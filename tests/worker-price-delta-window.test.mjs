// Worker per-window price-change Δ% helper.
//
// The 24h Δ chip was anchored on a single "newest trade older than the
// cutoff" reference. On a young, sparse market where adjacent trades had
// wildly different unit prices, that reference snapped each time a trade
// crossed the 24h boundary — flipping the chip sign with no new prints.
// Observed live on TAC: ref jumped 208 → 251 sats in 3 minutes purely
// from one trade ageing out, flipping the chip from +17.82% to −2.52%.
//
// The fix linearly interpolates between the two anchors bracketing the
// cutoff (newest in-band trade with ts < cutoff and oldest in-band
// trade with ts ≥ cutoff). The interpolated reference moves smoothly
// across the boundary rather than snapping. The current trade is the
// implicit "after" anchor for past-relative cutoffs when no closer
// trade exists, which keeps interpolation defined for the common case.
//
// This file pins:
//   - interpolation midpoint produces the expected price between two
//     bracketing trades equidistant from the cutoff
//   - interpolation weights anchors by time-distance to the cutoff
//     (asymmetric case: closer anchor dominates)
//   - the boundary-cross scenario produces SMALLER jitter than the
//     old snap-to-before reference would have (the fix's whole point)
//   - dust prints outside the ±5× mark band are excluded from
//     reference selection (mirrors the +1683% TAC anchoring incident)
//   - primary-window selection prefers 24h, falls through to tighter
//     windows when 24h has no anchor older than cutoff
//   - empty ring returns {} (no spurious chip keys)
//
// Run: `node tests/worker-price-delta-window.test.mjs`

import { readFileSync } from 'node:fs';
import { _computeWindowedPriceDeltas, _computeMarkPriceFromTrades } from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else { console.log(`  FAIL  ${label}${ok ? ` (got ${JSON.stringify(ok)})` : ''}`); fail++; }
    })
    .catch(e => { console.log(`  FAIL  ${label}: ${e?.message || e}`); fail++; });
}

// Identity unit fn: each trade's `price_sats` IS the unit price (we set
// `amount` such that price/amount converts to itself). Keeps tests
// readable — the helper's contract is the windowing/interpolation, not
// the dapp's BigInt amount-scaling math.
const unitFn = (priceSats, _amount) => Number(priceSats);
// Builds a ring sorted newest→oldest from {ts, unit} pairs.
const ring = (entries) => entries
  .slice()
  .sort((a, b) => b.ts - a.ts)
  .map(e => ({ price_sats: e.unit, amount: '1', ts: e.ts }));

const HOUR = 3600;
const DAY = 86400;

