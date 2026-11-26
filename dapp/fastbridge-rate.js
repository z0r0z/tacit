// What one BTC is worth in ETH, read from independent sources and kept only while they agree and are fresh. A provider prices a swap of Bitcoin for ETH from it (the
// rate is the provider's own, with its fee on top) and a page checks the provider's quote against it, so neither takes a price on one source's word. No imports: a
// page, a test and the daemon's image take it alike.
//
//   const feed = makeRateFeed({ sources: [chainlinkEthBtc({ call }), coinbaseEthBtc({ fetchImpl })], now })
//   await feed.refresh()      asks every source once (a source that fails or is stale is left out)
//   feed.current()            { ethPerBtc, at, n } or null: null when the sources disagree, too few answered, or the last good read is older than maxAgeSecs
//   feed.rate()               { num, den } or null: pool ETH units (1e-8 ETH) per satoshi, so that units = sats * num / den. ETH per BTC and units per sat are the same number
//
// A source is `async () => ethPerBtc` (a number above zero) and throws when it has nothing it trusts.

export const RATE_DEN = 100_000_000n;
// 1 BTC = 1e8 sats and 1 ETH = 1e8 pool units, so the ETH-per-BTC price is also pool units per sat
export const ratioOf = (ethPerBtc) => {
  if (!(typeof ethPerBtc === 'number' && Number.isFinite(ethPerBtc) && ethPerBtc > 0)) throw new Error('rate: not a price');
  return { num: BigInt(Math.round(ethPerBtc * 1e8)), den: RATE_DEN };
};
export const ethPerBtcOf = ({ num, den }) => Number(num) / Number(den);

// ── sources ──

// Chainlink's ETH / BTC aggregator on Ethereum mainnet: BTC per ETH with `decimals` places (8). `call(to, data)` is an eth_call returning the hex result. Its
// heartbeat is a day, so an answer is stale only past `maxAgeSecs` (26 h): it moves when the price has moved by half a percent, which is why a page compares with it
// loosely.
export const CHAINLINK_ETH_BTC = '0xAc559F25B1619171CbC396a50854A3240b6A4e99';
export function chainlinkEthBtc({ call, address = CHAINLINK_ETH_BTC, maxAgeSecs = 26 * 3600, now = () => Math.floor(Date.now() / 1000) }) {
  let decimals = null;
  const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  return async () => {
    if (decimals == null) { const d = await call(address, '0x313ce567'); decimals = Number(word(d, 0)); if (!(decimals >= 0 && decimals <= 24)) { decimals = null; throw new Error('chainlink: decimals'); } }
    const r = await call(address, '0xfeaf968c');
    if (typeof r !== 'string' || r.length < 2 + 64 * 5) throw new Error('chainlink: short answer');
    const roundId = word(r, 0), answer = word(r, 1), updatedAt = Number(word(r, 3)), answeredIn = word(r, 4);
    if (answer <= 0n || answer >= 1n << 255n) throw new Error('chainlink: no price');
    if (answeredIn < roundId) throw new Error('chainlink: stale round');
    if (now() - updatedAt > maxAgeSecs) throw new Error('chainlink: stale');
    return Number(10n ** BigInt(decimals)) / Number(answer);
  };
}

// Public nodes of separate operators that a page's CSP reaches, for reading the aggregator more than once (chainlinkNodes)
export const PRICE_NODES = Object.freeze(['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth.drpc.org', 'https://eth-mainnet.public.blastapi.io', 'https://1rpc.io/eth']);

