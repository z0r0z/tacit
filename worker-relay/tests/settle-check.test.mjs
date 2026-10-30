// A board proof is judged on the pool's answer, not on the settle wallet's balance. node --test tests/settle-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettleCheck, fundsRefusal } from '../src/lib/settle-check.js';

const STALE = ['0x4b9a1cfe', 'StaleRoot'];

test('a node refusing to run the call for a wallet that cannot pay is not a bad proof (the 2026-10-29 23:31 case: allowance 47,755 gas)', () => {
  const e = Object.assign(new Error('x'), { shortMessage: 'The contract function "settle" reverted with the following reason:\ngas required exceeds allowance (47755)' });
  assert.deepEqual(readSettleCheck(e, STALE).verdict, 'unchecked');
  assert.equal(fundsRefusal(e), true);
  assert.equal(readSettleCheck({ message: 'insufficient funds for gas * price + value' }, STALE).verdict, 'unchecked');
  assert.equal(readSettleCheck({ cause: { details: 'gas required exceeds allowance (2554560)' } }, STALE).verdict, 'unchecked');
});

test('the pool\'s own refusal is bad, and a stale root is stale, whoever the wallet is', () => {
  assert.equal(readSettleCheck({ shortMessage: 'The contract function "settle" reverted.' }, STALE).verdict, 'bad');
  assert.equal(readSettleCheck({ shortMessage: 'reverted with custom error StaleRoot()' }, STALE).verdict, 'stale');
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: '0x4B9A1CFE0000' } }, STALE).verdict, 'stale');
  assert.equal(readSettleCheck(new Error('Execution reverted: InvalidProof'), STALE).verdict, 'bad');
});

test('stale wins over a funds message, and a cause that cannot be written down does not throw', () => {
  assert.equal(readSettleCheck({ shortMessage: 'StaleRoot, gas required exceeds allowance (1)' }, STALE).verdict, 'stale');
  const circular = { shortMessage: 'reverted' }; circular.cause = circular;
  assert.equal(readSettleCheck(circular, STALE).verdict, 'bad');
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { value: 10n ** 30n } }, STALE).verdict, 'bad', 'a bigint in the cause is fine');
  assert.equal(readSettleCheck(null, STALE).verdict, 'bad');
  assert.equal(readSettleCheck('plain string', []).verdict, 'bad');
});
