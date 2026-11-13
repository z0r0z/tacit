import { keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeEvmTradeVenues, _internal as V, MULTICALL3 } from '/evm-trade-venues.js?cb=c9a3c2e7';
import { UserStopped } from '/trade/wallet.js?cb=5d19a733';
import { declinedWords } from '/wallet-prompts.js';
import { rpc, API, api, esc, fmtUnits, parseUnits, plain, usd, sig, E10, E18, ago } from '/trade/util.js?cb=1d2cd8d3';
import { nodeHealth, hedgeDelay } from '/trade/rpc.js';
import * as R from '/swap/route.js?cb=44449874';
import * as A from '/swap/aggregate.js?cb=67d0c300';
import * as SV from '/swap/solvers.js?cb=669b2617';
import { linkName, linkSides } from '/swap/link.js?cb=00bf0557';
import { routeLine } from '/swap/route-name.js?cb=2a0317f3';
import { calmText } from '/relay-outcome.js?cb=17e48a9a';
import * as GR from '/gas-relay.js?cb=e8d173a8';
import { checkSnwapCall, SNWAP_EXECUTORS, SAFE_EXECUTOR } from '/zrouter-guard.js';
import { rewardPop } from '/reward-pop.js?cb=88973dac';
import { makePointsNote } from '/points-note.js?cb=40738db7';
import { aprText, readPrecision, readSpot, privateFarms } from '/trade/farm-read.js?cb=efe1d81e';
import { SERVED } from '/evm-pool-tokens.js?cb=16e0e196';
import { netPicker } from '/net-pick.js?cb=9229f173';
import { addrView, addrFlat } from '/address-view.js?cb=58dd4914';

const CHAINLINK = { eth: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btc: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
const PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E';
const CETH_ID = R.POOL_ID[R.ZERO];
const now = () => Math.floor(Date.now() / 1000);
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordAt = (h, i) => BigInt('0x' + (strip(h).slice(i * 64, (i + 1) * 64) || '0'));
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
const lc = (a) => String(a).toLowerCase();

const NODES = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7', 'https://1.rpc.thirdweb.com'];
const SCAN_NODES = ['https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io', 'https://ethereum-rpc.publicnode.com'];
const memory = (() => { try { return localStorage; } catch { return null; } })();
const health = nodeHealth({ store: memory }), scanHealth = nodeHealth({ store: memory, key: 'tacit-rpc-rest-scan-v1', strict: true });
const WALLET_READS = new Set(['eth_call', 'eth_getBalance', 'eth_gasPrice', 'eth_blockNumber', 'eth_getCode', 'eth_getTransactionReceipt']);
const walletNode = {
  id: 'wallet',
  usable: (m, p) => WALLET_READS.has(m) && typeof W?.prov?.request === 'function' && !W.prov.isWalletConnect && W.prov.chainId === '0x1' && !(m === 'eth_call' && (p[0]?.gas || p[2])),
  send: (m, p) => W.prov.request({ method: m, params: p }),
};
const light = (method, params) => rpc(method, params, [...NODES, walletNode], { health, hedgeMs: hedgeDelay(1000) });
const heavy = (method, params) => rpc(method, params, SCAN_NODES, { health: scanHealth, hedgeMs: hedgeDelay(1500) });
export const ethCall = (to, data, block = 'latest', o = {}) => (o.gas ? heavy : light)('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: '0x' + BigInt(o.value).toString(16) } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block, ...(o.state ? [o.state] : [])]);
export const batch = async (calls) => V.decAggregate3(await ethCall(MULTICALL3, V.encAggregate3(calls)), calls.length);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
const standIn = () => '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('');
const within = (p, ms, why) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);
const PN = makePointsNote({ read: () => (H.today ? H.today() : fetch('https://api.tacit.finance/leaderboard?day=today&limit=1', { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null))) });
const noteOf = (x, q) => [x.note, ptsTag(rowPts(x, q))].filter(Boolean).join(/class="splitbar"/.test(x.note || '') ? '' : ' · ');
const ghostNote = (k, buy, wei) => {
  const pts = (w) => (buy && ptsFor('zswap', w) ? `<span style="visibility:hidden">${ptsTag({ pts: 100, floor: true })}</span>` : '');
  const note = k === 'split' ? `<span class="splitbar ghost" aria-hidden="true"><span></span></span>${pts((wei || 0n) / 2n)}` : k === 'precision' ? pts(wei || 0n) : '';
  return note ? `<small aria-hidden="true">${note}</small>` : '';
};
const PTS_SRC = new Set([0, 1, 3, 4, 8]);
function ptsFor(act, wei) {
  if (!(wei > 0n)) return null;
  const p = H.points?.(act, Number(wei) / 1e18);
  if (p !== undefined) return p?.pts >= 1 ? p : null;
  const n = PN.est(wei, act === 'zswap' ? 'zswapeth' : act === 'wrap' ? 'wrap' : 'evmpooldeposit');
  return n >= 1 ? { pts: n, floor: true } : null;
}
function rowPts(x, q) {
  if (!x || !q) return null;
  if (q.dir === 'ETH_TO_TAC') return ptsFor('zswap', x.k === 'precision' ? q.wei : x.k === 'split' ? x.split?.legs?.[0]?.amountIn : 0n);
  if (x.agg && isEth(lc(x.agg.tokenIn))) return ptsFor('zswap', (x.agg.kind === 'twohop' ? x.agg.legs.slice(0, 1) : x.agg.legs || []).reduce((t, l) => t + (PTS_SRC.has(l.source) ? l.amountIn : 0n), 0n));
  if (x.pin) return ptsFor('wrap', q.ethIn);
  if (x.priv && !x.pout && q.kind === 'private' && isEth(S.pay)) return ptsFor('wrap', q.wei);
  return null;
}
const laterPts = (q, r) => (!q || r?.hop ? null : ptsFor('dev', laterDeposit(q)));
const ptsSaid = (p, word = true) => (p ? `${p.floor ? '' : '≈ '}${Math.round(p.pts).toLocaleString('en-US')}${p.floor ? '+' : ''}${word ? ' points' : ''}` : '');
const AVOID = new Map();
const poolFloor = (x, slip = S.slip) => (x * (10000n - BigInt(Math.max(Number(slip) || 0, 100)))) / 10000n;
const splitBar = (sh) => `<span class="splitbar" role="img" aria-label="${sh}% Precision pool, ${100 - sh}% Tacit pool"><span class="pp" style="flex:${Math.max(sh, 8)}">Precision ${sh}%</span><span class="tp" style="flex:${Math.max(100 - sh, 8)}">Tacit ${100 - sh}%</span></span>`;
const TAC_MARK = '<svg class="tk xs" aria-hidden="true"><use href="#tk-tac"/></svg>';
const ptsTag = (p, word = true) => (p ? `<span class="pt">${TAC_MARK}${ptsSaid(p, word)}</span>` : '');
const reward = (p) => { if (p?.pts >= 1) rewardPop($('#go'), { pts: p.pts }); return true; };
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;

const TETH = { sym: 'tETH', name: 'Ether, private', addr: 'teth', dec: 18, icon: 'teth', priv: true };
const CUSTOM_KEY = 'tacit-swap-tokens-v1';
const S = {
  toTacit: null, toTacitBad: '', toTacitBusy: false, toName: null, toBusy: false,
  inP: false, outP: false, btc: false, at: { pay: null, get: null }, mk: null, mq: null, pay: lc(R.ZERO), get: lc(R.TAC), amt: '', slip: 50, pick: null, hold: false, q: null, seq: 0, busy: false, ack: false,
  custom: [], bal: {}, px: {}, gasPrice: null, chainT: 0, chainAt: 0, farms: null, lastBuy: null, note: '', ackKey: '', to: null, toOpen: false, toBad: '', ammRoute: null,
};
let ROOT = null, H = {}, wallet = null, W = {};
const paced = (k) => { try { H.pace?.(k); } catch { } };
const $ = (s) => ROOT.querySelector(s);
const setHtml = (el, h) => { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } };
const changed = () => H.onChange?.();
const RECENT_KEY = 'tacit-swap-recent-v1';
let RECENT = [];
try { RECENT = (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter((r) => /^0x[0-9a-f]{64}$/.test(r?.h) && Number.isFinite(r.t) && typeof r.s === 'string').slice(0, 8); } catch { }
function remember(h, s) {
  RECENT = [{ h, s: s.slice(0, 120), t: now() }, ...RECENT.filter((r) => r.h !== h)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(RECENT)); } catch { }
}
function paintRecent() {
  if (!$('#recent')) return;
  $('#recent').hidden = !RECENT.length;
  $('#recent-l').innerHTML = RECENT.map((r) => `<li><a href="https://etherscan.io/tx/${esc(r.h)}" target="_blank" rel="noopener noreferrer">${esc(r.s)}</a><time>${esc(ago(r.t))}</time></li>`).join('');
}
const SLIP_KEY = 'tacit-swap-slip-v1';
try { const v = Number(localStorage.getItem(SLIP_KEY)); if ([10, 50, 100, 300].includes(v)) S.slip = v; } catch { }
try { S.custom = (JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]') || []).filter((t) => /^0x[0-9a-f]{40}$/.test(t?.addr) && Number.isInteger(t.dec)).slice(0, 20); } catch { }
const TL = { rows: [], at: 0, p: null };
const SKIP = new Set(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84']);
const LOGO = {};
const okLogo = (l) => (typeof l === 'string' && /^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(l) && l.length < 40000 ? l : null);
function takeList(rows, uni = []) {
  const out = [], have = new Set();
  for (const o of rows || []) {
    const a = lc(o?.a || ''), logo = okLogo(o?.l);
    if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
    if (logo && (o.c === 1 || o.c === 0)) LOGO[a] ||= logo;
    if (o.c !== 1 || o.p !== 'ERC-20' || !o.v || SKIP.has(a) || !Number.isInteger(o.d) || o.d > 36) continue;
    out.push({ sym: String(o.s || '?').slice(0, 12), name: String(o.n || '').slice(0, 40), addr: a, dec: o.d }); have.add(a);
  }
  for (const o of uni || []) {
    const a = lc(o?.a || '');
    if (!/^0x[0-9a-f]{40}$/.test(a) || have.has(a) || SKIP.has(a) || !Number.isInteger(o.d) || o.d > 36) continue;
    if (o.l === 1) LOGO[a] ||= `/swap/logos/${a}.webp`;
    out.push({ sym: String(o.s || '?').slice(0, 12), name: String(o.n || '').slice(0, 40), addr: a, dec: o.d, uni: true }); have.add(a);
  }
  TL.rows = out;
}
try { localStorage.removeItem('tacit-swap-list-v1'); } catch { }
async function checkAmmRoute() {
  const v = await R.ammRouteLive({ ethCall }).catch(() => null);
  if (v == null || v === S.ammRoute) return;
  const was = `${S.pay}>${S.get}:${kindOf(S.pay, S.get)}`;
  S.ammRoute = v;
  if (S.busy) return;
  fit('pay'); paint();
  if (S.q && `${S.pay}>${S.get}:${kindOf(S.pay, S.get)}` !== was) requote(true);
}
function loadList() {
  if (TL.at) return Promise.resolve();
  return (TL.p ||= (async () => {
    const [{ LIST }, { UNI }] = await Promise.all([import('/swap/tokens.js?cb=73f33d2c'), import('/swap/uni-tokens.js?cb=866feaad')]);
    takeList(LIST, UNI); TL.at = Date.now();
    paintSides(); if (W.account) readBalances(false).then(paintSides);
  })().catch(() => {}).finally(() => { TL.p = null; }));
}
const pooled = (k) => !!SERVED[k];
const tacitPooled = (k) => isEth(k) || tacitKey(k) || pooled(k);
let LISTED = { rows: null, custom: null, list: [], by: new Map() };
const listed = () => {
  if (LISTED.rows !== TL.rows || LISTED.custom !== S.custom) {
    const known = R.TOKENS.map((t) => ({ ...t, addr: lc(t.addr) })), have = new Set(known.map((t) => t.addr));
    const list = [...known, ...TL.rows.filter((t) => !have.has(t.addr) && (have.add(t.addr), true)), ...S.custom.filter((t) => !have.has(t.addr))];
    LISTED = { rows: TL.rows, custom: S.custom, list, by: new Map(list.map((t) => [t.addr, t])) };
  }
  return LISTED.list;
};
const listedAt = (k) => (listed(), LISTED.by.get(k)) || null;
const BALQ = new Set();
const sidePriv = (k) => (k === S.pay ? S.inP : k === S.get ? S.outP : false);
const tokenOf = (k, priv = sidePriv(k)) => { const t = k === 'teth' ? TETH : listedAt(k); return t?.psym && priv ? { ...t, sym: t.psym } : t; };
const nameIs = (t, x) => lc(t.sym) === x || (t.psym && lc(t.psym) === x);
const isEth = (k) => k === lc(R.ZERO);
const tacitKey = (k) => R.tacitToken(k);
const POOLID = (k) => (k === 'teth' ? CETH_ID : R.POOL_ID[Object.keys(R.POOL_ID).find((a) => lc(a) === k)]);

const LT_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', LT_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', LT_ZAP = '0x0000008EbBF2323f95c4fBc18254f3D65C53998c';
const NOT_A_WALLET = new Set([LT_POOL, LT_ROUTER, LT_ZAP, R.ZERO, R.TAC, R.CUSD, R.CBTC, R.WETH, R.ZROUTER, R.ZQUOTER, R.PERMIT2, R.PRECISION_ROUTE, R.PRECISION_GUARD, R.TACIT_AMM, R.TACIT_AMM_ROUTE, R.CONF_ROUTER, PRECISION_POOL, MULTICALL3, SAFE_EXECUTOR, ...Object.keys(SNWAP_EXECUTORS)].map(lc));
const checksum = (a) => {
  const body = lc(a).slice(2), h = Array.from(keccak_256(new TextEncoder().encode(body)), (x) => x.toString(16).padStart(2, '0')).join('');
  return '0x' + [...body].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
};
function recipientOf(text) {
  const t = String(text || '').trim();
  if (!t) return { addr: null, bad: '' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { addr: null, bad: 'Paste a full 0x address.' };
  if (/[a-f]/.test(t.slice(2)) && /[A-F]/.test(t.slice(2)) && t !== checksum(t)) return { addr: null, bad: 'The capitals do not match this address’s checksum. Check it.' };
  if (NOT_A_WALLET.has(lc(t)) || listed().some((x) => lc(x.addr) === lc(t))) return { addr: null, bad: 'That is a contract this swap uses. Send to a wallet.' };
  return { addr: lc(t), bad: '' };
}
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const who = (a) => (a && S.toName && S.toName.addr === lc(a) ? S.toName.name : shortAddr(a));
const shortAddrH = (a) => addrView(a, 4, 6);
const whoH = (a) => (a && S.toName && S.toName.addr === lc(a) ? esc(S.toName.name) : shortAddrH(a));
const htmlVal = (html) => ({ html });
const cell = (v) => (v && v.html != null ? v.html : esc(v));
const isName = (t) => /^[^\s/@]+\.(eth|wei|gwei)$/i.test(t);
let namesP = null;
const names = () => (namesP ||= Promise.all([import('/confidential-names.js?cb=d41cb8bd'), import('/vendor/tacit-deps.min.js')])
  .then(([n, d]) => n.makeConfidentialNames({ call: n.makeMainnetCall(), secp: d.secp, keccak256: d.keccak_256 })).catch((e) => { namesP = null; throw e; }));
const tacitName = (t) => t.name || `tacit1…${String(t.pubHex).slice(-6)}`;
const recipient = () => (S.to && !S.inP && !S.outP && lc(S.to) !== lc(W.account || '') ? S.to : null);
const outTo = () => (kindOf(S.pay, S.get) === 'pout' ? S.to || (W.account ? lc(W.account) : null) : null);

const POOL_COINS = ['teth', lc(R.TAC), lc(R.CUSD), lc(R.CBTC)];
const inPool = (k) => POOL_COINS.includes(k);
const isListed = (k) => !!listedAt(k);
function kindOf(pay, get, inP = S.inP, outP = S.outP) {
  if (arguments.length < 3 && (S.at.pay || S.at.get)) return null;
  if (inP && outP) return inPool(pay) && inPool(get) && pay !== get ? 'private' : null;
  if (outP) {
    if (!inPool(get)) return null;
    if (isEth(pay)) return 'private';
    return isListed(pay) && !tacitKey(pay) && pay !== lc(R.WETH) ? 'pin' : null;
  }
  if (inP) return inPool(pay) && (isEth(get) || (isListed(get) && !tacitKey(get) && get !== lc(R.WETH))) ? 'pout' : null;
  if (pay === get || get === 'teth' || pay === 'teth') return null;
  if ((isEth(pay) && get === lc(R.TAC)) || (isEth(get) && pay === lc(R.TAC))) return 'tac';
  if ((isEth(pay) && (get === lc(R.CUSD) || get === lc(R.CBTC))) || (isEth(get) && (pay === lc(R.CUSD) || pay === lc(R.CBTC)))) return 'amm';
  const tin = tacitKey(pay), tout = tacitKey(get);
  if (get === lc(R.TAC) && !tin) return 'any';
  if (tin && !tout) return isListed(get) ? 'out' : null;
  if (!tin && tout) return pay !== lc(R.WETH) && (get === lc(R.CUSD) || get === lc(R.CBTC)) && S.ammRoute === true ? 'in' : null;
  const wrapPair = [pay, get].every((k) => isEth(k) || k === lc(R.WETH));
  return isListed(pay) && isListed(get) && !wrapPair && !(tin && tout) ? 'agg' : null;
}
const outRoute = (k) => (inPool(k) ? 'pool' : S.inP ? (kindOf(S.pay, k, true, false) === 'pout' ? 'out' : null) : !isEth(k) && laterPair(kindOf(S.pay, k, false, false), S.pay, k) ? 'later' : null);
const hidden = () => LATER.on && !S.inP && !S.outP && !inPool(S.get) && outRoute(S.get) === 'later';
const getPriv = () => S.outP || hidden();

const moving = () => !!H.moves;
const atOf = (side) => S.at[side] || ((side === 'pay' ? S.inP : S.outP) ? 'defi' : 'wallet');
const isPrivAt = (at) => at === 'defi' || at === 'pay' || at === 'chain';
const onChain = () => moving() && !!H.moves.onChain?.();
const sameCoin = (a, b) => a === b || [a, b].every((k) => isEth(k) || k === 'teth');
const native = (pay, pa, get, ga) => ((pa === 'wallet' || pa === 'defi') && (ga === 'wallet' || ga === 'defi') ? kindOf(pay, get, pa === 'defi', ga === 'defi') : null);
const sameMoney = (a, b) => sameCoin(a, b) || (a === lc(R.TAC) && b === lc(R.TAC));
function moveOf(pay = S.pay, pa = atOf('pay'), get = S.get, ga = atOf('get')) {
  if (!moving()) return null;
  const k = H.moves.key(pay, pa, get, ga);
  return k && (sameMoney(pay, get) || !native(pay, pa, get, ga)) ? k : null;
}
const lanePair = (pay, pa, get, ga) => moving() && !!$('#btc') && pa === 'btc' && ga === 'btc' && !sameMoney(pay, get);
const pairOk = (pay, pa, get, ga) => !!(native(pay, pa, get, ga) || moveOf(pay, pa, get, ga) || lanePair(pay, pa, get, ga) || exitOf(pay, pa, get, ga));
const USDC_K = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT_K = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const PAY_COINS = [lc(R.ZERO), USDC_K, USDT_K, lc(R.TAC)];
const WALLET_MARK = '<svg class="pl" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.2h9.6a1.4 1.4 0 0 1 1.4 1.4v6.6a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4V3.6a1.4 1.4 0 0 1 1.4-1.4h7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10.6" cy="9" r=".95" fill="currentColor"/></svg>';
const POOL_MARK = '<svg class="pl" viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="4.4" rx="5" ry="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 4.4v3.6c0 1.1 2.2 2 5 2s5-.9 5-2V4.4M3 8v3.6c0 1.1 2.2 2 5 2s5-.9 5-2V8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const MARK_USE = { pay: 'tk-peth', btc: 'c-btc', chain: 'tk-tac' };
const placeMark = (at) => (at === 'wallet' ? WALLET_MARK : at === 'defi' ? POOL_MARK : MARK_USE[at] ? `<svg class="tk xs" aria-hidden="true"><use href="#${MARK_USE[at]}"/></svg>` : '');
const KIND = { wallet: 'wallet', defi: 'private', pay: 'private', chain: 'private', btc: 'bitcoin' };
const KIND_NAME = { wallet: 'Wallet', private: 'Private', bitcoin: 'Bitcoin' };
const KIND_NOTE = { wallet: 'Public, in your wallet. Swaps use the best public liquidity.', bitcoin: 'TAC and tETH at your Bitcoin address.' };
const KIND_TIP = { wallet: 'Your wallet: public, on Ethereum', bitcoin: 'Bitcoin: TAC and tETH at your Bitcoin address', private: 'Private: tETH, TAC, cUSD and cBTC to swap, farm and borrow with (the DeFi pool), and ETH, USDC, USDT and TAC to pay anyone with (the Pay pool)' };
const PLACE_TIP = { wallet: 'Your wallet: public, on Ethereum', pay: 'Pay pool: ETH, USDC, USDT and TAC held privately, proved on this device and paid out to any address',
  defi: 'DeFi pool: tETH, TAC, cUSD and cBTC held privately, to swap, farm and borrow with', btc: 'Bitcoin: TAC and tETH at your Bitcoin address',
  chain: 'Tacit chain: TAC held privately on its own chain, paid to anyone there' };
const payPool = (k) => PAY_COINS.includes(k);
const exitOut = (pay, get) => (get === pay ? !isEth(pay) : isEth(get) || get === lc(R.TAC) || (isListed(get) && !tacitKey(get) && get !== lc(R.WETH)));
const exitOf = (pay = S.pay, pa = atOf('pay'), get = S.get, ga = atOf('get')) => {
  if (moving() && pa === 'wallet' && ga === 'pay' && payPool(get) && !isEth(get) && (isEth(pay) || (isListed(pay) && !tacitKey(pay) && pay !== lc(R.WETH) && pay !== get && (get === USDC_K || get === USDT_K)))) return { pay, get, into: true, wallet: true };
  if (!moving() || pa !== 'pay' || !payPool(pay) || (isEth(pay) && (H.moves.chain ?? 1) !== 1)) return null;
  if (ga === 'pay') return payPool(get) && get !== pay && (!isEth(get) || (H.moves.chain ?? 1) === 1) ? { pay, get, into: true } : null;
  return ga === 'wallet' && exitOut(pay, get) && !moveOf(pay, pa, get, ga) ? { pay, get } : null;
};
const intoPool = () => !!exitOf()?.into;
const exiting = () => !!exitOf();
const PLACES = ['defi', 'wallet', 'pay', 'btc', 'chain'];
const goes = (side, k, at) => PLACES.some((oa) => placeCoins(side === 'pay' ? 'get' : 'pay', oa).some((o) => (side === 'pay' ? pairOk(k, at, o, oa) : pairOk(o, oa, k, at))));
const placed = () => moving() && !!(S.at.pay || S.at.get || moveOf());
const LADDER = { wallet: 0, btc: 0, pay: 1, defi: 1, chain: 2 };
let FLOW = null;
function flowGet(k, at) {
  if (FLOW === 'withdraw') {
    if (at === 'chain' && atOf('get') === 'defi' && pairOk(k, at, k, 'defi')) return [k, 'defi'];
    const w = coinAt(k, 'wallet'); return isPrivAt(at) && pairOk(k, at, w, 'wallet') ? [w, 'wallet'] : null;
  }
  if (at === 'defi') return pairOk(k, at, coinAt(k, 'chain'), 'chain') ? [coinAt(k, 'chain'), 'chain'] : null;
  if (at !== 'wallet') return null;
  const cur = isPrivAt(atOf('get')) ? atOf('get') : 'defi';
  for (const h of [cur, ...['defi', 'pay', 'chain'].filter((x) => x !== cur)]) { const g = coinAt(k, h); if (sameMoney(k, g) && pairOk(k, 'wallet', g, h)) return [g, h]; }
  if (FLOW === 'shield' && !tacitKey(k) && isListed(k) && pairOk(k, 'wallet', 'teth', 'defi')) return ['teth', 'defi'];
  return null;
}
function flowFit() { const g = flowGet(S.pay, atOf('pay')); if (!g) return false; setAt('get', g[1]); S.get = g[0]; return true; }
const FLOW_PAIR = { shield: { from: 'ETH', to: 'tETH', private: 'to' }, withdraw: { from: 'tETH', to: 'ETH', private: 'from' } };
function coinAt(k, at) {
  if (at === 'defi') return isEth(k) ? 'teth' : inPool(k) ? k : 'teth';
  if (at === 'wallet') return k === 'teth' ? lc(R.ZERO) : k;
  if (at === 'pay') return payPool(k) ? k : lc(R.ZERO);
  if (at === 'chain') return lc(R.TAC);
  return isEth(k) || k === 'teth' ? 'teth' : lc(R.TAC);
}
const chainLive = () => !!H.moves?.chainLive?.();
const placeCoins = (side, at) => (at === 'chain' ? (onChain() ? [lc(R.TAC)] : []) : at === 'pay' ? (side === 'get' && chainLive() ? PAY_COINS.filter((k) => k !== lc(R.TAC)) : PAY_COINS) : at === 'btc' ? [lc(R.TAC), 'teth'] : at === 'defi' ? POOL_COINS : [lc(R.ZERO), lc(R.TAC)]);
function setAt(side, at) {
  S.at[side] = at === 'pay' || at === 'btc' || at === 'chain' ? at : null;
  if (side === 'pay') S.inP = at === 'defi';
  else { S.outP = at === 'defi'; if (at !== 'wallet') LATER.on = false; }
}
function mend(changed) {
  if (pairOk(S.pay, atOf('pay'), S.get, atOf('get'))) return true;
  const o = changed === 'pay' ? 'get' : 'pay', at = atOf(o), cur = o === 'pay' ? S.pay : S.get;
  for (const a of [at, ...PLACES.filter((x) => x !== at)]) {
    for (const k of [coinAt(cur, a), ...placeCoins(o, a)]) {
      if (o === 'pay' ? pairOk(k, a, S.get, atOf('get')) : pairOk(S.pay, atOf('pay'), k, a)) { setAt(o, a); if (o === 'pay') S.pay = k; else S.get = k; return true; }
    }
  }
  return false;
}
function setHome(home) {
  if (S.busy || atOf('get') === home) return;
  const was = S.get, wasAt = atOf('get');
  setAt('get', home); S.get = coinAt(was, home);
  if (!pairOk(S.pay, atOf('pay'), S.get, home)) { setAt('get', home === 'pay' ? 'defi' : home === 'defi' ? 'pay' : wasAt); S.get = coinAt(was, atOf('get')); }
  const way = FLOW && (LADDER[atOf('get')] > LADDER[atOf('pay')] ? 'shield' : 'withdraw');
  if (way && way !== FLOW) { setFlowNow(way); H.onFlow?.(way); }
  S.amt = fitAmt(S.amt);
  S.q = null; S.mq = null; changed(); paint(); requote(true);
}
const CHAIN_MARK = { 1: 'c-eth', 8453: 'c-base', 4663: 'c-rh' }, CHAIN_NAME = { 4663: 'Robinhood Chain' };
function chainMarks(cs) {
  if (!cs.every((c) => CHAIN_MARK[c.id])) return `${cs.length} chains`;
  const names = esc(cs.map((c) => CHAIN_NAME[c.id] || c.name).join(', '));
  return `<span class="cm" role="img" aria-label="${names}" title="${names}">${cs.map((c) => `<svg class="tk" aria-hidden="true"><use href="#${CHAIN_MARK[c.id]}"/></svg>`).join('')}</span>`;
}
let HOMES_OPEN = false;
function homesHtml() {
  if (takesOut()) return outHtml(atOf('pay'));
  if (!moving() || !isPrivAt(atOf('get'))) return '';
  const pa = atOf('pay'), eth = isEth(S.get) || S.get === 'teth', tac = S.get === lc(R.TAC);
  if (!eth && !tac) return '';
  const dk = eth ? 'teth' : lc(R.TAC), pk = eth ? lc(R.ZERO) : lc(R.TAC);
  const ch = tac && pairOk(S.pay, pa, lc(R.TAC), 'chain');
  const noPay = tac && chainLive();
  if (!pairOk(S.pay, pa, dk, 'defi') || (!noPay && !pairOk(S.pay, pa, pk, 'pay')) || (noPay && !ch)) return '';
  const at = atOf('get'), cs = eth ? H.moves.chains?.() || [] : [], where = cs.length > 1 ? chainMarks(cs) : 'Ethereum';
  const wei = isEth(S.pay) && pa === 'wallet' ? parseUnits(S.amt, 18) || 0n : null;
  const cue = (act) => { const p = wei == null ? null : ptsFor(act, wei > 0n ? wei : 10n ** 18n); return `<span class="ra">${p ? `<span>${ptsTag(p, false)}</span><small>${wei > 0n ? 'points' : 'points/ETH'}</small>` : ''}</span>`; };
  const open = HOMES_OPEN || ch;
  const row = (home, t, sub, icon, act) => `<button type="button" role="radio" class="c${open ? '' : ' one'}" data-home="${home}" aria-checked="${String(at === home)}" tabindex="${at === home ? 0 : -1}"><svg class="tk" aria-hidden="true"><use href="#tk-${icon}"/></svg><span class="rt"><b>${t}</b><small>${sub}</small></span>${cue(act)}${open ? '<span class="rd" aria-hidden="true"></span>' : ''}</button>`;
  const defi = row('defi', 'Swap, farm, borrow', 'DeFi pool', eth ? 'teth' : 'tac', 'wrap'), pay = noPay ? '' : row('pay', 'Pay anyone', `Pay pool · ${where}`, eth ? 'peth' : 'tac', 'dev');
  const chain = ch ? row('chain', 'Fast private TAC', 'Tacit chain · quick sends, about a cent each', 'tac', null) : '';
  if (!open) return `<div class="rows-h"><span>Use it to</span><span class="chg" aria-hidden="true">Change</span></div>${at === 'pay' && pay ? pay : at === 'chain' ? chain : defi}`;
  return `<div class="rows-h"${HOMES_OPEN ? '' : ' data-open="1"'}><span>Use it to</span></div>${defi}${chain}${pay}`;
}
const takesOut = () => {
  if (!moving() || !FLOW) return false;
  const at = atOf('pay'), k = S.pay;
  if (at === 'chain') return FLOW === 'withdraw' && pairOk(k, 'chain', k, 'defi');
  return at === 'defi' && k === lc(R.TAC) && pairOk(k, 'defi', k, 'chain') && pairOk(k, 'defi', k, 'wallet');
};
function outHtml(from) {
  const at = atOf('get');
  const row = (home, t, sub) => `<button type="button" role="radio" class="c" data-home="${home}" aria-checked="${String(at === home)}" tabindex="${at === home ? 0 : -1}"><svg class="tk" aria-hidden="true"><use href="#tk-tac"/></svg><span class="rt"><b>${t}</b><small>${sub}</small></span><span class="ra"></span><span class="rd" aria-hidden="true"></span></button>`;
  const wallet = row('wallet', 'To your wallet', 'public TAC on Ethereum');
  const other = from === 'chain' ? row('defi', 'Swap, farm, borrow', 'DeFi pool') : row('chain', 'Fast private TAC', 'Tacit chain · quick sends, about a cent each');
  return `<div class="rows-h" data-open="1"><span>Take it to</span></div>${wallet}${other}`;
}
function chainHtml() {
  if (!moving() || !((atOf('pay') === 'pay' && isEth(S.pay)) || (atOf('get') === 'pay' && isEth(S.get))) || !H.moves.chains) return '';
  const cs = H.moves.chains();
  return cs.length > 1 ? `Pay pool on <select id="chain-sel" aria-label="The Pay pool’s chain">${cs.map((c) => `<option value="${c.id}" data-mark="${CHAIN_MARK[c.id] || 'c-eth'}"${c.id === H.moves.chain ? ' selected' : ''}>${esc(CHAIN_NAME[c.id] || c.name)}</option>`).join('')}</select>` : '';
}
function paintMove() {
  const q = S.mq || {}, out = $('#out'), rc = $('#rcpt'), go = $('#go');
  if (!q.busy && (!!q.fixed !== $('#amt').readOnly || (q.fixed && $('#amt').placeholder !== (q.all ? 'All' : '—')))) paintSides();
  out.classList.toggle('busy', !!q.busy);
  if (!q.busy) { const v = q.out == null ? null : String(q.out); out.textContent = v ?? '0'; out.classList.toggle('ph', v == null || v === '—'); out.classList.toggle('word', v != null && v !== '—' && !/^[\d.,]+$/.test(v)); }
  fitSize(out);
  const n = !q.busy && /^[\d.,]+$/.test(String(q.out ?? '')) ? parseUnits(String(q.out).replace(/,/g, ''), tokenOf(S.get)?.dec ?? 18) : null, v = n ? usdOf(S.get, n) : null;
  $('#get-usd').textContent = v != null ? `≈ ${usd(v)}` : '';
  $('#rows').hidden = true; $('#later').hidden = true; $('#ackbox').innerHTML = ''; $('#ackbox').dataset.k = '';
  const lines = (q.rc || []).filter(Boolean);
  rc.hidden = !lines.length || (!S.amt && !q.fixed); rc.classList.toggle('stale', !!q.busy);
  rc.innerHTML = lines.map(([k, v, c, t]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${k === 'TAC points' ? TAC_MARK : ''}${esc(k)}</dt><dd class="${c || ''}">${cell(v)}</dd></div>`).join('');
  const need = !q.free && !parseUnits(S.amt, Math.min(8, tokenOf(S.pay)?.dec ?? 8));
  go.textContent = S.busy ? 'Working…' : need ? 'Enter an amount' : q.busy && !q.go ? 'Reading…' : q.go || 'Continue';
  go.disabled = S.busy || need || !!q.busy || !!q.failed || !!q.early;
  go.className = `go${isPrivAt(atOf('get')) ? ' priv' : ''}`;
  if (!S.busy) say(q.line ? `<span class="${q.warn ? 'warn' : ''}">${esc(q.line)}</span>` : '');
}
function clearTo() { S.toAsked = false; S.to = null; S.toBad = ''; S.toName = null; S.toBusy = false; S.toTacit = null; S.toTacitBad = ''; S.toTacitBusy = false; S.toOpen = false; $('#to-in').value = ''; }
function fit(changed) {
  if (kindOf(S.pay, S.get)) return;
  if (placed()) { mend(changed); return; }
  if (changed === 'pay') S.get = S.outP ? (S.pay === 'teth' || isEth(S.pay) ? lc(R.TAC) : 'teth') : S.inP ? lc(R.ZERO) : isEth(S.pay) ? lc(R.TAC) : tacitKey(S.pay) ? lc(R.ZERO) : lc(R.TAC);
  else S.pay = S.inP ? (S.get === 'teth' ? lc(R.TAC) : 'teth') : S.outP ? lc(R.ZERO) : isEth(S.get) || !tacitKey(S.get) ? lc(R.TAC) : lc(R.ZERO);
  if (!kindOf(S.pay, S.get)) { S.pay = S.inP ? 'teth' : lc(R.ZERO); S.get = S.outP ? (S.pay === 'teth' ? lc(R.TAC) : 'teth') : S.inP ? lc(R.ZERO) : lc(R.TAC); }
}
function pickAt(side, at, k) {
  if (S.busy) return;
  if (moving()) { choose(side, `@${at}:${k}`); return; }
  if (at === atOf(side)) { choose(side, k); return; }
  const was = side === 'pay' ? S.pay : S.get, amt = S.amt;
  if (side === 'get') clearTo();
  keepAmt(() => { setAt(side, at); if (side === 'pay') S.pay = k; else S.get = k; fit(side === 'pay' ? 'get' : 'pay'); });
  if (side === 'pay' && sameCoin(was, k)) S.amt = amt;
  if (at === 'defi') { warmPrivate(); farmsSoon(); privUp(); }
  S.amt = fitAmt(S.amt); S.q = null; S.pick = null; S.hold = false; S.ack = false; changed(); paint(); requote(true);
}

const SPRITE = new Set(['tac', 'teth', 'cbtc', 'cusd', 'btc', 'eth', 'peth']);
function coin(t, cls = '', later = false) {
  if (!t) return '';
  if (t.pvt) cls += ' pvt';
  return SPRITE.has(t.icon) ? `<svg class="tk ${cls}" aria-hidden="true"><use href="#tk-${t.icon}"/></svg>` : LOGO[t.addr] ? `<img class="tk ${cls}" ${later && LOGO[t.addr][0] === '/' ? 'data-src' : 'src'}="${LOGO[t.addr]}" alt="" aria-hidden="true" decoding="async">` : letter(t, cls);
}
const TINT = { USDC: '#2775CA', USDT: '#26A17B', DAI: '#F5AC37', wstETH: '#00A3FF', WETH: '#627EEA' };
function letter(t, cls) { return `<span class="tk letter ${cls}" style="--c:${TINT[t.sym] || '#8F8979'}" aria-hidden="true">${esc((t.sym || '?').replace(/^w(?=[A-Z])/, '').slice(0, 1).toUpperCase())}</span>`; }
function amtFmt(v, dec) {
  const n = Number(v) / 10 ** dec;
  const dp = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return fmtUnits(v, dec, Math.min(dp, dec));
}
const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
function balFmt(v, dec) {
  const n = Number(v) / 10 ** dec;
  return n > 0 && n < 1 ? tidy(fmtUnits(v, dec, Math.min(Math.max(4, Math.ceil(-Math.log10(n)) + 3), 8, dec))) : amtFmt(v, dec);
}
const poolUnits = () => S.inP || (S.outP && isEth(S.pay));
const tacSwap = () => isEth(S.pay) && S.get === lc(R.TAC);
const tacUnits = () => tacSwap() && (exiting() || laterOn(kindOf(S.pay, S.get)));
const alignTac = (w) => w - (w % R.UNIT);
const fitAmt = (s, on = poolUnits() || tacUnits()) => (on ? String(s).replace(/([.,]\d{8})\d+$/, '$1') : s);
const gasKeep = () => (S.gasPrice || 3n * 10n ** 9n) * 400000n;
const tipKeep = () => (S.q?.tip != null ? S.q.tip * 2n : 10n ** 15n);
function usdOf(k, wei) {
  const t = tokenOf(k), p = S.px;
  if (!t || wei == null) return null;
  const n = Number(wei) / 10 ** t.dec, is = (sym) => R.TOKENS.some((x) => x.sym === sym && lc(x.addr) === lc(k));
  if (isEth(k) || k === 'teth' || lc(k) === lc(R.WETH)) return p.ethUsd ? n * p.ethUsd : null;
  if (is('wstETH')) return p.ethUsd && p.wstEth ? n * p.wstEth * p.ethUsd : null;
  if (lc(k) === lc(R.CBTC) || is('WBTC')) return p.btcUsd ? n * p.btcUsd : null;
  if (lc(k) === lc(R.CUSD) || is('USDC') || is('USDT') || is('DAI')) return n;
  if (k === lc(R.TAC)) return p.ethUsd && p.perEth ? (n / p.perEth) * p.ethUsd : null;
  return null;
}

async function readPrices() {
  const r = await batch([
    { to: PRECISION_POOL, data: '0x2af1f249' }, { to: CHAINLINK.eth, data: '0xfeaf968c' }, { to: CHAINLINK.btc, data: '0xfeaf968c' }, { to: MULTICALL3, data: '0x0f28c97d' },
    { to: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', data: '0x035faf82' },
  ]);
  const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);
  if (r[0]) { const root = Number(wordAt(r[0], 0)) / 1e18; S.px.perEth = root > 0 ? root * root : null; }
  S.px.ethUsd = fresh(r[1]) ?? S.px.ethUsd; S.px.btcUsd = fresh(r[2]) ?? S.px.btcUsd;
  if (r[3]) { S.chainT = Number(wordAt(r[3], 0)); S.chainAt = now(); }
  if (r[4]) S.px.wstEth = Number(wordAt(r[4], 0)) / 1e18;
  if (S.px.ethUsd) H.onPrices?.(S.px);
}
const chainDeadline = (s = 1200) => BigInt(Math.ceil(((S.chainT ? S.chainT + (now() - S.chainAt) : now()) + s) / 60) * 60);
const chainNow = () => Number(chainDeadline(0)) - 60;
let chainP = null;
const chainTime = () => (S.chainT ? Promise.resolve() : (chainP ||= readPrices().catch(() => {}).finally(() => { chainP = null; })));
const gasPrice = (() => { let at = 0, out = null; return () => (S.gasPrice != null && now() - at < 20 ? Promise.resolve(S.gasPrice) : (out ||= (async () => { try { S.gasPrice = BigInt(await light('eth_gasPrice', [])); at = now(); } catch { } return S.gasPrice; })().finally(() => { out = null; }))); })();
const netOf = (r) => { const v = usdOf(S.get, r.out), f = S.gasPrice && S.px.ethUsd ? (Number(r.gas * S.gasPrice) / 1e18) * S.px.ethUsd : null; return v != null && f != null ? v - f : Number(r.out); };
function rerank(q = S.q) {
  if (q?.kind !== 'agg' || !q.rows || q.rows.length < 2) return;
  q.rows.sort((a, b) => netOf(b) - netOf(a)); q.rows.forEach((x, i) => { x.best = i === 0; });
  if (!S.hold || !q.rows.some((r) => r.k === S.pick)) S.pick = q.rows.find((r) => r.best)?.k || q.rows[0]?.k || null;
}
async function readBalances(fresh = true) {
  const who = W.account;
  if (!who) { S.bal = {}; return; }
  const had = (k) => !fresh && S.balFor === who && k in S.bal;
  const toks = listed().filter((t) => !isEth(t.addr) && (!t.uni || t.addr === S.pay || t.addr === S.get) && !had(t.addr));
  const [eth, r] = await Promise.all([had(lc(R.ZERO)) ? S.bal[lc(R.ZERO)] : light('eth_getBalance', [who, 'latest']).then(BigInt, () => null), toks.length ? batch(toks.map((t) => ({ to: t.addr, data: '0x70a08231' + addrWord(who) }))).catch(() => []) : []]);
  const bal = {};
  if (eth != null) bal[lc(R.ZERO)] = eth;
  toks.forEach((t, i) => { if (r[i]) bal[t.addr] = wordAt(r[i], 0); });
  if (W.account !== who) return;
  if (S.balFor === who) for (const [k, v] of Object.entries(S.bal)) if (!(k in bal) && (!fresh || listedAt(k)?.uni)) bal[k] = v;
  S.bal = bal; S.balFor = who;
  relayLiveCheck();
}

const live = (t) => { $('#sw-live').textContent = t; };
const say = (h, cls = '', stick = false) => {
  if (stick) S.note = { h, cls };
  const q = $('#q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h;
  if (stick || S.busy) try { const r = q.getBoundingClientRect(); if (r.height && r.bottom + 56 > innerHeight && r.top < innerHeight + 300) q.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } catch { }
};
function walletChanged() { S.bal = {}; LATER.p2 = {}; LATER.dgas = null; LATER.dgasTok = null; paint(); readBalances().then(paint); if (S.q) requote(true); }
async function signTyped(typed, from) {
  if (lc(W.account || '') !== lc(from)) throw new Error('The wallet’s account changed. Nothing was signed; review it again.');
  await wallet.ensureMainnet();
  try { return await W.prov.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] }); } catch (e) {
    if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied/i.test(e?.message || '')) throw new UserStopped(!!e?.quick);
    throw e;
  }
}

const PREVIEW = '0x0000000000000000000000000000000000000001';
const GAS = { single: 160000n, twohop: 260000n, hybrid: 480000n, tac: 160000n, tacSell: 210000n, split: 270000n, any: 320000n, amm: 150000n, ammIn: 200000n, out: 340000n, in: 290000n, zap: 700000n, snwap: 380000n };
const picked = (q = S.q) => (q?.rows || []).find((r) => r.k === S.pick) || q?.rows?.find((r) => r.best) || q?.rows?.[0] || null;

function syncMove() {
  const mk = moveOf();
  if (moving() && mk !== S.mk) {
    S.mk = mk; S.mq = null;
    clearTimeout(qTimer);
    for (const el of ROOT.querySelectorAll('#hx-pts, #hx-have')) { el.hidden = true; el.__h = ''; el.textContent = ''; }
    if (mk) clearTo(); else H.moves.idle?.();
  }
  return mk;
}
let qTimer = 0;
function requote(now_ = false) {
  clearTimeout(qTimer);
  if (S.btc) return;
  if (hopDefault()) { changed(); paint(); }
  const mk = syncMove();
  if (mk) {
    const my = ++S.seq;
    S.mq = { ...(S.mq || {}), busy: true }; paintQuote();
    qTimer = setTimeout(() => H.moves.quote(mk, S.amt, (q) => { if (S.mk === mk && my === S.seq) { S.mq = q || {}; paintQuote(); } }), now_ ? 0 : 150);
    return;
  }
  const my = ++S.seq;
  const t = tokenOf(S.pay), wei = parseUnits(S.amt, t?.dec ?? 18);
  if (!wei) { S.q = null; paint(); return; }
  if (exiting()) {
    S.q = { ...(S.q || {}), kind: 'exit', busy: true }; paintQuote();
    qTimer = setTimeout(() => quoteExit(my, wei).catch((e) => { if (my === S.seq) { S.q = { kind: 'exit', err: e?.message || String(e) }; paint(); } }), now_ ? 0 : 200);
    return;
  }
  const was = S.q && !S.q.err && !S.q.busy && S.q.wei ? picked(S.q) : null;
  S.q = { ...(S.q || {}), busy: true, est: was?.out ? (was.out * wei) / S.q.wei : S.q?.est ?? null }; paintQuote();
  qTimer = setTimeout(() => quote(my, wei).catch((e) => { if (my === S.seq) { S.q = { err: e?.message || String(e) }; paint(); } }), now_ ? 0 : 200);
}
async function quote(my, wei) {
  const kind = kindOf(S.pay, S.get), pay = tokenOf(S.pay), get = tokenOf(S.get);
  const done = (q) => { if (my !== S.seq) return; S.q = { ...q, kind, wei, at: now() }; if (!S.hold || !S.q.rows?.some((r) => r.k === S.pick)) S.pick = S.q.rows?.find((r) => r.best)?.k || S.q.rows?.[0]?.k || null; const ak = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; if (ak !== S.ackKey) { S.ack = false; S.ackKey = ak; } if (q.part) paintQuote(); else paint(); aheadSoon(); modsSoon(); };
  if (!kind) return done({ none: true });
  const account = W.account || undefined;
  if (laterOn(kind) && !isEth(S.pay) && viaToken()) {
    const lt = await ltLoad(), stand = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('');
    const r = await within(lt.mod.routeFrom({ ethCall, venues, tokenIn: S.pay, token: isEth(S.get) ? R.ZERO : S.get, amount: wei, to: stand, slippageBps: S.slip, deadline: chainDeadline(1200) }), 25e3, 'zQuoter did not answer in time. Try again.');
    if (!r) return done({ rows: [], why: `No onchain route sells ${esc(pay.sym)} for ${esc(get.sym)} right now.`, lt: 'hop' });
    return done({ rows: [{ k: 'later', name: `${pay.sym} pool → ${r.name}`, note: '', out: r.out, min: r.min, hop: true, gas: GAS.zap, best: true }], lt: 'hop' });
  }
  if (laterOn(kind) && !isEth(S.pay)) {
    const lt = await ltLoad(), v = await within(lt.mod.quoteThrough({ ethCall, venues, pay: S.pay, get: S.get, amountIn: wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 25e3, 'zQuoter did not answer in time. Try again.');
    if (!v) return done({ rows: [], why: `No onchain route takes ${esc(pay.sym)} through the private pool to ${esc(get.sym)} right now.`, lt: 'zap' });
    return done({ rows: [{ k: 'later', name: `${v.r0.name} → ETH pool → ${v.r1.name}`, note: '', out: v.r1.out, min: v.r1.min, via: { ...v, spend: (wei * v.ethWei) / v.r0.out }, gas: GAS.zap, best: true }], lt: 'zap' });
  }
  if (kind === 'tac' && isEth(S.pay) && laterOn(kind)) {
    const lt = await ltLoad(), w = alignTac(wei);
    const r = w > 0n ? await within(lt.mod.routeOutTac({ venues, amount: w, to: standIn(), slippageBps: S.slip, deadline: chainDeadline(1200) }), 25e3, 'The pools did not answer in time. Try again.') : null;
    if (!r) return done({ rows: [], why: 'No pool can fill this right now.' });
    return done({ rows: [{ k: r.name === 'Precision pool' ? 'precision' : 'tacit-amm', name: r.name, note: '', out: r.out, min: r.min, gas: GAS.tac, best: true }], dir: 'ETH_TO_TAC' });
  }
  if (kind === 'tac') {
    const dir = isEth(S.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: wei, account, gasPrice: gasPrice() });
    if (!rt.single) return done({ rows: [], why: 'No pool can fill this right now.' });
    const rows = [];
    const ranked = rt.r.ranked || [];
    for (const v of ranked) rows.push({ k: v.venue, name: v.venue === 'precision' ? 'Precision pool' : 'Tacit pool', note: '', out: BigInt(v.amountOut), venue: v, gas: dir === 'ETH_TO_TAC' ? GAS.tac : GAS.tacSell });
    if (rt.split) { const sh = Math.round(Number(rt.split.legs[0].amountIn * 1000n / (rt.split.legs[0].amountIn + rt.split.legs[1].amountIn)) / 10); rows.push({ k: 'split', name: 'Both pools', note: splitBar(sh), out: BigInt(rt.split.amountOut), split: rt.split, gas: GAS.split }); }
    const best = rt.pick === 'split' ? rows.find((r) => r.k === 'split') : rows.find((r) => r.k === rt.single.venue);
    if (best) best.best = true;
    return done({ rows, dir });
  }
  if (kind === 'amm') {
    const q = await R.quoteAmm({ ethCall, tokenIn: isEth(S.pay) ? R.ZERO : S.pay, tokenOut: isEth(S.get) ? R.ZERO : S.get, amountIn: wei });
    if (!q) return done({ rows: [], why: wei < R.UNIT ? 'Enter a larger amount.' : 'The Tacit pool has no price for this pair right now.', tiny: wei < R.UNIT });
    return done({ rows: [{ k: 'amm', name: 'Tacit pool', note: '', out: q.amountOut, amm: q, gas: isEth(S.pay) ? GAS.amm : GAS.ammIn, best: true }], dust: wei - q.amountIn });
  }
  if (kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: S.pay, amountIn: wei, account: account || '0x0000000000000000000000000000000000000001', slippageBps: S.slip, deadline: chainDeadline(1800), reuse: true }), 15e3, 'zQuoter did not answer in time. Try again.');
    if (!q) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} against WETH deeply enough. Swap it for ETH elsewhere first.` });
    const hop = q.hop ? `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}` : null;
    return done({ rows: [{ k: 'any', name: hop ? `${hop} → Precision pool` : 'Precision pool', note: '', out: q.tacOut, any: q, gas: GAS.any, best: true }] });
  }
  if (kind === 'out' || kind === 'in') {
    const who = account || '0x0000000000000000000000000000000000000001', dest = recipient() || who, args = { ethCall, amountIn: wei, account: who, to: dest, slippageBps: S.slip, deadline: chainDeadline(1800), reuse: true };
    if (kind === 'out') {
      const q = await within(R.quoteTacitToToken({ ...args, venues, tokenIn: S.pay, tokenOut: S.get }), 20e3, 'zQuoter did not answer in time. Try again.');
      if (!q) return done({ rows: [], why: `No pool trades WETH for ${esc(get.sym)} deeply enough. Sell ${esc(pay.sym)} for ETH, then swap it elsewhere.` });
      const via = q.leg.venue === 'precision' ? 'Precision pool' : 'Tacit pool', hop = q.hop ? `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}` : null;
      return done({ rows: [{ k: 'out', name: hop ? `${via} → ${hop}` : via, note: '', out: q.out, val: q.val, min: q.min, sell: q, gas: GAS.out, best: true }] });
    }
    const q = await within(R.quoteTokenToTacit({ ...args, token: S.pay, tokenOut: S.get }), 20e3, 'zQuoter did not answer in time. Try again.');
    if (!q) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} against WETH deeply enough. Swap it for ETH elsewhere first.` });
    const hop = `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}`;
    return done({ rows: [{ k: 'in', name: `${hop} → Tacit pool`, note: '', out: q.out, buy: q, gas: GAS.in, best: true }] });
  }
  if (kind === 'agg') {
    const hide = laterOn(kind), who = hide ? PREVIEW : recipient() || account || PREVIEW, rows = [], sq = { tokenIn: S.pay, tokenOut: S.get, amountIn: wei, decIn: pay.dec, decOut: get.dec };
    const sols = hide ? [] : SV.SOLVERS.filter((v) => !(AVOID.get(v.id) > Date.now()));
    let left = 1 + sols.length, zerr = null;
    gasPrice();
    const put = (r) => { const i = rows.findIndex((x) => x.k === r.k); if (i < 0) rows.push(r); else rows[i] = r; };
    const show = () => { if (!rows.length || my !== S.seq) return; rows.sort((a, b) => netOf(b) - netOf(a)); rows.forEach((x, i) => { x.best = i === 0; }); done({ rows: rows.slice(), more: sols.length ? left : 0, part: left > 0 }); };
    const settle = (r) => { left--; if (r) put(r); show(); };
    const zRow = (zq) => ({ k: 'agg', name: zq.name, note: 'onchain', out: zq.out, min: zq.min, agg: zq, gas: GAS[zq.kind] || GAS.split, at: now() });
    await Promise.all([
      within(A.bestRoute({ ethCall, to: who, refundTo: hide ? PREVIEW : account || who, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: S.slip, deadline: chainDeadline(1200), onRoute: (zq) => { put(zRow(zq)); show(); } }), 20e3, 'zQuoter did not answer in time. Try again.')
        .then((zq) => settle(zq ? zRow(zq) : null), (e) => { zerr = e; settle(null); }),
      ...(sols.map((v) => SV.priceOf(v, sq).then((p) => settle(p ? { k: `sv:${p.id}`, name: p.name, note: 'solver', out: p.out, sv: { id: p.id, ctx: p.ctx }, gas: GAS.snwap } : null)))),
    ]);
    if (rows.length) return;
    if (zerr) throw zerr;
    return done({ rows: [], why: 'No route trades this pair deeply enough right now.' });
  }
  if (kind === 'pin') {
    const who = account || PREVIEW, r1 = await within(A.bestRoute({ ethCall, to: who, refundTo: who, tokenIn: S.pay, tokenOut: R.ZERO, amountIn: wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Try again.');
    if (!r1) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} for ETH deeply enough.` });
    const units = r1.min / E10;
    if (!units) return done({ rows: [], why: 'Enter a larger amount.', tiny: true });
    const q = await privQuote(units, 'eth', 'ETH');
    return done(q.rows?.length ? { ...q, pin: r1, ethIn: units * E10, rows: q.rows.map((x) => ({ ...x, name: `${r1.name} → ${x.name === 'Made private' ? 'private' : x.name}`, pin: true })) } : q);
  }
  const units = parseUnits(S.amt, 8);
  if (!units) return done({ rows: [], why: 'Enter an amount with at most 8 decimal places.' });
  if (kind === 'pout') return done(await quoteOut(units, pay, get));
  return done(await privQuote(units, isEth(S.pay) ? 'eth' : PK[S.pay], pay.sym));
}
async function privQuote(units, from, sym) {
  const wallet = from === 'eth' && !S.inP, tipP = wallet ? tipFor(units) : null;
  if (wallet && S.get === 'teth') return { rows: [{ k: 'private', name: 'Made private', note: '', out: units * E10, best: true, priv: true }], fee: null, tip: await tipP };
  const t = await getUx(), to = PK[S.get];
  idsOf(t);
  const id = (k) => (k === 'cbtc' ? String(t.pool.CBTC_ZK_ASSET_ID) : String(t.assetByTicker[POOL_TK[k]]?.assetId || '')).toLowerCase();
  const stops = from === 'eth' || to === 'eth' ? [to] : ['eth', to];
  const f0 = await opFee(t, POOL_TK[from], 'route'), fee = stops.length > 1 ? twoDigits((f0 * 14n) / 10n) : f0;
  if (units <= fee * 2n) return { rows: [], why: `Swap more than ${fmtUnits(fee * 2n, 8, 6)} ${esc(sym)}: the relay’s fee is ${fmtUnits(fee, 8, 6)}.`, tiny: true };
  let cur = id(from), amt = units - fee, at = from;
  const pools = [];
  for (const k of stops) {
    const next = id(k);
    const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => t.quoteRoute({ asset0: cur, amountIn: amt, path: [{ assetNext: next, feeBps }] }).then((r) => (r && r.amountOut > 0n ? r : null), () => null)));
    const best = tiers.filter(Boolean).reduce((a, c) => (!a || c.amountOut > a.amountOut ? c : a), null);
    if (!best) return { rows: [], why: 'The Tacit pool has no price for this pair right now.' };
    const h = best.hops[0], lo = BigInt(cur) <= BigInt(next);
    pools.push({ a: at, b: k, feeBps: Number(h.feeBps), ra: BigInt(lo ? h.reserveAPre : h.reserveBPre), rb: BigInt(lo ? h.reserveBPre : h.reserveAPre) });
    cur = next; amt = best.amountOut; at = k;
  }
  return { rows: [{ k: 'private', name: 'Tacit pool', note: '', out: amt * E10, best: true, priv: true }], fee, feeTick: from, pools, tip: tipP ? await tipP : null };
}
const ACT_GAS = 450000n;
async function quoteOut(units, pay, get) {
  const t = await getUx(), from = PK[S.pay], eth = isEth(S.get);
  idsOf(t);
  let tUnits = units, fee = null;
  const pools = [];
  if (from !== 'eth') {
    fee = await opFee(t, POOL_TK[from], 'route');
    if (units <= fee * 2n) return { rows: [], why: `Swap more than ${fmtUnits(fee * 2n, 8, 6)} ${esc(pay.sym)}: the relay’s fee is ${fmtUnits(fee, 8, 6)}.`, tiny: true };
    const cur = IDS[from], next = IDS.eth;
    const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => t.quoteRoute({ asset0: cur, amountIn: units - fee, path: [{ assetNext: next, feeBps }] }).then((r) => (r && r.amountOut > 0n ? r : null), () => null)));
    const best = tiers.filter(Boolean).reduce((a, c) => (!a || c.amountOut > a.amountOut ? c : a), null);
    if (!best) return { rows: [], why: 'The Tacit pool has no price for this pair right now.' };
    const h = best.hops[0], lo = BigInt(cur) <= BigInt(next);
    pools.push({ a: from, b: 'eth', feeBps: Number(h.feeBps), ra: BigInt(lo ? h.reserveAPre : h.reserveBPre), rb: BigInt(lo ? h.reserveBPre : h.reserveAPre) });
    tUnits = best.amountOut;
  }
  const gp = eth ? 0n : (await gasPrice()) || 3n * 10n ** 9n;
  const xmin = (await opFee(t, 'cETH', 'unwrap')) + (eth ? 0n : (ACT_GAS * gp * 4n / 3n + E10 - 1n) / E10);
  const { fee: xfee, net } = t.quoteUnwrapFee(tUnits, 'cETH', { minFee: xmin });
  if (net <= 0n) return { rows: [], why: 'Too small to leave the pool: the relay’s fee is more than it.', tiny: true };
  const wei = net * E10, via = from === 'eth' ? '' : 'Tacit pool → ';
  const base = { fee, xfee, xmin, pools, tUnits };
  if (eth) return { ...base, rows: [{ k: 'pout', name: `${via}out of the pool`, out: wei, min: wei, wei, best: true, priv: true, pout: true }] };
  const sale = await within(R.quoteEthToToken({ ethCall, to: S.to || '0x0000000000000000000000000000000000000001', tokenOut: S.get, amount: wei, slippageBps: S.slip, deadline: chainDeadline(1800) }), 20e3, 'zQuoter did not answer in time. Try again.');
  if (!sale) return { rows: [], why: `No pool trades ETH for ${esc(get.sym)} deeply enough.` };
  const venue = `${sale.name}${sale.feeBps ? ` ${Number(sale.feeBps) / 100}%` : ''}`;
  return { ...base, rows: [{ k: 'pout', name: `${via}${venue}`, sale: venue, out: sale.amountOut, min: sale.amountLimit, wei, best: true, priv: true, pout: true }] };
}
const PK = { teth: 'eth', [lc(R.TAC)]: 'tac', [lc(R.CUSD)]: 'cusd', [lc(R.CBTC)]: 'cbtc' };
const POOL_TK = { eth: 'cETH', tac: 'cTAC', cbtc: 'cBTC', cusd: 'cUSD' };
let uxP = null;
const getUx = () => (H.getUx ? H.getUx() : uxP ||= (async () => {
  const [{ makeConfidentialPoolUx }, dep, d] = await Promise.all([import('/confidential-pool-ux.js?cb=2f24efa1'), import('/confidential-deployments.js'), import('/vendor/tacit-deps.min.js')]);
  dep.setActiveNetwork('mainnet');
  return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
})().catch((e) => { uxP = null; throw e; }));
const IDS = {};
const idsOf = (t) => { for (const k of ['eth', 'tac', 'cusd']) IDS[k] = String(t.assetByTicker[POOL_TK[k]]?.assetId || '').toLowerCase(); IDS.cbtc = String(t.pool.CBTC_ZK_ASSET_ID).toLowerCase(); return IDS; };
const TIPS = new Map();
const tipFor = (units) => {
  const k = String(units), c = TIPS.get(k);
  if (c && Date.now() - c.at < 30e3) return c.p;
  for (const [x, v] of TIPS) if (Date.now() - v.at >= 30e3) TIPS.delete(x);
  const p = import('/teth/read.js?cb=7aa845b7').then((m) => m.wrapQuote(units * E10)).then((x) => x.tip, () => { if (TIPS.get(k)?.p === p) TIPS.delete(k); return null; });
  TIPS.set(k, { p, at: Date.now() });
  return p;
};
const OPFEE = new Map();
const opFee = (t, ticker, op) => {
  const k = `${ticker}:${op}`, c = OPFEE.get(k);
  if (c && Date.now() - c.at < 30e3) return c.p;
  const p = t.quoteOpFee(ticker, op).then(BigInt);
  p.catch(() => { if (OPFEE.get(k)?.p === p) OPFEE.delete(k); });
  OPFEE.set(k, { p, at: Date.now() });
  return p;
};
let warmed = false;
function warmPrivate() {
  if (warmed) return;
  warmed = true;
  H.warm?.();
  document.head.append(Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://rpc.mevblocker.io', crossOrigin: '' }));
  getUx().then((t) => opFee(t, 'cETH', 'route')).catch(() => {});
}
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };

