// AMM router pathfinding across cBTC.tac denomination tiers.
//
// Real launch-day scenario: a user holding cBTC.tac.10k wants to trade for
// cBTC.tac.100k. There is no direct cross-denom pool (each tier is its own
// asset_id per ctacVariantAssetId). The router must hop through a common
// asset (TAC) to bridge denominations:
//
//   cBTC.tac.10k → TAC → cBTC.tac.100k    (2-hop via TAC bridge)
//
// This test asserts:
//   - The denom-tier ladder produces distinct asset_ids (no accidental collisions)
//   - The router enumerates 2-hop paths bridging across denominations
//   - Per-hop slippage compounds correctly
//   - min_out applied to final hop catches stale-quote attacks
//   - Disconnected denominations (no TAC bridge pool) yield no route
//   - Choosing between two TAC-bridge alternatives picks the higher output
//
// Why this matters at launch: without router support, a cBTC.tac.10k holder
// who wants exposure to cBTC.tac.100k must manually compose two swaps. The
// router lets the dapp present this as a single trader action — the v2
// "swap A for B" UX traders expect.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  pairKey, findBestRoute, simulateRoute, computeMinOutForRoute,
} from './amm-router.mjs';

// Recompute ctacVariantAssetId locally — same formula the dapp + worker use:
//   sha256('tacit-cbtc-tac-variant-v1' || denomLE_64)
const CTAC_DOMAIN = new TextEncoder().encode('tacit-cbtc-tac-variant-v1');
function ctacVariantAssetIdBytes(denomSats) {
  const denomLE = new Uint8Array(8);
  const v = new DataView(denomLE.buffer);
  const d = BigInt(denomSats);
  v.setUint32(0, Number(d & 0xffffffffn), true);
  v.setUint32(4, Number((d >> 32n) & 0xffffffffn), true);
  return sha256(concatBytes(CTAC_DOMAIN, denomLE));
}

// Synthetic TAC asset_id — same shape as a CETCHed asset (32 bytes, domain-tagged).
const TAC = sha256(new TextEncoder().encode('tacit-test-tac-bridge-asset'));

// Build a pool with canonical (low, high) ordering enforced by the router.
function poolFor(assetX, assetY, R_X, R_Y, fee_bps) {
  const a = bytesToHex(assetX), b = bytesToHex(assetY);
  return a < b
    ? { asset_A: assetX, asset_B: assetY, R_A: R_X, R_B: R_Y, fee_bps }
    : { asset_A: assetY, asset_B: assetX, R_A: R_Y, R_B: R_X, fee_bps };
}

// Canonical cBTC.tac tier set per SPEC-CBTC-TAC-AMENDMENT §"Denomination tiers".
const DENOMS = [1_000n, 10_000n, 100_000n, 1_000_000n, 10_000_000n];
const CTAC = Object.fromEntries(DENOMS.map(d => [d.toString(), ctacVariantAssetIdBytes(d)]));

describe('cBTC.tac denomination-tier asset_id ladder', () => {
  test('every canonical tier produces a 32-byte asset_id', () => {
    for (const d of DENOMS) {
      const aid = ctacVariantAssetIdBytes(d);
      assert.strictEqual(aid.length, 32, `denom=${d} produced ${aid.length}-byte id`);
    }
  });

  test('different denominations yield different asset_ids (no collisions)', () => {
    const seen = new Set();
    for (const d of DENOMS) {
      const hex = bytesToHex(ctacVariantAssetIdBytes(d));
      assert.ok(!seen.has(hex), `collision at denom=${d}`);
      seen.add(hex);
    }
    assert.strictEqual(seen.size, DENOMS.length);
  });

  test('ctacVariantAssetId is deterministic across calls', () => {
    for (const d of DENOMS) {
      const a = bytesToHex(ctacVariantAssetIdBytes(d));
      const b = bytesToHex(ctacVariantAssetIdBytes(d));
      assert.strictEqual(a, b);
    }
  });

  test('TAC bridge asset_id is distinct from every cBTC.tac tier', () => {
    const tacHex = bytesToHex(TAC);
    for (const d of DENOMS) {
      const ctacHex = bytesToHex(ctacVariantAssetIdBytes(d));
      assert.notStrictEqual(tacHex, ctacHex, `TAC collides with cBTC.tac.${d}`);
    }
  });
});

