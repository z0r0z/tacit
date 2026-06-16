#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_SWAP_ROUTE (0x33): the trader's single input note
// (A) flows through two SEEDED C0-backed pools (A→B via pool1, B→C via pool2) and lands as ONE receipt note
// (C), so the reflection guest validates the value chain + every hop's reserve floor, onboards the receipt,
// advances both pools' reserves, and MUST land on the JS assembler's newDigest — the reflect-exec guest↔JS
// digest-parity check for the swap_route fold. Sentinel change: C_in commits exactly hop-0's input.
//   node tests/gen-reflection-swaproute-synth.mjs > /tmp/swaproute-reflect-input.json

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
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const A = '0x' + 'a1'.repeat(32), B = '0x' + 'b2'.repeat(32), C = '0x' + 'c3'.repeat(32); // A < B < C
const PROTO = '0x' + '00'.repeat(33), ZERO_OWNER = '0x' + '00'.repeat(32), SENTINEL = Buffer.alloc(33);
const BLOCK_HEIGHT = 316000;
const inMag = 1000n, midMag = 1900n, outMag = 3600n;            // A→(1900 B)→(3600 C)
const p1A = 1000000n, p1B = 2000000n, p2A = 2000000n, p2B = 4000000n;
const rIn = 0x303n, rReceipt = 0x707n;
const seedTxid = Buffer.alloc(32, 0x33), seedVout = 0;

const pool1Id = pool.ammDerivePoolIdFull(A, B, 0, 0, PROTO, 0); // (A,B)
const pool2Id = pool.ammDerivePoolIdFull(B, C, 0, 0, PROTO, 0); // (B,C)
const cInXY = pool.commitXY(inMag, rIn);                         // trader's input = exactly inMag of A
const cIn = pool.compressXY(cInXY.cx, cInXY.cy);
const cReceipt = pool.compressXY(...Object.values(pool.commitXY(outMag, rReceipt)));
const kernelSig = swapVarKernelSig({ assetHex: A, txidHex: '0x' + seedTxid.toString('hex'), vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: inMag, rIn });

const hop = (pidHex, dir, rA, rB, dA, dB) => cat([hb(pidHex), [dir], u16le(0), u64le(rA), u64le(rB), u64le(dA), u64le(dB)]); // 67 bytes
// 0x33 envelope: op ‖ n_hops ‖ in_asset ‖ out_asset ‖ min_out(8) ‖ expiry(4) ‖ trader_pubkey(33) ‖ hops ‖
// trader_input_outpoint(36) ‖ c_in(33) ‖ c_receipt(33) ‖ r_receipt(32) ‖ rp_len(2)=1 ‖ range_proof(1) ‖
// kernel_sig(64) ‖ intent_sig(64).
const envelope = cat([
  [0x33], [0x02], hb(A), hb(C), u64le(0), u32le(0), Buffer.alloc(33),
  hop(pool1Id, 0, p1A, p1B, inMag, midMag),    // A→B
  hop(pool2Id, 0, p2A, p2B, midMag, outMag),   // B→C
  seedTxid, u32le(seedVout),                    // trader_input_outpoint (fold uses the detected spend, not this)
  hb(cIn), hb(cReceipt), be(rReceipt, 32),
  u16le(1), Buffer.alloc(1), Buffer.from(kernelSig), Buffer.alloc(64),
]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: two C0-backed pools + the trader's input note (a live UTXO of A).
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([
  { poolId: pool1Id, assetA: A, assetB: B, reserveA: p1A.toString(), reserveB: p1B.toString(), totalShares: '1000', c0Backed: true, protocolFeeBps: 0, kLast: (p1A * p1B).toString(), protocolFeeAccrued: '0' },
  { poolId: pool2Id, assetA: B, assetB: C, reserveA: p2A.toString(), reserveB: p2B.toString(), totalShares: '1000', c0Backed: true, protocolFeeBps: 0, kLast: (p2A * p2B).toString(), protocolFeeAccrued: '0' },
]);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(A, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), A);
coords.set(inOutpoint.toLowerCase(), { cx: cInXY.cx, cy: cInXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: {
    type: 'swap_route', traderInputAsset: A, traderOutputAsset: C,
    hops: [
      { poolId: pool1Id, direction: 0, rAPre: p1A.toString(), rBPre: p1B.toString(), deltaANetMag: inMag.toString(), deltaBNetMag: midMag.toString() },
      { poolId: pool2Id, direction: 0, rAPre: p2A.toString(), rBPre: p2B.toString(), deltaANetMag: midMag.toString(), deltaBNetMag: outMag.toString() },
    ],
    cIn, cReceipt, rReceipt: '0x' + Buffer.from(be(rReceipt, 32)).toString('hex'), kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, coords);

const rt = input.blocks[0].txs[0].swapRoute;
const p1 = state.pools.get(pool1Id), p2 = state.pools.get(pool2Id);
console.error(`swap_route: ${inMag}A→${midMag}B→${outMag}C folded=${!!rt} pool1=A:${p1.reserveA} B:${p1.reserveB} pool2=B:${p2.reserveA} C:${p2.reserveB} newDigest=${input.newDigest}`);
if (!rt) { console.error('FATAL: swap_route was not folded (a gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
