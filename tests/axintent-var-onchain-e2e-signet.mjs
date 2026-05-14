// End-to-end signet harness for §5.7.6.1 variable-amount atomic intents.
//
// Drives the full builder loop against the live worker on signet:
//
//   1. Verify both wallets are funded (faucet-fed).
//   2. Ensure seller has an asset UTXO with amount > min_take_amount.
//      If not, etch a 1000-base-unit TESTVAR (decimals=0) test asset.
//   3. Seller publishAxferVarIntent (no commit broadcast — deferred).
//   4. Taker claimAxferVarIntent (claim_msg_v3 with requested_amount).
//   5. Seller fulfilAxferVarIntent (builds commit_tx UNBROADCAST +
//      partial_reveal + OP_RETURN(80) dual recovery; POSTs to worker).
//   6. Taker finalizeAxferVarTake (verifies partial_reveal under
//      maker_pubkey, appends BTC funding + SIGHASH_ALL, POSTs to
//      /finalize). Worker performs sequential commit-then-reveal
//      broadcast.
//   7. Wait for reveal to confirm on chain.
//   8. Independently verify: taker holdings include requested_amount
//      under the asset_id, maker holdings include the change amount,
//      OP_RETURN(80) on-chain dual recovery decrypts cleanly for both
//      parties.
//
// State file at .local/axintent-var-signet-state.json is resumable.
//
// Reuses the existing axintent-signet-test-wallets.json (legacy seller +
// taker wallets) — the variable-amount flow doesn't need fresh wallets.
//
// Run: `node axintent-var-onchain-e2e-signet.mjs`

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

// LOAD-BEARING: flips the dapp's variable-amount feature flag for this
// harness only. The flag reads from globalThis at module load time and
// stays true for the lifetime of this Node process. Browser pages have no
// such global, so production behavior is unaffected.
globalThis.__TACIT_ENABLE_T_AXFER_VARIABLE = true;

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'axintent-var-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'axintent-signet-test-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}. Run the wallet generator first (or copy from the legacy harness setup).`);
}
const wallets = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const SELLER_SK = hexToBytes(wallets.seller.priv_hex);
const TAKER_SK  = hexToBytes(wallets.taker.priv_hex);
const SELLER_PUB = secp.getPublicKey(SELLER_SK, true);
const TAKER_PUB  = secp.getPublicKey(TAKER_SK, true);

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
  dapp.invalidateHoldingsCache();
}

setWallet(SELLER_SK, SELLER_PUB);
const SELLER_ADDR = dapp.wallet.address();
setWallet(TAKER_SK, TAKER_PUB);
const TAKER_ADDR = dapp.wallet.address();

console.log('=== axintent-var-onchain-e2e-signet (§5.7.6.1 builder) ===');
console.log(`  seller: ${SELLER_ADDR}`);
console.log(`  taker:  ${TAKER_ADDR}`);
console.log(`  state:  ${STATE_FILE}`);
console.log(`  feature flag: __TACIT_ENABLE_T_AXFER_VARIABLE = ${globalThis.__TACIT_ENABLE_T_AXFER_VARIABLE}\n`);

const state = loadState();

// ---- Phase 1: verify funding ----
console.log('[1/8] Verify funding');
async function balance(addr) {
  const res = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  if (!res.ok) throw new Error(`addr fetch ${res.status}`);
  const j = await res.json();
  const c = j.chain_stats || {};
  const m = j.mempool_stats || {};
  return (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
}
const sb = await balance(SELLER_ADDR);
const tb = await balance(TAKER_ADDR);
info(`seller: ${sb} sats`);
info(`taker:  ${tb} sats`);
// Variable-amount needs more seller balance because the maker funds the
// commit tx + the reveal fee at fulfilment time (unlike legacy which
// pre-broadcasts the commit at publish).
if (sb < 15_000) fail(`seller needs ≥15k sats (has ${sb}) — fund signet wallet at https://signetfaucet.com or https://signet.bublina.eu.org`);
if (tb < 50_000) fail(`taker needs ≥50k sats (has ${tb}) — fund signet wallet at https://signetfaucet.com or https://signet.bublina.eu.org`);
ok('both wallets funded');

