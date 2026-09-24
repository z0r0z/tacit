#!/usr/bin/env node
// Regression test: a swap-batch fold error must never stop the reflection lane.
//
// `foldSwapBatch` (dapp/confidential-swapbatch.js) can reject a batch before full verification completes.
// The reflection cursor advances strictly in block order, so an exception escaping that call would have
// blocked every later block from folding too, not just this one batch — the same hazard class already
// guarded against once for burn-deposit bundles (worker/src/reflection-attest.js's getBurnDeposits). This
// test proves the fix: a throwing fold hook must be caught in confidential-pool.js's
// assembleReflectionScanInput and treated as unfolded/ordinary traffic (matching the existing "no hook"
// fallback shape exactly), never propagate.
//
// Uses a MOCK swapBatchFold hook that always throws — this isolates the fix under test (the try/catch in
// confidential-pool.js) from the real foldSwapBatch's internal logic, which is separately verified by
// reading dapp/confidential-swapbatch.js directly.
//
// Run: node tests/confidential-swapbatch-fold-error-isolation.test.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const dsha = (b) => sha256(sha256(b));

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32);
const BLOCK_HEIGHT = 500000;
const RECEIPT_XONLY = 'e1'.repeat(32), REFUND_XONLY = 'e2'.repeat(32), V0_XONLY = 'e0'.repeat(32);
const seedTxid = Buffer.alloc(32, 0x2f), seedVout = 0;

// A minimal, 1-intent-shaped swap_batch tx. Its envelope CONTENT is irrelevant (garbage) — the mock fold
// hook below throws unconditionally, so nothing ever reads intents/receipts/proof. Only the tx's real
// output structure matters, since receiptSpks/refundSpks in confidential-pool.js read straight from
// txData (txOutputScript), computed OUTSIDE the try/catch under test.
const pushData = (b) => cat([[b.length], b]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], pushData(Buffer.alloc(8, 0xee)), [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const p2trOut = (xonlyHex) => cat([u64le(0), [0x22], [0x51, 0x20], Buffer.from(xonlyHex, 'hex')]);
const outputs = cat([p2trOut(V0_XONLY), p2trOut(RECEIPT_XONLY), p2trOut(REFUND_XONLY)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x03], outputs, wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx), txidHex = hx(txid);

const reserved = Buffer.alloc(32, 7);
const witnessRoot = dsha(cat([Buffer.alloc(32), dsha(tx)]));
const wcommit = dsha(cat([witnessRoot, reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
  [0x01], [0x20], reserved,
  Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const coinbaseSpec = { txData: hx(coinbase), txid: hx(cbTxid), vins: [], env: null };
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

const env = { assetA: ASSET_A, assetB: ASSET_B, nIntents: 1, feeBps: 30, intents: [{}], receipts: [{}] };
const txSpec = { txData: hx(tx), txid: txidHex, vins: [{ prevTxid: hx(seedTxid), vout: seedVout }], env: { type: 'swap_batch', ...env } };

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);

// ───────────────── 1. a throwing fold hook must not propagate ─────────────────
{
  const swapBatchFold = () => { throw new Error('swap-batch: two intents share a refund key — both refunds would hash to the same leaf and nullifier, so only one could ever be spent'); };
  let input;
  await assert.doesNotReject(async () => {
    input = await pool.assembleReflectionScanInput(state, {
      anchorHeight: BLOCK_HEIGHT, headers: [hx(header)], blocks: [{ txs: [coinbaseSpec, txSpec] }], swapBatchFold,
    }, new Map());
  }, 'assembleReflectionScanInput must not throw when the fold hook throws');
  ok('a throwing swapBatchFold hook does not propagate out of assembleReflectionScanInput');

  const sb = input.blocks[0].txs[1].swapBatch;
  assert.ok(sb, 'the swap_batch tx still gets a swapBatch descriptor (peeked, not folded)');
  assert.strictEqual(sb.receiptPaths.length, env.nIntents, 'receiptPaths still has nIntents entries (peeked)');
  assert.strictEqual(sb.refundPaths.length, env.nIntents, 'refundPaths still has nIntents entries (peeked)');
  ok('the failed fold is treated exactly like the existing "no hook" fallback shape — ordinary, unfolded traffic');
}

// ───────────────── 2. a real error still gets recorded — this isn't silent swallowing on the wrong thing ─────────────────
{
  const state2 = pool.makeScanReflectionState();
  state2.setHeight(BLOCK_HEIGHT - 1);
  let sawUnrelatedError = false;
  const originalLog = console.log;
  console.log = (msg) => { if (String(msg).includes('swap_batch fold') && String(msg).includes('boom')) sawUnrelatedError = true; };
  try {
    const swapBatchFold = () => { throw new Error('boom: some other internal fold error'); };
    await pool.assembleReflectionScanInput(state2, {
      anchorHeight: BLOCK_HEIGHT, headers: [hx(header)], blocks: [{ txs: [coinbaseSpec, txSpec] }], swapBatchFold,
    }, new Map());
  } finally { console.log = originalLog; }
  assert.ok(sawUnrelatedError, 'the underlying error message is still logged, not silently discarded');
  ok('a genuine internal fold error is caught the same way, and still logged for operator visibility');
}

console.log(`\n${n} swap-batch fold error-isolation checks passed.`);
