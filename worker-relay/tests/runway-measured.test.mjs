// A wallet's runway from the burn the relay's own books measured (lib/runway.js measuredBurnEthPerDay, burnWeiPerDay), not only the configured
// estimate: on 2026-11-22 the monitor read 10.9 days for a settle wallet that held about 17 hours of the gas the relay was really spending.
//   node worker-relay/tests/runway-measured.test.mjs
import assert from 'node:assert/strict';
import { measuredBurnEthPerDay, burnWeiPerDay, burnGasPerDay, runwayDays } from '../src/lib/runway.js';
process.env.RPC_URL ||= 'http://127.0.0.1:9';                                    // config.js reads its endpoints when it loads; nothing here connects
const { OP_GAS } = await import('../src/lib/config.js');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const eth = (x) => BigInt(Math.round(x * 1e18));
const at = (iso) => Date.parse(iso);

// the ledger days as /relay/economics served them on 2026-11-22 at 13:14 UTC
const LEDGER = [
  { date: '2026-11-15', gasEth: 0.034625 }, { date: '2026-11-16', gasEth: 0.02885 }, { date: '2026-11-17', gasEth: 0.031852 },
  { date: '2026-11-18', gasEth: 0.031538 }, { date: '2026-11-19', gasEth: 0.028505 }, { date: '2026-11-20', gasEth: 0.0164 },
  { date: '2026-11-21', gasEth: 0.017434 }, { date: '2026-11-22', gasEth: 0.014689 },
];

ok('the burn is the larger of the last whole day and today run out to a day', () => {
  const now = at('2026-11-22T13:14:00Z'), through = (13 * 60 + 14) / (24 * 60);
  const got = measuredBurnEthPerDay(LEDGER, now);
  assert.ok(Math.abs(got - 0.014689 / through) < 1e-9, `today's pace: ${got}`);
  assert.ok(got > 0.017434, 'more than yesterday');
  assert.equal(measuredBurnEthPerDay(LEDGER, at('2026-11-22T23:59:00Z')), 0.014689 / (86340 / 86400) > 0.017434 ? 0.014689 / (86340 / 86400) : 0.017434, 'late in the day the day so far is nearly a day');
});

ok('early in the day, a few settles are not read as a pace: the last whole day stands', () => {
  const rows = [{ date: '2026-11-21', gasEth: 0.02 }, { date: '2026-11-22', gasEth: 0.01 }];
  assert.equal(measuredBurnEthPerDay(rows, at('2026-11-22T01:00:00Z')), 0.02, 'one hour in: ten times the pace would be noise');
  assert.equal(measuredBurnEthPerDay(rows, at('2026-11-22T02:23:00Z')), 0.02, 'just under a tenth of the day');
  assert.ok(measuredBurnEthPerDay(rows, at('2026-11-22T02:25:00Z')) > 0.02, 'a tenth of the day in: read');
});

ok('rows that say nothing are ignored, and no books mean no figure', () => {
  assert.equal(measuredBurnEthPerDay([], at('2026-11-22T13:00:00Z')), null);
  assert.equal(measuredBurnEthPerDay(null, at('2026-11-22T13:00:00Z')), null);
  assert.equal(measuredBurnEthPerDay(undefined), null);
  assert.equal(measuredBurnEthPerDay([{ date: '2026-11-21', gasEth: 'lots' }, null, { gasEth: 1 }, { date: '2026-11-20' }], at('2026-11-22T13:00:00Z')), null);
  assert.equal(measuredBurnEthPerDay([{ date: '2026-11-21', gasEth: 0 }], at('2026-11-22T13:00:00Z')), null, 'a day that spent nothing is no burn');
  assert.equal(measuredBurnEthPerDay([{ date: '2026-11-22', gasEth: 0.01 }], at('2026-11-22T12:00:00Z')) > 0, true, 'only today, far enough in: its pace');
  assert.equal(measuredBurnEthPerDay([{ date: '2026-11-23', gasEth: 0.5 }], at('2026-11-22T12:00:00Z')), null, 'a day that has not started is not read');
});

const burn = (roles, extra = {}) => ({ roles, relayBurnGasPerDay: 36_000_000n, expectedOpsPerDay: 20, gas: OP_GAS, ...extra });
const PRICE = 151_674_492n;                                                     // 0.1517 gwei, as the monitor read it

ok('the settle wallet: the configured estimate stood at about 11 days; the books say under a day', () => {
  const balance = eth(0.019886920933250153);
  const was = runwayDays({ balanceWei: balance, gasPriceWei: PRICE, ...burn(['settle']) });
  assert.ok(was > 10 && was < 12, `the old reading: ${was.toFixed(1)} days`);
  const measured = measuredBurnEthPerDay(LEDGER, at('2026-11-22T13:14:00Z'));
  const perDay = burnWeiPerDay({ ...burn(['settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: measured });
  const now = Number(balance) / Number(perDay);
  assert.ok(now > 0.5 && now < 1, `the reading from the books: ${now.toFixed(2)} days`);
});

ok('a measured burn under the configured one changes nothing, and without one the configured burn stands', () => {
  const base = burnGasPerDay(burn(['settle'])) * PRICE;
  assert.equal(burnWeiPerDay({ ...burn(['settle']), gasPriceWei: PRICE }), base);
  assert.equal(burnWeiPerDay({ ...burn(['settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: null }), base);
  assert.equal(burnWeiPerDay({ ...burn(['settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: 0.0000001 }), base, 'the larger of the two');
  assert.equal(burnWeiPerDay({ ...burn(['settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: -1 }), base);
});

ok('only the settle role takes the measured burn; a wallet with both keeps its relay part', () => {
  const relayOnly = burnGasPerDay(burn(['relay'])) * PRICE;
  assert.equal(burnWeiPerDay({ ...burn(['relay']), gasPriceWei: PRICE, measuredSettleEthPerDay: 0.05 }), relayOnly, 'the relay wallet is not read from the settles');
  const both = burnWeiPerDay({ ...burn(['relay', 'settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: 0.05 });
  assert.equal(both, relayOnly + eth(0.05), 'the relay part plus the measured settles');
  const bothSmall = burnWeiPerDay({ ...burn(['relay', 'settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: 1e-9 });
  assert.equal(bothSmall, burnGasPerDay(burn(['relay', 'settle'])) * PRICE, 'a small measure leaves the configured sum');
});

ok('the paging line: 12 hours at the measured burn is the default, and a wallet that holds a day does not page', () => {
  const measured = 0.0272;
  const perDay = burnWeiPerDay({ ...burn(['settle']), gasPriceWei: PRICE, measuredSettleEthPerDay: measured });
  const days = (bal) => Number(eth(bal)) / Number(perDay);
  assert.ok(days(0.0196) < 1.5 && days(0.0196) > 0.5, 'a warning today');
  assert.ok(days(0.012) < 0.5, 'a page once it holds under twelve hours');
  assert.ok(days(0.05) > 1.5, 'quiet when it holds a day and a half');
});

console.log(`\n${pass} passed, 0 failed`);
