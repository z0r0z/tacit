// swap/route.js poolImpact: what a swap through the private pools gives up to their prices, from the reserves the quote carries (the Swap tab's "Price impact" row, and its confirm step above 10%).
//   node tests/pool-impact.test.mjs
import assert from 'node:assert/strict';
import { poolImpact } from '../dapp/swap/route.js';

let n = 0;
const ok = (c, s) => { assert.ok(c, s); n++; };
const near = (a, b, tol, s) => ok(Math.abs(a - b) <= tol, `${s} (${a} vs ${b})`);
const U = 10n ** 8n;

// one pool, a fee of 30 basis points: a tiny swap gives up about the fee, a big one the fee and the price move
{
  const pool = { feeBps: 30, ra: 100_000n * U, rb: 200_000n * U };
  near(poolImpact([pool], 1n * U).impact, 0.003, 0.0001, 'a swap of one in a hundred thousand: the fee');
  const p = poolImpact([pool], 10_000n * U);                                    // a tenth of what the pool holds on the paying side
  const g = 10_000n * U * 9970n, out = (200_000n * U * g) / (100_000n * U * 10000n + g);
  ok(p.out === out, 'the out is the constant product at the fee');
  near(p.impact, 1 - (Number(out) / Number(10_000n * U)) / 2, 1e-9, 'the impact is how far the rate fell from the pool\'s own price');
  near(p.impact, 1 - 0.997 / 1.0997, 1e-9, 'a tenth of the pool, the fee included: 1 - 0.997 / (1 + 0.1 x 0.997)');
}
// the SPX pool as it stood: 6 SPX into 751 SPX / 0.1197 tETH (the page said 1.09%)
{
  const pool = { feeBps: 30, ra: 75_124_679_189n, rb: 11_967_348n };
  near(poolImpact([pool], 6n * U).impact, 0.0109, 0.0003, 'the pool the page showed 1.09% for');
  near(poolImpact([pool], 100n * U).impact, 0.120, 0.003, 'and 12% for a hundred');
}
// two pools in a row (through tETH): the second takes what the first pays out, and what is given up compounds
{
  const a = { feeBps: 30, ra: 1_000n * U, rb: 2_000n * U }, b = { feeBps: 5, ra: 3_000n * U, rb: 6_000n * U };
  const one = poolImpact([a], 100n * U), two = poolImpact([a, b], 100n * U), second = poolImpact([b], one.out);
  ok(two.out === second.out, 'the second pool is paid what the first paid out');
  near(two.impact, 1 - (1 - one.impact) * (1 - second.impact), 1e-12, 'what is given up compounds');
}
// nothing to say: an empty pool, no pools, an empty swap, a swap that buys nothing
ok(poolImpact([{ feeBps: 30, ra: 0n, rb: 5n * U }], U) === null, 'an empty pool');
ok(poolImpact([], U) === null && poolImpact(undefined, U) === null, 'no pools');
ok(poolImpact([{ feeBps: 30, ra: 5n * U, rb: 5n * U }], 0n) === null, 'an empty swap');
ok(poolImpact([{ feeBps: 30, ra: 10n ** 18n, rb: 5n }], 1n) === null, 'a swap that buys nothing');
ok(poolImpact([{ ra: 100n * U, rb: 100n * U }], U).impact > 0.003, 'a pool with no fee named is taken at 30 basis points');
console.log(`pool-impact: ${n} checks passed`);
