#!/usr/bin/env node
// Phase 4.4 — assemble a FULL effect-fold of a REAL signet CXFER through the reflection prover.
// Seeds the prior state with the CXFER's spent outpoints (valid commitments; in production these
// come from the attested prior state / the prior txs), then folds the real CXFER as one transfer
// effect bound to its confirmed tx: real PoW + merkle inclusion (verify_tx_in_block), real vins
// (extract_inputs), real envelope output commitments (parse_cxfer_envelope). The fold data
// (vin outpoint keys, output commitment-hashes + outpoints, txid) is extracted from the real tx
// by cxfer-core (fixtures/signet_cxfer_folddata.json, written by gen_real_cxfer_fold_data).
//
// Run: node tests/gen-reflection-cxfer-fold.mjs > contracts/sp1/confidential/fixtures/reflection_input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const rd = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));

const cx = rd('../contracts/sp1/confidential/fixtures/signet_cxfer.json');
const fold = rd('../contracts/sp1/confidential/fixtures/signet_cxfer_folddata.json');
const reverseTxid = (h) => '0x' + h.replace(/^0x/, '').match(/../g).reverse().join(''); // display → internal
const txidsInternal = cx.txids.map(reverseTxid);

const BLOCK_HEIGHT = cx.blockHeight; // 307547
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

const state = pool.makeReflectionState();

// 1. seed the prior state with the CXFER's spent outpoints (valid commitments). In production
//    these were attested in a prior cycle (the prior txs folded); here we seed them directly.
const seedNotes = fold.spendOutpoints.map((outpoint, i) => {
  const { cx: scx, cy: scy } = pool.commitXY(1000n + BigInt(i), 7n + BigInt(i) * 3n); // valid curve point
  return { cx: scx, cy: scy, outpoint, noteLeaf: v(0x1000 + i), commitmentHash: pool.commitmentHash(scx, scy) };
});
state.applyTransfer([], seedNotes.map((n) => ({ noteLeaf: n.noteLeaf, outpoint: n.outpoint, commitmentHash: n.commitmentHash })), BLOCK_HEIGHT - 1);

// 2. assemble the prior (post-seed) + the real CXFER as one transfer effect.
const input = pool.assembleReflectionInput(state, {
  anchorHeight: BLOCK_HEIGHT, // headers[0] is the CXFER's block; effect height = anchor + blockIndex
  headers: [cx.header.replace(/^0x/, '')],
  effects: [{
    type: 'transfer',
    blockIndex: 0,
    txData: cx.tx.replace(/^0x/, ''),
    txIndex: cx.txIndex,
    txids: txidsInternal.map((t) => t.replace(/^0x/, '')),
    height: BLOCK_HEIGHT, // == anchorHeight + blockIndex (the guest recomputes this)
    spends: seedNotes.map((n) => ({ cx: n.cx, cy: n.cy, outpoint: n.outpoint })),
    outputs: fold.outputs.map((o, i) => ({ noteLeaf: v(0x2000 + i), outpoint: o.outpoint, commitmentHash: o.commitmentHash, vout: o.vout })),
  }],
});

process.stderr.write(`folded real CXFER: ${input.effects[0].spends.length} spends, ${input.effects[0].outputs.length} outputs; newDigest ${input.newDigest}\n`);
process.stdout.write(JSON.stringify({ note: 'FULL effect-fold of a real signet CXFER (block 307547) through the reflection prover.', ...input }, null, 1) + '\n');
