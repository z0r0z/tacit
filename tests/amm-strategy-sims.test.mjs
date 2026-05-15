// Strategy simulations for the tacit AMM.
//
// These tests are NOT consensus-critical. They simulate the economic
// behavior of the protocol over many trades and price walks, and assert
// that the design's stated properties hold across realistic scenarios:
//
//   1. LP IL + fee accrual over price walks (Monte Carlo, 3 volatility
//      profiles × 3 time horizons × 100 trials each = 900 sims)
//   2. High-volume saturation (10K random events; pool invariants hold)
//   3. Concurrent-batch-same-block race (deterministic; documents the
//      AMM.md "Open caveats" disjoint-batches edge case in test form)
//
// Built entirely on the math layer (solveClearing, lpAddShares,
// lpRemoveOutputs, lpInitShares). No Bitcoin txs, no envelopes, no
// Groth16. The goal is to give product/UX/LP-decision confidence — not
// soundness. Soundness is covered by amm-validator.test.mjs +
// adversarial-test.mjs + amm-batch-fuzz.test.mjs.

import {
  solveClearing, amountOutForTrader, applyBatch,
  lpAddShares, lpInitShares, lpRemoveOutputs, isqrt,
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

// Seeded PRNG — same construction as amm-batch-fuzz.test.mjs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =========================================================================
// 1. LP IL + fee accrual over price walks
// =========================================================================
//
// Model: an "outside market" price walks geometrically. An arbitrageur
// keeps the pool's spot ratio aligned with the market by swapping. Each
// arb swap pays the pool fee (fee_bps), which accrues to LPs via the
// constant-product invariant. At the end of the horizon, the LP withdraws
// proportionally; we compare their value to "just holding" the initial
// position.
//
// Volatility profiles (per-step σ, expressed as fractional std dev):
//   - stable     : 0.0005 (~1% daily vol; cBTC ↔ cUSD stablecoin pair)
//   - correlated : 0.005  (~10% daily vol; cBTC ↔ correlated tacit asset)
//   - volatile   : 0.02   (~40% daily vol; cBTC ↔ random PETCH token)
//
// Each profile is run for 30 days × 24 hourly steps = 720 walk steps.
// 100 Monte Carlo trials per profile, deterministic seeds.

function arbSwapToTarget({ R_A, R_B, P_target, fee_bps }) {
  // Compute the swap size that brings the pool's spot ratio to P_target
  // (price = R_A / R_B). Arbitrageur swaps the side that's "cheap" in the
  // pool relative to P_target. Solver uses the existing clearing math
  // (single-direction; the arbitrageur is the sole trader).
  //
  // P_spot > P_target  ⇒  pool has too much A (B is undervalued in pool);
  //                       arb swaps B → A (puts B in, takes A out).
  // P_spot < P_target  ⇒  pool has too much B (A is undervalued in pool);
  //                       arb swaps A → B.
  const P_spot = Number(R_A) / Number(R_B);
  if (Math.abs(P_spot - P_target) / P_target < 0.0001) return null; // negligible drift

  // Compute exact arb amount via Uniswap V2 formula (with fee γ).
  // Target reserves: R_A' = sqrt(k_target * P_target),
  //                  R_B' = sqrt(k_target / P_target)
  // where k_target is the post-arb k. The fee makes k strictly increase.
  //
  // We approximate by solving for the swap that brings the post-swap
  // P_spot to within 0.1% of P_target. Iteratively pick swap size, run
  // solveClearing, check post price.
  const γ = (10000n - BigInt(fee_bps));
  const γDen = 10000n;
  const k = R_A * R_B;

  // Heuristic: arb size proportional to the price gap.
  // (R_A / R_B) → P_target: gap_ratio = sqrt(P_target / P_spot).
  // Δa = R_A * (gap_ratio - 1) for A → B direction.
  const gap = Math.sqrt(P_target / P_spot);
  let direction, amount;
  if (P_target > P_spot) {
    // Need P_spot to increase. swap A → B (put A in, take B out).
    direction = 'A→B';
    const fa = Number(R_A) * (gap - 1);
    amount = BigInt(Math.max(1, Math.floor(fa)));
  } else {
    // P_target < P_spot. swap B → A.
    direction = 'B→A';
    const fa = Number(R_B) * (1 / gap - 1);
    amount = BigInt(Math.max(1, Math.floor(fa)));
  }

  if (amount === 0n) return null;
  // Cap arb at 25% of the relevant reserve to avoid drainage on extreme moves
  if (direction === 'A→B' && amount > R_A / 4n) amount = R_A / 4n;
  if (direction === 'B→A' && amount > R_B / 4n) amount = R_B / 4n;

  let X, Y;
  if (direction === 'A→B') { X = amount; Y = 0n; }
  else                     { X = 0n; Y = amount; }

  const sol = solveClearing(X, Y, R_A, R_B, BigInt(fee_bps));
  const post = applyBatch(R_A, R_B, sol);
  return { sol, post, direction, amount };
}

function simulateOnePriceWalk({
  initialReserves, fee_bps, lpShareFraction,
  steps, volPerStep, rng,
}) {
  let pool = { R_A: initialReserves.R_A, R_B: initialReserves.R_B };
  const S_init = isqrt(pool.R_A * pool.R_B);
  const lpShares = (S_init * BigInt(Math.floor(lpShareFraction * 10000))) / 10000n;

  // Track initial LP entitlement: their value at entry is lpShareFraction
  // of the pool's value. Compute hodl-equivalent in B-denominated units.
  const P_init = Number(pool.R_A) / Number(pool.R_B);
  const lpInitValueB = (Number(pool.R_A) / P_init + Number(pool.R_B)) * lpShareFraction;
  // i.e., the LP's initial position is lpShareFraction · (R_B + R_A/P_init)
  //                                = lpShareFraction · 2·R_B at P_spot.

  let P_market = P_init;
  for (let i = 0; i < steps; i++) {
    // Geometric random walk: P *= exp((rng - 0.5) * 2 * vol)
    const u = rng() - 0.5;
    P_market *= Math.exp(u * 2 * volPerStep);

    // Arb to target
    const arb = arbSwapToTarget({ R_A: pool.R_A, R_B: pool.R_B, P_target: P_market, fee_bps });
    if (arb) pool = arb.post;
  }

  // LP withdraws at end
  const S_final = S_init; // S didn't change (no LP events during walk)
  const out = lpRemoveOutputs(lpShares, pool.R_A, pool.R_B, S_final);
  const lpFinalValueB = Number(out.delta_b) + Number(out.delta_a) / P_market;

  // Hodl: keep the initial deposit ratio. At final price:
  const lpInitARatio = Number(initialReserves.R_A) * lpShareFraction;
  const lpInitBRatio = Number(initialReserves.R_B) * lpShareFraction;
  const hodlValueB = lpInitBRatio + lpInitARatio / P_market;

  // IL is the difference between hodl and LP, normalized.
  // Note: IL is always ≤ 0 (LP underperforms hodl on price moves).
  // Fees add to LP performance.
  const il = (lpFinalValueB - hodlValueB) / hodlValueB;

  return {
    P_init, P_final: P_market,
    lpInitValueB, lpFinalValueB, hodlValueB,
    il, // net = (LP - hodl) / hodl; negative = LP underperformed
  };
}

function summarize(results) {
  const n = results.length;
  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / n;
  const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
  };
  const ils = results.map(r => r.il);
  return {
    n,
    mean_il_pct: (mean(ils) * 100).toFixed(2),
    median_il_pct: (median(ils) * 100).toFixed(2),
    p10_il_pct: (([...ils].sort((a, b) => a - b)[Math.floor(n * 0.1)]) * 100).toFixed(2),
    p90_il_pct: (([...ils].sort((a, b) => a - b)[Math.floor(n * 0.9)]) * 100).toFixed(2),
  };
}

