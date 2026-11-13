// worker/src/stats-views.js: the tETH page's slim reading is the whole reading's `eth` object, less what the page does not read, and nothing else of its weight.
import assert from 'node:assert/strict';
import { ethStatsBody, pageStatsBody, bucketSeries, PAGE_BUCKETS } from '../worker/src/stats-views.js';

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ', m); };

const whole = { at: 1760000000, block: 23600000, eth: { inWei: { $n: '20000000000000000000' }, held: { $n: '10090000000000000000' }, outWei: { $n: '9910000000000000000' }, deposits: 238, lastAt: 1759990000, wallets: 65, unread: 0,
  series: { ins: [[2, { $n: '9' }]], flows: [[1, { $n: '5' }], [2, { $n: '-3' }]] } },
  dev: [{ series: { ins: new Array(500).fill([1, 2, 3]) } }], link: { times: { a: [1] } }, tac: {}, btc: {}, pts: {} };
const slim = JSON.parse(ethStatsBody(JSON.stringify(whole)));
const { series: _s, ...totals } = whole.eth;
ok(JSON.stringify({ ...slim.eth, series: undefined }) === JSON.stringify({ ...totals, series: undefined }), 'the pool\'s totals are carried as they are, in the same order');
ok(Object.keys(slim.eth.series).join() === 'flows' && JSON.stringify(slim.eth.series.flows) === '[[1,"5"],[2,"-3"]]', 'its movements are carried in order, each amount a plain decimal string; the per-deposit series is left out');
// the tETH page's reading of an amount (dapp/teth/read.js big()) takes either form
const big = (x) => BigInt(x != null && typeof x === 'object' && '$n' in x ? x.$n : x ?? 0);
ok(slim.eth.series.flows.every(([t, v], i) => t === whole.eth.series.flows[i][0] && big(v) === big(whole.eth.series.flows[i][1])), 'and each reads back to the same time and amount');
ok(JSON.stringify(JSON.parse(ethStatsBody(JSON.stringify({ at: 1, eth: { held: { $n: '1' }, deposits: 0 } }))).eth) === '{"held":{"$n":"1"},"deposits":0}', 'a pool reading with no series is carried as it is');
ok(slim.at === whole.at && slim.block === whole.block, 'with the time and block of the reading');
ok(Object.keys(slim).sort().join() === 'at,block,eth', 'and nothing else');
ok(ethStatsBody(JSON.stringify(whole)).length < JSON.stringify(whole).length / 4, 'it is a fraction of the whole reading');
ok(JSON.parse(ethStatsBody('{"at":5}')).eth === null, 'a reading with no pool part gives null, not a missing key the page would misread');
assert.throws(() => ethStatsBody('not json'), 'a body that is not JSON throws (the handler then serves the whole reading)'); n++; console.log('  ok   a body that is not JSON throws, so the handler falls back to the whole reading');

// ── the stats page's view: the device pools' series gathered into buckets that keep the sums, the counts and the days ──
{
  const D = 1790000000 - (1790000000 % 86400);                                   // a UTC midnight
  const amt = (v) => ({ $n: String(v) });
  const ins = [], flows = [];
  for (let i = 0; i < 20000; i++) { const t = D + 3600 + i * 97; ins.push([t, amt(1000 + i)]); flows.push([t, amt(i % 3 === 0 ? -(500 + i) : 700 + i)]); }
  const v1 = { held: amt(5), deposits: 2, series: { ins: [[D + 5, amt(1)], [D + 90000, amt(2)]], flows: [[D + 5, amt(1)]] } };
  const dev = [{ chain: 8453, nd: 20000, series: { ins, flows } }, { chain: 1, nd: 0, series: { ins: [], flows: [] } }, null];
  const at = (D + 3600 + 20000 * 97 + 600) * 1000;
  const whole = { at, eth: v1, dev, link: { times: { settles: [1, 2] } }, tac: { supply: amt(7) } };
  const page = JSON.parse(pageStatsBody(JSON.stringify(whole)));
  const sum = (xs) => xs.reduce((a, e) => a + BigInt(e[1].$n), 0n);
  ok(sum(page.dev[0].series.ins) === sum(ins) && sum(page.dev[0].series.flows) === sum(flows), 'the amounts of a pool\'s deposits and of its movements add up to what they were');
  ok(page.dev[0].series.ins.reduce((a, e) => a + e[2], 0) === 20000, 'a deposit bucket says how many deposits it holds, and they all are counted');
  ok(page.dev[0].series.ins.length < 20000 / 5 && JSON.stringify(page).length < JSON.stringify(whole).length / 4, 'the pool\'s series are a fraction of their size');
  ok(page.dev[0].series.ins.length <= PAGE_BUCKETS && page.dev[0].series.flows.length <= PAGE_BUCKETS, 'and at most the bucket count the chart is given');
  ok(JSON.stringify(page.eth) === JSON.stringify(v1) && JSON.stringify(page.link) === JSON.stringify(whole.link) && JSON.stringify(page.tac) === JSON.stringify(whole.tac), 'the V1 pool\'s reading, the link and the TAC part are carried as they are');
  ok(page.dev[0].nd === 20000 && page.dev[0].chain === 8453 && page.dev[2] === null && page.dev[1].series.ins.length === 0, 'so are a pool\'s totals, and a pool that was not read stays unread');
  const day = (t) => Math.floor(t / 86400), dayCount = (xs) => { const m = new Map(); for (const e of xs) m.set(day(e[0]), (m.get(day(e[0])) || 0) + (e[2] ?? 1)); return m; };
  const a = dayCount(ins), b = dayCount(page.dev[0].series.ins);
  ok([...a].every(([d, c]) => b.get(d) === c) && a.size === b.size, 'the deposits of each day are the deposits of that day: no bucket holds two days');
  ok(page.dev[0].series.ins.every((e, i, xs) => !i || xs[i - 1][0] < e[0]), 'buckets are in time order');
  ok(bucketSeries([[5, amt(3)], [7, amt(-3)], [2000, amt(4)]], 900).length === 1, 'a bucket whose movements cancel is left out (a flow of nothing draws nothing)');
  ok(bucketSeries([[5, amt(3)], [7, amt(-3)], [2000, amt(4)]], 900, { counted: true }).length === 2, 'but a deposit bucket is kept: its deposits are counted');
  ok(bucketSeries([[null, amt(3)], [10, amt(1)]], 900).length === 1, 'an event with no time is left out, as the page leaves it out');
  ok(pageStatsBody('{"at":5}') === '{"at":5}' && pageStatsBody(JSON.stringify({ at: 1, dev: [] })) === JSON.stringify({ at: 1, dev: [] }), 'a reading with no pool series is returned as it is');
  assert.throws(() => pageStatsBody('nope')); n++; console.log('  ok   a body that is not JSON throws');
}
console.log(`${n} stats-views checks passed`);
