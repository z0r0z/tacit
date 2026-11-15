// Makes the lower levels of the pool's Merkle tree in a few workers (confidential-tree-worker.js), for the first root or path of a tree the page asks for
// (confidential-pool.js Tree.prepare).
//
//   const workers = makeTreeWorkers();
//   await workers(leaves, n) → { h, lower: [Uint8Array × h] } | null
//
// `leaves`: the n leaves packed in one buffer. The leaves are cut in chunks of 2^h (confidential-tree-core.js chunkHeight) that the workers make at once, and `lower` has
// levels 1..h of the whole tree, the pieces of each level put in order; the page makes the rest (core.finish: a few hashes). null: too few leaves to be worth it, no Workers, none
// could be made, or a worker failed, was too long or gave an answer that is not the size it has to be, and the page makes the whole of it, as it always did. The workers are
// kept `idleMs` after the last tree, as a page asks for more than one (the pool's, the snapshot's, the live set's).
import { startWorker } from './worker-start.js';
import { chunkHeight, nodesAt } from './confidential-tree-core.js';

export const MIN_LEAVES = 1024;
export const CHUNK_MS = 60e3;
export const IDLE_MS = 8e3;
const WARM_LEAVES = 256, WARM_H = 8;

export function makeTreeWorkers({
  url = new URL('./confidential-tree-worker.js', import.meta.url),
  count = () => Math.min(2, Math.max(1, ((globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 2) - 2)),     // two are as quick as four for a tree of this size, and the page starts many workers
  make = (u) => startWorker(u),
  available = () => typeof Worker === 'function',
  minLeaves = MIN_LEAVES, chunkMs = CHUNK_MS, idleMs = IDLE_MS,
} = {}) {
  let pool = [], parked = null, queue = Promise.resolve(), seq = 0;
  const endAll = () => { for (const w of pool) { try { w.terminate(); } catch { } } pool = []; };
  const park = () => { clearTimeout(parked); parked = setTimeout(endAll, idleMs); };
  const ask = (w, msg) => new Promise((done) => {
    const timer = setTimeout(() => { w.bad = true; done(null); }, chunkMs);
    w.onmessage = (e) => { if (e.data && e.data.id === msg.id) { clearTimeout(timer); done(e.data); } };
    w.onerror = () => { clearTimeout(timer); w.bad = true; done(null); };
    try { w.postMessage(msg, [msg.leaves]); } catch { clearTimeout(timer); w.bad = true; done(null); }
  });

  async function run(leaves, n) {
    clearTimeout(parked);
    const k = Math.min(Math.max(1, Number(count()) || 1), Math.ceil(n / 256));
    const h = chunkHeight(n, k), size = 2 ** h, parts = Math.ceil(n / size);
    while (pool.length < Math.min(k, parts)) { try { pool.push(make(url)); } catch { break; } }
    if (!pool.length) return null;
    const pieces = new Array(parts).fill(null);
    let next = 0;
    const drive = async (w) => {
      while (!w.bad && next < parts) {
        const part = next++, from = part * size, c = Math.min(size, n - from);
        const r = await ask(w, { id: ++seq, leaves: leaves.slice(from * 32, (from + c) * 32).buffer, count: c, h });
        const ok = r && Array.isArray(r.levels) && r.levels.length === h && r.levels.every((b, j) => b instanceof ArrayBuffer && b.byteLength === nodesAt(c, j + 1) * 32);
        if (ok) pieces[part] = r.levels.map((b) => new Uint8Array(b)); else w.bad = true;
      }
    };
    try { await Promise.all(pool.slice(0, Math.min(k, parts)).map(drive)); }
    finally {
      for (const w of pool) if (w.bad) { try { w.terminate(); } catch { } }
      pool = pool.filter((w) => !w.bad);
      if (pool.length) park();
    }
    if (pieces.some((p) => !p)) return null;
    // put the chunks' pieces of each level in order
    const lower = [];
    for (let j = 0; j < h; j++) {
      const out = new Uint8Array(nodesAt(n, j + 1) * 32);
      let off = 0;
      for (const p of pieces) { out.set(p[j], off); off += p[j].length; }
      if (off !== out.length) return null;
      lower.push(out);
    }
    return { h, lower };
  }

  // Starts the workers and has each make a small tree (about two hundred hashes), so the first real tree finds them loaded and their code compiled. The page asks for this when it
  // starts to read the pool's history, which is a wait on the network, so the start of the workers (the most of what a first tree costs in them) is over by the time a tree comes.
  // They are ended `idleMs` after this if no tree comes, as after any other.
  async function warm() {
    if (!available()) return;
    const mine = queue.then(async () => {
      clearTimeout(parked);
      const k = Math.max(1, Number(count()) || 1);
      while (pool.length < k) { try { pool.push(make(url)); } catch { break; } }
      await Promise.all(pool.slice(0, k).map(async (w) => {
        if (w.bad) return;
        const r = await ask(w, { id: ++seq, leaves: new ArrayBuffer(WARM_LEAVES * 32), count: WARM_LEAVES, h: WARM_H });
        if (!(r && Array.isArray(r.levels) && r.levels.length === WARM_H)) w.bad = true;
      }));
      for (const w of pool) if (w.bad) { try { w.terminate(); } catch { } }
      pool = pool.filter((w) => !w.bad);
      if (pool.length) park();
    });
    queue = mine.catch(() => {});
    return mine;
  }

  const treeWorkers = async function treeWorkers(leaves, n) {
    if (!available() || !(leaves instanceof Uint8Array) || leaves.length !== n * 32 || n < minLeaves) return null;
    const mine = queue.then(() => run(leaves, n));
    queue = mine.catch(() => {});
    return mine;
  };
  treeWorkers.warm = warm;
  return treeWorkers;
}
