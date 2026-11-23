// dapp/lockmint-auto.js: one press from BTC to cUSD. The decision (what the Borrow card's lock, bond, mint and borrow come to next) is pure, so it is run here
// against a fake chain over hours of simulated time, with step functions that change the fake chain as the real ones do. The cases that matter most: the BTC
// is never sent by it, a lock is never made twice (not even on a stale read), the bond runs only inside a press, a step that goes nowhere stops after three tries,
// and a loan is sized from the price at that moment and never near the floor.
//   node --test tests/lockmint-auto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newIntent, autoNext, afterStep, stageOf, debtFor, autoLine, RETRY_MS, MAX_FAILS, EXPIRE_MS } from '../dapp/lockmint-auto.js';

const idOf = (r) => `${r.lockTxid}:${r.lockVout}`;
const OLD = { lockTxid: 'aa'.repeat(32), lockVout: 1, vBtc: '10000' }, NEW = { lockTxid: 'bb'.repeat(32), lockVout: 1, vBtc: '100000' }, NEWID = idOf(NEW);
const SATS = 100000n, PAD = 5000n, T0 = 1_800_000_000_000;
const base = { rec: null, sats: 0n, pendingSats: 0n, bonded: false, reflected: false, minted: false, borrowed: 0n, cbtc: null, usd: 7_000_000_000n, ratio: 15000n, height: null };
const next = (st, intent, o = {}) => autoNext({ st, intent, pad: PAD, idOf, listed: new Set(), now: T0, ...o });
const intent = (o = {}) => ({ ...newIntent({ sats: SATS, ratio: 200, before: [idOf(OLD)], now: T0 }), ...o });

test('the loan is the ratio of the lock’s value in a cent’s grain, and never within five points of the floor', () => {
  assert.equal(debtFor({ usd: 7_000_000_000n, ratio: 200 }), 3_500_000_000n, '200% is half the lock’s value, the card’s own suggestion');
  assert.equal(debtFor({ usd: 7_000_000_123n, ratio: 200 }), 3_500_000_000n, 'cut to 0.01');
  assert.equal(debtFor({ usd: 7_000_000_000n, ratio: 250 }), 2_800_000_000n);
  assert.equal(debtFor({ usd: 7_000_000_000n, ratio: 150, floor: 15000n }), 4_516_000_000n, '150% would be 4.666 of 7, over what the floor and five points allow (4.516): cut to it');
  assert.equal(debtFor({ usd: 0n }), 0n); assert.equal(debtFor({ usd: null }), 0n);
  for (const usd of [1n * 10n ** 8n, 7n * 10n ** 11n, 123456789012n]) for (const ratio of [100, 110, 150, 175, 200, 250, 400]) {
    const d = debtFor({ usd, ratio, floor: 15000n });
    assert.ok(d * 15500n <= usd * 10000n, `usd ${usd} at ${ratio}%: ${d} keeps the ratio five points over the floor`);
    assert.ok(d % 1_000_000n === 0n && d * BigInt(ratio) <= usd * 100n, 'in a cent’s grain, and never more than the ratio asked');
  }
});

test('before there is a lock: it waits for BTC, then for it to confirm, then locks; it never sends the BTC', () => {
  const it = intent();
  assert.deepEqual(next(null, it), { act: 'wait', why: 'read' });
  assert.deepEqual(next({ ...base, sats: null }, it), { act: 'wait', why: 'read' }, 'a deposit address that could not be read is not an empty one');
  assert.deepEqual(next({ ...base, sats: 20000n }, it), { act: 'wait', why: 'deposit', short: SATS + PAD - 20000n });
  assert.deepEqual(next({ ...base, sats: SATS + PAD, pendingSats: SATS + PAD }, it), { act: 'wait', why: 'confirm' }, 'enough, but unconfirmed');
  assert.deepEqual(next({ ...base, sats: SATS + PAD }, it), { act: 'lock' });
  assert.deepEqual(next({ ...base, sats: SATS + PAD + 1n, pendingSats: 2n }, it), { act: 'wait', why: 'confirm' }, 'enough in all, but the confirmed part is a sat short');
  assert.deepEqual(next({ ...base, sats: SATS + PAD + 1n, pendingSats: 1n }, it), { act: 'lock' }, 'and with the confirmed part enough it locks, whatever else is on its way');
  assert.ok(![next({ ...base }, it), next({ ...base, sats: 1n }, it)].some((x) => x.act === 'fund' || x.act === 'lock'), 'no fund step exists');
});

