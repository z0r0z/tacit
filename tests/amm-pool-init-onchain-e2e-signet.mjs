// Signet smoke-test for AMM POOL_INIT (T_LP_ADD variant 1).
//
// Initializes a fresh AMM pool against an (asset_A, asset_B) pair from
// the depositor wallet's holdings. Default pair = (a PINE bootstrap asset,
// a fresh PINEB token CETCHed inline if needed) so this harness is
// self-contained.
//
// Phases (resumable via .local/amm-pool-init-signet-state.json):
//   1. Pre-flight: balance + asset-A + asset-B holdings
//   2. (if needed) CETCH a second asset (PINEB, 1M supply, 0 decimals)
//   3. POOL_INIT: T_LP_ADD variant 1 with deltaA, deltaB
//   4. Post-flight: tx structure verification on chain
//
// Run:  node tests/amm-pool-init-onchain-e2e-signet.mjs
// Reset state:  rm .local/amm-pool-init-signet-state.json
// Knobs (env):
//   DELTA_A         (default 100_000)
//   DELTA_B         (default 100_000)
//   FEE_BPS         (default 30 = 0.3%)
//   POOL_META_URI   (default '')
//   BOOTSTRAP_B=1   force a fresh PINEB CETCH (skips reuse from state)
//
// Requires:
//   .local/cbtc-tac-signet-test-wallets.json  (depositor wallet)
//   .local/cbtc-tac-signet-state.json         (tacAssetIdHex = PINE asset_id)
//   Depositor: ≥ 50k signet sats for two CETCHes (if needed) + POOL_INIT
//              fee + asset-A + asset-B holdings ≥ DELTA_{A,B} each.

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
const STATE_FILE = path.join(STATE_DIR, 'amm-pool-init-signet-state.json');
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
  fail(`expected .local/cbtc-tac-signet-state.json with tacAssetIdHex set (CETCH a token first and record its asset_id there).`);
}
const ASSET_A_ID = ctacState.tacAssetIdHex; // PINE
const state = loadJson(STATE_FILE);

console.log('=== amm-pool-init-onchain-e2e-signet ===');
console.log(`  depositor: ${DEP_ADDR}`);
console.log(`  asset A:   PINE (${ASSET_A_ID.slice(0, 16)}…)`);
console.log(`  state:     ${STATE_FILE}\n`);

const DELTA_A = BigInt(process.env.DELTA_A || 100_000);
const DELTA_B = BigInt(process.env.DELTA_B || 100_000);
const FEE_BPS = Number(process.env.FEE_BPS || 30);

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight (balance + asset holdings)');
const addrInfo = await (await fetch(`https://mempool.space/signet/api/address/${DEP_ADDR}`)).json();
const sats = (addrInfo.chain_stats?.funded_txo_sum ?? 0) - (addrInfo.chain_stats?.spent_txo_sum ?? 0)
           + (addrInfo.mempool_stats?.funded_txo_sum ?? 0) - (addrInfo.mempool_stats?.spent_txo_sum ?? 0);
info(`depositor BTC: ${sats.toLocaleString()} sats`);
if (sats < 30_000) fail('need ≥ 30k sats for POOL_INIT commit/reveal + carves');

const holdings = await dapp.scanHoldings();
const holdA = holdings.get(ASSET_A_ID);
info(`PINE balance: ${holdA?.balance ?? 0}`);
if (!holdA || holdA.balance < DELTA_A) {
  fail(`need ≥ ${DELTA_A} PINE for deltaA (got ${holdA?.balance ?? 0})`);
}

// ---- Phase 2: bootstrap second asset (PINEB) if needed ----
step(2, 'asset B (PINEB) — CETCH if not already present');
let assetBId = state.assetBIdHex;
if (process.env.BOOTSTRAP_B === '1') { assetBId = null; state.assetBIdHex = null; }
if (assetBId) {
  const holdB = holdings.get(assetBId);
  if (!holdB || holdB.balance < DELTA_B) {
    info(`PINEB asset_id ${assetBId.slice(0,16)}… present but balance ${holdB?.balance ?? 0} < deltaB ${DELTA_B}`);
    fail('depositor PINEB balance insufficient — top up via dapp UI or set BOOTSTRAP_B=1');
  }
  ok(`reusing PINEB from state: ${assetBId.slice(0, 16)}… (balance ${holdB.balance})`);
} else {
  info('CETCHing PINEB (1M supply, 0 decimals, mintable=false)…');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'PINEB', supplyBase: 1_000_000n, decimals: 0, mintable: false, metadataBuilder: null,
    onProgress: (s) => info(`  · ${s}`),
  });
  assetBId = r.assetIdHex;
  state.assetBIdHex = assetBId;
  state.assetBCetchTxid = r.revealTxid;
  saveState(state);
  ok(`PINEB CETCH broadcast: asset_id ${assetBId.slice(0, 16)}…`);
  info(`  reveal_txid: ${r.revealTxid}`);
  info('  waiting 90s for confirmation + indexer pickup…');
  await sleep(90_000);
  dapp.invalidateHoldingsCache();
  const h2 = await dapp.scanHoldings();
  const holdB = h2.get(assetBId);
  if (!holdB || holdB.balance < DELTA_B) {
    fail(`PINEB CETCH supply not yet visible (got ${holdB?.balance ?? 0}); re-run after another minute`);
  }
  ok(`PINEB balance: ${holdB.balance}`);
}

