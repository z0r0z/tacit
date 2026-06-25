#!/usr/bin/env node
import assert from 'node:assert';
import { makeCrossChainAssets } from '../dapp/cross-chain-asset-resolver.js';
import { makeCrossChainOrderbook } from '../dapp/cross-chain-orderbook.js';
import {
  LANES,
  VENUE_KINDS,
  constantProductOut,
  makeConstantProductVenue,
  makeCrossVenueRouter,
  makeOrderbookVenue,
} from '../dapp/cross-venue-router.js';

// Browser-free deterministic "sha256" is irrelevant here because we upsert fixed ids only.
const X = makeCrossChainAssets({ sha256: (b) => new Uint8Array(32).fill(Uint8Array.from(b)[0] || 1) });
const TAC = '0x' + 'aa'.repeat(32);
const TETH = '0x' + 'bb'.repeat(32);
X.ingestBitcoin({ assetIdHex: TAC, ticker: 'TAC', decimals: 8 });
X.ingestEvm({ assetIdHex: TAC, ticker: 'TAC', decimals: 8, canonicalErc20: '0x' + '11'.repeat(20) }, 1);
X.ingestBitcoin({ assetIdHex: TETH, ticker: 'tETH', decimals: 8 });
X.ingestEvm({ assetIdHex: TETH, ticker: 'tETH', decimals: 8, canonicalErc20: '0x' + '22'.repeat(20) }, 1);

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

// 1. Same-lane AMM venues rank by best output.
{
  const btc = makeConstantProductVenue({
    id: 'btc-amm',
    kind: VENUE_KINDS.BTC_AMM,
    lane: LANES.BITCOIN,
    pools: [{ id: 'btc-pool', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 100n, feeBps: 30 }],
  });
  const evm = makeConstantProductVenue({
    id: 'evm-conf',
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    lane: LANES.ETHEREUM,
    pools: [{ id: 'evm-pool', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 130n, feeBps: 30 }],
  });
  const r = makeCrossVenueRouter({ venues: [btc, evm] });
  const q = r.bestExactIn({ assetIn: TAC, laneIn: LANES.ETHEREUM, assetOut: TETH, laneOut: LANES.ETHEREUM, amountIn: 100n });
  assert.equal(q.venueId, 'evm-conf');
  assert.equal(q.amountOut, constantProductOut(100n, 1000n, 130n, 30));
  ok('same-lane AMM quote chooses the matching EVM venue and returns deterministic constant-product output');
}

// 2. Cross-chain orderbook exact-in sweep plans multiple fills best-price first.
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  // Taker gives tETH on Ethereum to receive TAC on Bitcoin.
  const better = ob.post({ maker: 'A', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: TETH, wantAmount: 10n, wantLane: 'ethereum' });
  const worse = ob.post({ maker: 'B', giveAsset: TAC, giveAmount: 90n, giveLane: 'bitcoin', wantAsset: TETH, wantAmount: 10n, wantLane: 'ethereum' });
  const q = ob.quoteExactIn({ giveAsset: TETH, wantAsset: TAC, amountIn: 15n, giveLane: 'ethereum', wantLane: 'bitcoin' });
  assert.equal(q.amountOut, 145n); // 10 tETH -> 100 TAC, 5 tETH -> 45 TAC
  assert.equal(q.usedIn, 15n);
  assert.deepEqual(q.fills.map((f) => f.offerId), [better, worse]);
  ok('orderbook exact-in sweep consumes best-price offers first and supports partial second fill');
}

// 3. Cross-venue router compares orderbook cross-lane route against same-lane venues only when lanes match.
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  ob.post({ maker: 'A', giveAsset: TAC, giveAmount: 100n, giveLane: 'bitcoin', wantAsset: TETH, wantAmount: 10n, wantLane: 'ethereum' });
  const router = makeCrossVenueRouter({
    venues: [
      makeOrderbookVenue({ orderbook: ob }),
      makeConstantProductVenue({
        id: 'public-evm',
        kind: VENUE_KINDS.EVM_PUBLIC_AMM,
        lane: LANES.ETHEREUM,
        pools: [{ id: 'pub', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 100n, feeBps: 30 }],
      }),
    ],
  });
  const cross = router.bestExactIn({ assetIn: TETH, laneIn: LANES.ETHEREUM, assetOut: TAC, laneOut: LANES.BITCOIN, amountIn: 10n });
  assert.equal(cross.kind, VENUE_KINDS.CROSS_CHAIN_ORDERBOOK);
  assert.equal(cross.amountOut, 100n);
  assert.equal(cross.plan.fills.length, 1);

  const same = router.bestExactIn({ assetIn: TAC, laneIn: LANES.ETHEREUM, assetOut: TETH, laneOut: LANES.ETHEREUM, amountIn: 100n });
  assert.equal(same.kind, VENUE_KINDS.EVM_PUBLIC_AMM);
  ok('cross-venue router selects orderbook for cross-lane and AMM for same-lane quotes');
}

