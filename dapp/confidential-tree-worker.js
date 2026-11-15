// Module worker: makes the lower levels of a chunk of the pool's Merkle tree off the page's thread (confidential-tree-core.js lower: each level one hash of every pair of the one
// below, about a hash for each leaf of the chunk, some fifty microseconds). For the live UTXO set, whose leaves are themselves hashes of records, it makes the chunk's leaves first.
//   { id, leaves: ArrayBuffer (count × 32 bytes), count, h } → { id, levels: [ArrayBuffer × h] }, level j + 1 of the chunk in levels[j], handed back rather than copied
//   { id, leaves: ArrayBuffer (count × 129 bytes of preimages), count, h, pre: true } → { id, leaves: ArrayBuffer (count × 32), levels }
// It runs the function the page runs. Nothing it holds is secret: the leaves are the pool's, on chain.
import { keccak_256 } from './vendor/tacit-deps.min.js';
import { makeTreeCore } from './confidential-tree-core.js';

const core = makeTreeCore({ keccak256: keccak_256 });

self.onmessage = ({ data }) => {
  const { id, leaves, count, h, pre } = data || {};
  try {
    const made = pre ? core.hashLeaves(new Uint8Array(leaves), count) : new Uint8Array(leaves);
    const levels = core.lower(made, count, h).map((b) => b.buffer);
    if (pre) self.postMessage({ id, leaves: made.buffer, levels }, [made.buffer, ...levels]);
    else self.postMessage({ id, levels }, levels);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
