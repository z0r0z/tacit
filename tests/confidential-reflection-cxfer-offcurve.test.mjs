#!/usr/bin/env node
// Regression test: an unresolvable commitment must never stop the reflection lane — the cxfer/cxfer_bound
// sibling of the swap_batch fold-error fix.
//
// A commitment field isn't checked against the curve before dapp/confidential-reflection-scan-indexer.js's
// txSpec() decompresses it, and decompression can throw on input that was never verified any other way. The
// reflection cursor advances strictly in block order, so an exception escaping that call would have blocked
// every later block from folding too — the same hazard class already guarded against for burn-deposit
// bundles and for swap_batch. This test proves the fix: an off-curve commitment must fall through to
// env=null (ordinary, unrecognized traffic — a commitment that doesn't decompress was never a real
// confidential transfer the guest could have folded either), never throw.
//
// Run: node tests/confidential-reflection-cxfer-offcurve.test.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const idx = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// A syntactically-valid-length but off-curve compressed point: 02 || an x-coordinate with no curve solution.
// Confirmed empirically (see the fix's own investigation): x=5 has no valid y, ProjectivePoint.fromHex throws.
const OFFCURVE_COMMITMENT = '0x02' + (5n).toString(16).padStart(64, '0');
const ASSET_ID = '0x' + 'aa'.repeat(32);
const HEADERS = ['0x' + '00'.repeat(80)];
const ANCHOR_HEIGHT = 500000;

// ───────────────── 1. cxfer with an off-curve commitment must not throw ─────────────────
{
  const tx = {
    rawHex: '0x' + 'deadbeef'.repeat(4),
    txidDisplay: 'offcurve-cxfer-1',
    vins: [],
    decode: {
      type: 'cxfer', opcode: 0x22, assetInputCount: null, assetId: ASSET_ID,
      kernelSig: '0x' + '11'.repeat(64), rangeProof: '0x' + '22'.repeat(32),
      commitments: [OFFCURVE_COMMITMENT], vouts: null, voutBase: 0,
    },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await idx.assembleBlocks([{ txs: [tx] }], { headers: HEADERS, anchorHeight: ANCHOR_HEIGHT });
  }, 'assembleBlocks must not throw on an off-curve cxfer commitment');
  ok('a cxfer envelope with an off-curve commitment does not throw');
  assert.strictEqual(result.blocks[0].txs[0].outputs.length, 0, 'no cxfer outputs are folded — treated as ordinary, unrecognized traffic');
  ok('it is treated as ordinary, unrecognized Bitcoin traffic — not a confidential transfer');
}

// ───────────────── 2. cxfer_bound with an off-curve commitment must not throw ─────────────────
{
  const tx = {
    rawHex: '0x' + 'deadbeef'.repeat(4),
    txidDisplay: 'offcurve-cxfer-bound-1',
    vins: [],
    decode: {
      type: 'cxfer_bound', opcode: 0x39, target: '0x' + '33'.repeat(32), assetId: ASSET_ID,
      kernelSig: '0x' + '11'.repeat(64), rangeProof: '0x' + '22'.repeat(32),
      commitments: [OFFCURVE_COMMITMENT], vouts: null, voutBase: 0,
    },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await idx.assembleBlocks([{ txs: [tx] }], { headers: HEADERS, anchorHeight: ANCHOR_HEIGHT + 1 });
  }, 'assembleBlocks must not throw on an off-curve cxfer_bound commitment');
  ok('a cxfer_bound envelope with an off-curve commitment does not throw');
  assert.strictEqual(result.blocks[0].txs[0].outputs.length, 0, 'no cxfer outputs are folded — treated as ordinary, unrecognized traffic');
  ok('it is treated as ordinary, unrecognized Bitcoin traffic — not a confidential transfer');
}

console.log(`\n${n} cxfer off-curve-commitment isolation checks passed.`);
