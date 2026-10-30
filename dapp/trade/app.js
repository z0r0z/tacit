if (/^\/trade\/(index\.html)?$/.test(location.pathname)) history.replaceState(null, '', `/trade/tac/${location.search}${location.hash}`);
import { keccak_256 } from '/vendor/tacit-deps.min.js';
import {
  makeEvmTradeVenues, zswapDeepLink, encErc20Approve, PRECISION_POOL, TAC_ERC20, TACIT_AMM, MULTICALL3, CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID, _internal,
} from '/evm-trade-venues.js?cb=5a940508';
import { getConfidentialDeployment } from '/confidential-deployments.js';
import { buildBook, planBuy, planSell as planBtcSell, ladderLevels } from '/btc-book.js?cb=0a09ab9e';
import { decodeTape, chartBars, continuous, invert, ethLaneUsd, btcLaneUsd, candlesFromTrades, tradePrices, closeAt, volumeSince, gap, TAPE_FINE, TAPE_COARSE } from '/trade/tape.js?cb=a4aefafb';
import { mountChart, fmtLocalStamp, fmtLocalTime } from '/trade/chart.js?cb=04207026';
import { mountDepth } from '/trade/depth.js?cb=438b534c';
import { readBook, planBuy as planBoardBuy, planSell as planBoardSell, refine as refineBoards, buildFill as buildBoardFill, BOARD_NAMES } from '/zboards.js?cb=e8d21aec';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=de979716';
import { takeEarly } from '/trade/rpc.js?cb=63f04503';
import { mountFarm } from '/trade/farm.js?cb=e3f70b9d';
import { grp, sig, group, satsFmt, day as dayFmt, warm as warmFormatters } from '/trade/fmt.js?cb=32b1744b';
import { makePointsNote } from '/points-note.js?cb=dc44d257';

const API = 'https://api.tacit.finance';
const TAC_BTC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://mainnet.gateway.tenderly.co'];
const CHAINLINK = { ethUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btcUsd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
const ZSWAP_HOST = 'https://zswap.wei.limo';
const SCAN = 'https://etherscan.io/address/';
const E10 = 10n ** 10n, E18 = 10n ** 18n;
const ORANGE = '#f7931a', ETHBLUE = '#627eea', GREEN = '#16a34a';

const $ = (s, r = document) => r.querySelector(s);
const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? String(vals[i] ?? '') : ''), '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const now = () => Math.floor(Date.now() / 1000);

const rpc = (method, params) => takeEarly(RPCS, method, params);
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block]);
const batch = async (calls) => _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(calls)), calls.length);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
const api = (path) => fetch(`${API}${path}`, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const PN = makePointsNote({ read: () => api('/leaderboard?day=today&limit=1') });
PN.load().then(() => { if (S.quote && !S.quote.busy) renderQuote(S.quote); });

function privatePoolId(fee) {
  const hexBytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));
  const [lo, hi] = BigInt(CETH_POOL_ASSET_ID) <= BigInt(TAC_POOL_ASSET_ID) ? [CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID] : [TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID];
  const b = new Uint8Array(96); b.set(hexBytes(lo), 0); b.set(hexBytes(hi), 32); b.set(hexBytes(word(fee)), 64);
  return Array.from(keccak_256(b), (x) => x.toString(16).padStart(2, '0')).join('');
}
const PRIV_TIERS = [30, 5, 100, 1];

