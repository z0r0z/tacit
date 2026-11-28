// The stuck-TAC desk (btcswap-desk/lib/stuck-desk.mjs, bounty entry A), offline: classes, quote
// math per class, the hard discount band against a hostile config, the floor, the caps, the
// reserve, quote expiry, and the pledge book per pledger.
//   node tests/stuck-desk.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { CLASS, DISCOUNT_BAND_BPS, classifyLock, classifyNote, deskPolicy, makePledgeBook, makeStuckDesk } from '../btcswap-desk/lib/stuck-desk.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TAC = 100000000n; // 1 TAC in base units
const clean = { trace: 'tracked', poolExit: false, transfers: 12 };
const longHistory = { trace: 'tracked', poolExit: false, transfers: 900 };
const poolExit = { trace: 'unprovable', poolExit: true, transfers: 3 };
const unread = { trace: 'unread', poolExit: false, transfers: 3 };

const T0 = 1764072000; // a fixed clock: 2026-11-25T12:00:00Z
const funded = (amounts = [6000n * TAC]) => {
  const pledges = makePledgeBook();
  amounts.forEach((a, i) => pledges.pledge(`p${i + 1}`, a));
  return pledges;
};
const deskWith = ({ policy = deskPolicy(), pledges = funded(), now = () => T0 } = {}) => makeStuckDesk({ policy, pledges, now });

test('classes: clean, long history, pool exit, unknown', () => {
  assert.equal(classifyNote(clean), CLASS.CLEAN);
  assert.equal(classifyNote(longHistory), CLASS.LONG_HISTORY);
  assert.equal(classifyNote(poolExit), CLASS.POOL_EXIT);
  assert.equal(classifyNote(unread), CLASS.UNKNOWN);
  assert.equal(classifyNote(null), CLASS.UNKNOWN);
  assert.equal(classifyNote({}), CLASS.UNKNOWN);
  // the same reading as entry C: an unprovable history, no pool exit, within the count
  assert.equal(classifyNote({ trace: 'unprovable', poolExit: false, transfers: 40 }), CLASS.LONG_HISTORY);
});

test('the boundary at 255 transfers: 255 is clean, 256 is long history', () => {
  assert.equal(classifyNote({ trace: 'tracked', poolExit: false, transfers: 255 }), CLASS.CLEAN);
  assert.equal(classifyNote({ trace: 'tracked', poolExit: false, transfers: 256 }), CLASS.LONG_HISTORY);
});

test('a lock takes the worst class of its notes, and any unknown makes it unknown', () => {
  assert.equal(classifyLock([longHistory, longHistory]), CLASS.LONG_HISTORY);
  assert.equal(classifyLock([longHistory, poolExit]), CLASS.POOL_EXIT);
  assert.equal(classifyLock([longHistory, unread]), CLASS.UNKNOWN);
  assert.equal(classifyLock([]), CLASS.UNKNOWN);
});

test('unknown is refused with a retry, never quoted', () => {
  const d = deskWith();
  const r = d.quote({ note: unread, amount: 100n * TAC });
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
});

test('a clean note is refused: it bridges on its own, the desk adds nothing', () => {
  const d = deskWith();
  const r = d.quote({ note: clean, amount: 100n * TAC });
  assert.equal(r.ok, false);
  assert.match(r.why, /regular bridge/);
});

test('quote math per class: out = amount x (1 - discount), BigInt exact', () => {
  const d = deskWith();
  const a = 100n * TAC;
  const lh = d.quote({ note: longHistory, amount: a });
  assert.equal(lh.ok, true);
  assert.equal(lh.quote.discountBps, 3680);
  assert.equal(lh.quote.amountOut, (a * 6320n) / 10000n); // 63.20 TAC
  const pe = d.quote({ note: poolExit, amount: a });
  assert.equal(pe.ok, true);
  assert.equal(pe.quote.discountBps, 4255);
  assert.equal(pe.quote.amountOut, (a * 5745n) / 10000n); // 57.45 TAC
  assert.equal(pe.quote.priceBps, 5745);
});

test('a quote carries an expiry from the config', () => {
  const d = deskWith();
  const r = d.quote({ note: longHistory, amount: 10n * TAC });
  assert.equal(r.quote.validUntil, T0 + 600);
});

