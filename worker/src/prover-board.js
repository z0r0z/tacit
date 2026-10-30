// The prover board: proofs the relay wants made, for workers that pull them. The relay posts a program input (the
// bincode SP1Stdin a page or the relay builds, dapp/sp1-stdin.js) with the class of work it is; a worker with a token for
// that class claims the oldest, proves it on its own machine and posts the proof back; the relay reads it, checks it against
// the pool (a simulated settle) and sends it, or falls back to the prover network when nobody took the job in time.
//
// Classes: 'private' carries a user's witness and goes only to workers whose token names that class (Tacit's own machines
// at first); 'public' is work whose input is public anyway and may go to any worker with a token; 'eth-state' is the
// Ethereum-state proof the Bitcoin reflection verifies inside itself (program 'eth-state', eth_prove's input), which goes to
// workers whose token names that class or 'private' (a machine trusted with users' witnesses is trusted with this). A claim
// is a lease: a worker that goes quiet past it loses the job to the next claim, with no bond and no penalty beyond the
// record. Nothing here verifies a proof; the relay does, before anything is sent or paid for.
//
// Programs: 'confidential' (the pool's settle guest, proved groth16: the proof is the hex settle() takes) and 'eth-state'
// (proved compressed: the proof is the base64 of the bincode SP1ProofWithPublicValues, which eth_prove's finish mode checks).
// A worker says which programs it proves when it claims (old workers say nothing: 'confidential'), and is offered only those.
//
// Storage (KV, portable to Cloudflare's): pb:pending (ids, oldest first), pb:job:<id>, pb:proof:<id> (a compressed proof,
// kept apart from its job so the record every claim reads stays small), pb:workers (name → record).

export const PROVER_BOARD = Object.freeze({
  classes: Object.freeze(['private', 'public', 'eth-state']),
  programs: Object.freeze(['confidential', 'eth-state']),
  // Each program's proof mode and the classes its jobs may carry.
  modes: Object.freeze({ confidential: 'groth16', 'eth-state': 'compressed' }),
  programClasses: Object.freeze({ confidential: Object.freeze(['private', 'public']), 'eth-state': Object.freeze(['eth-state']) }),
  maxCompressedProofBytes: 2 * 1024 * 1024,            // a compressed proof of the eth-reflection guest is about 1.3 MB
  leaseMs: 5 * 60_000,                                 // a claim lasts this long without a result
  keepMs: 60 * 60_000,                                 // a finished or cancelled job stays readable this long
  maxPending: 64,
  maxStdinBytes: 1024 * 1024,                          // bincode SP1Stdin, uncompressed (a batch of eight ops is well under)
  // eth_prove's input carries one light-client update per sync-committee period since the last landed proof: ~120 KB a cycle,
  // 2 MB from a cold start (34 periods, measured 2026-10-26), so a run of missed landings still fits.
  maxStdinBytesByProgram: Object.freeze({ 'eth-state': 4 * 1024 * 1024 }),
  maxOpenPerWorker: 2,
});

// PROVER_WORKER_TOKENS: "name:token[:class+class],name:token" — each worker's name, its bearer token and the classes it may
// claim (default: public only). A token under 16 characters is ignored, so a typo cannot open the board.
export function parseWorkerTokens(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const [name, token, classes] = part.trim().split(':');
    if (!name || !token || token.length < 16 || !/^[A-Za-z0-9_.-]{1,40}$/.test(name)) continue;
    const cls = (classes || 'public').split('+').map((c) => c.trim()).filter((c) => PROVER_BOARD.classes.includes(c));
    // A token trusted with users' witnesses may prove the Ethereum-state input too.
    if (cls.includes('private') && !cls.includes('eth-state')) cls.push('eth-state');
    out.push({ name, token, classes: cls.length ? cls : ['public'] });
  }
  return out;
}
// The worker a bearer token names, or null. Constant-time per token, so a token cannot be guessed letter by letter.
export function workerOf(authorization, raw) {
  const m = /^Bearer (.+)$/.exec(String(authorization || ''));
  if (!m) return null;
  for (const w of parseWorkerTokens(raw)) {
    if (w.token.length !== m[1].length) continue;
    let diff = 0;
    for (let i = 0; i < w.token.length; i++) diff |= w.token.charCodeAt(i) ^ m[1].charCodeAt(i);
    if (diff === 0) return { name: w.name, classes: w.classes };
  }
  return null;
}

