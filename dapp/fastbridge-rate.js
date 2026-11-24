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
export function makeRateFeed({ sources, now = () => Math.floor(Date.now() / 1000), minSources = 2, maxSpreadBps = 100, maxAgeSecs = 180, unanimous = false, log = () => {} }) {
  // a feed that needs no source to answer would take no answer for a price: it needs at least one, and has one to ask
  if (!Array.isArray(sources) || !sources.length) throw new Error('rate: a feed needs a source');
  if (!(Number.isInteger(minSources) && minSources >= 1 && minSources <= sources.length)) throw new Error('rate: minSources must be from 1 to the number of sources');
  let last = null, reading = null;
  async function refresh() {
    if (reading) return reading;
    reading = (async () => {
      const got = (await Promise.all(sources.map(async (s, i) => { try { return { i, v: pos(await s()) }; } catch (e) { log({ level: 'warn', msg: 'a price source gave nothing', source: i, error: String((e && e.message) || e).slice(0, 120) }); return null; } }))).filter(Boolean);
      if (got.length < minSources) { log({ level: 'warn', msg: 'too few price sources answered', answered: got.length, need: minSources }); return last && now() - last.at <= maxAgeSecs ? last : null; }
      const m = median(got.map((g) => g.v)), within = got.filter((g) => Math.abs(g.v - m) * 10000 <= m * maxSpreadBps);
      if (within.length < minSources || ((unanimous || got.length <= 2) && within.length < got.length)) {
        log({ level: 'warn', msg: 'the price sources disagree', values: got.map((g) => g.v) });
        last = null;                                  // a price that was good before the sources split is not kept: it may be the one that is wrong
        return null;
      }
      last = { ethPerBtc: median(within.map((g) => g.v)), at: now(), n: within.length };
      return last;
    })().finally(() => { reading = null; });
    return reading;
  }
  const current = () => (last && now() - last.at <= maxAgeSecs ? { ...last } : null);
  const rate = () => { const c = current(); return c ? ratioOf(c.ethPerBtc) : null; };
  return { refresh, current, rate };
}
