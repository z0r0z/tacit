// The page side of the usage counters (dapp/metrics.js): when it sends, what it sends, and that every name a page counts is one the API accepts.
// Run: node --test tests/dapp-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS, SOURCES, enabled, makeCount } from '../dapp/metrics.js';
import { CLIENT_EVENTS } from '../worker/src/metrics.js';

const live = (over = {}) => ({
  location: { protocol: 'https:', hostname: 'tacit.finance' },
  navigator: { webdriver: false, sendBeacon: () => true },
  localStorage: { getItem: () => null },
  document: { visibilityState: 'visible' },
  ...over,
});
const withNav = (nav) => live({ navigator: { webdriver: false, sendBeacon: () => true, ...nav } });

test('the page\'s names are the API\'s names, exactly, so neither side drops what the other sends', () => {
  assert.deepEqual([...EVENTS].sort(), [...CLIENT_EVENTS].sort());
  assert.equal(new Set(EVENTS).size, EVENTS.length, 'no name twice');
});

test('a link\'s source is one of five, and each has its own count', () => {
  assert.deepEqual(SOURCES, ['menu', 'chip', 'lander', 'assets', 'share']);
  for (const s of SOURCES) assert.ok(EVENTS.includes(`trade_via_${s}`), s);
  assert.equal(EVENTS.filter((e) => e.startsWith('trade_via_')).length, SOURCES.length);
});

test('it sends only on the live site, in a real browser that has not said no', () => {
  assert.equal(enabled(live()), true);
  assert.equal(enabled(live({ location: { protocol: 'http:', hostname: 'tacit.finance' } })), false, 'not over http');
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(enabled(live({ location: { protocol: 'https:', hostname: h } })), false, h);
  assert.equal(enabled(withNav({ webdriver: true })), false, 'not from automation');
  assert.equal(enabled(withNav({ doNotTrack: '1' })), false, 'not with Do Not Track');
  assert.equal(enabled(live({ doNotTrack: '1' })), false);
  assert.equal(enabled(withNav({ msDoNotTrack: '1' })), false);
  assert.equal(enabled(withNav({ globalPrivacyControl: true })), false, 'not with Global Privacy Control');
  assert.equal(enabled(withNav({ doNotTrack: '0' })), true, 'Do Not Track set to no is a yes');
  assert.equal(enabled(live({ localStorage: { getItem: (k) => (k === 'tacit-metrics' ? '0' : null) } })), false, 'not when the visitor switched it off');
  assert.equal(enabled(live({ localStorage: { getItem: () => { throw new Error('blocked'); } } })), true, 'storage that throws is not a reason to refuse');
  assert.equal(enabled(live({ document: { visibilityState: 'prerender' } })), false, 'not while the page is only being prepared');
  assert.equal(enabled({}), false); assert.equal(enabled(null), false); assert.equal(enabled(undefined) === true || enabled(undefined) === false, true);
});

test('what goes out is the name alone, by beacon, to the API\'s endpoint', () => {
  const sent = [];
  const env = live({ navigator: { webdriver: false, sendBeacon: (u, b) => { sent.push([u, b]); return true; } } });
  const count = makeCount(env, { base: 'https://api.example' });
  assert.equal(count('lane_btc'), true);
  assert.deepEqual(sent, [['https://api.example/metrics/event', 'lane_btc']], 'a URL and a string: no address, no id, no data object');
});

test('a name that is not on the list is not sent, and a mistyped one never reaches the network', () => {
  const sent = [];
  const count = makeCount(live({ navigator: { webdriver: false, sendBeacon: (u, b) => { sent.push(b); return true; } }, fetch: () => { sent.push('fetch'); return Promise.resolve(); } }));
  for (const bad of ['', 'lane_bitcoin', 'book_load', 'x'.repeat(100), null, undefined, 5, {}, ['lane_btc']]) assert.equal(count(bad), false, String(bad));
  assert.deepEqual(sent, []);
});

test('once means once for the page, and a name asked for twice without it is sent twice', () => {
  const sent = [];
  const count = makeCount(live({ navigator: { webdriver: false, sendBeacon: (u, b) => { sent.push(b); return true; } } }));
  assert.equal(count('trade_view', { once: true }), true); assert.equal(count('trade_view', { once: true }), false);
  count('lane_btc'); count('lane_btc');
  assert.deepEqual(sent, ['trade_view', 'lane_btc', 'lane_btc']);
});

