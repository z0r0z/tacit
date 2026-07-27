#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC reflected-note BRIDGE BURN (0x2B) that spends a live
// pool note, so the reflection guest folds it into the burn set under the SOURCE-SPECIFIC bridge_burn_id and
// MUST land on the JS assembler's newDigest — the reflect-exec guest<->JS parity check for the burn-set fold.
//
// The bug this closes: the assembler used to fold the burn under the bare ν, but the guest keys the burn
// accumulator by bridge_burn_id(BURN_SOURCE_REFLECTED, spent_outpoint, btc_note_leaf) — so the insert witness
// targeted the wrong key and the first live bridge-out halted reflection. BRIDGEBURN_SCENARIO selects:
//   reflected      (default) — envelope asset == the spent note's asset → the burn records (burn set grows).
//                              Expected: DIGEST_MATCH-with-burn.
//   asset-mismatch          — envelope declares a DIFFERENT asset than the note actually spent → the guest
//                              SKIPS the burn record (note stays nullified, no bridge-out minted). No burn
//                              witness is read. Expected: DIGEST_MATCH-with-skip (burn set unchanged).
//   node tests/gen-reflection-bridge-burn-synth.mjs > /tmp/bridge-burn-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');

const SCENARIO = process.env.BRIDGEBURN_SCENARIO || 'reflected';
const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32);
const AUTH = '0x' + 'e7'.repeat(32); // the note's Bitcoin auth key (x-only) — part of its btc_note_leaf
const DEST = '0x' + 'de'.repeat(32); // the bridge-out destination commitment
const BLOCK_HEIGHT = 312000;
const noteVal = 5000n, rNote = 0x9a9an;

// The live note (a Bitcoin-homed btc-note of asset A) seeded at seedTxid:0.
const noteXY = pool.commitXY(noteVal, rNote);
const seedTxid = Buffer.alloc(32, 0x7b), seedVout = 0;
const noteLeaf = pool.btcNoteLeaf(ASSET_A, noteXY.cx, noteXY.cy, AUTH);
const nu = pool.nullifier(noteLeaf);
// The burn envelope declares the asset it claims to burn: A for a real burn, B for the hostile-asset-mismatch.
const envAsset = SCENARIO === 'asset-mismatch' ? ASSET_B : ASSET_A;

// 0x2B burn envelope (129B): opcode ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32).
const envelope = cat([[0x2b], hb(envAsset), Buffer.alloc(32), hb(nu), hb(DEST)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// Seed the prior: the live btc-note (asset A) at seedTxid:0, carrying its auth key.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(noteLeaf, inOutpoint, pool.commitmentHash(noteXY.cx, noteXY.cy), ASSET_A, AUTH);
coords.set(inOutpoint.toLowerCase(), { cx: noteXY.cx, cy: noteXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: { type: 'burn', assetId: envAsset, nullifier: nu, dest: DEST },
};
const burnBefore = state.counts().burn;
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, coords);

const burnTx = input.blocks[0].txs[1];
const burnGrew = state.counts().burn === burnBefore + 1;
const noteSpent = state.spentContains(nu);
if (!noteSpent) { console.error('FATAL: the burned note was not nullified'); process.exit(1); }
if (SCENARIO === 'asset-mismatch') {
  if (burnGrew) { console.error('FATAL: asset-mismatch burn should NOT record a bridge-out'); process.exit(1); }
  if (burnTx.burnInsert !== null) { console.error('FATAL: asset-mismatch must read no burn witness'); process.exit(1); }
} else {
  if (!burnGrew) { console.error('FATAL: reflected burn did not record a bridge-out'); process.exit(1); }
  // The burn is keyed by bridge_burn_id(REFLECTED, spent_outpoint, btc_note_leaf) — assert that exact key inserted.
  const burnId = pool.bridgeBurnId(1, '0x' + seedTxid.toString('hex'), seedVout, noteLeaf);
  if (!state.burnContains(burnId)) { console.error('FATAL: burn set does not contain the reflected bridge_burn_id'); process.exit(1); }
}
console.error(`bridge_burn[${SCENARIO}]: envAsset=${envAsset.slice(0, 10)} spent=${noteSpent} burnGrew=${burnGrew} newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
