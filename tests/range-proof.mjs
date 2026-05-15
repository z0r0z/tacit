// Tacit range-proof primitive.
//
// Composable predicates over Pedersen-committed u64 amounts. Reuses tacit's
// existing 64-bit aggregate-bulletproof producer/verifier (`bpRangeAggProve`
// / `bpRangeAggVerify` in `bulletproofs.mjs`). Scope-generic: usable by
// AMM `min_out` slippage proofs, future cUSD CDP collateral-ratio
// attestations, permissioned-pool LP gates, sealed-bid auctions, tiered
// fees, and any other tacit surface that needs "this hidden amount
// satisfies a public predicate."
//
// Supported predicates:
//
//   PRED_GE:        a ≥ X            (one-sided lower bound, X public)
//   PRED_LE:        a ≤ X            (one-sided upper bound, X public)
//   PRED_IN_RANGE:  a ∈ [X, Y]       (closed range, X and Y public)
//   PRED_GT_HIDDEN: a > b            (hidden vs hidden — b's commitment public)
//   PRED_EQ:        a = X            (equality, via blinding-reveal; X public)
//
// Equality (`PRED_EQ`) is the only one that does NOT use a bulletproof: it
// reveals the blinding `r`, and the verifier checks `C == X·H + r·G`
// directly. This reveals `a` to the verifier (since they already know X)
// but cryptographically certifies the equality.
//
// All four bulletproof-based predicates reduce to a single
// `bpRangeAggProve` call on a shifted commitment, leveraging Pedersen
// homomorphism:
//
//   `a ≥ X`         ⇔ `(a − X) ∈ [0, 2^64)` against `C − X·H`
//   `a ≤ X`         ⇔ `(X − a) ∈ [0, 2^64)` against `X·H − C`
//   `a ∈ [X, Y]`    ⇔ both of the above (aggregated 2-element bulletproof)
//   `a > b`         ⇔ `(a − b − 1) ∈ [0, 2^64)` against `C_a − C_b − H`
//
// The verifier computes the shifted commitment(s) deterministically from
// public components (commitments, X, Y) and feeds them to
// `bpRangeAggVerify`. No new cryptographic assumption beyond the existing
// 64-bit bulletproof.
//
// Wire format for an attestation object:
//
//   predicate_type(1)
//   predicate_params(*)   — type-dependent (8 B for X, 8 B for Y, 33 B for
//                           target commitment, or 32 B for blinding-reveal)
//   proof_len_LE(2) + proof_bytes(*)
//
// Cost: ~700 B per single-predicate proof, ~750 B aggregated for IN_RANGE.
// EQ is trivial (no bulletproof, just the 32-byte blinding).

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, bytesToPoint,
  bigintToBytes32, bytes32ToBigint,
  bpRangeAggProve, bpRangeAggVerify,
} from './bulletproofs.mjs';

// =========================================================================
// Predicate type discriminators (wire-format byte 0)
// =========================================================================

export const PRED_GE        = 0x00;   // a ≥ X
export const PRED_LE        = 0x01;   // a ≤ X
export const PRED_IN_RANGE  = 0x02;   // a ∈ [X, Y]
export const PRED_GT_HIDDEN = 0x03;   // a > b (b's commitment public)
export const PRED_EQ        = 0x04;   // a = X (via blinding-reveal)

const N_BITS = 64n;
const TWO_64 = 1n << N_BITS;

// =========================================================================
// Internal helpers
// =========================================================================

function u64LE(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= TWO_64) throw new Error(`u64 out of range: ${x}`);
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function readU64LE(b, o = 0) {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]);
  return x;
}
function u16LE(n) {
  const b = new Uint8Array(2);
  b[0] = n & 0xff; b[1] = (n >> 8) & 0xff;
  return b;
}
function readU16LE(b, o = 0) {
  return b[o] | (b[o + 1] << 8);
}
function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}

// Subtract two secp256k1 points: P - Q.
function ptSub(P, Q) { return P.add(Q.negate()); }

// =========================================================================
// Prover API
// =========================================================================

