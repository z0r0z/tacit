// The proof pool: wraps proved ahead of time on anyone's machine, for points.
//
// A wrap's proof (OP_WRAP) binds only the asset, the amount and the note commitment: no root, no deadline, no price. So it can be
// proved long before it is sent, and a page keeps it as a voucher that later deposits and settles in one router transaction with
// no wait (dapp/wrap-vouchers.js). Its program input (dapp/sp1-stdin.js stdinFor('wrap')) holds no secret: the note's opening stays
// with its holder, and the input carries only the commitment and a signature that opens it. So a page may post the input here, and
// anyone running the device prover (tacit-prover) or an idle prover-board worker may lease it, prove it and post the proof back.
//
// Each proof is checked before it is kept: its public values must be this input's (the deposit it consumes, the leaf it inserts,
// the chain it is bound to and its memo root, every one read from the input itself, so a page cannot name a deposit its input does
// not prove), and the live SP1 verifier must take it. A proof that passes is kept for the page and earns its miner's address points
// for the UTC day, up to a number of proofs a day; the points service's mining campaign pays those points in TAC from a pocket of its
// own once the day is over, reading the day's tally from GET /prover/pool/credits. A proof that fails goes back to the queue for
// someone else and, when the answer is certain, is a strike against the client that leased it; three strikes in a day and that client
// is offered nothing more that day. Strikes, the jobs a miner is not offered again and the lease limits all go by the client, never
// by the address: anyone may name any address, so a limit on the address would let one miner shut another out.
//
// Nothing is bonded and nothing is signed: a miner names the address its points go to, and a lease is a random token only the
// lessee holds. A lease that runs out puts its job back at its age (oldest first), and a miner that cannot prove a job may hand it
// back; a job nobody has proved after three such tries is dropped, since an input that cannot be proved would otherwise go round
// forever. The client that had it is not offered it again.
//
// Storage (KV, portable to Cloudflare's): pp:queue ([{ id, at, tries, skip }], oldest first), pp:leases (id → { lease, until, miner,
// client, at, tries, skip }), pp:job:<id> (the input until it is proved, then only the proof), pp:day:<day> (the day's miners, the
// clients' strikes and counts, kept long enough for the campaign to read), pp:req:<day>:<client> (the requests one client made that day). A client is
// a hash of its IP address, never the address itself.
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { isHex } from './confidential-open.js';

export const PROOF_POOL = Object.freeze({
  types: Object.freeze(['wrap']),
  maxStdinBytes: 64 * 1024,          // bincode SP1Stdin; a wrap's is under 1 KiB
  reqPerClientDay: 40,
  urgentPerClientDay: 6,             // POOL_URGENT_IP_DAILY: of those, how many a page may mark urgent (the size it expects to press first): Tacit's own prover takes them without waiting for the miners               // POOL_REQ_IP_DAILY: a key keeps 16 sizes ready (four ETH wraps, four shares in each of three farms)
  maxPending: 2000,                  // POOL_MAX_PENDING: queued and leased together
  leaseMs: 45 * 60_000,              // POOL_LEASE_MS: a laptop proves a wrap in about 15 minutes
  keepMs: 7 * 86_400_000,            // POOL_KEEP_MS: how long a finished proof stays readable
  pointsPerProof: 20,                // POINTS_MINE_PER_PROOF
  proofsPerMinerDay: 30,             // POINTS_MINE_DAILY_CAP: proofs an address is credited for in a UTC day
  strikesPerDay: 3,
  leasesPerClient: 4,                // open leases one client may hold, one per address (a household's few machines)
  minerIdleMs: 5 * 60_000,           // POOL_MINER_IDLE_MS: a house prover's wait for the miners holds only while one has asked this recently
  maxTries: 3,
  maxResultIds: 32,
  top: 20,
  daySecs: 40 * 86400,               // a day's tally outlives the campaign's reading of it
});

