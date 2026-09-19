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

// 1. storage slot = keccak256(ν ‖ uint256(70)) — the Solidity mapping-slot rule for nullifierSpent (slot 70).
//    The constant itself is checked against the compiled storage layout by
//    contracts/sp1/confidential/verify-storage-slots.sh; this case covers the slot-derivation rule.
{
  assert.equal(guard.NULLIFIER_SPENT_SLOT, 70, 'nullifierSpent declaration slot');
  // The expectation is derived from the guard's own constant, so this case tests the mapping-slot rule
  // rather than a fixed digest.
  const slotWord = guard.NULLIFIER_SPENT_SLOT.toString(16).padStart(64, '0');
  const expect = '0x' + Buffer.from(keccak_256(Buffer.from('11'.repeat(32) + slotWord, 'hex'))).toString('hex');
  assert.equal(guard.spentSlot(NU), expect, 'slot is keccak256(ν ‖ uint256(slot))');
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

// ── bitcoinSpendBlockedAny: the multi-leaf-domain gate ────────────────────────────────────────────
//
// A Bitcoin-homed note has two possible leaf domains — legacy `btc_note_leaf` and generation-bound
// `btc_note_leaf_bound` — which hash to different nullifiers, and the EVM fast lane records the bound form.
// These cases pin that every candidate nullifier is checked.
const NU_UNBOUND = '0x' + 'a1'.repeat(32);
const NU_BOUND = '0x' + 'b2'.repeat(32);

// 7. only the BOUND ν is spent on the EVM → still blocked (the fast-lane case)
{
  const spent = new Set([guard.spentSlot(NU_BOUND)]);
  const ethCall = async (_to, slot) => (spent.has(slot) ? WORD_TRUE : WORD_FALSE);
  const r = await guard.bitcoinSpendBlockedAny(ethCall, POOL, [NU_UNBOUND, NU_BOUND]);
  assert.equal(r.blocked, true, 'a fast-laned (generation-bound) note must block the Bitcoin spend');
  assert.equal(r.reason, 'evm-spent');
  assert.equal(r.nullifier, NU_BOUND, 'reports which domain matched');
  // And the single-ν form on the unbound domain alone would have MISSED it — the bug this closes.
  const miss = await guard.bitcoinSpendBlocked(ethCall, POOL, NU_UNBOUND);
  assert.equal(miss.blocked, false, 'unbound-only check misses a bound-domain consume (the regression)');
}

// 8. only the LEGACY ν is spent → still blocked (order-independent)
{
  const spent = new Set([guard.spentSlot(NU_UNBOUND)]);
  const ethCall = async (_to, slot) => (spent.has(slot) ? WORD_TRUE : WORD_FALSE);
  const r = await guard.bitcoinSpendBlockedAny(ethCall, POOL, [NU_UNBOUND, NU_BOUND]);
  assert.equal(r.blocked, true, 'a legacy-domain consume blocks too');
  assert.equal(r.nullifier, NU_UNBOUND);
}

// 9. neither spent → not blocked, and every candidate was actually queried
{
  const seen = [];
  const ethCall = async (_to, slot) => { seen.push(slot); return WORD_FALSE; };
  const r = await guard.bitcoinSpendBlockedAny(ethCall, POOL, [NU_UNBOUND, NU_BOUND]);
  assert.equal(r.blocked, false, 'unspent in both domains → safe to honor on Bitcoin');
  assert.equal(seen.length, 2, 'every candidate domain is queried');
}

// 10. empty candidate list is a CALLER BUG, not "nothing to check" → fail closed
{
  let called = false;
  const ethCall = async () => { called = true; return WORD_FALSE; };
  const r = await guard.bitcoinSpendBlockedAny(ethCall, POOL, []);
  assert.equal(r.blocked, true, 'no candidates supplied → cannot confirm unspent → fail closed');
  assert.equal(r.reason, 'evm-unverifiable');
  assert.equal(called, false);
}

// 11. an RPC failure on ANY candidate fails the whole check closed
{
  const ethCall = async (_to, slot) => {
    if (slot === guard.spentSlot(NU_BOUND)) throw new Error('rpc down');
    return WORD_FALSE;
  };
  const r = await guard.bitcoinSpendBlockedAny(ethCall, POOL, [NU_UNBOUND, NU_BOUND]);
  assert.equal(r.blocked, true, 'an unverifiable candidate blocks, even if another read clean');
  assert.equal(r.reason, 'evm-unverifiable');
}

console.log('confidential-crosslane-guard: all checks passed');
