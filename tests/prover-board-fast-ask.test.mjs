// A community machine's ask for work is answered without the board's lock when a recent look at the open jobs shows none it could race
// (worker/src/prover-board.js). Same answers as asking through the lock; nothing read or written for the ask; a job posted through the same
// storage is raced at once, one written by another process within communityViewMs; sightings stay visible. Run: node --test tests/prover-board-fast-ask.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProverBoard, buildProverBoard, newBoardMemory, PROVER_BOARD } from '../worker/src/prover-board.js';

let t = 5_000_000;
const now = () => t;
const tacit = { name: 'tacit-a5000', classes: ['private', 'public'] };
const miner = (i) => ({ name: 'c-0x' + i.toString(16).padStart(40, '0'), classes: ['public'], community: true, client: 'k' + (i % 5) });
const ask = (b, w) => b.claim({ worker: w, classes: ['public'] });
let n = 0;
const pubJob = (b, secs = 600) => b.post({ class: 'public', stdin: Buffer.from(`wrap ${++n}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(t / 1000) + secs });
const privJob = (b) => b.post({ class: 'private', stdin: Buffer.from(`witness ${++n}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(t / 1000) + 600 });
const slow = { ...PROVER_BOARD, communityFast: 0 };

// An in-memory storage that counts every call.
function memStore() {
  const jobs = new Map(), days = new Map();
  let pend = [], ws = {}, trouble = {};
  const calls = { n: 0 };
  const c = (f, name = f.name) => (...a) => { calls.n++; if (calls.log) calls.log.push(name); return f(...a); };
  return {
    calls,
    getDay: c(async (d) => (days.has(d) ? JSON.parse(days.get(d)) : null)), putDay: c(async (d, r) => { days.set(d, JSON.stringify(r)); }),
    getPending: c(async () => pend.slice()), putPending: c(async (ids) => { pend = ids.slice(); }),
    getJob: c(async (id) => (jobs.has(id) ? JSON.parse(jobs.get(id)) : null)), putJob: c(async (id, j) => { jobs.set(id, JSON.stringify(j)); }), deleteJob: c(async (id) => { jobs.delete(id); }),
    getWorkers: c(async () => JSON.parse(JSON.stringify(ws))), putWorkers: c(async (x) => { ws = JSON.parse(JSON.stringify(x)); }),
    getTrouble: c(async () => ({ ...trouble })), putTrouble: c(async (x) => { trouble = { ...x }; }),
    rawWorkers: () => JSON.parse(JSON.stringify(ws)),
    dump: () => ({ pending: pend.slice(), jobs: Object.fromEntries([...jobs].map(([k, v]) => { const j = JSON.parse(v); return [k, { status: j.status, class: j.class, program: j.program, worker: j.worker, racers: j.racers, raced: j.raced, drawPick: j.drawPick, drawn: j.drawn, drawOpen: j.drawOpen, postedAt: j.postedAt, deadline: j.deadline, leaseUntil: j.leaseUntil, sealed: !!j.sealed }]; })) }),
  };
}
const spyLock = () => {
  let tail = Promise.resolve();
  const f = (fn) => { f.count++; const p = tail.then(fn, fn); tail = p.then(() => {}, () => {}); return p; };
  f.count = 0;
  return f;
};

test('an ask with nothing to race reads and writes nothing and does not take the lock', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const [a, c] = [miner(1), miner(2)];
  assert.equal(await ask(b, a), null);
  assert.equal(await ask(b, c), null);
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 100; i++) assert.equal(await ask(b, i % 2 ? a : c), null);
  assert.equal(st.calls.n, before.calls, 'no storage call for 100 asks');
  assert.equal(lock.count, before.locks, 'no lock taken for 100 asks');
});

test('the house worker asking again, with nothing changed, does not spoil the look', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const a = miner(10);
  await privJob(b);                                                              // a private job: nothing for a community machine
  assert.equal(await ask(b, a), null); assert.equal(await ask(b, a), null);
  const house = () => b.claim({ worker: { ...tacit, name: 'tacit-b5000' }, classes: ['public'] });   // asks for the public class only: takes nothing
  assert.equal(await house(), null); assert.equal(await house(), null);
  const before = st.calls.n;
  for (let i = 0; i < 10; i++) { assert.equal(await ask(b, a), null); assert.equal(await house(), null); }
  assert.equal(st.calls.n - before > 0, true, 'the house worker\'s own asks read and write');
  const c0 = st.calls.n;
  for (let i = 0; i < 10; i++) assert.equal(await ask(b, a), null);
  assert.equal(st.calls.n, c0, 'community asks after the house worker\'s still cost nothing');
});

test('a job posted through the same storage is raced by the very next ask', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const a = miner(3);
  assert.equal(await ask(b, a), null);
  assert.equal(await ask(b, a), null);
  const posted = await pubJob(b);
  const j = await ask(b, a);
  assert.ok(j, 'the posted job is offered at once');
  assert.equal(j.jobId, posted.jobId); assert.equal(j.race, true);
});

test('a job written by another process is raced within communityViewMs', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock() });
  const other = makeProverBoard({ storage: st, now, lock: spyLock() });         // another process: its own memory and lock, the same storage
  const a = miner(4);
  assert.equal(await ask(b, a), null); assert.equal(await ask(b, a), null);
  const posted = await pubJob(other);
  t += PROVER_BOARD.communityViewMs;
  const j = await ask(b, a);
  assert.ok(j && j.jobId === posted.jobId, 'seen once the look has aged out');
});

test('machines that cannot race a job get nothing without the lock: racing it already, or the race is full', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const posted = await pubJob(b);
  const racers = Array.from({ length: PROVER_BOARD.communityRacers }, (_, i) => miner(100 + i));
  for (const r of racers) assert.equal((await ask(b, r)).jobId, posted.jobId);
  assert.equal(await ask(b, racers[0]), null, 'racing it already');
  const late = miner(200);
  assert.equal(await ask(b, late), null, 'the race is full');
  assert.equal(await ask(b, late), null);
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 20; i++) { assert.equal(await ask(b, late), null); assert.equal(await ask(b, racers[1]), null); }
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
});

