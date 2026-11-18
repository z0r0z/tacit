// The relays the relay registry lists, read through an Ethereum node and kept for a minute, so a forwarder asks the chain once a minute however many wallets
// ask it for a relay. A read that fails keeps what was known for up to ten minutes: a node's bad moment does not take every community relay off the route.

import { readRegistry, RELAY_REGISTRY } from '../../../dapp/evm-pool-open-relays.js';

export function makeRegistryReader({ rpcUrl, registry = RELAY_REGISTRY, ttlMs = 60_000, staleMs = 600_000, fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new Map();      // chain id → { at, entries }
  const call = async (to, data) => {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    if (j.error || typeof j.result !== 'string') throw new Error('the node did not answer the call');
    return j.result;
  };
  async function entries(chainId) {
    const c = cache.get(chainId);
    if (c && now() - c.at < ttlMs) return c.entries;
    const fresh = await readRegistry({ call, chainId, registry });
    if (!fresh.length && c && now() - c.at < staleMs) return c.entries;
    cache.set(chainId, { at: now(), entries: fresh });
    return fresh;
  }
  return {
    entries,
    async find(chainId, relayer) {
      const hit = (await entries(chainId)).find((e) => e.relayer.toLowerCase() === String(relayer).toLowerCase());
      return hit ? { url: hit.url, relayer: hit.relayer } : null;
    },
  };
}
