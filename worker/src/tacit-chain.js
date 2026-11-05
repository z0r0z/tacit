// The pool's history as a chain of blocks, read from the confidential index (every LeavesInserted, NullifiersSpent, lock and Wrap
// log of the live pool, in order). A block is one Ethereum transaction that changed the pool's notes: a settle, alone or with the
// deposit it consumes. A deposit on its own changes no note and is not a block; it waits for one. Nothing here is decided by Tacit:
// the order is Ethereum's, the contents are the logs, and anyone can rebuild every block and its hash from the logs alone.
//
//   hash(block) = keccak256(prev ‖ uint64 height ‖ uint64 ethBlock ‖ tx ‖ keccak256(leaves…) ‖ keccak256(nullifiers…))
//
// with prev = 32 zero bytes for height 0, each leaf and nullifier 32 bytes in log order (lock leaves after note leaves, lock nullifiers
// after note nullifiers), and keccak256 of no bytes for an empty list. docs/TACIT-CHAIN.md says the same for someone checking it.
//
// A block names its prover when the proof pool kept a proof that inserts one of its leaves (proof-pool.js minedBy): a community
// prover's address and the points it earned, or `house` for Tacit's own GPU, which earns nothing. Blocks proved any other way name none.
//
// Storage (KV): ch:head ({ seq, height, hash, at }: the next index entry to read and the chain's tip), ch:recent (the newest blocks,
// newest last).
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

export const CHAIN = Object.freeze({ keep: 200, page: 1000, maxPagesPerSync: 40, staleMs: 10_000 });
const ZERO = '0x' + '00'.repeat(32);

const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const b32 = (h) => hexToBytes(String(h).replace(/^0x/, '').padStart(64, '0'));
const listHash = (xs) => keccak_256(concatBytes(...xs.map(b32)));

export function blockHash({ prev, height, ethBlock, tx, leaves, nullifiers }) {
  return '0x' + bytesToHex(keccak_256(concatBytes(b32(prev), u64(height), u64(ethBlock), b32(tx), listHash(leaves), listHash(nullifiers))));
}

// One transaction's index entries → its block body, or null when it changed no note (a deposit alone).
export function bodyOf(entries) {
  const leaves = [], locks = [], nullifiers = [], lockNfs = [];
  let deposits = 0;
  for (const e of entries) {
    if (e.excluded) continue;
    if (e.type === 'leaves') leaves.push(...(e.leaves || []));
    else if (e.type === 'nullifiers') nullifiers.push(...(e.nullifiers || []));
    else if (e.type === 'locks') { locks.push(...(e.lockLeaves || [])); lockNfs.push(...(e.lockNullifiers || [])); }
    else if (e.type === 'wrap') deposits++;
  }
  if (!leaves.length && !nullifiers.length && !locks.length && !lockNfs.length) return null;
  return { ethBlock: entries[0].block, tx: entries[0].tx, leaves: [...leaves, ...locks], nullifiers: [...nullifiers, ...lockNfs], notes: leaves.length, spent: nullifiers.length, deposits };
}

// Index entries (in seq order) → transactions, each complete: a transaction in a block the index has not finished is held back, and so
// is the last one of a full page (`more`), whose entries may go on into the next.
export function txGroups(entries, indexedToBlock, more = false) {
  const out = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last[0].tx === e.tx) last.push(e); else out.push([e]);
  }
  while (out.length && out[out.length - 1][0].block > indexedToBlock) out.pop();
  if (more && out.length > 1) out.pop();
  return out;
}

// kv: { get, put }. index: confidential-index's { fresh, read }. minedBy(leaves) → { [leaf]: { miner, points } } for the leaves a
// community proof inserted.
export function makeChain({ kv, index, minedBy = async () => ({}), cfg = CHAIN, now = () => Date.now() } = {}) {
  const read = async (k, d) => { const s = await kv.get(k); if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
  const write = (k, v) => kv.put(k, JSON.stringify(v));
  let running = null;

  async function syncOnce() {
    try { await index.fresh(); } catch {}
    let head = await read('ch:head', { seq: 0, height: -1, hash: ZERO, at: 0 });
    let recent = await read('ch:recent', []);
    for (let p = 0; p < cfg.maxPagesPerSync; p++) {
      const r = await index.read({ from: head.seq, limit: cfg.page });
      if (r.headBlock != null) head = { ...head, ethHead: r.headBlock };
      const groups = txGroups(r.entries || [], r.indexedToBlock, (r.entries || []).length >= cfg.page);
      if (!groups.length) break;
      const made = [];
      for (const g of groups) {
        const body = bodyOf(g);
        head = { ...head, seq: g[g.length - 1].seq + 1 };
        if (!body) continue;
        const height = head.height + 1, hash = blockHash({ prev: head.hash, height, ...body });
        made.push({ height, hash, prev: head.hash, ...body });
        head = { ...head, height, hash };
      }
      if (made.length) {
        const tail = made.slice(-cfg.keep), who = await minedBy(tail.flatMap((b) => b.leaves)).catch(() => ({}));
        for (const b of tail) {
          const m = b.leaves.map((l) => who[l.toLowerCase()]).find(Boolean);
          if (m?.house) b.house = true;
          else if (m) { b.prover = m.miner; b.points = m.points; }
        }
        recent = [...recent, ...tail].slice(-cfg.keep);
      }
      if ((r.entries || []).length < cfg.page) break;
    }
    head.at = now();
    await write('ch:recent', recent);
    await write('ch:head', head);
    return { head, recent };
  }
  const sync = () => running || (running = syncOnce().finally(() => { running = null; }));

  // The tip (with Ethereum's newest block, so a reader can say how long ago each block was) and the newest `limit` blocks, newest first, each without its leaf and nullifier lists (counts only); `before` pages back.
  async function blocks({ limit = 30, before = null } = {}) {
    let head = await read('ch:head', null), recent;
    if (!head || now() - head.at > cfg.staleMs) ({ head, recent } = await sync()); else recent = await read('ch:recent', []);
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 30)));
    const top = before == null ? Infinity : Number(before);
    const list = recent.filter((b) => b.height < top).slice(-n).reverse()
      .map(({ leaves, nullifiers, ...b }) => b);
    return { head: { height: head.height, hash: head.hash, ethHead: head.ethHead ?? null }, blocks: list };
  }

  return { sync, blocks };
}
