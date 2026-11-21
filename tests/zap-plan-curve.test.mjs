#!/usr/bin/env node
// The one-transaction buy-and-shield plan (route.js zapShieldPlan) over a REAL zQuoter answer whose best route is a Curve pool the guard does not list
// (fixtures/curve-crv-quote.json: ETH -> CRV through Curve, paid to the ConfidentialRouter):
//   - without a proven pool the plan refuses it, with the guard's own reason (nothing is sent on a route the guard does not know)
//   - with the pool the aggregator proved by simulation (the quote's `curvePools`), the same calldata makes a plan: the router swaps, wraps the least and returns the rest
//   - a pool that is not the route's own does not unlock it, and a plan still refuses a different recipient, amount or deadline
//   node tests/zap-plan-curve.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { zapShieldPlan, CONF_ROUTER } from '../dapp/swap/route.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const f = JSON.parse(readFileSync(new URL('./fixtures/curve-crv-quote.json', import.meta.url), 'utf8'));
const quote = { amountOut: BigInt(f.amountOut), amountLimit: BigInt(f.amountLimit), msgValue: BigInt(f.msgValue), callData: f.callData, deadline: BigInt(f.deadline) };
const wei = BigInt(f.amount), SCALE = 10n ** 10n;
assert.strictEqual(f.to.toLowerCase(), CONF_ROUTER.toLowerCase());

const bare = zapShieldPlan({ quote, tokenOut: f.token, wei, scale: SCALE });
assert.ok(bare.why && /curve route uses a pool that is not allowed/.test(bare.why), `refused with the guard's reason (${bare.why})`);
ok('a Curve route through a pool the guard does not list is refused, with the guard\'s own reason');

const plan = zapShieldPlan({ quote: { ...quote, curvePools: f.pools }, tokenOut: f.token, wei, scale: SCALE });
assert.ok(!plan.why, `a plan (${plan.why})`);
assert.strictEqual(plan.value, wei); assert.strictEqual(plan.to.toLowerCase(), CONF_ROUTER.toLowerCase());
assert.strictEqual(plan.wrapAmount % SCALE, 0n); assert.ok(plan.wrapAmount > 0n && plan.wrapAmount <= quote.amountLimit);
assert.strictEqual(plan.rest, quote.amountOut - plan.wrapAmount);
ok('with the pool the aggregator proved by simulation, the same calldata makes a plan: the least wrapped in whole units, the rest returned');

const other = zapShieldPlan({ quote: { ...quote, curvePools: ['0x000000000000000000000000000000000000dead'] }, tokenOut: f.token, wei, scale: SCALE });
assert.ok(other.why, 'another pool does not unlock the route');
ok('a pool that is not the route\'s own does not unlock it');

for (const [what, over] of [['recipient', { quote: { ...quote, curvePools: f.pools, callData: f.callData.replace(CONF_ROUTER.slice(2).toLowerCase(), '00000000000000000000000000000000000000ab') } }], ['amount', { wei: wei + 1n, quote: { ...quote, curvePools: f.pools, msgValue: wei + 1n } }], ['deadline', { deadline: quote.deadline + 1n, quote: { ...quote, curvePools: f.pools } }]]) {
  const r = zapShieldPlan({ tokenOut: f.token, wei, scale: SCALE, ...over });
  assert.ok(r.why, `${what} is still checked`);
}
ok('a different recipient, amount or deadline is still refused, with the pool proven');
console.log(`\n${n} passed`);
