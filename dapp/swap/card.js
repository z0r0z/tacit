// The swap card: any token for any token at the best onchain price, either side private, and Swap privately. /swap/ shows it, and so does the
// front page's Swap tab: `mountSwapCard(root, host)` draws it in `root`, and the page hands it its wallet (the front page also its Tacit key, its
// pool module and its Activity journal). One card to a page: its state is this module's.
import { keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeEvmTradeVenues, _internal as V, MULTICALL3 } from '/evm-trade-venues.js?cb=5a940508';
import { UserStopped } from '/trade/wallet.js?cb=6778fe25';
import { rpc, RPCS, API, api, esc, fmtUnits, parseUnits, plain, usd, sig, E10, E18, ago } from '/trade/util.js?cb=dcf3a4f2';
import * as R from '/swap/route.js?cb=ce610210';
import * as A from '/swap/aggregate.js?cb=3c73982e';
import * as SV from '/swap/solvers.js?cb=2c70b259';
import * as GR from '/gas-relay.js?cb=893b2c02';
import { checkSnwapCall, SNWAP_EXECUTORS, SAFE_EXECUTOR } from '/zrouter-guard.js?cb=f5ae4bcd';
import { rewardPop } from '/reward-pop.js?cb=1b53f6d4';
import { makePointsNote } from '/points-note.js?cb=dc44d257';
import { aprText, readPrecision, readSpot, privateFarms } from '/trade/farm-read.js?cb=112a01b9';
import { SERVED } from '/evm-pool-tokens.js?cb=e1ab5d24';
import { netPicker } from '/net-pick.js?cb=8f57c360';

const CHAINLINK = { eth: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btc: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
const PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E';
const CETH_ID = R.POOL_ID[R.ZERO];
const now = () => Math.floor(Date.now() / 1000);
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordAt = (h, i) => BigInt('0x' + (strip(h).slice(i * 64, (i + 1) * 64) || '0'));
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
const lc = (a) => String(a).toLowerCase();

const HEAVY_HOSTS = [RPCS[RPCS.length - 1], ...RPCS.slice(0, -1)];
export const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: '0x' + BigInt(o.value).toString(16) } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block, ...(o.state ? [o.state] : [])], o.gas ? HEAVY_HOSTS : undefined);
export const batch = async (calls) => V.decAggregate3(await ethCall(MULTICALL3, V.encAggregate3(calls)), calls.length);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
const within = (p, ms, why) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);
const PN = makePointsNote({ read: () => fetch('https://api.tacit.finance/leaderboard?day=today&limit=1', { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)) });
const noteOf = (x, q) => [x.note, ptsTag(rowPts(x, q))].filter(Boolean).join(' · ');
// ── TAC points: what a route earns, said beside it and in its receipt, and popped from the button once it is sent ──
// The program counts, each for the wallet that sent it: ETH that zRouter puts into a pool it can check (Uniswap v2, v3 and v4, Sushi, the
// Precision pool) as a swap of ETH; a wallet's ETH deposited into the private pool as a wrap; its ETH deposited into the private ETH pool (Swap
// privately) as a deposit there. An outside solver's route earns nothing (its ETH reaches the pools through the solver's own router), nor does
// a swap out of a pool that the relay sends. The figure is the page's estimate where it gives one (the front page's, with the early bonus,
// the holder tiers and the day's weight), else the program's floor rate.
const PTS_SRC = new Set([0, 1, 3, 4, 8]);                                  // zQuoter's sources the program checks: Uniswap v2, Sushi, Uniswap v3, v4
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
// Swap privately: its deposit into the private ETH pool (a token's own pool is not one the program counts)
const laterPts = (q, r) => (!q || r?.hop ? null : ptsFor('dev', laterDeposit(q)));
const ptsSaid = (p, word = true) => (p ? `${p.floor ? '' : '≈ '}${Math.round(p.pts).toLocaleString('en-US')}${p.floor ? '+' : ''}${word ? ' points' : ''}` : '');
// What a swap inside a private pool must pay at least: it settles by a proof some time after the quote, so the slippage setting is honoured when it is looser than 1%,
// and never goes tighter than that.
// Solvers whose firm route the guard refused or whose simulation failed, left out of the quotes for five minutes (solver id -> until).
const AVOID = new Map();
const poolFloor = (x) => (x * (10000n - BigInt(Math.max(Number(S.slip) || 0, 100)))) / 10000n;
// How a split divides, as the TAC trading page draws it: Precision's share and Tacit's, side by side, each named (the first leg is Precision's).
const splitBar = (sh) => `<span class="splitbar" role="img" aria-label="${sh}% Precision pool, ${100 - sh}% Tacit pool"><span class="pp" style="flex:${Math.max(sh, 8)}">Precision ${sh}%</span><span class="tp" style="flex:${Math.max(100 - sh, 8)}">Tacit ${100 - sh}%</span></span>`;
// the TAC mark beside a points figure, wherever one is said (a route's note, a home's cue, a receipt line)
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
// The page the card is drawn on: its root, and what the page hands it (see mountSwapCard). Every element the card reads is looked for inside it.
let ROOT = null, H = {}, wallet = null, W = {};
const $ = (s) => ROOT.querySelector(s);
const changed = () => H.onChange?.();
// The last swaps made from this browser, so a swap does not vanish with the line that said "Done": a short sentence and its transaction.
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
// the tokens the picker lists beyond the card's own, loaded once, when first wanted: the token list registry's (token.list.wei, written from the
// chain by tools/token-list.mjs), then the Uniswap Labs default list's Ethereum tokens (tools/uniswap-list.mjs) where the registry has none,
// each drawn with the logo kept for it on this site
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
try { localStorage.removeItem('tacit-swap-list-v1'); } catch { }        // the list once read from the chain and kept here a day
// Whether TacitAmmRoute is deployed, which is what lets a token be swapped into tacUSD or tacBTC in one transaction. Read now and then, so the
// pair appears by itself the day it is.
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
    paintSides(); if (W.account) readBalances().then(paintSides);
  })().catch(() => {}).finally(() => { TL.p = null; }));
}
// A token with a private pool of its own (dapp/evm-pool-tokens.js SERVED): named in the picker and listed ahead of the others
const pooled = (k) => !!SERVED[k];
// a coin Tacit holds privately: ETH (as tETH), TAC, tacUSD and tacBTC (as cUSD and cBTC), and the tokens with private pools of their own
const tacitPooled = (k) => isEth(k) || tacitKey(k) || pooled(k);
// every token the card knows (its own, the lists', the ones added by address), made again only when the lists or the added ones change
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
const BALQ = new Set();                                                   // the long list's tokens whose balance was asked for, by account
// A coin as its side shows it: on a private side tacUSD and tacBTC are the notes cUSD and cBTC.
const sidePriv = (k) => (k === S.pay ? S.inP : k === S.get ? S.outP : false);
const tokenOf = (k, priv = sidePriv(k)) => { const t = k === 'teth' ? TETH : listedAt(k); return t?.psym && priv ? { ...t, sym: t.psym } : t; };
const nameIs = (t, x) => lc(t.sym) === x || (t.psym && lc(t.psym) === x);
const isEth = (k) => k === lc(R.ZERO);
const tacitKey = (k) => R.tacitToken(k);
const POOLID = (k) => (k === 'teth' ? CETH_ID : R.POOL_ID[Object.keys(R.POOL_ID).find((a) => lc(a) === k)]);

// ── the output to another address (public swaps only; never read from the address bar, so a shared link cannot name one) ──
const NOT_A_WALLET = new Set([R.ZERO, R.TAC, R.CUSD, R.CBTC, R.WETH, R.ZROUTER, R.ZQUOTER, R.PERMIT2, R.PRECISION_ROUTE, R.PRECISION_GUARD, R.TACIT_AMM, R.TACIT_AMM_ROUTE, R.CONF_ROUTER, PRECISION_POOL, MULTICALL3, SAFE_EXECUTOR, ...Object.keys(SNWAP_EXECUTORS)].map(lc));
// EIP-55: the capitals of an address are its checksum
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
// an address shown by the name it was typed as (alice.eth), else short
const who = (a) => (a && S.toName && S.toName.addr === lc(a) ? S.toName.name : shortAddr(a));
// alice.eth, alice.wei or alice.gwei where an address goes: looked up as the rest of the app looks a name up (two nodes must agree)
const isName = (t) => /^[^\s/@]+\.(eth|wei|gwei)$/i.test(t);
let namesP = null;
const names = () => (namesP ||= Promise.all([import('/confidential-names.js'), import('/vendor/tacit-deps.min.js')])
  .then(([n, d]) => n.makeConfidentialNames({ call: n.makeMainnetCall(), secp: d.secp, keccak256: d.keccak_256 })).catch((e) => { namesP = null; throw e; }));
const tacitName = (t) => t.name || `tacit1…${String(t.pubHex).slice(-6)}`;
const recipient = () => (S.to && !S.inP && !S.outP && lc(S.to) !== lc(W.account || '') ? S.to : null);
// Where a swap out of the private pool goes: the address typed, else the wallet connected here (never taken from the address bar).
const outTo = () => (kindOf(S.pay, S.get) === 'pout' ? S.to || (W.account ? lc(W.account) : null) : null);

// Which way a pair goes, from where each side is (a wallet, or the private balance):
//   wallet → wallet    the Tacit routes for TAC, tacUSD and tacBTC; any other pair zQuoter's best onchain route ('agg')
//   wallet → private   ETH made private, then swapped in the pool ('private'); another token first swapped for ETH ('pin')
//   private → private  a swap in the pool ('private')
//   private → wallet   a swap in the pool to tETH, then out of it to the address, as ETH or a token ('pout')
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
  if (tin && !tout) return isListed(get) ? 'out' : null;                                                // TAC, tacUSD or tacBTC out to any token
  if (!tin && tout) return pay !== lc(R.WETH) && (get === lc(R.CUSD) || get === lc(R.CBTC)) && S.ammRoute === true ? 'in' : null;   // any token in to tacUSD or tacBTC, once TacitAmmRoute is deployed
  const wrapPair = [pay, get].every((k) => isEth(k) || k === lc(R.WETH));
  return isListed(pay) && isListed(get) && !wrapPair && !(tin && tout) ? 'agg' : null;                   // any token to any token
}
// A token the pool does not hold can still be got privately: paid out of the private balance to an address ('pout'), or bought from the
// wallet's ETH or a wallet token through the private ETH pool (Swap privately). Either way the token itself lands at an address, so it is listed
// with the wallet's coins; how it travels is Swap privately's switch.
const outRoute = (k) => (inPool(k) ? 'pool' : S.inP ? (kindOf(S.pay, k, true, false) === 'pout' ? 'out' : null) : !isEth(k) && laterPair(kindOf(S.pay, k, false, false), S.pay, k) ? 'later' : null);
const hidden = () => LATER.on && !S.inP && !S.outP && !inPool(S.get) && outRoute(S.get) === 'later';
const getPriv = () => S.outP || hidden();

// ── places: the front page's Swap card ─────────────────────────────────────────────────────────────────────────────────────────────────────
// With H.moves the card is the front page's Swap card. Each side is in a wallet, private or on Bitcoin, and private is one of two homes: the
// DeFi pool (tETH, TAC, cUSD and cBTC, bridged, swapped, farmed and borrowed against) or the Pay pool (ETH and TAC proved on this device and
// paid out privately on its chain). What the card makes on /swap/ it makes here: any swap, and ETH into and out of the DeFi pool. Moving one
// coin between places otherwise is the page's: H.moves names the move, prices it and starts it, and the card shows what it says.
const moving = () => !!H.moves;
const atOf = (side) => S.at[side] || ((side === 'pay' ? S.inP : S.outP) ? 'defi' : 'wallet');
const isPrivAt = (at) => at === 'defi' || at === 'pay';
const sameCoin = (a, b) => a === b || [a, b].every((k) => isEth(k) || k === 'teth');
// the pair as the card makes it itself, each side where pa and ga say
const native = (pay, pa, get, ga) => ((pa === 'wallet' || pa === 'defi') && (ga === 'wallet' || ga === 'defi') ? kindOf(pay, get, pa === 'defi', ga === 'defi') : null);
// one coin moving between places is the page's to make (its own forms, with their fees and points); a swap from one coin to another is this card's
const sameMoney = (a, b) => sameCoin(a, b) || (a === lc(R.TAC) && b === lc(R.TAC));
function moveOf(pay = S.pay, pa = atOf('pay'), get = S.get, ga = atOf('get')) {
  if (!moving()) return null;
  const k = H.moves.key(pay, pa, get, ga);
  return k && (sameMoney(pay, get) || !native(pay, pa, get, ga)) ? k : null;
}
// both sides on Bitcoin, two coins: a swap in the Bitcoin pool, which the Bitcoin lane makes in place of the card's own fields
const lanePair = (pay, pa, get, ga) => moving() && !!$('#btc') && pa === 'btc' && ga === 'btc' && !sameMoney(pay, get);
const pairOk = (pay, pa, get, ga) => !!(native(pay, pa, get, ga) || moveOf(pay, pa, get, ga) || lanePair(pay, pa, get, ga) || exitOf(pay, pa, get, ga));
// The Pay pool holds ETH, the two dollars and TAC, each in a pool of its own that this device proves for. What a pool holds goes out to an
// address as the same coin, or swapped for another on the way (one withdrawal that runs the swap, later.js's plans: adopt, then the confirmed
// price). The out leg's coin is ETH, TAC or any listed token zQuoter routes (WETH only wraps, and the Tacit tokens have their own ways).
const USDC_K = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT_K = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const PAY_COINS = [lc(R.ZERO), USDC_K, USDT_K, lc(R.TAC)];
// Where a coin is held, as a small mark: the wallet's glyph, each pool's own mark (the DeFi pool's tETH ring, the Pay pool's dashed ETH ring) and
// Bitcoin's. The corner of each field, the picker's group headers and its anchors all wear them, so the place reads at a glance.
const WALLET_MARK = '<svg class="pl" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.2h9.6a1.4 1.4 0 0 1 1.4 1.4v6.6a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4V3.6a1.4 1.4 0 0 1 1.4-1.4h7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10.6" cy="9" r=".95" fill="currentColor"/></svg>';
const MARK_USE = { pay: 'tk-peth', defi: 'tk-teth', btc: 'c-btc' };
const placeMark = (at) => (at === 'wallet' ? WALLET_MARK : MARK_USE[at] ? `<svg class="tk xs" aria-hidden="true"><use href="#${MARK_USE[at]}"/></svg>` : '');
// what each place is for, said once under its group in the picker: the same coin (TAC most of all) is held in several, and this is what tells them apart
const PLACE_NOTE = { wallet: 'Public, on Ethereum. Swaps use the best public liquidity.', defi: 'Private, Bitcoin-backed. Swap, farm and borrow in Tacit’s own private AMM.',
  pay: 'Private, held on this device. Pay anyone, or swap out through public liquidity.' };
const PLACE_TIP = { wallet: 'Your wallet: public, on Ethereum', pay: 'Pay pool: ETH, USDC, USDT and TAC held privately, proved on this device and paid out to any address',
  defi: 'DeFi pool: tETH, TAC, cUSD and cBTC held privately, to swap, farm and borrow with', btc: 'Bitcoin: TAC and tETH at your Bitcoin address' };
