// CXFER helpers — port of the dapp's tapscript / Schnorr / stealth /
// kernel / encoder primitives. Kept self-contained so bridge-3b.mjs
// imports a single module rather than copy-pasting.
//
// All functions byte-for-byte match dapp/tacit.js. Cross-impl pinning is
// possible against tests/mixer-envelope.test.mjs (dapp side) by feeding
// identical inputs.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { randomBytes } from 'crypto';
import { bppRangeProve } from '/Users/z/tacit/dapp/bulletproofs-plus.js';

// ─── Constants ──────────────────────────────────────────────────────
export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N_BITS = 64;

export const G = secp.ProjectivePoint.BASE;
export const ZERO = secp.ProjectivePoint.ZERO;

export const BLIND_DOMAIN        = new TextEncoder().encode('tacit-blind-v1');
export const CHANGE_DOMAIN       = new TextEncoder().encode('tacit-change-v1');
export const AMOUNT_DOMAIN       = new TextEncoder().encode('tacit-amount-v1');
export const AMOUNT_SELF_DOMAIN  = new TextEncoder().encode('tacit-amount-self-v1');

export const ENVELOPE_MAGIC      = new TextEncoder().encode('TACIT');
export const ENVELOPE_VERSION    = 0x01;
export const TAP_NUMS            = unhex('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

export const MAX_SCRIPT_PUSH = 520;
export const OP_FALSE = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d;
export const OP_IF = 0x63, OP_ENDIF = 0x68, OP_CHECKSIG = 0xac;

export const T_CXFER_BPP = 0x22;
export const DUST = 546;

// ─── Bytes / hex / writer ───────────────────────────────────────────
export function hex(b) { return Buffer.from(b).toString('hex'); }
export function unhex(s) { return new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex')); }
export const hexToBytes = unhex;
export const bytesToHex = hex;
export function concatBytes(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export function bigintToBytes32(v) {
  v = BigInt(v);
  const buf = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}
export function bytes32ToBigint(b) {
  let v = 0n;
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}
export const hash256 = b => sha256(sha256(b));
export const hash160 = b => ripemd160(sha256(b));
export const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };

export class W {
  constructor() { this.parts = []; }
  push(b) { this.parts.push(b); return this; }
  u8(n)   { this.parts.push(new Uint8Array([n & 0xff])); return this; }
  u32(n)  { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return this.push(b); }
  u64(n)  { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.push(b); }
  varint(n) {
    if (n < 0xfd)        return this.u8(n);
    if (n < 0x10000)     { this.u8(0xfd); const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return this.push(b); }
    if (n < 0x100000000) { this.u8(0xfe); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.push(b); }
    this.u8(0xff); return this.u64(n);
  }
  out() { return concatBytes(...this.parts); }
}

export function _compactSize(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; }
  if (n <= 0xffffffff) { const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b; }
  throw new Error('compactSize too big');
}
function _encodePush(data) {
  const L = data.length;
  if (L === 0) return new Uint8Array([0]);
  if (L < 0x4c) return concatBytes(new Uint8Array([L]), data);
  if (L <= 0xff) return concatBytes(new Uint8Array([OP_PUSHDATA1, L]), data);
  if (L <= 0xffff) {
    const b = new Uint8Array(3); b[0] = OP_PUSHDATA2;
    new DataView(b.buffer).setUint16(1, L, true);
    return concatBytes(b, data);
  }
  throw new Error('push too big');
}

// ─── Pedersen ──────────────────────────────────────────────────────
function deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let c = 0; c < 256; c++) {
    const x = sha256(concatBytes(seed, new Uint8Array([c])));
    const cand = concatBytes(new Uint8Array([0x02]), x);
    try { const p = secp.ProjectivePoint.fromHex(hex(cand)); if (!p.equals(ZERO)) return p; } catch {}
  }
  throw new Error('H');
}
export const H = deriveH();
export const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
export function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}
export const pointToBytes = P => P.toRawBytes(true);
export function bytesToPoint(b) {
  if (b.length !== 33 || (b[0] !== 0x02 && b[0] !== 0x03)) throw new Error('pubkey must be 33-byte compressed');
  return secp.ProjectivePoint.fromHex(hex(b));
}

