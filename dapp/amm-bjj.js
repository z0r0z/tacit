// BabyJubJub curve primitives for the tacit AMM (SPEC §3.9 planned).
// Dapp-side port of tests/amm-bjj.mjs — kept byte-for-byte equivalent so
// the dapp's Pedersen-BJJ commitments match the worker's verify path.
//
// The only difference from the test version is the import shape: tests
// import from @noble/hashes directly; the dapp imports from its bundled
// vendor module. The math is identical.
//
// Twisted Edwards form per circomlib: a*u^2 + v^2 = 1 + d*u^2*v^2 over BN254 Fr.
//   a    = 168700
//   d    = 168696
//   p_Fr = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//   full group order  = 21888242871839275222246405745257275088614511777268538073601725287587578984328
//   prime subgroup    = full / 8 = 2736030358979909402780800718157159386076813972158567259200215660948447373041
//
// Point encoding: 32 bytes, v-coord LE, sign of u in high bit of byte 31.
// Matches circomlib `packPoint` byte-for-byte.

import { sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

export const P_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const A_BJJ = 168700n;
export const D_BJJ = 168696n;
export const ORDER_BJJ = 21888242871839275222246405745257275088614511777268538073601725287587578984328n;
export const N_BJJ = ORDER_BJJ / 8n;
export const COFACTOR_BJJ = 8n;

const PM1D2 = (P_FR - 1n) / 2n;

export function mod(a, p = P_FR) { const r = a % p; return r < 0n ? r + p : r; }
export function modPow(base, exp, p = P_FR) {
  let r = 1n, b = mod(base, p), e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % p;
    b = (b * b) % p;
    e >>= 1n;
  }
  return r;
}
export function modInv(a, p = P_FR) {
  let [oldR, r] = [mod(a, p), p];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('not invertible');
  return mod(oldS, p);
}

export function modSqrt(n, p = P_FR) {
  n = mod(n, p);
  if (n === 0n) return 0n;
  if (modPow(n, (p - 1n) / 2n, p) !== 1n) return null;
  let Q = p - 1n;
  let S = 0n;
  while ((Q & 1n) === 0n) { Q >>= 1n; S++; }
  if (S === 1n) return modPow(n, (p + 1n) / 4n, p);
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n, p) !== p - 1n) z++;
  let M = S;
  let c = modPow(z, Q, p);
  let t = modPow(n, Q, p);
  let R = modPow(n, (Q + 1n) / 2n, p);
  while (true) {
    if (t === 1n) return R;
    let i = 0n, tmp = t;
    while (tmp !== 1n) {
      tmp = (tmp * tmp) % p;
      i++;
      if (i >= M) return null;
    }
    const b = modPow(c, 1n << (M - i - 1n), p);
    M = i;
    c = (b * b) % p;
    t = (t * c) % p;
    R = (R * b) % p;
  }
}

export const ID = Object.freeze([0n, 1n]);

export function eq(P, Q) { return P[0] === Q[0] && P[1] === Q[1]; }
export function isIdentity(P) { return P[0] === 0n && P[1] === 1n; }

export function onCurve(P) {
  const [u, v] = P;
  const u2 = (u * u) % P_FR;
  const v2 = (v * v) % P_FR;
  const lhs = mod(A_BJJ * u2 + v2);
  const rhs = mod(1n + D_BJJ * ((u2 * v2) % P_FR));
  return lhs === rhs;
}

export function addPoint(P, Q) {
  const [u1, v1] = P, [u2, v2] = Q;
  const u1u2 = (u1 * u2) % P_FR;
  const v1v2 = (v1 * v2) % P_FR;
  const dProd = mod(D_BJJ * u1u2 * v1v2 % P_FR);
  const inv1 = modInv(mod(1n + dProd));
  const inv2 = modInv(mod(1n - dProd));
  const u3 = mod((u1 * v2 + v1 * u2) % P_FR * inv1);
  const v3 = mod((v1 * v2 - A_BJJ * u1 * u2 % P_FR) * inv2);
  return [u3, v3];
}

export function mulScalar(P, k) {
  let r = [0n, 1n];
  let acc = [P[0], P[1]];
  let e = mod(k, ORDER_BJJ);
  while (e > 0n) {
    if (e & 1n) r = addPoint(r, acc);
    acc = addPoint(acc, acc);
    e >>= 1n;
  }
  return r;
}

