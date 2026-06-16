// CI guard: the committed clearing_vectors.json is CURRENT — equals a fresh compute from the JS
// reference solveClearing. Without this, editing tests/amm-clearing.mjs without re-running the
// generator leaves the Rust guest's solve_clearing_matches_js KAT asserting against a stale fixture,
// so the live JS (Bitcoin lane) and the live Rust ELF (Ethereum lane) can silently drift on the
// fee-clearing price. Mirrors tests/amount-out-parity.test.mjs.
//
// Run: node tests/clearing-vectors-parity.test.mjs
import { readFileSync } from 'node:fs';
import { computeVectors } from './gen-clearing-vectors.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try { if (fn() === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const committed = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/clearing_vectors.json', import.meta.url)));

test('committed clearing_vectors fixture is current (regenerate with node tests/gen-clearing-vectors.mjs)', () =>
  JSON.stringify(committed.vectors) === JSON.stringify(computeVectors()));

console.log(`\n${pass}/${pass + fail} clearing-vectors parity checks passed`);
process.exit(fail === 0 ? 0 : 1);
