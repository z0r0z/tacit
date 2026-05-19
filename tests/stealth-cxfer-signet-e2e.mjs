// Tacit-asset CXFER × stealth-recipient × real signet — end-to-end.
//
// Closes the gap left by tests/stealth-signet-extended.mjs (bare sats
// only) and proves out the math fix in commit 140d130 on real chain.
//
// Six phases, each independently resumable from .local state:
//
//   Phase 1: pre-flight — wallets, sats funding, balance checks.
//             If Alice + Carol are under-funded, Bob tops them up
//             with a single classical BTC tx (~30k sats each).
//   Phase 2: CETCH test asset (Bob) — fresh on every fresh run.
//   Phase 3: BASELINE — Bob → Alice classical CXFER (no stealth).
//             Confirms unchanged code path still works post-integration.
//   Phase 4: STEALTH SEND — Bob → Alice CXFER with stealth recipient.
//             Alice scans; confirms scanner detects + persists
//             stealthTweakedSk; output script is P2WPKH(commit).
//   Phase 5: STEALTH SPEND — Alice → Bob CXFER spending the stealth
//             UTXO from Phase 4 → classical recipient. THE FIX path:
//             amount-channel must use Alice's tweakedSk so Bob can
//             decrypt. Bob scans; balance restored end-to-end.
//   Phase 6: STEALTH → STEALTH — Bob → Carol stealth, spending the
//             classical UTXO from Phase 5. Carol scans; she gets a
//             second-degree stealth credit. Then Carol → Bob stealth
//             (THE FIX again, K_asset > 1 if her holdings allow it).
//             Bob scans, confirms final balance.
//
// Run:  node tests/stealth-cxfer-signet-e2e.mjs
// Reset: rm .local/stealth-cxfer-signet-state.json
//
// Pre-reqs:
//   - .local/stealth-signet-{alice,bob,carol}.json (from
//     tests/gen-stealth-signet-wallets.mjs)
//   - Bob ≥ 200k signet sats. The harness funds Alice + Carol
//     from Bob if their balances are under thresholds.

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
import * as secp from '@noble/secp256k1';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'stealth-cxfer-signet-state.json');
const ALICE_FILE = path.join(STATE_DIR, 'stealth-signet-alice.json');
const BOB_FILE   = path.join(STATE_DIR, 'stealth-signet-bob.json');
const CAROL_FILE = path.join(STATE_DIR, 'stealth-signet-carol.json');

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

for (const f of [ALICE_FILE, BOB_FILE, CAROL_FILE]) {
  if (!existsSync(f)) fail(`wallet file missing: ${f} — run node tests/gen-stealth-signet-wallets.mjs`);
}
const ALICE = JSON.parse(readFileSync(ALICE_FILE, 'utf8'));
const BOB   = JSON.parse(readFileSync(BOB_FILE,   'utf8'));
const CAROL = JSON.parse(readFileSync(CAROL_FILE, 'utf8'));

function asAlice() { dapp.wallet.priv = hexToBytes(ALICE.priv_hex); dapp.wallet.pub = hexToBytes(ALICE.pub_hex); dapp.invalidateHoldingsCache(); }
function asBob()   { dapp.wallet.priv = hexToBytes(BOB.priv_hex);   dapp.wallet.pub = hexToBytes(BOB.pub_hex);   dapp.invalidateHoldingsCache(); }
function asCarol() { dapp.wallet.priv = hexToBytes(CAROL.priv_hex); dapp.wallet.pub = hexToBytes(CAROL.pub_hex); dapp.invalidateHoldingsCache(); }

