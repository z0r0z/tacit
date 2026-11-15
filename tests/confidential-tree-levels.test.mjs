// The pool's Merkle tree (dapp/confidential-pool.js Tree) keeps the levels it computed instead of hashing every leaf again for each root and each path.
// The root and every path must be what the rebuild gave (rootAndPathFresh, the old algorithm kept as a reference), for every size, every index, and
// through inserts between queries; and the indexer hands the same tree out again only for the same leaves.
//   node --test tests/confidential-tree-levels.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const leaf = (i) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode('leaf' + i))).toString('hex');
const treeOf = (n) => { const t = new pool.Tree(); for (let i = 0; i < n; i++) t.insert(leaf(i)); return t; };

test('every size and every index: the same root and path as the rebuild', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 127, 128, 129, 255, 256, 257, 300]) {
    const t = treeOf(n);
    const idx = n === 0 ? [0] : [...new Set([0, 1, n >> 1, n - 2, n - 1, n, n + 1, 1000].filter((i) => i >= 0))];
    for (const i of idx) assert.deepStrictEqual(t.rootAndPath(i), t.rootAndPathFresh(i), `${n} leaves, index ${i}`);
    assert.strictEqual(t.root(), t.rootAndPathFresh(0).root, `${n} leaves, root`);
  }
});

test('queries between inserts see the leaves inserted so far', () => {
  const t = new pool.Tree();
  for (let i = 0; i < 70; i++) {
    t.insert(leaf(i));
    assert.strictEqual(t.root(), t.rootAndPathFresh(0).root, `after ${i + 1} leaves`);
    if (i % 7 === 0) for (const j of [0, i >> 1, i]) assert.deepStrictEqual(t.rootAndPath(j), t.rootAndPathFresh(j), `path ${j} after ${i + 1}`);
  }
});

test('the levels are made once for the leaves a tree has, and again after an insert', () => {
  const t = treeOf(200);
  const a = t.levels(), b = t.levels();
  assert.strictEqual(a, b, 'asked again, the same levels');
  t.root(); t.rootAndPath(5); t.rootAndPath(199);
  assert.strictEqual(t.levels(), a, 'a root and paths do not make them again');
  t.insert(leaf(200));
  assert.notStrictEqual(t.levels(), a, 'an insert does');
  assert.strictEqual(t.root(), t.rootAndPathFresh(0).root);
});

test('a path asked for by a note is the one a verifier folds to the root', () => {
  const t = treeOf(97);
  for (const i of [0, 1, 50, 96]) {
    const { root, path } = t.rootAndPath(i);
    let h = Uint8Array.from(Buffer.from(leaf(i).slice(2), 'hex'));
    for (let d = 0; d < path.length; d++) {
      const sib = Uint8Array.from(Buffer.from(path[d].slice(2), 'hex'));
      const pair = (i >>> d) & 1 ? [sib, h] : [h, sib];
      h = keccak_256(Uint8Array.from([...pair[0], ...pair[1]]));
    }
    assert.strictEqual('0x' + Buffer.from(h).toString('hex'), root, `leaf ${i} folds to the root`);
  }
});

test('the indexer hands out the tree it built for the same leaves, and a new one for any other', () => {
  const a = makeConfidentialIndexer({ secp, keccak256: keccak_256, sha256 }), b = makeConfidentialIndexer({ secp, keccak256: keccak_256, sha256 });
  const leaves = (n) => Array.from({ length: n }, (_, i) => ({ leaf: leaf(i), memo: '0x', leafIndex: i }));
  const t1 = a.buildTree(leaves(50));
  assert.strictEqual(a.buildTree(leaves(50)), t1, 'the same leaves: the same tree');
  assert.strictEqual(b.buildTree(leaves(50)), t1, 'also for another indexer on the page');
  const t2 = a.buildTree(leaves(51));
  assert.notStrictEqual(t2, t1, 'one more leaf: a new tree');
  assert.strictEqual(t2.root(), treeOf(51).rootAndPathFresh(0).root, 'and it is the right one');
  assert.strictEqual(t1.root(), treeOf(50).rootAndPathFresh(0).root, 'the first one is left as it was');
  const other = leaves(51); other[10] = { leaf: leaf(9999), memo: '0x', leafIndex: 10 };
  const t3 = a.buildTree(other);
  assert.notStrictEqual(t3, t2, 'a different leaf in the middle: a new tree');
  assert.strictEqual(t3.root(), (() => { const t = new pool.Tree(); other.forEach((l) => t.insert(l.leaf)); return t.rootAndPathFresh(0).root; })());
  assert.throws(() => a.buildTree([{ leaf: leaf(0) }, undefined]), /leaf gap at index 1/, 'a gap is still refused');
});

test('and it is faster: a root and a note\'s path cost one build, not one each', () => {
  const n = 4000, t = treeOf(n), u = treeOf(n);
  const t0 = performance.now(); for (let k = 0; k < 6; k++) u.rootAndPathFresh(k * 600); const fresh = performance.now() - t0;
  const t1 = performance.now(); for (let k = 0; k < 6; k++) t.rootAndPath(k * 600); const kept = performance.now() - t1;
  console.log(`  ${n} leaves, six paths: rebuilt each time ${fresh.toFixed(0)} ms, levels kept ${kept.toFixed(0)} ms (${(fresh / kept).toFixed(1)}x)`);
  assert.ok(kept < fresh / 2, 'at least twice as fast for six paths');
});
