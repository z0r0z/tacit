#!/usr/bin/env node
// dapp/trade/tape.js against the TAC/ETH Precision pool's real tape (tests/fixtures/precision-tape-2026-10-12.json, as
// `tape(period, 256)` returned it on mainnet), the float decoding against an independent encoder, and the candle maths.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  TAPE_FINE, TAPE_COARSE, unpackFloat, decodeBar, decodeTape, invert, scale, rollup, chartBars, continuous, tradePrices, candlesFromTrades, ethLaneUsd, btcLaneUsd, gap, closeAt, volumeSince,
} from '../dapp/trade/tape.js';
import { cumulative } from '../dapp/trade/book.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const fx = JSON.parse(readFileSync(new URL('./fixtures/precision-tape-2026-10-12.json', import.meta.url)));

// The contract's own encoder (PriceTape.pack): msb, keep 24 bits.
const pack = (v) => { v = BigInt(v); if (v === 0n) return 0; const msb = v.toString(2).length - 1; if (msb < 24) return Number(v); const sh = msb - 23; return Number((BigInt(sh) << 24n) | (v >> BigInt(sh))); };
const encode = (bucket, o, h, l, c, v, count) => BigInt(bucket) | (BigInt(pack(o)) << 32n) | (BigInt(pack(h)) << 64n) | (BigInt(pack(l)) << 96n) | (BigInt(pack(c)) << 128n) | (BigInt(pack(v)) << 160n) | (BigInt(count) << 192n);

// ── floats and one bar ──
{
  assert.equal(unpackFloat(0), 0n);
  assert.equal(unpackFloat(1), 1n);
  assert.equal(unpackFloat(0xffffff), 0xffffffn, 'exponent 0 is exact');
  assert.equal(unpackFloat((8 << 24) | 0x800000), 0x800000n << 8n);
  for (const v of [1n, 12345n, 0xffffffn, 10n ** 18n, 13373n * 10n ** 18n, 7n * 10n ** 40n + 12345n]) {
    const back = unpackFloat(pack(v));
    assert.ok(back <= v && (v - back) * 8000000n <= v, `${v} → ${back}: truncates, and within 2^-23`);
  }
  const bar = decodeBar(encode(123456, 13000n * 10n ** 18n, 13500n * 10n ** 18n, 12900n * 10n ** 18n, 13373n * 10n ** 18n, 25n * 10n ** 17n, 7));
  assert.equal(bar.bucket, 123456); assert.equal(bar.count, 7);
  for (const [k, want] of [['open', 13000n], ['high', 13500n], ['low', 12900n], ['close', 13373n]]) {
    const got = Number(bar[k]) / 1e18, w = Number(want);
    assert.ok(Math.abs(got - w) / w < 2e-7 && got <= w, `${k} ${got} vs ${w}`);
  }
  assert.ok(Math.abs(Number(bar.volume) / 1e18 - 2.5) < 1e-6);
  ok('floats unpack to what the contract packed (truncated, within 2^-23) and a bar word decodes field by field');
}

// ── the real tape ──
const coarse = decodeTape(fx.coarse, TAPE_COARSE), fine = decodeTape(fx.fine, TAPE_FINE);
{
  assert.equal(coarse.length, 80, 'the 4-hour tape had 80 bars with trades when read');
  assert.equal(fine.length, 14);
  assert.ok(coarse.every((b, i) => i === 0 || b.t > coarse[i - 1].t), 'oldest first, strictly increasing');
  assert.ok(coarse.every((b) => b.t % TAPE_COARSE === 0) && fine.every((b) => b.t % TAPE_FINE === 0));
  assert.equal(new Date(coarse[0].t * 1000).toISOString(), '2026-09-22T16:00:00.000Z', 'the first bar is the pool\'s first day');
  assert.ok(coarse.every((b) => b.low > 0 && b.low <= b.open && b.low <= b.close && b.high >= b.open && b.high >= b.close && b.n > 0 && b.vol >= 0), 'every bar is a well-formed candle');
  const trades = coarse.reduce((a, b) => a + b.n, 0), eth = coarse.reduce((a, b) => a + b.vol, 0);
  assert.ok(trades >= 650 && trades <= 700, `trades ${trades}`);
  assert.ok(eth > 29 && eth < 32, `volume ${eth} ETH`);
  const lo = Math.min(...coarse.map((b) => b.low)), hi = Math.max(...coarse.map((b) => b.high));
  assert.ok(lo > 3400 && lo < 3600 && hi > 25000 && hi < 26500, `range ${lo}-${hi} TAC per ETH (read with cast: 3492-25884)`);
  const last = coarse.at(-1).close;
  assert.ok(last > 13000 && last < 13800, `last 4-hour close ${last}`);
  assert.ok(fine.at(-1).t >= coarse.at(-1).t, 'the fine tape reaches past the coarse one');
  ok('the real 4-hour tape: 80 bars from 2026-09-22 16:00Z, ~660 trades, ~30 ETH, 3,492 to 25,884 TAC per ETH; the 5-minute tape has 14');
}

