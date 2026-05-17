// Camenisch-Stadler sigma protocol binding secp256k1 Pedersen ↔ BabyJubJub
// Pedersen under a shared hidden amount `a`. Dapp-side port of
// tests/amm-sigma-xcurve.mjs — math identical, imports adjusted for the
// dapp bundle.
//
// Per AMM.md §"Hybrid commitments (secp256k1 + BabyJubJub)" — proves
// knowledge of (a, r_secp, r_BJJ) with shared 320-bit integer `z_a` so
// neither side can claim a different hidden amount.
//
// Wire format (169 bytes): A_secp(33) || A_BJJ(32) || z_a(40) || z_r_secp(32) || z_r_BJJ(32)
// Soundness: 128-bit (FS challenge space 2^128). Statistical ZK: ≈ 128-bit.

import { secp, sha256, concatBytes, hmac } from './vendor/tacit-deps.min.js';
import {
  G as G_SECP, H as H_SECP, SECP_N, modN as modSecp, ZERO as SECP_ZERO,
  pedersenCommit, pointToBytes,
} from './bulletproofs.js';
import {
  N_BJJ, mod as modField,
  addPoint, mulScalar, eq as bjjEq,
  packPoint, unpackPoint,
  H_BJJ, G_BJJ, pedersenBJJ,
} from './amm-bjj.js';

const DOMAIN = new TextEncoder().encode('tacit-amm-xcurve-v1');

const TWO_128 = 1n << 128n;
const TWO_192 = 1n << 192n;
const TWO_320 = 1n << 320n;
const ALPHA_MAX = TWO_320 - TWO_192;

export const XCURVE_PROOF_LEN = 169;
export const Z_A_BYTES = 40;
export const CHALLENGE_BYTES = 16;

function modN_BJJ(x) { return ((x % N_BJJ) + N_BJJ) % N_BJJ; }

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

function hmacSha256(key, msg) {
  return hmac(sha256, key, msg);
}

// Deterministic-nonce production prover. seedKey is a high-entropy secret
// derived from long-term key material (NOT the witness scalars) so an RNG
// bug can't leak the witness. Statement binds nonces to this exact proof.
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
      new DataView(ctr.buffer).setUint32(0, counter++, false);
      const msg = concatBytes(TAG, statement, ctr);
      const block = hmacSha256(seedKey, msg);
      const take = Math.min(32, len - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
}

export function challenge(C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes) {
  const h = sha256(concatBytes(DOMAIN, C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes));
  return bytesToBigintBE(h.subarray(32 - CHALLENGE_BYTES, 32));
}

// Dapp internal helper — @noble/secp256k1 v2 ProjectivePoint.fromHex needs hex.
function bytesToHexLocal(b) {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < b.length; i++) {
    out += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
  }
  return out;
}

// Production prover (deterministic-nonce). Browser code should always use
// this variant — the default platform-RNG path is for tests only.
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
  const statement = concatBytes(
    Cs_bytes, Cb_bytes,
    bigintToBytesBE(a, 8),
    bigintToBytesBE(r_s, 32),
    bigintToBytesBE(r_b, 32),
  );
  const rng = makeDeterministicRng(seedKey, statement);
  return proveXCurveRaw({ a, r_secp: r_s, r_BJJ: r_b, C_secp: Cs, C_BJJ: Cb, rng });
}

