#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_LP_HARVEST (0x3B) drawing a reward note from a
// SEEDED C0-backed farm treasury, so the reflection guest folds it (reward note onboarded + treasury
// debited) and MUST land on the JS assembler's newDigest — the reflect-exec guest↔JS digest-parity check
// for the harvest fold (T_FARM_REFUND 0x3E uses the SAME fold). The reward note is decree-minted: DERIVED
// from the PUBLIC (reward_amount, reward_r), so there is no input spend / kernel.
//   node tests/gen-reflection-harvest-synth.mjs > /tmp/harvest-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const REWARD_ASSET = '0x' + 'c3'.repeat(32), FARM_ID = '0x' + '44'.repeat(32);
const BLOCK_HEIGHT = 311000;
const treasury = 1000000n, rewardAmount = 25000n, rewardR = 0xF00Dn;

// 0x3B envelope (226 bytes): only farm_id / reward_amount / reward_r drive the fold; the rest are
// worker-fairness fields (zeroed). Layout: op ‖ farm_id(32) ‖ bond_id(36) ‖ harvester_pubkey(33) ‖
// exit_acc(16) ‖ exit_view_height(4) ‖ reward_amount(8 LE) ‖ reward_r(32) ‖ harvester_sig(64).
const envelope = cat([[0x3B], hb(FARM_ID), Buffer.alloc(36), Buffer.alloc(33), Buffer.alloc(16), Buffer.alloc(4), u64le(rewardAmount), be(rewardR, 32), Buffer.alloc(64)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0xdd); // a non-treasury input (no live-set hit)
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: a C0-backed farm treasury (a degenerate pool keyed by farm_id; asset_a = the reward asset).
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: '0x' + '00'.repeat(32), reserveA: treasury.toString(), reserveB: '0', totalShares: '0', c0Backed: true, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'harvest', farmId: FARM_ID, amount: rewardAmount.toString(), r: '0x' + Buffer.from(be(rewardR, 32)).toString('hex') },
};
const input = pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, new Map());

const hv = input.blocks[0].txs[0].harvest;
console.error(`harvest: reward=${rewardAmount} treasuryPost=${treasury - rewardAmount} folded=${!!hv} newDigest=${input.newDigest}`);
if (!hv) { console.error('FATAL: harvest was not folded (a gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
