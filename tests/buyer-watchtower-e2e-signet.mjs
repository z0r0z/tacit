// End-to-end signet harness for the buyer-side watchtower.
//
// Proves the full walk-away loop with the REAL daemon binary doing the buyer
// side:
//
//   1. Verify both wallets funded (bid wallet = buyer, seller wallet = seller).
//   2. Seller holds a TESTBID asset (etch 1000 TESTBID, decimals=0, if needed).
//   3. Buyer posts a variable-fill bid-intent (amount=1000 @ 20000 sats, min_fill=100).
//   4. Seller fulfils a 300-unit chunk (fulfilBidIntent) → linked atomic-intent
//      targeting the buyer (6000 sats scaled price).
//   5. WATCHTOWER does the buyer side: spawn `buyer-watchtower.mjs --once`,
//      which discovers the targeting intent, claims it, and polls for the
//      seller's fulfilment. Meanwhile this harness (as seller) fulfils the
//      atomic-intent; the daemon then verifies + takes (SIGHASH_ALL) + broadcasts.
//   6. Wait for the reveal to confirm; verify the buyer received 300 TESTBID and
//      the bid decremented to 700 / PARTIALLY_RESERVED.
//
// The daemon runs in its own process with ONLY the bid wallet key — this is the
// faithful test (the binary, not a re-implementation). Coordination is via the
// worker (the daemon's claim is visible here; this harness's fulfilment is
// visible to the daemon), so no shared state is needed.
//
// Wallets: .local/watchtower-e2e-wallets.json  ({ bid, seller } priv_hex)
// State:   .local/watchtower-e2e-state.json    (resumable for the slow setup phases)
//
// Run: `node tests/buyer-watchtower-e2e-signet.mjs`

import { JSDOM } from 'jsdom';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
try { globalThis.navigator = dom.window.navigator; } catch { /* Node 21+ read-only built-in navigator — keep it */ }
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
const STATE_FILE = path.join(STATE_DIR, 'watchtower-e2e-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'watchtower-e2e-wallets.json');
const DAEMON = path.join(__dirname, '..', 'fulfiller', 'buyer-watchtower.mjs');
const DAEMON_CFG = path.join(STATE_DIR, '_wt-daemon-config.json');
const WORKER = 'https://api.tacit.finance';

const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };
const fail = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const info = (m) => console.log(`  ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(WALLET_FILE)) fail(`wallet file missing: ${WALLET_FILE}`);
const wallets = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const BID_SK = hexToBytes(wallets.bid.priv_hex);
const SELLER_SK = hexToBytes(wallets.seller.priv_hex);
const BID_PUB = secp.getPublicKey(BID_SK, true);
const SELLER_PUB = secp.getPublicKey(SELLER_SK, true);

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
  dapp.invalidateHoldingsCache();
  try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(pub), '1'); } catch {}
}
setWallet(SELLER_SK, SELLER_PUB); const SELLER_ADDR = dapp.wallet.address();
setWallet(BID_SK, BID_PUB);       const BID_ADDR = dapp.wallet.address();

console.log('=== buyer-watchtower-e2e-signet ===');
console.log(`  buyer/bid wallet:   ${BID_ADDR}`);
console.log(`  seller wallet:      ${SELLER_ADDR}`);
console.log(`  daemon:             ${DAEMON}`);
console.log(`  state:              ${STATE_FILE}\n`);

const state = loadState();

// ---- Phase 1: funding ----
console.log('[1/6] Verify funding');
async function balance(addr) {
  const r = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  if (!r.ok) throw new Error(`addr fetch ${r.status}`);
  const j = await r.json();
  const c = j.chain_stats || {}, mp = j.mempool_stats || {};
  return (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (mp.funded_txo_sum || 0) - (mp.spent_txo_sum || 0);
}
const bb = await balance(BID_ADDR);
const sb = await balance(SELLER_ADDR);
info(`bid wallet:   ${bb} sats`);
info(`seller:       ${sb} sats`);
if (bb < 15_000) fail(`bid wallet needs ≥15k sats (has ${bb}) — fund ${BID_ADDR}`);
if (sb < 15_000) fail(`seller needs ≥15k sats (has ${sb}) — fund ${SELLER_ADDR}`);
ok('both wallets funded');

// ---- Phase 2: seller asset ----
console.log('\n[2/6] Seller asset holdings');
setWallet(SELLER_SK, SELLER_PUB);
let assetId = null, asset = null;
async function findAsset() {
  dapp.invalidateHoldingsCache();
  const h = await dapp.scanHoldings(true);
  for (const [aid, hh] of h) if (hh.balance >= 1000n) { assetId = aid; asset = hh; return true; }
  return false;
}
if (!(await findAsset())) {
  if (state.etch?.reveal_txid) {
    info(`(resuming) awaiting etch ${state.etch.reveal_txid.slice(0, 16)}…`);
  } else {
    info('seller has no TESTBID — etching 1000 TESTBID (decimals=0)');
    const r = await dapp.buildAndBroadcastCEtch({ ticker: 'TESTBID', supplyBase: 1000n, decimals: 0, imageUri: null, mintable: false, onProgress: (s) => info(`  [etch] ${s}`) });
    state.etch = { reveal_txid: r.revealTxid, asset_id: r.assetIdHex }; saveState(state);
    ok(`etch broadcast: reveal=${r.revealTxid.slice(0, 16)}…`);
  }
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline && !assetId) {
    const s = await fetch(`https://mempool.space/signet/api/tx/${state.etch.reveal_txid}/status`).then((x) => x.json()).catch(() => null);
    if (s?.confirmed) { await findAsset(); if (assetId) break; }
    info('  awaiting etch confirmation…'); await sleep(30_000);
  }
  if (!assetId) fail('no asset after etch confirm');
}
info(`asset: ${assetId.slice(0, 16)}… (${asset.ticker}, ${asset.balance} held)`);
ok('seller has TESTBID');