// The pool's numbers from the environment, each checked: a value out of range keeps the default.
export function proofPoolConfig(env = {}) {
  const n = (v, dflt, lo, hi) => {
    if (v === undefined || v === null || v === '') return dflt;
    const x = Number(v);
    return Number.isInteger(x) && x >= lo && x <= hi ? x : dflt;
  };
  return Object.freeze({
    ...PROOF_POOL,
    reqPerClientDay: n(env.POOL_REQ_IP_DAILY, PROOF_POOL.reqPerClientDay, 0, 100_000),
    urgentPerClientDay: n(env.POOL_URGENT_IP_DAILY, PROOF_POOL.urgentPerClientDay, 0, 1000),
    maxPending: n(env.POOL_MAX_PENDING, PROOF_POOL.maxPending, 1, 100_000),
    leaseMs: n(env.POOL_LEASE_MS, PROOF_POOL.leaseMs, 60_000, 86_400_000),
    minerIdleMs: n(env.POOL_MINER_IDLE_MS, PROOF_POOL.minerIdleMs, 0, 86_400_000),
    keepMs: n(env.POOL_KEEP_MS, PROOF_POOL.keepMs, 60_000, 30 * 86_400_000),
    pointsPerProof: n(env.POINTS_MINE_PER_PROOF, PROOF_POOL.pointsPerProof, 0, 100_000),
    proofsPerMinerDay: n(env.POINTS_MINE_DAILY_CAP, PROOF_POOL.proofsPerMinerDay, 0, 100_000),
  });
}

// ── the input and the proof ──

// The wrap a program input asks for, read back from its bytes, or an Error saying why it is not one wrap as exec-wrap.rs writes it.
// The bytes are bincode of SP1Stdin { buffer, ptr, proofs } (dapp/sp1-stdin.js): a u64 count of entries, each a u64 length and its
// bytes, then ptr and proofs, both 0. A wrap's sixteen entries: the chain binding, five roots (all zero: a wrap proves against
// none), one op, OP_WRAP, the asset, the value, the commitment (cx, cy), the owner, the opening signature (R, z) and one memo hash.
// Each Vec<u8> entry is itself bincode (a u64 length, then the bytes); the integers are little-endian.
export function readWrapStdin(bytes) {
  let off = 0;
  const u64 = () => {
    if (off + 8 > bytes.length) throw new Error('the input ends early');
    let x = 0n;
    for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[off + i]);
    off += 8;
    return x;
  };
  if (u64() !== 16n) throw new Error('a wrap\'s input has sixteen entries (one wrap, one memo hash)');
  const e = [];
  for (let i = 0; i < 16; i++) {
    const len = u64();
    if (len > BigInt(bytes.length - off)) throw new Error('the input ends early');
    e.push(bytes.subarray(off, off + Number(len)));
    off += Number(len);
  }
  if (u64() !== 0n || u64() !== 0n || off !== bytes.length) throw new Error('the input must end with no pointer, no proofs and nothing after');
  const vec = (i, n, what) => {
    const b = e[i];
    if (b.length !== 8 + n || b[0] !== n || b.subarray(1, 8).some((x) => x)) throw new Error(`${what} must be ${n} bytes`);
    return b.subarray(8);
  };
  const chainBinding = vec(0, 32, 'the chain binding');
  for (let i = 1; i <= 5; i++) if (vec(i, 32, 'a root').some((x) => x)) throw new Error('a wrap proves against no root, so its roots are zero');
  if (e[6].length !== 4 || e[6][0] !== 1 || e[6][1] || e[6][2] || e[6][3]) throw new Error('the input must hold one op');
  if (e[7].length !== 1 || e[7][0] !== 0) throw new Error('the op must be a wrap (OP_WRAP)');
  const asset = vec(8, 32, 'the asset');
  if (e[9].length !== 8) throw new Error('the value must be a u64');
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(e[9][i]);
  const cx = vec(10, 32, 'cx'), cy = vec(11, 32, 'cy'), owner = vec(12, 32, 'the owner');
  vec(13, 33, 'the signature\'s R'); vec(14, 32, 'the signature\'s z');
  const memoHash = vec(15, 32, 'the memo hash');
  return { chainBinding, asset, value, cx, cy, owner, memoHash };
}