test('a machine racing one job is offered no other, and its asks cost nothing while another job waits', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const m = miner(20);
  const first = await pubJob(b), second = await pubJob(b);
  assert.equal((await ask(b, m)).jobId, first.jobId);
  assert.equal(await ask(b, m), null); assert.equal(await ask(b, m), null);       // one race at a time: the second job is not offered
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 20; i++) assert.equal(await ask(b, m), null);
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
  assert.ok(second.jobId);
});

test('a machine that does not race a job\'s program is not held up by it: its asks cost nothing while one is open', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const m = miner(21);
  await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('a block').toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 900 });
  const onlyWraps = () => b.claim({ worker: m, classes: ['public'], programs: ['confidential'] });
  assert.equal(await onlyWraps(), null); assert.equal(await onlyWraps(), null);
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 20; i++) assert.equal(await onlyWraps(), null);
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
  assert.ok((await b.claim({ worker: m, classes: ['public'], programs: ['confidential', 'tacit-block'] })), 'and a machine that does race blocks is offered it');
});

test('the names of machines already seen are bounded', async () => {
  const memory = newBoardMemory();
  const b = makeProverBoard({ storage: memStore(), now, lock: spyLock(), memory });
  for (let i = 0; i < 5200; i++) await ask(b, miner(100_000 + i));
  assert.ok(memory.known.size <= 5000, `names kept: ${memory.known.size}`);
});

test('the racers a look kept are counted as of now: once their leases lapse a machine is offered the job', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), cfg: { ...PROVER_BOARD, communityViewMs: 3_600_000 } });
  const posted = await pubJob(b, 3600);
  for (let i = 0; i < PROVER_BOARD.communityRacers; i++) await ask(b, miner(300 + i));
  const late = miner(399);
  assert.equal(await ask(b, late), null); assert.equal(await ask(b, late), null);
  t += PROVER_BOARD.leaseMs + 1;                                                 // the look is still "fresh" (an hour), the racers' leases are not
  const j = await ask(b, late);
  assert.ok(j && j.jobId === posted.jobId, 'offered the job although the look is younger than its window');
});

test('sightings stay visible without being written: the summary, the first ask, and the write every communityFlushMs', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock() });
  const a = miner(5);
  await ask(b, a);
  assert.equal(st.rawWorkers()[a.name].lastSeen, t, 'a first ask is written at once');
  t += 2000;
  for (let i = 0; i < 5; i++) await ask(b, a);
  assert.equal(st.rawWorkers()[a.name].lastSeen, t - 2000, 'later asks inside the window are not written');
  let w = (await b.summary()).workers.find((x) => x.name === a.name);
  assert.equal(w.lastSeenSeconds, 0, 'but the summary reads the latest sighting');
  t += PROVER_BOARD.communityFlushMs;
  await ask(b, a);
  assert.equal(st.rawWorkers()[a.name].lastSeen, t, 'written again once the window has passed');
  assert.deepEqual(st.rawWorkers()[a.name].programs, ['confidential']);
  assert.ok(st.rawWorkers()[a.name].offered.confidential > 0);
});

test('a machine\'s first ask is written at once even while a look stands and the periodic write is not due', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock() });
  const [a, c] = [miner(13), miner(14)];
  await ask(b, a); await ask(b, a);                                              // a look stands, a write has just been made
  assert.equal(await ask(b, c), null);
  assert.ok(st.rawWorkers()[c.name], 'the second machine\'s record is in storage after its first ask');
  assert.equal(st.rawWorkers()[c.name].lastSeen, t);
});

test('a machine that raced a job and dropped out is not offered it again, and its asks then cost nothing', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const m = miner(15);
  const posted = await pubJob(b);
  assert.equal((await ask(b, m)).jobId, posted.jobId);
  await b.result({ worker: m, jobId: posted.jobId, publicValues: '0x' + '33'.repeat(64), proof: '0x' + '44'.repeat(260) });
  await b.raceVerdict({ jobId: posted.jobId, worker: m.name, ok: false });         // its candidate was refused: it is no longer racing, and has raced the job
  assert.equal(await ask(b, m), null); assert.equal(await ask(b, m), null);
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 20; i++) assert.equal(await ask(b, m), null);
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
});

test('a machine seen only by the fast ask still holds off the house worker for a fresh job (first pick)', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock() });
  const a = miner(6);
  await ask(b, a); await ask(b, a); await ask(b, a);
  const posted = await pubJob(b);
  assert.equal(await b.claim({ worker: tacit, classes: ['private', 'public'] }), null, 'the community has first pick');
  assert.equal((await ask(b, a)).jobId, posted.jobId);
});

test('built for every request the way production builds it, the state still carries from one request to the next', async () => {
  const kv = new Map(); let ops = 0;
  const KV = { get: async (k) => { ops++; return kv.has(k) ? kv.get(k) : null; }, put: async (k, v) => { ops++; kv.set(k, v); }, delete: async (k) => { ops++; kv.delete(k); } };
  const env = { REGISTRY_KV: KV, PROVER_BOARD_VIEW_MS: '60000' };
  const request = (w) => buildProverBoard(env).claim({ worker: w, classes: ['public'] });
  const a = miner(7), c = miner(8);
  assert.equal(await request(a), null); assert.equal(await request(c), null);
  assert.equal(await request(a), null);
  const before = ops;
  for (let i = 0; i < 30; i++) { assert.equal(await request(a), null); assert.equal(await request(c), null); }
  assert.equal(ops, before, 'no storage read or write for 60 asks across 60 boards');
  const posted = await buildProverBoard(env).post({ class: 'public', stdin: Buffer.from('built per request').toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await request(a)).jobId, posted.jobId, 'a job posted by one request is raced by the next');
  // a board that was not given the shared memory still answers correctly
  const fresh = (w) => makeProverBoard({ storage: memStore(), now }).claim({ worker: w, classes: ['public'] });
  assert.equal(await fresh(a), null); assert.equal(await fresh(a), null);
});