// ─── Tagged hash + Schnorr (BIP-340) ───────────────────────────────
export function _taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}
function _xor32(a, b) { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; }
export function signSchnorr(msgHash, priv32) {
  const dPrime = bytes32ToBigint(priv32);
  if (dPrime <= 0n || dPrime >= SECP_N) throw new Error('schnorr: invalid private key');
  const P = G.multiply(dPrime);
  const Pbytes = P.toRawBytes(true);
  const Px = Pbytes.slice(1);
  const d = (Pbytes[0] === 0x02) ? dPrime : (SECP_N - dPrime);
  const aux = randomBytes(32);
  const t = _xor32(bigintToBytes32(d), _taggedHash('BIP0340/aux', aux));
  const rand = _taggedHash('BIP0340/nonce', t, Px, msgHash);
  let kPrime = bytes32ToBigint(rand) % SECP_N;
  if (kPrime === 0n) throw new Error('schnorr: nonce zero');
  const R = G.multiply(kPrime);
  const Rbytes = R.toRawBytes(true);
  const Rx = Rbytes.slice(1);
  const k = (Rbytes[0] === 0x02) ? kPrime : (SECP_N - kPrime);
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, Px, msgHash)) % SECP_N;
  const s = (k + e * d) % SECP_N;
  return concatBytes(Rx, bigintToBytes32(s));
}

// ─── Taproot helpers ───────────────────────────────────────────────
export function tapLeafHash(script, leafVersion = 0xc0) {
  return _taggedHash('TapLeaf', new Uint8Array([leafVersion]), _compactSize(script.length), script);
}
export function tweakedOutputKey(internalXonly, merkleRoot) {
  const P = secp.ProjectivePoint.fromHex('02' + hex(internalXonly));
  const t = _taggedHash('TapTweak', internalXonly, merkleRoot);
  const tBig = bytes32ToBigint(t);
  if (tBig >= SECP_N) throw new Error('tap tweak ≥ N');
  const Q = P.add(G.multiply(tBig));
  const Qbytes = Q.toRawBytes(true);
  return { Q_xonly: Qbytes.slice(1), parity: Qbytes[0] === 0x03 ? 1 : 0 };
}
export function p2trScript(Q_xonly) {
  return concatBytes(new Uint8Array([0x51, 0x20]), Q_xonly);
}
export function controlBlock(internalXonly, parity, leafVersion = 0xc0) {
  return concatBytes(new Uint8Array([leafVersion | (parity & 1)]), internalXonly);
}

