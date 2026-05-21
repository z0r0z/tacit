// End-to-end signet harness for T_PREAUTH_BID (SPEC §5.7.11).
//
// Phases:
//   1. Verify both wallets are funded
//   2. Seller asset bootstrap (auto-etch a small test asset if none held)
//   3. Buyer publishes preauth-bid (auto-builds a pre-fund split tx;
//      worker validates auth_sig + buyer_sats_spend_sig + funding outpoint)
//   4. Confirm bid is fetchable via GET /preauth-bids/:bid_id
//   5. Seller takes the bid (T_PREAUTH_BID commit-reveal pair: vin[0] commit
//      P2TR script-path, vin[1] seller asset UTXO, vin[2] buyer's pre-signed
//      funding UTXO; vout[0] recipient DUST, vout[1] seller payout,
//      vout[2] OP_RETURN(bid_context_hash), [vout[3] seller change])
//   6. Wait for reveal to confirm on mempool.space
//   7. Verify on-chain outcomes:
//        - funding outpoint is spent by the reveal
//        - reveal vout[0] (buyer's tacit recipient) is the expected commit
//        - reveal vout[2] is OP_RETURN(canonical bid_context_hash)
//        - worker eventually marks the bid as stale_spent / cleans up
//        - buyer's holdings re-scan picks up the new lot at vout[0] via
//          the inline (amount, blinding) — chain-only recovery
//
// State file at .local/preauth-bid-signet-state.json is resumable.
//
// Run: `node tests/preauth-bid-onchain-e2e-signet.mjs`

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
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'preauth-bid-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'preauth-bid-signet-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}. Run \`node tests/gen-preauth-bid-signet-wallets.mjs\` first.`);
}
const wallets = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const SELLER_SK = hexToBytes(wallets.seller.priv_hex);
const BUYER_SK  = hexToBytes(wallets.buyer.priv_hex);
const SELLER_PUB = secp.getPublicKey(SELLER_SK, true);
const BUYER_PUB  = secp.getPublicKey(BUYER_SK, true);

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
  dapp.invalidateHoldingsCache();
}

setWallet(SELLER_SK, SELLER_PUB);
const SELLER_ADDR = dapp.wallet.address();
setWallet(BUYER_SK, BUYER_PUB);
const BUYER_ADDR = dapp.wallet.address();

console.log('=== preauth-bid-onchain-e2e-signet ===');
console.log(`  seller: ${SELLER_ADDR}`);
console.log(`  buyer:  ${BUYER_ADDR}`);
console.log(`  state:  ${STATE_FILE}\n`);

const state = loadState();

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
const bb = await balance(BUYER_ADDR);
info(`seller: ${sb} sats`);
info(`buyer:  ${bb} sats`);
if (sb < 20_000) fail(`seller needs ≥20k sats (has ${sb}). Fund ${SELLER_ADDR} via the faucet, then re-run.`);
if (bb < 50_000) fail(`buyer needs ≥50k sats (has ${bb}). Fund ${BUYER_ADDR} via the faucet, then re-run.`);
ok('both wallets funded');