const payPool = (k) => PAY_COINS.includes(k);
const exitOut = (pay, get) => (get === pay ? !isEth(pay) : isEth(get) || get === lc(R.TAC) || (isListed(get) && !tacitKey(get) && get !== lc(R.WETH)));
// (the ETH Pay pool's other chains are the page's own moves: a swap out runs on Ethereum's pools)
const exitOf = (pay = S.pay, pa = atOf('pay'), get = S.get, ga = atOf('get')) => {
  // the wallet's ETH into another coin's Pay pool: its swap pays that pool's deposit box for this key
  // (a listed wallet token goes the same way into a dollar's pool, by zQuoter's best route; TAC and the Tacit tokens have their own routes)
  if (moving() && pa === 'wallet' && ga === 'pay' && payPool(get) && !isEth(get) && (isEth(pay) || (isListed(pay) && !tacitKey(pay) && pay !== lc(R.WETH) && pay !== get && (get === USDC_K || get === USDT_K)))) return { pay, get, into: true, wallet: true };
  if (!moving() || pa !== 'pay' || !payPool(pay) || (isEth(pay) && (H.moves.chain ?? 1) !== 1)) return null;
  // into another Pay pool coin: the swap pays a deposit box of that pool for this key, no address of anyone's
  if (ga === 'pay') return payPool(get) && get !== pay && (!isEth(get) || (H.moves.chain ?? 1) === 1) ? { pay, get, into: true } : null;
  return ga === 'wallet' && exitOut(pay, get) && !moveOf(pay, pa, get, ga) ? { pay, get } : null;
};
const intoPool = () => !!exitOf()?.into;
const exiting = () => !!exitOf();
const PLACES = ['defi', 'wallet', 'pay', 'btc'];
const goes = (side, k, at) => PLACES.some((oa) => placeCoins(side === 'pay' ? 'get' : 'pay', oa).some((o) => (side === 'pay' ? pairOk(k, at, o, oa) : pairOk(o, oa, k, at))));
const placed = () => moving() && !!(S.at.pay || S.at.get || moveOf());
// a coin as it is in a place: ETH is tETH in the DeFi pool and on Bitcoin, ETH in a wallet and the Pay pool; TAC is TAC everywhere
function coinAt(k, at) {
  if (at === 'defi') return isEth(k) ? 'teth' : inPool(k) ? k : 'teth';
  if (at === 'wallet') return k === 'teth' ? lc(R.ZERO) : k;
  if (at === 'pay') return payPool(k) ? k : lc(R.ZERO);
  return isEth(k) || k === 'teth' ? 'teth' : lc(R.TAC);
}
// what a place offers a side: the Pay pool takes ETH and TAC and pays ETH out; Bitcoin holds TAC and tETH
const placeCoins = (side, at) => (at === 'pay' ? PAY_COINS : at === 'btc' ? [lc(R.TAC), 'teth'] : at === 'defi' ? POOL_COINS : [lc(R.ZERO), lc(R.TAC)]);
function setAt(side, at) {
  S.at[side] = at === 'pay' || at === 'btc' ? at : null;
  if (side === 'pay') S.inP = at === 'defi';
  else { S.outP = at === 'defi'; if (at !== 'wallet') LATER.on = false; }
}
// A pair that goes nowhere is mended on the side that did not change: its coin where it is, else that place's other coins, else another place.
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
// the To side's private home, chosen: the DeFi pool or the Pay pool, the same coin in either
function setHome(home) {
  if (S.busy || atOf('get') === home) return;
  const was = S.get;
  setAt('get', home); S.get = coinAt(was, home);
  if (!pairOk(S.pay, atOf('pay'), S.get, home)) { setAt('get', home === 'pay' ? 'defi' : 'pay'); S.get = coinAt(was, atOf('get')); }
  S.q = null; S.mq = null; changed(); paint(); requote(true);
}
// The chains the Pay pool pays on, as a row of their marks (named in its label and title); a chain with no mark here is counted instead
const CHAIN_MARK = { 1: 'c-eth', 8453: 'c-base', 4663: 'c-rh' }, CHAIN_NAME = { 4663: 'Robinhood Chain' };
function chainMarks(cs) {
  if (!cs.every((c) => CHAIN_MARK[c.id])) return `${cs.length} chains`;
  const names = esc(cs.map((c) => CHAIN_NAME[c.id] || c.name).join(', '));
  return `<span class="cm" role="img" aria-label="${names}" title="${names}">${cs.map((c) => `<svg class="tk" aria-hidden="true"><use href="#${CHAIN_MARK[c.id]}"/></svg>`).join('')}</span>`;
}
// Private on the To side, when the coin can rest in either home: the two of them, side by side
let HOMES_OPEN = false;
function homesHtml() {
  if (!moving() || !isPrivAt(atOf('get'))) return '';
  const pa = atOf('pay'), eth = isEth(S.get) || S.get === 'teth', tac = S.get === lc(R.TAC);
  if (!eth && !tac) return '';
  const dk = eth ? 'teth' : lc(R.TAC), pk = eth ? lc(R.ZERO) : lc(R.TAC);
  if (!pairOk(S.pay, pa, dk, 'defi') || !pairOk(S.pay, pa, pk, 'pay')) return '';
  // the Pay pool row names where it pays (ETH's on each chain it has, TAC's on Ethereum); the chain itself is picked under the rows
  const at = atOf('get'), cs = eth ? H.moves.chains?.() || [] : [], where = cs.length > 1 ? chainMarks(cs) : 'Ethereum';
  // what each home earns in TAC points for ETH from the wallet (a wrap into the DeFi pool, a deposit into the Pay pool): for the amount typed,
  // or for one ETH before one is
  const wei = isEth(S.pay) && pa === 'wallet' ? parseUnits(S.amt, 18) || 0n : null;
  const cue = (act) => { const p = wei == null ? null : ptsFor(act, wei > 0n ? wei : 10n ** 18n); return `<span class="ra">${p ? `<span>${ptsTag(p, false)}</span><small>${wei > 0n ? 'points' : 'points/ETH'}</small>` : ''}</span>`; };
  const row = (home, t, sub, icon, act) => `<button type="button" role="radio" class="c" data-home="${home}" aria-checked="${String(at === home)}" tabindex="${at === home ? 0 : -1}"><svg class="tk" aria-hidden="true"><use href="#tk-${icon}"/></svg><span class="rt"><b>${t}</b><small>${sub}</small></span>${cue(act)}<span class="rd" aria-hidden="true"></span></button>`;
  // the chosen home alone, with a way to change it, until the choice is opened
  const defi = row('defi', 'DeFi pool', 'swap, farm, borrow', eth ? 'teth' : 'tac', 'wrap'), pay = row('pay', 'Pay pool', `pay on ${where}`, eth ? 'peth' : 'tac', 'dev');
  if (!HOMES_OPEN) return `<div class="rows-h"><span>Private in</span><span class="chg">Change</span></div>${at === 'pay' ? pay : defi}`;
  return `<div class="rows-h"><span>Private in</span></div>${defi}${pay}`;
}
// the Pay pool's chain, while ETH is in it on either side
function chainHtml() {
  if (!moving() || !((atOf('pay') === 'pay' && isEth(S.pay)) || (atOf('get') === 'pay' && isEth(S.get))) || !H.moves.chains) return '';
  const cs = H.moves.chains();
  return cs.length > 1 ? `Pay pool on <select id="chain-sel" aria-label="The Pay pool’s chain">${cs.map((c) => `<option value="${c.id}" data-mark="${CHAIN_MARK[c.id] || 'c-eth'}"${c.id === H.moves.chain ? ' selected' : ''}>${esc(CHAIN_NAME[c.id] || c.name)}</option>`).join('')}</select>` : '';
}
// A move, priced by the page: what arrives, its receipt, a line, and the button it starts from.
function paintMove() {
  const q = S.mq || {}, out = $('#out'), rc = $('#rcpt'), go = $('#go');
  // a move that takes no amount (its own form chooses what goes): nothing to type, and what was typed waits for the next move that takes one
  if (!q.busy && !!q.fixed !== $('#amt').readOnly) paintSides();
  out.classList.toggle('busy', !!q.busy);
  if (!q.busy) { const v = q.out == null ? null : String(q.out); out.textContent = v ?? '0'; out.classList.toggle('ph', v == null || v === '—'); out.classList.toggle('word', v != null && v !== '—' && !/^[\d.,]+$/.test(v)); }
  fitSize(out);
  const n = !q.busy && /^[\d.,]+$/.test(String(q.out ?? '')) ? parseUnits(String(q.out).replace(/,/g, ''), tokenOf(S.get)?.dec ?? 18) : null, v = n ? usdOf(S.get, n) : null;
  $('#get-usd').textContent = v != null ? `≈ ${usd(v)}` : '';
  $('#rows').hidden = true; $('#later').hidden = true; $('#ackbox').innerHTML = ''; $('#ackbox').dataset.k = '';
  const lines = (q.rc || []).filter(Boolean);
  rc.hidden = !lines.length || (!S.amt && !q.fixed); rc.classList.toggle('stale', !!q.busy);   // the receipt waits for an amount
  rc.innerHTML = lines.map(([k, v, c, t]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${k === 'TAC points' ? TAC_MARK : ''}${esc(k)}</dt><dd class="${c || ''}">${esc(v)}</dd></div>`).join('');
  const need = !q.free && !parseUnits(S.amt, 8);
  go.textContent = S.busy ? 'Working…' : need ? 'Enter an amount' : q.busy && !q.go ? 'Reading…' : q.go || 'Continue';
  go.disabled = S.busy || need || !!q.busy || !!q.failed;
  go.className = `go${isPrivAt(atOf('get')) ? ' priv' : ''}`;
  if (!S.busy) say(q.line ? `<span class="${q.warn ? 'warn' : ''}">${esc(q.line)}</span>` : '');
}
// A pair that goes nowhere is mended from the side that changed: the other side takes the coin most likely to go with it.
function clearTo() { S.toAsked = false; S.to = null; S.toBad = ''; S.toName = null; S.toBusy = false; S.toTacit = null; S.toTacitBad = ''; S.toTacitBusy = false; S.toOpen = false; $('#to-in').value = ''; }
function fit(changed) {
  if (kindOf(S.pay, S.get)) return;
  if (placed()) { mend(changed); return; }
  if (changed === 'pay') S.get = S.outP ? (S.pay === 'teth' || isEth(S.pay) ? lc(R.TAC) : 'teth') : S.inP ? lc(R.ZERO) : isEth(S.pay) ? lc(R.TAC) : tacitKey(S.pay) ? lc(R.ZERO) : lc(R.TAC);
  else S.pay = S.inP ? (S.get === 'teth' ? lc(R.TAC) : 'teth') : S.outP ? lc(R.ZERO) : isEth(S.get) || !tacitKey(S.get) ? lc(R.TAC) : lc(R.ZERO);
  if (!kindOf(S.pay, S.get)) { S.pay = S.inP ? 'teth' : lc(R.ZERO); S.get = S.outP ? (S.pay === 'teth' ? lc(R.TAC) : 'teth') : S.inP ? lc(R.ZERO) : lc(R.TAC); }
}
// A coin picked with where it is held (the picker lists each place's coins): the side goes to that place with it. On the front page any place's
// coin goes as choose takes it; on /swap/ the side turns private or public with it, and the other side is fitted to the pair.
function pickAt(side, at, k) {
  if (S.busy) return;
  if (moving()) { choose(side, `@${at}:${k}`); return; }
  if (at === atOf(side)) { choose(side, k); return; }
  const was = side === 'pay' ? S.pay : S.get, amt = S.amt;
  if (side === 'get') clearTo();
  keepAmt(() => { setAt(side, at); if (side === 'pay') S.pay = k; else S.get = k; fit(side === 'pay' ? 'get' : 'pay'); });
  if (side === 'pay' && sameCoin(was, k)) S.amt = amt;                                                // ETH and tETH are the same unit: what was typed stands
  if (at === 'defi') { warmPrivate(); farmsSoon(); privUp(); }
  S.amt = fitAmt(S.amt); S.q = null; S.pick = null; S.hold = false; S.ack = false; changed(); paint(); requote(true);
}

const SPRITE = new Set(['tac', 'teth', 'cbtc', 'cusd', 'btc', 'eth', 'peth']);
// a coin held in the Pay pool carries the private mark (a dashed ring) wherever it is drawn
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
// What goes into the pool is counted in 8 decimals, its unit (a private balance, or ETH made private): a longer amount (Max on a wallet balance,
// a pasted figure) is cut there, never refused.
const poolUnits = () => S.inP || (S.outP && isEth(S.pay));
const fitAmt = (s, on = poolUnits()) => (on ? String(s).replace(/([.,]\d{8})\d+$/, '$1') : s);
// What a swap from the wallet's ETH leaves behind for the network fee, in wei: what Max keeps back, and what an amount is checked against.
const gasKeep = () => (S.gasPrice || 3n * 10n ** 9n) * 400000n;
// What a private swap from the wallet's ETH also keeps back for the relay's deposit tip: the last one quoted, twice over, or 0.001 ETH before any.
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
const chainDeadline = (s = 1200) => BigInt((S.chainT ? S.chainT + (now() - S.chainAt) : now()) + s);
const gasPrice = (() => { let at = 0; return async () => { if (S.gasPrice != null && now() - at < 20) return S.gasPrice; try { S.gasPrice = BigInt(await rpc('eth_gasPrice', [])); at = now(); } catch { } return S.gasPrice; }; })();
// The wallet's balances: of the card's own tokens, the registry's, the ones added by address and the pair chosen; a token of the Uniswap
// list is read once it is chosen (all of them at once would be some five hundred reads a time)
async function readBalances() {
  const who = W.account;
  if (!who) { S.bal = {}; return; }
  const toks = listed().filter((t) => !isEth(t.addr) && (!t.uni || t.addr === S.pay || t.addr === S.get));
  const [eth, r] = await Promise.all([rpc('eth_getBalance', [who, 'latest']).then(BigInt, () => null), batch(toks.map((t) => ({ to: t.addr, data: '0x70a08231' + addrWord(who) }))).catch(() => [])]);
  const bal = {};
  if (eth != null) bal[lc(R.ZERO)] = eth;
  toks.forEach((t, i) => { if (r[i]) bal[t.addr] = wordAt(r[i], 0); });
  if (W.account !== who) return;
  // a token of the long list read earlier for this account keeps its figure until it is read again
  if (S.balFor === who) for (const [k, v] of Object.entries(S.bal)) if (!(k in bal) && listedAt(k)?.uni) bal[k] = v;
  S.bal = bal; S.balFor = who;
  relayLiveCheck();
}

const live = (t) => { $('#sw-live').textContent = t; };
const say = (h, cls = '', stick = false) => { if (stick) S.note = { h, cls }; const q = $('#q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
// The wallet moved to another account, or one was connected: its balances are read again, and the quote made again for it.
function walletChanged() { S.bal = {}; paint(); readBalances().then(paint); if (S.q) requote(true); }
async function signTyped(typed, from) {
  if (lc(W.account || '') !== lc(from)) throw new Error('The wallet’s account changed. Nothing was signed; review it again.');
  await wallet.ensureMainnet();
  try { return await W.prov.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] }); } catch (e) {
    if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied/i.test(e?.message || '')) throw new UserStopped();
    throw e;
  }
}

const PREVIEW = '0x0000000000000000000000000000000000000001';           // who a quote pays before a wallet is connected
const GAS = { single: 160000n, twohop: 260000n, hybrid: 480000n, tac: 160000n, tacSell: 210000n, split: 270000n, any: 320000n, amm: 150000n, ammIn: 200000n, out: 340000n, in: 290000n, zap: 700000n, snwap: 380000n };
const picked = (q = S.q) => (q?.rows || []).find((r) => r.k === S.pick) || q?.rows?.find((r) => r.best) || q?.rows?.[0] || null;

function syncMove() {
  const mk = moveOf();
  if (moving() && mk !== S.mk) {
    S.mk = mk; S.mq = null;
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
  const done = (q) => { if (my !== S.seq) return; S.q = { ...q, kind, wei, at: now() }; if (!S.hold || !S.q.rows?.some((r) => r.k === S.pick)) S.pick = S.q.rows?.find((r) => r.best)?.k || S.q.rows?.[0]?.k || null; const ak = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; if (ak !== S.ackKey) { S.ack = false; S.ackKey = ak; } paint(); aheadSoon(); };
  if (!kind) return done({ none: true });
  const account = W.account || undefined;
  // Swap privately from a token: sold for ETH into the private pool (the zap), and the swap's share of that ETH sold for the token on the way
  // out, both quoted for stand-ins, so no node is shown the wallet or the address
  if (laterOn(kind) && !isEth(S.pay) && viaToken()) {
    // through the token's own pool: the token goes in as it is, and the swap out sells exactly the amount typed
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
  if (kind === 'tac') {
    const dir = isEth(S.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: wei, account, gasPrice: await gasPrice() });
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
  // any token to any token: zQuoter's best onchain route, held to the terms by the guard (swap/aggregate.js), raced against the outside
  // solvers (swap/solvers.js), which are told the pair and the amount alone; the best is what pays most less its network fee
  if (kind === 'agg') {
    // with Swap privately on, the quote names neither the wallet nor the destination, and asks no outside solver: a node or an API that saw
    // both would hold the link the deposit is there to break (the swap out is quoted again, with a stand-in, when it is made)
    const hide = laterOn(kind), who = hide ? PREVIEW : recipient() || account || PREVIEW, rows = [], sq = { tokenIn: S.pay, tokenOut: S.get, amountIn: wei, decIn: pay.dec, decOut: get.dec };
    const sols = hide ? [] : SV.SOLVERS.filter((v) => !(AVOID.get(v.id) > Date.now()));   // a solver whose route was just refused is left out for a few minutes
    let left = 1 + sols.length, zerr = null;
    gasPrice();
    // in dollars where the token and the gas can both be priced, else what it pays
    const net = (r) => { const v = usdOf(S.get, r.out), f = S.gasPrice && S.px.ethUsd ? (Number(r.gas * S.gasPrice) / 1e18) * S.px.ethUsd : null; return v != null && f != null ? v - f : Number(r.out); };
    // each source settles once: its route (or none) joins the list, which is ranked and drawn again with how many are still asked
    const settle = (r) => {
      left--; if (r) rows.push(r);
      if (!rows.length || my !== S.seq) return;
      rows.sort((a, b) => net(b) - net(a)); rows.forEach((x, i) => { x.best = i === 0; });
      done({ rows: rows.slice(), more: left });
    };
    await Promise.all([
      within(A.bestRoute({ ethCall, to: who, refundTo: hide ? PREVIEW : account || who, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Try again.')
        .then((zq) => settle(zq ? { k: 'agg', name: zq.name, note: 'onchain', out: zq.out, min: zq.min, agg: zq, gas: GAS[zq.kind] || GAS.split } : null), (e) => { zerr = e; settle(null); }),
      ...(sols.map((v) => SV.priceOf(v, sq).then((p) => settle(p ? { k: `sv:${p.id}`, name: p.name, note: 'solver', out: p.out, sv: { id: p.id, ctx: p.ctx }, gas: GAS.snwap } : null)))),
    ]);
    if (rows.length) return;
    if (zerr) throw zerr;
    return done({ rows: [], why: 'No route trades this pair deeply enough right now.' });
  }
  // a wallet token into the private balance: swapped for ETH (the best onchain route, paid to the wallet), then the least it is sure to pay made private and swapped in the pool
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
// A swap into the private balance or inside it, of `units` of the pool coin `from` (the wallet's ETH when it is 'eth' and the pay side is public).
async function privQuote(units, from, sym) {
  const wallet = from === 'eth' && !S.inP, tipP = wallet ? tipFor(units) : null;
  if (wallet && S.get === 'teth') return { rows: [{ k: 'private', name: 'Made private', note: '', out: units * E10, best: true, priv: true }], fee: null, tip: await tipP };
  const t = await getUx(), to = PK[S.get];
  idsOf(t);
  const id = (k) => (k === 'cbtc' ? String(t.pool.CBTC_ZK_ASSET_ID) : String(t.assetByTicker[POOL_TK[k]]?.assetId || '')).toLowerCase();
  const stops = from === 'eth' || to === 'eth' ? [to] : ['eth', to];
  const f0 = BigInt(await t.quoteOpFee(POOL_TK[from], 'route')), fee = stops.length > 1 ? twoDigits((f0 * 14n) / 10n) : f0;
  if (units <= fee * 2n) return { rows: [], why: `Swap more than ${fmtUnits(fee * 2n, 8, 6)} ${esc(sym)}: the relay’s fee is ${fmtUnits(fee, 8, 6)}.`, tiny: true };
  // each hop's reserves are kept, in the hop's order, so the receipt can say how deep the pool is that the swap is made in
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
// What the relay's activation of a swap exit costs besides the settle (the escrow made, the swap, the sweep), carried in the exit's fee with a
// third more at the gas price now (the relay refuses an exit whose fee does not cover both).
const ACT_GAS = 450000n;
// A private coin out of the pool: routed to tETH in the pool (unless it is tETH), that note unwrapped to the address as ETH, or to an exit
// recipe's escrow that sells the ETH on zRouter for the token, paid to the address.
async function quoteOut(units, pay, get) {
  const t = await getUx(), from = PK[S.pay], eth = isEth(S.get);
  idsOf(t);
  let tUnits = units, fee = null;
  const pools = [];
  if (from !== 'eth') {
    fee = BigInt(await t.quoteOpFee(POOL_TK[from], 'route'));
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
  const xmin = BigInt(await t.quoteOpFee('cETH', 'unwrap')) + (eth ? 0n : (ACT_GAS * gp * 4n / 3n + E10 - 1n) / E10);
  const { fee: xfee, net } = t.quoteUnwrapFee(tUnits, 'cETH', { minFee: xmin });
  if (net <= 0n) return { rows: [], why: 'Too small to leave the pool: the relay’s fee is more than it.', tiny: true };
  const wei = net * E10, via = from === 'eth' ? '' : 'Tacit pool → ';
  const base = { fee, xfee, xmin, pools, tUnits };
  if (eth) return { ...base, rows: [{ k: 'pout', name: `${via}out of the pool`, out: wei, min: wei, wei, best: true, priv: true, pout: true }] };
  const sale = await within(R.quoteEthToToken({ ethCall, to: S.to || '0x0000000000000000000000000000000000000001', tokenOut: S.get, amount: wei, slippageBps: S.slip, deadline: chainDeadline(1800) }), 20e3, 'zQuoter did not answer in time. Try again.');
  if (!sale) return { rows: [], why: `No pool trades ETH for ${esc(get.sym)} deeply enough.` };
  return { ...base, rows: [{ k: 'pout', name: `${via}${sale.name}${sale.feeBps ? ` ${Number(sale.feeBps) / 100}%` : ''}`, out: sale.amountOut, min: sale.amountLimit, wei, best: true, priv: true, pout: true }] };
}
const PK = { teth: 'eth', [lc(R.TAC)]: 'tac', [lc(R.CUSD)]: 'cusd', [lc(R.CBTC)]: 'cbtc' };
const POOL_TK = { eth: 'cETH', tac: 'cTAC', cbtc: 'cBTC', cusd: 'cUSD' };
// The pool module, one copy for the quotes and the private swap (private.js is handed it).
let uxP = null;
const getUx = () => (H.getUx ? H.getUx() : uxP ||= (async () => {
  const [{ makeConfidentialPoolUx }, dep, d] = await Promise.all([import('/confidential-pool-ux.js?cb=683e570c'), import('/confidential-deployments.js'), import('/vendor/tacit-deps.min.js')]);
  dep.setActiveNetwork('mainnet');
  return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
})().catch((e) => { uxP = null; throw e; }));
// The pool's ids of the four coins, as the quote names them (eth, tac, cusd, cbtc): read once the pool module is in.
const IDS = {};
const idsOf = (t) => { for (const k of ['eth', 'tac', 'cusd']) IDS[k] = String(t.assetByTicker[POOL_TK[k]]?.assetId || '').toLowerCase(); IDS.cbtc = String(t.pool.CBTC_ZK_ASSET_ID).toLowerCase(); return IDS; };
// What the relay asks, in ETH on top, to settle a deposit of the wallet's ETH; null when it cannot be read (the swap reads it again before sending).
const tipFor = (units) => import('/teth/read.js?cb=f00ab10f').then((m) => m.wrapQuote(units * E10)).then((x) => x.tip, () => null);
let warmed = false;
function warmPrivate() {
  if (warmed) return;
  warmed = true;
  H.warm?.();
  document.head.append(Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://mainnet.gateway.tenderly.co', crossOrigin: '' }));
  getUx().then((t) => t.quoteOpFee('cETH', 'route')).catch(() => {});
}
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };

// What the swap itself spends: for a private one the payment less the relay's fee, so the price and its impact are the pool's, not the fee's.
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
// On the front page the lane opens when both sides are put on Bitcoin, on the coin the From side holds
function syncLane() {
  if (!moving() || !$('#btc')) return;
  const on = lanePair(S.pay, atOf('pay'), S.get, atOf('get'));
  if (on === S.btc) return;
  setBtc(on);
  if (on) lane?.pair(S.pay === 'teth' ? 'teth' : 'tac');
}
// What a key last read as bridged to its Taproot address (the front page and the Bitcoin lane keep it, per key, in the browser): tETH or TAC that
// waits to be moved to the trading address before it can swap on Bitcoin. The Bitcoin switch carries a dot and says so; the lane has the move.
const BRIDGED_KEY = 'tacit-bridged-v1';
function bridgedWaiting() {
  try {
    const all = JSON.parse(localStorage.getItem(BRIDGED_KEY) || '{}') || {}, out = [];
    for (const held of Object.values(all)) {
      for (const [a, sym] of [['teth', 'tETH'], ['tac', 'TAC']]) {
        const e = held && held[a];
        if (e && Number(e.n) > 0 && /^\d+$/.test(String(e.v)) && BigInt(e.v) > 0n && !out.includes(sym)) out.push(sym);
      }
    }
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
  // slippage is a public market's: a swap made only inside the pool has none to set
  const k = kindOf(S.pay, S.get), slips = (k && k !== 'private' && !(k === 'pout' && isEth(S.get))) || (exiting() && S.pay !== S.get);
  ROOT.classList.toggle('btc', S.btc); if ($('#btc')) $('#btc').hidden = !S.btc; $('.sw-foot').hidden = !slips;
  ROOT.querySelectorAll('.mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'bitcoin' ? S.btc : !S.btc)));
}
const shownAt = (k, at) => { const t = tokenOf(k, at === 'defi'); return at === 'pay' && t ? (isEth(k) ? { ...t, icon: 'peth' } : { ...t, pvt: true }) : at === 'defi' && t && k === lc(R.TAC) ? { ...t, pvt: true } : t; };
let PAYWARM = 0;
function paintSides() {
  const pay = shownAt(S.pay, atOf('pay')), get = shownAt(S.get, atOf('get'));
  $('#pay-coin').innerHTML = `${coin(pay)}${esc(pay.sym)}<span class="car" aria-hidden="true">▾</span>`;
  $('#pay-coin').setAttribute('aria-label', `Pay with ${pay.sym}. Choose another`);
  $('#get-coin').innerHTML = `${coin(get)}${esc(get.sym)}<span class="car" aria-hidden="true">▾</span>`;
  $('#get-coin').setAttribute('aria-label', `Get ${get.sym}. Choose another`);
  const payPriv = S.inP, out = (!moveOf() && kindOf(S.pay, S.get) === 'pout') || exiting(), inPriv = S.outP;
  // out of the pool with no wallet connected here there is no address to default to: the field opens to ask for one
  // out of a pool the address it goes to is asked for in the open (with no wallet it is the only way; with one, a new address keeps the exit apart from it)
  if (out && !S.toAsked && ((exiting() && !intoPool()) || (!S.to && !S.toBad && !W.account && !intoPool()))) { S.toOpen = true; S.toAsked = true; }
  if (!out) S.toAsked = false;
  $('#f-pay').classList.toggle('priv', payPriv || atOf('pay') === 'pay'); $('#f-get').classList.toggle('priv', inPriv || atOf('get') === 'pay');
  // where each side's coin is held, in the field's corner (the coin picked decides it)
  for (const s of ['pay', 'get']) {
    const a = atOf(s), el = $(`#${s}-at`), mk = moving() ? placeMark(a) : '';
    if (!el) continue;
    el.className = `where${isPrivAt(a) ? ' priv' : ''}${mk && a !== 'wallet' ? ' pool' : ''}${moving() ? ' go-pick' : ''}`;
    const text = a === 'btc' ? 'Bitcoin' : isPrivAt(a) ? 'Private' : 'Wallet';
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
  if (a.readOnly !== fixed) { a.readOnly = fixed; a.placeholder = fixed ? '—' : '0'; }
  fitSize(a);
  $('#flip').disabled = placed() ? !pairOk(S.get, atOf('get'), S.pay, atOf('pay')) : !kindOf(S.get, S.pay);
  const bal = moveOf() || S.at.pay ? H.moves?.held?.(S.pay, atOf('pay'), moveOf()) ?? null : payPriv ? privBal(S.pay) : W.account ? S.bal[S.pay] : null, wei = parseUnits(S.amt, pay.dec);
  for (const k of [S.pay, S.get]) if (W.account && listedAt(k)?.uni && S.bal[k] === undefined && !BALQ.has(`${W.account}:${k}`)) { BALQ.add(`${W.account}:${k}`); readBalances().then(paintSides, () => {}); }
  const homes = $('#homes'), chain = $('#chain');
  if (homes) { const h = homesHtml(); homes.hidden = !h; if (h !== homes.dataset.h) { homes.innerHTML = h; homes.dataset.h = h; } }
  if (chain) { const c = chainHtml(); chain.hidden = !c; if (c !== chain.dataset.h) { chain.innerHTML = c; chain.dataset.h = c; netPicker($('#chain-sel')); } }
  const side = $('#pay-side'), mk = !S.amt && !fixed ? moveOf() : null, sizes = mk ? H.moves?.sizes?.(mk) || null : !S.amt && !fixed ? keptChips() : null;
  if (payPriv && bal == null && !S.at.pay && !moveOf()) side.innerHTML = PV?.unlocked ? `<span>Reading your private balance…${PV.readFailed ? ' <button type="button" id="pv-read">Read again</button>' : ''}</span>` : '<button type="button" id="pv-open">Your private balance</button>';
  else if (bal != null) side.innerHTML = fixed ? `<span>Balance ${esc(amtFmt(bal, pay.dec))}</span>` : `<button type="button" id="max" class="${wei && wei > bal ? 'over' : ''}">Balance ${esc(amtFmt(bal, pay.dec))}${bal > 0n ? ' · Max' : ''}</button>`;
  else if (!S.amt && !fixed && !sizes) side.innerHTML = `<span class="quick">${((poolUnits() ? QUICK_PRIV : QUICK)[pay.sym] || []).map((v) => `<button type="button" data-quick="${v}">${v}</button>`).join('')}</span>`;
  else side.textContent = '';
  // a side sitting in the Pay pool has its balances read (the page keeps them a minute), so a link to it shows what it holds
  if (moving() && atOf('pay') === 'pay' && Date.now() - PAYWARM > 30e3) { PAYWARM = Date.now(); H.moves.warm?.(); }
  const getBal = !S.outP && !S.at.get && !S.to && W.account ? S.bal[S.get] : null;
  $('#get-side').textContent = getBal ? `Balance ${amtFmt(getBal, get.dec)}` : '';
  // a move's own quick amounts (the page's sizes kept ready, marked once proved) stand where the dollar value goes until one is typed
  const v = wei && !fixed ? usdOf(S.pay, wei) : null, pu = $('#pay-usd');
  const h = sizes ? `<span class="quick">${sizes.map((x) => `<button type="button" data-quick="${esc(x.v)}"${x.rd ? ' class="rd" title="Proved already: one transaction"' : ''}>${x.rd ? '<svg aria-hidden="true"><use href="#i-bolt"/></svg>' : ''}${esc(x.v)}</button>`).join('')}</span>` : '';
  if (h) { if (pu.dataset.h !== h) { pu.innerHTML = h; pu.dataset.h = h; } }
  else { pu.dataset.h = ''; pu.textContent = v != null ? `≈ ${usd(v)}` : ''; }
}
const QUICK = { ETH: ['0.1', '0.5', '1'], TAC: ['500', '1000'], USDC: ['100', '500'], USDT: ['100', '500'], DAI: ['100', '500'], cUSD: ['100', '500'], tacUSD: ['100', '500'], cBTC: ['0.001', '0.01'], tacBTC: ['0.001', '0.01'], WBTC: ['0.005', '0.01'], WETH: ['0.1', '0.5'], wstETH: ['0.1', '0.5'], tETH: ['0.1', '0.5'] };
// The private pools are young: these are amounts a few times the relay's fee that move the price a few percent, not more.
const QUICK_PRIV = { ETH: ['0.02', '0.05', '0.1'], tETH: ['0.02', '0.05', '0.1'], TAC: ['500', '2000'], cUSD: ['50', '100'], cBTC: ['0.0005', '0.001'] };
// A pool's side by the name the quote keeps it under (the console's), and the icon its farm row is drawn with.
const PSYM = { eth: 'tETH', tac: 'TAC', cusd: 'cUSD', cbtc: 'cBTC' }, PICON = { eth: 'teth', tac: 'tac', cusd: 'cusd', cbtc: 'cbtc' };
// The private farm on the pool the swap ends in: the way to deepen it.
const farmOn = (p) => (S.farms || []).find((f) => f.pid != null && [PICON[p.a], PICON[p.b]].every((i) => f.icons.includes(i))) || null;
const fitSize = (el) => { const n = (el.value || el.textContent || '').length; el.classList.toggle('long', n > 8); el.classList.toggle('longer', n > 11); };

// A private swap's fees said once, in dollars, when each part can be priced (the relay's for the swap, the exit's, the deposit's tip), else a row
// each; the share of the swap they take is said when it is a fiftieth or more.
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
// A link to the card as it stands, a way in from the wallet (ETH into private tETH, say) or any swap: it opens on that pair with that amount.
function shareLink() {
  const mk = moveOf(), amt = String(S.amt || '').trim();
  if (!H.copy || !/^\d{0,12}(?:\.\d{1,18})?$/.test(amt) || !(Number(amt) > 0)) return null;
  if (mk) return `${location.origin}/#card=shield:${mk.replace('>', ':')}&amt=${amt}`;
  // any other swap: the pair, amount and private sides as the swap links name them (?from=&to=&amt=&private=)
  return kindOf(S.pay, S.get) && !S.btc ? `${location.origin}/?${params()}` : null;
}
// The address bar follows the same link (replaced in place, so no history entry): copying it from there works as well as the icon.
const shareSync = () => {
  const b = $('#copy'), u = shareLink();
  if (b) b.hidden = !u;
  if (!b || !history.replaceState) return;
  try {
    const at = location.pathname + location.search + location.hash, cur = new URL(location.href);
    let want;
    if (u) { const w = new URL(u); want = w.pathname + (w.hash ? cur.search : w.search || cur.search) + w.hash; if (!w.hash) { const q = new URLSearchParams(cur.search); for (const [k, v] of new URLSearchParams(w.search)) q.set(k, v); want = cur.pathname + (q.toString() ? `?${q}` : '') + cur.hash; } }
    else { const q = new URLSearchParams(cur.search); q.delete('amt'); want = cur.pathname + (q.toString() ? `?${q}` : '') + (/^#card=(?:shield|earn|send):/.test(cur.hash) ? '' : cur.hash); }
    // a private swap's amount is not written into the address bar (history, referrers, a screenshot): the copy link still carries it when the holder presses it
    if (S.inP || S.outP || laterOn(kindOf(S.pay, S.get))) { const w2 = new URL(want, location.origin); w2.searchParams.delete('amt'); want = w2.pathname + w2.search + w2.hash; }
    if (want !== at) history.replaceState(null, '', want);
  } catch { }
};
function paintQuote() {
  shareSync();
  if (moveOf()) { paintMove(); return; }
  if (exiting()) { paintExit(); return; }
  const q = S.q, out = $('#out'), get = tokenOf(S.get), pay = tokenOf(S.pay), rows = $('#rows'), rc = $('#rcpt'), go = $('#go'), ackbox = $('#ackbox');
  const r = picked(q), kind = kindOf(S.pay, S.get);
  // Swap privately from a token is priced as two swaps through the pool, any other swap as one: a quote of the other shape is asked again
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
  const list = first && kind === 'tac' ? [{ k: 'precision', name: 'Precision pool' }, { k: 'tacit-amm', name: 'Tacit pool' }, { k: 'split', name: 'Both pools' }] : (q?.rows || []);
  rows.hidden = !(list.length > 1);
  // whether routes are still being asked for, shown or not; a list that is not shown holds no rows of an older quote
  rows.toggleAttribute('data-more', q?.more > 0);
  if (rows.hidden && rows.innerHTML) rows.innerHTML = '';
  if (first && !rows.hidden) rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${esc(get.sym)} out</span></div>${list.map((x) => `<button type="button" role="radio" aria-checked="false" disabled><span class="rt"><b>${esc(x.name)}</b></span><span class="ra"><span>…</span></span><span class="rd" aria-hidden="true"></span></button>`).join('')}`;
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
    // the price reads whichever way gives a number of one or more; a press turns it around
    if (inAmt > 0 && outAmt > 0) lines.push(['Price', (outAmt >= inAmt) !== !!S.pxFlip ? `1 ${pay.sym} = ${sig(outAmt / inAmt)} ${get.sym}` : `1 ${get.sym} = ${sig(inAmt / outAmt)} ${pay.sym}`, '', depth, null, 'px-flip']);
    if (laterOn(kind)) { /* the swap out is priced again when it is made: its floor is shown then */ }
    else if (!r.priv || (r.pout && !isEth(S.get))) lines.push(['At least', `${tidy(amtFmt(r.min ?? (r.out * BigInt(10000 - S.slip)) / 10000n, get.dec))} ${get.sym}`]);
    else if (r.priv && !r.pout) lines.push(['At least', `${tidy(amtFmt(poolFloor(r.out / E10) * E10, get.dec))} ${get.sym}`]);
    if (r.sell?.rest > 0n) lines.push(['Plus', `about ${tidy(amtFmt(r.sell.rest, 18))} WETH`]);
    const routed = r.agg || r.sv ? (q.rows || []).length < 2 : r.any?.hop || r.sell || r.buy || r.pin || r.via || r.hop;
    if (routed) lines.push(['Route', r.name, '', r.agg?.quotes?.length ? `Compared with ${r.agg.quotes.length} pool${r.agg.quotes.length > 1 ? 's' : ''}` : r.sv ? 'An outside solver, settled through zRouter: it pays at least the least shown, or nothing is swapped' : '']);
    // what zQuoter's route adds over the best single pool, shown only when it is 0.1% or more
    if (r.agg?.quotes?.length) {
      const gain = Number(r.out - r.agg.quotes[0].out) / Number(r.agg.quotes[0].out);
      if (gain >= 0.001) lines.push(['Over best pool', `+${(gain * 100).toFixed(2)}%`, 'ok', r.agg.quotes[0].name]);
    }
    const tacSide = S.pay === lc(R.TAC) || S.get === lc(R.TAC);
    if (m != null && tacSide) lines.push(['Price impact', `${(Math.max(0, -m) * 100).toFixed(2)}%`, m <= GATE ? 'warn' : '']);
    else if (m != null && (!(r.agg || r.pin) || Math.abs(m) >= 0.01)) lines.push(['Against the market', m <= BAD ? `${(Math.abs(m) * 100).toFixed(1)}% below` : m >= 0.02 ? `${(m * 100).toFixed(1)}% above` : `${m >= 0 ? '+' : '−'}${(Math.abs(m) * 100).toFixed(2)}%`, m <= BAD ? 'warn' : m >= 0.02 ? 'ok' : '']);
    // a pair with no reference price here (neither side is ETH, a dollar, BTC or TAC): the rate is not checked against a market, which a thin pool could make poor
    if (m == null && (r.agg || r.sv) && !tacSide) lines.push(['Against the market', 'not checked', '', 'There is no reference price for this pair here, so a thin pool could give a poor rate. Compare the routes before sending, and use a small amount first.']);
    if (r.priv) lines.push(...feeLines(q, r));
    { const a = r.priv && aheadArgs(q), ra = r.priv && !a && routeAheadArgs(q), st = a ? PV?.aheadOf?.(a) : ra ? PV?.routeAheadOf?.(ra) : null;
      if (st) lines.push(['Proof', st === 'ready' ? (a ? 'made: one transaction' : 'made: the relay only sends it') : 'being made, about a minute', st === 'ready' ? 'ok' : '']); }
    { const nudge = r.priv && privRow(q, r); if (nudge) lines.push(nudge); }
    if (r.pout) lines.push(['Chain sees', `${get.sym} to ${S.to ? who(S.to) : W.account ? 'your wallet' : 'the address'}, not from whom`]);
    else if (r.pin) lines.push(['Chain sees', `your ${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym} for ETH, then a deposit`]);
    else if (r.priv) lines.push(['Chain sees', isEth(S.pay) ? `your ${tidy(amtFmt(q.wei, 18))} ETH deposited` : 'a swap, not whose']);
    else if (laterOn(kind)) { const dep = isEth(S.pay) ? laterDeposit(q) : laterIn(q); lines.push(['Chain sees', `your ${dep != null ? `${tidy(amtFmt(dep, pay.dec))} ` : ''}${pay.sym} going in, not where it goes`]); }   // the deposit, not the swap
    if (laterOn(kind)) {
      // through a token's own pool its relay is paid in that token; through the ETH pool, in ETH
      const hopFee = r.hop ? laterFee(q) : null, fee = r.hop ? hopFee : LATER.fee, fu = fee != null ? (r.hop ? usdOf(S.pay, fee) : usdOf(lc(R.ZERO), fee)) : null;
      const text = fee == null ? (LATER.err && !r.hop ? 'could not be read' : '…') : `${r.hop ? `${tidy(amtFmt(fee, pay.dec))} ${pay.sym}` : `${eth2(fee)} ETH`}${fu != null ? ` · about ${fu < 1 ? `$${fu.toFixed(2)}` : usd(fu)}` : ''}`;
      lines.push(['Relay fee', text, '', 'What the relay charges to send the swap out of the pool, paid from the deposit (set aside twice, for a fee that rises while it waits). The deposit itself pays the wallet’s network fee.']);
    }
    else if (!r.priv && S.gasPrice && S.px.ethUsd && relayNoEth(kind)) {
      const f = Number(GR.GAS_UNITS * S.gasPrice) / 1e18 * S.px.ethUsd * 1.5, sym = lc(S.pay) === lc(R.TAC) ? 'TAC' : tokenOf(S.pay)?.sym;
      lines.push(['Network fee', `about ${f < 1 ? `$${f.toFixed(2)}` : usd(f)}, paid in TAC or ${esc(sym)}`, 'ok', 'You hold no ETH for gas, so the relay sends this swap and takes its cost from your balance. TAC pays it when you hold enough, otherwise the token you swap. You sign once and nothing leaves your wallet unless the swap lands.']);
    }
    else if (!r.priv && r.gas && S.gasPrice && S.px.ethUsd) { const f = Number(r.gas * S.gasPrice) / 1e18 * S.px.ethUsd; lines.push(['Network fee', `about ${f < 1 ? `$${f.toFixed(2)}` : usd(f)}`]); }
    // one route shown while others are still being priced: say so, or the first to arrive looks like the only one
    if (rows.hidden && q.more > 0) lines.push(['Price', `checking ${q.more} more route${q.more > 1 ? 's' : ''}…`, '', 'A better price may still arrive. Wait a moment before sending.']);
    // with a list of routes each row says what it earns; with one route the receipt says it
    { const p = !rows.hidden ? null : laterOn(kind) ? laterPts(q, r) : rowPts(r, q); if (p) lines.push(['TAC points', ptsSaid(p, false), 'ok', p.why ? `${p.why}. An estimate: the program counts it from its own records.` : 'An estimate: the program counts it from its own records.']); }
  }
  rc.hidden = !lines.length;
  rc.innerHTML = lines.map(([k, v, c, t, href, act]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${k === 'TAC points' ? TAC_MARK : ''}${esc(k)}</dt><dd class="${c || ''}">${href ? `<a href="${esc(href)}">${esc(v)}</a>` : act ? `<button type="button" class="flip-px" data-${act} aria-label="${esc(v)}. Turn it around">${esc(v)}</button>` : esc(v)}</dd></div>`).join('');
  paintLater(q, r, kind);
  const gate = r && !q.busy && m != null && m <= GATE;
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
  const [label, can, cls] = button(q, r, kind, gate);
  go.textContent = label; go.disabled = !can; go.className = `go${cls ? ` ${cls}` : ''}`;
  if (!S.busy) { if (S.note) say(S.note.h, S.note.cls); else say(lineFor(q, r, kind)); }
}
// Far under the market into cUSD or cBTC, the vault makes them at their own price: that is the button, and swapping anyway is the box ticked above it
const mintAlt = () => (S.get === lc(R.CUSD) ? ['Borrow cUSD at $1 instead', '/vault/#btc'] : S.get === lc(R.CBTC) ? ['Mint cBTC 1:1 instead', '/vault/#btc'] : null);
const gateButton = () => { const a = mintAlt(); return a ? [a[0], true, 'priv'] : ['Accept the price above to swap', false]; };
function button(q, r, kind, gate) {
  const pay = tokenOf(S.pay), get = tokenOf(S.get);
  if (S.busy) return ['Working…', false];
  if (!kind) return ['Choose another pair', false];
  if (!S.amt || !parseUnits(S.amt, pay.dec)) return ['Enter an amount', false];
  // an address already refused is said at once, even while the price is read again
  if (S.toBad && !S.outP) return ['Check the address', false];
  if (q?.busy) return ['Finding the best price…', false];
  if (!q) return ['Finding the best price…', false];
  if (!r) return [q?.err ? 'Try again' : q?.tiny ? 'Amount too small' : 'No route', !!q?.err];
  if (S.toBusy && !S.outP) return ['Finding the address…', false];
  // a private side's address field, once something is typed in it: the swap waits for it to be a Tacit address
  const tTyped = S.outP && S.toOpen && $('#to-in').value.trim() !== '', tLabel = S.toTacit ? ` → ${esc(tacitName(S.toTacit))}` : '';
  if (kind === 'pin') {
    if (!W.account) return ['Connect wallet', true];
    if (tTyped && S.toTacitBad) return ['Check the address', false];
    if (tTyped && !S.toTacit) return ['Finding their address…', false];
    const bal = S.bal[S.pay], eth = S.bal[lc(R.ZERO)], tip = q.tip || 0n;
    if (bal != null && q.wei > bal) return [`Not enough ${pay.sym}`, false];
    if (eth != null && tip + 2n * gasKeep() > eth) return ['Leave some ETH for the network fee', false];
    if (gate && !S.ack) return gateButton();
    return [`Swap privately${tLabel}`, true, 'priv'];
  }
  if (kind === 'pout') {
    const pb = privBal(S.pay);
    if (S.toBad) return ['Check the address', false];
    const dest = outTo();
    if (!dest) return ['Add the address it goes to', false];
    if (pb != null && q.wei > pb) return [`Not enough private ${pay.sym}`, false];
    if (gate && !S.ack) return gateButton();
    return [S.to ? `Swap privately → ${who(dest)}` : 'Swap privately to your wallet', true, 'priv'];
  }
  if (kind === 'private') {
    // The wallet's ETH, and the private balance once the key is open here; the deposit's tip is part of what the wallet sends.
    const bal = isEth(S.pay) && W.account ? S.bal[S.pay] : null, tip = q.tip || 0n, pb = isEth(S.pay) ? null : privBal(S.pay);
    if (bal != null && q.wei > bal) return [`Not enough ${pay.sym}`, false];
    if (bal != null && q.wei + tip + gasKeep() > bal) return ['Leave some ETH for the network fee', false];
    if (pb != null && q.wei > pb) return [`Not enough private ${pay.sym}`, false];
    if (gate && !S.ack) return gateButton();
    if (tTyped && S.toTacitBad) return ['Check the address', false];
    if (tTyped && !S.toTacit) return ['Finding their address…', false];
    return [S.get === 'teth' && isEth(S.pay) ? (S.toTacit ? `Send privately${tLabel}` : 'Make it private') : `Swap privately${tLabel}`, true, 'priv'];
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
    if (tok && tin == null) return ['Finding the best price…', false];
    if (tok && held != null && tin > held) return [`Not enough ${pay.sym} for the deposit`, false];
    if (tok ? eth != null && 2n * gasKeep() > eth : eth != null && dep + gasKeep() > eth) return [tok ? 'Leave some ETH for the network fee' : 'Not enough ETH for the deposit', false];
    if (gate && !S.ack) return gateButton();
    const d = laterDest(), tail = d.kind === 'me' ? ' → private' : d.kind === 'tacit' ? ` → ${tacitName(S.toTacit)}` : '';
    return [`Deposit ${tok ? `${tidy(amtFmt(tin, pay.dec))} ${pay.sym}` : `${tidy(amtFmt(dep, 18))} ETH`}${tail}`, true, 'priv'];
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
  if (q?.err) return `<span class="err">${esc(q.err)}</span>`;
  if (!q?.busy && S.amt && (q?.none || !r) && q?.why) return esc(q.why);
  return '';
}
// Private, once priced, one receipt row that points somewhere better: the vault where it makes cUSD or cBTC for less than this pool asks, else the
// private farm that deepens the pool the swap ends in. → [label, text, class, tooltip, href] or null.
function privRow(q, r) {
  const m = vsMarket(q, r);
  if (m != null && m <= BAD && S.get === lc(R.CUSD)) return ['Cheaper', 'borrow cUSD at $1 →', '', 'The vault makes cUSD for a dollar', '/vault/#btc'];
  if (m != null && m <= BAD && S.get === lc(R.CBTC)) return ['Cheaper', 'mint cBTC 1:1 →', '', 'The vault makes cBTC against bitcoin', '/vault/#btc'];
  const p = q.pools?.[q.pools.length - 1], f = p && farmOn(p);
  return f ? ['Earn', `${f.apr != null ? `${aprText(f.apr)} on ` : ''}${f.name} →`, '', `Deepen ${f.name} privately: add liquidity and farm it`, `/#farm/private-${Number(f.pid)}`] : null;
}

async function go() {
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
    if (LATER.fee == null) { await readFee(); return; }                       // the relay's fee could not be read: Try again reads it again
    await laterGo(); return;
  }
  if (!W.account) { await H.connect(); return; }
  const from = W.account, P = { kind, r, q: S.q, wei: S.q.wei, floor: (r.out * BigInt(10000 - S.slip)) / 10000n, pay: S.pay, get: S.get, to: recipient() };
  if (S.toBad) return;
  // a wallet with no ETH for the gas: the swap goes through the gas relay, paid for in TAC or the token spent (dapp/gas-relay.js)
  if (['tac', 'any', 'in', 'out', 'agg'].includes(P.kind) && !isEth(P.pay)) { const plan = await relayPlan(from).catch(() => null); if (plan) { await relayGo(P, from, plan); return; } }
  S.busy = true; paintQuote();
  const before = P.to ? null : await balanceNow(P.get, from).catch(() => null);
  try {
    say('Reading the price again…');
    const tx = await prepare(P, from);
    if (!tx) return;
    say(P.to ? `Confirm the swap in your wallet. It sends the ${esc(tokenOf(P.get).sym)} to ${esc(who(P.to))}.` : 'Confirm the swap in your wallet.');
    const h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from, label: 'Swap' });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    live('Swap sent');
    const rc = await wallet.receipt(h);
    if (rc.status !== '0x1') throw Object.assign(new Error(`The transaction failed (${txLink(h)}). Nothing was swapped.`), { html: true });
    reward(rowPts(P.r, P.q));                       // the points pop once the swap has landed, not when it is sent
    const after = P.to ? null : await balanceNow(P.get, from).catch(() => null), got = before != null && after != null ? after - before : null;
    const g = tokenOf(P.get), where = P.to ? esc(who(P.to)) : 'your wallet';
    S.lastBuy = P.get === lc(R.TAC) && got > 0n ? got : null;
    if (P.to) { S.to = null; S.toOpen = false; S.toBad = ''; $('#to-in').value = ''; }
    S.amt = ''; S.q = null; S.busy = false; changed(); paint();
    say(`Done ${txLink(h)}: ${isEth(P.get) ? `about ${tidy(amtFmt(P.r.out, g.dec))} ETH to ${where}` : P.to ? `about ${tidy(amtFmt(P.r.out, g.dec))} ${esc(g.sym)} sent to ${where}` : got != null && got > 0n ? `${tidy(amtFmt(got, g.dec))} ${esc(g.sym)} in your wallet` : `${esc(g.sym)} sent to your wallet`}.${!isEth(P.get) && !P.to ? ` <button type="button" class="link" data-watch="${esc(g.addr)}">Add ${esc(g.sym)} to your wallet</button>` : ''}${S.lastBuy && H.farmIt ? ` · <button type="button" class="link" data-farm-it>Farm it</button>` : ''}`, 'ok', true);
    remember(h, `${tidy(amtFmt(P.wei, tokenOf(P.pay).dec))} ${tokenOf(P.pay).sym} → ${tidy(amtFmt(got != null && got > 0n ? got : P.r.out, g.dec))} ${g.sym}${P.to ? ` · to ${who(P.to)}` : ''}`); paintRecent();
    live('Swap done'); H.onDone?.();
    readBalances().then(() => paintSides());
    readPrices().catch(() => {});
  } catch (e) {
    S.busy = false; paintQuote();
    say(e instanceof UserStopped || e?.userStopped ? 'Cancelled in your wallet. Nothing was sent.' : `<span class="err">${e?.html ? e.message : esc(e?.message || String(e)).slice(0, 300)}</span>`, '', true);
  } finally { S.busy = false; }
}
// ── the gas relay: a swap with no ETH in the wallet ──
// TacitGasRelay (contracts/src/TacitGasRelay.sol) takes the wallet's one signed order, pulls the input and the fee with the wallet's permits, makes
// the swap and pays the output to the wallet; the settle relay sends it and keeps the fee. Only the aggregator (snwap) routes go this way: they
// pull the token from whoever calls, which is the relay contract.
let GR_LIVE = null;
// Whether the card would send this public swap through the relay: the relay is on the chain, the token paid is not ETH and the wallet holds too little ETH for the gas
const RELAY_KINDS = ['tac', 'any', 'in', 'out', 'agg'];
const relayNoEth = (kind) => !!(GR_LIVE && W.account && RELAY_KINDS.includes(kind) && !isEth(S.pay) && S.bal[lc(R.ZERO)] != null && S.gasPrice && GR.needsRelay({ ethWei: S.bal[lc(R.ZERO)], gasPriceWei: S.gasPrice }));
const relayLiveCheck = () => { if (GR_LIVE == null) rpc('eth_getCode', [GR.GAS_RELAY[1], 'latest']).then((c) => { GR_LIVE = String(c).length > 2; if (GR_LIVE) paintQuote(); }, () => {}); };
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
    // the same route the card would send, built for the relay contract as the caller (it holds the token and approves the target), paying `dest`
    RELAY_MODE = { amountIn: P.wei };
    let tx, amt;
    try { tx = await prepare({ ...P, to: dest }, relay); amt = RELAY_MODE.amountIn; } finally { RELAY_MODE = null; }
    if (!tx) return;
    if (tx.value && BigInt(tx.value) !== 0n) throw new Error('This route sends ETH, so it cannot be paid for in TAC. Nothing was sent.');
    const call = { to: tx.to, data: tx.data }, min = P.floor;
    // the fee: in TAC when the wallet holds enough and the token spent takes a permit, else in the token spent
    const permitTok = !!GR.PERMIT_TOKENS[lc(P.pay)], bal = (k) => S.bal[k] ?? 0n;
    // a fee is taken in TAC only if it is no more than a quarter of the swap's value and under $25 (when both can be priced), else in the token spent, under the same limits
    const feeOk = (k, f) => { const fu = usdOf(lc(k), f), su = usdOf(lc(P.pay), amt); return !(fu != null && fu > 25) && !(fu != null && su != null && fu * 4 > su); };
    let feeToken = P.pay, fee = await GR.feeFor({ gasPriceWei: plan.gasPrice, ethToToken: (w) => kyberEthTo(P.pay, w) });
    if (permitTok && lc(P.pay) !== tac) { const ft = await GR.feeFor({ gasPriceWei: plan.gasPrice, ethToToken: (w) => kyberEthTo(R.TAC, w) }); if (ft != null && bal(tac) >= ft && feeOk(tac, ft)) { feeToken = R.TAC; fee = ft; } }
    if (fee == null) throw new Error('Could not price the network fee. Nothing was sent.');
    if (!feeOk(feeToken, fee)) throw new Error(`The network fee is too high for this swap right now (${tidy(amtFmt(fee, lc(feeToken) === tac ? 18 : pt.dec))} ${lc(feeToken) === tac ? 'TAC' : esc(pt.sym)}). Swap more, add a little ETH, or try when gas is lower. Nothing was sent.`);
    if (lc(feeToken) === lc(P.pay) && fee * 4n > amt) throw new Error(`The network fee (${tidy(amtFmt(fee, pt.dec))} ${esc(pt.sym)}) is more than a quarter of this swap. Swap more, or add a little ETH. Nothing was sent.`);
    const total = lc(feeToken) === lc(P.pay) ? amt + fee : amt;
    if (bal(lc(P.pay)) < total) throw new Error(`Not enough ${esc(pt.sym)}: the swap and the network fee need ${tidy(amtFmt(total, pt.dec))}.`);
    const { order, data } = GR.buildOrder({ payer: from, tokenIn: P.pay, amountIn: amt, feeToken, fee, tokenOut: isEth(P.get) ? R.ZERO : P.get, minOut: min, recipient: dest, target: call.to, data: call.data });
    const feeTxt = `${tidy(amtFmt(fee, lc(feeToken) === tac ? 18 : pt.dec))} ${lc(feeToken) === tac ? 'TAC' : esc(pt.sym)}`;
    // the wallet's permits: one per token the relay pulls (ERC-2612), or one Permit2 signature for a token with none that Permit2 can already spend
    let inPermit = GR.NO_PERMIT, feePermit = GR.NO_PERMIT, p2 = GR.NO_P2;
    const dl = Math.floor(Date.now() / 1000) + 900;
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
    const r = await fetch(`${API}/gas/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: { order, data, signature, inPermit, feePermit, p2 } }), signal: AbortSignal.timeout(15e3) }).then((q) => q.json()).catch(() => null);
    // the relay saying no is final; no answer at all (a timeout, a dropped connection) is not: it may have the order, so this goes on to wait for it until it expires
    if (r && !r.ok) throw new Error(`The relay did not take the order${r?.error ? `: ${esc(r.error)}` : ''}. Nothing was spent.`);
    if (!r) say('The relay did not answer. Checking whether it took the order…');
    // wait for the relay to send it: the contract marks the order's nonce used when it runs (or when the wallet cancels it)
    const usedSel = '0xad04dc3f' + addrWord(from) + BigInt(order.nonce).toString(16).padStart(64, '0');
    const before = P.to ? null : await balanceNow(P.get, from).catch(() => null);
    const end = Number(order.deadline) * 1000 + 15e3;     // as long as the order can still be sent: a retry before then could swap twice
    say('Waiting for the relay to send it. Nothing leaves your wallet unless the swap lands.');
    let done = false;
    const t0 = Date.now();
    while (Date.now() < end && !done) {
      await new Promise((q) => setTimeout(q, 3000)); done = wordAt(await ethCall(relay, usedSel).catch(() => '0x'), 0) === 1n;
      if (!done) say(`Waiting for the relay to send it (${Math.round((Date.now() - t0) / 1000)} s). Nothing leaves your wallet unless the swap lands.`);
    }
    // the relay's transaction, from the contract's Executed event for this payer and order
    const ran = done ? await rpc('eth_getLogs', [{ address: relay, topics: ['0x533053a5fad9470861fb5df750d47e5f011faa03daba05299fe4bdc65f52d519', '0x' + addrWord(from), null, '0x' + BigInt(order.nonce).toString(16).padStart(64, '0')], fromBlock: '0x' + (BigInt(await rpc('eth_blockNumber', [])) - 200n).toString(16), toBlock: 'latest' }]).then((l) => l?.[0]?.transactionHash || null, () => null) : null;
    if (!done) throw new Error('The relay did not send it before the order expired. Nothing was spent. Try again.');
    const after = P.to ? null : await balanceNow(P.get, from).catch(() => null), got = before != null && after != null ? after - before : null;
    S.amt = ''; S.q = null; S.busy = false; changed(); paint();
    say(`Done: ${got != null && got > 0n ? `${tidy(amtFmt(got, gt.dec))} ${esc(gt.sym)} in your wallet` : `about ${tidy(amtFmt(P.r.out, gt.dec))} ${esc(gt.sym)} to ${esc(who(dest))}`}. The network fee was ${feeTxt}.${ran ? ` ${txLink(ran)}` : ''}`);
    live('Swap done'); H.onDone?.();
    readBalances().then(() => paintSides());
  } catch (e) {
    S.busy = false; paintQuote();
    say(e instanceof UserStopped || e?.userStopped ? 'Cancelled in your wallet. Nothing was sent.' : `<span class="err">${e?.html ? e.message : esc(e?.message || String(e)).slice(0, 300)}</span>`, '', true);
  } finally { S.busy = false; }
}
const balanceNow = async (k, who) => (isEth(k) ? BigInt(await rpc('eth_getBalance', [who, 'latest'])) : wordAt(await ethCall(k, '0x70a08231' + addrWord(who)), 0));

async function prepare(P, from) {
  const floorFor = (out) => { const f = (out * BigInt(10000 - S.slip)) / 10000n; return f > P.floor ? f : P.floor; };
  const dl = chainDeadline(1200), dest = P.to || from;
  const moved = () => { say('The price moved below the least you accept. Nothing was sent; the quote above is the new one.', '', true); S.busy = false; requote(true); return null; };
  let tx;
  if (P.kind === 'tac') {
    const dir = isEth(P.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: P.wei, account: from, gasPrice: await gasPrice() });
    const pick = P.r.split ? rt.split : (rt.r.ranked || []).find((v) => v.venue === P.r.venue.venue);
    if (!pick) { say('That route is no longer offered. Nothing was sent; press again for the new quote.', '', true); S.busy = false; requote(true); return null; }
    if (BigInt(pick.amountOut) < P.floor) return moved();
    const floor = floorFor(BigInt(pick.amountOut)), isSplit = !!P.r.split;
    const make = (permit) => (isSplit ? venues.buildSplit({ split: pick, account: from, to: dest, minOut: floor, deadline: dl, permit }) : venues.build({ quote: pick, dir, account: from, to: dest, minOut: floor, deadline: dl, permit }));
    tx = make();
    if (tx.approval && RELAY_MODE) { if (lc(tx.approval.spender) !== lc(tx.to)) throw new Error('This route needs a different spender, so it cannot be paid for in TAC. Pick another route or add a little ETH.'); RELAY_MODE.amountIn = P.wei; }
    else if (tx.approval) tx = await withAccess({ tx, make, from, dl, permit: pick.venue === 'precision' || isSplit });
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
        permit = R.splitSig(await signTyped(R.permitTyped({ token: P.pay, name: 'Tacit Token', version: '1', owner: from, spender: R.CONF_ROUTER, value: q.amountIn, nonce: accR.nonce, deadline: dl }), from));
      }
    }
    tx = R.buildAmm({ quote: q, account: from, to: dest, minOut: floor, deadline: dl, permit });
  } else if (P.kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: P.pay, amountIn: P.wei, account: from, slippageBps: S.slip, deadline: dl }), 15e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.tacOut < P.floor) return moved();
    const floor = floorFor(q.tacOut), access = await anyAccess(q, from);
    tx = R.buildAnyToTac({ quote: q, account: from, to: dest, minOut: floor, keccak256: keccak_256, access });
  } else if (P.kind === 'out') {
    const q = await within(R.quoteTacitToToken({ ethCall, venues, tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, account: from, to: dest, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    // the hop's calldata carries its own limit, which the builder cannot raise: it is sent only when that limit still pays at least what was shown
    if (!q || q.out < P.floor || q.min < (P.r.min ?? P.floor)) return moved();
    tx = R.buildTacitToToken({ quote: q, account: from, to: dest, venues, access: await tacitAccess(P.pay, q.amountIn, from, dl) });
  } else if (P.kind === 'in') {
    { const live = await R.ammRouteLive({ ethCall }); if (live !== true) { if (live === false) S.ammRoute = false; say(live === false ? 'That swap is not available right now. Nothing was sent.' : 'Could not check that swap right now. Nothing was sent; try again.', '', true); S.busy = false; paint(); return null; } }
    const q = await within(R.quoteTokenToTacit({ ethCall, token: P.pay, tokenOut: P.get, amountIn: P.wei, account: from, to: dest, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.out < P.floor) return moved();
    tx = R.buildTokenToTacit({ quote: q, account: from, to: dest, minOut: floorFor(q.out), access: await anyAccess(q, from) });
  } else if (P.kind === 'agg' && P.r.sv) {
    const v = SV.solverOf(P.r.sv.id), pt = tokenOf(P.pay), gt = tokenOf(P.get);
    say('Reading the price again…');
    const f = await SV.firm(v.id, { tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, decIn: pt.dec, decOut: gt.dec, slippageBps: S.slip }, P.r.sv.ctx);
    if (!f) { say(`${esc(v.name)} has no route for this right now. Nothing was sent; the quote above is the new one.`, '', true); S.busy = false; requote(true); return null; }
    if (f.out != null && f.out < P.floor) return moved();
    const min = floorFor(f.out ?? P.floor);
    const call = SV.snwapCall({ tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, to: dest, minOut: min, fwd: v.fwd, router: f.router, data: f.data });
    const why = checkSnwapCall(call.data, { to: dest, tokenIn: P.pay, tokenOut: P.get, amount: P.wei, minOut: min, executor: v.fwd });
    if (why) { AVOID.set(v.id, Date.now() + 5 * 60e3); say(`${esc(v.name)}’s route was refused (${esc(why)}). Nothing was sent; the next best route is shown.`, '', true); S.busy = false; S.hold = false; requote(true); return null; }
    // the approval or permit is asked for only now, once the route is firm and has passed the guard: a refused or moved quote leaves nothing behind
    const access = isEth(P.pay) ? null : await anyAccess({ token: P.pay, maxIn: P.wei, deadline: dl }, from, { permit2: false });
    tx = snwapTx(call, P, access);
  } else if (P.kind === 'agg') {
    const q = await within(A.bestRoute({ ethCall, to: dest, refundTo: from, tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    // the calldata's own limits are the swap's floor: it is sent only when they still pay at least what was shown
    if (!q || q.out < P.floor || q.min < (P.r.min ?? P.floor)) return moved();
    tx = await aggTx(q, from);
  } else throw new Error('Nothing to do for this pair.');
  if (RELAY_MODE) return tx;                                                 // the relay simulates the whole order before it sends
  say('Checking it first…');
  const sim = await venues.simulate({ tx, from });
  if (!sim.ok) {
    if (P.r.sv) { AVOID.set(P.r.sv.id, Date.now() + 5 * 60e3); say(`${esc(tokenOf(P.get).sym)} through ${esc(P.r.name)} would fail, so nothing was sent. The next best route is shown.`, '', true); S.busy = false; S.hold = false; requote(true); return null; }
    throw new Error('This swap would fail, so nothing was sent. Try a smaller amount or try again.');
  }
  return tx;
}
async function withAccess({ tx, make, from, dl, permit }) {
  const acc = await R.readAccess({ ethCall, token: R.TAC, owner: from, spender: tx.approval.spender });
  if (acc.allowed >= tx.approval.amount) return tx;
  if (permit) {
    say('Sign the permit for your TAC in your wallet. The signature costs nothing.');
    const sig = R.splitSig(await signTyped(R.permitTyped({ token: R.TAC, name: 'Tacit Token', version: '1', owner: from, spender: tx.approval.spender, value: tx.approval.amount, nonce: acc.nonce, deadline: dl }), from));
    return make({ value: tx.approval.amount, deadline: dl, ...sig });
  }
  await approve(R.TAC, tx.approval.spender, tx.approval.amount, from, acc.allowed);
  return tx;
}
// How a Tacit asset reaches zRouter: the allowance it already has, else a permit signed for free.
async function tacitAccess(token, amount, from, dl) {
  if (RELAY_MODE) { RELAY_MODE.amountIn = amount; return { kind: 'approved' }; }          // the gas relay holds the token and approves the target itself
  const t = tokenOf(lc(token)), acc = await R.readAccess({ ethCall, token, owner: from });
  if (acc.balance < amount) throw new Error(`Not enough ${t.sym}.`);
  if (acc.allowed >= amount) return { kind: 'approved' };
  say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
  return { kind: 'permit', value: amount, deadline: dl, ...R.splitSig(await signTyped(R.permitTyped({ token, name: 'Tacit Token', version: '1', owner: from, spender: R.ZROUTER, value: amount, nonce: acc.nonce, deadline: dl }), from)) };
}
// An aggregated route as one transaction: zQuoter's swaps, with what lets zRouter spend the token (a permit, or an allowance made first) ahead of them.
async function aggTx(q, from) {
  if (isEth(q.tokenIn)) return { to: R.ZROUTER, data: q.callData, value: q.value };
  const access = await anyAccess({ token: q.tokenIn, maxIn: q.amountIn, deadline: q.deadline }, from, { permit2: false });
  const legs = R.accessLegs(access, q.tokenIn, q.amountIn, 'aggTx');
  return { to: R.ZROUTER, data: legs.length ? R.encMulticall([...legs, ...A.legsOf(q.callData)]) : q.callData, value: q.value };
}
// An outside solver's route as one transaction: what lets zRouter spend the token (a permit, or nothing once an allowance was made), then the snwap.
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
    return { kind: 'dai', nonce: acc.nonce, expiry: q.deadline, ...R.splitSig(await signTyped(R.daiPermitTyped({ owner: from, nonce: acc.nonce, expiry: q.deadline }), from)) };
  }
  if (t.permit && acc.nonce != null) {
    say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    return { kind: 'permit', value: q.maxIn, deadline: q.deadline, ...R.splitSig(await signTyped(R.permitTyped({ token: q.token, name: await tokenName(q.token), version: t.permit, owner: from, spender: R.ZROUTER, value: q.maxIn, nonce: acc.nonce, deadline: q.deadline }), from)) };
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
async function approve(token, spender, amount, from, had) {
  const t = tokenOf(lc(token));
  if (had > 0n && t?.sym === 'USDT') {
    say('Your USDT allowance is reset to zero first (USDT asks for this).');
    const h0 = await wallet.sendTx({ to: token, data: R.encApprove(spender, 0n), from, label: 'Reset an allowance' });
    if ((await wallet.receipt(h0)).status !== '0x1') throw new Error('The reset did not go through.');
  }
  say(`Approve exactly this much ${esc(t?.sym || 'of the token')} in your wallet, once.`);
  const h = await wallet.sendTx({ to: token, data: R.encApprove(spender, amount), from, label: `Approve ${t?.sym || 'a token'}` });
  say(`Waiting for the approval ${txLink(h)}…`);
  if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
}
// ── Swap privately: ETH deposited now into the private ETH pool, swapped out later to an address (swap/later.js) ──
// Offered for a wallet ETH swap on the onchain route; the deposit is the swap, the relay's fee for the swap out (twice, for a fee that rises
// while it waits) and an extra the slider sets, so the deposit is not the swap; what is not swapped stays a private note.
const LATER = { on: false, auto: false, pct: 25, rand: Math.random(), fee: null, feeAt: 0, err: null, offers: {}, via: null, tp: {}, ethLeaves: null };
const PLANS_KEY = 'tacit-swap-later-v1';
const plans = () => { try { return (JSON.parse(localStorage.getItem(PLANS_KEY) || '[]') || []).filter((p) => p?.id); } catch { return []; } };
let LTP = null, LT = null;
const pageSigner = { get address() { return W.account; }, ready: async () => { if (!W.account) await H.connect(); await wallet.ensureMainnet(); },
  send: ({ to, data, value }) => wallet.sendTx({ to, data, value: BigInt(value || 0), from: W.account, label: 'Swap privately' }), rpc: (m, p) => rpc(m, p),
  signTyped: (typed) => signTyped(typed, W.account), receipt: (h) => wallet.receipt(h),
  // an approval and the zap in one confirmation, where the host's wallet sends batches (EIP-5792)
  canBatch: () => (wallet.canBatch ? wallet.canBatch() : false),
  get batch() { return wallet.sendCalls ? (calls, sent) => wallet.sendCalls(calls, { from: W.account, sent, label: 'Swap privately' }) : null; } };
const ltLoad = () => (LTP ||= import('/swap/later.js?cb=0375da83').then((m) => { LT = m.makeLater({ keyHex: async () => (await pvLoad()).keyHex(), signer: pageSigner, ethCall, venues, ux: getUx, sendPrivate: async (o) => (await pvLoad()).sendPrivate(o) }); LT.mod = m; return LT; }).catch((e) => { LTP = null; throw e; }));
// what Swap privately starts from: the wallet's ETH, or a token the zap sells for the deposit's ETH (any listed token zQuoter routes, or TAC through
// the Precision pool; WETH, tacUSD and tacBTC have their own ways in)
const laterPay = (k) => isEth(k) || k === lc(R.TAC) || (isListed(k) && !tacitKey(k) && k !== lc(R.WETH));
// from ETH: a token on the onchain route, or TAC through the pools the ticket uses; from a token: any listed token or ETH, or TAC, out of the pool
// (the pair alone, for the Get picker; the card's two sides must both read Wallet underneath for it to be offered)
const laterPair = (kind, pay = S.pay, get = S.get) => laterPay(pay)
  && (isEth(pay) ? kind === 'agg' || (kind === 'tac' && get === lc(R.TAC)) : (kind === 'agg' && get !== lc(R.WETH)) || kind === 'any' || kind === 'out' || kind === 'tac');
const laterFits = (kind) => !S.inP && !S.outP && laterPair(kind);
const laterOn = (kind) => LATER.on && laterFits(kind);
// ETH from the wallet buying a public token goes through the private pool by default (Swap privately): the hop is what sets this swap apart.
// A public swap stays one press away (the switch), and the way chosen is kept for this browser.
const HOP_KEY = 'tacit-swap-hop';
const hopPref = () => { try { return localStorage.getItem(HOP_KEY); } catch { return null; } };
const hopSave = (v) => { S.hopPublic = v === 'public'; LATER.auto = false; try { localStorage.setItem(HOP_KEY, v); } catch { } };
function hopDefault() {
  // the default is ETH's alone: a hop it turned on goes off once something else is paid (a hop chosen stays)
  if (LATER.on && LATER.auto && !S.busy && !isEth(S.pay)) { LATER.on = false; LATER.auto = false; return true; }
  if (LATER.on || S.hopPublic || hopPref() === 'public' || S.busy || !isEth(S.pay) || S.inP || S.outP || placed() || inPool(S.get) || outRoute(S.get) !== 'later') return false;
  LATER.on = true; LATER.auto = true; laterUp();
  return true;
}
// Swap privately turned on or off by its switch: the way is kept for the browser, the swap is priced again for it (the hop
// swaps out through zQuoter alone), and an address typed for the hop is not carried into a public swap
function hopSet(on) {
  LATER.on = on; hopSave(on ? 'private' : 'public');
  if (on) laterUp(); else clearTo();
  changed(); paint();
  if (S.q && kindOf(S.pay, S.get) === 'agg') requote(true);
}
// TAC can end in a private balance: the key's own (the field empty), or a Tacit address typed there (tacit1… or name.wei); a 0x address is paid as such
// (a swap through a token's own pool pays an address only)
const laterPool = () => LATER.on && S.get === lc(R.TAC) && laterFits(kindOf(S.pay, S.get)) && !(!isEth(S.pay) && viaToken());
const laterDest = () => (!laterPool() || S.to ? { kind: 'address' } : S.toTacit ? { kind: 'tacit', pubHex: S.toTacit.pubHex, name: S.toTacit.name || null } : { kind: 'me' });
// the gas the key's own account is handed to make the TAC private: one wrap at twice the gas price now, between 0.0005 and 0.003 ETH
const laterGas = () => { if (laterDest().kind === 'address') return 0n; const g = S.gasPrice ? 350_000n * BigInt(S.gasPrice) * 2n : 15n * 10n ** 14n; return g < 5n * 10n ** 14n ? 5n * 10n ** 14n : g > 3n * 10n ** 15n ? 3n * 10n ** 15n : g; };
// the deposit and its extra as later.js draws them (a random share around the slider's, rounded up), drawn again only when the slider moves
// (from a token the swap is the ETH its route into the pool pays, three figures rounded down)
// (through the token's own pool, the swap is the amount typed and the fee is that pool's relay's, both in the token)
const laterSwapWei = (q) => (isEth(S.pay) || picked(q)?.hop ? q?.wei : picked(q)?.via?.ethWei);
const laterFee = (q) => (picked(q)?.hop ? tokHop()?.fee ?? null : LATER.fee);
const laterAmounts = (q) => (laterSwapWei(q) && laterFee(q) != null && LT ? LT.mod.depositFor({ swapWei: laterSwapWei(q), feeWei: laterFee(q), pct: LATER.pct, rand: () => LATER.rand, gasWei: picked(q)?.hop ? 0n : laterGas() }) : null);
const laterExtra = (q) => laterAmounts(q)?.extraWei ?? 0n;
const laterDeposit = (q) => laterAmounts(q)?.depositWei ?? null;
// the token a deposit from a token takes, as later.js sizes it: the amount typed, scaled from its route's floor up to the deposit, with a little over
const laterIn = (q) => { if (picked(q)?.hop) return laterDeposit(q); const v = picked(q)?.via, dep = laterDeposit(q); return v && dep != null && v.r0.min > 0n ? (q.wei * dep * 10020n + v.r0.min * 10000n - 1n) / (v.r0.min * 10000n) : null; };
// A wallet token's own private pool (dapp/evm-pool-tokens.js), read once a minute while Swap privately is on: where it is, whether it is open,
// how many notes it holds and its relay's fee in the token. The swap goes through it once it is open and its relay quotes (unless the ETH pool
// is chosen); else through the ETH pool, and the box offers to open it.
const tokHop = () => (!isEth(S.pay) && LATER.tp[S.pay]) || null;
const hopOpen = (t = tokHop()) => !!(t?.hop?.state?.pool && t?.hop?.state?.router);
const viaToken = () => LATER.via !== 'eth' && hopOpen() && tokHop().fee != null;
// the token's pool row, for any wallet token: its own pool beside the ETH pool once it is open, else that it has none yet and the offer to open it
const viaShown = (th = tokHop()) => !!th?.hop;
const NEXT_INDEX = '0xfc7e9c6f';
function readHop(token = S.pay, force = false) {
  if (isEth(token) || !LATER.on) return;
  const t = LATER.tp[token];
  if (!force && t && (t.busy || Date.now() - (t.tried || 0) < 60e3)) return;
  LATER.tp[token] = { ...(t || {}), busy: true };
  if (LATER.ethLeaves == null) ethCall(LT_POOL, NEXT_INDEX).then((h) => { LATER.ethLeaves = Number(BigInt(h)); paintQuote(); }, () => {});
  ltLoad().then(async (lt) => {
    const hop = await lt.hopOf(token), open = hopOpen({ hop });
    // the fee at the gas the swap out is sent with, from the keeper that answers for this pool
    const [leaves, fee] = open ? await Promise.all([ethCall(hop.pool, NEXT_INDEX).then((h) => Number(BigInt(h)), () => null), lt.mod.relayFee(Number(lt.mod.HOP_GAS), undefined, hop.keeper, hop.pool).catch(() => null)]) : [0, null];
    LATER.tp[token] = { hop, leaves, fee, served: !!lt.mod.SERVED[token], told: t?.told, at: Date.now(), tried: Date.now(), busy: false };
    // open and the relay does not quote for it: named to the relay once, which keeps it (the next read, a minute on, finds it served)
    if (open && fee == null && !t?.told) { LATER.tp[token].told = true; lt.mod.notifyPool(token).catch(() => {}); }
    if (token === S.pay) paint();
  }).catch(() => { LATER.tp[token] = { ...(LATER.tp[token] || {}), busy: false, tried: Date.now() }; });
}
// Opens the wallet token's pool (one transaction from the wallet), then the swap goes through it.
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
// Swap privately warms what it uses: the private ETH pool (its fee read loads it); the Tacit pool's module only for TAC into the private balance
function laterUp() { S.toOpen = true; if (LATER.fee == null) readFee(); if (laterPool()) warmPrivate(); readHop(); }
function readFee() {
  LATER.err = null;
  return ltLoad().then((m) => m.mod.relayFee()).then((f) => { LATER.fee = f; LATER.feeAt = Date.now(); paintQuote(); }, (e) => { LATER.err = e?.message || String(e); paintQuote(); });
}
// The box under the receipt: one row that switches it and, while it is on, the buffer and the three steps it takes. Drawn again only when it is
// switched, so the slider keeps its hold while dragged; its figures are written in place.
const eth2 = (wei) => { const n = Number(wei) / 1e18; return tidy(n >= 1 ? n.toFixed(2) : n.toPrecision(2)); };
const LATER_TIP = 'Deposit now into a private pool and swap out later, so nothing onchain links your wallet to where the tokens go.';
function paintLater(q, r, kind) {
  // kept while on with no route through the pool, so it can be switched off again
  const el = $('#later'), fits = laterFits(kind) && (!!r || (LATER.on && !!q?.lt));
  el.hidden = !fits;
  if (!fits) return;
  if (LATER.on) readHop();
  const th = tokHop(), viaRow = LATER.on && !isEth(S.pay) && viaShown(th), hopOn = viaToken();
  // drawn again only when its parts change (the pool row's pills and counts are written in place, so a press keeps the focus)
  const k = `${LATER.on}:${laterPool() && laterDest().kind !== 'address'}:${viaRow ? `${S.pay}:${hopOpen(th)}` : ''}`;
  if (el.dataset.k !== k) {
    el.dataset.k = k;
    el.classList.toggle('on', LATER.on);
    el.innerHTML = `<button type="button" class="tgl" id="later-on" role="switch" aria-checked="${LATER.on}" title="${esc(LATER_TIP)}"><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><span class="tg-t"><b>Swap privately</b><small>${LATER.on ? 'your wallet and the address are not linked' : 'hides where it goes'}</small></span><span class="pill" aria-hidden="true"></span></button>`
      + (LATER.on ? (viaRow ? viaHtml(th) : '')
        + `<div class="buf" title="Deposit more than you swap, so the deposit and the swap do not match. What is not swapped stays yours, private in the pool."><span>Blur the amount<small> · the extra stays yours</small></span><input type="range" id="later-x" min="5" max="100" step="5" value="${LATER.pct}" aria-label="How much more to deposit than you swap, so the two do not match; the extra stays yours, private"><b id="later-xv"></b></div>`
        + `<ol class="st pre" aria-label="How it goes"><li><i class="mk" aria-hidden="true">1</i><span>Deposit <b id="later-dep"></b></span></li><li><i class="mk" aria-hidden="true">2</i><span>Wait</span></li><li><i class="mk" aria-hidden="true">3</i><span>Swap</span></li>${laterPool() && laterDest().kind !== 'address' ? '<li><i class="mk" aria-hidden="true">4</i><span>Private</span></li>' : ''}</ol>` : '');
  }
  if (!LATER.on) return;
  if (viaRow) viaPaint(th, hopOn);
  // the figures of a quote priced for the other route (or being priced) are shown dimmed until this one's are in
  const shape = laterOn(kind) && !isEth(S.pay) ? (hopOn ? 'hop' : 'zap') : false;
  el.classList.toggle('stale', !!q?.busy || !!(q && (q.lt || false) !== shape));
  const dep = laterDeposit(q), pay = tokenOf(S.pay), hopQ = !!picked(q)?.hop, tin = isEth(S.pay) ? null : laterIn(q);
  const inTok = (v) => `${tidy(amtFmt(v, pay.dec))} ${pay.sym}`;
  // the buffer in what is paid: the token (through its own pool, or sold into the ETH pool at the deposit's rate), else ETH
  $('#later-xv').textContent = hopQ ? `+${inTok(laterExtra(q))}` : tin != null && dep ? `+${inTok((laterExtra(q) * tin) / dep)}` : `+${eth2(laterExtra(q))} ETH`;
  $('#later-dep').textContent = dep == null ? (LATER.err ? '(fee unavailable)' : '…') : isEth(S.pay) ? `${eth2(dep)} ETH` : tin != null ? inTok(tin) : '…';
  $('#later-dep').title = dep == null ? '' : hopQ
    ? `${inTok(dep)} into the private ${pay.sym} pool as it is: the swap (${inTok(laterSwapWei(q))}), the relay’s fee for the swap out set aside twice (${inTok(2n * laterFee(q))}) and the buffer (${inTok(laterExtra(q))}), rounded up. What is not swapped stays private in that pool.`
    : `${tin != null ? `${inTok(tin)} sold for ${eth2(dep)} ETH in the same transaction: ` : ''}The swap (${eth2(laterSwapWei(q))} ETH), the relay’s fee for the swap out set aside twice (${eth2(2n * LATER.fee)} ETH) and the buffer (${eth2(laterExtra(q))} ETH), rounded up. What is not swapped stays in your private balance.`;
}
// The row that says which pool the swap goes through, from a wallet token: its own (with the notes each holds), or the offer to open it.
const LT_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
function viaHtml(th) {
  const sym = esc(tokenOf(S.pay).sym);
  if (!hopOpen(th)) return `<div class="via"><span>No private ${sym} pool yet</span><button type="button" class="link" data-open-pool title="One transaction from your wallet (about 4.4M gas) opens a private ${sym} pool for everyone, served by the relay${th.served ? '' : ' on a daily allowance of gas'}. Its first deposits have little company; until it is open, the swap goes through the ETH pool.">Open one</button></div>`;
  return `<div class="via" role="group" aria-label="Pool"><span>Pool</span><button type="button" class="vp" data-via="token"></button><button type="button" class="vp" data-via="eth"></button></div>`;
}
// The pool pills, written in place: each pool's notes (the company a deposit keeps there), which is chosen, and whether the relay serves it yet
function viaPaint(th, hopOn) {
  const sym = tokenOf(S.pay).sym, n = (x) => (x == null ? '' : ` · ${x.toLocaleString('en-US')}`), notes = (x, of) => (x == null ? `The private ${of} pool` : `${x.toLocaleString('en-US')} notes in the private ${of} pool`);
  const t = $('#later [data-via="token"]'), e = $('#later [data-via="eth"]');
  if (t) { t.textContent = `${sym}${n(th.leaves)}`; t.title = th.fee == null ? `${notes(th.leaves, sym)}. The relay is picking it up.` : notes(th.leaves, sym); t.disabled = th.fee == null; t.setAttribute('aria-pressed', String(hopOn)); }
  if (e) { e.textContent = `ETH${n(LATER.ethLeaves)}`; e.title = notes(LATER.ethLeaves, 'ETH'); e.setAttribute('aria-pressed', String(!hopOn)); }
}
const laterStep = (s) => ({ 'proving on this device': 'Proving on this device…', 'confirm in your wallet': 'Confirm the deposit in your wallet…', 'waiting for it to be mined': 'Waiting for it to land…',
  'sending through the relayer': 'The relay is sending it…', 'reading the price again': 'Reading the price again…', 'waiting for the TAC': 'Swapped. Waiting for the TAC to reach your Tacit account…',
  'making it private': 'Making it private, from your Tacit account…', 'sending it on': 'Private. Sending it on…',
  'sign the permit': 'Sign the permit in your wallet. The signature costs nothing…', 'approve': 'Approve exactly the deposit’s amount in your wallet, once…', 'reset the allowance': 'Your USDT allowance is reset to zero first (USDT asks for this)…' }[s] || `${s.charAt(0).toUpperCase()}${s.slice(1)}…`);
async function laterGo() {
  const q = S.q, to = S.to, get = tokenOf(S.get), dest = laterDest();
  if (!q || (!to && dest.kind === 'address') || laterDeposit(q) == null || S.busy) return;
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  // the relay's fee read again if it is old: the deposit is shown again when it has moved (busy meanwhile, so a second press starts nothing)
  if (picked(q)?.hop ? Date.now() - (tokHop()?.at || 0) > 120e3 : Date.now() - LATER.feeAt > 120e3) {
    const was = laterDeposit(q);
    S.busy = true;
    try { if (picked(q)?.hop) { readHop(S.pay, true); for (let i = 0; i < 40 && tokHop()?.busy; i++) await new Promise((r) => setTimeout(r, 250)); } else await readFee(); } finally { S.busy = false; }
    if (picked(q)?.hop && (Date.now() - (tokHop()?.at || 0) > 120e3 || tokHop()?.fee == null)) { say('The relay could not quote its fee right now. Try again in a moment.', 'err', true); paint(); return; }
    if (laterDeposit(q) !== was) { say('The relay’s fee moved, so the deposit is shown again. Check it and press once more.', '', true); paint(); return; }
  }
  const dep = laterDeposit(q), extra = laterExtra(q), hopQ = !!picked(q)?.hop, v = isEth(S.pay) || hopQ ? null : picked(q)?.via, tin = v ? laterIn(q) : null, pt = tokenOf(S.pay);
  if (!isEth(S.pay) && !hopQ && tin == null) return;
  const hop = hopQ ? tokHop()?.hop : null;
  if (hopQ && !hopOpen(tokHop())) { say('The private pool is not open yet.', 'err', true); return; }
  // from a token: the amount typed and its route's floor, from which later.js sizes the token sold for the deposit again, refused above what the
  // button showed by more than the slippage
  const pay = v ? { token: S.pay, sym: pt.sym, dec: pt.dec, amountIn: q.wei, min: v.r0.min, most: (tin * BigInt(10000 + S.slip)) / 10000n, slippageBps: S.slip } : null;
  S.busy = true; S.note = ''; paintQuote();
  let moved = false, popped = false;
  const earned = laterPts(q, picked(q));
  try {
    const lt = await ltLoad();
    await lt.start({ swapWei: laterSwapWei(q), extraWei: extra, token: S.get, sym: get.sym, dec: get.dec, to, toName: to && S.toName?.addr === lc(to) ? S.toName.name : null, depositWei: dep,
      dest: hop ? { kind: 'address' } : dest, gasWei: hop ? 0n : laterGas(), pay: hop ? { token: S.pay, sym: pt.sym, dec: pt.dec } : pay, hop, onStep: (s) => { say(esc(laterStep(s))); } });
    popped = true; reward(earned);                  // the points pop once the deposit has landed, not when it is sent
    LATER.on = false; S.amt = ''; S.q = null; S.to = null; S.toTacit = null; S.toTacitBad = ''; S.toOpen = false; $('#to-in').value = '';
    say('<span class="ok">Deposited.</span> The swap waits below.', 'ok', true);
  } catch (e) {
    moved = !!e?.moved;
    const stopped = e instanceof UserStopped || e?.userStopped;
    // a deposit that was sent and then failed to confirm is marked unsure by the steps: say so, so no second deposit is sent
    const unsure = !stopped && plans().some((x) => x.state === 'unsure' && Date.now() - x.at < 10 * 60e3);
    say(stopped ? 'Nothing was sent.' : `${esc(e?.message || String(e))}${unsure ? ' It may have been sent: check the steps below before depositing again.' : ''}`, stopped ? '' : 'err', true);
  }
  finally { S.busy = false; changed(); paint(); paintSteps(); H.onDone?.(); readBalances().then(paintSides, () => {}); }
  if (moved) requote(true);
}
// Each kept swap as steps: its deposit, its wait (the pool's new notes since, once the key is open here) and its swap out, with the price to
// confirm and what went wrong in the swap's own card.
const BLEND = {};
const ago_ = (t, to = Date.now()) => { const m = Math.max(0, Math.floor((to - t) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const stepLi = (state, n, title, detail = '', action = '') => `<li class="${state}"${state === 'now' ? ' aria-current="step"' : ''}><i class="mk" aria-hidden="true">${state === 'done' ? '✓' : state === 'fail' ? '!' : state === 'now' ? '' : n}</i><div class="t"><span>${title}</span>${detail ? `<small>${detail}</small>` : ''}</div>${action ? `<div class="a">${action}</div>` : ''}</li>`;
function paintSteps() {
  const el = $('#steps'), ps = plans().filter((p) => p.state !== 'done' || Date.now() - (p.doneAt || 0) < 864e5).slice(0, 6);
  el.hidden = !ps.length;
  el.innerHTML = ps.map((p) => {
    const b = BLEND[p.id], o = LATER.offers[p.id], id = esc(p.id), hd = p.hop ? Number(p.hop.dec) : 18, unit = p.hop ? p.hop.sym : 'ETH', amt = tidy(amtFmt(BigInt(p.swapWei), hd));
    const link = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer" aria-label="Transaction ${esc(h.slice(0, 10))}">${esc(h.slice(0, 8))}…↗</a>`;
    const pool = !!p.dest && p.dest.kind !== 'address', shielding = p.state === 'shielding', held = p.state === 'held';
    const deposited = !!p.depositedAt, done = p.state === 'done', swapping = p.state === 'swapping', stopped = p.state === 'stopped', waiting = p.state === 'waiting', swapped = done || shielding || held;
    const depDoubt = !deposited && !stopped && (p.state === 'unsure' || Date.now() - p.at > 3 * 60e3);
    const swapDoubt = deposited && !done && (p.state === 'unsure' || (swapping && Date.now() - (p.swapAt || p.at) > 10 * 60e3));
    const marks = b ? Math.min(5, Math.ceil(b.since / 2)) : 0;
    const meter = b ? ` <span class="mix" role="img" aria-label="Mixed with ${b.since} since yours">${[0, 1, 2, 3, 4].map((i) => `<i${i < marks ? ' class="on"' : ''}></i>`).join('')}</span>` : '';
    const left = p.swapAt || p.doneAt, inFor = left ? ago_(p.depositedAt || p.at, left) : ago_(p.depositedAt || p.at);
    const mix = b ? `${b.since ? `mixed with ${b.since} since yours` : 'nothing new in the pool yet'} · ${inFor}${meter}` : left ? inFor : `${inFor} so far`;
    const check = `<button type="button" class="btn sm ghost" data-later-check="${id}">Check it</button>`;
    const s1 = p.held ? stepLi('done', 1, 'In the pool', `${amt} ${esc(unit)}${b ? ` · ${b.since ? `mixed with ${b.since} since your latest deposit` : 'nothing deposited since your latest yet'}${meter}` : ', yours and hidden'}`, 'held privately')
      : stopped ? stepLi('fail', 1, 'Deposit', 'did not go through') : depDoubt ? stepLi('fail', 1, 'Deposit', 'not confirmed', check)
      : deposited ? stepLi('done', 1, 'Deposit', p.pay ? `${tidy(amtFmt(BigInt(p.pay.amountWei), Number(p.pay.dec)))} ${esc(p.pay.sym)} in` : '', p.depositTx ? link(p.depositTx) : 'in the pool') : stepLi('now', 1, 'Deposit', 'sending…');
    const s2 = p.held ? '' : !deposited ? stepLi('todo', 2, 'Hidden in the pool') : swapped || swapping || swapDoubt || (waiting && o) ? stepLi('done', 2, 'Hidden in the pool', mix) : stepLi('now', 2, 'Hidden in the pool', mix);
    const got = p.min ? `${tidy(amtFmt(BigInt(p.min), Number(p.dec)))} ${esc(p.sym)} or more` : '';
    const n3 = p.held ? 2 : 3, out3 = p.hop ? lc(p.token) === lc(p.hop.token) : p.token === lc(R.ZERO), tt = out3 ? 'Pay out' : 'Swap out';
    const s3 = swapped ? stepLi('done', n3, tt, got, p.swapTx ? link(p.swapTx) : 'done') : swapDoubt ? stepLi('fail', n3, tt, 'not confirmed', check)
      : swapping ? stepLi('now', n3, tt, 'sending…') : waiting && o ? stepLi('now', n3, tt, 'confirm the price')
      : waiting ? stepLi('todo', n3, tt) : stepLi('todo', n3, tt);
    const s4 = !pool ? '' : done ? stepLi('done', 4, 'Private', p.sendTx ? `sent to ${esc(p.dest.name || 'the Tacit address')}` : '', (p.sendTx || p.shieldTx) ? link(p.sendTx || p.shieldTx) : 'done')
      : held ? stepLi('fail', 4, 'Private', p.shieldTx ? 'private; not sent on' : 'not yet', `<button type="button" class="btn sm" data-later-shield="${id}">${p.shieldTx ? 'Send it on' : 'Make private'}</button>`)
      : shielding ? stepLi(S.busy ? 'now' : 'todo', 4, 'Private', S.busy ? 'making it private…' : 'the TAC is in your Tacit account', S.busy ? '' : `<button type="button" class="btn sm" data-later-shield="${id}">Make private</button>`)
      : stepLi('todo', 4, 'Private');
    const dec = Number(p.dec), self = o?.via === 'self';
    const offer = waiting && o ? `<div class="offer"><div><small>You get at least</small><b>${esc(tidy(amtFmt(o.min, dec)))} ${esc(p.sym)}</b>${o.ks ? `<small>KyberSwap ${esc(tidy(amtFmt(o.ks, dec)))}</small>` : ''}</div>`
      + `<div class="acts"><button type="button" class="btn" data-later-ok="${id}" data-via="${self ? 'self' : 'relay'}">${self ? 'Confirm from this wallet' : 'Confirm swap'}</button><button type="button" class="btn ghost" data-later-no="${id}">Not now</button></div></div>` : '';
    // the one thing to do while it waits: swap it out now (the price is shown first, and nothing is sent until it is confirmed)
    const cta = waiting && !o ? `<div class="cta"><button type="button" class="btn" data-later-go="${id}">${out3 ? 'Pay out now' : 'Swap now'}</button><small>${p.held ? 'You see the price and confirm it before anything is sent.' : b?.since ? `Mixed with ${b.since} other deposit${b.since > 1 ? 's' : ''} since yours. Swap now, or wait for more. You confirm the price first.` : 'The longer it waits, the more deposits mix with it. You confirm the price before anything is sent.'}</small></div>` : '';
    const chip = stopped || depDoubt || swapDoubt ? ['Needs a look', 'err'] : done ? ['Done', 'ok'] : swapping || shielding ? ['Swapping', ''] : !deposited ? ['Depositing', ''] : waiting && o ? ['Confirm price', ''] : waiting ? ['Ready', 'ok'] : null;
    const selfOk = p.refused && waiting && W.account && lc(W.account) !== p.from;
    const note = p.err && !done ? `<p class="note ${stopped || depDoubt || swapDoubt ? 'err' : 'warn'}" role="status">${esc(p.err)}${selfOk ? ` <button type="button" class="link" data-later-self="${id}">Send it from this wallet</button>` : ''}</p>` : '';
    const x = done ? `<button type="button" class="x" data-later-forget="${id}" aria-label="Hide">×</button>` : stopped || held ? `<button type="button" class="x" data-later-forget="${id}" aria-label="Remove">×</button>`
      : waiting ? `<button type="button" class="x" data-later-forget="${id}" data-ask="1" aria-label="Remove this swap">×</button>` : '';
    const where = p.into ? `into your private ${p.sym}` : !pool ? `to ${p.toName || shortAddr(p.to)}` : p.dest.kind === 'tacit' ? `to ${p.dest.name || `tacit1…${String(p.dest.pubHex).slice(-6)}`}, privately` : 'to your private balance';
    const held_ = BigInt(p.depositWei || 0);
    // a swap through a token's own pool counts in that token, and what is left of it is on the front page's private balances
    const poolName = p.hop ? `the private ${esc(p.hop.sym)} pool` : 'the private ETH pool', seeIt = p.hop ? `/#device/${esc(String(p.hop.id).replace(/^1-/, ''))}` : '/pay/eth/';
    const now = stopped || depDoubt || swapDoubt ? '' : !deposited ? `Depositing into ${poolName}.`
      : waiting && p.held ? `${amt} ${esc(unit)} out of ${poolName}: confirm the price below.`
      : waiting ? `${tidy(amtFmt(held_, hd))} ${esc(unit)} is in ${poolName}, yours and hidden. Swap it out when you like.`
      : swapping ? 'Swapping it out of the pool.'
      : done ? `Done. The rest of the deposit stays private in the pool. <a href="${seeIt}">See it →</a>` : '';
    return `<section class="plan" aria-label="Private swap of ${esc(amt)} ${esc(unit)} to ${esc(p.sym)}"><header><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><b>${esc(amt)} ${esc(unit)} → ${esc(p.sym)}</b><small>${esc(where)}</small>${chip ? `<em class="chip ${chip[1]}">${chip[0]}</em>` : ''}${x}</header>${now ? `<p class="now">${now}</p>` : ''}<ol class="st">${s1}${s2}${s3}${s4}</ol>${offer}${cta}${note}</section>`;
  }).join('');
}
// Swap now: the route read now (with the stand-in) and shown with KyberSwap's figure; Confirm sends it while it pays at least that.
async function laterOffer(id, via = 'relay') {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  S.busy = true; paintQuote(); say('Reading the price…');
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
  try { const q = await (await ltLoad()).check(p); say(q.state === 'done' ? 'Its swap went through.' : q.state === 'waiting' ? 'It is in the pool and waits to be swapped.' : esc(q.err || 'It did not go through.'), '', true); }
  catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); }
}
// Only ever a price that was shown: no press sends at one read behind the user's back, by the relay or from a wallet.
async function laterSwap(id, via = 'relay') {
  const p = plans().find((x) => x.id === id);
  let shown = LATER.offers[id];
  if (!p || S.busy || !shown) return;
  if (via === 'self' && !confirm('This wallet pays for the swap out and is seen sending it. Send it from this wallet?')) return;
  S.busy = true; paintQuote();
  let again = false;
  try {
    const lt = await ltLoad();
    // The key is opened first (a sign-in takes its time), then a price shown over a minute ago is read again here: the same or better goes on as
    // what was shown; a lower one is shown in its place, to confirm again. So the sign-in never turns a confirmed price into "read it again".
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    readBlend().catch(() => {});
    if (p.token !== lc(R.ZERO) && Date.now() - shown.at > 60e3) {
      say('Reading the price again…');
      const again = await lt.offer(p, { slippageBps: S.slip });
      if (again.min < shown.min) { LATER.offers[id] = { ...again, ks: shown.ks, via }; say('The price moved while you signed in. Check it and confirm again; nothing was sent.', '', true); return; }
      shown = LATER.offers[id] = { ...again, ks: shown.ks, via };
    }
    const done = await lt.swapOut(p, { shown, slippageBps: S.slip, via, onStep: (s) => say(esc(laterStep(s))) });
    delete LATER.offers[id];
    if (done.state === 'shielding') { paintSteps(); await lt.shield(done, { onStep: (s) => say(esc(laterStep(s))) }); }
    const where = done.into ? `is on its way into your private ${esc(p.sym)} pool: its relay completes it within minutes` : done.dest?.kind === 'tacit' ? `was sent privately to ${esc(done.dest.name || 'the Tacit address')}` : done.dest?.kind === 'me' ? 'is in your private balance' : `went to ${esc(shortAddr(p.to))}`;
    remember(done.swapTx, `${tidy(amtFmt(BigInt(p.swapWei), p.hop ? p.hop.dec : 18))} ${p.hop ? p.hop.sym : 'ETH'} → ${p.sym}, privately${done.into ? ', into your pool' : done.dest?.kind === 'address' || !done.dest ? `, to ${shortAddr(p.to)}` : ''}`);
    if (p.held) H.moves?.stale?.(p.hop ? lc(p.hop.token) : lc(R.ZERO), 'pay');
    say(`<span class="ok">Swapped.</span> ${esc(p.sym)} ${where}. <a href="https://etherscan.io/tx/${esc(done.swapTx)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>`, 'ok', true);
  } catch (e) {
    say(esc(e?.message || String(e)), 'err', true);
    if (e?.moved) { delete LATER.offers[id]; again = true; }
  }
  finally { S.busy = false; paint(); paintSteps(); H.onDone?.(); }
  // the price moved between the read and the send: the new one is read and shown, so Confirm is one press away, not two
  if (again) laterOffer(id, via);
}
// Make private (or send on) a swap whose TAC sits in the Tacit account: after a closed tab, or a stop
async function laterShield(id) {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  S.busy = true; paintQuote(); paintSteps();
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
  if (!ps.length || !LT || !PV?.unlocked) return;
  for (const p of ps) { try { BLEND[p.id] = await LT.blend(p); } catch { } }
  paintSteps();
}
function stepsClick(e) {
  const g = e.target.closest('[data-later-go]'), ok_ = e.target.closest('[data-later-ok]'), no = e.target.closest('[data-later-no]'), c = e.target.closest('[data-later-check]');
  const s = e.target.closest('[data-later-self]'), f = e.target.closest('[data-later-forget]'), sh = e.target.closest('[data-later-shield]');
  if (sh) laterShield(sh.dataset.laterShield);
  if (g) laterOffer(g.dataset.laterGo);
  if (ok_) laterSwap(ok_.dataset.laterOk, ok_.dataset.via === 'self' ? 'self' : 'relay').then(readBlend, () => {});
  if (no) { delete LATER.offers[no.dataset.laterNo]; say(''); paintSteps(); }
  if (c) laterCheck(c.dataset.laterCheck);
  if (s) laterOffer(s.dataset.laterSelf, 'self');
  if (f && (!f.dataset.ask || confirm(plans().find((p) => p.id === f.dataset.laterForget)?.held ? 'Remove this plan? The balance stays in the pool, yours.' : 'Remove this plan? Its deposit stays in your private ETH balance, on the private ETH page.'))) { try { localStorage.setItem(PLANS_KEY, JSON.stringify(plans().filter((p) => p.id !== f.dataset.laterForget))); } catch { } paintSteps(); }
}

