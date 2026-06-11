// ============================================================================
// dapp/bulletproofs-plus.js
// ============================================================================
//
// Bulletproofs+ aggregated range proof on secp256k1.
//
// This file is a hand-port of Monero's `src/ringct/bulletproofs_plus.cc`
// (BSD-3, retained at .local/monero-bpp-ref/ for cross-checking against
// the C++ algorithm), with the following adaptations:
//
//   1. Curve substitution: ed25519 → secp256k1.
//      → All `INV_EIGHT` / `MINUS_INV_EIGHT` multiplications are OMITTED.
//      → All `scalarmult8` calls in the verifier are OMITTED.
//      → secp256k1 has cofactor=1; no subgroup-handling tricks needed.
//      → This is the single most dangerous porting trap. Every place
//        Monero multiplies a scalar by 8^-1 before placing it in a
//        multiexp datum, this port uses the bare scalar.
//
//   2. Hash substitution: Keccak (cn_fast_hash) → SHA-256.
//      → Internal-only choice; prover and verifier agree.
//      → Means proof bytes are NOT compatible with Monero's BP+ —
//        this is intentional. tacit's BP+ is a parallel ZK protocol
//        with the same algorithmic structure but tacit's hash conventions.
//
//   3. Generator reuse per SPEC-CXFER-BPP-AMENDMENT §5.47.4:
//      → G_vec[i] = same construction as standard BP: try-and-increment
//        under domain tag "tacit-bp-G-v1" + 4-byte LE index. Reuses
//        SPEC.md §3.1 generators.
//      → H_vec[i] = same, with "tacit-bp-H-v1".
//      → G = secp256k1 base point.
//      → H = NUMS via "tacit-generator-H-v1".
//      → No `Q` generator (Monero's BP+ doesn't use one).
//
//   4. Transcript shape: tacit's existing length-prefixed Merlin-style
//      transcript (matches dapp/tacit.js bpTranscript), with BP+-specific
//      domain label "tacit-bpp-v1".
//
// ROLLOUT POSTURE.
//   - Mainnet: default OFF via `bppEnabled()` in dapp/tacit.js. Opt-in
//     per-client via localStorage['tacit-bpp-enable-mainnet-v1'] = '1'.
//   - Signet: default ON so signet exercises the proof system end-to-end
//     in production paths before mainnet activation.
//   - Validation chain: tests/bulletproofs-plus-prover-smoke.test.mjs
//     (KAT vs SPEC §3.1 pinned hex) + tests/bulletproofs-plus-roundtrip
//     (prove/verify self-consistency) + tests/bulletproofs-plus-adversarial
//     (bit-flip survey across every structural field, commitment swap,
//     cross-proof substitution, aggregation-factor mismatch, length
//     tamper) + tests/cxfer-bpp-wire (envelope encode/decode parity with
//     CXFER except opcode + rangeproof bytes) + tests/cxfer-bpp-integration
//     (real BP+ proofs flowing through the full envelope wrap pipeline +
//     kernel-sig parity under "tacit-kernel-v1").
//
// SOURCES:
//   - Bulletproofs+ paper: Chung, Han, Lai, Maller, Mohnblatt, Sarkar,
//     Sharma (2020). https://eprint.iacr.org/2020/735
//   - Monero reference: monero-project/monero
//     src/ringct/bulletproofs_plus.{cc,h}
//     (cached locally at .local/monero-bpp-ref/ at port time)
//   - Existing tacit BP: dapp/tacit.js lines ~4030–4750
//     (algorithmic conventions, transcript format, generator domain tags
//     all match — see amendment §5.47.4 for the reuse justification)
//
// ============================================================================

