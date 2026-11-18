// A page's side of the private route (docs/EVM-POOL.md "Private route"): whether it is available and on, and the fetch that carries a
// keeper's requests through it. The route hides a person's address from the relay (the keeper service and whatever hosts it); it does
// not hide it from the chain nodes a page reads through, or from any other service a page asks.
//
// Available when the page below names a gateway key and a forwarder; on unless the person has turned it off. While it is on, a request to a
// keeper goes through a forwarder. A person who turned it on gets no direct fallback (a request fails when no forwarder answers, rather than
// show the address it hides); a route nobody chose is probed once a visit and, if no forwarder answers, that visit connects directly and says so.

export const ROUTE = {
  keeper: 'https://tacit-evm-pool-keepers.onrender.com',   // the service whose pools (/<id>/evm-pool/keeper) the route carries
  id: 'k',                                                  // what the forwarders call that service
  gateway: '03dcc0e9c8f2f3f283831159600a0f1db2f615003a4d939999ff0e911894265a70',   // its gateway key, 33 bytes of hex (node worker-relay/src/sealed-keygen.js), key id 5c246719
  forwarders: ['https://tacit-evm-pool-forwarder.onrender.com'],   // each forwarder's address
};

const FLAG = 'tacit-private-route-v1';
// A person's choice is on ('1') or off ('0'); with none made the route is on, softly: it is probed once a visit, and if no forwarder answers
// that visit connects directly and the page says so (`unavailable()`), so the relay keeps working for everyone. A person who turned it on
// themselves has asked for it not to fall back, and gets the strict behaviour below: a request fails rather than show the address.
let chosen = null;   // the choice for this visit, for a browser that will not keep one
let down = false;    // no forwarder answered the probe of a route nobody chose
let probing = null;
const stored = () => { try { const v = localStorage.getItem(FLAG); return v === '1' ? true : v === '0' ? false : null; } catch { return null; } };
const choice = () => chosen ?? stored();

export const available = () => !!(ROUTE.gateway && ROUTE.forwarders.length);
export const enabled = () => available() && !down && (choice() ?? true);
export const unavailable = () => down;
export function turn(on) {
  chosen = !!on; down = false;
  try { localStorage.setItem(FLAG, on ? '1' : '0'); } catch { /* kept for this visit only */ }
}
// Back to no choice at all: the default.
export function reset() { chosen = null; down = false; probing = null; try { localStorage.removeItem(FLAG); } catch { /* nothing kept */ } }

// Does any forwarder answer? Asked once a visit, and only of a route nobody chose.
const probe = () => (probing ||= (async () => {
  try {
    await Promise.any(ROUTE.forwarders.map(async (f) => {
      const r = await fetch(`${f}/health`, { signal: AbortSignal.timeout?.(4000) });
      if (!r.ok) throw new Error('not ok');
    }));
  } catch { down = true; }
})());

let made = null;
const sealed = () => (made ||= import('/sealed-request.js?cb=f9a2dc78').then((m) => m.makeSealedFetch({ keeper: ROUTE.keeper, chainId: ROUTE.id, gateway: ROUTE.gateway, forwarders: ROUTE.forwarders }))
  .catch((e) => { made = null; throw e; }));

// fetch for a keeper's URLs. Off, it is fetch. On, a request to the route's service goes through a forwarder, and a request to any other
// keeper is refused, not sent.
export async function keeperFetch(url, init) {
  if (available() && choice() === null && !down) await probe();
  if (!enabled()) return fetch(url, init);
  const u = String(url);
  if (u.startsWith(`${ROUTE.keeper}/`)) return sealed().then((f) => f(u, init));
  if (/\/evm-pool\/keeper(?:\/|$)/.test(u)) throw new Error('The private route does not reach this relay.');
  return fetch(url, init);
}
// A wallet reads this to send without a reservation, which the route does not carry.
Object.defineProperty(keeperFetch, 'sealed', { get: enabled });
