// T_RANGE_ATTEST (opcode 0x44) — standalone on-chain anchored range
// attestations.
//
// Formalizes the range-proof primitive (range-proof.mjs) as a first-class
// protocol opcode: a holder publishes a signed envelope on chain claiming
// that one or more existing UTXO commitments satisfy a public predicate
// (≥ X, ≤ X, ∈ [X, Y], > b, = X). The indexer validates and records the
// attestation, making it queryable by holder, by scope_id, or by
// commitment outpoint. Consumers (cUSD CDP authorizations, permissioned
// LP gates, tiered-fee discounts, sealed-bid auction commitments) can
// reference attestations by their on-chain id.
//
// This opcode is **purely additive** — no existing tacit asset or order
// is affected by its introduction. Pre-amendment indexers (and any
// existing UTXO) see no change.
//
// Wire format:
//
//   opcode(1)                  = 0x44
//   scope_id(32)               — opaque scope discriminator (e.g., pool_id,
//                                claim_id, or SHA256(domain || context));
//                                indexer treats as bytes only
//   expiry_height_LE(4)        — u32, attestation expires after this height
//   commitment_count(1)        — u8, 1..16 UTXO commitments being attested
//   commitment_outpoints(36 * count) — [txid_BE(32) || vout_LE(4)] each;
//                                identifies on-chain UTXOs whose
//                                commitments are the inputs to the
//                                range-proof attestation
//   attestation_len_LE(2) + attestation_bytes(*) — output of
//                                `proveRange()` from range-proof.mjs
//   holder_pubkey(33)          — compressed secp256k1 of the attester
//   holder_sig(64)             — BIP-340 over SHA256("tacit-range-attest-v1"
//                                || all preceding fields)
//
// Indexer behaviour (extends SPEC.md §5):
//
//   1. Decode envelope. Reject on structural error.
//   2. Verify holder_sig against the preceding bytes.
//   3. Reject if `expiry_height < envelope_height` (already expired).
//   4. Resolve each commitment_outpoint to its on-chain Pedersen
//      commitment from current UTXO state. Reject if any outpoint is
//      not a confirmed UTXO at envelope_height − AMM_OP_CONFIRMATION_DEPTH
//      or earlier.
//   5. For multi-commitment attestations (count > 1), sum the resolved
//      commitments to get the aggregate C_sum.
//   6. For PRED_GT_HIDDEN: the attestation_bytes already embed C_b
//      inline (per range-proof.mjs); the validator extracts it and uses
//      it as the second commitment in verifyRange.
//   7. Call verifyRange(C_sum, attestation_bytes, { commitmentB? })
//      against the resolved commitments. Reject on verify failure.
//   8. Record (attestation_id = SHA256(envelope), holder_pubkey,
//      scope_id, expiry_height, predicate, commitment_set) in the
//      indexer's attestation registry.
//
// Spam: attestation envelopes pay Bitcoin tx fees like any other
// envelope, so spam is bounded by tx-fee economics. No rate limiting
// in protocol.
//
// Revocation: an attestation references specific commitment_outpoints.
// If any of those outpoints is spent, the attestation becomes stale
// (the commitments referenced no longer exist as UTXOs). Consumers
// SHOULD check "are the referenced outpoints still UTXOs at consumer-
// op time?" before relying on an attestation. The indexer MAY mark
// attestations as stale automatically when their commitments are
// spent.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import { signSchnorr, verifySchnorr } from './composition.mjs';
import {
  pedersenCommit, pointToBytes, bytesToPoint, ZERO,
} from './bulletproofs.mjs';
import { verifyRange, PRED_GE, PRED_LE, PRED_IN_RANGE, PRED_GT_HIDDEN, PRED_EQ } from './range-proof.mjs';

export const OPCODE_T_RANGE_ATTEST = 0x44;
const RANGE_ATTEST_DOMAIN = new TextEncoder().encode('tacit-range-attest-v1');

// =========================================================================
// Encoder helpers
// =========================================================================

function u16LE(n) { const b = new Uint8Array(2); b[0] = n & 0xff; b[1] = (n >> 8) & 0xff; return b; }
function u32LE(n) { const b = new Uint8Array(4); for (let i = 0; i < 4; i++) { b[i] = (n >>> (8*i)) & 0xff; } return b; }
function readU16LE(b, o) { return b[o] | (b[o+1] << 8); }
function readU32LE(b, o) { return ((b[o] | (b[o+1] << 8) | (b[o+2] << 16)) >>> 0) + (b[o+3] * 0x1000000); }
function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}

