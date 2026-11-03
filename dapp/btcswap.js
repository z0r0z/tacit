// A Bitcoin-to-Bitcoin swap between a holder of TAC the bridge's proof does not follow (a note whose history passes a
// shielded-pool exit, for one) and a desk holding TAC it follows. The holder ends with a tracked note it bridges in one
// burn; the desk ends with the holder's note. Both legs are Bitcoin locks, so neither side can be left half-paid:
//
//   1. The holder locks its note in a Taproot output keyed P_desk + T (dapp/adaptor-btc-lock.js), refundable to the
//      holder after `csvHolder` blocks. t is the holder's (adaptor-xswap deriveSwapSecrets), so only the holder can let
//      the desk open it.
//   2. The desk checks that lock on the chain and locks tracked TAC in a Taproot output whose key is the MuSig2 aggregate
//      of the holder's and the desk's keys (jointLock), refundable to the desk after `csvDesk` blocks, a shorter wait.
//   3. The holder checks the desk's lock (its key, its opening, that the proof follows it) and claims it by KEY PATH: the
//      two sign the claim together, the desk's half adapted to T (dapp/musig2.js), so the signature the holder completes
//      and publishes gives the desk t. A key-path spend keeps the note tracked (tests/btc-swap-lock-reflect.test.mjs); a
//      script-path one would not.
//   4. The desk reads t from the claim's signature and opens the holder's lock.
//
// Neither side can spend the desk's lock alone, so no holder can destroy the desk's TAC by spending it outside a valid
// transfer, and the claim that would pay the holder is the one that pays the desk. The holder's lock outlives the desk's
// by a margin, so t, once public, always leaves the desk time to open it.
//
// Pure: the Taproot helpers come in as `prims` (dapp/bitcoin-taproot-wallet.js).

import { secp, sha256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { SECP_N, pedersenCommit, bytes32ToBigint, bigintToBytes32, signSchnorr, verifySchnorr } from './bulletproofs.js';
import { deriveLock, refundLeaf } from './adaptor-btc-lock.js';
import { swapIdOf } from './adaptor-xswap.js';
import * as M from './musig2.js';

const te = new TextEncoder();
const Pt = secp.ProjectivePoint;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const hx = (b) => bytesToHex(b);
const bx = (h) => (h instanceof Uint8Array ? h : hexToBytes(strip(h)));
const hs = (x) => (x instanceof Uint8Array ? hx(x) : strip(x));
const toBig = (x) => (typeof x === 'bigint' ? x : bytes32ToBigint(bx(x)));
const tagged = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concatBytes(t, t, ...msgs)); };
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const pointOk = (h) => { try { return HEX(66).test(strip(h)) && !Pt.fromHex(strip(h)).equals(Pt.ZERO); } catch { return false; } };
const scalarOk = (h) => { try { const v = BigInt('0x' + strip(h)); return HEX(64).test(strip(h)) && v > 0n && v < SECP_N; } catch { return false; } };
const amountOk = (v) => /^\d{1,30}$/.test(String(v)) && BigInt(v) > 0n;

export const DEFAULTS = { csvHolder: 288, csvDesk: 144, lockDelayBlocks: 6, takeMarginBlocks: 24, claimLeftBlocks: 12, signStopBlocks: 6 };

// The desk's lock: key path = MuSig2(holder, desk) tweaked by the refund leaf; script path = the desk's refund after
// `csvBlocks`. The shape of adaptor-btc-lock deriveLock (the builders' refund reads leaf, leafHash, controlBlock), plus
// `keys` (the tweaked aggregate the claim is signed under).
export function jointLock({ prims, holderPub, deskPub, deskXonly, csvBlocks }) {
  const pks = M.keySort([bx(holderPub), bx(deskPub)]);
  const inner = M.keyAgg(pks);
  const leaf = refundLeaf({ lockerXonly: bx(deskXonly), csvBlocks });
  const leafHash = prims.tapLeafHash(leaf);
  const keys = M.keyAgg(pks, [M.tapTweak(inner.xonly, leafHash)]);
  const { Q_xonly, parity } = prims.tweakedOutputKey(inner.xonly, leafHash);
  if (hx(Q_xonly) !== hx(keys.xonly)) throw new Error('btcswap: the aggregate output key does not match the wallet\'s');
  return { internalXonly: inner.xonly, leaf, leafHash, csvBlocks, outputXonly: Q_xonly, parity, spk: prims.p2trScript(Q_xonly), controlBlock: prims.controlBlock(inner.xonly, parity), keys };
}

