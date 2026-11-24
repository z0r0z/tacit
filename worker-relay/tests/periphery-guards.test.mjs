// lib/periphery-guards.js: the verdict the monitor pages on for the periphery contracts.
// Run: node worker-relay/tests/periphery-guards.test.mjs
import assert from 'node:assert/strict';
import { peripheryVerdict } from '../src/lib/periphery-guards.js';

let n = 0;
const ok = (label) => { console.log(`  ok - ${label}`); n++; };
const R1 = '0x' + '1'.repeat(64), R2 = '0x' + '2'.repeat(64);

assert.equal(peripheryVerdict({ claimBond: 0n, funder: { tac: 0n, wtac: 0n }, points: { onchainRoot: R1, publishedRoot: R1, rootsSent: [] } }).level, 'ok');
assert.equal(peripheryVerdict({}).level, 'ok');
ok('no bond, an empty funder and a root as sent is ok; unread parts are skipped');

assert.equal(peripheryVerdict({ claimBond: 1n }).level, 'critical');
ok('any claim bond on the market is critical');

assert.equal(peripheryVerdict({ funder: { tac: 1n, wtac: 0n } }).level, 'warning');
assert.equal(peripheryVerdict({ funder: { tac: 0n, wtac: 1n } }).level, 'warning');
ok('a balance in the funder warns');

assert.equal(peripheryVerdict({ points: { onchainRoot: R2, publishedRoot: R1, rootsSent: [] } }).level, 'critical');
assert.equal(peripheryVerdict({ points: { onchainRoot: R2, publishedRoot: R1, rootsSent: [R2] } }).level, 'ok');
assert.equal(peripheryVerdict({ points: { onchainRoot: '0x' + '0'.repeat(64), publishedRoot: R1, rootsSent: [] } }).level, 'ok');
assert.equal(peripheryVerdict({ points: { onchainRoot: R2, publishedRoot: null, rootsSent: [] } }).level, 'ok');
ok('a distributor root the service never sent is critical; one it sent, an empty one, or no record yet is not');

const both = peripheryVerdict({ claimBond: 5n, funder: { tac: 1n, wtac: 0n } });
assert.equal(both.level, 'critical');
assert.equal(both.why.length, 2);
ok('a warning never lowers a critical, and every issue is listed');

console.log(`\n${n}/5 periphery-guards checks passed`);
