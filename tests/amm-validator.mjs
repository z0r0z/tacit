// Reference indexer validator for AMM envelopes (T_LP_ADD, T_LP_REMOVE,
// T_SWAP_BATCH). Mirrors AMM.md §"SPEC.md integration plan: §5.5" extension
// branches and §"Indexer determinism rules". Pure JS, no Bitcoin layer —
// callers must pre-extract the on-chain context (vout[0] OP_RETURN data,
// input Pedersen commitments, vin/vout layout).
//
// The Groth16 proof verification is delegated to an injected verifier. In
// production the verifier is snarkjs.groth16.verify(vk, publicSignals, proof)
// under the pool's vk_cid; pass it as `groth16Verify`. Callers MUST either
// pass a real verifier function or the explicit SKIP_GROTH16_VERIFY_UNSAFE
// sentinel — leaving it undefined throws. The sentinel exists only for
// pre-ceremony reference-harness use (no Phase 2 zkey yet) and unit tests;
// any production caller passing it is misconfigured and its envelopes
// should be treated as unverified.

import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes,
} from './bulletproofs.mjs';

import { decodeLpAdd, decodeLpRemove, decodeSwapBatch, decodeProtocolFeeClaim } from './amm-envelope.mjs';
import { derivePoolId, deriveLpAssetId, canonicalAssetPair } from './amm-asset.mjs';
import { verifyXCurve } from './amm-sigma-xcurve.mjs';
import { lpAddKernelVerify, lpRemoveKernelVerify } from './amm-kernel.mjs';
import {
  solveClearing, applyBatch, amountOutForTrader,
  lpAddShares, lpInitShares, lpRemoveOutputs,
} from './amm-clearing.mjs';
import { computeEnvelopeHash, deriveIntentId, buildIntentMsg, verifyIntent } from './amm-intent.mjs';
import { verifyMinLiqOutput } from './amm-min-liq.mjs';
import { extractLauncherPubkey } from './amm-jcs.mjs';
import { P_FR } from './amm-bjj.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';
import {
  isZeroAddress as isProtocolFeeAddressZero,
  crystallizeProtocolFee, computeProtocolShares,
  buildProtocolFeeClaimMsgWith,
} from './amm-protocol-fee.mjs';

// T_SWAP_VAR (opcode 0x32) — per-trade variable-amount swap mode. Reuses
// CXFER N=2 cryptography (Pedersen + bulletproof + kernel sig) rather than
// the batched Groth16 path of T_SWAP_BATCH. No ceremony coupling: ships
// alongside the AMM v1 surface without depending on the Phase 2 setup. See
// SPEC.md §5.16.3 (or spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md until
// merged) for the wire format and validator obligations.
//
// Re-exported here so integrators have a single canonical import path for
// every AMM-opcode validator. The implementation lives in swap-var.mjs to
// keep amm-validator.mjs's existing scope (LP + batched swap + protocol
// fee) focused.
export {
  validateSwapVar,
  decodeSwapVar,
  encodeSwapVar,
  computeSwapVarEnvelopeHash,
  curveDeltaOut,
  buildTickFan,
  buildSwapVarIntentMsg,
  buildSwapVarKernelMsg,
  deriveSwapVarReceiptScalar,
  deriveSwapVarReceiptPubkey,
  deriveSwapVarChangeScalar,
  deriveSwapVarTipScalar,
  OPCODE_T_SWAP_VAR,
  NO_CHANGE_SENTINEL,
} from './swap-var.mjs';

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function pointFromCompressed(bytes) {
  return secp.ProjectivePoint.fromHex(bytesToHex(bytes));
}

// Sentinel a caller passes when they intentionally want to skip Groth16
// verification — only legitimate use is the pre-ceremony reference harness
// and unit tests that do not exercise the SNARK path. Production indexers
// MUST pass a real verifier. Leaving `groth16Verify` undefined throws.
//
// Defense-in-depth: when NODE_ENV === 'production', this sentinel is
// REFUSED — production indexers must provide a real verifier or the
// validator hard-fails. In non-prod environments a one-time stderr
// warning is emitted so a developer can't accidentally let SKIP slip
// into a deployed build.
export const SKIP_GROTH16_VERIFY_UNSAFE = Symbol('tacit-amm-skip-groth16-verify-unsafe');

let _skipWarned = false;
function resolveGroth16Verify(arg, fnName) {
  if (arg === SKIP_GROTH16_VERIFY_UNSAFE) {
    // Hard refusal in production — the SKIP path defeats settler-binding
    // soundness (the constant-product check alone admits any settler-
    // favored split that satisfies the curve + Pedersen identity).
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') {
      throw new Error(
        `${fnName}: SKIP_GROTH16_VERIFY_UNSAFE refused in production ` +
        `(NODE_ENV=production). Pass a real Groth16 verifier function.`,
      );
    }
    if (!_skipWarned && typeof process !== 'undefined' && process.stderr) {
      _skipWarned = true;
      process.stderr.write(
        '[tacit-amm] WARNING: SKIP_GROTH16_VERIFY_UNSAFE in use — ' +
        'soundness disabled, dev/test only. Refused if NODE_ENV=production.\n',
      );
    }
    return null;
  }
  if (typeof arg === 'function') return arg;
  throw new Error(
    `${fnName}: groth16Verify is required (pass a verifier function or ` +
    `SKIP_GROTH16_VERIFY_UNSAFE for pre-ceremony reference use)`,
  );
}

// =========================================================================
// vk_cid integrity self-check
// =========================================================================
//
// Closes the "misconfigured IPFS gateway returns malicious vk bytes" hazard:
// an indexer that fetches the pool's pinned verifying-key bytes from any
// content-addressable store MUST recompute the CID from those bytes and
// verify it matches `pool.vk_cid` before passing the vk to snarkjs.
//
// V1 canonical format for `vk_cid` is **CIDv1 with raw codec + sha2-256
// multihash, multibase-base32 lowercase no-padding** (i.e., starts with
// "bafkrei..."). This matches IPFS's standard for content-addressed
// non-IPLD content (the most common form for static binary artifacts
// pinned by content-hash).
//
// Construction (canonical, byte-for-byte reproducible by every indexer):
//   multihash  = 0x12 (sha2-256 code) || 0x20 (length=32) || sha256(vk_bytes)
//   cid_bytes  = 0x01 (CIDv1) || 0x55 (raw codec) || multihash
//   cid_string = "b" || base32_lowercase_no_padding(cid_bytes)
//
// Total cid_bytes: 36 bytes; cid_string: 59 chars (1 prefix + 58 base32).

