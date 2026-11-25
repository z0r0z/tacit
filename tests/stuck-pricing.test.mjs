// The stuck-TAC pricing and policy rule (fastbridge-lp/lib/stuck-pricing.mjs, bounty entry C), offline:
// classes, the boundary at 255 transfers, unknown refused, fees that rise with risk and cover the
// haircut they price, the caps, the floor, and the safe defaults.
//   node tests/stuck-pricing.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { CLASS, DEFAULT_STUCK_POLICY, classifyLock, classifyNote, decideTake, feeBpsFor, stuckPolicy } from '../fastbridge-lp/lib/stuck-pricing.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TAC = 100000000n; // 1 TAC in base units
const clean = { trace: 'tracked', poolExit: false, transfers: 12 };
const longHistory = { trace: 'tracked', poolExit: false, transfers: 900 };
const poolExit = { trace: 'unprovable', poolExit: true, transfers: 3 };
const unread = { trace: 'unread', poolExit: false, transfers: 3 };
const room = { inventoryTac: 10000n * TAC, stuckTac: 0n, stuckTodayTac: 0n }; // a provider with room
const ask = (notes, amount, over = {}) => ({ notes, amount, ...room, ...over });

test('classes: clean, long history, pool exit, unknown', () => {
  assert.equal(classifyNote(clean), CLASS.CLEAN);
  assert.equal(classifyNote(longHistory), CLASS.LONG_HISTORY);
  assert.equal(classifyNote(poolExit), CLASS.POOL_EXIT);
  assert.equal(classifyNote(unread), CLASS.UNKNOWN);
  assert.equal(classifyNote(null), CLASS.UNKNOWN);
  assert.equal(classifyNote({}), CLASS.UNKNOWN);
  // an unprovable history that is no pool exit and within the limit is priced as long history
  assert.equal(classifyNote({ trace: 'unprovable', poolExit: false, transfers: 40 }), CLASS.LONG_HISTORY);
});

test('the boundary at 255 transfers: 255 is clean, 256 is long history', () => {
  assert.equal(classifyNote({ trace: 'tracked', poolExit: false, transfers: 255 }), CLASS.CLEAN);
  assert.equal(classifyNote({ trace: 'tracked', poolExit: false, transfers: 256 }), CLASS.LONG_HISTORY);
});

test('a lock takes the worst class of the notes it spends', () => {
  assert.equal(classifyLock([clean, clean]), CLASS.CLEAN);
  assert.equal(classifyLock([clean, longHistory]), CLASS.LONG_HISTORY);
  assert.equal(classifyLock([longHistory, poolExit]), CLASS.POOL_EXIT);
  assert.equal(classifyLock([clean, unread]), CLASS.UNKNOWN);
  assert.equal(classifyLock([]), CLASS.UNKNOWN);
});

test('unknown is refused with a retry, never priced', () => {
  const d = decideTake(ask([unread], 50n * TAC));
  assert.equal(d.accept, false);
  assert.equal(d.retry, true);
  assert.equal(d.fee, null);
});

test('fees rise with risk: clean < long history < pool exit', () => {
  const p = stuckPolicy();
  assert.ok(feeBpsFor(CLASS.CLEAN, p) < feeBpsFor(CLASS.LONG_HISTORY, p));
  assert.ok(feeBpsFor(CLASS.LONG_HISTORY, p) < feeBpsFor(CLASS.POOL_EXIT, p));
  assert.equal(feeBpsFor(CLASS.CLEAN, p), 30);          // the ordinary fee, untouched
  assert.equal(feeBpsFor(CLASS.LONG_HISTORY, p), 3680); // 30 + 3500 haircut + 150 lockup
  assert.equal(feeBpsFor(CLASS.POOL_EXIT, p), 4255);    // 30 + 4000 haircut + 225 lockup
});

