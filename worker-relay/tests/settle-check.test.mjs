// A board proof is judged on the pool's answer, not on the settle wallet's balance. node --test tests/settle-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettleCheck, fundsRefusal, EFFECT_REVERTS } from '../src/lib/settle-check.js';

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

test('a proof whose deposit is not in the pool yet (proved first) is nodeposit, by the selector or the name, never bad', () => {
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: '0x070d817c' } }, STALE).verdict, 'nodeposit');
  assert.equal(readSettleCheck({ shortMessage: 'reverted with custom error DepositNotPending()' }, STALE).verdict, 'nodeposit');
  assert.equal(readSettleCheck({ shortMessage: 'reverted with custom error DepositExists()' }, STALE).verdict, 'bad');
});

test('an op the pool refuses as it stands (its note already spent, a farm over-claim) is op, not a bad proof: no mark against the worker, and no second proof', () => {
  const op = (e, sel, name) => { const r = readSettleCheck(e, STALE); assert.equal(r.verdict, 'op'); assert.deepEqual(r.effect, { selector: sel, name }); };
  op({ shortMessage: 'reverted', cause: { data: '0xb115d857' } }, '0xb115d857', 'NullifierAlreadySpent');
  op({ shortMessage: 'reverted with custom error NullifierAlreadySpent()' }, '0xb115d857', 'NullifierAlreadySpent');
  op({ shortMessage: 'reverted', cause: { data: '0x508ece93' } }, '0x508ece93', 'OverClaim');
  op({ shortMessage: 'reverted with custom error OverClaim()' }, '0x508ece93', 'OverClaim');
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: '0xb115d857' } }, []).verdict, 'op', 'whatever list of stale roots the lane passes');
  // neighbours stay what they were
  assert.equal(readSettleCheck({ shortMessage: 'reverted with custom error InvalidProof()' }, STALE).verdict, 'bad');
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: '0x508ece94' } }, STALE).verdict, 'bad', 'a selector one off is not OverClaim');
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: '0x070d817c' } }, STALE).verdict, 'nodeposit', 'DepositNotPending is still its own verdict');
  assert.equal(readSettleCheck({ shortMessage: 'gas required exceeds allowance (47755)' }, STALE).verdict, 'unchecked');
});

test('the rest of the permanent refusals are op too: a wrong farm asset, reserves the pool no longer has, a burn, lock, position or harvest already used, a value that must bridge', () => {
  for (const [sel, name] of [['0xfd074bc1', 'WrongStakeAsset'], ['0x29b3c833', 'PoolReserveMismatch'], ['0xc760049c', 'BurnAlreadyMinted'], ['0xf7ee2683', 'LockAlreadySpent'], ['0x73f11ff4', 'CdpPositionAlreadySpent'], ['0xd590960c', 'HarvestReplayed'], ['0x4868d53b', 'BtcHomedValueExitMustBridge']]) {
    const bySel = readSettleCheck({ shortMessage: 'reverted with the following signature:', cause: { data: sel } }, STALE);
    assert.equal(bySel.verdict, 'op', name); assert.equal(bySel.effect.name, name);
    assert.equal(readSettleCheck({ shortMessage: `reverted with custom error ${name}()` }, []).verdict, 'op', `${name} by name`);
  }
  assert.ok(EFFECT_REVERTS.length === 9 && EFFECT_REVERTS.every((x) => /^0x[0-9a-f]{8}$/.test(x.selector)), 'a list of 4-byte selectors');
  assert.equal(new Set(EFFECT_REVERTS.map((x) => x.selector)).size, EFFECT_REVERTS.length, 'no selector twice');
});

test('refusals that clear with time, or that the lane proves again, are not op: TooEarly, Locked, NoLivePosition, a stale Bitcoin root', () => {
  for (const sel of ['0x085de625', '0x0f2e5b6c', '0x4743737f']) assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: sel } }, STALE).verdict, 'bad', sel);
  assert.equal(readSettleCheck({ shortMessage: 'reverted', cause: { data: '0x8a98f245' } }, ['0x8a98f245']).verdict, 'stale', 'a stale root stays stale (the lane proves it again from the witness)');
});

test('the selectors are the contracts\' own: each is the 4-byte hash of its error name', async () => {
  const { keccak256, toHex } = await import('viem');
  for (const x of EFFECT_REVERTS) assert.equal(keccak256(toHex(`${x.name}()`)).slice(0, 10), x.selector, x.name);
});
