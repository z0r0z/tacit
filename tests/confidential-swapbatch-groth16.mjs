#!/usr/bin/env node
// swap_batch Groth16 verify wiring — parseGroth16Proof256 (256B → snarkjs proof obj, the guest's G16Proof
// layout) + swapBatchGroth16Verify (snarkjs.groth16.verify against a caller-supplied vk). The swap_batch
// circuit's ACCEPT path (the 123 publics from swapBatchPublicSignals against the inline ceremony vk) needs a
// real head-zkey proof — that's the gen. Here we validate the MACHINERY in node with a REAL Groth16 vector:
// the mixer's sample_proof.json + verification_key.json (same 256B Groth16 shape, fewer publics). It confirms
// snarkjs.groth16.verify runs + accepts a valid proof routed through parseGroth16Proof256, and rejects tamper.
// Run: node tests/confidential-swapbatch-groth16.mjs

import { readFileSync } from 'node:fs';
import { swapBatchGroth16Verify, parseGroth16Proof256 } from '../dapp/confidential-swapbatch.js';

let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const sample = JSON.parse(readFileSync(new URL('../dapp/circuits/artifacts/sample_proof.json', import.meta.url)));
const vk = JSON.parse(readFileSync(new URL('../dapp/circuits/artifacts/verification_key.json', import.meta.url)));
const p = sample.proof; // a snarkjs proof object (pi_a / pi_b / pi_c)
const publics = sample.publicSignals.map(BigInt);

// Serialize the snarkjs proof → the 256-byte G16Proof layout parseGroth16Proof256 expects
// (A x|y ‖ B x_c0|x_c1|y_c0|y_c1 ‖ C x|y), so the parse is exercised against a real proof.
const be32 = (dec) => { let v = BigInt(dec); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const cat = (parts) => { const t = parts.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let q = 0; for (const x of parts) { o.set(x, q); q += x.length; } return o; };
const proofBytes = cat([
  be32(p.pi_a[0]), be32(p.pi_a[1]),
  be32(p.pi_b[0][0]), be32(p.pi_b[0][1]), be32(p.pi_b[1][0]), be32(p.pi_b[1][1]),
  be32(p.pi_c[0]), be32(p.pi_c[1]),
]);

ok(proofBytes.length === 256, 'serialized proof is 256 bytes');
const parsed = parseGroth16Proof256(proofBytes);
ok(parsed && parsed.protocol === 'groth16' && parsed.pi_b.length === 3, 'parseGroth16Proof256 → well-formed snarkjs proof');
ok(parsed.pi_a[0] === p.pi_a[0] && parsed.pi_b[1][1] === p.pi_b[1][1], 'parse recovers the proof field values (256B layout round-trips)');

const run = async () => {
  ok((await swapBatchGroth16Verify(vk, publics, proofBytes)) === true, 'valid proof verifies (256B-parse + snarkjs.groth16.verify wiring)');
  const bad = new Uint8Array(proofBytes); bad[0] ^= 1;
  ok((await swapBatchGroth16Verify(vk, publics, bad)) === false, 'tampered proof rejected');
  ok((await swapBatchGroth16Verify(vk, publics.map((x, i) => (i === 0 ? x + 1n : x)), proofBytes)) === false, 'tampered public input rejected');
  ok((await swapBatchGroth16Verify(vk, publics, new Uint8Array(255))) === false, 'wrong-length proof → false (no crash)');
  console.log(failures ? `\n${failures} FAIL` : '\nall ok');
  process.exit(failures ? 1 : 0);
};
run();