// ---- Phase 3: buyer posts bid ----
console.log('\n[3/6] Buyer: post variable-fill bid');
setWallet(BID_SK, BID_PUB);
const BID_AMOUNT = 1000n, BID_PRICE_SATS = 20000, BID_MIN_FILL = 100n;
if (state.bid?.bid_id) {
  info(`(resuming) bid ${state.bid.bid_id.slice(0, 16)}…`);
} else {
  const r = await dapp.publishBidIntent({ assetIdHex: assetId, amount: BID_AMOUNT, priceSats: BID_PRICE_SATS, expiry: Math.floor(Date.now() / 1000) + 24 * 3600, minFillAmount: BID_MIN_FILL });
  state.bid = { bid_id: r.bid_id, asset_id: r.asset_id }; saveState(state);
  ok(`bid posted: ${r.bid_id.slice(0, 16)}…`);
}

// ---- Phase 4: seller fulfils a 300-unit chunk ----
console.log('\n[4/6] Seller: fulfil 300-unit chunk → atomic intent');
setWallet(SELLER_SK, SELLER_PUB);
const CHUNK = 300n;
const SECRETS_KEY = 'tacit-axintent-secrets-v1:signet';
const PENDING_KEY = 'tacit-axintent-pending-v1:signet';
async function refetchBid() {
  const r = await fetch(`${WORKER}/assets/${assetId}/bid-intents/${state.bid.bid_id}?network=signet`);
  const j = await r.json();
  if (!r.ok || !j.intent) fail(`bid fetch failed: ${j.error || r.status}`);
  return j.intent;
}
// A live atomic-intent on this asset made by the seller, targeting the buyer.
async function findSellerAxintent() {
  const list = await fetch(`${WORKER}/assets/${assetId}/atomic-intents?network=signet`).then((r) => r.json()).catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);
  return (list.intents || []).find((i) =>
    String(i.maker_pubkey || '').toLowerCase() === bytesToHex(SELLER_PUB)
    && Number(i.expiry || 0) > now);
}
// fulfilBidIntent broadcasts the commit, THEN POSTs the intent. On signet the
// worker's chain view can lag the broadcast (404 "tx not yet indexed") or rate-
// limit (429) on that POST — a transient, not a real failure: the commit is
// already on-chain and the intent body + secret are persisted to localStorage.
// Recover by waiting for propagation and re-POSTing (resumePendingAxintents),
// never re-broadcasting (which would orphan a commit and double-spend the carve).
async function fulfilWithResume(bid) {
  let lastErr;
  // Pre-broadcast holdings/indexer lag (the carve UTXO isn't in the scanned
  // holdings yet) fails BEFORE any commit is broadcast — safe to rescan + retry
  // the whole fulfil.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await dapp.fulfilBidIntent({ bid, fillAmount: CHUNK });
      return { axintent_id: r.offer.intent_id, commit_txid: r.commit_txid };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (/not found in holdings|indexer hasn'?t caught up|↻ Rescan|not safe to send/i.test(msg) && attempt < 4) {
        info(`fulfil pre-broadcast holdings lag (${msg.slice(0, 80)}…); rescanning + retrying (attempt ${attempt})`);
        try { dapp.invalidateHoldingsCache(); await dapp.scanHoldings(true); } catch {}
        await sleep(20_000);
        continue;
      }
      break;
    }
  }
  {
    const e = lastErr;
    const msg = String(e?.message || e);
    if (!/not yet indexed|not found on chain|tx not found|not yet|propagat|429|HTTP 5\d\d/i.test(msg)) throw e;
    info(`fulfil POST hit a transient (${msg}); commit is broadcast — waiting for the worker's chain view, then resuming the POST`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await sleep(45_000);
      let res; try { res = await dapp.resumePendingAxintents(); } catch (re) { res = { attempted: '?', failures: [{ reason: re.message }] }; }
      const live = await findSellerAxintent();
      info(`  resume ${attempt}: attempted=${res.attempted} failures=${res.failures?.length ?? '?'} live=${live ? live.intent_id.slice(0, 12) + '…' : 'no'}`);
      if (live) return { axintent_id: live.intent_id, commit_txid: live.commit_txid || '' };
    }
    fail('could not resume the atomic-intent POST after retries (worker chain view never caught up)');
  }
}
if (state.fill?.axintent_id) {
  info(`(resuming) atomic-intent ${state.fill.axintent_id.slice(0, 16)}…`);
  if (state.fill.secrets_blob) globalThis.localStorage.setItem(SECRETS_KEY, state.fill.secrets_blob);
  if (state.fill.pending_blob) globalThis.localStorage.setItem(PENDING_KEY, state.fill.pending_blob);
} else {
  const bid = await refetchBid();
  const r = await fulfilWithResume(bid);
  state.fill = {
    axintent_id: r.axintent_id,
    commit_txid: r.commit_txid,
    secrets_blob: globalThis.localStorage.getItem(SECRETS_KEY) || '',
    pending_blob: globalThis.localStorage.getItem(PENDING_KEY) || '',
  };
  saveState(state);
  ok(`atomic-intent: ${r.axintent_id.slice(0, 16)}…  commit=${(r.commit_txid || '').slice(0, 16)}…`);
}