const _B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function base32EncodeLowercase(bytes) {
  let out = '';
  let buf = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += _B32_ALPHABET[(buf >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += _B32_ALPHABET[(buf << (5 - bits)) & 0x1f];
  }
  return out;
}

// Returns the canonical V1 vk_cid string for the given vk bytes. Exported so
// that ceremony coordinators + indexers + the dapp all derive identical
// CIDs from identical vk bytes — no implementation drift on this layer.
export function deriveVkCid(vkBytes) {
  if (!(vkBytes instanceof Uint8Array)) {
    throw new Error('deriveVkCid: vkBytes must be Uint8Array');
  }
  const digest = sha256(vkBytes);          // 32 bytes
  const cidBytes = new Uint8Array(36);
  cidBytes[0] = 0x01;                       // CIDv1
  cidBytes[1] = 0x55;                       // raw codec (no IPLD interpretation)
  cidBytes[2] = 0x12;                       // multihash code: sha2-256
  cidBytes[3] = 0x20;                       // multihash digest length: 32
  cidBytes.set(digest, 4);
  return 'b' + base32EncodeLowercase(cidBytes);
}

// Returns true iff the SHA-256 of `vkBytes` matches the content-hash encoded
// inside `vkCidString` (V1 canonical CIDv1 raw sha2-256 multibase-base32).
//
// V1 indexers MUST call this before passing vk bytes to snarkjs:
//
//   const vkBytes = await ipfsGateway.fetchByCid(pool.vk_cid);
//   if (!verifyVkCidBinding(vkBytes, pool.vk_cid)) {
//     throw new Error('vk_cid integrity check failed — refusing to verify proofs');
//   }
//   // ... only now is it safe to construct the verifier under these vk bytes
//
// Returns false on any malformation rather than throwing, so caller can
// fail-closed without try/catch boilerplate.
export function verifyVkCidBinding(vkBytes, vkCidString) {
  if (!(vkBytes instanceof Uint8Array)) return false;
  if (typeof vkCidString !== 'string') return false;
  let expected;
  try { expected = deriveVkCid(vkBytes); }
  catch { return false; }
  return expected === vkCidString;
}

// =========================================================================
// Canonical Groth16 publicSignals serialization
// =========================================================================
//
// The validator passes the decoded envelope object `env` and the pool state
// to an injected `groth16Verify` callback; the callback is then responsible
// for serializing those into the flat 123-element BN254-Fr-decimal-string
// array that `snarkjs.groth16.verify` consumes. Two independent indexers
// MUST produce byte-identical publicSignals arrays from the same `(env,
// pool)` inputs, otherwise their proof verifications diverge silently.
//
// This helper is the canonical serialization. AMM.md §6 ("Groth16 public-
// input vector") is the spec-side authority; this function is its byte-
// for-byte reference impl. Dapp provers, worker indexers, and third-party
// re-implementations MUST agree with this output exactly.
//
// Layout (123 signals total, N_MAX = 16):
//   [0]       pool_id_fr = SHA256(pool.pool_id) mod p_Fr        (32-byte hash reduced into Fr)
//   [1]       R_A_pre
//   [2]       R_B_pre
//   [3]       delta_A_net_sign       (0 positive / 1 negative)
//   [4]       delta_A_net_magnitude  (u64)
//   [5]       delta_B_net_sign
//   [6]       delta_B_net_magnitude  (u64)
//   [7]       tip_A_amount
//   [8]       tip_B_amount
//   [9]       fee_bps                (0..1000)
//   [10]      n_intents              (0..16)
//   [11+5i+0..3]  direction_i, C_in_BJJ_u_i, C_in_BJJ_v_i, min_out_i, tip_amount_i  (i ∈ [0,16))
//   [11+80+2i+0..1] C_out_BJJ_u_i, C_out_BJJ_v_i  (i ∈ [0,16))
//
// Padded intents (i ≥ n_intents) use direction=0, C_in_BJJ=(0,1), min_out=0,
// tip_amount=0. Padded receipts use C_out_BJJ=(0,1).
export const PUBLIC_SIGNALS_SWAP_BATCH_LENGTH = 123;
const _N_MAX = 16;
const _BJJ_IDENTITY_U = '0';
const _BJJ_IDENTITY_V = '1';

function _fr(x) {
  // Coerce u64/u32/u16/u8 BigInt or number to decimal string.
  if (typeof x === 'bigint') return x.toString();
  if (typeof x === 'number') return BigInt(x).toString();
  if (typeof x === 'string') return x;
  throw new Error(`_fr: unsupported type ${typeof x}`);
}
function _bytesToFr(bytes) {
  // Read 32-byte buffer as a big-endian integer, reduce mod p_Fr.
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error('_bytesToFr requires a 32-byte Uint8Array');
  }
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return (n % P_FR).toString();
}

export function derivePoolIdFr(poolId) {
  return _bytesToFr(sha256(poolId));
}

export function buildPublicSignalsSwapBatch(env, pool) {
  if (!pool || !(pool.pool_id instanceof Uint8Array) || pool.pool_id.length !== 32) {
    throw new Error('buildPublicSignalsSwapBatch: pool.pool_id must be a 32-byte Uint8Array');
  }
  if (!env || !Array.isArray(env.intents) || !Array.isArray(env.receipts)) {
    throw new Error('buildPublicSignalsSwapBatch: env.intents and env.receipts must be arrays');
  }
  if (env.intents.length > _N_MAX) {
    throw new Error(`buildPublicSignalsSwapBatch: env.intents.length ${env.intents.length} > N_MAX ${_N_MAX}`);
  }

  const n = env.intents.length;
  const sigs = new Array(PUBLIC_SIGNALS_SWAP_BATCH_LENGTH);

  // Globals (11)
  sigs[0]  = derivePoolIdFr(pool.pool_id);
  sigs[1]  = _fr(env.R_A_pre ?? pool.reserve_A);
  sigs[2]  = _fr(env.R_B_pre ?? pool.reserve_B);
  const dA = env.deltaANetSigned ?? 0n;
  const dB = env.deltaBNetSigned ?? 0n;
  sigs[3]  = _fr(dA < 0n ? 1n : 0n);
  sigs[4]  = _fr(dA < 0n ? -dA : dA);
  sigs[5]  = _fr(dB < 0n ? 1n : 0n);
  sigs[6]  = _fr(dB < 0n ? -dB : dB);
  sigs[7]  = _fr(env.tipAAmount ?? 0n);
  sigs[8]  = _fr(env.tipBAmount ?? 0n);
  sigs[9]  = _fr(env.feeBpsAtSettle ?? pool.fee_bps);
  sigs[10] = _fr(BigInt(n));

  // Per-intent (5 × 16)
  for (let i = 0; i < _N_MAX; i++) {
    const off = 11 + 5 * i;
    if (i < n) {
      const it = env.intents[i];
      sigs[off + 0] = _fr(BigInt(it.direction));
      // C_in_BJJ is packed as 32 bytes; decode the (u, v) coordinates.
      // For publicSignals, we need u and v as Fr-string decimal each.
      // The codec stores cInBjj as packed bytes; the caller may have already
      // unpacked them. Accept both forms: if env supplies cInBjjU/cInBjjV
      // pre-parsed, use them; else require unpacking by the caller.
      if (it.cInBjjU === undefined || it.cInBjjV === undefined) {
        throw new Error(`intent[${i}] must provide cInBjjU and cInBjjV (unpack via amm-bjj.unpackPoint first)`);
      }
      sigs[off + 1] = _fr(it.cInBjjU);
      sigs[off + 2] = _fr(it.cInBjjV);
      sigs[off + 3] = _fr(it.minOut);
      sigs[off + 4] = _fr(it.tipAmount);
    } else {
      sigs[off + 0] = '0';
      sigs[off + 1] = _BJJ_IDENTITY_U;
      sigs[off + 2] = _BJJ_IDENTITY_V;
      sigs[off + 3] = '0';
      sigs[off + 4] = '0';
    }
  }

  // Per-receipt (2 × 16)
  for (let i = 0; i < _N_MAX; i++) {
    const off = 11 + 5 * _N_MAX + 2 * i;
    if (i < n) {
      const r = env.receipts[i];
      if (r.cOutBjjU === undefined || r.cOutBjjV === undefined) {
        throw new Error(`receipt[${i}] must provide cOutBjjU and cOutBjjV (unpack via amm-bjj.unpackPoint first)`);
      }
      sigs[off + 0] = _fr(r.cOutBjjU);
      sigs[off + 1] = _fr(r.cOutBjjV);
    } else {
      sigs[off + 0] = _BJJ_IDENTITY_U;
      sigs[off + 1] = _BJJ_IDENTITY_V;
    }
  }

  return sigs;
}