// ---- Phase 2: seller asset holdings ----
console.log('\n[2/8] Seller asset holdings (need amount > 1 for partial fill)');
setWallet(SELLER_SK, SELLER_PUB);
let holdings = await dapp.scanHoldings(true);
let targetAssetId = null;
let targetUtxo = null;
let targetAsset = null;
// Variable-amount needs amount > 1 (≥ 2 base units so min_take ≥ 1 and
// requested < amount works as a non-degenerate split).
for (const [aid, h] of holdings) {
  const u = h.utxos.find(x => x.utxo.value >= 546 && x.amount > 1n);
  if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
}
if (!targetUtxo) {
  if (state.etch?.reveal_txid) {
    info(`(resuming) prior etch reveal ${state.etch.reveal_txid.slice(0,16)}… — waiting for confirm + re-scan`);
    const etchDeadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < etchDeadline && !targetUtxo) {
      const s = await fetch(`https://mempool.space/signet/api/tx/${state.etch.reveal_txid}/status`).then(r => r.json()).catch(() => null);
      if (s?.confirmed) {
        ok(`etch reveal confirmed at block ${s.block_height}`);
        dapp.invalidateHoldingsCache();
        holdings = await dapp.scanHoldings(true);
        for (const [aid, h] of holdings) {
          const u = h.utxos.find(x => x.utxo.value >= 546 && x.amount > 1n);
          if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
        }
        break;
      }
      info(`  awaiting etch confirmation…`);
      await sleep(30_000);
    }
  }
}
if (!targetUtxo) {
  info('seller has no usable asset — etching 1000 TESTVAR (decimals=0) for variable-amount harness');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'TESTVAR', supplyBase: 1000n, decimals: 0,
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
    const u = h.utxos.find(x => x.utxo.value >= 546 && x.amount > 1n);
    if (u) { targetAssetId = aid; targetUtxo = u; targetAsset = h; break; }
  }
  if (!targetUtxo) fail('still no asset after etch confirm — investigate');
}
info(`asset: ${targetAssetId.slice(0,16)}… (${targetAsset.ticker})`);
info(`utxo:  ${targetUtxo.utxo.txid.slice(0,16)}…:${targetUtxo.utxo.vout} (amount=${targetUtxo.amount})`);
ok('seller has spendable asset UTXO');

// ---- Phase 3: publish VARIABLE-AMOUNT atomic intent ----
console.log('\n[3/8] Seller: publish variable-amount intent (NO commit broadcast — deferred)');
const AMOUNT_BI = targetUtxo.amount;
const MIN_TAKE  = (AMOUNT_BI / 10n).toString();     // 10% floor
const REQUESTED = (AMOUNT_BI * 3n / 10n).toString(); // 30% take (taker chooses)
const PRICE_SATS = 20_000;                            // for the full listed amount
const EXPIRY = Math.floor(Date.now() / 1000) + 24 * 3600;
const SECRETS_KEY = `tacit-axintent-secrets-v1:signet`;

if (state.intent?.intent_id && state.intent.secrets_blob) {
  info(`(resuming) intent ${state.intent.intent_id.slice(0,16)}… — restoring localStorage`);
  globalThis.localStorage.setItem(SECRETS_KEY, state.intent.secrets_blob);
} else if (!state.intent?.intent_id) {
  setWallet(SELLER_SK, SELLER_PUB);
  try {
    const r = await dapp.publishAxferVarIntent({
      utxoTxid: targetUtxo.utxo.txid,
      utxoVout: targetUtxo.utxo.vout,
      priceSats: PRICE_SATS,
      expiry: EXPIRY,
      minTakeAmount: MIN_TAKE,
      onProgress: (s) => info(`  [pub] ${s}`),
    });
    state.intent = {
      intent_id: r.intent_id,
      asset_id: r.asset_id,
      amount: r.amount,
      min_take_amount: r.min_take_amount,
      price_sats: PRICE_SATS,
      expiry: EXPIRY,
      secrets_blob: globalThis.localStorage.getItem(SECRETS_KEY) || '',
    };
    saveState(state);
    ok(`intent published: ${r.intent_id.slice(0,16)}… (no on-chain activity)`);
    ok(`  amount=${r.amount}, min_take=${r.min_take_amount}, price=${PRICE_SATS} sats`);
  } catch (e) {
    fail(`publishAxferVarIntent failed: ${e.message}`);
  }
}

// ---- Phase 4: taker claims with requested_amount ----
console.log(`\n[4/8] Taker: claim intent with requested_amount=${REQUESTED}`);
setWallet(TAKER_SK, TAKER_PUB);
// Pull the intent from the worker so claimAxferVarIntent has the
// canonical record (it needs amount + price + min_take_amount).
const WORKER = 'https://tacit-pin.rosscampbell9.workers.dev';
async function loadIntent() {
  const r = await fetch(`${WORKER}/assets/${state.intent.asset_id}/atomic-intents?network=signet`);
  if (!r.ok) fail(`could not list intents (HTTP ${r.status})`);
  const j = await r.json();
  const i = (j.intents || []).find(x => x.intent_id === state.intent.intent_id);
  if (!i) fail(`our intent ${state.intent.intent_id} not in worker list`);
  return i;
}
const intent = await loadIntent();
info(`worker confirms intent: amount=${intent.amount}, min_take=${intent.min_take_amount}, state=${intent.state}`);