// ── out of the Pay pool: what a pool holds for this key, swapped (or paid) out to an address ──────────────────────────────────────────────────
// The relay's fee for that is the pool's own: ETH's (read as Swap privately reads it) or the token's from the token pool's keeper, kept in
// LATER.tp. The swap is priced here for a random stand-in (no node is shown the address), then adopted as a plan whose deposit is done
// already, and goes through the same confirmed price as any private swap's second half.
async function exitPool(k) {
  const lt = await ltLoad();
  if (isEth(k)) {
    if (LATER.fee == null || Date.now() - LATER.feeAt > 120e3) await readFee().catch(() => {});
    return { open: true, fee: LATER.fee, hop: null };
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
  const done = (q) => { if (my !== S.seq) return; S.q = { ...q, kind: 'exit', wei, at: now() }; paint(); };
  const lt = await ltLoad(), pool = exitOf()?.wallet ? { open: true, fee: null, hop: null } : await exitPool(S.pay);
  if (!pool.open) return done({ rows: [], why: `The private ${pay.sym} pool is not open yet.` });
  if (pool.fee == null && !exitOf()?.wallet) return done({ rows: [], why: `The relay is not quoting for the private ${pay.sym} pool right now. Try again in a moment.` });
  if (S.pay === S.get) return done({ rows: [{ k: 'exit', name: `${pay.sym} itself`, out: wei, min: wei, best: true }], fee: pool.fee });
  const stand = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join(''), deadline = chainDeadline(1200);
  const out = exitOf()?.wallet && !isEth(S.pay)
    ? A.bestRoute({ ethCall, to: PREVIEW, refundTo: PREVIEW, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: S.slip, deadline })
    : isEth(S.pay)
    ? (S.get === lc(R.TAC) ? lt.mod.routeOutTac({ venues, amount: wei, to: stand, slippageBps: S.slip, deadline }) : lt.mod.routeOut({ ethCall, token: S.get, amount: wei, to: stand, slippageBps: S.slip, deadline }))
    : lt.mod.routeFrom({ ethCall, venues, tokenIn: S.pay, token: isEth(S.get) ? R.ZERO : S.get, amount: wei, to: stand, slippageBps: S.slip, deadline });
  const r = await within(out, 25e3, 'zQuoter did not answer in time. Try again.');
  if (!r) return done({ rows: [], why: `No onchain route sells ${pay.sym} for ${get.sym} right now.` });
  // into another pool: what lands is a little under the floor, less that pool's own relay fee (read and shown, not left to be found after the press)
  const dst = exitOf()?.into ? await exitPool(S.get) : null;
  if (dst && !dst.open) return done({ rows: [], why: `The private ${get.sym} pool is not open yet.` });
  const arrives = dst && dst.fee != null ? (r.min * 997n) / 1000n - dst.fee : null;
  return done({ rows: [{ k: 'exit', name: r.name, out: r.out, min: r.min, best: true }], fee: pool.fee, ...(dst ? { dstFee: dst.fee, arrives } : {}) });
}
// where an exit pays: the address typed, else the connected wallet
const exitDest = () => S.to || (W.account ? lc(W.account) : null);
function exitButton(q, r) {
  const pay = tokenOf(S.pay), get = tokenOf(S.get), wei = parseUnits(S.amt, pay.dec), wal = !!exitOf()?.wallet, bal = wal ? (W.account ? S.bal[S.pay] ?? null : null) : H.moves?.held?.(S.pay, 'pay') ?? null, same = S.pay === S.get;
  if (S.busy) return ['Working…', false];
  if (!wei) return ['Enter an amount', false];
  if (wal && !W.account) return ['Connect wallet', true];
  if (S.toBad) return ['Check the address', false];
  if (S.toBusy) return ['Finding the address…', false];
  if (q?.busy || !q) return ['Finding the best price…', false];
  if (!r) return [q?.err ? 'Try again' : 'No route', !!q?.err];
  const dest = intoPool() ? 'pool' : exitDest();
  if (!dest) return ['Add the address it goes to', false];
  if (bal != null && wei > bal) return [`Not enough private ${pay.sym}`, false];
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
    lines.push(['Chain sees', exitOf()?.wallet ? `your ${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym} swapped into a pool deposit, not whose it is` : intoPool() ? `a swap into a pool deposit, not whose it is` : `${get.sym} to ${dest ? who(dest) : 'the address'}, not from whom`]);
    if (q.arrives != null && q.arrives > 0n) lines.push(['Arrives', `about ${tidy(amtFmt(q.arrives, get.dec))} ${get.sym}, private`, '', 'A little under the least above, less the relay’s fee of that pool for completing the deposit']);
    const fu = q.fee != null ? usdOf(S.pay, q.fee) : null;
    if (q.fee != null) lines.push(['Relay fee', `${tidy(amtFmt(q.fee, pay.dec))} ${pay.sym}${fu != null ? ` · about ${fu < 1 ? `$${fu.toFixed(2)}` : usd(fu)}` : ''}`, '', 'What the relay charges to send it out of the pool, from your private balance (kept back twice, for a fee that rises before it goes).']);
  }
  rc.hidden = !lines.length;
  rc.innerHTML = lines.map(([k, v, c, t, href, act]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${k === 'TAC points' ? TAC_MARK : ''}${esc(k)}</dt><dd class="${c || ''}">${act ? `<button type="button" class="flip-px" data-${act} aria-label="${esc(v)}. Turn it around">${esc(v)}</button>` : esc(v)}</dd></div>`).join('');
  const [label, can, cls] = exitButton(q, r);
  go.textContent = label; go.disabled = !can; go.className = `go${cls ? ` ${cls}` : ''}`;
  if (!S.busy) {
    const own = r && !busy && !intoPool() && W.account && exitDest() === lc(W.account);
    // a small amount loses much of itself to the relay's fee: said when it is over a twentieth
    const heavy = r && !busy && q.fee != null && q.wei > 0n && q.fee * 20n > q.wei ? `The relay’s fee is ${Math.round(Number((q.fee * 1000n) / q.wei)) / 10}% of this. A larger amount costs less.` : '';
    if (S.note) say(S.note.h, S.note.cls); else say(lineFor(q, r, 'exit') || (heavy ? `<span class="warn">${esc(heavy)}</span>` : own ? 'To this wallet. A new address keeps it apart from it.' : ''));
  }
}
// The wallet's ETH into a private balance of another coin: the key is opened, a deposit box of that pool made, and the wallet's swap sent paying it.
async function walletIntoGo(q, r) {
  if (!W.account) { await H.connect(); return; }
  if (!r || S.busy) return;
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  const get = tokenOf(S.get), wei = q.wei;
  S.busy = true; paintQuote(); say('Opening your private balance…');
  try {
    const lt = await ltLoad();
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    const into_ = await exitPool(S.get);
    if (!into_.open || into_.fee == null) throw new Error(`The private ${get.sym} pool is not ready right now. Try again in a moment.`);
    const pay = tokenOf(S.pay);
    let out;
    if (isEth(S.pay)) out = await lt.swapIntoPool({ swapWei: wei, token: S.get, into: { hop: into_.hop }, slippageBps: S.slip, shownMin: r.min, onStep: (s) => say(esc(laterStep(s))) });
    else {
      // a wallet token: the box for this key is made for a little under the previewed floor, the route is asked again paying the box, and the swap is
      // sent only if its own floor still covers the box (its access, a permit or an allowance, as any swap's)
      const bx = await lt.depositBoxFor({ into: { hop: into_.hop }, floor: r.min });
      say('Reading the price again…');
      const from = W.account, dl = chainDeadline(1200);
      const zq = await within(A.bestRoute({ ethCall, to: bx.box, refundTo: from, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
      if (!zq || zq.min < bx.amount) throw new Error('The price moved while the deposit box was made. Nothing was sent; press again.');
      const tx = await aggTx(zq, from);
      say('Checking it first…');
      if (!(await venues.simulate({ tx, from })).ok) throw new Error('This swap would fail, so nothing was sent. Try a smaller amount or try again.');
      say('Confirm the swap in your wallet.');
      const hash = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from, label: 'Swap privately' });
      out = { hash, box: bx.box, arrives: bx.value };
    }
    remember(out.hash, `${tidy(amtFmt(wei, pay.dec))} ${pay.sym} → ${get.sym}, privately, into your pool`);
    S.amt = ''; S.q = null;
    say(`<span class="ok">Sent.</span> About ${esc(tidy(amtFmt(out.arrives, get.dec)))} ${esc(get.sym)} reach your private balance within minutes. <a href="https://etherscan.io/tx/${esc(out.hash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>`, 'ok', true);
  } catch (e) { say(e instanceof UserStopped || e?.userStopped ? 'Nothing was sent.' : esc(e?.message || String(e)), e instanceof UserStopped || e?.userStopped ? '' : 'err', true); }
  finally { S.busy = false; changed(); paint(); H.onDone?.(); H.moves?.stale?.(S.get, 'pay'); readBalances().then(paintSides, () => {}); }
}
// The press: the key is opened, the balance adopted as a plan (nothing is sent), and the swap's price is read and shown to confirm.
async function exitGo() {
  const q = S.q, r = q?.kind === 'exit' ? q.rows?.[0] : null, into = intoPool(), dest = into ? 'pool' : exitDest();
  if (exitOf()?.wallet) return walletIntoGo(q, r);
  if (!r || !dest || S.busy || S.toBad) return;
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }      // as the other private paths do
  const pay = tokenOf(S.pay), get = tokenOf(S.get), wei = q.wei;
  S.busy = true; paintQuote(); say('Opening your private balance…');
  let plan = null;
  try {
    const lt = await ltLoad();
    try { await (await pvLoad()).open(); } catch (e) { if (!e?.unlockCancelled) throw e; return; }
    const pool = await exitPool(S.pay);
    if (!pool.open || pool.fee == null) throw new Error(`The relay is not quoting for the private ${pay.sym} pool right now. Try again in a moment.`);
    const into_ = into ? await exitPool(S.get) : null;
    if (into && (!into_.open || (into_.hop && into_.fee == null))) throw new Error(`The private ${get.sym} pool is not ready right now. Try again in a moment.`);
    plan = await lt.adopt({ swapWei: wei, token: S.get, sym: get.sym, dec: get.dec, to: into ? null : dest, toName: !into && S.toName?.addr === lc(dest) ? S.toName.name : null,
      hop: pool.hop, pay: pool.hop ? { sym: pay.sym, dec: pay.dec } : null, feeWei: pool.fee, ...(into ? { into: { hop: into_.hop } } : {}) });
    S.amt = ''; S.q = null; S.to = null; S.toName = null; S.toOpen = false; $('#to-in').value = ''; say('');
  } catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; changed(); paint(); paintSteps(); }
  if (plan) { readBlend().catch(() => {}); laterOffer(plan.id); }
}

