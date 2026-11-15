// Reads leaves of the Bitcoin pool's note feed for a wallet in a few workers (btc-pool-scan-worker.js), for the first read of a feed and for opening the notes a kept record lists
// (btc-pool-client.js scanMine).
//
//   const workers = makeBtcScanWorkers();
//   await workers(wallet, leaves, { minLeaves }) → [note | null | undefined, …] | null
//
// One entry per leaf: a note (the object the pool's receive gives), null (it is not a note of the wallet), undefined (not known: a worker failed or took too long, and the page reads that
// leaf). null for the whole answer: too few leaves to be worth it, no Workers, none could be made; the page reads them all, as it always did. `wallet` is the wallet's keys (the
// view keys, and the nullifier and spend keys when it has them); only the fields the pool's receive reads are sent. A page reads feeds more than once (a wallet, a claim, the kept
// notes of a record), so the workers are kept `idleMs` after the last job rather than made again for each; they hold the keys until then.
import { startWorker } from './worker-start.js';

export const CHUNK = 12;
export const MIN_LEAVES = 24;
export const CHUNK_MS = 60e3;
export const IDLE_MS = 8e3;
const KEYS = ['v', 'vInt', 'A', 'N', 'n', 'a'];

export function makeBtcScanWorkers({
  url = new URL('./btc-pool-scan-worker.js', import.meta.url),
  count = () => Math.min(4, Math.max(1, ((globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 2) - 2)),
  make = (u) => startWorker(u),
  available = () => typeof Worker === 'function',
  chunk = CHUNK, minLeaves = MIN_LEAVES, chunkMs = CHUNK_MS, idleMs = IDLE_MS,
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

  async function run(keys, leaves) {
    clearTimeout(parked);
    const out = new Array(leaves.length).fill(undefined);
    const parts = Math.ceil(leaves.length / chunk);
    const k = Math.min(Math.max(1, Number(count()) || 1), parts);
    while (pool.length < k) { try { pool.push(make(url)); } catch { break; } }
    let next = 0;
    const drive = async (w) => {
      while (!w.bad && next < parts) {
        const part = next++, from = part * chunk, to = Math.min(leaves.length, from + chunk);
        const r = await ask(w, { id: ++seq, wallet: keys, leaves: leaves.slice(from, to) });
        if (r && Array.isArray(r.notes) && r.notes.length === to - from) for (let j = 0; j < r.notes.length; j++) out[from + j] = r.notes[j];
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

  return async function btcScanWorkers(wallet, leaves, { minLeaves: min = minLeaves } = {}) {
    if (!available() || !wallet || wallet.v == null || !Array.isArray(leaves) || leaves.length < min) return null;
    const keys = {};
    for (const f of KEYS) if (wallet[f] != null) keys[f] = wallet[f];
    const feed = leaves.map((f) => ({ leafIndex: f.leafIndex, leaf: f.leaf, asset: f.asset, pkEph: f.pkEph, ctNote: f.ctNote }));
    const mine = queue.then(() => run(keys, feed));
    queue = mine.catch(() => {});
    return mine;
  };
}
