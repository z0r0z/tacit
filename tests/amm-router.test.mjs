// Tests for the AMM Router reference module (amm-router.mjs).
//
// Verifies that the V2-router-style algorithm composes correctly across:
//   - 1-hop direct pools
//   - 2-hop bridged routes
//   - Mixed depth (thin direct vs deep bridge)
//   - Disconnected graphs (no route)
//   - Per-hop quote integrity (amountIn passes correctly through each hop)
//   - Slippage / min_out budgeting

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  pairKey, poolHasAsset, counterpartyAsset,
  quoteSingleHop, findBestRoute, simulateRoute, computeMinOutForRoute,
} from './amm-router.mjs';

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

function mockAssetId(label) {
  return sha256(new TextEncoder().encode(`tacit-router-test-${label}`));
}

function poolFor(asset_A, asset_B, R_A, R_B, fee_bps) {
  const a = bytesToHex(asset_A), b = bytesToHex(asset_B);
  return a < b
    ? { asset_A, asset_B, R_A, R_B, fee_bps }
    : { asset_A: asset_B, asset_B: asset_A, R_A: R_B, R_B: R_A, fee_bps };
}

const cBTC = mockAssetId('cBTC');
const T1 = mockAssetId('T1');
const T2 = mockAssetId('T2');
const T3 = mockAssetId('T3');
const ISOLATED = mockAssetId('ISOLATED');

console.log('Canonical pair-key helpers');
test('pairKey is order-independent', () => pairKey(cBTC, T1) === pairKey(T1, cBTC));
test('pairKey is deterministic', () => pairKey(cBTC, T1) === pairKey(cBTC, T1));
test('poolHasAsset returns true for both pool assets', () => {
  const p = poolFor(cBTC, T1, 1_000_000n, 100_000n, 30);
  return poolHasAsset(p, cBTC) && poolHasAsset(p, T1) && !poolHasAsset(p, T2);
});
test('counterpartyAsset returns the other side', () => {
  const p = poolFor(cBTC, T1, 1_000_000n, 100_000n, 30);
  return bytesToHex(counterpartyAsset(p, cBTC)) === bytesToHex(T1)
      && bytesToHex(counterpartyAsset(p, T1)) === bytesToHex(cBTC);
});

console.log('\nquoteSingleHop');
{
  const pool = poolFor(cBTC, T1, 10_000_000n, 1_000_000n, 30);
  const q = quoteSingleHop(pool, cBTC, 10_000n);
  test('quoteSingleHop: cBTC → T1 returns positive amount_out', () => q.amountOut > 0n);
  test('quoteSingleHop: direction inferred from assetIn (cBTC = asset_A side)',
       () => q.direction === (bytesToHex(cBTC) < bytesToHex(T1) ? 'A→B' : 'B→A'));
  test('quoteSingleHop: throws on assetIn not in pool', () => {
    try { quoteSingleHop(pool, T2, 10_000n); return false; }
    catch (e) { return /not in pool/.test(e.message); }
  });
  test('quoteSingleHop: rejects zero / negative amountIn', () => {
    try { quoteSingleHop(pool, cBTC, 0n); return false; }
    catch (e) { return /positive bigint/.test(e.message); }
  });
}

console.log('\nfindBestRoute — direct route');
{
  const registry = new Map();
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 10_000_000n, 1_000_000n, 30));
  const r = findBestRoute(registry, cBTC, T1, 10_000n);
  test('direct route present ⇒ route length 1', () => r.route.length === 1);
  test('direct route returns positive amountOut', () => r.amountOut > 0n);
  test('hopQuotes carries the single hop', () => r.hopQuotes.length === 1);
}

console.log('\nfindBestRoute — 2-hop bridge');
{
  const registry = new Map();
  // Thin direct pool
  registry.set(pairKey(T1, T2), poolFor(T1, T2, 10_000n, 10_000n, 30));
  // Deep bridge via cBTC
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 10_000_000n, 10_000_000n, 30));
  registry.set(pairKey(cBTC, T2), poolFor(cBTC, T2, 10_000_000n, 10_000_000n, 30));

  const r = findBestRoute(registry, T1, T2, 50_000n);
  test('thin direct vs deep bridge ⇒ router picks the 2-hop bridge',
       () => r.route.length === 2);
  test('2-hop hopQuotes carries both legs',
       () => r.hopQuotes.length === 2
          && r.hopQuotes[0].amountOut === r.hopQuotes[1].amountIn);
}

