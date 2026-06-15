// CI guard for the per-hop CFMM exact-in KAT (get_amount_out), the route-hop analog of the batch
// clearing KAT. Asserts:
//   1. the committed fixture (contracts/sp1/confidential/fixtures/get_amount_out_vectors.json) is
//      CURRENT — i.e. equals a fresh compute from the JS reference, so an edit to the curve without
//      re-running the generator can't leave the Rust guest pinned to a stale fixture (silent drift).
//   2. for every vector the Bitcoin route validator's floor admits EXACTLY the curve output and
//      rejects one more — tying the worker/dapp route lane to the same value the Rust guest computes.
// The Rust side asserts get_amount_out == these vectors (cxfer-core get_amount_out_matches_js_vectors).
//
// Run: node tests/amount-out-parity.test.mjs
import { readFileSync } from 'node:fs';
import { computeVectors, CASES, getAmountOut } from './gen-amount-out-vectors.mjs';
import { cfmmFloorOk } from './swap-route.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try { if (fn() === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const committed = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/get_amount_out_vectors.json', import.meta.url)));

test('committed get_amount_out fixture is current (regenerate with node tests/gen-amount-out-vectors.mjs)', () =>
  JSON.stringify(committed.vectors) === JSON.stringify(computeVectors()));

test('Bitcoin route floor (cfmmFloorOk) admits exactly the curve output and rejects one more', () =>
  CASES.every((c) => {
    const out = getAmountOut(c.amountIn, c.reserveIn, c.reserveOut, c.feeBps);
    const f = (d) => cfmmFloorOk({ delta_in: c.amountIn, delta_out: d, R_in: c.reserveIn, R_out: c.reserveOut, fee_bps: c.feeBps });
    return f(out) === true && f(out + 1n) === false;
  }));

console.log(`\n${pass}/${pass + fail} amount-out parity checks passed`);
process.exit(fail === 0 ? 0 : 1);