// ─── BIP-341 sighashes (script-path + key-path) ────────────────────
export function tapSighash(tx, inputIdx, prevouts, leafHash, hashType = 0x00) {
  if (prevouts.length !== tx.inputs.length) throw new Error('prevouts length mismatch');
  const u8 = v => new Uint8Array([v & 0xff]);
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
  const parts = [u8(0x00), u8(hashType), u32(tx.version), u32(tx.locktime)];
  if ((hashType & 0x80) !== 0x80) {
    const buf = [];
    for (const inp of tx.inputs) { buf.push(reverseBytes(hexToBytes(inp.txid))); buf.push(u32(inp.vout)); }
    parts.push(sha256(concatBytes(...buf)));
    const amts = []; for (const po of prevouts) amts.push(u64(po.value));
    parts.push(sha256(concatBytes(...amts)));
    const spks = [];
    for (const po of prevouts) { spks.push(_compactSize(po.script.length)); spks.push(po.script); }
    parts.push(sha256(concatBytes(...spks)));
    const seqs = []; for (const inp of tx.inputs) seqs.push(u32(inp.sequence ?? 0xffffffff));
    parts.push(sha256(concatBytes(...seqs)));
  }
  const baseHt = hashType & 0x03;
  if (baseHt === 0x00 || baseHt === 0x01) {
    const outs = [];
    for (const out of tx.outputs) { outs.push(u64(out.value)); outs.push(_compactSize(out.script.length)); outs.push(out.script); }
    parts.push(sha256(concatBytes(...outs)));
  }
  parts.push(u8((1 << 1) | 0)); // ext_flag=1 (tapscript) + annex bit 0
  if ((hashType & 0x80) === 0x80) {
    const inp = tx.inputs[inputIdx]; const po = prevouts[inputIdx];
    parts.push(reverseBytes(hexToBytes(inp.txid)), u32(inp.vout), u64(po.value));
    parts.push(_compactSize(po.script.length), po.script, u32(inp.sequence ?? 0xffffffff));
  } else {
    parts.push(u32(inputIdx));
  }
  if (baseHt === 0x03) {
    if (inputIdx >= tx.outputs.length) throw new Error('SIGHASH_SINGLE: no output at idx');
    const out = tx.outputs[inputIdx];
    parts.push(sha256(concatBytes(u64(out.value), _compactSize(out.script.length), out.script)));
  }
  parts.push(leafHash, u8(0x00), u32(0xffffffff));
  return _taggedHash('TapSighash', concatBytes(...parts));
}
export function tapSighashKeyPath(tx, inputIdx, prevouts, hashType = 0x00) {
  if (prevouts.length !== tx.inputs.length) throw new Error('prevouts length mismatch');
  const u8 = v => new Uint8Array([v & 0xff]);
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
  const parts = [u8(0x00), u8(hashType), u32(tx.version), u32(tx.locktime)];
  const buf = [];
  for (const inp of tx.inputs) { buf.push(reverseBytes(hexToBytes(inp.txid))); buf.push(u32(inp.vout)); }
  parts.push(sha256(concatBytes(...buf)));
  const amts = []; for (const po of prevouts) amts.push(u64(po.value));
  parts.push(sha256(concatBytes(...amts)));
  const spks = [];
  for (const po of prevouts) { spks.push(_compactSize(po.script.length)); spks.push(po.script); }
  parts.push(sha256(concatBytes(...spks)));
  const seqs = []; for (const inp of tx.inputs) seqs.push(u32(inp.sequence ?? 0xffffffff));
  parts.push(sha256(concatBytes(...seqs)));
  const outs = [];
  for (const out of tx.outputs) { outs.push(u64(out.value)); outs.push(_compactSize(out.script.length)); outs.push(out.script); }
  parts.push(sha256(concatBytes(...outs)));
  parts.push(u8(0)); // ext_flag=0 (keypath) + annex bit 0
  parts.push(u32(inputIdx));
  return _taggedHash('TapSighash', concatBytes(...parts));
}

// ─── BIP-143 sighash (P2WPKH) ──────────────────────────────────────
export function sighashV0(tx, idx, scriptCode, value) {
  const w = new W();
  w.u32(tx.version);
  const wp = new W();
  for (const i of tx.inputs) { wp.push(reverseBytes(hexToBytes(i.txid))); wp.u32(i.vout); }
  w.push(hash256(wp.out()));
  const ws = new W();
  for (const i of tx.inputs) ws.u32(i.sequence);
  w.push(hash256(ws.out()));
  const inp = tx.inputs[idx];
  w.push(reverseBytes(hexToBytes(inp.txid)));
  w.u32(inp.vout);
  w.varint(scriptCode.length).push(scriptCode);
  w.u64(value);
  w.u32(inp.sequence);
  const wo = new W();
  for (const o of tx.outputs) { wo.u64(o.value); wo.varint(o.script.length).push(o.script); }
  w.push(hash256(wo.out()));
  w.u32(tx.locktime);
  w.u32(0x01); // SIGHASH_ALL
  return hash256(w.out());
}

