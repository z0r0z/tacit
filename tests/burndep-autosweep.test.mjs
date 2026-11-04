#!/usr/bin/env node
// The automatic registration of stranded burns (autoSweepStrandedBurns, run from the 5-minute tick) and the sweep under it
// (sweepPendingBurnDeposits): a burn the reflection holds pending with no bundle registered is built and its bundle runs the FULL admission
// check (the one POST /reflection/burndep/check runs) before it is stored; a registered burn is left for the next fold; the automatic pass
// cannot overlap itself, takes a lease, can be switched off, re-checks stored registrations only once an hour and does not retry a burn that
// failed for half an hour. The chain reads and the check are stood in.
//   node tests/burndep-autosweep.test.mjs
import assert from 'node:assert';
import { sweepPendingBurnDeposits, autoSweepStrandedBurns, assetKey } from '../worker/src/index.js';

const txid = (n) => n.toString(16).padStart(2, '0').repeat(32);
const ASSET = txid(99);
const records = [1, 2, 3].map((n) => ({ key: '0x' + txid(n + 10), burnedTxid: txid(n + 10), burnedVout: 0, burnTxidDisplay: txid(n), asset: '0x' + ASSET, completed: false }));
const kv = () => {
  const m = new Map([
    ['reflection:scan:mainnet', JSON.stringify({ attestedHeight: 100, snapshot: { pendingDepositRecords: records } })],
    [assetKey('mainnet', ASSET), JSON.stringify({ etch_txid: txid(77), etch_vout: 0 })],
  ]);
  return { m, async get(k, mode) { const v = m.has(k) ? m.get(k) : null; return v !== null && mode === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } };
};
const regKey = (n) => `reflection:burndep:mainnet:${txid(n)}`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => (String(url).endsWith('/hex') ? new Response('00'.repeat(20), { status: 200 }) : new Response('not found', { status: 404 }));
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const built = (tag) => async () => ({ bundle: { etch: { blockHeight: 1 }, tag }, hops: 1 });

