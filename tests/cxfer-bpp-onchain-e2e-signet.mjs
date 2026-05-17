// End-to-end signet harness for SPEC-CXFER-BPP-AMENDMENT §5.47.
//
// Exercises T_CXFER_BPP on real signet chain, including the mixed-ancestry
// walk that the offline tests cover only at the dispatch layer:
//
//   Phase 1: pre-flight (wallets funded, asset prerequisites)
//   Phase 2: CETCH a throwaway tacit asset (CXFER ancestor — standard BP)
//   Phase 3: SEND via T_CXFER_BPP m=1 (the new opcode, BP+ rangeproof)
//   Phase 4: recipient scans holdings; confirms the BPP UTXO is credited
//            via the mixed-ancestry path (CETCH → CXFER_BPP)
//   Phase 5: recipient sends back via standard T_CXFER m=1 (reverse path:
//            CXFER_BPP → CXFER); confirms validator dispatches correctly
//   Phase 6: sender re-scans; confirms final balance matches pre-send
//            minus fees (5-hop ancestry sanity)
//
// State is persisted between phases at .local/cxfer-bpp-signet-state.json
// so a partial run can be resumed.
//
// Run:  node tests/cxfer-bpp-onchain-e2e-signet.mjs
// Reset: rm .local/cxfer-bpp-signet-state.json
//
// Requires:
//   .local/cxfer-bpp-signet-test-wallets.json
//     (generate via: node tests/gen-cxfer-bpp-signet-wallets.mjs)
//   sender:    ~150k signet sats (CETCH + send + receive-back fees)
//   recipient: ~30k  signet sats (send-back fee)

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
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cxfer-bpp-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'cxfer-bpp-signet-test-wallets.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}\nGenerate first: node tests/gen-cxfer-bpp-signet-wallets.mjs`);
}
const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));

function asSender() {
  dapp.wallet.priv = hexToBytes(W.sender.priv_hex);
  dapp.wallet.pub  = hexToBytes(W.sender.pub_hex);
  dapp.invalidateHoldingsCache();
}
function asRecipient() {
  dapp.wallet.priv = hexToBytes(W.recipient.priv_hex);
  dapp.wallet.pub  = hexToBytes(W.recipient.pub_hex);
  dapp.invalidateHoldingsCache();
}

async function fetchSatsBalance(addr) {
  const r = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  const j = await r.json();
  const chain  = (j.chain_stats?.funded_txo_sum || 0) - (j.chain_stats?.spent_txo_sum || 0);
  const mempl  = (j.mempool_stats?.funded_txo_sum || 0) - (j.mempool_stats?.spent_txo_sum || 0);
  return chain + mempl;
}
async function waitConfirmed(txid, label) {
  info(`waiting for ${label} confirmation (${txid.slice(0, 12)}…)`);
  for (let i = 0; i < 240; i++) {  // 240 × 5s = 20 min cap
    try {
      const r = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
      if (r.ok) {
        const s = await r.json();
        if (s.confirmed) { ok(`${label} confirmed at block ${s.block_height}`); return s; }
      }
    } catch {}
    await sleep(5000);
  }
  fail(`${label} not confirmed after 20 min`);
}

const state = loadState();

// ---------------- Phase 1: pre-flight ----------------
step(1, 'Pre-flight (wallets, funding)');
asSender();
const senderAddr = dapp.wallet.address();
const recipientAddr = (() => { asRecipient(); const a = dapp.wallet.address(); asSender(); return a; })();
info(`sender:    ${senderAddr}`);
info(`recipient: ${recipientAddr}`);

const senderBal = await fetchSatsBalance(senderAddr);
const recipBal  = await fetchSatsBalance(recipientAddr);
info(`sender    sats: ${senderBal}`);
info(`recipient sats: ${recipBal}`);
if (senderBal < 100_000) fail(`sender needs ≥100k sats (has ${senderBal}); fund at https://signet.bublina.eu.org/`);
if (recipBal  < 20_000)  fail(`recipient needs ≥20k sats (has ${recipBal}); fund at https://signet.bublina.eu.org/`);
ok('both wallets funded');

// ---------------- Phase 2: CETCH ----------------
let assetIdHex = state.assetIdHex;
if (!assetIdHex) {
  step(2, 'CETCH a throwaway tacit asset');
  const supply = 100_000n;
  const ceRes = await dapp.buildAndBroadcastCEtch({
    ticker: `BPP${Date.now() % 100000}`,
    supplyBase: supply,
    decimals: 0,
    mintable: false,
  });
  ok(`CETCH commit ${ceRes.commitTxid.slice(0, 12)}… reveal ${ceRes.revealTxid.slice(0, 12)}…`);
  await waitConfirmed(ceRes.revealTxid, 'CETCH reveal');
  state.assetIdHex = ceRes.assetIdHex;
  state.cetchTxid = ceRes.revealTxid;
  state.supply = supply.toString();
  saveState(state);
  assetIdHex = state.assetIdHex;
} else {
  step(2, `CETCH already done — asset ${assetIdHex.slice(0, 12)}… (txid ${state.cetchTxid?.slice(0, 12)}…)`);
}

