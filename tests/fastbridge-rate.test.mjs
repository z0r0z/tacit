// The ETH-per-BTC rate feed (dapp/fastbridge-rate.js): what a provider prices a swap of Bitcoin for ETH from, and what a page checks a quote against.
// The Chainlink read is decoded from a real answer of the ETH / BTC aggregator (0xAc55…4e99) taken from mainnet on 2026-11-23. No network.
//   node tests/fastbridge-rate.test.mjs
import assert from 'node:assert/strict';
import { makeRateFeed, chainlinkEthBtc, coinbaseEthBtc, krakenEthBtc, ratioOf, ethPerBtcOf, RATE_DEN, CHAINLINK_ETH_BTC, chainlinkQuorum, forgetQuorum, restedNodes } from '../dapp/fastbridge-rate.js';

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

// ── the node quorum (chainlinkQuorum) ──
const NOW = UPDATED + 60;
const hostsOf = (calls) => calls;
// a stub network: each node is 'ok', '429', 'cors' (fetch throws), 'hang', or 'other' (a different price)
const net = (modes, log = []) => async (url, init) => {
  const mode = modes[url];
  log.push(url);
  if (mode === 'cors') throw new TypeError('Failed to fetch');
  if (mode === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
  if (mode === '429') return { status: 429, json: async () => ({}) };
  const body = JSON.parse(init.body), one = (b) => {
    if (b.method === 'eth_blockNumber') return { id: b.id, result: '0x100' };
    const round = mode === 'other' ? REAL_ROUND.replace('2ad77e', '2ad77f') : REAL_ROUND;
    return { id: b.id, result: b.params[0].data === '0x313ce567' ? REAL_DECIMALS : round };
  };
  return { status: 200, json: async () => (Array.isArray(body) ? body.map(one) : one(body)) };
};
const U = (n) => 'https://n' + n + '.example';
const quorum = (modes, extra = {}) => { const log = []; const t = { v: 1000000 }; return { log, t, q: chainlinkQuorum({ nodes: Object.keys(modes), fetchImpl: net(modes, log), now: () => NOW, nowMs: () => t.v, timeoutMs: 300, graceMs: 20, ...extra }) }; };
const fresh = () => forgetQuorum();
test('quorum: a price from two healthy nodes while others 429, fail like CORS and hang', async () => {
  fresh();
  const { q } = quorum({ [U(1)]: '429', [U(2)]: 'cors', [U(3)]: 'hang', [U(4)]: 'ok', [U(5)]: 'ok' });
  const r = await q();
  assert.equal(r.n, 2); assert.ok(Math.abs(r.ethPerBtc - 1e8 / 2807678) < 1e-9);
  await new Promise((r) => setTimeout(r, 900));       // (the node that hangs gives up within its own time, before the next test starts)
  assert.equal(restedNodes.size, 3);
});
test('quorum: a node that failed is rested and not asked again within the rest, then asked after it', async () => {
  fresh();
  const modes = { [U(1)]: '429', [U(2)]: 'ok', [U(3)]: 'ok' };
  const { q, log, t } = quorum(modes, { keepMs: 0 });
  await q(); const asked1 = log.filter((u) => u === U(1)).length;
  assert.ok(asked1 >= 1); assert.equal(restedNodes.get(U(1)).n, 1);
  await q(); await q();
  assert.equal(log.filter((u) => u === U(1)).length, asked1);
  t.v += 61000; modes[U(1)] = 'ok'; await q();
  assert.ok(log.filter((u) => u === U(1)).length > asked1);
});
test('quorum: a node that answers a different price at the same block blocks the read', async () => {
  fresh();
  const { q } = quorum({ [U(1)]: 'ok', [U(2)]: 'ok', [U(3)]: 'other' });
  await assert.rejects(q(), /disagree/);
});
test('quorum: fewer than two answering is an error, and a good reading is shared and kept', async () => {
  fresh();
  const bad = quorum({ [U(1)]: 'ok', [U(2)]: '429', [U(3)]: 'cors' });
  await assert.rejects(bad.q(), /too few/);
  fresh();
  const { q, log } = quorum({ [U(1)]: 'ok', [U(2)]: 'ok' });
  const [a, b] = await Promise.all([q(), q()]); const n = log.length;
  assert.deepEqual(a, b); await q(); assert.equal(log.length, n);
});
test('quorum: nodes that take batches get decimals and the round in one POST, once decimals are known only the round', async () => {
  fresh();
  const { q, log } = quorum({ [U(1)]: 'ok', [U(2)]: 'ok' }, { batchOf: () => true, keepMs: 0 });
  await q(); const first = log.length; await q();
  // first read: a height and one batch per node; the second: one height and one single-call batch per node
  assert.equal(first, 4); assert.equal(log.length - first, 4);
});
test('a reader that is not a URL (a wallet) that hangs, rejects, throws at once or returns garbage is no answer: the price still comes from the other nodes', async () => {
  fresh();
  const mk = (id, send) => ({ id, send });
  const nodes = [mk('w-hang', () => new Promise(() => {})), mk('w-reject', () => Promise.reject(new Error('User rejected'))), mk('w-throw', () => { throw new Error('boom'); }), mk('w-garbage', async () => ({ not: 'hex' })), U(1), U(2)];
  const log = [];
  const q = chainlinkQuorum({ nodes, fetchImpl: net({ [U(1)]: 'ok', [U(2)]: 'ok' }, log), now: () => NOW, timeoutMs: 300, graceMs: 20 });
  const r = await q();
  assert.equal(r.n, 2);
  await new Promise((r2) => setTimeout(r2, 900));
  assert.ok(['w-hang', 'w-reject', 'w-throw', 'w-garbage'].every((k) => restedNodes.has(k)), 'each is rested');
});
test('request budget: a market read over six nodes (one 429, one CORS) is at most 14 POSTs in all, and a second reader of the same page makes none', async () => {
  fresh();
  const modes = { [U(1)]: 'ok', [U(2)]: 'ok', [U(3)]: 'ok', [U(4)]: 'ok', [U(5)]: '429', [U(6)]: 'cors' };
  const a = quorum(modes, { batchOf: () => true }), b = quorum(modes, { batchOf: () => true });
  await a.q(); const used = a.log.length;
  assert.ok(used <= 14, `a read used ${used} requests`);
  await b.q(); assert.equal(b.log.length, 0);
  assert.equal(restedNodes.size, 2);
});
test('a counted feed counts the quorum as its sources and keeps the last reading when too few answer', async () => {
  fresh();
  let ok = true; const t = { v: 5 };
  const f = makeRateFeed({ sources: [async () => { if (!ok) throw new Error('none'); return { ethPerBtc: 35.6, n: 3 }; }], counted: true, minSources: 2, unanimous: true, maxAgeSecs: 600, now: () => t.v });
  assert.equal((await f.refresh()).n, 3);
  ok = false; t.v += 100; assert.equal((await f.refresh()).ethPerBtc, 35.6);
  t.v += 1000; assert.equal(await f.refresh(), null);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} rate feed checks passed`);
process.exit(process.exitCode || 0);
