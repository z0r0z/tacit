// A take of an ETH-for-Bitcoin swap that anyone can finish once the provider has claimed the ETH.
//
// In the swap (dapp/adaptor-xswap.js) the provider locks sats first into a Taproot output keyed P_user + T and the user then locks ETH in the pool to T.
// The provider's claim of the ETH publishes t, and the user takes the sats with the key d_user + t (dapp/adaptor-btc-lock.js claimSecret). A user who is
// offline when the claim lands, and stays offline until the provider's refund opens, loses both. This module lets the user sign the take AHEAD, except for
// the one number that needs t, and hand the rest to anyone:
//
//   pre-signature   s' = k + e * c2 * (c * d + tw)          what the user can compute without t
//   completed       s  = s' + e * c2 * c * t                 a BIP-340 signature for the lock output key Q (what makes it whole is the t in the claim)
//
// c = -1 when the internal key P + T has an odd y (the key path then signs with the negated secret), c2 = -1 when Q has an odd y, tw is the BIP-341 tweak
// (one script leaf, the locker's refund). The nonce k is the one of the even-y R = k*G, and e = H_BIP0340/challenge(R_x, Q_x, sighash). The pair (R, s')
// reveals nothing without t (s' G = R + e X', X' being the user's own key's share of Q), so it is safe to publish.
//
// The transaction is committed with SIGHASH_SINGLE | ANYONECANPAY (0x83): the signature fixes this input's outpoint, amount, script and sequence, the
// version and the locktime, and the ONE output at the same index, which is the user's address with the committed fee taken out. Anyone may add inputs
// (to pay a higher fee) and outputs after it, and nobody can change where the sats go. Input 0 is the lock, output 0 is the user's.
//
// Pure: no chain access, no wallet. The same file is the user's side (makePresig), the publisher's cheap check (verifyPresig) and the watcher's
// (completeTake, buildTake).

import { secp, sha256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { G, SECP_N, modN, bigintToBytes32, bytes32ToBigint, verifySchnorr } from './bulletproofs.js';
import { refundLeaf } from './adaptor-btc-lock.js';
import * as adaptor from './adaptor-signature.js';

const te = new TextEncoder();
const Pt = secp.ProjectivePoint;
const hx = bytesToHex;
const strip = (h) => String(h ?? '').replace(/^0x/, '').toLowerCase();
const bx = (h) => (h instanceof Uint8Array ? h : hexToBytes(strip(h)));
const isHex = (h, n) => new RegExp(`^[0-9a-f]{${n}}$`).test(strip(h));
const taggedHash = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concatBytes(t, t, ...msgs)); };

export const HASH_TYPE = 0x83;               // SIGHASH_SINGLE | SIGHASH_ANYONECANPAY
export const TAKE_SEQUENCE = 0xfffffffd;     // as every take: signals replacement
export const MIN_OUT = 330;                  // the committed output is at least this (dust for a P2TR output)
export const MAX_FEE_SHARE = 0.5;            // of the lock, as the take's own cap (policy.takeMaxFeeShare)
const MAX_LIFE_SECS = 8 * 86400;

