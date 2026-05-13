// Kernel-message + kernel-signature construction for AMM LP envelopes.
//
// Per AMM.md §"Kernel-msg construction" (§2 of Implementation specification).
//
// T_LP_ADD: two kernel sigs (one per asset side, A and B). Each proves:
//   • The LP knows Σᵢ r_in_secp,X,i (sum of input blindings on asset X side).
//   • The consumed inputs on asset X net to EXACTLY delta_X · H of asset value
//     (Mimblewimble-style balance check: signing under
//     (Σᵢ C_in_secp,X,i − delta_X · H_secp).x_only() works iff the residue is
//     a pure G-term whose discrete log is excess_X).
//
// T_LP_REMOVE: one kernel sig on the consumed lp_asset_id UTXO(s):
//   (Σᵢ C_in_secp,LP,i − share_amount · H_secp).x_only()

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, bigintToBytes32, bytes32ToBigint,
} from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';

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
function u16LE(n) {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, n & 0xffff, true);
  return buf;
}
function outpointBytes(op) {
  const txidBE = reverseBytes(hexToBytes(op.txid));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, op.vout >>> 0, true);
  return concatBytes(txidBE, voutLE);
}

// ---- T_LP_ADD kernel-msg ----
//
// kernel_msg_X = SHA256(
//   "tacit-amm-lp-add-v1" || variant(1) || pool_id(32) || asset_X(32)
//   || delta_X_LE(8) || share_amount_LE(8) || share_C_secp(33)
//   || in_count_X(1) || (in_txid_BE(32) || in_vout_LE(4))*in_count_X
// )
export function lpAddKernelMsg({
  variant,            // 0 = standard, 1 = POOL_INIT
  poolId,             // 32 bytes
  assetX,             // 32 bytes (asset_A or asset_B, matching this sig's side)
  deltaX,             // bigint, > 0
  shareAmount,        // bigint, > 0
  shareCSecpBytes,    // 33-byte compressed Pedersen commitment of share_amount
  inputsX,            // [{ txid: hex, vout: number }, ...]  asset-X side input UTXOs
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

// Compute the verification key for the LP_ADD kernel sig on asset X:
//   key_X = (Σᵢ C_in_secp,X,i − delta_X · H_secp).x_only()
// Returns the x-only 32-byte pubkey AND the ProjectivePoint (for prover use).
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

// Sign the LP_ADD kernel sig on side X with excess_X = Σ r_in_secp,X,i.
// Adjusts excess parity so the signing key matches the x-only pubkey computed
// above (BIP-340: even-y privkey).
export function lpAddKernelSign({
  variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX,
  inputCommitments, excessX, // sum of input blindings on side X (bigint)
}) {
  const msg = lpAddKernelMsg({ variant, poolId, assetX, deltaX, shareAmount, shareCSecpBytes, inputsX });
  const { prefix } = lpAddKernelKey({ inputCommitments, deltaX });
  let d = modN(excessX);
  // BIP-340 requires the signing privkey corresponds to an even-y pubkey.
  // If the pubkey is odd-y (compressed prefix 0x03), negate the privkey.
  if (prefix === 0x03) d = modN(SECP_N - d);
  return signSchnorr(msg, bigintToBytes32(d));
}

// Verify an LP_ADD kernel sig.
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

// ---- T_LP_REMOVE kernel-msg ----
//
// kernel_msg_LP = SHA256(
//   "tacit-amm-lp-remove-v1" || pool_id(32) || share_amount_LE(8)
//   || delta_A_LE(8) || delta_B_LE(8) || recv_A_C_secp(33) || recv_B_C_secp(33)
//   || lp_in_count(1) || (lp_in_txid_BE(32) || lp_in_vout_LE(4))*lp_in_count
// )
export function lpRemoveKernelMsg({
  poolId,
  shareAmount,
  deltaA,
  deltaB,
  recvACSecpBytes,
  recvBCSecpBytes,
  lpInputs,
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

// LP_REMOVE kernel key: (Σᵢ C_in_secp,LP,i − share_amount · H_secp).x_only()
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
