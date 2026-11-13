// ETH ↔ TAC inside "Swap privately" (dapp/swap/later.js routeOutTac, routeFrom, routeIn), against two synthetic constant-product pools read
// through the real venues module: the swap goes through both pools in one zRouter call when that pays more than one pool by over the split's
// extra gas, and through one pool otherwise. No chain; tests/swap-later-fork.mjs and tests/swap-held-exit-fork.mjs run the same calls on a fork.
//   node --test tests/swap-later-tac.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { routeOutTac, routeFrom, routeIn, quoteThrough, ZAP } = await import('../dapp/swap/later.js');
const V = await import('../dapp/evm-trade-venues.js');
const { keccak_256 } = await import('@noble/hashes/sha3');

const E18 = 10n ** 18n, GWEI = 10n ** 9n, ZERO = '0x0000000000000000000000000000000000000000';
const w = (v) => BigInt(v).toString(16).padStart(64, '0'), word = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const cp = (rIn, rOut, amtIn) => (amtIn * 997n * rOut) / (rIn * 1000n + amtIn * 997n);
function decodeAggregate3Call(data) {
  const h = data.replace(/^0x/, '').slice(8), at = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const subs = [];
  for (let i = 0; i < Number(at(1)); i++) {
    const t = 2 + Number(at(2 + i)) / 32, bo = t + Number(at(t + 2)) / 32, len = Number(at(bo));
    subs.push({ to: '0x' + h.slice(t * 64 + 24, t * 64 + 64), data: '0x' + h.slice((bo + 1) * 64, (bo + 1) * 64 + len * 2) });
  }
  return subs;
}
function encReturns(rets) {
  const bodies = rets.map((r) => { const d = r ? r.replace(/^0x/, '') : ''; return w(r ? 1 : 0) + w(64) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
  let off = rets.length * 32, head = '';
  for (const b of bodies) { head += w(off); off += b.length / 2; }
  return '0x' + w(32) + w(rets.length) + head + bodies.join('');
}
// the two pools as the lens and the AMM answer for them; `down` takes one away
function market({ precision = { eth: 3n * E18, tac: 39000n * E18 }, tacit = { eth: 1n * E18, tac: 11000n * E18 }, down = null } = {}) {
  const curves = { precision, tacit }, same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const out = (v, dir, amt) => (dir === 'ETH_TO_TAC' ? cp(curves[v].eth, curves[v].tac, amt) : cp(curves[v].tac, curves[v].eth, amt));
  const ethCall = async (to, data) => {
    if (!same(to, V.MULTICALL3)) throw new Error(`unexpected read of ${to}`);
    return encReturns(decodeAggregate3Call(data).map((c) => {
      const sel = c.data.slice(2, 10), arg = (i) => BigInt('0x' + c.data.slice(10 + i * 64, 10 + (i + 1) * 64));
      if (same(c.to, V.PRECISION_LENS) && sel === '2adaa389') return down === 'precision' ? null : '0x' + w(BigInt(V.PRECISION_POOL)) + w(out('precision', arg(3) === 0n ? 'ETH_TO_TAC' : 'TAC_TO_ETH', arg(4)));
      if (same(c.to, V.PRECISION_LENS) && sel === 'ef66de32') return '0x' + w(30);
      if (same(c.to, V.PRECISION_POLICY)) return '0x' + w(32) + w(1) + w(1);
      if (same(c.to, V.TACIT_AMM) && sel === '3bc1414a') return down === 'tacit' || arg(2) !== 30n ? null : '0x' + w(out('tacit', arg(0) === BigInt(V.CETH_POOL_ASSET_ID) ? 'ETH_TO_TAC' : 'TAC_TO_ETH', arg(3)));
      return null;
    }));
  };
  return { venues: V.makeEvmTradeVenues({ ethCall, keccak256: keccak_256 }), out, ethCall };
}
const TO = '0x00000000000000000000000000000000000de571', FROM = '0x00000000000000000000000000000000000f4011', DL = 1_900_000_000n;
const MULTICALL = '0xac9650d8';
const sum = (legs, k) => legs.reduce((t, l) => t + l[k], 0n);

test('ETH → TAC goes through both pools when that pays more than a split costs, and names each pool\'s part', async () => {
  const { venues, out } = market(), amount = E18;
  const r = await routeOutTac({ venues, amount, to: TO, slippageBps: 50, deadline: DL, gasPrice: GWEI });
  const best = [out('precision', 'ETH_TO_TAC', amount), out('tacit', 'ETH_TO_TAC', amount)].reduce((a, b) => (a > b ? a : b));
  assert.strictEqual(r.name, 'Both pools');
  assert.ok(r.out > best, `both pools pay ${r.out}, over the better pool's ${best}`);
  assert.deepStrictEqual(r.legs.map((l) => l.venue), ['precision', 'tacit-amm']);
  assert.strictEqual(sum(r.legs, 'amountIn'), amount, 'the two parts are the whole amount');
  assert.strictEqual(sum(r.legs, 'amountOut'), r.out, 'and what they pay is the route\'s');
  assert.strictEqual(r.legs[1].amountIn % V.TACIT_AMM_UNIT_SCALE, 0n, 'the Tacit pool\'s part is a whole number of its units');
  assert.strictEqual(r.min, (r.out * 9950n) / 10000n);
  assert.ok(r.callData.startsWith(MULTICALL) && r.callData.includes(word(TO)) && !r.standData.includes(word(TO)), 'one zRouter call written for the address, its copy for a stand-in');
  assert.ok(r.callData.includes(w(r.min)), 'the floor is in the call');
  assert.strictEqual(r.amountIn, amount);
});

test('ETH → TAC stays in one pool when gas costs more than the split gains, and takes the pool that pays more', async () => {
  const { venues, out } = market(), amount = E18 / 100n;
  const dear = await routeOutTac({ venues, amount, to: TO, slippageBps: 50, deadline: DL, gasPrice: 500n * GWEI });
  const p = out('precision', 'ETH_TO_TAC', amount), t = out('tacit', 'ETH_TO_TAC', amount);
  assert.strictEqual(dear.name, p >= t ? 'Precision pool' : 'Tacit pool');
  assert.strictEqual(dear.out, p >= t ? p : t);
  assert.strictEqual(dear.legs, undefined);
  assert.ok(dear.callData.includes(word(TO)) && !dear.standData.includes(word(TO)));
  // the gas is weighed at twice the price given: a gain between 1.2x and 2.4x the extra gas is left alone
  const big = E18, gain = (await routeOutTac({ venues, amount: big, to: TO, slippageBps: 50, deadline: DL })).out - out('precision', 'ETH_TO_TAC', big);
  const gainEth = (gain * big) / out('precision', 'ETH_TO_TAC', big), price = (gainEth * 10n) / (V.SPLIT_EXTRA_GAS.ETH_TO_TAC * 12n);
  assert.strictEqual((await routeOutTac({ venues, amount: big, to: TO, slippageBps: 50, deadline: DL, gasPrice: price / 3n })).name, 'Both pools');
  assert.strictEqual((await routeOutTac({ venues, amount: big, to: TO, slippageBps: 50, deadline: DL, gasPrice: (price * 3n) / 4n })).name, 'Precision pool');
});

test('with no gas price a split is taken for 0.3% more, and a promise of a price is waited for', async () => {
  const { venues } = market();
  assert.strictEqual((await routeOutTac({ venues, amount: E18, to: TO, slippageBps: 50, deadline: DL })).name, 'Both pools');
  // two pools at one price, one far deeper: the split gains almost nothing
  const flat = market({ precision: { eth: 300n * E18, tac: 3_900_000n * E18 }, tacit: { eth: 1n * E18, tac: 13_000n * E18 } });
  assert.strictEqual((await routeOutTac({ venues: flat.venues, amount: E18 / 100n, to: TO, slippageBps: 50, deadline: DL })).name, 'Precision pool');
  assert.strictEqual((await routeOutTac({ venues, amount: E18, to: TO, slippageBps: 50, deadline: DL, gasPrice: Promise.resolve(GWEI) })).name, 'Both pools');
  assert.strictEqual((await routeOutTac({ venues, amount: E18, to: TO, slippageBps: 50, deadline: DL, gasPrice: Promise.reject(new Error('no node')) })).name, 'Both pools');
});

test('an amount the Tacit pool cannot take whole still finds a route', async () => {
  // the Tacit pool pays more for small amounts here, and takes whole units of 1e10 wei only
  const m = market({ precision: { eth: 3n * E18, tac: 38000n * E18 }, tacit: { eth: 3n * E18, tac: 39000n * E18 } }), amount = E18 / 1000n + 7n;
  const r = await routeOutTac({ venues: m.venues, amount, to: TO, slippageBps: 50, deadline: DL, gasPrice: 500n * GWEI });
  assert.strictEqual(r.name, 'Precision pool', 'the pool that takes the whole amount');
  assert.strictEqual(r.amountIn, amount);
  const whole = await routeOutTac({ venues: m.venues, amount: E18 / 1000n, to: TO, slippageBps: 50, deadline: DL, gasPrice: 500n * GWEI });
  assert.strictEqual(whole.name, 'Tacit pool');
});

test('one pool down: the other is used; neither: no route', async () => {
  assert.strictEqual((await routeOutTac({ venues: market({ down: 'tacit' }).venues, amount: E18, to: TO, slippageBps: 50, deadline: DL })).name, 'Precision pool');
  assert.strictEqual((await routeOutTac({ venues: market({ down: 'precision' }).venues, amount: E18, to: TO, slippageBps: 50, deadline: DL })).name, 'Tacit pool');
  const none = { ...market().venues, route: async () => ({ r: { ranked: [] }, single: null, split: null, pick: null }) };
  assert.strictEqual(await routeOutTac({ venues: none, amount: E18, to: TO, slippageBps: 50, deadline: DL }), null);
});

test('a split that is not one plain zRouter call for the amount is passed over for one pool', async () => {
  const { venues } = market();
  let n = 0;
  // another target, another value, an allowance asked for, and a call that differs between two addresses by more than the address
  for (const bad of [(t) => ({ ...t, to: V.MULTICALL3 }), (t) => ({ ...t, value: t.value + 1n }), (t) => ({ ...t, approval: { token: V.TAC_ERC20, spender: V.ZROUTER, amount: 1n } }), (t) => ({ ...t, data: t.data + w(++n) })]) {
    const odd = { ...venues, buildSplit: (a) => bad(venues.buildSplit(a)) };
    const r = await routeOutTac({ venues: odd, amount: E18, to: TO, slippageBps: 50, deadline: DL });
    assert.strictEqual(r.name, 'Precision pool');
  }
  // and one whose written address cannot be told from the stand-in's
  const blind = { ...venues, buildSplit: (a) => venues.buildSplit({ ...a, account: TO, to: TO }) };
  assert.strictEqual((await routeOutTac({ venues: blind, amount: E18, to: TO, slippageBps: 50, deadline: DL })).name, 'Precision pool');
});

test('TAC → ETH out of a TAC pool: both pools or the Precision pool, each call taking the TAC by an allowance to zRouter', async () => {
  const { venues, out } = market(), amount = 5000n * E18;
  const r = await routeFrom({ ethCall: null, venues, tokenIn: V.TAC_ERC20, token: ZERO, amount, to: TO, slippageBps: 100, deadline: DL, gasPrice: GWEI });
  assert.strictEqual(r.name, 'Both pools');
  assert.ok(r.out > out('precision', 'TAC_TO_ETH', amount));
  assert.strictEqual(sum(r.legs, 'amountIn'), amount);
  assert.strictEqual(r.min, (r.out * 9900n) / 10000n);
  assert.ok(r.callData.startsWith(MULTICALL) && r.callData.includes(word(TO)) && !r.standData.includes(word(TO)) && r.standData.startsWith(MULTICALL));
  assert.strictEqual(r.deadline, DL);
  const dear = await routeFrom({ ethCall: null, venues, tokenIn: V.TAC_ERC20, token: ZERO, amount, to: TO, slippageBps: 100, deadline: DL, gasPrice: 5000n * GWEI });
  assert.strictEqual(dear.name, 'Precision pool');
  assert.strictEqual(dear.out, out('precision', 'TAC_TO_ETH', amount));
  assert.strictEqual(dear.legs, undefined);
  // the Tacit pool alone is no route out of a pool (its sale is not a zRouter call): with the Precision pool away there is none
  const lone = market({ down: 'precision' });
  assert.strictEqual(await routeFrom({ ethCall: null, venues: lone.venues, tokenIn: V.TAC_ERC20, token: ZERO, amount, to: TO, slippageBps: 100, deadline: DL }), null);
  // a call that asks for another allowance than the amount to zRouter is passed over
  const odd = { ...venues, buildSplit: (a) => { const t = venues.buildSplit(a); return { ...t, approval: { ...t.approval, spender: V.TACIT_AMM } }; } };
  assert.strictEqual((await routeFrom({ ethCall: null, venues: odd, tokenIn: V.TAC_ERC20, token: ZERO, amount, to: TO, slippageBps: 100, deadline: DL })).name, 'Precision pool');
});

test('TAC into the ETH pool through the zap: the same choice, paid to the zap', async () => {
  const { venues, out, ethCall } = market(), amountIn = 5000n * E18;
  const r = await routeIn({ ethCall, venues, token: V.TAC_ERC20, amountIn, from: FROM, slippageBps: 50, deadline: DL, gasPrice: GWEI });
  assert.strictEqual(r.name, 'Both pools');
  assert.ok(r.callData.includes(word(ZAP)) && r.out > out('precision', 'TAC_TO_ETH', amountIn) && r.amountIn === amountIn);
  const one = await routeIn({ ethCall, venues, token: V.TAC_ERC20, amountIn, from: FROM, slippageBps: 50, deadline: DL, gasPrice: 5000n * GWEI });
  assert.strictEqual(one.name, 'Precision pool');
  assert.ok(one.callData.includes(word(ZAP)));
  const q = await quoteThrough({ ethCall, venues, pay: V.TAC_ERC20, get: ZERO, amountIn, slippageBps: 50, deadline: DL, gasPrice: GWEI });
  assert.strictEqual(q.r0.name, 'Both pools');
  assert.strictEqual(q.r1.name, 'ETH');
  assert.ok(q.ethWei <= q.r0.out && q.ethWei > (q.r0.out * 99n) / 100n, 'what is swapped on is what the sale pays, rounded down');
});
