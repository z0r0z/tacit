// Cross-check: the JS exitRecipeEscrow CREATE2 derivation must be byte-identical to the on-chain
// ConfidentialRouter.escrowAddressFor(recipe). The expected values are the gold-standard outputs of the
// Foundry test `ConfidentialRouterExit.t.sol::test_sampleEscrowAddress_forJsCrossCheck` (run with -vv), for the
// SAME fixed router address + sample recipe pinned below.
//
//   forge test --match-test test_sampleEscrowAddress_forJsCrossCheck -vv
//     EXIT_ESCROW_INITCODE_HASH: 0xe6d8...67a2
//     fixedRouter:               0x00000000000000000000000000000000C0FFEE01
//     escrowAddressFor(...):     0x16842c2955F6516CD94d2b101E93949a852a25a9

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
  zCalldata: '0xdeadbeef',
};
const EXPECTED_INITCODE_HASH = '0xe6d8d739de13b5016e66ce90c2c628dbf3083375504cd9d9937415be0e8c67a2';
const EXPECTED_ESCROW = '0x16842c2955f6516cd94d2b101e93949a852a25a9'; // lowercased

const router = makeConfidentialRouter({ secp, keccak256: keccak_256, sha256, cfg: { chainId: 1, router: FIXED_ROUTER } });

test('EXIT_ESCROW_INITCODE_HASH matches the on-chain constant', () => {
  assert.equal(router.EXIT_ESCROW_INITCODE_HASH, EXPECTED_INITCODE_HASH);
});

test('exitRecipeEscrow == router.escrowAddressFor(recipe) for the sample recipe', () => {
  const escrow = router.exitRecipeEscrow(FIXED_ROUTER, SAMPLE_RECIPE).toLowerCase();
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
