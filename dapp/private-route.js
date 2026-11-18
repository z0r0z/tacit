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
};

// Always on while the page names a gateway key and a forwarder: there is no setting to turn it off and no direct fallback. A request to the
// relay that no forwarder can carry fails, and is never sent in the open, which would show the address the route exists to hide.
export const available = () => !!(ROUTE.gateway && ROUTE.forwarders.length);
export const enabled = available;

let made = null;
const sealed = () => (made ||= import('/sealed-request.js?cb=f9a2dc78').then((m) => m.makeSealedFetch({ keeper: ROUTE.keeper, chainId: ROUTE.id, gateway: ROUTE.gateway, forwarders: ROUTE.forwarders }))
  .catch((e) => { made = null; throw e; }));

// fetch for a keeper's URLs. Off, it is fetch. On, a request to the route's service goes through a forwarder, and a request to any other
// keeper is refused, not sent.
export function keeperFetch(url, init) {
  if (!enabled()) return fetch(url, init);
  const u = String(url);
  if (u.startsWith(`${ROUTE.keeper}/`)) return sealed().then((f) => f(u, init));
  if (/\/evm-pool\/keeper(?:\/|$)/.test(u)) return Promise.reject(new Error('The private route does not reach this relay.'));
  return fetch(url, init);
}
// A wallet reads this to send without a reservation, which the route does not carry.
Object.defineProperty(keeperFetch, 'sealed', { get: enabled });
