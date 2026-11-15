// Spreads a scan's memo probing over a few workers (confidential-memo-worker.js) so a first opening of a wallet on a device,
// which has to try every memo in the pool, neither holds the page's thread nor takes a single core's time over it.
//
//   const filter = makeMemoWorkers();          // pass to memo.scanSliced(…, { filter })
//   await filter(key, memos) → Int8Array | null
//
// One entry per memo: 0 it is not the key's, 1 it may be, -1 not known (a worker failed or took too long; the page tries that one itself).
// null: not worth it or not possible (few memos, no Workers, a blocked script): the page does all of them itself, as it always did.
// Workers are made for one scan and ended with it, so a key is not kept in one between scans. A page can hold more than one reader of
// the same pool (the front page and its swap card each open the wallet's balance): a request that is the same key over the same memos as
// one still running waits for that one's answer instead of starting a second set of workers on the same work.

export const CHUNK = 96;
export const MIN_MEMOS = 64;
export const CHUNK_MS = 30e3;

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
  chunk = CHUNK, minMemos = MIN_MEMOS, chunkMs = CHUNK_MS,
} = {}) {
  return async function filter(key, memos) {
    if (!available() || !Array.isArray(memos) || memos.length < minMemos) return null;
    const id = await same(key, memos);
    const held = id && running.get(id);
    if (held) return held;
    const run = probeAll(key, memos);
    if (id) { running.set(id, run); run.then(() => running.delete(id), () => running.delete(id)); }
    return run;
  };

  async function probeAll(key, memos) {
    const said = new Int8Array(memos.length).fill(-1);
    const parts = Math.ceil(memos.length / chunk);
    const k = Math.min(Math.max(1, Number(count()) || 1), parts);
    let next = 0;
    const workers = [];
    const drive = async () => {
      let w;
      try { w = make(url); } catch { return; }
      workers.push(w);
      let bad = false;
      const ask = (id, from, to) => new Promise((done) => {
        const timer = setTimeout(() => { bad = true; done(null); }, chunkMs);
        w.onmessage = (e) => { if (e.data && e.data.id === id) { clearTimeout(timer); done(e.data); } };
        w.onerror = () => { clearTimeout(timer); bad = true; done(null); };
        try { w.postMessage({ id, key, memos: memos.slice(from, to) }); } catch { clearTimeout(timer); bad = true; done(null); }
      });
      while (!bad && next < parts) {
        const part = next++, from = part * chunk, to = Math.min(memos.length, from + chunk);
        const r = await ask(part, from, to);
        if (r && r.said && r.said.length === to - from) said.set(r.said, from);
        else bad = true;
      }
    };
    try { await Promise.all(Array.from({ length: k }, drive)); }
    finally { for (const w of workers) { try { w.terminate(); } catch { } } }
    return said;
  }
}