// ─── ECDSA DER (BIP-66) ───────────────────────────────────────────
export function derEncodeFromCompact(rs) {
  const trim = x => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let t = x.slice(i); if (t[0] & 0x80) t = concatBytes(new Uint8Array([0]), t); return t; };
  const r = trim(rs.slice(0, 32));
  const s = trim(rs.slice(32, 64));
  return concatBytes(
    new Uint8Array([0x30, 4 + r.length + s.length]),
    new Uint8Array([0x02, r.length]), r,
    new Uint8Array([0x02, s.length]), s,
  );
}
export function ecdsaSign(hash, priv) {
  const sig = secp.sign(hash, priv, { lowS: true });
  return concatBytes(derEncodeFromCompact(sig.toCompactRawBytes()), new Uint8Array([0x01]));
}

// ─── Tx serialization ──────────────────────────────────────────────
export function serializeTx(tx, withWitness = true) {
  const hasWit = withWitness && tx.inputs.some(i => i.witness && i.witness.length);
  const w = new W();
  w.u32(tx.version);
  if (hasWit) w.push(new Uint8Array([0x00, 0x01]));
  w.varint(tx.inputs.length);
  for (const i of tx.inputs) {
    w.push(reverseBytes(hexToBytes(i.txid))); w.u32(i.vout);
    const ss = i.scriptSig || new Uint8Array(0);
    w.varint(ss.length).push(ss);
    w.u32(i.sequence);
  }
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) { w.u64(o.value); w.varint(o.script.length).push(o.script); }
  if (hasWit) {
    for (const i of tx.inputs) {
      const wit = i.witness || [];
      w.varint(wit.length);
      for (const item of wit) w.varint(item.length).push(item);
    }
  }
  w.u32(tx.locktime);
  return w.out();
}
export const computeTxid = tx => bytesToHex(reverseBytes(hash256(serializeTx(tx, false))));
export const p2wpkhScript = pubkey => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));

// ─── Signing helpers (key-injectable) ──────────────────────────────
export function signP2wpkhInputWithKey(tx, idx, prevValue, signerPriv, signerPub) {
  const scriptCode = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(signerPub), new Uint8Array([0x88, 0xac]));
  const sh = sighashV0(tx, idx, scriptCode, prevValue);
  const sig = ecdsaSign(sh, signerPriv);
  return [sig, signerPub];
}
export function signTaprootKeypathInputWithKey(tx, inputIdx, prevouts, privKey) {
  const sh = tapSighashKeyPath(tx, inputIdx, prevouts, 0x00);
  const sig = signSchnorr(sh, privKey);
  return [sig];
}
export function signTaprootScriptPathInputWithKey(tx, prevouts, envelopeScript, controlBlockBytes, privKey, inputIdx = 0) {
  const leaf = tapLeafHash(envelopeScript);
  const sh = tapSighash(tx, inputIdx, prevouts, leaf, 0x00);
  const sig = signSchnorr(sh, privKey);
  return [sig, envelopeScript, controlBlockBytes];
}

// ─── Stealth blinding / amount keystream ───────────────────────────
export function deriveBlinding(myPriv, theirPubBytes, anchorBytes, voutIdx) {
  bytesToPoint(theirPubBytes);
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const seed = sha256(shared.slice(1));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, seed, concatBytes(BLIND_DOMAIN, anchorBytes, voutLE));
  return bytes32ToBigint(out) % SECP_N;
}
export function deriveChangeBlinding(myPriv, anchorBytes, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, myPriv, concatBytes(CHANGE_DOMAIN, anchorBytes, voutLE));
  return bytes32ToBigint(out) % SECP_N;
}
export function deriveAmountKeystreamECDH(myPriv, theirPubBytes, anchorBytes, voutIdx) {
  bytesToPoint(theirPubBytes);
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const seed = sha256(shared.slice(1));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, seed, concatBytes(AMOUNT_DOMAIN, anchorBytes, voutLE)).slice(0, 8);
}
export function deriveAmountKeystreamSelf(myPriv, anchorBytes, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, myPriv, concatBytes(AMOUNT_SELF_DOMAIN, anchorBytes, voutLE)).slice(0, 8);
}