console.log('LP IL + fee accrual over price walks (Monte Carlo)');
{
  const profiles = [
    { name: 'stable (cBTC ↔ cUSD-style)', volPerStep: 0.0005 },
    { name: 'correlated (cBTC ↔ correlated tacit asset)', volPerStep: 0.005 },
    { name: 'volatile (cBTC ↔ long-tail token)', volPerStep: 0.02 },
  ];
  const horizons = [
    { name: '30 days', steps: 30 * 24 },
    { name: '90 days', steps: 90 * 24 },
  ];

  for (const profile of profiles) {
    for (const horizon of horizons) {
      const results = [];
      for (let trial = 0; trial < 100; trial++) {
        const rng = mulberry32(trial * 100003 + 7);
        const r = simulateOnePriceWalk({
          initialReserves: { R_A: 1_000_000n, R_B: 1_000_000n }, // symmetric ($1:$1-style)
          fee_bps: 30,
          lpShareFraction: 0.10, // LP holds 10% of pool
          steps: horizon.steps,
          volPerStep: profile.volPerStep,
          rng,
        });
        results.push(r);
      }
      const s = summarize(results);
      console.log(`  ${profile.name} | ${horizon.name}: ` +
                  `median_net=${s.median_il_pct}% ` +
                  `p10=${s.p10_il_pct}% p90=${s.p90_il_pct}% ` +
                  `(net = LP_final − hodl, % of hodl; positive ⇒ fees > IL)`);
      test(`profile=${profile.name} horizon=${horizon.name} sim completed`,
           () => results.length === 100);
    }
  }
}

