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

// my wallet scan key + a stranger
const myPriv = randomScalar(), myPub = pubHex(myPriv);
const sPriv = randomScalar(), sPub = pubHex(sPriv);

// helper: turn a note into the on-chain leaf hash + encoded memo (sealed to `pub`)
function emit(note, pub) {
  const { cx, cy } = memo.commitXY(note.value, note.blinding);
  const leaf = memo.leafHash(note.asset, cx, cy, note.owner);
  const enc = memo.encodeMemo(memo.sealMemo(pub, note, randomScalar));
  return { leaf, memo: enc, cx, cy };
}

const noteA = { value: 4242n, blinding: randomScalar(), secret: '0x' + 'a1'.repeat(32), asset: ASSET, owner: pool.nkToOwner('0x' + 'a1'.repeat(32)) };
const noteStranger = { value: 99n, blinding: randomScalar(), secret: '0x' + 'b2'.repeat(32), asset: ASSET, owner: pool.nkToOwner('0x' + 'b2'.repeat(32)) };
const noteB = { value: 10n, blinding: randomScalar(), secret: '0x' + 'c3'.repeat(32), asset: ASSET, owner: pool.nkToOwner('0x' + 'c3'.repeat(32)) };

const a = emit(noteA, myPub);
const s = emit(noteStranger, sPub);
const b = emit(noteB, myPub);