test('a lock the card already knew is never taken for its own; the one made after the intent is adopted', () => {
  const it = intent();
  assert.equal(next({ ...base, rec: OLD, bonded: true, minted: true, sats: SATS + PAD }, it).act, 'lock', 'the old lock is being followed, our lock is still to make');
  const n = next({ ...base, rec: NEW }, it, { gesture: true });
  assert.deepEqual([n.act, n.adopt], ['bond', NEWID], 'a new lock is the intent’s: adopted');
  assert.equal(stageOf({ st: { ...base, rec: OLD, minted: true }, intent: it, idOf }), 0);
  assert.equal(stageOf({ st: { ...base, rec: NEW }, intent: it, idOf }), 1);
  const own = intent({ lock: NEWID });
  assert.equal(stageOf({ st: { ...base, rec: OLD, minted: true }, intent: own, idOf }), 0, 'once adopted, only that lock counts');
  assert.deepEqual(next({ ...base, rec: OLD }, own, { listed: new Set([NEWID, idOf(OLD)]) }), { act: 'pick', id: NEWID }, 'the card follows another lock: it is asked to follow ours');
  assert.deepEqual(next({ ...base, rec: OLD }, own, { listed: new Set([idOf(OLD)]) }), { act: 'wait', why: 'gone' }, 'ours is not listed: it waits and says so, and does not lock again');
  assert.deepEqual(next({ ...base, rec: null, sats: 10n ** 9n }, own), { act: 'wait', why: 'gone' }, 'with a lock of its own made, plenty of BTC at the address never makes a second');
});

test('the lock’s own steps, in order: the bond asks for a press, the proof is waited for, then mint and borrow', () => {
  const it = intent({ lock: NEWID }), rec = NEW;
  assert.deepEqual(next({ ...base, rec }, it), { act: 'ask', step: 'bond', adopt: undefined }, 'no press, no bond');
  assert.equal(next({ ...base, rec }, it, { gesture: true }).act, 'bond');
  assert.equal(next({ ...base, rec, bonded: true }, it).why, 'bitcoin', 'bonded, not yet on Bitcoin');
  assert.equal(next({ ...base, rec, bonded: true, height: 900000 }, it).why, 'proof', 'confirmed, waiting for Bitcoin’s proof');
  assert.equal(next({ ...base, rec, bonded: true, reflected: true, height: 900000 }, it).act, 'mint');
  assert.equal(next({ ...base, rec, reflected: true }, it, { gesture: true }).act, 'bond', 'proven but unbonded is still the bond: nothing is minted without it');
  assert.equal(next({ ...base, rec, bonded: true, reflected: true }, it, { flight: true }).why, 'flight', 'a step on its way is waited for, not run twice');
  assert.equal(next({ ...base, rec, bonded: true, minted: true }, it).why, 'note', 'minted, the note not visible yet');
  const b = next({ ...base, rec, bonded: true, minted: true, cbtc: { value: '100000' } }, it);
  assert.deepEqual([b.act, b.debt], ['borrow', 3_500_000_000n], 'minted: borrow at the ratio on the price now');
  assert.equal(next({ ...base, rec, bonded: true, minted: true, cbtc: { value: '1' }, usd: null }, it).why, 'price');
  assert.equal(next({ ...base, rec, bonded: true, minted: true, borrowed: 5n }, it).act, 'done');
  assert.equal(next({ ...base, rec, bonded: true, minted: true }, { ...it, until: 'cbtc' }).act, 'done', 'a lock for cBTC ends at the mint');
  assert.equal(next({ ...base, rec, bonded: true, reflected: true }, { ...it, until: 'cbtc' }).act, 'mint');
});

test('a step that goes nowhere is tried again after five minutes, three times, then it stops and says what it saw', () => {
  const st = { ...base, rec: NEW, bonded: true, reflected: true, height: 1 }, it0 = intent({ lock: NEWID });
  assert.equal(next(st, it0).act, 'mint');
  const f1 = afterStep(it0, { before: 2, after: 2, now: T0, say: 'Not ready yet: the lock is still being proven.' });
  assert.deepEqual([f1.fails, f1.failAt, f1.last], [1, T0, 'Not ready yet: the lock is still being proven.']);
  assert.deepEqual(next(st, f1, { now: T0 + 60e3 }), { act: 'wait', why: 'retry', at: T0 + RETRY_MS }, 'not again at once');
  assert.equal(next(st, f1, { now: T0 + RETRY_MS }).act, 'mint', 'after five minutes');
  const f2 = afterStep(f1, { before: 3, after: 3, now: T0 + RETRY_MS, say: '' }), f3 = afterStep(f2, { before: 3, after: 3, now: T0 + 2 * RETRY_MS, say: 'x' });
  assert.equal(f2.last, 'Not ready yet: the lock is still being proven.', 'a silent failure keeps the last words');
  assert.deepEqual([f3.fails, MAX_FAILS], [3, 3]);
  const stop = next(st, f3, { now: T0 + 3 * RETRY_MS });
  assert.deepEqual([stop.act, stop.why], ['stopped', 'x']);
  const ok = afterStep(f2, { before: 3, after: 4, now: T0 + 3 * RETRY_MS });
  assert.deepEqual([ok.fails, ok.failAt, ok.last], [0, 0, ''], 'progress clears the count');
  assert.equal(next(st, { ...it0, stop: 'You stopped it.' }).why, 'You stopped it.');
  assert.equal(next(st, it0, { now: T0 + EXPIRE_MS + 1 }).act, 'stopped', 'a week on, it gives up');
  assert.equal(next(st, null).act, 'none');
});

