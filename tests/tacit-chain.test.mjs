// The pool's history as blocks (worker/src/tacit-chain.js): a transaction that changes notes is a block and a deposit alone is not,
// a transaction in a block the index has not finished waits, each block's hash chains to the one before and is the documented
// keccak of its fields, a block names the community prover of one of its leaves, and a read pages back and comes from storage while fresh.
// Run: node --test tests/tacit-chain.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { makeChain, blockHash, bodyOf, txGroups } from '../worker/src/tacit-chain.js';

const h32 = (n) => '0x' + n.toString(16).padStart(64, '0');
const ZERO = h32(0);
let seq = 0;
const ent = (type, block, tx, extra = {}) => ({ seq: seq++, type, block, tx: h32(tx), logIndex: seq, ...extra });

function store() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}
function index(entries, indexedToBlock) {
  const ix = { reads: 0, entries, indexedToBlock, fresh: async () => {} };
  ix.read = async ({ from, limit }) => { ix.reads++; const e = ix.entries.filter((x) => x.seq >= from).slice(0, limit); return { entries: e, indexedToBlock: ix.indexedToBlock, total: ix.entries.length }; };
  return ix;
}

test('the hash is keccak(prev ‖ height ‖ ethBlock ‖ tx ‖ keccak(leaves) ‖ keccak(nullifiers)) with 8-byte big-endian numbers', () => {
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
  const want = '0x' + bytesToHex(keccak_256(concatBytes(hexToBytes(ZERO.slice(2)), u64(0), u64(100), hexToBytes(h32(7).slice(2)),
    keccak_256(hexToBytes(h32(1).slice(2) + h32(2).slice(2))), keccak_256(new Uint8Array(0)))));
  assert.equal(blockHash({ prev: ZERO, height: 0, ethBlock: 100, tx: h32(7), leaves: [h32(1), h32(2)], nullifiers: [] }), want);
});

test('a deposit alone is no block; a settle with its deposit is one; lock leaves and nullifiers follow the notes\'', () => {
  assert.equal(bodyOf([ent('wrap', 1, 1)]), null);
  const b = bodyOf([ent('wrap', 2, 2), ent('nullifiers', 2, 2, { nullifiers: [h32(9)] }), ent('leaves', 2, 2, { leaves: [h32(3)] }),
    ent('locks', 2, 2, { lockLeaves: [h32(4)], lockNullifiers: [h32(8)] })]);
  assert.deepEqual(b, { ethBlock: 2, tx: h32(2), leaves: [h32(3), h32(4)], nullifiers: [h32(9), h32(8)], notes: 1, spent: 1, deposits: 1 });
  assert.equal(bodyOf([ent('leaves', 3, 3, { leaves: [h32(5)], excluded: true })]), null, 'an excluded row counts for nothing');
});

test('a transaction in a block the index has not finished waits for it', () => {
  const g = txGroups([ent('leaves', 5, 5, { leaves: [h32(1)] }), ent('nullifiers', 5, 5, { nullifiers: [h32(2)] }), ent('leaves', 6, 6, { leaves: [h32(3)] })], 5);
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 2);
});

test('blocks chain from height 0, name a community prover, page back, and are read from storage while fresh', async () => {
  seq = 0;
  const entries = [
    ent('wrap', 10, 1),
    ent('nullifiers', 11, 2, { nullifiers: [h32(20)] }), ent('leaves', 11, 2, { leaves: [h32(21)] }),
    ent('wrap', 12, 3), ent('leaves', 12, 3, { leaves: [h32(22), h32(23)] }),
    ent('leaves', 13, 4, { leaves: [h32(24)] }),
  ];
  const kv = store(), ix = index(entries, 13);
  let t = 1_000_000;
  const chain = makeChain({ kv, index: ix, now: () => t, cfg: { keep: 200, page: 2, maxPagesPerSync: 40, staleMs: 10_000 },
    minedBy: async (leaves) => (leaves.includes(h32(23)) ? { [h32(23)]: { miner: '0x' + '11'.repeat(20), points: 20 } } : {}) });
  const r = await chain.blocks({ limit: 10 });
  assert.deepEqual(r.blocks.map((b) => [b.height, b.ethBlock, b.notes, b.spent, b.deposits]), [[2, 13, 1, 0, 0], [1, 12, 2, 0, 1], [0, 11, 1, 1, 0]]);
  assert.equal(r.blocks[2].prev, ZERO);
  assert.equal(r.blocks[1].prev, r.blocks[2].hash);
  assert.equal(r.blocks[0].prev, r.blocks[1].hash);
  assert.equal(r.head.hash, r.blocks[0].hash);
  assert.equal(r.blocks[2].hash, blockHash({ prev: ZERO, height: 0, ethBlock: 11, tx: h32(2), leaves: [h32(21)], nullifiers: [h32(20)] }));
  assert.equal(r.blocks[1].prover, '0x' + '11'.repeat(20));
  assert.equal(r.blocks[1].points, 20);
  assert.equal(r.blocks[0].prover, undefined, 'a block nobody in the community proved names nobody');
  assert.equal(r.blocks[0].leaves, undefined, 'a read carries counts, not the lists');
  assert.deepEqual((await chain.blocks({ before: 2, limit: 1 })).blocks.map((b) => b.height), [1]);
  // fresh: no index read; stale: only what is new
  const reads = ix.reads;
  await chain.blocks();
  assert.equal(ix.reads, reads);
  ix.entries.push(ent('nullifiers', 14, 5, { nullifiers: [h32(30)] }));
  ix.indexedToBlock = 14;
  t += 11_000;
  const r2 = await chain.blocks({ limit: 1 });
  assert.equal(r2.head.height, 3);
  assert.equal(r2.blocks[0].prev, r.head.hash);
});
