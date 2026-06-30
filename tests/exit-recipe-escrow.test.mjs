// Cross-check: the JS exitRecipeEscrow CREATE2 derivation must be byte-identical to the on-chain
// ConfidentialRouter.escrowAddressFor(recipe). The expected values are the gold-standard outputs of the
// Foundry test `ConfidentialRouterExit.t.sol::test_sampleEscrowAddress_forJsCrossCheck` (run with -vv), for the
// SAME fixed router address + sample recipe pinned below.
//
//   forge test --match-test test_sampleEscrowAddress_forJsCrossCheck -vv
//     escrowImpl:                0xa38D17ef017A314cCD72b8F199C0e108EF7Ca04c
//     fixedRouter:               0x00000000000000000000000000000000C0FFEE01
//     escrowAddressFor(...):     0x30A0690CCA072031Ca499D838C08F594e8e9bD23

import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialRouter } from '../dapp/confidential-router.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

// Pinned to the Foundry test's fixed inputs.
const FIXED_ROUTER = '0x00000000000000000000000000000000C0FFEE01';
const SAMPLE_RECIPE = {
  exitedAsset: '0x0000000000000000000000000000000000000000000000000000000000001111',
  tokenOut: '0x0000000000000000000000000000000000002222',
  minOut: 12345n,
  finalRecipient: '0x0000000000000000000000000000000000003333',
  deadline: 1893456000n,
  nonce: 42n,
  feeAsset: '0x0000000000000000000000000000000000006789',
  pushInput: false,
  zCalldata: '0xdeadbeef',
};
// The live escrow implementation (router.escrowImpl()); part of the PUSH0 clone initcode hash.
const ESCROW_IMPL = '0xa38D17ef017A314cCD72b8F199C0e108EF7Ca04c';
const EXPECTED_ESCROW = '0x30a0690cca072031ca499d838c08f594e8e9bd23'; // lowercased

const router = makeConfidentialRouter({ secp, keccak256: keccak_256, sha256, cfg: { chainId: 1, router: FIXED_ROUTER } });

test('exitRecipeEscrow == router.escrowAddressFor(recipe) for the sample recipe', () => {
  const escrow = router.exitRecipeEscrow(ESCROW_IMPL, SAMPLE_RECIPE, FIXED_ROUTER).toLowerCase();
  assert.equal(escrow, EXPECTED_ESCROW, `JS escrow ${escrow} != on-chain ${EXPECTED_ESCROW}`);
});

test('encodeExitRecipe round-trips through the salt (deterministic)', () => {
  const a = router.exitRecipeSalt(SAMPLE_RECIPE);
  const b = router.exitRecipeSalt({ ...SAMPLE_RECIPE });
  assert.equal(a, b);
  // changing any field changes the salt (and thus the escrow)
  const c = router.exitRecipeSalt({ ...SAMPLE_RECIPE, nonce: 43n });
  assert.notEqual(a, c);
});