// proveRange({ value, blinding, otherValue?, otherBlinding? }, predicate)
//
// Inputs:
//   value      : bigint, the hidden amount `a` (must satisfy 0 ≤ a < 2^64)
//   blinding   : bigint, the Pedersen blinding `r` for `a`'s commitment
//   otherValue / otherBlinding : present iff predicate is PRED_GT_HIDDEN —
//                the b-side opening
//   predicate  : { type, X?, Y? } — public predicate parameters
//
// Returns: serialized attestation bytes (predicate type tag + params + proof).
export function proveRange({ value, blinding, otherValue, otherBlinding }, predicate) {
  const a = BigInt(value);
  const r = modN(BigInt(blinding));
  if (a < 0n || a >= TWO_64) {
    throw new Error(`value must satisfy 0 ≤ a < 2^64 (got ${a})`);
  }

  switch (predicate.type) {
    case 'ge': {
      const X = BigInt(predicate.X);
      assertU64(X, 'X');
      if (a < X) throw new Error(`cannot prove a ≥ X: a=${a} < X=${X}`);
      const { proof } = bpRangeAggProve([a - X], [r]);
      return concatBytes(new Uint8Array([PRED_GE]), u64LE(X), u16LE(proof.length), proof);
    }
    case 'le': {
      const X = BigInt(predicate.X);
      assertU64(X, 'X');
      if (a > X) throw new Error(`cannot prove a ≤ X: a=${a} > X=${X}`);
      const { proof } = bpRangeAggProve([X - a], [modN(-r)]);
      return concatBytes(new Uint8Array([PRED_LE]), u64LE(X), u16LE(proof.length), proof);
    }
    case 'in_range': {
      const X = BigInt(predicate.X);
      const Y = BigInt(predicate.Y);
      assertU64(X, 'X');
      assertU64(Y, 'Y');
      if (X > Y) throw new Error(`in_range requires X ≤ Y (got X=${X}, Y=${Y})`);
      if (a < X || a > Y) throw new Error(`cannot prove a ∈ [X,Y]: a=${a} not in [${X},${Y}]`);
      // Aggregated 2-element proof: (a − X) AND (Y − a) both in [0, 2^64).
      const { proof } = bpRangeAggProve([a - X, Y - a], [r, modN(-r)]);
      return concatBytes(
        new Uint8Array([PRED_IN_RANGE]),
        u64LE(X), u64LE(Y),
        u16LE(proof.length), proof,
      );
    }
    case 'gt_hidden': {
      if (otherValue === undefined || otherBlinding === undefined) {
        throw new Error('gt_hidden requires otherValue + otherBlinding');
      }
      const b = BigInt(otherValue);
      const r_b = modN(BigInt(otherBlinding));
      if (b < 0n || b >= TWO_64) throw new Error(`otherValue out of u64`);
      if (a <= b) throw new Error(`cannot prove a > b: a=${a} ≤ b=${b}`);
      const C_b_pt = pedersenCommit(b, r_b);
      const C_b_bytes = pointToBytes(C_b_pt);
      const { proof } = bpRangeAggProve([a - b - 1n], [modN(r - r_b)]);
      return concatBytes(
        new Uint8Array([PRED_GT_HIDDEN]),
        C_b_bytes,
        u16LE(proof.length), proof,
      );
    }
    case 'eq': {
      const X = BigInt(predicate.X);
      assertU64(X, 'X');
      if (a !== X) throw new Error(`cannot prove a = X: a=${a}, X=${X}`);
      // No bulletproof — equality via blinding reveal.
      // Verifier checks C == X·H + r·G.
      return concatBytes(
        new Uint8Array([PRED_EQ]),
        u64LE(X),
        bigintToBytes32(r),
      );
    }
    default:
      throw new Error(`unknown predicate type: ${predicate.type}`);
  }
}

function assertU64(x, name) {
  if (typeof x !== 'bigint') x = BigInt(x);
  if (x < 0n || x >= TWO_64) throw new Error(`${name} must satisfy 0 ≤ ${name} < 2^64 (got ${x})`);
}

