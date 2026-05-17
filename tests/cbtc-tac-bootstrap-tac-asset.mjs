// One-shot: CETCH a TAC-like throwaway asset on signet using the
// depositor wallet from .local/cbtc-tac-signet-test-wallets.json, then
// CXFER half the supply to the depositor itself as a usable bond UTXO.
//
// Writes the asset_id back into .local/cbtc-tac-signet-state.json so the
// smoke-test harness picks it up without env-var threading.
//
// Run: node tests/cbtc-tac-bootstrap-tac-asset.mjs
// Skip CETCH if state.tacAssetIdHex already set; pass FORCE=1 to override.

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
const STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) fail(`missing ${WALLET_FILE}`);
const wallets = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const DEP_SK = hexToBytes(wallets.depositor.priv_hex);
const DEP_PUB = secp.getPublicKey(DEP_SK, true);
dapp.wallet.priv = DEP_SK;
dapp.wallet.pub = DEP_PUB;
dapp.invalidateHoldingsCache();
const DEP_ADDR = dapp.wallet.address();

console.log('=== cBTC.tac bootstrap (CETCH TAC-like throwaway asset) ===');
console.log(`  depositor: ${DEP_ADDR}\n`);

const state = loadState();
if (state.tacAssetIdHex && !process.env.FORCE) {
  ok(`asset already bootstrapped: ${state.tacAssetIdHex}`);
  ok(`(re-run with FORCE=1 to CETCH a fresh one)`);
  process.exit(0);
}

// Pre-flight: depositor must have ≥ ~20k sats for the CETCH commit/reveal fee.
const addrInfo = await (await fetch(`https://mempool.space/signet/api/address/${DEP_ADDR}`)).json();
const chainSats = (addrInfo.chain_stats?.funded_txo_sum ?? 0) - (addrInfo.chain_stats?.spent_txo_sum ?? 0);
const memSats   = (addrInfo.mempool_stats?.funded_txo_sum ?? 0) - (addrInfo.mempool_stats?.spent_txo_sum ?? 0);
info(`balance: ${chainSats.toLocaleString()} confirmed + ${memSats.toLocaleString()} mempool sats`);
if (chainSats + memSats < 20_000) fail('need ≥ 20k sats for CETCH commit+reveal fees');

// CETCH a TAC-like token. mintable=false (fixed supply); 1M base units.
info(`CETCHing throwaway "PINE" token (1M supply, 0 decimals, mintable=false)…`);
const cetchRes = await dapp.buildAndBroadcastCEtch({
  ticker: 'PINE',
  supplyBase: 1_000_000n,
  decimals: 0,
  mintable: false,
  metadataBuilder: null, // skip IPFS pin
  onProgress: (s) => info(`  · ${s}`),
});
ok(`CETCH broadcast`);
info(`  commit_txid: ${cetchRes.commitTxid}`);
info(`  reveal_txid: ${cetchRes.revealTxid}`);
info(`  asset_id:    ${cetchRes.assetIdHex}`);

state.tacAssetIdHex = cetchRes.assetIdHex;
state.cetchCommitTxid = cetchRes.commitTxid;
state.cetchRevealTxid = cetchRes.revealTxid;
saveState(state);

info(`\nWaiting 90s for CETCH reveal to confirm…`);
await sleep(90_000);

// Verify the depositor sees the supply.
dapp.invalidateHoldingsCache();
const holdings = await dapp.scanHoldings();
const tacHolding = holdings.get(cetchRes.assetIdHex);
if (!tacHolding) fail(`CETCH supply not yet visible in holdings (give it another minute and re-scan)`);
ok(`depositor balance: ${tacHolding.balance} PINE`);
ok(`asset_id pinned in state file — smoke test will use it automatically`);
console.log('\nNext: node tests/cbtc-tac-onchain-e2e-signet.mjs');