async function satsBalance(addr) {
  const r = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  const j = await r.json();
  const c = j.chain_stats || {}; const m = j.mempool_stats || {};
  return (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
}
async function waitConfirmed(txid, label, maxMin = 30) {
  info(`waiting for ${label} confirmation (${txid.slice(0, 16)}…)`);
  const polls = Math.ceil((maxMin * 60) / 5);
  for (let i = 0; i < polls; i++) {
    try {
      const r = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
      if (r.ok) {
        const s = await r.json();
        if (s.confirmed) { ok(`${label} confirmed at block ${s.block_height}`); return s; }
      }
    } catch {}
    await sleep(5000);
  }
  fail(`${label} not confirmed after ${maxMin} min`);
}

const state = loadState();

// ============================================================================
// Phase 1 — preflight
// ============================================================================
step(1, 'Pre-flight (wallets, sats funding)');
info(`Alice classical: ${ALICE.address}`);
info(`Alice stealth:   ${ALICE.stealth_address.slice(0, 28)}…`);
info(`Bob classical:   ${BOB.address}`);
info(`Bob stealth:     ${BOB.stealth_address.slice(0, 28)}…`);
info(`Carol classical: ${CAROL.address}`);
info(`Carol stealth:   ${CAROL.stealth_address.slice(0, 28)}…`);

let bobBal   = await satsBalance(BOB.address);
let aliceBal = await satsBalance(ALICE.address);
let carolBal = await satsBalance(CAROL.address);
info(`Bob sats: ${bobBal}, Alice sats: ${aliceBal}, Carol sats: ${carolBal}`);
if (bobBal < 200_000) fail(`Bob needs ≥200k sats (has ${bobBal}); fund at https://signet.bublina.eu.org/`);

// Top up Alice + Carol from Bob if their balances are too low to act as senders.
const TOPUP_TARGET = 50_000;
const TOPUP_AMOUNT = 60_000;
const fundsNeeded = [];
if (aliceBal < TOPUP_TARGET) fundsNeeded.push({ name: 'Alice', addr: ALICE.address, amount: TOPUP_AMOUNT, stateKey: 'topupAliceTxid' });
if (carolBal < TOPUP_TARGET) fundsNeeded.push({ name: 'Carol', addr: CAROL.address, amount: TOPUP_AMOUNT, stateKey: 'topupCarolTxid' });
for (const f of fundsNeeded) {
  if (state[f.stateKey]) { ok(`${f.name} top-up done in prior run (${state[f.stateKey].slice(0, 16)}…)`); continue; }
  info(`top-up ${f.name} from Bob (${f.amount} sats)…`);
  asBob();
  const r = await dapp.buildAndBroadcastSatsSend({ recipientAddr: f.addr, amountSats: f.amount });
  ok(`${f.name} top-up tx ${r.txid.slice(0, 16)}…`);
  await waitConfirmed(r.txid, `${f.name} top-up`);
  state[f.stateKey] = r.txid;
  saveState(state);
}
if (fundsNeeded.length > 0) {
  bobBal   = await satsBalance(BOB.address);
  aliceBal = await satsBalance(ALICE.address);
  carolBal = await satsBalance(CAROL.address);
  info(`post-fund — Bob: ${bobBal}, Alice: ${aliceBal}, Carol: ${carolBal}`);
}

// ============================================================================
// Phase 2 — CETCH test asset
// ============================================================================
let assetIdHex = state.assetIdHex;
if (!assetIdHex) {
  step(2, 'CETCH test asset (Bob)');
  asBob();
  const supply = 1_000_000n;
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: `STH${Date.now() % 100000}`,
    supplyBase: supply,
    decimals: 0,
    mintable: false,
  });
  ok(`CETCH commit ${r.commitTxid.slice(0,16)}… reveal ${r.revealTxid.slice(0,16)}…`);
  await waitConfirmed(r.revealTxid, 'CETCH reveal');
  state.assetIdHex = r.assetIdHex;
  state.cetchTxid = r.revealTxid;
  state.supply = supply.toString();
  saveState(state);
  assetIdHex = state.assetIdHex;
} else {
  step(2, `CETCH already done — ${assetIdHex.slice(0, 12)}…`);
}

