// The depth ladder (dapp/fast/ladder.js): what each size costs the way the page would bridge it now, from a size one provider takes whole to one that
// is split, and what is waiting by the price it will pay. No wallet and no network: the providers' terms and the wants are made up.
//   node tests/fastbridge-ladder.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { costBySize, waitLevels } from '../dapp/fast/ladder.js';
import { feeAt } from '../dapp/fast/sweep.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = 10n ** 8n;
const prov = (id, { min = 10, max = 1000, available = null, bps = 30, flat = 1, any = true } = {}) => ({
  id, name: id, terms: { feeBps: bps, flatFee: BigInt(Math.round(flat * 1e8)), minAmount: BigInt(min) * TAC, maxAmount: BigInt(max) * TAC, available: available == null ? null : BigInt(available) * TAC, anyTac: any },
});
const tacs = (rows) => rows.map((r) => r.amount / TAC);
const sum = (xs) => xs.reduce((s, x) => s + x, 0n);

test('one provider: the least it takes, round sizes, and the most; each costs its rate and its flat part, which weighs most on the smallest', () => {
  const L = costBySize([prov('Tacit')]);
  assert.deepEqual(tacs(L.rows), [10n, 30n, 100n, 300n, 1000n]);
  assert.equal(L.depth, 1000n * TAC); assert.equal(L.least, 10n * TAC);
  assert.deepEqual(L.rows.map((r) => r.fee), [103_000_000n, 109_000_000n, 130_000_000n, 190_000_000n, 400_000_000n], '0.30% and 1 TAC');
  for (const r of L.rows) { assert.equal(r.parts.length, 1); assert.equal(r.parts[0].provider.id, 'Tacit'); assert.equal(r.parts[0].fee, r.fee); }
});

test('which provider is cheapest changes with size: a flat fee wins nothing on a large amount, a rate wins nothing on a small one', () => {
  const rate = prov('Rate', { bps: 100, flat: 0 }), flat = prov('Flat', { bps: 10, flat: 5 });
  const by = Object.fromEntries(costBySize([rate, flat]).rows.map((r) => [r.amount / TAC, r.parts[0].provider.id]));
  assert.equal(by[10n], 'Rate', '1% of 10 is 0.1; the other keeps 5.01');
  assert.equal(by[100n], 'Rate', '1 against 5.1');
  assert.equal(by[1000n], 'Flat', '10 against 6');
});

test('a size no one provider takes whole is split, and the row says across whom; the most is what the providers that take any TAC hold together', () => {
  const L = costBySize([prov('A', { available: 500 }), prov('B', { available: 400 })]);
  assert.equal(L.depth, 900n * TAC);
  assert.deepEqual(tacs(L.rows), [10n, 30n, 100n, 300n, 900n]);
  const last = L.rows.at(-1);
  assert.deepEqual(last.parts.map((p) => [p.provider.id, p.amount / TAC]).sort(), [['A', 500n], ['B', 400n]]);
  assert.equal(last.fee, sum(last.parts.map((p) => p.fee)));
  assert.equal(L.rows[0].parts.length, 1, 'a size one takes is not split');
  // providers that screen are not asked to take a part: the most is the one with the most room
  const screens = costBySize([prov('A', { available: 500, any: false }), prov('B', { available: 400, any: false })]);
  assert.equal(screens.depth, 500n * TAC);
  assert.ok(screens.rows.every((r) => r.parts.length === 1));
});

test('it follows what the page does: a size one provider takes whole goes to the cheapest of those, even when a split would cost less', () => {
  const big = prov('Big', { available: 1000, bps: 400, flat: 0 }), a = prov('A', { available: 300, bps: 100, flat: 0 }), b = prov('B', { available: 300, bps: 100, flat: 0 });
  const L = costBySize([big, a, b]);
  const r = L.rows.find((x) => x.amount === 300n * TAC);
  assert.equal(r.parts.length, 1); assert.equal(r.parts[0].provider.id, 'A', 'A and B tie on 300: the cheaper of those that take it, by name');
  const split = costBySize([big, a, b]).rows.find((x) => x.amount > 300n * TAC && x.amount < 1000n * TAC);
  if (split) assert.equal(split.parts.length, 1, 'Big takes up to 1,000 whole, so that is what the page does');
});

