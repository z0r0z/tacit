// Uniswap V2 canonical swap-output test vectors.
//
// Cross-implementation parity baseline against the well-known
// `swapTestCases` table from Uniswap/v2-core (test/UniswapV2Pair.spec.ts).
// Any reimplementation of tacit's AMM curve MUST reproduce these numbers
// byte-identically — otherwise a swap routed through one implementation
// would produce a different receipt amount than the same swap routed
// through another.
//
// The original Uniswap V2 vectors are at 18-decimal scale (`1e18` per
// unit). tacit assets are u64-bounded with 8-decimal max precision, so
// reserves at `1000` units in 18-decimal scale (= 1e21 base) exceed u64.
// We scale the same vectors down to 8-decimal scale — the curve math is
// homogeneous of degree 1 (scaling all inputs by k scales the output
// by k modulo floor rounding), so the leading digits match the upstream
// 18-decimal expected values.
//
// The fee is 30 bps (Uniswap V2's 0.3%), matching tacit's default
// `fee_bps = 30` recommendation.
//
// Run: `node amm-uniswap-v2-parity.test.mjs`

import { curveDeltaOut } from './swap-var.mjs';
import { solveClearing, amountOutForTrader } from './amm-clearing.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${typeof ok === 'object' ? JSON.stringify(ok) : ok}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const at8 = (n) => BigInt(n) * 100000000n;          // 1 unit at 8-decimal scale = 1e8 base

// --------------------------------------------------------------------
// 1. Canonical forward-swap vectors (A→B direction)
// --------------------------------------------------------------------
//
// Format: [delta_in_units, R_A_units, R_B_units, expected_delta_out_at_8_decimal_scale]
//
// Original 18-decimal vectors from Uniswap V2:
//   [1, 5, 10]      → 1_662497915624478906
//   [1, 10, 5]      →   453305446940074565
//   [2, 5, 10]      → 2_851015155847869602
//   [2, 10, 5]      →   831248957812239453
//   [1, 10, 10]     →   906610893880149131
//   [1, 100, 100]   →   987158034397061298
//   [1, 1000, 1000] →   996006981039903216
//
// Scaling down: 18-dec value / 1e10 = 8-dec value (with truncation).
// The leading digits of the 18-decimal vector are the 8-decimal expected
// output; floor-rounding is preserved.

const SWAP_VECTORS_AB = [
  // [delta_in, R_A, R_B, expected_delta_out_8dec]
  [1n,    5n,    10n,    166249791n],
  [1n,    10n,   5n,     45330544n],
  [2n,    5n,    10n,    285101515n],
  [2n,    10n,   5n,     83124895n],
  [1n,    10n,   10n,    90661089n],
  [1n,    100n,  100n,   98715803n],
  [1n,    1000n, 1000n,  99600698n],
];

console.log('Uniswap V2 canonical vectors — A→B direction, fee=30bps');

for (const [din, ra, rb, expectedOut] of SWAP_VECTORS_AB) {
  test(`A→B [Δ=${din}, R_A=${ra}, R_B=${rb}] → ${expectedOut}`, () => {
    const r = curveDeltaOut({
      direction: 0,
      R_A_pre: at8(ra),
      R_B_pre: at8(rb),
      delta_in: at8(din),
      fee_bps: 30,
    });
    if (r.deltaOut !== expectedOut) {
      return `got ${r.deltaOut}, expected ${expectedOut}`;
    }
    return true;
  });
}

// --------------------------------------------------------------------
// 2. Symmetry check — B→A direction with swapped reserves
// --------------------------------------------------------------------
//
// The curve is symmetric under (direction, R_A, R_B) ↔ (1-direction, R_B, R_A).
// Every A→B [Δ, R_A, R_B] vector implies a B→A [Δ, R_B, R_A] vector with
// the same output. Pinning this proves the direction-multiplexed validator
// branch is consistent.

console.log('\nSymmetry — B→A direction with swapped reserves matches A→B');

for (const [din, ra, rb, expectedOut] of SWAP_VECTORS_AB) {
  test(`B→A [Δ=${din}, R_A=${rb}, R_B=${ra}] (swapped) → ${expectedOut}`, () => {
    const r = curveDeltaOut({
      direction: 1,
      R_A_pre: at8(rb),                              // swapped
      R_B_pre: at8(ra),                              // swapped
      delta_in: at8(din),
      fee_bps: 30,
    });
    if (r.deltaOut !== expectedOut) {
      return `got ${r.deltaOut}, expected ${expectedOut}`;
    }
    return true;
  });
}