// ── inversion, roll-up, merging ──
{
  const b = coarse[10], inv = invert(b);
  assert.ok(Math.abs(inv.close * b.close - 1) < 1e-12 && inv.high === 1 / b.low && inv.low === 1 / b.high && inv.low <= inv.open && inv.high >= inv.close);
  assert.deepEqual(scale(b, 2).close, b.close * 2);
  const r = rollup(coarse, 86400);
  assert.equal(r.reduce((a, x) => a + x.n, 0), coarse.reduce((a, x) => a + x.n, 0), 'a roll-up keeps every trade');
  assert.ok(Math.abs(r.reduce((a, x) => a + x.vol, 0) - coarse.reduce((a, x) => a + x.vol, 0)) < 1e-9);
  for (const day of r) {
    const inside = coarse.filter((x) => x.t >= day.t && x.t < day.t + 86400);
    assert.equal(day.open, inside[0].open); assert.equal(day.close, inside.at(-1).close);
    assert.equal(day.high, Math.max(...inside.map((x) => x.high))); assert.equal(day.low, Math.min(...inside.map((x) => x.low)));
  }
  assert.equal(rollup([{ t: 0, open: 1, high: 2, low: 0, close: 2, vol: 1, n: 1 }, { t: 300, open: 2, high: 3, low: 1.5, close: 3, vol: 1, n: 1 }], 3600)[0].low, 1.5, 'a zero low (an underflowed price) never pins a roll-up');
  const hour = chartBars({ fine, coarse }, 3600);
  assert.ok(hour.length > 0 && hour.every((x) => x.t % 3600 === 0) && hour.length <= fine.length);
  assert.deepEqual(chartBars({ fine, coarse }, 450), [], 'a period that is not a whole number of 5-minute bars has no chart');
  const four = chartBars({ fine, coarse }, TAPE_COARSE), lastCoarseEnd = coarse.at(-1).t + TAPE_COARSE;
  assert.ok(four.length >= coarse.length - 0, 'the 4-hour chart is the 4-hour tape');
  assert.equal(four.at(-1).t, Math.floor(fine.at(-1).t / TAPE_COARSE) * TAPE_COARSE);
  if (fine.at(-1).t >= lastCoarseEnd) assert.ok(four.at(-1).t >= lastCoarseEnd, 'the live edge is covered by the 5-minute bars the 4-hour tape has not folded yet');
  ok('inversion, roll-ups (every trade kept, open/close/extremes right) and the merge of the two tapes at the live edge');
}

// ── candles of a pool: each opens where the one before closed ──
{
  const c = continuous(coarse);
  assert.equal(c.length, coarse.length);
  assert.deepEqual(c[0], coarse[0], 'the first bar keeps its own open');
  for (let i = 1; i < c.length; i++) {
    const b = c[i], was = coarse[i];
    assert.equal(b.open, coarse[i - 1].close, 'each bar opens at the close before it');
    assert.ok(b.close === was.close && b.vol === was.vol && b.n === was.n && b.t === was.t, 'its close, volume, trades and time are its own');
    assert.ok(b.high >= Math.max(was.high, b.open) && b.low <= Math.min(was.low, b.open) && b.low > 0, 'its high and low take in the open');
  }
  const gaps = coarse.filter((b, i) => i && b.open !== coarse[i - 1].close).length;
  assert.ok(gaps > 10, `the tape's own opens leave gaps between candles (${gaps}), which the continuous candles close`);
  assert.deepEqual(continuous([]), []);
  ok(`continuous candles from the real tape: each opens at the close before it (closing ${gaps} gaps), the rest of each bar its own`);
}

// ── the order book's staircase ──
{
  const steps = cumulative([{ price: 0.2, size: 10 }, { price: 0.1, size: 5 }, { price: 0.2, size: 5 }, { price: 0.3, size: 1 }, { price: 0, size: 9 }], 'ask');
  assert.deepEqual(steps.map((x) => [x.price, x.size, x.cum, x.orders.length]), [[0.1, 5, 5, 1], [0.2, 15, 20, 2], [0.3, 1, 21, 1]], 'asks from the cheapest, one step a price, a zero price left out');
  assert.ok(Math.abs(steps[1].value - (5 * 0.1 + 15 * 0.2)) < 1e-12 && Math.abs(steps[2].value / steps[2].cum - (0.5 + 3 + 0.3) / 21) < 1e-12, 'each step carries what every order up to it comes to, so its average price');
  assert.deepEqual(cumulative([{ price: 0.1, size: 1 }, { price: 0.3, size: 2 }], 'bid').map((x) => x.price), [0.3, 0.1], 'bids from the dearest');
  ok('the order book as a staircase: sizes and values added up from the best price outward');
}

