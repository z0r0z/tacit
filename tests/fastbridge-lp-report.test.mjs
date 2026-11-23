// The provider report (tools/fastbridge-lp-report.mjs): what it makes of a provider's log lines (swaps and how they ended, capacity, what was shielded, offers,
// trouble), and how it reads the logs from Render (pages, a rate limit, a refused key that is never printed). Synthetic logs in the daemon's own format.
//   node tests/fastbridge-lp-report.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { tac, tacWei, parseLines, summarize, render, fetchLogs, HOUSE } from '../tools/fastbridge-lp-report.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T0 = Date.parse('2026-11-23T06:00:00Z');
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const line = (min, o) => ({ timestamp: at(min), message: JSON.stringify({ ts: at(min), level: 'info', ...o }) });
const ONE = 10n ** 8n, WEI = 10n ** 18n;       // the pool counts in 8 places, the refill's log lines in the token's 18
const swap = (min, id, from, to, extra = {}) => line(min, { msg: 'swap', id, from, to, ...extra });
const idOf = (c) => c.repeat(72);

test('TAC as people read it: base units with 8 places, grouped, two places at most, and a value that is not a number says so', () => {
  assert.equal(tac('0'), '0'); assert.equal(tac(String(ONE)), '1'); assert.equal(tac(String(2536n * ONE)), '2,536'); assert.equal(tac(String(1000n * ONE + 5n * ONE / 10n)), '1,000.5');
  assert.equal(tac(String(ONE / 100n)), '0.01'); assert.equal(tac(String(ONE / 1000n)), '0', 'under two places shows as 0');
  assert.equal(tac(String(123456789n * ONE)), '123,456,789'); assert.equal(tac(null), '?'); assert.equal(tac('lots'), '?');
});

test('the refill\'s amounts are the token\'s own 18 places: 2,536 TAC reads as 2,536, not as a number ten digits larger', () => {
  assert.equal(tacWei(String(2536n * WEI)), '2,536'); assert.equal(tacWei(String(WEI / 2n)), '0.5'); assert.equal(tacWei('0'), '0'); assert.equal(tacWei(null), '?'); assert.equal(tacWei('lots'), '?');
  assert.notEqual(tac(String(2536n * WEI)), '2,536', 'read as pool units it is the wrong number: the two are not interchangeable');
});

test('parsing: the provider\'s JSON lines are kept with their fields, text that is not JSON is kept as it is, and the lines come out in time order', () => {
  const rows = [line(5, { msg: 'later' }), line(1, { msg: 'earlier', level: 'warn', error: 'x' }), { timestamp: at(3), message: 'Error: connect ECONNREFUSED 10.0.0.1:443' }, { timestamp: at(2), message: '   ' }, { timestamp: 'no', message: '{"msg":"no time","level":"info"}' }, null, { message: '[1,2]' }];
  const out = parseLines(rows);
  assert.deepEqual(out.map((e) => e.msg), ['no time', 'unstructured', 'earlier', 'unstructured', 'later'], 'lines with no time sort first (a JSON array is text, not a log line), blanks and nulls are dropped');
  const raw = out.find((e) => e.raw && /ECONNREFUSED/.test(e.raw));
  assert.equal(raw.level, 'error', 'a line that reads as an error is one'); assert.equal(raw.at, T0 + 3 * 60e3);
  assert.equal(out.find((e) => e.msg === 'earlier').error, 'x');
});