// ── a private swap, made on this card: the Tacit key is opened here (private.js), and the relay proves and sends each step ──
let PVP = null, PV = null;
const pickWallet = (list) => { const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid; };
const pvLoad = () => (PVP ||= import('/swap/private.js?cb=3f58d088').then((m) => {
  PV = m.makePrivate({ getUx, pick: pickWallet, ...H.key, onKey: (why) => { if (why) say(esc(why), 'err', true); else { PV.read().then(paint, () => {}); if (plans().some((x) => x.state === 'waiting')) ltLoad().then(readBlend, () => {}); } paint(); } });
  PV.mod = m;
  return PV;
}).catch((e) => { PVP = null; throw e; }));
// A swap of the wallet's ETH into the private balance through one pool is proved ahead (private.js `ahead`) once its quote has stood a moment
// with the key open: the press then sends one transaction that deposits it and settles the swap.
const aheadArgs = (q) => { const p = q?.pools; const units = parseUnits(S.amt, 8); return q?.kind === 'private' && !S.inP && isEth(S.pay) && S.get !== 'teth' && p?.length === 1 && units && IDS[p[0].b] ? { wei: units * E10, toAsset: IDS[p[0].b], feeBps: p[0].feeBps } : null; };
// Wallet ETH into the private balance through one pool: the sizes kept ready (private.js `keep`), proved as the card shows the pair with the
// key open and proved again a minute on if the pool has traded; they stand where the dollar value goes, marked once proved.
const KEEP_SWAP = ['0.01', '0.1'];
const KS = { tier: {}, at: 0 };
const keptPair = () => (!S.inP && isEth(S.pay) && S.get !== 'teth' && PK[S.get] && kindOf(S.pay, S.get) === 'private' && IDS[PK[S.get]] && (PV?.unlocked || H.key?.session?.unlocked) ? IDS[PK[S.get]] : null);
function keptChips() {
  const to = keptPair(), f = to ? KS.tier[to] : null;
  if (!to) return null;
  if (f === undefined) { KS.tier[to] = null; pvLoad().then((pv) => pv.tierOf(to)).then((x) => { KS.tier[to] = x; paint(); }, () => {}); }
  if (Date.now() - KS.at > 60e3 && f) { KS.at = Date.now(); pvLoad().then((pv) => pv.keep({ sizes: KEEP_SWAP.map((v) => String(parseUnits(v, 8) * E10)), toAsset: to, feeBps: f, onReady: paint })).catch(() => {}); }
  return f ? KEEP_SWAP.map((v) => ({ v, rd: PV?.aheadOf?.({ wei: parseUnits(v, 8) * E10, toAsset: to, feeBps: f }) === 'ready' })) : null;
}
// A swap from the private balance into another private coin is proved ahead the same way (private.js `routeAhead`): the plan the press will send.
const routeAheadArgs = (q) => {
  if (q?.kind !== 'private' || !S.inP || !S.outP || isEth(S.pay) || !q.pools?.length) return null;
  const r = picked(q), units = parseUnits(S.amt, 8), k0 = PK[S.pay];
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
// The key's private balance of a coin, in its 18 decimals: null until the key is open here and its notes are read.
const privBal = (k) => { const id = IDS[PK[k]]; return PV?.held && id ? PV.of(id).value * E10 : null; };
// A page that holds the key itself (the front page): a private side reads the balance at once, with nothing to open on the card.
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
// An exit whose swap did not run (the relay refused it, or it is slow): kept in this browser until its escrow is empty, so the card can offer
// to run the swap from a wallet until the recipe's deadline, or to send the escrow's ETH on to the address after it. Public data only.
const EXITS_KEY = 'tacit-swap-exits-v1';
const readExits = () => { try { return (JSON.parse(localStorage.getItem(EXITS_KEY) || '[]') || []).filter((x) => x?.recipe && /^0x[0-9a-f]{40}$/.test(x.escrow || '')).slice(0, 8); } catch { return []; } };
const keepExits = (xs) => { try { localStorage.setItem(EXITS_KEY, JSON.stringify(xs.slice(0, 8))); } catch { } };
const saveExit = (x) => keepExits([x, ...readExits().filter((y) => y.escrow !== x.escrow)]);
function exitLine(x) {
  const late = now() > Number(x.recipe.deadline), when = new Date(Number(x.recipe.deadline) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const to = shortAddr(x.recipe.finalRecipient);
  return `${esc(x.what || 'Your ETH')} is out of the pool, at its escrow ${addrLink(x.escrow)}, but the swap to ${esc(x.sym || 'the token')} has not run${x.why ? ` (${esc(String(x.why).slice(0, 120))})` : ''}. `
    + (late ? `<button type="button" class="link" data-exit-back="${esc(x.escrow)}">Send it to ${esc(to)} as ETH</button>.`
      : `<button type="button" class="link" data-exit-run="${esc(x.escrow)}">Run the swap from your wallet</button> (anyone may: the wallet that does is seen doing it), or after ${esc(when)} send it to ${esc(to)} as ETH.`);
}
const addrLink = (a) => `<a href="https://etherscan.io/address/${esc(a)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(a))}↗</a>`;
async function exitAct(escrow, back) {
  const x = readExits().find((y) => y.escrow === escrow);
  if (!x || S.busy) return;
  if (!W.account) { await H.connect(); return; }
  S.busy = true; paintQuote();
  try {
    const calls = await (await pvLoad()).exitCalls(x.recipe);
    say('Confirm it in your wallet…');
    const h = await wallet.sendTx({ to: calls.router, data: back ? calls.reclaim : calls.activate, from: W.account, label: back ? 'Send it as ETH' : 'Run the swap' });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error('It did not go through. Nothing was lost but its network fee.');
    keepExits(readExits().filter((y) => y.escrow !== escrow));
    remember(h, back ? `Sent ${x.what || 'the ETH'} to ${shortAddr(x.recipe.finalRecipient)} as ETH` : `Swapped ${x.what || 'the ETH'} for ${x.sym || 'the token'} to ${shortAddr(x.recipe.finalRecipient)}`);
    say(`<span class="ok">Done.</span> ${back ? 'The ETH went' : 'The swap ran and paid'} to ${esc(shortAddr(x.recipe.finalRecipient))}. ${txLink(h)}`, 'ok', true);
  } catch (e) { say(esc(e instanceof UserStopped || e?.userStopped ? 'Nothing was sent.' : e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); }
}
// On a visit, an exit still waiting at its escrow is said again; one whose escrow has emptied (it ran, or was sent on) is forgotten.
async function checkExits() {
  const xs = readExits(), left = [];
  for (const x of xs) {
    const bal = await rpc('eth_getBalance', [x.escrow, 'latest']).then(BigInt, () => null);
    if (bal == null || bal > 0n || now() - (x.at || 0) < 900) left.push(x);
  }
  keepExits(left);
  const w = left.find((x) => now() - (x.at || 0) >= 120);
  if (w && !S.busy && !S.note) say(exitLine(w), 'err', true);
}
async function privateGo(r, kind = 'private') {
  if (kind === 'pin') return pinGo(r);
  let q = S.q;
  const fromWallet = isEth(S.pay), units = parseUnits(S.amt, 8);
  if (!q || !units) return;
  if (fromWallet && !W.account) { await H.connect({ key: true }); return; }          // a private swap needs the Tacit wallet: a first visit opens it as the wallet connects
  // a quote over a minute old is read again here, and the press goes on while what it pays still clears the least shown
  if (now() - (q.at || 0) > 60) {
    say('Reading the price again…');
    const least = poolFloor(r.out), my = ++S.seq;
    await quote(my, q.wei).catch(() => {});
    const nr = my === S.seq && S.q && !S.q.err ? picked(S.q) : null;
    if (!nr || nr.k !== r.k || nr.out < least) { say('The price moved. Check it and press once more.', '', true); return; }
    q = S.q; r = nr;
  }
  const pay = tokenOf(S.pay), get = tokenOf(S.get), what = `${tidy(plain(units, 8))} ${pay.sym}`, payKey = S.pay, earned = rowPts(r, q);
  let popped = false;
  const step = (k, h) => (say({
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
      const k0 = PK[S.pay], to = outTo(), tokenOut = S.get, eth = isEth(S.get), slip = S.slip;
      if (!to) throw new Error('Name the address it goes to, or connect a wallet. Nothing was sent.');
      const plan = { asset: IDS[k0], units, ticker: POOL_TK[k0], fee: q.fee ?? 0n, eth: IDS.eth,
        path: k0 === 'eth' ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
        minOut: poolFloor(q.tUnits), label: `Swap ${what} for ${get.sym} to ${who(to)}`,
        out: { token: eth ? null : tokenOut, to, minFee: q.xmin, min: r.min, wei: r.wei,
          quote: (wei) => R.quoteEthToToken({ ethCall, to, tokenOut, amount: wei, slippageBps: slip, deadline: chainDeadline(1800) }) } };
      let res;
      try { res = await pv.swapOut(plan, { say: step }); }
      catch (e) { if (e?.stuck) { e.stuck = { ...e.stuck, what: `About ${tidy(amtFmt(r.wei, 18))} ETH`, sym: get.sym, at: now() }; saveExit(e.stuck); } throw e; }
      const got = `${tidy(amtFmt(res.out, get.dec))} ${get.sym}`;
      if (res.txHash) remember(res.txHash, `Swapped ${what} for ${got} to ${who(to)}`);
      if (S.pay === payKey) { S.amt = ''; S.q = null; }
      if (S.to === to) { S.to = null; S.toBad = ''; $('#to-in').value = ''; }
      say(`<span class="ok">Done.</span> About ${esc(got)} went to ${esc(who(to))}.${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
      return;
    }
    const k0 = fromWallet ? 'eth' : PK[S.pay];
    const plan = { wallet: fromWallet, wei: units * E10, units, asset: IDS[k0], ticker: POOL_TK[k0], fee: q.fee ?? 0n,
      path: S.get === 'teth' && fromWallet ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
      minOut: poolFloor(r.out / E10), label: `Swap ${what} for ${get.sym} privately`, sendTo: S.toTacit, outTicker: POOL_TK[PK[S.get]] };
    const res = await pv.swap(plan, { wallet, from: W.account, say: step });
    if (!popped) { popped = true; reward(earned); }                 // the points pop once the swap has gone through, not when its first step is sent
    const got = res.made != null ? `${tidy(plain(res.made, 8))} tETH` : `${tidy(amtFmt(res.out * E10, 18))} ${get.sym}`;
    if (res.txHash) remember(res.txHash, res.made != null ? `Made ${what} private` : `Swapped ${what} for ${got} privately`);
    if (S.pay === payKey) { S.amt = ''; S.q = null; }
    const where = res.sent ? `was sent to ${esc(res.sent.to || tacitName(S.toTacit))}. They claim it in their Tacit wallet.` : 'is in your private balance.';
    if (res.sent) { S.toTacit = null; S.toTacitBad = ''; S.toOpen = false; $('#to-in').value = ''; }
    say(`<span class="ok">Done.</span> ${res.made != null ? '' : 'About '}${esc(got)} ${where}${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
  } catch (e) {
    const m = PV?.mod;
    if (e?.unlockCancelled) say('');
    else if (e instanceof UserStopped || e?.userStopped || e?.code === 4001) say('Nothing was sent.', '', true);
    else if (e?.code === 'short') say(`Not enough private ${esc(pay.sym)}${e.most ? `: at most ${esc(tidy(plain(e.most, 8)))}, after the relay’s fee to cut a note to the amount` : ''}.`, 'err', true);
    else if (e?.stuck) say(exitLine(e.stuck), 'err', true);
    else if (e?.stayed) say(esc(e.message), 'err', true);
    else if (e?.pending) say(esc(e.message), 'err', true);
    else if (e?.kept) { if (S.pay === payKey) { S.inP = true; S.pay = 'teth'; S.amt = fitAmt(S.amt, true); S.q = null; if (!kindOf(S.pay, S.get)) fit('pay'); } say(`${esc(e.message)} Press Swap privately to swap it from there.`, 'err', true); }
    else if (e?.deposit && !e.deposit.landed) say(`${esc(m ? m.relayWords(e) : e.message)} Your deposit was sent ${e.deposit.hash ? txLink(e.deposit.hash) : ''} and is not confirmed yet. There is no need to send it again: once it lands, <a href="/teth/">finish it on the tETH page →</a>`, 'err', true);
    else if (e?.deposit) say(`${esc(m ? m.relayWords(e) : e.message)} Your ETH is in the Tacit pool ${e.deposit.hash ? txLink(e.deposit.hash) : ''}, not lost: <a href="/teth/">finish it on the tETH page →</a>`, 'err', true);
    else say(esc(m ? m.relayWords(e) : e?.message || String(e)), 'err', true);
  } finally {
    S.busy = false; changed(); paint(); H.onDone?.();
    if (S.pay !== payKey || !S.q) requote(true);
    PV?.read(true).then(paint, () => {});
    if (fromWallet) readBalances().then(paintSides, () => {});
  }
}
// A wallet token into the private balance: the best onchain route to ETH, paid to the wallet and held to at least the ETH the quote made
// private; then that ETH deposited and swapped in the pool, as a swap from the wallet's ETH is (private.js). Stopped between the two, the
// token is ETH in the wallet, and the card says so.
async function pinGo(r) {
  const q = S.q, from = W.account;
  if (!q?.pin || !q.ethIn) return;
  if (!from) { await H.connect({ key: true }); return; }
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  // the coins are the ones pressed for, read once: the pair cannot change while this runs, and nothing after an await reads it again
  const pay = tokenOf(S.pay), get = tokenOf(S.get), what = `${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym}`, payKey = S.pay, getKey = S.get;
  S.busy = true; S.note = ''; paintQuote();
  let h = null, swapped = false;
  try {
    const pv = await pvLoad(), t = await getUx();
    idsOf(t);
    await pv.open();
    say('Reading the price again…');
    // the relay's state and the pool's price are asked before the token is sold for ETH: a held relay or a price past the quote stops it here, with the token still in the wallet
    await pv.relayOpen();
    if (getKey !== 'teth') await pv.priceOk(IDS.eth, q.ethIn / E10, (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })), q.fee ?? 0n, poolFloor(r.out / E10));
    const r1 = await within(A.bestRoute({ ethCall, to: from, refundTo: from, tokenIn: payKey, tokenOut: R.ZERO, amountIn: q.wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!r1 || r1.min < q.ethIn) { say('The price moved below what was quoted. Nothing was sent; the quote above is the new one.', '', true); return; }
    const tx = await aggTx(r1, from);
    say('Checking it first…');
    if (!(await venues.simulate({ tx, from })).ok) throw new Error('The swap to ETH would fail, so nothing was sent. Try a smaller amount or try again.');
    say(`Confirm the swap of ${esc(what)} to ETH in your wallet…`);
    h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from, label: 'Swap to ETH' });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw Object.assign(new Error(`The swap to ETH failed (${txLink(h)}). Your ${esc(what)} is still in your wallet; nothing was lost but its network fee.`), { html: true });
    swapped = true;
    remember(h, `${what} → ETH, to be made private`);
    const plan = { wallet: true, wei: q.ethIn, units: q.ethIn / E10, asset: IDS.eth, ticker: 'cETH', fee: q.fee ?? 0n,
      path: getKey === 'teth' ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
      minOut: poolFloor(r.out / E10), label: `Swap ${what} for ${get.sym} privately`, sendTo: S.toTacit, outTicker: POOL_TK[PK[getKey]] };
    const step = (k, x) => say({ prepare: 'Swapped to ETH. Preparing the deposit…', confirm: 'Confirm the deposit in your wallet…', sent: `Deposit sent ${x ? txLink(x) : ''}. Waiting for it to land…`,
      proving: `Deposited ${x ? txLink(x) : ''}. The relay is making it private, about a minute…`, note: 'Private now. Finding its note…', route: 'The relay is proving your private swap, about a minute…', ahead: 'Finishing the proof of your swap…', posted: 'The relay is sending your private swap, its proof is made, a few moments…', own: 'Proving your swap with your own prover, about a minute. Nothing has left your wallet yet…', check: 'Checking it first…', swap: `Deposited ${x ? txLink(x) : ''}. The relay is proving your swap, about a minute…`, send: 'The relay is sending it on to them, about a minute…' }[k] || '');
    const res = await pv.swap(plan, { wallet, from, say: step });
    if (!popped) { popped = true; reward(earned); }
    const got = res.made != null ? `${tidy(plain(res.made, 8))} tETH` : `about ${tidy(amtFmt(res.out * E10, 18))} ${get.sym}`;
    if (res.txHash) remember(res.txHash, `Swapped ${what} for ${got} privately`);
    if (S.pay === payKey) { S.amt = ''; S.q = null; }
    const where = res.sent ? `was sent to ${esc(res.sent.to || tacitName(S.toTacit))}. They claim it in their Tacit wallet.` : 'is in your private balance.';
    if (res.sent) { S.toTacit = null; S.toTacitBad = ''; S.toOpen = false; $('#to-in').value = ''; }
    say(`<span class="ok">Done.</span> ${esc(got)} ${where}${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
  } catch (e) {
    const m = PV?.mod, why = esc(m ? m.relayWords(e) : e?.message || String(e));
    // after the swap to ETH the card is turned to what is now held, so a second press never swaps the token again
    const turn = (inP, k, amt) => { S.inP = inP; S.pay = k; S.amt = amt; S.q = null; if (!kindOf(S.pay, S.get)) fit('pay'); };
    // once the token has been sold to ETH, every ending turns the card to that ETH (below): a cancelled unlock or a stay no longer leaves it on the token
    if (e?.unlockCancelled && !swapped) say('');
    else if ((e instanceof UserStopped || e?.userStopped) && !swapped) say('Nothing was sent.', '', true);
    else if (e?.html && !swapped) say(e.message, 'err', true);
    else if (e?.stayed && !swapped) say(esc(e.message), 'err', true);
    else if (e?.kept) { turn(true, 'teth', tidy(plain(q.ethIn / E10, 8))); say(`${esc(e.message)} Press Swap privately to swap it from there.`, 'err', true); }
    else if (e?.deposit && !e.deposit.landed) { turn(false, lc(R.ZERO), ''); say(`${why} Your deposit was sent ${e.deposit.hash ? txLink(e.deposit.hash) : ''} and is not confirmed yet. There is no need to send it again: once it lands, <a href="/teth/">finish it on the tETH page →</a>`, 'err', true); }
    else if (e?.deposit) { turn(false, lc(R.ZERO), ''); say(`${why} Your ETH is in the Tacit pool ${e.deposit.hash ? txLink(e.deposit.hash) : ''}, not lost: <a href="/teth/">finish it on the tETH page →</a>`, 'err', true); }
    else if (swapped) { turn(false, lc(R.ZERO), tidy(plain(q.ethIn, 18))); say(`Your ${esc(what)} is ETH in your wallet now ${txLink(h)}, but it was not made private: ${e instanceof UserStopped || e?.userStopped ? 'the deposit was cancelled' : why}. The card now swaps from that ETH: press again to try.`, 'err', true); }
    else if (h) say(`The swap to ETH was sent ${txLink(h)} but its result could not be read: ${why}. Check your wallet before swapping again.`, 'err', true);
    else say(e?.html ? e.message : why, 'err', true);
  } finally {
    S.busy = false; changed(); paint(); H.onDone?.();
    if (!S.q) requote(true);
    PV?.read(true).then(paint, () => {});
    readBalances().then(paintSides, () => {});
  }
}

let pkClose = null, pkIO = null;
// a picker row's key: a coin and the place it is held, but for the wallet's (a plain address)
const ATK = /^@(pay|btc|defi|wallet):(.+)$/;
function openPicker(side) {
  pkClose?.({ keep: true });
  // the list arriving while the picker is open draws it again, and the focus stays where it was
  if (!TL.at) loadList().then(() => {
    if ($('#pk').hidden || $('#pk-q')?.value || !TL.rows.length) return;
    const a = document.activeElement, k = $('#pk').contains(a) ? (a.dataset?.k || (a.classList.contains('pk-x') ? 'x' : '')) : '';
    openPicker(side);
    if (k) setTimeout(() => (k === 'x' ? $('#pk .pk-x') : $(`#pk [data-k="${k}"]`))?.focus(), 0);
  });
  const pk = $('#pk'), at = atOf(side), cur = side === 'pay' ? S.pay : S.get;
  // every coin the side can take, under where it is held: the wallet's (ETH, the tokens with private pools and what the wallet holds first), the
  // DeFi pool's, on the front page the Pay pool's and Bitcoin's, then the rest of the token list. A key names its place (@defi:, @pay:, @btc:).
  const wl = held(listed().map((t) => t.addr)), top = wl.filter((k) => tacitPooled(k) || S.bal[k] > 0n), rest = wl.filter((k) => !top.includes(k));
  const groups = [['Wallet', top, false, 'wallet'], [moving() ? 'Private · DeFi pool' : 'Private', POOL_COINS.map((k) => `@defi:${k}`), true, 'defi'],
    ...(moving() ? [['Private · Pay pool', placeCoins(side, 'pay').map((k) => `@pay:${k}`), true, 'pay'], ['Bitcoin', placeCoins(side, 'btc').map((k) => `@btc:${k}`), false, 'btc']] : []),
    ['More tokens', rest, false, 'more']].filter(([, ks]) => ks.length);
  // a row of anchors to the places, so the private balances are one press from the top of a long list
  const JUMP = { wallet: 'Wallet', defi: 'DeFi pool', pay: 'Pay pool', btc: 'Bitcoin' }, jumps = groups.filter(([, , , id]) => JUMP[id]);
  const keys = groups.flatMap(([, ks]) => ks), cs = H.moves?.chains?.() || [], chains = cs.length;
  const SUB = { teth: 'ETH, made private', [lc(R.TAC)]: 'Tacit’s token', [lc(R.CUSD)]: 'a dollar borrowed against cBTC', [lc(R.CBTC)]: 'bitcoin, 1:1 with BTC' };
  const PLACE_TAG = { wallet: 'Public', defi: 'Private', pay: 'Private', btc: 'Bitcoin' };
  const row = (key) => {
    const m = ATK.exec(key), a = m ? m[1] : 'wallet', k = m ? m[2] : key, t = shownAt(k, a);
    if (!t) return '';
    // dimmed where it goes nowhere: a From coin with no To for it, a To coin the From side cannot reach (picked, the From side is mended)
    const ok = !moving() || (side === 'pay' ? goes('pay', k, a) : pairOk(S.pay, atOf('pay'), k, a));
    // each row says where its coin is held, so two rows for one coin (a wallet's USDC, the Pay pool's USDC) read apart even with the group headings gone (while searching)
    const sub = a === 'defi' ? `DeFi pool${SUB[k] ? ` · ${esc(SUB[k])}` : ''}` : a === 'pay' ? `Pay pool · ${isEth(k) && chains > 1 ? `pays on ${chainMarks(cs)}` : k === USDC_K || k === USDT_K ? 'a dollar, pays on Ethereum' : 'pays on Ethereum'}` : a === 'btc' ? 'at your Bitcoin address' : esc((t.custom ? `${t.addr.slice(0, 8)}…${t.addr.slice(-6)}` : t.name) || '');
    return `<button type="button" class="pk-r${ok ? '' : ' off'}"${ok ? '' : ' aria-disabled="true"'} data-k="${esc(key)}" aria-current="${a === at && k === cur}">${coin(t, '', a === 'wallet')}<span><b>${esc(t.sym)}${PLACE_TAG[a] ? `<i class="pw pw-${a}">${PLACE_TAG[a]}</i>` : ''}</b><small>${sub}</small></span><em>${rowBal(side, key)}</em></button>`;
  };
  warmPrivate(); H.moves?.warm?.();
  pkSide = side;
  pk.innerHTML = `<div class="pk-s" role="dialog" aria-modal="true" aria-label="${side === 'pay' ? (moving() ? 'From' : 'Pay with') : moving() ? 'To' : 'Get'}"><div class="pk-h"><b>${side === 'pay' ? (moving() ? 'From' : 'Pay with') : moving() ? 'To' : 'Get'}</b><button type="button" class="pk-x" aria-label="Close">×</button></div>${keys.some((k) => !inPool(k) && !/^@/.test(k)) ? '<input class="pk-q" id="pk-q" placeholder="Search, or paste a token address" autocomplete="off" spellcheck="false" aria-label="Search tokens or paste an address">' : ''}${moving() && jumps.length > 2 ? `<div class="pk-jump" role="group" aria-label="Go to">${jumps.map(([, , , id]) => `<button type="button" data-jump="${id}" title="${esc(PLACE_TIP[id] || '')}">${placeMark(id)}${JUMP[id]}</button>`).join('')}</div>` : ''}<div class="pk-l" id="pk-l">${groups.map(([g, ks, priv, id]) => `<p class="pk-g${priv ? ' priv' : ''}${moving() && priv ? ' pool' : ''}" data-g="${id}" title="${esc(moving() ? PLACE_TIP[id] || '' : '')}">${moving() ? placeMark(id) : ''}${esc(g)}</p>${moving() && PLACE_NOTE[id] ? `<p class="pk-d">${esc(PLACE_NOTE[id])}</p>` : ''}${ks.map(row).join('')}`).join('')}<p class="pk-n" id="pk-n"></p></div></div>`;
  pk.hidden = false;
  // the logos of the rows in the list's view (and a little past it), fetched as they come into it
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
  pk.querySelector('.pk-x').onclick = () => close();
  pk.onclick = (e) => {
    if (e.target === pk) return close();
    const j = e.target.closest('[data-jump]');
    if (j) { const l = $('#pk-l'), g = l.querySelector(`.pk-g[data-g="${j.dataset.jump}"]`); if (g) l.scrollTo({ top: g.offsetTop - l.offsetTop - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (b.dataset.add) { const t = JSON.parse(b.dataset.add); S.custom = [t, ...S.custom.filter((x) => x.addr !== t.addr)].slice(0, 20); try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(S.custom)); } catch { } readBalances().then(paintSides); }
    const m = ATK.exec(k);
    pickAt(side, m ? m[1] : 'wallet', m ? m[2] : k); close();
  };
  const qEl = $('#pk-q');
  if (qEl) {
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); [...pk.querySelectorAll('.pk-r')].filter((b) => !b.hidden).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))[0]?.click(); } });
    let seq = 0, words = null;
    qEl.oninput = async () => {
      const v = qEl.value.trim(), my = ++seq, l = $('#pk-l');
      const x = v.toLowerCase(), on = !!v && !/^0x/i.test(v);
      words ||= [...l.querySelectorAll('.pk-r')].map((b) => { const t = tokenOf(String(b.dataset.k).replace(ATK, '$2')); return { b, sy: t ? [lc(t.sym), lc(t.psym || '')] : null, nm: lc(t?.name || '') }; });
      for (const { b, sy, nm } of words) {
        const rank = !sy ? 0 : sy.includes(x) ? 1 : sy.some((y) => y && y.startsWith(x)) ? 2 : nm.startsWith(x) ? 3 : `${sy.join(' ')} ${nm}`.includes(x) ? 4 : 0;
        b.hidden = on && !rank; b.style.order = on ? rank : '';
      }
      l.querySelectorAll('.pk-g, .pk-d').forEach((g) => { g.hidden = on; });
      l.classList.toggle('srch', on);                 // with the headings gone, every row names its place (CSS: .pw)
      const jp = $('#pk .pk-jump'); if (jp) jp.hidden = on;
      l.querySelector('[data-add]')?.remove();
      // a search that matches nothing says so (and what to do), and a half-pasted address says what is missing, rather than an empty or unchanged list
      $('#pk-n').textContent = on && words.every(({ b }) => b.hidden) ? `Nothing matches “${v.slice(0, 24)}”. Paste a token’s address to add it.` : /^0x/i.test(v) && !/^0x[0-9a-fA-F]{40}$/.test(v) ? 'Paste the whole address: 0x and 40 characters.' : '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return;
      const k = lc(v);
      if (tokenOf(k)) { l.querySelectorAll('.pk-r').forEach((b) => { b.hidden = b.dataset.k !== k; }); return; }
      $('#pk-n').textContent = 'Reading the token…';
      const t = await R.readToken({ ethCall, keccak256: keccak_256, address: k }).catch(() => null);
      if (my !== seq) return;
      if (!t) { $('#pk-n').textContent = 'No token at that address on Ethereum.'; return; }
      const add = { addr: k, sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true };
      $('#pk-n').insertAdjacentHTML('beforebegin', `<button type="button" class="pk-r" data-k="${esc(k)}" data-add="${esc(JSON.stringify(add))}">${letter(add, '')}<span><b>${esc(t.sym)}</b><small>${esc(t.name)}</small></span><em>Add</em></button>`);
      $('#pk-n').textContent = 'Check the address: anyone can make a token with any name.';
    };
  }
  if (PKAT) { const l = $('#pk-l'), g = l.querySelector(`.pk-g[data-g="${PKAT}"]`); if (g) l.scrollTo({ top: g.offsetTop - l.offsetTop - 4 }); }
  setTimeout(() => (qEl || pk.querySelector('[aria-current="true"]') || pk.querySelector('.pk-r'))?.focus(), 0);
}
// What a picker row says is held: on the front page the page's own reading of a place it moves from (the paying account's ETH and TAC among
// them), a mark while the page is still reading it
let pkSide = null;
let PKAT = null;                      // the place a picker was opened at (a corner's mark): its coins are scrolled to, again if the list is drawn again
function rowBal(side, key) {
  const m = ATK.exec(key), a = m ? m[1] : 'wallet', k = m ? m[2] : key, t = shownAt(k, a);
  const bal = side === 'pay' && moving() ? H.moves?.held?.(k, a) ?? (a === 'wallet' ? S.bal[k] : null) : a === 'wallet' ? S.bal[k] : a === 'defi' ? privBal(k) : null;
  return bal ? esc(amtFmt(bal, t?.dec ?? 18)) : side === 'pay' && moving() && H.moves?.loading?.(k, a) ? '<span class="pk-rd" aria-label="reading">…</span>' : '';
}
// the open picker's balances drawn again (the page read them while it was open)
function pickerBals() {
  const pk = $('#pk');
  if (!pk || pk.hidden || !pkSide) return;
  for (const b of pk.querySelectorAll('.pk-r[data-k]')) { if (b.dataset.add) continue; const em = b.querySelector('em'), v = rowBal(pkSide, b.dataset.k); if (em && em.innerHTML !== v) em.innerHTML = v; }
}
// what the wallet holds first (by its worth), then the tokens with a private pool of their own, then the list's order
const POP = ['USDe', 'cbBTC', 'LINK', 'UNI', 'AAVE', 'PEPE', 'ENA', 'LDO', 'ONDO', 'SKY', 'MKR', 'weETH', 'cbETH', 'ARB', 'SHIB', 'CRV', 'PENDLE', 'ENS', 'COMP', 'GHO', 'crvUSD', 'PYUSD', 'EIGEN', 'ETHFI', 'SNX', 'GRT', 'RPL', 'FET', 'IMX', 'POL', 'APE', 'WLD', 'MORPHO', 'SUSHI', 'YFI', 'BAL', 'CVX', '1INCH'];
const famed = (k) => { const t = listedAt(k); if (!t?.uni) return 0; const j = POP.indexOf(t.sym); return j < 0 ? POP.length + 1 : j + 1; };
const held = (ks) => ks.map((k, i) => ({ k, i, v: S.bal[k] ? (usdOf(k, S.bal[k]) ?? 1e-9) : 0, f: famed(k) })).sort((a, b) => b.v - a.v || a.f - b.f || a.i - b.i).map((x) => x.k);
const defaultFor = (k) => (isEth(k) ? lc(R.TAC) : tacitKey(k) ? lc(R.ZERO) : lc(R.TAC));
function keepAmt(change) { const was = S.pay; change(); if (S.pay !== was) S.amt = ''; S.note = ''; }
function choose(side, k) {
  if (S.busy) return;
  // the Swap card: a coin picked with its place (the wallet, the DeFi pool, the Pay pool or Bitcoin) takes the side there with it
  const m = moving() && ATK.exec(k);
  if (m || S.at.pay || S.at.get) {
    const at = m ? m[1] : S.at[side] === 'pay' || S.at[side] === 'btc' ? (inPool(k) ? 'defi' : 'wallet') : atOf(side), real = m ? m[2] : k, was = side === 'pay' ? S.pay : S.get;
    const back = { at: { ...S.at }, inP: S.inP, outP: S.outP, pay: S.pay, get: S.get, later: LATER.on };
    setAt(side, at); if (side === 'pay') S.pay = real; else S.get = real;
    if (!mend(side)) { Object.assign(S, { at: back.at, inP: back.inP, outP: back.outP, pay: back.pay, get: back.get }); LATER.on = back.later; return; }
    if (side === 'get') clearTo();
    if (LATER.on) laterUp();
    if (side === 'pay' && !sameCoin(was, real)) S.amt = '';
    if (at === 'defi') { warmPrivate(); privUp(); }
    S.note = ''; S.q = null; S.mq = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
    return;
  }
  keepAmt(() => { if (side === 'pay') { S.pay = k; fit('pay'); } else { S.get = k; fit('get'); } });
  S.q = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
}