test('nothing to show when nothing has room: no providers, every one full, or room under a provider\'s own least', () => {
  assert.deepEqual(costBySize([]), { depth: 0n, least: null, rows: [] });
  assert.deepEqual(costBySize([prov('A', { available: 0 })]), { depth: 0n, least: null, rows: [] });
  assert.deepEqual(costBySize([prov('A', { min: 50, available: 30 })]).rows, []);
  // one with room among full ones is the ladder
  assert.deepEqual(tacs(costBySize([prov('Full', { available: 0 }), prov('A', { min: 11, available: 23 })]).rows), [11n, 23n]);
});

test('a ladder has at most eight rows, in order, from the least to the most', () => {
  const L = costBySize([prov('Huge', { min: 10, max: 5_000_000 })]);
  assert.equal(L.rows.length, 8);
  assert.equal(L.rows[0].amount, 10n * TAC); assert.equal(L.rows.at(-1).amount, 5_000_000n * TAC);
  assert.deepEqual(tacs(L.rows), tacs(L.rows).slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  assert.equal(new Set(tacs(L.rows)).size, 8, 'none twice');
  assert.equal(costBySize([prov('Huge', { max: 5_000_000 })], { rows: 3 }).rows.length, 3);
});

test('every row is whole: its parts add up to its size, each is within its provider\'s room and costs its provider\'s own sum, and a single row is the cheapest single', () => {
  let seed = 5;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 12) % n; };      // the high bits: the low ones of this generator cycle
  const rates = [10, 30, 100, 250, 400], flats = [0, 0.1, 1, 5];
  let withSplit = 0, rowsSeen = 0;
  for (let round = 0; round < 60; round++) {
    const n = 1 + rnd(5);
    const ps = Array.from({ length: n }, (_, i) => prov('p' + i, { min: [10, 11, 50][rnd(3)], max: 1000 + 500 * rnd(4), available: rnd(4) === 0 ? 0 : 20 + rnd(1500), bps: rates[rnd(5)], flat: flats[rnd(4)], any: rnd(5) !== 0 }));
    const L = costBySize(ps);
    let last = 0n;
    for (const r of L.rows) {
      rowsSeen++;
      assert.ok(r.amount > last, 'ascending'); last = r.amount;
      assert.equal(sum(r.parts.map((p) => p.amount)), r.amount, 'the parts add up');
      assert.equal(sum(r.parts.map((p) => p.fee)), r.fee, 'and so do their fees');
      for (const p of r.parts) {
        const t = p.provider.terms, cap = t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount;
        assert.ok(p.amount >= t.minAmount && p.amount <= cap, 'within the provider\'s room');
        assert.equal(p.fee, feeAt(t, p.amount), 'at the provider\'s own sum');
      }
      if (r.parts.length === 1) {
        const takers = ps.filter((p) => { const t = p.terms, cap = t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount; return cap >= t.minAmount && cap > 0n && r.amount >= t.minAmount && r.amount <= cap; });
        assert.equal(r.fee, takers.map((p) => feeAt(p.terms, r.amount)).reduce((a, b) => (b < a ? b : a)), 'the cheapest of those that take it whole');
      } else { withSplit++; assert.ok(r.parts.length <= 4); }
    }
    assert.ok(L.rows.length === 0 || L.rows.at(-1).amount <= L.depth);
  }
  assert.ok(rowsSeen > 100 && withSplit > 5, `the check saw ${rowsSeen} rows and ${withSplit} split ones: too few to mean anything`);
});

test('the waiting bridges, by the price they will pay: those that name none first, then the highest price down; a price that cannot be read is none', () => {
  const lv = waitLevels([{ amount: 100n * TAC, maxFeeBps: 100 }, { amount: 50n * TAC, maxFeeBps: null }, { amount: 25n * TAC, maxFeeBps: 100 }, { amount: 10n * TAC, maxFeeBps: 300 }, { amount: 5n * TAC, maxFeeBps: 'lots' }, { amount: 7n * TAC }]);
  assert.deepEqual(lv.map((x) => [x.maxFeeBps, x.count, x.total / TAC]), [[null, 3, 62n], [300, 1, 10n], [100, 2, 125n]]);
  assert.deepEqual(waitLevels([]), []); assert.deepEqual(waitLevels(null), []);
  assert.deepEqual(waitLevels([{ amount: 5n, maxFeeBps: 0 }]).map((x) => [x.maxFeeBps, x.count]), [[0, 1]], 'a price of nothing is a price');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} depth ladder checks passed`);
process.exit(process.exitCode || 0);
