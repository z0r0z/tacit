#!/usr/bin/env node
// The Bitcoin market module (dapp/btc-market.js) that the trade page opens in a sheet, mounted for real in jsdom with a stub context built from the
// fixtures captured from the API on 2026-10-12: no network, no browser. Pins what the page relies on: a ladder price sets the ticket as a press on the
// sheet's own row does (a limit that reaches it, the online-only bids it needs, no more to sell than the key holds), the orders box after a key is locked and
// opened again, a sale followed here belonging to the key that made it, a typed total being the sats typed, the best-ask chip reaching the ask, and a sell
// asking for sats to pay its network fee.
//
//   node tests/btc-market-sheet.test.mjs        (JSDOM_ROOT=<dir with node_modules/jsdom> picks a jsdom; see tests/_jsdom.mjs)

import fs from 'node:fs';
import { JSDOM } from './_jsdom.mjs';
const FX = new URL('./fixtures/', import.meta.url).pathname;
export const AID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const jsonF = (n) => JSON.parse(fs.readFileSync(FX + n, 'utf8'));
export const fx = { market: jsonF('tac-market-2026-10-12.json'), bids: jsonF('tac-bids-2026-10-12.json'), asset: jsonF('tac-asset-2026-10-12.json'), sales: jsonF('tac-sales-2026-10-12.json') };
export const now = () => Math.floor(Date.now() / 1000);

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'Event', 'HTMLElement', 'Element', 'Node', 'AbortController']) {
  try { Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true }); } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
globalThis.addEventListener = w.addEventListener.bind(w);
globalThis.removeEventListener = w.removeEventListener.bind(w);
w.Element.prototype.scrollIntoView = function () {};
const { mountBtcMarket } = await import(process.env.BTC_MARKET || new URL('../dapp/btc-market.js', import.meta.url).pathname);

export const listingsFx = (opts = {}) => {
  const soon = now() + 7 * 86400;
  return fx.market.listings.filter((l) => !opts.kind || l.kind === opts.kind).map((l) => ({ ...l, expiry: soon, expired: false, created_at: now() - 100, ...(opts.patch ? opts.patch(l) : {}) }));
};
export const bidsFx = () => fx.bids.intents.map((b) => ({ ...b, expiry: now() + 30 * 86400, created_at: now() - 100 }));

