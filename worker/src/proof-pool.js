// The proof pool: wraps proved ahead of time on anyone's machine, for points.
//
// A wrap's proof (OP_WRAP) binds only the asset, the amount and the note commitment: no root, no deadline, no price. So it can be
// proved long before it is sent, and a page keeps it as a voucher that later deposits and settles in one router transaction with
// no wait (dapp/wrap-vouchers.js). Its program input (dapp/sp1-stdin.js stdinFor('wrap')) holds no secret: the note's opening stays
// with its holder, and the input carries only the commitment and a signature that opens it. So a page may post the input here, and
// anyone running the device prover (tacit-prover) or an idle prover-board worker may lease it, prove it and post the proof back.
//
// Each input is checked as the program checks it before it is queued (wrapOpens): its signature must open its commitment, or no
// prover could prove it.
// Each proof is checked before it is kept: its public values must be exactly this input's (the deposit it consumes, the leaf it inserts,
// the chain it is bound to and its memo root, every one read from the input itself, so a page cannot name a deposit its input does
// not prove, and nothing else: no root, no payment), and the live SP1 verifier must take it. A proof that passes is kept for the page and earns its miner's address points
// once its deposit has landed on the pool (the points are for the UTC day the landing is seen, and a proof whose deposit has not landed within landMs earns none),
// for every proof it makes (no count a day unless one is set: the campaign's daily pot already bounds what is paid, and
// a count per address only holds back the provers who give the most, since anyone may name more addresses); the points service's mining campaign pays those points in TAC from a pocket of its
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
// a hash of its IP address, never the address itself. pp:paid:<depositId> marks a deposit already proved (paid for once), pp:mined:<leaf>
// who proved it, pp:recent the newest proofs.
import { ipBucket } from './ip-bucket.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { isHex } from './confidential-open.js';
import { makeConfidentialPool } from '../../dapp/confidential-pool.js';
import { CONFIDENTIAL_DEPLOYMENTS } from '../../dapp/confidential-deployments.js';

// The least a wrap can be, per asset, for its proof to earn points, in the units a wrap's program input holds its value in (the asset's tacitDecimals: 8 for the
// 18-decimal tokens, 6 for cUSDT). `raw` names each asset of the pool's table by ticker with its floor in whole tokens ("cETH=0.01,cTAC=10"), or any asset by its id
// with its floor in those units ("0x…=5000"); "none" or "off" is no floors, and an entry that does not parse is dropped. An asset with no entry has no floor.
// → { floors: { [assetId]: bigint }, view: { [ticker or id]: the floor as written } }
export function parseMinLand(raw, assets = CONFIDENTIAL_DEPLOYMENTS?.mainnet?.assets || []) {
  const floors = {}, view = {}, s = String(raw ?? '').trim();
  if (!s || /^(none|off)$/i.test(s)) return { floors, view };
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9]+)\s*=\s*(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const [, key, amount] = m;
    if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
      if (/^\d+$/.test(amount)) { floors[key.toLowerCase()] = BigInt(amount); view[key.toLowerCase()] = amount; }
      continue;
    }
    const a = assets.find((x) => x.ticker === key);
    if (!a) continue;
    const dec = Number(a.tacitDecimals ?? 8), [whole, frac = ''] = amount.split('.');
    if (frac.length > dec) continue;
    floors[String(a.assetId).toLowerCase()] = BigInt(whole + frac.padEnd(dec, '0'));
    view[key] = amount;
  }
  return { floors, view };
}
export const DEFAULT_MIN_LAND = 'cETH=0.01,cTAC=10,cBTC=0.0001,cUSD=10,cUSDT=10';

