#!/usr/bin/env node
// Trustless farm lifecycle reflection fixture — COVERS THE n_farms≥1 RESUME PATH. The prior state carries a
// registered farm WITH launcher_pubkey + lp_asset (the fields the guest reads on resume, reflect.rs:206-207),
// so the reflect-exec digest-match exercises the farm-resume handoff framing (a regression there bricks the
// forward-only digest). A single block then does an owner-authorized HARVEST (0x3B, 346B) → UNBOND (0x36, 217B):
//   • the bond receipt R0 is pre-seeded in the prior note tree (harvest proves its membership);
//   • the SPEND is gated by a BIP-340 sig under the receipt's one-time owner pubkey over the materialized note's
//     blinding (reward_r / lp_return_r) — the public preimage gates membership, the sig gates the spend;
//   • unbond nullifies R1, drops shares, and re-mints the bonded LP-shares as a live lp_asset note (lp-return).
//   node tests/gen-reflection-farm-lifecycle-synth.mjs > contracts/sp1/confidential/fixtures/reflection_farm_lifecycle.json
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { signSchnorr, G } from '../dapp/bulletproofs.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128le = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const HARVEST_DOM = new TextEncoder().encode('tacit-farm-harvest-owner-v1');
const UNBOND_DOM = new TextEncoder().encode('tacit-farm-unbond-owner-v1');

const FARM_ID = '0x' + '44'.repeat(32), REWARD_ASSET = '0x' + 'c3'.repeat(32);
const NONCE0 = '0x' + '01'.repeat(32), NONCE1 = '0x' + '02'.repeat(32);
const LAUNCHER_PUB = '0x02' + 'aa'.repeat(32); // 33-byte launcher pubkey carried in the resumed prior state
const LP_ASSET = '0x' + 'a5'.repeat(32);       // the farm's lp_asset (resumed; the unbond re-mints it)
const SHARES = 100, RATE = 100, TREASURY = 1_000_000n, REWARD = 250, REWARD_R = 0xF00Dn, LP_RETURN_R = 0xBEEFn;
const BLOCK_HEIGHT = 311000, GAP = 10; // bond seeded GAP blocks ago ⇒ rps = RATE·GAP·2^64/SHARES = 10·2^64

// The receipt owner is a ONE-TIME x-only pubkey; OWNER_PRIV signs the harvest/unbond spend.
const OWNER_PRIV = be('0x0a0b0c0d0e0f0102030405060708090a0b0c0d0e0f01020304050607080900aa', 32);
const ownerComp = G.multiply(BigInt(hx(OWNER_PRIV))).toRawBytes(true);
const OWNER = hx(ownerComp.slice(1)); // x-only (32 bytes)

const ENTRY0 = 0n;
const ENTRY1 = pool.farmHarvestNewEntry(SHARES, ENTRY0, REWARD); // advanced entry after harvesting REWARD
const R0 = pool.farmReceiptLeaf(FARM_ID, SHARES, ENTRY0, OWNER, NONCE0);
const R1 = pool.farmReceiptLeaf(FARM_ID, SHARES, ENTRY1, OWNER, NONCE1);

const SALT_H = 0xd1, SALT_U = 0xd2;
const mkTx = (env, salt) => {
  const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([env.length & 0xff, (env.length >> 8) & 0xff]), env, [0x68]]);
  const dummyTxid = Buffer.alloc(32, salt);
  const inputs = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputs, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
  return { tx, txid: computeTxid(tx), dummyTxid };
};
// Owner BIP-340 auth binds the materialized note's BLINDING (reward_r / lp_return_r), not the outpoint (the
// reveal tx commits sha256(envelope), so the txid can't be known before signing). Mirror the guest msgs.
const harvestMsg = keccak_256(cat([HARVEST_DOM, hb(FARM_ID), hb(R0), be(REWARD, 8), be(REWARD_R, 32)]));
const unbondMsg = keccak_256(cat([UNBOND_DOM, hb(FARM_ID), hb(R1), be(SHARES, 8), be(LP_RETURN_R, 32)]));
const harvesterSig = signSchnorr(harvestMsg, OWNER_PRIV);
const unbonderSig = signSchnorr(unbondMsg, OWNER_PRIV);

