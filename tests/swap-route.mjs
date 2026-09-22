// T_SWAP_ROUTE (opcode 0x33) reference implementation: atomic multi-hop AMM routing.
//
// One envelope spans 2..N_HOPS_MAX hops. The trader's single input note flows through each pool in order
// and lands as one receipt note of the final hop's output asset; intermediate amounts flow pool-to-pool
// and never become notes. A route has no change output: the whole input is consumed.
//
// validateSwapRoute mirrors the Bitcoin reflection guest's fold (see its header). The wire still carries
// every hop's declared fee tier, pre-reserves and magnitudes, plus cReceiptSecp and an m=2 range proof
// (sentinel + receipt) for format parity with T_SWAP_VAR; the fold reads only hop 0's input magnitude.
//
// Public surface:
//   - Constants: OPCODE_T_SWAP_ROUTE, ENVELOPE_VERSION, N_HOPS_MAX
//   - Wire encoder/decoder: encodeSwapRoute / decodeSwapRoute
//   - Message builders: buildSwapRouteIntentMsg, buildSwapRouteHop0KernelMsg, buildSwapRouteKernelMsg
//   - Validator: validateSwapRoute

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

// Maximum hops per route. At N=4 the envelope is ~1.3 KB, well under tap-leaf limits. The hop count is
// part of the route_msg preimage, so changing it changes the signed message.
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

// Per the spec. Returns the
// 32-byte SHA-256 hash the trader signs with BIP-340.
export function buildSwapRouteIntentMsg({
  traderPubkey,
  traderInputAssetId,
  traderOutputAssetId,
  minOut,
  expiryHeight,
  hops,
  cInSecp,
  // The receipt's PUBLIC BLINDING, not its commitment: the final output amount is only known once every hop has
  // been re-cleared against current reserves, so the consumer forms C_receipt = out'·H + rReceipt·G itself.
  rReceipt,
  // The receipt output's scriptPubKey (reveal-tx vout 1), length-prefixed — the anti-redirection binding.
  // The guest reads these bytes verbatim from the confirmed tx, so a redirected receipt breaks the signature.
  receiveScriptPubKey,
  // The refund output's scriptPubKey (reveal-tx vout 2 — a route has no change output), bound the same way and
  // present on every route: below minOut the exact input is returned there instead of the route being dropped.
  refundScriptPubKey,
}) {
  if (!Array.isArray(hops) || hops.length < 2 || hops.length > N_HOPS_MAX) {
    throw new Error(`hops length must be 2..${N_HOPS_MAX} (got ${hops?.length})`);
  }
  if (!(receiveScriptPubKey instanceof Uint8Array) || receiveScriptPubKey.length === 0) {
    throw new Error('receiveScriptPubKey must be the receipt output scriptPubKey');
  }
  if (!(refundScriptPubKey instanceof Uint8Array) || refundScriptPubKey.length === 0) {
    throw new Error('refundScriptPubKey must be the refund output scriptPubKey');
  }
  const tpk = asBytes(traderPubkey, 33, 'traderPubkey');
  const aid_in = asBytes(traderInputAssetId, 32, 'traderInputAssetId');
  const aid_out = asBytes(traderOutputAssetId, 32, 'traderOutputAssetId');
  const cin = asBytes(cInSecp, 33, 'cInSecp');
  const rrc = asBytes(rReceipt, 32, 'rReceipt');
  // The route input amount: hop 0's in-side magnitude, selected by hop 0's direction. It is the only
  // declared magnitude the fold reads; the kernel binds it to the trader's real spent note.
  const hop0 = hops[0];
  const deltaIn = Number(hop0.direction) === 0 ? hop0.deltaANetMag : hop0.deltaBNetMag;

  return sha256(concatBytes(
    DOMAIN_INTENT,
    tpk,
    aid_in,
    aid_out,
    u64LE(deltaIn),
    u64LE(minOut),
    u32LE(expiryHeight),
    new Uint8Array([hops.length & 0xff]),
    // Each hop binds only pool_id ‖ direction — the route's SHAPE. Its fee tier, pre-reserves and output
    // magnitudes are recomputed at fold time, so a pool moving after signing leaves the signature valid.
    ...hops.map((h) => concatBytes(asBytes(h.poolId, 32, 'hop.poolId'), new Uint8Array([Number(h.direction) & 0xff]))),
    cin,
    rrc,
    u16LE(receiveScriptPubKey.length), receiveScriptPubKey,
    u16LE(refundScriptPubKey.length), refundScriptPubKey,
  ));
}

