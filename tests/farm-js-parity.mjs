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

const farm = '0x' + '44'.repeat(32), alice = '0x' + '0a'.repeat(32), nonce = '0x' + '01'.repeat(32);

// 1. receipt leaf + nullifier
const leaf = pool.farmReceiptLeaf(farm, 100, 0n, alice, nonce);
eq(leaf, '0xa9a1a72e57bb86f2f1b8b2772a4968b6e5d12e81e3ed2e732423e5c040e4213a', 'farm_receipt_leaf(farm44,shares100,rps0,alice,nonce01)');
eq(pool.farmReceiptNullifier(leaf), '0x9247c6895d378bd442b262ba0dab08f4cc627d104ab523198c026dc3c38ed6ff', 'farm_receipt_nullifier');

// 2. rps accumulator: bond 100 @ rate 100, accrue to height 10 → rps = 10·2^64; new_entry(250) = 2.5·2^64
const set = pool.makeFarmRewardSet();
const st = { rate: 100n, totalShares: 0n, rps: 0n, lastHeight: 0n };
set.accrue(st, 0);              // bond accrue (no-op at h0)
const entry = st.rps; st.totalShares += 100n; // bond
set.accrue(st, 10);            // accrue 10 blocks
eq(st.rps, '184467440737095516160', 'rps @ h10 after bond(100)');
eq(entry, '0', 'rps_entry at bond');
eq(pool.farmHarvestNewEntry(100, 0n, 250), '46116860184273879040', 'new_entry(shares100,e0,rew250)');

// 3. FarmRewardSet root (1 entry: farm44, rate100, total100, rps0, last0)
const set2 = pool.makeFarmRewardSet();
set2.set(farm, { rate: 100n, totalShares: 100n, rps: 0n, lastHeight: 0n });
eq(set2.root(), '0x76a92b7ba79b80e766cc361a544f08e16c71befefe06c8c971fc63fb1587e663', 'FarmRewardSet.root (1 entry)');

console.log(fails ? `\n${fails} FAILED` : '\nall farm primitives byte-match Rust');
process.exit(fails ? 1 : 0);
