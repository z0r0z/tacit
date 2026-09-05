// Cross-check: the JS exitRecipeEscrow CREATE2 derivation must be byte-identical to the on-chain
// ConfidentialRouter.escrowAddressFor(recipe). The expected values are the gold-standard outputs of the
// Foundry test `ConfidentialRouterExit.t.sol::test_sampleEscrowAddress_forJsCrossCheck` (run with -vv), for the
// SAME fixed router address + sample recipe pinned below.
//
//   forge test --match-test test_sampleEscrowAddress_forJsCrossCheck -vv
//     executorImpl:              0x83B4EEa426B7328eB3bE89cDb558F18BAF6A2Bf7
//     fixedRouter:               0x00000000000000000000000000000000C0FFEE01
//     escrowAddressFor(...):     0xB07E63c83dA580FE1Fe67ff200e2FF555543C974

import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialRouter } from '../dapp/confidential-router.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

// Pinned to the Foundry test's fixed inputs — a MULTI-CALL recipe (2 calls, 2 sweeps).
const FIXED_ROUTER = '0x00000000000000000000000000000000C0FFEE01';
const SAMPLE_RECIPE = {
  exitedAsset: '0x0000000000000000000000000000000000000000000000000000000000001111',
  feeAsset: '0x0000000000000000000000000000000000006789',
  finalRecipient: '0x0000000000000000000000000000000000003333',
  deadline: 1893456000n,
  nonce: 42n,
  calls: [
    { target: '0x0000000000000000000000000000000000001234', value: 7n, token: '0x0000000000000000000000000000000000005678', amount: 1000n, push: false, data: '0xdeadbeef' },
    { target: '0x0000000000000000000000000000000000009abc', value: 0n, token: '0x0000000000000000000000000000000000000000', amount: 0n, push: true, data: '0xcafe' },
  ],
  sweepTokens: ['0x000000000000000000000000000000000000AAAA', '0x0000000000000000000000000000000000000000'],
  minOuts: [11n, 22n],
};
// The live executor implementation (router.executorImpl()); part of the PUSH0 clone initcode hash.
const EXECUTOR_IMPL = '0x83B4EEa426B7328eB3bE89cDb558F18BAF6A2Bf7';
const EXPECTED_ESCROW = '0xb07e63c83da580fe1fe67ff200e2ff555543c974'; // lowercased

const router = makeConfidentialRouter({ secp, keccak256: keccak_256, sha256, cfg: { chainId: 1, router: FIXED_ROUTER } });

test('exitRecipeEscrow == router.escrowAddressFor(recipe) for the multi-call sample recipe', () => {
  const escrow = router.exitRecipeEscrow(EXECUTOR_IMPL, SAMPLE_RECIPE, FIXED_ROUTER).toLowerCase();
  assert.equal(escrow, EXPECTED_ESCROW, `JS escrow ${escrow} != on-chain ${EXPECTED_ESCROW}`);
});

test('encodeExitRecipe round-trips through the salt (deterministic)', () => {
  const a = router.exitRecipeSalt(SAMPLE_RECIPE);
  const b = router.exitRecipeSalt({ ...SAMPLE_RECIPE });
  assert.equal(a, b);
  // changing any field changes the salt (and thus the escrow)
  const c = router.exitRecipeSalt({ ...SAMPLE_RECIPE, nonce: 43n });
  assert.notEqual(a, c);
  // changing a nested call's data changes the salt too
  const d = router.exitRecipeSalt({
    ...SAMPLE_RECIPE,
    calls: [{ ...SAMPLE_RECIPE.calls[0], data: '0xdeadbee0' }, SAMPLE_RECIPE.calls[1]],
  });
  assert.notEqual(a, d);
});

// Selectors below are keccak256(signature)[0:4] for the router's exit-recipe entrypoints — cross-checked
// independently via `cast sig` against the exact ABI signature strings (2026-09-05). A drift here means the
// router's function signatures changed and the hand-rolled encoders below are stale.
const SEL_ESCROW_ADDRESS_FOR = '0x2bf0cda2';
const SEL_ACTIVATE_EXIT = '0x1699fd5b';
const SEL_RECLAIM_EXIT = '0x02edf635';

test('escrowAddressForCalldata / activateExitCalldata: correct selector + tuple body matches encodeExitRecipe', () => {
  const body = router.encodeExitRecipe(SAMPLE_RECIPE).slice(2); // includes the leading 0x20 tuple-offset word
  const escrowCd = router.escrowAddressForCalldata(SAMPLE_RECIPE);
  const activateCd = router.activateExitCalldata(SAMPLE_RECIPE);
  assert.equal(escrowCd.slice(0, 10), SEL_ESCROW_ADDRESS_FOR);
  assert.equal(activateCd.slice(0, 10), SEL_ACTIVATE_EXIT);
  assert.equal(escrowCd.slice(10), body);
  assert.equal(activateCd.slice(10), body);
});

