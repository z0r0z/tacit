// Correctness suite for the deterministic clearing-solve algorithm (AMM.md §4).
//
// Asserts:
//   • Direction discrimination is correct (A-dom, B-dom, spot, empty)
//   • Constant-product curve is honored on the net residual
//   • Floor-toward-pool rounding in every division
//   • Symmetry: solveClearing(X, Y, …) ↔ solveClearing(Y, X, R_B, R_A, …) mirrors
//   • Per-trader fills respect P_clear
//   • LP add / remove / init formulas
//   • Qualifying-intent fixed-point converges and drops min_out failures

import {
  solveClearing, amountOutForTrader, applyBatch,
  lpAddShares, lpInitShares, lpRemoveOutputs, isqrt,
  qualifyingFixedPoint,
} from './amm-clearing.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

console.log('Direction discrimination');
test('X=1000, Y=0 ⇒ A→B', () => {
  const r = solveClearing(1000n, 0n, 1_000_000n, 2_000_000n, 30n);
  return r.direction === 'A→B' && r.delta_a_net > 0n && r.delta_b_net > 0n;
});
test('X=0, Y=1000 ⇒ B→A', () => {
  const r = solveClearing(0n, 1000n, 1_000_000n, 2_000_000n, 30n);
  return r.direction === 'B→A' && r.delta_a_net > 0n && r.delta_b_net > 0n;
});
test('X=500, Y=1000 (spot 1:2) ⇒ spot', () => {
  const r = solveClearing(500n, 1000n, 1_000_000n, 2_000_000n, 30n);
  return r.direction === 'spot' && r.delta_a_net === 0n && r.delta_b_net === 0n;
});
test('X=0, Y=0 ⇒ empty', () => {
  const r = solveClearing(0n, 0n, 1_000_000n, 2_000_000n, 30n);
  return r.direction === 'empty';
});
test('X>>Y·P_spot ⇒ A→B', () => {
  const r = solveClearing(5000n, 100n, 1_000_000n, 2_000_000n, 30n);
  return r.direction === 'A→B';
});
test('Y·P_spot>>X ⇒ B→A', () => {
  const r = solveClearing(100n, 5000n, 1_000_000n, 2_000_000n, 30n);
  return r.direction === 'B→A';
});

console.log('\nCurve correctness — Δb_net on the constant-product curve');
//   Δb_net = floor(R_B · γ · Δa_net / (R_A · γ_den + γ · Δa_net))
test('Δb_net matches CFMM formula (A-dom)', () => {
  const X = 1000n, R_A = 1_000_000n, R_B = 2_000_000n, fee_bps = 30n;
  const r = solveClearing(X, 0n, R_A, R_B, fee_bps);
  const g_num = 10000n - fee_bps;
  const expect = (R_B * g_num * r.delta_a_net) / (R_A * 10000n + g_num * r.delta_a_net);
  return r.delta_b_net === expect && r.delta_a_net === X;
});
test('Δa_net matches CFMM formula (B-dom)', () => {
  const Y = 1000n, R_A = 1_000_000n, R_B = 2_000_000n, fee_bps = 30n;
  const r = solveClearing(0n, Y, R_A, R_B, fee_bps);
  const g_num = 10000n - fee_bps;
  const expect = (R_A * g_num * r.delta_b_net) / (R_B * 10000n + g_num * r.delta_b_net);
  return r.delta_a_net === expect && r.delta_b_net === Y;
});

console.log('\nSymmetry — swap (A, B) ↔ (B, A) mirrors deltas');
test('A→B with (R_A, R_B) mirrors B→A with (R_B, R_A)', () => {
  const r1 = solveClearing(1234n, 0n, 1_000_000n, 2_000_000n, 30n);
  const r2 = solveClearing(0n, 1234n, 2_000_000n, 1_000_000n, 30n);
  return r1.delta_a_net === r2.delta_b_net && r1.delta_b_net === r2.delta_a_net;
});

console.log('\nFee math');
test('fee_bps=0 ⇒ no fee charged', () => {
  const r = solveClearing(1000n, 0n, 1_000_000n, 2_000_000n, 0n);
  // R_A · R_B should equal R_A' · R_B' for zero fee
  const post = applyBatch(1_000_000n, 2_000_000n, r);
  // With floor, R_A' · R_B' ≥ R_A · R_B - small floor slack.
  // For zero-fee at exact algebra (no flooring), invariant exactly holds.
  // Here R_B' will be slightly larger than the lossless ideal due to floor.
  const before = 1_000_000n * 2_000_000n;
  const after  = post.R_A * post.R_B;
  return after >= before; // floor favors the pool
});
test('fee_bps > 0 ⇒ invariant strictly grows', () => {
  const r = solveClearing(1000n, 0n, 1_000_000n, 2_000_000n, 30n);
  const post = applyBatch(1_000_000n, 2_000_000n, r);
  return post.R_A * post.R_B > 1_000_000n * 2_000_000n;
});
test('fee_bps capped at 1000 (10%)', () => {
  try { solveClearing(1n, 0n, 1n, 1n, 1001n); return false; }
  catch (e) { return /fee_bps out of range/.test(e.message); }
});

