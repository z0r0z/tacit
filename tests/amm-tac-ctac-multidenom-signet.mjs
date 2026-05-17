// Multi-denomination TAC/cBTC.tac AMM pool sweep on signet.
//
// Same end-to-end flow as amm-tac-ctac-pool-signet.mjs (slot mint →
// cBTC.tac deposit → POOL_INIT → swap → LP_REMOVE) but parametrized
// to test multiple cBTC.tac denomination tiers in sequence. Each tier
// produces its own pool at the corresponding cBTC.tac variant
// asset_id.
//
// Critically: this run does NOT install _testSetScanHoldingsOverride.
// The 968039d harness used the override to inject the cBTC.tac UTXO
// because the dapp's scanHoldings didn't yet recognize them. Commit
// d97d75e wired that recognition into scanHoldings via the
// localStorage position record. This harness validates the cold path
// works end-to-end: a depositor with the position record in storage
// can use cBTC.tac UTXOs as AMM inputs through the normal carveExactAmount
// pipeline.
//
// Phases (per denom, resumable via .local/amm-tac-ctac-md-<denom>-state.json):
//   1. Pre-flight (sats + TAC balance)
//   2. T_SLOT_MINT (cBTC.zk @ DENOM sats)
//   3. T_CBTC_TAC_DEPOSIT (slot + bond → cBTC.tac.<denom> UTXO)
//   4. Verify scanHoldings picks up the cBTC.tac UTXO
//   5. T_LP_ADD variant 1 — POOL_INIT (TAC/cBTC.tac.<denom> at fee_bps)
//
// Run:
//   SLOT_DENOM_SATS=10000  node tests/amm-tac-ctac-multidenom-signet.mjs
//   SLOT_DENOM_SATS=100000 node tests/amm-tac-ctac-multidenom-signet.mjs

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

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const WALLET_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');
const CTAC_STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-state.json');

function loadJson(p, fallback = {}) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function saveState(file, s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) fail(`missing ${WALLET_FILE}`);
const wallets = loadJson(WALLET_FILE);
const DEP_SK = hexToBytes(wallets.depositor.priv_hex);
const DEP_PUB = secp.getPublicKey(DEP_SK, true);
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(DEP_PUB), '1'); } catch {}
dapp.wallet.priv = DEP_SK;
dapp.wallet.pub = DEP_PUB;
dapp.invalidateHoldingsCache();
const DEP_ADDR = dapp.wallet.address();

const ctacState = loadJson(CTAC_STATE_FILE);
const TAC_ASSET_ID = ctacState.tacAssetIdHex;
if (!TAC_ASSET_ID) fail(`missing PINE asset_id from ${CTAC_STATE_FILE}`);

const SLOT_DENOM_SATS = BigInt(process.env.SLOT_DENOM_SATS || 10_000);
const BOND_AMOUNT_TAC = BigInt(process.env.BOND_AMOUNT_TAC || (SLOT_DENOM_SATS / 2n));
const POOL_DELTA_TAC  = BigInt(process.env.POOL_DELTA_TAC  || SLOT_DENOM_SATS);
const POOL_DELTA_CTAC = SLOT_DENOM_SATS;
const FEE_BPS = Number(process.env.FEE_BPS || 30);

const STATE_FILE = path.join(STATE_DIR, `amm-tac-ctac-md-${SLOT_DENOM_SATS}-state.json`);
const state = loadJson(STATE_FILE);
const ctacAssetId = dapp.ctacVariantAssetId(SLOT_DENOM_SATS);

console.log(`=== amm-tac-ctac-multidenom-signet (denom=${SLOT_DENOM_SATS}) ===`);
console.log(`  depositor:           ${DEP_ADDR}`);
console.log(`  cBTC.tac variant:    ${ctacAssetId.slice(0, 16)}…`);
console.log(`  pool delta_TAC:      ${POOL_DELTA_TAC}`);
console.log(`  pool delta_cBTC.tac: ${POOL_DELTA_CTAC}`);
console.log(`  state:               ${STATE_FILE}`);

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight');
const addrInfo = await (await fetch(`https://mempool.space/signet/api/address/${DEP_ADDR}`)).json();
const sats = (addrInfo.chain_stats?.funded_txo_sum ?? 0) - (addrInfo.chain_stats?.spent_txo_sum ?? 0)
           + (addrInfo.mempool_stats?.funded_txo_sum ?? 0) - (addrInfo.mempool_stats?.spent_txo_sum ?? 0);
const needSats = Number(SLOT_DENOM_SATS) + 25_000;
info(`depositor BTC: ${sats.toLocaleString()} sats (need ≥ ${needSats.toLocaleString()})`);
if (sats < needSats && !state.slotRecord) fail(`underfunded for denom ${SLOT_DENOM_SATS}`);

const holdings0 = await dapp.scanHoldings();
const tacHold = holdings0.get(TAC_ASSET_ID);
info(`PINE balance: ${tacHold?.balance ?? 0}`);
if (!tacHold || tacHold.balance < (POOL_DELTA_TAC + BOND_AMOUNT_TAC)) {
  fail(`need ≥ ${POOL_DELTA_TAC + BOND_AMOUNT_TAC} PINE, have ${tacHold?.balance ?? 0}`);
}
ok(`pre-flight passed`);

