// worker-relay/src/lib/pool-activity.js and its use in worker/src/farm-program.js: the log of how often each confidential pool's state changes, kept by the 5-minute tick from the farm
// program's own reads, and the summary each pool carries in GET /farm/program. Offline: node tests/pool-activity.test.mjs
import assert from 'node:assert/strict';
import { sampleOf, foldSample, summarize, summaries, readLog, KEEP_MS, MAX_EVENTS, GAP_MS } from '../worker-relay/src/lib/pool-activity.js';
import { handleFarm, farmActivityTick, _setFarmLoader, _resetFarmCache, _resetFarmActivity } from '../worker/src/farm-program.js';

const P1 = '0x' + '11'.repeat(32), P2 = '0x' + '22'.repeat(32), P3 = '0x' + '33'.repeat(32);
const MIN = 60e3;
const pool = (poolId, a, b, s) => ({ pid: 0, poolId, pair: 'TAC/cETH', reserves: a == null ? null : { assetA: '0xaa', assetB: '0xbb', reserveA: String(a), reserveB: String(b), lpTotalShares: String(s) } });

// sampleOf: each pool's state, null where it was not read, nothing for a row that is not a pool
{
  const s = sampleOf({ pools: [pool(P1, 10, 20, 5), pool(P2, null), { pid: 9, poolId: 'nope', reserves: {} }, pool(P3.toUpperCase().replace('0X', '0x'), 1, 2, 3)] });
  assert.deepEqual(s, [{ poolId: P1, state: '10:20:5' }, { poolId: P2, state: null }, { poolId: P3, state: '1:2:3' }], 'ids lowercased, a pool not read has no state, a bad id is left out');
  assert.deepEqual(sampleOf(null), []); assert.deepEqual(sampleOf({}), []);
}
// readLog: anything that is not the log is an empty one
for (const bad of [null, undefined, '', 'not json', '{"v":2,"pools":{}}', '{"v":1}', '[]', 7]) assert.deepEqual(readLog(bad), { v: 1, pools: {} }, `empty from ${String(bad)}`);

