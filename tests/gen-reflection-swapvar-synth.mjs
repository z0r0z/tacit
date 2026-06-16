#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC swap_var (T_SWAP_VAR 0x32) against a SEEDED
// C0-backed pool, so the reflection guest folds it (receipt onboarded + reserves advanced) and MUST land
// on the JS assembler's newDigest — the reflect-exec guest<->JS digest-parity check for the swap_var fold
// AND the pool reserve update. Sentinel-change case: the taker's input == delta_in_total (no change), so
// the kernel verify-key is P = C_in − delta_in_total·H = r_in·G (sign with r_in).
//   node tests/gen-reflection-swapvar-synth.mjs > /tmp/swapvar-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), POOL_ID = '0x' + '99'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 310000;
const reserveA = 1000000n, reserveB = 2000000n, deltaIn = 1000n, deltaOut = 1990n;
const rIn = 0xAAA1n, rReceipt = 0xBBB2n;

// c_in = the taker's input note (= exactly delta_in → sentinel, no change); c_receipt opens to delta_out.
const cInXY = pool.commitXY(deltaIn, rIn);
const cIn = pool.compressXY(cInXY.cx, cInXY.cy);
const cReceiptXY = pool.commitXY(deltaOut, rReceipt);
const cReceipt = pool.compressXY(cReceiptXY.cx, cReceiptXY.cy);
const SENTINEL = Buffer.alloc(33);
const seedTxid = Buffer.alloc(32, 0x77), seedVout = 0;

// delta_in_total = delta_in (tip 0); sentinel change → verify key P = C_in − delta_in·H = r_in·G.
const kernelSig = swapVarKernelSig({ assetHex: ASSET_A, txidHex: '0x' + seedTxid.toString('hex'), vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: deltaIn, rIn });

// T_SWAP_VAR envelope (rp_len = 0; layout per parse_swap_var_envelope).
const envelope = cat([
  [0x32], hb(POOL_ID), [0x00],
  u64le(reserveA), u64le(reserveB),
  u64le(deltaIn), u64le(0), u64le(0),
  u64le(deltaOut), u64le(0),
  u64le(0), [0x00], u32le(0),
  Buffer.alloc(33),                                  // trader_pubkey (unused by the fold)
  hb(cIn), SENTINEL, hb(cReceipt), be(rReceipt, 32),
  u16le(0),                                          // rp_len = 0
  Buffer.from(kernelSig), Buffer.alloc(64),          // kernel_sig, intent_sig (dummy)
]);

const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: the C0-backed pool + the taker's input note c_in (a live UTXO of asset_a).
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: '1000', c0Backed: true, protocolFeeBps: 0, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '0' }]);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(ASSET_A, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), ASSET_A);
coords.set(inOutpoint.toLowerCase(), { cx: cInXY.cx, cy: cInXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: {
    type: 'swap_var', poolId: POOL_ID, direction: 0,
    rAPre: reserveA.toString(), rBPre: reserveB.toString(),
    deltaIn: deltaIn.toString(), tipAmount: '0', deltaOut: deltaOut.toString(),
    cIn, cChangeOrSentinel: '0x' + '00'.repeat(33), cReceipt,
    rReceipt: '0x' + Buffer.from(be(rReceipt, 32)).toString('hex'), kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
  },
};
const input = pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, coords);

const sv = input.blocks[0].txs[0].swapVar;
console.error(`swap_var: dIn=${deltaIn} dOut=${deltaOut} reservesPost=A:${reserveA + deltaIn} B:${reserveB - deltaOut} folded=${!!sv} newDigest=${input.newDigest}`);
if (!sv) { console.error('FATAL: swap_var was not folded (a gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