// =========================================================================
// Kernel-msg construction
// =========================================================================

// Net-flow route kernel message (input asset → output asset over the whole route), kept byte-identical to
// the worker's ammSwapRouteKernelMsg parity vectors. The guest does not verify it: the route's kernel sig
// is checked against buildSwapRouteHop0KernelMsg (see the validator section).
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

// Verify key for the net-flow message: P = C_receipt − C_in − (delta_out_last − delta_in_0)·H, taken mod n.
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
// Identical to the per-pool floor used in T_SWAP_BATCH (the spec's
// CFMM curve floor identity) and T_SWAP_VAR. Per-trader floor dust
// can only push the actual delta_out DOWN from the curve (toward pool's
// favor), so the indexer enforces the upper-bound inequality.

export function cfmmFloorOk({ delta_in, delta_out, R_in, R_out, fee_bps }) {
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
// Mirrors the Bitcoin reflection guest's fold_swap_route. The trader signs the route's SHAPE (each hop's
// pool + direction), its input amount, min_out, the receipt blinding and both destinations. Each hop is
// re-cleared at the pool's CURRENT reserves and registry fee tier, chained from the amount the previous
// hop actually produced; declared per-hop fee tiers, pre-reserves and later-hop magnitudes are never read.
// A route that has expired, clears to nothing, or misses min_out is refunded (the exact input returns at
// the refund destination) and no pool moves. The receipt is formed from the final cleared amount under the
// public rReceipt; the envelope's cReceiptSecp and range proof take no part.
//
// Result shape:
//   { valid: true, outcome: 'receipt', newPoolStates: Map<pool_id_hex, {reserve_A, reserve_B}>, receipt }
//   { valid: true, outcome: 'refund',  newPoolStates: empty Map, refund: { asset_id, commitment }, reason }
//   { valid: false, reason: string }
//
// Inputs:
//   payload             : envelope bytes
//   pools               : Map<pool_id_hex, { pool_id, asset_A, asset_B, fee_bps, reserve_A, reserve_B, tradable }>
//   currentHeight       : confirmed Bitcoin height carrying the route
//   opReturnData        : REQUIRED — 32-byte data from vout[0]'s OP_RETURN; must equal SHA256(payload)
//   inputCommitment     : REQUIRED — the on-chain commitment at the trader's input (33 bytes or a point)
//   receiveScriptPubKey : REQUIRED — the receipt output's scriptPubKey (tx.vout[1]), as confirmed
//   refundScriptPubKey  : REQUIRED — the refund output's scriptPubKey (tx.vout[2]), as confirmed

// Constant-product exact-in hop output: floor(R_out·in·(10000−fee) / (R_in·10000 + in·(10000−fee))),
// always strictly below R_out.
const U64_MAX = (1n << 64n) - 1n;

export function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
  const g = 10000n - BigInt(feeBps);
  const ainG = BigInt(amountIn) * g;
  return (BigInt(reserveOut) * ainG) / (BigInt(reserveIn) * 10000n + ainG);
}

// The hop-0 kernel message the guest verifies: the plain tacit-kernel-v1 closure over the trader's input
// outpoint → one all-zero sentinel output, with delta_in_0 as the net. The outpoint txid is in the byte
// order the envelope carries it. Verified under P = C_in − delta_in_0·H.
export function buildSwapRouteHop0KernelMsg({ traderInputAssetId, traderInputOutpointTxid, traderInputOutpointVout, deltaIn0 }) {
  const txid = asBytes(traderInputOutpointTxid, 32, 'traderInputOutpointTxid');
  return computeKernelMsg(
    asBytes(traderInputAssetId, 32, 'traderInputAssetId'),
    [{ txid: bytesToHex(reverseBytes(txid)), vout: traderInputOutpointVout }],
    [new Uint8Array(33)],
    BigInt(deltaIn0),
  );
}

