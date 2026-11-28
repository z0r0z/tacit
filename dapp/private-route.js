// A page's side of the private route (docs/EVM-POOL.md "Private route"): whether it is available and on, and the fetch that carries a
// keeper's requests through it. The route hides a person's address from the relay (the keeper service and whatever hosts it); it does
// not hide it from the chain nodes a page reads through, or from any other service a page asks.
//
// Every request to a keeper goes through a forwarder, whoever makes it, and none is sent directly: a forwarder that does not answer is tried
// against the next one, and when none answers the request fails rather than show the address it hides.

import { isOnion, onionHttp, onTor } from './evm-pool-relays.js';

export const ROUTE = {
  keeper: 'https://tacit-evm-pool-keepers.onrender.com',   // the service whose pools (/<id>/evm-pool/keeper) the route carries
  id: 'k',                                                  // what the forwarders call that service
  gateway: '03dcc0e9c8f2f3f283831159600a0f1db2f615003a4d939999ff0e911894265a70',   // its gateway key, 33 bytes of hex (node worker-relay/src/sealed-keygen.js), key id 5c246719
  forwarders: ['https://tacit-evm-pool-forwarder.onrender.com', 'https://tacit-evm-pool-forwarder-2.onrender.com'],   // each forwarder's address
  nostr: ['wss://relay.primal.net', 'wss://nos.lol', 'wss://offchain.pub'],   // public Nostr relays that carry a request when no forwarder answers (docs/PRIVATE-ROUTE-NOSTR.md); empty: not used
  // the gateway for a wallet's own chain reads (worker-relay/src/evm-pool-rpc-gateway.js): a different service and key from the relay's, so the relay never sees them
  rpc: { url: 'https://tacit-evm-pool-rpc.onrender.com', id: 'r', gateway: '033b728ecb1b4ff06af1eaf111c0efe54e2cccedcb8febc458842f1f45cd79073a' },
  // the gateway for the relay's API (server/sealed-api.mjs): what a page asks of the relay (its quote, status, a job's submission) goes through a forwarder, so the API sees the forwarder's address
  api: { url: 'https://api.tacit.finance', id: 'a', gateway: '02e3ba0385d0b26d62b00ca895c8ab97ca1daa9cf7bd94b3770d244f72301b398c' },
};

// Always on while the page names a gateway key and a forwarder: there is no setting to turn it off and no direct fallback. A request to the
// relay that no forwarder can carry fails, and is never sent in the open, which would show the address the route exists to hide.
export const available = () => !!(ROUTE.gateway && ROUTE.forwarders.length);
export const enabled = available;

let made = null;
const sealedModule = () => import('/sealed-request.js?cb=381c7733');
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
  // A relay at an onion address is reached over Tor itself, as plain http (Tor encrypts it): no forwarder can carry it, and none is needed, for the relay sees
  // only Tor. A page that is not on Tor does not ask.
  if (isOnion(url)) return onTor() ? fetch(onionHttp(url), init) : Promise.reject(new Error('This relay is on Tor, and this page is not.'));
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

