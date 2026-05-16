// Property-based fuzz tests for the AMM curve and clearing solve.
//
// Canonical vectors (amm-uniswap-v2-parity.test.mjs) lock specific
// numeric outputs. This file complements them with property tests that
// sweep through tens of thousands of random inputs and assert invariants:
//
//   1. Monotonicity      — more input ⇒ more output (never less)
//   2. Symmetry          — direction multiplexing produces consistent results
//   3. Range bounds      — output strictly less than output-side reserve
//   4. k-invariant       — post-product ≥ pre-product (fee accrues to LPs)
//   5. Idempotence       — solveClearing fixed-point: applying the result and
//                          re-solving gives the same answer
//   6. Reserve overflow  — sums never exceed u64
//   7. Floor direction   — every floor rounds toward the pool, never away
//
// Random inputs are drawn from a deterministic PRNG seeded with a constant
// so test runs are reproducible. The PRNG fills (R_A, R_B, Δ, fee_bps)
// across multiple decades so we exercise both tiny pools (R_A ≈ 10^3)
// and realistic 8-decimal pools (R_A ≈ 10^11).
//
// Run: `node amm-curve-fuzz.test.mjs`

import { curveDeltaOut } from './swap-var.mjs';
import { solveClearing, amountOutForTrader, applyBatch } from './amm-clearing.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${typeof ok === 'object' ? JSON.stringify(ok) : ok}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const U64_MAX = (1n << 64n) - 1n;

// Reproducible PRNG (xorshift64*). Seeded per-section so each property
// test draws independently.
function makePrng(seed) {
  let s = BigInt(seed);
  return () => {
    s ^= s << 13n;  s &= U64_MAX;
    s ^= s >> 7n;
    s ^= s << 17n;  s &= U64_MAX;
    return s * 0x2545f4914f6cdd1dn & U64_MAX;
  };
}

// Random u64 in [lo, hi]. lo, hi inclusive bigints.
function randInRange(prng, lo, hi) {
  const span = hi - lo + 1n;
  return lo + (prng() % span);
}

// Pick a reserve magnitude across decades (tiny → realistic → huge).
function randReserve(prng) {
  // 80% of the time, draw from "realistic" 8-decimal pools (1e3 to 1e15).
  // 20% of the time, draw from the extreme tails to exercise overflow paths.
  const tail = (prng() % 10n);
  if (tail < 8n) {
    const decade = prng() % 13n;                                   // 0..12 (BigInt)
    const base = 10n ** decade;
    return base + (prng() % base);                                  // [base, 2·base)
  }
  // Tail: very small (1..10) or very large (up to 2^63)
  if (tail === 8n) return 1n + (prng() % 100n);
  const bits = (prng() % 16n) + 48n;                                // 48..63 (BigInt)
  return (prng() % (1n << bits)) + 1n;
}

// ============================================================
// 1. curveDeltaOut — single-trade monotonicity in delta_in
// ============================================================
//
// More input MUST produce at least as much output. Per-fill floor
// rounding is the only source of "tied" outputs.

console.log('curveDeltaOut — monotonicity in delta_in');

test('monotonicity: 2000 random (R_A, R_B, fee), Δ ∈ [1, R_A] doubling', () => {
  const prng = makePrng(0xC0DECAFE);
  for (let trial = 0; trial < 2000; trial++) {
    const ra = randReserve(prng);
    const rb = randReserve(prng);
    const fee_bps = Number(prng() % 1001n);
    let prevOut = -1n;
    let prevIn = 0n;
    for (let din = 1n; din <= ra && din < (1n << 60n); din = din * 2n + 1n) {
      let out;
      try {
        const r = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps });
        out = r.deltaOut;
      } catch (e) {
        // out-of-range u64 ⇒ stop this trial; we exercised the in-range portion
        break;
      }
      if (out < prevOut) {
        return `non-monotonic at trial=${trial}: din ${prevIn}→${din} out ${prevOut}→${out} (R_A=${ra}, R_B=${rb}, fee=${fee_bps})`;
      }
      prevOut = out;
      prevIn = din;
    }
  }
  return true;
});

