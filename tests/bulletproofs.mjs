// Bulletproofs implementation mirrored from tacit.html for offline testing and
// benchmarking. The math here matches the in-page module byte-for-byte, so a
// passing test suite is evidence the dApp's prover/verifier behave correctly.
//
// Run:
//   npm test    # correctness suite
//   npm run bench  # microbenchmarks
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const N_BITS = 64;

const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
const pointToBytes = P => P.toRawBytes(true);
const bytesToPoint = b => secp.ProjectivePoint.fromHex(bytesToHex(b));
function bigintToBytes32(n) { const m = modN(n); return hexToBytes(m.toString(16).padStart(64, '0')); }
const bytes32ToBigint = b => BigInt('0x' + bytesToHex(b));
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;

function deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(seed, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), x);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error('failed');
}
const H = deriveH();
function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}
function randomScalar() {
  while (true) {
    const x = bytes32ToBigint(crypto.getRandomValues(new Uint8Array(32)));
    if (x !== 0n && x < SECP_N) return x;
  }
}

// --- BP module (copied from tacit.html) ---
function modInv(a) {
  let x = modN(a); if (x === 0n) throw new Error('modInv(0)');
  let res = 1n, base = x, exp = SECP_N - 2n;
  while (exp > 0n) {
    if (exp & 1n) res = (res * base) % SECP_N;
    base = (base * base) % SECP_N;
    exp >>= 1n;
  }
  return res;
}
function vecScalarMul(v, s) { const r = new Array(v.length); for (let i = 0; i < v.length; i++) r[i] = modN(v[i] * s); return r; }
function vecAdd(a, b) { const r = new Array(a.length); for (let i = 0; i < a.length; i++) r[i] = modN(a[i] + b[i]); return r; }
function vecHadamard(a, b) { const r = new Array(a.length); for (let i = 0; i < a.length; i++) r[i] = modN(a[i] * b[i]); return r; }
function vecInner(a, b) { let s = 0n; for (let i = 0; i < a.length; i++) s = modN(s + a[i] * b[i]); return s; }
function vecOnes(n) { return new Array(n).fill(1n); }
function vecPow(x, n) { const r = new Array(n); let p = 1n; for (let i = 0; i < n; i++) { r[i] = p; p = modN(p * x); } return r; }
function safeMult(P, s) { const x = modN(s); return x === 0n ? ZERO : P.multiply(x); }

// Pippenger MSM (signed-digit windowed buckets).
function msm(scalars, points) {
  const N = scalars.length;
  if (N === 0) return ZERO;
  const ss = new Array(N), ps = new Array(N); let live = 0;
  for (let i = 0; i < N; i++) {
    const r = modN(scalars[i]);
    if (r === 0n) continue;
    ss[live] = r; ps[live] = points[i]; live++;
  }
  if (live === 0) return ZERO;
  ss.length = live; ps.length = live;
  const c = live <= 32 ? 3 : live <= 128 ? 4 : 5;
  const W = 1 << c;
  const HALF = W >> 1;
  const totalBits = 257;
  const numWindows = Math.ceil(totalBits / c);
  const digitsAll = new Array(live);
  for (let i = 0; i < live; i++) {
    const s = ss[i];
    const digs = new Array(numWindows);
    let carry = 0;
    for (let w = 0; w < numWindows; w++) {
      let d = Number((s >> BigInt(w * c)) & BigInt(W - 1)) + carry;
      if (d >= HALF) { d -= W; carry = 1; } else { carry = 0; }
      digs[w] = d;
    }
    digitsAll[i] = digs;
  }
  let acc = ZERO;
  const buckets = new Array(HALF + 1);
  for (let w = numWindows - 1; w >= 0; w--) {
    if (w !== numWindows - 1) {
      for (let s = 0; s < c; s++) acc = acc.double();
    }
    for (let k = 1; k <= HALF; k++) buckets[k] = ZERO;
    for (let i = 0; i < live; i++) {
      const d = digitsAll[i][w];
      if (d === 0) continue;
      if (d > 0) buckets[d] = buckets[d].add(ps[i]);
      else buckets[-d] = buckets[-d].add(ps[i].negate());
    }
    let running = buckets[HALF];
    let windowSum = running;
    for (let k = HALF - 1; k >= 1; k--) {
      running = running.add(buckets[k]);
      windowSum = windowSum.add(running);
    }
    acc = acc.add(windowSum);
  }
  return acc;
}

