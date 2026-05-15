// Envelope encoders/decoders for the three AMM opcodes.
//
// Per AMM.md §"Envelope byte layouts" (Implementation specification §1).
// Layouts are normative; indexers reject any deviation.
//
// Opcodes:
//   T_LP_ADD     = 0x2D  (variant 0 standard, variant 1 POOL_INIT)
//   T_LP_REMOVE  = 0x2E
//   T_SWAP_BATCH = 0x2F
//
// Each opcode's payload sits inside the envelope script-leaf at
// `tx.vin[0].witness[1]` wrapped by `OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF`.
// This module deals strictly with the inner <payload> bytes.

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { XCURVE_PROOF_LEN } from './amm-sigma-xcurve.mjs';

export const OPCODE_T_LP_ADD              = 0x2d;
export const OPCODE_T_LP_REMOVE           = 0x2e;
export const OPCODE_T_SWAP_BATCH          = 0x2f;
export const OPCODE_T_AMM_ATTEST          = 0x30;
export const OPCODE_T_PROTOCOL_FEE_CLAIM  = 0x31;
export const LP_ADD_VARIANT_STANDARD  = 0;
export const LP_ADD_VARIANT_POOL_INIT = 1;
export const FEE_BPS_MAX = 1000;
export const PROTOCOL_FEE_BPS_MAX = 1000; // capped at 10% of pool LP-fee growth
export const PROTOCOL_FEE_ADDRESS_ZERO = new Uint8Array(33); // all-zeros = no protocol fee
export const N_INTENTS_MAX = 16;
export const N_INTENTS_MIN = 1;

function isZeroAddress(addr) {
  if (!(addr instanceof Uint8Array) || addr.length !== 33) return false;
  for (let i = 0; i < 33; i++) if (addr[i] !== 0) return false;
  return true;
}

// ---- byte helpers ----
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
function u16LE(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function u64LE(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function readU32LE(buf, off) { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off, true); }
function readU16LE(buf, off) { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(off, true); }
function readU64LE(buf, off) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(buf[off + i]);
  return n;
}

// Signed u64 with explicit 1-byte sign: T_SWAP_BATCH delta_X_net format.
function signedU64Encode(value /* bigint */) {
  let mag, sign;
  if (value < 0n) { sign = 1; mag = -value; }
  else { sign = 0; mag = value; }
  if (mag >= 1n << 64n) throw new Error('signed u64 magnitude overflow');
  return concatBytes(new Uint8Array([sign]), u64LE(mag));
}
function signedU64Decode(buf, off) {
  const sign = buf[off];
  if (sign !== 0 && sign !== 1) throw new Error(`bad sign byte ${sign}`);
  const mag = readU64LE(buf, off + 1);
  return sign === 0 ? mag : -mag;
}

function assertOpcode(buf, expected, name) {
  if (buf.length === 0) throw new Error(`${name}: empty payload`);
  if (buf[0] !== expected) throw new Error(`${name}: expected opcode 0x${expected.toString(16)}, got 0x${buf[0].toString(16)}`);
}

// =========================================================================
// T_LP_ADD (0x2D)
// =========================================================================

