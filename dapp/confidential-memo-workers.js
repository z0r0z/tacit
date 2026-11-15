// Spreads a scan's memo probing over a few workers (confidential-memo-worker.js) so a first opening of a wallet on a device,
// which has to try every memo in the pool, neither holds the page's thread nor takes a single core's time over it.
//
//   const filter = makeMemoWorkers();          // pass to memo.scanSliced(…, { filter })
//   await filter(key, memos) → Int8Array | null
//
// One entry per memo: 0 it is not the key's, 1 it may be, -1 not known (a worker failed or took too long; the page tries that one itself).
// null: not worth it or not possible (few memos, no Workers, a blocked script): the page does all of them itself, as it always did.
// The workers are kept for a few seconds after the last batch and then ended, so a key is not kept in one for long. A page can hold more than one reader of
// the same pool (the front page and its swap card each open the wallet's balance): a request that is the same key over the same memos as
// one still running waits for that one's answer instead of starting a second set of workers on the same work.

export const CHUNK = 96;
export const MIN_MEMOS = 64;
export const CHUNK_MS = 30e3;
export const IDLE_MS = 8e3;

// What a request is, for telling that two are the same: a hash of the key and the memos (nothing is kept of it after the request).
const running = new Map();
async function same(key, memos) {
  try {
    const bytes = new TextEncoder().encode(String(key).toLowerCase() + '\n' + memos.join('\n'));
    const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

export { startWorker } from './worker-start.js';
import { startWorker } from './worker-start.js';

export function makeMemoWorkers({
  url = new URL('./confidential-memo-worker.js', import.meta.url),
  count = () => Math.min(4, Math.max(1, ((globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 2) - 2)),
  make = (u) => startWorker(u),
  available = () => typeof Worker === 'function',
  chunk = CHUNK, minMemos = MIN_MEMOS, chunkMs = CHUNK_MS, idleMs = IDLE_MS,
} = {}) {
  // A scan asks in batches (it keeps a checkpoint after each), so the workers are kept for `idleMs` after the last one instead of being made and ended for
  // every batch (a first login made sixty of them); they hold the key until then. One request at a time uses them.
  let pool = [], parked = null, queue = Promise.resolve(), seq = 0;
  const endAll = () => { for (const w of pool) { try { w.terminate(); } catch { } } pool = []; };
  const park = () => { clearTimeout(parked); parked = setTimeout(endAll, idleMs); };
  const ask = (w, msg) => new Promise((done) => {
    const timer = setTimeout(() => { w.bad = true; done(null); }, chunkMs);
    w.onmessage = (e) => { if (e.data && e.data.id === msg.id) { clearTimeout(timer); done(e.data); } };
    w.onerror = () => { clearTimeout(timer); w.bad = true; done(null); };
    try { w.postMessage(msg); } catch { clearTimeout(timer); w.bad = true; done(null); }
  });

  return async function filter(key, memos) {
    if (!available() || !Array.isArray(memos) || memos.length < minMemos) return null;
    const id = await same(key, memos);
    const held = id && running.get(id);
    if (held) return held;
    const mine = queue.then(() => probeAll(key, memos));
    queue = mine.catch(() => {});
    if (id) { running.set(id, mine); mine.then(() => running.delete(id), () => running.delete(id)); }
    return mine;
  };

  async function probeAll(key, memos) {
    clearTimeout(parked);
    const said = new Int8Array(memos.length).fill(-1);
    const parts = Math.ceil(memos.length / chunk);
    const k = Math.min(Math.max(1, Number(count()) || 1), parts);
    while (pool.length < k) { try { pool.push(make(url)); } catch { break; } }
    let next = 0;
    const drive = async (w) => {
      while (!w.bad && next < parts) {
        const part = next++, from = part * chunk, to = Math.min(memos.length, from + chunk);
        const r = await ask(w, { id: ++seq, key, memos: memos.slice(from, to) });
        if (r && r.said && r.said.length === to - from) said.set(r.said, from);
        else w.bad = true;
      }
    };
    try { await Promise.all(pool.slice(0, k).map(drive)); }
    finally {
      for (const w of pool) if (w.bad) { try { w.terminate(); } catch { } }
      pool = pool.filter((w) => !w.bad);
      if (pool.length) park();
    }
    return said;
  }
}