// settle #1: leaves 0 (mine), 1 (stranger). settle #2: leaf 2 (mine), spends noteB.
const events = [
  { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [a.leaf, s.leaf], memos: [a.memo, s.memo] },
  { type: 'LeavesInserted', firstLeafIndex: 2, leaves: [b.leaf], memos: [b.memo] },
  // OWNER is non-zero (an OWNED note, not a bearer note), so its nullifier is nk-bound via nativeNu —
  // pool.nullifier(leaf) is the BEARER (owner==0) formula and would record the wrong value here, matching
  // this repo's own documented gotcha: a bearer-formula nullifier on an owned note never reads spent.
  { type: 'NullifiersSpent', nullifiers: [pool.nativeNu(noteB.owner, noteB.secret, b.leaf)] },
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

// ── a settle whose memos sit on the wrong leaves: the notes are still found from the key alone ──
// A batch whose ops went in an order the pool pairs wrong (an op that makes locks ahead of one that makes notes; seen on mainnet at block 26474996: two note leaves and one lock leaf,
// memos of 322, 169 and 169 bytes) put a stealth lock's memo on the first note leaf and the transfer's two note memos one place on, the second on the lock's place. The pool emits the
// whole list with LeavesInserted, so every memo is in the event; the leaves of a shifted settle carry the others and are tried with them after their own.
{
  const xN = { value: 7000n, blinding: randomScalar(), secret: '0x' + 'd4'.repeat(32), asset: ASSET, owner: pool.nkToOwner('0x' + 'd4'.repeat(32)) };
  const yN = { value: 3000n, blinding: randomScalar(), secret: '0x' + 'e5'.repeat(32), asset: ASSET, owner: pool.nkToOwner('0x' + 'e5'.repeat(32)) };
  const x = emit(xN, myPub), y = emit(yN, myPub);
  const NOTE_BYTES = (x.memo.length - 2) / 2;
  assert.ok(NOTE_BYTES !== 145 && NOTE_BYTES !== 322, 'a note memo is not the size of a stealth lock memo');
  const STEALTH = '0x' + 'ee'.repeat(322);                       // what the lock's op sealed: 322 bytes (recipient + sender tail)
  const shiftedEv = { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [x.leaf, y.leaf], memos: [STEALTH, x.memo, y.memo] };   // as the chain held it
  const orderedEv = { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [x.leaf, y.leaf], memos: [x.memo, y.memo, STEALTH] };   // as the relay builds it now
  const nu = (nn, lf) => pool.nativeNu(nn.owner, nn.secret, lf);

  // the shape check: what is shifted, what is not
  assert.strictEqual(memo.shiftedMemos(2, shiftedEv.memos), true, 'a stealth-sized memo on a note place is shifted');
  assert.strictEqual(memo.shiftedMemos(2, orderedEv.memos), false, 'notes first and the lock last is in order');
  assert.strictEqual(memo.shiftedMemos(2, [x.memo, y.memo]), false, 'no lock places: nothing to have moved across');
  assert.strictEqual(memo.shiftedMemos(2, [x.memo, y.memo, '0x']), false, 'a swap\'s cut lock has no memo and is in its place');
  assert.strictEqual(memo.shiftedMemos(2, [x.memo, '0x', y.memo]), true, 'an empty memo on a note place and a note memo on the lock place is shifted');
  assert.strictEqual(memo.shiftedMemos(1, ['0x', STEALTH]), true, 'a note place without a memo is the shape of a bridge mint: tried with the others, harmlessly');
  assert.strictEqual(memo.shiftedMemos(2, [x.memo, y.memo, '0x' + 'ee'.repeat(145)]), false, 'a recipient-only stealth memo last is in order');
  ok('shiftedMemos tells a settle whose notes\' and locks\' memos are on the wrong places from one that is in order, by memo size alone');

  // without the alternatives, the old reading finds nothing of the two notes; with them it finds both
  const bare = idx.index([shiftedEv]).leaves.map(({ leaf, memo: m, leafIndex }) => ({ leaf, memo: m, leafIndex }));
  assert.strictEqual(memo.scan(myPriv, bare, [], nu).length, 0, 'one memo per leaf, as before: neither note opens');
  const found = idx.recover([shiftedEv], myPriv);
  assert.deepStrictEqual(found.map((f) => [f.leafIndex, f.value]).sort(), [[0, 7000n], [1, 3000n]], 'both notes are found from the key, each on its own leaf');
  assert.ok(found.every((f) => pool.verifyPath(f.leaf, f.leafIndex, f.path, f.root)), 'with spendable membership paths');
  assert.deepStrictEqual(found.map((f) => f.nullifier).sort(), [nu({ ...xN }, x.leaf), nu({ ...yN }, y.leaf)].sort(), 'and the nullifiers the chain will record');
  assert.strictEqual(idx.recover([shiftedEv], sPriv).length, 0, 'a stranger\'s key opens nothing of them');
  ok('recover: the two notes of a settle with shifted memos are found from the wallet key alone');

  // a settle in order offers nothing more: no alternatives, the same result
  const inOrder = idx.index([orderedEv]).leaves;
  assert.ok(inOrder.every((l) => l.alts === undefined), 'a settle in order carries no alternatives, so a scan costs what it did');
  assert.deepStrictEqual(idx.recover([orderedEv], myPriv).map((f) => f.value).sort(), [3000n, 7000n]);
  ok('a settle in order is read as it was');

  // the sliced scan the wallet uses: a checkpoint that says everything below leaf 2 was done, and the tried-memo record of an earlier scan, do not hide them
  const withAlts = idx.index([shiftedEv]).leaves;
  const earlier = await memo.scanSliced(myPriv, bare, [], nu);
  assert.strictEqual(earlier.length, 0, 'a scan before the alternatives existed rules both out on their own memos, and keeps that');
  const again = await memo.scanSliced(myPriv, withAlts, [], nu, { covered: { upTo: 2, mine: [] } });
  assert.deepStrictEqual(again.map((f) => [f.leafIndex, f.value]).sort(), [[0, 7000n], [1, 3000n]], 'a later scan with the alternatives, over a checkpoint that covers them and a tried record that ruled them out, finds both');
  const ruledOut = await memo.scanSliced(myPriv, withAlts, [], nu, { filter: async (_k, texts) => new Int8Array(texts.length) });
  assert.strictEqual(ruledOut.length, 2, 'the prefilter speaks of a leaf\'s own memo only: a shifted settle\'s leaves are opened in full');
  const ordinary = await memo.scanSliced(myPriv, inOrder, [], nu, { filter: async (_k, texts) => new Int8Array(texts.length) });
  assert.strictEqual(ordinary.length, 0, 'and a leaf the prefilter rules out, with nothing shifted, stays ruled out');
  ok('scanSliced: a checkpoint, an earlier tried record and the prefilter do not hide the notes of a shifted settle');
}

console.log(`\n${n}/9 confidential-indexer checks passed`);
