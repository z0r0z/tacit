#!/usr/bin/env node
// What a move of a bridged note asks the trading address for: the commit and the reveal at the fee rate now, not a flat 5,000 sats.
import assert from 'node:assert/strict';
import { moveSatsNeeded, MOVE_SATS_FLAT } from '../dapp/btc-book.js';

assert.equal(MOVE_SATS_FLAT, 5000);
assert.equal(await moveSatsNeeded(() => 1), 2000, 'at 1 sat/vB the two transactions are their 500-sat floors with room: 2,000, not 5,000');
assert.equal(await moveSatsNeeded(async () => 2), 2500);
assert.equal(await moveSatsNeeded(() => 10), 9500, 'at 10 sat/vB the flat 5,000 would have fallen short');
assert.ok((await moveSatsNeeded(() => 3)) < 5000 && (await moveSatsNeeded(() => 6)) > 5000, 'the flat sum sat between about 3 and 6 sat/vB');
assert.equal(await moveSatsNeeded(() => 0), 5000, 'a rate of nothing is no reading');
assert.equal(await moveSatsNeeded(() => NaN), 5000);
assert.equal(await moveSatsNeeded(() => undefined), 5000, 'a page with no fee rate keeps the flat sum');
assert.equal(await moveSatsNeeded(() => { throw new Error('offline'); }), 5000);
assert.equal(await moveSatsNeeded(async () => { throw new Error('offline'); }), 5000);
let last = 0;
for (const r of [1, 2, 4, 8, 16, 32]) { const n = await moveSatsNeeded(() => r); assert.ok(n >= last && n % 500 === 0, `rounded up to 500s and never falling as the rate rises (${r}: ${n})`); last = n; }
// Under 1 sat/vB (the network is taking such rates) the two transactions' floors are 150 sats, not 500: at 0.26 sat/vB (times the 1.5 spare, 0.39) 546 + 150 + 170 rounds to 1,000.
assert.equal(await moveSatsNeeded(() => 0.26), 1000, 'a backlog-time move asks 1,000, not the 2,000 it asked at 1 sat/vB');
assert.equal(await moveSatsNeeded(() => 0.6), 1500, 'at 0.6 (0.9 with the spare) the reveal is over its floor: 546 + 150 + 392');
assert.equal(await moveSatsNeeded(() => 0.7), 2000, 'with the spare at 1.05 the 500-sat floors apply again: 546 + 500 + 500');
console.log('btc-move-fee: ok');