test('PROVER_BOARD_COMMUNITY_FAST=0 sends every ask through the lock and writes it, as before', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock, cfg: slow });
  const a = miner(9);
  for (let i = 0; i < 10; i++) assert.equal(await ask(b, a), null);
  assert.equal(lock.count, 10);
  assert.ok(st.calls.n >= 10);
  const env = { REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} }, PROVER_BOARD_COMMUNITY_FAST: '0' };
  const lockless = buildProverBoard(env);
  assert.equal(await ask(lockless, a), null);
});

test('a job past its deadline does not keep a machine busy: the look still lists it, the machine is offered the next job', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), cfg: { ...PROVER_BOARD, communityViewMs: 3_600_000 } });
  const a = miner(11);
  const first = await pubJob(b, 30), second = await pubJob(b, 3600);
  assert.equal((await ask(b, a)).jobId, first.jobId);
  assert.equal(await ask(b, a), null, 'racing one job, nothing else is offered');
  assert.equal(await ask(b, a), null);
  t += 31_000;                                                                   // the first job's deadline passes inside the look's window
  const j = await ask(b, a);
  assert.ok(j && j.jobId === second.jobId, 'free of the expired job, the machine is offered the next');
});

test('a claim lease that ends inside a look is swept by the next ask, as the lock would: the job is open again', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), cfg: { ...PROVER_BOARD, communityViewMs: 3_600_000 } });
  const a = miner(12);
  const posted = await pubJob(b, 3600);
  const held = await b.claim({ worker: tacit, classes: ['private', 'public'] });
  assert.equal(held.jobId, posted.jobId);
  assert.equal((await ask(b, a)).jobId, posted.jobId, 'a community machine joins the race for a job the house holds');
  assert.equal(await ask(b, a), null);                                             // racing one job: a look is made
  assert.equal(await ask(b, a), null);
  assert.equal(st.dump().jobs[posted.jobId].status, 'claimed');
  t += PROVER_BOARD.leaseMs + 1;                                                   // the house worker's lease ends inside the look's window
  await ask(b, a);
  const j = st.dump().jobs[posted.jobId];
  assert.equal(j.status, 'queued', 'swept: the job is not left claimed past its lease');
  assert.equal(j.worker, null, 'the lapsed claim is let go');
});

test('a block held for its draw: the machines not drawn, and then everyone while the drawn one proves it, are told nothing without the lock', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock, cfg: { ...PROVER_BOARD, drawPct: 100 } });
  const ms = Array.from({ length: 12 }, (_, i) => miner(40_000 + i));
  const askAll = (w, programs = EVERY) => b.claim({ worker: w, classes: ['public'], programs });
  for (const m of ms) await askAll(m);                                           // each machine's first ask: all are fresh
  const rec = st.rawWorkers(); for (const m of ms) Object.assign(rec[m.name], { proved: 3, blocks: 4, blockSecs: 30 }); await st.putWorkers(rec);   // each has a block record, so can be drawn
  const posted = await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('a block').toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 900 });
  const first = await askAll(ms[0]);                                             // the first ask after the post makes the draw
  const pick = st.dump().jobs[posted.jobId].drawPick;
  assert.ok(pick, 'a machine was drawn');
  const others = ms.filter((m) => m.name !== pick);
  for (const m of others) assert.equal(await askAll(m), null, 'a machine not drawn is offered nothing');
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 5; i++) for (const m of others) assert.equal(await askAll(m), null);
  assert.equal(st.calls.n, before.calls, 'and its asks read and write nothing'); assert.equal(lock.count, before.locks);
  assert.ok(first === null || first.jobId === posted.jobId);
  const drawn = ms.find((m) => m.name === pick);
  const job = await askAll(drawn);
  assert.ok(job && job.jobId === posted.jobId, 'the machine drawn is offered the block');
  for (const m of others) assert.equal(await askAll(m), null);                   // the drawn machine has it: inside its time, no one else is offered it
  t += 5_000;                                                                    // the look has aged out: one ask makes a new one
  for (const m of others) assert.equal(await askAll(m), null);
  const b2 = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 5; i++) for (const m of others) assert.equal(await askAll(m), null);
  assert.equal(st.calls.n, b2.calls, 'while the drawn machine proves it, asks cost nothing'); assert.equal(lock.count, b2.locks);
  t += 30_000;                                                                   // past its usual time (30 s here): the race joins it
  const joined = await askAll(others[0]);
  assert.ok(joined && joined.jobId === posted.jobId && joined.race === true, 'the race opens to the others');
});

test('a block whose drawn machine answers after its usual time is left to the relay\'s check: the others are told nothing without the lock', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock, cfg: { ...PROVER_BOARD, drawPct: 100 } });
  const ms = Array.from({ length: 8 }, (_, i) => miner(43_000 + i));
  const askAll = (w) => b.claim({ worker: w, classes: ['public'], programs: EVERY });
  for (const m of ms) await askAll(m);
  const rec = st.rawWorkers(); Object.assign(rec[ms[2].name], { proved: 3, blocks: 4, blockSecs: 30 }); await st.putWorkers(rec);   // only ms[2] has a record: only it can be drawn
  const posted = await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('a late block').toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 900 });
  assert.equal(await askAll(ms[0]), null);                                       // the draw is made on this ask
  const drawn = ms[2], others = ms.filter((m) => m !== drawn);
  assert.equal(st.dump().jobs[posted.jobId].drawPick, drawn.name);
  assert.equal((await askAll(drawn)).jobId, posted.jobId);
  t += 31_000;                                                                   // past its usual time: the race is due to open to the others, but it answers first
  assert.deepEqual(await b.result({ worker: drawn, jobId: posted.jobId, publicValues: '0x' + '33'.repeat(64), proof: '0x' + '44'.repeat(260) }), { ok: true, status: 'candidate' });
  for (const m of others) assert.equal(await askAll(m), null, 'the relay is checking its answer: no one else\'s yet');
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 5; i++) for (const m of others) assert.equal(await askAll(m), null);
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
});

