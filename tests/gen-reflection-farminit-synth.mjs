#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_FARM_INIT (0x34): the launcher's single detected
// reward-asset spend funds a farm treasury under the swap-shape kernel, so the reflection guest registers the
// farm (a degenerate pool keyed by farm_id) and MUST land on the JS assembler's newDigest — the reflect-exec
// guest↔JS digest-parity check for the farm-init fold (incl. amm_derive_farm_id + the funding kernel). No note
// is onboarded (the treasury is virtual), so there is no note-path witness. Sentinel change: funding == reward_total.
//   node tests/gen-reflection-farminit-synth.mjs > /tmp/farminit-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const POOL_ID = '0x' + '77'.repeat(32), FARM_NONCE = '0x' + '01'.repeat(32);
const LAUNCHER_PUBKEY = '0x02' + 'ab'.repeat(32), REWARD_ASSET = '0x' + 'c3'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32), SENTINEL = Buffer.alloc(33);
const BLOCK_HEIGHT = 313000;
const rewardTotal = 500000n, rIn = 0xBEEFn;
const seedTxid = Buffer.alloc(32, 0x88), seedVout = 0;

// The launcher's funding note (= exactly reward_total → sentinel change); kernel P = C_in − reward_total·H = r_in·G.
const cInXY = pool.commitXY(rewardTotal, rIn);
const kernelSig = swapVarKernelSig({ assetHex: REWARD_ASSET, txidHex: '0x' + seedTxid.toString('hex'), vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: rewardTotal, rIn });

// 0x34 envelope (rp_len = 0): op ‖ pool_id ‖ farm_nonce ‖ launcher_pubkey(33) ‖ reward_asset ‖ reward_total(8) ‖
// 16 worker-config bytes ‖ c_change_or_sentinel(33) ‖ rp_len(2)=0 ‖ kernel_sig(64) ‖ launcher_sig(64).
const envelope = cat([
  [0x34], hb(POOL_ID), hb(FARM_NONCE), hb(LAUNCHER_PUBKEY), hb(REWARD_ASSET), u64le(rewardTotal),
  Buffer.alloc(8), Buffer.alloc(4), Buffer.alloc(4), SENTINEL, u16le(0), Buffer.from(kernelSig), Buffer.alloc(64),
]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: the launcher's funding note (a live UTXO of the reward asset). No farm yet — farm-init creates it.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(REWARD_ASSET, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), REWARD_ASSET);
coords.set(inOutpoint.toLowerCase(), { cx: cInXY.cx, cy: cInXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: {
    type: 'farm_init', poolId: POOL_ID, farmNonce: FARM_NONCE, launcherPubkey: LAUNCHER_PUBKEY, rewardAsset: REWARD_ASSET,
    rewardTotal: rewardTotal.toString(), cChangeOrSentinel: '0x' + '00'.repeat(33), kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
  },
};
const input = pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, coords);

const farmId = pool.ammDeriveFarmId(POOL_ID, LAUNCHER_PUBKEY, REWARD_ASSET, FARM_NONCE);
const farm = state.pools.get(farmId);
console.error(`farm-init: reward_total=${rewardTotal} registered=${!!farm} treasury=${farm ? farm.reserveA : '-'} newDigest=${input.newDigest}`);
if (!farm) { console.error('FATAL: farm was not registered (kernel/gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
