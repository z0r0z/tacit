// The private route to a relay anyone has listed in the relay registry.
//
// The route (dapp/private-route.js) seals a request so that what carries it reads none of it and the keeper at the other end sees the carrier's address, not the
// person's. For the relay a page ships with, the page holds the keeper's gateway key. For a relay from the registry the page holds only an address, so:
//   1. a forwarder fetches the relay's gateway key document (GET /r/<chain>/<relayer>/key), which the relay's own key has signed (dapp/relay-gateway-doc.js);
//      the forwarder is the one that asks, so the relay never sees the person's address, and it cannot swap in a key, for the signature would not hold;
//   2. the wallet seals to that key and posts the envelope to a forwarder at /r/<chain>/<relayer>, which hands it to the registry's entry for that relayer
//      and no one else, and returns the sealed answer.
// A relay that has no gateway key, or whose key a forwarder cannot show, is not reached, and a request to it is never sent in the open.

import { verifyDoc } from './relay-gateway-doc.js';

const shuffled = (a) => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };

// relays: the live list of { chainId, url, relayer } this page may reach (private-route.js fills it as the page reads the registry)
export function makeCommunityRoute({ relays, makeSealedFetch, forwarders, fetchImpl = globalThis.fetch?.bind(globalThis), keyMs = 15_000 }) {
  const sealedBy = new Map();      // chain id and relayer → the sealed fetch for that relay, once its key is known
  const entryOf = (url) => relays.find((r) => String(url).startsWith(`${r.url}/`)) || null;
  const originOf = (url) => new URL(url).origin;

  async function gatewayOf(e) {
    for (const fw of shuffled(forwarders)) {
      try {
        const r = await fetchImpl(`${String(fw).replace(/\/+$/, '')}/r/${e.chainId}/${e.relayer}/key`, { signal: AbortSignal.timeout?.(keyMs) });
        if (!r.ok) continue;
        const { docs } = await r.json();
        for (const d of Array.isArray(docs) ? docs : []) { const key = verifyDoc(d, e.relayer); if (key) return key; }
      } catch { /* the next forwarder */ }
    }
    throw new Error('This relay\'s private route key could not be shown and checked, so it is not reached.');
  }
  function sealedFor(e) {
    const id = `${e.chainId}:${e.relayer.toLowerCase()}`;
    if (!sealedBy.has(id)) {
      sealedBy.set(id, gatewayOf(e).then((gateway) => makeSealedFetch({
        keeper: originOf(e.url), chainId: 'r', gateway, forwarders, nostr: null,
        pathOf: (fw) => `${fw}/r/${e.chainId}/${e.relayer}`,
      })).catch((err) => { sealedBy.delete(id); throw err; }));
    }
    return sealedBy.get(id);
  }
  return {
    has: (url) => !!entryOf(url),
    // the keys of every relay listed so far, fetched ahead (quietly: a failure is tried again when a request needs it), so the first spend's quote is not the one
    // that waits for it
    warm: () => Promise.allSettled(relays.map((e) => sealedFor(e))).then(() => undefined),
    fetch(url, init) {
      const e = entryOf(url);
      if (!e) return Promise.reject(new Error('The private route does not reach this relay.'));
      const id = `${e.chainId}:${e.relayer.toLowerCase()}`;
      return sealedFor(e).then((f) => f(url, init)).catch((err) => { sealedBy.delete(id); throw err; });
    },
  };
}
