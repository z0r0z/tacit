import assert from 'node:assert/strict';
import {
  BASE_UNIT,
  DEFAULT_CONFIG,
  SCENARIOS,
  reverseFee,
  forwardEthereumPayout,
  reverseEthereumProceeds,
  meetsProceedsFloor,
  assessReverseQuote,
  runScenario,
  runAllScenarios,
} from './stuck-tac-harness/scenarios.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fromTac = (text) => {
  const [whole, fraction = ''] = String(text).split('.');
  return Number(whole) * BASE_UNIT + Number(fraction.padEnd(8, '0'));
};
const sum = (values) => values.reduce((total, value) => total + value, 0);
const openConfig = { startingInventory: fromTac('100000'), dailyCap: fromTac('10000'), stuckCeiling: fromTac('10000') };

test('known forward arithmetic and greatest-E production plateau', () => {
  const A = fromTac('100');
  assert.equal(forwardEthereumPayout(A), fromTac('99.6'));
  assert.equal(reverseFee(A), fromTac('0.4'));
  const B = fromTac('100');
  const E = reverseEthereumProceeds(B);
  assert.equal(E, 10040120361);
  assert.equal(E - reverseFee(E), B);
  assert.equal((E - 1) - reverseFee(E - 1), B - 1, 'the published value is an exact lower rounding edge');
  assert.equal((E + 1) - reverseFee(E + 1), B + 1, 'the next base unit is the next exact output');
  assert.equal(assessReverseQuote(B, E, 10000).expectedE, E);
  const plateauB = fromTac('996.9');
  const plateauE = reverseEthereumProceeds(plateauB);
  assert.equal(plateauE, fromTac('1000'));
  assert.equal((plateauE - 1) - reverseFee(plateauE - 1), plateauB, 'a separate two-base-unit exact plateau');
});

test('par boundary, premium floor and below-par refusal remain exact', () => {
  const A = fromTac('1000');
  const free = { feeBps: 0, flatFee: 0 };
  assert.equal(reverseEthereumProceeds(A, free), A);
  assert.equal(assessReverseQuote(A, A, 10000, free).ok, true);
  assert.equal(meetsProceedsFloor(A, A, 10000), true);
  assert.equal(meetsProceedsFloor(A, A - 1, 10000), false);
  assert.equal(assessReverseQuote(A, A, 10001, free).floorPass, false);
  assert.equal(meetsProceedsFloor(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 10000), true);
  const result = runScenario('floor-not-met');
  assert.equal(result.passed, true);
  assert.ok(result.summary.belowParRefusals > 0);
  assert.equal(result.summary.soldStuckB, 0);
  assert.equal(result.summary.activeSaleB, 0);
  assert.equal(result.summary.reverseProceedsE, 0);
  assert.equal(result.summary.fundingSelectedB, 0);
  assert.equal(result.summary.unsoldReverseStock, 0);
  assert.equal(result.summary.residualMain, result.summary.baselineStuck);
});

test('all default scenarios pass with gross, cost and capacity exclusions explicit', () => {
  const results = runAllScenarios();
  assert.deepEqual(results.map((result) => result.id), SCENARIOS.map((scenario) => scenario.id));
  for (const result of results) {
    assert.ok(result.passed, `${result.id}: ${result.assertions.filter((item) => !item.pass).map((item) => item.id).join(', ')}`);
    assert.equal(result.summary.nativeSatsCosts, null);
    assert.equal(result.summary.poolNoteCutCosts, null);
    assert.equal(result.summary.poolNoteCutReserves, null);
    assert.equal(result.summary.quotableCapacity, null);
    assert.equal(result.summary.poolCutAndCapacityExcluded, true);
    assert.equal(result.summary.buyerDemandGuaranteed, false);
  }
});

test('published N=1, 10 and 100 long-history figures are literal runner outputs', () => {
  const expected = [
    [1, fromTac('9900.4'), fromTac('10000.80120361')],
    [10, fromTac('9004'), fromTac('10008.0120361')],
    [100, fromTac('40'), fromTac('10080.120361')],
  ];
  for (const [bridgeCount, baseline, rebalanced] of expected) {
    const result = runScenario('long-history', {
      bridgeCount,
      startingInventory: fromTac('10000'),
      dailyCap: fromTac('10000'),
      stuckCeiling: fromTac('10000'),
    });
    assert.equal(result.passed, true);
    assert.equal(result.summary.completedBridges, bridgeCount);
    assert.equal(result.summary.baselineGrossPrivate, baseline, `N=${bridgeCount} baseline`);
    assert.equal(result.summary.rebalancedGrossPrivate, rebalanced, `N=${bridgeCount} rebalanced`);
    assert.equal(result.summary.totalBridged, bridgeCount * fromTac('100'));
    assert.equal(result.summary.forwardPayoutTotal, bridgeCount * fromTac('99.6'));
    assert.equal(result.summary.reverseProceedsE, bridgeCount * 10040120361);
    assert.ok(result.sales.every((sale) => sale.E === 10040120361));
  }
});