// ── the whole timeline, on a fake chain ──
function world({ sats = SATS + PAD, now = T0 } = {}) {
  const w = { now, calls: [], chain: { sats, pending: 0n, rec: null, bonded: false, reflected: false, minted: false, borrowed: 0n, cbtc: null, height: null, usd: 7_000_000_000n, stale: false },
    fail: {}, it: intent(), pad: PAD, gestureNow: false };
  w.st = () => ({ ...base, rec: w.chain.stale ? null : w.chain.rec, sats: w.chain.sats, pendingSats: w.chain.pending, bonded: w.chain.bonded, reflected: w.chain.reflected, minted: w.chain.minted,
    borrowed: w.chain.borrowed, cbtc: w.chain.cbtc, usd: w.chain.usd, height: w.chain.height });
  const steps = {
    lock: () => { w.chain.rec = NEW; w.chain.sats = 3000n; w.chain.height = null; },
    bond: () => { w.chain.bonded = true; },
    mint: () => { w.chain.minted = true; w.chain.cbtc = { value: '100000' }; },
    borrow: (n) => { w.chain.borrowed = n.debt; },
  };
  // the page's autoTick, without the page: ask, run, read again, record progress
  w.tick = ({ gesture = false } = {}) => {
    for (let i = 0; i < 6; i++) {
      const n = autoNext({ st: w.st(), intent: w.it, pad: w.pad, idOf, listed: new Set(w.chain.rec ? [NEWID] : []), flight: false, gesture, now: w.now });
      if (n.adopt && !w.it.lock) w.it = { ...w.it, lock: n.adopt };
      if (!steps[n.act]) return n;
      const before = stageOf({ st: w.st(), intent: w.it, idOf });
      w.calls.push(n.act);
      if (!w.fail[n.act]) steps[n.act](n);
      const after = stageOf({ st: w.st(), intent: w.it, idOf });
      w.it = afterStep(w.it, { before, after, now: w.now, say: w.fail[n.act] || '' });
      if (after <= before) return n;
    }
    return null;
  };
  return w;
}

test('timeline: BTC confirmed, one press: lock and bond at once, hours of waiting, then mint and borrow by itself, each step once', () => {
  const w = world();
  w.tick({ gesture: true });
  assert.deepEqual(w.calls, ['lock', 'bond'], 'the press locks and posts the bond');
  assert.equal(w.tick().why, 'bitcoin');
  w.chain.height = 900000; w.now += 40 * 60e3;
  assert.equal(w.tick().why, 'proof');
  for (let i = 0; i < 180; i++) { w.now += 60e3; const n = w.tick(); assert.equal(n.act, 'wait', 'a minute at a time, nothing runs until the proof is there'); }
  assert.deepEqual(w.calls, ['lock', 'bond']);
  w.chain.reflected = true; w.now += 60e3;
  const end = w.tick();
  assert.deepEqual(w.calls, ['lock', 'bond', 'mint', 'borrow'], 'proven: mint and borrow follow in the same tick, with no press');
  assert.equal(end.act, 'done');
  assert.equal(w.chain.borrowed, 3_500_000_000n, 'at 200% of the price at that moment');
  assert.equal(w.tick().act, 'done'); assert.deepEqual(w.calls, ['lock', 'bond', 'mint', 'borrow'], 'and nothing runs again');
});

test('timeline: no BTC yet: it waits, locks on its own once the deposit confirms, then asks for the bond and waits for a press', () => {
  const w = world({ sats: 0n });
  assert.equal(w.tick({ gesture: true }).why, 'deposit');
  assert.deepEqual(w.calls, [], 'a press with no BTC locks nothing');
  w.chain.sats = SATS + PAD; w.chain.pending = SATS + PAD; w.now += 60e3;
  assert.equal(w.tick().why, 'confirm');
  w.chain.pending = 0n; w.now += 30 * 60e3;
  const n = w.tick();
  assert.deepEqual(w.calls, ['lock'], 'the lock needs no wallet, so it runs without a press');
  assert.deepEqual([n.act, n.step], ['ask', 'bond'], 'and then it needs the person');
  for (let i = 0; i < 5; i++) { w.now += 3600e3; assert.equal(w.tick().act, 'ask'); }
  assert.deepEqual(w.calls, ['lock'], 'hours later still waiting for the press: the bond is never run without one');
  w.tick({ gesture: true });
  assert.deepEqual(w.calls, ['lock', 'bond']);
});

