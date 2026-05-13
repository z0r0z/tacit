// Deterministic clearing solve for tacit AMM uniform-price batches.
//
// Mirrors AMM.md §4 "Deterministic clearing-solve algorithm" byte-for-byte.
// Indexer determinism is normative: every indexer must compute the same
// (Δa_net, Δb_net, P_clear) for the same (X, Y, R_A, R_B, fee_bps).
//
// All arithmetic is BigInt — u128/u256 widths in pseudocode are enforced by the
// numeric type. All divisions floor toward zero (= floor toward the pool) for
// non-negative dividends, which `BigInt /` provides natively.

const U64_MAX = (1n << 64n) - 1n;
const FEE_BPS_MAX = 1000n; // 10%
const GAMMA_DEN = 10000n;
const BSEARCH_ITER_CAP = 64;

function asU64(x, name) {
  const v = BigInt(x);
  if (v < 0n || v > U64_MAX) throw new Error(`${name} must fit in u64`);
  return v;
}

// Result shape:
//   {
//     direction: 'A→B' | 'B→A' | 'spot' | 'empty',
//     delta_a_net: bigint, delta_b_net: bigint,
//     // P_clear = P_clear_num / P_clear_den (rational; never explicitly divide)
//     P_clear_num: bigint, P_clear_den: bigint,
//     iterations: number,
//   }

export function solveClearing(X, Y, R_A, R_B, fee_bps) {
  X        = asU64(X,        'X');
  Y        = asU64(Y,        'Y');
  R_A      = asU64(R_A,      'R_A');
  R_B      = asU64(R_B,      'R_B');
  fee_bps  = BigInt(fee_bps);
  if (fee_bps < 0n || fee_bps > FEE_BPS_MAX) throw new Error('fee_bps out of range');

  if (X === 0n && Y === 0n) {
    return {
      direction: 'empty',
      delta_a_net: 0n, delta_b_net: 0n,
      P_clear_num: R_A, P_clear_den: R_B === 0n ? 1n : R_B,
      iterations: 0,
    };
  }

  if (R_A === 0n || R_B === 0n) {
    throw new Error('pool reserves must be > 0 for a non-empty batch');
  }

  const gamma_num = GAMMA_DEN - fee_bps;
  const gamma_den = GAMMA_DEN;

  // Direction test: compare X·R_B vs Y·R_A in u128.
  const lhs = X * R_B;
  const rhs = Y * R_A;

  if (lhs > rhs) return solveAToB(X, Y, R_A, R_B, gamma_num, gamma_den);
  if (lhs < rhs) {
    // Symmetric: solve as B→A by swapping (X,Y) ↔ (Y,X), (R_A,R_B) ↔ (R_B,R_A),
    // run the A→B-dominant solve, swap output (delta_a, delta_b) accordingly.
    const r = solveAToB(Y, X, R_B, R_A, gamma_num, gamma_den);
    return {
      direction: 'B→A',
      delta_a_net: r.delta_b_net,
      delta_b_net: r.delta_a_net,
      // r.P_clear is units of B per A (since X,Y were swapped); the canonical
      // P_clear in the A-pool direction (A per B) is the reciprocal.
      P_clear_num: r.P_clear_den,
      P_clear_den: r.P_clear_num,
      iterations: r.iterations,
    };
  }
  // Exact-cancel batch
  return {
    direction: 'spot',
    delta_a_net: 0n, delta_b_net: 0n,
    P_clear_num: R_A, P_clear_den: R_B,
    iterations: 0,
  };
}

// A→B-dominant solve: binary search on Δa_net ∈ [1, X].
function solveAToB(X, Y, R_A, R_B, gamma_num, gamma_den) {
  let lo = 1n;
  let hi = X;
  let best = lo;
  let bestDeltaB = 0n;
  let iter = 0;

  while (iter < BSEARCH_ITER_CAP && lo <= hi) {
    const mid = lo + (hi - lo) / 2n;

    // Δb_net from curve, fee on net A inflow:
    //   Δb_net = floor(R_B · γ_num · mid / (R_A · γ_den + γ_num · mid))
    const num_db = R_B * gamma_num * mid;
    const den_db = R_A * gamma_den + gamma_num * mid;
    const delta_b = num_db / den_db; // floor

    // P_clear = X / (Y + Δb_net); compute Δa_implied = X − floor(Y · X / (Y + Δb_net))
    const denom = Y + delta_b;
    let delta_a_implied;
    if (denom === 0n) {
      // Only when Y == 0 and Δb_net == 0 (pool empty edge); the implicit
      // P_clear is infinite. Treat all of X as the implied A inflow.
      delta_a_implied = X;
    } else {
      const yx = Y * X;
      delta_a_implied = X - (yx / denom);
    }

    if (delta_a_implied === mid) {
      return {
        direction: 'A→B',
        delta_a_net: mid,
        delta_b_net: delta_b,
        P_clear_num: X,
        P_clear_den: Y + delta_b,
        iterations: iter + 1,
      };
    }
    if (delta_a_implied < mid) {
      hi = mid - 1n;
    } else {
      best = mid;
      bestDeltaB = delta_b;
      lo = mid + 1n;
    }
    iter++;
  }

  // No exact fixed point. Return the largest 'best' that was "too small."
  // Settler MUST declare exactly this (Δa_net, Δb_net); indexer recomputes
  // byte-identically and rejects anything else.
  // Recompute delta_b_net for the final 'best' so it's authoritative even when
  // bestDeltaB lagged a half-iteration behind.
  const num_db = R_B * gamma_num * best;
  const den_db = R_A * gamma_den + gamma_num * best;
  const final_delta_b = num_db / den_db;
  return {
    direction: 'A→B',
    delta_a_net: best,
    delta_b_net: final_delta_b,
    P_clear_num: X,
    P_clear_den: Y + final_delta_b,
    iterations: iter,
  };
}

