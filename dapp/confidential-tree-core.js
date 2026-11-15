// The levels of the pool's Merkle tree (confidential-pool.js Tree.levels) made from leaves packed in one buffer, in pieces that a worker can make at once
// (confidential-tree-worker.js, confidential-tree-workers.js) and a page puts together.
//
// A level i holds the nodes of level i-1 hashed in pairs (the missing side of a last pair is zeros[i-1]). The leaves are cut in chunks of 2^h that start at multiples
// of 2^h, so a chunk is a whole subtree and no pair of any level below h spans two chunks: `lower` makes levels 1..h of a chunk by itself (the last chunk may be
// shorter, and nothing lies to its right, so the zeros it takes are the zeros the whole tree takes), the chunks' pieces of each level follow one another into that
// level of the tree, and `finish` makes levels h+1 up to the top from level h, a few hashes. A worker and a page run these same functions.
//
// Deps are passed in (`keccak256`) so the page and the worker bring their own.

export const TREE_DEPTH = 32;
// A leaf of the live UTXO set is the hash of 129 bytes: key ‖ asset ‖ value ‖ authKey ‖ bound (confidential-pool.js livePre), packed one after another for the workers.
export const LIVE_PRE = 129;

// The height h of a chunk so that about `k` chunks cover `n` leaves: the least h with 2^h >= ceil(n / k).
export function chunkHeight(n, k) {
  let h = 0;
  while (2 ** h < Math.ceil(n / Math.max(1, k))) h++;
  return h;
}
// How many nodes level i of a chunk of `count` leaves has.
export const nodesAt = (count, i) => Math.ceil(count / 2 ** i);

export function makeTreeCore({ keccak256, depth = TREE_DEPTH }) {
  const zeros = (() => {
    const z = [new Uint8Array(32)], pair = new Uint8Array(64);
    for (let i = 1; i < depth; i++) { pair.set(z[i - 1], 0); pair.set(z[i - 1], 32); z.push(keccak256(pair)); }
    return z;
  })();
  const scratch = new Uint8Array(64);

  // one level up from `count` nodes at level i: ceil(count / 2) nodes, the missing side of the last pair zeros[i]
  function up(src, count, i) {
    const n = (count + 1) >> 1, out = new Uint8Array(n * 32);
    for (let k = 0; k < n; k++) {
      scratch.set(src.subarray(64 * k, 64 * k + 32), 0);
      if (2 * k + 1 < count) scratch.set(src.subarray(64 * k + 32, 64 * k + 64), 32); else scratch.set(zeros[i], 32);
      out.set(keccak256(scratch), 32 * k);
    }
    return out;
  }

  // levels 1..h of a chunk of `count` leaves: h buffers, the one at j holding level j + 1
  function lower(leaves, count, h) {
    const out = [];
    let cur = leaves, len = count;
    for (let i = 0; i < h; i++) { cur = up(cur, len, i); len = (len + 1) >> 1; out.push(cur); }
    return out;
  }

  // The whole tree from the leaves and levels 1..h of all of them (`lowerLevels`, each already made out of the chunks' pieces): { n, levels, counts, top }, level i in levels[i]
  // as a buffer of counts[i] nodes for i below the depth (levels[0] is `leaves`), and the root in top.
  function finish(leaves, n, lowerLevels, h) {
    const levels = [], counts = [];
    if (n === 0) {                                  // the empty tree: level 0 holds nothing, every level above one node, zeros[i]
      levels.push(new Uint8Array(0)); counts.push(0);
      for (let i = 1; i < depth; i++) { levels.push(zeros[i]); counts.push(1); }
      return { n, levels, counts, top: up(zeros[depth - 1], 1, depth - 1) };
    }
    levels.push(leaves); counts.push(n);
    for (let i = 1; i <= h && i < depth; i++) { levels.push(lowerLevels[i - 1]); counts.push((counts[i - 1] + 1) >> 1); }
    let cur = levels[Math.min(h, depth - 1)], len = counts[Math.min(h, depth - 1)];
    for (let i = Math.min(h, depth - 1); i < depth; i++) {
      if (i > h) { levels.push(cur); counts.push(len); }
      cur = up(cur, len, i); len = (len + 1) >> 1;
    }
    return { n, levels, counts, top: cur };
  }

  // A check made on what was put together, cheap enough to run on the page: the first and last node of every chunk at each of levels 1..h (so the ends of the whole level too) is the
  // hash of its children one level down. It is the edges that the putting-together of chunks and a short last chunk can get wrong; it is not a proof of the whole.
  function edgesHold(leaves, n, lowerLevels, h) {
    if (n === 0) return true;
    const level = (i) => (i === 0 ? leaves : lowerLevels[i - 1]);
    const parts = Math.ceil(n / 2 ** h);
    for (let i = 1; i <= h; i++) {
      const below = level(i - 1), nbelow = nodesAt(n, i - 1), here = level(i), nhere = nodesAt(n, i), per = 2 ** (h - i);
      if (!below || !here || below.length !== nbelow * 32 || here.length !== nhere * 32) return false;
      const ks = new Set();
      for (let c = 0; c < parts; c++) { ks.add(c * per); ks.add(Math.min((c + 1) * per, nhere) - 1); }
      for (const k of ks) {
        if (k < 0 || k >= nhere) return false;
        scratch.set(below.subarray(64 * k, 64 * k + 32), 0);
        if (2 * k + 1 < nbelow) scratch.set(below.subarray(64 * k + 32, 64 * k + 64), 32); else scratch.set(zeros[i - 1], 32);
        const want = keccak256(scratch);
        for (let b = 0; b < 32; b++) if (here[32 * k + b] !== want[b]) return false;
      }
    }
    return true;
  }

  // `count` leaves from their preimages (LIVE_PRE bytes each): a worker's first step for a set whose leaves are hashes of records
  function hashLeaves(pre, count) {
    const out = new Uint8Array(count * 32);
    for (let i = 0; i < count; i++) out.set(keccak256(pre.subarray(LIVE_PRE * i, LIVE_PRE * (i + 1))), 32 * i);
    return out;
  }
  // The leaves a worker made, checked where it matters to the page: the first and last leaf of every chunk is the hash of its preimage. (As with edgesHold, a check of the ends, not of the whole.)
  function leafEdgesHold(pre, n, leaves, h) {
    if (leaves.length !== n * 32 || pre.length !== n * LIVE_PRE) return false;
    const size = 2 ** h, parts = Math.ceil(n / size), ks = new Set();
    for (let c = 0; c < parts; c++) { ks.add(c * size); ks.add(Math.min((c + 1) * size, n) - 1); }
    for (const i of ks) {
      const want = keccak256(pre.subarray(LIVE_PRE * i, LIVE_PRE * (i + 1)));
      for (let b = 0; b < 32; b++) if (leaves[32 * i + b] !== want[b]) return false;
    }
    return true;
  }

  return { zeros, up, lower, finish, edgesHold, hashLeaves, leafEdgesHold };
}
