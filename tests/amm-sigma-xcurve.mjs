// Camenisch-Stadler-style sigma protocol binding a secp256k1 Pedersen commitment
// to a BabyJubJub Pedersen commitment under the SAME hidden amount `a`.
//
// Per AMM.md §"Hybrid commitments (secp256k1 + BabyJubJub)" — proves knowledge of
//   (a, r_secp, r_BJJ) such that
//     C_in_secp = a·H_secp + r_secp·G_secp  (on secp256k1)
//     C_in_BJJ  = a·H_BJJ  + r_BJJ ·G_BJJ   (on BabyJubJub)
//   with a < 2^64 (range-bounded externally by tacit's 64-bit bulletproof).
//
// Wire format (169 bytes total):
//     A_secp (33)  || A_BJJ (32) || z_a (40) || z_r_secp (32) || z_r_BJJ (32)
//
// Parameters (AMM.md §3.10):
//     e < 2^128  (challenge — last 16 bytes of SHA256 transcript)
//     α < 2^320 - 2^192   (mask — rejection-sampled so z_a < 2^320 fits in 40 bytes)
//     z_a = α + e·a       (over the integers)
//     z_r_secp = β_secp + e·r_secp   (mod n_secp)
//     z_r_BJJ  = β_BJJ  + e·r_BJJ    (mod n_BJJ)
//
// Soundness: 128-bit (Fiat-Shamir extractor with challenge space 2^128).
// Statistical ZK: ≈ 128-bit margin on `a` (M/B ≈ 2^128 distinguishing bound).
//
// The same integer `z_a` is sent on the wire and used in both verification
// equations; each curve's scalar multiplication reduces it modulo its own
// group order internally. Binding holds because the wire-integer is shared
// (an adversary who wanted to satisfy both equations with different `a`
// values would have to solve a CRT problem at >2^128 work given `e < 2^128`).

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';

import {
  G as G_SECP, H as H_SECP, SECP_N, modN as modSecp, ZERO as SECP_ZERO,
  pedersenCommit, pointToBytes, bigintToBytes32, bytes32ToBigint,
} from './bulletproofs.mjs';

import {
  N_BJJ, mod as modField, P_FR,
  addPoint, mulScalar, isIdentity, eq as bjjEq,
  packPoint, unpackPoint,
  H_BJJ, G_BJJ, pedersenBJJ,
} from './amm-bjj.mjs';

const DOMAIN = new TextEncoder().encode('tacit-amm-xcurve-v1');

const TWO_128 = 1n << 128n;
const TWO_192 = 1n << 192n;
const TWO_320 = 1n << 320n;
const ALPHA_MAX = TWO_320 - TWO_192; // α uniform in [0, 2^320 - 2^192)

// Wire-format constants exported for cross-impl conformance pinning.
export const XCURVE_PROOF_LEN = 169;
export const Z_A_BYTES = 40;
export const CHALLENGE_BYTES = 16;

function modN_BJJ(x) { return ((x % N_BJJ) + N_BJJ) % N_BJJ; }

// ---- scalar / byte helpers ----
function bytesToBigintBE(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}
function bigintToBytesBE(n, len) {
  const out = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  if (x !== 0n) throw new Error(`bigintToBytesBE: ${n} overflows ${len} bytes`);
  return out;
}

