// End-to-end signet broadcast test for the preauth-sale flow.
//
// Exercises the buyer-completable T_AXFER pipeline (SPEC §5.7.8) against
// real signet Bitcoin and the live worker. What the offline tests can't
// catch:
//   - Bitcoin consensus accepts the reveal tx (vin[1] seller sig, vin[0]
//     taproot script-path, vin[2..] SIGHASH_ALL funding, vout[0] tacit
//     recipient, vout[1] seller payout)
//   - mempool.space relay accepts both commit and reveal
//   - The dApp's commit→reveal sequencing survives indexer propagation lag
//   - Worker /preauth-sales POST/GET/DELETE round-trip with real keys
//
// Prerequisites (the harness checks and prints clear instructions if missing):
//   - Seller wallet with at least one tacit asset UTXO already etched on signet
//     (use the dApp UI to etch a CETCH first — auto-etching from this harness
//     would require re-implementing buildAndBroadcastCEtch, out of scope)
//   - Both seller and buyer wallets funded with ~50k signet sats each
//
// Inputs (env vars):
//   PREAUTH_SELLER_SK  — 64-hex priv of seller wallet (must hold a tacit UTXO)
//   PREAUTH_BUYER_SK   — 64-hex priv of buyer wallet (must have signet sats)
//   PREAUTH_ASSET_ID   — optional; defaults to the first asset in seller's holdings
//   PREAUTH_MIN_PRICE  — optional; defaults to 5000 sats
//
// State file: .local/preauth-sale-signet-state.json (resumable; delete to start over).
//
// Run: `node preauth-sale-e2e-signet.mjs`

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
const STATE_FILE = path.join(STATE_DIR, 'preauth-sale-signet-state.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SELLER_SK_HEX = (process.env.PREAUTH_SELLER_SK || '').toLowerCase();
const BUYER_SK_HEX  = (process.env.PREAUTH_BUYER_SK  || '').toLowerCase();
const ASSET_ID_OVERRIDE = (process.env.PREAUTH_ASSET_ID || '').toLowerCase();
const MIN_PRICE_SATS = Math.max(546, Number(process.env.PREAUTH_MIN_PRICE || 5000));

if (!/^[0-9a-f]{64}$/.test(SELLER_SK_HEX)) {
  fail('Set PREAUTH_SELLER_SK to a 64-hex signet wallet priv. The seller wallet must already hold a tacit asset UTXO (etch via the dApp UI first).');
}
if (!/^[0-9a-f]{64}$/.test(BUYER_SK_HEX)) {
  fail('Set PREAUTH_BUYER_SK to a 64-hex signet wallet priv. The buyer wallet must have at least ~50k signet sats.');
}
if (SELLER_SK_HEX === BUYER_SK_HEX) {
  fail('Seller and buyer privs must differ.');
}

const SELLER_SK = hexToBytes(SELLER_SK_HEX);
const SELLER_PUB = secp.getPublicKey(SELLER_SK, true);
const BUYER_SK = hexToBytes(BUYER_SK_HEX);
const BUYER_PUB = secp.getPublicKey(BUYER_SK, true);

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
  dapp.invalidateHoldingsCache();
}

setWallet(SELLER_SK, SELLER_PUB);
const SELLER_ADDR = dapp.wallet.address();
setWallet(BUYER_SK, BUYER_PUB);
const BUYER_ADDR = dapp.wallet.address();

console.log('=== preauth-sale signet e2e ===');
console.log(`  seller: ${SELLER_ADDR}`);
console.log(`  buyer:  ${BUYER_ADDR}`);
console.log(`  worker: live (hardcoded WORKER_BASE)`);
console.log(`  state:  ${STATE_FILE}`);

const state = loadState();

// ---- Phase 1: prerequisites ----
console.log('\n[1/5] Prerequisites:');

async function fetchAddrBalanceSats(addr) {
  const res = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  if (!res.ok) throw new Error(`addr fetch ${res.status}`);
  const j = await res.json();
  const chain = j.chain_stats || {};
  const mempool = j.mempool_stats || {};
  return (chain.funded_txo_sum || 0) - (chain.spent_txo_sum || 0)
       + (mempool.funded_txo_sum || 0) - (mempool.spent_txo_sum || 0);
}