test('a drawn machine whose claim ends before its usual time does is let go at once: the race opens to the others inside a look', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), cfg: { ...PROVER_BOARD, drawPct: 100, communityViewMs: 3_600_000 } });
  const ms = Array.from({ length: 8 }, (_, i) => miner(44_000 + i));
  const askAll = (w) => b.claim({ worker: w, classes: ['public'], programs: EVERY });
  for (const m of ms) await askAll(m);
  const rec = st.rawWorkers(); Object.assign(rec[ms[2].name], { proved: 3, blocks: 4, blockSecs: 55 }); await st.putWorkers(rec);   // only ms[2] can be drawn; its usual time is 55 s, its claim (45 s) ends first
  const posted = await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('a slow block').toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 3000 });
  assert.equal(await askAll(ms[0]), null);
  const drawn = ms[2], others = ms.filter((m) => m !== drawn);
  assert.equal(st.dump().jobs[posted.jobId].drawPick, drawn.name);
  assert.equal((await askAll(drawn)).jobId, posted.jobId);
  for (const m of others) assert.equal(await askAll(m), null); for (const m of others) assert.equal(await askAll(m), null);   // a look stands
  t += 46_000;                                                                   // its claim has ended (45 s), its usual time has not (55 s)
  const j = await askAll(others[0]);
  assert.ok(j && j.jobId === posted.jobId && j.race === true, 'the race opens to the others the moment the drawn machine\'s claim ends');
});

test('the board counts how its community asks were answered, and which kind of job kept a look from ruling one out', async () => {
  { // a plain open job
    const memory = newBoardMemory(), st = memStore();
    const b = makeProverBoard({ storage: st, now, lock: spyLock(), memory });
    const [m1, m2, m3] = [miner(45_001), miner(45_002), miner(45_003)];
    for (const m of [m1, m2, m3]) await ask(b, m);
    assert.equal(memory.asks.first, 3);
    await ask(b, m1); await ask(b, m1);
    assert.ok(memory.asks.fast >= 1, 'asks with nothing to race were answered fast');
    await pubJob(b);
    await ask(b, m1); await ask(b, m1);                                          // m1 races it, and a look stands that lists it
    const before = memory.asks.maybe.open;
    await ask(b, m3);                                                            // m3 could race it
    assert.equal(memory.asks.maybe.open, before + 1);
    assert.ok(memory.asks.stale >= 1, 'asks after a change made a new look');
    assert.deepEqual((await b.summary()).asks, { ...memory.asks, maybe: { ...memory.asks.maybe } }, 'and the summary carries the counts');
  }
  { // a Bitcoin batch no one is proving
    const memory = newBoardMemory();
    const b = makeProverBoard({ storage: memStore(), now, lock: spyLock(), memory });
    const [m1, m2] = [miner(45_011), miner(45_012)];
    const askAll = (w) => b.claim({ worker: w, classes: ['public'], programs: EVERY });
    await askAll(m1); await askAll(m2);
    await b.post({ class: 'public', program: 'btc-state', stdin: Buffer.from('a batch').toString('base64'), cycleLimit: 1e9, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 3000 });
    for (const m of [m1, m2, m1, m2]) await askAll(m);
    assert.ok(memory.asks.maybe.turn + memory.asks.stale + memory.asks.first >= 1);
  }
  { // a block in its draw: the machine drawn
    const memory = newBoardMemory(), st = memStore();
    const b = makeProverBoard({ storage: st, now, lock: spyLock(), memory, cfg: { ...PROVER_BOARD, drawPct: 100 } });
    const ms = Array.from({ length: 4 }, (_, i) => miner(45_021 + i));
    const askAll = (w) => b.claim({ worker: w, classes: ['public'], programs: EVERY });
    for (const m of ms) await askAll(m);
    const rec = st.rawWorkers(); Object.assign(rec[ms[2].name], { proved: 3, blocks: 4, blockSecs: 30 }); await st.putWorkers(rec);   // only ms[2] can be drawn
    const posted = await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('a drawn block').toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 900 });
    assert.equal(await askAll(ms[0]), null);                                     // the draw is made on this ask
    assert.equal(st.dump().jobs[posted.jobId].drawPick, ms[2].name);
    for (const m of [ms[1], ms[3], ms[0], ms[1]]) assert.equal(await askAll(m), null);   // a look stands that lists the block, held for ms[2]
    const before = memory.asks.maybe.draw;
    await askAll(ms[2]);
    assert.equal(memory.asks.maybe.draw, before + 1, 'the machine drawn is the one the look cannot rule out');
  }
});

test('a clock that steps back does not keep a look fresh', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock() });
  const m = miner(46_001);
  await ask(b, m); await ask(b, m); await ask(b, m);
  const c0 = st.calls.n;
  for (let i = 0; i < 5; i++) await ask(b, m);
  assert.equal(st.calls.n, c0, 'a look stands');
  t -= 10_000;                                                                   // the clock steps back ten seconds
  await ask(b, m);
  assert.ok(st.calls.n > c0, 'the board looks again rather than trusting a look from the future');
});

test('a look that is damaged never fails an ask: the board answers it', async () => {
  const st = memStore(), memory = newBoardMemory();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), memory });
  const m = miner(46_011);
  await ask(b, m); await ask(b, m); await ask(b, m);
  assert.ok(memory.view);
  memory.view = { ...memory.view, open: null };                                  // what the look holds is not what it should
  assert.equal(await ask(b, m), null, 'the ask is answered, not failed');
  const posted = await pubJob(b);
  memory.view = { epoch: memory.epoch, at: t, until: Infinity, open: [{ class: 'public', program: 'confidential', sealed: false, input: true, raced: null, racers: [], racedAt: {}, racerLease: {}, racedBy: {} }] };   // fresh, and a check on it throws
  const j = await ask(b, m);
  assert.ok(j && j.jobId === posted.jobId, 'and a job that is there is offered');
});