// The private farms and their rates: the receipt's Earn row names the one that deepens a private swap's pool (and /swap/'s Earn tab lists them).
async function readFarms() {
  const [prog, f, spot] = await Promise.all([api('/farm/program?network=mainnet'), readPrecision(({ to, data }) => ethCall(to, data)), readSpot(batch)]);
  const out = [{ k: 'precision', name: 'Precision farm', note: 'public', apr: f?.apr ?? null, icons: ['tac', 'eth'] }];
  for (const p of privateFarms(prog, f?.tacEth || 0, { ethUsd: spot.ethUsd ?? S.px.ethUsd, btcUsd: spot.btcUsd ?? S.px.btcUsd })) out.push({ k: `p${p.pid}`, pid: p.pid, name: p.name, note: 'private', apr: p.apr, icons: p.icons });
  S.farms = out;
}

// The pair, the amount and the private sides, as /swap/'s address bar names them (from, to, amt, private=to|from|both).
function params() {
  const p = new URLSearchParams(), sym = (k) => { const t = tokenOf(k); return t?.custom ? t.addr : t?.sym; };
  if (S.btc && !moving()) return p;
  if (S.pay !== lc(R.ZERO)) p.set('from', sym(S.pay));
  if (S.get !== lc(R.TAC)) p.set('to', sym(S.get));
  if (S.amt) p.set('amt', S.amt);
  if (S.inP || getPriv()) p.set('private', S.inP && S.outP ? 'both' : S.inP ? 'from' : 'to');
  if (S.at.pay) p.set('from-at', S.at.pay);
  if (S.at.get) p.set('to-at', S.at.get);
  return p;
}
function applyParams(p) {
  const find = (v) => { if (!v) return null; const x = lc(v); return x === 'teth' ? 'teth' : (listed().find((t) => nameIs(t, x) || t.addr === x)?.addr) || null; };
  const pv = p.get('private'), f = find(p.get('from')), t = find(p.get('to'));
  const fa = p.get('from-at'), ta = p.get('to-at');
  if (moving() && (['pay', 'btc'].includes(fa) || ['pay', 'btc'].includes(ta))) {
    setAt('pay', ['pay', 'btc'].includes(fa) ? fa : pv === 'from' || pv === 'both' ? 'defi' : 'wallet');
    setAt('get', ['pay', 'btc'].includes(ta) ? ta : pv === 'to' || pv === 'both' ? 'defi' : 'wallet');
    S.pay = coinAt(f || lc(R.ZERO), atOf('pay')); S.get = coinAt(t || lc(R.TAC), atOf('get'));
    if (!mend('pay')) { setAt('pay', 'wallet'); setAt('get', 'wallet'); S.pay = lc(R.ZERO); S.get = lc(R.TAC); return; }
    const a = p.get('amt');
    if (a && parseUnits(a, tokenOf(S.pay)?.dec ?? 18)) S.amt = fitAmt(a);
    return;
  }
  if (pv != null) {
    S.outP = pv !== 'from';
    S.inP = pv === 'from' || pv === 'both' || (pv === '' && !!f && !isEth(f));
  }
  const side = (k, priv) => (priv ? (isEth(k) ? 'teth' : k) : k === 'teth' ? lc(R.ZERO) : k);
  if (f) S.pay = side(f, S.inP); else if (S.inP) S.pay = 'teth';
  if (t) S.get = side(t, S.outP); else if (S.outP) S.get = S.pay === 'teth' ? lc(R.TAC) : 'teth';
  if (S.outP && t && !inPool(S.get)) { const r = outRoute(S.get); if (r) { S.outP = false; if (r === 'later') LATER.on = true; } }
  if (!kindOf(S.pay, S.get)) fit(t ? 'get' : 'pay');
  const a = p.get('amt');
  // a target token the card does not know: the pair it opened on is not the one the link named, so the amount (meant for that pair) is not filled in
  if (p.get('to') && !t) { S.note = { h: 'That token is not in the list, so the card opened on its default pair. Paste its address in the Get picker to add it.', cls: '' }; return; }
  if (a && (f ? S.pay === side(f, S.inP) : !p.get('from')) && parseUnits(a, tokenOf(S.pay).dec)) S.amt = fitAmt(a);
}
// The card shows what a link names: the page's own address, or a button elsewhere on the page. A token it does not know yet is looked for in the
// token list, or read from its address, and the card follows once it is found.
let ASKED = null;
function load(p, { fresh = true } = {}) {
  if (S.busy) return false;
  if (fresh) { S.inP = false; S.outP = false; S.at = { pay: null, get: null }; S.mq = null; S.pay = lc(R.ZERO); S.get = lc(R.TAC); S.amt = ''; LATER.on = false; clearTo(); }
  applyParams(p);
  ASKED = { p, pair: `${S.pay}>${S.get}` };
  S.q = null; S.pick = null; S.hold = false; S.ack = false; S.note = '';
  const named = [p.get('from'), p.get('to')].filter((v) => v && !/^0x/i.test(v));
  if (named.some((v) => !listed().some((t) => nameIs(t, lc(v))) && lc(v) !== 'teth')) loadList().then(() => { if (ASKED?.p !== p) return; const was = `${S.pay}>${S.get}:${S.inP}${S.outP}`; applyParams(p); if (`${S.pay}>${S.get}:${S.inP}${S.outP}` !== was) { S.q = null; paint(); readBalances().then(paintSides); if (S.amt || moveOf()) requote(true); else syncMove(); } });
  const f = p.get('from');
  if (/^0x[0-9a-fA-F]{40}$/.test(f || '') && !tokenOf(lc(f))) R.readToken({ ethCall, keccak256: keccak_256, address: lc(f) }).then((t) => {
    if (!t || ASKED?.p !== p) return;
    S.custom = [{ addr: lc(f), sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true }, ...S.custom].slice(0, 20);
    S.inP = false; S.pay = lc(f); if (!kindOf(S.pay, S.get)) S.get = lc(R.TAC);
    const a = p.get('amt'); if (a && parseUnits(a, t.dec)) S.amt = a;
    paint(); readBalances().then(paintSides); if (S.amt) requote(true);
  }).catch(() => {});
  if ([S.pay, S.get].some((k) => { const t = tokenOf(k); return t && !SPRITE.has(t.icon) && !LOGO[k]; })) loadList();
  if (S.inP || S.outP) { warmPrivate(); farmsSoon(); privUp(); }
  if (hidden()) laterUp();
  paint(); changed();
  // a move is priced even with no amount: some take none (all of it, or a bridge back that lists its notes), and the rest say what they need
  if (S.amt || moveOf()) requote(true); else syncMove();
  return true;
}