const spentOf = (q, r) => (r?.via ? r.via.spend : r?.pin ? q.wei : r?.any ? r.any.spend : r?.buy ? r.buy.spend : r?.sell ? r.sell.amountIn : r?.priv && q.fee != null ? q.wei - q.fee * E10 : q.wei);
function vsMarket(q = S.q, r = picked(q)) {
  if (!q || !r) return null;
  const vin = usdOf(S.pay, spentOf(q, r)) ?? (r.any ? usdOf(lc(R.ZERO), r.any.weth) : null), vout = usdOf(S.get, r.val ?? r.out);
  return vin && vout ? vout / vin - 1 : null;
}
const BAD = -0.03, GATE = -0.1;

function paint() {
  paintMode(); paintSides(); paintQuote(); paintRecent(); paintNudge(); syncLane();
}
function syncLane() {
  if (!moving() || !$('#btc')) return;
  const on = lanePair(S.pay, atOf('pay'), S.get, atOf('get'));
  if (on === S.btc) return;
  setBtc(on);
  if (on) lane?.pair(S.pay === 'teth' ? 'teth' : 'tac');
}
const BRIDGED_KEY = 'tacit-bridged-v1';
let BRIDGED = { raw: null, out: [] };
function bridgedWaiting() {
  try {
    const raw = localStorage.getItem(BRIDGED_KEY) || '{}';
    if (raw === BRIDGED.raw) return BRIDGED.out;
    const all = JSON.parse(raw) || {}, out = [];
    for (const held of Object.values(all)) {
      for (const [a, sym] of [['teth', 'tETH'], ['tac', 'TAC']]) {
        const e = held && held[a];
        if (e && Number(e.n) > 0 && /^\d+$/.test(String(e.v)) && BigInt(e.v) > 0n && !out.includes(sym)) out.push(sym);
      }
    }
    BRIDGED = { raw, out };
    return out;
  } catch { return []; }
}
function paintNudge() {
  const b = $('.mode [data-mode="bitcoin"]');
  if (!b) return;
  const w = S.btc ? [] : bridgedWaiting(), t = w.length ? `On Bitcoin: your bridged ${w.join(' and ')} waits there to be moved, then swapped` : 'On Bitcoin';
  b.toggleAttribute('data-nudge', w.length > 0);
  b.title = t; b.setAttribute('aria-label', t);
}
function paintMode() {
  const k = kindOf(S.pay, S.get), slips = (k && k !== 'private' && !(k === 'pout' && isEth(S.get))) || (exiting() && S.pay !== S.get);
  ROOT.classList.toggle('btc', S.btc); if ($('#btc')) $('#btc').hidden = !S.btc; $('.sw-foot').hidden = !slips;
  ROOT.querySelectorAll('.mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'bitcoin' ? S.btc : !S.btc)));
}
const shownAt = (k, at) => { const t = tokenOf(k, at === 'defi'); return at === 'chain' && t ? { ...t, pvt: true } : at === 'pay' && t ? (isEth(k) ? { ...t, icon: 'peth' } : { ...t, pvt: true }) : at === 'defi' && t && k === lc(R.TAC) ? { ...t, pvt: true } : t; };
let PAYWARM = 0;
function paintSides() {
  let pay = shownAt(S.pay, atOf('pay')), get = shownAt(S.get, atOf('get'));
  if (FLOW === 'shield' && get && pay) get = { ...get, sym: S.get === 'teth' ? 'ETH' : pay.sym };
  if (FLOW === 'withdraw' && get && pay) pay = { ...pay, sym: get.sym };
  setHtml($('#pay-coin'), `${coin(pay)}${esc(pay.sym)}<span class="car" aria-hidden="true">▾</span>`);
  $('#pay-coin').setAttribute('aria-label', `Pay with ${pay.sym}. Choose another`);
  setHtml($('#get-coin'), `${coin(get)}${esc(get.sym)}<span class="car" aria-hidden="true">▾</span>`);
  $('#get-coin').setAttribute('aria-label', `Get ${get.sym}. Choose another`);
  const payPriv = S.inP, out = (!moveOf() && kindOf(S.pay, S.get) === 'pout') || exiting(), inPriv = S.outP;
  if (out && !S.toAsked && ((exiting() && !intoPool()) || (!S.to && !S.toBad && !W.account && !intoPool()))) { S.toOpen = true; S.toAsked = true; }
  if (!out) S.toAsked = false;
  $('#f-pay').classList.toggle('priv', payPriv || atOf('pay') === 'pay'); $('#f-get').classList.toggle('priv', inPriv || atOf('get') === 'pay');
  for (const s of ['pay', 'get']) {
    const a = atOf(s), el = $(`#${s}-at`), mk = moving() ? placeMark(a) : '';
    if (!el) continue;
    el.className = `where${isPrivAt(a) ? ' priv' : ''}${mk && a !== 'wallet' ? ' pool' : ''}${moving() ? ' go-pick' : ''}`;
    const text = a === 'btc' ? 'Bitcoin' : a === 'chain' ? 'Tacit chain' : a === 'defi' && moving() ? 'DeFi pool' : a === 'pay' && moving() ? 'Pay pool' : isPrivAt(a) ? 'Private' : 'Wallet';
    if (el.dataset.k !== `${a}`) { el.dataset.k = `${a}`; el.innerHTML = `${mk}${text}`; }
    if (moving()) { el.title = `${PLACE_TIP[a] || ''}. Press to choose another`; el.setAttribute('role', 'button'); el.tabIndex = 0; }
  }
  const to = S.inP ? outTo() : recipient(), gw = $('#get-where');
  const pool = laterPool();
  gw.className = `where${inPriv || (pool && !S.to) ? ' priv' : ''}`; gw.textContent = inPriv || (pool && !S.to) ? (S.toTacit ? `to ${tacitName(S.toTacit)}` : 'to your private balance') : S.to && to ? `to ${who(to)}` : (out && !W.account) || laterOn(kindOf(S.pay, S.get)) ? 'to an address' : 'to your wallet';
  gw.disabled = false; gw.setAttribute('aria-expanded', String(S.toOpen)); gw.hidden = placed() && (!exiting() || intoPool());
  $('#to').hidden = !S.toOpen || (placed() && (!exiting() || intoPool())); $('#to-in').setAttribute('aria-invalid', String(inPriv ? !!S.toTacitBad : !!S.toBad));
  $('#to-in').placeholder = inPriv ? 'Send to a Tacit address: tacit1… or name.wei' : pool ? 'Your private balance, or tacit1…, name.wei or 0x…' : exiting() && W.account ? 'Your wallet, or a new address: 0x… or name.eth' : LATER.on ? 'Address it goes to: a new 0x… or name.eth' : (out && !W.account) ? 'Address it goes to: 0x… or name.eth' : 'Send to another address: 0x… or name.eth';
  if (inPriv) {
    $('#to-note').textContent = S.toTacitBad || (S.toTacitBusy ? 'Looking it up…' : S.toTacit ? (S.toTacit.name ? `Sent to ${S.toTacit.name}: they claim it in their Tacit wallet` : 'They claim it in their Tacit wallet') : '');
    $('#to-note').className = S.toTacitBad ? 'err' : '';
  } else {
    $('#to-note').textContent = S.toBad || (S.toBusy ? 'Looking it up…' : to && $('#to-in').value.trim() !== checksum(to) ? checksum(to) : ''); $('#to-note').className = S.toBad ? 'err' : '';
  }
  const a = $('#amt'), fixed = !!(moveOf() && S.mq?.fixed), shown = fixed ? '' : S.amt; if (a.value !== shown) a.value = shown;
  const ph = fixed ? (S.mq?.all ? 'All' : '—') : '0';
  if (a.readOnly !== fixed || a.placeholder !== ph) { a.readOnly = fixed; a.placeholder = ph; }
  fitSize(a);
  $('#flip').disabled = placed() ? !pairOk(S.get, atOf('get'), S.pay, atOf('pay')) : !kindOf(S.get, S.pay);
  const bal = moveOf() || S.at.pay ? H.moves?.held?.(S.pay, atOf('pay'), moveOf()) ?? null : payPriv ? privBal(S.pay) : W.account ? S.bal[S.pay] : null, wei = parseUnits(S.amt, pay.dec);
  for (const k of [S.pay, S.get]) if (W.account && listedAt(k)?.uni && S.bal[k] === undefined && !BALQ.has(`${W.account}:${k}`)) { BALQ.add(`${W.account}:${k}`); readBalances().then(paintSides, () => {}); }
  const homes = $('#homes'), chain = $('#chain');
  if (homes) { const h = homesHtml(); homes.hidden = !h; if (h !== homes.dataset.h) { homes.innerHTML = h; homes.dataset.h = h; } }
  if (chain) { const c = chainHtml(); chain.hidden = !c; if (c !== chain.dataset.h) { chain.innerHTML = c; chain.dataset.h = c; netPicker($('#chain-sel')); } }
  const side = $('#pay-side'), mk = !S.amt && !fixed ? moveOf() : null, sizes = mk ? H.moves?.sizes?.(mk) || null : !S.amt && !fixed ? keptChips() : null;
  if (payPriv && bal == null && !S.at.pay && !moveOf()) setHtml(side, PV?.unlocked ? `<span>Reading your private balance…${PV.readFailed ? ' <button type="button" id="pv-read">Read again</button>' : ''}</span>` : '<button type="button" id="pv-open">Sign in to see your private balance</button>');
  else if (moving() && isPrivAt(atOf('pay')) && bal == null && !fixed && !H.key?.session?.unlocked) setHtml(side, '<button type="button" id="pv-sign">Sign in to see your private balance</button>');
  else if (bal != null) setHtml(side, fixed ? `<span>Balance ${esc(balFmt(bal, pay.dec))}</span>` : `<button type="button" id="max" class="${wei && wei > bal ? 'over' : ''}">Balance ${esc(balFmt(bal, pay.dec))}${bal > 0n ? ' <span class="mx">Max</span>' : ''}</button>`);
  else if (!S.amt && !fixed && !sizes) setHtml(side, `<span class="quick">${((poolUnits() ? QUICK_PRIV : QUICK)[pay.sym] || []).map((v) => `<button type="button" data-quick="${v}">${v}</button>`).join('')}</span>`);
  else setHtml(side, '');
  if (moving() && atOf('pay') === 'pay' && Date.now() - PAYWARM > 30e3) { PAYWARM = Date.now(); H.moves.warm?.(); }
  const getBal = !S.outP && !S.at.get && !S.to && W.account ? S.bal[S.get] : null;
  $('#get-side').textContent = getBal ? `Balance ${balFmt(getBal, get.dec)}` : '';
  const v = wei && !fixed ? usdOf(S.pay, wei) : null, pu = $('#pay-usd');
  const h = sizes ? `<span class="quick">${sizes.map((x) => x.act ? `<button type="button" data-stage${x.off ? ' disabled' : ''}>${esc(x.v)}</button>` : `<button type="button" data-quick="${esc(x.v)}"${x.rd ? ` class="rd" title="${esc(x.t || 'Proved already: one transaction')}" aria-label="${esc(x.v)}, ready now: one transaction"` : ''}>${esc(x.v)}</button>`).join('')}${sizes.some((x) => x.rd) ? '<span class="rdn" aria-hidden="true"><svg><use href="#i-bolt"/></svg>ready now</span>' : ''}</span>` : '';
  if (h) { if (pu.dataset.h !== h) { pu.innerHTML = h; pu.dataset.h = h; } }
  else { pu.dataset.h = ''; pu.textContent = v != null ? `≈ ${usd(v)}` : ''; }
}
const QUICK = { ETH: ['0.1', '0.5', '1'], TAC: ['500', '1000'], USDC: ['100', '500'], USDT: ['100', '500'], DAI: ['100', '500'], cUSD: ['100', '500'], tacUSD: ['100', '500'], cBTC: ['0.001', '0.01'], tacBTC: ['0.001', '0.01'], WBTC: ['0.005', '0.01'], WETH: ['0.1', '0.5'], wstETH: ['0.1', '0.5'], tETH: ['0.1', '0.5'] };
const QUICK_PRIV = { ETH: ['0.02', '0.05', '0.1'], tETH: ['0.02', '0.05', '0.1'], TAC: ['500', '2000'], cUSD: ['50', '100'], cBTC: ['0.0005', '0.001'] };
const PSYM = { eth: 'tETH', tac: 'TAC', cusd: 'cUSD', cbtc: 'cBTC' }, PICON = { eth: 'teth', tac: 'tac', cusd: 'cusd', cbtc: 'cbtc' };
const farmOn = (p) => (S.farms || []).find((f) => f.pid != null && [PICON[p.a], PICON[p.b]].every((i) => f.icons.includes(i))) || null;
const fitSize = (el) => { const n = (el.value || el.textContent || '').length; el.classList.toggle('long', n > 8); el.classList.toggle('longer', n > 11); };

function feeLines(q, r) {
  const coin = isEth(S.pay) || S.pay === 'teth' || r.pin ? 'teth' : S.pay;
  const parts = [];
  if (q.fee != null) parts.push(['Relay fee', `${fmtUnits(q.fee, 8, 6)} ${tokenOf(coin, true).sym}`, usdOf(coin, q.fee * E10)]);
  if (q.xfee != null) parts.push(['Exit fee', `${fmtUnits(q.xfee, 8, 6)} tETH`, usdOf('teth', q.xfee * E10)]);
  if (q.tip != null) parts.push(['Deposit tip', `${fmtUnits(q.tip, 18, 6)} ETH`, usdOf(lc(R.ZERO), q.tip)]);
  if (!parts.length) return [];
  const share = q.fee != null ? Number(q.fee * E10) / Number(r.pin ? q.ethIn : q.wei) : 0, said = share >= 0.02 ? ` · ${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}% of the swap` : '';
  if (parts.every((x) => x[2] != null)) {
    const t = parts.reduce((a, x) => a + x[2], 0);
    return [['Fees', `about ${t < 1 ? `$${t.toFixed(2)}` : usd(t)}${said}`, share >= 0.05 ? 'warn' : '', parts.map((x) => `${x[0]} ${x[1]}`).join(' + ')]];
  }
  return parts.map(([k, v], i) => [k, `${v}${i === 0 ? said : ''}`]);
}
function shareLink() {
  const mk = moveOf(), amt = String(S.amt || '').trim();
  if (!H.copy || !/^\d{0,12}(?:\.\d{1,18})?$/.test(amt) || !(Number(amt) > 0)) return null;
  if (mk) return `${location.origin}/#card=shield:${mk.replace('>', ':')}&amt=${amt}`;
  return kindOf(S.pay, S.get) && !S.btc ? `${location.origin}/?${params()}` : null;
}
const shareSync = () => {
  const b = $('#copy'), u = shareLink();
  if (b) b.hidden = !u || !!FLOW;
  if (!b || !history.replaceState || FLOW) return;
  try {
    const at = location.pathname + location.search + location.hash, cur = new URL(location.href);
    let want;
    if (u) { const w = new URL(u); want = w.pathname + (w.hash ? cur.search : w.search || cur.search) + w.hash; if (!w.hash) { const q = new URLSearchParams(cur.search); for (const [k, v] of new URLSearchParams(w.search)) q.set(k, v); want = cur.pathname + (q.toString() ? `?${q}` : '') + cur.hash; } }
    else { const q = new URLSearchParams(cur.search); q.delete('amt'); want = cur.pathname + (q.toString() ? `?${q}` : '') + (/^#card=(?:shield|earn|send):/.test(cur.hash) ? '' : cur.hash); }
    if (S.inP || S.outP || placed() || laterOn(kindOf(S.pay, S.get))) { const w2 = new URL(want, location.origin); w2.searchParams.delete('amt'); w2.hash = w2.hash.replace(/&amt=[^&]*/, ''); want = w2.pathname + w2.search + w2.hash; }
    if (want !== at) history.replaceState(null, '', want);
  } catch { }
};
function paintQuote() { quotePaint(); flowGo(); }
function flowGo() {
  const tip = $('#flow-tip');
  if (tip) { tip.hidden = !(FLOW === 'withdraw' && S.amt && !S.busy); if (!tip.hidden) tip.textContent = exiting() ? 'For more privacy: a new address, a while after you shielded, and not the same amount.' : 'For more privacy: a while after you shielded, and not the same amount.'; }
  const go = $('#go'), ask = !!FLOW && !S.busy && !S.amt && !(moveOf() && S.mq?.fixed);
  go.dataset.ask = ask ? '1' : '';
  if (!ask && FLOW === 'shield' && !go.disabled && /^(Deposit privately|Make it private)$/.test(go.textContent)) go.textContent = `Shield ${shownAt(S.pay, atOf('pay'))?.sym || ''}`.trim();
  if (!ask) return;
  const t = FLOW === 'shield' ? shownAt(S.pay, atOf('pay')) : shownAt(S.get, atOf('get'));
  go.textContent = `${FLOW === 'shield' ? 'Shield' : 'Withdraw'} ${t?.sym || ''}`.trim(); go.disabled = false; go.className = 'go';
}
function quotePaint() {
  shareSync();
  if (moveOf()) { paintMove(); return; }
  if (exiting()) { paintExit(); return; }
  const q = S.q, out = $('#out'), get = FLOW === 'shield' && S.get === 'teth' ? { ...tokenOf(S.get), sym: 'ETH' } : tokenOf(S.get), pay = tokenOf(S.pay), rows = $('#rows'), rc = $('#rcpt'), go = $('#go'), ackbox = $('#ackbox');
  const r = picked(q), kind = kindOf(S.pay, S.get);
  const shape = laterOn(kind) && !isEth(S.pay) ? (viaToken() ? 'hop' : 'zap') : false;
  if (q && !q.busy && !q.err && !q.none && (q.lt || false) !== shape) { requote(true); return; }
  out.classList.toggle('busy', !!q?.busy); out.classList.remove('word');
  if (r && !q.busy) { out.textContent = tidy(amtFmt(r.out, get.dec)); out.classList.remove('ph'); }
  else if (q?.busy && q.est != null) { out.textContent = tidy(amtFmt(q.est, get.dec)); out.classList.remove('ph'); }
  else if (!q?.busy) { out.textContent = '0'; out.classList.add('ph'); }
  fitSize(out);
  const vo = r && !q.busy ? usdOf(S.get, r.out) : null;
  const m = q && !q.busy ? vsMarket(q, r) : null;
  $('#get-usd').innerHTML = vo != null ? `≈ ${usd(vo)}${m != null && Math.abs(m) >= 0.0005 ? ` <span class="${m <= BAD ? 'warn' : m > 0.02 ? 'ok' : 'mute'}">(${m > 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(Math.abs(m) >= 0.1 ? 0 : 2)}%)</span>` : ''}` : '';
  const busy = !!q?.busy, first = busy && !r;
  rows.classList.toggle('stale', busy); rc.classList.toggle('stale', busy);
  const list = first && kind === 'tac' && !laterOn(kind) ? [{ k: 'precision', name: 'Precision pool' }, { k: 'tacit-amm', name: 'Tacit pool' }, { k: 'split', name: 'Both pools' }] : (q?.rows || []);
  rows.hidden = !(list.length > 1);
  rows.toggleAttribute('data-more', q?.more > 0);
  if (rows.hidden && rows.innerHTML) rows.innerHTML = '';
  if (first && !rows.hidden) rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${esc(get.sym)} out</span></div>${list.map((x) => `<button type="button" role="radio" aria-checked="false" disabled><span class="rt"><b>${esc(x.name)}</b>${ghostNote(x.k, isEth(S.pay), parseUnits(S.amt, pay.dec))}</span><span class="ra"><span>…</span><small>&nbsp;</small></span><span class="rd" aria-hidden="true"></span></button>`).join('')}`;
  else if (!rows.hidden) {
    const top = list.find((x) => x.best) || list.reduce((a, b) => (b.out > a.out ? b : a));
    let shown = list;
    if (list.length > 4 && S.routesAll !== `${S.pay}>${S.get}`) { shown = list.slice(0, 3); if (r && !shown.includes(r)) shown = [...shown.slice(0, 2), r]; }
    const more = list.length - shown.length;
    rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${q.more > 0 ? '<i class="more-q" aria-label="more quotes coming"></i>' : ''}${esc(get.sym)} out</span></div>${shown.map((x) => `<button type="button" role="radio" aria-checked="${x.k === r?.k}" data-route="${esc(x.k)}"><span class="rt"><b>${esc(x.name)}</b>${noteOf(x, q) ? `<small>${noteOf(x, q)}</small>` : ''}</span><span class="ra"><span>${esc(tidy(amtFmt(x.out, get.dec)))}</span>${x === top && list.length > 1 ? '<em>best</em>' : x.out < top.out ? `<small>${(Number(top.out - x.out) * 100 / Number(top.out)).toFixed(2)}% less</small>` : x.out > top.out ? `<small title="The marked route is preferred when it pays within 1% of the best">${(Number(x.out - top.out) * 100 / Number(top.out)).toFixed(2)}% more</small>` : ''}</span><span class="rd" aria-hidden="true"></span></button>`).join('')}${more ? `<button type="button" class="more" data-routes-all>${more} more quote${more > 1 ? 's' : ''}</button>` : ''}`;
  }
  const lines = first ? (kind === 'private' || kind === 'pout' ? ['Price', 'Price impact', 'Relay fee'] : ['Price', 'At least', 'Price impact', 'Network fee']).map((k) => [k, '…']) : [];
  if (r) {
    const inAmt = Number(spentOf(q, r)) / 10 ** pay.dec, outAmt = Number(r.val ?? r.out) / 10 ** get.dec;
    const depth = r.priv && q.pools?.length ? `Pool depth: ${q.pools.map((p) => `${tidy(amtFmt(p.ra, 8))} ${PSYM[p.a]} · ${tidy(amtFmt(p.rb, 8))} ${PSYM[p.b]}`).join(' and ')}` : '';
    if (inAmt > 0 && outAmt > 0) lines.push(['Price', (outAmt >= inAmt) !== !!S.pxFlip ? `1 ${pay.sym} = ${sig(outAmt / inAmt)} ${get.sym}` : `1 ${get.sym} = ${sig(inAmt / outAmt)} ${pay.sym}`, '', depth, null, 'px-flip']);
    if (laterOn(kind)) { }
    else if (!r.priv || (r.pout && !isEth(S.get))) lines.push(['At least', `${tidy(amtFmt(r.min ?? (r.out * BigInt(10000 - S.slip)) / 10000n, get.dec))} ${get.sym}`]);
    else if (r.priv && !r.pout) lines.push(['At least', `${tidy(amtFmt(poolFloor(r.out / E10) * E10, get.dec))} ${get.sym}`]);
    if (r.sell?.rest > 0n) lines.push(['Plus', `about ${tidy(amtFmt(r.sell.rest, 18))} WETH`]);
    const routed = r.agg || r.sv ? (q.rows || []).length < 2 : r.any?.hop || r.sell || r.buy || r.pin || r.via || r.hop;
    const hopEth = laterOn(kind) && isEth(S.pay) && !r.hop && !r.via && rows.hidden;
    const named = hopEth || !routed ? routeLine({ r, pools: q.pools, hop: hopEth }, (k) => PSYM[k]) : null;
    const compared = r.agg?.quotes?.length ? `Compared with ${r.agg.quotes.length} pool${r.agg.quotes.length > 1 ? 's' : ''}` : r.sv ? 'An outside solver, settled through zRouter: it pays at least the least shown, or nothing is swapped' : '';
    if (named) lines.push(['Route', named.text, '', [named.tip, compared].filter(Boolean).join(' ')]);
    else if (routed) lines.push(['Route', r.name, '', compared]);
    if (r.agg?.quotes?.length) {
      const gain = Number(r.out - r.agg.quotes[0].out) / Number(r.agg.quotes[0].out);
      if (gain >= 0.001) lines.push(['Over best pool', `+${(gain * 100).toFixed(2)}%`, 'ok', r.agg.quotes[0].name]);
    }
    const tacSide = S.pay === lc(R.TAC) || S.get === lc(R.TAC);
    if (m != null && tacSide) lines.push(['Price impact', `${(Math.max(0, -m) * 100).toFixed(2)}%`, m <= GATE ? 'warn' : '']);
    else if (m != null && (!(r.agg || r.pin) || Math.abs(m) >= 0.01)) lines.push(['Against the market', m <= BAD ? `${(Math.abs(m) * 100).toFixed(1)}% below` : m >= 0.02 ? `${(m * 100).toFixed(1)}% above` : `${m >= 0 ? '+' : '−'}${(Math.abs(m) * 100).toFixed(2)}%`, m <= BAD ? 'warn' : m >= 0.02 ? 'ok' : '']);
    if (m == null && (r.agg || r.sv) && !tacSide) lines.push(['Against the market', 'not checked', '', 'There is no reference price for this pair here, so a thin pool could give a poor rate. Compare the routes before sending, and use a small amount first.']);
    if (r.priv) lines.push(...feeLines(q, r));
    { const a = r.priv && aheadArgs(q), ra = r.priv && !a && routeAheadArgs(q), st = a ? PV?.aheadOf?.(a) : ra ? PV?.routeAheadOf?.(ra) : null;
      if (st) lines.push(['Proof', st === 'ready' ? (a ? 'made: one transaction' : 'made: the relay only sends it') : 'being made, about a minute', st === 'ready' ? 'ok' : '']); }
    { const nudge = r.priv && privRow(q, r); if (nudge) lines.push(nudge); }
    if (r.pout) lines.push(['Chain sees', htmlVal(`${esc(get.sym)} to ${S.to ? whoH(S.to) : W.account ? 'your wallet' : 'the address'}, not from whom`)]);
    else if (r.pin) lines.push(['Chain sees', `your ${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym} for ETH, then a deposit`]);
    else if (r.priv) lines.push(['Chain sees', isEth(S.pay) ? `your ${tidy(amtFmt(q.wei, 18))} ETH deposited` : 'a swap, not whose']);
    else if (laterOn(kind)) { const dep = isEth(S.pay) ? laterDeposit(q) : laterIn(q); lines.push(['Chain sees', `your ${dep != null ? `${tidy(amtFmt(dep, pay.dec))} ` : ''}${pay.sym} going in, not where it goes`]); }
    if (laterOn(kind)) {
      const hopFee = r.hop ? laterFee(q) : null, fee = r.hop ? hopFee : LATER.fee, fu = fee != null ? (r.hop ? usdOf(S.pay, fee) : usdOf(lc(R.ZERO), fee)) : null;
      const text = fee == null ? (LATER.err && !r.hop ? 'could not be read' : '…') : `${r.hop ? `${tidy(amtFmt(fee, pay.dec))} ${pay.sym}` : `${eth2(fee)} ETH`}${fu != null ? ` · about ${fu < 1 ? `$${fu.toFixed(2)}` : usd(fu)}` : ''}`;
      lines.push(depGasLine());
      lines.push(['Relay fee', text, '', 'What the relay charges to send the swap out of the pool, paid from the deposit (set aside twice, for a fee that rises while it waits). The deposit itself pays the wallet’s network fee.']);
      lines.push(['Time', 'within minutes', '', 'Your deposit lands first, then the relay completes the swap out of the pool.']);
    }
    else if (!r.priv && S.gasPrice && S.px.ethUsd && relayNoEth(kind)) {
      const f = Number(GR.GAS_UNITS * S.gasPrice) / 1e18 * S.px.ethUsd * 1.5, sym = lc(S.pay) === lc(R.TAC) ? 'TAC' : tokenOf(S.pay)?.sym;
      lines.push(['Network fee', `about ${f < 1 ? `$${f.toFixed(2)}` : usd(f)}, paid in ${lc(sym) === 'tac' ? 'TAC' : `TAC or ${esc(sym)}`}`, 'ok', 'You hold no ETH for gas, so the relay sends this swap and takes its cost from your balance. TAC pays it when you hold enough, otherwise the token you swap. You sign once and nothing leaves your wallet unless the swap lands.']);
    }
    else if (!r.priv && r.gas && S.gasPrice && S.px.ethUsd) { const f = Number(r.gas * S.gasPrice) / 1e18 * S.px.ethUsd; lines.push(['Network fee', `about ${f < 1 ? `$${f.toFixed(2)}` : usd(f)}`]); }
    if (rows.hidden && q.more > 0) lines.push(['Price', `checking ${q.more} more route${q.more > 1 ? 's' : ''}…`, '', 'A better price may still arrive. Wait a moment before sending.']);
    { const p = !rows.hidden ? null : laterOn(kind) ? laterPts(q, r) : rowPts(r, q); if (p) lines.push(['TAC points', ptsSaid(p, false), 'ok', p.why ? `${p.why}. An estimate: the program counts it from its own records.` : 'An estimate: the program counts it from its own records.']); }
  }
  rc.hidden = !lines.length;
  rc.innerHTML = lines.map(([k, v, c, t, href, act]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${k === 'TAC points' ? TAC_MARK : ''}${esc(k)}</dt><dd class="${c || ''}">${href ? `<a href="${esc(href)}">${esc(v)}</a>` : act ? `<button type="button" class="flip-px" data-${act} aria-label="${esc(v)}. Turn it around">${esc(v)}</button>` : cell(v)}</dd></div>`).join('');
  paintLater(q, r, kind);
  const gate = r && !q.busy && m != null && m <= GATE;
  if (gate) { S.gapNow = Math.abs(m); if (S.ack && S.gapNow > (S.ackGap ?? 0) + 0.02) S.ack = false; }
  if (busy) { } else if (gate) {
    const pub = r.priv ? '.' : ', then make it public.';
    const alt = S.get === lc(R.CUSD) ? ` <a href="/vault/#btc">Borrow cUSD at $1</a>${pub}` : S.get === lc(R.CBTC) ? ` <a href="/vault/#btc">Mint cBTC 1:1</a>${pub}` : '';
    if (!ackbox.querySelector('input') || ackbox.dataset.k !== `${S.pay}>${S.get}`) {
      ackbox.dataset.k = `${S.pay}>${S.get}`;
      const tac = S.pay === lc(R.TAC) || S.get === lc(R.TAC);
      ackbox.innerHTML = tac
        ? `<label class="ack"><input type="checkbox" id="ack"><span>Moves the price <b>${(Math.abs(m) * 100).toFixed(0)}%</b>. Swap anyway</span></label>`
        : `<label class="ack"><input type="checkbox" id="ack"><span><b>${(Math.abs(m) * 100).toFixed(0)}% under</b> market.${alt} Swap anyway</span></label>`;
      $('#ack').checked = S.ack;
    } else { ackbox.querySelector('input').checked = S.ack; ackbox.querySelector('b').textContent = `${(Math.abs(m) * 100).toFixed(0)}%${S.pay === lc(R.TAC) || S.get === lc(R.TAC) ? '' : ' under'}`; }
  } else { ackbox.innerHTML = ''; ackbox.dataset.k = ''; }
  const [label, can, cls, deposit] = button(q, r, kind, gate);
  go.textContent = label; go.disabled = !can; go.className = `go${cls ? ` ${cls}` : ''}`;
  if (deposit) depositSoon(q);
  if (!S.busy) { if (S.note) say(S.note.h, S.note.cls); else say(lineFor(q, r, kind)); }
}
const mintAlt = () => (S.get === lc(R.CUSD) ? ['Borrow cUSD at $1 instead', '/vault/#btc'] : S.get === lc(R.CBTC) ? ['Mint cBTC 1:1 instead', '/vault/#btc'] : null);
const gateButton = () => { const a = mintAlt(); return a ? [a[0], true, 'priv'] : ['Accept the price above to swap', false]; };
function button(q, r, kind, gate) {
  const pay = tokenOf(S.pay), get = tokenOf(S.get);
  if (S.busy) return ['Working…', false];
  if (!kind) return ['Choose another pair', false];
  if (!S.amt || !parseUnits(S.amt, pay.dec)) return [amountWord(S.amt, pay.dec), false];
  if (S.toBad && !S.outP) return ['Check the address', false];
  if (q?.busy) return ['Finding the best price…', false];
  if (!q) return ['Finding the best price…', false];
  if (!r) return [q?.err ? 'Try again' : q?.tiny ? 'Amount too small' : 'No route', !!q?.err];
  if (S.toBusy && !S.outP) return ['Finding the address…', false];
  const tTyped = S.outP && S.toOpen && $('#to-in').value.trim() !== '', tLabel = S.toTacit ? ` → ${esc(tacitName(S.toTacit))}` : '';
  if (kind === 'pin') {
    if (!W.account) return ['Connect wallet', true];
    if (tTyped && S.toTacitBad) return ['Check the address', false];
    if (tTyped && !S.toTacit) return ['Finding their address…', false];
    const bal = S.bal[S.pay], eth = S.bal[lc(R.ZERO)], tip = q.tip || 0n;
    if (bal != null && q.wei > bal) return [`Not enough ${pay.sym}`, false];
    if (eth != null && tip + 2n * gasKeep() > eth) return ['Leave some ETH for the network fee', false];
    if (gate && !S.ack) return gateButton();
    return [FLOW === 'shield' && !S.toTacit ? `Shield ${pay.sym}` : `Swap privately${tLabel}`, true, 'priv'];
  }
  if (kind === 'pout') {
    const pb = privBal(S.pay);
    if (S.toBad) return ['Check the address', false];
    const dest = outTo();
    if (!dest) return ['Add the address it goes to', false];
    if (pb != null && q.wei > pb && !stagedFits(S.pay, q.wei)) return [`Not enough private ${pay.sym}`, false];
    if (gate && !S.ack) return gateButton();
    return [S.to ? `Swap privately → ${who(dest)}` : 'Swap privately to your wallet', true, 'priv'];
  }
  if (kind === 'private') {
    const bal = isEth(S.pay) && W.account ? S.bal[S.pay] : null, tip = q.tip || 0n, pb = isEth(S.pay) ? null : privBal(S.pay);
    if (bal != null && q.wei > bal) return [`Not enough ${pay.sym}`, false];
    if (bal != null && q.wei + tip + gasKeep() > bal) return ['Leave some ETH for the network fee', false];
    if (pb != null && q.wei > pb && !stagedFits(S.pay, q.wei)) return [`Not enough private ${pay.sym}`, false];
    if (gate && !S.ack) return gateButton();
    if (tTyped && S.toTacitBad) return ['Check the address', false];
    if (tTyped && !S.toTacit) return ['Finding their address…', false];
    return [S.get === 'teth' && isEth(S.pay) ? (S.toTacit ? `Send privately${tLabel}` : FLOW === 'shield' ? `Shield ${pay.sym}` : 'Make it private') : `Swap privately${tLabel}`, true, 'priv'];
  }
  if (S.toBad) return ['Check the address', false];
  if (!W.account) return ['Connect wallet', true];
  if (laterOn(kind)) {
    const dep = laterDeposit(q), eth = S.bal[lc(R.ZERO)], typed = $('#to-in').value.trim(), pool = laterPool(), tok = !isEth(S.pay), tin = tok ? laterIn(q) : null, held = tok ? S.bal[S.pay] : null;
    if (pool && typed && !/^0x/i.test(typed)) { if (S.toTacitBad) return ['Check the address', false]; if (!S.toTacit) return ['Finding their address…', false]; }
    else if (!pool && !S.to) return ['Add the address it goes to', false];
    else if (typed && S.toBad) return ['Check the address', false];
    if (S.to && lc(S.to) === lc(W.account)) return ['Use another address than this wallet', false];
    if (dep == null) return [LATER.err ? 'Try again' : 'Reading the relay’s fee…', !!LATER.err];
    const payer = tok ? depPayer() : 'eth';
    if (tok && payer !== 'eth' && LATER.boxFee == null) return ['Reading the relay’s fee…', false];
    if (tok && tin == null) return ['Finding the best price…', false];
    if (tok && held != null && tin > held) return [`Not enough ${pay.sym} for the deposit`, false];
    if (payer === 'token') { const f = relayWei() != null ? tokenWei(S.pay, relayWei()) : null; if (held != null && f != null && tin + f > held) return [`Leave about ${tidy(amtFmt(f, pay.dec))} ${pay.sym} for the network fee`, false]; }
    if (payer === 'eth' && (tok ? eth != null && 2n * gasKeep() > eth : eth != null && dep + gasKeep() > eth)) return [tok ? 'Leave some ETH for the network fee' : 'Not enough ETH for the deposit', false];
    if (payer !== 'eth' && plans().some((p) => p.boxed && (p.state === 'depositing' || p.state === 'unsure') && p.from === lc(W.account) && Date.now() - p.at < 2400e3)) return ['A deposit is on its way: see below', false];
    if (gate && !S.ack) return gateButton();
    const d = laterDest(), tail = d.kind === 'me' ? ' → private' : d.kind === 'tacit' ? ` → ${tacitName(S.toTacit)}` : '';
    return [`Deposit ${tok ? `${tidy(amtFmt(tin, pay.dec))} ${pay.sym}` : `${tidy(amtFmt(dep, 18))} ETH`}${tail}`, true, 'priv', true];
  }
  const bal = S.bal[S.pay], wei = q.wei;
  if (bal != null && wei > bal) return [`Not enough ${pay.sym}`, false];
  if (bal != null && isEth(S.pay) && S.gasPrice && wei + r.gas * S.gasPrice > bal) return ['Leave some ETH for the network fee', false];
  if (gate && !S.ack) return gateButton();
  const to = recipient(), tail = to ? ` → ${who(to)}` : '';
  return [(isEth(S.get) || kind === 'out' ? `Sell ${pay.sym}` : isEth(S.pay) || kind === 'any' || kind === 'in' ? `Buy ${get.sym}` : `Swap ${pay.sym} for ${get.sym}`) + tail, true];
}
function lineFor(q, r, kind) {
  if (!kind) return S.inP && S.outP && S.pay === S.get ? 'Pick another coin to get.' : S.inP && tacitKey(S.get) && !S.outP ? `To take it out as ${esc(tokenOf(S.get).sym)}, <a href="/">use the Tacit app</a>.` : !S.inP && S.outP && tacitKey(S.pay) ? `To make ${esc(tokenOf(S.pay).sym)} private, <a href="/">use the Tacit app</a>.` : 'No route for this pair.';
  if (q?.err && !q.busy) return `<span class="err">${esc(q.err)}</span>`;
  if (!q?.busy && S.amt && (q?.none || !r) && q?.why) return esc(q.why);
  return '';
}
function privRow(q, r) {
  const m = vsMarket(q, r);
  if (m != null && m <= BAD && S.get === lc(R.CUSD)) return ['Cheaper', 'borrow cUSD at $1 →', '', 'The vault makes cUSD for a dollar', '/vault/#btc'];
  if (m != null && m <= BAD && S.get === lc(R.CBTC)) return ['Cheaper', 'mint cBTC 1:1 →', '', 'The vault makes cBTC against bitcoin', '/vault/#btc'];
  const p = q.pools?.[q.pools.length - 1], f = p && farmOn(p);
  return f ? ['Earn', `${f.apr != null ? `${aprText(f.apr)} on ` : ''}${f.name} →`, '', `Deepen ${f.name} privately: add liquidity and farm it`, `/#farm/private-${Number(f.pid)}`] : null;
}

let PENDING = null;
async function pendingState(h, from) {
  const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null);
  if (rc) return { rc };
  const tx = await rpc('eth_getTransactionByHash', [h]).catch(() => null);
  if (tx?.nonce == null || tx.blockNumber) return {};
  const count = await rpc('eth_getTransactionCount', [from, 'latest']).then(BigInt, () => null);
  return { gone: count != null && count > BigInt(tx.nonce) };
}
async function landed(h, from, what) {
  const t0 = Date.now();
  try { return await wallet.receipt(h); } catch { }
  PENDING = { h, from, s: what }; remember(h, `${what} · not confirmed yet`); paintRecent();
  for (let gone = 0; Date.now() - t0 < 30 * 60e3; ) {
    say(`Sent ${txLink(h)}. Not confirmed yet, ${Math.round((Date.now() - t0) / 60e3)} minutes on: still waiting for it to land. Do not send it again.`);
    await new Promise((r) => setTimeout(r, 15e3));
    const st = await pendingState(h, from);
    if (st.rc) { PENDING = null; return st.rc; }
    if (st.gone && ++gone > 1) { PENDING = null; throw Object.assign(new Error(`${txLink(h)} was replaced or dropped before it was mined (sped up or cancelled in the wallet). Check your wallet: a replacement that swapped needs nothing more.`), { html: true }); }
    if (!st.gone) gone = 0;
  }
  throw Object.assign(new Error(`${txLink(h)} is still not confirmed. Check it on Etherscan before sending anything again; this card looks for it before its next swap.`), { html: true });
}
async function pendingHolds() {
  if (!PENDING) return false;
  const { h, from, s } = PENDING, st = await pendingState(h, from);
  if (st.rc) { PENDING = null; remember(h, st.rc.status === '0x1' ? s : `${s} · failed`); paintRecent(); H.onDone?.(); readBalances().then(paintSides, () => {}); return false; }
  if (st.gone) { PENDING = null; say(`Your last swap ${txLink(h)} was replaced or dropped before it was mined. Check your wallet before sending another.`, '', true); return true; }
  say(`Your last swap ${txLink(h)} is not confirmed yet. Check it on Etherscan before sending another.`, '', true);
  return true;
}
async function go() {
  if ($('#go').dataset.ask) { $('#amt').focus(); return; }
  const mk = moveOf();
  if (mk) { if (!S.busy && !S.mq?.busy) H.moves.go(mk, S.amt); return; }
  if (exiting()) { if (S.q?.err) requote(true); else await exitGo(); return; }
  const kind = kindOf(S.pay, S.get), r = picked();
  if (S.busy) return;
  if (!r) { if (S.q?.err) requote(true); return; }
  if (!S.ack && mintAlt() && S.q && !S.q.busy && (vsMarket(S.q, r) ?? 0) <= GATE) { location.href = mintAlt()[1]; return; }
  S.note = '';
  if (kind === 'private' || kind === 'pout' || kind === 'pin') { await privateGo(r, kind); return; }
  if (laterOn(kind)) {
    if (!W.account) { await H.connect(); return; }
    if (!picked()?.hop && LATER.fee == null) { await readFee(); return; }
    await laterGo(); return;
  }
  if (!W.account) { await H.connect(); return; }
  if (PENDING) { S.busy = true; paintQuote(); const held = await pendingHolds().catch(() => true); S.busy = false; paintQuote(); if (held) return; }
  const from = W.account, P = { kind, r, q: S.q, wei: S.q.wei, slip: S.slip, floor: (r.out * BigInt(10000 - S.slip)) / 10000n, pay: S.pay, get: S.get, to: recipient() };
  if (S.toBad) return;
  if (['tac', 'any', 'in', 'out', 'agg'].includes(P.kind) && !isEth(P.pay)) { S.busy = true; const plan = await relayPlan(from).catch(() => null); S.busy = false; if (plan) { await relayGo(P, from, plan); return; } }
  S.busy = true; approved = ''; zeroed = ''; paintQuote();
  const beforeP = P.to ? null : balanceNow(P.get, from).catch(() => null);
  let before = null;
  try {
    say('Reading the price again…');
    const tx = await prepare(P, from);
    if (!tx) return;
    before = await beforeP;
    say(P.to ? `Confirm the swap in your wallet. It sends the ${esc(tokenOf(P.get).sym)} to ${whoH(P.to)}.` : 'Confirm the swap in your wallet.');
    const h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from, label: 'Swap' });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    live('Swap sent');
    const rc = await landed(h, from, `${tidy(amtFmt(P.wei, tokenOf(P.pay).dec))} ${tokenOf(P.pay).sym} → ${tidy(amtFmt(P.r.out, tokenOf(P.get).dec))} ${tokenOf(P.get).sym}${P.to ? ` · to ${who(P.to)}` : ''}`);
    if (rc.status !== '0x1') throw Object.assign(new Error(`The transaction failed (${txLink(h)}). Nothing was swapped.`), { html: true });
    reward(rowPts(P.r, P.q));
    const after = P.to ? null : await balanceNow(P.get, from).catch(() => null), got = before != null && after != null ? after - before : null;
    const g = tokenOf(P.get), where = P.to ? whoH(P.to) : 'your wallet';
    S.lastBuy = P.get === lc(R.TAC) && got > 0n ? got : null;
    if (P.to) { S.to = null; S.toOpen = false; S.toBad = ''; $('#to-in').value = ''; }
    S.amt = ''; S.q = null; S.seq++; S.busy = false; changed(); paint();
    say(`Done ${txLink(h)}: ${isEth(P.get) ? `about ${tidy(amtFmt(P.r.out, g.dec))} ETH to ${where}` : P.to ? `about ${tidy(amtFmt(P.r.out, g.dec))} ${esc(g.sym)} sent to ${where}` : got != null && got > 0n ? `${tidy(amtFmt(got, g.dec))} ${esc(g.sym)} in your wallet` : `${esc(g.sym)} sent to your wallet`}.${!isEth(P.get) && !P.to ? ` <button type="button" class="link" data-watch="${esc(g.addr)}">Add ${esc(g.sym)} to your wallet</button>` : ''}${S.lastBuy && H.farmIt ? ` · <button type="button" class="link" data-farm-it>Farm it</button>` : ''}`, 'ok', true);
    remember(h, `${tidy(amtFmt(P.wei, tokenOf(P.pay).dec))} ${tokenOf(P.pay).sym} → ${tidy(amtFmt(got != null && got > 0n && !isEth(P.get) ? got : P.r.out, g.dec))} ${g.sym}${P.to ? ` · to ${who(P.to)}` : ''}`); paintRecent();
    live('Swap done'); H.onDone?.();
    readBalances().then(() => paintSides());
    readPrices().catch(() => {});
  } catch (e) {
    S.busy = false; paintQuote();
    say(e instanceof UserStopped || e?.userStopped ? declinedWords(e, unsent()) : `<span class="err">${e?.html ? e.message : esc(e?.message || String(e)).slice(0, 300)}</span>`, '', true);
  } finally { S.busy = false; }
}
let GR_LIVE = null;
const RELAY_KINDS = ['tac', 'any', 'in', 'out', 'agg'];
const relayNoEth = (kind) => !!(GR_LIVE && W.account && RELAY_KINDS.includes(kind) && !isEth(S.pay) && S.bal[lc(R.ZERO)] != null && S.gasPrice && GR.needsRelay({ ethWei: S.bal[lc(R.ZERO)], gasPriceWei: S.gasPrice }));
const relayLiveCheck = () => { if (GR_LIVE == null) light('eth_getCode', [GR.GAS_RELAY[1], 'latest']).then((c) => { GR_LIVE = String(c).length > 2; if (GR_LIVE) paintQuote(); }, () => {}); };
async function relayPlan(from) {
  const relay = GR.GAS_RELAY[1];
  if (GR_LIVE == null) GR_LIVE = String(await rpc('eth_getCode', [relay, 'latest']).catch(() => '0x')).length > 2;
  if (!GR_LIVE) return null;
  const [ethWei, gasPrice] = await Promise.all([rpc('eth_getBalance', [from, 'latest']).then(BigInt), rpc('eth_gasPrice', []).then(BigInt)]);
  return GR.needsRelay({ ethWei, gasPriceWei: gasPrice }) ? { gasPrice } : null;
}
const kyberEthTo = async (token, wei) => {
  const r = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?${new URLSearchParams({ tokenIn: '0xEeeeeEeeeEeEeeEeEeeEeEEEeeeeEeeeeeeeEEeE', tokenOut: token, amountIn: String(wei) })}`, { signal: AbortSignal.timeout(8000) }).then((q) => (q.ok ? q.json() : null)).catch(() => null);
  const o = r?.data?.routeSummary?.amountOut;
  return /^\d+$/.test(String(o ?? '')) ? BigInt(o) : null;
};
let RELAY_MODE = null;
async function relayGo(P, from, plan) {
  S.busy = true; paintQuote();
  try {
    const relay = GR.GAS_RELAY[1], pt = tokenOf(P.pay), gt = tokenOf(P.get), dest = P.to || from, tac = lc(R.TAC);
    say('No ETH needed: reading the price and the fee…');
    RELAY_MODE = { amountIn: P.wei };
    let tx, amt;
    try { tx = await prepare({ ...P, to: dest }, relay); amt = RELAY_MODE.amountIn; } finally { RELAY_MODE = null; }
    if (!tx) return;
    if (tx.value && BigInt(tx.value) !== 0n) throw new Error('This route sends ETH, so it cannot be paid for in TAC. Nothing was sent.');
    const call = { to: tx.to, data: tx.data }, min = P.floor;
    const permitTok = !!GR.PERMIT_TOKENS[lc(P.pay)], bal = (k) => S.bal[k] ?? 0n;
    const feeOk = (k, f) => { const fu = usdOf(lc(k), f), su = usdOf(lc(P.pay), amt); return !(fu != null && fu > 25) && !(fu != null && su != null && fu * 4 > su); };
    let feeToken = P.pay, fee = await GR.feeFor({ gasPriceWei: plan.gasPrice, ethToToken: (w) => kyberEthTo(P.pay, w) });
    if (permitTok && lc(P.pay) !== tac) { const ft = await GR.feeFor({ gasPriceWei: plan.gasPrice, ethToToken: (w) => kyberEthTo(R.TAC, w) }); if (ft != null && bal(tac) >= ft && feeOk(tac, ft)) { feeToken = R.TAC; fee = ft; } }
    if (fee == null) throw new Error('Could not price the network fee. Nothing was sent.');
    if (!feeOk(feeToken, fee)) throw new Error(`The network fee is too high for this swap right now (${tidy(amtFmt(fee, lc(feeToken) === tac ? 18 : pt.dec))} ${lc(feeToken) === tac ? 'TAC' : esc(pt.sym)}). Swap more, add a little ETH, or try when gas is lower. Nothing was sent.`);
    if (lc(feeToken) === lc(P.pay) && fee * 4n > amt) throw new Error(`The network fee (${tidy(amtFmt(fee, pt.dec))} ${esc(pt.sym)}) is more than a quarter of this swap. Swap more, or add a little ETH. Nothing was sent.`);
    const total = lc(feeToken) === lc(P.pay) ? amt + fee : amt;
    if (bal(lc(P.pay)) < total) throw new Error(`Not enough ${esc(pt.sym)}: the swap and the network fee need ${tidy(amtFmt(total, pt.dec))}.`);
    const { order, data } = GR.buildOrder({ payer: from, tokenIn: P.pay, amountIn: amt, feeToken, fee, tokenOut: isEth(P.get) ? R.ZERO : P.get, minOut: min, recipient: dest, target: call.to, data: call.data, now: chainNow() });
    const feeTxt = `${tidy(amtFmt(fee, lc(feeToken) === tac ? 18 : pt.dec))} ${lc(feeToken) === tac ? 'TAC' : esc(pt.sym)}`;
    let inPermit = GR.NO_PERMIT, feePermit = GR.NO_PERMIT, p2 = GR.NO_P2;
    const dl = chainNow() + 900;
    const beforeP = P.to ? null : balanceNow(P.get, from).catch(() => null);
    say(`Sign the swap in your wallet. ${feeTxt} pays the network fee: no ETH is needed.`);
    if (permitTok) {
      const nonceOf = async (t) => wordAt(await ethCall(t, '0x7ecebe00' + addrWord(from)), 0);
      const sp = async (t, value) => { const td = GR.permitTypedData({ token: t, owner: from, value, nonce: await nonceOf(t), deadline: dl }); return { value: String(value), deadline: String(dl), ...GR.splitSig(await signTyped(td, from)) }; };
      inPermit = await sp(P.pay, total);
      if (lc(feeToken) !== lc(P.pay)) feePermit = await sp(feeToken, fee);
    } else {
      const allow = wordAt(await ethCall(P.pay, '0xdd62ed3e' + addrWord(from) + addrWord(GR.PERMIT2)), 0);
      if (allow < total) throw new Error(`${esc(pt.sym)} has not been approved for Permit2 from this wallet yet, which takes one transaction with a little ETH. Nothing was sent.`);
      const pn = wordAt(await ethCall(GR.PERMIT2, '0x927da105' + addrWord(from) + addrWord(P.pay) + addrWord(relay)), 2);
      const b = GR.permit2TypedData({ details: [{ token: P.pay, amount: total, expiration: dl, nonce: pn }], owner: from, deadline: dl });
      p2 = { use: true, batch: b.batch, sig: await signTyped(b.typed, from) };
    }
    const signature = await signTyped(GR.orderTypedData(order), from);
    say('Sending it to the relay…');
    const before = await beforeP;
    const r = await fetch(`${API}/gas/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: { order, data, signature, inPermit, feePermit, p2 } }), signal: AbortSignal.timeout(15e3) }).then((q) => q.json()).catch(() => null);
    if (r && !r.ok) throw new Error(`${calmText(r?.error) && calmText(r?.error) !== String(r?.error) ? calmText(r.error) : 'The relay did not take the order.'} Nothing was spent.`);
    if (!r) say('The relay did not answer. Checking whether it took the order…');
    const usedSel = '0xad04dc3f' + addrWord(from) + BigInt(order.nonce).toString(16).padStart(64, '0');
    say('Waiting for the relay to send it. Nothing leaves your wallet unless the swap lands.');
    let done = false, read = false;
    const t0 = Date.now(), end = t0 + Math.max(0, Number(order.deadline) - chainNow() + 15) * 1000;
    while (Date.now() < end && !done) {
      await new Promise((q) => setTimeout(q, 3000)); done = wordAt(await ethCall(relay, usedSel).then((x) => { read = true; return x; }, () => { read = false; return '0x'; }), 0) === 1n;
      if (!done) say(`Waiting for the relay to send it (${Math.round((Date.now() - t0) / 1000)} s). Nothing leaves your wallet unless the swap lands.`);
    }
    const ran = done ? await rpc('eth_blockNumber', []).then((h) => rpc('eth_getLogs', [{ address: relay, topics: ['0x533053a5fad9470861fb5df750d47e5f011faa03daba05299fe4bdc65f52d519', '0x' + addrWord(from), null, '0x' + BigInt(order.nonce).toString(16).padStart(64, '0')], fromBlock: '0x' + (BigInt(h) > 200n ? BigInt(h) - 200n : 0n).toString(16), toBlock: 'latest' }])).then((l) => l?.[0]?.transactionHash || null, () => null) : null;
    if (!done && !read) throw new Error('The relay’s answer could not be read, so it may have sent the order. Check your wallet before sending anything more.');
    if (!done) throw new Error('The relay did not send it before the order expired. Nothing was spent. Try again.');
    const after = P.to ? null : await balanceNow(P.get, from).catch(() => null), got = before != null && after != null ? after - before : null;
    if (P.to) { S.to = null; S.toOpen = false; S.toBad = ''; $('#to-in').value = ''; }
    S.amt = ''; S.q = null; S.seq++; S.busy = false; changed(); paint();
    say(`Done: ${got != null && got > 0n ? `${tidy(amtFmt(got, gt.dec))} ${esc(gt.sym)} in your wallet` : `about ${tidy(amtFmt(P.r.out, gt.dec))} ${esc(gt.sym)} to ${whoH(dest)}`}. The network fee was ${feeTxt}.${ran ? ` ${txLink(ran)}` : ''}`, 'ok', true);
    if (ran) { remember(ran, `${tidy(amtFmt(P.wei, pt.dec))} ${pt.sym} → ${tidy(amtFmt(got != null && got > 0n ? got : P.r.out, gt.dec))} ${gt.sym}${P.to ? ` · to ${who(P.to)}` : ''}`); paintRecent(); }
    live('Swap done'); H.onDone?.();
    readBalances().then(() => paintSides());
    readPrices().catch(() => {});
  } catch (e) {
    S.busy = false; paintQuote();
    say(e instanceof UserStopped || e?.userStopped ? declinedWords(e, 'Nothing was sent.') : `<span class="err">${e?.html ? e.message : esc(e?.message || String(e)).slice(0, 300)}</span>`, '', true);
  } finally { S.busy = false; }
}
const balanceNow = async (k, who) => (isEth(k) ? BigInt(await rpc('eth_getBalance', [who, 'latest'])) : wordAt(await ethCall(k, '0x70a08231' + addrWord(who)), 0));

