#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC variant-0 T_LP_ADD (0x2D) that takes the REFUND path:
// the LP's signed `share_amount` floor is above what the current reserves would mint (a sandwich), so the fold
// returns delta_a / delta_b as two owner-bound notes at the refund outputs (vout 1/2) and leaves the pool
// UNCHANGED — instead of self-burning the two funding notes. Exercises the guest↔JS digest parity of the refund
// branch (two-path witness, formed refund notes, reserves untouched). A sibling expired-path vector flips only
// the expiry vs height. Box run gates it as DIGEST_MATCH.
//   node tests/gen-reflection-lp-add-refund-synth.mjs > /tmp/lp-add-refund-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';
import { lpAddKernelSig } from './_swapvar-kernel.mjs';

const MODE = process.argv[2] === '--expired' ? 'expired' : 'sandwich';
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
const deltaA = 100000n, deltaB = 200000n;
const rA = 0xAA03n, rB = 0xBB03n, shareR = 0x5757n;
// sandwich: floor = minted + 1 (unreachable). expired: floor satisfiable but expiry < height.
const EXPIRY = MODE === 'expired' ? BLOCK_HEIGHT - 10 : BLOCK_HEIGHT + 1000;
const REFUND_A_XONLY = '31'.repeat(32), REFUND_B_XONLY = '32'.repeat(32);
const rRefA = 0x4141n, rRefB = 0x4242n;
const refABlindHex = '0x' + Buffer.from(be(rRefA, 32)).toString('hex');
const refBBlindHex = '0x' + Buffer.from(be(rRefB, 32)).toString('hex');

const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, feeBps, 0, PROTO_FEE_ADDR, protocolFeeBps);
const minted = pool.lpAddShares(totalShares, deltaA, deltaB, reserveA, reserveB); // 100000
const floor = MODE === 'expired' ? minted : minted + 1n; // sandwich: unreachable floor; expired: satisfiable
const cAxy = pool.commitXY(deltaA, rA), cBxy = pool.commitXY(deltaB, rB);
const shareXY = pool.commitXY(floor, shareR);
const shareCsecp = pool.compressXY(shareXY.cx, shareXY.cy);
const seedTxidA = Buffer.alloc(32, 0x2c), seedTxidB = Buffer.alloc(32, 0x2d);
const kernelA = lpAddKernelSig({ variant: 0, poolIdHex: poolId, assetXHex: ASSET_A, deltaX: deltaA, shareAmount: floor, shareCsecpHex: shareCsecp, inputs: [['0x' + seedTxidA.toString('hex'), 0]], expiryHeight: EXPIRY, refundXonlyHex: '0x' + REFUND_A_XONLY, refundBlindingHex: refABlindHex }, rA);
const kernelB = lpAddKernelSig({ variant: 0, poolIdHex: poolId, assetXHex: ASSET_B, deltaX: deltaB, shareAmount: floor, shareCsecpHex: shareCsecp, inputs: [['0x' + seedTxidB.toString('hex'), 0]], expiryHeight: EXPIRY, refundXonlyHex: '0x' + REFUND_B_XONLY, refundBlindingHex: refBBlindHex }, rB);

const envelope = cat([
  [0x2D], [0x00], hb(ASSET_A), hb(ASSET_B), u64le(deltaA), u64le(deltaB), u64le(floor),
  hb(shareCsecp), Buffer.alloc(32), Buffer.alloc(169), Buffer.from(kernelA), Buffer.from(kernelB),
  be(shareR, 32), u32le(EXPIRY), be(rRefA, 32), be(rRefB, 32),
]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inA = cat([seedTxidA, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const inB = cat([seedTxidB, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const wit1 = cat([[0x01], [0x40], Buffer.alloc(0x40)]);
const SHARE_XONLY = 'e0'.repeat(32);
const p2trOut = (xonlyHex) => cat([u64le(0), [0x22], [0x51, 0x20], Buffer.from(xonlyHex, 'hex')]);
// vout 0 = share dest (unused on the refund path), vout 1/2 = the refund notes' destinations.
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(2), inA, inB, [0x03], p2trOut(SHARE_XONLY), p2trOut(REFUND_A_XONLY), p2trOut(REFUND_B_XONLY), wit0, wit1, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header_blk = mineHeader(computeMerkleRoot([cbTxid, txid]));

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: totalShares.toString(), c0Backed: true, feeBps, protocolFeeBps: 0, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '0' }]);
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
    shareAmount: floor.toString(), shareCsecp, shareR: '0x' + Buffer.from(be(shareR, 32)).toString('hex'),
    kernelSigA: '0x' + Buffer.from(kernelA).toString('hex'), kernelSigB: '0x' + Buffer.from(kernelB).toString('hex'),
    feeBps, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps,
    expiryHeight: EXPIRY, refundABlinding: refABlindHex, refundBBlinding: refBBlindHex,
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header_blk).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, coords);

const la = input.blocks[0].txs[1].lpAdd;
const p = state.pools.get(poolId);
const unchanged = BigInt(p.reserveA) === reserveA && BigInt(p.reserveB) === reserveB && BigInt(p.totalShares) === totalShares;
// The two FORMED refund notes (delta_a / delta_b under the on-chain blindings) at the vout-1/2 x-only keys.
const refALeaf = pool.btcNoteLeaf(ASSET_A, pool.commitXY(deltaA, rRefA).cx, pool.commitXY(deltaA, rRefA).cy, '0x' + REFUND_A_XONLY);
const refBLeaf = pool.btcNoteLeaf(ASSET_B, pool.commitXY(deltaB, rRefB).cx, pool.commitXY(deltaB, rRefB).cy, '0x' + REFUND_B_XONLY);
const leaves = state._acc.notes.leaves.map((l) => pool.hx(l).toLowerCase());
const bothRefunds = leaves.includes(refALeaf.toLowerCase()) && leaves.includes(refBLeaf.toLowerCase());
console.error(`lp_add v0 REFUND(${MODE}): minted=${minted} floor=${floor} unchanged=${unchanged} bothRefunds=${bothRefunds} twoPaths=${!!(la && la.path0 && la.path1)} newDigest=${input.newDigest}`);
if (!unchanged || !bothRefunds || !(la && la.path0 && la.path1)) { console.error('FATAL: variant-0 refund did not onboard both refund notes / left reserves untouched'); process.exit(1); }
console.log(JSON.stringify(input));
