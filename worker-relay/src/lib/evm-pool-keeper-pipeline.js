// The keeper's queue of insertions. The pool inserts only against its current head (oldRoot, startIndex), and a
// spend's signature does not cover the root, so insertions can be lined up ahead of the chain:
//
//  1. reserve: a wallet names the two leaves it will insert (fixed before it proves) and the notes it spends, and
//     gets a slot: the root and index its proof must start from, and the leaves queued ahead of it. Many wallets
//     then prove at once, each against its own slot, instead of racing for one head.
//  2. fulfil: the proof arrives for its slot and is checked off chain (proof, bindings, slot), since it cannot be
//     simulated before the slots ahead land.
//  3. pump: ready slots are sent in order, several per block, never past a slot still proving.
//
// A slot not fulfilled in time is cut with everything behind it, and those wallets reserve again. A requester whose
// unused slot cost others their place (it lapsed or was given up with slots behind it) may not reserve again for
// pauseMs; a wallet in that position sends unreserved, against the queue's tail. A slot sent and not landed within staleMs is cut
// the same way (the chain's send path has sent its transaction again by then, see resend there), so a spend whose transaction was
// dropped is free to be sent again. The queue is
// dropped whole when the chain's head stops leading into it (another sender's insertion landed first, or a sent
// transaction reverted); what follows reverts cheaply on StaleRoot.
//
// chain: { poolState() → { root, nextIndex }, knownRoot(root) → bool, spent(nfs) → bool[] }
// baseTree() → { tree, root }: an incTree of the pool at its head (leafSync.sync()).
// verify(tx) → bool: the Groth16 proof against the ceremony key.

import { randomBytes } from 'node:crypto';
import { extDataHash } from '../../../dapp/evm-pool-zk.js';

export class PipelineError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const bytesOf = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const stale = (m) => new PipelineError(409, m, { stale: true });

