// A page's side of the private route (docs/EVM-POOL.md "Private route"): whether it is available and on, and the fetch that carries a
// keeper's requests through it. The route hides a person's address from the relay (the keeper service and whatever hosts it); it does
// not hide it from the chain nodes a page reads through, or from any other service a page asks.
//
// Every request to a keeper goes through a forwarder, whoever makes it, and none is sent directly: a forwarder that does not answer is tried
// against the next one, and when none answers the request fails rather than show the address it hides.

export const ROUTE = {
  keeper: 'https://tacit-evm-pool-keepers.onrender.com',   // the service whose pools (/<id>/evm-pool/keeper) the route carries
  id: 'k',                                                  // what the forwarders call that service
  gateway: '03dcc0e9c8f2f3f283831159600a0f1db2f615003a4d939999ff0e911894265a70',   // its gateway key, 33 bytes of hex (node worker-relay/src/sealed-keygen.js), key id 5c246719
  forwarders: ['https://tacit-evm-pool-forwarder.onrender.com', 'https://tacit-evm-pool-forwarder-2.onrender.com'],   // each forwarder's address
  nostr: ['wss://relay.primal.net', 'wss://nos.lol', 'wss://offchain.pub'],   // public Nostr relays that carry a request when no forwarder answers (docs/PRIVATE-ROUTE-NOSTR.md); empty: not used
};

// Always on while the page names a gateway key and a forwarder: there is no setting to turn it off and no direct fallback. A request to the
// relay that no forwarder can carry fails, and is never sent in the open, which would show the address the route exists to hide.
export const available = () => !!(ROUTE.gateway && ROUTE.forwarders.length);
export const enabled = available;

let made = null;
const sealedModule = () => import('/sealed-request.js?cb=3f065b4d');
// The sealed fetch, with Nostr behind the forwarders when the page names relays and this browser has a WebSocket. The Nostr carrier loads only here, so a
// page that never needs it never fetches it.
const sealed = () => (made ||= Promise.all([
  sealedModule(),
  ROUTE.nostr?.length && typeof WebSocket === 'function' ? import('/route-nostr.js?cb=9e86a4e2').catch(() => null) : null,
]).then(([m, rn]) => m.makeSealedFetch({ keeper: ROUTE.keeper, chainId: ROUTE.id, gateway: ROUTE.gateway, forwarders: ROUTE.forwarders, nostr: rn ? rn.makeNostrCarrier({ relays: ROUTE.nostr }) : null }))
  .catch((e) => { made = null; throw e; }));

// fetch for a keeper's URLs. Off, it is fetch. On, a request to the route's service goes through a forwarder, and a request to any other
// keeper is refused, not sent.
export function keeperFetch(url, init) {
  if (!enabled()) return fetch(url, init);
  const u = String(url);
  if (u.startsWith(`${ROUTE.keeper}/`)) return sealed().then((f) => f(u, init));
  if (/\/evm-pool\/keeper(?:\/|$)/.test(u)) {
    // a relay the page has read from the relay registry goes the same way, sealed to its own key (dapp/route-community.js); any other is refused
    if (RELAYS.some((r) => u.startsWith(`${r.url}/`))) return community().then((c) => c.fetch(u, init));
    return Promise.reject(new Error('The private route does not reach this relay.'));
  }
  return fetch(url, init);
}

// The relays the relay registry lists that this page may reach through the route: { chainId, url, relayer }. A page names them as it reads the registry; the
// private route's key for each is fetched, and checked against the relayer's address, when it is asked for (and once ahead, now).
const RELAYS = [];
let community_ = null;
const community = () => (community_ ||= Promise.all([import('/route-community.js?cb=9d14649c'), sealedModule()])
  .then(([c, m]) => c.makeCommunityRoute({ relays: RELAYS, makeSealedFetch: m.makeSealedFetch, forwarders: ROUTE.forwarders }))
  .catch((e) => { community_ = null; throw e; }));
export function listRelays(chainId, list) {
  if (!enabled()) return;
  for (const k of list || []) {
    const url = String(k?.url ?? '').replace(/\/+$/, '');
    if (!/^https:\/\/[\w.-]+(?:\/[\w./-]*)?\/evm-pool\/keeper$/.test(url) || !/^0x[0-9a-fA-F]{40}$/.test(String(k?.relayer))) continue;
    if (!RELAYS.some((r) => r.url === url && r.chainId === Number(chainId))) RELAYS.push({ chainId: Number(chainId), url, relayer: k.relayer });
  }
  if (RELAYS.length) community().then((c) => c.warm()).catch(() => {});
}
// A wallet reads this to send without a reservation, which the route does not carry.
Object.defineProperty(keeperFetch, 'sealed', { get: enabled });

// A fetch for a JSON-RPC reader's nodes (dapp/json-rpc.js): each read goes to the keeper's /rpc through the route, so the node that answers sees the keeper's
// request and the keeper sees a forwarder, not the wallet; and only a read the route cannot carry goes to the node the reader named. That is the one place a request
// may go direct: a chain read is public data, and a page that stopped reading the chain whenever the route did would be of no use. A route that fails is left alone for
// a minute, so the page does not wait on it for every read. A refusal of a particular call (403: not a carried method, too wide a range) falls back for that call only.
const RPC_PAUSE_MS = 60_000, RPC_WAIT_MS = 6000;
let rpcSkipUntil = 0;
const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h); } catch { return true; } };
export function rpcFetch(keeperBase, { fetchImpl = (u, i) => fetch(u, i), now = () => Date.now() } = {}) {
  return async (url, init = {}) => {
    const direct = () => fetchImpl(url, init);
    if (!keeperBase || !enabled() || String(init.method || 'GET').toUpperCase() !== 'POST' || isLocal(url) || now() < rpcSkipUntil) return direct();
    try {
      let timer;
      const r = await Promise.race([
        keeperFetch(`${String(keeperBase).replace(/\/+$/, '')}/rpc`, { method: 'POST', body: init.body, signal: init.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the route did not answer a chain read')), RPC_WAIT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (r.status === 200) return r;
      if (r.status >= 500 || r.status === 429) rpcSkipUntil = now() + RPC_PAUSE_MS;
    } catch (e) {
      if (init.signal?.aborted) throw e;
      rpcSkipUntil = now() + RPC_PAUSE_MS;
    }
    return direct();
  };
}