// The holder's lock: adaptor-btc-lock's, with the desk as claimer.
export const holderLock = ({ prims, deskPub, T, holderXonly, csvBlocks }) => deriveLock({ prims, claimerPub: bx(deskPub), T, lockerXonly: bx(holderXonly), csvBlocks });

// ── step 1 → 2: what the holder sends once its lock has confirmed ──
export function makeHolderOffer({ swapId, asset, value, rLock, txid, vout, csvBlocks, holderPub, T, deskPub, out }) {
  return {
    v: 1, swapId: hx(swapId), T: hx(T.toRawBytes(true)), deskPub: hs(deskPub), holderPub: hs(holderPub),
    lock: { asset: hs(asset), value: String(value), rLock: hx(bigintToBytes32(toBig(rLock))), txid: strip(txid), vout, csvBlocks },
    out: String(out),
  };
}

function holderOfferShape(o) {
  const l = o.lock || {}, bad = [];
  if (o.v !== 1) bad.push('version');
  if (!HEX(72).test(strip(o.swapId || ''))) bad.push('swap id');
  if (!pointOk(o.T || '')) bad.push('T');
  if (!pointOk(o.deskPub || '') || !pointOk(o.holderPub || '')) bad.push('keys');
  if (!HEX(64).test(strip(l.txid || '')) || !Number.isInteger(l.vout) || l.vout < 0) bad.push('lock outpoint');
  if (!HEX(64).test(strip(l.asset || '')) || !amountOk(l.value)) bad.push('lock amount');
  if (!scalarOk(l.rLock || '')) bad.push('lock blinding');
  if (!Number.isInteger(l.csvBlocks) || l.csvBlocks < 1 || l.csvBlocks > 0xffff) bad.push('timelock');
  if (!amountOk(o.out)) bad.push('amount out');
  return bad;
}

// The desk's check of the holder's lock. `chain` is what the desk read itself: { spk, commitment (33-byte hex),
// validNote (the validator's note of `expect.asset`), confirmations, height, tip, noteInputs }. `expect` is its quote.
export function checkHolderOffer(offer, { prims, deskPub, expect, chain, minConfs = 1, policy = DEFAULTS }) {
  try {
    const o = offer || {};
    const bad = holderOfferShape(o);
    if (bad.length) return { ok: false, reasons: ['malformed offer: ' + bad.join(', ')] };
    const l = o.lock, reasons = [];
    if (strip(o.deskPub) !== hs(deskPub)) reasons.push('the lock is not keyed to this desk');
    if (strip(l.asset) !== hs(expect.asset) || BigInt(l.value) !== BigInt(expect.value) || BigInt(o.out) !== BigInt(expect.out)) reasons.push('the amounts differ from the quote');
    if (l.csvBlocks < policy.csvHolder) reasons.push(`refund timelock under ${policy.csvHolder} blocks`);
    const lock = holderLock({ prims, deskPub: o.deskPub, T: Pt.fromHex(strip(o.T)), holderXonly: bx(o.holderPub).slice(1), csvBlocks: l.csvBlocks });
    if (hx(lock.spk) !== hs(chain.spk)) reasons.push('the output does not pay the lock these terms make');
    if (hx(pedersenCommit(BigInt(l.value), toBig(l.rLock)).toRawBytes(true)) !== hs(chain.commitment)) reasons.push('the opening does not match the note');
    if (chain.validNote !== true) reasons.push('the output is not a valid note of the asset');
    if (!(chain.confirmations >= minConfs)) reasons.push(`fewer than ${minConfs} confirmation(s)`);
    const first = chain.noteInputs && chain.noteInputs[0];
    if (!first || strip(o.swapId) !== hx(swapIdOf(first.txid, first.vout))) reasons.push('the swap id is not the outpoint the lock transaction spends');
    // the desk's lock, its refund wait and a margin to take this lock must all fit before this lock's refund opens
    if (chain.confirmations > 0 && chain.height + l.csvBlocks - 1 < chain.tip + policy.lockDelayBlocks + policy.csvDesk + policy.takeMarginBlocks) reasons.push('the lock\'s refund opens too soon for the desk to lock against it');
    return { ok: reasons.length === 0, reasons, lock };
  } catch (e) { return { ok: false, reasons: ['malformed offer: ' + String((e && e.message) || e).slice(0, 120)] }; }
}

