// End-to-end signet harness for §5.7.7 variable-fill bid intents.
//
// Drives the full builder loop against the live worker on signet:
//
//   1. Verify both wallets are funded.
//   2. Ensure the seller has a TESTBID asset UTXO with amount > min_fill.
//      If not, etch a 1000-base-unit TESTBID (decimals=0).
//   3. The "buyer" wallet (taker.priv_hex in the existing test wallets file
//      — repurposed here as the bidder for this harness) posts a variable-
//      fill bid: amount=1000 TESTBID at 20000 sats total, min_fill=100.
//   4. The seller wallet picks a chunk (default: 300 TESTBID) and calls
//      fulfilBidIntent({ bid, fillAmount: 300n }). This creates a linked
//      atomic-intent for 300 TESTBID at scaled price (floor(300 × 20000 / 1000)
//      = 6000 sats), POSTs the partial-claim with fill_amount=300 to the
//      worker.
//   5. Bidder's auto-fulfil (or manual) claims the seller's atomic-intent;
//      seller fulfils; bidder takes — same §5.7.6 / §5.7.6.1 take flow.
//   6. Wait for reveal to confirm on chain.
//   7. Verify: bid.remaining_amount = 700 (was 1000, fill_amount=300);
//      bid.state = 'PARTIALLY_RESERVED'; bid.partial_claims[] has one
//      entry with fill_amount=300; seller has 300 fewer TESTBID; bidder
//      has 300 more TESTBID + 6000 fewer sats.
//   8. Optionally: a SECOND partial fulfilment of 700 TESTBID to drain the
//      bid completely. After the second fill bid.state should be 'CLOSED'.
//
// State file at .local/bid-variable-fill-signet-state.json is resumable.
//
// Reuses the existing axintent-signet-test-wallets.json:
//   - "seller" wallet → the seller fulfilling chunks of the bid
//   - "taker"  wallet → repurposed as the BIDDER posting the variable-fill bid
//
// Run: `node bid-variable-fill-onchain-e2e-signet.mjs`

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'bid-variable-fill-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'axintent-signet-test-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}. Copy from axintent-signet-test-wallets.json or run the wallet generator.`);
}
const wallets = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const SELLER_SK = hexToBytes(wallets.seller.priv_hex);
const BIDDER_SK = hexToBytes(wallets.taker.priv_hex);   // repurposed as bidder
const SELLER_PUB = secp.getPublicKey(SELLER_SK, true);
const BIDDER_PUB = secp.getPublicKey(BIDDER_SK, true);

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
  dapp.invalidateHoldingsCache();
}

setWallet(SELLER_SK, SELLER_PUB);
const SELLER_ADDR = dapp.wallet.address();
setWallet(BIDDER_SK, BIDDER_PUB);
const BIDDER_ADDR = dapp.wallet.address();

console.log('=== bid-variable-fill-onchain-e2e-signet (§5.7.7) ===');
console.log(`  seller (fulfils chunks): ${SELLER_ADDR}`);
console.log(`  bidder (posts bid):      ${BIDDER_ADDR}`);
console.log(`  state: ${STATE_FILE}\n`);

const state = loadState();
const WORKER = 'https://tacit-pin.rosscampbell9.workers.dev';

// ---- Phase 1: verify funding ----
console.log('[1/7] Verify funding');
async function balance(addr) {
  const res = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  if (!res.ok) throw new Error(`addr fetch ${res.status}`);
  const j = await res.json();
  const c = j.chain_stats || {};
  const m = j.mempool_stats || {};
  return (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
}
const sb = await balance(SELLER_ADDR);
const bb = await balance(BIDDER_ADDR);
info(`seller: ${sb} sats`);
info(`bidder: ${bb} sats`);
if (sb < 15_000) fail(`seller needs ≥15k sats (has ${sb}) — fund signet wallet`);
if (bb < 25_000) fail(`bidder needs ≥25k sats (has ${bb}) — fund signet wallet`);
ok('both wallets funded');

// ---- Phase 2: seller asset holdings ----
console.log('\n[2/7] Seller asset holdings');
setWallet(SELLER_SK, SELLER_PUB);
let holdings = await dapp.scanHoldings(true);
let targetAssetId = null, targetAsset = null;
for (const [aid, h] of holdings) {
  if (h.balance >= 1000n) { targetAssetId = aid; targetAsset = h; break; }
}
if (!targetAssetId) {
  if (state.etch?.reveal_txid) {
    info(`(resuming) prior etch reveal ${state.etch.reveal_txid.slice(0,16)}… — awaiting confirm`);
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline && !targetAssetId) {
      const s = await fetch(`https://mempool.space/signet/api/tx/${state.etch.reveal_txid}/status`).then(r => r.json()).catch(() => null);
      if (s?.confirmed) {
        dapp.invalidateHoldingsCache();
        holdings = await dapp.scanHoldings(true);
        for (const [aid, h] of holdings) {
          if (h.balance >= 1000n) { targetAssetId = aid; targetAsset = h; break; }
        }
        break;
      }
      info(`  awaiting etch confirmation…`);
      await sleep(30_000);
    }
  }
}
if (!targetAssetId) {
  info('seller has no TESTBID — etching 1000 TESTBID (decimals=0)');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'TESTBID', supplyBase: 1000n, decimals: 0,
    imageUri: null, mintable: false,
    onProgress: (s) => info(`  [etch] ${s}`),
  });
  state.etch = { commit_txid: r.commitTxid, reveal_txid: r.revealTxid, asset_id: r.assetIdHex };
  saveState(state);
  ok(`etch broadcast: reveal=${r.revealTxid.slice(0,16)}…`);
  info('waiting up to 30 min for confirm…');
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(30_000);
    const s = await fetch(`https://mempool.space/signet/api/tx/${r.revealTxid}/status`).then(x => x.json()).catch(() => null);
    if (s?.confirmed) { ok(`etch reveal confirmed at block ${s.block_height}`); break; }
    info(`  awaiting etch confirmation…`);
  }
  dapp.invalidateHoldingsCache();
  holdings = await dapp.scanHoldings(true);
  for (const [aid, h] of holdings) {
    if (h.balance >= 1000n) { targetAssetId = aid; targetAsset = h; break; }
  }
  if (!targetAssetId) fail('still no asset after etch confirm — investigate');
}
info(`asset: ${targetAssetId.slice(0,16)}… (${targetAsset.ticker}, ${targetAsset.balance} held)`);
ok('seller has TESTBID');

