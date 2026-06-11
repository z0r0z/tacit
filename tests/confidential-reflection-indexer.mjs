#!/usr/bin/env node
// Phase 4.4 — the reflection indexer (dapp/confidential-reflection-indexer.js) resolves confirmed
// CXFER effects (spent outpoint → the real note's coords, output envelope commitments →
// decompressed notes) and assembles a prover batch. The tx-binding end-to-end is validated on real
// data (the GPU proof + the in-zkVM execute); this checks the indexer's resolution + assembly logic
// with valid synthetic commitments.
//
// Run: node tests/confidential-reflection-indexer.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeReflectionIndexer } from '../dapp/confidential-reflection-indexer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ne = (a, b, m) => { if (a === b) { console.error(`FAIL ${m} (should differ)`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

// Build a transfer-resolution scenario through a fresh indexer.
function run() {
  const idx = makeReflectionIndexer(deps);
  const pool = idx.pool;
  const asset = v(0xa5);

  // 2 prior pool notes (the spends' source), seeded as deposits at chosen outpoints
  const spent = [0, 1].map((i) => {
    const { cx, cy } = pool.commitXY(1000n + BigInt(i), 100n + BigInt(i));
    return { cx, cy, txid: v(0xd0 + i), vout: i };
  });
  const deposits = spent.map((n) => idx.recordDeposit({ assetId: asset, txid: n.txid, vout: n.vout, cx: n.cx, cy: n.cy }));
  idx.applyDeposits(deposits, 100);
  ok(idx.knownOutpoints() === 2, 'two deposits recorded');

  // 2 output notes carried as compressed commitments in the (would-be) CXFER envelope
  const out = [0, 1].map((i) => {
    const { cx, cy } = pool.commitXY(2000n + BigInt(i), 50n + BigInt(i));
    return { cx, cy, compressed: pool.compressXY(cx, cy) };
  });
  // compress↔decompress round-trips
  const rt = pool.decompressCommitment(out[0].compressed);
  eq(rt.cx, out[0].cx, 'compress↔decompress round-trips (Cx)');

  // resolve the transfer (spends the 2 deposits, creates the 2 outputs)
  const resolved = idx.resolveTransfer({
    txid: v(0x7777), assetId: asset, height: 101, blockIndex: 0,
    txData: '00', txIndex: 6, txids: [v(0x01)],
    spentVins: spent.map((n) => ({ prevTxid: n.txid, vout: n.vout })),
    outputCommitments: out.map((n) => n.compressed),
  });

  // the spends resolved to the real deposit coords
  eq(resolved.spends.length, 2, 'two spends resolved');
  eq(resolved.spends[0].cx, spent[0].cx, 'spend[0] resolved to the prior note Cx');
  eq(resolved.spends[1].cy, spent[1].cy, 'spend[1] resolved to the prior note Cy');
  // each spend's outpoint is outpointKey(prevTxid, vout)
  eq(resolved.spends[0].outpoint, pool.outpointKey(spent[0].txid, spent[0].vout), 'spend outpoint = outpointKey(vin)');
  // the outputs decompressed to notes whose commitmentHash matches
  eq(resolved.outputs[0].commitmentHash, pool.commitmentHash(out[0].cx, out[0].cy), 'output[0] commitment bound to the envelope point');
  eq(resolved.outputs[0].outpoint, pool.outpointKey(v(0x7777), 0), 'output outpoint = outpointKey(txid, vout=0)');
  // the spent outpoints left the live set; the 2 new outputs entered
  ok(idx.knownOutpoints() === 2, 'live set: 2 spent out, 2 new in');

  // assemble the prover batch
  const input = idx.assembleBatch([resolved], { headers: ['00'.repeat(80)], anchorHeight: 100 });
  eq(input.effects.length, 1, 'one effect in the batch');
  eq(input.effects[0].spends.length, 2, 'effect carries 2 spend witnesses');
  eq(input.effects[0].outputs.length, 2, 'effect carries 2 output witnesses');
  ne(input.newDigest, input.prior.poolRoot, 'batch advances the digest');
  return input.newDigest;
}

const d1 = run();
const d2 = run();
eq(d2, d1, 'deterministic: same effects → same newDigest');

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS — the indexer resolves + assembles a prover batch');
process.exit(failures ? 1 : 0);
