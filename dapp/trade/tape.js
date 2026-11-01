// Price history for the TAC trade page, as plain data: the Precision pool's on-chain price tape (zFi's IPriceTape,
// read with eth_call: no indexer), and the Bitcoin order book's trades, both turned into candles. Pure: no DOM, no
// network, so a node test can feed it what the chain returned.
//
// A tape bar is one 256-bit word: bucket u32 (unix time / period; 0 = nothing traded), then open, high, low, close and
// volume as 4-byte floats (a 24-bit mantissa shifted left by an 8-bit exponent), then a trade count u16. A price is raw
// token1 per raw token0 times 1e18 (the pair here is ETH, TAC, both 18 decimals, so TAC per ETH). Volume is in token0
// (ETH). Floats truncate, a coarse bar lags the live fine bar by one fine bar, and a dust trade can move a bar's high
// or low: it is a chart, not an oracle.

export const TAPE_FINE = 300, TAPE_COARSE = 14400;
// How many buckets the page asks of each tape (the newest the one in progress): the 5-minute tape reaches back this many bars, whether or not they traded.
export const TAPE_WORDS = 256;
const E18 = 1e18;

// The 4-byte float back to an integer: mantissa << exponent.
export const unpackFloat = (p) => BigInt(p & 0xffffff) * (2n ** BigInt(p >>> 24));

// One bar word (bigint, or a hex string) → { bucket, open, high, low, close, volume, count }, prices as bigint ×1e18.
export function decodeBar(word) {
  const w = BigInt(word);
  const f = (shift) => unpackFloat(Number((w >> BigInt(shift)) & 0xffffffffn));
  return { bucket: Number(w & 0xffffffffn), open: f(32), high: f(64), low: f(96), close: f(128), volume: f(160), count: Number((w >> 192n) & 0xffffn) };
}