// ── bytes of a transaction ──
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const u64le = (v) => { let x = BigInt(v); const o = new Uint8Array(8); for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const compact = (n) => (n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? Uint8Array.of(0xfd, n & 0xff, n >> 8) : concatBytes(Uint8Array.of(0xfe), u32le(n)));
const rev = (b) => Uint8Array.from(b).reverse();
const outBytes = (o) => concatBytes(u64le(o.value), compact(o.script.length), o.script);
const inBytes = (i) => concatBytes(rev(bx(i.txid)), u32le(i.vout), compact(0), u32le(i.sequence));

// tx = { version, locktime, inputs: [{ txid (display hex), vout, sequence, witness: [Uint8Array] }], outputs: [{ value, script }] }
export function serializeTx(tx, { witness = true } = {}) {
  const w = witness && tx.inputs.some((i) => i.witness && i.witness.length);
  const parts = [u32le(tx.version), ...(w ? [Uint8Array.of(0, 1)] : []), compact(tx.inputs.length), ...tx.inputs.map(inBytes), compact(tx.outputs.length), ...tx.outputs.map(outBytes)];
  if (w) for (const i of tx.inputs) parts.push(compact((i.witness || []).length), ...(i.witness || []).flatMap((x) => [compact(x.length), x]));
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}
export const txidOf = (tx) => hx(rev(sha256(sha256(serializeTx(tx, { witness: false })))));
export const vsizeOf = (tx) => Math.ceil((serializeTx(tx, { witness: false }).length * 3 + serializeTx(tx).length) / 4);

// ── the lock output, from the terms (as dapp/adaptor-btc-lock.js deriveLock makes it) ──
function lockOf({ claimerPub, T, lockerXonly, csvBlocks }) {
  const P = Pt.fromHex(hx(bx(claimerPub)));
  const Tp = typeof T?.toRawBytes === 'function' ? T : Pt.fromHex(hx(bx(T)));
  const I = P.add(Tp);
  if (I.equals(Pt.ZERO)) throw new Error('take-presig: T cancels the key');
  const ib = I.toRawBytes(true), ix = ib.slice(1);
  const leaf = refundLeaf({ lockerXonly: bx(lockerXonly), csvBlocks });
  const leafHash = taggedHash('TapLeaf', Uint8Array.of(0xc0), compact(leaf.length), leaf);
  const tw = bytes32ToBigint(taggedHash('TapTweak', ix, leafHash));
  if (tw >= SECP_N) throw new Error('take-presig: tap tweak >= N');
  const Q = Pt.fromHex('02' + hx(ix)).add(G.multiply(tw)), qb = Q.toRawBytes(true);
  const Qx = qb.slice(1);
  return { P, T: Tp, internalOddY: ib[0] === 0x03, tw, Qx, qOdd: qb[0] === 0x03, spk: concatBytes(Uint8Array.of(0x51, 0x20), Qx) };
}
// the sign that turns d + t into what the signature carries
const signsOf = (lock) => ({ c: lock.internalOddY ? SECP_N - 1n : 1n, c2: lock.qOdd ? SECP_N - 1n : 1n });

// ── the committed take ──
const skeleton = (p) => ({
  version: 2, locktime: 0,
  inputs: [{ txid: strip(p.lock.txid), vout: Number(p.lock.vout), sequence: TAKE_SEQUENCE, witness: [] }],
  outputs: [{ value: Number(p.lock.value) - Number(p.fee), script: bx(p.dest) }],
});
// BIP-341 key-path sighash with hash type 0x83 for input 0 of a transaction whose output 0 is the committed one
export function sighashOf({ tx, lockValue, lockSpk }) {
  const o = tx.outputs[0], i = tx.inputs[0];
  return taggedHash('TapSighash', concatBytes(
    Uint8Array.of(0x00, HASH_TYPE), u32le(tx.version), u32le(tx.locktime),
    Uint8Array.of(0x00),                                                  // spend type: key path, no annex
    rev(bx(i.txid)), u32le(i.vout), u64le(lockValue), compact(lockSpk.length), lockSpk, u32le(i.sequence),
    sha256(outBytes(o))));                                                // the output at this input's index
}

const challenge = (Rx, Qx, m) => bytes32ToBigint(taggedHash('BIP0340/challenge', Rx, Qx, m)) % SECP_N;
const liftEven = (x) => Pt.fromHex('02' + hx(x));

// The standard output scripts a take may pay (what a wallet's address is)
export function standardSpk(spk) {
  const s = bx(spk), h = hx(s);
  return (s.length === 22 && h.startsWith('0014')) || (s.length === 34 && (h.startsWith('0020') || h.startsWith('5120')))
    || (s.length === 25 && h.startsWith('76a914') && h.endsWith('88ac')) || (s.length === 23 && h.startsWith('a914') && h.endsWith('87'));
}

// ── the user's side ──
// The pre-signature of the take of `lockOut` ({ txid, vout, value }) to `dest` (a script) with `fee` sats committed. `dUser` is the key whose public key is `claimerPub`;
// `sTilde` (the user's own pre-signature of the pool claim, hex) and `lockNu` are carried so that a watcher can find the claim and read t out of it. The nonce is
// derived from the key and what is signed, so the same inputs make the same pre-signature and two different takes never share one.
export function makePresig({ dUser, claimerPub, T, lockerXonly, csvBlocks, lockOut, dest, fee, sTilde, lockNu, deadline, expiresAt = null }) {
  const d = typeof dUser === 'bigint' ? dUser : bytes32ToBigint(bx(dUser));
  if (!(d > 0n && d < SECP_N) || hx(G.multiply(d).toRawBytes(true)) !== hx(bx(claimerPub))) throw new Error('take-presig: the key is not the claimer key');
  const Tb = typeof T?.toRawBytes === 'function' ? T.toRawBytes(true) : bx(T);
  const lock = lockOf({ claimerPub, T: Pt.fromHex(hx(Tb)), lockerXonly, csvBlocks });
  const p = {
    v: 1, lock: { txid: strip(lockOut.txid), vout: Number(lockOut.vout), value: Number(lockOut.value) },
    claimerPub: hx(bx(claimerPub)), T: hx(Tb), lockerXonly: hx(bx(lockerXonly)), csv: Number(csvBlocks),
    dest: hx(bx(dest)), fee: Number(fee), hashType: HASH_TYPE, sequence: TAKE_SEQUENCE,
    sTilde: hx(bx(sTilde)), lockNu: strip(lockNu), deadline: Number(deadline), expiresAt: expiresAt == null ? Number(deadline) + 3 * 86400 : Number(expiresAt),
  };
  const bad = shapeReasons(p);
  if (bad.length) throw new Error('take-presig: ' + bad[0]);
  const sh = sighashOf({ tx: skeleton(p), lockValue: p.lock.value, lockSpk: lock.spk });
  const k0 = bytes32ToBigint(taggedHash('tacit-take-presig-nonce-v1', bigintToBytes32(d), sh, lock.Qx, Tb)) % SECP_N;
  if (k0 === 0n) throw new Error('take-presig: nonce was zero');
  const R0 = G.multiply(k0).toRawBytes(true);
  const k = R0[0] === 0x02 ? k0 : SECP_N - k0, Rx = R0.slice(1);
  const e = challenge(Rx, lock.Qx, sh);
  const { c, c2 } = signsOf(lock);
  const sPre = modN(k + e * modN(c2 * modN(c * d + lock.tw)));
  return { ...p, R: hx(Rx), sPre: hx(bigintToBytes32(sPre)) };
}

function shapeReasons(p) {
  const r = [];
  if (!p || typeof p !== 'object' || p.v !== 1) return ['unknown version'];
  const l = p.lock || {};
  if (!isHex(l.txid, 64) || !Number.isInteger(l.vout) || l.vout < 0 || !Number.isSafeInteger(l.value) || l.value <= 0) r.push('the lock outpoint is malformed');
  if (!/^0[23][0-9a-f]{64}$/.test(strip(p.claimerPub)) || !/^0[23][0-9a-f]{64}$/.test(strip(p.T))) r.push('a key is malformed');
  if (!isHex(p.lockerXonly, 64) || !isHex(p.sTilde, 64) || !isHex(p.lockNu, 64)) r.push('a field is not 32 bytes of hex');
  if (p.sPre !== undefined && !isHex(p.sPre, 64)) r.push('sPre is not 32 bytes of hex');
  if (p.R !== undefined && !isHex(p.R, 64)) r.push('R is not 32 bytes of hex');
  if (!Number.isInteger(p.csv) || p.csv < 1 || p.csv > 0xffff) r.push('the timelock is out of range');
  if (p.hashType !== HASH_TYPE || p.sequence !== TAKE_SEQUENCE) r.push('the hash type or the sequence is not the take\'s');
  if (!Number.isSafeInteger(p.fee) || p.fee < 0 || (l.value > 0 && p.fee > Math.floor(l.value * MAX_FEE_SHARE))) r.push('the committed fee is out of range');
  if (!Number.isSafeInteger(l.value - p.fee) || l.value - p.fee < MIN_OUT) r.push('the committed output is below dust');
  try { if (!/^[0-9a-f]+$/.test(strip(p.dest)) || strip(p.dest).length % 2 || !standardSpk(p.dest)) r.push('the destination is not a standard script'); } catch { r.push('the destination is malformed'); }
  if (!Number.isInteger(p.deadline) || !Number.isInteger(p.expiresAt)) r.push('the times are not numbers');
  return r;
}

// Everything a reader can check without t: the shape, the lock output the terms make, the sighash of the committed take, and s' G = R + e X'. A pre-signature that
// passes was made by the holder of the key for exactly this take. `nowSecs` (optional) also refuses one past its expiry or implausibly far from it.
export function verifyPresig(p, { nowSecs = null } = {}) {
  try {
    const reasons = shapeReasons(p);
    if (!isHex(p && p.R, 64) || !isHex(p && p.sPre, 64)) reasons.push('R and sPre are 32 bytes each');
    if (reasons.length) return { ok: false, reasons };
    if (nowSecs != null && (p.expiresAt < nowSecs || p.expiresAt > nowSecs + MAX_LIFE_SECS)) return { ok: false, reasons: ['the pre-signature has expired or is dated too far ahead'] };
    const lock = lockOf({ claimerPub: p.claimerPub, T: p.T, lockerXonly: p.lockerXonly, csvBlocks: p.csv });
    const tx = skeleton(p), sh = sighashOf({ tx, lockValue: p.lock.value, lockSpk: lock.spk });
    const s = bytes32ToBigint(bx(p.sPre));
    if (s >= SECP_N || s === 0n) return { ok: false, reasons: ['sPre is out of range'] };
    const { c, c2 } = signsOf(lock), Rx = bx(p.R), e = challenge(Rx, lock.Qx, sh);
    const Xp = lock.P.multiply(c).add(G.multiply(lock.tw)).multiply(c2);
    if (!G.multiply(s).equals(liftEven(Rx).add(Xp.multiply(e)))) return { ok: false, reasons: ['the pre-signature does not verify'] };
    return { ok: true, reasons: [], lock, sighash: sh, spk: hx(lock.spk), e };
  } catch (err) { return { ok: false, reasons: ['malformed: ' + String((err && err.message) || err).slice(0, 120)] }; }
}

// ── the pool's claim, read for t ──
// z is the claim kernel's scalar from the pool settle; t = z - s~ (the user's own pre-signature of that kernel, carried in the record). Null unless t opens T.
export function extractT(p, z) {
  try {
    const t = adaptor.evmKernelExtract(bytes32ToBigint(bx(p.sTilde)), typeof z === 'bigint' ? z : BigInt(z));    // (as the page reads it: a bigint, a 0x string or a decimal one)
    return t !== 0n && adaptor.adaptorPoint(t).equals(Pt.fromHex(strip(p.T))) ? t : null;
  } catch { return null; }
}

// ── the watcher's side ──
// The completed signature (64 bytes) for the take, checked against the lock output key; throws unless it verifies.
export function completeSig(p, t) {
  const v = verifyPresig(p);
  if (!v.ok) throw new Error('take-presig: ' + v.reasons[0]);
  const tt = typeof t === 'bigint' ? t : bytes32ToBigint(bx(t));
  if (!(tt > 0n && tt < SECP_N) || !adaptor.adaptorPoint(tt).equals(Pt.fromHex(strip(p.T)))) throw new Error('take-presig: t does not open T');
  const { c, c2 } = signsOf(v.lock);
  const s = modN(bytes32ToBigint(bx(p.sPre)) + v.e * modN(c2 * c * tt));
  const sig = concatBytes(bx(p.R), bigintToBytes32(s));
  if (!verifySchnorr(sig, v.sighash, v.lock.Qx)) throw new Error('take-presig: the completed signature does not verify');
  return sig;
}

// The take as a transaction: input 0 the lock with the completed signature (65 bytes, the hash type last), output 0 the committed one. `extra` (optional, from a funder)
// adds inputs and outputs after those: { inputs: [{ txid, vout, sequence }], outputs: [{ value, script }], sign(tx, prevouts) -> witnesses[] for the added inputs }.
// The signature does not depend on them. Never returns a transaction whose first output is not the committed one.
export function buildTake(p, t, extra = null) {
  const sig = completeSig(p, t);
  const tx = skeleton(p);
  tx.inputs[0].witness = [concatBytes(sig, Uint8Array.of(HASH_TYPE))];
  if (extra) {
    for (const i of extra.inputs || []) tx.inputs.push({ txid: strip(i.txid), vout: i.vout, sequence: i.sequence ?? TAKE_SEQUENCE, witness: [] });
    for (const o of extra.outputs || []) tx.outputs.push({ value: o.value, script: bx(o.script) });
    if (extra.sign && extra.inputs && extra.inputs.length) {
      const ws = extra.sign(tx, [{ value: p.lock.value, script: lockOf({ claimerPub: p.claimerPub, T: p.T, lockerXonly: p.lockerXonly, csvBlocks: p.csv }).spk }, ...extra.inputs.map((i) => ({ value: i.value, script: bx(i.script) }))]);
      ws.forEach((w, k) => { tx.inputs[k + 1].witness = w; });
    }
  }
  const lock = lockOf({ claimerPub: p.claimerPub, T: p.T, lockerXonly: p.lockerXonly, csvBlocks: p.csv });
  if (!sameCommitted(tx, p, lock)) throw new Error('take-presig: the take does not pay the committed output');
  return { tx, hex: hx(serializeTx(tx)), txid: txidOf(tx), vsize: vsizeOf(tx), fee: Number(p.fee) };
}

// The last check before a broadcast: input 0 is the lock outpoint, output 0 is exactly the user's address and value, and the signature on input 0 verifies for the
// sighash of this very transaction (so it is the one the pre-signature was made for).
export function sameCommitted(tx, p, lock = lockOf({ claimerPub: p.claimerPub, T: p.T, lockerXonly: p.lockerXonly, csvBlocks: p.csv })) {
  const i = tx.inputs[0], o = tx.outputs[0], w = i.witness && i.witness[0];
  if (!i || !o || !w || w.length !== 65 || w[64] !== HASH_TYPE) return false;
  if (strip(i.txid) !== strip(p.lock.txid) || i.vout !== p.lock.vout || i.sequence !== TAKE_SEQUENCE || tx.version !== 2 || tx.locktime !== 0) return false;
  if (o.value !== p.lock.value - p.fee || hx(o.script) !== strip(p.dest)) return false;
  return verifySchnorr(w.slice(0, 64), sighashOf({ tx, lockValue: p.lock.value, lockSpk: lock.spk }), lock.Qx);
}

// The fee rate (sat/vB) the committed fee pays at the take's own size (one input, one output, a 65-byte signature)
export function committedRate(p) {
  const probe = skeleton(p);
  probe.inputs[0].witness = [new Uint8Array(65)];
  return p.fee / vsizeOf(probe);
}
// The fee to commit for a rate: the size of the take alone (one P2TR key-path input, the destination output) at that rate
export function takeFee({ dest, feeRate, lockValue }) {
  const probe = { version: 2, locktime: 0, inputs: [{ txid: '00'.repeat(32), vout: 0, sequence: TAKE_SEQUENCE, witness: [new Uint8Array(65)] }], outputs: [{ value: MIN_OUT, script: bx(dest) }] };
  const fee = Math.ceil(vsizeOf(probe) * feeRate);
  return Math.min(fee, Math.floor(Number(lockValue) * MAX_FEE_SHARE));
}
