#!/usr/bin/env node
// Focused reflection fixture for the launcher-authorized FARM-REFUND fold (T_FARM_REFUND 0x3E, 174B). The farm
// launcher reclaims unspent treasury post-grace: the envelope carries a public-r refund note (same shape as a
// harvest reward) so fold_farm_refund reuses fold_harvest to mint it at vout[1] + DEBIT the C0-backed treasury.
// The draw is gated IN-GUEST: the envelope's launcher_pubkey must equal the one bound at FARM_INIT (stored in
// farm_rewards) AND a BIP-340 sig under it over farm_refund_msg(farm, amount, r, view_height, dest_spk) must
// verify — the dest_spk (vout[1] scriptPubKey) binding stops a front-runner replaying the public envelope to
// redirect the treasury draw to their own UTXO. The guest must land on the JS assembler's newDigest.
//   node tests/gen-reflection-farmrefund-synth.mjs > /tmp/farmrefund-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { signSchnorr, G } from '../dapp/bulletproofs.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const FARM_REFUND_DOM = new TextEncoder().encode('tacit-amm-farm-refund-v1');

const FARM_ID = '0x' + '47'.repeat(32), REWARD_ASSET = '0x' + 'c3'.repeat(32);
const LP_ASSET = '0x' + 'a5'.repeat(32);
const SHARES = 100, RATE = 100, TREASURY = 1_000_000n;
const REFUND = 4000, REFUND_R = 0xFEEDn, REFUND_VIEW_H = 312700;
const BLOCK_HEIGHT = 312800, GAP = 10;

// The farm LAUNCHER: a real secp key whose COMPRESSED pubkey is bound at FARM_INIT (launcher_pubkey, 33B); the
// guest verifies a BIP-340 sig over its x-only half (launcher_pubkey[1..33]).
const LAUNCHER_PRIV = be('0x1112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30', 32);
const LAUNCHER_PUB = hx(G.multiply(BigInt(hx(LAUNCHER_PRIV))).toRawBytes(true)); // compressed (33B)

// vout[1] refund destination scriptPubKey the launcher sig binds (P2WPKH-shaped).
const REFUND_SPK = cat([[0x00, 0x14], Buffer.alloc(20, 0x9f)]);
const refundMsg = keccak_256(cat([FARM_REFUND_DOM, hb(FARM_ID), be(REFUND, 8), be(REFUND_R, 32), be(REFUND_VIEW_H, 4), REFUND_SPK]));
const launcherSig = signSchnorr(refundMsg, LAUNCHER_PRIV);

// 0x3E refund (174): op ‖ farm_id(32) ‖ launcher_pubkey(33) ‖ refund_amount(8 LE) ‖ refund_view_height(4 LE) ‖
//   refund_r(32) ‖ launcher_sig(64)
const refundEnv = cat([[0x3E], hb(FARM_ID), hb(LAUNCHER_PUB), u64le(REFUND), u32le(REFUND_VIEW_H), be(REFUND_R, 32), launcherSig]);
if (refundEnv.length !== 174) { console.error(`FATAL: refund envelope length ${refundEnv.length} (want 174)`); process.exit(1); }

const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([refundEnv.length & 0xff, (refundEnv.length >> 8) & 0xff]), refundEnv, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0xe3);
const inputs = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
// vout[0] = value-0 envelope marker (empty spk); vout[1] = the materialized refund note destination (REFUND_SPK).
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputs,
  [0x02], Buffer.alloc(8), [0x00], Buffer.alloc(8), varint(REFUND_SPK.length), REFUND_SPK, wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// prior: resume the registered farm (launcher_pubkey + lp_asset bound) + the C0-backed treasury pool.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.farmRewards.load([{ farmId: FARM_ID, rate: String(RATE), totalShares: String(SHARES), rps: '0', lastHeight: String(BLOCK_HEIGHT - GAP), launcherPubkey: LAUNCHER_PUB, lpAsset: LP_ASSET }]);
state.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: '0x' + '00'.repeat(32), reserveA: TREASURY.toString(), reserveB: '0', totalShares: '0', c0Backed: true, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);

const txSpec = {
  txData: '0x' + tx.toString('hex'), txid: hx(txid), vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'farm_refund', farmId: FARM_ID, launcherPubkey: LAUNCHER_PUB, amount: REFUND.toString(), refundViewHeight: REFUND_VIEW_H, r: hx(be(REFUND_R, 32)), launcherSig: hx(launcherSig) },
};
const treasury0 = BigInt(state.pools.get(FARM_ID).reserveA);
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, new Map());

const fr = input.blocks[0].txs[1].farmRefund;
const treasuryPost = BigInt(state.pools.get(FARM_ID).reserveA);
const noteCountPost = state._acc.notes.leaves.length;
console.error(`farm-refund (174B launcher-auth): refund=${REFUND} treasury ${treasury0}->${treasuryPost} notes=${noteCountPost} newDigest=${input.newDigest}`);
// Anti-false-pass: the refund must ACTUALLY materialize — the C0-backed treasury debited by exactly REFUND
// (read from state, not computed) AND the refund note appended. A skip (e.g. a bad launcher sig / wrong length
// the guest rejects) leaves the treasury + note tree untouched and would digest-match trivially.
if (treasuryPost !== treasury0 - BigInt(REFUND)) {
  console.error(`FATAL: farm-refund did NOT debit the treasury by ${REFUND} (fold skipped — would be a both-skip false pass)`); process.exit(1);
}
if (noteCountPost !== 1) {
  console.error(`FATAL: refund note was not appended to the note tree (got ${noteCountPost} leaves, want 1)`); process.exit(1);
}
console.log(JSON.stringify(input));
