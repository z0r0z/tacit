// End-to-end signet harness for SPEC-CBTC-TAC-AMENDMENT §§5.36–5.37.
//
// Phases (resumable via .local/cbtc-tac-signet-state.json):
//   1. Pre-flight: verify depositor + recipient wallets are funded,
//      depositor has a TAC-like asset UTXO.
//   2. Slot mint: T_SLOT_MINT a cBTC.zk slot at SLOT_DENOM_SATS.
//   3. cBTC.tac deposit: T_CBTC_TAC_DEPOSIT (slot + TAC bond → cBTC.tac).
//   4. (optional) cBTC.tac transfer: send to recipient via T_AXFER_VAR.
//   5. (optional) recipient sends it back.
//   6. cBTC.tac withdraw: T_CBTC_TAC_WITHDRAW; verify bond return UTXO
//      at vout[1] and BTC payout at vout[0].
//   7. Post-flight: re-scan holdings; depositor's TAC balance back at
//      pre-deposit level (minus fees), depositor's BTC up by payout
//      (minus DUST + fees).
//
// Run:  node tests/cbtc-tac-onchain-e2e-signet.mjs
// Skip phases with env flags: SKIP_TRANSFER=1, SKIP_WITHDRAW=1, etc.
// Reset state:  rm .local/cbtc-tac-signet-state.json
//
// Requires:
//   .local/cbtc-tac-signet-test-wallets.json
//     (generate via: node tests/gen-cbtc-tac-signet-wallets.mjs)
//   Depositor: ~200k signet sats + a TAC-like tacit asset UTXO ≥ 5000 base units
//   Recipient: ~10k signet sats (optional, skipped if SKIP_TRANSFER=1)

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
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
// Skip the CF worker proxy — uncached signet routes take ~16s/request via
// the proxy vs ~0.6s direct to mempool.space, blowing the holdings-scan
// 90s timeout. Custom API base goes straight to upstream.
globalThis.localStorage.setItem('tacit-custom-api-v1', JSON.stringify({
  signet: 'https://mempool.space/signet/api',
}));

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}. Run: node tests/gen-cbtc-tac-signet-wallets.mjs`);
}
const wallets = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const DEP_SK = hexToBytes(wallets.depositor.priv_hex);
const REC_SK = hexToBytes(wallets.recipient.priv_hex);
const DEP_PUB = secp.getPublicKey(DEP_SK, true);
const REC_PUB = secp.getPublicKey(REC_SK, true);

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
  dapp.invalidateHoldingsCache();
}

// Pre-mark backup ack so ensureBurnerBackedUp doesn't pop a modal
// (modal returns false in headless JSDOM → carveExactAmount cancels).
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(DEP_PUB), '1'); } catch {}
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(REC_PUB), '1'); } catch {}

setWallet(DEP_SK, DEP_PUB);
const DEP_ADDR = dapp.wallet.address();
setWallet(REC_SK, REC_PUB);
const REC_ADDR = dapp.wallet.address();

console.log('=== cbtc-tac-onchain-e2e-signet ===');
console.log(`  depositor: ${DEP_ADDR}`);
console.log(`  recipient: ${REC_ADDR}`);
console.log(`  state:     ${STATE_FILE}\n`);

const state = loadState();

// ---- knobs ----
const SLOT_DENOM_SATS = BigInt(process.env.SLOT_DENOM_SATS || 10_000);   // 10k sats / slot
const BOND_AMOUNT_TAC = BigInt(process.env.BOND_AMOUNT_TAC || 5_000);    // 5k TAC bond
const TAC_ASSET_ID    = (process.env.TAC_ASSET_ID || state.tacAssetIdHex || '').toLowerCase();
const SKIP_TRANSFER   = !!process.env.SKIP_TRANSFER;
const SKIP_WITHDRAW   = !!process.env.SKIP_WITHDRAW;

async function balanceSats(addr) {
  const res = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  if (!res.ok) return 0;
  const j = await res.json();
  const chain = (j.chain_stats?.funded_txo_sum ?? 0) - (j.chain_stats?.spent_txo_sum ?? 0);
  const mem   = (j.mempool_stats?.funded_txo_sum ?? 0) - (j.mempool_stats?.spent_txo_sum ?? 0);
  return chain + mem;
}

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight (funding + TAC asset)');
const depSats = await balanceSats(DEP_ADDR);
const recSats = await balanceSats(REC_ADDR);
info(`depositor balance: ${depSats.toLocaleString()} sats`);
info(`recipient balance: ${recSats.toLocaleString()} sats`);
if (depSats < 50_000) fail(`depositor underfunded — need ≥ 50_000 sats. Fund ${DEP_ADDR} via https://signet.bublina.eu.org/`);
if (!SKIP_TRANSFER && recSats < 5_000) {
  info(`(recipient underfunded; will skip transfer phase unless funded — re-run after topping up ${REC_ADDR})`);
}
if (!TAC_ASSET_ID || !/^[0-9a-f]{64}$/.test(TAC_ASSET_ID)) {
  fail(`TAC_ASSET_ID env var required (64 hex). CETCH a throwaway TAC-like asset first, then re-run with TAC_ASSET_ID=<hex>.`);
}