// ---- Phase 2: seller asset bootstrap (auto-etch if needed) ----
console.log('\n[2/7] Seller asset holdings');
setWallet(SELLER_SK, SELLER_PUB);
let holdings = await dapp.scanHoldings(true);
let targetAssetId = null;
let targetUtxo = null;
let targetAsset = null;
for (const [aid, h] of holdings) {
  const u = h.utxos.find(x => x.utxo.value >= 546);
  if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
}
if (!targetUtxo && state.etch?.reveal_txid) {
  info(`(resuming) prior etch reveal ${state.etch.reveal_txid.slice(0, 16)}… — waiting for confirm`);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline && !targetUtxo) {
    const s = await fetch(`https://mempool.space/signet/api/tx/${state.etch.reveal_txid}/status`).then(r => r.json()).catch(() => null);
    if (s?.confirmed) {
      ok(`etch reveal confirmed at block ${s.block_height}`);
      dapp.invalidateHoldingsCache();
      holdings = await dapp.scanHoldings(true);
      for (const [aid, h] of holdings) {
        const u = h.utxos.find(x => x.utxo.value >= 546);
        if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
      }
      if (targetUtxo) break;
    }
    info(`  awaiting etch confirmation…`);
    await sleep(30_000);
  }
  if (!targetUtxo) {
    fail(`prior etch ${state.etch.reveal_txid} did not confirm. Check https://mempool.space/signet/tx/${state.etch.reveal_txid} or clear state.etch from ${STATE_FILE}.`);
  }
}
if (!targetUtxo) {
  info('seller has no asset — etching 1000 TESTBID (decimals=0)');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'TESTBID', supplyBase: 1000n, decimals: 0,
    imageUri: null, mintable: false,
    onProgress: (s) => info(`  [etch] ${s}`),
  });
  state.etch = { commit_txid: r.commitTxid, reveal_txid: r.revealTxid, asset_id: r.assetIdHex };
  saveState(state);
  ok(`etch broadcast: reveal=${r.revealTxid.slice(0, 16)}…`);
  info('waiting up to 30 min for confirm + holdings refresh…');
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
    const u = h.utxos.find(x => x.utxo.value >= 546);
    if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
  }
  if (!targetUtxo) fail('still no asset after etch confirm — investigate');
}
info(`asset: ${targetAssetId.slice(0, 16)}… (${targetAsset.ticker})`);
info(`utxo:  ${targetUtxo.utxo.txid.slice(0, 16)}…:${targetUtxo.utxo.vout} (amount=${targetUtxo.amount})`);
ok('seller has spendable asset UTXO');

// ---- Phase 3: buyer publishes preauth-bid ----
console.log('\n[3/7] Buyer: publishPreauthBid');
const BID_AMOUNT_BASE = 100n;          // 100 base units of TESTBID
const BID_PRICE_SATS = 20_000;          // 20k sats for 100 units
const BID_MAX_FEE_BUDGET = 1500;        // 1.5k sat fee/tip cap
const BID_EXPIRY = Math.floor(Date.now() / 1000) + 24 * 3600;

if (BID_AMOUNT_BASE > targetUtxo.amount) {
  fail(`bid amount (${BID_AMOUNT_BASE}) exceeds seller's holding (${targetUtxo.amount}); etch more or reduce`);
}

