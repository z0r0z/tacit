// The stuck TAC pricing rule: clean notes go on as before, stuck ones only at a fee that covers their class's haircut and under the cap,
// an unread history is refused with retry, and a screen called without the offer refuses anything not clean.
//   node tests/fastbridge-stuck-price.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { classOf, worstClass, makeRule, requiredFee, stuckPriceScreen, model } from '../dapp/fast/stuck-price.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const A = { txid: 'aa'.repeat(32), vout: 0 }, B = { txid: 'bb'.repeat(32), vout: 1 };
const vetOf = (m) => async (ns) => new Map(ns.map((n) => [`${n.txid}:${n.vout}`, m[`${n.txid}:${n.vout}`]]));
const id = (n) => `${n.txid}:${n.vout}`;
const rule = { baseFeeBps: 30, haircutBps: { long: 200, poolExit: 500 }, maxStuck: 1_000_000n };

test('classes from verdicts', () => {
  assert.equal(classOf({ state: 'tracked' }), 'clean');
  assert.equal(classOf({ state: 'traced', hops: 9 }), 'clean');
  assert.equal(classOf({ state: 'long', hops: 300 }), 'long');
  assert.equal(classOf({ state: 'unprovable' }), 'poolExit');
  assert.equal(classOf({ state: 'unread' }), 'unread');
  assert.equal(classOf(undefined), 'unread');
  assert.equal(classOf({ state: 'something-new' }), 'unread');
});

test('a lock is priced by its worst input', () => {
  const v = new Map([[id(A), { state: 'traced' }], [id(B), { state: 'unprovable' }]]);
  assert.equal(worstClass([A, B], v), 'poolExit');
  assert.equal(worstClass([A], v), 'clean');
});

test('config is checked', () => {
  assert.throws(() => makeRule({ baseFeeBps: -1 }));
  assert.throws(() => makeRule({ haircutBps: { long: 1.5 } }));
  assert.throws(() => makeRule({ maxStuck: -5n }));
  assert.equal(requiredFee(makeRule(rule), 'long', 10_000n), 230n);
  assert.equal(requiredFee(makeRule(rule), 'poolExit', 1n), 1n);     // rounded up
  assert.equal(requiredFee(makeRule({ baseFeeBps: 30 }), 'long', 10_000n), null);
});

test('clean notes go on whatever the fee', async () => {
  const s = stuckPriceScreen(vetOf({ [id(A)]: { state: 'tracked' } }), rule);
  assert.equal(await s([A], { value: 1000n, amount: 1000n }), null);
  assert.equal(await s([A]), null);
});

test('unread is refused with retry', async () => {
  const s = stuckPriceScreen(vetOf({ [id(A)]: { state: 'unread' } }), rule);
  assert.deepEqual(await s([A], { value: 1000n, amount: 900n }), { why: 'the history of a note could not be read just now', retry: true });
});

test('a stuck note at too low a fee is refused, at enough it goes on', async () => {
  const s = stuckPriceScreen(vetOf({ [id(A)]: { state: 'long', hops: 400 } }), rule);
  const r = await s([A], { value: 100_000n, amount: 98_000n });            // 200 bps < 230
  assert.ok(r && !r.retry && /230 bps/.test(r.why));
  assert.equal(await s([A], { value: 100_000n, amount: 97_700n }), null);  // 230 bps
});

test('a class with no haircut set is not taken', async () => {
  const s = stuckPriceScreen(vetOf({ [id(A)]: { state: 'unprovable' } }), { baseFeeBps: 30, haircutBps: { long: 200 }, maxStuck: 10n ** 12n });
  const r = await s([A], { value: 100_000n, amount: 1n });
  assert.ok(r && /left the shielded pool/.test(r.why));
});

test('without the offer anything not clean is refused (never looser than lineageScreen)', async () => {
  const s = stuckPriceScreen(vetOf({ [id(A)]: { state: 'long' } }), rule);
  assert.ok(await s([A]));
});

test('the cap counts what was let through, or the holding the provider reports', async () => {
  const vet = vetOf({ [id(A)]: { state: 'unprovable' } });
  const s = stuckPriceScreen(vet, { ...rule, maxStuck: 150_000n });
  assert.equal(await s([A], { value: 100_000n, amount: 94_000n }), null);
  const r = await s([A], { value: 100_000n, amount: 94_000n });
  assert.ok(r && r.retry);
  const s2 = stuckPriceScreen(vet, { ...rule, maxStuck: 150_000n }, { stuckHeld: async () => 140_000n });
  assert.ok((await s2([A], { value: 20_000n, amount: 18_000n }))?.retry);
  assert.equal(await (stuckPriceScreen(vet, { ...rule, maxStuck: 150_000n }, { stuckHeld: async () => 0n }))([A], { value: 20_000n, amount: 18_000n }), null);
});

test('model: with the rule a provider no longer loses on stuck TAC', () => {
  const m = model({ n: 1000, size: 1000, share: 0.05, baseFeeBps: 30, haircutBps: 400, surchargeBps: 500, maxStuck: 30_000 });
  assert.equal(m.without.stuck, 50_000);
  assert.equal(m.with.stuck, 30_000);
  assert.equal(m.with.refused, 20_000);
  assert.ok(m.with.pnl > m.without.pnl && m.with.pnl > 0);
  console.log('  model n=1000 size=1000 5% stuck, fee 30bps, haircut 400bps, surcharge 500bps, cap 30k:', JSON.stringify(m));
});

let failed = 0;
for (const [name, fn] of tests) { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, e); } }
if (failed) { console.log(`${failed} failed`); process.exit(1); } else console.log(`all ${tests.length} passed`);
