// How the Bitcoin pool replay reads its esplora sources (worker-relay/src/lib/btc-pool-chain.js makeEsplora) and when
// it asks again (btc-pool-indexer.js nextDelayMs, esploraSources). The sources are shared and rate limited, and one
// shield whose input has hundreds of ancestors costs thousands of reads: a source that limits us is rested, reads are
// a stream and not a burst, what cannot change is kept so a retry resumes, nothing is sent while every source rests,
// and a failure says what each source answered. No network.
//   node tests/btc-pool-esplora.test.mjs

import assert from 'node:assert/strict';
import { makeEsplora } from '../worker-relay/src/lib/btc-pool-chain.js';
import { nextDelayMs, esploraSources, MAX_BACKOFF_MS } from '../worker-relay/src/btc-pool-indexer.js';

const tid = (n) => n.toString(16).padStart(64, '0');
const res = (body, status = 200, headers = {}) => new Response(body, { status, headers });
// A fake clock the sleeps advance, and a fetch that records who was asked what.
function rig(hosts, handler, opts = {}) {
  let t = 1_000_000;
  const seen = [];
  let out = 0, peak = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seen.push(`${u.hostname}${u.pathname}`);
    out++; peak = Math.max(peak, out);
    await Promise.resolve();
    try { return await handler(u, seen.length); } finally { out--; }
  };
  const esplora = makeEsplora(hosts.map((h) => `https://${h}/api`), { fetchImpl, nowMs: () => t, sleep: async (ms) => { t += ms; }, ...opts });
  return { esplora, seen, later: (ms) => { t += ms; }, peak: () => peak, now: () => t };
}
const hostsAsked = (seen) => seen.map((s) => s.split('/')[0]);
const status = (h) => JSON.stringify({ confirmed: true, block_height: h, block_hash: 'aa'.repeat(32) });
const failure = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a source that limits us is passed over for the next, and left alone on the reads after it', async () => {
  const { esplora, seen } = rig(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? res('slow down', 429) : res('0123')));
  await esplora.rawTx(tid(1));
  assert.deepEqual(hostsAsked(seen), ['limited.test', 'calm.test'], 'the first read tried the limited one and went on');
  await esplora.rawTx(tid(2)); await esplora.rawTx(tid(3));
  assert.deepEqual(hostsAsked(seen).slice(2), ['calm.test', 'calm.test'], 'the limited one is not asked again while it rests');
});

test('a rested source is asked again once its rest is over, and the rest is as long as Retry-After says', async () => {
  let limited = true;
  const { esplora, seen, later } = rig(['a.test', 'b.test'], (u) => (u.hostname === 'a.test' && limited ? res('wait', 429, { 'retry-after': '90' }) : res('0123')), { coolMs: 1000 });
  await esplora.rawTx(tid(1));
  assert.equal(esplora.health()[0].restingSecs, 90, 'Retry-After wins over the 1 s the client would have chosen');
  later(60_000); limited = false;
  await esplora.rawTx(tid(2));
  assert.ok(!hostsAsked(seen).slice(2).includes('a.test'), 'still resting after 60 s');
  later(31_000);
  for (let n = 3; n < 6; n++) await esplora.rawTx(tid(n));
  assert.ok(hostsAsked(seen).slice(3).includes('a.test'), 'asked again after 91 s');
  assert.equal(esplora.health()[0].fails, 0, 'and healthy again after it answered');
});

test('a burst of failures rests the source once, at the first step, not at the cap', async () => {
  const { esplora } = rig(['a.test'], () => res('no', 429), { maxInflight: 12, gapMs: 0 });
  await Promise.allSettled(Array.from({ length: 12 }, (_, n) => esplora.rawTx(tid(n))));
  const h = esplora.health()[0];
  assert.equal(h.fails, 1, 'twelve reads that failed together are one failure');
  assert.ok(h.restingSecs <= 20, `rests ${h.restingSecs} s, not minutes`);
});