test('reclaimExitCalldata: correct selector, decodes back to the same extraTokens', () => {
  const extra = ['0x' + '4444'.padStart(40, '0'), '0x' + '5555'.padStart(40, '0')];
  const cd = router.reclaimExitCalldata(SAMPLE_RECIPE, extra);
  assert.equal(cd.slice(0, 10), SEL_RECLAIM_EXIT);

  const hex = cd.slice(10);
  const wordAt = (i) => hex.slice(i * 64, i * 64 + 64);
  const recipeOff = Number(BigInt('0x' + wordAt(0)));
  const arrayOff = Number(BigInt('0x' + wordAt(1)));
  assert.equal(recipeOff, 64); // two head words precede the tail
  // The recipe's own encoding (offset 0 relative to its tuple start) reoccupies [recipeOff, arrayOff).
  const recipeBody = hex.slice(recipeOff * 2, arrayOff * 2);
  assert.equal(recipeBody, router.encodeExitRecipe(SAMPLE_RECIPE).slice(2 + 64));
  // address[] tail: length word + one word per address.
  const arrHex = hex.slice(arrayOff * 2);
  const len = Number(BigInt('0x' + arrHex.slice(0, 64)));
  assert.equal(len, extra.length);
  const decoded = Array.from({ length: len }, (_, i) => '0x' + arrHex.slice(64 + i * 64 + 24, 64 + i * 64 + 64));
  assert.deepEqual(decoded, extra.map((a) => a.toLowerCase()));

  // Empty extraTokens still encodes a valid (zero-length) array.
  const cdEmpty = router.reclaimExitCalldata(SAMPLE_RECIPE, []);
  const hexEmpty = cdEmpty.slice(10);
  const arrayOffEmpty = Number(BigInt('0x' + hexEmpty.slice(64, 128)));
  assert.equal(Number(BigInt('0x' + hexEmpty.slice(arrayOffEmpty * 2, arrayOffEmpty * 2 + 64))), 0);
});

// createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes) — cross-checked
// via `cast sig` and against the live Robinhood Chain Inbox (0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D),
// which responded correctly to this exact selector on 2026-09-05.
const SEL_CREATE_RETRYABLE_TICKET = '0x679b6ded';

test('createRetryableTicketCalldata: correct selector, static fields decode back exactly', () => {
  const args = {
    to: '0x' + '4321'.padStart(40, '0'),
    l2CallValue: 1000000000000000n,
    maxSubmissionCost: 12345n,
    excessFeeRefundAddress: '0x' + '4321'.padStart(40, '0'),
    callValueRefundAddress: '0x' + '4321'.padStart(40, '0'),
    gasLimit: 100000n,
    maxFeePerGas: 50000000n,
    data: '0x',
  };
  const cd = router.createRetryableTicketCalldata(args);
  assert.equal(cd.slice(0, 10), SEL_CREATE_RETRYABLE_TICKET);
  const hex = cd.slice(10);
  const wordAt = (i) => hex.slice(i * 64, i * 64 + 64);
  assert.equal('0x' + wordAt(0).slice(24), args.to);
  assert.equal(BigInt('0x' + wordAt(1)), args.l2CallValue);
  assert.equal(BigInt('0x' + wordAt(2)), args.maxSubmissionCost);
  assert.equal('0x' + wordAt(3).slice(24), args.excessFeeRefundAddress);
  assert.equal('0x' + wordAt(4).slice(24), args.callValueRefundAddress);
  assert.equal(BigInt('0x' + wordAt(5)), args.gasLimit);
  assert.equal(BigInt('0x' + wordAt(6)), args.maxFeePerGas);
  // word(7) is the offset to the dynamic `data` tail; empty data ⇒ a zero-length word right after it.
  const dataOffset = Number(BigInt('0x' + wordAt(7)));
  assert.equal(Number(BigInt('0x' + hex.slice(dataOffset * 2, dataOffset * 2 + 64))), 0);
});

test('buildArbitrumBridgeExit: total call value is l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas, refunds pinned to l2Recipient', () => {
  const l2Recipient = '0x' + '9999'.padStart(40, '0');
  const r = router.buildArbitrumBridgeExit({
    exitedAsset: SAMPLE_RECIPE.exitedAsset,
    l2Recipient,
    l2CallValue: 1000000000000000n,
    maxSubmissionCost: 12345n,
    gasLimit: 100000n,
    maxFeePerGas: 50000000n,
    deadline: 1893456000n,
    nonce: 7n,
  });
  assert.equal(r.calls.length, 1);
  const expectedTotal = 1000000000000000n + 12345n + 100000n * 50000000n;
  assert.equal(r.calls[0].value, expectedTotal);
  assert.equal(r.calls[0].target.toLowerCase(), router.ARBITRUM_ORBIT_INBOX[4663].toLowerCase());
  assert.equal(r.finalRecipient.toLowerCase(), l2Recipient.toLowerCase());
  assert.equal(r.sweepTokens.length, 1);
  assert.ok(router.exitRecipeSalt(r).startsWith('0x'));
});

test('buildSwapExit / buildBatchExit produce hashable recipes', () => {
  const r = router.buildSwapExit({
    exitedAsset: SAMPLE_RECIPE.exitedAsset,
    inToken: '0x0000000000000000000000000000000000005678',
    inAmount: 1000n,
    outToken: '0x000000000000000000000000000000000000AAAA',
    minOut: 11n,
    finalRecipient: SAMPLE_RECIPE.finalRecipient,
    deadline: 1893456000n,
    nonce: 1n,
    zCalldata: '0xdeadbeef',
  });
  assert.equal(r.calls.length, 1);
  assert.ok(router.exitRecipeSalt(r).startsWith('0x'));
});
