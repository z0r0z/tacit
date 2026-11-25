// What a fast-bridge provider holds after N bridges, with and without the desk (docs/STUCK-TAC-BOUNTY.md):
// the brief counts 230 of 4,546 unspent TAC notes (~5%) over the history limit, so 5% of what a provider takes on
// Bitcoin cannot come home. The desk swaps a stuck note for tracked TAC at 30 bps plus a flat 1 TAC per swap.
// Units are the token's smallest (1 TAC = 100,000,000); the fee is the desk's own formula, integer arithmetic.
//   node tests/btcswap-desk-numbers.test.mjs

import assert from 'node:assert/strict';

const UNIT = 100_000_000n; // one TAC
const START = 10_000n * UNIT; // the provider's lendable TAC on Ethereum
const BRIDGE = 100n * UNIT; // TAC moved per bridge
const STUCK_RATE_NUM = 5n, STUCK_RATE_DEN = 100n; // 5% of what the provider takes on Bitcoin is stuck
const FEE_BPS = 30n, FLAT = 1n * UNIT; // the desk's fee

const feeOf = (amount) => (amount * FEE_BPS) / 10000n + FLAT;
const tac = (units) => Number(units) / 1e8;

// Without the desk, stuck TAC piles up on Bitcoin and the Ethereum inventory drains by exactly that much.
const withoutDesk = (n) => START - BigInt(n) * BRIDGE * STUCK_RATE_NUM / STUCK_RATE_DEN;
// With the desk, stuck TAC is swapped back in notes of `swapSize`; the loss is only the fee, plus the unswapped tail.
function withDesk(n, swapSize) {
  const stuck = BigInt(n) * BRIDGE * STUCK_RATE_NUM / STUCK_RATE_DEN;
  const swaps = stuck / swapSize;
  const recovered = swaps * (swapSize - feeOf(swapSize));
  return START - (stuck - recovered);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the desk fee schedule, and the smallest note it can swap', () => {
  assert.equal(feeOf(100n * UNIT), 13n * UNIT / 10n, 'a 100 TAC swap costs 1.3 TAC');
  assert.equal(feeOf(10n * UNIT), 103n * UNIT / 100n, 'a 10 TAC swap costs 1.03 TAC');
  // the fee eats a 1 TAC note whole, and the first amount that clears it is 100,300,903 units (~1.003 TAC)
  assert.ok(1n * UNIT - feeOf(1n * UNIT) <= 0n, 'a 1 TAC note cannot be swapped');
  assert.equal(100300903n - feeOf(100300903n), 1n, 'the break-even note returns 1 unit');
  assert.ok(100300902n - feeOf(100300902n) <= 0n, 'one unit below the break-even returns nothing');
});

test('provider holdings after N bridges, with and without the desk', () => {
  console.log('  bridges | without desk | with desk (100 TAC swaps) | with desk (10 TAC swaps) | stuck recovered (100 TAC swaps)');
  for (const n of [10, 50, 100, 500, 1000, 2000]) {
    const wo = withoutDesk(n), w100 = withDesk(n, 100n * UNIT), w10 = withDesk(n, 10n * UNIT);
    const recovered = BigInt(n) * BRIDGE * STUCK_RATE_NUM / STUCK_RATE_DEN - (START - w100);
    console.log(`  ${String(n).padStart(7)} | ${tac(wo).toFixed(0).padStart(12)} | ${tac(w100).toFixed(0).padStart(25)} | ${tac(w10).toFixed(0).padStart(24)} | ${tac(recovered).toFixed(0).padStart(18)}`);
    // a swap only helps once a full swap-size of stuck TAC has piled up: at 10 bridges only 50 TAC is stuck,
    // so no 100 TAC swap has happened yet and the desk is exactly as good as doing nothing.
    assert.ok(w100 >= wo && w10 > wo, `the desk never leaves less lendable after ${n} bridges`);
    if (n >= 20) assert.ok(w100 > wo, 'once a full 100 TAC swap has run, the desk leaves more lendable');
  }
  assert.equal(withoutDesk(2000), 0n, 'without the desk the inventory is gone after 2,000 bridges');
  assert.equal(tac(withDesk(1000, 100n * UNIT)), 9935, 'with 100 TAC swaps, 9,935 TAC is still lendable after 1,000 bridges');
  assert.equal(tac(withDesk(1000, 10n * UNIT)), 9485, 'with 10 TAC swaps, 9,485 TAC is still lendable after 1,000 bridges');
  assert.equal(tac(withoutDesk(1000)), 5000, 'without the desk, 5,000 TAC is still lendable after 1,000 bridges');
});

let failed = 0;
for (const [name, fn] of tests.filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY))) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.stack || e).split('\n').slice(0, 6).join('\n  ')}`); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
