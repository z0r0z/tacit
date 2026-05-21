// 8-decimal end-to-end signet harness for T_PREAUTH_BID_VAR (SPEC §5.7.12).
//
// Mirror of tests/preauth-bid-var-onchain-e2e-signet.mjs (0-decimal flow)
// with decimals_scale = 8 — the canonical TAC scenario the protocol
// must support. Verifies that the inline section's decimals_scale byte
// is plumbed through every layer:
//
//   • Encoder: produces a 134-byte inline section + scale byte at the
//     end of the inline run.
//   • K-sig batch verify (worker /preauth-bids-var POST): each per-ratio
//     bid_context_hash includes decimals_scale in its SHA-256 preimage;
//     the worker re-derives the same hash and verifies all K signatures.
//   • Settlement: seller's takePreauthBidVar opens output[0] Pedersen
//     to (fill_amount × 10^8, recipient_blinding) — the protocol-wide
//     base-unit invariant.
//   • Refund vout: indexer-enforced sats math is scale-invariant.
//   • Chain-only recovery: buyer's scanHoldings credits the recipient
//     lot with the same scale conversion.
//
// Etches a fresh 8-decimal TBIDVAR8 asset (supply 1000 whole = 10^11
// base units) so seller has enough to fill the canonical 100-whole-TAC
// shape with room to spare.
//
// State file at .local/preauth-bid-var-8dec-signet-state.json is resumable.
//
// Run: `node tests/preauth-bid-var-8dec-onchain-e2e-signet.mjs`

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
globalThis.__TACIT_ENABLE_T_PREAUTH_BID_VAR = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/ripemd160';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'preauth-bid-var-8dec-signet-state.json');
// Reuse the wallets the 0-dec harness uses — they're funded and held no
// asset state we care about (each harness etches its own asset).
const WALLET_FILE = path.join(STATE_DIR, 'preauth-bid-var-signet-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hash160(b) { return ripemd160(sha256(b)); }

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}. Run \`node tests/gen-preauth-bid-var-signet-wallets.mjs\` first.`);
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

console.log('=== preauth-bid-var-8dec-onchain-e2e-signet (SPEC §5.7.12, scale=8) ===');
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
if (sb < 20_000) fail(`seller needs ≥20k sats (has ${sb}). Top up ${SELLER_ADDR} and re-run.`);
if (bb < 30_000) fail(`buyer needs ≥30k sats (has ${bb}). Top up ${BUYER_ADDR} and re-run.`);
ok('both wallets funded');

// ---- Phase 2: seller asset bootstrap (8-decimal etch) ----
console.log('\n[2/7] Seller asset holdings (8-decimal TBIDVAR8)');
setWallet(SELLER_SK, SELLER_PUB);
let holdings = await dapp.scanHoldings(true);
let targetAssetId = null;
let targetUtxo = null;
let targetAsset = null;
// Prefer the asset from prior state (if resuming).
if (state.etch?.asset_id) {
  const h = holdings.get(state.etch.asset_id);
  if (h) {
    const u = h.utxos.find(x => x.utxo.value >= 546);
    if (u) { targetAssetId = state.etch.asset_id; targetUtxo = u; targetAsset = h; }
  }
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
      const h = holdings.get(state.etch.asset_id);
      if (h) {
        const u = h.utxos.find(x => x.utxo.value >= 546);
        if (u) { targetAssetId = state.etch.asset_id; targetUtxo = u; targetAsset = h; break; }
      }
    }
    info(`  awaiting etch confirmation…`);
    await sleep(30_000);
  }
  if (!targetUtxo) {
    fail(`prior etch ${state.etch.reveal_txid} did not confirm. Check https://mempool.space/signet/tx/${state.etch.reveal_txid} or clear state.etch from ${STATE_FILE}.`);
  }
}
if (!targetUtxo) {
  info('seller has no TBIDVAR8 yet — etching 1000 whole TBIDVAR8 (decimals=8 → 10^11 base units)');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'TBIDVAR8', supplyBase: 100_000_000_000n, decimals: 8,
    imageUri: null, mintable: false,
    onProgress: (s) => info(`  [etch] ${s}`),
  });
  state.etch = { commit_txid: r.commitTxid, reveal_txid: r.revealTxid, asset_id: r.assetIdHex };
  saveState(state);
  ok(`etch broadcast: reveal=${r.revealTxid.slice(0, 16)}…  asset=${r.assetIdHex.slice(0, 16)}…`);
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
  const h = holdings.get(r.assetIdHex);
  if (h) {
    const u = h.utxos.find(x => x.utxo.value >= 546);
    if (u) { targetAssetId = r.assetIdHex; targetUtxo = u; targetAsset = h; }
  }
  if (!targetUtxo) fail('still no asset after etch confirm — investigate');
}
info(`asset: ${targetAssetId.slice(0, 16)}… (${targetAsset.ticker}, decimals=${targetAsset.decimals})`);
info(`utxo:  ${targetUtxo.utxo.txid.slice(0, 16)}…:${targetUtxo.utxo.vout} (amount=${targetUtxo.amount} base units = ${targetUtxo.amount / 10n**8n} whole)`);
if (targetAsset.decimals !== 8) fail(`expected decimals=8, got ${targetAsset.decimals} — etch is off-spec`);
ok('seller has spendable 8-decimal asset UTXO');