import { secp, sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

// ---- Constants (match existing tacit conventions) -----------------------

export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const N_BITS = 64;                  // range = [0, 2^N_BITS)
export const BPP_MAX_M = 8;                // m ∈ {1, 2, 4, 8}
export const BPP_MAX_NM = N_BITS * BPP_MAX_M;  // 512 — matches §3.1 generator vector size

// BP+ domain separator. Distinct from "tacit-bp-v1" used by standard
// Bulletproofs so the two proof systems' transcripts cannot collide.
const BPP_DOMAIN = 'tacit-bpp-v1';

// ---- Scalar arithmetic --------------------------------------------------

export function modN(x) { return ((x % SECP_N) + SECP_N) % SECP_N; }

// Fermat's little theorem: x^(n-2) mod n. modInv(0) is undefined.
export function modInv(a) {
  let x = modN(a);
  if (x === 0n) throw new Error('bpp: modInv(0)');
  let result = 1n, base = x, exp = SECP_N - 2n;
  while (exp > 0n) {
    if (exp & 1n) result = modN(result * base);
    base = modN(base * base);
    exp >>= 1n;
  }
  return result;
}

// Montgomery's batch inverse trick: 1 inversion + 3n multiplications.
export function batchInv(xs) {
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

export function randomScalar() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('bpp: CSPRNG unavailable');
  for (let attempt = 0; attempt < 32; attempt++) {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const s = bytes32ToBigint(b);
    if (s !== 0n && s < SECP_N) return s;
  }
  throw new Error('bpp: failed to draw a random scalar');
}

export function bytes32ToBigint(b) {
  let r = 0n;
  for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}

export function bigintToBytes32(n) {
  const m = modN(n);
  return hexToBytes(m.toString(16).padStart(64, '0'));
}

// ---- Point arithmetic (secp256k1 via @noble) ----------------------------

export const G = secp.ProjectivePoint.BASE;
export const ZERO = secp.ProjectivePoint.ZERO;

export function pointToBytes(P) { return P.toRawBytes(true); }
export function bytesToPoint(b) { return secp.ProjectivePoint.fromHex(bytesToHex(b)); }

// safeMult avoids @noble throwing on zero-scalar multiplication.
export function safeMult(P, s) {
  const x = modN(s);
  return x === 0n ? ZERO : P.multiply(x);
}

// Multi-scalar multiplication: Σ s_i · P_i via windowed Pippenger.
//
// The result is mathematically identical to the naïve `Σ s_i · P_i` loop —
// both produce the same secp256k1 point. Pippenger reorders the work to
// cut total point operations from O(n · log(n_scalar_bits)) doublings down
// to O(n + 2^c · log(n_scalar_bits) / c) by binning each scalar's c-bit
// windows into shared buckets that get added once per bucket, not once per
// scalar bit. Window size c ≈ log2(active_n) is the empirical sweet spot.
//
// For BP+ at typical vector sizes (n = 128–512), Pippenger is ~5–20×
// faster than the naïve loop. Output is byte-identical when serialized via
// `pointToBytes`. Not consensus-relevant; just a hot-path speedup for
// prove + verify.
//
// Algorithm (textbook Pippenger, e.g. Bernstein/Doche/Lange survey):
//   1. Pick c such that the number of windows numWindows ≈ ceil(256/c).
//   2. For each window w (from MSB to LSB):
//      a. Double the running accumulator c times to shift it left one window.
//      b. Bin each point into a bucket indexed by its c-bit window value:
//         buckets[v] += points[i] when scalar[i]'s window-w value == v.
//      c. Sum buckets weighted by index: Σ_v v · buckets[v]. Computed in
//         linear time via running-sum trick (Σ from B-1 down to 1).
//      d. Add weighted sum to accumulator.
//
// Small-n fast path: setup cost (allocating buckets, BigInt shifts)
// dominates Pippenger's savings below a handful of nonzero scalars, so fall
// through to the naïve loop in that regime.

function _msmWindowSize(activeCount) {
  if (activeCount < 32)   return 3;
  if (activeCount < 128)  return 4;
  if (activeCount < 1024) return 5;
  return 6;
}

export function msm(scalars, points) {
  if (scalars.length !== points.length) throw new Error('bpp: msm length mismatch');
  const n = scalars.length;
  if (n === 0) return ZERO;

  // Reduce scalars once; track which entries are nonzero so the bucket pass
  // can skip zero-scalar slots without re-reducing.
  const reduced = new Array(n);
  let activeCount = 0;
  for (let i = 0; i < n; i++) {
    const s = modN(scalars[i]);
    reduced[i] = s;
    if (s !== 0n) activeCount++;
  }
  if (activeCount === 0) return ZERO;

  // Tiny n: naïve loop is competitive and avoids Pippenger's setup cost.
  if (activeCount <= 4) {
    let acc = ZERO;
    for (let i = 0; i < n; i++) {
      if (reduced[i] !== 0n) acc = acc.add(points[i].multiply(reduced[i]));
    }
    return acc;
  }

  const c = _msmWindowSize(activeCount);
  const numBuckets = 1 << c;
  const numWindows = Math.ceil(256 / c);
  const cBig = BigInt(c);
  const mask = (1n << cBig) - 1n;

  let acc = ZERO;
  for (let w = numWindows - 1; w >= 0; w--) {
    // Shift acc left by one window (= c doublings). Skip on the first
    // iteration because acc is ZERO.
    if (w !== numWindows - 1) {
      for (let d = 0; d < c; d++) acc = acc.add(acc);
    }

    // Bin points by their c-bit window value.
    const buckets = new Array(numBuckets);
    for (let b = 0; b < numBuckets; b++) buckets[b] = ZERO;

    const shift = BigInt(w * c);
    for (let i = 0; i < n; i++) {
      const s = reduced[i];
      if (s === 0n) continue;
      const v = Number((s >> shift) & mask);
      if (v === 0) continue;
      buckets[v] = buckets[v].add(points[i]);
    }

    // Σ_v v · buckets[v] via running sum: starting from bucket B-1 and
    // sweeping down, runningSum accumulates buckets and windowTotal
    // accumulates runningSums — windowTotal ends up equal to the
    // index-weighted sum without any explicit multiplications.
    let runningSum = ZERO;
    let windowTotal = ZERO;
    for (let b = numBuckets - 1; b >= 1; b--) {
      runningSum = runningSum.add(buckets[b]);
      windowTotal = windowTotal.add(runningSum);
    }

    acc = acc.add(windowTotal);
  }

  return acc;
}

// ---- Vector helpers -----------------------------------------------------

export function vecAdd(a, b) {
  if (a.length !== b.length) throw new Error('bpp: vecAdd length mismatch');
  const r = new Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = modN(a[i] + b[i]);
  return r;
}

export function vecSub(a, b) {
  if (a.length !== b.length) throw new Error('bpp: vecSub length mismatch');
  const r = new Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = modN(a[i] - b[i]);
  return r;
}

export function vecScalarMul(v, s) {
  const r = new Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = modN(v[i] * s);
  return r;
}

export function vecScalarAdd(v, s) {
  const r = new Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = modN(v[i] + s);
  return r;
}

export function vecScalarSub(v, s) {
  const r = new Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = modN(v[i] - s);
  return r;
}

export function vecHadamard(a, b) {
  if (a.length !== b.length) throw new Error('bpp: vecHadamard length mismatch');
  const r = new Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = modN(a[i] * b[i]);
  return r;
}

export function vecPow(x, n) {
  const r = new Array(n);
  let p = 1n;
  for (let i = 0; i < n; i++) { r[i] = p; p = modN(p * x); }
  return r;
}

export function vecOnes(n) { return new Array(n).fill(1n); }

// Weighted inner product: Σ_{i=0..n-1} a_i · b_i · y^(i+1).
// This is the BP+ core (replaces the standard <a,b> inner product).
// Reference: Monero `weighted_inner_product` at .local/monero-bpp-ref/
// bulletproofs_plus.cc:299–315.
export function weightedInnerProduct(a, b, y) {
  if (a.length !== b.length) throw new Error('bpp: weightedInnerProduct length mismatch');
  let res = 0n;
  let yPower = 1n;
  for (let i = 0; i < a.length; i++) {
    yPower = modN(yPower * y);  // y^(i+1) — note: starts at y^1, not y^0
    res = modN(res + modN(a[i] * b[i]) * yPower);
  }
  return res;
}

// Hadamard-fold a point vector: replaces v[i] with a·v[i] + b·v[i+sz/2].
// Reference: Monero `hadamard_fold` at bulletproofs_plus.cc:324–336.
export function hadamardFold(v, a, b) {
  if ((v.length & 1) !== 0) throw new Error('bpp: hadamardFold needs even-length vector');
  const sz = v.length / 2;
  const out = new Array(sz);
  for (let i = 0; i < sz; i++) {
    out[i] = v[i].multiply(modN(a)).add(v[sz + i].multiply(modN(b)));
  }
  return out;
}

// ---- Generator vectors (reused from SPEC §3.1, amendment §5.47.4) -------

// Try-and-increment hash-to-curve for secp256k1. MUST match dapp/tacit.js's
// `_bpHashToCurve` byte-for-byte so the generators reused per amendment
// §5.47.4 produce the exact pinned hex from SPEC §3.1. The derivation hashes
// (domain || idx_LE || counter) in a single SHA-256, takes the result as
// the x-coordinate with 0x02 prefix (even Y), and increments the counter
// until a valid curve point lands.
function _hashToCurveSecp(domain, idx) {
  const domainBytes = new TextEncoder().encode(domain);
  const idxLE = new Uint8Array(4);
  new DataView(idxLE.buffer).setUint32(0, idx >>> 0, true);
  for (let counter = 0; counter < 256; counter++) {
    const seed = sha256(concatBytes(domainBytes, idxLE, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), seed);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(ZERO)) return p;
    } catch {}
  }
  throw new Error(`bpp: _hashToCurveSecp(${domain}, ${idx}) failed`);
}

