// An EVM pool's state at any block, rebuilt from its Transact events alone and checked against them: the note tree (its root
// and size) and the set of spent nullifiers (their sparse-tree root). Nothing here trusts a node's answer about the state;
// every event carries the root the pool had after it, and the rebuilt tree must reproduce each one.
//
// Read-only. A holding reward proves, in zero knowledge, that a note is in the note tree and its nullifier is not in the
// spent set at a snapshot block; this is what the verifier of such a proof compares the public roots against.
//
// The counts are of leaves and of nullifiers, not of notes held: a transaction fills its two input slots with zero-value
// notes when it spends fewer, each with a real nullifier, and its outputs may be zero-value too, so leaves minus nullifiers is
// not the number of notes still unspent, and which leaf a nullifier spent is exactly what the pool hides. What the public
// events do give exactly is the ETH that went in and out and the relayer fees paid (`flows`); the pool's own balance is what
// is left, in - out - fees.
//
// transacts: [{ blockNumber, logIndex, firstIndex, outLeaf0, outLeaf1, nf0, nf1, newRoot, extAmount? }] (bigint or hex), any order.
// zk: makeEvmPoolZk({ poseidon }), for the tree and the hash H.

export class PoolHistoryError extends Error {}

const big = (x) => BigInt(x);

// The root of circomlib's sparse Merkle tree over `keys` (each with value 1), as circomlibjs builds it: a key's bits are read
// least significant first, a subtree holding exactly one key is that key's leaf, hash(key, 1, 1), wherever it sits, an empty
// subtree is 0, and two children hash(left, right). The structure depends only on the set, never on insertion order.
export function smtRoot(keys, hash) {
  const ks = [...new Set(keys.map(big))];
  const walk = (set, level) => {
    if (set.length === 0) return 0n;
    if (set.length === 1) return hash([set[0], 1n, 1n]);
    if (level > 253) throw new PoolHistoryError('two nullifiers agree on every bit');
    const left = [], right = [];
    for (const k of set) ((k >> BigInt(level)) & 1n ? right : left).push(k);
    return hash([walk(left, level + 1), walk(right, level + 1)]);
  };
  return walk(ks, 0);
}

export function buildPoolHistory({ transacts, zk, depth = 32 }) {
  const H = zk.H;
  const events = [...transacts].map((e) => ({
    block: Number(e.blockNumber), logIndex: Number(e.logIndex ?? 0), firstIndex: big(e.firstIndex),
    leaves: [big(e.outLeaf0), big(e.outLeaf1)], nfs: [big(e.nf0), big(e.nf1)], newRoot: big(e.newRoot),
    ext: e.extAmount === undefined || e.extAmount === null ? 0n : big(e.extAmount),
    fee: e.fee === undefined || e.fee === null ? 0n : big(e.fee),
  })).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  const tree = zk.incTree();
  const empty = tree.root;                       // the root of an empty tree
  const steps = [];                              // after each event: { block, root, size, nullifiers (cumulative count), notes }
  const nullifiers = [];                         // every non-zero nullifier, in order
  let notes = 0;                                 // non-empty leaves inserted
  const flows = { deposits: 0, withdrawals: 0, in: 0n, out: 0n, fees: 0n };
  let head = empty;

  for (const e of events) {
    const inserts = e.leaves[0] !== 0n || e.leaves[1] !== 0n;
    if (inserts) {
      if (e.firstIndex !== BigInt(tree.size)) throw new PoolHistoryError(`Transact at index ${e.firstIndex} in block ${e.block}, expected ${tree.size}`);
      tree.append(e.leaves);
      notes += e.leaves.filter((l) => l !== 0n).length;
      head = tree.root;
    }
    if (head !== e.newRoot) throw new PoolHistoryError(`block ${e.block} log ${e.logIndex}: the pool says its root became ${e.newRoot.toString(16)}, the rebuilt tree has ${head.toString(16)}`);
    for (const nf of e.nfs) if (nf !== 0n) nullifiers.push(nf);
    if (e.ext > 0n) { flows.deposits += 1; flows.in += e.ext; } else if (e.ext < 0n) { flows.withdrawals += 1; flows.out += -e.ext; }
    flows.fees += e.fee;
    steps.push({ block: e.block, root: head, size: tree.size, nullifiers: nullifiers.length, notes, in: flows.in, out: flows.out, fees: flows.fees, deposits: flows.deposits, withdrawals: flows.withdrawals });
  }

  const sizeByRoot = new Map([[empty, 0]]);
  for (const st of steps) sizeByRoot.set(st.root, st.size);
  const nfSeen = new Set();
  for (const nf of nullifiers) {
    if (nfSeen.has(nf)) throw new PoolHistoryError(`nullifier ${nf.toString(16)} appears twice`);
    nfSeen.add(nf);
  }

  // The last step at or before `block` (a block's events all count), or the empty state.
  const stepAt = (block) => {
    let lo = 0, hi = steps.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid].block <= block) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found < 0 ? { block: null, root: empty, size: 0, nullifiers: 0, notes: 0, in: 0n, out: 0n, fees: 0n, deposits: 0, withdrawals: 0 } : steps[found];
  };

  return {
    depth,
    events: events.length,
    head: { root: head, size: tree.size, nullifiers: nullifiers.length, leaves: notes, flows: { ...flows } },
    // The leaf count the pool had when `root` was its head, for a root this history reached; null for any other.
    sizeOfRoot: (root) => sizeByRoot.get(big(root)) ?? null,
    // The state after every event up to and including `block`: the tree (root, slots, non-empty leaves), how many non-zero
    // nullifiers are published, and the ETH that has gone in and out through the public amounts.
    at(block) {
      const s = stepAt(block);
      return { root: s.root, size: s.size, leaves: s.notes, nullifiers: s.nullifiers, flows: { deposits: s.deposits, withdrawals: s.withdrawals, in: s.in, out: s.out, fees: s.fees, net: s.in - s.out - s.fees } };
    },
    // The spent nullifiers as of `block` and the root of their sparse tree.
    nullifiersAt(block) { return nullifiers.slice(0, stepAt(block).nullifiers); },
    nfRootAt(block) { return smtRoot(nullifiers.slice(0, stepAt(block).nullifiers), H); },
  };
}