// ---- Phase 2: slot mint ----
step(2, `T_SLOT_MINT @ ${SLOT_DENOM_SATS} sats`);
let slotRecord;
if (state.slotRecord) {
  ok(`reusing prior slot: ${state.slotRecord.leafCommitmentHex.slice(0, 16)}…`);
  slotRecord = state.slotRecord;
} else {
  const res = await dapp.buildAndBroadcastSlotMint({
    assetIdHex: ctacAssetId,
    denomination: SLOT_DENOM_SATS,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`slot broadcast: reveal ${res.revealTxid.slice(0, 16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  const recs = dapp.getSlotRecords();
  slotRecord = recs.find(r => r.mintTxid === res.revealTxid);
  if (!slotRecord) fail('slot record missing post-mint');
  state.slotRecord = slotRecord;
  saveState(STATE_FILE, state);
}

// ---- Phase 3: cBTC.tac deposit ----
step(3, `T_CBTC_TAC_DEPOSIT (slot + ${BOND_AMOUNT_TAC} TAC bond)`);
let positionRecord;
if (state.positionRecord) {
  ok(`reusing prior position: ${state.positionRecord.status}`);
  positionRecord = state.positionRecord;
} else {
  const res = await dapp.buildAndBroadcastCbtcTacDeposit({
    slotRecord,
    bondAmountTAC: BOND_AMOUNT_TAC,
    tacAssetIdHex: TAC_ASSET_ID,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`deposit broadcast: reveal ${res.revealTxid.slice(0, 16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  const positions = dapp.getCtacPositionRecords();
  positionRecord = positions.find(p => p.depositRevealTxid === res.revealTxid);
  if (!positionRecord) fail('position record missing post-deposit');
  state.positionRecord = positionRecord;
  saveState(STATE_FILE, state);
}

// ---- Phase 4: verify scanHoldings recognizes cBTC.tac UTXO ----
step(4, 'verify scanHoldings recognizes the cBTC.tac UTXO (no override)');
// Wait a bit more if needed for indexer + cron pickup.
info(`waiting 60s for worker cron + indexer pickup…`);
await sleep(60_000);
dapp.invalidateHoldingsCache();
const holdings = await dapp.scanHoldings(true);
const ctacHold = holdings.get(ctacAssetId.toLowerCase());
if (!ctacHold || ctacHold.balance === 0n) {
  fail(`scanHoldings did NOT pick up cBTC.tac UTXO for variant ${ctacAssetId.slice(0, 16)}…`);
}
const expectedUtxo = ctacHold.utxos.find(u =>
  u.utxo.txid === positionRecord.depositRevealTxid && u.utxo.vout === 0,
);
if (!expectedUtxo) {
  fail(`scanHoldings did not include the expected UTXO ${positionRecord.depositRevealTxid.slice(0, 16)}…:0 (got ${ctacHold.utxos.length} other UTXOs)`);
}
ok(`scanHoldings sees cBTC.tac UTXO: balance=${ctacHold.balance}, ${ctacHold.utxos.length} UTXO(s)`);
ok(`  matching mint UTXO: ${expectedUtxo.utxo.txid.slice(0, 16)}…:0, amount=${expectedUtxo.amount}`);

// ---- Phase 5: POOL_INIT (no override; tests cold scanHoldings path) ----
step(5, `T_LP_ADD variant 1 — POOL_INIT TAC/cBTC.tac.${SLOT_DENOM_SATS}`);
if (state.poolInit) {
  ok(`reusing prior POOL_INIT: ${state.poolInit.reveal_txid.slice(0, 16)}…`);
} else {
  const result = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: TAC_ASSET_ID,
    assetBIdHex: ctacAssetId,
    deltaA: POOL_DELTA_TAC,
    deltaB: POOL_DELTA_CTAC,
    feeBps: FEE_BPS,
    vkCid: 'bafyAmmV1Placeholder',
    ceremonyCid: 'bafyAmmCeremonyV1',
    poolCapabilityFlags: 0,
    poolMetaUri: '',
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`POOL_INIT broadcast`);
  info(`  reveal:         ${result.revealTxid}`);
  info(`  pool_id:        ${result.poolIdHex}`);
  info(`  founder_shares: ${result.founderShares}`);
  state.poolInit = {
    reveal_txid: result.revealTxid,
    pool_id_hex: result.poolIdHex,
    founder_shares: result.founderShares.toString(),
    deltaA: result.deltaA.toString(),
    deltaB: result.deltaB.toString(),
    fee_bps: FEE_BPS,
  };
  saveState(STATE_FILE, state);
}

console.log(`\n=== smoke complete (denom=${SLOT_DENOM_SATS}) ===`);
console.log(`pool_id:   ${state.poolInit.pool_id_hex}`);
console.log(`reveal:    https://mempool.space/signet/tx/${state.poolInit.reveal_txid}`);
console.log(`State preserved at ${STATE_FILE}.`);
