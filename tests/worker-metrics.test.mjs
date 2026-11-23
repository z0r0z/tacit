// The site's usage counters (worker/src/metrics.js): counts of named events per UTC day and nothing else. What it must do: count only names on its list, never grow or lose a
// count to a flood or a failing store, keep days apart, honour Do Not Track, and hold no trace of who sent anything.
// Run: node --test tests/worker-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMetrics, handleMetricEvent, handleMetricsGet, CLIENT_EVENTS, SERVER_EVENTS, metricsKey } from '../worker/src/metrics.js';

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0), DAY = 86400_000;
function rig(over = {}) {
  let t = T0; const timers = [], puts = [], m = new Map(); let down = false, gets = 0;
  const kv = {
    get: async (k) => { gets++; if (down) throw new Error('store down'); const v = m.get(k); return v == null ? null : JSON.parse(v); },
    put: async (k, v, o) => { if (down) throw new Error('store down'); puts.push({ k, o }); m.set(k, v); },
  };
  const metrics = makeMetrics({ kv, now: () => t, timer: (fn, ms) => { timers.push({ fn, ms }); return 0; }, ...over });
  return { metrics, kv, m, puts, timers, gets: () => gets, resetGets: () => { gets = 0; }, tick: (ms) => { t += ms; }, setDown: (d) => { down = d; }, fire: async () => { const ts = timers.splice(0); for (const x of ts) await x.fn(); await new Promise((r) => setImmediate(r)); } };
}
const stored = (r, day = '2026-11-23') => JSON.parse(r.m.get(metricsKey(day)) || 'null');

test('events are counted per day and written together after a short wait, with an expiry', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) assert.equal(r.metrics.record('trade_view'), 'ok');
  assert.equal(r.metrics.record('lane_btc'), 'ok');
  assert.equal(r.timers.length, 1, 'one write is planned, not one per event');
  assert.equal(r.m.size, 0, 'nothing is written yet');
  await r.fire();
  assert.deepEqual(stored(r), { trade_view: 3, lane_btc: 1 });
  assert.equal(r.puts[0].o.expirationTtl, 120 * 86400, 'a day\'s counts are kept for 120 days');
  assert.equal(r.timers.length, 0, 'and nothing more is planned');
});

test('only names on the list are counted; a name only the server may count is refused from a page', async () => {
  const r = rig();
  assert.equal(r.metrics.record('hack'), 'unknown'); assert.equal(r.metrics.record(''), 'unknown'); assert.equal(r.metrics.record(null), 'unknown');
  assert.equal(r.metrics.record('x'.repeat(5000)), 'unknown'); assert.equal(r.metrics.record({ toString: () => 'trade_view' }), 'unknown');
  assert.equal(r.metrics.record('book_load'), 'unknown', 'a page cannot claim a book load');
  assert.equal(r.metrics.record('book_load', { fromClient: false }), 'ok', 'the API counts its own');
  await r.fire();
  assert.deepEqual(stored(r), { book_load: 1 });
  assert.ok(CLIENT_EVENTS.every((n) => /^[a-z_]{1,32}$/.test(n)) && SERVER_EVENTS.every((n) => /^[a-z_]{1,32}$/.test(n)));
});

test('more than the cap of one name in a minute is dropped, other names are not held back, and the minute passes', async () => {
  const r = rig({ perMin: 5 });
  const got = Array.from({ length: 8 }, () => r.metrics.record('trade_view'));
  assert.deepEqual(got, ['ok', 'ok', 'ok', 'ok', 'ok', 'capped', 'capped', 'capped']);
  assert.equal(r.metrics.record('lane_btc'), 'ok');
  r.tick(61_000);
  assert.equal(r.metrics.record('trade_view'), 'ok');
  await r.fire();
  assert.deepEqual(stored(r), { trade_view: 6, lane_btc: 1 }, 'a flood adds 5 a minute at most');
});

test('a count belongs to the UTC day it happened in, even when it is written later', async () => {
  const r = rig();
  r.tick(11 * 3600_000 + 59 * 60_000 + 50_000);                       // 23:59:50
  r.metrics.record('trade_view');
  r.tick(20_000);                                                     // 00:00:10 the next day
  r.metrics.record('trade_view'); r.metrics.record('trade_view');
  await r.fire();
  assert.deepEqual(stored(r, '2026-11-23'), { trade_view: 1 });
  assert.deepEqual(stored(r, '2026-11-24'), { trade_view: 2 });
});