// Per-trader output once P_clear is fixed.
//
//   direction 'A→B': amount_out = floor(amount_in_swap · P_clear_den / P_clear_num)
//   direction 'B→A': amount_out = floor(amount_in_swap · P_clear_num / P_clear_den)
//
// `solveClearing` returns P_clear in A-per-B (X / (Y + Δb)) units.
//   A→B trader: input A → output B = amount_in / P_clear = amount_in · den / num.
//   B→A trader: input B → output A = amount_in · P_clear = amount_in · num / den.
export function amountOutForTrader(amount_in_swap, direction, P_clear_num, P_clear_den) {
  const a = BigInt(amount_in_swap);
  if (direction === 'A→B' || direction === 0 || direction === 0n) {
    return (a * P_clear_den) / P_clear_num;
  }
  if (direction === 'B→A' || direction === 1 || direction === 1n) {
    return (a * P_clear_num) / P_clear_den;
  }
  throw new Error(`unknown direction ${direction}`);
}

// Apply the batch to pool reserves. Mutates nothing; returns new reserves.
export function applyBatch(R_A, R_B, result) {
  const Ra = BigInt(R_A), Rb = BigInt(R_B);
  if (result.direction === 'A→B') return { R_A: Ra + result.delta_a_net, R_B: Rb - result.delta_b_net };
  if (result.direction === 'B→A') return { R_A: Ra - result.delta_a_net, R_B: Rb + result.delta_b_net };
  return { R_A: Ra, R_B: Rb };
}

// LP-share formulas (AMM.md §"Indexer determinism rules: Rounding").
export function lpAddShares(delta_a, delta_b, R_A, R_B, S) {
  const da = BigInt(delta_a), db = BigInt(delta_b);
  const ra = BigInt(R_A), rb = BigInt(R_B), s = BigInt(S);
  if (s === 0n) {
    // POOL_INIT path: total shares = isqrt(Δa·Δb). Handled by lpInitShares.
    throw new Error('use lpInitShares for POOL_INIT (S == 0)');
  }
  const a = (da * s) / ra;
  const b = (db * s) / rb;
  return a < b ? a : b;
}

export function lpInitShares(delta_a, delta_b, minimum_liquidity) {
  const da = BigInt(delta_a), db = BigInt(delta_b), ml = BigInt(minimum_liquidity);
  const total = isqrt(da * db);
  if (total <= ml) throw new Error('initial liquidity below MINIMUM_LIQUIDITY');
  return { total_shares: total, founder_shares: total - ml, locked_shares: ml };
}

export function lpRemoveOutputs(share_amount, R_A, R_B, S) {
  const sa = BigInt(share_amount), ra = BigInt(R_A), rb = BigInt(R_B), s = BigInt(S);
  if (s === 0n) throw new Error('cannot remove from empty pool');
  return { delta_a: (ra * sa) / s, delta_b: (rb * sa) / s };
}

// Deterministic integer square root (Newton's method on BigInt).
export function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x = n, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}

// Qualifying-intent fixed-point computation (AMM.md §5).
//
// Each intent is { intent_id (hex string), direction ('A→B' | 'B→A'), amount_in_swap (bigint), min_out (bigint) }.
// Returns the converged qualifying subset (array; preserves intent_id sort order).
//
// Loop cap exactly matches AMM.md §5's `for iter in 0..len(candidate_set)`:
// each iter strictly shrinks `set` by ≥ 1 element or converges, so `len`
// iterations is an upper bound on progress.
export function qualifyingFixedPoint(candidate_set, R_A, R_B, fee_bps) {
  // Sort by intent_id ascending (lexicographic bytes / hex).
  let set = candidate_set.slice().sort((a, b) => (a.intent_id < b.intent_id ? -1 : a.intent_id > b.intent_id ? 1 : 0));

  for (let iter = 0; iter < candidate_set.length; iter++) {
    if (set.length === 0) return set;
    let X = 0n, Y = 0n;
    for (const it of set) {
      const ain = BigInt(it.amount_in_swap);
      if (it.direction === 'A→B') X += ain;
      else if (it.direction === 'B→A') Y += ain;
      else throw new Error(`bad direction ${it.direction}`);
    }
    let r;
    try { r = solveClearing(X, Y, R_A, R_B, fee_bps); }
    catch (e) {
      // empty / degenerate — drop and return current
      return set;
    }
    const newSet = [];
    for (const it of set) {
      const out = amountOutForTrader(it.amount_in_swap, it.direction, r.P_clear_num, r.P_clear_den);
      if (out >= BigInt(it.min_out)) newSet.push(it);
    }
    if (newSet.length === set.length) return set;
    if (newSet.length === 0) return newSet;
    set = newSet;
  }
  return []; // never reached — defensive
}