async function prepare(P, from) {
  const floorFor = (out) => { const f = (out * BigInt(10000 - P.slip)) / 10000n; return f > P.floor ? f : P.floor; };
  await chainTime();
  if (!S.chainT) throw new Error('Could not read the chain’s clock, which the swap’s deadline counts from. Nothing was sent; try again.');
  const dl = chainDeadline(1200), dest = P.to || from;
  const moved = () => { say('The price moved below the least you accept. Nothing was sent; the quote above is the new one.', '', true); S.busy = false; requote(true); return null; };
  let tx;
  if (P.kind === 'tac') {
    const dir = isEth(P.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: P.wei, account: from, gasPrice: gasPrice() });
    const pick = P.r.split ? rt.split : (rt.r.ranked || []).find((v) => v.venue === P.r.venue.venue);
    if (!pick) { say('That route is no longer offered. Nothing was sent; press again for the new quote.', '', true); S.busy = false; requote(true); return null; }
    if (BigInt(pick.amountOut) < P.floor) return moved();
    const floor = floorFor(BigInt(pick.amountOut)), isSplit = !!P.r.split;
    const make = (permit) => (isSplit ? venues.buildSplit({ split: pick, account: from, to: dest, minOut: floor, deadline: dl, permit }) : venues.build({ quote: pick, dir, account: from, to: dest, minOut: floor, deadline: dl, permit }));
    tx = make();
    if (tx.approval && RELAY_MODE) { if (lc(tx.approval.spender) !== lc(tx.to)) throw new Error('This route needs a different spender, so it cannot be paid for in TAC. Pick another route or add a little ETH.'); RELAY_MODE.amountIn = P.wei; }
    else if (tx.approval) tx = await withAccess({ tx, make, from, dl, permit: pick.venue === 'precision' || pick.venue === 'tacit-amm' || isSplit });
  } else if (P.kind === 'amm') {
    const q = await R.quoteAmm({ ethCall, tokenIn: isEth(P.pay) ? R.ZERO : P.pay, tokenOut: isEth(P.get) ? R.ZERO : P.get, amountIn: P.wei });
    if (!q || q.amountOut < P.floor) return moved();
    const floor = floorFor(q.amountOut);
    let permit = null;
    if (!isEth(P.pay)) {
      const acc = await R.readAccess({ ethCall, token: P.pay, owner: from, spender: R.TACIT_AMM });
      if (acc.allowed < q.amountIn) {
        say(`Sign the permit for your ${esc(tokenOf(P.pay).sym)} in your wallet. The signature costs nothing.`);
        const accR = await R.readAccess({ ethCall, token: P.pay, owner: from, spender: R.CONF_ROUTER });
        permit = await signedOr(async () => R.splitSig(await signTyped(R.permitTyped({ token: P.pay, name: 'Tacit Token', version: '1', owner: from, spender: R.CONF_ROUTER, value: q.amountIn, nonce: accR.nonce, deadline: dl }), from)),
          async () => { await approve(P.pay, R.TACIT_AMM, q.amountIn, from, acc.allowed); return null; });
      }
    }
    tx = R.buildAmm({ quote: q, account: from, to: dest, minOut: floor, deadline: dl, permit });
  } else if (P.kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: P.pay, amountIn: P.wei, account: from, slippageBps: P.slip, deadline: dl }), 15e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.tacOut < P.floor) return moved();
    const floor = floorFor(q.tacOut), access = await anyAccess(q, from);
    tx = R.buildAnyToTac({ quote: q, account: from, to: dest, minOut: floor, keccak256: keccak_256, access });
  } else if (P.kind === 'out') {
    const q = await within(R.quoteTacitToToken({ ethCall, venues, tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, account: from, to: dest, slippageBps: P.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.out < P.floor || q.min < (P.r.min ?? P.floor)) return moved();
    tx = R.buildTacitToToken({ quote: q, account: from, to: dest, venues, access: await tacitAccess(P.pay, q.amountIn, from, dl) });
  } else if (P.kind === 'in') {
    { const live = await R.ammRouteLive({ ethCall }); if (live !== true) { if (live === false) S.ammRoute = false; say(live === false ? 'That swap is not available right now. Nothing was sent.' : 'Could not check that swap right now. Nothing was sent; try again.', '', true); S.busy = false; paint(); return null; } }
    const q = await within(R.quoteTokenToTacit({ ethCall, token: P.pay, tokenOut: P.get, amountIn: P.wei, account: from, to: dest, slippageBps: P.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.out < P.floor) return moved();
    tx = R.buildTokenToTacit({ quote: q, account: from, to: dest, minOut: floorFor(q.out), access: await anyAccess(q, from) });
  } else if (P.kind === 'agg' && P.r.sv) {
    const v = SV.solverOf(P.r.sv.id), pt = tokenOf(P.pay), gt = tokenOf(P.get);
    say('Reading the price again…');
    const f = await SV.firm(v.id, { tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, decIn: pt.dec, decOut: gt.dec, slippageBps: P.slip }, P.r.sv.ctx);
    if (!f) { say(`${esc(v.name)} has no route for this right now. Nothing was sent; the quote above is the new one.`, '', true); S.busy = false; requote(true); return null; }
    if (f.out != null && f.out < P.floor) return moved();
    const min = floorFor(f.out ?? P.floor);
    const call = SV.snwapCall({ tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, to: dest, minOut: min, fwd: v.fwd, router: f.router, data: f.data });
    const why = checkSnwapCall(call.data, { to: dest, tokenIn: P.pay, tokenOut: P.get, amount: P.wei, minOut: min, executor: v.fwd });
    if (why) { AVOID.set(v.id, Date.now() + 5 * 60e3); say(`${esc(v.name)}’s route was refused (${esc(why)}). Nothing was sent; the next best route is shown.`, '', true); S.busy = false; S.hold = false; requote(true); return null; }
    const access = isEth(P.pay) ? null : await anyAccess({ token: P.pay, maxIn: P.wei, deadline: dl }, from, { permit2: false });
    tx = snwapTx(call, P, access);
  } else if (P.kind === 'agg') {
    const shown = P.r.agg;
    P.reused = !!shown && now() - (P.r.at || 0) <= 90 && lc(shown.to) === lc(dest) && lc(shown.refundTo) === lc(from) && shown.amountIn === P.wei && lc(shown.tokenIn) === lc(P.pay) && lc(shown.tokenOut) === lc(P.get) && shown.slippageBps === P.slip;
    const q = P.reused ? shown : await within(A.bestRoute({ ethCall, to: dest, refundTo: from, tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, slippageBps: P.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.out < P.floor || q.min < (P.r.min ?? P.floor)) return moved();
    tx = await aggTx(q, from);
  } else throw new Error('Nothing to do for this pair.');
  if (RELAY_MODE) return tx;
  say('Checking it first…');
  const sim = await venues.simulate({ tx, from });
  if (!sim.ok) {
    if (P.r.sv) { AVOID.set(P.r.sv.id, Date.now() + 5 * 60e3); say(`${unsent(`${esc(tokenOf(P.get).sym)} through ${esc(P.r.name)} would fail`)} The next best route is shown.`, '', true); S.busy = false; S.hold = false; requote(true); return null; }
    if (P.reused) { say(`${unsent('The price moved')} It is read again: check it and press once more.`, '', true); S.busy = false; requote(true); return null; }
    throw Object.assign(new Error(`${unsent('This swap would fail')} Try a smaller amount or try again.`), { html: true });
  }
  return tx;
}
async function withAccess({ tx, make, from, dl, permit }) {
  const acc = await R.readAccess({ ethCall, token: R.TAC, owner: from, spender: tx.approval.spender });
  if (acc.allowed >= tx.approval.amount) return tx;
  if (permit) {
    say('Sign the permit for your TAC in your wallet. The signature costs nothing.');
    try {
      const sig = R.splitSig(await signTyped(R.permitTyped({ token: R.TAC, name: 'Tacit Token', version: '1', owner: from, spender: tx.approval.permitSpender || tx.approval.spender, value: tx.approval.amount, nonce: acc.nonce, deadline: dl }), from));
      return make({ value: tx.approval.amount, deadline: dl, ...sig });
    } catch (e) {
      if (e instanceof UserStopped || e?.userStopped || /account changed/i.test(e?.message || '') || !cantSign(e)) throw e;
      say('Your wallet cannot sign a permit. Approve the TAC for this pool in your wallet.');
    }
  }
  await approve(R.TAC, tx.approval.spender, tx.approval.amount, from, acc.allowed);
  return tx;
}
const cantSign = (e) => [-32601, 4200].includes(e?.code) || /wrong length|not supported|unsupported|does not support|method .*not (found|available|implemented)/i.test(String(e?.message || e || ''));
async function signedOr(sign, instead) {
  try { return await sign(); }
  catch (e) {
    if (e instanceof UserStopped || e?.userStopped || /account changed/i.test(e?.message || '') || !cantSign(e)) throw e;
    say('Your wallet cannot sign a permit. Approve the token in your wallet instead.');
    return instead();
  }
}
async function tacitAccess(token, amount, from, dl) {
  if (RELAY_MODE) { RELAY_MODE.amountIn = amount; return { kind: 'approved' }; }
  const t = tokenOf(lc(token)), acc = await R.readAccess({ ethCall, token, owner: from });
  if (acc.balance < amount) throw new Error(`Not enough ${t.sym}.`);
  if (acc.allowed >= amount) return { kind: 'approved' };
  say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
  return signedOr(async () => ({ kind: 'permit', value: amount, deadline: dl, ...R.splitSig(await signTyped(R.permitTyped({ token, name: 'Tacit Token', version: '1', owner: from, spender: R.ZROUTER, value: amount, nonce: acc.nonce, deadline: dl }), from)) }),
    async () => { await approve(token, R.ZROUTER, amount, from, acc.allowed); return { kind: 'approved' }; });
}
async function aggTx(q, from) {
  if (isEth(q.tokenIn)) return { to: R.ZROUTER, data: q.callData, value: q.value };
  const access = await anyAccess({ token: q.tokenIn, maxIn: q.amountIn, deadline: q.deadline }, from, { permit2: false });
  const legs = R.accessLegs(access, q.tokenIn, q.amountIn, 'aggTx');
  return { to: R.ZROUTER, data: legs.length ? R.encMulticall([...legs, ...A.legsOf(q.callData)]) : q.callData, value: q.value };
}
function snwapTx(call, P, access) {
  if (!access) return call;
  const legs = R.accessLegs(access, P.pay, P.wei, 'snwapTx');
  return { to: call.to, data: legs.length ? R.encMulticall([...legs, call.data]) : call.data, value: 0n };
}
async function anyAccess(q, from, { permit2 = true } = {}) {
  if (RELAY_MODE) { RELAY_MODE.amountIn = q.maxIn ?? q.amountIn; return { kind: 'approved' }; }
  const t = tokenOf(lc(q.token)), acc = await R.readAccess({ ethCall, token: q.token, owner: from });
  if (acc.balance < q.maxIn) throw new Error(`Not enough ${t.sym}: the swap may spend up to ${tidy(amtFmt(q.maxIn, t.dec))}.`);
  if (acc.allowed >= q.maxIn) return { kind: 'approved' };
  if (t.permit === undefined) t.permit = (await R.readToken({ ethCall, keccak256: keccak_256, address: q.token }).catch(() => null))?.permit ?? null;
  if (t.permit === 'dai') {
    say('Sign DAI’s permit in your wallet. The signature costs nothing.');
    return signedOr(async () => ({ kind: 'dai', nonce: acc.nonce, expiry: q.deadline, ...R.splitSig(await signTyped(R.daiPermitTyped({ owner: from, nonce: acc.nonce, expiry: q.deadline }), from)) }),
      async () => { await approve(q.token, R.ZROUTER, q.maxIn, from, acc.allowed); return { kind: 'approved' }; });
  }
  if (t.permit && acc.nonce != null) {
    say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    const name = await tokenName(q.token);
    return signedOr(async () => ({ kind: 'permit', value: q.maxIn, deadline: q.deadline, ...R.splitSig(await signTyped(R.permitTyped({ token: q.token, name, version: t.permit, owner: from, spender: R.ZROUTER, value: q.maxIn, nonce: acc.nonce, deadline: q.deadline }), from)) }),
      async () => { await approve(q.token, R.ZROUTER, q.maxIn, from, acc.allowed); return { kind: 'approved' }; });
  }
  if (permit2 && acc.permit2 >= q.maxIn) {
    say(`Sign a Permit2 transfer of your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    const nonce = R.randomNonce();
    return { kind: 'permit2', nonce, deadline: q.deadline, signature: await signTyped(R.permit2Typed({ token: q.token, amount: q.maxIn, nonce, deadline: q.deadline }), from) };
  }
  await approve(q.token, R.ZROUTER, q.maxIn, from, acc.allowed);
  return { kind: 'approved' };
}
const NAMES = new Map();
async function tokenName(token) {
  if (NAMES.has(lc(token))) return NAMES.get(lc(token));
  const t = await R.readToken({ ethCall, keccak256: keccak_256, address: token });
  NAMES.set(lc(token), t?.name || '');
  return t?.name || '';
}
let approved = '', zeroed = '';
const unsent = (lead = '') => (approved ? `${lead ? `${lead}. ` : ''}Your approval of ${esc(approved)} went through; the swap was not sent.`
  : zeroed ? `${lead ? `${lead}. ` : ''}Your ${esc(zeroed)} allowance was set to zero; nothing else was sent.` : lead ? `${lead}, so nothing was sent.` : 'Nothing was sent.');
async function approve(token, spender, amount, from, had) {
  const t = tokenOf(lc(token));
  if (had > 0n && (t?.sym === 'USDT' || lc(token) === '0xdac17f958d2ee523a2206206994597c13d831ec7')) {
    say('Your USDT allowance is reset to zero first (USDT asks for this).');
    const h0 = await wallet.sendTx({ to: token, data: R.encApprove(spender, 0n), from, label: 'Reset an allowance' });
    if ((await wallet.receipt(h0)).status !== '0x1') throw new Error('The reset did not go through.');
    zeroed = t?.sym || 'USDT';
  }
  say(`Approve exactly this much ${esc(t?.sym || 'of the token')} in your wallet, once.`);
  const h = await wallet.sendTx({ to: token, data: R.encApprove(spender, amount), from, label: `Approve ${t?.sym || 'a token'}` });
  say(`Waiting for the approval ${txLink(h)}…`);
  if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
  approved = `${tidy(amtFmt(amount, t?.dec ?? 18))} ${t?.sym || 'tokens'}`; zeroed = '';
}
const LATER = { on: false, auto: false, pct: 25, rand: Math.random(), fee: null, feeAt: 0, err: null, offers: {}, via: null, tp: {}, ethLeaves: null, dgas: null, dgasTok: null, boxFee: null, boxFeeAt: 0, boxFeeTry: 0, p2: {}, step: {}, depStep: '' };
const PLANS_KEY = 'tacit-swap-later-v1';
const plans = () => { try { return (JSON.parse(localStorage.getItem(PLANS_KEY) || '[]') || []).filter((p) => p?.id); } catch { return []; } };
let LTP = null, LT = null;
const pageSigner = { pin: null, get address() { return pageSigner.pin || W.account; }, ready: async () => { if (!W.account) await H.connect(); await wallet.ensureMainnet(); },
  send: ({ to, data, value }) => { if (pageSigner.pin && lc(W.account || '') !== lc(pageSigner.pin)) throw new Error('The wallet switched account since you pressed. Nothing was sent.'); return wallet.sendTx({ to, data, value: BigInt(value || 0), from: pageSigner.pin || W.account, label: 'Swap privately' }); }, rpc: (m, p) => rpc(m, p),
  signTyped: (typed) => signTyped(typed, pageSigner.pin || W.account), receipt: (h) => wallet.receipt(h),
  canBatch: () => (wallet.canBatch ? wallet.canBatch() : false),
  get batch() { return wallet.sendCalls ? (calls, sent) => wallet.sendCalls(calls, { from: pageSigner.pin || W.account, sent, label: 'Swap privately' }) : null; } };
let proverAsked = 0;
function proverSoon(force = false) {
  const net = navigator.connection;
  if (proverAsked || net?.saveData || /^(slow-)?2g$/.test(net?.effectiveType || '') || !(force || exiting() || laterOn(kindOf(S.pay, S.get)))) return;
  proverAsked = Date.now();
  ltLoad().then((lt) => lt.warm()).catch(() => { setTimeout(() => { proverAsked = 0; }, 60e3); });
}
let modsAsked = false;
function modsSoon() {
  if (modsAsked || !laterOn(kindOf(S.pay, S.get))) return;
  modsAsked = true;
  ltLoad().then((lt) => lt.modules()).catch(() => { modsAsked = false; });
}
let depAsked = '', depTimer = 0, depDeclined = false, depTouched = 0;
const depKeyed = () => !!(PV?.unlocked || H.key?.session?.unlocked);
const sheetOpen = () => !!document.querySelector('dialog[open], .bsheet, .bm-modal') || $('#pk')?.hidden === false;
function depositSoon(q) {
  const net = navigator.connection, hop = picked(q)?.hop ? tokHop()?.hop : null, dep = laterDeposit(q), k = `${hop?.pool || ''}:${dep}`;
  if (net?.saveData || /^(slow-)?2g$/.test(net?.effectiveType || '') || dep == null || k === depAsked || (depDeclined && !depKeyed()) || (!isEth(S.pay) && !hop && depPayer() !== 'eth')) return;
  depAsked = k;
  const ask = () => {
    if (!ROOT?.isConnected) { depAsked = ''; return; }
    if (document.hidden) { depAsked = ''; document.addEventListener('visibilitychange', () => { if (!document.hidden && S.q) paintQuote(); }, { once: true }); return; }
    const left = depTouched + 2000 - Date.now();
    if (left > 0) { depTimer = setTimeout(ask, left); return; }
    if (!depKeyed() && sheetOpen()) { depTimer = setTimeout(ask, 2000); return; }
    ltLoad().then((lt) => lt.ahead({ depositWei: dep, hop })).catch((e) => {
      if (e?.unlockCancelled) depDeclined = true;
      else setTimeout(() => { if (depAsked === k) depAsked = ''; }, 60e3);
    });
  };
  clearTimeout(depTimer);
  depTimer = setTimeout(ask, 0);
}
const ltLoad = () => (LTP ||= import('/swap/later.js?cb=0fa6b00a').then((m) => { LT = m.makeLater({ keyHex: async () => (await pvLoad()).keyHex(), signer: pageSigner, ethCall, venues, ux: getUx, sendPrivate: async (o) => (await pvLoad()).sendPrivate(o), now: () => (S.chainT ? (S.chainT + (now() - S.chainAt)) * 1000 : Date.now()) }); LT.mod = m; return LT; }).catch((e) => { LTP = null; throw e; }));
const laterPay = (k) => isEth(k) || k === lc(R.TAC) || (isListed(k) && !tacitKey(k) && k !== lc(R.WETH));
const laterPair = (kind, pay = S.pay, get = S.get) => laterPay(pay)
  && (isEth(pay) ? kind === 'agg' || (kind === 'tac' && get === lc(R.TAC)) : (kind === 'agg' && get !== lc(R.WETH)) || kind === 'any' || kind === 'out' || kind === 'tac');
const laterFits = (kind) => !S.inP && !S.outP && laterPair(kind);
const laterOn = (kind) => LATER.on && laterFits(kind);
const HOP_KEY = 'tacit-swap-hop';
const hopPref = () => { try { return localStorage.getItem(HOP_KEY); } catch { return null; } };
const hopSave = (v) => { S.hopPublic = v === 'public'; LATER.auto = false; try { localStorage.setItem(HOP_KEY, v); } catch { } };
function hopDefault() {
  if (LATER.on && LATER.auto && !S.busy && !isEth(S.pay)) { LATER.on = false; LATER.auto = false; return true; }
  if (LATER.on || S.hopPublic || hopPref() === 'public' || S.busy || !isEth(S.pay) || S.inP || S.outP || placed() || inPool(S.get) || outRoute(S.get) !== 'later') return false;
  LATER.on = true; LATER.auto = true; laterUp();
  if (S.amt) S.amt = fitAmt(S.amt);
  return true;
}
function hopSet(on) {
  LATER.on = on; hopSave(on ? 'private' : 'public');
  if (on && S.amt) S.amt = fitAmt(S.amt);
  if (on) laterUp(); else clearTo();
  changed(); paint();
  if (S.q && ['agg', 'tac'].includes(kindOf(S.pay, S.get))) requote(true);
}
const laterPool = () => LATER.on && S.get === lc(R.TAC) && laterFits(kindOf(S.pay, S.get)) && !(!isEth(S.pay) && viaToken());
const laterDest = () => (!laterPool() || S.to ? { kind: 'address' } : S.toTacit ? { kind: 'tacit', pubHex: S.toTacit.pubHex, name: S.toTacit.name || null } : { kind: 'me' });
const laterGas = () => { if (laterDest().kind === 'address') return 0n; const g = S.gasPrice ? 350_000n * BigInt(S.gasPrice) * 2n : 15n * 10n ** 14n; return g < 5n * 10n ** 14n ? 5n * 10n ** 14n : g > 3n * 10n ** 15n ? 3n * 10n ** 15n : g; };
const laterSwapWei = (q) => (isEth(S.pay) || picked(q)?.hop ? (tacSwap() && q?.wei ? alignTac(q.wei) : q?.wei) : picked(q)?.via?.ethWei);
const laterFee = (q) => (picked(q)?.hop ? tokHop()?.fee ?? null : LATER.fee);
const laterAmounts = (q) => (laterSwapWei(q) && laterFee(q) != null && LT ? LT.mod.depositFor({ swapWei: laterSwapWei(q), feeWei: laterFee(q), pct: LATER.pct, rand: () => LATER.rand, gasWei: picked(q)?.hop ? 0n : laterGas() }) : null);
const laterExtra = (q) => laterAmounts(q)?.extraWei ?? 0n;
const laterDeposit = (q) => laterAmounts(q)?.depositWei ?? null;
const laterIn = (q) => {
  if (picked(q)?.hop) return laterDeposit(q);
  const v = picked(q)?.via, dep = laterDeposit(q);
  if (v && dep != null && depPayer() !== 'eth') {
    if (LATER.boxFee == null || v.r0.out <= 0n) return null;
    const keep = 10000n - (LT?.mod?.BOXED_MARGIN_BPS ?? 40n), want = ((dep + LATER.boxFee) * 10000n + keep - 1n) / keep;
    return (q.wei * want * 10005n + v.r0.out * 10000n - 1n) / (v.r0.out * 10000n);
  }
  return v && dep != null && v.r0.min > 0n ? (q.wei * dep * 10020n + v.r0.min * 10000n - 1n) / (v.r0.min * 10000n) : null;
};
const tokHop = () => (!isEth(S.pay) && LATER.tp[S.pay]) || null;
const hopOpen = (t = tokHop()) => !!(t?.hop?.state?.pool && t?.hop?.state?.router);
const viaToken = () => LATER.via !== 'eth' && hopOpen() && tokHop().fee != null && depPayer() === 'eth';
const tokenWei = (k, wei) => { const t = tokenOf(k), u = usdOf(lc(R.ZERO), wei), one = t ? usdOf(k, 10n ** BigInt(t.dec)) : null; return u != null && one ? BigInt(Math.ceil((u / one) * 10 ** t.dec)) : null; };
const relayTok = (k) => !!(GR_LIVE && W.account && !isEth(k) && (GR.PERMIT_TOKENS[lc(k)] || LATER.p2[lc(k)] === true) && tokenWei(k, 10n ** 15n) != null);
const depWei = () => (S.gasPrice ? (isEth(S.pay) ? GR.GAS_UNITS : GAS.zap) * S.gasPrice : null);
const relayWei = () => (S.gasPrice ? (GR.GAS_UNITS * S.gasPrice * 15n) / 10n : null);
function depWays() {
  if (!LATER.on || isEth(S.pay) || !relayTok(S.pay) || (S.get === lc(R.TAC) && !S.to)) return { token: false, tac: false };
  const tac = lc(R.TAC), held = S.bal[tac], need = relayWei() != null ? tokenWei(tac, relayWei()) : null;
  return { token: true, tac: lc(S.pay) !== tac && !!GR.PERMIT_TOKENS[lc(S.pay)] && held != null && need != null && held >= (need * 12n) / 10n };
}
function depGasLine() {
  const money = (u) => (u == null ? '' : `about ${u < 1 ? `$${u.toFixed(2)}` : usd(u)}`), payer = depPayer(), sym = tokenOf(S.pay)?.sym;
  if (payer === 'eth') {
    const w = depWei(), u = w != null ? usdOf(lc(R.ZERO), w) : null;
    return ['Deposit gas', w != null ? `${eth2(w)} ETH${u != null ? ` · ${money(u)}` : ''}` : 'ETH, from your wallet', '', 'Your wallet sends the deposit itself, so its gas is ETH from the wallet. Everything after the deposit is sent by the relay and costs you no gas.'];
  }
  const w = relayWei(), bf = LATER.boxFee, u = w != null && bf != null ? usdOf(lc(R.ZERO), w + bf) : null, unit = payer === 'tac' ? `TAC and ${esc(sym)}` : esc(sym);
  return ['Deposit gas', `${u != null ? `${money(u)} in ${unit}` : `paid in ${unit}`}, no ETH needed`, 'ok', `No ETH leaves your wallet: the relay sends the swap that makes the deposit and is paid in ${payer === 'tac' ? 'TAC' : esc(sym)}, and the pool’s keeper completes the deposit for a fee out of the ${esc(sym)} sold. Your wallet signs and sends nothing, and nothing leaves it unless the swap lands.`];
}
function depPayer() {
  if (isEth(S.pay) || !LATER.on) return 'eth';
  const w = depWays(), eth = S.bal[lc(R.ZERO)], pick = LATER.dgasTok === S.pay ? LATER.dgas : null;
  if ((pick === 'eth' && !(eth != null && 2n * gasKeep() > eth)) || (pick === 'token' && w.token) || (pick === 'tac' && w.tac)) return pick;
  if (eth == null || 2n * gasKeep() <= eth) return 'eth';
  return w.tac ? 'tac' : w.token ? 'token' : 'eth';
}
const viaShown = (th = tokHop()) => !!th?.hop;
const NEXT_INDEX = '0xfc7e9c6f';
function readBoxFee(force = false) {
  if (!force && ((LATER.boxFee != null && Date.now() - LATER.boxFeeAt < 120e3) || Date.now() - LATER.boxFeeTry < 15e3)) return Promise.resolve();
  LATER.boxFeeTry = Date.now();
  return ltLoad().then((m) => m.mod.depositFee().then((f) => { LATER.boxFee = m.mod.boxFeeOf(f); LATER.boxFeeAt = Date.now(); paintQuote(); })).catch(() => {});
}
function readP2(token) {
  const k = lc(token);
  if (!W.account || GR.PERMIT_TOKENS[k] || LATER.p2[k] !== undefined) return;
  LATER.p2[k] = null;
  ethCall(token, '0xdd62ed3e' + addrWord(W.account) + addrWord(GR.PERMIT2)).then((h) => { LATER.p2[k] = wordAt(h, 0) >= (S.bal[k] || 1n); paintQuote(); }, () => { LATER.p2[k] = false; setTimeout(() => { if (LATER.p2[k] === false) delete LATER.p2[k]; }, 30e3); });
}
function readHop(token = S.pay, force = false) {
  if (isEth(token) || !LATER.on) return;
  readBoxFee(); readP2(token);
  const t = LATER.tp[token];
  if (!force && t && (t.busy || Date.now() - (t.tried || 0) < 60e3)) return;
  LATER.tp[token] = { ...(t || {}), busy: true };
  if (LATER.ethLeaves == null) ethCall(LT_POOL, NEXT_INDEX).then((h) => { LATER.ethLeaves = Number(BigInt(h)); paintQuote(); }, () => {});
  ltLoad().then(async (lt) => {
    const hop = await lt.hopOf(token), open = hopOpen({ hop });
    const [leaves, fee] = open ? await Promise.all([ethCall(hop.pool, NEXT_INDEX).then((h) => Number(BigInt(h)), () => null), lt.mod.relayFee(Number(lt.mod.HOP_GAS), undefined, hop.keeper, hop.pool).catch(() => null)]) : [0, null];
    LATER.tp[token] = { hop, leaves, fee, served: !!lt.mod.SERVED[token], told: t?.told, at: Date.now(), tried: Date.now(), busy: false };
    if (open && fee == null && !t?.told) { LATER.tp[token].told = true; lt.mod.notifyPool(token).catch(() => {}); }
    if (token === S.pay) paint();
  }).catch(() => { LATER.tp[token] = { ...(LATER.tp[token] || {}), busy: false, tried: Date.now() }; });
}
async function openPoolGo() {
  const token = S.pay, t = tokenOf(token);
  if (S.busy || isEth(token)) return;
  if (!W.account) { await H.connect(); return; }
  S.busy = true; paintQuote();
  try {
    const lt = await ltLoad();
    const r = await lt.openPool(token, { onStep: (st) => say(esc(st === 'open the pool' ? `Confirm in your wallet: it opens the private ${t.sym} pool for everyone…` : laterStep(st))) });
    say(r ? `<span class="ok">The private ${esc(t.sym)} pool is open.</span> The relay serves it within minutes.` : `The private ${esc(t.sym)} pool is open already.`, 'ok', true);
    LATER.via = null; readHop(token, true);
  } catch (e) { say(e instanceof UserStopped || e?.userStopped ? 'Nothing was sent.' : esc(e?.message || String(e)), e instanceof UserStopped || e?.userStopped ? '' : 'err', true); }
  finally { S.busy = false; paint(); }
}
function laterUp() { S.toOpen = true; if (LATER.fee == null) readFee(); if (laterPool()) warmPrivate(); readHop(); }
function readFee() {
  LATER.err = null;
  return ltLoad().then((m) => m.mod.relayFee()).then((f) => { LATER.fee = f; LATER.feeAt = Date.now(); paintQuote(); }, (e) => { LATER.err = e?.message || String(e); paintQuote(); });
}
const amountWord = (amt, dec) => (/^\s*\d*[.,]\d+\s*$/.test(String(amt || '')) && String(amt).split(/[.,]/)[1].trim().length > dec ? `At most ${dec} decimals` : 'Enter an amount');
const eth2 = (wei) => { const n = Number(wei) / 1e18; return tidy(n >= 1 || !(n > 0) ? n.toFixed(2) : n.toFixed(Math.min(18, 1 - Math.floor(Math.log10(n))))); };
const LATER_TIP = 'Deposit now into a private pool and swap out later, so nothing onchain links your wallet to where the tokens go.';
function paintLater(q, r, kind) {
  const el = $('#later'), fits = laterFits(kind) && (!!r || !!q?.busy || (LATER.on && !!q?.lt));
  el.hidden = !fits;
  if (!fits) return;
  if (LATER.on) readHop();
  const th = tokHop(), viaRow = LATER.on && !isEth(S.pay) && viaShown(th), hopOn = viaToken(), dw = depWays(), gasRow = LATER.on && !isEth(S.pay) && (dw.token || dw.tac);
  const k = `${LATER.on}:${laterPool() && laterDest().kind !== 'address'}:${viaRow ? `${S.pay}:${hopOpen(th)}` : ''}:${gasRow ? `${S.pay}:${dw.tac}` : ''}`;
  if (el.dataset.k !== k) {
    el.dataset.k = k;
    el.classList.toggle('on', LATER.on);
    el.innerHTML = `<button type="button" class="tgl" id="later-on" role="switch" aria-checked="${LATER.on}" title="${esc(LATER_TIP)}"><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><span class="tg-t"><b>Swap privately</b><small>${LATER.on ? 'your wallet and the address are not linked' : 'hides where it goes'}</small></span><span class="pill" aria-hidden="true"></span></button>`
      + (LATER.on ? (viaRow ? viaHtml(th) : '') + (gasRow ? gasHtml(dw) : '')
        + `<div class="buf" title="Deposit more than you swap, so the deposit and the swap do not match. What is not swapped stays yours, private in the pool."><span>Blur the amount<small> · the extra stays yours</small></span><input type="range" id="later-x" min="5" max="100" step="5" value="${LATER.pct}" aria-label="How much more to deposit than you swap, so the two do not match; the extra stays yours, private"><b id="later-xv"></b></div>`
        + `<ol class="st pre" aria-label="How it goes"><li><i class="mk" aria-hidden="true">1</i><span>Deposit <b id="later-dep"></b></span></li><li><i class="mk" aria-hidden="true">2</i><span>Wait</span></li><li><i class="mk" aria-hidden="true">3</i><span>Swap</span></li>${laterPool() && laterDest().kind !== 'address' ? '<li><i class="mk" aria-hidden="true">4</i><span>Private</span></li>' : ''}</ol><p class="later-note" id="later-note"></p>` : '');
  }
  if (!LATER.on) return;
  if (viaRow) viaPaint(th, hopOn);
  if (gasRow) gasPaint(dw);
  const shape = laterOn(kind) && !isEth(S.pay) ? (hopOn ? 'hop' : 'zap') : false;
  el.classList.toggle('stale', !!q?.busy || !!(q && (q.lt || false) !== shape));
  const dep = laterDeposit(q), pay = tokenOf(S.pay), hopQ = !!picked(q)?.hop, tin = isEth(S.pay) ? null : laterIn(q);
  const inTok = (v) => `${tidy(amtFmt(v, pay.dec))} ${pay.sym}`;
  $('#later-xv').textContent = hopQ ? `+${inTok(laterExtra(q))}` : tin != null && dep ? `+${inTok((laterExtra(q) * tin) / dep)}` : `+${eth2(laterExtra(q))} ETH`;
  $('#later-dep').textContent = dep == null ? (LATER.err ? '(fee unavailable)' : '…') : isEth(S.pay) ? `${eth2(dep)} ETH` : tin != null ? inTok(tin) : '…';
  $('#later-dep').title = dep == null ? '' : hopQ
    ? `${inTok(dep)} into the private ${pay.sym} pool as it is: the swap (${inTok(laterSwapWei(q))}), the relay’s fee for the swap out set aside twice (${inTok(2n * laterFee(q))}) and the buffer (${inTok(laterExtra(q))}), rounded up. What is not swapped stays private in that pool.`
    : `${tin != null ? (depPayer() !== 'eth' ? `${inTok(tin)} sold by the relay for ${eth2(dep + (LATER.boxFee ?? 0n))} ETH, the deposit and the keeper’s fee for completing it: ` : `${inTok(tin)} sold for ${eth2(dep)} ETH in the same transaction: `) : ''}The swap (${eth2(laterSwapWei(q))} ETH), the relay’s fee for the swap out set aside twice (${eth2(2n * LATER.fee)} ETH) and the buffer (${eth2(laterExtra(q))} ETH), rounded up. What is not swapped stays in your private balance.`;
  $('#later-note').textContent = dep != null && isEth(S.pay) ? `${eth2(laterSwapWei(q))} ETH is swapped; the rest stays yours, private.` : hopQ && dep != null ? `${inTok(laterSwapWei(q))} is swapped; the rest stays yours, private.` : '';
}
function viaHtml(th) {
  const sym = esc(tokenOf(S.pay).sym);
  if (!hopOpen(th)) return `<div class="via"><span>No private ${sym} pool yet</span><button type="button" class="link" data-open-pool title="One transaction from your wallet (about 4.4M gas) opens a private ${sym} pool for everyone, served by the relay${th.served ? '' : ' on a daily allowance of gas'}. Its first deposits have little company; until it is open, the swap goes through the ETH pool.">Open one</button></div>`;
  return `<div class="via" role="group" aria-label="Pool"><span>Pool</span><button type="button" class="vp" data-via="token"></button><button type="button" class="vp" data-via="eth"></button></div>`;
}
function gasHtml(w) {
  const sym = esc(tokenOf(S.pay).sym);
  return `<div class="via" role="group" aria-label="Deposit gas"><span title="Who pays the network fee of the deposit. Your wallet sends it with ETH, or the relay sends it and is paid in the token or TAC, so no ETH is needed.">Deposit gas</span><button type="button" class="vp" data-dg="eth">ETH</button>${w.token ? `<button type="button" class="vp" data-dg="token">${sym}</button>` : ''}${w.tac ? '<button type="button" class="vp" data-dg="tac">TAC</button>' : ''}</div>`;
}
function gasPaint(w) {
  const p = depPayer(), eth = S.bal[lc(R.ZERO)], short = eth != null && 2n * gasKeep() > eth, sym = tokenOf(S.pay).sym;
  const cost = (wei) => { const u = wei != null ? usdOf(lc(R.ZERO), wei) : null; return u == null ? '' : u < 1 ? `$${u.toFixed(2)}` : usd(u); };
  const relay = relayWei() != null && LATER.boxFee != null ? cost(relayWei() + LATER.boxFee) : '';
  const set = (key, text, tip, on, off = false) => { const b = $(`#later [data-dg="${key}"]`); if (!b) return; b.textContent = text; b.title = tip; b.setAttribute('aria-pressed', String(on)); b.disabled = off; };
  set('eth', `ETH${cost(depWei()) ? ` · ${cost(depWei())}` : ''}`, short ? 'This wallet holds too little ETH for the deposit’s gas.' : 'Your wallet sends the deposit with its own ETH. The cheapest way.', p === 'eth', short);
  set('token', `${sym}${relay ? ` · ${relay}` : ''}`, `The relay sends the deposit and is paid in ${sym}, so no ETH is needed. It costs more than sending it yourself: two transactions are paid for.`, p === 'token');
  set('tac', `TAC${relay ? ` · ${relay}` : ''}`, 'The relay sends the deposit and is paid in TAC, so no ETH is needed. It costs more than sending it yourself: two transactions are paid for.', p === 'tac');
}
function viaPaint(th, hopOn) {
  const sym = tokenOf(S.pay).sym, n = (x) => (x == null ? '' : ` · ${x.toLocaleString('en-US')}`), notes = (x, of) => (x == null ? `The private ${of} pool` : `${x.toLocaleString('en-US')} notes in the private ${of} pool`);
  const t = $('#later [data-via="token"]'), e = $('#later [data-via="eth"]');
  const relayed = depPayer() !== 'eth';
  if (t) { t.textContent = `${sym}${n(th.leaves)}`; t.title = relayed ? `With the deposit’s gas paid in a token the swap goes through the ETH pool. Pay it in ETH to use the ${sym} pool.` : th.fee == null ? `${notes(th.leaves, sym)}. The relay is picking it up.` : notes(th.leaves, sym); t.disabled = th.fee == null || relayed; t.setAttribute('aria-pressed', String(hopOn)); }
  if (e) { e.textContent = `ETH${n(LATER.ethLeaves)}`; e.title = notes(LATER.ethLeaves, 'ETH'); e.setAttribute('aria-pressed', String(!hopOn)); }
}
const laterStep = (s) => ({ 'proving on this device': `Proving on this device${LT?.proveMs ? `, about ${Math.max(5, Math.round(LT.proveMs / 1000))} s` : ''}…`, 'confirm in your wallet': 'Confirm the deposit in your wallet…', 'waiting for it to be mined': 'Waiting for it to land…',
  'sending through the relayer': 'The relay is sending it…', 'reading the price again': 'Reading the price again…', 'waiting for the TAC': 'Swapped. Waiting for the TAC to reach this key’s address…',
  'making it private': 'Making it private, from this key’s address…', 'sending it on': 'Private. Sending it on…',
  'sign the permit': 'Sign the permit in your wallet. The signature costs nothing…', 'approve': 'Approve exactly the deposit’s amount in your wallet, once…', 'reset the allowance': 'Your USDT allowance is reset to zero first (USDT asks for this)…' }[s] || `${s.charAt(0).toUpperCase()}${s.slice(1)}…`);
async function laterGo() {
  const q = S.q, to = S.to, get = tokenOf(S.get), dest = laterDest(), slip = S.slip;
  if (!q || (!to && dest.kind === 'address') || laterDeposit(q) == null || S.busy) return;
  if (!isEth(S.pay) && !picked(q)?.hop && now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  if (picked(q)?.hop ? Date.now() - (tokHop()?.at || 0) > 120e3 : Date.now() - LATER.feeAt > 120e3) {
    const was = laterDeposit(q);
    S.busy = true;
    try { if (picked(q)?.hop) { readHop(S.pay, true); for (let i = 0; i < 40 && tokHop()?.busy; i++) await new Promise((r) => setTimeout(r, 250)); } else await readFee(); } finally { S.busy = false; }
    if (picked(q)?.hop && (Date.now() - (tokHop()?.at || 0) > 120e3 || tokHop()?.fee == null)) { say('The relay could not quote its fee right now. Try again in a moment.', 'err', true); paint(); return; }
    if (!picked(q)?.hop && Date.now() - LATER.feeAt > 120e3) { say('The relay could not quote its fee right now. Try again in a moment.', 'err', true); paint(); return; }
    if (laterDeposit(q) !== was) { say('The relay’s fee moved, so the deposit is shown again. Check it and press once more.', '', true); paint(); return; }
  }
  const payer = !isEth(S.pay) && !picked(q)?.hop ? depPayer() : 'eth';
  if (payer !== 'eth' && Date.now() - LATER.boxFeeAt > 120e3) {
    const was = laterIn(q);
    S.busy = true;
    try { await readBoxFee(true); } finally { S.busy = false; }
    if (LATER.boxFee == null || Date.now() - LATER.boxFeeAt > 120e3) { say('The relay could not quote its fee right now. Try again in a moment.', 'err', true); paint(); return; }
    if (laterIn(q) !== was) { say('The relay’s fee moved, so the deposit is shown again. Check it and press once more.', '', true); paint(); return; }
  }
  const dep = laterDeposit(q), extra = laterExtra(q), hopQ = !!picked(q)?.hop, v = isEth(S.pay) || hopQ ? null : picked(q)?.via, tin = v ? laterIn(q) : null, pt = tokenOf(S.pay);
  if (!isEth(S.pay) && !hopQ && tin == null) return;
  const hop = hopQ ? tokHop()?.hop : null;
  if (hopQ && !hopOpen(tokHop())) { say('The private pool is not open yet.', 'err', true); return; }
  const pay = v ? { token: S.pay, sym: pt.sym, dec: pt.dec, amountIn: q.wei, min: v.r0.min, most: (tin * BigInt(10000 + slip)) / 10000n, slippageBps: slip } : null;
  clearTimeout(depTimer);
  S.busy = true; S.note = ''; pageSigner.pin = W.account || null; paintQuote();
  let moved = false, popped = false;
  const earned = laterPts(q, picked(q));
  try {
    const lt = await ltLoad(), toName = to && S.toName?.addr === lc(to) ? S.toName.name : null, onStep = (s) => { LATER.depStep = laterStep(s); say(esc(laterStep(s))); paintSteps(); };
    if (payer !== 'eth') await relayStart(lt, { q, to, toName, get, dep, extra, v, tin, pt, payer, slip, onStep });
    else await lt.start({ swapWei: laterSwapWei(q), extraWei: extra, token: S.get, sym: get.sym, dec: get.dec, to, toName, depositWei: dep,
      dest: hop ? { kind: 'address' } : dest, gasWei: hop ? 0n : laterGas(), pay: hop ? { token: S.pay, sym: pt.sym, dec: pt.dec } : pay, hop, onStep });
    popped = true; reward(earned);
    LATER.rand = Math.random();
    LATER.on = false; S.amt = ''; S.q = null; S.seq++; S.to = null; S.toTacit = null; S.toTacitBad = ''; S.toOpen = false; $('#to-in').value = '';
    say('<span class="ok">Deposited.</span> The swap waits below.', 'ok', true);
  } catch (e) {
    moved = !!e?.moved;
    const stopped = e instanceof UserStopped || e?.userStopped || e?.unlockCancelled;
    const unsure = !stopped && plans().some((x) => x.state === 'unsure' && Date.now() - x.at < 10 * 60e3);
    say(stopped ? (e?.zeroed ? `Your ${esc(e.zeroed)} allowance was set to zero; nothing else was sent.` : 'Nothing was sent.') : `${esc(e?.message || String(e))}${unsure ? ' It may have been sent: check the steps below before depositing again.' : ''}`, stopped ? '' : 'err', true);
  }
  finally { S.busy = false; pageSigner.pin = null; LATER.depStep = ''; depAsked = ''; changed(); paint(); paintSteps(); H.onDone?.(); readBalances().then(paintSides, () => {}); }
  if (moved) requote(true);
}
async function relayStart(lt, { q, to, toName, get, dep, extra, v, tin, pt, payer, slip, onStep }) {
  const from = W.account;
  LATER.depStep = 'No ETH needed: reading the price and the fee…'; say(LATER.depStep); paintSteps();
  const fees = await priceRelayFee({ payer, tin, pt });
  return lt.startBoxed({ swapWei: laterSwapWei(q), extraWei: extra, token: S.get, sym: get.sym, dec: get.dec, to, toName, depositWei: dep,
    pay: { token: S.pay, sym: pt.sym, dec: pt.dec, amountIn: tin, typed: q.wei, route: v.r0.name }, onStep, fund: (box) => relayFund(lt, box, { from, q, v, tin, pt, fees, slip }) });
}
async function priceRelayFee({ payer, tin, pt }) {
  const tac = lc(R.TAC), nothing = (m) => Object.assign(new Error(m), { nothingSpent: true });
  const gasPrice = BigInt(await rpc('eth_gasPrice', []));
  const price = (k) => GR.feeFor({ gasPriceWei: gasPrice, ethToToken: (w) => kyberEthTo(k, w) });
  let feeToken = payer === 'tac' ? R.TAC : S.pay, fee = await price(feeToken);
  if (fee == null && payer === 'tac') { feeToken = S.pay; fee = await price(feeToken); }
  if (fee == null) throw nothing('Could not price the network fee. Nothing was sent.');
  const isTac = lc(feeToken) === tac, fu = usdOf(lc(feeToken), fee), su = usdOf(lc(S.pay), tin), feeTxt = `${tidy(amtFmt(fee, isTac ? 18 : pt.dec))} ${isTac ? 'TAC' : esc(pt.sym)}`;
  if ((fu != null && fu > 25) || (fu != null && su != null && fu * 4 > su)) throw nothing(`The network fee is too high for this swap right now (${feeTxt}). Swap more, add a little ETH, or try when gas is lower. Nothing was sent.`);
  return { feeToken, fee, feeTxt };
}
async function relayFund(lt, box, ctx) {
  const posted = { at: false };
  try { return await relayFundRun(lt, box, ctx, posted); }
  catch (e) { if (e && !posted.at && !e.nothingSpent) e.nothingSpent = true; throw e; }
}
async function relayFundRun(lt, { box, amount }, { from, q, v, tin, pt, fees, slip }, posted) {
  const relay = GR.GAS_RELAY[1], tac = lc(R.TAC), { feeToken, fee, feeTxt } = fees, ft = tokenOf(lc(feeToken));
  const nothing = (m, more = {}) => Object.assign(new Error(m), { nothingSpent: true, ...more });
  const note = (h) => { LATER.depStep = h.replace(/<[^>]+>/g, ''); say(h); paintSteps(); };
  const dl = chainDeadline(1200), stand = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('');
  const tacRoute = async (a, who) => {
    const rt = (await venues.route({ dir: 'TAC_TO_ETH', amountIn: a, account: relay }))?.r?.precision;
    if (!rt || BigInt(rt.amountIn) !== a) return null;
    const out = BigInt(rt.amountOut), min = (out * BigInt(10000 - slip)) / 10000n;
    if (min <= 0n) return null;
    const tx = venues.build({ quote: rt, dir: 'TAC_TO_ETH', account: relay, to: who, minOut: min, deadline: dl });
    if (lc(tx.to) !== lc(R.ZROUTER) || BigInt(tx.value || 0) !== 0n || (tx.approval && lc(tx.approval.spender) !== lc(tx.to)) || !lc(tx.data).includes(addrWord(who))) return null;
    return { out, min, callData: tx.data, name: 'Precision pool' };
  };
  const route = (a, who) => (lc(S.pay) === tac ? tacRoute(a, who) : A.bestRoute({ ethCall, to: who, refundTo: relay, tokenIn: S.pay, tokenOut: R.ZERO, amountIn: a, slippageBps: slip, deadline: dl }));
  note('Reading the price again…');
  const sized = await within(lt.mod.sizeBoxed({ route: (a) => route(a, stand), amountIn: q.wei, out: v.r0.out, needWei: amount }), 25e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
  if (!sized) throw nothing(`No onchain route sells ${pt.sym} for the deposit right now. Nothing was sent.`);
  if (sized.amountIn > (tin * BigInt(10000 + slip)) / 10000n) throw nothing(`The price moved: the deposit takes more ${pt.sym} than was shown. Nothing was sent; check it and press again.`, { moved: true });
  const rb = await within(route(sized.amountIn, box), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
  if (!rb || rb.out < amount) throw nothing('The price moved while the deposit box was made. Nothing was sent; press again.', { moved: true });
  const held = await balanceNow(S.pay, from), total = lc(feeToken) === lc(S.pay) ? sized.amountIn + fee : sized.amountIn;
  if (held < total) throw nothing(`Not enough ${esc(pt.sym)}: the deposit and the network fee need ${tidy(amtFmt(total, pt.dec))}. Nothing was sent.`);
  if (lc(feeToken) !== lc(S.pay) && (await balanceNow(feeToken, from)) < fee) throw nothing(`Not enough ${esc(ft.sym)} for the network fee. Nothing was sent.`);
  const { order, data } = GR.buildOrder({ payer: from, tokenIn: S.pay, amountIn: sized.amountIn, feeToken, fee, tokenOut: R.ZERO, minOut: amount, recipient: box, target: R.ZROUTER, data: rb.callData, ttlSecs: 240, now: Number(chainDeadline(0)) - 60 });
  note(`Sign the deposit in your wallet. ${feeTxt} pays the network fee: no ETH is needed.`);
  posted.at = true;
  const hash = await GR.placeOrder({ order, data, from, symbol: esc(pt.sym), sign: { typed: (td) => signTyped(td, from) }, rpc, step: (t) => note(`${esc(t)}…`), api: API, now: () => Number(chainDeadline(0)) - 60,
    guard: () => { if (lc(W.account || '') !== lc(from)) throw nothing('The wallet’s account changed, so nothing was sent.'); } });
  return { hash, amountIn: sized.amountIn, route: rb.name };
}
const BLEND = {};
const ago_ = (t, to = Date.now()) => { const m = Math.max(0, Math.floor((to - t) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const stepLi = (state, n, title, detail = '', action = '') => `<li class="${state}"${state === 'now' ? ' aria-current="step"' : ''}><i class="mk" aria-hidden="true">${state === 'done' ? '✓' : state === 'fail' ? '!' : state === 'now' ? '' : n}</i><div class="t"><span>${title}</span>${detail ? `<small>${detail}</small>` : ''}</div>${action ? `<div class="a">${action}</div>` : ''}</li>`;
let STEPS_HTML = null;
function paintSteps() {
  const all = plans().filter((p) => p.state !== 'done' || Date.now() - (p.doneAt || 0) < 864e5);
  let room = Math.max(0, 6 - all.filter((p) => p.state !== 'done').length);
  const el = $('#steps'), ps = all.filter((p) => p.state !== 'done' || room-- > 0), into = intoRows();
  el.hidden = !ps.length && !into;
  for (const p of ps) if (p.state === 'done' && !p.got && p.swapTx && !GOT.has(p.id)) { GOT.add(p.id); learnGot(p.id).catch(() => {}); }
  const bw = ps.find(boxOpen);
  if (bw && !BOXW.t && !S.busy && depKeyed()) BOXW.t = setTimeout(boxWatch, Date.now() - bw.at < 60e3 ? 12e3 : 30e3);
  for (const p of ps) if (p.state === 'stopped' && p.boxed && p.box && p.boxIntent && !p.reclaimedAt && !BOXES[p.id]?.busy && Date.now() - (BOXES[p.id]?.at || 0) > 60e3) readBox(p);
  const html = ps.map((p) => {
    const b = BLEND[p.id], o = LATER.offers[p.id], id = esc(p.id), hd = p.hop ? Number(p.hop.dec) : 18, unit = p.hop ? p.hop.sym : 'ETH', amt = tidy(amtFmt(BigInt(p.swapWei), hd));
    const link = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer" aria-label="Transaction ${esc(h.slice(0, 10))}">${esc(h.slice(0, 8))}…↗</a>`;
    const pool = !!p.dest && p.dest.kind !== 'address', shielding = p.state === 'shielding', held = p.state === 'held';
    const deposited = !!p.depositedAt, done = p.state === 'done', swapping = p.state === 'swapping', stopped = p.state === 'stopped', waiting = p.state === 'waiting', swapped = done || shielding || held;
    const depDoubt = !deposited && !stopped && (p.state === 'unsure' || Date.now() - p.at > (p.boxed ? 20 : 3) * 60e3);
    const swapDoubt = deposited && !done && (p.state === 'unsure' || (swapping && Date.now() - (p.swapAt || p.at) > 10 * 60e3));
    const marks = b ? Math.min(5, Math.ceil(b.since / 2)) : 0;
    const meter = b ? ` <span class="mix" role="img" aria-label="Mixed with ${Math.ceil(b.since / 2)} other transactions since yours">${[0, 1, 2, 3, 4].map((i) => `<i${i < marks ? ' class="on"' : ''}></i>`).join('')}</span>` : '';
    const left = p.swapAt || p.doneAt, inFor = left ? ago_(p.depositedAt || p.at, left) : ago_(p.depositedAt || p.at);
    const mix = b ? `${b.since ? `mixed with ${b.since} since yours` : 'nothing new in the pool yet'} · ${inFor}${meter}` : p.mixed != null ? `${p.mixed ? `mixed with ${p.mixed} since yours` : 'nothing new in the pool yet'} · ${inFor}` : left ? inFor : `${inFor} so far`;
    const check = `<button type="button" class="btn sm ghost" data-later-check="${id}">Check it</button>`;
    const s1 = p.held ? stepLi('done', 1, 'In the pool', `${amt} ${esc(unit)}${b ? ` · ${b.since ? `mixed with ${b.since} since your latest deposit` : 'nothing deposited since your latest yet'}${meter}` : ', yours and hidden'}`, 'held privately')
      : stopped ? stepLi('fail', 1, 'Deposit', 'did not go through') : depDoubt ? stepLi('fail', 1, 'Deposit', 'not confirmed', check)
      : deposited ? stepLi('done', 1, 'Deposit', p.pay ? `${tidy(amtFmt(BigInt(p.pay.amountWei), Number(p.pay.dec)))} ${esc(p.pay.sym)} in` : '', p.depositTx ? link(p.depositTx) : 'in the pool')
        : stepLi('now', 1, 'Deposit', LATER.depStep && p.id === ps[0]?.id ? esc(LATER.depStep) : p.boxed ? (p.depositTx || p.soldAt ? 'the pool’s keeper is making it private…' : p.box ? 'the relay is sending it…' : 'opening your deposit box…') : 'sending…');
    const s2 = p.held ? '' : !deposited ? stepLi('todo', 2, 'Hidden in the pool') : swapped || swapping || swapDoubt || (waiting && o) ? stepLi('done', 2, 'Hidden in the pool', mix) : stepLi('now', 2, 'Hidden in the pool', mix);
    const got = p.got ? `${tidy(amtFmt(BigInt(p.got), Number(p.dec)))} ${esc(p.sym)} received` : p.min ? `${tidy(amtFmt(BigInt(p.min), Number(p.dec)))} ${esc(p.sym)} or more` : '';
    const n3 = p.held ? 2 : 3, out3 = p.hop ? lc(p.token) === lc(p.hop.token) : p.token === lc(R.ZERO), tt = out3 ? 'Pay out' : 'Swap out';
    const s3 = swapped ? stepLi('done', n3, tt, got, p.swapTx ? link(p.swapTx) : 'done') : swapDoubt ? stepLi('fail', n3, tt, 'not confirmed', check)
      : swapping ? stepLi('now', n3, tt, esc(LATER.step[p.id] || 'sending…')) : waiting && o ? stepLi('now', n3, tt, 'confirm the price')
      : waiting ? stepLi('todo', n3, tt) : stepLi('todo', n3, tt);
    const s4 = !pool ? '' : done ? stepLi('done', 4, 'Private', p.sendTx ? `sent to ${esc(p.dest.name || 'the Tacit address')}` : '', (p.sendTx || p.shieldTx) ? link(p.sendTx || p.shieldTx) : 'done')
      : held ? stepLi('fail', 4, 'Private', p.shieldTx ? 'private; not sent on' : 'not yet', `<button type="button" class="btn sm" data-later-shield="${id}">${p.shieldTx ? 'Send it on' : 'Make private'}</button>`)
      : shielding ? stepLi(S.busy ? 'now' : 'todo', 4, 'Private', S.busy ? 'making it private…' : 'the TAC is in this key’s address', S.busy ? '' : `<button type="button" class="btn sm" data-later-shield="${id}">Make private</button>`)
      : stepLi('todo', 4, 'Private');
    const dec = Number(p.dec), self = o?.via === 'self';
    const offer = waiting && o ? `<div class="offer"><div><small>You get at least</small><b>${esc(tidy(amtFmt(o.min, dec)))} ${esc(p.sym)}</b>${o.ks ? `<small>KyberSwap ${esc(tidy(amtFmt(o.ks, dec)))}</small>` : ''}</div>`
      + `<div class="acts"><button type="button" class="btn" data-later-ok="${id}" data-via="${self ? 'self' : 'relay'}">${self ? 'Confirm from this wallet' : 'Confirm swap'}</button><button type="button" class="btn ghost" data-later-no="${id}">Not now</button></div></div>` : '';
    const cta = waiting && !o ? `<div class="cta"><button type="button" class="btn" data-later-go="${id}">${out3 ? 'Pay out now' : 'Swap now'}</button><small>${p.held ? 'You see the price and confirm it before anything is sent.' : b?.since ? `Mixed with ${Math.ceil(b.since / 2)} other transaction${b.since > 2 ? 's' : ''} in the pool since yours. Swap now, or wait for more. You confirm the price first.` : 'The longer it waits, the more deposits mix with it. You confirm the price before anything is sent.'}</small></div>` : '';
    const chip = stopped || depDoubt || swapDoubt ? ['Needs a look', 'err'] : done ? ['Done', 'ok'] : swapping ? ['Swapping', ''] : shielding ? ['Making private', ''] : !deposited ? ['Depositing', ''] : waiting && o ? ['Confirm price', ''] : waiting ? ['Ready', 'ok'] : null;
    const selfOk = p.refused && waiting && W.account && lc(W.account) !== p.from;
    const bx = BOXES[p.id], back = stopped && p.boxed && p.boxIntent && !p.reclaimedAt && bx?.wei > 0n && chainNow() > Number(p.boxIntent.deadline)
      ? `<div class="cta"><button type="button" class="btn" data-later-reclaim="${id}">Send ${esc(tidy(amtFmt(bx.wei, 18)))} ETH back</button><small>It goes to ${shortAddrH(String(p.boxIntent.refund))}, an address only your key controls, where the pool’s keeper turns it into private ETH. Your wallet pays the gas.</small></div>` : '';
    const note = p.err && !done ? `<p class="note ${stopped || depDoubt || swapDoubt ? 'err' : 'warn'}" role="status">${esc(p.err)}${selfOk ? ` <button type="button" class="link" data-later-self="${id}">Send it from this wallet</button>` : ''}</p>` : '';
    const x = done ? `<button type="button" class="x" data-later-forget="${id}" aria-label="Hide">×</button>` : stopped || held ? `<button type="button" class="x" data-later-forget="${id}"${stopped && p.boxed && p.boxIntent && !p.reclaimedAt ? ' data-ask="1"' : ''} aria-label="Remove">×</button>`
      : waiting ? `<button type="button" class="x" data-later-forget="${id}" data-ask="1" aria-label="Remove this swap">×</button>` : '';
    const where = p.into ? `into your private ${esc(p.sym)}` : !pool ? `to ${p.toName ? esc(p.toName) : shortAddrH(p.to)}` : p.dest.kind === 'tacit' ? `to ${esc(p.dest.name || `tacit1…${String(p.dest.pubHex).slice(-6)}`)}, privately` : 'to your private balance';
    const held_ = BigInt(p.depositWei || 0);
    const poolName = p.hop ? `the private ${esc(p.hop.sym)} pool` : 'the private ETH pool', seeIt = p.hop ? `/#device/${esc(String(p.hop.id).replace(/^1-/, ''))}` : '/pay/eth/';
    const now = stopped || depDoubt || swapDoubt ? '' : !deposited ? (p.boxed ? 'The relay is making your deposit: no ETH needed.' : `Depositing into ${poolName}.`)
      : waiting && p.held ? `${amt} ${esc(unit)} out of ${poolName}: confirm the price below.`
      : waiting ? `${tidy(amtFmt(held_, hd))} ${esc(unit)} is in ${poolName}, yours and hidden. Swap it out when you like.`
      : swapping ? 'Swapping it out of the pool.'
      : done ? `Done. The rest of the deposit stays private in the pool. <a href="${seeIt}">See it →</a>` : '';
    const head = p.pay?.typed ? `${tidy(amtFmt(BigInt(p.pay.typed), Number(p.pay.dec)))} ${esc(p.pay.sym)}` : `${esc(amt)} ${esc(unit)}`;
    return `<section class="plan" aria-label="Private swap of ${head} to ${esc(p.sym)}"><header><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><b>${head} → ${esc(p.sym)}</b><small>${where}</small>${chip ? `<em class="chip ${chip[1]}">${chip[0]}</em>` : ''}${x}</header>${now ? `<p class="now">${now}</p>` : ''}<ol class="st">${s1}${s2}${s3}${s4}</ol>${offer}${cta}${note}${back}</section>`;
  }).join('') + into;
  if (html !== STEPS_HTML || el.innerHTML === '') { el.innerHTML = html; STEPS_HTML = html; }
}
const INTOB = {};
const intoWorth = (x, v) => { try { return v > 0n && v * 1000n >= BigInt(x.intent.amount) * 25n; } catch { return v > 0n; } };
const intoBoxes = () => { try { return JSON.parse(localStorage.getItem(INTO_BOXES) || '[]').filter((x) => x && x.box && x.intent && x.router && !x.reclaimedAt && !x.empty && !x.small); } catch { return []; } };
function intoRows() {
  const due = intoBoxes().filter((x) => chainNow() > Number(x.intent.deadline));
  for (const x of due) { const k = lc(x.box), r = INTOB[k]; if (!r?.busy && Date.now() - (r?.at || 0) > 60e3) intoRead(x); }
  return due.filter((x) => intoWorth(x, INTOB[lc(x.box)]?.held)).map((x) => {
    const t = tokenOf(lc(x.token)) || { sym: 'tokens', dec: 18 }, v = INTOB[lc(x.box)].held, b = esc(x.box), sent = !!x.reclaimTx && Date.now() - (x.reclaimAt || 0) < 30 * 60e3;
    return `<section class="plan" aria-label="A deposit box to send back"><header><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><b>${esc(tidy(amtFmt(v, t.dec)))} ${esc(t.sym)} left in a deposit box</b><small>from a swap into your private ${esc(t.sym)}</small></header>`
      + `<div class="cta"><button type="button" class="btn" data-into-reclaim="${b}"${sent ? ' disabled' : ''}>${sent ? 'Being sent back…' : 'Send it back'}</button><small>It goes to ${shortAddrH(String(x.intent.refund))}, this key’s own address: only your key controls it.</small></div></section>`;
  }).join('');
}
function intoRead(x) {
  const k = lc(x.box), token = lc(x.token || R.ZERO);
  INTOB[k] = { ...INTOB[k], busy: true };
  (isEth(token) ? light('eth_getBalance', [x.box, 'latest']) : ethCall(token, '0x70a08231' + k.replace(/^0x/, '').padStart(64, '0')))
    .then((h) => {
      const held = BigInt(h); INTOB[k] = { held, at: Date.now() };
      if (!x.reclaimTx && held === 0n) keepIntoBox({ ...x, empty: Date.now() });
      else if (!x.reclaimTx && !intoWorth(x, held)) keepIntoBox({ ...x, small: String(held) });
    }, () => { INTOB[k] = { held: null, at: Date.now() }; })
    .then(paintSteps);
}
async function intoReclaim(box) {
  const rec = intoBoxes().find((x) => lc(x.box) === lc(box));
  if (!rec || S.busy) return;
  if (!W.account) { await H.connect(); return; }
  S.busy = true; pageSigner.pin = W.account || null; paintQuote(); say('Checking the deposit box…');
  const steps = { 'confirm in your wallet': 'Confirm sending it back in your wallet…', 'waiting for the block': 'Waiting for the block…' }, t = tokenOf(lc(rec.token)) || { sym: 'tokens', dec: 18 };
  try {
    const r = await (await ltLoad()).reclaimIntoBox(rec, { onStep: (s) => say(steps[s] || esc(s)), onSent: (h, held) => keepIntoBox({ ...rec, reclaimTx: h, reclaimAt: Date.now(), reclaimHeld: held }) });
    keepIntoBox({ ...rec, reclaimTx: r.hash, reclaimHeld: r.held, reclaimedAt: Date.now() });
    remember(r.hash, `${tidy(amtFmt(r.held, t.dec))} ${t.sym} sent back from a deposit box`);
    say(`<span class="ok">Sent back.</span> ${esc(tidy(amtFmt(r.held, t.dec)))} ${esc(t.sym)} went to ${shortAddrH(r.to)}, this key’s address. ${txLink(r.hash)}`, 'ok', true);
  } catch (e) { say(e instanceof UserStopped || e?.userStopped ? declinedWords(e, 'Nothing was sent.') : esc(e?.message || String(e)), e instanceof UserStopped || e?.userStopped ? '' : 'err', true); }
  finally { S.busy = false; pageSigner.pin = null; delete INTOB[lc(box)]; paint(); paintSteps(); H.onDone?.(); }
}
const BOXW = { t: 0 };
const BOXES = {};
function readBox(p) {
  const id = p.id;
  BOXES[id] = { ...BOXES[id], busy: true };
  ltLoad().then((lt) => lt.boxHolds(p)).then((wei) => { BOXES[id] = { wei, at: Date.now() }; }, () => { BOXES[id] = { wei: null, at: Date.now() }; }).then(paintSteps);
}
const boxOpen = (p) => p.boxed && p.box && (p.state === 'depositing' || p.state === 'unsure') && Date.now() - p.at < 2400e3;
async function boxWatch() {
  BOXW.t = 0;
  const p = plans().find(boxOpen);
  if (!p || S.busy || !depKeyed()) return;
  try { await (await ltLoad()).check(p); } catch { }
  paintSteps();
}
const GOT = new Set(), TRANSFER_T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
async function learnGot(id) {
  const p = plans().find((x) => x.id === id);
  if (!p?.swapTx || p.got || p.token === lc(R.ZERO) || p.into || (p.dest && p.dest.kind !== 'address')) return;
  for (let i = 0; i < 8; i++) {
    const rc = await rpc('eth_getTransactionReceipt', [p.swapTx]).catch(() => null);
    if (rc) {
      const got = (rc.logs || []).filter((l) => lc(l.address) === lc(p.token) && l.topics?.[0] === TRANSFER_T && lc('0x' + String(l.topics[2] || '').slice(26)) === lc(p.to)).reduce((a, l) => a + BigInt(l.data), 0n);
      if (got > 0n) { try { localStorage.setItem(PLANS_KEY, JSON.stringify(plans().map((x) => (x.id === id ? { ...x, got: String(got) } : x)))); } catch { } paintSteps(); }
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function laterOffer(id, via = 'relay', again = false) {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  if (p.state !== 'waiting') { paintSteps(); return; }
  proverSoon(true);
  S.busy = true; if (!again) S.note = ''; paintQuote(); say('Reading the price…');
  try {
    const lt = await ltLoad(), o = await lt.offer(p, { slippageBps: S.slip });
    LATER.offers[id] = { ...o, via };
    say('');
  } catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); }
}
async function laterCheck(id) {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  S.busy = true; paintQuote(); say('Checking it against the pool…');
  try { const q = await (await ltLoad()).check(p); say(q.state === 'done' ? 'Its swap went through.' : q.state === 'waiting' ? 'It is in the pool and waits to be swapped.' : q.state === 'depositing' ? 'The relay has sent it. The pool’s keeper has not completed the deposit yet: it is looked for again.' : esc(q.err || 'It did not go through.'), '', true); }
  catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); }
}
async function laterSwap(id, via = 'relay') {
  const p = plans().find((x) => x.id === id);
  let shown = LATER.offers[id];
  if (!p || S.busy || !shown) return;
  if (p.state !== 'waiting') { delete LATER.offers[id]; paintSteps(); return; }
  if (via === 'self' && !confirm('This wallet pays for the swap out and is seen sending it. Send it from this wallet?')) return;
  const slip = S.slip;
  S.busy = true; S.note = ''; paintQuote();
  let again = false;
  try {
    const lt = await ltLoad();
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    readBlend().catch(() => {});
    if (p.token !== lc(R.ZERO) && Date.now() - shown.at > 60e3) {
      say('Reading the price again…');
      const again = await lt.offer(p, { slippageBps: slip });
      if (again.min < shown.min) { LATER.offers[id] = { ...again, ks: shown.ks, via }; say('The price moved while you signed in. Check it and confirm again; nothing was sent.', '', true); return; }
      shown = LATER.offers[id] = { ...again, ks: shown.ks, via };
    }
    if (BLEND[id]) p.mixed = BLEND[id].since;
    const done = await lt.swapOut(p, { shown, slippageBps: slip, via, onStep: (s) => { LATER.step[id] = laterStep(s); say(esc(laterStep(s))); paintSteps(); } });
    delete LATER.offers[id];
    if (done.state === 'shielding') { paintSteps(); await lt.shield(done, { onStep: (s) => say(esc(laterStep(s))) }); }
    const where = done.into ? `is on its way into your private ${esc(p.sym)} pool: its relay completes it within minutes` : done.dest?.kind === 'tacit' ? `was sent privately to ${esc(done.dest.name || 'the Tacit address')}` : done.dest?.kind === 'me' ? 'is in your private balance' : `went to ${shortAddrH(p.to)}`;
    remember(done.swapTx, `${tidy(amtFmt(BigInt(p.swapWei), p.hop ? p.hop.dec : 18))} ${p.hop ? p.hop.sym : 'ETH'} → ${p.sym}, privately${done.into ? ', into your pool' : done.dest?.kind === 'address' || !done.dest ? `, to ${shortAddr(p.to)}` : ''}`);
    if (p.held) H.moves?.stale?.(p.hop ? lc(p.hop.token) : lc(R.ZERO), 'pay');
    say(`<span class="ok">Swapped.</span> ${esc(p.sym)} ${where}. <a href="https://etherscan.io/tx/${esc(done.swapTx)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>`, 'ok', true);
    GOT.add(id); learnGot(id).catch(() => {});
  } catch (e) {
    say(esc(e?.message || String(e)), 'err', true);
    if (e?.moved) { delete LATER.offers[id]; again = true; }
  }
  finally { delete LATER.step[id]; S.busy = false; paint(); paintSteps(); H.onDone?.(); }
  if (again) laterOffer(id, via, true);
}
async function laterReclaim(id) {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy || p.state !== 'stopped') return;
  if (!W.account) { await H.connect(); return; }
  S.busy = true; pageSigner.pin = W.account || null; paintQuote(); say('Checking the deposit box…');
  const steps = { 'confirm in your wallet': 'Confirm sending it back in your wallet…', 'waiting for the block': 'Waiting for the block…' };
  try {
    const r = await (await ltLoad()).reclaimBox(p, { onStep: (t) => say(steps[t] || esc(t)) });
    remember(r.hash, `${tidy(amtFmt(r.wei, 18))} ETH sent back from a deposit box`);
    say(`<span class="ok">Sent back.</span> ${esc(tidy(amtFmt(r.wei, 18)))} ETH went to ${shortAddrH(r.to)}, an address only your key controls, where the pool’s keeper turns it into private ETH. ${txLink(r.hash)}`, 'ok', true);
  } catch (e) { say(e instanceof UserStopped || e?.userStopped ? declinedWords(e, 'Nothing was sent.') : esc(e?.message || String(e)), e instanceof UserStopped || e?.userStopped ? '' : 'err', true); }
  finally { S.busy = false; pageSigner.pin = null; delete BOXES[id]; paint(); paintSteps(); H.onDone?.(); }
}
async function laterShield(id) {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  if (p.state !== 'shielding' && p.state !== 'held') { paintSteps(); return; }
  S.busy = true; S.note = ''; paintQuote(); paintSteps();
  try {
    const lt = await ltLoad();
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    const done = await lt.shield(p, { onStep: (s) => say(esc(laterStep(s))) });
    say(`<span class="ok">Private.</span> ${esc(p.sym)} ${done.dest.kind === 'tacit' ? `was sent to ${esc(done.dest.name || 'the Tacit address')}` : 'is in your private balance'}.`, 'ok', true);
  } catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); H.onDone?.(); }
}
async function readBlend() {
  const ps = plans().filter((p) => p.state === 'waiting');
  if (!ps.length || !LT || !depKeyed()) return;
  for (const p of ps) { try { BLEND[p.id] = await LT.blend(p); } catch { } }
  paintSteps();
}
function stepsClick(e) {
  const g = e.target.closest('[data-later-go]'), ok_ = e.target.closest('[data-later-ok]'), no = e.target.closest('[data-later-no]'), c = e.target.closest('[data-later-check]');
  const s = e.target.closest('[data-later-self]'), f = e.target.closest('[data-later-forget]'), sh = e.target.closest('[data-later-shield]'), rb = e.target.closest('[data-later-reclaim]');
  if (sh) laterShield(sh.dataset.laterShield);
  if (rb) laterReclaim(rb.dataset.laterReclaim);
  const ir = e.target.closest('[data-into-reclaim]'); if (ir) intoReclaim(ir.dataset.intoReclaim);
  if (g) laterOffer(g.dataset.laterGo);
  if (ok_) laterSwap(ok_.dataset.laterOk, ok_.dataset.via === 'self' ? 'self' : 'relay').then(readBlend, () => {});
  if (no) { delete LATER.offers[no.dataset.laterNo]; say(''); paintSteps(); }
  if (c) laterCheck(c.dataset.laterCheck);
  if (s) laterOffer(s.dataset.laterSelf, 'self');
  if (f && (!f.dataset.ask || confirm((() => { const pl = plans().find((p) => p.id === f.dataset.laterForget); return pl?.boxed && pl.boxIntent && !pl.reclaimedAt && pl.state === 'stopped' ? 'Remove this swap? Its deposit box may still hold ETH, and this record is what sends it back from here. Removing it means that can no longer be done on this page.' : pl?.held ? 'Remove this plan? The balance stays in the pool, yours.' : pl?.hop ? `Remove this plan? Its deposit stays in your private ${pl.hop.sym} balance.` : 'Remove this plan? Its deposit stays in your private ETH balance, on the private ETH page.'; })()))) { try { localStorage.setItem(PLANS_KEY, JSON.stringify(plans().filter((p) => p.id !== f.dataset.laterForget))); } catch { } paintSteps(); }
}

async function exitPool(k) {
  const lt = await ltLoad();
  if (isEth(k)) {
    if (LATER.fee == null || Date.now() - LATER.feeAt > 120e3) await readFee().catch(() => {});
    return { open: true, fee: LATER.fee != null && Date.now() - LATER.feeAt <= 120e3 ? LATER.fee : null, hop: null };
  }
  const t = LATER.tp[k];
  if (t && !t.busy && Date.now() - (t.at || 0) < 60e3) return { open: hopOpen(t), fee: t.fee, hop: t.hop };
  const hop = await lt.hopOf(k), open = hopOpen({ hop });
  const fee = open ? await lt.mod.relayFee(Number(lt.mod.HOP_GAS), undefined, hop.keeper, hop.pool).catch(() => null) : null;
  LATER.tp[k] = { ...(t || {}), hop, fee, served: !!lt.mod.SERVED[k], at: Date.now(), tried: Date.now(), busy: false };
  return { open, fee, hop };
}
async function quoteExit(my, wei) {
  const pay = tokenOf(S.pay), get = tokenOf(S.get);
  if (tacSwap()) wei = alignTac(wei);
  const done = (q) => { if (my !== S.seq) return; S.q = { ...q, kind: 'exit', wei, at: now() }; paint(); };
  const lt = await ltLoad();
  const stand = standIn(), deadline = chainDeadline(1200);
  const price = () => {
    const out = exitOf()?.wallet && !isEth(S.pay)
    ? A.bestRoute({ ethCall, to: PREVIEW, refundTo: PREVIEW, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: S.slip, deadline })
    : isEth(S.pay)
    ? (S.get === lc(R.TAC) ? lt.mod.routeOutTac({ venues, amount: wei, to: stand, slippageBps: S.slip, deadline }) : lt.mod.routeOut({ ethCall, token: S.get, amount: wei, to: stand, slippageBps: S.slip, deadline }))
    : lt.mod.routeFrom({ ethCall, venues, tokenIn: S.pay, token: isEth(S.get) ? R.ZERO : S.get, amount: wei, to: stand, slippageBps: S.slip, deadline });
    return within(out, 25e3, 'zQuoter did not answer in time. Try again.').then((r) => ({ r }), (e) => ({ e }));
  };
  const routeP = S.pay === S.get ? null : price();
  const pool = exitOf()?.wallet ? { open: true, fee: null, hop: null } : await exitPool(S.pay);
  if (!pool.open) return done({ rows: [], why: `The private ${pay.sym} pool is not open yet.` });
  if (pool.fee == null && !exitOf()?.wallet) return done({ rows: [], why: `No price for the private ${pay.sym} pool yet. Try again in a moment.` });
  if (S.pay === S.get) return done({ rows: [{ k: 'exit', name: `${pay.sym} itself`, out: wei, min: wei, best: true }], fee: pool.fee });
  const { r, e } = await routeP;
  if (e) throw e;
  if (!r) return done({ rows: [], why: `No onchain route sells ${pay.sym} for ${get.sym} right now.` });
  const dst = exitOf()?.into ? await exitPool(S.get) : null;
  if (dst && !dst.open) return done({ rows: [], why: `The private ${get.sym} pool is not open yet.` });
  const arrives = dst && dst.fee != null ? (r.min * 997n) / 1000n - dst.fee : null;
  return done({ rows: [{ k: 'exit', name: r.name, out: r.out, min: r.min, best: true }], fee: pool.fee, ...(dst ? { dstFee: dst.fee, arrives } : {}) });
}
const exitDest = () => S.to || (W.account ? lc(W.account) : null);
function exitButton(q, r) {
  const pay = tokenOf(S.pay), get = tokenOf(S.get), wei = parseUnits(S.amt, pay.dec), wal = !!exitOf()?.wallet, bal = wal ? (W.account ? S.bal[S.pay] ?? null : null) : H.moves?.held?.(S.pay, 'pay') ?? null, same = S.pay === S.get;
  if (S.busy) return ['Working…', false];
  if (!wei) return [amountWord(S.amt, pay.dec), false];
  if (wal && !W.account) return ['Connect wallet', true];
  if (S.toBad) return ['Check the address', false];
  if (S.toBusy) return ['Finding the address…', false];
  if (q?.busy || !q) return ['Finding the best price…', false];
  if (!r) return [q?.err ? 'Try again' : 'No route', !!q?.err];
  const dest = intoPool() ? 'pool' : exitDest();
  if (!dest) return ['Add the address it goes to', false];
  if (bal != null && wei > bal && (wal || !stagedFits(S.pay, wei))) return [wal ? `Not enough ${pay.sym}` : `Not enough private ${pay.sym}`, false];
  if (bal != null && q.fee != null && wei + 2n * q.fee > bal) return ['Leave room for the relay’s fee', false];
  if (wal && isEth(S.pay) && bal != null && wei + gasKeep() > bal) return ['Leave some ETH for the network fee', false];
  if (wal && !isEth(S.pay) && S.bal[lc(R.ZERO)] != null && 2n * gasKeep() > S.bal[lc(R.ZERO)]) return ['Leave some ETH for the network fee', false];
  if (intoPool() && q.arrives != null && q.arrives <= (q.dstFee ?? 0n)) return ['Too small for the pool’s fee', false];
  if (intoPool()) return [`Swap ${pay.sym} into your private ${get.sym}`, true, 'priv'];
  return [same ? `Withdraw ${pay.sym} → ${who(dest)}` : `Swap ${pay.sym} for ${get.sym} → ${who(dest)}`, true, 'priv'];
}
function paintExit() {
  const q = S.q, r = q?.kind === 'exit' ? q.rows?.[0] || null : null, pay = tokenOf(S.pay), get = tokenOf(S.get), out = $('#out'), rc = $('#rcpt'), go = $('#go'), busy = !!q?.busy;
  out.classList.toggle('busy', busy); out.classList.remove('word');
  if (r && !busy) { out.textContent = tidy(amtFmt(r.out, get.dec)); out.classList.remove('ph'); }
  else if (!busy) { out.textContent = '0'; out.classList.add('ph'); }
  fitSize(out);
  const vo = r && !busy ? usdOf(S.get, r.out) : null;
  $('#get-usd').textContent = vo != null ? `≈ ${usd(vo)}` : '';
  $('#rows').hidden = true; $('#later').hidden = true; $('#ackbox').innerHTML = ''; $('#ackbox').dataset.k = '';
  rc.classList.toggle('stale', busy);
  const lines = [];
  if (r) {
    const inAmt = Number(q.wei) / 10 ** pay.dec, outAmt = Number(r.out) / 10 ** get.dec, dest = exitDest();
    if (S.pay !== S.get && inAmt > 0 && outAmt > 0) lines.push(['Price', (outAmt >= inAmt) !== !!S.pxFlip ? `1 ${pay.sym} = ${sig(outAmt / inAmt)} ${get.sym}` : `1 ${get.sym} = ${sig(inAmt / outAmt)} ${pay.sym}`, '', '', null, 'px-flip']);
    if (S.pay !== S.get) { lines.push(['At least', `${tidy(amtFmt(r.min, get.dec))} ${get.sym}`]); lines.push(['Route', r.name]); }
    lines.push(['Chain sees', exitOf()?.wallet ? `your ${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym} swapped into a pool deposit, not whose it is` : intoPool() ? `a swap into a pool deposit, not whose it is` : htmlVal(`${esc(get.sym)} to ${dest ? whoH(dest) : 'the address'}, not from whom`)]);
    if (q.arrives != null && q.arrives > 0n) lines.push(['Arrives', `about ${tidy(amtFmt(q.arrives, get.dec))} ${get.sym}, private`, '', 'A little under the least above, less the relay’s fee of that pool for completing the deposit']);
    const fu = q.fee != null ? usdOf(S.pay, q.fee) : null;
    if (q.fee != null) lines.push(['Relay fee', `${tidy(amtFmt(q.fee, pay.dec))} ${pay.sym}${fu != null ? ` · about ${fu < 1 ? `$${fu.toFixed(2)}` : usd(fu)}` : ''}`, '', 'What the relay charges to send it out of the pool, from your private balance (kept back twice, for a fee that rises before it goes).']);
  }
  rc.hidden = !lines.length;
  rc.innerHTML = lines.map(([k, v, c, t, href, act]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${k === 'TAC points' ? TAC_MARK : ''}${esc(k)}</dt><dd class="${c || ''}">${act ? `<button type="button" class="flip-px" data-${act} aria-label="${esc(v)}. Turn it around">${esc(v)}</button>` : cell(v)}</dd></div>`).join('');
  const [label, can, cls] = exitButton(q, r);
  go.textContent = label; go.disabled = !can; go.className = `go${cls ? ` ${cls}` : ''}`;
  if (!S.busy) {
    const own = r && !busy && !intoPool() && W.account && exitDest() === lc(W.account);
    const heavy = r && !busy && q.fee != null && q.wei > 0n && q.fee * 20n > q.wei ? `The relay’s fee is ${Math.round(Number((q.fee * 1000n) / q.wei)) / 10}% of this. A larger amount costs less.` : '';
    if (S.note) say(S.note.h, S.note.cls); else say(lineFor(q, r, 'exit') || (heavy ? `<span class="warn">${esc(heavy)}</span>` : own ? 'To this wallet. A new address keeps it apart from it.' : ''));
  }
}
const INTO_BOXES = 'tacit-swap-into-boxes-v1';
function keepIntoBox(rec) {
  try {
    const l = JSON.parse(localStorage.getItem(INTO_BOXES) || '[]').filter((x) => x && lc(x.box) !== lc(rec.box));
    localStorage.setItem(INTO_BOXES, JSON.stringify([{ ...rec, at: Date.now() }, ...l].slice(0, 100), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch { }
}
async function walletIntoGo(q, r) {
  if (!W.account) { await H.connect(); return; }
  if (!r || S.busy) return;
  S.note = '';
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  const get = tokenOf(S.get), wei = q.wei, slip = S.slip;
  S.busy = true; approved = ''; zeroed = ''; pageSigner.pin = W.account || null; paintQuote(); say('Opening your private balance…');
  try {
    const lt = await ltLoad();
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    const into_ = await exitPool(S.get);
    if (!into_.open || into_.fee == null) throw new Error(`The private ${get.sym} pool is not ready right now. Try again in a moment.`);
    const pay = tokenOf(S.pay);
    let out;
    if (isEth(S.pay)) out = await lt.swapIntoPool({ swapWei: wei, token: S.get, into: { hop: into_.hop }, slippageBps: slip, shownMin: r.min, onStep: (s) => say(esc(laterStep(s))),
      onBox: (b) => keepIntoBox({ box: b.box, intent: b.intent ?? null, deadline: b.deadline ?? null, router: into_.hop?.state?.router || null, token: S.get, pay: S.pay, hash: null }) });
    else {
      const bx = await lt.depositBoxFor({ into: { hop: into_.hop }, floor: r.min });
      keepIntoBox({ box: bx.box, intent: bx.intent ?? null, deadline: bx.deadline ?? null, router: into_.hop?.state?.router || null, token: S.get, pay: S.pay, hash: null });
      say('Reading the price again…');
      const from = W.account, dl = chainDeadline(1200);
      const zq = await within(A.bestRoute({ ethCall, to: bx.box, refundTo: from, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
      if (!zq || zq.min < bx.amount) throw new Error('The price moved while the deposit box was made. Nothing was sent; press again.');
      const tx = await aggTx(zq, from);
      say('Checking it first…');
      if (!(await venues.simulate({ tx, from })).ok) throw Object.assign(new Error(`${unsent('This swap would fail')} Try a smaller amount or try again.`), { html: true });
      say('Confirm the swap in your wallet.');
      const hash = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from, label: 'Swap privately' });
      say('Waiting for the block…');
      const rc = await wallet.receipt(hash).catch(() => null);
      if (rc && !(rc.status === '0x1' || rc.status === 1 || rc.status === 'success')) throw new Error('The swap was sent but failed on chain, so nothing reached your private balance.');
      out = { hash, box: bx.box, arrives: bx.value, intent: bx.intent ?? null, deadline: bx.deadline ?? null };
    }
    if (out?.box) keepIntoBox({ box: out.box, intent: out.intent ?? null, deadline: out.deadline ?? null, router: into_.hop?.state?.router || null, token: S.get, pay: S.pay, hash: out.hash || null });
    remember(out.hash, `${tidy(amtFmt(wei, pay.dec))} ${pay.sym} → ${get.sym}, privately, into your pool`);
    S.amt = ''; S.q = null; S.seq++;
    say(`<span class="ok">Sent.</span> About ${esc(tidy(amtFmt(out.arrives, get.dec)))} ${esc(get.sym)} reach your private balance within minutes. <a href="https://etherscan.io/tx/${esc(out.hash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>`, 'ok', true);
  } catch (e) { say(e instanceof UserStopped || e?.userStopped ? unsent() : e?.html ? e.message : esc(e?.message || String(e)), e instanceof UserStopped || e?.userStopped ? '' : 'err', true); }
  finally { S.busy = false; pageSigner.pin = null; changed(); paint(); H.onDone?.(); H.moves?.stale?.(S.get, 'pay'); readBalances().then(paintSides, () => {}); }
}
async function exitGo() {
  const q = S.q, r = q?.kind === 'exit' ? q.rows?.[0] : null, into = intoPool(), dest = into ? 'pool' : exitDest();
  if (exitOf()?.wallet) return walletIntoGo(q, r);
  if (!r || !dest || S.busy || S.toBad) return;
  S.note = '';
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  const pay = tokenOf(S.pay), get = tokenOf(S.get), wei = q.wei;
  S.busy = true; paintQuote(); say('Opening your private balance…');
  let plan = null;
  try {
    const lt = await ltLoad();
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    const pool = await exitPool(S.pay);
    if (!pool.open || pool.fee == null) throw new Error(`No price for the private ${pay.sym} pool yet. Try again in a moment.`);
    const into_ = into ? await exitPool(S.get) : null;
    if (into && (!into_.open || (into_.hop && into_.fee == null))) throw new Error(`The private ${get.sym} pool is not ready right now. Try again in a moment.`);
    plan = await lt.adopt({ swapWei: wei, token: S.get, sym: get.sym, dec: get.dec, to: into ? null : dest, toName: !into && S.toName?.addr === lc(dest) ? S.toName.name : null,
      hop: pool.hop, pay: pool.hop ? { sym: pay.sym, dec: pay.dec } : null, feeWei: pool.fee, ...(into ? { into: { hop: into_.hop } } : {}) });
    S.amt = ''; S.q = null; S.seq++; S.to = null; S.toName = null; S.toOpen = false; $('#to-in').value = ''; say('');
  } catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; changed(); paint(); paintSteps(); }
  if (plan) { readBlend().catch(() => {}); laterOffer(plan.id); }
}

let PVP = null, PV = null;
const pickWallet = (list) => { const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid; };
const pvLoad = () => (PVP ||= import('/swap/private.js?cb=1c0cb519').then((m) => {
  PV = m.makePrivate({ getUx, pick: pickWallet, ...H.key, now: () => (S.chainT ? (S.chainT + (now() - S.chainAt)) * 1000 : Date.now()), onKey: (why) => { if (why) say(esc(why), 'err', true); else { PV.read().then(paint, () => {}); if (plans().some((x) => x.state === 'waiting')) ltLoad().then(readBlend, () => {}); } paint(); } });
  PV.mod = m;
  return PV;
}).catch((e) => { PVP = null; throw e; }));
const aheadArgs = (q) => { const p = q?.pools; const units = parseUnits(S.amt, 8); return q?.kind === 'private' && !S.inP && isEth(S.pay) && S.get !== 'teth' && p?.length === 1 && units && IDS[p[0].b] ? { wei: units * E10, toAsset: IDS[p[0].b], feeBps: p[0].feeBps } : null; };
const KEEP_SWAP = ['0.01', '0.1'];
const KS = { tier: {}, at: 0 };
const keptPair = () => (!S.inP && isEth(S.pay) && S.get !== 'teth' && PK[S.get] && kindOf(S.pay, S.get) === 'private' && IDS[PK[S.get]] && (PV?.unlocked || H.key?.session?.unlocked) ? IDS[PK[S.get]] : null);
const stagePair = () => (S.inP && S.outP && S.pay === 'teth' && S.get !== 'teth' && PK[S.get] && IDS[PK[S.get]] && kindOf(S.pay, S.get) === 'private' && (PV?.unlocked || H.key?.session?.unlocked) ? IDS[PK[S.get]] : null);
function stagedChips() {
  if (!stagePair() || !PV) return null;
  const have = PV.stagedSizes(paint);
  if (!have) return null;
  if (PV.deviceStaging?.()) {
    const sized = [...new Set(have.map(String))].map(BigInt).sort((a, b) => (a < b ? 1 : -1)).slice(0, 3);
    const chips = sized.map((u) => ({ v: tidy(fmtUnits(u * E10, 18, 8)), rd: true, t: 'Kept ready: one fast proof' }));
    if (PV.isStaging()) chips.push({ v: 'Keeping ready…', act: true, off: true });
    else if ((privBal('teth') ?? 0n) > 0n) chips.push({ v: 'Keep ready', act: true });
    return chips;
  }
  const units = KEEP_SWAP.map((v) => parseUnits(v, 8)), miss = units.filter((u) => !have.includes(u));
  const chips = KEEP_SWAP.map((v, i) => ({ v, rd: have.includes(units[i]), t: 'Kept ready: one fast proof' }));
  if (PV.isStaging()) chips.push({ v: 'Keeping ready…', act: true, off: true });
  else if (keepable(miss)) chips.push({ v: 'Keep ready', act: true });
  return chips;
}
function keepable(miss) {
  const id = IDS[PK.teth];
  if (!miss.length || !PV?.held || !id) return false;
  const top = PV.of(id).notes.reduce((m, n) => (BigInt(n.value) > m ? BigInt(n.value) : m), 0n);
  return miss.some((u) => { const need = PV.stageNeed?.(u, paint); return need === undefined ? top > u : need !== null && top > need; });
}
async function stageGo() {
  let pv = null;
  try {
    pv = await pvLoad();
    if (pv.deviceStaging?.()) {
      const p = pv.stageWhole({ say: (n) => { say(`Keeping ${n} tETH note${n === 1 ? '' : 's'} ready to swap, proved on this computer: about 15 minutes…`, '', true); paint(); }, onStaged: () => pv.read(true).then(paint, paint) });
      paint();
      const n = await p; S.note = ''; say(n ? 'Kept ready. Pick a size to swap it in one fast proof.' : 'Nothing to keep ready: no free tETH note.', n ? '' : 'err', true);
      return;
    }
    const p = pv.stageSizes({ sizes: KEEP_SWAP.map((v) => parseUnits(v, 8)), say: (u) => { say(`Keeping ${esc(tidy(amtFmt(u * E10, 18)))} tETH ready to swap…`, '', true); paint(); }, onStaged: () => pv.read(true).then(paint, paint) });
    paint();
    const n = await p; S.note = '';
    const left = KEEP_SWAP.map((v) => parseUnits(v, 8)).filter((u) => !(pv.stagedSizes?.() || []).includes(u));
    if (n || !left.length) say('Kept ready. Pick a size to swap it in one fast proof.', '', true);
    else say('Nothing to keep ready: no single tETH note holds a size and its fee. Each size is cut from one note, and notes are not joined.', 'err', true);
  } catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { pv?.read(true).then(paint, paint); }
}
function keptChips() {
  const to = keptPair(), f = to ? KS.tier[to] : null;
  if (!to) return stagedChips();
  if (f === undefined) { KS.tier[to] = null; pvLoad().then((pv) => pv.tierOf(to)).then((x) => { KS.tier[to] = x; paint(); }, () => {}); }
  if (Date.now() - KS.at > 60e3 && f) { KS.at = Date.now(); pvLoad().then((pv) => pv.keep({ sizes: KEEP_SWAP.map((v) => String(parseUnits(v, 8) * E10)), toAsset: to, feeBps: f, onReady: paint })).catch(() => {}); }
  return f ? KEEP_SWAP.map((v) => ({ v, rd: PV?.aheadOf?.({ wei: parseUnits(v, 8) * E10, toAsset: to, feeBps: f }) === 'ready' })) : null;
}
const routeAheadArgs = (q) => {
  if (q?.kind !== 'private' || !S.inP || !S.outP || isEth(S.pay) || !q.pools?.length) return null;
  const r = picked(q), units = parseUnits(S.amt, 8), k0 = PK[S.pay];
  if (S.pay === 'teth' && q.pools.length === 1 && units && PV?.stagedSizes?.()?.includes(units)) return null;
  return r && units && IDS[k0] ? { wallet: false, asset: IDS[k0], units, ticker: POOL_TK[k0], fee: q.fee ?? 0n, path: q.pools.map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })), minOut: poolFloor(r.out / E10) } : null;
};
let ahT = 0;
function aheadSoon() {
  clearTimeout(ahT);
  const q = S.q, a = aheadArgs(q), ra = !a && routeAheadArgs(q);
  if (!(a || ra) || !(PV?.unlocked || H.key?.session?.unlocked)) return;
  ahT = setTimeout(() => {
    if (S.q !== q) return;
    pvLoad().then((pv) => { const p = a ? pv.ahead(a) : pv.routeAhead(ra); paintQuote(); return p; }).then(() => { if (S.q === q) paintQuote(); }, () => {});
  }, 1500);
}
const privBal = (k) => { const id = IDS[PK[k]]; return PV?.held && id ? PV.of(id).value * E10 : null; };
const stagedFits = (k, wei) => k === 'teth' && wei > 0n && wei % E10 === 0n && !!PV?.stagedSizes?.()?.includes(wei / E10);
function privUp() {
  if (!H.key?.session?.unlocked || !(S.inP || S.outP)) return;
  pvLoad().then(async (pv) => { idsOf(await getUx()); await pv.read(); }).then(paint, paint);
}
async function openPrivate() {
  const pv = await pvLoad();
  try { await pv.open(); } catch (e) { if (!e?.unlockCancelled) say(esc(e?.message || String(e)), 'err'); return; }
  idsOf(await getUx());
  paint();
}
const EXITS_KEY = 'tacit-swap-exits-v1';
const readExits = () => { try { return (JSON.parse(localStorage.getItem(EXITS_KEY) || '[]') || []).filter((x) => x?.recipe && /^0x[0-9a-f]{40}$/.test(x.escrow || '')).slice(0, 8); } catch { return []; } };
const keepExits = (xs) => { try { localStorage.setItem(EXITS_KEY, JSON.stringify(xs.slice(0, 8))); } catch { } };
const saveExit = (x) => keepExits([x, ...readExits().filter((y) => y.escrow !== x.escrow)]);
function exitLine(x) {
  const late = chainNow() > Number(x.recipe.deadline), when = new Date(Number(x.recipe.deadline) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const to = shortAddr(x.recipe.finalRecipient);
  return `${esc(x.what || 'Your ETH')} is out of the pool, at its escrow ${addrLink(x.escrow)}, but the swap to ${esc(x.sym || 'the token')} has not run${x.why ? ` (${esc(String(x.why).slice(0, 120))})` : ''}. `
    + (late ? `<button type="button" class="link" data-exit-back="${esc(x.escrow)}">Send it to ${esc(to)} as ETH</button>.`
      : `<button type="button" class="link" data-exit-run="${esc(x.escrow)}">Run the swap from your wallet</button> (anyone may: the wallet that does is seen doing it), or after ${esc(when)} send it to ${esc(to)} as ETH.`);
}
const addrLink = (a) => `<a href="https://etherscan.io/address/${esc(a)}" target="_blank" rel="noopener noreferrer">${addrFlat(a, 4, 6)}↗</a>`;
async function exitAct(escrow, back) {
  const x = readExits().find((y) => y.escrow === escrow);
  if (!x || S.busy) return;
  if (!W.account) { await H.connect(); return; }
  S.busy = true; paintQuote();
  try {
    await chainTime();
    if (back !== (chainNow() > Number(x.recipe.deadline))) { say(exitLine(x), 'err', true); return; }
    const calls = await (await pvLoad()).exitCalls(x.recipe), data = back ? calls.reclaim : calls.activate;
    say('Checking it first…');
    if (!(await venues.simulate({ tx: { to: calls.router, data, value: 0n }, from: W.account })).ok) throw new Error(`${back ? 'It cannot be sent on' : 'The swap cannot run'} right now: the escrow refuses it. Nothing was sent; try again in a moment${back ? '' : ', or send it on as ETH once the deadline has passed'}.`);
    say('Confirm it in your wallet…');
    const h = await wallet.sendTx({ to: calls.router, data, from: W.account, label: back ? 'Send it as ETH' : 'Run the swap' });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error('It did not go through. Nothing was lost but its network fee.');
    keepExits(readExits().filter((y) => y.escrow !== escrow));
    remember(h, back ? `Sent ${x.what || 'the ETH'} to ${shortAddr(x.recipe.finalRecipient)} as ETH` : `Swapped ${x.what || 'the ETH'} for ${x.sym || 'the token'} to ${shortAddr(x.recipe.finalRecipient)}`);
    say(`<span class="ok">Done.</span> ${back ? 'The ETH went' : 'The swap ran and paid'} to ${shortAddrH(x.recipe.finalRecipient)}. ${txLink(h)}`, 'ok', true);
  } catch (e) { say(esc(e instanceof UserStopped || e?.userStopped ? 'Nothing was sent.' : e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); }
}
async function checkExits() {
  const xs = readExits(), left = [], full = new Set();
  for (const x of xs) {
    const bal = await rpc('eth_getBalance', [x.escrow, 'latest']).then(BigInt, () => null);
    if (bal == null || bal > 0n || now() - (x.at || 0) < 900) left.push(x);
    if (bal !== 0n) full.add(x);      // an escrow emptied since is a swap that ran: kept a while, not said to be stuck
  }
  keepExits(left);
  const w = left.find((x) => full.has(x) && now() - (x.at || 0) >= 120);
  if (w) await chainTime();
  if (w && !S.busy && !S.note) say(exitLine(w), 'err', true);
}
const HERE_SAY = {
  split: 'This computer is cutting a note to the amount first, a few minutes…', combine: 'This computer is combining your notes into one of the amount first, a few minutes…',
  route: 'This computer is proving your private swap, a few minutes. Nothing has left your wallet yet…', own: 'This computer is proving your swap, a few minutes. Nothing has left your wallet yet…',
  again: 'The pool traded while this computer proved it, so it is proved again at the new price…',
};
async function privateGo(r, kind = 'private', here = false) {
  if (kind === 'pin') return pinGo(r);
  let q = S.q;
  const fromWallet = isEth(S.pay), units = parseUnits(S.amt, 8);
  if (!q || !units) return;
  if (fromWallet && !W.account) { await H.connect({ key: true }); return; }
  const slip = S.slip, toTacit = S.toTacit, outAddr = kind === 'pout' ? outTo() : null;
  if (now() - (q.at || 0) > 60) {
    S.busy = true; paintQuote(); say('Reading the price again…');
    const least = poolFloor(r.out, slip), my = ++S.seq;
    await within(quote(my, q.wei), 30e3, 'The price was not read in time.').catch(() => {});
    const nr = my === S.seq && S.q && !S.q.err ? picked(S.q) : null;
    if (!nr || nr.k !== r.k || nr.out < least) { S.busy = false; paintQuote(); say('The price moved. Check it and press once more.', '', true); return; }
    q = S.q; r = nr;
  }
  const pay = tokenOf(S.pay), get = tokenOf(S.get), what = `${tidy(plain(units, 8))} ${pay.sym}`, payKey = S.pay, earned = rowPts(r, q);
  let popped = false;
  const step = (k, h) => (paced(k), say((here && HERE_SAY[k]) || {
    prepare: 'Preparing the deposit…', confirm: 'Confirm the deposit in your wallet…', sent: `Deposit sent ${h ? txLink(h) : ''}. Waiting for it to land…`,
    proving: `Deposited ${h ? txLink(h) : ''}. The relay is making it private, about a minute…`, note: 'Private now. Finding its note…',
    split: 'The relay is cutting a note to the amount first, about a minute…', combine: 'The relay is combining your notes into one of the amount first, about a minute…',
    route: 'The relay is proving your private swap, about a minute…', send: 'The relay is sending it on to them, about a minute…',
    ahead: 'Finishing the proof of your swap…', posted: 'The relay is sending your private swap, its proof is made, a few moments…', own: 'Proving your swap with your own prover, about a minute. Nothing has left your wallet yet…', check: 'Checking it first…', swap: `Deposited ${h ? txLink(h) : ''}. The relay is proving your swap, about a minute…`,
    exit: 'The relay is sending it out of the pool, about a minute…', exitswap: 'The relay is sending it out of the pool to be swapped, about a minute…',
    activate: `Out of the pool ${h ? txLink(h) : ''}. The relay is running the swap…`,
  }[k] || ''));
  S.busy = true; S.note = ''; paintQuote();
  try {
    const pv = await pvLoad(), t = await getUx();
    idsOf(t);
    if (kind === 'pout') {
      const k0 = PK[S.pay], to = outAddr, tokenOut = S.get, eth = isEth(S.get);
      if (!to) throw new Error('Name the address it goes to, or connect a wallet. Nothing was sent.');
      const plan = { asset: IDS[k0], units, ticker: POOL_TK[k0], fee: q.fee ?? 0n, eth: IDS.eth,
        path: k0 === 'eth' ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
        minOut: poolFloor(q.tUnits, slip), label: `Swap ${what} for ${get.sym} to ${who(to)}`,
        out: { token: eth ? null : tokenOut, to, minFee: q.xmin, min: r.min, wei: r.wei,
          quote: (wei) => R.quoteEthToToken({ ethCall, to, tokenOut, amount: wei, slippageBps: slip, deadline: chainDeadline(1800) }) } };
      let res;
      try { res = await pv.swapOut(plan, { say: step }); }
      catch (e) { if (e?.stuck) { e.stuck = { ...e.stuck, what: `About ${tidy(amtFmt(r.wei, 18))} ETH`, sym: get.sym, at: now() }; saveExit(e.stuck); } throw e; }
      const got = `${tidy(amtFmt(res.out, get.dec))} ${get.sym}`;
      if (res.txHash) remember(res.txHash, `Swapped ${what} for ${got} to ${who(to)}`);
      if (S.pay === payKey) { S.amt = ''; S.q = null; }
      if (S.to === to) { S.to = null; S.toBad = ''; $('#to-in').value = ''; }
      say(`<span class="ok">Done.</span> About ${esc(got)} went to ${whoH(to)}.${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
      return;
    }
    const k0 = fromWallet ? 'eth' : PK[S.pay];
    const plan = { wallet: fromWallet, wei: units * E10, units, asset: IDS[k0], ticker: POOL_TK[k0], fee: q.fee ?? 0n,
      path: S.get === 'teth' && fromWallet ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
      minOut: poolFloor(r.out / E10, slip), label: `Swap ${what} for ${get.sym} privately`, sendTo: toTacit, outTicker: POOL_TK[PK[S.get]] };
    const res = await (here ? pv.swapHere(plan, { wallet, from: W.account, say: step }) : pv.swap(plan, { wallet, from: W.account, say: step }));
    if (!popped) { popped = true; reward(earned); }
    const got = res.made != null ? `${tidy(plain(res.made, 8))} tETH` : `${tidy(amtFmt(res.out * E10, 18))} ${get.sym}`;
    if (res.txHash) remember(res.txHash, res.made != null ? `Made ${what} private` : `Swapped ${what} for ${got} privately`);
    if (S.pay === payKey) { S.amt = ''; S.q = null; }
    const where = res.sent ? `was sent to ${esc(res.sent.to || tacitName(toTacit))}. They claim it in their Tacit wallet.` : 'is in your private balance.';
    if (res.sent) { S.toTacit = null; S.toTacitBad = ''; S.toOpen = false; $('#to-in').value = ''; }
    say(`<span class="ok">Done.</span> ${res.made != null ? '' : 'About '}${esc(got)} ${where}${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
  } catch (e) {
    const m = PV?.mod;
    if (e?.unlockCancelled) say('');
    else if (e instanceof UserStopped || e?.userStopped || e?.code === 4001) say('Nothing was sent.', '', true);
    else if (e?.noProver) say('No prover runs on this computer yet. <a href="/prove/">Set up this computer</a>, then press again.', 'err', true);
    else if (e?.notNow && kind === 'private' && !here && !toTacit && PV?.canHere) { S.hereR = r; say(`${esc(e.message)}<br><button class="link" type="button" id="pv-here">Prove it on this computer</button>, free: it takes a few minutes, and nothing goes to the relay.`, 'err', true); }
    else if (e?.code === 'short') say(`Not enough private ${esc(pay.sym)}${e.most ? `: at most ${esc(tidy(plain(e.most, 8)))}, after the relay’s fee to cut a note to the amount` : ''}.`, 'err', true);
    else if (e?.stuck) say(exitLine(e.stuck), 'err', true);
    else if (e?.stayed) say(esc(e.message), 'err', true);
    else if (e?.pending) say(esc(e.message), 'err', true);
    else if (e?.kept) { if (S.pay === payKey) { S.inP = true; S.pay = 'teth'; S.amt = fitAmt(S.amt, true); S.q = null; if (!kindOf(S.pay, S.get)) fit('pay'); } say(`${esc(e.message)} Press Swap privately to swap it from there.`, 'err', true); }
    else if (e?.deposit && !e.deposit.landed) say(`${esc(m ? m.relayWords(e) : e.message)} Your deposit was sent ${e.deposit.hash ? txLink(e.deposit.hash) : ''} and is not confirmed yet. There is no need to send it again: once it lands, <a href="/teth/">finish it on the tETH page →</a>`, 'err', true);
    else if (e?.deposit) say(`${esc(m ? m.relayWords(e) : e.message)} Your ETH is in the Tacit pool ${e.deposit.hash ? txLink(e.deposit.hash) : ''}, not lost: <a href="/teth/">finish it on the tETH page →</a>`, 'err', true);
    else say(esc(m ? m.relayWords(e) : e?.message || String(e)), 'err', true);
  } finally {
    paced(''); S.busy = false; changed(); paint(); H.onDone?.();
    if (S.pay !== payKey || !S.q) requote(true);
    PV?.read(true).then(paint, () => {});
    if (fromWallet) readBalances().then(paintSides, () => {});
  }
}
async function pinGo(r) {
  const q = S.q, from = W.account;
  if (!q?.pin || !q.ethIn) return;
  if (!from) { await H.connect({ key: true }); return; }
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  const pay = tokenOf(S.pay), get = tokenOf(S.get), what = `${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym}`, payKey = S.pay, getKey = S.get, earned = rowPts(r, q), slip = S.slip, toTacit = S.toTacit;
  S.busy = true; S.note = ''; approved = ''; zeroed = ''; paintQuote();
  let h = null, swapped = false, popped = false;
  try {
    const pv = await pvLoad(), t = await getUx();
    idsOf(t);
    await pv.open();
    say('Reading the price again…');
    await pv.relayOpen();
    if (getKey !== 'teth') await pv.priceOk(IDS.eth, q.ethIn / E10, (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })), q.fee ?? 0n, poolFloor(r.out / E10, slip));
    const r1 = await within(A.bestRoute({ ethCall, to: from, refundTo: from, tokenIn: payKey, tokenOut: R.ZERO, amountIn: q.wei, slippageBps: slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!r1 || r1.min < q.ethIn) { say('The price moved below what was quoted. Nothing was sent; the quote above is the new one.', '', true); requote(true); return; }
    const tx = await aggTx(r1, from);
    say('Checking it first…');
    if (!(await venues.simulate({ tx, from })).ok) throw Object.assign(new Error(`${unsent('The swap to ETH would fail')} Try a smaller amount or try again.`), { html: true });
    say(`Confirm the swap of ${esc(what)} to ETH in your wallet…`);
    h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from, label: 'Swap to ETH' });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw Object.assign(new Error(`The swap to ETH failed (${txLink(h)}). Your ${esc(what)} is still in your wallet; nothing was lost but its network fee.`), { html: true });
    swapped = true;
    remember(h, `${what} → ETH, to be made private`);
    const plan = { wallet: true, wei: q.ethIn, units: q.ethIn / E10, asset: IDS.eth, ticker: 'cETH', fee: q.fee ?? 0n,
      path: getKey === 'teth' ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
      minOut: poolFloor(r.out / E10, slip), label: `Swap ${what} for ${get.sym} privately`, sendTo: toTacit, outTicker: POOL_TK[PK[getKey]] };
    const step = (k, x) => (paced(k), say({ prepare: 'Swapped to ETH. Preparing the deposit…', confirm: 'Confirm the deposit in your wallet…', sent: `Deposit sent ${x ? txLink(x) : ''}. Waiting for it to land…`,
      proving: `Deposited ${x ? txLink(x) : ''}. The relay is making it private, about a minute…`, note: 'Private now. Finding its note…', route: 'The relay is proving your private swap, about a minute…', ahead: 'Finishing the proof of your swap…', posted: 'The relay is sending your private swap, its proof is made, a few moments…', own: 'Proving your swap with your own prover, about a minute. Nothing has left your wallet yet…', check: 'Checking it first…', swap: `Deposited ${x ? txLink(x) : ''}. The relay is proving your swap, about a minute…`, send: 'The relay is sending it on to them, about a minute…' }[k] || ''));
    const res = await pv.swap(plan, { wallet, from, say: step });
    if (!popped) { popped = true; reward(earned); }
    const got = res.made != null ? `${tidy(plain(res.made, 8))} tETH` : `about ${tidy(amtFmt(res.out * E10, 18))} ${get.sym}`;
    if (res.txHash) remember(res.txHash, `Swapped ${what} for ${got} privately`);
    if (S.pay === payKey) { S.amt = ''; S.q = null; }
    const where = res.sent ? `was sent to ${esc(res.sent.to || tacitName(toTacit))}. They claim it in their Tacit wallet.` : 'is in your private balance.';
    if (res.sent) { S.toTacit = null; S.toTacitBad = ''; S.toOpen = false; $('#to-in').value = ''; }
    say(`<span class="ok">Done.</span> ${esc(got)} ${where}${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
  } catch (e) {
    const m = PV?.mod, why = esc(m ? m.relayWords(e) : e?.message || String(e));
    const turn = (inP, k, amt) => { S.inP = inP; S.pay = k; S.amt = amt; S.q = null; if (!kindOf(S.pay, S.get)) fit('pay'); };
    if (e?.unlockCancelled && !swapped) say('');
    else if ((e instanceof UserStopped || e?.userStopped) && !swapped) say(unsent(), '', true);
    else if (e?.html && !swapped) say(e.message, 'err', true);
    else if (e?.stayed && !swapped) say(esc(e.message), 'err', true);
    else if (e?.kept) { turn(true, 'teth', tidy(plain(q.ethIn / E10, 8))); say(`${esc(e.message)} Press Swap privately to swap it from there.`, 'err', true); }
    else if (e?.deposit && !e.deposit.landed) { turn(false, lc(R.ZERO), ''); say(`${why} Your deposit was sent ${e.deposit.hash ? txLink(e.deposit.hash) : ''} and is not confirmed yet. There is no need to send it again: once it lands, <a href="/teth/">finish it on the tETH page →</a>`, 'err', true); }
    else if (e?.deposit) { turn(false, lc(R.ZERO), ''); say(`${why} Your ETH is in the Tacit pool ${e.deposit.hash ? txLink(e.deposit.hash) : ''}, not lost: <a href="/teth/">finish it on the tETH page →</a>`, 'err', true); }
    else if (swapped) { turn(false, lc(R.ZERO), tidy(plain(q.ethIn, 18))); say(`Your ${esc(what)} is ETH in your wallet now ${txLink(h)}, but it was not made private: ${e instanceof UserStopped || e?.userStopped ? 'the deposit was cancelled' : why}. The card now swaps from that ETH: press again to try.`, 'err', true); }
    else if (h) say(`The swap to ETH was sent ${txLink(h)} but its result could not be read: ${why}. Check your wallet before swapping again.`, 'err', true);
    else say(e?.html ? e.message : why, 'err', true);
  } finally {
    paced(''); S.busy = false; changed(); paint(); H.onDone?.();
    if (!S.q) requote(true);
    PV?.read(true).then(paint, () => {});
    readBalances().then(paintSides, () => {});
  }
}

let pkClose = null, pkIO = null;
const ATK = /^@(pay|btc|defi|wallet|chain):(.+)$/;
let PKKIND = null;
function openPicker(side, again = false) {
  pkClose?.({ keep: true });
  if (!again) PKKIND = null;
  if (!TL.at) loadList().then(() => {
    if ($('#pk').hidden || !TL.rows.length) return;
    const a = document.activeElement, v = $('#pk-q')?.value || '', k = $('#pk').contains(a) ? (a.id === 'pk-q' ? 'q' : a.dataset?.k || (a.classList.contains('pk-x') ? 'x' : '')) : '';
    openPicker(side, true);
    // a search typed before the full list arrived is run again over it
    const qe = $('#pk-q');
    if (v && qe) { qe.value = v; qe.oninput?.(); }
    if (k) setTimeout(() => (k === 'q' ? qe : k === 'x' ? $('#pk .pk-x') : $(`#pk [data-k="${k}"]`))?.focus(), 0);
  });
  const pk = $('#pk'), at = atOf(side), cur = side === 'pay' ? S.pay : S.get;
  const wl = held(listed().map((t) => t.addr)), top = wl.filter((k) => tacitPooled(k) || S.bal[k] > 0n), rest = wl.filter((k) => !top.includes(k));
  const groups = [['Wallet', top, 'wallet', 'wallet'], ['Private', [...POOL_COINS.map((k) => `@defi:${k}`), ...(moving() ? placeCoins(side, 'pay').map((k) => `@pay:${k}`) : []), ...placeCoins(side, 'chain').map((k) => `@chain:${k}`)], 'private', 'defi'],
    ...(moving() ? [['Bitcoin', placeCoins(side, 'btc').map((k) => `@btc:${k}`), 'bitcoin', 'btc']] : []),
    [FLOW === 'shield' ? 'More tokens, sold for ETH on the way in' : 'More tokens', rest, 'wallet', 'more']].map((g) => (FLOW ? [g[0], g[1].filter((key) => { const m = ATK.exec(key); return !!flowGet(m ? m[2] : key, m ? m[1] : 'wallet'); }), g[2], g[3]] : g)).filter(([, ks]) => ks.length);
  const kinds = ['wallet', 'private', 'bitcoin'].filter((kd) => groups.some((g) => g[2] === kd));
  const first = KIND[PKAT || at];
  let kind = again && kinds.includes(PKKIND) ? PKKIND : kinds.includes(first) ? first : kinds[0];
  PKKIND = kind;
  const keys = groups.flatMap(([, ks]) => ks), cs = H.moves?.chains?.() || [], chains = cs.length;
  const SUB = { teth: 'ETH, made private', [lc(R.TAC)]: 'Tacit’s token', [lc(R.CUSD)]: 'a dollar borrowed against cBTC', [lc(R.CBTC)]: 'bitcoin, 1:1 with BTC' };
  const PLACE_TAG = { wallet: 'Public', defi: moving() ? 'DeFi pool' : 'Private', pay: moving() ? 'Pay pool' : 'Private', chain: 'Tacit chain', btc: 'Bitcoin' };
  const row = (key) => {
    const m = ATK.exec(key), a = m ? m[1] : 'wallet', k = m ? m[2] : key, t = shownAt(k, a);
    if (!t) return null;
    const ok = !moving() || (side === 'pay' ? goes('pay', k, a) : pairOk(S.pay, atOf('pay'), k, a));
    const twin = moving() && (k === 'teth' || k === lc(R.TAC) || isEth(k));
    const sub = a === 'defi' ? `${esc(SUB[k] || '')}${twin ? `<span class="pk-tw">${SUB[k] ? ' · ' : ''}swap, farm, borrow</span>` : ''}`
      : a === 'pay' ? `${isEth(k) ? 'private ETH' : k === USDC_K || k === USDT_K ? 'a private dollar' : 'private TAC'} · pay anyone on ${isEth(k) && chains > 1 ? chainMarks(cs) : 'Ethereum'}`
      : a === 'chain' ? 'private TAC · on the Tacit chain' : a === 'btc' ? 'at your Bitcoin address' : esc((t.custom ? `${t.addr.slice(0, 8)}…${t.addr.slice(-6)}` : t.name) || '');
    return { ok, at: a, html: `<button type="button" class="pk-r${ok ? '' : ' off'}"${ok ? '' : ' aria-disabled="true"'} data-k="${esc(key)}" data-kind="${KIND[a]}"${KIND[a] === kind ? '' : ' hidden'}${moving() && a !== 'wallet' ? ` title="${esc(PLACE_TIP[a] || '')}"` : ''} aria-current="${a === at && k === cur}">${coin(t, '', a === 'wallet')}<span><b>${esc(t.sym)}<i class="pk-t pk-t-${a}" data-t="${PLACE_TAG[a]}"></i></b><small>${sub}</small></span><em>${rowBal(side, key)}</em></button>` };
  };
  warmPrivate(); H.moves?.warm?.();
  pkSide = side;
  const title = side === 'pay' ? (moving() ? 'From' : 'Pay with') : moving() ? 'To' : 'Get', noted = new Set();
  const list = groups.map(([g, ks, kd, id]) => {
    const rs = ks.map(row).filter(Boolean), hide = kd === kind ? '' : ' hidden', ordered = (xs) => [...xs.filter((r) => r.ok), ...xs.filter((r) => !r.ok)].map((r) => r.html).join('');
    const homes = kd === 'private' && moving() ? [['defi', 'Swap, farm, borrow'], ['pay', 'Pay anyone'], ['chain', 'Tacit chain']].filter(([h]) => rs.some((r) => r.at === h)) : [], split = homes.length > 1;
    const rows = split ? homes.map(([h, label]) => `<p class="pk-sub" data-kind="${kd}"${hide}>${label}</p>${ordered(rs.filter((r) => r.at === h))}`).join('') : ordered(rs);
    const note = kd === 'private' ? (moving() ? (split ? 'Held privately.' : 'Held privately. Swap, farm and borrow, or pay anyone.') : 'Held privately in Tacit’s pool, to swap, farm and borrow with.') : KIND_NOTE[kd];
    return `<p class="pk-g${id === 'more' ? '' : ' kh'}" data-g="${id}" data-kind="${kd}"${hide}>${esc(g)}</p>${noted.has(kd) ? '' : (noted.add(kd), `<p class="pk-d" data-kind="${kd}"${hide}>${esc(note)}</p>`)}${rows}`;
  }).join('');
  const kindBtn = (kd) => `<button type="button" role="radio" data-kind="${kd}" aria-checked="${kd === kind}" tabindex="${kd === kind ? 0 : -1}" title="${esc(KIND_TIP[kd])}">${kd === 'wallet' ? WALLET_MARK : kd === 'bitcoin' ? placeMark('btc') : '<span class="lock" aria-hidden="true"></span>'}${KIND_NAME[kd]}</button>`;
  pk.innerHTML = `<div class="pk-s" role="dialog" aria-modal="true" aria-label="${title}"><div class="pk-h"><b>${title}</b><button type="button" class="pk-x" aria-label="Close">×</button></div>${FLOW !== 'withdraw' && keys.some((k) => !inPool(k) && !/^@/.test(k)) ? '<input class="pk-q" id="pk-q" placeholder="Search tokens, or paste an address" autocomplete="off" spellcheck="false" aria-label="Search tokens or paste an address">' : ''}${kinds.length > 1 ? `<div class="pk-kind" id="pk-kind" role="radiogroup" aria-label="Where it is held">${kinds.map(kindBtn).join('')}</div>` : ''}<div class="pk-l" id="pk-l">${list}<p class="pk-n" id="pk-n"></p></div></div>`;
  pk.hidden = false;
  if ($('#pk-kind')) arrows($('#pk-kind'), 'data-kind');
  pkIO?.disconnect();
  pkIO = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const i = e.target; i.src = i.dataset.src; i.removeAttribute('data-src'); pkIO.unobserve(i); } }, { root: $('#pk-l'), rootMargin: '160px 0px' });
  for (const i of pk.querySelectorAll('img[data-src]')) pkIO.observe(i);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...pk.querySelectorAll('button, input')].filter((x) => !x.hidden), a = document.activeElement;
    if (!f.length) return;
    if (e.shiftKey ? a === f[0] || !pk.contains(a) : a === f[f.length - 1] || !pk.contains(a)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
  };
  const away = (e) => { if (!pk.contains(e.target)) close({ quiet: true }); };
  const close = ({ keep = false, quiet = false } = {}) => { if (!keep) { pkIO?.disconnect(); pkIO = null; PKAT = null; } document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', away, true); if (pkClose === close) pkClose = null; if (keep) return; pk.hidden = true; pk.innerHTML = ''; if (!quiet) $(side === 'pay' ? '#pay-coin' : '#get-coin').focus(); };
  document.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', away, true);
  pkClose = close;
  const applyKind = (kd) => {
    kind = PKKIND = kd;
    for (const el of pk.querySelectorAll('#pk-l [data-kind]')) el.hidden = el.dataset.kind !== kd;
    for (const b of pk.querySelectorAll('#pk-kind [data-kind]')) { const on = b.dataset.kind === kd; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    $('#pk-l').scrollTop = 0;
  };
  pk.querySelector('.pk-x').onclick = () => close();
  pk.onclick = (e) => {
    if (e.target === pk) return close();
    const kb = e.target.closest('#pk-kind [data-kind]');
    if (kb) { applyKind(kb.dataset.kind); return; }
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (b.dataset.add) { const t = JSON.parse(b.dataset.add); S.custom = [t, ...S.custom.filter((x) => x.addr !== t.addr)].slice(0, 20); try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(S.custom)); } catch { } readBalances().then(paintSides); }
    const m = ATK.exec(k);
    pickAt(side, m ? m[1] : 'wallet', m ? m[2] : k); close();
  };
  const qEl = $('#pk-q');
  if (qEl) {
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); [...pk.querySelectorAll('.pk-r')].filter((b) => !b.hidden && !b.closest('[hidden]')).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))[0]?.click(); } });
    let seq = 0, words = null;
    qEl.oninput = async () => {
      const v = qEl.value.trim(), my = ++seq, l = $('#pk-l');
      const x = v.toLowerCase(), on = !!v && !/^0x/i.test(v);
      words ||= [...l.querySelectorAll('.pk-r')].map((b) => { const t = tokenOf(String(b.dataset.k).replace(ATK, '$2')); return { b, sy: t ? [lc(t.sym), lc(t.psym || '')] : null, nm: lc(t?.name || '') }; });
      for (const { b, sy, nm } of words) {
        const rank = !sy ? 0 : sy.includes(x) ? 1 : sy.some((y) => y && y.startsWith(x)) ? 2 : nm.startsWith(x) ? 3 : `${sy.join(' ')} ${nm}`.includes(x) ? 4 : 0;
        b.hidden = on && !rank; b.style.order = on ? rank : '';
      }
      l.querySelectorAll('.pk-g, .pk-d, .pk-sub').forEach((g) => { g.hidden = on; });
      l.classList.toggle('srch', on);
      l.classList.toggle('one', new Set([...l.querySelectorAll('.pk-r[data-kind]')].filter((b) => !b.hidden).map((b) => b.dataset.kind)).size < 2);
      const kc = $('#pk-kind'); if (kc) kc.hidden = on;
      if (!on) applyKind(kind);
      l.querySelector('[data-add]')?.remove();
      $('#pk-n').textContent = on && words.every(({ b }) => b.hidden) ? `Nothing matches “${v.slice(0, 24)}”. Paste a token’s address to add it.` : /^0x/i.test(v) && !/^0x[0-9a-fA-F]{40}$/.test(v) ? 'Paste the whole address: 0x and 40 characters.' : '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return;
      const k = lc(v);
      if (tokenOf(k)) { l.querySelectorAll('.pk-r').forEach((b) => { b.hidden = b.dataset.k !== k; }); return; }
      l.querySelectorAll('.pk-r:not([data-add])').forEach((b) => { b.hidden = true; });
      $('#pk-n').textContent = 'Reading the token…';
      const t = await R.readToken({ ethCall, keccak256: keccak_256, address: k }).catch(() => null);
      if (my !== seq) return;
      if (!t) { $('#pk-n').textContent = 'No token at that address on Ethereum.'; return; }
      const add = { addr: k, sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true };
      $('#pk-n').insertAdjacentHTML('beforebegin', `<button type="button" class="pk-r" data-k="${esc(k)}" data-add="${esc(JSON.stringify(add))}">${letter(add, '')}<span><b>${esc(t.sym)}</b><small>${esc(t.name)}</small></span><em>Add</em></button>`);
      $('#pk-n').textContent = 'Check the address: anyone can make a token with any name.';
    };
  }
  { const l = $('#pk-l'), c = [...pk.querySelectorAll('.pk-r[aria-current="true"]')].find((b) => !b.hidden); if (c && c.offsetTop - l.offsetTop > l.clientHeight * .6) l.scrollTop = c.offsetTop - l.offsetTop - l.clientHeight / 3; }
  const touch = matchMedia('(pointer: coarse)').matches, seen = (sel) => [...pk.querySelectorAll(sel)].find((b) => !b.hidden);
  setTimeout(() => ((touch ? null : qEl) || seen('.pk-r[aria-current="true"]') || seen('.pk-r'))?.focus(), 0);
}
let pkSide = null;
let PKAT = null;
function rowBal(side, key) {
  const m = ATK.exec(key), a = m ? m[1] : 'wallet', k = m ? m[2] : key, t = shownAt(k, a);
  const bal = side === 'pay' && moving() ? H.moves?.held?.(k, a) ?? (a === 'wallet' ? S.bal[k] : null) : a === 'wallet' ? S.bal[k] : a === 'defi' ? privBal(k) : a === 'chain' ? H.moves?.held?.(k, a) ?? null : null;
  return bal ? esc(amtFmt(bal, t?.dec ?? 18)) : side === 'pay' && moving() && H.moves?.loading?.(k, a) ? '<span class="pk-rd" aria-label="reading">…</span>' : '';
}
function pickerBals() {
  const pk = $('#pk');
  if (!pk || pk.hidden || !pkSide) return;
  for (const b of pk.querySelectorAll('.pk-r[data-k]')) { if (b.dataset.add) continue; const em = b.querySelector('em'), v = rowBal(pkSide, b.dataset.k); if (em && em.innerHTML !== v) em.innerHTML = v; }
}
const POP = ['USDe', 'cbBTC', 'LINK', 'UNI', 'AAVE', 'PEPE', 'ENA', 'LDO', 'ONDO', 'SKY', 'MKR', 'weETH', 'cbETH', 'ARB', 'SHIB', 'CRV', 'PENDLE', 'ENS', 'COMP', 'GHO', 'crvUSD', 'PYUSD', 'EIGEN', 'ETHFI', 'SNX', 'GRT', 'RPL', 'FET', 'IMX', 'POL', 'APE', 'WLD', 'MORPHO', 'SUSHI', 'YFI', 'BAL', 'CVX', '1INCH'];
const famed = (k) => { const t = listedAt(k); if (!t?.uni) return 0; const j = POP.indexOf(t.sym); return j < 0 ? POP.length + 1 : j + 1; };
const held = (ks) => ks.map((k, i) => ({ k, i, v: S.bal[k] ? (usdOf(k, S.bal[k]) ?? 1e-9) : 0, f: famed(k) })).sort((a, b) => b.v - a.v || a.f - b.f || a.i - b.i).map((x) => x.k);
const defaultFor = (k) => (isEth(k) ? lc(R.TAC) : tacitKey(k) ? lc(R.ZERO) : lc(R.TAC));
function keepAmt(change) { const was = S.pay; change(); if (S.pay !== was) S.amt = ''; S.note = ''; }
function choose(side, k) {
  if (S.busy) return;
  const m = moving() && ATK.exec(k);
  if (FLOW) {
    const at = m ? m[1] : 'wallet', real = m ? m[2] : k, was = S.pay;
    if (side !== 'pay' || !flowGet(real, at)) return;
    setAt('pay', at); S.pay = real; flowFit(); clearTo();
    if (!sameCoin(was, real)) S.amt = '';
    if (at === 'defi') { warmPrivate(); privUp(); }
    S.note = ''; S.q = null; S.mq = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
    return;
  }
  if (m || S.at.pay || S.at.get) {
    const at = m ? m[1] : S.at[side] === 'pay' || S.at[side] === 'btc' || S.at[side] === 'chain' ? (inPool(k) ? 'defi' : 'wallet') : atOf(side), real = m ? m[2] : k, was = side === 'pay' ? S.pay : S.get;
    const back = { at: { ...S.at }, inP: S.inP, outP: S.outP, pay: S.pay, get: S.get, later: LATER.on };
    setAt(side, at); if (side === 'pay') S.pay = real; else S.get = real;
    if (!mend(side)) { Object.assign(S, { at: back.at, inP: back.inP, outP: back.outP, pay: back.pay, get: back.get }); LATER.on = back.later; return; }
    if (side === 'get') clearTo();
    if (LATER.on) laterUp();
    if (!sameCoin(back.pay, S.pay)) S.amt = '';        // the amount is in the From coin, which a To pick can change too (mend)
    S.amt = fitAmt(S.amt);
    if (at === 'defi') { warmPrivate(); privUp(); }
    S.note = ''; S.q = null; S.mq = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
    return;
  }
  keepAmt(() => { if (side === 'pay') { S.pay = k; fit('pay'); } else { S.get = k; fit('get'); } });
  S.q = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
}