test('what was already stored is added to, not replaced (another instance, or an earlier flush)', async () => {
  const r = rig();
  r.m.set(metricsKey('2026-11-23'), JSON.stringify({ trade_view: 10, lane_btc: 4 }));
  r.metrics.record('trade_view'); r.metrics.record('btc_bought');
  await r.fire();
  assert.deepEqual(stored(r), { trade_view: 11, lane_btc: 4, btc_bought: 1 });
});

test('two writes at once for one day lose nothing', async () => {
  const r = rig();
  r.metrics.record('trade_view'); r.metrics.record('trade_view');
  const a = r.metrics.flush();
  r.metrics.record('trade_view'); r.metrics.record('lane_btc');
  const b = r.metrics.flush();
  await Promise.all([a, b]);
  assert.deepEqual(stored(r), { trade_view: 3, lane_btc: 1 });
});

test('a store that is down loses nothing: the counts are kept and written when it is back', async () => {
  const r = rig();
  r.metrics.record('trade_view'); r.metrics.record('trade_view');
  r.setDown(true);
  await r.metrics.flush();                                            // does not throw
  assert.equal(r.m.size, 0);
  assert.ok(r.timers.length >= 1, 'it tries again');
  r.metrics.record('trade_view');
  r.setDown(false);
  await r.fire();
  assert.deepEqual(stored(r), { trade_view: 3 });
});

test('a stored value that is not a count table (damaged, or something else) is treated as empty, never thrown on', async () => {
  for (const bad of ['[1,2,3]', '"text"', '{"trade_view":"x"}', '{"unknown_name":5}']) {
    const r = rig(); r.m.set(metricsKey('2026-11-23'), bad);
    r.metrics.record('trade_view'); await r.fire();
    const v = stored(r);
    assert.equal(v.trade_view, 1, bad);
  }
});

test('reading gives the last days that have counts, newest first, with what is not yet written included; the number of days is bounded', async () => {
  const r = rig();
  r.m.set(metricsKey('2026-11-21'), JSON.stringify({ trade_view: 7 }));
  r.m.set(metricsKey('2026-11-23'), JSON.stringify({ trade_view: 5, lane_btc: 2 }));
  r.metrics.record('trade_view');                                     // 1 more, still in memory
  const out = await r.metrics.read(14);
  assert.deepEqual(out.days, [{ day: '2026-11-23', counts: { trade_view: 6, lane_btc: 2 } }, { day: '2026-11-21', counts: { trade_view: 7 } }]);
  assert.deepEqual((await r.metrics.read(1)).days.map((d) => d.day), ['2026-11-23']);
  r.resetGets();
  assert.equal((await r.metrics.read(9999)).days.length, 2, 'bounded to 31 days');
  assert.equal(r.gets(), 31, 'and a request for a million days reads 31 days from the store, not a million');
  r.resetGets(); await r.metrics.read(0); assert.equal(r.gets(), 14, 'zero days reads the default'); r.resetGets(); await r.metrics.read(-5); assert.equal(r.gets(), 1, 'a negative number reads one day');
  assert.equal((await r.metrics.read('abc')).days.length, 2, 'a bad number reads the default');
});

test('nothing that identifies a sender is read or kept: the request\'s address headers do not reach the store', async () => {
  const r = rig();
  const req = new Request('https://api.example/metrics/event', { method: 'POST', body: 'lane_btc', headers: { 'content-type': 'text/plain', 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'SecretBrowser/1', origin: 'https://tacit.finance' } });
  const res = await handleMetricEvent(req, r.metrics);
  await r.fire();
  assert.equal(res.status, 204);
  const all = [...r.m.values()].join(' ');
  assert.ok(!/203\.0\.113|SecretBrowser|tacit\.finance/.test(all), 'no address, agent or origin in what is stored');
  assert.deepEqual(stored(r), { lane_btc: 1 });
  assert.deepEqual(Object.values(stored(r)).every((v) => Number.isInteger(v)), true, 'only whole counts');
});