export async function mk({ listings = listingsFx(), bids = bidsFx(), me = null, markUnit = 150, lastTradeTs = null, flags = {}, exec = {}, trades = [], pref = null, ls = {} } = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, JSON.stringify(v));
  if (pref) localStorage.setItem(`tacit-btc-market-v1:${AID}`, JSON.stringify(pref));
  const calls = { take: [], batch: [], sell: [], bid: [], list: [], toast: [], cancel: [] };
  const state = { listings, bids, me, markUnit, lastTradeTs: lastTradeTs ?? now() - 3600, loads: 0 };
  const ctx = {
    aid: AID,
    asset: () => ({ ticker: 'TAC', decimals: 8, identityHtml: '<b>TAC</b>', iconHtml: '', markUnit: state.markUnit, change24h: 0, lastTradeTs: state.lastTradeTs, vol24Sats: 1000, mcapSats: null, holders: 5 }),
    listings: () => state.listings,
    loadListings: async () => { state.loads++; },
    loadBids: async () => state.bids,
    loadStats: async () => ({ trades }),
    btcUsd: () => 100000,
    me: () => state.me,
    unlock: async () => {},
    fundSats: (o) => { calls.fund = (calls.fund || 0) + 1; calls.fundArgs = o || null; },
    takenIds: () => new Set(),
    flags: { varIntents: false, watchtower: { enabled: true, maxSats: 2_000_000 }, ...flags },
    icons: {},
    exec: {
      takePreauthBatch: async (raws) => { calls.batch.push(raws.map((r) => r.sale_id)); return { reveal_txid: 'aa' }; },
      takeAsk: async (raw, kind, amt) => { calls.take.push([raw.sale_id || raw.intent_id, kind, String(amt)]); return { reveal_txid: 'bb' }; },
      sellToBid: async (raw, fill) => { calls.sell.push([raw.bid_id, fill == null ? null : String(fill)]); return { commit_txid: 'cc', offer: { intent_id: 'i' + calls.sell.length } }; },
      placeBid: async (o) => { calls.bid.push(o); return { bid_id: 'b1', expiry: now() + 86400 }; },
      registerWatchtower: async () => ({}),
      listForSale: async (o) => { calls.list.push(o); return { txid: 'dd' }; },
      cancelListing: async (raw) => { calls.cancel.push(['listing', raw.sale_id]); },
      cancelOffer: async (raw) => { calls.cancel.push(['offer', raw.intent_id]); },
      cancelBid: async (raw) => { calls.cancel.push(['bid', raw.bid_id]); },
      offerNeedsSpend: async () => false,
      ensureAutoConfirm: () => {},
      offerStatus: async () => 'posted',
      ...exec,
    },
    after: { bought: async () => {}, sold: async () => {}, listed: async () => {} },
    confirm: async () => true,
    toast: (m, k) => calls.toast.push([k, m]),
    friendlyError: (e) => String(e?.message || e),
    onError: () => {},
    goBack: () => {},
    txUrl: (t) => 'https://x/' + t,
    ...(state.ctxPatch || {}),
  };
  const host = document.createElement('div'); host.className = 'bm-skin'; document.body.appendChild(host);
  const ctl = mountBtcMarket(host, ctx);
  await ctl.refresh({ force: true });
  const $ = (s) => host.querySelector(`[data-k=${s}]`);
  const api = {
    ctl, host, ctx, state, calls, $,
    txt: (s) => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim(),
    val: (s) => $(s).value,
    type: (s, v) => { $(s).value = v; $(s).dispatchEvent(new w.Event('input', { bubbles: true })); },
    click: (sel) => { const n = host.querySelector(sel); n.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); },
    settle: () => new Promise((r) => setTimeout(r, 120)),
    go: () => ({ text: $('go').textContent, disabled: $('go').disabled, kind: $('go').dataset.kind }),
    quote: () => $('quote').textContent.replace(/\s+/g, ' ').trim(),
    destroy: () => { ctl.destroy(); host.remove(); },
  };
  return api;
}
export { w };

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const ME = '02' + 'ee'.repeat(32), OTHER = '02' + 'ab'.repeat(32), H = 'ee'.repeat(20);
const meOf = (o = {}) => ({ pubHex: ME, h160: H, unlocked: true, sats: 500000, assetBase: 100n * 10n ** 8n, ...o });
const mkL = (id, tac, sats, seller = OTHER) => ({ asset_id: AID, kind: 'preauth', sale_id: id, seller_pubkey: seller, asset_opening: { amount: String(BigInt(tac) * 10n ** 8n) }, min_price_sats: sats, expiry: now() + 86400 * 7, created_at: now() - 100 });
const click = (el, sel) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const run = async (name, f) => { try { await f(); } catch (e) { fails++; console.log('FAIL   ' + name + ': ' + (e.stack || e).toString().split('\n').slice(0, 3).join(' / ')); } };

await run('orders box', async () => {
  const me = meOf({ assetBase: 1000n * 10n ** 8n });
  const m = await mk({ listings: [mkL('mine1', 10, 2000, ME), mkL('o1', 10, 2500)], bids: [], me, markUnit: 200 });
  ok(!m.$('orders').hidden && /Cancel/.test(m.$('orders').innerHTML), 'your own listing is in Your orders with its Cancel');
  m.state.me = null; await m.ctl.refresh({ soft: true });
  ok(m.$('orders').hidden, 'locked: the box is gone');
  m.state.me = me; await m.ctl.refresh({ soft: true });
  ok(!m.$('orders').hidden && /Cancel/.test(m.$('orders').innerHTML), 'the same key opened again: the orders are drawn again (the box stayed empty)');
  m.click('[data-act=side][data-v=sell]'); m.click('[data-act=type][data-v=limit]'); await m.settle();
  m.type('limit-price', '200'); m.type('amount', '5'); await m.settle();
  ok(/already have/.test(m.quote()), 'a limit at the price of your open listing says you already have one');
  m.state.listings = [mkL('o1', 10, 2500)]; await m.ctl.refresh({ force: true }); await m.settle();
  ok(!/already have/.test(m.quote()), 'and does not once that listing has left the book');
  m.destroy();
});

