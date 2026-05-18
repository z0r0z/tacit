// T_FARM_INIT (0x34) / T_LP_BOND (0x35) / T_LP_UNBOND (0x36)
// reference implementation.
//
// Spec: SPEC-AMM-FARM-AMENDMENT.md (round-1, post-sanity-check).
//
// MasterChef-style staked-LP rewards on tacit AMM pools.
//
// Design properties:
//   - Virtual treasury bookkeeping (no on-chain treasury UTXO; mirrors
//     AMM virtual pool reserves at AMM.md:1845 and cBTC.tac insurance).
//   - Per-bond worker-indexed records keyed by vout[1].outpoint of the
//     bond tx. Receipts are plain P2WPKH dust markers — NOT a tacit
//     asset class.
//   - Q.96 fixed-point acc_reward_per_share, lazy mintFee-style
//     crystallization on every farm-mutating event.
//   - Reuses tacit-kernel-v1 kernel-sig + Pedersen + m=1 bulletproof
//     stack from T_SWAP_VAR. No Groth16, no new ceremony.
//   - Three new domain tags: tacit-amm-farm-init-v1,
//     tacit-amm-farm-bond-v1, tacit-amm-farm-unbond-v1.
//
// Wire weight (fixed portions):
//   T_FARM_INIT : 316 B + ~360 B BP = ~676 B
//   T_LP_BOND   : 256 B + ~360 B BP = ~616 B
//   T_LP_UNBOND : 259 B (no BP)
//
// Public surface:
//   - Constants: OPCODE_T_FARM_INIT/T_LP_BOND/T_LP_UNBOND, ENVELOPE_VERSION,
//     AMM_FARM_MIN_BOND, AMM_FARM_MIN_REWARD_TOTAL, AMM_FARM_MAX_START_DELAY,
//     AMM_FARM_VIEW_STALENESS, ACC_FIXED_POINT_SHIFT
//   - Derivation: deriveFarmId, deriveLpAssetIdFromPoolId
//   - Encoders: encodeFarmInit, encodeLpBond, encodeLpUnbond
//   - Decoders: decodeFarmInit, decodeLpBond, decodeLpUnbond
//   - Msg builders: buildFarmInitMsg, buildFarmInitKernelMsg,
//     buildLpBondMsg, buildLpBondKernelMsg, buildLpUnbondMsg
//   - Crystallization: crystallizeFarm
//   - Validators: validateFarmInit, validateLpBond, validateLpUnbond
//   - In-memory state machine: FarmState

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN, pedersenCommit, pointToBytes,
} from './bulletproofs.mjs';
import {
  computeKernelMsg, verifySchnorr,
} from './composition.mjs';

// =========================================================================
// Constants
// =========================================================================

export const OPCODE_T_FARM_INIT  = 0x34;
export const OPCODE_T_LP_BOND    = 0x35;
export const OPCODE_T_LP_UNBOND  = 0x36;
export const ENVELOPE_VERSION    = 0x01;

// Anti-spam dust floor on individual bonds (matches MINIMUM_LIQUIDITY-class numeric).
export const AMM_FARM_MIN_BOND = 1000n;

// Anti-spam dust floor on farm reward_total. 10^9 base units protects
// against trivial worker-storage griefing via micro-farms.
export const AMM_FARM_MIN_REWARD_TOTAL = 1_000_000_000n;

// Upper bound on (start_height - current_height) for a fresh farm.
// ~30 days of Bitcoin blocks at 10-min cadence. Prevents launchers from
// pre-registering far-future farms that occupy worker state for years.
export const AMM_FARM_MAX_START_DELAY = 4320;

// Freshness gate on bonder/unbonder view of canonical state.
// Mirrors T_INTENT_ATTEST's TTL-class staleness check; 6 Bitcoin blocks
// ≈ 1 hour at 10-min cadence.
export const AMM_FARM_VIEW_STALENESS = 6;

// Q.96 fixed-point for acc_reward_per_share. Chosen so that
//   numerator (reward_units << 96) fits in u192 for reward_per_block ≤ u64,
//   elapsed ≤ u32, total_bonded ≥ 1; pending fits in u192 for
//   bond_amount ≤ u64, acc_delta ≤ u128.
export const ACC_FIXED_POINT_SHIFT = 96n;

// No-change sentinel (33 zero bytes) — same convention as T_SWAP_VAR.
export const NO_CHANGE_SENTINEL = new Uint8Array(33);

// Domain tags
const DOMAIN_FARM_ID    = new TextEncoder().encode('tacit-amm-farm-init-v1');
const DOMAIN_INIT_MSG   = DOMAIN_FARM_ID;            // shared with farm_id derivation
const DOMAIN_BOND_MSG   = new TextEncoder().encode('tacit-amm-farm-bond-v1');
const DOMAIN_UNBOND_MSG = new TextEncoder().encode('tacit-amm-farm-unbond-v1');
const DOMAIN_LP_ASSET   = new TextEncoder().encode('tacit-amm-lp-v1');

// Limits guarded at decode time.
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

