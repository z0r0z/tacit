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

// ── Canonical encoders: delegated, never re-implemented ──────────────────────────────────────────
// T_LP_ADD, T_LP_REMOVE and T_PROTOCOL_FEE_CLAIM are produced by dapp/amm-envelope.js, which is the
// single source these bytes are defined by (the worker decoder and the guest parser are held byte-exact
// against it). This module used to carry its own copy of them; that copy silently fell behind the real
// layout twice — once missing the share opening blinding, once the two lp-remove blindings — and each
// time the tests kept passing against their own wrong bytes. Delegating removes the drift surface.
//
// The wrappers below only supply test-ergonomic defaults for fields these older tests predate, so a
// test that does not care about a field still emits a CURRENT, valid payload rather than a stale one:
//   - shareR / rRecvA / rRecvB : the option-a reflection opening blindings, zero unless given.
//   - the refund tail          : a losing or expired add returns delta_a / delta_b to owner-bound refund
//                                notes instead of self-burning; defaults to TEST_LP_ADD_REFUND_TAIL.
// A test that exercises any of those passes them explicitly and the default is not used. Legacy arg
// spellings are mapped to the canonical ones so call sites did not have to be rewritten en masse.
// T_SWAP_BATCH stays implemented below: it has no dapp encoder (the op is disabled this generation).
import {
  encodeLpAdd as _encodeLpAdd,
  encodeLpRemove as _encodeLpRemove,
  encodeProtocolFeeClaim as _encodeProtocolFeeClaim,
} from '../dapp/amm-envelope.js';
import { TEST_LP_ADD_REFUND_TAIL } from './helpers/amm-refund-tail.mjs';

import {
  decodeLpAdd as _decodeLpAdd,
  decodeLpRemove as _decodeLpRemove,
  decodeProtocolFeeClaim as _decodeProtocolFeeClaim,
} from '../dapp/amm-envelope.js';

// The canonical decoders report a malformed payload by returning null (an indexer skips it rather
// than dying on attacker-supplied bytes). These tests were written against a decoder that threw and
// assert on WHY it rejected, so the wrappers re-derive the reason from the payload and throw with it.
// The accepted bytes are the canonical decoder's — only the shape of the rejection differs.
function _rejectReason(payload, opcode, name, { variantByte = false } = {}) {
  if (!(payload instanceof Uint8Array)) return `${name}: payload must be Uint8Array`;
  if (payload.length === 0) return `${name}: truncated payload`;
  if (payload[0] !== opcode) {
    return `${name}: expected opcode 0x${opcode.toString(16).toUpperCase()}, got 0x${payload[0].toString(16)}`;
  }
  if (variantByte && payload.length > 1 && payload[1] !== 0 && payload[1] !== 1) {
    return `${name}: bad variant ${payload[1]}`;
  }
  return `${name}: truncated payload or trailing bytes`;
}

// The canonical decoder skips the two kernel sigs (the dapp's value-binding uses the sigma + Groth16,
// so it never needs them). They sit at a fixed offset, and these tests round-trip them, so surface them.
const _LP_ADD_KERNEL_SIG_A_OFF = 2 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + XCURVE_PROOF_LEN;

export function decodeLpAdd(payload) {
  const d = _decodeLpAdd(payload);
  if (!d) throw new Error(_rejectReason(payload, OPCODE_T_LP_ADD, 'T_LP_ADD', { variantByte: true }));
  const a = _LP_ADD_KERNEL_SIG_A_OFF;
  return {
    ...d,
    kernelSigA: payload.slice(a, a + 64),
    kernelSigB: payload.slice(a + 64, a + 128),
  };
}
export function decodeLpRemove(payload) {
  const d = _decodeLpRemove(payload);
  if (!d) throw new Error(_rejectReason(payload, OPCODE_T_LP_REMOVE, 'T_LP_REMOVE'));
  return d;
}
export function decodeProtocolFeeClaim(payload) {
  const d = _decodeProtocolFeeClaim(payload);
  if (!d) {
    // The canonical decoder length-checks before anything else; distinguish that from a bad opcode
    // and from a zero claim so the negative tests can tell the three apart.
    if (payload instanceof Uint8Array && payload.length !== ENVELOPE_PROTOCOL_FEE_CLAIM_BYTES) {
      throw new Error(`T_PROTOCOL_FEE_CLAIM: expected ${ENVELOPE_PROTOCOL_FEE_CLAIM_BYTES} bytes, got ${payload.length}`);
    }
    throw new Error(_rejectReason(payload, OPCODE_T_PROTOCOL_FEE_CLAIM, 'T_PROTOCOL_FEE_CLAIM'));
  }
  if (d.claimAmount === 0n) throw new Error('T_PROTOCOL_FEE_CLAIM: claim_amount must be > 0');
  // Legacy spelling kept alongside the canonical one so older assertions still read.
  return { ...d, claimerPubkeyXOnly: d.claimerXOnly };
}

const _ZERO32 = new Uint8Array(32);

export function encodeLpAdd(args) {
  return _encodeLpAdd({
    shareR: _ZERO32,
    ...TEST_LP_ADD_REFUND_TAIL,
    ...args,
  });
}

export function encodeLpRemove(args) {
  return _encodeLpRemove({ rRecvA: _ZERO32, rRecvB: _ZERO32, ...args });
}

export function encodeProtocolFeeClaim(args) {
  // The canonical encoder spells the claimer field `claimerXOnly`.
  const { claimerPubkeyXOnly, ...rest } = args;
  return _encodeProtocolFeeClaim({
    ...(claimerPubkeyXOnly !== undefined ? { claimerXOnly: claimerPubkeyXOnly } : {}),
    ...rest,
  });
}


// =========================================================================
// T_SWAP_BATCH (0x2F)
// =========================================================================

// Per-intent block:
//   direction(1) || trader_pubkey(33) || C_in_secp(33) || C_in_BJJ(32)
//   || in_xcurve_sigma(169) || min_out_LE(8) || tip_amount_LE(8)
//   || expiry_height_LE(4) || intent_sig(64)
// = 1 + 33 + 33 + 32 + 169 + 8 + 8 + 4 + 64 = 352 bytes per intent
//
// Per-receipt block:
//   C_out_secp(33) || C_out_BJJ(32) || out_xcurve_sigma(169)
// = 234 bytes per receipt

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

// Fixed size of a T_PROTOCOL_FEE_CLAIM payload: opcode(1) ‖ pool_id(32) ‖ claimer_x_only(32)
// ‖ claim_amount_LE(8) ‖ claim_C_secp(33) ‖ claim_blinding(32) ‖ claim_sig(64).
export const ENVELOPE_PROTOCOL_FEE_CLAIM_BYTES = 1 + 32 + 32 + 8 + 33 + 32 + 64;
