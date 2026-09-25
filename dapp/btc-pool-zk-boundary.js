// secp256k1 ↔ BabyJubJub boundary of the client-proved Bitcoin shielded pool.
//
// Transparent Tacit notes are secp Pedersen commitments v·H + r·G; pool values enter and leave the circuit as
// BabyJub commitments v·H_BJJ + r·G_BJJ (depC / exitC). A boundary crossing carries
//
//   C_secp(33) ‖ C_bjj(32) ‖ sigma(169) ‖ bpp(591)          BOUNDARY_LEN = 825
//
// sigma: the cross-curve Camenisch–Stadler proof (amm-sigma.js), equal amounts modulo each group order.
// bpp:   a 64-bit Bulletproofs+ range proof on C_secp (bulletproofs-plus.js, m = 1).
// The circuit range-checks the BabyJub side (< 2^64); with both sides range-bound the sigma's modular
// equality is integer equality.
//
// Shield: C_secp = C_pool, the kernel output over the shielded transparent notes; C_bjj = depC.
// Exit:   C_secp = the new transparent note's commitment; C_bjj = exitC.

import { secp } from './vendor/tacit-deps.min.js';
import { proveXCurveDeterministic, verifyXCurve, XCURVE_PROOF_LEN } from './amm-sigma.js';
import { bppRangeProve, bppRangeVerify } from './bulletproofs-plus.js';
import { pedersenCommit, pointToBytes, SECP_N } from './bulletproofs.js';
import { pedersenBJJ, packPoint, unpackPoint, isIdentity, N_BJJ } from './amm-bjj.js';

export const BPP_M1_LEN = 591;
export const BOUNDARY_LEN = 33 + 32 + XCURVE_PROOF_LEN + BPP_M1_LEN;
const U64 = 1n << 64n;
const R_BJJ_MAX = 1n << 251n;

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// v: u64; rSecp: blinding mod n_secp (nonzero); rBjj: blinding in (0, l) (the circuit reads it as < 2^251);
// seedKey: ≥ 16 bytes of wallet-derived secret for the sigma's deterministic nonces.
export function proveBoundary({ v, rSecp, rBjj, seedKey }) {
  const a = BigInt(v);
  if (a < 0n || a >= U64) throw new Error('boundary: v must be a u64');
  const rs = BigInt(rSecp) % SECP_N;
  const rb = BigInt(rBjj);
  if (rs === 0n) throw new Error('boundary: zero secp blinding');
  if (rb <= 0n || rb >= N_BJJ || rb >= R_BJJ_MAX) throw new Error('boundary: rBjj must be in (0, l)');
  const Cs = pedersenCommit(a, rs);
  const Cb = pedersenBJJ(a, rb);
  const { proof: sigma, C_secp_bytes: cSecp, C_BJJ_bytes: cBjj } = proveXCurveDeterministic({
    a, r_secp: rs, r_BJJ: rb, seedKey, C_secp: Cs, C_BJJ: Cb,
  });
  const { proof: bpp } = bppRangeProve([a], [rs]);
  return { cSecp, cBjj, sigma, bpp, cBjjPoint: Cb };
}

// Native check an indexer runs. Returns the BabyJub point for the circuit's public signals, or null.
export function verifyBoundary({ cSecp, cBjj, sigma, bpp }) {
  if (!(cSecp instanceof Uint8Array) || cSecp.length !== 33) return null;
  if (!(cBjj instanceof Uint8Array) || cBjj.length !== 32) return null;
  if (!(sigma instanceof Uint8Array) || sigma.length !== XCURVE_PROOF_LEN) return null;
  if (!(bpp instanceof Uint8Array) || bpp.length !== BPP_M1_LEN) return null;
  let Cs;
  try { Cs = secp.ProjectivePoint.fromHex(toHex(cSecp)); } catch { return null; }
  const Cb = unpackPoint(cBjj);
  if (!Cb || isIdentity(Cb)) return null;
  if (!verifyXCurve(sigma, cSecp, cBjj)) return null;
  let rangeOk = false;
  try { rangeOk = bppRangeVerify([Cs], bpp); } catch { rangeOk = false; }
  return rangeOk ? Cb : null;
}

export function encodeBoundary({ cSecp, cBjj, sigma, bpp }) {
  const out = new Uint8Array(BOUNDARY_LEN);
  out.set(cSecp, 0); out.set(cBjj, 33); out.set(sigma, 65); out.set(bpp, 65 + XCURVE_PROOF_LEN);
  return out;
}

export function decodeBoundary(b) {
  if (!(b instanceof Uint8Array) || b.length !== BOUNDARY_LEN) return null;
  return {
    cSecp: b.slice(0, 33), cBjj: b.slice(33, 65),
    sigma: b.slice(65, 65 + XCURVE_PROOF_LEN), bpp: b.slice(65 + XCURVE_PROOF_LEN),
  };
}

export { packPoint, pointToBytes };