async function readFarms() {
  const [prog, f, spot] = await Promise.all([api('/farm/program?network=mainnet'), readPrecision(({ to, data }) => ethCall(to, data)), readSpot(batch)]);
  const out = [{ k: 'precision', name: 'Precision farm', note: 'public', apr: f?.apr ?? null, icons: ['tac', 'eth'] }];
  for (const p of privateFarms(prog, f?.tacEth || 0, { ethUsd: spot.ethUsd ?? S.px.ethUsd, btcUsd: spot.btcUsd ?? S.px.btcUsd })) out.push({ k: `p${p.pid}`, pid: p.pid, name: p.name, note: 'private', apr: p.apr, icons: p.icons });
  S.farms = out;
}

function params() {
  const p = new URLSearchParams(), sym = (k) => { const t = tokenOf(k); return t?.custom || (t?.addr && listed().filter((x) => nameIs(x, lc(t.sym))).length > 1) ? t.addr : t?.sym; };
  if (S.btc && !moving()) return p;
  if (S.pay !== lc(R.ZERO)) p.set('from', sym(S.pay));
  if (S.get !== lc(R.TAC) || S.inP || getPriv()) p.set('to', sym(S.get));      // read back with no To, a private pair gives tETH
  if (S.amt) p.set('amt', S.amt);
  if (S.inP || getPriv()) p.set('private', S.inP && S.outP ? 'both' : S.inP ? 'from' : 'to');
  if (S.at.pay) p.set('from-at', S.at.pay);
  if (S.at.get) p.set('to-at', S.at.get);
  return p;
}
function applyParams(p) {
  const find = (v) => { if (!v) return null; const x = linkName(v); return x === 'teth' ? 'teth' : (listed().find((t) => nameIs(t, x) || t.addr === x)?.addr) || null; };
  const pv = p.get('private'), f = find(p.get('from')), t = find(p.get('to'));
  const fa = p.get('from-at'), ta = p.get('to-at');
  const AT = ['pay', 'btc', ...(onChain() ? ['chain'] : [])];
  if (moving() && (AT.includes(fa) || AT.includes(ta))) {
    setAt('pay', AT.includes(fa) ? fa : pv === 'from' || pv === 'both' ? 'defi' : 'wallet');
    setAt('get', AT.includes(ta) ? ta : pv === 'to' || pv === 'both' ? 'defi' : 'wallet');
    S.pay = coinAt(f || lc(R.ZERO), atOf('pay')); S.get = coinAt(t || lc(R.TAC), atOf('get'));
    if (!mend('pay')) { setAt('pay', 'wallet'); setAt('get', 'wallet'); S.pay = lc(R.ZERO); S.get = lc(R.TAC); return; }
    const a = p.get('amt');
    if (a && parseUnits(a, tokenOf(S.pay)?.dec ?? 18)) S.amt = fitAmt(a);
    return;
  }
  const sides = linkSides({ pv, fromName: p.get('from'), toName: p.get('to'), fromKey: f }, { notes: new Set(listed().filter((x) => x.psym).map((x) => lc(x.psym))), isEth });
  if (sides?.inP !== undefined) S.inP = sides.inP;
  if (sides?.outP !== undefined) S.outP = sides.outP;
  const side = (k, priv) => (priv ? (isEth(k) ? 'teth' : k) : k === 'teth' ? lc(R.ZERO) : k);
  if (f) S.pay = side(f, S.inP); else if (S.inP) S.pay = 'teth';
  if (t) S.get = side(t, S.outP); else if (S.outP) S.get = S.pay === 'teth' ? lc(R.TAC) : 'teth';
  if (S.outP && t && !inPool(S.get)) { const r = outRoute(S.get); if (r) { S.outP = false; if (r === 'later') LATER.on = true; } }
  if (!kindOf(S.pay, S.get)) fit(t ? 'get' : 'pay');
  const a = p.get('amt');
  if (p.get('to') && !t) { S.note = { h: 'That token is not in the list, so the card opened on its default pair. Paste its address in the Get picker to add it.', cls: '' }; return; }
  if (a && (f ? S.pay === side(f, S.inP) : !p.get('from')) && parseUnits(a, tokenOf(S.pay).dec)) S.amt = fitAmt(a);
}
let ASKED = null;
function load(p, { fresh = true } = {}) {
  if (S.busy) return false;
  if (fresh) { S.inP = false; S.outP = false; S.at = { pay: null, get: null }; S.mq = null; S.pay = lc(R.ZERO); S.get = lc(R.TAC); S.amt = ''; LATER.on = false; clearTo(); }
  S.note = ''; applyParams(p);
  if (FLOW && !flowFit()) { S.inP = false; S.outP = false; S.at = { pay: null, get: null }; S.amt = ''; applyParams(new URLSearchParams(FLOW_PAIR[FLOW])); flowFit(); }
  ASKED = { p, pair: `${S.pay}>${S.get}` };
  S.q = null; S.pick = null; S.hold = false; S.ack = false;
  const named = [p.get('from'), p.get('to')].filter((v) => v && !/^0x/i.test(v)), mine = `${S.pay}>${S.get}:${S.amt}:${S.inP}${S.outP}`;
  if (named.some((v) => !listed().some((t) => nameIs(t, linkName(v))) && linkName(v) !== 'teth')) loadList().then(() => { if (ASKED?.p !== p || S.busy || `${S.pay}>${S.get}:${S.amt}:${S.inP}${S.outP}` !== mine) return; const was = `${S.pay}>${S.get}:${S.inP}${S.outP}`; S.note = ''; applyParams(p); if (`${S.pay}>${S.get}:${S.inP}${S.outP}` !== was) { S.q = null; changed(); paint(); readBalances().then(paintSides); if (S.amt || moveOf()) requote(true); else syncMove(); } });
  const f = p.get('from');
  const pair0 = ASKED.pair, amt0 = S.amt;
  if (/^0x[0-9a-fA-F]{40}$/.test(f || '') && !tokenOf(lc(f))) R.readToken({ ethCall, keccak256: keccak_256, address: lc(f) }).then((t) => {
    if (!t || ASKED?.p !== p) return;
    S.custom = [{ addr: lc(f), sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true }, ...S.custom].slice(0, 20);
    if (`${S.pay}>${S.get}` !== pair0 || S.amt !== amt0) { paint(); return; }
    S.inP = false; S.pay = lc(f); if (!kindOf(S.pay, S.get)) S.get = lc(R.TAC);
    const a = p.get('amt'); if (a && parseUnits(a, t.dec)) S.amt = fitAmt(a);
    paint(); readBalances().then(paintSides); if (S.amt) requote(true);
  }).catch(() => {});
  if ([S.pay, S.get].some((k) => { const t = tokenOf(k); return t && !SPRITE.has(t.icon) && !LOGO[k]; })) loadList();
  if (S.inP || S.outP) { warmPrivate(); farmsSoon(); privUp(); }
  if (hidden()) laterUp();
  paint(); changed();
  if (S.amt || moveOf()) requote(true); else syncMove();
  return true;
}