await run('sales followed here belong to a key', async () => {
  const sale = (owner) => ({ state: 'posted', ...(owner ? { owner } : {}), amount: String(60n * 10n ** 8n), sats: 9000, unit: 150, at: now(), raw: { intent_id: 'iA' } });
  const key = `tacit-btc-market-sells-v1:${AID}`;
  const rows = async (meObj, rec) => { const m = await mk({ listings: [], bids: [], me: meObj, ls: { [key]: { iA: rec } } }); m.click('[data-act=side][data-v=sell]'); await m.settle(); const t = m.txt('orders'), bal = m.txt('bal'); m.destroy(); return { t, bal }; };
  const own = await rows(meOf(), sale(ME)), other = await rows(meOf({ pubHex: OTHER }), sale(ME)), old = await rows(meOf({ pubHex: OTHER }), sale(null));
  ok(/Sell 60/.test(own.t) && /60.*in your open orders/.test(own.bal), 'a sell followed under this key is in its orders and holds its TAC');
  ok(!/Sell 60/.test(other.t) && !/in your open orders/.test(other.bal), 'another key does not see it, and none of its TAC is locked');
  ok(/Sell 60/.test(old.t), 'a record from before keys were noted stays visible');
});

await run('typed total', async () => {
  const m = await mk({ me: meOf() });
  m.click('[data-act=type][data-v=limit]'); await m.settle();
  m.type('limit-price', '3'); m.type('total', '1000'); await m.settle();
  ok(/up to 1,000 sats/.test(m.quote()) && m.val('total') === '1000', `a total of 1000 sats at 3 stays 1,000 (amount ${m.val('amount')}, ${m.quote().slice(0, 40)})`);
  m.destroy();
});

await run('best ask chip', async () => {
  const m = await mk({ listings: [mkL('a1', 100, 16799), mkL('a2', 100, 20000)], bids: [], me: meOf(), markUnit: 168 });
  m.click('[data-act=type][data-v=limit]'); await m.settle();
  const chip = m.host.querySelector('[data-act=pchip][data-kind=ask]');
  ok(!!chip, 'a limit buy offers the best ask as a price');
  click(chip); await m.settle();
  ok(Number(m.val('limit-price')) >= Number(chip.dataset.v), `it sets a price that reaches the ask (${m.val('limit-price')} for ${chip.dataset.v})`);
  m.destroy();
});

await run('a ladder price', async () => {
  const listings = [mkL('l1', 1000, 150000), mkL('l2', 1000, 170000), mkL('l3', 1000, 190000), mkL('l4', 1000, 250000), mkL('l5', 1000, 400000)];
  const m = await mk({ listings, bids: [], me: meOf({ sats: 50_000_000 }), markUnit: 150 });
  const asks = m.ctl.state.book.asks, far = asks[asks.length - 1].unit;
  m.ctl.primeAt('ask', far); await m.settle();
  ok(Number(m.val('amount')) === 5000 && !/for sale within your max price/.test(m.quote()), `a price beyond the largest % choice buys everything up to it (${m.val('amount')} TAC: ${m.quote().slice(0, 70)})`);
  ok(m.ctl.state.limitAt?.side === 'buy' && Math.abs(m.ctl.state.limitAt.unit - far) < 1e-9, 'the limit is that price, shown as the max price');
  m.ctl.primeAt('ask', asks[1].unit); await m.settle();
  ok(Number(m.val('amount')) === 2000 && m.ctl.state.limitAt == null && !/for sale within your max price/.test(m.quote()), 'a nearer price keeps its % limit (no exact price kept from the one before)');
  m.destroy();
  // the plan a caller quoted (a budget in sats, going as far as a price): the ticket is set to go as far, and takes the bids that settle only while the bidder is online
  const spend = async (extra) => { const x = await mk({ listings, bids: [], me: meOf({ sats: 50_000_000 }), markUnit: 150, pref: { side: 'buy', type: 'market', slip: 5 } }); x.ctl.prime({ side: 'buy', type: 'market', spendSats: 760_000, ...extra }); await x.settle(); const r = { quote: x.quote(), limitAt: x.ctl.state.limitAt }; x.destroy(); return r; };
  const plain = await spend({}), reached = await spend({ reachUnit: far });
  ok(/can't fill at this price/.test(plain.quote) && !/can't fill at this price/.test(reached.quote) && reached.limitAt?.unit === far, `a budget in sats primed with the price its plan went to is quoted to that price (${reached.quote.slice(0, 60)}), where without it part of the budget stays out of reach (${plain.quote.slice(-70)})`);
  const bid = (id, tac, sats) => ({ asset_id: AID, bid_id: id, buyer_pubkey: OTHER, amount: String(BigInt(tac) * 10n ** 8n), price_sats: sats, watchtower: false, expiry: now() + 86400 * 20, created_at: now() - 100 });
  const s = await mk({ listings: [], bids: [bid('b1', 40, 6000), bid('b2', 60, 8400), bid('b3', 300, 30000)], me: meOf({ assetBase: 100n * 10n ** 8n }), markUnit: 150 });
  s.ctl.primeAt('bid', s.ctl.state.book.bids[2].unit, 'manual'); await s.settle();
  ok(s.ctl.state.side === 'sell' && s.ctl.state.includeManual === true && Number(s.val('amount')) === 100, `a bid that settles when its bidder is online turns that on, and sells no more than the 100 TAC held (${s.val('amount')})`);
  ok(!/Not enough/.test(s.go().text), `and the button is not 'Not enough TAC' (${s.go().text})`);
  s.destroy();
  const t = await mk({ listings: [], bids: [bid('b1', 40, 6000), bid('b2', 60, 8400), bid('b3', 300, 30000)], me: meOf({ assetBase: 100n * 10n ** 8n }), markUnit: 150 });
  t.ctl.prime({ side: 'sell', type: 'market', sellBase: 100n * 10n ** 8n, includeManual: true, reachUnit: t.ctl.state.book.bids[2].unit }); await t.settle();
  ok(t.ctl.state.includeManual === true && !/No match|settle automatically/.test(t.quote()), `a sale primed from a plan that took online-only bids quotes them (${t.quote().slice(0, 60)})`);
  t.destroy();
});