// =========================================================================
// Verifier API
// =========================================================================

// verifyRange(commitmentA, attestationBytes, opts?)
//
// Inputs:
//   commitmentA      : 33-byte compressed secp256k1 Pedersen commitment to `a`
//   attestationBytes : output of proveRange()
//   opts.commitmentB : optional 33-byte commitment (required for PRED_GT_HIDDEN)
//
// Returns: { ok: bool, predicate?: {...}, reason?: string }.
//
// The predicate's public parameters are extracted from the attestation
// bytes and returned so callers can sanity-check against their expected
// values. The verifier does NOT trust the attestation's claimed
// predicate — callers MUST match `result.predicate` to their expected
// shape before accepting.
export function verifyRange(commitmentA, attestationBytes, opts = {}) {
  if (!(attestationBytes instanceof Uint8Array) || attestationBytes.length < 1) {
    return { ok: false, reason: 'invalid attestation bytes' };
  }
  const Cb = asBytes(commitmentA, 33, 'commitmentA');
  let C_a;
  try { C_a = bytesToPoint(Cb); }
  catch (e) { return { ok: false, reason: `commitmentA decode: ${e.message}` }; }

  const tag = attestationBytes[0];
  let off = 1;
  try {
    switch (tag) {
      case PRED_GE: {
        if (off + 8 + 2 > attestationBytes.length) return { ok: false, reason: 'truncated PRED_GE' };
        const X = readU64LE(attestationBytes, off); off += 8;
        const proofLen = readU16LE(attestationBytes, off); off += 2;
        if (off + proofLen !== attestationBytes.length) return { ok: false, reason: 'PRED_GE proof_len mismatch' };
        const proof = attestationBytes.slice(off, off + proofLen);
        // Shifted commitment: C_a − X·H.
        const shifted = X === 0n ? C_a : ptSub(C_a, H.multiply(X));
        if (!bpRangeAggVerify([shifted], proof)) {
          return { ok: false, reason: 'PRED_GE bulletproof verify failed' };
        }
        return { ok: true, predicate: { type: 'ge', X } };
      }
      case PRED_LE: {
        if (off + 8 + 2 > attestationBytes.length) return { ok: false, reason: 'truncated PRED_LE' };
        const X = readU64LE(attestationBytes, off); off += 8;
        const proofLen = readU16LE(attestationBytes, off); off += 2;
        if (off + proofLen !== attestationBytes.length) return { ok: false, reason: 'PRED_LE proof_len mismatch' };
        const proof = attestationBytes.slice(off, off + proofLen);
        // Shifted commitment: X·H − C_a.
        const xH = X === 0n ? ZERO : H.multiply(X);
        const shifted = xH.add(C_a.negate());
        if (!bpRangeAggVerify([shifted], proof)) {
          return { ok: false, reason: 'PRED_LE bulletproof verify failed' };
        }
        return { ok: true, predicate: { type: 'le', X } };
      }
      case PRED_IN_RANGE: {
        if (off + 16 + 2 > attestationBytes.length) return { ok: false, reason: 'truncated PRED_IN_RANGE' };
        const X = readU64LE(attestationBytes, off); off += 8;
        const Y = readU64LE(attestationBytes, off); off += 8;
        if (X > Y) return { ok: false, reason: 'PRED_IN_RANGE: X > Y not allowed' };
        const proofLen = readU16LE(attestationBytes, off); off += 2;
        if (off + proofLen !== attestationBytes.length) return { ok: false, reason: 'PRED_IN_RANGE proof_len mismatch' };
        const proof = attestationBytes.slice(off, off + proofLen);
        const shifted_lo = X === 0n ? C_a : ptSub(C_a, H.multiply(X));
        const yH = Y === 0n ? ZERO : H.multiply(Y);
        const shifted_hi = yH.add(C_a.negate());
        if (!bpRangeAggVerify([shifted_lo, shifted_hi], proof)) {
          return { ok: false, reason: 'PRED_IN_RANGE aggregated bulletproof verify failed' };
        }
        return { ok: true, predicate: { type: 'in_range', X, Y } };
      }
      case PRED_GT_HIDDEN: {
        if (off + 33 + 2 > attestationBytes.length) return { ok: false, reason: 'truncated PRED_GT_HIDDEN' };
        const Cb_b = attestationBytes.slice(off, off + 33); off += 33;
        // Caller MUST supply the matching commitment via opts.commitmentB —
        // we compare bytes to detect mismatched contexts.
        if (!opts.commitmentB) return { ok: false, reason: 'PRED_GT_HIDDEN requires opts.commitmentB' };
        const optsB = asBytes(opts.commitmentB, 33, 'commitmentB');
        if (Cb_b.length !== optsB.length || !Cb_b.every((b, i) => b === optsB[i])) {
          return { ok: false, reason: 'attestation\'s declared C_b != opts.commitmentB' };
        }
        const proofLen = readU16LE(attestationBytes, off); off += 2;
        if (off + proofLen !== attestationBytes.length) return { ok: false, reason: 'PRED_GT_HIDDEN proof_len mismatch' };
        const proof = attestationBytes.slice(off, off + proofLen);
        const C_b_pt = bytesToPoint(Cb_b);
        // Shifted commitment: C_a − C_b − 1·H.
        const shifted = C_a.add(C_b_pt.negate()).add(H.negate());
        if (!bpRangeAggVerify([shifted], proof)) {
          return { ok: false, reason: 'PRED_GT_HIDDEN bulletproof verify failed' };
        }
        return { ok: true, predicate: { type: 'gt_hidden' } };
      }
      case PRED_EQ: {
        if (off + 8 + 32 !== attestationBytes.length) return { ok: false, reason: 'PRED_EQ length mismatch' };
        const X = readU64LE(attestationBytes, off); off += 8;
        const rRevealed = bytes32ToBigint(attestationBytes.slice(off, off + 32));
        const expected = pedersenCommit(X, modN(rRevealed));
        if (!C_a.equals(expected)) {
          return { ok: false, reason: 'PRED_EQ: C does not open to (X, r)' };
        }
        return { ok: true, predicate: { type: 'eq', X } };
      }
      default:
        return { ok: false, reason: `unknown predicate tag 0x${tag.toString(16)}` };
    }
  } catch (e) {
    return { ok: false, reason: `verifyRange threw: ${e.message}` };
  }
}