// ── envelopes ──
// 0x3B harvest (346): op ‖ farm_id ‖ bond_id(36) ‖ pubkey(33) ‖ exit_acc(16) ‖ view_h(4) ‖ reward(8) ‖ reward_r(32)
//   ‖ owner(32) ‖ old_nonce(32) ‖ new_nonce(32) ‖ shares(8) ‖ rps_entry(16) ‖ harvester_sig(64)
const harvestEnv = cat([[0x3B], hb(FARM_ID), Buffer.alloc(36), Buffer.alloc(33), Buffer.alloc(16), Buffer.alloc(4),
  u64le(REWARD), be(REWARD_R, 32), hb(OWNER), hb(NONCE0), hb(NONCE1), u64le(SHARES), u128le(ENTRY0), harvesterSig]);
// 0x36 unbond (217): op ‖ farm_id ‖ owner(32) ‖ nonce(32) ‖ shares(8) ‖ rps_entry(16) ‖ lp_return_r(32) ‖ unbonder_sig(64)
const unbondEnv = cat([[0x36], hb(FARM_ID), hb(OWNER), hb(NONCE1), u64le(SHARES), u128le(ENTRY1), be(LP_RETURN_R, 32), unbonderSig]);
if (harvestEnv.length !== 346 || unbondEnv.length !== 217) { console.error(`FATAL: envelope length ${harvestEnv.length}/${unbondEnv.length} (want 346/217)`); process.exit(1); }

const h = mkTx(harvestEnv, SALT_H), u = mkTx(unbondEnv, SALT_U);
// BIP141 coinbase carrying the witness commitment, so the guest's witness-commitment gate authenticates the
// Taproot envelopes (witness_committed) and extracts/folds them.
const dsha = (b) => sha256(sha256(b));
const reserved = Buffer.alloc(32, 7);
const witnessRoot = computeMerkleRoot([Buffer.alloc(32), dsha(h.tx), dsha(u.tx)]);
const wcommit = dsha(cat([witnessRoot, reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
  [0x01], [0x20], reserved,
  Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const coinbaseSpec = { txData: '0x' + Buffer.from(coinbase).toString('hex'), txid: '0x' + Buffer.from(cbTxid).toString('hex'), vins: [], env: null };
const header = mineHeader(computeMerkleRoot([cbTxid, h.txid, u.txid]));

// ── prior: resume a registered farm (WITH launcher_pubkey + lp_asset) + the bond receipt R0 in the note tree ──
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.farmRewards.load([{ farmId: FARM_ID, rate: String(RATE), totalShares: String(SHARES), rps: '0', lastHeight: String(BLOCK_HEIGHT - GAP), launcherPubkey: LAUNCHER_PUB, lpAsset: LP_ASSET }]);
state.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: '0x' + '00'.repeat(32), reserveA: TREASURY.toString(), reserveB: '0', totalShares: '0', c0Backed: true, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);
state._acc.notes.insert(R0);

const txs = [
  { txData: '0x' + h.tx.toString('hex'), txid: hx(h.txid), vins: [{ prevTxid: '0x' + h.dummyTxid.toString('hex'), vout: 0 }],
    env: { type: 'harvest', farmId: FARM_ID, shares: SHARES, rpsEntry: ENTRY0.toString(), owner: OWNER, oldNonce: NONCE0, newNonce: NONCE1, amount: REWARD.toString(), r: hx(be(REWARD_R, 32)), harvesterSig: hx(harvesterSig) } },
  { txData: '0x' + u.tx.toString('hex'), txid: hx(u.txid), vins: [{ prevTxid: '0x' + u.dummyTxid.toString('hex'), vout: 0 }],
    env: { type: 'lp_unbond', farmId: FARM_ID, shares: SHARES, rpsEntry: ENTRY1.toString(), owner: OWNER, nonce: NONCE1, lpReturnR: hx(be(LP_RETURN_R, 32)), unbonderSig: hx(unbonderSig) } },
];
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, ...txs] }],
}, new Map());

const hv = input.blocks[0].txs[1].harvest, ub = input.blocks[0].txs[2].lpUnbond;
console.error(`resume n_farms=1 (launcher+lp_asset)  harvest folded=${!!(hv && hv.spentInsert)} (reward ${REWARD})  unbond folded=${!!(ub && ub.spentInsert)} (lp-return ${SHARES})  newDigest=${input.newDigest}`);
if (!hv || !ub) { console.error('FATAL: a farm fold bailed (owner-sig or gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
