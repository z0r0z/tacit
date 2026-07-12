#!/usr/bin/env node
// F4 full-scan reflection: the dapp's makeLiveUtxoSet / makeScanReflectionState /
// assembleReflectionScanInput mirror the Rust prover (cxfer-core LiveUtxoSet + ScanReflection)
// byte-for-byte. The genesis digest is the three-way anchor (JS == Rust == contract). If this
// drifts, knownReflectionDigest chaining breaks.
//
// Run: node tests/confidential-reflection-scan.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { conservingZeroCxfer } from './_conserving-cxfer.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const ZERO_OWNER = '0x' + '00'.repeat(32);

let failures = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${msg}`); };
const ne = (a, b, msg) => { if (a === b) { console.error(`FAIL ${msg} (should differ)`); failures++; } else console.log(`ok   ${msg}`); };

// The full-scan genesis digest — the three-way anchor: JS == cxfer-core ScanReflection::genesis().digest()
// == ConfidentialPool.REFLECTION_GENESIS_DIGEST. Commits the empty live set + cBTC lock set + pool registry +
// the fast-lane consumed-ν count (Mode-B; 0 at genesis). Matches ConfidentialPool.sol:246.
const SCAN_GENESIS = '0xe9e59ecbb38bf720371372192107226058653493e3872ee5b289ea46ef8bd8c6';
const LIVE2_ROOT = '0x0b4c5da8728e3216a451be798a8d9326513e018880e1755bffd582f084718faa';

const last = (b) => '0x' + '00'.repeat(31) + b;     // 32-byte word, b in the last byte (key)
const first = (b) => '0x' + b + '00'.repeat(31);     // 32-byte word, b in the first byte (value/asset)
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// 1. genesis digest — the three-way anchor for the full-scan model.
const st = pool.makeScanReflectionState();
eq(st.digest(), SCAN_GENESIS, 'full-scan genesis digest == Rust prover');
eq(JSON.stringify(st.counts()), JSON.stringify({ note: 0, spent: 1, live: 0, burn: 1, height: 0 }), 'genesis counts (empty live, sentinels)');
eq(st.liveRoot(), st.poolRoot(), 'empty live root == empty note-tree root (both keccak_merkle_root([]))');

// 2. live-set root matches Rust for a known 2-entry set (insertion order irrelevant — key-sorted).
//    Each entry carries (key, value=commitment_hash, asset); the asset is committed in the root.
const ls = pool.makeLiveUtxoSet();
ls.insert(last('30'), first('c3'), first('bb'));
ls.insert(last('10'), first('a1'), first('aa'));
eq(ls.root(), LIVE2_ROOT, 'live-set root == Rust (key-sorted, O(live), asset-committed)');
eq(JSON.stringify(ls.get(last('10'))), JSON.stringify([first('a1'), first('aa')]), 'get resolves → [value, asset]');
eq(ls.get(last('99')), null, 'get of an absent outpoint is null');
eq(JSON.stringify(ls.remove(last('10'))), JSON.stringify([first('a1'), first('aa')]), 'remove returns the stored [value, asset]');
eq(ls.len(), 1, 'one entry after remove');

// 3. assembleReflectionScanInput over: block1 = a cxfer tx with 2 outputs; block2 = a plain spend
//    of output 0 and a bridge-out burn of output 1. Checks the witness-stream shape + the digest.
const txid1 = v(0x71);               // tx1 txid (internal order, 32 bytes)
const assetId = v(0xa55e7);
// a CONSERVING cxfer (Σout = 0, no inputs) so the conservation gate folds it; real commitments +
// a valid kernel sig + BP+ range over the two zero-value outputs.
const cxf = conservingZeroCxfer(assetId, [0x0a01n, 0x0a02n]);
const mkOut = (comp, j) => { const { cx, cy } = pool.decompressCommitment(comp); return { cx, cy, compressed: comp, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(assetId, cx, cy, ZERO_OWNER), vout: j }; };
const [out0, out1] = cxf.commitments.map(mkOut);

const coords = new Map();
const batch = {
  anchorHeight: 100,
  headers: ['0x' + '00'.repeat(80), '0x' + '11'.repeat(80)], // opaque here (the guest checks PoW)
  blocks: [
    { txs: [{ txData: '0xdeadbeef', txid: txid1, vins: [], env: { type: 'cxfer', assetId, kernelSig: cxf.kernelSig, rangeProof: cxf.rangeProof, outputs: [out0, out1] } }] },
    { txs: [
      { txData: '0xfeed01', txid: v(0x72), vins: [{ prevTxid: txid1, vout: 0 }], env: null },
      { txData: '0xfeed02', txid: v(0x73), vins: [{ prevTxid: txid1, vout: 1 }], env: { type: 'burn', nullifier: pool.nullifier(out1.cx, out1.cy), dest: v(0xde) } },
    ] },
  ],
};

const d0 = st.digest();
const input = await pool.assembleReflectionScanInput(st, batch, coords);
ne(input.newDigest, d0, 'the batch advances the digest');
eq(input.newDigest, st.digest(), 'newDigest == the advanced state');
eq(input.prior.poolRoot, pool.makeScanReflectionState().poolRoot(), 'prior captured the genesis pool root');
eq(input.prior.liveCount, 0, 'prior live set was empty');

// block1: the cxfer tx declared two outputs, no spends.
eq(input.blocks[0].txs[0].outputs.length, 2, 'cxfer tx emits 2 output witnesses');
eq(input.blocks[0].txs[0].openings.length, 0, 'cxfer tx (no pool vins) has no openings');
eq(input.blocks[0].txs[0].outputs[0].vout, 0, 'output 0 carries its vout');

// block2 tx0: a plain spend of output 0 — one opening + one spent insert, no burn/outputs.
const spendTx = input.blocks[1].txs[0];
eq(spendTx.openings.length, 1, 'plain spend: one opening');
eq(spendTx.spentInserts.length, 1, 'plain spend: one spent-set insert');
eq(spendTx.burnInsert, null, 'plain spend: no burn');
eq(spendTx.openings[0].cx, out0.cx, 'opening binds output 0 coords');

// block2 tx1: a bridge-out of output 1 — one opening + spent insert + a burn insert.
const burnTx = input.blocks[1].txs[1];
eq(burnTx.openings.length, 1, 'burn: one opening');
eq(burnTx.spentInserts.length, 1, 'burn: spent insert (the burned note is also nullified)');
ne(JSON.stringify(burnTx.burnInsert), 'null', 'burn: a burn-set insert witness is emitted');

// final state: both outputs spent → live set empty again; spent has both ν; burn has one.
eq(st.counts().live, 0, 'both outputs spent → live set empty');
eq(st.counts().note, 2, 'two notes appended');
eq(st.counts().spent, 3, 'two spends + sentinel');
eq(st.counts().burn, 2, 'one bridge-out + sentinel');

// 4. value-entry (T_MINT/cmint) is SURFACED-not-folded: the conservation-closed full-scan model has
//    no free-output deposit path, so a mint's output must NOT enter bitcoinPoolRoot (it would be
//    unbacked from the reflection's view), but it must be flagged LOUD (never silently dropped).
const stM = pool.makeScanReflectionState();
const noteBefore = stM.counts().note;
const mintBatch = { anchorHeight: 200, headers: ['0x' + '00'.repeat(80)], blocks: [{ txs: [
  { txData: '0xmint01', txid: v(0x91), vins: [{ prevTxid: v(0x90), vout: 0 }], env: { type: 'mint', assetId: v(0xa55e7) } },
] }] };
const mintInput = await pool.assembleReflectionScanInput(stM, mintBatch, new Map());
eq(mintInput.unreflectedValueEntry.length, 1, 'the mint is surfaced as an unreflected value-entry');
eq(mintInput.unreflectedValueEntry[0].txid, v(0x91), 'the surfaced entry names the mint txid');
eq(stM.counts().note, noteBefore, 'the mint folds NO note (value does not enter bitcoinPoolRoot)');
eq(mintInput.blocks[0].txs[0].outputs.length, 0, 'the mint tx emits no output witnesses (guest skips it identically)');

// The exec harness (exec-reflect-prove.rs / exec-reflect-fixture.rs write_stdin) reads EXACTLY
// this JSON shape in the guest's io::read order. Lock it so an assembler field rename can't
// silently desync the box stream from the guest.
//   prior: poolRoot,noteCount, spentRoot,spentCount, live:[[key,value,asset]…], burnRoot,burnCount, height
const P = input.prior;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };
ok(Array.isArray(P.live) && P.live.every((t) => Array.isArray(t) && t.length === 3), 'prior.live is [key,value,asset] triples (harness reads p["live"])');
ok(['poolRoot','noteCount','spentRoot','spentCount','live','burnRoot','burnCount','height'].every((k) => k in P), 'prior has every field the harness writes');
const sI = burnTx.spentInserts[0];
ok(['sLowValue','sLowNext','sLowIndex','sLowPath','sNewPath'].every((k) => k in sI), 'spentInsert has the harness fields');
const bI = burnTx.burnInsert;
ok(['bLowKey','bLowNext','bLowValue','bLowIndex','bLowPath','bNewPath'].every((k) => k in bI), 'burnInsert has the harness fields');
const oW = input.blocks[0].txs[0].outputs[0];
// the note leaf is DERIVED in-guest (reflected_note_leaf), so the harness streams only notePath + vout.
ok(['notePath','vout'].every((k) => k in oW), 'output has the streamed harness fields (notePath,vout)');
ok(['cx','cy'].every((k) => k in spendTx.openings[0]), 'opening has cx,cy');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall full-scan reflection checks passed');