test('a block whose draw offer has run out is opened to the race by the next ask, not left skipped', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), cfg: { ...PROVER_BOARD, drawPct: 100, communityViewMs: 3_600_000 } });
  const ms = Array.from({ length: 6 }, (_, i) => miner(41_000 + i));
  const askAll = (w) => b.claim({ worker: w, classes: ['public'], programs: EVERY });
  for (const m of ms) await askAll(m);
  const rec = st.rawWorkers(); for (const m of ms) Object.assign(rec[m.name], { proved: 3, blocks: 4, blockSecs: 30 }); await st.putWorkers(rec);
  const posted = await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('another block').toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 900 });
  await askAll(ms[0]);
  const pick = st.dump().jobs[posted.jobId].drawPick;
  const others = ms.filter((m) => m.name !== pick);
  for (const m of others) assert.equal(await askAll(m), null);
  for (const m of others) assert.equal(await askAll(m), null);                   // a look stands: no job for them
  t += PROVER_BOARD.drawOfferMs + 1;                                             // the drawn machine never came: inside the look's window the offer ends
  const j = await askAll(others[0]);
  assert.ok(j && j.jobId === posted.jobId, 'offered the block once the offer has ended');
});

test('a Bitcoin batch one machine is proving is another machine\'s turn for everyone else: their asks cost nothing', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const ms = Array.from({ length: 10 }, (_, i) => miner(42_000 + i));
  const askAll = (w) => b.claim({ worker: w, classes: ['public'], programs: EVERY });
  for (const m of ms) await askAll(m);
  const posted = await b.post({ class: 'public', program: 'btc-state', stdin: Buffer.from('a batch').toString('base64'), cycleLimit: 1e9, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 3000 });
  let taker = null;
  for (let round = 0; round < 3 && !taker; round++) for (const m of ms) { const j = await askAll(m); if (j && j.jobId === posted.jobId) { taker = m; break; } }
  assert.ok(taker, 'the machine whose turn it is takes the batch');
  const others = ms.filter((m) => m.name !== taker.name);
  for (const m of others) assert.equal(await askAll(m), null); for (const m of others) assert.equal(await askAll(m), null);
  const before = { calls: st.calls.n, locks: lock.count };
  for (let i = 0; i < 5; i++) for (const m of others) assert.equal(await askAll(m), null);
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
});

test('a finished job that is due to leave the list inside a look is dropped by the next ask, as the lock would', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), cfg: { ...PROVER_BOARD, communityViewMs: 100 * 3_600_000 } });
  const a = miner(16);
  const old = await pubJob(b, 100 * 3600);
  await b.cancel({ jobId: old.jobId });
  assert.equal(await ask(b, a), null); assert.equal(await ask(b, a), null);        // a look stands, with the cancelled job still kept
  assert.ok(st.dump().jobs[old.jobId]);
  t += PROVER_BOARD.keepMs + 1;
  await ask(b, a);
  assert.equal(st.dump().jobs[old.jobId], undefined, 'the job is gone from storage');
  assert.equal(st.dump().pending.includes(old.jobId), false, 'and from the list');
});

test('more machines than the memory of sightings holds still cost nothing once each has asked', async () => {
  const st = memStore(), lock = spyLock();
  const b = makeProverBoard({ storage: st, now, lock });
  const ms = Array.from({ length: PROVER_BOARD.communityKept + 100 }, (_, i) => miner(7000 + i));
  for (const m of ms) assert.equal(await ask(b, m), null);                         // each machine's first ask
  for (const m of ms) assert.equal(await ask(b, m), null);                         // the look is made
  const before = { calls: st.calls.n, locks: lock.count };
  for (const m of ms) assert.equal(await ask(b, m), null);
  assert.equal(st.calls.n, before.calls); assert.equal(lock.count, before.locks);
});

test('the memory of sightings is bounded to the community records the summary keeps', async () => {
  const st = memStore(), memory = newBoardMemory();
  const b = makeProverBoard({ storage: st, now, lock: spyLock(), memory });
  for (let i = 0; i < PROVER_BOARD.communityKept + 60; i++) { await ask(b, miner(1000 + i)); t += 10; }
  assert.ok(memory.presence.size <= PROVER_BOARD.communityKept);
  const sum = await b.summary();
  assert.ok(sum.workers.filter((w) => w.community).length <= PROVER_BOARD.communityKept + 5, 'the summary lists about as many as it always has');
  t += PROVER_BOARD.communityKeepSeenMs + 1;
  await b.summary();
  assert.ok(memory.presence.size > 0, 'reading does not drop a sighting');
  await ask(b, miner(5000));                                                       // a new machine: its first ask is written out, and the old sightings go with that write
  assert.equal(memory.presence.size, 1, 'sightings not renewed are dropped once a write has carried them');
  const w = (await b.summary()).workers.filter((x) => x.community);
  assert.ok(w.some((x) => x.name === miner(1000 + PROVER_BOARD.communityKept + 59).name), 'and the machines are still listed from storage');
});

// A look gone stale does not send every waiting ask through the board: the first makes a new look, the rest find it.
test('asks that arrive together after a look has aged out cost about one look between them', async () => {
  const st = memStore();
  const b = makeProverBoard({ storage: st, now, lock: spyLock() });
  const ms = Array.from({ length: 30 }, (_, i) => miner(2000 + i));
  for (const m of ms) await ask(b, m);                                           // each machine's first ask
  await ask(b, ms[0]);                                                           // a look is made
  t += PROVER_BOARD.communityViewMs + 1;
  let c0 = st.calls.n; await ask(b, ms[0]); const one = st.calls.n - c0;         // one ask after the look has aged: what a look costs
  t += PROVER_BOARD.communityViewMs + 1;
  c0 = st.calls.n;
  await Promise.all(ms.map((m) => ask(b, m)));
  assert.ok(st.calls.n - c0 <= one + 2, `30 asks together cost ${st.calls.n - c0} calls, one look costs ${one}`);
  assert.ok((await b.summary()).asks.rechecked >= 20, 'the rest found the new look inside the lock');
});

