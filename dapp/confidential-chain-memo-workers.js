// Opens a page of Tacit chain memos in a few workers (confidential-chain-memo-worker.js), for the chain wallet's scan (tacit-chain-wallet.js `openMany`).
//
//   const openMany = makeChainMemoWorkers();       // makeChainClient gives one to the wallet
//   await openMany(memos, secret) → [{ value, s } | null | undefined, …] | null
//
// One entry per memo: null it is not the key's, { value, s } it is, undefined not known (a worker failed or took too long; the wallet opens that one).
// null (the whole answer): too few memos to be worth it, no Workers, none could be made; the wallet opens them all, as it always did. A scan reads the chain a
// page at a time, so the workers are kept `idleMs` after the last page rather than made again for each; they hold the key until then.
import { startWorker } from './worker-start.js';

export const CHUNK = 20;
export const MIN_MEMOS = 16;
export const CHUNK_MS = 60e3;
export const IDLE_MS = 8e3;

export function makeChainMemoWorkers({
  url = new URL('./confidential-chain-memo-worker.js', import.meta.url),
  count = () => Math.min(4, Math.max(1, ((globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 2) - 2)),
  make = (u) => startWorker(u),
  available = () => typeof Worker === 'function',
  chunk = CHUNK, minMemos = MIN_MEMOS, chunkMs = CHUNK_MS, idleMs = IDLE_MS,
} = {}) {
  let pool = [], parked = null, queue = Promise.resolve(), seq = 0;
  const endAll = () => { for (const w of pool) { try { w.terminate(); } catch { } } pool = []; };
  const park = () => { clearTimeout(parked); parked = setTimeout(endAll, idleMs); };
  const ask = (w, msg) => new Promise((done) => {
    const timer = setTimeout(() => { w.bad = true; done(null); }, chunkMs);
    w.onmessage = (e) => { if (e.data && e.data.id === msg.id) { clearTimeout(timer); done(e.data); } };
    w.onerror = () => { clearTimeout(timer); w.bad = true; done(null); };
    try { w.postMessage(msg); } catch { clearTimeout(timer); w.bad = true; done(null); }
  });

  async function run(memos, secret) {
    clearTimeout(parked);
    const out = new Array(memos.length).fill(undefined);
    const parts = Math.ceil(memos.length / chunk);
    const k = Math.min(Math.max(1, Number(count()) || 1), parts);
    while (pool.length < k) { try { pool.push(make(url)); } catch { break; } }
    let next = 0;
    const drive = async (w) => {
      while (!w.bad && next < parts) {
        const part = next++, from = part * chunk, to = Math.min(memos.length, from + chunk);
        const r = await ask(w, { id: ++seq, secret, memos: memos.slice(from, to) });
        if (r && Array.isArray(r.opened) && r.opened.length === to - from) for (let j = 0; j < r.opened.length; j++) out[from + j] = r.opened[j];
        else w.bad = true;
      }
    };
    try { await Promise.all(pool.slice(0, k).map(drive)); }
    finally {
      for (const w of pool) if (w.bad) { try { w.terminate(); } catch { } }
      pool = pool.filter((w) => !w.bad);
      if (pool.length) park();
    }
    return out;
  }

  return async function openMany(memos, secret) {
    if (!available() || !Array.isArray(memos) || memos.length < minMemos) return null;
    const mine = queue.then(() => run(memos, secret));
    queue = mine.catch(() => {});
    return mine;
  };
}
