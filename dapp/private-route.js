// A page's side of the private route (docs/EVM-POOL.md "Private route"): whether it is available and on, and the fetch that carries a
// keeper's requests through it. The route hides a person's address from the relay (the keeper service and whatever hosts it); it does
// not hide it from the chain nodes a page reads through, or from any other service a page asks.
//
// Available when the page below names a gateway key and a forwarder, on when the person has turned it on. While it is on, a request to a
// keeper is never sent directly, which would show the address it hides: it goes through a forwarder, and fails when none answers.

export const ROUTE = {
  keeper: 'https://tacit-evm-pool-keepers.onrender.com',   // the service whose pools (/<id>/evm-pool/keeper) the route carries
  id: 'k',                                                  // what the forwarders call that service
  gateway: '',                                              // its gateway key, 33 bytes of hex (node worker-relay/src/sealed-keygen.js)
  forwarders: [],                                           // each forwarder's address
};

const FLAG = 'tacit-private-route-v1';
let chosen = null;   // the choice for this visit, for a browser that will not keep one
const stored = () => { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } };

export const available = () => !!(ROUTE.gateway && ROUTE.forwarders.length);
export const enabled = () => available() && (chosen ?? stored());
export function turn(on) {
  chosen = !!on;
  try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* kept for this visit only */ }
}

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