try {
  // ── the sweep ──
  {
    const store = kv(), checks = [];
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async (net, body) => { checks.push(body); return { status: 200, body: { admitted: true } }; } };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 1, build: built('b1') });
    ok(r.attempted === 1 && r.registered === 1 && checks.length === 1, `an unregistered burn is built, checked once and registered (attempted ${r.attempted}, registered ${r.registered}, ${checks.length} check)`);
    ok(checks[0].bundle.tag === 'b1' && /^0x/.test(checks[0].burnTxHex), 'the check is given the built bundle and the burn read from the chain');
    ok(JSON.parse(store.m.get(regKey(1))).tag === 'b1', 'the registration is the built bundle');
  }
  {
    const store = kv();
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => ({ status: 200, body: { admitted: false, reason: 'range proof' } }) };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 1, build: built('bad') });
    ok(r.registered === 0 && r.errors.length === 1 && /full admission check/.test(r.errors[0].error), 'a bundle the full check does not admit is not stored, and the sweep says so');
    ok(!store.m.has(regKey(1)), 'nothing was written for that burn');
  }
  {
    const store = kv(); store.m.set(regKey(1), JSON.stringify({ tag: 'waiting for a fold' }));
    let calls = 0;
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => { calls++; return { status: 200, body: { admitted: true } }; } };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 3, checkStored: false, build: built('new') });
    ok(JSON.parse(store.m.get(regKey(1))).tag === 'waiting for a fold', 'checkStored false: a registered burn is left exactly as it was');
    ok(calls === 2 && r.registered === 2 && r.skipped === 1 && r.checked === 0, `...and the two unregistered burns are built and checked (${calls} checks, registered ${r.registered}, skipped ${r.skipped})`);
  }
  {
    const store = kv(); let calls = 0;
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => { calls++; return { status: 200, body: { admitted: true } }; } };
    const skipped = [];
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 3, build: built('x'), skip: (t) => { skipped.push(t); return t === txid(2); } });
    ok(r.registered === 2 && !store.m.has(regKey(2)) && store.m.has(regKey(1)) && store.m.has(regKey(3)), 'skip(txid) passes over a burn the caller has just failed on');
  }

  // ── the automatic pass ──
  const noSweep = async () => ({ attempted: 0, registered: 0, checked: 0, skipped: 0, errors: [] });
  {
    const env = { REGISTRY_KV: kv(), BURNDEP_AUTOSWEEP: '0' }; let called = 0;
    const r = await autoSweepStrandedBurns(env, 'mainnet', { sweep: async () => { called++; return noSweep(); } });
    ok(r === null && called === 0, 'BURNDEP_AUTOSWEEP=0 turns it off');
  }
  {
    const env = { REGISTRY_KV: kv() }; let release, entered = 0;
    const slow = () => new Promise((res) => { entered++; release = () => res({ attempted: 1, registered: 1, checked: 0, skipped: 0, errors: [] }); });
    const first = autoSweepStrandedBurns(env, 'mainnet', { sweep: slow });
    await new Promise((r) => setTimeout(r, 5));
    const second = await autoSweepStrandedBurns(env, 'mainnet', { sweep: slow });
    ok(second === null && entered === 1, 'a second pass while one is running does nothing');
    release(); const r1 = await first;
    ok(r1 && r1.registered === 1, 'the first pass finishes normally');
    const third = await autoSweepStrandedBurns({ REGISTRY_KV: kv() }, 'mainnet', { sweep: noSweep });
    ok(third && third.attempted === 0, 'and the next pass (a fresh store) can run');
  }
  {
    const store = kv(); store.m.set('reflection:burndep:autosweep-lease:mainnet', '1'); let called = 0;
    const r = await autoSweepStrandedBurns({ REGISTRY_KV: store }, 'mainnet', { sweep: async () => { called++; return noSweep(); } });
    ok(r === null && called === 0, 'a lease held by the other API instance makes this pass stand down');
    const fresh = kv(); await autoSweepStrandedBurns({ REGISTRY_KV: fresh }, 'mainnet', { sweep: noSweep });
    ok(fresh.m.has('reflection:burndep:autosweep-lease:mainnet'), 'a pass takes the lease');
  }
  {
    const seen = [];
    const sweep = async (e, net, opts) => { seen.push(opts); return noSweep(); };
    for (const tickIdx of [0, 1, 5, 11, 12, 13, 24]) await autoSweepStrandedBurns({ REGISTRY_KV: kv() }, 'mainnet', { tickIdx, sweep });
    ok(seen.map((o) => o.checkStored).join() === 'true,false,false,false,true,false,true', 'stored registrations are re-checked once an hour (every 12th tick), not on every tick');
    ok(seen.every((o) => o.maxCount === 2), 'at most two burns a pass');
  }
  {
    let t = 1_000_000_000; const failFor = txid(42); let skipFn = null;
    // like the real sweep, a burn the pass is told to skip is not attempted, so it reports nothing
    const sweep = async (e, net, opts) => {
      skipFn = opts.skip;
      return opts.skip(failFor) ? noSweep() : { attempted: 1, registered: 0, checked: 0, skipped: 0, errors: [{ burnTxidDisplay: '0x' + failFor, error: 'dangling lineage' }] };
    };
    await autoSweepStrandedBurns({ REGISTRY_KV: kv() }, 'mainnet', { now: () => t, sweep });
    t += 10 * 60_000;
    await autoSweepStrandedBurns({ REGISTRY_KV: kv() }, 'mainnet', { now: () => t, sweep });
    ok(skipFn(failFor) === true && skipFn(txid(43)) === false, 'a burn that failed ten minutes ago is passed over; another is not');
    t += 25 * 60_000;
    await autoSweepStrandedBurns({ REGISTRY_KV: kv() }, 'mainnet', { now: () => t, sweep: async (e, net, opts) => { skipFn = opts.skip; return noSweep(); } });
    ok(skipFn(failFor) === false, 'and tried again once half an hour has passed');
  }
  {
    const r = await autoSweepStrandedBurns({}, 'mainnet', { sweep: noSweep });
    ok(r === null, 'no store, no pass');
  }
} finally { globalThis.fetch = realFetch; }
console.log(`${n} checks`);
