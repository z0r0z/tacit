// The ETH-per-BTC rate feed (dapp/fastbridge-rate.js): what a provider prices a swap of Bitcoin for ETH from, and what a page checks a quote against.
// The Chainlink read is decoded from a real answer of the ETH / BTC aggregator (0xAc55…4e99) taken from mainnet on 2026-11-23. No network.
//   node tests/fastbridge-rate.test.mjs
import assert from 'node:assert/strict';
import { makeRateFeed, chainlinkEthBtc, coinbaseEthBtc, krakenEthBtc, ratioOf, ethPerBtcOf, RATE_DEN, CHAINLINK_ETH_BTC } from '../dapp/fastbridge-rate.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// latestRoundData() of the live aggregator: answer 2807678 (0.02807678 BTC per ETH, 8 places), updatedAt 0x6b042d2f
const REAL_DECIMALS = '0x' + '0'.repeat(63) + '8';
const REAL_ROUND = '0x000000000000000000000000000000000000000000000002000000000000637e00000000000000000000000000000000000000000000000000000000002ad77e000000000000000000000000000000000000000000000000000000006b042d18000000000000000000000000000000000000000000000000000000006b042d2f000000000000000000000000000000000000000000000002000000000000637e';
const UPDATED = 0x6b042d2f;
const chain = ({ round = REAL_ROUND, decimals = REAL_DECIMALS } = {}) => async (to, data) => {
  assert.equal(to.toLowerCase(), CHAINLINK_ETH_BTC.toLowerCase());
  return data === '0x313ce567' ? decimals : data === '0xfeaf968c' ? round : (() => { throw new Error('unexpected call ' + data); })();
};

test('the Chainlink answer decodes to ETH per BTC: 0.02807678 BTC per ETH is 35.6155 ETH per BTC', async () => {
  const v = await chainlinkEthBtc({ call: chain(), now: () => UPDATED + 60 })();
  assert.ok(Math.abs(v - 1 / 0.02807678) < 1e-9, String(v));
  assert.ok(v > 35.6 && v < 35.7);
});

test('a Chainlink answer older than 26 hours, with no price, or from an older round than its answer is not used', async () => {
  await assert.rejects(chainlinkEthBtc({ call: chain(), now: () => UPDATED + 26 * 3600 + 1 })(), /stale/);
  await assert.doesNotReject(chainlinkEthBtc({ call: chain(), now: () => UPDATED + 26 * 3600 })());
  const zero = REAL_ROUND.slice(0, 2 + 64) + '0'.repeat(64) + REAL_ROUND.slice(2 + 128);
  await assert.rejects(chainlinkEthBtc({ call: chain({ round: zero }), now: () => UPDATED + 1 })(), /no price/);
  const older = REAL_ROUND.slice(0, 2 + 64 * 4) + '0'.repeat(63) + '1';
  await assert.rejects(chainlinkEthBtc({ call: chain({ round: older }), now: () => UPDATED + 1 })(), /stale round/);
  await assert.rejects(chainlinkEthBtc({ call: async () => '0x', now: () => UPDATED })(), /./);
});

test('the exchange sources read the last price as BTC per ETH and give ETH per BTC', async () => {
  const cb = await coinbaseEthBtc({ fetchImpl: async (u) => { assert.match(u, /ETH-BTC\/ticker/); return { ok: true, json: async () => ({ price: '0.0281' }) }; } })();
  assert.ok(Math.abs(cb - 1 / 0.0281) < 1e-9);
  const kr = await krakenEthBtc({ fetchImpl: async (u) => { assert.match(u, /ETHXBT/); return { ok: true, json: async () => ({ result: { XETHXXBT: { c: ['0.02812', '1.2'] } } }) }; } })();
  assert.ok(Math.abs(kr - 1 / 0.02812) < 1e-9);
  await assert.rejects(coinbaseEthBtc({ fetchImpl: async () => ({ ok: false, status: 503 }) })(), /503/);
  await assert.rejects(krakenEthBtc({ fetchImpl: async () => ({ ok: true, json: async () => ({ result: {} }) }) })(), /not a price/);
  await assert.rejects(coinbaseEthBtc({ fetchImpl: async () => ({ ok: true, json: async () => ({ price: '0' }) }) })(), /not a price/);
});

