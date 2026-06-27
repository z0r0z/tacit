#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC variant-0 T_LP_ADD (0x2D) — an LP-add to an EXISTING
// C0-backed pool (vs variant-1 POOL_INIT). The guest finds the pool by canonical-asset enumeration, grows its
// reserves + mints the proportional LP shares, and onboards the minted share note; the result MUST land on the
// JS assembler's newDigest — the reflect-exec guest↔JS digest-parity check for the variant-0 path (proportional
// share-mint amount + the share note opening), closing the gap left by the variant-1-only lp_add gen.
//   node tests/gen-reflection-lpadd-v0-synth.mjs > /tmp/lpadd-v0-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';
import { lpAddKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32); // a1 < b2 → canonical (A,B)
const PROTO_FEE_ADDR = '0x' + '00'.repeat(33), ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 316000;
const reserveA = 1000000n, reserveB = 2000000n, totalShares = 1000000n, feeBps = 0, protocolFeeBps = 0;
const deltaA = 100000n, deltaB = 200000n; // 10% proportional add
const rA = 0xAA02n, rB = 0xBB02n, shareR = 0x5656n;

const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, feeBps, 0, PROTO_FEE_ADDR, protocolFeeBps);
const lpShares = pool.lpAddShares(totalShares, deltaA, deltaB, reserveA, reserveB); // min(δa·S/Ra, δb·S/Rb) = 100000
const cAxy = pool.commitXY(deltaA, rA), cBxy = pool.commitXY(deltaB, rB);
const shareXY = pool.commitXY(lpShares, shareR);
const shareCsecp = pool.compressXY(shareXY.cx, shareXY.cy);
const seedTxidA = Buffer.alloc(32, 0x2a), seedTxidB = Buffer.alloc(32, 0x2b);
const kernelA = lpAddKernelSig({ variant: 0, poolIdHex: poolId, assetXHex: ASSET_A, deltaX: deltaA, shareAmount: lpShares, shareCsecpHex: shareCsecp, inputs: [['0x' + seedTxidA.toString('hex'), 0]] }, rA);
const kernelB = lpAddKernelSig({ variant: 0, poolIdHex: poolId, assetXHex: ASSET_B, deltaX: deltaB, shareAmount: lpShares, shareCsecpHex: shareCsecp, inputs: [['0x' + seedTxidB.toString('hex'), 0]] }, rB);

// 0x2D variant-0 envelope: 452-byte header ‖ share_r(32). No variant-1 tail. share_c_bjj + xcurve sigma zeroed.
const envelope = cat([
  [0x2D], [0x00], hb(ASSET_A), hb(ASSET_B), u64le(deltaA), u64le(deltaB), u64le(lpShares),
  hb(shareCsecp), Buffer.alloc(32), Buffer.alloc(169), Buffer.from(kernelA), Buffer.from(kernelB),
  be(shareR, 32),
]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inA = cat([seedTxidA, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const inB = cat([seedTxidB, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const wit1 = cat([[0x01], [0x00]]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(2), inA, inB, [0x01], Buffer.alloc(8), [0x00], wit0, wit1, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header_blk = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: the EXISTING C0-backed pool + the LP's two funding notes (live UTXOs of asset_a / asset_b).
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: totalShares.toString(), c0Backed: true, protocolFeeBps: 0, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '0' }]);
const coords = new Map();
for (const [txidBuf, xy, asset] of [[seedTxidA, cAxy, ASSET_A], [seedTxidB, cBxy, ASSET_B]]) {
  const op = pool.outpointKey('0x' + txidBuf.toString('hex'), 0);
  state.foldOutput(pool.leaf(asset, xy.cx, xy.cy, ZERO_OWNER), op, pool.commitmentHash(xy.cx, xy.cy), asset);
  coords.set(op.toLowerCase(), { cx: xy.cx, cy: xy.cy });
}

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxidA.toString('hex'), vout: 0 }, { prevTxid: '0x' + seedTxidB.toString('hex'), vout: 0 }],
  env: {
    type: 'lp_add', variant: 0, assetA: ASSET_A, assetB: ASSET_B, deltaA: deltaA.toString(), deltaB: deltaB.toString(),
    shareAmount: lpShares.toString(), shareCsecp, shareR: '0x' + Buffer.from(be(shareR, 32)).toString('hex'),
    kernelSigA: '0x' + Buffer.from(kernelA).toString('hex'), kernelSigB: '0x' + Buffer.from(kernelB).toString('hex'),
    feeBps, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps,
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header_blk).toString('hex')], blocks: [{ txs: [txSpec] }],
}, coords);

const la = input.blocks[0].txs[0].lpAdd;
const p = state.pools.get(poolId);
const grew = BigInt(p.reserveA) === reserveA + deltaA && BigInt(p.reserveB) === reserveB + deltaB && BigInt(p.totalShares) === totalShares + lpShares;
console.error(`lp_add v0: dA=${deltaA} dB=${deltaB} lpShares=${lpShares} grew=${grew} sharePath=${!!(la && la.sharePath)} reservesPost=A:${p.reserveA} B:${p.reserveB} S:${p.totalShares} newDigest=${input.newDigest}`);
if (!grew || !(la && la.sharePath)) { console.error('FATAL: variant-0 lp_add did not grow the pool / mint the share note — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
