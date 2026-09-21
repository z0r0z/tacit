// tools/airdrop-weights.mjs: cross-token weighting, blacklist handling, floor, cap and exact totals.
import { test } from 'node:test';
import assert from 'node:assert';
import { allocate, rankWeights, parseTac, UNIT } from '../tools/airdrop-weights.mjs';

const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const tac = (n) => parseTac(String(n));
const sum = (entries) => entries.reduce((s, e) => s + BigInt(e.amountWei), 0n);
const by = (entries) => Object.fromEntries(entries.map((e) => [e.address, BigInt(e.amountWei)]));

test('the list adds up to the pool exactly and every amount is a multiple of the pool unit', () => {
  const t1 = { holders: [{ address: a(1), balance: '1000000000000000000' }, { address: a(2), balance: '3000000000000000000' }, { address: a(3), balance: '7' }] };
  const t2 = { holders: [{ address: a(2), balance: '5' }, { address: a(4), balance: '11' }, { address: a(5), balance: '13' }] };
  const { entries } = allocate([t1, t2], { totalWei: tac(1000) });
  assert.equal(sum(entries), tac(1000));
  for (const e of entries) assert.equal(BigInt(e.amountWei) % UNIT, 0n);
});

test('units and decimals do not matter: a token counted in whole units or in 18 decimals gives the same shares', () => {
  const big = { holders: [{ address: a(1), balance: (10n * 10n ** 18n).toString() }, { address: a(2), balance: (30n * 10n ** 18n).toString() }] };
  const small = { holders: [{ address: a(1), balance: '10' }, { address: a(2), balance: '30' }] };
  const x = by(allocate([big], { totalWei: tac(100) }).entries), y = by(allocate([small], { totalWei: tac(100) }).entries);
  assert.deepEqual(x, y);
  assert.equal(x[a(1)], tac(25));
});

test('rank weights split the pool between tokens, linear by default', () => {
  const t1 = { holders: [{ address: a(1), balance: '1' }] }, t2 = { holders: [{ address: a(2), balance: '1' }] }, t3 = { holders: [{ address: a(3), balance: '1' }] };
  const m = by(allocate([t1, t2, t3], { totalWei: tac(600) }).entries);
  assert.equal(m[a(1)], tac(300)); assert.equal(m[a(2)], tac(200)); assert.equal(m[a(3)], tac(100));
  const g = by(allocate([t1, t2], { totalWei: tac(300), weights: '2,1' }).entries);
  assert.equal(g[a(1)], tac(200));
  assert.throws(() => rankWeights(3, '1,2'), /expected 3/);
});

test('blacklisted balances are removed from every denominator and receive nothing', () => {
  const t = { holders: [{ address: a(1), balance: '100' }, { address: a(2), balance: '100' }, { address: a(9), balance: '800' }] };
  const m = by(allocate([t], { totalWei: tac(1000), blacklist: [a(9)] }).entries);
  assert.equal(m[a(9)], undefined);
  assert.equal(m[a(1)], tac(500)); assert.equal(m[a(2)], tac(500));
});

test('a token whose eligible supply is empty gives its share to the others', () => {
  const t1 = { holders: [{ address: a(9), balance: '5' }] }, t2 = { holders: [{ address: a(2), balance: '1' }] };
  const { entries, report } = allocate([t1, t2], { totalWei: tac(90), blacklist: [a(9)] });
  assert.equal(by(entries)[a(2)], tac(90));
  assert.equal(report.perTokenShareOfPool[0], 0);
});

test('splitting a balance across two addresses does not change the total received', () => {
  const one = { holders: [{ address: a(1), balance: '1000' }, { address: a(3), balance: '1000' }] };
  const two = { holders: [{ address: a(1), balance: '500' }, { address: a(2), balance: '500' }, { address: a(3), balance: '1000' }] };
  const x = by(allocate([one], { totalWei: tac(1000) }).entries), y = by(allocate([two], { totalWei: tac(1000) }).entries);
  assert.equal(y[a(1)] + y[a(2)], x[a(1)]);
});

test('the same address in several tokens sums its shares', () => {
  const t1 = { holders: [{ address: a(1), balance: '1' }, { address: a(2), balance: '1' }] }, t2 = { holders: [{ address: a(1), balance: '1' }] };
  const m = by(allocate([t1, t2], { totalWei: tac(300) }).entries);
  assert.equal(m[a(1)], tac(100) + tac(100)); // 2/3 of the pool from token 1 (half of it) plus token 2 whole third
  assert.equal(m[a(2)], tac(100));
});

test('the floor drops small allocations and re-normalises the rest to the full pool', () => {
  const t = { holders: [{ address: a(1), balance: '1000000' }, { address: a(2), balance: '1000000' }, { address: a(3), balance: '1' }] };
  const { entries, report } = allocate([t], { totalWei: tac(1000), floorWei: tac(1) });
  assert.equal(by(entries)[a(3)], undefined);
  assert.equal(report.floorDropped, 1);
  assert.equal(sum(entries), tac(1000));
});

test('the cap limits one address and spreads the excess over the others', () => {
  const t = { holders: [{ address: a(1), balance: '900' }, { address: a(2), balance: '50' }, { address: a(3), balance: '50' }] };
  const { entries } = allocate([t], { totalWei: tac(1000), cap: 0.5 });
  const m = by(entries);
  assert.equal(m[a(1)], tac(500));
  assert.equal(m[a(2)], tac(250)); assert.equal(m[a(3)], tac(250));
  assert.equal(sum(entries), tac(1000));
  assert.throws(() => allocate([t], { totalWei: tac(1000), cap: 0.2 }), /cap is too low/);
});

test('the result does not depend on the order of holders or duplicate holder rows', () => {
  const h = [{ address: a(1), balance: '3' }, { address: a(2), balance: '5' }, { address: a(1), balance: '4' }];
  const x = allocate([{ holders: h }], { totalWei: tac(700) }).entries, y = allocate([{ holders: [...h].reverse() }], { totalWei: tac(700) }).entries;
  assert.deepEqual(x, y);
  const ideal = (tac(700) * 7n) / 12n; // duplicate rows for one address are summed: 7 of 12
  const got = by(x)[a(1)];
  assert.ok(got >= ideal - ideal % UNIT && got <= ideal - ideal % UNIT + UNIT);
});

test('rejects malformed input', () => {
  assert.throws(() => allocate([{ holders: [{ address: 'nope', balance: '1' }] }], { totalWei: tac(1) }), /bad holder address/);
  assert.throws(() => allocate([{ holders: [{ address: a(1), balance: '1' }] }], { totalWei: 5n }), /multiple of the pool unit/);
  assert.throws(() => allocate([{ holders: [{ address: a(1), balance: '0' }] }], { totalWei: tac(1) }), /no eligible holders/);
});
