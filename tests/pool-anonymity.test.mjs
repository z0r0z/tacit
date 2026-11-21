#!/usr/bin/env node
// worker/src/pool-anonymity.js: deposits per asset from the public event index's rows, counted in 30-day and 7-day windows, resumed from a stored
// cursor (a second summary reads only the new rows), counted afresh when the index was rebuilt, and answered from the last counts when the index is down.
//   node tests/pool-anonymity.test.mjs
import assert from 'node:assert';
import { makePoolAnonymity, crowd, DAY_BLOCKS } from '../worker/src/pool-anonymity.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), ETH = '0x' + 'ee'.repeat(32);
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, m }; };

// a fake index over a growing list of rows
function fakeIndex(rows, block) {
  const calls = [];
  const idx = {
    rows, block, down: false, calls,
    async fresh() { if (idx.down) throw new Error('rpc down'); },
    async read({ from, limit }) {
      calls.push(from);
      const entries = idx.rows.slice(from, from + limit).map((r, i) => ({ seq: from + i, ...r }));
      return { total: idx.rows.length, next: from + entries.length, entries, indexedToBlock: idx.block, headBlock: idx.block + 3, synced: true };
    },
  };
  return idx;
}
const wrap = (assetId, block) => ({ type: 'wrap', assetId, block, amount: '1' });
const day = (d, off = 0) => d * DAY_BLOCKS + off;

const NOW = day(100);
const rows = [
  wrap(A, day(100, 5)), wrap(A, day(99, 5)), wrap(A, day(90)), wrap(A, day(70)),   // A: 2 in the last 7 days, 3 in 30, 4 ever
  wrap(B, day(50)),                                                                 // B: old: none in 30
  { type: 'leaves', block: day(100), first: 0, leaves: [], memos: [] },            // not a deposit
  { type: 'nullifiers', block: day(100), nullifiers: [] },
  wrap(ETH, day(100, 1)),
];
const idx = fakeIndex(rows, NOW + 50), st = mem();
const anon = makePoolAnonymity({ index: idx, storage: st, pool: '0xPool', names: { [ETH]: 'cETH' }, ttlMs: 0 });
let v = await anon.summary();
assert.deepStrictEqual(v.assets[A], { total: 4, d30: 3, d7: 2 });
assert.deepStrictEqual(v.assets[B], { total: 1, d30: 0, d7: 0 });
assert.deepStrictEqual(v.assets[ETH], { total: 1, d30: 1, d7: 1, ticker: 'cETH' });
assert.strictEqual(v.asOf, NOW + 50); assert.strictEqual(v.windowDays, 30); assert.strictEqual(v.synced, true);
ok('deposits are counted per asset in the 30-day, 7-day and all-time windows; other rows and non-deposits are not counted; a ticker is named when known');

idx.rows.push(wrap(A, day(100, 40)), wrap(A, day(100, 41)));
idx.calls.length = 0;
v = await anon.summary();
assert.strictEqual(v.assets[A].total, 6); assert.strictEqual(v.assets[A].d7, 4);
assert.deepStrictEqual(idx.calls, [8], 'a second summary reads only the rows after its cursor');
ok('it resumes from its stored cursor: only the new rows are read, and counted once');

const again = makePoolAnonymity({ index: idx, storage: st, pool: '0xPool', ttlMs: 0 });
idx.calls.length = 0;
v = await again.summary();
assert.strictEqual(v.assets[A].total, 6); assert.deepStrictEqual(idx.calls, [10]);
ok('a new process picks up the stored counts, not a rescan');

idx.rows = [wrap(B, day(100))];
v = await again.summary();
assert.deepStrictEqual(v.assets[B], { total: 1, d30: 1, d7: 1 }); assert.strictEqual(v.assets[A], undefined);
ok('an index rebuilt behind the cursor is counted again from its start');

idx.down = true; idx.rows.push(wrap(B, day(100, 9)));
v = await again.summary();
assert.strictEqual(v.assets[B].total, 2);
ok('with the node down it still serves what the index holds');

// old days fall away after 45 days, and the window moves with the head
const idx2 = fakeIndex([wrap(A, day(10)), wrap(A, day(60))], day(100));
const a2 = makePoolAnonymity({ index: idx2, storage: mem(), pool: '0xP2', ttlMs: 0 });
v = await a2.summary();
assert.strictEqual(v.assets[A].d30, 0); assert.strictEqual(v.assets[A].total, 2);
ok('deposits older than the window are in the total only');

// a cache: a second call inside the ttl does not read again
const idx3 = fakeIndex([wrap(A, day(100))], day(100)), a3 = makePoolAnonymity({ index: idx3, storage: mem(), pool: '0xP3', ttlMs: 60000 });
await a3.summary(); idx3.calls.length = 0; await a3.summary();
assert.strictEqual(idx3.calls.length, 0);
ok('an answer is reused inside its ttl');

assert.deepStrictEqual([crowd(0), crowd(9), crowd(10), crowd(99), crowd(100)], ['low', 'low', 'fair', 'fair', 'strong']);
ok('the labels: under 10 low, under 100 fair, then strong');
console.log(`\n${n} passed`);
