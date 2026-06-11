// Confidential settle relay — thin dapp client for the worker prove/settle queue.
//
// The dapp assembles a confidential op (transfer / swap / lp) with the matching assembler
// (confidential-transfer.js / confidential-swap.js / confidential-lp.js), then hands the
// fixture-shaped `op` witness + per-leaf `memos` to the relay here. The worker queues it, the GPU
// box claims + Groth16-proves it and submits ConfidentialPool.settle() on-chain, and the dapp polls
// status until it lands. The op JSON shape MUST match the box harness for that type (the same shape
// the gen-confidential-*-fixture.mjs scripts emit) — that parity is what the on-chain proof enforces.
//
// fetchImpl injected for Node tests / non-window contexts; defaults to global fetch.

export function makeConfidentialRelay({ base, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('confidential-relay: no fetch available');
  const root = (base || '').replace(/\/$/, '');

  async function asJson(res) {
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`relay ${res.status}: ${body.error || text || res.statusText}`);
    return body;
  }

  // Enqueue a confidential op. type ∈ {transfer, swap, lp, otc, bid}; op = the fixture-shaped witness;
  // memos = per-leaf recovery ciphertexts (hex, one per committed leaf) or []. Returns {jobId,status}.
  async function submitOp({ type, op, memos = [] } = {}) {
    const res = await f(`${root}/confidential/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, op, memos }),
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

  return { submitOp, status, waitForSettle, settle };
}