let _BPP_GVEC = null, _BPP_HVEC = null, _BPP_H = null;
export function bppGens() {
  if (_BPP_GVEC) return { Gvec: _BPP_GVEC, Hvec: _BPP_HVEC, H: _BPP_H };
  const gv = [], hv = [];
  for (let i = 0; i < BPP_MAX_NM; i++) {
    gv.push(_hashToCurveSecp('tacit-bp-G-v1', i));
    hv.push(_hashToCurveSecp('tacit-bp-H-v1', i));
  }
  let H = null;
  const hSeed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(hSeed, new Uint8Array([counter])));
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(concatBytes(new Uint8Array([0x02]), x)));
      if (!p.equals(ZERO)) { H = p; break; }
    } catch {}
  }
  if (!H) throw new Error('bpp: failed to derive H');
  _BPP_GVEC = Object.freeze(gv);
  _BPP_HVEC = Object.freeze(hv);
  _BPP_H = H;
  return { Gvec: _BPP_GVEC, Hvec: _BPP_HVEC, H: _BPP_H };
}

// Pedersen commitment: C = v·H + γ·G.
// Same scheme as standard BP (the amendment requires commitment-format parity).
export function pedersenCommit(v, gamma) {
  const { H } = bppGens();
  return safeMult(H, BigInt(v)).add(safeMult(G, BigInt(gamma)));
}

// ---- Transcript ---------------------------------------------------------

// Length-prefixed Fiat-Shamir transcript. Mirrors dapp/tacit.js bpTranscript
// but with the BP+ domain label baked in by convention (caller still calls
// append('domain', ...) at the start).
export function bppTranscript() {
  const parts = [];
  const _u32 = n => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  };
  const _push = (labelBytes, dataBytes) => {
    parts.push(_u32(labelBytes.length));
    parts.push(labelBytes);
    parts.push(_u32(dataBytes.length));
    parts.push(dataBytes);
  };
  return {
    append(label, bytes) {
      _push(new TextEncoder().encode(label), bytes);
    },
    challenge(label) {
      const labelBytes = new TextEncoder().encode(label);
      parts.push(_u32(labelBytes.length));
      parts.push(labelBytes);
      const h = sha256(concatBytes(...parts));
      parts.push(_u32(h.length));
      parts.push(h);
      let c = modN(bytes32ToBigint(h));
      if (c === 0n) {
        // Vanishingly unlikely; rehash with a tag to avoid 0 challenges
        // which break the inverse paths in the WIPA fold.
        const h2 = sha256(concatBytes(h, new Uint8Array([0x01])));
        c = modN(bytes32ToBigint(h2));
        if (c === 0n) throw new Error('bpp transcript: 0 challenge');
      }
      return c;
    },
  };
}

