// Taking back scored rows that were credited in error (the store's voidDeposits, driven by POINTS_VOID_TXS): the row goes, the
// address's totals come down by it, rows of a settled day are left alone, and doing it twice does nothing the second time.
//   node worker-relay/tests/points-void.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';

const D = 20700, DAY = 86400;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const ETH5 = '5000000000000000000';
let n = 0;
const dep = (depositor, day, points, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: ETH5, priorDepositCount: 0, points, activity: 'zswapeth', chainId: 8453, ...extra });
const ok = (m) => console.log('ok -', m);

const dir = mkdtempSync(join(tmpdir(), 'points-void-'));
try {
  const store = openStore(join(dir, 'p.db'));
  const wash = dep(A, D, 7679);                  // A's only row, wash
  const real = dep(B, D, 1500, { chainId: 1 });  // B swapped for real
  const washB = dep(B, D, 7000);                 // B also has a wash row
  for (const r of [wash, real, washB]) assert.equal(store.recordDeposit(r), true);
  assert.equal(store.countByActivity('zswapeth'), 3);

  const out = store.voidDeposits([wash.txHash.toUpperCase().replace('0X', '0x'), washB.txHash, '0x' + 'f'.repeat(64)]);
  assert.deepEqual(out.voided.map((r) => r.txHash).sort(), [wash.txHash, washB.txHash].sort(), 'the listed rows go, a hash with no row is skipped');
  assert.deepEqual(out.settledDay, []);
  assert.equal(store.countByActivity('zswapeth'), 1, 'the activity count, which sets the early bonus, drops with them');
  assert.equal(store.totalFor(A), null, 'an address left with no rows is gone from the totals');
  const b = store.totalFor(B);
  assert.equal(b.points, 1500, 'B keeps the real swap\'s points');
  assert.equal(b.deposit_count, 1);
  assert.equal(b.amount_wei, ETH5, 'and its ETH total is exact');
  assert.deepEqual(makeCounted({ store, onTime: false }).rows(D).map((r) => [r.address, r.dayPoints]), [[B, 1500]], 'the day board holds only the real row');
  ok('wash rows are taken back from the row table, the totals and the day board, and the real row stays');

  assert.deepEqual(store.voidDeposits([wash.txHash, washB.txHash]), { voided: [], settledDay: [] });
  assert.equal(store.totalFor(B).points, 1500);
  ok('the same list again changes nothing');

  // A row of a settled day is reported and left: its reward is already in the ledger.
  const old = dep(A, D - 1, 400);
  store.recordDeposit(old);
  store.saveSettleState({ lastSettledDay: D - 1, publishedRoot: null, publishedTotalWei: null, knobs: null });
  const late = store.voidDeposits([old.txHash]);
  assert.deepEqual(late.voided, []);
  assert.deepEqual(late.settledDay.map((r) => r.txHash), [old.txHash]);
  assert.equal(store.totalFor(A).points, 400, 'a settled day\'s row keeps its points');
  ok('a row of a settled day is reported and left as it is');
  store.db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