function slipPaint() { $('#slip').innerHTML = [10, 50, 100, 300].map((b) => `<button type="button" data-slip="${b}" aria-pressed="${S.slip === b}">${b / 100}%</button>`).join(''); }
// the farms are read once Private is open: the line under a private quote names the one that deepens its pool
const farmsSoon = () => { if (!S.farms) readFarms().then(() => { if ((S.inP || S.outP) && S.q?.pools) paintQuote(); }, () => {}); };
// The Bitcoin lane is another module, loaded the first time it opens: it swaps in the Bitcoin pool with a Tacit key, apart from this page's wallet
// and routes. The wallet connected here only helps open that key.
let lane = null;
const pageWallet = () => (W.account && W.prov && !W.prov.isWalletConnect ? { uuid: W.uuid, address: W.account } : null);
async function openLane() {
  try {
    lane ||= (await import('/swap/bitcoin.js?cb=4b4e3cc7')).makeBitcoinLane({ host: $('#btc'), notify: (m) => live(m), wallet: pageWallet, onBridged: paintNudge, from: moving() && S.pay === lc(R.TAC) ? 'tac' : 'teth' });
    if (S.btc) await lane.show();
  } catch (e) { $('#btc').innerHTML = `<p class="q err">Could not load the Bitcoin lane: ${esc(e?.message || e)}</p>`; lane = null; }
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

// each place says what it means where a pointer rests on it: the wallet is seen by anyone; Private is unseen (a private balance, or, for a token
// that has none, a swap through the private pool to an address); Bitcoin is TAC and tETH held on Bitcoin
// where a side's coin is held, named in its field's corner (paintSides fills it)
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
    if (e.target.closest('[data-open-pool]')) { openPoolGo(); return; }
    if (!e.target.closest('#later-on')) return;
    hopSet(!LATER.on);
  });
  // the buffer moves the deposit as it is dragged; the random draw around it is made again when it is let go
  $('#later').addEventListener('input', (e) => { if (e.target.id === 'later-x') { LATER.pct = Number(e.target.value); paintQuote(); } });
  $('#later').addEventListener('change', (e) => { if (e.target.id === 'later-x') { LATER.rand = Math.random(); paintQuote(); } });
  $('#steps').addEventListener('click', stepsClick);
  $('#slip').addEventListener('click', (e) => { const b = e.target.closest('[data-slip]'); if (!b) return; S.slip = Number(b.dataset.slip); try { localStorage.setItem(SLIP_KEY, String(S.slip)); } catch { } slipPaint(); if (S.q) requote(true); else paintQuote(); });
  $('#amt').addEventListener('input', (e) => { S.amt = fitAmt(e.target.value.trim()); S.note = ''; fitSize(e.target); changed(); paintSides(); requote(); });
  $('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
  ROOT.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
  $('#pay-coin').addEventListener('click', () => { PKAT = null; openPicker('pay'); });
  // the token lists are read at the first sign of a swap being set up: a coin hovered, focused or touched, or the amount focused
  for (const id of ['#pay-coin', '#get-coin', '#amt']) for (const ev of ['pointerenter', 'focus', 'touchstart']) $(id).addEventListener(ev, () => { loadList(); }, { once: true, passive: true });
  $('#get-coin').addEventListener('click', () => { PKAT = null; openPicker('get'); });
  // the place named in a field's corner is a way into the picker, at that place's coins
  for (const s of ['pay', 'get']) {
    const open = () => { if (!moving() || S.busy) return; PKAT = atOf(s); openPicker(s); };
    $(`#${s}-at`).addEventListener('click', open);
    $(`#${s}-at`).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
  $('#flip').addEventListener('click', () => {
    if (S.busy) return;
    if (placed()) {
      const pa = atOf('pay'), ga = atOf('get'), [p, g] = [S.pay, S.get];
      if (!pairOk(g, ga, p, pa)) return;
      setAt('pay', ga); setAt('get', pa); S.pay = g; S.get = p; S.q = null; S.mq = null; S.note = ''; clearTo(); if (!sameMoney(p, g) || tokenOf(p)?.dec !== tokenOf(g)?.dec) S.amt = ''; changed(); paint(); requote(true);
      return;
    }
    if (!kindOf(S.get, S.pay)) return;
    const r = picked(), out = r && !S.q?.busy ? tidy(plain(r.out, tokenOf(S.get).dec)) : '';
    [S.pay, S.get] = [S.get, S.pay]; S.note = '';
    S.amt = out ? tidy(out.replace(/(\.\d{8})\d+$/, '$1')) : S.amt; S.q = null; S.pick = null; S.hold = false; changed(); paint(); requote(true);
  });
  $('#get-where').addEventListener('click', () => { S.toOpen = !S.toOpen; paintSides(); if (S.toOpen) $('#to-in').focus(); });
  // a Tacit address or a name typed for a private side is looked up once the typing pauses, and only the last thing typed is kept
  let tacitT = 0;
  $('#to-in').addEventListener('input', (e) => {
    S.note = '';
    const raw = e.target.value.trim();
    if (!S.outP && !(laterPool() && raw && !/^0x/i.test(raw))) {
      clearTimeout(tacitT); S.toTacit = null; S.toTacitBad = ''; S.toTacitBusy = false; S.toName = null; S.toBusy = false;
      if (!isName(raw)) { const r = recipientOf(raw); S.to = r.addr; S.toBad = r.bad; paint(); return; }
      S.to = null; S.toBad = ''; S.toBusy = true;
      tacitT = setTimeout(async () => {
        let to = null, bad = '';
        let name = null;
        try { const r = await (await names()).resolveAddress(raw); if (!r) bad = `${raw} does not point at an address.`; else { const v = recipientOf(r.address); to = v.addr; bad = v.bad; if (to) name = { name: r.name, addr: to }; } }
        catch (err) { bad = String(err?.message || err).slice(0, 200); }
        if ($('#to-in').value.trim() !== raw) return;
        S.to = to; S.toBad = bad; S.toName = name; S.toBusy = false; paint();
      }, 400);
      paint(); return;
    }
    S.to = null; S.toBad = '';
    clearTimeout(tacitT); S.toTacit = null; S.toTacitBad = ''; S.toTacitBusy = !!raw; S.toName = null; S.toBusy = false;
    if (raw) tacitT = setTimeout(async () => {
      try { const r = await (await pvLoad()).mod.resolveTacit(raw); if ($('#to-in').value.trim() === raw) S.toTacit = { raw, pubHex: r.pubHex, name: r.name || null }; }
      catch (err) { if ($('#to-in').value.trim() === raw) S.toTacitBad = String(err?.message || err).slice(0, 200); }
      finally { if ($('#to-in').value.trim() === raw) { S.toTacitBusy = false; paint(); } }
    }, 400);
    paint();
  });
  $('#to-in').addEventListener('keydown', (e) => { if (e.key === 'Escape') { S.toOpen = false; paintSides(); $('#get-where').focus(); } });
  $('#go').addEventListener('click', go);
  $('#homes')?.addEventListener('click', (e) => { const b = e.target.closest('[data-home]'); if (!b) return; if (!HOMES_OPEN) { HOMES_OPEN = true; paint(); return; } HOMES_OPEN = false; if (b.dataset.home === atOf('get')) paint(); else setHome(b.dataset.home); });
  if ($('#homes')) arrows($('#homes'), 'data-home');
  $('#chain')?.addEventListener('change', (e) => {
    if (e.target.id !== 'chain-sel') return;
    H.moves.setChain(Number(e.target.value)); mend(atOf('pay') === 'pay' ? 'pay' : 'get');
    S.mq = null; changed(); paint(); requote(true); $('#chain .np-b')?.focus();
  });
  $('#rows').addEventListener('click', (e) => { if (e.target.closest('[data-routes-all]')) { S.routesAll = `${S.pay}>${S.get}`; paintQuote(); $('#rows [aria-checked="true"]')?.focus(); return; } const b = e.target.closest('[data-route]'); if (!b) return; S.pick = b.dataset.route; S.hold = true; S.ack = false; S.ackKey = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; paintQuote(); });
  ROOT.addEventListener('click', (e) => {
    if (e.target.closest('[data-px-flip]')) { S.pxFlip = !S.pxFlip; paintQuote(); $('#rcpt [data-px-flip]')?.focus(); return; }
    const q = e.target.closest('[data-quick]');
    if (q) { S.amt = q.dataset.quick; S.note = ''; changed(); paintSides(); requote(true); return; }
    // a move's Max is the page's: what its source holds, less what its own fees keep back
    const mk = e.target.closest('#max') && moveOf();
    if (mk && H.moves.most) { H.moves.most(mk).then((v) => { if (v == null || moveOf() !== mk) return; S.amt = v; S.note = ''; changed(); paintSides(); requote(true); }, () => {}); return; }
    if (e.target.closest('#copy')) { const u = shareLink(); if (u) H.copy(u, 'Link copied'); return; }
    if (e.target.closest('#max') && S.inP && PV) {
      const was = S.pay, k = PK[S.pay], same = `${S.get}${S.inP}${S.outP}${LATER.on}`;       // a read that returns after the card was turned around is not applied
      PV.most(IDS[k], POOL_TK[k]).then((v) => { if (v == null || S.pay !== was || `${S.get}${S.inP}${S.outP}${LATER.on}` !== same) return; S.amt = tidy(plain(v, 8)); S.note = ''; changed(); paintSides(); requote(true); }, () => {});
      return;
    }
    if (e.target.closest('#max') && exiting() && !exitOf().wallet) {
      const was = S.pay, bal = H.moves?.held?.(S.pay, 'pay'), same = `${S.get}${S.inP}${S.outP}${LATER.on}`;
      if (bal != null) exitPool(was).then(async (p) => { if (S.pay !== was || `${S.get}${S.inP}${S.outP}${LATER.on}` !== same || !exiting() || p.fee == null) return; const v = (await ltLoad()).mod.heldSwapMax(bal, p.fee); S.amt = tidy(plain(v, tokenOf(was).dec)); S.note = ''; changed(); paintSides(); requote(true); }, () => {});
      return;
    }
    if (e.target.closest('#max')) {
      const t = tokenOf(S.pay), bal = S.at.pay ? H.moves?.held?.(S.pay, S.at.pay) ?? null : S.inP ? privBal(S.pay) : S.bal[S.pay];
      if (bal == null) return;
      // Max keeps half again the network fee it checks against, so a gas price that ticks up before the button is drawn does not undo it
      const keep = isEth(S.pay) && !S.at.pay ? (gasKeep() * 3n) / 2n + (S.outP ? tipKeep() : 0n) : 0n, left = bal > keep ? bal - keep : 0n;
      // with Swap privately on, what is left is the deposit: the swap is the most whose deposit (its extra and the relay's fee with it) fits
      const hop = isEth(S.pay) && !S.at.pay && laterOn(kindOf(S.pay, S.get)) && LATER.fee != null && LT;
      // from a token with Swap privately on, the deposit is the swap scaled up (its extra and the relay's fee): Max takes the most whose deposit fits the balance, by the live
      // quote's own ratio where there is one, else from the extra the slider asks, with a margin so the exact deposit that follows still fits
      const tokLater = !isEth(S.pay) && !S.at.pay && !S.inP && laterOn(kindOf(S.pay, S.get));
      const tokMax = () => { const q0 = S.q, dep = q0?.wei ? laterIn(q0) : null, ratio = dep ? Number(dep) / Number(q0.wei) : (1 + LATER.pct / 100) * 1.002 * 1.03; return BigInt(Math.floor((Number(left) / ratio) * 0.985)); };
      const v = hop ? LT.mod.swapFor({ capWei: left, feeWei: LATER.fee, pct: LATER.pct, rand: () => LATER.rand, gasWei: laterGas() }) : tokLater ? tokMax() : left;
      S.amt = tidy(fitAmt(plain(v, t.dec))); S.note = ''; changed(); paintSides(); requote(true); return;
    }
    if (e.target.closest('[data-watch]')) { const t = tokenOf(e.target.closest('[data-watch]').dataset.watch); if (t) wallet.watchAsset({ address: t.addr, symbol: t.sym, decimals: t.dec }); return; }
    if (e.target.closest('[data-farm-it]')) H.farmIt?.(S.lastBuy);
    if (e.target.closest('#pv-open')) openPrivate().catch(() => {});
    if (e.target.closest('#pv-read')) { PV?.read(true).then(paint, () => paint()); return; }
    const xr = e.target.closest('[data-exit-run], [data-exit-back]');
    if (xr) exitAct(xr.dataset.exitRun || xr.dataset.exitBack, !!xr.dataset.exitBack).catch(() => {});
  });
  $('#ackbox').addEventListener('change', (e) => { if (e.target.id === 'ack') { S.ack = e.target.checked; paintQuote(); } });
  $('.mode')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    // on the front page the switch shows only in the lane, and Ethereum leaves it for the card's first swap
    if (moving()) { if (b.dataset.mode !== 'bitcoin' && S.btc) load(new URLSearchParams()); return; }
    if (b.dataset.mode === 'bitcoin') { setBtc(!S.btc); return; }
    if (S.btc) setBtc(false);
  });
  if ($('.mode')) arrows($('.mode'), 'data-mode');
  arrows($('#rows'), 'data-route');
  addEventListener('storage', (e) => { if (e.key === BRIDGED_KEY || e.key === null) paintNudge(); });
}

