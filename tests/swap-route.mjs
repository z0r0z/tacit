// T_SWAP_ROUTE (opcode 0x33) reference implementation.
//
// Atomic multi-hop AMM routing. Spec: SPEC-SWAP-ROUTE-AMENDMENT.md.
//
// Cryptographic reuse with T_SWAP_VAR (§5.20):
//   - Same `tacit-kernel-v1` domain tag for kernel sig (composition.mjs
//     computeKernelMsg).
//   - Same m=2 aggregated bulletproof wire format over the trader's
//     output commit (with the additive-identity sentinel in slot 0 —
//     T_SWAP_ROUTE has no change UTXO in V1).
//   - Cleartext per-hop CFMM deltas (no zero-knowledge over intermediate
//     amounts; identical privacy posture to N sequential T_SWAP_VAR calls
//     in the same Bitcoin tx).
//
// Differences from T_SWAP_VAR:
//   - One envelope spans N hops (2..N_HOPS_MAX); each hop has its own
//     (pool_id, direction, R_A_pre, R_B_pre, delta_a_net_mag,
//     delta_b_net_mag, fee_bps).
//   - Validator advances pool state hop-by-hop in the declared order,
//     re-checking the with-fee CFMM curve floor per hop.
//   - No change UTXO: trader's full input is consumed (use T_AXFER_VAR
//     beforehand to pre-split if needed). V1 keeps this simple; settler-
//     driven follow-up can add change handling.
//   - No bridge Pedersen commitments: intermediate amounts are public
//     cleartext per-hop deltas; hop_k.delta_out_amount must equal
//     hop_{k+1}.delta_in_amount, and the trader's chain-side balance
//     closes via one kernel sig over (input → final receipt).
//
// NO Groth16 in this opcode; CFMM math is pure indexer arithmetic.
//
// Public surface:
//   - Constants: OPCODE_T_SWAP_ROUTE, ENVELOPE_VERSION, N_HOPS_MAX
//   - Wire encoder/decoder: encodeSwapRoute / decodeSwapRoute
//   - Message builders: buildSwapRouteIntentMsg / buildSwapRouteKernelMsg
//   - Validator: validateSwapRoute (mirrors §"Validator algorithm")

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN, pedersenCommit, pointToBytes,
} from './bulletproofs.mjs';
import {
  signSchnorr, verifySchnorr, computeKernelMsg,
} from './composition.mjs';

// =========================================================================
// Constants
// =========================================================================

export const OPCODE_T_SWAP_ROUTE = 0x33;
export const ENVELOPE_VERSION = 0x01;

// Maximum hops per route. Chosen to match typical DEX path lengths (Uni V2
// router defaults to 3-4 hops). At N=4 the per-route envelope is ~1.3 KB —
// comfortably under tap-leaf size limits and under the 2-RTT settlement
// budget. Raising this is a follow-up amendment (changes the route_msg
// preimage shape; not soft-fork compatible at the validator level).
export const N_HOPS_MAX = 4;

// Domain tags
const DOMAIN_INTENT = new TextEncoder().encode('tacit-swap-route-v1');

// =========================================================================
// Helpers
// =========================================================================

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}
function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }
function u16LE(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
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
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function readU16LE(b, o) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true); }
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
function bytesToHex(b) {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
  return out;
}

// Outpoint encoding (txid big-endian + vout little-endian) — the
// canonical Bitcoin-tx outpoint shape used everywhere in tacit.
function encodeOutpoint(txidBE, vout) {
  const txid = asBytes(txidBE, 32, 'txid');
  return concatBytes(txid, u32LE(vout));
}

// Per-hop block (67 bytes) layout helpers.
const HOP_BLOCK_BYTES = 32 + 1 + 2 + 8 + 8 + 8 + 8;