function setFlowNow(f) { FLOW = f; ROOT.classList.toggle('flow', !!f); ROOT.dataset.flow = f || ''; }
let FLOW_WANT, flowWait = 0;
function setFlow(f) {
  f = f === 'shield' || f === 'withdraw' ? f : null;
  if (S.busy) {
    FLOW_WANT = f === FLOW ? undefined : f;
    if (FLOW_WANT !== undefined && !flowWait) flowWait = setInterval(() => {
      if (S.busy) return;
      clearInterval(flowWait); flowWait = 0;
      const w = FLOW_WANT; FLOW_WANT = undefined;
      if (w !== undefined && w !== FLOW) { if (H.onIdle) H.onIdle(); else setFlow(w); }
    }, 400);
    return;
  }
  FLOW_WANT = undefined;
  if (f === FLOW) return;
  setFlowNow(f);
  if (!f) return;
  if ((f === 'shield' && atOf('pay') !== 'wallet') || !flowFit()) { load(new URLSearchParams(FLOW_PAIR[f])); return; }
  S.amt = fitAmt(S.amt);
  S.q = null; S.mq = null; changed(); paint(); requote(true);
}
function slipPaint() { $('#slip').innerHTML = [10, 50, 100, 300].map((b) => `<button type="button" data-slip="${b}" aria-pressed="${S.slip === b}">${b / 100}%</button>`).join(''); }
const farmsSoon = () => { if (!S.farms) readFarms().then(() => { if ((S.inP || S.outP) && S.q?.pools) paintQuote(); }, () => {}); };
let lane = null, laneP = null;
const pageWallet = () => (W.account && W.prov && !W.prov.isWalletConnect ? { uuid: W.uuid, address: W.account } : null);
async function openLane() {
  try {
    laneP ||= import('/swap/bitcoin.js?cb=fe20f39e').then((mod) => (lane = mod.makeBitcoinLane({ host: $('#btc'), notify: (m) => live(m), wallet: pageWallet, onBridged: paintNudge, from: moving() && S.pay === lc(R.TAC) ? 'tac' : 'teth' })));
    await laneP;
    if (S.btc) await lane.show();
  } catch (e) { $('#btc').innerHTML = `<p class="q err">Could not load the Bitcoin lane: ${esc(e?.message || e)}</p>`; lane = laneP = null; }
}
function setBtc(on) {
  if (S.btc === on || !$('#btc')) return;
  S.btc = on; changed(); paint();
  if (on) openLane(); else lane?.hide();
}
function arrows(box, attr) {
  box.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    const rs = [...box.querySelectorAll('[role="radio"]:not(:disabled)')], i = rs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = rs[(i + d + rs.length) % rs.length], k = next.getAttribute(attr);
    next.click();
    ([...box.querySelectorAll(`[${attr}]`)].find((x) => x.getAttribute(attr) === k) || next).focus();
  });
}