// The same aggregator read from several nodes, each one a source: a page with no exchange on its CSP still takes the price on more than one node's word. Every
// node is asked at one block a little behind the tip (the median of the heights they give, less `behind`), so nodes that agree give the very same answer, and a
// feed made `unanimous` has no price while any node that answers says something else. `nodes`: RPC URLs, each asked with a plain POST.
export function chainlinkNodes({ nodes, fetchImpl = (...a) => fetch(...a), timeoutMs = 8000, behind = 2, pinMs = 15000, address = CHAINLINK_ETH_BTC, maxAgeSecs, now, nowMs = () => Date.now() }) {
  const post = async (url, method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!j || j.error || typeof j.result !== 'string') throw new Error('rpc: no result');
    return j.result;
  };
  let pin = null;
  const block = () => {
    if (pin && nowMs() - pin.at < pinMs) return pin.p;
    const p = (async () => {
      const hs = (await Promise.all(nodes.map((u) => post(u, 'eth_blockNumber', []).then((h) => Number(BigInt(h)), () => null)))).filter((h) => Number.isSafeInteger(h) && h > 0).sort((a, b) => a - b);
      if (hs.length < 2) throw new Error('chainlink: too few nodes gave a height');
      return '0x' + (hs[(hs.length - 1) >> 1] - behind).toString(16);
    })();
    pin = { at: nowMs(), p };
    p.catch(() => { if (pin && pin.p === p) pin = null; });
    return p;
  };
  return nodes.map((u) => chainlinkEthBtc({ address, ...(maxAgeSecs ? { maxAgeSecs } : {}), ...(now ? { now } : {}), call: async (to, data) => post(u, 'eth_call', [{ to, data }, await block()]) }));
}