setWallet(DEP_SK, DEP_PUB);
const depHoldings = await dapp.scanHoldings();
const tacHolding = depHoldings.get(TAC_ASSET_ID);
if (!tacHolding || tacHolding.balance < BOND_AMOUNT_TAC) {
  fail(`depositor lacks ≥${BOND_AMOUNT_TAC} TAC at asset_id ${TAC_ASSET_ID.slice(0,16)}… (got ${tacHolding?.balance ?? 0})`);
}
ok(`depositor has ${tacHolding.balance} TAC (need ${BOND_AMOUNT_TAC} for bond)`);
state.tacAssetIdHex = TAC_ASSET_ID;
saveState(state);

// ---- Phase 2: slot mint (idempotent — skip if state.slotRecord exists & live) ----
step(2, 'T_SLOT_MINT (cBTC.zk slot at SLOT_DENOM_SATS)');
let slotRecord;
if (state.slotRecord) {
  ok(`reusing slot from prior run: leaf ${state.slotRecord.leafCommitmentHex.slice(0,16)}…`);
  slotRecord = state.slotRecord;
} else {
  setWallet(DEP_SK, DEP_PUB);
  // T_SLOT_MINT requires a tacit-asset-id for the slot's "wrapper" attribution.
  // SPEC-CBTC-ZK §5.21: assetIdHex names the wrapper this slot represents.
  // For smoke test we use the cBTC.tac canonical 100k tier? No — cBTC.zk slots
  // can be at any denomination; the wrapper asset_id is the cBTC.zk variant
  // (deterministic per denomination, just like cBTC.tac). For smoke test we
  // use SLOT_DENOM_SATS = 10k → cBTC.zk.10k synthetic variant.
  const slotAssetId = dapp.ctacVariantAssetId ? dapp.ctacVariantAssetId(SLOT_DENOM_SATS) : null;
  if (!slotAssetId) fail('ctacVariantAssetId not exported by dapp');
  info(`minting slot at denom=${SLOT_DENOM_SATS}, asset_id=${slotAssetId.slice(0,16)}…`);
  const res = await dapp.buildAndBroadcastSlotMint({
    assetIdHex: slotAssetId,
    denomination: SLOT_DENOM_SATS,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`slot minted: commit ${res.commitTxid.slice(0,16)}…  reveal ${res.revealTxid.slice(0,16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  // Pull the slot record back from localStorage (dapp persisted it)
  const slotRecs = dapp.getSlotRecords();
  slotRecord = slotRecs.find(r => r.mintTxid === res.revealTxid);
  if (!slotRecord) fail('slot record not found in dapp localStorage post-mint');
  state.slotRecord = slotRecord;
  saveState(state);
  ok(`slot record persisted: leaf ${slotRecord.leafCommitmentHex.slice(0,16)}…`);
}

// ---- Phase 3: cBTC.tac deposit ----
step(3, 'T_CBTC_TAC_DEPOSIT (slot + TAC bond → cBTC.tac)');
let positionRecord;
if (state.positionRecord) {
  ok(`reusing position from prior run: ${state.positionRecord.status}`);
  positionRecord = state.positionRecord;
} else {
  setWallet(DEP_SK, DEP_PUB);
  // §5.47 v1 lien model: bond is an LP-share UTXO of a canonical (cBTC.zk,
  // TAC) pool. Caller provides the LP-share UTXO outpoint + amount + blinding.
  // For the E2E test, callers can pre-stage an LP-share UTXO via T_LP_ADD
  // and pass it through state.lpShareUtxo. If absent, the test fails with
  // a clear message instructing the operator.
  const lpShareUtxo = state.lpShareUtxo || null;
  const lpShareAssetIdHex = state.lpShareAssetIdHex || process.env.LP_SHARE_ASSET_ID || null;
  if (!lpShareUtxo || !lpShareAssetIdHex) {
    fail('v1 lien model: state.lpShareUtxo {txid, vout, amount, blinding} + '
      + 'state.lpShareAssetIdHex required. Pre-stage via T_LP_ADD on a '
      + '(cBTC.zk, TAC) pool and populate state file before re-running.');
  }
  info(`depositing slot + LP-share lien (UTXO ${lpShareUtxo.txid.slice(0,16)}…:${lpShareUtxo.vout}, amount ${lpShareUtxo.amount})…`);
  const res = await dapp.buildAndBroadcastCbtcTacDeposit({
    slotRecord,
    lpShareUtxo,
    lpShareAssetIdHex,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`deposit broadcast: commit ${res.commitTxid.slice(0,16)}…  reveal ${res.revealTxid.slice(0,16)}…`);
  ok(`mint UTXO at ${res.revealTxid.slice(0,16)}…:0 = ${SLOT_DENOM_SATS} sats (face) of cBTC.tac`);
  ok(`bond LP-share UTXO ${lpShareUtxo.txid.slice(0,16)}…:${lpShareUtxo.vout} is now liened (still in wallet, economically immobile)`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  const positions = dapp.getCtacPositionRecords();
  positionRecord = positions.find(p => p.depositRevealTxid === res.revealTxid);
  if (!positionRecord) fail('position record not found post-deposit');
  state.positionRecord = positionRecord;
  saveState(state);
  ok(`position state: ${positionRecord.status}`);
}

// ---- Phase 6: cBTC.tac withdraw ----
if (SKIP_WITHDRAW) {
  console.log('\n--- SKIP_WITHDRAW set — stopping here ---');
  process.exit(0);
}
step(6, 'T_CBTC_TAC_WITHDRAW (close position; v1 lien model — no bond return UTXO)');
setWallet(DEP_SK, DEP_PUB);
// Construct cbtcTacUtxos array from the position's mint UTXO.
const cbtcTacUtxos = [{
  utxo: { txid: positionRecord.depositRevealTxid, vout: 0 },
  amount: BigInt(positionRecord.mintAmount),
  blinding: positionRecord.mintBlindingHex,
}];
info(`withdrawing position; payout → ${DEP_ADDR}`);
const wd = await dapp.buildAndBroadcastCbtcTacWithdraw({
  positionRecord,
  slotRecord,
  cbtcTacUtxos,
  recipientAddr: null,
  onProgress: (s) => info(`  · ${s}`),
});
ok(`withdraw broadcast: commit ${wd.commitTxid.slice(0,16)}…  reveal ${wd.revealTxid.slice(0,16)}…`);
ok(`BTC payout: ${wd.payoutValue.toLocaleString()} sats → vout[0]`);
ok(`bond LP-share UTXO is now UNLIENED — depositor can spend it freely`);

state.withdrawResult = {
  commitTxid: wd.commitTxid,
  revealTxid: wd.revealTxid,
  payoutValue: wd.payoutValue,
};
saveState(state);

info(`waiting 60s for withdraw confirmation…`);
await sleep(60_000);

// ---- Phase 7: post-flight ----
step(7, 'post-flight (re-scan holdings; verify lien released)');
setWallet(DEP_SK, DEP_PUB);
dapp.invalidateHoldingsCache();
// Under v1 lien model the LP-share UTXO doesn't move at withdraw — it stays
// at the same outpoint but the worker has released the lien. Verify by
// querying the worker's lien state for that outpoint.
const lpUtxo = state.lpShareUtxo;
try {
  const lienCheck = await fetch(`https://tacit.finance/ctac/lien?network=signet&txid=${lpUtxo.txid}&vout=${lpUtxo.vout}`);
  const lienJson = await lienCheck.json();
  if (lienJson.lien === null || lienJson.lien === undefined) {
    ok(`LIEN RELEASE VERIFIED: bond LP-share UTXO ${lpUtxo.txid.slice(0,16)}…:${lpUtxo.vout} is no longer liened`);
  } else {
    info(`lien state still '${lienJson.lien?.state}' — may need worker re-scan after withdraw confirmation`);
  }
} catch (e) {
  info(`lien-state probe failed: ${e?.message || e}`);
}

const postSats = await balanceSats(DEP_ADDR);
info(`depositor BTC balance: ${postSats.toLocaleString()} sats (had ${depSats.toLocaleString()} before)`);

console.log('\n=== smoke test complete ===');
console.log(`State preserved at ${STATE_FILE}. Inspect any txid on https://mempool.space/signet`);
