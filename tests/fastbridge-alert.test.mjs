// The provider's alerts (fastbridge-lp/lib/alert.mjs): every one is logged; with a webhook set it is also posted as JSON, with one readable line under
// `text` (Slack) and `content` (Discord) as well as its own fields; a webhook that fails or hangs never reaches the provider.
//   node tests/fastbridge-alert.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { alertLine, makeAlert } from '../fastbridge-lp/lib/alert.mjs';
import { waitingFields } from '../fastbridge-lp/lib/wants.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the line says who, how bad, what, and the details a person needs, and leaves out what is not a plain value', () => {
  const line = alertLine({ level: 'alert', msg: 'a swap has waited long in taking', id: 'abc:0', error: null, nested: { a: 1 }, count: 2 }, 'Tacit');
  assert.equal(line, '[Tacit] ALERT: a swap has waited long in taking (id: abc:0, count: 2)');
  assert.equal(alertLine({ msg: 'plain' }), '[fast bridge LP] INFO: plain');
  assert.equal(alertLine({ level: 'warn', msg: 'x', why: 'two\nlines\tof   text' }), '[fast bridge LP] WARN: x (why: two lines of text)');
});

test('a long alert is cut to what a chat message takes', () => {
  const line = alertLine({ level: 'warn', msg: 'm', a: 'x'.repeat(5000), b: 'y'.repeat(5000), c: 'z'.repeat(5000), d: 'w'.repeat(5000), e: 'v'.repeat(5000), f: 'u'.repeat(5000), g: 'u'.repeat(5000), h: 'u'.repeat(5000), i: 'u'.repeat(5000), j: 'u'.repeat(5000) });
  assert.ok(line.length <= 1800, 'under the 2,000 characters of a Discord message');
  assert.ok(line.endsWith('…'));
});

test('without a webhook an alert is only logged', async () => {
  const logs = [], posts = [];
  makeAlert({ log: (o) => logs.push(o), fetchImpl: async (...a) => { posts.push(a); } })({ level: 'alert', msg: 'm' });
  assert.deepEqual(logs, [{ level: 'alert', msg: 'm' }]);
  assert.deepEqual(posts, []);
});

test('with a webhook it is logged and posted: its own fields, and the readable line as text and as content', async () => {
  const logs = [], posts = [];
  const alert = makeAlert({ log: (o) => logs.push(o), webhook: 'https://hooks.example/x', name: 'Tacit', fetchImpl: async (url, init) => { posts.push([url, init]); return { ok: true }; } });
  alert({ level: 'warn', msg: 'the provider is running out of private TAC to lend', free: '757', held: '1754' });
  assert.equal(logs.length, 1);
  assert.equal(posts.length, 1);
  const [url, init] = posts[0], body = JSON.parse(init.body);
  assert.equal(url, 'https://hooks.example/x');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(body.text, body.content);
  assert.equal(body.text, '[Tacit] WARN: the provider is running out of private TAC to lend (free: 757, held: 1754)');
  assert.deepEqual([body.level, body.msg, body.free, body.held], ['warn', 'the provider is running out of private TAC to lend', '757', '1754']);
});

test('a webhook that rejects, throws at once, or answers with something that is not a promise never reaches the provider', async () => {
  const logs = [];
  for (const fetchImpl of [async () => { throw new Error('down'); }, () => { throw new Error('threw at once'); }, () => Promise.reject(new Error('rejected')), () => 7]) {
    const alert = makeAlert({ log: (o) => logs.push(o), webhook: 'https://hooks.example/x', fetchImpl });
    assert.doesNotThrow(() => alert({ level: 'alert', msg: 'm' }));
  }
  await new Promise((r) => setTimeout(r, 10));                   // an unhandled rejection would end the test process
  assert.equal(logs.length, 4, 'each was still logged');
});

const TAC = 10n ** 8n;
test('bridges waiting for a provider: the readable line says how many and the largest, and, when some name a price, what they pay at most and how many this fee meets', () => {
  const quote = { feeBps: 30, flatFee: String(TAC / 10n) };      // 0.30% and 0.1 TAC: 0.40% of 100 TAC, 0.31% of 1,000
  // none names a price: the alert is what it was, with the largest in words
  const plain = waitingFields([{ amount: String(100n * TAC), maxFeeBps: null }, { amount: String(7999n * TAC), maxFeeBps: null }], quote);
  assert.deepEqual(plain, { count: 2, amounts: [String(100n * TAC), String(7999n * TAC)], prices: [null, null], largest: '7,999 TAC' });
  assert.equal(alertLine({ level: 'warn', msg: 'bridges are waiting for a provider', ...plain }, 'Tacit'), '[Tacit] WARN: bridges are waiting for a provider (count: 2, largest: 7,999 TAC)');
  // some do: the highest price offered, and how many of all of them this provider's fee meets (one that names none is met by any)
  const mixed = waitingFields([{ amount: String(100n * TAC), maxFeeBps: 100 }, { amount: String(100n * TAC), maxFeeBps: 39 }, { amount: String(1000n * TAC), maxFeeBps: null }, { amount: String(3873n * TAC / 10n), maxFeeBps: 0 }], quote);
  assert.deepEqual(mixed.prices, [100, 39, null, 0]);
  assert.equal(mixed.payUpTo, '1.00%'); assert.equal(mixed.atYourFee, '2 of 4', 'the 1.00% one and the one with no price; not 0.39% (it keeps 0.40%), not no fee at all');
  assert.equal(mixed.largest, '1,000 TAC');
  assert.equal(alertLine({ level: 'warn', msg: 'bridges are waiting for a provider', ...mixed }, 'Tacit'), '[Tacit] WARN: bridges are waiting for a provider (count: 4, largest: 1,000 TAC, payUpTo: 1.00%, atYourFee: 2 of 4)', 'the arrays stay in the JSON, the line has the scalars');
  // a provider that keeps nothing meets even a price of nothing
  assert.equal(waitingFields([{ amount: String(5n * TAC), maxFeeBps: 0 }], { feeBps: 0, flatFee: '0' }).atYourFee, '1 of 1');
  // places: two when there are some, none when there are none
  assert.equal(waitingFields([{ amount: String(12n * TAC + TAC / 2n), maxFeeBps: null }], quote).largest, '12.5 TAC');
  assert.equal(waitingFields([{ amount: String(12n * TAC + TAC / 4n), maxFeeBps: null }], quote).largest, '12.25 TAC');
  assert.equal(waitingFields([{ amount: '5', maxFeeBps: null }], quote).largest, '0 TAC', 'dust is under two places');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} alert checks passed`);
process.exit(process.exitCode || 0);