// ── the same answers as the lock gives ──
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const run = async (f) => { try { return { ok: await f() }; } catch (e) { return { err: String(e.message || e) }; } };
const SEALED = { worker: 'tacit-a5000', epk: '0x03' + 'cd'.repeat(32), iv: Buffer.alloc(12, 1).toString('base64'), ct: Buffer.alloc(40, 2).toString('base64') };
const EVERY = ['confidential', 'btc-state', 'tacit-block'];
const ASKS = [undefined, ['confidential'], ['confidential', 'tacit-block'], ['btc-state'], EVERY, EVERY, EVERY, EVERY, ['bogus'], ['tacit-block']];
const tot = { fast: 0, ref: 0, asks: 0, jobs: new Set() };

const HISTORIES = Number(process.env.FAST_ASK_HISTORIES) || 24, SEED_BASE = Number(process.env.FAST_ASK_SEED_BASE) || 0;   // FAST_ASK_HISTORIES=500 for a longer run
for (const seed of Array.from({ length: HISTORIES }, (_, i) => SEED_BASE + i + 1)) {
  const drawPct = seed % 2 === 0 ? 100 : 0;                                     // every other history has the block draw on
  test(`random history ${seed}${drawPct ? ' (block draw on)' : ''}: asks, posts, sealed and block jobs, results, verdicts, cancels and waits give the same answers fast and through the lock`, async () => {
    const r = rng(seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    t = 20_000_000 + seed * 1_000_000;
    const lockF = spyLock(), lockR = spyLock();
    const stF = memStore(), stR = memStore(), memF = newBoardMemory();
    const fast = makeProverBoard({ storage: stF, now, lock: lockF, memory: memF, cfg: { ...PROVER_BOARD, drawPct } });
    const ref = makeProverBoard({ storage: stR, now, lock: lockR, cfg: { ...PROVER_BOARD, drawPct, communityFast: 0 } });
    const miners = Array.from({ length: 14 }, (_, i) => miner(50 + i));
    const ids = [], holds = new Map();
    let houseHeld = null, step = 0;
    const speeds = new Map(miners.map((m) => [m.name, 15 + Math.floor(r() * 43)]));
    const both = async (label, f) => {
      const a = await run(() => f(fast)), b = await run(() => f(ref));
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const n0 = stF.calls.n, l0 = lockF.count, again = await run(() => f(fast));      // the same ask once more, to see which way the fast board takes it
        assert.fail(`seed ${seed} step ${step} ${label} at t=${t}\nrepeated on the fast board: ${JSON.stringify(again).slice(0, 80)} with ${stF.calls.n - n0} storage calls, ${lockF.count - l0} lock takes\nfast: ${JSON.stringify(a)}\nlock: ${JSON.stringify(b)}\nview: ${JSON.stringify(memF.view)} epoch ${memF.epoch}\nfast store: ${JSON.stringify(stF.dump())}\nlock store: ${JSON.stringify(stR.dump())}`);
      }
      return b;
    };
    const known = (res) => { if (res.ok && res.ok.jobId && !ids.includes(res.ok.jobId)) { ids.push(res.ok.jobId); tot.jobs.add(`${seed}:${res.ok.jobId}`); } };
    const check = async () => {
      const w = miner(900 + step);                                  // a machine never seen: its ask goes through the lock on both boards
      await both('settling ask', (x) => ask(x, w));
      for (const id of ids) {
        const a = await run(() => fast.status(id)), b = await run(() => ref.status(id));
        assert.deepEqual(a, b, `seed ${seed} step ${step} status ${id}`);
      }
      const sf = await fast.summary(), sr = await ref.summary();
      const byName = (s) => new Map(s.workers.map((x) => [x.name, x]));
      const diffs = [];
      for (const k of Object.keys({ ...sf, ...sr })) if (k !== 'workers' && k !== 'asks' && JSON.stringify(sf[k]) !== JSON.stringify(sr[k])) diffs.push(`${k}: fast ${JSON.stringify(sf[k])} vs lock ${JSON.stringify(sr[k])}`);
      const wf = byName(sf), wr = byName(sr);
      for (const name of new Set([...wf.keys(), ...wr.keys()])) {
        const a = wf.get(name), b = wr.get(name);
        if (!a || !b) { diffs.push(`${name.slice(-3)}: only in ${a ? 'fast' : 'lock'}`); continue; }
        for (const k of Object.keys({ ...a, ...b })) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${name.slice(-3)}.${k}: fast ${JSON.stringify(a[k])} vs lock ${JSON.stringify(b[k])}`);
      }
      assert.deepEqual(diffs, [], `seed ${seed} step ${step} summary`);
    };
    if (drawPct) {                                                   // every machine has a block record, so a block is drawn to one of them
      for (const m of miners) await both(`first ask ${m.name.slice(-3)}`, (b) => b.claim({ worker: m, classes: ['public'], programs: EVERY }));
      for (const st of [stF, stR]) { const ws = st.rawWorkers(); for (const m of miners) Object.assign(ws[m.name], { proved: 3, blocks: 4, blockSecs: speeds.get(m.name) }); await st.putWorkers(ws); }
    }
    for (step = 0; step < 80; step++) {
      const x = r(), burst = r() < 0.2;
      // every random draw is made here, once, and handed to both boards
      if (burst) {                                                   // polls between job events: a run of asks with nothing else happening
        const k = pick([6, 10, 15]), dt = pick([20, 100, 300]);
        for (let i = 0; i < k; i++) {
          const m = pick(miners), programs = pick(ASKS);
          const res = await both(`burst ask ${m.name.slice(-3)} ${JSON.stringify(programs)}`, (b) => b.claim({ worker: m, classes: ['public'], ...(programs ? { programs } : {}) }));
          tot.asks++;
          if (res.ok && res.ok.jobId) holds.set(m.name, res.ok.jobId);
          t += dt;
        }
      } else if (x < 0.10) {
        const secs = pick([5, 30, 120, 900]), payload = `wrap ${seed}-${step}`;
        known(await both('post public', (b) => b.post({ class: 'public', stdin: Buffer.from(payload).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(t / 1000) + secs })));
      } else if (x < 0.14) {
        const payload = `witness ${seed}-${step}`;
        known(await both('post private', (b) => b.post({ class: 'private', stdin: Buffer.from(payload).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(t / 1000) + 600 })));
      } else if (x < 0.17) {
        const program = pick(['tacit-block', 'btc-state']), payload = `${program} ${seed}-${step}`;
        known(await both(`post ${program}`, (b) => b.post({ class: 'public', program, stdin: Buffer.from(payload).toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + 900 })));
      } else if (x < 0.19) {
        const cls = pick(['private', 'public']);
        known(await both(`post sealed ${cls}`, (b) => b.post({ class: cls, sealed: { ...SEALED, ct: Buffer.alloc(40, step + 3).toString('base64') }, cycleLimit: 1, gasLimit: 1, deadline: Math.floor(t / 1000) + 600 })));
      } else if (x < 0.60) {
        const m = pick(miners), programs = pick(ASKS);
        const res = await both(`ask ${m.name.slice(-3)} ${JSON.stringify(programs)}`, (b) => b.claim({ worker: m, classes: ['public'], ...(programs ? { programs } : {}) }));
        tot.asks++;
        if (res.ok && res.ok.jobId) holds.set(m.name, res.ok.jobId);
      } else if (x < 0.67) {
        const programs = pick([undefined, ['confidential'], ['confidential', 'tacit-block'], ['btc-state']]);
        const res = await both('house ask', (b) => b.claim({ worker: tacit, classes: ['private', 'public'], ...(programs ? { programs } : {}) }));
        if (res.ok && res.ok.jobId) houseHeld = res.ok.jobId;
      } else if (x < 0.73 && houseHeld) {
        await both('house result', (b) => b.result({ worker: tacit, jobId: houseHeld, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) }));
        houseHeld = null;
      } else if (x < 0.81 && holds.size) {
        const [name, jobId] = pick([...holds.entries()]);
        const m = miners.find((q) => q.name === name);
        const good = r() < 0.5;
        await both('candidate', (b) => b.result({ worker: m, jobId, publicValues: '0x' + '33'.repeat(64), proof: '0x' + '44'.repeat(260) }));
        await both('verdict', (b) => b.raceVerdict({ jobId, worker: name, ok: good }));
        holds.delete(name);
      } else if (x < 0.85 && ids.length) {
        const target = pick(ids);
        await both('cancel', (b) => b.cancel({ jobId: target }));
      } else {
        t += pick([200, 900, 1_100, 2_000, 15_000, 25_000, 70_000, 130_000, PROVER_BOARD.leaseMs + 1_000, PROVER_BOARD.keepMs + 5_000]);
      }
      if (step % 7 === 6) await check();
    }
    await check();
    tot.fast += lockF.count; tot.ref += lockR.count;
  });
}

// ── what production looks like ──
// A time-stepped run of the live pattern on both boards at once: 150 machines that all offer every program asking every 3 s or so, wraps, blocks
// with the draw on, a long Bitcoin batch, two house workers asking every second, proofs coming back and being taken. Same answers, and far less work.
test('150 machines on every program with blocks drawn, a long batch and two house workers: the same answers fast and through the lock, and a fraction of the work', async () => {
  const r = rng(77);
  t = 60_000_000;
  const stF = memStore(), stR = memStore(), lockF = spyLock(), lockR = spyLock();
  const cfgF = { ...PROVER_BOARD, drawPct: 100 };
  const fast = makeProverBoard({ storage: stF, now, lock: lockF, cfg: cfgF });
  const ref = makeProverBoard({ storage: stR, now, lock: lockR, cfg: { ...cfgF, communityFast: 0 } });
  const ALL = ['confidential', 'btc-state', 'tacit-block'];
  const miners = Array.from({ length: 150 }, (_, i) => miner(30_000 + i));
  const houses = [{ ...tacit, name: 'tacit-a5000' }, { ...tacit, name: 'tacit-b5000' }];
  const due = new Map(miners.map((m) => [m.name, t + Math.floor(r() * 3000)]));
  const houseDue = new Map(houses.map((h, i) => [h.name, t + i * 500]));
  const working = [], verdicts = [];                                             // { who, jobId, at } a proof on its way back; { jobId, name, at, ok } a candidate the relay is checking
  let step = 0, jobs = 0, claimed = 0, proved = 0, lapsedBlocks = 0, slowBlocks = 0, blockClaims = 0;
  const speed = new Map(miners.map((m) => [m.name, 20 + Math.floor(r() * 38)]));
  const both = async (label, f) => {
    const a = await run(() => f(fast)), b = await run(() => f(ref));
    if (JSON.stringify(a) !== JSON.stringify(b)) assert.fail(`step ${step} t+${t - 60_000_000} ${label}\nfast: ${JSON.stringify(a).slice(0, 300)}\nlock: ${JSON.stringify(b).slice(0, 300)}`);
    return b;
  };
  const ids = [];
  const post = async (label, cls, program, secs, dur) => {
    jobs++;
    const payload = `${label} ${jobs}`;
    const res = await both(`post ${label}`, (b) => b.post({ class: cls, ...(program ? { program } : {}), stdin: Buffer.from(payload).toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: Math.floor(t / 1000) + secs }));
    if (res.ok && res.ok.jobId) ids.push(res.ok.jobId);
  };
  // an hour of finished jobs still on the list
  for (let i = 0; i < 60; i++) { await post('old', 'public', null, 3600); }
  for (const id of ids.slice()) await both('cancel old', (b) => b.cancel({ jobId: id }));
  for (const m of miners) await both(`first ask ${m.name.slice(-3)}`, (b) => b.claim({ worker: m, classes: ['public'], programs: ALL }));
  for (const st of [stF, stR]) { const ws = st.rawWorkers(); for (const m of miners) Object.assign(ws[m.name], { proved: 3, blocks: 4, blockSecs: speed.get(m.name) }); await st.putWorkers(ws); }
  let nextWrap = t + 5_000, nextBlock = t + 8_000, nextBatch = t + 20_000;
  for (step = 0; step < 3000; step++) {                                          // 300 s in 100 ms steps
    t += 100;
    if (t >= nextWrap) { await post('wrap', 'public', null, 600); nextWrap = t + 20_000 + Math.floor(r() * 20_000); }
    if (t >= nextBlock) { await post('block', 'public', 'tacit-block', 900); nextBlock = t + 12_000 + Math.floor(r() * 10_000); }
    if (t >= nextBatch) { await post('batch', 'public', 'btc-state', 3000); nextBatch = t + 900_000; }
    for (const m of miners) {
      if (t < due.get(m.name)) continue;
      due.set(m.name, t + 2500 + Math.floor(r() * 1000));
      const res = await both(`ask ${m.name.slice(-3)}`, (b) => b.claim({ worker: m, classes: ['public'], programs: ALL }));
      if (res.ok && res.ok.jobId) {
        claimed++;
        const k = r(), usual = speed.get(m.name) * 1000;
        let dur = 15_000 + Math.floor(r() * 30_000);
        if (res.ok.program === 'btc-state') dur = 400_000;
        else if (res.ok.program === 'tacit-block') { const kind = blockClaims++ % 4; dur = kind === 0 ? Math.floor(usual * (0.6 + r() * 0.35)) : kind === 3 ? 1e12 : Math.floor(usual * (1.2 + r() * 1.3)); if (kind === 3) lapsedBlocks++; else if (kind) slowBlocks++; }
        if (dur < 1e11) working.push({ who: m, jobId: res.ok.jobId, at: t + dur, community: true });
      }
    }
    for (const h of houses) {
      if (t < houseDue.get(h.name)) continue;
      houseDue.set(h.name, t + 1000);
      const res = await both(`house ${h.name}`, (b) => b.claim({ worker: h, classes: ['private', 'public'], programs: ['confidential', 'tacit-block'] }));
      if (res.ok && res.ok.jobId) { claimed++; working.push({ who: h, jobId: res.ok.jobId, at: t + 25_000 + Math.floor(r() * 30_000), community: false }); houseDue.set(h.name, t + 60_000); }
    }
    for (let i = working.length - 1; i >= 0; i--) {
      const w = working[i];
      if (t < w.at) continue;
      working.splice(i, 1);
      const pv = '0x' + '33'.repeat(64), pr = '0x' + '44'.repeat(260), good = r() < 0.9;
      const res = await both(`result ${w.who.name.slice(-3)}`, (b) => b.result({ worker: w.who, jobId: w.jobId, publicValues: pv, proof: pr }));
      if (w.community && res.ok && res.ok.status === 'candidate') verdicts.push({ jobId: w.jobId, name: w.who.name, at: t + 1000 + Math.floor(r() * 5000), ok: good });
      else if (res.ok && res.ok.status === 'proved') proved++;
    }
    for (let i = verdicts.length - 1; i >= 0; i--) {
      const v = verdicts[i];
      if (t < v.at) continue;
      verdicts.splice(i, 1);
      const res = await both('verdict', (b) => b.raceVerdict({ jobId: v.jobId, worker: v.name, ok: v.ok }));
      if (res.ok && res.ok.status === 'proved') proved++;
    }
    if (step % 300 === 299) {
      for (const id of ids) {
        const a = await run(() => fast.status(id)), b = await run(() => ref.status(id));
        assert.deepEqual(a, b, `step ${step} status ${id}`);
      }
    }
  }
  assert.ok(jobs >= 70 && claimed >= 10 && proved >= 2, `the run exercised the board: ${jobs} jobs, ${claimed} claims, ${proved} proved`);
  assert.ok(slowBlocks >= 2 && lapsedBlocks >= 2, `drawn machines that were slow (${slowBlocks}) and silent (${lapsedBlocks}) were exercised`);
  const asks = 150 * 300 / 3.0;
  console.log(`# production-like run: ${jobs} jobs, ${claimed} claims, ${proved} proved, ${slowBlocks} slow and ${lapsedBlocks} silent drawn machines; lock taken ${lockF.count} fast vs ${lockR.count} lock-only; storage calls ${stF.calls.n} vs ${stR.calls.n} (about ${asks.toFixed(0)} community asks)`);
  assert.ok(lockF.count < lockR.count * 0.25, `lock taken ${lockF.count} times fast against ${lockR.count} lock-only`);
  assert.ok(stF.calls.n < stR.calls.n * 0.25, `storage calls ${stF.calls.n} fast against ${stR.calls.n} lock-only`);
});

test('the random histories covered a real spread of jobs, and the fast ask took the lock far less than the lock-only board did', () => {
  assert.ok(tot.jobs.size >= HISTORIES * 3, `jobs posted across the histories: ${tot.jobs.size}`);
  assert.ok(tot.asks >= HISTORIES * 40, `community asks across the histories: ${tot.asks}`);
  assert.ok(tot.fast < tot.ref * 0.6, `lock taken ${tot.fast} times fast against ${tot.ref} times through the lock`);
  console.log(`# jobs ${tot.jobs.size}, community asks ${tot.asks}, lock ${tot.fast} fast vs ${tot.ref} lock-only`);
});
