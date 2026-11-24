// Pool deposits counted net of what the pool paid the address the same UTC day (POINTS_NET_OF_PAYOUTS: src/lib/points-engagement.js,
// points-counted.js, and the store's recordPoolPayout / dayPayoutsByAddress): ETH that comes out of the pool and goes back in is not
// new ETH put in. An address paid back all it deposited counts nothing, one paid nothing counts all of it up to its daily limit, days
// before the rule starts re-split to the same figures, and a withdrawal recorded after its day settled leaves that day's split alone.
//   node worker-relay/tests/points-net-of-payouts.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { parseNetOfPayouts, netOfPayoutsForDay, parseAddressDayCaps, countedShare } from '../src/lib/points-engagement.js';

const ETH = 10n ** 18n, DAY = 86400, D = 20782;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), E = '0x' + 'e'.repeat(40), F = '0x' + 'f'.repeat(40);
let n = 0;
const wei = (eth) => String(BigInt(Math.round(eth * 1000)) * ETH / 1000n);
const dep = (depositor, day, activity, eth, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: wei(eth), priorDepositCount: 0, points: eth * 1000, activity, chainId: 8453, ...extra });
const payout = (recipient, day, eth, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), logIndex: 1, chainId: 8453, recipient, blockTime: day * DAY + 200 + n, wei: wei(eth), ...extra });
const pts = (rows) => Object.fromEntries(rows.map((r) => [r.address, Math.round(r.dayPoints)]));
const ok = (m) => console.log('ok -', m);

{
  const s = parseNetOfPayouts('20782:evmpooldeposit;20900:evmpooldeposit,wrap;21000:off');
  assert.deepEqual(s.map((e) => e.fromDay), [20782, 20900, 21000]);
  assert.equal(netOfPayoutsForDay(s, 20781).size, 0, 'nothing before the first day');
  assert.deepEqual([...netOfPayoutsForDay(s, 20782)], ['evmpooldeposit']);
  assert.deepEqual([...netOfPayoutsForDay(s, 20950)].sort(), ['evmpooldeposit', 'wrap'], 'a later entry replaces the earlier one');
  assert.equal(netOfPayoutsForDay(s, 21000).size, 0, '"off" ends it');
  const bad = [];
  assert.deepEqual(parseNetOfPayouts('nonsense;20782:Bad Name', (m) => bad.push(m)), [], 'a malformed entry makes no rule');
  assert.equal(bad.length, 2, 'and each one is reported');
  ok('the schedule parses by day, a later entry replaces an earlier one, off ends it, bad entries are reported');
}

{
  const T = 10n * ETH;
  assert.equal(countedShare(6n * ETH, { paidWei: 6n * ETH }), 0, 'paid back everything: nothing');
  assert.equal(countedShare(6n * ETH, { paidWei: 7n * ETH }), 0, 'paid back more than it put in: nothing, never negative');
  assert.equal(countedShare(T, { paidWei: 0n }), 1);
  assert.equal(countedShare(T, { paidWei: 4n * ETH }), 0.6);
  assert.equal(countedShare(T, { limitWei: 5n * ETH, paidWei: 0n }), 0.5, 'the limit still applies');
  assert.equal(countedShare(T, { limitWei: 5n * ETH, paidWei: 8n * ETH }), 0.2, 'the net is the smaller of the two');
  assert.equal(countedShare(T, { limitWei: 5n * ETH }), 0.5, 'with no payout figure it is the plain limit');
  assert.equal(countedShare(0n, { paidWei: 0n }), 1);
  ok('countedShare takes the smaller of the net and the limit, and is never negative');
}

const dir = mkdtempSync(join(tmpdir(), 'points-net-'));
try {
  const store = openStore(join(dir, 'p.db'));
  // The farm pattern: A deposits three times and is paid the same back each time; B deposits and keeps it; C is paid part of it back;
  // E deposits far more than the limit and is paid nothing; F is paid a withdrawal but never deposited.
  for (const eth of [2, 2, 2.046]) store.recordDeposit(dep(A, D, 'evmpooldeposit', eth));
  for (const eth of [2, 2, 2.046]) store.recordPoolPayout(payout(A, D, eth));
  store.recordDeposit(dep(B, D, 'evmpooldeposit', 4));
  store.recordDeposit(dep(C, D, 'evmpooldeposit', 4)); store.recordPoolPayout(payout(C, D, 1));
  store.recordDeposit(dep(E, D, 'evmpooldeposit', 20));
  store.recordPoolPayout(payout(F, D, 3));
  store.recordDeposit(dep(A, D, 'wrap', 1));   // another activity of the same address is not touched

  const caps = parseAddressDayCaps('20741:evmpooldeposit=5');
  const net = parseNetOfPayouts('20782:evmpooldeposit');
  const withRule = makeCounted({ store, addressDayCaps: caps, netOfPayoutsSchedule: net });
  const without = makeCounted({ store, addressDayCaps: caps });

  const before = pts(without.rows(D));
  assert.equal(before[A], 5000 + 1000, 'without the rule the farm earns its 5 ETH limit of deposits, and the wrap');
  const after = pts(withRule.rows(D));
  assert.equal(after[A], 1000, 'A: paid back all it put in, so only its wrap counts');
  assert.equal(after[B], 4000, 'B: paid nothing, counts all 4 ETH');
  assert.equal(after[C], 3000, 'C: 4 ETH in, 1 ETH paid back, counts 3');
  assert.equal(after[E], 5000, 'E: far past the limit, paid nothing: the limit');
  assert.equal(after[F], undefined, 'F: a payout and no deposit is no row and no points');
  ok('the farm pattern counts nothing, an ordinary deposit counts in full, a part-paid one counts the rest, the limit still binds');

  const beforeStart = makeCounted({ store, addressDayCaps: caps, netOfPayoutsSchedule: parseNetOfPayouts('20783:evmpooldeposit') });
  assert.deepEqual(pts(beforeStart.rows(D)), before, 'a day before the rule starts re-splits to the same figures');
  ok('a day before the rule starts is split as it was');

  // Idempotent per withdrawal, and one marked late once its day has settled.
  const again = payout(B, D, 4);
  assert.equal(store.recordPoolPayout(again), true);
  assert.equal(store.recordPoolPayout(again), false, 'the same withdrawal twice adds once');
  assert.equal(store.dayPayoutsByAddress(D * DAY, (D + 1) * DAY).get(B), 4n * ETH);
  store.saveSettleState({ lastSettledDay: D, publishedRoot: null, publishedTotalWei: null, knobs: null });
  store.recordPoolPayout(payout(E, D, 20));   // recorded after its day settled
  assert.equal(store.dayPayoutsByAddress(D * DAY, (D + 1) * DAY).get(E), 20n * ETH, 'counted for the day as it stands now');
  assert.equal(store.dayPayoutsByAddress(D * DAY, (D + 1) * DAY, { onTime: true }).get(E), undefined, 'but not in what the settlement saw');
  const settled = pts(makeCounted({ store, addressDayCaps: caps, netOfPayoutsSchedule: net, onTime: true }).rows(D));
  assert.equal(settled[E], 5000, 'a late withdrawal leaves the settled day\'s split alone');
  assert.equal(settled[B], 0, 'while one recorded on time (B paid back its 4) still counts');
  ok('a withdrawal is kept once, and one recorded after its day settled does not change that day\'s split');
  store.db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
