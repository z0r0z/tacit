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
// /confidential/submit is permissionless (a bad witness just fails to prove), so bound the
// pending queue: an attacker can otherwise enqueue unbounded distinct ops, each of which burns a
// full GPU prove cycle and starves real jobs (FIFO, single-prover). New submits past the cap are
// rejected until the box drains the backlog; dedup of an in-flight op is unaffected.
const MAX_PENDING_JOBS = 512;

export function makeConfidentialSettler({ storage, hash, now, feeGate }) {
  // storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job) }
  // feeGate({ type, op }) -> bool : OPTIONAL profitability gate for the relayed (mode:'settle') flow — reject
  //   a fee below the current gas-priced floor (relay-quote.js `passesFloor`) before burning a prove cycle.
  //   Absent ⇒ no gate (the initial relayer can run ungated / fully subsidized).
  const clock = now || (() => Date.now());

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
  async function submitJob({ type, op, memos, mode = 'settle', feeAsset = null }) {
    if (!type || !op) throw new Error('submitJob: type + op required');
    if (!['wrap', 'unwrap', 'transfer', 'swap', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond', 'adaptorlock', 'adaptorclaim', 'adaptorrefund', 'cdpclose', 'cdpliquidate', 'cdptopup', 'bridgemint', 'cbtcmint', 'stealthlock', 'stealthlockbatch', 'stealthclaim', 'stealthrefund', 'bridgestealthmint', 'wraptransfer', 'sendunwrap', 'lpbond', 'lpremove', 'wrapcdpmint'].includes(type)) throw new Error(`submitJob: unknown type ${type}`);
    if (!['settle', 'prove'].includes(mode)) throw new Error(`submitJob: unknown mode ${mode}`);
    // Profitability gate (relayed flow only): a fee below the current gas-priced floor is rejected BEFORE it
    // burns a GPU prove cycle. `prove` jobs are user-sent (the user pays gas), so they're never gated.
    if (mode === 'settle' && feeGate && !feeGate({ type, op })) {
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
    const job = {
      id, type, op, mode, memos: memos || [],
      // feeAsset: the public ERC20/ETH address of this op's relay FeePayment (native ETH = the zero
      // address / null). The box needs it for the relaySettle path so TacitRelayer forwards the right
      // token to the ops fee recipient; the direct-settle path ignores it (fee → msg.sender in-kind).
      feeAsset: feeAsset || null,
      status: 'pending', createdAt: clock(), claimedAt: 0, txHash: null, error: null,
      publicValues: null, proof: null,
    };
    await storage.putJob(id, job);
    if (!pend.includes(id)) { pend.push(id); await storage.putPending(pend); }
    return { jobId: id, status: 'pending' };
  }

  // The box claims the oldest provable job (FIFO). Claiming flips it to 'proving' so a second poller
  // won't double-prove; a stale claim (crashed box) is reclaimable after CLAIM_TTL_MS.
  async function nextJob() {
    const pend = await storage.getPending();
    for (const id of pend) {
      const j = await storage.getJob(id);
      if (!j) continue;
      const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
      if (claimable) {
        j.status = 'proving'; j.claimedAt = clock();
        await storage.putJob(id, j);
        // `mode` tells the box whether to submit on-chain ('settle') or just return the proof ('prove').
        return { jobId: id, type: j.type, op: j.op, memos: j.memos, mode: j.mode || 'settle', feeAsset: j.feeAsset || null };
      }
    }
    return null;
  }

  // The box reports the outcome. 'settle' jobs ack { txHash }; 'prove' jobs ack { publicValues, proof } (no
  // on-chain submit) → status 'proven'. Idempotent: re-acking a terminal-success job returns its artifacts.
  async function ackJob(jobId, { txHash, error, publicValues, proof } = {}) {
    const j = await storage.getJob(jobId);
    if (!j) return { ok: false, reason: 'unknown job' };
    if (j.status === 'settled' || j.status === 'proven') {
      return { ok: true, status: j.status, txHash: j.txHash, publicValues: j.publicValues, proof: j.proof };
    }
    if (error) {
      j.status = 'failed'; j.error = String(error);
    } else if ((j.mode || 'settle') === 'prove') {
      if (!publicValues || !proof) { j.status = 'failed'; j.error = 'prove-only ack missing publicValues/proof'; }
      else { j.status = 'proven'; j.publicValues = publicValues; j.proof = proof; }
    } else {
      j.status = 'settled'; j.txHash = txHash || null;
    }
    await storage.putJob(jobId, j);
    // Any terminal outcome leaves the pending queue (the job record is kept for status lookups).
    const pend = (await storage.getPending()).filter((x) => x !== jobId);
    await storage.putPending(pend);
    return { ok: true, status: j.status, txHash: j.txHash, publicValues: j.publicValues, proof: j.proof };
  }

  async function jobStatus(jobId) {
    const j = await storage.getJob(jobId);
    if (!j) return null;
    // A 'proven' job carries the artifacts the dapp embeds into the user-sent router tx (publicValues, proof);
    // both are public (they go on-chain in the settle call anyway).
    return { jobId, type: j.type, mode: j.mode || 'settle', status: j.status, txHash: j.txHash, error: j.error,
      createdAt: j.createdAt, publicValues: j.publicValues || null, proof: j.proof || null };
  }

  async function pendingCount() {
    const pend = await storage.getPending();
    let n = 0;
    for (const id of pend) { const j = await storage.getJob(id); if (j && (j.status === 'pending' || j.status === 'proving')) n++; }
    return n;
  }

  return { submitJob, nextJob, ackJob, jobStatus, pendingCount, jobIdOf };
}

// KV-backed wiring for the worker runtime. KV keys: cps:pending (id[]), cps:job:<id> (job).
export function buildConfidentialSettler(env, { hash, feeGate }) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  const storage = {
    getPending: async () => { const s = await KV.get('cps:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('cps:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('cps:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('cps:job:' + id, JSON.stringify(job)),
  };
  return makeConfidentialSettler({ storage, hash, feeGate });
}
