#!/usr/bin/env node
// Trustless fair-farm lifecycle reflection fixture: a pre-seeded BOND (receipt note R0 in the prior note tree
// + farm accumulator), then a single block doing HARVEST (0x3B) → UNBOND (0x36). Exercises fold_lp_harvest
// (bound vs live rps, nullify R0, append advanced R1, mint reward) + fold_lp_unbond (nullify R1, drop shares),
// so the reflect-exec guest↔JS digest-parity check covers the trustless farm folds.
//   node tests/gen-reflection-farm-lifecycle-synth.mjs > /tmp/farm-lifecycle-input.json
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

const FARM_ID = '0x' + '44'.repeat(32), REWARD_ASSET = '0x' + 'c3'.repeat(32);
const OWNER = '0x' + '0a'.repeat(32), NONCE0 = '0x' + '01'.repeat(32), NONCE1 = '0x' + '02'.repeat(32);
const BONDER = '0x02' + 'bb'.repeat(32); // 33-byte pubkey (envelope field; ignored by the trustless fold)
const SHARES = 100, RATE = 100, TREASURY = 1_000_000n, REWARD = 250, REWARD_R = 0xF00Dn;
const BLOCK_HEIGHT = 311000, GAP = 10; // bond seeded GAP blocks ago ⇒ rps = RATE·GAP·2^64/SHARES = 10·2^64

// rps_entry at bond was 0 (farm rps 0 then); the advanced entry after harvesting REWARD:
const ENTRY0 = 0n;
const ENTRY1 = pool.farmHarvestNewEntry(SHARES, ENTRY0, REWARD); // 2.5·2^64

// ── envelopes ──
// 0x3B harvest (226): op ‖ farm_id ‖ bond_id(36) ‖ pubkey(33) ‖ exit_acc(16) ‖ view_h(4) ‖ reward(8 LE) ‖ reward_r(32) ‖ sig(64)
const harvestEnv = cat([[0x3B], hb(FARM_ID), Buffer.alloc(36), Buffer.alloc(33), Buffer.alloc(16), Buffer.alloc(4), u64le(REWARD), be(REWARD_R, 32), Buffer.alloc(64)]);
// 0x36 unbond (142): op ‖ farm_id ‖ unbonder_pubkey(33) ‖ shares(8 LE) ‖ view_h(4) ‖ sig(64)
const unbondEnv = cat([[0x36], hb(FARM_ID), hb(BONDER), u64le(SHARES), u32le(0), Buffer.alloc(64)]);

const mkTx = (env, salt) => {
  const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([env.length & 0xff, (env.length >> 8) & 0xff]), env, [0x68]]);
  const dummyTxid = Buffer.alloc(32, salt);
  const inputs = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputs, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
  return { tx, txid: computeTxid(tx), dummyTxid };
};
const h = mkTx(harvestEnv, 0xd1), u = mkTx(unbondEnv, 0xd2);
// BIP141 coinbase carrying the witness commitment, so the guest's witness-commitment gate authenticates the
// Taproot envelopes (witness_committed) and extracts/folds them. The coinbase folds nothing (no envelope).
const dsha = (b) => sha256(sha256(b));
const reserved = Buffer.alloc(32, 7);
const witnessRoot = computeMerkleRoot([Buffer.alloc(32), dsha(h.tx), dsha(u.tx)]); // wtxid[coinbase]=0, then the two txs
const wcommit = dsha(cat([witnessRoot, reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit, // OP_RETURN ‖ 0xaa21a9ed ‖ commitment
  [0x01], [0x20], reserved,
  Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const coinbaseSpec = { txData: '0x' + Buffer.from(coinbase).toString('hex'), txid: '0x' + Buffer.from(cbTxid).toString('hex'), vins: [], env: null };
const header = mineHeader(computeMerkleRoot([cbTxid, h.txid, u.txid]));

// ── prior: seed the farm accumulator (bond GAP blocks ago, rps not yet accrued) + the bond receipt R0 in the
// note tree (so poolRoot includes it; the harvest proves its membership). ──
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.farmRewards.load([{ farmId: FARM_ID, rate: String(RATE), totalShares: String(SHARES), rps: '0', lastHeight: String(BLOCK_HEIGHT - GAP) }]);
state.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: '0x' + '00'.repeat(32), reserveA: TREASURY.toString(), reserveB: '0', totalShares: '0', c0Backed: true, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);
const R0 = pool.farmReceiptLeaf(FARM_ID, SHARES, ENTRY0, OWNER, NONCE0);
state._acc.notes.insert(R0);

const txs = [
  { txData: '0x' + h.tx.toString('hex'), txid: '0x' + Buffer.from(h.txid).toString('hex'), vins: [{ prevTxid: '0x' + h.dummyTxid.toString('hex'), vout: 0 }],
    env: { type: 'harvest', farmId: FARM_ID, shares: SHARES, rpsEntry: ENTRY0.toString(), owner: OWNER, oldNonce: NONCE0, newNonce: NONCE1, amount: REWARD.toString(), r: '0x' + Buffer.from(be(REWARD_R, 32)).toString('hex') } },
  { txData: '0x' + u.tx.toString('hex'), txid: '0x' + Buffer.from(u.txid).toString('hex'), vins: [{ prevTxid: '0x' + u.dummyTxid.toString('hex'), vout: 0 }],
    env: { type: 'lp_unbond', farmId: FARM_ID, shares: SHARES, rpsEntry: ENTRY1.toString(), owner: OWNER, nonce: NONCE1 } },
];
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, ...txs] }],
}, new Map());

const hv = input.blocks[0].txs[1].harvest, ub = input.blocks[0].txs[2].lpUnbond;
console.error(`harvest folded=${!!(hv && hv.spentInsert)} (reward ${REWARD}, advanced entry ${ENTRY1})  unbond folded=${!!(ub && ub.spentInsert)}  newDigest=${input.newDigest}`);
if (!hv || !ub) { console.error('FATAL: a farm fold bailed (gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
