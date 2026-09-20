// The cTAC reference price, from the public trade record.
//
//   node tools/tac-price-reference.mjs [--api https://api.tacit.finance] [--asset <assetId>]
//
// The relay's fee gate needs a price for cTAC (TAC_PRICE_SATS in worker/src/index.js). There is no reliable
// on-chain oracle for it — the pool is thin and a thin pool is manipulable — so it is anchored on what has
// actually traded on the Bitcoin-side orderbook.
//
// The anchor is the VOLUME-WEIGHTED AVERAGE OVER THE WHOLE RECORD, on purpose. Volume weighting stops a few
// dust trades setting the price, and using the whole record rather than a recent window stops a quiet spell
// from doing it: TAC has been waiting on a relaunch, so a low recent VWAP reflects that lull rather than what
// TAC is worth. The windows are printed so the trend is visible, but they inform the judgement; they are not
// the number.
//
// Reads only the public per-asset route, which needs ?network=mainnet (it defaults to signet without it).
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const API = arg('--api', 'https://api.tacit.finance').replace(/\/$/, '');
const TAC = arg('--asset', 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b');

const res = await fetch(`${API}/assets/${TAC}?network=mainnet`);
if (!res.ok) { console.error(`${res.status} from ${API}`); process.exit(1); }
const d = await res.json();
if (d.trades_truncated) console.error('warning: the trade list is truncated — the average covers only the newest trades');

// `price_sats` is the trade's TOTAL in sats and `amount` is base units (8 decimals), so a per-TAC price is
// price_sats / (amount / 1e8). Checked against mark_price on the last trade.
const t = (d.trades || []).map((x) => ({ sats: x.price_sats, tac: Number(x.amount) / 1e8, ts: x.ts })).filter((x) => x.tac > 0);
if (!t.length) { console.error('no trades'); process.exit(1); }
const vwap = (a) => a.reduce((s, x) => s + x.sats, 0) / a.reduce((s, x) => s + x.tac, 0);
const tac = (a) => a.reduce((s, x) => s + x.tac, 0);
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const ts = t.map((x) => x.ts);

console.log(`\n${t.length} trades, ${day(Math.min(...ts))} -> ${day(Math.max(...ts))}   ${tac(t).toFixed(0)} TAC for ${(t.reduce((s, x) => s + x.sats, 0) / 1e8).toFixed(4)} BTC`);
console.log(`\n  REFERENCE (volume-weighted, whole record)   ${vwap(t).toFixed(1)} sats/TAC\n`);
console.log(`  last fill (mark_price)                      ${d.mark_price ? Number(d.mark_price.unit).toFixed(1) : '-'}`);

const byMonth = {};
for (const x of t) (byMonth[new Date(x.ts * 1000).toISOString().slice(0, 7)] ||= []).push(x);
console.log('\n  month     trades      TAC   VWAP');
for (const m of Object.keys(byMonth).sort()) console.log(`  ${m}  ${String(byMonth[m].length).padStart(6)}  ${tac(byMonth[m]).toFixed(0).padStart(7)}  ${vwap(byMonth[m]).toFixed(1).padStart(6)}`);
console.log('\nSet TAC_PRICE_SATS (env) or TAC_PRICE_SATS_DEFAULT in worker/src/index.js from the reference line.\n');