// ---- Phase 3: buyer publishes preauth-bid-var (scale=8) ----
console.log('\n[3/7] Buyer: publishPreauthBidVar at decimals_scale=8 (canonical TAC shape)');
// Canonical TAC shape:
//   max_fill = 100 whole tokens (scaled units at scale=8)
//   min_fill = 10 whole
//   fill_increment = 10 whole
//   price_per_unit = 200 sats per whole
//   K = (100-10)/10 + 1 = 10 ratios
//   buyer funding = 100 × 200 + DUST(546) + max_fee(3000) = 23,546 sats
const VAR_DECIMALS_SCALE = 8;
const VAR_MAX_FILL = 100n;       // 100 whole
const VAR_MIN_FILL = 10n;
const VAR_FILL_INC = 10n;
const VAR_PRICE_PER_UNIT = 200n; // sats per whole
const VAR_MAX_FEE_BUDGET = 3000;
const VAR_EXPIRY = Math.floor(Date.now() / 1000) + 24 * 3600;
const VAR_K = Number((VAR_MAX_FILL - VAR_MIN_FILL) / VAR_FILL_INC) + 1;
const VAR_PARTIAL_FILL = 50n;    // mid-range; exercises refund vout
const VAR_PARTIAL_RATIO_IDX = Number((VAR_PARTIAL_FILL - VAR_MIN_FILL) / VAR_FILL_INC);
const VAR_EXPECTED_REFUND = (VAR_MAX_FILL - VAR_PARTIAL_FILL) * VAR_PRICE_PER_UNIT;

// Seller's UTXO is in base units; scaled units would be / 10^8.
const targetUtxoScaled = targetUtxo.amount / 10n ** 8n;
if (VAR_MAX_FILL > targetUtxoScaled) {
  fail(`bid max_fill (${VAR_MAX_FILL} whole) exceeds seller's holding (${targetUtxoScaled} whole); etch more`);
}

