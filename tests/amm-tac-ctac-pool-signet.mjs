// TAC/cBTC.tac AMM pool signet smoke.
//
// Validates the production asset pair: PINE (a TAC-like CETCH used as
// stand-in for canonical TAC) on one side, cBTC.tac.40k (the 40_000-sat
// denomination tier of cBTC.tac) on the other. This is the asset pair
// users will actually trade and LP into post-launch.
//
// Mirrors the synthetic-asset LP cycle smoke (amm-lp-cycle-signet.mjs)
// but uses real-shape assets, exercising the full "sats → LP position"
// path the user landed in their ask:
//
//   sats → (slot mint) → cBTC.zk slot
//        → (cBTC.tac deposit + TAC bond) → fungible cBTC.tac.40k UTXO
//        → (POOL_INIT)                    → AMM founder LP position
//        → (swap)                         → price discovery
//        → (LP_REMOVE)                    → recover proportional reserves
//
// Phases (resumable via .local/amm-tac-ctac-pool-state.json):
//   1. Pre-flight (sats + TAC balance + cBTC.tac.40k variant asset_id)
//   2. Slot mint (cBTC.zk @ 40k sats denom, asset_id = ctacVariantAssetId(40_000))
//   3. cBTC.tac deposit (slot + 20k TAC bond → 40k cBTC.tac.40k UTXO)
//   4. POOL_INIT (TAC/cBTC.tac.40k @ fee_bps=30, reserves 40k/40k)
//   5. Swap test (5k TAC → cBTC.tac via T_SWAP_VAR; verify pricing)
//   6. LP_REMOVE (burn founder shares; verify proportional withdrawal)
//
// We deliberately do NOT attempt the cBTC.tac withdraw back to sats
// at the end: that path is validated separately by
// cbtc-tac-onchain-e2e-signet.mjs. This harness's job is the AMM-side
// proof that cBTC.tac slots in as a normal AMM asset.
//
// Run:  node tests/amm-tac-ctac-pool-signet.mjs
// Reset: rm .local/amm-tac-ctac-pool-state.json
//
// Requires:
//   .local/cbtc-tac-signet-test-wallets.json (depositor wallet)
//   .local/cbtc-tac-signet-state.json        (PINE asset_id from prior bootstrap)
//   Depositor: ≥ 80k signet sats + ≥ 60k PINE (≈20k bond + 40k pool reserve)

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
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'amm-tac-ctac-pool-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');
const CTAC_STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-state.json');

function loadJson(p, fallback = {}) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
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
if (!ctacState.tacAssetIdHex) {
  fail(`expected .local/cbtc-tac-signet-state.json with tacAssetIdHex set. Run:\n   node tests/cbtc-tac-bootstrap-tac-asset.mjs`);
}
const TAC_ASSET_ID = ctacState.tacAssetIdHex;  // PINE = TAC stand-in

const SLOT_DENOM_SATS = BigInt(process.env.SLOT_DENOM_SATS || 40_000);
const BOND_AMOUNT_TAC = BigInt(process.env.BOND_AMOUNT_TAC || 20_000);
const POOL_DELTA_TAC  = BigInt(process.env.POOL_DELTA_TAC  || 40_000);
const POOL_DELTA_CTAC = SLOT_DENOM_SATS;  // mint = denom = pool reserve B
const FEE_BPS = Number(process.env.FEE_BPS || 30);
const SWAP_DELTA_IN = BigInt(process.env.SWAP_DELTA_IN || 5_000);

const state = loadJson(STATE_FILE);
const ctacAssetId = (dapp.ctacVariantAssetId ? dapp.ctacVariantAssetId(SLOT_DENOM_SATS) : null);
if (!ctacAssetId) fail('dapp.ctacVariantAssetId missing');

console.log('=== amm-tac-ctac-pool-signet ===');
console.log(`  depositor:           ${DEP_ADDR}`);
console.log(`  TAC asset (PINE):    ${TAC_ASSET_ID.slice(0, 16)}…`);
console.log(`  cBTC.tac.${SLOT_DENOM_SATS}k variant: ${ctacAssetId.slice(0, 16)}…`);
console.log(`  pool delta_TAC:      ${POOL_DELTA_TAC}`);
console.log(`  pool delta_cBTC.tac: ${POOL_DELTA_CTAC}`);
console.log(`  fee_bps:             ${FEE_BPS}`);

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight (sats + TAC balance)');
const addrInfo = await (await fetch(`https://mempool.space/signet/api/address/${DEP_ADDR}`)).json();
const sats = (addrInfo.chain_stats?.funded_txo_sum ?? 0) - (addrInfo.chain_stats?.spent_txo_sum ?? 0)
           + (addrInfo.mempool_stats?.funded_txo_sum ?? 0) - (addrInfo.mempool_stats?.spent_txo_sum ?? 0);