// The desk's key in one swap's joint lock, and its lock's blinding. Each swap has a key of its own: with one key for every
// swap, two locks for the same holder would share an output key, and a signature the desk gave for one could spend the
// other while revealing only the first swap's t.
function scalarOf(seed, tag, swapId) {
  for (let i = 0; ; i++) {
    const k = bytes32ToBigint(tagged('tacit-btcswap-desk-v1', seed, te.encode(tag), bx(swapId), Uint8Array.of(i)));
    if (k > 0n && k < SECP_N) return k;
  }
}
export function deskSwapSecrets({ seed, swapId }) {
  if (!(seed instanceof Uint8Array) || seed.length < 32) throw new Error('btcswap: seed must be at least 32 bytes');
  const d = scalarOf(seed, 'musig-key', swapId);
  return { d, pub: secp.ProjectivePoint.BASE.multiply(d).toRawBytes(true), rLock: scalarOf(seed, 'r-lock', swapId) };
}

// ── step 2 → 3: what the desk publishes once its lock has confirmed ──
export function makeDeskOffer({ swapId, asset, amount, rLock, txid, vout, csvBlocks, deskXonly, musigPub }) {
  return { v: 1, swapId: hx(swapId), lock: { asset: hs(asset), amount: String(amount), rLock: hx(bigintToBytes32(toBig(rLock))), txid: strip(txid), vout, csvBlocks, deskXonly: hs(deskXonly), musigPub: hs(musigPub) } };
}

// The holder's check of the desk's lock. `chain`: { spk, commitment, validNote, confirmations, height, tip, tracked }
// where `tracked` is true once the bridge's proof follows the output (or its inputs, see trackedAhead).
export function checkDeskOffer(offer, { prims, holderPub, expect, chain, minConfs = 2, minCsv = DEFAULTS.csvDesk / 2, policy = DEFAULTS }) {
  try {
    const o = offer || {}, l = o.lock || {}, reasons = [];
    if (o.v !== 1 || strip(o.swapId || '') !== hs(expect.swapId)) return { ok: false, reasons: ['an offer for another swap'] };
    if (!HEX(64).test(strip(l.txid || '')) || !Number.isInteger(l.vout) || l.vout < 0 || !amountOk(l.amount) || !scalarOk(l.rLock || '') || !HEX(64).test(strip(l.deskXonly || ''))
      || !pointOk(l.musigPub || '') || strip(l.musigPub) === hs(holderPub) || !Number.isInteger(l.csvBlocks) || l.csvBlocks < 1 || l.csvBlocks > 0xffff) return { ok: false, reasons: ['malformed offer'] };
    if (strip(l.asset) !== hs(expect.asset) || BigInt(l.amount) !== BigInt(expect.amount)) reasons.push('the desk locked another amount');
    if (l.csvBlocks < minCsv) reasons.push(`the desk's refund opens in under ${minCsv} blocks`);
    const lock = jointLock({ prims, holderPub, deskPub: l.musigPub, deskXonly: l.deskXonly, csvBlocks: l.csvBlocks });
    if (hx(lock.spk) !== hs(chain.spk)) reasons.push('the output does not pay the joint lock');
    if (hx(pedersenCommit(BigInt(l.amount), toBig(l.rLock)).toRawBytes(true)) !== hs(chain.commitment)) reasons.push('the opening does not match the note');
    if (chain.validNote !== true) reasons.push('the output is not a valid note of the asset');
    if (!(chain.confirmations >= minConfs)) reasons.push(`fewer than ${minConfs} confirmation(s)`);
    if (chain.tracked !== true) reasons.push('the bridge\'s proof does not follow this note');
    if (chain.confirmations > 0 && chain.tip + policy.claimLeftBlocks > chain.height + l.csvBlocks - 1) reasons.push('too little time is left before the desk\'s refund opens');
    return { ok: reasons.length === 0, reasons, lock };
  } catch (e) { return { ok: false, reasons: ['malformed offer: ' + String((e && e.message) || e).slice(0, 120)] }; }
}