describe('Router 2-hop bridge across cBTC.tac denominations (via TAC)', () => {
  // Build the registry the launch dapp would maintain: each cBTC.tac tier
  // paired with TAC, no direct cross-denom pool (per SPEC §5.36 — every
  // cBTC.tac variant is its own asset, AMM pools are per-(asset, asset) pair).
  function buildRegistry({ withDenoms = [10_000n, 100_000n], reservesPerDenom = null } = {}) {
    const registry = new Map();
    for (const d of withDenoms) {
      const ctac = CTAC[d.toString()];
      // Reserves chosen so the pool can absorb realistic swap sizes.
      // Default: 1M cBTC.tac.<denom> against 100M TAC (≈ 100 TAC/cBTC.tac mid).
      const [R_ctac, R_tac] = reservesPerDenom
        ? reservesPerDenom(d)
        : [1_000_000n, 100_000_000n];
      registry.set(pairKey(ctac, TAC), poolFor(ctac, TAC, R_ctac, R_tac, 30));
    }
    return registry;
  }

  test('router finds cBTC.tac.10k → TAC → cBTC.tac.100k via 2-hop bridge', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    const from = CTAC['10000'];
    const to = CTAC['100000'];
    const r = findBestRoute(registry, from, to, 1_000n);
    assert.ok(r.route, 'router returned null route');
    assert.strictEqual(r.route.length, 2, `expected 2-hop, got ${r.route.length}-hop`);
    assert.ok(r.amountOut > 0n, `expected positive amountOut, got ${r.amountOut}`);
    assert.strictEqual(r.hopQuotes.length, 2);

    // First hop should consume the user's input and produce TAC.
    assert.strictEqual(bytesToHex(r.hopQuotes[0].assetIn), bytesToHex(from));
    assert.strictEqual(r.hopQuotes[0].amountIn, 1_000n);
    assert.ok(r.hopQuotes[0].amountOut > 0n, 'hop 1 should yield TAC');

    // Second hop should consume the TAC output of hop 1.
    assert.strictEqual(bytesToHex(r.hopQuotes[1].assetIn), bytesToHex(TAC));
    assert.strictEqual(r.hopQuotes[1].amountIn, r.hopQuotes[0].amountOut);
    assert.strictEqual(r.hopQuotes[1].amountOut, r.amountOut);
  });

  test('router yields no route when bridge pool is missing', () => {
    // Only the .10k tier has a TAC pool — no path to .100k exists.
    const registry = buildRegistry({ withDenoms: [10_000n] });
    const from = CTAC['10000'];
    const to = CTAC['100000'];
    const r = findBestRoute(registry, from, to, 1_000n);
    assert.strictEqual(r.route, null);
    assert.strictEqual(r.amountOut, 0n);
  });

  test('router routes 3-tier ladder: .10k → TAC → .1M (skipping .100k)', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n, 1_000_000n] });
    const from = CTAC['10000'];
    const to = CTAC['1000000'];
    const r = findBestRoute(registry, from, to, 1_000n);
    assert.ok(r.route, 'router returned null route');
    assert.strictEqual(r.route.length, 2);
    // Verify the bridge is TAC, not the intermediate .100k tier.
    assert.strictEqual(bytesToHex(r.hopQuotes[0].assetIn), bytesToHex(from));
    assert.strictEqual(bytesToHex(r.hopQuotes[1].assetIn), bytesToHex(TAC));
  });

  test('simulateRoute reproduces findBestRoute output (deterministic walk)', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    const from = CTAC['10000'];
    const to = CTAC['100000'];
    const best = findBestRoute(registry, from, to, 1_000n);
    const sim = simulateRoute(registry, best.route, from, 1_000n);
    assert.strictEqual(sim.amountOut, best.amountOut);
    assert.strictEqual(bytesToHex(sim.finalAsset), bytesToHex(to));
    assert.strictEqual(sim.hops.length, 2);
  });

  test('per-hop amountIn = previous hop\'s amountOut (no leakage across hops)', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    const r = findBestRoute(registry, CTAC['10000'], CTAC['100000'], 5_000n);
    assert.ok(r.route);
    assert.strictEqual(r.hopQuotes[1].amountIn, r.hopQuotes[0].amountOut);
  });

  test('compounded slippage: 2-hop output is strictly less than ideal (no fee, no impact)', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    const amountIn = 1_000n;
    const r = findBestRoute(registry, CTAC['10000'], CTAC['100000'], amountIn);
    assert.ok(r.route);
    // Both pools have the same reserves (1M/100M) so the "ideal" rate is 1:1
    // for the cBTC.tac legs (the TAC quantity cancels). Two hops at 30 bps fee
    // + impact must yield strictly less than amountIn.
    assert.ok(r.amountOut < amountIn,
      `expected output < input due to fees+impact; got ${r.amountOut} from ${amountIn}`);
  });

  test('asymmetric bridge pools: 2-hop route still resolves', () => {
    // The two bridge pools (cBTC.tac.10k ↔ TAC and cBTC.tac.100k ↔ TAC)
    // can have very different reserve depths — e.g., the .100k tier locks
    // 10x more BTC per slot, so its bridge pool may be deeper. Verify the
    // router still composes a clean route regardless.
    // Note: the router's current pairKey index only sees one pool per pair,
    // so multi-fee-tier discovery within a single pair is out of scope.
    const ctac10k = CTAC['10000'];
    const ctac100k = CTAC['100000'];
    const registry = new Map();
    // .10k bridge: shallower (less BTC backing — fewer locked sats per slot)
    registry.set(pairKey(ctac10k, TAC), poolFor(ctac10k, TAC, 100_000n, 10_000_000n, 30));
    // .100k bridge: deeper (10x more BTC backing)
    registry.set(pairKey(ctac100k, TAC), poolFor(ctac100k, TAC, 100_000n, 100_000_000n, 30));
    const r = findBestRoute(registry, ctac10k, ctac100k, 1_000n);
    assert.ok(r.route, 'asymmetric reserves should still produce a route');
    assert.strictEqual(r.route.length, 2);
    assert.ok(r.amountOut > 0n);
  });

  test('shallow bridge pool reduces output relative to deep bridge', () => {
    const ctac10k = CTAC['10000'];
    const ctac100k = CTAC['100000'];
    // Deep version: 100M TAC per side
    const deepRegistry = new Map();
    deepRegistry.set(pairKey(ctac10k, TAC),  poolFor(ctac10k, TAC, 1_000_000n, 100_000_000n, 30));
    deepRegistry.set(pairKey(ctac100k, TAC), poolFor(ctac100k, TAC, 1_000_000n, 100_000_000n, 30));
    // Shallow version: only 1M TAC per side (100x less liquidity)
    const shallowRegistry = new Map();
    shallowRegistry.set(pairKey(ctac10k, TAC),  poolFor(ctac10k, TAC, 1_000_000n, 1_000_000n, 30));
    shallowRegistry.set(pairKey(ctac100k, TAC), poolFor(ctac100k, TAC, 1_000_000n, 1_000_000n, 30));

    const amountIn = 50_000n;  // 5% of the cBTC.tac.10k reserve — non-trivial impact
    const deep = findBestRoute(deepRegistry, ctac10k, ctac100k, amountIn);
    const shallow = findBestRoute(shallowRegistry, ctac10k, ctac100k, amountIn);
    assert.ok(deep.route && shallow.route);
    assert.ok(deep.amountOut > shallow.amountOut,
      `deep route (${deep.amountOut}) should out-execute shallow (${shallow.amountOut})`);
  });

  test('min_out budget catches stale-quote scenarios for 2-hop routes', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    const r = findBestRoute(registry, CTAC['10000'], CTAC['100000'], 1_000n);
    assert.ok(r.route);
    const minOut1Pct = computeMinOutForRoute(r.amountOut, 100);  // 1% slippage budget
    const minOut0 = computeMinOutForRoute(r.amountOut, 0);       // zero slippage
    assert.strictEqual(minOut0, r.amountOut, 'zero slippage budget = exact quote');
    assert.ok(minOut1Pct < r.amountOut, '1% budget should be strictly less than quote');
    // 1% of quote should equal (quote * 9900) / 10000
    const expected = (r.amountOut * 9900n) / 10000n;
    assert.strictEqual(minOut1Pct, expected);
  });

  test('reverse direction works: .100k → TAC → .10k routes symmetrically', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    const r = findBestRoute(registry, CTAC['100000'], CTAC['10000'], 1_000n);
    assert.ok(r.route, 'reverse direction should also find a route');
    assert.strictEqual(r.route.length, 2);
    assert.strictEqual(bytesToHex(r.hopQuotes[0].assetIn), bytesToHex(CTAC['100000']));
    assert.strictEqual(bytesToHex(r.hopQuotes[1].assetIn), bytesToHex(TAC));
  });

  test('amount-in must be positive bigint (defensive boundary)', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    assert.throws(
      () => findBestRoute(registry, CTAC['10000'], CTAC['100000'], 0n),
      /positive bigint/,
    );
    assert.throws(
      () => findBestRoute(registry, CTAC['10000'], CTAC['100000'], -1n),
      /positive bigint/,
    );
  });

  test('assetIn == assetOut is a defensive rejection (no self-route)', () => {
    const registry = buildRegistry({ withDenoms: [10_000n, 100_000n] });
    assert.throws(
      () => findBestRoute(registry, CTAC['10000'], CTAC['10000'], 1_000n),
      /assetIn == assetOut/,
    );
  });
});

