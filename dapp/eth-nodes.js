// a namespace import, and `?.`: this file and wallet-prompts.js are served without a cache token, so for a few minutes after a change a visit can hold one of them new and the other old
import * as prompts from './wallet-prompts.js';

// Keep retired or origin-blocked endpoints out of the browser retry set. A failed fallback still creates a failed-resource
// console entry and spends time before the next healthy node is tried.
export const ETH_NODES = [
  // PublicNode currently returns browser-specific HTTP 403s for this app, even
  // though the same JSON-RPC payload works from other clients. Keep it out of
  // the default browser route so a visitor never pays for that failed first try.
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://ethereum-json-rpc.stakely.io',
  // The light gateway is promoted ahead of these nodes for cheap latest-state reads;
  // its position here keeps it out of the way for history, receipts, and logs.
  'https://tacit-node-gw.onrender.com/eth',
  // Last resorts: they answer a browser with a 429 (no CORS headers, so the console shows a CORS block), and a browser prints a line for every failed request.
  'https://rpc.mevblocker.io',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
];
export const ETH_LOG_NODES = [
  'https://tacit-node-gw.onrender.com/eth',
  'https://ethereum-json-rpc.stakely.io',
  'https://rpc.mevblocker.io',
  'https://rpc.mevblocker.io/fast',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
];
export const ETH_ARCHIVE_NODES = [
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://rpc.mevblocker.io',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
];

export const BASE_NODES = [
  'https://base-rpc.publicnode.com',
  'https://base-mainnet.public.blastapi.io',
  'https://base.drpc.org',
  'https://mainnet.base.org',
];
export const ROBINHOOD_NODES = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com',
  'https://robinhood.drpc.org',
];

const LIMITS = {
  'ethereum-rpc.publicnode.com': { logs: 9999, back: 9999, state: true, batch: 50 },
  'rpc.mevblocker.io': { logs: 45000, batch: 25, last: true },
  'mainnet.rpc.buidlguidl.com': { logs: 10000, last: true },
  'tacit-node-gw.onrender.com/eth': { logs: 512, state: true },
  'eth-mainnet.nodereal.io': { logs: 49999, shared: true },
  'rpc.flashbots.net': { logs: 0 },
  'robinhood-rpc.publicnode.com': { logs: 0, state: true },
  'eth.drpc.org': { logs: 0 },
  '1.rpc.thirdweb.com': { logs: 2000 },
  'ethereum-json-rpc.stakely.io': { logs: 25 },
  '1rpc.io/eth': { logs: 50, last: true },
  // answers a log read of more than 10 blocks with a 400, so it is never asked one
  'eth-mainnet.public.blastapi.io': { logs: 0, last: true },
  'base.drpc.org': { logs: 0 },
  'base-mainnet.public.blastapi.io': { logs: 0 },
  'robinhood.drpc.org': { logs: 0, state: true },
  '127.0.0.1:8545': { logs: 512, state: true },
};
const limitsOf = (url) => {
  const id = String(url).replace(/^https?:\/\//, '');
  for (const k of Object.keys(LIMITS)) if (id === k || id.startsWith(k + '/')) return LIMITS[k];
  return null;
};
export const logSpan = (url) => limitsOf(url)?.logs || Infinity;
// How many reads a node takes in one JSON-RPC batch, 0 for one that is not sent batches (not measured, or no history: the light node answers an old transaction
// with null). Measured 2026-11-25 with Origin tacit.finance, 377 eth_getTransactionByHash: publicnode 100 a batch fine (0.5 s for all), mevblocker 25 (3.7 s).
export const batchSize = (url) => limitsOf(url)?.batch || 0;
export const isShared = (url) => !!limitsOf(url)?.shared;
// A node that answers a browser with 429s (no CORS headers, so a CORS block in the console): asked only when every other has failed, whatever its log span.
// The nodes whose agreement ends a swap in a browser: the page's list without the last resorts, four of them, two of which must agree (makeNodeQuorum asks them all at once).
export const browserAgreeNodes = () => ETH_NODES.filter((u) => !limitsOf(u)?.last).slice(0, 4);
export const lastResort = (url) => !!limitsOf(url)?.last;
const blockNo = (t) => (typeof t === 'string' && /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : null);
const STATE_BLOCK = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1, eth_getStorageAt: 2, eth_getTransactionCount: 1 };
export function refuses(url, method, params, head = null) {
  const lim = limitsOf(url);
  if (!lim) return false;
  if (method === 'eth_getLogs') {
    if (lim.logs === 0) return true;
    const f = (Array.isArray(params) && params[0]) || {}, from = blockNo(f.fromBlock), to = blockNo(f.toBlock);
    if (from != null && to != null && lim.logs != null && to - from + 1 > lim.logs) return true;
    const end = head ?? to;
    return lim.back != null && from != null && end != null && end - from > lim.back;
  }
  return !!lim.state && method in STATE_BLOCK && blockNo(params?.[STATE_BLOCK[method]]) != null;
}