// ============================================================================
// Bulletproofs+ aggregated range proof
// ============================================================================
//
// Prover input:
//   values:    array of m bigints, each in [0, 2^N_BITS)
//   blindings: array of m bigints (Pedersen blinding factors γ_j)
//   m ∈ {1, 2, 4, 8}
//
// Prover output:
//   { proof: Uint8Array, commitments: Point[] }
//
// Proof wire layout (port note: matches Monero's BulletproofPlus struct
// but with bare scalars — no INV_EIGHT preprocessing):
//
//   A      (33 B)                   — initial commit to aL/aR
//   A1     (33 B)                   — final-round commit
//   B      (33 B)                   — final-round mask commit
//   r1     (32 B)                   — final scalar
//   s1     (32 B)                   — final scalar
//   d1     (32 B)                   — final scalar (folds blindings)
//   L_k    (33 B) × logMN rounds
//   R_k    (33 B) × logMN rounds
//
// Total: 99 + 96 + logMN·66 bytes.
//   m=1 → logMN=6 → 591 B
//   m=2 → logMN=7 → 657 B
//   m=4 → logMN=8 → 723 B
//   m=8 → logMN=9 → 789 B
//
// (Compare standard BP: 754/820/886 at the same m. BP+ saves ~97 B per proof.)
//
// Algorithm: Chung et al. 2020 §4.4, ported from Monero
// bulletproofs_plus.cc:502–776 (function bulletproof_plus_PROVE).
// ============================================================================

// `_allowOutOfRangeForTest` is a TEST-ONLY escape hatch: it skips the [0,2^64) input guard so a
// soundness test can forge a proof that commits an out-of-range value (V = v·H, with the bit
// decomposition of v mod 2^64) and assert the VERIFIER rejects it. Production callers never set it.
export function bppRangeProve(values, blindings, _allowOutOfRangeForTest = false) {
  const m = values.length;
  if (m !== blindings.length) throw new Error('bpp: values/blindings length mismatch');
  if (![1, 2, 4, 8].includes(m)) throw new Error(`bpp: unsupported aggregation m=${m}`);

  const logN = 6;                   // log2(64)
  const N = N_BITS;                 // 64
  const logM = Math.log2(m) | 0;
  const logMN = logM + logN;
  const MN = m * N;

  const { Gvec: GvecFull, Hvec: HvecFull, H } = bppGens();
  const Gvec = GvecFull.slice(0, MN);
  const Hvec = HvecFull.slice(0, MN);

  // ---- Commitments V_j = v_j·H + γ_j·G (no INV_EIGHT — secp256k1) -------
  const V = new Array(m);
  for (let j = 0; j < m; j++) {
    if (typeof values[j] !== 'bigint') throw new Error(`bpp: values[${j}] must be bigint`);
    const v = values[j];
    if (!_allowOutOfRangeForTest && (v < 0n || v >= (1n << BigInt(N)))) {
      throw new Error(`bpp: value[${j}]=${v} out of range [0, 2^${N})`);
    }
    V[j] = pedersenCommit(v, blindings[j]);
  }

  // ---- Bit decomposition: aL[j*N+i] = i-th bit of v_j ; aR = aL - 1 -----
  // Note we do NOT compute aL8/aR8 (Monero's INV_EIGHT pre-scaling) since
  // secp256k1 has cofactor=1.
  const aL = new Array(MN);
  const aR = new Array(MN);
  for (let j = 0; j < m; j++) {
    const v = j < values.length ? values[j] : 0n;
    for (let i = 0; i < N; i++) {
      const bit = (v >> BigInt(i)) & 1n;
      aL[j * N + i] = bit;
      aR[j * N + i] = modN(bit - 1n);
    }
  }

  // ---- Try-again loop for zero challenges (vanishingly rare) ------------
  // Cap retries to avoid infinite loops on broken randomness.
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return _bppRangeProveAttempt({ m, MN, logMN, Gvec, Hvec, H, V, aL, aR, blindings });
    } catch (e) {
      if (e?.message?.includes('zero challenge')) continue;  // retry
      throw e;
    }
  }
  throw new Error('bpp: 16 retries exhausted (broken randomness?)');
}

