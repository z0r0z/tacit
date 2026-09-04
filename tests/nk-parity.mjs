// JS side of the native-note ownership parity check.
//
// A native (EVM-homed) note's published owner is keccak(nk ‖ "tacit-native-owner-v1") and its spend
// nullifier is keccak(nk ‖ leaf ‖ "tacit-native-nullifier-v1"). The guest enforces both; the client
// derives both. If the two implementations disagree, the client mints notes the guest cannot spend —
// unrecoverable, because the vkey is immutable.
//
// The SAME vectors are asserted in cxfer-core's `nk_js_parity` module, so changing either definition
// fails one of the two suites rather than silently stranding funds.
import { test } from 'node:test';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const NK = '0x' + '44'.repeat(32);
const LEAF = '0x' + 'ab'.repeat(32);
// Produced by cxfer-core (the guest), not by this file — see cxfer-core `nk_js_parity`.
const OWNER = '0x7fd55ff71cacdf099469ed8014a33cbcfd9a8cef4033c719001502c643b1f1a2';
const NU = '0x6ee2cfe444b10301ff676f9011c633d9811584ef1742f7c397b4d4183c058bb8';

test('nkToOwner matches the guest', () => {
  assert.equal(String(pool.nkToOwner(NK)).toLowerCase(), OWNER);
});

test('nativeNullifier matches the guest', () => {
  assert.equal(String(pool.nativeNullifier(NK, LEAF)).toLowerCase(), NU);
});

test('owner is per-note: a different nk gives a different published owner', () => {
  // Why this matters: owner rides in the public leaf. A wallet-wide nk would publish one constant
  // owner across every note the wallet holds, making them all linkable on-chain — which is the
  // property the scheme exists to prevent. nk must therefore be derived per note.
  const other = '0x' + '45'.repeat(32);
  assert.notEqual(String(pool.nkToOwner(NK)), String(pool.nkToOwner(other)));
});

test('nullifier binds the leaf: same nk, different notes give different nullifiers', () => {
  const otherLeaf = '0x' + 'cd'.repeat(32);
  assert.notEqual(String(pool.nativeNullifier(NK, LEAF)), String(pool.nativeNullifier(NK, otherLeaf)));
});
