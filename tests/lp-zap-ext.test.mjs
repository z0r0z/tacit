// The ETH zap that buys the swap half outside the pool (dapp/lp-zap.js zapPlanExt, zapPlanExtFor): the plan made before the share is proved, and the plan made again for exactly
// the proved count after it. The proof takes minutes, and the pool is other people's too: a trade or an add landing meanwhile must not cost the proof (it used to: any move at all
// made the legs miss the count, and the page said "press again", and made another proof). Reserves are a live snapshot of tETH / SPX.
//   node tests/lp-zap-ext.test.mjs
import assert from 'node:assert/strict';
import { zapPlan, zapPlanFor, zapPlanExt, zapPlanExtFor } from '../dapp/lp-zap.js';

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
console.log(`lp-zap-ext: ${n} checks passed`);
