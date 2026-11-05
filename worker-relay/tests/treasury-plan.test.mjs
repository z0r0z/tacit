// The treasury plan (src/lib/treasury-plan.js): fee ETH goes where the runway is shortest, the settle wallet keeps its floor and never
// ends up shorter than what it feeds, and nothing moves under its minimum.
// node --test tests/treasury-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreasury, burnFromBooks, runwayDays, daysText, swapMinWei } from '../src/lib/treasury-plan.js';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;   // ETH → wei, to a millionth
const P = (n) => BigInt(Math.round(n * 1e4)) * 10n ** 14n;   // PROVE → wei
const PRICE = P(13000);                                       // one ETH buys 13,000 PROVE
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(b))), `${a} is not near ${b}`);

test('the short runways are raised to one level with the settle wallet, which keeps its floor', () => {
  // The relay's wallets on 2026-10-16: settle 0.0146 ETH burning 0.0105/day (1.4 d); relay 0.00066 burning 0.0047/day (0.14 d); credit 21
  // PROVE burning 86/day (0.24 d). Every one of them is short, so all three end on the same level, under the three-day target.
  const plan = planTreasury({
    settle: { wei: E(0.0146), burnPerDayWei: E(0.0105), floorWei: E(0.003) },
    relay: { wei: E(0.00066), burnPerDayWei: E(0.0047), floorWei: E(0.001) },
    prove: { wei: P(21), burnPerDayWei: P(86), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.ok(plan.toRelayWei > 0n && plan.toProveWei > 0n);
  near(plan.after.settleDays, plan.after.relayDays, 1e-2);
  near(plan.after.settleDays, plan.after.proveDays, 1e-2);
  assert.ok(plan.after.settleDays < 3 && plan.after.settleDays > 0.5, `level ${plan.after.settleDays}`);
  assert.ok(E(0.0146) - plan.toRelayWei - plan.toProveWei >= E(0.003), 'the floor is kept');
  // With only the relay wallet short, it alone is fed, to where the two runways meet: a = (S·rb − R·sb)/(sb+rb).
  const one = planTreasury({
    settle: { wei: E(0.0146), burnPerDayWei: E(0.0105), floorWei: E(0.003) },
    relay: { wei: E(0.00066), burnPerDayWei: E(0.0047), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(86), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  const meet = (E(0.0146) * E(0.0047) - E(0.00066) * E(0.0105)) / (E(0.0105) + E(0.0047));
  assert.ok(one.toRelayWei >= meet - 10n ** 12n && one.toRelayWei <= meet + 10n ** 12n, `${one.toRelayWei} vs ${meet}`);
  assert.equal(one.toProveWei, 0n);
  near(one.after.settleDays, one.after.relayDays, 1e-3);
});

test('the relay wallet is never fed past its target, and not at all when it is the longer runway', () => {
  const rich = planTreasury({
    settle: { wei: E(1), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.001), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(10), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  const want = E(0.015) - E(0.001);
  assert.ok(rich.toRelayWei >= want - 10n ** 12n && rich.toRelayWei <= want, 'three days of burn, no more');
  const longer = planTreasury({
    settle: { wei: E(0.01), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.05), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(10), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(longer.toRelayWei, 0n);
  assert.equal(longer.toProveWei, 0n);
});

test('PROVE is bought from what is left after the relay wallet, up to where the runways meet, and capped per pass', () => {
  const plan = planTreasury({
    settle: { wei: E(0.2), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.02), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(plan.toRelayWei, 0n, 'the relay wallet already has four days');
  // three days of PROVE is 270; it holds 10, so 260 PROVE = 0.02 ETH at the price. The settle wallet has far more than three days, so the target binds.
  const want = (P(260) * 10n ** 18n + PRICE - 1n) / PRICE;
  assert.ok(plan.toProveWei >= want - 10n ** 12n && plan.toProveWei <= want, `${plan.toProveWei} vs ${want}`);
  near(plan.after.proveDays, 3, 1e-3);
  const capped = planTreasury({
    settle: { wei: E(0.2), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.02), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE, maxSwapWei: E(0.005),
  });
  assert.equal(capped.toProveWei, E(0.005));
});

test('a thin settle wallet shares its pain: PROVE is bought only up to where the two runways meet', () => {
  // settle 0.02 ETH at 0.01/day = 2 days; credit 10 PROVE at 90/day = 0.11 day; the relay wallet is fine. Equal runways, not three days of PROVE.
  const plan = planTreasury({
    settle: { wei: E(0.02), burnPerDayWei: E(0.01), floorWei: E(0.002) },
    relay: { wei: E(0.05), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.ok(plan.toProveWei > 0n);
  near(plan.after.settleDays, plan.after.proveDays, 1e-2);
  assert.ok(plan.after.proveDays < 3);
});

test('nothing moves under the floor, under a minimum, or when PROVE cannot be priced', () => {
  const floor = planTreasury({
    settle: { wei: E(0.002), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(0), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(floor.toRelayWei, 0n); assert.equal(floor.toProveWei, 0n);
  const tiny = planTreasury({
    settle: { wei: E(0.0031), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(10), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE, minMoveWei: E(0.001),
  });
  assert.equal(tiny.toRelayWei, 0n);
  assert.ok(tiny.notes.some((n) => /minimum move/.test(n)));
  const unpriced = planTreasury({
    settle: { wei: E(1), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(1), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(0), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: null,
  });
  assert.equal(unpriced.toProveWei, 0n);
  assert.ok(unpriced.notes.some((n) => /cannot be priced/.test(n)));
});

test('with no burn known, the floors decide: a wallet under its floor is brought to twice it', () => {
  const plan = planTreasury({
    settle: { wei: E(0.05), burnPerDayWei: 0n, floorWei: E(0.003) },
    relay: { wei: E(0.0005), burnPerDayWei: 0n, floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: 0n, floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(plan.toRelayWei, E(0.002) - E(0.0005));
  const want = (P(50) * 10n ** 18n + PRICE - 1n) / PRICE;
  assert.ok(plan.toProveWei >= want - 10n ** 12n && plan.toProveWei <= want, 'the credit is brought to its floor');
  const fine = planTreasury({
    settle: { wei: E(0.05), burnPerDayWei: 0n, floorWei: E(0.003) },
    relay: { wei: E(0.0015), burnPerDayWei: 0n, floorWei: E(0.001) },
    prove: { wei: P(70), burnPerDayWei: 0n, floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(fine.toRelayWei, 0n); assert.equal(fine.toProveWei, 0n);
});

test('the books give a burn a day, with today counted as the part of it that has passed', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0); // half of the 16th
  const b = burnFromBooks({
    '2026-10-14': { gasEth: 0.01, proveIn: 80, settled: 60 },
    '2026-10-15': { gasEth: 0.012, proveIn: 100, settled: 70 },
    '2026-10-16': { gasEth: 0.004, proveIn: 30, settled: 20 },
  }, { now });
  near(b.gasEthPerDay, 0.026 / 2.5); near(b.provePerDay, 210 / 2.5); near(b.settlesPerDay, 150 / 2.5); assert.equal(b.days, 3);
  const early = burnFromBooks({ '2026-10-16': { gasEth: 0.001, proveIn: 5, settled: 2 } }, { now: Date.UTC(2026, 9, 16, 0, 10, 0) });
  near(early.gasEthPerDay, 0.004, 1e-6);  // a quarter day at least
  assert.equal(burnFromBooks({}).gasEthPerDay, null);
  assert.equal(burnFromBooks({ junk: { gasEth: 1 } }).days, 0);
});

test('runway helpers', () => {
  assert.equal(runwayDays(10n, 0n), Infinity);
  assert.equal(runwayDays(10n, 4n), 2.5);
  assert.equal(daysText(Infinity), '∞'); assert.equal(daysText(400), '365+'); assert.equal(daysText(12.4), '12'); assert.equal(daysText(1.26), '1.3');
});

// The 2026-10-20 outage: the settle wallet held 0.0016 ETH (floor 0.0007, burning 0.0059/day), the relay wallet 0.001, and the credit 14.2 PROVE,
// under the ~17 a reflection proof needs free. Levelling alone raised the credit to the settle wallet's own 0.3 days and then dropped the
// purchase under the 0.002 ETH minimum swap, so nothing was ever bought while every attest was refused.
const OUTAGE = {
  settle: { wei: E(0.0016), burnPerDayWei: E(0.0059), floorWei: E(0.0007) },
  relay: { wei: E(0.001), burnPerDayWei: E(0.0033), floorWei: E(0.0033) },
  prove: { wei: P(14.2), burnPerDayWei: P(58.4), floorWei: P(60) },
  targetDays: 3, minMoveWei: E(0.0005), minSwapWei: E(0.002), maxSwapWei: E(0.02), proveWeiPerEth: PRICE,
};

test('the old plan bought nothing in that outage: the levelled purchase fell under the minimum swap', () => {
  const plan = planTreasury(OUTAGE);
  assert.equal(plan.toProveWei, 0n);
  assert.ok(plan.notes.some((n) => /minimum swap/.test(n)));
});

test('a credit under its urgent line is bought up first with all the settle wallet holds above its floor', () => {
  const plan = planTreasury({ ...OUTAGE, urgentMinSwapWei: E(0.0003), prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } });
  assert.equal(plan.toProveWei, E(0.0009), 'everything above the floor');
  assert.equal(plan.urgentWei, E(0.0009));
  assert.equal(plan.toRelayWei, 0n, 'nothing is left to level');
  assert.ok(E(0.0016) - plan.toProveWei >= E(0.0007), 'the settle wallet keeps its floor');
  assert.ok(plan.after.proveDays > plan.runway.proveDays + 0.1, `credit ${plan.runway.proveDays} -> ${plan.after.proveDays} days`);
  assert.ok(plan.notes.some((n) => /urgent line/.test(n)));
});

test('the urgent purchase stops at what the credit needs, and at the most a swap may take', () => {
  const rich = { ...OUTAGE, settle: { wei: E(1), burnPerDayWei: E(0.0059), floorWei: E(0.0007) }, urgentMinSwapWei: E(0.0003) };
  const need = (60 - 14.2) / 13000;                                 // ETH to bring 14.2 PROVE to 60 at 13,000 PROVE an ETH
  const plan = planTreasury({ ...rich, prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } });
  assert.ok(plan.urgentWei >= E(need) - 10n ** 12n && plan.urgentWei <= E(need) + 10n ** 12n, `${plan.urgentWei} vs ${E(need)}`);
  const capped = planTreasury({ ...rich, maxSwapWei: E(0.001), prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } });
  assert.equal(capped.toProveWei, E(0.001));
  assert.ok(capped.urgentWei <= E(0.001));
});

test('with a long credit nothing is urgent: the plan is the levelling it was', () => {
  const calm = { ...OUTAGE, settle: { wei: E(0.0146), burnPerDayWei: E(0.0105), floorWei: E(0.003) }, prove: { wei: P(120), burnPerDayWei: P(58.4), floorWei: P(60), urgentBelowWei: P(45), urgentToWei: P(60) } };
  const plain = planTreasury({ ...calm, prove: { ...calm.prove, urgentBelowWei: 0n } });
  const plan = planTreasury(calm);
  assert.equal(plan.urgentWei, 0n);
  assert.equal(plan.toProveWei, plain.toProveWei);
  assert.equal(plan.toRelayWei, plain.toRelayWei);
});

test('an urgent purchase the settle wallet cannot afford waits with a reason, and a wallet at its floor gives nothing', () => {
  const tiny = planTreasury({ ...OUTAGE, settle: { ...OUTAGE.settle, wei: E(0.0008) }, urgentMinSwapWei: E(0.0003), prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } });
  assert.equal(tiny.toProveWei, 0n);
  assert.ok(tiny.notes.some((n) => /minimum swap/.test(n)));
  const none = planTreasury({ ...OUTAGE, settle: { ...OUTAGE.settle, wei: E(0.0007) }, urgentMinSwapWei: E(0.0003), prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } });
  assert.equal(none.toProveWei, 0n);
  assert.ok(none.notes.some((n) => /nothing above its floor/.test(n)));
});

test('an unpriced PROVE is never swapped, urgent or not', () => {
  const plan = planTreasury({ ...OUTAGE, proveWeiPerEth: null, urgentMinSwapWei: E(0.0003), prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } });
  assert.equal(plan.toProveWei, 0n);
  assert.equal(plan.urgentWei, 0n);
});

test('the least a swap is worth making follows the gas price, between a floor and the old fixed minimum', () => {
  const cost = (gwei) => BigInt(Math.round(gwei * 1e9)) * 300_000n;          // 300k gas
  const cfg = { multiple: 25, floorWei: E(0.0003), ceilWei: E(0.002) };
  assert.equal(swapMinWei({ gasWei: cost(0.01), ...cfg }), E(0.0003), 'nearly free gas: the floor');
  assert.equal(swapMinWei({ gasWei: cost(0.09), ...cfg }), cost(0.09) * 25n, 'today’s 0.09 gwei: 25 times the swap gas, 0.0007 ETH rather than 0.002');
  assert.equal(swapMinWei({ gasWei: cost(0.2), ...cfg }), cost(0.2) * 25n, 'at 0.2 gwei: 25 times the swap gas, 0.0015 ETH');
  assert.equal(swapMinWei({ gasWei: cost(0.5), ...cfg }), E(0.002), 'at 0.5 gwei the old minimum already holds');
  assert.equal(swapMinWei({ gasWei: cost(20), ...cfg }), E(0.002), 'dear gas: the old minimum');
  assert.equal(swapMinWei({ gasWei: 0n, floorWei: E(0.01), ceilWei: E(0.002) }), E(0.002), 'a floor above the ceiling gives way to it');
});

test('an urgent purchase does not leave the relay wallet without gas: under its hard minimum it is brought to its floor first', () => {
  const urgent = { ...OUTAGE, urgentMinSwapWei: E(0.0003), prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } };
  // The relay wallet holds 0.0002, its minimum is 0.0006 and its floor 0.0008: 0.0006 goes to it, and the PROVE gets the rest above the settle floor.
  const plan = planTreasury({ ...urgent, relay: { ...OUTAGE.relay, wei: E(0.0002), floorWei: E(0.0008), hardMinWei: E(0.0006) } });
  assert.equal(plan.toRelayWei, E(0.0006));
  assert.equal(plan.toProveWei, E(0.0009) - E(0.0006));
  assert.ok(E(0.0016) - plan.toRelayWei - plan.toProveWei >= E(0.0007), 'the settle wallet keeps its floor');
  assert.ok(plan.notes.some((n) => /before the credit is bought/.test(n)));
  // A floor the room cannot reach takes the whole room: a relay wallet with no gas stops the attests the PROVE was for.
  const short = planTreasury({ ...urgent, relay: { ...OUTAGE.relay, wei: E(0.0002), hardMinWei: E(0.0006) } });
  assert.equal(short.toRelayWei, E(0.0009));
  assert.equal(short.toProveWei, 0n);
  // A relay wallet already over its minimum is not asked for anything, and the purchase is the whole room as before.
  const fine = planTreasury({ ...urgent, relay: { ...OUTAGE.relay, wei: E(0.001), hardMinWei: E(0.0006) } });
  assert.equal(fine.toProveWei, E(0.0009));
  assert.equal(fine.toRelayWei, 0n);
  // With the credit healthy the minimum is not applied here at all: the levelling feeds the relay wallet as it always did.
  const calm = planTreasury({ ...OUTAGE, prove: { ...OUTAGE.prove, wei: P(120), urgentBelowWei: P(45), urgentToWei: P(60) }, relay: { ...OUTAGE.relay, wei: E(0.0002), hardMinWei: E(0.0006) } });
  assert.equal(calm.urgentWei, 0n);
});

// 2026-10-30..11-04: the urgent tier filled the relay wallet only to its hard minimum (attests alone, ~0.0017 ETH at 0.2 gwei) under a floor
// of ~0.0065 (attests and header batches), so it sat just under the minimum after every pass and was fed in slivers (0.000001, 0.000002,
// 0.000005 ETH, each transfer's gas more than it carried) while the rest of the room bought PROVE. Filled to its floor, one move holds it
// over the minimum for days, and a wallet between the minimum and its floor is left to the levelling as before.
test('the urgent tier does not feed the relay wallet in slivers', () => {
  const urgent = { ...OUTAGE, settle: { wei: E(0.02), burnPerDayWei: E(0.003), floorWei: E(0.00136) }, urgentMinSwapWei: E(0.0003),
    prove: { ...OUTAGE.prove, urgentBelowWei: P(45), urgentToWei: P(60) } };
  const relay = { burnPerDayWei: E(0.0027), floorWei: E(0.0065), hardMinWei: E(0.0017) };
  const plan = planTreasury({ ...urgent, relay: { ...relay, wei: E(0.0017) - 1000000000000n } });
  assert.equal(plan.toRelayWei, E(0.0065) - E(0.0017) + 1000000000000n, 'to its floor, not the millionth it is short of its minimum');
  assert.ok(plan.toProveWei > 0n, 'the credit is still bought with the rest');
  assert.ok(E(0.02) - plan.toRelayWei - plan.toProveWei >= E(0.00136), 'the settle wallet keeps its floor');
  // Between its minimum and its floor the urgent tier leaves it alone: the credit is first, as before.
  const mid = planTreasury({ ...urgent, relay: { ...relay, wei: E(0.003) } });
  assert.ok(mid.urgentWei > 0n);
  assert.ok(!mid.notes.some((n) => /before the credit is bought/.test(n)));
});
