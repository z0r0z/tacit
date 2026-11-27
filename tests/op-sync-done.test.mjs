// opSync (dapp/index.html) reads an action's steps to say how it went. A flow whose last step runs outside the relay's jobs (the move out of the private pool to the Tacit chain)
// has only its first job as a step, which read as "the first part went through, but the rest did not start" even after the move succeeded: such a flow marks its record `done`.
// The real source is cut out of the page and run here with stand-ins for the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ended } from '../dapp/activity.js';
import { frontPage } from './lib/front-page.mjs';

const html = frontPage(new URL('../dapp/index.html', import.meta.url));
const okStatusLine = html.match(/^const okStatus = .*$/m)?.[0];
const start = html.indexOf('function opSync(id) {'), end = html.indexOf('\nfunction actWrite()', start);
assert.ok(okStatusLine && start > 0 && end > start, 'opSync is where this test expects it');
const source = `${okStatusLine}\n${html.slice(start, end)}\nreturn opSync;`;

function world({ live = false } = {}) {
  const items = new Map(), RUN_OF = new Map();
  const actGet = (id) => items.get(id);
  const actPut = (id, patch) => { const x = items.get(id) || {}; Object.assign(x, patch); items.set(id, x); return x; };
  const failText = (it) => it.err || 'It did not go through.';
  const noRetry = (t) => t;
  const opSync = new Function('actGet', 'actPut', 'RUN_OF', 'failText', 'noRetry', 'ended', source)(actGet, actPut, RUN_OF, failText, noRetry, ended);
  const op = (steps, extra = {}) => {
    actPut('op:1', { kind: 'op', label: 'Move 21 TAC to the Tacit chain', status: 'pending', steps: steps.map((s) => ({ id: s.id, main: !!s.main, step: s.step || null })), ...extra });
    for (const s of steps) actPut(s.id, { kind: 'job', status: s.status, ...(s.left ? { left: true } : {}) });
    RUN_OF.set('op:1', { live });
    opSync('op:1');
    return actGet('op:1');
  };
  return { op };
}
const combine = (status = 'settled') => ({ id: 'job:combine', step: 'Combine notes', status });

test('a move whose last step ran outside the relay jobs is settled when it says it is done', () => {
  const r = world().op([combine()], { done: true });
  assert.equal(r.status, 'settled');
  assert.equal(r.err, undefined);
});

test('without that, a flow that stopped after its first step still reads as half done', () => {
  const r = world().op([combine()]);
  assert.equal(r.status, 'failed');
  assert.match(r.err, /first part went through \(combine notes\), but the rest did not start/);
});

test('a settled main step settles it, with its hash', () => {
  const w = world();
  const r = w.op([combine(), { id: 'job:main', main: true, status: 'settled' }]);
  assert.equal(r.status, 'settled');
});

test('a failed step is still named, and done does not hide a stop', () => {
  assert.match(world().op([combine('failed')]).err, /Combine notes did not go through/);
  const r = world().op([combine()], { stop: 'The relay refused it.' });
  assert.equal(r.status, 'failed');
  assert.equal(r.err, 'The relay refused it.');
});

// a farm zap from a proof kept ready (or the zap's own credit, or sent first and settled by the relay): its steps are the page's transaction and the relay's jobs for the share,
// each named, so none is the main one
const zapTx = { id: 'tx:1:0xabc', step: 'Zap', status: 'confirmed' }, bondJob = { id: 'job:bond', step: 'Farm your tETH / TAC share', status: 'settled' };
test('a farm zap that went through is not read as failed when none of its steps is the main one', () => {
  const r = world().op([zapTx, bondJob]);
  assert.equal(r.status, 'failed', 'what the steps alone say: the reading the zap must head off');
  assert.match(r.err, /did not start/);
  const done = world().op([zapTx, bondJob], { done: true });
  assert.equal(done.status, 'settled');
  assert.equal(done.err, undefined);
});
test('zapFinish marks the zap’s record done once its last step has landed, and not otherwise', () => {
  const at = html.indexOf('async function zapFinish(run,'), body = html.slice(at, html.indexOf('\nasync function zapFinishSteps', at));
  assert.ok(at > 0 && /const r = await zapFinishSteps\(/.test(body), 'zapFinish is the wrapper');
  assert.match(body, /if \(r === 'done' && run\.op\) actPut\(run\.op, \{ done: true \}\);\s+return r;/, 'done only when the steps ended in done (not when the zap did not land, or has not yet)');
  const steps = html.slice(html.indexOf('async function zapFinishSteps'), html.indexOf('\nasync function stepBond'));
  assert.ok(!/done: true/.test(steps) && (steps.match(/return 'done'/g) || []).length === 3 && /return 'landing'/.test(steps) && /return 'gone'/.test(steps), 'the steps return done, landing or gone, and only done is marked');
});

test('while the run is live it is not called failed', () => {
  const r = world({ live: true }).op([combine()]);
  assert.notEqual(r.status, 'failed');
});

// a private swap the pool moved under is built again by the pool ux (route / submitWrapSwap) and each build is sent as a new main job of the same action
const swapTry = (n, status, extra = {}) => ({ id: `job:try${n}`, main: true, status, ...extra });

test('a swap refused once and settled on its rebuild reads as settled, not failed', () => {
  const r = world().op([swapTry(1, 'failed'), swapTry(2, 'settled')]);
  assert.equal(r.status, 'settled');
  assert.equal(r.err, undefined);
});

test('a swap still proving its rebuild reads as proving, not as the refusal before it', () => {
  const r = world({ live: true }).op([swapTry(1, 'failed'), swapTry(2, 'proving')]);
  assert.equal(r.status, 'proving');
});

test('a job left in the queue when its swap was built again does not hold the row open or fail it', () => {
  assert.equal(world().op([swapTry(1, 'pending', { left: true }), swapTry(2, 'settled')]).status, 'settled');
  assert.equal(world({ live: true }).op([swapTry(1, 'failed', { left: true }), swapTry(2, 'pending')]).status, 'proving');
});

test('a swap whose last build failed too still reads as failed, with that build\'s words', () => {
  const r = world().op([swapTry(1, 'failed'), swapTry(2, 'failed', {})]);
  assert.equal(r.status, 'failed');
});

test('a failed step before the swap is still named while the swap waits', () => {
  const r = world({ live: true }).op([combine('failed'), swapTry(1, 'pending')]);
  assert.equal(r.status, 'failed');
  assert.match(r.err, /Combine notes did not go through/);
});