// ─── CXFER ─────────────────────────────────────────────────────────
export function encryptAmount(amountBigint, keystream8) {
  const a = BigInt(amountBigint);
  if (a < 0n || a >= (1n << 64n)) throw new Error('amount out of u64 range');
  const ct = new Uint8Array(8);
  let n = a;
  for (let i = 0; i < 8; i++) { ct[i] = Number(n & 0xffn) ^ keystream8[i]; n >>= 8n; }
  return ct;
}
export function computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnedAmount = 0n) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (inputOutpoints.length > 255) throw new Error('input count > 255');
  if (outputCommitments.length > 255) throw new Error('output count > 255');
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), assetId, new Uint8Array([inputOutpoints.length])];
  for (const op of inputOutpoints) {
    parts.push(reverseBytes(hexToBytes(op.txid)));
    const voutLE = new Uint8Array(4); new DataView(voutLE.buffer).setUint32(0, op.vout >>> 0, true);
    parts.push(voutLE);
  }
  parts.push(new Uint8Array([outputCommitments.length]));
  for (const c of outputCommitments) parts.push(c);
  const burnLE = new Uint8Array(8); const view = new DataView(burnLE.buffer);
  view.setUint32(0, Number(burnedAmount & 0xffffffffn), true);
  view.setUint32(4, Number((burnedAmount >> 32n) & 0xffffffffn), true);
  parts.push(burnLE);
  return sha256(concatBytes(...parts));
}
export function encodeCXferBppPayload({ assetId, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig 64 bytes');
  if (![1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs in {1,2,4,8}');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const parts = [new Uint8Array([T_CXFER_BPP]), assetId, kernelSig, new Uint8Array([outputs.length])];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encryptedAmount 8');
    parts.push(o.commitment, o.encryptedAmount);
  }
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}

// ─── Envelope script (tapscript leaf wrapping a payload) ───────────
export function encodeEnvelopeScript(signingPubXonly, payload) {
  if (signingPubXonly.length !== 32) throw new Error('signing pubkey must be 32 bytes (x-only)');
  const chunks = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION])];
  for (let i = 0; i < payload.length; i += MAX_SCRIPT_PUSH) {
    chunks.push(payload.slice(i, Math.min(i + MAX_SCRIPT_PUSH, payload.length)));
  }
  const pieces = [_encodePush(signingPubXonly), new Uint8Array([OP_CHECKSIG]), new Uint8Array([OP_FALSE, OP_IF])];
  for (const c of chunks) pieces.push(_encodePush(c));
  pieces.push(new Uint8Array([OP_ENDIF]));
  return concatBytes(...pieces);
}

// ─── BPP+ proof helper ─────────────────────────────────────────────
export function bppProveAmounts(amounts, blindings) {
  // bppRangeProve(amounts, blindings) returns { proof: Uint8Array, commitments: Point[] }
  return bppRangeProve(amounts, blindings);
}

