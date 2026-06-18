// Confidential settle relay — a prove/settle job queue for the EVM ConfidentialPool.
//
// The shielded-pool prover lives on a GPU box behind NAT (same box as the reflection relay), so it
// POLLS the worker rather than the worker pushing to it: the dapp assembles a confidential op
// (transfer / swap / lp), submits the witness here, the box claims it via /confidential/job, GPU
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

export function makeConfidentialSettler({ storage, hash, now }) {
  // storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job) }
  const clock = now || (() => Date.now());

  // jobId = hash of the witness (type+op) → idempotent: resubmitting the same op returns the same job.
  function jobIdOf(type, op) { return hash(JSON.stringify({ type, op })); }

  async function submitJob({ type, op, memos }) {
    if (!type || !op) throw new Error('submitJob: type + op required');
    if (!['wrap', 'unwrap', 'transfer', 'swap', 'lp', 'otc', 'bid'].includes(type)) throw new Error(`submitJob: unknown type ${type}`);
    const id = jobIdOf(type, op);
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
      id, type, op, memos: memos || [],
      status: 'pending', createdAt: clock(), claimedAt: 0, txHash: null, error: null,
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
        return { jobId: id, type: j.type, op: j.op, memos: j.memos };
      }
    }
    return null;
  }

  // The box reports the settle outcome. Idempotent: acking a settled job again is a no-op.
  async function ackJob(jobId, { txHash, error } = {}) {
    const j = await storage.getJob(jobId);
    if (!j) return { ok: false, reason: 'unknown job' };
    if (j.status === 'settled') return { ok: true, status: 'settled', txHash: j.txHash };
    if (error) { j.status = 'failed'; j.error = String(error); }
    else { j.status = 'settled'; j.txHash = txHash || null; }
    await storage.putJob(jobId, j);
    // Either outcome leaves the pending queue (the job record is kept for status lookups).
    const pend = (await storage.getPending()).filter((x) => x !== jobId);
    await storage.putPending(pend);
    return { ok: true, status: j.status, txHash: j.txHash };
  }

  async function jobStatus(jobId) {
    const j = await storage.getJob(jobId);
    if (!j) return null;
    return { jobId, type: j.type, status: j.status, txHash: j.txHash, error: j.error, createdAt: j.createdAt };
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
export function buildConfidentialSettler(env, { hash }) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  const storage = {
    getPending: async () => { const s = await KV.get('cps:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('cps:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('cps:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('cps:job:' + id, JSON.stringify(job)),
  };
  return makeConfidentialSettler({ storage, hash });
}