export const PROOF_POOL = Object.freeze({
  types: Object.freeze(['wrap']),
  maxStdinBytes: 64 * 1024,          // bincode SP1Stdin; a wrap's is under 1 KiB
  reqPerClientDay: 40,
  urgentPerClientDay: 6,             // POOL_URGENT_IP_DAILY: of those, how many a page may mark urgent (the size it expects to press first): Tacit's own prover takes them without waiting for the miners               // POOL_REQ_IP_DAILY: a key keeps 16 sizes ready (four ETH wraps, four shares in each of three farms)
  maxPending: 2000,                  // POOL_MAX_PENDING: queued and leased together
  leaseMs: 45 * 60_000,              // POOL_LEASE_MS: a laptop proves a wrap in about 15 minutes
  keepMs: 7 * 86_400_000,            // POOL_KEEP_MS: how long a finished proof stays readable
  // A proof pays when its deposit has landed on the pool (the pool's depositStatus is not 0), if that is within landMs of the proof (0: pay at the proof, as
  // before). The deposit is looked for at each of landChecks' ages after the proof, every look one batched read of the chain, and a proof not found by the last
  // look earns nothing. It needs a chain to ask (makeProofPool's `chain`).
  landMs: 7 * 86_400_000,            // POOL_LAND_MS
  landSweepMs: 20_000,               // POOL_LAND_SWEEP_MS: how often the looks that are due are made
  landChecks: Object.freeze([45_000, 180_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000, 259_200_000]),
  landPerSweep: 600,                 // looks made in one sweep at most
  landWaitMs: 6000,                  // POOL_LAND_WAIT_MS: the longest a request waits on the chain for this
  minLand: Object.freeze({}),        // POOL_MIN_LAND: the least a wrap can be, per asset id, for its proof to earn points (see parseMinLand); none unless set here or by proofPoolConfig
  minLandView: Object.freeze({}),
  pointsPerProof: 20,                // POINTS_MINE_PER_PROOF
  proofsPerMinerDay: Infinity,       // POINTS_MINE_DAILY_CAP: proofs an address is credited for in a UTC day (none: every proof)
  // A proof pays in full when it comes back within payFullSecs of its lease and less the longer it took, down to payFloorPct of the full
  // points at payFloorSecs and beyond: a laptop's proof still earns, a fast one earns more. payFloorPct 100 pays every proof the same.
  payFullSecs: 60,                   // POOL_PAY_FULL_SECS
  payFloorSecs: 600,                 // POOL_PAY_FLOOR_SECS
  payFloorPct: 50,                   // POOL_PAY_FLOOR_PCT
  strikesPerDay: 3,
  lapsesPerDay: 4,                   // POOL_LAPSES_PER_DAY: leases a client may let run out or hand back in a UTC day before it is offered nothing more (honest lapses are rare: leases and proofs matched to within five over 38 hours)
  leasesPerClient: 4,                // open leases one client may hold, one per address (a household's few machines)
  houseTakeoverMs: 25 * 60_000,      // POOL_HOUSE_TAKEOVER_MS: a miner's lease held this long without a proof can be taken over by Tacit's own prover when it is free (0: never); 99.6% of honest proofs come back inside it
  ticketsPerAddress: 3,              // POOL_TICKETS_PER_ADDRESS: at most this many of an address's places count toward a turn at once (one address leasing through a pool of proxy IPs held a ticket per IP)
  turnMs: 30_000,                    // POOL_TURN_MS: a miner counts as asking for this long after it last asked, and a new job is held this long for the one whose turn it is (0: first to ask)
  minerIdleMs: 5 * 60_000,           // POOL_MINER_IDLE_MS: a house prover's wait for the miners holds only while one has asked this recently
  holdMs: 45_000,                    // POOL_HOLD_MS: how long a page's hold keeps Tacit's own provers off the pool (a typed amount's proof is asked within seconds)
  holdMaxMs: 10 * 60_000,            // POOL_HOLD_MAX_MS: holds that run on longer than this unbroken are ignored until they lapse, so the pool is never starved
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
  const ml = parseMinLand(env.POOL_MIN_LAND === undefined || env.POOL_MIN_LAND === null || env.POOL_MIN_LAND === '' ? DEFAULT_MIN_LAND : env.POOL_MIN_LAND);
  return Object.freeze({
    ...PROOF_POOL,
    minLand: Object.freeze(ml.floors),
    minLandView: Object.freeze(ml.view),
    reqPerClientDay: n(env.POOL_REQ_IP_DAILY, PROOF_POOL.reqPerClientDay, 0, 100_000),
    urgentPerClientDay: n(env.POOL_URGENT_IP_DAILY, PROOF_POOL.urgentPerClientDay, 0, 1000),
    maxPending: n(env.POOL_MAX_PENDING, PROOF_POOL.maxPending, 1, 100_000),
    leaseMs: n(env.POOL_LEASE_MS, PROOF_POOL.leaseMs, 60_000, 86_400_000),
    minerIdleMs: n(env.POOL_MINER_IDLE_MS, PROOF_POOL.minerIdleMs, 0, 86_400_000),
    holdMs: n(env.POOL_HOLD_MS, PROOF_POOL.holdMs, 0, 600_000),
    holdMaxMs: n(env.POOL_HOLD_MAX_MS, PROOF_POOL.holdMaxMs, 0, 86_400_000),
    keepMs: n(env.POOL_KEEP_MS, PROOF_POOL.keepMs, 60_000, 30 * 86_400_000),
    landMs: n(env.POOL_LAND_MS, PROOF_POOL.landMs, 0, 30 * 86_400_000),
    landSweepMs: n(env.POOL_LAND_SWEEP_MS, PROOF_POOL.landSweepMs, 1000, 600_000),
    landWaitMs: n(env.POOL_LAND_WAIT_MS, PROOF_POOL.landWaitMs, 500, 60_000),
    pointsPerProof: n(env.POINTS_MINE_PER_PROOF, PROOF_POOL.pointsPerProof, 0, 100_000),
    proofsPerMinerDay: n(env.POINTS_MINE_DAILY_CAP, PROOF_POOL.proofsPerMinerDay, 1, 100_000),
    payFullSecs: n(env.POOL_PAY_FULL_SECS, PROOF_POOL.payFullSecs, 0, 86_400),
    payFloorSecs: n(env.POOL_PAY_FLOOR_SECS, PROOF_POOL.payFloorSecs, 1, 86_400),
    payFloorPct: n(env.POOL_PAY_FLOOR_PCT, PROOF_POOL.payFloorPct, 10, 100),
    lapsesPerDay: n(env.POOL_LAPSES_PER_DAY, PROOF_POOL.lapsesPerDay, 1, 100_000),
    turnMs: n(env.POOL_TURN_MS, PROOF_POOL.turnMs, 0, 600_000),
    ticketsPerAddress: n(env.POOL_TICKETS_PER_ADDRESS, PROOF_POOL.ticketsPerAddress, 1, 1000),
    houseTakeoverMs: n(env.POOL_HOUSE_TAKEOVER_MS, PROOF_POOL.houseTakeoverMs, 0, 86_400_000),
  });
}

// The share of a proof's full points it earns for taking `secs` from lease to proof: all of it up to payFullSecs, falling in a straight
// line to payFloorPct at payFloorSecs, and that much beyond. Terms that do not make a slope (the floor not past the full time, or a
// floor of 100) pay every proof in full.
export function payFactor(secs, cfg) {
  const full = Number(cfg.payFullSecs), floor = Number(cfg.payFloorSecs), pct = Number(cfg.payFloorPct) / 100;
  const s = Number(secs);
  if (!(floor > full) || !(pct >= 0 && pct < 1) || !(s > full)) return 1;
  return s >= floor ? pct : 1 - ((1 - pct) * (s - full)) / (floor - full);
}
// The points a proof earns: the full points scaled by how long it took, whole points, at least one while any are paid.
export const payFor = (secs, cfg) => (cfg.pointsPerProof > 0 ? Math.max(1, Math.round(cfg.pointsPerProof * payFactor(secs, cfg))) : 0);

// A fixed point in [0, 1) for a job and an address, or for a job and a client: a hash of the two.
export const drawOf = (id, who) => {
  const h = sha256(new TextEncoder().encode(`tacit-pool-turn|${id}|${String(who).toLowerCase()}`));
  return (h[0] * 65536 + h[1] * 256 + h[2]) / 16777216;
};

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
  const sigR = vec(13, 33, 'the signature\'s R'), sigZ = vec(14, 32, 'the signature\'s z');
  const memoHash = vec(15, 32, 'the memo hash');
  return { chainBinding, asset, value, cx, cy, owner, sigR, sigZ, memoHash };
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

// Every public value a wrap's proof commits, from the wrap itself: abi.encode of ConfidentialPool.PublicValues (the settle guest's
// PublicValues, field k in word 1 + k) with version 1, the chain binding, the one leaf, the one deposit and the memo root, and every
// other field zero or empty: a wrap proves against no root and spends, pays, withdraws and swaps nothing.
const PV_FIELDS = 31, PV_LISTS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 17, 18, 19, 22, 23, 24, 25, 26, 28, 29, 30]);
export function wrapPublicValues(expect) {
  const word = (x) => BigInt(x).toString(16).padStart(64, '0');
  const head = [], tail = [];
  for (let f = 0; f < PV_FIELDS; f++) {
    if (!PV_LISTS.has(f)) { head.push(word(f === 0 ? 1 : f === 1 ? expect.chainBinding : f === 27 ? expect.memoRoot : 0)); continue; }
    const items = f === 4 ? [expect.leaf] : f === 5 ? [expect.depositId] : [];
    head.push(word(32 * (PV_FIELDS + tail.length)));
    tail.push(word(items.length), ...items.map(word));
  }
  return '0x' + word(32) + head.join('') + tail.join('');
}