// The words `tape(period, count)` returned (newest first, empty buckets zero) → bars oldest first, as numbers:
// { t (start, unix seconds), open, high, low, close (TAC per ETH), vol (ETH), n (trades) }. `decimalsShift` is
// decimals(token0) − decimals(token1): 0 for ETH and TAC.
export function decodeTape(words, period, decimalsShift = 0) {
  const k = 10 ** decimalsShift, bars = [];
  for (const word of words) {
    if (BigInt(word) === 0n) continue;
    const b = decodeBar(word);
    if (!b.bucket) continue;
    const px = (x) => (Number(x) / E18) * k;
    bars.push({ t: b.bucket * period, open: px(b.open), high: px(b.high), low: px(b.low), close: px(b.close), vol: Number(b.volume) / E18, n: b.count });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// The bar for the price the other way up: ETH per TAC from TAC per ETH. High and low swap places.
export const invert = (bar) => ({ ...bar, open: 1 / bar.open, high: 1 / bar.low, low: 1 / bar.high, close: 1 / bar.close });
export const scale = (bar, k) => ({ ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k });

// Finer bars into wider ones (a whole number of the finer period): open of the first, close of the last, the extremes,
// the volumes and counts added. A bar whose low is 0 (a price that underflowed the tape's 1e18 scale) leaves the low alone.
export function rollup(bars, period) {
  const out = new Map();
  for (const b of bars) {
    const t = Math.floor(b.t / period) * period, c = out.get(t);
    if (!c) { out.set(t, { ...b, t }); continue; }
    c.high = Math.max(c.high, b.high);
    if (b.low > 0) c.low = c.low > 0 ? Math.min(c.low, b.low) : b.low;
    c.close = b.close; c.vol += b.vol; c.n += b.n;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// What a chart of `period`-second bars is drawn from: periods under four hours from the 5-minute tape (about 21 hours back),
// four hours and over from the 4-hour tape (about 42 days back). A 4-hour bar lags the live 5-minute bar by one, so the
// 5-minute bars newer than the last 4-hour bar are added to it before it is rolled up.
export function chartBars({ fine = [], coarse = [] }, period) {
  if (period < TAPE_COARSE) return period % TAPE_FINE === 0 ? rollup(fine, period) : [];
  const lastCoarse = coarse.length ? coarse[coarse.length - 1].t + TAPE_COARSE : 0;
  return rollup([...coarse, ...fine.filter((b) => b.t >= lastCoarse)], period);
}

// A pool's price moves only when it trades, so a period opens where the one before it closed: each bar's open becomes the close before it
// (its high and low widened to take that in) instead of its own first trade, whose price includes that trade's impact. The first bar keeps its own.
export function continuous(bars) {
  return bars.map((b, i) => {
    const o = i ? bars[i - 1].close : b.open;
    return o === b.open ? b : { ...b, open: o, high: Math.max(b.high, o), low: b.low > 0 ? Math.min(b.low, o) : o };
  });
}

// ETH traded from `from` to `to` (unix seconds): the 5-minute bars where the tape holds them (they reach back about a day), and the
// 4-hour bars before them, a bucket that only partly falls in the window counted for its share of the time. A bucket that began
// before the window is therefore not dropped whole, and the stretch the 5-minute bars cover is never counted twice. An empty 5-minute bucket is not
// in the tape, so where the bars start is told by `fineFrom` (the page knows how far back it asked); without it, the first bar read stands for it.
export function volumeSince({ fine = [], coarse = [] }, from, to, fineFrom = fine.length ? fine[0].t : to) {
  const f0 = fineFrom;
  let v = 0;
  for (const b of fine) if (b.t >= from && b.t < to) v += b.vol;
  for (const b of coarse) { const a = Math.max(b.t, from), z = Math.min(b.t + TAPE_COARSE, f0, to); if (z > a) v += (b.vol * (z - a)) / TAPE_COARSE; }
  return v;
}

// Bars of a tape on the first and last day of what has been read are partial buckets; the chart's span, for its axis.
export const span = (bars) => (bars.length ? { from: bars[0].t, to: bars[bars.length - 1].t } : null);

// ── the Bitcoin order book's trades ──

// /assets/<id> returns `trades`, newest first: { price_sats (the whole fill's price), amount (base units), ts, fill_count }.
// The unit price is sats per TAC. A trade far from the median (a fill outside 0.2x-5x of it) is a different thing from a
// price and is dropped, as the worker does for its own mark.
export function tradePrices(trades, decimals = 8) {
  const pts = [];
  for (const t of trades || []) {
    const amount = Number(t.amount) / 10 ** decimals, sats = Number(t.price_sats);
    if (amount > 0 && sats > 0 && Number.isFinite(Number(t.ts))) pts.push({ t: Number(t.ts), price: sats / amount, vol: amount });
  }
  if (pts.length < 3) return pts.sort((a, b) => a.t - b.t);
  const sorted = [...pts].map((x) => x.price).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
  return pts.filter((x) => x.price >= med * 0.2 && x.price <= med * 5).sort((a, b) => a.t - b.t);
}

// Trades into candles of `period` seconds: { t, open, high, low, close (sats per TAC), vol (TAC), n }.
export function candlesFromTrades(trades, period, decimals = 8) {
  const out = new Map();
  for (const x of tradePrices(trades, decimals)) {
    const t = Math.floor(x.t / period) * period, c = out.get(t);
    if (!c) out.set(t, { t, open: x.price, high: x.price, low: x.price, close: x.price, vol: x.vol, n: 1 });
    else { c.high = Math.max(c.high, x.price); c.low = Math.min(c.low, x.price); c.close = x.price; c.vol += x.vol; c.n++; }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ── comparing the two lanes ──

// Both lanes in dollars per TAC at today's rates (a tape has no dollar history): the Ethereum tape's TAC-per-ETH and the book's
// sats-per-TAC. `ethUsd` and `btcUsd` are the rates now, so the chart shows how the two lanes sit against each other, not
// what a dollar was worth on a day.
export const ethLaneUsd = (bar, ethUsd) => scale(invert(bar), ethUsd);
export const btcLaneUsd = (bar, btcUsd) => scale(bar, btcUsd / 1e8);

// The gap between two lanes' last prices, as a fraction of the first: positive when `b` is above `a`.
export const gap = (a, b) => (a > 0 && b > 0 ? b / a - 1 : null);

// Where a series is at `t`: the close of the last bar at or before it (a lane that has not traded since keeps its last close).
export function closeAt(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) { ans = bars[mid]; lo = mid + 1; } else hi = mid - 1; }
  return ans ? ans.close : null;
}