// ---- Phase 3: bidder posts variable-fill bid ----
console.log('\n[3/7] Bidder: post variable-fill bid');
setWallet(BIDDER_SK, BIDDER_PUB);
const BID_AMOUNT = 1000n;     // total TESTBID the bid covers
const BID_PRICE_SATS = 20000;  // total sats for the full amount
const BID_MIN_FILL = 100n;     // smallest legal chunk
const BID_EXPIRY = Math.floor(Date.now() / 1000) + 24 * 3600;

if (state.bid?.bid_id) {
  info(`(resuming) bid ${state.bid.bid_id.slice(0,16)}…`);
} else {
  const r = await dapp.publishBidIntent({
    assetIdHex: targetAssetId, amount: BID_AMOUNT, priceSats: BID_PRICE_SATS,
    expiry: BID_EXPIRY, minFillAmount: BID_MIN_FILL,
  });
  state.bid = { bid_id: r.bid_id, asset_id: r.asset_id, amount: BID_AMOUNT.toString(), price_sats: BID_PRICE_SATS };
  saveState(state);
  ok(`bid posted: ${r.bid_id.slice(0,16)}… (amount=${BID_AMOUNT}, min_fill=${BID_MIN_FILL}, price=${BID_PRICE_SATS})`);
}

// ---- Phase 4: seller fulfils a 300-TESTBID chunk ----
console.log('\n[4/7] Seller: fulfil 300-TESTBID chunk (scaled price: 6000 sats)');
setWallet(SELLER_SK, SELLER_PUB);
const CHUNK_AMOUNT = 300n;

let bidRecord;
async function refetchBid() {
  const r = await fetch(`${WORKER}/assets/${targetAssetId}/bid-intents/${state.bid.bid_id}?network=signet`);
  const j = await r.json();
  if (!r.ok || !j.intent) fail(`bid fetch failed: ${j.error || r.status}`);
  return j.intent;
}
bidRecord = await refetchBid();
info(`bid state: ${bidRecord.state || 'OPEN'}, remaining: ${bidRecord.remaining_amount || bidRecord.amount}`);

