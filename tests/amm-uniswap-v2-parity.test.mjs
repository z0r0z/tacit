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
import { solveClearing, amountOutForTrader, lpRemoveOutputs, lpAddShares, lpInitShares, isqrt } from './amm-clearing.mjs';
import { computeProtocolShares, crystallizeProtocolFee } from './amm-protocol-fee.mjs';

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
// 9. isqrt canonical vectors (Uniswap V2 Math.sqrt parity)
// --------------------------------------------------------------------
//
// Newton's method on BigInt. Pinning these ensures any reimplementation
// (Rust, Go, Python) agrees on edge cases — particularly the (y+1)/2
// initial-value bug from dapp.org.uk #3 that broke Uniswap V2's sqrt
// for y = uint(-1). tacit's BigInt arithmetic makes overflow impossible,
// but reimplementations on fixed-width types must reproduce these.

console.log('\nisqrt canonical vectors (Math.sqrt parity)');

const ISQRT_VECTORS = [
  [0n, 0n], [1n, 1n], [2n, 1n], [3n, 1n], [4n, 2n],
  [8n, 2n], [9n, 3n], [100n, 10n],
  [1000000n, 1000n],
  [999999n, 999n],
  [1_000_000_000_000n, 1_000_000n],
  // The famous Uniswap V2 fuzz target — large value that broke the original sqrt
  [(1n << 64n) - 1n, 4294967295n],                  // sqrt(u64.max) = u32.max
  [(1n << 128n) - 1n, (1n << 64n) - 1n],            // sqrt(u128.max) = u64.max
  [1_000_000_000_000_000_000n, 1_000_000_000n],     // 1e18 (Uniswap V2 default scale)
];

for (const [n, expected] of ISQRT_VECTORS) {
  test(`isqrt(${n}) = ${expected}`, () => isqrt(n) === expected || `got ${isqrt(n)}`);
}

// --------------------------------------------------------------------
// 10. lpInitShares (POOL_INIT) canonical vectors
// --------------------------------------------------------------------
//
// Initial total = isqrt(Δa · Δb), founder = total - MINIMUM_LIQUIDITY = total - 1000.
// Uniswap V2's `mint` first-call path matches this exactly.

console.log('\nlpInitShares canonical vectors');

const POOL_INIT_VECTORS = [
  // [deltaA, deltaB, expected_total, expected_founder]
  [10000n, 10000n, 10000n, 9000n],
  [1_000_000n, 1_000_000n, 1_000_000n, 999_000n],
  [100_000_000n, 200_000_000n, 141421356n, 141420356n],     // realistic 8-decimal seed
  [4n, 9n, 6n, null],                                         // edge: total=6 ≤ ML=1000 → rejected
];

for (const [da, db, expectedTotal, expectedFounder] of POOL_INIT_VECTORS) {
  test(`lpInitShares(Δa=${da}, Δb=${db}) total=${expectedTotal}, founder=${expectedFounder}`, () => {
    if (expectedFounder === null) {
      try { lpInitShares(da, db, 1000n); return false; }
      catch (e) { return /below MINIMUM_LIQUIDITY/.test(e.message); }
    }
    const r = lpInitShares(da, db, 1000n);
    if (r.total_shares !== expectedTotal) return `total: got ${r.total_shares}`;
    if (r.founder_shares !== expectedFounder) return `founder: got ${r.founder_shares}`;
    if (r.locked_shares !== 1000n) return `locked: got ${r.locked_shares}`;
    return true;
  });
}

// --------------------------------------------------------------------
// 11. lpAddShares (variant=0 LP_ADD) canonical vectors
// --------------------------------------------------------------------
//
// shares = floor(min(Δa · S / R_A, Δb · S / R_B)). The min takes the
// tighter side, so off-ratio deposits get only the limiting fraction —
// matching Uniswap V2's `mint` for non-initial calls. The excess flows
// donate to remaining LPs (same as Uniswap V2).

console.log('\nlpAddShares canonical vectors');

const LP_ADD_VECTORS = [
  // [deltaA, deltaB, R_A, R_B, S, expected_shares]
  [500n,   500n,   1000n, 1000n, 1000n, 500n],                // at ratio
  [100n,   100n,   1000n, 1000n, 1000n, 100n],                // at ratio, smaller
  [500n,   1000n,  1000n, 1000n, 1000n, 500n],                // db too high, capped by da
  [1000n,  500n,   1000n, 1000n, 1000n, 500n],                // da too high, capped by db
  [1n,     1n,     1000n, 1000n, 1000n, 1n],                  // smallest non-zero
  // Floor rounding (S not divisible by R)
  [100n,   100n,   1234n, 1234n, 1000n, 81n],                 // floor(100·1000/1234) = 81
  // Realistic 8-decimal pool
  [50_000_000_000n, 100_000_000_000n,
   100_000_000_000n, 200_000_000_000n,
   141421356237n, 70710678118n],                              // 50% add at ratio
];

