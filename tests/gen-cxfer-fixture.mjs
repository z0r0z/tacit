#!/usr/bin/env node
// Serialize a confidential transfer (commitments, aggregated BP+ range proof,
// conservation kernel) to hex, so the Rust guest port can be unit-tested
// natively against a proof the JS prover produced. The Rust verifier must accept
// this exact proof — that locks the port.
//
// Run: node tests/gen-cxfer-fixture.mjs > contracts/sp1/confidential/fixtures/cxfer.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';

const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const hex = (b) => Buffer.from(b).toString('hex');
const ptHex = (P) => hex(P.toRawBytes(true)); // 33-byte compressed

// deterministic blindings so the fixture is reproducible
let s = 1n;
const rand = () => { s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return randomScalar(); };

const inputs = [
  { value: 1234567n, blinding: rand() },
  { value: 89n, blinding: rand() },
];
const outputs = [
  { value: 1234000n, blinding: rand() },
  { value: 656n, blinding: rand() },
];

const t = ct.buildTransfer({ inputs, outputs });
if (!ct.verifyTransfer(t)) throw new Error('JS self-verify failed');

process.stdout.write(JSON.stringify({
  note: 'confidential transfer fixture (JS prover) for the Rust guest port',
  inC: t.inC.map(ptHex),
  outC: t.outC.map(ptHex),
  rangeProof: hex(t.rangeProof),
  kernel: { R: ptHex(t.kernel.R), z: t.kernel.z.toString(16).padStart(64, '0') },
}, null, 2) + '\n');
