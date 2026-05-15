// AMM Router — reference implementation of Uniswap-V2-router-style
// best-path selection across tacit AMM pools.
//
// Pure dapp-side orchestration: no envelopes, no signing, no Bitcoin txs.
// Composes the math layer (`amm-clearing.mjs`) to pick the best 1-hop or
// 2-hop route between two tacit assets. Dapps wire this into their swap
// tile alongside the orderbook-DEX router.
//
// V1 atomicity: each hop in a multi-hop route settles as an independent
// Bitcoin tx (`T_SWAP_VAR`). Between hops, other traders can shift the
// intermediate pool's spot, so multi-hop is "best effort" with per-hop
// `min_out` slippage protection. Atomic multi-hop is the
// `SPEC-TRADE-BATCH-AMENDMENT.md` scope (V1.x / V2 deliverable).

import { bytesToHex } from '@noble/hashes/utils';
import { solveClearing, amountOutForTrader } from './amm-clearing.mjs';

// ---------------------------------------------------------------------------
// Canonical pair-key helpers
// ---------------------------------------------------------------------------

// Canonical pair key for a (asset_A, asset_B) pool. Sort lex-smaller first so
// any two callers compute the same key for the same unordered pair.
export function pairKey(assetA, assetB) {
  const a = bytesToHex(assetA);
  const b = bytesToHex(assetB);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Returns true iff the given asset_id (Uint8Array) appears in this pool.
export function poolHasAsset(pool, assetId) {
  const h = bytesToHex(assetId);
  return bytesToHex(pool.asset_A) === h || bytesToHex(pool.asset_B) === h;
}

// Returns the "other side" of a pool given one asset. Throws if the asset
// is not in the pool.
export function counterpartyAsset(pool, assetId) {
  const h = bytesToHex(assetId);
  if (bytesToHex(pool.asset_A) === h) return pool.asset_B;
  if (bytesToHex(pool.asset_B) === h) return pool.asset_A;
  throw new Error('counterpartyAsset: asset not in pool');
}

// ---------------------------------------------------------------------------
// Quote a single-hop swap
// ---------------------------------------------------------------------------

// Compute the exact `amount_out` for `(assetIn, amountIn)` through a single
// pool. Returns the bigint amount_out plus the direction used.
//
// Wraps `solveClearing` for the single-trader case; mirrors the math the
// validator enforces in-circuit for `T_SWAP_VAR` (and exactly per-trader
// in `T_SWAP_BATCH` once `P_clear` is fixed).
export function quoteSingleHop(pool, assetIn, amountIn) {
  if (!poolHasAsset(pool, assetIn)) throw new Error('quoteSingleHop: assetIn not in pool');
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) {
    throw new Error('quoteSingleHop: amountIn must be a positive bigint');
  }
  const direction = bytesToHex(assetIn) === bytesToHex(pool.asset_A) ? 'A→B' : 'B→A';
  const X = direction === 'A→B' ? amountIn : 0n;
  const Y = direction === 'B→A' ? amountIn : 0n;
  const sol = solveClearing(X, Y, pool.R_A, pool.R_B, BigInt(pool.fee_bps));
  const amountOut = amountOutForTrader(amountIn, direction, sol.P_clear_num, sol.P_clear_den);
  return { amountOut, direction, solution: sol };
}

// ---------------------------------------------------------------------------
// Find best route (1-hop or 2-hop)
// ---------------------------------------------------------------------------