const side = (s) => `<span class="where" id="${s}-at"></span>`;
const CP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const markup = (o) => `<p class="sr" id="sw-live" role="status" aria-live="polite"></p>
  ${o.lane === false ? '' : `<div class="mode" role="radiogroup" aria-label="Chain">
    <button type="button" role="radio" data-mode="wallet" aria-checked="true"><svg class="tk" aria-hidden="true"><use href="#c-eth"/></svg>Ethereum</button>
    <button type="button" role="radio" data-mode="bitcoin" aria-checked="false" aria-label="On Bitcoin" title="On Bitcoin"><svg class="tk" aria-hidden="true"><use href="#c-btc"/></svg></button>
  </div>
  <div id="btc" hidden></div>`}
  <div class="f" id="f-pay">
    <div class="fh"><span>${o.moves ? 'From' : 'You pay'}</span>${side('pay')}</div>
    <div class="fm"><input class="amt" id="amt" inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false" aria-label="Amount to pay"><button class="coin" id="pay-coin" type="button" aria-haspopup="dialog" aria-label="Pay with ETH"></button></div>
    <div class="ff"><span id="pay-usd" class="num"></span><span id="pay-side"></span></div>
  </div>
  <div class="mid"><button class="flip" id="flip" type="button" aria-label="Swap the two sides"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v17m0 0-4-4m4 4 4-4M16 21V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
  <div class="f" id="f-get">
    <div class="fh"><span>${o.moves ? 'To' : 'You get'}</span>${side('get')}</div>
    <div class="fm"><output class="big ph num" id="out" for="amt">0</output><button class="coin" id="get-coin" type="button" aria-haspopup="dialog" aria-label="Get TAC"></button></div>
    <div class="ff"><span id="get-usd" class="num"></span><span class="ffr"><span id="get-side"></span><button class="where" id="get-where" type="button" aria-expanded="false" aria-controls="to">to your wallet</button></span></div>
    <div class="to" id="to" hidden><input id="to-in" type="text" inputmode="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Send to another address" placeholder="Send to another address, 0x…"><small id="to-note" role="status"></small></div>
  </div>
  ${o.moves ? '<div class="rows" id="homes" role="radiogroup" aria-label="Private in" hidden></div><label class="hx-chain" id="chain" hidden></label>' : ''}
  <div class="rows" id="rows" role="radiogroup" aria-label="Route" hidden></div>
  <dl class="rcpt" id="rcpt" hidden></dl>
  ${o.moves ? '<div class="hx-pts" id="hx-pts" hidden></div><div class="hx-have" id="hx-have" hidden></div>' : ''}
  <div class="later" id="later" hidden></div>
  <div class="act">
    <div id="ackbox"></div>
    <button class="go" id="go" type="button" disabled>Enter an amount</button>
    <p class="q" id="q" role="status"></p>
    ${o.moves ? '<div class="mv-st" id="mv-st"></div><p class="flow-tip" id="flow-tip" hidden></p>' : ''}
    ${o.moves ? `<button class="cp" id="copy" type="button" title="Copy link" aria-label="Copy link" hidden>${CP_ICON}</button>` : ''}
  </div>
  <div class="sw-foot"><span>Slippage</span><span class="slip" id="slip" role="group" aria-label="Slippage"></span></div>
  <div class="steps" id="steps" hidden></div>
  ${o.recent === false ? '' : '<details class="recent" id="recent" hidden><summary>Recent swaps</summary><ol id="recent-l"></ol></details>'}
  <div class="pk" id="pk" hidden></div>`;