// ---- Phase 3: POOL_INIT ----
step(3, `T_LP_ADD variant 1 — POOL_INIT (PINE ↔ PINEB at fee_bps=${FEE_BPS})`);
if (state.poolIdHex) {
  ok(`pool already exists from prior run: ${state.poolIdHex.slice(0, 16)}…`);
  ok(`  reveal_txid: ${state.initRevealTxid}`);
  info(`  re-run with rm ${STATE_FILE} to retry`);
} else {
  info(`POOL_INIT: deltaA=${DELTA_A} deltaB=${DELTA_B} feeBps=${FEE_BPS}`);
  const result = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: ASSET_A_ID,
    assetBIdHex: assetBId,
    deltaA: DELTA_A, deltaB: DELTA_B,
    feeBps: FEE_BPS,
    vkCid: 'bafyAmmV1Placeholder',     // worker doesn't yet fetch+verify
    ceremonyCid: 'bafyAmmCeremonyV1',  // placeholder until AMM ceremony lands
    poolCapabilityFlags: 0,
    poolMetaUri: '',
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`POOL_INIT broadcast`);
  info(`  commit_txid:    ${result.commitTxid}`);
  info(`  reveal_txid:    ${result.revealTxid}`);
  info(`  pool_id:        ${result.poolIdHex}`);
  info(`  lp_asset_id:    ${result.lpAssetIdHex}`);
  info(`  founder_shares: ${result.founderShares}`);
  info(`  canonical A:    ${result.canonicalAssetA.slice(0, 16)}… (Δ=${result.deltaA})`);
  info(`  canonical B:    ${result.canonicalAssetB.slice(0, 16)}… (Δ=${result.deltaB})`);
  state.poolIdHex = result.poolIdHex;
  state.lpAssetIdHex = result.lpAssetIdHex;
  state.founderShares = result.founderShares.toString();
  state.initCommitTxid = result.commitTxid;
  state.initRevealTxid = result.revealTxid;
  state.rShareSecpHex = result.rShareSecpHex;
  state.rShareBJJHex = result.rShareBJJHex;
  state.shareCSecpHex = result.shareCSecpHex;
  saveState(state);
  info(`  waiting 60s for confirmation…`);
  await sleep(60_000);
}

// ---- Phase 4: on-chain tx structure verification ----
step(4, 'on-chain tx structure verification');
const revealTx = await (await fetch(`https://mempool.space/signet/api/tx/${state.initRevealTxid}`)).json();
info(`reveal status: ${revealTx.status?.confirmed ? 'CONFIRMED block ' + revealTx.status.block_height : 'mempool'}`);
info(`vin count:  ${revealTx.vin.length} (expect 3: envelope, asset-A, asset-B)`);
info(`vout count: ${revealTx.vout.length} (expect 2: founder-share, locked-min-liq)`);
for (let i = 0; i < revealTx.vout.length; i++) {
  const o = revealTx.vout[i];
  info(`  vout[${i}]: ${o.value} sats, ${o.scriptpubkey_type}, ${o.scriptpubkey_address || '-'}`);
}
ok(`POOL_INIT on chain: https://mempool.space/signet/tx/${state.initRevealTxid}`);

