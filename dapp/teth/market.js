// tETH on Bitcoin: what the Bitcoin order book says of it, and how the page shows that. tETH is an asset on Bitcoin as well (the same id on both
// chains: bridged tETH lands there), and anyone holding it there can list it for sats or bid for it, as TAC is traded. Until someone does, there
// is nothing to show but the price it would have: ETH's, in sats. So the panel has two states, said by `isActive`: a book (its depth, its ladders,
// the last price and how far it sits from ETH) with a way into the Bitcoin market; and a quiet one that says what will appear, with ETH's price
// in sats as its one figure.
import { buildBook, ladderLevels } from '/btc-book.js?cb=0a09ab9e';
import { api, esc, grp, usd } from '/trade/util.js?cb=e8317464';

export const BTC_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';        // tETH on Bitcoin: the cETH asset id, without the 0x
const BOOK_ROWS = 8;

// The asset, its listings and its bids from the API. null: the asset could not be read (not "no market"). A book that could not be read is null too,
// and `bidsRead` says whether the bids were (a list that could not be read is not the same as no bids).
export async function readMarket() {
  const [asset, sales, bidRows] = await Promise.all([api(`/assets/${BTC_ID}?network=mainnet`), api(`/assets/${BTC_ID}/preauth-sales?network=mainnet`), api(`/assets/${BTC_ID}/bid-intents?network=mainnet`)]);
  if (!asset) return null;
  const bidsRead = Array.isArray(bidRows?.intents);
  const book = Array.isArray(sales?.sales) ? buildBook({ assetId: BTC_ID, decimals: 8, listings: sales.sales.map((x) => ({ ...x, kind: 'preauth' })), bids: bidsRead ? bidRows.intents : [] }) : null;   // the sale rows carry no `kind`
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  return { trades: Array.isArray(asset.trades) ? asset.trades : [], mark: n(asset.mark_price?.unit) || null, vol24: n(asset.volume_24h_sats) || 0, change24: n(asset.price_24h_change_pct),
    holders: n(asset.holder_count), transfers: n(asset.transfer_count), firstTrade: n(asset.price_first_trade_ts), tradesCap: n(asset.trades_cap), book, bidsRead };
}
// Something to show: a listing, a bid, or a trade.
export const isActive = (m) => !!m && (m.trades.length > 0 || !!(m.book && (m.book.asks.length > 0 || m.book.bids.length > 0)));
// 'active': something to show. 'idle': the listings and the bids were both read and there is nothing. 'unread': one of them could not be, and nothing
// else shows: that is not an empty book, and is not said to be.
export const bookState = (m) => (!m ? 'none' : isActive(m) ? 'active' : !m.book || !m.bidsRead ? 'unread' : 'idle');

// What a tETH is worth in sats at ETH's price now: the figure a Bitcoin price is held against.
export const refSats = (ethUsd, btcUsd) => (ethUsd > 0 && btcUsd > 0 ? (ethUsd / btcUsd) * 1e8 : null);
// How far a price in sats sits from ETH's: negative is below.
export const premium = (sats, ref) => (sats > 0 && ref > 0 ? sats / ref - 1 : null);
// How far a price sits from ETH's, in words: the one phrase the hero's lanes and the Bitcoin panel both use.
export const vsEth = (p) => (p == null ? '' : Math.abs(p) < 0.005 ? 'level with ETH' : `${Math.abs(p * 100).toFixed(Math.abs(p) < 0.1 ? 1 : 0)}% ${p < 0 ? 'under' : 'over'} ETH`);
export const satsTxt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const left = (t, at) => { const d = t - at; return d <= 0 ? 'now' : d < 3600 ? `${Math.ceil(d / 60)} min` : d < 172800 ? `${Math.round(d / 3600)} h` : `${Math.round(d / 86400)} days`; };
const tethTxt = (n) => grp(n, n >= 100 ? 0 : n >= 1 ? 2 : 4);

// The book as the Bitcoin market draws it: the asks above with the cheapest nearest the middle, the last price and the spread between, the bids
// below, each row shaded by how much lies between it and the middle. A row with `attrs` is a button.
export function stackBook({ asks, bids, totalHead, mid, all = false, emptyAsk = 'No one is selling right now.', emptyBid = 'No one is bidding right now.', ghost = false }) {
  const show = (l) => (all ? l : l.slice(0, BOOK_ROWS)), a = show(asks), b = show(bids);
  const cum = (l) => { let t = 0; return l.map((x) => (t += x.depth)); };
  const ac = cum(a), bc = cum(b), max = Math.max(ac.at(-1) || 0, bc.at(-1) || 0) || 1;
  const row = (x, side, c) => {
    const inner = `<span class="p">${esc(x.price)}${x.small ? `<small>${esc(x.small)}</small>` : ''}</span><span class="a">${x.mine ? '<i class="ob-tag">yours</i>' : ''}${esc(x.amount)}</span><span class="t">${esc(x.total)}</span>`;
    const cls = `ob-row ${side}${x.mine ? ' mine' : ''}`, style = `--w:${Math.max(1, Math.round((c / max) * 100))}%`;
    return x.attrs && !x.mine ? `<button type="button" class="${cls}" style="${style}" title="${esc(x.title)}" aria-label="${esc(x.label)}" ${x.attrs}>${inner}</button>` : `<div class="${cls}" style="${style}" title="${esc(x.title)}">${inner}</div>`;
  };
  const hidden = asks.length - a.length + bids.length - b.length;
  return `<div class="ob${ghost ? ' ghost' : ''}"><div class="ob-head"><span>Price</span><span><svg class="tk xs inl" aria-hidden="true"><use href="#tk-teth"/></svg><span class="tn">tETH</span></span><span>${esc(totalHead)}</span></div>`
    + `<div class="ob-asks">${a.length ? a.map((x, i) => row(x, 'ask', ac[i])).reverse().join('') : `<div class="ob-empty">${esc(emptyAsk)}</div>`}</div>`
    + `<div class="ob-spread">${mid}</div>`
    + `<div class="ob-bids">${b.length ? b.map((x, i) => row(x, 'bid', bc[i])).join('') : `<div class="ob-empty">${esc(emptyBid)}</div>`}</div>`
    + (hidden > 0 || all ? `<button type="button" class="ob-more" data-more="1">${all ? 'Show less' : `Full book · ${asks.length} asks, ${bids.length} bids`}</button>` : '') + '</div>';
}
const spreadTxt = (ask, bid) => (ask && bid ? `<span title="Between the cheapest ask and the best bid">spread ${Math.abs((ask - bid) / ask * 100).toFixed(1)}%</span>` : '');

