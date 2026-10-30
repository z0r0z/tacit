#!/usr/bin/env node
// The split route in dapp/evm-trade-venues.js (quoteSplit / buildSplit / plan), against synthetic venues.
//
// Both venues are constant-product curves with different depth, so the best split has a closed-form answer to compare with
// (brute force at 0.01% steps). The transactions it builds are compared byte for byte with the same bundle encoded by
// `cast calldata` (foundry), nested the way the chain will read it: zRouter.multicall([guard snwap, snwap(Multicall3,
// aggregate3[Value](legs))]). tests/tac-split-fork.mjs runs the same bundles against mainnet state.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  ZERO_ADDR, TAC_ERC20, TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID, ZROUTER, PRECISION_ROUTE, PRECISION_LENS, PRECISION_POLICY, PRECISION_GUARD,
  PRECISION_POOL, TACIT_AMM, TACIT_AMM_UNIT_SCALE, MULTICALL3, SAFE_EXECUTOR, SPLIT_EXTRA_GAS, SPLIT_REFINE_ABOVE, splitWorth, makeEvmTradeVenues,
} from '../dapp/evm-trade-venues.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const A1 = '0x1111111111111111111111111111111111111111';
const E18 = 10n ** 18n;

// ── the synthetic market: Precision is deeper, the AMM a little cheaper per TAC ──
const CURVES = { precision: { eth: 3n * E18, tac: 39000n * E18 }, tacit: { eth: 1n * E18, tac: 11000n * E18 } };
const cp = (rIn, rOut, amtIn) => (amtIn * 997n * rOut) / (rIn * 1000n + amtIn * 997n);
const outOf = (v, dir, amt) => (dir === 'ETH_TO_TAC' ? cp(CURVES[v].eth, CURVES[v].tac, amt) : cp(CURVES[v].tac, CURVES[v].eth, amt));
const align = (a) => a - (a % TACIT_AMM_UNIT_SCALE);

