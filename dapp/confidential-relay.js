// Confidential settle relay — thin dapp client for the worker prove/settle queue.
//
// The dapp assembles a confidential op (transfer / swap / lp) with the matching assembler
// (confidential-transfer.js / confidential-swap.js / confidential-lp.js), then hands the
// fixture-shaped `op` witness + per-leaf `memos` to the relay here. The worker queues it, the GPU
// box claims + Groth16-proves it and submits ConfidentialPool.settle() on-chain, and the dapp polls
// status until it lands. The op JSON shape MUST match the box harness for that type (the same shape
// the gen-confidential-*-fixture.mjs scripts emit) — that parity is what the on-chain proof enforces.
//
// RELAY-FEE PRIVACY POLICY: a relayed op pays the settler a public FeePayment in the op's asset, so the fee
// VALUE lands on-chain. To avoid re-introducing a per-intent amount/size signal that batch-netting otherwise
// hides, relay fees SHOULD be a FLAT, gas-denominated per-op amount (independent of the trade size), never a
// proportional skim. `fee = 0` (self-settle / self-broadcast) is the privacy-maximal path and is always
// supported (the guest suppresses the empty FeePayment). The fee is bound in the proof — the settler cannot
// pad or redirect it — so this is a privacy posture, not a fund control.
//
// fetchImpl injected for Node tests / non-window contexts; defaults to global fetch.

export function makeConfidentialRelay({ base, fetchImpl, guard } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('confidential-relay: no fetch available');
  const root = (base || '').replace(/\/$/, '');

  async function asJson(res) {
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`relay ${res.status}: ${body.error || text || res.statusText}`);
    return body;
  }

  // Enqueue a confidential op. type ∈ {unwrap, transfer, swap, lp, otc, route, bid}; op = the fixture-shaped
  // witness. RECOVERY CHOKEPOINT: an op that creates leaves MUST pass `outputs` (one recovery descriptor per
  // leaf, same order as the op's leaves) + the matching `leaves` + an `ephRand` scalar source. submitOp seals
  // one memo per output through the guard and runs the assertOutputsRecoverable tripwire BEFORE queuing, so no
  // op can ship a seed-only-unrecoverable leaf. A leaf-less op (unwrap) passes `memos: []`. (Back-compat: a
  // relay constructed without a guard passes raw `memos` through unchecked — for non-leaf-bearing tests.)
  async function submitOp({ type, op, leaves = [], outputs = null, ephRand, memos = null, mode, feeAsset = null } = {}) {
    let sealedMemos;
    if (outputs != null) {
      if (!guard) throw new Error('confidential-relay: `outputs` given but no recovery guard wired (pass `guard` to makeConfidentialRelay)');
      if (typeof ephRand !== 'function') throw new Error('confidential-relay: an op with `outputs` needs an `ephRand` scalar source for the memo seal');
      sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand });
      guard.assertOutputsRecoverable({ leaves, outputs, memos: sealedMemos });
    } else {
      sealedMemos = memos || [];
      // With the guard wired, an op shipping leaves (non-empty memos) but no `outputs` can't be
      // recovery-checked — reject it so nothing bypasses the guard. Leaf-less ops (unwrap) pass with [].
      if (guard && sealedMemos.length) {
        throw new Error('confidential-relay: pass `outputs` (recovery descriptors) for any op that creates leaves — raw memos bypass the recovery guard');
      }
    }
    const res = await f(`${root}/confidential/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, op, memos: sealedMemos, ...(mode ? { mode } : {}), ...(feeAsset ? { feeAsset } : {}) }),
    });
    return asJson(res);
  }

  async function status(jobId) {
    const res = await f(`${root}/confidential/status?id=${encodeURIComponent(jobId)}`);
    if (res.status === 404) return { jobId, status: 'unknown' };
    return asJson(res);
  }

  // Poll until the job settles or fails. onUpdate(state) fires on each status change.
  async function waitForSettle(jobId, { intervalMs = 4000, timeoutMs = 5 * 60 * 1000, onUpdate, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const st = await status(jobId);
      if (st.status !== last) { last = st.status; if (onUpdate) onUpdate(st); }
      if (st.status === 'settled') return st;
      if (st.status === 'failed') throw new Error(`settle failed: ${st.error || 'unknown'}`);
      if (st.status === 'unknown') throw new Error('relay lost the job (worker restart / KV miss)');
      if (Date.now() > deadline) throw new Error('settle timed out (box offline or backlogged)');
      await wait(intervalMs);
    }
  }

  // Convenience: submit and block until on-chain.
  async function settle(opSpec, waitOpts) {
    const { jobId, status: s } = await submitOp(opSpec);
    if (s === 'settled') return { jobId, status: 'settled' };
    return waitForSettle(jobId, waitOpts);
  }

  // Prove-only poll: resolve when the box has proven the op (mode 'prove'), returning
  // { publicValues, proof, ... } for the dapp to embed in a user-sent ConfidentialRouter tx. A job that the
  // box ends up settling instead (already-settled dedup) also resolves — the caller can branch on st.status.
  async function waitForProof(jobId, { intervalMs = 4000, timeoutMs = 15 * 60 * 1000, onUpdate, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const st = await status(jobId);
      if (st.status !== last) { last = st.status; if (onUpdate) onUpdate(st); }
      if (st.status === 'proven') return st;
      if (st.status === 'settled') return st;
      if (st.status === 'failed') throw new Error(`prove failed: ${st.error || 'unknown'}`);
      if (st.status === 'unknown') throw new Error('relay lost the job (worker restart / KV miss)');
      if (Date.now() > deadline) throw new Error('prove timed out (box offline or backlogged)');
      await wait(intervalMs);
    }
  }

  // Convenience: submit a prove-only job and block until the proof is ready. `onJob(jobId)` fires the moment
  // the job is queued (before the long prove wait) so a caller can persist a resumable record — a prove-timeout
  // then leaves the jobId recoverable instead of orphaning the in-flight proof.
  async function prove(opSpec, waitOpts = {}) {
    const r = await submitOp({ ...opSpec, mode: 'prove' });
    if (waitOpts.onJob) { try { waitOpts.onJob(r.jobId); } catch { /* best-effort */ } }
    if (r.status === 'proven' || r.status === 'settled') return { jobId: r.jobId, ...(await status(r.jobId)) };
    return waitForProof(r.jobId, waitOpts);
  }

  return { submitOp, status, waitForSettle, settle, waitForProof, prove };
}
