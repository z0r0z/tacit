
export const TAPE_FINE = 300, TAPE_COARSE = 14400;
export const TAPE_WORDS = 256;
const E18 = 1e18;

export const unpackFloat = (p) => BigInt(p & 0xffffff) * (2n ** BigInt(p >>> 24));

export function decodeBar(word) {
  const w = BigInt(word);
  const f = (shift) => unpackFloat(Number((w >> BigInt(shift)) & 0xffffffffn));
  return { bucket: Number(w & 0xffffffffn), open: f(32), high: f(64), low: f(96), close: f(128), volume: f(160), count: Number((w >> 192n) & 0xffffn) };
}

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

export const invert = (bar) => ({ ...bar, open: 1 / bar.open, high: 1 / bar.low, low: 1 / bar.high, close: 1 / bar.close });
export const scale = (bar, k) => ({ ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k });

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

export function chartBars({ fine = [], coarse = [] }, period) {
  if (period < TAPE_COARSE) return period % TAPE_FINE === 0 ? rollup(fine, period) : [];
  const lastCoarse = coarse.length ? coarse[coarse.length - 1].t + TAPE_COARSE : 0;
  return rollup([...coarse, ...fine.filter((b) => b.t >= lastCoarse)], period);
}

export function continuous(bars) {
  return bars.map((b, i) => {
    const o = i ? bars[i - 1].close : b.open;
    return o === b.open ? b : { ...b, open: o, high: Math.max(b.high, o), low: b.low > 0 ? Math.min(b.low, o) : o };
  });
}

export function volumeSince({ fine = [], coarse = [] }, from, to, fineFrom = fine.length ? fine[0].t : to) {
  const f0 = fineFrom;
  let v = 0;
  for (const b of fine) if (b.t >= from && b.t < to) v += b.vol;
  for (const b of coarse) { const a = Math.max(b.t, from), z = Math.min(b.t + TAPE_COARSE, f0, to); if (z > a) v += (b.vol * (z - a)) / TAPE_COARSE; }
  return v;
}

export const span = (bars) => (bars.length ? { from: bars[0].t, to: bars[bars.length - 1].t } : null);

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

export function candlesFromTrades(trades, period, decimals = 8) {
  const out = new Map();
  for (const x of tradePrices(trades, decimals)) {
    const t = Math.floor(x.t / period) * period, c = out.get(t);
    if (!c) out.set(t, { t, open: x.price, high: x.price, low: x.price, close: x.price, vol: x.vol, n: 1 });
    else { c.high = Math.max(c.high, x.price); c.low = Math.min(c.low, x.price); c.close = x.price; c.vol += x.vol; c.n++; }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

export const ethLaneUsd = (bar, ethUsd) => scale(invert(bar), ethUsd);
export const btcLaneUsd = (bar, btcUsd) => scale(bar, btcUsd / 1e8);

export const gap = (a, b) => (a > 0 && b > 0 ? b / a - 1 : null);

export function closeAt(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) { ans = bars[mid]; lo = mid + 1; } else hi = mid - 1; }
  return ans ? ans.close : null;
}
