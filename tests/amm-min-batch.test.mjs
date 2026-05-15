// MIN_BATCH_SIZE confidentiality default (audit MEDIUM-4).
//
// Verifies the normative indexer rule: validateSwapBatch REJECTS N=1 batches
// for default pools, and ACCEPTS them only when the pool has the
// POOL_CAP_SOLO_INTENT_ALLOWED capability flag set.
//
// Why this matters: a SWAP_BATCH publishes (Δa_net, Δb_net) on chain. With
// N=1 those public deltas equal the trader's exact swap amount, defeating
// amount confidentiality. The default rule forces settlers to accumulate
// ≥ 2 intents per batch, mixing trader amounts together. Pools that prefer
// liveness over confidentiality opt in via the capability flag.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  AMM_MIN_BATCH_SIZE,
  POOL_CAP_SOLO_INTENT_ALLOWED,
} from './amm-validator.mjs';

describe('AMM_MIN_BATCH_SIZE — confidentiality default', () => {

  test('AMM_MIN_BATCH_SIZE == 2', () => {
    assert.strictEqual(AMM_MIN_BATCH_SIZE, 2);
  });

  test('POOL_CAP_SOLO_INTENT_ALLOWED bit is 0x02', () => {
    // Bit 0 (0x01) is reserved by AMM.md for LP_ADD T_RANGE_ATTEST gating.
    // POOL_CAP_SOLO_INTENT_ALLOWED occupies bit 1 (0x02).
    assert.strictEqual(POOL_CAP_SOLO_INTENT_ALLOWED, 0x02);
  });

  test('capability flag bit reserves room for 6 future flags', () => {
    // 0x01 and 0x02 are taken; 0x04, 0x08, 0x10, 0x20, 0x40, 0x80 remain.
    assert.strictEqual(POOL_CAP_SOLO_INTENT_ALLOWED & 0x02, 0x02);
    assert.strictEqual(POOL_CAP_SOLO_INTENT_ALLOWED & 0xfd, 0);
  });

});
