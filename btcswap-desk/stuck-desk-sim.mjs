#!/usr/bin/env node
// What a fast bridge provider holds after N bridges, with and without the stuck-TAC desk
// (btcswap-desk/lib/stuck-desk.mjs, bounty entry A). Deterministic: no randomness, the same
// bridge pattern every run, so the numbers below are the numbers in the write-up.
//   node btcswap-desk/stuck-desk-sim.mjs        (Node 22)
//
// The pattern, from the brief's count of 2026-11-22: 230 of 4,546 unspent notes (about 5%) were
// over the history limit, pool exits not counted. So of every 20 bridges, 19 carry a clean note
// and 1 carries a stuck note of 100 TAC; of every 10 stuck notes, 7 are long history and 3 are
// pool exits (an assumption — pool exits were not counted; the split is stated here and in the
// write-up, and the desk's caps do not depend on it). The provider starts with 10,000 TAC of
// lendable Ethereum-side inventory; every bridge pays out 100 TAC of it and takes a 100 TAC note
// on Bitcoin. A clean note comes home over the regular bridge and restores the 100. A stuck note
// does not come home: without the desk it sits on Bitcoin and the lendable side is 100 poorer for
// good. With the desk, the provider swaps the stuck note on Bitcoin for tracked TAC at the desk's
// discount for its class, brings that home, and loses only the discount.
//
// The desk is the module itself, with the example config's limits and a pledge book of 10,000 TAC
// from three pledgers, so its caps, reserve and per-day limit are the ones that bind or don't.

import { CLASS, deskPolicy, makePledgeBook, makeStuckDesk } from './lib/stuck-desk.mjs';

const TAC = 100000000n;
const N = 1000;                 // bridges
const VALUE = 100n * TAC;       // every bridge carries 100 TAC
const START = 10000n * TAC;     // the provider's lendable inventory at the start
const DAY = 50;                 // bridges per day, so the run spans 20 days

const fmt = (units) => {
  const neg = units < 0n, u = neg ? -units : units;
  const whole = u / TAC, frac = String((u % TAC) / 1000000n).padStart(2, '0');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac}`;
};

const clean = { trace: 'tracked', poolExit: false, transfers: 12 };
const longHistory = { trace: 'tracked', poolExit: false, transfers: 900 };
const poolExit = { trace: 'unprovable', poolExit: true, transfers: 3 };
// bridge i (1-based): every 20th is stuck; stuck number k splits 7 long history : 3 pool exit
const noteFor = (i) => {
  if (i % 20) return clean;
  const k = i / 20; // 1..50
  return (k - 1) % 10 < 7 ? longHistory : poolExit;
};

// ── without the desk ──
let lendableNo = START, stuckNo = 0n, stuckCountNo = 0;
for (let i = 1; i <= N; i++) {
  const note = noteFor(i);
  lendableNo -= VALUE;                       // the bridge pays out on Ethereum
  if (note === clean) lendableNo += VALUE;   // a clean note comes home and restores it
  else { stuckNo += VALUE; stuckCountNo++; } // a stuck note stays on Bitcoin
}

// ── with the desk ──
let clock = 1764072000; // 2026-11-25T12:00:00Z, advanced a day every DAY bridges
const pledges = makePledgeBook();
pledges.pledge('provider-a', 5000n * TAC);
pledges.pledge('provider-b', 3000n * TAC);
pledges.pledge('holder-c', 2000n * TAC);
const desk = makeStuckDesk({ policy: deskPolicy(), pledges, now: () => clock });
let lendable = START, stuckHeld = 0n, swapped = 0, refused = 0, paidOut = 0n, keptAsDiscount = 0n;
let peakDayOut = 0n;
for (let i = 1; i <= N; i++) {
  if (i > 1 && (i - 1) % DAY === 0) { clock += 86400; peakDayOut = peakDayOut > desk.outToday() ? peakDayOut : desk.outToday(); }
  const note = noteFor(i);
  lendable -= VALUE;
  if (note === clean) { lendable += VALUE; continue; }
  const r = desk.quote({ note, amount: VALUE });
  if (!r.ok) { refused++; stuckHeld += VALUE; continue; } // the desk could not take it: it stays stuck
  desk.accept(r.quote.id);
  swapped++; paidOut += r.quote.amountOut; keptAsDiscount += VALUE - r.quote.amountOut;
  lendable += r.quote.amountOut; // the tracked TAC comes home over the regular bridge
}
peakDayOut = peakDayOut > desk.outToday() ? peakDayOut : desk.outToday();

console.log(`stuck-TAC desk simulation: ${N} bridges of ${fmt(VALUE)} TAC, ${DAY} bridges a day`);
console.log(`pattern: 5% of notes stuck (the brief's 230 of 4,546), of stuck 70% ${CLASS.LONG_HISTORY} / 30% ${CLASS.POOL_EXIT} (assumed split)`);
console.log('');
console.log('without the desk:');
console.log(`  lendable inventory at the end   ${fmt(lendableNo)} TAC  (started ${fmt(START)})`);
console.log(`  stuck on Bitcoin, cannot lend   ${fmt(stuckNo)} TAC  (${stuckCountNo} notes)`);
console.log('');
console.log('with the desk (example config: discounts 3,680 / 4,255 bps, per-note cap 1,000 TAC, per-day cap 5,000 TAC out, 20% share, 10% reserve):');
console.log(`  lendable inventory at the end   ${fmt(lendable)} TAC`);
console.log(`  stuck still held (desk refused) ${fmt(stuckHeld)} TAC`);
console.log(`  stuck notes swapped             ${swapped} of ${stuckCountNo}  (refused ${refused})`);
console.log(`  tracked TAC the desk paid out   ${fmt(paidOut)} TAC`);
console.log(`  value the desk kept as discount ${fmt(keptAsDiscount)} TAC  (this is the provider's whole loss with the desk)`);
console.log(`  busiest day at the desk         ${fmt(peakDayOut)} TAC out of the 5,000 TAC per-day cap`);
console.log(`  pledged inventory at the end    ${fmt(pledges.totalPledged() - pledges.totalSettled())} TAC unspent of ${fmt(pledges.totalPledged())} pledged (reserve floor 1,000 TAC never touched)`);
for (const id of pledges.pledgers()) {
  const p = pledges.pledger(id);
  console.log(`    ${id}: pledged ${fmt(p.pledged)}, settled ${fmt(p.settled)}, still theirs ${fmt(p.available)}`);
}