// ── the Bitcoin lane ──
{
  const T = (price_sats, amount, ts) => ({ price_sats, amount: String(amount), ts, fill_count: 1 });
  const trades = [T(20000, 10000000000, 1000090), T(15000, 10000000000, 1000050), T(900000, 100000000, 1000040), T(14000, 10000000000, 1000000), T(15500, 10000000000, 999000)];
  const pts = tradePrices(trades);
  assert.deepEqual(pts.map((x) => x.price), [155, 140, 150, 200].map((x) => x), 'sats per TAC (price_sats × 1e8 / amount), oldest first, the off-market fill dropped');
  const c = candlesFromTrades(trades, 600);
  assert.equal(c.length, 2); assert.equal(c[1].open, 140); assert.equal(c[1].close, 200); assert.equal(c[1].high, 200); assert.equal(c[1].low, 140); assert.equal(c[1].n, 3); assert.equal(c[1].vol, 300);
  assert.equal(candlesFromTrades([], 3600).length, 0); assert.equal(tradePrices([T(0, 5, 1), T(5, 0, 2), T(5, 5, 'x')]).length, 0);
  ok('trades into sats-per-TAC candles; fills far from the median, zero and malformed trades are left out');
}

// ── comparing the lanes ──
{
  const ethBar = { t: 0, open: 13300, high: 13500, low: 13200, close: 13400, vol: 1, n: 1 };
  const eth = ethLaneUsd(ethBar, 2549), btc = btcLaneUsd({ t: 0, open: 150, high: 160, low: 140, close: 150, vol: 1, n: 1 }, 83438);
  assert.ok(Math.abs(eth.close - 2549 / 13400) < 1e-12 && eth.high >= eth.low, 'ETH lane: dollars per TAC = ETH/USD ÷ TAC per ETH');
  assert.ok(Math.abs(btc.close - 150 * 83438 / 1e8) < 1e-12, 'Bitcoin lane: dollars per TAC = sats × BTC/USD ÷ 1e8');
  assert.ok(Math.abs(gap(eth.close, btc.close) - (btc.close / eth.close - 1)) < 1e-12 && gap(0, 1) === null);
  const bars = [{ t: 100, close: 1 }, { t: 200, close: 2 }, { t: 300, close: 3 }];
  assert.equal(closeAt(bars, 250), 2); assert.equal(closeAt(bars, 300), 3); assert.equal(closeAt(bars, 50), null); assert.equal(closeAt(bars, 9999), 3);
  ok('both lanes in dollars at today\'s rates, the gap between them, and the last close at a time');
}

// ── volume over a window ──
{
  const bar = (t, vol) => ({ t, open: 1, high: 1, low: 1, close: 1, vol, n: 1 });
  const coarse = [bar(0, 4), bar(14400, 8), bar(28800, 12)], fine = [bar(26100, 1), bar(26400, 2), bar(29100, 3)];
  const want = (4400 / 14400) * 4 + (11700 / 14400) * 8 + 1 + 2 + 3;     // the first buckets by their share of the window, then the 5-minute bars; the last bucket is what the 5-minute bars already hold
  assert.ok(Math.abs(volumeSince({ coarse, fine }, 10000, 30000) - want) < 1e-9, 'a bucket that began before the window counts for its share, and nothing is counted twice');
  assert.equal(volumeSince({ coarse, fine: [] }, 0, 28800), 12, 'with no 5-minute bars the whole 4-hour buckets in the window are added');
  assert.equal(volumeSince({ coarse: [], fine: [] }, 0, 100), 0);
  // an empty 5-minute bucket is not in the tape: one trade late in a 4-hour bucket is counted once, not again by the share of the bucket before it
  assert.equal(volumeSince({ coarse: [bar(0, 1)], fine: [bar(10800, 1)] }, 0, 11400, 0), 1, 'the 5-minute tape is told where it starts');
  assert.equal(volumeSince({ coarse: [bar(0, 1)], fine: [bar(10800, 1)] }, 0, 11400), 1.75, 'without it, the first bar read stands for the start (as before)');
  ok('volume over a window: the 5-minute bars, then the 4-hour ones by their share, with no bar counted twice');
}

console.log(`\n${n} trade-tape checks passed`);