// encodeLpAdd({ ... }) → Uint8Array
//
// Required (variant 0):
//   variant: 0
//   assetA, assetB        : 32-byte Uint8Array or hex
//   deltaA, deltaB        : bigint > 0
//   shareAmount           : bigint > 0
//   shareCSecp            : 33 bytes
//   shareCBJJ             : 32 bytes
//   shareXcurveSigma      : 157 bytes
//   kernelSigA, kernelSigB: 64 bytes each
//   proof                 : Uint8Array (Groth16 proof bytes)
//
// Additional for variant 1 (POOL_INIT):
//   feeBps                : 0..1000
//   vkCid                 : UTF-8 string, length 1..64
//   ceremonyCid           : UTF-8 string, length 1..64
//   arbiterPubkeys        : array of 33-byte compressed pubkeys (0..16)
//   launcherSigs          : array of 64-byte BIP-340 sigs (0..2)
export function encodeLpAdd(args) {
  const variant = args.variant;
  if (variant !== 0 && variant !== 1) throw new Error('variant must be 0 or 1');

  const parts = [
    new Uint8Array([OPCODE_T_LP_ADD, variant]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    u64LE(args.deltaA),
    u64LE(args.deltaB),
    u64LE(args.shareAmount),
    asBytes(args.shareCSecp, 33, 'shareCSecp'),
    asBytes(args.shareCBJJ, 32, 'shareCBJJ'),
    asBytes(args.shareXcurveSigma, XCURVE_PROOF_LEN, 'shareXcurveSigma'),
    asBytes(args.kernelSigA, 64, 'kernelSigA'),
    asBytes(args.kernelSigB, 64, 'kernelSigB'),
  ];

  if (variant === 1) {
    if (typeof args.feeBps !== 'number' || args.feeBps < 0 || args.feeBps > FEE_BPS_MAX) {
      throw new Error(`feeBps must be 0..${FEE_BPS_MAX}`);
    }
    parts.push(u16LE(args.feeBps));
    const vkBytes = new TextEncoder().encode(args.vkCid);
    if (vkBytes.length < 1 || vkBytes.length > 64) throw new Error('vkCid length 1..64 bytes');
    parts.push(new Uint8Array([vkBytes.length]), vkBytes);
    const cerBytes = new TextEncoder().encode(args.ceremonyCid);
    if (cerBytes.length < 1 || cerBytes.length > 64) throw new Error('ceremonyCid length 1..64 bytes');
    parts.push(new Uint8Array([cerBytes.length]), cerBytes);
    const arb = args.arbiterPubkeys || [];
    if (arb.length > 16) throw new Error('arbiterPubkeys count 0..16');
    const arbM = args.arbiterThresholdM ?? (arb.length > 0 ? 1 : 0);
    if (arb.length === 0 && arbM !== 0) {
      throw new Error('arbiterThresholdM must be 0 when no arbiter pubkeys pinned');
    }
    if (arb.length > 0 && (arbM < 1 || arbM > arb.length)) {
      throw new Error(`arbiterThresholdM must be 1..${arb.length}`);
    }
    parts.push(new Uint8Array([arb.length, arbM]));
    for (const pk of arb) parts.push(asBytes(pk, 33, 'arbiterPubkey'));
    const lsigs = args.launcherSigs || [];
    if (lsigs.length > 2) throw new Error('launcherSigs count 0..2');
    parts.push(new Uint8Array([lsigs.length]));
    for (const sig of lsigs) parts.push(asBytes(sig, 64, 'launcherSig'));
    // Protocol-fee placeholder (founder-set, immutable). all-zeros address = no fee.
    const protoAddr = args.protocolFeeAddress || PROTOCOL_FEE_ADDRESS_ZERO;
    parts.push(asBytes(protoAddr, 33, 'protocolFeeAddress'));
    const protoBps = args.protocolFeeBps || 0;
    if (typeof protoBps !== 'number' || protoBps < 0 || protoBps > PROTOCOL_FEE_BPS_MAX) {
      throw new Error(`protocolFeeBps must be 0..${PROTOCOL_FEE_BPS_MAX}`);
    }
    // If bps > 0, the address MUST be non-zero (otherwise fee is unclaimable forever).
    if (protoBps > 0 && isZeroAddress(protoAddr)) {
      throw new Error('protocolFeeBps > 0 requires non-zero protocolFeeAddress');
    }
    // If address is non-zero, bps MUST be > 0 (otherwise the address is dead weight).
    if (!isZeroAddress(protoAddr) && protoBps === 0) {
      throw new Error('non-zero protocolFeeAddress requires protocolFeeBps > 0');
    }
    parts.push(u16LE(protoBps));
    // Optional pool_meta_uri — informational dapp metadata pointer
    // (description, logo, IPFS CID, website). Never consensus-bound;
    // indexer does not dereference. Length 0..255.
    const metaUri = args.poolMetaUri ?? '';
    const metaBytes = new TextEncoder().encode(metaUri);
    if (metaBytes.length > 255) throw new Error('poolMetaUri length must be 0..255 bytes');
    parts.push(new Uint8Array([metaBytes.length]), metaBytes);
    // Pool capability flags — u8 bitmap declaring opt-in behaviors.
    //   bit 0 (0x01) — LP_ADD requires T_RANGE_ATTEST under this pool's scope
    //   bits 1-7 — reserved for future amendments
    // Default 0 = standard V1 pool. Closest analog to Uniswap V4 hooks
    // (protocol-defined feature flags, NOT pluggable executable code).
    const capFlags = args.poolCapabilityFlags ?? 0;
    if (capFlags < 0 || capFlags > 0xff) throw new Error('poolCapabilityFlags must be u8');
    parts.push(new Uint8Array([capFlags]));
  }

  // Tail: proof_len_LE(2) || proof
  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large (> 65535 bytes)');
  parts.push(u16LE(proof.length), proof);

  return concatBytes(...parts);
}

export function decodeLpAdd(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  assertOpcode(payload, OPCODE_T_LP_ADD, 'T_LP_ADD');
  let off = 1;
  const variant = payload[off++];
  if (variant !== 0 && variant !== 1) throw new Error(`bad variant ${variant}`);
  const assetA = payload.slice(off, off + 32); off += 32;
  const assetB = payload.slice(off, off + 32); off += 32;
  const deltaA = readU64LE(payload, off); off += 8;
  const deltaB = readU64LE(payload, off); off += 8;
  const shareAmount = readU64LE(payload, off); off += 8;
  const shareCSecp = payload.slice(off, off + 33); off += 33;
  const shareCBJJ = payload.slice(off, off + 32); off += 32;
  const shareXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
  const kernelSigA = payload.slice(off, off + 64); off += 64;
  const kernelSigB = payload.slice(off, off + 64); off += 64;

  const result = { variant, assetA, assetB, deltaA, deltaB, shareAmount, shareCSecp, shareCBJJ, shareXcurveSigma, kernelSigA, kernelSigB };

  if (variant === 1) {
    if (off + 2 > payload.length) throw new Error('truncated: missing fee_bps');
    const feeBps = readU16LE(payload, off); off += 2;
    if (feeBps > FEE_BPS_MAX) throw new Error(`fee_bps out of range: ${feeBps}`);
    const vkLen = payload[off++];
    if (vkLen < 1 || vkLen > 64) throw new Error('vk_cid length out of range');
    const vkBytes = payload.slice(off, off + vkLen); off += vkLen;
    const cerLen = payload[off++];
    if (cerLen < 1 || cerLen > 64) throw new Error('ceremony_cid length out of range');
    const cerBytes = payload.slice(off, off + cerLen); off += cerLen;
    const arbCount = payload[off++];
    if (arbCount > 16) throw new Error('arbiter_count out of range');
    const arbThresholdM = payload[off++];
    if (arbCount === 0 && arbThresholdM !== 0) {
      throw new Error('arbiter_threshold_m must be 0 when arbiter_count = 0');
    }
    if (arbCount > 0 && (arbThresholdM < 1 || arbThresholdM > arbCount)) {
      throw new Error(`arbiter_threshold_m out of range: ${arbThresholdM} (count ${arbCount})`);
    }
    const arbiterPubkeys = [];
    for (let i = 0; i < arbCount; i++) {
      arbiterPubkeys.push(payload.slice(off, off + 33));
      off += 33;
    }
    const lsigCount = payload[off++];
    if (lsigCount > 2) throw new Error('launcher_sig_count out of range');
    const launcherSigs = [];
    for (let i = 0; i < lsigCount; i++) {
      launcherSigs.push(payload.slice(off, off + 64));
      off += 64;
    }
    if (off + 33 > payload.length) throw new Error('truncated: missing protocol_fee_address');
    const protocolFeeAddress = payload.slice(off, off + 33); off += 33;
    if (off + 2 > payload.length) throw new Error('truncated: missing protocol_fee_bps');
    const protocolFeeBps = readU16LE(payload, off); off += 2;
    if (protocolFeeBps > PROTOCOL_FEE_BPS_MAX) {
      throw new Error(`protocol_fee_bps out of range: ${protocolFeeBps}`);
    }
    if (protocolFeeBps > 0 && isZeroAddress(protocolFeeAddress)) {
      throw new Error('protocol_fee_bps > 0 with zero address');
    }
    if (!isZeroAddress(protocolFeeAddress) && protocolFeeBps === 0) {
      throw new Error('non-zero protocol_fee_address with zero bps');
    }
    result.feeBps = feeBps;
    result.vkCid = new TextDecoder('utf-8').decode(vkBytes);
    result.ceremonyCid = new TextDecoder('utf-8').decode(cerBytes);
    // Optional pool_meta_uri — cosmetic dapp pointer. 0..255 byte UTF-8.
    if (off + 1 > payload.length) throw new Error('truncated: missing pool_meta_uri_len');
    const metaLen = payload[off++];
    if (off + metaLen > payload.length) throw new Error('truncated: missing pool_meta_uri bytes');
    const poolMetaUri = metaLen === 0 ? '' : new TextDecoder('utf-8').decode(payload.slice(off, off + metaLen));
    off += metaLen;

    // Pool capability flags — u8 bitmap.
    if (off + 1 > payload.length) throw new Error('truncated: missing pool_capability_flags');
    const poolCapabilityFlags = payload[off++];

    result.arbiterPubkeys = arbiterPubkeys;
    result.arbiterThresholdM = arbThresholdM;
    result.launcherSigs = launcherSigs;
    result.protocolFeeAddress = protocolFeeAddress;
    result.protocolFeeBps = protocolFeeBps;
    result.poolMetaUri = poolMetaUri;
    result.poolCapabilityFlags = poolCapabilityFlags;
  }

  if (off + 2 > payload.length) throw new Error('truncated: missing proof_len');
  const proofLen = readU16LE(payload, off); off += 2;
  if (off + proofLen > payload.length) throw new Error('truncated: missing proof bytes');
  result.proof = payload.slice(off, off + proofLen);
  off += proofLen;
  if (off !== payload.length) throw new Error(`trailing bytes after payload (${payload.length - off})`);

  return result;
}

// =========================================================================
// T_LP_REMOVE (0x2E)
// =========================================================================

export function encodeLpRemove(args) {
  const parts = [
    new Uint8Array([OPCODE_T_LP_REMOVE]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    u64LE(args.shareAmount),
    u64LE(args.deltaA),
    u64LE(args.deltaB),
    asBytes(args.recvACSecp, 33, 'recvACSecp'),
    asBytes(args.recvACBJJ, 32, 'recvACBJJ'),
    asBytes(args.recvAXcurveSigma, XCURVE_PROOF_LEN, 'recvAXcurveSigma'),
    asBytes(args.recvBCSecp, 33, 'recvBCSecp'),
    asBytes(args.recvBCBJJ, 32, 'recvBCBJJ'),
    asBytes(args.recvBXcurveSigma, XCURVE_PROOF_LEN, 'recvBXcurveSigma'),
    asBytes(args.kernelSigLP, 64, 'kernelSigLP'),
  ];
  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large');
  parts.push(u16LE(proof.length), proof);
  return concatBytes(...parts);
}

export function decodeLpRemove(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  assertOpcode(payload, OPCODE_T_LP_REMOVE, 'T_LP_REMOVE');
  let off = 1;
  const assetA = payload.slice(off, off + 32); off += 32;
  const assetB = payload.slice(off, off + 32); off += 32;
  const shareAmount = readU64LE(payload, off); off += 8;
  const deltaA = readU64LE(payload, off); off += 8;
  const deltaB = readU64LE(payload, off); off += 8;
  const recvACSecp = payload.slice(off, off + 33); off += 33;
  const recvACBJJ = payload.slice(off, off + 32); off += 32;
  const recvAXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
  const recvBCSecp = payload.slice(off, off + 33); off += 33;
  const recvBCBJJ = payload.slice(off, off + 32); off += 32;
  const recvBXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
  const kernelSigLP = payload.slice(off, off + 64); off += 64;
  if (off + 2 > payload.length) throw new Error('truncated: missing proof_len');
  const proofLen = readU16LE(payload, off); off += 2;
  if (off + proofLen > payload.length) throw new Error('truncated: missing proof bytes');
  const proof = payload.slice(off, off + proofLen);
  off += proofLen;
  if (off !== payload.length) throw new Error('trailing bytes after payload');
  return {
    assetA, assetB, shareAmount, deltaA, deltaB,
    recvACSecp, recvACBJJ, recvAXcurveSigma,
    recvBCSecp, recvBCBJJ, recvBXcurveSigma,
    kernelSigLP, proof,
  };
}

// =========================================================================
// T_SWAP_BATCH (0x2F)
// =========================================================================

// Per-intent block:
//   direction(1) || trader_pubkey(33) || C_in_secp(33) || C_in_BJJ(32)
//   || in_xcurve_sigma(157) || min_out_LE(8) || tip_amount_LE(8)
//   || expiry_height_LE(4) || intent_sig(64)
// = 1 + 33 + 33 + 32 + 157 + 8 + 8 + 4 + 64 = 340 bytes per intent
//
// Per-receipt block:
//   C_out_secp(33) || C_out_BJJ(32) || out_xcurve_sigma(157)
// = 222 bytes per receipt

const PER_INTENT_BYTES  = 1 + 33 + 33 + 32 + XCURVE_PROOF_LEN + 8 + 8 + 4 + 64; // 352 at v1
const PER_RECEIPT_BYTES = 33 + 32 + XCURVE_PROOF_LEN;                            // 234 at v1

// args:
//   assetA, assetB           : 32 B each
//   nIntents                 : 1..16
//   deltaANetSigned          : bigint (signed)
//   deltaBNetSigned          : bigint (signed)
//   rNetA, rNetB             : 32 B each
//   feeBpsAtSettle           : 0..1000
//   tipAAmount, tipBAmount   : bigint
//   tipACSecp, tipBCSecp     : 33 B each
//   rTipA, rTipB             : 32 B each
//   arbiterBlock             : null | { expectedHeight, qualifyingSetHash(32),
//                                        m(u8 1..16), signerIndices: u8[m] ascending distinct,
//                                        sigs: Uint8Array(64 * m) concatenated BIP-340 }
//   intents                  : array of {
//                                direction, traderPubkey, cInSecp, cInBjj,
//                                inXcurveSigma, minOut, tipAmount,
//                                expiryHeight, intentSig,
//                              }, length === nIntents
//   receipts                 : array of { cOutSecp, cOutBjj, outXcurveSigma },
//                                length === nIntents
//   proof                    : Uint8Array
export function encodeSwapBatch(args) {
  if (typeof args.nIntents !== 'number' || args.nIntents < N_INTENTS_MIN || args.nIntents > N_INTENTS_MAX) {
    throw new Error(`nIntents must be ${N_INTENTS_MIN}..${N_INTENTS_MAX}`);
  }
  if (!Array.isArray(args.intents) || args.intents.length !== args.nIntents) {
    throw new Error('intents.length must equal nIntents');
  }
  if (!Array.isArray(args.receipts) || args.receipts.length !== args.nIntents) {
    throw new Error('receipts.length must equal nIntents');
  }
  if (args.feeBpsAtSettle < 0 || args.feeBpsAtSettle > FEE_BPS_MAX) {
    throw new Error(`fee_bps_at_settle out of range`);
  }

  const parts = [
    new Uint8Array([OPCODE_T_SWAP_BATCH]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    new Uint8Array([args.nIntents]),
    signedU64Encode(BigInt(args.deltaANetSigned)),
    signedU64Encode(BigInt(args.deltaBNetSigned)),
    asBytes(args.rNetA, 32, 'rNetA'),
    asBytes(args.rNetB, 32, 'rNetB'),
    u16LE(args.feeBpsAtSettle),
    u64LE(args.tipAAmount),
    u64LE(args.tipBAmount),
    asBytes(args.tipACSecp, 33, 'tipACSecp'),
    asBytes(args.tipBCSecp, 33, 'tipBCSecp'),
    asBytes(args.rTipA, 32, 'rTipA'),
    asBytes(args.rTipB, 32, 'rTipB'),
  ];

  if (args.arbiterBlock) {
    const a = args.arbiterBlock;
    parts.push(u32LE(a.expectedHeight));
    parts.push(asBytes(a.qualifyingSetHash, 32, 'qualifyingSetHash'));
    const m = a.m;
    if (typeof m !== 'number' || m < 1 || m > 16) {
      throw new Error('arbiterBlock.m must be 1..16');
    }
    if (!Array.isArray(a.signerIndices) || a.signerIndices.length !== m) {
      throw new Error(`arbiterBlock.signerIndices must have length ${m}`);
    }
    for (let i = 0; i < m; i++) {
      const idx = a.signerIndices[i];
      if (typeof idx !== 'number' || idx < 0 || idx > 15) {
        throw new Error(`arbiterBlock.signerIndices[${i}] must be 0..15`);
      }
      if (i > 0 && idx <= a.signerIndices[i - 1]) {
        throw new Error(`arbiterBlock.signerIndices must be ascending distinct`);
      }
    }
    if (!(a.sigs instanceof Uint8Array) || a.sigs.length !== 64 * m) {
      throw new Error(`arbiterBlock.sigs must be Uint8Array of length ${64 * m}`);
    }
    parts.push(new Uint8Array([m, ...a.signerIndices]));
    parts.push(a.sigs);
  }

  // Per-intent blocks
  let prevIntentId = null;
  for (let i = 0; i < args.intents.length; i++) {
    const it = args.intents[i];
    if (it.direction !== 0 && it.direction !== 1) throw new Error(`intent[${i}].direction must be 0 or 1`);
    parts.push(new Uint8Array([it.direction]));
    parts.push(asBytes(it.traderPubkey, 33, `intent[${i}].traderPubkey`));
    parts.push(asBytes(it.cInSecp, 33, `intent[${i}].cInSecp`));
    parts.push(asBytes(it.cInBjj, 32, `intent[${i}].cInBjj`));
    parts.push(asBytes(it.inXcurveSigma, XCURVE_PROOF_LEN, `intent[${i}].inXcurveSigma`));
    parts.push(u64LE(it.minOut));
    parts.push(u64LE(it.tipAmount));
    parts.push(u32LE(it.expiryHeight));
    parts.push(asBytes(it.intentSig, 64, `intent[${i}].intentSig`));

    // Canonical ordering: per-intent blocks MUST appear in STRICTLY
    // ascending intent_id byte-order (equal == duplicate, rejected).
    // We don't have intent_id here directly (it's SHA256(intent_msg)) but callers should
    // pre-sort. Validate that any pre-sorted hint is respected:
    if (it._intentId) {
      const cur = asBytes(it._intentId, 32, `intent[${i}]._intentId`);
      if (prevIntentId !== null) {
        let cmp = 0;
        for (let j = 0; j < 32; j++) {
          if (cur[j] < prevIntentId[j]) { cmp = -1; break; }
          if (cur[j] > prevIntentId[j]) { cmp = 1; break; }
        }
        if (cmp <= 0) {
          throw new Error(cmp === 0
            ? `duplicate intent_id at i=${i}`
            : `intents not in intent_id ascending order at i=${i}`);
        }
      }
      prevIntentId = cur;
    }
  }

  // Per-receipt blocks
  for (let i = 0; i < args.receipts.length; i++) {
    const r = args.receipts[i];
    parts.push(asBytes(r.cOutSecp, 33, `receipt[${i}].cOutSecp`));
    parts.push(asBytes(r.cOutBjj, 32, `receipt[${i}].cOutBjj`));
    parts.push(asBytes(r.outXcurveSigma, XCURVE_PROOF_LEN, `receipt[${i}].outXcurveSigma`));
  }

  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large');
  parts.push(u16LE(proof.length), proof);

  // Optional settler_meta_uri — informational pointer the settler tags
  // their batch with (settler version, identity, analytics URL). Never
  // consensus-bound; indexer does not dereference. 0..255 byte UTF-8.
  const settlerUri = args.settlerMetaUri ?? '';
  const settlerBytes = new TextEncoder().encode(settlerUri);
  if (settlerBytes.length > 255) throw new Error('settlerMetaUri length must be 0..255 bytes');
  parts.push(new Uint8Array([settlerBytes.length]), settlerBytes);

  return concatBytes(...parts);
}

// Decodes a T_SWAP_BATCH payload. Requires `hasArbiter` hint from pool config.
export function decodeSwapBatch(payload, { hasArbiter = false } = {}) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  assertOpcode(payload, OPCODE_T_SWAP_BATCH, 'T_SWAP_BATCH');
  let off = 1;
  const assetA = payload.slice(off, off + 32); off += 32;
  const assetB = payload.slice(off, off + 32); off += 32;
  const nIntents = payload[off++];
  if (nIntents < N_INTENTS_MIN || nIntents > N_INTENTS_MAX) throw new Error(`n_intents out of range: ${nIntents}`);

  const deltaANetSigned = signedU64Decode(payload, off); off += 9;
  const deltaBNetSigned = signedU64Decode(payload, off); off += 9;
  const rNetA = payload.slice(off, off + 32); off += 32;
  const rNetB = payload.slice(off, off + 32); off += 32;
  const feeBpsAtSettle = readU16LE(payload, off); off += 2;
  if (feeBpsAtSettle > FEE_BPS_MAX) throw new Error(`fee_bps_at_settle out of range: ${feeBpsAtSettle}`);
  const tipAAmount = readU64LE(payload, off); off += 8;
  const tipBAmount = readU64LE(payload, off); off += 8;
  const tipACSecp = payload.slice(off, off + 33); off += 33;
  const tipBCSecp = payload.slice(off, off + 33); off += 33;
  const rTipA = payload.slice(off, off + 32); off += 32;
  const rTipB = payload.slice(off, off + 32); off += 32;

  let arbiterBlock = null;
  if (hasArbiter) {
    const expectedHeight = readU32LE(payload, off); off += 4;
    const qualifyingSetHash = payload.slice(off, off + 32); off += 32;
    const m = payload[off++];
    if (m < 1 || m > 16) throw new Error(`arbiter m out of range: ${m}`);
    if (off + m + 64 * m > payload.length) throw new Error('truncated: arbiter signerIndices/sigs');
    const signerIndices = [];
    for (let i = 0; i < m; i++) {
      const idx = payload[off++];
      if (idx > 15) throw new Error(`arbiter signerIndices[${i}] out of range: ${idx}`);
      if (i > 0 && idx <= signerIndices[i - 1]) {
        throw new Error('arbiter signerIndices must be ascending distinct');
      }
      signerIndices.push(idx);
    }
    const sigs = payload.slice(off, off + 64 * m); off += 64 * m;
    arbiterBlock = { expectedHeight, qualifyingSetHash, m, signerIndices, sigs };
  }

  const intents = [];
  for (let i = 0; i < nIntents; i++) {
    const direction = payload[off++];
    if (direction !== 0 && direction !== 1) throw new Error(`intent[${i}].direction must be 0 or 1`);
    const traderPubkey = payload.slice(off, off + 33); off += 33;
    const cInSecp = payload.slice(off, off + 33); off += 33;
    const cInBjj = payload.slice(off, off + 32); off += 32;
    const inXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
    const minOut = readU64LE(payload, off); off += 8;
    const tipAmount = readU64LE(payload, off); off += 8;
    const expiryHeight = readU32LE(payload, off); off += 4;
    const intentSig = payload.slice(off, off + 64); off += 64;
    intents.push({ direction, traderPubkey, cInSecp, cInBjj, inXcurveSigma, minOut, tipAmount, expiryHeight, intentSig });
  }

  const receipts = [];
  for (let i = 0; i < nIntents; i++) {
    const cOutSecp = payload.slice(off, off + 33); off += 33;
    const cOutBjj = payload.slice(off, off + 32); off += 32;
    const outXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
    receipts.push({ cOutSecp, cOutBjj, outXcurveSigma });
  }

  if (off + 2 > payload.length) throw new Error('truncated: missing proof_len');
  const proofLen = readU16LE(payload, off); off += 2;
  if (off + proofLen > payload.length) throw new Error('truncated: missing proof bytes');
  const proof = payload.slice(off, off + proofLen);
  off += proofLen;

  // Optional settler_meta_uri (0..255 byte UTF-8). Informational only.
  if (off + 1 > payload.length) throw new Error('truncated: missing settler_meta_uri_len');
  const settlerLen = payload[off++];
  if (off + settlerLen > payload.length) throw new Error('truncated: missing settler_meta_uri bytes');
  const settlerMetaUri = settlerLen === 0
    ? '' : new TextDecoder('utf-8').decode(payload.slice(off, off + settlerLen));
  off += settlerLen;

  if (off !== payload.length) throw new Error('trailing bytes after payload');

  return {
    assetA, assetB, nIntents,
    deltaANetSigned, deltaBNetSigned,
    rNetA, rNetB,
    feeBpsAtSettle,
    tipAAmount, tipBAmount, tipACSecp, tipBCSecp, rTipA, rTipB,
    arbiterBlock,
    intents, receipts,
    proof,
    settlerMetaUri,
  };
}

// Reports the per-trader block + per-receipt block byte sizes (useful for fee
// calculations).
export const ENVELOPE_PER_INTENT_BYTES  = PER_INTENT_BYTES;
export const ENVELOPE_PER_RECEIPT_BYTES = PER_RECEIPT_BYTES;

// =========================================================================
// T_PROTOCOL_FEE_CLAIM (0x31)
// =========================================================================
//
// Authenticated mint of accrued LP-share protocol-fee balance to a UTXO at the
// pool's pinned protocol_fee_address. No Groth16 — the claim amount is public
// (it equals pool.protocol_fee_accrued at decode time), and the lp_share
// commitment uses a public opening (amount, blinding) since lp_share is
// fungible and the address is already public.
//
// Wire format (fixed 202 bytes):
//   opcode(1)                  = 0x31
//   pool_id(32)                # SHA256("tacit-amm-pool-v1" || asset_A || asset_B)
//   claimer_pubkey_x_only(32)  # x-only of pool.protocol_fee_address
//   claim_amount_LE(8)         # u64, > 0; must == pool.protocol_fee_accrued
//   claim_C_secp(33)           # Pedersen commitment of claim_amount with chosen blinding
//   claim_blinding(32)         # r_secp (revealed)
//   claim_sig(64)              # BIP-340 over claim_msg below

const PROTOCOL_FEE_CLAIM_FIXED_BYTES = 1 + 32 + 32 + 8 + 33 + 32 + 64; // 202

export function encodeProtocolFeeClaim(args) {
  const parts = [
    new Uint8Array([OPCODE_T_PROTOCOL_FEE_CLAIM]),
    asBytes(args.poolId, 32, 'poolId'),
    asBytes(args.claimerPubkeyXOnly, 32, 'claimerPubkeyXOnly'),
    u64LE(args.claimAmount),
    asBytes(args.claimCSecp, 33, 'claimCSecp'),
    asBytes(args.claimBlinding, 32, 'claimBlinding'),
    asBytes(args.claimSig, 64, 'claimSig'),
  ];
  return concatBytes(...parts);
}

export function decodeProtocolFeeClaim(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  assertOpcode(payload, OPCODE_T_PROTOCOL_FEE_CLAIM, 'T_PROTOCOL_FEE_CLAIM');
  if (payload.length !== PROTOCOL_FEE_CLAIM_FIXED_BYTES) {
    throw new Error(`T_PROTOCOL_FEE_CLAIM: expected ${PROTOCOL_FEE_CLAIM_FIXED_BYTES} bytes, got ${payload.length}`);
  }
  let off = 1;
  const poolId               = payload.slice(off, off + 32); off += 32;
  const claimerPubkeyXOnly   = payload.slice(off, off + 32); off += 32;
  const claimAmount          = readU64LE(payload, off);     off += 8;
  const claimCSecp           = payload.slice(off, off + 33); off += 33;
  const claimBlinding        = payload.slice(off, off + 32); off += 32;
  const claimSig             = payload.slice(off, off + 64); off += 64;
  if (claimAmount === 0n) throw new Error('claim_amount must be > 0');
  return { poolId, claimerPubkeyXOnly, claimAmount, claimCSecp, claimBlinding, claimSig };
}

export const ENVELOPE_PROTOCOL_FEE_CLAIM_BYTES = PROTOCOL_FEE_CLAIM_FIXED_BYTES;
