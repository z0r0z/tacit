// T_SWAP_VAR (opcode 0x32) reference implementation.
//
// Per-trade variable-amount AMM swap. Spec: SPEC-SWAP-VAR-AMENDMENT.md.
//
// Cryptographic reuse with T_AXFER_VAR (§5.7.9):
//   - Same `tacit-kernel-v1` domain tag.
//   - Same single-asset excess-scalar kernel-sig closure shape:
//       P = C_change_or_sentinel − C_in_secp + delta_in_total · H_secp
//   - Same m=2 aggregated bulletproof wire format over
//     (C_change_or_sentinel, C_receipt_secp).
//
// Differences from T_AXFER_VAR worth calling out:
//   - kernel_msg lists ONE output commit (the asset-A change); the
//     cross-asset receipt is bound out-of-kernel via intent_sig +
//     a directly-published r_receipt opening check.
//   - delta_in_total occupies the slot T_AXFER_VAR uses for burned_amount.
//   - The receipt commit's binding to delta_out is INSIDE the validator,
//     via r_receipt — this closes the inflation gap surfaced in the
//     same-day P0 crypto fix (AMENDMENTS.md 2026-05-15 changelog entry).
//
// NO Groth16 in this opcode; curve recompute is pure indexer arithmetic.
//
// Public surface:
//   - Wire encoder/decoder: encodeSwapVar / decodeSwapVar
//   - Message builders: buildSwapVarIntentMsg / buildSwapVarKernelMsg
//   - HMAC derivations: deriveSwapVarReceiptScalar / deriveSwapVarChangeScalar /
//                       deriveSwapVarTipScalar / deriveSwapVarReceiptPubkey
//   - Curve: curveDeltaOut (single-trade against-curve recompute, u256)
//   - Tick-fan: buildTickFan (K log-spaced ticks ∈ [Δmin, Δmax])
//   - Validator: validateSwapVar (mirrors §"Indexer validation algorithm")

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN, pedersenCommit, pointToBytes,
} from './bulletproofs.mjs';
import {
  signSchnorr, verifySchnorr, computeKernelMsg,
} from './composition.mjs';

// =========================================================================
// Constants — opcode, version, sentinels, domain tags
// =========================================================================

export const OPCODE_T_SWAP_VAR = 0x32;
export const ENVELOPE_VERSION = 0x01;

// 33-byte all-zero sentinel for the no-change case. NOT a valid SEC1
// encoding — implementations MUST special-case BEFORE invoking the secp
// decoder. Verifier substitutes the additive identity (point at infinity)
// in the kernel-sig closure.
export const NO_CHANGE_SENTINEL = new Uint8Array(33); // all zeros

// BIP-340 / HMAC domain tags introduced by this amendment.
const DOMAIN_INTENT       = new TextEncoder().encode('tacit-amm-swap-var-v1');
const DOMAIN_RECEIPT_BLIND = new TextEncoder().encode('tacit-amm-swap-var-receipt-v1');
const DOMAIN_RECEIPT_PK    = new TextEncoder().encode('tacit-amm-swap-var-recv-v1');
const DOMAIN_CHANGE_BLIND  = new TextEncoder().encode('tacit-amm-swap-var-change-v1');
const DOMAIN_TIP_BLIND     = new TextEncoder().encode('tacit-amm-swap-var-tip-v1');

