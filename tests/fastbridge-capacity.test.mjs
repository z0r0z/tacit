// How much of the Bitcoin and ETH provider, its board and the page's quote stays open to others when one client sends a lot: the providers a quote asks, how
// long it waits on each, and the board's room for the site's own ads.
//   node tests/fastbridge-capacity.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { pairWorld, SATS, UNITS } from './lib/pair-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// eight ads that ask no fee and never answer, with new keys on every read of the board
const fakesOf = (real, round) => Array.from({ length: 8 }, (_, i) => ({
  id: `fake-${round}-${i}`, name: 'Provider', ref: { kind: 'mailbox', fake: true }, assets: real.assets,
  terms: { ...real.terms, feeBps: 0, flatFee: 0n, minAmount: 1n, maxAmount: 10n ** 12n }, reverse: { feeBps: 0, flatFee: 0n, minAmount: 1n, maxAmount: 10n ** 12n, available: null },
}));
const never = (n = () => {}) => makeCounter(() => (n(), new Promise(() => {})));
// a transport to the world's provider that counts the quotes it is asked for
const toFwd = (w, n) => makeCounter(async (m, path, body) => { if (path === '/quote') n(); const r = await w.fwd.handle({ method: m, path, body }); return { status: r.status, body: r.body }; });
const toRev = (w, n) => async (m, path, body) => { if (path === '/reverse/quote') n(); const r = await w.rev.handle({ method: m, path, body }); return { status: r.status, body: r.body }; };

test('page: a provider /fast/lp.json names is asked for every quote, whatever other ads the board lists, and at most four of those are asked', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  const real = await w.discover();
  let houseAsked = 0, fakesAsked = 0, round = 0;
  const pair = w.makePair({
    discover: async () => [...real, ...fakesOf(real[0], round)],
    counterFor: (ref) => (ref.fake ? never(() => fakesAsked++) : toFwd(w, () => houseAsked++)),
    reverseCallFor: (ref) => (ref.fake ? () => (fakesAsked++, new Promise(() => {})) : toRev(w, () => houseAsked++)),
    policy: { askMs: 20 },
  });
  for (let i = 0; i < 5; i++) {
    for (const dir of ['b2e', 'e2b']) {
      round++; const before = fakesAsked;
      const q = await pair.quote({ dir, amount: dir === 'b2e' ? SATS : UNITS });
      assert.equal(q.provider.id, 'lp1', `${dir}: the named provider's quote`);
      assert.ok(fakesAsked - before <= 4, `${dir}: ${fakesAsked - before} of the other ads asked`);
    }
  }
  assert.equal(houseAsked, 10, 'asked for every quote');
});

test('page: a provider this key finished a swap with is asked although it is only an ad on the board', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  const [real] = await w.discover();
  const onBoard = { ...real, ref: { ...real.ref, kind: 'mailbox' } };
  let houseAsked = 0, round = 0;
  const pair = w.makePair({
    discover: async () => [onBoard, ...fakesOf(real, ++round)],
    counterFor: (ref) => (ref.fake ? never() : toFwd(w, () => houseAsked++)),
    policy: { askMs: 20 },
  });
  // an ad like any other: past the four that ask no fee, it is not asked
  await assert.rejects(pair.quote({ dir: 'b2e', amount: SATS }), /no provider could quote|did not answer/);
  assert.equal(houseAsked, 0);
  await w.mems.get('fwd').put({ id: 'f'.repeat(64), role: 'bl', phase: 'done', created: 1, amount: '1', evmAmount: '1', csvBlocks: 144, provider: onBoard.ref });
  const q = await pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(q.provider.id, 'lp1');
  assert.equal(houseAsked, 1);
});

test('page: an ETH-for-Bitcoin quote is asked with the quote\'s own wait, and the rest of the swap with the transport\'s', async () => {
  const w = pairWorld();
  await w.ready();
  const waits = [];
  const pair = w.makePair({
    reverseCallFor: (ref, o = {}) => { const ms = o.timeoutMs || null; return async (m, path, body) => { waits.push([path, ms]); const r = await w.rev.handle({ method: m, path, body }); return { status: r.status, body: r.body }; }; },
    policy: { askMs: 777 },
  });
  await pair.quote({ dir: 'e2b', amount: UNITS });
  assert.deepEqual(waits.filter(([p]) => p === '/reverse/quote'), [['/reverse/quote', 777]]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
