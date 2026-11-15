// The settle loop's heartbeat (src/settle-relay.js). /prover-health calls a kind "down" after ten quiet minutes, and on
// 2026-11-15 settle read "down" for 17 minutes while it was in fact alive and failing every job it took: a batch of farm
// entries the chain refused, each member re-proved and acked failed in well under a minute. Nothing in that path beat —
// `beating()` only starts beating after four minutes, and the idle beat is skipped because the cycle DID work — so the one
// reading that mattered said the opposite of the truth.
//
// settle-relay.js cannot be imported here (it reads the relay's whole config at load), so these pin the two guards in its
// source: the fast-failing path beats before it proves, and the loop beats on any working cycle that has gone quiet.
// Run: node --test tests/settle-beat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/settle-relay.js', import.meta.url), 'utf8');
const body = (name) => {
  const at = src.indexOf(`async function ${name}(`);
  assert.notEqual(at, -1, `${name} is gone from settle-relay.js — these checks need rewriting, not deleting`);
  return src.slice(at, at + 2600);
};

test('settleOne beats before it proves, so a job that fails fast still beats', () => {
  const f = body('settleOne');
  const beatAt = f.search(/await beat\(/), proveAt = f.search(/beating\(/);
  assert.notEqual(beatAt, -1, 'settleOne must beat: every member of a refused batch is carried here, and each can fail in seconds');
  assert.ok(beatAt < proveAt, 'the beat must come BEFORE the prove — beating() first beats four minutes in, which a fast failure never reaches');
});

test('every heartbeat the file sends records when it went, so the floor can trust it', () => {
  assert.match(src, /const sendBeat = \(detail\) => \{ lastBeatAt = Date\.now\(\);/);
  assert.match(src, /const beat = \(detail\) => sendBeat\(/, 'beat() must go through sendBeat, not heartbeat() directly');
  // Any heartbeat() that skips sendBeat leaves lastBeatAt stale and the floor then beats when it need not (or, worse, a
  // future path reintroduces the silent case). Only the two wrappers may call the client directly.
  const direct = src.split('\n')
    .filter((l) => /\bheartbeatIdle?\('settle'/.test(l))
    .filter((l) => !/^const sendBeatIdle? = /.test(l.trim()))
    .map((l) => l.trim());
  assert.deepEqual(direct, [], 'heartbeat(\'settle\', …) called outside sendBeat/sendBeatIdle: route it through them, or lastBeatAt goes stale and the floor beats on a loop that already has');
});

test('a working cycle that has gone quiet beats, inside the ten minutes health allows', () => {
  assert.match(src, /const BEAT_FLOOR_MS = /);
  const floor = Number(/const BEAT_FLOOR_MS = (\d+) \* 60_000/.exec(src)?.[1]);
  assert.ok(floor >= 1 && floor <= 8, `the floor must sit inside health's ten quiet minutes with room to spare, got ${floor} min`);
  assert.match(src, /else if \(Date\.now\(\) - lastBeatAt > BEAT_FLOOR_MS\) await beat\(/, 'the loop must beat on a working cycle that has not beaten within the floor');
  // The floor is the `else` of the idle branch: an idle cycle has its own beat (sendBeatIdle), and beating both would hide
  // the standing note that the short/paused relay beats instead.
  const loop = src.slice(src.indexOf('if (!worked) worked = await gasCycle();'));
  assert.ok(loop.indexOf('sendBeatIdle') < loop.indexOf('else if (Date.now() - lastBeatAt'), 'the floor belongs after the idle beat, as its else');
});

test('the note a quiet working cycle sends carries the recent failure count', () => {
  // withFailures() is what tells "up and working" from "up and failing every job" — the distinction the 17 minutes lacked.
  assert.match(src, /const beat = \(detail\) => sendBeat\(withFailures\(/);
  assert.match(src, /function noteProveFailure\(\)/);
});
