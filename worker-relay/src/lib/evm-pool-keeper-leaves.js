// The pool's leaves, rebuilt from its Transact events: each event with a non-zero output appends (outLeaf0,
// outLeaf1) at firstIndex, an empty output included; an event whose outputs are both empty inserted nothing.
// Leaves from blocks at least `confirmations` deep are persisted, with those blocks' Transact and Received events
// (served to wallets by /events); the unconfirmed tail is re-read on every sync so a reorg above that depth never
// lands in the store. The tree over the persisted leaves is kept incrementally in memory, so a sync costs hashes
// only for new leaves.
//
// chain: { blockNumber(), transactLogs(from, to) → [{ firstIndex, outLeaf0, outLeaf1, blockNumber, logIndex, tx, nf0,
//          nf1, memo0, memo1 }], receivedLogs?(from, to) → [{ box, n, index, value, rho, fee, blockNumber, logIndex,
//          tx }], poolState(blockNumber) → { root, nextIndex } }

export class LeafSyncError extends Error {}

const str = (x) => (x === undefined || x === null ? null : typeof x === 'bigint' ? x.toString() : String(x));
const lc = (a) => (a ? String(a).toLowerCase() : null);

// The public facts of a Transact log beyond what a wallet needs to spend (its recipient, amount, relayer and fee) and the
// block's time where the node gives it, kept so a wallet's history can read them here (/events?facts=1) rather than
// asking a node about every transaction. A sender, target and router call data are added later (makeFactsSync).
function logFacts(e) {
  const f = {};
  if (e.extAmount !== undefined && e.extAmount !== null) Object.assign(f, { recipient: lc(e.recipient), ext: str(e.extAmount), relayer: lc(e.relayer), fee: str(e.fee) });
  if (Number(e.blockTimestamp) > 0) f.ts = Number(e.blockTimestamp);                // a node that gives 0 gives none
  return f;
}
export const FACT_KEYS = ['recipient', 'ext', 'relayer', 'fee', 'from', 'to', 'input', 'ts'];
const withoutFacts = (ev) => { const o = { ...ev }; for (const k of FACT_KEYS) delete o[k]; if (ev.kind === 'received') o.fee = ev.fee; return o; };

// A stored event's JSON: what a wallet needs to find and spend its notes, and the facts above.
function transactEvent(e) {
  return {
    kind: 'transact', block: Number(e.blockNumber), tx: e.tx ?? null, firstIndex: Number(e.firstIndex),
    nf0: str(e.nf0), nf1: str(e.nf1), outLeaf0: str(BigInt(e.outLeaf0)), outLeaf1: str(BigInt(e.outLeaf1)),
    memo0: e.memo0 ?? '0x', memo1: e.memo1 ?? '0x', ...logFacts(e),
  };
}
function receivedEvent(e) {
  return {
    kind: 'received', block: Number(e.blockNumber), tx: e.tx ?? null, box: String(e.box).toLowerCase(), n: str(e.n),
    index: Number(e.index), value: str(e.value), rho: str(e.rho), fee: str(e.fee),
    ...(Number(e.blockTimestamp) > 0 ? { ts: Number(e.blockTimestamp) } : {}),
  };
}