test('clean ordinary returns are included in the known five-forward gross baseline', () => {
  const result = runScenario('normal-recovery', { bridgeCount: 5, dailyCap: fromTac('10000'), stuckCeiling: fromTac('10000') });
  assert.equal(result.summary.totalBridged, fromTac('1140'));
  assert.equal(result.summary.forwardFees, fromTac('3.92'));
  assert.equal(result.summary.forwardPayoutTotal, fromTac('1136.08'));
  assert.equal(result.summary.cleanReturned, fromTac('140'));
  assert.equal(result.summary.baselineGrossPrivate, fromTac('11003.92'));
  const E = sum(result.sales.map((sale) => sale.E));
  assert.equal(result.summary.rebalancedGrossPrivate, result.summary.baselineGrossPrivate + E);
  const ordinary = result.events.find((event) => event.kind === 'clean-return');
  assert.equal(ordinary.amount, fromTac('140'));
  assert.match(ordinary.detail, /No TAC return fee/);
});

test('no buyer still consumes funding cap and builds unsold reverse stock', () => {
  const result = runScenario('no-buyer', { bridgeCount: 4, stuckCeiling: fromTac('10000') });
  assert.equal(result.passed, true);
  assert.equal(result.summary.completedBridges, 4);
  assert.equal(result.summary.cleanReturned, fromTac('260'));
  assert.equal(result.summary.fundingSelectedB, fromTac('740'));
  assert.equal(result.summary.unsoldReverseStock, fromTac('740'));
  assert.equal(result.summary.residualMain, 0);
  assert.equal(result.summary.soldStuckB, 0);
  assert.equal(result.summary.lastSaleAt, null);
  assert.deepEqual(result.summary.dailyUsed, { 1: fromTac('420'), 2: fromTac('320') });
  assert.equal(result.fundingMoves.length, 3);
  assert.ok(result.fundingMoves.every((move) => move.selectedAt !== null));
});

test('unread residual risk is excluded from measured ceiling, funding and sale clock even at N=100', () => {
  const result = runScenario('unread-lineage', { ...openConfig, bridgeCount: 100, stuckCeiling: fromTac('100') });
  assert.equal(result.passed, true);
  assert.equal(result.summary.completedBridges, 100);
  assert.ok(result.summary.quarantined > result.config.stuckCeiling);
  assert.equal(result.summary.residualMain, result.summary.quarantined);
  assert.equal(result.summary.measuredStuck, 0);
  assert.equal(result.summary.fundingSelectedB, 0);
  assert.equal(result.summary.maximumDailyUsed, 0);
  assert.equal(result.summary.watchSince, null);
  assert.equal(result.summary.gateOpen, false);
  assert.equal(result.summary.gateRefusals, 0);
});

test('daily cap is charged by whole-note funding selection, not by completed sales', () => {
  for (const [cap, expectedMoves] of [[100, 0], [400, 5], [600, 5], [10000, 10]]) {
    const result = runScenario('daily-cap', { bridgeCount: 10, dailyCap: fromTac(String(cap)), stuckCeiling: fromTac('10000') });
    assert.equal(result.passed, true, String(cap));
    assert.equal(result.fundingMoves.length, expectedMoves);
    assert.equal(result.sales.length, expectedMoves);
    assert.equal(result.summary.fundingSelectedB, expectedMoves * fromTac('400'));
    assert.equal(result.summary.soldStuckB, result.summary.fundingSelectedB);
    assert.equal(result.summary.residualMain, fromTac('4000') - result.summary.soldStuckB);
    assert.equal(sum(Object.values(result.summary.dailyUsed)), result.summary.fundingSelectedB);
    for (const used of Object.values(result.summary.dailyUsed)) assert.ok(used <= result.config.dailyCap);
  }
});

test('B-06 N=1 proves funding is not a sale and an existing sale continues after the timed gate', () => {
  const result = runScenario('stalled-recovery', { bridgeCount: 1 });
  assert.equal(result.passed, true);
  assert.equal(result.fundingMoves.length, 1);
  assert.equal(result.sales.length, 1);
  assert.equal(result.summary.gateRefusals, 0);
  assert.equal(result.summary.activeContinuationsAfterGate, 1);
  assert.equal(result.summary.lastSaleAt, 180);
  assert.equal(result.summary.watchSince, null);
  const opened = result.gateHistory.find((entry) => entry.open && entry.reason === 'no-completed-sale');
  assert.equal(opened.at, 180);
  assert.equal(opened.lastSaleAt, null);
  assert.equal(result.events.some((event) => /three polls|poll 1|poll 2|poll 3/i.test(event.title + event.detail)), false);
});

test('B-06 N=2 refuses the forward at the stall boundary, then the active sale resets the clock', () => {
  const result = runScenario('stalled-recovery', { bridgeCount: 2 });
  assert.equal(result.passed, true);
  assert.equal(result.summary.completedBridges, 1);
  assert.equal(result.summary.refusedBridges, 1);
  assert.equal(result.summary.stallGateRefusals, 1);
  assert.equal(result.summary.lastSaleAt, 180);
  assert.equal(result.summary.activeContinuationsAfterGate, 1);
  assert.equal(result.summary.gateOpen, false);
  assert.equal(result.events.filter((event) => event.title === 'Forward refused · intake gate open').length, 1);
});

