#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_LP_REMOVE (0x2E): the LP burns one detected
// LP-share note (netting to share_amount under the share-burn kernel) and withdraws the proportional
// (delta_a, delta_b); the reflection guest onboards BOTH withdrawn notes + draws down reserves/shares, and
// MUST land on the JS assembler's newDigest — the reflect-exec guest↔JS digest-parity check for the lp_remove
// fold (canonical-pair pool lookup, multi-input share-burn kernel, two recv openings, reserve/share drawdown).
//   node tests/gen-reflection-lpremove-synth.mjs > /tmp/lpremove-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';
import { lpRemoveKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), POOL_ID = '0x' + '2e'.repeat(32); // a1 < b2 → canonical (A,B)
const ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 314000;
const reserveA = 1000000n, reserveB = 2000000n, totalShares = 1000000n, shareAmount = 100000n;
const deltaA = (reserveA * shareAmount) / totalShares, deltaB = (reserveB * shareAmount) / totalShares; // 100000, 200000
const rShare = 0x5151n, rRecvA = 0xA1A1n, rRecvB = 0xB2B2n;
const seedTxid = Buffer.alloc(32, 0x2e), seedVout = 0;

const lpAsset = pool.ammDeriveLpAssetId(POOL_ID);
const shareXY = pool.commitXY(shareAmount, rShare);            // the burned LP-share note (live)
const recvA = pool.compressXY(...Object.values(pool.commitXY(deltaA, rRecvA)));
const recvB = pool.compressXY(...Object.values(pool.commitXY(deltaB, rRecvB)));
const kernelSig = lpRemoveKernelSig({ poolIdHex: POOL_ID, shareAmount, deltaA, deltaB, recvAHex: recvA, recvBHex: recvB, lpOutpoints: [['0x' + seedTxid.toString('hex'), seedVout]] }, rShare);

// 0x2E envelope (623 bytes): op ‖ asset_a ‖ asset_b ‖ share_amount(8) ‖ delta_a(8) ‖ delta_b(8) ‖
// recv_a_secp(33) ‖ recv_a worker fields(32+169) ‖ recv_b_secp(33) ‖ recv_b worker fields(32+169) ‖
// kernel_sig(64) ‖ trailing(2). Only the fold-relevant fields are non-zero (the rest are worker range/sigma).
const envelope = cat([
  [0x2E], hb(ASSET_A), hb(ASSET_B), u64le(shareAmount), u64le(deltaA), u64le(deltaB),
  hb(recvA), Buffer.alloc(32), Buffer.alloc(169),
  hb(recvB), Buffer.alloc(32), Buffer.alloc(169),
  Buffer.from(kernelSig), Buffer.alloc(2),
]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: the C0-backed pool + the LP's burned LP-share note (a live UTXO of the pool's LP-share asset).
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: totalShares.toString(), c0Backed: true, protocolFeeBps: 0, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '0' }]);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(lpAsset, shareXY.cx, shareXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(shareXY.cx, shareXY.cy), lpAsset);
coords.set(inOutpoint.toLowerCase(), { cx: shareXY.cx, cy: shareXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: {
    type: 'lp_remove', assetA: ASSET_A, assetB: ASSET_B, shareAmount: shareAmount.toString(),
    deltaA: deltaA.toString(), deltaB: deltaB.toString(), recvASecp: recvA, recvBSecp: recvB,
    rRecvA: '0x' + Buffer.from(be(rRecvA, 32)).toString('hex'), rRecvB: '0x' + Buffer.from(be(rRecvB, 32)).toString('hex'),
    kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, coords);

const lr = input.blocks[0].txs[0].lpRemove;
const p = state.pools.get(POOL_ID);
console.error(`lp_remove: share=${shareAmount} dA=${deltaA} dB=${deltaB} folded=${!!lr} reservesPost=A:${p.reserveA} B:${p.reserveB} sharesPost=${p.totalShares} newDigest=${input.newDigest}`);
if (!lr) { console.error('FATAL: lp_remove was not folded (a gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