function _bppRangeProveAttempt({ m, MN, logMN, Gvec, Hvec, H, V, aL, aR, blindings }) {
  // ---- Transcript init: domain + V commitments -------------------------
  const transcript = bppTranscript();
  transcript.append('domain', new TextEncoder().encode(BPP_DOMAIN));
  transcript.append('M', new Uint8Array([m & 0xff]));
  for (const Vj of V) transcript.append('V', pointToBytes(Vj));

  // ---- A = aL·Gvec + aR·Hvec + α·G  (no INV_EIGHT) --------------------
  const alpha = randomScalar();
  let A = msm(aL, Gvec).add(msm(aR, Hvec)).add(safeMult(G, alpha));
  transcript.append('A', pointToBytes(A));

  // ---- y, z challenges -------------------------------------------------
  const y = transcript.challenge('y');
  if (y === 0n) throw new Error('bpp: zero challenge (y)');
  const z = transcript.challenge('z');
  if (z === 0n) throw new Error('bpp: zero challenge (z)');
  const zSq = modN(z * z);

  // ---- d[j*N+i] = z^(2(j+1)) · 2^i  (windowed) -------------------------
  const d = new Array(MN).fill(0n);
  d[0] = zSq;
  for (let i = 1; i < N_BITS; i++) d[i] = modN(d[i - 1] * 2n);
  for (let j = 1; j < m; j++) {
    for (let i = 0; i < N_BITS; i++) {
      d[j * N_BITS + i] = modN(d[(j - 1) * N_BITS + i] * zSq);
    }
  }

  // ---- y_powers[0..MN+1] -----------------------------------------------
  // Need y^0 through y^(MN+1) for d_y construction (uses y^(MN-i) for i ∈ [0,MN])
  // and for alpha1 (uses y^(MN+1)).
  const yPowers = vecPow(y, MN + 2);

  // ---- aL1 = aL - z; aR1 = aR + z + d·y^(MN-i) -------------------------
  const aL1 = vecScalarSub(aL, z);
  const aR_plus_z = vecScalarAdd(aR, z);
  const d_y = new Array(MN);
  for (let i = 0; i < MN; i++) {
    d_y[i] = modN(d[i] * yPowers[MN - i]);
  }
  const aR1 = vecAdd(aR_plus_z, d_y);

  // ---- alpha1 = alpha + Σ_j z^(2(j+1)) · y^(MN+1) · γ_j ----------------
  let alpha1 = alpha;
  let zp = zSq;  // starts at z^2 (which is z^(2*1) for j=0)
  const yMN1 = yPowers[MN + 1];
  for (let j = 0; j < m; j++) {
    const term = modN(modN(zp * yMN1) * modN(BigInt(blindings[j])));
    alpha1 = modN(alpha1 + term);
    zp = modN(zp * zSq);  // z^(2*(j+2)) for next iter
  }

  // ---- Inner-product rounds (WIPA) -------------------------------------
  // The WIPA differs from standard IPA by the y-weighting. Specifically the
  // L, R commitments fold with y^(nprime) weighting on aprime[hi], and the
  // aprime fold uses y^(nprime)·u^(-1) for the high half.
  //
  // Reference: bulletproofs_plus.cc:676–714.
  let Gprime = Gvec.slice();
  let Hprime = Hvec.slice();
  let aprime = aL1.slice();
  let bprime = aR1.slice();
  let nprime = MN;

  const yInv = modInv(y);
  // Precompute y^-i for i ∈ [0, MN). Used by the L's G-side weighting.
  const yInvPow = new Array(MN);
  yInvPow[0] = 1n;
  for (let i = 1; i < MN; i++) yInvPow[i] = modN(yInvPow[i - 1] * yInv);

  const Lvec = new Array(logMN);
  const Rvec = new Array(logMN);

  for (let round = 0; round < logMN; round++) {
    nprime /= 2;

    // cL = <aprime[lo], bprime[hi]>_y  (weighted inner product)
    const aprimeLo = aprime.slice(0, nprime);
    const aprimeHi = aprime.slice(nprime);
    const bprimeLo = bprime.slice(0, nprime);
    const bprimeHi = bprime.slice(nprime);
    const cL = weightedInnerProduct(aprimeLo, bprimeHi, y);

    // cR = <y^nprime · aprime[hi], bprime[lo]>_y
    const aprimeHiScaled = vecScalarMul(aprimeHi, yPowers[nprime]);
    const cR = weightedInnerProduct(aprimeHiScaled, bprimeLo, y);

    // Random blindings for L, R
    const dL = randomScalar();
    const dR = randomScalar();

    // L = aprime[lo]·y^-nprime·Gprime[hi] + bprime[hi]·Hprime[lo] + cL·H + dL·G
    // Per Monero compute_LR (bulletproofs_plus.cc:184–216), but without INV_EIGHT.
    // The y^-nprime factor on Gprime[hi] is what makes this WIPA (weighted IPA).
    const GprimeHi = Gprime.slice(nprime);
    const HprimeLo = Hprime.slice(0, nprime);
    const GprimeLo = Gprime.slice(0, nprime);
    const HprimeHi = Hprime.slice(nprime);
    const yInvNp = yInvPow[nprime];
    const aprimeLo_weighted = vecScalarMul(aprimeLo, yInvNp);
    const L_pt = msm(aprimeLo_weighted, GprimeHi)
      .add(msm(bprimeHi, HprimeLo))
      .add(safeMult(H, cL))
      .add(safeMult(G, dL));

    // R = aprime[hi]·y^nprime·Gprime[lo] + bprime[lo]·Hprime[hi] + cR·H + dR·G
    const aprimeHi_weighted = vecScalarMul(aprimeHi, yPowers[nprime]);
    const R_pt = msm(aprimeHi_weighted, GprimeLo)
      .add(msm(bprimeLo, HprimeHi))
      .add(safeMult(H, cR))
      .add(safeMult(G, dR));

    Lvec[round] = L_pt;
    Rvec[round] = R_pt;

    transcript.append('L', pointToBytes(L_pt));
    transcript.append('R', pointToBytes(R_pt));
    const u = transcript.challenge('u');
    if (u === 0n) throw new Error('bpp: zero challenge (u)');
    const uInv = modInv(u);

    // Fold Gprime, Hprime, aprime, bprime per BP+ scheme.
    // Reference: bulletproofs_plus.cc:698–704.
    // Gprime[i] = u^-1·Gprime[lo][i] + (y^-nprime·u)·Gprime[hi][i]
    const factorGhi = modN(yInvNp * u);
    Gprime = hadamardFold(Gprime, uInv, factorGhi);
    // Hprime[i] = u·Hprime[lo][i] + u^-1·Hprime[hi][i]
    Hprime = hadamardFold(Hprime, u, uInv);
    // aprime[i] = u·aprime[lo][i] + (u^-1·y^nprime)·aprime[hi][i]
    const factorAhi = modN(uInv * yPowers[nprime]);
    aprime = vecAdd(vecScalarMul(aprimeLo, u), vecScalarMul(aprimeHi, factorAhi));
    // bprime[i] = u^-1·bprime[lo][i] + u·bprime[hi][i]
    bprime = vecAdd(vecScalarMul(bprimeLo, uInv), vecScalarMul(bprimeHi, u));

    // alpha1 += dL·u^2 + dR·u^-2
    const uSq = modN(u * u);
    const uInvSq = modN(uInv * uInv);
    alpha1 = modN(alpha1 + modN(dL * uSq) + modN(dR * uInvSq));
  }

  // ---- Final round: r, s, d_, eta randoms ------------------------------
  // aprime[0], bprime[0] are now the collapsed scalars. Gprime[0], Hprime[0]
  // are the collapsed generators.
  const r = randomScalar();
  const s = randomScalar();
  const d_ = randomScalar();
  const eta = randomScalar();

  // A1 = r·Gprime[0] + s·Hprime[0] + d_·G + (r·y·bprime[0] + s·y·aprime[0])·H
  // Reference: bulletproofs_plus.cc:722–747.
  const ry_bprime = modN(modN(r * y) * bprime[0]);
  const sy_aprime = modN(modN(s * y) * aprime[0]);
  const A1_H_scalar = modN(ry_bprime + sy_aprime);
  const A1 = Gprime[0].multiply(modN(r))
    .add(Hprime[0].multiply(modN(s)))
    .add(safeMult(G, d_))
    .add(safeMult(H, A1_H_scalar));

  // B = eta·G + r·y·s·H
  // Reference: bulletproofs_plus.cc:749–754.
  const rys = modN(modN(r * y) * s);
  const B = safeMult(G, eta).add(safeMult(H, rys));

  transcript.append('A1', pointToBytes(A1));
  transcript.append('B', pointToBytes(B));
  const e = transcript.challenge('e');
  if (e === 0n) throw new Error('bpp: zero challenge (e)');
  const eSq = modN(e * e);

  // ---- Final scalars ---------------------------------------------------
  // r1 = aprime[0]·e + r
  // s1 = bprime[0]·e + s
  // d1 = d_·e + eta + alpha1·e^2
  const r1 = modN(modN(aprime[0] * e) + r);
  const s1 = modN(modN(bprime[0] * e) + s);
  const d1 = modN(modN(d_ * e) + eta + modN(alpha1 * eSq));

  // ---- Serialize proof -------------------------------------------------
  const parts = [
    pointToBytes(A),
    pointToBytes(A1),
    pointToBytes(B),
    bigintToBytes32(r1),
    bigintToBytes32(s1),
    bigintToBytes32(d1),
  ];
  for (let k = 0; k < logMN; k++) {
    parts.push(pointToBytes(Lvec[k]));
    parts.push(pointToBytes(Rvec[k]));
  }
  return { proof: concatBytes(...parts), commitments: V };
}

