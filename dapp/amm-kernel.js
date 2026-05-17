// Kernel-message + kernel-signature construction for AMM LP envelopes —
// dapp-side port of tests/amm-kernel.mjs. Byte-for-byte identical math.
//
// Per AMM.md §"Kernel-msg construction":
//   T_LP_ADD: two kernel sigs (one per asset side, A and B). Each proves:
//     • The LP knows Σᵢ r_in_secp,X,i (sum of input blindings on asset X side).
//     • The consumed inputs on asset X net to EXACTLY delta_X · H of asset value.
//       Signing under (Σᵢ C_in_secp,X,i − delta_X · H_secp).x_only() works iff
//       the residue is a pure G-term whose discrete log is excess_X.
//   T_LP_REMOVE: one kernel sig on the consumed lp_asset_id UTXO(s):
//     (Σᵢ C_in_secp,LP,i − share_amount · H_secp).x_only()

import { secp, sha256, hexToBytes, bytesToHex, concatBytes } from './vendor/tacit-deps.min.js';
import {
  G, H, ZERO, SECP_N, modN, bigintToBytes32,
  signSchnorr, verifySchnorr,
} from './bulletproofs.js';

const DOMAIN_LP_ADD    = new TextEncoder().encode('tacit-amm-lp-add-v1');
const DOMAIN_LP_REMOVE = new TextEncoder().encode('tacit-amm-lp-remove-v1');

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes`);
  return b;
}
function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }
function u64LE(n) {
  const buf = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}
function outpointBytes(op) {
  const txidBE = reverseBytes(hexToBytes(op.txid));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, op.vout >>> 0, true);
  return concatBytes(txidBE, voutLE);
}

// ============== T_LP_ADD ==============

export function lpAddKernelMsg({
  variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX,
}) {
  if (variant !== 0 && variant !== 1) throw new Error('variant must be 0 or 1');
  const pid = asBytes(poolId, 32, 'poolId');
  const aid = asBytes(assetX, 32, 'assetX');
  const csc = asBytes(shareCSecpBytes, 33, 'shareCSecpBytes');
  if (!Array.isArray(inputsX) || inputsX.length === 0) throw new Error('inputsX must be non-empty array');
  if (inputsX.length > 255) throw new Error('too many inputs');
  const parts = [
    DOMAIN_LP_ADD,
    new Uint8Array([variant]),
    pid, aid,
    u64LE(deltaX),
    u64LE(shareAmount),
    csc,
    new Uint8Array([inputsX.length]),
  ];
  for (const op of inputsX) parts.push(outpointBytes(op));
  return sha256(concatBytes(...parts));
}

export function lpAddKernelKey({ inputCommitments, deltaX }) {
  if (!Array.isArray(inputCommitments) || inputCommitments.length === 0) {
    throw new Error('inputCommitments must be non-empty');
  }
  let sum = ZERO;
  for (const C of inputCommitments) {
    const Cp = C instanceof secp.ProjectivePoint ? C : secp.ProjectivePoint.fromHex(C instanceof Uint8Array ? bytesToHex(C) : C);
    sum = sum.add(Cp);
  }
  const d = BigInt(deltaX);
  if (d < 0n || d >= 1n << 64n) throw new Error('delta out of u64 range');
  const dH = d === 0n ? ZERO : H.multiply(d);
  const E = sum.add(dH.negate());
  if (E.equals(ZERO)) throw new Error('kernel key collapsed to identity');
  const Ebytes = E.toRawBytes(true);
  return { xOnly: Ebytes.slice(1), point: E, prefix: Ebytes[0] };
}

export function lpAddKernelSign({
  variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX,
  inputCommitments, excessX,
}) {
  const msg = lpAddKernelMsg({ variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX });
  const { prefix } = lpAddKernelKey({ inputCommitments, deltaX });
  let d = modN(excessX);
  if (prefix === 0x03) d = modN(SECP_N - d);
  return signSchnorr(msg, bigintToBytes32(d));
}

export function lpAddKernelVerify({
  variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX,
  inputCommitments, sig64,
}) {
  const msg = lpAddKernelMsg({ variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX });
  let key;
  try { key = lpAddKernelKey({ inputCommitments, deltaX }); }
  catch { return false; }
  return verifySchnorr(sig64, msg, key.xOnly);
}

// ============== T_LP_REMOVE ==============

export function lpRemoveKernelMsg({
  poolId, shareAmount, deltaA, deltaB, recvACSecpBytes, recvBCSecpBytes, lpInputs,
}) {
  const pid = asBytes(poolId, 32, 'poolId');
  const csA = asBytes(recvACSecpBytes, 33, 'recvACSecpBytes');
  const csB = asBytes(recvBCSecpBytes, 33, 'recvBCSecpBytes');
  if (!Array.isArray(lpInputs) || lpInputs.length === 0) throw new Error('lpInputs must be non-empty');
  if (lpInputs.length > 255) throw new Error('too many lp inputs');
  const parts = [
    DOMAIN_LP_REMOVE,
    pid,
    u64LE(shareAmount),
    u64LE(deltaA),
    u64LE(deltaB),
    csA, csB,
    new Uint8Array([lpInputs.length]),
  ];
  for (const op of lpInputs) parts.push(outpointBytes(op));
  return sha256(concatBytes(...parts));
}

export function lpRemoveKernelKey({ lpInputCommitments, shareAmount }) {
  if (!Array.isArray(lpInputCommitments) || lpInputCommitments.length === 0) {
    throw new Error('lpInputCommitments must be non-empty');
  }
  let sum = ZERO;
  for (const C of lpInputCommitments) {
    const Cp = C instanceof secp.ProjectivePoint ? C : secp.ProjectivePoint.fromHex(C instanceof Uint8Array ? bytesToHex(C) : C);
    sum = sum.add(Cp);
  }
  const sH = H.multiply(BigInt(shareAmount));
  const E = sum.add(sH.negate());
  if (E.equals(ZERO)) throw new Error('kernel key collapsed to identity');
  const Ebytes = E.toRawBytes(true);
  return { xOnly: Ebytes.slice(1), point: E, prefix: Ebytes[0] };
}

export function lpRemoveKernelSign({
  poolId, shareAmount, deltaA, deltaB, recvACSecpBytes, recvBCSecpBytes, lpInputs,
  lpInputCommitments, excessLP,
}) {
  const msg = lpRemoveKernelMsg({ poolId, shareAmount, deltaA, deltaB, recvACSecpBytes, recvBCSecpBytes, lpInputs });
  const { prefix } = lpRemoveKernelKey({ lpInputCommitments, shareAmount });
  let d = modN(excessLP);
  if (prefix === 0x03) d = modN(SECP_N - d);
  return signSchnorr(msg, bigintToBytes32(d));
}

export function lpRemoveKernelVerify({
  poolId, shareAmount, deltaA, deltaB, recvACSecpBytes, recvBCSecpBytes, lpInputs,
  lpInputCommitments, sig64,
}) {
  const msg = lpRemoveKernelMsg({ poolId, shareAmount, deltaA, deltaB, recvACSecpBytes, recvBCSecpBytes, lpInputs });
  let key;
  try { key = lpRemoveKernelKey({ lpInputCommitments, shareAmount }); }
  catch { return false; }
  return verifySchnorr(sig64, msg, key.xOnly);
}
