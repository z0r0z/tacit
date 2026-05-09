#!/usr/bin/env node
// Sample prover: builds an in-memory pool tree, deposits 4 leaves with random
// (secret, nullifier_preimage), then withdraws against leaf 2 with a real
// Groth16 proof under the keys built by build.sh.
//
// Run: npm run build && npm run prove:sample
//
// The sample proof + public inputs are written to artifacts/sample_proof.json
// and verified with snarkjs.groth16.verify.

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(__dirname, 'artifacts');

const LEVELS = 20;

function randFr() {
  // BN254 scalar field is ~254 bits; mask top 2 bits to ensure < r.
  const b = crypto.randomBytes(32);
  b[0] &= 0x3f;
  return BigInt('0x' + b.toString('hex'));
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const denomination = 100000000n; // 1.0 token at decimals=8

  // Build 4 deposits in a length-4 prefix.
  const leaves = [];
  const records = [];
  for (let i = 0; i < 4; i++) {
    const secret = randFr();
    const nullifierPreimage = randFr();
    const leaf = F.toObject(poseidon([secret, nullifierPreimage, denomination]));
    leaves.push(leaf);
    records.push({ index: i, secret, nullifierPreimage, leaf });
  }

  // Tree state at depth 20: pad with EMPTY_LEAF subtree roots. Sentinel must
  // match dapp's poolEmptyLeaf() in tacit.js (poseidon1([0])) — without
  // alignment, the prover and dapp's recomputed roots disagree on sparse
  // trees and the dapp's verifier rejects every sample proof. Tests covering
  // the cross-impl agreement live at tests/mixer.test.mjs.
  const EMPTY_LEAF = F.toObject(poseidon([F.e(0)]));

  const zeros = [EMPTY_LEAF];
  for (let d = 1; d <= LEVELS; d++) {
    zeros.push(F.toObject(poseidon([zeros[d - 1], zeros[d - 1]])));
  }

  function buildTree(leaves) {
    let layer = leaves.slice();
    const layers = [layer];
    for (let d = 0; d < LEVELS; d++) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : zeros[d];
        next.push(F.toObject(poseidon([left, right])));
      }
      if (next.length === 0) next.push(zeros[d + 1]);
      layer = next;
      layers.push(layer);
    }
    return { root: layer[0], layers };
  }

  const { root, layers } = buildTree(leaves);

  // Withdraw record #2.
  const TARGET = 2;
  const rec = records[TARGET];

  // Build merkle proof for leaf #TARGET.
  const path_elements = [];
  const path_indices = [];
  let idx = TARGET;
  for (let d = 0; d < LEVELS; d++) {
    const layer = layers[d];
    const sibling = idx % 2 === 0
      ? (idx + 1 < layer.length ? layer[idx + 1] : zeros[d])
      : layer[idx - 1];
    path_elements.push(sibling);
    path_indices.push(idx % 2);
    idx = Math.floor(idx / 2);
  }

  const nullifier_hash = F.toObject(poseidon([rec.nullifierPreimage]));

  // r_leaf = poseidon2(secret, nullifier_preimage). The circuit constrains
  // it to this exact value; the validator uses it for the external Pedersen
  // check. SPEC §3.8 constraint 4.
  const r_leaf = F.toObject(poseidon([rec.secret, rec.nullifierPreimage]));

  // bind_hash placeholder for the demo — production wires to the dApp's
  // computeWithdrawBindHash which covers (asset_id, denom_LE, nullifier_hash,
  // recipient_commitment, r_leaf).
  const bind_hash = randFr();

  const input = {
    root,
    nullifier_hash,
    denomination,
    r_leaf,
    bind_hash,
    secret: rec.secret,
    nullifier_preimage: rec.nullifierPreimage,
    path_elements,
    path_indices,
  };

  console.log('==> Generating witness + Groth16 proof');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    path.join(ART, 'withdraw.wasm'),
    path.join(ART, 'withdraw_final.zkey'),
  );

  console.log('==> Verifying proof');
  const vk = JSON.parse(await fs.readFile(path.join(ART, 'verification_key.json'), 'utf8'));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log('   verify:', ok ? 'OK' : 'FAIL');
  if (!ok) process.exit(1);

  await fs.writeFile(
    path.join(ART, 'sample_proof.json'),
    JSON.stringify({ proof, publicSignals, public_input_names: [
      'root', 'nullifier_hash', 'denomination', 'r_leaf', 'bind_hash',
    ] }, null, 2),
  );
  console.log('==> Wrote artifacts/sample_proof.json');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