// Cancel stale seller intents from prior runs on this asset so the daemon (which
// now takes any matching public ask) doesn't burn claim cycles on orphans whose
// fulfilment secrets this run no longer holds.
setWallet(SELLER_SK, SELLER_PUB);
{
  const allList = await fetch(`${WORKER}/assets/${assetId}/atomic-intents?network=signet`).then((r) => r.json()).catch(() => ({}));
  for (const it of (allList.intents || [])) {
    if (!it.intent_id || it.intent_id === state.fill.axintent_id) continue;
    if (String(it.maker_pubkey || '').toLowerCase() !== bytesToHex(SELLER_PUB)) continue;
    try { await dapp.cancelAxferIntent({ assetIdHex: assetId, intentIdHex: it.intent_id }); info(`cancelled stale intent ${it.intent_id.slice(0, 12)}…`); }
    catch (e) { info(`(cancel ${it.intent_id.slice(0, 12)}… failed: ${e.message})`); }
  }
}

// ---- Phase 5: watchtower does buyer side (claim + take), seller fulfils axintent ----
console.log('\n[5/6] Watchtower: claim + take (daemon binary); seller fulfils axintent');
const CHUNK_PRICE = Number((BigInt(BID_PRICE_SATS) * CHUNK) / BID_AMOUNT); // 6000

// daemon config: TESTBID asset, decimals 0, policy covers the chunk's unit price
writeFileSync(DAEMON_CFG, JSON.stringify({
  bid_wallet_privkey: wallets.bid.priv_hex,
  worker_base: WORKER,
  network: 'signet',
  asset_id: assetId,
  max_unit_price_sats: 25,           // chunk is 6000/300 = 20 sats/unit
  max_total_fill_base: '300',
  decimals: 0,
  claim_fulfil_timeout_sec: 360,
  min_bid_wallet_sats: 1000,
  state_path: path.join(STATE_DIR, '_wt-daemon-state.json'),
}, null, 2));