const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordsOf = (hex) => { const h = hex.replace(/^0x/, '').slice(8); return (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64)); };
function decodeAggregate3Call(data) {
  const h = data.replace(/^0x/, '').slice(8), word = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const cnt = Number(word(1)), subs = [];
  for (let i = 0; i < cnt; i++) {
    const t = 2 + Number(word(2 + i)) / 32, bo = t + Number(word(t + 2)) / 32, len = Number(word(bo));
    subs.push({ to: '0x' + h.slice(t * 64 + 24, t * 64 + 64), data: '0x' + h.slice((bo + 1) * 64, (bo + 1) * 64 + len * 2) });
  }
  return subs;
}
// (bool success, bytes data)[] as aggregate3 returns it.
function encReturns(rets) {
  const bodies = rets.map((r) => { const d = r ? r.replace(/^0x/, '') : ''; return w(r ? 1 : 0) + w(64) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
  let off = rets.length * 32, head = '';
  for (const b of bodies) { head += w(off); off += b.length / 2; }
  return '0x' + w(32) + w(rets.length) + head + bodies.join('');
}
const SEL = { quoteBest: '2adaa389', effFee: 'ef66de32', tacitQuote: '3bc1414a' };

// `delayMs` answers each read after that long, so the round a read went out in can be counted (`log.at`); `otherPoolBelow` makes the lens
// name another pool for amounts under it (a pool that is best only at small sizes).
const OTHER_POOL = '0x2222222222222222222222222222222222222222';
function makeEthCall({ failSim = false, tacitDown = false, delayMs = 0, otherPoolBelow = 0n } = {}) {
  const log = { agg3: 0, sims: 0, batches: [], at: [], policy: 0, policyPools: [], other: new Set() };
  async function ethCall(to, data, block, opts) {
    if (to.toLowerCase() === ZROUTER.toLowerCase()) { log.sims++; if (failSim) throw new Error('execution reverted: Multicall3: call failed'); return '0x'; }
    if (to.toLowerCase() !== MULTICALL3.toLowerCase()) throw new Error(`unexpected ethCall to ${to}`);
    log.agg3++; log.batches.push(0); log.at.push(Date.now());
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const rets = decodeAggregate3Call(data).map((c) => {
      log.batches[log.batches.length - 1]++;
      if (c.to.toLowerCase() === PRECISION_POLICY.toLowerCase()) { log.policy++; log.policyPools.push('0x' + c.data.slice(10 + 2 * 64 + 24, 10 + 3 * 64).toLowerCase()); }
      else if (![PRECISION_LENS, TACIT_AMM].some((a) => a.toLowerCase() === c.to.toLowerCase())) log.other.add(c.to.toLowerCase());
      const sel = c.data.slice(2, 10), arg = (i) => BigInt('0x' + c.data.slice(10 + i * 64, 10 + (i + 1) * 64));
      if (c.to.toLowerCase() === PRECISION_LENS.toLowerCase() && sel === SEL.quoteBest) {
        const dir = arg(3) === 0n ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
        return '0x' + w(BigInt(arg(4) < otherPoolBelow ? OTHER_POOL : PRECISION_POOL)) + w(outOf('precision', dir, arg(4)));
      }
      if (c.to.toLowerCase() === PRECISION_LENS.toLowerCase() && sel === SEL.effFee) return '0x' + w(30);
      if (c.to.toLowerCase() === PRECISION_POLICY.toLowerCase()) return '0x' + w(32) + w(1) + w(1);
      if (c.to.toLowerCase() === TACIT_AMM.toLowerCase() && sel === SEL.tacitQuote) {
        if (tacitDown || arg(2) !== 30n) return null;
        const dir = arg(0) === BigInt(CETH_POOL_ASSET_ID) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
        return '0x' + w(outOf('tacit', dir, arg(3)));
      }
      return null;
    });
    return encReturns(rets);
  }
  return { ethCall, log };
}

const keccak256 = (bytes) => {
  const hex = cast('keccak', '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  return Uint8Array.from((hex.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
};

const snwapCast = (tokenIn, amountIn, recipient, tokenOut, minOut, executor, data) =>
  cast('calldata', 'snwap(address,uint256,address,address,uint256,address,bytes)', tokenIn, String(amountIn), recipient, tokenOut, String(minOut), executor, data);
const bestSingle = (dir, amt) => (outOf('precision', dir, amt) >= outOf('tacit', dir, align(amt)) ? outOf('precision', dir, amt) : outOf('tacit', dir, align(amt)));

// ── quoteSplit: finds the optimum, in both directions, at several sizes ──
for (const dir of ['ETH_TO_TAC', 'TAC_TO_ETH']) {
  const { ethCall } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  for (const amt of dir === 'ETH_TO_TAC' ? [E18 / 2n, E18, 2n * E18] : [2000n * E18, 5000n * E18, 12000n * E18]) {
    const split = await venues.quoteSplit({ dir, amountIn: amt, account: A1 });
    assert.ok(split, `a split should pay more at ${amt}`);
    const [p, t] = split.legs;
    assert.equal(p.amountIn + t.amountIn, amt, 'the legs add up to exactly the order');
    assert.equal(t.amountIn % TACIT_AMM_UNIT_SCALE, 0n, 'the AMM leg is a whole multiple of 1e10');
    assert.equal(split.amountOut, p.amountOut + t.amountOut);
    assert.equal(p.amountOut, outOf('precision', dir, p.amountIn));
    assert.equal(t.amountOut, outOf('tacit', dir, t.amountIn));
    assert.ok(split.gain > 0n && split.amountOut > bestSingle(dir, amt));
    // brute force at 0.01% steps: the two-pass search (5% then 1% steps) must be within 0.005% of the true optimum
    let best = 0n;
    for (let s = 0n; s <= 10000n; s++) { const a2 = align(amt * s / 10000n), tot = outOf('precision', dir, amt - a2) + (a2 ? outOf('tacit', dir, a2) : 0n); if (tot > best) best = tot; }
    assert.ok(split.amountOut * 100000n >= best * 99995n, `search ${split.amountOut} vs optimum ${best}`);
  }
}
ok('quoteSplit finds the best allocation (within 0.005% of brute force) and legs add up, both directions, three sizes each');

{
  const { ethCall, log } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall });
  const s = await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1 });
  assert.ok(log.agg3 <= 10,`a split quote is a handful of batches, not a call per point (${log.agg3})`);
  assert.equal(await makeEvmTradeVenues({ ethCall: makeEthCall({ tacitDown: true }).ethCall }).quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1 }), null);
  assert.equal(await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 0n, account: A1 }), null);
  assert.ok(s.gainBps > 0);
}
ok('quoteSplit uses a few batched reads, and answers null when a venue is down or nothing is asked');

