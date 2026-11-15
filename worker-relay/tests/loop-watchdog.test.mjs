// A stalled loop is noticed and named: a stage that runs longer than the limit calls onStall with that stage, a loop that keeps moving does not, and a limit of 0 watches nothing.
// Run: node --test tests/loop-watchdog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLoopWatchdog } from '../src/lib/loop-watchdog.js';

// a clock and a timer the test drives
function rig(limitMs) {
  let t = 0, tick = null; const stalls = [];
  const wd = makeLoopWatchdog({ limitMs, onStall: (s) => stalls.push(s), now: () => t, everyMs: 60_000, setIntervalFn: (f) => { tick = f; return { unref() {} }; }, clearIntervalFn: () => { tick = null; } });
  return { wd, stalls, advance: (ms) => { t += ms; tick && tick(); }, running: () => tick !== null };
}

test('a stage that runs past the limit is reported by name; a loop that keeps moving is not', () => {
  const r = rig(30 * 60_000); r.wd.start();
  r.wd.stage('scan');
  r.advance(20 * 60_000);
  r.wd.stage('settle');
  r.advance(20 * 60_000);
  assert.deepEqual(r.stalls, [], 'forty minutes in all, but no one stage past thirty');
  r.advance(11 * 60_000);
  assert.equal(r.stalls.length, 1);
  assert.equal(r.stalls[0].stage, 'settle');
  assert.ok(r.stalls[0].idleMs > 30 * 60_000, `it says how long: ${r.stalls[0].idleMs}`);
});

test('a limit of 0 (or a missing handler) watches nothing, and stop ends the watch', () => {
  const none = rig(0); none.wd.start();
  assert.equal(none.running(), false);
  const w = makeLoopWatchdog({ limitMs: 1000, setIntervalFn: () => { throw new Error('no handler: no timer'); } });
  assert.doesNotThrow(() => w.start());
  const r = rig(1000); r.wd.start(); assert.equal(r.running(), true);
  r.wd.stop(); assert.equal(r.running(), false);
  r.wd.start(); r.wd.start();
  assert.equal(r.running(), true, 'starting twice is one watch');
});

test('current() names the stage and how long it has run', () => {
  const r = rig(60_000); r.wd.start(); r.wd.stage('snapshots'); r.advance(5000);
  assert.deepEqual(r.wd.current(), { stage: 'snapshots', idleMs: 5000 });
});

test('a stage that runs long is reported once, by name, well before the limit', () => {
  let t = 0, tick = null; const slow = [], stalls = [];
  const wd = makeLoopWatchdog({ limitMs: 30 * 60_000, warnMs: 5 * 60_000, onSlow: (s) => slow.push(s), onStall: (s) => stalls.push(s), now: () => t, everyMs: 60_000, setIntervalFn: (f) => { tick = f; return { unref() {} }; }, clearIntervalFn: () => {} });
  wd.start(); wd.stage('zrouter');
  for (let i = 0; i < 8; i++) { t += 60_000; tick(); }
  assert.equal(slow.length, 1, 'once, not every minute');
  assert.equal(slow[0].stage, 'zrouter');
  assert.deepEqual(stalls, [], 'eight minutes is not yet a stall');
  wd.stage('scan');
  for (let i = 0; i < 7; i++) { t += 60_000; tick(); }
  assert.equal(slow.length, 2, 'the next stage that runs long is reported too');
});