// foldSample: the first reading starts a record; the same state adds nothing; a changed one is an event of its kind
{
  const T = 1_800_000_000_000;
  let log = foldSample(null, [{ poolId: P1, state: '100:200:50' }], { t: T, block: 1000 });
  assert.deepEqual(log.pools[P1], { first: T, last: { t: T, b: 1000, s: '100:200:50' }, ev: [] });
  log = foldSample(log, [{ poolId: P1, state: '100:200:50' }], { t: T + 5 * MIN, block: 1025 });
  assert.equal(log.pools[P1].ev.length, 0, 'no change, no event'); assert.equal(log.pools[P1].last.t, T + 5 * MIN, 'but the reading is noted');
  log = foldSample(log, [{ poolId: P1, state: '103:195:50' }], { t: T + 10 * MIN, block: 1050 });
  assert.deepEqual(log.pools[P1].ev, [[T + 10 * MIN, 1050, 'trade']], 'reserves moved, shares did not: a trade');
  log = foldSample(log, [{ poolId: P1, state: '203:395:99' }], { t: T + 15 * MIN, block: 1075 });
  assert.deepEqual(log.pools[P1].ev.at(-1), [T + 15 * MIN, 1075, 'liquidity'], 'shares moved: an add or a remove');
  assert.equal(log.pools[P1].first, T, 'the record still starts where it did');
  // a pool not read this time keeps its record as it was; another pool in the same reading is still folded
  const both = foldSample(log, [{ poolId: P1, state: null }, { poolId: P2, state: '5:5:5' }], { t: T + 20 * MIN, block: 1100 });
  assert.deepEqual(both.pools[P1], log.pools[P1]); assert.equal(both.pools[P2].first, T + 20 * MIN);
  assert.notEqual(both, log, 'the log it was given is not changed'); assert.equal(log.pools[P2], undefined);
}
// a gap in the record starts another: what changed in it is not counted, and what came before is not counted into the new one
{
  const T = 1_800_000_000_000;
  let log = foldSample(null, [{ poolId: P1, state: 'a:b:1' }], { t: T, block: 1 });
  log = foldSample(log, [{ poolId: P1, state: 'a2:b:1' }], { t: T + 5 * MIN, block: 2 });
  assert.equal(log.pools[P1].ev.length, 1);
  const later = foldSample(log, [{ poolId: P1, state: 'a3:b:1' }], { t: T + 5 * MIN + GAP_MS + 1, block: 99 });
  assert.deepEqual(later.pools[P1], { first: T + 5 * MIN + GAP_MS + 1, last: { t: T + 5 * MIN + GAP_MS + 1, b: 99, s: 'a3:b:1' }, ev: [] }, 'a gap ends the record, whatever the state');
  const edge = foldSample(log, [{ poolId: P1, state: 'a3:b:1' }], { t: T + 5 * MIN + GAP_MS, block: 99 });
  assert.equal(edge.pools[P1].ev.length, 2, 'a gap of exactly the limit is still one record'); assert.equal(edge.pools[P1].first, T);
  const back = foldSample(log, [{ poolId: P1, state: 'a3:b:1' }], { t: T, block: 99 });
  assert.equal(back.pools[P1].ev.length, 0, 'a clock that went back is a new record too');
}
// the record is kept for KEEP_MS and for MAX_EVENTS
{
  const T = 1_800_000_000_000;
  let log = null, i = 0;
  for (; i < MAX_EVENTS + 40; i++) log = foldSample(log, [{ poolId: P1, state: `${i}:0:1` }], { t: T + i * MIN, block: i });
  assert.equal(log.pools[P1].ev.length, MAX_EVENTS, 'at most MAX_EVENTS'); assert.equal(log.pools[P1].ev.at(-1)[1], i - 1, 'the newest kept');
  let old = foldSample(null, [{ poolId: P1, state: '0:0:1' }], { t: T, block: 0 }), t = T;
  for (let k = 1; k <= 3; k++) { t += 15 * MIN; old = foldSample(old, [{ poolId: P1, state: `${k}:0:1` }], { t, block: k }); }
  for (let k = 0; k < KEEP_MS / (15 * MIN) + 2; k++) { t += 15 * MIN; old = foldSample(old, [{ poolId: P1, state: '9:0:1' }], { t, block: 100 + k }); }
  assert.equal(old.pools[P1].ev.length, 0, 'changes older than KEEP_MS are dropped');
}
// summarize: counts back from the last reading
{
  const T = 1_800_000_000_000;
  const at = [10, 50, 100, 400, 1000];             // minutes after T, each a change
  // the record is unbroken only with readings every few minutes
  let dense = foldSample(null, [{ poolId: P1, state: '0:0:1' }], { t: T, block: 0 }), state = 0;
  for (let m = 5; m <= 1000; m += 5) { if (at.includes(m)) state++; dense = foldSample(dense, [{ poolId: P1, state: `${state}:0:1` }], { t: T + m * MIN, block: m }); }
  const s = summarize(dense, P1);
  assert.deepEqual(s, { at: T + 1000 * MIN, since: T, hour: 1, day: 5, lastMoveAt: T + 1000 * MIN }, 'one change in the hour to the last reading, five in the day');
  assert.equal(summarize(dense, P2), null, 'a pool with no record'); assert.equal(summarize(dense, P1.toUpperCase().replace('0X', '0x')).day, 5, 'ids are matched in lowercase');
  assert.equal(summarize(null, P1), null);
  assert.deepEqual(Object.keys(summaries(dense)), [P1]);
  // a quiet pool: no change, no last move
  const quiet = foldSample(foldSample(null, [{ poolId: P2, state: '1:1:1' }], { t: T, block: 0 }), [{ poolId: P2, state: '1:1:1' }], { t: T + 5 * MIN, block: 25 });
  assert.deepEqual(summarize(quiet, P2), { at: T + 5 * MIN, since: T, hour: 0, day: 0, lastMoveAt: null });
}

// ── the tick and the program's answer ──
const store = () => {
  const m = new Map(), clock = { now: Date.now() };
  return { clock, m, ok: true,
    async get(k) { if (!this.ok) throw new Error('store down'); const e = m.get(k); if (!e) return null; if (e.until && e.until <= clock.now) { m.delete(k); return null; } return e.v; },
    async put(k, v, o = {}) { if (!this.ok) throw new Error('store down'); m.set(k, { v, until: o.expirationTtl ? clock.now + o.expirationTtl * 1000 : 0 }); } };
};
const reply = (obj, status = 200, headers = {}) => ({ obj, status, headers });
let reserve = { a: 100, b: 200, s: 50 }, block = 26_000_000, fails = false;
const loader = async () => {
  if (fails) throw new Error('rpc down');
  return { program: { manager: '0xm', block, pools: [pool(P1, reserve.a, reserve.b, reserve.s), pool(P2, null)], codeMissing: false }, health: { status: 'ok' }, updatedAt: new Date().toISOString() };
};
const fresh = () => { _resetFarmCache(); _resetFarmActivity(); _setFarmLoader(loader); };      // _resetFarmCache puts the real chain reader back, so the stand-in goes in after it
const reset = () => { fresh(); reserve = { a: 100, b: 200, s: 50 }; block = 26_000_000; fails = false; };
const ask = (env) => handleFarm('program', new URL('https://api.test/farm/program?network=mainnet'), env, {}, reply);

