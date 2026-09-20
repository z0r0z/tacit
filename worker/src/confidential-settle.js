// Confidential settle relay — a prove/settle job queue for the EVM ConfidentialPool.
//
// The shielded-pool prover lives on a GPU box behind NAT (same box as the reflection relay), so it
// POLLS the worker rather than the worker pushing to it: the dapp assembles a confidential op
// (transfer / swap / route / lp), submits the witness here, the box claims it via /confidential/job, GPU
// Groth16-proves the settle guest, submits ConfidentialPool.settle(pv, proof, memos) on-chain, then
// /confidential/ack marks it done. Mirrors [[reflection-attest]]'s box-poll shape; this one is a
// multi-job QUEUE (user-initiated) rather than a single advancing cursor.
//
// Trust: the worker never proves and never holds funds — it only queues opaque witnesses + relays a
// proof the contract independently verifies against PROGRAM_VKEY. A bad witness just fails to prove.

const CLAIM_TTL_MS = 10 * 60 * 1000; // a claimed-but-unfinished job is reclaimable after 10 min (box crash)
// KV has no compare-and-swap (real Cloudflare KV doesn't either, and this queue must stay portable to
// it — see server/kv-store.mjs), so a plain read-then-write claim races once more than one poller hits
// the same pending job. CLAIM_VERIFY_DELAY_MS narrows that window from "the whole poll interval" to
// milliseconds: see nextJob()'s claim-nonce re-read below.
const CLAIM_VERIFY_DELAY_MS = 400;
// /confidential/submit is permissionless (a bad witness just fails to prove), so bound the
// pending queue: an attacker can otherwise enqueue unbounded distinct ops, each of which burns a
// full GPU prove cycle and starves real jobs (FIFO, single-prover). New submits past the cap are
// rejected until the box drains the backlog; dedup of an in-flight op is unaffected.
const MAX_PENDING_JOBS = 512;

// A relayed exit to an L2 may carry its ConfidentialRouter ExitRecipe, so the relay can call the permissionless
// activateExit(recipe) as soon as the settle lands — otherwise the user has to send it from some wallet, and that
// wallet is then linked to the exit. The worker only checks the recipe's shape; the relay checks it maps to the
// proof's own recipient (escrowAddressFor) and that the bound fee covers the activation before sending anything.
const EXIT_TYPES = ['unwrap', 'sendunwrap'];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^\d{1,78}$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2}){0,4096}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
function normalizeExit(e) {
  const bad = (what) => { throw new Error(`submitJob: exit recipe has a bad ${what}`); };
  const addr = (v, what) => (ADDR_RE.test(v || '') ? v.toLowerCase() : bad(what));
  const uint = (v, what) => (UINT_RE.test(String(v ?? '')) ? BigInt(v).toString() : bad(what));
  if (!e || typeof e !== 'object' || Array.isArray(e)) bad('shape');
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.exitedAsset || '')) bad('exitedAsset');
  if (!Array.isArray(e.calls) || !e.calls.length || e.calls.length > 8) bad('calls list');
  if (!Array.isArray(e.sweepTokens) || !Array.isArray(e.minOuts) || e.sweepTokens.length !== e.minOuts.length || e.sweepTokens.length > 8) bad('sweep list');
  return {
    exitedAsset: e.exitedAsset.toLowerCase(),
    feeAsset: addr(e.feeAsset, 'feeAsset'),
    finalRecipient: addr(e.finalRecipient, 'finalRecipient'),
    deadline: uint(e.deadline, 'deadline'),
    nonce: uint(e.nonce, 'nonce'),
    calls: e.calls.map((c) => {
      if (!c || typeof c !== 'object' || typeof c.push !== 'boolean' || !DATA_RE.test(c.data || '')) bad('call');
      return { target: addr(c.target, 'call target'), value: uint(c.value, 'call value'), token: addr(c.token, 'call token'),
        amount: uint(c.amount, 'call amount'), push: c.push, data: c.data.toLowerCase() };
    }),
    sweepTokens: e.sweepTokens.map((t) => addr(t, 'sweep token')),
    minOuts: e.minOuts.map((v) => uint(v, 'minOut')),
  };
}

