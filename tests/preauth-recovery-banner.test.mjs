// Recovery banner rendering — single-take vs batched commit records.
//
// When a preauth-take's commit broadcasts but the reveal fails, the
// dapp persists a recovery record under `tacit-preauth-take-pending-v1:
// <network>` keyed by commit_txid. The Activity tab renders a banner
// listing every pending record with a Recover button.
//
// Single-take records have flat fields (sale_id, amount, ticker, …).
// Batched records (from takePreauthSaleBatch) add a `batch[]` array
// carrying per-sale recovery hints — the schema is a superset, and the
// banner needs to distinguish them so users see "5 sales" instead of
// thinking a batched failure was a single-take.
//
// This test pins the banner-rendering behavior for both record kinds:
//   - both kinds render a Recover button bound to the correct
//     commit_txid (the script-path-spend recovery is identical
//     regardless of record kind),
//   - only the batched record carries the "batch · N sales" tag,
//   - the sats-locked + ticker + amount display surfaces correctly
//     for both,
//   - empty record list returns empty string (no banner spam).
//
// Run: `node preauth-recovery-banner.test.mjs`

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

// Wallet setup (recordPreauthTakePending validates record format only,
// not key ownership; this is just to keep `wallet.priv` set so any path
// reading it doesn't blow up).
const SK = hexToBytes('0e'.repeat(32));
dapp.wallet.priv = SK;
dapp.wallet.pub = secp.getPublicKey(SK, true);

// Clear any pre-existing pendings so we start from a known state.
const _initial = dapp.listPreauthTakePendings();
for (const p of _initial) dapp.forgetPreauthTakePending(p.commitTxidHex);

// ============================================================================
// Empty state — no banner when no records exist.
// ============================================================================
console.log('\n§ Empty state:');
await test('empty banner returns empty string', () =>
  dapp._renderPreauthRecoveryBannerHtml() === '');

// ============================================================================
// Single-take recovery record (legacy schema, no `batch` field).
// ============================================================================
console.log('\n§ Single-take record rendering:');
const COMMIT_SINGLE = '11'.repeat(32);
dapp.recordPreauthTakePending(COMMIT_SINGLE, {
  sale_id: 'aa'.repeat(16),
  asset_id: 'b1'.repeat(32),
  amount: '1000',
  ticker: 'TAC',
  decimals: 0,
  commit_value: 4_500,
  envelope_script_hex: '20' + 'cc'.repeat(32) + 'ac0063',  // sentinel; only length needed
  control_block_hex: 'c0' + 'dd'.repeat(32),
  recip_blinding_hex: 'ee'.repeat(32),
});

let singleHtml;
await test('single-take banner renders', () => {
  singleHtml = dapp._renderPreauthRecoveryBannerHtml();
  return typeof singleHtml === 'string' && singleHtml.length > 0;
});
await test('single-take banner references the commit_txid', () =>
  singleHtml.includes(COMMIT_SINGLE));
await test('single-take banner shows the locked sats amount', () =>
  singleHtml.includes('4,500 sats'));
await test('single-take banner shows the attempted asset amount + ticker', () =>
  /attempted 1,?000 TAC/.test(singleHtml));
await test('single-take banner Recover button is wired with commit_txid', () =>
  singleHtml.includes(`data-act="preauth-recover" data-commit-txid="${COMMIT_SINGLE}"`));
await test('single-take banner does NOT show batch tag', () =>
  !/batch · \d+ sales/.test(singleHtml));

// ============================================================================
// Batched recovery record (5-sale batch under one commit_txid).
// ============================================================================
console.log('\n§ Batched record rendering:');
const COMMIT_BATCH = '22'.repeat(32);
dapp.recordPreauthTakePending(COMMIT_BATCH, {
  sale_id: 'a1'.repeat(16),
  asset_id: 'b2'.repeat(32),
  amount: '6250',  // Σ of all 5 batched amounts
  ticker: 'TAC',
  decimals: 0,
  commit_value: 8_200,
  envelope_script_hex: '20' + 'aa'.repeat(32) + 'ac0063',
  control_block_hex: 'c0' + 'bb'.repeat(32),
  recip_blinding_hex: 'ff'.repeat(32),
  batch: [
    { sale_id: 'a1'.repeat(16), amount: '1000', min_price_sats: 30_000 },
    { sale_id: 'a2'.repeat(16), amount: '1250', min_price_sats: 35_000 },
    { sale_id: 'a3'.repeat(16), amount: '1500', min_price_sats: 40_000 },
    { sale_id: 'a4'.repeat(16), amount: '1000', min_price_sats: 32_000 },
    { sale_id: 'a5'.repeat(16), amount: '1500', min_price_sats: 38_000 },
  ],
});

let bothHtml;
await test('both records render together (banner shows 2 rows)', () => {
  bothHtml = dapp._renderPreauthRecoveryBannerHtml();
  return bothHtml.includes(COMMIT_SINGLE) && bothHtml.includes(COMMIT_BATCH);
});
await test('header pluralizes correctly: "2 stranded preauth-take commits"', () =>
  /2 stranded preauth-take commits\b/.test(bothHtml));
await test('batched record shows "batch · 5 sales" tag', () =>
  /batch · 5 sales/.test(bothHtml));
await test('batched record shows aggregate amount (6,250 TAC)', () =>
  /attempted 6,?250 TAC/.test(bothHtml));
await test('batched record shows aggregate commit value (8,200 sats)', () =>
  bothHtml.includes('8,200 sats'));
await test('batched record Recover button wired to its own commit_txid', () =>
  bothHtml.includes(`data-act="preauth-recover" data-commit-txid="${COMMIT_BATCH}"`));
await test('single-take row still does NOT show batch tag', () => {
  // Slice the HTML around the single-take row by its data-recovery-row anchor
  // and confirm no "batch ·" appears within that slice.
  const idx = bothHtml.indexOf(`data-recovery-row="${COMMIT_SINGLE}"`);
  if (idx < 0) return false;
  // Look at the ~600 chars following the anchor — long enough to span
  // one rendered row's HTML.
  const slice = bothHtml.slice(idx, idx + 600);
  return !/batch · \d+ sales/.test(slice);
});

// ============================================================================
// Forget — both record kinds drop cleanly via the same forget call.
// ============================================================================
console.log('\n§ Forget round-trip:');
await test('forget on the batched record drops it from listings', () => {
  dapp.forgetPreauthTakePending(COMMIT_BATCH);
  const remaining = dapp.listPreauthTakePendings();
  return remaining.length === 1 && remaining[0].commitTxidHex === COMMIT_SINGLE;
});
await test('after forgetting batched, banner only references the single-take', () => {
  const h = dapp._renderPreauthRecoveryBannerHtml();
  return h.includes(COMMIT_SINGLE) && !h.includes(COMMIT_BATCH);
});
await test('forget on the single-take record empties the banner', () => {
  dapp.forgetPreauthTakePending(COMMIT_SINGLE);
  return dapp._renderPreauthRecoveryBannerHtml() === '';
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
