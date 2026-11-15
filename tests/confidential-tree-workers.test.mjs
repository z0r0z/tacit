// The pool's Merkle tree made in workers (dapp/confidential-tree-core.js, confidential-tree-worker.js, confidential-tree-workers.js, and Tree.prepare in confidential-pool.js): a tree
// prepared with workers has the levels the tree makes itself, node for node, for every size and any number of workers, and whatever the workers do, fail to do, take too long over or get
// wrong at the edges, the tree is the same tree: what the workers do not give, levels() makes as it always did.
//   node --test tests/confidential-tree-workers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeTreeCore, chunkHeight, nodesAt } from '../dapp/confidential-tree-core.js';
import { makeTreeWorkers } from '../dapp/confidential-tree-workers.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const core = makeTreeCore({ keccak256: keccak_256 });
const leaf = (i) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode('leaf' + i))).toString('hex');
const treeOf = (n) => { const t = new pool.Tree(); for (let i = 0; i < n; i++) t.insert(leaf(i)); return t; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b, what) => {
  assert.strictEqual(a.n, b.n, `${what}: n`);
  assert.strictEqual(a.levels.length, b.levels.length, `${what}: levels`);
  a.levels.forEach((lv, i) => {
    assert.strictEqual(lv.length, b.levels[i].length, `${what}: nodes at level ${i}`);
    for (let k = 0; k < lv.length; k++) if (Buffer.compare(Buffer.from(lv[k]), Buffer.from(b.levels[i][k])) !== 0) assert.fail(`${what}: node ${k} of level ${i}`);
  });
  assert.strictEqual(Buffer.from(a.top[0]).toString('hex'), Buffer.from(b.top[0]).toString('hex'), `${what}: top`);
};

// Stand-in workers that run the same function in this thread, a tick later.
function fake({ failAt = null, hangAt = null, shortAt = null, wrongAt = null, corrupt = null, made = [], opts = {}, calls = [] } = {}) {
  let n = 0;
  return makeTreeWorkers({
    available: () => true, count: () => 3, minLeaves: 1, chunkMs: 20e3, idleMs: 800, ...opts,
    make: () => {
      if (opts.makeThrows) throw new Error('no workers here');
      const w = { ended: false, onmessage: null, onerror: null, terminate() { this.ended = true; },
        postMessage({ id, leaves, count, h }) {
          const nth = n++; calls.push({ count, h });
          setTimeout(() => {
            if (w.ended || nth === hangAt) return;
            if (nth === failAt) return w.onerror?.(new Error('boom'));
            let levels = core.lower(new Uint8Array(leaves), count, h).map((b) => b.buffer);
            if (nth === shortAt) levels = levels.slice(1);
            if (nth === wrongAt) levels = levels.map((b, j) => (j === 0 ? b.slice(32) : b));
            if (corrupt && nth === corrupt.at) { const b = new Uint8Array(levels[corrupt.level]); b[corrupt.byte < 0 ? b.length + corrupt.byte : corrupt.byte] ^= 1; }
            w.onmessage?.({ data: { id, levels } });
          }, 1);
        } };
      made.push(w);
      return w;
    },
  });
}

test('the chunk height is the least h with 2^h chunks of enough to cover n in k', () => {
  assert.strictEqual(chunkHeight(7600, 4), 11);
  assert.strictEqual(chunkHeight(1024, 4), 8);
  assert.strictEqual(chunkHeight(1025, 4), 9);
  assert.strictEqual(chunkHeight(1, 4), 0);
  assert.strictEqual(chunkHeight(5, 1), 3);
  assert.strictEqual(nodesAt(7, 1), 4);
  assert.strictEqual(nodesAt(8, 3), 1);
});

test('a tree made in workers has the levels the tree makes itself, node for node, for every size and any number of workers', async () => {
  const sizes = [...Array(40).keys(), 63, 64, 65, 100, 127, 128, 129, 255, 256, 257, 300, 511, 512, 513, 1000, 1023, 1024, 1025, 2047, 2048, 2049, 3000, 4100];
  for (const count of [1, 2, 3, 4, 7]) {
    const workers = fake({ opts: { count: () => count } });
    for (const n of sizes) {
      if (n === 0) continue;
      const t = treeOf(n), want = treeOf(n).levels();
      await t.prepare(workers);
      assert.ok(t._made, `${n} leaves with ${count} workers: the levels came from the workers`);
      same(t.levels(), want, `${n} leaves, ${count} workers`);
    }
  }
});

test('the root and the path of every index of a tree made in workers are the rebuild\'s', async () => {
  for (const n of [1, 2, 3, 9, 100, 777, 1500, 2049]) {
    const t = treeOf(n);
    await t.prepare(fake());
    for (const i of [...new Set([0, 1, n >> 1, n - 1, n, n + 5, 1000])].filter((x) => x >= 0)) assert.deepStrictEqual(t.rootAndPath(i), t.rootAndPathFresh(i), `${n} leaves, index ${i}`);
    assert.strictEqual(t.root(), t.rootAndPathFresh(0).root);
  }
});