export function hop0KernelVerifyPoint({ cInSecp, deltaIn0 }) {
  const cIn = secp.ProjectivePoint.fromHex(bytesToHex(asBytes(cInSecp, 33, 'cInSecp')));
  const d = BigInt(deltaIn0) % SECP_N;
  return d === 0n ? cIn : cIn.add(H.multiply(d).negate());
}

function asCommitBytes(c) {
  if (c instanceof Uint8Array) return c.length === 33 ? c : null;
  if (c && typeof c.toRawBytes === 'function') return c.toRawBytes(true);
  return undefined;
}

export function validateSwapRoute({
  payload, pools, currentHeight,
  opReturnData,
  inputCommitment,
  receiveScriptPubKey,
  refundScriptPubKey,
}) {
  for (const [name, v, where] of [
    ['receiveScriptPubKey', receiveScriptPubKey, 'the receipt output (tx.vout[1])'],
    ['refundScriptPubKey', refundScriptPubKey, 'the refund output (tx.vout[2])'],
  ]) {
    if (v === undefined) {
      throw new Error(
        `validateSwapRoute: ${name} is required — pass the scriptPubKey of ${where} ` +
        "so the validator can rebuild the destination the trader's intent_sig binds. " +
        'Take it from the confirmed tx, never reconstruct it from an assumed output type.',
      );
    }
  }
  if (opReturnData === undefined) {
    throw new Error(
      'validateSwapRoute: opReturnData is required — pass the 32-byte ' +
      "data from tx.vout[0]'s OP_RETURN so the validator can verify " +
      'SHA256(envelope_payload) == opReturnData.',
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
  if (!bytesEqual(opReturnData, computeSwapRouteEnvelopeHash(payload))) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }

  const inputCommitmentBytes = asCommitBytes(inputCommitment);
  if (inputCommitmentBytes === null) {
    return { valid: false, reason: 'inputCommitment must be 33-byte compressed point' };
  }
  if (inputCommitmentBytes === undefined) {
    return { valid: false, reason: 'inputCommitment must be ProjectivePoint or Uint8Array(33)' };
  }
  if (!bytesEqual(env.cInSecp, inputCommitmentBytes)) {
    return { valid: false, reason: 'env.cInSecp does not match on-chain input UTXO commit at outpoint' };
  }

  // ----- intent authorization (route shape, input amount, min_out, rReceipt, both destinations) -----
  let intentMsg;
  try {
    intentMsg = buildSwapRouteIntentMsg({
      traderPubkey: env.traderPubkey,
      traderInputAssetId: env.traderInputAssetId,
      traderOutputAssetId: env.traderOutputAssetId,
      minOut: env.minOut,
      expiryHeight: env.expiryHeight,
      hops: env.hops,
      cInSecp: env.cInSecp,
      rReceipt: env.rReceipt,
      receiveScriptPubKey,
      refundScriptPubKey,
    });
  } catch (e) { return { valid: false, reason: `intent_msg: ${e.message}` }; }
  let intentOk;
  try { intentOk = verifySchnorr(env.intentSig, intentMsg, env.traderPubkey.subarray(1)); }
  catch { intentOk = false; }
  if (!intentOk) return { valid: false, reason: 'intent_sig verification failed' };

  const refund = (reason) => ({
    valid: true,
    outcome: 'refund',
    reason,
    newPoolStates: new Map(),
    refund: { asset_id: env.traderInputAssetId, commitment: env.cInSecp },
  });

  // Expiry refunds rather than skips: the input is already spent by the confirmed tx.
  if (env.expiryHeight === 0 || env.expiryHeight < currentHeight) {
    return refund(`route expired (currentHeight ${currentHeight} > expiry ${env.expiryHeight})`);
  }

  // ----- stage every hop before committing any pool state (all-or-nothing) -----
  const staged = new Map();
  let curAsset = env.traderInputAssetId;
  let curAmount = 0n;
  let clearedToNothing = false;
  for (let k = 0; k < env.hops.length; k++) {
    const hop = env.hops[k];
    const pid = bytesToHex(hop.poolId);
    if (staged.has(pid)) return { valid: false, reason: `hop[${k}] pool repeated in route` };
    const pool = pools.get(pid);
    if (!pool) return { valid: false, reason: `pool not registered: ${pid}` };
    if (pool.tradable === false) return { valid: false, reason: `pool ${pid} not tradable` };
    let reserveA = BigInt(pool.reserve_A);
    let reserveB = BigInt(pool.reserve_B);
    const dir = hop.direction;
    const [assetIn, assetOut, rIn, rOut] = dir === 0
      ? [pool.asset_A, pool.asset_B, reserveA, reserveB]
      : [pool.asset_B, pool.asset_A, reserveB, reserveA];
    if (!bytesEqual(assetIn, curAsset)) {
      return {
        valid: false,
        reason: `hop[${k}] asset_in mismatch: expected ${bytesToHex(curAsset)}, got ${bytesToHex(assetIn)}`,
      };
    }
    let inMag;
    if (k === 0) {
      inMag = dir === 0 ? hop.deltaANetMag : hop.deltaBNetMag;
      if (inMag === 0n) return { valid: false, reason: 'zero route input' };
      const kernelMsg = buildSwapRouteHop0KernelMsg({
        traderInputAssetId: curAsset,
        traderInputOutpointTxid: env.traderInputOutpointTxid,
        traderInputOutpointVout: env.traderInputOutpointVout,
        deltaIn0: inMag,
      });
      let kernelOk = false;
      try {
        const P = hop0KernelVerifyPoint({ cInSecp: env.cInSecp, deltaIn0: inMag });
        if (!P.equals(ZERO)) kernelOk = verifySchnorr(env.kernelSig, kernelMsg, pointToBytes(P).subarray(1));
      } catch { kernelOk = false; }
      if (!kernelOk) return { valid: false, reason: 'kernel_sig verification failed (hop 0 input)' };
    } else {
      inMag = curAmount;
    }
    if (rIn === 0n || rOut === 0n) return { valid: false, reason: `hop[${k}] pool has an empty side` };
    const outMag = getAmountOut(inMag, rIn, rOut, pool.fee_bps);
    if (outMag === 0n) { clearedToNothing = true; break; }
    const rInPost = rIn + inMag;
    if (rInPost > U64_MAX) return { valid: false, reason: `hop[${k}] reserve_in + delta_in overflows u64` };
    const rOutPost = rOut - outMag;
    if (rInPost * rOutPost < rIn * rOut) {
      return { valid: false, reason: `hop[${k}] constant-product floor (k decreased)` };
    }
    if (dir === 0) { reserveA = rInPost; reserveB = rOutPost; } else { reserveB = rInPost; reserveA = rOutPost; }
    staged.set(pid, { reserve_A: reserveA, reserve_B: reserveB, delta_in: inMag, delta_out: outMag });
    curAsset = assetOut;
    curAmount = outMag;
  }

  if (clearedToNothing) return refund('a hop cleared to nothing');
  if (curAmount < env.minOut) {
    return refund(`min_out not met: cleared ${curAmount} < min_out ${env.minOut}`);
  }
  if (!bytesEqual(curAsset, env.traderOutputAssetId)) {
    return {
      valid: false,
      reason: `final hop asset_out mismatch: expected ${bytesToHex(env.traderOutputAssetId)}, got ${bytesToHex(curAsset)}`,
    };
  }

  const rReceiptN = modN(BigInt('0x' + bytesToHex(env.rReceipt)));
  const commitment = pointToBytes(pedersenCommit(curAmount, rReceiptN));
  const newPoolStates = new Map();
  for (const [pid, s] of staged) newPoolStates.set(pid, { reserve_A: s.reserve_A, reserve_B: s.reserve_B });
  return {
    valid: true,
    outcome: 'receipt',
    newPoolStates,
    hops: [...staged.values()].map(({ delta_in, delta_out }) => ({ delta_in, delta_out })),
    receipt: {
      asset_id: env.traderOutputAssetId,
      commitment,
      r_receipt: env.rReceipt,
      amount: curAmount,
    },
  };
}
