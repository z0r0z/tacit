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
  function buildTree(leaves) {
    const tree = new pool.Tree();
    for (let i = 0; i < leaves.length; i++) {
      if (!leaves[i]) throw new Error(`leaf gap at index ${i} (missed a LeavesInserted event?)`);
      tree.insert(leaves[i].leaf);
    }
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
    const mine = memo.scan(scanPriv, evs, [...spent], pool.nullifier);
    return mine.map((note) => ({ ...note, path: tree.rootAndPath(note.leafIndex).path, root }));
  }

  return { index, buildTree, recover, _pool: pool, _memo: memo };
}
