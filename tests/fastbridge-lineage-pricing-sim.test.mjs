// The account behind the stuck-TAC pricing write-up: what a provider holds after 1, 10 and 25 bridges of the same size,
// with no lineage rule and with the class addition set to the expected haircut. Offline arithmetic only.
//   node tests/fastbridge-lineage-pricing-sim.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { normalizeLineageFees, lineageTerms } from '../dapp/fastbridge-lineage-pricing.js';

const START = 100_000n, AMOUNT = 10_000n, BASE_BPS = 30;
const fees = normalizeLineageFees({
  defaultClass: 'pool-exit',
  long: { feeBps: 1000, flatFee: '0' },
  poolExit: { feeBps: 2500, flatFee: '0' },
});
// In this model the expected haircut is exactly the class addition: 10% for a long history, 25% for a pool exit.
const haircutBps = { clean: 0n, long: 1_000n, 'pool-exit': 2_500n };

function afterBridges(cls, n, priced) {
  const terms = priced ? lineageTerms({ feeBps: BASE_BPS, flatFee: 0n }, fees, cls) : { feeBps: BigInt(BASE_BPS), flatFee: 0n };
  const fee = (AMOUNT * terms.feeBps) / 10000n + terms.flatFee;
  const paidOut = AMOUNT - fee;
  const recovered = (AMOUNT * (10_000n - haircutBps[cls])) / 10_000n;
  return START + BigInt(n) * (recovered - paidOut);
}

const rows = [];
for (const cls of ['clean', 'long', 'pool-exit']) for (const n of [1, 10, 25]) rows.push({ class: cls, bridges: n, without: afterBridges(cls, n, false), with: afterBridges(cls, n, true) });

// Clean TAC is unaffected: the base 0.30% fee is a gain of 30 per 10,000 bridge under either rule.
for (const n of [1, 10, 25]) assert.equal(afterBridges('clean', n, false), afterBridges('clean', n, true));
assert.equal(afterBridges('clean', 25, true), 100_750n);

// A long note priced like clean TAC loses 970 per bridge (a 10% haircut less the 0.30% base fee); priced at +10%, it keeps the same 30 margin.
assert.equal(afterBridges('long', 1, false), 99_030n);
assert.equal(afterBridges('long', 10, false), 90_300n);
assert.equal(afterBridges('long', 25, false), 75_750n);
assert.equal(afterBridges('long', 1, true), 100_030n);
assert.equal(afterBridges('long', 10, true), 100_300n);
assert.equal(afterBridges('long', 25, true), 100_750n);

// A pool exit priced like clean TAC loses 2,470 per bridge; priced at +25%, it keeps the same 30 margin.
assert.equal(afterBridges('pool-exit', 1, false), 97_530n);
assert.equal(afterBridges('pool-exit', 10, false), 75_300n);
assert.equal(afterBridges('pool-exit', 25, false), 38_250n);
assert.equal(afterBridges('pool-exit', 1, true), 100_030n);
assert.equal(afterBridges('pool-exit', 10, true), 100_300n);
assert.equal(afterBridges('pool-exit', 25, true), 100_750n);

console.log('  class      bridges  without rule  with lineage fee');
for (const r of rows) console.log(`  ${r.class.padEnd(10)} ${String(r.bridges).padStart(7)}  ${r.without.toString().padStart(12)}  ${r.with.toString().padStart(15)}`);
console.log('\n18/18 lineage-pricing simulation checks passed');