console.log('\nFloor rounding favors the pool');
test('A→B trader fill rounds down', () => {
  const r = solveClearing(1000n, 0n, 1_000_000n, 2_000_000n, 30n);
  // amount_out for A→B trader with input 333 should be floor(333 · 1992 / 1000) = 663.
  const out = amountOutForTrader(333n, 'A→B', r.P_clear_num, r.P_clear_den);
  const expect = (333n * r.P_clear_den) / r.P_clear_num;
  return out === expect;
});

console.log('\nPer-trader fill correctness');
test('fills sum equals net delta (A→B side, single trader)', () => {
  const X = 1000n;
  const r = solveClearing(X, 0n, 1_000_000n, 2_000_000n, 30n);
  // Single trader takes all of X → their amount_out should equal Δb_net.
  const out = amountOutForTrader(X, 'A→B', r.P_clear_num, r.P_clear_den);
  return out === r.delta_b_net;
});
test('fills sum equals net delta (B→A side, single trader)', () => {
  const Y = 1000n;
  const r = solveClearing(0n, Y, 1_000_000n, 2_000_000n, 30n);
  const out = amountOutForTrader(Y, 'B→A', r.P_clear_num, r.P_clear_den);
  return out === r.delta_a_net;
});
test('two-sided fill conservation', () => {
  // X = 800 A→B, Y = 1000 B→A on a 1:2 pool — A-dominant after offset.
  // Pool accounting per asset:
  //   A:  +X from A→B traders (in)  −outBtoA to B→A traders (out)  ⇒ net +Δa_net
  //   B:  +Y from B→A traders (in)  −outAtoB to A→B traders (out)  ⇒ net −Δb_net
  // So:  Δa_net = X − outBtoA  AND  Δb_net = outAtoB − Y  (up to floor slack).
  const X = 800n, Y = 1000n;
  const r = solveClearing(X, Y, 1_000_000n, 2_000_000n, 30n);
  if (r.direction !== 'A→B') return false;
  const outAtoB = amountOutForTrader(X, 'A→B', r.P_clear_num, r.P_clear_den);
  const outBtoA = amountOutForTrader(Y, 'B→A', r.P_clear_num, r.P_clear_den);
  const ok_a = r.delta_a_net === X - outBtoA;
  // Floor rounding can leak ≤ 1 base unit to LPs per integer division.
  const ok_b_diff = (outAtoB - Y) - r.delta_b_net;
  const ok_b = ok_b_diff >= 0n && ok_b_diff <= 1n;
  return ok_a && ok_b;
});

console.log('\nEdge cases');
test('empty pool reserves throw', () => {
  try { solveClearing(1n, 0n, 0n, 1n, 30n); return false; }
  catch (e) { return /reserves must be > 0/.test(e.message); }
});
test('large amount near u64 max', () => {
  // u64 max ≈ 1.8e19. Use 1e18 sides on a 1e18 pool to avoid overflow concerns.
  const big = 1_000_000_000_000_000_000n; // 1e18
  const r = solveClearing(big, 0n, big, big, 30n);
  return r.direction === 'A→B' && r.delta_a_net === big && r.delta_b_net > 0n;
});
test('iteration cap is enforced', () => {
  const r = solveClearing(7n, 13n, 9999n, 9999n, 30n);
  return r.iterations <= 64;
});

console.log('\napplyBatch — reserve updates');
test('A→B: R_A += Δa, R_B -= Δb', () => {
  const r = solveClearing(1000n, 0n, 1_000_000n, 2_000_000n, 30n);
  const post = applyBatch(1_000_000n, 2_000_000n, r);
  return post.R_A === 1_000_000n + r.delta_a_net && post.R_B === 2_000_000n - r.delta_b_net;
});
test('B→A: R_A -= Δa, R_B += Δb', () => {
  const r = solveClearing(0n, 1000n, 1_000_000n, 2_000_000n, 30n);
  const post = applyBatch(1_000_000n, 2_000_000n, r);
  return post.R_A === 1_000_000n - r.delta_a_net && post.R_B === 2_000_000n + r.delta_b_net;
});
test('spot: reserves unchanged', () => {
  const r = solveClearing(500n, 1000n, 1_000_000n, 2_000_000n, 30n);
  const post = applyBatch(1_000_000n, 2_000_000n, r);
  return post.R_A === 1_000_000n && post.R_B === 2_000_000n;
});