function _bpHashToCurve(domain, idx) {
  const idxLE = new Uint8Array(4); new DataView(idxLE.buffer).setUint32(0, idx >>> 0, true);
  for (let counter = 0; counter < 256; counter++) {
    const seed = sha256(concatBytes(new TextEncoder().encode(domain), idxLE, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), seed);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error(`bp generator failed: ${domain}#${idx}`);
}
const BP_MAX_M = 8;
const BP_MAX_NM = N_BITS * BP_MAX_M;
let _BP_GVEC = null, _BP_HVEC = null, _BP_Q = null;
function _bpGens() {
  if (_BP_GVEC) return { Gvec: _BP_GVEC, Hvec: _BP_HVEC, Q: _BP_Q };
  _BP_GVEC = []; _BP_HVEC = [];
  for (let i = 0; i < BP_MAX_NM; i++) {
    _BP_GVEC.push(_bpHashToCurve('tacit-bp-G-v1', i));
    _BP_HVEC.push(_bpHashToCurve('tacit-bp-H-v1', i));
  }
  _BP_Q = _bpHashToCurve('tacit-bp-Q-v1', 0);
  return { Gvec: _BP_GVEC, Hvec: _BP_HVEC, Q: _BP_Q };
}

function bpTranscript() {
  const parts = [];
  return {
    append(label, bytes) {
      parts.push(new TextEncoder().encode(label));
      parts.push(bytes);
    },
    challenge(label) {
      parts.push(new TextEncoder().encode(label));
      const h = sha256(concatBytes(...parts));
      parts.push(h);
      let c = modN(bytes32ToBigint(h));
      if (c === 0n) {
        const h2 = sha256(concatBytes(h, new Uint8Array([0x01])));
        c = modN(bytes32ToBigint(h2));
        if (c === 0n) throw new Error('bp transcript: 0 challenge');
      }
      return c;
    },
  };
}

function bpIpaProve(G_init, H_init, Q, a_init, b_init, transcript) {
  let G_v = G_init.slice(), H_v = H_init.slice();
  let a = a_init.slice(), b = b_init.slice();
  const Lk = [], Rk = [];
  while (a.length > 1) {
    const n = a.length / 2;
    const a_lo = a.slice(0, n), a_hi = a.slice(n);
    const b_lo = b.slice(0, n), b_hi = b.slice(n);
    const G_lo = G_v.slice(0, n), G_hi = G_v.slice(n);
    const H_lo = H_v.slice(0, n), H_hi = H_v.slice(n);
    const c_L = vecInner(a_lo, b_hi);
    const c_R = vecInner(a_hi, b_lo);
    let L = msm(a_lo, G_hi).add(msm(b_hi, H_lo)).add(safeMult(Q, c_L));
    let R = msm(a_hi, G_lo).add(msm(b_lo, H_hi)).add(safeMult(Q, c_R));
    Lk.push(L); Rk.push(R);
    transcript.append('L', pointToBytes(L));
    transcript.append('R', pointToBytes(R));
    const u = transcript.challenge('u');
    const u_inv = modInv(u);
    const G_n = new Array(n), H_n = new Array(n), a_n = new Array(n), b_n = new Array(n);
    for (let i = 0; i < n; i++) {
      G_n[i] = G_lo[i].multiply(u_inv).add(G_hi[i].multiply(u));
      H_n[i] = H_lo[i].multiply(u).add(H_hi[i].multiply(u_inv));
      a_n[i] = modN(u * a_lo[i] + u_inv * a_hi[i]);
      b_n[i] = modN(u_inv * b_lo[i] + u * b_hi[i]);
    }
    G_v = G_n; H_v = H_n; a = a_n; b = b_n;
  }
  return { L: Lk, R: Rk, a_final: a[0], b_final: b[0] };
}

function batchInv(xs) {
  const n = xs.length;
  if (n === 0) return [];
  const partial = new Array(n);
  partial[0] = modN(xs[0]);
  for (let i = 1; i < n; i++) partial[i] = modN(partial[i - 1] * xs[i]);
  let inv = modInv(partial[n - 1]);
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = i === 0 ? inv : modN(inv * partial[i - 1]);
    inv = modN(inv * xs[i]);
  }
  return out;
}