// ============================================================================
// Bulletproofs+ aggregated range proof verifier
// ============================================================================
//
// Strategy: build a single multi-scalar multiplication that must equal the
// identity element when the proof is valid. All terms accumulate into one
// MSM check.
//
// Algorithm reference: Monero bulletproofs_plus.cc:799–1104.
// Port adaptations vs Monero:
//   1. Skip `scalarmult8` on proof points (secp256k1 cofactor=1).
//   2. SHA-256 transcript instead of Keccak.
//   3. Reuse our bppGens() generators.
//   4. Single-proof verify uses weight=1 (no batch combination needed).
//      The Monero verifier always batches, but for single-proof verify
//      that random weight is unnecessary and only adds entropy concerns.
//
// MSM equation (single proof, weight = 1):
//   identity =
//       G · d1
//     + H · (r1·y·s1 + e²·((z²-z)·sum(y_MN) + y^(MN+1)·z·sum(d)))
//     + Σ_i Gvec[i] · (e·r1·s_i + e²·z)
//     + Σ_i Hvec[i] · (e·s1·s_i_rev - e²·z - e²·y^(MN-i)·d[i])
//     + Σ_j V[j] · (-e²·z^(2(j+1))·y^(MN+1))
//     + A · (-e²)
//     + A1 · (-e)
//     + B · (-1)
//     + Σ_k L[k] · (-e²·u_k²)
//     + Σ_k R[k] · (-e²·u_k⁻²)
//
//   where:
//     s_i        = y^(-i) · challenges_cache[i]
//     s_i_rev    = challenges_cache[(MN-1) XOR i]
//     d[j*N+i]   = z^(2(j+1)) · 2^i
//     sum(d)     = (2^N - 1) · Σ_{j=1..M} z^(2j)
//     sum(y_MN)  = y + y² + ... + y^MN
//
// Returns true iff the proof verifies. No exceptions on invalid proofs —
// returns false. Exceptions reserved for malformed proof bytes (wrong length,
// off-curve points) since those represent caller bugs, not verifier rejection.
// ============================================================================

// Σ_{i=1..n} x^i where n is a power of 2. Mirrors Monero's
// sum_of_scalar_powers (bulletproofs_plus.cc:262–297), specialized to
// the power-of-2 case which is all we use.
function _sumOfScalarPowers(x, n) {
  if (n === 0) throw new Error('bpp: sum_of_scalar_powers needs n > 0');
  if (n === 1) return modN(x);
  // For n+1 being power of 2 case, Monero has an optimization. For our use
  // n = MN ∈ {64, 128, 256, 512}, n+1 is NOT power of 2, so use the general loop.
  // Compute Σ_{i=1..n} x^i = x · (x^n - 1) / (x - 1).
  // To avoid division, we do the loop:
  //   res = 0
  //   xpow = 1
  //   for i in 1..n: xpow *= x; res += xpow
  let res = 0n;
  let xpow = 1n;
  for (let i = 1; i <= n; i++) {
    xpow = modN(xpow * x);
    res = modN(res + xpow);
  }
  return res;
}

