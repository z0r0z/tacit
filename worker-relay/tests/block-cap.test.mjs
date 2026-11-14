// The size of the reflection job the lane asks for (src/lib/block-cap.js): halved when the prover network refuses a batch it
// cannot execute, raised one block at a time while batches prove at the full ask, never moved by a failure that is not that.
// node --test tests/block-cap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBlockCap, isUnexecutable, BLOCK_CAP_MAX } from '../src/lib/block-cap.js';

test('a refused batch halves the ask, down to one block', () => {
  assert.equal(nextBlockCap(null, { unexecutable: true, blocks: 20 }), 10);
  assert.equal(nextBlockCap(10, { unexecutable: true, blocks: 10 }), 5);
  assert.equal(nextBlockCap(5, { unexecutable: true, blocks: 5 }), 2);
  assert.equal(nextBlockCap(2, { unexecutable: true, blocks: 2 }), 1);
  assert.equal(nextBlockCap(3, { unexecutable: true, blocks: 3 }), 1);
});

test('the halving follows the batch that failed, not the old ask', () => {
  // The lane was nearly caught up and the job held 3 blocks under an ask of 8.
  assert.equal(nextBlockCap(8, { unexecutable: true, blocks: 3 }), 1);
});

test('a refusal at one block is not about size, so the ask does not move', () => {
  assert.equal(nextBlockCap(null, { unexecutable: true, blocks: 1 }), null);
  assert.equal(nextBlockCap(1, { unexecutable: true, blocks: 1 }), 1);
});

test('a failure that is not a refusal leaves the ask alone', () => {
  assert.equal(nextBlockCap(4, { blocks: 4 }), 4);
  assert.equal(nextBlockCap(null, { blocks: 20 }), null);
});

test('a batch proved at the full ask raises it by one', () => {
  assert.equal(nextBlockCap(2, { proved: true, blocks: 2 }), 3);
  assert.equal(nextBlockCap(6, { proved: true, blocks: 6 }), 7);
});

test('a smaller job than the ask teaches nothing, and no ask stays no ask', () => {
  assert.equal(nextBlockCap(6, { proved: true, blocks: 2 }), 6);
  assert.equal(nextBlockCap(null, { proved: true, blocks: 20 }), null);
});

test('the ask is dropped once it reaches the ceiling', () => {
  assert.equal(nextBlockCap(BLOCK_CAP_MAX - 1, { proved: true, blocks: BLOCK_CAP_MAX - 1 }), null);
});

test('a refuse / grow sequence settles near the size the limit allows', () => {
  // A limit that fits 4 blocks: the ask halves from the API cap, then climbs until it is refused again.
  const fits = (n) => n <= 4;
  let cap = null, refused = 0;
  for (let i = 0; i < 40; i++) {
    const asked = cap ?? 20;
    if (fits(asked)) cap = nextBlockCap(cap ?? asked, { proved: true, blocks: asked });
    else { refused++; cap = nextBlockCap(cap, { unexecutable: true, blocks: asked }); }
  }
  assert.ok(cap === null || cap <= 5, `ask ended at ${cap}`);
  assert.ok(refused >= 1 && refused <= 14, `${refused} refusals in 40 cycles`);
});

test('isUnexecutable reads the network refusal off stderr and nothing else', () => {
  assert.equal(isUnexecutable("thread 'main' panicked at src/bin/bitcoin_prove.rs:105:98:\ngroth16 proof failed: Proof request 0xb50868ef5b0a is unexecutable"), true);
  assert.equal(isUnexecutable('groth16 proof failed: Proof request 0xabc is unfulfillable'), true);
  assert.equal(isUnexecutable('peak memory 861MB'), false);
  assert.equal(isUnexecutable('ENOENT: no such file or directory'), false);
  assert.equal(isUnexecutable(undefined), false);
});

// The prover board's limit on a btc-state input (worker/src/prover-board.js), and batches the lane built on 2026-11-14 that were over it.
const BOARD = 16 * 1024 * 1024;

test('a batch over the board\'s limit is asked for again at the share of its blocks that fits, with room to spare', () => {
  assert.equal(nextBlockCap(null, { blocks: 16, bytes: 46_700_924, maxBytes: BOARD }), 4);
  assert.equal(nextBlockCap(null, { blocks: 10, bytes: 28_176_757, maxBytes: BOARD }), 5);
  assert.equal(nextBlockCap(6, { blocks: 6, bytes: 17_603_580, maxBytes: BOARD }), 4);
  // Just over: still one block fewer, so the next job is smaller.
  assert.equal(nextBlockCap(null, { blocks: 6, bytes: BOARD + 1, maxBytes: BOARD }), 5);
});

test('one block over the board\'s limit cannot be cut, and a batch within it is not cut', () => {
  assert.equal(nextBlockCap(null, { blocks: 1, bytes: BOARD * 2, maxBytes: BOARD }), null);
  assert.equal(nextBlockCap(3, { blocks: 1, bytes: BOARD * 2, maxBytes: BOARD }), 3);
  assert.equal(nextBlockCap(5, { blocks: 5, bytes: BOARD, maxBytes: BOARD }), 5);
  assert.equal(nextBlockCap(5, { proved: true, blocks: 5, bytes: BOARD - 1, maxBytes: BOARD }), 6);
  assert.equal(nextBlockCap(5, { blocks: 5, bytes: BOARD * 2, maxBytes: 0 }), 5, 'no limit set');
});

test('a catch-up after a long header wait is cut until every batch fits the board, and the ask settles near the size that fits', () => {
  // Blocks of 1.5 to 4 MB of input; 16 blocks matured at once; each cut asks again at once.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const sizes = Array.from({ length: 400 }, () => Math.round(1.5e6 + rnd() * 2.5e6));
  let cap = null, at = 0, builds = 0, posted = 0, over = 0;
  while (at < sizes.length) {
    assert.ok(builds < 1000, 'the cuts made no progress');
    const n = Math.min(cap ?? 16, 16, sizes.length - at);
    const bytes = sizes.slice(at, at + n).reduce((a, b) => a + b, 0);
    builds++;
    if (bytes > BOARD && n > 1) { over++; cap = nextBlockCap(cap, { blocks: n, bytes, maxBytes: BOARD }); continue; }
    assert.ok(bytes <= BOARD, `a ${n}-block batch of ${bytes} bytes went out`);
    posted++; at += n;
    cap = nextBlockCap(cap, { proved: true, blocks: n });
  }
  assert.ok(posted >= 70 && posted <= 110, `${posted} batches for 400 blocks`);
  assert.ok(over / builds < 0.45, `${over} of ${builds} builds were over the limit`);
});
