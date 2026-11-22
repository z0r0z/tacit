// tests/fork-log-cache.mjs: the getLogs cache the mainnet-fork tests share. Offline: a synthetic chain stands in for the archive node.
//   node tests/fork-log-cache.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLogCache, CHUNK } from './fork-log-cache.mjs';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const hex = (v) => '0x' + BigInt(v).toString(16);
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', T1 = '0x' + '11'.repeat(32), T2 = '0x' + '22'.repeat(32);

// One log of each topic every so many blocks, up to block 40,000: enough to cross chunk boundaries at 5,000.
const chain = [];
for (let b = 1; b <= 40000; b += 37) chain.push({ address: POOL, topics: [T1], blockNumber: hex(b), data: '0x' });
for (let b = 20; b <= 40000; b += 53) chain.push({ address: POOL, topics: [T2], blockNumber: hex(b), data: '0x' });
const upstream = (calls, fail = null) => async (filter, from, to) => {
  calls.push({ filter, from, to });
  if (fail && fail.on) throw new Error('upstream down');
  return chain.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to && l.address === filter.address && l.topics[0] === filter.topics[0]);
};
const req = (a, b, extra = {}) => ({ address: POOL, topics: [T1], fromBlock: hex(a), toBlock: hex(b), ...extra });
const expected = (a, b, t = T1) => chain.filter((l) => l.topics[0] === t && BigInt(l.blockNumber) >= BigInt(a) && BigInt(l.blockNumber) <= BigInt(b));
const make = (o = {}) => { const calls = []; const cache = makeLogCache({ fetchChunk: upstream(calls, o.fail), head: () => o.head ?? 30000n, margin: 64n, autosave: false, ...o.opts }); return { cache, calls }; };
const span = (c) => [c.from, c.to];

await test('a request of any span inside one chunk costs one fetch of the whole chunk, and a hundred more in it cost none', async () => {
  const { cache, calls } = make();
  for (let a = 10000; a < 10000 + 50 * 100; a += 50) assert.deepEqual(await cache.logs(req(a, a + 49)), expected(a, a + 49), `span ${a}`);
  assert.equal(calls.length, 1, 'one call');
  assert.deepEqual(span(calls[0]), [10000n, 14999n], 'the aligned chunk');
  assert.equal(CHUNK, 5000n);
  assert.deepEqual(cache.stats(), { chunks: 1, tails: 0, fetched: 1, served: 99 });
});

await test('a request across a chunk boundary is the two chunks\' logs in block order, and only the ones in its range', async () => {
  const { cache, calls } = make();
  assert.deepEqual(await cache.logs(req(4990, 5010)), expected(4990, 5010));
  assert.deepEqual(calls.map(span), [[0n, 4999n], [5000n, 9999n]]);
  assert.deepEqual(await cache.logs(req(0, 24999)), expected(0, 24999));
  assert.equal(calls.length, 5, 'five chunks in all, two of them already held');
});

await test('what it does not answer is left to the fork: past the fork block, a block hash, a tag, a backwards range, no filter', async () => {
  const { cache, calls } = make();      // the fork block is 30,000
  for (const f of [req(29000, 30001), req(30000, 30050), { ...req(100, 200), blockHash: '0x' + 'ab'.repeat(32) }, { ...req(100, 200), toBlock: 'latest' }, { ...req(100, 200), fromBlock: 'earliest' }, req(200, 100), null, undefined, 'x'])
    assert.equal(await cache.logs(f), null, JSON.stringify(f)?.slice(0, 60));
  assert.equal(calls.length, 0, 'the fork was never asked');
  assert.deepEqual(cache.stats(), { chunks: 0, tails: 0, fetched: 0, served: 0 });
});

await test('the chunk that reaches the fork block is fetched only up to the fork block and held for this run, so the whole history is answerable', async () => {
  const { cache, calls } = make({ head: 12064n });      // settled up to 12,000; chunk 2 is 10,000..14,999
  assert.deepEqual(await cache.logs(req(10000, 10049)), expected(10000, 10049));
  assert.deepEqual(span(calls[0]), [10000n, 12064n], 'up to the fork block, not the chunk\'s end');
  assert.deepEqual(await cache.logs(req(11000, 11049)), expected(11000, 11049));
  assert.deepEqual(await cache.logs(req(12000, 12064)), expected(12000, 12064), 'the fork block itself');
  assert.equal(calls.length, 1, 'held after the first');
  assert.deepEqual(cache.stats(), { chunks: 0, tails: 1, fetched: 1, served: 2 });
  assert.deepEqual(await cache.logs(req(4990, 10010)), expected(4990, 10010), 'settled chunks and the held one together');
  assert.deepEqual(calls.slice(1).map(span), [[0n, 4999n], [5000n, 9999n]]);
  assert.equal(await cache.logs(req(12000, 12065)), null, 'a block past the fork block goes to the fork');
});

await test('a chunk that ends inside the margin before the fork block is held, not kept: it is the tail even though it is whole', async () => {
  const { cache, calls } = make({ head: 10040n });      // settled up to 9,976; chunk 1 ends at 9,999, inside the margin
  assert.deepEqual(await cache.logs(req(5000, 5049)), expected(5000, 5049));
  assert.deepEqual(span(calls[0]), [5000n, 9999n]);
  assert.deepEqual(cache.stats(), { chunks: 0, tails: 1, fetched: 1, served: 0 });
});