const tests = [
  // ── (1) Interpolation midpoint, symmetric anchors ─────────────────────
  // Anchors at 200 (24h ago + 1h) and 240 (24h ago − 1h). Cutoff sits
  // exactly between them, so the interpolated reference is 220 and a
  // current mark of 220 reads as 0%.
  ['24h ref interpolates symmetric bracketing trades', () => {
    const now = 1_000_000;
    const r = ring([
      { ts: now,                  unit: 220 }, // current
      { ts: now - DAY + HOUR,     unit: 240 }, // after-anchor (1h newer than cutoff)
      { ts: now - DAY - HOUR,     unit: 200 }, // before-anchor (1h older than cutoff)
    ]);
    const out = _computeWindowedPriceDeltas(r, unitFn, 220, 220, now);
    const p = out.price_24h_change_pct;
    if (typeof p !== 'number') return `expected number, got ${JSON.stringify(p)}`;
    return Math.abs(p) < 1e-9 ? true : `expected ~0%, got ${p}%`;
  }],

  // ── (2) Interpolation is time-weighted ────────────────────────────────
  // Only two anchors in the ring: the current trade (now) and one
  // 25h ago. The 24h cutoff sits 1h into a 25h span between them, so
  // frac = 1h/25h = 0.04 and ref = 90 + (100−90)·0.04 = 90.4. The chip
  // pulls the reference 4% of the way toward the current price rather
  // than snap-to-before's hard 90.
  ['interpolated ref weighted by time-distance to anchors', () => {
    const now = 2_000_000;
    const r = ring([
      { ts: now,              unit: 100 }, // current = after-anchor
      { ts: now - DAY - HOUR, unit:  90 }, // 25h ago = before-anchor
    ]);
    const out = _computeWindowedPriceDeltas(r, unitFn, 100, 100, now);
    const p = out.price_24h_change_pct;
    const refU = 90 + (100 - 90) * (HOUR / (DAY + HOUR));
    const expected = ((100 - refU) / refU) * 100;
    return (typeof p === 'number' && Math.abs(p - expected) < 1e-9)
      ? true
      : `expected ${expected.toFixed(6)}%, got ${p}`;
  }],

  // ── (3) Interpolation jitter is bounded by snap-to-before jitter ─────
  // Reproduces the live TAC regression shape. Two trades sit 60s either
  // side of the 24h boundary. Take two snapshots 120s apart so the
  // after-side anchor ages into the before-side region. With
  // snap-to-before the reference flips hard (251 → 210). Interpolation
  // must produce a strictly smaller jitter between the two snapshots.
  ['boundary-cross jitter is smaller than snap-to-before would produce', () => {
    const t0 = 3_000_000;
    const r = ring([
      { ts: t0,            unit: 245 },
      { ts: t0 - DAY + 60, unit: 210 }, // 60s after the cutoff at t0; ages out by t0+120
      { ts: t0 - DAY - 60, unit: 251 }, // 60s before the cutoff at t0
    ]);
    const out1 = _computeWindowedPriceDeltas(r, unitFn, 245, 245, t0);
    const out2 = _computeWindowedPriceDeltas(r, unitFn, 245, 245, t0 + 120);
    const p1 = out1.price_24h_change_pct;
    const p2 = out2.price_24h_change_pct;
    if (typeof p1 !== 'number' || typeof p2 !== 'number') {
      return `missing delta: p1=${p1} p2=${p2}`;
    }
    // Snap-to-before counterfactual: at t0 ref=251, at t0+120 ref=210.
    const snapJitter = Math.abs(((245 - 251) / 251) - ((245 - 210) / 210)) * 100;
    const interpJitter = Math.abs(p1 - p2);
    return (interpJitter < snapJitter)
      ? true
      : `interp jitter ${interpJitter.toFixed(2)}pp not less than snap jitter ${snapJitter.toFixed(2)}pp (p1=${p1.toFixed(2)}%, p2=${p2.toFixed(2)}%)`;
  }],

  // ── (4) Dust print outside ±5× band is excluded ───────────────────────
  // A 0.18-sat print just before the cutoff (the historical TAC scenario)
  // must not anchor the 24h reference at a mark of 245 (band = [49, 1225]).
  // The next in-band trade behind it is the anchor instead; the chip
  // reads the small positive move from 240 toward 245, not the +136000%
  // a dust-anchored chip would have shown.
  ['dust print outside band does not anchor reference', () => {
    const now = 4_000_000;
    const r = ring([
      { ts: now,                  unit: 245 },
      { ts: now - DAY - 60,       unit: 0.18 }, // dust, out-of-band
      { ts: now - DAY - 2 * HOUR, unit: 240 }, // legitimate in-band ref
    ]);
    const out = _computeWindowedPriceDeltas(r, unitFn, 245, 245, now);
    const p = out.price_24h_change_pct;
    // before = {u:240, ts:now-DAY-7200}; after = current {u:245, ts:now}.
    // span = DAY + 7200. frac = 7200 / (DAY + 7200). u interpolated.
    const span = DAY + 2 * HOUR;
    const refU = 240 + 5 * (2 * HOUR / span);
    const expected = ((245 - refU) / refU) * 100;
    return (typeof p === 'number' && Math.abs(p - expected) < 1e-9)
      ? true
      : `expected ${expected.toFixed(6)}%, got ${p}`;
  }],

  // ── (5) Primary-window selection prefers 24h ──────────────────────────
  ['primary window prefers 24h when available', () => {
    const now = 5_000_000;
    const r = ring([
      { ts: now,                 unit: 110 },
      { ts: now - 30 * 60,       unit: 105 }, // 30m ago — feeds 1h
      { ts: now - 3 * HOUR,      unit: 102 }, // 3h ago — feeds 4h
      { ts: now - DAY + HOUR,    unit: 100 }, // 23h ago — after-anchor for 24h
      { ts: now - DAY - HOUR,    unit:  95 }, // 25h ago — before-anchor for 24h
    ]);
    const out = _computeWindowedPriceDeltas(r, unitFn, 110, 110, now);
    return out.price_change_primary_window === '24h'
      ? true
      : `expected '24h', got '${out.price_change_primary_window}'`;
  }],

  // ── (6) Primary window falls through to tightest available ────────────
  // Ring has nothing older than 1h beyond the current trade (the
  // newest "real" trade is older than 1h — feeds the 1h window's
  // before-anchor; nothing older means 4h/24h have no before-anchor).
  ['primary window falls back to tightest available', () => {
    const now = 6_000_000;
    const r = ring([
      { ts: now,             unit: 110 },
      { ts: now - 30 * 60,   unit: 105 }, // 30m ago — 1h after-anchor
      { ts: now - 2 * HOUR,  unit: 100 }, // 2h ago — 1h before-anchor; not within 4h cutoff distance for 4h before
    ]);
    const out = _computeWindowedPriceDeltas(r, unitFn, 110, 110, now);
    return out.price_change_primary_window === '1h'
      ? true
      : `expected '1h', got '${out.price_change_primary_window}'`;
  }],

  // ── (7) Empty ring returns empty object ───────────────────────────────
  ['empty ring returns {} (no spurious keys)', () => {
    const out = _computeWindowedPriceDeltas([], unitFn, 100, 100, 7_000_000);
    return (out && typeof out === 'object' && Object.keys(out).length === 0)
      ? true
      : `expected {}, got ${JSON.stringify(out)}`;
  }],

  // ── (8) Thin-market mark guard keeps one print from redefining mark ───
  ['thin one-trade day falls back to recent median mark', () => {
    const now = 8_000_000;
    const r = ring([
      { ts: now - 10 * 60, unit: 72 },     // only 24h trade
      { ts: now - 2 * DAY, unit: 199 },
      { ts: now - 3 * DAY, unit: 200 },
      { ts: now - 4 * DAY, unit: 245 },
      { ts: now - 5 * DAY, unit: 266 },
      { ts: now - 6 * DAY, unit: 300 },
      { ts: now - 7 * DAY, unit: 320 },
    ]);
    const out = _computeMarkPriceFromTrades({
      lastTrade: r[0],
      ring: r,
      unitFn,
      nowSec: now,
    });
    const expectedMedian = 245;
    return out?.source === 'thin_liquidity_guard'
      && Math.abs(out.unit - expectedMedian) < 1e-9
      && out.trades_24h === 1
      ? true
      : `expected thin_liquidity_guard median ${expectedMedian}, got ${JSON.stringify(out)}`;
  }],

  ['thin one-trade day keeps last trade when near median', () => {
    const now = 9_000_000;
    const r = ring([
      { ts: now - 10 * 60, unit: 180 },
      { ts: now - 2 * DAY, unit: 190 },
      { ts: now - 3 * DAY, unit: 200 },
      { ts: now - 4 * DAY, unit: 205 },
      { ts: now - 5 * DAY, unit: 210 },
    ]);
    const out = _computeMarkPriceFromTrades({
      lastTrade: r[0],
      ring: r,
      unitFn,
      nowSec: now,
    });
    return out?.source === 'last_trade' && Math.abs(out.unit - 180) < 1e-9
      ? true
      : `expected last_trade 180, got ${JSON.stringify(out)}`;
  }],

  ['hard mark outlier still falls back to median', () => {
    const now = 10_000_000;
    const r = ring([
      { ts: now - 10 * 60, unit: 20 },
      { ts: now - 2 * DAY, unit: 190 },
      { ts: now - 3 * DAY, unit: 200 },
      { ts: now - 4 * DAY, unit: 205 },
      { ts: now - 5 * DAY, unit: 210 },
    ]);
    const out = _computeMarkPriceFromTrades({
      lastTrade: r[0],
      ring: r,
      unitFn,
      nowSec: now,
    });
    return out?.source === 'median_outlier_guard' && Math.abs(out.unit - 200) < 1e-9
      ? true
      : `expected median_outlier_guard 200, got ${JSON.stringify(out)}`;
  }],

  // ── (9) The reference median is the market as it trades now, not the whole ring ──
  // The real TAC Bitcoin-book ring of 2026-11-28 (618 fills, May to Nov; TAC repriced about fivefold in November): the median of the
  // whole ring is 225 sats while the week's fills sit at 790-1,460. The day's only fill (910 sats) is within 0.76x of the week's median, so it is the mark.
  ['real ring after a repricing: the one fill of the day is the mark, not the old median', () => {
    const rows = JSON.parse(readFileSync(new URL('./fixtures/tac-btc-trades-2026-11-28.json', import.meta.url))).rows;
    const dec8 = (p, a) => Number(BigInt(Math.floor(Number(p))) * 10n ** 8n * 100000000n / BigInt(a)) / 1e8;
    const real = rows.map(([ts, price_sats, amount]) => ({ ts, price_sats, amount })).sort((a, b) => b.ts - a.ts);
    const now = real[0].ts + 25 * HOUR;
    const all = real.map((t) => dec8(t.price_sats, t.amount)).sort((a, b) => a - b), wholeRingMedian = all[all.length >> 1];
    if (!(wholeRingMedian > 200 && wholeRingMedian < 250)) return `fixture changed: whole-ring median ${wholeRingMedian}`;
    const out = _computeMarkPriceFromTrades({ lastTrade: real[0], ring: real, unitFn: dec8, nowSec: now });
    return out?.source === 'last_trade' && Math.abs(out.unit - 910) < 0.01
      ? true
      : `expected last_trade 910 (the whole-ring median ${wholeRingMedian.toFixed(1)} is what the old code returned), got ${JSON.stringify(out)}`;
  }],

  ['a repricing with fills at the new price: the day\'s one print at the new price is kept', () => {
    const now = 20_000_000;
    const old = Array.from({ length: 40 }, (_, i) => ({ ts: now - 60 * DAY - i * HOUR, unit: 150 + (i % 5) }));
    const fresh = Array.from({ length: 12 }, (_, i) => ({ ts: now - 2 * DAY - i * HOUR, unit: 1000 + (i % 4) * 20 }));
    const r = ring([{ ts: now - 20 * 60, unit: 1100 }, ...fresh, ...old]);
    const out = _computeMarkPriceFromTrades({ lastTrade: r[0], ring: r, unitFn, nowSec: now });
    return out?.source === 'last_trade' && out.unit === 1100
      ? true
      : `expected last_trade 1100 (the old whole-ring median, ~150, made 1100 a 7x outlier), got ${JSON.stringify(out)}`;
  }],

  ['a lonely print far from this week\'s fills is still held back to the week\'s median', () => {
    const now = 21_000_000;
    const week = Array.from({ length: 10 }, (_, i) => ({ ts: now - 2 * DAY - i * HOUR, unit: 1000 }));
    const r = ring([{ ts: now - 5 * 60, unit: 3200 }, ...week]);
    const out = _computeMarkPriceFromTrades({ lastTrade: r[0], ring: r, unitFn, nowSec: now });
    return out?.source === 'thin_liquidity_guard' && out.unit === 1000
      ? true
      : `expected thin_liquidity_guard 1000, got ${JSON.stringify(out)}`;
  }],

  ['a quiet fortnight: with under five fills in the week, the newest twenty fills are the reference', () => {
    const now = 22_000_000;
    const longAgo = Array.from({ length: 30 }, (_, i) => ({ ts: now - 120 * DAY - i * HOUR, unit: 150 }));
    const recentish = Array.from({ length: 25 }, (_, i) => ({ ts: now - 10 * DAY - i * HOUR, unit: 1000 + (i % 3) * 10 }));
    const r = ring([...recentish, ...longAgo]);
    const wholeRing = r.map((t) => t.price_sats).sort((a, b) => a - b)[r.length >> 1];
    const out = _computeMarkPriceFromTrades({ lastTrade: r[0], ring: r, unitFn, nowSec: now });
    return wholeRing === 150 && out?.source === 'last_trade' && out.unit === 1000
      ? true
      : `expected last_trade 1000 (whole-ring median ${wholeRing} would call it a 6.7x outlier), got ${JSON.stringify(out)}`;
  }],

  ['the deltas follow the corrected mark: a 910-sat mark against a 1,200-sat week reads down, not down 75%', () => {
    const now = 23_000_000;
    const old = Array.from({ length: 40 }, (_, i) => ({ ts: now - 60 * DAY - i * HOUR, unit: 150 }));
    const week = Array.from({ length: 12 }, (_, i) => ({ ts: now - (2 + i) * DAY, unit: 1200 }));
    const r = ring([{ ts: now - 10 * 60, unit: 910 }, ...week, ...old]);
    const mark = _computeMarkPriceFromTrades({ lastTrade: r[0], ring: r, unitFn, nowSec: now });
    const d = _computeWindowedPriceDeltas(r, unitFn, mark.unit, 910, now);
    return mark.unit === 910 && d.price_7d_change_pct > -30 && d.price_7d_change_pct < -20
      ? true
      : `expected a 7d change near -24%, got mark ${mark.unit} and ${JSON.stringify(d)}`;
  }],
];

(async () => {
  console.log('worker-price-delta-window');
  for (const [label, fn] of tests) await test(label, fn);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