test('an empty tree, and a handful of leaves with the default threshold, are left to levels() and are the same tree', async () => {
  const t0 = new pool.Tree();
  await t0.prepare(fake());
  assert.strictEqual(t0._made, null, 'nothing is made for no leaves');
  assert.strictEqual(t0.root(), t0.rootAndPathFresh(0).root);
  const few = treeOf(40), defaults = makeTreeWorkers({ available: () => true, make: () => { throw new Error('should not start'); } });
  await few.prepare(defaults);
  assert.strictEqual(few._made, null, 'a few leaves are not worth workers');
  const bare = treeOf(40);
  await bare.prepare(null);
  assert.strictEqual(bare._made, null, 'no workers, no change');
  assert.strictEqual(few.root(), few.rootAndPathFresh(0).root);
  assert.strictEqual(bare.root(), few.root());
});

test('workers that fail, hang, answer short or answer the wrong size leave the tree to levels(), and it is the same tree', async () => {
  const n = 3000, want = treeOf(n).levels();
  const cases = {
    'a worker that fails': fake({ failAt: 1 }),
    'a worker that never answers': fake({ hangAt: 0, opts: { chunkMs: 300 } }),
    'a worker whose answer is short': fake({ shortAt: 1 }),
    'a worker whose answer is the wrong size': fake({ wrongAt: 0 }),
    'workers that cannot be made': fake({ opts: { makeThrows: true } }),
    'Workers that are not there': makeTreeWorkers({ available: () => false, minLeaves: 1 }),
    'a runner that says nothing': async () => null,
    'a runner that throws': async () => { throw new Error('nope'); },
  };
  for (const [name, workers] of Object.entries(cases)) {
    const t = treeOf(n);
    await t.prepare(workers);
    assert.strictEqual(t._made, null, `${name}: nothing was taken from it`);
    same(t.levels(), want, name);
  }
});

test('an answer wrong at an edge is not taken, and the tree is the same', async () => {
  const n = 3000, want = treeOf(n).levels(), h = chunkHeight(n, 3);
  for (const [name, corrupt] of [
    ['the last node of a level', { at: 2, level: 1, byte: -1 }],
    ['the first node of a level', { at: 0, level: 2, byte: 0 }],
    ['the last node of the top of a chunk', { at: 1, level: h - 1, byte: -1 }],
  ]) {
    const t = treeOf(n);
    await t.prepare(fake({ corrupt }));
    assert.strictEqual(t._made, null, `${name}: not kept`);
    same(t.levels(), want, name);
  }
});

test('a leaf inserted while the levels are being made is not left out: what came back is not kept, and the tree has the new leaf', async () => {
  const t = treeOf(2000);
  const p = t.prepare(fake());
  t.insert(leaf(2000));                           // before the workers answer
  await p;
  assert.strictEqual(t._made, null, 'the levels of 2,000 leaves are not the levels of 2,001');
  same(t.levels(), treeOf(2001).levels(), 'with the leaf');
  assert.strictEqual(t.root(), t.rootAndPathFresh(0).root);
});

test('asked again while the levels are being made, the tree waits for that one: the workers are asked once', async () => {
  const calls = [], t = treeOf(2500), workers = fake({ calls });
  await Promise.all([t.prepare(workers), t.prepare(workers), t.prepare(workers)]);
  const first = calls.length;
  assert.ok(first >= 1 && first <= 3, `${first} chunks`);
  assert.ok(t._made);
  await t.prepare(workers);
  assert.strictEqual(calls.length, first, 'a tree that has its levels asks nobody');
  same(t.levels(), treeOf(2500).levels(), 'the same levels');
});

test('trees are made one after another by the same workers, which are kept between them, then ended', async () => {
  const made = [], keep = fake({ made, opts: { idleMs: 800 } });
  await treeOf(1500).prepare(keep); await treeOf(2500).prepare(keep);
  const first = made.length;
  assert.ok(made.length >= 2 && made.every((w) => !w.ended), 'alive after the second tree');
  await pause(1800);
  assert.ok(made.every((w) => w.ended), 'ended once quiet');
  await treeOf(1500).prepare(keep);
  assert.ok(made.length > first, 'a later tree makes new ones');
  await pause(1800);
});

test('the shipped worker file, run in threads, makes the levels the tree makes', async () => {
  const workerFile = fileURLToPath(new URL('../dapp/confidential-tree-worker.js', import.meta.url));
  const boot = `const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    const held = []; let up = false;
    parentPort.on('message', (data) => { if (up) globalThis.self.onmessage({ data }); else held.push(data); });
    import(${JSON.stringify('file://' + workerFile)}).then(() => { up = true; for (const d of held.splice(0)) globalThis.self.onmessage({ data: d }); }, (e) => parentPort.postMessage({ failed: String(e) }));`;
  const threads = [];
  const real = makeTreeWorkers({
    available: () => true, count: () => 3, minLeaves: 1, chunkMs: 60e3, idleMs: 800,
    make: () => {
      const th = new ThreadWorker(boot, { eval: true });
      const w = { onmessage: null, onerror: null, postMessage: (x, tr) => th.postMessage(x, tr), terminate: () => th.terminate() };
      th.on('message', (data) => { if (data.failed) return w.onerror?.(new Error(data.failed)); w.onmessage?.({ data }); });
      th.on('error', (e) => w.onerror?.(e));
      threads.push(th);
      return w;
    },
  });
  for (const n of [1500, 3000, 4100]) {
    const t = treeOf(n);
    await t.prepare(real);
    assert.ok(t._made, `${n} leaves: made by the shipped worker`);
    same(t.levels(), treeOf(n).levels(), `${n} leaves`);
  }
  assert.ok(threads.length >= 2);
  await pause(1800);
});