// Outpoint encoding: txid_BE(32) || vout_LE(4) = 36 bytes.
function encodeOutpoint(op) {
  const txidBytes = typeof op.txid === 'string' ? hexToBytes(op.txid) : op.txid;
  if (txidBytes.length !== 32) throw new Error('txid must be 32 bytes');
  return concatBytes(txidBytes, u32LE(op.vout >>> 0));
}
function decodeOutpoint(buf, off) {
  return {
    txid: bytesToHex(buf.slice(off, off + 32)),
    vout: readU32LE(buf, off + 32),
  };
}

// =========================================================================
// Encoder / decoder
// =========================================================================

// encodeRangeAttest({ scopeId, expiryHeight, commitmentOutpoints, attestationBytes, holderPubkey, holderPrivkey? OR holderSig? })
export function encodeRangeAttest(args) {
  const sid = asBytes(args.scopeId, 32, 'scopeId');
  const expiryHeight = args.expiryHeight >>> 0;
  const outpoints = args.commitmentOutpoints;
  if (!Array.isArray(outpoints) || outpoints.length < 1 || outpoints.length > 16) {
    throw new Error('commitmentOutpoints must be Array of length 1..16');
  }
  const att = args.attestationBytes;
  if (!(att instanceof Uint8Array) || att.length < 1 || att.length > 0xffff) {
    throw new Error('attestationBytes must be Uint8Array of length 1..65535');
  }
  let holderPubkey;
  if (args.holderPubkey) holderPubkey = asBytes(args.holderPubkey, 33, 'holderPubkey');
  else if (args.holderPrivkey) holderPubkey = secp.ProjectivePoint.fromPrivateKey(args.holderPrivkey).toRawBytes(true);
  else throw new Error('holderPubkey or holderPrivkey required');

  const parts = [
    new Uint8Array([OPCODE_T_RANGE_ATTEST]),
    sid,
    u32LE(expiryHeight),
    new Uint8Array([outpoints.length]),
  ];
  for (const op of outpoints) parts.push(encodeOutpoint(op));
  parts.push(u16LE(att.length), att);
  parts.push(holderPubkey);

  const preSig = concatBytes(...parts);

  let holderSig;
  if (args.holderSig) {
    holderSig = asBytes(args.holderSig, 64, 'holderSig');
  } else if (args.holderPrivkey) {
    const msgHash = sha256(concatBytes(RANGE_ATTEST_DOMAIN, preSig));
    holderSig = signSchnorr(msgHash, args.holderPrivkey);
  } else {
    throw new Error('holderSig or holderPrivkey required');
  }
  return concatBytes(preSig, holderSig);
}

export function decodeRangeAttest(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  if (payload.length < 1 + 32 + 4 + 1 + 0 + 2 + 33 + 64) throw new Error('truncated');
  let off = 0;
  if (payload[off++] !== OPCODE_T_RANGE_ATTEST) {
    throw new Error(`expected opcode 0x${OPCODE_T_RANGE_ATTEST.toString(16)}`);
  }
  const scopeId = payload.slice(off, off + 32); off += 32;
  const expiryHeight = readU32LE(payload, off); off += 4;
  const count = payload[off++];
  if (count < 1 || count > 16) throw new Error(`commitment_count out of range: ${count}`);
  if (off + count * 36 + 2 + 33 + 64 > payload.length) throw new Error('truncated: outpoints/attestation');
  const commitmentOutpoints = [];
  for (let i = 0; i < count; i++) {
    commitmentOutpoints.push(decodeOutpoint(payload, off));
    off += 36;
  }
  const attLen = readU16LE(payload, off); off += 2;
  if (off + attLen + 33 + 64 !== payload.length) {
    throw new Error('attestation_len mismatch or trailing bytes');
  }
  const attestationBytes = payload.slice(off, off + attLen); off += attLen;
  const holderPubkey = payload.slice(off, off + 33); off += 33;
  const holderSig = payload.slice(off, off + 64); off += 64;
  if (off !== payload.length) throw new Error('trailing bytes after sig');

  return {
    scopeId, expiryHeight, commitmentOutpoints,
    attestationBytes, holderPubkey, holderSig,
  };
}

// =========================================================================
// Sig verification
// =========================================================================

