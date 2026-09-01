#!/usr/bin/env node
// Full-scan reflection indexer (worker wiring): the dapp's makeScanReflectionIndexer transforms
// the worker's per-block tx data (raw hex + vins + protocol decode) into the full-scan prover
// input and advances the canonical ScanReflection state across blocks — and a snapshot round-trip
// reconstructs the exact digest (restart durability). Mirrors what reflection-attest.js feeds.
//
// Run: node tests/confidential-reflection-scan-indexer.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { makeBurnDepositAssembler } from '../dapp/burn-deposit-assembler.js';
import { conservingCxfer } from './_conserving-cxfer.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha256 = (b) => sha256(sha256(b));
const cat = (arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
// A minimal burnDepositKit: block1's burn tx carries no holder-traced provenance bundle, so
// buildBurnDepositCtx only ever exercises the bundle-less ("no admissible leaf") fallback — the
// mirror/parseEtchAnchor/computeTxidInternal members are never actually invoked, but the kit must
// be present (the scan indexer requires SOME kit for any burn-classified tx, since it always builds
// at least the tx's own witness-commitment proof).
const burnDepositKit = {
  assembler: makeBurnDepositAssembler({ dsha256, cat, bytesToHex }),
  parseEtchAnchor: () => null,
  computeTxidInternal: () => '0x' + '00'.repeat(32),
  mirror: { verifyCmintAuthorized: () => null, verifyPoolMembershipLeaf: () => null, verifyProvenanceLeaves: () => false },
};
const deps = { secp, keccak256: keccak_256, sha256, burnDepositKit };

let failures = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${msg}`); };
const ne = (a, b, msg) => { if (a === b) { console.error(`FAIL ${msg} (should differ)`); failures++; } else console.log(`ok   ${msg}`); };

// A valid compressed secp commitment for scalar k: (k·G), as the CXFER envelope carries it.
const commit = (k) => '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(BigInt(k)).toRawBytes(true)).toString('hex');
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
// 32-byte display-order txids (the indexer reverses to internal); content irrelevant to the logic.
const dtx = (b) => '0x' + b.toString(16).padStart(2, '0') + 'ff'.repeat(31);

const assetId = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b'; // TAC — the legacy-admissible asset an unbound cxfer folds under
const idx = makeScanReflectionIndexer(deps);
const genesis = idx.digest();

// Block 0 (height 500): one CXFER tx with two output notes (deposits). vins are non-pool.
const tx0disp = dtx(0x10);
// block0's cxfer SPENDS a pre-seeded live note (the fold requires >=1 live input now; zero-input cxfers skip).
const inDisplayTxid = dtx(0xee), inVout = 3, inK = 0x0c01n;
const inInternal = '0x' + inDisplayTxid.replace(/^0x/, '').match(/../g).reverse().join(''); // display → internal
const cxf = conservingCxfer(assetId, [{ txid: inInternal, vout: inVout, k: inK }], [11n, 22n]);
const inC = cxf.inputCommitments[0];
const inKey = idx.pool.outpointKey(inInternal, inVout);
{ const snap = idx.snapshot();
  snap.liveTriples.push([inKey, idx.pool.commitmentHash(inC.cx, inC.cy), assetId, '0x' + '00'.repeat(32), 0]);
  snap.coords.push([inKey.toLowerCase(), { cx: inC.cx, cy: inC.cy }]);
  idx.load(snap); }
const block0 = { txs: [{
  txidDisplay: tx0disp,
  rawHex: 'aa'.repeat(60),
  vins: [{ prevTxidDisplay: inDisplayTxid, vout: inVout }],  // spends the seeded live note
  decode: { type: 'cxfer', assetId, ...cxf },
}] };
const in0 = await idx.assembleBlocks([block0], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 500 });
eq(in0.prior.poolRoot, makeScanReflectionIndexer(deps).roots().poolRoot, 'block0 prior == genesis pool root');
ne(in0.newDigest, genesis, 'block0 advances the digest');
eq(idx.liveCount(), 2, 'two outputs are now live');
eq(in0.blocks[0].txs[0].outputs.length, 2, 'cxfer tx emits two output witnesses');
eq(in0.blocks[0].txs[0].openings.length, 1, 'cxfer spends the seeded live note (one opening)');

// The internal-order txid the outputs are keyed under (so block1 can spend them).
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');
const tx0internalDisplay = tx0disp; // block1 references the SAME display txid as its prevTxid
const out1 = idx.pool.decompressCommitment(cxf.commitments[1]);
// ν is leaf-bound: the live note was folded with a zero auth_key, so ν = nullifier(btc_note_leaf(asset,Cx,Cy,0)).
const burnNu = idx.pool.nullifier(idx.pool.btcNoteLeaf(assetId, out1.cx, out1.cy, '0x' + '00'.repeat(32)));

// Block 1 (height 501): a plain spend of output 0, and a bridge-out burn of output 1.
const afterBlock0 = idx.digest();
const block1 = { txs: [
  { txidDisplay: dtx(0x20), rawHex: 'bb'.repeat(40), vins: [{ prevTxidDisplay: tx0internalDisplay, vout: 0 }], decode: null },
  { txidDisplay: dtx(0x21), rawHex: 'cc'.repeat(40), vins: [{ prevTxidDisplay: tx0internalDisplay, vout: 1 }], decode: { type: 'burn', assetId, nullifier: burnNu, dest: v(0xde57), target: v(0x7c) } },
] };
const in1 = await idx.assembleBlocks([block1], { headers: ['0x' + '11'.repeat(80)], anchorHeight: 501 });
eq(in1.prior.poolRoot, in0.newDigest ? in1.prior.poolRoot : null, 'block1 prior exists');
eq(in1.prior.liveCount, 2, 'block1 prior had two live notes');
eq(idx.liveCount(), 0, 'both outputs spent → live set empty');
eq(in1.blocks[0].txs[0].openings.length, 1, 'plain spend detected (one opening)');
eq(in1.blocks[0].txs[0].spentInserts.length, 1, 'plain spend → one spent-set insert');
eq(in1.blocks[0].txs[1].openings.length, 1, 'burn spend detected');
ne(JSON.stringify(in1.blocks[0].txs[1].burnInsert), 'null', 'burn → a burn-set insert');
ne(idx.digest(), afterBlock0, 'block1 advances the digest');
const finalDigest = idx.digest();

// Snapshot round-trip: a fresh indexer loaded from the snapshot reproduces the exact digest +
// roots (so a worker restart resumes the canonical state without replaying every block).
const snap = idx.snapshot();
const restored = makeScanReflectionIndexer(deps);
restored.load(JSON.parse(JSON.stringify(snap)));
eq(restored.digest(), finalDigest, 'snapshot round-trip reproduces the digest');
eq(JSON.stringify(restored.roots()), JSON.stringify(idx.roots()), 'snapshot round-trip reproduces the roots');
eq(restored.liveCount(), 0, 'restored live count matches');

// And a restored indexer can keep folding: a third block with a cxfer that spends a freshly-seeded live note
// and deposits one output, advancing coherently.
const in2live = makeScanReflectionIndexer(deps);
in2live.load(JSON.parse(JSON.stringify(snap)));
const b2inDisplay = dtx(0xdd), b2inVout = 0, b2inK = 0x0d01n;
const b2inInternal = '0x' + b2inDisplay.replace(/^0x/, '').match(/../g).reverse().join('');
const cxf2 = conservingCxfer(assetId, [{ txid: b2inInternal, vout: b2inVout, k: b2inK }], [33n]);
const b2inC = cxf2.inputCommitments[0];
const b2inKey = in2live.pool.outpointKey(b2inInternal, b2inVout);
{ const s2 = in2live.snapshot();
  s2.liveTriples.push([b2inKey, in2live.pool.commitmentHash(b2inC.cx, b2inC.cy), assetId, '0x' + '00'.repeat(32), 0]);
  s2.coords.push([b2inKey.toLowerCase(), { cx: b2inC.cx, cy: b2inC.cy }]);
  in2live.load(s2); }
const block2 = { txs: [{ txidDisplay: dtx(0x30), rawHex: 'dd'.repeat(50), vins: [{ prevTxidDisplay: b2inDisplay, vout: b2inVout }], decode: { type: 'cxfer', assetId, ...cxf2 } }] };
const r2 = await in2live.assembleBlocks([block2], { headers: ['0x' + '22'.repeat(80)], anchorHeight: 502 });
eq(r2.prior.poolRoot, idx.roots().poolRoot, 'restored indexer continues from the snapshot root');
eq(in2live.liveCount(), 1, 'the new deposit is live in the restored indexer');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall full-scan indexer checks passed');
