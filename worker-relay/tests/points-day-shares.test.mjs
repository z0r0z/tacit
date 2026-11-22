// dayShares (lib/points-day-board.js) gives each address the day-so-far figures that dayPot, splitDayBudget and a scan of the day's rows give it one
// request at a time; makeTtlMemo (lib/ttl-memo.js) keeps a synchronous result for a few seconds.
//   node worker-relay/tests/points-day-shares.test.mjs
import assert from 'node:assert/strict';
import { dayShares, dayPot, splitDayBudget } from '../src/lib/points-day-board.js';
import { parseBudgets, budgetsForDay } from '../src/lib/points-budgets.js';
import { makeTtlMemo } from '../src/lib/ttl-memo.js';

const TAC = 10n ** 18n, budget = 1111n * TAC, ceiling = 3n * TAC / 100n;
const ACTIVITIES = ['holding', 'cbtchold', 'zswapeth', 'cusdmint', 'wrap', 'evmpooldeposit'];

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function makeRows(seed, n) {
  const r = rng(seed), rows = [];
  for (let i = 0; i < n; i++) {
    const address = '0x' + (0x1000 + i).toString(16).padStart(40, '0');
    const by = {};
    for (const a of ACTIVITIES) if (r() < 0.4) by[a] = Math.floor(r() * 2_000_000) / 100;
    rows.push({ address, by, dayPoints: Object.values(by).reduce((s, v) => s + v, 0), rawPoints: 0, factor: 1, kinds: Object.keys(by).length, activeDays: 1 });
  }
  return rows;
}

// What the handler computed for one address before: a scan of the rows, the day's pot, and the split only for a row with points.
function oneAtATime(rows, address, cap, groups) {
  const row = rows.find((r) => r.address.toLowerCase() === address.toLowerCase());
  const { totalPoints, pot } = dayPot(rows, budget, cap, groups);
  const paid = row && row.dayPoints > 0 ? splitDayBudget(rows, budget, cap, groups).get(row.address) ?? 0n : 0n;
  return { row, totalPoints, pot, paid };
}
function fromShares(shares, address) {
  const row = shares.row(address);
  return { row, totalPoints: shares.totalPoints, pot: shares.pot, paid: row && row.dayPoints > 0 ? shares.paid.get(row.address) ?? 0n : 0n };
}

const groupSets = {
  none: [],
  shared: budgetsForDay(parseBudgets('20747:stay=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint@0.15/0.01,loop=wrap+evmpooldeposit@0.6!/0.03'), 20747),
  topup: budgetsForDay(parseBudgets('20747:stay=holding+cbtchold@0.25/0.02+0.04,use=zswapeth+cusdmint@0.15/0.01,loop=wrap+evmpooldeposit@0.6!/0.03'), 20747),
};
assert.ok(groupSets.shared.length === 3 && groupSets.topup.length === 3, 'the group fixtures parse');

for (const [name, groups] of Object.entries(groupSets)) {
  for (const cap of [null, ceiling]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rows = makeRows(seed, seed === 5 ? 1 : 60);
      const shares = dayShares(rows, budget, cap, groups);
      const probes = [...rows.map((r) => r.address), '0x' + 'e'.repeat(40), rows[0].address.toUpperCase().replace('0X', '0x')];
      for (const a of probes) assert.deepEqual(fromShares(shares, a), oneAtATime(rows, a, cap, groups), `groups ${name}, cap ${cap}, seed ${seed}, ${a}`);
    }
  }
}

{ // a day with no activity: the pot is the budget, nobody is paid, nobody has a row
  const shares = dayShares([], budget, ceiling, []);
  assert.equal(shares.pot, budget); assert.equal(shares.totalPoints, 0);
  assert.equal(shares.row('0x' + 'a'.repeat(40)), undefined);
  assert.equal(shares.paid.size, 0);
}

{ // two rows for one address in different letter case: the first is the one found, as a scan finds it
  const lower = '0x' + 'ab'.repeat(20), upper = '0x' + 'AB'.repeat(20);
  const rows = [{ address: upper, by: { wrap: 5 }, dayPoints: 5 }, { address: lower, by: { wrap: 9 }, dayPoints: 9 }];
  assert.equal(dayShares(rows, budget, null, []).row(lower), rows[0]);
  assert.equal(dayShares(rows, budget, null, []).row(upper), rows[0]);
}

{ // the figures are made once for any number of addresses asked
  const rows = makeRows(7, 40);
  let reads = 0;
  const counting = new Proxy(rows, { get(t, k, r) { if (k === Symbol.iterator || k === 'reduce' || k === 'map') reads++; return Reflect.get(t, k, r); } });
  const shares = dayShares(counting, budget, null, []);
  const before = reads;
  for (let i = 0; i < 200; i++) shares.row(rows[i % rows.length].address);
  assert.equal(reads, before, 'looking an address up does not read the day again');
}

// ── the memo ──
{
  let t = 0, loads = 0;
  const memo = makeTtlMemo({ ttlMs: 1000, max: 3, now: () => t });
  const load = (v) => () => { loads++; return { v }; };
  const a1 = memo('a', load(1)), a2 = memo('a', load(2));
  assert.equal(a1, a2); assert.equal(loads, 1, 'asked twice inside the window, loaded once');
  t = 999; assert.equal(memo('a', load(3)), a1, 'still inside the window');
  t = 1000; assert.notEqual(memo('a', load(4)), a1); assert.equal(loads, 2, 'a new load once the window has passed');
  assert.equal(memo('b', load(5)).v, 5); assert.equal(memo('c', load(6)).v, 6); assert.equal(memo('d', load(7)).v, 7);
  const before = loads; memo('a', load(8)); assert.equal(loads, before + 1, 'at most max keys: the oldest went');
  assert.equal(memo('d', load(9)).v, 7, 'the newest stays');
}
{
  let loads = 0;
  const memo = makeTtlMemo({ ttlMs: 1000, now: () => 0 });
  assert.throws(() => memo('x', () => { loads++; throw new Error('no'); }), /no/);
  assert.equal(memo('x', () => { loads++; return 1; }), 1);
  assert.equal(loads, 2, 'a load that throws is not kept');
}
{
  let loads = 0;
  const off = makeTtlMemo({ ttlMs: 0, now: () => 0 });
  off('k', () => ++loads); off('k', () => ++loads);
  assert.equal(loads, 2, 'a window of 0 keeps nothing');
}

console.log('points-day-shares: ok');
