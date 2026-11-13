// The provider's refill (fastbridge-lp/lib/refill.mjs): it shields what has reached its address at any level of what is free, and when its free
// private TAC runs under a mark with nothing there it pulls a chunk from a treasury that approved it for a limited amount and shields that; it
// stays inside the allowance, the treasury's balance, a chunk and the day's limit, and it does nothing it cannot finish safely.
//   node tests/fastbridge-refill.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeRefill } from '../fastbridge-lp/lib/refill.mjs';

const TAC = 10n ** 18n, POOL = 10n ** 8n;                   // a TAC in token units and in pool units
const tac = (n) => BigInt(n) * TAC;
const T0 = 1_800_000_000;

// A world with a clock and an address, a treasury and a pool; each call the refill makes is recorded.
function world(over = {}) {
  const w = { t: T0, free: 1000n * POOL, pub: 0n, allow: tac(50000), treasury: tac(1000000), eth: true, quiet: true, state: {}, calls: [], alerts: [], logs: [], pullFails: false, shieldFails: null, ...over };
  const cfg = { lowWater: tac(3000), chunk: tac(5000), minShield: tac(100), maxPerDay: tac(20000), minIntervalSecs: 1800, ...(over.config || {}) };
  const r = makeRefill({
    free: async () => w.free, publicTac: async () => w.pub, allowance: async () => w.allow, treasuryTac: async () => w.treasury, ethOk: async () => w.eth, quiet: async () => w.quiet,
    pull: async (v) => { w.calls.push(['pull', v]); if (w.pullFails) throw new Error('the pull reverted'); w.allow -= v; w.treasury -= v; w.pub += v; },
    shield: async (v) => { w.calls.push(['shield', v]); if (w.shieldFails) { const e = new Error(w.shieldFails.msg); if (w.shieldFails.deposited) e.deposited = w.shieldFails.deposited; throw e; } w.pub -= v; w.free += v / 10n ** 10n; },
    load: async () => w.state, save: async (s) => { w.state = s; }, now: () => w.t, config: cfg, log: (o) => w.logs.push(o), alert: (o) => w.alerts.push(o),
  });
  w.r = r; w.advance = (s) => { w.t += s; };
  return w;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('with enough free and nothing at the address it does nothing', async () => {
  const w = world({ free: 3000n * POOL });
  assert.equal((await w.r.step()).did, 'enough');
  assert.deepEqual(w.calls, []);
  assert.equal((await world({ free: 2999n * POOL }).r.step()).did, 'refilled', 'one TAC under the mark is under it');
});

test('while the free amount cannot be read it does nothing', async () => {
  const w = world({ free: null });
  assert.equal((await w.r.step()).did, 'unread');
  assert.deepEqual(w.calls, []);
});

test('TAC at its address is shielded in preference to a pull, up to a chunk, and nothing is pulled', async () => {
  const w = world({ pub: tac(2000) });
  const r = await w.r.step();
  assert.deepEqual([r.did, r.amount], ['refilled', tac(2000)]);
  assert.deepEqual(w.calls, [['shield', tac(2000)]]);
  const big = world({ pub: tac(12000) });
  await big.r.step();
  assert.deepEqual(big.calls, [['shield', tac(5000)]], 'a chunk at a time');
});

test('dust at its address is left, and a chunk is pulled from the treasury and shielded', async () => {
  const w = world({ pub: tac(6) });
  const r = await w.r.step();
  assert.deepEqual([r.did, r.pulled], ['refilled', tac(5000)]);
  assert.deepEqual(w.calls, [['pull', tac(5000)], ['shield', tac(5000)]], 'what was pulled is shielded, and the dust stays where it is');
});

test('it pulls no more than the allowance, the treasury holds or the day allows, in whole pool units', async () => {
  let w = world({ allow: tac(1200) });
  await w.r.step();
  assert.deepEqual(w.calls[0], ['pull', tac(1200)], 'the allowance is less than a chunk');
  w = world({ treasury: tac(700) });
  await w.r.step();
  assert.deepEqual(w.calls[0], ['pull', tac(700)], 'the treasury holds less');
  w = world({ allow: 1234567890123456789012n });
  await w.r.step();
  assert.equal(w.calls[0][1] % 10n ** 10n, 0n, 'whole pool units: the pool cannot take the remainder');
  assert.equal(w.calls[0][1], 1234567890120000000000n);
});

test('without an allowance, or one under the least worth shielding, nothing is pulled, and the operator is told once', async () => {
  const w = world({ allow: 0n });
  assert.equal((await w.r.step()).did, 'none');
  assert.deepEqual(w.calls, []);
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0].msg, /none can be pulled/);
  w.advance(1900); await w.r.step(); w.advance(1900); await w.r.step();
  assert.equal(w.alerts.length, 1, 'said again only after six hours');
  w.advance(21600); await w.r.step();
  assert.equal(w.alerts.length, 2);
  const small = world({ allow: tac(99) });
  assert.equal((await small.r.step()).did, 'none', 'under the least worth shielding');
});