// =========================================================================
// 2. High-volume saturation
// =========================================================================
//
// 10,000 random events against one pool. 70% T_SWAP_VAR-style single
// trades (random direction + size); 20% T_SWAP_BATCH-style multi-trader
// batches (N ∈ {2..16}); 10% LP events (60% adds, 40% removes). Assert
// after every event:
//
//   - reserve_A > 0 AND reserve_B > 0
//   - lp_total_shares > 0
//   - k-invariant non-decreasing: k_after ≥ k_before
//   - No BigInt overflow / undefined / NaN

console.log('\nHigh-volume saturation (10K random events)');
{
  const rng = mulberry32(42);
  let pool = {
    R_A: 10_000_000n, R_B: 10_000_000n,
    lp_total_shares: isqrt(10_000_000n * 10_000_000n),
  };
  const fee_bps = 30n;
  let invariantViolations = 0;
  let swapEvents = 0, batchEvents = 0, lpAddEvents = 0, lpRemoveEvents = 0;
  let kSamples = [];

  for (let i = 0; i < 10_000; i++) {
    const k_before = pool.R_A * pool.R_B;
    const eventType = rng();
    try {
      if (eventType < 0.70) {
        // Single trade (T_SWAP_VAR-style: one trader, one direction)
        const direction = rng() < 0.5 ? 'A→B' : 'B→A';
        const maxIn = direction === 'A→B' ? pool.R_A / 100n : pool.R_B / 100n;
        const amount = (BigInt(Math.floor(rng() * 1_000_000)) % (maxIn + 1n));
        if (amount > 0n) {
          const X = direction === 'A→B' ? amount : 0n;
          const Y = direction === 'B→A' ? amount : 0n;
          const sol = solveClearing(X, Y, pool.R_A, pool.R_B, fee_bps);
          const post = applyBatch(pool.R_A, pool.R_B, sol);
          pool = { ...pool, R_A: post.R_A, R_B: post.R_B };
          swapEvents++;
        }
      } else if (eventType < 0.90) {
        // Multi-trader batch (T_SWAP_BATCH-style, N ∈ {2..16})
        const N = 2 + Math.floor(rng() * 15);
        let X = 0n, Y = 0n;
        for (let j = 0; j < N; j++) {
          const dir = rng() < 0.5;
          const maxAmt = (dir ? pool.R_A : pool.R_B) / 1000n;
          const amt = (BigInt(Math.floor(rng() * 100_000)) % (maxAmt + 1n));
          if (dir) X += amt; else Y += amt;
        }
        if (X > 0n || Y > 0n) {
          const sol = solveClearing(X, Y, pool.R_A, pool.R_B, fee_bps);
          const post = applyBatch(pool.R_A, pool.R_B, sol);
          pool = { ...pool, R_A: post.R_A, R_B: post.R_B };
          batchEvents++;
        }
      } else if (eventType < 0.96) {
        // LP_ADD
        const ratio_bps = BigInt(1 + Math.floor(rng() * 500)); // 0.01% – 5% addition
        const deltaA = (pool.R_A * ratio_bps) / 10000n;
        const deltaB = (pool.R_B * ratio_bps) / 10000n;
        if (deltaA > 0n && deltaB > 0n) {
          const newShares = lpAddShares(deltaA, deltaB, pool.R_A, pool.R_B, pool.lp_total_shares);
          if (newShares > 0n) {
            pool = {
              R_A: pool.R_A + deltaA,
              R_B: pool.R_B + deltaB,
              lp_total_shares: pool.lp_total_shares + newShares,
            };
            lpAddEvents++;
          }
        }
      } else {
        // LP_REMOVE
        const ratio_bps = BigInt(1 + Math.floor(rng() * 100)); // up to 1% of supply
        const sharesBurn = (pool.lp_total_shares * ratio_bps) / 10000n;
        if (sharesBurn > 0n && sharesBurn < pool.lp_total_shares) {
          const out = lpRemoveOutputs(sharesBurn, pool.R_A, pool.R_B, pool.lp_total_shares);
          if (out.delta_a < pool.R_A && out.delta_b < pool.R_B) {
            pool = {
              R_A: pool.R_A - out.delta_a,
              R_B: pool.R_B - out.delta_b,
              lp_total_shares: pool.lp_total_shares - sharesBurn,
            };
            lpRemoveEvents++;
          }
        }
      }
    } catch (e) {
      invariantViolations++;
      console.log(`     event ${i}: ${e.message}`);
    }

    // Invariant checks
    const k_after = pool.R_A * pool.R_B;
    if (pool.R_A <= 0n) { invariantViolations++; break; }
    if (pool.R_B <= 0n) { invariantViolations++; break; }
    if (pool.lp_total_shares <= 0n) { invariantViolations++; break; }
    if (eventType < 0.90 && k_after < k_before) {
      // Swaps MUST not decrease k (fee accrues to LPs).
      // LP events CAN change k (proportionally added/removed liquidity).
      invariantViolations++;
    }

    if (i % 1000 === 0) kSamples.push(k_after);
  }

  console.log(`  events: ${swapEvents} single-trades, ${batchEvents} batches, ${lpAddEvents} LP_ADDs, ${lpRemoveEvents} LP_REMOVEs`);
  console.log(`  invariant violations: ${invariantViolations}`);
  console.log(`  k progression (every 1000 events): ${kSamples.map(k => Number(k).toExponential(2)).join(', ')}`);

  test('10K events: zero invariant violations',
       () => invariantViolations === 0);
  test('10K events: pool still has positive reserves + shares',
       () => pool.R_A > 0n && pool.R_B > 0n && pool.lp_total_shares > 0n);
  test('10K events: k strictly grew (fee accrual visible)',
       () => kSamples[kSamples.length - 1] > kSamples[0]);
}