test('when the beacon is refused it falls back to a keep-alive fetch with no credentials, and a failure is nobody\'s problem', async () => {
  const calls = [];
  const env = live({ navigator: { webdriver: false, sendBeacon: () => false }, fetch: (u, o) => { calls.push([u, o]); return Promise.reject(new Error('offline')); } });
  const count = makeCount(env, { base: 'https://api.example' });
  assert.equal(count('lane_eth'), true);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'https://api.example/metrics/event');
  assert.equal(calls[0][1].method, 'POST'); assert.equal(calls[0][1].body, 'lane_eth'); assert.equal(calls[0][1].credentials, 'omit'); assert.equal(calls[0][1].keepalive, true);
  await new Promise((r) => setImmediate(r));                 // the rejection is caught: no unhandled rejection fails this test
  const thrower = makeCount(live({ navigator: { webdriver: false, sendBeacon: () => { throw new Error('boom'); } } }));
  assert.equal(thrower('lane_eth'), false, 'a throwing beacon is swallowed');
  assert.equal(makeCount(live({ navigator: { webdriver: false } }))('lane_eth'), false, 'no beacon and no fetch: nothing sent, nothing thrown');
});

test('nothing is sent from a browser that said no, by any path', () => {
  const sent = [];
  const env = withNav({ doNotTrack: '1', sendBeacon: (u, b) => { sent.push(b); return true; } });
  env.fetch = () => { sent.push('fetch'); return Promise.resolve(); };
  const count = makeCount(env);
  for (const e of EVENTS) assert.equal(count(e), false);
  assert.deepEqual(sent, []);
});

// Every event a page, the sheet or the lander counts is spelled in the source: each literal name must be on the list (a typo would count nothing and nobody would know).
test('every event name the pages count is on the list', () => {
  const files = ['dapp/trade/app.js', 'dapp/trade/btc.js', 'dapp/index.html'].map((f) => join(new URL('..', import.meta.url).pathname, f));
  const names = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:metric|tally)\(\s*'([a-z_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/\b(?:metric|tally)\(\s*`([a-z_]*)\$\{/g)) names.add(`${m[1]}…`);
  }
  assert.ok(names.size >= 8, `the pages count a good many things (${[...names].join(',')})`);
  for (const n of names) {
    if (n.endsWith('…')) assert.ok(EVENTS.some((e) => e.startsWith(n.slice(0, -1))), n);
    else assert.ok(EVENTS.includes(n), `${n} is counted by a page but is not on the list`);
  }
  // the names built from a variable: the five link sources, the four button kinds, and the btc_ names the sheet builds from what settled
  for (const k of ['buy', 'bid', 'sell', 'list']) assert.ok(EVENTS.includes(`${k}_btc_click`), k);
  for (const k of ['bought', 'sold', 'listed']) assert.ok(EVENTS.includes(`btc_${k}`), k);
});

test('the pages that link to the trade page name where the link is', () => {
  const root = new URL('..', import.meta.url).pathname;
  const read = (f) => readFileSync(join(root, f), 'utf8');
  assert.match(read('build/chrome.mjs'), /'\/trade\/tac\/\?src=menu', 'Trade'/);
  assert.match(read('dapp/chrome.js'), /'\/trade\/tac\/\?src=menu':/, 'the More page has a line for it');
  const lander = read('dapp/index.html');
  assert.match(lander, /href="\/trade\/tac\/\?src=lander"/); assert.match(lander, /\/trade\/tac\/\?lane=btc&src=chip/); assert.match(lander, /\/trade\/tac\/\?src=chip/);
  assert.match(read('dapp/assets/index.html'), /href="\/trade\/tac\/\?src=assets"/);
  for (const f of ['dapp/index.html', 'dapp/assets/index.html']) for (const m of read(f).matchAll(/\/trade\/tac\/\?[^"'`\s)]*src=([a-z]+)/g)) assert.ok(SOURCES.includes(m[1]), `${f}: ${m[1]}`);
});

// A nothing that walks the dapp for stray reads of what a visitor is: the counter module reads no cookie, no address, no wallet and no storage but its own off switch.
test('the counter module reads nothing that identifies a visitor', () => {
  const src = readFileSync(new URL('../dapp/metrics.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/document\.cookie|\.cookie\b|ethereum|wallet|address|location\.(href|search|hash|pathname)|userAgent|fingerprint|canvas|Intl\.|screen\./i.test(src), 'no cookie, wallet, address, page address or device detail');
  const stores = [...src.matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
  assert.deepEqual(stores, ["getItem('tacit-metrics')"], 'storage is read for the off switch and written never');
  assert.ok(/credentials: 'omit'/.test(src));
});
