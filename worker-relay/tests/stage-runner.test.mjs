// One stage that hangs does not freeze the others: it is left running and skipped on later turns until it ends, a stage that finishes in time returns or
// throws as it would have, a stage that fails after the loop went on is logged, and stages are independent of each other.
// Run: node --test tests/stage-runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStageRunner } from '../src/lib/stage-runner.js';

const rig = (budgetMs = 40) => { const said = []; return { said, run: makeStageRunner({ budgetMs, log: (...a) => said.push(a.join(' ')) }) }; };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

test('a stage that finishes in time returns its value or throws its error, as it would have', async () => {
  const { run, said } = rig();
  assert.deepEqual(await run('scan', async () => 7), { value: 7 });
  await assert.rejects(run('scan', async () => { throw new Error('blockscout address-logs 500'); }), /address-logs 500/);
  await assert.rejects(run('scan', () => { throw new Error('thrown at once'); }), /thrown at once/);
  assert.deepEqual(said, [], 'nothing said about stages that were on time');
  assert.deepEqual(await run('scan', async () => 'again'), { value: 'again' }, 'a failed stage runs again on its next turn');
});

test('a stage that hangs is left running, the loop goes on, and its next turns are skipped until it ends', async () => {
  const { run, said } = rig(30);
  const hung = deferred(); let starts = 0;
  const r1 = await run('weiname', () => { starts++; return hung.p; });
  assert.deepEqual(r1, { late: true });
  assert.match(said[0], /stage "weiname" has run past/);
  assert.deepEqual(await run('weiname', () => { starts++; return Promise.resolve(1); }), { skipped: true });
  assert.deepEqual(await run('weiname', () => { starts++; return Promise.resolve(1); }), { skipped: true });
  assert.equal(starts, 1, 'a second run of the same stage never started beside the first');
  assert.equal(said.filter((m) => /still running/.test(m)).length, 1, 'said once, not every turn');
  hung.resolve('done late');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await run('weiname', async () => 'fresh'), { value: 'fresh' }, 'once it has ended the stage runs again');
});

test('other stages are not held up by the one that hangs', async () => {
  const { run } = rig(30);
  const hung = deferred();
  await run('pm', () => hung.p);
  const t0 = Date.now();
  assert.deepEqual(await run('settle', async () => 'paid'), { value: 'paid' });
  assert.deepEqual(await run('campaigns', async () => 'credited'), { value: 'credited' });
  assert.ok(Date.now() - t0 < 25, 'the stages behind it ran at once');
  hung.resolve();
});

test('a stage that fails after the loop went on is logged, not left unhandled', async () => {
  const { run, said } = rig(20);
  const hung = deferred();
  await run('ce', () => hung.p);
  hung.reject(new Error('explorer 500'));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(said.some((m) => /stage "ce" failed after the loop went on: explorer 500/.test(m)), said.join(' | '));
});

test('a budget of 0 waits for the stage, as before', async () => {
  const { run } = rig(0);
  const slow = deferred(); setTimeout(() => slow.resolve('late but waited for'), 25);
  assert.deepEqual(await run('scan', () => slow.p), { value: 'late but waited for' });
});
