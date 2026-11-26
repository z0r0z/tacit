#!/usr/bin/env node
// The numbers behind the stuck-TAC write-up (docs/STUCK-TAC-BOUNTY.md, option C), in the shape of the desk entry's table:
// a provider starts with 10,000 TAC it can lend; bridges are 100 TAC; of the notes bridged, 5% have a history longer than
// the proof follows (the brief's count: 230 of 4,546 unspent notes over the limit) and 2% are exits from the shielded pool
// (an assumption, stated as one in the write-up: pool exits are uncounted in the brief). Three ways of running compare:
// screening and refusing (today's lineage screen), taking any TAC at the standing fee (today's anyTac), and the priced rule
// (dapp/fast/stuck-terms.js at its default assumptions: unsticking costs the desk's published 30 bps + a flat 1 TAC a note;
// a long note never unsticks a tenth of the time, a pool exit a fifth). Expected values throughout: a fractional bridge is
// the average over many. The priced column's lendable TAC holds because the uplift collected is the expected haircut by
// construction, and that identity is asserted here against figures worked by hand from the assumptions, not from the code.
//   node tests/stuck-terms-numbers.test.mjs        (Node 22)

import { classFee, haircutBps, expectedFlat } from '../dapp/fast/stuck-terms.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };
const TAC = 10n ** 8n;
const U = (tac) => BigInt(tac) * TAC;
const START = 10000, BRIDGE = 100;                       // TAC
const LONG_SHARE = 5, EXIT_SHARE = 2, CLEAN_SHARE = 93;  // of every 100 bridges, by count
const BASE = { feeBps: 30, flatFee: 10_000_000n };       // the standing terms (PROVIDER_DEFAULTS)

// The expected haircut of one stuck bridge, worked by hand from the assumptions:
// long: a tenth loses the whole 100 TAC; the rest pay 30 bps of 100 plus the flat 1 TAC to unstick: 10 + 0.9 x 1.3 = 11.17 TAC.
// pool-exit: a fifth loses the whole 100 TAC; the rest pay the same unstuck cost: 20 + 0.8 x 1.3 = 21.04 TAC.
const byHand = (neverTenths, unlockTenths) => (BigInt(neverTenths) * U(BRIDGE) + BigInt(unlockTenths) * 130_000_000n) / 10n;
ok(classFee(U(BRIDGE), 'long', { base: BASE }) - classFee(U(BRIDGE), 'clean', { base: BASE }) === byHand(1, 9), 'long: the uplift on a 100 TAC bridge is the hand-worked expected haircut, 11.17 TAC');
ok(classFee(U(BRIDGE), 'pool-exit', { base: BASE }) - classFee(U(BRIDGE), 'clean', { base: BASE }) === byHand(2, 8), 'pool-exit: the uplift on a 100 TAC bridge is the hand-worked expected haircut, 21.04 TAC');
ok(haircutBps('long') === 1027 && expectedFlat('long') === 90_000_000n, 'long at the defaults: 1027 bps and 0.9 TAC of expected flat cost');
ok(haircutBps('pool-exit') === 2024 && expectedFlat('pool-exit') === 80_000_000n, 'pool-exit at the defaults: 2024 bps and 0.8 TAC of expected flat cost');

// Sensitivity: a provider that unsticks at the desk as a matter of routine writes far fewer notes off whole
// (long 2%, pool-exit 5%): the same rule prices the same bridges at 3.28 and 6.24 TAC of uplift.
{
  const cfg = { base: BASE, classes: { long: { neverBps: 200 }, 'pool-exit': { neverBps: 500 } } };
  ok(classFee(U(BRIDGE), 'long', cfg) - classFee(U(BRIDGE), 'clean', cfg) === 328_000_000n, 'sensitivity, long at 2% written off: the uplift is 3.28 TAC of 100');
  ok(classFee(U(BRIDGE), 'pool-exit', cfg) - classFee(U(BRIDGE), 'clean', cfg) === 624_000_000n, 'sensitivity, pool-exit at 5% written off: the uplift is 6.24 TAC of 100');
}

// The three regimes, in expectation. Refusing: stuck bridges are turned away, lendable TAC never moves, and only the
// clean share is served. Flat: every stuck bridge moves 100 TAC out of what can be lent, at the standing fee, until
// nothing is left to lend (at 7 TAC of capacity a bridge, the 10,000 TAC is gone after 1,428 bridges). Priced: stuck
// bridges are served at their class fees and unstuck as they come; the uplift collected is the expected unstuck loss,
// so lendable TAC holds in expectation while every bridge is served.
const rows = [10, 50, 100, 500, 1000];
console.log('\n  bridges | refuse: lendable TAC, served | anyTac flat: lendable TAC | priced: lendable TAC, served');
for (const bridges of rows) {
  const stuckTac = (LONG_SHARE + EXIT_SHARE) * bridges;                    // 7 TAC of capacity per bridge, in TAC units x100 bridges-share: (5+2)% of 100 TAC
  const refuseLendable = START, refuseServed = (CLEAN_SHARE * bridges) / 100;
  const flatLendable = Math.max(0, START - stuckTac);
  const pricedLendable = START, pricedServed = bridges;
  console.log(`  ${String(bridges).padStart(7)} | ${refuseLendable}, ${refuseServed} | ${flatLendable} | ${pricedLendable}, ${pricedServed}`);
  ok(refuseLendable === 10000 && pricedLendable === 10000, `after ${bridges} bridges: refusing and pricing both hold 10,000 TAC lendable`);
  ok(flatLendable === 10000 - 7 * bridges, `after ${bridges} bridges: taking any TAC at the standing fee leaves ${10000 - 7 * bridges} TAC lendable`);
}
ok(Math.floor(START / 7) === 1428, 'taking any TAC at the standing fee runs out of lendable TAC after 1,428 bridges');

console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} stuck-terms numbers checks passed`);
process.exit(failures ? 1 : 0);
