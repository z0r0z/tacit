#!/usr/bin/env node
// dapp/btc-book.js — order book normalization and market-order planning, checked against a
// snapshot of the live TAC book (tests/fixtures/btc-book-tac-2026-09-29.json) plus
// hand-built edge cases. Every sats figure a plan hands to a signer must equal the integer
// math the tacit.js executors use (floor(fill × price_sats / amount)).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRerouteable, isSpentOffer } from '../dapp/btc-market.js';
import {
  DUST, BID_CLAIM_WINDOW_SEC, buildBook, planBuy, planSell, withinBounds, ladderLevels, listingShape,
  parseAmount, parseNumber, fmtAmount, fmtUnit, amountForSats, satsForAmount, scaledSats, unitPrice,
} from '../dapp/btc-book.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/btc-book-tac-2026-09-29.json', import.meta.url)));
const AID = fx.asset_id;
const NOW = fx.captured_at;
let n = 0;
const t = (name, fn) => { fn(); n++; };

const live = (extra = {}) => buildBook({
  assetId: AID, decimals: 8, listings: fx.listings, bids: fx.bids, nowSec: NOW, ...extra,
});

t('live book: asks sorted cheapest first, whole 1,000 TAC lot at 192.1 on top', () => {
  const b = live();
  assert.equal(b.asks.length, 28);
  for (let i = 1; i < b.asks.length; i++) assert.ok(b.asks[i - 1].unit <= b.asks[i].unit);
  assert.equal(b.asks[0].kind, 'preauth');
  assert.equal(b.asks[0].amount, 100000000000n);
  assert.equal(b.asks[0].sats, 192100);
  assert.equal(fmtUnit(b.bestAsk), '192.10');
});

t('live book: the CLOSED 212 bid is not offered as fillable', () => {
  const b = live();
  assert.ok(!b.bids.some((x) => x.raw.bid_id === '618293870abc7bdaa37a3fcf47cb9f49'));
  assert.equal(b.excluded.bids.closed, 1);
  assert.equal(fmtUnit(b.bestBid), '209.99');
  assert.equal(b.overlap, true);
});

t('live book: no bid is watchtower-flagged in the snapshot, so a default market sell finds nothing', () => {
  const b = live();
  const p = planSell(b, { sellBase: parseAmount('10', 8) });
  assert.equal(p.fills.length, 0);
  assert.ok(p.manualAvailable > 0);
});

t('market buy under a whole lot: the 192,100-sat lot is skipped, never overspent', () => {
  const b = live();
  const p = planBuy(b, { spendSats: 50_000, maxUnit: 250 });
  assert.ok(p.sats <= 50_000);
  assert.ok(p.skipped.some((s) => s.reason === 'too-big' && s.ask.sats === 192100));
  for (const f of p.fills) assert.ok(f.unit <= 250);
  assert.equal(p.leftoverSats, 50_000 - p.sats);
  assert.equal(p.fills.reduce((s, f) => s + f.sats, 0), p.sats);
});

t('market buy big enough for the whole lot takes it first', () => {
  const b = live();
  const p = planBuy(b, { spendSats: 200_000, maxUnit: 250 });
  assert.equal(p.fills[0].ask.sats, 192100);
  assert.ok(p.sats <= 200_000);
});

t('market buy respects the max price', () => {
  const b = live();
  const p = planBuy(b, { spendSats: 5_000_000, maxUnit: 195 });
  for (const f of p.fills) assert.ok(f.unit <= 195);
  assert.ok(p.aboveMax > 0);
});

t('buy by amount: at least the amount, no whole lot more than double what is still needed', () => {
  const b = live();
  const want = parseAmount('150', 8);
  const p = planBuy(b, { receiveBase: want, maxUnit: 300 });
  assert.ok(p.amount >= want || p.shortBase > 0n);
  assert.ok(!p.fills.some((f) => f.ask.amount === 100000000000n), 'the 1,000 TAC lot is not forced on a 150 TAC buyer');
});

t('own offers are never routed; targeted and stale offers are hidden', () => {
  const me = fx.listings.find((l) => l.kind === 'preauth').seller_pubkey;
  const b = live({ myPubHex: me });
  const p = planBuy(b, { spendSats: 10_000_000, maxUnit: 1e9 });
  assert.ok(!p.fills.some((f) => f.ask.mine));
  const tgt = buildBook({ assetId: AID, decimals: 8, nowSec: NOW, bids: [], listings: [
    { kind: 'intent', asset_id: AID, intent_id: 'a', amount: '100000000', price_sats: 1000, expiry: NOW + 9999, created_at: NOW, intended_buyer_h160: 'ff'.repeat(20) },
    { kind: 'intent', asset_id: AID, intent_id: 'b', amount: '100000000', price_sats: 1000, expiry: NOW + 9999, created_at: NOW - 13 * 3600 },
    { kind: 'intent', asset_id: AID, intent_id: 'c', amount: '100000000', price_sats: 1000, expiry: NOW + 9999, created_at: NOW, claim: { expires_at: NOW + 60 } },
    { kind: 'intent', asset_id: AID, intent_id: 'd', amount: '100000000', price_sats: 1000, expiry: NOW + 30, created_at: NOW },
    { kind: 'intent', asset_id: AID, intent_id: 'e', amount: '100000000', price_sats: 1000, expiry: NOW + 9999, created_at: NOW, min_take_amount: '1000' },
    { kind: 'range', asset_id: AID },
  ] });
  assert.equal(tgt.asks.length, 0);
  assert.deepEqual(
    { r: tgt.excluded.asks.reserved, s: tgt.excluded.asks.stale, c: tgt.excluded.asks.claimed, x: tgt.excluded.asks.expired, d: tgt.excluded.asks.disabled, o: tgt.excluded.asks.otc },
    { r: 1, s: 1, c: 1, x: 1, d: 1, o: 1 },
  );
});

