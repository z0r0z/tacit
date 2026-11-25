// What a provider holds after N bridges, with and without the stuck-TAC pricing rule
// (fastbridge-lp/lib/stuck-pricing.mjs, bounty entry C). Deterministic and offline: the mix is fixed
// by the brief's count, not sampled, so the numbers in the write-up are these numbers, re-run.
//   node fastbridge-lp/stuck-sim.mjs
//
// The model, stated plainly so it can be argued with:
//   - every bridge takes 100 TAC; the provider starts with 10,000 TAC of Ethereum-side inventory;
//   - the mix of notes: 93% clean, 5% long history (230 of 4,546 unspent notes were over the history
//     limit in the count of 2026-11-22, pool exits not counted), 2% pool exit (an assumption, stated
//     as one: the brief counts no pool exits, so 2% is a guess at their share of what providers are
//     offered, and the script takes it as a flag: node fastbridge-lp/stuck-sim.mjs 5 for 5%);
//   - a clean note bridges home and its value is lent again, so a clean bridge costs the provider
//     nothing but its fee, which it keeps;
//   - a stuck note never bridges home. Without the rule it is taken at the ordinary fee and realised
//     later at the class's expected recovery. With the rule it is taken at the class's priced fee
//     while the config's caps leave room (here the binding one is the stuck share: 20% of the 10,000
//     TAC inventory is 2,000 TAC of stuck face) and refused past them, so a refused note stays with
//     its holder and costs the provider nothing;
//   - "value held" is Ethereum-side inventory plus the expected realisable value of the stuck TAC on
//     Bitcoin, less the lockup cost of the wait on the notes taken under the rule (without the rule
//     the wait is not priced or bounded, so it is not charged: the without column is the kinder one).

import { CLASS, decideTake, stuckPolicy } from './lib/stuck-pricing.mjs';

const TAC = 100000000n;
const policy = stuckPolicy();
const START = 10000n * TAC, AMOUNT = 100n * TAC;
const NOTES = {
  [CLASS.CLEAN]: { trace: 'tracked', poolExit: false, transfers: 12 },
  [CLASS.LONG_HISTORY]: { trace: 'tracked', poolExit: false, transfers: 900 },
  [CLASS.POOL_EXIT]: { trace: 'unprovable', poolExit: true, transfers: 3 },
};
const poolExitShare = Number(process.argv[2] ?? 2); // percent of bridges, an assumption (see above)
const mix = [ // per 100 bridges
  [CLASS.CLEAN, 95 - poolExitShare], [CLASS.LONG_HISTORY, 5], [CLASS.POOL_EXIT, poolExitShare],
];

function run(n, withRule) {
  let eth = START, stuckFace = 0n, stuckValue = 0n, fees = 0n, lockup = 0n, refused = 0;
  const stuckByClass = { [CLASS.LONG_HISTORY]: 0n, [CLASS.POOL_EXIT]: 0n };
  for (let i = 0; i < n; i++) {
    // the fixed mix, spread evenly: bridge i takes the class the count assigns it
    let at = (i * 100) / n, cls = CLASS.CLEAN;
    for (const [c, share] of mix) { if (at < share) { cls = c; break; } at -= share; }
    const note = NOTES[cls];
    if (withRule) {
      const d = decideTake({ notes: [note], amount: AMOUNT, inventoryTac: START, stuckTac: stuckFace, stuckTodayTac: 0n }, policy);
      // the per-day cap is a rate limit, not a lifetime one: days pass in a run of N bridges, so the
      // snapshot passes stuckTodayTac 0 and the share cap is the one that binds over a whole run
      if (!d.accept) { refused++; continue; }
      eth -= d.evmOut; fees += d.fee;
      if (cls !== CLASS.CLEAN) {
        stuckFace += AMOUNT; stuckByClass[cls] += AMOUNT;
        stuckValue += (AMOUNT * BigInt(policy.recoveryBps[cls])) / 10000n;
        lockup += (AMOUNT * BigInt(policy.lockupBpsPerDay * policy.expectedDaysStuck[cls])) / 10000n;
      } else eth += AMOUNT; // a clean note comes home and is lent again
    } else {
      const fee = (AMOUNT * BigInt(policy.baseFeeBps)) / 10000n + policy.flatFee;
      eth -= AMOUNT - fee; fees += fee;
      if (cls !== CLASS.CLEAN) {
        stuckFace += AMOUNT; stuckByClass[cls] += AMOUNT;
        stuckValue += (AMOUNT * BigInt(policy.recoveryBps[cls])) / 10000n;
      } else eth += AMOUNT;
    }
  }
  return { eth, stuckFace, stuckValue, fees, lockup, refused, stuckByClass, total: eth + stuckValue - (withRule ? lockup : 0n) };
}

const tac = (b) => (Number(b) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 1 });
console.log(`mix per 100 bridges: ${mix.map(([c, s]) => `${c} ${s}`).join(', ')}; start 10,000 TAC; 100 TAC a bridge\n`);
console.log('bridges | rule | ETH inventory | stuck face (long / pool) | stuck value | fees kept | refused | value held');
for (const n of [100, 1000]) {
  for (const withRule of [false, true]) {
    const r = run(n, withRule);
    console.log(`${n} | ${withRule ? 'with' : 'without'} | ${tac(r.eth)} | ${tac(r.stuckFace)} (${tac(r.stuckByClass[CLASS.LONG_HISTORY])} / ${tac(r.stuckByClass[CLASS.POOL_EXIT])}) | ${tac(r.stuckValue)} | ${tac(r.fees)} | ${r.refused} | ${tac(r.total)}`);
  }
}