if (state.claim?.claimed_at) {
  info(`(resuming) claim already placed at ${new Date(state.claim.claimed_at * 1000).toISOString()}`);
} else {
  const c = await dapp.claimAxferVarIntent({
    assetIdHex: state.intent.asset_id,
    intentIdHex: state.intent.intent_id,
    intent,
    requestedAmount: REQUESTED,
  });
  state.claim = { claimed_at: Math.floor(Date.now() / 1000), claim: c.claim || c };
  saveState(state);
  ok(`claim accepted by worker (requested_amount=${REQUESTED})`);
  ok(`  scaled BTC payment: ${Math.floor(Number(REQUESTED) * PRICE_SATS / Number(AMOUNT_BI))} sats`);
}

// ---- Phase 5: seller fulfils (builds commit_tx UNBROADCAST + partial_reveal) ----
console.log('\n[5/8] Seller: fulfil — build commit_tx (UNBROADCAST) + partial_reveal');
setWallet(SELLER_SK, SELLER_PUB);
// Restore localStorage so fulfilAxferVarIntent finds the per-intent `r`
// secret saved at publish time.
globalThis.localStorage.setItem(SECRETS_KEY, state.intent.secrets_blob);

const claim = state.claim?.claim;
if (!claim || !claim.taker_pubkey || !claim.requested_amount) fail('cached claim body missing taker_pubkey or requested_amount');

if (state.fulfil?.posted) {
  info(`(resuming) fulfilment already posted`);
} else {
  const f = await dapp.fulfilAxferVarIntent({
    assetIdHex: state.intent.asset_id,
    intentIdHex: state.intent.intent_id,
    intent,
    claim,
  });
  state.fulfil = { posted: true, response: f };
  saveState(state);
  ok('fulfilment posted to worker (state should be COMMIT_READY)');
}

// ---- Phase 6: taker downloads + finalizes (verifies, signs funding, POSTs /finalize) ----
console.log('\n[6/8] Taker: finalize — verify partial_reveal, append funding, POST /finalize');
setWallet(TAKER_SK, TAKER_PUB);
if (state.finalize?.broadcast) {
  info(`(resuming) /finalize already POSTed`);
  info(`  commit_txid: ${state.finalize.commit_txid}`);
  info(`  reveal_txid: ${state.finalize.reveal_txid}`);
} else {
  const fulfilmentResp = await dapp.fetchAxferFulfilment({
    assetIdHex: state.intent.asset_id,
    intentIdHex: state.intent.intent_id,
  });
  if (!fulfilmentResp) fail('worker has no fulfilment record');
  const finalized = await dapp.finalizeAxferVarTake({
    assetIdHex: state.intent.asset_id,
    intentIdHex: state.intent.intent_id,
    intent,
    fulfilment: fulfilmentResp,
    onProgress: (s) => info(`  [final] ${s}`),
  });
  state.finalize = {
    broadcast: true,
    commit_txid: finalized.commit_txid,
    reveal_txid: finalized.reveal_txid,
    explorer: finalized.explorer,
  };
  saveState(state);
  ok(`worker broadcast sequential pair:`);
  ok(`  commit:  ${finalized.commit_txid}`);
  ok(`  reveal:  ${finalized.reveal_txid}`);
  if (finalized.explorer) {
    info(`  → ${finalized.explorer.commit}`);
    info(`  → ${finalized.explorer.reveal}`);
  }
}

// ---- Phase 7: wait for reveal to confirm ----
console.log('\n[7/8] Wait for reveal to confirm (polling every 30s, up to 30 min)');
const deadline = Date.now() + 30 * 60 * 1000;
let revealStatus = null;
while (Date.now() < deadline) {
  revealStatus = await fetch(`https://mempool.space/signet/api/tx/${state.finalize.reveal_txid}/status`).then(r => r.json()).catch(() => null);
  if (revealStatus?.confirmed) { ok(`reveal confirmed at block ${revealStatus.block_height}`); break; }
  info(`  awaiting confirmation… (mempool? ${revealStatus ? 'yes' : 'not visible yet'})`);
  await sleep(30_000);
}
if (!revealStatus?.confirmed) fail('reveal not confirmed within 30 min');

// ---- Phase 8: verify holdings (taker received requested, maker received change) ----
console.log('\n[8/8] Verify variable-amount settlement on chain');

