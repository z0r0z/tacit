// The pool's leaves, rebuilt from its Transact events: each event with a non-zero output appends (outLeaf0,
// outLeaf1) at firstIndex, an empty output included; an event whose outputs are both empty inserted nothing. Leaves from blocks at least `confirmations` deep are persisted; the unconfirmed tail is
// re-read on every sync so a reorg above that depth never lands in the store.
//
// chain: { blockNumber(), transactLogs(from, to) → [{ firstIndex, outLeaf0, outLeaf1, blockNumber }],
//          poolState(blockNumber) → { root, nextIndex } }

export class LeafSyncError extends Error {}

export function makeLeafSync({ store, chain, startBlock = 0n, confirmations = 12n, logChunk = 2000n, log = () => {} }) {
  const synced = () => {
    const v = store.getMeta('synced_block');
    return v === null ? BigInt(startBlock) - 1n : BigInt(v);
  };

  function ordered(logs, expectFrom) {
    const sorted = [...logs].filter((e) => BigInt(e.outLeaf0) !== 0n || BigInt(e.outLeaf1) !== 0n).sort((a, b) => (BigInt(a.firstIndex) < BigInt(b.firstIndex) ? -1 : 1));
    const out = [];
    let next = BigInt(expectFrom);
    for (const e of sorted) {
      if (BigInt(e.firstIndex) !== next) throw new LeafSyncError(`Transact at index ${e.firstIndex}, expected ${next}`);
      out.push({ leaf: BigInt(e.outLeaf0), block: BigInt(e.blockNumber) }, { leaf: BigInt(e.outLeaf1), block: BigInt(e.blockNumber) });
      next += 2n;
    }
    return out;
  }

  // Returns { leaves, root, nextIndex, head }: every leaf the pool holds at `head`, and its root there.
  async function sync() {
    const head = BigInt(await chain.blockNumber());
    const safe = head - BigInt(confirmations);
    try {
      for (let from = synced() + 1n; from <= safe; ) {
        const to = from + BigInt(logChunk) - 1n > safe ? safe : from + BigInt(logChunk) - 1n;
        const items = ordered(await chain.transactLogs(from, to), store.leafCount());
        store.appendLeaves(items, to);
        from = to + 1n;
      }
    } catch (e) {
      if (e instanceof LeafSyncError) { log(`leaf store inconsistent (${e.message}); resyncing from the start block`); store.resetLeaves(); }
      throw e;
    }
    const persisted = store.leaves();
    const tailFrom = synced() + 1n;
    const tail = tailFrom <= head ? ordered(await chain.transactLogs(tailFrom, head), persisted.length) : [];
    const leaves = [...persisted, ...tail.map((t) => t.leaf)];
    const { root, nextIndex } = await chain.poolState(head);
    if (BigInt(leaves.length) !== BigInt(nextIndex)) {
      // Fewer: the log provider lags the state provider; retry next tick. More: the store holds a dropped block.
      if (BigInt(leaves.length) > BigInt(nextIndex)) store.resetLeaves();
      throw new LeafSyncError(`have ${leaves.length} leaves, pool holds ${nextIndex} at block ${head}`);
    }
    return { leaves, root: BigInt(root), nextIndex: BigInt(nextIndex), head };
  }

  return { sync, invalidate: () => store.resetLeaves() };
}
