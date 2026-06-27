#!/usr/bin/env node
// Focused reflection fixture for the trustless HARVEST fold (0x3B, 346B) — the owner-authorized reward
// materialization in isolation (the farm-lifecycle fixture covers harvest+unbond together; this pins harvest
// alone). The bond receipt R0 is pre-seeded in the prior note tree; the SPEND is gated by a BIP-340 sig under
// the receipt's one-time owner pubkey over the materialized reward note's blinding (reward_r) AND its vout[1]
// destination scriptPubKey (the front-run-resistant dest binding). fold_lp_harvest verifies the receipt +
// bounds reward ≤ shares·(rps−rps_entry); fold_harvest materializes the reward note (vout 1) + DEBITS the
// C0-backed treasury. The guest must land on the JS assembler's newDigest — the reflect-exec guest↔JS
// digest-parity check for the harvest fold. Replaces the prior stale 226-byte (worker-protocol) envelope,
// which the current guest (parse_lp_harvest_envelope requires 346) + dapp classifier no longer accept.
//   node tests/gen-reflection-harvest-synth.mjs > /tmp/harvest-reflect-input.json

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
const u128le = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const HARVEST_DOM = new TextEncoder().encode('tacit-farm-harvest-owner-v1');

const FARM_ID = '0x' + '44'.repeat(32), REWARD_ASSET = '0x' + 'c3'.repeat(32);
const NONCE0 = '0x' + '01'.repeat(32), NONCE1 = '0x' + '02'.repeat(32);
const LAUNCHER_PUB = '0x02' + 'aa'.repeat(32), LP_ASSET = '0x' + 'a5'.repeat(32);
const SHARES = 100, RATE = 100, TREASURY = 1_000_000n, REWARD = 250, REWARD_R = 0xF00Dn;
const BLOCK_HEIGHT = 312500, GAP = 10; // bond seeded GAP blocks ago ⇒ rps = RATE·GAP·2^64/SHARES

// One-time receipt owner; OWNER_PRIV signs the harvest spend.
const OWNER_PRIV = be('0x0a0b0c0d0e0f0102030405060708090a0b0c0d0e0f01020304050607080900aa', 32);
const OWNER = hx(G.multiply(BigInt(hx(OWNER_PRIV))).toRawBytes(true).slice(1)); // x-only (32 bytes)
const ENTRY0 = 0n;
const R0 = pool.farmReceiptLeaf(FARM_ID, SHARES, ENTRY0, OWNER, NONCE0);

const REWARD_SPK = cat([[0x00, 0x14], Buffer.alloc(20, 0x9d)]); // vout[1] reward destination the owner sig binds
const harvestMsg = keccak_256(cat([HARVEST_DOM, hb(FARM_ID), hb(R0), be(REWARD, 8), be(REWARD_R, 32), REWARD_SPK]));
const harvesterSig = signSchnorr(harvestMsg, OWNER_PRIV);

// 0x3B harvest (346): op ‖ farm_id ‖ bond_id(36) ‖ pubkey(33) ‖ exit_acc(16) ‖ view_h(4) ‖ reward(8) ‖
//   reward_r(32) ‖ owner(32) ‖ old_nonce(32) ‖ new_nonce(32) ‖ shares(8) ‖ rps_entry(16) ‖ harvester_sig(64)
const harvestEnv = cat([[0x3B], hb(FARM_ID), Buffer.alloc(36), Buffer.alloc(33), Buffer.alloc(16), Buffer.alloc(4),
  u64le(REWARD), be(REWARD_R, 32), hb(OWNER), hb(NONCE0), hb(NONCE1), u64le(SHARES), u128le(ENTRY0), harvesterSig]);
if (harvestEnv.length !== 346) { console.error(`FATAL: harvest envelope length ${harvestEnv.length} (want 346)`); process.exit(1); }

const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([harvestEnv.length & 0xff, (harvestEnv.length >> 8) & 0xff]), harvestEnv, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0xd1);
const inputs = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
// vout[0] = value-0 envelope marker (empty spk); vout[1] = the materialized reward note destination (REWARD_SPK).
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputs,
  [0x02], Buffer.alloc(8), [0x00], Buffer.alloc(8), varint(REWARD_SPK.length), REWARD_SPK, wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// prior: resume the registered farm (rps advanced by GAP) + the C0-backed treasury pool + the bond receipt R0.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.farmRewards.load([{ farmId: FARM_ID, rate: String(RATE), totalShares: String(SHARES), rps: '0', lastHeight: String(BLOCK_HEIGHT - GAP), launcherPubkey: LAUNCHER_PUB, lpAsset: LP_ASSET }]);
state.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: '0x' + '00'.repeat(32), reserveA: TREASURY.toString(), reserveB: '0', totalShares: '0', c0Backed: true, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);
state._acc.notes.insert(R0);

const txSpec = {
  txData: '0x' + tx.toString('hex'), txid: hx(txid), vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'harvest', farmId: FARM_ID, shares: SHARES, rpsEntry: ENTRY0.toString(), owner: OWNER, oldNonce: NONCE0, newNonce: NONCE1, amount: REWARD.toString(), r: hx(be(REWARD_R, 32)), harvesterSig: hx(harvesterSig) },
};
const treasury0 = BigInt(state.pools.get(FARM_ID).reserveA);
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, new Map());

const hv = input.blocks[0].txs[1].harvest;
const treasuryPost = BigInt(state.pools.get(FARM_ID).reserveA);
console.error(`harvest (346B trustless): reward=${REWARD} treasury ${treasury0}->${treasuryPost} folded=${!!(hv && hv.spentInsert)} newDigest=${input.newDigest}`);
// Anti-false-pass: the harvest must ACTUALLY materialize — the C0-backed treasury debited by exactly REWARD
// (read from state, not computed) AND the old receipt nullified. A skip (e.g. a stale envelope the guest
// rejects) leaves the treasury untouched and would digest-match trivially.
if (treasuryPost !== treasury0 - BigInt(REWARD)) {
  console.error(`FATAL: harvest did NOT debit the treasury by ${REWARD} (fold skipped — would be a both-skip false pass)`); process.exit(1);
}
if (!hv || !hv.spentInsert) { console.error('FATAL: harvest receipt was not nullified (owner-sig / gate failed)'); process.exit(1); }
console.log(JSON.stringify(input));
