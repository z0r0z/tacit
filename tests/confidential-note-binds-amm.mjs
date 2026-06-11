#!/usr/bin/env node
// Concrete proof that a confidential-pool note (the same secp256k1 commitment the
// Ethereum ConfidentialPool uses — including a BRIDGED note) binds into the AMM batch
// swap. The Sigma cross-curve binding (dapp/amm-sigma.js ↔ tests/amm-sigma-xcurve.mjs)
// proves the note's hidden value `a` equals the value committed by the BabyJubJub
// commitment that `amm_swap_batch` consumes — without revealing `a`. The note's secp
// commitment IS the bound object (the H generators are byte-identical), so there's no
// adapter: bridged note → sigma → BJJ commitment → batch swap.
//
// Run: node tests/confidential-note-binds-amm.mjs

import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { proveXCurve, verifyXCurve, XCURVE_PROOF_LEN } from './amm-sigma-xcurve.mjs';
import { packPoint, pedersenBJJ } from './amm-bjj.mjs';
import { bppGens, G, randomScalar } from '../dapp/bulletproofs-plus.js';
import assert from 'node:assert';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const H = bppGens().H; // the confidential pool's note generator (NUMS tacit-generator-H-v1)

// A bridged TAC note: value `a` hidden in a secp Pedersen commitment, exactly as it
// sits in the ConfidentialPool (C = a·H + r_secp·G).
const a = 1500n;                 // the note's value (hidden)
const r_secp = randomScalar();   // the note's blinding
const r_bjj = randomScalar();    // a fresh blinding for the in-circuit BJJ commitment

// Sigma-bind: prove the note's `a` equals the BJJ commitment's `a`.
const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ: r_bjj });

// ── 1. the bound secp commitment IS the confidential-pool note commitment ──
const noteCommitment = H.multiply(a).add(G.multiply(r_secp)).toRawBytes(true); // a·H + r·G
assert.deepStrictEqual(Buffer.from(C_secp_bytes), Buffer.from(noteCommitment), 'bound C_secp == pool note commitment');
ok('the sigma-bound secp commitment is exactly the confidential-pool note (same H, no adapter)');

// ── 2. the binding verifies: note value == BJJ (AMM input) value, hidden ──
assert.strictEqual(proof.length, XCURVE_PROOF_LEN, '169-byte proof');
assert.strictEqual(verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes), true, 'binding verifies');
ok('sigma proof binds the note to the BJJ commitment under the same hidden value (169 bytes)');

// ── 3. C_BJJ is the commitment amm_swap_batch consumes — it commits to the SAME a ──
const expectedBJJ = packPoint(pedersenBJJ(a, r_bjj));
assert.deepStrictEqual(Buffer.from(C_BJJ_bytes), Buffer.from(expectedBJJ), 'C_BJJ = a·H_BJJ + r·G_BJJ');
ok('the BJJ commitment (the batch-swap circuit input) commits to the note value');

// ── 4. cannot rebind to a different amount: a BJJ commitment for a' != a is rejected ──
const wrongBJJ = packPoint(pedersenBJJ(a + 1n, r_bjj));
assert.strictEqual(verifyXCurve(proof, C_secp_bytes, wrongBJJ), false, 'value-swap rejected');
ok('binding to a DIFFERENT amount is rejected (no value created crossing curves)');

// ── 5. a tampered proof is rejected ──
const bad = Uint8Array.from(proof); bad[80] ^= 1;
assert.strictEqual(verifyXCurve(bad, C_secp_bytes, C_BJJ_bytes), false, 'tampered proof rejected');
ok('tampered sigma proof is rejected');

console.log(`\n${n}/5 confidential-note-binds-amm checks passed`);