test('the hard band holds against a hostile config: discounts too high or too low are clamped', () => {
  const greedy = deskPolicy({ discountBps: { 'long-history': 9900, 'pool-exit': 100 } });
  assert.equal(greedy.classes[CLASS.LONG_HISTORY].discountBps, DISCOUNT_BAND_BPS[CLASS.LONG_HISTORY].max);
  // pool-exit asked for 100 bps, under its band's min — and its default floor caps it at 7,500 anyway
  assert.equal(greedy.classes[CLASS.POOL_EXIT].discountBps, DISCOUNT_BAND_BPS[CLASS.POOL_EXIT].min);
  const d = deskWith({ policy: greedy });
  const r = d.quote({ note: longHistory, amount: 100n * TAC });
  assert.equal(r.quote.discountBps, 6000); // never the 9,900 the config asked for
});

test('the floor caps the discount: the holder is always offered at least the floor share', () => {
  // a floor of 50% for long history: no quote may pay out less than half of face
  const p = deskPolicy({ floorBps: { 'long-history': 5000 } });
  assert.equal(p.classes[CLASS.LONG_HISTORY].discountBps, 3680); // the default already honours a 50% floor, so it stays
  const p2 = deskPolicy({ discountBps: { 'long-history': 6000 }, floorBps: { 'long-history': 5000 } });
  assert.equal(p2.classes[CLASS.LONG_HISTORY].discountBps, 5000); // clamped down to honour the floor
  const d = deskWith({ policy: p2 });
  const r = d.quote({ note: longHistory, amount: 100n * TAC });
  assert.equal(r.quote.amountOut, 50n * TAC); // exactly the floor, never below
});

test('a floor no allowed discount can honour disables the class instead of breaking a bound', () => {
  // long-history band min is 500 bps, so a floor above 9,500 bps of face can never be honoured
  const p = deskPolicy({ floorBps: { 'long-history': 9900 } });
  assert.equal(p.classes[CLASS.LONG_HISTORY].enabled, false);
  const d = deskWith({ policy: p });
  assert.equal(d.quote({ note: longHistory, amount: 100n * TAC }).ok, false);
  // the other class is untouched
  assert.equal(d.quote({ note: poolExit, amount: 100n * TAC }).ok, true);
});

test('the per-note cap and the minimum are enforced', () => {
  const d = deskWith();
  assert.equal(d.quote({ note: longHistory, amount: 1001n * TAC }).ok, false); // cap is 1,000 TAC
  assert.equal(d.quote({ note: longHistory, amount: TAC / 2n }).ok, false);    // minimum is 1 TAC
  assert.equal(d.quote({ note: longHistory, amount: 1000n * TAC }).ok, true);  // exactly at the cap quotes (out 632 TAC)
});

test('one quote takes at most its share of pledged inventory', () => {
  const d = deskWith(); // 6,000 TAC pledged, max share 20% -> at most 1,200 TAC out per quote
  assert.equal(d.quote({ note: longHistory, amount: 1000n * TAC }).ok, true);  // out 632 TAC
  const d2 = deskWith({ pledges: funded([1000n * TAC]) });                    // 1,000 pledged -> at most 200 out
  assert.equal(d2.quote({ note: longHistory, amount: 1000n * TAC }).ok, false); // out would be 632
  assert.equal(d2.quote({ note: longHistory, amount: 300n * TAC }).ok, true);   // out 189.6
});

test('the reserve is never quoted away', () => {
  // 1,000 TAC pledged, reserve 10%: available after quotes must stay >= 100 TAC
  const d = deskWith({ pledges: funded([1000n * TAC]) });
  assert.equal(d.quote({ note: longHistory, amount: 300n * TAC }).ok, true);  // out 189.6, free 810.4
  assert.equal(d.quote({ note: longHistory, amount: 300n * TAC }).ok, true);  // out 189.6, free 620.8
  // a third identical quote still fits the reserve, but the share rule is on total pledged, so keep
  // going until the reserve is what stops it: each further quote leaves less free
  let last;
  for (let i = 0; i < 6; i++) last = d.quote({ note: longHistory, amount: 300n * TAC });
  assert.equal(last.ok, false);
  assert.match(last.why, /reserve|share/);
});

