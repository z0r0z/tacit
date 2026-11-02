// dapp/swap/aggregate.js bestRoute with zQuoter's real answers at block 26257675, when its best route for 0.00333 ETH → USDC ran through a
// Curve pool the guard does not list (USDC / WETH / INV) and the page said "No route": that route is taken only when the swap, run as it
// stands from an address given the ETH, pays at least its floor; a simulation that pays less, fails, or is not asked for leaves it refused.
//   node --test tests/swap-aggregate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { bestRoute } = await import('../dapp/swap/aggregate.js');
const F = JSON.parse(readFileSync(new URL('./fixtures/aggregate-curve-26257675.json', import.meta.url), 'utf8'));
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x0000000000000000000000000000000000000000';

// the recorded node: each zQuoter read answered as it was, and the simulation as `sim` says
function node(sim = (r) => r) {
  const seen = [];
  const ethCall = async (to, data, block, o = {}) => {
    const c = F.calls.find((x) => x.sel === data.slice(0, 10) && x.sim === !!o.state);
    seen.push({ sel: data.slice(0, 10), sim: !!o.state, from: o.from, state: o.state });
    if (!c) throw new Error('not recorded');
    if (c.error) throw Object.assign(new Error(c.error), { revert: /revert/i.test(c.error) });
    return o.state ? sim(c.result) : c.result;
  };
  return { ethCall, seen };
}
const ask = (ethCall, over = {}) => bestRoute({ ethCall, to: F.to, tokenIn: ZERO, tokenOut: USDC, amountIn: BigInt(F.amountIn), slippageBps: 50, deadline: BigInt(F.deadline), block: '0x' + F.block.toString(16), ...over });
// the last word of the simulated multicall's return is the swap's amount out
const paying = (v) => (r) => r.slice(0, -64) + BigInt(v).toString(16).padStart(64, '0');

test('the Curve route is offered once the simulation shows it pays at least its floor', async () => {
  const { ethCall, seen } = node();
  const q = await ask(ethCall);
  assert.ok(q, 'a route');
  assert.match(q.name, /Curve/);
  assert.ok(q.out >= q.min && q.min > 0n);
  const sims = seen.filter((s) => s.sim);
  assert.strictEqual(sims.length, 1, 'simulated once, not once for each answer that carries the same route');
  assert.ok(BigInt(sims[0].state[sims[0].from].balance) > BigInt(F.amountIn), 'from a fresh address the node is told holds the ETH');
});

test('a simulation that pays under the floor leaves it refused', async () => {
  const { ethCall } = node();
  const floor = (await ask(ethCall)).min;
  assert.strictEqual(await ask(node(paying(floor - 1n)).ethCall), null);
  assert.ok(await ask(node(paying(floor)).ethCall), 'exactly the floor passes');
});

test('a simulation the node refuses, or one that reverts, leaves it refused', async () => {
  assert.strictEqual(await ask(node(() => { throw new Error('state overrides are not supported'); }).ethCall), null);
  assert.strictEqual(await ask(node(() => { throw Object.assign(new Error('execution reverted'), { revert: true }); }).ethCall), null);
});

test('without the simulation the guard refuses a pool it does not list, as before', async () => {
  const { ethCall } = node(() => '0x');
  assert.strictEqual(await ask(ethCall), null);
});

test('Swap privately\'s swap out takes the same route: written for the real address, it is checked with the Curve pool the simulation let through', async () => {
  const { routeOut } = await import('../dapp/swap/later.js');
  const { ethCall } = node();
  const real = '0x' + '77'.repeat(20);
  // the stand-in is the address the recorded answers were asked for, so the recorded node answers them
  const r = await routeOut({ ethCall, token: USDC, amount: BigInt(F.amountIn), to: real, slippageBps: 50, deadline: BigInt(F.deadline), random: () => Uint8Array.from(Buffer.from(F.to.slice(2), 'hex')) });
  assert.ok(r, 'a route to swap out on');
  assert.ok(r.callData.includes('77'.repeat(20)) && !r.callData.includes(F.to.slice(2)), 'written for the real address');
});

// ── onRoute: the best route so far, told as each scan answers ──
const E = JSON.parse(readFileSync(new URL('./fixtures/aggregate-eth-dai.json', import.meta.url), 'utf8'));
const DAI = E.tokenOut;
// zQuoter's recorded answers for 0.001 ETH → DAI, each after its own delay (ms, by selector); `order` is told which was answered
function eth(delays = {}, order = []) {
  const ethCall = async (to, data) => {
    const sel = data.slice(2, 10);
    await new Promise((r) => setTimeout(r, delays[sel] ?? 0));
    order.push(sel);
    if (!E.calls[sel]) throw Object.assign(new Error('execution reverted'), { revert: true });
    return E.calls[sel];
  };
  return ethCall;
}
const askEth = (ethCall, over = {}) => bestRoute({ ethCall, to: E.to, tokenIn: ZERO, tokenOut: DAI, amountIn: BigInt(E.amountIn), slippageBps: E.slippageBps, deadline: BigInt(E.deadline), block: '0x' + E.block.toString(16), ...over });
const SEL4 = { viaEth: 'e453166e', split: '892af013', hybrid: '85f86a90', quotes: 'e1fd10bc' };

