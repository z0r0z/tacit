#!/usr/bin/env node
// Phase 4.2 — the reflection indexer's Δ-witnesses (makeReflectionState.witnessTransfer /
// witnessBridgeOut) are exactly what the reflection prover folds: replaying the prover's
// witnessed transitions (cxfer-core keccak_tree_append / imt_insert / utxo_insert / utxo_remove)
// on the prior roots + the JS-built witnesses reproduces the indexer's new roots. If this holds,
// the prover accepts the indexer's witnesses and lands on the same digest the contract chains.
//
// Run: node tests/confidential-reflection-witness.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const { imtLeaf, utxoLeaf, verifyPath, merkleRootFrom, nullifier, commitmentHash } = pool;
const ZERO = '0x' + '00'.repeat(32);
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

let failures = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${msg}`); };
const ok = (c, msg) => { if (!c) { console.error(`FAIL ${msg}`); failures++; } else console.log(`ok   ${msg}`); };

// ── the prover's witnessed transitions, replayed (mirror cxfer-core) ──
function appendT(prior, nextIndex, path, leaf) {
  ok(verifyPath(ZERO, nextIndex, path, prior), 'append: slot empty in prior');
  return merkleRootFrom(leaf, nextIndex, path);
}
function imtInsertT(prior, nu, lowV, lowN, lowI, lowP, newI, newP) {
  ok(verifyPath(imtLeaf(lowV, lowN), lowI, lowP, prior), 'imt: low ∈ prior');
  const interm = merkleRootFrom(imtLeaf(lowV, nu), lowI, lowP);
  ok(verifyPath(ZERO, newI, newP, interm), 'imt: new slot empty in intermediate');
  return merkleRootFrom(imtLeaf(nu, lowN), newI, newP);
}
function utxoInsertT(prior, key, val, lowK, lowN, lowV, lowI, lowP, newI, newP) {
  ok(verifyPath(utxoLeaf(lowK, lowN, lowV), lowI, lowP, prior), 'utxo+: low ∈ prior');
  const interm = merkleRootFrom(utxoLeaf(lowK, key, lowV), lowI, lowP);
  ok(verifyPath(ZERO, newI, newP, interm), 'utxo+: new slot empty in intermediate');
  return merkleRootFrom(utxoLeaf(key, lowN, val), newI, newP);
}
function utxoRemoveT(prior, key, nodeN, nodeV, nodeI, nodeP, predK, predV, predI, predP) {
  ok(verifyPath(utxoLeaf(predK, key, predV), predI, predP, prior), 'utxo-: pred ∈ prior');
  const interm = merkleRootFrom(utxoLeaf(predK, nodeN, predV), predI, predP);
  ok(verifyPath(utxoLeaf(key, nodeN, nodeV), nodeI, nodeP, interm), 'utxo-: node ∈ intermediate');
  return merkleRootFrom(ZERO, nodeI, nodeP);
}

const rs = pool.makeReflectionState();

// 1. deposit: witness one output, replay append + utxo-insert against the prior roots.
const cx0 = v(0x0a), cy0 = v(0x1a), op0 = v(0xa0), leaf0 = v(0x1aa), com0 = commitmentHash(cx0, cy0);
let pPool = rs.poolRoot(), pUtxo = rs.utxoRoot(), c = rs.counts();
let w = rs.witnessTransfer([], [{ noteLeaf: leaf0, outpoint: op0, commitmentHash: com0 }], 100);
const ow = w.outputs[0];
eq(appendT(pPool, c.note, ow.notePath, ow.noteLeaf), rs.poolRoot(), 'output append reproduces poolRoot');
eq(utxoInsertT(pUtxo, ow.outpoint, ow.commitmentHash, ow.uLowKey, ow.uLowNext, ow.uLowValue, ow.uLowIndex, ow.uLowPath, c.utxo, ow.uNewPath),
   rs.utxoRoot(), 'output utxo-insert reproduces utxoRoot');

// a second deposit so there's a UTXO to spend + the trees are non-trivial
const cx1 = v(0x0b), cy1 = v(0x1b), op1 = v(0xb0), leaf1 = v(0x1bb), com1 = commitmentHash(cx1, cy1);
rs.witnessTransfer([], [{ noteLeaf: leaf1, outpoint: op1, commitmentHash: com1 }], 100);

// 2. spend note 0: replay imt-insert (spent) + utxo-remove against the prior roots.
let pSpent = rs.spentRoot(); pUtxo = rs.utxoRoot(); c = rs.counts();
w = rs.witnessTransfer([{ cx: cx0, cy: cy0, outpoint: op0 }], [], 101);
const sw = w.spends[0];
const nu0 = nullifier(cx0, cy0);
eq(imtInsertT(pSpent, nu0, sw.sLowValue, sw.sLowNext, sw.sLowIndex, sw.sLowPath, c.spent, sw.sNewPath),
   rs.spentRoot(), 'spend imt-insert reproduces spentRoot');
eq(utxoRemoveT(pUtxo, sw.outpoint, sw.uNodeNext, sw.uNodeValue, sw.uNodeIndex, sw.uNodePath, sw.uPredKey, sw.uPredValue, sw.uPredIndex, sw.uPredPath),
   rs.utxoRoot(), 'spend utxo-remove reproduces utxoRoot');

// 3. bridge-out note 1: replay the spend part + the burn-set insert.
let pBurn = rs.burnRoot(); pSpent = rs.spentRoot(); c = rs.counts();
const dest = v(0xde);
const bw = rs.witnessBridgeOut({ cx: cx1, cy: cy1, outpoint: op1, destCommitment: dest }, 102);
const nu1 = nullifier(cx1, cy1);
eq(imtInsertT(pSpent, nu1, bw.spend.sLowValue, bw.spend.sLowNext, bw.spend.sLowIndex, bw.spend.sLowPath, c.spent, bw.spend.sNewPath),
   rs.spentRoot(), 'burn spend reproduces spentRoot');
eq(utxoInsertT(pBurn, nu1, dest, bw.bLowKey, bw.bLowNext, bw.bLowValue, bw.bLowIndex, bw.bLowPath, c.burn, bw.bNewPath),
   rs.burnRoot(), 'burn-set insert reproduces burnRoot');

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS — the indexer’s witnesses fold to the indexer’s roots');
process.exit(failures ? 1 : 0);