// What a wrap's proof must commit to, from the wrap itself (dapp/confidential-pool.js leaf, depositId; cxfer-core memo_root): the
// leaf keccak(asset ‖ cx ‖ cy ‖ owner), the deposit keccak(asset ‖ value as 32 bytes ‖ keccak(cx ‖ cy ‖ owner)), the chain binding,
// and the memo root keccak(0³² ‖ memo hash).
export function wrapExpect(w) {
  const k = (...parts) => keccak_256(concatBytes(...parts));
  const be32 = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
  const hx = (b) => '0x' + bytesToHex(b);
  return {
    depositId: hx(k(w.asset, be32(w.value), k(w.cx, w.cy, w.owner))),
    leaf: hx(k(w.asset, w.cx, w.cy, w.owner)),
    chainBinding: hx(w.chainBinding),
    memoRoot: hx(k(new Uint8Array(32), w.memoHash)),
  };
}

// Whether public values are this wrap's, read as the page reads them (confidential-pool-ux.js wrapProofFits): abi.encode of
// ConfidentialPool.PublicValues, a tuple whose field k sits in word 1 + k, so word 2 is the chain binding, words 5 and 6 point at
// `leaves` and `depositsConsumed`, and word 28 is the memo root. It consumes exactly this deposit and inserts exactly this leaf,
// for the chain and the memos its input named: any other proof, however valid, is not this job's.
export function proofFits(publicValues, expect) {
  try {
    const h = String(publicValues).replace(/^0x/, '').toLowerCase();
    if (!h.length || h.length % 64 || !/^[0-9a-f]+$/.test(h)) return false;
    const n = h.length / 64;
    const word = (i) => { if (!(i >= 0 && i < n)) throw new Error('short'); return '0x' + h.slice(i * 64, i * 64 + 64); };
    const w = (i) => BigInt(word(i));
    if (w(0) !== 32n) return false;
    const list = (head) => {
      const at = 1n + w(head) / 32n, len = w(Number(at));
      if (w(head) % 32n || at + 1n + len > BigInt(n)) throw new Error('short');
      return Array.from({ length: Number(len) }, (_, k) => word(Number(at) + 1 + k));
    };
    const lc = (x) => String(x).toLowerCase();
    const leaves = list(5), deposits = list(6);
    return leaves.length === 1 && leaves[0] === lc(expect.leaf) && deposits.length === 1 && deposits[0] === lc(expect.depositId)
      && word(2) === lc(expect.chainBinding) && word(28) === lc(expect.memoRoot);
  } catch { return false; }
}

// abi.encode for the SP1 verifier's verifyProof(bytes32 programVKey, bytes publicValues, bytes proofBytes), with its selector. It
// returns nothing and reverts on a proof it does not take.
export const VERIFY_SELECTOR = '0x41493c60';
export function verifyCalldata({ vkey, publicValues, proof }) {
  const strip = (x) => String(x).replace(/^0x/, '').toLowerCase();
  const num = (x) => BigInt(x).toString(16).padStart(64, '0');
  const bytes = (hex) => num(hex.length / 2) + hex + '0'.repeat((64 - (hex.length % 64)) % 64);
  const pv = bytes(strip(publicValues)), pf = bytes(strip(proof));
  return VERIFY_SELECTOR + strip(vkey).padStart(64, '0') + num(96) + num(96 + pv.length / 2) + pv + pf;
}

// ── the pool ──

const DAY_MS = 86_400_000;
const dayOf = (t) => Math.floor(t / DAY_MS);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
export const POOL_ID = /^[0-9a-f]{32}$/;
const reply = (status, body) => ({ status, body });

// A client as the pool keeps it: a hash of its IP address.
export const clientOf = (ip) => bytesToHex(sha256(new TextEncoder().encode(`tacit-proof-pool-client|${ip}`))).slice(0, 16);

function makeLock() {
  let tail = Promise.resolve();
  return (fn) => { const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; };
}
// Two tokens compared without stopping at the first difference.
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

