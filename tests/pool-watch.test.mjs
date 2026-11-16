// dapp/pool-watch.js, what watches a pool while a proof made against its exact reserves is being made: a move is told once, a flicker, a failed read and a hung node are not one,
// reads are paced and never overlap, and a node that keeps failing is asked more slowly.
//   node tests/pool-watch.test.mjs
import assert from 'node:assert/strict';
import { watchPool, proveAgain } from '../dapp/pool-watch.js';

// a script of answers: strings are states, 'ERR' throws, null finds no pool; after the script it repeats its last answer. `wait` is recorded and returns at once.
function rig(script, opts = {}) {
  const asked = [], waits = [];
  let i = 0, active = 0, maxActive = 0, moves = 0, clock = 0;
  const read = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setImmediate(r));
    const a = script[Math.min(i++, script.length - 1)];
    asked.push(a); active--;
    if (a === 'ERR') throw new Error('Ethereum is unreachable');
    return a;
  };
  const w = watchPool({ read, wait: async (ms) => { waits.push(ms); clock += ms; await new Promise((r) => setImmediate(r)); }, now: () => clock, onMove: () => moves++, ...opts });
  return { w, asked, waits, moves: () => moves, maxActive: () => maxActive };
}
const settle = (r) => r.w.done;

// a pool that does not change is never a move
{
  const r = rig(['A', 'A', 'A', 'A', 'A', 'A'], { lifeMs: 6 * 15e3 });
  await settle(r);
  assert.equal(r.w.moved, false); assert.equal(r.moves(), 0); assert.equal(r.w.base, 'A'); assert.ok(r.w.reads >= 5, 'it read each time round');
  assert.ok(r.waits.every((x) => x === 15e3), 'at the steady pace');
}
// a different state seen twice in a row is a move, told once, and the watch ends there
{
  const r = rig(['A', 'A', 'B', 'B', 'B', 'B']);
  await settle(r);
  assert.equal(r.w.moved, true); assert.equal(r.moves(), 1); assert.equal(r.asked.length, 4, 'ended on the second sighting');
}
// one answer that differs (a node a block behind) and then the baseline again is not a move; nor is a flicker that never repeats
{
  const r = rig(['A', 'B', 'A', 'A', 'C', 'A', 'A', 'A'], { lifeMs: 8 * 15e3 });
  await settle(r);
  assert.equal(r.w.moved, false, 'a lone different answer is not a trade'); assert.equal(r.moves(), 0);
}
// a different state each time is not "the same one each time", until one repeats
{
  const r = rig(['A', 'B', 'C', 'C']);
  await settle(r);
  assert.equal(r.w.moved, true); assert.equal(r.asked.length, 4);
}
// confirm: 1 takes the first different answer; confirm: 3 wants three
{
  const one = rig(['A', 'B', 'B'], { confirm: 1 }); await settle(one);
  assert.equal(one.w.moved, true); assert.equal(one.asked.length, 2);
  const three = rig(['A', 'B', 'B', 'B', 'B'], { confirm: 3 }); await settle(three);
  assert.equal(three.w.moved, true); assert.equal(three.asked.length, 4, 'baseline and three sightings');
}
// failed reads and a missing pool say nothing, however many, and the nodes are asked more slowly meanwhile, then at the steady pace again
{
  const r = rig(['ERR', 'ERR', 'ERR', null, 'A', 'A', 'ERR', 'ERR', 'A', 'A'], { lifeMs: 10 * 60e3, every: 10e3, slowest: 50e3 });
  await settle(r);
  assert.equal(r.w.moved, false, 'no move from errors'); assert.equal(r.moves(), 0);
  const w = r.waits;
  assert.deepEqual(w.slice(0, 4), [20e3, 40e3, 50e3, 50e3], 'doubling on each failure, up to the slowest');
  assert.deepEqual(w.slice(4, 6), [10e3, 10e3], 'and back to the steady pace at the first answer');
}
// the baseline is the first answer that comes, and a failure before it does not make one
{
  const r = rig(['ERR', 'A', 'A', 'B', 'B']);
  await settle(r);
  assert.equal(r.w.base, 'A'); assert.equal(r.w.moved, true);
}
// a pool that is not there never becomes a baseline
{
  const r = rig([null, null, 'A', 'A'], { lifeMs: 4 * 60e3, every: 1e3, slowest: 1e3 });
  await settle(r);
  assert.equal(r.w.base, 'A'); assert.equal(r.w.moved, false);
}
// reads are never asked while another is out, however slowly the node answers
{
  let active = 0, max = 0, n = 0;
  const w = watchPool({ read: async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 15)); active--; n++; return 'A'; }, wait: () => new Promise((r) => setTimeout(r, 1)), every: 0, lifeMs: 1e9 });
  await new Promise((r) => setTimeout(r, 120));
  w.stop(); await w.done;
  assert.equal(max, 1, 'one read at a time'); assert.ok(n >= 3, 'and it kept asking');
}
// a node that never answers is given up on after readMs and asked again; that is a failed read, not a move
{
  let calls = 0;
  const w = watchPool({ read: () => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve('A'); }, wait: () => new Promise((r) => setTimeout(r, 1)), readMs: 20, every: 0, lifeMs: 1e9 });
  await new Promise((r) => setTimeout(r, 150));
  w.stop(); await w.done;
  assert.ok(calls >= 2 && w.failed >= 1 && w.base === 'A' && !w.moved, `a hung read is given up on (${calls} calls, ${w.failed} failed)`);
}
// stop() ends it, and nothing is told afterwards; it also ends by itself when its life is over
{
  const r = rig(['A', 'B', 'B'], { lifeMs: 1 });
  await settle(r);
  assert.equal(r.w.moved, false, 'a watch past its life reads no more'); assert.ok(r.asked.length <= 1);
  const s = rig(['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B']); s.w.stop(); await settle(s);
  assert.equal(s.w.moved, false); assert.equal(s.moves(), 0);
}
// onMove that throws does not break the watch's end
{
  const r = rig(['A', 'B', 'B'], { onMove: () => { throw new Error('boom'); } });
  await settle(r);
  assert.equal(r.w.moved, true);
}

