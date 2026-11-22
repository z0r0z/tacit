// The prover board's lock and its passes (worker/src/prover-board.js). Every post, claim, result and cancel waits behind one lock, and a pass under it used to read every
// retained job up to four times over, one after another: on 2026-11-22 (about 50 jobs retained, ~150 community machines asking) a relay post waited ~14 s at the median
// and a house worker's claim as long, so the relay's 20 s limit sent jobs to the prover network instead of the board. Now a pass reads the jobs in one round, and the
// relay's calls go ahead of the community's asks that are waiting (a community ask that has waited long enough goes first, so none starves).
//   node --test tests/prover-board-lock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardLock, makeProverBoard } from '../worker/src/prover-board.js';

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const stdin = (n) => Buffer.from(`program input ${n}`).toString('base64');
const T0 = 2_000_000;

test('lock: one at a time; an urgent call goes ahead of the asks waiting; each class keeps its order', async () => {
  const lock = makeBoardLock({ agingMs: 1e9 });
  let inside = 0, peak = 0; const done = [];
  const job = (name, opts, ms = 5) => lock(async () => { inside++; peak = Math.max(peak, inside); await nap(ms); inside--; done.push(name); return name; }, opts);
  const all = [job('c1', {}, 20), job('c2', {}), job('c3', {}), job('u1', { first: true }), job('u2', { first: true }), job('c4', {})];
  assert.deepEqual(await Promise.all(all), ['c1', 'c2', 'c3', 'u1', 'u2', 'c4']);
  assert.equal(peak, 1, 'two calls were inside at once');
  assert.deepEqual(done, ['c1', 'u1', 'u2', 'c2', 'c3', 'c4'], 'c1 was already running; then the urgent ones in order, then the asks in order');
});

test('lock: an ask that has waited agingMs is taken before the urgent calls, so a steady stream of urgent calls cannot starve it', async () => {
  let clock = 0;
  const lock = makeBoardLock({ agingMs: 1000, now: () => clock });
  const done = [];
  const hold = lock(async () => { await nap(10); done.push('first'); });
  const old = lock(async () => { done.push('old-ask'); });
  clock = 1500;                                                    // the ask has now waited past agingMs
  const urgent = [lock(async () => { done.push('u1'); }, { first: true }), lock(async () => { done.push('u2'); }, { first: true })];
  await Promise.all([hold, old, ...urgent]);
  assert.deepEqual(done, ['first', 'old-ask', 'u1', 'u2']);
});

test('lock: a call that throws frees the lock, and its error reaches its own caller only', async () => {
  const lock = makeBoardLock();
  const bad = lock(async () => { throw new Error('boom'); }, { first: true });
  const good = lock(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  assert.equal(await lock(async () => 'again', { first: true }), 'again');
});

// A store that counts reads, holds each for a moment, and notes how many were in flight together.
function slowStore(latency = 3) {
  const jobs = new Map(); let pend = [], workers = {}, trouble = {};
  const s = { reads: 0, inFlight: 0, peak: 0 };
  return Object.assign(s, {
    seed(list) { for (const j of list) jobs.set(j.id, j); pend = list.map((j) => j.id); },
    getPending: async () => pend.slice(), putPending: async (ids) => { pend = ids.slice(); },
    getJob: async (id) => { s.reads++; s.inFlight++; s.peak = Math.max(s.peak, s.inFlight); await nap(latency); s.inFlight--; const j = jobs.get(id); return j ? JSON.parse(JSON.stringify(j)) : null; },
    putJob: async (id, j) => { jobs.set(id, JSON.parse(JSON.stringify(j))); }, deleteJob: async (id) => { jobs.delete(id); pend = pend.filter((x) => x !== id); },
    getWorkers: async () => ({ ...workers }), putWorkers: async (w) => { workers = { ...w }; },
    getTrouble: async () => ({ ...trouble }), putTrouble: async (x) => { trouble = { ...x }; },
    getDay: async () => null, putDay: async () => {},
  });
}
const seedJobs = (n, status = 'proved') => Array.from({ length: n }, (_, i) => ({ id: `job${i}`, class: 'private', program: 'confidential', mode: 'groth16', stdin: null, sealed: null, cycleLimit: 1, gasLimit: 1, deadline: T0 / 1000 + 3600,
  status, postedAt: T0 - 60_000, claimedAt: T0 - 50_000, endedAt: T0 - 10_000, worker: 'tacit-a5000', leaseUntil: 0, lapsed: 0, publicValues: null, proof: null, error: null }));
const house = { name: 'tacit-a5000', classes: ['private', 'public'] };

test('a house worker\'s claim reads each retained job once, in rounds, not one after another four times over', async () => {
  const st = slowStore(), N = 48; st.seed(seedJobs(N));
  const b = makeProverBoard({ storage: st, now: () => T0 });
  assert.equal(await b.claim({ worker: house, classes: ['private', 'public'] }), null, 'nothing is queued');
  assert.ok(st.reads <= N + 2, `${st.reads} reads for ${N} jobs (before: about ${4 * N})`);
  assert.ok(st.peak > 1, 'the reads were one after another');
  assert.ok(st.peak <= 16, `${st.peak} reads at once: the pool behind the store would be taken`);
});

test('a community ask and the public summary read the list in one round too', async () => {
  const st = slowStore(), N = 48; st.seed(seedJobs(N));
  const b = makeProverBoard({ storage: st, now: () => T0 });
  await b.claim({ worker: { name: 'c-0x01', classes: ['public'], community: true, client: 'x' }, classes: ['public'] });
  assert.ok(st.reads <= N + 2, `community ask: ${st.reads} reads for ${N} jobs`);
  st.reads = 0; st.peak = 0;
  const sum = await b.summary();
  assert.equal(sum.proved, N);
  assert.ok(st.reads <= N + 1 && st.peak > 1, `summary: ${st.reads} reads, ${st.peak} at once`);
});

test('a relay post is not left at the back of the line behind community machines asking', async () => {
  const st = slowStore(2); st.seed(seedJobs(30));
  const lock = makeBoardLock();
  const b = makeProverBoard({ storage: st, now: () => T0, lock });
  const finished = [];
  const asks = Array.from({ length: 14 }, (_, i) => b.claim({ worker: { name: `c-0x${i}`, classes: ['public'], community: true, client: `x${i}` }, classes: ['public'] }).then(() => finished.push(`ask${i}`)));
  await nap(1);
  const post = b.post({ class: 'private', stdin: stdin(1), cycleLimit: 1e6, gasLimit: 1e8, deadline: T0 / 1000 + 600 }).then(() => finished.push('POST'));
  await Promise.all([...asks, post]);
  const at = finished.indexOf('POST');
  assert.ok(at >= 0 && at <= 4, `the post finished ${at + 1}th of ${finished.length}: ${finished.join(' ')}`);
});

test('the board still answers correctly: a queued job goes to the worker that may have it, once', async () => {
  const st = slowStore(1); st.seed(seedJobs(5));
  const b = makeProverBoard({ storage: st, now: () => T0, lock: makeBoardLock() });
  const { jobId } = await b.post({ class: 'private', stdin: stdin(7), cycleLimit: 1e6, gasLimit: 1e8, deadline: T0 / 1000 + 600 });
  const [a, c] = await Promise.all([b.claim({ worker: house, classes: ['private', 'public'] }), b.claim({ worker: { name: 'tacit-b5000', classes: ['private', 'public'] }, classes: ['private', 'public'] })]);
  const got = [a, c].filter(Boolean);
  assert.equal(got.length, 1, 'one job, one claimer');
  assert.equal(got[0].jobId, jobId);
});