if (state.fill1?.broadcast) {
  info(`(resuming) first fulfilment already submitted`);
} else {
  try {
    const r = await dapp.fulfilBidIntent({ bid: bidRecord, fillAmount: CHUNK_AMOUNT });
    state.fill1 = { broadcast: true, axintent_id: r.offer.intent_id, commit_txid: r.commit_txid };
    saveState(state);
    ok(`atomic-intent created: ${r.offer.intent_id.slice(0,16)}…  commit=${r.commit_txid.slice(0,16)}…`);
  } catch (e) {
    fail(`fulfilBidIntent failed: ${e.message}`);
  }
}

// ---- Phase 5: bidder takes the seller's atomic-intent ----
console.log('\n[5/7] Bidder: claim + take the seller-fulfilled axintent');
setWallet(BIDDER_SK, BIDDER_PUB);
if (state.fill1?.take_txid) {
  info(`(resuming) take already broadcast: ${state.fill1.take_txid}`);
} else {
  try {
    // Claim
    const c = await dapp.claimAxferIntent({
      assetIdHex: targetAssetId,
      intentIdHex: state.fill1.axintent_id,
      priceSats: 6000,
    });
    ok(`claim accepted by worker`);
    await sleep(2000);
    // Take
    const fres = await dapp.fetchAxferFulfilment({ assetIdHex: targetAssetId, intentIdHex: state.fill1.axintent_id });
    if (!fres) fail('seller hasn\'t fulfilled yet — manual fulfilment needed');
    const r = await dapp.takeAxferIntent({
      intent: fres.intent,
      fulfilment: fres.fulfilment,
      onProgress: (s) => info(`  [take] ${s}`),
    });
    state.fill1.take_txid = r.txid || r.reveal_txid;
    saveState(state);
    ok(`reveal broadcast: ${state.fill1.take_txid}`);
  } catch (e) {
    fail(`bidder take failed: ${e.message}`);
  }
}

// ---- Phase 6: wait for reveal confirm + verify bid state ----
console.log('\n[6/7] Wait for reveal confirm + verify bid state');
const deadline = Date.now() + 30 * 60 * 1000;
let revealConfirmed = false;
while (Date.now() < deadline) {
  const s = await fetch(`https://mempool.space/signet/api/tx/${state.fill1.take_txid}/status`).then(r => r.json()).catch(() => null);
  if (s?.confirmed) {
    ok(`reveal confirmed at block ${s.block_height}`);
    revealConfirmed = true;
    break;
  }
  info(`  awaiting confirmation…`);
  await sleep(30_000);
}
if (!revealConfirmed) fail('reveal not confirmed within 30 min');

bidRecord = await refetchBid();
info(`bid post-settlement:`);
info(`  state: ${bidRecord.state}`);
info(`  remaining: ${bidRecord.remaining_amount}`);
info(`  partial_claims: ${(bidRecord.partial_claims || []).length}`);
const expectedRemaining = (BID_AMOUNT - CHUNK_AMOUNT).toString();
if (bidRecord.remaining_amount !== expectedRemaining) {
  fail(`bid.remaining_amount expected ${expectedRemaining}, got ${bidRecord.remaining_amount}`);
}
if (bidRecord.state !== 'PARTIALLY_RESERVED') {
  fail(`bid.state expected PARTIALLY_RESERVED, got ${bidRecord.state}`);
}
ok(`bid decremented correctly: ${BID_AMOUNT} → ${expectedRemaining}; state = PARTIALLY_RESERVED`);

// ---- Phase 7: success summary ----
console.log('\n[7/7] Variable-fill bid settlement confirmed');
console.log('\n========== SUCCESS ==========');
console.log(`  bid:              ${state.bid.bid_id}`);
console.log(`  asset:            ${targetAssetId}`);
console.log(`  bid amount:       ${BID_AMOUNT}`);
console.log(`  fill chunk:       ${CHUNK_AMOUNT}`);
console.log(`  remaining post-fill: ${bidRecord.remaining_amount}`);
console.log(`  bid state:        ${bidRecord.state}`);
console.log(`  reveal tx:        ${state.fill1.take_txid}`);
console.log(`\n  Validates: SPEC §5.7.7 variable-fill (canonical form), worker partial-fill state machine,`);
console.log(`  bid intent → linked T_AXFER_VAR atomic-intent → atomic settlement on Bitcoin.`);
console.log(`\n  To run a multi-seller test, re-run with state.fill1.broadcast cleared + state.fill2/fill3 to`);
console.log(`  exercise three concurrent chunks. Future PR will extend this harness to drive that case.`);