const SAMPLE = [
  line(0, { msg: 'capacity', held: String(2536n * ONE), promised: '0', open: 0, holds: 0 }),
  line(1, { msg: 'refill: shielded', amount: String(2536n * WEI), pulled: false }),
  swap(10, idOf('a'), 'none', 'accepted'), swap(12, idOf('a'), 'accepted', 'locking'), swap(40, idOf('a'), 'locked', 'offered'), swap(50, idOf('a'), 'taking', 'done'),
  swap(11, idOf('b'), 'none', 'accepted'), swap(100, idOf('b'), 'taking', 'done'),
  swap(20, idOf('c'), 'none', 'accepted'), swap(30, idOf('c'), 'locked', 'offered'),
  swap(25, idOf('d'), 'none', 'accepted'), swap(60, idOf('d'), 'locking', 'refunding'), swap(300, idOf('d'), 'refunding', 'refunded', { why: 'the user never claimed' }),
  swap(26, idOf('e'), 'none', 'accepted'), swap(27, idOf('e'), 'accepted', 'rejected', { why: 'the lock was spent' }),
  line(15, { msg: 'offer accepted', id: idOf('a') }), line(16, { msg: 'offer accepted', id: idOf('b') }),
  line(17, { msg: 'offer declined', level: 'warn', id: idOf('x'), retry: true, why: 'the lock has no confirmation yet' }), line(18, { msg: 'offer declined', level: 'warn', why: 'the lock has no confirmation yet' }), line(19, { msg: 'offer declined', level: 'warn', why: 'a note it cannot read' }),
  line(200, { msg: 'capacity', held: String(900n * ONE), promised: String(700n * ONE), open: 2, holds: 1 }),
  line(205, { msg: 'capacity', held: String(17n * ONE), promised: String(3n * ONE), open: 1, holds: 0 }),
  line(70, { msg: 'swap step failed', level: 'warn', id: idOf('c'), phase: 'offered', error: 'the explorer did not answer' }), line(71, { msg: 'swap step failed', level: 'warn', id: idOf('c'), error: 'the explorer is rate limited' }),
  line(120, { msg: 'a swap has waited long in taking', level: 'alert', id: idOf('c') }),
  { timestamp: at(130), message: 'Error: socket hang up' },
  line(210, { msg: 'refill: shielded', amount: String(5000n * WEI), pulled: false }),
];

test('the swaps: how many were seen, how each ended, how many are still open and where, and how long the finished ones took', () => {
  const r = summarize(parseLines(SAMPLE), { hours: 12 });
  assert.equal(r.swaps.seen, 5);
  assert.deepEqual(r.swaps.ended, { done: 2, refunded: 1, rejected: 1 });
  assert.deepEqual(r.swaps.open, { offered: 1 }); assert.equal(r.swaps.openCount, 1);
  assert.equal(r.swaps.finished, 2); assert.equal(r.swaps.medianMs, 89 * 60e3, 'the median of 40 and 89 minutes (the upper middle of two)'); assert.equal(r.swaps.slowestMs, 89 * 60e3);
  assert.deepEqual(r.swaps.notDone.map((n) => [n.id[0], n.phase, n.why]), [['d', 'refunded', 'the user never claimed']], 'the ones that did not go through are listed with why (a rejected one is the user\'s own, not listed)');
});

test('the swaps not over are listed, the longest in their phase first, each with the last error it was given', () => {
  const r = summarize(parseLines(SAMPLE), { hours: 12 });
  assert.deepEqual(r.swaps.openList, [{ id: idOf('c'), phase: 'offered', since: T0 + 30 * 60e3, error: 'the explorer is rate limited' }]);
  const more = summarize(parseLines([swap(5, idOf('p'), 'none', 'accepted'), swap(9, idOf('q'), 'none', 'locking'), swap(7, idOf('r'), 'none', 'taking'), line(8, { msg: 'swap step failed', level: 'warn', id: idOf('r'), error: 'broadcast refused: x' }), line(20, { msg: 'swap step failed', level: 'warn', id: idOf('r'), error: 'broadcast refused: y' }), swap(30, idOf('s'), 'taking', 'done')]), {});
  assert.deepEqual(more.swaps.openList.map((o) => [o.id[0], o.phase, o.error]), [['p', 'accepted', null], ['r', 'taking', 'broadcast refused: y'], ['q', 'locking', null]], 'oldest first; the latest error of each; a finished swap is not listed');
  const text = render(r);
  assert.match(text, /not over \(longest in its phase first\):\n\s+offered\s+cccccccccccc…\s+since 06:30 UTC\s+last error: the explorer is rate limited/);
  const many = summarize(parseLines(Array.from({ length: 15 }, (_, i) => swap(i, String.fromCharCode(97 + i).repeat(72), 'none', 'taking'))), {});
  assert.match(render(many), /… and 3 more/);
});