// Whether public values are this wrap's: exactly the ones above, so a proof of any other op, or of this wrap against any root, is not
// this job's however valid.
export function proofFits(publicValues, expect) {
  try { return String(publicValues).replace(/^0x/, '').toLowerCase() === wrapPublicValues(expect).slice(2); } catch { return false; }
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

// The deposit a wrap-style op opens, read from the head of its program input, which the ops that open one write alike: the chain binding,
// five roots, one op, its type byte, the asset, the value, the deposit's commitment (cx, cy), owner and opening signature (R, z). OP_WRAP
// is type 0 and OP_WRAPTRANSFER 27; what follows differs per op and is not read. Returns what wrapOpens takes, or an Error saying why not.
export function readDepositHead(bytes, opType) {
  let off = 0;
  const u64 = () => {
    if (off + 8 > bytes.length) throw new Error('the input ends early');
    let x = 0n;
    for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[off + i]);
    off += 8;
    return x;
  };
  const count = u64();
  if (count < 15n) throw new Error('the input is too short to hold a deposit');
  const e = [];
  for (let i = 0; i < 15; i++) {
    const len = u64();
    if (len > BigInt(bytes.length - off)) throw new Error('the input ends early');
    e.push(bytes.subarray(off, off + Number(len)));
    off += Number(len);
  }
  const vec = (i, n, what) => {
    const b = e[i];
    if (b.length !== 8 + n || b[0] !== n || b.subarray(1, 8).some((x) => x)) throw new Error(`${what} must be ${n} bytes`);
    return b.subarray(8);
  };
  if (e[6].length !== 4 || e[6][0] !== 1 || e[6][1] || e[6][2] || e[6][3]) throw new Error('the input must hold one op');
  if (e[7].length !== 1 || e[7][0] !== opType) throw new Error(`the op must be type ${opType}`);
  if (e[9].length !== 8) throw new Error('the value must be a u64');
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(e[9][i]);
  return { chainBinding: vec(0, 32, 'the chain binding'), asset: vec(8, 32, 'the asset'), value, cx: vec(10, 32, 'cx'), cy: vec(11, 32, 'cy'),
    owner: vec(12, 32, 'the owner'), sigR: vec(13, 33, 'the signature\'s R'), sigZ: vec(14, 32, 'the signature\'s z'), memoHash: new Uint8Array(32) };
}

// Whether a wrap opens as the program checks it (contracts/sp1/confidential/src/main.rs, OP_WRAP): the commitment is a point on the
// curve, and the signature (R, z) opens it to the value over the wrap's intent context. The program stops on one that does not.
// OP_WRAPTRANSFER checks its deposit the same way under its own tag (`tag`, 'tacit-wraptransfer-intent-v1').
let kit = null;
export function wrapOpens(w, tag = 'tacit-wrap-intent-v1') {
  try {
    kit ||= makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
    const hx = (b) => '0x' + bytesToHex(b);
    const cx = hx(w.cx), cy = hx(w.cy), owner = hx(w.owner);
    secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) }).assertValidity();
    const ctx = kit.intentContext(tag, hx(w.chainBinding), hx(w.asset), wrapExpect(w).depositId, [[cx, cy, owner]], [w.value]);
    return kit.verifyOpeningSigma(cx, cy, w.value, hx(w.sigR), hx(w.sigZ), ctx) === true;
  } catch { return false; }
}
const stdinOpens = (stdin) => { try { return wrapOpens(readWrapStdin(hexToBytes(String(stdin).replace(/^0x/, '')))); } catch { return false; } };

// ── the pool ──

const DAY_MS = 86_400_000;
const dayOf = (t) => Math.floor(t / DAY_MS);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
export const POOL_ID = /^[0-9a-f]{32}$/;
const reply = (status, body) => ({ status, body });

