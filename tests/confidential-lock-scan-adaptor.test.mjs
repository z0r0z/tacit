// decodePublicValuesAdaptorFields on the public values of real Groth16 proofs (contracts/test/fixtures/adaptor_*_groth16.json):
// what a lock appended, what a claim spent and revealed, what a refund spent and when it may land.
//   node tests/confidential-lock-scan-adaptor.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLockScan } from '../dapp/confidential-lock-scan.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const scan = makeConfidentialLockScan({ pool: makeConfidentialPool({ secp: rootSecp, keccak256: keccak_256, sha256 }) });
const load = (n) => JSON.parse(readFileSync(new URL(`../contracts/test/fixtures/adaptor_${n}_groth16.json`, import.meta.url), 'utf8'));
const ZERO = '0x' + '00'.repeat(32);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a lock appends one lock leaf, spends one note, spends no lock and reveals nothing', () => {
  const pv = scan.decodePublicValuesAdaptorFields(load('lock').publicValues);
  assert.equal(pv.lockLeaves.length, 1);
  assert.equal(pv.nullifiers.length, 1);
  assert.deepEqual(pv.lockNullifiers, []);
  assert.deepEqual(pv.adaptorClaimS, []);
  assert.ok(pv.deadline > 1_700_000_000, 'the lock names its deadline');
  assert.equal(pv.refundNotBefore, 0);
});

test('a claim spends one lock, makes one note and commits one kernel s, against a lock-set root', () => {
  const pv = scan.decodePublicValuesAdaptorFields(load('claim').publicValues);
  assert.equal(pv.lockNullifiers.length, 1);
  assert.equal(pv.adaptorClaimS.length, 1);
  assert.notEqual(pv.adaptorClaimS[0], ZERO);
  assert.equal(pv.leaves.length, 1);
  assert.notEqual(pv.lockSetRoot, ZERO);
  assert.deepEqual(pv.lockLeaves, []);
  assert.ok(pv.deadline > 0, 'a claim settles before the lock\'s deadline');
  assert.equal(pv.refundNotBefore, 0);
});

test('a refund spends one lock, makes one note, reveals no s, and may land only from the deadline on', () => {
  const pv = scan.decodePublicValuesAdaptorFields(load('refund').publicValues);
  assert.equal(pv.lockNullifiers.length, 1);
  assert.deepEqual(pv.adaptorClaimS, []);
  assert.equal(pv.leaves.length, 1);
  assert.ok(pv.refundNotBefore > 1_700_000_000);
});

test('the s a real claim commits is the kernel s of the op it was proved from', () => {
  const op = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/adaptor_claim_op.json', import.meta.url), 'utf8'));
  const pv = scan.decodePublicValuesAdaptorFields(load('claim').publicValues);
  assert.equal(BigInt(pv.adaptorClaimS[0]), BigInt(op.kernelS), 'z read from the public values is the z the claimer signed');
  assert.equal(pv.deadline, op.deadline);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} adaptor public-values checks passed`);
