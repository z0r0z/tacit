// lib/points-root-guard.js: when the root setter's key may sign a root.
// Run: node worker-relay/tests/points-root-guard.test.mjs
import assert from 'node:assert/strict';
import { rootProblems, parseSent, withSent, parseAccept, SENT_ROOTS_MAX } from '../src/lib/points-root-guard.js';

let n = 0;
const ok = (label) => { console.log(`  ok - ${label}`); n++; };
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const R1 = '0x' + '1'.repeat(64), R2 = '0x' + '2'.repeat(64), R3 = '0x' + '3'.repeat(64), ZERO = '0x' + '0'.repeat(64);
const tree = (root, amounts) => ({ root, totalWei: String(Object.values(amounts).reduce((s, v) => s + v, 0n)), claims: Object.fromEntries(Object.entries(amounts).map(([a, v]) => [a, { cumulativeAmount: String(v) }])) });
const prev = { publishedAmounts: [[A, '100'], [B, '50']], publishedTotalWei: '150', publishedRoot: R1 };

assert.deepEqual(rootProblems({ tree: tree(R2, { [A]: 120n, [B]: 50n, [C]: 10n }), ...prev, onchain: { root: R1, totalAllocated: 150n } }), []);
ok('a tree that only adds, over the root this service published, may go');

assert.deepEqual(rootProblems({ tree: tree(R1, { [A]: 100n }), publishedAmounts: [], publishedTotalWei: null, publishedRoot: null, onchain: { root: ZERO, totalAllocated: 0n } }), []);
ok('the first publish, onto an empty distributor, may go');

assert.equal(rootProblems({ tree: tree(R2, { [A]: 90n, [B]: 100n }), ...prev, onchain: { root: R1, totalAllocated: 150n } }).length, 1);
ok('an account holding less than in the published tree holds the publish');

assert.ok(rootProblems({ tree: tree(R2, { [A]: 100n }), ...prev, onchain: { root: R1, totalAllocated: 150n } }).some((w) => /below the published|hold less/.test(w)));
ok('a total below the published one holds the publish');

assert.equal(rootProblems({ tree: tree(R2, { [A]: 100n, [B]: 50n, [C]: 1n }), ...prev, onchain: { root: R3, totalAllocated: 9_000n } }).length, 2);
ok('a root on the distributor this service did not send holds the publish');

assert.deepEqual(rootProblems({ tree: tree(R2, { [A]: 100n, [B]: 50n, [C]: 1n }), ...prev, onchain: { root: R3, totalAllocated: 9_000n }, known: [R3] }), []);
ok('a root the service sent (receipt missed) or the operator named is accepted');

assert.equal(rootProblems({ tree: tree(R2, { [A]: 100n }), publishedAmounts: [], publishedTotalWei: null, publishedRoot: null, onchain: { root: R3, totalAllocated: 5n } }).length, 1);
ok('a distributor with a root, and no record of publishing one, holds the publish');

let list = [];
for (let i = 0; i < SENT_ROOTS_MAX + 3; i++) list = withSent(list, '0x' + String(i).padStart(64, '0'));
assert.equal(list.length, SENT_ROOTS_MAX);
assert.deepEqual(parseSent(JSON.stringify(list)), list);
assert.deepEqual(parseSent('nope'), []);
assert.deepEqual(parseAccept(` ${R1}, junk ,${R2}`), [R1, R2]);
ok('the sent list keeps the newest few, and parses what it wrote');

console.log(`\n${n}/8 points-root-guard checks passed`);