export function makeConfidentialSettler({ storage, hash, now, feeGate, priceFee, sleep }) {
  // storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job) }
  // feeGate({ type, op }) -> bool : OPTIONAL profitability gate for the relayed (mode:'settle') flow — reject
  //   a fee below the current gas-priced floor (relay-quote.js `passesFloor`) before burning a prove cycle.
  //   Absent ⇒ no gate (the initial relayer can run ungated / fully subsidized).
  // sleep(ms) -> Promise : OPTIONAL, for the claim-verify wait in nextJob/nextBatch. Real callers get a
  // real setTimeout; tests inject an instant resolver so the suite doesn't pay CLAIM_VERIFY_DELAY_MS
  // (real wall-clock time) on every claim.
  const clock = now || (() => Date.now());
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // jobId = hash of the witness (type+op[+mode]) → idempotent: resubmitting the same op returns the same job.
  // `settle` keeps the legacy id (type+op); a `prove`-only job for the same op is a DISTINCT id so the two can
  // coexist (e.g. the same deposit consume both prove-only for a router tx and box-settled).
  function jobIdOf(type, op, mode = 'settle') {
    return hash(JSON.stringify(mode === 'settle' ? { type, op } : { type, op, mode }));
  }

  // mode:
  //   'settle' (default) — the box GPU-proves AND submits ConfidentialPool.settle() on-chain (the relayed flow).
  //   'prove'            — the box GPU-proves but does NOT submit; it acks { publicValues, proof } which the
  //                        dapp embeds into a USER-SENT ConfidentialRouter tx (wrapAndSettle* / zapETHToPayment /
  //                        farm bond). The router pulls from msg.sender, so only the user can send it.
  async function submitJob({ type, op, memos, mode = 'settle', feeAsset = null, exit = null }) {
    if (!type || !op) throw new Error('submitJob: type + op required');
    // Drop a caller-supplied feeUsd FIRST, before anything derives from `op`.
    //
    // Position matters as much as the deletion: `jobIdOf(type, op, mode)` hashes the op, so stripping this
    // after the id was computed would leave a caller able to vary a field the guest never reads, mint a
    // fresh job id for the identical op, and walk straight past dedup. Removing it here means the id is
    // taken over the op the guest will actually see.
    if (typeof op === 'object' && 'feeUsd' in op) delete op.feeUsd;
    if (!['wrap', 'unwrap', 'transfer', 'swap', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond', 'adaptorlock', 'adaptorclaim', 'adaptorrefund', 'cdpclose', 'cdpliquidate', 'cdptopup', 'bridgemint', 'cbtcmint', 'stealthlock', 'stealthlockbatch', 'stealthclaim', 'stealthrefund', 'bridgestealthmint', 'wraptransfer', 'sendunwrap', 'lpbond', 'lpremove', 'batchtransfer', 'wraplp', 'wrapswap', 'wrapcdpmint', 'fastlane'].includes(type)) throw new Error(`submitJob: unknown type ${type}`);
    if (!['settle', 'prove'].includes(mode)) throw new Error(`submitJob: unknown mode ${mode}`);
    if (exit != null && (mode !== 'settle' || !EXIT_TYPES.includes(type))) {
      throw new Error('submitJob: an exit recipe rides only on a relayed unwrap or sendunwrap');
    }
    const recipe = exit == null ? null : normalizeExit(exit);
    // Profitability gate (relayed flow only): a fee below the current gas-priced floor is rejected BEFORE it
    // burns a GPU prove cycle. `prove` jobs are user-sent (the user pays gas), so they're never gated.
    // Awaited: a real feeGate reads live gas price over RPC, so it can't be synchronous.
    if (mode === 'settle' && feeGate && !(await feeGate({ type, op }))) {
      throw new Error('submitJob: relay fee below the current floor — re-quote higher or self-settle');
    }
    const id = jobIdOf(type, op, mode);
    const existing = await storage.getJob(id);
    if (existing && existing.status !== 'failed') {
      return { jobId: id, status: existing.status, deduped: true };
    }
    const pend = await storage.getPending();
    // Backpressure: bound the unauthenticated queue (a new, non-deduped op only).
    if (!pend.includes(id) && pend.length >= MAX_PENDING_JOBS) {
      throw new Error('submitJob: queue full, retry later');
    }
    // What this op actually pays us, DERIVED from the op's own fee legs — never taken from the caller.
    //
    // `op` is client JSON, so any field on it is attacker-controlled. The relay's fee gate used to read
    // `op.feeUsd`, which meant a hostile integrator could have declared any number it liked and had the
    // gate believe it. Nothing populated the field, so the bypass was never reachable — but wiring the
    // producer is exactly what would have made it reachable, so the value is derived here instead and the
    // client's copy is dropped before the op is stored.
    let priced = null;
    if (mode === 'settle' && priceFee) {
      try { priced = await priceFee({ type, op }); }
      catch { priced = null; } // pricing is advisory; never fail a submit because an oracle blinked
    }

    const job = {
      id, type, op, mode, memos: memos || [],
      // Derived fee, for the relay's profitability gate. null feeUsd = "we could not price it", which the
      // relay treats as unpaid work rather than as free permission.
      feeUnits: priced?.feeUnits ?? null,
      feeUsd: priced?.feeUsd ?? null,
      // feeAsset: the public ERC20/ETH address of this op's relay FeePayment (native ETH = the zero
      // address / null). The box needs it for the relaySettle path so TacitRelayer forwards the right
      // token to the ops fee recipient; the direct-settle path ignores it (fee → msg.sender in-kind).
      feeAsset: feeAsset || null,
      exit: recipe, activateTx: null, activateError: null,
      status: 'pending', createdAt: clock(), claimedAt: 0, txHash: null, error: null,
      publicValues: null, proof: null,
    };
    await storage.putJob(id, job);
    if (!pend.includes(id)) { pend.push(id); await storage.putPending(pend); }
    return { jobId: id, status: 'pending' };
  }

  // The box claims the oldest provable job (FIFO). Claiming flips it to 'proving' so a second poller
  // won't double-prove; a stale claim (crashed box) is reclaimable after CLAIM_TTL_MS.
  //
  // With more than one box polling (real as of the 2026-09-06 fallback worker), a plain read-then-write
  // claim can race: two pollers both read 'pending' before either write lands, both flip it, both prove
  // it. That never risks funds — the contract's own nullifier/deposit-status checks make a duplicate
  // settle a no-op revert, not a double-spend — but it wastes a full proof (real $PROVE cost). Since KV
  // has no compare-and-swap to close the window outright, narrow it with a claim nonce: write it, then
  // re-read after CLAIM_VERIFY_DELAY_MS. Concurrent writes to one key still land in some final order, so
  // exactly one claimant's nonce survives that wait — the other sees a foreign nonce and backs off to try
  // the next candidate instead of also proving this one.
  async function nextJob() {
    const pend = await storage.getPending();
    for (const id of pend) {
      const j = await storage.getJob(id);
      if (!j) continue;
      const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
      if (!claimable) continue;
      const nonce = crypto.randomUUID();
      j.status = 'proving'; j.claimedAt = clock(); j.claimNonce = nonce;
      await storage.putJob(id, j);
      await wait(CLAIM_VERIFY_DELAY_MS);
      const won = await storage.getJob(id);
      if (!won || won.claimNonce !== nonce) continue; // lost the race — another poller's write landed after ours
      // `mode` tells the box whether to submit on-chain ('settle') or just return the proof ('prove').
      // feeUnits/feeUsd are the worker-DERIVED fee (see submitJob). They must ride along or the relay's
      // profitability gate sees undefined and treats every job as unpaid work.
      return { jobId: id, type: j.type, op: j.op, memos: j.memos, mode: j.mode || 'settle', feeAsset: j.feeAsset || null, exit: j.exit || null, feeUnits: j.feeUnits ?? null, feeUsd: j.feeUsd ?? null };
    }
    return null;
  }

  // Claim up to `max` settle-mode jobs that can share ONE settle. The guest proves a batch against a single
  // spendRoot, so only jobs already carrying the same root (and chain binding) can travel together — true for
  // anything queued between two settles. Batching splits the settle's gas across its members and stops each
  // settle transaction from being a one-user event. FIFO order is preserved; a job that doesn't fit the
  // batch's root is simply left for the next round rather than reordered around.
  async function nextBatch({ max = 8, types = ['transfer'] } = {}) {
    const pend = await storage.getPending();
    const claimed = []; // { id, j, nonce } — verified in one shared wait below, not per-job
    let root = null, binding = null;
    for (const id of pend) {
      if (claimed.length >= max) break;
      const j = await storage.getJob(id);
      if (!j) continue;
      const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
      if (!claimable) continue;
      if ((j.mode || 'settle') !== 'settle') continue; // prove-only jobs are user-sent, never batched
      if (!types.includes(j.type)) continue;
      const r = j.op && j.op.spendRoot, b = j.op && j.op.chainBinding;
      if (!r || !b) continue;
      if (root === null) { root = r; binding = b; }
      else if (r !== root || b !== binding) continue;
      const nonce = crypto.randomUUID();
      j.status = 'proving'; j.claimedAt = clock(); j.claimNonce = nonce;
      await storage.putJob(id, j);
      claimed.push({ id, j, nonce });
    }
    if (!claimed.length) return [];
    // Same claim-nonce race-narrowing as nextJob() (see its comment) — one shared wait for the whole
    // batch rather than per-job, since a settle-batch call is itself a single latency-sensitive round trip.
    await wait(CLAIM_VERIFY_DELAY_MS);
    const picked = [];
    for (const { id, j, nonce } of claimed) {
      const won = await storage.getJob(id);
      if (!won || won.claimNonce !== nonce) continue; // lost the race for this one — leave it for the next round
      picked.push({ jobId: id, type: j.type, op: j.op, memos: j.memos, mode: 'settle', feeAsset: j.feeAsset || null, exit: j.exit || null, feeUnits: j.feeUnits ?? null, feeUsd: j.feeUsd ?? null });
    }
    return picked;
  }

  // The box reports the outcome. 'settle' jobs ack { txHash }; 'prove' jobs ack { publicValues, proof } (no
  // on-chain submit) → status 'proven'. Idempotent: re-acking a terminal-success job returns its artifacts.
  // A settled exit that carries a recipe later acks { activateTx } or { activateError } for its activateExit; a
  // recorded activation tx is final, while a recorded error can still be followed by a tx.
  function recordActivation(j, activateTx, activateError) {
    if (j.status !== 'settled' || !j.exit || j.activateTx) return false;
    if (activateTx && TX_RE.test(String(activateTx))) { j.activateTx = String(activateTx).toLowerCase(); j.activateError = null; return true; }
    if (activateError) { j.activateError = String(activateError).slice(0, 300); return true; }
    return false;
  }
  const ackView = (j) => ({ ok: true, status: j.status, txHash: j.txHash, publicValues: j.publicValues, proof: j.proof, activateTx: j.activateTx || null });

  async function ackJob(jobId, { txHash, error, publicValues, proof, activateTx, activateError } = {}) {
    const j = await storage.getJob(jobId);
    if (!j) return { ok: false, reason: 'unknown job' };
    if (j.status === 'settled' || j.status === 'proven') {
      if (recordActivation(j, activateTx, activateError)) await storage.putJob(jobId, j);
      return ackView(j);
    }
    if (error) {
      j.status = 'failed'; j.error = String(error);
    } else if ((j.mode || 'settle') === 'prove') {
      if (!publicValues || !proof) { j.status = 'failed'; j.error = 'prove-only ack missing publicValues/proof'; }
      else { j.status = 'proven'; j.publicValues = publicValues; j.proof = proof; }
    } else {
      j.status = 'settled'; j.txHash = txHash || null;
      recordActivation(j, activateTx, activateError);
    }
    await storage.putJob(jobId, j);
    // Any terminal outcome leaves the pending queue (the job record is kept for status lookups).
    const pend = (await storage.getPending()).filter((x) => x !== jobId);
    await storage.putPending(pend);
    return ackView(j);
  }

  async function jobStatus(jobId) {
    const j = await storage.getJob(jobId);
    if (!j) return null;
    // A 'proven' job carries the artifacts the dapp embeds into the user-sent router tx (publicValues, proof);
    // both are public (they go on-chain in the settle call anyway).
    // `activation` is null for a job without an exit recipe; otherwise 'pending' until the relay reports its
    // activateExit as 'done' (activateTx) or 'failed' (activateError — the user activates it themselves).
    return { jobId, type: j.type, mode: j.mode || 'settle', status: j.status, txHash: j.txHash, error: j.error,
      createdAt: j.createdAt, publicValues: j.publicValues || null, proof: j.proof || null,
      activation: j.exit ? (j.activateTx ? 'done' : j.activateError ? 'failed' : 'pending') : null,
      activateTx: j.activateTx || null, activateError: j.activateError || null };
  }

  async function pendingCount() {
    const pend = await storage.getPending();
    let n = 0;
    for (const id of pend) { const j = await storage.getJob(id); if (j && (j.status === 'pending' || j.status === 'proving')) n++; }
    return n;
  }

  return { submitJob, nextJob, nextBatch, ackJob, jobStatus, pendingCount, jobIdOf };
}

// KV-backed wiring for the worker runtime. KV keys: cps:pending (id[]), cps:job:<id> (job).
export function buildConfidentialSettler(env, { hash, feeGate, priceFee }) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  const storage = {
    getPending: async () => { const s = await KV.get('cps:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('cps:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('cps:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('cps:job:' + id, JSON.stringify(job)),
  };
  return makeConfidentialSettler({ storage, hash, feeGate, priceFee });
}
