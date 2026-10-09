// The market page for one asset: header, live order book, trade ticket, your orders and
// recent trades. Planning is btc-book.js; settlement is the audited executors in tacit.js,
// reached only through `ctx` (see _btcMarketCtx there), so this module never builds a
// transaction itself.
//
// Rendering: the shell is written once per asset. Inputs are never re-rendered — refreshes
// patch the text of output nodes and swap the ladder rows, so typing, focus and scroll
// survive every update. A 10 s loop (visible tab only) keeps the book, quote and your
// orders live; a trade you make refreshes immediately.
//
// Safety: what the review screen shows is what runs. After you confirm, the page may
// re-route around an offer someone else took, but only inside the bounds you confirmed
// (never more sats, never a worse price — withinBounds in btc-book.js); anything else
// stops and says so.

import {
  DUST, buildBook, planBuy, planSell, withinBounds, ladderLevels, listingShape,
  parseAmount, fmtAmount, fmtUnit, fmtSats, amountForSats, satsForAmount,
} from './btc-book.js';

const REFRESH_MS = 10_000;
// A refresh that hasn't answered by then counts as failed, so one hung request can't
// freeze the page; the next tick tries again.
const REFRESH_TIMEOUT_MS = 15_000;
const STATS_REFRESH_MS = 60_000;
const SELL_TRACK_MS = 8_000;
const MAX_REROUTES = 3;
// A dialog's confirm button takes focus when it opens, and Enter in the amount box is what
// opens it, so a second Enter (a double tap, or key repeat) would land on it unread. The
// button ignores activation for this long after the dialog appears, and ignores held keys.
const CONFIRM_GRACE_MS = 600;
const LADDER_ROWS = 8;
// Orders this far from the last trade are folded away until "show all" (fat-finger
// bids at a fraction of a sat, asks at many times the price).
const FAR_BELOW = 0.2;
const FAR_ABOVE = 5;
const CHART_TFS = [['1D', 86400, '1D'], ['1W', 7 * 86400, '1W'], ['1M', 30 * 86400, '1M'], ['ALL', Infinity, 'All']];
const SLIPPAGE_CHOICES = [1, 2, 5, 10, 25];
// A market order's default price cap. Thin books (most real listings here) sit in a few
// large, unevenly-priced lots — a tight default cap turns "spend my sats at the best
// price" into "spend my sats, unless that requires reaching the 2nd cheapest lot, in
// which case do nothing and ask me first." Default wide enough that a normal budget
// reaches the real available liquidity in one tap; Settings can still tighten it for
// anyone who wants a hard price ceiling.
const DEFAULT_SLIPPAGE = 25;
const EXPIRY_CHOICES = [[86400, '1 day'], [3 * 86400, '3 days'], [7 * 86400, '7 days'], [30 * 86400, '30 days']];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