function wire() {
  $('#later').addEventListener('click', (e) => {
    const via = e.target.closest('[data-via]');
    if (via && !via.disabled) { LATER.via = via.dataset.via; paint(); return; }
    const dg = e.target.closest('[data-dg]');
    if (dg && !dg.disabled) { LATER.dgas = dg.dataset.dg; LATER.dgasTok = S.pay; paint(); return; }
    if (e.target.closest('[data-open-pool]')) { openPoolGo(); return; }
    if (!e.target.closest('#later-on')) return;
    hopSet(!LATER.on);
  });
  $('#later').addEventListener('input', (e) => { if (e.target.id === 'later-x') { LATER.pct = Number(e.target.value); paintQuote(); } });
  $('#later').addEventListener('change', (e) => { if (e.target.id === 'later-x') { LATER.rand = Math.random(); paintQuote(); } });
  $('#steps').addEventListener('click', stepsClick);
  $('#slip').addEventListener('click', (e) => { const b = e.target.closest('[data-slip]'); if (!b) return; S.slip = Number(b.dataset.slip); try { localStorage.setItem(SLIP_KEY, String(S.slip)); } catch { } slipPaint(); if (S.q) requote(true); else paintQuote(); });
  $('#amt').addEventListener('input', (e) => { S.amt = fitAmt(e.target.value.trim()); S.note = ''; fitSize(e.target); changed(); paintSides(); requote(); });
  $('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
  ROOT.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
  $('#pay-coin').addEventListener('click', () => { PKAT = null; openPicker('pay'); });
  for (const id of ['#pay-coin', '#get-coin', '#amt']) for (const ev of ['pointerenter', 'focus', 'touchstart']) $(id).addEventListener(ev, () => { loadList(); }, { once: true, passive: true });
  $('#get-coin').addEventListener('click', () => { if (FLOW) return; PKAT = null; openPicker('get'); });
  for (const s of ['pay', 'get']) {
    const open = () => { if (!moving() || S.busy || (FLOW && s === 'get')) return; PKAT = atOf(s); openPicker(s); };
    $(`#${s}-at`).addEventListener('click', open);
    $(`#${s}-at`).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
  $('#flip').addEventListener('click', () => {
    if (S.busy) return;
    if (placed()) {
      const pa = atOf('pay'), ga = atOf('get'), [p, g] = [S.pay, S.get];
      if (!pairOk(g, ga, p, pa)) return;
      setAt('pay', ga); setAt('get', pa); S.pay = g; S.get = p; S.q = null; S.mq = null; S.note = ''; clearTo(); if (!sameMoney(p, g) || tokenOf(p)?.dec !== tokenOf(g)?.dec) S.amt = '';
      if (FLOW) { setFlowNow(FLOW === 'shield' ? 'withdraw' : 'shield'); H.onFlow?.(FLOW); }
      changed(); paint(); requote(true);
      return;
    }
    if (!kindOf(S.get, S.pay)) return;
    const r = picked(), out = r && !S.q?.busy ? tidy(plain(r.out, tokenOf(S.get).dec)) : '', [p, g] = [S.pay, S.get], keep = sameMoney(p, g) && tokenOf(p)?.dec === tokenOf(g)?.dec;
    [S.pay, S.get] = [g, p]; S.note = '';
    S.amt = out ? tidy(out.replace(/(\.\d{8})\d+$/, '$1')) : keep ? S.amt : ''; S.q = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
  });
  $('#get-where').addEventListener('click', () => { S.toOpen = !S.toOpen; paintSides(); if (S.toOpen) $('#to-in').focus(); });
  let tacitT = 0;
  $('#to-in').addEventListener('input', (e) => {
    S.note = '';
    const raw = e.target.value.trim();
    if (!S.outP && !(laterPool() && raw && !/^0x/i.test(raw))) {
      clearTimeout(tacitT); S.toTacit = null; S.toTacitBad = ''; S.toTacitBusy = false; S.toName = null; S.toBusy = false;
      if (!isName(raw)) { const r = recipientOf(raw); S.to = r.addr; S.toBad = r.bad; if (S.to) proverSoon(); paint(); return; }
      S.to = null; S.toBad = ''; S.toBusy = true;
      tacitT = setTimeout(async () => {
        let to = null, bad = '';
        let name = null;
        try { const r = await (await names()).resolveAddress(raw); if (!r) bad = `${raw} does not point at an address.`; else { const v = recipientOf(r.address); to = v.addr; bad = v.bad; if (to) name = { name: r.name, addr: to }; } }
        catch (err) { bad = String(err?.message || err).slice(0, 200); }
        if ($('#to-in').value.trim() !== raw) return;
        S.to = to; S.toBad = bad; S.toName = name; S.toBusy = false; if (S.to) proverSoon(); paint();
      }, 400);
      paint(); return;
    }
    S.to = null; S.toBad = '';
    clearTimeout(tacitT); S.toTacit = null; S.toTacitBad = ''; S.toTacitBusy = !!raw; S.toName = null; S.toBusy = false;
    if (raw) tacitT = setTimeout(async () => {
      try { const r = await (await pvLoad()).mod.resolveTacit(raw); if ($('#to-in').value.trim() === raw) { S.toTacit = { raw, pubHex: r.pubHex, name: r.name || null }; proverSoon(); } }
      catch (err) { if ($('#to-in').value.trim() === raw) S.toTacitBad = String(err?.message || err).slice(0, 200); }
      finally { if ($('#to-in').value.trim() === raw) { S.toTacitBusy = false; paint(); } }
    }, 400);
    paint();
  });
  $('#to-in').addEventListener('keydown', (e) => { if (e.key === 'Escape') { S.toOpen = false; paintSides(); $('#get-where').focus(); } });
  $('#go').addEventListener('click', go);
  $('#homes')?.addEventListener('click', (e) => { const b = e.target.closest('[data-home]') || (!HOMES_OPEN && e.target.closest('.chg') ? $('#homes [data-home]') : null); if (!b) return; if (!HOMES_OPEN && !$('#homes [data-open]')) { HOMES_OPEN = true; paint(); return; } HOMES_OPEN = false; if (b.dataset.home === atOf('get')) paint(); else setHome(b.dataset.home); });
  if ($('#homes')) arrows($('#homes'), 'data-home');
  $('#chain')?.addEventListener('change', (e) => {
    if (e.target.id !== 'chain-sel') return;
    H.moves.setChain(Number(e.target.value)); mend(atOf('pay') === 'pay' ? 'pay' : 'get');
    S.mq = null; changed(); paint(); requote(true); $('#chain .np-b')?.focus();
  });
  $('#rows').addEventListener('click', (e) => { if (e.target.closest('[data-routes-all]')) { S.routesAll = `${S.pay}>${S.get}`; paintQuote(); $('#rows [aria-checked="true"]')?.focus(); return; } const b = e.target.closest('[data-route]'); if (!b) return; S.pick = b.dataset.route; S.hold = true; S.ack = false; S.ackKey = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; paintQuote(); });
  ROOT.addEventListener('click', (e) => {
    if (e.target.closest('[data-px-flip]')) { S.pxFlip = !S.pxFlip; paintQuote(); $('#rcpt [data-px-flip]')?.focus(); return; }
    if (e.target.closest('[data-stage]')) { stageGo(); return; }
    const q = e.target.closest('[data-quick]');
    if (q) { S.amt = q.dataset.quick; S.note = ''; changed(); paintSides(); requote(true); return; }
    const mk = e.target.closest('#max') && moveOf();
    if (mk && H.moves.most) { H.moves.most(mk).then((v) => { if (v == null || moveOf() !== mk) return; S.amt = v; S.note = ''; changed(); paintSides(); requote(true); }, () => {}); return; }
    if (e.target.closest('#copy')) { const u = shareLink(); if (u) H.copy(u, 'Link copied'); return; }
    if (e.target.closest('#max') && S.inP && PV) {
      const was = S.pay, k = PK[S.pay], same = `${S.get}${S.inP}${S.outP}${LATER.on}`;
      PV.most(IDS[k], POOL_TK[k]).then((v) => { if (v == null || S.pay !== was || `${S.get}${S.inP}${S.outP}${LATER.on}` !== same) return; S.amt = tidy(plain(v, 8)); S.note = ''; changed(); paintSides(); requote(true); }, () => {});
      return;
    }
    if (e.target.closest('#max') && exiting() && !exitOf().wallet) {
      const was = S.pay, bal = H.moves?.held?.(S.pay, 'pay'), same = `${S.get}${S.inP}${S.outP}${LATER.on}`;
      if (bal != null) exitPool(was).then(async (p) => { if (S.pay !== was || `${S.get}${S.inP}${S.outP}${LATER.on}` !== same || !exiting() || p.fee == null) return; const v = (await ltLoad()).mod.heldSwapMax(bal, p.fee); S.amt = v > 0n ? tidy(fitAmt(plain(v, tokenOf(was).dec))) : ''; S.note = v > 0n ? '' : { h: 'The relay’s fee takes all of this balance, so there is nothing to swap out.', cls: '' }; changed(); paintSides(); requote(true); }, () => {});
      return;
    }
    if (e.target.closest('#max')) {
      const t = tokenOf(S.pay), bal = S.at.pay ? H.moves?.held?.(S.pay, S.at.pay) ?? null : S.inP ? privBal(S.pay) : S.bal[S.pay];
      if (bal == null) return;
      const relayKeep = !isEth(S.pay) && !S.at.pay && !S.inP && laterOn(kindOf(S.pay, S.get)) && depPayer() === 'token' && relayWei() != null ? ((tokenWei(S.pay, relayWei()) ?? 0n) * 13n) / 10n : 0n;
      const keep = isEth(S.pay) && !S.at.pay ? (gasKeep() * 3n) / 2n + (S.outP ? tipKeep() : 0n) : relayKeep, left = bal > keep ? bal - keep : 0n;
      const hop = isEth(S.pay) && !S.at.pay && laterOn(kindOf(S.pay, S.get)) && LATER.fee != null && LT;
      const tokLater = !isEth(S.pay) && !S.at.pay && !S.inP && laterOn(kindOf(S.pay, S.get));
      const tokMax = () => { const q0 = S.q, dep = q0?.wei ? laterIn(q0) : null, ratio = dep ? Number(dep) / Number(q0.wei) : (1 + LATER.pct / 100) * 1.002 * 1.03; return BigInt(Math.floor((Number(left) / ratio) * 0.985)); };
      const v = hop ? LT.mod.swapFor({ capWei: left, feeWei: LATER.fee, pct: LATER.pct, rand: () => LATER.rand, gasWei: laterGas() }) : tokLater ? tokMax() : left;
      S.amt = tidy(fitAmt(plain(v, t.dec))); S.note = ''; changed(); paintSides(); requote(true); return;
    }
    if (e.target.closest('[data-watch]')) { const t = tokenOf(e.target.closest('[data-watch]').dataset.watch); if (t) wallet.watchAsset({ address: t.addr, symbol: t.sym, decimals: t.dec }); return; }
    if (e.target.closest('[data-farm-it]')) H.farmIt?.(S.lastBuy);
    if (e.target.closest('#pv-open')) openPrivate().catch(() => {});
    if (e.target.closest('#pv-sign')) H.key?.openKey?.().catch(() => {});
    if (e.target.closest('#pv-here') && S.hereR && !S.busy) { S.note = ''; privateGo(S.hereR, 'private', true).catch(() => {}); return; }
    if (e.target.closest('#pv-read')) { PV?.read(true).then(paint, () => paint()); return; }
    const xr = e.target.closest('[data-exit-run], [data-exit-back]');
    if (xr) exitAct(xr.dataset.exitRun || xr.dataset.exitBack, !!xr.dataset.exitBack).catch(() => {});
  });
  $('#ackbox').addEventListener('change', (e) => { if (e.target.id === 'ack') { S.ack = e.target.checked; S.ackGap = S.gapNow; paintQuote(); } });
  $('.mode')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    if (moving()) { if (b.dataset.mode !== 'bitcoin' && S.btc) load(new URLSearchParams()); return; }
    if (b.dataset.mode === 'bitcoin') { setBtc(!S.btc); return; }
    if (S.btc) setBtc(false);
  });
  if ($('.mode')) arrows($('.mode'), 'data-mode');
  arrows($('#rows'), 'data-route');
  addEventListener('storage', (e) => { if (e.key === BRIDGED_KEY || e.key === null) paintNudge(); if ((e.key === PLANS_KEY || e.key === null) && ROOT?.isConnected) paintSteps(); });
}

