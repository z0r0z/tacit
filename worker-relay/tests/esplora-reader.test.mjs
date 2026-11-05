// The header feeder's explorer reader: a rate-limited explorer is left alone for what it asks, the last good one goes first, a 404 is not a limit,
// and an explorer that limits every source costs one request each, not a burst. node --test tests/esplora-reader.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEsploraReader } from '../src/lib/esplora-reader.js';

const A = 'https://a.example/api', B = 'https://b.example/api', C = 'https://c.example/api';
// A scripted explorer set: `plan[base]` is a list of answers, the last one repeating. An answer is a status, 'net' (a thrown network error) or { status, retryAfter }.
function world(plan) {
  const calls = [], idx = {};
  const fetchImpl = async (url) => {
    const base = Object.keys(plan).find((b) => url.startsWith(b));
    calls.push(base + url.slice(base.length));
    const i = idx[base] = (idx[base] ?? -1) + 1;
    const step = plan[base][Math.min(i, plan[base].length - 1)];
    if (step === 'net') throw new Error('fetch failed');
    const status = typeof step === 'object' ? step.status : step;
    const headers = new Map(typeof step === 'object' && step.retryAfter != null ? [['retry-after', String(step.retryAfter)]] : []);
    return { ok: status === 200, status, headers, text: async () => ' 974676\n' };
  };
  let t = 1_000_000;
  const slept = [];
  return { calls, fetchImpl, now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}
const reader = (w, plan, opts = {}) => makeEsploraReader(Object.keys(plan), { fetchImpl: w.fetchImpl, now: w.now, sleep: w.sleep, ...opts });

test('a healthy explorer answers once, the answer is trimmed, and the next read starts at it', async () => {
  const plan = { [A]: [200], [B]: [200] }, w = world(plan), r = reader(w, plan);
  assert.equal(await r.get('/blocks/tip/height'), '974676');
  assert.deepEqual(w.calls, [A + '/blocks/tip/height']);
});

test('one that answers 429 rests for its Retry-After, the next explorer answers, and the resting one is not asked again until it is over', async () => {
  const plan = { [A]: [{ status: 429, retryAfter: 90 }, 200], [B]: [200] }, w = world(plan), r = reader(w, plan);
  assert.equal(await r.get('/x'), '974676');
  assert.deepEqual(w.calls, [A + '/x', B + '/x'], 'A said no, B answered');
  await r.get('/y'); await r.get('/z');
  assert.deepEqual(w.calls.slice(2), [B + '/y', B + '/z'], 'B is the last good one and A is resting: A is not asked');
  w.advance(91_000);
  assert.ok(r.state().every((s) => s.restingFor === 0), 'A has rested its 90 s');
  assert.equal(await r.get('/after'), '974676');
  assert.equal(w.calls[w.calls.length - 1], B + '/after', 'but the last good explorer still goes first');
});

test('without a Retry-After a rate limit rests the source 60 s while the others go on answering', async () => {
  const plan = { [A]: [429], [B]: [200] }, w = world(plan), r = reader(w, plan);
  await r.get('/x');
  assert.equal(r.state().find((s) => s.base === A).restingFor, 60_000);
  assert.equal(r.state().find((s) => s.base === B).restingFor, 0);
});

test('the rest doubles on each answer in a row and is capped at ten minutes', async () => {
  // only A: every read asks it as soon as it has rested
  const plan = { [A]: [429] }, w = world(plan), r = reader(w, plan, { maxWaitMs: 0 });
  const rests = [];
  for (let n = 0; n < 6; n++) {
    await assert.rejects(r.get('/x'), /^Error: esplora \/x: 429/);
    rests.push(r.state()[0].restingFor);
    w.advance(r.state()[0].restingFor + 1);
  }
  assert.deepEqual(rests, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
});

test('every explorer rate-limiting costs one request each, and the next read at once costs none', async () => {
  const plan = { [A]: [429], [B]: [429], [C]: [429] }, w = world(plan), r = reader(w, plan, { maxWaitMs: 0 });
  await assert.rejects(r.get('/blocks/tip/height'), (e) => /^esplora \/blocks\/tip\/height: 429$/.test(e.message));
  assert.equal(w.calls.length, 3, 'one pass, not nine requests');
  await assert.rejects(r.get('/blocks/tip/height'), /^Error: esplora \/blocks\/tip\/height: 429 \(every explorer is resting\)$/);
  assert.equal(w.calls.length, 3, 'all resting: no request was made');
});

test('when every explorer is resting and the soonest is close, it waits for that one and asks it', async () => {
  const plan = { [A]: [{ status: 429, retryAfter: 5 }, 200], [B]: [{ status: 429, retryAfter: 30 }] }, w = world(plan), r = reader(w, plan);
  await assert.rejects(r.get('/x'), /429/);                       // both rest: A 5 s, B 30 s
  assert.equal(await r.get('/x'), '974676', 'A rests 5 s, within the 20 s it may wait');
  assert.deepEqual(w.slept.map((ms) => Math.round(ms / 1000)), [5]);
});

test('a 404 is not a rate limit: the next explorer is asked, nothing rests, and all of them 404 is a 404', async () => {
  const plan = { [A]: [404], [B]: [200] }, w = world(plan), r = reader(w, plan);
  assert.equal(await r.get('/block-height/974677'), '974676');
  assert.ok(r.state().every((s) => s.restingFor === 0 && s.streak === 0), 'A is not resting');
  const p2 = { [A]: [404], [B]: [404] }, w2 = world(p2), r2 = reader(w2, p2);
  await assert.rejects(r2.get('/block-height/999999999'), /^Error: esplora \/block-height\/999999999: 404$/);
  assert.ok(r2.state().every((s) => s.restingFor === 0), 'neither rests');
});

test('a network error or a 5xx rests the source briefly (15 s) and the next one answers', async () => {
  const plan = { [A]: ['net'], [B]: [502], [C]: [200] }, w = world(plan), r = reader(w, plan);
  assert.equal(await r.get('/x'), '974676');
  assert.deepEqual(r.state().map((s) => s.restingFor), [15_000, 15_000, 0]);
});

test('an error keeps the shape the feeder recognises as a wait (esplora <path>: …), and a success clears the streak', async () => {
  const plan = { [A]: [429, 429, 200] }, w = world(plan), r = reader(w, plan, { maxWaitMs: 0 });
  await assert.rejects(r.get('/x'), (e) => /^esplora /.test(e.message));
  w.advance(60_001); await assert.rejects(r.get('/x'), /429/);
  assert.equal(r.state()[0].streak, 2);
  w.advance(120_001); assert.equal(await r.get('/x'), '974676');
  assert.equal(r.state()[0].streak, 0);
});

test('bases are trimmed of a trailing slash, and an empty list is refused', async () => {
  const w = world({ 'https://a.example/api': [200] });
  const r = makeEsploraReader(['https://a.example/api/ '], { fetchImpl: w.fetchImpl });
  await r.get('/blocks/tip/height');
  assert.equal(w.calls[0], 'https://a.example/api/blocks/tip/height');
  assert.throws(() => makeEsploraReader([' ', ''], {}), /no explorer bases/);
});
