// The provider projection: how much Ethereum-side TAC a fast-bridge provider holds after N bridges, with the stuck-TAC
// desk and without it. Deterministic, no chain, no clock: projectProvider in tests/lib/btcswap-world.mjs. The printed
// table is the numbers section of the write-up, produced by code, not by hand.
//   node tests/btcswap-numbers.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { projectProvider } from './lib/btcswap-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the projection: with the desk the provider never holds stuck TAC, and holds more on Ethereum', () => {
  for (const n of [20, 50, 100]) for (const bps of [100, 300]) {
    const p = projectProvider({ n, discountBps: bps });
    assert.equal(p.stuckWith, 0n, `N=${n} ${bps}bps: the desk takes every stuck note`);
    assert.ok(p.stuckWithout > 0n, `N=${n} ${bps}bps: without the desk some notes stay stuck`);
    assert.ok(p.ethWith > p.ethWithout, `N=${n} ${bps}bps: the desk leaves the provider with more on Ethereum`);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}: ${e.message}`); }
}

// The table: a provider bridging one 100-TAC note per bridge, 5% of notes stuck, desk fee 30bps + 1 TAC, return 50bps.
// Values are in TAC (1 TAC = 100,000,000 units).
const tac = (v) => (Number(v) / 100_000_000).toFixed(1);
console.log('\nProvider holdings after N bridges, one 100-TAC note per bridge, 5% of notes stuck');
console.log('discount | N   | ETH-side TAC with desk | ETH-side TAC without | stuck TAC with desk | stuck TAC without');
for (const bps of [100, 300]) for (const n of [20, 50, 100]) {
  const p = projectProvider({ n, discountBps: bps });
  const row = (v) => tac(v).padStart(6);
  console.log(`${(bps / 100).toFixed(0)}%        | ${String(n).padStart(3)} | ${row(p.ethWith)} | ${row(p.ethWithout)} | ${row(p.stuckWith)} | ${row(p.stuckWithout)}`);
}
console.log('\nThe desk takes the stuck notes at the discount and pays the return on what it draws; the provider\'s');
console.log('Ethereum-side TAC is what bridges home at once. Stuck TAC without the desk waits for a new pool');
console.log('generation, which the brief does not promise.');
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