// Minimum blocks between POOL_INIT confirmation and the first variant-0
// LP_ADD. During this window only swaps are accepted, so arbitrageurs can
// correct any misprice before naive LPs are exposed. The founder bears
// the arbitrage cost of their own initial seed if the ratio was mispriced.
// Six blocks ≈ 1 hour at Bitcoin's average block time.
export const AMM_INITIAL_LP_LOCK_BLOCKS = 6;

// Confidentiality-protection: AMM swap batches expose (Δa_net, Δb_net) on
// chain. With N=1 (a solo intent), those public deltas equal the trader's
// exact swap amount — amount confidentiality collapses. By default the
// indexer REJECTS N=1 batches: settlers must wait to accumulate ≥ 2 intents
// per pool per block. Pools that prefer liveness over confidentiality can
// opt in by setting POOL_CAP_SOLO_INTENT_ALLOWED in their capability flags
// at POOL_INIT time.
//
// Solo-intent privacy default (pro-trader / pro-confidentiality).
export const AMM_MIN_BATCH_SIZE = 2;

// Pool capability-flags bitmap (u8). Default 0 = standard V1 pool with
// confidentiality-preserving defaults. Adding flags is additive; flag bits
// are immutable after POOL_INIT.
//
// Bit 0 (0x01) is reserved by AMM.md §"POOL_INIT" for the LP_ADD
// T_RANGE_ATTEST gating mode (gated pools require an attestation under
// scope=pool_id for LP_ADD). The validator side of that gate is not yet
// shipped; the bit is reserved here so the two flag spaces don't collide.
export const POOL_CAP_REQUIRES_LP_RANGE_ATTEST = 0x01;
export const POOL_CAP_SOLO_INTENT_ALLOWED      = 0x02;
// Reserved for future flags (0x04, 0x08, ..., 0x80). Adding a new flag bit
// is a soft fork (old indexers see unknown flag and SHOULD reject pools
// that set it, lest they apply default-confidentiality rules to a pool
// the founder opted out of).

// Result shape:
//   { valid: true,  newPoolState, receipts: [...] }
//   { valid: false, reason: string }