test('the endpoint always answers 204, counts a valid name, and does not count a browser that asked not to be', async () => {
  const r = rig(), post = (body, headers = {}) => handleMetricEvent(new Request('https://api.example/metrics/event', { method: 'POST', body, headers }), r.metrics);
  assert.equal((await post('lane_btc')).status, 204);
  assert.equal((await post('lane_btc', { DNT: '1' })).status, 204);
  assert.equal((await post('lane_btc', { 'Sec-GPC': '1' })).status, 204);
  assert.equal((await post('not a name')).status, 204, 'a name that is refused is answered like one that is counted');
  assert.equal((await post('')).status, 204);
  assert.equal((await post('book_load')).status, 204);
  assert.equal((await post('lane_btc' + ' '.repeat(300), { 'content-length': '308' })).status, 204, 'a body too long to be a name is answered like the rest');
  assert.equal((await post('trade_view' + ' '.repeat(80))).status, 204, 'and padding past a name\'s length, whatever it is followed by, is not one either');
  await r.fire();
  assert.deepEqual(stored(r), { lane_btc: 1 }, 'one counted: not the two that asked not to be, nor the refused names');
  const res = await post('trade_view');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*'); assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('a body that says it is big is not read at all', async () => {
  const r = rig(); let read = false;
  const big = { headers: new Headers({ 'content-length': '100000' }), text: async () => { read = true; return 'trade_view'; } };
  assert.equal((await handleMetricEvent(big, r.metrics)).status, 204);
  assert.equal(read, false, 'its text is never asked for');
  const small = { headers: new Headers({ 'content-length': '10' }), text: async () => { read = true; return 'trade_view'; } };
  await handleMetricEvent(small, r.metrics);
  assert.equal(read, true); await r.fire();
  assert.deepEqual(stored(r), { trade_view: 1 }, 'a small one is counted');
});

test('the read answers with the counts and a note, and may be cached for a minute', async () => {
  const r = rig(); r.metrics.record('trade_view'); r.metrics.record('btc_bought'); await r.fire();
  const res = await handleMetricsGet(new URL('https://api.example/metrics?days=3'), r.metrics);
  assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60'); assert.equal(res.headers.get('Content-Type'), 'application/json');
  const j = await res.json();
  assert.deepEqual(j.days, [{ day: '2026-11-23', counts: { trade_view: 1, btc_bought: 1 } }]);
  assert.match(j.note, /nothing identifies anyone/);
});

// Through the worker's own request handler, as a browser reaches it: the beacon, its preflight, the book (which counts a load) and the read.
test('through the worker: a beacon is counted, its preflight passes, a book request is counted as a load, and the counts can be read back', async () => {
  const mem = new Map();
  globalThis.caches = { default: { match: async (k) => mem.get(String(k.url || k)), put: async (k, v) => { mem.set(String(k.url || k), v); } } };
  const { default: worker } = await import('../worker/src/index.js');
  const store = new Map();
  const kv = { get: async (k, t) => { const v = store.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => store.set(k, typeof v === 'string' ? v : JSON.stringify(v)), delete: async (k) => store.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
  const env = { REGISTRY_KV: kv, ALLOWED_ORIGINS: '*' }, ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const call = (url, init) => worker.fetch(new Request('https://api.test' + url, init), env, ctx);
  let r = await call('/metrics/event', { method: 'POST', body: 'lane_btc', headers: { origin: 'https://tacit.finance', 'content-type': 'text/plain' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('/metrics/event', { method: 'OPTIONS', headers: { origin: 'https://tacit.finance', 'access-control-request-method': 'POST' } })).status, 204);
  const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  assert.equal((await call(`/assets/${TAC}/preauth-sales?view=book&network=mainnet`)).status, 200);
  assert.equal((await call(`/assets/${TAC}/preauth-sales?network=mainnet`)).status, 200);          // not the book view: not counted
  r = await call('/metrics?days=1');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).days[0].counts, { lane_btc: 1, book_load: 1 });
  assert.equal((await call('/metrics', { method: 'POST', body: 'x' })).status !== 200, true, 'the read is a GET');
});