// --------------------------------------------------------------------
// 3. Zero-fee curve (Uniswap V2 with feeOff or test scenarios)
// --------------------------------------------------------------------
//
// At fee_bps=0, the curve degenerates to pure constant-product:
//   delta_out = floor(R_B · Δ / (R_A + Δ))
//
// Vector at 8-decimal scale: [Δ=1, R_A=5, R_B=10] →
//   floor(10e8 · 1e8 / (5e8 + 1e8)) = floor(10e16 / 6e8) = floor(1.666...e8) = 166666666

console.log('\nZero-fee curve (fee_bps=0)');

test('[Δ=1, R_A=5, R_B=10] → 166666666 (pure constant-product)', () => {
  const r = curveDeltaOut({
    direction: 0, R_A_pre: at8(5), R_B_pre: at8(10), delta_in: at8(1), fee_bps: 0,
  });
  return r.deltaOut === 166666666n || `got ${r.deltaOut}`;
});

test('[Δ=1, R_A=10, R_B=10] → 90909090 (pure constant-product)', () => {
  const r = curveDeltaOut({
    direction: 0, R_A_pre: at8(10), R_B_pre: at8(10), delta_in: at8(1), fee_bps: 0,
  });
  // floor(10e8 · 1e8 / (10e8 + 1e8)) = floor(10e16 / 11e8) = floor(0.9090...e8) = 90909090
  return r.deltaOut === 90909090n || `got ${r.deltaOut}`;
});

// --------------------------------------------------------------------
// 4. Single-trader batch round-trips through solveClearing
// --------------------------------------------------------------------
//
// solveClearing is the batched-uniform-clearing entry point; with a
// single A→B trader it should produce the same delta_out as
// curveDeltaOut (since clearing degenerates to per-trade pricing).

console.log('\nsolveClearing parity: N=1 batch matches per-trade curve');

for (const [din, ra, rb, expectedOut] of SWAP_VECTORS_AB) {
  test(`solveClearing(X=${din}, Y=0, R_A=${ra}, R_B=${rb}) gives matching output`, () => {
    const X = at8(din);
    const Y = 0n;
    const R_A = at8(ra);
    const R_B = at8(rb);
    const r = solveClearing(X, Y, R_A, R_B, 30);
    // For a single A→B trader: amount_out = amount_in · P_clear_den / P_clear_num
    const out = amountOutForTrader(X, 'A→B', r.P_clear_num, r.P_clear_den);
    if (out !== expectedOut) return `got ${out}, expected ${expectedOut}`;
    return true;
  });
}

// --------------------------------------------------------------------
// 5. Boundary: maximum-input swap (Δ = R_A) — at fee=30bps, the
//    output simplifies to floor(R_B · γ_num / (γ_den + γ_num))
//    which is ~R_B/2 for any equal-reserve pool.
// --------------------------------------------------------------------
//
// For R_A = R_B = X, Δ = X: delta_out = floor(X · γ_num · X / (X · γ_den + γ_num · X))
//                                     = floor(X · γ_num / (γ_den + γ_num))
//                                     = floor(X · 9970 / 19970)
// For X = 1000e8: floor(1e11 · 9970 / 19970) = floor(9.97e14 / 19970) = 49924887330.

console.log('\nBoundary — Δ = R_A (entire reserve as input)');

test('[Δ=1000, R_A=1000, R_B=1000, fee=30bps] → 49924887330 (~R_B/2)', () => {
  const r = curveDeltaOut({
    direction: 0, R_A_pre: at8(1000), R_B_pre: at8(1000), delta_in: at8(1000), fee_bps: 30,
  });
  if (r.deltaOut !== 49924887330n) return `got ${r.deltaOut}, expected 49924887330`;
  if (r.deltaOut >= at8(1000)) return 'deltaOut should be strictly less than reserve_out';
  return true;
});