// The same aggregator read by a quorum of nodes, as ONE source that says how many nodes stood behind its answer (`{ ethPerBtc, n }`, which a feed made `counted`
// takes as n sources). `nodes` is a list or a function giving the current list: URLs, or `{ id, usable?, send(method, params) }` for a reader that is not a URL (the
// connected wallet). A node that gives no answer for any reason (429, a CORS block that hides one, a timeout, a 5xx, bad JSON, a node error) is out of the read and
// rested for `restMs` with a strike, and is not asked again until then, so a node that refuses is not hammered and the console not filled with its failures. That is
// never "says something else": only a node that gives a good price different from the others is a disagreement, and it blocks the read (a node answering with another
// value at the same block, as before). Up to `fan` healthy nodes are asked at once and the read ends as soon as `need` agree (after a short `graceMs` for answers
// already on the way); the rest of the list is asked only if too few answered. The block is pinned once for the node set (the lowest of the first `need` heights,
// less `behind`), and each node then answers decimals and the round in ONE batched POST where `batchOf(url)` says it takes batches. A reading is kept `keepMs`
// and shared by every reader of the page (the live line, the quote, the lane), and a read already under way is the one they all wait on.
// `bodyOf(url)` is the POST body's type (a plain one avoids the CORS preflight).
const rested = new Map();                       // node -> { until, n }, kept for the page so every reader of it shares what a node did
export const restedNodes = rested;
const shared = new Map();                       // address -> { at, p }
const decimalsOf = new Map();                   // address -> decimals once read (fixed for an aggregator)
export function chainlinkQuorum({ nodes, fetchImpl = (...a) => fetch(...a), timeoutMs = 3500, behind = 2, address = CHAINLINK_ETH_BTC, maxAgeSecs, now, nowMs = () => Date.now(), need = 2, fan = 6, restMs = 60000, graceMs = 250, keepMs = 15000, bodyOf = () => 'application/json', batchOf = () => false, log = () => {} }) {
  const key = (n) => (typeof n === 'string' ? n : n.id);
  const rest = (n, why) => { const k = key(n), r = rested.get(k); rested.set(k, { until: nowMs() + restMs, n: ((r && r.n) || 0) + 1 }); log({ level: 'warn', msg: 'a price node gave no answer and is rested', node: k, error: String((why && why.message) || why).slice(0, 80) }); };
  const healthy = (n) => { const r = rested.get(key(n)); return !r || r.until <= nowMs(); };
  const timed = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t)); };
  const word = (r) => { if (typeof r !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r)) throw new Error('rpc: no result'); return r; };
  // calls: [{ method, params }] -> results in order (one POST when `batch`, else one each)
  const send = (n, calls, batch) => timed((async () => {
    if (typeof n !== 'string') { if (n.usable && calls.some((c) => !n.usable(c.method, c.params))) throw new Error('not usable'); return Promise.all(calls.map((c) => n.send(c.method, c.params).then(word))); }
    const one = async (body) => {
      const r = await fetchImpl(n, { method: 'POST', headers: { 'content-type': bodyOf(n) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
      return r.json();
    };
    if (batch) {
      const j = await one(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params })));
      if (!Array.isArray(j)) throw new Error('rpc: no batch');
      return calls.map((_, i) => { const x = j.find((y) => y && y.id === i + 1); if (!x || x.error) throw new Error('rpc: no result'); return word(x.result); });
    }
    return Promise.all(calls.map(async (c) => { const j = await one({ jsonrpc: '2.0', id: 1, method: c.method, params: c.params }); if (!j || j.error) throw new Error('rpc: no result'); return word(j.result); }));
  })(), timeoutMs + 500);
  const read = async () => {
    const list = (typeof nodes === 'function' ? nodes() : nodes).filter(healthy);
    if (list.length < need) throw new Error('chainlink: too few nodes to ask');
    const answers = [], heights = []; let block = null;
    const known = decimalsOf.get(address);
    const run = async (n) => {
      try {
        if (!block) {
          heights.push(Number(BigInt((await send(n, [{ method: 'eth_blockNumber', params: [] }], false))[0])));
          if (!block && heights.length >= need) block = '0x' + (Math.min(...heights) - behind).toString(16);
        }
        // (a node that gave a height first waits for the block the others give)
        for (let i = 0; !block && i < 40; i++) await new Promise((r) => setTimeout(r, 100));
        if (!block) throw new Error('no block');
        const at = (data) => ({ method: 'eth_call', params: [{ to: address, data }, block] });
        const rs = await send(n, known == null ? [at('0x313ce567'), at('0xfeaf968c')] : [at('0xfeaf968c')], batchOf(n));
        const dec = known == null ? rs[0] : null;
        answers.push(await chainlinkEthBtc({ address, ...(maxAgeSecs ? { maxAgeSecs } : {}), ...(now ? { now } : {}), call: async (to, data) => (data === '0x313ce567' ? (dec || '0x' + BigInt(known).toString(16).padStart(64, '0')) : rs[rs.length - 1]) })());
        if (known == null) decimalsOf.set(address, Number(BigInt(dec)));
      } catch (e) { rest(n, e); }
    };
    const agree = () => { const g = new Map(); for (const v of answers) g.set(v, (g.get(v) || 0) + 1); let best = 0, val = null; for (const [v, c] of g) if (c > best) { best = c; val = v; } return { best, val, kinds: g.size }; };
    const asked = []; let next = 0;
    const ask = (k) => { while (k-- > 0 && next < list.length) asked.push(run(list[next++])); };
    ask(fan);
    for (;;) {
      await new Promise((r) => { const t = setInterval(() => { if (agree().best >= need) { clearInterval(t); r(); } }, 25); Promise.all(asked).then(() => { clearInterval(t); r(); }); });
      const a = agree();
      if (a.best >= need) { await new Promise((r) => setTimeout(r, graceMs)); break; }
      if (a.kinds > 1 || next >= list.length) break;
      ask(fan);
    }
    const a = agree();
    if (a.kinds > 1) throw new Error('chainlink: the nodes disagree');
    if (a.best < need) throw new Error('chainlink: too few nodes answered');
    return { ethPerBtc: a.val, n: a.best };
  };
  return () => {
    // (one reading per aggregator and set of nodes: a reader with other nodes is not handed this one's)
    const id = address + '|' + (typeof nodes === 'function' ? nodes() : nodes).map(key).join(',');
    const s = shared.get(id);
    if (s && nowMs() - s.at < keepMs) return s.p;
    const p = read();
    shared.set(id, { at: nowMs(), p });
    p.catch(() => { const c = shared.get(id); if (c && c.p === p) shared.delete(id); });
    return p;
  };
}
export const forgetQuorum = () => { shared.clear(); rested.clear(); decimalsOf.clear(); };