const D = { gasPrice: null, chainFailed: false, tapeFailed: false, btcFailed: false, bookFailed: false, ethUsd: null, btcUsd: null, perEth: null, priv: null, precision: null, ethSupply: null, btc: null, book: null, bidsRead: false, zb: null, zbFailed: false, tape: { fine: [], coarse: [] }, readAt: 0 };
const ME = { pub: null, how: '', pageKey: null };
const S = { side: 'buy', amt: '', book: null, pin: null, lane: 'eth', unit: 'usd', range: null, log: false, slip: 50, bal: null, busy: false, tf: { eth: null, btc: null }, kind: 'line', quote: null, seq: 0, zq: null };
const TF = { eth: [['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['1d', 86400]], btc: [['1h', 3600], ['4h', 14400], ['1d', 86400], ['1w', 604800]] };
const CHART_KEY = 'tacit-trade-chart-v1';
try {
  const v = JSON.parse(localStorage.getItem(CHART_KEY) || 'null') || {}, size = (l, p) => (p == null || TF[l].some(([, x]) => x === p) ? p : null);
  if (['eth', 'btc', 'cmp'].includes(v.lane)) S.lane = v.lane;
  if ([null, 0, 1, 7, 30, 90].includes(v.range)) S.range = v.range;
  if (['line', 'candles'].includes(v.kind)) S.kind = v.kind;
  if (['usd', 'native'].includes(v.unit)) S.unit = v.unit;
  if (typeof v.log === 'boolean') S.log = v.log;
  if (v.tf) S.tf = { eth: size('eth', v.tf.eth), btc: size('btc', v.tf.btc) };
} catch { }
const keepChart = () => { try { localStorage.setItem(CHART_KEY, JSON.stringify({ lane: S.lane, range: S.range, kind: S.kind, unit: S.unit, log: S.log, tf: S.tf })); } catch { } };

async function loadChain() {
  try { await readChain(); D.chainFailed = D.perEth == null; } catch (e) { D.chainFailed = true; throw e; } finally { D.chainDone = true; }
}
async function readChain() {
  const pool = getConfidentialDeployment('mainnet')?.pool;
  const calls = [
    { to: PRECISION_POOL, data: '0x2af1f249' },
    { to: CHAINLINK.ethUsd, data: '0xfeaf968c' }, { to: CHAINLINK.btcUsd, data: '0xfeaf968c' },
    { to: PRECISION_POOL, data: '0x443cb4bc' }, { to: PRECISION_POOL, data: '0x5a76f25e' }, { to: TAC_ERC20, data: '0x18160ddd' },
    ...PRIV_TIERS.map((fee) => ({ to: pool || TAC_ERC20, data: '0xb5217bb4' + privatePoolId(fee) })),
    { to: MULTICALL3, data: '0x0f28c97d' },
  ];
  gasPrice().catch(() => {});
  const r = await batch(calls), P = 6;
  const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);
  D.ethUsd = fresh(r[1]); D.btcUsd = fresh(r[2]);
  const ct = r[P + PRIV_TIERS.length]; if (ct) { D.chainT = Number(wordAt(ct, 0)); D.chainAt = now(); }
  if (r[0]) { const root = Number(wordAt(r[0], 0)) / 1e18; D.perEth = root > 0 ? root * root : null; }
  if (r[3] && r[4]) D.precision = { eth: wordAt(r[3], 0), tac: wordAt(r[4], 0) };
  if (r[5]) D.ethSupply = wordAt(r[5], 0);
  D.priv = null;
  if (pool) for (const [i, fee] of PRIV_TIERS.entries()) {
    const x = r[P + i];
    if (x && strip(x).length >= 64 * 7 && wordAt(x, 0) !== 0n && wordAt(x, 3) > 0n && wordAt(x, 4) > 0n) { D.priv = { fee, rEth: wordAt(x, 3), rTac: wordAt(x, 4), price: Number(wordAt(x, 3)) / Number(wordAt(x, 4)) }; break; }
  }
}

const KEPT = 'tacit-trade-tape-v1';
function keptTape() { try { const v = JSON.parse(localStorage.getItem(KEPT) || 'null'); return v?.v === 1 && v.pool === PRECISION_POOL && Array.isArray(v.coarse) ? v.coarse.filter((b) => b && Number.isFinite(b.t) && b.t % TAPE_COARSE === 0) : []; } catch { return []; } }
let keptSig = '';
function keepTape(coarse) { const sig = `${coarse.length}:${coarse.at(-1)?.t}:${coarse.at(-1)?.close}`; if (sig === keptSig) return; keptSig = sig; try { localStorage.setItem(KEPT, JSON.stringify({ v: 1, pool: PRECISION_POOL, coarse: coarse.slice(-1500) })); } catch { } }
async function loadTapes(o = {}) {
  try { await readTapes(o); D.tapeFailed = false; } catch (e) { D.tapeFailed = true; throw e; }
}
async function readTapes({ coarse: wantCoarse = true } = {}) {
  const sel = '0x29a65241';
  const words = (r) => { const h = strip(r), n = Number(wordAt(h, 1)); return Array.from({ length: n }, (_, i) => '0x' + h.slice(128 + i * 64, 192 + i * 64)); };
  const [c, f] = await Promise.all([wantCoarse || !D.tape.coarse.length ? ethCall(PRECISION_POOL, sel + word(TAPE_COARSE) + word(256)) : null, ethCall(PRECISION_POOL, sel + word(TAPE_FINE) + word(256))]);
  const fine = decodeTape(words(f), TAPE_FINE);
  if (c) {
    const merged = new Map(keptTape().map((b) => [b.t, b]));
    for (const b of decodeTape(words(c), TAPE_COARSE)) merged.set(b.t, b);
    D.tape = { coarse: [...merged.values()].sort((a, b) => a.t - b.t), fine };
    keepTape(D.tape.coarse);
  } else D.tape = { coarse: D.tape.coarse, fine };
}

async function loadBitcoin({ lists = true } = {}) {
  const [asset, sales, bidRows] = await Promise.all([api(`/assets/${TAC_BTC_ID}?network=mainnet`), lists ? api(`/assets/${TAC_BTC_ID}/preauth-sales?network=mainnet&view=book`) : null, lists ? api(`/assets/${TAC_BTC_ID}/bid-intents?network=mainnet`) : null]);
  if (asset) D.btc = { trades: asset.trades || [], mark: Number(asset.mark_price?.unit) || null, last: asset.last_trade || null, change24: asset.price_24h_change_pct, vol24: Number(asset.volume_24h_sats) || 0, holders: asset.holder_count ?? null, firstTrade: asset.price_first_trade_ts || null, tradesCap: asset.trades_cap };
  D.btcFailed = !asset && !D.btc; D.bookFailed = lists && !Array.isArray(sales?.sales) && !D.book;
  if (asset && D.book) { D.btc.ask = D.book.bestAsk; D.btc.bid = D.book.bestBid; }
  if (Array.isArray(sales?.sales)) {
    D.bidsRead = Array.isArray(bidRows?.intents);
    D.raw = { listings: sales.sales.map((x) => ({ ...x, kind: 'preauth' })), bids: D.bidsRead ? bidRows.intents : [] };
    D.btc ||= { trades: [], mark: null };
    rebuildBook();
  }
}
function rebuildBook() {
  if (!D.raw) return;
  D.book = buildBook({ assetId: TAC_BTC_ID, decimals: 8, ...D.raw, myPubHex: ME.pub });
  if (D.btc) { D.btc.ask = D.book.bestAsk; D.btc.bid = D.book.bestBid; }
}

const BOARD_CALLS = 8;
let boardRetries = 0, boardSeq = 0, boardApplied = 0;
async function loadBoards() {
  const my = ++boardSeq, b = await readBook({ ethCall, base: TAC_ERC20, now: now() });
  if (b.answered > 0 && my > boardApplied && (!D.zb || b.answered >= D.zb.answered)) { D.zb = b; boardApplied = my; }
  D.zbFailed = !D.zb;
  if (b.answered === 0 && boardRetries++ < 3) setTimeout(() => loadBoards().then(paintAll).catch(() => {}), 4000); else if (b.answered > 0) boardRetries = 0;
  if (S.pin && !pinnedOrder()) { S.pin = null; renderPin(); if (S.quote && !S.busy) requote(true); }
}

const retryBtn = () => `<button class="linkbtn" type="button" data-retry${D.retrying ? ' disabled' : ''}>${D.retrying ? 'Trying…' : 'Try again'}</button>`;
const usd = (x) => (x == null || !Number.isFinite(x) ? '—' : x >= 1000 ? `$${grp(x, 0)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toPrecision(3)}`);
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(Math.abs(x) >= 0.095 ? 0 : d)}%`);
function fmtUnits(v, dec = 18, max = 4) {
  let n = BigInt(v), neg = n < 0n; if (neg) n = -n;
  const base = 10n ** BigInt(dec), frac = (n % base).toString().padStart(dec, '0').slice(0, max).replace(/0+$/, '');
  return `${neg ? '−' : ''}${group(n / base)}${frac ? `.${frac}` : ''}`;
}
const fmtOut = (v, buy) => { const n = BigInt(v); return n > 0n && n < 10n ** BigInt(buy ? 16 : 12) ? `under ${buy ? '0.01' : '0.000001'}` : fmtUnits(n, 18, buy ? 2 : 6); };
function parseUnits(text, dec = 18) {
  let t = String(text ?? '').trim().replace(/[_\s]/g, '');
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  if (f.length > dec) return null;
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
const priceEth = () => (D.perEth ? 1 / D.perEth : null);
const usdOf = (eth) => (eth != null && D.ethUsd ? eth * D.ethUsd : null);
const btcUsdPerTac = () => (D.btc?.mark && D.btcUsd ? (D.btc.mark * D.btcUsd) / 1e8 : null);
const laneGap = (other) => { const base = usdOf(priceEth()); return base && other ? gap(base, other) : null; };
const gapClass = (g) => (g == null ? '' : Math.abs(g) < 0.01 ? 'mute' : g > 0 ? 'up' : 'down');
const chainDeadline = (s) => BigInt((D.chainT ? D.chainT + (now() - D.chainAt) : now()) + s);
const tacitEth = () => D.priv?.price ?? null;

const ethAt = (t) => { const f = D.tape.fine; return f.length && t >= f[0].t ? closeAt(f, t) : closeAt(D.tape.coarse, t); };
const priceAgo = (secs) => ethAt(now() - secs);
const compact = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : usd(x));
// The last price read is shown at once on the next visit, dimmed until a fresh read replaces it, so the number is there at first paint.
const PX_KEY = 'tacit-trade-px-v1';
let keptPx = '';
function keepPx(text) { if (text === keptPx) return; keptPx = text; try { localStorage.setItem(PX_KEY, JSON.stringify({ s: text, t: now() })); } catch { } }
function paintKeptPx() {
  try {
    const k = JSON.parse(localStorage.getItem(PX_KEY) || 'null'), el = $('#px-usd');
    if (el && k && typeof k.s === 'string' && /^\$[0-9.,]{1,12}$/.test(k.s) && now() - k.t < 86400 && el.textContent === 'TAC') { el.textContent = k.s; el.classList.add('stale'); keptPx = k.s; }
  } catch { }
}
paintKeptPx();
function renderHead() {
  const eth = priceEth(), px = usdOf(eth);
  $('#px-usd').textContent = px != null ? usd(px) : eth != null ? `${sig(eth)} ETH` : 'TAC';
  if (px != null) { $('#px-usd').classList.remove('stale'); keepPx(usd(px)); }
  document.title = px != null ? `TAC ${usd(px)} · tacit trade` : 'tacit trade · TAC';
  const vol = volumeSince(D.tape, now() - 86400, now());
  const bits = [], stats = [], st = (k, v, title = '') => stats.push(html`<span class="st"${title ? ` title="${esc(title)}"` : ''}><i>${k}</i> <b class="num">${v}</b></span>`);
  const changes = [['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800]].map(([l, s]) => { const then = priceAgo(s); return then && D.perEth ? [l, then / D.perEth - 1] : null; }).filter(Boolean);
  if (changes.length) bits.push(`<span class="chgs">${changes.map(([l, c]) => `<span class="chg ${c >= 0.0005 ? 'up' : c <= -0.0005 ? 'down' : 'mute'}"><i>${l}</i> ${esc(pct(c))}</span>`).join(' ')}</span>`);
  if (eth != null) st('1 TAC =', `${sig(eth)} ETH`, 'At the Precision pool');
  if (D.tape.coarse.length) st('24h volume', vol >= 0.01 ? `${grp(vol, vol < 10 ? 2 : 0)} ETH` : 'under 0.01 ETH', `Swaps in the Precision pool over the last 24 hours${D.btc?.vol24 ? `. The Bitcoin order book traded ${grp(D.btc.vol24, 0)} sats` : ''}`);
  if (D.precision && D.ethUsd) st('Liquidity', compact(2 * Number(D.precision.eth) / 1e18 * D.ethUsd), 'Both sides of the Precision pool, in dollars');
  if (px != null) st('FDV', compact(21e6 * px), 'Fully diluted value: all 21,000,000 TAC at this price');
  if (stats.length) bits.push(`<span class="stats">${stats.join(' ')}</span>`);
  setHtml($('#px-sub'), bits.length ? bits.join('') : D.chainFailed ? `<span class="mute">Could not read the pools. ${retryBtn()}</span>` : '<span class="mute">Reading the pools…</span>');
  const ask = D.btc?.ask && D.btcUsd ? (D.btc.ask * D.btcUsd) / 1e8 : null, gl = laneGap(btcUsdPerTac()), ga = laneGap(ask);
  const side = (v) => (Math.abs(v) < 0.01 ? 0 : Math.sign(v));
  const rel = (v) => (side(v) === 0 ? 'level with' : html`<b>${Math.round(Math.abs(v) * 100)}% ${v > 0 ? 'above' : 'below'}</b>`);
  const lastTxt = gl != null ? `the last trade was ${rel(gl)} Ethereum’s price` : '', askTxt = ga != null ? `the cheapest ask is ${rel(ga)} ${lastTxt ? 'it' : 'Ethereum’s price'}` : '';
  setHtml($('#gapnote'), lastTxt || askTxt ? `On Bitcoin, ${lastTxt}${lastTxt && askTxt ? (side(gl) === side(ga) ? ', and ' : ', but ') : ''}${askTxt}.` : '');
}
const CM_ETH = '<svg class="tk xs inl" aria-hidden="true"><use href="#c-eth"/></svg>', CM_BTC = '<svg class="tk xs inl" aria-hidden="true"><use href="#c-btc"/></svg>';
function renderLanes() {
  const base = usdOf(priceEth()), ask = D.btc?.ask ? (D.btc.ask * (D.btcUsd || 0)) / 1e8 : null, cards = [
    { name: 'Precision pool', sw: ETHBLUE, v: base, s: priceEth() != null ? `${sig(priceEth())} ETH` : null, g: 'the reference', gc: 'mute' },
    { name: 'Tacit pool', sw: GREEN, v: usdOf(tacitEth()), s: tacitEth() != null ? `${sig(tacitEth())} ETH` : null, gap: laneGap(usdOf(tacitEth())), dev: true, sub: 'public or private swap' },
    { name: 'Bitcoin · last trade', sw: ORANGE, v: btcUsdPerTac(), s: D.btc?.mark ? `${satsFmt(D.btc.mark)} sats` : null, gap: laneGap(btcUsdPerTac()) },
    { name: 'Bitcoin · cheapest ask', sw: ORANGE, v: ask || null, s: D.btc?.ask ? `${satsFmt(D.btc.ask)} sats` : null, gap: laneGap(ask || null) },
  ];
  const bg = laneGap(btcUsdPerTac());
  setHtml($('#hints-sum'), base != null || btcUsdPerTac() != null
    ? [base != null ? html`<span>${CM_ETH}<span class="nm">Ethereum </span><b>${usd(base)}</b></span>` : '', btcUsdPerTac() != null ? html`<span>${base != null ? '· ' : ''}${CM_BTC}<span class="nm">Bitcoin </span><b>${usd(btcUsdPerTac())}</b></span>` : '', bg != null && Math.abs(bg) >= 0.01 ? html`<span class="apart">· ${Math.round(Math.abs(bg) * 100)}% apart</span>` : ''].join('')
    : 'Prices on each chain');
  setHtml($('#lanes'), cards.map((c) => {
    const g = c.g ?? (c.gap != null ? `${pct(c.gap)} vs Precision${c.dev && Math.abs(c.gap) >= 0.01 ? ' · apart' : ''}` : c.sub || '');
    const loading = c.v == null && c.s == null && !(D.tape.coarse.length || D.btc);
    return html`<div class="lane"><span class="k"><i class="sw" style="background:${c.sw}"></i>${esc(c.name)}</span><span class="v num">${loading ? '<i class="sk"></i>' : usd(c.v)}</span><span class="s num">${c.s ? esc(c.s) : ''}</span><span class="g ${c.gc ?? gapClass(c.gap)}">${esc(g)}</span></div>`;
  }).join(''));
}

const chartHost = $('#chart');
const chart = mountChart(chartHost, (h, rows) => paintRead(h, rows), { onSelect: (w) => { S.sel = w; paintRead(); }, onView: (w) => { S.zoom = w; S.sel = null; paintRead(); } });
function priceFmt(unit, lane) {
  if (unit === 'usd') return (v) => usd(v);
  return lane === 'btc' ? (v) => `${satsFmt(v)} sats` : (v) => `${sig(v)} ETH`;
}
const placesOf = (step) => { for (let d = 0; d < 10; d++) { const x = step * 10 ** d; if (Math.abs(x - Math.round(x)) < 1e-6 * Math.max(1, x)) return d; } return 10; };
function tickFmt(unit, lane) {
  if (unit === 'usd') return (step) => { const d = Math.max(2, placesOf(step)); return (v) => `$${v.toFixed(d)}`; };
  return lane === 'btc' ? (step) => { const d = placesOf(step); return (v) => `${grp(v, d)} sats`; } : (step) => { const d = placesOf(step); return (v) => `${v.toFixed(d)} ETH`; };
}
const inUnit = (lane, unit) => (lane === 'btc' ? (v) => (unit === 'usd' && D.btcUsd ? (v * D.btcUsd) / 1e8 : v) : (v) => (unit === 'usd' ? D.ethUsd / v : 1 / v));
const RANGE_SET = [['1D', 1], ['1W', 7], ['1M', 30], ['3M', 90]];
function spanDays(lane) {
  if (lane === 'btc') { const ts = (D.btc?.trades || []).map((t) => Number(t.ts)).filter(Number.isFinite); return ts.length ? (now() - Math.min(...ts)) / 86400 : 0; }
  const f = D.tape.coarse[0]?.t ?? D.tape.fine[0]?.t;
  return f ? (now() - f) / 86400 : 0;
}
function rangesFor(lane) {
  const span = spanDays(lane === 'cmp' ? 'eth' : lane);
  return [...(span ? RANGE_SET.filter(([, d]) => d < span) : RANGE_SET.slice(0, 3)), ['All', 0]];
}
function effRange(lane) {
  const days = rangesFor(lane).map(([, d]) => d);
  return days.includes(S.range) ? S.range : days.includes(30) ? 30 : 0;
}
const RANGE_WORDS = { 1: 'past day', 7: 'past week', 30: 'past month', 90: 'past 3 months', 0: 'all time' };
function lineTf(lane, r = effRange(lane)) {
  if (lane === 'btc') return r === 1 ? 3600 : r === 7 ? 14400 : 86400;
  const first = D.tape.coarse[0]?.t;
  return r === 1 ? 900 : r === 0 && first && now() - first > 90 * 86400 ? 86400 : TAPE_COARSE;
}
function sizesFor(lane, r = effRange(lane)) {
  const days = r || Math.max(1, spanDays(lane));
  return TF[lane].filter(([, p]) => { const n = (days * 86400) / p; return n >= 8 && n <= 400 && (lane !== 'eth' || p >= TAPE_COARSE || r === 1); });
}
function candleTf(lane) {
  const offered = sizesFor(lane).map(([, p]) => p), line = lineTf(lane);
  if (offered.includes(S.tf[lane])) return S.tf[lane];
  return offered.includes(line) || !offered.length ? line : offered.reduce((a, p) => (Math.abs(Math.log(p / line)) < Math.abs(Math.log(a / line)) ? p : a));
}
const tfFor = (lane) => (lane === 'cmp' ? lineTf('eth', effRange('cmp')) : S.kind === 'candles' ? candleTf(lane) : lineTf(lane));
const sizeName = (tf) => (tf === 604800 ? '1w' : tf % 86400 === 0 ? `${tf / 86400}d` : tf % 3600 === 0 ? `${tf / 3600}h` : `${tf / 60}m`);
function lineBars(bars, tf, since, seed, spot) {
  const from = since ? Math.floor(since / tf) * tf : bars[0]?.t;
  if (from == null || (!bars.length && seed == null)) return bars;
  const end = Math.floor(now() / tf) * tf;
  if ((end - from) / tf > 800) return bars;
  const out = [];
  let i = 0, prev = seed != null ? { close: seed } : null;
  for (let t = from; t <= end; t += tf) {
    while (i < bars.length && bars[i].t < t) i++;
    if (i < bars.length && bars[i].t === t) { prev = bars[i++]; out.push(prev); }
    else if (prev) { const c = prev.close; out.push({ t, open: c, high: c, low: c, close: c, vol: 0, n: 0, held: true }); }
  }
  if (spot > 0 && out.length) { const l = out.at(-1); out[out.length - 1] = { ...l, close: spot, high: Math.max(l.high, spot), low: l.low > 0 ? Math.min(l.low, spot) : spot, live: true }; }
  return out;
}
const effUnit = (lane) => ((lane === 'eth' && !D.ethUsd) || (lane === 'btc' && !D.btcUsd) ? 'native' : S.unit);
function renderControls() {
  const lane = S.lane, native = lane === 'btc' ? 'sats' : 'ETH', seg = (label, attr, opts, cur) => `<div class="seg sm" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  $('#lane-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lane === lane)));
  const r = effRange(lane);
  $('#range-seg').innerHTML = rangesFor(lane).map(([l, d]) => `<button type="button" data-range="${d}" aria-pressed="${r === d}">${l}</button>`).join('');
  const sizes = $('#tf-seg'), showSizes = S.kind === 'candles' && lane !== 'cmp';
  sizes.hidden = !showSizes;
  if (showSizes) { const tf = candleTf(lane); sizes.innerHTML = sizesFor(lane).map(([l, p]) => `<button type="button" data-tf="${p}" aria-pressed="${tf === p}">${l}</button>`).join(''); }
  $('#view-seg').innerHTML = (lane === 'cmp' ? '' : seg('Chart type', 'kind', [['line', 'Line'], ['candles', 'Candles']], S.kind) + seg('Price in', 'unit', [['usd', 'USD'], ['native', native]], effUnit(lane)))
    + `<button type="button" class="tg" data-log="1" aria-pressed="${S.log}" title="A log axis draws equal percentage moves at equal heights">Log</button>`;
  const tk = (id) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${id}"/></svg>`;
  $('#chart-name').textContent = { eth: 'TAC / ETH · Precision pool', btc: 'TAC / BTC · Bitcoin order book', cmp: 'TAC · Ethereum and Bitcoin' }[lane];
  $('#chart-pair').innerHTML = tk('tac') + (lane === 'cmp' ? '' : tk(lane === 'btc' ? 'btc' : 'eth'));
}
const readPx = (v, unit, lane) => (unit === 'usd' ? `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}` : lane === 'btc' ? `${satsFmt(v)} sats` : `${sig(v, 4)} ETH`);
function spanStats(V, w) {
  const { bars, tf, line } = V, inW = bars.filter((b) => b.t + tf > w.t0 && b.t < w.t1);
  if (!inW.length) return null;
  const before = bars.filter((b) => b.t + tf <= w.t0).at(-1), last = inW.at(-1), toEnd = last === bars.at(-1);
  const from = before ? before.close : line ? inW[0].close : inW[0].open, to = toEnd && V.now != null ? V.now : last.close;
  const lows = inW.map((x) => (line || !(x.low > 0) ? x.close : x.low)), highs = inW.map((x) => (line ? x.close : x.high));
  return { from, to, lo: Math.min(...lows, from, to), hi: Math.max(...highs, from, to), vol: inW.reduce((a, x) => a + (x.vol || 0), 0), t0: Math.max(w.t0, bars[0].t), t1: toEnd ? now() : Math.min(w.t1, last.t + tf) };
}
function spanText(t0, t1) {
  const one = fmtLocalTime(t0, true) === fmtLocalTime(t1, true), d = t1 - t0;
  const len = d >= 2 * 86400 ? `${Math.round(d / 86400)} days` : d >= 2 * 3600 ? `${Math.round(d / 3600)} h` : `${Math.max(1, Math.round(d / 60))} min`;
  return `${fmtLocalTime(t0, true)} ${fmtLocalTime(t0)}${one ? ' to ' : ` to ${fmtLocalTime(t1, true)} `}${fmtLocalTime(t1)} · ${len}`;
}
const chgHtml = (chg) => { const up = chg >= 0.0005, down = chg <= -0.0005; return html`<span class="chg ${up ? 'up' : down ? 'down' : 'mute'}">${up ? '▲' : down ? '▼' : ''} ${pct(chg).slice(1)}</span>`; };
function paintRead(h = null, rows = null) {
  const el = $('#ch-read'), V = S.view;
  let out = '';
  if (V?.lane === 'cmp') {
    const at = (id) => rows?.find((r) => r.s.id === id)?.b.close, e = h ? at('eth') : V.ethNow, b = h ? at('btc') : V.btcNow, g = e > 0 && b > 0 ? b / e - 1 : null;
    if (e != null || b != null) out = html`<div class="l"><span class="px num">${g == null ? '—' : esc(pct(g))}</span> <em>${g == null ? '' : 'Bitcoin against Ethereum'} · ${esc(h ? fmtLocalStamp(h.b.t) : 'now')}</em></div> <div class="r"><span>Ethereum <b>${e != null ? readPx(e, 'usd') : '—'}</b></span> <span>Bitcoin <b>${b != null ? readPx(b, 'usd') : '—'}</b></span></div>`;
  } else if (V?.bars.length || V?.now != null) {
    const { bars, unit, lane, line } = V, b = h?.b, U = lane === 'btc' ? 'TAC' : 'ETH';
    const nowPx = V.now ?? bars.at(-1).close, start = V.base ?? bars[0]?.close ?? nowPx;
    const num = (v) => (lane === 'btc' ? grp(v, 0) : v < 10 ? v.toFixed(2) : grp(v, 0)), px = (v) => readPx(v, unit, lane);
    const traded = (x) => (x.vol > 0 ? html`<span><b>${num(x.vol)}</b> ${U} in ${x.n ? `${x.n} trade${x.n === 1 ? '' : 's'}` : 'this bar'}</span>` : html`<span>nothing traded in this bar</span>`);
    const usdVol = (v) => (lane === 'eth' && D.ethUsd && v > 0 ? ` (${compact(v * D.ethUsd)})` : '');
    const summary = (lo, hi, vol) => html`<span>low <b>${px(lo)}</b></span> <span>high <b>${px(hi)}</b></span>${vol > 0 ? html` <span><b>${num(vol)}</b> ${U}${usdVol(vol)} traded</span>` : ''}`;
    const w = S.sel || S.zoom, st = !b && w ? spanStats(V, w) : null;
    if (b) {
      const word = `${fmtLocalStamp(b.t)}${b.held ? ' · no trades, price held' : ''}`;
      const mine = (V.points || []).filter((p) => p.t >= b.t && p.t < b.t + V.tf).map((p) => `you ${p.up ? 'bought' : 'sold'} ${tacFmt(p.tac)} TAC`);
      const right = (line ? traded(b) : html`<span>O <b>${px(b.open)}</b></span> <span>H <b>${px(b.high)}</b></span> <span>L <b>${px(b.low)}</b></span> ${traded(b)}`) + (mine.length ? html` <span class="you">${esc(mine.join(', '))}</span>` : '');
      out = html`<div class="l"><span class="px num">${px(b.close)}</span> ${chgHtml(b.close / (line ? start : b.open) - 1)} <em>${esc(word)}</em></div> <div class="r">${right}</div>`;
    } else if (st) {
      out = html`<div class="l"><span class="px num">${px(st.to)}</span> ${chgHtml(st.to / st.from - 1)} <em>${esc(spanText(st.t0, st.t1))}</em>${S.zoom && !S.sel ? ' <button type="button" class="linkbtn" data-zoomout>Zoom out</button>' : ''}</div> <div class="r">${summary(st.lo, st.hi, st.vol)}</div>`;
    } else {
      const lows = line ? bars.map((x) => x.close) : bars.map((x) => (x.low > 0 ? x.low : x.close)), highs = line ? bars.map((x) => x.close) : bars.map((x) => x.high);
      const word = V.range ? RANGE_WORDS[V.range] : bars.length ? `all time · since ${fmtLocalTime(bars[0].t, true)}` : 'all time';
      out = html`<div class="l"><span class="px num">${px(nowPx)}</span> ${chgHtml(nowPx / start - 1)} <em>${esc(word)}</em></div> <div class="r">${summary(Math.min(...lows, nowPx), Math.max(...highs, nowPx), V.vol)}</div>`;
    }
  }
  if (el.__h !== out) { el.__h = out; el.innerHTML = out; }
}
function chartEmpty(lane) {
  const ethFailed = D.tapeFailed && !D.tape.coarse.length, btcFailed = D.btcFailed && !D.btc;
  return lane === 'eth' && ethFailed ? 'Could not read the price history. Try again in a moment.' : lane === 'btc' && btcFailed ? 'Could not read the Bitcoin trades. Try again in a moment.' : lane === 'cmp' && (ethFailed || btcFailed) ? 'Could not read the price history. Try again in a moment.' : undefined;
}
function renderChart() {
  if (S.unit === 'usd' && !D.chainDone) return;
  const lane = S.lane, tf = tfFor(lane);
  const unit = lane === 'cmp' ? 'usd' : effUnit(lane);
  if (lane === 'cmp' && !(D.ethUsd && D.btcUsd)) {
    chart.update({ series: [], tags: [], period: tf, label: 'TAC price, Ethereum and Bitcoin' });
    $('#legend').innerHTML = ''; $('#chart-note').textContent = D.ethUsd || D.btcUsd ? 'Waiting for the other dollar rate to compare Ethereum and Bitcoin.' : 'Waiting for the dollar rates to compare Ethereum and Bitcoin.';
    S.view = null; paintRead(); renderControls();
    return;
  }
  const range = effRange(lane), since = range ? now() - range * 86400 : 0;
  const cmp = lane === 'cmp', line = cmp || S.kind === 'line';
  const trades = tradePrices(D.btc?.trades || []).map((x) => ({ t: x.t, close: x.price, vol: x.vol }));
  let eth = chartBars(D.tape, tf);
  if (!line) eth = continuous(eth);
  eth = eth.filter((b) => b.t + tf > since);
  if (line && lane !== 'btc') eth = lineBars(eth, tf, since, since ? ethAt(since) : null, D.perEth);
  const btcFrom = cmp && !since ? eth[0]?.t ?? 0 : since;
  let btc = (D.btc ? candlesFromTrades(D.btc.trades, tf) : []).filter((b) => b.t + tf > btcFrom);
  if (line && lane !== 'eth') btc = lineBars(btc, tf, btcFrom, btcFrom ? closeAt(trades, btcFrom) : null, D.btc?.mark || 0);
  const ethBars = eth.map((b) => (unit === 'usd' ? ethLaneUsd(b, D.ethUsd) : invert(b)));
  const btcBars = btc.map((b) => (unit === 'usd' && D.btcUsd ? btcLaneUsd(b, D.btcUsd) : b));
  const series = [], tags = [], legend = [];
  const priv = tacitEth(), deviates = priv != null && priceEth() != null && Math.abs(priv / priceEth() - 1) >= 0.01;
  const ethSpot = unit === 'usd' ? usdOf(priceEth()) : priceEth(), privSpot = unit === 'usd' ? usdOf(priv) : priv;
  const btcSpot = D.btc?.mark ? (unit === 'usd' ? btcUsdPerTac() : D.btc.mark) : null;
  const tagPx = (v, l) => (unit !== 'usd' && l === 'eth' ? sig(v, 3) : readPx(v, unit, l));
  if (lane === 'eth' || cmp) {
    series.push({ id: 'eth', name: 'Precision pool', color: ETHBLUE, kind: line ? 'line' : 'candles', area: !cmp, bars: ethBars, fmt: priceFmt(unit, 'eth'), tickFmt: tickFmt(unit, 'eth'), volFmt: (v) => `${v.toFixed(3)} ETH` });
    if (ethSpot != null) tags.push({ y: ethSpot, label: tagPx(ethSpot, 'eth'), color: ETHBLUE });
    if (deviates && privSpot != null) tags.push({ y: privSpot, label: 'Tacit', color: GREEN });
  }
  if (lane === 'btc' || cmp) {
    series.push({ id: 'btc', name: 'Bitcoin order book', color: ORANGE, kind: line ? 'line' : 'candles', area: !cmp, bars: btcBars, fmt: priceFmt(unit, 'btc'), tickFmt: tickFmt(unit, 'btc'), volFmt: (v) => `${grp(v, 0)} TAC` });
    if (btcSpot != null) tags.push({ y: btcSpot, label: tagPx(btcSpot, 'btc'), color: ORANGE });
  }
  const points = cmp ? [] : myTrades(lane).map((p) => ({ ...p, y: lane === 'btc' ? inUnit('btc', unit)(p.px) : inUnit('eth', unit)(1 / p.px) })).filter((p) => p.y > 0 && p.t + tf > since);
  const names = { eth: 'Precision pool on Ethereum', btc: 'Bitcoin order book', cmp: 'Ethereum and Bitcoin, in dollars' };
  const quiet = !cmp && !series[0].bars.length && (lane === 'btc' ? trades.length : D.tape.coarse.length) ? `No trades ${lane === 'btc' ? 'on the Bitcoin order book' : 'in the Precision pool'} in the ${RANGE_WORDS[range] || 'range'}.` : undefined;
  chart.update({ series, tags, period: tf, log: S.log, minSpan: 0.04, readout: true, zoomable: !cmp, points: points.map(({ t, y, up }) => ({ t, y, up })), label: `TAC price, ${names[lane]}, ${sizeName(tf)} ${line ? 'line' : 'candles'}`, empty: chartEmpty(lane) ?? quiet });
  const base = since ? (lane === 'btc' ? closeAt(trades, since) : ethAt(since)) : null;
  S.view = cmp ? { lane, ethNow: ethSpot, btcNow: btcSpot }
    : { lane, unit, range, line, tf, points, bars: series[0].bars, base: base ? inUnit(lane, unit)(base) : null, now: lane === 'btc' ? btcSpot : ethSpot,
      vol: lane === 'btc' ? trades.filter((x) => x.t >= since).reduce((a, x) => a + x.vol, 0) : volumeSince(D.tape, since || (D.tape.coarse[0]?.t ?? 0), now()) };
  paintRead();
  const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
  if (lane !== 'btc') legend.push(`<span>${sw(ETHBLUE)}Precision pool (Ethereum)${ethSpot != null ? ` · ${priceFmt(unit, 'eth')(ethSpot)}` : ''}</span>`);
  if (lane !== 'eth') legend.push(`<span>${sw(ORANGE)}Bitcoin order book${btcSpot != null ? ` · ${priceFmt(unit, 'btc')(btcSpot)}` : ''}</span>`);
  if (lane !== 'btc' && priv != null) legend.push(`<span>${sw(GREEN)}Tacit pool · ${priceFmt(unit, 'eth')(privSpot)}${deviates ? `, ${pct(priv / priceEth() - 1)} vs Precision` : ', level with Precision'}</span>`);
  $('#legend').innerHTML = lane === 'cmp' ? legend.join('') : points.length ? '<span><b class="up">▲</b><b class="down">▼</b> your purchases and sales</span>' : '';
  const first = D.tape.coarse[0], days = first ? Math.max(1, Math.round((now() - first.t) / 86400)) : 0;
  $('#chart-note').textContent = lane === 'eth'
    ? `Executed prices (fees included) from the Precision pool’s onchain tape. A quiet stretch holds the last price, and the right edge is the price now. Each candle opens where the one before closed. The tape holds a day of 5-minute bars and six weeks of 4-hour bars; this browser keeps what it has read${first ? ` (${days} days so far)` : ''}.`
    : lane === 'btc' ? `Every trade on the Bitcoin order book since ${D.btc?.firstTrade ? dayFmt(D.btc.firstTrade) : 'it began'}${D.btc?.trades?.length ? ` (${D.btc.trades.length} trades)` : ''}; a stretch with no trades holds the price before it.`
    : 'Ethereum and Bitcoin in dollars, at today’s ETH and BTC prices. The figure above is how far Bitcoin sits from Ethereum.';
  if (lane !== 'cmp') $('#chart-note').textContent += ' Drag across the chart to zoom; double-click to zoom out. Your own trades are flagged when a wallet is connected.';
  renderControls();
}

const dirOf = () => (S.side === 'buy' ? 'ETH_TO_TAC' : 'TAC_TO_ETH');
const getAmount = () => parseUnits(S.amt, 18);
const gasPrice = (() => {
  let at = 0, p = null;
  const read = () => (p ||= rpc('eth_gasPrice', []).then((g) => { D.gasPrice = BigInt(g); at = now(); return D.gasPrice; }, () => D.gasPrice).finally(() => { p = null; }));
  return async () => (D.gasPrice != null && now() - at < 20 ? D.gasPrice : D.gasPrice != null && now() - at < 600 ? (read(), D.gasPrice) : read());
})();
function privQuote(dir, wei) {
  if (!D.priv) return null;
  const inU = wei / E10, [rIn, rOut] = dir === 'ETH_TO_TAC' ? [D.priv.rEth, D.priv.rTac] : [D.priv.rTac, D.priv.rEth];
  if (inU <= 0n) return null;
  const g = BigInt(10000 - D.priv.fee), a = inU * g;
  return ((rOut * a) / (rIn * 10000n + a)) * E10;
}
function bookQuote(dir, wei) {
  if (!D.book || !D.ethUsd || !D.btcUsd) return null;
  if (dir === 'ETH_TO_TAC') {
    const sats = Math.floor((Number(wei) / 1e18) * D.ethUsd / D.btcUsd * 1e8);
    if (sats < 546) return { sats, out: null };
    const plan = planBuy(D.book, { spendSats: sats });
    return { sats, out: plan.fills.length ? plan.amount * E10 : null, plan };
  }
  const tac = Number(wei) / 1e18, ref = D.btc?.mark || D.book.bestAsk;
  const sell = planBtcSell(D.book, { sellBase: wei / E10, includeManual: true });
  return ref || sell.fills.length ? { sats: sell.fills.length ? sell.sats : tac * ref, out: null, sell, bids: D.book.bids.length } : null;
}
async function zq(dir, wei) {
  const k = `${dir}:${wei}`;
  if (S.zq?.k === k && now() - S.zq.at < 300) return S.zq.v;
  const v = await Promise.race([
    venues.quoteZQuoter({ dir, amountIn: wei, account: undefined, deadline: BigInt(now() + 1800) }).catch(() => ({ status: 'error' })),
    new Promise((res) => setTimeout(() => res({ status: 'timeout' }), 8000)),
  ]);
  S.zq = { k, at: now(), v };
  return v;
}

const isMine = (o) => !!W.account && o.maker.toLowerCase() === W.account.toLowerCase();
const pinnedOrder = () => (S.pin ? [...(D.zb?.asks || []), ...(D.zb?.bids || [])].find((o) => o.key === S.pin) || null : null);
async function boardQuote(dir, wei) {
  const z = D.zb, buy = dir === 'ETH_TO_TAC', list = z ? (buy ? z.asks : z.bids) : [];
  if (!list.length) return null;
  const skip = (o) => isMine(o) || (S.pin != null && o.key !== S.pin);
  const plan = buy ? planBoardBuy(list, wei, { skip }) : planBoardSell(list, wei, { skip });
  if (!plan.fills.length) return { ok: false, orders: list.filter((o) => !isMine(o)).length };
  const fine = await refineBoards({ ethCall, plan });
  if (!fine) return { ok: false, orders: list.length, stale: true };
  return { ok: true, plan: fine, out: fine.get, spent: fine.pay, full: fine.pay * 1000n >= wei * 995n, keys: fine.fills.map((f) => f.order.key) };
}
function routeOf(q) {
  const bd = q?.board, pools = q?.rt?.single ? (q.rt.pick === 'split' ? q.rt.split : q.rt.single) : null;
  if (S.pin) return bd?.ok ? 'boards' : null;
  if (!bd?.ok || !bd.full) return pools ? 'pools' : null;
  if (!pools) return 'boards';
  return bd.out * 100n >= BigInt(pools.amountOut) * 101n ? 'boards' : 'pools';
}
const boardsName = (bd) => (bd.plan.fills.length === 1 ? `${BOARD_NAMES[bd.plan.fills[0].order.board]} order #${bd.plan.fills[0].order.id}` : `${bd.plan.fills.length} zSwap orders`);

// A long amount (Max reads the balance to the last digit) shrinks to stay whole inside the box instead of running under the unit.
const fitAmt = () => $('.amt').classList.toggle('long', $('#amt').value.length > 12);
async function requote(quiet = false) {
  fitAmt();
  const my = ++S.seq, wei = getAmount(), dir = dirOf(), buy = S.side === 'buy';
  if (!quiet) { S.quote = null; keepInHash(); if (!S.busy) { $('#status').textContent = ''; $('#status').dataset.kind = ''; } }
  if (!wei || wei <= 0n) { S.quote = null; S.qfail = false; renderQuote(null); renderVenues(null); return; }
  if (!quiet) { if (S.shown === S.side) { $('.p-ticket').classList.add('stale'); renderChips(); renderGo(); } else renderQuote({ busy: true }); }
  if (quiet) S.refreshing = true;
  try {
    const [rt, sp, board] = await Promise.all([gasPrice().then((g) => venues.route({ dir, amountIn: wei, account: W.account || undefined, gasPrice: g })), ethCall(PRECISION_POOL, '0x2af1f249').catch(() => null), boardQuote(dir, wei).catch(() => null)]);
    if (my !== S.seq) return;
    if (!rt.single && !sp) throw new Error('no node answered');
    if (sp) { const root = Number(wordAt(sp, 0)) / 1e18; if (root > 0) { D.perEth = root * root; renderHead(); renderLanes(); } }
    S.qfail = false;
    S.quote = { wei, dir, buy, rt, board, priv: privQuote(dir, wei), book: bookQuote(dir, wei), zq: S.zq?.k === `${dir}:${wei}` ? S.zq.v : null };
    renderQuote(S.quote); renderVenues(S.quote); renderBook();
    if ($('#cmp').open) askZq(S.quote);
  } catch (e) {
    if (my === S.seq && !quiet) { S.qfail = true; renderQuote({ err: 'Could not read the pools. Try again in a moment.' }); renderVenues(null); setTimeout(() => { if (S.qfail && my === S.seq && !S.busy) requote(true); }, 5000); }
  }
  finally { if (quiet) S.refreshing = false; }
}
function askZq(q) {
  if (!q || q.zq) return;
  const { wei, dir } = q;
  zq(dir, wei).then((v) => { if (S.quote && S.quote.wei === wei && S.quote.dir === dir) { S.quote.zq = v; renderVenues(S.quote); } });
}
$('#cmp').addEventListener('toggle', () => { if ($('#cmp').open) askZq(S.quote); });
// The Bitcoin market opened on what the ticket holds: a buy as the sats the amount is worth, going as far into the book as its plan went; a sale of the
// amount into the bids its plan took (the online-only ones too, when it took any); a listing of the amount. With no quote, just the side.
function openBitcoinFor(act, q = S.quote) {
  if (!btcOn()) return;
  if (!q || q.busy || q.err) return openBitcoin(act === 'list' ? { side: 'sell', type: 'limit' } : { side: act, type: 'market' });
  const base = q.wei / E10, sp = q.book?.sell, bp = q.book?.plan;
  openBitcoin(act === 'buy' ? (q.book?.sats >= 546 ? { side: 'buy', type: 'market', spendSats: q.book.sats, reachUnit: bp?.worstUnit || undefined } : { side: 'buy', type: 'market' })
    : act === 'sell' ? { side: 'sell', type: 'market', sellBase: base, reachUnit: sp?.fills.length ? sp.worstUnit : undefined, includeManual: !!sp?.fills.some((f) => !f.bid.auto) }
    : { side: 'sell', type: 'limit', sellBase: base });
}
$('#venues').addEventListener('click', (e) => { const b = e.target.closest('[data-btc-row]'); if (b && S.quote) openBitcoinFor(b.dataset.btcRow); });
$('#btc-alt')?.addEventListener('click', (e) => { const b = e.target.closest('[data-btc-alt]'); if (b) openBitcoinFor(b.dataset.btcAlt); });
// The ticket trades on Ethereum; the same TAC trades for sats on Bitcoin. The line under the ticket says what the order book does with this amount, and opens it there.
// The page is sent with it drawn (the general sentence, which is what it says until the book is read), so the book arriving moves nothing: it is taken away only
// when the book is read and empty, or cannot be read.
function renderBtcAlt(q = S.quote) {
  const el = $('#btc-alt'), b = D.book, buy = S.side === 'buy';
  if (!el) return;
  if (!btcOn() || (b ? !(b.asks.length || b.bids.length) : D.bookFailed)) { el.hidden = true; return; }
  const bk = q && !q.busy && !q.err ? q.book : null;
  let text, act;
  const worth = (sats) => (D.btcUsd ? ` (about ${usd(sats / 1e8 * D.btcUsd)})` : '');
  if (buy && bk?.out) { text = html`Or pay <b>${satsFmt(bk.sats)} sats</b>${worth(bk.sats)} on Bitcoin for about <b>${tacFmt(Number(bk.out) / 1e18)} TAC</b>.`; act = 'buy'; }
  else if (!buy && bk?.sell?.fills.length) {
    // The bids can be fewer than the amount: say how much of it they take, or the sats read as the price of all of it.
    const part = bk.sell.leftoverBase > 0n;
    text = part ? html`Bitcoin bids take only <b>${tacFmt(Number(bk.sell.amount) / 1e8)} TAC</b> of this, for <b>${satsFmt(bk.sats)} sats</b>${worth(bk.sats)}.` : html`Or sell on Bitcoin for <b>${satsFmt(bk.sats)} sats</b>${worth(bk.sats)}.`; act = 'sell';
  }
  else if (!buy && bk) { text = 'Or list it for sats on Bitcoin.'; act = 'list'; }
  else { text = `Or ${buy ? 'buy' : 'sell'} TAC for sats on the Bitcoin order book.`; act = buy ? 'buy' : 'sell'; }
  const label = act === 'list' ? 'List on Bitcoin' : act === 'buy' ? 'Buy on Bitcoin' : 'Sell on Bitcoin';
  const h = `<svg class="tk xs" aria-hidden="true"><use href="#c-btc"/></svg><span>${text} <button type="button" class="linkbtn" data-btc-alt="${act}">${label} →</button></span>`;
  // The line the page was sent with is kept while it is what this would draw: drawing it again would be a new element for the browser's first paint to count, a second later.
  if (el.__h === undefined) { const t = document.createElement('template'); t.innerHTML = h; if (t.innerHTML === el.innerHTML) el.__h = h; }
  setHtml(el, h);
  el.hidden = false;
}
const PRESETS = { buy: [['0.05 ETH', '0.05'], ['0.25 ETH', '0.25'], ['1 ETH', '1']], sell: [['1,000 TAC', '1000'], ['5,000 TAC', '5000'], ['20,000 TAC', '20000']] };
// With a wallet that holds some of what is paid, the quick amounts are shares of it (the Max beside the balance is the rest); without one, round amounts to see the scale.
function chipSet() {
  const have = spendable(), dp = S.side === 'buy' ? 6 : 2, u = 10n ** BigInt(18 - dp);
  const shares = have != null && have > 0n ? [['25%', 1n], ['50%', 2n], ['75%', 3n]].map(([l, k]) => [l, plain(have * k / 4n / u * u)]) : null;
  return shares && shares.every(([, v]) => Number(v) > 0) ? shares : PRESETS[S.side];
}
function renderChips() { $('#chips').innerHTML = chipSet().map(([l, v]) => `<button type="button" data-amt="${v}" aria-pressed="${S.amt === v}"${S.busy ? ' disabled' : ''}>${l}</button>`).join(''); }
function lockTicket() {
  const b = S.busy;
  $('#amt').disabled = b; $('#in-bal').disabled = b;
  document.querySelectorAll('#side-seg button, #chips button, #flip').forEach((x) => { x.disabled = b; });
}
function keepInHash() {
  if (!S.ready) return;
  const h = S.amt ? `#side=${S.side}&amount=${encodeURIComponent(S.amt)}` : S.side === 'sell' ? '#side=sell' : '';
  if (h !== location.hash) history.replaceState(null, '', location.pathname + location.search + h);
}
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-amt]'); if (!b || S.busy) return; S.amt = b.dataset.amt; $('#amt').value = S.amt; S.pin = null; renderPin(); requote(); });
function quoteSay(t) {
  const s = $('#status');
  if (S.busy || (s.dataset.kind === 'trade' && s.textContent)) return;
  s.textContent = t; s.dataset.kind = t ? 'quote' : '';
}
function renderQuote(q) {
  renderChips(); renderBtcAlt(q);
  if (!q?.busy) $('.p-ticket').classList.remove('stale');
  const buy = S.side === 'buy', outEl = $('#out'), route = $('#route'), go = $('#go');
  $('#in-lbl').textContent = 'You pay';
  $('#in-unit').innerHTML = `<svg class="tk sm" aria-hidden="true"><use href="#tk-${buy ? 'eth' : 'tac'}"/></svg>${buy ? 'ETH' : 'TAC'}`;
  $('#out-unit').innerHTML = `<svg class="tk sm" aria-hidden="true"><use href="#tk-${buy ? 'tac' : 'eth'}"/></svg>${buy ? 'TAC' : 'ETH'}`;
  $('#amt').setAttribute('aria-label', buy ? 'ETH to pay' : 'TAC to pay');
  const none = (t) => { S.shown = null; outEl.textContent = t; outEl.classList.add('ph'); $('#out-usd').textContent = ''; route.innerHTML = ''; $('#tk-note').textContent = ''; renderGo(); };
  if (!q) { none('0.00'); quoteSay(S.amt && getAmount() == null ? 'Could not read that amount. Write 1500 or 0.05.' : ''); return; }
  if (q.busy) { none('…'); return; }
  if (q.err) { none('—'); quoteSay(q.err); return; }
  quoteSay('');
  const { rt, wei } = q, via = routeOf(q);
  if (!via) { none('—'); quoteSay(S.pin ? 'That order does not fit this amount: it is taken whole, or it was filled.' : 'No pool can fill this right now.'); return; }
  let out, perTac, name, note = '', usdIn;
  if (via === 'boards') {
    const bd = q.board;
    out = bd.out; usdIn = buy ? bd.spent : bd.out;
    perTac = buy ? Number(bd.spent) / Number(bd.out) : Number(bd.out) / Number(bd.spent);
    name = boardsName(bd);
    const one = bd.plan.fills.length === 1;
    if (!bd.full) note = `<p class="splitnote">${one ? 'This order' : 'These orders'} ${(buy ? 'cost' : 'take') + (one ? 's' : '')} ${esc(fmtUnits(bd.spent, 18, 6))} ${buy ? 'ETH' : 'TAC'}, less than the amount you entered; the rest stays with you.</p>`;
  } else {
    const pick = rt.pick === 'split' ? rt.split : rt.single;
    out = BigInt(pick.amountOut); usdIn = buy ? wei : out;
    perTac = buy ? Number(wei) / Number(out) : Number(out) / Number(wei);
    name = rt.pick === 'split' ? `Split: ${splitWhat(rt.split)}` : rt.single.venue === 'precision' ? 'Precision pool' : rt.single.venue === 'tacit-amm' ? 'Tacit pool' : 'Other pool';
    const gainTxt = rt.split ? `${(rt.split.gainBps / 100).toFixed(rt.split.gainBps < 100 ? 2 : 1)}%` : '';
    if (rt.pick === 'split') note = `<p class="splitnote">Split: <b>${gainTxt}</b> ${buy ? 'more TAC' : 'more ETH'} than the better pool alone.</p>`;
    else if (rt.split && buy && rt.split.gainBps >= 30) note = `<p class="splitnote mute">A split pays ${gainTxt} more, not enough to ${rt.single.venue === 'precision' ? 'leave the Precision pool (it earns points)' : 'be worth it'}.</p>`;
    else if (rt.split) note = `<p class="splitnote mute">A split pays ${gainTxt} more, less than its extra network fee.</p>`;
  }
  outEl.textContent = fmtOut(out, buy); outEl.classList.remove('ph');
  $('#live').textContent = `You get ${outEl.textContent.startsWith('under') ? '' : 'about '}${outEl.textContent} ${buy ? 'TAC' : 'ETH'} for ${fmtUnits(wei, 18, 6)} ${buy ? 'ETH' : 'TAC'}.`;
  const usdV = D.ethUsd ? (Number(usdIn) / 1e18) * D.ethUsd : null, usdOut = usdV == null ? '' : usdV < 0.0001 ? 'under $0.0001' : usd(usdV);
  $('#out-usd').textContent = usdOut ? `≈ ${usdOut}` : '';
  const priceTxt = `${D.ethUsd ? `${usd(usdOf(perTac))} · ` : ''}${sig(perTac)} ETH per TAC`;
  const split = via === 'pools' && rt.pick === 'split' ? rt.split : null;
  const pts = buy && via === 'pools' ? PN.floor(split ? split.legs[0].amountIn : rt.single.venue === 'precision' ? wei : 0n) : '';
  route.innerHTML = (split
    ? html`<div class="kv"><span>Route</span><b>Split across two pools${split.gainBps >= 1 ? ` <i class="gain">+${(split.gainBps / 100).toFixed(split.gainBps < 100 ? 2 : 1)}%</i>` : ''}</b></div>
      <div class="splitbar" role="img" aria-label="${esc(splitWhat(split))}"><span style="flex:${splitShare(split)}" class="pp">Precision ${splitShare(split)}%</span><span style="flex:${100 - splitShare(split)}" class="tp">Tacit ${100 - splitShare(split)}%</span></div>`
    : html`<div class="kv"><span>Route</span><b>${esc(name)}</b></div>`)
    + html`<div class="kv"><span>Price</span><b>${esc(priceTxt)}</b></div>` + (pts ? html`<div class="kv"><span>Points</span><b>${pts}</b></div>` : '') + (split ? '' : note)
    + detailsHtml(planOf(q))
    + (q.priv && via === 'pools' ? html`<p class="privnote"><a href="${esc(privLink(q))}">Swap privately through the Tacit pool →</a></p>` : '');
  const approves = !buy && via === 'pools' && rt.pick !== 'split' && rt.single.venue === 'tacit-amm';
  $('#tk-note').textContent = `${buy ? 'One transaction' : approves ? 'An approval of your TAC for the Tacit pool (the first time), then one transaction' : 'A free permit signature, then one transaction'}, checked before it is sent.${via === 'boards' ? ' If an order is filled first, nothing is sent.' : rt.pick === 'split' ? ' If the split fails the check, it goes to one pool.' : ''}`;
  S.shown = S.side;
  renderGo();
}
const privLink = (q) => (q?.priv ? `/#card=${q.buy ? 'swap:ether:tac' : 'swap:tac:ether'}:private&amt=${plain(q.wei / E10 * E10)}` : null);
const splitShare = (sp) => Math.round(Number(sp.legs[0].amountIn * 1000n / (sp.legs[0].amountIn + sp.legs[1].amountIn)) / 10);
const splitWhat = (sp) => `${splitShare(sp)}% Precision pool, ${100 - splitShare(sp)}% Tacit pool`;