test('capacity, what the provider shielded, the offers it took and declined', () => {
  const r = summarize(parseLines(SAMPLE), { hours: 12 });
  assert.equal(r.capacity.samples, 3); assert.equal(r.capacity.first.held, String(2536n * ONE)); assert.equal(r.capacity.last.held, String(17n * ONE)); assert.equal(r.capacity.lowestHeld, 17n * ONE);
  assert.deepEqual(r.refills.map((x) => [x.amount, x.pulled]), [[String(2536n * WEI), false], [String(5000n * WEI), false]]);
  assert.equal(r.offers.accepted, 2);
  assert.deepEqual(r.offers.declined, [['the lock has no confirmation yet', 2], ['a note it cannot read', 1]], 'most common first');
});

test('trouble: warnings and errors grouped by what they say, most common first, with the last one of each; text errors count too', () => {
  const r = summarize(parseLines(SAMPLE), { hours: 12 });
  const by = Object.fromEntries(r.trouble.map((t) => [t.msg, t]));
  assert.equal(by['offer declined'].n, 3); assert.equal(by['swap step failed'].n, 2); assert.equal(by['a swap has waited long in taking'].n, 1);
  assert.equal(by['swap step failed'].last.error, 'the explorer is rate limited', 'the last of them');
  assert.ok(Object.keys(by).some((k) => /^unstructured: Error: socket hang up/.test(k)));
  assert.equal(r.trouble[0].msg, 'offer declined');
});

test('the text: it says what happened in words, puts what needs a look first, and says plainly when there is nothing', () => {
  const text = render(summarize(parseLines(SAMPLE), { hours: 12 }));
  for (const re of [/last 12 h: \d+ log lines/, /Swaps seen: 5\. Ended: 2 done, 1 refunded, 1 rejected\. Still open: 1 \(1 offered\)/, /median of 89 min/, /refunded: dddddddddddd….*the user never claimed/,
    /first held 2,536 TAC, promised 0 TAC, 0 open; last held 17 TAC, promised 3 TAC, 1 open, 0 holds; lowest held 17 TAC/, /Shielded by the provider itself: 2,536 TAC at 06:01, 5,000 TAC at 09:30/,
    /Offers: 2 accepted, 3 declined \(2x the lock has no confirmation yet; 1x a note it cannot read\)/, /LOOK AT THESE FIRST: 1x "a swap has waited long in taking"/]) assert.match(text, re);
  const quiet = render(summarize(parseLines([line(1, { msg: 'listening', port: 1 })]), { hours: 1 }));
  assert.match(quiet, /Swaps seen: 0\. Ended: none ended\./); assert.match(quiet, /no capacity lines/); assert.match(quiet, /Warnings and errors: none\./); assert.doesNotMatch(quiet, /LOOK AT THESE/);
  const empty = render(summarize([], { hours: 3 })); assert.match(empty, /0 log lines/);
  const lostText = render(summarize(parseLines([swap(1, idOf('z'), 'none', 'accepted'), swap(2, idOf('z'), 'offered', 'lost')]), {}));
  assert.match(lostText, /LOOK AT THESE FIRST: 1 lost swap\(s\)/);
});

