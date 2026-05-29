#!/usr/bin/env node
// Generates a REAL Groth16 withdraw proof against the FINALIZED CEREMONY zkey
// and writes a fixture the Foundry test (Groth16VerifierReal.t.sol) consumes.
//
// Purpose: exercise the burn->withdraw proof path end-to-end against the REAL
// on-chain Groth16Verifier (not the mock the Sepolia e2e used). The fixture
// records the proof in BOTH G2 coordinate orderings so the test can prove
// which one the on-chain verifier (and thus the mixer's _verifyProof) needs:
//   - "native"  = snarkjs proof.pi_b order, exactly what dapp _serializeGroth16Proof
//                 packs into the envelope and what the mixer reads + forwards.
//   - "swapped" = snarkjs soliditycalldata order (G2 c0/c1 swapped), what the
//                 EVM bn254 pairing precompile expects.
//
// Run: node tests/gen-withdraw-proof-fixture.mjs

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import * as snarkjs from '../dapp/circuits/node_modules/snarkjs/main.js';
import { buildPoseidon } from '../dapp/circuits/node_modules/circomlibjs/main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRC = path.join(__dirname, '..', 'dapp', 'circuits');
const WASM = path.join(CIRC, 'artifacts', 'withdraw.wasm');
const ZKEY = path.join(CIRC, 'ceremony-bundle', 'withdraw_final.zkey');
const VK = path.join(CIRC, 'ceremony-bundle', 'verification_key.json');
const OUT = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'withdraw_proof.json');

const LEVELS = 20;

function randFr() {
  const b = crypto.randomBytes(32);
  b[0] &= 0x3f; // < BN254 r
  return BigInt('0x' + b.toString('hex'));
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const denomination = 100000000n; // 1.0 at 8 decimals (the 1e8 tacit-unit pool)

  // Self-consistent 4-leaf tree; withdraw leaf #2. Mirrors prove-sample.mjs.
  const leaves = [], records = [];
  for (let i = 0; i < 4; i++) {
    const secret = randFr(), nullifierPreimage = randFr();
    const leaf = F.toObject(poseidon([secret, nullifierPreimage, denomination]));
    leaves.push(leaf); records.push({ secret, nullifierPreimage });
  }
  const EMPTY_LEAF = F.toObject(poseidon([F.e(0)]));
  const zeros = [EMPTY_LEAF];
  for (let d = 1; d <= LEVELS; d++) zeros.push(F.toObject(poseidon([zeros[d - 1], zeros[d - 1]])));

  function buildTree(lv) {
    let layer = lv.slice(); const layers = [layer];
    for (let d = 0; d < LEVELS; d++) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i], right = i + 1 < layer.length ? layer[i + 1] : zeros[d];
        next.push(F.toObject(poseidon([left, right])));
      }
      if (next.length === 0) next.push(zeros[d + 1]);
      layer = next; layers.push(layer);
    }
    return { root: layer[0], layers };
  }
  const { root, layers } = buildTree(leaves);

  const TARGET = 2, rec = records[TARGET];
  const path_elements = [], path_indices = [];
  let idx = TARGET;
  for (let d = 0; d < LEVELS; d++) {
    const layer = layers[d];
    const sibling = idx % 2 === 0 ? (idx + 1 < layer.length ? layer[idx + 1] : zeros[d]) : layer[idx - 1];
    path_elements.push(sibling); path_indices.push(idx % 2); idx = Math.floor(idx / 2);
  }
  const nullifier_hash = F.toObject(poseidon([rec.nullifierPreimage]));
  const r_leaf = F.toObject(poseidon([rec.secret, rec.nullifierPreimage]));
  const bind_hash = randFr();

  const input = { root, nullifier_hash, denomination, r_leaf, bind_hash,
    secret: rec.secret, nullifier_preimage: rec.nullifierPreimage, path_elements, path_indices };

  console.log('==> fullProve against ceremony zkey');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

  const vk = JSON.parse(await fs.readFile(VK, 'utf8'));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log('   snarkjs.verify (ceremony vk):', ok ? 'OK' : 'FAIL');
  if (!ok) process.exit(1);

  // soliditycalldata gives the swapped-order calldata the EVM precompile wants.
  const cd = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const parsed = JSON.parse('[' + cd + ']'); // [ [a0,a1], [[b00,b01],[b10,b11]], [c0,c1], [pub..] ]
  const [aCD, bCD, cCD, pubCD] = parsed;

  const fixture = {
    note: 'Real ceremony-key withdraw proof. native = dapp _serializeGroth16Proof/guest order; swapped = soliditycalldata/precompile order.',
    publicSignals,                     // [root, nullifier_hash, denomination, r_leaf, bind_hash]
    a: [proof.pi_a[0], proof.pi_a[1]],
    c: [proof.pi_c[0], proof.pi_c[1]],
    b_native:  [[proof.pi_b[0][0], proof.pi_b[0][1]], [proof.pi_b[1][0], proof.pi_b[1][1]]],
    b_swapped: [[bCD[0][0], bCD[0][1]], [bCD[1][0], bCD[1][1]]],
    soliditycalldata: { a: aCD, b: bCD, c: cCD, pub: pubCD },
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fixture, null, 2));
  console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
  console.log('   native b[0][0] :', fixture.b_native[0][0]);
  console.log('   swapped b[0][0]:', fixture.b_swapped[0][0]);
  console.log('   swapped == native? ', JSON.stringify(fixture.b_native) === JSON.stringify(fixture.b_swapped));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
