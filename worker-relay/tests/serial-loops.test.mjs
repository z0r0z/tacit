// lib/serial.js and lib/worker-loops.js: the two pieces that let the settle relay run its loop more than once (SETTLE_CONCURRENCY) without two
// sends sharing a nonce, two fallback proofs sharing a file, or a stop cutting a job off.
//   node --test worker-relay/tests/serial-loops.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSerial } from '../src/lib/serial.js';
import { runLoops } from '../src/lib/worker-loops.js';

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

test('turns never overlap, and go in the order asked', async () => {
  const s = makeSerial();
  let inside = 0, max = 0;
  const order = [];
  const job = (name, ms) => s.run(async () => { inside++; max = Math.max(max, inside); order.push(`+${name}`); await nap(ms); order.push(`-${name}`); inside--; return name; });
  const out = await Promise.all([job('a', 30), job('b', 5), job('c', 10)]);
  assert.deepEqual(out, ['a', 'b', 'c']);
  assert.equal(max, 1, 'two turns were inside at once');
  assert.deepEqual(order, ['+a', '-a', '+b', '-b', '+c', '-c']);
});

test('a turn that throws frees the next one, and its error reaches its own caller only', async () => {
  const s = makeSerial();
  const a = s.run(async () => { await nap(5); throw new Error('boom'); });
  const b = s.run(async () => 'ok');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
  assert.equal(await s.run(async () => 'still works'), 'still works');
});

test('acquire/release: the turn is held until released, and releasing twice is harmless', async () => {
  const s = makeSerial();
  const first = await s.acquire();
  let got = false;
  const second = s.acquire().then((done) => { got = true; return done; });
  await nap(15);
  assert.equal(got, false, 'the second turn started while the first was held');
  first(); first();
  const done = await second;
  assert.equal(got, true);
  done();
  assert.equal(await s.run(async () => 1), 1);
});

test('runLoops: count loops run side by side; stopping lets each finish its pass, and stopped() runs once, last', async () => {
  let stop = false, passes = 0, inFlight = 0, peak = 0, stoppedCalls = 0, finishedBeforeStop = 0;
  const step = async (i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await nap(20 + i * 10);
    passes++; inFlight--; finishedBeforeStop++;
    if (passes >= 4) stop = true;
  };
  await runLoops({ count: 2, step, stopping: () => stop, stopped: async () => { stoppedCalls++; assert.equal(inFlight, 0, 'stopped() ran with a pass still in flight'); } });
  assert.equal(peak, 2, 'the two loops never overlapped');
  assert.equal(stoppedCalls, 1);
  assert.ok(passes >= 4);
});

test('runLoops: one loop (the default) behaves as the old loop: step, step, stop', async () => {
  let stop = false, n = 0, stoppedCalls = 0;
  await runLoops({ step: async () => { n++; if (n === 3) stop = true; }, stopping: () => stop, stopped: async () => { stoppedCalls++; } });
  assert.equal(n, 3); assert.equal(stoppedCalls, 1);
});

test('runLoops: a count that is not a number or is below 1 runs one loop', async () => {
  for (const count of [0, -3, NaN, undefined, 'x']) {
    let stop = false, n = 0;
    await runLoops({ count, step: async () => { n++; stop = true; }, stopping: () => stop, stopped: async () => {} });
    assert.equal(n, 1, `count=${String(count)}`);
  }
});
