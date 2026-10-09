// TAC's Ethereum trading lane: the ticket that trades ETH against the public TAC ERC20 on
// Ethereum mainnet, mounted by btc-market.js beside the Bitcoin order book for the one asset
// (TAC) that also has real liquidity there. Quoting and calldata are evm-trade-venues.js
// (fork-verified, unit-tested); this module is the DOM half, in the same language as the
// Bitcoin ticket: Buy / Sell, an amount with balance chips, a quote that names what you get,
// the least you can get, the price, its impact and the venue, then a review dialog whose
// numbers are what runs.
//
// Mount contract: mountEvmTradeLane(host, opts) fills `host` once and is idempotent on repeat
// calls against the same node. `opts` is the wallet seam { address(), connect(), sendTx({from,
// to,data,value}) } plus, optionally, `market` ({ markUnit(), btcUsd(), iconHtml() } — the
// Bitcoin lane's last price, for the cross-lane comparison), `txUrl(hash)`, and test seams
// `venues` / `rpc` / `ethUsd` that replace the live quoting and RPC. No wallet is needed to
// quote — only to execute.

import { getConfidentialDeployment, esc, notify } from './confidential-deployments.js';
import {
  TAC_ERC20, VENUES, makeEvmTradeVenues, zswapDeepLink,
  encErc20Allowance, encErc20Approve, encErc20BalanceOf, decUint256,
} from './evm-trade-venues.js';
import { keccak_256 } from './vendor/tacit-deps.min.js';

const DEBOUNCE_MS = 300;
// The review's confirm button takes focus when the dialog opens, and Enter in the amount box
// is what opens it, so a second Enter (a double tap, or key repeat) would land on it unread.
// The button ignores activation for this long after the dialog appears, and ignores held keys.
const CONFIRM_GRACE_MS = 600;
const BG_REQUOTE_MS = 20_000;
const SPOT_REFRESH_MS = 30_000;
const ZQUOTER_WAIT_MS = 4000;
const RECEIPT_POLL_MS = 3000;
const RECEIPT_TIMEOUT_MS = 240_000;
const ETHERSCAN_TX = (h) => `https://etherscan.io/tx/${h}`;
const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TAC_ERC20}`;
const ZSWAP_HOST = 'https://zswap.wei.limo';
const SLIPPAGE_CHOICES = [[10, '0.1%'], [50, '0.5%'], [100, '1%'], [300, '3%']];
const DEFAULT_SLIPPAGE_BPS = 50;
// Price impact past these marks is called out; past the second it must be acknowledged.
const IMPACT_WARN_BPS = 300;
const IMPACT_BLOCK_BPS = 1000;
// A tiny trade's rate is the market's spot price; impact is how far a real trade falls from it.
const SPOT_PROBE = { ETH_TO_TAC: 10n ** 15n, TAC_TO_ETH: 10n ** 18n };
// Gas a swap takes, used for the fee estimate before a wallet is connected and for the ETH
// a "Max" buy keeps back. Both are generous.
const GAS_GUESS = { ETH_TO_TAC: 220_000n, TAC_TO_ETH: 260_000n, approve: 55_000n };
const ETH_RESERVE_FALLBACK = 2n * 10n ** 15n; // 0.002 ETH
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PREF_KEY = 'tacit-eth-lane-v1';
const ETH_USD_KEY = 'tacit-eth-usd-v1';

// ── live RPC (mainnet) ────────────────────────────────────────────────────────
function mainnetRpcs() {
  const d = getConfidentialDeployment('mainnet');
  return (d && Array.isArray(d.rpcs)) ? d.rpcs : [];
}
async function rpcCall(method, params, { retryPasses = 2 } = {}) {
  const urls = mainnetRpcs();
  if (!urls.length) throw new Error('no mainnet RPC endpoints configured');
  let lastErr;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let pass = 0; pass < retryPasses; pass++) {
    if (pass > 0) await sleep(400 * pass);
    for (const url of urls) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(12000) });
        if (!r.ok) { lastErr = new Error(`rpc ${r.status}`); continue; }
        const j = await r.json();
        if (j && j.error) { lastErr = Object.assign(new Error(j.error.message || 'rpc error'), { data: j.error.data, code: j.error.code }); continue; }
        return j ? j.result : undefined;
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('all mainnet RPCs failed');
}
const liveRpc = {
  // call(to, data, block, opts) — the shape evm-trade-venues.js's quoteZQuoter needs
  // (opts.gas, kept out of any Multicall3 batch — the module handles that split itself).
  call(to, data, block = 'latest', callOpts = {}) {
    const call = { to: String(to).toLowerCase(), data };
    if (callOpts.from) call.from = callOpts.from;
    if (callOpts.value) call.value = callOpts.value;
    if (callOpts.gas) call.gas = callOpts.gas;
    const opts = callOpts.retryPasses != null ? { retryPasses: callOpts.retryPasses } : undefined;
    return rpcCall('eth_call', [call, block], opts);
  },
  getBalance: (addr) => rpcCall('eth_getBalance', [addr, 'latest']).then((h) => (h ? BigInt(h) : 0n)),
  gasPrice: () => rpcCall('eth_gasPrice', []).then((h) => (h ? BigInt(h) : null)),
  receipt: (hash) => rpcCall('eth_getTransactionReceipt', [hash]),
};

// ── helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + v.toString(16);
const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '');

// Amount strings round-trip through BigInt, never Number, so nothing above 2^53 loses precision.
export function parseUnitsStr(str, decimals = 18) {
  const s = String(str == null ? '' : str).trim().replace(/[,_\s]/g, '');
  if (s === '' || s === '.' || !/^[0-9]*\.?[0-9]*$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (!whole && !frac) return null;
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try { return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(fracPadded || '0'); }
  catch { return null; }
}
export function formatUnitsStr(value, decimals = 18, maxFrac = 6) {
  if (value == null) return '';
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
// For display: thousands separators and a precision that suits the size.
export function fmtTok(value, ticker) {
  if (value == null) return '';
  const n = Number(formatUnitsStr(value, 18, 12));
  if (!Number.isFinite(n)) return formatUnitsStr(value, 18, 6);
  const digits = ticker === 'ETH'
    ? (n >= 1 ? 4 : n >= 0.01 ? 5 : 6)
    : (n >= 1000 ? 0 : n >= 1 ? 2 : 4);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
function fmtRate(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toPrecision(3).replace(/\.?0+$/, '');
}
function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 10_000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 0.01) return '$' + Number(v.toPrecision(3));
  if (v > 0) return '$' + Number(v.toPrecision(2));
  return '$0';
}
const toNum = (value, decimals = 18) => Number(formatUnitsStr(value, decimals, 12));
const fmtPct = (bps) => (bps < 1 ? '< 0.01' : (bps / 100).toFixed(2)) + '%';

// What a user needs to read, not what the node said.
function decodeRevertReason(err) {
  const raw = (err && (err.data || (err.data && err.data.data))) || '';
  const h = String(raw || '').replace(/^0x/, '');
  if (h.slice(0, 8) !== '08c379a0' || h.length < 8 + 128) return null;
  try {
    const len = parseInt(h.slice(8 + 64, 8 + 128), 16);
    const bytes = (h.slice(8 + 128, 8 + 128 + len * 2).match(/../g) || []).map((b) => parseInt(b, 16));
    return new TextDecoder().decode(new Uint8Array(bytes)) || null;
  } catch { return null; }
}
export function isUserRejection(e) {
  const code = e && typeof e === 'object' ? (e.code ?? e.cause?.code) : null;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  return /user rejected|user denied|rejected the request|denied transaction|cancelled by user|canceled by user/i.test(String(e?.message || e || ''));
}
export function friendlyEthError(e) {
  if (isUserRejection(e)) return 'Cancelled in your wallet — nothing was sent.';
  const m = String(e?.message || e || '');
  if (/insufficient funds/i.test(m)) return 'Not enough ETH to cover the amount and the network fee.';
  if (/Switch your wallet/i.test(m)) return m;
  if (/no Ethereum wallet|no wallet selected|install MetaMask/i.test(m)) return 'No Ethereum wallet found — install MetaMask, Rabby, Rainbow or Coinbase Wallet, or open this page in its browser.';
  if (/timed out waiting/i.test(m)) return m;
  if (/slippage|minOut|too little received|INSUFFICIENT_OUTPUT/i.test(m)) return 'The price moved past your slippage before the swap ran — nothing was swapped. Quote again or allow more slippage.';
  if (/deadline|expired/i.test(m)) return 'The quote expired before the swap ran — nothing was swapped. Try again.';
  return m.replace(/^Error:\s*/, '') || 'Something went wrong.';
}

// ETH/USD for the dollar hints. Coinbase's spot endpoint is public and CORS-open, the same
// source the dapp uses for BTC/USD; a miss just hides the dollar figures.
let ethUsdCache = { price: null, at: 0 };
async function fetchEthUsd() {
  if (ethUsdCache.price && Date.now() - ethUsdCache.at < 60_000) return ethUsdCache.price;
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json() : null;
    const p = Number(j?.data?.amount);
    if (p > 0) {
      ethUsdCache = { price: p, at: Date.now() };
      try { localStorage.setItem(ETH_USD_KEY, JSON.stringify(ethUsdCache)); } catch {}
      return p;
    }
  } catch {}
  if (ethUsdCache.price) return ethUsdCache.price;
  try {
    const s = JSON.parse(localStorage.getItem(ETH_USD_KEY) || 'null');
    if (s && s.price > 0 && Date.now() - s.at < 86_400_000) { ethUsdCache = s; return s.price; }
  } catch {}
  return null;
}

const ETH_LOGO_SVG = `<svg viewBox="0 0 32 32" width="16" height="16" style="flex-shrink:0;border-radius:50%;display:block;">
  <circle cx="16" cy="16" r="16" fill="#627eea"/>
  <polygon points="16,5 24,16 16,20.5 8,16" fill="#fff"/>
  <polygon points="16,5 8,16 16,20.5" fill="#fff" fill-opacity="0.55"/>
  <polygon points="16,21.8 24,17.3 16,27 8,17.3" fill="#fff" fill-opacity="0.85"/>
