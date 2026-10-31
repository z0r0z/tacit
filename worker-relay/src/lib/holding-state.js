// A pool's state at a snapshot block from its stored Transact events: the note-tree root the pool announced (its own, checked
// against the pool's root history by the caller), the leaf count, and the spent set with its sparse-tree root. The events must
// run unbroken from the pool's first insertion to the block, or the state is refused.
import { smtRoot } from './evm-pool-snapshot.js';

export class HoldingStateError extends Error {}

const EMPTY = 0n;

// Whether a stored word (hex, or decimal text, or a bigint) is zero, without making a bigint of it: a pool's events carry four such words each and
// most of them are empty.
const ZERO_WORD = /^(?:0[xX])?0*$/;
export const isZero = (x) => (typeof x === 'string' ? ZERO_WORD.test(x) : BigInt(x) === EMPTY);

// events: [{ block, logIndex, firstIndex, outLeaf0, outLeaf1, nf0, nf1, newRoot }] (hex or bigint), every event of the pool up to
// at least `block`. emptyRoot: the root of an empty tree. The spent-set root is the costly part and is left null (nfRoot: false) for
// a caller that has more to check first.
// ordered: the events already come in (block, logIndex) order, as the store's iterator gives them. They are then read once, one at a
// time, and nothing is built from them but the state. Any other order is sorted first, which takes a copy of every event and a parsed
// copy again (seven BigInts and two arrays each): for Base's pool, 135,000 events on 2026-10-31, the state took 175 MB of a heap of 256.
export function poolStateAt({ events, block, hash, emptyRoot, nfRoot = true, ordered = false }) {
  const rows = ordered ? events : [...events].sort((a, b) => Number(a.block) - Number(b.block) || Number(a.logIndex) - Number(b.logIndex));
  let root = BigInt(emptyRoot), last = null, size = 0n, again = false;
  const nullifiers = [], seen = new Set();
  const spend = (raw) => {
    if (isZero(raw)) return;
    const nf = BigInt(raw);
    if (seen.has(nf)) again = true;          // said after the loop, as before: a missing event is reported first
    seen.add(nf);
    nullifiers.push(nf);
  };
  for (const e of rows) {
    const at = Number(e.block);
    if (at > block) break;
    if (!isZero(e.outLeaf0) || !isZero(e.outLeaf1)) {
      const first = BigInt(e.firstIndex);
      if (first !== size) throw new HoldingStateError(`Transact at index ${first} in block ${at}, expected ${size}: an event is missing`);
      size += 2n;
    }
    last = e.newRoot;                          // the pool's root after the last event is the only one kept
    spend(e.nf0);
    spend(e.nf1);
  }
  if (again) throw new HoldingStateError('a nullifier appears twice');
  if (last !== null) root = BigInt(last);
  return { block, root, size: Number(size), nullifiers, nfRoot: nfRoot ? smtRoot(nullifiers, hash) : null };
}

// The root of an empty note tree of `depth` levels, empty leaf 0.
export function emptyRootOf(hash, depth = 32) {
  let z = 0n;
  for (let i = 0; i < depth; i++) z = hash([z, z]);
  return z;
}
