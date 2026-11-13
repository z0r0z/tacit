// Slim views of the /stats reading, each built once per reading from its JSON body.
//
// `eth`: the pool's ETH reading alone (its totals and its movements), for the tETH page, which draws the pool's ETH history and reads nothing else
// of /stats. It is the `eth` object the whole reading carries, with the reading's time and block beside it, less the per-deposit series (`ins`,
// which the page does not read; its deposits are among the movements), and with each movement's amount a plain decimal string, not { $n: "…" }.
const plain = (v) => (v && typeof v === 'object' && '$n' in v ? v.$n : v);
export function ethStatsBody(body) {
  const j = JSON.parse(body), e = j.eth;
  let eth = e ?? null;
  if (e && typeof e === 'object' && e.series) {
    const { series, ...rest } = e, { ins, ...kept } = series, f = series.flows;
    eth = { ...rest, series: { ...kept, flows: Array.isArray(f) ? f.map(([t, v]) => [t, plain(v)]) : f } };
  }
  return JSON.stringify({ eth, at: j.at ?? null, block: j.block ?? null });
}

// `page`: the whole reading for the stats page, with the device pools' per-event series gathered into time buckets. Those series are only drawn (the ETH chart's
// step line) and counted by day (the activity chart), and one pool alone has tens of thousands of events (2.5 MB of the 2.9 MB reading); the chart is a few hundred
// pixels wide, so the events of one bucket become one step of the sum of their amounts, at the time of the bucket's last event, and a deposit bucket says how many
// deposits it holds. A bucket is at most 1/PAGE_BUCKETS of the time the reading covers (a quarter of a pixel on the widest chart), never less than a quarter of an
// hour, and always a part of a day that divides it evenly, so that no bucket holds events of two days. Totals, counts and the V1 pool's own series are carried as
// they are.
export const PAGE_BUCKETS = 4000;
const BUCKET_SIZES = [900, 1200, 1440, 1800, 2400, 3600, 4800, 7200, 14400, 28800, 43200, 86400];   // seconds; each divides 86,400
const amount = (v) => BigInt(v && typeof v === 'object' ? v.$n : v);
export function bucketSeries(events, size, { counted = false } = {}) {
  const by = new Map();
  for (const [t, v] of events) {
    if (t == null) continue;
    const k = Math.floor(t / size), cur = by.get(k);
    if (cur) { cur.sum += amount(v); cur.n++; if (t > cur.t) cur.t = t; } else by.set(k, { t, sum: amount(v), n: 1 });
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b).filter((b) => counted || b.sum !== 0n)
    .map((b) => (counted ? [b.t, { $n: b.sum.toString() }, b.n] : [b.t, { $n: b.sum.toString() }]));
}
export function pageStatsBody(body) {
  const j = JSON.parse(body);
  if (!Array.isArray(j.dev)) return body;
  const firsts = [];
  for (const s of [j.eth?.series, ...j.dev.map((d) => d?.series)]) for (const key of ['ins', 'flows']) { const t = s?.[key]?.find?.((e) => e[0] != null)?.[0]; if (t != null) firsts.push(t); }
  if (!firsts.length) return body;
  const span = (j.at ?? Date.now()) / (j.at > 1e11 ? 1000 : 1) - Math.min(...firsts), want = Math.ceil(span / PAGE_BUCKETS);
  const size = BUCKET_SIZES.find((x) => x >= want) ?? 86400;
  j.dev = j.dev.map((d) => (d && d.series ? { ...d, series: { ins: bucketSeries(d.series.ins || [], size, { counted: true }), flows: bucketSeries(d.series.flows || [], size) } } : d));
  return JSON.stringify(j);
}
