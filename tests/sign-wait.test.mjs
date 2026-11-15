// sign-wait.js: the line a sign-in sheet shows while it waits for a wallet (the step, a plainer line after 10 s, a last one after 25 s), and a Cancel that
// ends the wait at once and tells the sign-in it was cancelled.
//   node tests/sign-wait.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body><p id="w"></p></body></html>');
globalThis.document = dom.window.document;
const { waitSay, waitLine, cancellable, stepWords, STILL, LOST, STILL_MS, LOST_MS } = await import('../dapp/sign-wait.js');

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };

function clock() {
  let t = 0, id = 0; const q = new Map();
  return { setTimer: (fn, ms) => { q.set(++id, { at: t + ms, fn }); return id; }, clearTimer: (i) => q.delete(i),
    advance(ms) { t += ms; for (const [i, x] of [...q]) if (x.at <= t) { q.delete(i); x.fn(); } } };
}

await test('the words for each step, and for the first sign-in that asks twice', () => {
  assert.equal(stepWords('account'), 'Reading your wallet…');
  assert.equal(stepWords('sign', { of: 2 }), 'Sign the message in your wallet. Step 1 of 2.');
  assert.equal(stepWords('confirm', { of: 2 }), 'Sign once more to confirm. Step 2 of 2.');
  assert.equal(stepWords('sign', { of: 1 }), 'Sign the message in your wallet.');
  assert.equal(stepWords('nothing'), null);
});
await test('a wallet that does not answer: the step, then still waiting at 10 s, then what to do at 25 s', () => {
  const c = clock(), said = [];
  const w = waitSay((t) => said.push(t), c);
  w.step('sign', { of: 1 });
  c.advance(STILL_MS - 1); assert.deepEqual(said, ['Sign the message in your wallet.']);
  c.advance(1); assert.equal(said.at(-1), STILL);
  c.advance(LOST_MS - STILL_MS); assert.equal(said.at(-1), LOST);
  assert.match(LOST, /reload this page/);
});
await test('each step starts the clock again', () => {
  const c = clock(), said = [];
  const w = waitSay((t) => said.push(t), c);
  w.step('sign', { of: 2 }); c.advance(9000); w.step('confirm', { of: 2 }); c.advance(9000);
  assert.equal(said.at(-1), 'Sign once more to confirm. Step 2 of 2.', 'nine seconds into the second step it still says the step');
  c.advance(1000); assert.equal(said.at(-1), STILL);
});
await test('once stopped it says nothing more', () => {
  const c = clock(), said = [];
  const w = waitSay((t) => said.push(t), c);
  w.step('sign'); w.stop(); c.advance(60e3); w.step('confirm');
  assert.deepEqual(said, ['Sign the message in your wallet.']);
});
await test('the line in a sheet holds the words and a Cancel link that cancels', () => {
  const el = document.getElementById('w');
  let cancelled = 0;
  const line = waitLine(el, { first: 'Reading your wallet…', cancel: () => { cancelled++; } });
  assert.equal(el.querySelector('span').textContent, 'Reading your wallet…');
  line.step('sign', { of: 1 });
  assert.equal(el.querySelector('span').textContent, 'Sign the message in your wallet.');
  el.querySelector('button').click();
  assert.equal(cancelled, 1);
  assert.equal(el.querySelector('button').textContent, 'Cancel');
  line.stop();
});
await test('cancel ends the wait at once, says it was a cancel, and tells the sign-in through its signal', async () => {
  let seen = null;
  const run = cancellable((signal) => { seen = signal; return new Promise(() => {}); });
  assert.equal(seen.aborted, false);
  run.cancel();
  await assert.rejects(run.done, (e) => e.code === 4001 && e.unlockCancelled === true && /Cancelled/.test(e.message));
  assert.equal(seen.aborted, true);
});
await test('a sign-in that finishes first is its own answer, and a cancel after it changes nothing', async () => {
  const run = cancellable(async () => 'opened');
  assert.equal(await run.done, 'opened');
  run.cancel();
});
await test('a sign-in that fails first fails the same way', async () => {
  const run = cancellable(async () => { throw new Error('wallet said no'); });
  await assert.rejects(run.done, /wallet said no/);
});

console.log(failed ? `\n${failed} failed` : '\nall sign-wait checks passed');
process.exit(failed ? 1 : 0);
