// How many requests one page has in flight to one public node. A shared public key answers 429 to a burst, and the console lists every refused request;
// a scan of a pool's history is a burst. Measured 2026-11-08: nodereal's key (the one every visitor reads through) serves three wide eth_getLogs at once
// and answers 429 to a fourth, then to everything for a while after; Base's own endpoint answers 429 past about twenty-five in a burst. A request over
// the limit waits its turn here, in the order it was asked, and is sent when one before it is done, so the node is never asked for more than it serves.
//
// A host or a method with no entry is not limited: `pace` then returns what `send` returns, with nothing in between. A queued request that is cancelled
// (its signal aborts: a timeout, or a hedge that was beaten) leaves the queue without being sent.

const LANES = {
  'eth-mainnet.nodereal.io': { eth_getLogs: 3 },
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
