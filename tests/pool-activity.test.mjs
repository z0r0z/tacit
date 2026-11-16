// worker-relay/src/lib/pool-activity.js and its use in worker/src/farm-program.js: the log of how often each confidential pool's state changes, kept by the 5-minute tick from the farm
// program's own reads, and the summary each pool carries in GET /farm/program. Offline: node tests/pool-activity.test.mjs
import assert from 'node:assert/strict';
import { sampleOf, foldSample, summarize, summaries, readLog, historyPlan, applyHistory, noteFailed, scrub, KEEP_MS, MAX_EVENTS, GAP_MS, WINDOW_BLOCKS, CHUNK_BLOCKS, BLOCK_MS, SLACK_BLOCKS, MARGIN_BLOCKS, RETRY_MS } from '../worker-relay/src/lib/pool-activity.js';
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
  assert.deepEqual(log.pools[P1], { first: T, fb: 1000, last: { t: T, b: 1000, s: '100:200:50' }, ev: [] });
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
  assert.deepEqual(later.pools[P1], { first: T + 5 * MIN + GAP_MS + 1, fb: 99, last: { t: T + 5 * MIN + GAP_MS + 1, b: 99, s: 'a3:b:1' }, ev: [] }, 'a gap ends the record, whatever the state');
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
  assert.deepEqual(s, { at: T + 1000 * MIN, since: T, hour: 1, day: 5, lastMoveAt: T + 1000 * MIN, backfill: null }, 'one change in the hour to the last reading, five in the day');
  assert.equal(summarize(dense, P2), null, 'a pool with no record'); assert.equal(summarize(dense, P1.toUpperCase().replace('0X', '0x')).day, 5, 'ids are matched in lowercase');
  assert.equal(summarize(null, P1), null);
  assert.deepEqual(Object.keys(summaries(dense)), [P1]);
  // a quiet pool: no change, no last move
  const quiet = foldSample(foldSample(null, [{ poolId: P2, state: '1:1:1' }], { t: T, block: 0 }), [{ poolId: P2, state: '1:1:1' }], { t: T + 5 * MIN, block: 25 });
  assert.deepEqual(summarize(quiet, P2), { at: T + 5 * MIN, since: T, hour: 0, day: 0, lastMoveAt: null, backfill: null });
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
  const kv = store(), env = { REGISTRY_KV: kv, FARM_ACTIVITY_BACKFILL: '0' };
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
  const kv = store(), env = { REGISTRY_KV: kv, FARM_ACTIVITY_BACKFILL: '0' };
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
  const kv = store(), env = { REGISTRY_KV: kv, FARM_ACTIVITY_BACKFILL: '0' };
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
  assert.equal(await farmActivityTick({ REGISTRY_KV: kv, FARM_ACTIVITY_BACKFILL: '0' }, () => kv.clock.now), null); assert.ok(!kv.m.has('farm:activity:v1'));
}