function encodeHop(hop) {
  const {
    poolId, direction, feeBps,
    R_A_pre, R_B_pre,
    deltaANetMag, deltaBNetMag,
  } = hop;
  if (direction !== 0 && direction !== 1) {
    throw new Error(`hop direction must be 0|1 (got ${direction})`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
    throw new Error(`hop fee_bps must be 0..1000 (got ${feeBps})`);
  }
  return concatBytes(
    asBytes(poolId, 32, 'hop.poolId'),
    new Uint8Array([direction & 0xff]),
    u16LE(feeBps),
    u64LE(R_A_pre), u64LE(R_B_pre),
    u64LE(deltaANetMag), u64LE(deltaBNetMag),
  );
}

function decodeHop(payload, o) {
  if (o + HOP_BLOCK_BYTES > payload.length) {
    throw new Error(`decode: truncated hop block at offset ${o}`);
  }
  const poolId = new Uint8Array(payload.subarray(o, o + 32)); o += 32;
  const direction = payload[o++];
  if (direction !== 0 && direction !== 1) {
    throw new Error(`hop.direction must be 0|1 (got ${direction})`);
  }
  const feeBps = readU16LE(payload, o); o += 2;
  if (feeBps > 1000) throw new Error(`hop.fee_bps > 1000 (got ${feeBps})`);
  const R_A_pre = readU64LE(payload, o); o += 8;
  const R_B_pre = readU64LE(payload, o); o += 8;
  const deltaANetMag = readU64LE(payload, o); o += 8;
  const deltaBNetMag = readU64LE(payload, o); o += 8;
  return [{ poolId, direction, feeBps, R_A_pre, R_B_pre, deltaANetMag, deltaBNetMag }, o];
}

// =========================================================================
// Intent-msg construction
// =========================================================================

// Per SPEC-SWAP-ROUTE-AMENDMENT §"Intent message + signature". Returns the
// 32-byte SHA-256 hash the trader signs with BIP-340.
export function buildSwapRouteIntentMsg({
  traderPubkey,
  traderInputAssetId,
  traderOutputAssetId,
  minOut,
  expiryHeight,
  hops,
  cInSecp,
  cReceiptSecp,
}) {
  if (!Array.isArray(hops) || hops.length < 2 || hops.length > N_HOPS_MAX) {
    throw new Error(`hops length must be 2..${N_HOPS_MAX} (got ${hops?.length})`);
  }
  const tpk = asBytes(traderPubkey, 33, 'traderPubkey');
  const aid_in = asBytes(traderInputAssetId, 32, 'traderInputAssetId');
  const aid_out = asBytes(traderOutputAssetId, 32, 'traderOutputAssetId');
  const cin = asBytes(cInSecp, 33, 'cInSecp');
  const cout = asBytes(cReceiptSecp, 33, 'cReceiptSecp');

  const hopBlocks = hops.map(encodeHop);

  return sha256(concatBytes(
    DOMAIN_INTENT,
    tpk,
    aid_in,
    aid_out,
    u64LE(minOut),
    u32LE(expiryHeight),
    new Uint8Array([hops.length & 0xff]),
    ...hopBlocks,
    cin,
    cout,
  ));
}

// =========================================================================
// Kernel-msg construction
// =========================================================================

// The kernel sig closes the trader's net asset flow across the whole
// route. Signature semantics:
//   P = C_receipt_secp − C_in_secp − (delta_out_last − delta_in_0) · H_secp
// Signed by excess_route = r_receipt − r_in.
//
// The "single-asset" closure model from CXFER + T_AXFER_VAR + T_SWAP_VAR
// is generalized to "input asset → output asset" because the trader
// pays delta_in_0 of one asset and receives delta_out_last of another.
// Both deltas are public; intermediate hop deltas are also public but
// don't appear in the kernel closure (they're balanced internally per
// hop via the CFMM check).
//
// Reuses composition.mjs computeKernelMsg with assetId = trader's input
// asset, single inputOutpoint = the trader's tacit input, single output
// commit = C_receipt_secp, and the burned_amount slot encoding
// `delta_in_0 - delta_out_last_inUnitsOfInputAsset`. Since the output is
// a different asset, that representation isn't directly meaningful;
// instead we use a dedicated route-specific message that binds:
//   - input asset_id
//   - output asset_id
//   - delta_in_0, delta_out_last (public)
//   - trader_input_outpoint
//   - C_receipt_secp
//   - route hash (SHA256 of the hop block array — already covered by
//     intent_sig, but binding here closes a "settler swaps hops" attack
//     where the kernel sig from one route is reused under a different
//     hop sequence)
const DOMAIN_KERNEL = new TextEncoder().encode('tacit-kernel-v1');

export function buildSwapRouteKernelMsg({
  traderInputAssetId,
  traderOutputAssetId,
  traderInputOutpointTxid,
  traderInputOutpointVout,
  deltaIn0,
  deltaOutLast,
  cReceiptSecp,
  hopsHash,
}) {
  return sha256(concatBytes(
    DOMAIN_KERNEL,
    asBytes(traderInputAssetId, 32, 'traderInputAssetId'),
    asBytes(traderOutputAssetId, 32, 'traderOutputAssetId'),
    new Uint8Array([0x01]),                  // asset_input_count
    encodeOutpoint(traderInputOutpointTxid, traderInputOutpointVout),
    asBytes(cReceiptSecp, 33, 'cReceiptSecp'),
    u64LE(deltaIn0),
    u64LE(deltaOutLast),
    asBytes(hopsHash, 32, 'hopsHash'),
  ));
}

// Compute the BIP-340 verification key for the kernel sig:
//   P = C_receipt_secp − C_in_secp − (delta_out_last − delta_in_0) · H_secp
// then take its x-only form.
//
// (delta_out_last − delta_in_0) is signed in the field of u64 scalars on
// secp256k1's curve. Since we work mod secp256k1 group order which is
// much larger than 2^64, this is just `(d_out − d_in) mod n` in scalar
// arithmetic.
export function kernelVerifyPoint({ cInSecp, cReceiptSecp, deltaIn0, deltaOutLast }) {
  const cIn  = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cInSecp,      33, 'cInSecp')));
  const cOut = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cReceiptSecp, 33, 'cReceiptSecp')));
  const dIn  = BigInt(deltaIn0);
  const dOut = BigInt(deltaOutLast);
  // delta_diff = (deltaOutLast − deltaIn0) mod n, then multiply H by it.
  // If delta_diff == 0 (round-trip route returning to input asset at
  // exactly the same value, e.g. arbitrage break-even), the H term drops.
  let delta_diff = (dOut - dIn) % SECP_N;
  if (delta_diff < 0n) delta_diff += SECP_N;
  const ddH = delta_diff === 0n ? ZERO : H.multiply(delta_diff);
  return cOut.add(cIn.negate()).add(ddH.negate());
}

