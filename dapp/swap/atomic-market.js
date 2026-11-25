// What the Bitcoin and Ethereum lane can say before a Tacit wallet is open: the providers of the pair (their signed ads, fast/discover.js), the market price (Chainlink's
// ETH / BTC aggregator through public nodes, as the pair client reads it), and from the two an estimate of what an amount gets. The lane (swap/atomic.js) and the /btc/
// page read it; the firm quote still comes from the provider once the wallet is open. No DOM.
//
//   const m = await readMarket({ fetchImpl, lists, call, now })
//   m.rate          ETH per BTC, or null when the market could not be read
//   m.providers     [{ id, name, b2e: { min, max, available, feeBps, flatFee }, e2b: same | null }]: b2e amounts and flat fee in sats, e2b in pool units (1e-8 ETH)
//   m.totals        { b2e: { min, max, now }, e2b: same } over every provider (null for a direction none offers): the least taken, the most asked, the most takeable now
//   estimate(m, dir, amount) -> { get, provider } | null       what the best provider would give for `amount`, before its own quote

import { discoverProviders } from '/fast/discover.js?cb=4a1bb265';
import { makeRateFeed, chainlinkEthBtc, chainlinkNodes, PRICE_NODES } from '/fastbridge-rate.js?cb=be7769e1';
import { SATS_ASSET_ID, ETH_ASSET_ID } from '/swap/atomic-probe.js?cb=590d41c3';

const loadLists = async (fetchImpl) => {
  try {
    const r = await fetchImpl('/fast/lp.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return { providers: Array.isArray(j?.providers) ? j.providers : [], boards: Array.isArray(j?.boards) ? j.boards : [] };
  } catch { return { providers: [], boards: [] }; }
};
const side = (t) => (t ? { min: BigInt(t.minAmount), max: BigInt(t.maxAmount), available: t.available == null ? null : BigInt(t.available), feeBps: Number(t.feeBps) || 0, flatFee: BigInt(t.flatFee ?? 0) } : null);
// the most one swap can be with a provider right now: its maximum, or what it holds when that is less
export const takeable = (s) => (!s ? 0n : s.available != null && s.available < s.max ? s.available : s.max);
const totalOf = (ss) => {
  const on = ss.filter(Boolean);
  if (!on.length) return null;
  return { min: on.reduce((a, s) => (s.min < a ? s.min : a), on[0].min), max: on.reduce((a, s) => (s.max > a ? s.max : a), 0n), now: on.reduce((a, s) => { const t = takeable(s); return t >= s.min && t > a ? t : a; }, 0n) };
};

let feed = null;
// (the market is read as the pair client reads it: the aggregator at one block from nodes of separate operators, two or more agreeing; `call` reads it through one
// caller's eth_call instead)
export async function readMarket({ fetchImpl = (...a) => fetch(...a), lists = null, call = null, now, nodes = PRICE_NODES } = {}) {
  feed ||= call
    ? makeRateFeed({ sources: [chainlinkEthBtc({ call, ...(now ? { now } : {}) })], minSources: 1, maxAgeSecs: 600, ...(now ? { now } : {}) })
    : makeRateFeed({ sources: chainlinkNodes({ nodes, fetchImpl, ...(now ? { now } : {}) }), minSources: 2, maxSpreadBps: 1, unanimous: true, maxAgeSecs: 600, ...(now ? { now } : {}) });
  const l = lists || (await loadLists(fetchImpl));
  const [found, rate] = await Promise.all([
    discoverProviders({ ...l, fetchImpl, assets: { btcAsset: SATS_ASSET_ID, evmAsset: ETH_ASSET_ID }, ...(now ? { now } : {}) }).catch(() => []),
    feed.refresh().then((c) => (c ? c.ethPerBtc : null), () => null),
  ]);
  const providers = found.map((p) => ({ id: p.id, name: p.name || 'Provider', b2e: side(p.terms), e2b: side(p.reverse) }));
  return { rate, providers, totals: { b2e: totalOf(providers.map((p) => p.b2e)), e2b: totalOf(providers.map((p) => p.e2b)) }, at: Math.floor(Date.now() / 1000) };
}

// what is left of `amount` after a side's fee (its share and its flat part, both in the paying side's units)
export const afterFee = (s, amount) => { const a = BigInt(amount), f = (a * BigInt(s.feeBps)) / 10000n + s.flatFee; return a > f ? a - f : 0n; };
// the fee as a share of the smallest swap, which is where a flat part weighs most
export const feeAtMin = (s) => (s && s.min > 0n ? (Number((s.min * BigInt(s.feeBps)) / 10000n + s.flatFee) / Number(s.min)) * 100 : null);

export function estimate(m, dir, amount) {
  const a = BigInt(amount || 0);
  if (!m || !m.rate || a <= 0n) return null;
  let best = null;
  for (const p of m.providers) {
    const s = p[dir];
    if (!s || a < s.min || a > takeable(s)) continue;
    const net = afterFee(s, a);
    // 1 ETH and 1 BTC are both 1e8 units, so ETH per BTC is pool units per sat
    const get = dir === 'b2e' ? BigInt(Math.floor(Number(net) * m.rate)) : BigInt(Math.floor(Number(net) / m.rate));
    if (!best || get > best.get) best = { get, provider: p.name };
  }
  return best;
}