// =========================================================================
// Helpers
// =========================================================================

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}
function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }
function u32LE(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function u64LE(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function u16LE(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function readU32LE(b, o) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true) >>> 0; }
function readU64LE(b, o) {
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(b[o + i]) << BigInt(i * 8);
  return n;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function isNoChangeSentinel(b) {
  if (!(b instanceof Uint8Array) || b.length !== 33) return false;
  for (let i = 0; i < 33; i++) if (b[i] !== 0) return false;
  return true;
}
function bytesToBigintBE(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}
function canonicalOutpoint(txidHex, vout) {
  const txid_BE = reverseBytes(asBytes(txidHex, 32, 'txid'));
  return concatBytes(txid_BE, u32LE(vout));
}

// =========================================================================
// HMAC derivations
// =========================================================================

// Per §"Receipt-address blinding". r_receipt is published on chain
// alongside the envelope so the indexer can directly verify
// C_receipt_secp opens to delta_out.
//
// Note: derivation is tick-INDEPENDENT — the trader anchors on
// (pool_id, asset_input_outpoint), which are fixed across a tick-fan.
// The same r_receipt scalar works for every K candidate Δ.
export function deriveSwapVarReceiptScalar({ traderPrivkey, poolId, assetInputOutpoint }) {
  const sk = asBytes(traderPrivkey, 32, 'traderPrivkey');
  const pid = asBytes(poolId, 32, 'poolId');
  if (!(assetInputOutpoint instanceof Uint8Array) || assetInputOutpoint.length !== 36) {
    throw new Error('assetInputOutpoint must be 36 bytes (txid_BE || vout_LE)');
  }
  const seed = hmac(sha256, sk, concatBytes(DOMAIN_RECEIPT_BLIND, pid, assetInputOutpoint));
  return modN(bytesToBigintBE(seed));
}

// Per §"Receipt-address blinding". Used to derive the P2WPKH that
// receives the asset-B receipt UTXO. The trader recovers the pubkey
// via the same seed at wallet restore time.
export function deriveSwapVarReceiptPubkey({ traderPrivkey, poolId, assetInputOutpoint }) {
  const sk = asBytes(traderPrivkey, 32, 'traderPrivkey');
  const pid = asBytes(poolId, 32, 'poolId');
  if (!(assetInputOutpoint instanceof Uint8Array) || assetInputOutpoint.length !== 36) {
    throw new Error('assetInputOutpoint must be 36 bytes');
  }
  const seed = hmac(sha256, sk, concatBytes(DOMAIN_RECEIPT_PK, pid, assetInputOutpoint));
  // Use the seed as a child privkey (mod n, rejection-sample = 1 if 0).
  let child = bytesToBigintBE(seed) % SECP_N;
  if (child === 0n) child = 1n;
  const pubPt = G.multiply(child);
  return {
    privkey: numberToBytes32(child),
    pubkey:  pointToBytes(pubPt), // 33-byte compressed
  };
}

// Tick-INDEPENDENT change blinding. Same anchor as r_receipt; lives in
// its own domain. Stays constant across a K-tick fan so the kernel sig's
// excess scalar (r_change − r_in) is also tick-independent.
export function deriveSwapVarChangeScalar({ traderPrivkey, poolId, assetInputOutpoint }) {
  const sk = asBytes(traderPrivkey, 32, 'traderPrivkey');
  const pid = asBytes(poolId, 32, 'poolId');
  if (!(assetInputOutpoint instanceof Uint8Array) || assetInputOutpoint.length !== 36) {
    throw new Error('assetInputOutpoint must be 36 bytes');
  }
  const seed = hmac(sha256, sk, concatBytes(DOMAIN_CHANGE_BLIND, pid, assetInputOutpoint));
  return modN(bytesToBigintBE(seed));
}

// Settler-side tip blinding. Settler derives this from their privkey +
// the envelope's asset_input_outpoint (which the settler observes when
// assembling the tx). Domain mirrors T_SWAP_BATCH's tip-blinding scheme.
export function deriveSwapVarTipScalar({ settlerPrivkey, poolId, assetInputOutpoint }) {
  const sk = asBytes(settlerPrivkey, 32, 'settlerPrivkey');
  const pid = asBytes(poolId, 32, 'poolId');
  if (!(assetInputOutpoint instanceof Uint8Array) || assetInputOutpoint.length !== 36) {
    throw new Error('assetInputOutpoint must be 36 bytes');
  }
  const seed = hmac(sha256, sk, concatBytes(DOMAIN_TIP_BLIND, pid, assetInputOutpoint));
  return modN(bytesToBigintBE(seed));
}

function numberToBytes32(n) {
  if (typeof n !== 'bigint') n = BigInt(n);
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

// =========================================================================
// AMM curve — single-trade against-curve recompute
// =========================================================================
//
// Per §"Indexer validation algorithm" curve recompute. Uses BigInt
// (u256 equivalent) to avoid overflow when (R · γ · Δ) products are
// computed. Returns u64 delta_out (floor division).
//
// Throws if any reserve or delta is out of u64 range. Throws if the
// post-state would have a non-positive reserve (curve construction
// makes this impossible for positive Δ_in, but defensive).
export function curveDeltaOut({ direction, R_A_pre, R_B_pre, delta_in, fee_bps }) {
  const ra = BigInt(R_A_pre);
  const rb = BigInt(R_B_pre);
  const din = BigInt(delta_in);
  const fbps = BigInt(fee_bps);
  if (ra <= 0n || rb <= 0n) throw new Error('reserves must be > 0');
  if (din <= 0n) throw new Error('delta_in must be > 0');
  if (fbps < 0n || fbps > 1000n) throw new Error('fee_bps must be in [0, 1000]');
  if (ra >= 1n << 64n || rb >= 1n << 64n || din >= 1n << 64n) throw new Error('values must fit u64');

  const gNum = 10000n - fbps;
  const gDen = 10000n;

  let num, den, deltaOut, raPost, rbPost;
  if (direction === 0) {                            // A → B
    num = rb * gNum * din;
    den = ra * gDen + gNum * din;
    deltaOut = num / den;                            // floor
    raPost = ra + din;
    rbPost = rb - deltaOut;
  } else if (direction === 1) {                     // B → A
    num = ra * gNum * din;
    den = rb * gDen + gNum * din;
    deltaOut = num / den;
    raPost = ra - deltaOut;
    rbPost = rb + din;
  } else {
    throw new Error('direction must be 0 or 1');
  }
  if (deltaOut >= 1n << 64n) throw new Error('delta_out overflows u64');
  if (raPost <= 0n || rbPost <= 0n) throw new Error('post-reserve non-positive');
  // Reserve overflow check — Uniswap V2 caps at uint112, tacit spec says
  // u64. After many swaps + LP_ADDs, post-reserves could exceed u64;
  // future swaps' R_pre would then fail decode and the pool gets stuck.
  if (raPost >= 1n << 64n) throw new Error('post-reserve_A overflows u64');
  if (rbPost >= 1n << 64n) throw new Error('post-reserve_B overflows u64');
  return { deltaOut, raPost, rbPost };
}

// =========================================================================
// Tick-fan schedule
// =========================================================================
//
// Per §"Tick-fan coordination layer" (AMENDMENTS.md 2026-05-15 entry).
// K ∈ {2, 4, 8, 16} log-spaced ticks across [delta_in_min, delta_in_max].
// On-chain wire format is byte-identical to a single-Δ broadcast; the
// fan is purely off-chain coordination. Tick-independent fields
// (r_receipt, r_change, excess, asset_input_outpoint) are shared across
// the K candidates; per-tick fields are
// (delta_in_k, delta_out_k, C_change_k, C_receipt_k, bulletproof_k,
//  intent_sig_k).
//
// Tick spacing formula matches AMENDMENTS.md changelog: each k is
//   tick[k] = floor(Δmin · (Δmax/Δmin)^(k/(K-1)))
// for k ∈ [0, K). K = 1 collapses to a single-Δ self-broadcast.
export function buildTickFan({ deltaInMin, deltaInMax, K }) {
  if (![1, 2, 4, 8, 16].includes(K)) throw new Error('K must be ∈ {1,2,4,8,16}');
  const dMin = BigInt(deltaInMin);
  const dMax = BigInt(deltaInMax);
  if (dMin <= 0n) throw new Error('deltaInMin must be > 0');
  if (dMax < dMin) throw new Error('deltaInMax must be >= deltaInMin');
  if (K === 1) return [dMin];                       // single-Δ self-broadcast
  // Geometric spacing in log space via Math.pow on doubles, then floor.
  // For Δs in the u64 range this stays well within double precision; the
  // exact endpoints are pinned to dMin / dMax to avoid rounding drift.
  const ticks = new Array(K);
  const lo = Number(dMin);
  const hi = Number(dMax);
  for (let k = 0; k < K; k++) {
    if (k === 0) ticks[k] = dMin;
    else if (k === K - 1) ticks[k] = dMax;
    else {
      const f = k / (K - 1);
      const v = Math.floor(lo * Math.pow(hi / lo, f));
      ticks[k] = BigInt(v);
    }
  }
  // Enforce strict monotonic increasing (collapse equal ticks); guards
  // against double-precision rounding leaving two adjacent ticks equal
  // for very narrow [Δmin, Δmax] ranges.
  for (let k = 1; k < K; k++) {
    if (ticks[k] <= ticks[k - 1]) ticks[k] = ticks[k - 1] + 1n;
    if (ticks[k] > dMax) ticks[k] = dMax;
  }
  return ticks;
}

// =========================================================================
// Intent-msg construction
// =========================================================================

// Per §"Intent-msg construction". Returns the 32-byte SHA-256 hash
// the trader signs with BIP-340.
export function buildSwapVarIntentMsg({
  poolId, direction, deltaIn, deltaInMin, deltaInMax, deltaOut,
  minOut, tipAmount, tipAsset, expiryHeight, traderPubkey,
  assetInputOutpoint, receiveScriptPubKey,
  cReceiptSecp, cChangeOrSentinel,
}) {
  const pid = asBytes(poolId, 32, 'poolId');
  if (direction !== 0 && direction !== 1) throw new Error('direction must be 0|1');
  if (tipAsset !== 0 && tipAsset !== 1) throw new Error('tipAsset must be 0|1');
  const tpk = asBytes(traderPubkey, 33, 'traderPubkey');
  if (!(assetInputOutpoint instanceof Uint8Array) || assetInputOutpoint.length !== 36) {
    throw new Error('assetInputOutpoint must be 36 bytes');
  }
  if (!(receiveScriptPubKey instanceof Uint8Array)) {
    throw new Error('receiveScriptPubKey must be Uint8Array');
  }
  if (receiveScriptPubKey.length > 0xffff) {
    throw new Error('receiveScriptPubKey too large (> 65535)');
  }
  const crs = asBytes(cReceiptSecp, 33, 'cReceiptSecp');
  const cco = asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel');

  return sha256(concatBytes(
    DOMAIN_INTENT,
    pid,
    new Uint8Array([direction]),
    u64LE(deltaIn), u64LE(deltaInMin), u64LE(deltaInMax),
    u64LE(deltaOut), u64LE(minOut), u64LE(tipAmount),
    new Uint8Array([tipAsset]),
    u32LE(expiryHeight),
    tpk,
    assetInputOutpoint,
    u16LE(receiveScriptPubKey.length),
    receiveScriptPubKey,
    crs,
    cco,
  ));
}

// =========================================================================
// Kernel-msg construction
// =========================================================================

// Per §"Kernel-msg construction" — single-asset closure over the
// trader's asset-A side. Reuses composition.mjs `computeKernelMsg`
// helper (same `tacit-kernel-v1` domain tag, same byte layout) so this
// shares production code paths with CXFER + T_AXFER_VAR.
//
// `cChangeOrSentinel` is the trader's published change commitment OR
// the 33-byte all-zero NO_CHANGE_SENTINEL. The verifier substitutes
// the additive identity for the sentinel before computing
// (C_change − C_in + delta_in_total · H).
//
// delta_in_total = delta_in + tip_amount. This is the cleartext
// outflow from the trader's commit space (to pool + settler tip).
// Occupies the kernel_msg slot T_AXFER_VAR uses for burned_amount.
export function buildSwapVarKernelMsg({
  assetIdIn, assetInputOutpointTxid, assetInputOutpointVout,
  cChangeOrSentinel, deltaInTotal,
}) {
  // computeKernelMsg signature: (assetId, inputOutpoints, outputCommitments, burnedAmount).
  // T_SWAP_VAR puts the change commit (or sentinel) in the single-output slot
  // and delta_in_total in the burned slot.
  return computeKernelMsg(
    asBytes(assetIdIn, 32, 'assetIdIn'),
    [{ txid: assetInputOutpointTxid, vout: assetInputOutpointVout }],
    [asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel')],
    BigInt(deltaInTotal),
  );
}

// Compute the BIP-340 verification key for the kernel sig:
//   P = C_change_or_sentinel − C_in_secp + delta_in_total · H_secp
// then take its x-only form. For the sentinel case, substitute the
// point at infinity (= ZERO in the secp library) before the equation.
export function kernelVerifyPoint({ cChangeOrSentinel, cInSecp, deltaInTotal }) {
  const cIn = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cInSecp, 33, 'cInSecp')));
  let cChange;
  if (isNoChangeSentinel(cChangeOrSentinel)) {
    cChange = ZERO;
  } else {
    cChange = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel')));
  }
  const dit = BigInt(deltaInTotal);
  const ditH = dit === 0n ? ZERO : H.multiply(dit);
  return cChange.add(cIn.negate()).add(ditH);
}

// Helper: convert hex-utility format
function bytesToHex(b) {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
  return out;
}

// =========================================================================
// Wire-format encoder/decoder
// =========================================================================

// Returns the envelope payload bytes (without the OP_RETURN wrapping).
// envelope_hash = SHA256(payload) is computed by the caller.
export function encodeSwapVar(env) {
  const {
    poolId, direction, R_A_pre, R_B_pre,
    deltaIn, deltaInMin, deltaInMax, deltaOut, minOut, tipAmount, tipAsset,
    expiryHeight, traderPubkey, cInSecp, cChangeOrSentinel, cReceiptSecp,
    rReceipt, rangeProof, kernelSig, intentSig,
  } = env;

  const parts = [
    new Uint8Array([OPCODE_T_SWAP_VAR]),
    asBytes(poolId, 32, 'poolId'),
    new Uint8Array([direction & 0xff]),
    u64LE(R_A_pre), u64LE(R_B_pre),
    u64LE(deltaIn), u64LE(deltaInMin), u64LE(deltaInMax),
    u64LE(deltaOut), u64LE(minOut), u64LE(tipAmount),
    new Uint8Array([tipAsset & 0xff]),
    u32LE(expiryHeight),
    asBytes(traderPubkey, 33, 'traderPubkey'),
    asBytes(cInSecp, 33, 'cInSecp'),
    asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel'),
    asBytes(cReceiptSecp, 33, 'cReceiptSecp'),
    asBytes(rReceipt, 32, 'rReceipt'),
  ];
  // range_proof is variable-length (bulletproof aggregated m=2). Prefix with u16 LE.
  if (!(rangeProof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (rangeProof.length > 0xffff) throw new Error('rangeProof too large (> 65535)');
  parts.push(u16LE(rangeProof.length), rangeProof);
  parts.push(asBytes(kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(intentSig, 64, 'intentSig'));
  return concatBytes(...parts);
}

export function decodeSwapVar(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  let o = 0;
  function take(n, name) {
    if (o + n > payload.length) throw new Error(`decode: truncated at ${name} (need ${n}, have ${payload.length - o})`);
    const s = payload.subarray(o, o + n);
    o += n;
    return s;
  }
  const opcode = take(1, 'opcode')[0];
  if (opcode !== OPCODE_T_SWAP_VAR) throw new Error(`bad opcode: ${opcode}`);
  const poolId = new Uint8Array(take(32, 'poolId'));
  const direction = take(1, 'direction')[0];
  if (direction !== 0 && direction !== 1) throw new Error(`bad direction: ${direction}`);
  const R_A_pre = readU64LE(payload, o); o += 8;
  const R_B_pre = readU64LE(payload, o); o += 8;
  const deltaIn = readU64LE(payload, o); o += 8;
  const deltaInMin = readU64LE(payload, o); o += 8;
  const deltaInMax = readU64LE(payload, o); o += 8;
  const deltaOut = readU64LE(payload, o); o += 8;
  const minOut = readU64LE(payload, o); o += 8;
  const tipAmount = readU64LE(payload, o); o += 8;
  const tipAsset = take(1, 'tipAsset')[0];
  if (tipAsset !== 0 && tipAsset !== 1) throw new Error(`bad tipAsset: ${tipAsset}`);
  const expiryHeight = readU32LE(payload, o); o += 4;
  const traderPubkey = new Uint8Array(take(33, 'traderPubkey'));
  const cInSecp = new Uint8Array(take(33, 'cInSecp'));
  const cChangeOrSentinel = new Uint8Array(take(33, 'cChangeOrSentinel'));
  const cReceiptSecp = new Uint8Array(take(33, 'cReceiptSecp'));
  const rReceipt = new Uint8Array(take(32, 'rReceipt'));
  const rpLen = (payload[o] | (payload[o + 1] << 8)) >>> 0; o += 2;
  const rangeProof = new Uint8Array(take(rpLen, 'rangeProof'));
  const kernelSig = new Uint8Array(take(64, 'kernelSig'));
  const intentSig = new Uint8Array(take(64, 'intentSig'));
  if (o !== payload.length) throw new Error(`trailing bytes after intentSig: ${payload.length - o}`);
  return {
    opcode, poolId, direction,
    R_A_pre, R_B_pre,
    deltaIn, deltaInMin, deltaInMax, deltaOut, minOut, tipAmount, tipAsset,
    expiryHeight, traderPubkey,
    cInSecp, cChangeOrSentinel, cReceiptSecp,
    rReceipt, rangeProof, kernelSig, intentSig,
  };
}

export function computeSwapVarEnvelopeHash(payload) {
  return sha256(payload);
}

// =========================================================================
// Validator — mirrors SPEC.md §5.20 "Validator algorithm (outcome taxonomy)"
// =========================================================================
//
// Every confirmed T_SWAP_VAR resolves to exactly one outcome:
//   INVALID      — Stage-A authentication failure (sigs, bindings, proof,
//                  decode). No tacit credit anywhere; vin[1]'s value chain
//                  ends. Unreachable for a correct builder — every Stage-A
//                  gate is over data the builder controls at sign time.
//   EXECUTE      — market-order fill at the pool's ACTUAL running reserves,
//                  floor-bounded by the trader's signed min_out.
//   PASS-THROUGH — authenticated but non-executable (floor miss, expiry,
//                  unknown pool, range/arithmetic bounds…). Pool state is
//                  unchanged; the trader's input refunds at the receipt
//                  slot (input asset, delta_in + tip_amount).
//
// Result shape:
//   { outcome: 'invalid',     valid: false, reason }
//   { outcome: 'execute',     valid: true, executed: true,
//     deltaOutActual, quotedDeltaOut, newPoolState,
//     receipt: { asset_id, amount, commitment, r_receipt } }
//   { outcome: 'passthrough', valid: true, executed: false, passReason,
//     quotedDeltaOut, newPoolState /* == pool, unchanged */,
//     receipt: { asset_id /* input asset */, amount /* delta_in + tip */,
//                commitment, r_receipt } }
//
// `valid` means "authenticated — the envelope credits something". The
// credited receipt commitment is DERIVED (amount · H + r_receipt · G);
// env.cReceiptSecp is the trader's signed quote and is never the credit
// source. The derivation is the inflation defense: no trader-declared
// receipt value is trusted anywhere (SPEC §5.20 steps 8–10).
//
// Envelopes confirmed below the per-network SWAP_VAR_OUTCOME_ACTIVATION
// height validate under the superseded strict-equality algorithm —
// preserved at this file's pre-2026-06-05 git revision; indexers keep it
// as a frozen legacy branch keyed on confirmation height.
//
// Inputs:
//   payload             : envelope bytes
//   pool                : current pool state { pool_id, asset_A, asset_B,
//                                              reserve_A, reserve_B, fee_bps, ... }
//                         (null/undefined ⇒ pass-through, not invalid)
//   assetInputOutpointTxid / Vout : the outpoint of vin[1] (trader's tacit input)
//   currentHeight       : block height at confirmation
//   opReturnData        : vout[0] OP_RETURN payload (32 bytes; MUST equal envelope_hash)
//   bulletproofVerify   : injected (V_pts, proofBytes) -> bool. Pass the real
//                         bpRangeAggVerify from bulletproofs.mjs in production;
//                         tests can stub.
//   receiveScriptPubKey : the canonical receive_scriptPubKey the trader committed
//                         to in intent_msg. Caller extracts this from vout[1]
//                         on chain (the actual receipt UTXO) and supplies it
//                         here for intent_msg reconstruction.
export function validateSwapVar({
  payload, pool, opReturnData,
  assetInputOutpointTxid, assetInputOutpointVout,
  currentHeight,
  receiveScriptPubKey,
  bulletproofVerify,
  inputCommitment,                // REQUIRED: 33-byte compressed or ProjectivePoint
                                  // — the on-chain Pedersen commit of the trader's
                                  // input UTXO at (assetInputOutpointTxid, Vout).
                                  // Validator checks env.cInSecp matches this.
                                  // Closes the input-side inflation gap (analogous
                                  // to the 2026-05-15 receipt-side fix): without
                                  // this check the kernel-sig closure only binds
                                  // env.cInSecp's H-coefficient relative to
                                  // env.cChange, not to the actual on-chain UTXO
                                  // value — so a trader can claim a fake input
                                  // commit and inflate asset A via env.cChange.
  inputAssetId,                   // REQUIRED: 32-byte asset id of vin[1]'s parent.
                                  // Binds the kernel msg to the input's REAL asset,
                                  // drives the pass-through refund's asset_id, and
                                  // gates executability against the pool's
                                  // direction side. Resolvable without the pool —
                                  // pass-through works even for unknown pools.
}) {
  if (typeof bulletproofVerify !== 'function') {
    throw new Error('validateSwapVar: bulletproofVerify is required');
  }
  if (inputCommitment === undefined) {
    throw new Error(
      'validateSwapVar: inputCommitment is required — pass the on-chain ' +
      'Pedersen commit at (assetInputOutpointTxid, assetInputOutpointVout) ' +
      'so the validator can verify env.cInSecp matches.',
    );
  }
  if (!(inputAssetId instanceof Uint8Array) || inputAssetId.length !== 32) {
    throw new Error(
      'validateSwapVar: inputAssetId is required — pass the 32-byte asset id ' +
      "of vin[1]'s parent (drives kernel-msg reconstruction and the " +
      'pass-through refund asset).',
    );
  }

  // ════════ Stage A — AUTHENTICATION (any failure ⇒ INVALID) ════════

  let env;
  try { env = decodeSwapVar(payload); }
  catch (e) { return { outcome: 'invalid', valid: false, reason: `decode error: ${e.message}` }; }

  // OP_RETURN binding.
  if (!(opReturnData instanceof Uint8Array) || opReturnData.length !== 32) {
    return { outcome: 'invalid', valid: false, reason: 'missing or malformed vout[0] OP_RETURN data' };
  }
  const expectedHash = computeSwapVarEnvelopeHash(payload);
  if (!bytesEqual(opReturnData, expectedHash)) {
    return { outcome: 'invalid', valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }

  // Input-side inflation defense: verify env.cInSecp matches the on-chain
  // Pedersen commit at the cited outpoint. The kernel-sig closure alone
  // binds env.cInSecp's H-coef relative to env.cChange's H-coef
  // (a_in_claimed = a_change_claimed + delta_in_total). It does NOT bind
  // a_in_claimed to the actual on-chain UTXO value. Without this check, a
  // trader can claim a_in_claimed > a_real, mint env.cChange to commit to
  // (a_real + Δ), and inflate asset A by Δ when they spend the change UTXO.
  // Load-bearing for BOTH outcomes — the pass-through refund arithmetic is
  // only sound against the real input value.
  let inputCommitmentBytes;
  if (inputCommitment instanceof Uint8Array) {
    if (inputCommitment.length !== 33) {
      return { outcome: 'invalid', valid: false, reason: 'inputCommitment must be 33-byte compressed point' };
    }
    inputCommitmentBytes = inputCommitment;
  } else if (typeof inputCommitment.toRawBytes === 'function') {
    inputCommitmentBytes = inputCommitment.toRawBytes(true);
  } else {
    return { outcome: 'invalid', valid: false, reason: 'inputCommitment must be ProjectivePoint or Uint8Array(33)' };
  }
  if (!bytesEqual(env.cInSecp, inputCommitmentBytes)) {
    return {
      outcome: 'invalid', valid: false,
      reason: 'env.cInSecp does not match on-chain input UTXO commit at outpoint',
    };
  }

  // r_receipt scalar range — needed for the derived-commitment credit in
  // both non-invalid outcomes.
  const rReceiptScalar = bytesToBigintBE(env.rReceipt);
  if (rReceiptScalar >= SECP_N) {
    return { outcome: 'invalid', valid: false, reason: 'r_receipt >= n_secp (invalid scalar)' };
  }

  // Quoted-receipt point decode (bulletproof slot-1 subject; the credit
  // path never reads its implied amount).
  let cReceiptOnChain;
  try {
    cReceiptOnChain = secp.ProjectivePoint.fromHex(bytesToHex(env.cReceiptSecp));
  } catch (e) {
    return { outcome: 'invalid', valid: false, reason: `cReceiptSecp decode: ${e.message}` };
  }

  // ----- intent_sig verification -----
  const intentMsg = buildSwapVarIntentMsg({
    poolId: env.poolId, direction: env.direction,
    deltaIn: env.deltaIn, deltaInMin: env.deltaInMin, deltaInMax: env.deltaInMax,
    deltaOut: env.deltaOut, minOut: env.minOut,
    tipAmount: env.tipAmount, tipAsset: env.tipAsset,
    expiryHeight: env.expiryHeight, traderPubkey: env.traderPubkey,
    assetInputOutpoint: canonicalOutpoint(assetInputOutpointTxid, assetInputOutpointVout),
    receiveScriptPubKey,
    cReceiptSecp: env.cReceiptSecp,
    cChangeOrSentinel: env.cChangeOrSentinel,
  });
  const traderXOnly = env.traderPubkey.subarray(1); // strip parity byte for BIP-340
  if (!verifySchnorr(env.intentSig, intentMsg, traderXOnly)) {
    return { outcome: 'invalid', valid: false, reason: 'intent_sig verification failed' };
  }

  // ----- kernel_sig verification -----
  //
  // Sentinel-aware closure: P = C_change_or_sentinel − C_in_secp + delta_in_total · H.
  // The verifier key is P.x_only(). The kernel msg binds the input's REAL
  // asset id (inputAssetId), not the pool's direction side — identical
  // bytes in the honest case, and well-defined even when the pool is
  // unknown (pass-through path).
  const deltaInTotal = env.deltaIn + env.tipAmount;
  if (deltaInTotal >= 1n << 64n) {
    // Defensive: a real input commitment can't hold ≥ 2^64 (its own
    // ancestry bulletproof bounds it), so the slot-0 range gate below
    // would fail anyway. Reject early with a precise reason.
    return { outcome: 'invalid', valid: false, reason: 'delta_in + tip_amount overflows u64' };
  }
  const kernelMsg = buildSwapVarKernelMsg({
    assetIdIn: inputAssetId,
    assetInputOutpointTxid, assetInputOutpointVout,
    cChangeOrSentinel: env.cChangeOrSentinel,
    deltaInTotal,
  });
  const P = kernelVerifyPoint({
    cChangeOrSentinel: env.cChangeOrSentinel,
    cInSecp: env.cInSecp,
    deltaInTotal,
  });
  if (P.equals(ZERO)) {
    return { outcome: 'invalid', valid: false, reason: 'kernel verifier key is point at infinity (would accept any sig)' };
  }
  const PBytes = pointToBytes(P);
  const PxOnly = PBytes.subarray(1); // strip parity byte
  if (!verifySchnorr(env.kernelSig, kernelMsg, PxOnly)) {
    return { outcome: 'invalid', valid: false, reason: 'kernel_sig verification failed' };
  }

  // ----- Bulletproof m=2 over (C_change_or_sentinel, C_receipt_secp) -----
  //
  // The change side's range gate proves (amount_in − delta_in_total) ≥ 0,
  // which prevents the trader over-spending their input commit — load-
  // bearing for both outcomes. The receipt side ranges the QUOTED commit
  // (wire-format parity with T_AXFER_VAR); the credited amount's range-
  // safety is established by derivation.
  //
  // No-change case: the prover supplies the additive identity in slot 0,
  // which trivially opens to (value=0, blinding=0).
  let cChangeForBP;
  if (isNoChangeSentinel(env.cChangeOrSentinel)) {
    cChangeForBP = ZERO;
  } else {
    try { cChangeForBP = secp.ProjectivePoint.fromHex(bytesToHex(env.cChangeOrSentinel)); }
    catch (e) { return { outcome: 'invalid', valid: false, reason: `cChangeOrSentinel decode: ${e.message}` }; }
  }
  if (!bulletproofVerify([cChangeForBP, cReceiptOnChain], env.rangeProof)) {
    return { outcome: 'invalid', valid: false, reason: 'bulletproof verification failed' };
  }

  // ════════ Stage B — EXECUTABILITY (any failure ⇒ PASS-THROUGH) ════════
  //
  // Evaluated against the pool's RUNNING state at this envelope's
  // canonical position. In-block ordering affects only the PRICE a fill
  // receives — never validity.

  const passthrough = (passReason) => {
    const refundAmount = deltaInTotal; // delta_in + tip_amount — everything
                                       // the kernel closure proves left the
                                       // input beyond the committed change.
                                       // No tip on non-execution.
    const refundCommitment = pointToBytes(pedersenCommit(refundAmount, rReceiptScalar));
    return {
      outcome: 'passthrough', valid: true, executed: false, passReason,
      quotedDeltaOut: env.deltaOut,
      newPoolState: pool ? { ...pool } : null,   // unchanged
      receipt: {
        asset_id: inputAssetId,
        commitment: refundCommitment,
        r_receipt: env.rReceipt,
        amount: refundAmount,
      },
    };
  };

  if (!pool) return passthrough('pool not registered');
  if (!bytesEqual(env.poolId, pool.pool_id)) return passthrough('pool_id mismatch');
  if (env.direction !== 0 && env.direction !== 1) return passthrough('direction out of range');

  // Input asset must be the pool's direction-side asset; tip_asset byte
  // must name the same side (wire rule: tip is paid from the input).
  const dirSideAsset = env.direction === 0 ? pool.asset_A : pool.asset_B;
  if (!bytesEqual(inputAssetId, dirSideAsset)) {
    return passthrough("input asset != pool's direction-side asset");
  }
  if (env.tipAsset !== env.direction) return passthrough('tip_asset != input side');

  // Range gate on the [Δmin, Δ, Δmax] tuple.
  if (env.deltaIn === 0n) return passthrough('delta_in must be > 0');
  if (env.deltaIn < env.deltaInMin) return passthrough('delta_in < delta_in_min');
  if (env.deltaIn > env.deltaInMax) return passthrough('delta_in > delta_in_max');

  // Expiry.
  if (currentHeight >= env.expiryHeight) {
    return passthrough(`expired (height ${currentHeight} >= ${env.expiryHeight})`);
  }

  // Curve evaluation at ACTUAL running reserves — the declared
  // (R_A_pre, R_B_pre) and delta_out are advisory quote context only.
  let curve;
  try {
    curve = curveDeltaOut({
      direction: env.direction,
      R_A_pre: pool.reserve_A, R_B_pre: pool.reserve_B,
      delta_in: env.deltaIn, fee_bps: pool.fee_bps,
    });
  } catch (e) { return passthrough(`curve at actual reserves: ${e.message}`); }
  if (curve.raPost <= 0n || curve.rbPost <= 0n) {
    return passthrough('post-reserve non-positive (defensive floor)');
  }

  // Slippage floor — the trader's binding price consent. max(1, ·): a
  // zero-output fill never executes even at min_out = 0 (pass-through is
  // strictly kinder than donating delta_in to the pool).
  const floor = env.minOut > 1n ? env.minOut : 1n;
  if (curve.deltaOut < floor) {
    return passthrough(`slippage: delta_out_actual=${curve.deltaOut} < max(1, min_out=${env.minOut})`);
  }

  // ════════ EXECUTE — market-order fill at actual reserves ════════
  //
  // The credited receipt commitment is DERIVED from the actual fill and
  // the published r_receipt. Tip mechanics stay caller-delegated: vout[3]
  // credits tip_amount iff its commitment opens under the settler's
  // derived r_tip ("tacit-amm-swap-var-tip-v1"); an unopenable tip output
  // is simply not credited (settler forfeits; fill and pool unaffected).
  const newPoolState = {
    ...pool,
    reserve_A: curve.raPost,
    reserve_B: curve.rbPost,
    // LP fee accrual: pool's k grows naturally because the fee-adjusted
    // curve product is ≥ k_pre. The lazy-mintFee crystallization fires
    // at the next LP_ADD / LP_REMOVE event — see AMM.md §"Protocol fee
    // mechanism" — not here.
  };
  const receiptCommitment = pointToBytes(pedersenCommit(curve.deltaOut, rReceiptScalar));
  return {
    outcome: 'execute', valid: true, executed: true,
    deltaOutActual: curve.deltaOut,
    quotedDeltaOut: env.deltaOut,
    newPoolState,
    receipt: {
      asset_id: env.direction === 0 ? pool.asset_B : pool.asset_A,
      commitment: receiptCommitment,
      r_receipt: env.rReceipt,
      amount: curve.deltaOut,
    },
  };
}