const isHex = (s, bytes) => typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s) && (bytes == null || s.length === 2 + 2 * bytes);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const b64len = (s) => Math.floor(s.length * 3 / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);

function makeLock() {
  let tail = Promise.resolve();
  return (fn) => { const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; };
}

// The input is a user's witness: it stays on a record only while a worker may still need it (queued or claimed) and is
// dropped the moment the job is over, and a record leaves storage when it leaves the list.
// storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job), deleteJob?(id), getWorkers()->{}, putWorkers({}) }
export function makeProverBoard({ storage, hash, now, lock } = {}) {
  if (!storage) throw new Error('prover-board: storage is required');
  const clock = now || (() => Date.now());
  const exclusive = lock || makeLock();
  const id = hash || ((s) => 'pb_' + s.length.toString(36) + '_' + Array.from(s).reduce((a, c) => ((a * 33) ^ c.charCodeAt(0)) >>> 0, 5381).toString(36));
  const workers = async () => (await storage.getWorkers()) || {};

  // Finished and cancelled jobs are dropped from the pending list once kept long enough; the list is read on every call.
  async function sweep(pend) {
    const keep = [];
    for (const jid of pend) {
      const j = await storage.getJob(jid);
      if (!j) continue;
      if (j.status === 'queued' || j.status === 'claimed') {
        if (j.deadline && clock() > j.deadline * 1000) { j.status = 'expired'; over(j); await storage.putJob(jid, j); }
        else if (j.status === 'claimed' && clock() > j.leaseUntil) { j.status = 'queued'; j.worker = null; j.leaseUntil = 0; j.lapsed = (j.lapsed || 0) + 1; await storage.putJob(jid, j); }
      }
      if (['queued', 'claimed'].includes(j.status) || clock() - (j.endedAt || 0) < PROVER_BOARD.keepMs) keep.push(jid);
      else {
        if (storage.deleteJob) await storage.deleteJob(jid);
        if (j.proofKept && storage.deleteProof) await storage.deleteProof(jid);
      }
    }
    return keep;
  }
  const over = (j) => { j.stdin = null; j.sealed = null; j.endedAt = clock(); };
  // A compressed proof lives under its own key when the storage has one (buildProverBoard's KV does), else on the record.
  const putProof = async (j, proof) => { if (storage.putProof) { await storage.putProof(j.id, proof); j.proof = null; j.proofKept = true; } else j.proof = proof; };
  const proofOf = async (j) => (j.proofKept && storage.getProof ? await storage.getProof(j.id) : j.proof);

  // The relay posts work. The same input posted twice is one job (its id is the hash of what the worker proves). A job
  // carries either `stdin` (the input, for any worker of its class) or `sealed` (dapp/sealed-input.js: the input encrypted
  // to one named worker's key, which only that worker is offered; the board itself cannot read it).
  async function post({ class: cls, program = 'confidential', mode = null, stdin, sealed, cycleLimit, gasLimit, deadline, label = null } = {}) {
    if (!PROVER_BOARD.classes.includes(cls)) throw new Error(`class must be one of ${PROVER_BOARD.classes.join(', ')}`);
    if (!PROVER_BOARD.programs.includes(program)) throw new Error(`program must be one of ${PROVER_BOARD.programs.join(', ')}`);
    if (!PROVER_BOARD.programClasses[program].includes(cls)) throw new Error(`a ${program} job's class is ${PROVER_BOARD.programClasses[program].join(' or ')}`);
    if (mode != null && mode !== PROVER_BOARD.modes[program]) throw new Error(`a ${program} job is proved ${PROVER_BOARD.modes[program]}`);
    if (program !== 'confidential' && sealed != null) throw new Error('only a confidential job can be sealed');
    const sealedOk = sealed && typeof sealed === 'object' && typeof sealed.worker === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(sealed.worker)
      && typeof sealed.epk === 'string' && /^0x0[23][0-9a-fA-F]{64}$/.test(sealed.epk) && typeof sealed.iv === 'string' && B64.test(sealed.iv) && b64len(sealed.iv) === 12
      && typeof sealed.ct === 'string' && B64.test(sealed.ct) && b64len(sealed.ct) > 16 && b64len(sealed.ct) <= PROVER_BOARD.maxStdinBytes + 16;
    if (sealed != null && !sealedOk) throw new Error('sealed must be { worker, epk (compressed secp256k1 hex), iv (12 bytes base64), ct (base64) }');
    const maxIn = PROVER_BOARD.maxStdinBytesByProgram[program] || PROVER_BOARD.maxStdinBytes;
    if (!sealedOk && (typeof stdin !== 'string' || !stdin || !B64.test(stdin) || b64len(stdin) > maxIn)) throw new Error(`stdin must be base64 of at most ${maxIn} bytes`);
    const cyc = Number(cycleLimit), gas = Number(gasLimit), dl = Number(deadline);
    if (!Number.isFinite(cyc) || cyc <= 0 || !Number.isFinite(gas) || gas <= 0) throw new Error('cycleLimit and gasLimit must be positive');
    if (!Number.isFinite(dl) || dl * 1000 <= clock()) throw new Error('deadline must be a unix time in the future');
    if (label != null && (typeof label !== 'string' || label.length > 80)) throw new Error('label must be a short string');
    return exclusive(async () => {
      const pend = await sweep(await storage.getPending());
      const jobId = id(`${program}|${cls}|${sealedOk ? `sealed:${sealed.ct}` : stdin}`);
      const have = await storage.getJob(jobId);
      if (have && ['queued', 'claimed'].includes(have.status)) return { jobId, status: have.status, deduped: true };
      if (pend.filter((x) => x !== jobId).length >= PROVER_BOARD.maxPending) throw Object.assign(new Error('the board is full'), { code: 'full' });
      if (have && have.proofKept && storage.deleteProof) await storage.deleteProof(jobId); // the same input again: the old proof goes
      const job = { id: jobId, class: cls, program, mode: PROVER_BOARD.modes[program], stdin: sealedOk ? null : stdin, sealed: sealedOk ? { worker: sealed.worker, epk: sealed.epk, iv: sealed.iv, ct: sealed.ct } : null,
        cycleLimit: cyc, gasLimit: gas, deadline: dl, label, status: 'queued', postedAt: clock(),
        worker: null, leaseUntil: 0, claimedAt: 0, endedAt: 0, publicValues: null, proof: null, error: null, lapsed: 0 };
      await storage.putJob(jobId, job);
      await storage.putPending([...pend.filter((x) => x !== jobId), jobId]);
      return { jobId, status: 'queued' };
    });
  }

  // What the relay reads: never the input again, only where the job stands and the proof when there is one.
  async function status(jobId) {
    const j = await storage.getJob(String(jobId || ''));
    if (!j) return null;
    const live = j.status === 'claimed' && clock() > j.leaseUntil ? 'queued' : j.status === 'queued' && j.deadline && clock() > j.deadline * 1000 ? 'expired' : j.status;
    return { jobId: j.id, class: j.class, program: j.program, mode: j.mode || PROVER_BOARD.modes[j.program] || 'groth16', status: live, sealedTo: j.sealed ? j.sealed.worker : null, worker: live === 'claimed' ? j.worker : j.status === 'proved' || j.status === 'failed' ? j.worker : null,
      postedAt: j.postedAt, claimedAt: j.claimedAt || null, endedAt: j.endedAt || null, publicValues: j.publicValues, proof: j.status === 'proved' ? await proofOf(j) : j.proof, error: j.error, lapsed: j.lapsed || 0 };
  }

  // The relay gives a job up (it went to the network, or the proof that came back did not pass): a result after this is
  // ignored, and `reason` 'bad' counts against the worker that made it.
  async function cancel({ jobId, reason = null } = {}) {
    return exclusive(async () => {
      const j = await storage.getJob(String(jobId || ''));
      if (!j) return { ok: false, error: 'no such job' };
      if (!['queued', 'claimed', 'proved'].includes(j.status)) return { ok: true, status: j.status };
      if (reason === 'bad' && j.worker) await bump(j.worker, 'bad');
      j.status = 'cancelled'; over(j); j.cancelReason = reason;
      await storage.putJob(j.id, j);
      return { ok: true, status: 'cancelled' };
    });
  }

  async function bump(name, field, pubkey = null, programs = null) {
    const ws = await workers();
    const w = ws[name] || (ws[name] = { proved: 0, failed: 0, bad: 0, lapsed: 0, lastSeen: 0, firstSeen: clock() });
    if (field) w[field] = (w[field] || 0) + 1;
    if (pubkey && /^0x0[23][0-9a-fA-F]{64}$/.test(pubkey)) w.pubkey = pubkey.toLowerCase();
    if (programs) w.programs = programs;
    w.lastSeen = clock();
    await storage.putWorkers(ws);
  }

  // A worker takes the oldest job of a class it may prove, and holds it for the lease. `{}` when there is nothing.
  // `pubkey`: the key inputs may be sealed to (prover-worker/src/main.rs), shown on the summary.
  // `warming`: the worker is starting (building its prover, warming the GPU) and takes nothing yet; it is counted as seen, so the relay
  // keeps posting jobs here for the minute it takes instead of sending them to the network, and the jobs wait for it.
  // `programs`: what the worker can prove (a worker that predates them proves 'confidential' only); recorded for the summary.
  async function claim({ worker, classes, pubkey = null, warming = false, programs = null } = {}) {
    if (!worker || !Array.isArray(classes) || !classes.length) throw new Error('worker and classes are required');
    const can = Array.isArray(programs) && programs.length ? programs.filter((p) => PROVER_BOARD.programs.includes(p)) : ['confidential'];
    return exclusive(async () => {
      await bump(worker.name, null, pubkey, warming ? null : can); // a warming ping names no programs: what it proved last stands
      if (warming) return null;
      const pend = await sweep(await storage.getPending());
      await storage.putPending(pend);
      let open = 0;
      for (const jid of pend) { const j = await storage.getJob(jid); if (j && j.status === 'claimed' && j.worker === worker.name) open++; }
      if (open >= PROVER_BOARD.maxOpenPerWorker) return null;
      for (const jid of pend) {
        const j = await storage.getJob(jid);
        if (!j || j.status !== 'queued' || !classes.includes(j.class) || !worker.classes.includes(j.class) || !can.includes(j.program || 'confidential')) continue;
        if (j.sealed && j.sealed.worker !== worker.name) continue; // sealed to another worker: not even offered
        j.status = 'claimed'; j.worker = worker.name; j.claimedAt = clock(); j.leaseUntil = clock() + PROVER_BOARD.leaseMs;
        await storage.putJob(jid, j);
        return { jobId: j.id, class: j.class, program: j.program, mode: j.mode || PROVER_BOARD.modes[j.program], stdin: j.stdin, sealed: j.sealed ? { epk: j.sealed.epk, iv: j.sealed.iv, ct: j.sealed.ct } : null, cycleLimit: j.cycleLimit, gasLimit: j.gasLimit, deadline: j.deadline, leaseUntil: j.leaseUntil, label: j.label };
      }
      return null;
    });
  }

  // The worker's answer: the proof with its public values (hex), or why it could not prove the job. A groth16 proof is the hex
  // settle() takes; a compressed one is the base64 of the bincode SP1ProofWithPublicValues.
  async function result({ worker, jobId, publicValues = null, proof = null, error = null } = {}) {
    if (!worker) throw new Error('worker is required');
    return exclusive(async () => {
      const j = await storage.getJob(String(jobId || ''));
      if (!j) return { ok: false, error: 'no such job' };
      if (j.status !== 'claimed' || j.worker !== worker.name) return { ok: false, error: j.status === 'claimed' ? 'claimed by another worker' : `job is ${j.status}` };
      if (error != null) {
        j.status = 'failed'; j.error = String(error).slice(0, 300); over(j);
        await storage.putJob(j.id, j);
        await bump(worker.name, 'failed');
        return { ok: true, status: 'failed' };
      }
      if (!isHex(publicValues) || publicValues.length < 2 + 64 * 2 || publicValues.length > 2 + 2 * 65536) return { ok: false, error: 'publicValues must be the hex of the proof\'s public values' };
      if ((j.mode || PROVER_BOARD.modes[j.program]) === 'compressed') {
        if (typeof proof !== 'string' || !B64.test(proof) || b64len(proof) < 1024 || b64len(proof) > PROVER_BOARD.maxCompressedProofBytes) return { ok: false, error: 'proof must be the base64 of the saved compressed proof' };
        j.status = 'proved'; j.publicValues = publicValues.toLowerCase(); await putProof(j, proof); over(j);
      } else {
        if (!isHex(proof) || proof.length < 2 + 2 * 4 || proof.length > 2 + 2 * 4096) return { ok: false, error: 'proof must be the hex of the groth16 proof bytes' };
        j.status = 'proved'; j.publicValues = publicValues.toLowerCase(); j.proof = proof.toLowerCase(); over(j);
      }
      await storage.putJob(j.id, j);
      await bump(worker.name, 'proved');
      return { ok: true, status: 'proved' };
    });
  }

  // For anyone: how much is waiting, and who is proving. No inputs, no proofs.
  async function summary() {
    const pend = await storage.getPending();
    const counts = { queued: 0, claimed: 0, proved: 0, failed: 0 };
    const waits = [], proves = [];
    for (const jid of pend) {
      const j = await storage.getJob(jid);
      if (!j) continue;
      const live = j.status === 'claimed' && clock() > j.leaseUntil ? 'queued' : j.status;
      if (counts[live] != null) counts[live]++;
      if (j.status === 'proved' && j.postedAt && j.claimedAt && j.endedAt) { waits.push((j.claimedAt - j.postedAt) / 1000); proves.push((j.endedAt - j.claimedAt) / 1000); }
    }
    const ws = await workers();
    const list = Object.entries(ws).map(([name, w]) => ({ name, proved: w.proved || 0, failed: w.failed || 0, bad: w.bad || 0, lastSeenSeconds: w.lastSeen ? Math.max(0, Math.floor((clock() - w.lastSeen) / 1000)) : null, pubkey: w.pubkey || null, programs: w.programs || ['confidential'] }))
      .sort((a, b) => b.proved - a.proved || a.name.localeCompare(b.name));
    // How the jobs finished in the last hour fared (a job stays readable that long), in seconds: the wait for a claim, which is a worker busy with other
    // work (the proof pool's stock, an Ethereum-state proof), and the time to prove. On 2026-10-30 the wait was 1 s at the median and 24 s at the 90th
    // percentile, every wait over five seconds behind work that was not a board job, so the 90th percentile is what a second worker would move.
    const pct = (xs, p) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : null);
    const recent = { n: waits.length, waitP50: pct(waits, 0.5), waitP90: pct(waits, 0.9), proveP50: pct(proves, 0.5), proveP90: pct(proves, 0.9) };
    return { ...counts, recent, workers: list, lease: PROVER_BOARD.leaseMs / 1000 };
  }

  return { post, status, cancel, claim, result, summary };
}

const kvLocks = new WeakMap();
export function buildProverBoard(env, { hash } = {}) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!KV) return null;
  if (!kvLocks.has(KV)) kvLocks.set(KV, makeLock());
  const storage = {
    getPending: async () => { const s = await KV.get('pb:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('pb:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('pb:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('pb:job:' + id, JSON.stringify(job)),
    deleteJob: async (id) => KV.delete('pb:job:' + id),
    putProof: async (id, proof) => KV.put('pb:proof:' + id, proof),
    getProof: async (id) => KV.get('pb:proof:' + id),
    deleteProof: async (id) => KV.delete('pb:proof:' + id),
    getWorkers: async () => { const s = await KV.get('pb:workers'); return s ? JSON.parse(s) : {}; },
    putWorkers: async (ws) => KV.put('pb:workers', JSON.stringify(ws)),
  };
  return makeProverBoard({ storage, hash, lock: kvLocks.get(KV) });
}
