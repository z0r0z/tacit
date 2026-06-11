#!/usr/bin/env node
// Validates the Tacit→EVM account derivation (dapp/evm-account.js): the
// address derivation matches known secp→ETH vectors, and deriveEvmAccount is
// deterministic, network-isolated, key-isolated, and in-range.
//
// Run: node tests/evm-account.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeEvmAccount } from '../dapp/evm-account.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const a = makeEvmAccount({ secp, keccak256: keccak_256, sha256 });
let n = 0; const ok = (m) => { console.log('  ok -', m); n++; };

// ── 1. address derivation matches canonical secp→ETH vectors ──
assert.strictEqual(a.addressFromPriv(1n), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', 'privkey 1');
assert.strictEqual(a.addressFromPriv(2n), '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf', 'privkey 2');
ok('addressFromPriv matches known secp256k1 → Ethereum vectors (priv 1, 2)');

// ── 2. deterministic ──
const tacit = '0x' + '11'.repeat(32);
const acc1 = a.deriveEvmAccount(tacit, 'mainnet');
const acc2 = a.deriveEvmAccount(tacit, 'mainnet');
assert.deepStrictEqual(acc1, acc2, 'deterministic');
ok(`deterministic: same tacit key + network → same EVM account (${acc1.address.slice(0, 12)}…)`);

// ── 3. network isolation ──
const accSig = a.deriveEvmAccount(tacit, 'signet');
assert.notStrictEqual(acc1.address, accSig.address, 'network isolation');
ok('network-isolated: signet and mainnet derive distinct EVM accounts');

// ── 4. key isolation ──
const accOther = a.deriveEvmAccount('0x' + '22'.repeat(32), 'mainnet');
assert.notStrictEqual(acc1.address, accOther.address, 'key isolation');
ok('key-isolated: different tacit keys derive different EVM accounts');

// ── 5. in-range + address consistency ──
const p = BigInt(acc1.priv);
assert.ok(p > 0n && p < secp.CURVE.n, 'evm priv in [1, N-1]');
assert.strictEqual(a.addressFromPriv(p), acc1.address, 'address matches derived priv');
ok('derived priv in [1, N-1] and its address matches');

console.log(`\n${n}/5 evm-account checks passed`);
