#!/usr/bin/env node
// worker/src/chain-anonymity.js: the Tacit chain's notes made / spent / unspent from the leader's /state, growth over the last day and week from an
// hourly reading, one leader read a minute, the last good counts (marked stale) while the leader is down, and a fresh history after a rebuild.
//   node tests/chain-anonymity.test.mjs
import assert from 'node:assert';
import { makeChainAnonymity, reading, HOUR_MS } from '../worker/src/chain-anonymity.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, m }; };
const state = (o = {}) => ({ chain: '0x1', height: 479, leaves: 1277, nullifiers: 571, spends: 483, pending: 1, pool: '3647141930469', shares: '3598406971539', ...o });

assert.strictEqual(reading({ ...state(), leaves: -1 }), null);
assert.strictEqual(reading({ ...state(), nullifiers: 2000 }), null, 'more spent than made is not a chain state');
assert.strictEqual(reading({ ...state(), height: 'x' }), null);
assert.strictEqual(reading(null), null);
assert.strictEqual(reading({ ...state(), pool: 'abc' }).pool, null, 'a pool figure that is not a number is left out');
ok('a /state answer that is not a chain state is refused');

let T = 1_700_000_000_000, cur = state(), reads = 0, down = false;
const st = mem();
const mk = (extra = {}) => makeChainAnonymity({ read: async () => { reads++; if (down) throw new Error('down'); return cur; }, storage: st, now: () => T, ...extra });
let a = mk();
let v = await a.summary();
assert.strictEqual(v.notes, 1277); assert.strictEqual(v.spent, 571); assert.strictEqual(v.unspent, 706); assert.strictEqual(v.spends, 483);
assert.strictEqual(v.pool, '3647141930469'); assert.strictEqual(v.poolDecimals, 8); assert.strictEqual(v.stale, false);
assert.strictEqual(v.d1, null); assert.strictEqual(v.d7, null);
ok('the counts come from the leader; with one reading there is no growth to report');

await a.summary(); await a.summary();
assert.strictEqual(reads, 1, 'answers inside the minute reuse one leader read');
ok('a busy page costs one leader read a minute');

// two days of hourly readings, +10 notes, +4 spent, +3 spends an hour
for (let i = 1; i <= 48; i++) {
  T += HOUR_MS; cur = state({ height: 479 + i, leaves: 1277 + 10 * i, nullifiers: 571 + 4 * i, spends: 483 + 3 * i });
  v = await a.summary();
}
assert.deepStrictEqual(v.d1, { secs: 24 * 3600, notes: 240, spent: 96, spends: 72 });
assert.strictEqual(v.d7.secs, 48 * 3600); assert.strictEqual(v.d7.notes, 480);
ok('growth is read against the oldest reading inside the window; a history shorter than a week reports its true span');

// a week and a half on: old readings drop out
for (let i = 0; i < 9 * 24; i++) { T += HOUR_MS; cur = state({ leaves: cur.leaves + 1, nullifiers: cur.nullifiers, spends: cur.spends + 1, height: cur.height + 1 }); v = await a.summary(); }
assert.ok(v.d7.secs <= 7 * 24 * 3600 && v.d7.secs >= 7 * 24 * 3600 - 3600);
assert.ok(JSON.parse(st.m.get('chainanon:v1')).hist.length <= 8 * 24 + 1, 'only eight days are kept');
ok('only the last eight days of readings are kept');

// a restart reads the stored history again
const before = v.d1; reads = 0;
a = mk(); T += 61000; cur = state({ leaves: cur.leaves + 1, nullifiers: cur.nullifiers, spends: cur.spends, height: cur.height });
v = await a.summary();
assert.ok(v.d1 && v.d1.secs <= 24 * 3600 && v.d1.secs > 23 * 3600, 'history survives a restart');
ok('the history is kept in storage');

// leader down: the last good counts, marked stale
down = true; T += 120000; a = mk(); const lastNotes = cur.leaves;
v = await a.summary();
assert.strictEqual(v.stale, true); assert.strictEqual(v.notes, lastNotes);
ok('while the leader is down the last good counts are served, marked stale');

// no history and the leader down: an error, not zeros
const a2 = makeChainAnonymity({ read: async () => { throw new Error('down'); }, storage: mem(), now: () => T });
await assert.rejects(a2.summary(), /not answering/);
ok('with nothing stored and the leader down it errors rather than answer zeros');

// a rebuilt leader (counts went backwards) starts the history again
down = false; cur = state({ leaves: 10, nullifiers: 2, spends: 4, height: 3 }); T += 120000; a = mk();
v = await a.summary();
assert.strictEqual(v.notes, 10); assert.strictEqual(v.d1, null);
ok('counts that went backwards (a leader rebuilt from scratch) restart the history');

console.log(`\n${n} passed`);
