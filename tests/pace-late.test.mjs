// The card's progress line when a stage runs past its usual time (dapp/activity.js makePace, dapp/index.html paceOf / paceTick / failText).
//
// 2026-11-19: a relayed settle that the network was slow to include held the card's bar near its end for minutes and the line under it said "a few seconds" the whole time (a stage
// past its estimate kept 15% of the estimate as time left); then the relay's own words, "settle accepted but never included after 3 rounds (last tip 557340642 wei)", showed in the
// card for a moment before the deposit was finished again. A stage well past its usual time now says so, and that failure has words a person can read.
//
//   node tests/pace-late.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePace } from '../dapp/activity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'dapp/index.html'), 'utf8');
let pass = 0, fail = 0;
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const between = (from, to) => { const a = page.indexOf(from), b = page.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)}`); return page.slice(a, b); };

const pace = makePace({ storage: null });
const T0 = 1_000_000_000_000;
// a job sent to the chain `sentFor` seconds ago (queue and prove behind it), the send stage live
const job = (sentFor) => ({ kind: 'job', at: T0 - 200_000, ts: { proving: T0 - 150_000, proven: T0 - sentFor * 1000 }, lane: 'board' });
const at = (it, secs) => pace.of(pace.job(it, T0 + secs * 1000 - 0));

await test('a send within its usual time is not late, and counts down', () => {
  const p = pace.of(pace.job(job(5), T0));
  ok(p.late === false, 'late too soon');
  ok(p.left > 5, `left ${p.left}`);
});

await test('a send that has run past 1.5x its usual time is late (the usual is 18 s)', () => {
  ok(pace.of(pace.job(job(26), T0)).late === false, 'late at 26 s');
  ok(pace.of(pace.job(job(28), T0)).late === true, 'not late at 28 s');
  ok(pace.of(pace.job(job(300), T0)).late === true, 'not late at 5 min');
});

await test('a stage that has finished is never the one that is late', () => {
  const done = { kind: 'job', at: T0 - 600_000, end: T0 - 1000, ts: { proving: T0 - 500_000, proven: T0 - 300_000 }, lane: 'board' };
  ok(pace.of(pace.job(done, T0)).late === false, 'a finished job was late');
});

await test('a queued job waiting longer than its usual turn is late too', () => {
  const q = { kind: 'job', at: T0 - 120_000, ts: {}, lane: 'board' };
  ok(pace.of(pace.job(q, T0)).late === true, 'a long wait in line is not late');
  ok(pace.of(pace.job({ ...q, at: T0 - 5_000 }, T0)).late === false, 'a short wait is late');
});

await test('of() passes late through and keeps the bar short of its end', () => {
  const p = pace.of({ spent: 500, left: 2.7, late: true });
  ok(p.late === true && p.pct <= 97, JSON.stringify(p));
  ok(pace.of({ spent: 1, left: 9 }).late === false, 'late without being asked');
});

await test('the card says it is taking longer than usual, and still counts down when it is not', () => {
  ok(/pc\.late \? 'taking longer than usual' : leftWords\(pc\.left\)/.test(page), 'paceTick does not use late');
  const s = between('function paceOf(it) {', 'const leftWords');
  ok(/late = late \|\| \(!ended\(x\.it\) && !!p\.late\)/.test(s) && /PACE\.of\(\{ spent, left, late \}\)/.test(s), 'an action made of several jobs does not carry late');
});

await test('"never included" and a pending-block revert read as words, not as the relay\'s log line', () => {
  const src = between('function failText(it) {', 'const txUrl');
  const failText = new Function('revertText', `${src}\nreturn failText;`)(() => null);
  for (const raw of ['settle accepted but never included after 3 rounds (last tip 557340642 wei)', 'settle reverts in the pending block']) {
    const t = failText({ status: 'failed', err: raw });
    ok(/slow to take it/.test(t) && !/wei|rounds|tip/.test(t), `said: ${t}`);
  }
  ok(/relay could not settle it/i.test(failText({ status: 'failed', err: 'settle reverted 0xabc' })), 'a real revert lost its words');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
