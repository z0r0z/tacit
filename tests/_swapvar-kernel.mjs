// Shared swap_var KERNEL signer for the reflection fixtures + fold tests. The dapp only ever VERIFIES the
// kernel (confidential-pool.js swapVarKernelVerify) — a taker's wallet produces it — so the signer lives in
// test code. These helpers build the exact message the guest/JS verify and sign it with the input blinding
// r_in. Message: domain ‖ asset ‖ 1 ‖ txid ‖ vout_le ‖ 1 ‖ c_change_or_sentinel(33) ‖ delta_in_total_le.
// Sentinel-change case: C_change = identity, so the verify key is P = C_in − delta_in_total·H = r_in·G.

import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const G = secp.ProjectivePoint.BASE, N = secp.CURVE.n;
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const taggedHash = (tag, msg) => { const th = sha256(new TextEncoder().encode(tag)); return sha256(_cat([th, th, msg])); };

// BIP-340 sign with private scalar d (even-y key/nonce) — matches confidential-pool verifySchnorr.
export function bip340Sign(msg, dIn) {
  let d = dIn % N; if (d === 0n) throw new Error('zero key');
  if (G.multiply(d).toAffine().y & 1n) d = N - d;
  const Px = be(G.multiply(d).toAffine().x);
  let k = bytesToBig(sha256(_cat([be(d), msg]))) % N; if (k === 0n) k = 1n;
  if (G.multiply(k).toAffine().y & 1n) k = N - k;
  const Rx = be(G.multiply(k).toAffine().x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', _cat([Rx, Px, msg]))) % N;
  return _cat([Rx, be((k + e * d) % N)]);
}

// The kernel message (asset/txid as 0x-hex; cChangeBytes = the 33-byte c_change, all-zero for sentinel).
export function swapVarKernelMsg(assetHex, txidHex, vout, cChangeBytes, deltaInTotal) {
  return sha256(_cat([new TextEncoder().encode('tacit-kernel-v1'), hb(assetHex), Uint8Array.of(1), hb(txidHex), u32le(vout), Uint8Array.of(1), cChangeBytes, u64le(deltaInTotal)]));
}

// A kernel sig over the message, signed with the input blinding r_in (sentinel case). Returns the 64-byte sig.
export function swapVarKernelSig({ assetHex, txidHex, vout, cChangeBytes, deltaInTotal, rIn }) {
  return bip340Sign(swapVarKernelMsg(assetHex, txidHex, vout, cChangeBytes, deltaInTotal), rIn);
}

// LP-remove share-burn kernel: msg = domain ‖ pool_id ‖ share_amount_LE ‖ delta_a_LE ‖ delta_b_LE ‖
// recv_a_secp(33) ‖ recv_b_secp(33) ‖ n_inputs ‖ (txid ‖ vout_LE)* — signed with the burned LP-shares' total
// blinding r_total (verify key P = Σ C_in_LP − share_amount·H = r_total·G).
export function lpRemoveKernelMsg({ poolIdHex, shareAmount, deltaA, deltaB, recvAHex, recvBHex, lpOutpoints }) {
  const parts = [new TextEncoder().encode('tacit-amm-lp-remove-v1'), hb(poolIdHex), u64le(shareAmount), u64le(deltaA), u64le(deltaB), hb(recvAHex), hb(recvBHex), Uint8Array.of(lpOutpoints.length & 0xff)];
  for (const [txidHex, vout] of lpOutpoints) { parts.push(hb(txidHex)); parts.push(u32le(vout)); }
  return sha256(_cat(parts));
}
export function lpRemoveKernelSig(opts, rTotal) { return bip340Sign(lpRemoveKernelMsg(opts), rTotal); }

// LP-add per-asset kernel: msg = domain ‖ variant ‖ pool_id ‖ asset_x ‖ delta_x_LE ‖ share_amount_LE ‖
// share_csecp(33) ‖ n_inputs ‖ (txid ‖ vout_LE)* — signed with the asset-X inputs' total blinding r_x
// (verify key P = Σ C_in_x − delta_x·H = r_x·G).
export function lpAddKernelMsg({ variant, poolIdHex, assetXHex, deltaX, shareAmount, shareCsecpHex, inputs }) {
  const parts = [new TextEncoder().encode('tacit-amm-lp-add-v1'), Uint8Array.of(variant & 0xff), hb(poolIdHex), hb(assetXHex), u64le(deltaX), u64le(shareAmount), hb(shareCsecpHex), Uint8Array.of(inputs.length & 0xff)];
  for (const [txidHex, vout] of inputs) { parts.push(hb(txidHex)); parts.push(u32le(vout)); }
  return sha256(_cat(parts));
}
export function lpAddKernelSig(opts, rX) { return bip340Sign(lpAddKernelMsg(opts), rX); }