test('timeline: a stale read after the lock never makes a second lock', () => {
  const w = world();
  w.chain.stale = true;                                   // the lock went out, the read of the key's locks does not show it yet, and the old coin is still listed
  {
    w.tick({ gesture: true });
    assert.deepEqual(w.calls, ['lock'], 'one lock');
    assert.equal(w.it.fails, 1, 'no lock showed: counted as a step that went nowhere');
    w.chain.sats = SATS + PAD;                           // the explorer still lists the coin
    for (let i = 0; i < 4; i++) { w.now += 60e3; w.tick({ gesture: true }); }
    assert.deepEqual(w.calls, ['lock'], 'the retry wait holds the second one back');
    w.chain.stale = false; w.now += 60e3;
    w.tick({ gesture: true });
    assert.deepEqual(w.calls, ['lock', 'bond'], 'the read catches up: the lock is the intent’s own and goes on to its bond');
    assert.equal(w.it.lock, NEWID);
  }
});

test('timeline: a mint that never goes through stops after three tries; a resume starts the count again', () => {
  const w = world();
  w.tick({ gesture: true }); w.chain.height = 1; w.chain.reflected = true; w.fail.mint = 'Not ready yet: the lock is still being proven.';
  for (let i = 0; i < 3; i++) { w.tick(); w.now += RETRY_MS; }
  assert.deepEqual(w.calls.filter((x) => x === 'mint'), ['mint', 'mint', 'mint']);
  const s = w.tick();
  assert.deepEqual([s.act, s.why], ['stopped', 'Not ready yet: the lock is still being proven.']);
  assert.equal(w.calls.filter((x) => x === 'mint').length, 3, 'a stopped intent runs nothing more');
  w.fail.mint = null; w.it = { ...w.it, fails: 0, failAt: 0, stop: null, last: '' };      // the card’s Resume
  w.tick();
  assert.deepEqual(w.calls.slice(-2), ['mint', 'borrow']);
});

test('timeline: the price moves between the mint and the loan: the loan is sized at the price then, and a price that falls cannot reach the floor', () => {
  const w = world(); w.it = { ...w.it, ratio: 150 };
  w.tick({ gesture: true }); w.chain.reflected = true; w.chain.height = 1; w.chain.usd = 4_000_000_000n;
  w.tick();
  assert.equal(w.chain.borrowed, debtFor({ usd: 4_000_000_000n, ratio: 150, floor: 15000n }), 'sized from the price now');
  assert.ok(w.chain.borrowed * 15500n <= 4_000_000_000n * 10000n + 15500n * 10n ** 6n, 'five points over the 150% floor, whatever ratio was asked');
  assert.ok(w.chain.borrowed < 4_000_000_000n * 100n / 150n, 'so a 150% ask is cut to stay clear of the floor');
});

test('a lock for cBTC only ends at the mint and borrows nothing', () => {
  const w = world(); w.it = { ...w.it, until: 'cbtc' };
  w.tick({ gesture: true }); w.chain.reflected = true; w.chain.height = 1; w.tick();
  assert.deepEqual(w.calls, ['lock', 'bond', 'mint']);
});

test('the card’s line says what it waits for', () => {
  const fmt = (v) => `${Number(v) / 1e8} BTC`, it = intent(), line = (n) => autoLine(n, it, { fmt, now: T0 });
  assert.match(line({ act: 'wait', why: 'deposit', short: 50000n }), /waiting for 0\.0005 BTC more BTC at your Bitcoin address, then it locks it/);
  assert.match(line({ act: 'wait', why: 'proof' }), /Bitcoin’s proof to reach your lock, then it mints cBTC and borrows cUSD\. Keep this tab open, or come back: it carries on from here\./);
  assert.match(autoLine({ act: 'wait', why: 'proof' }, { ...it, until: 'cbtc' }, { fmt }), /then it mints cBTC\. Keep this tab open/);
  assert.match(line({ act: 'ask', step: 'bond' }), /needs you for the bond: one wallet confirmation/);
  assert.match(line({ act: 'stopped', why: 'x' }), /^Autopilot stopped: x$/);
  assert.match(line({ act: 'wait', why: 'retry', at: T0 + 4 * 60e3 + 1 }), /tries again in 5 min/);
  assert.equal(line({ act: 'none' }), '');
  for (const why of ['read', 'confirm', 'gone', 'flight', 'bitcoin', 'note', 'price']) assert.match(line({ act: 'wait', why }), /^Autopilot /);
});