t('sell into bids (including ones needing the bidder online) uses the executor price scaling', () => {
  const b = live();
  const want = parseAmount('30', 8);
  const p = planSell(b, { sellBase: want, includeManual: true });
  assert.ok(p.fills.length > 0);
  assert.ok(p.amount <= want);
  for (const f of p.fills) {
    assert.equal(f.sats, Number((f.amount * BigInt(f.bid.priceSats)) / f.bid.fullAmount));
    assert.ok(f.sats >= DUST);
    if (f.bid.kind === 'bid-var') assert.ok(f.amount >= f.bid.minFill && f.amount <= f.bid.amount);
  }
  for (let i = 1; i < p.fills.length; i++) assert.ok(p.fills[i - 1].unit >= p.fills[i].unit);
  assert.equal(p.needsBidder, true);
});

t('watchtower bids route by default and rank ahead of equal-priced manual ones', () => {
  const bids = [
    { bid_id: 'm', amount: '1000000000', price_sats: 2000, expiry: NOW + 9999, created_at: NOW - 10, buyer_pubkey: '02aa' },
    { bid_id: 'w', amount: '1000000000', price_sats: 2000, expiry: NOW + 9999, created_at: NOW, buyer_pubkey: '02bb', watchtower: true },
  ];
  const b = buildBook({ assetId: AID, decimals: 8, nowSec: NOW, listings: [], bids });
  assert.equal(b.bids[0].raw.bid_id, 'w');
  const p = planSell(b, { sellBase: 1000000000n });
  assert.equal(p.fills.length, 1);
  assert.equal(p.fills[0].bid.raw.bid_id, 'w');
  assert.equal(p.needsBidder, false);
});

t('re-plans run unasked only inside the confirmed bounds', () => {
  const b = live();
  const p = planBuy(b, { spendSats: 50_000, maxUnit: 250 });
  assert.equal(withinBounds(p, { maxSats: 50_000, maxUnit: 250 }), true);
  assert.equal(withinBounds(p, { maxSats: p.sats - 1, maxUnit: 250 }), false);
  assert.equal(withinBounds(p, { maxSats: 50_000, maxUnit: p.worstUnit - 0.01 }), false);
  assert.equal(withinBounds({ ...p, fills: [] }, { maxSats: 1e9, maxUnit: 1e9 }), false);
});

t('excludeIds drops a failed offer from the re-plan', () => {
  const b = live();
  const p1 = planBuy(b, { spendSats: 50_000, maxUnit: 250 });
  const p2 = planBuy(b, { spendSats: 50_000, maxUnit: 250, excludeIds: new Set([p1.fills[0].ask.id]) });
  assert.ok(!p2.fills.some((f) => f.ask.id === p1.fills[0].ask.id));
});

t('a comma that is a decimal point is read as one, a comma between groups of three as a thousands separator', () => {
  // a keypad with a comma key: 0,05 TAC is five hundredths, not five
  assert.equal(parseAmount('0,05', 8), 5000000n);
  assert.equal(parseAmount('0,5', 8), 50000000n);
  assert.equal(parseAmount('1,5', 8), 150000000n);
  assert.equal(parseAmount('12,50', 8), 1250000000n);
  assert.equal(parseAmount('0,500', 8), 50000000n);                   // a leading zero is no group of three
  assert.equal(parseAmount('1.234,5', 8), 123450000000n);             // the other way round: a point between groups, a comma for the fraction
  // and what it always read as a thousands separator still is
  assert.equal(parseAmount('1,500', 8), 150000000000n);
  assert.equal(parseAmount('1,234.5', 8), 123450000000n);
  assert.equal(parseAmount('1,234,567', 8), 123456700000000n);
  assert.equal(parseNumber('152,5'), 152.5);
  assert.equal(parseNumber('1,500'), 1500);
  assert.ok(Number.isNaN(parseNumber('abc')) && Number.isNaN(parseNumber('')) && Number.isNaN(parseNumber(',')));
});

