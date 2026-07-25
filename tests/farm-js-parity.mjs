#!/usr/bin/env node
// JS↔Rust byte-parity for the fair-farm receipt primitives (cxfer-core farm_receipt_leaf /
// farm_receipt_nullifier / FarmRewardState / FarmRewardSet::root). Anchors printed from the Rust KAT inputs.
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let fails = 0;
const eq = (got, want, name) => { const ok = String(got).toLowerCase() === String(want).toLowerCase(); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${got}\n     want ${want}`}`); if (!ok) fails++; };

const farm = '0x' + '44'.repeat(32), lpAsset = '0x' + '00'.repeat(32);
const alice = '0x' + '0a'.repeat(32), nonce = '0x' + '01'.repeat(32);

// 1. receipt leaf (v3 — a stable position id, no rps_entry) + nullifier
const leaf = pool.farmReceiptLeaf(farm, lpAsset, 100, alice, nonce);
eq(leaf, '0xa9ff21b9e430c69c7f80303340151611064e6eca213160b88a5e9669369ab1ee', 'farm_receipt_leaf(farm44,lp0,shares100,alice,nonce01)');
eq(pool.farmReceiptNullifier(leaf), '0x66b837df8326854eb7a686829756855557b656a917f5c9bfd09901c7cba832f6', 'farm_receipt_nullifier');

// 2. rps accumulator: bond 100 @ rate 100, accrue to height 10 → rps = 10·2^64. The entry stamped at bond
// is the live rps (0 here); the reward debt it takes on is shares·entry = 0, so the whole emission is
// outstanding (= exactly what a launcher refund must reserve).
const set = pool.makeFarmRewardSet();
const st = { rate: 100n, totalShares: 0n, rps: 0n, totalRewardDebt: 0n, lastHeight: 0n };
set.accrue(st, 0);              // bond accrue (no-op at h0)
const entry = st.rps; st.totalShares += 100n; st.totalRewardDebt += 100n * entry; // bond
set.accrue(st, 10);            // accrue 10 blocks
eq(st.rps, '184467440737095516160', 'rps @ h10 after bond(100)');
eq(entry, '0', 'entry stamped at bond');
eq(st.totalRewardDebt, '0', 'reward debt taken on at bond');
eq((st.rps * st.totalShares - st.totalRewardDebt) / pool.FARM_RPS_PRECISION, '1000', 'exact outstanding entitlement');

// 3. FarmRewardSet root (1 entry: farm44, rate100, total100, rps0, debt0, last0)
const set2 = pool.makeFarmRewardSet();
set2.set(farm, { rate: 100n, totalShares: 100n, rps: 0n, totalRewardDebt: 0n, lastHeight: 0n });
eq(set2.root(), '0x010c47a3098cb9f81256b98cbee0b367d07cc99e927bebea3ffa598b8b6ee927', 'FarmRewardSet.root (1 entry)');

// 4. FarmEntrySet root (1 stamp: the receipt leaf above, entry rps 0) — the per-position checkpoint registry
// that replaced the in-leaf checkpoint; its root rides ScanReflection.digest().
const es = pool.makeFarmEntrySet();
es.stamp(leaf, 0n);
eq(es.root(), '0xfd4590f1a7d06be203e0050d65e6e53dac9160ca9f0566ce6072fca04c4d2cca', 'FarmEntrySet.root (1 stamp)');

console.log(fails ? `\n${fails} FAILED` : '\nall farm primitives byte-match Rust');
process.exit(fails ? 1 : 0);
