// Confidential-pool indexer + seed-only recovery. Consumes the pool's on-chain
// event stream (LeavesInserted + NullifiersSpent, in block/log order) and rebuilds:
//   - the append-only Keccak Merkle tree (leaves in slot order, anchored by the
//     firstLeafIndex each LeavesInserted carries)
//   - the spent-nullifier set
//   - the encrypted memo aligned to every leaf
// then recovers a wallet's active notes from its scan key alone — each with the
// membership path needed to spend it. The contract's memo data-availability is
// what makes this work with NO off-chain note storage: a wiped wallet recovers
// its whole confidential balance from chain + seed, exactly like the Bitcoin side.
//
// Deps injected for Node + browser: { secp, keccak256, sha256 }.

import { makeConfidentialPool } from './confidential-pool.js';
import { makeConfidentialMemo } from './confidential-memo.js';

// the tree built last, shared by every indexer on the page (the front page's and its swap card's): { keys: the leaf hashes, tree }
let lastBuilt = null;

export function makeConfidentialIndexer({ secp, keccak256, sha256 }) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const memo = makeConfidentialMemo({ secp, sha256, keccak256 });

  // Fold the event stream into slot-ordered leaves (+ aligned memos) and the
  // spent set. events: array, in order, of either
  //   { type:'LeavesInserted', firstLeafIndex, leaves:[hash..], memos:[hex..] }
  //   { type:'NullifiersSpent', nullifiers:[hash..] }
  function index(events) {
    const leaves = [];
    const spent = new Set();
    for (const ev of events || []) {
      if (ev.type === 'LeavesInserted') {
        const base = Number(ev.firstLeafIndex);
        for (let i = 0; i < ev.leaves.length; i++) {
          leaves[base + i] = { leaf: ev.leaves[i], memo: ev.memos[i], leafIndex: base + i };
        }
      } else if (ev.type === 'NullifiersSpent') {
        for (const n of ev.nullifiers) spent.add(String(n).toLowerCase());
      }
    }
    return { leaves, spent };
  }

  // Rebuild the Merkle tree from indexed leaves (slot order). Throws on a gap —
  // the append-only tree must be contiguous from 0, so a hole means a missed event.
  // A balance reads the pool's history several times (the quick pass and the full one, the swap card's own), and a tree is made of its leaves alone,
  // so the tree built last is handed out again when the leaves are the same ones; every caller only reads it (root, paths), and it keeps the levels it
  // computed, so the hashing is done once.
  function buildTree(leaves) {
    const keys = new Array(leaves.length);
    for (let i = 0; i < leaves.length; i++) {
      if (!leaves[i]) throw new Error(`leaf gap at index ${i} (missed a LeavesInserted event?)`);
      keys[i] = leaves[i].leaf;
    }
    if (lastBuilt && lastBuilt.keys.length === keys.length && lastBuilt.keys.every((k, i) => k === keys[i])) return lastBuilt.tree;
    const tree = new pool.Tree();
    for (let i = 0; i < keys.length; i++) tree.insert(keys[i]);
    lastBuilt = { keys, tree };
    return tree;
  }

  // Seed-only recovery: from the event stream + a scan private key, return the
  // wallet's active (unspent) notes, each as { value, blinding, secret, asset,
  // owner, cx, cy, leaf, leafIndex, nullifier, path, root } — ready to spend.
  function recover(events, scanPriv) {
    const { leaves, spent } = index(events);
    const tree = buildTree(leaves);
    const root = tree.root();
    const evs = leaves.filter(Boolean);
    // ν per the guest's native_nu: bearer (owner==0) → leaf-bound, else bound to the note's secret nk.
    const mine = memo.scan(scanPriv, evs, [...spent], (note, leaf) => pool.nativeNu(note.owner, note.secret, leaf));
    return mine.map((note) => ({ ...note, path: tree.rootAndPath(note.leafIndex).path, root }));
  }

  return { index, buildTree, recover, _pool: pool, _memo: memo };
}
