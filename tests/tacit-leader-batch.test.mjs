// The leader's block timing (tacit-leader/fees.mjs blockReady): at once while gas is cheap, a short wait for company when it is not.
import assert from 'node:assert/strict';
import { blockReady } from '../tacit-leader/fees.mjs';

const gwei = (g) => BigInt(Math.round(g * 1e9));
const at = (o) => blockReady({ now: 100_000, firstSeen: 100_000, minSpends: 1, maxWaitMs: 20e3, batchGwei: 0.5, target: 4, waitMs: 90e3, ...o });

assert.equal(at({ waiting: 0, baseFee: gwei(0.05) }), false, 'nothing waiting: no block');
assert.equal(at({ waiting: 1, baseFee: gwei(0.05) }), true, 'cheap gas: one payment lands at once');
assert.equal(at({ waiting: 1, baseFee: gwei(0.5) }), true, 'at the threshold: at once');
assert.equal(at({ waiting: 1, baseFee: gwei(3) }), false, 'dear gas: one payment waits for company');
assert.equal(at({ waiting: 3, baseFee: gwei(3) }), false, '... three still wait');
assert.equal(at({ waiting: 4, baseFee: gwei(3) }), true, '... four go');
assert.equal(at({ waiting: 1, baseFee: gwei(3), firstSeen: 100_000 - 90_000 }), true, '... and one goes once it waited the longest wait');
assert.equal(at({ waiting: 0, forced: 1, baseFee: gwei(30) }), true, 'a forced entry goes at once whatever the gas');
assert.equal(at({ waiting: 1, baseFee: gwei(0.05), minSpends: 3 }), false, 'the leader\'s own floor still holds');
assert.equal(at({ waiting: 1, baseFee: gwei(0.05), minSpends: 3, firstSeen: 100_000 - 20_000 }), true, '... until its own wait');
console.log('tacit-leader-batch: ok');