console.log('\nLP formulas');
test('lpInitShares(1M, 2M, 1000)', () => {
  const r = lpInitShares(1_000_000n, 2_000_000n, 1000n);
  return r.total_shares === isqrt(2_000_000_000_000n) && r.locked_shares === 1000n
      && r.founder_shares + r.locked_shares === r.total_shares;
});
test('isqrt is deterministic floor', () => {
  return isqrt(0n) === 0n && isqrt(1n) === 1n && isqrt(4n) === 2n
      && isqrt(8n) === 2n && isqrt(9n) === 3n && isqrt(15n) === 3n && isqrt(16n) === 4n;
});
test('lpAddShares uses floor(min(...))', () => {
  const sh = lpAddShares(500n, 1001n, 1_000_000n, 2_000_000n, 1_414_213n);
  // min(500·1414213/1M, 1001·1414213/2M) = min(707, 707) — but the 1001 side gives
  // floor(1415628213/2M) = 707, so tie.
  return sh === 707n;
});
test('lpAddShares: thinner side wins', () => {
  // 500 vs 999 (less than ratio 500:1000) — the B side is "thin," wins.
  const sh = lpAddShares(500n, 999n, 1_000_000n, 2_000_000n, 1_414_213n);
  const a = (500n * 1_414_213n) / 1_000_000n;
  const b = (999n * 1_414_213n) / 2_000_000n;
  return sh === (a < b ? a : b);
});
test('lpRemoveOutputs reciprocal of init for full share', () => {
  // Burn ALL shares → withdraw all reserves
  const total = isqrt(2_000_000_000_000n);
  const r = lpRemoveOutputs(total, 1_000_000n, 2_000_000n, total);
  return r.delta_a === 1_000_000n && r.delta_b === 2_000_000n;
});

console.log('\nQualifying-intent fixed-point');
test('all intents satisfy min_out ⇒ converges to full set', () => {
  const set = [
    { intent_id: '01', direction: 'A→B', amount_in_swap: 1000n, min_out: 0n },
    { intent_id: '02', direction: 'B→A', amount_in_swap: 500n,  min_out: 0n },
  ];
  const out = qualifyingFixedPoint(set, 1_000_000n, 2_000_000n, 30n);
  return out.length === 2;
});
test('intent with unsatisfiable min_out is dropped', () => {
  const set = [
    { intent_id: '01', direction: 'A→B', amount_in_swap: 1000n, min_out: 9_999_999n }, // impossible
    { intent_id: '02', direction: 'B→A', amount_in_swap: 500n,  min_out: 0n },
  ];
  const out = qualifyingFixedPoint(set, 1_000_000n, 2_000_000n, 30n);
  return out.length === 1 && out[0].intent_id === '02';
});
test('cascading drops converge', () => {
  // Intent 01 wants ≥ 1990 B per 1000 A (≥ 1.99 B/A; spot is 2 B/A).
  // Intent 02 is a much larger same-direction A→B order that drives the
  // clearing price down for everyone. Under the combined batch intent 01's
  // min_out fails ⇒ dropped; the re-solve with just 02 succeeds.
  const set = [
    { intent_id: '01', direction: 'A→B', amount_in_swap: 1000n,  min_out: 1990n },
    { intent_id: '02', direction: 'A→B', amount_in_swap: 50_000n, min_out: 0n },
  ];
  const out = qualifyingFixedPoint(set, 1_000_000n, 2_000_000n, 30n);
  return out.length === 1 && out[0].intent_id === '02';
});
test('returns canonical sort order', () => {
  const set = [
    { intent_id: 'ff', direction: 'A→B', amount_in_swap: 1n, min_out: 0n },
    { intent_id: '01', direction: 'B→A', amount_in_swap: 1n, min_out: 0n },
    { intent_id: '7f', direction: 'A→B', amount_in_swap: 1n, min_out: 0n },
  ];
  const out = qualifyingFixedPoint(set, 1_000_000n, 2_000_000n, 30n);
  // All survive; should be sorted ['01', '7f', 'ff'].
  const ids = out.map(x => x.intent_id);
  return ids[0] === '01' && ids[1] === '7f' && ids[2] === 'ff';
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