// ── reading from Render ──
const page = (logs, next = null) => ({ logs, hasMore: !!next, nextStartTime: null, nextEndTime: next });
const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('reading the logs: every page of the window, newest first, the same row once, the key sent as a bearer and to Render only, the service and the window in the query', async () => {
  const calls = [];
  const pages = [page([{ id: '3', timestamp: at(30), message: 'c' }, { id: '2', timestamp: at(20), message: 'b' }], at(20)), page([{ id: '2', timestamp: at(20), message: 'b' }, { id: '1', timestamp: at(10), message: 'a' }])];
  const rows = await fetchLogs({ key: 'KEY-123', hours: 6, now: () => T0 + 60 * 60e3, fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(pages[calls.length - 1]); } });
  assert.deepEqual(rows.map((r) => r.id), ['3', '2', '1'], 'a row on two pages is read once');
  assert.equal(calls.length, 2);
  for (const c of calls) { assert.match(c.url, /^https:\/\/api\.render\.com\/v1\/logs\?/); assert.equal(c.init.headers.Authorization, 'Bearer KEY-123'); }
  const q = new URL(calls[0].url).searchParams;
  assert.deepEqual([q.get('ownerId'), q.get('resource'), q.get('type'), q.get('direction'), q.get('limit')], [HOUSE.owner, HOUSE.service, 'app', 'backward', '100']);
  assert.equal(q.get('startTime'), new Date(T0 + 60 * 60e3 - 6 * 3600e3).toISOString()); assert.equal(q.get('endTime'), new Date(T0 + 60 * 60e3).toISOString());
  assert.equal(new URL(calls[1].url).searchParams.get('endTime'), at(20), 'the next page ends where the last one began');
  const other = []; await fetchLogs({ key: 'k', service: 'srv-other', owner: 'tea-other', hours: 1, fetchImpl: async (url) => { other.push(new URL(url).searchParams); return respond(page([])); } });
  assert.deepEqual([other[0].get('resource'), other[0].get('ownerId')], ['srv-other', 'tea-other']);
});

test('a page that says there is more but points nowhere new ends the read instead of looping, and the pages are capped', async () => {
  let n = 0;
  const same = await fetchLogs({ key: 'k', now: () => T0, fetchImpl: async () => { n++; return respond({ logs: [{ id: String(n), timestamp: at(1), message: 'x' }], hasMore: true, nextEndTime: new Date(T0).toISOString() }); } });
  assert.equal(n, 1); assert.equal(same.length, 1);
  let m = 0;
  const capped = await fetchLogs({ key: 'k', now: () => T0, maxPages: 5, fetchImpl: async () => { m++; return respond({ logs: [{ id: String(m), timestamp: at(1), message: 'x' }], hasMore: true, nextEndTime: at(-m) }); } });
  assert.equal(m, 5); assert.equal(capped.length, 5);
});

test('a rate limit is waited out and asked again; a key that is refused is said so without printing it, and so is any other failure', async () => {
  const sleeps = []; let n = 0;
  const rows = await fetchLogs({ key: 'SECRET-KEY', now: () => T0, sleep: async (ms) => { sleeps.push(ms); }, fetchImpl: async () => { n++; return n < 3 ? respond('slow down', 429) : respond(page([{ id: '1', timestamp: at(1), message: 'ok' }])); } });
  assert.equal(rows.length, 1); assert.deepEqual(sleeps, [1500, 3000], 'a growing wait');
  for (const status of [401, 403, 500]) {
    const e = await fetchLogs({ key: 'SECRET-KEY', now: () => T0, sleep: async () => {}, fetchImpl: async () => respond('nope SECRET-KEY? no, just nope', status) }).then(() => null, (x) => x);
    assert.match(e.message, new RegExp(`Render answered ${status}`)); if (status !== 500) assert.match(e.message, /the key was not accepted/);
  }
  const never = await fetchLogs({ key: 'k', now: () => T0, sleep: async () => {}, fetchImpl: async () => respond('busy', 429) }).then(() => null, (x) => x);
  assert.match(never.message, /Render answered 429/, 'six asks and no more');
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} provider report checks passed`);
process.exit(process.exitCode || 0);
