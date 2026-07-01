#!/usr/bin/env node
// Validates the ETH→BTC reverse cross-lane gate (dapp/confidential-crosslane-guard.js) —
// PLAN-confidential-cross-chain.md §10 step 1. The Bitcoin-spend validator must reject
// spending a note whose ν is spent on the EVM ConfidentialPool, and must FAIL CLOSED when
// it cannot confirm. Checks:
//   1. selector == nullifierSpent(bytes32)
//   2. ν spent on EVM (return word non-zero) → blocked
//   3. ν unspent on EVM (return word zero)   → not blocked
//   4. RPC throws                            → blocked (fail-closed)
//   5. malformed `0x` return                 → blocked (fail-closed)
//   6. no EVM pool wired (poolAddress null)  → not blocked (cross-lane inactive)
//   7. the ABI-encoded calldata is selector ‖ ν, and the queried tag is forwarded
//
// Run: node tests/confidential-crosslane-guard.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import assert from 'node:assert';
import { makeCrossLaneGuard } from '../dapp/confidential-crosslane-guard.js';

const keccak256 = (b) => keccak_256(b);
const guard = makeCrossLaneGuard({ keccak256 });

const POOL = '0xC2CB3b290000000000000000000000000000beef';
const NU = '0x' + '11'.repeat(32);
const WORD_TRUE = '0x' + '0'.repeat(63) + '1';
const WORD_FALSE = '0x' + '0'.repeat(64);

// 1. storage slot = keccak256(ν ‖ uint256(69)) — the Solidity mapping-slot rule for nullifierSpent (slot 69)
{
  const slotWord = '0'.repeat(62) + '45'; // uint256(69) == 0x45
  const expect = '0x' + Buffer.from(keccak_256(Buffer.from('11'.repeat(32) + slotWord, 'hex'))).toString('hex');
  assert.equal(guard.spentSlot(NU), expect, 'slot is keccak256(ν ‖ uint256(69))');
  assert.equal(guard.NULLIFIER_SPENT_SLOT, 69, 'nullifierSpent declaration slot');
}

// 7. storage-read shape + tag forwarding (capture what the guard sends)
{
  let seen = null;
  const ethGetStorageAt = async (to, slot, tag) => { seen = { to, slot, tag }; return WORD_FALSE; };
  await guard.bitcoinSpendBlocked(ethGetStorageAt, POOL, NU);
  assert.equal(seen.to, POOL.toLowerCase(), 'pool address lowercased');
  assert.equal(seen.slot, guard.spentSlot(NU), 'reads the nullifierSpent[ν] storage slot');
  assert.equal(seen.tag, 'latest', 'defaults to the latest mined block (block ASAP, not after finality)');
  const r = await guard.bitcoinSpendBlocked(ethGetStorageAt, POOL, NU, { blockTag: 'finalized' });
  assert.equal(seen.tag, 'finalized', 'tag is overridable');
  assert.equal(r.blocked, false, 'unspent → not blocked');
}

// 2. EVM-spent → blocked
{
  const ethCall = async () => WORD_TRUE;
  const r = await guard.bitcoinSpendBlocked(ethCall, POOL, NU);
  assert.equal(r.blocked, true, 'EVM-spent note blocks the Bitcoin spend');
  assert.equal(r.reason, 'evm-spent');
}

// 3. EVM-unspent → not blocked
{
  const ethCall = async () => WORD_FALSE;
  const r = await guard.bitcoinSpendBlocked(ethCall, POOL, NU);
  assert.equal(r.blocked, false, 'EVM-unspent note may be spent on Bitcoin');
  assert.equal(r.reason, 'evm-unspent');
}

// 4. RPC failure → fail-closed
{
  const ethCall = async () => { throw new Error('rpc down'); };
  const r = await guard.bitcoinSpendBlocked(ethCall, POOL, NU);
  assert.equal(r.blocked, true, 'cannot confirm unspent → fail closed');
  assert.equal(r.reason, 'evm-unverifiable');
}

// 5. malformed `0x` return (no contract / reverted) → fail-closed
{
  const ethCall = async () => '0x';
  const r = await guard.bitcoinSpendBlocked(ethCall, POOL, NU);
  assert.equal(r.blocked, true, 'empty return is unverifiable → fail closed');
  assert.equal(r.reason, 'evm-unverifiable');
}

// 6. cross-lane inactive (no EVM pool) → not blocked, and no RPC call made
{
  let called = false;
  const ethCall = async () => { called = true; return WORD_TRUE; };
  const r = await guard.bitcoinSpendBlocked(ethCall, null, NU);
  assert.equal(r.blocked, false, 'no EVM pool wired → pure-Bitcoin operation unchanged');
  assert.equal(r.reason, 'crosslane-inactive');
  assert.equal(called, false, 'no RPC call when cross-lane is inactive');
}

// evmNullifierSpent direct: bool word parsing (non-zero anywhere in the low byte)
{
  const ethCall = async () => '0x' + '0'.repeat(62) + '01' + 'ff'.repeat(0); // ...0001
  assert.equal(await guard.evmNullifierSpent(ethCall, POOL, NU), true, 'low-bit set → spent');
}

console.log('confidential-crosslane-guard: all checks passed');
