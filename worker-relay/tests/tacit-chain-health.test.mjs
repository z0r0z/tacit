// The monitor's tacit chain verdicts: the leader's node behind the contract, a forced entry the leader leaves out, no prover for blocks.
import assert from 'node:assert/strict';
import { tacitChainVerdict, paymentsWaiting, PROVER_SEEN_S } from '../src/lib/tacit-chain-health.js';

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
assert.deepEqual(levels(behind), ['critical']);
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

// what waits: a shield waits on its deposit and is held out of blocks, so only payments the leader lists notes for are spends a block is late to take
const lists = (answer) => async (path) => { assert.equal(path, '/pending-notes'); if (answer instanceof Error) throw answer; return answer; };
assert.equal(await paymentsWaiting({ pending: 0 }, async () => { throw new Error('asked with nothing pending'); }), 0);
assert.equal(await paymentsWaiting({ pending: 2 }, lists({ leaves: [], memos: [] })), 0, 'shields alone: nothing for a block to take');
assert.equal(await paymentsWaiting({ pending: 2 }, lists({ leaves: ['0x11'], memos: ['0x22'] })), 2, 'a payment is held: the leader\'s count stands');
assert.equal(await paymentsWaiting({ pending: 2 }, lists(new Error('HTTP 404'))), 2, 'a leader without the list is taken at its count');
assert.equal(await paymentsWaiting({ pending: 2 }, lists({ error: 'not here' })), 2, 'an answer that is not a list is taken at the count');
assert.equal(await paymentsWaiting(null, lists({ leaves: [] })), 0);
const shieldsOnly = await paymentsWaiting({ pending: 2 }, lists({ leaves: [], memos: [] }));
assert.deepEqual(levels(tacitChainVerdict({ leader: { height: 4, pending: shieldsOnly }, chain: chain(), board: { workers: [] }, now })), ['warning'], 'no prover and only shields waiting: a warning, not spends waiting');

console.log('tacit-chain-health: ok');
