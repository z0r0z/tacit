// How the user's side reads a provider's HTTP answer (dapp/fastbridge-http.js): the provider's own "no" is final, and what the edge in front of it says is not.
//   node tests/fastbridge-http-answers.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeCounter } from '../dapp/fastbridge-http.js';

const counterFor = (reply) => makeCounter(async () => reply);
const offer = (c) => c.sendOffer({ quoteId: 'q', offer: {} });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the provider\'s own answer is read as it is, and its busy answer is a retry', async () => {
  assert.deepEqual(await offer(counterFor({ status: 200, body: { ok: true, phase: 'accepted' } })), { ok: true, phase: 'accepted' });
  assert.deepEqual(await offer(counterFor({ status: 200, body: { ok: false, retry: false, why: 'quote expired' } })), { ok: false, retry: false, why: 'quote expired' });
  const busy = await offer(counterFor({ status: 429, body: null }));
  assert.equal(busy.ok, false); assert.equal(busy.retry, true);
});

test('a refusal with the provider\'s error in its body is final', async () => {
  const r = await offer(counterFor({ status: 400, body: { error: 'the amount does not cover the fee' } }));
  assert.deepEqual(r, { ok: false, retry: false, why: 'the amount does not cover the fee' });
});

test('a 404, 408 or 425 is the edge not answering: a retry, not a refusal that sends the lock to its refund', async () => {
  for (const status of [404, 408, 425]) {
    const r = await offer(counterFor({ status, body: status === 404 ? { error: 'not found' } : null }));
    assert.equal(r.ok, false, String(status));
    assert.equal(r.retry, true, `${status} is asked again`);
    assert.match(r.why, /did not answer/);
  }
});

test('a 4xx with no error from the provider (a proxy or firewall page) is thrown, to be asked again, not read as a refusal', async () => {
  for (const status of [401, 403, 451]) {
    await assert.rejects(offer(counterFor({ status, body: null })), (e) => e.status === status, String(status));
  }
});

test('a server error is still thrown', async () => {
  await assert.rejects(offer(counterFor({ status: 502, body: null })), (e) => e.status === 502);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} answer checks passed`);
process.exit(process.exitCode || 0);
