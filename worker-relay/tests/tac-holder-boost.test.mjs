// TAC-holder points boost (src/lib/tac-holder-boost.js): tier parsing, the trailing-window minimum balance,
// the coverage guard, and that a replay from scratch reproduces the same multipliers.
//   node worker-relay/tests/tac-holder-boost.test.mjs

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  parseBoostTiers, multiplierFor, minBalanceOver, openTacBoost, scanTacTransfers,
} from '../src/lib/tac-holder-boost.js';

const TAC = 10n ** 18n;
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b0';
const ZERO = '0x0000000000000000000000000000000000000000';
const TIERS = parseBoostTiers('100:1.25,1000:1.5,10000:2');

let n = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { n++; console.log(`ok - ${name}`); });
}

function transfer(i, blockNumber, from, to, tac) {
  return { txHash: `0x${String(i).padStart(64, '0')}`, logIndex: 0, blockNumber, from, to, valueWei: (BigInt(tac) * TAC).toString() };
}

function fresh(opts = {}) {
  return openTacBoost(new Database(':memory:'), { tiers: TIERS, windowBlocks: 100, startBlock: 0, fromBlock: 1, ...opts });
}

await test('tiers parse ascending and reject lowering multipliers', () => {
  assert.deepEqual(parseBoostTiers('1000:1.5,100:1.25').map((t) => t.multiplier), [1.25, 1.5]);
  assert.throws(() => parseBoostTiers('100:0.9'));
  assert.throws(() => parseBoostTiers('100:2,1000:1.5'));
  assert.throws(() => parseBoostTiers('0:1.5'));
  assert.throws(() => parseBoostTiers('1.5:2'));
  assert.deepEqual(parseBoostTiers(''), []);
});

await test('multiplier follows the highest tier reached', () => {
  assert.equal(multiplierFor(99n * TAC, TIERS), 1);
  assert.equal(multiplierFor(100n * TAC, TIERS), 1.25);
  assert.equal(multiplierFor(5000n * TAC, TIERS), 1.5);
  assert.equal(multiplierFor(10n ** 30n, TIERS), 2);
  assert.equal(multiplierFor(10n ** 30n, []), 1);
});

await test('window minimum counts the balance entering the window and every dip inside it', () => {
  const rows = [
    { block_number: 10, from_addr: ZERO, to_addr: ALICE, value_wei: String(500n * TAC) },
    { block_number: 50, from_addr: ALICE, to_addr: BOB, value_wei: String(450n * TAC) },
    { block_number: 60, from_addr: BOB, to_addr: ALICE, value_wei: String(450n * TAC) },
  ];
  assert.equal(minBalanceOver(rows, ALICE, 0, 49), 0n); // window opens before the first receive
  assert.equal(minBalanceOver(rows, ALICE, 20, 49), 500n * TAC);
  assert.equal(minBalanceOver(rows, ALICE, 20, 70), 50n * TAC); // the dip at block 50 counts
  assert.equal(minBalanceOver(rows, ALICE, 61, 70), 500n * TAC); // window after the dip
});

await test('buying right before an activity earns nothing', () => {
  const b = fresh();
  b.recordTransfers([transfer(1, 195, BOB, ALICE, 50000)], 300);
  assert.equal(b.boostFor(ALICE, 200).multiplier, 1); // window 101..200 opened with zero
  assert.equal(b.boostFor(ALICE, 294).multiplier, 1); // window 195..294 still sees the pre-buy zero
  assert.equal(b.boostFor(ALICE, 295).multiplier, 2); // held for the whole window
});

await test('selling inside the window drops the tier', () => {
  const b = fresh();
  b.recordTransfers([
    transfer(1, 10, BOB, ALICE, 20000),
    transfer(2, 250, ALICE, BOB, 19500),
  ], 300);
  assert.equal(b.boostFor(ALICE, 200).multiplier, 2);
  assert.equal(b.boostFor(ALICE, 260).multiplier, 1.25); // 500 TAC after the sale
});

await test('self-transfers and address case do not change the balance', () => {
  const b = fresh();
  b.recordTransfers([
    transfer(1, 10, BOB, ALICE.toUpperCase().replace('0X', '0x'), 1000),
    transfer(2, 20, ALICE, ALICE, 1000),
  ], 300);
  assert.equal(b.boostFor(ALICE, 200).multiplier, 1.5);
});

await test('activities before startBlock are never boosted', () => {
  const b = fresh({ startBlock: 250 });
  b.recordTransfers([transfer(1, 10, BOB, ALICE, 50000)], 300);
  assert.equal(b.boostFor(ALICE, 200).multiplier, 1);
  assert.equal(b.boostFor(ALICE, 250).multiplier, 2);
});

await test('a block past the replayed range throws instead of guessing', () => {
  const b = fresh();
  b.recordTransfers([], 300);
  assert.throws(() => b.boostFor(ALICE, 301), /past the replayed transfers/);
});

await test('scan replays in chunks, stays behind head, and a fresh replay reproduces every multiplier', async () => {
  const logs = [
    { transactionHash: '0x' + '1'.repeat(64), logIndex: 3, blockNumber: 5n, args: { from: ZERO, to: ALICE, amount: 20000n * TAC } },
    { transactionHash: '0x' + '2'.repeat(64), logIndex: 1, blockNumber: 150n, args: { from: ALICE, to: BOB, amount: 19000n * TAC } },
    { transactionHash: '0x' + '3'.repeat(64), logIndex: 0, blockNumber: 390n, args: { from: BOB, to: ALICE, amount: 5n * TAC } },
  ];
  const calls = [];
  const client = {
    getBlockNumber: async () => 412n,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([Number(fromBlock), Number(toBlock)]);
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const opts = { token: '0x' + 'a'.repeat(40), confirmations: 12, chunk: 128 };

  const a = fresh();
  assert.equal(await scanTacTransfers(a, client, opts), 400);
  assert.deepEqual(calls, [[1, 128], [129, 256], [257, 384], [385, 400]]);
  assert.equal(await scanTacTransfers(a, client, opts), 400); // caught up: no further calls
  assert.equal(calls.length, 4);

  const b = fresh();
  await scanTacTransfers(b, client, opts);
  for (const block of [50, 104, 149, 150, 200, 249, 250, 395, 400]) {
    assert.deepEqual(a.boostFor(ALICE, block), b.boostFor(ALICE, block), `block ${block}`);
  }
  assert.equal(a.boostFor(ALICE, 149).multiplier, 2);
  assert.equal(a.boostFor(ALICE, 200).multiplier, 1.5); // 1,000 left after the sale
  assert.equal(a.boostFor(ALICE, 250).multiplier, 1.5);
});

console.log(`\n${n} passed`);
