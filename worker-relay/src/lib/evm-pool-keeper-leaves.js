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
// A chunk that is not kept: nothing was stored for it, so the next sync reads it again (no reset).
export class ChunkNotKept extends Error {}
// sync() refused because a replay of the pool's history is already running: no tree to give until it is done.
export class CatchingUp extends Error {}

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

export function makeLeafSync({ store, chain, zk, startBlock = 0n, confirmations = 12n, logChunk = 2000n, log = () => {}, rebuildChunk = 4000 }) {
  const synced = () => {
    const v = store.getMeta('synced_block');
    return v === null ? BigInt(startBlock) - 1n : BigInt(v);
  };
  let base = null; // incTree over the persisted leaves
  let progressAt = Date.now();   // when a sync last started or stored a chunk: a replay of a pool's history takes hours, and is not a hang

  // That tree's right edge, size and root are kept beside the leaves, with the leaf count, the block they are read through and the last
  // leaf, so a start can take it from the store: hashing every leaf of a pool (109,000 on Base) again stalls the process for tens of
  // seconds, long enough for its health check to fail. It is used only when all of those agree with the leaves the store holds; any doubt
  // and the leaves are hashed as before, a slice at a time with the event loop let in between (the same tree as one append: a slice is
  // an append like any other).
  const baseMark = () => ({ count: store.leafCount(), block: store.syncedBlock(), last: store.lastLeaf()?.leaf ?? null });
  const keepBase = () => store.setMeta('base_tree', JSON.stringify({ tree: base.toJSON(), ...baseMark() }));
  const later = () => new Promise((r) => setImmediate(r));
  async function loadBase() {
    try {
      const raw = store.getMeta('base_tree');
      if (raw) {
        const m = JSON.parse(raw), now = baseMark();
        if (m.tree && m.count === now.count && m.block === now.block && m.last === now.last) {
          const t = zk.incTree(m.tree);
          if (t.size === now.count) return t;
        }
      }
    } catch { /* hashed again below */ }
    const t = zk.incTree(), all = store.leaves();
    for (let i = 0; i < all.length; i += rebuildChunk) { t.append(all.slice(i, i + rebuildChunk)); await later(); }
    return t;
  }
  // One rebuild at a time however many syncs ask, and none kept past a reset that happened while it ran.
  let baseP = null, gen = 0;
  async function ensureBase() {
    while (!base) {
      const mine = gen;
      baseP ||= loadBase().finally(() => { baseP = null; });
      const t = await baseP;
      if (mine === gen && !base) { base = t; keepBase(); }
    }
  }

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
    store.setMeta('base_tree', '');
    base = null;
    gen++;
  }

  // One run at a time. The keeper's tick, its history loop and every relay request's pipeline each call sync(), and two runs over
  // one store read the same chunk: the one that stores second finds the pool's next leaf not where it expects it, calls the store
  // inconsistent and empties it, and the replay of a busy pool's history (hours) starts again under the next overlap (Base,
  // 2026-11-04: 91 resets in 10 hours, the feed never past its first blocks, relay requests answered "catching up"). A caller that
  // arrives while a run is going waits for it, then runs its own, which finds the store caught up and costs a tail read. A run that
  // fails does not hold up the ones behind it.
  //
  // Unless the run in progress is a replay (a fresh disk, a store that was emptied: more than REPLAY_CHUNKS chunks behind the chain, hours of
  // reading): a caller has no tree to be given for that long, and parked behind it a relay request holds its connection until the gateway
  // gives up. It is told at once (CatchingUp, which the pipeline answers 429 "catching up"), and the run goes on.
  const REPLAY_CHUNKS = 6;
  let queue = Promise.resolve();
  let flight = null;   // { behind }: the run in progress, and how many blocks it started behind the chain
  function sync() {
    if (flight && flight.behind > REPLAY_CHUNKS * Number(logChunk)) {
      return Promise.reject(new CatchingUp(`catching up with the chain: the history is ${flight.behind} blocks behind and being read`));
    }
    const run = queue.then(syncOnce, syncOnce);
    queue = run.then(() => {}, () => {});
    return run;
  }

  // Returns { tree, root, nextIndex, head, confirmed }: an incTree over every leaf the pool holds at `head`, and its root
  // there; `confirmed` is the tree over the persisted leaves alone and the block they are read through.
  async function syncOnce() {
    try { return await syncRun(); } finally { flight = null; }
  }
  async function syncRun() {
    progressAt = Date.now();
    const head = BigInt(await chain.blockNumber());
    const safe = head - BigInt(confirmations);
    flight = { behind: Math.max(0, Number(safe - synced())) };
    try {
      await ensureBase();
      for (let from = synced() + 1n; from <= safe; ) {
        const to = from + BigInt(logChunk) - 1n > safe ? safe : from + BigInt(logChunk) - 1n;
        const [txs, recs] = await Promise.all([chain.transactLogs(from, to), chain.receivedLogs ? chain.receivedLogs(from, to) : []]);
        const items = ordered(txs, store.leafCount());
        // A node that keeps only recent history answers an old range with nothing rather than an error, and a fallback stops at that
        // answer, so a chunk is kept only when the leaves it leaves the store with are the pool's own count at its last block. A node
        // that cannot say fails the sync here too. Either way nothing is stored, and the chunk is read again.
        const held = BigInt((await chain.poolState(to)).nextIndex), have = BigInt(store.leafCount() + items.length);
        if (have !== held) throw new ChunkNotKept(`blocks ${from}-${to} would leave ${have} leaves, the pool held ${held} at block ${to}; the log node may keep only recent history`);
        const events = [
          ...txs.map((e) => ({ block: e.blockNumber, logIndex: e.logIndex ?? 0, ev: transactEvent(e) })),
          ...recs.map((e) => ({ block: e.blockNumber, logIndex: e.logIndex ?? 0, ev: receivedEvent(e) })),
        ];
        store.appendLeaves(items, to, events);
        base.append(items.map((x) => x.leaf));
        keepBase();
        progressAt = Date.now();
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
    return { tree, root: BigInt(root), nextIndex: BigInt(nextIndex), head, confirmed: { tree: base.clone(), block: synced() } };
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

  // What the pool's confirmed Transact events say went in and out, for a monitor to hold against the pool's balance: deposits,
  // withdrawals and relayer fees in wei, and the leaves, through the synced block (null before anything is synced, or while an
  // event stored before amounts were kept still lacks its own). Kept for 30 s, since a read goes through every stored event.
  let memo = null;
  function totals() {
    const through = store.syncedBlock();
    if (through === null) return null;
    if (memo && memo.through === through && Date.now() - memo.at < 30_000) return memo.value;
    let dep = 0n, wd = 0n, fee = 0n, events = 0;
    for (const r of store.transactsThrough(through)) {
      if (r.ext === null || r.ext === undefined || r.fee === null || r.fee === undefined) return null;
      const x = BigInt(r.ext);
      if (x > 0n) dep += x; else wd -= x;
      fee += BigInt(r.fee); events++;
    }
    const value = { through, events, deposits: dep.toString(), withdrawals: wd.toString(), fees: fee.toString(), leaves: store.leafCountThrough(through) };
    memo = { through, at: Date.now(), value };
    return value;
  }

  // The confirmed tree's right edge at its count and the block it is read through: a catch-up point, as the keeper last read the
  // pool, for a person to post from their own wallet. null before the first sync, or at an odd count (a spend fills both of its
  // outputs, so the pool's count is even).
  function point() {
    if (!base || !base.size || base.size % 2) return null;
    return { size: Number(base.size), block: Number(synced()), filled: base.toJSON().filled.map((x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`) };
  }

  return { sync, eventsFrom, totals, point, invalidate: reset, get progressAt() { return progressAt; } };
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