function renderVenues(q) {
  const tb = $('#venues tbody'), buy = S.side === 'buy';
  const unit = buy ? 'TAC' : 'ETH', f = (v) => `${fmtOut(v, buy)} ${unit}`;
  $('#venues').classList.toggle('empty', !q); $('#cmp').hidden = !q;
  if (!q) { tb.innerHTML = `<tr><td colspan="3" class="mute">Enter an amount to compare every pool.</td></tr>`; return; }
  const { rt } = q, rows = [], via = routeOf(q);
  const add = (r) => rows.push(r);
  const p = rt.r?.precision, t = rt.r?.tacitAmm;
  const runs = via === 'boards' ? 'boards' : rt.pick === 'split' ? 'split' : rt.single?.venue;
  add({ name: 'Precision pool', note: p ? `fee ${(Number(p.feeBps) / 1e4).toFixed(2)}%` : '', out: p?.amountOut, why: p ? null : 'could not quote', runs: runs === 'precision' });
  add({ name: 'Tacit pool', note: 'public swap · fee 0.30%', out: t?.amountOut, why: t ? null : 'could not quote', runs: runs === 'tacit-amm' });
  if (rt.split) add({ name: 'Both, split', note: splitWhat(rt.split), out: rt.split.amountOut, split: true, runs: runs === 'split' });
  const priv = q.priv;
  add({ name: 'Tacit pool, private', note: 'before the relay fee', out: priv, why: D.priv ? null : 'not read', priv: true, link: privLink(q) });
  const zqv = q.zq;
  if (zqv?.status === 'ok') add({ name: 'Uniswap, Sushi or Curve', note: 'found by zQuoter', out: zqv.amountOut });
  const bz = q.board, zside = D.zb ? (buy ? D.zb.asks : D.zb.bids) : [];
  if (bz?.ok) add({ name: 'zSwap boards', note: `${boardsName(bz)}${bz.full ? '' : ` · takes ${fmtUnits(bz.spent, 18, 4)} ${buy ? 'ETH' : 'TAC'} of your amount`}`, out: bz.out, part: !bz.full, boards: true, runs: runs === 'boards' });
  else if (zside.length) add({ name: 'zSwap boards', note: `${zside.length} resting order${zside.length === 1 ? '' : 's'}`, why: S.pin ? 'the pinned order does not fit this' : 'none fits this amount', out: null });
  const bk = q.book;
  if (bk) {
    const to = (act, text) => (btcOn() ? { act, actText: text } : {});
    const sw = (n) => (D.btcUsd ? ` (about ${usd(n / 1e8 * D.btcUsd)})` : '');
    if (buy) add({ name: 'Bitcoin order book', note: `pay ${satsFmt(bk.sats)} sats${sw(bk.sats)} instead`, out: bk.out, why: bk.out ? null : bk.sats < 546 ? 'too small for Bitcoin' : 'no listing that small', btc: true, ...(bk.out ? to('buy', 'Buy on Bitcoin →') : {}) });
    else if (bk.sell?.fills.length) {
      const sp = bk.sell, manual = sp.fills.filter((f) => !f.bid.auto).length;
      add({ name: 'Bitcoin order book', show: `${satsFmt(bk.sats)} sats`, btc: true,
        note: `${D.btcUsd ? `about ${usd(bk.sats / 1e8 * D.btcUsd)} · ` : ''}${sp.fills.length} bid${sp.fills.length === 1 ? '' : 's'} · ${!manual ? 'settles within minutes' : 'settles when the bidder is online'}${sp.leftoverBase ? ` · takes ${fmtUnits(sp.amount * E10, 18, 2)} TAC` : ''} · less ~${satsFmt(sp.feesEst)} sats in fees`, out: null, ...to('sell', 'Sell on Bitcoin →') });
    } else add({ name: 'Bitcoin order book', note: bk.bids ? 'no bid takes this amount' : D.bidsRead ? 'no bids' : 'bids not read', why: `list it: ~${satsFmt(bk.sats)} sats at the last trade`, out: null, btc: true, ...to('list', 'List on Bitcoin →') });
  }
  const eth = rows.filter((r) => r.out != null && !r.priv && !r.btc && !r.part).map((r) => BigInt(r.out));
  const best = eth.length ? eth.reduce((a, b) => (b > a ? b : a)) : null;
  $('#cmp-sum').textContent = `Compare ${rows.length} ways to trade this`;
  tb.innerHTML = rows.map((r) => {
    const isBest = best != null && r.out != null && !r.priv && !r.btc && !r.part && BigInt(r.out) === best;
    const delta = r.out != null && best && !r.part && !r.btc ? Number((BigInt(r.out) - best) * 10000n / best) / 10000 : null;
    const cell = r.out != null ? `<b class="num">${f(r.out)}</b>` : r.show ? `<b class="num">${esc(r.show)}</b>` : `<span class="mute">${esc(r.why || '')}</span>`;
    return `<tr${isBest ? ' class="best"' : ''}><td><b>${esc(r.name)}</b>${isBest ? '<span class="tag">best</span>' : ''}${r.runs ? '<span class="tag mute">this ticket</span>' : ''}${r.priv ? '<span class="tag mute">estimate</span>' : ''}<small>${esc(r.note || '')}${r.link ? ` · <a href="${esc(r.link)}">Swap privately →</a>` : ''}${r.act ? ` · <button type="button" class="linkbtn" data-btc-row="${r.act}">${esc(r.actText)}</button>` : ''}</small></td><td class="r">${cell}</td><td class="r opt num">${delta != null && !isBest ? esc(pct(delta, 1)) : ''}</td></tr>`;
  }).join('');
}

