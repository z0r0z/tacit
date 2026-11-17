#!/usr/bin/env node
// A finished box does not stay in the keeper's store for ever. Run: node worker-relay/tests/keeper-prune.test.mjs
import assert from 'node:assert';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';

const s = openKeeperStore(':memory:');
const DAY = 86400, T0 = 1_000_000;
const add = (box, kind, now) => s.addIntent({ box, kind, intent: { box, npk: '0x' + 'aa'.repeat(32) }, hint: null, reward: 0n, token: '0x' + '0'.repeat(40), deadline: now + DAY, now });
const A = (n) => '0x' + String(n).padStart(40, '0');
add(A(1), 'deposit', T0); s.update(A(1), { status: 'completed', note: 'swept', updated: T0 });       // done and settled: goes
add(A(2), 'deposit', T0); s.update(A(2), { status: 'completed', note: '', updated: T0 });            // done, leftover still to settle: stays
add(A(3), 'deposit', T0); s.update(A(3), { status: 'expired', updated: T0 });                        // lapsed: goes
add(A(4), 'receive', T0);                                                                            // watched, not terminal: stays
add(A(5), 'deposit', T0 + 6 * DAY); s.update(A(5), { status: 'completed', note: 'swept', updated: T0 + 6 * DAY }); // recent: stays
const gone = s.pruneTerminal(T0 + 8 * DAY, 7 * DAY);
assert.strictEqual(gone, 2, 'two rows are old and finished');
assert.strictEqual(s.get(A(1)), undefined, 'a finished, settled box is gone');
assert.strictEqual(s.get(A(3)), undefined, 'an expired box is gone');
assert.ok(s.get(A(2)), 'a completed deposit with a leftover to settle is kept');
assert.ok(s.get(A(4)), 'a watched receive box is kept');
assert.ok(s.get(A(5)), 'a recent finished box is kept');
console.log('  ok - finished boxes older than the limit are dropped; live ones and unsettled leftovers stay\n1 passed');
