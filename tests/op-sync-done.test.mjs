// opSync (dapp/index.html) reads an action's steps to say how it went. A flow whose last step runs outside the relay's jobs (the move out of the private pool to the Tacit chain)
// has only its first job as a step, which read as "the first part went through, but the rest did not start" even after the move succeeded: such a flow marks its record `done`.
// The real source is cut out of the page and run here with stand-ins for the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ended } from '../dapp/activity.js';

const html = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
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
    for (const s of steps) actPut(s.id, { kind: 'job', status: s.status });
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

test('while the run is live it is not called failed', () => {
  const r = world({ live: true }).op([combine()]);
  assert.notEqual(r.status, 'failed');
});
