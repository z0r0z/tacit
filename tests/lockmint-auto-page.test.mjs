// The front page's one-press flow from BTC to cUSD (dapp/index.html): the real driver (autoTick, autoStep, the intent kept for the key) and the real press (hxBwStart) are
// cut out of the page and run against a fake chain with a clock the test moves, and step functions that change the chain as the card's own do (the technique of
// tests/zap-page-flows.test.mjs). dapp/lockmint-auto.js decides what is next (tests/lockmint-auto.test.mjs); this checks that the page does what it names, once, and stops when told.
//   node --test tests/lockmint-auto-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newIntent, autoNext, afterStep, stageOf, autoLine } from '../dapp/lockmint-auto.js';
import { frontPage } from './lib/front-page.mjs';

const page = frontPage(new URL('../dapp/index.html', import.meta.url));
const cut = (a, b) => { const s = page.indexOf(a), e = page.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the page has ${a}`); return page.slice(s, e); };
const SRC = `${cut('// ── one press from BTC to cUSD', 'function hxBwUpdate() {')}\n${cut('async function hxBwStart() {', '\nfunction hxKeepAmt')}`;
const NAMES = ['store', 'S', 'HX', 'LOCK', 'lockId', 'newIntent', 'autoNext', 'afterStep', 'stageOf', 'autoLine', 'HXP', 'hxBwInflight', 'busy', 'FLASH', 'say', '$', 'BWX', 'bwCanWst', 'loadBorrow', 'hxPad', 'rerender', 'hxBwUpdate',
  'html', 'fmt', 'document', 'setInterval', 'setTimeout', 'hxUnits', 'hxBwLoad', 'Date'];
const SATS = 100000n, PAD = 5000n, T0 = 1_800_000_000_000;
const REC = { lockTxid: 'bb'.repeat(32), lockVout: 1, vBtc: '100000' }, RECID = `${REC.lockTxid}:${REC.lockVout}`;

function rig({ sats = SATS + PAD, held = false } = {}) {
  const log = [], clock = { t: T0 }, mem = new Map(), timers = [];
  const chain = { sats, pending: 0n, rec: null, bonded: false, reflected: false, minted: false, borrowed: 0n, cbtc: null, height: null, usd: 7_000_000_000n, fail: {} };
  const el = () => ({ textContent: '', getAttribute: () => null, setAttribute() {}, removeAttribute() {} });
  const HX = { bwr: '200', bm: 'cusd', bwBusy: 0, q: {}, bwMore: true }, S = { key: { pubHex: 'pub1' } }, LOCK = { state: null, list: [], pick: null }, notes = [];
  const store = { get: (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null), set: (k, v) => (v == null ? mem.delete(k) : mem.set(k, JSON.stringify(v))) };
  const stub = { store, S, HX, LOCK, lockId: (l) => `${l.lockTxid}:${l.lockVout}`, newIntent, autoNext, afterStep, stageOf, autoLine, HXP: { v: PAD }, hxBwInflight: () => null,
    busy: async (btn, fn) => { log.push('busy'); return fn({ check() {} }); }, FLASH: {}, say: (e, v) => { if (e) e.textContent = String(v?.s ?? v); }, $: () => null,
    bwCanWst: () => held, rerender() {}, hxBwUpdate: () => { notes.push('update'); }, html: (s, ...v) => ({ s: s.reduce((a, x, i) => a + (v[i - 1]?.s ?? v[i - 1] ?? '') + x) }),
    fmt: (v) => `${Number(v) / 1e8}`, document: { createElement: el }, setInterval: () => 0, setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, hxUnits: () => SATS, hxBwLoad() {},
    Date: { now: () => clock.t }, hxPad: async () => PAD,
    loadBorrow: async () => {
      log.push('read');
      LOCK.list = chain.rec ? [chain.rec] : [];
      LOCK.state = { rec: chain.rec, sats: chain.sats, pendingSats: chain.pending, bonded: chain.bonded, reflected: chain.reflected, minted: chain.minted, borrowed: chain.borrowed, cbtc: chain.cbtc, usd: chain.usd, ratio: 15000n, height: chain.height, at: clock.t };
    },
    BWX: {
      fund: async (where, sats) => { log.push(`fund:${sats}`); },
      lock: async (where, sats) => { log.push(`lock:${sats}`); if (chain.fail.lock) return void (where().textContent = chain.fail.lock); chain.rec = REC; chain.sats = 3000n; },
      bond: async (run, where, use) => { log.push(`bond:${use}`); if (chain.fail.bond) return void (where().textContent = chain.fail.bond); chain.bonded = true; },
      mint: async (run, where) => { log.push('mint'); if (chain.fail.mint) return void (where().textContent = chain.fail.mint); chain.minted = true; chain.cbtc = { value: '100000' }; chain.fail.after?.(); },
      borrow: async (run, where, debt, self) => { log.push(`borrow:${debt}`); chain.borrowed = debt; },
    } };
  const api = new Function(...NAMES, `${SRC}\nreturn { autoTick, autoStart, autoGet, autoSet, autoNote, autoSoon, hxBwStart, AUTO };`)(...NAMES.map((k) => stub[k]));
  return { ...api, log, clock, chain, HX, LOCK, S, mem, timers, notes, stub, calls: () => log.filter((x) => x !== 'read' && x !== 'busy') };
}
const later = (r, ms) => { r.clock.t += ms; };

test('the press with no BTC sends the funding and keeps the intent; nothing is locked or bonded', async () => {
  const r = rig({ sats: 0n });
  await r.stub.loadBorrow();
  await r.hxBwStart();
  assert.deepEqual(r.calls(), [`fund:${SATS}`]);
  const it = r.autoGet();
  assert.deepEqual([it.sats, it.ratio, it.until, it.before, it.lock], [String(SATS), 200, 'cusd', [], null], 'what to lock, at what ratio, how far; no lock of its own yet');
  assert.match(r.autoNote(r.LOCK.state).s, /Autopilot is waiting for 0\.00105 more BTC at your Bitcoin address/);
  assert.match(r.autoNote(r.LOCK.state).s, /data-hxbw="autostop">Stop</, 'with the way to stop it');
});

test('the press with the BTC confirmed locks it and posts the bond inside the press, then waits for the proof', async () => {
  const r = rig();
  await r.stub.loadBorrow();
  await r.hxBwStart();
  assert.deepEqual(r.calls(), [`lock:${SATS}`, 'bond:eth'], 'no fund step, the lock, then the bond (a press: the wallet asks)');
  assert.equal(r.autoGet().lock, RECID, 'the lock made is the intent’s own');
  assert.equal(r.HX.bwMore, false, 'and the card moves to following it');
  const n = r.log.length;
  later(r, 60e3); await r.autoTick();
  assert.deepEqual(r.calls(), [`lock:${SATS}`, 'bond:eth'], 'waiting for the proof runs nothing');
  assert.match(r.autoNote(r.LOCK.state).s, /waiting for your lock to confirm on Bitcoin/, 'first Bitcoin’s confirmation');
  r.chain.height = 900000; later(r, 60e3); await r.autoTick();
  assert.match(r.autoNote(r.LOCK.state).s, /waiting for Bitcoin’s proof to reach your lock, then it mints cBTC and borrows cUSD/, 'then its proof');
  assert.deepEqual(r.calls(), [`lock:${SATS}`, 'bond:eth']);
  assert.ok(r.log.length >= n);
});

test('hours later, the timer finds the proof there and mints and borrows with no press; the intent is gone when it is done', async () => {
  const r = rig();
  await r.stub.loadBorrow(); await r.hxBwStart();
  r.chain.height = 900000;
  for (let i = 0; i < 120; i++) { later(r, 60e3); await r.autoTick(); }
  assert.deepEqual(r.calls(), [`lock:${SATS}`, 'bond:eth'], 'two hours of ticks, nothing run');
  r.chain.reflected = true; later(r, 60e3);
  await r.autoTick();
  assert.deepEqual(r.calls().slice(2), ['mint', `borrow:${3_500_000_000n}`], 'proven: mint, then the loan at 200% of the price now');
  assert.equal(r.autoGet(), null, 'done: the intent is cleared');
  const before = r.log.length; later(r, 60e3); await r.autoTick();
  assert.equal(r.log.length, before, 'and nothing runs again');
});

test('the bond is never posted without a press: a lock made by the timer waits for one, and the card says so', async () => {
  const r = rig({ sats: 0n });
  await r.stub.loadBorrow(); await r.hxBwStart();
  r.chain.sats = SATS + PAD; later(r, 40 * 60e3);
  await r.autoTick();
  assert.deepEqual(r.calls(), [`fund:${SATS}`, `lock:${SATS}`], 'the deposit confirmed: it locked, with no press');
  for (let i = 0; i < 10; i++) { later(r, 3600e3); await r.autoTick(); }
  assert.ok(!r.calls().some((x) => x.startsWith('bond')), 'ten hours on, no bond');
  assert.match(r.autoNote(r.LOCK.state).s, /needs you for the bond: one wallet confirmation/);
  await r.autoTick({ gesture: true, force: true });
  assert.ok(r.calls().includes('bond:eth'), 'the press that is the card’s button or Resume posts it');
});

test('wstETH held is the bond’s way (a signature in the same transaction), ETH otherwise', async () => {
  const r = rig({ held: true });
  await r.stub.loadBorrow(); await r.hxBwStart();
  assert.deepEqual(r.calls(), [`lock:${SATS}`, 'bond:wst']);
});

test('with the autopilot off the press is the old one: lock or fund, no intent kept, nothing carried on', async () => {
  const r = rig(); r.HX.bwAuto = false;
  await r.stub.loadBorrow(); await r.hxBwStart();
  assert.deepEqual(r.calls(), [`lock:${SATS}`]);
  assert.equal(r.autoGet(), null);
  const f = rig({ sats: 0n }); f.HX.bwAuto = false;
  await f.stub.loadBorrow(); await f.hxBwStart();
  assert.deepEqual(f.calls(), [`fund:${SATS}`]); assert.equal(f.autoGet(), null);
});

test('BTC already on its way: the press starts the intent and sends nothing; a second press while its lock is in progress refuses', async () => {
  const r = rig({ sats: SATS + PAD });
  r.chain.pending = SATS + PAD; r.HX.q = { wait: true };
  await r.stub.loadBorrow(); await r.hxBwStart();
  assert.deepEqual(r.calls(), [], 'no funding, no lock');
  assert.ok(r.autoGet(), 'the intent is kept, so the lock follows the confirmation');
  const s = rig(); s.HX.q = {};
  await s.stub.loadBorrow(); await s.hxBwStart();
  const calls = s.calls().length;
  const msgs = [];
  await s.hxBwStart();
  assert.equal(s.calls().length, calls, 'a second press while its own lock is carried on makes nothing');
});

test('a second press while the autopilot is in the middle of a step changes nothing', async () => {
  const r = rig();
  await r.stub.loadBorrow();
  r.AUTO.busy = true;
  await r.hxBwStart();
  assert.deepEqual(r.calls(), [], 'no funding, no lock');
  assert.equal(r.autoGet(), null, 'and the intent of the press under way is not replaced');
});

test('a step that goes nowhere is tried again after five minutes, three times, then it stops; Resume starts the count again', async () => {
  const r = rig();
  await r.stub.loadBorrow(); await r.hxBwStart();
  r.chain.height = 1; r.chain.reflected = true; r.chain.fail.mint = 'Not ready yet: the lock is still being proven.';
  for (let i = 0; i < 6; i++) { later(r, 5 * 60e3); await r.autoTick(); }
  assert.equal(r.calls().filter((x) => x === 'mint').length, 3, 'three tries and no more');
  assert.match(r.autoNote(r.LOCK.state).s, /Autopilot stopped: Not ready yet: the lock is still being proven\./);
  assert.match(r.autoNote(r.LOCK.state).s, /data-hxbw="autogo">Resume</);
  r.chain.fail.mint = null; r.autoSet({ ...r.autoGet(), fails: 0, failAt: 0, stop: null, last: '' });
  later(r, 60e3); await r.autoTick({ gesture: true, force: true });
  assert.deepEqual(r.calls().slice(-2), ['mint', `borrow:${3_500_000_000n}`]);
});

test('Stop pressed while a step runs is not undone by the step finishing', async () => {
  const r = rig();
  await r.stub.loadBorrow(); await r.hxBwStart();
  r.chain.height = 1; r.chain.reflected = true; r.chain.fail.after = () => r.autoSet(null);       // the person presses Stop while the mint is being proven
  later(r, 60e3); await r.autoTick();
  assert.equal(r.autoGet(), null, 'the intent stays cleared');
  assert.ok(!r.calls().some((x) => x.startsWith('borrow')), 'and no loan follows');
});

test('it keeps out of the way: not while a step of the card runs, not twice within twenty seconds, not for another key', async () => {
  const r = rig();
  await r.stub.loadBorrow(); await r.hxBwStart();
  r.chain.height = 1; r.chain.reflected = true;
  r.HX.bwBusy = 1; later(r, 60e3); await r.autoTick();
  assert.ok(!r.calls().includes('mint'), 'a step of the card is running');
  r.HX.bwBusy = 0; later(r, 60e3); const reads = () => r.log.filter((x) => x === 'read').length;
  await r.autoTick();
  assert.ok(r.calls().includes('mint'));
  const n = reads(); later(r, 5e3); await r.autoTick();
  assert.equal(reads(), n, 'a tick five seconds after the last does nothing');
  r.S.key = { pubHex: 'pub2' }; later(r, 60e3);
  const m = r.log.length; await r.autoTick();
  assert.equal(r.log.length, m, 'another key has no intent');
});

test('the card’s buttons and the page’s own hooks are wired', () => {
  assert.match(page, /if \(k === 'autostop'\) \{ autoSet\(null\); box\.__h = ''; return hxBwUpdate\(\); \}/, 'Stop clears the intent');
  assert.match(page, /if \(k === 'autogo'\) \{ const it = autoGet\(\); if \(it\) autoSet\(\{ \.\.\.it, fails: 0, failAt: 0, stop: null, last: '' \}\); return void autoTick\(\{ gesture: true, force: true \}\); \}/, 'Resume clears the failures and runs inside the press');
  assert.match(page, /return html`\$\{head\}\$\{stepper\}\$\{autoNote\(st\)\}<div class="hx-bw-p">/, 'the track face shows the line');
  assert.match(page, /function hxBwUpdate\(\) \{\n  autoSoon\(\);/, 'every card update asks for a tick');
  assert.match(page, /setInterval\(\(\) => \{ if \(S\.key && autoGet\(\)\) autoTick\(\); \}, 60e3\);/, 'and so does the minute');
  assert.match(page, /const go = ready != null && ready >= need \? `Lock \$\{fmt\(units, 8, 8\)\} BTC\$\{auto \? more : ''\}`/, 'the lock face’s button says what the press does');
  assert.match(page, /cusd: \[\['Lock BTC and borrow cUSD', 'borrow:cusd'\]\]/, 'the Earn card’s link says it too');
});
