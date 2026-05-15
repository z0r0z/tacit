// Unit coverage for `fulfilBidIntentBatch` orchestration gates.
//
// The function's happy path reuses two heavily-exercised primitives
// (`buildAndBroadcastCXferMulti` for the split + `fulfilBidIntent` for
// each per-bid commit). Those are validated by the AMM / chunked-listing
// suites + signet e2e harnesses. The NEW code in this PR is purely
// orchestration: input validation, fallback gates, and the per-bid
// expansion of variable-fill scaling.
//
// This test pins the orchestration BEFORE it reaches the network — every
// case asserted here trips a synchronous throw or short-circuits before
// any fetch is issued. Happy-path coverage (one batched split tx + N
// commits) is left to the signet harness because the seller-side
// publishAxferIntent flow has 4-5 fetch mocks worth of moving parts that
// aren't worth re-implementing under jsdom.
//
// Run: `node bid-fulfil-batch.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// Wallet setup so ensurePrivkey() doesn't block the validation tests.
const SK = hexToBytes('0a'.repeat(32));
dapp.wallet.priv = SK;
dapp.wallet.pub = secp.getPublicKey(SK, true);

// Asserter: invokes fulfilBidIntentBatch with the given input, returns
// true iff it threw with a message matching `pattern`. Wrapping the
// promise lets us treat synchronous validation throws + async rejections
// uniformly.
async function assertThrowsMatching(input, pattern) {
  try {
    await dapp.fulfilBidIntentBatch(input);
    return false; // should have thrown
  } catch (e) {
    return pattern.test(String(e?.message || ''));
  }
}

// ============================================================================
// Section 1: export contract
// ============================================================================
console.log('\n§ Export contract:');
await test('fulfilBidIntentBatch is exported', () =>
  typeof dapp.fulfilBidIntentBatch === 'function');
await test('fulfilBidIntent is still exported (single-fill path unchanged)', () =>
  typeof dapp.fulfilBidIntent === 'function');

// ============================================================================
// Section 2: input validation gates (synchronous throws before any network)
// ============================================================================
console.log('\n§ Input validation gates:');
await test('throws on bids === undefined', () =>
  assertThrowsMatching({}, /bids required/));
await test('throws on bids === null', () =>
  assertThrowsMatching({ bids: null }, /bids required/));
await test('throws on bids === [] (empty array)', () =>
  assertThrowsMatching({ bids: [] }, /bids required/));
await test('throws on bids.length > 100 (DoS guard)', () => {
  const oversized = Array.from({ length: 101 }, (_, i) => ({
    bid: { bid_id: 'a'.repeat(32), asset_id: 'b'.repeat(64), amount: '1', price_sats: 1000 },
    fillAmount: null,
  }));
  return assertThrowsMatching({ bids: oversized }, /batch too large/);
});

