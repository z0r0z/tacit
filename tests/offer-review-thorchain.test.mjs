// Two confirm-before-send checks in dapp/tacit.js.
//
// atomicOfferReview: the take-offer confirm shows the asset's ticker and decimals from this wallet's record of its
// on-chain metadata, refuses an offer naming others, shows an unknown asset by its id in base units, and calls verified
// only what was checked.
//
// thorchainQuoteProblem: a THORChain ETH→BTC quote is used only when its memo swaps to L1 BTC paying this wallet's
// address and it has not expired.
//
// Run: `node tests/offer-review-thorchain.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.fetch = async () => { throw new Error('offline'); };
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

const T = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};

const AID = 'f0'.repeat(32);
const offer = (extra = {}) => ({
  asset_id: AID, amount: '1250000000', price_sats: 5000, maker_address: 'bc1qmaker',
  expiry: Math.floor(Date.now() / 1000) + 3600, ...extra,
});

console.log('atomicOfferReview');
{
  const r = T.atomicOfferReview(offer({ ticker: 'FAKE', decimals: 2 }));
  ok('an unknown asset is shown by its id, the amount in base units', !r.error && r.text.includes(`Asset:    ${AID}`) && r.text.includes('Buying:   1250000000 base units'));
  ok('the maker\'s ticker is not shown for an unknown asset', !r.text.includes('FAKE') && r.ticker === '' && r.decimals === 0);
  ok('nothing is called verified', !/verified/i.test(r.text));
}
T.registerAsset({ assetIdHex: AID, ticker: 'TAC', decimals: 8 });
{
  const r = T.atomicOfferReview(offer({ ticker: 'TAC', decimals: 8 }));
  ok('a known asset shows its recorded ticker and decimals', !r.error && r.text.includes('Buying:   12.5 TAC') && r.ticker === 'TAC' && r.decimals === 8);
  ok('the check list names the registry as the ticker\'s source', /ticker and decimals are this wallet's on-chain record/.test(r.text));
  const r2 = T.atomicOfferReview(offer());
  ok('an offer that names no ticker reads from the record', !r2.error && r2.text.includes('12.5 TAC'));
  const bad = T.atomicOfferReview(offer({ ticker: 'TACC', decimals: 8 }));
  ok('an offer naming another ticker is refused', /offer rejected: .*TACC.*on-chain record is TAC.*Nothing was sent/.test(bad.error || ''));
  const bad2 = T.atomicOfferReview(offer({ ticker: 'TAC', decimals: 2 }));
  ok('an offer naming other decimals is refused', /2 decimals.*TAC with 8.*Nothing was sent/.test(bad2.error || ''));
}

console.log('\nthorchainQuoteProblem');
{
  const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const now = 1_800_000_000, later = now + 600;
  const q = (memo, expiry = later) => ({ memo, expiry });
  ok('=:b:<addr> is used', T.thorchainQuoteProblem(q(`=:b:${addr}:0/1/0`), addr, now) === null);
  ok('SWAP:BTC.BTC:<addr> is used', T.thorchainQuoteProblem(q(`SWAP:BTC.BTC:${addr}:12345`), addr, now) === null);
  ok('a refund address after the destination is allowed', T.thorchainQuoteProblem(q(`=:b:${addr}/0xabc:0/1/0`), addr, now) === null);
  ok('another destination is refused', /not this wallet's/.test(T.thorchainQuoteProblem(q('=:b:bc1qsomeoneelse:0/1/0'), addr, now) || ''));
  ok('a swap to another asset is refused', /not a swap to Bitcoin/.test(T.thorchainQuoteProblem(q(`=:ETH.ETH:${addr}`), addr, now) || ''));
  ok('a memo that is not a swap is refused', /not a swap to Bitcoin/.test(T.thorchainQuoteProblem(q(`+:BTC.BTC:${addr}`), addr, now) || ''));
  ok('an expired quote is refused', /expired/.test(T.thorchainQuoteProblem(q(`=:b:${addr}`, now - 1), addr, now) || ''));
  ok('a quote with no expiry is refused', /expired/.test(T.thorchainQuoteProblem({ memo: `=:b:${addr}` }, addr, now) || ''));
  ok('every refusal says nothing was sent', /nothing was sent/i.test(T.thorchainQuoteProblem(q('=:b:x'), addr, now)));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
