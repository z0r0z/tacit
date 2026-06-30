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