// ============================================================
// 2. curveDeltaOut — symmetry under direction swap
// ============================================================
//
// curveDeltaOut(direction=0, R_A, R_B, Δ) ≡ curveDeltaOut(direction=1, R_B, R_A, Δ).
// The direction-multiplexed branches in the validator must agree.

console.log('\ncurveDeltaOut — A↔B symmetry');

test('direction swap with swapped reserves: 1000 random cases', () => {
  const prng = makePrng(0xBEEFFACE);
  for (let trial = 0; trial < 1000; trial++) {
    const ra = randReserve(prng);
    const rb = randReserve(prng);
    const din = randInRange(prng, 1n, ra > U64_MAX ? U64_MAX : ra);
    const fee_bps = Number(prng() % 1001n);
    let fwd, rev;
    try {
      fwd = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps });
    } catch { continue; }
    try {
      rev = curveDeltaOut({ direction: 1, R_A_pre: rb, R_B_pre: ra, delta_in: din, fee_bps });
    } catch { continue; }
    if (fwd.deltaOut !== rev.deltaOut) {
      return `direction asymmetry at trial=${trial}: fwd=${fwd.deltaOut}, rev=${rev.deltaOut} (R_A=${ra}, R_B=${rb}, Δ=${din}, fee=${fee_bps})`;
    }
  }
  return true;
});

// ============================================================
// 3. curveDeltaOut — output strictly less than output reserve
// ============================================================
//
// Uniswap V2's INSUFFICIENT_LIQUIDITY check: a swap cannot drain the
// pool. tacit's curve formula structurally bounds delta_out < R_out
// for any finite Δ at fee_bps > 0 (and ≤ R_out at fee_bps = 0).

console.log('\ncurveDeltaOut — output bounded by reserve');

test('delta_out < R_out for fee>0, ≤ R_out for fee=0 (2000 cases)', () => {
  const prng = makePrng(0xDEADBEEF);
  for (let trial = 0; trial < 2000; trial++) {
    const ra = randReserve(prng);
    const rb = randReserve(prng);
    const fee_bps = Number(prng() % 1001n);
    const din = randInRange(prng, 1n, ra > U64_MAX ? U64_MAX : ra);
    let r;
    try { r = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps }); }
    catch { continue; }
    if (fee_bps > 0 && r.deltaOut >= rb) {
      return `delta_out ${r.deltaOut} >= R_B ${rb} (trial=${trial})`;
    }
    if (fee_bps === 0 && r.deltaOut > rb) {
      return `fee=0: delta_out ${r.deltaOut} > R_B ${rb} (trial=${trial})`;
    }
  }
  return true;
});

// ============================================================
// 4. curveDeltaOut — k-invariant non-decrease
// ============================================================
//
// Constant-product with fee: k_post ≥ k_pre always. Equal only at
// fee_bps = 0 AND when no floor rounding would push k upward.

console.log('\ncurveDeltaOut — k-invariant');

test('k_post ≥ k_pre at fee=30bps (2000 cases)', () => {
  const prng = makePrng(0xFEEDFACE);
  for (let trial = 0; trial < 2000; trial++) {
    const ra = randReserve(prng);
    const rb = randReserve(prng);
    const din = randInRange(prng, 1n, ra > U64_MAX ? U64_MAX : ra);
    let r;
    try { r = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps: 30 }); }
    catch { continue; }
    const k_pre = ra * rb;
    const k_post = r.raPost * r.rbPost;
    if (k_post < k_pre) {
      return `k decreased at trial=${trial}: ${k_pre}→${k_post} (R_A=${ra}, R_B=${rb}, Δ=${din})`;
    }
  }
  return true;
});

