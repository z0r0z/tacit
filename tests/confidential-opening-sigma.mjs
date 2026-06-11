#!/usr/bin/env node
// Opening proof-of-knowledge (swap/LP) — JS prover/verifier round-trip + tamper, mirroring
// cxfer-core's verify_opening_sigma (and its native test). This is the primitive that lets the
// settle box verify a swap/LP opening WITHOUT learning the blinding r — so it can't spend the
// input or redirect the output. Uses the same vector as the Rust test (amount 1234, r=0x11.., nonce
// 0x22.., ctx=0x33..) so the two conventions line up; full byte-level agreement is locked by the
// exec harness when the guest verifies a JS-produced witness.
//
// Run: node tests/confidential-opening-sigma.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const AMOUNT = 1234;
const R_BLIND = '0x' + '11'.repeat(32);
const NONCE = '0x' + '22'.repeat(32);
const CTX = '0x' + '33'.repeat(32);

const { cx, cy } = pool.commitXY(AMOUNT, BigInt(R_BLIND));
const sig = pool.openingSigma(AMOUNT, BigInt(R_BLIND), CTX, BigInt(NONCE));

// 1. a valid proof verifies — and the witness carries only (R, z), never r.
assert.ok(pool.verifyOpeningSigma(cx, cy, AMOUNT, sig.R, sig.z, CTX), 'valid opening sigma verifies');
assert.ok(!/^0x0+$/.test(sig.R) && sig.z.length === 66, 'proof = (R 33B, z 32B), no blinding exposed');
ok('JS openingSigma → verifyOpeningSigma round-trips (r never leaves the prover)');

// 2. binds the value: a different amount against the same commitment is rejected.
assert.ok(!pool.verifyOpeningSigma(cx, cy, AMOUNT + 1, sig.R, sig.z, CTX), 'amount tamper rejected');
ok('a different amount (same commitment) is rejected — the opening binds the value');

// 3. binds the trade terms: a different context is rejected (box cannot redirect/relabel).
assert.ok(!pool.verifyOpeningSigma(cx, cy, AMOUNT, sig.R, sig.z, '0x' + '44'.repeat(32)), 'context tamper rejected');
ok('a different context is rejected — the box cannot alter out_owner / min_out / amounts');

// 4. a forged response or wrong commitment is rejected.
const badZ = '0x' + (BigInt(sig.z) ^ 1n).toString(16).padStart(64, '0');
assert.ok(!pool.verifyOpeningSigma(cx, cy, AMOUNT, sig.R, badZ, CTX), 'z tamper rejected');
const other = pool.commitXY(AMOUNT, BigInt(R_BLIND) + 1n);
assert.ok(!pool.verifyOpeningSigma(other.cx, other.cy, AMOUNT, sig.R, sig.z, CTX), 'wrong commitment rejected');
ok('a forged response or a different commitment is rejected');

// 5. a fresh nonce gives a different proof for the same statement (no nonce reuse footgun in callers).
const sig2 = pool.openingSigma(AMOUNT, BigInt(R_BLIND), CTX, '0x' + '23'.repeat(32));
assert.notStrictEqual(sig2.R, sig.R, 'distinct nonce → distinct R');
assert.ok(pool.verifyOpeningSigma(cx, cy, AMOUNT, sig2.R, sig2.z, CTX), 'the fresh-nonce proof also verifies');
ok('a fresh nonce yields a distinct, still-valid proof');

console.log(`\n${n} opening-sigma checks passed.`);