{
  reset();
  const kv = store(), env = { REGISTRY_KV: kv };
  const tick = async (advanceMin) => { kv.clock.now += advanceMin * MIN; return farmActivityTick(env, () => kv.clock.now); };
  // before any tick the answer is the program as it was: no activity key
  let r = await ask(env);
  assert.equal(r.status, 200); assert.equal(r.obj.pools[0].activity, undefined, 'no record yet');
  const t0 = kv.clock.now;
  let log = await tick(0);
  assert.equal(log.pools[P1].first, t0); assert.equal(log.pools[P2], undefined, 'a pool that was not read has no record');
  assert.ok(kv.m.has('farm:activity:v1') && kv.m.has('farm:activity:lease'), 'the log and the lease are in the store');
  assert.equal(await tick(0), null, 'a second service in the same tick finds the lease and does nothing');
  const next = await tick(5);
  assert.ok(next && next.pools[P1].last.t > log.pools[P1].last.t, 'after the lease (240 s) it runs again');
}
{
  reset();
  const kv = store(), env = { REGISTRY_KV: kv };
  const tick = (m) => { kv.clock.now += m * MIN; return farmActivityTick(env, () => kv.clock.now); };
  await tick(0);
  reserve = { a: 103, b: 195, s: 50 }; block += 25;
  const log = await tick(5);
  assert.equal(log.pools[P1].ev.length, 1, 'the second tick saw a change');
  let r = await ask(env);
  const a = r.obj.pools[0].activity;
  assert.equal(a.hour, 1); assert.equal(a.day, 1); assert.equal(a.lastMoveAt, kv.clock.now); assert.equal(a.at, kv.clock.now); assert.ok(a.since < a.at);
  assert.equal(r.obj.pools[1].activity, undefined, 'the pool with no record carries none');
  assert.equal(r.obj.stale, false); assert.ok(r.obj.updatedAt);
  // a new process (the in-memory summaries gone) reads the same record back from the store
  fresh();
  r = await ask(env);
  assert.deepEqual(r.obj.pools[0].activity, a, 'the record is the store\'s, not the process\'s');
  // the store down at ask time: the program is still served, without the summary
  fresh(); kv.ok = false;
  r = await ask(env);
  assert.equal(r.status, 200); assert.equal(r.obj.pools[0].activity, undefined, 'a store that cannot be read costs the summary and nothing else');
  assert.equal(r.obj.pools[0].poolId, P1, 'and the rest of the answer is whole');
  // the chain unreadable at tick time: the tick throws (the cron logs it), the record is left as it was, and the lease is not what stops the next one
  kv.ok = true; fresh(); fails = true;
  await assert.rejects(tick(5), /rpc down/);
  fails = false;
  const again = await tick(5);
  assert.ok(again && again.pools[P1], 'the next tick goes on'); assert.equal(again.pools[P1].first, log.pools[P1].first, 'within the gap it is still the same record');
}
// a tick that comes after a long silence starts a new record rather than claiming the time between
{
  reset();
  const kv = store(), env = { REGISTRY_KV: kv };
  const tick = (m) => { kv.clock.now += m * MIN; return farmActivityTick(env, () => kv.clock.now); };
  const first = await tick(0);
  reserve = { a: 1, b: 2, s: 3 };
  const late = await tick(60);
  assert.equal(late.pools[P1].ev.length, 0, 'a change somewhere in an hour of silence is not counted'); assert.ok(late.pools[P1].first > first.pools[P1].first);
}
// switched off, or with no store: nothing is written and the answer is the program's
{
  reset();
  const kv = store();
  assert.equal(await farmActivityTick({ REGISTRY_KV: kv, FARM_ACTIVITY: '0' }), null); assert.equal(kv.m.size, 0, 'off: nothing written');
  assert.equal(await farmActivityTick({}), null, 'no store: nothing to do');
  const r = await ask({}); assert.equal(r.status, 200); assert.equal(r.obj.pools[0].activity, undefined);
  const p = await ask({ REGISTRY_KV: kv, FARM_ACTIVITY: '0' }); assert.equal(p.obj.pools[0].activity, undefined);
}
// a program with no contract code is no record
{
  reset();
  _setFarmLoader(async () => ({ program: { manager: '0xm', codeMissing: true }, health: {}, updatedAt: 'x' }));
  const kv = store();
  assert.equal(await farmActivityTick({ REGISTRY_KV: kv }, () => kv.clock.now), null); assert.ok(!kv.m.has('farm:activity:v1'));
}
console.log('pool-activity: all checks passed');
