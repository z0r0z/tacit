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
};
ok(fmtUnits(2000000000n, 8) === '20' && fmtUnits(123456789n, 8) === '1.23456789' && parseUnits('20', 8) === 2000000000n && parseUnits('0.5', 6) === 500000n && parseUnits('1.234567891', 8) === null, 'amounts read and write in the token\'s own decimals');

const box = document.getElementById('box');
const ctl = mountBoundMarket(box, { T, asset: { id: ID, ticker: 'SPX', decimals: 8 }, unlock: async () => { calls.unlocks++; }, notify: (m, k) => notes.push([k, m]) });
await tick(); await tick();
const text = box.textContent.replace(/\s+/g, ' ');
ok(/Bids for SPX/.test(text) && /20 SPX/.test(text) && /450 sats each/.test(text), `the bound bid shows its amount and price per token (${text.slice(0, 90)})`);
ok(box.querySelectorAll('[data-home]').length === 1 && /5 SPX/.test(text), 'only this token\'s bought notes are listed, each with Move to Ethereum');

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

for (let i = 0; i < 6; i++) await tick();
box.querySelector('[data-home]').click();
await tick(); await tick();
ok(calls.homes.length === 1 && calls.homes[0].txid === 'ee'.repeat(32), 'Move to Ethereum moves that bought note home by the fast lane');
ctl.destroy();
ok(!box.querySelector('.bound-mkt'), 'destroy removes the view');
console.log(`\n${pass} trade-bound checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