// ── route(): each venue is asked once, and nothing the answer does not carry ──
// a purchase of 2 ETH is an order worth the second search round (SPLIT_REFINE_ABOVE), the sale of 5,000 TAC (about 0.3 ETH) is not
const ROUTES = [['ETH_TO_TAC', 2n * E18, true], ['TAC_TO_ETH', 5000n * E18, false]];
for (const [dir, amt, refined] of ROUTES) {
  const { ethCall, log } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const r = await venues.route({ dir, amountIn: amt, account: A1, gasPrice: 10n ** 9n });
  assert.equal(r.pick, 'split');
  // the single quotes (Precision's best pool with its fee and policy beside it; the AMM's tiers) once for the ranking and the split search together,
  // and the coarse grid, then the fine grid for an order that is worth it; the split's legs are the grid's own reads at the winning sizes, in the pool the single quote found routable
  assert.deepEqual(log.batches, refined ? [3, 4, 40, 16] : [3, 4, 40], `the batches a route makes (${JSON.stringify(log.batches)})`);
  assert.equal(log.policy, 1, 'the pool is checked against the policy once, not for every quote of it');
  assert.equal(log.other.size, 0, `no resting-order or Uniswap v4 read is made (${[...log.other]})`);
  assert.equal(r.r.v4.length, 0); assert.equal(r.r.boards, null);
  // the same answer as the two quotes asked for separately, as quoteAll and quoteSplit are on their own (the split searched as far as route() searches it)
  const { ethCall: e2 } = makeEthCall(), v2 = makeEvmTradeVenues({ ethCall: e2, keccak256 });
  const [all, split] = await Promise.all([v2.quoteAll({ dir, amountIn: amt, account: A1, includeZQuoter: false }), v2.quoteSplit({ dir, amountIn: amt, account: A1, refineAbove: SPLIT_REFINE_ABOVE })]);
  assert.equal(r.split.amountOut, split.amountOut); assert.equal(r.r.best.amountOut, all.best.amountOut); assert.equal(r.split.legs[0].pool, split.legs[0].pool);
}
ok('route() asks each venue once (4 reads for an order the fine grid does not pay for, 5 for one it does, not 13), checks the pool\'s policy once, leaves out the boards and Uniswap v4, and answers as quoteAll and quoteSplit do on their own');

// ── route(): one round trip, two for an order worth the fine grid. The pool's fee and policy go out in the lens's own read, and the legs need no more ──
for (const [dir, amt, refined] of ROUTES) {
  const D = 40, { ethCall, log } = makeEthCall({ delayMs: D });
  const r = await makeEvmTradeVenues({ ethCall, keccak256 }).route({ dir, amountIn: amt, account: A1, gasPrice: 10n ** 9n });
  assert.equal(r.pick, 'split');
  const rounds = log.at.map((t) => Math.round((t - log.at[0]) / D));
  assert.deepEqual(rounds, refined ? [0, 0, 0, 1] : [0, 0, 0], `the round each read goes out in (${JSON.stringify(rounds)}, batches ${JSON.stringify(log.batches)})`);
}
ok('route() answers in one round trip (the single quotes and the coarse grid), and in two for an order worth the fine grid');

