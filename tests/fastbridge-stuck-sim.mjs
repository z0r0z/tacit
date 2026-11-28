// What a fast bridge provider holds after N bridges, with and without the stuck TAC pricing rule
// (docs/STUCK-TAC-BOUNTY.md, entry C). Expected values throughout — no randomness — so the numbers in
// the write-up reproduce exactly: node tests/fastbridge-stuck-sim.mjs
//
// The model, with every assumption on the table:
//   - The provider starts with 100,000 TAC of pool-side inventory and rebalances clean Bitcoin TAC home
//     over the regular bridge as it goes (the wait for that is real but is not what drains it, so clean
//     TAC is treated as coming home whole). Only stuck TAC never comes home.
//   - Bridges average 100 TAC. Of every bridge's notes, the lock falls in a class with the shares below.
//     The long share is the bounty's own count (230 of 4,546 unspent notes over the history limit on
//     2026-11-22, about 5%); pool exits were not counted there, so 2% is an assumption, and the table is
//     re-run at 5% in the sensitivity lines.
//   - A stuck note's expected recoverable value is its face times one minus its class haircut (the same
//     haircuts the pricing rule charges, DEFAULT_STUCK_POLICY): it can be sold on the Bitcoin order book
//     or through a desk, at a discount, but it is not worthless.
//   - Base terms are the defaults (0.30% + 0.1 TAC). Fees are kept from the payout, so a bridge of A pays
//     out A − fee on the pool side and brings A in on the Bitcoin side.
//
// Three policies:
//   anyTac   today's daemon: takes everything at the base fee. Stuck TAC piles up on the Bitcoin side,
//            its expected loss carried by the provider.
//   screen   today's other choice: refuses long, pool-exit and other locks. Nothing is lost and nothing
//            is stuck — and that demand is turned away unserved.
//   priced   this entry: takes everything, at the base fee plus the class's haircut on stuck locks. The
//            expected loss is covered by the add-on as it is taken, so the provider's expected position
//            is whole; its pool-side inventory still drains by the stuck face until the Bitcoin-side
//            proceeds are brought back (the desk of entry A or the loop of entry B does that carrying;
//            pricing is what makes carrying it worth doing).

const START = 100_000;          // pool-side inventory, TAC
const SIZE = 100;               // average bridge, TAC
const BASE_FEE = SIZE * 0.0030 + 0.1; // per bridge at the default terms
const HAIRCUT = { long: 0.05, 'pool-exit': 0.10, other: 0.15 };

function run(N, shares) {
  const stuck = { long: 0, 'pool-exit': 0, other: 0 }; // face value held on Bitcoin, by class
  let refused = 0, addOn = 0, baseFees = 0;
  for (const [cls, share] of Object.entries(shares)) stuck[cls] = N * share * SIZE;
  refused = N * (shares.long + shares['pool-exit'] + shares.other) * SIZE;
  for (const [cls, face] of Object.entries(stuck)) addOn += face * HAIRCUT[cls];
  baseFees = N * BASE_FEE;
  const face = Object.values(stuck).reduce((a, b) => a + b, 0);
  const recoverable = Object.entries(stuck).reduce((a, [cls, f]) => a + f * (1 - HAIRCUT[cls]), 0);
  const expectedLoss = face - recoverable;
  // screen never takes the stuck locks, so it holds none of them: its cost is the refused column.
  const row = (policy, poolSide, extra) => ({
    policy, N,
    poolSide: round(poolSide),
    stuckFace: round(policy === 'screen' ? 0 : face), stuckWorth: round(policy === 'screen' ? 0 : recoverable),
    expectedLoss: round(policy === 'screen' ? 0 : expectedLoss), extraFees: round(extra),
    refused: round(policy === 'screen' ? refused : 0),
  });
  return [
    row('anyTac', START - face, 0),
    row('screen', START, 0),
    row('priced', START - face, addOn),
  ];
}

const round = (x) => Math.round(x * 100) / 100;
const shares = { long: 0.05, 'pool-exit': 0.02, other: 0.00 };
console.log('Shares per bridge: long 5% (the bounty count), pool-exit 2% (assumed), other 0%');
console.log('Base fees are earned by every policy on the bridges it serves and are left out of `net` except as noted.\n');
for (const N of [100, 500, 1000]) {
  for (const r of run(N, shares)) {
    console.log(
      `${r.policy.padEnd(7)} N=${String(N).padEnd(5)} pool side ${fmt(r.poolSide)}  stuck face ${fmt(r.stuckFace)}  ` +
      `stuck worth ${fmt(r.stuckWorth)}  expected loss ${fmt(r.expectedLoss)}  add-on fees ${fmt(r.extraFees)}  refused ${fmt(r.refused)}`);
  }
  console.log('');
}
function fmt(x) { return x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).padStart(9); }

// Sensitivity: the priced policy when the haircuts turn out worse than assumed (realised 10% / 20% /
// 25% against the 5% / 10% / 15% charged), N = 1000. The add-on is fixed at quote time, so a worse
// realised haircut is a real loss — the write-up says so, and a provider that fears it raises its own
// haircutBps or lowers maxAddBps until the class is refused instead.
console.log('Sensitivity, priced policy, N=1000, realised haircuts worse than charged:');
for (const realised of [{ long: 0.10, 'pool-exit': 0.20, other: 0.25 }]) {
  const rows = run(1000, shares);
  const face = { long: 1000 * shares.long * SIZE, 'pool-exit': 1000 * shares['pool-exit'] * SIZE, other: 0 };
  const charged = Object.entries(face).reduce((a, [c, f]) => a + f * HAIRCUT[c], 0);
  const lost = Object.entries(face).reduce((a, [c, f]) => a + f * realised[c], 0);
  console.log(`  charged ${fmt(charged)}  realised loss ${fmt(lost)}  shortfall ${fmt(lost - charged)}`);
}
// And the pool-exit share at 5% instead of 2% (it was not in the bounty count), N = 1000:
console.log('\nPool-exit share 5% instead of 2%, N=1000:');
for (const r of run(1000, { long: 0.05, 'pool-exit': 0.05, other: 0.00 })) {
  console.log(`  ${r.policy.padEnd(7)} pool side ${fmt(r.poolSide)}  stuck face ${fmt(r.stuckFace)}  expected loss ${fmt(r.expectedLoss)}  add-on fees ${fmt(r.extraFees)}  refused ${fmt(r.refused)}`);
}