// A client as the pool keeps it: a keyed hash of its IP address (a bare hash of an IPv4 address can be undone by trying them all).
export const clientOf = (ip, env = {}) => ipBucket(env, ip).slice(0, 16);

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
// `chain` (optional) reads the pool's side of Ethereum: depositStatuses(depositIds) the pool's depositStatus of each (0 none, 1 pending, 2 consumed), an array in the
// same order with null for one that could not be read, or null when none could. With one, and landMs set, a proof pays when its deposit lands (see PROOF_POOL.landMs);
// without one a proof pays at once.
export function makeProofPool({ kv, cfg = PROOF_POOL, verify, now, lock, random, registry, chain } = {}) {
  if (!kv) throw new Error('proof-pool: kv is required');
  if (typeof verify !== 'function') throw new Error('proof-pool: verify is required');
  const landing = !!chain && cfg.landMs > 0;
  const clock = now || (() => Date.now());
  const exclusive = lock || makeLock();
  const token = random || (() => bytesToHex(crypto.getRandomValues(new Uint8Array(16))));
  const K = { queue: 'pp:queue', leases: 'pp:leases', job: (id) => `pp:job:${id}`, day: (d) => `pp:day:${d}`, req: (d, c) => `pp:req:${d}:${c}`, urg: (d, c) => `pp:urg:${d}:${c}`, minerSeen: 'pp:miner-seen', hold: 'pp:hold', mined: (leaf) => `pp:mined:${leaf}`, paid: (dep) => `pp:paid:${dep}`, recent: 'pp:recent', pend: (dep) => `pp:pend:${dep}`, got: (dep) => `pp:got:${dep}`, chk: (slot) => `pp:chk:${slot}`, chkAt: 'pp:chkat' };
  const read = async (key, dflt) => { const s = await kv.get(key); if (s == null) return dflt; try { return JSON.parse(s); } catch { return dflt; } };
  const write = (key, v, ttlSecs) => kv.put(key, JSON.stringify(v), ttlSecs ? { expirationTtl: ttlSecs } : undefined);
  const dayRec = async (d) => { const r = await read(K.day(d), null); return { done: 0, points: 0, miners: {}, clients: {}, ...(r && typeof r === 'object' ? r : {}) }; };
  const minerIn = (rec, m) => rec.miners[m] || (rec.miners[m] = { proofs: 0, credited: 0, points: 0 });
  const earns = (rec, m) => ((rec.miners[m]?.credited || 0) < cfg.proofsPerMinerDay ? cfg.pointsPerProof : 0);
  // Whether a job's wrap is smaller than the least that earns points for its asset (cfg.minLand): by the asset and value its request kept, or read from the input of a job
  // posted before requests kept them. An asset with no floor, or an input that cannot be read, is not below one.
  function belowMinimum(job) {
    if (!job || !cfg.minLand || !Object.keys(cfg.minLand).length) return false;
    let asset = job.asset, value = job.value != null ? BigInt(job.value) : null;
    if (asset == null || value == null) {
      try { const w = readWrapStdin(hexToBytes(String(job.stdin).replace(/^0x/, ''))); asset = '0x' + bytesToHex(w.asset); value = w.value; } catch { return false; }
    }
    const floor = cfg.minLand[String(asset).toLowerCase()];
    return floor != null && value < floor;
  }

  // Who is asking for work, by (address, client), kept in memory: a miner asks every few seconds, and a restart only means the next
  // asks fill it again. A new job is held for the asker whose turn for it comes first. A turn belongs to the place (the client): its draw for the
  // job, and nothing of the address, which anyone may name as often as they like. Every place has the same chance, however many addresses
  // it asks under or how often it asks (inside `turnMs`); a swarm gains by places and not by wallets. (An earlier rule took the later of the
  // address's and the place's draw, so a swarm of N addresses over M places held N x M pairs and took the best: 20 x 20 won four jobs in five
  // against thirty honest askers; by places alone it is about two in five.) Within one place the address with the earlier draw goes first.
  // `registry` is where they are kept: the route builds a pool afresh for every request, so a registry made inside one would hold only the asker of that request, who
  // would always be the one whose turn it is (that is how the turn rule went unused in production from 11-14 until it was found: the tests reuse one pool). buildProofPool
  // gives every pool on a KV the same registry.
  const reg = registry || { askers: new Map(), holders: new Map(), sweptAt: 0, landAt: 0 }, askers = reg.askers, holders = reg.holders;
  // `lapses`: leases this client has let run out or handed back today. Such a client's turn comes after every other asker's: a place that takes a lease and
  // sits on it (so the job waits out the whole lease for whoever asks first) must not win the next turn too, and can only pick up what nobody else is asking for.
  function noteAsker(m, client, t, lapses = 0) {
    askers.set(`${m}|${client}`, { m, client, at: t, lapses });
    if (t - reg.sweptAt < 1000) return;
    reg.sweptAt = t;
    for (const [k, a] of askers) if (t - a.at > cfg.turnMs) askers.delete(k);
    for (const [id, h] of holders) if (t - h.at > 60_000) holders.delete(id);
  }
  function askerView(t) {
    const by = new Map();
    for (const a of askers.values()) if (t - a.at <= cfg.turnMs) by.set(a.m, (by.get(a.m) || 0) + 1);
    let places = 0, counted = 0;
    for (const n of by.values()) { places += n; counted += Math.min(n, cfg.ticketsPerAddress); }
    const top = [...by.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([miner, n]) => ({ miner: miner.slice(0, 10), places: n }));
    return { places, addresses: by.size, tickets: counted, top };
  }
  // the asker a young job is held for: the earliest turn among those who asked within `turnMs` and may take it; read again each second
  function holderOf(e, t) {
    const memo = holders.get(e.id);
    if (memo && t - memo.at < 1000) return memo.key;
    let key = null, best = Infinity;
    // An address counts at most `ticketsPerAddress` of its places at once, the same few whichever job it is (a fixed order by the address's and the place's
    // own hash, not by the job's draws, which would let more places mean a better best): one address leasing through a pool of proxy IPs had held a ticket
    // for every one of them. It can still spread over more addresses; that is a wallet each, and its points are spread with it.
    const live = new Map();
    for (const [k, a] of askers) {
      if (t - a.at > cfg.turnMs || (e.skip || []).includes(a.client)) continue;
      if (!live.has(a.m)) live.set(a.m, []);
      live.get(a.m).push([k, a]);
    }
    for (const list of live.values()) {
      if (list.length > cfg.ticketsPerAddress) list.sort((x, y) => drawOf(`ticket|${x[1].m}`, x[1].client) - drawOf(`ticket|${y[1].m}`, y[1].client) || (x[0] < y[0] ? -1 : 1));
      for (const [k, a] of list.slice(0, cfg.ticketsPerAddress)) {
        const v = drawOf(e.id, a.client) + drawOf(e.id, a.m) / 1e4 + (a.lapses > 0 ? 1 : 0);
        if (v < best || (v === best && k < key)) { best = v; key = k; }
      }
    }
    holders.set(e.id, { at: t, key });
    return key;
  }

  // A job back in the queue at its age, or dropped once it has had its tries (`tried`: a lease that ran out or was handed back,
  // not a proof that failed, which is the miner's fault and not the job's). The miner that had it is not offered it again.
  // `returned`: when it came back. It is held for a fresh turn from then (lease), not offered to whoever asks first because it is old: a job that waited out
  // a lease would otherwise go to whoever asked in the very second the lease ran out, and the one who sat on it knows that second.
  async function giveBack(q, id, l, tried, t = null) {
    const tries = (l.tries || 0) + (tried ? 1 : 0), skip = [...new Set([...(l.skip || []), l.client])].slice(-16);
    if (tries >= cfg.maxTries) { await kv.delete(K.job(id)); return; }
    holders.delete(id);                       // whom it was held for before is no longer the question
    const e = { id, at: l.at, tries, skip, ...(t != null ? { returned: t } : {}), ...(l.urgent ? { urgent: true } : {}) };
    const i = q.findIndex((x) => x.at > e.at);
    if (i < 0) q.push(e); else q.splice(i, 0, e);
  }
  // A lease a client let run out or handed back: counted against that client for the day (never against an address, which anyone may
  // name), so a few places cannot hold the queue up or wear its jobs out with leases they never mean to prove. Tacit's own provers are
  // not counted.
  async function lapsed(l, t) {
    if (l.house) return;
    const d = dayOf(t), rec = await dayRec(d);
    rec.lapses = { ...(rec.lapses || {}), [l.client]: ((rec.lapses || {})[l.client] || 0) + 1 };
    await write(K.day(d), rec, cfg.daySecs);
  }
  // Leases that ran out go back. → whether anything changed.
  async function reclaim(q, L, t) {
    let changed = false;
    for (const [id, l] of Object.entries(L)) {
      if (l.until > t) continue;
      delete L[id];
      await giveBack(q, id, l, true, t);
      await lapsed(l, t);
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
    let w, want;
    try { w = readWrapStdin(bytes); want = wrapExpect(w); } catch (err) { return reply(400, { ok: false, code: 'bad_stdin', error: `not a wrap's program input: ${err.message}` }); }
    if (!expect || typeof expect !== 'object' || !B32.test(String(expect.depositId)) || !B32.test(String(expect.leaf))) {
      return reply(400, { ok: false, code: 'bad_expect', error: 'expect must be { depositId, leaf }, each 0x and 32 bytes' });
    }
    if (expect.depositId.toLowerCase() !== want.depositId || expect.leaf.toLowerCase() !== want.leaf) {
      return reply(400, { ok: false, code: 'bad_expect', error: 'expect is not the deposit and the leaf this input proves' });
    }
    if (!wrapOpens(w)) return reply(400, { ok: false, code: 'bad_opening', error: 'the input\'s signature does not open its commitment, so it cannot be proved' });
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
      await write(K.job(id), { id, type, stdin: stdin.toLowerCase(), expect: want, status: 'open', postedAt: t, opens: true, asset: '0x' + bytesToHex(w.asset), value: String(w.value) });
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
  // and a few on a client in all. A job younger than `turnMs` is held for the asker whose turn it is (holderOf), so how often a miner
  // asks, and from how many places, does not decide who takes it. `minAgeMs`: only a job that has waited at least that long. `house`: one of Tacit's own provers (a
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
      // a page is about to ask for a proof that is not in the pool: Tacit's own provers stay free for it (a proof cannot be stopped once
      // it starts, so one begun now would hold the person up for its whole run); miners lease as ever
      if (house && t < (await read(K.hold, { until: 0 })).until) return reply(204, null);
      const q = await read(K.queue, []), L = await read(K.leases, {});
      let changed = await reclaim(q, L, t);
      const save = async () => { if (changed) { await write(K.queue, q); await write(K.leases, L); } };
      const rec = await dayRec(dayOf(t));
      if ((rec.clients[client] || 0) >= cfg.strikesPerDay) {
        await save();
        return reply(403, { ok: false, code: 'struck_out', error: `${cfg.strikesPerDay} proofs that did not pass today; nothing more is leased here until the next UTC day` });
      }
      if (!house && ((rec.lapses || {})[client] || 0) >= cfg.lapsesPerDay) {
        await save();
        return reply(403, { ok: false, code: 'lapsed_out', error: `${cfg.lapsesPerDay} leases ran out or were handed back today; nothing more is leased here until the next UTC day` });
      }
      const held = Object.entries(L).filter(([, l]) => l.client === client), open = held.find(([, l]) => l.miner === m);
      if (open) { await save(); return reply(429, { ok: false, code: 'lease_open', id: open[0], error: 'one lease at a time: send its proof (or hand it back) first' }); }
      if (held.length >= cfg.leasesPerClient) { await save(); return reply(429, { ok: false, code: 'lease_open', error: `at most ${cfg.leasesPerClient} leases from one place at a time` }); }
      if (!house && cfg.turnMs) noteAsker(m, client, t, (rec.lapses || {})[client] || 0);
      for (let i = 0; i < q.length;) {
        const e = q[i];
        // the wait for the miners holds for ordinary jobs; one marked urgent is taken at once, and the younger ones behind an unripe job are looked at too
        if (minAge && t - e.at < minAge && !e.urgent) { i++; continue; }
        if ((e.skip || []).includes(client)) { i++; continue; }
        // a miner takes a young job only when it is the one the job is held for; an older one, or any job for Tacit's own prover, goes to whoever asks
        if (!house && cfg.turnMs && t - (e.returned ?? e.at) < cfg.turnMs && holderOf(e, t) !== `${m}|${client}`) { i++; continue; }
        q.splice(i, 1);
        changed = true;
        const job = await read(K.job(e.id), null);
        if (!job || job.status !== 'open') continue;          // gone from under its place: dropped
        // a job not marked as opening is checked as it comes up, and dropped if it does not open
        if (!job.opens && !stdinOpens(job.stdin)) { await kv.delete(K.job(e.id)); continue; }
        const l = { lease: token(), until: t + cfg.leaseMs, miner: m, client, at: e.at, tries: e.tries || 0, skip: e.skip || [], ...(e.urgent ? { urgent: true } : {}), ...(house ? { house: true } : {}) };
        L[e.id] = l;
        askers.delete(`${m}|${client}`);          // proving now: not asking again until it asks
        await save();
        return reply(200, { ok: true, id: e.id, type: job.type, stdin: job.stdin, lease: l.lease, leaseMs: cfg.leaseMs, points: house || belowMinimum(job) ? 0 : earns(rec, m) });
      }
      // Nothing waiting: Tacit's own prover, free, takes over the lease that has been held the longest past `houseTakeoverMs` without a proof, so a page's wrap does
      // not wait out the whole lease for a miner that is not proving it (a lease taken and sat on). The miner's lease is gone (its late proof is not taken) and the
      // lapse counts against its place; the house's proof earns nothing, as ever. 99.6% of honest proofs come back well inside the time, and what is taken over is
      // one the page has already waited that long for.
      if (house && cfg.houseTakeoverMs > 0) {
        const stale = Object.entries(L).filter(([, x]) => !x.house && x.until > t && t - (x.until - cfg.leaseMs) >= cfg.houseTakeoverMs).sort((a, b) => a[1].until - b[1].until)[0];
        const job = stale ? await read(K.job(stale[0]), null) : null;
        if (stale && job && job.status === 'open') {
          const [id, old] = stale;
          await lapsed(old, t);
          const dr = await dayRec(dayOf(t));
          dr.takeovers = (dr.takeovers || 0) + 1;
          await write(K.day(dayOf(t)), dr, cfg.daySecs);
          const l = { lease: token(), until: t + cfg.leaseMs, miner: m, client, at: old.at, tries: (old.tries || 0) + 1, skip: [...new Set([...(old.skip || []), old.client])].slice(-16), ...(old.urgent ? { urgent: true } : {}), house: true };
          L[id] = l;
          changed = true;
          await save();
          return reply(200, { ok: true, id, type: job.type, stdin: job.stdin, lease: l.lease, leaseMs: cfg.leaseMs, points: 0 });
        }
      }
      await save();
      return reply(204, null);
    });
  }

  // A page's word that a proof is about to be asked of Tacit's own provers (an amount typed that no kept proof covers): for `holdMs` they
  // lease nothing from the pool, so the proof asked for finds the GPU free. Holds that run on unbroken past `holdMaxMs` are not
  // extended until they lapse, and a run longer than one hold is followed by a rest as long as its extensions ran before the next run
  // starts, so holds asked without end leave the pool's own provers at least half the time.
  async function hold() {
    if (!cfg.holdMs) return reply(200, { ok: true, until: 0 });
    return exclusive(async () => {
      const t = clock(), h = await read(K.hold, { until: 0, since: 0 });
      const ran = Number.isFinite(h.since) ? Math.max(0, h.until - h.since - cfg.holdMs) : 0;
      if (t >= h.until && t < h.until + ran) return reply(200, { ok: true, until: h.until });
      const since = t < h.until ? h.since : t;
      if (t - since >= cfg.holdMaxMs) return reply(200, { ok: true, until: h.until });
      const until = Math.max(h.until, t + cfg.holdMs);
      await write(K.hold, { until, since }, Math.ceil((cfg.holdMs + 2 * cfg.holdMaxMs) / 1000) + 60);
      return reply(200, { ok: true, until });
    });
  }

  // A proof that is not its job's: the job goes back for someone else without using up a try, and, when the answer is certain,
  // the client that leased it takes a strike.
  async function refuse(L, id, l, t, strike) {
    const q = await read(K.queue, []);
    delete L[id];
    await giveBack(q, id, l, false, t);
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
        await giveBack(q, id, l, true, t);
        await write(K.queue, q);
        await write(K.leases, L);
        await lapsed(l, t);
        return { r: reply(200, { ok: true, released: true }) };
      }
      const job = await read(K.job(id), null);
      if (!job || job.status !== 'open') { delete L[id]; await write(K.leases, L); return { r: noLease }; }
      if (!proofFits(publicValues, job.expect)) {
        await refuse(L, id, l, t, true);
        return { r: reply(400, { ok: false, code: 'bad_proof', error: 'these public values are not this job\'s: they must be exactly its wrap\'s (its deposit, its leaf, its chain binding and memo root, and no root)' }) };
      }
      return { r: null, dep: String(job.expect?.depositId || '').toLowerCase(), house: !!l.house, small: belowMinimum(job) };
    });
    if (first.r) return first.r;
    let v;
    try { v = await verify({ publicValues, proof }); } catch { v = {}; }
    if (!v || (!v.ok && !v.reverted)) return reply(503, { ok: false, code: 'chain_unreadable', error: 'the verifier could not be asked just now; send it again (the lease still holds)', retryAfter: 30 });
    // Whether this proof's deposit is on the pool already (asked here, outside the lock like the verifier: it is a call to Ethereum, and bounded; Tacit's own
    // provers earn nothing and are not asked about, nor is a wrap below its asset's minimum).
    const onPool = landing && v.ok && first.dep && !first.house && !first.small ? (await statusesOf([first.dep], cfg.landWaitMs))[0] : null;
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
      await bumpHour(t, l.house ? null : l.miner);
      // Who made the note, for the block it lands in (tacit-chain.js), and the newest proofs: a community prover by its address,
      // Tacit's own provers as the house, which earns nothing and is never in the tally.
      const leaf = String(job.expect?.leaf || '').toLowerCase(), secs = Math.max(0, Math.round((t - (l.until - cfg.leaseMs)) / 1000));
      // `shown` is what the feed says when that differs from what the note keeps: a proof waiting for its deposit shows no points until it lands.
      const made = async (who, shown = who) => {
        if (leaf) await write(K.mined(leaf), { ...who, at: t }, cfg.daySecs);
        const feed = await read(K.recent, []);
        await write(K.recent, [...feed, { at: t, ...shown, secs }].slice(-cfg.top * 2));
      };
      if (l.house) {
        rec.house = (rec.house || 0) + 1;
        await write(K.day(d), rec, cfg.daySecs);
        const dep = String(job.expect?.depositId || '').toLowerCase();
        if (!dep || (await read(K.paid(dep), null)) == null) { if (dep) await write(K.paid(dep), t, cfg.daySecs); await made({ house: true, points: 0 }); }
        return reply(200, { ok: true, points: 0 });
      }
      // A deposit is paid for once: its input can be posted again with a changed signature (a new job, the same deposit and leaf), which
      // the same proof answers, so a deposit already proved earns nothing more and its leaf keeps who proved it first.
      const dep = String(job.expect?.depositId || '').toLowerCase();
      const again = dep ? (await read(K.paid(dep), null)) != null : false;
      if (dep && !again) await write(K.paid(dep), t, cfg.daySecs);
      // A job that came back (a lease ran out or was handed back, so its page has waited) is paid by its age from the page's request, not from the lease that
      // proved it: whoever takes it up after the wait does not earn full speed pay for the page's wait. A job on its first lease is timed from the lease as ever.
      const waited = (l.tries || 0) > 0 ? Math.max(0, Math.round((t - l.at) / 1000)) : 0, paySecs = Math.max(secs, waited);
      const small = belowMinimum(job), mr = minerIn(rec, l.miner), points = !again && !small && earns(rec, l.miner) > 0 ? payFor(paySecs, cfg) : 0;
      mr.proofs++;
      // A proof pays when its deposit has landed on the pool (see PROOF_POOL.landMs): one whose deposit is there already pays now, any other waits in
      // pp:pend:<deposit> until a look at the pool (check) finds it there, and lapses after landMs. A deposit whose status could not be read waits too.
      const waiting = landing && !!dep && points > 0 && !(onPool >= 1);
      if (points > 0 && !waiting) { mr.credited++; mr.points += points; rec.points += points; if (landing) rec.landed = (rec.landed || 0) + 1; }
      if (waiting) { rec.pended = (rec.pended || 0) + 1; await write(K.pend(dep), { miner: l.miner, points, at: t }, Math.ceil(cfg.landMs / 1000) + 3600); await enqueue(dep, 0, t, t); }
      await write(K.day(d), rec, cfg.daySecs);
      const extra = waited > secs ? { waited } : {};
      if (!again) await made({ miner: l.miner, points, ...extra }, waiting ? { miner: l.miner, points: 0, pending: points, ...extra } : undefined);
      return reply(200, { ok: true, points, ...(waiting ? { pending: true } : {}), ...(small ? { belowMinimum: true } : {}) });
    });
  }

  // What `p` answers if it does so within `ms` (and does not throw), else null (it is left to finish, its answer dropped).
  const within = (ms, p) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });

  // The pool's depositStatus of each deposit (0 none, 1 pending, 2 consumed), in order, null for one that could not be read: one batched read of the chain, bounded.
  async function statusesOf(deps, ms) {
    if (!deps.length) return [];
    const r = await within(ms, Promise.resolve().then(() => chain.depositStatuses(deps)));
    return Array.isArray(r) && r.length === deps.length ? r.map((x) => (Number.isInteger(x) && x >= 0 ? x : null)) : deps.map(() => null);
  }

  // A deposit is looked for at each of landChecks' ages after its proof: `n` is the look, `at` the proof's time. The looks are kept by the minute they fall due
  // (pp:chk:<minute>), never earlier than `delay` from now. Under the lock. False when there is no such look left (the deposit has lapsed).
  async function enqueue(dep, n, at, now, delay = 1000) {
    if (n >= cfg.landChecks.length) return false;
    const due = Math.max(at + cfg.landChecks[n], now + delay);
    if (due - at > cfg.landMs) return false;
    if (await read(K.chkAt, null) == null) await write(K.chkAt, Math.floor(now / 60_000) - 1);
    const key = K.chk(Math.floor(due / 60_000)), list = await read(key, []);
    list.push([dep, n]);
    await write(key, list, Math.ceil(cfg.landMs / 1000) + 7200);
    return true;
  }

  // The proofs whose deposits have landed, each paid on the day this runs (a day that is over never changes), if it has not lapsed and its address still earns that
  // day; one that waited is shown in the feed with its points from then. The day's tally and the feed are written first and the waiting records cleared after, so
  // a failure part-way loses nothing (pp:got:<deposit> keeps the retry from paying twice). Under the lock.
  async function land(deps, t) {
    const d = dayOf(t), paid = [], clear = [];
    let rec = null, feed = null;
    for (const dep of new Set(deps)) {
      const p = await read(K.pend(dep), null);
      if (!p || typeof p.miner !== 'string') continue;
      if (await read(K.got(dep), null) != null) { clear.push(dep); continue; }
      clear.push(dep);
      if (t - p.at > cfg.landMs) continue;
      rec = rec || await dayRec(d);
      if (earns(rec, p.miner) <= 0) continue;
      const mr = minerIn(rec, p.miner);
      mr.credited++; mr.points += p.points; rec.points += p.points; rec.landed = (rec.landed || 0) + 1; paid.push(dep);
      feed = feed || await read(K.recent, []);
      const e = feed.find((x) => x.at === p.at && x.miner === p.miner && x.pending != null);
      if (e) { e.points = e.pending; delete e.pending; }
    }
    if (rec) await write(K.day(d), rec, cfg.daySecs);
    if (feed) await write(K.recent, feed);
    for (const dep of paid) await write(K.got(dep), t, Math.ceil(cfg.landMs / 1000) + 86_400);
    for (const dep of clear) await kv.delete(K.pend(dep));
    return paid.length;
  }

  // The looks that are due, from the last one made up to the current minute: the deposits asked about in one batched read of the chain; one found on the pool is paid, any
  // other is looked for again at its next age (a proof not found by the last age earns nothing), one that could not be read again in two minutes. A chain that cannot be
  // read at all leaves the looks where they are.
  async function check(t) {
    const nowSlot = Math.floor(t / 60_000);
    const cur = await read(K.chkAt, null);
    if (!Number.isSafeInteger(cur)) { await write(K.chkAt, nowSlot - 1); return; }
    const slots = [], lists = [];
    let n = 0;
    for (let s = cur + 1; s < nowSlot && s <= cur + 60; s++) {   // only minutes that are over: a look is never early, and one queued now never falls in a slot cleared below
      const list = await read(K.chk(s), []);
      if (n > 0 && n + list.length > cfg.landPerSweep) break;
      slots.push(s); lists.push(list); n += list.length;
    }
    if (!slots.length) return;
    const entries = lists.flat(), deps = entries.map(([dep]) => dep);
    const st = await statusesOf(deps, cfg.landWaitMs * 4);
    // What the last look found, for stats: whether the chain answered for all of them, some, or none.
    if (deps.length) reg.look = { at: clock(), n: deps.length, how: st.every((x) => x === null) ? 'failed' : st.some((x) => x === null) ? 'partial' : 'ok' };
    if (deps.length && st.every((x) => x === null)) return;
    await exclusive(async () => {
      const now = clock();
      await land(deps.filter((_, i) => st[i] >= 1), now);
      let lapsed = 0;
      for (let i = 0; i < entries.length; i++) {
        if (st[i] >= 1) continue;
        const [dep, k] = entries[i], p = await read(K.pend(dep), null);
        if (!p) continue;
        if (!(st[i] === null ? await enqueue(dep, k, p.at, now, 120_000) : await enqueue(dep, k + 1, p.at, now))) lapsed++;
      }
      // The day's counts of deposits looked for and of waiting proofs with no look left (after land, which writes the day's record itself).
      const seen = st.filter((x) => x !== null).length;
      if (seen || lapsed) {
        const d = dayOf(now), rec = await dayRec(d);
        rec.looked = (rec.looked || 0) + seen;
        rec.lapsedLand = (rec.lapsedLand || 0) + lapsed;
        await write(K.day(d), rec, cfg.daySecs);
      }
      for (const s of slots) await kv.delete(K.chk(s));
      await write(K.chkAt, slots[slots.length - 1]);
    });
  }

  // Make the looks that are due, at most every landSweepMs. Nothing here throws: a store or chain that cannot be reached just now leaves the looks for the next time.
  async function sweep() {
    if (!landing || clock() - (reg.landAt || 0) < cfg.landSweepMs) return;
    reg.landAt = clock();
    try { await check(clock()); } catch { /* the same looks are made next time */ }
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

  // The last 24 hours, so the counts do not drop to nothing at midnight UTC: pp:hour:<n> holds an hour's proofs and who made them
  // (a community prover by its address; Tacit's own counted, never named).
  const HOUR_MS = 3_600_000;
  async function bumpHour(t, miner) {
    const k = `pp:hour:${Math.floor(t / HOUR_MS)}`, h = await read(k, { done: 0, miners: {} });
    h.done++;
    if (miner) h.miners[miner] = (h.miners[miner] || 0) + 1;
    await write(k, h, 26 * 3600);
  }
  async function lastDay(t) {
    const now = Math.floor(t / HOUR_MS), hours = await Promise.all(Array.from({ length: 24 }, (_, i) => read(`pp:hour:${now - i}`, null)));
    const miners = new Set();
    let done = 0;
    for (const h of hours) if (h) { done += h.done || 0; for (const m of Object.keys(h.miners || {})) miners.add(m); }
    return { done, miners: miners.size };
  }

  // For anyone: how much is waiting, who proved most today, and the last 24 hours' proofs and provers. No inputs, no proofs, no clients.
  async function stats() {
    await within(cfg.landWaitMs, sweep());
    const t = clock(), q = await read(K.queue, []), L = await read(K.leases, {}), rec = await dayRec(dayOf(t));
    const live = Object.values(L).filter((l) => l.until > t).length;
    const miners = Object.entries(rec.miners).filter(([, m]) => m.proofs > 0);
    const day = await lastDay(t);
    const secs = (ms) => Math.max(0, Math.round(ms / 1000));
    return reply(200, {
      // today is inside the last 24 hours, so never fewer than today's (the hours count only from when this began keeping them)
      queued: q.length + Object.keys(L).length - live, leased: live, doneToday: rec.done, minersToday: miners.length,
      // how long the oldest waiting job has waited, and the longest a lease has been out: a pool that is stuck shows in these
      oldestQueuedSecs: q.length ? secs(t - Math.min(...q.map((e) => e.at))) : 0,
      oldestLeaseSecs: live ? secs(Math.max(...Object.values(L).filter((l) => l.until > t).map((l) => t - (l.until - cfg.leaseMs)))) : 0,
      done24h: Math.max(day.done, rec.done), miners24h: Math.max(day.miners, miners.length),
      // leases let run out or handed back today, and the places that did: a pool whose leases are sat on shows here (honest ones are rare)
      lapsedToday: Object.values(rec.lapses || {}).reduce((a, n) => a + n, 0), lapsedPlacesToday: Object.keys(rec.lapses || {}).length,
      // proofs Tacit's own prover made today (the backstop: nobody else took the job in time) and the leases it took over from a miner that sat on them
      houseToday: rec.house || 0, takeoversToday: rec.takeovers || 0,
      // proofs paid today because their deposit landed on the pool (they may be earlier days' proofs)
      // Whether the landing check is running and what it finds, so a day with nothing landed can be told from a check that is not looking: proofs that waited for
      // their deposit, deposits looked for on the pool, proofs with no look left, and this process's last sweep and last look (`how`: the chain answered for all,
      // some or none of them).
      ...(landing ? { landedToday: rec.landed || 0, pendedToday: rec.pended || 0, lookedToday: rec.looked || 0, lapsedLandToday: rec.lapsedLand || 0,
        lastSweep: reg.landAt || null, lastLook: reg.look ? { at: reg.look.at, n: reg.look.n, how: reg.look.how } : null } : {}),
      // who is asking for work as this process sees it, for the last `turnMs` (the pool keeps it in memory, per process): places and addresses registered, how many
      // tickets they count for once an address is held to `ticketsPerAddress`, and the addresses with the most places (an address is already public on the board)
      askers: askerView(t),
      top: miners.map(([miner, m]) => ({ miner, proofs: m.proofs })).sort((a, b) => b.proofs - a.proofs || (a.miner < b.miner ? -1 : 1)).slice(0, cfg.top),
      // pointsPerProof is the most a proof earns; `pay` says how it falls with the time a proof took (payFor, payFactor)
      terms: { pointsPerProof: cfg.pointsPerProof, proofsPerMinerDay: cfg.proofsPerMinerDay, leaseMs: cfg.leaseMs,
        pay: { fullSecs: cfg.payFullSecs, floorSecs: cfg.payFloorSecs, floorPct: cfg.payFloorPct }, takeoverSecs: Math.round(cfg.houseTakeoverMs / 1000), ticketsPerAddress: cfg.ticketsPerAddress,
        // a proof earns its points when its deposit lands on the pool, if that is within windowSecs of the proof (absent: it earns them at the proof)
        ...(landing ? { landing: { windowSecs: Math.round(Math.min(cfg.landMs, cfg.landChecks[cfg.landChecks.length - 1]) / 1000) } } : {}),
        // the least a wrap can be, per asset, for its proof to earn points (absent: no floors)
        ...(Object.keys(cfg.minLandView || {}).length ? { minLand: cfg.minLandView } : {}) },
    });
  }

  // A UTC day's tally, for the points service's mining campaign: each address's proofs and the points they earned. `over` once the
  // day has ended, after which it no longer changes (a proof is credited to the day it passed on).
  async function credits(day) {
    const t = clock();
    if (!Number.isSafeInteger(day) || day < 0 || day > dayOf(t)) return reply(400, { ok: false, error: 'day must be a UTC day number, today or before' });
    await within(cfg.landWaitMs, sweep());
    const rec = await dayRec(day);
    const miners = Object.entries(rec.miners).filter(([, m]) => m.points > 0).map(([miner, m]) => ({ miner, proofs: m.proofs, points: m.points }))
      .sort((a, b) => (a.miner < b.miner ? -1 : 1));
    return reply(200, { day, over: t >= (day + 1) * DAY_MS, pointsPerProof: cfg.pointsPerProof, miners });
  }

  // The leaves a pool proof inserted, each with who made it: { [leaf]: { miner, points } } for a community prover, { house: true } for Tacit's own.
  async function minedBy(leaves) {
    const out = {};
    for (const leaf of new Set(leaves.map((x) => String(x).toLowerCase()))) {
      const m = B32.test(leaf) ? await read(K.mined(leaf), null) : null;
      if (m) out[leaf] = m.house ? { house: true } : { miner: m.miner, points: m.points };
    }
    return out;
  }

  // The newest pool proofs, newest first: when, by whom (a community address, or the house), the points and how long it took from lease to proof.
  async function recent() {
    return reply(200, { proofs: (await read(K.recent, [])).slice().reverse() });
  }

  return { request, lease, hold, submit, results, stats, credits, minedBy, recent };
}

const kvLocks = new WeakMap(), kvRegistries = new WeakMap();
export function buildProofPool(env, { verify, chain } = {}) {
  const kv = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!kv) return null;
  if (!kvLocks.has(kv)) kvLocks.set(kv, makeLock());
  if (!kvRegistries.has(kv)) kvRegistries.set(kv, { askers: new Map(), holders: new Map(), sweptAt: 0, landAt: 0 });
  return makeProofPool({ kv, cfg: proofPoolConfig(env), verify, chain, lock: kvLocks.get(kv), registry: kvRegistries.get(kv) });
}