const btcOn = () => { try { return localStorage.getItem('tacit-trade-btc') !== '0'; } catch { return true; } };
let bitcoin = null;
function notify(msg, kind = '', ms = 5000) {
  const t = document.createElement('div');
  t.className = `btoast ${kind}`; t.setAttribute('role', 'status'); t.textContent = msg; document.body.append(t);
  $('#live').textContent = msg;
  setTimeout(() => t.remove(), ms);
}
const pageWallet = () => (W.account && W.prov && !W.prov.isWalletConnect ? { uuid: W.uuid, address: W.account } : null);
let bitcoinP = null;
function getBitcoin() {
  return (bitcoinP ||= import('/trade/btc.js?cb=3c571e48').then((m) => (bitcoin = m.makeBitcoin({
    notify, wallet: pageWallet, onChange: () => syncMe(),
    onTraded: (t) => { noteBitcoinTrade(t); loadBitcoin().then(paintAll).catch(() => {}); },
  }))).catch((e) => { bitcoinP = null; throw e; }));
}
async function openBitcoin(prime = null) {
  try { await (await getBitcoin()).open(prime); } catch (e) { notify(`Could not open the Bitcoin market: ${e?.message || e}`, 'error', 9000); }
}
const lc = (s) => String(s || '').toLowerCase();
const PUBKEY = /^0[23][0-9a-f]{64}$/, KNOWN_IDS = ['tacit-trade-id-v1', 'tacit-tac-id-v1', 'tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1'];
function ethKeyFor(account) {
  const a = lc(account).replace(/^0x/, ''), json = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, pubs = [];
  if (!a) return null;
  try { pubs.push(localStorage.getItem(`tacit-eth-identity-anchor:${a}`)); } catch { }
  const site = json('tacit-eth-identity:mainnet');
  if (site && lc(site.address).replace(/^0x/, '') === a) pubs.push(site.pubkey);
  for (const id of KNOWN_IDS) { const r = json(id); if (r?.mode === 'eth' && lc(r.address).replace(/^0x/, '') === a) pubs.push(r.pubHex); }
  return pubs.map(lc).find((h) => PUBKEY.test(h)) || null;
}
// The Tacit key is locked when the page's wallet moves to another account, as everywhere on the site: but only a key that wallet opened. A key
// opened another way (the sheet's own sign-in, before a wallet was connected here, or with another wallet) is not the page wallet's to lock.
function syncMe() {
  const k = bitcoin?.session.unlocked ? bitcoin.session.key : null;
  if (!k) ME.pageKey = null;
  else if (k.mode === 'eth' && W.account && lc(k.address) === lc(W.account)) ME.pageKey = lc(k.pubHex);
  if (k?.mode === 'eth' && W.account && lc(k.address) !== lc(W.account) && ME.pageKey === lc(k.pubHex)) { ME.pageKey = null; bitcoin.lock(); return; }
  const open = k ? lc(k.pubHex) : null, pub = open || ethKeyFor(W.account), how = open ? 'open' : pub ? 'record' : '';
  if (pub === ME.pub && how === ME.how) { renderBook(); return; }
  ME.pub = pub; ME.how = how; rebuildBook();
  renderHead(); renderLanes(); renderBook();
  if (S.quote && !S.busy) requote(true);
}
function bookPrime(kind, i) {
  const b = D.book, upTo = (rows, side) => ladderLevels(rows, side).slice(0, i + 1).filter((l) => l.flag !== 'mine').reduce((a, l) => a + l.amount, 0n);
  const at = (rows, side) => { const l = ladderLevels(rows, side)[i]; return l ? { atUnit: l.unit, flag: l.flag } : {}; };
  if (kind === 'buy') return { side: 'buy', type: 'market', receiveBase: upTo(b.asks, 'ask'), ...at(b.asks, 'ask') };
  if (kind === 'sell') return { side: 'sell', type: 'market', sellBase: upTo(b.bids, 'bid'), ...at(b.bids, 'bid') };
  if (kind === 'list') return { side: 'sell', type: 'limit' };
  return null;
}