// Compute SHA256 over the encoded hop block array — used as a stable
// digest binding into kernel_msg. Mirrors the per-hop block layout from
// encode/decode so any byte-level mutation across hops shifts the digest.
export function hashHops(hops) {
  const blocks = hops.map(encodeHop);
  return sha256(concatBytes(...blocks));
}

// =========================================================================
// Wire-format encoder / decoder
// =========================================================================

// Returns the envelope payload bytes (without the OP_RETURN wrapping).
// envelope_hash = SHA256(payload) is computed by the caller.
export function encodeSwapRoute(env) {
  const {
    traderInputAssetId, traderOutputAssetId,
    minOut, expiryHeight, traderPubkey,
    hops,
    traderInputOutpointTxid, traderInputOutpointVout,
    cInSecp, cReceiptSecp, rReceipt,
    rangeProof, kernelSig, intentSig,
  } = env;
  if (!Array.isArray(hops) || hops.length < 2 || hops.length > N_HOPS_MAX) {
    throw new Error(`hops length must be 2..${N_HOPS_MAX} (got ${hops?.length})`);
  }
  const parts = [
    new Uint8Array([OPCODE_T_SWAP_ROUTE, hops.length & 0xff]),
    asBytes(traderInputAssetId, 32, 'traderInputAssetId'),
    asBytes(traderOutputAssetId, 32, 'traderOutputAssetId'),
    u64LE(minOut),
    u32LE(expiryHeight),
    asBytes(traderPubkey, 33, 'traderPubkey'),
    ...hops.map(encodeHop),
    encodeOutpoint(traderInputOutpointTxid, traderInputOutpointVout),
    asBytes(cInSecp, 33, 'cInSecp'),
    asBytes(cReceiptSecp, 33, 'cReceiptSecp'),
    asBytes(rReceipt, 32, 'rReceipt'),
  ];
  if (!(rangeProof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (rangeProof.length > 0xffff) throw new Error('rangeProof too large (> 65535)');
  parts.push(u16LE(rangeProof.length), rangeProof);
  parts.push(asBytes(kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(intentSig, 64, 'intentSig'));
  return concatBytes(...parts);
}

export function decodeSwapRoute(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  let o = 0;
  function take(n, name) {
    if (o + n > payload.length) throw new Error(`decode: truncated at ${name} (need ${n}, have ${payload.length - o})`);
    const s = payload.subarray(o, o + n);
    o += n;
    return s;
  }
  const opcode = take(1, 'opcode')[0];
  if (opcode !== OPCODE_T_SWAP_ROUTE) throw new Error(`bad opcode: ${opcode}`);
  const nHops = take(1, 'nHops')[0];
  if (nHops < 2 || nHops > N_HOPS_MAX) {
    throw new Error(`n_hops must be 2..${N_HOPS_MAX} (got ${nHops})`);
  }
  const traderInputAssetId = new Uint8Array(take(32, 'traderInputAssetId'));
  const traderOutputAssetId = new Uint8Array(take(32, 'traderOutputAssetId'));
  if (bytesEqual(traderInputAssetId, traderOutputAssetId)) {
    throw new Error('trader_input_asset_id == trader_output_asset_id (degenerate)');
  }
  const minOut = readU64LE(payload, o); o += 8;
  const expiryHeight = readU32LE(payload, o); o += 4;
  const traderPubkey = new Uint8Array(take(33, 'traderPubkey'));

  const hops = [];
  for (let k = 0; k < nHops; k++) {
    const [hop, next_o] = decodeHop(payload, o);
    hops.push(hop);
    o = next_o;
  }

  // trader_input_outpoint(36) — txid(32 BE) || vout(4 LE)
  const traderInputOutpointTxid = new Uint8Array(take(32, 'traderInputOutpointTxid'));
  const traderInputOutpointVout = readU32LE(payload, o); o += 4;

  const cInSecp = new Uint8Array(take(33, 'cInSecp'));
  const cReceiptSecp = new Uint8Array(take(33, 'cReceiptSecp'));
  const rReceipt = new Uint8Array(take(32, 'rReceipt'));
  const rpLen = readU16LE(payload, o); o += 2;
  const rangeProof = new Uint8Array(take(rpLen, 'rangeProof'));
  const kernelSig = new Uint8Array(take(64, 'kernelSig'));
  const intentSig = new Uint8Array(take(64, 'intentSig'));
  if (o !== payload.length) {
    throw new Error(`trailing bytes after intentSig: ${payload.length - o}`);
  }
  return {
    opcode, nHops,
    traderInputAssetId, traderOutputAssetId,
    minOut, expiryHeight, traderPubkey,
    hops,
    traderInputOutpointTxid, traderInputOutpointVout,
    cInSecp, cReceiptSecp, rReceipt,
    rangeProof, kernelSig, intentSig,
  };
}

export function computeSwapRouteEnvelopeHash(payload) {
  return sha256(payload);
}

// =========================================================================
// CFMM curve check (with-fee floor identity, integer)
// =========================================================================
//
// For a single hop with declared (delta_in, delta_out) and pool reserves
// (R_in, R_out) at fee_bps:
//
//   delta_out * (R_in * 10000 + (10000 − fee_bps) * delta_in)
//      ≤ R_out * (10000 − fee_bps) * delta_in
//
// Identical to the per-pool floor used in T_SWAP_BATCH (AMM.md
// §"CFMM curve floor identity") and T_SWAP_VAR. Per-trader floor dust
// can only push the actual delta_out DOWN from the curve (toward pool's
// favor), so the indexer enforces the upper-bound inequality.

function cfmmFloorOk({ delta_in, delta_out, R_in, R_out, fee_bps }) {
  const gNum = 10000n - BigInt(fee_bps);
  const gDen = 10000n;
  const lhs = BigInt(delta_out) * (BigInt(R_in) * gDen + gNum * BigInt(delta_in));
  const rhs = BigInt(R_out) * gNum * BigInt(delta_in);
  return lhs <= rhs;
}

// =========================================================================
// Validator
// =========================================================================
//
// Result shape:
//   { valid: true,  newPoolStates: Map<pool_id_hex, newPoolState>, receipt }
//   { valid: false, reason: string }
//
// Inputs:
//   payload            : envelope bytes
//   pools              : Map<pool_id_hex, pool_state> — one entry per
//                        distinct pool_id touched by the route. Each pool
//                        carries { pool_id, asset_A, asset_B, fee_bps,
//                        reserve_A, reserve_B, tradable }.
//   currentHeight      : block height at confirmation
//   opReturnData       : REQUIRED — 32-byte data from vout[0]'s OP_RETURN.
//                        Checked against SHA256(payload) per SPEC §5.22 step 1.
//   inputCommitment    : REQUIRED — 33-byte compressed Pedersen commit or a
//                        ProjectivePoint; the on-chain commitment at vin[1].
//                        Without binding env.cInSecp to the actual UTXO, the
//                        trader can pick any (a_in_claimed, r_in) consistent
//                        with the kernel sig and inflate asset_in.
//   bulletproofVerify  : injected (V_pts, proofBytes) -> bool. Pass the
//                        real bpRangeAggVerify from bulletproofs.mjs in
//                        production; tests pass a stub.

const U64_MAX = (1n << 64n) - 1n;

export function validateSwapRoute({
  payload, pools, currentHeight,
  opReturnData,
  inputCommitment,
  bulletproofVerify,
}) {
  if (typeof bulletproofVerify !== 'function') {
    throw new Error('validateSwapRoute: bulletproofVerify is required');
  }
  if (opReturnData === undefined) {
    throw new Error(
      'validateSwapRoute: opReturnData is required — pass the 32-byte ' +
      "data from tx.vout[0]'s OP_RETURN so the validator can verify " +
      'SHA256(envelope_payload) == opReturnData per SPEC §5.22 step 1.',
    );
  }
  if (inputCommitment === undefined) {
    throw new Error(
      'validateSwapRoute: inputCommitment is required — pass the on-chain ' +
      "Pedersen commit at (traderInputOutpointTxid, traderInputOutpointVout) " +
      'so the validator can verify env.cInSecp matches.',
    );
  }

  let env;
  try { env = decodeSwapRoute(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  if (!(opReturnData instanceof Uint8Array) || opReturnData.length !== 32) {
    return { valid: false, reason: 'opReturnData must be 32-byte Uint8Array' };
  }
  const expectedHash = computeSwapRouteEnvelopeHash(payload);
  if (!bytesEqual(opReturnData, expectedHash)) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }

  let inputCommitmentBytes;
  if (inputCommitment instanceof Uint8Array) {
    if (inputCommitment.length !== 33) {
      return { valid: false, reason: 'inputCommitment must be 33-byte compressed point' };
    }
    inputCommitmentBytes = inputCommitment;
  } else if (inputCommitment && typeof inputCommitment.toRawBytes === 'function') {
    inputCommitmentBytes = inputCommitment.toRawBytes(true);
  } else {
    return { valid: false, reason: 'inputCommitment must be ProjectivePoint or Uint8Array(33)' };
  }
  if (!bytesEqual(env.cInSecp, inputCommitmentBytes)) {
    return {
      valid: false,
      reason: 'env.cInSecp does not match on-chain input UTXO commit at outpoint',
    };
  }

  if (env.expiryHeight !== 0 && currentHeight > env.expiryHeight) {
    return { valid: false, reason: `route expired (currentHeight ${currentHeight} > expiry ${env.expiryHeight})` };
  }

  // ----- intent sig verification (binds the whole route) -----
  const hopsHash = hashHops(env.hops);
  const intentMsg = buildSwapRouteIntentMsg({
    traderPubkey: env.traderPubkey,
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    minOut: env.minOut,
    expiryHeight: env.expiryHeight,
    hops: env.hops,
    cInSecp: env.cInSecp,
    cReceiptSecp: env.cReceiptSecp,
  });
  const traderXOnly = env.traderPubkey.subarray(1);
  let intentOk;
  try { intentOk = verifySchnorr(env.intentSig, intentMsg, traderXOnly); }
  catch { intentOk = false; }
  if (!intentOk) {
    return { valid: false, reason: 'intent_sig verification failed' };
  }

  // ----- per-hop chain: asset + amount continuity + CFMM floor -----
  // Snapshot pool reserves so multi-touch routes (same pool twice in a
  // row, e.g. arbitrage cycle) advance state correctly per hop.
  const poolSnapshot = new Map();
  for (const hop of env.hops) {
    const k = bytesToHex(hop.poolId);
    if (poolSnapshot.has(k)) continue;
    const pool = pools.get(k);
    if (!pool) return { valid: false, reason: `pool not registered: ${k}` };
    if (pool.tradable === false) return { valid: false, reason: `pool ${k} not tradable` };
    poolSnapshot.set(k, {
      asset_A: pool.asset_A,
      asset_B: pool.asset_B,
      reserve_A: BigInt(pool.reserve_A),
      reserve_B: BigInt(pool.reserve_B),
      fee_bps: pool.fee_bps,
    });
  }

  let hop_input_asset = env.traderInputAssetId;
  let prev_delta_out = null;
  let delta_in_0 = null;
  let delta_out_last = null;

  for (let k = 0; k < env.hops.length; k++) {
    const H_k = env.hops[k];
    const pid_hex = bytesToHex(H_k.poolId);
    const snap = poolSnapshot.get(pid_hex);

    if (H_k.feeBps !== snap.fee_bps) {
      return { valid: false, reason: `hop[${k}] fee_bps ${H_k.feeBps} != pool.fee_bps ${snap.fee_bps}` };
    }
    if (BigInt(H_k.R_A_pre) !== snap.reserve_A) {
      return { valid: false, reason: `hop[${k}] R_A_pre ${H_k.R_A_pre} != pool.reserve_A ${snap.reserve_A}` };
    }
    if (BigInt(H_k.R_B_pre) !== snap.reserve_B) {
      return { valid: false, reason: `hop[${k}] R_B_pre ${H_k.R_B_pre} != pool.reserve_B ${snap.reserve_B}` };
    }

    // direction → (asset_in, asset_out, R_in, R_out, delta_in, delta_out)
    let asset_in, asset_out, R_in, R_out, delta_in, delta_out;
    if (H_k.direction === 0) {                       // pool's asset_A is input
      asset_in  = snap.asset_A;
      asset_out = snap.asset_B;
      R_in      = snap.reserve_A;
      R_out     = snap.reserve_B;
      delta_in  = H_k.deltaANetMag;
      delta_out = H_k.deltaBNetMag;
    } else {                                          // pool's asset_B is input
      asset_in  = snap.asset_B;
      asset_out = snap.asset_A;
      R_in      = snap.reserve_B;
      R_out     = snap.reserve_A;
      delta_in  = H_k.deltaBNetMag;
      delta_out = H_k.deltaANetMag;
    }
    if (delta_in <= 0n) return { valid: false, reason: `hop[${k}] delta_in == 0 (degenerate)` };
    if (delta_out <= 0n) return { valid: false, reason: `hop[${k}] delta_out == 0 (degenerate)` };

    // Asset continuity: hop_k.asset_in == previous-hop's asset_out (or
    // trader_input_asset for k == 0).
    if (!bytesEqual(asset_in, hop_input_asset)) {
      return {
        valid: false,
        reason: `hop[${k}] asset_in mismatch: expected ${bytesToHex(hop_input_asset)}, got ${bytesToHex(asset_in)}`,
      };
    }

    // Amount continuity: hop_k.delta_in == previous-hop's delta_out (for k ≥ 1).
    if (k > 0 && delta_in !== prev_delta_out) {
      return {
        valid: false,
        reason: `hop[${k}] delta_in ${delta_in} != prev hop delta_out ${prev_delta_out}`,
      };
    }

    // Reserve-overflow guard.
    if (R_in + delta_in > U64_MAX) {
      return { valid: false, reason: `hop[${k}] reserve_in + delta_in overflows u64` };
    }
    if (R_out < delta_out) {
      return { valid: false, reason: `hop[${k}] reserve_out < delta_out (drains pool)` };
    }

    // CFMM curve floor identity (with-fee, upper bound).
    if (!cfmmFloorOk({
      delta_in, delta_out,
      R_in, R_out,
      fee_bps: snap.fee_bps,
    })) {
      return { valid: false, reason: `hop[${k}] CFMM curve floor identity violated (delta_out exceeds with-fee curve)` };
    }

    // Advance pool snapshot for the next hop's check.
    if (H_k.direction === 0) {
      snap.reserve_A = R_in  + delta_in;
      snap.reserve_B = R_out - delta_out;
    } else {
      snap.reserve_B = R_in  + delta_in;
      snap.reserve_A = R_out - delta_out;
    }

    if (k === 0) delta_in_0 = delta_in;
    delta_out_last = delta_out;
    prev_delta_out = delta_out;
    hop_input_asset = asset_out;
  }

  if (!bytesEqual(hop_input_asset, env.traderOutputAssetId)) {
    return {
      valid: false,
      reason: `final hop asset_out mismatch: expected ${bytesToHex(env.traderOutputAssetId)}, got ${bytesToHex(hop_input_asset)}`,
    };
  }

  // ----- min_out gate (terminal-only; Uni V2 router semantics) -----
  if (delta_out_last < env.minOut) {
    return { valid: false, reason: `min_out violated: delta_out_last ${delta_out_last} < min_out ${env.minOut}` };
  }

  // ----- Receipt opening: cReceiptSecp opens to (delta_out_last, rReceipt) -----
  let rReceiptN;
  try { rReceiptN = modN(BigInt('0x' + bytesToHex(env.rReceipt))); }
  catch (e) { return { valid: false, reason: `rReceipt parse: ${e.message}` }; }
  if (rReceiptN === 0n) {
    return { valid: false, reason: 'rReceipt is zero — would leak deltaOut via C_receipt = delta_out · H' };
  }
  const expectedReceipt = pedersenCommit(delta_out_last, rReceiptN);
  const expectedReceiptBytes = pointToBytes(expectedReceipt);
  if (!bytesEqual(expectedReceiptBytes, env.cReceiptSecp)) {
    return { valid: false, reason: 'cReceiptSecp does not open to (delta_out_last, rReceipt)' };
  }

  // ----- Kernel sig verification -----
  const kernelMsg = buildSwapRouteKernelMsg({
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    traderInputOutpointTxid: env.traderInputOutpointTxid,
    traderInputOutpointVout: env.traderInputOutpointVout,
    deltaIn0: delta_in_0,
    deltaOutLast: delta_out_last,
    cReceiptSecp: env.cReceiptSecp,
    hopsHash,
  });
  const P = kernelVerifyPoint({
    cInSecp: env.cInSecp,
    cReceiptSecp: env.cReceiptSecp,
    deltaIn0: delta_in_0,
    deltaOutLast: delta_out_last,
  });
  if (P.equals(ZERO)) {
    return { valid: false, reason: 'kernel verifier key is point at infinity (would accept any sig)' };
  }
  const PBytes = pointToBytes(P);
  const PxOnly = PBytes.subarray(1);
  let kernelOk;
  try { kernelOk = verifySchnorr(env.kernelSig, kernelMsg, PxOnly); }
  catch { kernelOk = false; }
  if (!kernelOk) {
    return { valid: false, reason: 'kernel_sig verification failed' };
  }

  // ----- Bulletproof m=2 over (sentinel, C_receipt_secp) -----
  // Slot 0 is the additive identity (ZERO) — sentinel for the "no
  // change" case (T_SWAP_ROUTE never produces a change UTXO in V1).
  // Wire-format parity with T_SWAP_VAR / T_AXFER_VAR keeps the
  // bulletproof verifier hot-path identical across opcodes.
  let cReceiptOnChain;
  try { cReceiptOnChain = secp.ProjectivePoint.fromHex(bytesToHex(env.cReceiptSecp)); }
  catch (e) { return { valid: false, reason: `cReceiptSecp decode: ${e.message}` }; }
  if (!bulletproofVerify([ZERO, cReceiptOnChain], env.rangeProof)) {
    return { valid: false, reason: 'bulletproof verification failed' };
  }

  // ----- All checks passed; emit per-pool state transitions -----
  const newPoolStates = new Map();
  for (const [k, snap] of poolSnapshot) {
    newPoolStates.set(k, {
      reserve_A: snap.reserve_A,
      reserve_B: snap.reserve_B,
      // LP-fee accrual: pool's k grows naturally because the with-fee
      // curve product is ≥ k_pre. Lazy mintFee crystallization fires
      // at the next LP_ADD / LP_REMOVE — not here.
    });
  }
  return {
    valid: true,
    newPoolStates,
    receipt: {
      asset_id: env.traderOutputAssetId,
      commitment: env.cReceiptSecp,
      r_receipt: env.rReceipt,
      amount: delta_out_last,
    },
  };
}
