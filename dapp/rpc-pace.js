
const LANES = {
  'eth-mainnet.nodereal.io': { eth_getLogs: 3 },
  'rpc.mevblocker.io': { eth_getLogs: 2 },
  'mainnet.rpc.buidlguidl.com': { eth_getLogs: 3 },
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

export function busy(url, method) {
  const lane = laneOf(url, method);
  return lane ? lane.running + lane.queue.length : 0;
}

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