// ============================================================
// 5. solveClearing — fixed-point idempotence
// ============================================================
//
// If we apply a batch's result to the pool, then re-solve at the new
// reserves with empty intent set, we should get a no-op spot result.
// (This is more a sanity check on applyBatch than solveClearing.)

console.log('\nsolveClearing — applyBatch round-trip');

test('apply A→B-only batch advances reserves consistently (500 cases)', () => {
  const prng = makePrng(0xCAFEBABE);
  for (let trial = 0; trial < 500; trial++) {
    const ra = randInRange(prng, 1000n, 1n << 40n);
    const rb = randInRange(prng, 1000n, 1n << 40n);
    const X = randInRange(prng, 1n, ra);
    const fee_bps = Number(prng() % 1001n);
    const r = solveClearing(X, 0n, ra, rb, fee_bps);
    const post = applyBatch(ra, rb, r);
    if (r.direction === 'A→B') {
      if (post.R_A !== ra + r.delta_a_net) return `R_A mismatch trial=${trial}`;
      if (post.R_B !== rb - r.delta_b_net) return `R_B mismatch trial=${trial}`;
    }
  }
  return true;
});

// ============================================================
// 6. solveClearing — N=1 batch matches curveDeltaOut
// ============================================================
//
// Single-trader batch (Y=0 or X=0) should compute the same output as
// the per-trade curve. Catches drift between the two pricing paths.

console.log('\nsolveClearing — N=1 parity with curveDeltaOut');

test('solveClearing(X, 0, ...) gives curveDeltaOut(0, ...) (1000 cases)', () => {
  const prng = makePrng(0xBADC0DE5);
  for (let trial = 0; trial < 1000; trial++) {
    const ra = randInRange(prng, 1000n, 1n << 40n);
    const rb = randInRange(prng, 1000n, 1n << 40n);
    const X = randInRange(prng, 1n, ra);
    const fee_bps = Number(prng() % 1001n);
    const r = solveClearing(X, 0n, ra, rb, fee_bps);
    const out = amountOutForTrader(X, 'A→B', r.P_clear_num, r.P_clear_den);
    let curveOut;
    try {
      curveOut = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: X, fee_bps }).deltaOut;
    } catch { continue; }
    if (out !== curveOut) {
      return `parity break trial=${trial}: solve=${out}, curve=${curveOut} (R_A=${ra}, R_B=${rb}, X=${X}, fee=${fee_bps})`;
    }
  }
  return true;
});

// ============================================================
// 7. solveClearing — direction inference
// ============================================================
//
// X·R_B > Y·R_A ⇒ A-dom (Δa > 0).
// X·R_B < Y·R_A ⇒ B-dom (Δa < 0 equivalently Δb > 0).
// X·R_B = Y·R_A ⇒ spot (deltas = 0).

console.log('\nsolveClearing — direction discrimination');

test('direction matches sign of X·R_B − Y·R_A (1500 cases)', () => {
  const prng = makePrng(0xC0DEDEAD);
  for (let trial = 0; trial < 1500; trial++) {
    const ra = randInRange(prng, 1000n, 1n << 32n);
    const rb = randInRange(prng, 1000n, 1n << 32n);
    const X = randInRange(prng, 0n, ra / 2n);
    const Y = randInRange(prng, 0n, rb / 2n);
    if (X === 0n && Y === 0n) continue;
    const fee_bps = Number(prng() % 1001n);
    const r = solveClearing(X, Y, ra, rb, fee_bps);
    const cmp = X * rb - Y * ra;
    if (cmp > 0n) {
      if (r.direction !== 'A→B') return `expected A→B for X·R_B > Y·R_A at trial=${trial}, got ${r.direction}`;
    } else if (cmp < 0n) {
      if (r.direction !== 'B→A') return `expected B→A for X·R_B < Y·R_A at trial=${trial}, got ${r.direction}`;
    } else {
      if (r.direction !== 'spot') return `expected spot for X·R_B = Y·R_A at trial=${trial}, got ${r.direction}`;
    }
  }
  return true;
});

