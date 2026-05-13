// Pre-ceremony drift guard for AMM circuits.
//
// The ceremony commits to the exact byte-content of the four .circom source
// files AND the resulting .r1cs compilation artifacts. Any change after
// ceremony finalization is an irrevocable break: existing pools' pinned
// vk_cid values stop verifying.
//
// This test runs in CI BEFORE the ceremony to catch unintentional drift
// during ongoing product work (worker / settler / dapp UI), and AFTER the
// ceremony to alarm if anyone accidentally edits a frozen file.
//
// What this test does:
//   1. Hashes each .circom source file with SHA-256.
//   2. Hashes each compiled .r1cs file with SHA-256.
//   3. Asserts each hash matches a pinned expected value.
//   4. Also asserts constraint-count fingerprints (NL + linear + wires +
//      public-input count) from a fresh circom recompile.
//
// To intentionally update after a deliberate circuit change:
//   1. Edit the .circom file.
//   2. Run `./build.sh` to regenerate the r1cs.
//   3. Run `node drift-guard.test.mjs` — it will report the new hashes.
//   4. Update the PINNED_* constants below to the new values.
//   5. Commit the source change AND the pin update in the same PR.
//   6. Run a fresh ceremony (existing vk's are invalidated).
//
// Run from this directory: `node drift-guard.test.mjs`
// CI integration: add to dapp/circuits/amm/package.json or run via build.sh
// CI step.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// =========================================================================
// PINNED VALUES — DO NOT EDIT WITHOUT INTENT TO INVALIDATE THE CEREMONY.
//
// Pinned post-hardening (see REVIEW.md). Any drift = potential ceremony
// invalidation. If you have a deliberate reason to change these, update
// REVIEW.md with the reasoning AND plan a fresh Phase 2 ceremony.
// =========================================================================

const PINNED_SOURCE_HASHES = {
  'bjj_pedersen.circom':   'fdb4b547d6f756757ccd25d8d9a1495d276ff90a9de98a623a3b1a014060c28e',
  'amm_lp_add.circom':     'dd8d9e2e50a7dec241b3de5a30262354ed1100155e363baf57c13b36f0565a06',
  'amm_lp_remove.circom':  '093fc69dc7d3f4727fcb74d95715c5de1e00a46372d6a4bf7279d2ccd1ce6941',
  'amm_swap_batch.circom': 'dfb219a2704840a8deb2209d6b1a34edf3c9b206d1e02dea280e3df048aa64c4',
};

const PINNED_R1CS_HASHES = {
  'amm_lp_add.r1cs':     '5a67cdcc9e432d8474147a212dabf35e65425522bac111f8a1805d9386afb701',
  'amm_lp_remove.r1cs':  '005a38bfe8acc4d644e600aa91d08e08dba87170f87279bfb5b087230a4399b1',
  'amm_swap_batch.r1cs': 'bd144d4bc66bd349522d9b2d7308d3e4dbf4c1281da9a8964933afe4aad47de8',
};

const PINNED_FINGERPRINTS = {
  amm_lp_add:     { nl: 4923,   linear: 230,  wires: 5155,   pubInputs: 5,   privInputs: 1 },
  amm_lp_remove:  { nl: 9908,   linear: 461,  wires: 10371,  pubInputs: 8,   privInputs: 2 },
  amm_swap_batch: { nl: 164476, linear: 7682, wires: 172058, pubInputs: 123, privInputs: 96 },
};

// =========================================================================

function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

console.log('Source .circom file hashes (immediate change detector)');
for (const [name, expected] of Object.entries(PINNED_SOURCE_HASHES)) {
  const path = resolve(__dirname, name);
  test(`${name} hash matches pinned`, () => {
    const actual = sha256File(path);
    if (actual !== expected) {
      console.log(`     expected: ${expected}`);
      console.log(`     got:      ${actual}`);
      return false;
    }
    return true;
  });
}

console.log('\nCompiled .r1cs file hashes (compilation-output detector)');
const buildExists = existsSync(resolve(__dirname, 'build'));
if (!buildExists) {
  console.log('  SKIP  build/ directory missing — run ./build.sh first');
} else {
  for (const [name, expected] of Object.entries(PINNED_R1CS_HASHES)) {
    const path = resolve(__dirname, 'build', name);
    test(`${name} hash matches pinned`, () => {
      if (!existsSync(path)) {
        console.log(`     missing: ${path}`);
        return false;
      }
      const actual = sha256File(path);
      if (actual !== expected) {
        console.log(`     expected: ${expected}`);
        console.log(`     got:      ${actual}`);
        return false;
      }
      return true;
    });
  }
}

console.log('\nConstraint-count fingerprints (semantic verification via fresh recompile)');
let circomAvailable = false;
try {
  execSync('circom --version', { stdio: 'pipe' });
  circomAvailable = true;
} catch { /* circom not in PATH */ }

if (!circomAvailable) {
  console.log('  SKIP  circom not in PATH — install circom 2.1.6+ to enable this check');
} else {
  for (const [name, expected] of Object.entries(PINNED_FINGERPRINTS)) {
    test(`${name} constraint fingerprint matches pinned`, () => {
      const out = execSync(
        `circom ${name}.circom --r1cs -l ../node_modules -o build`,
        { cwd: __dirname, stdio: 'pipe' },
      ).toString();
      const nl       = parseInt(out.match(/non-linear constraints:\s*(\d+)/)?.[1] || '-1', 10);
      const linear   = parseInt(out.match(/^linear constraints:\s*(\d+)/m)?.[1] || '-1', 10);
      const wires    = parseInt(out.match(/wires:\s*(\d+)/)?.[1] || '-1', 10);
      const pubIn    = parseInt(out.match(/public inputs:\s*(\d+)/)?.[1] || '-1', 10);
      const privIn   = parseInt(out.match(/private inputs:\s*(\d+)/)?.[1] || '-1', 10);
      const actual   = { nl, linear, wires, pubInputs: pubIn, privInputs: privIn };
      const drifts   = [];
      for (const k of Object.keys(expected)) {
        if (actual[k] !== expected[k]) drifts.push(`${k}: expected ${expected[k]}, got ${actual[k]}`);
      }
      if (drifts.length > 0) {
        for (const d of drifts) console.log(`     ${d}`);
        return false;
      }
      return true;
    });
  }
}

console.log(`\n${pass}/${pass + fail} drift checks passed`);
if (fail > 0) {
  console.log('\nCEREMONY-INVALIDATING DRIFT DETECTED.');
  console.log('Either revert the change, or:');
  console.log('  1. Update REVIEW.md with the rationale');
  console.log('  2. Re-run ./build.sh and copy the new hashes/fingerprints into this file');
  console.log('  3. Plan a fresh Phase 2 ceremony (existing vk_cid values become invalid)');
  process.exit(1);
}
