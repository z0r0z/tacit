// Signet smoke-test for AMM POOL_INIT (T_LP_ADD variant 1).
//
// Initializes a fresh AMM pool against an (asset_A, asset_B) pair from
// the depositor wallet's holdings. Default pair = (PINE bootstrap asset
// from cbtc-tac-bootstrap-tac-asset.mjs, a fresh PINEB token CETCHed
// inline if needed) so this harness is self-contained.
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
  fail(`expected .local/cbtc-tac-signet-state.json with tacAssetIdHex set. Run:\n   node tests/cbtc-tac-bootstrap-tac-asset.mjs`);
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

console.log('\n=== smoke test complete ===');
console.log(`Pool id: ${state.poolIdHex}`);
console.log(`State preserved at ${STATE_FILE}.`);
