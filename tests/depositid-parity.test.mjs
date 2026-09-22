// CI guard for the deposit-commitment KAT (depositCommit/depositId): asserts the committed fixture
// (contracts/sp1/confidential/fixtures/deposit_id_vectors.json) is CURRENT — equals a fresh compute from
// dapp/confidential-pool.js — so an edit to the hash chain without regenerating the fixture can't leave an
// external reimplementation (e.g. an integrator computing the same commitment independently) pinned to a
// stale value with no signal.
//
// Run: node tests/depositid-parity.test.mjs
import { readFileSync } from 'node:fs';
import { computeVectors } from './gen-depositid-vectors.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try { if (fn() === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const committed = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/deposit_id_vectors.json', import.meta.url)));

test('committed deposit_id fixture is current (regenerate with node tests/gen-depositid-vectors.mjs)', () =>
  JSON.stringify(committed.vectors) === JSON.stringify(computeVectors()));

console.log(`\n${pass}/${pass + fail} depositId parity checks passed`);
process.exit(fail === 0 ? 0 : 1);