// Test-only RNG-driven prover (browser callers should never use this —
// in JSDOM-based unit tests it's fine because tests pass their own rng).
export function proveXCurveRaw({ a, r_secp, r_BJJ, C_secp = null, C_BJJ = null, rng = defaultRng }) {
  if (typeof a !== 'bigint' || a < 0n || a >= (1n << 64n)) {
    throw new Error('amount must satisfy 0 ≤ a < 2^64');
  }
  r_secp = modSecp(r_secp);
  r_BJJ  = modN_BJJ(r_BJJ);

  const Cs = C_secp || pedersenCommit(a, r_secp);
  const Cb = C_BJJ  || pedersenBJJ(a, r_BJJ);
  const Cs_bytes = pointToBytes(Cs);
  const Cb_bytes = packPoint(Cb);

  const alpha   = sampleAlpha(rng);
  const beta_s  = sampleScalarMod(SECP_N, 32, rng);
  const beta_b  = sampleScalarMod(N_BJJ, 32, rng);

  const A_secp_pt = (alpha === 0n ? SECP_ZERO : H_SECP.multiply(modSecp(alpha)))
    .add(beta_s === 0n ? SECP_ZERO : G_SECP.multiply(beta_s));
  const aH_bjj = alpha === 0n ? [0n, 1n] : mulScalar(H_BJJ(), modN_BJJ(alpha));
  const bG_bjj = beta_b === 0n ? [0n, 1n] : mulScalar(G_BJJ(), beta_b);
  const A_BJJ_pt = addPoint(aH_bjj, bG_bjj);

  const A_secp_bytes = pointToBytes(A_secp_pt);
  const A_BJJ_bytes  = packPoint(A_BJJ_pt);

  const e = challenge(Cs_bytes, Cb_bytes, A_secp_bytes, A_BJJ_bytes);

  const z_a = alpha + e * a;
  if (z_a >= TWO_320) {
    throw new Error('z_a overflowed 40 bytes (resample required)');
  }
  const z_r_secp = modSecp(beta_s + e * r_secp);
  const z_r_BJJ  = modN_BJJ(beta_b + e * r_BJJ);

  const proof = concatBytes(
    A_secp_bytes,
    A_BJJ_bytes,
    bigintToBytesBE(z_a, Z_A_BYTES),
    bigintToBytesBE(z_r_secp, 32),
    bigintToBytesBE(z_r_BJJ, 32),
  );
  if (proof.length !== XCURVE_PROOF_LEN) {
    throw new Error(`proof len ${proof.length}, expected ${XCURVE_PROOF_LEN}`);
  }
  return { proof, C_secp_bytes: Cs_bytes, C_BJJ_bytes: Cb_bytes };
}

export function verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) {
  if (!(proof instanceof Uint8Array) || proof.length !== XCURVE_PROOF_LEN) return false;
  if (!(C_secp_bytes instanceof Uint8Array) || C_secp_bytes.length !== 33) return false;
  if (!(C_BJJ_bytes  instanceof Uint8Array) || C_BJJ_bytes.length  !== 32) return false;

  const A_secp_bytes = proof.subarray(0, 33);
  const A_BJJ_bytes  = proof.subarray(33, 65);
  const z_a          = bytesToBigintBE(proof.subarray(65, 65 + Z_A_BYTES));
  const z_r_secp     = bytesToBigintBE(proof.subarray(65 + Z_A_BYTES, 65 + Z_A_BYTES + 32));
  const z_r_BJJ      = bytesToBigintBE(proof.subarray(65 + Z_A_BYTES + 32, XCURVE_PROOF_LEN));

  if (z_a >= TWO_320)   return false;
  if (z_r_secp >= SECP_N) return false;
  if (z_r_BJJ  >= N_BJJ)  return false;

  let C_secp_pt, A_secp_pt, C_BJJ_pt, A_BJJ_pt;
  try {
    C_secp_pt = secp.ProjectivePoint.fromHex(bytesToHexLocal(C_secp_bytes));
    A_secp_pt = secp.ProjectivePoint.fromHex(bytesToHexLocal(A_secp_bytes));
  } catch { return false; }
  C_BJJ_pt = unpackPoint(C_BJJ_bytes);
  A_BJJ_pt = unpackPoint(A_BJJ_bytes);
  if (!C_BJJ_pt || !A_BJJ_pt) return false;

  const e = challenge(C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes);

  const lhsS = (z_a === 0n ? SECP_ZERO : H_SECP.multiply(modSecp(z_a)))
    .add(z_r_secp === 0n ? SECP_ZERO : G_SECP.multiply(z_r_secp));
  const rhsS = A_secp_pt.add(e === 0n ? SECP_ZERO : C_secp_pt.multiply(e));
  if (!lhsS.equals(rhsS)) return false;

  const lhsB = addPoint(
    z_a === 0n ? [0n, 1n] : mulScalar(H_BJJ(), modN_BJJ(z_a)),
    z_r_BJJ === 0n ? [0n, 1n] : mulScalar(G_BJJ(), z_r_BJJ),
  );
  const eC_BJJ = e === 0n ? [0n, 1n] : mulScalar(C_BJJ_pt, e);
  const rhsB = addPoint(A_BJJ_pt, eC_BJJ);
  return bjjEq(lhsB, rhsB);
}