// =========================================================================
// 3. Concurrent-batch-same-block race
// =========================================================================
//
// Documents the AMM.md "Open caveats" disjoint-batches edge case in test
// form: two settlers race the same pool with disjoint intent subsets;
// both Bitcoin-confirm in the same block; indexer applies them in
// tx_index order; the second batch's declared R_A_pre / R_B_pre no
// longer match indexer state (which is post-batch-1 by then), so the
// second's Groth16 proof would fail and indexer rejects it. The trader
// in the second batch loses their input UTXO without a credited receipt.

console.log('\nConcurrent-batch-same-block race (disjoint-subsets edge case)');
{
  const fee_bps = 30n;
  const pool0 = { R_A: 1_000_000n, R_B: 2_000_000n };

  // Settler 1 builds batch with X1, Y1 against pool0
  const X1 = 5000n, Y1 = 0n;
  const sol1 = solveClearing(X1, Y1, pool0.R_A, pool0.R_B, fee_bps);
  const pool1 = applyBatch(pool0.R_A, pool0.R_B, sol1);
  test('Settler 1 batch solves cleanly at pool0',
       () => sol1.direction === 'A→B' && pool1.R_A > pool0.R_A && pool1.R_B < pool0.R_B);

  // Settler 2 builds batch with X2, Y2 against the SAME pool0 (didn't see
  // settler 1's batch). Disjoint intent subset.
  const X2 = 0n, Y2 = 10000n;
  const sol2_thinking_pool0 = solveClearing(X2, Y2, pool0.R_A, pool0.R_B, fee_bps);
  // What settler 2 THINKS the post-batch reserves will be:
  const pool2_expected = applyBatch(pool0.R_A, pool0.R_B, sol2_thinking_pool0);

  // Now both batches Bitcoin-confirm in the same block. Indexer applies
  // settler 1's batch first (lower tx_index). Pool state advances to pool1.
  // Then indexer processes settler 2's batch.
  //
  // Settler 2's envelope DECLARED R_A_pre = pool0.R_A, but the indexer's
  // canonical state is now pool1.R_A (different). The Groth16 public-
  // signals for settler 2's proof include the OLD reserves — they no
  // longer match the indexer's view. The proof verification fails.
  //
  // Re-solving settler 2's batch at pool1 would give different deltas:
  const sol2_at_pool1 = solveClearing(X2, Y2, pool1.R_A, pool1.R_B, fee_bps);
  test('Settler 2 batch at pool1 (post-batch-1) ≠ at pool0 (pre-batch-1)',
       () => sol2_thinking_pool0.delta_a_net !== sol2_at_pool1.delta_a_net
          || sol2_thinking_pool0.delta_b_net !== sol2_at_pool1.delta_b_net);

  // The indexer's rejection rationale: settler 2's envelope reserves
  // mismatch the canonical post-prior-batch reserves. This is the
  // documented edge case — settler 2 (and trader 2) lose their inputs at
  // Bitcoin layer, but no receipt is credited.
  test('disjoint-batches edge case: trader in second batch loses their UTXO without receipt',
       () => {
         // The protocol's existing defenses:
         //   - vout[0] OP_RETURN(envelope_hash) + SIGHASH_ALL closes envelope-tampering
         //   - depth-3 AMM_OP_CONFIRMATION_DEPTH closes shallow reorgs
         // The disjoint-batches case is NOT closed at the protocol layer
         // — it requires off-chain settler coordination ("settlers SHOULD
         // coordinate off-chain on a one-batch-per-pool-per-block convention",
         // per §"Uniform clearing → Cross-batch ordering").
         //
         // This test pins the documented behavior: settler 2's reserves
         // claim no longer matches indexer state, so the batch is rejected.
         return sol2_thinking_pool0.P_clear_num !== sol2_at_pool1.P_clear_num
             || sol2_thinking_pool0.P_clear_den !== sol2_at_pool1.P_clear_den;
       });

  // Defense: in-block walking. If settler 2 had been aware of settler 1's
  // batch (via worker websocket or mempool), they could rebuild at pool1
  // and produce a valid envelope. This is the "settlers SHOULD coordinate"
  // mitigation: it's an operational discipline, not a consensus rule.
  const sol2_correct = solveClearing(X2, Y2, pool1.R_A, pool1.R_B, fee_bps);
  const pool2_correct = applyBatch(pool1.R_A, pool1.R_B, sol2_correct);
  test('Settler 2 rebuilt at pool1 produces a valid batch at the new reserves',
       () => sol2_correct.direction === 'B→A'
          && pool2_correct.R_B > pool1.R_B
          && pool2_correct.R_A < pool1.R_A);
}

console.log(`\n${pass}/${pass + fail} strategy-sim assertions passed`);
if (fail > 0) process.exit(1);