test('B-06 N=3 gives new exposure a full interval and keeps refund exposure without advancing lastSaleAt', () => {
  const result = runScenario('stalled-recovery', { bridgeCount: 3 });
  assert.equal(result.passed, true);
  assert.equal(result.summary.lastSaleAt, 180);
  assert.equal(result.summary.lastRefundAt, 300);
  assert.equal(result.summary.refundedB, fromTac('100'));
  assert.equal(result.summary.unsoldReverseStock, fromTac('100'));
  assert.equal(result.summary.activeSaleB, 0);
  assert.equal(result.summary.watchSince, 300);
  assert.equal(result.summary.stallElapsed, 0);
  assert.ok(result.watchHistory.every((entry) => entry.at === entry.watchSince));
});

test('premium floor refusal cannot fabricate B-06 completion or refund', () => {
  const result = runScenario('stalled-recovery', { bridgeCount: 10, recoveryFloorBps: 11000, stuckCeiling: fromTac('10000') });
  assert.equal(result.passed, true);
  assert.equal(result.summary.activeContinuationsAfterGate, 0);
  assert.equal(result.summary.lastSaleAt, null);
  assert.equal(result.summary.lastRefundAt, null);
  assert.equal(result.summary.refundedB, 0);
  assert.equal(result.summary.fundingSelectedB, 0);
  assert.equal(result.summary.unsoldReverseStock, 0);
  assert.equal(result.summary.gateReason !== 'no-completed-sale', true);
});

test('N=1, 10 and 100 conserve every scenario and replay exactly without input mutation', () => {
  for (const bridgeCount of [1, 10, 100]) {
    const config = { ...openConfig, bridgeCount };
    const before = JSON.stringify(config);
    for (const scenario of SCENARIOS) {
      const result = runScenario(scenario.id, config);
      assert.ok(result.passed, `${scenario.id} N=${bridgeCount}: ${result.assertions.filter((item) => !item.pass).map((item) => item.id).join(', ')}`);
      assert.equal(result.summary.completedBridges + result.summary.refusedBridges, bridgeCount);
      assert.equal(result.summary.baselineStuck, result.summary.residualMain + result.summary.unsoldReverseStock + result.summary.activeSaleB + result.summary.soldStuckB);
      assert.equal(result.summary.rebalancedGrossPrivate, result.summary.baselineGrossPrivate + result.summary.reverseProceedsE);
      assert.deepEqual(runScenario(scenario.id, config), result);
      assert.equal(JSON.stringify(config), before);
    }
  }
});

test('deterministic amount patterns repeat after 20 bridges and N=100 never reads beyond the fixture list', () => {
  const result = runScenario('normal-recovery', { ...openConfig, bridgeCount: 100 });
  assert.equal(result.passed, true);
  assert.equal(result.summary.completedBridges, 100);
  assert.equal(result.forwards[20].A, result.forwards[0].A);
  assert.equal(result.forwards[40].A, result.forwards[0].A);
  assert.equal(result.forwards.length, 100);
});

test('cap, floor and stall-interval variations preserve every guard', () => {
  for (const dailyCap of [fromTac('100'), fromTac('350.5'), fromTac('600'), fromTac('10000')]) {
    for (const recoveryFloorBps of [10000, 10500, 11000]) {
      for (const stallSecs of [60, 180, 600]) {
        const config = { ...openConfig, bridgeCount: 10, dailyCap, recoveryFloorBps, stallSecs };
        for (const scenario of SCENARIOS) {
          const result = runScenario(scenario.id, config);
          assert.ok(result.passed, `${scenario.id}, cap ${dailyCap}, floor ${recoveryFloorBps}, stall ${stallSecs}: ${result.assertions.filter((item) => !item.pass).map((item) => item.id).join(', ')}`);
          for (const sale of result.sales) assert.ok(meetsProceedsFloor(sale.B, sale.E, recoveryFloorBps));
        }
      }
    }
  }
});

test('configuration exposes N=100, par default and bounded sale-clock controls', () => {
  assert.equal(DEFAULT_CONFIG.recoveryFloorBps, 10000);
  assert.equal(DEFAULT_CONFIG.stallSecs, 180);
  assert.throws(() => runScenario('normal-recovery', { bridgeCount: 101 }), /bridgeCount/);
  assert.throws(() => runScenario('normal-recovery', { recoveryFloorBps: 9999 }), /recoveryFloorBps/);
  assert.throws(() => runScenario('normal-recovery', { recoveryFloorBps: 11001 }), /recoveryFloorBps/);
  assert.throws(() => runScenario('normal-recovery', { stallSecs: 59 }), /stallSecs/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.log(`  FAIL - ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} stuck TAC scenario suites passed`);
process.exit(process.exitCode || 0);
