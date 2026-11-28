// The account behind the stuck-TAC pricing write-up: what a provider holds after 1, 10 and 25 bridges of the same size,
// with no lineage rule and with the class addition set to the expected haircut. Offline arithmetic only.
//   node tests/fastbridge-lineage-pricing-sim.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { lineageCapAllows, normalizeLineageFees, lineageTerms } from '../dapp/fastbridge-lineage-pricing.js';

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


// Stress model: the payout leaves immediately, while the Bitcoin-side note is recovered only after `delay` bridges (never, when
// delay is null). Exposure is face value held in stuck classes, as the daemon's caps count it. This is intentionally harsher
// than the instant-recovery table above.
function stress({ n = 25, mix, delay = 5, priced = true, caps = null, haircuts = haircutBps }) {
  const cfg = caps ? normalizeLineageFees({
    defaultClass: 'pool-exit', long: { feeBps: 1000, flatFee: '0' }, poolExit: { feeBps: 2500, flatFee: '0' }, caps,
  }) : fees;
  let inv = START, refused = 0, recoveredValue = 0n;
  const exposure = { long: 0n, poolExit: 0n }, due = [];
  const rows = [];
  for (let i = 0; i < n; i++) {
    while (due.length && due[0].at === i) {
      const r = due.shift();
      inv += r.value; recoveredValue += r.value;
      if (r.cls !== 'clean') exposure[r.cls === 'pool-exit' ? 'poolExit' : r.cls] -= AMOUNT;
    }
    const cls = mix(i);
    const canTake = !caps || cls === 'clean' || lineageCapAllows(cfg, exposure, cls, AMOUNT);
    if (!canTake) { refused++; rows.push({ i, cls, refused: true, inv, long: exposure.long, poolExit: exposure.poolExit }); continue; }
    const terms = priced ? lineageTerms({ feeBps: BigInt(BASE_BPS), flatFee: 0n }, cfg, cls) : { feeBps: BigInt(BASE_BPS), flatFee: 0n };
    const fee = (AMOUNT * terms.feeBps) / 10000n + terms.flatFee;
    inv -= AMOUNT - fee;
    if (cls !== 'clean') exposure[cls === 'pool-exit' ? 'poolExit' : cls] += AMOUNT;
    if (delay != null) due.push({ at: i + delay, cls, value: (AMOUNT * (10_000n - haircuts[cls])) / 10_000n });
    else recoveredValue += 0n;
    rows.push({ i, cls, refused: false, inv, long: exposure.long, poolExit: exposure.poolExit });
  }
  const pending = due.reduce((a, r) => a + r.value, 0n);
  return { inv, exposure, refused, pending, rows };
}

const rising = (i) => (i < 5 ? 'clean' : i < 15 ? 'long' : 'pool-exit');
const worse = { clean: 0n, long: 1_200n, 'pool-exit': 3_000n };
const allLong = () => 'long';

const worseWithout = stress({ mix: rising, haircuts: worse, priced: false });
const worseWith = stress({ mix: rising, haircuts: worse, priced: true });
assert.equal(worseWithout.inv, 23_750n);
assert.equal(worseWith.inv, 58_750n);
assert.equal(worseWith.refused, 0);

const cappedCfg = { long: '20000', poolExit: '10000', total: '25000' };
const uncapped = stress({ mix: rising, haircuts: worse, priced: true });
const capped = stress({ mix: rising, haircuts: worse, priced: true, caps: cappedCfg });
assert.ok(capped.exposure.long <= 20_000n && capped.exposure.poolExit <= 10_000n && capped.exposure.long + capped.exposure.poolExit <= 25_000n);
assert.equal(capped.refused, 14);
assert.ok(capped.inv > uncapped.inv, 'caps stop the worst tail even when some flow is refused');
assert.ok(capped.rows.every((r) => r.long + r.poolExit <= 25_000n));

// A refused or refunded lock never becomes exposure, so capacity is available again immediately. Here every fifth long is
// refunded before the take; it pays nothing and holds nothing.
function refunding(n = 25) {
  const cfg = normalizeLineageFees({ defaultClass: 'pool-exit', long: { feeBps: 1000, flatFee: '0' }, poolExit: { feeBps: 2500, flatFee: '0' }, caps: { long: '40000', total: '40000' } });
  const exposure = { long: 0n, poolExit: 0n };
  let inv = START, refused = 0, refunded = 0;
  const due = [];
  for (let i = 0; i < n; i++) {
    while (due.length && due[0].at === i) { const r = due.shift(); inv += r.value; exposure.long -= AMOUNT; }
    if (i % 5 === 4) { refunded++; continue; }
    if (!lineageCapAllows(cfg, exposure, 'long', AMOUNT)) { refused++; continue; }
    const terms = lineageTerms({ feeBps: BigInt(BASE_BPS), flatFee: 0n }, cfg, 'long');
    inv -= AMOUNT - ((AMOUNT * terms.feeBps) / 10000n);
    exposure.long += AMOUNT;
    due.push({ at: i + 5, cls: 'long', value: (AMOUNT * 9_000n) / 10_000n });
  }
  return { inv, refused, refunded, exposure };
}
const refunds = refunding();
assert.equal(refunds.refunded, 5);
assert.ok(refunds.refused < stress({ mix: allLong, caps: { long: '40000', total: '40000' } }).refused, 'refunds release in-flight capacity');

// No recovery at all: the cap is the hard bound on illiquid face value. Without it the same 25 long bridges put 250,000 at risk.
const illiquidCapped = stress({ mix: allLong, delay: null, caps: { long: '20000', total: '20000' } });
const illiquidOpen = stress({ mix: allLong, delay: null });
assert.equal(illiquidCapped.exposure.long, 20_000n);
assert.equal(illiquidCapped.refused, 23);
assert.equal(illiquidOpen.exposure.long, 250_000n);

console.log('\n  stress scenario                    inventory after 25  refused  stuck exposure');
console.log(`  worse haircut, no rule             ${worseWithout.inv.toString().padStart(17)}  ${String(worseWithout.refused).padStart(7)}  ${(worseWithout.exposure.long + worseWithout.exposure.poolExit).toString().padStart(14)}`);
console.log(`  worse haircut, lineage fee         ${worseWith.inv.toString().padStart(17)}  ${String(worseWith.refused).padStart(7)}  ${(worseWith.exposure.long + worseWith.exposure.poolExit).toString().padStart(14)}`);
console.log(`  worse haircut, fee + caps          ${capped.inv.toString().padStart(17)}  ${String(capped.refused).padStart(7)}  ${(capped.exposure.long + capped.exposure.poolExit).toString().padStart(14)}`);
console.log(`  illiquid long, caps                ${illiquidCapped.inv.toString().padStart(17)}  ${String(illiquidCapped.refused).padStart(7)}  ${illiquidCapped.exposure.long.toString().padStart(14)}`);
console.log(`  illiquid long, no caps             ${illiquidOpen.inv.toString().padStart(17)}  ${String(illiquidOpen.refused).padStart(7)}  ${illiquidOpen.exposure.long.toString().padStart(14)}`);

console.log('\n31/31 lineage-pricing simulation checks passed');