// =========================================================================
// T_LP_ADD validator
// =========================================================================
//
// Inputs:
//   payload          : envelope bytes
//   pool             : current pool state (null for POOL_INIT variant=1)
//                        { pool_id, asset_A, asset_B, vk_cid, fee_bps,
//                          reserve_A, reserve_B, lp_total_shares,
//                          inclusion_arbiter_pubkeys, ... }
//   inputCommitmentsA: array of ProjectivePoint — asset-A input UTXOs consumed
//   inputCommitmentsB: array of ProjectivePoint — asset-B input UTXOs consumed
//   inputsA, inputsB : array of { txid, vout } — the same UTXOs as outpoints
//   metadataA, metadataB : per-asset metadata blob bytes (Uint8Array) or null,
//                          for launcher-gate verification on POOL_INIT
//   groth16Verify    : REQUIRED — function ({proof, publicSignals, pool, kind}) -> bool
//                        Pass SKIP_GROTH16_VERIFY_UNSAFE for the pre-ceremony
//                        reference-harness / unit-test path. Undefined throws.
//   currentHeight    : REQUIRED — block height envelope confirms at. Used to
//                        set pool.init_height on POOL_INIT and to enforce
//                        AMM_INITIAL_LP_LOCK_BLOCKS on variant-0 LP_ADD.
export function validateLpAdd({
  payload, pool,
  inputCommitmentsA, inputCommitmentsB,
  inputsA, inputsB,
  metadataA = null, metadataB = null,
  groth16Verify,
  currentHeight,
  vkBytes,                        // optional Uint8Array — if provided, integrity-checked against pool.vk_cid
}) {
  const verify = resolveGroth16Verify(groth16Verify, 'validateLpAdd');
  if (typeof currentHeight !== 'number' || currentHeight < 0) {
    throw new Error('validateLpAdd: currentHeight (u32) is required');
  }
  let env;
  try { env = decodeLpAdd(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  // Canonical asset ordering: assetA must be < assetB.
  for (let i = 0; i < 32; i++) {
    if (env.assetA[i] < env.assetB[i]) break;
    if (env.assetA[i] > env.assetB[i]) {
      return { valid: false, reason: 'assetA must be lexicographically smaller than assetB' };
    }
  }

  // Verify pool_id matches.
  const poolId = derivePoolId(env.assetA, env.assetB);

  // POOL_INIT path (variant 1): create pool. Otherwise require existing pool.
  if (env.variant === 1) {
    if (pool) return { valid: false, reason: 'POOL_INIT but pool already exists' };

    // Launcher gate (AMM.md §"Optional launcher gate").
    const gateA = metadataA ? extractLauncherPubkey(metadataA) : null;
    const gateB = metadataB ? extractLauncherPubkey(metadataB) : null;
    const gates = [gateA, gateB].filter(g => g !== null);
    if (gates.length > 0) {
      if (env.launcherSigs.length !== gates.length) {
        return { valid: false, reason: 'launcher_sig_count must match declared gates' };
      }
      // Build the launcher-gate message: SHA256("tacit-amm-launcher-gate-v1" || pool_id || vk_cid || fee_bps_LE)
      const vkCidBytes = new TextEncoder().encode(env.vkCid);
      const feeBpsLE = new Uint8Array(2);
      new DataView(feeBpsLE.buffer).setUint16(0, env.feeBps, true);
      const gateMsg = sha256(concatBytes(
        new TextEncoder().encode('tacit-amm-launcher-gate-v1'),
        poolId,
        vkCidBytes,
        feeBpsLE,
      ));
      // Verify each launcher sig — order: gateA first (if present), then gateB.
      // The spec is silent on the order; we adopt "ordered by asset_A's pubkey first".
      const orderedGates = [gateA, gateB].filter(g => g !== null);
      for (let i = 0; i < orderedGates.length; i++) {
        const pk = orderedGates[i];
        const xOnly = pk.subarray(1);
        if (!verifySchnorr(env.launcherSigs[i], gateMsg, xOnly)) {
          return { valid: false, reason: `launcher_sig[${i}] failed verification` };
        }
      }
    } else {
      if (env.launcherSigs.length !== 0) {
        return { valid: false, reason: 'no launcher gates declared but launcherSigs non-empty' };
      }
    }

    // Initial shares (Uniswap V2 convention): total = isqrt(deltaA · deltaB).
    let initShares;
    try { initShares = lpInitShares(env.deltaA, env.deltaB, 1000n); }
    catch (e) { return { valid: false, reason: `lpInitShares: ${e.message}` }; }
    if (initShares.founder_shares !== env.shareAmount) {
      return { valid: false, reason: `shareAmount mismatch: expected ${initShares.founder_shares}, got ${env.shareAmount}` };
    }

    // Per-asset kernel sigs.
    if (!verifyKernel(env, inputCommitmentsA, inputCommitmentsB, inputsA, inputsB, env.variant)) {
      return { valid: false, reason: 'kernel sig verification failed' };
    }
    if (!verifyXCurve(env.shareXcurveSigma, env.shareCSecp, env.shareCBJJ)) {
      return { valid: false, reason: 'share output sigma cross-curve binding failed' };
    }
    if (verify && !verify({ proof: env.proof, pool: { vk_cid: env.vkCid }, kind: 'LP_ADD_INIT' })) {
      return { valid: false, reason: 'Groth16 proof failed (POOL_INIT)' };
    }

    // Construct new pool state.
    const newPool = {
      pool_id: poolId,
      asset_A: env.assetA,
      asset_B: env.assetB,
      lp_asset_id: deriveLpAssetId(poolId),
      vk_cid: env.vkCid,
      ceremony_cid: env.ceremonyCid,
      fee_bps: env.feeBps,
      reserve_A: env.deltaA,
      reserve_B: env.deltaB,
      lp_total_shares: initShares.total_shares,
      inclusion_arbiter_pubkeys: env.arbiterPubkeys || [],
      inclusion_arbiter_threshold_m: env.arbiterThresholdM ?? 0,
      // Protocol fee (founder-set, immutable). All-zeros address = disabled.
      protocol_fee_address: env.protocolFeeAddress || new Uint8Array(33),
      protocol_fee_bps: env.protocolFeeBps || 0,
      protocol_fee_accrued: 0n,
      k_last: env.deltaA * env.deltaB,
      // First-LP misprice mitigation: lock external LP_ADD until
      // current_height ≥ init_height + AMM_INITIAL_LP_LOCK_BLOCKS so
      // arbitrageurs have time to correct any misprice in the seed ratio.
      init_height: currentHeight,
      // Pool capability flags (u8 bitmap). 0 = standard V1 pool.
      capability_flags: env.poolCapabilityFlags ?? 0,
    };
    return {
      valid: true,
      newPoolState: newPool,
      receipts: [
        { kind: 'lp_share_founder', amount: initShares.founder_shares, commitment: env.shareCSecp },
        { kind: 'lp_share_locked', amount: initShares.locked_shares, info: 'NUMS-locked at vout[1]' },
      ],
    };
  }

  // Standard LP_ADD (variant 0) — require existing pool.
  if (!pool) return { valid: false, reason: 'pool not registered' };
  if (!bytesEqual(pool.pool_id, poolId)) return { valid: false, reason: 'pool_id mismatch' };

  // First-LP misprice mitigation: variant-0 LP_ADD is locked for the first
  // AMM_INITIAL_LP_LOCK_BLOCKS confirmations after POOL_INIT. During this
  // window only swaps are accepted; arbitrage corrects any malicious seed
  // ratio before naive LPs can be exposed.
  if (typeof pool.init_height === 'number') {
    const unlockHeight = pool.init_height + AMM_INITIAL_LP_LOCK_BLOCKS;
    if (currentHeight < unlockHeight) {
      return {
        valid: false,
        reason: `pool in initial-LP lock window: currentHeight ${currentHeight} < unlockHeight ${unlockHeight} (init ${pool.init_height} + lock ${AMM_INITIAL_LP_LOCK_BLOCKS})`,
      };
    }
  }

  // Crystallize protocol fee before applying the add. No-op if pool has no
  // protocol fee, or if k has not grown since the last fee event. Dilutes
  // existing LPs proportionally; new LP joins against the crystallized S.
  const xPool = crystallizeProtocolFee(pool);

  // At-the-ratio check: deltaA / deltaB ≈ reserve_A / reserve_B.
  // share_amount = floor(min(deltaA · S / reserve_A, deltaB · S / reserve_B))
  // S here is the CRYSTALLIZED total — the LP must compute their envelope
  // against the same post-crystallization S.
  let expectedShares;
  try {
    expectedShares = lpAddShares(env.deltaA, env.deltaB, xPool.reserve_A, xPool.reserve_B, xPool.lp_total_shares);
  } catch (e) { return { valid: false, reason: `lpAddShares: ${e.message}` }; }
  // Zero-share guard. LP_ADD that rounds to zero shares is a
  // fee-burning no-op (LP pays Bitcoin fees, receives no shares); reject at
  // validator level so the wasted-fees UX failure becomes a clear envelope
  // rejection instead of a silent zero-credit. Encoder also rejects (defense
  // in depth at the wire layer).
  if (expectedShares === 0n) {
    return { valid: false, reason: 'shareAmount rounds to zero — deposit too small for current pool ratio' };
  }
  if (expectedShares !== env.shareAmount) {
    return { valid: false, reason: `shareAmount: expected ${expectedShares}, got ${env.shareAmount}` };
  }

  if (!verifyKernel(env, inputCommitmentsA, inputCommitmentsB, inputsA, inputsB, env.variant)) {
    return { valid: false, reason: 'kernel sig verification failed' };
  }
  if (!verifyXCurve(env.shareXcurveSigma, env.shareCSecp, env.shareCBJJ)) {
    return { valid: false, reason: 'share output sigma cross-curve binding failed' };
  }
  // vk_cid integrity self-check
  if (vkBytes !== undefined && xPool.vk_cid !== undefined) {
    if (!verifyVkCidBinding(vkBytes, xPool.vk_cid)) {
      return { valid: false, reason: 'vk_cid integrity check failed: deriveVkCid(vkBytes) != pool.vk_cid' };
    }
  }
  if (verify && !verify({ proof: env.proof, pool: xPool, kind: 'LP_ADD', vkBytes })) {
    return { valid: false, reason: 'Groth16 proof failed' };
  }

  const newReserveA = xPool.reserve_A + env.deltaA;
  const newReserveB = xPool.reserve_B + env.deltaB;
  return {
    valid: true,
    newPoolState: {
      ...xPool,
      reserve_A: newReserveA,
      reserve_B: newReserveB,
      lp_total_shares: xPool.lp_total_shares + env.shareAmount,
      k_last: newReserveA * newReserveB,
    },
    receipts: [{ kind: 'lp_share', amount: env.shareAmount, commitment: env.shareCSecp }],
  };
}

function verifyKernel(env, inputCommitmentsA, inputCommitmentsB, inputsA, inputsB, variant) {
  return lpAddKernelVerify({
    variant,
    poolId: derivePoolId(env.assetA, env.assetB),
    assetX: env.assetA,
    deltaX: env.deltaA,
    shareAmount: env.shareAmount,
    shareCSecpBytes: env.shareCSecp,
    inputsX: inputsA,
    inputCommitments: inputCommitmentsA,
    sig64: env.kernelSigA,
  }) && lpAddKernelVerify({
    variant,
    poolId: derivePoolId(env.assetA, env.assetB),
    assetX: env.assetB,
    deltaX: env.deltaB,
    shareAmount: env.shareAmount,
    shareCSecpBytes: env.shareCSecp,
    inputsX: inputsB,
    inputCommitments: inputCommitmentsB,
    sig64: env.kernelSigB,
  });
}

// =========================================================================
// T_LP_REMOVE validator
// =========================================================================
export function validateLpRemove({
  payload, pool,
  lpInputCommitments, lpInputs,
  groth16Verify,
  vkBytes,                        // optional Uint8Array — if provided, integrity-checked against pool.vk_cid
}) {
  const verify = resolveGroth16Verify(groth16Verify, 'validateLpRemove');
  let env;
  try { env = decodeLpRemove(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }
  if (!pool) return { valid: false, reason: 'pool not registered' };
  const poolId = derivePoolId(env.assetA, env.assetB);
  if (!bytesEqual(pool.pool_id, poolId)) return { valid: false, reason: 'pool_id mismatch' };

  // Crystallize protocol fee before applying the remove. Same V2-lazy
  // pattern as LP_ADD — diluting existing LPs by accrued fee before they
  // withdraw, so the burning LP gets only their non-fee proportion of
  // pool value.
  const xPool = crystallizeProtocolFee(pool);

  // Expected deltas: proportional withdrawal against the crystallized state.
  let expected;
  try { expected = lpRemoveOutputs(env.shareAmount, xPool.reserve_A, xPool.reserve_B, xPool.lp_total_shares); }
  catch (e) { return { valid: false, reason: `lpRemoveOutputs: ${e.message}` }; }
  if (expected.delta_a !== env.deltaA) {
    return { valid: false, reason: `deltaA: expected ${expected.delta_a}, got ${env.deltaA}` };
  }
  if (expected.delta_b !== env.deltaB) {
    return { valid: false, reason: `deltaB: expected ${expected.delta_b}, got ${env.deltaB}` };
  }

  // Kernel sig over lp-share input(s).
  const kernelOk = lpRemoveKernelVerify({
    poolId,
    shareAmount: env.shareAmount,
    deltaA: env.deltaA, deltaB: env.deltaB,
    recvACSecpBytes: env.recvACSecp,
    recvBCSecpBytes: env.recvBCSecp,
    lpInputs,
    lpInputCommitments,
    sig64: env.kernelSigLP,
  });
  if (!kernelOk) return { valid: false, reason: 'kernel sig verification failed' };

  // Sigma cross-curve bindings on both receipts.
  if (!verifyXCurve(env.recvAXcurveSigma, env.recvACSecp, env.recvACBJJ)) {
    return { valid: false, reason: 'asset-A receipt sigma binding failed' };
  }
  if (!verifyXCurve(env.recvBXcurveSigma, env.recvBCSecp, env.recvBCBJJ)) {
    return { valid: false, reason: 'asset-B receipt sigma binding failed' };
  }

  // vk_cid integrity self-check
  if (vkBytes !== undefined && xPool.vk_cid !== undefined) {
    if (!verifyVkCidBinding(vkBytes, xPool.vk_cid)) {
      return { valid: false, reason: 'vk_cid integrity check failed: deriveVkCid(vkBytes) != pool.vk_cid' };
    }
  }
  if (verify && !verify({ proof: env.proof, pool: xPool, kind: 'LP_REMOVE', vkBytes })) {
    return { valid: false, reason: 'Groth16 proof failed' };
  }

  const newReserveA = xPool.reserve_A - env.deltaA;
  const newReserveB = xPool.reserve_B - env.deltaB;
  return {
    valid: true,
    newPoolState: {
      ...xPool,
      reserve_A: newReserveA,
      reserve_B: newReserveB,
      lp_total_shares: xPool.lp_total_shares - env.shareAmount,
      k_last: newReserveA * newReserveB,
    },
    receipts: [
      { kind: 'lp_withdraw_A', amount: env.deltaA, commitment: env.recvACSecp },
      { kind: 'lp_withdraw_B', amount: env.deltaB, commitment: env.recvBCSecp },
    ],
  };
}

// =========================================================================
// T_SWAP_BATCH validator
// =========================================================================
//
// Inputs:
//   payload                  : envelope bytes
//   pool                     : current pool state (must be registered)
//   opReturnData             : 32-byte data from vout[0] OP_RETURN (or null if absent)
//   inputCommitmentsByIntent : array, parallel to intents — each entry is an
//                              array of ProjectivePoint commitments aggregated
//                              into C_in_secp for that intent's tacit input(s)
//   intentInputUtxos         : array, parallel to intents — each entry is the
//                              list of { txid, vout } outpoints consumed by
//                              that intent
//   receiveScripts           : array, parallel to intents — each entry is the
//                              trader's receive_scriptPubKey (Uint8Array)
//   currentHeight            : block height (for arbiter expected_height check)
//   groth16Verify            : REQUIRED — function or SKIP_GROTH16_VERIFY_UNSAFE
//   qualifyingSetResolver    : OPTIONAL — for arbiter-pinned pools, function
//                              (qualifyingSetHash) -> { intentIds: Array<Uint8Array(32)> }
//                              that fetches the canonical list bytes
//                              (content-addressed) and returns the intent_id
//                              set the arbiter signed. If omitted for an
//                              arbiter-pinned pool, mandatory-inclusion
//                              fails closed.
export function validateSwapBatch({
  payload, pool, opReturnData,
  inputCommitmentsByIntent, intentInputUtxos, receiveScripts,
  currentHeight,
  groth16Verify,
  qualifyingSetResolver = null,
  vkBytes,                        // optional Uint8Array — if provided, integrity-checked against pool.vk_cid
}) {
  if (!pool) return { valid: false, reason: 'pool not registered' };
  const verify = resolveGroth16Verify(groth16Verify, 'validateSwapBatch');
  const hasArbiter = (pool.inclusion_arbiter_pubkeys || []).length > 0;

  let env;
  try { env = decodeSwapBatch(payload, { hasArbiter }); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  // OP_RETURN binding: vout[0] data MUST equal SHA256(envelope_payload).
  if (!opReturnData) return { valid: false, reason: 'missing vout[0] OP_RETURN' };
  const expectedHash = computeEnvelopeHash(payload);
  if (!bytesEqual(opReturnData, expectedHash)) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }

  // pool_id consistency
  const poolId = derivePoolId(env.assetA, env.assetB);
  if (!bytesEqual(pool.pool_id, poolId)) return { valid: false, reason: 'pool_id mismatch' };
  if (env.feeBpsAtSettle !== pool.fee_bps) {
    return { valid: false, reason: 'fee_bps_at_settle != pool.fee_bps' };
  }

  // MIN_BATCH_SIZE confidentiality default. A batch of
  // size 1 reveals the trader's full swap amount via the public
  // (Δa_net, Δb_net) deltas. Reject N=1 unless the pool explicitly opted
  // in to solo-intent batches via POOL_CAP_SOLO_INTENT_ALLOWED.
  const poolFlags = pool.capability_flags ?? 0;
  const soloAllowed = (poolFlags & POOL_CAP_SOLO_INTENT_ALLOWED) !== 0;
  if (!soloAllowed && env.intents.length < AMM_MIN_BATCH_SIZE) {
    return {
      valid: false,
      reason: `batch size ${env.intents.length} < AMM_MIN_BATCH_SIZE ${AMM_MIN_BATCH_SIZE}; ` +
              `pool must set POOL_CAP_SOLO_INTENT_ALLOWED (0x02) to permit solo intents`,
    };
  }

  // Arbiter block enforcement (m-of-n threshold + mandatory inclusion).
  //   1. arbiter block present + expectedHeight matches currentHeight
  //   2. m matches pool's pinned threshold; signerIndices ascending distinct
  //   3. all m BIP-340 sigs verify against pinned pubkeys[signer_index]
  //   4. canonical list bytes (via qualifyingSetResolver) hash to
  //      env.arbiterBlock.qualifyingSetHash
  //   5. every intent_id in the canonical list appears in env.intents
  //
  // If qualifyingSetResolver is null and the pool has an arbiter, the
  // validator fails closed — there's no safe way to accept a swap from
  // an arbiter-pinned pool without verifying the inclusion rule.
  if (hasArbiter) {
    if (!env.arbiterBlock) return { valid: false, reason: 'arbiter block required by pool' };

    if (env.arbiterBlock.expectedHeight !== currentHeight) {
      return {
        valid: false,
        reason: `arbiter expectedHeight ${env.arbiterBlock.expectedHeight} != currentHeight ${currentHeight}`,
      };
    }

    const m = pool.inclusion_arbiter_threshold_m;
    if (env.arbiterBlock.m !== m) {
      return {
        valid: false,
        reason: `arbiter m mismatch: envelope ${env.arbiterBlock.m} vs pool ${m}`,
      };
    }
    if (!verifyArbiterSig(
      env.arbiterBlock.qualifyingSetHash,
      env.arbiterBlock.signerIndices,
      env.arbiterBlock.sigs,
      pool.inclusion_arbiter_pubkeys,
      m,
    )) {
      return { valid: false, reason: 'arbiter sigs did not verify against pinned pubkey set' };
    }

    if (typeof qualifyingSetResolver !== 'function') {
      return {
        valid: false,
        reason: 'arbiter-pinned pool requires qualifyingSetResolver to fetch canonical intent list',
      };
    }

    let qset;
    try { qset = qualifyingSetResolver(env.arbiterBlock.qualifyingSetHash); }
    catch (e) { return { valid: false, reason: `qualifyingSetResolver threw: ${e.message}` }; }
    if (!qset || !Array.isArray(qset.intentIds)) {
      return { valid: false, reason: 'qualifyingSetResolver returned no intentIds' };
    }

    // Verify the resolved list bytes hash to qualifying_set_hash.
    const recomputed = computeQualifyingSetHash({
      poolId,
      height: env.arbiterBlock.expectedHeight,
      intentIds: qset.intentIds,
    });
    if (!bytesEqual(recomputed, env.arbiterBlock.qualifyingSetHash)) {
      return { valid: false, reason: 'resolved canonical list does not hash to qualifying_set_hash' };
    }

    // Cache for membership check after intent_id derivation below.
    env._qsetIntentIds = qset.intentIds;
  } else {
    if (env.arbiterBlock) return { valid: false, reason: 'arbiter block present but pool has none pinned' };
  }

  // intent_id ascending order
  let prevIid = null;
  const intentIds = [];
  for (let i = 0; i < env.intents.length; i++) {
    const it = env.intents[i];
    // Reconstruct intent_msg from envelope-visible fields + provided trader inputs/scripts.
    if (i >= intentInputUtxos.length || i >= receiveScripts.length) {
      return { valid: false, reason: 'missing context for intent reconstruction' };
    }
    let intentMsg;
    try {
      intentMsg = buildIntentMsg({
        poolId, direction: it.direction, inputUtxos: intentInputUtxos[i],
        cInSecp: it.cInSecp, cInBjj: it.cInBjj, xcurveSigma: it.inXcurveSigma,
        receiveScriptPubKey: receiveScripts[i],
        minOut: it.minOut, tipAmount: it.tipAmount,
        // Tip-asset substitution: AMM.md §"Tip mechanics" §3 makes tip_asset
        // structurally equal to direction (tip on input side). buildIntentMsg
        // asserts this invariant; we pass direction as the
        // single source of truth. Any divergent value would fail sig-verify
        // below regardless.
        tipAsset: it.direction,
        expiryHeight: it.expiryHeight, traderPubkey: it.traderPubkey,
      });
    } catch (e) { return { valid: false, reason: `intent[${i}] msg build: ${e.message}` }; }

    const iid = deriveIntentId(intentMsg);
    if (prevIid) {
      // STRICTLY ascending: equal id == duplicate (defense-in-depth even
      // though Bitcoin's UTXO model already prevents same-outpoint reuse).
      let cmp = 0;
      for (let j = 0; j < 32; j++) {
        if (iid[j] < prevIid[j]) { cmp = -1; break; }
        if (iid[j] > prevIid[j]) { cmp = 1; break; }
      }
      if (cmp <= 0) {
        return {
          valid: false,
          reason: cmp === 0
            ? `duplicate intent_id at i=${i}`
            : `intents not in intent_id ascending order at i=${i}`,
        };
      }
    }
    prevIid = iid;
    intentIds.push(iid);

    // BIP-340 intent_sig verification (out-of-circuit per AMM.md).
    if (!verifyIntent(intentMsg, it.intentSig, it.traderPubkey)) {
      return { valid: false, reason: `intent[${i}] intent_sig failed` };
    }
    // Per-intent sigma cross-curve binding.
    if (!verifyXCurve(it.inXcurveSigma, it.cInSecp, it.cInBjj)) {
      return { valid: false, reason: `intent[${i}] sigma cross-curve failed` };
    }
    // Defense-in-depth: the trader's intent_sig binds `it.cInSecp` (their
    // claim about what their input UTXOs sum to). Verify that claim matches
    // the actual on-chain inputs the caller wired up for this intent slot.
    // The asset-level aggregate Pedersen check (below) catches mismatches
    // implicitly, but the failure mode there is global ("asset-A aggregate
    // Pedersen check failed") and doesn't pinpoint which intent diverged.
    // Checking per-intent here turns that into a precise diagnostic and
    // makes a forged-cInSecp intent_sig fail at the right slot.
    const intentInputs = inputCommitmentsByIntent[i];
    if (!Array.isArray(intentInputs) || intentInputs.length === 0) {
      return { valid: false, reason: `intent[${i}]: inputCommitmentsByIntent[${i}] missing` };
    }
    let inputSum = ZERO;
    for (const cp of intentInputs) inputSum = inputSum.add(cp);
    let claimedCInSecp;
    try { claimedCInSecp = pointFromCompressed(it.cInSecp); }
    catch (e) { return { valid: false, reason: `intent[${i}]: cInSecp decode: ${e.message}` }; }
    if (!inputSum.equals(claimedCInSecp)) {
      return { valid: false, reason: `intent[${i}]: Σ inputCommitmentsByIntent[${i}] != intent.cInSecp` };
    }
    // Expiry not lapsed.
    if (it.expiryHeight < currentHeight) {
      return { valid: false, reason: `intent[${i}] expired (height ${it.expiryHeight} < ${currentHeight})` };
    }
  }

  // Mandatory-inclusion check for arbiter-pinned pools: every intent_id in
  // the canonical qualifying list MUST appear in this envelope.
  if (hasArbiter && env._qsetIntentIds) {
    const envIdsHex = new Set(intentIds.map(b => bytesToHex(b)));
    for (let i = 0; i < env._qsetIntentIds.length; i++) {
      const need = env._qsetIntentIds[i];
      const needHex = bytesToHex(need instanceof Uint8Array ? need : hexToBytes(need));
      if (!envIdsHex.has(needHex)) {
        return {
          valid: false,
          reason: `mandatory-inclusion: qualifying intent_id ${needHex.slice(0, 16)}… missing from batch`,
        };
      }
    }
  }

  // Per-receipt sigma cross-curve bindings.
  for (let i = 0; i < env.receipts.length; i++) {
    const r = env.receipts[i];
    if (!verifyXCurve(r.outXcurveSigma, r.cOutSecp, r.cOutBjj)) {
      return { valid: false, reason: `receipt[${i}] sigma cross-curve failed` };
    }
  }

  // Re-run deterministic clearing solve and check declared deltas match.
  let X = 0n, Y = 0n;
  // Re-derive per-trader amount_in from BJJ commitments is impossible without
  // private witness; the Groth16 proof binds this. Here we verify the
  // public Pedersen identity instead (next).
  // Compute Δ_signed direction sign from envelope.
  const dA = env.deltaANetSigned, dB = env.deltaBNetSigned;

  // Chain-side aggregate Pedersen check (one per asset):
  //   Σ_{X→Y inputs} C_in_secp,i − Σ_{Y→X outputs} C_out_secp,i
  //     − tip_X_C_secp − delta_X_signed · H == R_net_X · G
  if (!checkAggregatePedersen({
    env,
    inputCommitmentsByIntent,
    assetXIsA: true,
    deltaXSigned: dA,
    tipXCSecp: env.tipACSecp,
    rNetX: env.rNetA,
  })) {
    return { valid: false, reason: 'asset-A aggregate Pedersen check failed' };
  }
  if (!checkAggregatePedersen({
    env,
    inputCommitmentsByIntent,
    assetXIsA: false,
    deltaXSigned: dB,
    tipXCSecp: env.tipBCSecp,
    rNetX: env.rNetB,
  })) {
    return { valid: false, reason: 'asset-B aggregate Pedersen check failed' };
  }

  // Direction inference from declared net deltas:
  //   A→B-dominant: dA > 0, dB < 0  (A flowing in, B flowing out)
  //   B→A-dominant: dA < 0, dB > 0
  //   spot:         dA == 0, dB == 0
  if (!(dA === 0n && dB === 0n) && !(dA > 0n && dB < 0n) && !(dA < 0n && dB > 0n)) {
    return { valid: false, reason: `inconsistent net-delta signs: dA=${dA}, dB=${dB}` };
  }

  // Re-derive (deltaA_net, deltaB_net) from the deterministic solve over the
  // included intent set. This requires knowing per-trader amount_in's, which
  // the indexer doesn't (Groth16 binds them). What the indexer CAN check:
  // the declared deltas form a valid (X, Y, R_A, R_B, fee_bps) clearing
  // result — but X and Y are private. So instead we verify:
  //   - The chain-side Pedersen identity holds (above) — binds Σ C's to
  //     declared deltas.
  //   - The Groth16 proof asserts each amount_out_i = amount_in_i · P_clear
  //     and min_out is satisfied.
  // The remaining indexer check is: declared (dA, dB) satisfies the
  // constant-product invariant on the post-batch reserves.
  let newReserveA, newReserveB;
  if (dA > 0n) {
    // A→B-dom
    newReserveA = pool.reserve_A + dA;
    newReserveB = pool.reserve_B + dB; // dB is negative, so subtract magnitude
    // Verify the curve: post-batch product ≥ pre-batch product (fee accrues to LPs)
    if (newReserveB <= 0n) return { valid: false, reason: 'asset-B reserve would go negative' };
  } else if (dA < 0n) {
    newReserveA = pool.reserve_A + dA;
    newReserveB = pool.reserve_B + dB;
    if (newReserveA <= 0n) return { valid: false, reason: 'asset-A reserve would go negative' };
  } else {
    newReserveA = pool.reserve_A;
    newReserveB = pool.reserve_B;
  }

  // Constant-product check: with γ scaling, R_A · R_B (post) ≥ R_A · R_B (pre).
  // The exact-output deterministic solve ensures this; verify cheaply here.
  if (newReserveA * newReserveB < pool.reserve_A * pool.reserve_B) {
    return { valid: false, reason: 'constant-product invariant violated (post < pre)' };
  }

  // With-fee CFMM curve floor identity (pins settler pricing).
  //
  // The constant-product check above only enforces non-decrease (no-fee curve
  // upper bound on |Δb|). On its own it admits any (|Δa|, |Δb|) along the
  // 1-parameter family between the with-fee and no-fee curves — leaving the
  // settler up to `fee_bps` of pricing freedom (cf. settler-trader collusion
  // redirecting fee revenue from LPs).
  //
  // The deterministic solve pins |Δb| = floor(R_B · γ_num · |Δa| /
  // (R_A · γ_den + γ_num · |Δa|)). Per-trader floor dust can only push the
  // actual declared |Δb| DOWNWARD from this curve (toward the pool's favor),
  // never upward. The tight check is therefore an upper bound:
  //
  //   A-dom (dA > 0, dB < 0):
  //     |Δb| · (R_A · γ_den + γ_num · |Δa|)  ≤  R_B · γ_num · |Δa|
  //
  //   B-dom (dA < 0, dB > 0):
  //     |Δa| · (R_B · γ_den + γ_num · |Δb|)  ≤  R_A · γ_num · |Δb|
  //
  //   Spot (dA = dB = 0): reserves unchanged (handled above).
  //
  // All inputs are public: pool reserves, declared deltas, fee_bps. No private
  // witness needed. Closes the "narrow settler pricing freedom" gap so the
  // spec's "no settler freedom in pricing, only in subset selection" claim
  // (AMM.md §"Uniform clearing") becomes operationally true.
  if (dA !== 0n || dB !== 0n) {
    const gNum = 10000n - BigInt(pool.fee_bps);
    const gDen = 10000n;
    if (dA > 0n) {                                       // A-dom
      const absA = dA;
      const absB = -dB;
      const lhs = absB * (pool.reserve_A * gDen + gNum * absA);
      const rhs = pool.reserve_B * gNum * absA;
      if (lhs > rhs) {
        return { valid: false, reason: 'CFMM curve floor identity violated (A-dom): |Δb| exceeds with-fee curve' };
      }
    } else {                                             // B-dom (dA < 0, dB > 0)
      const absA = -dA;
      const absB = dB;
      const lhs = absA * (pool.reserve_B * gDen + gNum * absB);
      const rhs = pool.reserve_A * gNum * absB;
      if (lhs > rhs) {
        return { valid: false, reason: 'CFMM curve floor identity violated (B-dom): |Δa| exceeds with-fee curve' };
      }
    }
  }

  // vk_cid integrity self-check. If the caller supplied the
  // resolved vk bytes alongside the pool's pinned CID, recompute the CID
  // from those bytes and reject on mismatch. Closes the "malicious IPFS
  // gateway returns wrong vk" hazard before snarkjs ever sees the bytes.
  // Production indexers MUST pass `vkBytes`; pre-ceremony tests using
  // SKIP_GROTH16_VERIFY_UNSAFE pass undefined and skip this check.
  if (vkBytes !== undefined && pool.vk_cid !== undefined) {
    if (!verifyVkCidBinding(vkBytes, pool.vk_cid)) {
      return { valid: false, reason: 'vk_cid integrity check failed: deriveVkCid(vkBytes) != pool.vk_cid' };
    }
  }

  // Groth16 batch proof (delegated)
  if (verify && !verify({ proof: env.proof, pool, kind: 'SWAP_BATCH', publicSignals: env, vkBytes })) {
    return { valid: false, reason: 'Groth16 batch proof failed' };
  }

  return {
    valid: true,
    newPoolState: {
      ...pool,
      reserve_A: newReserveA,
      reserve_B: newReserveB,
      // lp_total_shares unchanged by swaps
    },
    receipts: env.receipts.map((r, i) => ({
      kind: env.intents[i].direction === 0 ? 'swap_B_to_trader' : 'swap_A_to_trader',
      commitment: r.cOutSecp,
      vout: 1 + i,
    })),
    intentIds,
  };
}

// =========================================================================
// Arbiter helpers — mandatory-inclusion enforcement
// =========================================================================

const QSET_DOMAIN = new TextEncoder().encode('tacit-amm-qset-v1');

// Compute qualifying_set_hash from canonical components.
// canonical_list_bytes is u8-length-prefixed concat of 32-byte intent_ids
// in ascending byte order. N_MAX=16 fits in u8 (spec normative).
export function computeQualifyingSetHash({ poolId, height, intentIds }) {
  if (!(poolId instanceof Uint8Array) || poolId.length !== 32) {
    throw new Error('poolId must be 32 bytes');
  }
  if (typeof height !== 'number' || height < 0 || height > 0xffffffff) {
    throw new Error('height must be u32');
  }
  if (!Array.isArray(intentIds) || intentIds.length > 0xff) {
    throw new Error('intentIds must be Array of length 0..255');
  }
  for (let i = 1; i < intentIds.length; i++) {
    const a = intentIds[i - 1], b = intentIds[i];
    let cmp = 0;
    for (let j = 0; j < 32 && cmp === 0; j++) {
      if (a[j] < b[j]) cmp = -1;
      else if (a[j] > b[j]) cmp = 1;
    }
    if (cmp >= 0) throw new Error(`intentIds must be ascending and distinct (index ${i})`);
  }
  const heightLE = new Uint8Array(4);
  new DataView(heightLE.buffer).setUint32(0, height >>> 0, true);
  const parts = [QSET_DOMAIN, poolId, heightLE, new Uint8Array([intentIds.length])];
  for (const id of intentIds) {
    if (!(id instanceof Uint8Array) || id.length !== 32) throw new Error('intent_id must be 32 bytes');
    parts.push(id);
  }
  return sha256(concatBytes(...parts));
}

// Verify m-of-n arbiter signature against pool's pinned pubkey set.
// `signerIndices` is an array of m ascending distinct indices into
// `pinnedPubkeys`; `sigs` is a concat of m × 64-byte BIP-340 sigs over
// `qualifyingSetHash`. Each sig must verify under pubkey at its declared
// index. m=1 is the simplest case; m=2..n is the BFT-shape threshold.
// MuSig2 quorums can also use n=1, m=1 with an off-chain-aggregated key.
export function verifyArbiterSig(qualifyingSetHash, signerIndices, sigs, pinnedPubkeys, m) {
  if (!Array.isArray(pinnedPubkeys) || pinnedPubkeys.length === 0) return false;
  if (typeof m !== 'number' || m < 1 || m > pinnedPubkeys.length) return false;
  if (!(qualifyingSetHash instanceof Uint8Array) || qualifyingSetHash.length !== 32) return false;
  if (!Array.isArray(signerIndices) || signerIndices.length !== m) return false;
  if (!(sigs instanceof Uint8Array) || sigs.length !== 64 * m) return false;

  for (let i = 0; i < m; i++) {
    const idx = signerIndices[i];
    if (typeof idx !== 'number' || idx < 0 || idx >= pinnedPubkeys.length) return false;
    if (i > 0 && idx <= signerIndices[i - 1]) return false;
  }

  for (let i = 0; i < m; i++) {
    const pk = pinnedPubkeys[signerIndices[i]];
    const sig = sigs.subarray(64 * i, 64 * (i + 1));
    const xOnly = pk.subarray(1);
    if (!verifySchnorr(sig, qualifyingSetHash, xOnly)) return false;
  }
  return true;
}

function checkAggregatePedersen({ env, inputCommitmentsByIntent, assetXIsA, deltaXSigned, tipXCSecp, rNetX }) {
  // Σ_{X→Y inputs} C_in_secp,i  (intents whose direction matches X-side input)
  // − Σ_{Y→X outputs} C_out_secp,i  (intents whose direction is opposite, so X is their receipt)
  // − tip_X_C_secp − delta_X_signed · H == R_net_X · G
  //
  // direction == 0 (A→B): input is asset A, output is asset B.
  // direction == 1 (B→A): input is asset B, output is asset A.
  //
  // For assetXIsA: input side = direction==0 traders, output side = direction==1 traders.

  let sum = ZERO;
  for (let i = 0; i < env.intents.length; i++) {
    const it = env.intents[i];
    const isInputSide = (assetXIsA && it.direction === 0) || (!assetXIsA && it.direction === 1);
    const isOutputSide = (assetXIsA && it.direction === 1) || (!assetXIsA && it.direction === 0);
    if (isInputSide) {
      // The trader's input C_in_secp is the aggregate of their tacit-input UTXOs'
      // Pedersen commitments. Caller provides those; we sum them here.
      for (const cp of inputCommitmentsByIntent[i]) sum = sum.add(cp);
    } else if (isOutputSide) {
      sum = sum.add(pointFromCompressed(env.receipts[i].cOutSecp).negate());
    }
  }
  sum = sum.add(pointFromCompressed(tipXCSecp).negate());

  // Subtract delta_X_signed · H (handle sign)
  if (deltaXSigned !== 0n) {
    const mag = deltaXSigned < 0n ? -deltaXSigned : deltaXSigned;
    const dH = H.multiply(mag);
    if (deltaXSigned > 0n) sum = sum.add(dH.negate());
    else sum = sum.add(dH);
  }

  // Compare against R_net_X · G
  const rNet = BigInt('0x' + bytesToHex(rNetX));
  const rNetMod = modN(rNet);
  const rG = rNetMod === 0n ? ZERO : G.multiply(rNetMod);
  return sum.equals(rG);
}

// =========================================================================
// T_PROTOCOL_FEE_CLAIM validator
// =========================================================================
//
// Authenticated mint of accrued LP-share protocol-fee balance to a UTXO at
// the pool's pinned protocol_fee_address. No Groth16. Steps:
//   1. Decode envelope. Reject on structural error.
//   2. Verify pool_id matches a registered pool with non-zero protocol fee.
//   3. Verify claimer_pubkey_x_only matches x-only of pool.protocol_fee_address.
//   4. Verify BIP-340 claim_sig over claim_msg (see amm-protocol-fee.mjs).
//   5. Crystallize protocol fee on pool (V2-lazy mintFee).
//   6. Verify claim_amount == pool.protocol_fee_accrued post-crystallization.
//   7. Verify claim_C_secp == amount·H + blinding·G (public opening).
//   8. Emit lp_asset_id UTXO at vout[0] for protocol_fee_address.
//   9. Reset pool.protocol_fee_accrued = 0; k_last is already updated by step 5.
export function validateProtocolFeeClaim({ payload, pool }) {
  let env;
  try { env = decodeProtocolFeeClaim(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  if (!pool) return { valid: false, reason: 'pool not registered' };
  if (!bytesEqual(pool.pool_id, env.poolId)) return { valid: false, reason: 'pool_id mismatch' };
  if (!pool.protocol_fee_address || isProtocolFeeAddressZero(pool.protocol_fee_address)) {
    return { valid: false, reason: 'pool has no protocol fee configured' };
  }
  if (!pool.protocol_fee_bps || pool.protocol_fee_bps === 0) {
    return { valid: false, reason: 'pool has zero protocol_fee_bps' };
  }

  // claimer_pubkey_x_only must equal x-only of pool.protocol_fee_address (33-byte
  // compressed: first byte is parity, last 32 are x-only).
  const expectedXOnly = pool.protocol_fee_address.subarray(1);
  if (!bytesEqual(env.claimerPubkeyXOnly, expectedXOnly)) {
    return { valid: false, reason: 'claimer_pubkey_x_only != pool.protocol_fee_address[x_only]' };
  }

  // Crystallize protocol fee so claim_amount can be matched against the
  // post-crystallization accrued counter.
  const xPool = crystallizeProtocolFee(pool);
  const accrued = xPool.protocol_fee_accrued || 0n;
  if (env.claimAmount !== accrued) {
    return { valid: false, reason: `claim_amount mismatch: expected ${accrued}, got ${env.claimAmount}` };
  }
  if (env.claimAmount === 0n) return { valid: false, reason: 'no protocol fee accrued' };

  // BIP-340 sig under claimer_pubkey_x_only over claim_msg.
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, {
    poolId: env.poolId,
    claimAmount: env.claimAmount,
    claimCSecp: env.claimCSecp,
    claimBlinding: env.claimBlinding,
  });
  if (!verifySchnorr(env.claimSig, claimMsg, env.claimerPubkeyXOnly)) {
    return { valid: false, reason: 'claim_sig verification failed' };
  }

  // Public opening: claim_C_secp must equal claim_amount·H + claim_blinding·G.
  const r = BigInt('0x' + bytesToHex(env.claimBlinding));
  if (r >= SECP_N) return { valid: false, reason: 'claim_blinding >= group order' };
  const expectedC = H.multiply(env.claimAmount).add(r === 0n ? ZERO : G.multiply(r));
  const actualC = pointFromCompressed(env.claimCSecp);
  if (!expectedC.equals(actualC)) {
    return { valid: false, reason: 'claim_C_secp does not open to (claim_amount, claim_blinding)' };
  }

  return {
    valid: true,
    newPoolState: {
      ...xPool,
      protocol_fee_accrued: 0n,
      // k_last stays as crystallizeProtocolFee set it (current R_A · R_B).
    },
    receipts: [
      {
        kind: 'protocol_fee_claim',
        amount: env.claimAmount,
        commitment: env.claimCSecp,
        asset_id: pool.lp_asset_id,
        recipient_pubkey_x_only: env.claimerPubkeyXOnly,
        vout: 0,
      },
    ],
  };
}

