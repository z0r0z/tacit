// A reverting attest estimate whose revert says the pool moved past the proof (the proof can never land) is told apart from any other
// failure, so the lane lets the proof go without backing off. node --test tests/attest-revert.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, CallExecutionError } from 'viem';
import { staleAttestRevert, STALE_ATTEST_ERRORS } from '../src/lib/attest-revert.js';

const ABI = [{ type: 'function', name: 'attestBitcoinStateProven', stateMutability: 'nonpayable', inputs: [{ type: 'bytes' }, { type: 'bytes' }], outputs: [] }];
// What viem throws when the pool's ABI does not carry the error: the selector in the revert data and the message.
const reverted = (data) => new ContractFunctionExecutionError(
  new ContractFunctionRevertedError({ abi: ABI, data, functionName: 'attestBitcoinStateProven' }),
  { abi: ABI, functionName: 'attestBitcoinStateProven', args: ['0x', '0x'], contractAddress: '0x000000000Ed1eabD231Be41d93b719056F7febFC' },
);

test('ConsumedCountStale (0x55a09618), the 2026-11-05 refusal, reads as stale', () => {
  assert.equal(staleAttestRevert(reverted('0x55a09618')), 'ConsumedCountStale');
});

test('every stale-state error is known by its selector', async () => {
  const { toFunctionSelector } = await import('viem');
  for (const n of STALE_ATTEST_ERRORS) assert.equal(staleAttestRevert(reverted(toFunctionSelector(`${n}()`))), n);
});

test('a revert that does not mean the state moved is not stale', async () => {
  const { toFunctionSelector } = await import('viem');
  for (const n of ['UnanchoredReflection', 'WrongEthPool', 'ChainMismatch', 'StaleBitcoinSpentRoot']) {
    assert.equal(staleAttestRevert(reverted(toFunctionSelector(`${n}()`))), null, n);
  }
  assert.equal(staleAttestRevert(new Error('fetch failed')), null);
  assert.equal(staleAttestRevert(null), null);
});

test('a revert with no data on our node is decided by a selector had elsewhere', () => {
  const bare = new CallExecutionError(new BaseError('execution reverted'), { account: undefined });
  assert.equal(staleAttestRevert(bare), null);
  assert.equal(staleAttestRevert(bare, '0x55a09618'), 'ConsumedCountStale');
  assert.equal(staleAttestRevert(bare, '0x12345678'), null);
});

test('a decoded error name, or the name in the text, is enough', () => {
  const named = { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError', data: { errorName: 'StaleReflectionDigest' } } };
  assert.equal(staleAttestRevert(named), 'StaleReflectionDigest');
  assert.equal(staleAttestRevert(new Error('reverted: StaleRelayProof()')), 'StaleRelayProof');
});