// ============================================================================
// Phase 3 — BASELINE: Bob → Alice classical CXFER
// ============================================================================
if (!state.p3RevealTxid) {
  step(3, 'BASELINE: Bob → Alice CLASSICAL CXFER (regression — must still work)');
  asBob();
  await dapp.scanHoldings();
  const r = await dapp.buildAndBroadcastCXfer({
    assetIdHex,
    recipientPubHex: ALICE.pub_hex,
    amount: 200_000n,
  });
  ok(`reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p3 classical reveal');
  state.p3RevealTxid = r.revealTxid;
  saveState(state);
} else {
  step(3, `BASELINE already done — ${state.p3RevealTxid.slice(0, 16)}…`);
}

// Alice scans, must see the classical credit.
asAlice();
{
  const h = await dapp.scanHoldings();
  const ah = h.get(assetIdHex);
  if (!ah || ah.balance < 200_000n) fail(`Alice missing classical credit (have ${ah?.balance ?? 0n})`);
  const classicalCount = ah.utxos.filter(u => !u.stealthTweakedSk).length;
  if (classicalCount < 1) fail(`Alice has no classical-shaped UTXO (utxos: ${ah.utxos.length})`);
  ok(`Alice classical balance: ${ah.balance}, classical UTXOs: ${classicalCount}`);
}

// ============================================================================
// Phase 4 — STEALTH SEND: Bob → Alice stealth CXFER
// ============================================================================
if (!state.p4RevealTxid) {
  step(4, 'STEALTH SEND: Bob → Alice CXFER with stealth recipient');
  asBob();
  await dapp.scanHoldings();
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ stealthAddress: ALICE.stealth_address, amount: 150_000n }],
  });
  ok(`reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p4 stealth reveal');
  state.p4RevealTxid = r.revealTxid;
  saveState(state);
} else {
  step(4, `STEALTH SEND already done — ${state.p4RevealTxid.slice(0, 16)}…`);
}

// Alice scans for stealth credit.
asAlice();
{
  const h = await dapp.scanHoldings();
  const ah = h.get(assetIdHex);
  if (!ah) fail(`Alice has no holdings for asset`);
  const stealthUtxos = ah.utxos.filter(u => u.stealthTweakedSk);
  if (stealthUtxos.length < 1) fail(`Alice has no stealth UTXO; total: ${ah.utxos.length}`);
  ok(`Alice TOTAL balance ${ah.balance} (classical+stealth)`);
  ok(`Alice has ${stealthUtxos.length} stealth UTXO(s), tweakedSk persisted`);
  // Confirm the stealth UTXO's on-chain script is P2WPKH(commit), not P2WPKH(Alice.pub).
  // Fetch the reveal tx and check the script at the matching vout.
  const stealthUtxo = stealthUtxos[0];
  const txData = await fetch(`https://mempool.space/signet/api/tx/${stealthUtxo.utxo.txid}`).then(r => r.json());
  const outScript = txData.vout[stealthUtxo.utxo.vout].scriptpubkey;
  const classicalScript = bytesToHex(dapp.p2wpkhScript(hexToBytes(ALICE.pub_hex)));
  if (outScript === classicalScript) fail(`stealth output's script is P2WPKH(alice.pub) — NOT shielded`);
  // Verify tweakedSk · G == commit (the on-chain pubkey hash).
  const tweakedPub = secp.getPublicKey(hexToBytes(stealthUtxo.stealthTweakedSk), true);
  const expectedScript = bytesToHex(dapp.p2wpkhScript(tweakedPub));
  if (outScript !== expectedScript) fail(`tweakedSk·G doesn't match on-chain script`);
  ok(`stealth output script verified: P2WPKH(commit) where tweakedSk·G == commit ✓`);
}

// ============================================================================
// Phase 5 — STEALTH SPEND: Alice → Bob CLASSICAL spending stealth UTXO
//   THE FIX path: amount channel must use Alice's tweakedSk.
// ============================================================================
if (!state.p5RevealTxid) {
  step(5, 'STEALTH SPEND: Alice → Bob CLASSICAL CXFER spending the stealth UTXO');
  asAlice();
  const h = await dapp.scanHoldings();
  const ah = h.get(assetIdHex);
  const stealthUtxo = ah.utxos.find(u => u.stealthTweakedSk);
  if (!stealthUtxo) fail(`Alice's stealth UTXO not found`);
  info(`spending stealth UTXO ${stealthUtxo.utxo.txid.slice(0,16)}…:${stealthUtxo.utxo.vout} (${stealthUtxo.amount} units)`);
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ pubHex: BOB.pub_hex, amount: 100_000n }],
    forceUtxos: [stealthUtxo],  // forces the stealth UTXO as the input
  });
  ok(`reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p5 stealth-spend reveal');
  state.p5RevealTxid = r.revealTxid;
  saveState(state);
} else {
  step(5, `STEALTH SPEND already done — ${state.p5RevealTxid.slice(0, 16)}…`);
}

// Bob scans; must see the credit (proves amount channel symmetry held).
asBob();
{
  const h = await dapp.scanHoldings();
  const bh = h.get(assetIdHex);
  if (!bh) fail(`Bob lost all balance — scan failed`);
  // Bob's balance should be: supply - 200k (p3) - 150k (p4) + 100k (p5 back to Bob)
  const expected = 1_000_000n - 200_000n - 150_000n + 100_000n;
  if (bh.balance !== expected) fail(`Bob balance ${bh.balance} ≠ expected ${expected}`);
  ok(`Bob balance ${bh.balance} = supply - p3 - p4 + p5 ✓ (THE FIX proved on chain)`);
}

// ============================================================================
// Phase 6 — STEALTH → STEALTH: chained stealth via tacit CXFER
//   Bob (classical) → Carol (stealth) → Bob (stealth, downstream)
//   The 2nd hop is the most stressful: Carol spends a stealth UTXO and
//   sends to a stealth recipient — both channels use tweakedSk.
// ============================================================================
if (!state.p6aRevealTxid) {
  step(6, 'STEALTH → STEALTH chain: Bob → Carol stealth (hop A)');
  asBob();
  await dapp.scanHoldings();
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ stealthAddress: CAROL.stealth_address, amount: 80_000n }],
  });
  ok(`hop A reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p6a reveal');
  state.p6aRevealTxid = r.revealTxid;
  saveState(state);
} else {
  step(6, `hop A already done — ${state.p6aRevealTxid.slice(0, 16)}…`);
}