console.log('\nfindBestRoute — no path');
{
  const registry = new Map();
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 1_000_000n, 100_000n, 30));
  // T2 doesn't appear anywhere
  const r = findBestRoute(registry, T1, T2, 1_000n);
  test('no path ⇒ amountOut = 0n and route = null',
       () => r.amountOut === 0n && r.route === null);
  test('no path ⇒ hopQuotes empty', () => r.hopQuotes.length === 0);
}

console.log('\nfindBestRoute — ISOLATED asset (only in one pool, no bridge)');
{
  const registry = new Map();
  // cBTC is in two pools (T1 and T2 bridges), ISOLATED is only paired with T3
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 1_000_000n, 100_000n, 30));
  registry.set(pairKey(cBTC, T2), poolFor(cBTC, T2, 1_000_000n, 100_000n, 30));
  registry.set(pairKey(ISOLATED, T3), poolFor(ISOLATED, T3, 1_000_000n, 100_000n, 30));
  // Trying to route T1 → ISOLATED: no direct, no 2-hop (T3 isn't bridged anywhere)
  const r = findBestRoute(registry, T1, ISOLATED, 1_000n);
  test('disconnected subgraph: T1 → ISOLATED has no route',
       () => r.amountOut === 0n);
}

console.log('\nfindBestRoute — equal-depth pools, prefer direct (fewer hops)');
{
  const registry = new Map();
  registry.set(pairKey(T1, T2), poolFor(T1, T2, 1_000_000n, 1_000_000n, 30));
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 1_000_000n, 1_000_000n, 30));
  registry.set(pairKey(cBTC, T2), poolFor(cBTC, T2, 1_000_000n, 1_000_000n, 30));
  const r = findBestRoute(registry, T1, T2, 1_000n);
  test('equal depth ⇒ direct route wins (less fee compounding)',
       () => r.route.length === 1 && r.route[0] === pairKey(T1, T2));
}

console.log('\nfindBestRoute — basic validation');
{
  const registry = new Map();
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 1_000_000n, 100_000n, 30));
  test('amountIn = 0n throws', () => {
    try { findBestRoute(registry, cBTC, T1, 0n); return false; }
    catch (e) { return /positive bigint/.test(e.message); }
  });
  test('assetIn == assetOut throws', () => {
    try { findBestRoute(registry, cBTC, cBTC, 1_000n); return false; }
    catch (e) { return /assetIn == assetOut/.test(e.message); }
  });
}

console.log('\nsimulateRoute — walk a fixed path');
{
  const registry = new Map();
  registry.set(pairKey(cBTC, T1), poolFor(cBTC, T1, 10_000_000n, 1_000_000n, 30));
  registry.set(pairKey(cBTC, T2), poolFor(cBTC, T2, 10_000_000n, 1_000_000n, 30));

  // Manually pick a 2-hop route T1 → cBTC → T2
  const route = [pairKey(T1, cBTC), pairKey(cBTC, T2)];
  const sim = simulateRoute(registry, route, T1, 10_000n);
  test('simulateRoute: 2-hop walk produces consistent hop output threading',
       () => sim.hops.length === 2
          && sim.hops[0].amountOut === sim.hops[1].amountIn
          && sim.amountOut === sim.hops[sim.hops.length - 1].amountOut);
  test('simulateRoute: final asset matches target',
       () => bytesToHex(sim.finalAsset) === bytesToHex(T2));
  test('simulateRoute: missing pool in route throws', () => {
    try { simulateRoute(registry, [pairKey(T1, T3)], T1, 1_000n); return false; }
    catch (e) { return /not in registry/.test(e.message); }
  });
}

console.log('\ncomputeMinOutForRoute — slippage helper');
{
  test('0% slippage ⇒ min_out == quote', () =>
    computeMinOutForRoute(1_000_000n, 0) === 1_000_000n);
  test('1% slippage ⇒ min_out = 99% of quote', () =>
    computeMinOutForRoute(1_000_000n, 100) === 990_000n);
  test('5% slippage ⇒ min_out = 95% of quote', () =>
    computeMinOutForRoute(1_000_000n, 500) === 950_000n);
  test('100% slippage ⇒ min_out = 0', () =>
    computeMinOutForRoute(1_000_000n, 10000) === 0n);
  test('rejects negative slippage', () => {
    try { computeMinOutForRoute(1n, -1); return false; }
    catch (e) { return /slippageBps/.test(e.message); }
  });
  test('rejects > 10000 bps slippage', () => {
    try { computeMinOutForRoute(1n, 10001); return false; }
    catch (e) { return /slippageBps/.test(e.message); }
  });
}

console.log(`\n${pass}/${pass + fail} router tests passed`);
if (fail > 0) process.exit(1);