for (const [da, db, ra, rb, s, expected] of LP_ADD_VECTORS) {
  test(`lpAddShares(Δa=${da}, Δb=${db}, R_A=${ra}, R_B=${rb}, S=${s}) → ${expected}`, () => {
    const sh = lpAddShares(da, db, ra, rb, s);
    return sh === expected || `got ${sh}`;
  });
}

// --------------------------------------------------------------------
// 12. lpRemoveOutputs (LP_REMOVE) canonical vectors
// --------------------------------------------------------------------
//
// delta_X = floor(R_X · share / S). Always floor toward the pool —
// remaining LPs absorb the dust. Same direction as Uniswap V2's burn().

console.log('\nlpRemoveOutputs canonical vectors');

const LP_REMOVE_VECTORS = [
  // [share, R_A, R_B, S, expected_delta_A, expected_delta_B]
  [500n,    1000n,         1000n,         1000n,         500n,    500n],         // 50% burn
  [100n,    1000n,         1000n,         1000n,         100n,    100n],         // 10% burn
  [1n,      1000n,         1000n,         1000n,         1n,      1n],           // 0.1% burn (no rounding)
  [999n,    1000n,         1000n,         1000n,         999n,    999n],         // near-full burn
  // Imbalanced pool
  [100n,    100n,          10000n,        1000n,         10n,     1000n],        // R_B 100x larger
  // Floor rounding (R · sa not divisible by S)
  [100n,    1000n,         1000n,         1234n,         81n,     81n],          // floor(100·1000/1234) = 81
  // Realistic 8-decimal scale (50B sat half-burn from a (100B, 200B) pool)
  [50_000_000_000n, 100_000_000_000n, 200_000_000_000n, 100_000_000_000n,
   50_000_000_000n, 100_000_000_000n],
];

for (const [sa, ra, rb, s, expA, expB] of LP_REMOVE_VECTORS) {
  test(`lpRemoveOutputs(share=${sa}, R_A=${ra}, R_B=${rb}, S=${s}) → (${expA}, ${expB})`, () => {
    const r = lpRemoveOutputs(sa, ra, rb, s);
    if (r.delta_a !== expA) return `delta_A: got ${r.delta_a}`;
    if (r.delta_b !== expB) return `delta_B: got ${r.delta_b}`;
    return true;
  });
}

// LP_REMOVE round-trip: LP_ADD then LP_REMOVE the same shares should
// return at most the deposited amounts (modulo floor-rounding dust to LPs).
test('LP_ADD then LP_REMOVE same shares: returns ≤ deposit (dust to remaining LPs)', () => {
  const da = 1_000_000n, db = 1_000_000n;
  const init = lpInitShares(da, db, 1000n);
  const S_init = init.total_shares;                                // 1_000_000
  // Add at-the-ratio
  const deltaAddA = 500_000n, deltaAddB = 500_000n;
  const sharesAdded = lpAddShares(deltaAddA, deltaAddB, da, db, S_init);
  const S_after_add = S_init + sharesAdded;
  const ra_after = da + deltaAddA;
  const rb_after = db + deltaAddB;
  // Remove the just-added shares
  const out = lpRemoveOutputs(sharesAdded, ra_after, rb_after, S_after_add);
  if (out.delta_a > deltaAddA) return `LP got more A back than added: ${out.delta_a} > ${deltaAddA}`;
  if (out.delta_b > deltaAddB) return `LP got more B back than added: ${out.delta_b} > ${deltaAddB}`;
  return true;
});

// --------------------------------------------------------------------
// 13. mintFee (Uniswap V2 lazy protocol fee crystallization) vectors
// --------------------------------------------------------------------
//
// Formula: new_shares = S · bps · (rootK_now - rootK_pre) /
//                      ((BPS_DEN - bps) · rootK_now + bps · rootK_pre)
//
// Floor-divides; dilutes existing LPs; matches Uniswap V2's `_mintFee`
// for `feeOn` mode. tacit additionally caps bps at 1000 (= 10%) which
// covers Uniswap V2's hardcoded 1/6 ≈ 16.67% IF the fee policy ever
// raised the cap. Default V1 pools have bps=0 (no protocol fee).

console.log('\ncomputeProtocolShares canonical vectors');