// ── filling a record in from old blocks ──
{
  const T0 = 1_800_000_000_000, HEAD = 26_000_000, floor = HEAD - WINDOW_BLOCKS, newFrom = HEAD - CHUNK_BLOCKS, one = [{ poolId: P1, state: '100:200:50' }];
  const logOf = (rec) => ({ v: 1, pools: { [P1]: rec } });
  const rec = (o) => ({ first: T0 - 60 * MIN, fb: HEAD - 300, last: { t: T0 - 5 * MIN, b: HEAD - 25, s: 'x:y:1' }, ev: [], ...o });
  const planOf = (log) => historyPlan(log, one, { t: T0, head: HEAD });
  // historyPlan: what each pool needs, from the log as it was before the reading. A stretch of CHUNK_BLOCKS at a time, so no tick reads more than a few dozen blocks
  assert.equal(CHUNK_BLOCKS, 1200, 'four hours a tick');
  assert.deepEqual(planOf(null), [{ poolId: P1, mode: 'new', from: newFrom, to: HEAD, toState: '100:200:50' }], 'no record: the last four hours before the reading');
  assert.deepEqual(historyPlan(null, [{ poolId: P1, state: null }], { t: T0, head: HEAD }), [], 'a pool not read has no plan'); assert.deepEqual(historyPlan(null, one, { t: T0, head: 0 }), [], 'nor does a reading with no block');
  assert.deepEqual(planOf(logOf(rec({ first: T0 - 86400e3, fb: floor }))), [], 'a record a day long needs nothing');
  assert.deepEqual(planOf(logOf(rec({ first: T0 - 86400e3 + 1, fb: floor + SLACK_BLOCKS }))), [], 'within the slack of a day it is long enough');
  assert.deepEqual(planOf(logOf(rec({ fb: floor + SLACK_BLOCKS + 1 }))).map((x) => x.mode), ['prepend'], 'a shade shorter is not');
  assert.deepEqual(planOf(logOf(rec())), [{ poolId: P1, mode: 'prepend', from: HEAD - 300 - CHUNK_BLOCKS, to: HEAD - 300 }], 'a live short record: the four hours before its first block');
  assert.deepEqual(planOf(logOf(rec({ fb: floor + 500 }))), [{ poolId: P1, mode: 'prepend', from: floor, to: floor + 500 }], 'near the window the stretch ends at it, no further');
  assert.deepEqual(planOf(logOf(rec({ fb: undefined }))), [{ poolId: P1, mode: 'prepend', from: HEAD - 300 - MARGIN_BLOCKS - CHUNK_BLOCKS, to: HEAD - 300 - MARGIN_BLOCKS }], 'one made before blocks were kept: its first block worked out from its times, a margin early');
  assert.equal(planOf(logOf(rec({ bf: { at: T0 - MIN, ok: true, mode: 'new', reads: 20 } }))).length, 1, 'a good stretch is followed by the next, at the next tick');
  assert.deepEqual(planOf(logOf(rec({ bf: { at: T0 - MIN, ok: true, full: true } }))), [], 'but not once the pool\'s own beginning is reached');
  assert.deepEqual(planOf(logOf(rec({ bf: { at: T0 - RETRY_MS, ok: false, err: 'x' } }))), [], 'a failed try is not repeated at once');
  assert.equal(planOf(logOf(rec({ bf: { at: T0 - RETRY_MS - 1, ok: false, err: 'x' } }))).length, 1, 'but after the wait it is'); assert.equal(RETRY_MS, 10 * 60e3);
  assert.deepEqual(planOf(logOf(rec({ last: { t: T0 - 60 * MIN, b: HEAD - 300, s: 'x:y:1' } }))), [{ poolId: P1, mode: 'gap', from: HEAD - 300, fromState: 'x:y:1', to: HEAD, toState: '100:200:50' }], 'a gap within the window: its blocks, from the state the record ended in');
  assert.deepEqual(planOf(logOf(rec({ last: { t: T0 - 60 * MIN, b: floor - 10, s: 'x:y:1' } }))).map((x) => [x.mode, x.from]), [['new', newFrom]], 'a gap longer than the window is a new record');
  assert.deepEqual(planOf(logOf(rec({ last: { t: T0 + MIN, b: HEAD - 1, s: 'x:y:1' } }))).map((x) => x.mode), ['gap'], 'a clock that went back is not live, and its blocks are still the record\'s own to fill');

  // foldSample keeps what a record carries, and a new one says its first block
  const live = logOf({ first: T0, fb: 5, last: { t: T0, b: 5, s: 'a:b:1' }, ev: [], bf: { at: T0, ok: true } });
  const f = foldSample(live, [{ poolId: P1, state: 'a2:b:1' }], { t: T0 + 5 * MIN, block: 30 });
  assert.equal(f.pools[P1].fb, 5); assert.deepEqual(f.pools[P1].bf, { at: T0, ok: true }); assert.equal(f.pools[P1].ev.length, 1);

  // applyHistory: a new record, with what the read did said on it
  const t = T0, head = HEAD, timeOf = (b) => t - (head - b) * BLOCK_MS;
  const fresh = foldSample(null, one, { t, block: head }), planNew = planOf(null)[0];
  const ev1 = [{ block: head - 1000, kind: 'trade' }, { block: head - 100, kind: 'liquidity' }];
  const made = applyHistory(null, fresh, planNew, { from: newFrom, fromState: 'a', events: ev1, calls: 30 }, { t, head });
  assert.deepEqual(made.pools[P1], { first: timeOf(newFrom), fb: newFrom, last: { t, b: head, s: '100:200:50' }, ev: [[timeOf(head - 1000), head - 1000, 'trade'], [timeOf(head - 100), head - 100, 'liquidity']], bf: { at: t, ok: true, mode: 'new', reads: 30 } });
  assert.equal(timeOf(newFrom), t - 4 * 3600e3, 'four hours of blocks');
  assert.deepEqual(summarize(made, P1), { at: t, since: t - 4 * 3600e3, hour: 1, day: 2, lastMoveAt: timeOf(head - 100), backfill: { at: t, ok: true, mode: 'new', reads: 30 } }, 'the summary says what was read');
  // a pool made inside what was asked for starts where the search found it, and that is the whole of it
  const late = applyHistory(null, fresh, planNew, { from: newFrom + 600, fromState: 'a', events: [], calls: 8 }, { t, head });
  assert.equal(late.pools[P1].fb, newFrom + 600); assert.equal(late.pools[P1].first, timeOf(newFrom + 600)); assert.deepEqual(late.pools[P1].bf, { at: t, ok: true, mode: 'new', reads: 8, full: true }, 'full: nothing earlier to read');
  // a gap joins the record it broke: its first, its first block, its events and its mark stay, and the gap's changes follow
  const broken = logOf(rec({ first: T0 - 600 * MIN, fb: HEAD - 3000, last: { t: T0 - 60 * MIN, b: HEAD - 300, s: 'x:y:1' }, ev: [[T0 - 400 * MIN, HEAD - 2000, 'trade']], bf: { at: T0 - 600 * MIN, ok: true, mode: 'new', reads: 20 } }));
  const foldedGap = foldSample(broken, one, { t, block: head }), gp = planOf(broken)[0];
  const joined = applyHistory(broken, foldedGap, gp, { from: HEAD - 300, fromState: 'x:y:1', events: [{ block: head - 150, kind: 'trade' }], calls: 4 }, { t, head });
  assert.deepEqual(joined.pools[P1], { first: T0 - 600 * MIN, fb: HEAD - 3000, last: { t, b: head, s: '100:200:50' }, ev: [[T0 - 400 * MIN, HEAD - 2000, 'trade'], [timeOf(head - 150), head - 150, 'trade']], bf: { at: T0 - 600 * MIN, ok: true, mode: 'new', reads: 20 } });
  const nomark = logOf({ first: T0 - 600 * MIN, last: { t: T0 - 60 * MIN, b: HEAD - 300, s: 'x:y:1' }, ev: [] });
  assert.equal('bf' in applyHistory(nomark, foldSample(nomark, one, { t, block: head }), planOf(nomark)[0], { from: HEAD - 300, events: [], calls: 2 }, { t, head }).pools[P1], false, 'a record never filled in before its start is still to be');
  // a live short record gets the stretch before it, oldest first, with what it has kept
  const shortRec = logOf(rec({ ev: [[T0 - 30 * MIN, HEAD - 150, 'trade']] }));
  const foldedShort = foldSample(shortRec, one, { t, block: head }), pp = planOf(shortRec)[0];
  const pre = applyHistory(shortRec, foldedShort, pp, { from: pp.from, events: [{ block: pp.from + 100, kind: 'trade' }, { block: pp.from + 700, kind: 'liquidity' }], calls: 14 }, { t, head });
  assert.deepEqual(pre.pools[P1].ev.map((e) => e[1]), [pp.from + 100, pp.from + 700, HEAD - 150, HEAD], 'older first, then the one it kept, then what this reading itself found');
  assert.equal(pre.pools[P1].first, timeOf(pp.from)); assert.equal(pre.pools[P1].fb, pp.from); assert.deepEqual(pre.pools[P1].bf, { at: t, ok: true, mode: 'prepend', reads: 14 }); assert.equal(pre.pools[P1].last.b, head);
  // events older than KEEP_MS go, and the cap holds
  const many = Array.from({ length: MAX_EVENTS + 30 }, (_, i) => ({ block: newFrom + 1 + i, kind: 'trade' }));
  assert.equal(applyHistory(null, fresh, planNew, { from: newFrom, events: many, calls: 1 }, { t, head }).pools[P1].ev.length, MAX_EVENTS);
  // noteFailed marks the record with why, and leaves a pool with none alone
  const failed = noteFailed(fresh, planNew, { t, err: new Error('rpc eth_call failed: a.test HTTP 429; b.test not JSON') });
  assert.deepEqual(failed.pools[P1].bf, { at: t, ok: false, mode: 'new', err: 'rpc eth_call failed: a.test HTTP 429; b.test not JSON' });
  assert.deepEqual(noteFailed({ v: 1, pools: {} }, planNew, { t, err: 'x' }), { v: 1, pools: {} });
  assert.deepEqual(summarize(failed, P1).backfill, { at: t, ok: false, mode: 'new', err: 'rpc eth_call failed: a.test HTTP 429; b.test not JSON' }, 'the reason reaches the summary');
  assert.equal(summarize(fresh, P1).backfill, null, 'a record no read was made for says null, not nothing');
  // scrub: no address (a node's address can carry a key), one line, bounded
  assert.equal(scrub(new Error('failed: https://eth-mainnet.example/v2/SECRETKEY HTTP 429\n  at x')), 'failed: [address] HTTP 429 at x');
  assert.ok(!/SECRETKEY/.test(JSON.stringify(noteFailed(fresh, planNew, { t, err: 'rpc failed https://x.example/v2/SECRETKEY: down' }))), 'a keyed address is not kept in the log either');
  assert.equal(scrub('y'.repeat(900)).length, 300); assert.equal(scrub(null), ''); assert.equal(scrub(undefined), ''); assert.equal(scrub('plain words'), 'plain words');
}