test('the rest doubles on each failure in a row, up to the cap', async () => {
  const { esplora, later } = rig(['a.test'], () => res('no', 503), { coolMs: 10_000, coolMaxMs: 60_000, gapMs: 0 });
  const rests = [];
  for (let i = 0; i < 5; i++) {
    await assert.rejects(esplora.rawTx(tid(i)));
    rests.push(esplora.health()[0].restingSecs);
    later(esplora.health()[0].restingSecs * 1000 + 1);
  }
  assert.deepEqual(rests, [10, 20, 40, 60, 60]);
});

test('when every source rests nothing is sent, and the error says how long until the first is back', async () => {
  const { esplora, seen } = rig(['a.test', 'b.test'], (u) => res('no', 429, { 'retry-after': u.hostname === 'a.test' ? '30' : '120' }));
  await assert.rejects(esplora.tipHeight());
  const asked = seen.length;
  const e = await esplora.tipHeight().then(() => null, (x) => x);
  assert.equal(seen.length, asked, 'no request while both rest');
  assert.ok(e.restMs > 29_000 && e.restMs <= 30_000, `restMs ${e.restMs}`);
  assert.equal(e.notFound, false);
  assert.match(e.message, /every source is resting/);
});

test('a failed read names every source and why, with the network error underneath "fetch failed"', async () => {
  const { esplora } = rig(['a.test', 'b.test', 'c.test'], (u) => {
    if (u.hostname === 'a.test') return res('slow down', 429);
    if (u.hostname === 'b.test') return res('nope', 502);
    throw failure('ECONNRESET');
  });
  const e = await esplora.rawTx(tid(9)).then(() => null, (x) => x);
  assert.match(e.message, /a\.test\/api HTTP 429/);
  assert.match(e.message, /b\.test\/api HTTP 502/);
  assert.match(e.message, /c\.test\/api ECONNRESET/);
  assert.doesNotMatch(e.message, /^fetch failed$/);
  assert.equal(esplora.health().find((s) => s.source === 'c.test/api').last, 'ECONNRESET');
});

