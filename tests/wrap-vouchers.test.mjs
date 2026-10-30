// The voucher store: exact-sum picks, and a full browser store never losing a proof that was paid for.
// node --test tests/wrap-vouchers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVouchers } from '../dapp/wrap-vouchers.js';

// A Storage with a byte quota, as the browser's: setItem past it throws.
function fakeStorage(quota = Infinity) {
  const m = new Map();
  const size = () => [...m].reduce((s, [k, v]) => s + k.length + v.length, 0);
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { const before = m.get(k); m.set(k, String(v)); if (size() > quota) { if (before === undefined) m.delete(k); else m.set(k, before); throw new Error('QuotaExceededError'); } },
    removeItem: (k) => { m.delete(k); },
    raw: m,
  };
}
const v = (n, o = {}) => ({ ticker: 'cETH', amount: String(n * 10 ** 15), index: n, commit: '0xc' + n, depositId: '0xd' + n, leaf: '0xl' + n, assetId: '0xa', at: 1000 + n, status: 'ready', publicValues: '0x' + 'ab'.repeat(40), proof: '0x' + 'cd'.repeat(20), ...o });
const A = '02aa', B = '02bb';

test('ready vouchers that add up to the amount are picked, fewest first; proving ones are not', () => {
  const s = makeVouchers({ storage: fakeStorage() });
  s.put(A, v(10)); s.put(A, v(100)); s.put(A, v(1, { amount: String(10 ** 18) })); s.put(A, v(50, { status: 'proving' }));
  assert.deepEqual(s.pick(A, 'cETH', 110n * 10n ** 15n).map((x) => x.index).sort((a, b) => a - b), [10, 100]);
  assert.equal(s.pick(A, 'cETH', 50n * 10n ** 15n), null, 'a proof still being made is not on hand');
  assert.equal(s.pick(A, 'cETH', 7n), null);
  assert.equal(s.pick(A, 'cETH', 10n ** 18n).length, 1);
});

test('put replaces the voucher of the same deposit, and drop removes it', () => {
  const s = makeVouchers({ storage: fakeStorage() });
  s.put(A, v(1, { status: 'proving' })); s.put(A, v(1));
  assert.equal(s.list(A).length, 1);
  assert.equal(s.list(A)[0].status, 'ready');
  s.drop(A, '0xd1');
  assert.deepEqual(s.list(A), []);
});

test('a store that is full makes room from the oldest other key before it refuses a proof', () => {
  const st = fakeStorage(1500);
  const s = makeVouchers({ storage: st });
  s.put(B, v(1, { at: 1 })); s.put(B, v(2, { at: 2 }));          // an old key's vouchers fill the store
  const before = st.raw.size;
  for (let i = 3; i < 9; i++) s.put(A, v(i, { at: 100 + i }));   // the active key keeps asking for room
  assert.equal(s.list(A).length, 6, 'every voucher of the active key was kept for the page');
  assert.ok(!st.raw.has('tacit-wrap-vouchers-v1:' + B), 'the other key was the one to give way');
  assert.ok(before >= 1);
  const stored = JSON.parse(st.raw.get('tacit-wrap-vouchers-v1:' + A));
  assert.ok(stored.length >= 3 && stored.length < 6, `what fits is in the store too (${stored.length})`);
  assert.equal(Math.max(...stored.map((x) => x.index)), 8, 'and it is the newest that stayed, not the oldest');
});

test('the active key\'s own vouchers are never the room that is made', () => {
  const st = fakeStorage(900);
  const s = makeVouchers({ storage: st });
  for (let i = 1; i < 12; i++) s.put(A, v(i));
  assert.equal(s.list(A).length, 11, 'all of them are still found (the page keeps them when the browser will not)');
});

test('a store that will not take a write at all still serves the page, and takes the next write that fits', () => {
  const st = fakeStorage(0);
  const s = makeVouchers({ storage: st });
  s.put(A, v(1)); s.put(A, v(2));
  assert.equal(s.list(A).length, 2);
  assert.equal(s.pick(A, 'cETH', 1n * 10n ** 15n).length, 1);
  // room appears (the quota rises): the next write lands in the store and the page stops leaning on memory
  const roomy = fakeStorage();
  const t = makeVouchers({ storage: roomy });
  t.put(A, v(1));
  assert.equal(JSON.parse(roomy.raw.get('tacit-wrap-vouchers-v1:' + A)).length, 1);
});

test('no storage at all (a private window) keeps the vouchers in memory', () => {
  const s = makeVouchers({ storage: undefined });
  s.put(A, v(1)); s.put(A, v(2, { status: 'proving' }));
  assert.equal(s.list(A, 'cETH', 'ready').length, 1);
  assert.equal(s.list(A).length, 2);
  s.drop(A, '0xd1');
  assert.equal(s.list(A).length, 1);
});

test('unreadable stored data reads as empty and is overwritten by the next write', () => {
  const st = fakeStorage();
  st.setItem('tacit-wrap-vouchers-v1:' + A, '{not json');
  const s = makeVouchers({ storage: st });
  assert.deepEqual(s.list(A), []);
  s.put(A, v(1));
  assert.equal(s.list(A).length, 1);
});

import { stockSizes } from '../dapp/wrap-vouchers.js';
const ETH = 10n ** 18n, SIZES = [ETH / 1000n, ETH / 100n, ETH / 10n, ETH], OPT = { starter: ETH / 100n, floor: ETH / 100n };

test('a key with no money to wrap is asked for its starter size only; one with some, or one not yet read, for all', () => {
  assert.deepEqual(stockSizes(SIZES, 0n, OPT), [ETH / 100n], 'nothing in the paying accounts');
  assert.deepEqual(stockSizes(SIZES, ETH / 100n - 1n, OPT), [ETH / 100n], 'a wei under the floor');
  assert.deepEqual(stockSizes(SIZES, ETH / 100n, OPT), SIZES, 'at the floor, all of them as before');
  assert.deepEqual(stockSizes(SIZES, 5n * ETH, OPT), SIZES);
  assert.deepEqual(stockSizes(SIZES, null, OPT), SIZES, 'a balance that could not be read changes nothing');
  assert.deepEqual(stockSizes(SIZES, undefined, OPT), SIZES);
});

test('the starter is the only size left even when the key chose others, and none when it did not choose the starter', () => {
  assert.deepEqual(stockSizes([ETH / 10n, ETH], 0n, OPT), [], 'a key that kept only the large sizes is asked for none until it has money');
  assert.deepEqual(stockSizes([ETH / 100n], 0n, OPT), [ETH / 100n]);
  assert.deepEqual(stockSizes([], 0n, OPT), []);
});

test('the store hands the rule to the page', () => {
  const s = makeVouchers({ storage: fakeStorage() });
  assert.equal(s.stockSizes, stockSizes);
});
