// A wait on purpose is said once, then every few minutes while it stays the same. node --test tests/quiet-log.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeQuietLog } from '../src/lib/quiet-log.js';

test('the same wait is said once, then again after the interval', () => {
  const out = []; let t = 0;
  const say = makeQuietLog((m) => out.push(m), { everyMs: 600_000, now: () => t });
  assert.equal(say('gas', 'holding 12 headers'), true);
  for (t = 60_000; t < 600_000; t += 60_000) assert.equal(say('gas', `holding ${12 + t / 60_000} headers`), false);
  t = 600_000;
  assert.equal(say('gas', 'holding 22 headers'), true);
  assert.deepEqual(out, ['holding 12 headers', 'holding 22 headers']);
});

test('a different reason is said at once, and so is the same one after the wait is over', () => {
  const out = []; let t = 0;
  const say = makeQuietLog((m) => out.push(m), { now: () => t });
  say('gas', 'a');
  t = 1000; say('funds', 'b');
  t = 2000; say('gas', 'c');
  assert.deepEqual(out, ['a', 'b', 'c'], 'each change of reason is a line');
  t = 3000; say('gas', 'd');
  assert.deepEqual(out, ['a', 'b', 'c'], 'but the same one again is not');
  say.reset();
  t = 4000; say('gas', 'e');
  assert.deepEqual(out, ['a', 'b', 'c', 'e'], 'after the wait ends, the next one is announced again');
});

test('due() says whether a line would be written, so the work to make it is only done then', () => {
  let t = 0;
  const say = makeQuietLog(() => {}, { everyMs: 600_000, now: () => t });
  assert.equal(say.due('gas'), true);
  say('gas', 'a');
  assert.equal(say.due('gas'), false);
  assert.equal(say.due('funds'), true);
  t = 600_000;
  assert.equal(say.due('gas'), true);
});
