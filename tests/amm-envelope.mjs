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

export const OPCODE_T_LP_ADD     = 0x2d;
export const OPCODE_T_LP_REMOVE  = 0x2e;
export const OPCODE_T_SWAP_BATCH = 0x2f;
export const LP_ADD_VARIANT_STANDARD  = 0;
export const LP_ADD_VARIANT_POOL_INIT = 1;
export const FEE_BPS_MAX = 1000;
export const N_INTENTS_MAX = 16;
export const N_INTENTS_MIN = 1;

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
    asBytes(args.shareXcurveSigma, 157, 'shareXcurveSigma'),
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
    parts.push(new Uint8Array([arb.length]));
    for (const pk of arb) parts.push(asBytes(pk, 33, 'arbiterPubkey'));
    const lsigs = args.launcherSigs || [];
    if (lsigs.length > 2) throw new Error('launcherSigs count 0..2');
    parts.push(new Uint8Array([lsigs.length]));
    for (const sig of lsigs) parts.push(asBytes(sig, 64, 'launcherSig'));
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
  const shareXcurveSigma = payload.slice(off, off + 157); off += 157;
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
    result.feeBps = feeBps;
    result.vkCid = new TextDecoder('utf-8').decode(vkBytes);
    result.ceremonyCid = new TextDecoder('utf-8').decode(cerBytes);
    result.arbiterPubkeys = arbiterPubkeys;
    result.launcherSigs = launcherSigs;
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
    asBytes(args.recvAXcurveSigma, 157, 'recvAXcurveSigma'),
    asBytes(args.recvBCSecp, 33, 'recvBCSecp'),
    asBytes(args.recvBCBJJ, 32, 'recvBCBJJ'),
    asBytes(args.recvBXcurveSigma, 157, 'recvBXcurveSigma'),
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
  const recvAXcurveSigma = payload.slice(off, off + 157); off += 157;
  const recvBCSecp = payload.slice(off, off + 33); off += 33;
  const recvBCBJJ = payload.slice(off, off + 32); off += 32;
  const recvBXcurveSigma = payload.slice(off, off + 157); off += 157;
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

const PER_INTENT_BYTES  = 340;
const PER_RECEIPT_BYTES = 222;

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
//   arbiterBlock             : null | { expectedHeight, qualifyingSetHash(32), arbiterSig(64) }
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
    parts.push(asBytes(a.arbiterSig, 64, 'arbiterSig'));
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
    parts.push(asBytes(it.inXcurveSigma, 157, `intent[${i}].inXcurveSigma`));
    parts.push(u64LE(it.minOut));
    parts.push(u64LE(it.tipAmount));
    parts.push(u32LE(it.expiryHeight));
    parts.push(asBytes(it.intentSig, 64, `intent[${i}].intentSig`));

    // Canonical ordering: per-intent blocks MUST appear in intent_id ascending byte-order.
    // We don't have intent_id here directly (it's SHA256(intent_msg)) but callers should
    // pre-sort. Validate that any pre-sorted hint is respected:
    if (it._intentId) {
      const cur = asBytes(it._intentId, 32, `intent[${i}]._intentId`);
      if (prevIntentId !== null) {
        for (let j = 0; j < 32; j++) {
          if (cur[j] < prevIntentId[j]) throw new Error(`intents not in intent_id ascending order at i=${i}`);
          if (cur[j] > prevIntentId[j]) break;
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
    parts.push(asBytes(r.outXcurveSigma, 157, `receipt[${i}].outXcurveSigma`));
  }

  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large');
  parts.push(u16LE(proof.length), proof);

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
    const arbiterSig = payload.slice(off, off + 64); off += 64;
    arbiterBlock = { expectedHeight, qualifyingSetHash, arbiterSig };
  }

  const intents = [];
  for (let i = 0; i < nIntents; i++) {
    const direction = payload[off++];
    if (direction !== 0 && direction !== 1) throw new Error(`intent[${i}].direction must be 0 or 1`);
    const traderPubkey = payload.slice(off, off + 33); off += 33;
    const cInSecp = payload.slice(off, off + 33); off += 33;
    const cInBjj = payload.slice(off, off + 32); off += 32;
    const inXcurveSigma = payload.slice(off, off + 157); off += 157;
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
    const outXcurveSigma = payload.slice(off, off + 157); off += 157;
    receipts.push({ cOutSecp, cOutBjj, outXcurveSigma });
  }

  if (off + 2 > payload.length) throw new Error('truncated: missing proof_len');
  const proofLen = readU16LE(payload, off); off += 2;
  if (off + proofLen > payload.length) throw new Error('truncated: missing proof bytes');
  const proof = payload.slice(off, off + proofLen);
  off += proofLen;
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
  };
}

// Reports the per-trader block + per-receipt block byte sizes (useful for fee
// calculations).
export const ENVELOPE_PER_INTENT_BYTES  = PER_INTENT_BYTES;
export const ENVELOPE_PER_RECEIPT_BYTES = PER_RECEIPT_BYTES;