// Uniform random sample in [0, ALPHA_MAX) by rejection from 40 random bytes
// (320-bit α; ALPHA_MAX = 2^320 - 2^192 keeps z_a = α + e·a < 2^320).
function sampleAlpha(rng = defaultRng) {
  while (true) {
    const buf = rng(40);
    const n = bytesToBigintBE(buf);
    if (n < ALPHA_MAX) return n;
  }
}
function sampleScalarMod(n_mod, byteLen, rng = defaultRng) {
  while (true) {
    const buf = rng(byteLen);
    const x = bytesToBigintBE(buf);
    if (x < n_mod) return x;
  }
}
function defaultRng(len) {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

// Build a deterministic RNG from a per-statement seed key + the public
// statement (commitments). Used by `proveXCurveDeterministic` to produce
// reproducible (α, β_secp, β_BJJ) without leaking the witness through
// RNG side-channels.
//
// Construction: counter-mode HMAC-SHA256 — for output i, emit
//   block_i = HMAC-SHA256(seedKey, "tacit-amm-xcurve-prng-v1" || statement || u32_BE(i))
// concatenated until `len` bytes are produced. Equivalent to RFC 6979
// in spirit (deterministic, witness-derivable nonce) but tailored to
// the cross-curve sigma's (α, β_secp, β_BJJ) sampling pattern.
//
// `seedKey` SHOULD be a high-entropy secret derived from the trader's
// long-term key, NOT the witness scalars themselves. Common pattern:
//   seedKey = HMAC-SHA256(trader_priv, "tacit-amm-xcurve-seed-v1")
// Closes the "RNG bug exposes discrete logs" tail risk for production
// indexers / signers that need deterministic nonces.
function makeDeterministicRng(seedKey, statement) {
  if (!(seedKey instanceof Uint8Array) || seedKey.length < 16) {
    throw new Error('makeDeterministicRng: seedKey must be a Uint8Array of ≥ 16 bytes');
  }
  if (!(statement instanceof Uint8Array)) {
    throw new Error('makeDeterministicRng: statement must be a Uint8Array');
  }
  const TAG = new TextEncoder().encode('tacit-amm-xcurve-prng-v1');
  let counter = 0;
  return function detRng(len) {
    const out = new Uint8Array(len);
    let filled = 0;
    while (filled < len) {
      const ctr = new Uint8Array(4);
      new DataView(ctr.buffer).setUint32(0, counter++, false); // big-endian
      const msg = concatBytes(TAG, statement, ctr);
      const block = hmacSha256(seedKey, msg);
      const take = Math.min(32, len - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
}

// HMAC-SHA256 via @noble/hashes (already imported indirectly via sha256;
// add explicit import).
import { hmac } from '@noble/hashes/hmac';
function hmacSha256(key, msg) {
  return hmac(sha256, key, msg);
}

// Compute the Fiat-Shamir challenge e < 2^128 from the public transcript.
//   e = bytes_be_to_int( SHA256(domain || C_secp || C_BJJ || A_secp || A_BJJ) )[-16:]
// We take the LOW 16 bytes of the digest (i.e., `digest mod 2^128` when the
// digest is read big-endian as an integer).
export function challenge(C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes) {
  const h = sha256(concatBytes(DOMAIN, C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes));
  return bytesToBigintBE(h.subarray(32 - CHALLENGE_BYTES, 32)); // last 16 bytes = 128 bits
}

// ---- prover ----
//
// Inputs:
//   a        : bigint, the hidden amount (must satisfy 0 ≤ a < 2^64)
//   r_secp   : bigint, the secp blinding (in Z_{n_secp})
//   r_BJJ    : bigint, the BJJ blinding (in Z_{n_BJJ})
//   C_secp   : optional precomputed Pedersen-secp commitment (ProjectivePoint)
//   C_BJJ    : optional precomputed Pedersen-BJJ commitment ([u, v])
//   rng      : optional rng for testing determinism
//
// Returns:
//   { proof: Uint8Array(169), C_secp_bytes, C_BJJ_bytes }
//
// Production callers MUST use `proveXCurveDeterministic` (below) instead of
// the default platform-RNG path. The default path is gated by NODE_ENV: it
// throws when `NODE_ENV === 'production'` AND no explicit `rng` was passed,
// mirroring the SKIP_GROTH16_VERIFY_UNSAFE production refusal pattern in
// the validator. Callers who explicitly pass an `rng` (e.g., a deterministic
// test stream) bypass this gate. See the RNG-leak rationale above.
let _proveXCurveRngWarned = false;
export function proveXCurve({ a, r_secp, r_BJJ, C_secp = null, C_BJJ = null, rng = defaultRng }) {
  if (rng === defaultRng) {
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') {
      throw new Error(
        'proveXCurve: default (platform-RNG) prover refused in production ' +
        '(NODE_ENV=production). Use proveXCurveDeterministic, or pass an ' +
        'explicit `rng` if the caller has audited its source.',
      );
    }
    if (!_proveXCurveRngWarned && typeof process !== 'undefined' && process.stderr) {
      _proveXCurveRngWarned = true;
      process.stderr.write(
        '[tacit-amm] WARNING: proveXCurve called with default platform RNG. ' +
        'Production code MUST use proveXCurveDeterministic. ' +
        'Refused if NODE_ENV=production.\n',
      );
    }
  }
  if (typeof a !== 'bigint' || a < 0n || a >= (1n << 64n)) {
    throw new Error('amount must satisfy 0 ≤ a < 2^64');
  }
  r_secp = modSecp(r_secp);
  r_BJJ  = modN_BJJ(r_BJJ);

  const Cs = C_secp || pedersenCommit(a, r_secp);
  const Cb = C_BJJ  || pedersenBJJ(a, r_BJJ);
  const Cs_bytes = pointToBytes(Cs);   // 33-byte compressed secp
  const Cb_bytes = packPoint(Cb);      // 32-byte packed BJJ

  // Commit phase
  const alpha   = sampleAlpha(rng);
  const beta_s  = sampleScalarMod(SECP_N, 32, rng);
  const beta_b  = sampleScalarMod(N_BJJ, 32, rng);

  // A_secp = α·H_secp + β_secp·G_secp
  const A_secp_pt = (alpha === 0n ? SECP_ZERO : H_SECP.multiply(modSecp(alpha)))
    .add(beta_s === 0n ? SECP_ZERO : G_SECP.multiply(beta_s));
  // A_BJJ = α·H_BJJ + β_BJJ·G_BJJ
  const aH_bjj = alpha === 0n ? [0n, 1n] : mulScalar(H_BJJ(), modN_BJJ(alpha));
  const bG_bjj = beta_b === 0n ? [0n, 1n] : mulScalar(G_BJJ(), beta_b);
  const A_BJJ_pt = addPoint(aH_bjj, bG_bjj);

  const A_secp_bytes = pointToBytes(A_secp_pt); // 33
  const A_BJJ_bytes  = packPoint(A_BJJ_pt);     // 32

  // Challenge
  const e = challenge(Cs_bytes, Cb_bytes, A_secp_bytes, A_BJJ_bytes);

  // Response (z_a over the integers)
  const z_a = alpha + e * a;
  if (z_a >= TWO_320) {
    // Statistically impossible (α ≤ 2^320 − 2^192, e·a ≤ 2^192 − 1 ⇒ z_a < 2^320).
    // Keep as defensive guard.
    throw new Error('z_a overflowed 40 bytes (resample required)');
  }
  const z_r_secp = modSecp(beta_s + e * r_secp);
  const z_r_BJJ  = modN_BJJ(beta_b + e * r_BJJ);

  const proof = concatBytes(
    A_secp_bytes,                       // 33
    A_BJJ_bytes,                        // 32
    bigintToBytesBE(z_a, Z_A_BYTES),    // 40
    bigintToBytesBE(z_r_secp, 32),      // 32
    bigintToBytesBE(z_r_BJJ, 32),       // 32
  );
  if (proof.length !== XCURVE_PROOF_LEN) {
    throw new Error(`proof len ${proof.length}, expected ${XCURVE_PROOF_LEN}`);
  }
  return { proof, C_secp_bytes: Cs_bytes, C_BJJ_bytes: Cb_bytes };
}

// ---- verifier ----
//
// Inputs:
//   proof    : Uint8Array(169)
//   C_secp_bytes : 33-byte compressed secp Pedersen commitment
//   C_BJJ_bytes  : 32-byte packed BJJ Pedersen commitment
//
// Returns: true if proof verifies under both curves with a SHARED integer z_a.
export function verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) {
  if (!(proof instanceof Uint8Array) || proof.length !== XCURVE_PROOF_LEN) return false;
  if (!(C_secp_bytes instanceof Uint8Array) || C_secp_bytes.length !== 33) return false;
  if (!(C_BJJ_bytes  instanceof Uint8Array) || C_BJJ_bytes.length  !== 32) return false;

  // Layout: A_secp(33) | A_BJJ(32) | z_a(40) | z_r_secp(32) | z_r_BJJ(32)
  const A_secp_bytes = proof.subarray(0, 33);
  const A_BJJ_bytes  = proof.subarray(33, 65);
  const z_a          = bytesToBigintBE(proof.subarray(65, 65 + Z_A_BYTES));
  const z_r_secp     = bytesToBigintBE(proof.subarray(65 + Z_A_BYTES, 65 + Z_A_BYTES + 32));
  const z_r_BJJ      = bytesToBigintBE(proof.subarray(65 + Z_A_BYTES + 32, XCURVE_PROOF_LEN));

  // Range checks
  if (z_a >= TWO_320)   return false;          // 40-byte BE encoding bound
  if (z_r_secp >= SECP_N) return false;        // mod n_secp
  if (z_r_BJJ  >= N_BJJ)  return false;        // mod n_BJJ

  // Decode points
  let C_secp_pt, A_secp_pt, C_BJJ_pt, A_BJJ_pt;
  try {
    C_secp_pt = secp.ProjectivePoint.fromHex(bytesToHex(C_secp_bytes));
    A_secp_pt = secp.ProjectivePoint.fromHex(bytesToHex(A_secp_bytes));
  } catch { return false; }
  C_BJJ_pt = unpackPoint(C_BJJ_bytes);
  A_BJJ_pt = unpackPoint(A_BJJ_bytes);
  if (!C_BJJ_pt || !A_BJJ_pt) return false;

  const e = challenge(C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes);

  // Check secp side:  z_a·H_secp + z_r_secp·G_secp == A_secp + e·C_secp
  // z_a may exceed n_secp; modSecp() applies the explicit reduction.
  const lhsS = (z_a === 0n ? SECP_ZERO : H_SECP.multiply(modSecp(z_a)))
    .add(z_r_secp === 0n ? SECP_ZERO : G_SECP.multiply(z_r_secp));
  const rhsS = A_secp_pt.add(e === 0n ? SECP_ZERO : C_secp_pt.multiply(e));
  if (!lhsS.equals(rhsS)) return false;

  // Check BJJ side:  z_a·H_BJJ + z_r_BJJ·G_BJJ == A_BJJ + e·C_BJJ
  // z_a may exceed n_BJJ; modN_BJJ() applies the explicit reduction.
  const lhsB = addPoint(
    z_a === 0n ? [0n, 1n] : mulScalar(H_BJJ(), modN_BJJ(z_a)),
    z_r_BJJ === 0n ? [0n, 1n] : mulScalar(G_BJJ(), z_r_BJJ),
  );
  const eC_BJJ = e === 0n ? [0n, 1n] : mulScalar(C_BJJ_pt, e);
  const rhsB = addPoint(A_BJJ_pt, eC_BJJ);
  return bjjEq(lhsB, rhsB);
}

// `bytesToHex` is needed for @noble/secp256k1 v2 Point.fromHex
function bytesToHex(b) {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < b.length; i++) {
    out += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
  }
  return out;
}

// ===========================================================================
// Deterministic-nonce production prover wrapper
// ===========================================================================
//
// Wraps `proveXCurve` with a deterministic (witness + statement)-derived
// nonce source so production signers don't depend on the platform RNG. An
// RNG bug (insufficient entropy, replay across re-derived processes, etc.)
// in a randomized sigma can leak the witness scalars; with deterministic
// nonces an adversary who controls timing/process state still can't extract
// the witness because (α, β_secp, β_BJJ) are an HMAC of secrets they don't
// know.
//
// Inputs:
//   a, r_secp, r_BJJ  — witness scalars (same as proveXCurve)
//   seedKey           — Uint8Array(≥16). MUST be a high-entropy secret
//                       derived from long-term key material, NOT the
//                       witness scalars themselves. A typical derivation
//                       is HMAC-SHA256(trader_priv, "tacit-amm-xcurve-seed-v1").
//                       Reusing the same (seedKey, statement) across distinct
//                       (a, r) inputs is SAFE because the statement (which
//                       includes the commitments) changes when (a, r) change.
//   C_secp, C_BJJ     — optional precomputed commitments (saves recomputation)
//
// Returns: same shape as proveXCurve.
export function proveXCurveDeterministic({ a, r_secp, r_BJJ, seedKey, C_secp = null, C_BJJ = null }) {
  if (typeof a !== 'bigint' || a < 0n || a >= (1n << 64n)) {
    throw new Error('amount must satisfy 0 ≤ a < 2^64');
  }
  const r_s = modSecp(r_secp);
  const r_b = modN_BJJ(r_BJJ);
  const Cs = C_secp || pedersenCommit(a, r_s);
  const Cb = C_BJJ  || pedersenBJJ(a, r_b);
  const Cs_bytes = pointToBytes(Cs);
  const Cb_bytes = packPoint(Cb);
  // Statement = the public preimage that goes into the FS challenge plus the
  // witness commitment to bind nonces to this exact proving event. The
  // deterministic RNG is reset per call via the statement, so different
  // invocations with different witnesses get different nonce streams even
  // under a fixed seedKey.
  const statement = concatBytes(
    Cs_bytes, Cb_bytes,
    // Bind witness scalars into the nonce derivation so two calls with the
    // same (a, r_secp, r_BJJ) produce identical nonces (deterministic), and
    // two calls with different witnesses produce independent streams.
    bigintToBytesBE(a, 8),
    bigintToBytesBE(r_s, 32),
    bigintToBytesBE(r_b, 32),
  );
  const rng = makeDeterministicRng(seedKey, statement);
  return proveXCurve({ a, r_secp: r_s, r_BJJ: r_b, C_secp: Cs, C_BJJ: Cb, rng });
}
