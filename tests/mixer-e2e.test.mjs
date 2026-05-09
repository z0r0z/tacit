// SPEC §5.11 — end-to-end Groth16 prove/verify check.
//
// Wraps dapp/circuits/prove-sample.mjs (which generates a real proof against
// a 4-leaf in-memory pool tree using circomlibjs's Poseidon, then verifies
// via snarkjs.groth16.verify) and asserts exit-0. Plus a few sanity checks
// on the artifacts the prover wrote.
//
// What this gives us that mixer.test.mjs / mixer-envelope.test.mjs don't:
//   - The full prover→verifier pipeline actually executes — proves the
//     circuit + zkey + verification key are mutually consistent, and that
//     poseidon-lite (dapp side) and circomlibjs (prover side) agree on
//     hash outputs at the field-element level (any drift would manifest
//     as a Merkle-root mismatch at proof time).
//   - The `withdraw_final.zkey` / `verification_key.json` artifacts under
//     dapp/circuits/artifacts are still in shape after the empty-leaf
//     unification fix.
//
// What this does NOT cover yet:
//   - Direct invocation of the dapp's verifyMixerProof (it lives behind
//     vendor/tacit-mixer.min.js and is browser-only). Reaching it from
//     node requires either (a) a jsdom shim that loads the bundle, or
//     (b) extracting the verify glue into a node-runnable form. The
//     prove-sample script's own snarkjs.groth16.verify call is the same
//     primitive the dapp invokes, just without the dapp's CID-fetch +
//     proof-bytes-parse glue layered on top.
//
// Run: `node mixer-e2e.test.mjs`

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(__dirname, '..', 'dapp', 'circuits');
const SAMPLE_PROOF = path.join(CIRCUITS, 'artifacts', 'sample_proof.json');
const VK = path.join(CIRCUITS, 'artifacts', 'verification_key.json');
const ZKEY = path.join(CIRCUITS, 'artifacts', 'withdraw_final.zkey');
const WASM = path.join(CIRCUITS, 'artifacts', 'withdraw.wasm');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`);
    fail++;
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

console.log('Mixer artifacts exist (build.sh has been run):');

await test('verification_key.json exists', () => exists(VK));
await test('withdraw_final.zkey exists', () => exists(ZKEY));
await test('withdraw.wasm exists', () => exists(WASM));

// Skip the rest if artifacts are missing — fresh checkouts won't have them.
const artifactsReady = (await exists(VK)) && (await exists(ZKEY)) && (await exists(WASM));
if (!artifactsReady) {
  console.log('');
  console.log('  SKIP  Groth16 prove/verify (run `cd dapp/circuits && bash build.sh` first)');
  console.log('');
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

console.log('\nGroth16 prove/verify pipeline:');

await test('prove-sample.mjs generates + verifies a real Groth16 proof', () => {
  const result = spawnSync('node', ['prove-sample.mjs'], {
    cwd: CIRCUITS,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    console.log(`     stdout: ${result.stdout?.trim() || '(empty)'}`);
    console.log(`     stderr: ${result.stderr?.trim() || '(empty)'}`);
    return false;
  }
  // Sanity: the script should print "verify: OK" before exiting.
  return /verify:\s*OK/i.test(result.stdout);
});

await test('sample_proof.json artifact has expected shape', async () => {
  const raw = await fs.readFile(SAMPLE_PROOF, 'utf8');
  const j = JSON.parse(raw);
  // Shape: { proof: {pi_a, pi_b, pi_c, protocol, curve}, publicSignals: [...] }
  // — snarkjs's standard Groth16 proof object plus the array of public inputs.
  if (!j.proof || !j.publicSignals) return false;
  if (!Array.isArray(j.publicSignals)) return false;
  // 5 public inputs per withdraw.circom: root, nullifier_hash, denomination,
  // r_leaf, bind_hash. Pinned here so a circuit-side change that adds /
  // removes a public input fails this test loudly instead of silently
  // breaking the dapp's verifyMixerProof (which expects exactly 5).
  if (j.publicSignals.length !== 5) return false;
  if (j.proof.protocol !== 'groth16') return false;
  if (j.proof.curve !== 'bn128') return false;
  if (!Array.isArray(j.proof.pi_a) || j.proof.pi_a.length < 2) return false;
  if (!Array.isArray(j.proof.pi_b) || j.proof.pi_b.length < 2) return false;
  if (!Array.isArray(j.proof.pi_c) || j.proof.pi_c.length < 2) return false;
  return true;
});

await test('verification_key.json declares 5 public inputs (matches publicSignals)', async () => {
  const raw = await fs.readFile(VK, 'utf8');
  const vk = JSON.parse(raw);
  // snarkjs's vk has nPublic == number of public signals the circuit exposes.
  // If this drifts vs prove-sample's publicSignals.length above, the dapp's
  // verifyMixerProof would reject every otherwise-valid proof.
  return vk.nPublic === 5;
});

console.log('');
console.log(`${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