export function makeLeafSync({ store, chain, zk, startBlock = 0n, confirmations = 12n, logChunk = 2000n, log = () => {} }) {
  const synced = () => {
    const v = store.getMeta('synced_block');
    return v === null ? BigInt(startBlock) - 1n : BigInt(v);
  };
  let base = null; // incTree over the persisted leaves

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

  function reset() {
    store.resetLeaves();
    base = null;
  }

  // Returns { tree, root, nextIndex, head }: an incTree over every leaf the pool holds at `head`, and its root there.
  async function sync() {
    const head = BigInt(await chain.blockNumber());
    const safe = head - BigInt(confirmations);
    try {
      if (!base) { base = zk.incTree(); base.append(store.leaves()); }
      for (let from = synced() + 1n; from <= safe; ) {
        const to = from + BigInt(logChunk) - 1n > safe ? safe : from + BigInt(logChunk) - 1n;
        const [txs, recs] = await Promise.all([chain.transactLogs(from, to), chain.receivedLogs ? chain.receivedLogs(from, to) : []]);
        const items = ordered(txs, store.leafCount());
        const events = [
          ...txs.map((e) => ({ block: e.blockNumber, logIndex: e.logIndex ?? 0, ev: transactEvent(e) })),
          ...recs.map((e) => ({ block: e.blockNumber, logIndex: e.logIndex ?? 0, ev: receivedEvent(e) })),
        ];
        store.appendLeaves(items, to, events);
        base.append(items.map((x) => x.leaf));
        from = to + 1n;
      }
    } catch (e) {
      if (e instanceof LeafSyncError) { log(`leaf store inconsistent (${e.message}); resyncing from the start block`); reset(); }
      throw e;
    }
    const tailFrom = synced() + 1n;
    const tail = tailFrom <= head ? ordered(await chain.transactLogs(tailFrom, head), base.size) : [];
    const tree = base.clone();
    tree.append(tail.map((t) => t.leaf));
    const { root, nextIndex } = await chain.poolState(head);
    if (BigInt(tree.size) !== BigInt(nextIndex)) {
      // Fewer: the log provider lags the state provider; retry next tick. More: the store holds a dropped block.
      if (BigInt(tree.size) > BigInt(nextIndex)) reset();
      throw new LeafSyncError(`have ${tree.size} leaves, pool holds ${nextIndex} at block ${head}`);
    }
    return { tree, root: BigInt(root), nextIndex: BigInt(nextIndex), head };
  }

  // Stored events from `fromBlock` on, whole blocks only, at most about `limit`. → { events, through }: every event
  // in blocks fromBlock..through (through = the synced block when nothing is cut off). Without `facts` an event has the
  // shape it always had; with it, the facts kept so far, and `factsThrough`: the block every event up to has them all.
  function eventsFrom(fromBlock, limit, { facts = false } = {}) {
    const shape = (rows) => rows.map((r) => (facts ? r.ev : withoutFacts(r.ev)));
    const extra = facts ? { factsThrough: factsThrough() } : {};
    const top = store.syncedBlock();
    if (top === null || fromBlock > top) return { events: [], through: top ?? Number(startBlock) - 1, ...extra };
    const rows = store.eventsFrom(fromBlock, limit + 1);
    if (rows.length <= limit) return { events: shape(rows), through: top, ...extra };
    const last = rows[rows.length - 1].block;
    const whole = rows.filter((r) => r.block < last);
    if (whole.length) return { events: shape(whole), through: last - 1, ...extra };
    const one = store.eventsFrom(last, 100_000).filter((r) => r.block === last); // one block holds more than `limit`
    return { events: shape(one), through: last, ...extra };
  }
  function factsThrough() {
    const a = store.getMeta('facts_block'), b = store.getMeta('facts_logs_block');
    return a === null || b === null ? Number(startBlock) - 1 : Math.min(Number(a), Number(b));
  }

  return { sync, eventsFrom, invalidate: reset };
}