info(`depositor BTC: ${sats.toLocaleString()} sats`);
if (sats < 80_000 && !state.slotRecord) fail('need ≥ 80k sats for slot mint + deposit + POOL_INIT + swap + LP_REMOVE');

const holdings = await dapp.scanHoldings();
const tacHold = holdings.get(TAC_ASSET_ID);
info(`PINE balance: ${tacHold?.balance ?? 0}`);
if (!tacHold || tacHold.balance < (POOL_DELTA_TAC + BOND_AMOUNT_TAC)) {
  fail(`need ≥ ${POOL_DELTA_TAC + BOND_AMOUNT_TAC} PINE (pool reserve + bond), have ${tacHold?.balance ?? 0}`);
}
ok(`pre-flight passed`);

// ---- Phase 2: slot mint ----
step(2, `T_SLOT_MINT (cBTC.zk @ ${SLOT_DENOM_SATS} sats denom)`);
let slotRecord;
if (state.slotRecord) {
  ok(`reusing prior slot: leaf ${state.slotRecord.leafCommitmentHex.slice(0, 16)}…`);
  slotRecord = state.slotRecord;
} else {
  info(`minting slot at denom ${SLOT_DENOM_SATS}, asset_id ${ctacAssetId.slice(0, 16)}…`);
  const res = await dapp.buildAndBroadcastSlotMint({
    assetIdHex: ctacAssetId,
    denomination: SLOT_DENOM_SATS,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`slot minted: commit ${res.commitTxid.slice(0,16)}…  reveal ${res.revealTxid.slice(0,16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  const recs = dapp.getSlotRecords();
  slotRecord = recs.find(r => r.mintTxid === res.revealTxid);
  if (!slotRecord) fail('slot record not found in dapp localStorage post-mint');
  state.slotRecord = slotRecord;
  saveState(state);
  ok(`slot persisted: leaf ${slotRecord.leafCommitmentHex.slice(0, 16)}…`);
}

// ---- Phase 3: cBTC.tac deposit ----
step(3, `T_CBTC_TAC_DEPOSIT (slot + ${BOND_AMOUNT_TAC} TAC bond → cBTC.tac UTXO)`);
let positionRecord;
if (state.positionRecord) {
  ok(`reusing prior position: ${state.positionRecord.status}`);
  positionRecord = state.positionRecord;
} else {
  info(`depositing slot + ${BOND_AMOUNT_TAC} TAC bond → expect ${SLOT_DENOM_SATS} cBTC.tac face`);
  const res = await dapp.buildAndBroadcastCbtcTacDeposit({
    slotRecord,
    bondAmountTAC: BOND_AMOUNT_TAC,
    tacAssetIdHex: TAC_ASSET_ID,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`deposit broadcast: commit ${res.commitTxid.slice(0, 16)}…  reveal ${res.revealTxid.slice(0, 16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  const positions = dapp.getCtacPositionRecords();
  positionRecord = positions.find(p => p.depositRevealTxid === res.revealTxid);
  if (!positionRecord) fail('position record not found post-deposit');
  state.positionRecord = positionRecord;
  saveState(state);
  ok(`position persisted: state=${positionRecord.status}, mint=${positionRecord.mintAmount} cBTC.tac`);
}

// The cBTC.tac UTXO from deposit lives at positionRecord.depositRevealTxid:0.
// The dapp's scanHoldings doesn't yet recognize cBTC.tac UTXOs as standalone
// asset UTXOs (the T_CBTC_TAC_DEPOSIT scan-handler is a separate workstream),
// so we inject the cBTC.tac UTXO into a holdings override before AMM ops run.
// This proves the AMM layer composes with cBTC.tac without depending on
// the future scanHoldings integration.
const ctacMintUtxoRef = {
  utxo: { txid: positionRecord.depositRevealTxid, vout: 0 },
  amount: BigInt(positionRecord.mintAmount),
  blinding: BigInt('0x' + positionRecord.mintBlindingHex),
};
info(`cBTC.tac mint UTXO: ${ctacMintUtxoRef.utxo.txid.slice(0, 16)}…:0  amount=${ctacMintUtxoRef.amount}`);
info(`installing holdings override (TAC from chain + cBTC.tac injected) …`);
const baseHoldings = await dapp.scanHoldings(true);
// scanHoldings(true) returns the wallet-visible asset map. We augment with
// cBTC.tac then install the override so subsequent scanHoldings() calls see
// both assets. The override is read by carveExactAmount inside the AMM
// builders.
const augmented = new Map(baseHoldings);
augmented.set(ctacAssetId.toLowerCase(), {
  balance: ctacMintUtxoRef.amount,
  utxos: [ctacMintUtxoRef],
});
dapp._testSetScanHoldingsOverride(() => augmented);
ok(`holdings override installed (TAC + cBTC.tac)`);

// ---- Phase 4: POOL_INIT ----
step(4, `T_LP_ADD variant 1 — POOL_INIT TAC/cBTC.tac`);
if (state.poolInit) {
  ok(`reusing prior POOL_INIT: ${state.poolInit.reveal_txid.slice(0, 16)}…`);
  ok(`  pool_id: ${state.poolInit.pool_id_hex.slice(0, 16)}…`);
} else {
  info(`POOL_INIT: ${POOL_DELTA_TAC} TAC + ${POOL_DELTA_CTAC} cBTC.tac at fee_bps=${FEE_BPS}`);
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
  info(`  commit:         ${result.commitTxid}`);
  info(`  reveal:         ${result.revealTxid}`);
  info(`  pool_id:        ${result.poolIdHex}`);
  info(`  founder_shares: ${result.founderShares}`);
  info(`  canon_A:        ${result.canonicalAssetA.slice(0, 16)}… (Δ=${result.deltaA})`);
  info(`  canon_B:        ${result.canonicalAssetB.slice(0, 16)}… (Δ=${result.deltaB})`);
  state.poolInit = {
    commit_txid: result.commitTxid,
    reveal_txid: result.revealTxid,
    pool_id_hex: result.poolIdHex,
    lp_asset_id_hex: result.lpAssetIdHex,
    canonical_asset_a: result.canonicalAssetA,
    canonical_asset_b: result.canonicalAssetB,
    canonical_delta_a: result.deltaA.toString(),
    canonical_delta_b: result.deltaB.toString(),
    fee_bps: FEE_BPS,
    founder_shares: result.founderShares.toString(),
    locked_shares: '1000',
    r_share_secp_hex: result.rShareSecpHex,
    r_share_bjj_hex: result.rShareBJJHex,
    share_c_secp_hex: result.shareCSecpHex,
  };
  saveState(state);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
}

// Pool seeded. Clear the cBTC.tac holdings override — the cBTC.tac UTXO was
// consumed by POOL_INIT, and the swap phase needs fresh TAC state from chain.
dapp._testSetScanHoldingsOverride(null);
dapp.invalidateHoldingsCache();
info(`holdings override cleared; subsequent scans go to chain`);

// ---- Phase 5: swap test ----
step(5, `T_SWAP_VAR — swap ${SWAP_DELTA_IN} of asset_A → asset_B`);
const poolInit = state.poolInit;
const R_A_pre = state.swapResult ? BigInt(state.swapResult.raPost) : BigInt(poolInit.canonical_delta_a);
const R_B_pre = state.swapResult ? BigInt(state.swapResult.rbPost) : BigInt(poolInit.canonical_delta_b);
const direction = 0; // canonical A → B
if (state.swapResult) {
  ok(`reusing prior swap: ${state.swapResult.reveal_txid.slice(0, 16)}… (Δout=${state.swapResult.delta_out})`);
} else {
  info(`pre-swap reserves: ${R_A_pre} / ${R_B_pre}`);
  // x·y=k with fee
  const fb = BigInt(FEE_BPS);
  const dinNet = (SWAP_DELTA_IN * (10000n - fb)) / 10000n;
  const expectedOut = (R_B_pre * dinNet) / (R_A_pre + dinNet);
  const minOut = (expectedOut * 99n) / 100n;
  info(`expected_out: ${expectedOut} (minOut=${minOut})`);

  const swapInput = await dapp.carveExactAmount({
    assetIdHex: poolInit.canonical_asset_a,
    amount: SWAP_DELTA_IN,
  });
  if (!swapInput?.utxo) fail('failed to carve swap input UTXO');

  const tipResp = await fetch('https://mempool.space/signet/api/blocks/tip/height');
  const tipHeight = parseInt((await tipResp.text()).trim(), 10);
  const expiryHeight = tipHeight + 144;

  const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
    poolReserves: {
      pool_id_hex: poolInit.pool_id_hex,
      reserve_a: R_A_pre.toString(),
      reserve_b: R_B_pre.toString(),
      fee_bps: FEE_BPS,
    },
    assetInputUtxo: {
      txid: swapInput.utxo.txid,
      vout: swapInput.utxo.vout,
      amount: swapInput.amount,
      blinding: swapInput.blinding,
      asset_id_hex: poolInit.canonical_asset_a,
    },
    direction,
    deltaIn: SWAP_DELTA_IN,
    minOut,
    expiryHeight,
    receiveAssetIdHex: poolInit.canonical_asset_b,
  });
  ok(`swap broadcast`);
  info(`  commit:    ${r.commitTxid}`);
  info(`  reveal:    ${r.revealTxid}`);
  info(`  delta_out: ${r.deltaOut} (expected ${expectedOut})`);
  info(`  raPost:    ${r.raPost}`);
  info(`  rbPost:    ${r.rbPost}`);
  state.swapResult = {
    commit_txid: r.commitTxid,
    reveal_txid: r.revealTxid,
    delta_in: SWAP_DELTA_IN.toString(),
    delta_out: r.deltaOut.toString(),
    raPost: r.raPost.toString(),
    rbPost: r.rbPost.toString(),
  };
  saveState(state);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
}

// ---- Phase 6: LP_REMOVE ----
step(6, 'T_LP_REMOVE — burn founder shares for proportional reserves');
if (state.lpRemoveResult) {
  ok(`reusing prior LP_REMOVE: ${state.lpRemoveResult.reveal_txid.slice(0, 16)}…`);
  ok(`  recovered: ${state.lpRemoveResult.delta_a} A + ${state.lpRemoveResult.delta_b} B`);
} else {
  // Compute current reserves after swap; pool total shares = founder + locked.
  const burnShares = BigInt(poolInit.founder_shares);
  const totalShares = BigInt(poolInit.founder_shares) + BigInt(poolInit.locked_shares);
  const Ra = BigInt(state.swapResult.raPost);
  const Rb = BigInt(state.swapResult.rbPost);
  const expectedA = (Ra * burnShares) / totalShares;
  const expectedB = (Rb * burnShares) / totalShares;
  info(`burning ${burnShares} shares of ${totalShares} → expect ${expectedA} A + ${expectedB} B`);

  const r = await dapp.buildAndBroadcastLpRemove({
    poolIdHex: poolInit.pool_id_hex,
    assetAIdHex: poolInit.canonical_asset_a,
    assetBIdHex: poolInit.canonical_asset_b,
    shareAmount: burnShares,
    expectedDeltaA: expectedA,
    expectedDeltaB: expectedB,
    lpShareUtxos: [{
      utxo: { txid: poolInit.reveal_txid, vout: 0 },
      amount: burnShares,
      blinding: BigInt('0x' + poolInit.r_share_secp_hex),
    }],
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`LP_REMOVE broadcast`);
  info(`  commit: ${r.commitTxid}`);
  info(`  reveal: ${r.revealTxid}`);
  info(`  recovered: ${r.deltaA} A + ${r.deltaB} B`);
  state.lpRemoveResult = {
    commit_txid: r.commitTxid,
    reveal_txid: r.revealTxid,
    delta_a: r.deltaA.toString(),
    delta_b: r.deltaB.toString(),
  };
  saveState(state);
}

console.log('\n=== TAC/cBTC.tac AMM pool smoke complete ===');
console.log(`State preserved at ${STATE_FILE}.`);
console.log('\nTxs to inspect on https://mempool.space/signet:');
console.log(`  slot mint:     ${slotRecord.mintTxid}`);
console.log(`  cBTC.tac dep:  ${positionRecord.depositRevealTxid}`);
console.log(`  POOL_INIT:     ${state.poolInit.reveal_txid}`);
console.log(`  SWAP_VAR:      ${state.swapResult.reveal_txid}`);
console.log(`  LP_REMOVE:     ${state.lpRemoveResult.reveal_txid}`);
console.log(`\npool_id: ${state.poolInit.pool_id_hex}`);
