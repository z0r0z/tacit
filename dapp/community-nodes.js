// Community nodes, as a page uses them. A page never connects to a community host itself (a page's connect-src names no unknown host, and the pages that
// move money do not get a looser one): it asks the site's API origin, which every page already names, to forward a public-data read to a listed node
// (node-prober/src/service.mjs `/nodes/relay`). The operator therefore sees the gateway, not the visitor; the gateway sees the question, which names
// no address (nodes-list.js ethPublic).
//
//   communityTail(method, params)     extra last-resort hosts for hedgedRpc (trade/rpc.js): fees only, one per independent group, after every built-in host
//   quorumRead(kind, method, params)  a public-data read that two independent groups of community nodes gave the same answer to, or an error: for callers
//                                     that want more voters, never the only voter for anything that moves money
//   nodesOnly.get() / .set(on)        'Tacit and public nodes only': the browser's switch, off by default; on, nothing here asks a community node
//
// What stays out: no balance, nonce, code, call, proof, address history or output set ever goes to a community node, whatever a caller asks for (the
// allowlist is checked here and again by the relay); a signed list that does not verify under the pinned key is ignored and the built-in lists stand
// alone (with no key pinned nothing here makes a request at all); and a money decision (a terminal swap, an ETH lock's agreement, a claim read) keeps
// its own quorum of built-in nodes, since the methods those need are not in the tail and a quorumRead is never what they wait on.
import { NODES_API, PROBER_PUBS } from './nodes-pin.js';

// the signing and checking code (and the crypto it needs) is loaded only when a key is pinned, so a page in a build with none loads nothing for it
let L = null;
const lib = () => (L ? Promise.resolve(L) : import('./nodes-list.js').then((m) => (L = m)));

const ONLY = 'tacit-nodes-only', CACHE = 'tacit-nodes-list-v1';
// the reads a community node may answer alone: fee figures, which a caller may show or use for an estimate and which hold no one's funds
export const TAIL_METHODS = new Set(['eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory']);
const store = () => { try { return globalThis.localStorage; } catch { return null; } };

export const nodesOnly = {
  get() { try { return store()?.getItem(ONLY) === '1'; } catch { return false; } },
  set(on) { try { if (on) store()?.setItem(ONLY, '1'); else store()?.removeItem(ONLY); } catch { /* the choice lasts for this load only */ } },
};

export function makeCommunity({ fetchImpl = (...a) => fetch(...a), now = () => Math.floor(Date.now() / 1000), pubs = PROBER_PUBS, api = NODES_API, off = () => nodesOnly.get(), cache = store() } = {}) {
  let nodes = [], loading = null, tried = 0;
  const readCache = () => { try { return JSON.parse(cache?.getItem(CACHE) || 'null'); } catch { return null; } };
  const accept = (doc) => { const v = L.verifyList(doc, now(), pubs); if (v.length) nodes = v; return v.length > 0; };
  const ready = pubs.length ? lib().then(() => { accept(readCache()); }) : Promise.resolve();

  async function load() {
    await ready;
    if (!pubs.length || off()) return nodes;
    if (loading) return loading;
    if (nodes.length && (readCache()?.until ?? 0) > now() + 300) return nodes;
    if (now() - tried < 120) return nodes;
    tried = now();
    loading = (async () => {
      try {
        const r = await fetchImpl(`${api}/list`, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
        const doc = r.ok ? await r.json() : null;
        if (accept(doc)) { try { cache?.setItem(CACHE, JSON.stringify(doc)); } catch { /* a list is fetched again next time */ } }
        else if (doc != null) nodes = [];           // a list that does not verify is no list
      } catch { /* the built-in lists stand */ }
      return nodes;
    })().finally(() => { loading = null; });
    return loading;
  }

  const live = (kind) => (off() || !L ? [] : L.independent(nodes.filter((n) => n.kind === kind)));
  const relayEth = (node, method, params, signal) => fetchImpl(`${api}/relay`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ node: node.id, method, params }), credentials: 'omit', signal })
    .then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error('community node did not answer'); const x = JSON.parse(j.text); if (x.error) throw Object.assign(new Error(x.error.message || 'rpc error'), { rpc: true }); return x.result; });
  const relayBtc = (node, path, signal) => fetchImpl(`${api}/relay`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ node: node.id, path }), credentials: 'omit', signal })
    .then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok || !j || j.status !== 200) throw new Error('community node did not answer'); return j.text; });

  return {
    load, ready, nodes: () => nodes,
    // hedgedRpc's host objects: `usable` is the gate (public fee reads only, and only while the switch is off), `send` is the relay
    tail(method, params) {
      if (!pubs.length) return [];
      load();                                  // not waited for: a read never waits on the list
      if (!L) return [];
      if (!TAIL_METHODS.has(method) || !L.ethPublic(method, params)) return [];
      return live('eth').slice(0, 3).map((n) => ({ id: `community/${n.id}`, usable: (m, p) => TAIL_METHODS.has(m) && L.ethPublic(m, p) && !off(), send: (m, p, signal) => relayEth(n, m, p, signal) }));
    },
    // the answer at least `min` independent groups gave alike. A read that is not public data is refused before anything is sent.
    async quorumRead(kind, method, params, { min = 2, ask = 4, timeoutMs = 10_000 } = {}) {
      await ready; await lib();
      const ok = kind === 'eth' ? L.ethPublic(method, params) : L.btcPublic(method);
      if (!ok) throw new Error('not a public-data read');
      await load();
      const pick = live(kind).slice(0, ask);
      if (pick.length < min) throw new Error('not enough independent community nodes');
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const got = await Promise.all(pick.map((n) => (kind === 'eth' ? relayEth(n, method, params, ctrl.signal) : relayBtc(n, method, ctrl.signal)).then((v) => ({ n, k: JSON.stringify(v), v }), () => null)));
        const by = new Map();
        for (const g of got.filter(Boolean)) { const e = by.get(g.k) || { v: g.v, groups: new Set() }; e.groups.add(g.n.group); by.set(g.k, e); }
        const best = [...by.values()].sort((a, b) => b.groups.size - a.groups.size);
        if (!best.length || best[0].groups.size < min || (best[1] && best[1].groups.size === best[0].groups.size)) throw new Error('community nodes did not agree');
        return best[0].v;
      } finally { clearTimeout(timer); }
    },
  };
}

// the page-wide instance: made on first use, in a browser only
let shared = null;
export const community = () => (shared ||= (typeof location === 'undefined' ? makeCommunity({ pubs: [], cache: null }) : makeCommunity()));
export const communityTail = (method, params) => community().tail(method, params);