// ── the tick filling a record in, against a stand-in chain ──
{
  const quiet = console.warn; const warned = []; console.warn = (m) => { warned.push(String(m)); };
  const HEAD = 26_000_000, floor = HEAD - WINDOW_BLOCKS;
  // the pool's state a number of blocks back from the head: changes at 7000 (trade), 4000 (an add), 1000 (trade) and 200 (a remove) blocks back, and the program's own state at the end
  const steps = [[7000, '1:1:50'], [4000, '2:2:51'], [1000, '3:3:51'], [200, '100:200:50']];
  const chainFn = (initial, from = steps) => async (b) => { let st = initial; for (const [back, state] of from) if (b >= HEAD - back) st = state; return st; };
  const histOf = (fn, calls) => ({ stateAt: (id) => async (b) => { calls.push([id, b]); return fn(id, b); } });
  const run = async (kv, env, hist, m) => { kv.clock.now += m * MIN; return farmActivityTick(env, () => kv.clock.now, hist); };
  const on = (kv) => ({ REGISTRY_KV: kv });
  const P1chain = (fn) => (id, b) => (id === P1 ? fn(b) : null);
  // ticks until the plan is empty (or the cap), returning how many reads each took
  const fill = async (kv, env, hist, calls, cap = 12) => { const per = []; for (let i = 0; i < cap; i++) { const n = calls.length; await run(kv, env, hist, 5); per.push(calls.length - n); if (!per.at(-1)) break; } return per; };

  // the first tick of all reads four hours, and each tick after it four hours more, until the day is whole: no tick reads more than a few dozen blocks
  {
    reset(); block = HEAD;
    const kv = store(), calls = [], env = on(kv), hist = histOf(P1chain(chainFn('0:0:50')), calls);
    const log = await run(kv, env, hist, 0), t0 = kv.clock.now, r = log.pools[P1], n1 = calls.length;
    assert.equal(r.fb, HEAD - CHUNK_BLOCKS); assert.equal(r.first, t0 - 4 * 3600e3); assert.equal(r.bf.mode, 'new'); assert.equal(r.bf.ok, true);
    assert.deepEqual(r.ev.map((e) => e[2]), ['trade', 'liquidity'], 'only the changes inside the four hours: 1000 and 200 blocks back'); assert.ok(n1 < 30, 'a few reads for the first stretch (' + n1 + ')');
    assert.ok(calls.every(([id]) => id === P1), 'the pool that was not read in the program is not read');
    const mid = (await ask(env)).obj.pools[0].activity; assert.equal(mid.backfill.ok, true); assert.equal(mid.backfill.mode, 'new'); assert.equal(mid.backfill.reads, n1);
    const per = await fill(kv, env, hist, calls), done = readLog(await kv.get('farm:activity:v1')).pools[P1], t = kv.clock.now;
    assert.equal(done.fb, floor, 'the day is whole'); assert.equal(done.first, t - 5 * MIN - 86400e3, 'a day before the tick that read the last stretch (the one before the idle tick)');
    assert.equal(done.ev.length, 4, 'all four changes'); assert.deepEqual(done.ev.map((e) => e[2]), ['trade', 'liquidity', 'trade', 'liquidity']);
    assert.ok(per.slice(0, -1).every((c) => c > 0 && c < 40), 'each tick a few dozen reads at most (' + per + ')'); assert.equal(per.at(-1), 0, 'and then none');
    assert.equal(per.length, 6, 'five more stretches and then a tick with nothing to read');
    const a = (await ask(env)).obj.pools[0].activity;
    assert.equal(a.day, 4); assert.equal(a.hour, 0, 'the change 40 minutes before the first tick is over an hour before the seventh (the stand-in head does not move on)'); assert.equal(a.backfill.mode, 'prepend'); assert.equal(a.backfill.ok, true);
    const n = calls.length; await run(kv, env, hist, 5); assert.equal(calls.length, n, 'a whole record is not read for again');
  }
  // the records already live, made before blocks were kept, with no mark: extended a stretch a tick, once each has its first block
  {
    reset(); block = HEAD;
    const kv = store(), calls = [], env = on(kv), t0 = kv.clock.now, hist = histOf(P1chain(chainFn('0:0:50')), calls);
    await kv.put('farm:activity:v1', JSON.stringify({ v: 1, pools: { [P1]: { first: t0 - 55 * MIN, last: { t: t0, b: HEAD - 25, s: '100:200:50' }, ev: [[t0 - 30 * MIN, HEAD - 150, 'trade']] } } }));
    const log = await run(kv, env, hist, 5), r = log.pools[P1];
    assert.equal(r.fb, HEAD - 300 - MARGIN_BLOCKS - CHUNK_BLOCKS, 'a stretch before the estimated start'); assert.equal(r.bf.mode, 'prepend');
    assert.equal(r.ev.at(-1)[1], HEAD - 150, 'what the record had kept stays, last'); assert.ok(calls.every(([, b]) => b <= HEAD - 300 - MARGIN_BLOCKS + 25), 'no block after where the record starts is read');
    await fill(kv, env, hist, calls);
    const done = readLog(await kv.get('farm:activity:v1')).pools[P1];
    assert.equal(done.fb, floor); assert.equal(done.ev.length, 4, 'three before it, one it kept (the change at 200 blocks back is after the estimated start, so it is the record\'s own to have seen)');
  }
  // a gap: the blocks of the gap are read at once, and the record is whole across it
  {
    reset(); block = HEAD;
    const kv = store(), calls = [], env = on(kv), t0 = kv.clock.now, hist = histOf(P1chain(chainFn('0:0:50')), calls);
    await kv.put('farm:activity:v1', JSON.stringify({ v: 1, pools: { [P1]: { first: t0 - 600 * MIN, fb: HEAD - 3000, last: { t: t0 - 55 * MIN, b: HEAD - 300, s: '3:3:51' }, ev: [[t0 - 400 * MIN, HEAD - 2000, 'trade']], bf: { at: t0 - 600 * MIN, ok: true } } } }));
    const log = await run(kv, env, hist, 5), r = log.pools[P1];
    assert.equal(r.first, t0 - 600 * MIN, 'the record is the one it was'); assert.equal(r.fb, HEAD - 3000); assert.equal(r.ev.length, 2);
    assert.equal(r.ev[1][2], 'liquidity', 'the remove 200 blocks back, which the gap hid'); assert.ok(calls.length <= 8 && calls.every(([, b]) => b > HEAD - 300 && b <= HEAD), 'only the gap\'s blocks (' + calls.length + ' reads)');
  }
  // old blocks that cannot be read: the record is what the ticks make of it, marked with why, said in the summary, and tried again after ten minutes, not at each tick
  {
    reset(); block = HEAD; warned.length = 0;
    const kv = store(), calls = [], env = on(kv);
    let works = false;
    const hist = histOf((id, b) => { if (!works) throw new Error('rpc eth_call failed: rpc.mevblocker.io HTTP 403; mainnet.rpc.buidlguidl.com HTTP 429 at https://x.example/v2/SECRETKEY'); return id === P1 ? chainFn('0:0:50')(b) : null; }, calls);
    let log = await run(kv, env, hist, 0), t = kv.clock.now;
    assert.equal(log.pools[P1].first, t, 'the record starts at the reading, as it did before'); assert.equal(log.pools[P1].fb, HEAD);
    assert.equal(log.pools[P1].bf.ok, false); assert.equal(log.pools[P1].bf.mode, 'new');
    const said = (await ask(env)).obj.pools[0].activity.backfill;
    assert.equal(said.ok, false); assert.match(said.err, /mevblocker.*HTTP 403.*buidlguidl.*HTTP 429/); assert.ok(!/SECRETKEY|x\.example/.test(JSON.stringify(said)), 'the reason is in the API, and without an address'); assert.equal(said.mode, 'new');
    assert.ok(warned.some((w) => /\[farm-activity\].*not read: rpc eth_call failed/.test(w) && !/SECRETKEY/.test(w)), 'and in the log');
    const n = calls.length;
    works = true; log = await run(kv, env, hist, 5); assert.equal(calls.length, n, 'not asked again at the next tick');
    log = await run(kv, env, hist, 5); assert.equal(calls.length, n, 'nor ten minutes on, to the minute');
    log = await run(kv, env, hist, 5), t = kv.clock.now;      // 15 minutes after the failure (a tick sooner than the lease's four minutes does not run at all)
    assert.ok(calls.length > n, 'after the wait, again'); assert.equal(log.pools[P1].bf.ok, true); assert.equal(log.pools[P1].bf.mode, 'prepend'); assert.equal(log.pools[P1].fb, HEAD - CHUNK_BLOCKS, 'the stretch before the record, now read');
    assert.equal((await ask(env)).obj.pools[0].activity.backfill.ok, true, 'and the summary says it worked');
    await fill(kv, env, hist, calls); assert.equal(readLog(await kv.get('farm:activity:v1')).pools[P1].ev.filter((e) => e[2] === 'liquidity').length, 2, 'the changes are all there in the end');
  }
  // a pool made 5400 blocks ago: its record starts where it was first there, and the reading stops there
  {
    reset(); block = HEAD;
    const kv = store(), calls = [], env = on(kv);
    const hist = histOf(P1chain(chainFn(null, [[5400, '0:0:50'], ...steps.slice(1)])), calls);      // made 5400 blocks back, then the later changes
    await run(kv, env, hist, 0); await fill(kv, env, hist, calls);
    const r = readLog(await kv.get('farm:activity:v1')).pools[P1], t = kv.clock.now;
    assert.equal(r.fb, floor + 1800, 'the first coarse block the pool was there'); assert.equal(r.bf.full, true, 'and nothing earlier is looked for'); assert.equal(r.ev.length, 3, 'its making is not a change; the three after it are');
    const n = calls.length; await run(kv, env, hist, 5); assert.equal(calls.length, n, 'no more reads once its beginning is reached');
  }
  // no time left for the search: the same as a failure, said as one
  {
    reset(); block = HEAD;
    const kv = store(), calls = [], env = on(kv), hist = { ...histOf((id, b) => chainFn('0:0:50')(b), calls), deadlineMs: -1 };
    const log = await run(kv, env, hist, 0);
    assert.equal(log.pools[P1].bf.ok, false); assert.match(log.pools[P1].bf.err, /ran out of time/); assert.equal(calls.length, 0, 'it stopped before reading');
  }
  // switched off: no old block is read, and the record starts at the reading, with no status
  {
    reset(); block = HEAD;
    const kv = store(), calls = [], env = { REGISTRY_KV: kv, FARM_ACTIVITY_BACKFILL: '0' }, hist = histOf(() => '1:1:1', calls);
    const log = await run(kv, env, hist, 0);
    assert.equal(calls.length, 0); assert.equal(log.pools[P1].bf, undefined); assert.equal(log.pools[P1].first, kv.clock.now);
    assert.equal((await ask(env)).obj.pools[0].activity.backfill, null, 'the summary says null: this server can read old blocks and has not');
  }
  console.warn = quiet;
}
console.log('pool-activity: all checks passed');