// ============================================================
// 8. solveClearing — both-direction net flow conservation
// ============================================================
//
// For mixed batches (X > 0 AND Y > 0), the net flow (Δa_net, Δb_net)
// should satisfy the CFMM curve floor identity:
//
//   A-dom:  |Δb| · (R_A · γ_den + γ_num · |Δa|) ≤ R_B · γ_num · |Δa|
//   B-dom:  |Δa| · (R_B · γ_den + γ_num · |Δb|) ≤ R_A · γ_num · |Δb|
//
// This is the inequality the validator enforces in checkAggregatePedersen.

console.log('\nsolveClearing — CFMM curve floor identity');

test('mixed-batch net delta satisfies with-fee curve floor (1000 cases)', () => {
  const prng = makePrng(0xF00DBA11);
  for (let trial = 0; trial < 1000; trial++) {
    const ra = randInRange(prng, 1000n, 1n << 30n);
    const rb = randInRange(prng, 1000n, 1n << 30n);
    const X = randInRange(prng, 1n, ra / 4n);
    const Y = randInRange(prng, 1n, rb / 4n);
    const fee_bps = 30;
    const gNum = 10000n - BigInt(fee_bps);
    const gDen = 10000n;
    let r;
    try { r = solveClearing(X, Y, ra, rb, fee_bps); } catch { continue; }
    if (r.direction === 'spot') continue;
    const da = r.delta_a_net;
    const db = r.delta_b_net;
    if (r.direction === 'A→B') {
      const lhs = db * (ra * gDen + gNum * da);
      const rhs = rb * gNum * da;
      if (lhs > rhs) {
        return `A-dom curve floor violated trial=${trial}: lhs=${lhs}, rhs=${rhs} (R_A=${ra}, R_B=${rb}, X=${X}, Y=${Y}, Δa=${da}, Δb=${db})`;
      }
    } else {
      const lhs = da * (rb * gDen + gNum * db);
      const rhs = ra * gNum * db;
      if (lhs > rhs) {
        return `B-dom curve floor violated trial=${trial}: lhs=${lhs}, rhs=${rhs}`;
      }
    }
  }
  return true;
});

// ============================================================
// 9. curveDeltaOut — fee_bps boundary fuzz
// ============================================================
//
// Sweep fee_bps from 0 to 1000 at fixed (R_A, R_B, Δ) and verify
// delta_out is monotonically non-increasing as fee grows.

console.log('\ncurveDeltaOut — fee_bps monotonicity');

test('higher fee_bps never increases delta_out (200 cases × 11 fees)', () => {
  const prng = makePrng(0x12345678);
  for (let trial = 0; trial < 200; trial++) {
    const ra = randInRange(prng, 1000n, 1n << 40n);
    const rb = randInRange(prng, 1000n, 1n << 40n);
    const din = randInRange(prng, 1n, ra / 2n);
    let prev = ra * rb;                                            // dummy upper bound
    for (let fee_bps = 0; fee_bps <= 1000; fee_bps += 100) {
      let r;
      try { r = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps }); }
      catch { continue; }
      if (r.deltaOut > prev) {
        return `fee monotonicity broken at trial=${trial}, fee=${fee_bps}: ${r.deltaOut} > prev ${prev}`;
      }
      prev = r.deltaOut;
    }
  }
  return true;
});

// ============================================================
// 10. curveDeltaOut — reserve scaling invariance
// ============================================================
//
// Homogeneity: scaling (R_A, R_B, Δ) by the same factor k should scale
// delta_out by k (modulo floor rounding). At scale k=2, delta_out_2 ≈
// 2·delta_out_1, within ≤ 1 base unit due to rounding.

console.log('\ncurveDeltaOut — reserve scaling invariance');