// =========================================================================
// Convenience: aggregate over multiple UTXOs
// =========================================================================
//
// To prove a predicate over the SUM of N hidden amounts, the caller takes
// the sum of values and blindings:
//
//   sum_value    = Σ a_i
//   sum_blinding = Σ r_i  (mod n)
//   sum_C        = Σ C_i  (computed publicly by verifier)
//
// Then call proveRange({ value: sum_value, blinding: sum_blinding }, predicate)
// and on the verifier side call verifyRange(sum_C_bytes, attestation).
//
// This works because Pedersen commitments are additively homomorphic:
//   Σ (a_i·H + r_i·G) = (Σ a_i)·H + (Σ r_i)·G.
//
// Helper: aggregate a list of (value, blinding) pairs and produce the
// summed pair, with overflow guarded.
export function aggregateCommitments(pairs) {
  let sumV = 0n, sumR = 0n;
  for (const { value, blinding } of pairs) {
    sumV += BigInt(value);
    sumR += BigInt(blinding);
  }
  if (sumV >= TWO_64) {
    throw new Error(`aggregate value ≥ 2^64 — overflow; cannot prove under 64-bit bulletproofs`);
  }
  return { value: sumV, blinding: modN(sumR) };
}

// Helper: sum a list of compressed-secp commitment bytes into one point.
export function sumCommitmentBytes(commitmentBytesList) {
  let acc = ZERO;
  for (const c of commitmentBytesList) {
    acc = acc.add(bytesToPoint(asBytes(c, 33, 'commitment')));
  }
  return pointToBytes(acc);
}
