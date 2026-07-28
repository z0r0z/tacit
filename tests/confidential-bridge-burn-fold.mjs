#!/usr/bin/env node
// Bridge-burn fold — JS mirror of the reflect.rs burn-set dispatch. Validates that the assembler keys the burn
// accumulator by the SOURCE-SPECIFIC bridge_burn_id (spent outpoint + full source leaf), NOT the bare ν, and
// mirrors the guest's decisions: a reflected burn records under BURN_SOURCE_REFLECTED only when the envelope
// asset equals the spent note's asset; a burn-deposit records under BURN_SOURCE_DEPOSIT with the spent-set and
// burn-set treated INDEPENDENTLY (a fresh burn_id inserts even when ν is already spent); a duplicate burn_id is
// a membership-gated no-op. End-to-end guest-digest parity: gen-reflection-bridge-burn-synth.mjs under
// reflect-exec. Run: node tests/confidential-bridge-burn-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const norm = (x) => pool.hx(hb(x)).toLowerCase();
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const A = '0x' + 'a1'.repeat(32), B = '0x' + 'b2'.repeat(32);
const AUTH = '0x' + 'e7'.repeat(32), DEST = '0x' + 'de'.repeat(32), TARGET = '0x' + '7c'.repeat(32);
const noteXY = pool.commitXY(5000n, 0x9a9an);
const noteLeaf = pool.btcNoteLeaf(A, noteXY.cx, noteXY.cy, AUTH);
const nu = pool.nullifier(noteLeaf);
const seedTxid = Buffer.alloc(32, 0x7b), seedVout = 0;

// Build a 0x2B burn tx spending the live note at seedTxid:0, declaring `envAsset`.
function burnTx(envAsset) {
  const envelope = cat([[0x2b], hb(envAsset), Buffer.alloc(32), hb(nu), hb(DEST), hb(TARGET)]);
  const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
  const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
  return tx;
}
async function runBurn(envAsset) {
  const state = pool.makeScanReflectionState();
  state.setHeight(100);
  const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
  state.foldOutput(noteLeaf, inOutpoint, pool.commitmentHash(noteXY.cx, noteXY.cy), A, AUTH);
  const coords = new Map([[inOutpoint.toLowerCase(), { cx: noteXY.cx, cy: noteXY.cy }]]);
  const tx = burnTx(envAsset);
  const txid = computeTxid(tx);
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
  const header = mineHeader(computeMerkleRoot([cbTxid, txid]));
  const txSpec = { txData: '0x' + tx.toString('hex'), txid: '0x' + Buffer.from(txid).toString('hex'), vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }], env: { type: 'burn', assetId: envAsset, nullifier: nu, dest: DEST, target: TARGET } };
  const input = await pool.assembleReflectionScanInput(state, { anchorHeight: 101, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }] }, coords);
  return { state, burnTx: input.blocks[0].txs[1] };
}

// ── reflected fresh: the burn records under bridge_burn_id(REFLECTED), NOT ν ──
{
  const { state, burnTx } = await runBurn(A);
  ok(state.spentContains(nu), 'reflected: the burned note is nullified');
  const burnId = pool.bridgeBurnId(1, '0x' + seedTxid.toString('hex'), seedVout, noteLeaf, TARGET);
  ok(state.burnContains(burnId), 'reflected: burn set contains the target-scoped bridge_burn_id (source-specific key)');
  // A DIFFERENT target reconstructs a distinct id → not a member (a successor generation cannot pay this burn).
  ok(!state.burnContains(pool.bridgeBurnId(1, '0x' + seedTxid.toString('hex'), seedVout, noteLeaf, '0x' + '7d'.repeat(32))), 'reflected: a different-target burn_id is NOT a member');
  ok(!state.burnContains(nu), 'reflected: burn set is NOT keyed by the bare ν');
  ok(burnTx.burnInsert && norm(burnTx.burnInsert.bLowKey) !== norm(burnId), 'reflected: a real (fresh) burn insert witness was emitted');
  eq(state.counts().burn, 2, 'reflected: burn count = sentinel + the bridge-out');
}

// ── asset-mismatch: envelope declares B, note is A → SKIP the burn record ──
{
  const { state, burnTx } = await runBurn(B);
  ok(state.spentContains(nu), 'asset-mismatch: the note stays nullified (no double-spend)');
  eq(state.counts().burn, 1, 'asset-mismatch: NO bridge-out recorded (burn set unchanged)');
  eq(burnTx.burnInsert, null, 'asset-mismatch: no burn witness read (stream stays in sync)');
}

// ── burn-deposit independence: a ν already in the spent set must NOT block a fresh (deposit) burn_id ──
// The burn-deposit path folds the SPENT and BURN sides independently. Replicate its primitives: pre-spend ν,
// then confirm a fresh deposit burn_id still inserts (note appended + burn recorded).
{
  const state = pool.makeScanReflectionState();
  state.setHeight(100);
  const nativeLeaf = pool.leaf(A, noteXY.cx, noteXY.cy, '0x' + '00'.repeat(32)); // native burn-deposit source leaf
  const depNu = pool.nullifier(nativeLeaf);
  state.foldSpent(depNu); // ν recorded in the spent set BEFORE the burn-deposit (a prior normal spend / collision)
  ok(state.spentContains(depNu), 'burn-deposit: ν is already spent');
  const burnId = pool.bridgeBurnId(2, '0x' + seedTxid.toString('hex'), seedVout, nativeLeaf, TARGET);
  ok(!state.burnContains(burnId), 'burn-deposit: the deposit burn_id is still FRESH despite the spent ν');
  const noteBefore = state.counts().note, burnBefore = state.counts().burn;
  state.foldNoteAppend(nativeLeaf);
  state.foldBurn(burnId, DEST);
  ok(state.burnContains(burnId), 'burn-deposit: the fresh burn_id records even though ν was already spent (independent sides)');
  eq(state.counts().note, noteBefore + 1, 'burn-deposit: the native note was appended');
  eq(state.counts().burn, burnBefore + 1, 'burn-deposit: the burn set grew');

  // ── duplicate burn_id: a re-presented deposit is a membership-gated no-op ──
  const w = state.foldBurn(burnId, DEST);
  eq(norm(w.bLowKey), norm(burnId), 'duplicate burn_id: membership-gated no-op (bLowKey === burnId)');
  eq(state.counts().burn, burnBefore + 1, 'duplicate burn_id: burn set did not grow again');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