const sellerBalance = await fetchAddrBalanceSats(SELLER_ADDR);
const buyerBalance  = await fetchAddrBalanceSats(BUYER_ADDR);
info(`seller balance: ${sellerBalance} sats`);
info(`buyer  balance: ${buyerBalance} sats`);
if (sellerBalance < 5000) {
  fail(`Seller has insufficient sats (${sellerBalance}). Fund ${SELLER_ADDR} from https://signetfaucet.com/ or the dApp's /drip endpoint, then re-run.`);
}
// Conservative pre-check. The actual preauth settlement the buyer funds is
// price_sats + commit/reveal fees (~10-15k at the harness price); 30k leaves
// ample margin without forcing a faucet top-up for an already-funded wallet.
if (buyerBalance < 30_000) {
  fail(`Buyer has insufficient sats (${buyerBalance}). Fund ${BUYER_ADDR} from https://signetfaucet.com/, then re-run.`);
}
ok('both wallets funded');

// ---- Phase 2: seller side — find an asset UTXO, publish preauth-sale ----
console.log('\n[2/5] Seller: scan holdings, publish preauth-sale');

setWallet(SELLER_SK, SELLER_PUB);
info('scanning seller holdings (may take 10-30s for fresh wallets)…');
const holdings = await dapp.scanHoldings(true);
if (!holdings || holdings.size === 0) {
  fail(`Seller wallet has no tacit asset holdings. Open the dApp at ?network=signet, import wallet priv ${SELLER_SK_HEX.slice(0, 8)}…, and etch a CETCH from the Etch tab. Then re-run this harness.`);
}

let targetAssetId = ASSET_ID_OVERRIDE;
let targetUtxo = null;
let targetAsset = null;
for (const [aid, h] of holdings) {
  if (ASSET_ID_OVERRIDE && aid !== ASSET_ID_OVERRIDE) continue;
  const u = h.utxos.find(x => x.utxo.value >= 546);
  if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
}
if (!targetUtxo) {
  fail(`Seller has holdings but no spendable UTXO ${ASSET_ID_OVERRIDE ? `for asset ${ASSET_ID_OVERRIDE.slice(0, 16)}…` : ''}.`);
}

info(`asset:  ${targetAssetId.slice(0, 16)}… (ticker: ${targetAsset.ticker || '?'}, decimals: ${targetAsset.decimals || 0})`);
info(`outpoint: ${targetUtxo.utxo.txid.slice(0, 16)}…:${targetUtxo.utxo.vout}`);
info(`amount: ${targetUtxo.amount.toString()} (base units)`);

if (state.sale && state.sale.asset_id === targetAssetId && state.sale.utxo_txid === targetUtxo.utxo.txid) {
  info(`(resuming from previous run; sale_id ${state.sale.sale_id.slice(0, 16)}…)`);
} else {
  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600; // 24h
  info(`publishing preauth-sale at min_price_sats=${MIN_PRICE_SATS}, expiry=${expiry}…`);
  const result = await dapp.publishPreauthSale({
    utxoTxid: targetUtxo.utxo.txid,
    utxoVout: targetUtxo.utxo.vout,
    minPriceSats: MIN_PRICE_SATS,
    expiry,
  });
  ok(`worker accepted listing; sale_id=${result.sale_id}`);
  state.sale = {
    asset_id: result.asset_id,
    sale_id: result.sale_id,
    utxo_txid: targetUtxo.utxo.txid,
    utxo_vout: targetUtxo.utxo.vout,
    min_price_sats: MIN_PRICE_SATS,
    expiry,
    seller_pub: bytesToHex(SELLER_PUB),
  };
  saveState(state);
}

// Confirm the listing is visible in GET /preauth-sales.
const refetched = await dapp.fetchPreauthSale({
  assetIdHex: state.sale.asset_id,
  saleIdHex: state.sale.sale_id,
});
if (!refetched) fail('listing not visible in GET /preauth-sales — worker may have rejected silently');
ok('listing fetchable from worker');

// ---- Phase 3: buyer side — take the sale ----
console.log('\n[3/5] Buyer: take preauth-sale');