const revealTx = await fetch(`https://mempool.space/signet/api/tx/${state.finalize.reveal_txid}`).then(r => r.json());
info(`reveal has ${revealTx.vout.length} vouts:`);
for (let i = 0; i < Math.min(revealTx.vout.length, 6); i++) {
  const v = revealTx.vout[i];
  info(`  vout[${i}] value=${v.value} spk=${v.scriptpubkey.slice(0, 16)}…(${v.scriptpubkey.length / 2}B)`);
}
// vout[3] MUST be OP_RETURN(80) per §5.7.6.1 *On-chain recovery*.
// Standard relay encoding: 6a (OP_RETURN) || 4c (OP_PUSHDATA1) || 50 (=80) || <80 bytes>.
const op80 = revealTx.vout[3];
if (!op80 || !op80.scriptpubkey.startsWith('6a4c50')) {
  fail(`vout[3] is not OP_RETURN(80) (got prefix ${op80?.scriptpubkey.slice(0, 6)}); SPEC §5.7.6.1 violated`);
}
ok(`vout[3] = OP_RETURN(80) dual-recovery payload`);

// Taker holdings — scan from chain alone (uses on-chain OP_RETURN recovery)
setWallet(TAKER_SK, TAKER_PUB);
dapp.invalidateHoldingsCache();
const takerHoldings = await dapp.scanHoldings(true);
const tHold = takerHoldings.get(state.intent.asset_id);
if (!tHold) fail(`taker has no holdings for asset ${state.intent.asset_id.slice(0,16)}…`);
const takerRecip = tHold.utxos.find(u => u.utxo.txid === state.finalize.reveal_txid && u.utxo.vout === 0);
if (!takerRecip) {
  info(`taker holdings for ${state.intent.asset_id.slice(0,16)}…: balance=${tHold.balance} utxos=${tHold.utxos.length} ghosts=${tHold.ghosts.length}`);
  fail('taker recipient UTXO not found at vout[0]');
}
if (String(takerRecip.amount) !== REQUESTED) {
  fail(`taker received ${takerRecip.amount}, expected ${REQUESTED}`);
}
ok(`taker received ${takerRecip.amount} at vout[0] (matches requested_amount)`);

// Maker change — must appear at vout[2]
setWallet(SELLER_SK, SELLER_PUB);
dapp.invalidateHoldingsCache();
const sellerHoldings = await dapp.scanHoldings(true);
const sHold = sellerHoldings.get(state.intent.asset_id);
if (!sHold) fail(`seller has no holdings for asset ${state.intent.asset_id.slice(0,16)}…`);
const sellerChange = sHold.utxos.find(u => u.utxo.txid === state.finalize.reveal_txid && u.utxo.vout === 2);
if (!sellerChange) {
  info(`seller holdings for ${state.intent.asset_id.slice(0,16)}…: balance=${sHold.balance} utxos=${sHold.utxos.length} ghosts=${sHold.ghosts.length}`);
  fail('seller change UTXO not found at vout[2]');
}
const expectedChange = (BigInt(AMOUNT_BI) - BigInt(REQUESTED)).toString();
if (String(sellerChange.amount) !== expectedChange) {
  fail(`seller change ${sellerChange.amount}, expected ${expectedChange}`);
}
ok(`seller change ${sellerChange.amount} at vout[2] (matches amount − requested = ${expectedChange})`);

// Conservation: requested + change == amount (closes Pedersen invariant at openings level)
if (BigInt(takerRecip.amount) + BigInt(sellerChange.amount) !== BigInt(AMOUNT_BI)) {
  fail(`conservation violation: ${takerRecip.amount} + ${sellerChange.amount} != ${AMOUNT_BI}`);
}
ok(`conservation holds: ${takerRecip.amount} + ${sellerChange.amount} = ${AMOUNT_BI}`);

console.log('\n========== SUCCESS ==========');
console.log(`  reveal tx:        ${state.finalize.reveal_txid}`);
console.log(`  commit tx:        ${state.finalize.commit_txid}`);
console.log(`  asset:            ${state.intent.asset_id}`);
console.log(`  listed amount:    ${AMOUNT_BI}`);
console.log(`  min_take:         ${MIN_TAKE}`);
console.log(`  requested take:   ${REQUESTED}  → vout[0] (DUST P2WPKH taker)`);
console.log(`  maker change:     ${expectedChange}  → vout[2] (DUST P2WPKH maker)`);
console.log(`  scaled BTC paid:  ${Math.floor(Number(REQUESTED) * PRICE_SATS / Number(AMOUNT_BI))} sats → vout[1] (maker)`);
console.log(`  on-chain payload: OP_RETURN(80) dual recovery → vout[3]`);
console.log(`\n  Validates: SPEC §5.7.6.1 + §5.7.9 builder end-to-end, A′ deferred-commit flow,`);
console.log(`  worker /finalize sequential broadcast, dual-party seed-only recovery.`);