test('a route is told as soon as the first scan that holds one answers, and the answer is the best of all, as without it', async () => {
  const plain = await askEth(eth());
  assert.ok(plain && plain.out > 0n, 'a route for ETH → DAI');
  const heard = [], order = [];
  const q = await askEth(eth({ [SEL4.viaEth]: 5, [SEL4.quotes]: 5, [SEL4.split]: 60, [SEL4.hybrid]: 120 }, order), { onRoute: (r) => heard.push({ r, answered: order.slice() }) });
  assert.ok(heard.length >= 1, 'told at least once');
  assert.ok(!heard[0].answered.includes(SEL4.split) && !heard[0].answered.includes(SEL4.hybrid), 'the first is told before the split and the mix have answered');
  assert.deepEqual(order, [SEL4.viaEth, SEL4.quotes, SEL4.split, SEL4.hybrid].sort((a, b) => ({ [SEL4.viaEth]: 5, [SEL4.quotes]: 5, [SEL4.split]: 60, [SEL4.hybrid]: 120 }[a] - { [SEL4.viaEth]: 5, [SEL4.quotes]: 5, [SEL4.split]: 60, [SEL4.hybrid]: 120 }[b])), 'and the answer waits for the last scan');
  for (const { r } of heard) {
    assert.ok(r.callData && r.min > 0n && r.out >= r.min, 'a route with its floor');
    assert.deepEqual(r.quotes, [], 'the list of every pool\'s quote is not read yet');
    assert.strictEqual(r.to, E.to); assert.strictEqual(r.refundTo, E.to, 'and who it refunds, for a card that sends it as it was shown'); assert.strictEqual(r.deadline, BigInt(E.deadline)); assert.strictEqual(r.amountIn, BigInt(E.amountIn));
  }
  for (let i = 1; i < heard.length; i++) assert.ok(heard[i].r.out > heard[i - 1].r.out, 'told again only for a better one');
  assert.ok(heard.at(-1).r.out <= q.out);
  for (const k of ['out', 'min', 'callData', 'name', 'kind', 'value']) assert.deepEqual(q[k], plain[k], `the answer's ${k} is the same as without onRoute`);
  assert.deepEqual(q.quotes, plain.quotes); assert.ok(q.quotes.length > 0, 'and it carries the pools\' quotes');
});

test('a scan that answers later with a worse route is not told, and one that holds none is passed over', async () => {
  const heard = [];
  const plain = await askEth(eth());
  // the best route's scan last: whatever answered before it is told, and only the improvements
  const order = [], q = await askEth(eth({ [SEL4.viaEth]: 80, [SEL4.split]: 5, [SEL4.hybrid]: 5, [SEL4.quotes]: 5 }, order), { onRoute: (r) => heard.push(r) });
  assert.strictEqual(order.at(-1), SEL4.viaEth);
  for (let i = 1; i < heard.length; i++) assert.ok(heard[i].out > heard[i - 1].out);
  assert.ok(heard.length >= 1 && heard.at(-1).out <= q.out && q.out === plain.out);
  // a pair with no split or mix route: the one scan's route is all there is
  const only = [], r2 = await askEth(async (to, data) => { if (!data.startsWith('0x' + SEL4.viaEth) && !data.startsWith('0x' + SEL4.quotes)) throw Object.assign(new Error('execution reverted'), { revert: true }); return E.calls[data.slice(2, 10)]; }, { onRoute: (r) => only.push(r) });
  assert.ok(r2 && only.length === 1 && only[0].callData === r2.callData, 'told once, with the route it returns');
});

test('a page whose onRoute throws still gets its answer', async () => {
  const plain = await askEth(eth());
  const q = await askEth(eth({ [SEL4.split]: 20 }), { onRoute: () => { throw new Error('the page broke'); } });
  assert.strictEqual(q.callData, plain.callData); assert.strictEqual(q.out, plain.out);
});

test('a Curve route the guard does not list is never told: only a simulation can offer it', async () => {
  const { ethCall } = node(), heard = [];
  const q = await ask(ethCall, { onRoute: (r) => heard.push(r) });
  assert.match(q.name, /Curve/);
  assert.deepEqual(heard, [], 'nothing the guard refuses is shown on the way');
});

test('no route at all is no call', async () => {
  const heard = [], none = async () => { throw Object.assign(new Error('execution reverted'), { revert: true }); };
  assert.strictEqual(await askEth(none, { onRoute: (r) => heard.push(r) }), null); assert.deepEqual(heard, []);
});