await run('a price the band keeps out', async () => {
  // the last trade was 100 an hour ago, so a % limit is also held under 200 (twice the last trade): a row at 210, inside +25% of the best ask, is still set exactly
  const listings = [mkL('l1', 1000, 170000), mkL('l2', 1000, 210000)];
  const m = await mk({ listings, bids: [], me: meOf({ sats: 50_000_000 }), markUnit: 100 });
  m.ctl.primeAt('ask', m.ctl.state.book.asks[1].unit); await m.settle();
  ok(/You get\s*2,000 TAC/.test(m.quote()) && m.ctl.state.limitAt?.unit === 210, `a row press buys everything up to its price, past the band around the last trade (${m.quote().slice(0, 40)}; limit ${JSON.stringify(m.ctl.state.limitAt)})`);
  m.click('[data-act=row][data-side=ask]'); await m.settle();
  ok(/You get\s*[12],000 TAC/.test(m.quote()) && !/within your max price/.test(m.quote()), `and so does the sheet's own row (${m.quote().slice(0, 40)})`);
  const bids = [{ asset_id: AID, bid_id: 'b1', buyer_pubkey: OTHER, amount: String(1000n * 10n ** 8n), price_sats: 60000, watchtower: true, expiry: now() + 86400 * 20, created_at: now() - 100 }, { asset_id: AID, bid_id: 'b2', buyer_pubkey: OTHER, amount: String(1000n * 10n ** 8n), price_sats: 45000, watchtower: true, expiry: now() + 86400 * 20, created_at: now() - 100 }];
  const s = await mk({ listings: [], bids, me: meOf({ assetBase: 5000n * 10n ** 8n }), markUnit: 100 });
  s.ctl.primeAt('bid', 45); await s.settle();
  ok(/You get\s*105,000 sats/.test(s.quote()) && s.ctl.state.limitAt?.unit === 45, `a bid under half the last trade is reached the same way on the sell side (${s.quote().slice(0, 40)})`);
  m.destroy(); s.destroy();
});

await run('the funding press carries the amount', async () => {
  const m = await mk({ listings: [mkL('l1', 1000, 150000)], bids: [], me: meOf({ sats: 1000 }), markUnit: 150 });
  m.type('amount', '150000'); await m.settle();
  ok(m.go().kind === 'fund' && /Add 149,800 more sats/.test(m.go().text), `a buy short of sats asks for them (${m.go().text})`);
  m.click('[data-act=go]'); await m.settle();
  const f = m.calls.fundArgs;
  ok(f && f.sats === 149800 && f.need === 150800 && typeof f.fiat === 'function' && f.fiat(100000) === '$100.00', `and the page's dialog is told how many are short, how many the order needs, and what they are worth (${JSON.stringify({ sats: f?.sats, need: f?.need })})`);
  m.destroy();
});