const ACT_KEY = 'tacit-trade-activity-v1';
const readActs = () => { try { const v = JSON.parse(localStorage.getItem(ACT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
function noteAct(e) { try { localStorage.setItem(ACT_KEY, JSON.stringify([{ t: now(), ...e }, ...readActs()].slice(0, 40))); } catch { } }
const myActs = () => readActs().filter((e) => e.who && (e.who === lc(W.account) || e.who === ME.pub)).slice(0, 8);
function myRecent() {
  const local = myActs(), seen = new Set(local.map((e) => lc(e.tx || '')).filter(Boolean));
  const chain = W.account ? (D.trades || []).filter((x) => x.to === lc(W.account) && !seen.has(lc(x.tx))).map((x) => ({ t: x.t, lane: 'eth', kind: x.side === 'buy' ? 'bought' : 'sold', tac: x.tac, paid: x.eth, unit: 'eth', tx: x.tx })) : [];
  return [...local, ...chain].sort((a, b) => b.t - a.t).slice(0, 8);
}
function myTrades(lane) {
  const who = [W.account && lc(W.account), ME.pub].filter(Boolean);
  if (!who.length) return [];
  const local = readActs().filter((e) => who.includes(e.who) && e.lane === lane && (e.kind === 'bought' || e.kind === 'sold') && e.tac > 0 && e.paid > 0);
  const seen = new Set(local.map((e) => lc(e.tx || '')).filter(Boolean));
  const chain = lane === 'eth' && W.account ? (D.trades || []).filter((x) => x.to === lc(W.account) && !seen.has(lc(x.tx))).map((x) => ({ t: x.t, kind: x.side === 'buy' ? 'bought' : 'sold', tac: x.tac, paid: x.eth })) : [];
  return [...local, ...chain].map((e) => ({ t: e.t, up: e.kind === 'bought', tac: e.tac, px: e.paid / e.tac }));
}
function noteBitcoinTrade({ kind, amount, result, ids }) {
  const k = bitcoin?.session.key, who = ME.pub || (k ? lc(k.pubHex) : null);
  if (!who || amount == null) return;
  const tac = Number(amount) / 1e8, tx = result?.reveal_txid || result?.commit_txid || result?.txid || null, book = D.book;
  let paid = null;
  if (kind === 'bought') { const rows = (ids || []).map((id) => book?.asks.find((a) => a.id === id)); if (rows.length && rows.every(Boolean)) paid = rows.reduce((t, a) => t + a.sats, 0); }
  else if (kind === 'sold') { const bid = book?.bids.find((x) => x.id === (ids || [])[0]); if (bid) paid = Math.round(tac * bid.unit); }
  noteAct({ who, lane: 'btc', kind, tac, paid, unit: 'sats', tx });
}
function myOrders() {
  const out = [], b = D.book;
  if (b && ME.pub) {
    for (const a of b.asks) if (a.mine) out.push({ lane: 'btc', side: 'sell', tac: Number(a.amount) / 1e8, px: btcPxFmt(btcPx(a.unit)), alt: D.btcUsd ? `${satsFmt(a.unit)} sats` : '', expiry: a.expiry, note: 'taken whole' });
    for (const x of b.bids) if (x.mine) out.push({ lane: 'btc', side: 'buy', tac: Number(x.amount) / 1e8, px: btcPxFmt(btcPx(x.unit)), alt: D.btcUsd ? `${satsFmt(x.unit)} sats` : '', expiry: x.expiry, note: x.auto ? 'settles on its own' : 'settles while you are online' });
  }
  for (const o of [...(D.zb?.asks || []), ...(D.zb?.bids || [])]) if (isMine(o)) out.push({ lane: 'eth', side: o.side === 'ask' ? 'sell' : 'buy', tac: Number(o.base) / 1e18, px: ethPxFmt(ethPx(o.price)), alt: D.ethUsd ? `${sig(o.price)} ETH` : '', expiry: o.expiry || 0, note: `${BOARD_NAMES[o.board]} #${o.id}` });
  return out;
}
const showMine = () => !!(W.account || ME.pub);
function mineHtml(orders) {
  const key = bitcoin?.session.unlocked ? bitcoin.session.key : null, me = key ? bitcoin.me : null, here = pageWallet();
  const who = key ? (key.mode === 'eth' ? `Ethereum ${short(key.address)}` : key.mode === 'passkey' ? `passkey “${key.label || 'Tacit'}”` : `Bitcoin ${short(key.address || '')}`) : W.account ? `Ethereum ${short(W.account)}` : '';
  const btn = (act, t, cls = '') => `<button type="button" class="fillbtn ${cls}" data-mine="${act}">${esc(t)}</button>`;
  const openBtn = here ? btn('open', `Open with ${short(here.address)}`, 'primary') : btn('signin', 'Open your Tacit wallet', 'primary');
  const how = here ? ' One free signature, two the first time.' : '';
  const bal = me ? `${me.sats != null ? esc(satsFmt(me.sats)) : '—'} sats · ${me.assetBase != null ? `${esc(tacFmt(Number(me.assetBase) / 1e8))} TAC on Bitcoin` : 'TAC on Bitcoin loading…'}`
    : key ? 'Reading what it holds on Bitcoin…'
    : ME.pub ? `Open it to see what it holds on Bitcoin.${how}` : `Open your Tacit wallet to see your Bitcoin orders and what you hold there.${how}`;
  const acts = me ? btn('fund', 'Add sats') + btn('lock', 'Lock') : key ? '' : openBtn;
  const lane = (l) => `<svg class="tk xs inl" role="img" aria-label="${l === 'btc' ? 'Bitcoin' : 'Ethereum'}"><use href="#c-${l === 'btc' ? 'btc' : 'eth'}"/></svg>`;
  const ord = orders.length ? `<table class="table trades yours"><thead><tr><th>Order</th><th class="r">TAC</th><th class="r">Price</th><th class="r opt">Ends</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${orders.map((o) =>
    `<tr><td>${lane(o.lane)}${o.side === 'sell' ? 'Selling' : 'Bid'}<small>${esc(o.note)}</small></td><td class="r num">${esc(tacFmt(o.tac))}</td><td class="r num">${esc(o.px)}${o.alt ? `<small>${esc(o.alt)}</small>` : ''}</td><td class="r opt">${o.expiry ? esc(left(o.expiry)) : ''}</td><td class="go">${o.lane === 'btc' ? (btcOn() ? '<button type="button" class="linkbtn" data-mine="manage">Manage</button>' : '') : `<a href="${ZSWAP_HOST}" target="_blank" rel="noopener noreferrer">zSwap ↗</a>`}</td></tr>`).join('')}</tbody></table>`
    : ME.pub ? `<p class="note">No open orders on the Bitcoin order book. ${btcOn() ? `<button type="button" class="linkbtn" data-mine="list">List a sale</button>` : ''}</p>` : '';
  const rec = myRecent();
  const recent = rec.length ? `<p class="mine-h">Recent <span>what this browser saw, and the Precision pool’s swaps to your account over the last day</span></p><table class="table trades yours recent"><tbody>${rec.map((e) => {
    const pay = e.paid != null ? ` for ${e.unit === 'eth' ? `${grp(e.paid, e.paid < 1 ? 4 : 2)} ETH` : `${satsFmt(e.paid)} sats`}` : '', what = e.kind === 'listed' ? 'Listed' : e.kind === 'sold' ? 'Sold' : 'Bought';
    const href = e.tx ? (e.lane === 'btc' ? `https://mempool.space/tx/${e.tx}` : `https://etherscan.io/tx/${e.tx}`) : '';
    return `<tr><td>${lane(e.lane)}${esc(ago(e.t))}</td><td>${esc(what)} <b>${esc(tacFmt(e.tac))}</b> TAC${esc(pay)}</td><td class="go">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open the transaction">↗</a>` : ''}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  const eth = W.account && S.bal && S.bal.eth != null ? `<div class="mine-eth">${esc(fmtUnits(S.bal.eth, 18, 4))} ETH · ${esc(fmtUnits(S.bal.tac ?? 0n, 18, 2))} TAC on Ethereum</div>` : '';
  return `<div class="mine-head"><div class="mine-who"><b>Your Tacit wallet</b> ${who ? `<span>${esc(who)}</span>` : ''}</div><div class="mine-bal">${bal}</div><div class="mine-acts">${acts}</div>${eth}</div>${ord}${recent}`;
}
async function mineAct(act, btn) {
  const b = btn ? { el: btn, text: btn.textContent } : null;
  if (b && /^(open|signin)$/.test(act)) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const bt = await getBitcoin();
    if (act === 'open') await bt.openHere();
    else if (act === 'signin') await bt.signIn();
    else if (act === 'fund') bt.fund();
    else if (act === 'lock') bt.lock();
    else if (act === 'list') await openBitcoin(bookPrime('list'));
    else await openBitcoin(act === 'manage' ? { focus: 'orders' } : null);
  } catch (e) {
    if (!/cancel/i.test(e?.message || '') && !e?.unlockCancelled && e?.name !== 'NotAllowedError' && e?.code !== 4001) notify(String(e?.message || e).slice(0, 200), 'error', 9000);
  } finally { if (b?.el.isConnected) { b.el.disabled = false; b.el.textContent = b.text; } renderBook(); }
}
const PEEK_IDLE = 'Press a price to buy or sell up to it.';
function setPeek(t) { const el = $('#ob-peek'); if (t === null || !btcOn()) { el.hidden = true; return; } el.hidden = false; el.textContent = t || PEEK_IDLE; }
function peekText(kind, i) {
  const b = D.book; if (!b) return '';
  const want = bookPrime(kind, i), buy = kind === 'buy';
  const p = buy ? planBuy(b, { receiveBase: want.receiveBase }) : planBtcSell(b, { sellBase: want.sellBase, includeManual: true });
  if (!p.fills.length) return '';
  const sats = p.sats, avg = p.avgUnit ? btcPxFmt(btcPx(p.avgUnit)) : '';
  return [`${buy ? 'Buy' : 'Sell'} ${tacFmt(Number(p.amount) / 1e8)} TAC for ${satsFmt(sats)} sats`, D.btcUsd ? `about ${usd(sats / 1e8 * D.btcUsd)}` : '', avg ? `${avg} each` : '', p.fills.length > 1 ? `${p.fills.length} ${buy ? 'listings' : 'bids'}` : ''].filter(Boolean).join(' · ');
}

const depth = mountDepth($('#depthchart'), { onPick: (e) => { if (e?.order && bookTab() === 'eth') pinOrder(e.order.key); } });
const SWAP_TOPIC = '0x2a9237ff5aa599ef4c5ee4b1142b53429d5755e2685fe6288b2e3320202115f5';
async function loadTrades() {
  const head = await rpc('eth_getBlockByNumber', ['latest', false]), n = Number(BigInt(head.number)), ts = Number(BigInt(head.timestamp));
  const logs = await rpc('eth_getLogs', [{ address: PRECISION_POOL, topics: [SWAP_TOPIC], fromBlock: `0x${(n - 6900).toString(16)}`, toBlock: 'latest' }]);
  D.trades = logs.map((l) => {
    const buy = BigInt(l.topics[1]) === 0n, a = wordAt(l.data, 0), b = wordAt(l.data, 1);
    return { lane: 'eth', t: ts - (n - Number(BigInt(l.blockNumber))) * 12, side: buy ? 'buy' : 'sell', tac: Number(buy ? b : a) / 1e18, eth: Number(buy ? a : b) / 1e18, tx: l.transactionHash, to: `0x${String(l.topics[2] || '').slice(26).toLowerCase()}` };
  }).filter((x) => x.tac > 0 && x.eth > 0);
  D.tradesAt = now();
}
let tradesBusy = false;
async function ensureTrades(force = false) {
  if (tradesBusy || (!force && !D.tradesStale && D.tradesAt && now() - D.tradesAt < 50)) return;
  tradesBusy = true; D.tradesTried = now(); D.tradesStale = false;
  try { await loadTrades(); D.tradesErr = false; } catch { D.tradesErr = !D.trades; } finally { tradesBusy = false; }
  renderBook(); renderChart();
}
const ago = (t) => { const d = Math.max(0, now() - t); return d < 90 ? 'just now' : d < 3600 ? `${Math.round(d / 60)}m ago` : d < 86400 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`; };
function tradesHtml() {
  if (D.tradesErr && !D.trades) return `<p class="note">Could not read the pool’s recent swaps. Try again in a moment.</p>`;
  if (!D.trades) return `<p class="note">Reading recent trades…</p>`;
  const rows = [...D.trades.map((x) => ({ ...x, usd: D.ethUsd ? x.eth / x.tac * D.ethUsd : null })),
    ...tradePrices(D.btc?.trades || []).slice(-40).map((x) => ({ lane: 'btc', t: x.t, side: null, tac: x.vol, sats: x.price, usd: D.btcUsd ? x.price * D.btcUsd / 1e8 : null }))].sort((a, b) => b.t - a.t).slice(0, 40);
  if (!rows.length) return '<p class="note">No trades yet.</p>';
  const shown = S.tradesAll ? rows : rows.slice(0, TRADES_ROWS);
  const cell = (x) => (x.lane === 'eth' ? `${fmtUnits(BigInt(Math.round(x.eth * 1e6)) * 10n ** 12n, 18, 4)} ETH` : `${satsFmt(x.sats * x.tac)} sats`);
  return `<table class="table trades"><thead><tr><th>Time</th><th class="r">TAC</th><th class="r">Price</th><th class="r opt">Paid</th><th><span class="sr">Transaction</span></th></tr></thead><tbody>${shown.map((x) => {
    const price = x.usd != null ? usd(x.usd) : x.lane === 'eth' ? `${sig(x.eth / x.tac)} ETH` : `${satsFmt(x.sats)} sats`;
    return `<tr><td title="${esc(`${fmtLocalStamp(x.t)}${x.lane === 'eth' ? ', about' : ''}`)}"><svg class="tk xs inl" role="img" aria-label="${x.lane === 'eth' ? 'Ethereum' : 'Bitcoin'}"><use href="#c-${x.lane === 'eth' ? 'eth' : 'btc'}"/></svg>${esc(ago(x.t))}${x.side ? `<small class="${x.side === 'buy' ? 'up' : 'down'}">${x.side}</small>` : ''}${x.to && W.account && x.to === lc(W.account) ? '<small class="you">you</small>' : ''}</td><td class="r num">${esc(tacFmt(x.tac))}</td><td class="r num ${x.side === 'buy' ? 'up' : x.side === 'sell' ? 'down' : ''}">${esc(price)}</td><td class="r opt num">${esc(cell(x))}</td><td class="go">${x.tx ? `<a href="https://etherscan.io/tx/${esc(x.tx)}" target="_blank" rel="noopener noreferrer" aria-label="Open the transaction on Etherscan">↗</a>` : ''}</td></tr>`;
  }).join('')}</tbody></table>${rows.length > TRADES_ROWS ? `<button type="button" class="ob-more" data-more-trades="1">${S.tradesAll ? 'Show fewer' : `Show all ${rows.length} trades`}</button>` : ''}`;
}
const TRADES_ROWS = 12;
const hasBoardOrders = () => !!D.zb && (D.zb.asks.length > 0 || D.zb.bids.length > 0);
const bookTab = () => (S.book === 'mine' && !showMine() ? null : S.book) || (D.zb ? (hasBoardOrders() ? 'eth' : 'btc') : (D.zbFailed ? 'btc' : 'eth'));
const ethPx = (p) => (D.ethUsd ? p * D.ethUsd : p);
const ethPxFmt = (v) => (D.ethUsd ? usd(v) : `${sig(v)} ETH`);
const btcPx = (sats) => (D.btcUsd ? (sats * D.btcUsd) / 1e8 : sats);
const btcPxFmt = (v) => (D.btcUsd ? usd(v) : `${satsFmt(v)} sats`);
const tacFmt = (n) => grp(n, n >= 100 ? 0 : 2);
const left = (t) => { const d = t - now(); return d <= 0 ? 'now' : d < 3600 ? `${Math.ceil(d / 60)} min` : d < 172800 ? `${Math.round(d / 3600)} h` : `${Math.round(d / 86400)} days`; };
const ZSWAP_LINK = `<a href="${ZSWAP_HOST}" target="_blank" rel="noopener noreferrer">Place an order on zSwap ↗</a>`;
const BOOK_ROWS = 8;
function stackBook({ asks, bids, totalHead, mid, levels = false }) {
  const show = (l) => (S.bookAll ? l : l.slice(0, BOOK_ROWS)), a = show(asks), b = show(bids);
  const cum = (l) => { let t = 0; return l.map((x) => (t += x.depth)); };
  const ac = cum(a), bc = cum(b), max = Math.max(ac.at(-1) || 0, bc.at(-1) || 0) || 1;
  const row = (x, side, c) => {
    const inner = `<span class="p">${esc(x.price)}${x.small ? `<small>${esc(x.small)}</small>` : ''}</span><span class="a">${x.mine ? '<i class="ob-tag">yours</i>' : ''}${esc(x.amount)}</span><span class="t">${esc(x.total)}</span>`;
    const cls = `ob-row ${side}${x.take ? ' take' : ''}${x.mine ? ' mine' : ''}`, style = `--w:${Math.max(1, Math.round((c / max) * 100))}%`;
    return x.attrs && !x.mine ? `<button type="button" class="${cls}" style="${style}" title="${esc(x.title)}" aria-label="${esc(x.label)}" ${x.attrs}>${inner}</button>` : `<div class="${cls}" style="${style}" title="${esc(x.title)}">${inner}</div>`;
  };
  const hidden = asks.length - a.length + bids.length - b.length;
  return `<div class="ob"><div class="ob-head"><span>Price</span><span><svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span><span>${esc(totalHead)}</span></div>`
    + `<div class="ob-asks">${a.length ? a.map((x, i) => row(x, 'ask', ac[i])).reverse().join('') : '<div class="ob-empty">No one is selling right now.</div>'}</div>`
    + `<div class="ob-spread">${mid}</div>`
    + `<div class="ob-bids">${b.length ? b.map((x, i) => row(x, 'bid', bc[i])).join('') : '<div class="ob-empty">No one is bidding right now.</div>'}</div>`
    + (hidden > 0 || S.bookAll ? `<button type="button" class="ob-more" data-more="1">${S.bookAll ? 'Show less' : `Full book · ${count(asks.length, levels ? 'ask price' : 'ask')}, ${count(bids.length, levels ? 'bid price' : 'bid')}`}</button>` : '') + '</div>';
}
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const spreadTxt = (ask, bid, why = '') => {
  if (!ask || !bid) return '';
  const over = (bid - ask) / ask;
  return over > 0.0005 ? `<span title="The best bid is above the cheapest ask.${esc(why)}">bids ${over < 0.095 ? (over * 100).toFixed(1) : Math.round(over * 100)}% over asks</span>` : `<span title="Between the cheapest ask and the best bid">spread ${Math.abs(over * 100).toFixed(1)}%</span>`;
};
function ethStack(z) {
  const taking = new Set(S.quote?.board?.ok && routeOf(S.quote) === 'boards' ? S.quote.board.keys : []);
  const lv = (o) => {
    const ask = o.side === 'ask', tac = Number(o.base) / 1e18, px = ethPxFmt(ethPx(o.price));
    const meta = [BOARD_NAMES[o.board], o.partial ? 'part fills ok' : 'whole only', o.expiry ? `ends in ${left(o.expiry)}` : 'no end', o.board === 'dutch' ? 'price changes with time' : o.board === 'floor' ? 'bid climbs' : ''].filter(Boolean).join(' · ');
    return { price: px, small: D.ethUsd ? `${sig(o.price)} ETH` : '', amount: tacFmt(tac), total: fmtUnits(o.quote, 18, 4), depth: Number(o.quote) / 1e18, mine: isMine(o), take: taking.has(o.key),
      attrs: `data-fill="${esc(o.key)}"`, title: `${meta}. Click to ${ask ? 'buy' : 'sell'} this order.`, label: `${ask ? 'Buy' : 'Sell'} ${tacFmt(tac)} TAC at ${px} each` };
  };
  const ref = priceEth();
  return stackBook({ asks: z.asks.map(lv), bids: z.bids.map(lv), totalHead: 'ETH',
    mid: `${ref ? `<span class="ob-last"><b>${esc(ethPxFmt(ethPx(ref)))}</b><em>Precision pool</em></span>` : '<span></span>'}${spreadTxt(z.asks[0]?.price, z.bids[0]?.price)}` });
}
function btcStack(b, live) {
  const lvs = (rows, ask) => { let upTo = 0; return ladderLevels(rows, ask ? 'ask' : 'bid').map((l, i) => {
    const amt = Number(l.amount) / 1e8, px = btcPxFmt(btcPx(l.unit)), ends = ask ? Math.min(...l.rows.map((r) => r.expiry).filter(Boolean)) : 0;
    const why = ask ? (l.count > 1 ? `${l.count} listings, each taken whole` : 'one listing, taken whole') : l.flag === 'auto' ? 'settles within minutes' : 'settles when the bidder is online';
    if (l.flag !== 'mine') upTo += amt;
    return { price: px, small: [D.btcUsd ? `${satsFmt(l.unit)} sats` : '', l.count > 1 ? `${l.count} listings` : ''].filter(Boolean).join(' · '), amount: tacFmt(amt), total: satsFmt(l.sats), depth: l.sats, mine: l.flag === 'mine',
      attrs: live ? `data-btc="${ask ? 'buy' : 'sell'}" data-i="${i}"` : '', title: `${why}${Number.isFinite(ends) && ends ? ` · ends in ${left(ends)}` : ''}.${live ? ` Click to ${ask ? 'buy' : 'sell'} up to this price.` : ''}`,
      label: `${ask ? 'Buy' : 'Sell'} ${tacFmt(upTo)} TAC in all, ${ask ? 'up' : 'down'} to ${px} each` };
  }); };
  return stackBook({ asks: lvs(b.asks, true), bids: lvs(b.bids, false), totalHead: 'Sats', levels: true,
    mid: `${D.btc?.mark ? `<span class="ob-last"><b>${esc(btcPxFmt(btcPx(D.btc.mark)))}</b><em>last trade</em></span>` : '<span></span>'}${spreadTxt(b.bestAsk, b.bestBid, ' A bid settles when its bidder is online, and a listing is taken whole.')}` });
}
const setHtml = (el, h) => { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } };
function renderBook() {
  const orders = myOrders(), mb = $('#book-seg [data-book="mine"]');
  mb.hidden = !showMine(); setHtml(mb, `Yours${orders.length ? `<i class="n">${orders.length}</i>` : ''}`);
  const tab = bookTab(), box = $('#ladders'), note = $('#depth-note');
  $('#book-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.book === tab)));
  $('#depthchart').hidden = tab === 'trades' || tab === 'mine' || (tab === 'eth' && !!D.zb && !hasBoardOrders());       // an empty board says so once, under the tabs, not again in a blank chart
  setPeek(tab === 'btc' ? '' : null);
  if (tab === 'mine') { if (W.account && (D.tradesStale || ((!D.tradesAt || now() - D.tradesAt > 120) && (!D.tradesTried || now() - D.tradesTried > 60)))) ensureTrades(); setHtml(box, mineHtml(orders)); note.textContent = ''; return; }
  if (tab === 'trades') {
    setHtml(box, tradesHtml());
    note.textContent = 'Precision pool swaps from about the last day (a split counts its Precision share) and every Bitcoin order book trade.';
    return;
  }
  if (tab === 'eth') {
    const z = D.zb;
    if (!z) {
      depth.update({ asks: [], bids: [], empty: D.zbFailed ? 'Could not read zSwap’s boards.' : 'Reading zSwap’s boards…' });
      setHtml(box, D.zbFailed ? `<p class="note">Could not read zSwap’s boards. ${ZSWAP_LINK}</p>` : ''); note.textContent = ''; return;
    }
    const missing = z.answered < BOARD_CALLS ? ' Some boards did not answer; orders may be missing.' : '';
    const bd = S.quote?.board, via = routeOf(S.quote);
    const take = S.pin == null && via === 'boards' && bd?.ok ? { side: S.quote.buy ? 'ask' : 'bid', size: Number(S.quote.buy ? bd.out : bd.spent) / 1e18 } : null;
    depth.update({
      asks: z.asks.map((o) => ({ price: ethPx(o.price), size: Number(o.base) / 1e18, order: o })), bids: z.bids.map((o) => ({ price: ethPx(o.price), size: Number(o.base) / 1e18, order: o })), take,
      priceFmt: ethPxFmt, sizeFmt: (n) => `${tacFmt(n)} TAC`, label: 'zSwap order book for TAC', empty: 'No TAC orders on zSwap’s boards.',
    });
    setHtml(box, hasBoardOrders() ? ethStack(z) : `<p class="note">${z.answered < BOARD_CALLS ? 'No TAC orders on the boards that answered.' : 'No TAC orders on zSwap’s boards.'}${missing} ${ZSWAP_LINK}</p>`);
    note.innerHTML = hasBoardOrders() ? `Orders on zSwap’s boards. Press an order to trade with it alone; otherwise the ticket fills the best orders together when that pays more.${missing} ${ZSWAP_LINK}` : '';
    return;
  }
  const b = D.book;
  if (!b) { setPeek(null); depth.update({ asks: [], bids: [], empty: D.bookFailed ? 'Could not read the Bitcoin order book.' : 'Reading the Bitcoin order book…' }); setHtml(box, D.bookFailed ? `<p class="note">Could not read the Bitcoin order book. ${retryBtn()}</p>` : ''); note.textContent = ''; return; }
  const bq = S.quote?.book, take = bq?.plan?.fills?.length && S.side === 'buy' ? { side: 'ask', size: Number(bq.plan.amount) / 1e8 } : bq?.sell?.fills?.length && S.side === 'sell' ? { side: 'bid', size: Number(bq.sell.amount) / 1e8 } : null;
  depth.update({
    asks: b.asks.map((r) => ({ price: btcPx(r.unit), size: Number(r.amount) / 1e8 })), bids: b.bids.map((r) => ({ price: btcPx(r.unit), size: Number(r.amount) / 1e8 })), take,
    priceFmt: btcPxFmt, sizeFmt: (n) => `${tacFmt(n)} TAC`, label: 'Bitcoin order book for TAC', empty: 'No TAC is listed on the Bitcoin order book right now.',
  });
  const live = btcOn();
  setHtml(box, btcStack(b, live) + (live ? `<div class="btc-actions"><button class="fillbtn primary" type="button" data-btc="open">Trade on Bitcoin</button><button class="fillbtn" type="button" data-btc="list">List a sale</button></div>` : ''));
  const total = b.asks.reduce((a, r) => a + r.amount, 0n), want = b.bids.reduce((a, r) => a + r.amount, 0n);
  const bidsTxt = !D.bidsRead ? 'Could not read the bids.' : b.bids.length ? `${count(b.bids.length, 'bid')} (${grp(Number(want) / 1e8, 0)} TAC) ${b.bids.length === 1 ? 'settles' : 'settle'} when the bidder is online.` : 'No bids.';
  const nMine = orders.filter((o) => o.lane === 'btc').length, yours = nMine ? `<button type="button" class="linkbtn" data-goto="mine">You have ${nMine} open order${nMine === 1 ? '' : 's'} here</button>. ` : '';
  note.innerHTML = b.asks.length ? `${yours}${count(b.asks.length, 'listing')} (${grp(Number(total) / 1e8, 0)} TAC), taken whole. ${bidsTxt}${live ? '' : ` <a href="/classic.html#tab=market&aid=${TAC_BTC_ID}&lane=btc">List a sale →</a>`}` : bidsTxt;
}
function renderPin() {
  const el = $('#pin'), o = pinnedOrder();
  if (!S.pin || !o) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span>Filling ${esc(BOARD_NAMES[o.board])} order #${esc(o.id)}</span><button class="linkbtn" type="button" id="unpin">Use the best route</button>`;
}
function pinOrder(key) {
  const o = [...(D.zb?.asks || []), ...(D.zb?.bids || [])].find((x) => x.key === key);
  if (!o || isMine(o) || S.busy) return;
  const buy = o.side === 'ask';
  S.pin = key; S.side = buy ? 'buy' : 'sell';
  S.amt = plain(buy ? o.quote : o.base); $('#amt').value = S.amt;
  $('#side-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.side === S.side)));
  renderBalance(); renderPin(); requote();
  $('.p-ticket').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderAbout() {
  setHtml($('#about'), `<p><b>TAC</b> is Tacit’s private money: 21,000,000, issued once on Bitcoin, confidential by default. On Ethereum it is an ERC-20 minted only against TAC that left Bitcoin. <a href="/verify.html">Check the supply →</a></p>`);
  const link = (a, t) => `<a href="${SCAN}${a}" target="_blank" rel="noopener noreferrer">${t || `${a.slice(0, 8)}…${a.slice(-6)}`}</a>`;
  const pool = getConfidentialDeployment('mainnet')?.pool, vol24Usd = D.btc?.vol24 && D.btcUsd ? (D.btc.vol24 * D.btcUsd) / 1e8 : null;
  const main = [
    ['Ethereum', `ERC-20 ${link(TAC_ERC20)}${D.ethSupply != null ? ` · ${grp(Number(D.ethSupply) / 1e18, 0)} TAC minted there so far` : ''}`, CM_ETH],
    ['Bitcoin', `Asset <code>${TAC_BTC_ID.slice(0, 8)}…${TAC_BTC_ID.slice(-6)}</code>${D.btc?.holders ? ` · ${grp(D.btc.holders, 0)} holders` : ''}${D.btc?.vol24 ? ` · ${grp(D.btc.vol24, 0)} sats${vol24Usd != null ? ` (${vol24Usd < 10 ? usd(vol24Usd) : `$${grp(vol24Usd, 0)}`})` : ''} traded in 24h` : ''}`, CM_BTC],
    ['Bridging', `<a href="/#bridge">The bridge</a> takes TAC from Bitcoin to Ethereum, usually within a few hours and sometimes up to a day.`],
  ];
  const more = [
    ['Precision pool', `${link(PRECISION_POOL)} · TAC/ETH${D.precision ? ` · holds ${fmtUnits(D.precision.eth, 18, 2)} ETH and ${fmtUnits(D.precision.tac, 18, 0)} TAC` : ''}`],
    ['Tacit pool', `${pool ? link(pool) : ''} · TAC/tETH, 0.30% fee${D.priv ? ` · holds ${fmtUnits(D.priv.rEth, 8, 2)} tETH and ${fmtUnits(D.priv.rTac, 8, 0)} TAC` : ''} · public swaps via ${link(TACIT_AMM)}, private swaps from private balances`],
    ['Buybacks', `${link('0x6919cbEf0e70AFFA02Ae02c86c532A137154f250', 'TacBuyback')} buys up to 0.25 ETH of TAC every 6 hours`],
    ['More', `<a href="https://github.com/src-company/tacit/blob/main/docs/TAC.md" target="_blank" rel="noopener noreferrer">About TAC ↗</a> · <a href="/#asset/tac">TAC in the app →</a> · <a href="/weld/stats/">Stats →</a>`],
  ];
  const li = ([k, v, mark = '']) => `<li><b>${mark}${esc(k)}</b><span>${v}</span></li>`;
  setHtml($('#facts'), main.map(li).join(''));
  setHtml($('#facts-more'), more.map(li).join(''));
}

const connect = makeConnect({
  describe: 'Trade TAC at the best price',
  rows: walletRows, wire: wireWalletSheet,
  busy: () => S.busy || farm.busy(),
  leave: (addr) => { if (bitcoin?.session.unlocked && bitcoin.session.key?.mode === 'eth' && lc(bitcoin.session.key.address) === lc(addr)) bitcoin.lock(); },
  say: (t) => say(t),
  onChange: () => { syncMe(); if (!farm.busy()) farm.refresh(); if (W.account && S.ready) ensureTrades(); else renderChart(); if (S.busy) return; readBalances().then(() => { renderBalance(); if (getAmount()) requote(); else renderGo(); }); },
  restore: false,
});
const { wallet, W } = connect, connectWallet = connect.connect;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const plain = (v, dec = 18) => { const n = BigInt(v), b = 10n ** BigInt(dec), f = (n % b).toString().padStart(dec, '0').replace(/0+$/, ''); return `${n / b}${f ? `.${f}` : ''}`; };
const say = (t) => { const s = $('#status'); s.innerHTML = t; s.dataset.kind = 'trade'; };
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;
async function readBalances() {
  const who = W.account;
  if (!who) { S.bal = null; return; }
  const [eth, tac] = await Promise.all([rpc('eth_getBalance', [who, 'latest']).then((x) => BigInt(x), () => null), ethCall(TAC_ERC20, '0x70a08231' + word(BigInt(who))).then((x) => wordAt(x, 0), () => null)]);
  if (W.account === who) S.bal = { eth, tac };
}
const spendable = () => (S.bal ? (S.side === 'buy' ? S.bal.eth : S.bal.tac) : null);
// ETH a trade must leave for its own network fee: twice the route's gas at the gas price now (room for a price that rises before it is signed and for the wallet's padding), and for a sale the approval sent first. The fee row says what the trade costs, so a balance that covers both is not held back.
const APPROVE_GAS = 60000;
const gasReserve = (P = null, buy = true) => { const at = buy ? 0 : 1, units = ROUTE_GAS[P?.split ? 'split' : P?.rt?.single?.venue || 'split']?.[at] || ROUTE_GAS.split[at]; return BigInt(units + (buy ? 0 : APPROVE_GAS)) * (D.gasPrice ?? 3n * 10n ** 9n) * 2n; };
function renderBalance() {
  const b = $('#in-bal'), have = spendable();
  b.hidden = have == null;
  if (have != null) b.textContent = `Balance ${fmtUnits(have, 18, 4)} ${S.side === 'buy' ? 'ETH' : 'TAC'} · Max`;
  renderChips(); renderBorrow();
}
const BW = { key: '', at: 0, q: null, busy: false, mod: null };
const KIND_DP = { usd: 2, eth: 4 };
const BW_PLAIN = '<p class="bw-l">Borrow TACD or TACE against TAC. No interest, one fee.</p><p class="bw-a"><a class="bw-go" href="/vault/">Borrow against TAC →</a></p>';
function borrowHtml(q, tac) {
  const open = ['usd', 'eth'].map((k) => q?.[k]).filter((v) => v?.state === 'open');
  if (!open.length) {
    if (q && ['usd', 'eth'].every((k) => q[k]?.state === 'closed')) return '<p class="bw-l">Borrowing against TAC is not open right now.</p><p class="bw-a"><a class="bw-go" href="/vault/">See the vaults →</a></p>';
    const small = q?.usd?.state === 'small' ? q.usd : null;
    if (small && small.min != null) return `<p class="bw-l">Your ${esc(fmtUnits(tac, 18, 2))} TAC backs less than the smallest loan (${esc(fmtUnits(small.min, 18, 2))} TACD).</p><p class="bw-a"><a class="bw-go" href="/vault/">Borrow against TAC →</a></p>`;
    return BW_PLAIN;
  }
  const [a, b] = open, n = (v) => esc(fmtUnits(v.amount, 18, KIND_DP[v.key]));
  return `<p class="bw-l">${a.vault ? 'You can' : `Your <b>${esc(fmtUnits(tac, 18, 2))} TAC</b> can`} borrow up to <b>${n(a)} ${a.sym}</b></p>`
    + `<p class="bw-a"><a class="bw-go" href="${esc(a.href)}">Borrow ${n(a)} ${a.sym} →</a>${b ? `<a class="bw-alt" href="${esc(b.href)}">or ${n(b)} ${b.sym}</a>` : ''}</p>`;
}
function renderBorrow() {
  const el = $('#bw'), who = W.account, tac = S.bal?.tac;
  if (!el) return;
  if (!who || tac == null || tac === 0n) { setHtml(el, BW_PLAIN); return; }
  const key = `${lc(who)}:${tac}`;
  if (BW.q && BW.key === key) setHtml(el, borrowHtml(BW.q, tac));
  if ((BW.key === key && now() - BW.at < 60) || BW.busy) return;
  BW.busy = true;
  (BW.mod ||= import('/vault/quote.js?cb=5444fc51').catch((e) => { BW.mod = null; throw e; })).then((m) => m.quoteBorrow({ tac, account: who, rpc }))
    .then((q) => { BW.q = q; }, (e) => { console.warn('borrow quote:', e?.message || e); BW.q = null; })
    .then(() => { BW.key = key; BW.at = now(); })
    .finally(() => { BW.busy = false; if (W.account && `${lc(W.account)}:${S.bal?.tac}` === key) setHtml(el, borrowHtml(BW.q, tac)); else renderBorrow(); });
}
function renderGo() {
  const go = $('#go'), q = S.quote, buy = S.side === 'buy', wei = getAmount();
  go.disabled = false; go.title = '';
  if (!W.account) { go.textContent = 'Connect wallet'; return; }
  if (S.busy) { go.textContent = 'Working…'; go.disabled = true; return; }
  if (!wei) { go.textContent = 'Enter an amount'; go.disabled = true; return; }
  if (!routeOf(q) || !D.perEth) { go.textContent = S.shown && !q ? 'Updating the quote…' : 'Reading the pools…'; go.disabled = true; return; }
  const have = spendable();
  if (have != null && wei > have) { go.textContent = `Not enough ${buy ? 'ETH' : 'TAC'}`; go.disabled = true; return; }
  const P = planOf();
  if (!buy && S.bal && S.bal.eth != null && S.bal.eth < gasReserve(P, false)) { go.textContent = 'Add ETH for the network fee'; go.disabled = true; go.title = `About ${fmtUnits(gasReserve(P, false), 18, 5)} ETH is needed for the fee`; return; }
  if (buy && have != null && wei + gasReserve(P) > have) { go.textContent = 'Leave ETH for the network fee'; go.disabled = true; go.title = `About ${fmtUnits(gasReserve(P), 18, 5)} ETH stays for the fee: Max leaves it`; return; }
  go.textContent = buy ? 'Buy TAC' : 'Sell TAC';
  if (P.impact >= 0.1 && !acked(P)) { go.textContent = `Accept the loss to ${buy ? 'buy' : 'sell'} TAC`; go.disabled = true; go.title = 'Tick the box above to accept the price impact'; }
}
function planOf(q = S.quote) {
  const { wei, dir, buy, rt } = q;
  if (routeOf(q) === 'boards') {
    const bd = q.board, expected = D.perEth ? (buy ? Number(bd.spent) * D.perEth : Number(bd.spent) / D.perEth) : null;
    const floor = buildBoardFill({ plan: bd.plan, side: buy ? 'buy' : 'sell', token: TAC_ERC20, account: W.account || ZERO_ADDRESS, deadline: 0n, slipBps: S.slip }).minOut;
    return { via: 'boards', wei: bd.spent, dir, buy, board: bd, out: bd.out, floor, impact: expected ? Math.max(0, 1 - Number(bd.out) / expected) : 0, split: false };
  }
  const pick = rt.pick === 'split' ? rt.split : rt.single, out = BigInt(pick.amountOut);
  const expected = D.perEth ? (buy ? Number(wei) * D.perEth : Number(wei) / D.perEth) : null;
  return { via: 'pools', wei, dir, buy, rt, out, floor: (out * BigInt(10000 - S.slip)) / 10000n, impact: expected ? Math.max(0, 1 - Number(out) / expected) : 0, split: rt.pick === 'split' };
}
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// A loss accepted stands for the same trade while it is no larger: the minute's re-read that moves the figure a point either way does not take the tick away (a larger loss asks again).
const ackKey = (P) => `${P.dir}:${P.wei}`, ackPct = (P) => Math.round(P.impact * 100), acked = (P) => S.ack?.key === ackKey(P) && ackPct(P) <= S.ack.pct;
function detailsHtml(P) {
  const buy = P.buy, outU = buy ? 'TAC' : 'ETH', big = P.impact >= 0.1;
  return html`${P.impact >= 0.005 ? `<div class="kv"><span>Price impact</span><b class="${P.impact >= 0.05 ? 'err' : ''}">${(P.impact * 100).toFixed(P.impact < 0.1 ? 1 : 0)}%</b></div>` : ''}
    <div class="kv"><span>At least</span><b>${esc(fmtOut(P.floor, buy))} ${outU}</b></div>${feeHtml(P)}
    <div class="slip"><span class="mute">Slippage</span><div class="seg sm" id="slip-seg" role="group" aria-label="Slippage">${[[50, '0.5%'], [100, '1%'], [300, '3%']].map(([v, l]) => `<button type="button" data-slip="${v}" aria-pressed="${S.slip === v}">${l}</button>`).join('')}</div></div>
    ${big ? `<label class="ack"><input type="checkbox" id="ack"${acked(P) ? ' checked' : ''}><span>I accept losing about ${Math.round(P.impact * 100)}% of this ${buy ? 'purchase' : 'sale'} ${P.via === 'boards' ? 'against the Precision pool’s price' : 'to price impact. A smaller amount moves it less'}.</span></label>` : ''}`;
}
const ROUTE_GAS = { precision: [152000, 175000], 'tacit-amm': [131000, 130000], split: [261000, 315000] };
function feeHtml(P) {
  const units = (P.via === 'boards' ? null : ROUTE_GAS[P.split ? 'split' : P.rt.single.venue])?.[P.buy ? 0 : 1];
  if (!units || D.gasPrice == null) return '';
  const eth = Number(BigInt(units) * D.gasPrice) / 1e18, fee = usdOf(eth);
  const txt = fee == null ? `≈ ${sig(eth)} ETH` : fee < 0.01 ? 'under $0.01' : `≈ $${fee.toFixed(2)}`;
  return html`<div class="kv"><span>Network fee</span><b title="About ${grp(units, 0)} gas at ${sig(Number(D.gasPrice) / 1e9)} gwei, the gas price now">${txt}</b></div>`;
}
function walletRows() {
  const bal = S.bal ? `<div class="kv"><span>ETH</span><b class="num">${esc(fmtUnits(S.bal.eth ?? 0n, 18, 4))}</b></div><div class="kv"><span>TAC</span><b class="num">${esc(fmtUnits(S.bal.tac ?? 0n, 18, 2))}</b></div>` : '';
  const bk = bitcoin?.session.unlocked ? bitcoin.me : null, btcOpen = !!bitcoin?.session.unlocked;
  const onBtc = bk ? `<div class="kv"><span>Bitcoin</span><b class="addr-s">${esc(bk.address || '')}</b></div><div class="kv"><span>On Bitcoin</span><b class="num">${bk.sats != null ? esc(satsFmt(bk.sats)) : '—'} sats · ${bk.assetBase != null ? esc(tacFmt(Number(bk.assetBase) / 1e8)) : '…'} TAC <button class="linkbtn" type="button" data-btc-lock>Lock</button></b></div>`
    : btcOpen ? '<div class="kv"><span>Bitcoin</span><b>Loading…</b></div>'
    : pageWallet() ? `<div class="kv"><span>Bitcoin</span><b>${ME.pub ? 'Your Tacit wallet' : 'Not open'} <button class="linkbtn" type="button" data-btc-open>${ME.pub ? 'Show balances' : 'Open'}</button></b></div>` : '';
  return bal + onBtc;
}
function wireWalletSheet(root, close) {
  root.querySelector('[data-btc-lock]')?.addEventListener('click', () => { bitcoin?.lock(); close(); });
  root.querySelector('[data-btc-open]')?.addEventListener('click', (e) => { close(); S.book = 'mine'; mineAct('open', null); renderBook(); e.stopPropagation(); });
}

const farm = mountFarm($('#farm'), {
  ethCall, batch, rpc, api, wallet, W, connect: () => connectWallet(), fmtUnits, parseUnits, esc, usd, ethUsd: () => D.ethUsd, txLink, gasPrice: () => D.gasPrice,
  onDone: () => { readBalances().then(() => { renderBalance(); renderGo(); }); loadChain().then(paintAll).catch(() => {}); },
});

connect.restore();

{
  const stick = $('#stick'), ticket = $('.p-ticket');
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { stick.hidden = e.isIntersecting; }, { rootMargin: '0px 0px -40px 0px' }).observe(ticket);
  $('#stick-go').addEventListener('click', () => ticket.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function withTacAccess({ make, buy, permit, from, dl }) {
  let tx = make();
  if (!buy && tx.approval) {
    const [allowed, nonceRaw] = await Promise.all([ethCall(TAC_ERC20, '0xdd62ed3e' + word(BigInt(from)) + word(BigInt(tx.approval.spender))), permit ? ethCall(TAC_ERC20, '0x7ecebe00' + word(BigInt(from))) : null]);
    const have = wordAt(allowed, 0);
    const approve = async (said) => {
      say(said);
      const h = await wallet.sendTx({ to: TAC_ERC20, data: encErc20Approve(tx.approval.spender, tx.approval.amount), from });
      say(`Waiting for the approval ${txLink(h)}`);
      if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
    };
    if (have < tx.approval.amount) {
      if (permit) {
        say('Sign the permit for your TAC in your wallet. The signature costs nothing.');
        const nonce = wordAt(nonceRaw, 0);
        try {
          const sig = await wallet.signPermit({ token: TAC_ERC20, name: 'Tacit Token', spender: tx.approval.spender, value: tx.approval.amount, deadline: dl, nonce, owner: from });
          tx = make({ value: tx.approval.amount, deadline: dl, ...sig });
        } catch (e) {
          // A wallet that cannot sign a permit (a smart-contract account, or one without typed-data signing) approves the pool instead, and the trade goes without a signature. A "no" ends it.
          if (e?.userStopped || e?.code === 4001 || /account changed/i.test(e?.message || '')) throw e;
          await approve('Your wallet cannot sign a permit. Approve the TAC for this pool in your wallet.');
        }
      } else await approve('Approve the TAC for this pool in your wallet.');
    }
  }
  return tx;
}

async function preparePools(P, from) {
  const buy = P.buy, dir = P.dir;
  say('Reading the price again…');
  const rt = await venues.route({ dir, amountIn: P.wei, account: from, gasPrice: await gasPrice() });
  if (!rt.single) throw new Error('No pool can fill this right now.');
  const venue = P.rt.single.venue, pick = P.split ? rt.split : (rt.r.ranked || []).find((x) => x.venue === venue);
  if (!pick) { say('That route is no longer offered. Nothing was sent; press again for the new quote.'); requote(true); return null; }
  if (BigInt(pick.amountOut) < P.floor) { say('The price moved below the least you accept. Nothing was sent; the quote above is the new one.'); requote(true); return null; }
  const floorFor = (route) => { const f = (BigInt(route.amountOut) * BigInt(10000 - S.slip)) / 10000n; return f > P.floor ? f : P.floor; };
  const dl = chainDeadline(1200);
  const prepare = async (route) => {
    const isSplit = !!route.legs, floor = floorFor(route);
    const make = (permit) => (isSplit ? venues.buildSplit({ split: route, account: from, minOut: floor, deadline: dl, permit }) : venues.build({ quote: route, dir, account: from, minOut: floor, deadline: dl, permit }));
    const tx = await withTacAccess({ make, buy, permit: route.venue === 'precision' || isSplit, from, dl });
    say('Checking it first…');
    return { tx, sim: await venues.simulate({ tx, from }) };
  };
  let run = await prepare(pick);
  if (!run.sim.ok && P.split) {
    say('The split failed its check, so this goes to one pool.');
    if (BigInt(rt.single.amountOut) < P.floor) throw new Error('The price on one pool alone is below the least you accept. Nothing was sent.');
    run = await prepare(rt.single);
  }
  if (!run.sim.ok) throw new Error('This trade would fail, so nothing was sent. Try a smaller amount or try again.');
  return run.tx;
}

async function prepareBoards(P, from) {
  const buy = P.buy, side = buy ? 'buy' : 'sell';
  say('Reading the order book again…');
  const book = await readBook({ ethCall, base: TAC_ERC20, now: now() });
  const rows = new Map((buy ? book.asks : book.bids).map((o) => [o.key, o]));
  const orders = P.board.keys.map((k) => rows.get(k));
  const stop = (why) => { say(why); loadBoards().then(paintAll).catch(() => {}); requote(true); return null; };
  if (orders.some((o) => !o)) return stop('An order was filled or cancelled. Nothing was sent; the quote above is the new one.');
  const again = (buy ? planBoardBuy : planBoardSell)(orders, P.wei);
  const fine = again.fills.length ? await refineBoards({ ethCall, plan: again }) : null;
  if (!fine) return stop('These orders can no longer be filled together. Nothing was sent; the quote above is the new one.');
  if (fine.get < P.floor) return stop('The price moved below the least you accept. Nothing was sent; the quote above is the new one.');
  const dl = chainDeadline(1200);
  const make = (permit) => buildBoardFill({ plan: fine, side, token: TAC_ERC20, account: from, deadline: dl, slipBps: S.slip, permit, floor: P.floor });
  const tx = await withTacAccess({ make, buy, permit: true, from, dl });
  say('Checking it first…');
  if (!(await venues.simulate({ tx, from })).ok) throw new Error('This would fail, so nothing was sent. An order may have been filled; the order book is reloading.');
  return tx;
}

async function ethReceived(from, rc, eth0) {
  const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || 0), at = (bn) => rpc('eth_getBalance', [from, `0x${bn.toString(16)}`]).then(BigInt);
  let got = null;
  try { const bn = BigInt(rc.blockNumber), [before, after] = await Promise.all([at(bn - 1n), at(bn)]); got = after - before + fee; }
  catch { if (eth0 != null && S.bal?.eth != null && W.account?.toLowerCase() === from.toLowerCase()) got = S.bal.eth - eth0 + fee; }
  return got != null && got > 0n ? got : undefined;
}
async function sendAndReport(tx, { from, buy, P }) {
  say('Confirm the transaction in your wallet.');
  const eth0P = rpc('eth_getBalance', [from, 'latest']).then((x) => BigInt(x), () => null);
  const hash = await wallet.sendTx({ ...tx, from }), eth0 = await eth0P;
  say(`Sent ${txLink(hash)}. Waiting for it to land…`);
  const rc = await wallet.receipt(hash);
  if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
  let got;
  if (buy) { const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', me = '0x' + word(BigInt(from)); got = rc.logs.filter((l) => l.address.toLowerCase() === TAC_ERC20.toLowerCase() && l.topics[0] === T && l.topics[2]?.toLowerCase() === me).reduce((a, l) => a + BigInt(l.data), 0n); }
  await readBalances();
  if (!buy) got = await ethReceived(from, rc, eth0);
  const tacOut = buy ? got : P?.wei, ethOut = buy ? P?.wei : got;
  if (tacOut != null && ethOut != null) noteAct({ who: lc(from), lane: 'eth', kind: buy ? 'bought' : 'sold', tac: Number(tacOut) / 1e18, paid: Number(ethOut) / 1e18, unit: 'eth', tx: hash });
  S.seq++; S.quote = null; S.qfail = false; S.ack = null; S.amt = ''; S.pin = null; $('#amt').value = ''; fitAmt(); keepInHash();
  renderBalance(); renderQuote(null); renderVenues(null); renderPin();
  D.tradesStale = true; if (['trades', 'mine'].includes(bookTab())) ensureTrades(true); renderChart();
  loadChain().then(paintAll).catch(() => {});
  loadTapes({ coarse: false }).then(paintAll).catch(() => {});
  loadBoards().then(paintAll).catch(() => {});
  say(`<span class="ok">${buy ? 'Bought' : 'Sold'}.</span> ${got != null ? `${buy ? 'Received' : 'Received about'} ${esc(fmtUnits(got, 18, buy ? 2 : 6))} ${buy ? 'TAC' : 'ETH'} · ` : ''}${txLink(hash)}${buy && !tacAdded() ? ' · <button class="linkbtn" type="button" id="add-tac">Add TAC to your wallet</button>' : ''}${buy && got ? ` · <button class="linkbtn" type="button" id="farm-it" data-tac="${got}">Farm it</button>` : ''}`);
}

const TAC_ADDED = 'tacit-trade-tac-added';
const tacAdded = () => { try { return localStorage.getItem(TAC_ADDED) === '1'; } catch { return false; } };
$('#status').addEventListener('click', async (e) => {
  const f = e.target.closest('#farm-it');
  if (f) { f.disabled = true; if (!(await farm.use({ tac: BigInt(f.dataset.tac) }))) { f.disabled = false; f.textContent = 'Could not open the farm'; } return; }
  const b = e.target.closest('#add-tac');
  if (!b) return;
  b.disabled = true;
  if (await wallet.watchAsset({ address: TAC_ERC20, symbol: 'TAC', decimals: 18, image: `${location.origin}/tac-logo.png` })) {
    try { localStorage.setItem(TAC_ADDED, '1'); } catch { }
    b.replaceWith('Added to your wallet');
  } else { b.disabled = false; b.textContent = 'Not added. Try again'; }
});

async function execute(P) {
  if (S.busy || !W.account) return;
  const from = W.account;
  S.busy = true; lockTicket(); renderGo();
  try {
    const tx = await (P.via === 'boards' ? prepareBoards(P, from) : preparePools(P, from));
    if (tx) await sendAndReport(tx, { from, buy: P.buy, P });
  } catch (e) {
    say(`<span class="err">${esc(e instanceof UserStopped ? e.message : String(e.message || e).slice(0, 220))}</span>`);
  } finally { S.busy = false; lockTicket(); renderGo(); }
}
$('#go').addEventListener('click', () => {
  if (!W.account) { connectWallet(); return; }
  const wei = getAmount();
  if (!wei) return;
  if (!S.quote || S.quote.wei !== wei || S.quote.dir !== dirOf()) { clearTimeout(amtTimer); requote(); return; }
  if (!routeOf(S.quote)) return;
  const P = planOf();
  if (P.impact >= 0.1 && !acked(P)) return;
  say(''); execute(P);
});
$('#route').addEventListener('click', (e) => {
  const b = e.target.closest('[data-slip]');
  if (!b || S.busy) return;
  S.slip = Number(b.dataset.slip);
  try { localStorage.setItem('tacit-trade-slip', String(S.slip)); } catch { }
  if (S.quote) renderQuote(S.quote);
});
$('#route').addEventListener('change', (e) => {
  if (e.target.id !== 'ack' || !S.quote || !routeOf(S.quote)) return;
  const P = planOf();
  S.ack = e.target.checked ? { key: ackKey(P), pct: ackPct(P) } : null;
  renderGo();
});
$('#in-bal').addEventListener('click', () => {
  const have = spendable();
  if (have == null || S.busy) return;
  const v = S.side === 'buy' ? (have > gasReserve() ? have - gasReserve() : 0n) : have;
  S.amt = plain(v); $('#amt').value = S.amt; requote();
});
S.slip = (() => { try { const v = Number(localStorage.getItem('tacit-trade-slip')); return [50, 100, 300].includes(v) ? v : 50; } catch { return 50; } })();

let amtTimer = 0;
$('#amt').addEventListener('input', (e) => { S.amt = e.target.value; fitAmt(); clearTimeout(amtTimer); amtTimer = setTimeout(requote, 250); $('.p-ticket').classList.add('stale'); });
$('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled && !$('#go').hidden) $('#go').click(); });
$('#flip').addEventListener('click', () => {
  if (S.busy) return;
  const q = S.quote, via = q && routeOf(q), got = via === 'boards' ? q.board.out : via ? BigInt((q.rt.pick === 'split' ? q.rt.split : q.rt.single).amountOut) : null;
  $(`#side-seg [data-side="${S.side === 'buy' ? 'sell' : 'buy'}"]`).click();
  if (got) { const dp = S.side === 'buy' ? 6 : 2, u = 10n ** BigInt(18 - dp); S.amt = plain(got / u * u); $('#amt').value = S.amt; requote(); }
});
$('#side-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-side]');
  if (!b || b.dataset.side === S.side || S.busy) return;
  S.side = b.dataset.side; S.amt = ''; $('#amt').value = ''; fitAmt(); S.pin = null; renderPin(); renderBalance();
  $('#side-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.side === S.side)));
  requote(); renderQuote(null); renderVenues(null);
});
document.addEventListener('click', (e) => { const h = $('#hints'); if (h.open && !h.contains(e.target)) h.open = false; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#hints').open) { $('#hints').open = false; $('#hints summary').focus(); } });
$('#depth-note').addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { S.book = g.dataset.goto; renderBook(); } });
$('#book-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-book]'); if (b) { S.book = b.dataset.book; renderBook(); if (S.book === 'trades') ensureTrades(); } });
$('#ladders').addEventListener('click', (e) => {
  if (e.target.closest('[data-more]')) { S.bookAll = !S.bookAll; renderBook(); return; }
  if (e.target.closest('[data-more-trades]')) { S.tradesAll = !S.tradesAll; renderBook(); return; }
  const f = e.target.closest('[data-fill]'); if (f) { pinOrder(f.dataset.fill); return; }
  const m = e.target.closest('[data-mine]'); if (m) { mineAct(m.dataset.mine, m); return; }
  const k = e.target.closest('[data-btc]'); if (k) openBitcoin(bookPrime(k.dataset.btc, Number(k.dataset.i)));
});
const peekRow = (e) => { const r = e.target.closest?.('[data-btc][data-i]'); setPeek(r ? peekText(r.dataset.btc, Number(r.dataset.i)) : ''); };
$('#ladders').addEventListener('mouseover', peekRow); $('#ladders').addEventListener('focusin', peekRow);
$('#ladders').addEventListener('mouseleave', () => setPeek('')); $('#ladders').addEventListener('focusout', () => setPeek(''));
const warm = () => getBitcoin().then((b) => b.session.load()).catch(() => {});
$('#ladders').addEventListener('mouseover', (e) => { if (e.target.closest?.('[data-mine="open"],[data-mine="signin"]')) warm(); });
$('#ladders').addEventListener('focusin', (e) => { if (e.target.closest?.('[data-mine="open"],[data-mine="signin"]')) warm(); });
$('#pin').addEventListener('click', (e) => { if (e.target.closest('#unpin') && !S.busy) { S.pin = null; renderPin(); requote(); renderBook(); } });
$('#lane-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-lane]'); if (b) { chart.zoomOut(); S.lane = b.dataset.lane; keepChart(); renderChart(); } });
$('.p-chart').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.closest('#lane-seg')) return;
  if (b.dataset.zoomout != null) { chart.zoomOut(); return; }
  if (b.dataset.kind || b.dataset.tf || b.dataset.range != null) chart.zoomOut();
  if (b.dataset.kind) S.kind = b.dataset.kind; else if (b.dataset.unit) S.unit = b.dataset.unit; else if (b.dataset.tf) S.tf[S.lane] = Number(b.dataset.tf); else if (b.dataset.range != null) S.range = Number(b.dataset.range); else if (b.dataset.log) S.log = !S.log;
  keepChart(); renderChart();
});
function paintAll() { renderHead(); renderLanes(); renderChart(); renderBook(); renderPin(); renderAbout(); farm.paint(); renderBtcAlt(); if (S.quote) renderVenues(S.quote); }
renderQuote(null); renderVenues(null); renderControls(); renderAbout(); renderLanes();
const loads = [loadChain().then(paintAll), loadTapes().then(paintAll), loadBitcoin().then(paintAll), loadBoards().then(paintAll)];
setTimeout(warmFormatters, 0);
Promise.allSettled(loads).then((rs) => {
  D.readAt = now();
  if (rs.every((r) => r.status === 'rejected')) $('#chart').innerHTML = '<p class="chart-empty">Could not read the pools. Try again in a moment.</p>';
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('btc') === 'on' || params.get('btc') === 'off') { try { localStorage.setItem('tacit-trade-btc', params.get('btc') === 'on' ? '1' : '0'); } catch { } renderBook(); }
  if (params.get('side') === 'sell') $('#side-seg [data-side="sell"]').click();
  S.ready = true; retrySoon();
  openBitcoinHash(params.get('btc'));
  if (W.account) ensureTrades();
  if (params.get('amount')) { S.amt = params.get('amount'); $('#amt').value = S.amt; requote(); } else keepInHash();
  paintAll();
});
// #btc=buy, #btc=sell or #btc=list (a link from another page) opens the Bitcoin market on that side
function openBitcoinHash(how) {
  if (!['buy', 'sell', 'list'].includes(how) || !btcOn()) return;
  openBitcoin(how === 'list' ? { side: 'sell', type: 'limit' } : { side: how, type: 'market' });
}
addEventListener('hashchange', () => {
  if (!S.ready || S.busy) return;
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  openBitcoinHash(params.get('btc'));
  if (!params.has('side') && !params.has('amount')) return;
  const side = params.has('side') ? (params.get('side') === 'sell' ? 'sell' : 'buy') : S.side;
  if (side !== S.side) $(`#side-seg [data-side="${side}"]`).click();
  const amount = params.get('amount');
  if (amount != null && amount !== S.amt) { S.amt = amount; $('#amt').value = amount; S.pin = null; renderPin(); requote(); }
});
let polls = 0, polledAt = now();
function poll(back = false) {
  if (document.hidden) return;
  const n = ++polls, full = back || n % 5 === 0, lists = back || n % 2 === 0 || ['btc', 'mine'].includes(bookTab());
  polledAt = now();
  const reads = [loadChain(), loadTapes({ coarse: full }), loadBitcoin({ lists }), loadBoards()];
  for (const read of reads) read.then(paintAll, paintAll);
  if (D.retrying) Promise.allSettled(reads).then(() => { D.retrying = false; paintAll(); });
  if ((S.quote || S.qfail) && !S.busy && !S.refreshing) requote(true);
  if (W.account && !S.busy) readBalances().then(() => { renderBalance(); renderGo(); });
  if (!farm.busy()) farm.refresh();
  if (bookTab() === 'trades') ensureTrades(true); else if (W.account && n % 5 === 0) ensureTrades();
  if (bitcoin?.session.unlocked && !bitcoin.isOpen) bitcoin.refresh().catch(() => {});
}
setInterval(poll, 60e3);
document.addEventListener('click', (e) => { const b = e.target.closest('[data-retry]'); if (b && !D.retrying) { D.retrying = true; b.disabled = true; b.textContent = 'Trying…'; poll(true); } });
let sooner = 0;
function retrySoon() {
  if (sooner >= 3 || !(D.chainFailed || D.tapeFailed || D.btcFailed || D.bookFailed)) return;
  setTimeout(() => { sooner++; poll(true); retrySoon(); }, 5000 * (sooner + 1));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && now() - polledAt >= 60) poll(true); });