export function packPoint(P) {
  const buf = new Uint8Array(32);
  let v = P[1];
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  if (P[0] > PM1D2) buf[31] |= 0x80;
  return buf;
}

export function inSubgroup(P) {
  if (isIdentity(P)) return true;
  return isIdentity(mulScalar(P, N_BJJ));
}

export function unpackPoint(buf) {
  if (buf.length !== 32) throw new Error('bad length');
  const work = new Uint8Array(buf);
  let sign = false;
  if (work[31] & 0x80) { sign = true; work[31] &= 0x7f; }
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(work[i]);
  if (v >= P_FR) return null;
  const v2 = (v * v) % P_FR;
  const num = mod(1n - v2);
  const den = mod(A_BJJ - D_BJJ * v2 % P_FR);
  if (den === 0n) return null;
  const u2 = mod(num * modInv(den));
  let u = modSqrt(u2);
  if (u === null) return null;
  if ((u > PM1D2) !== sign) u = mod(-u);
  const P = [u, v];
  if (!inSubgroup(P)) return null;
  return P;
}

const SEED_H = new TextEncoder().encode('tacit-amm-bjj-H-v1');
const SEED_G = new TextEncoder().encode('tacit-amm-bjj-G-v1');

function counterLE(c) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, c >>> 0, true);
  return b;
}

function digestToScalar(digest32) {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(digest32[i]);
  return n % P_FR;
}

export function deriveBJJGenerator(seed, maxIters = 1024) {
  for (let c = 0; c < maxIters; c++) {
    const digest = sha256(concatBytes(seed, counterLE(c)));
    const u = digestToScalar(digest);
    const u2 = (u * u) % P_FR;
    const num = mod(1n - A_BJJ * u2 % P_FR);
    const den = mod(1n - D_BJJ * u2 % P_FR);
    if (den === 0n) continue;
    const vsq = mod(num * modInv(den));
    let v = modSqrt(vsq);
    if (v === null) continue;
    if ((v & 1n) === 1n) v = mod(-v);
    const cand = [u, v];
    if (!onCurve(cand)) continue;
    const Q = mulScalar(cand, COFACTOR_BJJ);
    if (isIdentity(Q)) continue;
    const ord = mulScalar(Q, N_BJJ);
    if (!isIdentity(ord)) continue;
    return { point: Q, counter: c };
  }
  throw new Error('BJJ NUMS derivation: max iterations exceeded');
}

let _H = null, _G = null, _Hmeta = null, _Gmeta = null;
export function H_BJJ() {
  if (!_H) { const r = deriveBJJGenerator(SEED_H); _H = r.point; _Hmeta = r; }
  return _H;
}
export function G_BJJ() {
  if (!_G) { const r = deriveBJJGenerator(SEED_G); _G = r.point; _Gmeta = r; }
  return _G;
}
export function H_BJJ_meta() { H_BJJ(); return _Hmeta; }
export function G_BJJ_meta() { G_BJJ(); return _Gmeta; }

// Pedersen commitment on BabyJubJub: C = a*H_BJJ + r*G_BJJ.
// Padded-slot rule: (0, 0) → identity (0, 1) so caller can elide hiding.
// Real-amount callers MUST use pedersenBJJStrict (rejects blinding ≡ 0).
export function pedersenBJJ(amount, blinding) {
  const a = mod(BigInt(amount), N_BJJ);
  const r = mod(BigInt(blinding), N_BJJ);
  const aH = a === 0n ? [0n, 1n] : mulScalar(H_BJJ(), a);
  const rG = r === 0n ? [0n, 1n] : mulScalar(G_BJJ(), r);
  return addPoint(aH, rG);
}

export function pedersenBJJStrict(amount, blinding) {
  const r = mod(BigInt(blinding), N_BJJ);
  if (r === 0n) {
    throw new Error('pedersenBJJStrict: blinding ≡ 0 mod N_BJJ destroys hiding');
  }
  return pedersenBJJ(amount, blinding);
}

export function pointToHex(P) {
  return `(${P[0].toString(16).padStart(64, '0')}, ${P[1].toString(16).padStart(64, '0')})`;
}
