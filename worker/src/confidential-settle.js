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

// Promise-chain mutex: each fn starts after the previous one settles, whether it resolved or threw.
export function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

export function makeConfidentialSettler({ storage, hash, now, feeGate, priceFee, sleep, lock }) {
  // storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job) }
  // feeGate({ type, op }) -> bool : OPTIONAL profitability gate for the relayed (mode:'settle') flow — reject
  //   a fee below the current gas-priced floor (relay-quote.js `passesFloor`) before burning a prove cycle.
  //   Absent ⇒ no gate (the initial relayer can run ungated / fully subsidized).
  // sleep(ms) -> Promise : OPTIONAL, for the claim-verify wait in nextJob/nextBatch. Real callers get a
  // real setTimeout; tests inject an instant resolver so the suite doesn't pay CLAIM_VERIFY_DELAY_MS
  // (real wall-clock time) on every claim.
  // lock(fn) -> Promise : OPTIONAL, runs fn exclusively with respect to every other lock(fn) call sharing the
  //   same lock. The pending list is one shared value that every mutation reads, edits and writes back across
  //   awaits, so overlapping requests would otherwise overwrite each other's edit. Callers that build a fresh
  //   settler per request must pass one lock shared by all of them (buildConfidentialSettler does).
  const clock = now || (() => Date.now());
  const exclusive = lock || makeLock();
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
    // A live duplicate needs no pricing; the authoritative dedupe below runs under the lock.
    const seen = await storage.getJob(id);
    const skipPricing = !!seen && seen.status !== 'failed';
    // What this op actually pays us, DERIVED from the op's own fee legs — never taken from the caller.
    //
    // `op` is client JSON, so any field on it is attacker-controlled. The relay's fee gate used to read
    // `op.feeUsd`, which meant a hostile integrator could have declared any number it liked and had the
    // gate believe it. Nothing populated the field, so the bypass was never reachable — but wiring the
    // producer is exactly what would have made it reachable, so the value is derived here instead and the
    // client's copy is dropped before the op is stored.
    let priced = null;
    if (mode === 'settle' && priceFee && !skipPricing) {
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
    // Dedupe, backpressure, record and queue entry are one step: the record is what makes a later submit
    // read as a duplicate, so it is only ever left behind together with its queue entry.
    return exclusive(async () => {
      const existing = await storage.getJob(id);
      const pend = await storage.getPending();
      if (existing && existing.status !== 'failed') {
        // A live job that is missing from the queue can never be claimed; queue it again so the duplicate
        // resolves to a job that will actually run.
        const live = existing.status === 'pending' || existing.status === 'proving';
        if (live && !pend.includes(id)) {
          if (pend.length >= MAX_PENDING_JOBS) throw new Error('submitJob: queue full, retry later');
          pend.push(id);
          await storage.putPending(pend);
        }
        return { jobId: id, status: existing.status, deduped: true };
      }
      // Backpressure: bound the unauthenticated queue (a new, non-deduped op only).
      if (!pend.includes(id) && pend.length >= MAX_PENDING_JOBS) {
        throw new Error('submitJob: queue full, retry later');
      }
      await storage.putJob(id, job);
      if (!pend.includes(id)) {
        pend.push(id);
        try { await storage.putPending(pend); }
        catch (e) {
          // Not queued, so not accepted: mark the record failed (resubmittable) rather than leave it as a duplicate.
          try { await storage.putJob(id, { ...job, status: 'failed', error: 'could not be queued' }); } catch { /* the retry path re-queues it */ }
          throw e;
        }
      }
      return { jobId: id, status: 'pending' };
    });
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
      // Read-check-write of the job record is one step, so an ack or another claim cannot land between them.
      const claim = await exclusive(async () => {
        const j = await storage.getJob(id);
        if (!j) return null;
        const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
        if (!claimable) return null;
        const nonce = crypto.randomUUID();
        j.status = 'proving'; j.claimedAt = clock(); j.claimNonce = nonce;
        await storage.putJob(id, j);
        return { j, nonce };
      });
      if (!claim) continue;
      const { j, nonce } = claim;
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
  // Job types that can share one settle. This is NOT a tuning knob: the relay proves a claimed batch as
  // `batchtransfer`, a transfer-specific guest op, so anything added here without a matching guest batch
  // type would be folded by a circuit that does not understand it. Swaps have their own answer — intent
  // batching through OP_SWAP, which amortises the PROOF rather than the gas — and it lives in the dapp
  // coordinator, not here. The relay re-checks this at the point it builds the op.
  const BATCHABLE_TYPES = ['transfer'];

  async function nextBatch({ max = 8, types = BATCHABLE_TYPES } = {}) {
    const pend = await storage.getPending();
    const claimed = []; // { id, j, nonce } — verified in one shared wait below, not per-job
    let root = null, binding = null;
    for (const id of pend) {
      if (claimed.length >= max) break;
      const c = await exclusive(async () => {
        const j = await storage.getJob(id);
        if (!j) return null;
        const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
        if (!claimable) return null;
        if ((j.mode || 'settle') !== 'settle') return null; // prove-only jobs are user-sent, never batched
        if (!types.includes(j.type)) return null;
        const r = j.op && j.op.spendRoot, b = j.op && j.op.chainBinding;
        if (!r || !b) return null;
        if (root === null) { root = r; binding = b; }
        else if (r !== root || b !== binding) return null;
        const nonce = crypto.randomUUID();
        j.status = 'proving'; j.claimedAt = clock(); j.claimNonce = nonce;
        await storage.putJob(id, j);
        return { id, j, nonce };
      });
      if (c) claimed.push(c);
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

  function ackJob(jobId, ack = {}) { return exclusive(() => ackJobLocked(jobId, ack)); }

  async function ackJobLocked(jobId, { txHash, error, publicValues, proof, activateTx, activateError }) {
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

  // A read-only picture of the queue for the operator: how many jobs are waiting, how many are being proved, and
  // how long the oldest of each has been in that state. Ages, not job details — nothing about any op leaves here.
  // This is what tells "the relay is idle" apart from "the relay has stopped and users are waiting": a queue whose
  // oldest pending job keeps getting older is the signature of a dead or hung settle service.
  async function queueStats() {
    const pend = await storage.getPending();
    const t = clock();
    let pending = 0, proving = 0, oldestPendingMs = 0, oldestProvingMs = 0;
    for (const id of pend) {
      const j = await storage.getJob(id);
      if (!j) continue;
      if (j.status === 'pending') { pending++; oldestPendingMs = Math.max(oldestPendingMs, t - (j.createdAt || t)); }
      else if (j.status === 'proving') { proving++; oldestProvingMs = Math.max(oldestProvingMs, t - (j.claimedAt || t)); }
    }
    return { pending, proving, oldestPendingSec: Math.round(oldestPendingMs / 1000), oldestProvingSec: Math.round(oldestProvingMs / 1000) };
  }

  async function pendingCount() {
    const pend = await storage.getPending();
    let n = 0;
    for (const id of pend) { const j = await storage.getJob(id); if (j && (j.status === 'pending' || j.status === 'proving')) n++; }
    return n;
  }

  return { submitJob, nextJob, nextBatch, ackJob, jobStatus, pendingCount, queueStats, jobIdOf };
}

// KV-backed wiring for the worker runtime. KV keys: cps:pending (id[]), cps:job:<id> (job).
// The worker builds a settler per request, so the queue lock lives per KV namespace, not per settler.
const kvLocks = new WeakMap();
export function buildConfidentialSettler(env, { hash, feeGate, priceFee }) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (KV && !kvLocks.has(KV)) kvLocks.set(KV, makeLock());
  const storage = {
    getPending: async () => { const s = await KV.get('cps:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('cps:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('cps:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('cps:job:' + id, JSON.stringify(job)),
  };
  return makeConfidentialSettler({ storage, hash, feeGate, priceFee, lock: kvLocks.get(KV) });
}
