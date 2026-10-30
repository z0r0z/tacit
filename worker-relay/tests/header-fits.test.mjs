// How many headers a thin wallet can send, from the model, before any estimate. node --test tests/header-fits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { affordableHeaders, headerBatchGas, headerBatchNeed, exceedsAllowance, HEADER_GAS, HEADER_TX_GAS } from '../src/lib/header-fits.js';

const G = 1_000_000_000n;

test('a batch is as many headers as the padded gas limit at the fee cap fits in the budget', () => {
  // the wallet of 2026-10-30: 0.00065 ETH, an attest kept back (0.00028), a 0.451 gwei cap (1.5 x 0.3 gwei + the tip)
  const budget = 650_000_000_000_000n - 280_000_000_000_000n, fee = 451_000_000n;
  const n = affordableHeaders({ budget, maxFeePerGas: fee, max: 20 });
  assert.ok(n >= 3 && n <= 5, `about four headers (${n})`);
  assert.ok(headerBatchNeed(n, fee) <= budget, 'what it sends is paid for');
  assert.ok(headerBatchNeed(n + 1, fee) > budget, 'and one more would not be');
});

test('no budget, no fee or no headers wanted is none', () => {
  assert.equal(affordableHeaders({ budget: 0n, maxFeePerGas: G, max: 20 }), 0);
  assert.equal(affordableHeaders({ budget: -5n, maxFeePerGas: G, max: 20 }), 0);
  assert.equal(affordableHeaders({ budget: 10n ** 18n, maxFeePerGas: 0n, max: 20 }), 0);
  assert.equal(affordableHeaders({ budget: 10n ** 18n, maxFeePerGas: G, max: 0 }), 0);
});

test('under the cost of the transaction itself is none, even with a budget', () => {
  const justUnder = (HEADER_TX_GAS * 125n * G) / 100n;                 // pays the transaction's gas and not one header
  assert.equal(affordableHeaders({ budget: justUnder, maxFeePerGas: G, max: 20 }), 0);
  const oneHeader = headerBatchNeed(1, G);
  assert.equal(affordableHeaders({ budget: oneHeader, maxFeePerGas: G, max: 20 }), 1);
  assert.equal(affordableHeaders({ budget: oneHeader - 1n, maxFeePerGas: G, max: 20 }), 0);
});

test('a rich wallet is capped at the batch wanted', () => {
  assert.equal(affordableHeaders({ budget: 10n ** 19n, maxFeePerGas: G, max: 20 }), 20);
  assert.equal(affordableHeaders({ budget: 10n ** 19n, maxFeePerGas: G, max: 7 }), 7);
});

test('it grows with the budget and shrinks as the fee rises', () => {
  let last = -1;
  for (let k = 1; k <= 30; k++) { const n = affordableHeaders({ budget: BigInt(k) * 10n ** 14n, maxFeePerGas: 500_000_000n, max: 40 }); assert.ok(n >= last); last = n; }
  const cheap = affordableHeaders({ budget: 10n ** 15n, maxFeePerGas: 300_000_000n, max: 40 }), dear = affordableHeaders({ budget: 10n ** 15n, maxFeePerGas: 900_000_000n, max: 40 });
  assert.ok(cheap > dear);
});

test('the model is not under what the chain used: 20 headers measured at 3.5M gas', () => {
  assert.ok(headerBatchGas(20) >= 3_500_000n, 'the model covers the measured batch');
  assert.ok(HEADER_GAS >= 177_000n);
});

test('a node\'s refusal to estimate a send the account cannot pay for is told from other errors', () => {
  assert.equal(exceedsAllowance(new Error('Execution reverted with reason: gas required exceeds allowance (1981129).')), true);
  assert.equal(exceedsAllowance({ details: 'insufficient funds for gas * price + value' }), true);
  assert.equal(exceedsAllowance({ shortMessage: 'gas required exceeds allowance (2139401)' }), true);
  assert.equal(exceedsAllowance(new Error('execution reverted: UnknownParent')), false);
  assert.equal(exceedsAllowance(null), false);
});