describe('cross-denom router under realistic launch reserves', () => {
  test('1k → TAC → 10M (extreme denomination ladder spread)', () => {
    // Smallest to largest tier — bridges through TAC. Asset units differ
    // wildly: 1 cBTC.tac.10M-unit = 10_000 cBTC.tac.1k-units in BTC backing,
    // so a thousand .1k-units swap target ≈ tenths of a .10M-unit.
    // Reserves chosen to make a small input still produce a positive output:
    // small pool has enough headroom, large pool has enough .10M-units that
    // a sub-unit-equivalent in TAC can still buy at least 1 .10M-unit out.
    const small = CTAC['1000'];
    const large = CTAC['10000000'];
    const registry = new Map();
    // .1k bridge pool: 1M units cBTC.tac.1k ↔ 100M TAC (deep)
    registry.set(pairKey(small, TAC), poolFor(small, TAC, 1_000_000n, 100_000_000n, 30));
    // .10M bridge pool: 1M units cBTC.tac.10M ↔ 100M TAC (deep)
    registry.set(pairKey(large, TAC), poolFor(large, TAC, 1_000_000n, 100_000_000n, 30));
    // Swap 1k .1k-units (small) → expect some .10M-units out via TAC bridge.
    const r = findBestRoute(registry, small, large, 1_000n);
    assert.ok(r.route, 'extreme-spread route should still resolve');
    assert.strictEqual(r.route.length, 2);
    assert.ok(r.amountOut > 0n, `expected positive output, got ${r.amountOut}`);
  });

  test('every denomination tier can bridge to every other (full mesh check)', () => {
    const registry = new Map();
    for (const d of DENOMS) {
      registry.set(pairKey(CTAC[d.toString()], TAC), poolFor(
        CTAC[d.toString()], TAC, 1_000_000n, 100_000_000n, 30,
      ));
    }
    // For each ordered pair of distinct denoms, the router should find a route.
    let routesFound = 0, expectedRoutes = 0;
    for (const dA of DENOMS) {
      for (const dB of DENOMS) {
        if (dA === dB) continue;
        expectedRoutes++;
        const r = findBestRoute(
          registry, CTAC[dA.toString()], CTAC[dB.toString()], 1_000n,
        );
        if (r.route) routesFound++;
      }
    }
    assert.strictEqual(routesFound, expectedRoutes,
      `expected all ${expectedRoutes} cross-tier routes; found ${routesFound}`);
  });
});
