// A pool's state at a snapshot block from its stored Transact events: the note-tree root the pool announced (its own, checked
// against the pool's root history by the caller), the leaf count, and the spent set with its sparse-tree root. The events must
// run unbroken from the pool's first insertion to the block, or the state is refused.
import { smtRoot } from './evm-pool-snapshot.js';

export class HoldingStateError extends Error {}

const EMPTY = 0n;

// events: [{ block, logIndex, firstIndex, outLeaf0, outLeaf1, nf0, nf1, newRoot }] (hex or bigint), every event of the pool up to
// at least `block`. emptyRoot: the root of an empty tree.
export function poolStateAt({ events, block, hash, emptyRoot }) {
  const sorted = [...events].map((e) => ({
    block: Number(e.block), logIndex: Number(e.logIndex), firstIndex: BigInt(e.firstIndex), leaves: [BigInt(e.outLeaf0), BigInt(e.outLeaf1)],
    nfs: [BigInt(e.nf0), BigInt(e.nf1)], newRoot: BigInt(e.newRoot),
  })).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  let root = BigInt(emptyRoot), size = 0n;
  const nullifiers = [];
  for (const e of sorted) {
    if (e.block > block) break;
    if (e.leaves[0] !== EMPTY || e.leaves[1] !== EMPTY) {
      if (e.firstIndex !== size) throw new HoldingStateError(`Transact at index ${e.firstIndex} in block ${e.block}, expected ${size}: an event is missing`);
      size += 2n;
    }
    root = e.newRoot;
    for (const nf of e.nfs) if (nf !== EMPTY) nullifiers.push(nf);
  }
  if (new Set(nullifiers).size !== nullifiers.length) throw new HoldingStateError('a nullifier appears twice');
  return { block, root, size: Number(size), nullifiers, nfRoot: smtRoot(nullifiers, hash) };
}

// The root of an empty note tree of `depth` levels, empty leaf 0.
export function emptyRootOf(hash, depth = 32) {
  let z = 0n;
  for (let i = 0; i < depth; i++) z = hash([z, z]);
  return z;
}