test('the per-day cap stops quotes, and a new day opens them again', () => {
  let t = T0;
  const policy = deskPolicy({ quote: { maxDayOut: '20000000000' } }); // 200 TAC out per day
  const d = deskWith({ policy, pledges: funded([100000n * TAC]), now: () => t });
  assert.equal(d.quote({ note: longHistory, amount: 300n * TAC }).ok, true);  // out 189.6
  assert.equal(d.quote({ note: longHistory, amount: 300n * TAC }).ok, false); // 379.2 > 200
  t += 86400; // the next UTC day
  assert.equal(d.quote({ note: longHistory, amount: 300n * TAC }).ok, true);
});

test('an expired quote cannot be accepted, and its reservation is freed', () => {
  let t = T0;
  const pledges = funded([1000n * TAC]);
  const d = deskWith({ pledges, now: () => t });
  const r = d.quote({ note: longHistory, amount: 300n * TAC });
  assert.equal(pledges.available(), 1000n * TAC - r.quote.amountOut);
  t += 601; // past validSecs = 600
  const a = d.accept(r.quote.id);
  assert.equal(a.ok, false);
  assert.match(a.why, /expired/);
  assert.equal(pledges.available(), 1000n * TAC); // whole again
});

test('sweep frees lapsed quotes without touching live ones', () => {
  let t = T0;
  const pledges = funded([1000n * TAC]);
  const d = deskWith({ pledges, now: () => t });
  const r1 = d.quote({ note: longHistory, amount: 100n * TAC });
  t += 300;
  const r2 = d.quote({ note: longHistory, amount: 100n * TAC });
  t += 301; // r1 is 601 old, r2 is 301 old
  assert.equal(d.sweep(), 1);
  assert.equal(d.accept(r2.quote.id).ok, true);
  assert.equal(d.accept(r1.quote.id).ok, false);
});

test('the pledge book accounts per pledger: reserve oldest first, settle charges, release frees', () => {
  const b = makePledgeBook();
  b.pledge('alice', 100n * TAC);
  b.pledge('bob', 50n * TAC);
  assert.equal(b.totalPledged(), 150n * TAC);
  assert.equal(b.reserve('q1', 120n * TAC), true);
  assert.deepEqual(b.reservation('q1'), [{ pledger: 'alice', amount: 100n * TAC }, { pledger: 'bob', amount: 20n * TAC }]);
  assert.equal(b.pledger('alice').available, 0n);
  assert.equal(b.pledger('bob').available, 30n * TAC);
  assert.equal(b.reserve('q2', 31n * TAC), false); // only 30 free: all or nothing, nothing reserved
  assert.equal(b.available(), 30n * TAC);
  assert.equal(b.settle('q1'), true);
  assert.equal(b.pledger('alice').settled, 100n * TAC);
  assert.equal(b.pledger('bob').settled, 20n * TAC);
  assert.equal(b.reserve('q3', 30n * TAC), true);
  assert.equal(b.release('q3'), true);
  assert.equal(b.available(), 30n * TAC);
});

test('a pledger cannot withdraw what a quote holds or what has settled', () => {
  const b = makePledgeBook();
  b.pledge('alice', 100n * TAC);
  b.reserve('q1', 60n * TAC);
  assert.equal(b.withdraw('alice', 41n * TAC), false);
  assert.equal(b.withdraw('alice', 40n * TAC), true);
  b.settle('q1');
  assert.equal(b.withdrawable('alice'), 0n);
});

test('accepting a quote settles its reservation against the pledgers', () => {
  const pledges = funded([500n * TAC, 500n * TAC]);
  const d = deskWith({ pledges });
  const r = d.quote({ note: poolExit, amount: 100n * TAC });
  assert.equal(r.ok, true);
  const a = d.accept(r.quote.id);
  assert.equal(a.ok, true);
  assert.equal(pledges.totalSettled(), r.quote.amountOut);
  assert.equal(pledges.totalReserved(), 0n);
  assert.equal(pledges.pledger('p1').settled, r.quote.amountOut); // oldest pledge paid it all
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n  ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} tests passed`);
if (failed) process.exit(1);