// Whether the proof will follow a confirmed lock output it has not reached yet: the lock transaction is a valid transfer
// (the caller's validator says so), every note it spends is tracked, and every one of those inputs is signed in a way that
// binds the outputs (a key-path signature with the default or ALL sighash, or a P2WPKH signature in strict DER with an
// ALL-type sighash), the rule of cxfer-core bitcoin.rs input_first_witness_item / sig_binds_all_outputs.
export function bindsAllOutputs(witness) {
  const w = (witness || []).map((x) => bx(x));
  if (w.length !== 1 && w.length !== 2) return false;
  const sig = w[0];
  if (w.length === 2 && !(w[1].length === 33 && (w[1][0] === 0x02 || w[1][0] === 0x03) && derShaped(sig))) return false;
  return sig.length === 64 || (sig.length > 0 && (sig[sig.length - 1] & 0x7f) === 0x01);
}
// bitcoin.rs is_strict_der_sig_with_sighash
function derShaped(sig) {
  const n = sig.length;
  if (n < 9 || n > 73 || sig[0] !== 0x30 || sig[1] !== n - 3 || sig[2] !== 0x02) return false;
  const rlen = sig[3];
  if (rlen === 0 || 4 + rlen + 2 > n || sig[4 + rlen] !== 0x02) return false;
  const slen = sig[5 + rlen];
  return slen !== 0 && 6 + rlen + slen === n - 1;
}

// ── requests the holder signs ──
// The desk answers a signing request only from the key the holder's lock refunds to: a stranger who knows a swap id
// cannot use up its signing sessions.
export const requestDigest = (id, path, body) => tagged('tacit-btcswap-req-v1', bx(id), te.encode(path), te.encode(JSON.stringify(body)));
export const signRequest = (priv, id, path, body) => hx(signSchnorr(requestDigest(id, path, body), priv));
export function checkRequest({ holderPub, id, path, body, auth }) {
  try { return HEX(128).test(strip(auth || '')) && verifySchnorr(bx(auth), requestDigest(id, path, body), bx(holderPub).slice(1)); } catch { return false; }
}

// t from a spend of the desk's lock: the key-path signature's s against each pre-signature the desk gave out.
// `sessions` are the desk's stored ones ({ msg, pubnonces, sPre }), `T` the holder's adaptor point.
export function extractT({ witness, sessions, keys, T }) {
  if (!witness || witness.length !== 1) return null;
  const sig = bx(witness[0]);
  for (const s of sessions) {
    if (!s.sPre) continue;
    const sess = M.session({ keys, pubnonces: s.pubnonces.map(bx), msg: bx(s.msg), T });
    const t = M.extract({ sig, sPre: BigInt('0x' + strip(s.sPre)), sess });
    if (t) return t;
  }
  return null;
}
