#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_PROTOCOL_FEE_CLAIM (0x31) against a SEEDED
// C0-backed pool with swap-driven k-growth, so the reflection guest crystallizes the protocol-fee skim,
// requires claim == accrued, onboards the claim note (an LP-share note), and MUST land on the JS assembler's
// newDigest — the reflect-exec guest↔JS digest-parity check for the protocol-fee-claim fold (exercises
// crystallize_protocol_fee / protocol_fee_shares / amm_derive_lp_asset_id). The claim note is decree-minted.
//   node tests/gen-reflection-protofee-synth.mjs > /tmp/protofee-reflect-input.json

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

const POOL_ID = '0x' + '31'.repeat(32), ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32);
const BLOCK_HEIGHT = 312000;
const reserveA = 2000n, reserveB = 2000n, sPre = 1000000n, kLast = 1000000n, feeBps = 30;
const claimBlinding = 0xABCDn;

// The accrued protocol-fee shares from k-growth (k_last 1e6 → k_now 4e6); the claim must equal them exactly.
const accrued = pool.protocolFeeShares(sPre, kLast, reserveA * reserveB, feeBps);
const { cx, cy } = pool.commitXY(accrued, claimBlinding);
const claimCSecp = pool.compressXY(cx, cy);

// 0x31 envelope (202 bytes): op ‖ pool_id(32) ‖ claimer_x_only(32) ‖ claim_amount(8 LE) ‖ claim_C_secp(33) ‖
// claim_blinding(32) ‖ claim_sig(64). The claimer x-only + sig are worker-fairness fields (zeroed).
const envelope = cat([[0x31], hb(POOL_ID), Buffer.alloc(32), u64le(accrued), hb(claimCSecp), be(claimBlinding, 32), Buffer.alloc(64)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0xee);
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// Seed the prior: a C0-backed pool with a protocol-fee tier + a stale k_last (so a claim crystallizes a skim).
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: sPre.toString(), c0Backed: true, protocolFeeBps: feeBps, kLast: kLast.toString(), protocolFeeAccrued: '0' }]);

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'protocol_fee_claim', poolId: POOL_ID, amount: accrued.toString(), cSecp: claimCSecp, blinding: '0x' + Buffer.from(be(claimBlinding, 32)).toString('hex') },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, new Map());

const pf = input.blocks[0].txs[0].protocolFee;
console.error(`protocol-fee claim: accrued=${accrued} folded=${!!pf} newDigest=${input.newDigest}`);
if (accrued === 0n) { console.error('FATAL: accrued is 0 — choose reserves with k-growth'); process.exit(1); }
if (!pf) { console.error('FATAL: protocol-fee claim was not folded (a gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