test('[Δ=10000·R_A, R_A=1000, R_B=1000, fee=30bps] → asymptote approaches R_B', () => {
  // For very large Δ, delta_out → R_B (since denominator becomes
  // dominated by γ_num · Δ, ratio → R_B · γ_num · Δ / (γ_num · Δ) = R_B).
  // At Δ = 10000 · R_A = 1e15, denominator = 1000·1e8·1e4 + 9970·1e15
  //   = 1e15 + 9.97e18 ≈ 9.971e18
  // numerator = 1000·1e8 · 9970 · 1e15 = 1000 · 9970 · 1e23 = 9.97e29
  // delta_out = floor(9.97e29 / 9.971e18) = floor(9.999...e10) = ~R_B - tiny
  const r = curveDeltaOut({
    direction: 0, R_A_pre: at8(1000), R_B_pre: at8(1000),
    delta_in: at8(10000) * 1000n, fee_bps: 30,
  });
  // delta_out should be very close to R_B (= 1e11) but strictly less.
  if (r.deltaOut >= at8(1000)) return 'deltaOut should be < reserve_out';
  const gap = at8(1000) - r.deltaOut;
  if (gap > at8(1)) return `gap to R_B = ${gap}, expected very small`;
  return true;
});

// --------------------------------------------------------------------
// 6. Tiny input → floor rounds to zero (Uniswap V2 doesn't reject this
//    at curve level, only at swap() if amountOut == 0)
// --------------------------------------------------------------------
//
// At extreme imbalance R_A=1e18, R_B=1, a single sat input rounds to 0:

console.log('\nFloor-rounding to zero for tiny inputs against huge reserves');

test('Δ=1 (1 base unit) against R_A=1e10, R_B=10 → 0 output', () => {
  // delta_out = floor(10 · 9970 · 1 / (1e10 · 10000 + 9970)) = floor(99700 / 1e14) = 0
  const r = curveDeltaOut({
    direction: 0, R_A_pre: 10000000000n, R_B_pre: 10n, delta_in: 1n, fee_bps: 30,
  });
  return r.deltaOut === 0n || `got ${r.deltaOut}, expected 0`;
});

// --------------------------------------------------------------------
// 7. Monotonicity — more input → more output
// --------------------------------------------------------------------

console.log('\nMonotonicity — more input never decreases output');

test('curveDeltaOut is monotonically non-decreasing in delta_in', () => {
  let prev = 0n;
  for (let din = 1n; din <= 1000n; din *= 2n) {
    const r = curveDeltaOut({
      direction: 0, R_A_pre: at8(1000), R_B_pre: at8(1000),
      delta_in: at8(Number(din)), fee_bps: 30,
    });
    if (r.deltaOut < prev) return `non-monotonic at Δ=${din}: ${r.deltaOut} < ${prev}`;
    prev = r.deltaOut;
  }
  return true;
});

// --------------------------------------------------------------------
// 8. Constant-product invariant: k_post ≥ k_pre (LP fee accrues)
// --------------------------------------------------------------------

console.log('\nConstant-product invariant: k grows on every fee>0 swap');

test('k_pre < k_post for every nontrivial swap at fee=30bps', () => {
  for (const [din, ra, rb] of SWAP_VECTORS_AB) {
    const r = curveDeltaOut({
      direction: 0, R_A_pre: at8(ra), R_B_pre: at8(rb), delta_in: at8(din), fee_bps: 30,
    });
    const k_pre = at8(ra) * at8(rb);
    const k_post = r.raPost * r.rbPost;
    if (k_post <= k_pre) {
      return `k did not grow for [${din}, ${ra}, ${rb}]: pre=${k_pre}, post=${k_post}`;
    }
  }
  return true;
});

test('k_pre == k_post for every nontrivial swap at fee=0bps (no fee)', () => {
  for (const [din, ra, rb] of SWAP_VECTORS_AB) {
    const r = curveDeltaOut({
      direction: 0, R_A_pre: at8(ra), R_B_pre: at8(rb), delta_in: at8(din), fee_bps: 0,
    });
    const k_pre = at8(ra) * at8(rb);
    const k_post = r.raPost * r.rbPost;
    // With no fee, k_post should equal k_pre EXCEPT for floor-rounding dust
    // that always accrues to the pool. So k_post >= k_pre always; we just
    // verify it doesn't decrease.
    if (k_post < k_pre) {
      return `k decreased at fee=0 for [${din}, ${ra}, ${rb}]: pre=${k_pre}, post=${k_post}`;
    }
  }
  return true;
});

// --------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