// 4. Full-fill gate rejects shallow cross-chain books, partial mode returns usable depth.
{
  const ob = makeCrossChainOrderbook({ resolver: X });
  ob.post({ maker: 'A', giveAsset: TAC, giveAmount: 50n, giveLane: 'bitcoin', wantAsset: TETH, wantAmount: 5n, wantLane: 'ethereum' });
  assert.equal(ob.quoteExactIn({ giveAsset: TETH, wantAsset: TAC, amountIn: 10n, giveLane: 'ethereum', wantLane: 'bitcoin' }), null);
  const partial = ob.quoteExactIn({ giveAsset: TETH, wantAsset: TAC, amountIn: 10n, giveLane: 'ethereum', wantLane: 'bitcoin', requireFullFill: false });
  assert.equal(partial.usedIn, 5n);
  assert.equal(partial.unusedIn, 5n);
  assert.equal(partial.amountOut, 50n);
  ok('full-fill gate is explicit, with partial-depth quotes available for UI/depth previews');
}

// 5. Multihop AMM routes are planned when they beat a direct pool.
{
  const MID = '0x' + 'cc'.repeat(32);
  const venue = makeConstantProductVenue({
    id: 'evm-conf',
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    lane: LANES.ETHEREUM,
    pools: [
      { id: 'bad-direct', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 20n, feeBps: 30 },
      { id: 'tac-mid', assetA: TAC, assetB: MID, reserveA: 1000n, reserveB: 1000n, feeBps: 30 },
      { id: 'mid-teth', assetA: MID, assetB: TETH, reserveA: 1000n, reserveB: 1000n, feeBps: 30 },
    ],
  });
  const router = makeCrossVenueRouter({ venues: [venue] });
  const best = router.bestExactIn({ assetIn: TAC, laneIn: LANES.ETHEREUM, assetOut: TETH, laneOut: LANES.ETHEREUM, amountIn: 100n });
  assert.equal(best.plan.type, 'constant-product-route');
  assert.equal(best.plan.hops.length, 2);
  assert.equal(best.plan.hops[0].poolId, 'tac-mid');
  assert.equal(best.plan.hops[1].poolId, 'mid-teth');
  assert.equal(best.kind, VENUE_KINDS.EVM_CONFIDENTIAL_AMM);
  ok('multihop same-lane AMM planning composes pool hops and ranks against direct pools');
}

// 6. Bitcoin AMM registry snapshots use the same venue adapter shape.
{
  const venue = makeConstantProductVenue({
    id: 'btc-native',
    kind: VENUE_KINDS.BTC_AMM,
    lane: LANES.BITCOIN,
    pools: [{
      pool_id: 'pool_ab',
      asset_a: TAC.slice(2),
      asset_b: TETH.slice(2),
      reserve_a: '1000',
      reserve_b: '100',
      fee_bps: 30,
      validation: 'verified',
    }],
  });
  const router = makeCrossVenueRouter({ venues: [venue] });
  const best = router.bestExactIn({ assetIn: TAC, laneIn: LANES.BITCOIN, assetOut: TETH, laneOut: LANES.BITCOIN, amountIn: 100n });
  assert.equal(best.kind, VENUE_KINDS.BTC_AMM);
  assert.equal(best.venueId, 'btc-native');
  assert.equal(best.plan.poolId, 'pool_ab');
  assert.equal(best.amountOut, constantProductOut(100n, 1000n, 100n, 30));
  ok('Bitcoin AMM pool registry fields quote through the shared constant-product venue adapter');
}

console.log(`\n${n}/6 cross-venue router checks passed`);