// kv: { get(key) → string|null, put(key, value, { expirationTtl }?), delete(key) }.
// verify({ publicValues, proof }) → { ok } when the verifier takes the proof, { reverted, definite } when it refuses it, and
// neither when it could not be asked (index.js ethCallVerdict).
// Every call answers { status, body }; 204 has no body.
export function makeProofPool({ kv, cfg = PROOF_POOL, verify, now, lock, random } = {}) {
  if (!kv) throw new Error('proof-pool: kv is required');
  if (typeof verify !== 'function') throw new Error('proof-pool: verify is required');
  const clock = now || (() => Date.now());
  const exclusive = lock || makeLock();
  const token = random || (() => bytesToHex(crypto.getRandomValues(new Uint8Array(16))));
  const K = { queue: 'pp:queue', leases: 'pp:leases', job: (id) => `pp:job:${id}`, day: (d) => `pp:day:${d}`, req: (d, c) => `pp:req:${d}:${c}`, urg: (d, c) => `pp:urg:${d}:${c}`, minerSeen: 'pp:miner-seen' };
  const read = async (key, dflt) => { const s = await kv.get(key); if (s == null) return dflt; try { return JSON.parse(s); } catch { return dflt; } };
  const write = (key, v, ttlSecs) => kv.put(key, JSON.stringify(v), ttlSecs ? { expirationTtl: ttlSecs } : undefined);
  const dayRec = async (d) => { const r = await read(K.day(d), null); return { done: 0, points: 0, miners: {}, clients: {}, ...(r && typeof r === 'object' ? r : {}) }; };
  const minerIn = (rec, m) => rec.miners[m] || (rec.miners[m] = { proofs: 0, credited: 0, points: 0 });
  const earns = (rec, m) => ((rec.miners[m]?.credited || 0) < cfg.proofsPerMinerDay ? cfg.pointsPerProof : 0);

  // A job back in the queue at its age, or dropped once it has had its tries (`tried`: a lease that ran out or was handed back,
  // not a proof that failed, which is the miner's fault and not the job's). The miner that had it is not offered it again.
  async function giveBack(q, id, l, tried) {
    const tries = (l.tries || 0) + (tried ? 1 : 0), skip = [...new Set([...(l.skip || []), l.client])].slice(-16);
    if (tries >= cfg.maxTries) { await kv.delete(K.job(id)); return; }
    const e = { id, at: l.at, tries, skip, ...(l.urgent ? { urgent: true } : {}) };
    const i = q.findIndex((x) => x.at > e.at);
    if (i < 0) q.push(e); else q.splice(i, 0, e);
  }
  // Leases that ran out go back. → whether anything changed.
  async function reclaim(q, L, t) {
    let changed = false;
    for (const [id, l] of Object.entries(L)) {
      if (l.until > t) continue;
      delete L[id];
      await giveBack(q, id, l, true);
      changed = true;
    }
    return changed;
  }

  // A page posts a wrap to be proved. The same input posted again is the same job (its id is the first 16 bytes of the input's
  // sha256, as tacit-prover names a job), and costs nothing against the day's requests.
  // `urgent`: the page expects to press this one first (its most likely size): up to `urgentPerClientDay` a day are marked so, and a house prover leases a marked job
  // at once instead of holding back for the miners; past the cap it is asked as any other.
  async function request({ type, stdin, expect, client = 'anon', urgent = false } = {}) {
    if (!cfg.types.includes(type)) return reply(400, { ok: false, code: 'bad_type', error: `type must be one of ${cfg.types.join(', ')}` });
    if (typeof stdin !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(stdin) || (stdin.length - 2) / 2 > cfg.maxStdinBytes) {
      return reply(400, { ok: false, code: 'bad_stdin', error: `stdin must be the 0x-hex of a bincode SP1Stdin of at most ${cfg.maxStdinBytes} bytes` });
    }
    const bytes = hexToBytes(stdin.slice(2));
    let want;
    try { want = wrapExpect(readWrapStdin(bytes)); } catch (err) { return reply(400, { ok: false, code: 'bad_stdin', error: `not a wrap's program input: ${err.message}` }); }
    if (!expect || typeof expect !== 'object' || !B32.test(String(expect.depositId)) || !B32.test(String(expect.leaf))) {
      return reply(400, { ok: false, code: 'bad_expect', error: 'expect must be { depositId, leaf }, each 0x and 32 bytes' });
    }
    if (expect.depositId.toLowerCase() !== want.depositId || expect.leaf.toLowerCase() !== want.leaf) {
      return reply(400, { ok: false, code: 'bad_expect', error: 'expect is not the deposit and the leaf this input proves' });
    }
    const id = bytesToHex(sha256(bytes)).slice(0, 32);
    return exclusive(async () => {
      const t = clock();
      const q = await read(K.queue, []), L = await read(K.leases, {});
      let changed = await reclaim(q, L, t);
      const save = async () => { if (changed) { await write(K.queue, q); await write(K.leases, L); } };
      const have = await read(K.job(id), null);
      if (have && have.status === 'done' && t - have.doneAt < cfg.keepMs) { await save(); return reply(200, { ok: true, id, deduped: true }); }
      if (have && have.status === 'open') {
        // Still waiting. A record that lost its place in the queue (a write that never landed) gets it back.
        if (!L[id] && !q.some((e) => e.id === id)) { q.push({ id, at: have.postedAt, tries: 0, skip: [] }); q.sort((a, b) => a.at - b.at); changed = true; }
        // asked again as urgent (a page that has since opened its card): the place it already has is marked
        const waiting = q.find((e) => e.id === id);
        if (urgent === true && waiting && !waiting.urgent) { const d = dayOf(t), u = Number(await kv.get(K.urg(d, client))) || 0; if (u < cfg.urgentPerClientDay) { waiting.urgent = true; changed = true; await kv.put(K.urg(d, client), String(u + 1), { expirationTtl: 2 * 86400 }); } }
        await save();
        return reply(200, { ok: true, id, deduped: true });
      }
      const d = dayOf(t), n = Number(await kv.get(K.req(d, client))) || 0;
      if (n >= cfg.reqPerClientDay) { await save(); return reply(429, { ok: false, code: 'pool_cap', error: `at most ${cfg.reqPerClientDay} proofs asked for from one place a day; this one can still be proved another way` }); }
      if (q.length + Object.keys(L).length >= cfg.maxPending) { await save(); return reply(429, { ok: false, code: 'pool_full', error: 'the pool is full just now; prove this one another way' }); }
      await write(K.job(id), { id, type, stdin: stdin.toLowerCase(), expect: want, status: 'open', postedAt: t });
      const u = urgent === true ? Number(await kv.get(K.urg(d, client))) || 0 : 0, mark = urgent === true && u < cfg.urgentPerClientDay;
      q.push({ id, at: t, tries: 0, skip: [], ...(mark ? { urgent: true } : {}) });
      changed = true;
      await save();
      await kv.put(K.req(d, client), String(n + 1), { expirationTtl: 2 * 86400 });
      if (mark) await kv.put(K.urg(d, client), String(u + 1), { expirationTtl: 2 * 86400 });
      return reply(200, { ok: true, id });
    });
  }

  // A miner takes the oldest job its client has not had before, and holds it for the lease: one open lease per address on a client,
  // and a few on a client in all. `minAgeMs`: only a job that has waited at least that long. `house`: one of Tacit's own provers (a
  // board worker, by its token), which takes what has waited and earns nothing: its proofs are kept for the pages but never enter
  // the day's tally, so the miners' share is never paid to Tacit. A house prover's wait is for the miners: it holds only while a
  // miner has asked for work within `minerIdleMs`; with none about, a page's proofs are made at once.
  // `points`: what the proof would earn if it passed now (0 once the address has its proofs for the day: the work is still welcome).
  async function lease({ miner, client = 'anon', minAgeMs = 0, house = null } = {}) {
    if (!house && (typeof miner !== 'string' || !ADDR.test(miner))) return reply(400, { ok: false, code: 'bad_miner', error: 'miner must be the 0x address the points go to' });
    const m = house ? `house:${house}` : miner.toLowerCase();
    let minAge = Number.isSafeInteger(minAgeMs) && minAgeMs > 0 ? minAgeMs : 0;
    return exclusive(async () => {
      const t = clock();
      // a miner asking (with work or without) keeps the house waiting; its time is written at most once a minute
      const seen = Number(await read(K.minerSeen, 0)) || 0;
      if (!house && t - seen > 60_000) await write(K.minerSeen, t, 86400);
      if (house && minAge && t - seen > cfg.minerIdleMs) minAge = 0;
      const q = await read(K.queue, []), L = await read(K.leases, {});
      let changed = await reclaim(q, L, t);
      const save = async () => { if (changed) { await write(K.queue, q); await write(K.leases, L); } };
      const rec = await dayRec(dayOf(t));
      if ((rec.clients[client] || 0) >= cfg.strikesPerDay) {
        await save();
        return reply(403, { ok: false, code: 'struck_out', error: `${cfg.strikesPerDay} proofs that did not pass today; nothing more is leased here until the next UTC day` });
      }
      const held = Object.entries(L).filter(([, l]) => l.client === client), open = held.find(([, l]) => l.miner === m);
      if (open) { await save(); return reply(429, { ok: false, code: 'lease_open', id: open[0], error: 'one lease at a time: send its proof (or hand it back) first' }); }
      if (held.length >= cfg.leasesPerClient) { await save(); return reply(429, { ok: false, code: 'lease_open', error: `at most ${cfg.leasesPerClient} leases from one place at a time` }); }
      for (let i = 0; i < q.length;) {
        const e = q[i];
        // the wait for the miners holds for ordinary jobs; one marked urgent is taken at once, and the younger ones behind an unripe job are looked at too
        if (minAge && t - e.at < minAge && !e.urgent) { i++; continue; }
        if ((e.skip || []).includes(client)) { i++; continue; }
        q.splice(i, 1);
        changed = true;
        const job = await read(K.job(e.id), null);
        if (!job || job.status !== 'open') continue;          // gone from under its place: dropped
        const l = { lease: token(), until: t + cfg.leaseMs, miner: m, client, at: e.at, tries: e.tries || 0, skip: e.skip || [], ...(e.urgent ? { urgent: true } : {}), ...(house ? { house: true } : {}) };
        L[e.id] = l;
        await save();
        return reply(200, { ok: true, id: e.id, type: job.type, stdin: job.stdin, lease: l.lease, leaseMs: cfg.leaseMs, points: house ? 0 : earns(rec, m) });
      }
      await save();
      return reply(204, null);
    });
  }

  // A proof that is not its job's: the job goes back for someone else without using up a try, and, when the answer is certain,
  // the client that leased it takes a strike.
  async function refuse(L, id, l, t, strike) {
    const q = await read(K.queue, []);
    delete L[id];
    await giveBack(q, id, l, false);
    await write(K.queue, q);
    await write(K.leases, L);
    if (!strike) return;
    const d = dayOf(t), rec = await dayRec(d);
    rec.clients[l.client] = (rec.clients[l.client] || 0) + 1;
    await write(K.day(d), rec, cfg.daySecs);
  }

  // The miner's answer: the proof and its public values (0x-hex), or `error` to hand back a job it cannot prove. The public values
  // are checked first, then the verifier is asked (outside the lock: it is a call to Ethereum), then the lease is checked again.
  async function submit({ id, lease: tok, publicValues, proof, error = null } = {}) {
    if (typeof id !== 'string' || !POOL_ID.test(id) || typeof tok !== 'string' || !tok) return reply(400, { ok: false, code: 'bad_request', error: 'id and lease are required' });
    if (error == null && (!isHex(publicValues, 64, 64 * 1024) || !isHex(proof, 4, 4096))) {
      return reply(400, { ok: false, code: 'bad_request', error: 'publicValues and proof must be the 0x-hex the prover returned' });
    }
    const noLease = reply(409, { ok: false, code: 'no_lease', error: 'that lease is not held: it ran out, was handed back, or never was' });
    const first = await exclusive(async () => {
      const t = clock();
      const L = await read(K.leases, {}), l = L[id];
      if (!l || !same(l.lease, tok) || l.until <= t) return { r: noLease };
      if (error != null) {
        const q = await read(K.queue, []);
        delete L[id];
        await giveBack(q, id, l, true);
        await write(K.queue, q);
        await write(K.leases, L);
        return { r: reply(200, { ok: true, released: true }) };
      }
      const job = await read(K.job(id), null);
      if (!job || job.status !== 'open') { delete L[id]; await write(K.leases, L); return { r: noLease }; }
      if (!proofFits(publicValues, job.expect)) {
        await refuse(L, id, l, t, true);
        return { r: reply(400, { ok: false, code: 'bad_proof', error: 'these public values are not this job\'s: they must consume its deposit, insert its leaf and carry its chain binding and memo root' }) };
      }
      return { r: null };
    });
    if (first.r) return first.r;
    let v;
    try { v = await verify({ publicValues, proof }); } catch { v = {}; }
    if (!v || (!v.ok && !v.reverted)) return reply(503, { ok: false, code: 'chain_unreadable', error: 'the verifier could not be asked just now; send it again (the lease still holds)', retryAfter: 30 });
    return exclusive(async () => {
      const t = clock();
      const L = await read(K.leases, {}), l = L[id];
      // Checked while the lease held: one that ran out while the verifier was asked still counts, one handed on does not.
      if (!l || !same(l.lease, tok)) return noLease;
      if (!v.ok) {
        await refuse(L, id, l, t, !!v.definite);
        return reply(400, { ok: false, code: 'bad_proof', error: 'the SP1 verifier refuses this proof' });
      }
      const job = await read(K.job(id), null);
      delete L[id];
      await write(K.leases, L);
      if (!job || job.status !== 'open') return noLease;
      // Kept for the page without its input, which nobody needs any more.
      await write(K.job(id), { id, type: job.type, expect: job.expect, status: 'done', postedAt: job.postedAt, doneAt: t, miner: l.miner,
        publicValues: publicValues.toLowerCase(), proof: proof.toLowerCase() }, Math.ceil(cfg.keepMs / 1000));
      const d = dayOf(t), rec = await dayRec(d);
      rec.done++;
      if (l.house) { rec.house = (rec.house || 0) + 1; await write(K.day(d), rec, cfg.daySecs); return reply(200, { ok: true, points: 0 }); }
      const mr = minerIn(rec, l.miner), points = earns(rec, l.miner);
      mr.proofs++;
      if (points > 0) { mr.credited++; mr.points += points; rec.points += points; }
      await write(K.day(d), rec, cfg.daySecs);
      return reply(200, { ok: true, points });
    });
  }

  // Where each job stands, with the proof once there is one. An id the pool does not hold (never posted, dropped, or kept past
  // its time) is gone.
  async function results(ids) {
    const t = clock(), L = await read(K.leases, {}), out = {};
    for (const id of ids) {
      const j = POOL_ID.test(id) ? await read(K.job(id), null) : null;
      if (!j) out[id] = { status: 'gone' };
      else if (j.status === 'done') out[id] = t - j.doneAt < cfg.keepMs ? { status: 'done', publicValues: j.publicValues, proof: j.proof } : { status: 'gone' };
      else out[id] = { status: L[id] && L[id].until > t ? 'leased' : 'queued' };
    }
    return reply(200, { results: out });
  }

  // For anyone: how much is waiting, and who proved most today. No inputs, no proofs, no clients.
  async function stats() {
    const t = clock(), q = await read(K.queue, []), L = await read(K.leases, {}), rec = await dayRec(dayOf(t));
    const live = Object.values(L).filter((l) => l.until > t).length;
    const miners = Object.entries(rec.miners).filter(([, m]) => m.proofs > 0);
    return reply(200, {
      queued: q.length + Object.keys(L).length - live, leased: live, doneToday: rec.done, minersToday: miners.length,
      top: miners.map(([miner, m]) => ({ miner, proofs: m.proofs })).sort((a, b) => b.proofs - a.proofs || (a.miner < b.miner ? -1 : 1)).slice(0, cfg.top),
      terms: { pointsPerProof: cfg.pointsPerProof, proofsPerMinerDay: cfg.proofsPerMinerDay, leaseMs: cfg.leaseMs },
    });
  }

  // A UTC day's tally, for the points service's mining campaign: each address's proofs and the points they earned. `over` once the
  // day has ended, after which it no longer changes (a proof is credited to the day it passed on).
  async function credits(day) {
    const t = clock();
    if (!Number.isSafeInteger(day) || day < 0 || day > dayOf(t)) return reply(400, { ok: false, error: 'day must be a UTC day number, today or before' });
    const rec = await dayRec(day);
    const miners = Object.entries(rec.miners).filter(([, m]) => m.points > 0).map(([miner, m]) => ({ miner, proofs: m.proofs, points: m.points }))
      .sort((a, b) => (a.miner < b.miner ? -1 : 1));
    return reply(200, { day, over: t >= (day + 1) * DAY_MS, pointsPerProof: cfg.pointsPerProof, miners });
  }

  return { request, lease, submit, results, stats, credits };
}

const kvLocks = new WeakMap();
export function buildProofPool(env, { verify } = {}) {
  const kv = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!kv) return null;
  if (!kvLocks.has(kv)) kvLocks.set(kv, makeLock());
  return makeProofPool({ kv, cfg: proofPoolConfig(env), verify, lock: kvLocks.get(kv) });
}