// Fills in the stored events' facts, behind the leaf sync and apart from it, so a slow or failing node here never holds up
// a wallet's leaves or a relay. Two marks in the store say how far each stage has gone, so a restart goes on from there:
//   facts_logs_block: the log's own fields for events stored before they were kept, read again from the logs;
//   facts_block:      each transaction's sender and target (and a router call's data), and each block's time where the
//                     log did not carry it, over blocks the first stage has covered.
// step(budgetMs) works until the budget is spent and returns true when there is more to do; a read that fails throws,
// leaving the marks where they were.
export function makeFactsSync({ store, chain, startBlock = 0n, logChunk = 2000n, concurrency = 4 }) {
  const mark = (k) => { const v = store.getMeta(k); return v === null ? Number(startBlock) - 1 : Number(v); };
  const router = lc(chain.router);
  const each = async (items, f) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (i < items.length) await f(items[i++]); }));
  };
  async function step(budgetMs = 20_000) {
    const t0 = Date.now(), spent = () => Date.now() - t0 >= budgetMs;
    const top = store.syncedBlock();
    if (top === null) return false;
    for (let p = mark('facts_logs_block'); p < top; p = mark('facts_logs_block')) {
      if (spent()) return true;
      const a = p + 1, b = Math.min(top, a + Number(logChunk) - 1);
      const old = store.eventsBetween(a, b).filter((r) => r.ev.kind === 'transact' && r.ev.ext === undefined);
      if (!old.length) { store.setMeta('facts_logs_block', b); continue; }
      const logs = chain.factsLogs ? await chain.factsLogs(BigInt(a), BigInt(b), old.map((r) => ({ block: r.block, logIndex: r.logIndex }))) : await chain.transactLogs(BigInt(a), BigInt(b));
      const at = new Map(logs.map((l) => [`${Number(l.blockNumber)}:${Number(l.logIndex ?? 0)}`, l]));
      store.updateEvents(old.map((r) => {
        const l = at.get(`${r.block}:${r.logIndex}`);
        if (!l) throw new Error(`no Transact log at block ${r.block} index ${r.logIndex}`);
        return { ...r, ev: { ...r.ev, ...logFacts(l) } };
      }), 'facts_logs_block', b);
    }
    // Version 2 treats a stored time of 0 as missing (an earlier version kept what a node gave, and Robinhood's gives 0): the
    // second stage runs once more over what was stored, which only does work for the events that still lack a time or sender.
    if (store.getMeta('facts_v') !== '2') { store.setMeta('facts_block', Number(startBlock) - 1); store.setMeta('facts_v', '2'); }
    const ceiling = mark('facts_logs_block');
    for (let p = mark('facts_block'); p < ceiling; p = mark('facts_block')) {
      if (spent()) return true;
      const a = p + 1, b = Math.min(ceiling, a + Number(logChunk) - 1);
      const rows = store.eventsBetween(a, b);
      const times = new Map(rows.filter((r) => r.ev.ts > 0).map((r) => [r.block, r.ev.ts]));
      const untimed = [...new Set(rows.filter((r) => !(r.ev.ts > 0)).map((r) => r.block))].filter((n) => !times.has(n));
      for (let i = 0; i < untimed.length; i += 50) {
        if (spent()) return true;
        await each(untimed.slice(i, i + 50), async (n) => { times.set(n, await chain.blockTime(n)); });
      }
      const unsent = rows.filter((r) => r.ev.kind === 'transact' && r.ev.from === undefined);
      for (let i = 0; i < unsent.length; i += 50) {
        if (spent()) return true;
        const part = unsent.slice(i, i + 50), got = new Map();
        await each(part, async (r) => { got.set(r.ev.tx, await chain.txFacts(r.ev.tx)); });
        store.updateEvents(part.map((r) => {
          const f = got.get(r.ev.tx), to = lc(f.to);
          return { ...r, ev: { ...r.ev, from: lc(f.from), to, ...(to === router && f.input ? { input: f.input } : {}), ts: r.ev.ts > 0 ? r.ev.ts : times.get(r.block) } };
        }));
      }
      const timeOnly = rows.filter((r) => !(r.ev.ts > 0) && !(r.ev.kind === 'transact' && r.ev.from === undefined));
      store.updateEvents(timeOnly.map((r) => ({ ...r, ev: { ...r.ev, ts: times.get(r.block) } })), 'facts_block', b);
    }
    return mark('facts_logs_block') < (store.syncedBlock() ?? -1);
  }
  return { step };
}