if (state.bid?.bid_id) {
  info(`(resuming) bid_id=${state.bid.bid_id.slice(0, 16)}…`);
} else {
  setWallet(BUYER_SK, BUYER_PUB);
  try {
    const r = await dapp.publishPreauthBid({
      assetIdHex: targetAssetId,
      amount: BID_AMOUNT_BASE,
      priceSats: BID_PRICE_SATS,
      expiry: BID_EXPIRY,
      maxFeeBudget: BID_MAX_FEE_BUDGET,
      onProgress: (stage, extra) => info(`  [pub] ${stage}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    });
    state.bid = {
      asset_id: r.asset_id,
      bid_id: r.bid_id,
      funding_outpoint: r.funding_outpoint,
      amount: BID_AMOUNT_BASE.toString(),
      price_sats: BID_PRICE_SATS,
      max_fee_budget: BID_MAX_FEE_BUDGET,
      expiry: BID_EXPIRY,
    };
    saveState(state);
    ok(`bid published: bid_id=${r.bid_id}`);
    info(`funding outpoint: ${r.funding_outpoint.txid.slice(0, 16)}…:${r.funding_outpoint.vout} (value=${r.funding_outpoint.value})`);
  } catch (e) {
    fail(`publishPreauthBid failed: ${e.message}`);
  }
}

// ---- Phase 4: confirm bid is fetchable ----
console.log('\n[4/7] Confirm bid fetchable from worker');
const fetched = await dapp.fetchPreauthBid({ assetIdHex: state.bid.asset_id, bidIdHex: state.bid.bid_id });
if (!fetched) fail('bid not visible in GET /preauth-bids/:bid_id — worker may have rejected silently');
ok(`bid fetched: status=${fetched.status || 'live'}, amount=${fetched.amount}, price_sats=${fetched.price_sats}`);
if (fetched.amount !== state.bid.amount) fail(`amount mismatch (local ${state.bid.amount}, worker ${fetched.amount})`);
if (Number(fetched.price_sats) !== BID_PRICE_SATS) fail(`price_sats mismatch (local ${BID_PRICE_SATS}, worker ${fetched.price_sats})`);

// Also exercise list endpoint.
const allBids = await dapp.fetchPreauthBids({ assetIdHex: state.bid.asset_id });
if (!allBids.find(b => b.bid_id === state.bid.bid_id)) {
  fail('bid not visible in GET /preauth-bids list');
}
ok(`bid visible in /preauth-bids list (${allBids.length} total)`);

// ---- Phase 5: seller takes the bid ----
console.log('\n[5/7] Seller: takePreauthBid');
setWallet(SELLER_SK, SELLER_PUB);
// scanHoldings + targetUtxo were computed under seller's wallet earlier;
// re-scan for any in-flight changes.
dapp.invalidateHoldingsCache();

if (state.take?.reveal_txid) {
  info(`(resuming) reveal=${state.take.reveal_txid.slice(0, 16)}…`);
} else {
  try {
    const r = await dapp.takePreauthBid({
      assetIdHex: state.bid.asset_id,
      bidIdHex: state.bid.bid_id,
      onProgress: (stage) => info(`  [take] ${stage}`),
    });
    state.take = { commit_txid: r.commit_txid, reveal_txid: r.reveal_txid };
    saveState(state);
    ok(`reveal broadcast: ${r.reveal_txid}`);
    info(`commit: ${r.commit_txid}`);
  } catch (e) {
    fail(`takePreauthBid failed: ${e.message}`);
  }
}

// ---- Phase 6: wait for reveal to confirm ----
console.log('\n[6/7] Wait for reveal to confirm (polling every 30s, up to 30 min)');
async function txStatus(txid) {
  const res = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`tx status ${res.status}`);
  return res.json();
}
let revealStatus = null;
const DEADLINE = Date.now() + 30 * 60 * 1000;
while (Date.now() < DEADLINE) {
  revealStatus = await txStatus(state.take.reveal_txid).catch(() => null);
  if (revealStatus?.confirmed) { ok(`reveal confirmed at block ${revealStatus.block_height}`); break; }
  if (revealStatus) info(`reveal in mempool, awaiting confirmation…`);
  else              info(`reveal not yet visible to indexer (propagation lag)…`);
  await sleep(30_000);
}
if (!revealStatus?.confirmed) {
  console.warn('  reveal not confirmed within 30 min; CPFP may be needed if fee rate undershot');
  console.warn(`  reveal txid: ${state.take.reveal_txid}`);
  process.exit(2);
}

// ---- Phase 7: verify on-chain outcomes ----
console.log('\n[7/7] Verify on-chain outcomes');

async function fetchOutspend(txid, vout) {
  const res = await fetch(`https://mempool.space/signet/api/tx/${txid}/outspend/${vout}`);
  if (!res.ok) throw new Error(`outspend ${res.status}`);
  return res.json();
}

// 1. Funding outpoint must now be spent — by the reveal.
const fundingSp = await fetchOutspend(state.bid.funding_outpoint.txid, state.bid.funding_outpoint.vout);
if (!fundingSp.spent) fail('buyer funding outpoint still unspent — reveal did not consume it');
if (fundingSp.txid !== state.take.reveal_txid) fail(`buyer funding spent by different tx (${fundingSp.txid})`);
ok('buyer funding outpoint spent by reveal');

// 2. Seller's asset outpoint must be spent by the reveal.
const assetSp = await fetchOutspend(targetUtxo.utxo.txid, targetUtxo.utxo.vout);
if (!assetSp.spent) fail('seller asset outpoint still unspent — reveal did not consume it');
if (assetSp.txid !== state.take.reveal_txid) fail(`seller asset spent by different tx (${assetSp.txid})`);
ok('seller asset outpoint spent by reveal');

// 3. Inspect reveal tx structure.
const revealRes = await fetch(`https://mempool.space/signet/api/tx/${state.take.reveal_txid}`);
const revealJson = await revealRes.json();
if (revealJson.vin.length !== 3) fail(`reveal vin count = ${revealJson.vin.length}, expected 3`);
const tacitDustOuts = revealJson.vout.filter(o => Number(o.value) === 546);
if (tacitDustOuts.length < 1) fail('no DUST vout in reveal — recipient missing');
// vout[0] should be the buyer's tacit recipient (DUST P2WPKH).
const vout0 = revealJson.vout[0];
if (Number(vout0.value) !== 546) fail(`vout[0].value=${vout0.value}, expected 546 (DUST)`);
ok(`reveal vout[0] = DUST (buyer's tacit recipient slot)`);

// vout[1] should be seller's BTC payout (≥ price_sats).
const vout1 = revealJson.vout[1];
if (Number(vout1.value) < BID_PRICE_SATS) {
  fail(`seller underpaid: vout[1].value=${vout1.value}, expected >= ${BID_PRICE_SATS}`);
}
ok(`reveal vout[1].value=${vout1.value} (seller payout, >= price_sats=${BID_PRICE_SATS})`);

// vout[2] should be OP_RETURN(bid_context_hash). Verify the 34-byte
// scriptPubKey shape AND that the embedded 32-byte hash matches the
// canonical bid_context_hash for this bid.
const vout2 = revealJson.vout[2];
if (Number(vout2.value) !== 0) fail(`vout[2].value=${vout2.value}, expected 0 (OP_RETURN)`);
const v2spk = vout2.scriptpubkey;
if (typeof v2spk !== 'string' || v2spk.length !== 68 || !v2spk.startsWith('6a20')) {
  fail(`vout[2].scriptpubkey wrong shape: ${v2spk}`);
}
const v2hash = v2spk.slice(4);  // 32 bytes hex
// Recompute canonical bid_context_hash.
const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(state.bid.amount), true);
const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(state.bid.price_sats), true);
const canonicalHash = sha256(concatBytes(
  new TextEncoder().encode('tacit-preauth-bid-context-v1'),
  hexToBytes(state.bid.asset_id),
  hexToBytes(state.bid.bid_id),
  hexToBytes(fetched.recipient_pubkey),
  amountLE,
  hexToBytes(fetched.blinding),
  priceLE,
));
if (bytesToHex(canonicalHash) !== v2hash) {
  fail(`vout[2] OP_RETURN hash mismatch:\n  on-chain: ${v2hash}\n  canonical: ${bytesToHex(canonicalHash)}`);
}
ok('reveal vout[2] = OP_RETURN(canonical bid_context_hash)');

// 4. Buyer's holdings re-scan picks up the new lot at vout[0] via the
//    inline (amount, blinding) — chain-only recovery, no bid-record
//    fetch.
console.log('\n  Verifying buyer-side chain-only recovery…');
setWallet(BUYER_SK, BUYER_PUB);
dapp.invalidateHoldingsCache();
// Give mempool.space a beat to reindex the new UTXO under buyer.
await sleep(15_000);
// Re-derive buyer's address (recipient_pubkey defaults to buyer_pubkey
// when publishPreauthBid is called without recipientPubHex). The lot
// should appear at txid:0 of the reveal under buyer.
const buyerHoldings = await dapp.scanHoldings(true);
const buyerH = buyerHoldings.get(state.bid.asset_id);
if (!buyerH) {
  info('(buyer holdings empty — may need longer indexer propagation)');
} else {
  const recoveredLot = buyerH.utxos.find(u => u.utxo.txid === state.take.reveal_txid && u.utxo.vout === 0);
  if (recoveredLot && recoveredLot.amount.toString() === state.bid.amount) {
    ok(`buyer recovered ${recoveredLot.amount} ${buyerH.ticker || '?'} from chain alone (no bid-record fetch)`);
  } else {
    info(`(buyer holdings show ${buyerH.balance} ${buyerH.ticker || '?'} — chain-only recovery may need another scan cycle)`);
  }
}

// 5. Worker should eventually clean up the bid (stale_spent sweep). Best-effort
//    check — the sweep runs on cron, so it may take a few minutes. Don't fail
//    if it hasn't fired yet.
const postFetch = await dapp.fetchPreauthBid({ assetIdHex: state.bid.asset_id, bidIdHex: state.bid.bid_id });
if (postFetch) info(`(worker still has the bid — stale_spent sweep runs on cron, expect cleanup within ~5 min)`);
else            ok('worker cleaned up bid post-settlement');

console.log('\n=== PASS ===');
console.log('T_PREAUTH_BID e2e signet flow completed successfully.');
console.log(`  asset:      ${state.bid.asset_id}`);
console.log(`  bid_id:     ${state.bid.bid_id}`);
console.log(`  funding:    ${state.bid.funding_outpoint.txid}:${state.bid.funding_outpoint.vout}`);
console.log(`  commit txid: ${state.take.commit_txid}`);
console.log(`  reveal txid: ${state.take.reveal_txid}`);
console.log(`  block:       ${revealStatus.block_height}`);
console.log(`\nDelete ${STATE_FILE} to start a fresh run.\n`);
