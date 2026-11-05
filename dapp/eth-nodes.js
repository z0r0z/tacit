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
// onfinality and merkle (gone or rate-limited at once), blxrbdn (no eth_getLogs).

export const ETH_NODES = [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.mevblocker.io',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://rpc.flashbots.net',
  'https://eth-mainnet.public.blastapi.io',
  'https://ethereum-json-rpc.stakely.io',
  'https://1rpc.io/eth',
];
export const ETH_LOG_NODES = [
  'https://rpc.mevblocker.io',                                            // 50,000 blocks
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',  // under 50,000
  'https://ethereum-rpc.publicnode.com',                                  // 10,000, recent blocks only
  'https://eth.drpc.org',                                                 // under 10,000
  'https://1.rpc.thirdweb.com',                                           // by response size
  'https://ethereum-json-rpc.stakely.io',                                 // about 1,000
  'https://1rpc.io/eth',                                                  // 50
];
export const ETH_ARCHIVE_NODES = [
  'https://rpc.mevblocker.io',
  'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
  'https://eth.drpc.org',
  'https://1.rpc.thirdweb.com',
  'https://rpc.flashbots.net',
  'https://eth-mainnet.public.blastapi.io',
];

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
