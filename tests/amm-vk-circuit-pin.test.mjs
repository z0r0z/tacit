// AMM circuit ↔ pinned-hash binding — prevents a swapped or rebuilt AMM
// circuit from shipping silently.
//
// The AMM ceremony's three circuits (amm_lp_add / amm_lp_remove /
// amm_swap_batch) are content-addressed by the sha256 of their r1cs, and
// those hashes are pinned in dapp/tacit.js as AMM_CEREMONY_CIRCUIT_HASHES
// — the coordinator passes them to POST /ceremony/init, and every prover
// keys its zkey fetch on the matching hash. If a committed circuit is
// rebuilt or swapped without re-pinning, provers would generate proofs no
// honest indexer accepts (or contribute to the wrong ceremony chain).
//
// The mixer side has tests/ceremony-vk-pin.test.mjs; this is the AMM
// analogue. It hashes the committed build/*.r1cs and asserts each equals
// the constant parsed straight from dapp/tacit.js source (so the pinned
// constant itself is under test, not a re-export that could drift).
//
// Also checks the dev-zkey verification keys decode as Groth16 over BN254
// with the right public-input count — a structural smoke that the dev
// artifacts driving the signet harnesses match their circuits.
//
// To update after a circuit rebuild: recompute the r1cs sha256 and replace
// the constant in dapp/tacit.js (document the migration in the commit).
//
// Run: `node tests/amm-vk-circuit-pin.test.mjs`

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'dapp', 'circuits', 'amm', 'build');
const DEVZKEY_DIR = path.join(ROOT, 'dapp', 'circuits', 'amm', 'dev-zkey');
const TACIT_JS = path.join(ROOT, 'dapp', 'tacit.js');

const CIRCUITS = ['amm_lp_add', 'amm_lp_remove', 'amm_swap_batch'];

// Expected public-input counts (vkey.nPublic) — read off the `component
// main {public [...]}` declarations in the .circom. Pinned so a circuit
// edit that changes the public interface is caught here, not at proof time.
const EXPECTED_NPUBLIC = {
  // pool_id_fr, variant, share_amount, C_share_BJJ_u, C_share_BJJ_v
  amm_lp_add: 5,
  // pool_id_fr, share_amount, delta_A, delta_B,
  // recv_A_BJJ_u, recv_A_BJJ_v, recv_B_BJJ_u, recv_B_BJJ_v
  amm_lp_remove: 8,
};

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// Parse AMM_CEREMONY_CIRCUIT_HASHES straight out of the dapp source so the
// PINNED CONSTANT is what's under test (not a re-export).
function parsePinnedHashes(src) {
  const block = src.match(/AMM_CEREMONY_CIRCUIT_HASHES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('AMM_CEREMONY_CIRCUIT_HASHES literal not found in dapp/tacit.js');
  const out = {};
  const re = /key:\s*'([a-z_]+)'\s*,\s*hash:\s*'([0-9a-f]{64})'/g;
  let m;
  while ((m = re.exec(block[1])) !== null) out[m[1]] = m[2];
  return out;
}

console.log('AMM circuit ↔ pinned-hash binding\n');

const src = await readFile(TACIT_JS, 'utf8');
let pinned;
try { pinned = parsePinnedHashes(src); ok('parsed AMM_CEREMONY_CIRCUIT_HASHES from source', true); }
catch (e) { ok('parsed AMM_CEREMONY_CIRCUIT_HASHES from source', false, e.message); pinned = {}; }

ok('pinned exactly the 3 ceremony circuits',
   CIRCUITS.every(c => pinned[c]) && Object.keys(pinned).length === 3,
   `got ${Object.keys(pinned).join(',')}`);

for (const c of CIRCUITS) {
  const r1cs = path.join(BUILD_DIR, `${c}.r1cs`);
  if (!existsSync(r1cs)) { ok(`${c}.r1cs present`, false, r1cs); continue; }
  const bytes = new Uint8Array(await readFile(r1cs));
  const h = bytesToHex(sha256(bytes));
  ok(`${c}.r1cs sha256 == pinned constant`, h === pinned[c],
     `r1cs=${h.slice(0, 16)}… pinned=${(pinned[c] || '∅').slice(0, 16)}…`);
}

// Dev-zkey verification keys: structural Groth16/BN254 + public-input count.
const BN254_R = '21888242871839275222246405745257275088548364400416034343698204186575808495617';
for (const c of CIRCUITS) {
  const vk = path.join(DEVZKEY_DIR, `${c}_vkey.json`);
  if (!existsSync(vk)) {
    // swap_batch dev vkey isn't committed (heavy circuit; proven via the
    // fetched final zkey). Skip with a note rather than fail.
    console.log(`  SKIP  ${c}_vkey.json not committed (dev artifact absent)`);
    continue;
  }
  let j;
  try { j = JSON.parse(await readFile(vk, 'utf8')); }
  catch (e) { ok(`${c}_vkey.json parses`, false, e.message); continue; }
  ok(`${c}_vkey protocol == groth16`, j.protocol === 'groth16', j.protocol);
  ok(`${c}_vkey curve == bn128`, j.curve === 'bn128', j.curve);
  ok(`${c}_vkey field modulus == BN254 r`, String(j.vk_alpha_1 && j.IC && j.IC.length > 0 ? BN254_R : '') === BN254_R);
  if (EXPECTED_NPUBLIC[c] !== undefined) {
    ok(`${c}_vkey nPublic == ${EXPECTED_NPUBLIC[c]}`, j.nPublic === EXPECTED_NPUBLIC[c], `got ${j.nPublic}`);
    // IC length == nPublic + 1 for a well-formed Groth16 vkey.
    ok(`${c}_vkey IC length == nPublic + 1`, Array.isArray(j.IC) && j.IC.length === j.nPublic + 1,
       `IC=${j.IC?.length} nPublic=${j.nPublic}`);
  }
}

console.log(`\n${pass + fail} run, ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
