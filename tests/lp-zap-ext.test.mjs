// The ETH zap that buys the swap half outside the pool (dapp/lp-zap.js zapPlanExt, zapPlanExtFor): the plan made before the share is proved, and the plan made again for exactly
// the proved count after it. The proof takes minutes, and the pool is other people's too: a trade or an add landing meanwhile must not cost the proof (it used to: any move at all
// made the legs miss the count, and the page said "press again", and made another proof). Reserves are a live snapshot of tETH / SPX.
//   node tests/lp-zap-ext.test.mjs
import assert from 'node:assert/strict';
import { zapPlan, zapPlanFor, zapPlanExt, zapPlanExtFor, addRoute } from '../dapp/lp-zap.js';

let n = 0;
const ok = (c, s) => { assert.ok(c, s); n++; };
const A = 10n ** 10n, ra0 = 11967348n, rb0 = 75124679189n, t0 = 946277568n, F = 30n;       // tETH in units of 1e10 wei, SPX in 1e-8, the pool's shares
const rate = 5800n * 10n ** 8n, floorRate = rate * 995n / 1000n;                             // the outside market: SPX units per ETH, and what the swap surely brings (0.5% under)
const asked = [];
const quote = async (w) => { asked.push(w); return { amountOut: w * rate / 10n ** 18n, amountLimit: w * floorRate / 10n ** 18n, callData: '0x' + 'ab'.repeat(8) + w.toString(16) }; };
const swapped = (y) => { const out = (rb0 * y * 9970n) / (ra0 * 10000n + y * 9970n); return { ra: ra0 + y, rb: rb0 - out, t: t0 }; };         // someone trades y units of tETH in
const sold = (y) => { const out = (ra0 * y * 9970n) / (rb0 * 10000n + y * 9970n); return { ra: ra0 - out, rb: rb0 + y, t: t0 }; };            // someone trades y SPX units in
const added = (bp) => ({ ra: ra0 + ra0 * BigInt(bp) / 10000n, rb: rb0 + rb0 * BigInt(bp) / 10000n, t: t0 + t0 * BigInt(bp) / 10000n });      // someone adds bp/10000 more of everything
const mints = (S, p, plan) => { const a = plan.ethLeg / A, sA = (a * p.t) / p.ra, sB = plan.bLeg * p.t / p.rb; return (sA < sB ? sA : sB) === S; };

const W = 10n ** 17n / 2n, maxEth = W + W / 50n;                                              // 0.05 ETH entered, and the 2% the page allows over it
const ext = await zapPlanExt({ eth: W, ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, quote });
ok(ext && ext.ext === true && ext.value <= W && ext.left >= 0n, 'a plan is made for 0.05 ETH, inside what was entered');
ok(mints(ext.shares, { ra: ra0, rb: rb0, t: t0 }, ext), 'its legs mint exactly its shares at the pool as quoted');

// the pool is where it was when the share was proved: the plan stands
{
  const p = await zapPlanExtFor({ shares: ext.shares, prev: ext, quote, ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, maxEth });
  ok(p && p.shares === ext.shares && p.value <= maxEth && p.floor >= p.bLeg && mints(ext.shares, { ra: ra0, rb: rb0, t: t0 }, p), 'unmoved: the same count, within the allowance, the swap brings the leg at its floor');
  ok(p.floor - p.bLeg <= p.bLeg / 500n, 'and the swap is no more than 0.2% over the leg (the rest comes back as public SPX)');
  ok(p.callData === (await quote(p.swapIn)).callData, 'the call is the quote for the size the plan ended at');
}