// ── the fine grid buys little: what the coarse one finds is within a basis point of it, and a larger order asks for it ──
{
  const amt = 2n * E18, fine = makeEthCall(), coarse = makeEthCall();
  const [f, c] = await Promise.all([
    makeEvmTradeVenues({ ethCall: fine.ethCall }).quoteSplit({ dir: 'ETH_TO_TAC', amountIn: amt, account: A1 }),
    makeEvmTradeVenues({ ethCall: coarse.ethCall }).quoteSplit({ dir: 'ETH_TO_TAC', amountIn: amt, account: A1, refineAbove: 3n * E18 }),
  ]);
  assert.equal(c.shareBps % 500n, 0n, 'without the fine grid the share is one of the coarse grid\'s');
  assert.ok(f.amountOut >= c.amountOut && (f.amountOut - c.amountOut) * 10000n <= f.amountOut * 2n, `the fine grid adds ${f.amountOut - c.amountOut} of ${f.amountOut}`);
  assert.equal(fine.log.agg3 - coarse.log.agg3, 1, 'and costs a batch');
  const at = makeEthCall();
  await makeEvmTradeVenues({ ethCall: at.ethCall }).quoteSplit({ dir: 'ETH_TO_TAC', amountIn: amt, account: A1, refineAbove: amt });
  assert.equal(at.log.agg3, fine.log.agg3, 'an order of exactly refineAbove is searched finely');
  // a sale is weighed by what it pays, in ETH
  const sale = makeEthCall(), small = makeEthCall();
  await makeEvmTradeVenues({ ethCall: sale.ethCall }).quoteSplit({ dir: 'TAC_TO_ETH', amountIn: 5000n * E18, account: A1, refineAbove: E18 / 10n });
  await makeEvmTradeVenues({ ethCall: small.ethCall }).quoteSplit({ dir: 'TAC_TO_ETH', amountIn: 5000n * E18, account: A1, refineAbove: E18 });
  assert.equal(sale.log.agg3 - small.log.agg3, 1, 'a sale that pays 0.3 ETH is searched finely above 0.1 ETH and not above 1');
}
ok('quoteSplit searches the fine grid only for an order worth refineAbove (what is paid in ETH, or what a sale pays), and the coarse grid alone is within 0.02% of it');

// ── Precision's fee and policy ride in the lens's read for the pool it is expected to name ──
{
  const D = 40, { ethCall, log } = makeEthCall({ delayMs: D });
  const q = await makeEvmTradeVenues({ ethCall }).quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1 });
  assert.deepEqual(log.batches, [3], 'the lens, the pool\'s fee and its policy in one read');
  assert.equal(q.pool.toLowerCase(), PRECISION_POOL.toLowerCase()); assert.equal(q.feeBps, 30n); assert.equal(q.amountOut, outOf('precision', 'ETH_TO_TAC', E18));
  // another pool at this size: the fee and the policy of that one are read after, as they were
  const o = makeEthCall({ otherPoolBelow: 2n * E18 });
  const q2 = await makeEvmTradeVenues({ ethCall: o.ethCall }).quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1 });
  assert.deepEqual(o.log.batches, [3, 2]); assert.equal(q2.pool.toLowerCase(), OTHER_POOL); assert.equal(q2.feeBps, 30n);
  assert.ok(o.log.policyPools.includes(OTHER_POOL) && o.log.policyPools.includes(PRECISION_POOL.toLowerCase()), `the policy was asked for the pool guessed and for the pool named (${o.log.policyPools})`);
  // a quote that names no pool is null, with no second read
  const dead = await makeEvmTradeVenues({ ethCall: async () => { throw new Error('down'); } }).quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1 });
  assert.equal(dead, null);
  // no guess: the lens alone, then the pool's fee and policy; another guess is taken as given
  const n = makeEthCall(), g = makeEthCall({ otherPoolBelow: 2n * E18 });
  await makeEvmTradeVenues({ ethCall: n.ethCall }).quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1, hint: null });
  assert.deepEqual(n.log.batches, [1, 2]);
  await makeEvmTradeVenues({ ethCall: g.ethCall }).quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1, hint: OTHER_POOL });
  assert.deepEqual(g.log.batches, [3], 'a guess that is right is one read, whichever pool it names');
}
ok('quotePrecision is one read when the lens names the pool its fee and policy were asked for (the Precision pool unless told otherwise), two when it names another');