// ─── Taproot envelope broadcaster (commit + reveal) ────────────────
// Bridge ops (MINT/BURN/EXPORT/IMPORT/ROTATE) and mixer T_WITHDRAW exceed the
// 80B OP_RETURN datacarrier cap, so they ride in a Taproot script-path reveal
// whose witness item 1 carries the TACIT-framed envelope (encodeEnvelopeScript).
// The guest's extract_taproot_envelope strips the frame and dispatches on the
// opcode. Mirrors the dapp's buildAndBroadcastBridge* commit/reveal.
//   extraRevealOutputs: outputs placed at vout 0.. BEFORE the change (e.g.
//   EXPORT's stealth UTXO at vout 0). Default [] → reveal is change-only.
// Returns { commitTxid, revealTxid } — revealTxid is what the worker/guest index.
export async function broadcastTaprootEnvelope({
  envelope, signerPriv, signerPub, address, mempoolApi,
  extraRevealOutputs = [], extraRevealInputs = [],
  revealFee = Number(process.env.REVEAL_FEE) || 2500, commitFee = Number(process.env.COMMIT_FEE) || 300,
}) {
  const xonly = signerPub.slice(1, 33);
  const envelopeScript = encodeEnvelopeScript(xonly, envelope);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);
  const wpkh = p2wpkhScript(signerPub);

  const utxos = await (await fetch(`${mempoolApi}/address/${address}/utxo`)).json();
  const spendable = utxos.filter(u => u.value > DUST);
  const conf = spendable.filter(u => u.status?.confirmed);
  const pool = (conf.length ? conf : spendable).sort((a, b) => b.value - a.value);
  if (!pool.length) throw new Error('no spendable signet UTXO for the Taproot commit');
  const funding = pool[0];

  const extraSum = extraRevealOutputs.reduce((s, o) => s + o.value, 0);
  const extraInSum = extraRevealInputs.reduce((s, i) => s + i.value, 0);
  const commitValue = DUST + extraSum + revealFee;
  const commitChange = funding.value - commitValue - commitFee;
  if (commitChange < DUST) {
    throw new Error(`commit change ${commitChange} < dust (funding ${funding.value}, need ${commitValue + commitFee})`);
  }

  const commitTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: funding.txid, vout: funding.vout, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: commitValue, script: p2trSpk }, { value: commitChange, script: wpkh }],
  };
  commitTx.inputs[0].witness = signP2wpkhInputWithKey(commitTx, 0, funding.value, signerPriv, signerPub);
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = computeTxid(commitTx);

  // Reveal: vin0 = commit P2TR (script-path, signerPriv); vin1.. = extraRevealInputs
  // each P2WPKH signed with its own key — IMPORT (0x64) spends the imported tETH
  // UTXO here so the guest's extract_input_outpoints match fires. Outputs:
  // extraRevealOutputs at vout 0.., then change. Fee = revealFee.
  const revealChange = DUST + extraInSum;
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
      ...extraRevealInputs.map(i => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd, witness: [] })),
    ],
    outputs: [...extraRevealOutputs, { value: revealChange, script: wpkh }],
  };
  const prevouts = [
    { value: commitValue, script: p2trSpk },
    ...extraRevealInputs.map(i => ({ value: i.value, script: i.script })),
  ];
  revealTx.inputs[0].witness = signTaprootScriptPathInputWithKey(revealTx, prevouts, envelopeScript, cb, signerPriv, 0);
  extraRevealInputs.forEach((inp, k) => {
    revealTx.inputs[k + 1].witness = signP2wpkhInputWithKey(revealTx, k + 1, inp.value, inp.priv, inp.pub);
  });
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = computeTxid(revealTx);

  const post = async (hex, label) => {
    const r = await fetch(`${mempoolApi}/tx`, { method: 'POST', body: hex });
    const b = await r.text();
    if (!r.ok) throw new Error(`${label} broadcast ${r.status}: ${b}`);
    return b.trim();
  };
  await post(commitHex, 'commit');
  // On mainnet the reveal can outrun the commit's propagation across mempool.space
  // nodes (bad-txns-inputs-missingorspent). Retry with backoff until the commit
  // is visible to the node serving the reveal.
  let revealErr = null;
  for (let i = 0; i < 18; i++) {
    try { await post(revealHex, 'reveal'); revealErr = null; break; }
    catch (e) { revealErr = e; await new Promise(r => setTimeout(r, 5000)); }
  }
  if (revealErr) throw revealErr;
  return { commitTxid, revealTxid, revealHex, commitHex };
}

export { secp };