// Endpoints from the page's own curated registry (dapp/pay-registry.js): its forwarders and Nostr relays go first and the page's own stay behind them,
// so a dead one is passed over and none of the page's own is lost. Only a host this page's policy lets it reach is taken (the policy stays closed: a new
// host needs a page that names it). A change before the route is first used costs nothing; after, the route is built again on its next request.
const OWN_FORWARDERS = [...ROUTE.forwarders], OWN_NOSTR = [...ROUTE.nostr];
const policyHosts = () => {
  try {
    const m = globalThis.document?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
    const c = /(?:^|;)\s*connect-src([^;]*)/.exec(m);
    return c ? c[1].trim().split(/\s+/) : null;
  } catch { return null; }
};
const allowedHere = (u) => { const hs = policyHosts(); if (!hs) return true; try { const o = new URL(u).origin; return hs.includes(o) || hs.includes(`${new URL(u).protocol}//${new URL(u).host}`); } catch { return false; } };
export function setRouteEndpoints({ forwarders = [], nostr = [] } = {}) {
  const f = [...new Set([...(forwarders || []).filter((u) => /^https:\/\/[\w.-]+(?::\d{1,5})?$/.test(u) && allowedHere(u)), ...OWN_FORWARDERS])].slice(0, 8);
  const n = [...new Set([...(nostr || []).filter((u) => /^wss:\/\/[\w.-]+(?::\d{1,5})?$/.test(u) && allowedHere(u)), ...OWN_NOSTR])].slice(0, 8);
  const same = f.join() === ROUTE.forwarders.join() && n.join() === ROUTE.nostr.join();
  if (same) return false;
  ROUTE.forwarders = f; ROUTE.nostr = n; made = null; community_ = null;
  return true;
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
    if (isOnion(url) || !/^https:\/\/[\w.-]+(?:\/[\w./-]*)?\/evm-pool\/keeper$/.test(url) || !/^0x[0-9a-fA-F]{40}$/.test(String(k?.relayer))) continue;
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
const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h); } catch { return true; } };
export function rpcFetch(keeperBase, { fetchImpl = (u, i) => fetch(u, i), now = () => Date.now(), send = (u, i) => keeperFetch(u, i), ready = () => true } = {}) {
  let rpcSkipUntil = 0;   // a route that fails is left alone for a minute, for this reader only
  return async (url, init = {}) => {
    const direct = () => fetchImpl(url, init);
    if (!keeperBase || !enabled() || !ready() || String(init.method || 'GET').toUpperCase() !== 'POST' || isLocal(url) || now() < rpcSkipUntil) return direct();
    try {
      let timer;
      const r = await Promise.race([
        send(`${String(keeperBase).replace(/\/+$/, '')}/rpc`, { method: 'POST', body: init.body, signal: init.signal }),
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

// A wallet's own reads (the connected account's balance, the simulation of its deposit, a transaction's receipt, a name it looks up) go to a gateway of their
// own, sealed to its own key and carried by the same forwarders, and not to the relay: the relay sees a wallet's private side, this sees its public side, and no
// one service sees both. Anything it cannot carry goes to the node the reader named, as rpcFetch does.
let walletMade = null;
const walletSealed = () => (walletMade ||= sealedModule().then((m) => m.makeSealedFetch({ keeper: ROUTE.rpc.url, chainId: ROUTE.rpc.id, gateway: ROUTE.rpc.gateway, forwarders: ROUTE.forwarders }))
  .catch((e) => { walletMade = null; throw e; }));
export function walletRpcFetch(chainId, opts = {}) {
  const base = ROUTE.rpc?.url ? `${ROUTE.rpc.url}/${chainId}/evm-pool/keeper` : null;
  return rpcFetch(base, { ...opts, ready: () => !!ROUTE.rpc?.gateway, send: (u, i) => walletSealed().then((f) => f(u, i)) });
}

// A fixed pool's withdrawal goes to a public ERC-4337 bundler (fixed-pool-paymaster.js), which would see the person's address and the recipient. Through the route the wallet-read gateway sends
// it, and the bundler sees the gateway. When the road fails, the person is asked (once a visit, by `ask`; the browser's confirm by default) whether to send it straight to the bundler, so the
// withdrawal stays possible; a "no" sends nothing and fails with "try again", and is not asked again while the road rests. A user operation sent twice is one (the EntryPoint runs it once),
// which the flow already relies on when a reply is lost.
const BUNDLER_URL = [[/^https:\/\/public\.pimlico\.io\/v2\/(\d{1,10})\/rpc$/, 'pimlico'], [/^https:\/\/api\.candide\.dev\/public\/v3\/(\d{1,10})$/, 'candide']];
export const BUNDLER_DIRECT_ASK = 'The private route to the bundler is not answering. Send the withdrawal to the bundler directly? The bundler will see your IP address.';
export const BUNDLER_DIRECT_NO = 'The private route to the bundler is not answering, so nothing was sent. Try again in a minute.';
const browserAsk = (text) => (typeof globalThis.confirm === 'function' ? !!globalThis.confirm(text) : true);
export function bundlerFetch({ fetchImpl = (u, i) => fetch(u, i), now = () => Date.now(), ask = browserAsk } = {}) {
  let skipUntil = 0, agreed = false, declinedUntil = 0;
  return async (url, init = {}) => {
    const hit = BUNDLER_URL.map(([re, name]) => [re.exec(String(url)), name]).find(([m]) => m);
    if (!hit || !ROUTE.rpc?.gateway || !enabled() || String(init.method || 'GET').toUpperCase() !== 'POST') return fetchImpl(url, init);
    if (now() >= skipUntil) {
      try {
        const f = await walletSealed();
        const r = await f(`${ROUTE.rpc.url}/${hit[0][1]}/evm-pool/keeper/bundler-${hit[1]}`, init);
        // a gateway that was refused or throttled by the bundler (every caller leaves from its one address) or that could not carry the call
        if (r.status === 404 || r.status === 403 || r.status === 429 || r.status >= 500) throw new Error('the route did not carry the bundler call');
        return r;
      } catch (e) {
        if (init.signal?.aborted) throw e;
        skipUntil = now() + RPC_PAUSE_MS;
      }
    }
    if (!agreed && (now() < declinedUntil || !(agreed = !!(await ask(BUNDLER_DIRECT_ASK))))) { declinedUntil = skipUntil; throw new Error(BUNDLER_DIRECT_NO); }
    return fetchImpl(url, init);
  };
}

// A fixed pool's deposit history through the route (dapp/fixed-pool-sync.js): the wallet-read gateway keeps it from the chain's logs and serves it in pages, so no outside host sees which
// pool a person reads or when. A page not ready yet (503) gives null, which sends the read to the next source; a road that fails does the same and is left alone for a minute.
export function poolHistory(chainId, { now = () => Date.now() } = {}) {
  let skipUntil = 0;
  return async ({ pool, from, n }) => {
    if (!ROUTE.rpc?.gateway || !enabled() || now() < skipUntil) return null;
    try {
      const f = await walletSealed();
      const r = await f(`${ROUTE.rpc.url}/${chainId}/evm-pool/keeper/history?pool=${pool}&from=${from}&n=${n}`);
      if (r.status === 503) return null;
      if (!r.ok) { skipUntil = now() + RPC_PAUSE_MS; return null; }
      return await r.json();
    } catch { skipUntil = now() + RPC_PAUSE_MS; return null; }
  };
}

// What a page asks of the relay's API, through the route: the same paths server/sealed-api.mjs carries. A request for one of them goes to a forwarder, sealed to the API's gateway key, and
// the API answers it as it would a direct one (an answer of its own, an error included, is the answer). Only a road that fails (no forwarder answers) sends it straight to the API, as
// before: the relay is what a person's money moves through, and a page that stopped using it whenever a forwarder did would be of no use. A road that fails is left alone for a minute.
// A job submitted twice is one job (its id is a hash of what it holds), so a request the road dropped after the API had it is safe to send again.
const API_PATHS = [['GET', /^\/confidential\/(status|quote|relay|open|index|armed)$/], ['POST', /^\/confidential\/(submit|landed|arm)$/], ['POST', /^\/prover\/pool\/hold$/]];
let apiMade = null;
const apiSealed = () => (apiMade ||= Promise.all([
  sealedModule(),
  ROUTE.nostr?.length && typeof WebSocket === 'function' ? import('/route-nostr.js?cb=9e86a4e2').catch(() => null) : null,
]).then(([m, rn]) => m.makeSealedFetch({ keeper: ROUTE.api.url, chainId: ROUTE.api.id, gateway: ROUTE.api.gateway, forwarders: ROUTE.forwarders, nostr: rn ? rn.makeNostrCarrier({ relays: ROUTE.nostr }) : null }))
  .catch((e) => { apiMade = null; throw e; }));
export function apiFetch({ fetchImpl = (u, i) => fetch(u, i), now = () => Date.now() } = {}) {
  let skipUntil = 0;
  return async (url, init = {}) => {
    const direct = () => fetchImpl(url, init);
    const u = String(url), base = ROUTE.api?.url;
    if (!base || !ROUTE.api.gateway || !enabled() || !u.startsWith(`${base}/`) || now() < skipUntil) return direct();
    const method = String(init.method || 'GET').toUpperCase(), path = u.slice(base.length).split('?')[0];
    if (!API_PATHS.some(([m, re]) => m === method && re.test(path))) return direct();
    try {
      let timer;
      const go = apiSealed().then((f) => f(u, init));
      // a read is not waited on for long; a submission is, by the caller's own deadline
      const r = method === 'GET'
        ? await Promise.race([go, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the route did not answer a read of the relay')), RPC_WAIT_MS * 2); })]).finally(() => clearTimeout(timer))
        : await go;
      return r;
    } catch (e) {
      if (init.signal?.aborted) throw e;
      skipUntil = now() + RPC_PAUSE_MS;
    }
    return direct();
  };
}