// ── route(): a gas price still being read does not hold the quotes back ──
{
  const D = 30, { ethCall, log } = makeEthCall({ delayMs: D });
  const t0 = Date.now();
  const late = new Promise((res) => setTimeout(() => res(10n ** 9n), 200));
  const r = await makeEvmTradeVenues({ ethCall, keccak256 }).route({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, gasPrice: late });
  assert.ok(log.at[0] - t0 < 25, `the quotes go out at once, not after the price (${log.at[0] - t0} ms)`);
  assert.equal(r.pick, 'split');
  const dear = await makeEvmTradeVenues({ ethCall: makeEthCall().ethCall, keccak256 }).route({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, gasPrice: Promise.resolve(10n ** 13n) });
  assert.equal(dear.pick, 'single', 'a price that arrives as a promise is the price the split has to pay for');
  // a price that never comes (a read that failed) is no price: the margin without one decides
  const none = await makeEvmTradeVenues({ ethCall: makeEthCall().ethCall, keccak256 }).route({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, gasPrice: Promise.reject(new Error('no price')) });
  assert.equal(none.pick, 'split');
  const undef = await makeEvmTradeVenues({ ethCall: makeEthCall().ethCall, keccak256 }).route({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, gasPrice: Promise.resolve(undefined) });
  assert.equal(undef.pick, 'split');
}
ok('route() takes the gas price as a promise, reads the quotes beside it, and treats one that fails or is empty as no price');

// ── a split leg whose size has another best pool is quoted the way a single venue is: that pool's fee and policy are read ──
{
  const { ethCall, log } = makeEthCall({ otherPoolBelow: 19n * E18 / 10n });
  const s = await makeEvmTradeVenues({ ethCall }).quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1 });
  assert.ok(s && s.legs[0].amountIn < 19n * E18 / 10n, 'the Precision leg is under the size where the other pool is best');
  assert.equal(s.legs[0].pool.toLowerCase(), OTHER_POOL, 'the leg names the pool the lens chose at its size');
  assert.ok(log.policyPools.includes(OTHER_POOL), `that pool is checked against the policy too (${log.policyPools})`);
  assert.equal(s.legs[0].amountOut, outOf('precision', 'ETH_TO_TAC', s.legs[0].amountIn));
}
ok('a split leg that the lens sends to another pool at its size is quoted afresh, with that pool\'s policy checked')

