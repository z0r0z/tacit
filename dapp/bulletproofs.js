// secp256k1 Pedersen + NUMS-H primitives, packaged as an ES module that
// the dapp's AMM modules (amm-sigma.js, amm-lp.js) can import without
// circular-depending on dapp/tacit.js.
//
// IMPORTANT: H must match dapp/tacit.js's `deriveH()` byte-for-byte. We
// reuse the same domain string ('tacit-generator-H-v1') and try-and-increment
// pattern. A divergence would make Pedersen commits produced by the AMM
// modules incompatible with the worker's verifier. Cross-impl pinning test
// (tests/amm-foundation.test.mjs) catches drift.

import { secp, sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N_BITS = 64;

export function modN(x) { return ((x % SECP_N) + SECP_N) % SECP_N; }

function _deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(seed, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), x);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error('failed to derive NUMS generator H');
}

export const H = _deriveH();
export const G = secp.ProjectivePoint.BASE;
export const ZERO = secp.ProjectivePoint.ZERO;

export function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}

export const pointToBytes = P => P.toRawBytes(true);

export function bigintToBytes32(n) {
  const m = modN(n);
  return hexToBytes(m.toString(16).padStart(64, '0'));
}

export function bytes32ToBigint(b) {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

// BIP-340 Schnorr — same impl as dapp/tacit.js's inline signSchnorr but
// re-exported here so AMM modules can import without circular-depending
// on tacit.js. Math is byte-identical to the test reference's
// composition.mjs signSchnorr.
function _taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}
function _xor32(a, b) { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; }
export function signSchnorr(msgHash, priv32) {
  const dPrime = bytes32ToBigint(priv32);
  if (dPrime <= 0n || dPrime >= SECP_N) throw new Error('schnorr: invalid private key');
  const P = G.multiply(dPrime);
  const Pbytes = P.toRawBytes(true);
  const Px = Pbytes.slice(1);
  const d = (Pbytes[0] === 0x02) ? dPrime : (SECP_N - dPrime);
  const aux = crypto.getRandomValues(new Uint8Array(32));
  const t = _xor32(bigintToBytes32(d), _taggedHash('BIP0340/aux', aux));
  const rand = _taggedHash('BIP0340/nonce', t, Px, msgHash);
  let kPrime = bytes32ToBigint(rand) % SECP_N;
  if (kPrime === 0n) throw new Error('schnorr: nonce was zero');
  const R = G.multiply(kPrime);
  const Rbytes = R.toRawBytes(true);
  const Rx = Rbytes.slice(1);
  const k = (Rbytes[0] === 0x02) ? kPrime : (SECP_N - kPrime);
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, Px, msgHash)) % SECP_N;
  const s = (k + e * d) % SECP_N;
  return concatBytes(Rx, bigintToBytes32(s));
}
export function verifySchnorr(sig64, msgHash, pubXonly32) {
  if (sig64.length !== 64 || pubXonly32.length !== 32 || msgHash.length !== 32) return false;
  const Rx = sig64.slice(0, 32);
  const sBig = bytes32ToBigint(sig64.slice(32, 64));
  if (sBig >= SECP_N) return false;
  if (bytes32ToBigint(pubXonly32) >= SECP_P) return false;
  let P; try { P = secp.ProjectivePoint.fromHex('02' + bytesToHex(pubXonly32)); } catch { return false; }
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, pubXonly32, msgHash)) % SECP_N;
  // noble's Point.multiply throws on scalar=0. Guard so adversarial sigs
  // (s=0 or e=0) don't crash the verifier — let the identity-point check
  // below reject them as invalid.
  const sG = sBig === 0n ? ZERO : G.multiply(sBig);
  const eP = e === 0n ? ZERO : P.multiply(e);
  const R = sG.add(eP.negate());
  if (R.equals(ZERO)) return false;
  const Rb = R.toRawBytes(true);
  if (Rb[0] !== 0x02) return false;
  for (let i = 0; i < 32; i++) if (Rb[i + 1] !== Rx[i]) return false;
  return true;
}