// ---- Phase 5: wait for worker to index the pool ----
const WORKER_BASE = process.env.TACIT_WORKER_BASE || process.env.WORKER_BASE || 'https://api.tacit.finance';
step(5, 'wait for worker indexer to register the pool');
let poolRecord = null;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pool/${state.poolIdHex}`);
    if (r.ok) {
      poolRecord = await r.json();
      if (poolRecord?.pool_id) break;
    }
  } catch {}
  info(`  not yet indexed; polling again in 20s (attempt ${i + 1}/30)…`);
  await sleep(20_000);
}
if (!poolRecord) {
  fail(`pool not indexed after 10 minutes. Check worker cron + AMM validator branch.`);
}
ok(`pool indexed`);
info(`  validation:     ${poolRecord.validation}`);
info(`  reserve_a:      ${poolRecord.reserve_a}`);
info(`  reserve_b:      ${poolRecord.reserve_b}`);
info(`  lp_total_shares: ${poolRecord.lp_total_shares}`);
info(`  founder_shares: ${poolRecord.founder_shares}`);
info(`  locked_shares:  ${poolRecord.locked_shares}`);
info(`  fee_bps:        ${poolRecord.fee_bps}`);
state.poolRecord = poolRecord;
saveState(state);

if (process.env.SKIP_LIFECYCLE === '1') {
  console.log('\nSKIP_LIFECYCLE=1 — stopping after POOL_INIT verification.');
  console.log(`Pool id: ${state.poolIdHex}`);
  process.exit(0);
}

// ---- Phase 6: LP_ADD variant 0 (add more liquidity) ----
step(6, 'T_LP_ADD variant 0 — add more liquidity to existing pool');
const ADD_DELTA_A = BigInt(process.env.ADD_DELTA_A || 50_000);
const ADD_DELTA_B = BigInt(process.env.ADD_DELTA_B || 50_000);
if (state.lpAddVariant0Result) {
  ok(`reusing prior LP_ADD result: ${state.lpAddVariant0Result.revealTxid}`);
} else {
  // Compute expected shareAmount via Uniswap V2 mint formula:
  //   shares = min(Δa·S/R_a, Δb·S/R_b)
  const Ra = BigInt(poolRecord.reserve_a);
  const Rb = BigInt(poolRecord.reserve_b);
  const S = BigInt(poolRecord.lp_total_shares);
  const sharesFromA = (ADD_DELTA_A * S) / Ra;
  const sharesFromB = (ADD_DELTA_B * S) / Rb;
  const expectedShares = sharesFromA < sharesFromB ? sharesFromA : sharesFromB;
  info(`adding deltaA=${ADD_DELTA_A} deltaB=${ADD_DELTA_B} → ${expectedShares} shares`);
  const r = await dapp.buildAndBroadcastLpAddVariant0({
    poolIdHex: state.poolIdHex,
    assetAIdHex: poolRecord.asset_a,
    assetBIdHex: poolRecord.asset_b,
    deltaA: ADD_DELTA_A, deltaB: ADD_DELTA_B,
    shareAmount: expectedShares,
    feeBps: poolRecord.fee_bps,
    poolCapabilityFlags: poolRecord.capability_flags,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`LP_ADD variant 0 broadcast`);
  info(`  commit_txid: ${r.commitTxid}`);
  info(`  reveal_txid: ${r.revealTxid}`);
  info(`  shares minted: ${r.shareAmount}`);
  state.lpAddVariant0Result = {
    commitTxid: r.commitTxid, revealTxid: r.revealTxid,
    shareAmount: r.shareAmount.toString(), deltaA: r.deltaA.toString(), deltaB: r.deltaB.toString(),
    rShareSecpHex: r.rShareSecpHex,
  };
  saveState(state);
  info(`  waiting 90s for confirm + indexer pickup…`);
  await sleep(90_000);
}

// ---- Phase 7: T_SWAP_VAR — swap against the pool ----
step(7, 'T_SWAP_VAR — swap PINE for PINEB against the pool');
if (state.swapResult) {
  ok(`reusing prior swap result: ${state.swapResult.revealTxid}`);
} else {
  // Re-fetch pool to get fresh reserves after LP_ADD
  let p2 = poolRecord;
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pool/${state.poolIdHex}`);
    if (r.ok) p2 = await r.json();
  } catch {}
  info(`pool reserves now: A=${p2.reserve_a} B=${p2.reserve_b}`);

  const SWAP_DELTA_IN = BigInt(process.env.SWAP_DELTA_IN || 5_000);
  const direction = 0; // A → B
  // Compute expected deltaOut via x·y=k with fee
  const Ra = BigInt(p2.reserve_a);
  const Rb = BigInt(p2.reserve_b);
  const fb = BigInt(p2.fee_bps);
  const dinNet = (SWAP_DELTA_IN * (10000n - fb)) / 10000n;
  const expectedOut = (Rb * dinNet) / (Ra + dinNet);
  const minOut = (expectedOut * 99n) / 100n; // 1% slippage tolerance
  info(`swap: ${SWAP_DELTA_IN} A → expect ${expectedOut} B (minOut=${minOut})`);

  // Holdings should have a PINE UTXO ≥ SWAP_DELTA_IN; carve exact
  const swapInputUtxo = await dapp.carveExactAmount({
    assetIdHex: p2.asset_a, amount: SWAP_DELTA_IN,
  });
  if (!swapInputUtxo?.utxo) fail('failed to carve swap input UTXO');

  // The shipped buildAndBroadcastSwapVarSelfFulfill takes poolReserves + assetInputUtxo
  const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
    poolReserves: {
      reserve_a: p2.reserve_a, reserve_b: p2.reserve_b, fee_bps: p2.fee_bps,
      pool_id_hex: state.poolIdHex,
    },
    assetInputUtxo: {
      txid: swapInputUtxo.utxo.txid, vout: swapInputUtxo.utxo.vout,
      amount: swapInputUtxo.amount, blinding: swapInputUtxo.blinding,
      asset_id_hex: p2.asset_a,
    },
    direction,
    deltaIn: SWAP_DELTA_IN,
    minOut,
    expiryHeight: 0xffffffff,
    receiveAssetIdHex: p2.asset_b,
  });
  ok(`swap broadcast`);
  info(`  reveal_txid: ${r.revealTxid}`);
  info(`  deltaOut:    ${r.deltaOut}`);
  state.swapResult = {
    revealTxid: r.revealTxid, deltaIn: SWAP_DELTA_IN.toString(),
    deltaOut: r.deltaOut.toString(),
  };
  saveState(state);
  info(`  waiting 90s for confirm + indexer pickup…`);
  await sleep(90_000);
}