export function verifyRangeAttestSig(decoded) {
  // Reconstruct the pre-sig bytes EXACTLY as the encoder produced them.
  const parts = [
    new Uint8Array([OPCODE_T_RANGE_ATTEST]),
    asBytes(decoded.scopeId, 32, 'scopeId'),
    u32LE(decoded.expiryHeight),
    new Uint8Array([decoded.commitmentOutpoints.length]),
  ];
  for (const op of decoded.commitmentOutpoints) parts.push(encodeOutpoint(op));
  parts.push(u16LE(decoded.attestationBytes.length), decoded.attestationBytes);
  parts.push(asBytes(decoded.holderPubkey, 33, 'holderPubkey'));
  const preSig = concatBytes(...parts);
  const msgHash = sha256(concatBytes(RANGE_ATTEST_DOMAIN, preSig));
  const xOnly = decoded.holderPubkey.subarray(1);
  return verifySchnorr(decoded.holderSig, msgHash, xOnly);
}

// =========================================================================
// Validator — full envelope check
// =========================================================================
//
// Inputs:
//   payload          : envelope bytes
//   envelopeHeight   : block height the envelope confirms at
//   commitmentResolver : function ({ txid, vout }) -> {
//                           commitment: Uint8Array(33),  // 33-byte secp Pedersen
//                           assetId: Uint8Array(32),
//                           amount: bigint OR null (if unknown),
//                       } OR null if outpoint is not a confirmed UTXO.
//                       Indexers supply this; the validator does not maintain
//                       UTXO state.
//
// Returns: { valid: bool, reason?: string, decoded?, attestationId?: Uint8Array(32) }
export function validateRangeAttest({ payload, envelopeHeight, commitmentResolver }) {
  let env;
  try { env = decodeRangeAttest(payload); }
  catch (e) { return { valid: false, reason: `decode: ${e.message}` }; }

  if (!verifyRangeAttestSig(env)) {
    return { valid: false, reason: 'holder_sig verification failed' };
  }

  if (env.expiryHeight < envelopeHeight) {
    return {
      valid: false,
      reason: `attestation expired (expiry=${env.expiryHeight} < envelopeHeight=${envelopeHeight})`,
    };
  }

  if (typeof commitmentResolver !== 'function') {
    return { valid: false, reason: 'commitmentResolver required' };
  }

  // Resolve outpoints to commitments.
  const resolved = [];
  for (let i = 0; i < env.commitmentOutpoints.length; i++) {
    const op = env.commitmentOutpoints[i];
    let r;
    try { r = commitmentResolver(op); }
    catch (e) { return { valid: false, reason: `commitmentResolver threw on outpoint[${i}]: ${e.message}` }; }
    if (!r || !r.commitment) {
      return { valid: false, reason: `outpoint[${i}] not a confirmed UTXO: ${op.txid}:${op.vout}` };
    }
    resolved.push(r);
  }

  // Aggregate: if multi-commitment, sum into a single sum_commitment point.
  // PRED_GT_HIDDEN is the only predicate where C_b lives separately in
  // attestation_bytes; for it, the outpoints MUST resolve to exactly the
  // C_a side. Caller's responsibility to construct correctly.
  let primaryCommitmentBytes;
  if (resolved.length === 1) {
    primaryCommitmentBytes = resolved[0].commitment;
  } else {
    let acc = ZERO;
    for (const r of resolved) acc = acc.add(bytesToPoint(r.commitment));
    primaryCommitmentBytes = pointToBytes(acc);
  }

  // For PRED_GT_HIDDEN, extract C_b from attestation_bytes per
  // range-proof.mjs wire format (tag byte 0x03 followed by 33-byte C_b).
  const predTag = env.attestationBytes[0];
  let opts = {};
  if (predTag === PRED_GT_HIDDEN) {
    if (env.attestationBytes.length < 1 + 33) {
      return { valid: false, reason: 'PRED_GT_HIDDEN attestation truncated' };
    }
    opts.commitmentB = env.attestationBytes.slice(1, 1 + 33);
  }

  const verifyResult = verifyRange(primaryCommitmentBytes, env.attestationBytes, opts);
  if (!verifyResult.ok) {
    return { valid: false, reason: `range-proof verify failed: ${verifyResult.reason}` };
  }

  const attestationId = sha256(payload);
  return {
    valid: true,
    decoded: env,
    attestationId,
    predicate: verifyResult.predicate,
    primaryCommitment: primaryCommitmentBytes,
  };
}