const pos = (x) => { const v = Number(x); if (!(Number.isFinite(v) && v > 0)) throw new Error('not a price'); return v; };
// Coinbase's ETH-BTC ticker (BTC per ETH) and Kraken's ETHXBT (the last trade): public, server-side
export function coinbaseEthBtc({ fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 }) {
  return async () => {
    const r = await fetchImpl('https://api.exchange.coinbase.com/products/ETH-BTC/ticker', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    return 1 / pos((await r.json()).price);
  };
}
export function krakenEthBtc({ fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 }) {
  return async () => {
    const r = await fetchImpl('https://api.kraken.com/0/public/Ticker?pair=ETHXBT', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`kraken ${r.status}`);
    const j = await r.json(), t = j && j.result && Object.values(j.result)[0];
    return 1 / pos(t && t.c && t.c[0]);
  };
}

// ── the feed ──

const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// `minSources` must answer and agree within `maxSpreadBps` (of the median) for a read to count: with more than two, a source off by more is dropped as an
// outlier and the rest stand if there are still enough; with two that disagree there is no price. `maxAgeSecs` is how long a good read stands.
// `unanimous`: every source that answers must agree (none is dropped as an outlier), as for one aggregator read from several nodes at one block.
export function makeRateFeed({ sources, now = () => Math.floor(Date.now() / 1000), minSources = 2, maxSpreadBps = 100, maxAgeSecs = 180, unanimous = false, counted = false, log = () => {} }) {
  // a feed that needs no source to answer would take no answer for a price: it needs at least one, and has one to ask
  if (!Array.isArray(sources) || !sources.length) throw new Error('rate: a feed needs a source');
  if (!(Number.isInteger(minSources) && minSources >= 1 && (counted || minSources <= sources.length))) throw new Error('rate: minSources must be from 1 to the number of sources');
  let last = null, reading = null;
  async function refresh() {
    if (reading) return reading;
    reading = (async () => {
      const got = (await Promise.all(sources.map(async (s, i) => { try { const x = await s(); return counted && x && typeof x === 'object' ? { i, v: pos(x.ethPerBtc), n: x.n } : { i, v: pos(x), n: 1 }; } catch (e) { log({ level: 'warn', msg: 'a price source gave nothing', source: i, error: String((e && e.message) || e).slice(0, 120) }); return null; } }))).filter(Boolean);
      const cnt = (xs) => xs.reduce((t, g) => t + g.n, 0);
      if (cnt(got) < minSources) { log({ level: 'warn', msg: 'too few price sources answered', answered: cnt(got), need: minSources }); return last && now() - last.at <= maxAgeSecs ? last : null; }
      const m = median(got.map((g) => g.v)), within = got.filter((g) => Math.abs(g.v - m) * 10000 <= m * maxSpreadBps);
      if (cnt(within) < minSources || ((unanimous || got.length <= 2) && within.length < got.length)) {
        log({ level: 'warn', msg: 'the price sources disagree', values: got.map((g) => g.v) });
        last = null;                                  // a price that was good before the sources split is not kept: it may be the one that is wrong
        return null;
      }
      last = { ethPerBtc: median(within.map((g) => g.v)), at: now(), n: cnt(within) };
      return last;
    })().finally(() => { reading = null; });
    return reading;
  }
  const current = () => (last && now() - last.at <= maxAgeSecs ? { ...last } : null);
  const rate = () => { const c = current(); return c ? ratioOf(c.ethPerBtc) : null; };
  return { refresh, current, rate };
}