t('amount parsing and formatting round-trip', () => {
  assert.equal(parseAmount('1,234.5', 8), 123450000000n);
  assert.equal(parseAmount('0.000000019', 8), 1n);
  assert.equal(parseAmount('abc', 8), null);
  assert.equal(parseAmount('', 8), null);
  assert.equal(fmtAmount(123450000000n, 8), '1,234.5');
  assert.equal(fmtAmount(46142272157n, 8, 4), '461.4227');
  assert.equal(fmtUnit(194.03841347), '194.04');
  assert.equal(fmtUnit(0.198), '0.198');
  assert.equal(fmtUnit(12345.6), '12,346');
});

t('sats ↔ amount conversions round down', () => {
  const u = unitPrice(97862, 46142272157n, 8);
  const a = amountForSats(10_000, u, 8);
  assert.ok(satsForAmount(a, u, 8) <= 10_000);
  assert.equal(scaledSats(2936178115n, 57258, 29361781159n), Math.floor(2936178115 * 57258 / 29361781159));
});

t('ladder groups identical prints into one level with a count', () => {
  const b = live();
  const lv = ladderLevels(b.asks, 'ask');
  const total = lv.reduce((s, l) => s + l.count, 0);
  assert.equal(total, b.asks.length);
  const at212 = lv.filter((l) => l.flag === 'maker' && fmtUnit(l.unit) === '212.09');
  assert.equal(at212.length, 1);
  assert.equal(at212[0].count, 5);
});

t('listing shape: walk-away lots, each at least 2×dust', () => {
  const s = listingShape(parseAmount('100', 8), 194, 8);
  assert.equal(s.k, 7);
  assert.ok(s.perLotSats >= 2 * DUST);
  assert.ok(s.listedBase <= parseAmount('100', 8));
  const small = listingShape(parseAmount('6', 8), 194, 8);
  assert.equal(small.k, 1);
  assert.equal(listingShape(parseAmount('1', 8), 194, 8).k, 0);
});

t('bids in their last 30 minutes are not offered to sellers (the worker would refuse the claim)', () => {
  const mk = (id, ttl, extra = {}) => ({ bid_id: id, amount: '1000000000', price_sats: 2000, expiry: NOW + ttl, created_at: NOW, buyer_pubkey: '02' + id.repeat(33), ...extra });
  const b = buildBook({ assetId: AID, decimals: 8, nowSec: NOW, listings: [], bids: [mk('a', BID_CLAIM_WINDOW_SEC - 5), mk('b', BID_CLAIM_WINDOW_SEC + 60), mk('c', 120, { buyer_pubkey: '02me' })], myPubHex: '02me' });
  assert.deepEqual(b.bids.map((x) => x.raw.bid_id).sort(), ['b', 'c']);
});

t('re-route only on errors that mean the offer moved and nothing was committed', () => {
  assert.equal(isRerouteable('preauth sale not found — refresh listings'), true);
  assert.equal(isRerouteable('listing changed since you reviewed it — stale'), true);
  assert.equal(isRerouteable('claim POST returned 409'), true);
  assert.equal(isRerouteable('insufficient sats for commit (need ~14090 sats)'), false);
  assert.equal(isRerouteable('reveal rejected · Commit tx broadcast — 900 sats locked at ab:0'), false);
  assert.equal(isRerouteable(Object.assign(new Error('bid already claimed'), { noReroute: true })), false);
});

t('an offer whose coin is spent is left out of later quotes; one claimed for a while is not', () => {
  assert.equal(isSpentOffer('asset outpoint already spent'), true);
  assert.equal(isSpentOffer(new Error('preauth sale is stale')), true);
  assert.equal(isSpentOffer('preauth sale not found — refresh listings'), true);
  assert.equal(isSpentOffer('bid already claimed'), false);
  assert.equal(isSpentOffer('claim expired'), false);
  assert.equal(isSpentOffer(Object.assign(new Error('asset outpoint already spent'), { noReroute: true })), false);
});

t('a limit buy of N tokens never fills more than N from cheaper whole lots', () => {
  const now = NOW;
  const lot = (id, tac, sats) => ({ kind: 'preauth', asset_id: 'aa', sale_id: id, seller_pubkey: '02' + id, asset_opening: { amount: String(BigInt(tac) * 100000000n) }, min_price_sats: sats, expiry: now + 99999, created_at: now - 10 });
  const b = buildBook({ assetId: 'aa', decimals: 8, listings: [lot('a', 200, 1000), lot('b', 80, 600)], bids: [], nowSec: now });
  const want = parseAmount('100', 8);
  const total = satsForAmount(want, 10, 8);
  const loose = planBuy(b, { spendSats: total, maxUnit: 10 });
  assert.equal(loose.amount, 20000000000n);
  const capped = planBuy(b, { spendSats: total, maxBase: want, maxUnit: 10 });
  assert.ok(capped.amount <= want);
  assert.equal(capped.fills.length, 1);
  assert.equal(capped.fills[0].ask.raw.sale_id, 'b');
  assert.ok(capped.skipped.some((s) => s.ask.raw.sale_id === 'a' && s.reason === 'too-big'));
});

console.log(`btc-book: ${n} checks passed`);
