#!/usr/bin/env node
// End-to-end seed-only recovery over the confidential pool's on-chain event
// stream (dapp/confidential-indexer.js). Simulates exactly what the contract
// emits — LeavesInserted(firstLeafIndex, leaves, memos) batches + a
// NullifiersSpent — across two settles, then proves a wiped wallet reconstructs
// its active notes (with spendable membership paths) from its scan key alone.
// Stranger notes and spent notes are filtered; recovered paths fold to the root
// the indexer rebuilt; a dropped event is detected as a tree gap.
//
// Run: node tests/confidential-indexer.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const idx = makeConfidentialIndexer(deps);
const memo = makeConfidentialMemo({ secp, sha256, keccak256 });
const pool = makeConfidentialPool(deps);
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const pubHex = (priv) => '0x' + Buffer.from(G.multiply(priv).toRawBytes(true)).toString('hex');
const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '07';

// my wallet scan key + a stranger
const myPriv = randomScalar(), myPub = pubHex(myPriv);
const sPriv = randomScalar(), sPub = pubHex(sPriv);

// helper: turn a note into the on-chain leaf hash + encoded memo (sealed to `pub`)
function emit(note, pub) {
  const { cx, cy } = memo.commitXY(note.value, note.blinding);
  const leaf = memo.leafHash(note.asset, cx, cy, note.owner);
  const enc = memo.encodeMemo(memo.sealMemo(pub, note, randomScalar));
  return { leaf, memo: enc };
}

const noteA = { value: 4242n, blinding: randomScalar(), secret: '0x' + 'a1'.repeat(32), asset: ASSET, owner: OWNER };
const noteStranger = { value: 99n, blinding: randomScalar(), secret: '0x' + 'b2'.repeat(32), asset: ASSET, owner: OWNER };
const noteB = { value: 10n, blinding: randomScalar(), secret: '0x' + 'c3'.repeat(32), asset: ASSET, owner: OWNER };

const a = emit(noteA, myPub);
const s = emit(noteStranger, sPub);
const b = emit(noteB, myPub);

// settle #1: leaves 0 (mine), 1 (stranger). settle #2: leaf 2 (mine), spends noteB.
const events = [
  { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [a.leaf, s.leaf], memos: [a.memo, s.memo] },
  { type: 'LeavesInserted', firstLeafIndex: 2, leaves: [b.leaf], memos: [b.memo] },
  { type: 'NullifiersSpent', nullifiers: [pool.nullifier(noteB.secret)] },
];

// ── index folds the stream ──
const indexed = idx.index(events);
assert.strictEqual(indexed.leaves.filter(Boolean).length, 3, 'three leaves indexed in slot order');
assert.strictEqual(indexed.spent.size, 1, 'one nullifier spent');
ok('event stream folds to 3 ordered leaves + 1 spent nullifier');

// ── seed-only recovery ──
const recovered = idx.recover(events, myPriv);
assert.strictEqual(recovered.length, 1, 'one active note recovered (stranger + spent B filtered)');
const r = recovered[0];
assert.strictEqual(r.value, 4242n, 'recovered note A value');
assert.strictEqual(r.leafIndex, 0, 'note A is at slot 0');
assert.strictEqual(r.secret, noteA.secret, 'recovered note A secret');
ok('wallet recovers only its active note (value, secret, asset, owner) from seed alone');

// ── the recovered membership path actually folds to the rebuilt root ──
assert.ok(pool.verifyPath(r.leaf, r.leafIndex, r.path, r.root), 'recovered path folds to root');
ok('recovered note carries a spendable membership path that folds to the on-chain root');

// ── recovered root equals an independently rebuilt tree's root ──
const tree = new pool.Tree();
[a.leaf, s.leaf, b.leaf].forEach((lf) => tree.insert(lf));
assert.strictEqual(r.root, tree.root(), 'indexer root == independent rebuild');
ok('indexer-rebuilt root matches an independent tree rebuild');

// ── a dropped LeavesInserted is caught as a contiguity gap (not silent) ──
const holed = [
  { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [a.leaf], memos: [a.memo] },
  { type: 'LeavesInserted', firstLeafIndex: 2, leaves: [b.leaf], memos: [b.memo] }, // slot 1 missing
];
assert.throws(() => idx.recover(holed, myPriv), /leaf gap at index 1/, 'gap detected');
ok('a missed LeavesInserted event is caught as a tree gap (fail-loud)');

console.log(`\n${n}/5 confidential-indexer checks passed`);