// =========================================================================
// Helpers
// =========================================================================

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}
function u32LE(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function u64LE(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x > U64_MAX) throw new Error(`u64 overflow: ${x}`);
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function u128LE(n) {
  const b = new Uint8Array(16);
  let x = BigInt(n);
  if (x < 0n || x > U128_MAX) throw new Error(`u128 overflow: ${x}`);
  for (let i = 0; i < 16; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function readU32LE(b, o) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true) >>> 0; }
function readU64LE(b, o) {
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(b[o + i]) << BigInt(i * 8);
  return n;
}
function readU128LE(b, o) {
  let n = 0n;
  for (let i = 0; i < 16; i++) n |= BigInt(b[o + i]) << BigInt(i * 8);
  return n;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function bytesToHex(b) {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
  return out;
}
function bytesToBigintBE(b) { return BigInt('0x' + bytesToHex(b)); }

// Outpoint encoding shared with the rest of tacit:
//   bond_id / vin[1].outpoint = txid(32 BE) || vout(4 LE).
function encodeOutpoint(txidBE, vout) {
  const txid = asBytes(txidBE, 32, 'txid');
  return concatBytes(txid, u32LE(vout));
}

export function isNoChangeSentinel(b) {
  if (!(b instanceof Uint8Array) || b.length !== 33) return false;
  for (let i = 0; i < 33; i++) if (b[i] !== 0) return false;
  return true;
}

// =========================================================================
// Derivation helpers
// =========================================================================

// farm_id = SHA256(domain || pool_id || launcher_pubkey || reward_asset_id || farm_nonce)
export function deriveFarmId({ poolId, launcherPubkey, rewardAssetId, farmNonce }) {
  return sha256(concatBytes(
    DOMAIN_FARM_ID,
    asBytes(poolId, 32, 'poolId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    asBytes(rewardAssetId, 32, 'rewardAssetId'),
    asBytes(farmNonce, 32, 'farmNonce'),
  ));
}

// lp_asset_id = SHA256("tacit-amm-lp-v1" || pool_id) per AMM.md
// §"LP shares as a confidential tacit asset".
export function deriveLpAssetIdFromPoolId(poolId) {
  return sha256(concatBytes(DOMAIN_LP_ASSET, asBytes(poolId, 32, 'poolId')));
}

// bond_id is the outpoint of vout[1] of T_LP_BOND — encoded as the standard
// tacit 36-byte (txid_BE || vout_LE) tuple.
export function encodeBondId(txidBE, vout) {
  return encodeOutpoint(txidBE, vout);
}
export function decodeBondId(bondIdBytes) {
  const b = asBytes(bondIdBytes, 36, 'bond_id');
  return { txid: new Uint8Array(b.subarray(0, 32)), vout: readU32LE(b, 32) };
}

// =========================================================================
// Message builders
// =========================================================================

// init_msg — signed by launcher_pubkey (BIP-340).
export function buildFarmInitMsg({
  farmId, launcherPubkey,
  rewardTotal, rewardPerBlock,
  startHeight, endHeight,
  envelopeHash,
}) {
  return sha256(concatBytes(
    DOMAIN_INIT_MSG,
    asBytes(farmId, 32, 'farmId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    u64LE(rewardTotal),
    u64LE(rewardPerBlock),
    u32LE(startHeight),
    u32LE(endHeight),
    asBytes(envelopeHash, 32, 'envelopeHash'),
  ));
}

// kernel_msg for T_FARM_INIT — uses composition.mjs computeKernelMsg
// with asset_id = reward_asset_id, single input outpoint, single
// output (C_change_or_sentinel), and burned slot = reward_total.
//
// "Burned" here is the standard kernel-sig terminology for "value
// absorbed into validator-tracked state" — same role as in T_LP_REMOVE
// and T_SWAP_VAR. Different on-chain semantics, identical math.
export function buildFarmInitKernelMsg({
  rewardAssetId, launcherInputOutpointTxid, launcherInputOutpointVout,
  cChangeOrSentinel, rewardTotal,
}) {
  return computeKernelMsg(
    asBytes(rewardAssetId, 32, 'rewardAssetId'),
    [{ txid: bytesToHex(asBytes(launcherInputOutpointTxid, 32, 'launcherInputOutpointTxid')), vout: launcherInputOutpointVout }],
    [asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel')],
    BigInt(rewardTotal),
  );
}

// bond_msg — signed by bonder_pubkey (BIP-340).
export function buildLpBondMsg({
  farmId, bonderPubkey, bondAmount,
  entryAccPerShare, bondViewHeight, envelopeHash,
}) {
  return sha256(concatBytes(
    DOMAIN_BOND_MSG,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bonderPubkey, 33, 'bonderPubkey'),
    u64LE(bondAmount),
    u128LE(entryAccPerShare),
    u32LE(bondViewHeight),
    asBytes(envelopeHash, 32, 'envelopeHash'),
  ));
}

// kernel_msg for T_LP_BOND — composition.mjs computeKernelMsg with
// asset_id = lp_asset_id (derived from farm.pool_id), single input
// outpoint, single output (C_change_or_sentinel), burned slot =
// bond_amount.
export function buildLpBondKernelMsg({
  lpAssetId, bonderInputOutpointTxid, bonderInputOutpointVout,
  cChangeOrSentinel, bondAmount,
}) {
  return computeKernelMsg(
    asBytes(lpAssetId, 32, 'lpAssetId'),
    [{ txid: bytesToHex(asBytes(bonderInputOutpointTxid, 32, 'bonderInputOutpointTxid')), vout: bonderInputOutpointVout }],
    [asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel')],
    BigInt(bondAmount),
  );
}

// unbond_msg — signed by unbonder_pubkey (BIP-340).
export function buildLpUnbondMsg({
  farmId, bondId, unbonderPubkey,
  exitAccPerShare, exitViewHeight, rewardAmount,
  lpReturnR, rewardR, envelopeHash,
}) {
  return sha256(concatBytes(
    DOMAIN_UNBOND_MSG,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bondId, 36, 'bondId'),
    asBytes(unbonderPubkey, 33, 'unbonderPubkey'),
    u128LE(exitAccPerShare),
    u32LE(exitViewHeight),
    u64LE(rewardAmount),
    asBytes(lpReturnR, 32, 'lpReturnR'),
    asBytes(rewardR, 32, 'rewardR'),
    asBytes(envelopeHash, 32, 'envelopeHash'),
  ));
}

// =========================================================================
// Kernel verify-point construction (shared shape with T_SWAP_VAR)
// =========================================================================
//
// For both T_FARM_INIT and T_LP_BOND the kernel sig closes the
// single-asset side:
//   P = C_change_or_sentinel − C_in + burned_amount · H
//
// signed by excess = r_change − r_in (or just −r_in in the whole-input
// case where C_change_or_sentinel = ZERO). Identical to T_SWAP_VAR's
// kernelVerifyPoint, factored out for reuse across our two opcodes.

export function kernelVerifyPoint({ cChangeOrSentinel, cInSecp, burnedAmount }) {
  const cIn = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cInSecp, 33, 'cInSecp')));
  let cChange;
  if (isNoChangeSentinel(cChangeOrSentinel)) {
    cChange = ZERO;
  } else {
    cChange = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel')));
  }
  const burned = BigInt(burnedAmount);
  const burnedH = burned === 0n ? ZERO : H.multiply(burned);
  return cChange.add(cIn.negate()).add(burnedH);
}

// =========================================================================
// Crystallization (mintFee-style lazy accrual)
// =========================================================================
//
// Mutates farm in place. Safe to call multiple times — idempotent for
// the same height. Returns the new acc_reward_per_share so callers can
// validate freshness without re-reading.

export function crystallizeFarm(farm, currentHeight) {
  const h = currentHeight > farm.end_height ? farm.end_height : currentHeight;
  if (h <= farm.last_update_height) {
    return farm.acc_reward_per_share;
  }
  if (h < farm.start_height) {
    // Pre-start: advance the clock without emission.
    farm.last_update_height = h;
    return farm.acc_reward_per_share;
  }
  const baseline = farm.last_update_height < farm.start_height
    ? farm.start_height
    : farm.last_update_height;
  const elapsed = BigInt(h) - BigInt(baseline);
  if (farm.total_bonded > 0n && elapsed > 0n) {
    const reward_units = elapsed * farm.reward_per_block;
    const acc_delta = (reward_units << ACC_FIXED_POINT_SHIFT) / farm.total_bonded;
    farm.acc_reward_per_share += acc_delta;
  }
  farm.last_update_height = h;
  return farm.acc_reward_per_share;
}

// =========================================================================
// Wire-format encoders / decoders
// =========================================================================

// ---- T_FARM_INIT ----

export function encodeFarmInit(env) {
  const {
    poolId, farmNonce, launcherPubkey, rewardAssetId,
    rewardTotal, rewardPerBlock, startHeight, endHeight,
    cChangeOrSentinel, rangeProof, kernelSig, launcherSig,
  } = env;

  const parts = [
    new Uint8Array([ENVELOPE_VERSION, OPCODE_T_FARM_INIT]),
    asBytes(poolId, 32, 'poolId'),
    asBytes(farmNonce, 32, 'farmNonce'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    asBytes(rewardAssetId, 32, 'rewardAssetId'),
    u64LE(rewardTotal),
    u64LE(rewardPerBlock),
    u32LE(startHeight),
    u32LE(endHeight),
    asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel'),
  ];
  if (!(rangeProof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (rangeProof.length > 0xffff) throw new Error('rangeProof too large (> 65535)');
  parts.push(new Uint8Array([rangeProof.length & 0xff, (rangeProof.length >> 8) & 0xff]));
  parts.push(rangeProof);
  parts.push(asBytes(kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(launcherSig, 64, 'launcherSig'));
  return concatBytes(...parts);
}

export function decodeFarmInit(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  let o = 0;
  function take(n, name) {
    if (o + n > payload.length) throw new Error(`decode: truncated at ${name} (need ${n}, have ${payload.length - o})`);
    const s = payload.subarray(o, o + n);
    o += n;
    return s;
  }
  const version = take(1, 'version')[0];
  if (version !== ENVELOPE_VERSION) throw new Error(`bad envelope_version: ${version}`);
  const opcode = take(1, 'opcode')[0];
  if (opcode !== OPCODE_T_FARM_INIT) throw new Error(`bad opcode: ${opcode}`);
  const poolId = new Uint8Array(take(32, 'poolId'));
  const farmNonce = new Uint8Array(take(32, 'farmNonce'));
  const launcherPubkey = new Uint8Array(take(33, 'launcherPubkey'));
  if (launcherPubkey[0] !== 0x02 && launcherPubkey[0] !== 0x03) {
    throw new Error(`launcherPubkey not a valid compressed secp256k1 point (leading byte ${launcherPubkey[0]})`);
  }
  const rewardAssetId = new Uint8Array(take(32, 'rewardAssetId'));
  const rewardTotal = readU64LE(payload, o); o += 8;
  const rewardPerBlock = readU64LE(payload, o); o += 8;
  const startHeight = readU32LE(payload, o); o += 4;
  const endHeight = readU32LE(payload, o); o += 4;
  const cChangeOrSentinel = new Uint8Array(take(33, 'cChangeOrSentinel'));
  const rpLen = (payload[o] | (payload[o + 1] << 8)) >>> 0; o += 2;
  const rangeProof = new Uint8Array(take(rpLen, 'rangeProof'));
  const kernelSig = new Uint8Array(take(64, 'kernelSig'));
  const launcherSig = new Uint8Array(take(64, 'launcherSig'));
  if (o !== payload.length) {
    throw new Error(`trailing bytes after launcherSig: ${payload.length - o}`);
  }
  return {
    version, opcode,
    poolId, farmNonce, launcherPubkey, rewardAssetId,
    rewardTotal, rewardPerBlock, startHeight, endHeight,
    cChangeOrSentinel, rangeProof, kernelSig, launcherSig,
  };
}

// ---- T_LP_BOND ----

export function encodeLpBond(env) {
  const {
    farmId, bonderPubkey, bondAmount,
    entryAccPerShare, bondViewHeight,
    cChangeOrSentinel, rangeProof, kernelSig, bonderSig,
  } = env;

  const parts = [
    new Uint8Array([ENVELOPE_VERSION, OPCODE_T_LP_BOND]),
    asBytes(farmId, 32, 'farmId'),
    asBytes(bonderPubkey, 33, 'bonderPubkey'),
    u64LE(bondAmount),
    u128LE(entryAccPerShare),
    u32LE(bondViewHeight),
    asBytes(cChangeOrSentinel, 33, 'cChangeOrSentinel'),
  ];
  if (!(rangeProof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (rangeProof.length > 0xffff) throw new Error('rangeProof too large (> 65535)');
  parts.push(new Uint8Array([rangeProof.length & 0xff, (rangeProof.length >> 8) & 0xff]));
  parts.push(rangeProof);
  parts.push(asBytes(kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(bonderSig, 64, 'bonderSig'));
  return concatBytes(...parts);
}

export function decodeLpBond(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  let o = 0;
  function take(n, name) {
    if (o + n > payload.length) throw new Error(`decode: truncated at ${name} (need ${n}, have ${payload.length - o})`);
    const s = payload.subarray(o, o + n);
    o += n;
    return s;
  }
  const version = take(1, 'version')[0];
  if (version !== ENVELOPE_VERSION) throw new Error(`bad envelope_version: ${version}`);
  const opcode = take(1, 'opcode')[0];
  if (opcode !== OPCODE_T_LP_BOND) throw new Error(`bad opcode: ${opcode}`);
  const farmId = new Uint8Array(take(32, 'farmId'));
  const bonderPubkey = new Uint8Array(take(33, 'bonderPubkey'));
  if (bonderPubkey[0] !== 0x02 && bonderPubkey[0] !== 0x03) {
    throw new Error(`bonderPubkey not a valid compressed secp256k1 point`);
  }
  const bondAmount = readU64LE(payload, o); o += 8;
  const entryAccPerShare = readU128LE(payload, o); o += 16;
  const bondViewHeight = readU32LE(payload, o); o += 4;
  const cChangeOrSentinel = new Uint8Array(take(33, 'cChangeOrSentinel'));
  const rpLen = (payload[o] | (payload[o + 1] << 8)) >>> 0; o += 2;
  const rangeProof = new Uint8Array(take(rpLen, 'rangeProof'));
  const kernelSig = new Uint8Array(take(64, 'kernelSig'));
  const bonderSig = new Uint8Array(take(64, 'bonderSig'));
  if (o !== payload.length) {
    throw new Error(`trailing bytes after bonderSig: ${payload.length - o}`);
  }
  return {
    version, opcode,
    farmId, bonderPubkey, bondAmount,
    entryAccPerShare, bondViewHeight,
    cChangeOrSentinel, rangeProof, kernelSig, bonderSig,
  };
}

// ---- T_LP_UNBOND ----

export function encodeLpUnbond(env) {
  const {
    farmId, bondId, unbonderPubkey,
    exitAccPerShare, exitViewHeight, rewardAmount,
    lpReturnR, rewardR, unbonderSig,
  } = env;
  const parts = [
    new Uint8Array([ENVELOPE_VERSION, OPCODE_T_LP_UNBOND]),
    asBytes(farmId, 32, 'farmId'),
    asBytes(bondId, 36, 'bondId'),
    asBytes(unbonderPubkey, 33, 'unbonderPubkey'),
    u128LE(exitAccPerShare),
    u32LE(exitViewHeight),
    u64LE(rewardAmount),
    asBytes(lpReturnR, 32, 'lpReturnR'),
    asBytes(rewardR, 32, 'rewardR'),
    asBytes(unbonderSig, 64, 'unbonderSig'),
  ];
  return concatBytes(...parts);
}

export function decodeLpUnbond(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  let o = 0;
  function take(n, name) {
    if (o + n > payload.length) throw new Error(`decode: truncated at ${name} (need ${n}, have ${payload.length - o})`);
    const s = payload.subarray(o, o + n);
    o += n;
    return s;
  }
  const version = take(1, 'version')[0];
  if (version !== ENVELOPE_VERSION) throw new Error(`bad envelope_version: ${version}`);
  const opcode = take(1, 'opcode')[0];
  if (opcode !== OPCODE_T_LP_UNBOND) throw new Error(`bad opcode: ${opcode}`);
  const farmId = new Uint8Array(take(32, 'farmId'));
  const bondId = new Uint8Array(take(36, 'bondId'));
  const unbonderPubkey = new Uint8Array(take(33, 'unbonderPubkey'));
  if (unbonderPubkey[0] !== 0x02 && unbonderPubkey[0] !== 0x03) {
    throw new Error(`unbonderPubkey not a valid compressed secp256k1 point`);
  }
  const exitAccPerShare = readU128LE(payload, o); o += 16;
  const exitViewHeight = readU32LE(payload, o); o += 4;
  const rewardAmount = readU64LE(payload, o); o += 8;
  const lpReturnR = new Uint8Array(take(32, 'lpReturnR'));
  const rewardR = new Uint8Array(take(32, 'rewardR'));
  const unbonderSig = new Uint8Array(take(64, 'unbonderSig'));
  if (o !== payload.length) {
    throw new Error(`trailing bytes after unbonderSig: ${payload.length - o}`);
  }
  return {
    version, opcode,
    farmId, bondId, unbonderPubkey,
    exitAccPerShare, exitViewHeight, rewardAmount,
    lpReturnR, rewardR, unbonderSig,
  };
}

// Envelope hash = SHA256(payload). Same convention as T_SWAP_VAR /
// T_SWAP_ROUTE; caller binds this into vout[0]'s OP_RETURN.
export function computeEnvelopeHash(payload) { return sha256(payload); }

// =========================================================================
// Validators
// =========================================================================

// ---- validateFarmInit ----
//
// Inputs:
//   payload              : envelope bytes
//   pool                 : existing AMM pool state — needed for pool_id
//                          verification + init-lock + reward_asset_id
//                          consistency. {pool_id, init_height, ...}.
//   inputCommitment      : 33-byte on-chain Pedersen commit at vin[1]
//                          (the launcher's reward-asset UTXO). Passed
//                          by the worker from canonical UTXO state.
//   currentHeight        : block height at confirmation (depth-3 pinned).
//   opReturnData         : 32-byte vout[0] OP_RETURN payload.
//   bulletproofVerify    : injected (V_pts, proofBytes) -> bool.
//
// Returns { valid: true, farm, kernelMsg, initMsg } or { valid: false, reason }.

export function validateFarmInit({
  payload, pool, inputCommitment, currentHeight, opReturnData, bulletproofVerify,
}) {
  if (!pool) return { valid: false, reason: 'pool not registered' };
  if (typeof bulletproofVerify !== 'function') {
    throw new Error('validateFarmInit: bulletproofVerify is required');
  }
  if (inputCommitment === undefined) {
    throw new Error('validateFarmInit: inputCommitment is required (on-chain Pedersen commit at vin[1])');
  }
  let env;
  try { env = decodeFarmInit(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  // OP_RETURN binding.
  if (!(opReturnData instanceof Uint8Array) || opReturnData.length !== 32) {
    return { valid: false, reason: 'missing or malformed vout[0] OP_RETURN data' };
  }
  const envelopeHash = sha256(payload);
  if (!bytesEqual(opReturnData, envelopeHash)) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }

  // pool_id consistency.
  if (!bytesEqual(env.poolId, pool.pool_id)) {
    return { valid: false, reason: 'pool_id mismatch' };
  }

  // Initial-LP lock window — no farms over a pool still inside it.
  const initHeight = pool.init_height || 0;
  const initLock = pool.amm_initial_lp_lock_blocks ?? 6;   // default per AMM.md
  if (env.startHeight < initHeight + initLock) {
    return {
      valid: false,
      reason: `start_height ${env.startHeight} < pool.init_height+lock ${initHeight + initLock}`,
    };
  }

  // start_height ≥ currentHeight + 3 (depth-3 activation gate).
  if (env.startHeight < currentHeight + 3) {
    return { valid: false, reason: `start_height ${env.startHeight} < currentHeight+3 ${currentHeight + 3}` };
  }
  // start_height ≤ currentHeight + AMM_FARM_MAX_START_DELAY.
  if (env.startHeight > currentHeight + AMM_FARM_MAX_START_DELAY) {
    return {
      valid: false,
      reason: `start_height ${env.startHeight} > currentHeight+max_delay ${currentHeight + AMM_FARM_MAX_START_DELAY}`,
    };
  }

  // Reward schedule sanity.
  if (env.rewardPerBlock === 0n) return { valid: false, reason: 'reward_per_block must be > 0' };
  if (env.rewardTotal < AMM_FARM_MIN_REWARD_TOTAL) {
    return { valid: false, reason: `reward_total < AMM_FARM_MIN_REWARD_TOTAL (${env.rewardTotal} < ${AMM_FARM_MIN_REWARD_TOTAL})` };
  }
  if (env.rewardTotal % env.rewardPerBlock !== 0n) {
    return { valid: false, reason: 'reward_total not divisible by reward_per_block (no fractional final block)' };
  }
  const durationBlocks = env.rewardTotal / env.rewardPerBlock;
  if (durationBlocks > BigInt(0xffffffff)) {
    return { valid: false, reason: 'farm duration exceeds u32 block range' };
  }
  const expectedEnd = env.startHeight + Number(durationBlocks);
  if (expectedEnd > 0xffffffff) {
    return { valid: false, reason: 'computed end_height exceeds u32' };
  }
  if (env.endHeight !== expectedEnd) {
    return {
      valid: false,
      reason: `end_height ${env.endHeight} != start_height + reward_total/reward_per_block (${expectedEnd})`,
    };
  }

  // Input-commit binding.
  let inputCommitmentBytes;
  if (inputCommitment instanceof Uint8Array) {
    if (inputCommitment.length !== 33) return { valid: false, reason: 'inputCommitment must be 33-byte compressed point' };
    inputCommitmentBytes = inputCommitment;
  } else if (typeof inputCommitment.toRawBytes === 'function') {
    inputCommitmentBytes = inputCommitment.toRawBytes(true);
  } else {
    return { valid: false, reason: 'inputCommitment must be ProjectivePoint or Uint8Array(33)' };
  }

  // farm_id derivation.
  const farmId = deriveFarmId({
    poolId: env.poolId,
    launcherPubkey: env.launcherPubkey,
    rewardAssetId: env.rewardAssetId,
    farmNonce: env.farmNonce,
  });

  // Bulletproof m=1 over C_change_or_sentinel.
  // The whole-input case uses the additive-identity sentinel (ZERO point),
  // same convention as T_SWAP_VAR.
  let cChangePt;
  if (isNoChangeSentinel(env.cChangeOrSentinel)) {
    cChangePt = ZERO;
  } else {
    try { cChangePt = secp.ProjectivePoint.fromHex(bytesToHex(env.cChangeOrSentinel)); }
    catch (e) { return { valid: false, reason: `cChangeOrSentinel decode: ${e.message}` }; }
  }
  if (!bulletproofVerify([cChangePt], env.rangeProof)) {
    return { valid: false, reason: 'bulletproof verification failed' };
  }

  // Kernel sig verification.
  // Worker passes vin[1].outpoint as part of the validation call, but
  // the kernel_msg incorporates it via computeKernelMsg. The caller
  // must provide the outpoint values consistent with the actual tx.
  // For the in-memory state machine we re-derive at apply time.
  // Here we package what's needed for the worker to construct kernelMsg
  // and verify; we return the kernel verify-point construction below
  // so the worker can finish the verification with its outpoint info.

  // farm record (uninitialised acc).
  const farm = {
    farm_id: farmId,
    pool_id: env.poolId,
    lp_asset_id: deriveLpAssetIdFromPoolId(env.poolId),
    reward_asset_id: env.rewardAssetId,
    launcher_pubkey: env.launcherPubkey,
    reward_total: env.rewardTotal,
    reward_per_block: env.rewardPerBlock,
    start_height: env.startHeight,
    end_height: env.endHeight,
    acc_reward_per_share: 0n,
    total_bonded: 0n,
    last_update_height: env.startHeight,   // pre-start; advances at first bond
    treasury_remaining: env.rewardTotal,
  };

  const kernelMsgInfo = {
    rewardAssetId: env.rewardAssetId,
    cChangeOrSentinel: env.cChangeOrSentinel,
    rewardTotal: env.rewardTotal,
    inputCommitmentBytes,
  };

  const initMsg = buildFarmInitMsg({
    farmId,
    launcherPubkey: env.launcherPubkey,
    rewardTotal: env.rewardTotal,
    rewardPerBlock: env.rewardPerBlock,
    startHeight: env.startHeight,
    endHeight: env.endHeight,
    envelopeHash,
  });

  // launcher_sig verification.
  const launcherXOnly = env.launcherPubkey.subarray(1);
  let launcherOk;
  try { launcherOk = verifySchnorr(env.launcherSig, initMsg, launcherXOnly); }
  catch { launcherOk = false; }
  if (!launcherOk) {
    return { valid: false, reason: 'launcher_sig verification failed' };
  }

  return { valid: true, farm, kernelMsgInfo, initMsg, envelopeHash };
}

// Finishes kernel-sig verification given the launcher's actual input
// outpoint (the worker has this from the tx; tests inject it).
export function verifyFarmInitKernelSig({
  envelope,                  // decoded env (from decodeFarmInit)
  launcherInputOutpointTxid, // 32-byte BE
  launcherInputOutpointVout, // u32
  inputCommitment,           // 33-byte on-chain Pedersen commit
}) {
  const kernelMsg = buildFarmInitKernelMsg({
    rewardAssetId: envelope.rewardAssetId,
    launcherInputOutpointTxid,
    launcherInputOutpointVout,
    cChangeOrSentinel: envelope.cChangeOrSentinel,
    rewardTotal: envelope.rewardTotal,
  });
  const P = kernelVerifyPoint({
    cChangeOrSentinel: envelope.cChangeOrSentinel,
    cInSecp: inputCommitment,
    burnedAmount: envelope.rewardTotal,
  });
  if (P.equals(ZERO)) {
    return { ok: false, reason: 'kernel verifier key is point at infinity (would accept any sig)' };
  }
  const PBytes = pointToBytes(P);
  const PxOnly = PBytes.subarray(1);
  let ok;
  try { ok = verifySchnorr(envelope.kernelSig, kernelMsg, PxOnly); }
  catch { ok = false; }
  return { ok, reason: ok ? null : 'kernel_sig verification failed', kernelMsg };
}

// ---- validateLpBond ----

export function validateLpBond({
  payload, farm, inputCommitment,
  currentConfirmationHeight, opReturnData, bulletproofVerify,
}) {
  if (!farm) return { valid: false, reason: 'farm not registered' };
  if (typeof bulletproofVerify !== 'function') {
    throw new Error('validateLpBond: bulletproofVerify is required');
  }
  if (inputCommitment === undefined) {
    throw new Error('validateLpBond: inputCommitment is required');
  }
  let env;
  try { env = decodeLpBond(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  if (!(opReturnData instanceof Uint8Array) || opReturnData.length !== 32) {
    return { valid: false, reason: 'missing or malformed vout[0] OP_RETURN data' };
  }
  const envelopeHash = sha256(payload);
  if (!bytesEqual(opReturnData, envelopeHash)) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }
  if (!bytesEqual(env.farmId, farm.farm_id)) {
    return { valid: false, reason: 'farm_id mismatch' };
  }

  // Pre-conditions.
  if (currentConfirmationHeight < 3) {
    return { valid: false, reason: 'currentConfirmationHeight < 3 (no canonical state yet)' };
  }
  const canonicalHeight = currentConfirmationHeight - 3 > farm.end_height
    ? farm.end_height
    : currentConfirmationHeight - 3;

  // Farm-not-exhausted (must be bondable through at least one reward block).
  if (currentConfirmationHeight >= farm.end_height) {
    return { valid: false, reason: 'farm exhausted (currentConfirmationHeight >= end_height)' };
  }

  // Min-bond dust floor.
  if (env.bondAmount < AMM_FARM_MIN_BOND) {
    return { valid: false, reason: `bond_amount ${env.bondAmount} < AMM_FARM_MIN_BOND ${AMM_FARM_MIN_BOND}` };
  }

  // Freshness check.
  const stalenessFloor = canonicalHeight - AMM_FARM_VIEW_STALENESS;
  if (env.bondViewHeight < stalenessFloor) {
    return { valid: false, reason: `bond_view_height ${env.bondViewHeight} < canonical-staleness ${stalenessFloor}` };
  }

  // Crystallize farm against canonical_height (clone so the caller decides
  // when to commit the new state — keeps the validator pure-functional).
  const farmCopy = { ...farm };
  crystallizeFarm(farmCopy, canonicalHeight);
  if (env.entryAccPerShare !== farmCopy.acc_reward_per_share) {
    return {
      valid: false,
      reason: `entry_acc_per_share mismatch (got ${env.entryAccPerShare}, canonical ${farmCopy.acc_reward_per_share})`,
    };
  }

  // Input commit.
  let inputCommitmentBytes;
  if (inputCommitment instanceof Uint8Array) {
    if (inputCommitment.length !== 33) return { valid: false, reason: 'inputCommitment must be 33-byte compressed point' };
    inputCommitmentBytes = inputCommitment;
  } else if (typeof inputCommitment.toRawBytes === 'function') {
    inputCommitmentBytes = inputCommitment.toRawBytes(true);
  } else {
    return { valid: false, reason: 'inputCommitment must be ProjectivePoint or Uint8Array(33)' };
  }

  // Bulletproof m=1.
  let cChangePt;
  if (isNoChangeSentinel(env.cChangeOrSentinel)) {
    cChangePt = ZERO;
  } else {
    try { cChangePt = secp.ProjectivePoint.fromHex(bytesToHex(env.cChangeOrSentinel)); }
    catch (e) { return { valid: false, reason: `cChangeOrSentinel decode: ${e.message}` }; }
  }
  if (!bulletproofVerify([cChangePt], env.rangeProof)) {
    return { valid: false, reason: 'bulletproof verification failed' };
  }

  // bond_msg + bonder_sig.
  const bondMsg = buildLpBondMsg({
    farmId: env.farmId,
    bonderPubkey: env.bonderPubkey,
    bondAmount: env.bondAmount,
    entryAccPerShare: env.entryAccPerShare,
    bondViewHeight: env.bondViewHeight,
    envelopeHash,
  });
  const bonderXOnly = env.bonderPubkey.subarray(1);
  let bonderOk;
  try { bonderOk = verifySchnorr(env.bonderSig, bondMsg, bonderXOnly); }
  catch { bonderOk = false; }
  if (!bonderOk) return { valid: false, reason: 'bonder_sig verification failed' };

  // Bond record (caller fills bond_id from vout[1].outpoint post-confirmation).
  const bondRecord = {
    farm_id: env.farmId,
    bond_amount: env.bondAmount,
    entry_acc_per_share: env.entryAccPerShare,
    bonder_pubkey: env.bonderPubkey,
    bond_height: currentConfirmationHeight,
  };

  // Build the new farm state for the caller to commit.
  const newFarm = {
    ...farmCopy,
    total_bonded: farmCopy.total_bonded + env.bondAmount,
  };

  const kernelMsgInfo = {
    lpAssetId: farm.lp_asset_id,
    cChangeOrSentinel: env.cChangeOrSentinel,
    bondAmount: env.bondAmount,
    inputCommitmentBytes,
  };

  return {
    valid: true,
    newFarm,
    bondRecord,
    kernelMsgInfo,
    bondMsg,
    canonicalHeight,
    envelopeHash,
  };
}

export function verifyLpBondKernelSig({
  envelope, lpAssetId,
  bonderInputOutpointTxid, bonderInputOutpointVout,
  inputCommitment,
}) {
  const kernelMsg = buildLpBondKernelMsg({
    lpAssetId,
    bonderInputOutpointTxid,
    bonderInputOutpointVout,
    cChangeOrSentinel: envelope.cChangeOrSentinel,
    bondAmount: envelope.bondAmount,
  });
  const P = kernelVerifyPoint({
    cChangeOrSentinel: envelope.cChangeOrSentinel,
    cInSecp: inputCommitment,
    burnedAmount: envelope.bondAmount,
  });
  if (P.equals(ZERO)) {
    return { ok: false, reason: 'kernel verifier key is point at infinity (would accept any sig)' };
  }
  const PxOnly = pointToBytes(P).subarray(1);
  let ok;
  try { ok = verifySchnorr(envelope.kernelSig, kernelMsg, PxOnly); }
  catch { ok = false; }
  return { ok, reason: ok ? null : 'kernel_sig verification failed', kernelMsg };
}

// ---- validateLpUnbond ----

export function validateLpUnbond({
  payload, farm, bondRecord, currentConfirmationHeight, opReturnData,
}) {
  if (!farm) return { valid: false, reason: 'farm not registered' };
  if (!bondRecord) return { valid: false, reason: 'bond record not found for bond_id' };
  let env;
  try { env = decodeLpUnbond(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  if (!(opReturnData instanceof Uint8Array) || opReturnData.length !== 32) {
    return { valid: false, reason: 'missing or malformed vout[0] OP_RETURN data' };
  }
  const envelopeHash = sha256(payload);
  if (!bytesEqual(opReturnData, envelopeHash)) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }
  if (!bytesEqual(env.farmId, farm.farm_id)) {
    return { valid: false, reason: 'farm_id mismatch' };
  }
  if (!bytesEqual(env.farmId, bondRecord.farm_id)) {
    return { valid: false, reason: 'bond.farm_id does not match envelope.farm_id (cross-farm bond_id)' };
  }
  if (!bytesEqual(env.unbonderPubkey, bondRecord.bonder_pubkey)) {
    return { valid: false, reason: 'unbonder_pubkey != bond.bonder_pubkey' };
  }
  if (currentConfirmationHeight < 3) {
    return { valid: false, reason: 'currentConfirmationHeight < 3 (no canonical state yet)' };
  }

  const canonicalHeight = currentConfirmationHeight - 3 > farm.end_height
    ? farm.end_height
    : currentConfirmationHeight - 3;
  const stalenessFloor = canonicalHeight - AMM_FARM_VIEW_STALENESS;
  if (env.exitViewHeight < stalenessFloor) {
    return { valid: false, reason: `exit_view_height ${env.exitViewHeight} < canonical-staleness ${stalenessFloor}` };
  }

  const farmCopy = { ...farm };
  crystallizeFarm(farmCopy, canonicalHeight);
  if (env.exitAccPerShare !== farmCopy.acc_reward_per_share) {
    return {
      valid: false,
      reason: `exit_acc_per_share mismatch (got ${env.exitAccPerShare}, canonical ${farmCopy.acc_reward_per_share})`,
    };
  }
  // Pending reward computation. exit_acc must be >= entry_acc — equality is
  // fine (no emission window since bond), but lower would imply farm state
  // corruption.
  if (env.exitAccPerShare < bondRecord.entry_acc_per_share) {
    return { valid: false, reason: 'exit_acc_per_share < entry_acc_per_share (farm state corruption)' };
  }
  const delta = env.exitAccPerShare - bondRecord.entry_acc_per_share;
  const pending = (bondRecord.bond_amount * delta) >> ACC_FIXED_POINT_SHIFT;
  const payout = pending > farmCopy.treasury_remaining ? farmCopy.treasury_remaining : pending;
  if (env.rewardAmount !== payout) {
    return {
      valid: false,
      reason: `reward_amount mismatch (got ${env.rewardAmount}, expected payout ${payout} = min(pending ${pending}, treasury_remaining ${farmCopy.treasury_remaining}))`,
    };
  }

  // Public opening sanity: lp_return_r and reward_r must be valid scalars
  // (< secp_n, non-zero — zero would yield an unhidden commit C = amount · H,
  // leaking nothing further than what's already cleartext but still bad
  // hygiene for downstream consumers).
  const lpReturnRScalar = bytesToBigintBE(env.lpReturnR);
  if (lpReturnRScalar === 0n) return { valid: false, reason: 'lpReturnR is zero (degenerate blinding)' };
  if (lpReturnRScalar >= SECP_N) return { valid: false, reason: 'lpReturnR >= n_secp' };
  const rewardRScalar = bytesToBigintBE(env.rewardR);
  if (env.rewardAmount > 0n) {
    if (rewardRScalar === 0n) return { valid: false, reason: 'rewardR is zero (degenerate blinding)' };
    if (rewardRScalar >= SECP_N) return { valid: false, reason: 'rewardR >= n_secp' };
  }

  // BIP-340 unbonder sig.
  const unbondMsg = buildLpUnbondMsg({
    farmId: env.farmId,
    bondId: env.bondId,
    unbonderPubkey: env.unbonderPubkey,
    exitAccPerShare: env.exitAccPerShare,
    exitViewHeight: env.exitViewHeight,
    rewardAmount: env.rewardAmount,
    lpReturnR: env.lpReturnR,
    rewardR: env.rewardR,
    envelopeHash,
  });
  const unbonderXOnly = env.unbonderPubkey.subarray(1);
  let unbonderOk;
  try { unbonderOk = verifySchnorr(env.unbonderSig, unbondMsg, unbonderXOnly); }
  catch { unbonderOk = false; }
  if (!unbonderOk) return { valid: false, reason: 'unbonder_sig verification failed' };

  // Compute the validator-decreed output commitments.
  const cLpReturn = pedersenCommit(bondRecord.bond_amount, lpReturnRScalar);
  const cReward = env.rewardAmount === 0n
    ? null
    : pedersenCommit(env.rewardAmount, rewardRScalar);

  const newFarm = {
    ...farmCopy,
    total_bonded: farmCopy.total_bonded - bondRecord.bond_amount,
    treasury_remaining: farmCopy.treasury_remaining - env.rewardAmount,
  };

  const receipts = [
    {
      kind: 'lp_return',
      asset_id: farm.lp_asset_id,
      amount: bondRecord.bond_amount,
      commitment: pointToBytes(cLpReturn),
      r: env.lpReturnR,
      recipient_pubkey: env.unbonderPubkey,
      vout: 1,
    },
  ];
  if (env.rewardAmount > 0n) {
    receipts.push({
      kind: 'farm_reward',
      asset_id: farm.reward_asset_id,
      amount: env.rewardAmount,
      commitment: pointToBytes(cReward),
      r: env.rewardR,
      recipient_pubkey: env.unbonderPubkey,
      vout: 2,
    });
  }

  return {
    valid: true,
    newFarm,
    receipts,
    unbondMsg,
    canonicalHeight,
    envelopeHash,
  };
}

// =========================================================================
// In-memory state machine
// =========================================================================
//
// FarmState mirrors what the worker holds in KV: a map of farms by
// farm_id and a map of bond records by bond_id. Tests apply envelopes
// against this to verify end-to-end behaviour without a real chain.
//
// Conservation invariants enforced on every apply call.

export class FarmState {
  constructor() {
    this.farms = new Map();         // farm_id_hex -> farm
    this.bonds = new Map();         // bond_id_hex -> bondRecord
    this.bondsByBonder = new Map(); // bonder_pubkey_hex -> Set<bond_id_hex>
  }

  getFarm(farmId) {
    return this.farms.get(bytesToHex(asBytes(farmId, 32, 'farmId')));
  }
  getBond(bondId) {
    return this.bonds.get(bytesToHex(asBytes(bondId, 36, 'bondId')));
  }
  bondsForBonder(pubkey) {
    const ids = this.bondsByBonder.get(bytesToHex(asBytes(pubkey, 33, 'pubkey'))) || new Set();
    return [...ids].map(h => this.bonds.get(h)).filter(Boolean);
  }

  applyFarmInit(farm) {
    const key = bytesToHex(farm.farm_id);
    if (this.farms.has(key)) throw new Error('duplicate farm_id');
    this.farms.set(key, { ...farm });
  }

  applyLpBond({ newFarm, bondRecord, bondId }) {
    const fKey = bytesToHex(newFarm.farm_id);
    if (!this.farms.has(fKey)) throw new Error('farm not present');
    const bKey = bytesToHex(asBytes(bondId, 36, 'bondId'));
    if (this.bonds.has(bKey)) throw new Error('duplicate bond_id');
    this.farms.set(fKey, { ...newFarm });
    this.bonds.set(bKey, { ...bondRecord, bond_id: asBytes(bondId, 36, 'bondId') });
    const pKey = bytesToHex(bondRecord.bonder_pubkey);
    if (!this.bondsByBonder.has(pKey)) this.bondsByBonder.set(pKey, new Set());
    this.bondsByBonder.get(pKey).add(bKey);
    this.checkInvariants(newFarm);
  }

  applyLpUnbond({ newFarm, bondId }) {
    const fKey = bytesToHex(newFarm.farm_id);
    if (!this.farms.has(fKey)) throw new Error('farm not present');
    const bKey = bytesToHex(asBytes(bondId, 36, 'bondId'));
    const prev = this.bonds.get(bKey);
    if (!prev) throw new Error('bond not present');
    this.farms.set(fKey, { ...newFarm });
    this.bonds.delete(bKey);
    const pKey = bytesToHex(prev.bonder_pubkey);
    const set = this.bondsByBonder.get(pKey);
    if (set) {
      set.delete(bKey);
      if (set.size === 0) this.bondsByBonder.delete(pKey);
    }
    this.checkInvariants(newFarm);
  }

  // Conservation invariants 1, 2, 5 from SPEC-AMM-FARM-AMENDMENT §"Conservation invariants".
  // Invariants 3 (LP-asset cross-cycle) and 4 (no-accrual-without-depth)
  // are enforced by the validator itself; the state machine checks the
  // state-level invariants here.
  checkInvariants(farm) {
    // Invariant 2: total_bonded = sum_of_outstanding_bond_records.bond_amount
    let sumBonded = 0n;
    for (const b of this.bonds.values()) {
      if (bytesEqual(b.farm_id, farm.farm_id)) sumBonded += b.bond_amount;
    }
    if (sumBonded !== farm.total_bonded) {
      throw new Error(`invariant 2 violated: total_bonded ${farm.total_bonded} != sum_bond_records ${sumBonded}`);
    }
    // Invariant 5: treasury_remaining <= reward_total (always, structurally — payout <= treasury_remaining).
    if (farm.treasury_remaining > farm.reward_total) {
      throw new Error(`invariant 5 violated: treasury_remaining ${farm.treasury_remaining} > reward_total ${farm.reward_total}`);
    }
  }
}