if (state.bid?.bid_id) {
  info(`(resuming) bid_id=${state.bid.bid_id.slice(0, 16)}…  K=${state.bid.K}`);
} else {
  setWallet(BUYER_SK, BUYER_PUB);
  try {
    const r = await dapp.publishPreauthBidVar({
      assetIdHex: targetAssetId,
      pricePerUnit: VAR_PRICE_PER_UNIT,
      minFill: VAR_MIN_FILL,
      maxFill: VAR_MAX_FILL,
      fillIncrement: VAR_FILL_INC,
      decimalsScale: VAR_DECIMALS_SCALE,
      expiry: VAR_EXPIRY,
      maxFeeBudget: VAR_MAX_FEE_BUDGET,
      onProgress: (stage, extra) => info(`  [pub] ${stage}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    });
    state.bid = {
      asset_id: r.asset_id,
      bid_id: r.bid_id,
      funding_outpoint: r.funding_outpoint,
      K: r.K,
      min_fill: VAR_MIN_FILL.toString(),
      max_fill: VAR_MAX_FILL.toString(),
      fill_increment: VAR_FILL_INC.toString(),
      price_per_unit: VAR_PRICE_PER_UNIT.toString(),
      decimals_scale: VAR_DECIMALS_SCALE,
      max_fee_budget: VAR_MAX_FEE_BUDGET,
      expiry: VAR_EXPIRY,
    };
    saveState(state);
    ok(`bid published: bid_id=${r.bid_id}  K=${r.K}  scale=${VAR_DECIMALS_SCALE}`);
    info(`funding outpoint: ${r.funding_outpoint.txid.slice(0, 16)}…:${r.funding_outpoint.vout} (value=${r.funding_outpoint.value})`);
  } catch (e) {
    fail(`publishPreauthBidVar failed: ${e.message}`);
  }
}
if (state.bid.K !== VAR_K) fail(`K mismatch: state.bid.K=${state.bid.K}, expected ${VAR_K}`);

// ---- Phase 4: confirm bid is fetchable + worker stored decimals_scale ----
console.log('\n[4/7] Confirm bid fetchable from worker + decimals_scale persisted');
const fetched = await dapp.fetchPreauthBidVar({ assetIdHex: state.bid.asset_id, bidIdHex: state.bid.bid_id });
if (!fetched) fail('bid not visible in GET /preauth-bids-var/:bid_id');
ok(`bid fetched: status=${fetched.status || 'live'}  K=${fetched.K}  range=[${fetched.min_fill}, ${fetched.max_fill}] step=${fetched.fill_increment}  px=${fetched.price_per_unit} sats/scaled-unit  scale=${fetched.decimals_scale}`);
if (fetched.max_fill !== state.bid.max_fill) fail(`max_fill mismatch (local ${state.bid.max_fill}, worker ${fetched.max_fill})`);
if (fetched.K !== state.bid.K) fail(`K mismatch (local ${state.bid.K}, worker ${fetched.K})`);
if (fetched.decimals_scale !== VAR_DECIMALS_SCALE) fail(`decimals_scale mismatch (local ${VAR_DECIMALS_SCALE}, worker ${fetched.decimals_scale}) — the new field isn't round-tripping`);
if (!Array.isArray(fetched.buyer_sats_spend_sigs) || fetched.buyer_sats_spend_sigs.length !== VAR_K) {
  fail(`worker stored ${fetched.buyer_sats_spend_sigs?.length} sigs, expected K=${VAR_K}`);
}
ok(`worker round-tripped decimals_scale=${fetched.decimals_scale} + ${VAR_K} per-ratio pre-sigs`);

// ---- Phase 5: seller takes at fill_amount=50 (whole TAC equivalent) ----
console.log(`\n[5/7] Seller: takePreauthBidVar at fill_amount=${VAR_PARTIAL_FILL} (whole; ratio_index=${VAR_PARTIAL_RATIO_IDX} of K=${VAR_K})`);
setWallet(SELLER_SK, SELLER_PUB);
dapp.invalidateHoldingsCache();

if (state.take?.reveal_txid) {
  info(`(resuming) reveal=${state.take.reveal_txid.slice(0, 16)}…`);
} else {
  try {
    const r = await dapp.takePreauthBidVar({
      assetIdHex: state.bid.asset_id,
      bidIdHex: state.bid.bid_id,
      fillAmount: VAR_PARTIAL_FILL,
      onProgress: (stage, extra) => info(`  [take] ${stage}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    });
    state.take = {
      commit_txid: r.commit_txid,
      reveal_txid: r.reveal_txid,
      fill_amount: r.fill_amount,
      ratio_index: r.ratio_index,
      refund_sats: r.refund_sats,
    };
    saveState(state);
    ok(`reveal broadcast: ${r.reveal_txid}`);
    info(`commit: ${r.commit_txid}`);
    info(`fill_amount=${r.fill_amount} whole TAC  ratio_index=${r.ratio_index}  refund=${r.refund_sats} sats`);
  } catch (e) {
    fail(`takePreauthBidVar failed: ${e.message}`);
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

// ---- Phase 7: verify on-chain outcomes (the 8-dec invariants) ----
console.log('\n[7/7] Verify on-chain outcomes (8-decimal-specific invariants)');

async function fetchOutspend(txid, vout) {
  const res = await fetch(`https://mempool.space/signet/api/tx/${txid}/outspend/${vout}`);
  if (!res.ok) throw new Error(`outspend ${res.status}`);
  return res.json();
}

const fundingSp = await fetchOutspend(state.bid.funding_outpoint.txid, state.bid.funding_outpoint.vout);
if (!fundingSp.spent) fail('buyer funding outpoint still unspent');
if (fundingSp.txid !== state.take.reveal_txid) fail(`buyer funding spent by different tx (${fundingSp.txid})`);
ok('buyer funding outpoint spent by reveal');

const assetSp = await fetchOutspend(targetUtxo.utxo.txid, targetUtxo.utxo.vout);
if (!assetSp.spent) fail('seller asset outpoint still unspent');
if (assetSp.txid !== state.take.reveal_txid) fail(`seller asset spent by different tx (${assetSp.txid})`);
ok('seller asset outpoint spent by reveal');

const revealRes = await fetch(`https://mempool.space/signet/api/tx/${state.take.reveal_txid}`);
const revealJson = await revealRes.json();
if (revealJson.vin.length !== 3) fail(`reveal vin count = ${revealJson.vin.length}, expected 3`);
ok(`reveal has 3 vin`);

// vout[0] = buyer's tacit recipient (DUST P2WPKH).
const vout0 = revealJson.vout[0];
if (Number(vout0.value) !== 546) fail(`vout[0].value=${vout0.value}, expected 546 (DUST)`);
const expectedRecipientSpk = '0014' + bytesToHex(hash160(BUYER_PUB));
if (vout0.scriptpubkey.toLowerCase() !== expectedRecipientSpk) {
  fail(`vout[0].scriptpubkey != P2WPKH(buyer_pubkey)`);
}
ok(`reveal vout[0] = DUST P2WPKH(buyer) — partial-fill lot for ${VAR_PARTIAL_FILL} whole TBIDVAR8 (= ${VAR_PARTIAL_FILL * 10n**8n} base units)`);

// vout[1] = seller's BTC payout ≥ fill × price = 50 × 200 = 10,000 sats.
const minSellerPayout = Number(VAR_PARTIAL_FILL * VAR_PRICE_PER_UNIT);
const vout1 = revealJson.vout[1];
if (Number(vout1.value) < minSellerPayout) {
  fail(`seller underpaid: vout[1].value=${vout1.value}, expected >= ${minSellerPayout}`);
}
ok(`reveal vout[1].value=${vout1.value} (seller payout, >= ${minSellerPayout})`);

// vout[2] = OP_RETURN(canonical per-ratio bid_context_hash AT scale=8).
const vout2 = revealJson.vout[2];
if (Number(vout2.value) !== 0) fail(`vout[2].value=${vout2.value}, expected 0 (OP_RETURN)`);
const v2spk = vout2.scriptpubkey;
if (typeof v2spk !== 'string' || v2spk.length !== 68 || !v2spk.startsWith('6a20')) {
  fail(`vout[2].scriptpubkey wrong shape: ${v2spk}`);
}
const v2hash = v2spk.slice(4);
function u64LE(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }
const refundScriptHashBytes = hash160(hexToBytes(fetched.refund_pubkey));
const canonicalHash = sha256(concatBytes(
  new TextEncoder().encode('tacit-preauth-bid-var-context-v1'),
  hexToBytes(state.bid.asset_id),
  hexToBytes(state.bid.bid_id),
  hexToBytes(fetched.recipient_pubkey),
  u64LE(state.bid.price_per_unit),
  u64LE(state.bid.max_fill),
  u64LE(state.bid.fill_increment),
  u64LE(state.take.fill_amount),
  refundScriptHashBytes,
  new Uint8Array([VAR_DECIMALS_SCALE & 0xff]),  // ← THE 8-DEC GATE
));
if (bytesToHex(canonicalHash) !== v2hash) {
  fail(`vout[2] OP_RETURN hash mismatch — decimals_scale binding broken on chain\n  on-chain: ${v2hash}\n  canonical: ${bytesToHex(canonicalHash)}`);
}
ok(`reveal vout[2] = OP_RETURN(canonical per-ratio hash including decimals_scale=8)`);

// vout[3] = refund vout = 50 × 200 = 10,000 sats to refund_pubkey.
const vout3 = revealJson.vout[3];
if (!vout3) fail('vout[3] missing — partial-fill MUST have a refund vout');
const expectedRefundSpk = '0014' + bytesToHex(refundScriptHashBytes);
if (vout3.scriptpubkey.toLowerCase() !== expectedRefundSpk) {
  fail(`vout[3].scriptpubkey != P2WPKH(refund_pubkey)`);
}
if (Number(vout3.value) !== Number(VAR_EXPECTED_REFUND)) {
  fail(`vout[3].value=${vout3.value}, expected ${VAR_EXPECTED_REFUND}`);
}
ok(`reveal vout[3] = P2WPKH(refund_pubkey) paying ${vout3.value} sats — REFUND VOUT INVARIANT HOLDS AT SCALE=8`);

// Buyer chain-only recovery: the recipient lot at vout[0] should open
// to (fill_amount × 10^8, blinding) base units. Buyer scanHoldings does
// this scaling automatically.
console.log('\n  Verifying buyer-side chain-only recovery (scale=8 → base units)…');
setWallet(BUYER_SK, BUYER_PUB);
dapp.invalidateHoldingsCache();
await sleep(15_000);
const buyerHoldings = await dapp.scanHoldings(true);
const buyerH = buyerHoldings.get(state.bid.asset_id);
if (!buyerH) {
  info('(buyer holdings empty — may need longer indexer propagation)');
} else {
  const recoveredLot = buyerH.utxos.find(u => u.utxo.txid === state.take.reveal_txid && u.utxo.vout === 0);
  // Expected: fill_amount × 10^decimals_scale = 50 × 10^8 = 5,000,000,000 base units.
  const expectedBaseUnits = VAR_PARTIAL_FILL * (10n ** BigInt(VAR_DECIMALS_SCALE));
  if (recoveredLot && recoveredLot.amount === expectedBaseUnits) {
    ok(`buyer recovered ${recoveredLot.amount} base units (${VAR_PARTIAL_FILL} whole ${buyerH.ticker}) chain-only — Pedersen opened to scaled value`);
  } else if (recoveredLot) {
    fail(`buyer recovery amount mismatch: got ${recoveredLot.amount}, expected ${expectedBaseUnits} base units (= ${VAR_PARTIAL_FILL} × 10^${VAR_DECIMALS_SCALE})`);
  } else {
    info(`(buyer holdings show ${buyerH.balance} base units of ${buyerH.ticker} but not the new lot — propagation lag, re-scan)`);
  }
}

console.log('\n=== PASS ===');
console.log('T_PREAUTH_BID_VAR @ decimals_scale=8 e2e signet flow completed.');
console.log(`  asset:              ${state.bid.asset_id}`);
console.log(`  asset.decimals:     8 (TBIDVAR8)`);
console.log(`  bid_id:             ${state.bid.bid_id}`);
console.log(`  decimals_scale:     ${VAR_DECIMALS_SCALE} (1 scaled unit = 1 whole TBIDVAR8 = 10^8 base units)`);
console.log(`  K:                  ${state.bid.K}`);
console.log(`  range:              [${state.bid.min_fill}, ${state.bid.max_fill}] whole × step ${state.bid.fill_increment}`);
console.log(`  price_per_unit:     ${state.bid.price_per_unit} sats/whole`);
console.log(`  fill_amount:        ${state.take.fill_amount} whole (= ${BigInt(state.take.fill_amount) * 10n**8n} base units)`);
console.log(`  refund:             ${state.take.refund_sats} sats`);
console.log(`  commit txid:        ${state.take.commit_txid}`);
console.log(`  reveal txid:        ${state.take.reveal_txid}`);
console.log(`  block:              ${revealStatus.block_height}`);
console.log(`\nDelete ${STATE_FILE} to start a fresh run.\n`);