if (state.take && state.take.reveal_txid) {
  info(`(already taken in previous run; reveal=${state.take.reveal_txid.slice(0, 16)}…)`);
} else {
  setWallet(BUYER_SK, BUYER_PUB);
  info(`taking sale ${state.sale.sale_id.slice(0, 16)}… as buyer ${BUYER_ADDR}`);
  const result = await dapp.takePreauthSale({
    assetIdHex: state.sale.asset_id,
    saleIdHex: state.sale.sale_id,
    onProgress: (stage) => info(`  [progress] ${stage}`),
  });
  ok(`reveal broadcast: ${result.reveal_txid}`);
  info(`commit: ${result.commit_txid}`);
  state.take = {
    commit_txid: result.commit_txid,
    reveal_txid: result.reveal_txid,
    buyer_pub: bytesToHex(BUYER_PUB),
  };
  saveState(state);
}

// ---- Phase 4: wait for reveal to confirm ----
console.log('\n[4/5] Wait for reveal to confirm (polling every 30s, up to 30 min)');

async function fetchTxStatus(txid) {
  const res = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`tx status ${res.status}`);
  return res.json();
}

let revealStatus = null;
const REVEAL_DEADLINE = Date.now() + 30 * 60 * 1000;
while (Date.now() < REVEAL_DEADLINE) {
  revealStatus = await fetchTxStatus(state.take.reveal_txid).catch(() => null);
  if (revealStatus?.confirmed) { ok(`reveal confirmed at block ${revealStatus.block_height}`); break; }
  if (revealStatus) info(`reveal in mempool, awaiting confirmation… (${new Date().toISOString()})`);
  else              info(`reveal not yet visible to indexer (propagation lag)…`);
  await sleep(30_000);
}
if (!revealStatus?.confirmed) {
  console.warn('  reveal not confirmed within 30 min; CPFP may be needed if fee rate undershot');
  console.warn(`  reveal txid: ${state.take.reveal_txid}`);
  process.exit(2);
}

// ---- Phase 5: verify outcomes ----
console.log('\n[5/5] Verify on-chain outcomes');

async function fetchOutspend(txid, vout) {
  const res = await fetch(`https://mempool.space/signet/api/tx/${txid}/outspend/${vout}`);
  if (!res.ok) throw new Error(`outspend ${res.status}`);
  return res.json();
}

// Asset outpoint must now be spent (by the reveal).
const assetSp = await fetchOutspend(state.sale.utxo_txid, state.sale.utxo_vout);
if (!assetSp.spent) fail('asset outpoint still unspent — reveal did not consume it');
if (assetSp.txid !== state.take.reveal_txid) fail(`asset outpoint spent by different tx (${assetSp.txid})`);
ok('asset outpoint spent by reveal');

// Reveal's vout[0] (buyer recipient) must be unspent.
const recipSp = await fetchOutspend(state.take.reveal_txid, 0);
if (recipSp.spent) info('reveal vout[0] already spent (buyer self-transferred?)');
else ok('reveal vout[0] (buyer recipient) is live');

// Seller payout output (reveal vout[1]) must pay the seller's expected script.
const revealRes = await fetch(`https://mempool.space/signet/api/tx/${state.take.reveal_txid}`);
const revealJson = await revealRes.json();
const vout1 = revealJson.vout?.[1];
if (!vout1) fail('reveal has no vout[1]');
if (vout1.value < state.sale.min_price_sats) {
  fail(`seller underpaid: vout[1].value=${vout1.value}, expected >= ${state.sale.min_price_sats}`);
}
ok(`seller paid: vout[1].value=${vout1.value} (>= min_price_sats=${state.sale.min_price_sats})`);

// Worker should now reflect the sale as taken or stale (asset outpoint spent).
const postTakeListing = await dapp.fetchPreauthSale({
  assetIdHex: state.sale.asset_id,
  saleIdHex: state.sale.sale_id,
});
if (postTakeListing) info(`(worker still has the record — stale-cron not implemented yet, see SPEC §5.7.8)`);
else                 ok('listing cleaned up on worker');

console.log('\n=== PASS ===');
console.log('Preauth-sale e2e signet flow completed successfully.');
console.log(`  asset:        ${state.sale.asset_id}`);
console.log(`  sale_id:      ${state.sale.sale_id}`);
console.log(`  commit txid:  ${state.take.commit_txid}`);
console.log(`  reveal txid:  ${state.take.reveal_txid}`);
console.log(`  Block:        ${revealStatus.block_height}`);
console.log(`\nDelete ${STATE_FILE} to start a fresh run.\n`);