// ============================================================================
// Section 3: per-bid expansion validation
//
// fulfilBidIntentBatch iterates each bid and validates structure BEFORE
// reaching scanHoldings / network. These tests pin each per-bid throw.
// ============================================================================
console.log('\n§ Per-bid expansion validation:');
const validAssetId = 'c'.repeat(64);
const mkBid = (overrides = {}) => ({
  bid_id: 'd'.repeat(32),
  asset_id: validAssetId,
  amount: '1000',
  price_sats: 50_000,
  expiry: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

await test('throws when a bid lacks bid_id', () =>
  assertThrowsMatching(
    { bids: [{ bid: { ...mkBid(), bid_id: undefined }, fillAmount: null },
             { bid: mkBid({ bid_id: 'e'.repeat(32) }), fillAmount: null }] },
    /bids\[0\] invalid/,
  ));
await test('throws when a bid lacks asset_id', () =>
  assertThrowsMatching(
    { bids: [{ bid: { ...mkBid(), asset_id: undefined }, fillAmount: null },
             { bid: mkBid(), fillAmount: null }] },
    /bids\[0\] invalid/,
  ));

// Variable-fill scaling validation. Variable bids carry min_fill_amount;
// the caller passes a specific fillAmount that must fall in
// [min_fill_amount, remaining_amount].
const mkVarBid = (overrides = {}) => mkBid({
  min_fill_amount: '100',
  remaining_amount: '1000',
  ...overrides,
});

await test('variable bid: throws when fillAmount < min_fill_amount', () =>
  assertThrowsMatching(
    {
      bids: [
        { bid: mkVarBid(), fillAmount: 50 },
        { bid: mkBid({ bid_id: 'f'.repeat(32) }), fillAmount: null },
      ],
    },
    /below min_fill_amount/,
  ));
await test('variable bid: throws when fillAmount > remaining_amount', () =>
  assertThrowsMatching(
    {
      bids: [
        { bid: mkVarBid(), fillAmount: 2000 },
        { bid: mkBid({ bid_id: 'a1'.repeat(16) }), fillAmount: null },
      ],
    },
    /exceeds remaining_amount/,
  ));
await test('whole-bid: throws when fillAmount differs from bid.amount', () =>
  assertThrowsMatching(
    {
      bids: [
        { bid: mkBid(), fillAmount: 999 },
        { bid: mkBid({ bid_id: 'a2'.repeat(16) }), fillAmount: null },
      ],
    },
    /whole-bid: fillAmount must equal bid\.amount/,
  ));

// ============================================================================
// Section 4: scanHoldings fall-through
//
// Past pre-bid validation, fulfilBidIntentBatch calls scanHoldings to
// resolve the seller's UTXO set. With no network setup in this minimal
// scaffold scanHoldings will fail-fast — we just confirm the function
// reaches that stage (a different error class from the synchronous
// validation throws above) for a structurally-valid batch.
//
// This isn't a happy-path test; it's a "the orchestrator didn't crash on
// valid input before reaching the network" check.
// ============================================================================
console.log('\n§ Validation passes for structurally-valid input:');
await test('valid 2-bid batch progresses past pre-validation (different error class)', async () => {
  try {
    await dapp.fulfilBidIntentBatch({
      bids: [
        { bid: mkBid(), fillAmount: null },
        { bid: mkBid({ bid_id: 'a3'.repeat(16) }), fillAmount: null },
      ],
    });
    // If somehow it succeeded (it shouldn't without a worker), that's
    // a different kind of failure — flag it.
    return false;
  } catch (e) {
    const msg = String(e?.message || '');
    // Validation errors we just tested:
    if (/bids required|batch too large|bids\[\d+\] invalid|below min_fill_amount|exceeds remaining_amount|whole-bid/.test(msg)) {
      return false; // we wanted to GO PAST these
    }
    // Anything else — including "worker disabled", a scanHoldings throw,
    // a fetch 404, etc. — confirms we reached the network/holdings
    // resolution stage, which is what we're asserting.
    return true;
  }
});

// ============================================================================
// Section 5: N=1 fast path
//
// fulfilBidIntentBatch with bids.length===1 delegates to fulfilBidIntent
// directly. We can't test the delegation outcome without network mocks,
// but we can confirm the function accepts N=1 input shape without
// throwing on the validation gates above (it would NEVER reach the
// "batch too large" / mixed-asset gates because N=1 short-circuits).
// ============================================================================
console.log('\n§ N=1 fast path shape:');
await test('N=1 input shape accepted (delegation path entered)', async () => {
  try {
    await dapp.fulfilBidIntentBatch({
      bids: [{ bid: mkBid(), fillAmount: null }],
    });
    return false;
  } catch (e) {
    const msg = String(e?.message || '');
    // The N=1 fast path delegates to fulfilBidIntent. The error MUST be
    // from inside fulfilBidIntent (e.g. scanHoldings / worker disabled
    // / network), NOT from a "batch too large" or pre-validation
    // throw inside the batch entrypoint itself.
    if (/batch too large|bids\[\d+\] invalid|below min_fill_amount|exceeds remaining_amount|whole-bid/.test(msg)) {
      return false; // pre-validation tripped — N=1 should have skipped that
    }
    return true;
  }
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
