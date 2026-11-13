
export const ETH_NODES = [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.mevblocker.io',
  'https://mainnet.rpc.buidlguidl.com',
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://eth-mainnet.public.blastapi.io',
  'https://ethereum-json-rpc.stakely.io',
  'https://1rpc.io/eth',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
];
export const ETH_LOG_NODES = [
  'https://rpc.mevblocker.io',
  'https://rpc.mevblocker.io/fast',
  'https://ethereum-rpc.publicnode.com',
  'https://mainnet.rpc.buidlguidl.com',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
  'https://ethereum-json-rpc.stakely.io',
  'https://1rpc.io/eth',
];
export const ETH_ARCHIVE_NODES = [
  'https://rpc.mevblocker.io',
  'https://mainnet.rpc.buidlguidl.com',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://1.rpc.thirdweb.com',
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
  'ethereum-rpc.publicnode.com': { logs: 9999, back: 9999, state: true },
  'rpc.mevblocker.io': { logs: 45000 },
  'mainnet.rpc.buidlguidl.com': { logs: 10000 },
  'eth-mainnet.nodereal.io': { logs: 49999, shared: true },
  'rpc.flashbots.net': { logs: 0 },
  'robinhood-rpc.publicnode.com': { logs: 0, state: true },
  'eth.drpc.org': { logs: 0 },
  '1.rpc.thirdweb.com': { logs: 2000 },
  'ethereum-json-rpc.stakely.io': { logs: 25 },
  '1rpc.io/eth': { logs: 50 },
  'base.drpc.org': { logs: 0 },
  'base-mainnet.public.blastapi.io': { logs: 0 },
  'robinhood.drpc.org': { logs: 0, state: true },
};
const limitsOf = (url) => {
  const id = String(url).replace(/^https?:\/\//, '');
  for (const k of Object.keys(LIMITS)) if (id === k || id.startsWith(k + '/')) return LIMITS[k];
  return null;
};
export const logSpan = (url) => limitsOf(url)?.logs || Infinity;
export const isShared = (url) => !!limitsOf(url)?.shared;
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
export function walletNode(get) {
  return {
    id: 'wallet',
    usable: (m, p) => {
      const w = get();
      return WALLET_READS.has(m) && typeof w?.request === 'function' && !w.isWalletConnect && !(m === 'eth_call' && (p[0]?.gas || p[2]));
    },
    send: (m, p) => get().request({ method: m, params: p }),
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