const WALLET_READS = new Set(['eth_call', 'eth_getBalance', 'eth_gasPrice', 'eth_blockNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_maxPriorityFeePerGas']);
// The wallet is a read node of last resort, never a flood: its extension answers these reads and shows its sign prompts from one queue, so a page that spilled dozens of reads into it
// (public nodes slow or limited puts the wallet first in the hedge order, and a pool scan asks for hundreds) saw its sign-in popup take 20 to 30 seconds. At most WALLET_LIVE reads are
// with the wallet at once, counted across every node the page makes (one wallet, one queue): a read over that is left to the public nodes, and a read the wallet never answers frees its place
// after WALLET_HOLD_MS.
const WALLET_LIVE = 2, WALLET_HOLD_MS = 30e3;
let walletLive = 0;
export function walletNode(get) {
  return {
    id: 'wallet',
    usable: (m, p) => {
      const w = get();
      return walletLive < WALLET_LIVE && !prompts.promptOpen?.() && WALLET_READS.has(m) && typeof w?.request === 'function' && !w.isWalletConnect && !(m === 'eth_call' && (p[0]?.gas || p[2]));
    },
    send: (m, p) => {
      walletLive++;
      let freed = false;
      const free = () => { if (!freed) { freed = true; walletLive--; } };
      const hold = setTimeout(free, WALLET_HOLD_MS);
      try { return Promise.resolve(get().request({ method: m, params: p })).finally(() => { clearTimeout(hold); free(); }); } catch (e) { clearTimeout(hold); free(); throw e; }
    },
  };
}

let injected = null;
export function onMainnet(get) {
  const seen = new WeakMap();
  return () => {
    const w = get();
    if (!w || typeof w.request !== 'function') return null;
    let s = seen.get(w);
    if (!s) {
      s = { ok: false };
      seen.set(w, s);
      let n = 0;
      const look = () => { const my = ++n; s.ok = false; return Promise.resolve(w.request({ method: 'eth_chainId' })).then((c) => { if (my === n) s.ok = Number(c) === 1; }).catch(() => { if (my === n) s.ok = false; }); };
      look();
      try { w.on?.('chainChanged', look); } catch { }
    }
    return s.ok ? w : null;
  };
}

export function connectedInjected() {
  const w = typeof window !== 'undefined' ? window.ethereum : null;
  if (!w?.request) return null;
  if (!injected) {
    injected = { ok: false };
    let n = 0;
    const look = () => { const my = ++n; injected.ok = false; return Promise.all([w.request({ method: 'eth_accounts' }), w.request({ method: 'eth_chainId' })])
      .then(([a, c]) => { if (my === n) injected.ok = Array.isArray(a) && a.length > 0 && Number(c) === 1; })
      .catch(() => { if (my === n) injected.ok = false; }); };
    look();
    try { w.on?.('accountsChanged', look); w.on?.('chainChanged', look); } catch { }
  }
  return injected.ok ? w : null;
}
