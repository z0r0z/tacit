#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_LP_ADD / POOL_INIT (0x2D, variant 1): the LP's two
// detected per-asset spends seed a fresh pool, so the reflection guest inserts the pool at isqrt(Δa·Δb) shares,
// onboards the minted LP-share note, and MUST land on the JS assembler's newDigest — the reflect-exec guest↔JS
// digest-parity check for the lp_add fold (two per-asset kernels, pool_id derivation, founder-share math, the
// share-mint note). The minted LP-share = isqrt(Δa·Δb) − MINIMUM_LIQUIDITY.
//   node tests/gen-reflection-lp-poolinit-synth.mjs > /tmp/lp-poolinit-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';
import { lpAddKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32); // a1 < b2 → canonical (A,B)
const PROTO_FEE_ADDR = '0x' + '00'.repeat(33);
const BLOCK_HEIGHT = 315000;
const deltaA = 4000n, deltaB = 9000n, feeBps = 0, protocolFeeBps = 0; // isqrt(4000·9000)=6000 shares
const totalShares = pool.isqrt(deltaA * deltaB), lpShares = totalShares - pool.AMM_MINIMUM_LIQUIDITY; // 6000, 5000
const rA = 0xAA01n, rB = 0xBB01n, shareR = 0x5555n;
const seedTxidA = Buffer.alloc(32, 0x1a), seedTxidB = Buffer.alloc(32, 0x1b);

const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, feeBps, 0, PROTO_FEE_ADDR, protocolFeeBps);
const cAxy = pool.commitXY(deltaA, rA), cBxy = pool.commitXY(deltaB, rB);
const shareXY = pool.commitXY(lpShares, shareR);
const shareCsecp = pool.compressXY(shareXY.cx, shareXY.cy);
const kernelA = lpAddKernelSig({ variant: 1, poolIdHex: poolId, assetXHex: ASSET_A, deltaX: deltaA, shareAmount: lpShares, shareCsecpHex: shareCsecp, inputs: [['0x' + seedTxidA.toString('hex'), 0]] }, rA);
const kernelB = lpAddKernelSig({ variant: 1, poolIdHex: poolId, assetXHex: ASSET_B, deltaX: deltaB, shareAmount: lpShares, shareCsecpHex: shareCsecp, inputs: [['0x' + seedTxidB.toString('hex'), 0]] }, rB);

// 0x2D envelope: 452-byte header ‖ variant-1 tail. Only the fold-relevant fields are set; the BJJ commitment +
// cross-curve sigma + vk/ceremony/arbiter/launcher/meta tail bytes are zeroed (the reflection skips them).
const header = cat([
  [0x2D], [0x01], hb(ASSET_A), hb(ASSET_B), u64le(deltaA), u64le(deltaB), u64le(lpShares),
  hb(shareCsecp), Buffer.alloc(32), Buffer.alloc(169), Buffer.from(kernelA), Buffer.from(kernelB),
  be(shareR, 32), // option-a: share_r ON-CHAIN at offset 452 (before the variant-1 tail) — the guest parses it
]);
const tail = cat([u16le(feeBps), [0x00, 0x00, 0x00, 0x00, 0x00], hb(PROTO_FEE_ADDR), u16le(protocolFeeBps), [0x00, 0x00]]);
const envelope = cat([header, tail]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inA = cat([seedTxidA, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const inB = cat([seedTxidB, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const wit1 = cat([[0x01], [0x00]]); // vin1 witness: one empty item (dummy)
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(2), inA, inB, [0x01], Buffer.alloc(8), [0x00], wit0, wit1, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header_blk = mineHeader(computeMerkleRoot([cbTxid, txid]));

// Seed the prior: the LP's two funding notes (live UTXOs of asset_a / asset_b). No pool yet — POOL_INIT creates it.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const ZERO_OWNER = '0x' + '00'.repeat(32);
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
    type: 'lp_add', variant: 1, assetA: ASSET_A, assetB: ASSET_B, deltaA: deltaA.toString(), deltaB: deltaB.toString(),
    shareAmount: lpShares.toString(), shareCsecp, shareR: '0x' + Buffer.from(be(shareR, 32)).toString('hex'),
    kernelSigA: '0x' + Buffer.from(kernelA).toString('hex'), kernelSigB: '0x' + Buffer.from(kernelB).toString('hex'),
    feeBps, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps,
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header_blk).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, coords);

const la = input.blocks[0].txs[1].lpAdd;
const p = state.pools.get(poolId);
console.error(`lp_add POOL_INIT: dA=${deltaA} dB=${deltaB} shares=${totalShares} lpShares=${lpShares} folded=${!!la} pool=${p ? `A:${p.reserveA} B:${p.reserveB} S:${p.totalShares}` : '-'} newDigest=${input.newDigest}`);
if (!la) { console.error('FATAL: lp_add was not folded (a gate failed) — fixture would not validate'); process.exit(1); }
// Anti-false-pass: POOL_INIT must actually CREATE the pool (it didn't exist in the prior) with the expected
// reserves + shares. A both-skip would leave the registry empty and digest-match trivially.
if (!p || BigInt(p.reserveA) !== deltaA || BigInt(p.reserveB) !== deltaB || BigInt(p.totalShares) !== totalShares) {
  console.error('FATAL: POOL_INIT did not create the pool as expected (fold skipped — would be a both-skip false pass)'); process.exit(1);
}
console.log(JSON.stringify(input));