let daemonOut = '';
const child = spawn('node', [DAEMON, '--config', DAEMON_CFG, '--once'], { cwd: path.join(__dirname, '..', 'fulfiller') });
child.stdout.on('data', (d) => { daemonOut += d.toString(); process.stdout.write(`  [daemon] ${d.toString().trim().split('\n').join('\n  [daemon] ')}\n`); });
child.stderr.on('data', (d) => { daemonOut += d.toString(); process.stderr.write(`  [daemon:err] ${d}`); });
const daemonDone = new Promise((res) => child.on('close', (code) => res(code)));

// Concurrently: wait for the daemon's claim to land, then fulfil as seller.
let sellerFulfilled = false;
const sellerLoop = (async () => {
  const deadline = Date.now() + 360 * 1000;
  while (Date.now() < deadline && !sellerFulfilled) {
    await sleep(8000);
    try {
      const listResp = await fetch(`${WORKER}/assets/${assetId}/atomic-intents?network=signet`).then((r) => r.json());
      const ax = (listResp.intents || []).find((i) => i.intent_id === state.fill.axintent_id);
      if (ax && ax.claim) {
        setWallet(SELLER_SK, SELLER_PUB);
        if (state.fill.secrets_blob) globalThis.localStorage.setItem(SECRETS_KEY, state.fill.secrets_blob);
        if (state.fill.pending_blob) globalThis.localStorage.setItem(PENDING_KEY, state.fill.pending_blob);
        await dapp.fulfilAxferIntent({ assetIdHex: assetId, intentIdHex: state.fill.axintent_id, intent: ax, claim: ax.claim });
        sellerFulfilled = true;
        ok('seller fulfilled the atomic-intent — daemon should now take');
      }
    } catch (e) { info(`  (seller poll) ${e.message}`); }
  }
})();

const code = await daemonDone;
await sellerLoop;
if (!/fill completed/.test(daemonOut)) fail(`daemon did not complete a fill (exit ${code}). Output above.`);
const txm = daemonOut.match(/"txid":"([0-9a-f]{64})"/);
const takeTxid = txm ? txm[1] : null;
if (!takeTxid) fail('daemon completed but no take txid parsed');
state.fill.take_txid = takeTxid; saveState(state);
ok(`watchtower take broadcast: ${takeTxid}`);

// ---- Phase 6: confirm + verify ----
console.log('\n[6/6] Wait for confirm + verify delivery');
const deadline = Date.now() + 30 * 60 * 1000;
let confirmed = false;
while (Date.now() < deadline) {
  const s = await fetch(`https://mempool.space/signet/api/tx/${takeTxid}/status`).then((r) => r.json()).catch(() => null);
  if (s?.confirmed) { ok(`take confirmed at block ${s.block_height}`); confirmed = true; break; }
  info('  awaiting confirmation…'); await sleep(30_000);
}
if (!confirmed) fail('take not confirmed within 30 min');

setWallet(BID_SK, BID_PUB);
dapp.invalidateHoldingsCache();
const bh = await dapp.scanHoldings(true);
const got = bh.get(assetId)?.balance || 0n;
if (got < CHUNK) fail(`buyer received ${got} TESTBID, expected ≥ ${CHUNK}`);
ok(`buyer received ${got} TESTBID (≥ ${CHUNK})`);

const bidRec = await refetchBid();
info(`bid post-settlement: state=${bidRec.state}, remaining=${bidRec.remaining_amount}`);
if (bidRec.remaining_amount !== (BID_AMOUNT - CHUNK).toString()) fail(`bid.remaining expected ${BID_AMOUNT - CHUNK}, got ${bidRec.remaining_amount}`);

console.log('\n========== SUCCESS ==========');
console.log(`  bid:            ${state.bid.bid_id}`);
console.log(`  asset:          ${assetId}`);
console.log(`  chunk filled:   ${CHUNK} TESTBID @ ${CHUNK_PRICE} sats (by the watchtower daemon)`);
console.log(`  take tx:        ${takeTxid}`);
console.log(`  buyer holdings: ${got} TESTBID`);
console.log(`  bid remaining:  ${bidRec.remaining_amount} (${bidRec.state})`);
console.log('\n  Validates: buyer posts a bid, walks away; the watchtower daemon claims a');
console.log('  seller fill, verifies delivery, and settles it SIGHASH_ALL — buyer offline.');
process.exit(0);