function ago(ts) {
  const s = Math.max(0, nowSec() - Number(ts || 0));
  if (!ts) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A unit price as the ticket's price box shows it: display precision, no separators.
function plainUnit(u) {
  return fmtUnit(u).replace(/,/g, '');
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 10_000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  if (v > 0) return '$' + v.toPrecision(3);
  return '$0';
}

// Errors that mean "that offer is gone or moved" and nothing of yours was spent on it.
// A message carrying a commit/recovery marker means sats are in flight — never retried.
export function isRerouteable(err) {
  if (err && typeof err === 'object' && err.noReroute) return false;
  const s = String((err && typeof err === 'object' ? err.message : err) || '');
  if (/Commit tx broadcast|locked at|recovery record/i.test(s)) return false;
  return /already spent|expired|stale|changed since|refresh listings|preauth sale not found|just got taken|intent not found|no such (intent|bid|sale)|claim.*expired|did ?n.t fulfil|already claimed|already pledged|exceeds bid\.remaining|bid expired|\b409\b/i.test(s);
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export function mountBtcMarket(host, ctx) {
  if (host.__btcMarket && host.__btcMarket.aid === ctx.aid) {
    host.__btcMarket.refresh({ soft: true });
    return host.__btcMarket;
  }
  if (host.__btcMarket) host.__btcMarket.destroy();
  const ctl = createMarket(host, ctx);
  host.__btcMarket = ctl;
  return ctl;
}

function createMarket(host, ctx) {
  const aid = ctx.aid;
  const asset0 = ctx.asset();
  const dec = asset0.decimals | 0;
  const T = esc(asset0.ticker || 'token');
  const prefKey = `tacit-btc-market-v1:${aid}`;
  const pref = LS.get(prefKey, {});
  const S = {
    book: null, bookSig: '', levelsSig: '',
    bids: [], stats: null, loadedOnce: false,
    side: pref.side === 'sell' ? 'sell' : 'buy',
    type: pref.type === 'limit' ? 'limit' : 'market',
    buyIn: pref.buyIn === 'token' ? 'token' : 'sats',
    slip: SLIPPAGE_CHOICES.includes(pref.slip) ? pref.slip : DEFAULT_SLIPPAGE,
    includeMaker: pref.includeMaker !== false,
    includeManual: pref.includeManual === true,
    expirySec: EXPIRY_CHOICES.some(([s]) => s === pref.expirySec) ? pref.expirySec : 86400,
    watchtower: pref.watchtower !== false,
    showAllAsks: false, showAllBids: false,
    busy: false, destroyed: false, cancelling: new Set(),
    lastOk: 0, lastErr: null, timer: null, statsAt: 0,
    lane: ctx.initialLane === 'eth' && ctx.mountEth ? 'eth' : 'btc',
    quote: null,
    sells: new Map(Object.entries(LS.get(`tacit-btc-market-sells-v1:${aid}`, {}))),
  };
  const savePref = () => LS.set(prefKey, {
    side: S.side, type: S.type, buyIn: S.buyIn, slip: S.slip, includeMaker: S.includeMaker,
    includeManual: S.includeManual, expirySec: S.expirySec, watchtower: S.watchtower,
  });
  const saveSells = () => LS.set(`tacit-btc-market-sells-v1:${aid}`, Object.fromEntries(S.sells));

  host.innerHTML = shellHtml();
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const $ = (sel) => host.querySelector(sel);
  const $$ = (sel) => Array.from(host.querySelectorAll(sel));
  const el = {
    live: $('[data-k=live]'), price: $('[data-k=price]'), usd: $('[data-k=usd]'), chg: $('[data-k=chg]'),
    stats: $('[data-k=stats]'), chart: $('[data-k=chart]'), chartWrap: $('[data-k=chart-wrap]'), chartSum: $('[data-k=chart-sum]'), avail: $('[data-k=avail]'),
    asks: $('[data-k=asks]'), bids: $('[data-k=bids]'), spread: $('[data-k=spread]'), bookNote: $('[data-k=book-note]'),
    bidMore: $('[data-k=bid-more]'),
    ticket: $('[data-k=ticket]'), amount: $('[data-k=amount]'), price2: $('[data-k=limit-price]'), total: $('[data-k=total]'), modeNote: $('[data-k=mode-note]'),
    unitBtn: $('[data-k=unit]'), chips: $('[data-k=chips]'), bal: $('[data-k=bal]'), quote: $('[data-k=quote]'),
    go: $('[data-k=go]'), fine: $('[data-k=fine]'), opts: $('[data-k=opts]'),
    orders: $('[data-k=orders]'), trades: $('[data-k=trades]'),
    laneBtc: $('[data-lane=btc]'), laneEth: $('[data-lane=eth]'), ethHost: $('[data-k=eth-host]'), laneNote: $('[data-k=lane-note]'),
  };

  function shellHtml() {
    const a = asset0;
    const lanes = ctx.mountEth ? `
      <div class="bm-seg bm-lanes" role="tablist" aria-label="Where to trade">
        <button type="button" role="tab" data-act="lane" data-v="btc">${ctx.icons?.btc || ''}<span>Bitcoin</span></button>
        <button type="button" role="tab" data-act="lane" data-v="eth">${ctx.icons?.eth || ''}<span>Ethereum</span></button>
      </div>` : '';
    return `
    <section class="bm" data-aid="${esc(aid)}">
      <div class="bm-top">
        <a href="#" class="bm-back" data-act="back">&larr; All markets</a>
        <span class="bm-live" data-k="live" aria-live="polite">connecting…</span>
      </div>
      <div class="bm-head">
        <div class="bm-id">${a.identityHtml || `<strong>${T}</strong>`}</div>
        <div class="bm-quoteline">
          <span class="bm-price" data-k="price">—</span><span class="bm-price-unit">sats/${T}</span>
          <span class="bm-usd" data-k="usd"></span>
          <span class="bm-chg" data-k="chg"></span>
        </div>
        <div class="bm-stats" data-k="stats"></div>
      </div>
      <div class="bm-chart" data-k="chart-wrap">
        <div class="bm-chart-top">
          <div class="bm-chart-sum" data-k="chart-sum"></div>
          <div class="bm-seg bm-tf" role="group" aria-label="Chart range">${CHART_TFS.map(([tf, , label]) => `<button type="button" data-act="tf" data-v="${tf}">${label}</button>`).join('')}</div>
        </div>
        <div class="bm-chart-body" data-k="chart"></div>
      </div>
      ${lanes}
      ${ctx.mountEth ? `<p class="bm-lane-note" data-k="lane-note"></p>` : ''}
      <div class="bm-lane" data-lane="btc">
        <div class="bm-grid">
          <div class="bm-left">
          <div class="bm-ticket" data-k="ticket">
            <div class="bm-sides" role="tablist">
              <button type="button" role="tab" data-act="side" data-v="buy">Buy</button>
              <button type="button" role="tab" data-act="side" data-v="sell">Sell</button>
            </div>
            <div class="bm-types">
              <button type="button" data-act="type" data-v="market" title="Market order">Now</button>
              <button type="button" data-act="type" data-v="limit" title="Limit order">At my price</button>
            </div>
            <p class="bm-mode-note" data-k="mode-note"></p>
            <label class="bm-field bm-field-price" data-show="limit">
              <span class="bm-label">Price <em>sats per ${T}</em></span>
              <span class="bm-inputrow"><input data-k="limit-price" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Limit price in sats per ${T}"></span>
              <span class="bm-pricechips" data-k="pricechips"></span>
            </label>
            <label class="bm-field">
              <span class="bm-label" data-k="amount-label">Amount</span>
              <span class="bm-inputrow">
                <input data-k="amount" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Amount">
                <button type="button" class="bm-unit" data-k="unit" data-act="unit"></button>
              </span>
            </label>
            <label class="bm-field" data-show="limit">
              <span class="bm-label">Total <em>sats</em></span>
              <span class="bm-inputrow"><input data-k="total" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="Total in sats"><span class="bm-unit bm-unit-static">${ctx.icons?.btc || ''}sats</span></span>
            </label>
            <div class="bm-chips" data-k="chips"></div>
            <div class="bm-bal" data-k="bal"></div>
            <div class="bm-avail" data-k="avail"></div>
            <div class="bm-quote" data-k="quote" aria-live="polite"></div>
            <details class="bm-opts" data-k="opts"><summary data-k="opts-sum">Settings</summary><div data-k="opts-body"></div></details>
            <button type="button" class="bm-go" data-k="go" data-act="go" disabled>Enter an amount</button>
            <p class="bm-fine" data-k="fine"></p>
          </div>
          <div class="bm-trades" data-k="trades"></div>
          </div>
          <div class="bm-book">
            <div class="bm-book-head"><span>Price <em>sats</em></span><span>Amount <em>${T}</em></span><span>Total <em>sats</em></span></div>
            <div class="bm-asks" data-k="asks"></div>
            <div class="bm-spread" data-k="spread"></div>
            <div class="bm-bids" data-k="bids"></div>
            <button type="button" class="bm-more" data-k="bid-more" data-act="more-bids" hidden></button>
            <div class="bm-book-note" data-k="book-note"></div>
          </div>
        </div>
        <div class="bm-orders" data-k="orders" hidden></div>
      </div>
      ${ctx.mountEth ? `<div class="bm-lane" data-lane="eth" hidden><div data-k="eth-host"></div></div>` : ''}
    </section>`;
  }

  // ── derived data ──────────────────────────────────────────────────────────
  const me = () => ctx.me() || null;

  function rebuildBook() {
    const m = me();
    S.book = buildBook({
      assetId: aid, decimals: dec,
      listings: ctx.listings(),
      bids: S.bids,
      myPubHex: m?.pubHex || null, myH160: m?.h160 || null,
      varIntents: !!ctx.flags?.varIntents,
      takenIds: ctx.takenIds ? ctx.takenIds() : null,
    });
  }

  const eligibleAsks = () => S.book.asks.filter((a) => !a.mine && (S.includeMaker || a.instant));
  const eligibleBids = () => S.book.bids.filter((b) => !b.mine && (S.includeManual || b.auto));
  const refUnit = () => {
    const a = ctx.asset();
    return (S.side === 'buy' ? eligibleAsks()[0]?.unit : eligibleBids()[0]?.unit) || a.markUnit || null;
  };
  // The price limit: a % from the best offer, unless the user picked an exact price
  // from a suggestion (S.limitAt), which lasts until they change side or pick a %.
  const maxBuyUnit = () => {
    if (S.limitAt?.side === 'buy') return S.limitAt.unit;
    const best = eligibleAsks()[0]?.unit;
    return best ? best * (1 + S.slip / 100) : Infinity;
  };
  const minSellUnit = () => {
    if (S.limitAt?.side === 'sell') return S.limitAt.unit;
    const best = eligibleBids()[0]?.unit;
    return best ? best * (1 - S.slip / 100) : 0;
  };
  const usdOf = (sats) => {
    const px = ctx.btcUsd();
    return px > 0 && Number.isFinite(sats) ? (sats / 1e8) * px : null;
  };

  // ── header ────────────────────────────────────────────────────────────────
  let lastPrice = null;
  function paintHeader() {
    const a = ctx.asset();
    const idEl = $('.bm-id');
    if (a.identityHtml && idEl.__html !== a.identityHtml) { idEl.innerHTML = a.identityHtml; idEl.__html = a.identityHtml; }
    const u = a.markUnit;
    if (u > 0) {
      const txt = fmtUnit(u);
      if (el.price.textContent !== txt) {
        if (lastPrice != null && u !== lastPrice) flash(el.price, u > lastPrice ? 'up' : 'down');
        el.price.textContent = txt;
      }
      lastPrice = u;
      const usd = usdOf(u);
      el.usd.textContent = usd != null ? fmtUsd(usd) : '';
    } else {
      el.price.textContent = 'no trades yet';
      el.usd.textContent = '';
    }
    const c = a.change24h;
    if (Number.isFinite(c) && u > 0 && (c !== 0 || a.vol24Sats > 0)) {
      el.chg.textContent = `${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}% 24h`;
      el.chg.className = 'bm-chg ' + (c >= 0 ? 'up' : 'down');
    } else { el.chg.textContent = ''; el.chg.className = 'bm-chg'; }
    const bits = [];
    if (a.lastTradeTs) bits.push(`<span>Last trade <b>${ago(a.lastTradeTs)} ago</b></span>`);
    if (a.vol24Sats != null) bits.push(`<span>24h volume <b>${usdOf(a.vol24Sats) != null ? fmtUsd(usdOf(a.vol24Sats)) : fmtSats(a.vol24Sats) + ' sats'}</b></span>`);
    if (a.mcapSats != null) bits.push(`<span>Market cap <b>${usdOf(a.mcapSats) != null ? fmtUsd(usdOf(a.mcapSats)) : fmtSats(a.mcapSats) + ' sats'}</b></span>`);
    if (a.holders != null) bits.push(`<span>Holders <b>${Number(a.holders).toLocaleString('en-US')}</b></span>`);
    const html = bits.join('');
    if (el.stats.innerHTML !== html) el.stats.innerHTML = html;
  }

  function paintLive() {
    if (S.lane === 'eth') { el.live.className = 'bm-live ok'; el.live.textContent = 'Ethereum mainnet'; return; }
    if (S.lastErr && (!S.lastOk || Date.now() - S.lastOk > 45_000)) {
      el.live.className = 'bm-live bad';
      el.live.innerHTML = `offline — retrying <button type="button" data-act="refresh">retry now</button>`;
      return;
    }
    if (!S.lastOk) { el.live.className = 'bm-live'; el.live.textContent = 'connecting…'; return; }
    const s = Math.floor((Date.now() - S.lastOk) / 1000);
    el.live.className = 'bm-live ok';
    el.live.textContent = s < 3 ? 'live' : `live · ${s}s ago`;
  }

  function flash(node, dir) {
    node.classList.remove('bm-flash-up', 'bm-flash-down');
    node.classList.add(dir === 'up' ? 'bm-flash-up' : 'bm-flash-down');
    clearTimeout(node.__flashT);
    node.__flashT = setTimeout(() => node.classList.remove('bm-flash-up', 'bm-flash-down'), 1500);
  }

  // ── book ──────────────────────────────────────────────────────────────────
  // One ladder row. The shaded bar is cumulative depth from the spread outward, so the
  // book reads as a staircase: how much you'd have to buy (or sell) to reach this price.
  function rowHtml(lv, side, depthPct) {
    let tag = '';
    let why = side === 'ask'
      ? (lv.flag === 'maker' ? 'The seller\'s wallet confirms your claim, usually within seconds; if it\'s offline the page moves on and nothing is spent.' : lv.count > 1 ? 'Whole pieces — each is bought entirely or not at all.' : 'Sold as one whole piece.')
      : (lv.flag === 'auto' ? 'A watchtower settles this bid for the bidder, usually within a couple of minutes.' : 'Settles only while the bidder\'s wallet is online.');
    if (lv.flag === 'mine') { tag = '<i class="bm-tag you">you</i>'; why = 'Your order — manage it under Your orders.'; }
    else if (side === 'ask' && lv.flag === 'maker') tag = '<i class="bm-dot wait" aria-label="seller confirms"></i>';
    else if (side === 'bid' && lv.flag === 'auto') tag = '<i class="bm-dot auto" aria-label="auto-settles"></i>';
    const pieces = lv.count > 1 ? `${lv.count} ${side === 'ask' ? 'pieces' : 'bids'} · ` : '';
    return `<button type="button" class="bm-row ${side}" data-act="row" data-side="${side}" data-key="${esc(lv.key)}" style="--w:${depthPct}%" title="${esc(pieces + why + ' Click to ' + (side === 'ask' ? 'buy' : 'sell') + ' up to this price.')}">
      <span class="p">${fmtUnit(lv.unit)}</span><span class="a">${tag}${fmtAmount(lv.amount, dec, 4)}</span><span class="t">${fmtSats(lv.sats)}</span></button>`;
  }

  function paintBook() {
    const b = S.book;
    const ref = ctx.asset().markUnit || (b.bestAsk && b.bestBid ? (b.bestAsk + b.bestBid) / 2 : b.bestAsk || b.bestBid);
    const near = (r) => r.mine || !ref || (r.unit >= ref * FAR_BELOW && r.unit <= ref * FAR_ABOVE);
    const askLv = ladderLevels(S.showAllAsks ? b.asks : b.asks.filter(near), 'ask');
    const bidLv = ladderLevels(S.showAllBids ? b.bids : b.bids.filter(near), 'bid');
    const farAsks = b.asks.length - b.asks.filter(near).length;
    const farBids = b.bids.length - b.bids.filter(near).length;
    const askShown = S.showAllAsks ? askLv : askLv.slice(0, LADDER_ROWS);
    const bidShown = S.showAllBids ? bidLv : bidLv.slice(0, LADDER_ROWS);
    const cum = (ls) => { let t = 0; return ls.map((l) => (t += l.sats)); };
    const askCum = cum(askShown), bidCum = cum(bidShown);
    const maxCum = Math.max(askCum[askCum.length - 1] || 0, bidCum[bidCum.length - 1] || 0, 1);
    const pct = (v) => Math.max(1, Math.round((v / maxCum) * 100));
    const sig = [askShown, bidShown].map((ls) => ls.map((l) => l.key + ':' + l.amount + ':' + l.count).join(',')).join('|') + S.showAllAsks + S.showAllBids;
    if (sig !== S.levelsSig) {
      S.levelsSig = sig;
      el.asks.innerHTML = askShown.length
        ? askShown.map((l, i) => rowHtml(l, 'ask', pct(askCum[i]))).reverse().join('')
        : `<div class="bm-empty">No one is selling right now.${S.side === 'buy' ? ' Place a limit bid and sellers can fill it.' : ''}</div>`;
      el.bids.innerHTML = bidShown.length
        ? bidShown.map((l, i) => rowHtml(l, 'bid', pct(bidCum[i]))).join('')
        : `<div class="bm-empty">No one is bidding right now.${S.side === 'sell' ? ' List at your price and buyers can take it.' : ''}</div>`;
      S.ladder = { ask: new Map(askLv.map((l) => [l.key, l])), bid: new Map(bidLv.map((l) => [l.key, l])) };
    }
    const allAskLv = ladderLevels(b.asks, 'ask').length;
    const allBidLv = ladderLevels(b.bids, 'bid').length;
    const hiddenLv = (allAskLv - askShown.length) + (allBidLv - bidShown.length);
    const full = S.showAllAsks && S.showAllBids;
    el.bidMore.hidden = !full && hiddenLv <= 0;
    el.bidMore.textContent = full ? 'Show less' : `Full book · ${allAskLv} asks, ${allBidLv} bids`;
    el.bidMore.title = (farAsks + farBids) ? `Includes ${farAsks + farBids} priced far from the market` : '';
    const a = ctx.asset();
    let sp = '';
    if (a.markUnit > 0) sp += `<span class="bm-sp-last" title="Price of the last trade"><b>${fmtUnit(a.markUnit)}</b><em>last</em></span>`;
    if (b.bestAsk != null && b.bestBid != null) {
      if (b.overlap) {
        const autoAbove = b.bids.some((x) => !x.mine && x.auto && x.unit > b.bestAsk);
        sp += `<span class="bm-sp-note" title="${autoAbove ? 'Some bids pay more than the cheapest ask — sell into them now.' : 'Some bids pay more than the cheapest ask, but their bidders settle only while online.'}">bids over ask</span>`;
      } else {
        const pc = ((b.bestAsk - b.bestBid) / b.bestAsk) * 100;
        sp += `<span class="bm-sp-note">spread ${fmtUnit(b.bestAsk - b.bestBid)} · ${pc.toFixed(pc < 1 ? 2 : 1)}%</span>`;
      }
    }
    if (el.spread.innerHTML !== sp) el.spread.innerHTML = sp;
    const ex = b.excluded;
    const hid = (ex.asks.otc || 0);
    const notes = [];
    if (hid) notes.push(`${hid} OTC offer${hid === 1 ? '' : 's'} that need${hid === 1 ? 's' : ''} trust in the seller ${hid === 1 ? 'isn\'t' : 'aren\'t'} shown`);
    const stale = (ex.asks.stale || 0) + (ex.asks.claimed || 0);
    if (stale) notes.push(`${stale} offer${stale === 1 ? ' is' : 's are'} busy or inactive and hidden`);
    // Each fact on its own line rather than one dense run-on sentence — a small "key"
    // for the dots and the few whole-piece/online-only asks, not a paragraph to parse.
    const legend = [];
    if (b.asks.some((x) => !x.mine && x.whole)) legend.push('Asks sell as whole pieces');
    if (b.asks.some((x) => !x.mine && !x.instant)) legend.push('<i class="bm-dot wait"></i> the seller confirms your claim');
    if (b.bids.some((x) => !x.mine && x.auto)) legend.push('<i class="bm-dot auto"></i> settles automatically');
    if (b.bids.some((x) => !x.mine && !x.auto)) legend.push('some bids need the bidder online');
    const nb = [...legend, ...notes.map(esc)].map((t) => `<span>${t}</span>`).join('');
    if (el.bookNote.innerHTML !== nb) el.bookNote.innerHTML = nb;
  }

  // ── ticket ────────────────────────────────────────────────────────────────
  function paintTicketFrame() {
    $$('[data-act=side]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === S.side)));
    $$('[data-act=type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S.type)));
    el.ticket.dataset.side = S.side;
    el.ticket.dataset.type = S.type;
    $$('[data-show=limit]').forEach((n) => { n.hidden = S.type !== 'limit'; });
    const lbl = $('[data-k=amount-label]');
    if (S.type === 'limit') {
      lbl.innerHTML = `Amount <em>${T}</em>`;
      el.unitBtn.hidden = true;
    } else if (S.side === 'buy') {
      lbl.innerHTML = S.buyIn === 'sats' ? 'You spend' : 'You get';
      el.unitBtn.hidden = false;
      el.unitBtn.innerHTML = `${S.buyIn === 'sats' ? (ctx.icons?.btc || '') + 'sats' : (ctx.asset().iconHtml || '') + T} <span class="sw" aria-hidden="true">⇄</span>`;
      el.unitBtn.title = S.buyIn === 'sats' ? `Enter how many ${asset0.ticker} you want instead` : 'Enter how many sats to spend instead';
    } else {
      lbl.innerHTML = 'You sell';
      el.unitBtn.hidden = false;
      el.unitBtn.innerHTML = `${ctx.asset().iconHtml || ''}${T}`;
      el.unitBtn.title = '';
    }
    paintOpts();
    el.modeNote.textContent = {
      'buy-market': 'Buy from the cheapest sellers right now.',
      'buy-limit': 'Name your price. Anything offered at or below it fills now; the rest waits on the book as your bid.',
      'sell-market': 'Sell to the best bids right now.',
      'sell-limit': 'Name your price. Your tokens are listed on the book and buyers take them — you don\'t need to be online.',
    }[`${S.side}-${S.type}`];
    el.fine.innerHTML = S.side === 'buy'
      ? 'Settles on Bitcoin, peer to peer. No custodian, no wrapped coins.'
      : 'Settles on Bitcoin, peer to peer. You keep your tokens until a buyer pays.';
  }

  function paintOpts() {
    const body = $('[data-k=opts-body]');
    const slip = `<label class="bm-opt"><span>${S.side === 'buy' ? 'Max price' : 'Min price'}</span>
      <select data-act="slip">${SLIPPAGE_CHOICES.map((p) => `<option value="${p}"${p === S.slip ? ' selected' : ''}>${S.side === 'buy' ? '+' : '−'}${p}% from best</option>`).join('')}</select></label>`;
    const flag = S.side === 'buy'
      ? `<label class="bm-check"><input type="checkbox" data-act="inc-maker"${S.includeMaker ? ' checked' : ''}> Include offers the seller confirms <em>(adds a few seconds; skipped if they're offline)</em></label>`
      : `<label class="bm-check"><input type="checkbox" data-act="inc-manual"${S.includeManual ? ' checked' : ''}> Include bids without auto-settle <em>(they complete only when the bidder is online — could be hours)</em></label>`;
    const expiry = `<label class="bm-opt"><span>Order lasts</span><select data-act="expiry">${EXPIRY_CHOICES.map(([s, l]) => `<option value="${s}"${s === S.expirySec ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    const html = S.type === 'market' ? slip + flag : expiry;
    if (body.innerHTML !== html) body.innerHTML = html;
    const sum = $('[data-k=opts-sum]');
    const exp = EXPIRY_CHOICES.find(([x]) => x === S.expirySec)?.[1] || '1 day';
    sum.innerHTML = S.type === 'market'
      ? (S.limitAt?.side === S.side
        ? `${S.side === 'buy' ? 'Max price' : 'Min price'} <b>${fmtUnit(S.limitAt.unit)}</b>`
        : `${S.side === 'buy' ? 'Max price' : 'Min price'} <b>${S.side === 'buy' ? '+' : '−'}${S.slip}%</b> from best`)
      : `Order lasts <b>${exp}</b>`;
  }

  function paintBalance() {
    const m = me();
    const chips = [];
    let bal = '';
    if (!m) {
      bal = `<button type="button" class="bm-link" data-act="unlock">Connect a wallet</button> to see your balance`;
    } else if (!m.unlocked) {
      bal = `<button type="button" class="bm-link" data-act="unlock">Unlock</button> to see your balance`;
    } else if (S.side === 'buy') {
      bal = m.sats == null ? 'Balance: checking…' : `Balance: <b>${fmtSats(m.sats)}</b> sats${m.sats < 2000 ? ` · <button type="button" class="bm-link" data-act="fund">add sats</button>` : ''}`;
      if (m.sats > 0 && S.type === 'market' && S.buyIn === 'sats') {
        const spendable = Math.max(0, m.sats - reserveSats());
        for (const p of [25, 50, 100]) {
          const v = Math.floor(spendable * p / 100);
          if (v >= DUST) chips.push(`<button type="button" data-act="chip" data-v="${v}">${p === 100 ? 'Max' : p + '%'}</button>`);
        }
      }
    } else {
      const free = freeBase(m);
      const locked = free == null ? 0n : m.assetBase - free;
      bal = free == null ? `Balance: checking…` : `Balance: <b>${fmtAmount(free, dec)}</b> ${T}${locked > 0n ? ` <em>· ${fmtAmount(locked, dec)} ${T} in your open orders</em>` : ''}`;
      if (free > 0n) {
        for (const p of [25, 50, 100]) {
          const v = (free * BigInt(p)) / 100n;
          if (v > 0n) chips.push(`<button type="button" data-act="chip" data-v="${fmtAmount(v, dec).replace(/,/g, '')}">${p === 100 ? 'Max' : p + '%'}</button>`);
        }
      }
    }
    if (el.bal.innerHTML !== bal) el.bal.innerHTML = bal;
    const ch = chips.join('');
    if (el.chips.innerHTML !== ch) el.chips.innerHTML = ch;
    const pc = $('[data-k=pricechips]');
    if (S.type === 'limit' && S.book) {
      const pcs = [];
      const b = S.book;
      if (b.bestBid) pcs.push(`<button type="button" data-act="pchip" data-v="${b.bestBid}">best bid ${fmtUnit(b.bestBid)}</button>`);
      if (b.bestAsk) pcs.push(`<button type="button" data-act="pchip" data-v="${b.bestAsk}">best ask ${fmtUnit(b.bestAsk)}</button>`);
      if (ctx.asset().markUnit > 0) pcs.push(`<button type="button" data-act="pchip" data-v="${ctx.asset().markUnit}">last ${fmtUnit(ctx.asset().markUnit)}</button>`);
      const h = pcs.join('');
      if (pc.innerHTML !== h) pc.innerHTML = h;
    }
  }

  // Sats a buy keeps back for network fees.
  const reserveSats = () => 3000;

  // Parse the ticket into an order description (no network).
  function readOrder() {
    const amtTxt = el.amount.value;
    if (S.type === 'market') {
      if (S.side === 'buy') {
        if (S.buyIn === 'sats') {
          const v = Number(String(amtTxt).replace(/[,_\s]/g, ''));
          return Number.isFinite(v) && v > 0 ? { side: 'buy', type: 'market', spendSats: Math.floor(v) } : null;
        }
        const base = parseAmount(amtTxt, dec);
        return base && base > 0n ? { side: 'buy', type: 'market', receiveBase: base } : null;
      }
      const base = parseAmount(amtTxt, dec);
      return base && base > 0n ? { side: 'sell', type: 'market', sellBase: base } : null;
    }
    const unit = Number(String(el.price2.value).replace(/[,_\s]/g, ''));
    const base = parseAmount(amtTxt, dec);
    if (!(unit > 0) || !base || base <= 0n) return { side: S.side, type: 'limit', unit: unit > 0 ? unit : null, base: base || null, incomplete: true };
    return { side: S.side, type: 'limit', unit, base, totalSats: satsForAmount(base, unit, dec) };
  }

  function computeQuote() {
    if (!S.book) return null;
    const o = readOrder();
    if (!o || o.incomplete) return { order: o, empty: true };
    if (o.type === 'market' && o.side === 'buy') {
      const maxUnit = maxBuyUnit();
      const plan = planBuy(S.book, { spendSats: o.spendSats ?? null, receiveBase: o.receiveBase ?? null, maxUnit, includeIntents: S.includeMaker });
      return { order: o, plan, maxUnit };
    }
    if (o.type === 'market' && o.side === 'sell') {
      const minUnit = minSellUnit();
      const plan = planSell(S.book, { sellBase: o.sellBase, minUnit, includeManual: S.includeManual });
      return { order: o, plan, minUnit };
    }
    if (o.side === 'buy') {
      const now = planBuy(S.book, { spendSats: o.totalSats, maxBase: o.base, maxUnit: o.unit, includeIntents: S.includeMaker });
      return { order: o, plan: now, limit: true };
    }
    const bestSellable = eligibleBids()[0]?.unit;
    return { order: o, limit: true, shape: listingShape(o.base, o.unit, dec), crosses: bestSellable != null && bestSellable >= o.unit, bestSellable };
  }

  function setGo(text, enabled, kind = '') {
    el.go.textContent = text;
    el.go.disabled = !enabled;
    el.go.dataset.kind = kind;
  }

  function paintAvail(q) {
    let h = '';
    if (S.book && (!q || q.empty) && S.type === 'market') {
      if (S.side === 'buy') {
        const asks = eligibleAsks();
        if (asks.length) {
          const smallest = asks.reduce((m, a) => (a.sats < m.sats ? a : m), asks[0]);
          h = `Best offer <b>${fmtUnit(asks[0].unit)}</b> sats/${T} · smallest piece ${fmtAmount(smallest.amount, dec, 4)} ${T} for ${fmtSats(smallest.sats)} sats`;
        } else h = 'No one is selling right now.';
      } else {
        const bids = eligibleBids();
        const manual = S.book.bids.filter((b) => !b.mine && !b.auto).length;
        if (bids.length) h = `Best bid <b>${fmtUnit(bids[0].unit)}</b> sats/${T} · ${bids.length} bid${bids.length === 1 ? '' : 's'} you can sell into now`;
        else if (manual) h = `No auto-settling bids. ${manual} bid${manual === 1 ? ' settles' : 's settle'} only when the bidder is online — allow them in Settings, or <button type="button" class="bm-link" data-act="to-limit">list at your price</button>.`;
        else h = 'No one is bidding right now.';
      }
    }
    if (el.avail.innerHTML !== h) el.avail.innerHTML = h;
  }

  // How far a fill's average price sits from the last trade, as a note when it's a lot
  // worse than the market the page header shows (a thin book can ask well above it).
  function offMarketNote(p, side) {
    const mark = ctx.asset().markUnit;
    if (!(mark > 0) || !p?.avgUnit) return '';
    const off = side === 'buy' ? (p.avgUnit - mark) / mark : (mark - p.avgUnit) / mark;
    if (off < 0.1) return '';
    return `<div class="bm-q bm-warn">${side === 'buy' ? 'Pays' : 'Sells'} ${Math.round(off * 100)}% ${side === 'buy' ? 'above' : 'below'} the last trade (${fmtUnit(mark)} sats/${T}). Check the book or set a tighter price limit in Settings.</div>`;
  }

  function paintQuote() {
    if (S.busy) return;
    const q = computeQuote();
    paintAvail(q);
    S.quote = q;
    const m = me();
    let html = '';
    if (!S.book) { el.quote.innerHTML = '<div class="bm-q bm-muted">Loading the book…</div>'; setGo('Loading…', false); return; }
    if (!q || q.empty) {
      const o = q?.order;
      if (o?.type === 'limit' && o.base && o.unit) html = '';
      else if (o?.type === 'limit' && (o.base || o.unit)) html = `<div class="bm-q bm-muted">Enter both a price and an amount.</div>`;
      el.quote.innerHTML = html;
      setGo(S.type === 'limit' ? 'Enter price and amount' : 'Enter an amount', false);
      return;
    }
    const o = q.order;
    const row = (k, v, cls = '') => `<div class="bm-qr ${cls}"><span>${k}</span><span>${v}</span></div>`;
    const usd = (s) => { const u = usdOf(s); return u != null ? ` <em>${fmtUsd(u)}</em>` : ''; };
    if (o.type === 'market' && o.side === 'buy') {
      const p = q.plan;
      if (!p.fills.length) {
        const cheapBig = p.skipped.find((s) => s.reason === 'too-big');
        let why = 'No sell offers within your max price right now.';
        if (!S.book.asks.some((a) => !a.mine)) why = 'No one is selling right now.';
        else if (cheapBig && o.spendSats != null) why = `The cheapest offer is one piece of ${fmtAmount(cheapBig.ask.amount, dec, 4)} ${T} for ${fmtSats(cheapBig.ask.sats)} sats — more than you entered.`;
        else if (cheapBig) why = `Offers at this price come in larger pieces than you asked for (smallest: ${fmtAmount(cheapBig.ask.amount, dec, 4)} ${T}).`;
        // What the same order could fill with no price limit, offered as a one-tap raise.
        const wide = S.book.asks.some((a) => !a.mine) ? planBuy(S.book, { spendSats: o.spendSats ?? null, receiveBase: o.receiveBase ?? null, maxUnit: Infinity, includeIntents: S.includeMaker }) : null;
        const best = eligibleAsks()[0]?.unit;
        let offer = '';
        if (wide && wide.fills.length && best) {
          why = `Nothing fills within your price limit of ${fmtUnit(q.maxUnit)}.`;
          const over = ((wide.worstUnit - best) / best) * 100;
          offer = `<div class="bm-callout"><div>Your ${o.spendSats != null ? `${fmtSats(o.spendSats)} sats` : 'order'} can buy <b>${fmtAmount(wide.amount, dec, 4)} ${T}</b> at up to <b>${fmtUnit(wide.worstUnit)}</b> — ${over.toFixed(0)}% above the best offer.</div>
            <div class="bm-actions"><button type="button" class="bm-btn" data-act="allow-price" data-v="${wide.worstUnit}">Allow up to ${fmtUnit(wide.worstUnit)}</button><button type="button" class="bm-btn ghost" data-act="to-limit">Bid at my price</button></div></div>`;
        } else {
          offer = `<div class="bm-actions"><button type="button" class="bm-btn" data-act="to-limit">Place a bid at my price</button></div>`;
        }
        html = `<div class="bm-q bm-warn">${why}</div>${offer}`;
        el.quote.innerHTML = html;
        setGo('No match at this price', false);
        return;
      }
      html += row('You get', `<b>${fmtAmount(p.amount, dec, 6)} ${T}</b>`, 'big');
      html += row('You pay', `${fmtSats(p.sats)} sats${usd(p.sats)}`);
      html += row('Average price', `${fmtUnit(p.avgUnit)} sats/${T}`);
      html += row('Network fees', `≈ ${fmtSats(p.feesEst)} sats`, 'muted');
      html += offMarketNote(p, 'buy');
      if (p.leftoverSats >= DUST && o.spendSats != null) html += `<div class="bm-q bm-note">${fmtSats(p.leftoverSats)} sats can't fill at this price and stay in your wallet.</div>`;
      if (p.shortBase > 0n) html += `<div class="bm-q bm-note">Only ${fmtAmount(p.amount, dec, 4)} ${T} is for sale within your max price.</div>`;
      if (p.overBase > 0n) html += `<div class="bm-q bm-note">Includes ${fmtAmount(p.overBase, dec, 4)} ${T} extra — offers are sold in whole pieces.</div>`;
      const big = p.skipped.find((s) => s.reason === 'too-big' && s.ask.unit < p.avgUnit);
      if (big && o.spendSats != null) html += `<div class="bm-q bm-muted">A cheaper piece (${fmtAmount(big.ask.amount, dec, 4)} ${T} at ${fmtUnit(big.ask.unit)}) needs ${fmtSats(big.ask.sats)} sats.</div>`;
      if (p.needsMaker) html += `<div class="bm-q bm-muted">Some of this fills from offers the seller confirms — usually seconds.</div>`;
      el.quote.innerHTML = html;
      if (m && m.unlocked && m.sats != null && m.sats < p.sats + p.feesEst) { setGo(`Add ${fmtSats(p.sats + p.feesEst - m.sats)} more sats`, true, 'fund'); return; }
      setGo(`Review buy`, true, 'review');
      return;
    }
    if (o.type === 'market' && o.side === 'sell') {
      const p = q.plan;
      const free = m?.unlocked ? freeBase(m) : null;
      if (free != null && o.sellBase > free) {
        const locked = m.assetBase - free;
        el.quote.innerHTML = `<div class="bm-q bm-warn">You have ${fmtAmount(free, dec)} ${T} available${locked > 0n ? ` — ${fmtAmount(locked, dec)} ${T} is in your open orders` : ''}.</div>`;
        setGo(`Not enough ${asset0.ticker}`, false);
        return;
      }
      if (!p.fills.length) {
        let why = 'No bids within your min price right now.';
        if (!S.book.bids.some((b) => !b.mine)) why = 'No one is bidding right now.';
        else if (p.manualAvailable) why = `No bids that settle automatically. ${p.manualAvailable} bid${p.manualAvailable === 1 ? ' settles' : 's settle'} only while the bidder is online — it can take hours.`;
        else if (p.skipped.some((s) => s.reason === 'too-big')) why = 'The bids here want more than you entered.';
        const acts = [];
        if (p.manualAvailable) acts.push(`<button type="button" class="bm-btn" data-act="inc-manual-now">Offer to online-only bids</button>`);
        const wideBid = S.book.bids.find((b) => !b.mine && (S.includeManual || b.auto));
        if (!p.manualAvailable && wideBid && wideBid.unit < minSellUnit()) acts.push(`<button type="button" class="bm-btn" data-act="allow-price" data-v="${wideBid.unit}">Allow down to ${fmtUnit(wideBid.unit)}</button>`);
        acts.push(`<button type="button" class="bm-btn ${acts.length ? 'ghost' : ''}" data-act="to-limit">List at my price</button>`);
        html = `<div class="bm-q bm-warn">${why}</div><div class="bm-actions">${acts.join('')}</div>`;
        el.quote.innerHTML = html;
        setGo('No match at this price', false);
        return;
      }
      html += row('You get', `<b>${fmtSats(p.sats)} sats</b>${usd(p.sats)}`, 'big');
      html += row('You sell', `${fmtAmount(p.amount, dec, 6)} ${T}`);
      html += row('Average price', `${fmtUnit(p.avgUnit)} sats/${T}`);
      html += row('Network fees', `≈ ${fmtSats(p.feesEst)} sats`, 'muted');
      html += offMarketNote(p, 'sell');
      if (p.leftoverBase > 0n) html += `<div class="bm-q bm-note">${fmtAmount(p.leftoverBase, dec, 4)} ${T} has no matching bid and stays in your wallet.</div>`;
      html += `<div class="bm-q bm-muted">${p.needsBidder ? 'Completes when each bidder\'s wallet settles — some may take hours.' : 'Completes in about a minute — keep this tab open until it does.'}</div>`;
      el.quote.innerHTML = html;
      setGo('Review sell', true, 'review');
      return;
    }
    // limit
    if (o.side === 'buy') {
      const p = q.plan;
      const nowFill = p.fills.length ? p : null;
      const restSats = o.totalSats - (nowFill ? nowFill.sats : 0);
      const bidBase = limitBidBase(o, nowFill, restSats);
      html += row('Total', `<b>up to ${fmtSats(o.totalSats)} sats</b>${usd(o.totalSats)}`, 'big');
      if (nowFill) html += row('Fills now', `${fmtAmount(nowFill.amount, dec, 4)} ${T} for ${fmtSats(nowFill.sats)} sats`);
      if (bidBase > 0n) html += row(nowFill ? 'Rest becomes a bid' : 'Your bid', `${fmtAmount(bidBase, dec, 4)} ${T} at ${fmtUnit(o.unit)}`);
      if (bidBase > 0n) html += existingOrderNote('buy', o.unit);
      const bidSats = bidBase > 0n ? satsForAmount(bidBase, o.unit, dec) : 0;
      const wt = watchtowerState(bidSats);
      if (bidBase > 0n) {
        const wtDetail = !wt.ok ? esc(wt.why)
          : wt.on ? `— sets aside ${fmtSats(bidSats + 10000)} sats in a wallet only you can reclaim`
          : `— otherwise, fills complete only while this page stays open`;
        html += `<label class="bm-check"><input type="checkbox" data-act="wt"${wt.on ? ' checked' : ''}${wt.ok ? '' : ' disabled'}><span>Fill it while I'm away <em>${wtDetail}</em></span></label>`;
      }
      el.quote.innerHTML = html;
      const needSats = (nowFill ? nowFill.sats + nowFill.feesEst : 0) + (bidSats > 0 ? bidSats + (wt.on ? 10000 : 0) + 1000 : 0);
      if (m && m.unlocked && m.sats != null && m.sats < needSats) { setGo(`Add ${fmtSats(needSats - m.sats)} more sats`, true, 'fund'); return; }
      setGo(nowFill ? 'Review order' : 'Review bid', true, 'review');
      return;
    }
    const sh = q.shape;
    html += row('You get', `<b>${fmtSats(sh.totalSats)} sats</b>${usd(sh.totalSats)}`, 'big');
    if (sh.k === 0) {
      el.quote.innerHTML = html + `<div class="bm-q bm-warn">Too small to list — a listing must be worth at least ${DUST} sats.</div>`;
      setGo('Too small', false);
      return;
    }
    html += row('Listed as', sh.k >= 2 ? `${sh.k} pieces of ${fmtAmount(sh.perLotBase, dec, 4)} ${T}` : 'one piece');
    html += existingOrderNote('sell', o.unit);
    if (q.crosses) html += `<div class="bm-q bm-note">Bids already pay ${fmtUnit(q.bestSellable)} or more — a <button type="button" class="bm-link" data-act="to-market">market sell</button> gets you that now.</div>`;
    html += `<div class="bm-q bm-muted">Buyers take it without you online. Cancel any time (one network fee).</div>`;
    el.quote.innerHTML = html;
    const freeList = m?.unlocked ? freeBase(m) : null;
    if (freeList != null && o.base > freeList) { setGo(`Not enough ${asset0.ticker}`, false); return; }
    setGo('Review listing', true, 'review');
  }

  // "At my price" rests as an open order — if you already have one at the same displayed
  // price, a second click adds a SECOND one rather than changing the first. Surface that
  // before Review, not after, so it's a choice, not a surprise found later in Your orders.
  function existingOrderNote(side, unit) {
    if (!S.myRows) return '';
    const target = fmtUnit(unit);
    const dup = [...S.myRows.values()].find((r) => r.side === side && fmtUnit(r.unit) === target);
    if (!dup) return '';
    return `<div class="bm-q bm-note">You already have an open ${side === 'buy' ? 'bid' : 'listing'} for ${fmtAmount(dup.amount, dec, 4)} ${T} at this price — this adds a second one.</div>`;
  }

  // A limit buy's resting bid: what the remaining sats buy at the limit, never more than
  // the amount asked for minus what already filled.
  function limitBidBase(o, nowFill, restSats) {
    if (restSats < DUST) return 0n;
    let base = amountForSats(restSats, o.unit, dec);
    const want = o.base - (nowFill ? nowFill.amount : 0n);
    if (base > want) base = want > 0n ? want : 0n;
    return satsForAmount(base, o.unit, dec) >= DUST ? base : 0n;
  }

  function watchtowerState(restSats) {
    const w = ctx.flags?.watchtower;
    if (!w || !w.enabled) return { ok: false, on: false, why: '(not available on this network)' };
    if (restSats > w.maxSats) return { ok: false, on: false, why: `(watchtower handles bids up to ${fmtSats(w.maxSats)} sats)` };
    return { ok: true, on: S.watchtower };
  }

  function paintAll() {
    if (S.destroyed) return;
    paintHeader();
    if (S.book) paintBook();
    paintBalance();
    paintQuote();
    paintOrders();
    paintLive();
  }

  // ── your orders ───────────────────────────────────────────────────────────
  // Everything of yours that is open here: listings and offers (each holds a coin until it
  // sells or is cancelled), bids, and sells still being followed. `lock` is the tokens a row
  // keeps out of what you can sell.
  function myOrderRows() {
    const mine = [];
    if (!S.book) return mine;
    for (const a of S.book.asks.filter((x) => x.mine)) {
      const sale = S.sells.get(a.raw.intent_id || '');
      mine.push({
        id: a.id, side: 'sell', amount: a.amount, unit: a.unit, sats: a.sats, lock: a.fullAmount,
        status: sale ? sellStatusText(sale) : a.kind === 'preauth' ? 'listed' : 'listed · you confirm claims',
        action: !sale || sale.state === 'posted' ? 'cancel' : null, kind: sale ? 'sale' : a.kind, raw: a.raw,
      });
    }
    for (const b of S.book.bids.filter((x) => x.mine)) {
      mine.push({
        id: b.id, side: 'buy', amount: b.amount, unit: b.unit, sats: b.sats, lock: 0n,
        status: b.auto ? 'bid · auto-settles' : 'bid · fills while you\'re online', action: 'cancel', kind: b.kind, raw: b.raw,
      });
    }
    for (const [iid, sale] of S.sells) {
      if (mine.some((r) => r.raw?.intent_id === iid)) continue;
      if (sale.state === 'settled' || sale.state === 'closed' || sale.state === 'gone') continue;
      mine.push({ id: 'sell:' + iid, side: 'sell', amount: BigInt(sale.amount), unit: sale.unit, sats: sale.sats, lock: BigInt(sale.amount), status: sellStatusText(sale), action: sale.state === 'posted' ? 'cancel' : null, kind: 'sale', raw: { intent_id: iid } });
    }
    return mine;
  }

  // What you can still sell: the wallet balance less the coins already committed to your own
  // open listings and offers (the executor sells only from free coins).
  function lockedBase() { return myOrderRows().reduce((t, r) => t + r.lock, 0n); }
  function freeBase(m) {
    if (m?.assetBase == null) return null;
    const l = lockedBase();
    return m.assetBase > l ? m.assetBase - l : 0n;
  }

  function paintOrders() {
    if (!S.book) return;
    const m = me();
    const mine = myOrderRows();
    if (!mine.length || !m) { el.orders.hidden = true; el.orders.innerHTML = ''; return; }
    el.orders.hidden = false;
    const html = `<h3>Your orders <em>${mine.length}</em></h3><div class="bm-otable">${mine.map((r) => `
      <div class="bm-orow ${r.side}"><span class="s">${r.side === 'buy' ? 'Buy' : 'Sell'}</span>
      <span>${fmtAmount(r.amount, dec, 4)} ${T}</span><span>@ ${fmtUnit(r.unit)}</span><span class="muted">${esc(S.cancelling.has(r.id) ? 'cancelling…' : r.status)}</span>
      <span>${r.action === 'cancel' && !S.cancelling.has(r.id) ? `<button type="button" data-act="cancel" data-id="${esc(r.id)}">Cancel</button>` : ''}</span></div>`).join('')}</div>`;
    if (el.orders.__html !== html) { el.orders.innerHTML = html; el.orders.__html = html; }
    S.myRows = new Map(mine.map((r) => [r.id, r]));
  }

  function sellStatusText(s) {
    return {
      posted: 'waiting for the buyer',
      claimed: 'buyer claimed — confirming',
      confirmed: 'confirmed — buyer settling',
      settled: 'sold',
      closed: 'offer closed — the tokens stayed in your wallet',
      gone: 'no longer listed — check your balance',
    }[s.state] || 'waiting for the buyer';
  }

  // ── recent trades ─────────────────────────────────────────────────────────
  function paintTrades() {
    const all = S.stats?.trades || [];
    if (!all.length) { el.trades.innerHTML = ''; return; }
    // Oldest first so each print's arrow compares with the one before it.
    let prev = null;
    const rows = all.slice(0, 40).reverse().map((t) => {
      const amt = BigInt(t.amount || 0);
      const u = amt > 0n ? (Number(t.price_sats) * Math.pow(10, dec)) / Number(amt) : null;
      const dir = prev == null || u == null ? '' : u > prev * (1 + 1e-9) ? 'up' : u < prev * (1 - 1e-9) ? 'down' : '';
      prev = u ?? prev;
      return { t, amt, u, dir, n: 1 };
    }).reverse();
    const grouped = [];
    for (const r of rows) {
      const g = grouped[grouped.length - 1];
      if (g && g.amt === r.amt && Number(g.t.price_sats) === Number(r.t.price_sats) && ago(g.t.ts) === ago(r.t.ts)) { g.n++; continue; }
      grouped.push({ ...r });
    }
    const link = (txid) => ctx.txUrl ? ctx.txUrl(txid) : null;
    const html = `<h3>Recent trades</h3><div class="bm-ttable"><div class="bm-trow bm-thead"><span>Price</span><span>${T}</span><span>When</span></div>${grouped.slice(0, 10).map(({ t, amt, u, dir, n }) => {
      const href = t.txid ? link(t.txid) : null;
      const time = `${ago(t.ts)}`;
      return `<div class="bm-trow" title="${esc(fmtSats(Number(t.price_sats) * n))} sats${n > 1 ? ` across ${n} fills` : ''}"><span class="p ${dir}"><i class="dir" aria-hidden="true">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''}</i>${fmtUnit(u)}</span><span>${fmtAmount(amt, dec, 2)}${n > 1 ? `<i class="bm-cnt">×${n}</i>` : ''}</span><span class="muted">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener" title="View on mempool.space">${time}</a>` : time}</span></div>`;
    }).join('')}</div>`;
    if (el.trades.__html !== html) { el.trades.innerHTML = html; el.trades.__html = html; }
  }

  // ── chart ─────────────────────────────────────────────────────────────────
  function chartPoints() {
    return (S.stats?.trades || []).map((t) => {
      const amt = BigInt(t.amount || 0);
      return amt > 0n ? { ts: Number(t.ts), u: (Number(t.price_sats) * Math.pow(10, dec)) / Number(amt), amt, sats: Number(t.price_sats) } : null;
    }).filter((p) => p && p.u > 0 && p.ts > 0).sort((a, b) => a.ts - b.ts);
  }

  // Prints far outside the typical range (fat fingers, dust trades) stay out of the line,
  // the axis and the range; they're counted instead.
  function chartBand(pts) {
    const us = pts.map((p) => p.u).sort((a, b) => a - b);
    const med = us[Math.floor(us.length / 2)];
    return { lo: med * FAR_BELOW, hi: med * FAR_ABOVE };
  }

  // One volume-weighted price per time bucket: a smooth line that still follows every fill.
  function chartBuckets(pts, t0, t1, n) {
    const out = [];
    const w = Math.max(1, (t1 - t0) / n);
    for (const p of pts) {
      const i = Math.min(n - 1, Math.floor((p.ts - t0) / w));
      const b = out[i] || (out[i] = { t0: t0 + i * w, t1: t0 + (i + 1) * w, sats: 0, base: 0, n: 0, last: p.ts });
      b.sats += p.sats; b.base += Number(p.amt); b.n++; b.last = Math.max(b.last, p.ts);
    }
    return out.filter(Boolean).map((b) => ({ ...b, u: (b.sats * Math.pow(10, dec)) / b.base, ts: b.n === 1 ? b.last : (b.t0 + b.t1) / 2 }));
  }

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return out;
  }

  function paintChart() {
    const all = chartPoints();
    let tf = LS.get('tacit-btc-market-tf', '1M');
    if (!CHART_TFS.some(([k]) => k === tf)) tf = '1M';
    const span = (k) => CHART_TFS.find(([x]) => x === k)[1];
    // A quiet market: widen until there is something to draw.
    let shownTf = tf;
    for (const [k] of CHART_TFS) {
      if (span(k) < span(tf)) continue;
      shownTf = k;
      if (all.filter((p) => p.ts >= nowSec() - span(k)).length >= 2) break;
    }
    $$('[data-act=tf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === shownTf)));
    const inWin = all.filter((p) => p.ts >= nowSec() - span(shownTf));
    const band = inWin.length ? chartBand(inWin) : null;
    const win = band ? inWin.filter((p) => p.u >= band.lo && p.u <= band.hi) : [];
    const outliers = inWin.length - win.length;
    let sum = `<span class="bm-chart-title">Price</span>`;
    if (win.length >= 2) {
      const first = win[0].u, last = win[win.length - 1].u;
      const chg = ((last - first) / first) * 100;
      const lo = Math.min(...win.map((p) => p.u)), hi = Math.max(...win.map((p) => p.u));
      const label = shownTf === 'ALL' ? 'all time' : `past ${{ '1D': 'day', '1W': 'week', '1M': 'month' }[shownTf]}`;
      sum += `<span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%</span><em>${label}</em>`
        + `<span class="bm-chart-range"><em>low</em> ${fmtUnit(lo)} <em>high</em> ${fmtUnit(hi)}</span>`
        + (outliers ? `<em class="bm-chart-out" title="Trades priced far outside the typical range (e.g. dust or mistyped fills) aren't drawn">${outliers} outlier${outliers === 1 ? '' : 's'} hidden</em>` : '');
    }
    if (el.chartSum.innerHTML !== sum) el.chartSum.innerHTML = sum;
    const sg = shownTf + '|' + (el.chart.clientWidth || 0) + '|' + win.map((p) => p.ts + ':' + p.u).join(',') + '|' + (S.book?.bestBid ?? '') + '|' + (S.book?.bestAsk ?? '');
    if (el.chart.__sig === sg) return;
    el.chart.__sig = sg;
    if (win.length < 2) { el.chart.innerHTML = `<div class="bm-empty">Not enough trades to chart yet.</div>`; return; }
    el.chart.innerHTML = chartSvg(win, shownTf);
    wireChartHover();
  }

  const PL = 10, PR = 70, PT = 14, PB = 42, VH = 24;
  let CW = 640, CH = 240;
  function chartSvg(win, tf) {
    // Draw at the box's real width so text stays at its natural size on phones.
    CW = Math.max(300, Math.min(900, Math.round(el.chart.clientWidth || 640)));
    CH = CW < 480 ? 200 : 240;
    const t0 = win[0].ts, t1 = Math.max(nowSec(), win[win.length - 1].ts);
    const nb = Math.max(12, Math.min(120, Math.floor((CW - PL - PR) / 6)));
    const bk = chartBuckets(win, t0, t1 + 1, nb);
    let lo = Math.min(...bk.map((b) => b.u)), hi = Math.max(...bk.map((b) => b.u));
    const bid = S.book?.bestBid, ask = S.book?.bestAsk;
    for (const v of [bid, ask]) if (v && v > lo * 0.7 && v < hi * 1.3) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi <= lo) { hi = lo * 1.05; lo = lo * 0.95; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const plotB = CH - PB;
    const X = (t) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (CW - PL - PR);
    const Y = (u) => PT + (1 - (u - lo) / (hi - lo)) * (plotB - PT);
    S.chartMap = { X, Y, bk };
    const pts = bk.map((b) => [X(b.ts), Y(b.u)]);
    pts.push([X(t1), Y(bk[bk.length - 1].u)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const area = `${line}L${X(t1).toFixed(1)},${plotB}L${X(t0).toFixed(1)},${plotB}Z`;
    const up = bk[bk.length - 1].u >= bk[0].u;
    const vmax = Math.max(...bk.map((b) => b.sats), 1);
    const bw = Math.max(1.5, (CW - PL - PR) / nb - 1.5);
    const vol = bk.map((b) => `<rect x="${(X(b.ts) - bw / 2).toFixed(1)}" y="${(plotB - (b.sats / vmax) * VH).toFixed(1)}" width="${bw.toFixed(1)}" height="${((b.sats / vmax) * VH).toFixed(1)}"/>`).join('');
    // Right-axis tags for the live book; ticks that would sit under a tag are dropped.
    const tags = [];
    if (ask && ask >= lo && ask <= hi) tags.push({ v: ask, cls: 'ask', label: `ask ${fmtUnit(ask)}` });
    if (bid && bid >= lo && bid <= hi) tags.push({ v: bid, cls: 'bid', label: `bid ${fmtUnit(bid)}` });
    if (tags.length === 2 && Math.abs(Y(tags[0].v) - Y(tags[1].v)) < 16) {
      const [a, b] = tags[0].v > tags[1].v ? [tags[0], tags[1]] : [tags[1], tags[0]];
      a.dy = -8; b.dy = 8;
    }
    const ticks = niceTicks(lo, hi, CW < 480 ? 3 : 4)
      .filter((v) => !tags.some((t) => Math.abs(Y(v) - (Y(t.v) + (t.dy || 0))) < 14))
      .map((v) => `<line x1="${PL}" x2="${CW - PR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${CW - PR + 8}" y="${(Y(v) + 3.5).toFixed(1)}">${fmtUnit(v)}</text>`).join('');
    const tagSvg = tags.map((t) => {
      const y = Y(t.v), ty = y + (t.dy || 0);
      return `<g class="tag ${t.cls}"><line x1="${PL}" x2="${CW - PR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><rect x="${CW - PR + 3}" y="${(ty - 8).toFixed(1)}" width="${PR - 5}" height="16" rx="2"/><text x="${CW - PR + 7}" y="${(ty + 3.5).toFixed(1)}">${t.label}</text></g>`;
    }).join('');
    const nX = CW < 480 ? 3 : 5;
    const fmtDate = (t) => {
      const d = new Date(t * 1000);
      if (tf === '1D') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (t1 - t0 > 300 * 86400) return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };
    const xt = Array.from({ length: nX }, (_, i) => t0 + ((t1 - t0) * i) / (nX - 1))
      .map((t, i) => `<text class="xl" x="${X(t).toFixed(1)}" y="${CH - 8}" text-anchor="${i === 0 ? 'start' : i === nX - 1 ? 'end' : 'middle'}">${i === nX - 1 ? 'now' : fmtDate(t)}</text>`).join('');
    const last = bk[bk.length - 1];
    return `<div class="bm-chart-box"><svg viewBox="0 0 ${CW} ${CH}" width="${CW}" height="${CH}" class="bm-svg ${up ? 'up' : 'down'}" role="img" aria-label="Price history">
      <g class="grid">${ticks}</g>
      <g class="vol">${vol}</g>
      <path class="area" d="${area}"/><path class="line" d="${line}"/>
      ${tagSvg}
      <circle class="lastdot" cx="${X(t1).toFixed(1)}" cy="${Y(last.u).toFixed(1)}" r="3.5"/>
      <line class="axis" x1="${PL}" x2="${CW - PR}" y1="${plotB}" y2="${plotB}"/>
      ${xt}
      <g class="cursor" hidden><line y1="${PT}" y2="${plotB}"/><circle r="4"/></g>
      <rect class="hit" x="${PL}" y="0" width="${CW - PL - PR}" height="${CH}"/>
    </svg><div class="bm-tip" hidden></div></div>`;
  }

  function wireChartHover() {
    const svg = el.chart.querySelector('svg');
    const tip = el.chart.querySelector('.bm-tip');
    const cur = svg.querySelector('.cursor');
    const hit = svg.querySelector('.hit');
    const { X: toX, Y: toY, bk } = S.chartMap;
    const move = (clientX) => {
      const r = svg.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * CW;
      let best = bk[0];
      for (const b of bk) if (Math.abs(toX(b.ts) - x) < Math.abs(toX(best.ts) - x)) best = b;
      const X = toX(best.ts), y = toY(best.u);
      cur.hidden = false;
      cur.querySelector('line').setAttribute('x1', X); cur.querySelector('line').setAttribute('x2', X);
      cur.querySelector('circle').setAttribute('cx', X); cur.querySelector('circle').setAttribute('cy', y);
      tip.hidden = false;
      const when = new Date(best.ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      tip.innerHTML = `<b>${fmtUnit(best.u)}</b> sats/${T}${best.n > 1 ? ' <em>avg</em>' : ''}<br>${best.n} trade${best.n === 1 ? '' : 's'} · ${fmtSats(best.sats)} sats<br><em>${best.n > 1 ? 'around ' : ''}${when}</em>`;
      const px = (X / CW) * r.width;
      tip.style.left = `${Math.min(Math.max(4, px + 12 > r.width - 188 ? px - 196 : px + 12), r.width - 188)}px`;
    };
    hit.addEventListener('pointermove', (e) => move(e.clientX), sig);
    hit.addEventListener('pointerdown', (e) => move(e.clientX), sig);
    hit.addEventListener('pointerleave', () => { cur.hidden = true; tip.hidden = true; }, sig);
  }

  // ── refresh loop ──────────────────────────────────────────────────────────
  let inflight = null;
  async function refresh({ force = false, soft = false } = {}) {
    if (S.destroyed) return;
    if (soft && S.loadedOnce) { rebuildBook(); paintAll(); return; }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const [, bids] = await withTimeout(Promise.all([ctx.loadListings({ force }), ctx.loadBids({ force })]), REFRESH_TIMEOUT_MS);
        S.bids = Array.isArray(bids) ? bids : S.bids;
        S.lastOk = Date.now(); S.lastErr = null;
      } catch (e) {
        S.lastErr = e;
      }
      if (force || !S.stats || Date.now() - S.statsAt > STATS_REFRESH_MS) {
        try { S.stats = await withTimeout(ctx.loadStats({ force }), REFRESH_TIMEOUT_MS); S.statsAt = Date.now(); paintTrades(); paintChart(); } catch {}
      }
      S.loadedOnce = true;
      rebuildBook();
      paintAll();
      paintChart();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  function schedule() {
    clearTimeout(S.timer);
    if (S.destroyed) return;
    S.timer = setTimeout(async () => {
      if (!host.isConnected) { destroy(); return; }
      if (!document.hidden && S.lane === 'btc') await refresh({ force: true });
      else paintLive();
      trackSells();
      schedule();
    }, REFRESH_MS);
  }
  const onVis = () => { if (!document.hidden && !S.destroyed && host.isConnected) { refresh({ force: true }); schedule(); } };
  document.addEventListener('visibilitychange', onVis, sig);
  const liveTick = setInterval(() => { if (!S.destroyed) paintLive(); }, 1000);

  // ── pending sells: follow each offer until the buyer settles ──────────────
  let tracking = false;
  async function trackSells() {
    if (tracking || !S.sells.size || !ctx.exec?.offerStatus) return;
    tracking = true;
    try {
      let changed = false;
      for (const [iid, sale] of S.sells) {
        const final = sale.state === 'settled' || sale.state === 'gone' || (sale.state === 'closed' && nowSec() - (sale.doneAt || 0) > 600);
        if (final) {
          if (nowSec() - (sale.doneAt || 0) > 3600) { S.sells.delete(iid); changed = true; }
          continue;
        }
        let st;
        const hadUtxo = !!sale.raw?.asset_utxo;
        try { st = await ctx.exec.offerStatus({ intentId: iid, raw: sale.raw }); } catch { continue; }
        if (!hadUtxo && sale.raw?.asset_utxo) changed = true;
        if (st && st !== sale.state) {
          sale.state = st; changed = true;
          if ((st === 'settled' || st === 'closed' || st === 'gone') && !sale.doneAt) sale.doneAt = nowSec();
          if (st === 'posted' || st === 'claimed' || st === 'confirmed') sale.doneAt = 0;
          if (st === 'settled') ctx.toast?.(`Sold ${fmtAmount(BigInt(sale.amount), dec, 4)} ${asset0.ticker} for ${fmtSats(sale.sats)} sats ✓`, 'success', 8000);
        }
      }
      if (changed) { saveSells(); paintOrders(); S.onSellsChanged?.(); }
    } finally { tracking = false; }
  }

  // ── review + execute ──────────────────────────────────────────────────────
  function modal() {
    const wrap = document.createElement('div');
    wrap.className = 'bm-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `<div class="bm-card" data-side="${S.side}"><div class="bm-mbody"></div><div class="bm-mfoot"></div></div>`;
    document.body.appendChild(wrap);
    const body = wrap.querySelector('.bm-mbody');
    const foot = wrap.querySelector('.bm-mfoot');
    let onKey = null;
    let escLocked = false;
    const openedAt = Date.now();
    const prevFocus = document.activeElement;
    const api = {
      body, foot,
      set(html) {
        body.innerHTML = html;
        const h = body.querySelector('h2');
        if (h) wrap.setAttribute('aria-label', h.textContent);
      },
      buttons(btns) {
        foot.innerHTML = btns.map((b, i) => `<button type="button" data-i="${i}" class="${b.primary ? 'bm-go' : ''}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('');
        foot.querySelectorAll('button').forEach((n) => {
          n.onkeydown = (e) => { if (e.repeat) e.preventDefault(); };
          n.onclick = () => {
            if (n.classList.contains('bm-go') && Date.now() - openedAt < CONFIRM_GRACE_MS) return;
            if (btns[+n.dataset.i].once !== false) {
              foot.querySelectorAll('button').forEach((x) => { x.disabled = true; });
              // A slow unlock prompt or network round-trip can leave the button sitting
              // disabled for a while; say so instead of just going quiet.
              if (n.classList.contains('bm-go')) n.textContent = 'Working…';
            }
            btns[+n.dataset.i].onClick();
          };
        });
        const primary = foot.querySelector('.bm-go');
        if (primary) primary.focus();
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
    return api;
  }

  function stepsHtml(steps) {
    return `<ol class="bm-steps">${steps.map((s) => `<li class="${s.status}"><span class="st">${{
      queued: '○', working: '◐', waiting: '◔', done: '✓', failed: '✕', skipped: '–',
    }[s.status] || '○'}</span><span class="lb">${s.label}${s.note ? `<em>${esc(s.note)}</em>` : ''}${s.txid && ctx.txUrl ? ` <a href="${esc(ctx.txUrl(s.txid))}" target="_blank" rel="noopener">tx</a>` : ''}</span></li>`).join('')}</ol>`;
  }

  const planSig = (q) => (q?.plan ? q.plan.fills.map((f) => (f.ask || f.bid).id + ':' + f.amount + ':' + f.sats).join(',') : String(q?.shape?.totalSats ?? ''));
  let reviewing = false;
  async function review() {
    // The page behind a dialog is still reachable by keyboard; one review at a time.
    if (S.busy || S.destroyed || reviewing || document.querySelector('.bm-modal')) return;
    const m = me();
    if (!m) { await ctx.unlock(); refresh({ soft: true }); return; }
    let q = computeQuote();
    if (!q || q.empty) return;
    if (el.go.dataset.kind === 'fund') { ctx.fundSats(); return; }
    // The quote is only as fresh as the last refresh. After a stretch without one (a
    // backgrounded tab, a dropped connection) re-read the book first, and show the new
    // quote instead of a review of offers that may be gone.
    if (!S.lastOk || Date.now() - S.lastOk > 25_000) {
      reviewing = true;
      el.go.disabled = true; el.go.textContent = 'Checking prices…';
      const before = planSig(q);
      try { await refresh({ force: true }); } finally { reviewing = false; }
      if (S.destroyed) return;
      if (S.lastErr && (!S.lastOk || Date.now() - S.lastOk > 25_000)) {
        paintQuote();
        ctx.toast?.('Can\'t reach the order book — check your connection and try again.', 'error', 6000);
        return;
      }
      q = computeQuote();
      if (!q || q.empty) { paintQuote(); return; }
      if (planSig(q) !== before) { paintQuote(); ctx.toast?.('Prices changed — check the updated quote.', 'info', 5000); return; }
    }
    const o = q.order;
    const md = modal();
    let cancelled = false;
    const close = () => { cancelled = true; md.close(); };
    md.onEscape(close);
    const row = (k, v) => `<div class="bm-qr"><span>${k}</span><span>${v}</span></div>`;
    if (o.type === 'market' && o.side === 'buy') {
      const p = q.plan;
      const maxUnit = q.maxUnit === Infinity ? p.worstUnit : q.maxUnit;
      // Spend orders are capped at what was typed; buy-an-amount orders at that amount
      // priced at the limit (whole pieces can round it up, never past the plan itself).
      const maxSats = o.spendSats != null
        ? o.spendSats
        : Math.max(p.sats, satsForAmount(o.receiveBase, maxUnit, dec));
      const bounds = { maxSats, maxUnit };
      md.set(`<h2>Buy ${fmtAmount(p.amount, dec, 6)} ${T}</h2>
        ${row('You pay', `<b>${fmtSats(p.sats)} sats</b>`)}
        ${row('Network fee', `≈ ${fmtSats(p.feesEst)} sats`)}
        ${row('Total', `<b>≈ ${fmtSats(p.sats + p.feesEst)} sats</b>${usdOf(p.sats + p.feesEst) != null ? ` <em>${fmtUsd(usdOf(p.sats + p.feesEst))}</em>` : ''}`)}
        ${row('Average price', `${fmtUnit(p.avgUnit)} sats/${T}`)}
        ${row('Limits', `at most ${fmtUnit(maxUnit)} sats/${T} · ${fmtSats(maxSats)} sats`)}
        <p class="bm-q bm-muted">If an offer is taken before you, the page moves to the next one — only within these limits. Otherwise it stops and nothing more is spent.</p>
        ${stepsHtml(p.fills.map((f) => ({ status: 'queued', label: fillLabel(f), note: f.ask.instant ? '' : 'seller confirms' })))}`);
      md.buttons([{ label: 'Cancel', onClick: close }, { label: 'Buy now', primary: true, onClick: () => runBuy(md, p, bounds, o) }]);
      return;
    }
    if (o.type === 'market' && o.side === 'sell') {
      const p = q.plan;
      const bounds = { maxBase: p.amount, minUnit: q.minUnit || p.worstUnit };
      md.set(`<h2>Sell ${fmtAmount(p.amount, dec, 6)} ${T}</h2>
        ${row('You get', `<b>${fmtSats(p.sats)} sats</b>${usdOf(p.sats) != null ? ` <em>${fmtUsd(usdOf(p.sats))}</em>` : ''}`)}
        ${row('Average price', `${fmtUnit(p.avgUnit)} sats/${T}`)}
        ${row('Network fees', `≈ ${fmtSats(p.feesEst)} sats, paid by you`)}
        <p class="bm-q bm-muted">Each sale is offered to its bidder, whose wallet pays and settles it on Bitcoin. ${p.needsBidder ? 'Some of these bidders have to come online first — that can take hours; until then the tokens stay in your wallet.' : 'The watchtower does this within a minute or two.'} <b>Keep this tab open</b> — your wallet confirms each buyer's claim automatically.</p>
        ${stepsHtml(p.fills.map((f) => ({ status: 'queued', label: sellLabel(f), note: f.bid.auto ? 'auto-settles' : 'bidder must be online' })))}`);
      md.buttons([{ label: 'Cancel', onClick: close }, { label: 'Sell now', primary: true, onClick: () => runSell(md, p, bounds) }]);
      return;
    }
    if (o.side === 'buy') {
      const now = q.plan.fills.length ? q.plan : null;
      const restSats = o.totalSats - (now ? now.sats : 0);
      const bidBase = limitBidBase(o, now, restSats);
      const bidSats = bidBase > 0n ? satsForAmount(bidBase, o.unit, dec) : 0;
      const wt = watchtowerState(bidSats);
      const exp = EXPIRY_CHOICES.find(([s]) => s === S.expirySec)?.[1] || '1 day';
      md.set(`<h2>Limit buy ${fmtAmount(o.base, dec, 6)} ${T} at ${fmtUnit(o.unit)}</h2>
        ${now ? row('Fills now', `${fmtAmount(now.amount, dec, 6)} ${T} for ${fmtSats(now.sats)} sats`) : ''}
        ${bidBase > 0n ? row('Bid', `${fmtAmount(bidBase, dec, 6)} ${T} for up to ${fmtSats(bidSats)} sats <em>(lasts ${exp})</em>`) : ''}
        ${bidBase > 0n && wt.on ? row('Watchtower', `moves ${fmtSats(bidSats + 10000)} sats into a bid wallet only you can reclaim <em>(includes 10,000 for fees)</em>`) : ''}
        <p class="bm-q bm-muted">${bidBase > 0n ? (wt.on ? 'Sellers can fill your bid while you\'re away; cancel any time from Your orders and reclaim what\'s left.' : 'Fills complete while this page is open. Cancel any time from Your orders.') : ''}</p>`);
      md.buttons([{ label: 'Cancel', onClick: close }, { label: 'Place order', primary: true, onClick: () => runLimitBuy(md, { order: o, now, bidBase, bidSats, watchtower: wt.on && bidBase > 0n }) }]);
      return;
    }
    const sh = q.shape;
    const exp = EXPIRY_CHOICES.find(([s]) => s === S.expirySec)?.[1] || '1 day';
    md.set(`<h2>List ${fmtAmount(sh.listedBase, dec, 6)} ${T} at ${fmtUnit(o.unit)}</h2>
      ${row('You get', `<b>${fmtSats(sh.totalSats)} sats</b> when all of it sells`)}
      ${row('Listed as', sh.k >= 2 ? `${sh.k} pieces of ${fmtAmount(sh.perLotBase, dec, 6)} ${T} (${fmtSats(sh.perLotSats)} sats each)` : 'one piece')}
      ${row('Lasts', exp)}
      <p class="bm-q bm-muted">Buyers take pieces without you online. Setting this up is one or two Bitcoin transactions (network fees apply). Cancelling later costs one more.</p>`);
    md.buttons([{ label: 'Cancel', onClick: close }, { label: 'List for sale', primary: true, onClick: () => runList(md, { order: o, shape: sh }) }]);
    void cancelled;
  }

  const fillLabel = (f) => `${fmtAmount(f.amount, dec, 4)} ${T} at ${fmtUnit(f.unit)} — ${fmtSats(f.sats)} sats`;
  const sellLabel = (f) => `${fmtAmount(f.amount, dec, 4)} ${T} at ${fmtUnit(f.unit)} — ${fmtSats(f.sats)} sats`;

  function beginBusy(md) {
    if (S.destroyed) { md.close(); return false; }
    if (S.busy) { md.set('<h2>Another order is still running</h2><p class="bm-q">Wait for it to finish, then try again.</p>'); md.buttons([{ label: 'Close', primary: true, onClick: () => md.close() }]); return false; }
    S.busy = true; el.go.disabled = true; el.go.textContent = 'Working…';
    return true;
  }
  function endBusy() { S.busy = false; refresh({ force: true }); }

  // Buy: preauth listings together in one transaction where possible, then offers that
  // need their seller to confirm, one at a time. Re-route only inside `bounds`.
  async function runBuy(md, plan0, bounds, order) {
    try { await ctx.unlock(); } catch (e) { md.close(); ctx.toast?.(ctx.friendlyError(e), 'error'); return; }
    if (!beginBusy(md)) return;
    md.lockEscape();
    const steps = [];
    const stepFor = (f) => { const s = { status: 'queued', label: fillLabel(f), fill: f }; steps.push(s); return s; };
    plan0.fills.forEach(stepFor);
    let stop = false;
    const paint = (title) => {
      md.set(`<h2>${title}</h2>${stepsHtml(steps)}`);
    };
    md.buttons([{ label: 'Stop after this step', onClick: () => { stop = true; md.foot.querySelector('button').disabled = true; } }]);
    let spent = 0; let got = 0n; let reroutes = 0; let err = null;
    const tried = new Set();
    let queue = steps.slice();
    paint('Buying…');
    while (queue.length && !stop) {
      const pre = queue.filter((s) => s.fill.ask.kind === 'preauth');
      const rest = queue.filter((s) => s.fill.ask.kind !== 'preauth');
      queue = [];
      let stale = [];
      if (pre.length >= 2) {
        pre.forEach((s) => { s.status = 'working'; });
        paint('Buying…');
        let r = null;
        try {
          r = await ctx.exec.takePreauthBatch(pre.map((s) => s.fill.ask.raw));
        } catch (e) {
          const msg = ctx.friendlyError(e);
          if (isRerouteable(e)) {
            // One of them moved; take the rest one by one so only the stale one fails.
            pre.forEach((s) => { s.status = 'queued'; });
            rest.unshift(...pre);
          } else {
            pre.forEach((s) => { s.status = 'failed'; s.note = msg; });
            err = e; break;
          }
        }
        if (r) {
          for (const s of pre) { s.status = 'done'; s.txid = r.reveal_txid || r.commit_txid || r.txid; tried.add(s.fill.ask.id); }
          const amt = pre.reduce((t, s) => t + s.fill.amount, 0n);
          spent += pre.reduce((t, s) => t + s.fill.sats, 0); got += amt;
          try { await ctx.after.bought({ amount: amt, result: r, ids: pre.map((s) => s.fill.ask.id) }); } catch {}
        }
      } else rest.unshift(...pre);
      for (const s of rest) {
        if (stop) { s.status = 'skipped'; continue; }
        const f = s.fill;
        tried.add(f.ask.id);
        s.status = 'working'; paint('Buying…');
        let r = null;
        try {
          r = await ctx.exec.takeAsk(f.ask.raw, f.ask.kind, f.amount, {
            onClaimed: () => { s.status = 'waiting'; s.note = 'waiting for the seller to confirm'; paint('Buying…'); },
          });
        } catch (e) {
          if (isRerouteable(e)) { s.status = 'failed'; s.note = 'taken by someone else'; stale.push(s); }
          else { s.status = 'failed'; s.note = ctx.friendlyError(e); err = e; }
        }
        if (r) {
          s.status = 'done'; s.note = s.rerouted ? 're-routed' : ''; s.txid = r.reveal_txid || r.commit_txid || r.txid;
          spent += f.sats; got += f.amount;
          try { await ctx.after.bought({ amount: f.amount, result: r, ids: f.ask.whole ? [f.ask.id] : [] }); } catch {}
        }
        paint('Buying…');
        if (err) break;
      }
      if (err || stop || !stale.length) break;
      if (++reroutes > MAX_REROUTES) break;
      // Re-plan what's left against a fresh book, inside the confirmed bounds.
      await refresh({ force: true });
      const left = order.spendSats != null
        ? { spendSats: Math.min(order.spendSats, bounds.maxSats) - spent }
        : { receiveBase: order.receiveBase - got };
      if ((left.spendSats != null && left.spendSats < DUST) || (left.receiveBase != null && left.receiveBase <= 0n)) break;
      const np = planBuy(S.book, { ...left, maxUnit: bounds.maxUnit, includeIntents: S.includeMaker, excludeIds: tried });
      const ok = np.fills.length && withinBounds(np, { maxSats: bounds.maxSats - spent, maxUnit: bounds.maxUnit });
      if (!ok) { steps.push({ status: 'skipped', label: 'No other offers within your price limit — stopped here' }); break; }
      np.fills.forEach((f) => { const s = stepFor(f); s.note = 're-routed'; s.rerouted = true; queue.push(s); });
    }
    // Anything never attempted (stopped, or an earlier step failed) says so, not "queued".
    for (const s of steps) if (s.status === 'queued') { s.status = 'skipped'; s.note = 'not attempted'; }
    const title = got > 0n ? `Bought ${fmtAmount(got, dec, 6)} ${T}` : 'Nothing bought';
    const summary = got > 0n
      ? `<p class="bm-q">Paid ${fmtSats(spent)} sats · average ${fmtUnit((spent * Math.pow(10, dec)) / Number(got))} sats/${T}. It shows in your wallet now and confirms with the next Bitcoin block.</p>${err ? `<p class="bm-q bm-warn">The rest didn't go through: ${esc(ctx.friendlyError(err))}</p>` : ''}`
      : `<p class="bm-q">${err ? esc(ctx.friendlyError(err)) : 'The offers were taken before you — nothing was spent.'}</p>`;
    const leftover = order.spendSats != null ? order.spendSats - spent : 0;
    md.set(`<h2>${title}</h2>${summary}${stepsHtml(steps)}`);
    md.unlockEscape();
    const btns = [{ label: 'Done', primary: true, onClick: () => md.close() }];
    if (leftover >= 5000 && !err) btns.unshift({ label: `Bid with the other ${fmtSats(leftover)} sats`, onClick: () => { md.close(); prime({ side: 'buy', type: 'limit', totalSats: leftover }); } });
    md.buttons(btns);
    if (err) ctx.onError?.(err);
    endBusy();
  }

  // Sell: offer tokens to each bid (the bidder's wallet or watchtower settles), then
  // follow each offer until it settles.
  async function runSell(md, plan0, bounds) {
    try { await ctx.unlock(); } catch (e) { md.close(); ctx.toast?.(ctx.friendlyError(e), 'error'); return; }
    if (!beginBusy(md)) return;
    md.lockEscape();
    ctx.exec.ensureAutoConfirm?.();
    const steps = plan0.fills.map((f) => ({ status: 'queued', label: sellLabel(f), fill: f }));
    let stop = false; let err = null; let offered = 0n; let reroutes = 0;
    const tried = new Set();
    const paint = (t) => md.set(`<h2>${t}</h2>${stepsHtml(steps)}`);
    md.buttons([{ label: 'Stop after this step', onClick: () => { stop = true; md.foot.querySelector('button').disabled = true; } }]);
    let queue = steps.slice();
    const runIds = new Set();
    while (queue.length && !stop) {
      const stale = [];
      for (const s of queue) {
        if (stop) { s.status = 'skipped'; continue; }
        const f = s.fill;
        tried.add(f.bid.id);
        s.status = 'working'; paint('Selling…');
        let r = null;
        try {
          r = await ctx.exec.sellToBid(f.bid.raw, f.bid.kind === 'bid-var' ? f.amount : null);
        } catch (e) {
          if (isRerouteable(e)) { s.status = 'failed'; s.note = 'bid filled by someone else'; stale.push(s); }
          else { s.status = 'failed'; s.note = ctx.friendlyError(e); err = e; }
        }
        if (r) {
          s.status = 'done'; s.note = 'offered — waiting for the buyer'; s.txid = r.commit_txid;
          offered += f.amount;
          const iid = r.offer?.intent_id;
          if (iid) {
            runIds.add(iid);
            S.sells.set(iid, { state: 'posted', amount: f.amount.toString(), sats: f.sats, unit: f.unit, bidId: f.bid.raw.bid_id, at: nowSec(), raw: { asset_utxo: r.offer?.asset_utxo || null, maker_address: r.offer?.maker_address || null, price_sats: f.sats } });
            saveSells();
          }
          try { await ctx.after.sold({ amount: f.amount, result: r, ids: f.bid.kind === 'bid' ? [f.bid.id] : [] }); } catch {}
        }
        paint('Selling…');
        if (err) break;
      }
      queue = [];
      if (err || stop || !stale.length || ++reroutes > MAX_REROUTES) break;
      await refresh({ force: true });
      const left = bounds.maxBase - offered;
      if (left <= 0n) break;
      const np = planSell(S.book, { sellBase: left, minUnit: bounds.minUnit, includeManual: S.includeManual, excludeIds: tried });
      if (!np.fills.length || !withinBounds(np, { maxBase: left, minUnit: bounds.minUnit })) { steps.push({ status: 'skipped', label: 'No other bids within your price limit — stopped here' }); break; }
      np.fills.forEach((f) => { const s = { status: 'queued', label: sellLabel(f), fill: f, note: 're-routed' }; steps.push(s); queue.push(s); });
    }
    for (const s of steps) if (s.status === 'queued') { s.status = 'skipped'; s.note = 'not attempted'; }
    const unsold = plan0.amount > offered ? plan0.amount - offered : 0n;
    const listRest = () => ({ label: `List the other ${fmtAmount(unsold, dec, 4)} ${asset0.ticker}`, onClick: () => { S.onSellsChanged = null; md.close(); prime({ side: 'sell', type: 'limit', sellBase: unsold }); } });
    endBusy();
    if (offered === 0n) {
      md.set(`<h2>Nothing sold</h2><p class="bm-q">${err ? esc(ctx.friendlyError(err)) : 'The bids were filled before you — nothing was spent.'}</p>${stepsHtml(steps)}`);
      md.unlockEscape();
      md.buttons([{ label: 'Done', primary: true, onClick: () => md.close() }]);
      if (err) ctx.onError?.(err);
      return;
    }
    // Follow the offers live inside the dialog; closing it keeps tracking in Your orders.
    const paintTrack = () => {
      const mineNow = [...runIds].map((id) => S.sells.get(id)).filter(Boolean);
      const settled = mineNow.filter((x) => x.state === 'settled');
      const allSold = mineNow.length > 0 && settled.length === mineNow.length;
      md.set(`<h2>${allSold ? `Sold ${fmtAmount(offered, dec, 6)} ${T}` : 'Waiting for buyers to settle'}</h2>
        <p class="bm-q">${allSold ? 'Paid in full.' : 'Keep this tab open. Your wallet confirms each buyer\'s claim, then the buyer\'s payment settles it on Bitcoin. Closing this dialog is fine — progress stays under Your orders.'}</p>
        <ol class="bm-steps">${mineNow.map((x) => `<li class="${x.state === 'settled' ? 'done' : x.state === 'closed' || x.state === 'gone' ? 'failed' : 'waiting'}"><span class="st">${x.state === 'settled' ? '✓' : x.state === 'closed' || x.state === 'gone' ? '✕' : '◔'}</span><span class="lb">${fmtAmount(BigInt(x.amount), dec, 4)} ${T} for ${fmtSats(x.sats)} sats<em>${sellStatusText(x)}</em></span></li>`).join('')}</ol>`);
    };
    paintTrack();
    S.onSellsChanged = () => { if (document.body.contains(md.body)) paintTrack(); };
    md.unlockEscape();
    md.buttons([...(unsold > 0n && !err ? [listRest()] : []), { label: 'Close', primary: true, onClick: () => { S.onSellsChanged = null; md.close(); } }]);
    if (err) ctx.onError?.(err);
    const pump = async () => { for (let i = 0; i < 40 && document.body.contains(md.body); i++) { await trackSells(); await sleep(SELL_TRACK_MS); } };
    pump();
  }

  async function runLimitBuy(md, { order, now, bidBase, bidSats, watchtower }) {
    try { await ctx.unlock(); } catch (e) { md.close(); ctx.toast?.(ctx.friendlyError(e), 'error'); return; }
    if (!beginBusy(md)) return;
    md.lockEscape();
    const steps = [];
    if (now) now.fills.forEach((f) => steps.push({ status: 'queued', label: fillLabel(f), fill: f }));
    const bidStep = bidBase > 0n ? { status: 'queued', label: `Bid ${fmtAmount(bidBase, dec, 4)} ${T} at ${fmtUnit(order.unit)}` } : null;
    const wtStep = watchtower ? { status: 'queued', label: 'Hand the bid to the watchtower' } : null;
    if (bidStep) steps.push(bidStep);
    if (wtStep) steps.push(wtStep);
    const paint = (t) => md.set(`<h2>${t}</h2>${stepsHtml(steps)}`);
    md.buttons([]);
    let spent = 0; let got = 0n; let err = null;
    for (const s of steps.filter((x) => x.fill)) {
      s.status = 'working'; paint('Placing your order…');
      try {
        const r = await ctx.exec.takeAsk(s.fill.ask.raw, s.fill.ask.kind, s.fill.amount, { onClaimed: () => { s.status = 'waiting'; s.note = 'waiting for the seller to confirm'; paint('Placing your order…'); } });
        s.status = 'done'; s.note = ''; s.txid = r?.reveal_txid || r?.commit_txid || r?.txid; spent += s.fill.sats; got += s.fill.amount;
        try { await ctx.after.bought({ amount: s.fill.amount, result: r, ids: s.fill.ask.whole ? [s.fill.ask.id] : [] }); } catch {}
      } catch (e) {
        if (isRerouteable(e)) { s.status = 'failed'; s.note = 'taken by someone else — your bid covers it'; }
        else { s.status = 'failed'; s.note = ctx.friendlyError(e); err = e; break; }
      }
    }
    // The bid covers whatever didn't fill now, at the same price.
    let bidId = null;
    if (!err && bidStep) {
      const restSats = order.totalSats - spent;
      let base = restSats >= DUST ? amountForSats(restSats, order.unit, dec) : 0n;
      if (base > order.base - got) base = order.base > got ? order.base - got : 0n;
      const sats = satsForAmount(base, order.unit, dec);
      if (base > 0n && sats >= DUST) {
        bidStep.label = `Bid ${fmtAmount(base, dec, 4)} ${T} at ${fmtUnit(order.unit)}`;
        bidStep.status = 'working'; paint('Placing your order…');
        try {
          const r = await ctx.exec.placeBid({ amountBase: base, priceSats: sats, expirySec: S.expirySec });
          bidId = r?.bid_id || null;
          bidStep.status = 'done';
          if (wtStep && bidId) {
            wtStep.status = 'working'; paint('Placing your order…');
            try {
              await ctx.exec.registerWatchtower({ bidId, amountBase: base, priceSats: sats, expirySec: S.expirySec, expiry: r.expiry });
              wtStep.status = 'done';
            } catch (e) { wtStep.status = 'failed'; wtStep.note = `${ctx.friendlyError(e, { verb: 'Watchtower' })} — your bid is live; fills complete while this page is open`; }
          }
        } catch (e) { bidStep.status = 'failed'; bidStep.note = ctx.friendlyError(e, { verb: 'Bid' }); err = e; if (wtStep) wtStep.status = 'skipped'; }
      } else { bidStep.status = 'skipped'; bidStep.note = 'everything filled'; if (wtStep) wtStep.status = 'skipped'; }
    }
    paint(err ? 'Order not completed' : bidId ? 'Your bid is live' : 'Done');
    md.unlockEscape();
    md.buttons([{ label: 'Done', primary: true, onClick: () => md.close() }]);
    if (err) ctx.onError?.(err);
    endBusy();
  }

  async function runList(md, { order, shape }) {
    try { await ctx.unlock(); } catch (e) { md.close(); ctx.toast?.(ctx.friendlyError(e), 'error'); return; }
    if (!beginBusy(md)) return;
    md.lockEscape();
    const step = { status: 'working', label: shape.k >= 2 ? `Split into ${shape.k} pieces and list them` : 'List for sale' };
    md.set(`<h2>Listing…</h2>${stepsHtml([step])}`);
    md.buttons([]);
    let err = null;
    try {
      const r = await ctx.exec.listForSale({ amountBase: shape.listedBase, shape, unit: order.unit, expirySec: S.expirySec, onStage: (t) => { step.note = t; md.set(`<h2>Listing…</h2>${stepsHtml([step])}`); } });
      step.status = 'done'; step.note = ''; step.txid = r?.txid || null;
      await ctx.after.listed?.({ amount: shape.listedBase, result: r });
    } catch (e) { step.status = 'failed'; step.note = ctx.friendlyError(e, { verb: 'Listing' }); err = e; }
    md.set(`<h2>${err ? 'Listing not completed' : 'Listed'}</h2>${stepsHtml([step])}${err ? '' : '<p class="bm-q bm-muted">It shows in the book within a few seconds. Cancel from Your orders.</p>'}`);
    md.unlockEscape();
    md.buttons([{ label: 'Done', primary: true, onClick: () => md.close() }]);
    if (err) ctx.onError?.(err);
    endBusy();
  }

  async function cancelOrder(id) {
    const r = S.myRows?.get(id);
    if (!r || S.cancelling.has(id)) return;
    const what = `${r.side === 'buy' ? 'bid for' : r.kind === 'sale' ? 'offer of' : 'listing of'} ${fmtAmount(r.amount, dec, 4)} ${asset0.ticker} at ${fmtUnit(r.unit)}`;
    const onchain = r.kind === 'preauth';
    // An offer whose claim has been fulfilled is already in the buyer's hands, signed. Taking
    // it off the board does not void that; only spending its coin back to you does.
    let signed = false;
    if (r.kind === 'intent' || r.kind === 'intent-var' || r.kind === 'sale') {
      try { signed = !!(await ctx.exec.offerNeedsSpend?.(r.raw)); } catch { signed = false; }
    }
    const ok = await ctx.confirm({
      title: `Cancel ${r.side === 'buy' ? 'bid' : 'listing'}?`,
      body: onchain
        ? `Cancels your ${what}. This spends the listed coins back to your own wallet so the listing can never be filled — one network fee (about 800 sats).`
        : signed
          ? `Cancels your ${what}. A buyer already holds the signed settlement for it, which stays valid for 24 hours, so this spends the listed coins back to your own wallet to void it — one network fee (about 800 sats).`
          : `Cancels your ${what}.${r.raw?.watchtower ? ' The watchtower stops too, and whatever is left in the bid wallet comes back to you.' : ''}`,
      confirmLabel: 'Cancel order', cancelLabel: 'Keep it',
    });
    if (!ok || S.cancelling.has(id)) return;
    S.cancelling.add(id); paintOrders();
    try {
      await ctx.unlock();
      if (r.kind === 'preauth') await ctx.exec.cancelListing(r.raw);
      else if (r.kind === 'intent' || r.kind === 'intent-var') await ctx.exec.cancelOffer(r.raw);
      else if (r.kind === 'sale') {
        await ctx.exec.cancelOffer(r.raw);
        const sale = S.sells.get(r.raw.intent_id);
        if (sale) { sale.state = 'closed'; sale.doneAt = nowSec(); saveSells(); }
      } else await ctx.exec.cancelBid(r.raw);
      ctx.toast?.('Order cancelled', 'success');
    } catch (e) { ctx.toast?.(ctx.friendlyError(e, { verb: 'Cancel' }), 'error', 9000); ctx.onError?.(e); }
    S.cancelling.delete(id);
    refresh({ force: true });
  }

  // Load a book row into the ticket: an ask → buy it, a bid → sell into it.
  function primeFromRow(side, key) {
    const lv = S.ladder?.[side]?.get(key);
    if (!lv) return;
    if (lv.flag === 'mine') { el.orders.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    if (side === 'ask') {
      // Everything up to and including this level, at this level's price. A level that
      // needs the seller's confirmation turns that option on first, so the cheaper rows
      // counted below are ones the quote can actually buy.
      if (!lv.rows[0].instant) S.includeMaker = true;
      const upTo = S.book.asks.filter((a) => !a.mine && a.unit <= lv.unit * (1 + 1e-9) && (S.includeMaker || a.instant));
      const need = upTo.reduce((t, a) => t + a.amount, 0n);
      const best = eligibleAsks()[0]?.unit || lv.unit;
      S.slip = SLIPPAGE_CHOICES.find((p) => best * (1 + p / 100) >= lv.unit) ?? SLIPPAGE_CHOICES[SLIPPAGE_CHOICES.length - 1];
      prime({ side: 'buy', type: 'market', receiveBase: need });
    } else {
      if (lv.flag === 'manual') S.includeManual = true;
      const upTo = S.book.bids.filter((b) => !b.mine && b.unit >= lv.unit * (1 - 1e-9) && (S.includeManual || b.auto));
      const need = upTo.reduce((t, b) => t + b.amount, 0n);
      const m = me();
      const free = freeBase(m);
      const give = free != null && free > 0n && free < need ? free : need;
      const best = eligibleBids()[0]?.unit || lv.unit;
      S.slip = SLIPPAGE_CHOICES.find((p) => best * (1 - p / 100) <= lv.unit) ?? SLIPPAGE_CHOICES[SLIPPAGE_CHOICES.length - 1];
      prime({ side: 'sell', type: 'market', sellBase: give });
    }
  }

  // Set the ticket from outside (book rows, Holdings "sell", the post-buy "bid the rest").
  function prime({ side, type, spendSats, receiveBase, sellBase, amountBase, totalSats, unit } = {}) {
    if (side) S.side = side;
    if (type) S.type = type;
    if (S.lane !== 'btc') setLane('btc');
    if (S.type === 'market' && S.side === 'buy') {
      if (receiveBase != null) { S.buyIn = 'token'; el.amount.value = fmtAmount(receiveBase, dec).replace(/,/g, ''); }
      else if (spendSats != null) { S.buyIn = 'sats'; el.amount.value = String(spendSats); }
    } else if (S.type === 'market') {
      if (sellBase != null) el.amount.value = fmtAmount(sellBase, dec).replace(/,/g, '');
    } else {
      // Resting defaults: a buy joins the best bid (or the cheapest ask when bids sit above
      // it); a sell joins the cheapest ask.
      const bb = S.book?.bestBid, ba = S.book?.bestAsk;
      const u = unit || (S.side === 'buy'
        ? (bb && ba ? Math.min(bb, ba) : bb || ba || ctx.asset().markUnit)
        : (ba || bb || ctx.asset().markUnit));
      if (u) el.price2.value = plainUnit(u);
      if (totalSats != null && u) el.amount.value = fmtAmount(amountForSats(totalSats, u, dec), dec).replace(/,/g, '');
      else if ((amountBase ?? sellBase) != null) el.amount.value = fmtAmount(amountBase ?? sellBase, dec).replace(/,/g, '');
      S.anchorTotal = false;
      S.syncTotal?.();
    }
    savePref();
    paintTicketFrame();
    paintAll();
    el.ticket.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.amount.focus({ preventScroll: true });
  }

  function setLane(lane) {
    S.lane = lane;
    $$('[data-act=lane]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === lane)));
    if (el.laneBtc) el.laneBtc.hidden = lane !== 'btc';
    if (el.laneEth) el.laneEth.hidden = lane !== 'eth';
    if (el.laneNote) {
      el.laneNote.textContent = lane === 'eth'
        ? `ETH ⇄ ${asset0.ticker} (ERC20) at the best price across Ethereum venues, from your own Ethereum wallet.`
        : 'Peer-to-peer order book — pay in sats, settle on Bitcoin. No custodian, no wrapped coins.';
    }
    // The Ethereum ticket gets the Bitcoin book's last price so it can say how the two compare.
    if (lane === 'eth' && ctx.mountEth && el.ethHost) {
      ctx.mountEth(el.ethHost, { markUnit: () => ctx.asset().markUnit, btcUsd: () => ctx.btcUsd(), iconHtml: () => ctx.asset().iconHtml });
    }
    ctx.onLane?.(lane);
    paintLive();
    if (lane === 'btc') refresh({ force: true });
  }

  // ── events ────────────────────────────────────────────────────────────────
  host.addEventListener('click', (e) => {
    if (S.destroyed) return;
    const t = e.target.closest('[data-act]');
    if (!t || !host.contains(t)) return;
    const act = t.dataset.act;
    if (act === 'back') { e.preventDefault(); ctx.goBack(); return; }
    if (act === 'refresh') { refresh({ force: true }); return; }
    if (act === 'lane') { setLane(t.dataset.v); return; }
    if (act === 'side') { if (S.side !== t.dataset.v) { S.side = t.dataset.v; S.limitAt = null; el.amount.value = ''; el.total.value = ''; savePref(); paintTicketFrame(); paintAll(); } return; }
    if (act === 'type') {
      // The amount box counts sats for a market buy entered in sats and tokens everywhere
      // else, so crossing between the two carries the value over in the other unit.
      const from = readOrder(), to = t.dataset.v;
      const carried = S.side === 'buy' && S.buyIn === 'sats' && S.type !== to;
      S.type = to; savePref();
      if (carried) el.amount.value = to === 'market' && from?.totalSats ? String(from.totalSats) : '';
      if (to === 'limit' && (carried || !el.price2.value)) prime({ type: 'limit', totalSats: carried ? from?.spendSats : undefined });
      paintTicketFrame(); paintAll(); return;
    }
    if (act === 'to-limit') {
      const o = readOrder();
      S.type = 'limit';
      prime({ type: 'limit', totalSats: o?.spendSats, amountBase: o?.receiveBase ?? o?.sellBase });
      return;
    }
    if (act === 'allow-price') { S.limitAt = { side: S.side, unit: Number(t.dataset.v) }; paintOpts(); paintQuote(); return; }
    if (act === 'inc-manual-now') { S.includeManual = true; savePref(); paintOpts(); paintQuote(); return; }
    if (act === 'to-market') { S.type = 'market'; prime({ type: 'market', sellBase: parseAmount(el.amount.value, dec) || undefined }); return; }
    if (act === 'unit') {
      if (S.side !== 'buy' || S.type !== 'market') return;
      const q = S.quote;
      if (S.buyIn === 'sats') { S.buyIn = 'token'; el.amount.value = q?.plan?.amount > 0n ? fmtAmount(q.plan.amount, dec).replace(/,/g, '') : ''; }
      else { S.buyIn = 'sats'; el.amount.value = q?.plan?.sats > 0 ? String(q.plan.sats) : ''; }
      savePref(); paintTicketFrame(); paintAll(); return;
    }
    if (act === 'chip') { el.amount.value = t.dataset.v; S.anchorTotal = false; S.syncTotal(); paintQuote(); return; }
    if (act === 'pchip') { el.price2.value = plainUnit(Number(t.dataset.v)); S.anchorTotal ? el.total.dispatchEvent(new Event('input')) : S.syncTotal(); paintQuote(); return; }
    if (act === 'go') { review(); return; }
    if (act === 'unlock') { ctx.unlock().then(() => refresh({ soft: true })).catch(() => {}); return; }
    if (act === 'fund') { ctx.fundSats(); return; }
    if (act === 'row') {
      // At my price: a row click just sets the price to that level (join or cross it).
      if (S.type === 'limit') {
        const lv = S.ladder?.[t.dataset.side]?.get(t.dataset.key);
        if (lv) { el.price2.value = plainUnit(lv.unit); S.anchorTotal ? el.total.dispatchEvent(new Event('input')) : S.syncTotal(); paintQuote(); el.amount.focus({ preventScroll: true }); }
        return;
      }
      primeFromRow(t.dataset.side, t.dataset.key); return;
    }
    if (act === 'more-bids') { const f = !(S.showAllAsks && S.showAllBids); S.showAllAsks = f; S.showAllBids = f; paintBook(); return; }
    if (act === 'cancel') { cancelOrder(t.dataset.id); return; }
    if (act === 'tf') { LS.set('tacit-btc-market-tf', t.dataset.v); paintChart(); return; }
    ctx.onAct?.(act, t);
  }, sig);
  host.addEventListener('change', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'slip') { S.slip = Number(t.value); S.limitAt = null; savePref(); paintOpts(); paintQuote(); }
    if (t.dataset.act === 'inc-maker') { S.includeMaker = t.checked; savePref(); paintQuote(); }
    if (t.dataset.act === 'inc-manual') { S.includeManual = t.checked; savePref(); paintQuote(); }
    if (t.dataset.act === 'expiry') { S.expirySec = Number(t.value); savePref(); }
    if (t.dataset.act === 'wt') { S.watchtower = t.checked; savePref(); paintQuote(); }
  }, sig);
  let debounce = null;
  const onInput = () => { clearTimeout(debounce); debounce = setTimeout(paintQuote, 60); };
  // At my price: any two of price / amount / total set the third. Typing the total
  // anchors it, so a later price change re-derives the amount instead.
  const unitNow = () => Number(String(el.price2.value).replace(/[,_\s]/g, ''));
  const syncTotal = () => {
    const u = unitNow(); const base = parseAmount(el.amount.value, dec);
    el.total.value = u > 0 && base > 0n ? String(satsForAmount(base, u, dec)) : '';
  };
  const syncAmount = () => {
    const u = unitNow(); const t = Number(String(el.total.value).replace(/[,_\s]/g, ''));
    el.amount.value = u > 0 && t > 0 ? fmtAmount(amountForSats(t, u, dec), dec).replace(/,/g, '') : '';
  };
  el.amount.addEventListener('input', () => { S.anchorTotal = false; if (S.type === 'limit') syncTotal(); onInput(); }, sig);
  el.price2.addEventListener('input', () => { if (S.type === 'limit') { if (S.anchorTotal) syncAmount(); else syncTotal(); } onInput(); }, sig);
  el.total.addEventListener('input', () => { S.anchorTotal = true; syncAmount(); onInput(); }, sig);
  el.total.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.go.disabled) review(); }, sig);
  S.syncTotal = syncTotal;
  el.amount.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.go.disabled) review(); }, sig);
  el.price2.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.go.disabled) review(); }, sig);
  let resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(paintChart, 150); }, sig);

  function destroy() {
    S.destroyed = true;
    clearTimeout(S.timer);
    clearInterval(liveTick);
    clearTimeout(debounce);
    ac.abort();
  }

  // first paint
  paintTicketFrame();
  if (ctx.mountEth) setLane(S.lane); else S.lane = 'btc';
  rebuildBook();
  paintAll();
  paintChart();
  refresh({ force: false }).then(() => { if (!S.stats) refresh({ force: true }); });
  schedule();

  return {
    aid,
    refresh,
    prime,
    destroy,
    get state() { return S; },
  };
}
