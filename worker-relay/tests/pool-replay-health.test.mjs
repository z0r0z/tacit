// lib/pool-replay-health.js: the monitor's verdict on the Bitcoin pool's replay service.
// Run: node worker-relay/tests/pool-replay-health.test.mjs
import assert from 'node:assert/strict';
import { poolReplayVerdict } from '../src/lib/pool-replay-health.js';

const ok = { confirmations: 3, height: 977161, tip: 977163, verifierEnabled: true, halted: null, lastError: null, sources: [] };
assert.equal(poolReplayVerdict(ok).level, 'ok');
assert.equal(poolReplayVerdict(ok).lag, 0, 'the replay waits for 3 confirmations: 977161 is the newest block it owes');
assert.equal(poolReplayVerdict({ ...ok, height: 977160 }).lag, 1);
assert.equal(poolReplayVerdict({ ...ok, height: 977159 }).lag, 2);

// the 2026-11-23 incident: halted at 977127 reading a shield input's ancestry, 35 blocks owed
const stuck = {
  ...ok, height: 977126, tip: 977163, lastError: 'fetch failed',
  halted: { height: 977127, txid: '7a'.repeat(32), reason: 'shield input unresolved: validating 0979…:0: tx 4966…: fetch failed' },
  sources: [{ source: 'mempool.space/api', restingSecs: 120, fails: 3, last: 'HTTP 429' }, { source: 'blockstream.info/api', restingSecs: 0, fails: 0, last: null }],
};
const v = poolReplayVerdict(stuck);
assert.equal(v.level, 'critical');
assert.equal(v.lag, 35);
assert.match(v.why, /halted at 977127: shield input unresolved/);
assert.match(v.why, /mempool\.space\/api 120 s \(HTTP 429\)/, 'says which source is resting and why');
assert.doesNotMatch(v.why, /blockstream/, 'a source that is up is not listed as resting');

// how soon it speaks up
assert.equal(poolReplayVerdict({ ...ok, height: 977159 }).level, 'ok', '2 blocks owed, not halted: it is working');
assert.equal(poolReplayVerdict({ ...ok, height: 977159, halted: { height: 977160, reason: 'x' } }).level, 'warning', 'halted and 2 owed: warn now');
assert.equal(poolReplayVerdict({ ...ok, height: 977158 }).level, 'warning', '3 owed: warn');
assert.equal(poolReplayVerdict({ ...ok, height: 977151 }).level, 'warning', '10 owed');
assert.equal(poolReplayVerdict({ ...ok, height: 977150 }).level, 'warning', '11 owed');
assert.equal(poolReplayVerdict({ ...ok, height: 977149 }).level, 'critical', '12 owed, about two hours: page');
assert.equal(poolReplayVerdict({ ...ok, height: 977160, halted: { height: 977161, reason: 'x' } }).level, 'ok', 'halted with 1 owed is one retry away');
assert.equal(poolReplayVerdict({ ...ok, height: 977145 }, { warn: 20, critical: 40 }).level, 'ok');

// other ways it is not serving
assert.equal(poolReplayVerdict({ ...ok, verifierEnabled: false, verifierReason: 'wasm missing' }).level, 'critical');
assert.match(poolReplayVerdict({ ...ok, verifierEnabled: false, verifierReason: 'wasm missing' }).why, /wasm missing/);
assert.equal(poolReplayVerdict({ ...ok, height: null }).level, 'critical', 'never started');
assert.equal(poolReplayVerdict({ ...ok, tip: null, lastError: 'every source is resting' }).level, 'unknown', 'no chain tip to compare to');
assert.match(poolReplayVerdict({ ...ok, tip: null, lastError: 'every source is resting' }).why, /every source is resting/);
assert.equal(poolReplayVerdict(null).level, 'unknown');
assert.equal(poolReplayVerdict('nope').level, 'unknown');
assert.equal(poolReplayVerdict({ ...ok, height: 977170 }).lag, 0, 'a source behind the replay is not a negative lag');
console.log('ok - pool replay: ok when it keeps up, warns when halted or 3 blocks behind, pages at 12, names the sources that rest, unknown when unread');
