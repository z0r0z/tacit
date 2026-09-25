// Secret Sats Join: coordinator-less equal-denomination joins to silent-payment outputs
// (contracts/sp1/confidential/DESIGN-secret-sats-join.md, "§N" below).
//
// Participants bring one confirmed coin each, meet on an untrusted bulletin board, shuffle their output
// keys with a DC-net and each build the same transaction. Every participant signs only after it has
// rebuilt that transaction and found its own output in it.
//
// Pure: runs in the browser and in Node. Network access goes through two injected interfaces:
//   board  { info(), post(topic, msg), poll(topic, since, waitMs), topics(), evidence(), log(topic, txid) }
//          makeHttpBoard(url) implements it over fetch; worker-relay/src/join-board.js is the server.
//   chain  { tipHeight(), getTx(txid) (Esplora shape), getOutspend(txid, vout), broadcast(hex) }
//          makeEsploraChain(base) implements it.
// Keys are passed in: the page hands over its silent-payment identity (scanPriv, spendPub, spendPriv) and
// the private key of each coin it registers.

import { secp, sha256, ripemd160, hmac, hexToBytes, bytesToHex, concatBytes } from './vendor/tacit-deps.min.js';
import {
  bip352TaggedHash as taggedHash, bip352OutpointBytes, bip352SmallestOutpoint, bip352InputPubkey,
  bip352PublicTweakPoint, bip352U32be,
} from './bip352.js';

if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, concatBytes(...m));

const Point = secp.ProjectivePoint;
const G = Point.BASE;
const ZERO = Point.ZERO;
const N = secp.CURVE.n;
const P = secp.CURVE.p;
const enc = new TextEncoder();

// ─────────────────────────────────────────────────────────────── parameters (§2)

export const BUCKETS = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120];
export const T_STEP_MS = 30_000;
export const AGE_MIN = 6;
export const SEQUENCE = 0xfffffffd;
export const MAX_WEIGHT = 400_000;

// Tiers per network. The 10,000-sat tier exists on signet only, so a demo round of several participants
// fits a small faucet budget.
export const NETWORKS = {
  mainnet: { kMin: 10, kMax: 100, tiers: [100_000, 1_000_000], laterTiers: [10_000_000, 100_000_000], hrp: 'bc' },
  signet: { kMin: 3, kMax: 20, tiers: [10_000, 100_000, 1_000_000], laterTiers: [], hrp: 'tb' },
};

export function networkParams(network) {
  const p = NETWORKS[network];
  if (!p) throw new Error(`join: unknown network ${network}`);
  return p;
}

// a(fr) = max(1,000, ⌈(240 + 124·fr) / 500⌉ · 500): one follow-on key-path spend of d plus a 240-sat anchor.
export function allowance(fr) {
  checkBucket(fr);
  return Math.max(1000, Math.ceil((240 + 124 * fr) / 500) * 500);
}

export function outputValue(d, fr) { return d + allowance(fr); }

export function checkBucket(fr) {
  if (!BUCKETS.includes(fr)) throw new Error(`join: ${fr} sat/vB is not a fee bucket`);
  return fr;
}

// f_in(fr, P2TR) = ⌈fr × (57.5 + 43 + s)⌉, f_in(fr, P2WPKH) = ⌈fr × (68 + 43 + s)⌉, s = ⌈11 / k_min⌉.
// Computed in half-vbytes so the 57.5 stays an integer.
export function inputFee(fr, type, kMin) {
  const s = Math.ceil(11 / kMin);
  const halfVb = type === 'p2tr' ? 201 + 2 * s : type === 'p2wpkh' ? 222 + 2 * s : null;
  if (halfVb == null) throw new Error(`join: input type ${type} is not allowed`);
  return Math.ceil((fr * halfVb) / 2);
}

// Excess ceiling: a coin whose excess over o + f_in exceeds max(f_in, 5,000) belongs in a higher bucket.
export function excessCeiling(fr, type, kMin) { return Math.max(inputFee(fr, type, kMin), 5000); }

// Value of each entry-transaction output (§2.4): o + f_in(fr, P2TR) + margin, margin = f_in(fr_est, P2TR).
export function entryOutputValue({ d, fr, kMin, frEst = fr, margin = null }) {
  return outputValue(d, fr) + inputFee(fr, 'p2tr', kMin) + (margin ?? inputFee(frEst, 'p2tr', kMin));
}

// Bucket choice (§2.1): the smallest bucket ≥ fr_own, or the next one up when its open topic already has
// more JOINs; never above 2·fr_own. `openJoins(fr)` returns the JOIN count of the open topic at fr.
export function chooseBucket(frOwn, openJoins = () => 0) {
  const i = BUCKETS.findIndex((b) => b >= frOwn);
  if (i < 0) throw new Error('join: fee rate above the largest bucket');
  const base = BUCKETS[i], next = BUCKETS[i + 1];
  if (next != null && next <= 2 * frOwn && openJoins(next) > openJoins(base)) return next;
  return base;
}

// ─────────────────────────────────────────────────────────────── bytes

const u8 = (n) => Uint8Array.of(n & 0xff);
const u16be = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, false); return b; };
const u32be = (n) => bip352U32be(n);
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u64be = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), false); return b; };
const toBytes = (v) => (v instanceof Uint8Array ? v : hexToBytes(String(v).replace(/^0x/i, '')));
const hex = (b) => bytesToHex(b);
const b2n = (b) => BigInt('0x' + (bytesToHex(b) || '0'));
const n2b = (x) => hexToBytes(x.toString(16).padStart(64, '0'));
const hash256 = (b) => sha256(sha256(b));
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
const bytesEq = (a, b) => a.length === b.length && compareBytes(a, b) === 0;

function compactSize(n) {
  if (n < 0xfd) return u8(n);
  if (n <= 0xffff) { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; }
  const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b;
}
const varslice = (b) => concatBytes(compactSize(b.length), b);

export const outpointBytes = (txid, vout) => bip352OutpointBytes(txid, vout);
export const outpointKey = (o) => `${o.txid}:${o.vout}`;

export function randomScalar() {
  for (;;) {
    const k = b2n(randomBytes(32));
    if (k > 0n && k < N) return k;
  }
}

// ─────────────────────────────────────────────────────────────── BIP-340

export function schnorrSign(msg32, priv) {
  const d0 = typeof priv === 'bigint' ? priv : b2n(priv);
  if (d0 <= 0n || d0 >= N) throw new Error('join: invalid private key');
  const Pb = G.multiply(d0).toRawBytes(true);
  const d = Pb[0] === 0x02 ? d0 : N - d0;
  const px = Pb.slice(1);
  const t = n2b(d).map((x, i) => x ^ taggedHash('BIP0340/aux', randomBytes(32))[i]);
  const k0 = b2n(taggedHash('BIP0340/nonce', t, px, msg32)) % N;
  if (k0 === 0n) throw new Error('join: nonce is zero');
  const Rb = G.multiply(k0).toRawBytes(true);
  const k = Rb[0] === 0x02 ? k0 : N - k0;
  const e = b2n(taggedHash('BIP0340/challenge', Rb.slice(1), px, msg32)) % N;
  return concatBytes(Rb.slice(1), n2b((k + e * d) % N));
}

export function schnorrVerify(sig, msg32, xonly) {
  try {
    sig = toBytes(sig); xonly = toBytes(xonly);
    if (sig.length !== 64 || xonly.length !== 32 || msg32.length !== 32) return false;
    const r = b2n(sig.slice(0, 32)), s = b2n(sig.slice(32));
    if (r >= P || s >= N) return false;
    const Pk = liftX(xonly);
    if (!Pk) return false;
    const e = b2n(taggedHash('BIP0340/challenge', sig.slice(0, 32), xonly, msg32)) % N;
    const R = G.multiply(s).add(Pk.multiply(e).negate());
    if (R.equals(ZERO)) return false;
    const Rb = R.toRawBytes(true);
    return Rb[0] === 0x02 && bytesEq(Rb.slice(1), sig.slice(0, 32));
  } catch { return false; }
}

export function liftX(xonly) {
  const x = typeof xonly === 'bigint' ? xonly : b2n(toBytes(xonly));
  if (x <= 0n || x >= P) return null;
  try { return Point.fromHex('02' + x.toString(16).padStart(64, '0')); } catch { return null; }
}

export const xonlyOfPriv = (priv) => G.multiply(typeof priv === 'bigint' ? priv : b2n(priv)).toRawBytes(true).slice(1);

// ─────────────────────────────────────────────────────────────── ECDSA / DER

function derEncode(compact) {
  const int = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let t = x.slice(i); if (t[0] & 0x80) t = concatBytes(u8(0), t); return t; };
  const r = int(compact.slice(0, 32)), s = int(compact.slice(32));
  return concatBytes(Uint8Array.of(0x30, 4 + r.length + s.length, 0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
}

function derDecode(der) {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) return null;
  const rl = der[3];
  if (rl < 1 || rl > 33 || der[4 + rl] !== 0x02) return null;
  const sl = der[5 + rl];
  if (sl < 1 || sl > 33 || 6 + rl + sl !== der.length) return null;
  let r = der.slice(4, 4 + rl), s = der.slice(6 + rl);
  if (r.length === 33) { if (r[0]) return null; r = r.slice(1); }
  if (s.length === 33) { if (s[0]) return null; s = s.slice(1); }
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length); out.set(s, 64 - s.length);
  return out;
}

const hash160 = (b) => ripemd160(sha256(b));

export const p2trScript = (xonly) => concatBytes(Uint8Array.of(0x51, 0x20), toBytes(xonly));
export const p2wpkhScript = (pub33) => concatBytes(Uint8Array.of(0x00, 0x14), hash160(toBytes(pub33)));

// Input type of a prevout script: 'p2tr', 'p2wpkh' or null (refused, §2.2).
export function scriptType(spk) {
  spk = toBytes(spk);
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) return 'p2tr';
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) return 'p2wpkh';
  return null;
}

// ─────────────────────────────────────────────────────────────── transactions

// tx: { version, locktime, inputs: [{ txid (display hex), vout, sequence, witness: [Uint8Array] }],
//       outputs: [{ value, script: Uint8Array }] }
export function serializeTx(tx, withWitness = true) {
  const wit = withWitness && tx.inputs.some((i) => i.witness && i.witness.length);
  const parts = [u32le(tx.version)];
  if (wit) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) parts.push(hexToBytes(i.txid).reverse(), u32le(i.vout), u8(0), u32le(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64le(o.value), varslice(o.script));
  if (wit) for (const i of tx.inputs) { const w = i.witness || []; parts.push(compactSize(w.length), ...w.map(varslice)); }
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}