// ──────────────────── Classic Bulletproofs aggregated range verify ────────────────────
// Mirror of the guest `verify_range_classic` (cxfer-core/src/lib.rs) and byte-identical to
// dapp/tacit.js / tests/bulletproofs.mjs `bpRangeAggBatchVerify`. Verifies a classic-BP
// (`T_CXFER` 0x23) aggregated range proof over m ∈ {1,2,4,8} compressed commitments.
// Generators `G_vec`/`H_vec` share the BP+ domains (`tacit-bp-G/H-v1`); `Q` = `tacit-bp-Q-v1`.
function _modInv(a) {
  let x = modN(a); if (x === 0n) throw new Error('modInv(0)');
  let res = 1n, base = x, exp = SECP_N - 2n;
  while (exp > 0n) { if (exp & 1n) res = (res * base) % SECP_N; base = (base * base) % SECP_N; exp >>= 1n; }
  return res;
}
function _batchInv(xs) {
  const n = xs.length; if (n === 0) return [];
  const partial = new Array(n); partial[0] = modN(xs[0]);
  for (let i = 1; i < n; i++) partial[i] = modN(partial[i - 1] * xs[i]);
  let inv = _modInv(partial[n - 1]); const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = i === 0 ? inv : modN(inv * partial[i - 1]); inv = modN(inv * xs[i]); }
  return out;
}
function _vecInner(a, b) { let s = 0n; for (let i = 0; i < a.length; i++) s = modN(s + a[i] * b[i]); return s; }
function _vecPow(x, n) { const r = new Array(n); let p = 1n; for (let i = 0; i < n; i++) { r[i] = p; p = modN(p * x); } return r; }
function _msm(scalars, points) {
  let acc = ZERO;
  for (let i = 0; i < scalars.length; i++) { const s = modN(scalars[i]); if (s !== 0n) acc = acc.add(points[i].multiply(s)); }
  return acc;
}
function _bpHashToCurveC(domain, idx) {
  const idxLE = new Uint8Array(4); new DataView(idxLE.buffer).setUint32(0, idx >>> 0, true);
  for (let counter = 0; counter < 256; counter++) {
    const seed = sha256(concatBytes(new TextEncoder().encode(domain), idxLE, new Uint8Array([counter])));
    try { const p = secp.ProjectivePoint.fromHex(bytesToHex(concatBytes(new Uint8Array([0x02]), seed))); if (!p.equals(ZERO)) return p; } catch {}
  }
  throw new Error(`bp generator failed: ${domain}#${idx}`);
}
const _BP_MAX_NM = N_BITS * 8;
let _BPC_G = null, _BPC_H = null, _BPC_Q = null;
function _bpGensC() {
  if (_BPC_G) return { Gvec: _BPC_G, Hvec: _BPC_H, Q: _BPC_Q };
  _BPC_G = []; _BPC_H = [];
  for (let i = 0; i < _BP_MAX_NM; i++) { _BPC_G.push(_bpHashToCurveC('tacit-bp-G-v1', i)); _BPC_H.push(_bpHashToCurveC('tacit-bp-H-v1', i)); }
  _BPC_Q = _bpHashToCurveC('tacit-bp-Q-v1', 0);
  return { Gvec: _BPC_G, Hvec: _BPC_H, Q: _BPC_Q };
}
function _bpTranscriptC() {
  const parts = [];
  const _u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const _push = (l, d) => { parts.push(_u32(l.length)); parts.push(l); parts.push(_u32(d.length)); parts.push(d); };
  return {
    append(label, bytes) { _push(new TextEncoder().encode(label), bytes); },
    challenge(label) {
      const lb = new TextEncoder().encode(label); parts.push(_u32(lb.length)); parts.push(lb);
      const h = sha256(concatBytes(...parts)); parts.push(_u32(h.length)); parts.push(h);
      let c = modN(bytes32ToBigint(h));
      if (c === 0n) { c = modN(bytes32ToBigint(sha256(concatBytes(h, new Uint8Array([0x01]))))); if (c === 0n) throw new Error('bp transcript: 0 challenge'); }
      return c;
    },
  };
}
// Byte length of a classic-BP proof for m commitments (distinct from BP+'s 99+96+log_mn·66).
export function bpClassicProofLen(m, n_bits = N_BITS) {
  const log_nm = Math.log2(n_bits * m); if (!Number.isInteger(log_nm)) return -1;
  return 33 * 4 + 32 * 3 + log_nm * 33 * 2 + 32 * 2;
}
// commitmentsCompressed: array of 33-byte compressed points (Uint8Array or hex). proofBytes: Uint8Array.
export function bpRangeVerify(commitmentsCompressed, proofBytes, n_bits = N_BITS) {
  const m = commitmentsCompressed.length;
  if (![1, 2, 4, 8].includes(m)) return false;
  const nm = n_bits * m; const log_nm = Math.log2(nm);
  if (!Number.isInteger(log_nm)) return false;
  if (!proofBytes || proofBytes.length !== bpClassicProofLen(m, n_bits)) return false;
  const toPt = c => (c instanceof Uint8Array) ? secp.ProjectivePoint.fromHex(bytesToHex(c)) : secp.ProjectivePoint.fromHex(String(c).replace(/^0x/, ''));
  let V_pts;
  try { V_pts = commitmentsCompressed.map(toPt); } catch { return false; }
  let off = 0; let A, S, T_1, T_2;
  try {
    A = secp.ProjectivePoint.fromHex(bytesToHex(proofBytes.slice(off, off + 33))); off += 33;
    S = secp.ProjectivePoint.fromHex(bytesToHex(proofBytes.slice(off, off + 33))); off += 33;
    T_1 = secp.ProjectivePoint.fromHex(bytesToHex(proofBytes.slice(off, off + 33))); off += 33;
    T_2 = secp.ProjectivePoint.fromHex(bytesToHex(proofBytes.slice(off, off + 33))); off += 33;
  } catch { return false; }
  const t_hat = modN(bytes32ToBigint(proofBytes.slice(off, off + 32))); off += 32;
  const tau_x = modN(bytes32ToBigint(proofBytes.slice(off, off + 32))); off += 32;
  const mu = modN(bytes32ToBigint(proofBytes.slice(off, off + 32))); off += 32;
  const Lk = [], Rk = [];
  try { for (let k = 0; k < log_nm; k++) { Lk.push(secp.ProjectivePoint.fromHex(bytesToHex(proofBytes.slice(off, off + 33)))); off += 33; Rk.push(secp.ProjectivePoint.fromHex(bytesToHex(proofBytes.slice(off, off + 33)))); off += 33; } } catch { return false; }
  const a_final = modN(bytes32ToBigint(proofBytes.slice(off, off + 32))); off += 32;
  const b_final = modN(bytes32ToBigint(proofBytes.slice(off, off + 32))); off += 32;
  if (off !== proofBytes.length) return false;

  const t = _bpTranscriptC();
  t.append('domain', new TextEncoder().encode('tacit-bp-v1'));
  t.append('n', new Uint8Array([n_bits & 0xff]));
  t.append('m', new Uint8Array([m & 0xff]));
  for (const V of V_pts) t.append('V', pointToBytes(V));
  t.append('A', pointToBytes(A)); t.append('S', pointToBytes(S));
  const y = t.challenge('y'); const z = t.challenge('z');
  t.append('T1', pointToBytes(T_1)); t.append('T2', pointToBytes(T_2));
  const x = t.challenge('x');
  t.append('t_hat', bigintToBytes32(t_hat)); t.append('tau_x', bigintToBytes32(tau_x)); t.append('mu', bigintToBytes32(mu));
  const w = t.challenge('w');
  const u = new Array(log_nm);
  for (let j = 0; j < log_nm; j++) { t.append('L', pointToBytes(Lk[j])); t.append('R', pointToBytes(Rk[j])); u[j] = t.challenge('u'); }
  const u_inv = _batchInv(u);
  const u_sq = u.map(uu => modN(uu * uu));
  const u_inv_sq = u_inv.map(uu => modN(uu * uu));
  const s = new Array(nm);
  s[0] = u_inv.reduce((a, v) => modN(a * v), 1n);
  for (let i = 1; i < nm; i++) { const lsb = i & -i; const j = log_nm - 1 - (Math.log2(lsb) | 0); s[i] = modN(s[i ^ lsb] * u_sq[j]); }
  const s_inv = _batchInv(s);
  const y_nm = _vecPow(y, nm); const sum_y_nm = _vecInner(new Array(nm).fill(1n), y_nm);
  const sum_two_n = (1n << BigInt(n_bits)) - 1n;
  const z_sq = modN(z * z); const z_minus_z2 = modN(z - z_sq);
  let zp = modN(z_sq * z); let delta = modN(z_minus_z2 * sum_y_nm);
  for (let j = 0; j < m; j++) { delta = modN(delta - zp * sum_two_n); zp = modN(zp * z); }
  const y_inv = _modInv(y); const y_inv_pow = _vecPow(y_inv, nm);
  const zpow_2j = new Array(m); { let p = z_sq; for (let j = 0; j < m; j++) { zpow_2j[j] = p; p = modN(p * z); } }
  const two_n = _vecPow(2n, n_bits);
  const { Gvec: Gfull, Hvec: Hfull, Q } = _bpGensC();
  const Gvec = Gfull.slice(0, nm), Hvec = Hfull.slice(0, nm);
  const x2 = modN(x * x);

  // check A (t-polynomial): h·(t_hat−δ) + G·τx − x·T1 − x²·T2 − Σ z^{2+j}·V_j = 𝟘
  const aScalars = [modN(t_hat - delta), tau_x, modN(-x), modN(-x2)];
  const aPoints = [H, G, T_1, T_2];
  { let zj = z_sq; for (let j = 0; j < m; j++) { aScalars.push(modN(-zj)); aPoints.push(V_pts[j]); zj = modN(zj * z); } }
  if (!_msm(aScalars, aPoints).equals(ZERO)) return false;

  // check B (inner-product): A + x·S − μ·G + w(t_hat−a·b)·Q + Σ(u²L+u⁻²R) + Σ G_i·(−z−a·s_i) + Σ H_i·(…)
  const bScalars = [1n, x, modN(-mu), modN(w * modN(t_hat - a_final * b_final))];
  const bPoints = [A, S, G, Q];
  for (let k = 0; k < log_nm; k++) { bScalars.push(u_sq[k]); bPoints.push(Lk[k]); bScalars.push(u_inv_sq[k]); bPoints.push(Rk[k]); }
  const minus_z = modN(-z);
  for (let i = 0; i < nm; i++) {
    const j = (i / n_bits) | 0, k = i % n_bits;
    const g_total = modN(minus_z - a_final * s[i]);
    const h_coeff = modN(z + modN(zpow_2j[j] * two_n[k]) * y_inv_pow[i]);
    const h_total = modN(h_coeff - b_final * modN(s_inv[i] * y_inv_pow[i]));
    bScalars.push(g_total); bPoints.push(Gvec[i]);
    bScalars.push(h_total); bPoints.push(Hvec[i]);
  }
  return _msm(bScalars, bPoints).equals(ZERO);
}