// ---- Phase 8: T_LP_REMOVE (burn LP shares for proportional withdrawal) ----
step(8, 'T_LP_REMOVE — burn LP shares for proportional reserves');
if (state.lpRemoveResult) {
  ok(`reusing prior LP_REMOVE result: ${state.lpRemoveResult.revealTxid}`);
} else {
  // Re-fetch pool state
  let p3 = poolRecord;
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pool/${state.poolIdHex}`);
    if (r.ok) p3 = await r.json();
  } catch {}
  info(`pool reserves: A=${p3.reserve_a} B=${p3.reserve_b} total_shares=${p3.lp_total_shares}`);

  // Burn the founder shares from POOL_INIT. The mint UTXO is at
  // state.initRevealTxid:0 with state.founderShares + state.rShareSecpHex.
  const burnShares = BigInt(state.founderShares);
  const Ra = BigInt(p3.reserve_a);
  const Rb = BigInt(p3.reserve_b);
  const S = BigInt(p3.lp_total_shares);
  const expectedA = (Ra * burnShares) / S;
  const expectedB = (Rb * burnShares) / S;
  info(`burning ${burnShares} shares → ${expectedA} A + ${expectedB} B (= S=${S}, R=${Ra}/${Rb})`);

  const r = await dapp.buildAndBroadcastLpRemove({
    poolIdHex: state.poolIdHex,
    assetAIdHex: p3.asset_a, assetBIdHex: p3.asset_b,
    shareAmount: burnShares,
    expectedDeltaA: expectedA, expectedDeltaB: expectedB,
    lpShareUtxos: [{
      utxo: { txid: state.initRevealTxid, vout: 0 },
      amount: burnShares,
      blinding: BigInt('0x' + state.rShareSecpHex),
    }],
    feeBps: p3.fee_bps,
    poolCapabilityFlags: p3.capability_flags,
    onProgress: (s) => info(`  · ${s}`),
  });
  ok(`LP_REMOVE broadcast`);
  info(`  reveal_txid: ${r.revealTxid}`);
  info(`  receive A:   ${r.deltaA} (vout[0])`);
  info(`  receive B:   ${r.deltaB} (vout[1])`);
  state.lpRemoveResult = {
    revealTxid: r.revealTxid,
    deltaA: r.deltaA.toString(), deltaB: r.deltaB.toString(),
  };
  saveState(state);
}

console.log('\n=== AMM full lifecycle smoke test complete ===');
console.log(`Pool id: ${state.poolIdHex}`);
console.log(`State preserved at ${STATE_FILE}.`);
console.log('\nTxs to inspect on https://mempool.space/signet:');
console.log(`  POOL_INIT:   ${state.initRevealTxid}`);
if (state.lpAddVariant0Result) console.log(`  LP_ADD v0:   ${state.lpAddVariant0Result.revealTxid}`);
if (state.swapResult)          console.log(`  SWAP_VAR:    ${state.swapResult.revealTxid}`);
if (state.lpRemoveResult)      console.log(`  LP_REMOVE:   ${state.lpRemoveResult.revealTxid}`);