export const txidOf = (tx) => hex(hash256(serializeTx(tx, false)).reverse());

export function txWeight(tx) {
  const base = serializeTx(tx, false).length, total = serializeTx(tx, true).length;
  return base * 3 + total;
}
export const txVsize = (tx) => Math.ceil(txWeight(tx) / 4);

// BIP-341 key-path sighash, SIGHASH_DEFAULT. prevouts: [{ value, script }] for every input.
export function taprootSighash(tx, idx, prevouts) {
  const cat = (xs) => sha256(concatBytes(...xs));
  const msg = concatBytes(
    u8(0), u8(0), u32le(tx.version), u32le(tx.locktime),
    cat(tx.inputs.map((i) => concatBytes(hexToBytes(i.txid).reverse(), u32le(i.vout)))),
    cat(prevouts.map((p) => u64le(p.value))),
    cat(prevouts.map((p) => varslice(p.script))),
    cat(tx.inputs.map((i) => u32le(i.sequence))),
    cat(tx.outputs.map((o) => concatBytes(u64le(o.value), varslice(o.script)))),
    u8(0), u32le(idx),
  );
  return taggedHash('TapSighash', msg);
}

// BIP-143 sighash of a P2WPKH input, SIGHASH_ALL.
export function p2wpkhSighash(tx, idx, pub33, value) {
  const inp = tx.inputs[idx];
  const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash160(pub33), Uint8Array.of(0x88, 0xac));
  return hash256(concatBytes(
    u32le(tx.version),
    hash256(concatBytes(...tx.inputs.map((i) => concatBytes(hexToBytes(i.txid).reverse(), u32le(i.vout))))),
    hash256(concatBytes(...tx.inputs.map((i) => u32le(i.sequence)))),
    hexToBytes(inp.txid).reverse(), u32le(inp.vout), varslice(scriptCode), u64le(value), u32le(inp.sequence),
    hash256(concatBytes(...tx.outputs.map((o) => concatBytes(u64le(o.value), varslice(o.script))))),
    u32le(tx.locktime), u32le(1),
  ));
}

// Witness for input idx spending coin { type, priv, pub33 } with every input's prevout.
export function signInput(tx, idx, prevouts, coin) {
  if (coin.type === 'p2tr') return [schnorrSign(taprootSighash(tx, idx, prevouts), coin.priv)];
  if (coin.type === 'p2wpkh') {
    const pub = toBytes(coin.pub33);
    const sig = secp.sign(p2wpkhSighash(tx, idx, pub, prevouts[idx].value), toBytes(coin.priv), { lowS: true });
    return [concatBytes(derEncode(sig.toCompactRawBytes()), u8(1)), pub];
  }
  throw new Error('join: unknown coin type');
}