function bpIpaVerify(G_init, H_init, Q, P, ipa, transcript) {
  const k = ipa.L.length;
  const n = G_init.length;
  if (n !== (1 << k)) return false;
  const u = new Array(k);
  for (let j = 0; j < k; j++) {
    transcript.append('L', pointToBytes(ipa.L[j]));
    transcript.append('R', pointToBytes(ipa.R[j]));
    u[j] = transcript.challenge('u');
  }
  const u_inv = batchInv(u);
  const u_sq = u.map(x => modN(x * x));
  const u_inv_sq = u_inv.map(x => modN(x * x));
  const s = new Array(n);
  s[0] = u_inv.reduce((acc, v) => modN(acc * v), 1n);
  for (let i = 1; i < n; i++) {
    const lsb = i & -i;
    const j_lsb = Math.log2(lsb) | 0;
    const j = k - 1 - j_lsb;
    s[i] = modN(s[i ^ lsb] * u_sq[j]);
  }
  const s_inv = batchInv(s);
  const a = modN(ipa.a_final), b = modN(ipa.b_final);
  const scalars = [], points = [];
  scalars.push(1n); points.push(P);
  for (let j = 0; j < k; j++) {
    scalars.push(u_sq[j]);     points.push(ipa.L[j]);
    scalars.push(u_inv_sq[j]); points.push(ipa.R[j]);
  }
  for (let i = 0; i < n; i++) {
    scalars.push(modN(-a * s[i]));     points.push(G_init[i]);
    scalars.push(modN(-b * s_inv[i])); points.push(H_init[i]);
  }
  scalars.push(modN(-a * b)); points.push(Q);
  return msm(scalars, points).equals(ZERO);
}

function bpRangeAggProve(values, blindings, n_bits = N_BITS) {
  const m = values.length;
  if (m !== blindings.length) throw new Error('values/blindings length mismatch');
  if (![1, 2, 4, 8].includes(m)) throw new Error(`unsupported m=${m}`);
  const nm = n_bits * m;
  const { Gvec: Gfull, Hvec: Hfull, Q } = _bpGens();
  const Gvec = Gfull.slice(0, nm), Hvec = Hfull.slice(0, nm);
  const V_pts = [], a_L = new Array(nm);
  for (let j = 0; j < m; j++) {
    const v = BigInt(values[j]);
    if (v < 0n || v >= (1n << BigInt(n_bits))) throw new Error(`value[${j}]=${v} out of range`);
    V_pts.push(pedersenCommit(v, blindings[j]));
    for (let i = 0; i < n_bits; i++) a_L[j * n_bits + i] = (v >> BigInt(i)) & 1n;
  }
  const a_R = a_L.map(x => modN(x - 1n));
  const alpha = randomScalar();
  let A = G.multiply(alpha).add(msm(a_L, Gvec)).add(msm(a_R, Hvec));
  const s_L = new Array(nm), s_R = new Array(nm);
  for (let i = 0; i < nm; i++) { s_L[i] = randomScalar(); s_R[i] = randomScalar(); }
  const rho = randomScalar();
  let S = G.multiply(rho).add(msm(s_L, Gvec)).add(msm(s_R, Hvec));

  const transcript = bpTranscript();
  transcript.append('domain', new TextEncoder().encode('tacit-bp-v2'));
  transcript.append('n', new Uint8Array([n_bits & 0xff]));
  transcript.append('m', new Uint8Array([m & 0xff]));
  for (const V of V_pts) transcript.append('V', pointToBytes(V));
  transcript.append('A', pointToBytes(A));
  transcript.append('S', pointToBytes(S));
  const y = transcript.challenge('y');
  const z = transcript.challenge('z');
  const ones_nm = vecOnes(nm);
  const z_neg = modN(-z);
  const l_const = vecAdd(a_L, vecScalarMul(ones_nm, z_neg));
  const l_X = s_L;
  const y_nm = vecPow(y, nm);
  const r_const_part1 = vecHadamard(y_nm, vecAdd(a_R, vecScalarMul(ones_nm, z)));
  const z_sq = modN(z * z);
  const zpow_2j = new Array(m); { let p = z_sq; for (let j = 0; j < m; j++) { zpow_2j[j] = p; p = modN(p * z); } }
  const two_n = vecPow(2n, n_bits);
  const r_const_part2 = new Array(nm);
  for (let i = 0; i < nm; i++) {
    const j = (i / n_bits) | 0; const k = i % n_bits;
    r_const_part2[i] = modN(zpow_2j[j] * two_n[k]);
  }
  const r_const = vecAdd(r_const_part1, r_const_part2);
  const r_X = vecHadamard(y_nm, s_R);
  const t_1 = modN(vecInner(l_const, r_X) + vecInner(l_X, r_const));
  const t_2 = vecInner(l_X, r_X);
  const tau_1 = randomScalar();
  const tau_2 = randomScalar();
  const T_1 = safeMult(H, t_1).add(G.multiply(tau_1));
  const T_2 = safeMult(H, t_2).add(G.multiply(tau_2));
  transcript.append('T1', pointToBytes(T_1));
  transcript.append('T2', pointToBytes(T_2));
  const x = transcript.challenge('x');
  const x2 = modN(x * x);
  const l = vecAdd(l_const, vecScalarMul(l_X, x));
  const r = vecAdd(r_const, vecScalarMul(r_X, x));
  const t_hat = vecInner(l, r);
  let tau_x = modN(tau_1 * x + tau_2 * x2);
  for (let j = 0; j < m; j++) tau_x = modN(tau_x + zpow_2j[j] * modN(BigInt(blindings[j])));
  const mu = modN(alpha + rho * x);
  transcript.append('t_hat', bigintToBytes32(t_hat));
  transcript.append('tau_x', bigintToBytes32(tau_x));
  transcript.append('mu', bigintToBytes32(mu));
  const w = transcript.challenge('w');
  const y_inv = modInv(y);
  const y_inv_pow = vecPow(y_inv, nm);
  const Hprime = Hvec.map((Hi, i) => Hi.multiply(modN(y_inv_pow[i])));
  const Q_ipa = Q.multiply(w);
  const ipa = bpIpaProve(Gvec, Hprime, Q_ipa, l, r, transcript);
  const buf = [
    pointToBytes(A), pointToBytes(S), pointToBytes(T_1), pointToBytes(T_2),
    bigintToBytes32(t_hat), bigintToBytes32(tau_x), bigintToBytes32(mu),
  ];
  for (let k = 0; k < ipa.L.length; k++) { buf.push(pointToBytes(ipa.L[k])); buf.push(pointToBytes(ipa.R[k])); }
  buf.push(bigintToBytes32(ipa.a_final));
  buf.push(bigintToBytes32(ipa.b_final));
  return { proof: concatBytes(...buf), commitments: V_pts };
}