// Even-power sum: x² + x⁴ + ... + x^n (n/2 terms, n must be a power of 2 ≥ 2).
// Mirrors Monero's sum_of_even_powers (bulletproofs_plus.cc:240–257).
function _sumOfEvenPowers(x, n) {
  if ((n & (n - 1)) !== 0) throw new Error('bpp: sum_of_even_powers needs n power of 2');
  if (n === 0) throw new Error('bpp: sum_of_even_powers needs n > 0');
  let x1 = modN(x * x);  // x²
  let res = x1;
  let nn = n;
  while (nn > 2) {
    res = modN(res + modN(x1 * res));
    x1 = modN(x1 * x1);
    nn = nn / 2;
  }
  return res;
}

export function bppRangeVerify(commitments, proofBytes) {
  // ---- Sanity: shape, sizes -------------------------------------------
  const m = commitments.length;
  if (![1, 2, 4, 8].includes(m)) return false;

  const logN = 6;
  const N = N_BITS;
  const logM = Math.log2(m) | 0;
  const logMN = logM + logN;
  const MN = m * N;

  // Expected proof length: 99 + 96 + logMN·66
  const expectedLen = 99 + 96 + logMN * 66;
  if (!proofBytes || proofBytes.length !== expectedLen) return false;

  // ---- Parse proof bytes ----------------------------------------------
  let off = 0;
  let A, A1, B;
  try {
    A  = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
    A1 = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
    B  = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
  } catch { return false; }
  const r1 = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
  const s1 = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
  const d1 = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
  if (r1 >= SECP_N || s1 >= SECP_N || d1 >= SECP_N) return false;
  const Lvec = new Array(logMN), Rvec = new Array(logMN);
  try {
    for (let k = 0; k < logMN; k++) {
      Lvec[k] = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      Rvec[k] = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
    }
  } catch { return false; }
  if (off !== proofBytes.length) return false;

  // ---- Replay transcript to recover challenges ------------------------
  const transcript = bppTranscript();
  transcript.append('domain', new TextEncoder().encode(BPP_DOMAIN));
  transcript.append('M', new Uint8Array([m & 0xff]));
  try {
    for (const Vj of commitments) transcript.append('V', pointToBytes(Vj));
  } catch { return false; }
  transcript.append('A', pointToBytes(A));
  const y = transcript.challenge('y');
  const z = transcript.challenge('z');
  if (y === 0n || z === 0n) return false;
  const zSq = modN(z * z);

  const challenges = new Array(logMN);
  for (let k = 0; k < logMN; k++) {
    transcript.append('L', pointToBytes(Lvec[k]));
    transcript.append('R', pointToBytes(Rvec[k]));
    challenges[k] = transcript.challenge('u');
    if (challenges[k] === 0n) return false;
  }

  transcript.append('A1', pointToBytes(A1));
  transcript.append('B', pointToBytes(B));
  const e = transcript.challenge('e');
  if (e === 0n) return false;
  const eSq = modN(e * e);

  // ---- Batch invert challenges + y for efficiency ---------------------
  const toInvert = [...challenges, y];
  const inverses = batchInv(toInvert);
  const challengesInv = inverses.slice(0, logMN);
  const yInv = inverses[logMN];

  // ---- y_MN = y^MN via repeated squaring ------------------------------
  // MN is always a power of 2 (m·N where m, N are both powers of 2).
  let y_MN = y;
  let tempMN = MN;
  while (tempMN > 1) {
    y_MN = modN(y_MN * y_MN);
    tempMN /= 2;
  }
  const y_MN_1 = modN(y_MN * y);   // y^(MN+1)

  // ---- Windowed d vector ----------------------------------------------
  // d[j*N+i] = z^(2(j+1)) · 2^i  for j ∈ [0, m), i ∈ [0, N).
  const d = new Array(MN).fill(0n);
  d[0] = zSq;
  for (let i = 1; i < N; i++) d[i] = modN(d[i - 1] * 2n);
  for (let j = 1; j < m; j++) {
    for (let i = 0; i < N; i++) {
      d[j * N + i] = modN(d[(j - 1) * N + i] * zSq);
    }
  }

  // ---- challenges_cache[i]: product of (u_j or u_j^-1) per bit of i ---
  // Standard IPA s vector construction. Reference: bulletproofs_plus.cc:1027–1038.
  // Built incrementally to avoid O(MN·logMN) scalar ops.
  const challengesCache = new Array(1 << logMN);
  challengesCache[0] = challengesInv[0];
  challengesCache[1] = challenges[0];
  for (let j = 1; j < logMN; j++) {
    const slots = 1 << (j + 1);
    for (let s = slots; s-- > 0;) {
      // Iterate s from slots-1 down to 0, stepping by 1 — but Monero
      // unrolls in pairs. We do the same.
      if (s & 1) {
        challengesCache[s] = modN(challengesCache[s >> 1] * challenges[j]);
      } else {
        challengesCache[s] = modN(challengesCache[s >> 1] * challengesInv[j]);
      }
    }
  }

  // ---- Build the single MSM check -------------------------------------
  // Aggregate scalars per generator/point category. Single weight = 1.
  const { Gvec, Hvec, H } = bppGens();

  // G scalar: +d1
  // H scalar: +(r1·y·s1 + e²·((z²-z)·sum(y_MN) + y^(MN+1)·z·sum(d)))
  const sum_y_MN = _sumOfScalarPowers(y, MN);
  const sum_d_val = modN(modN((1n << BigInt(N)) - 1n) * _sumOfEvenPowers(z, 2 * m));

  const H_term1 = modN(modN(r1 * y) * s1);
  const zSq_minus_z = modN(zSq - z);
  const H_inner1 = modN(zSq_minus_z * sum_y_MN);
  const H_inner2 = modN(modN(y_MN_1 * z) * sum_d_val);
  const H_inner = modN(H_inner1 + H_inner2);
  const H_scalar = modN(H_term1 + modN(eSq * H_inner));
  const G_scalar = d1;

  // V[j] scalar: -e² · z^(2(j+1)) · y^(MN+1)
  const V_scalars = new Array(m);
  {
    let zp = zSq;  // z^(2·(j+1)) for j=0 starts at z²
    const baseFactor = modN(SECP_N - modN(eSq * y_MN_1));  // -e²·y^(MN+1)
    for (let j = 0; j < m; j++) {
      V_scalars[j] = modN(baseFactor * zp);
      zp = modN(zp * zSq);
    }
  }

  // A scalar: -e²
  const A_scalar = modN(SECP_N - eSq);
  // A1 scalar: -e
  const A1_scalar = modN(SECP_N - e);
  // B scalar: -1
  const B_scalar = modN(SECP_N - 1n);

  // L[k] scalar: -e²·u_k²
  // R[k] scalar: -e²·u_k⁻²
  const L_scalars = new Array(logMN);
  const R_scalars = new Array(logMN);
  const minus_eSq = modN(SECP_N - eSq);
  for (let k = 0; k < logMN; k++) {
    const uSq = modN(challenges[k] * challenges[k]);
    const uInvSq = modN(challengesInv[k] * challengesInv[k]);
    L_scalars[k] = modN(minus_eSq * uSq);
    R_scalars[k] = modN(minus_eSq * uInvSq);
  }

  // G_i, H_i scalars: per-index, with iterated y^-i factor
  const Gi_scalars = new Array(MN);
  const Hi_scalars = new Array(MN);
  // Initial iterated values
  let e_r1_y_inv_i = modN(e * r1);       // starts as e·r1 (i.e., y^0 factor)
  const e_s1 = modN(e * s1);              // no y factor on the H side
  const eSq_z = modN(eSq * z);
  const minus_eSq_z = modN(SECP_N - eSq_z);
  let minus_eSq_y_MN_minus_i = modN(SECP_N - modN(eSq * y_MN));   // -e²·y^(MN-i), starts at i=0
  const MN_minus_1 = MN - 1;

  for (let i = 0; i < MN; i++) {
    // G_i scalar: e·r1·y^-i · challenges_cache[i] + e²·z
    const g_i = modN(modN(e_r1_y_inv_i * challengesCache[i]) + eSq_z);
    Gi_scalars[i] = g_i;

    // H_i scalar: e·s1 · challenges_cache[(MN-1)^i] + (-e²·z) + (-e²·y^(MN-i)·d[i])
    const revIdx = (MN_minus_1) ^ i;  // bit-complement within MN range
    const h_i_a = modN(e_s1 * challengesCache[revIdx]);
    const h_i_c = modN(minus_eSq_y_MN_minus_i * d[i]);
    const h_i = modN(modN(h_i_a + minus_eSq_z) + h_i_c);
    Hi_scalars[i] = h_i;

    // Update iterated factors
    e_r1_y_inv_i = modN(e_r1_y_inv_i * yInv);
    minus_eSq_y_MN_minus_i = modN(minus_eSq_y_MN_minus_i * yInv);
  }

  // ---- Final MSM check ------------------------------------------------
  // Single Pippenger multi-exp over every (scalar, point) pair contributing
  // to the verifier identity. Replaces the prior per-point .multiply() loop
  // (which was O(MN · 256) point-ops; Pippenger collapses to O(MN + 2^c)
  // per c-bit window). Closes SPEC.md §3.3 "Verifier optimizations" parity
  // for Bulletproofs+ — without this, m=8 verify is ~10× slower than the
  // BP equivalent; with this, BP+ verify lands in the same wall-time class
  // as BP verify (see tests/bulletproofs-plus.bench.mjs).
  //
  // Total points fed per call:
  //   G, H            (2)
  //   Gvec[0..MN-1]   (MN)
  //   Hvec[0..MN-1]   (MN)
  //   commitments[0..m-1] (m)
  //   A, A1, B        (3)
  //   Lvec[0..logMN-1] (logMN)
  //   Rvec[0..logMN-1] (logMN)
  // = 2·MN + m + 2·logMN + 5  (e.g. m=8 ⇒ 1057 points in one MSM).
  const msmScalars = [];
  const msmPoints  = [];
  msmScalars.push(G_scalar);  msmPoints.push(G);
  msmScalars.push(H_scalar);  msmPoints.push(H);
  for (let i = 0; i < MN; i++) {
    msmScalars.push(Gi_scalars[i]); msmPoints.push(Gvec[i]);
    msmScalars.push(Hi_scalars[i]); msmPoints.push(Hvec[i]);
  }
  for (let j = 0; j < m; j++) {
    msmScalars.push(V_scalars[j]); msmPoints.push(commitments[j]);
  }
  msmScalars.push(A_scalar);  msmPoints.push(A);
  msmScalars.push(A1_scalar); msmPoints.push(A1);
  msmScalars.push(B_scalar);  msmPoints.push(B);
  for (let k = 0; k < logMN; k++) {
    msmScalars.push(L_scalars[k]); msmPoints.push(Lvec[k]);
    msmScalars.push(R_scalars[k]); msmPoints.push(Rvec[k]);
  }

  const acc = msm(msmScalars, msmPoints);
  return acc.equals(ZERO);
}
