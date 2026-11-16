// The bound market view (dapp/trade/bound.js) over a mocked tacit.js: the book's bound bids with "Sell into this bid" (which posts the
// holder's bound offer for that bid, after the wallet is opened), "Place a bid" (a bound watchtower bid, its amount in the token's own
// decimals), and the bought notes with "Move to Ethereum". Offline, jsdom.
//   node tests/trade-bound.test.mjs
import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body><div id="box"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
const { mountBoundMarket, fmtUnits, parseUnits } = await import('../dapp/trade/bound.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const tick = () => new Promise((r) => setTimeout(r, 20));
const ID = '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';
const calls = { offers: [], bids: [], homes: [], unlocks: 0 }, notes = [];
const T = {
  async browseBoundBids(id) { return id === ID ? [{ bid_id: 'cd'.repeat(16), bound: true, buyer_xonly: '11'.repeat(32), buyer_pubkey: '02' + '22'.repeat(32), amount: '2000000000', remaining_amount: '2000000000', price_sats: 9000 }] : []; },
  async publishBoundOffer(a) { calls.offers.push(a); return { id: 'ff'.repeat(32), amount: 2000000000n, priceSats: 9000 }; },
  async placeBoundBid(a) { calls.bids.push(a); return { bid_id: 'ab'.repeat(16) }; },
  async boughtBoundNotes() { return [{ assetIdHex: ID, txid: 'ee'.repeat(32), vout: 0, amount: 500000000n, blinding: 7n, bidPub: '02' + '33'.repeat(32) }, { assetIdHex: 'aa'.repeat(32), txid: 'dd'.repeat(32), vout: 0, amount: 1n }]; },
  async moveBoundNoteHome(n) { calls.homes.push(n); return { txHash: '0x1' }; },
  // the bids the watchtower holds for this wallet: one of this token (listed), one kept on this device, one cancelled, one of another token (none listed)
  async listWatchtowerBids() {
    const all = [{ bid_id: 'ef'.repeat(16), kind: 'bound', status: 'active', self_take: false, asset_id: ID, bid_amount_base: '10000000', filled_base: '0', bid_price_sats: 600 },
      { bid_id: '12'.repeat(16), kind: 'bound', status: 'active', self_take: true, asset_id: ID, bid_amount_base: '100000000', filled_base: '0', bid_price_sats: 800 },
      { bid_id: '34'.repeat(16), kind: 'bound', status: 'cancelled', self_take: false, asset_id: ID, bid_amount_base: '100000000', filled_base: '0', bid_price_sats: 800 },
      { bid_id: '56'.repeat(16), kind: 'bound', status: 'active', self_take: false, asset_id: 'aa'.repeat(32), bid_amount_base: '100000000', filled_base: '0', bid_price_sats: 800 }];
    return all.filter((b) => !(calls.cancels || []).includes(b.bid_id));
  },
  async cancelWatchtowerBid(id) { calls.cancels = [...(calls.cancels || []), id]; return { ok: true }; },
};
ok(fmtUnits(2000000000n, 8) === '20' && fmtUnits(123456789n, 8) === '1.23456789' && parseUnits('20', 8) === 2000000000n && parseUnits('0.5', 6) === 500000n && parseUnits('1.234567891', 8) === null, 'amounts read and write in the token\'s own decimals');

const box = document.getElementById('box');
const ctl = mountBoundMarket(box, { T, asset: { id: ID, ticker: 'SPX', decimals: 8 }, unlock: async () => { calls.unlocks++; }, notify: (m, k) => notes.push([k, m]) });
await tick(); await tick();
const text = box.textContent.replace(/\s+/g, ' ');
ok(/Bids for SPX/.test(text) && /20 SPX/.test(text) && /450 sats each/.test(text), `the bound bid shows its amount and price per token (${text.slice(0, 90)})`);
ok(box.querySelectorAll('[data-home]').length === 1 && /5 SPX/.test(text), 'only this token\'s bought notes are listed, each with Move to Ethereum');
ok(/Your bids/.test(text) && /0\.1 SPX wanted/.test(text) && /for 600 sats/.test(text) && /waiting for a seller/.test(text), 'a bid placed through the watchtower is listed under Your bids, with what it wants, its price and that it waits for a seller');
ok(box.querySelectorAll('[data-wclose]').length === 1, 'only an active bound bid of this token that is not kept on this device is listed there (a self-take, a cancelled or another token\'s bid is not)');

box.querySelector('[data-sell]').click();
await tick(); await tick();
ok(calls.unlocks === 1 && calls.offers.length === 1 && calls.offers[0].assetIdHex === ID && calls.offers[0].bid.bid_id === 'cd'.repeat(16), 'Sell into this bid opens the wallet and posts the holder\'s bound offer for that bid');
ok(notes.some(([k, m]) => k === 'ok' && /Offered 20 SPX for 9,000 sats/.test(m)), 'and says what was offered, and that the watchtower completes it');

ok(calls.offers[0].part === undefined, 'with no amount entered the offer is the note as it fits (no part named)');
for (let i = 0; i < 6; i++) await tick();
box.querySelector('[data-part]').value = '1.5';
box.querySelector('[data-sell]').click();
await tick(); await tick();
ok(calls.offers.length === 2 && calls.offers[1].part === 150000000n, 'an amount entered on the row sells that part, in the token\'s decimals');
for (let i = 0; i < 6; i++) await tick();
box.querySelector('[data-part]').value = 'abc';
box.querySelector('[data-sell]').click();
await tick(); await tick();
ok(calls.offers.length === 2 && notes.some(([k, m]) => k === 'error' && /Enter an amount of SPX/.test(m)), 'an amount that does not read is refused before anything is offered');
for (let i = 0; i < 6; i++) await tick();   // the sell's refresh repaints the view first
box.querySelector('#bb-amt').value = '2.5'; box.querySelector('#bb-sats').value = '1200';
box.querySelector('[data-bid-place]').click();
await tick(); await tick();
ok(calls.bids.length === 1 && calls.bids[0].amount === 250000000n && calls.bids[0].priceSats === 1200 && calls.bids[0].decimals === 8, 'Place a bid places a bound watchtower bid in the token\'s decimals');
for (let i = 0; i < 6; i++) await tick();
box.querySelector('#bb-amt').value = 'x';
box.querySelector('[data-bid-place]').click();
await tick(); await tick();
ok(calls.bids.length === 1 && notes.some(([k, m]) => k === 'error' && /Enter an amount/.test(m)), 'an amount that does not read is said, and nothing is placed');
ok(!('feeBudgetSats' in calls.bids[0]), 'a bid with no fee budget entered leaves it to the engine (10,000 sats)');
for (let i = 0; i < 6; i++) await tick();
box.querySelector('#bb-amt').value = '0.1'; box.querySelector('#bb-sats').value = '600'; box.querySelector('#bb-fee').value = '500';
box.querySelector('[data-bid-place]').click();
await tick(); await tick();
ok(calls.bids.length === 1 && notes.some(([k, m]) => k === 'error' && /fee budget/.test(m)), 'a fee budget under 2,000 sats is said, and nothing is placed');
for (let i = 0; i < 6; i++) await tick();
box.querySelector('#bb-amt').value = '0.1'; box.querySelector('#bb-sats').value = '600'; box.querySelector('#bb-fee').value = '3000';
box.querySelector('[data-bid-place]').click();
await tick(); await tick();
ok(calls.bids.length === 2 && calls.bids[1].feeBudgetSats === 3000 && calls.bids[1].amount === 10000000n && calls.bids[1].priceSats === 600, 'a fee budget entered is the one the bid is placed with');
ok(/10,000 sats unless you enter another/.test(box.textContent.replace(/\s+/g, ' ')), 'the form says what a bid sets aside: its price and a fee budget, and that the rest comes back');

for (let i = 0; i < 6; i++) await tick();
box.querySelector('[data-wclose]').click();
await tick(); await tick();
ok(calls.cancels?.[0] === 'ef'.repeat(16) && notes.some(([k, m]) => k === 'ok' && /Bid closed\. What it set aside is returned/.test(m)), 'Close bid cancels that bid at the watchtower and says its sats come back');
for (let i = 0; i < 6; i++) await tick();
ok(box.querySelectorAll('[data-wclose]').length === 0, 'and it is gone from the list');
box.querySelector('[data-home]').click();
await tick(); await tick();
ok(calls.homes.length === 1 && calls.homes[0].txid === 'ee'.repeat(32), 'Move to Ethereum moves that bought note home by the fast lane');
ctl.destroy();
ok(!box.querySelector('.bound-mkt'), 'destroy removes the view');

// a bid kept on this device: placed with selfTake, its offers listed checked or not, Take on a checked one, Close returns its sats
const box2 = document.createElement('div'); document.body.append(box2);
const OFF = { id: '77'.repeat(32), buyerXonly: '11'.repeat(32) };
const T2 = { ...T,
  async myBoundBids(id) { return id === ID ? [{ bid_id: 'cd'.repeat(16), status: 'active', amount: 100000000n, filled: 20000000n, priceSats: 800, walletSats: 3600,
    offers: [{ offer: OFF, amount: 80000000n, priceSats: 600, checked: true }, { offer: { id: '88'.repeat(32) }, amount: 1n, priceSats: 546, checked: false, why: 'the bid wallet coin it was signed against is spent' }] }] : []; },
  async takeMyBoundOffer(o) { calls.takes = [...(calls.takes || []), o]; return { revealTxid: 'd6ba6529'.padEnd(64, '0') }; },
  async closeMyBoundBid(b) { calls.closes = [...(calls.closes || []), b]; return { swept: 2900 }; },
};
mountBoundMarket(box2, { T: T2, asset: { id: ID, ticker: 'SPX', decimals: 8 }, unlock: async () => {}, notify: (m, k) => notes.push([k, m]) });
await tick(); await tick();
const t2 = box2.textContent.replace(/\s+/g, ' ');
ok(/Your bids you take yourself/.test(t2) && /0\.8 SPX/.test(t2) && /for 600 sats/.test(t2) && /checked/.test(t2) && /0\.8 SPX wanted/.test(t2) && /3,600 sats in its wallet/.test(t2), `a self-take bid lists what it still wants, its wallet's sats and its checked offer (${t2.slice(-260)})`);
ok(box2.querySelectorAll('[data-take]').length === 1 && /does not check: the bid wallet coin/.test(t2), 'only a checked offer can be taken; one that does not check says why');
box2.querySelector('#bb-amt').value = '1'; box2.querySelector('#bb-sats').value = '800'; box2.querySelector('#bb-self').checked = true;
box2.querySelector('[data-bid-place]').click();
await tick(); await tick();
ok(calls.bids.at(-1).selfTake === true, 'Place a bid with "Take offers myself" places a self-take bid');
for (let i = 0; i < 6; i++) await tick();
box2.querySelector('[data-take]').click();
await tick(); await tick();
ok(calls.takes?.length === 1 && calls.takes[0].id === OFF.id && notes.some(([k, m]) => k === 'ok' && /Took 0\.8 SPX for 600 sats/.test(m)), 'Take takes that offer with this wallet\'s own bid key');
for (let i = 0; i < 6; i++) await tick();
box2.querySelector('[data-close]').click();
await tick(); await tick();
ok(calls.closes?.[0] === 'cd'.repeat(16) && notes.some(([k, m]) => /2,900 sats are on their way back/.test(m)), 'Close bid takes it off the book and returns its wallet\'s sats');
// the offer's notes are read whatever the page registered: /trade/ never registers a runtime token, so a note held at the Bitcoin address
// (a part sale's change, a bound send's arrival) must still be found
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
  const pub = src.slice(src.indexOf('async function publishBoundOffer('), src.indexOf('async function listBoundOffers('));
  ok(/bridgedHeldNotes\(aid, \{ anyBridged: true \}\)/.test(pub) && /async function bridgedHeldNotes\(assetIdHex, \{ anyBridged = false \} = \{\}\)/.test(src), 'a bound offer reads the notes held at the Bitcoin address without the page\'s token registry');
}
console.log(`\n${pass} trade-bound checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
