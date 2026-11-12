// Bridges of one size that arrive together each wait for a pool note of exactly that size. The provider makes a note ready for a swap when it is
// accepted, and the adapter cuts one only when no note of the size is free: so the first swap's cut is found by the next, which skips its own, and
// only one of them can use it. On 2026-11-12 five bridges of 996.9 TAC arrived within two minutes; four sat in `locking` with "waiting for a pool
// note of the exact size" for the rest of the day, each marked as made ready already. The machine asks again when the note is not there.
//   node tests/fastbridge-el-prepare.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import { G, SECP_N } from '../dapp/bulletproofs.js';

const T = G.multiply(0x1234567890abcdefn % SECP_N);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const NOW = 1_700_000_100;

// A pool that holds `free` notes of the swaps' size; `prepare` models the adapter: it cuts one only when none is free.
function lp() {
  const pool = { free: 0, cuts: 0, locks: 0 }, calls = [], clk = { t: NOW };
  let expected = null;
  const evm = {
    now: async () => NOW,
    refundKey: async () => ({ xonly: new Uint8Array(32).fill(5) }),
    lockNullifier: (leaf) => { expected = leaf; return '0x' + 'cd'.repeat(32); },
    lockPosition: async () => null,
    lockOp: async () => { calls.push('lockOp'); if (pool.free > 0) { pool.free--; pool.locks++; return { op: { x: 1 }, lockLeaf: expected, noteLeaf: '0x' + 'aa'.repeat(32) + String(pool.locks) }; } return null; },
    prepare: async () => { calls.push('prepare'); if (pool.free === 0) { pool.free = 1; pool.cuts++; } },
  };
  const recs = new Map();
  const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
  const el = makeEthereumLocker({ seed: new Uint8Array(32), store, policy: { minCsv: 72, minClaimSecs: 3600, buildRetrySecs: 30, buildRetryMaxSecs: 600 }, quotes: { get: async () => null }, btc: {}, evm, counter: {}, now: () => clk.t });
  const swap = (n) => {
    const rec = { id: String(n).repeat(72).slice(0, 72), role: 'el', phase: 'locking', created: NOW - 600, deadline: NOW + 4 * 3600, prepared: true, csvBlocks: 144,
      offer: { T: hex(T.toRawBytes(true)), btc: {}, evm: { asset: '0x' + 'f0'.repeat(32), amount: '99690000000', recipient: '0x' + '07'.repeat(32), rOut: '0x' + '09'.repeat(32) } } };
    recs.set(rec.id, rec); return rec;
  };
  return { el, pool, calls, swap, recs, evm, advance: (s) => { clk.t += s; } };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('two swaps of one size that were both made ready against one note: the one that finds it gone has its own cut made, and both lock', async () => {
  const w = lp();
  w.pool.free = 1;                                    // the first swap's cut: one note for two swaps that each saw it and skipped theirs
  const a = w.swap(1), b = w.swap(2);
  const ra = await w.el.step(a);
  assert.ok(ra.lock, 'the first takes the note that is there');
  assert.equal(w.pool.cuts, 0, 'and cuts nothing');
  const rb = await w.el.step(b);
  assert.ok(rb.lock, 'the second, finding none, is made a note and locks (it used to wait for ever)');
  assert.equal(w.pool.cuts, 1, 'one cut, for the one that needed it');
  assert.equal(w.pool.locks, 2);
});

test('five together with one note between them: each is made one in turn, none waits for ever, and nothing is cut that is not needed', async () => {
  const w = lp();
  w.pool.free = 1;
  const swaps = [1, 2, 3, 4, 5].map((n) => w.swap(n));
  for (const s of swaps) assert.ok((await w.el.step(s)).lock, 'swap ' + s.id.slice(0, 2));
  assert.deepEqual([w.pool.locks, w.pool.cuts], [5, 4], 'five locks, four cuts: the one note and a cut for each of the rest');
});

test('a swap whose note is not there and cannot be made yet waits and is tried again after the backoff, not on every step', async () => {
  // a provider whose cut does not produce a note in time: lockOp stays null
  const f = (() => {
    const calls = []; let expected = null;
    const evm = { now: async () => NOW, refundKey: async () => ({ xonly: new Uint8Array(32).fill(5) }), lockNullifier: (l) => { expected = l; return '0x' + 'cd'.repeat(32); }, lockPosition: async () => null,
      lockOp: async () => { calls.push('lockOp'); return null; }, prepare: async () => { calls.push('prepare'); } };
    const recs = new Map(); let t = NOW;
    const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
    const el = makeEthereumLocker({ seed: new Uint8Array(32), store, policy: { minCsv: 72, minClaimSecs: 3600, buildRetrySecs: 30, buildRetryMaxSecs: 600 }, quotes: { get: async () => null }, btc: {}, evm, counter: {}, now: () => t });
    const rec = { id: '3'.repeat(72), role: 'el', phase: 'locking', created: NOW - 600, deadline: NOW + 4 * 3600, prepared: true, csvBlocks: 144, offer: { T: hex(T.toRawBytes(true)), btc: {}, evm: { asset: '0x' + 'f0'.repeat(32), amount: '99690000000', recipient: '0x' + '07'.repeat(32), rOut: '0x' + '09'.repeat(32) } } };
    recs.set(rec.id, rec);
    return { el, rec, calls, at: (s) => { t = NOW + s; } };
  })();
  const r1 = await f.el.step(f.rec);
  assert.match(r1.why, /waiting for a pool note of the exact size/);
  assert.equal(f.calls.filter((c) => c === 'prepare').length, 1, 'made ready once on this try');
  await f.el.step(f.rec); await f.el.step(f.rec);
  assert.equal(f.calls.filter((c) => c === 'prepare').length, 1, 'not again within the backoff: the wallet is not read on every step');
  f.at(31);
  await f.el.step(f.rec);
  assert.equal(f.calls.filter((c) => c === 'prepare').length, 2, 'again once the backoff has passed');
});

test('a swap that failed and then moves on has no error left to show: the last error stands only while the phase does not change', async () => {
  const w = lp();
  w.pool.free = 1;
  const a = w.swap(1), built = w.evm.lockOp;
  w.evm.lockOp = async () => { throw new Error('insufficient ETH for gas'); };
  const r1 = await w.el.step(a);
  assert.match(r1.lastError, /insufficient ETH/);
  w.evm.lockOp = built;
  w.advance(31);
  const r2 = await w.el.step(a);
  assert.equal(r2.phase, 'locking', 'the lock is built, and the swap is still locking');
  assert.match(r2.lastError, /insufficient ETH/, 'its last error stands until it moves on');
  w.evm.lockPosition = async () => ({ at: 1 });                 // the lock is in the pool
  const r3 = await w.el.step(a);
  assert.equal(r3.phase, 'locked');
  assert.equal(r3.lastError, null, 'moved on: an alert for it no longer quotes the old failure');
  assert.equal((await w.recs.get(a.id)).lastError, null, 'and the stored record says so too');
});

test('a swap that ends without a lock keeps its last error: it says why', async () => {
  const w = lp();
  const a = w.swap(2);
  w.evm.lockOp = async () => { throw new Error('no single note covers the amount'); };
  const r1 = await w.el.step(a);
  assert.match(r1.lastError, /no single note covers/);
  a.deadline = NOW + 100;                                        // less than minClaimSecs left: too late to lock
  w.advance(31);
  const r2 = await w.el.step(a);
  assert.equal(r2.phase, 'aborted');
  assert.match(r2.lastError, /no single note covers/, 'the reason it could not lock stays on the record');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} provider note-cut checks passed`);
process.exit(process.exitCode || 0);