await run('signing in goes on into the review', async () => {
  // no key: the button says Review, and a press signs in and opens the review in one go (the sats read by the sign-in); short of sats it opens the funding sheet instead
  let me = null;
  const m = await mk({ listings: [mkL('l1', 1000, 150000)], bids: [], me: null, markUnit: 150 });
  m.ctx.me = () => me; m.ctx.unlock = async () => { me = meOf({ sats: 1_000_000 }); };
  m.type('amount', '150000'); await m.settle();
  m.click('[data-act=go]'); await m.settle(); await m.settle();
  const modal = document.querySelector('.bm-modal');
  ok(!!modal && /Buy 1,000 TAC/.test(modal.textContent), `one press signs in and opens the review (${(modal?.textContent || 'no review').replace(/\s+/g, ' ').slice(0, 40)})`);
  modal?.remove();
  me = null; m.ctx.unlock = async () => { me = meOf({ sats: 1000 }); }; await m.ctl.refresh({ soft: true }); await m.settle();
  m.click('[data-act=go]'); await m.settle(); await m.settle();
  ok(!document.querySelector('.bm-modal') && m.calls.fundArgs?.sats === 149800, `short of sats, the same press signs in and opens the funding sheet with the amount (${JSON.stringify({ sats: m.calls.fundArgs?.sats })})`);
  m.destroy();
});

await run('sell sats', async () => {
  const bid = { asset_id: AID, bid_id: 'bid1', buyer_pubkey: OTHER, amount: String(1000n * 10n ** 8n), price_sats: 150000, min_fill_amount: String(10n * 10n ** 8n), watchtower: true, expiry: now() + 86400 * 20, created_at: now() - 100 };
  const m = await mk({ listings: [], bids: [bid], me: meOf({ sats: 0 }), markUnit: 150 });
  m.click('[data-act=side][data-v=sell]'); await m.settle();
  m.type('amount', '100'); await m.settle();
  ok(/Add [\d,]+ more sats/.test(m.go().text) && m.go().kind === 'fund' && !m.go().disabled, `a sell with no sats asks to add them for the fee (${m.go().text})`);
  m.state.me = meOf({ sats: 50000 }); await m.ctl.refresh({ soft: true }); await m.settle();
  ok(/Review sell/.test(m.go().text), 'and is a Review once there are');
  m.destroy();
});

await run('sell headline', async () => {
  const bid = (id, tac, sats, auto) => ({ asset_id: AID, bid_id: id, buyer_pubkey: OTHER, amount: String(BigInt(tac) * 10n ** 8n), price_sats: sats, min_fill_amount: String(BigInt(tac) * 10n ** 7n), watchtower: !!auto, expiry: now() + 86400 * 20, created_at: now() - 100 });
  const avail = async (bids, pref) => { const m = await mk({ listings: [], bids, markUnit: 150, pref }); m.click('[data-act=side][data-v=sell]'); await m.settle(); const t = m.txt('avail'); m.destroy(); return t; };
  const auto1 = bid('a1', 12000, 12000, true), manual = [bid('m1', 30, 4560), bid('m2', 30, 4500), bid('m3', 30, 4470)];
  const t = await avail([auto1, ...manual, bid('m5', 100, 5100)]);
  ok(/Best bid 1 sats\/TAC · 1 bid you can sell into now/.test(t) && /3 more, up to 152\S* settle only when the bidder is online/.test(t), `the best bid you can sell into is followed by the better bids that settle only while their bidders are online, those within the ticket's min price (${t})`);
  const one = await avail([auto1, manual[0]]);
  ok(/1 more at 152\S* settles only when the bidder is online/.test(one), `one such bid reads in the singular (${one})`);
  const allowed = await avail([auto1, ...manual], { side: 'sell', type: 'market', includeManual: true });
  ok(/Best bid 152\S* sats\/TAC · 4 bids you can sell into now/.test(allowed) && !/more/.test(allowed), `once they are allowed they are the best bid and nothing is held back (${allowed})`);
  const low = await avail([auto1, bid('m5', 100, 5100)]);
  ok(/Best bid 1 sats\/TAC · 1 bid you can sell into now$/.test(low), `a bid under the ticket's min price is not offered (${low})`);
  const worse = await avail([bid('a2', 1000, 150000, true), bid('m4', 30, 3000)]);
  ok(/Best bid 150\S* sats\/TAC · 1 bid you can sell into now$/.test(worse), `a bid that settles only while its bidder is online and pays less adds nothing (${worse})`);
});