// `registry` is a Map<pair-key, pool-object>. Each pool-object has fields
// `{ asset_A, asset_B, R_A, R_B, fee_bps }` (the canonical V1 pool state).
//
// Returns `{ route, amountOut, hopQuotes }`:
//   - `route` is an array of pair-keys traversed (length 1 = direct, 2 = bridged)
//   - `amountOut` is the bigint output if the route settles cleanly
//   - `hopQuotes` is the per-hop `{ pool, assetIn, amountIn, amountOut, direction }`
//
// Returns `{ route: null, amountOut: 0n, hopQuotes: [] }` if no path exists.
//
// Selection rule: maximize `amountOut`. Ties broken by route length (prefer
// fewer hops to minimize per-hop slippage compounding and per-hop tx fees).
export function findBestRoute(registry, assetIn, assetOut, amountIn) {
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) {
    throw new Error('findBestRoute: amountIn must be a positive bigint');
  }
  const inHex = bytesToHex(assetIn);
  const outHex = bytesToHex(assetOut);
  if (inHex === outHex) throw new Error('findBestRoute: assetIn == assetOut');

  let best = { route: null, amountOut: 0n, hopQuotes: [] };

  // 1-hop direct
  const directKey = pairKey(assetIn, assetOut);
  if (registry.has(directKey)) {
    const pool = registry.get(directKey);
    const q = quoteSingleHop(pool, assetIn, amountIn);
    best = {
      route: [directKey],
      amountOut: q.amountOut,
      hopQuotes: [{ pool, assetIn, amountIn, amountOut: q.amountOut, direction: q.direction }],
    };
  }

  // 2-hop: enumerate intermediate assets
  const allAssets = new Set();
  for (const pool of registry.values()) {
    allAssets.add(bytesToHex(pool.asset_A));
    allAssets.add(bytesToHex(pool.asset_B));
  }
  for (const interHex of allAssets) {
    if (interHex === inHex || interHex === outHex) continue;
    const intermediate = hexToBytes32(interHex);
    const hop1Key = pairKey(assetIn, intermediate);
    const hop2Key = pairKey(intermediate, assetOut);
    const pool1 = registry.get(hop1Key);
    const pool2 = registry.get(hop2Key);
    if (!pool1 || !pool2) continue;

    const q1 = quoteSingleHop(pool1, assetIn, amountIn);
    if (q1.amountOut <= 0n) continue;
    const q2 = quoteSingleHop(pool2, intermediate, q1.amountOut);
    if (q2.amountOut <= 0n) continue;

    if (q2.amountOut > best.amountOut
        || (q2.amountOut === best.amountOut && best.route !== null && best.route.length > 2)) {
      best = {
        route: [hop1Key, hop2Key],
        amountOut: q2.amountOut,
        hopQuotes: [
          { pool: pool1, assetIn, amountIn, amountOut: q1.amountOut, direction: q1.direction },
          { pool: pool2, assetIn: intermediate, amountIn: q1.amountOut, amountOut: q2.amountOut, direction: q2.direction },
        ],
      };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Simulate a fixed route (i.e., the trader chose a path; quote per hop)
// ---------------------------------------------------------------------------

// Walk through a fixed route (array of pair-keys) starting from
// `(assetIn, amountIn)`. Returns the per-hop quote stack ending at `amountOut`.
// Throws if any hop is unroutable (pool missing, asset mismatch, zero out).
export function simulateRoute(registry, route, assetIn, amountIn) {
  let currentAsset = assetIn;
  let currentAmount = amountIn;
  const hops = [];
  for (const key of route) {
    const pool = registry.get(key);
    if (!pool) throw new Error(`simulateRoute: pool not in registry: ${key}`);
    const q = quoteSingleHop(pool, currentAsset, currentAmount);
    if (q.amountOut <= 0n) throw new Error(`simulateRoute: hop produces zero output: ${key}`);
    hops.push({
      pool, assetIn: currentAsset, amountIn: currentAmount,
      amountOut: q.amountOut, direction: q.direction,
    });
    currentAsset = counterpartyAsset(pool, currentAsset);
    currentAmount = q.amountOut;
  }
  return { hops, amountOut: currentAmount, finalAsset: currentAsset };
}

// ---------------------------------------------------------------------------
// min_out / slippage helpers
// ---------------------------------------------------------------------------

// Compute the trader's `min_out` for a quoted route under a given slippage
// tolerance (in basis points; 100 = 1%). Applied to the FINAL hop's output.
//
// For multi-hop routes in V1, each hop is independent. The dapp picks a
// per-hop `min_out` (the validator only sees one min_out per intent, per
// envelope). The "route-level" min_out below is the FINAL expected output
// reduced by the slippage budget — useful for end-user UX ("you'll receive
// at least X").
export function computeMinOutForRoute(routeQuoteAmount, slippageBps) {
  if (typeof routeQuoteAmount !== 'bigint' || routeQuoteAmount < 0n) {
    throw new Error('computeMinOutForRoute: routeQuoteAmount must be a non-negative bigint');
  }
  if (typeof slippageBps !== 'number' || slippageBps < 0 || slippageBps > 10000) {
    throw new Error('computeMinOutForRoute: slippageBps must be 0..10000');
  }
  const numerator = BigInt(10000 - slippageBps);
  return (routeQuoteAmount * numerator) / 10000n;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes32(hex) {
  if (hex.length !== 64) throw new Error('hexToBytes32: expected 64 hex chars');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