test('the day has a limit on what it pulls, kept across a restart, and the next day starts again', async () => {
  const w = world({ config: { maxPerDay: tac(8000) }, free: 0n });
  await w.r.step();                                            // pulls 5,000
  assert.deepEqual(w.state, { day: '2027-01-15', pulled: String(tac(5000)) });
  w.free = 0n; w.advance(1900); await w.r.step();              // 3,000 are left of the day
  assert.deepEqual(w.calls.filter((c) => c[0] === 'pull').map((c) => c[1]), [tac(5000), tac(3000)]);
  w.free = 0n; w.advance(1900);
  assert.equal((await w.r.step()).did, 'none', 'the day is used');
  const again = world({ config: { maxPerDay: tac(8000) }, free: 0n, state: w.state, t: w.t });
  assert.equal((await again.r.step()).did, 'none', 'a restart on the same day remembers it');
  again.advance(86400); again.free = 0n;
  assert.equal((await again.r.step()).did, 'refilled', 'the next day');
});

test('it does nothing when the address is low on ETH, or another send from it may be under way, and says so once for ETH', async () => {
  const w = world({ eth: false });
  assert.equal((await w.r.step()).did, 'eth');
  assert.deepEqual(w.calls, []);
  w.advance(1900); await w.r.step();
  assert.equal(w.alerts.length, 1);
  const busy = world({ quiet: false });
  assert.equal((await busy.r.step()).did, 'quiet');
  assert.deepEqual(busy.calls, []);
  busy.quiet = true;
  assert.equal((await busy.r.step()).did, 'refilled', 'asked again, it goes on: waiting for quiet is not an attempt');
});

test('attempts are spaced: a short pause after one that shielded, a long one after one that failed or found nothing to bring in', async () => {
  const w = world({ free: 0n });
  assert.equal((await w.r.step()).did, 'refilled');
  w.free = 0n;
  assert.equal((await w.r.step()).did, 'wait');
  w.advance(59); assert.equal((await w.r.step()).did, 'wait');
  w.advance(2); assert.equal((await w.r.step()).did, 'refilled', 'after the short pause it goes on');
  const none = world({ free: 0n, allow: 0n });
  assert.equal((await none.r.step()).did, 'none');
  none.advance(1799); assert.equal((await none.r.step()).did, 'wait', 'after one that found nothing to bring in, the long pause');
  none.advance(2); assert.equal((await none.r.step()).did, 'none');
});

test('TAC that reaches the address is shielded at any level of what is free, a chunk at a time with the short pause between, until it is all in', async () => {
  const w = world({ free: 50000n * POOL, pub: tac(12000) });
  assert.equal((await w.r.step()).did, 'refilled');
  assert.deepEqual(w.calls, [['shield', tac(5000)]], 'plenty is free, and it is shielded all the same: idle TAC at the address lends nothing');
  assert.equal((await w.r.step()).did, 'wait');
  w.advance(61); await w.r.step();
  w.advance(61); await w.r.step();
  assert.deepEqual(w.calls, [['shield', tac(5000)], ['shield', tac(5000)], ['shield', tac(2000)]], 'all of it, in chunks');
  w.advance(61);
  assert.equal((await w.r.step()).did, 'enough', 'and with it all in and plenty free, nothing more');
  assert.equal(w.pub, 0n);
});