// ── buildSplit: byte for byte against cast, nested the way the chain reads it ──
const DL = 2000000000n;
{
  const { ethCall } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const split = await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1 });
  const tx = venues.buildSplit({ split, account: A1, slippageBps: 50, deadline: DL });
  const [pl, tl] = split.legs, floor = split.amountOut * 9950n / 10000n;
  assert.equal(tx.to, ZROUTER); assert.equal(tx.value, E18); assert.equal(tx.approval, null); assert.equal(tx.minOut, floor);
  const route = cast('calldata', 'route(address[],address,address,uint256,uint256,address)', `[${pl.pool}]`, ZERO_ADDR, TAC_ERC20, String(pl.amountIn), '0', A1);
  const swap = cast('calldata', 'swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)', CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID, String(tl.feeBps), String(tl.amountIn), '0', String(DL), A1);
  const agg = cast('calldata', 'aggregate3Value((address,bool,uint256,bytes)[])',
    `[(${SAFE_EXECUTOR},false,${pl.amountIn},${cast('calldata', 'execute(address,bytes)', PRECISION_ROUTE, route)}),(${TACIT_AMM},false,${tl.amountIn},${swap})]`);
  const guard = snwapCast(ZERO_ADDR, 0, A1, ZERO_ADDR, 0, PRECISION_GUARD, cast('calldata', 'deadline(uint256,address)', String(DL), ZROUTER));
  const expected = cast('calldata', 'multicall(bytes[])', `[${guard},${snwapCast(ZERO_ADDR, 0, A1, TAC_ERC20, floor, MULTICALL3, agg)}]`);
  assert.equal(tx.data, expected);
  assert.throws(() => venues.buildSplit({ split, account: A1, deadline: DL, minOut: split.amountOut + 1n }), /minOut/);
  assert.throws(() => venues.buildSplit({ split: { ...split, legs: [pl, { ...tl, amountIn: tl.amountIn + 1n }] }, account: A1, deadline: DL }), /1e10/);
  ok('buildSplit (ETH to TAC) is byte for byte multicall([deadline guard, snwap(Multicall3, aggregate3Value([Precision via SafeExecutor, Tacit AMM]))])');
}
{
  const { ethCall } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const amt = 5000n * E18, split = await venues.quoteSplit({ dir: 'TAC_TO_ETH', amountIn: amt, account: A1 });
  const tx = venues.buildSplit({ split, account: A1, slippageBps: 50, deadline: DL });
  const [pl, tl] = split.legs, floor = split.amountOut * 9950n / 10000n;
  assert.equal(tx.to, ZROUTER); assert.equal(tx.value, 0n);
  assert.deepEqual(tx.approval, { token: TAC_ERC20, spender: ZROUTER, amount: amt });
  const route = cast('calldata', 'route(address[],address,address,uint256,uint256,address)', `[${pl.pool}]`, TAC_ERC20, ZERO_ADDR, String(pl.amountIn), '0', A1);
  const checkpoint = cast('calldata', 'checkpoint(address,bytes32,address)', TAC_ERC20, cast('keccak', route), A1);
  const sw = cast('calldata', 'swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)', TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID, String(tl.feeBps), String(tl.amountIn), '0', String(DL), A1);
  const ex = (d) => cast('calldata', 'execute(address,bytes)', PRECISION_ROUTE, d);
  const agg = cast('calldata', 'aggregate3((address,bool,bytes)[])',
    `[(${SAFE_EXECUTOR},false,${ex(checkpoint)}),(${TAC_ERC20},false,${cast('calldata', 'transfer(address,uint256)', PRECISION_ROUTE, String(pl.amountIn))}),(${SAFE_EXECUTOR},false,${ex(route)}),`
    + `(${TAC_ERC20},false,${cast('calldata', 'approve(address,uint256)', TACIT_AMM, String(tl.amountIn))}),(${TACIT_AMM},false,${sw})]`);
  const guard = snwapCast(ZERO_ADDR, 0, A1, ZERO_ADDR, 0, PRECISION_GUARD, cast('calldata', 'deadline(uint256,address)', String(DL), ZROUTER));
  const swapLeg = snwapCast(TAC_ERC20, amt, A1, ZERO_ADDR, floor, MULTICALL3, agg);
  assert.equal(tx.data, cast('calldata', 'multicall(bytes[])', `[${guard},${swapLeg}]`));
  // with a signed permit the approval is not needed and the permit leads
  const permit = { value: amt, deadline: DL, v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
  const withPermit = venues.buildSplit({ split, account: A1, slippageBps: 50, deadline: DL, permit });
  assert.equal(withPermit.approval, null);
  const permitLeg = cast('calldata', 'permit(address,uint256,uint256,uint8,bytes32,bytes32)', TAC_ERC20, String(amt), String(DL), '27', permit.r, permit.s);
  assert.equal(withPermit.data, cast('calldata', 'multicall(bytes[])', `[${permitLeg},${guard},${swapLeg}]`));
  assert.throws(() => makeEvmTradeVenues({ ethCall }).buildSplit({ split, account: A1, deadline: DL }), /keccak256/);
  ok('buildSplit (TAC to ETH) is byte for byte [permit?, guard, snwap(TAC, Multicall3, aggregate3([checkpoint, transfer, route, approve, Tacit swap]))]');
}

// ── splitWorth: the one rule the card, the sheets and plan() share ──
{
  // buying: 1 ETH in, the best single venue pays 12,000 TAC, the split 0.9% more
  const buy = { gain: 108n * E18, gainBps: 90, single: { amountOut: 12000n * E18 } };
  assert.equal(splitWorth({ dir: 'ETH_TO_TAC', split: buy, amountIn: E18 }), true, 'no gas price: 0.9% clears the 0.3% margin');
  assert.equal(splitWorth({ dir: 'ETH_TO_TAC', split: { ...buy, gainBps: 20 }, amountIn: E18 }), false, '0.2% does not');
  // 0.9% of 1 ETH = 0.009 ETH; its extra gas 110k at 20 gwei = 0.0022 ETH; 0.009 > 1.2 * 0.0022
  assert.equal(splitWorth({ dir: 'ETH_TO_TAC', split: buy, amountIn: E18, gasPrice: 20n * 10n ** 9n }), true);
  // at 100 gwei the same gas is 0.011 ETH: more than the gain
  assert.equal(splitWorth({ dir: 'ETH_TO_TAC', split: buy, amountIn: E18, gasPrice: 100n * 10n ** 9n }), false);
  // the boundary: gain·10 must EXCEED extraGas·price·12, so equality is not enough
  const price = 10n * 10n ** 9n, need = (SPLIT_EXTRA_GAS.ETH_TO_TAC * price * 12n) / 10n;   // wei of gain that just pays 1.2x the gas
  const at = (gainWei) => ({ gain: gainWei * 12000n, gainBps: 50, single: { amountOut: 12000n * E18 } });
  // gainWei ETH of extra TAC, scaled: gain(TAC) = gainWei * single.amountOut / amountIn
  const mk = (gainEth) => ({ gain: (gainEth * 12000n * E18) / E18, gainBps: 50, single: { amountOut: 12000n * E18 } });
  assert.equal(splitWorth({ dir: 'ETH_TO_TAC', split: mk(need), amountIn: E18, gasPrice: price }), false, 'exactly 1.2x its gas is not enough');
  assert.equal(splitWorth({ dir: 'ETH_TO_TAC', split: mk(need + 1n), amountIn: E18, gasPrice: price }), true, 'one wei more is');
  // selling: the gain is already ETH
  const sell = { gain: 4n * 10n ** 15n, gainBps: 100, single: { amountOut: 3n * 10n ** 17n } };
  assert.equal(splitWorth({ dir: 'TAC_TO_ETH', split: sell, amountIn: 5000n * E18, gasPrice: 10n * 10n ** 9n }), true, '0.004 ETH gain beats 141k gas at 10 gwei (0.0014 ETH)');
  assert.equal(splitWorth({ dir: 'TAC_TO_ETH', split: sell, amountIn: 5000n * E18, gasPrice: 30n * 10n ** 9n }), false, 'but not at 30 gwei (0.0042 ETH)');
  assert.equal(splitWorth({ dir: 'TAC_TO_ETH', split: null, amountIn: 1n }), false);
  assert.equal(splitWorth({ dir: 'TAC_TO_ETH', split: { ...sell, gain: 0n }, amountIn: 1n }), false);
  assert.ok(SPLIT_EXTRA_GAS.ETH_TO_TAC > 100000n && SPLIT_EXTRA_GAS.TAC_TO_ETH > SPLIT_EXTRA_GAS.ETH_TO_TAC, 'the measured gas deltas');
  ok('splitWorth: a 0.3% margin without a gas price; with one the gain (in ETH) must exceed 1.2x the extra gas, to the wei, both directions');
}

// ── route: which way an order runs, with the points preference a purchase carries ──
{
  const venues = makeEvmTradeVenues({ ethCall: makeEthCall().ethCall, keccak256 });
  const gp = 2n * 10n ** 9n;
  // a large purchase: the split pays far over 1% more than Precision, so it is taken
  const big = await venues.route({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, gasPrice: gp });
  assert.equal(big.pick, 'split'); assert.equal(big.single.venue, 'precision', 'the single it is weighed against is Precision');
  // 0.5 ETH: the split pays 0.7% more than Precision, under the 1% a purchase needs to leave it (its points), though worth its gas
  const mid = await venues.route({ dir: 'ETH_TO_TAC', amountIn: E18 / 2n, account: A1, gasPrice: gp });
  assert.equal(mid.pick, 'single'); assert.ok(mid.split && mid.split.gainBps >= 60 && mid.split.gainBps < 100, `the split is on offer at ${mid.split?.gainBps} bps`);
  // small orders gain nothing from a split at all
  for (const eth of [E18 / 50n, E18 / 10n]) assert.equal((await venues.route({ dir: 'ETH_TO_TAC', amountIn: eth, account: A1, gasPrice: gp })).pick, 'single');
  // a sale has no points, so any split worth its gas is taken
  const sale = await venues.route({ dir: 'TAC_TO_ETH', amountIn: 8000n * E18, account: A1, gasPrice: gp });
  assert.equal(sale.pick, 'split', 'a sale takes a split that is worth its gas, 1% or not');
  const noPref = await venues.route({ dir: 'ETH_TO_TAC', amountIn: E18 / 2n, account: A1, gasPrice: gp, preferPrecision: false });
  assert.equal(noPref.pick, 'split', 'without the points preference the 0.7% split is worth its gas');
  // gas too dear: nothing is worth a split
  const dear = await venues.route({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, gasPrice: 10n ** 13n });
  assert.equal(dear.pick, 'single'); assert.ok(dear.split, 'the split is still reported');
  // a single venue only: no split, and a venue that is down is simply absent
  const oneVenue = await makeEvmTradeVenues({ ethCall: makeEthCall({ tacitDown: true }).ethCall, keccak256 }).route({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1, gasPrice: gp });
  assert.equal(oneVenue.pick, 'single'); assert.equal(oneVenue.split, null); assert.equal(oneVenue.single.venue, 'precision');
  ok('route(): a purchase leaves Precision only for something over 1% better (a split included), a sale takes any split worth its gas, and gas too dear or a venue down keeps one pool');
}

// ── plan: the split is taken only when it is worth its gas, and only when it runs ──
{
  const { ethCall, log } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const base = { dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, deadline: DL };
  const noEstimate = await venues.plan(base);
  assert.equal(noEstimate.kind, 'split', 'without a gas estimate a split paying well over 0.3% is taken');
  assert.ok(noEstimate.split.gainBps > 30 && noEstimate.tx.to === ZROUTER);
  const cheap = await venues.plan({ ...base, estimateGas: async (tx) => (tx.data.length > 4000 ? 420000n : 300000n), gasPrice: async () => 2n * 10n ** 9n });
  assert.equal(cheap.kind, 'split'); assert.equal(cheap.gas.split - cheap.gas.single, 120000n);
  const dear = await venues.plan({ ...base, estimateGas: async (tx) => (tx.data.length > 4000 ? 300000n + 10n ** 9n : 300000n), gasPrice: async () => 10n ** 9n * 10n ** 9n });
  assert.equal(dear.kind, 'single', 'a split whose extra gas costs more than it earns is not taken');
  assert.ok(dear.split && dear.quote && dear.tx, 'the split stays on offer, and the single route is ready');
  const tiny = await venues.plan({ ...base, amountIn: 10n ** 12n });
  assert.equal(tiny.kind, 'single', 'a dust order gains less than 0.3% from splitting');
  const verified = await venues.plan({ ...base, verify: true });
  assert.equal(verified.kind, 'split'); assert.ok(log.sims >= 1, 'the chosen split was simulated first');
  const broken = makeEthCall({ failSim: true });
  const fell = await makeEvmTradeVenues({ ethCall: broken.ethCall, keccak256 }).plan({ ...base, verify: true });
  assert.equal(fell.kind, 'single', 'a split that reverts in simulation falls back to the best single venue');
  assert.match(String(fell.splitError), /Multicall3: call failed/);
  ok('plan() takes a split only when it pays enough over its extra gas, simulates it first on request, and falls back to the single venue on a revert');
}

console.log(`\n${n} tac-split checks passed`);