test('the rate is pool units per satoshi: 35.6155 ETH per BTC turns 100,000 sats into 3,561,550 units (0.0356155 ETH)', () => {
  const r = ratioOf(35.6155);
  assert.equal(r.den, RATE_DEN);
  assert.equal((100_000n * r.num) / r.den, 3_561_550n);
  assert.equal(ethPerBtcOf(r), 35.6155);
  assert.throws(() => ratioOf(0), /not a price/);
  assert.throws(() => ratioOf(NaN), /not a price/);
});

const src = (v) => async () => { if (v instanceof Error) throw v; return v; };

test('two sources that agree give their median, and the feed says when it was read and by how many', async () => {
  let t = 1000;
  const f = makeRateFeed({ sources: [src(35.6), src(35.8)], now: () => t });
  assert.equal(f.current(), null, 'nothing before the first read');
  assert.equal(f.rate(), null);
  await f.refresh();
  assert.deepEqual(f.current(), { ethPerBtc: 35.7, at: 1000, n: 2 });
  assert.equal(f.rate().num, 3_570_000_000n);
});

test('a price stands for maxAgeSecs and then is gone: a feed that cannot be read again gives no rate rather than an old one', async () => {
  let t = 1000, live = true;
  const f = makeRateFeed({ sources: [() => (live ? 35.6 : Promise.reject(new Error('down'))), () => (live ? 35.6 : Promise.reject(new Error('down')))], now: () => t, maxAgeSecs: 180 });
  await f.refresh();
  t += 179; assert.ok(f.rate());
  t += 2; assert.equal(f.rate(), null, 'past its age');
  live = false; await f.refresh();
  assert.equal(f.rate(), null);
});

test('too few sources answering is no price; one that fails is left out and the rest stand if enough remain', async () => {
  const logs = [];
  const one = makeRateFeed({ sources: [src(35.6), src(new Error('down'))], log: (l) => logs.push(l.msg) });
  assert.equal(await one.refresh(), null);
  assert.ok(logs.includes('too few price sources answered'));
  const three = makeRateFeed({ sources: [src(35.6), src(new Error('down')), src(35.7)] });
  assert.equal((await three.refresh()).n, 2);
  const solo = makeRateFeed({ sources: [src(35.6)], minSources: 1 });
  assert.equal((await solo.refresh()).ethPerBtc, 35.6);
});

test('two sources that disagree by more than the spread give no price, and the price from before is not kept', async () => {
  let v = 35.7;
  const f = makeRateFeed({ sources: [src(35.6), async () => v], maxSpreadBps: 100 });
  assert.ok(await f.refresh());
  v = 40;                                                                  // one of them is wrong, and there is no telling which
  assert.equal(await f.refresh(), null);
  assert.equal(f.rate(), null, 'the earlier price is dropped too');
});

test('with three sources an outlier is dropped and the two that agree stand; with two outliers there is no price', async () => {
  const f = makeRateFeed({ sources: [src(35.6), src(35.7), src(60)], maxSpreadBps: 100 });
  const r = await f.refresh();
  assert.equal(r.n, 2);
  assert.ok(Math.abs(r.ethPerBtc - 35.65) < 1e-9);
  const g = makeRateFeed({ sources: [src(10), src(35.7), src(60)], maxSpreadBps: 100 });
  assert.equal(await g.refresh(), null);
});

test('a feed that needs no source, or more than it has, or has none, cannot be made: no answer is never taken for a price', () => {
  assert.throws(() => makeRateFeed({ sources: [src(35.6)], minSources: 0 }), /minSources must be from 1/);
  assert.throws(() => makeRateFeed({ sources: [src(35.6)], minSources: 2 }), /minSources must be from 1/);
  assert.throws(() => makeRateFeed({ sources: [], minSources: 1 }), /needs a source/);
  assert.throws(() => makeRateFeed({ sources: null }), /needs a source/);
  assert.throws(() => makeRateFeed({ sources: [src(1), src(1)], minSources: 1.5 }), /minSources must be from 1/);
});

test('reads that are asked for together are one read', async () => {
  let calls = 0;
  const f = makeRateFeed({ sources: [async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 35.6; }, src(35.6)] });
  await Promise.all([f.refresh(), f.refresh(), f.refresh()]);
  assert.equal(calls, 1);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} rate feed checks passed`);
process.exit(process.exitCode || 0);