// Draws the card in `root` and starts it. `host` is the page:
//   wallet, W        its Ethereum wallet (trade/wallet.js's shape: sendTx, receipt, ensureMainnet, available, watchAsset; W.account, W.prov)
//   connect()        asks for a wallet to be connected
//   key              the page's Tacit key, when it holds one (private.js's session, open and wait): the card then opens no key of its own
//   getUx()          the page's pool module, when it has one
//   lane, recent     false leaves out the Bitcoin lane, and the list of the last swaps
//   onChange()       the pair, the amount or a side changed (the page keeps its address in step with params())
//   onPrices(px)     the prices were read (ETH, BTC and TAC in dollars)
//   onDone()         a swap was made (the page reads its balances again)
//   farmIt(wei)      offered after TAC was bought: the page's way to farm it
//   warm()           the first private quote is coming: the page may preload the pool's modules
//   moves            the Swap card's places (see the places block): key(pay, payAt, get, getAt) names a move or is null; quote(key, amt, cb)
//                    prices it, calling cb with { out, go, rc, line, warn, busy, free, failed } as it learns more; go(key, amt) starts it;
//                    idle() says no move is shown; held(coin, at, key) is what a move's side holds, most(key) what Max puts in;
//                    warm() reads the places' balances, stale(coin, at) reads one again at once (something left it);
//                    chains(), chain and setChain(id) the Pay pool's chain.
//                    Under a move's receipt are the page's own lines: the points it earns (#hx-pts) and what that place holds (#hx-have)
export function mountSwapCard(root, host = {}) {
  if (ROOT) throw new Error('This page already has a swap card.');
  ROOT = root; H = host; wallet = host.wallet; W = host.W;
  root.classList.add('swc');
  root.classList.toggle('mv', !!host.moves);
  root.innerHTML = markup(host);
  wire();
  slipPaint();
  paint();
  if (W.account) readBalances().then(paintSides, () => {});
  readPrices().then(() => { paint(); if (S.amt && !(S.inP || S.outP)) requote(true); }).catch(() => { if (S.amt && !(S.inP || S.outP)) requote(true); });
  gasPrice();
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
    if (now() - routeAt > 300) { routeAt = now(); checkAmmRoute(); }
    if (S.q && !S.busy && !S.q.busy && now() - (S.q.at || 0) > (['any', 'out', 'in', 'pout', 'agg', 'pin', 'exit'].includes(S.q.kind) ? 55 : 25)) requote(true);
    if (S.inP && PV?.unlocked && !PV.held && !S.busy) PV.read(true).then(paint, () => {});                 // a private balance whose read failed is read again
  };
  setInterval(tick, 30e3);
  setInterval(() => { if (!document.hidden && ROOT.isConnected) readBlend(); }, 30e3);
  document.addEventListener('visibilitychange', tick);
  return {
    load: (p) => load(p),
    params,
    get lane() { return S.btc; },
    setLane: (on) => setBtc(!!on),
    walletChanged,
    // the page's key was opened, changed or locked: what the card read under the last one is dropped
    keyChanged: () => { PV?.reset(); paint(); privUp(); },
    farms: () => (S.farms ? Promise.resolve(S.farms) : readFarms().then(() => S.farms)),
    readBalances: () => readBalances().then(paintSides),
    // the page read its balances again: what a move's side holds is drawn again
    refresh: () => { if (moveOf() || S.at.pay || S.at.get) { paintMode(); paintSides(); if (exiting() && S.q) paintQuote(); } else paintMode(); },
    // the card is shown again: a move is priced again
    requote: () => { if (!S.busy && (moveOf() || exiting())) requote(true); },
    focus: () => $('#amt').focus({ preventScroll: true }),
    closePicker: () => pkClose?.({ quiet: true }),
    pickerBals,
    get busy() { return S.busy; },
  };
}