// the pool moves while the share is proved: the proof is kept
for (const [name, p] of [['a trade of 0.0002 ETH in', swapped(20000n)], ['a trade of 0.001 ETH in', swapped(100000n)], ['a trade of 0.003 ETH in', swapped(300000n)], ['SPX sold into it', sold(20n * 10n ** 8n)],
  ['an add of +0.5%', added(50)], ['an add of +2%', added(200)], ['an add of +5%', added(500)]]) {
  asked.length = 0;
  const q = await zapPlanExtFor({ shares: ext.shares, prev: ext, quote, ra: p.ra, rb: p.rb, total: p.t, unitA: A, unitB: 1n, maxEth });
  ok(q && q.shares === ext.shares, `${name}: the proved count is still minted`);
  ok(mints(ext.shares, p, q) && q.value <= maxEth && q.floor >= q.bLeg && q.floor - q.bLeg <= q.bLeg / 500n, `${name}: exact count, inside the allowance, the swap brings the leg and no more than 0.2% over`);
  ok(asked.length <= 5, `${name}: the swap was asked for ${asked.length} times (a few at most)`);
}
// the swap follows the leg: SPX sold into the pool makes it want more tokens per ETH, so more is bought outside; a trade of tETH in wants fewer
{
  const more = await zapPlanExtFor({ shares: ext.shares, prev: ext, quote, ra: sold(20n * 10n ** 8n).ra, rb: sold(20n * 10n ** 8n).rb, total: t0, unitA: A, unitB: 1n, maxEth });
  const less = await zapPlanExtFor({ shares: ext.shares, prev: ext, quote, ra: swapped(100000n).ra, rb: swapped(100000n).rb, total: t0, unitA: A, unitB: 1n, maxEth });
  ok(more.bLeg > ext.bLeg && less.bLeg < ext.bLeg, 'the token leg follows the pool');
  ok(more.swapIn !== ext.swapIn || less.swapIn !== ext.swapIn, 'and the swap was sized again to it');
}
// moved too far, or nothing to buy with: said, not sent
{
  const far = swapped(20000000n);                                                                 // 0.2 ETH in: more than the pool held, its price moves several times over
  ok(await zapPlanExtFor({ shares: ext.shares, prev: ext, quote, ra: far.ra, rb: far.rb, total: far.t, unitA: A, unitB: 1n, maxEth }) === null, 'a pool that moved too far for the allowance: no plan');
  ok(await zapPlanExtFor({ shares: ext.shares, prev: ext, quote: async () => null, ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, maxEth }) === null, 'no quote: no plan');
  ok(await zapPlanExtFor({ shares: ext.shares, prev: ext, quote: async (w) => ({ amountOut: 1n, amountLimit: 1n, callData: '0x' }), ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, maxEth }) === null, 'a swap that cannot bring the leg at any size it is asked for: no plan');
  ok(await zapPlanExtFor({ shares: 0n, prev: ext, quote, ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, maxEth }) === null, 'no shares: no plan');
}
// the old way of asking (a quote already in hand, for the size it was made at) still answers
{
  const q = await zapPlanExtFor({ shares: ext.shares, prev: ext, q: await quote(ext.swapIn), ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, maxEth });
  ok(q && q.shares === ext.shares, 'a quote passed in directly is taken');
}
// the in-pool plan beside it moves the way the outside one now does (the page compares them, so neither may be the fragile one)
{
  const inp = zapPlan({ eth: W, ra: ra0, rb: rb0, total: t0, feeBps: F, unitA: A, unitB: 1n });
  const p = swapped(100000n);
  ok(zapPlanFor({ shares: inp.shares, ra: p.ra, rb: p.rb, total: p.t, feeBps: F, unitA: A, unitB: 1n, maxEth, settles: true }), 'the in-pool plan survives a trade of 0.001 ETH (as before)');
}
// which way an add buys the token's half (addRoute): the thin tETH / IMD pool as it was live on 2026-11-18 (0.00222749 ETH, 1.2754 IMD, an 18-decimal token: pool unit 1e10),
// 0.0005 ETH in at 0.19 gwei. The market's plan saved less than its extra gas, so the old rule (more shares per ETH by more than the gas) chose the swap inside the pool,
// which moved the pool's price 6.6% off the market. The rule now takes the market's plan whenever the swap inside would move the pool by more than 2%.
{
  const U = 10n ** 10n, raT = 222749n, rbT = 127540718n, tT = 5330062n, imdRate = 573n, gas = 140000n * 190000000n;
  const q = async (w) => ({ amountOut: w * imdRate, amountLimit: (w * imdRate * 995n) / 1000n, callData: '0x' + 'cd'.repeat(8) + w.toString(16) });
  const eth = 5n * 10n ** 14n;
  const inPool = zapPlan({ eth, ra: raT, rb: rbT, total: tT, feeBps: F, unitA: U, unitB: U });
  const extT = await zapPlanExt({ eth, ra: raT, rb: rbT, total: tT, unitA: U, unitB: U, quote: q });
  ok(inPool && extT, 'both plans exist for 0.0005 ETH in the thin pool');
  ok(inPool.impact > 0.02, `the swap inside would move the thin pool by ${(inPool.impact * 100).toFixed(1)}% (over 2%)`);
  const per = (x) => Number(x.shares) / Number(x.value), gain = (per(extT) - per(inPool)) / per(inPool) * Number(eth);
  ok(!(gain > Number(gas) * 1.5), `the market's saving (${gain.toFixed(0)} wei) is under its extra gas (${Number(gas) * 1.5}): the old rule chose the pool`);
  ok(addRoute({ inPool, ext: extT, wei: eth, gasWei: gas }) === 'ext', 'the new rule takes the market\'s plan');
  ok(addRoute({ inPool, ext: null, wei: eth, gasWei: gas }) === 'pool', 'with no market plan it is the pool');
  ok(addRoute({ inPool: null, ext: extT, wei: eth, gasWei: gas }) === 'ext', 'with no plan inside it is the market');
  // a deep pool and a small add: the swap moves it little and the market's saving is under its gas: the pool
  const deepIn = zapPlan({ eth: 10n ** 15n, ra: ra0, rb: rb0, total: t0, feeBps: F, unitA: A, unitB: 1n });
  const deepExt = await zapPlanExt({ eth: 10n ** 15n, ra: ra0, rb: rb0, total: t0, unitA: A, unitB: 1n, quote });
  ok(deepIn.impact < 0.02 && addRoute({ inPool: deepIn, ext: deepExt, wei: 10n ** 15n, gasWei: 140000n * 5n * 10n ** 9n }) === 'pool', 'a deep pool and a small add stay inside the pool');
  // boundaries, on made-up plans
  const mk = (shares, impact = 0) => ({ shares, value: 100n, impact });
  ok(addRoute({ inPool: mk(100n, 0.02), ext: mk(100n), wei: 10n ** 18n, gasWei: 1n }) === 'pool', 'an impact of exactly 2% is not over it');
  ok(addRoute({ inPool: mk(100n, 0.0201), ext: mk(100n), wei: 10n ** 18n, gasWei: 1n }) === 'ext', 'just over 2% takes the market');
  ok(addRoute({ inPool: mk(100n), ext: mk(120n), wei: 10n ** 18n, gasWei: 1n }) === 'ext', 'a big saving over a trivial gas cost takes the market');
  ok(addRoute({ inPool: mk(100n), ext: mk(120n), wei: 10n ** 18n, gasWei: 10n ** 18n }) === 'pool', 'the same saving under a huge gas cost stays in the pool');
}
console.log(`lp-zap-ext: ${n} checks passed`);
