// Brings a key's on-device pool wallet up to date off the page's main thread. Replaying the pool's tree hashes every leaf
// since the last saved state (Base's history is tens of thousands of leaves), which would freeze the page for seconds at a time.
// The page sends the wallet's saved state for one chain; this runs the same wallet code's sync on it and sends back what
// each state as it is written, so a long history read partway is kept. The page stores them (still only a cache: every
// balance is found again from the key and the chain), and its own wallet, made from them, then reads only what came after.
// Given `pools` (the payments pools a coin picker shows), it reads them all at once, the calls to one chain's nodes going out
// together in batches, and sends each pool's balance as it is known ({ part }), then { ok } when all are read.
import { makeEvmPoolZk } from '/evm-pool-zk.js?cb=2f062779';
import { makeEvmPoolWallet, evmPoolKeys, jsonRpc, batchedRpc } from '/evm-pool-wallet.js?cb=5ad65835';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '/vendor/tacit-poseidon.min.js';

const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });

const walletOf = (id, keys, c, pool, router, kept, rpc) => makeEvmPoolWallet({ zk, keys, keeper: c.keeper, prove: null,
  store: { get: (k) => kept.get(k) ?? null, set: (k, v) => { kept.set(k, v); self.postMessage({ id, write: [k, v] }); } },
  chain: { chainId: c.chainId, pool, router, rpc, deployBlock: c.deployBlock, confirmations: c.confirmations, logChunk: c.logChunk, token: c.token } });

self.onmessage = async ({ data: { id, priv, chain: c, pool, router, entries, pools } }) => {
  const kept = new Map(Object.entries(entries || {}));
  try {
    const keys = evmPoolKeys(zk, priv);
    if (pools) {
      const rpcs = new Map(), rpcOf = (urls) => { const k = JSON.stringify(urls); if (!rpcs.has(k)) rpcs.set(k, batchedRpc(jsonRpc(urls))); return rpcs.get(k); };
      await Promise.all(pools.map(async (p, part) => {
        try {
          const s = await walletOf(id, keys, p.chain, p.pool, p.router, kept, rpcOf(p.chain.rpc)).sync();
          self.postMessage({ id, part, ok: true, balance: String(s.balance) });
        } catch (e) { self.postMessage({ id, part, ok: false, error: String(e?.message || e) }); }
      }));
      self.postMessage({ id, ok: true });
      return;
    }
    const s = await walletOf(id, keys, c, pool, router, kept, jsonRpc(c.rpc)).sync();
    self.postMessage({ id, ok: true, balance: String(s.balance) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