// ---------------- Phase 3: send via T_CXFER_BPP ----------------
let bppRevealTxid = state.bppRevealTxid;
if (!bppRevealTxid) {
  step(3, 'Send via T_CXFER_BPP m=1 (the new opcode)');
  const sendAmt = 1_000n;
  asSender();
  await dapp.scanHoldings();  // warm cache
  const r = await dapp.buildAndBroadcastCXfer({
    assetIdHex,
    recipientPubHex: W.recipient.pub_hex,
    amount: sendAmt,
    useBpp: true,                  // <-- THE NEW PATH
  });
  ok(`BPP send commit ${r.commitTxid.slice(0, 12)}… reveal ${r.revealTxid.slice(0, 12)}…`);
  await waitConfirmed(r.revealTxid, 'BPP-send reveal');
  state.bppRevealTxid = r.revealTxid;
  state.bppSendAmt = sendAmt.toString();
  state.bppChangeAmt = r.changeAmount.toString();
  saveState(state);
  bppRevealTxid = state.bppRevealTxid;
} else {
  step(3, `BPP send already done — reveal ${bppRevealTxid.slice(0, 12)}…`);
}

// ---------------- Phase 4: recipient confirms credit ----------------
step(4, 'Recipient scans holdings (CETCH → CXFER_BPP ancestry)');
asRecipient();
const recipHoldings = await dapp.scanHoldings();
const recipAsset = recipHoldings.get(assetIdHex);
if (!recipAsset) fail(`recipient sees no balance for ${assetIdHex.slice(0, 12)}…`);
if (recipAsset.balance !== BigInt(state.bppSendAmt)) {
  fail(`recipient balance ${recipAsset.balance} ≠ expected ${state.bppSendAmt}`);
}
ok(`recipient credited ${recipAsset.balance} units via T_CXFER_BPP UTXO`);
info(`recipient holdings: ${recipAsset.utxos.length} utxo(s) on this asset`);

// ---------------- Phase 5: recipient sends back via standard T_CXFER ----------------
let returnRevealTxid = state.returnRevealTxid;
if (!returnRevealTxid) {
  step(5, 'Recipient sends back via standard T_CXFER (BPP → CXFER mixed ancestry)');
  asRecipient();
  const returnAmt = BigInt(state.bppSendAmt);  // send the full amount back
  const r = await dapp.buildAndBroadcastCXfer({
    assetIdHex,
    recipientPubHex: W.sender.pub_hex,
    amount: returnAmt,
    useBpp: false,                 // standard BP path — proves mixed dispatch works
  });
  ok(`return commit ${r.commitTxid.slice(0, 12)}… reveal ${r.revealTxid.slice(0, 12)}…`);
  await waitConfirmed(r.revealTxid, 'return-send reveal');
  state.returnRevealTxid = r.revealTxid;
  saveState(state);
  returnRevealTxid = state.returnRevealTxid;
} else {
  step(5, `return send already done — reveal ${returnRevealTxid.slice(0, 12)}…`);
}

// ---------------- Phase 6: sender re-scans, mixed-ancestry walk validated ----------------
step(6, 'Sender re-scans (CETCH → CXFER_BPP → CXFER, 3-hop mixed ancestry)');
asSender();
const senderHoldings = await dapp.scanHoldings();
const senderAsset = senderHoldings.get(assetIdHex);
if (!senderAsset) fail('sender sees no holdings for the asset after round trip');
// Sender should hold: original supply minus 0 (received back the entire send amount)
// = change_from_send + returned_amount
const expectTotal = BigInt(state.bppChangeAmt) + BigInt(state.bppSendAmt);
if (senderAsset.balance !== expectTotal) {
  fail(`sender balance ${senderAsset.balance} ≠ expected ${expectTotal} (change ${state.bppChangeAmt} + returned ${state.bppSendAmt})`);
}
ok(`sender balance restored to ${senderAsset.balance} (= ${state.bppChangeAmt} change + ${state.bppSendAmt} returned)`);
info('mixed-ancestry validator walk CETCH → CXFER_BPP → CXFER credits correctly');

console.log('\n=== T_CXFER_BPP signet smoke PASSED ===');
console.log('Validated on chain:');
console.log('  • T_CXFER_BPP envelope builds, broadcasts, confirms');
console.log('  • Recipient scanHoldings credits BPP-sourced UTXO via mixed-ancestry walk');
console.log('  • Standard T_CXFER spending a BPP parent dispatches correctly in validateOutpoint');
console.log('  • End-to-end balance integrity across CETCH → BPP → CXFER chain');
console.log('\nWipe state with: rm .local/cxfer-bpp-signet-state.json');
