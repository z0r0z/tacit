// How many requests one page has in flight to one public node. A shared public key answers 429 to a burst, and the console lists every refused request;
// a scan of a pool's history is a burst. Measured 2026-11-08: nodereal's key (the one every visitor reads through) serves three wide eth_getLogs at once
// and answers 429 to a fourth, then to everything for a while after; mevblocker answers a wide log query with "service temporarily unavailable" more often the more
// are at once (two are mostly served); Base's own endpoint answers 429 past about twenty-five in a burst. A request over
// the limit waits its turn here, in the order it was asked, and is sent when one before it is done, so the node is never asked for more than it serves.
//
// A host or a method with no entry is not limited: `pace` then returns what `send` returns, with nothing in between. A queued request that is cancelled
// (its signal aborts: a timeout, or a hedge that was beaten) leaves the queue without being sent.

const LANES = {
  'eth-mainnet.nodereal.io': { eth_getLogs: 3 },
  'rpc.mevblocker.io': { eth_getLogs: 2 },
  'mainnet.base.org': { '*': 4 },
};

const lanes = new Map();
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
function laneOf(url, method) {
  const table = LANES[hostOf(url)];
  if (!table) return null;
  const name = table[method] ? method : table['*'] ? '*' : null;
  if (!name) return null;
  const key = hostOf(url) + '|' + name;
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, lane = { cap: table[name], running: 0, queue: [] });
  return lane;
}
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export function pace(url, method, send, signal = null) {
  const lane = laneOf(url, method);
  if (!lane) return send();
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const entry = { start() { lane.running++; let p; try { p = Promise.resolve(send()); } catch (e) { p = Promise.reject(e); } p.then(resolve, reject).then(() => { lane.running--; drain(lane); }); } };
    if (signal) {
      entry.off = () => signal.removeEventListener('abort', entry.cancel);
      entry.cancel = () => { const i = lane.queue.indexOf(entry); if (i >= 0) { lane.queue.splice(i, 1); reject(aborted()); } };
      signal.addEventListener('abort', entry.cancel, { once: true });
    }
    lane.queue.push(entry);
    drain(lane);
  });
}
function drain(lane) {
  while (lane.running < lane.cap && lane.queue.length) {
    const entry = lane.queue.shift();
    entry.off?.();
    entry.start();
  }
}

// How many requests of this kind are in flight or waiting to one node (0 for a node that is not limited): for a caller that can send to any of several.
export function busy(url, method) {
  const lane = laneOf(url, method);
  return lane ? lane.running + lane.queue.length : 0;
}

// The same read asked twice. A page can hold two copies of a module (one loaded by its tokened URL, one by its bare URL), and each reads the pool on
// its own, so the node is asked what it was asked a moment ago. `once` runs `run` for a key and gives everyone who asks the same key the same answer: while it is
// under way, and for `ttlMs` after (a range of blocks that is fixed does not change). An answer that failed is not kept. `scope` (the fetch the readers
// use) keeps readers that are not on the same footing apart; this module is loaded once, so what it keeps is shared by the copies.
const ONCE = new WeakMap(), PAGE = {};
export function once(scope, key, ttlMs, run) {
  const s = scope && (typeof scope === 'object' || typeof scope === 'function') ? scope : PAGE;
  const kept = ONCE.get(s) || ONCE.set(s, new Map()).get(s);
  const hit = kept.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.p;
  const entry = { p: null, at: Date.now(), pending: true };
  entry.p = Promise.resolve().then(run);
  kept.set(key, entry);
  entry.p.then(() => { entry.pending = false; entry.at = Date.now(); }, () => { if (kept.get(key) === entry) kept.delete(key); });
  if (kept.size > 256) { for (const [k, e] of kept) { if (!e.pending && Date.now() - e.at >= ttlMs) kept.delete(k); if (kept.size <= 192) break; } }
  return entry.p;
}
