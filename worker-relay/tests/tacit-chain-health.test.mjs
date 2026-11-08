// The monitor's tacit chain verdicts: the leader's node behind the contract, a forced entry the leader leaves out, no prover for blocks.
import assert from 'node:assert/strict';
import { tacitChainVerdict, PROVER_SEEN_S } from '../src/lib/tacit-chain-health.js';

const now = 1_800_000_000;
const gpu = { name: 'tacit-a5000', programs: ['confidential', 'eth-state', 'tacit-block'], lastSeenSeconds: 3 };
const chain = (o = {}) => ({ height: 4, queued: 0, queueDone: 0, oldestQueuedAt: null, forceDelay: 3600, window: 600, ...o });
const levels = (v) => v.map((x) => x.level);

// all well
assert.deepEqual(tacitChainVerdict({ leader: { height: 4, pending: 0 }, chain: chain(), board: { workers: [gpu] }, now }), []);
// nothing read: nothing said (the caller alerts on a leader that does not answer)
assert.deepEqual(tacitChainVerdict({ leader: null, chain: null, board: null, now }), []);

// the leader's node behind the contract
const behind = tacitChainVerdict({ leader: { height: 3, pending: 0 }, chain: chain(), board: { workers: [gpu] }, now });
assert.deepEqual(levels(behind), ['warning']);
assert.match(behind[0].msg, /at block 3, the contract at 4/);

// a forced entry: quiet for 10 minutes, a warning after, critical at 3/4 of FORCE_DELAY, critical with "anyone may land" past FORCE_DELAY + WINDOW
const forced = (age) => tacitChainVerdict({ leader: { height: 4, pending: 0 }, chain: chain({ queued: 3, queueDone: 2, oldestQueuedAt: now - age }), board: { workers: [gpu] }, now });
assert.deepEqual(forced(5 * 60), []);
assert.deepEqual(levels(forced(11 * 60)), ['warning']);
assert.match(forced(11 * 60)[0].msg, /1 forced entry waiting, the oldest 11 min/);
assert.deepEqual(levels(forced(46 * 60)), ['critical']);
assert.match(forced(46 * 60)[0].msg, /14 min left/);
assert.deepEqual(levels(forced(71 * 60)), ['critical']);
assert.match(forced(71 * 60)[0].msg, /anyone may land/);

// no prover: a warning with nothing waiting, critical with spends waiting; a machine without tacit-block, or not seen lately, does not count
const stale = { ...gpu, lastSeenSeconds: PROVER_SEEN_S + 1 }, other = { ...gpu, programs: ['confidential'] };
assert.deepEqual(levels(tacitChainVerdict({ leader: { height: 4, pending: 0 }, chain: chain(), board: { workers: [stale, other] }, now })), ['warning']);
const none = tacitChainVerdict({ leader: { height: 4, pending: 2 }, chain: chain(), board: { workers: [] }, now });
assert.deepEqual(levels(none), ['critical']);
assert.match(none[0].msg, /2 spend\(s\) wait/);

console.log('tacit-chain-health: ok');