await run('last trade mark: a trade more than a day old is dimmed and carries its age', async () => {
  const day = 86400, lastOf = async (ago) => { const m = await mk({ listings: [mkL('o1', 10, 2500)], bids: [], markUnit: 150, lastTradeTs: now() - ago }); return m.$('spread').querySelector('.bm-sp-last'); };
  const fresh = await lastOf(3600);
  ok(fresh && !fresh.classList.contains('old') && fresh.querySelector('em').textContent === 'last', 'a trade an hour old reads as it did: the price and "last"');
  const edge = await lastOf(day - 600);
  ok(edge && !edge.classList.contains('old'), 'a trade just under a day old is still today\'s');
  const old = await lastOf(10 * day);
  ok(old && old.classList.contains('old') && old.querySelector('em').textContent === 'last · 10d ago', `a trade ten days old is dimmed and says how old (${old && old.textContent})`);
  ok(old && /10d ago/.test(old.title), 'and its hover text says so too');
});

// Asks priced more than three times the cheapest are one row of their own at the top of the asks, opened by a press and folded by another. Only once every nearer level is drawn.
await run('far asks fold', async () => {
  const askRows = (m) => [...m.$('asks').querySelectorAll('.bm-row')];
  const near = [mkL('c1', 10, 9000), mkL('c2', 10, 12000), mkL('c3', 10, 15000)], far = [mkL('f1', 10, 30000), mkL('f2', 10, 38000), mkL('f3', 10, 44000)];   // 900, 1,200, 1,500 | 3,000, 3,800, 4,400 sats a TAC
  const m = await mk({ listings: [...near, ...far], bids: [], markUnit: 900 });   // (the sheet's own reach, five times the last trade, is 4,500: it would draw them all)
  let rows = askRows(m);
  ok(rows[0]?.classList.contains('bm-fold') && /3 asks/.test(rows[0].textContent) && /far/.test(rows[0].textContent) && /^3,000\+/.test(rows[0].querySelector('.p').textContent), `the far asks are one row at the top: ${rows[0]?.textContent.replace(/\s+/g, ' ')}`);
  ok(/more than 3 times the cheapest, from 3,000 sats\/TAC: 30 TAC in all\. Click to show them\./.test(rows[0].title), `and its hover text says what is in it (${rows[0].title})`);
  ok(rows.length === 4 && JSON.stringify(rows.slice(1).map((r) => r.querySelector('.p').textContent)) === JSON.stringify(['1,500', '1,200', '900.00']), 'under it, the nearer asks: the cheapest at the bottom, by the spread');
  m.click('[data-act=far]'); await m.settle();
  rows = askRows(m);
  ok(rows.length === 7 && rows[0].classList.contains('bm-fold') && /fold/.test(rows[0].textContent) && rows[0].getAttribute('aria-expanded') === 'true' && JSON.stringify(rows.slice(1, 4).map((r) => r.querySelector('.p').textContent)) === JSON.stringify(['4,400', '3,800', '3,000']), 'a press opens them, above the nearer ones, and the row now offers to fold them');
  ok(rows[1].dataset.act === 'row' && rows[1].dataset.side === 'ask', 'and each is a row to press, as the others are');
  m.click('[data-act=far]'); await m.settle();
  ok(askRows(m).length === 4 && askRows(m)[0].getAttribute('aria-expanded') === 'false', 'another press folds them again');
  m.destroy();
  // more near levels than the ladder draws: the fold row would stand past rows that are not there, so it waits for the full book
  const many = Array.from({ length: 10 }, (_, i) => mkL('n' + i, 10, 9000 + i * 600));
  const b = await mk({ listings: [...many, mkL('x1', 10, 90000)], bids: [], markUnit: 900 });
  ok(!b.$('asks').querySelector('.bm-fold') && askRows(b).length === 8, 'with ten near levels and the ladder short, there is no fold row');
  b.click('[data-act=more-bids]'); await b.settle();
  ok(/1 ask/.test(b.$('asks').querySelector('.bm-fold')?.textContent || '') && askRows(b).length === 11, 'the full book shows every near level with the fold row above them');
  b.destroy();
  // the person's own ask is never folded, and nothing folds when nothing is far
  const own = await mk({ listings: [mkL('c1', 10, 9000), mkL('mine', 10, 90000, ME)], bids: [], me: meOf(), markUnit: 900 });
  ok(!own.$('asks').querySelector('.bm-fold'), 'an ask of mine at ten times the cheapest stays in the ladder');
  own.destroy();
  const flat = await mk({ listings: near, bids: [], markUnit: 900 });
  ok(!flat.$('asks').querySelector('.bm-fold') && askRows(flat).length === 3, 'a book with no far asks has no fold row');
  flat.destroy();
});

console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} btc-market-sheet checks passed`);
process.exit(fails ? 1 : 0);