// The ladders of a live book. `px(sats)` writes a price in the page's unit (dollars when the rate is known, else sats), `live` whether the rows open the market.
export function ladders(m, { btcUsd, live, all = false, at }) {
  const b = m.book, px = (sats) => (btcUsd ? usd(sats * btcUsd / 1e8) : `${satsTxt(sats)} sats`);
  const lvs = (rows, ask) => ladderLevels(rows, ask ? 'ask' : 'bid').map((l, i) => {
    const amt = Number(l.amount) / 1e8, price = px(l.unit), ends = ask ? Math.min(...l.rows.map((r) => r.expiry).filter(Boolean)) : 0;
    const why = ask ? (l.count > 1 ? `${l.count} listings, each taken whole` : 'one listing, taken whole') : l.flag === 'auto' ? 'settles within minutes' : 'settles when the bidder is online';
    return { price, small: [btcUsd ? `${satsTxt(l.unit)} sats` : '', l.count > 1 ? `${l.count} listings` : ''].filter(Boolean).join(' · '), amount: tethTxt(amt), total: satsTxt(l.sats), depth: l.sats, mine: l.flag === 'mine',
      attrs: live ? `data-btc="${ask ? 'buy' : 'sell'}" data-i="${i}"` : '', title: `${why}${Number.isFinite(ends) && ends ? ` · ends in ${left(ends, at)}` : ''}.${live ? ` Click to ${ask ? 'buy' : 'sell'} up to this price.` : ''}`,
      label: `${ask ? 'Buy up to' : 'Sell up to'} ${tethTxt(amt)} tETH at ${price} each` };
  });
  return stackBook({ asks: lvs(b.asks, true), bids: lvs(b.bids, false), totalHead: 'Sats', all,
    mid: `${m.mark ? `<span class="ob-last"><b>${esc(px(m.mark))}</b><em>last trade</em></span>` : '<span></span>'}${spreadTxt(b.bestAsk, b.bestBid)}` });
}

// The quiet state: the book's own shape, empty, with ETH's price in sats where the last trade will be.
export function idle(m, { ref }) {
  return stackBook({ asks: [], bids: [], totalHead: 'Sats', ghost: true, emptyAsk: 'No one is selling yet.', emptyBid: 'No one is bidding yet.',
    mid: ref ? `<span class="ob-last"><b>≈ ${esc(satsTxt(ref))} sats</b><em>ETH’s price</em></span>` : '<span></span>' });
}

// What a ladder click should set the market's ticket to: everything cheaper than the row, and the row. The row's index counts the levels as the
// ladder draws them (one of them may be the visitor's own), so the levels are made from every row and the visitor's own are left out of the sum.
export function bookPrime(m, kind, i) {
  const b = m.book, upTo = (rows, side) => ladderLevels(rows, side).slice(0, i + 1).filter((l) => l.flag !== 'mine').reduce((a, l) => a + l.amount, 0n);
  if (kind === 'buy') return { side: 'buy', type: 'market', receiveBase: upTo(b.asks, 'ask') };
  if (kind === 'sell') return { side: 'sell', type: 'market', sellBase: upTo(b.bids, 'bid') };
  if (kind === 'list') return { side: 'sell', type: 'limit' };
  return null;
}

// The line in the panel's head: the last price and how far it sits from ETH's, or what the quiet state is waiting for.
export function summary(m, { ethUsd, btcUsd, ref }) {
  if (!m) return '';
  if (bookState(m) === 'unread') return '<span>book not read</span>';
  if (!isActive(m)) return '<span>not listed yet</span>';
  if (!m.mark) return `<span>${m.book?.asks.length || 0} listed · ${m.book?.bids.length || 0} bid${m.book?.bids.length === 1 ? '' : 's'} · no trades yet</span>`;
  const word = vsEth(premium(m.mark, ref));
  return `<b class="num">${esc(satsTxt(m.mark))} sats</b>${btcUsd ? ` · ${usd(m.mark * btcUsd / 1e8)}` : ''}${word ? ` · ${word}` : ''}`;
}

// A line of closes with no gaps: a bar in which nothing traded holds the price before it, the range opens at the price it opened on (`seed`), and
// the last bar closes at the price now (`spot`).
export function fillBars(bars, { tf, since = 0, seed = null, spot = 0, at }) {
  const from = since ? Math.floor(since / tf) * tf : bars[0]?.t;
  if (from == null || (!bars.length && seed == null)) return bars;
  const end = Math.floor(at / tf) * tf;
  if (end < from || (end - from) / tf > 800) return bars;
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