export function makePipeline({
  chain, verify, assetField, baseTree, maxDepth = 32, maxPerOwner = 2, reserveMs = 90_000, staleMs = 200_000, pauseMs = 600_000,
  now = () => Date.now(), log = () => {},
}) {
  // { id, start, oldRoot, newRoot, outLeaf: [a, b], nfs, owner, state: 'reserved' | 'ready' | 'sent', at, tx?, send?,
  //   hash?, done?: { resolve, reject } }
  let entries = [];
  let tail = null; // incTree of the pool plus every queued slot's leaves
  const paused = new Map(); // owner → until: may not reserve before then
  const pause = (e) => { if (e.owner) paused.set(e.owner, now() + pauseMs); };

  let lock = Promise.resolve();
  const exclusive = (f) => { const run = lock.then(f, f); lock = run.catch(() => {}); return run; };

  function cut(i, why) {
    const gone = entries.slice(i);
    if (!gone.length) return;
    for (const e of gone) e.done?.reject(stale(why));
    entries = entries.slice(0, i);
    tail = null;
    log(`pipeline: ${why}; dropped ${gone.length}`);
  }

  async function refresh() {
    while (entries.length && entries[0].state === 'sent' && await chain.knownRoot(entries[0].newRoot)) entries.shift();
    if (!entries.length) { tail = null; return; }
    const { root } = await chain.poolState();
    if (BigInt(root) !== entries[0].oldRoot) return cut(0, `the pool's head no longer leads into the queue at ${entries[0].start}`);
    if (entries[0].state === 'sent' && now() - entries[0].at > staleMs) return cut(0, `slot ${entries[0].start} was sent but has not landed`);
    const late = entries.findIndex((e) => e.state === 'reserved' && now() - e.at > reserveMs);
    if (late >= 0) {
      entries.forEach((e, i) => { if (i >= late && i < entries.length - 1 && e.state === 'reserved' && now() - e.at > reserveMs) pause(e); });
      cut(late, `slot ${entries[late].start} was not fulfilled in time`);
    }
  }

  async function tailTree() {
    if (tail) return tail;
    let tree;
    try { ({ tree } = await baseTree()); } catch { throw new PipelineError(429, 'catching up with the chain; try again in a few seconds'); }
    for (const e of entries) tree.append(e.outLeaf);
    if (entries.length && tree.root !== entries[entries.length - 1].newRoot) { cut(0, 'the queue does not match the pool'); return tailTree(); }
    tail = tree;
    return tail;
  }

  // Sends ready slots in order, stopping at the first still proving. Inside the lock.
  async function pump() {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.state === 'sent') continue;
      if (e.state !== 'ready') return;
      try {
        // Only the front can be simulated: everything behind it follows unmined transactions.
        e.hash = await e.send({ simulate: i === 0 });
        e.state = 'sent';
        e.at = now();
        e.done?.resolve(e.hash);
      } catch (err) {
        e.done?.reject(err);
        cut(i, `slot ${e.start} failed to send`);
        return;
      }
    }
  }

  function checkNotes(nfs) {
    for (const e of entries) if (e.nfs.some((x) => nfs.includes(x))) throw stale('a note in this spend is already queued');
  }

  async function reserveLocked({ outLeaf, nfs = [], owner = null }) {
    await refresh();
    for (const [k, until] of paused) if (until <= now()) paused.delete(k);
    if (owner && paused.has(owner)) throw new PipelineError(403, 'a slot you reserved went unused while others waited on it, so reserving is paused for a few minutes; send without a reservation');
    if (entries.length >= maxDepth) throw new PipelineError(429, 'the queue is full; try again in a few seconds');
    if (owner && entries.filter((e) => e.owner === owner && e.state === 'reserved').length >= maxPerOwner) throw new PipelineError(429, 'too many open slots');
    const spends = nfs.map(BigInt).filter((x) => x !== 0n);
    checkNotes(spends);
    if (spends.length && (await chain.spent(spends)).some(Boolean)) throw new PipelineError(400, 'a note in this spend is already spent');
    const t = await tailTree();
    const base = entries.length ? { root: entries[0].oldRoot, size: entries[0].start } : { root: t.root, size: BigInt(t.size) };
    const ahead = entries.map((e) => e.outLeaf);
    const start = BigInt(t.size), oldRoot = t.root;
    t.append(outLeaf.map(BigInt));
    const e = { id: randomBytes(12).toString('hex'), start, oldRoot, newRoot: t.root, outLeaf: outLeaf.map(BigInt), nfs: spends, owner, state: 'reserved', at: now() };
    entries.push(e);
    return { e, base, ahead };
  }

  // Bindings of a proof to its slot and its transaction; the proof itself unless `own`.
  async function check(e, tx, { chainId, pool, own }) {
    const [root, oldRoot, newRoot, start, , eh, asset, nf0, nf1, out0, out1] = tx.publicInputs.map(BigInt);
    if (oldRoot !== e.oldRoot || start !== e.start || newRoot !== e.newRoot || out0 !== e.outLeaf[0] || out1 !== e.outLeaf[1]) throw stale('the proof is not for this slot');
    if (!e.nfs.every((x) => x === nf0 || x === nf1)) throw new PipelineError(400, 'the proof spends other notes than the slot named');
    if (asset !== BigInt(assetField)) throw new PipelineError(400, 'wrong asset');
    if (!own) {
      const want = extDataHash({ chainId: BigInt(chainId), pool, recipient: tx.recipient, extAmount: tx.extAmount, relayer: tx.relayer, fee: tx.fee, memo0: bytesOf(tx.memo0), memo1: bytesOf(tx.memo1) });
      if (eh !== want) throw new PipelineError(400, 'extDataHash does not match the transaction');
    }
    const i = entries.indexOf(e);
    if (root !== e.oldRoot && !entries.slice(0, i).some((x) => x.newRoot === root) && !(await chain.knownRoot(root))) throw stale('unknown membership root');
    if (!own && !(await verify(tx))) throw new PipelineError(400, 'the proof does not verify');
  }

  // Marks a slot ready with its transaction and sends what can go. → { sent }: a promise of the tx hash, settled
  // when this slot is sent (or cut); wrapped, so the lock is not held while it waits for the slots ahead.
  async function fulfilLocked(e, tx, send, opts) {
    await check(e, tx, opts);
    e.tx = tx;
    e.send = send;
    e.state = 'ready';
    const sent = new Promise((resolve, reject) => { e.done = { resolve, reject }; });
    sent.catch(() => {});
    await pump();
    return { sent };
  }

  // Housekeeping: expire slots and send what became sendable, even with no new requests.
  const timer = setInterval(() => { exclusive(async () => { await refresh(); await pump(); }).catch(() => {}); }, 2000);
  timer.unref?.();

  return {
    exclusive,

    // → { id, start, oldRoot, newRoot, root, size, pending: [{ outLeaf0, outLeaf1 }], expires }: prove from
    // oldRoot at start, i.e. the pool at root/size plus `pending` appended.
    reserve: (req) => exclusive(async () => {
      const { e, base, ahead } = await reserveLocked(req);
      return {
        id: e.id, start: e.start.toString(), oldRoot: e.oldRoot.toString(), newRoot: e.newRoot.toString(),
        root: base.root.toString(), size: base.size.toString(),
        pending: ahead.map(([a, b]) => ({ outLeaf0: a.toString(), outLeaf1: b.toString() })),
        expires: Math.floor((e.at + reserveMs) / 1000),
      };
    }),

    // A proven transaction for reservation `id`. send({ simulate }) → tx hash. → the tx hash once sent.
    fulfil: async (id, tx, send, opts) => {
      const { sent } = await exclusive(async () => {
        await refresh();
        const e = entries.find((x) => x.id === id);
        if (!e || e.state !== 'reserved') throw stale('the reservation expired; reserve again');
        return fulfilLocked(e, tx, send, opts);
      });
      return sent;
    },

    // A proven transaction with no reservation: it takes the next slot if it was proven against the queue's tail.
    // opts.front: only into an empty queue (a transaction that is simulated before it is sent).
    append: async (tx, send, opts) => {
      const { sent } = await exclusive(async () => {
        await refresh();
        if (opts.front && entries.length) throw new PipelineError(429, 'transactions ahead of this one are still landing; try again in a few seconds');
        const p = tx.publicInputs.map(BigInt);
        const t = await tailTree();
        if (p[1] !== t.root || p[3] !== BigInt(t.size)) throw stale('the queue moved: prove against GET /head again');
        const { e } = await reserveLocked({ outLeaf: [p[9], p[10]], nfs: [p[7], p[8]], owner: null });
        try { return await fulfilLocked(e, tx, send, opts); }
        catch (err) { if (e.state === 'reserved') cut(entries.indexOf(e), 'an unreserved transaction failed its checks'); throw err; }
      });
      return sent;
    },

    // The pool's head and every queued slot's leaves, and the tail they end at. → { root, size, pending, tail }
    head: () => exclusive(async () => {
      await refresh();
      const t = await tailTree();
      const base = entries.length ? { root: entries[0].oldRoot, size: entries[0].start } : { root: t.root, size: BigInt(t.size) };
      return {
        root: base.root.toString(), size: base.size.toString(),
        pending: entries.map((e) => ({ outLeaf0: e.outLeaf[0].toString(), outLeaf1: e.outLeaf[1].toString(), newRoot: e.newRoot.toString() })),
        tail: { root: t.root.toString(), size: String(t.size) },
      };
    }),

    // Gives up a reservation (and, since their proofs build on it, every slot behind it).
    cancel: (id) => exclusive(async () => {
      const i = entries.findIndex((x) => x.id === id && x.state === 'reserved');
      if (i < 0) return;
      if (i < entries.length - 1) pause(entries[i]);
      cut(i, `slot ${entries[i].start} was given up`);
    }),
    busy: () => exclusive(async () => { await refresh(); return entries.length > 0; }),
    size: () => entries.length,
    stop: () => clearInterval(timer),
  };
}