test('the fee covers the expected haircut: the payout never passes what the note is expected to realise, less the wait', () => {
  const p = stuckPolicy();
  for (const [note, cls] of [[longHistory, CLASS.LONG_HISTORY], [poolExit, CLASS.POOL_EXIT]]) {
    const amount = 100n * TAC;
    const d = decideTake(ask([note], amount), p);
    assert.equal(d.accept, true);
    const realised = (amount * BigInt(p.recoveryBps[cls])) / 10000n;      // what the note is expected to be worth
    const lockup = (amount * BigInt(p.lockupBpsPerDay * p.expectedDaysStuck[cls])) / 10000n;
    assert.ok(d.evmOut <= realised - lockup, `${cls}: payout ${d.evmOut} over realised-less-lockup ${realised - lockup}`);
  }
});

test('a clean take is the ordinary quote: base fee plus the flat part', () => {
  const amount = 100n * TAC;
  const d = decideTake(ask([clean], amount));
  assert.equal(d.accept, true);
  assert.equal(d.class, CLASS.CLEAN);
  assert.equal(d.fee, (amount * 30n) / 10000n + 10000000n);
  assert.equal(d.evmOut, amount - d.fee);
});

test('the floor: a class expected to realise under it is refused, not priced', () => {
  const p = stuckPolicy({ recoveryBps: { 'pool-exit': 4000 } }); // under the 5000 floor
  const d = decideTake(ask([poolExit], 50n * TAC), p);
  assert.equal(d.accept, false);
  assert.match(d.why, /floor/);
  // and the same note at a recovery over the floor is taken again
  assert.equal(decideTake(ask([poolExit], 50n * TAC), stuckPolicy({ recoveryBps: { 'pool-exit': 5000 } })).accept, true);
});

test('caps: per note, per day, and the stuck share of inventory', () => {
  assert.equal(decideTake(ask([longHistory], 100n * TAC)).accept, true);            // at the per-note cap
  assert.equal(decideTake(ask([longHistory], 101n * TAC)).accept, false);           // over it
  assert.equal(decideTake(ask([longHistory], 50n * TAC, { stuckTodayTac: 151n * TAC })).accept, false); // over the day
  assert.equal(decideTake(ask([longHistory], 50n * TAC, { stuckTodayTac: 150n * TAC })).accept, true);
  // 20% of a 10,000 TAC inventory is 2,000 TAC of stuck face: at it passes, over it refuses
  assert.equal(decideTake(ask([longHistory], 50n * TAC, { stuckTac: 1950n * TAC })).accept, true);
  assert.equal(decideTake(ask([longHistory], 50n * TAC, { stuckTac: 1951n * TAC })).accept, false);
  // clean takes are not charged against the stuck caps
  assert.equal(decideTake(ask([clean], 500n * TAC, { stuckTac: 9999n * TAC })).accept, true);
});

test('a fee past what a client will quote is refused, not quoted', () => {
  const p = stuckPolicy({ recoveryBps: { 'pool-exit': 500 }, floorRecoveryBps: 0, expectedDaysStuck: { 'pool-exit': 900 } });
  const d = decideTake(ask([poolExit], 50n * TAC), p);
  assert.equal(d.accept, false);
  assert.match(d.why, /quote/);
});

test('safe defaults: the rule is on, unknown refused, and a config that cannot be read throws', () => {
  assert.equal(DEFAULT_STUCK_POLICY.enabled, true);
  assert.equal(decideTake(ask([poolExit], 50n * TAC)).accept, true); // defaults price both stuck classes
  assert.throws(() => stuckPolicy({ recoveryBps: { 'pool-exit': 10001 } }), /recoveryBps/);
  assert.throws(() => stuckPolicy({ baseFeeBps: -1 }), /baseFeeBps/);
  assert.throws(() => stuckPolicy({ maxStuckShareBps: 10001 }), /cap/);
  // the rule switched off refuses stuck and clean alike at this gate: the daemon then quotes as before, without it
  assert.equal(decideTake(ask([clean], 50n * TAC), stuckPolicy({ enabled: false })).accept, false);
});

// ── run ──

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} stuck pricing checks passed`);
process.exit(process.exitCode || 0);