// ── proveAgain: one proof of an add, made again when a trade ends it ──
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
// the watch as the page makes it, only faster; `states` is what the pool reads as, one answer per read, the last one repeating
const watcher = (states) => { let i = 0; const read = async () => states[Math.min(i++, states.length - 1)]; return { read, make: (o) => watchPool({ ...o, every: 5, readMs: 200, wait: nap }) }; };
// a proof as the relay's wait goes: names its job, then pauses between the relay's answers, `pauses` of them, and is proven
const proof = (log, pauses, result = { txHash: '0xbeef' }) => async (hook) => {
  const opts = hook({ onJob: (id) => log.jobs.push(id), sleep: async () => { log.slept++; await nap(10); } });
  opts.onJob('job' + (log.jobs.length + 1));
  for (let i = 0; i < pauses; i++) await opts.sleep(1);
  log.finished++;
  return result;
};
const logOf = () => ({ jobs: [], slept: 0, finished: 0, again: [] });
{
  // a trade lands while the first is being proved: its wait ends at the next pause, not at the end, and the second is proved at once and goes through
  const log = logOf(), w = watcher(['A', 'A', 'B', 'B', 'B', 'B', 'B', 'B']);
  let n = 0, started = [];
  const r = await proveAgain({ read: w.read, watch: w.make, go: (hook) => { started.push(Date.now()); return ++n === 1 ? proof(log, 400)(hook) : proof(log, 2)(hook); }, again: (k, of, e, jobId) => log.again.push([k, of, jobId]) });
  assert.equal(r.txHash, '0xbeef'); assert.equal(n, 2, 'proved a second time');
  assert.deepEqual(log.again, [[2, 3, 'job1']], 'and said so, as the second of three tries, naming the job it gave up on'); assert.equal(log.finished, 1, 'the first never ran to its end');
  assert.ok(log.slept < 400 && log.jobs.length === 2, `the first was given up on early (${log.slept} pauses of 400)`);
}
{
  // nothing moves: one proof, no second, and the watch is over with it
  const log = logOf(), w = watcher(['A']); let made = null;
  const r = await proveAgain({ read: w.read, watch: (o) => (made = w.make(o)), go: proof(log, 4), again: () => log.again.push(1) });
  assert.equal(r.txHash, '0xbeef'); assert.equal(log.again.length, 0); assert.equal(log.jobs.length, 1);
  assert.equal(made.stopped, true, 'the watch is stopped when the proof is done');
}
{
  // a pool that keeps moving: three tries, then the give-up, and the retries were told as they went
  const log = logOf(); let reads = 0, n = 0;
  await assert.rejects(proveAgain({ read: async () => `s${reads++}`, watch: (o) => watchPool({ ...o, every: 5, confirm: 1, wait: nap }), go: (hook) => { n++; return proof(log, 400)(hook); }, again: (k, of) => log.again.push([k, of]), giveUp: () => Object.assign(new Error('kept trading'), { said: true }) }),
    (e) => e.message === 'kept trading' && e.said === true);
  assert.equal(n, 3, 'three tries in all'); assert.deepEqual(log.again, [[2, 3], [3, 3]]);
}
{
  // an error that is not the pool moving is the caller's as it is, after one try, and the watch is stopped
  const log = logOf(), w = watcher(['A']); let made = null, n = 0;
  const boom = Object.assign(new Error('prove failed: no capacity'), { code: 'prove_budget' });
  await assert.rejects(proveAgain({ read: w.read, watch: (o) => (made = w.make(o)), go: async (hook) => { n++; hook({}).onJob?.('j1'); throw boom; }, again: () => log.again.push(1) }), (e) => e === boom);
  assert.equal(n, 1); assert.equal(log.again.length, 0); assert.equal(made.stopped, true);
}
{
  // a proof that came too late (the page's own send says the pool moved, with no early flag) is tried again the same way
  const log = logOf(), w = watcher(['A']); let n = 0;
  const r = await proveAgain({ read: w.read, watch: w.make, go: async (hook) => { if (++n === 1) { hook({}).onJob?.('j1'); throw Object.assign(new Error('Nothing was sent. The pool moved while it was being proved.'), { moved: true, stale: true }); } return { txHash: '0xok' }; }, again: (k) => log.again.push(k) });
  assert.equal(r.txHash, '0xok'); assert.deepEqual(log.again, [2]);
  const none = []; let m = 0;
  await proveAgain({ read: w.read, watch: w.make, go: async () => { if (++m === 1) throw Object.assign(new Error('moved'), { moved: true }); return 1; }, again: (k, of, e, id) => none.push(id) });
  assert.deepEqual(none, [null], 'a try that sent no job names none');
}
{
  // the person has gone: the wait is not cut short by a trade, and a moved error is thrown as it is, not tried again
  const log = logOf(), w = watcher(['A', 'B', 'B', 'B']); let n = 0;
  const r = await proveAgain({ read: w.read, watch: w.make, away: () => true, go: (hook) => { n++; return proof(log, 30)(hook); }, again: () => log.again.push(1) });
  assert.equal(r.txHash, '0xbeef'); assert.equal(n, 1); assert.equal(log.finished, 1, 'run to its end');
  const e = Object.assign(new Error('moved'), { moved: true });
  await assert.rejects(proveAgain({ read: w.read, watch: w.make, away: () => true, go: async () => { throw e; } }), (x) => x === e);
}
{
  // nodes that all fail: the proof is waited for as before, to its end, and nothing is told
  const log = logOf(); let reads = 0;
  const r = await proveAgain({ read: async () => { reads++; throw new Error('Ethereum is unreachable'); }, watch: (o) => watchPool({ ...o, every: 3, slowest: 6, wait: nap }), go: proof(log, 20), again: () => log.again.push(1) });
  assert.equal(r.txHash, '0xbeef'); assert.equal(log.again.length, 0); assert.ok(reads >= 1, 'it did try the nodes');
}
{
  // the wait options the caller gave are kept: its own onJob and pause still run
  const seen = { jobs: [], paused: 0 };
  await proveAgain({ read: async () => 'A', watch: (o) => watchPool({ ...o, every: 5, wait: nap }), go: async (hook) => { const o = hook({ onJob: (id) => seen.jobs.push(id), sleep: async () => { seen.paused++; }, timeoutMs: 123 }); o.onJob('j9'); await o.sleep(1); assert.equal(o.timeoutMs, 123); return 1; } });
  assert.deepEqual(seen.jobs, ['j9']); assert.equal(seen.paused, 1);
}
console.log('pool-watch: proveAgain ok');
console.log('pool-watch: all checks passed');
