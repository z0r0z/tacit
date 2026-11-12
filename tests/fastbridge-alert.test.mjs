// The provider's alerts (fastbridge-lp/lib/alert.mjs): every one is logged; with a webhook set it is also posted as JSON, with one readable line under
// `text` (Slack) and `content` (Discord) as well as its own fields; a webhook that fails or hangs never reaches the provider.
//   node tests/fastbridge-alert.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { alertLine, makeAlert } from '../fastbridge-lp/lib/alert.mjs';

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

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} alert checks passed`);
process.exit(process.exitCode || 0);
