// TacBuyback keeper sizing and venue choice (src/lib/buyback-plan.js).
//   node worker-relay/tests/buyback-plan.test.mjs

import assert from 'node:assert/strict';
import { maxBuyFor, chooseBuy, cooldownLeft, VENUE_TACIT, VENUE_PRECISION } from '../src/lib/buyback-plan.js';

const E = 10n ** 18n;
const UNIT = 10n ** 10n;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('buy size is the smallest of balance, per-buy cap and impact cap, rounded to the unit', () => {
  const b = { maxPerBuy: E / 4n, unit: UNIT, maxImpactBps: 100 };
  assert.equal(maxBuyFor({ ...b, balance: E / 10n, ethReserveWei: 100n * E }), E / 10n);
  assert.equal(maxBuyFor({ ...b, balance: 5n * E, ethReserveWei: 100n * E }), E / 4n);
  assert.equal(maxBuyFor({ ...b, balance: 5n * E, ethReserveWei: 2n * E }), 2n * E / 100n);
  assert.equal(maxBuyFor({ ...b, balance: 5n * E, ethReserveWei: 12345678901234567n }) % UNIT, 0n);
  assert.equal(maxBuyFor({ ...b, balance: 5n * E, ethReserveWei: 0n }), 0n);
});

test('the better rate wins, compared exactly; a tie goes to the larger buy', () => {
  const q = [
    { venue: VENUE_TACIT, amountIn: E / 100n, tacOut: 100n * E },     // 10,000 TAC/ETH
    { venue: VENUE_PRECISION, amountIn: E / 10n, tacOut: 1500n * E }, // 15,000 TAC/ETH
  ];
  assert.equal(chooseBuy(q, { minBuyWei: 0n, slippageBps: 50 }).venue, VENUE_PRECISION);
  const tie = [
    { venue: VENUE_TACIT, amountIn: E / 100n, tacOut: 150n * E },
    { venue: VENUE_PRECISION, amountIn: E / 10n, tacOut: 1500n * E },
  ];
  assert.equal(chooseBuy(tie, { minBuyWei: 0n, slippageBps: 50 }).venue, VENUE_PRECISION);
});

test('minimum output is the quote less slippage; dust and empty quotes are skipped', () => {
  const p = chooseBuy([{ venue: VENUE_TACIT, amountIn: E / 10n, tacOut: 1000n * E }], { minBuyWei: 0n, slippageBps: 50 });
  assert.equal(p.minTacOut, 995n * E);
  assert.equal(chooseBuy([{ venue: VENUE_TACIT, amountIn: E / 10000n, tacOut: E }], { minBuyWei: E / 1000n, slippageBps: 50 }), null);
  assert.equal(chooseBuy([{ venue: VENUE_TACIT, amountIn: E, tacOut: 0n }], { minBuyWei: 0n, slippageBps: 50 }), null);
  assert.equal(chooseBuy([], { minBuyWei: 0n, slippageBps: 50 }), null);
  const best = chooseBuy([
    { venue: VENUE_TACIT, amountIn: E / 10000n, tacOut: 10n * E }, // best rate but below the minimum buy
    { venue: VENUE_PRECISION, amountIn: E / 10n, tacOut: 1000n * E },
  ], { minBuyWei: E / 1000n, slippageBps: 50 });
  assert.equal(best.venue, VENUE_PRECISION);
});

test('cooldown mirrors the contract', () => {
  assert.equal(cooldownLeft({ lastBuyAt: 0n, cooldown: 21600n, now: 1_800_000_000 }), 0);
  assert.equal(cooldownLeft({ lastBuyAt: 1_800_000_000n, cooldown: 21600n, now: 1_800_000_100 }), 21500);
  assert.equal(cooldownLeft({ lastBuyAt: 1_800_000_000n, cooldown: 21600n, now: 1_800_021_600 }), 0);
});

console.log(`\n${n} passed`);
