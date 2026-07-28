#!/usr/bin/env node
// ETH→BTC message (EthCallOutbox) cross-language parity.
//
// The record hash is derived in FOUR places that must agree byte-for-byte: EthCallOutbox.recordHashOf
// (Solidity, the BINDING side — it refuses what the guest could not fold), cxfer-core
// eth_reflection::eth_message_record (Rust, both guests), and the JS mirror here (dapp assembler + worker).
// A drift means a message accepted on Ethereum is unfoldable on Bitcoin — silent, and only visible once a
// real message is sent. The KAT below is the same vector asserted in:
//   - contracts/test/EthCallOutbox.t.sol            test_recordHash_kat
//   - cxfer-core/src/eth_reflection.rs              message_record_matches_solidity_recordhashof
//
// Run: node tests/eth-message-parity.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const NS_ATTEST = hx(keccak_256(Buffer.from('tacit-ns-attest-v1')));
const PAYLOAD_HASH = hx(keccak_256(Buffer.from('hello')));
const SENDER20 = Buffer.from('000000000000000000000000000000000000a11c', 'hex');

// ── 1. The KAT ──────────────────────────────────────────────────────────────────────────────────
const record = pool.ethMessageRecord(1, NS_ATTEST, SENDER20, PAYLOAD_HASH);
assert.strictEqual(
  record.toLowerCase(),
  '0x0d6a81b8062c850eabea90ec9a223a5e2aba6f7e8ddaf5d46c102e63507241be',
  'JS ethMessageRecord drifted from the Solidity/Rust vector',
);

// ── 2. Every field is bound ─────────────────────────────────────────────────────────────────────
const other32 = '0x' + '09'.repeat(32);
const otherSender = Buffer.alloc(20, 8);
assert.notStrictEqual(record, pool.ethMessageRecord(2, NS_ATTEST, SENDER20, PAYLOAD_HASH), 'destChain not bound');
assert.notStrictEqual(record, pool.ethMessageRecord(1, other32, SENDER20, PAYLOAD_HASH), 'ns not bound');
assert.notStrictEqual(record, pool.ethMessageRecord(1, NS_ATTEST, otherSender, PAYLOAD_HASH), 'sender not bound');
assert.notStrictEqual(record, pool.ethMessageRecord(1, NS_ATTEST, SENDER20, other32), 'payload hash not bound');

// ── 3. The leaf, and its place in the set ───────────────────────────────────────────────────────
const msgId = hx(keccak_256(Buffer.from('msgid-fixture')));
const leaf = pool.ethMessageLeaf(msgId, record);
assert.strictEqual(
  leaf.toLowerCase(),
  '0xbe550f6222d0bd3552d78245781fe8d58532b296d275ee921d259795a90fb7b4',
  'JS ethMessageLeaf drifted from keccak(msgId ‖ record)',
);
// The leaf binds BOTH halves: a different record under the same id is a different message.
assert.notStrictEqual(leaf, pool.ethMessageLeaf(msgId, other32), 'record not bound into the leaf');
assert.notStrictEqual(leaf, pool.ethMessageLeaf(other32, record), 'msgId not bound into the leaf');

// ── 4. The genesis digest still binds an empty message set ──────────────────────────────────────
// ethReflDigest gained the message set; the genesis prior the FIRST Mode-B cycle continues must reflect
// that, or the Bitcoin guest's `priorDigest == genesis` assert fails on the first reverse cycle.
const EMPTY_ETH_SET_ROOT = '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757';
const pv = pool.buildEthPv(pool.makeImtAccumulator().root(), EMPTY_ETH_SET_ROOT, 0, 0, null);
assert.strictEqual(typeof pv, 'string', 'buildEthPv must still assemble');
assert.strictEqual((pv.length - 2) / 64, 14, 'EthReflectionPublicValues must be 14 words');

console.log('ok — eth-message parity (record KAT, field binding, leaf, 14-word PV)');
