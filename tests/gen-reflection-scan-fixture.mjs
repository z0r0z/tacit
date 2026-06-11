#!/usr/bin/env node
// Build the FULL-SCAN reflection prover input from REAL signet block 307547 (ALL 146 txs), so the
// guest's completeness merkle check + the full vin-scan run end-to-end. Seeds the prior live set
// with the real CXFER's spent outpoints (valid commitments; in production these were attested in a
// prior cycle), then assembles the whole block — only the CXFER tx classifies as a pool effect;
// the other 145 (coinbase + ordinary signet txs) are scanned and touch no pool UTXO.
//
//   node tests/gen-reflection-scan-fixture.mjs > contracts/sp1/confidential/fixtures/reflection_input.json
//
// Block txs (raw hex + vins) are fetched once into /tmp/block-307547-full.json (fetch-block script).

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const rd = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));

const block = JSON.parse(readFileSync('/tmp/block-307547-full.json'));
const cxFix = rd('../contracts/sp1/confidential/fixtures/signet_cxfer.json');

const CXFER_DISPLAY = cxFix.txid;                 // 0b7e975f… (display order)
const HEADER = '0x' + cxFix.header.replace(/^0x/, '');
const BLOCK_HEIGHT = cxFix.blockHeight;           // 307547
const ZERO_OWNER = '0x' + '00'.repeat(32);
// The CXFER envelope's asset + compressed output commitments (cxfer-core parse_cxfer_envelope).
const ASSET = '0x879cf8e6f26b733497ca1d154ed22c80b2266a5702ed55476a8cd4a3c5e9c4ea';
const COMMITS = ['0x0285a262fa740c11d5373908d815729b716a4b1f162398435a8d3b527433fe492f',
                 '0x032f6b9765f0c786325aff703eb7dd070516b946deda91b44db605717a8c8be386'];

const internal = (d) => '0x' + d.replace(/^0x/, '').match(/../g).reverse().join(''); // display → internal
const withHex = (h) => (h.startsWith('0x') ? h : '0x' + h);

// ── Seed: the CXFER's vins are prior pool UTXOs. Fold them as prior outputs so the live set +
//    coords hold them, then the assembled block's scan detects + spends them. ──
const state = pool.makeScanReflectionState();
const coords = new Map();
state.setHeight(BLOCK_HEIGHT - 1);

const cxTx = block.txs.find((t) => t.txid === CXFER_DISPLAY);
if (!cxTx) throw new Error('CXFER tx not found in the fetched block');
const seedVins = cxTx.vins.filter((vi) => !vi.isCoinbase);
seedVins.forEach((vi, i) => {
  const outpoint = pool.outpointKey(internal(vi.prevTxid), vi.vout);
  const { cx, cy } = pool.commitXY(1000n + BigInt(i), 7n + BigInt(i) * 3n); // a valid prior note
  state.foldOutput(pool.leaf(ASSET, cx, cy, ZERO_OWNER), outpoint, pool.commitmentHash(cx, cy));
  coords.set(outpoint.toLowerCase(), { cx, cy });
});

// REFLECT-1: the assembler now re-verifies cxfer value conservation before folding (it mirrors the
// guest). For this fixture to fold the real CXFER, two things must hold: (1) the cxfer env carries
// the envelope's real kernel_sig + range_proof; (2) the prior live set holds the CXFER's REAL input
// commitments (so Σ C_in = Σ C_out for the real kernel). The seed above uses placeholder input notes
// (commitXY(1000…)), so conservation will NOT pass — regenerating this fixture for the corrected
// re-prove must fetch the prevout commitments and extract KERNEL_SIG / RANGE_PROOF from the CXFER
// envelope (cxfer-core parse_cxfer_envelope_full), as ASSET/COMMITS were extracted above.
const KERNEL_SIG = cxFix.kernelSig || null;     // 0x..64-byte BIP-340 kernel sig (extract from the envelope)
const RANGE_PROOF = cxFix.rangeProof || null;   // 0x.. BP+ range proof over the outputs
if (!KERNEL_SIG || !RANGE_PROOF) {
  throw new Error('gen-reflection-scan-fixture: post-REFLECT-1 this fixture needs the real CXFER ' +
    'kernel_sig + range_proof AND real prior input commitments so conservation passes. Wire them ' +
    '(extract from signet_cxfer.json\'s tx envelope + fetch the prevout commitments) before regenerating.');
}
const txs = block.txs.map((t) => {
  const vins = t.vins.filter((vi) => !vi.isCoinbase).map((vi) => ({ prevTxid: internal(vi.prevTxid), vout: vi.vout }));
  let env = null;
  if (t.txid === CXFER_DISPLAY) {
    env = { type: 'cxfer', assetId: ASSET, kernelSig: KERNEL_SIG, rangeProof: RANGE_PROOF, outputs: COMMITS.map((comm, j) => {
      const { cx, cy } = pool.decompressCommitment(comm);
      return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(ASSET, cx, cy, ZERO_OWNER), vout: j };
    }) };
  }
  return { txData: withHex(t.rawHex), txid: internal(t.txid), vins, env };
});

const input = pool.assembleReflectionScanInput(state, { anchorHeight: BLOCK_HEIGHT, headers: [HEADER], blocks: [{ txs }] }, coords);
if (input.nonConserving && input.nonConserving.length) {
  throw new Error('gen-reflection-scan-fixture: the CXFER did not conserve (the seed used placeholder ' +
    'input commitments). Seed the REAL prevout commitments so Σ C_in = Σ C_out for the real kernel sig.');
}

// Sanity to stderr (stdout is the fixture JSON).
const cxOut = input.blocks[0].txs.find((tx) => tx.outputs.length > 0);
console.error(`txs=${txs.length} priorLive=${input.prior.liveCount} spendsDetected=${input.blocks[0].txs.reduce((n, tx) => n + tx.openings.length, 0)} cxferOutputs=${cxOut ? cxOut.outputs.length : 0}`);
console.error(`newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