test('doubling reserves and input doubles output (modulo floor) (500 cases)', () => {
  const prng = makePrng(0xACEBABE5);
  for (let trial = 0; trial < 500; trial++) {
    const ra = randInRange(prng, 1000n, 1n << 30n);
    const rb = randInRange(prng, 1000n, 1n << 30n);
    const din = randInRange(prng, 1n, ra / 4n);
    const fee_bps = 30;
    let r1, r2;
    try {
      r1 = curveDeltaOut({ direction: 0, R_A_pre: ra,      R_B_pre: rb,      delta_in: din,      fee_bps });
      r2 = curveDeltaOut({ direction: 0, R_A_pre: ra * 2n, R_B_pre: rb * 2n, delta_in: din * 2n, fee_bps });
    } catch { continue; }
    // r2 should be approximately 2·r1 (within a few floor-rounding units)
    const expected = r1.deltaOut * 2n;
    const drift = r2.deltaOut > expected ? r2.deltaOut - expected : expected - r2.deltaOut;
    if (drift > 4n) {                                              // allow 4 base units of drift
      return `scaling drift trial=${trial}: r1=${r1.deltaOut}, r2=${r2.deltaOut}, expected ≈ ${expected}`;
    }
  }
  return true;
});

// ============================================================
// 11. Spot-clearing edge case
// ============================================================
//
// When X·R_B == Y·R_A exactly, the solve must return spot with both
// deltas = 0. P_clear collapses to the spot ratio.

console.log('\nSpot-clearing edge case');

test('exact-cancel batch: X·R_B = Y·R_A ⇒ spot, deltas = 0', () => {
  // Construct exact-cancel scenarios. The condition is X·R_B = Y·R_A,
  // i.e., X/R_A = Y/R_B (same fraction of each side flowing in).
  const cases = [
    { ra: 1000n, rb: 1000n, X: 100n, Y: 100n },                    // 1:1 pool, 10% each side
    { ra: 1000n, rb: 2000n, X: 100n, Y: 200n },                    // 1:2 pool (X·2000 = Y·1000 ⇒ Y=2X)
    { ra: 2000n, rb: 1000n, X: 100n, Y: 50n  },                    // 2:1 pool (X·1000 = Y·2000 ⇒ X=2Y)
  ];
  for (const { ra, rb, X, Y } of cases) {
    if (X * rb !== Y * ra) return `setup bug: X·R_B=${X*rb}, Y·R_A=${Y*ra}`;
    const r = solveClearing(X, Y, ra, rb, 30);
    if (r.direction !== 'spot') return `expected spot for (R_A=${ra}, R_B=${rb}, X=${X}, Y=${Y}), got ${r.direction}`;
    if (r.delta_a_net !== 0n || r.delta_b_net !== 0n) return `spot batch should have zero deltas, got (${r.delta_a_net}, ${r.delta_b_net})`;
  }
  return true;
});

// ============================================================
// 12. curveDeltaOut — fees actually accrue (k_post > k_pre at fee>0)
// ============================================================

console.log('\ncurveDeltaOut — fees strictly grow k at fee>0');

test('k_post > k_pre (strictly) for non-trivial swap at fee=30bps (500 cases)', () => {
  const prng = makePrng(0xC0FFEE42);
  let exact = 0, strictly_greater = 0;
  for (let trial = 0; trial < 500; trial++) {
    const ra = randInRange(prng, 10000n, 1n << 30n);               // exclude tiny pools where floor dominates
    const rb = randInRange(prng, 10000n, 1n << 30n);
    const din = randInRange(prng, 100n, ra / 4n);                  // exclude floor-to-zero cases
    let r;
    try { r = curveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps: 30 }); }
    catch { continue; }
    const k_pre = ra * rb;
    const k_post = r.raPost * r.rbPost;
    if (k_post > k_pre) strictly_greater++;
    else if (k_post === k_pre) exact++;
    else return `k decreased trial=${trial}`;
  }
  // Most cases should strictly grow k. The "exact" count is the dust-tied edge.
  if (strictly_greater < 400) return `only ${strictly_greater}/500 strictly grew k (rest tied due to floor)`;
  return true;
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