// True when `witness` validly spends prevouts[idx] in tx (P2TR key path SIGHASH_DEFAULT or P2WPKH SIGHASH_ALL).
export function verifyInputWitness(tx, idx, prevouts, witness) {
  const spk = prevouts[idx].script, type = scriptType(spk);
  if (!Array.isArray(witness)) return false;
  if (type === 'p2tr') {
    return witness.length === 1 && witness[0].length === 64 && schnorrVerify(witness[0], taprootSighash(tx, idx, prevouts), spk.slice(2));
  }
  if (type === 'p2wpkh') {
    if (witness.length !== 2 || witness[1].length !== 33) return false;
    const [sig, pub] = witness;
    if (!bytesEq(hash160(pub), spk.slice(2)) || sig[sig.length - 1] !== 0x01) return false;
    const compact = derDecode(sig.slice(0, -1));
    if (!compact) return false;
    try { return secp.verify(compact, p2wpkhSighash(tx, idx, pub, prevouts[idx].value), pub, { lowS: true }); } catch { return false; }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────── BIP-352 (§3.1)

// Public key an input contributes (§3.1): P2TR 0x02 ‖ x-only output key, P2WPKH its compressed key.
export function inputPub(m) {
  return m.type === 'p2tr' ? concatBytes(u8(0x02), toBytes(m.spk).slice(2)) : toBytes(m.pub33);
}

// Receiver-side forward derivation of a participant's own output P_k over the input set, with its own scan
// key alone: ecdh = b_scan · (input_hash · A_sum). Returns { xOnly, tweak (t_k, 32 bytes) }; the output's
// spending key is b_spend + t_k.
export function ownOutputKey({ inputs, scanPriv, spendPub, k = 0 }) {
  return ownOutputKeyFromPubs({ pubs: inputs.map(inputPub), outpoints: inputs.map((m) => outpointBytes(m.txid, m.vout)), scanPriv, spendPub, k });
}

// The same over explicit BIP-352 input keys (33 bytes, null for a non-contributing input) and every outpoint.
export function ownOutputKeyFromPubs({ pubs, outpoints: ops, scanPriv, spendPub, k = 0 }) {
  const tweakPt = bip352PublicTweakPoint(pubs, ops);
  if (!tweakPt) throw new Error('join: A_sum is the identity or input_hash is not a scalar; refusing the run');
  const ecdh = tweakPt.multiply(b2n(toBytes(scanPriv))).toRawBytes(true);
  const tweak = taggedHash('BIP0352/SharedSecret', ecdh, u32be(k));
  const t = b2n(tweak);
  if (t === 0n || t >= N) throw new Error('join: shared-secret tweak is not a scalar');
  const Pk = Point.fromHex(hex(toBytes(spendPub))).add(G.multiply(t));
  if (Pk.equals(ZERO)) throw new Error('join: output point is the identity');
  return { xOnly: Pk.toRawBytes(true).slice(1), tweak };
}

// Sender side of BIP-352 for the wallet's own transactions (entry and change outputs): every input's key
// is the sender's. inputs: [{ txid, vout, priv, type }]; recipients: [{ scanPub, spendPub }] in output order.
export function bip352SendOutputs({ inputs, recipients, allOutpoints = null }) {
  let a = 0n;
  for (const i of inputs) a = (a + evenYPriv(i.priv, i.type)) % N;
  if (a === 0n) throw new Error('join: input key sum is zero');
  const ops = allOutpoints || inputs.map((i) => outpointBytes(i.txid, i.vout));
  const ih = b2n(taggedHash('BIP0352/Inputs', bip352SmallestOutpoint(ops), G.multiply(a).toRawBytes(true)));
  if (ih === 0n || ih >= N) throw new Error('join: input_hash is not a scalar');
  const counters = new Map();
  return recipients.map((r) => {
    const key = hex(toBytes(r.scanPub));
    const k = counters.get(key) ?? 0; counters.set(key, k + 1);
    const ecdh = Point.fromHex(key).multiply((a * ih) % N).toRawBytes(true);
    const tweak = taggedHash('BIP0352/SharedSecret', ecdh, u32be(k));
    const Pk = Point.fromHex(hex(toBytes(r.spendPub))).add(G.multiply(b2n(tweak)));
    return { xOnly: Pk.toRawBytes(true).slice(1), tweak, k };
  });
}

// A P2TR key counts with the secret of its even-y point (BIP-352 and BIP-340).
function evenYPriv(priv, type) {
  const d = typeof priv === 'bigint' ? priv : b2n(toBytes(priv));
  if (type !== 'p2tr') return d;
  return G.multiply(d).toRawBytes(true)[0] === 0x03 ? N - d : d;
}

export function spendingKey(spendPriv, tweak) {
  const sk = (b2n(toBytes(spendPriv)) + b2n(toBytes(tweak))) % N;
  if (sk === 0n) throw new Error('join: spending key is zero');
  return n2b(sk);
}

// BIP-352 label tweak for label m (the change label is m = 0).
export function labelTweak(scanPriv, m) {
  return b2n(taggedHash('BIP0352/Label', toBytes(scanPriv), u32be(m))) % N;
}

// ─────────────────────────────────────────────────────────────── join silent payments (§3.2)

// H_P = SHA-256 of the run's outpoints in transaction (sorted) order.
export function inputSetHash(inputs) {
  return sha256(concatBytes(...sortInputs(inputs).map((m) => outpointBytes(m.txid, m.vout))));
}

function joinSpTweak(ecdh, k) {
  const t = b2n(taggedHash('TacitJoinSP/SharedSecret', ecdh, u32be(k)));
  if (t === 0n || t >= N) throw new Error('join: join-SP tweak is not a scalar');
  return t;
}

// Output key paying (scanPub, spendPub) from the sender's own input alone: a = its key (even-y for P2TR).
export function joinSpSend({ inputs, own, recipient, k = 0 }) {
  const a = evenYPriv(own.priv, own.type);
  if (a === 0n) throw new Error('join: input key is zero');
  const A = G.multiply(a).toRawBytes(true);
  const ih = b2n(taggedHash('TacitJoinSP/Inputs', inputSetHash(inputs), outpointBytes(own.txid, own.vout), A));
  if (ih === 0n || ih >= N) throw new Error('join: join-SP input_hash is not a scalar');
  const ecdh = Point.fromHex(hex(toBytes(recipient.scanPub))).multiply((a * ih) % N).toRawBytes(true);
  const t = joinSpTweak(ecdh, k);
  // A labeled address already carries B_spend + label·G as its spend key.
  const Pk = Point.fromHex(hex(toBytes(recipient.spendPub))).add(G.multiply(t));
  if (Pk.equals(ZERO)) throw new Error('join: output point is the identity');
  return { xOnly: Pk.toRawBytes(true).slice(1), tweak: n2b(t) };
}

// Recipient scan of one join transaction, per input: ecdh_i = (b_scan · input_hash_i) · A_i.
// inputs: [{ txid, vout, pub (33, the BIP-352 key of the input) }] in transaction order;
// outputs: [{ script }]. Returns [{ vout, inputIndex, k, tweak, label }]; spending key = b_spend + tweak.
export function joinSpScan({ inputs, outputs, scanPriv, spendPub, labels = [] }) {
  const b = b2n(toBytes(scanPriv));
  const H_P = sha256(concatBytes(...inputs.map((i) => outpointBytes(i.txid, i.vout))));
  const B = Point.fromHex(hex(toBytes(spendPub)));
  const labelPts = labels.map((m) => { const t = labelTweak(scanPriv, m); return { m, t, L: G.multiply(t) }; });
  const tr = [];
  outputs.forEach((o, v) => { const s = toBytes(o.script); if (scriptType(s) === 'p2tr') tr.push({ v, x: s.slice(2) }); });
  const found = [];
  const taken = new Set();
  inputs.forEach((inp, idx) => {
    if (!inp.pub) return;
    const A = Point.fromHex(hex(toBytes(inp.pub)));
    const ih = b2n(taggedHash('TacitJoinSP/Inputs', H_P, outpointBytes(inp.txid, inp.vout), toBytes(inp.pub)));
    if (ih === 0n || ih >= N || A.equals(ZERO)) return;
    const ecdh = A.multiply((b * ih) % N).toRawBytes(true);
    for (let k = 0; k < 2323; k++) {
      const t = joinSpTweak(ecdh, k);
      const Pk = B.add(G.multiply(t));
      const cands = [{ x: Pk.toRawBytes(true).slice(1), t, label: null }];
      for (const lp of labelPts) cands.push({ x: Pk.add(lp.L).toRawBytes(true).slice(1), t: (t + lp.t) % N, label: lp.m });
      const hit = tr.find((o) => !taken.has(o.v) && cands.some((c) => bytesEq(c.x, o.x)));
      if (!hit) break;
      const c = cands.find((c) => bytesEq(c.x, hit.x));
      taken.add(hit.v);
      found.push({ vout: hit.v, inputIndex: idx, k, tweak: n2b(c.t), label: c.label });
    }
  });
  return found;
}

// Esplora-shaped tx → the inputs joinSpScan and the BIP-352 scanner need, or null when not join-shaped.
export function joinSpScanEsploraTx(tx, keys, opts = {}) {
  if (!joinShape(tx, opts)) return [];
  const inputs = tx.vin.map((v) => ({
    txid: v.txid, vout: v.vout,
    pub: bip352InputPubkey({
      prevoutScript: hexToBytes(v.prevout.scriptpubkey),
      scriptSig: v.scriptsig ? hexToBytes(v.scriptsig) : null,
      witness: (v.witness || []).map((w) => hexToBytes(w)),
    }),
  }));
  const outputs = tx.vout.map((o) => ({ script: hexToBytes(o.scriptpubkey) }));
  return joinSpScan({ inputs, outputs, ...keys });
}

// ─────────────────────────────────────────────────────────────── join shape (§2.2)

const ALLOWANCES = [...new Set(BUCKETS.map((fr) => allowance(fr)))];
const ALL_TIERS = [...new Set(Object.values(NETWORKS).flatMap((n) => [...n.tiers, ...n.laterTiers]))];

// Esplora tx → { d, value, allowance } when join-shaped, else null.
export function joinShape(tx, { tiers = ALL_TIERS } = {}) {
  if (!tx || tx.version !== 2 || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) return null;
  if (tx.vout.length < 3 || tx.vout.length !== tx.vin.length) return null;
  for (const v of tx.vin) {
    const spk = v.prevout?.scriptpubkey || '';
    const w = v.witness || [];
    if (spk.length === 68 && spk.startsWith('5120')) { if (!(w.length === 1 && (w[0].length === 128 || w[0].length === 130))) return null; }
    else if (spk.length === 44 && spk.startsWith('0014')) { if (!(w.length === 2 && w[1].length === 66)) return null; }
    else return null;
  }
  const value = Number(tx.vout[0].value);
  for (const o of tx.vout) if (!(o.scriptpubkey?.length === 68 && o.scriptpubkey.startsWith('5120')) || Number(o.value) !== value) return null;
  for (const d of tiers) if (ALLOWANCES.includes(value - d)) return { d, value, allowance: value - d };
  return null;
}

// ─────────────────────────────────────────────────────────────── topics and messages (§4.3, §6)

export const STEP = { KE: 1, CM: 2, DC: 3, CONF: 4, SIG: 5, REVEAL: 6 };
export const STEP_NAME = Object.fromEntries(Object.entries(STEP).map(([k, v]) => [v, k]));

// topic = H_tag("TacitJoin/topic", network ‖ d(8) ‖ fr(2) ‖ h_ref(4) ‖ K_board(32)); network is its ASCII
// name behind a length byte, the integers big-endian.
export function topicId({ network, d, fr, hRef, boardKey }) {
  const net = enc.encode(network);
  return hex(taggedHash('TacitJoin/topic', u8(net.length), net, u64be(d), u16be(fr), u32be(hRef), toBytes(boardKey)));
}

const joinDigest = (m) => taggedHash('TacitJoin/own', toBytes(m.topic), outpointBytes(m.txid, m.vout), toBytes(m.spk), toBytes(m.session));

// JOIN = (topic, outpoint, prevout_value, prevout_spk, pubkey33 if P2WPKH, S_i, own_sig), plus the topic's
// parameters so a board can check the topic is its own.
export function makeJoin({ network, d, fr, hRef, boardKey, coin, sessionPub }) {
  const topic = topicId({ network, d, fr, hRef, boardKey });
  const type = scriptType(coin.spk);
  if (!type) throw new Error('join: coin type is not allowed');
  const m = {
    t: 'JOIN', topic, network, d, fr, hRef,
    txid: coin.txid, vout: coin.vout, value: coin.value, spk: hex(toBytes(coin.spk)),
    ...(type === 'p2wpkh' ? { pub: hex(toBytes(coin.pub33)) } : {}),
    session: hex(toBytes(sessionPub)),
  };
  m.sig = hex(schnorrSign(joinDigest(m), coin.priv));
  return m;
}

// Signature and shape check of a JOIN; returns the verifying x-only key or null. The topic's parameters are
// checked against the board key by whoever holds it (the board on POST, a client by comparing topics).
export function verifyJoin(m) {
  try {
    if (!m || m.t !== 'JOIN' || !/^[0-9a-f]{64}$/.test(m.txid) || !Number.isInteger(m.vout) || m.vout < 0) return null;
    if (!Number.isSafeInteger(m.value) || m.value <= 0 || !/^[0-9a-f]{64}$/.test(m.session)) return null;
    const spk = hexToBytes(m.spk), type = scriptType(spk);
    let key;
    if (type === 'p2tr') { if (m.pub != null) return null; key = spk.slice(2); }
    else if (type === 'p2wpkh') {
      const pub = hexToBytes(m.pub || '');
      if (pub.length !== 33 || !bytesEq(hash160(pub), spk.slice(2))) return null;
      Point.fromHex(m.pub);
      key = pub.slice(1);
    } else return null;
    if (!/^[0-9a-f]{64}$/.test(m.topic)) return null;
    return schnorrVerify(m.sig, joinDigest(m), key) ? key : null;
  } catch { return null; }
}

export const joinHash = (m) => sha256(concatBytes(toBytes(m.topic), outpointBytes(m.txid, m.vout), u64le(m.value), toBytes(m.spk), m.pub ? toBytes(m.pub) : new Uint8Array(0), toBytes(m.session), toBytes(m.sig)));

const msgDigest = (m) => taggedHash('TacitJoin/msg', toBytes(m.topic), u32be(m.r), u8(m.step), sha256(toBytes(m.body)), toBytes(m.view));

// A run message (topic, r, step, body, view, sig), signed under the session key.
export function makeMsg({ topic, r, step, body, view, sessionPriv }) {
  const m = { t: 'MSG', topic, r, step, session: hex(xonlyOfPriv(sessionPriv)), body: hex(body), view: hex(view) };
  m.sig = hex(schnorrSign(msgDigest(m), sessionPriv));
  return m;
}

export const MAX_BODY = { [STEP.KE]: 65, [STEP.CM]: 32, [STEP.CONF]: 1, [STEP.SIG]: 256, [STEP.REVEAL]: 32 };

export function verifyMsg(m, { kMax = 100 } = {}) {
  try {
    if (!m || m.t !== 'MSG' || !Number.isInteger(m.r) || m.r < 1 || m.r > 64 || !STEP_NAME[m.step]) return false;
    if (!/^[0-9a-f]{64}$/.test(m.session) || !/^[0-9a-f]{64}$/.test(m.view) || !/^([0-9a-f]{2})*$/.test(m.body)) return false;
    const len = m.body.length / 2;
    if (m.step === STEP.DC ? (len === 0 || len % 32 || len > 32 * kMax) : m.step === STEP.SIG ? len > MAX_BODY[STEP.SIG] : len !== MAX_BODY[m.step]) return false;
    return schnorrVerify(m.sig, msgDigest(m), m.session);
  } catch { return false; }
}

export const msgHash = (m) => sha256(concatBytes(toBytes(m.topic), u32be(m.r), u8(m.step), toBytes(m.session), sha256(toBytes(m.body)), toBytes(m.view), toBytes(m.sig)));

// view = SHA-256 of the sorted (S_l ‖ SHA-256(msg_l)).
export function viewOf(pairs) {
  const items = pairs.map(([s, h]) => concatBytes(toBytes(s), h)).sort(compareBytes);
  return sha256(concatBytes(...items));
}

export const closeDigest = (topic, lastSeq) => taggedHash('TacitJoin/close', toBytes(topic), u64be(lastSeq));
export function makeClose({ topic, lastSeq, boardPriv }) {
  return { t: 'CLOSE', topic, lastSeq, sig: hex(schnorrSign(closeDigest(topic, lastSeq), boardPriv)) };
}
export function verifyClose(m, boardKey) {
  return !!m && m.t === 'CLOSE' && Number.isSafeInteger(m.lastSeq) && schnorrVerify(m.sig, closeDigest(m.topic, m.lastSeq), boardKey);
}

// EVIDENCE(outpoint, kind, bundle), posted under a session key of the topic.
const evidenceDigest = (m) => taggedHash('TacitJoin/evidence', toBytes(m.topic), outpointBytes(m.txid, m.vout), enc.encode(m.kind), sha256(enc.encode(JSON.stringify(m.bundle))));
export function makeEvidence({ topic, txid, vout, kind, bundle, sessionPriv }) {
  const m = { t: 'EVIDENCE', topic, txid, vout, kind, bundle, session: hex(xonlyOfPriv(sessionPriv)) };
  m.sig = hex(schnorrSign(evidenceDigest(m), sessionPriv));
  return m;
}
export function verifyEvidenceSig(m) {
  try { return m?.t === 'EVIDENCE' && schnorrVerify(m.sig, evidenceDigest(m), m.session); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────── field and power sums (§4.1)

const fmod = (a) => { const r = a % P; return r < 0n ? r + P : r; };
function finv(a) {
  let [r0, r1, s0, s1] = [fmod(a), P, 1n, 0n];
  if (r0 === 0n) throw new Error('join: inverse of zero');
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return fmod(s0);
}
function fpow(a, e) { let r = 1n; a = fmod(a); while (e > 0n) { if (e & 1n) r = (r * a) % P; a = (a * a) % P; e >>= 1n; } return r; }

export function powerVector(x, n) {
  const v = new Array(n); let acc = 1n;
  for (let j = 0; j < n; j++) { acc = (acc * x) % P; v[j] = acc; }
  return v;
}

// Polynomials: BigInt coefficient arrays, lowest degree first, no trailing zeros.
const trim = (a) => { let n = a.length; while (n > 0 && a[n - 1] === 0n) n--; return a.slice(0, n); };
const deg = (a) => a.length - 1;
function pmod(a, f) {
  const r = a.slice(), df = deg(f), inv = finv(f[df]);
  for (let i = r.length - 1; i >= df; i--) {
    const c = (r[i] * inv) % P;
    if (c === 0n) continue;
    for (let j = 0; j <= df; j++) r[i - df + j] = fmod(r[i - df + j] - c * f[j]);
  }
  return trim(r.slice(0, df));
}
function pmul(a, b) {
  if (!a.length || !b.length) return [];
  const r = new Array(a.length + b.length - 1).fill(0n);
  for (let i = 0; i < a.length; i++) { if (a[i] === 0n) continue; for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j]; }
  return trim(r.map((x) => x % P));
}
function ppowmod(base, e, f) {
  let r = [1n], b = pmod(base, f);
  while (e > 0n) { if (e & 1n) r = pmod(pmul(r, b), f); b = pmod(pmul(b, b), f); e >>= 1n; }
  return r;
}
function monic(a) { const inv = finv(a[deg(a)]); return a.map((c) => (c * inv) % P); }
function pgcd(a, b) {
  a = trim(a); b = trim(b);
  while (b.length) { const r = pmod(a, b); a = b; b = r; }
  return a.length ? monic(a) : a;
}
function pdiv(a, f) {
  const r = a.slice(), df = deg(f), q = new Array(Math.max(0, a.length - df)).fill(0n), inv = finv(f[df]);
  for (let i = r.length - 1; i >= df; i--) {
    const c = (r[i] * inv) % P; q[i - df] = c;
    for (let j = 0; j <= df; j++) r[i - df + j] = fmod(r[i - df + j] - c * f[j]);
  }
  return trim(q);
}
function roots(f) {
  if (deg(f) <= 0) return [];
  if (deg(f) === 1) return [fmod(-f[0] * finv(f[1]))];
  const half = (P - 1n) / 2n;
  for (;;) {
    const delta = b2n(randomBytes(32)) % P;
    const h = ppowmod([delta, 1n], half, f);
    const hm = h.length ? h.slice() : [0n];
    hm[0] = fmod(hm[0] - 1n);
    const g = pgcd(f, trim(hm));
    if (deg(g) > 0 && deg(g) < deg(f)) return [...roots(g), ...roots(pdiv(f, g))];
  }
}

// Power sums S_1..S_n → the n messages, or null when they are not n distinct elements of F_p.
export function decodePowerSums(S) {
  const n = S.length;
  const e = [1n];
  for (let j = 1; j <= n; j++) {
    let acc = 0n;
    for (let m = 1; m <= j; m++) acc += (m % 2 ? 1n : -1n) * e[j - m] * S[m - 1];
    e.push((fmod(acc) * finv(BigInt(j))) % P);
  }
  const f = new Array(n + 1);
  for (let j = 0; j <= n; j++) f[n - j] = j % 2 ? fmod(-e[j]) : e[j];
  if (n >= 2) {
    const xp = ppowmod([0n, 1n], P, f);
    if (!(xp.length === 2 && xp[0] === 0n && xp[1] === 1n)) return null;
  }
  const rs = roots(trim(f));
  return rs.length === n ? rs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : null;
}

// ─────────────────────────────────────────────────────────────── DC-net (§4.2)

export function pairKey(topic, r, e, E) {
  return taggedHash('TacitJoin/dh', toBytes(topic), u32be(r), Point.fromHex(hex(toBytes(E))).multiply(e).toRawBytes(true));
}

export function pads(k, n) {
  const out = new Array(n);
  for (let j = 1; j <= n; j++) {
    const lo = taggedHash('TacitJoin/pad', k, u32be(j), u8(0)), hi = taggedHash('TacitJoin/pad', k, u32be(j), u8(1));
    out[j - 1] = b2n(concatBytes(lo, hi)) % P;
  }
  return out;
}

// DC_i[j] = x_i^j + Σ_{l≠i} σ_il · pad_il[j]; σ_il = +1 when S_i < S_l. peers: [{ session, E }].
export function dcVector({ topic, r, x, e, session, peers, n }) {
  const v = powerVector(x, n);
  for (const p of peers) {
    if (p.session === session) continue;
    const pd = pads(pairKey(topic, r, e, p.E), n);
    const sign = compareBytes(toBytes(session), toBytes(p.session)) < 0 ? 1n : -1n;
    for (let j = 0; j < n; j++) v[j] = fmod(v[j] + sign * pd[j]);
  }
  return v;
}

export const encodeVector = (v) => concatBytes(...v.map(n2b));
export function decodeVector(b) {
  b = toBytes(b);
  const v = [];
  for (let i = 0; i < b.length; i += 32) { const x = b2n(b.slice(i, i + 32)); if (x >= P) return null; v.push(x); }
  return v;
}
export const commitVector = (topic, r, body) => taggedHash('TacitJoin/cm', toBytes(topic), u32be(r), toBytes(body));

// With every ephemeral key revealed: the message each participant's vector carries, or null when the vector
// is not (y, y², …, y^n) for a valid x-only y. members: [{ session, E, e, dc }] (e may be null → unknown).
export function unmaskVectors({ topic, r, members }) {
  const n = members.length;
  return members.map((m) => {
    if (m.e == null || !m.dc) return { session: m.session, y: null };
    const v = m.dc.slice();
    for (const p of members) {
      if (p.session === m.session) continue;
      const pd = pads(pairKey(topic, r, m.e, p.E), n);
      const sign = compareBytes(toBytes(m.session), toBytes(p.session)) < 0 ? 1n : -1n;
      for (let j = 0; j < n; j++) v[j] = fmod(v[j] - sign * pd[j]);
    }
    const y = v[0];
    const ok = liftX(y) && powerVector(y, n).every((z, j) => z === v[j]);
    return { session: m.session, y: ok ? y : null };
  });
}

// Blame verdict after REVEAL (§4.5): excluded sessions, with the reason for each.
export function blameVerdict({ topic, r, members, blamers, inputKeys }) {
  const un = unmaskVectors({ topic, r, members });
  const out = new Map();
  const seen = new Map();
  for (const u of un) {
    if (u.y == null || inputKeys.has(u.y)) { out.set(u.session, 'bad-vector'); continue; }
    if (seen.has(u.y)) { out.set(u.session, 'duplicate'); out.set(seen.get(u.y), 'duplicate'); }
    else seen.set(u.y, u.session);
  }
  if (out.size === 0) for (const s of blamers) out.set(s, 'false-blame');
  return out;
}

// ─────────────────────────────────────────────────────────────── formation (§2.3, §6.2)

export const rankOf = (topic, m) => taggedHash('TacitJoin/rank', toBytes(topic), outpointBytes(m.txid, m.vout));

export function sortInputs(inputs) {
  return inputs.slice().sort((a, b) => compareBytes(outpointBytes(a.txid, a.vout), outpointBytes(b.txid, b.vout)));
}

// Σ_P (v_in − o) ≥ Σ_P f_in and |R| ≤ |Φ|.
export function fundingOk(members, { o, fr, kMin }) {
  let surplus = 0, need = 0, fresh = 0, remix = 0;
  for (const m of members) {
    surplus += m.value - o;
    need += inputFee(fr, m.type, kMin);
    if (m.cls === 'remix') remix++; else fresh++;
  }
  return remix <= fresh && surplus >= need;
}

// Drop remix inputs of highest rank until the funding rule holds.
export function trimToFunding(members, ctx) {
  let P_ = members.slice();
  while (!fundingOk(P_, ctx)) {
    const remixes = P_.filter((m) => m.cls === 'remix');
    if (!remixes.length) return P_;
    const worst = remixes.reduce((a, b) => (compareBytes(a.rank, b.rank) > 0 ? a : b));
    P_ = P_.filter((m) => m !== worst);
  }
  return P_;
}

// Class of a coin at (d, fr): 'fresh', 'remix' or null (§2.3). parentShape: joinShape of the coin's tx.
export function coinClass({ value, type, parentShape }, { d, fr, kMin }) {
  const o = outputValue(d, fr);
  if (type === 'p2tr' && parentShape && parentShape.d === d && value >= o) return 'remix';
  if (value >= o + inputFee(fr, type, kMin)) return 'fresh';
  return null;
}

// P_1 from the JOINs up to CLOSE. joins: verified JOIN messages; chain gives prevouts; evidence: Set of
// outpoint keys with verified evidence on this board; exclusions: the local list (§8).
export async function formRound({ topic, joins, chain, d, fr, kMin, kMax, evidence = new Set(), exclusions = null, tip = null }) {
  const o = outputValue(d, fr);
  const counts = new Map();
  for (const j of joins) counts.set(outpointKey(j), (counts.get(outpointKey(j)) || 0) + 1);
  const sessions = new Map();
  for (const j of joins) sessions.set(j.session, (sessions.get(j.session) || 0) + 1);
  const valid = [];
  for (const j of joins) {
    const key = outpointKey(j);
    if (counts.get(key) !== 1 || sessions.get(j.session) !== 1 || evidence.has(key)) continue;
    if (!verifyJoin(j) || j.topic !== topic) continue;
    let tx, spent;
    try { tx = await chain.getTx(j.txid); spent = await chain.getOutspend(j.txid, j.vout); } catch { continue; }
    const out = tx?.vout?.[j.vout];
    if (!out || Number(out.value) !== j.value || out.scriptpubkey !== j.spk) continue;
    if (!tx.status?.confirmed || spent?.spent) continue;
    if (exclusions && exclusions.excludes(j, tx)) continue;
    const type = scriptType(j.spk);
    const cls = coinClass({ value: j.value, type, parentShape: joinShape(tx) }, { d, fr, kMin });
    if (!cls) continue;
    valid.push({
      txid: j.txid, vout: j.vout, value: j.value, spk: j.spk, pub33: j.pub || null, type, cls,
      session: j.session, join: j, rank: rankOf(topic, j), height: tx.status.block_height,
      confirmations: tip != null ? tip - tx.status.block_height + 1 : null,
    });
  }
  valid.sort((a, b) => compareBytes(a.rank, b.rank));
  const chosen = [], txids = new Set();
  for (const m of valid) {
    if (m.cls !== 'fresh' || chosen.length >= kMax || txids.has(m.txid)) continue;
    chosen.push(m); txids.add(m.txid);
  }
  for (const m of valid) {
    if (m.cls !== 'remix' || chosen.length >= kMax) continue;
    if (fundingOk([...chosen, m], { o, fr, kMin })) chosen.push(m);
  }
  return chosen.length >= kMin ? sortInputs(chosen) : [];
}

// k_eff(P): distinct txids among fresh inputs aged ≥ age_min plus distinct parent txids among aged remix inputs.
export function kEff(members, ageMin = AGE_MIN) {
  const f = new Set(), r = new Set();
  for (const m of members) if ((m.confirmations ?? 0) >= ageMin) (m.cls === 'remix' ? r : f).add(m.txid);
  return f.size + r.size;
}

// ─────────────────────────────────────────────────────────────── the transaction (§2.2, §4.4, §7)

export function buildJoinTx({ inputs, keys, o, hRef }) {
  const ins = sortInputs(inputs);
  const outs = keys.map((x) => ({ value: o, script: p2trScript(typeof x === 'bigint' ? n2b(x) : x) })).sort((a, b) => compareBytes(a.script, b.script));
  return {
    version: 2, locktime: hRef,
    inputs: ins.map((m) => ({ txid: m.txid, vout: m.vout, sequence: SEQUENCE, witness: [] })),
    outputs: outs,
  };
}

export const prevoutsOf = (tx, byKey) => tx.inputs.map((i) => { const m = byKey.get(outpointKey(i)); return { value: m.value, script: toBytes(m.spk) }; });

// Every check of §7. Signs only when `ok`. own: [{ spk (hex or bytes) }] the scripts the client derived;
// coin: its own input; members: P_r as formed.
export function verifyBeforeSigning({ tx, members, own, coin, o, hRef, fr, frOwn, kMin, kMinClient = kMin, ageMin = AGE_MIN }) {
  const checks = [];
  const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail });
  const byKey = new Map(members.map((m) => [outpointKey(m), m]));
  add('1-shape', tx.version === 2 && tx.locktime === hRef && tx.inputs.every((i) => i.sequence === SEQUENCE), 'version 2, nLockTime h_ref, nSequence 0xfffffffd');
  const sorted = sortInputs(members);
  const sameInputs = tx.inputs.length === sorted.length && tx.inputs.every((i, k) => i.txid === sorted[k].txid && i.vout === sorted[k].vout);
  add('2-inputs', sameInputs && fundingOk(members, { o, fr, kMin }), 'inputs are exactly P_r; funding rule and |R| ≤ |Φ|');
  add('3-outputs', tx.outputs.length === members.length && tx.outputs.every((x) => x.value === o && scriptType(x.script) === 'p2tr'), `|P_r| outputs, each P2TR at ${o}`);
  const ownOk = own.every((w) => tx.outputs.filter((x) => bytesEq(x.script, toBytes(w.spk)) && x.value === o).length === 1);
  add('4-own-output', own.length > 0 && ownOk, 'each own output present exactly once at o');
  const ke = kEff(members, ageMin);
  add('5-k-eff', ke >= kMinClient, `k_eff ${ke} ≥ ${kMinClient}`);
  const mine = byKey.get(outpointKey(coin));
  const excess = mine ? mine.value - o - (mine.cls === 'remix' ? 0 : inputFee(fr, mine.type, kMin)) : Infinity;
  add('6-own-excess', !!mine && excess <= excessCeiling(fr, mine.type, kMin) && fr <= 2 * frOwn, `excess ${excess}, fr ${fr} ≤ 2·${frOwn}`);
  const fee = members.reduce((s, m) => s + m.value, 0) - members.length * o;
  const wu = estimatedWeight(members);
  add('7-size-fee', wu <= MAX_WEIGHT && fee >= Math.ceil((wu / 4) * fr), `${wu} WU, fee ${fee}`);
  return { ok: checks.every((c) => c.ok), checks, fee, weight: wu };
}

// Upper bound on the signed weight: 42 WU overhead, 230 per P2TR and 272 per P2WPKH input, 172 per output.
export function estimatedWeight(members) {
  return 42 + members.reduce((s, m) => s + (m.type === 'p2tr' ? 230 : 272), 0) + 172 * members.length;
}

// ─────────────────────────────────────────────────────────────── local exclusion list (§8)

// storage: { get(): string|null, set(string) } (localStorage adapter in the dapp). An offense m excludes
// the outpoint for 24 h × 2^(m−1), at most 30 days, and extends one hop to outputs of a spending tx.
export function makeExclusionList(storage = null, now = () => Date.now()) {
  let state = {};
  try { state = JSON.parse(storage?.get() || '{}') || {}; } catch { state = {}; }
  const save = () => { try { storage?.set(JSON.stringify(state)); } catch {} };
  const DAY = 86_400_000;
  const active = (key) => { const e = state[key]; return !!e && e.until > now(); };
  return {
    add(outpoint) {
      const key = typeof outpoint === 'string' ? outpoint : outpointKey(outpoint);
      const m = (state[key]?.offenses || 0) + 1;
      state[key] = { offenses: m, until: now() + Math.min(DAY * 2 ** (m - 1), 30 * DAY) };
      save();
    },
    has: (o) => active(typeof o === 'string' ? o : outpointKey(o)),
    // tx: the coin's own transaction (Esplora shape); its inputs carry the one-hop rule.
    excludes(o, tx = null) {
      if (active(outpointKey(o))) return true;
      return !!tx?.vin?.some((v) => active(`${v.txid}:${v.vout}`));
    },
    entries: () => ({ ...state }),
  };
}

// ─────────────────────────────────────────────────────────────── evidence (§8)

// Independent check of an EVIDENCE message. Returns true when it proves the offense. `chain` is needed for
// 'double-spend' only.
export async function verifyEvidence(ev, { chain = null } = {}) {
  if (!verifyEvidenceSig(ev)) return false;
  const b = ev.bundle || {};
  const joinOf = (s) => (b.joins || []).find((j) => j.session === s && verifyJoin(j) && j.topic === ev.topic);
  const accusedJoin = (b.joins || []).find((j) => j.txid === ev.txid && j.vout === ev.vout && verifyJoin(j) && j.topic === ev.topic);
  if (!accusedJoin) return false;
  const S = accusedJoin.session;
  const okMsg = (m) => m && m.topic === ev.topic && m.session && joinOf(m.session) && verifyMsg(m);
  if (ev.kind === 'equivocation') {
    const [a, c] = b.messages || [];
    return okMsg(a) && okMsg(c) && a.session === S && c.session === S && a.r === c.r && a.step === c.step && hex(msgHash(a)) !== hex(msgHash(c));
  }
  if (ev.kind === 'commitment') {
    const { cm, dc } = b;
    return okMsg(cm) && okMsg(dc) && cm.session === S && dc.session === S && cm.r === dc.r && cm.step === STEP.CM && dc.step === STEP.DC
      && !bytesEq(toBytes(cm.body), commitVector(ev.topic, dc.r, dc.body));
  }
  if (ev.kind === 'bad-vector' || ev.kind === 'false-blame' || ev.kind === 'duplicate') {
    const { r } = b;
    const joins = (b.joins || []).filter((j) => verifyJoin(j) && j.topic === ev.topic);
    const n = joins.length;
    if (!n || new Set(joins.map((j) => j.session)).size !== n) return false;
    const pick = (step) => {
      const m = new Map();
      for (const x of b[STEP_NAME[step].toLowerCase()] || []) if (okMsg(x) && x.r === r && x.step === step) m.set(x.session, x);
      return m;
    };
    const ke = pick(STEP.KE), dc = pick(STEP.DC), rv = pick(STEP.REVEAL), cf = pick(STEP.CONF);
    const H_P = hex(inputSetHash(joins.map((j) => ({ txid: j.txid, vout: j.vout }))));
    const members = [];
    for (const j of joins) {
      const k = ke.get(j.session), d = dc.get(j.session), v = rv.get(j.session);
      if (!k || !d || hex(toBytes(k.body).slice(33)) !== H_P) return false;
      const E = toBytes(k.body).slice(0, 33);
      let e = null;
      if (v) { e = b2n(toBytes(v.body)); if (e <= 0n || e >= N || !bytesEq(G.multiply(e).toRawBytes(true), E)) e = null; }
      const vec = decodeVector(d.body);
      if (!vec || vec.length !== n) return false;
      members.push({ session: j.session, E, e, dc: vec });
    }
    // Every revealed key must be present except possibly the accused's (a bad vector needs its own key).
    if (members.some((m) => m.e == null)) return false;
    const inputKeys = new Set(joins.map((j) => b2n(inputPub({ type: scriptType(j.spk), spk: j.spk, pub33: j.pub }).slice(1))));
    const blamers = [...cf.values()].filter((m) => m.body === '00').map((m) => m.session);
    const verdict = blameVerdict({ topic: ev.topic, r, members, blamers, inputKeys });
    return verdict.get(S) === ev.kind;
  }
  if (ev.kind === 'double-spend' && chain) {
    const { tx: txHex, witness, conflict } = b;
    if (!txHex || !Array.isArray(witness) || !conflict) return false;
    const tx = parseTx(toBytes(txHex));
    const idx = tx.inputs.findIndex((i) => i.txid === ev.txid && i.vout === ev.vout);
    if (idx < 0 || !Array.isArray(b.prevouts)) return false;
    const prevouts = b.prevouts.map((p) => ({ value: p.value, script: toBytes(p.script) }));
    if (!verifyInputWitness(tx, idx, prevouts, witness.map(toBytes))) return false;
    const spent = await chain.getOutspend(ev.txid, ev.vout);
    return !!spent?.spent && spent.txid === conflict && conflict !== txidOf(tx) && !!spent.status?.confirmed;
  }
  return false;
}

// Minimal parser for the unsigned or signed transactions this module builds.
export function parseTx(raw) {
  let p = 0;
  const rd = (n) => { const s = raw.slice(p, p + n); p += n; return s; };
  const rdU32 = () => new DataView(rd(4).buffer.slice(0)).getUint32(0, true);
  const rdVar = () => { const b = raw[p++]; if (b < 0xfd) return b; if (b === 0xfd) { const v = raw[p] | (raw[p + 1] << 8); p += 2; return v; } const v = new DataView(raw.buffer, raw.byteOffset + p, 4).getUint32(0, true); p += 4; return v; };
  const version = rdU32();
  let wit = false;
  if (raw[p] === 0 && raw[p + 1] === 1) { wit = true; p += 2; }
  const inputs = [];
  for (let i = 0, n = rdVar(); i < n; i++) {
    const txid = hex(rd(32).reverse()); const vout = rdU32(); rd(rdVar()); inputs.push({ txid, vout, sequence: rdU32(), witness: [] });
  }
  const outputs = [];
  for (let i = 0, n = rdVar(); i < n; i++) {
    const value = Number(new DataView(rd(8).buffer.slice(0)).getBigUint64(0, true)); outputs.push({ value, script: rd(rdVar()) });
  }
  if (wit) for (const i of inputs) for (let k = 0, n = rdVar(); k < n; k++) i.witness.push(rd(rdVar()));
  return { version, inputs, outputs, locktime: rdU32() };
}

const encodeWitness = (items) => concatBytes(compactSize(items.length), ...items.map(varslice));
function decodeWitness(b) {
  b = toBytes(b);
  let p = 0; const n = b[p++]; const items = [];
  for (let i = 0; i < n; i++) { const l = b[p++]; items.push(b.slice(p, p + l)); p += l; }
  if (p !== b.length) throw new Error('join: bad witness encoding');
  return items;
}

// ─────────────────────────────────────────────────────────────── transport

// A board over HTTP. Requests carry no cookies, credentials or custom headers (§5.2); JSON bodies go as
// text/plain so browsers send no preflight.
export function makeHttpBoard(url, { fetch: f = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/$/, '');
  const get = async (path) => {
    const r = await f(base + path, { credentials: 'omit' });
    if (!r.ok) throw new Error(`board ${path}: HTTP ${r.status}`);
    return r.json();
  };
  const post = async (path, body) => {
    const r = await f(base + path, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`board ${path}: HTTP ${r.status} ${j.error || ''}`.trim());
    return j;
  };
  return {
    url: base,
    info: () => get('/join/v1/info'),
    post: (topic, msg) => post(`/join/v1/${topic}`, msg),
    poll: (topic, since = 0, waitMs = 20_000) => get(`/join/v1/${topic}?since=${since}&wait=${Math.floor(waitMs / 1000)}`),
    topics: () => get('/join/v1/topics'),
    evidence: () => get('/join/v1/evidence'),
    log: (topic, txid) => post('/join/v1/log', { topic, txid }),
  };
}

// Topics of one tier and bucket across several boards, most JOINs first (§10.1 round preference).
export async function openTopicsAcross(boards, { network, d, fr }) {
  const all = [];
  await Promise.all(boards.map(async (b) => {
    try {
      const { topics = [] } = await b.topics();
      for (const t of topics) if (t.network === network && t.d === d && t.fr === fr && !t.closed) all.push({ board: b, ...t });
    } catch {}
  }));
  return all.sort((a, b) => b.joins - a.joins);
}

// Esplora chain source.
export function makeEsploraChain(bases, { fetch: f = globalThis.fetch, minGapMs = 0 } = {}) {
  const list = (Array.isArray(bases) ? bases : [bases]).map((b) => b.replace(/\/$/, ''));
  let last = 0;
  const call = async (path, init) => {
    let err;
    for (const b of list) {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      try {
        const r = await f(b + path, init);
        const text = await r.text();
        if (!r.ok) { err = new Error(`${path}: HTTP ${r.status} ${text.slice(0, 200)}`); if (r.status === 400) throw err; continue; }
        return text;
      } catch (e) { err = e; if (/HTTP 400/.test(e.message)) throw e; }
    }
    throw err;
  };
  return {
    tipHeight: async () => Number(await call('/blocks/tip/height')),
    getTx: async (txid) => JSON.parse(await call(`/tx/${txid}`)),
    getOutspend: async (txid, vout) => JSON.parse(await call(`/tx/${txid}/outspend/${vout}`)),
    broadcast: async (hexTx) => call('/tx', { method: 'POST', body: hexTx }),
  };
}

// Message inbox over a board topic: a background long-poll loop and waiters.
class Inbox {
  constructor(board, topic, { pollMs = 20_000 } = {}) {
    this.board = board; this.topic = topic; this.pollMs = pollMs;
    this.msgs = []; this.since = 0; this.waiters = new Set(); this.stopped = false; this.close = null;
  }
  start() {
    (async () => {
      let backoff = 250;
      while (!this.stopped) {
        try {
          const r = await this.board.poll(this.topic, this.since, this.pollMs);
          for (const { seq, msg } of r.messages || []) {
            if (seq <= this.since) continue;
            this.since = seq;
            this.msgs.push({ seq, msg });
          }
          // `last` lets a poll that returned nothing new for us still move forward.
          if (Number.isSafeInteger(r.last) && r.last > this.since) this.since = r.last;
          backoff = 250;
          this.notify();
        } catch {
          if (this.stopped) break;
          await new Promise((res) => setTimeout(res, backoff));
          backoff = Math.min(backoff * 2, 5000);
        }
      }
    })();
    return this;
  }
  stop() { this.stopped = true; this.notify(); }
  notify() { for (const w of [...this.waiters]) w(); }
  // Resolves true once pred() holds, false at the deadline.
  until(pred, deadline) {
    return new Promise((resolve) => {
      const check = () => {
        if (pred()) { cleanup(); resolve(true); return; }
        if (Date.now() >= deadline || this.stopped) { cleanup(); resolve(false); }
      };
      const timer = setTimeout(check, Math.max(0, deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }
}

// ─────────────────────────────────────────────────────────────── participant (§4.3–§4.5, §6)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One participant through one round.
//   board, chain                 transports
//   network, d, fr, frOwn        round parameters (fr a bucket, frOwn the client's own estimate)
//   coin                         { txid, vout, value, spk, type, priv, pub33? } a confirmed own coin
//   keys                         { scanPriv, spendPub } own silent-payment identity (output to self)
//   payTo                        optional { scanPub, spendPub } — a join silent payment instead (§3.2)
//   siblings                     outpoints of this client's other participants in the round (sets k)
//   hRef                         reference height (default: chain tip)
//   exclusions                   makeExclusionList(...) (optional)
//   kMinClient, ageMin, tStepMs, jitter, joinDelayMs, closeTimeoutMs, maxRuns
//   adversary                    test hooks { vector(r, v) → v, post(r, step, body) → body | null | body[] }
//   onEvent                      progress callback ({ type, ... })
// Returns { status: 'broadcast' | 'no-round' | 'failed' | 'refused', txid, hex, tx, own: [{ vout, xOnly,
// tweak, spk, value }], runs, excluded, candidates }.
export async function runParticipant(opts) {
  const {
    board, chain, network, d, fr, frOwn = fr, coin, keys = null, payTo = null, siblings = [],
    exclusions = null, adversary = null, onEvent = () => {}, maxRuns = 16,
  } = opts;
  const params = networkParams(network);
  const kMin = opts.kMin ?? params.kMin, kMax = opts.kMax ?? params.kMax;
  const kMinClient = opts.kMinClient ?? kMin, ageMin = opts.ageMin ?? AGE_MIN;
  const tStep = opts.tStepMs ?? T_STEP_MS;
  const jitterMax = opts.jitter ?? 0.3 * tStep;
  const o = outputValue(d, fr);
  const type = scriptType(coin.spk);
  if (!type) throw new Error('join: coin type is not allowed');
  if (!payTo && !keys) throw new Error('join: keys or payTo required');
  checkBucket(fr);
  if (fr > 2 * frOwn) throw new Error('join: bucket above twice the own fee estimate');

  await checkOwnCoin({ coin, chain, d, fr, kMin });

  const info = await board.info();
  const boardKey = info.boardKey;
  const hRef = opts.hRef ?? await chain.tipHeight();
  const topic = topicId({ network, d, fr, hRef, boardKey });
  const sessionPriv = randomScalar();
  const session = hex(xonlyOfPriv(sessionPriv));
  const ev = (type_, x = {}) => { try { onEvent({ type: type_, topic, ...x }); } catch {} };

  const inbox = new Inbox(board, topic, { pollMs: Math.min(20_000, Math.max(1000, tStep)) }).start();
  const jitter = () => (jitterMax > 0 ? sleep(Math.random() * jitterMax) : Promise.resolve());
  try {
    if (opts.joinDelayMs) await sleep(typeof opts.joinDelayMs === 'function' ? opts.joinDelayMs() : opts.joinDelayMs);
    const join = makeJoin({ network, d, fr, hRef, boardKey, coin, sessionPub: hexToBytes(session) });
    await board.post(topic, join);
    ev('joined', { hRef });

    // Gathering: until the board's CLOSE.
    const closeDeadline = Date.now() + (opts.closeTimeoutMs ?? 3 * 3600_000);
    const closeMsg = () => inbox.msgs.find(({ msg }) => msg.t === 'CLOSE' && msg.topic === topic && verifyClose(msg, boardKey));
    if (!(await inbox.until(() => !!closeMsg(), closeDeadline))) return { status: 'no-round', reason: 'no CLOSE' };
    const close = closeMsg().msg;
    const joins = inbox.msgs.filter(({ seq, msg }) => seq <= close.lastSeq && msg.t === 'JOIN').map(({ msg }) => msg);
    const evidenceSet = new Set();
    try {
      const { evidence = [] } = await board.evidence();
      for (const e of [...evidence, ...inbox.msgs.filter(({ msg }) => msg.t === 'EVIDENCE').map(({ msg }) => msg)]) {
        if (await verifyEvidence(e, { chain })) evidenceSet.add(outpointKey(e));
      }
    } catch {}
    const tip = await chain.tipHeight().catch(() => null);
    let members = await formRound({ topic, joins, chain, d, fr, kMin, kMax, evidence: evidenceSet, exclusions, tip });
    ev('formed', { n: members.length });
    if (!members.some((m) => m.session === session)) return { status: 'no-round', reason: members.length ? 'not admitted' : 'below k_min' };

    const excludedAll = [];
    const candidates = [];
    for (let r = 1; r <= maxRuns; r++) {
      if (members.length < kMin || !members.some((m) => m.session === session)) break;
      ev('run', { r, n: members.length });
      const res = await runOnce({
        r, members, topic, session, sessionPriv, coin, keys, payTo, siblings, o, hRef, fr, frOwn, kMin,
        kMinClient, ageMin, tStep, inbox, board, jitter, adversary, ev,
      });
      if (res.refused) return { status: 'refused', checks: res.checks, runs: r, excluded: excludedAll };
      if (res.candidate) candidates.push(res.candidate);
      if (res.ok) {
        let broadcastError = null;
        try { await chain.broadcast(res.hex); } catch (e) { if (!/already|known|in block|duplicate/i.test(e.message)) broadcastError = e.message; }
        try { await board.log(topic, res.txid); } catch {}
        ev('broadcast', { txid: res.txid, error: broadcastError });
        return { status: 'broadcast', txid: res.txid, hex: res.hex, tx: res.tx, own: res.own, runs: r, n: members.length, excluded: excludedAll, candidates, broadcastError, topic, hRef };
      }
      for (const [s, why] of res.exclude) {
        const m = members.find((x) => x.session === s);
        if (m) { excludedAll.push({ outpoint: outpointKey(m), why, run: r }); exclusions?.add(m); }
      }
      for (const e of res.evidence || []) { try { await board.post(topic, e); } catch {} }
      members = trimToFunding(members.filter((m) => !res.exclude.has(m.session)), { o, fr, kMin });
      ev('excluded', { r, excluded: [...res.exclude.entries()] });
    }
    return { status: 'failed', runs: maxRuns, excluded: excludedAll, candidates };
  } finally {
    inbox.stop();
  }
}

// Registration checks on the client's own coin (§2.3): confirmed, unspent, an allowed type, admitted as
// fresh or remix at (d, fr), and its excess within the ceiling (otherwise it belongs in a higher bucket).
export async function checkOwnCoin({ coin, chain, d, fr, kMin }) {
  const type = scriptType(coin.spk);
  const tx = await chain.getTx(coin.txid);
  const out = tx?.vout?.[coin.vout];
  if (!out || Number(out.value) !== coin.value || out.scriptpubkey !== hex(toBytes(coin.spk))) throw new Error('join: coin does not match the chain');
  if (!tx.status?.confirmed) throw new Error('join: coin is unconfirmed');
  if ((await chain.getOutspend(coin.txid, coin.vout))?.spent) throw new Error('join: coin is spent');
  const cls = coinClass({ value: coin.value, type, parentShape: joinShape(tx) }, { d, fr, kMin });
  if (!cls) throw new Error(`join: coin of ${coin.value} sats is below the window for d = ${d} at ${fr} sat/vB`);
  const excess = coin.value - outputValue(d, fr) - (cls === 'remix' ? 0 : inputFee(fr, type, kMin));
  if (excess > excessCeiling(fr, type, kMin)) throw new Error(`join: coin excess ${excess} is above the ceiling; register in a higher bucket`);
  return { cls, excess };
}

async function runOnce(c) {
  const { r, members, topic, session, sessionPriv, inbox, tStep, jitter, adversary } = c;
  const n = members.length;
  const exclude = new Map();
  const evidence = [];
  const sessions = new Set(members.map((m) => m.session));
  const bySession = new Map(members.map((m) => [m.session, m]));

  // Own output key for this run (§3): P_r changes every run, so keys revealed in a failed run never recur.
  const mine = members.find((m) => m.session === session);
  const own = [];
  let x;
  if (c.payTo) {
    const { xOnly } = joinSpSend({ inputs: members, own: c.coin, recipient: c.payTo, k: c.payTo.k ?? 0 });
    x = b2n(xOnly); own.push({ xOnly, spk: p2trScript(xOnly), tweak: null, payTo: true });
  } else {
    const mineAndSiblings = sortInputs(members.filter((m) => m.session === session || c.siblings.some((s) => s.txid === m.txid && s.vout === m.vout)));
    const k = mineAndSiblings.findIndex((m) => m.session === session);
    const { xOnly, tweak } = ownOutputKey({ inputs: members, scanPriv: c.keys.scanPriv, spendPub: c.keys.spendPub, k });
    x = b2n(xOnly); own.push({ xOnly, spk: p2trScript(xOnly), tweak, k });
  }
  const inputKeys = new Set(members.map((m) => b2n(inputPub(m).slice(1))));

  const post = async (step, body, view) => {
    let bodies = [body];
    if (adversary?.post) {
      const t = adversary.post(r, step, body);
      if (t === null) return;
      bodies = Array.isArray(t) ? t : [t];
    }
    await jitter();
    for (const b of bodies) await c.board.post(topic, makeMsg({ topic, r, step, body: b, view, sessionPriv }));
  };

  // Collect one step: the distinct valid messages per member, until all are in or the deadline passes.
  const stepMsgs = (step) => {
    const out = new Map();
    for (const { msg } of inbox.msgs) {
      if (msg.t !== 'MSG' || msg.topic !== topic || msg.r !== r || msg.step !== step || !sessions.has(msg.session)) continue;
      if (!msg._ok) { if (msg._ok === false) continue; msg._ok = verifyMsg(msg, { kMax: 1000 }); if (!msg._ok) continue; }
      const list = out.get(msg.session) || [];
      if (!list.some((m) => m.sig === msg.sig)) list.push(msg);
      out.set(msg.session, list);
    }
    return out;
  };
  // Two different signed messages for one step exclude the signer, whenever they are seen in the run.
  const done = [];
  const flagged = new Set();
  const equivocations = () => {
    for (const st of done) {
      for (const [s, list] of stepMsgs(st)) {
        if (list.length < 2 || flagged.has(s)) continue;
        flagged.add(s);
        exclude.set(s, 'equivocation');
        const j = bySession.get(s);
        evidence.push(makeEvidence({ topic, txid: j.txid, vout: j.vout, kind: 'equivocation', bundle: { joins: [j.join], messages: list.slice(0, 2).map(strip) }, sessionPriv }));
      }
    }
  };
  const collect = async (step, expected = sessions) => {
    const deadline = Date.now() + tStep;
    await inbox.until(() => { const m = stepMsgs(step); return [...expected].every((s) => m.has(s)); }, deadline);
    done.push(step);
    equivocations();
    const got = stepMsgs(step);
    const one = new Map();
    for (const s of expected) {
      const list = got.get(s);
      if (flagged.has(s)) continue;
      if (!list) { exclude.set(s, 'missing'); continue; }
      one.set(s, list[0]);
    }
    return one;
  };
  const viewFrom = (msgs) => viewOf([...msgs.values()].map((m) => [m.session, msgHash(m)]));
  const checkView = (msgs, view) => { for (const [s, m] of msgs) if (m.view !== hex(view)) exclude.set(s, 'view'); };
  const fail = () => ({ ok: false, exclude, evidence });

  // KE
  const H_P = inputSetHash(members);
  const joinView = viewOf(members.map((m) => [m.session, joinHash(m.join)]));
  const e = randomScalar();
  const E = G.multiply(e).toRawBytes(true);
  await post(STEP.KE, concatBytes(E, H_P), joinView);
  const ke = await collect(STEP.KE);
  checkView(ke, joinView);
  const Es = new Map();
  for (const [s, m] of ke) {
    const b = toBytes(m.body);
    if (!bytesEq(b.slice(33), H_P)) { exclude.set(s, 'input-set'); continue; }
    try { const pt = Point.fromHex(hex(b.slice(0, 33))); if (pt.equals(ZERO)) throw 0; Es.set(s, b.slice(0, 33)); } catch { exclude.set(s, 'bad-key'); }
  }
  if (exclude.size) return fail();
  c.ev('step', { r, step: 'KE' });

  // CM
  const keView = viewFrom(ke);
  const peers = members.map((m) => ({ session: m.session, E: Es.get(m.session) }));
  let vec = dcVector({ topic, r, x, e, session, peers, n });
  if (adversary?.vector) vec = adversary.vector(r, vec);
  const dcBody = encodeVector(vec);
  await post(STEP.CM, commitVector(topic, r, dcBody), keView);
  const cm = await collect(STEP.CM);
  checkView(cm, keView);
  if (exclude.size) return fail();
  c.ev('step', { r, step: 'CM' });

  // DC
  const cmView = viewFrom(cm);
  await post(STEP.DC, dcBody, cmView);
  const dc = await collect(STEP.DC);
  checkView(dc, cmView);
  const vectors = new Map();
  for (const [s, m] of dc) {
    const v = decodeVector(m.body);
    if (!bytesEq(toBytes(cm.get(s).body), commitVector(topic, r, m.body))) {
      exclude.set(s, 'commitment');
      const j = bySession.get(s);
      evidence.push(makeEvidence({ topic, txid: j.txid, vout: j.vout, kind: 'commitment', bundle: { joins: [j.join], cm: strip(cm.get(s)), dc: strip(m) }, sessionPriv }));
      continue;
    }
    if (!v || v.length !== n) { exclude.set(s, 'bad-vector'); continue; }
    vectors.set(s, v);
  }
  if (exclude.size) return fail();
  c.ev('step', { r, step: 'DC' });

  // Decode, then OK or BLAME.
  const S = new Array(n).fill(0n);
  for (const v of vectors.values()) for (let j = 0; j < n; j++) S[j] = (S[j] + v[j]) % P;
  const keys = decodePowerSums(S);
  const okDecode = !!keys && keys.every((y) => liftX(y) && !inputKeys.has(y)) && keys.includes(x);
  const dcView = viewFrom(dc);
  await post(STEP.CONF, u8(okDecode ? 1 : 0), dcView);
  const conf = await collect(STEP.CONF);
  checkView(conf, dcView);
  if (exclude.size) return fail();
  const blamers = [...conf.values()].filter((m) => m.body !== '01').map((m) => m.session);
  const confView = viewFrom(conf);
  c.ev('step', { r, step: 'CONF', blamers: blamers.length });

  if (blamers.length) {
    // REVEAL: every ephemeral key, then recompute every vector.
    await post(STEP.REVEAL, n2b(e), confView);
    const rv = await collect(STEP.REVEAL);
    checkView(rv, confView);
    const ms = [];
    for (const m of members) {
      const v = rv.get(m.session);
      let ee = null;
      if (v) { ee = b2n(toBytes(v.body)); if (ee <= 0n || ee >= N || !bytesEq(G.multiply(ee).toRawBytes(true), Es.get(m.session))) { exclude.set(m.session, 'bad-reveal'); ee = null; } }
      ms.push({ session: m.session, E: Es.get(m.session), e: ee, dc: vectors.get(m.session) });
    }
    if (exclude.size) return fail();
    const verdict = blameVerdict({ topic, r, members: ms, blamers, inputKeys });
    const bundle = {
      r, joins: members.map((m) => m.join), ke: [...ke.values()].map(strip), dc: [...dc.values()].map(strip),
      reveal: [...rv.values()].map(strip), conf: [...conf.values()].map(strip),
    };
    for (const [s, why] of verdict) {
      exclude.set(s, why);
      const j = bySession.get(s);
      evidence.push(makeEvidence({ topic, txid: j.txid, vout: j.vout, kind: why, bundle, sessionPriv }));
    }
    c.ev('step', { r, step: 'REVEAL', verdict: [...verdict.entries()] });
    return fail();
  }

  // SIG: build T, check everything, sign only if the own output is present (§7).
  const tx = buildJoinTx({ inputs: members, keys: keys.map(n2b), o: c.o, hRef: c.hRef });
  const check = verifyBeforeSigning({ tx, members, own, coin: c.coin, o: c.o, hRef: c.hRef, fr: c.fr, frOwn: c.frOwn, kMin: c.kMin, kMinClient: c.kMinClient, ageMin: c.ageMin });
  c.ev('verify', { r, checks: check.checks });
  if (!check.ok) return { refused: true, checks: check.checks };
  const byKey = new Map(members.map((m) => [outpointKey(m), m]));
  const prevouts = prevoutsOf(tx, byKey);
  const myIdx = tx.inputs.findIndex((i) => i.txid === c.coin.txid && i.vout === c.coin.vout);
  const wit = signInput(tx, myIdx, prevouts, { ...c.coin, type: mine.type });
  await post(STEP.SIG, encodeWitness(wit), confView);
  const sg = await collect(STEP.SIG);
  checkView(sg, confView);
  const witnesses = new Map();
  for (const [s, m] of sg) {
    const idx = tx.inputs.findIndex((i) => outpointKey(i) === outpointKey(bySession.get(s)));
    let w;
    try { w = decodeWitness(m.body); } catch { exclude.set(s, 'bad-witness'); continue; }
    if (!verifyInputWitness(tx, idx, prevouts, w)) { exclude.set(s, 'bad-witness'); continue; }
    witnesses.set(idx, w);
  }
  const outs = tx.outputs.map((out, vout) => ({ out, vout }));
  const ownOut = own.map((w) => { const hit = outs.find(({ out }) => bytesEq(out.script, w.spk)); return { ...w, vout: hit.vout, value: c.o, spk: hex(w.spk), xOnly: hex(w.xOnly), tweak: w.tweak ? hex(w.tweak) : null }; });
  if (exclude.size) {
    // Our witness for T_r exists; if T_r is completed later it pays every output, so track it (§4.5).
    return { ok: false, exclude, evidence, candidate: { txid: txidOf(tx), own: ownOut } };
  }
  tx.inputs.forEach((i, idx) => { i.witness = witnesses.get(idx); });
  const raw = serializeTx(tx);
  c.ev('step', { r, step: 'SIG' });
  return { ok: true, tx, hex: hex(raw), txid: txidOf(tx), own: ownOut };
}

const strip = (m) => { const { _ok, ...rest } = m; return rest; };

// ─────────────────────────────────────────────────────────────── entry transaction (§2.4)

// Builds and signs the entry transaction: `count` outputs of `value` to the wallet's own silent address
// (BIP-352 over this transaction's inputs, k = 0..count−1) and one change output. coins: [{ txid, vout,
// value, spk, type, priv, pub33? }] all the wallet's. Returns { tx, hex, txid, fee, outputs: [{ vout, xOnly,
// tweak, value }] }.
export function buildEntryTx({ coins, keys, count = 1, value, changeSpk, feeRate }) {
  if (!coins?.length) throw new Error('join: no coins');
  const recips = Array.from({ length: count }, () => ({ scanPub: keys.scanPub, spendPub: keys.spendPub }));
  const derived = bip352SendOutputs({ inputs: coins, recipients: recips });
  const outputs = derived.map((dv) => ({ value, script: p2trScript(dv.xOnly) }));
  const total = coins.reduce((s, c) => s + c.value, 0);
  const inW = coins.reduce((s, c) => s + (c.type === 'p2tr' ? 230 : 272), 0);
  const changeW = changeSpk ? (8 + 1 + toBytes(changeSpk).length) * 4 : 0;
  const vbNoChange = Math.ceil((42 + inW + 172 * count) / 4);
  const vbChange = Math.ceil((42 + inW + 172 * count + changeW) / 4);
  const change = total - count * value - Math.ceil(vbChange * feeRate);
  const dust = changeSpk && scriptType(changeSpk) === 'p2wpkh' ? 294 : 330;
  if (changeSpk && change >= dust) outputs.push({ value: change, script: toBytes(changeSpk) });
  else if (total - count * value < Math.ceil(vbNoChange * feeRate)) throw new Error(`join: coins cover ${total}, need ${count * value + Math.ceil(vbNoChange * feeRate)}`);
  const tx = { version: 2, locktime: 0, inputs: coins.map((c) => ({ txid: c.txid, vout: c.vout, sequence: SEQUENCE, witness: [] })), outputs };
  const prevouts = coins.map((c) => ({ value: c.value, script: toBytes(c.spk) }));
  coins.forEach((c, i) => { tx.inputs[i].witness = signInput(tx, i, prevouts, c); });
  const fee = total - outputs.reduce((s, x) => s + x.value, 0);
  return {
    tx, hex: hex(serializeTx(tx)), txid: txidOf(tx), fee, vsize: txVsize(tx),
    outputs: derived.map((dv, vout) => ({ vout, xOnly: hex(dv.xOnly), tweak: hex(dv.tweak), value, k: dv.k })),
  };
}

// ─────────────────────────────────────────────────────────────── after the round

// Own outputs of a confirmed join, found by scanning with the scan key alone (the forward derivation over
// the transaction's own inputs). tx: Esplora shape. Returns [{ txid, vout, value, tweak, k }].
export function scanJoinForOwn(tx, { scanPriv, spendPub }) {
  if (!joinShape(tx)) return [];
  const inputs = tx.vin.map((v) => ({
    txid: v.txid, vout: v.vout,
    pub: bip352InputPubkey({ prevoutScript: hexToBytes(v.prevout.scriptpubkey), scriptSig: null, witness: (v.witness || []).map(hexToBytes) }),
  }));
  if (inputs.some((i) => !i.pub)) return [];
  const tweakPt = bip352PublicTweakPoint(inputs.map((i) => i.pub), inputs.map((i) => outpointBytes(i.txid, i.vout)));
  if (!tweakPt) return [];
  const ecdh = tweakPt.multiply(b2n(toBytes(scanPriv))).toRawBytes(true);
  const B = Point.fromHex(hex(toBytes(spendPub)));
  const out = [];
  for (let k = 0; k < tx.vout.length; k++) {
    const tweak = taggedHash('BIP0352/SharedSecret', ecdh, u32be(k));
    const x = hex(B.add(G.multiply(b2n(tweak))).toRawBytes(true).slice(1));
    const vout = tx.vout.findIndex((o) => o.scriptpubkey === '5120' + x);
    if (vout < 0) break;
    out.push({ txid: tx.txid, vout, value: Number(tx.vout[vout].value), tweak: hex(tweak), k });
  }
  return out;
}

// A mixed output as a spendable coin: { txid, vout, value, spk, type: 'p2tr', priv, xOnly }. `tweak` is the
// credit's t_k (recordSpCredit's tweakHex); spendPriv the identity's b_spend.
export function mixedCoin({ txid, vout, value, tweak, spendPriv }) {
  const priv = spendingKey(spendPriv, tweak);
  const xOnly = xonlyOfPriv(priv);
  return { txid, vout, value, spk: hex(p2trScript(xOnly)), type: 'p2tr', priv, xOnly: hex(xOnly) };
}

// Funds a buy-and-shield (dapp/btc-pool-zap.js buyAndShield) from one mixed output and nothing else. The
// commit transaction spends the mixed coin by key path; its change, and the carrier's change, pay a fresh
// output of the wallet's own silent address (BIP-352 from the mixed coin, k = 0), so the commit change is
// found by an ordinary silent-payment scan. The envelope's signing key is that same fresh key.
//   makeBtcWallet: dapp/bitcoin-taproot-wallet.js; resolveNote: as buyAndShield's tacit.resolveNote
// Returns { tacit, wallet, change: { xOnly, tweak, spk } } for buyAndShield({ tacit, wallet, ... }). After
// broadcast, record credits for commit vout 1 (when present) and carrier vout 0 with change.tweak.
export function zapFromMixedCoin({ coin, keys, makeBtcWallet, hrp = 'tb', resolveNote, feeRate }) {
  const [derived] = bip352SendOutputs({ inputs: [coin], recipients: [{ scanPub: keys.scanPub, spendPub: keys.spendPub }] });
  const changePriv = spendingKey(keys.spendPriv, derived.tweak);
  const { prims } = makeBtcWallet({ priv: changePriv, hrp });
  const changePub = prims.wallet.pub;
  if (!bytesEq(changePub.slice(1), derived.xOnly)) throw new Error('join: change key mismatch');
  const coinSpk = toBytes(coin.spk);
  const tacit = {
    ...prims,
    resolveNote,
    p2wpkhScript: (pub) => (bytesEq(toBytes(pub), changePub) ? p2trScript(changePub.slice(1)) : prims.p2wpkhScript(pub)),
    signP2wpkhInput: (tx, idx, value) => {
      const prevouts = tx.inputs.map((i) => {
        if (i.txid !== coin.txid || i.vout !== coin.vout) throw new Error('join: the commit may spend the mixed coin only');
        return { value: coin.value, script: coinSpk };
      });
      if (value !== coin.value) throw new Error('join: mixed coin value mismatch');
      return prims.signTaprootKeypathInput(tx, idx, prevouts, toBytes(coin.priv));
    },
  };
  return {
    tacit,
    wallet: { utxos: [{ txid: coin.txid, vout: coin.vout, value: coin.value }], feeRate },
    change: { xOnly: hex(derived.xOnly), tweak: hex(derived.tweak), spk: hex(p2trScript(derived.xOnly)) },
  };
}