const PROTOCOL_FEE_VECTORS = [
  // No growth → 0
  { S: 1000n,    k_pre: 1_000_000n, k_now: 1_000_000n, bps: 50n,   expected: 0n },
  // k decreased (LP_REMOVE happened) → 0
  { S: 1000n,    k_pre: 1_000_000n, k_now: 999_999n,   bps: 50n,   expected: 0n },
  // bps = 0 (fee disabled) → 0
  { S: 1000n,    k_pre: 100n,       k_now: 200n,       bps: 0n,    expected: 0n },
  // S = 0 (empty pool) → 0 (defensive; can't happen in valid flow)
  { S: 0n,       k_pre: 100n,       k_now: 200n,       bps: 50n,   expected: 0n },
  // k 4x growth (sqrt 2x) at 0.5% bps: matches manual calc
  { S: 1_000_000n,
    k_pre: 1_000_000_000_000_000_000n,
    k_now: 4_000_000_000_000_000_000n,
    bps:   50n,
    expected: 2506n },
  // Same k-growth at max 10% bps
  { S: 1_000_000n,
    k_pre: 1_000_000_000_000_000_000n,
    k_now: 4_000_000_000_000_000_000n,
    bps:   1000n,
    expected: 52631n },
  // 100x k-growth (10x sqrt) at 5% bps
  { S: 1_000_000n,
    k_pre: 1_000_000_000_000_000_000n,
    k_now: 100_000_000_000_000_000_000n,
    bps:   500n,
    expected: 47120n },
  // Tiny growth → 0 due to floor
  { S: 1000n,    k_pre: 1_000_000n, k_now: 1_000_100n, bps: 50n,   expected: 0n },
  { S: 1000n,    k_pre: 1_000_000n, k_now: 1_010_000n, bps: 50n,   expected: 0n },
];

for (const { S, k_pre, k_now, bps, expected } of PROTOCOL_FEE_VECTORS) {
  test(`computeProtocolShares(S=${S}, kΔ=${k_pre}→${k_now}, bps=${bps}) → ${expected}`, () => {
    const r = computeProtocolShares({ S_pre: S, k_pre, k_now, protocol_fee_bps: bps });
    return r === expected || `got ${r}`;
  });
}

// mintFee rejects out-of-range bps (matches the validator's pre-flight)
test('computeProtocolShares rejects bps > 1000', () => {
  try {
    computeProtocolShares({ S_pre: 1000n, k_pre: 100n, k_now: 200n, protocol_fee_bps: 1001n });
    return false;
  } catch (e) { return /out of range/.test(e.message); }
});

test('computeProtocolShares rejects negative bps', () => {
  try {
    computeProtocolShares({ S_pre: 1000n, k_pre: 100n, k_now: 200n, protocol_fee_bps: -1n });
    return false;
  } catch (e) { return /out of range/.test(e.message); }
});

// Crystallization full path: pool with growth → accrued > 0; k_last advances.
test('crystallizeProtocolFee end-to-end: accrued grows, k_last advances', () => {
  const pool = {
    reserve_A: 2_000_000n, reserve_B: 2_000_000n,
    lp_total_shares: 2_000_000n,
    k_last: 1_000_000_000_000n,                                   // (1M)^2
    protocol_fee_address: new Uint8Array(33).fill(0xab),          // non-zero ⇒ enabled
    protocol_fee_bps: 50,
    protocol_fee_accrued: 0n,
  };
  const x = crystallizeProtocolFee(pool);
  // k grew from 1e12 to 4e12, so some shares accrue
  if (x.protocol_fee_accrued === 0n) return 'accrued should be > 0';
  if (x.k_last !== 4_000_000_000_000n) return `k_last did not advance: ${x.k_last}`;
  if (x.lp_total_shares !== 2_000_000n + x.protocol_fee_accrued) return 'S did not dilute';
  return true;
});

// Crystallization is no-op when fee disabled.
test('crystallizeProtocolFee no-op when address = zero (fee disabled)', () => {
  const pool = {
    reserve_A: 2_000_000n, reserve_B: 2_000_000n,
    lp_total_shares: 2_000_000n,
    k_last: 1_000_000_000_000n,
    protocol_fee_address: new Uint8Array(33),                     // all zeros = disabled
    protocol_fee_bps: 0,
    protocol_fee_accrued: 0n,
  };
  const x = crystallizeProtocolFee(pool);
  return x.lp_total_shares === pool.lp_total_shares
      && x.k_last === pool.k_last
      && (x.protocol_fee_accrued || 0n) === 0n;
});

// --------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