test('a timeout is reported as one', async () => {
  const { esplora } = rig(['a.test'], () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
  const e = await esplora.rawTx(tid(1)).then(() => null, (x) => x);
  assert.match(e.message, /a\.test\/api timed out/);
});

test('notFound needs every source to say 404, and is not claimed while one rests or fails', async () => {
  const all = rig(['a.test', 'b.test'], () => res('nf', 404));
  assert.equal((await all.esplora.rawTx(tid(1)).then(() => null, (x) => x)).notFound, true);
  assert.equal(all.esplora.health().every((s) => s.restingSecs === 0), true, '404 is an answer, not a failure');
  const one = rig(['a.test', 'b.test'], (u) => (u.hostname === 'a.test' ? res('limit', 429) : res('nf', 404)));
  assert.equal((await one.esplora.rawTx(tid(1)).then(() => null, (x) => x)).notFound, false, 'one limited, one 404: not known to be absent');
  assert.equal((await one.esplora.rawTx(tid(2)).then(() => null, (x) => x)).notFound, false, 'with one still resting it is still not known');
});

test('reads for the same path that are under way together are one request', async () => {
  const { esplora, seen } = rig(['a.test'], async () => { await new Promise((r) => setTimeout(r, 5)); return res('0123'); });
  const got = await Promise.all(Array.from({ length: 10 }, () => esplora.rawTx(tid(7))));
  assert.equal(seen.length, 1);
  assert.equal(got.length, 10);
});

test('only so many reads are out at once, and a source gets one new read per gap', async () => {
  const waits = [];
  let t = 0;
  const seen = [];
  let out = 0, peak = 0;
  const esplora = makeEsplora(['https://a.test/api'], {
    maxInflight: 4, gapMs: 100, nowMs: () => t, sleep: async (ms) => { waits.push(ms); t += ms; },
    fetchImpl: async (u) => { seen.push(u); out++; peak = Math.max(peak, out); await new Promise((r) => setTimeout(r, 3)); out--; return res('0123'); },
  });
  await Promise.all(Array.from({ length: 20 }, (_, n) => esplora.rawTx(tid(n))));
  assert.equal(seen.length, 20);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.ok(waits.length >= 15, 'reads were spaced');
  assert.ok(waits.every((w) => w <= 100 * 20), 'by the gap, not by more');
});

test('transaction reads rotate over the sources that are up; tip and block reads keep to the first', async () => {
  const { esplora, seen } = rig(['a.test', 'b.test', 'c.test'], (u) => (/tip|block-height|\/block\//.test(u.pathname) ? res('977163') : res('0123')), { gapMs: 0 });
  for (let n = 0; n < 6; n++) await esplora.rawTx(tid(n));
  const tx = hostsAsked(seen);
  assert.deepEqual([...new Set(tx)].sort(), ['a.test', 'b.test', 'c.test'], 'every source took a share');
  assert.equal(tx.filter((h) => h === 'a.test').length, 2);
  seen.length = 0;
  for (let n = 0; n < 4; n++) await esplora.tipHeight();
  assert.deepEqual([...new Set(hostsAsked(seen))], ['a.test'], 'the tip is read from one source');
});

test('a transaction status deep under the tip is read once; a shallow or unconfirmed one is read each time', async () => {
  const { esplora, seen } = rig(['a.test'], (u) => {
    if (u.pathname === '/api/blocks/tip/height') return res('1000');
    if (u.pathname.includes(tid(1))) return res(status(500));            // 500 deep
    if (u.pathname.includes(tid(2))) return res(status(950));            // 50 deep
    return res(JSON.stringify({ confirmed: false }));
  }, { gapMs: 0 });
  await esplora.tipHeight();
  const reads = (n) => seen.filter((s) => s.includes(tid(n))).length;
  for (let i = 0; i < 3; i++) { await esplora.txStatus(tid(1)); await esplora.txStatus(tid(2)); await esplora.txStatus(tid(3)); }
  assert.equal(reads(1), 1, 'deep');
  assert.equal(reads(2), 3, 'shallow');
  assert.equal(reads(3), 3, 'unconfirmed');
  const s = await esplora.txStatus(tid(1)); s.block_height = 1;
  assert.equal((await esplora.txStatus(tid(1))).block_height, 500, 'a caller changing what it was given does not change what is kept');
});

test('a walk that is limited part way resumes where it stopped, and sends no read twice', async () => {
  // 120 transactions, each wanting its status; the source limits us after the 40th read and again later.
  let served = 0;
  const { esplora, seen, later } = rig(['a.test', 'b.test'], (u) => {
    if (u.pathname === '/api/blocks/tip/height') return res('5000');
    served++;
    if (served % 41 === 0) return res('slow down', 429, { 'retry-after': '30' });
    return res(status(100));
  }, { gapMs: 0, coolMs: 1000 });
  await esplora.tipHeight();
  const ids = Array.from({ length: 120 }, (_, n) => tid(n + 1));
  const done = new Set();
  let passes = 0;
  while (done.size < ids.length && passes < 50) {
    passes++;
    await Promise.allSettled(ids.filter((i) => !done.has(i)).map(async (i) => { await esplora.txStatus(i); done.add(i); }));
    later(35_000);
  }
  assert.equal(done.size, 120, 'the walk finished');
  const statusReads = seen.filter((s) => s.includes('/status'));
  const distinct = new Set(statusReads.map((s) => s.split('/').slice(-2)[0]));
  assert.equal(distinct.size, 120);
  assert.ok(statusReads.length <= 120 + 12, `${statusReads.length} reads for 120 transactions: only the limited ones were asked twice`);
});

test('health lists each source with its rest and last error', async () => {
  const { esplora } = rig(['a.test', 'b.test'], (u) => (u.hostname === 'a.test' ? res('no', 429, { 'retry-after': '45' }) : res('0123')));
  await esplora.rawTx(tid(1));
  assert.deepEqual(esplora.health(), [
    { source: 'a.test/api', restingSecs: 45, fails: 1, last: 'HTTP 429' },
    { source: 'b.test/api', restingSecs: 0, fails: 0, last: null },
  ]);
});

test('block hashes with a quorum come only from sources that are up, and need as many as the quorum', async () => {
  const hash = 'ab'.repeat(32);
  const { esplora } = rig(['a.test', 'b.test', 'c.test'], (u) => (u.hostname === 'c.test' ? res('no', 429) : res(hash)), { hashQuorum: 2, gapMs: 0 });
  assert.equal(await esplora.blockHash(5), hash, 'two of three agree');
  const second = await esplora.blockHash(6);
  assert.equal(second, hash, 'and the limited one is left out the next time');
  const two = rig(['a.test', 'b.test', 'c.test'], (u) => (u.hostname === 'a.test' ? res(hash) : res('no', 503)), { hashQuorum: 2, gapMs: 0 });
  await assert.rejects(two.esplora.blockHash(5), /of 2 sources answered|resting|sources up/);
});

test('the delay before the next pass: quick while catching up, slow when idle, backing off while it fails, never under what the sources ask', () => {
  const mid = () => 0.5; // jitter factor 1
  assert.equal(nextDelayMs({ behind: true, rnd: mid }), 1000);
  assert.equal(nextDelayMs({ behind: false, pollMs: 30000, rnd: mid }), 30000);
  const steps = [1, 2, 3, 4, 5, 6, 7, 20].map((failures) => nextDelayMs({ failures, behind: true, rnd: mid }));
  assert.deepEqual(steps, [5000, 10000, 20000, 40000, 80000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  assert.equal(nextDelayMs({ failures: 1, behind: true, restMs: 60_000, rnd: mid }), 60_500, 'waits for the rest');
  assert.equal(nextDelayMs({ failures: 1, behind: true, restMs: 10 * 60_000, rnd: mid }), MAX_BACKOFF_MS, 'but looks again within the cap');
  const lo = nextDelayMs({ failures: 3, behind: true, rnd: () => 0 }), hi = nextDelayMs({ failures: 3, behind: true, rnd: () => 1 });
  assert.ok(lo >= 0.85 * 20000 - 1 && hi <= 1.15 * 20000 + 1 && lo < hi, 'a little jitter');
});

test('mainnet always carries the public sources, in the order set first; signet and an explicit ONLY list are left alone', () => {
  const three = 'https://mempool.space/api,https://blockstream.info/api,https://mempool.emzy.de/api';
  assert.deepEqual(esploraSources('mainnet', { BTC_POOL_ESPLORA: three }), [
    'https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api', 'https://mempool.bitaroo.net/api',
  ]);
  assert.deepEqual(esploraSources('mainnet', { BTC_POOL_ESPLORA: 'https://own.test/api/, https://mempool.space/api' }), [
    'https://own.test/api', 'https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api', 'https://mempool.bitaroo.net/api',
  ], 'our own source first, no duplicates, trailing slash dropped');
  assert.deepEqual(esploraSources('mainnet', { BTC_POOL_ESPLORA: 'https://own.test/api', BTC_POOL_ESPLORA_ONLY: '1' }), ['https://own.test/api']);
  assert.equal(esploraSources('mainnet', {}).length, 4);
  assert.deepEqual(esploraSources('signet', {}), ['https://mempool.space/signet/api']);
  assert.deepEqual(esploraSources('signet', { BTC_POOL_ESPLORA: 'https://s.test/api' }), ['https://s.test/api']);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} esplora checks passed`);
process.exit(process.exitCode || 0);
