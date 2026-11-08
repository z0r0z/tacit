// The public Ethereum nodes the pages read through, in one place, ranked by what each served when measured from a browser (2026-11-04): plain reads,
// event logs over wide ranges, and state at past blocks. Every one answers CORS for tacit.finance; each page's connect-src names them all. A node that
// fails is not dropped here: the pages' clients (trade/rpc.js hedgedRpc + nodeHealth) rest it and ask it last, so this order is only where they start.
//
//   ETH_NODES          plain reads, gas, nonces, sends: the fastest first
//   ETH_LOG_NODES      eth_getLogs over thousands of blocks: the widest first (the others answer narrower ranges, learned as they refuse)
//   ETH_ARCHIVE_NODES  reads at a past block (publicnode keeps only recent state without a token)
//   walletNode(get)    the connected wallet's own node as a last resort: only reads, only on Ethereum mainnet, never through WalletConnect (a relay hop)
//
// Measured and left out: Tenderly's gateway (resets the connection), llamarpc (525), cloudflare-eth (refuses), Ankr (needs a key), omniatech, lava,
// onfinality and merkle (gone or rate-limited at once), blxrbdn (no eth_getLogs), flashbots (a sending endpoint: eth_call is refused with a 403, and
// eth_getBalance, eth_getCode and eth_getLogs time out; it still serves the sends that name it).

export const ETH_NODES = [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.mevblocker.io',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://eth-mainnet.public.blastapi.io',
  'https://ethereum-json-rpc.stakely.io',
  'https://1rpc.io/eth',
];
export const ETH_LOG_NODES = [
  'https://rpc.mevblocker.io',                                            // 50,000 blocks
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',  // under 50,000
  'https://ethereum-rpc.publicnode.com',                                  // 10,000, recent blocks only
  'https://ethereum-json-rpc.stakely.io',                                 // about 1,000
  'https://1rpc.io/eth',                                                  // 50
];
// Left out of the list above, though they serve plain reads: drpc answers every eth_getLogs with a 400 (its free plan), and thirdweb limits the rate
// of a log query at once and answers a wide one by response size; as a fallback each only adds a refused request to the console.
export const ETH_ARCHIVE_NODES = [
  'https://rpc.mevblocker.io',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://eth-mainnet.public.blastapi.io',
];

// What a node is known to turn away (measured 2026-11-08 from a browser on tacit.finance), so a read it would refuse is asked of the others first: the browser
// lists every refused request in the console, and each costs a round trip. A node is not dropped, only asked last, so one whose limits change is still reached.
//   logs   the most blocks one eth_getLogs may span (0: none at all)
//   back   how far behind the newest block its logs reach (publicnode keeps recent blocks, and older ones need a token)
//   state  set for a node that serves state only at the newest blocks: a read at a numbered block goes elsewhere
const LIMITS = {
  'ethereum-rpc.publicnode.com': { logs: 9999, back: 9999, state: true },
  'rpc.mevblocker.io': { logs: 45000 },
  'eth-mainnet.nodereal.io': { logs: 49999 },
  'eth.drpc.org': { logs: 0 },
  '1.rpc.thirdweb.com': { logs: 2000 },
  'ethereum-json-rpc.stakely.io': { logs: 25 },
  '1rpc.io/eth': { logs: 50 },
};
const limitsOf = (url) => {
  const id = String(url).replace(/^https?:\/\//, '');
  for (const k of Object.keys(LIMITS)) if (id === k || id.startsWith(k + '/')) return LIMITS[k];
  return null;
};
// The widest eth_getLogs span to start a node at (Infinity where it has no known limit): a range wider is cut to this before it is sent.
export const logSpan = (url) => limitsOf(url)?.logs || Infinity;
const blockNo = (t) => (typeof t === 'string' && /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : null);
const STATE_BLOCK = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1, eth_getStorageAt: 2, eth_getTransactionCount: 1 };
// Whether `url` is known to refuse this read. `head` is the newest block the caller is reading toward, when it knows it (the end of a scan).
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

// The connected wallet's node, for trade/rpc.js hedgedRpc: a read the public nodes all failed. `get()` gives the page's EIP-1193 provider while it is on
// Ethereum mainnet, or null (connectedInjected below is one such getter).
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

// The injected wallet, only once this site is already connected to it (eth_accounts asks nothing of the user) and while it is on Ethereum mainnet: what
// it says is read once and again when its account or chain changes, so the getter itself sends nothing.
let injected = null;
// A wallet the page itself connected (an announced one, which need not be window.ethereum), used only while it is on Ethereum mainnet: a read of
// the pool through a wallet on another chain would answer about that chain. Its chain is read once and again when it changes, so the getter sends nothing.
export function onMainnet(get) {
  const seen = new WeakMap();
  return () => {
    const w = get();
    if (!w || typeof w.request !== 'function') return null;
    let s = seen.get(w);
    if (!s) {
      s = { ok: false };
      seen.set(w, s);
      // off while it is read again, and only the latest read counts: an answer about the chain left behind must not turn it back on
      let n = 0;
      const look = () => { const my = ++n; s.ok = false; return Promise.resolve(w.request({ method: 'eth_chainId' })).then((c) => { if (my === n) s.ok = Number(c) === 1; }).catch(() => { if (my === n) s.ok = false; }); };
      look();
      try { w.on?.('chainChanged', look); } catch { /* a provider without events */ }
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
    try { w.on?.('accountsChanged', look); w.on?.('chainChanged', look); } catch { /* a provider without events */ }
  }
  return injected.ok ? w : null;
}
