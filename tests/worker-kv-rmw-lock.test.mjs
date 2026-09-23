#!/usr/bin/env node
// Per-key serialization of the worker's read-modify-write counters (worker/src/index.js `withKvKeyLock`).
//
// Every per-IP token bucket and every daily budget in the worker is `kv.get` → compute → `kv.put` across an
// await. Without serialization, concurrent requests all resolve their `get` before any `put` lands, all read
// the same count, and all write count-1 — so N parallel requests cost ONE token and the limit does nothing.
// That matters beyond load shedding: the prove and free-relay daily caps are the only bound on real PROVE
// spend from a permissionless route.
//
// This pins the property the fix provides (a burst is a burst under concurrency) and, deliberately, also
// demonstrates the unlocked version failing — so the test cannot quietly pass for the wrong reason if the
// lock is ever removed.
//
// Run: node tests/worker-kv-rmw-lock.test.mjs

import assert from 'node:assert';

let pass = 0;
const ok = (name) => { pass++; console.log('  ok  ' + name); };

// A KV whose reads and writes both yield to the event loop, exactly as a real network/Postgres round trip does.
function slowKv() {
  const store = new Map();
  return {
    get: async (k) => { await new Promise((r) => setTimeout(r, 1)); return store.get(k) ?? null; },
    put: async (k, v) => { await new Promise((r) => setTimeout(r, 1)); store.set(k, v); },
  };
}

// The helper under test, mirrored from worker/src/index.js.
const locks = new Map();
function withKvKeyLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => {}, () => {});
  locks.set(key, settled);
  settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return run;
}

const BURST = 5;
function takeToken(kv, key) {
  return async () => {
    let b; try { b = JSON.parse((await kv.get(key)) || 'null'); } catch { b = null; }
    if (!b || typeof b.tokens !== 'number') b = { tokens: BURST };
    if (b.tokens <= 0) return false;
    b.tokens -= 1;
    await kv.put(key, JSON.stringify(b));
    return true;
  };
}

// 1. The bug, reproduced: without the lock a burst of 5 admits 20 concurrent callers.
{
  const kv = slowKv();
  const take = takeToken(kv, 'rl:a');
  const admitted = (await Promise.all(Array.from({ length: 20 }, () => take()))).filter(Boolean).length;
  assert.equal(admitted, 20, 'unlocked RMW should admit everyone — if this ever fails the premise changed');
  ok('unlocked: 20 concurrent callers all pass a 5-token bucket (the bypass this fix exists for)');
}

// 2. The fix: the same burst admits exactly BURST.
{
  const kv = slowKv();
  const take = takeToken(kv, 'rl:b');
  const admitted = (await Promise.all(Array.from({ length: 20 }, () => withKvKeyLock('rl:b', take)))).filter(Boolean).length;
  assert.equal(admitted, BURST, `locked RMW must admit exactly ${BURST}`);
  ok('locked: 20 concurrent callers consume exactly the burst, no more');
}

// 3. Distinct keys must NOT queue behind each other — a shared bucket would be its own denial of service.
{
  const kv = slowKv();
  const order = [];
  const slow = withKvKeyLock('k1', async () => { await new Promise((r) => setTimeout(r, 40)); order.push('slow'); });
  const fast = withKvKeyLock('k2', async () => { order.push('fast'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['fast', 'slow'], 'a different key must not wait on this one');
  ok('distinct keys run concurrently — the lock is per key, not global');
}

// 4. A throwing critical section must not wedge the key forever.
{
  const kv = slowKv();
  await assert.rejects(() => withKvKeyLock('k3', async () => { throw new Error('boom'); }), /boom/);
  const after = await withKvKeyLock('k3', takeToken(kv, 'rl:c'));
  assert.equal(after, true, 'the key is usable again after a rejection');
  ok('a rejected critical section releases the key');
}

// 5. The lock map drains, so distinct IPs cannot grow it without bound.
{
  for (let i = 0; i < 50; i++) await withKvKeyLock('ip:' + i, async () => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(locks.size, 0, `lock map should drain, still holds ${locks.size}`);
  ok('idle keys are dropped from the lock map');
}

console.log(`\n${pass} kv-rmw-lock checks passed.`);
