// Runs the bridge-mint walk's nullifier chunks (confidential-recovery.js walkBridgeMints) in a few workers (confidential-bridge-worker.js), so a
// first opening of a wallet on a device neither holds the page's thread nor takes one core's time over it.
//
//   const bridgeWorkers = makeBridgeWorkers();        // given to makeConfidentialRecovery({ bridgeWorkers })
//   await bridgeWorkers(job, chunks) → [{ found, tried } | null, …]    one entry per chunk, null where a worker did not answer it
//
// null (the whole answer): no Workers or none could be made; the page then searches every chunk itself, as it always did. A walk is many
// slices one after the other, so the workers are kept for `idleMs` after the last job rather than made again for each; they hold the key until then.
// The same job asked for twice at once (the front page and its swap card both open the balance) is run once.
import { startWorker } from './worker-start.js';

export const CHUNK_MS = 120e3;
export const IDLE_MS = 8e3;

const running = new Map();

// A name for what is asked, for telling that two asks are the same and for the worker to keep its setup under: a hash of the text (nothing is kept of it).
async function digest(text) {
  try {
    const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// what a worker is sent, with nothing in it a message cannot carry
function setupOf({ p, owners, values, roundValues, maxExp }) {
  return {
    p: Uint8Array.from(p), values: (values || []).map((v) => String(v)), roundValues: !!roundValues, maxExp: Number(maxExp),
    owners: owners.map((o) => ({ asset: { assetId: o.asset.assetId }, idBytes: Uint8Array.from(o.idBytes), notes: o.notes.map((n) => ({ i: n.i, secret: n.secret, owner: n.owner, ownerBytes: Uint8Array.from(n.ownerBytes) })) })),
  };
}
const setupText = (s) => JSON.stringify([hexOf(s.p), s.values, s.roundValues, s.maxExp, s.owners.map((o) => [o.asset.assetId, hexOf(o.idBytes), o.notes.map((n) => [n.i, n.secret, n.owner])])]);

export function makeBridgeWorkers({
  url = new URL('./confidential-bridge-worker.js', import.meta.url),
  count = () => Math.min(4, Math.max(1, ((globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 2) - 2)),
  make = (u) => startWorker(u),
  available = () => typeof Worker === 'function',
  chunkMs = CHUNK_MS, idleMs = IDLE_MS,
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

  async function run(job, chunks) {
    clearTimeout(parked);
    const setup = setupOf(job), setupKey = (await digest(setupText(setup))) || String(++seq);
    const results = new Array(chunks.length).fill(null);
    const k = Math.min(Math.max(1, Number(count()) || 1), chunks.length);
    while (pool.length < k) { try { pool.push(make(url)); } catch { break; } }
    let next = 0;
    const drive = async (w) => {
      while (!w.bad && next < chunks.length) {
        const i = next++;
        const r = await ask(w, { id: ++seq, setupKey, setup, nulls: chunks[i].map((x) => ({ n: x.n, want: [...x.want] })) });
        if (r && Array.isArray(r.found) && Number.isFinite(r.tried)) results[i] = { found: r.found, tried: r.tried };
        else w.bad = true;
      }
    };
    try { await Promise.all(pool.slice(0, k).map(drive)); }
    finally {
      for (const w of pool) if (w.bad) { try { w.terminate(); } catch { } }
      pool = pool.filter((w) => !w.bad);
      if (pool.length) park();
    }
    return results;
  }

  return async function bridgeWorkers(job, chunks) {
    if (!available() || !Array.isArray(chunks) || !chunks.length) return null;
    const id = await digest(setupText(setupOf(job)) + '\n' + JSON.stringify(chunks.map((c) => c.map((x) => [x.n, [...x.want]]))));
    const held = id && running.get(id);
    if (held) return held;
    const mine = queue.then(() => run(job, chunks));
    queue = mine.catch(() => {});
    if (id) { running.set(id, mine); mine.then(() => running.delete(id), () => running.delete(id)); }
    return mine;
  };
}
