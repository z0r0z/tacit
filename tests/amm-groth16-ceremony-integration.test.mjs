// Real-vk Groth16 integration test (post-ceremony end-to-end).
//
// This test wires `snarkjs.groth16.verify` against:
//   - The canonical vk produced by the Phase 2 AMM ceremony
//   - A reference proof generated from the canonical witness fixture
//   - The canonical 123-element publicSignals array produced by
//     `buildPublicSignalsSwapBatch` (see amm-validator.mjs)
//
// Status pre-ceremony: the canonical vk does not yet exist. This test is
// SKIPPED unless the caller exports `AMM_CEREMONY_VK_PATH` and
// `AMM_CEREMONY_PROOF_PATH` pointing at JSON files produced by a real
// snarkjs ceremony run. Post-ceremony, CI MUST set these env vars and the
// test MUST run; this is the end-to-end integrity check the validator's
// `verifyVkCidBinding` + `buildPublicSignalsSwapBatch` together promise.
//
// Why this test is the load-bearing pre-ceremony scaffold:
//   - The validator delegates Groth16 verification to an injected callback;
//     pre-ceremony tests use SKIP_GROTH16_VERIFY_UNSAFE which short-circuits
//     the check entirely. There is no JS-side test that exercises:
//       (a) the canonical publicSignals serialization,
//       (b) the canonical vk bytes,
//       (c) the actual snarkjs.groth16.verify call,
//       (d) the cross-pool-replay defense (proof against vk_A rejected by vk_B).
//     Until ceremony output exists, (b) is the gating variable; this test
//     scaffold is ready to run as soon as the ceremony coordinator produces
//     the canonical vk + reference proof bytes.
//
// Environment variables consumed:
//   AMM_CEREMONY_VK_PATH     — path to verification_key.json (snarkjs format)
//   AMM_CEREMONY_PROOF_PATH  — path to proof.json (snarkjs format)
//   AMM_CEREMONY_PUBLIC_PATH — path to public.json (123-element decimal-string array)
//   AMM_CEREMONY_VK_CID      — optional; the canonical CIDv1-raw-sha256 string
//                              for the ceremony vk bytes (if set, this test
//                              also verifies deriveVkCid(vk_bytes) matches it).
//
// Reference command (post-ceremony) to run:
//   AMM_CEREMONY_VK_PATH=./dapp/circuits/amm/dev-zkey/amm_swap_batch_dev_vk.json \
//   AMM_CEREMONY_PROOF_PATH=./fixtures/amm-swap-batch-proof.json \
//   AMM_CEREMONY_PUBLIC_PATH=./fixtures/amm-swap-batch-public.json \
//   node amm-groth16-ceremony-integration.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { deriveVkCid, verifyVkCidBinding, PUBLIC_SIGNALS_SWAP_BATCH_LENGTH } from './amm-validator.mjs';

