// Works out whether a batch of transfers hold anything for the wallet's key in a few workers (stealth-scan-worker.js), for the scan for shielded payments
// (tacit.js scanAssetForStealthReceipts).
//
//   const workers = makeStealthWorkers();
//   await workers({ walletPriv, walletPub, networkTag }, jobs) → [true | false | undefined, …] | null
//
// One entry per job: true it holds nothing for the key, false it holds a credit, undefined not known (a worker failed or took too long; the page works that one out).
// null (the whole answer): too few jobs to be worth it, no Workers, none could be made; the page works them all out, as it always did. A scan reads a page of transfers at a
// time, so the workers are kept `idleMs` after the last batch rather than made again for each; they hold the key until then.
import { startWorker } from './worker-start.js';

export const CHUNK = 12;
export const MIN_JOBS = 12;
export const CHUNK_MS = 60e3;
export const IDLE_MS = 8e3;

export function makeStealthWorkers({
  url = new URL('./stealth-scan-worker.js', import.meta.url),
  count = () => Math.min(4, Math.max(1, ((globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 2) - 2)),
  make = (u) => startWorker(u),
  available = () => typeof Worker === 'function',
  chunk = CHUNK, minJobs = MIN_JOBS, chunkMs = CHUNK_MS, idleMs = IDLE_MS,
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

  async function run(key, jobs) {
    clearTimeout(parked);
    const out = new Array(jobs.length).fill(undefined);
    const parts = Math.ceil(jobs.length / chunk);
    const k = Math.min(Math.max(1, Number(count()) || 1), parts);
    while (pool.length < k) { try { pool.push(make(url)); } catch { break; } }
    let next = 0;
    const drive = async (w) => {
      while (!w.bad && next < parts) {
        const part = next++, from = part * chunk, to = Math.min(jobs.length, from + chunk);
        const r = await ask(w, { id: ++seq, walletPriv: key.walletPriv, walletPub: key.walletPub, networkTag: key.networkTag, jobs: jobs.slice(from, to) });
        if (r && Array.isArray(r.nothing) && r.nothing.length === to - from) for (let j = 0; j < r.nothing.length; j++) out[from + j] = r.nothing[j];
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

  return async function stealthWorkers(key, jobs) {
    if (!available() || !Array.isArray(jobs) || jobs.length < minJobs) return null;
    const mine = queue.then(() => run(key, jobs));
    queue = mine.catch(() => {});
    return mine;
  };
}