await test('each filter has its own chunks: another topic or another address is fetched on its own', async () => {
  const { cache, calls } = make();
  const a = await cache.logs(req(10000, 10049)), b = await cache.logs(req(10000, 10049, { topics: [T2] }));
  assert.deepEqual(a, expected(10000, 10049)); assert.deepEqual(b, expected(10000, 10049, T2));
  assert.notDeepEqual(a, b);
  assert.equal(calls.length, 2);
  await cache.logs(req(10000, 10049, { address: '0x' + '99'.repeat(20) }));
  assert.equal(calls.length, 3);
});

await test('the archive node is asked for the filter as it was, with the chunk\'s own bounds in place of the request\'s', async () => {
  const { cache, calls } = make();
  await cache.logs(req(10020, 10030));
  assert.deepEqual(calls[0].filter, { address: POOL, topics: [T1] });
  assert.equal('fromBlock' in calls[0].filter, false);
  assert.deepEqual(span(calls[0]), [10000n, 14999n]);
});

await test('a fetch that fails is not cached: the error comes up, nothing is kept, and the next ask tries again', async () => {
  const fail = { on: true };
  const { cache, calls } = make({ fail });
  await assert.rejects(cache.logs(req(10000, 10049)), /upstream down/);
  assert.deepEqual(cache.stats(), { chunks: 0, tails: 0, fetched: 0, served: 0 });
  fail.on = false;
  assert.deepEqual(await cache.logs(req(10000, 10049)), expected(10000, 10049));
  assert.equal(calls.length, 2);
  const bad = makeLogCache({ fetchChunk: async () => ({ error: 'x' }), head: () => 30000n, autosave: false });
  await assert.rejects(bad.logs(req(10000, 10049)), /did not return logs/);
  assert.equal(bad.stats().chunks, 0);
});

await test('with a file the settled chunks outlive the run; a damaged file, or entries that are not logs, are a cold cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logcache-')), file = join(dir, 'c.json');
  try {
    const first = make({ opts: { file } });
    await first.cache.logs(req(10000, 10049)); await first.cache.logs(req(20000, 20049));
    first.cache.save();
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length, 2);
    const second = make({ opts: { file } });
    assert.deepEqual(await second.cache.logs(req(10010, 10040)), expected(10010, 10040));
    assert.equal(second.calls.length, 0, 'served from the file');
    writeFileSync(file, '{not json');
    const cold = make({ opts: { file } });
    assert.deepEqual(await cold.cache.logs(req(10010, 10040)), expected(10010, 10040));
    assert.equal(cold.calls.length, 1);
    writeFileSync(file, JSON.stringify({ [JSON.stringify([POOL, [T1], '2'])]: 'not logs' }));
    const odd = make({ opts: { file } });
    assert.deepEqual(await odd.cache.logs(req(10010, 10040)), expected(10010, 10040));
    assert.equal(odd.calls.length, 1, 'a value that is not an array is not served');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('the file holds settled chunks only: what reached the fork block is not kept, and a later fork block fetches that chunk whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logcache-')), file = join(dir, 'c.json');
  try {
    const first = make({ head: 12064n, opts: { file } });
    await first.cache.logs(req(5000, 5049));           // settled
    await first.cache.logs(req(10000, 10049));         // reaches the fork block
    first.cache.save();
    const kept = Object.keys(JSON.parse(readFileSync(file, 'utf8')));
    assert.equal(kept.length, 1, 'one chunk in the file');
    assert.deepEqual(JSON.parse(kept[0]).at(-1), '1', 'the settled one');
    const later = make({ head: 20000n, opts: { file } });
    assert.deepEqual(await later.cache.logs(req(5000, 5049)), expected(5000, 5049));
    assert.equal(later.calls.length, 0, 'the settled chunk is served from the file');
    assert.deepEqual(await later.cache.logs(req(10000, 10049)), expected(10000, 10049));
    assert.deepEqual(span(later.calls[0]), [10000n, 14999n], 'chunk 2 is now settled and is fetched whole, not as the first run had it');
    assert.equal(expected(12065, 14999).length > 0, true, 'and holds logs the first run\'s fork block could not have seen');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('the two fork tests use it, fetch through an archive node and not the fork, and ask the cache before the fork', () => {
  for (const f of ['wrapswap-first-fork.mjs', 'staged-swap-fork.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.match(src, /import\('\.\/fork-log-cache\.mjs'\)/, `${f} imports the cache`);
    assert.match(src, /makeLogCache\(\{/, `${f} makes one`);
    assert.match(src, /LOG_RPC/, `${f} names the archive node`);
    assert.match(src, /realFetch\(LOG_RPC,/, `${f} fetches chunks from it directly, not through the fork`);
    const ask = src.indexOf('cachedLogs(init)'), fork = src.indexOf("'the fork');", src.indexOf('globalThis.fetch = async'));
    assert.ok(ask > 0 && fork > ask, `${f} asks the cache first, then the fork`);
    assert.match(src, /"jsonrpc"/, `${f} routes every JSON-RPC call to the fork`);
  }
});

console.log(`${n} fork-log-cache checks passed`);