// Carol scans, picks up stealth credit.
asCarol();
{
  const h = await dapp.scanHoldings();
  const ch = h.get(assetIdHex);
  const stealth = ch?.utxos?.find(u => u.stealthTweakedSk && u.amount === 80_000n);
  if (!stealth) fail(`Carol missing stealth credit`);
  ok(`Carol has stealth UTXO (${stealth.amount} units), tweakedSk persisted`);
}

if (!state.p6bRevealTxid) {
  info('hop B: Carol → Bob STEALTH spending the stealth UTXO');
  asCarol();
  const h = await dapp.scanHoldings();
  const ch = h.get(assetIdHex);
  const stealth = ch.utxos.find(u => u.stealthTweakedSk && u.amount === 80_000n);
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ stealthAddress: BOB.stealth_address, amount: 50_000n }],
    forceUtxos: [stealth],
  });
  ok(`hop B reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p6b reveal');
  state.p6bRevealTxid = r.revealTxid;
  saveState(state);
} else {
  info(`hop B already done — ${state.p6bRevealTxid.slice(0, 16)}…`);
}

// Bob scans; must see the new stealth credit.
asBob();
{
  const h = await dapp.scanHoldings();
  const bh = h.get(assetIdHex);
  const newStealth = bh?.utxos?.find(u =>
    u.stealthTweakedSk && u.utxo.txid === state.p6bRevealTxid,
  );
  if (!newStealth) fail(`Bob missing final stealth credit from Carol`);
  ok(`Bob received stealth credit ${newStealth.amount} from Carol's stealth-spend ✓`);
  ok(`(this hop = double-stealth: tweakedSk on both input AND output channels)`);
  // Total expected: supply - p3(200k) - p4(150k) + p5(100k) - p6a(80k) + p6b(50k)
  const expected = 1_000_000n - 200_000n - 150_000n + 100_000n - 80_000n + 50_000n;
  if (bh.balance !== expected) fail(`Bob final balance ${bh.balance} ≠ expected ${expected}`);
  ok(`Bob final balance ${bh.balance} = supply - p3 - p4 + p5 - p6a + p6b ✓`);
}

// ============================================================================
// Summary
// ============================================================================
console.log('\n=== Tacit CXFER × stealth × signet — END-TO-END PASSED ===');
console.log('  ✓ Phase 1: pre-flight + auto-funding');
console.log('  ✓ Phase 2: CETCH test asset');
console.log('  ✓ Phase 3: classical CXFER baseline (regression check)');
console.log('  ✓ Phase 4: stealth send — Alice scans and persists tweakedSk');
console.log('  ✓ Phase 5: stealth → classical (THE FIX path, on real chain)');
console.log('  ✓ Phase 6: stealth → stealth chain (double-stealth round-trip)');
console.log(`\n  asset_id: ${assetIdHex}`);
console.log('  See .local/stealth-cxfer-signet-state.json for tx ids.\n');