export function mountSwapCard(root, host = {}) {
  if (ROOT) throw new Error('This page already has a swap card.');
  ROOT = root; H = host; wallet = host.wallet; W = host.W;
  root.classList.add('swc');
  root.classList.toggle('mv', !!host.moves);
  root.innerHTML = markup(host);
  wire();
  for (const t of ['pointerdown', 'keydown', 'input']) addEventListener(t, () => { depTouched = Date.now(); }, true);
  slipPaint();
  paint();
  if (W.account) readBalances().then(paintSides, () => {});
  readPrices().then(() => { rerank(); paint(); if (S.amt && !(S.inP || S.outP) && Math.abs(S.chainT - now()) > 120) requote(true); }).catch(() => {});
  gasPrice().then(() => { rerank(); paint(); }, () => {});
  checkAmmRoute().then(() => {
    if (S.ammRoute !== true || S.busy || !ASKED || `${S.pay}>${S.get}` !== ASKED.pair) return;
    applyParams(ASKED.p);
    if (`${S.pay}>${S.get}` !== ASKED.pair) { S.q = null; paint(); readBalances().then(paintSides); if (S.amt) requote(true); }
  });
  checkExits().catch(() => {});
  paintSteps();
  if (plans().some((p) => p.state === 'waiting')) ltLoad().then(readBlend, () => {});
  PN.load().then(() => { if (S.q?.rows && !S.q.busy) paintQuote(); }, () => {});
  let ticked = 0, routeAt = now();
  const tick = () => {
    if (document.hidden || !ROOT.isConnected || now() - ticked < 10) return;
    ticked = now();
    readPrices().catch(() => {});
    gasPrice().then(() => { rerank(); paintQuote(); }, () => {});
    if (now() - routeAt > 300) { routeAt = now(); checkAmmRoute(); }
    if (S.q && !S.busy && !S.q.busy && now() - (S.q.at || 0) > (['any', 'out', 'in', 'pout', 'agg', 'pin', 'exit', 'private'].includes(S.q.kind) ? 55 : 25)) requote(true);
    if (S.inP && PV?.unlocked && !PV.held && !S.busy) PV.read(true).then(paint, () => {});
  };
  setInterval(tick, 30e3);
  setInterval(() => { if (!document.hidden && ROOT.isConnected) readBlend(); }, 30e3);
  document.addEventListener('visibilitychange', tick);
  return {
    load: (p) => load(p),
    setFlow,
    get flow() { return FLOW; },
    get busy() { return S.busy; },
    params,
    get lane() { return S.btc; },
    setLane: (on) => setBtc(!!on),
    walletChanged,
    keyChanged: () => { PV?.reset(); paint(); privUp(); },
    farms: () => (S.farms ? Promise.resolve(S.farms) : readFarms().then(() => S.farms)),
    readBalances: () => readBalances().then(paintSides),
    refresh: () => { if (moveOf() || S.at.pay || S.at.get) { paintMode(); paintSides(); if (exiting() && S.q) paintQuote(); } else paintMode(); },
    requote: () => { if (!S.busy && (moveOf() || exiting())) requote(true); },
    focus: () => $('#amt').focus({ preventScroll: true }),
    working: (on) => {
      if (!!on === S.busy) return;
      S.busy = !!on; paintQuote();
      if (!on) { paint(); H.onDone?.(); readBalances().then(paintSides, () => {}); }
    },
    clear: () => { clearTimeout(qTimer); S.seq++; S.amt = ''; S.q = null; S.mq = null; changed(); paint(); const mk = moveOf(); if (mk) H.moves?.cleared?.(mk); },
    closePicker: () => pkClose?.({ quiet: true }),
    pickerBals,
    get busy() { return S.busy; },
  };
}