test('TAC at the address waits for ETH and for a quiet address, as a pull does', async () => {
  const w = world({ free: 50000n * POOL, pub: tac(2000), eth: false });
  assert.equal((await w.r.step()).did, 'eth');
  w.eth = true; w.quiet = false;
  assert.equal((await w.r.step()).did, 'quiet');
  w.quiet = true;
  assert.equal((await w.r.step()).did, 'refilled');
  assert.deepEqual(w.calls, [['shield', tac(2000)]]);
});

test('a pull that fails shields nothing and is not repeated at once; the next attempt works', async () => {
  const w = world({ pullFails: true });
  assert.equal((await w.r.step()).did, 'failed');
  assert.deepEqual(w.calls, [['pull', tac(5000)]]);
  assert.match(w.alerts[0].error, /reverted/);
  assert.equal((await w.r.step()).did, 'wait');
  w.pullFails = false; w.advance(1900);
  assert.equal((await w.r.step()).did, 'refilled');
});

test('TAC pulled but not shielded is at the address, and the next attempt shields it without pulling again', async () => {
  const w = world({ shieldFails: { msg: 'the deposit did not go' } });
  assert.equal((await w.r.step()).did, 'failed');
  assert.deepEqual(w.calls, [['pull', tac(5000)], ['shield', tac(5000)]]);
  w.shieldFails = null; w.advance(1900);
  assert.equal((await w.r.step()).did, 'refilled');
  assert.deepEqual(w.calls.slice(2), [['shield', tac(5000)]], 'the pulled TAC is shielded, and no second pull');
  assert.equal(w.allow, tac(45000), 'one pull in all');
});

test('a deposit whose settle did not go through stops the refill for good, with the transaction named, and nothing more is sent', async () => {
  const w = world({ shieldFails: { msg: 'the relay refused', deposited: '0xabc' } });
  const r = await w.r.step();
  assert.equal(r.did, 'stuck');
  assert.equal(w.alerts.length, 1);
  assert.equal(w.alerts[0].level, 'error');
  assert.equal(w.alerts[0].deposit, '0xabc');
  assert.deepEqual(w.r.halted().deposited, '0xabc');
  w.shieldFails = null; w.free = 0n; w.advance(86400 * 3);
  assert.equal((await w.r.step()).did, 'halted');
  assert.equal(w.calls.length, 2, 'the pull and the one deposit, and no more');
});

test('two steps at once are one: the second does not start while the first is under way', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = world({ pub: tac(2000) });
  const slow = makeRefill({
    free: async () => w.free, publicTac: async () => w.pub, allowance: async () => w.allow, treasuryTac: async () => w.treasury, ethOk: async () => true,
    pull: async () => {}, shield: async (v) => { w.calls.push(['shield', v]); await gate; }, now: () => w.t, config: { lowWater: tac(3000), chunk: tac(5000), minShield: tac(100), maxPerDay: tac(20000) },
  });
  const first = slow.step();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await slow.step()).did, 'busy');
  release(); await first;
  assert.deepEqual(w.calls, [['shield', tac(2000)]]);
});

test('settings that could pull nothing, or without limit, are refused when it is made', async () => {
  for (const bad of [{ lowWater: 0n }, { chunk: 0n }, { minShield: 0n }, { maxPerDay: -1n }]) {
    assert.throws(() => world({ config: bad }), /refill: /);
  }
});

test('the daemon makes it only when the config names a treasury, never in a dry run, and the pull is the standard transferFrom from the treasury to its own address', async () => {
  const src = readFileSync(new URL('../fastbridge-lp/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(C\.refill && !DRY\)/, 'off unless configured, and never in a dry run');
  assert.match(src, /0x23b872dd/, 'transferFrom(address,address,uint256)');
  assert.match(src, /'0x23b872dd' \+ word\(treasury\) \+ word\(acct\.address\) \+ word\(amount\)/, 'from the treasury to its own address, and no other recipient');
  assert.match(src, /ux\.warmWrapLogs\(\{ ticker: 'TAC' \}\)/, 'the wrap logs are read a little after start, so the first real shield is not the slow one');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} refill checks passed`);
process.exit(process.exitCode || 0);