</svg>`;
const TAC_LOGO_IMG = `<img src="tac-logo.png" alt="" width="16" height="16" style="flex-shrink:0;border-radius:50%;display:block;">`;
function venueLabel(v) {
  if (v === VENUES.PRECISION) return 'Precision';
  if (v === VENUES.TACIT_AMM) return 'Tacit AMM';
  if (v === VENUES.ZQUOTER) return 'zQuoter';
  return v || 'unknown';
}
// Precision's lens reports its fee in millionths; the Tacit AMM and zQuoter in basis points.
function feePct(q) {
  if (!q || q.feeBps == null) return null;
  const f = Number(q.feeBps);
  return q.venue === VENUES.PRECISION ? f / 10_000 : f / 100;
}
function venueWhy(v) {
  if (v === VENUES.PRECISION) return 'A concentrated ETH/TAC pool on Ethereum, routed through zRouter.';
  if (v === VENUES.TACIT_AMM) return "Tacit's own public TAC/cETH pool.";
  if (v === VENUES.ZQUOTER) return 'An aggregator over Uniswap, Sushi, Curve and zAMM.';
  return '';
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export function mountEvmTradeLane(host, opts) {
  if (!host) return null;
  if (host.__evmLane) { host.__evmLane.setOpts(opts); return host.__evmLane; }
  const ctl = createLane(host, opts || {});
  host.__evmLane = ctl;
  host.dataset.evmLaneMounted = '1';
  return ctl;
}

function createLane(host, opts0) {
  const pref = LS.get(PREF_KEY, {});
  const S = {
    opts: opts0,
    side: pref.side === 'sell' ? 'sell' : 'buy',
    slippageBps: SLIPPAGE_CHOICES.some(([b]) => b === pref.slippageBps) ? pref.slippageBps : DEFAULT_SLIPPAGE_BPS,
    amountStr: '',
    quote: null, quoting: false, quoteSeq: 0,
    spot: null, spotAt: 0, spotDir: null,
    ethBal: null, tacBal: null, balAddr: null,
    gasPrice: null, gasAt: 0,
    ethUsd: null,
    busy: false, destroyed: false,
    ackImpact: false,
    debTimer: null, bgTimer: null,
  };
  const savePref = () => LS.set(PREF_KEY, { side: S.side, slippageBps: S.slippageBps });
  const dir = () => (S.side === 'buy' ? 'ETH_TO_TAC' : 'TAC_TO_ETH');
  const inTicker = () => (S.side === 'buy' ? 'ETH' : 'TAC');
  const outTicker = () => (S.side === 'buy' ? 'TAC' : 'ETH');
  const rpc = () => S.opts.rpc || liveRpc;
  let liveVenues = null;
  const venues = () => S.opts.venues || (liveVenues ||= makeEvmTradeVenues({ ethCall: (to, data, block, o) => rpc().call(to, data, block, o), keccak256: keccak_256 }));
  const txUrl = (h) => (S.opts.txUrl ? S.opts.txUrl(h) : ETHERSCAN_TX(h));
  const tacIcon = () => { try { return S.opts.market?.iconHtml?.() || TAC_LOGO_IMG; } catch { return TAC_LOGO_IMG; } };
  const iconFor = (t) => (t === 'ETH' ? ETH_LOGO_SVG : tacIcon());
  const slipLabel = () => SLIPPAGE_CHOICES.find(([b]) => b === S.slippageBps)?.[1] || '0.5%';

  host.innerHTML = `
    <div class="bm-grid bm-ethgrid">
      <div class="bm-left">
        <div class="bm-ticket bm-eth" data-k="eticket" data-side="${S.side}">
          <div class="bm-sides" role="tablist">
            <button type="button" role="tab" data-act="eside" data-v="buy">Buy</button>
            <button type="button" role="tab" data-act="eside" data-v="sell">Sell</button>
          </div>
          <p class="bm-mode-note" data-k="emode"></p>
          <div class="bm-spot" data-k="espot" aria-live="polite"></div>
          <label class="bm-field">
            <span class="bm-label" data-k="elabel">You spend</span>
            <span class="bm-inputrow">
              <input data-k="eamount" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Amount">
              <span class="bm-unit bm-unit-static" data-k="eunit"></span>
            </span>
          </label>
          <div class="bm-chips" data-k="echips"></div>
          <div class="bm-bal" data-k="ebal"></div>
          <div class="bm-quote" data-k="equote" aria-live="polite"></div>
          <details class="bm-opts" data-k="eopts"><summary data-k="eopts-sum"></summary><div data-k="eopts-body"></div></details>
          <button type="button" class="bm-go" data-k="ego" data-act="ego" disabled>Enter an amount</button>
          <p class="bm-fine" data-k="efine"></p>
        </div>
      </div>
      <div class="bm-book bm-venues" data-k="evenues"></div>
    </div>`;
  const $ = (sel) => host.querySelector(sel);
  const $$ = (sel) => Array.from(host.querySelectorAll(sel));
  const el = {
    ticket: $('[data-k=eticket]'), mode: $('[data-k=emode]'), spot: $('[data-k=espot]'), label: $('[data-k=elabel]'),
    amount: $('[data-k=eamount]'), unit: $('[data-k=eunit]'), chips: $('[data-k=echips]'), bal: $('[data-k=ebal]'),
    quote: $('[data-k=equote]'), optsSum: $('[data-k=eopts-sum]'), optsBody: $('[data-k=eopts-body]'),
    go: $('[data-k=ego]'), fine: $('[data-k=efine]'), venues: $('[data-k=evenues]'),
  };
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  // ── wallet + balances ─────────────────────────────────────────────────────
  function address() {
    try { return typeof S.opts.address === 'function' ? S.opts.address() : null; } catch { return null; }
  }
  async function refreshBalances() {
    const addr = address();
    if (!addr) { S.ethBal = null; S.tacBal = null; S.balAddr = null; paintBalance(); paintGo(); return; }
    try {
      const [eth, tacRaw] = await Promise.all([rpc().getBalance(addr), rpc().call(TAC_ERC20, encErc20BalanceOf(addr))]);
      if (S.destroyed) return;
      S.ethBal = eth; S.tacBal = decUint256(tacRaw); S.balAddr = addr;
    } catch { /* keep the last known figures on a transient miss */ }
    paintBalance(); paintQuote(); paintGo();
  }
  async function refreshGas() {
    if (S.gasPrice && Date.now() - S.gasAt < 30_000) return S.gasPrice;
    try { const g = await rpc().gasPrice(); if (g) { S.gasPrice = g; S.gasAt = Date.now(); } } catch {}
    return S.gasPrice;
  }
  // ETH kept back from a "Max" buy so the swap itself can still pay for gas.
  const ethReserve = () => (S.gasPrice ? (GAS_GUESS.ETH_TO_TAC * S.gasPrice * 3n) / 2n : ETH_RESERVE_FALLBACK);
  const feeEstWei = (gasUnits) => (S.gasPrice ? gasUnits * S.gasPrice : null);
  const balIn = () => (S.side === 'buy' ? S.ethBal : S.tacBal);
  const ethUsdOf = (wei) => (S.ethUsd && wei != null ? toNum(wei) * S.ethUsd : null);

  // ── spot + quote ──────────────────────────────────────────────────────────
  // The spot rate from a tiny probe through the deepest venue; the Tacit AMM answers when the
  // band can't. Shown before any amount is typed and used for price impact.
  async function refreshSpot(force = false) {
    const d = dir();
    if (!force && S.spot && S.spotDir === d && Date.now() - S.spotAt < SPOT_REFRESH_MS) return;
    const probe = SPOT_PROBE[d];
    let q = null;
    try { q = await venues().quotePrecision({ dir: d, amountIn: probe }); } catch {}
    if (!q) { try { q = await venues().quoteTacitAmm({ dir: d, amountIn: probe }); } catch {} }
    if (S.destroyed || dir() !== d) return;
    if (q && q.amountOut > 0n) {
      // rate = out per 1 in, scaled 1e18
      S.spot = { dir: d, rate: (q.amountOut * 10n ** 18n) / q.amountIn, venue: q.venue };
      S.spotDir = d;
    } else if (S.spotDir !== d) { S.spot = null; }
    S.spotAt = Date.now();
    paintSpot(); paintQuote(); paintVenues(); paintGo();
  }
  // TAC per ETH and ETH per TAC as floats, for display only.
  function spotRates() {
    if (!S.spot) return null;
    const r = toNum(S.spot.rate);
    if (!(r > 0)) return null;
    return S.spot.dir === 'ETH_TO_TAC' ? { tacPerEth: r, ethPerTac: 1 / r } : { tacPerEth: 1 / r, ethPerTac: r };
  }
  function impactBps(q) {
    if (!q || !q.best || !S.spot || S.spot.dir !== q.dir) return null;
    const rate = (q.best.amountOut * 10n ** 18n) / q.amountIn;
    if (rate >= S.spot.rate) return 0;
    return Number(((S.spot.rate - rate) * 10000n) / S.spot.rate);
  }
  const minOutOf = (amountOut, bps) => (amountOut * BigInt(10000 - bps)) / 10000n;
  // A quote answers one direction and one amount; anything typed or flipped since asks a new question.
  const quoteIsCurrent = () => {
    const q = S.quote, a = parseUnitsStr(S.amountStr);
    return !!q && !!a && q.dir === dir() && q.amountIn === a;
  };
  const quotePending = () => S.quoting || S.debTimer != null;

  // The pools answer in a second or two; the aggregator probe can take several and usually has
  // no route, so it joins the quote when it answers instead of holding the whole quote back.
  async function doQuote(amt, d) {
    const seq = ++S.quoteSeq;
    S.quoting = true; paintQuote(); paintGo();
    const account = address() || undefined;
    const v = venues();
    const zq = typeof v.quoteZQuoter === 'function'
      ? Promise.race([v.quoteZQuoter({ dir: d, amountIn: amt, account }).then((r) => r || { venue: VENUES.ZQUOTER, status: 'error' }, () => ({ venue: VENUES.ZQUOTER, status: 'error' })), sleep(ZQUOTER_WAIT_MS).then(() => ({ venue: VENUES.ZQUOTER, status: 'timeout' }))])
      : Promise.resolve(null);
    try {
      const result = await v.quoteAll({ dir: d, amountIn: amt, account, includeZQuoter: false });
      if (S.destroyed || seq !== S.quoteSeq) return;
      result.zquoter = { venue: VENUES.ZQUOTER, status: 'pending' };
      S.quote = result;
    } catch { /* keep the last quote on a transient failure */ }
    finally {
      if (seq === S.quoteSeq) { S.quoting = false; paintQuote(); paintVenues(); paintGo(); }
    }
    refreshGas().then(() => { if (!S.destroyed && seq === S.quoteSeq) { paintQuote(); paintGo(); } });
    const z = await zq;
    if (S.destroyed || seq !== S.quoteSeq || !S.quote || !z) return;
    // Kept for comparison only: the swap is sent through the venues quoteAll ranks, which the
    // aggregator's route is not one of, so it must not become the route the review names.
    S.quote.zquoter = z;
    paintQuote(); paintVenues(); paintGo();
  }
  function scheduleQuote(immediate) {
    clearTimeout(S.debTimer); S.debTimer = null;
    const amt = parseUnitsStr(S.amountStr);
    if (!amt || amt <= 0n) { S.quote = null; S.quoting = false; S.quoteSeq++; paintQuote(); paintVenues(); paintGo(); return; }
    const d = dir();
    const run = () => { S.debTimer = null; doQuote(amt, d); };
    if (immediate) run(); else S.debTimer = setTimeout(run, DEBOUNCE_MS);
  }

  // ── paint ─────────────────────────────────────────────────────────────────
  function paintFrame() {
    $$('[data-act=eside]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === S.side)));
    el.ticket.dataset.side = S.side;
    el.mode.textContent = S.side === 'buy'
      ? 'Buy TAC with ETH at the best price across Ethereum venues.'
      : 'Sell TAC for ETH at the best price across Ethereum venues.';
    el.label.textContent = S.side === 'buy' ? 'You spend' : 'You sell';
    el.unit.innerHTML = `${iconFor(inTicker())}${inTicker()}`;
    el.amount.setAttribute('aria-label', `Amount in ${inTicker()}`);
    el.fine.innerHTML = `Settles on Ethereum mainnet from your own wallet. TAC (ERC20) <a href="${ETHERSCAN_TOKEN}" target="_blank" rel="noopener noreferrer">${esc(short(TAC_ERC20))}</a>`;
    paintOpts();
  }
  function paintOpts() {
    el.optsSum.innerHTML = `Slippage <b>${slipLabel()}</b>`;
    const html = `<label class="bm-opt"><span>Slippage</span><select data-act="eslip">${SLIPPAGE_CHOICES.map(([b, l]) => `<option value="${b}"${b === S.slippageBps ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="bm-q bm-muted">The swap reverts, spending only its network fee, if the price moves against you by more than this before it runs.</p>`;
    if (el.optsBody.innerHTML !== html) el.optsBody.innerHTML = html;
  }
  function paintSpot() {
    const r = spotRates();
    let html = '';
    if (r) {
      const usd = S.ethUsd ? fmtUsd(r.ethPerTac * S.ethUsd) : '';
      html = `<span><b>1 TAC</b> ≈ ${fmtRate(r.ethPerTac)} ETH${usd ? ` <em>${usd}</em>` : ''}</span><span><b>1 ETH</b> ≈ ${fmtRate(r.tacPerEth)} TAC${S.ethUsd ? ` <em>${fmtUsd(S.ethUsd)}</em>` : ''}</span>`;
    } else if (S.spotAt === 0) html = `<span class="bm-muted">Fetching the Ethereum price…</span>`;
    else html = `<span class="bm-muted">No Ethereum price right now.</span>`;
    if (el.spot.innerHTML !== html) el.spot.innerHTML = html;
  }
  function paintBalance() {
    const addr = address();
    let bal = '';
    const chips = [];
    if (!addr) {
      bal = `<button type="button" class="bm-link" data-act="econnect">Connect an Ethereum wallet</button> to see your balance`;
    } else {
      const b = balIn();
      bal = b == null ? 'Balance: checking…' : `Balance: <b>${fmtTok(b, inTicker())}</b> ${inTicker()} <span class="bm-addr" title="${esc(addr)}">· ${esc(short(addr))}</span>`;
      if (b != null && b > 0n) {
        const spendable = S.side === 'buy' ? (b > ethReserve() ? b - ethReserve() : 0n) : b;
        for (const p of [25, 50, 100]) {
          const v = (spendable * BigInt(p)) / 100n;
          if (v > 0n) chips.push(`<button type="button" data-act="echip" data-v="${formatUnitsStr(v, 18, 18)}" title="${p === 100 && S.side === 'buy' ? 'Everything but the ETH the network fee needs' : ''}">${p === 100 ? 'Max' : p + '%'}</button>`);
        }
      }
    }
    if (el.bal.innerHTML !== bal) el.bal.innerHTML = bal;
    const ch = chips.join('');
    if (el.chips.innerHTML !== ch) el.chips.innerHTML = ch;
  }
  // The cross-lane line: what the Bitcoin book last paid per TAC, next to this quote.
  function bitcoinCompare(usdPerTacHere) {
    const m = S.opts.market;
    if (!m || !usdPerTacHere) return '';
    let mark = null, btcUsd = 0;
    try { mark = m.markUnit?.(); btcUsd = m.btcUsd?.() || 0; } catch {}
    if (!(mark > 0) || !(btcUsd > 0)) return '';
    const usdBtc = (mark / 1e8) * btcUsd;
    const diff = ((usdPerTacHere - usdBtc) / usdBtc) * 100;
    const better = S.side === 'buy' ? diff < 0 : diff > 0;
    const word = Math.abs(diff) < 0.5 ? 'about the same as' : `${Math.abs(diff).toFixed(Math.abs(diff) < 10 ? 1 : 0)}% ${diff < 0 ? 'below' : 'above'}`;
    return `<div class="bm-q bm-muted">On Bitcoin the last trade was ${mark.toLocaleString('en-US', { maximumFractionDigits: 2 })} sats per TAC <em>(${fmtUsd(usdBtc)})</em> — this price is ${word} it${Math.abs(diff) >= 0.5 ? (better ? ', in your favour' : '') : ''}.</div>`;
  }
  function quoteView() {
    const q = S.quote;
    if (!q || !q.best || !quoteIsCurrent()) return null;
    const bps = impactBps(q);
    const minOut = minOutOf(q.best.amountOut, S.slippageBps);
    const rateOut = toNum(q.best.amountOut) / toNum(q.amountIn); // out per in
    const ethPerTac = S.side === 'buy' ? 1 / rateOut : rateOut;
    const tacPerEth = S.side === 'buy' ? rateOut : 1 / rateOut;
    const gas = GAS_GUESS[q.dir] + (S.side === 'sell' ? GAS_GUESS.approve : 0n);
    return { q, bps, minOut, ethPerTac, tacPerEth, feeWei: feeEstWei(gas), usdPerTac: S.ethUsd ? ethPerTac * S.ethUsd : null };
  }
  function paintQuote() {
    if (S.busy) return;
    const amt = parseUnitsStr(S.amountStr);
    const row = (k, v, cls = '') => `<div class="bm-qr ${cls}"><span>${k}</span><span>${v}</span></div>`;
    let html = '';
    if (!amt || amt <= 0n) { el.quote.innerHTML = ''; return; }
    const v = quoteView();
    if (!v) {
      if (quotePending() && !quoteIsCurrent()) html = `<div class="bm-q bm-muted">Finding the best price…</div>`;
      else if (S.quote && quoteIsCurrent() && !S.quote.best) html = `<div class="bm-q bm-warn">No venue can fill this amount right now.</div>${S.quote.boards?.restingOrders > 0 ? `<div class="bm-q bm-muted">${S.quote.boards.restingOrders} resting order${S.quote.boards.restingOrders === 1 ? '' : 's'} on zSwap's boards may — <a href="${esc(zswapDeepLink({ host: ZSWAP_HOST, dir: dir(), amount: S.amountStr }) || ZSWAP_HOST)}" target="_blank" rel="noopener noreferrer">fill there ↗</a>.</div>` : ''}`;
      else html = `<div class="bm-q bm-warn">Couldn't reach Ethereum to price this — <button type="button" class="bm-link" data-act="erequote">try again</button>.</div>`;
      el.quote.innerHTML = html; return;
    }
    const { q, bps, minOut, ethPerTac, tacPerEth, feeWei, usdPerTac } = v;
    const outT = outTicker();
    const usdOut = S.side === 'buy' ? (usdPerTac ? toNum(q.best.amountOut) * usdPerTac : null) : ethUsdOf(q.best.amountOut);
    html += row('You get', `<b>${fmtTok(q.best.amountOut, outT)} ${outT}</b>${usdOut != null ? ` <em>${fmtUsd(usdOut)}</em>` : ''}${S.quoting ? ' <em class="bm-refreshing">updating…</em>' : ''}`, 'big');
    html += row('At least', `${fmtTok(minOut, outT)} ${outT} <em>after ${slipLabel()} slippage</em>`);
    html += row('Price', `1 TAC = ${fmtRate(ethPerTac)} ETH${usdPerTac ? ` <em>${fmtUsd(usdPerTac)}</em>` : ''} · 1 ETH = ${fmtRate(tacPerEth)} TAC`);
    if (bps != null) {
      const cls = bps >= IMPACT_BLOCK_BPS ? 'bm-bad' : bps >= IMPACT_WARN_BPS ? 'bm-warn' : '';
      html += row('Price impact', `<span class="${cls}">${fmtPct(bps)}</span>`);
    }
    html += row('Route', `${esc(venueLabel(q.best.venue))}${feePct(q.best) != null ? ` <em>${feePct(q.best).toFixed(2)}% fee</em>` : ''}`);
    html += row('Network fee', feeWei != null ? `≈ ${fmtTok(feeWei, 'ETH')} ETH${ethUsdOf(feeWei) != null ? ` <em>${fmtUsd(ethUsdOf(feeWei))}</em>` : ''}` : 'estimating…', 'muted');
    if (q.best.dustIn > 0n) html += `<div class="bm-q bm-note">${fmtTok(q.best.dustIn, inTicker())} ${inTicker()} stays in your wallet — this venue trades in steps of 0.00000001.</div>`;
    if (bps != null && bps >= IMPACT_BLOCK_BPS) {
      html += `<div class="bm-callout">This trade moves the price by ${(bps / 100).toFixed(1)}%. A smaller amount, or several, would get a better price.
        <label class="bm-check"><input type="checkbox" data-act="eack"${S.ackImpact ? ' checked' : ''}><span>I understand I'm trading well off the market price</span></label></div>`;
    } else if (bps != null && bps >= IMPACT_WARN_BPS) {
      html += `<div class="bm-q bm-note">A large trade for this pool — splitting it would get a better average price.</div>`;
    }
    const z = q.zquoter;
    if (z && z.status === 'ok' && z.amountOut > q.best.amountOut) {
      const zl = zswapDeepLink({ host: ZSWAP_HOST, dir: dir(), amount: S.amountStr || undefined }) || ZSWAP_HOST;
      html += `<div class="bm-q bm-note">zQuoter quotes ${fmtTok(z.amountOut, outT)} ${outT} for this — more than the routes this page sends through. <a href="${esc(zl)}" target="_blank" rel="noopener noreferrer">Fill it on zSwap ↗</a></div>`;
    }
    html += bitcoinCompare(usdPerTac);
    el.quote.innerHTML = html;
  }
  function paintVenues() {
    const q = S.quote;
    const r = spotRates();
    const T = outTicker();
    const rowOf = (label, out, fee, best, why) => `<div class="bm-vrow${best ? ' best' : ''}" title="${esc(why)}"><span class="v">${best ? '<i class="bm-tag best">best</i>' : ''}${esc(label)}</span><span class="o">${out}</span><span class="f">${fee}</span></div>`;
    const amt = parseUnitsStr(S.amountStr);
    let rows = '';
    const head = `<div class="bm-book-head"><span>Venue</span><span>${amt && amt > 0n ? `You'd get <em>${T}</em>` : 'Price'}</span><span>Fee</span></div>`;
    if (q && amt && amt > 0n) {
      const ranked = q.ranked || [];
      const bestVenue = q.best?.venue;
      const seen = new Set();
      for (const v of ranked) {
        seen.add(v.venue);
        rows += rowOf(venueLabel(v.venue), `${fmtTok(v.amountOut, T)}`, feePct(v) != null ? `${feePct(v).toFixed(2)}%` : '—', v.venue === bestVenue, venueWhy(v.venue));
      }
      for (const v of [VENUES.PRECISION, VENUES.TACIT_AMM, VENUES.ZQUOTER]) {
        if (seen.has(v)) continue;
        const st = v === VENUES.ZQUOTER ? q.zquoter?.status : null;
        if (st === 'ok' && q.zquoter.amountOut > 0n) {
          const zl = zswapDeepLink({ host: ZSWAP_HOST, dir: q.dir, amount: S.amountStr || undefined }) || ZSWAP_HOST;
          rows += rowOf(venueLabel(v), `${fmtTok(q.zquoter.amountOut, T)} <a href="${esc(zl)}" target="_blank" rel="noopener noreferrer">fill on zSwap ↗</a>`, feePct(q.zquoter) != null ? `${feePct(q.zquoter).toFixed(2)}%` : '—', false, `${venueWhy(v)} This page can't send through it; zSwap can.`);
          continue;
        }
        const note = st === 'pending' ? 'checking…' : st === 'timeout' ? 'slow to answer' : 'no route';
        rows += rowOf(venueLabel(v), `<em>${note}</em>`, '', false, venueWhy(v));
      }
      const resting = q.boards?.restingOrders || 0;
      const link = resting > 0 ? zswapDeepLink({ host: ZSWAP_HOST, dir: q.dir, amount: S.amountStr || undefined }) : null;
      rows += rowOf('Order boards', resting > 0 ? (link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${resting} resting · fill on zSwap ↗</a>` : `${resting} resting`) : '<em>no resting orders</em>', '', false, 'Limit orders resting on zSwap boards. This page quotes them but fills them on zSwap.');
    } else if (r) {
      rows += rowOf(venueLabel(S.spot.venue), `1 ETH ≈ ${fmtRate(r.tacPerEth)} TAC`, '', true, venueWhy(S.spot.venue));
      rows += `<div class="bm-empty">Enter an amount to compare every venue.</div>`;
    } else {
      rows += `<div class="bm-empty">${S.spotAt === 0 ? 'Reading Ethereum venues…' : 'No venue is quoting right now.'}</div>`;
    }
    const note = `<div class="bm-book-note"><span>One venue fills the whole trade — the best of those this page sends through.</span><span>Prices move block to block; the review re-checks them.</span></div>`;
    const html = head + rows + note;
    if (el.venues.__html !== html) { el.venues.innerHTML = html; el.venues.__html = html; }
  }
  function paintGo() {
    if (S.busy) return;
    const set = (t, on, kind = '') => { el.go.textContent = t; el.go.disabled = !on; el.go.dataset.kind = kind; };
    const amt = parseUnitsStr(S.amountStr);
    if (!amt || amt <= 0n) return set('Enter an amount', false);
    if (!address()) return set('Connect wallet', true, 'connect');
    const b = balIn();
    if (b != null && amt > b) return set(`Not enough ${inTicker()}`, false);
    if (!quoteIsCurrent()) return set(quotePending() ? 'Finding the best price…' : 'No price right now', false);
    if (!S.quote.best) return set('No price right now', false);
    if (S.side === 'buy' && S.ethBal != null && S.gasPrice && amt + feeEstWei(GAS_GUESS.ETH_TO_TAC) > S.ethBal) return set('Not enough ETH for the network fee', false);
    if (S.side === 'sell' && S.ethBal != null && S.gasPrice && S.ethBal < feeEstWei(GAS_GUESS.TAC_TO_ETH)) return set('Not enough ETH for the network fee', false);
    const bps = impactBps(S.quote);
    if (bps != null && bps >= IMPACT_BLOCK_BPS && !S.ackImpact) return set('Confirm the price impact above', false);
    return set(S.side === 'buy' ? 'Review buy' : 'Review sell', true, 'review');
  }
  function paintAll() { if (S.destroyed) return; paintFrame(); paintSpot(); paintBalance(); paintQuote(); paintVenues(); paintGo(); }

  // ── review + execute ──────────────────────────────────────────────────────
  function modal() {
    const wrap = document.createElement('div');
    wrap.className = 'bm-modal';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `<div class="bm-card" data-side="${S.side}"><div class="bm-mbody"></div><div class="bm-mfoot"></div></div>`;
    document.body.appendChild(wrap);
    const body = wrap.querySelector('.bm-mbody'), foot = wrap.querySelector('.bm-mfoot');
    let onKey = null, escLocked = false;
    const openedAt = Date.now();
    const prevFocus = document.activeElement;
    return {
      body, foot,
      set(html) { body.innerHTML = html; },
      buttons(btns) {
        foot.innerHTML = btns.map((b, i) => `<button type="button" data-i="${i}" class="${b.primary ? 'bm-go' : ''}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('');
        foot.querySelectorAll('button').forEach((n) => {
          n.onkeydown = (e) => { if (e.repeat) e.preventDefault(); };
          n.onclick = () => {
            if (n.classList.contains('bm-go') && Date.now() - openedAt < CONFIRM_GRACE_MS) return;
            if (btns[+n.dataset.i].once !== false) {
              foot.querySelectorAll('button').forEach((x) => { x.disabled = true; });
              if (n.classList.contains('bm-go')) n.textContent = 'Working…';
            }
            btns[+n.dataset.i].onClick();
          };
        });
        foot.querySelector('.bm-go')?.focus();
      },
      close() {
        if (onKey) document.removeEventListener('keydown', onKey);
        wrap.remove();
        // Hand the keyboard back to what had it (the amount box), not to the page body.
        try { if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true }); } catch {}
      },
      onEscape(fn) { onKey = (e) => { if (e.key === 'Escape' && !escLocked) fn(); }; document.addEventListener('keydown', onKey); },
      lockEscape() { escLocked = true; },
      unlockEscape() { escLocked = false; },
    };
  }
  const stepsHtml = (steps) => `<ol class="bm-steps">${steps.map((s) => `<li class="${s.status}"><span class="st">${{ queued: '○', working: '◐', waiting: '◔', done: '✓', failed: '✕', skipped: '–' }[s.status] || '○'}</span><span class="lb">${s.label}${s.note ? `<em>${esc(s.note)}</em>` : ''}${s.hash ? ` <a href="${esc(txUrl(s.hash))}" target="_blank" rel="noopener">tx</a>` : ''}</span></li>`).join('')}</ol>`;
  const row = (k, v) => `<div class="bm-qr"><span>${k}</span><span>${v}</span></div>`;

  async function connect() {
    el.go.disabled = true; el.go.textContent = 'Connecting…';
    try {
      await S.opts.connect();
      await refreshBalances();
      refreshGas().then(() => { if (!S.destroyed) { paintBalance(); paintGo(); } });
      scheduleQuote(true);
    } catch (e) {
      notify(friendlyEthError(e), 'error');
    } finally { paintBalance(); paintGo(); }
  }

  async function review() {
    // The page behind a dialog is still reachable by keyboard; one review at a time.
    if (S.busy || S.destroyed || document.querySelector('.bm-modal')) return;
    if (el.go.dataset.kind === 'connect') return connect();
    const v = quoteView();
    const amt = parseUnitsStr(S.amountStr);
    if (!v || !amt) return;
    if (!address()) return connect();
    const { q, bps, minOut, ethPerTac, tacPerEth, feeWei, usdPerTac } = v;
    const outT = outTicker(), inT = inTicker();
    const md = modal();
    md.onEscape(() => md.close());
    const needsApproval = S.side === 'sell';
    const usdIn = S.side === 'buy' ? ethUsdOf(amt) : (usdPerTac ? toNum(amt) * usdPerTac : null);
    md.set(`<h2>${S.side === 'buy' ? 'Buy' : 'Sell'} ${S.side === 'buy' ? fmtTok(q.best.amountOut, 'TAC') : fmtTok(amt, 'TAC')} TAC</h2>
      ${row(S.side === 'buy' ? 'You pay' : 'You sell', `<b>${fmtTok(amt, inT)} ${inT}</b>${usdIn != null ? ` <em>${fmtUsd(usdIn)}</em>` : ''}`)}
      ${row('You get', `≈ ${fmtTok(q.best.amountOut, outT)} ${outT}`)}
      ${row('At least', `<b>${fmtTok(minOut, outT)} ${outT}</b> <em>or the swap reverts</em>`)}
      ${row('Price', `1 TAC = ${fmtRate(ethPerTac)} ETH · 1 ETH = ${fmtRate(tacPerEth)} TAC`)}
      ${bps != null ? row('Price impact', fmtPct(bps)) : ''}
      ${row('Route', `${esc(venueLabel(q.best.venue))} on Ethereum`)}
      ${row('Network fee', feeWei != null ? `≈ ${fmtTok(feeWei, 'ETH')} ETH${ethUsdOf(feeWei) != null ? ` <em>${fmtUsd(ethUsdOf(feeWei))}</em>` : ''}${needsApproval ? ' <em>(two transactions the first time)</em>' : ''}` : 'shown in your wallet')}
      <p class="bm-q bm-muted">The price is checked again right before sending. If it has moved so you'd get less than the figure above, you'll be asked first.</p>
      ${stepsHtml([...(needsApproval ? [{ status: 'queued', label: 'Allow the venue to take your TAC', note: 'skipped if already allowed' }] : []), { status: 'queued', label: 'Confirm in your wallet' }, { status: 'queued', label: 'Confirming on Ethereum' }])}`);
    md.buttons([{ label: 'Cancel', onClick: () => md.close() }, { label: S.side === 'buy' ? 'Buy now' : 'Sell now', primary: true, onClick: () => run(md, { amt, dir: q.dir, reviewed: q.best, minOut, side: S.side }) }]);
  }

  async function waitForReceipt(hash) {
    const start = Date.now();
    for (;;) {
      let r = null;
      try { r = await rpc().receipt(hash); } catch {}
      if (r) return r;
      if (Date.now() - start > RECEIPT_TIMEOUT_MS) throw new Error('Timed out waiting for confirmation — check the transaction on Etherscan.');
      await sleep(RECEIPT_POLL_MS);
    }
  }
  // TAC paid to `account` in this receipt, from the token's Transfer logs.
  function tacReceived(receipt, account) {
    let total = 0n;
    const me = String(account).toLowerCase().replace(/^0x/, '').padStart(64, '0');
    for (const log of receipt?.logs || []) {
      if (String(log.address).toLowerCase() !== TAC_ERC20.toLowerCase()) continue;
      if (!log.topics || log.topics[0] !== ERC20_TRANSFER_TOPIC || log.topics.length < 3) continue;
      if (String(log.topics[2]).toLowerCase().replace(/^0x/, '') !== me) continue;
      try { total += BigInt(log.data); } catch {}
    }
    return total;
  }
  async function ensureAllowance(built, addr, step, paint) {
    if (!built.approval) { if (step && step.status === 'queued') { step.status = 'skipped'; step.note = 'not needed for this route'; paint(); } return; }
    if (step.status === 'done' && step.spender === built.approval.spender) return;
    step.spender = built.approval.spender;
    step.status = 'working'; step.note = 'checking what\'s already allowed'; paint();
    const allowance = decUint256(await rpc().call(built.approval.token, encErc20Allowance(addr, built.approval.spender)));
    if (allowance >= built.approval.amount) { step.status = 'skipped'; step.note = 'already allowed'; paint(); return; }
    step.note = 'confirm the allowance in your wallet'; paint();
    const hash = await S.opts.sendTx({ from: addr, to: built.approval.token, data: encErc20Approve(built.approval.spender, built.approval.amount) });
    step.status = 'waiting'; step.note = 'waiting for it to confirm'; step.hash = hash; paint();
    const r = await waitForReceipt(hash);
    if (r && r.status !== '0x1') throw new Error('The allowance transaction reverted.');
    step.status = 'done'; step.note = ''; paint();
  }

  // The reviewed floor (`minOut`) is what runs: a fresh quote that still clears it is sent
  // with that same floor; one that can't asks the user before anything is signed.
  async function run(md, { amt, dir: d, reviewed, minOut, side }) {
    const addr = address();
    if (!addr) { md.close(); return; }
    if (S.busy) { md.set('<h2>Another swap is still running</h2><p class="bm-q">Wait for it to finish, then try again.</p>'); md.buttons([{ label: 'Close', primary: true, onClick: () => md.close() }]); return; }
    S.busy = true; el.go.disabled = true; el.go.textContent = 'Working…';
    md.lockEscape();
    const outT = side === 'buy' ? 'TAC' : 'ETH';
    const approveStep = side === 'sell' ? { status: 'queued', label: 'Allow the venue to take your TAC' } : null;
    const signStep = { status: 'queued', label: 'Confirm in your wallet' };
    const mineStep = { status: 'queued', label: 'Confirming on Ethereum' };
    const steps = [...(approveStep ? [approveStep] : []), signStep, mineStep];
    const title = side === 'buy' ? 'Buying…' : 'Selling…';
    const paint = () => md.set(`<h2>${title}</h2>${stepsHtml(steps)}`);
    md.buttons([]);
    paint();
    let err = null, hash = null, receipt = null, quoteUsed = reviewed, minUsed = minOut;
    try {
      let built = venues().build({ quote: reviewed, dir: d, account: addr, slippageBps: S.slippageBps, minOut });
      await ensureAllowance(built, addr, approveStep, paint);

      signStep.status = 'working'; signStep.note = 're-checking the price'; paint();
      const fresh = await venues().quoteAll({ dir: d, amountIn: amt, account: addr, includeZQuoter: false });
      if (!fresh.best) throw new Error('No venue can fill this amount right now — nothing was sent.');
      if (fresh.best.amountOut < minOut) {
        const newMin = minOutOf(fresh.best.amountOut, S.slippageBps);
        const accepted = await new Promise((resolve) => {
          md.set(`<h2>The price moved</h2>
            ${row('You were shown', `≈ ${fmtTok(reviewed.amountOut, outT)} ${outT} <em>at least ${fmtTok(minOut, outT)}</em>`)}
            ${row('It is now', `<b>≈ ${fmtTok(fresh.best.amountOut, outT)} ${outT}</b> <em>at least ${fmtTok(newMin, outT)}</em>`)}
            <p class="bm-q bm-muted">Nothing has been sent. Continue at the new price, or stop here.</p>`);
          md.buttons([{ label: 'Stop — send nothing', onClick: () => resolve(false) }, { label: 'Continue at the new price', primary: true, onClick: () => resolve(true) }]);
        });
        if (!accepted) {
          S.quote = fresh; S.busy = false; paintAll();
          md.unlockEscape();
          md.set('<h2>Nothing sent</h2><p class="bm-q">The quote on the page has been refreshed.</p>');
          md.buttons([{ label: 'Done', primary: true, onClick: () => md.close() }]);
          return;
        }
        quoteUsed = fresh.best; minUsed = newMin;
        paint();
      } else {
        quoteUsed = fresh.best;
      }
      built = venues().build({ quote: quoteUsed, dir: d, account: addr, slippageBps: S.slippageBps, minOut: minUsed });
      // The winning venue may have changed between the two quotes; the allowance follows it.
      if (approveStep) await ensureAllowance(built, addr, approveStep, paint);

      signStep.status = 'working'; signStep.note = 'simulating'; paint();
      const valueHex = built.value && built.value > 0n ? hex(built.value) : undefined;
      try { await rpc().call(built.to, built.data, 'latest', { from: addr, value: valueHex }); }
      catch (simErr) {
        const reason = decodeRevertReason(simErr);
        if (/insufficient funds/i.test(String(simErr?.message || ''))) throw new Error('insufficient funds');
        throw new Error(reason ? `It would fail: ${reason}` : 'This swap would fail right now — nothing was sent. Quote again or allow more slippage.');
      }
      signStep.note = 'confirm in your wallet'; paint();
      hash = await S.opts.sendTx({ from: addr, to: built.to, data: built.data, value: valueHex });
      signStep.status = 'done'; signStep.note = ''; signStep.hash = hash;
      mineStep.status = 'waiting'; mineStep.note = 'usually under a minute'; paint();
      receipt = await waitForReceipt(hash);
      if (receipt && receipt.status !== '0x1') throw new Error('The swap reverted on Ethereum — your funds stayed where they were, only the network fee was spent.');
      mineStep.status = 'done'; mineStep.note = '';
    } catch (e) {
      err = e;
      const s = steps.find((x) => x.status === 'working' || x.status === 'waiting') || signStep;
      s.status = 'failed'; s.note = friendlyEthError(e);
      for (const x of steps) if (x.status === 'queued') x.status = 'skipped';
    }
    S.busy = false;
    md.unlockEscape();
    if (err) {
      md.set(`<h2>${hash ? 'Swap failed' : 'Nothing sent'}</h2><p class="bm-q">${esc(friendlyEthError(err))}</p>${stepsHtml(steps)}`);
      md.buttons([{ label: 'Done', primary: true, onClick: () => md.close() }]);
      if (!isUserRejection(err)) notify(friendlyEthError(err), 'error');
      refreshBalances(); scheduleQuote(true); paintGo();
      return;
    }
    const got = side === 'buy' ? tacReceived(receipt, addr) : null;
    const before = side === 'sell' ? S.ethBal : null;
    S.amountStr = ''; el.amount.value = ''; S.quote = null; S.ackImpact = false;
    await refreshBalances();
    const ethDelta = side === 'sell' && before != null && S.ethBal != null ? S.ethBal - before : null;
    const headline = side === 'buy'
      ? `Bought ${fmtTok(got > 0n ? got : quoteUsed.amountOut, 'TAC')} TAC`
      : `Sold ${fmtTok(amt, 'TAC')} TAC`;
    const detail = side === 'buy'
      ? `${got > 0n ? 'It' : 'About that much'} is in your Ethereum wallet now.`
      : (ethDelta != null && ethDelta > 0n ? `Your ETH balance rose by about ${fmtTok(ethDelta, 'ETH')} ETH after the network fee.` : `About ${fmtTok(quoteUsed.amountOut, 'ETH')} ETH is in your Ethereum wallet now.`);
    md.set(`<h2>${headline}</h2><p class="bm-q">${detail} <a href="${esc(txUrl(hash))}" target="_blank" rel="noopener noreferrer">View on Etherscan ↗</a></p>${stepsHtml(steps)}`);
    md.buttons([{ label: 'Done', primary: true, onClick: () => md.close() }]);
    notify(headline, 'ok');
    paintAll();
  }

  // ── events ────────────────────────────────────────────────────────────────
  host.addEventListener('click', (e) => {
    if (S.destroyed) return;
    const t = e.target.closest('[data-act]');
    if (!t || !host.contains(t)) return;
    const act = t.dataset.act;
    if (act === 'eside') {
      if (S.side !== t.dataset.v) {
        S.side = t.dataset.v; S.amountStr = ''; el.amount.value = ''; S.quote = null; S.quoting = false; S.quoteSeq++; clearTimeout(S.debTimer); S.debTimer = null; S.ackImpact = false; savePref();
        paintAll(); refreshSpot(true); el.amount.focus({ preventScroll: true });
      }
      return;
    }
    if (act === 'echip') { S.amountStr = t.dataset.v; el.amount.value = t.dataset.v; S.ackImpact = false; scheduleQuote(true); paintGo(); return; }
    if (act === 'econnect') { connect(); return; }
    if (act === 'erequote') { scheduleQuote(true); return; }
    if (act === 'ego') { review(); return; }
  }, sig);
  host.addEventListener('change', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'eslip') { S.slippageBps = Number(t.value) || DEFAULT_SLIPPAGE_BPS; savePref(); paintOpts(); paintQuote(); }
    if (t.dataset.act === 'eack') { S.ackImpact = t.checked; paintGo(); }
  }, sig);
  el.amount.addEventListener('input', () => { S.amountStr = el.amount.value; S.ackImpact = false; scheduleQuote(false); paintQuote(); paintGo(); }, sig);
  el.amount.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.go.disabled) review(); }, sig);

  // ── background ────────────────────────────────────────────────────────────
  S.bgTimer = setInterval(() => {
    if (S.destroyed || S.busy) return;
    if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
    if (!host.isConnected) { destroy(); return; }
    if (address() !== S.balAddr) refreshBalances();
    refreshSpot();
    const amt = parseUnitsStr(S.amountStr);
    if (amt && amt > 0n) scheduleQuote(true);
  }, BG_REQUOTE_MS);
  function destroy() {
    S.destroyed = true;
    clearTimeout(S.debTimer); clearInterval(S.bgTimer);
    ac.abort();
  }

  // first paint
  paintAll();
  refreshSpot(true);
  refreshBalances();
  refreshGas().then(() => { if (!S.destroyed) { paintBalance(); paintQuote(); paintGo(); } });
  (S.opts.ethUsd ? Promise.resolve(S.opts.ethUsd()) : fetchEthUsd()).then((p) => { if (!S.destroyed && p > 0) { S.ethUsd = p; paintSpot(); paintQuote(); } }).catch(() => {});

  return {
    setOpts(o) { S.opts = o || {}; paintBalance(); paintGo(); if (address() !== S.balAddr) refreshBalances(); },
    refresh() { refreshSpot(true); refreshBalances(); scheduleQuote(true); },
    destroy,
    get state() { return S; },
  };
}
