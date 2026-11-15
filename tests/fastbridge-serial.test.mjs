// The provider's turn-taking for sends from its own address (fastbridge-lp/lib/serial.mjs): one at a time, in order, and a failure does not stop
// the ones behind it.
//   node tests/fastbridge-serial.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeSerial } from '../fastbridge-lp/lib/serial.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

test('tasks run one at a time, in the order they were asked, and each returns its own result', async () => {
  const serial = makeSerial(), log = []; let running = 0, most = 0;
  const task = (name, ms) => serial(async () => { running++; most = Math.max(most, running); log.push('start ' + name); await tick(ms); log.push('end ' + name); running--; return name.toUpperCase(); });
  const out = await Promise.all([task('a', 20), task('b', 1), task('c', 10)]);
  assert.deepEqual(out, ['A', 'B', 'C']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'], 'a long one first does not let a short one pass it');
  assert.equal(most, 1, 'never two at once');
});

test('a task that fails fails for its caller alone: the ones behind it still run', async () => {
  const serial = makeSerial(), ran = [];
  const bad = serial(async () => { ran.push('bad'); throw new Error('the send was refused'); });
  const good = serial(async () => { ran.push('good'); return 'ok'; });
  await assert.rejects(bad, /refused/);
  assert.equal(await good, 'ok');
  assert.deepEqual(ran, ['bad', 'good']);
});

test('a task asked after the line has emptied runs at once, and a task that throws synchronously is a failure, not a stop', async () => {
  const serial = makeSerial();
  assert.equal(await serial(async () => 1), 1);
  await tick(5);
  assert.equal(await serial(async () => 2), 2);
  await assert.rejects(serial(() => { throw new Error('threw'); }), /threw/);
  assert.equal(await serial(async () => 3), 3, 'and the line goes on');
});

test('a send that takes its turn inside another that is waiting would wait for ever: the turn is taken around one send, not around a whole job', async () => {
  const serial = makeSerial();
  // the shape the daemon uses: the deposit takes a turn and is done; then, outside it, the settle takes its own
  const deposit = () => serial(async () => 'deposited');
  const settle = () => serial(async () => 'settled');
  const job = async () => { const d = await deposit(); const s = await settle(); return [d, s]; };
  const out = await Promise.race([Promise.all([job(), job()]), tick(500).then(() => 'DEADLOCK')]);
  assert.notEqual(out, 'DEADLOCK');
  assert.deepEqual(out, [['deposited', 'settled'], ['deposited', 'settled']]);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} serial checks passed`);
process.exit(process.exitCode || 0);