let pass = 0, fail = 0, skipped = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === 'skip') { console.log(`  SKIP  ${label}`); skipped++; return; }
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
async function testAsync(label, fn) {
  try {
    const ok = await fn();
    if (ok === 'skip') { console.log(`  SKIP  ${label}`); skipped++; return; }
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const VK_PATH = process.env.AMM_CEREMONY_VK_PATH;
const PROOF_PATH = process.env.AMM_CEREMONY_PROOF_PATH;
const PUBLIC_PATH = process.env.AMM_CEREMONY_PUBLIC_PATH;
const VK_CID = process.env.AMM_CEREMONY_VK_CID;

const CEREMONY_FIXTURES_AVAILABLE =
  VK_PATH && PROOF_PATH && PUBLIC_PATH &&
  existsSync(VK_PATH) && existsSync(PROOF_PATH) && existsSync(PUBLIC_PATH);

console.log('Real-vk Groth16 integration (post-ceremony)');
console.log(`  Ceremony fixtures: ${CEREMONY_FIXTURES_AVAILABLE ? 'AVAILABLE' : 'NOT AVAILABLE — pre-ceremony'}`);

if (!CEREMONY_FIXTURES_AVAILABLE) {
  // Pre-ceremony path: smoke-check that the scaffolding compiles and the
  // helpers it depends on are present. The actual end-to-end verification
  // is gated on ceremony output.
  test('vk_cid integrity helpers are present (pre-ceremony scaffolding compiles)', () =>
    typeof deriveVkCid === 'function' && typeof verifyVkCidBinding === 'function'
  );
  test('publicSignals layout constant pinned at 123 (matches AMM.md §6)', () =>
    PUBLIC_SIGNALS_SWAP_BATCH_LENGTH === 123
  );
  test('end-to-end Groth16 verify against canonical vk (gated on ceremony output)', () =>
    'skip'
  );
  test('cross-pool replay defense: proof against vk_A rejected under vk_B (gated)', () =>
    'skip'
  );
  test('vkBytes ↔ vk_cid integrity (gated on canonical vk bytes)', () =>
    'skip'
  );
} else {
  // Post-ceremony path. Run the actual integration test.
  await testAsync('snarkjs.groth16.verify accepts ceremony-produced proof', async () => {
    // Dynamic import so pre-ceremony test runs without snarkjs available.
    const { default: snarkjs } = await import('snarkjs').catch(() => ({ default: null }));
    if (!snarkjs) { console.log('     (snarkjs not installed; run npm i snarkjs)'); return false; }
    const vk = JSON.parse(readFileSync(VK_PATH, 'utf8'));
    const proof = JSON.parse(readFileSync(PROOF_PATH, 'utf8'));
    const publicSignals = JSON.parse(readFileSync(PUBLIC_PATH, 'utf8'));
    if (publicSignals.length !== PUBLIC_SIGNALS_SWAP_BATCH_LENGTH) {
      console.log(`     publicSignals.length ${publicSignals.length} != expected ${PUBLIC_SIGNALS_SWAP_BATCH_LENGTH}`);
      return false;
    }
    return await snarkjs.groth16.verify(vk, publicSignals, proof);
  });

  test('vk_cid integrity: deriveVkCid(vk_bytes) matches AMM_CEREMONY_VK_CID env', () => {
    if (!VK_CID) { console.log('     (no AMM_CEREMONY_VK_CID set — skipping)'); return 'skip'; }
    // The actual vk *bytes* (not the JSON form) are what get hashed.
    // For snarkjs vk format, the canonical "bytes" are the contents of
    // verification_key.json with whatever encoding the ceremony coordinator
    // chose — typically the raw JSON. The exact serialization is part of the
    // ceremony output spec. Here we assume the file contents bytes are the
    // canonical form.
    const vkBytes = readFileSync(VK_PATH);
    return verifyVkCidBinding(vkBytes, VK_CID);
  });

  // Cross-pool replay defense: a proof produced against pool_A's vk MUST NOT
  // verify when handed pool_B's vk (which has a different vk_cid_fr pinned
  // as a public signal). This is the structural defense documented in
  // AMM.md §"Security properties" table.
  // Implementation note: requires two distinct vks. Post-ceremony, this
  // becomes meaningful when there are ≥2 confirmed pools with different vks
  // (different ceremonies); for V1 with a single canonical vk, the test
  // demonstrates the mechanism by mutating one byte of publicSignals[0]
  // (pool_id_fr) and confirming verification rejects.
  await testAsync('cross-pool replay defense: mutated pool_id_fr ⇒ proof rejected', async () => {
    const { default: snarkjs } = await import('snarkjs').catch(() => ({ default: null }));
    if (!snarkjs) return false;
    const vk = JSON.parse(readFileSync(VK_PATH, 'utf8'));
    const proof = JSON.parse(readFileSync(PROOF_PATH, 'utf8'));
    const publicSignals = JSON.parse(readFileSync(PUBLIC_PATH, 'utf8'));
    // Mutate publicSignals[0] (pool_id_fr) — should reject.
    const mutated = [...publicSignals];
    mutated[0] = (BigInt(mutated[0]) + 1n).toString();
    const result = await snarkjs.groth16.verify(vk, mutated, proof);
    return result === false;
  });
}

console.log(`\n${pass}/${pass + fail + skipped} passed (${skipped} skipped, ${fail} failed)`);
if (fail > 0) process.exit(1);