function bpRangeAggVerify(V_pts, proofBytes, n_bits = N_BITS) {
  return bpRangeAggBatchVerify([{ commitments: V_pts, proof: proofBytes }], n_bits);
}

function bpRangeAggBatchVerify(items, n_bits = N_BITS) {
  if (items.length === 0) return true;
  let maxNm = 0;
  const meta = [];
  for (const it of items) {
    const m = it.commitments.length;
    if (![1, 2, 4, 8].includes(m)) return false;
    const nm = n_bits * m;
    const log_nm = Math.log2(nm);
    if (!Number.isInteger(log_nm)) return false;
    const expectedLen = 33 * 4 + 32 * 3 + log_nm * 33 * 2 + 32 * 2;
    if (it.proof.length !== expectedLen) return false;
    if (nm > maxNm) maxNm = nm;
    meta.push({ m, nm, log_nm });
  }
  const { Gvec: Gfull, Hvec: Hfull, Q } = _bpGens();
  const Gvec = Gfull.slice(0, maxNm);
  const Hvec = Hfull.slice(0, maxNm);
  const aggG = new Array(maxNm).fill(0n);
  const aggH = new Array(maxNm).fill(0n);
  let aggQ = 0n, aggGcurve = 0n, aggHvalue = 0n;
  const extraScalars = [], extraPoints = [];

  for (let pIdx = 0; pIdx < items.length; pIdx++) {
    const it = items[pIdx];
    const { m, nm, log_nm } = meta[pIdx];
    const proofBytes = it.proof;
    const V_pts = it.commitments;
    let off = 0;
    let A, S, T_1, T_2;
    try {
      A   = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      S   = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      T_1 = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      T_2 = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
    } catch { return false; }
    const t_hat = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const tau_x = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const mu    = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const Lk = [], Rk = [];
    try {
      for (let k = 0; k < log_nm; k++) {
        Lk.push(bytesToPoint(proofBytes.slice(off, off + 33))); off += 33;
        Rk.push(bytesToPoint(proofBytes.slice(off, off + 33))); off += 33;
      }
    } catch { return false; }
    const a_final = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const b_final = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;

    const transcript = bpTranscript();
    transcript.append('domain', new TextEncoder().encode('tacit-bp-v2'));
    transcript.append('n', new Uint8Array([n_bits & 0xff]));
    transcript.append('m', new Uint8Array([m & 0xff]));
    for (const V of V_pts) transcript.append('V', pointToBytes(V));
    transcript.append('A', pointToBytes(A));
    transcript.append('S', pointToBytes(S));
    const y = transcript.challenge('y');
    const z = transcript.challenge('z');
    transcript.append('T1', pointToBytes(T_1));
    transcript.append('T2', pointToBytes(T_2));
    const x = transcript.challenge('x');
    transcript.append('t_hat', bigintToBytes32(t_hat));
    transcript.append('tau_x', bigintToBytes32(tau_x));
    transcript.append('mu', bigintToBytes32(mu));
    const w = transcript.challenge('w');
    const u = new Array(log_nm);
    for (let j = 0; j < log_nm; j++) {
      transcript.append('L', pointToBytes(Lk[j]));
      transcript.append('R', pointToBytes(Rk[j]));
      u[j] = transcript.challenge('u');
    }
    const u_inv = batchInv(u);
    const u_sq = u.map(uu => modN(uu * uu));
    const u_inv_sq = u_inv.map(uu => modN(uu * uu));

    const s = new Array(nm);
    s[0] = u_inv.reduce((acc, v) => modN(acc * v), 1n);
    for (let i = 1; i < nm; i++) {
      const lsb = i & -i;
      const j_lsb = Math.log2(lsb) | 0;
      const j = log_nm - 1 - j_lsb;
      s[i] = modN(s[i ^ lsb] * u_sq[j]);
    }
    const s_inv = batchInv(s);

    const ones_nm = vecOnes(nm);
    const y_nm = vecPow(y, nm);
    const sum_y_nm = vecInner(ones_nm, y_nm);
    const sum_two_n = (1n << BigInt(n_bits)) - 1n;
    const z_sq = modN(z * z);
    const z_minus_z2 = modN(z - z_sq);
    let zp = modN(z_sq * z);
    let delta = modN(z_minus_z2 * sum_y_nm);
    for (let j = 0; j < m; j++) {
      delta = modN(delta - zp * sum_two_n);
      zp = modN(zp * z);
    }
    const y_inv = modInv(y);
    const y_inv_pow = vecPow(y_inv, nm);
    const zpow_2j = new Array(m); { let p = z_sq; for (let j = 0; j < m; j++) { zpow_2j[j] = p; p = modN(p * z); } }
    const two_n = vecPow(2n, n_bits);

    const alpha = randomScalar();
    const beta  = randomScalar();
    const x2 = modN(x * x);

    aggHvalue = modN(aggHvalue + alpha * modN(t_hat - delta));
    aggGcurve = modN(aggGcurve + alpha * tau_x);
    extraScalars.push(modN(-alpha * x));    extraPoints.push(T_1);
    extraScalars.push(modN(-alpha * x2));   extraPoints.push(T_2);
    let zj = z_sq;
    for (let j = 0; j < m; j++) {
      extraScalars.push(modN(-alpha * zj));
      extraPoints.push(V_pts[j]);
      zj = modN(zj * z);
    }

    extraScalars.push(beta);             extraPoints.push(A);
    extraScalars.push(modN(beta * x));   extraPoints.push(S);
    aggGcurve = modN(aggGcurve + beta * modN(-mu));
    aggQ = modN(aggQ + beta * modN(w * modN(t_hat - a_final * b_final)));
    for (let k = 0; k < log_nm; k++) {
      extraScalars.push(modN(beta * u_sq[k]));     extraPoints.push(Lk[k]);
      extraScalars.push(modN(beta * u_inv_sq[k])); extraPoints.push(Rk[k]);
    }
    const minus_z = modN(-z);
    for (let i = 0; i < nm; i++) {
      const j = (i / n_bits) | 0; const k = i % n_bits;
      const s_G_i = minus_z;
      const s_H_i = modN(z + modN(zpow_2j[j] * two_n[k]) * y_inv_pow[i]);
      const G_total = modN(s_G_i - a_final * s[i]);
      const H_total = modN(s_H_i - b_final * modN(s_inv[i] * y_inv_pow[i]));
      aggG[i] = modN(aggG[i] + beta * G_total);
      aggH[i] = modN(aggH[i] + beta * H_total);
    }
  }

  const allScalars = [...aggG, ...aggH, aggQ, aggGcurve, aggHvalue, ...extraScalars];
  const allPoints  = [...Gvec, ...Hvec, Q, G, H, ...extraPoints];
  return msm(allScalars, allPoints).equals(ZERO);
}

// Re-exports for the test + bench harnesses.
export {
  // Crypto context
  G, H, ZERO, SECP_N, N_BITS,
  modN, pedersenCommit, pointToBytes, bytesToPoint, bigintToBytes32, bytes32ToBigint,
  randomScalar,
  // Bulletproofs
  bpRangeAggProve, bpRangeAggVerify, bpRangeAggBatchVerify,
  _bpGens,
};
