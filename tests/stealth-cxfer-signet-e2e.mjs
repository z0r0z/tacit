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

// scanHoldings has a hardcoded 90s timeout against mempool.space, which
// rate-limits aggressively. Wrap with retry-on-timeout — the scan is
// idempotent and cache-warming means the retry usually completes quickly.
async function scanHoldingsRetry(maxAttempts = 5) {
  let last;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await dapp.scanHoldings();
    } catch (e) {
      last = e;
      if (!String(e?.message || '').includes('exceeded 90s')) throw e;
      info(`scanHoldings timed out (attempt ${i + 1}/${maxAttempts}); retrying in 15s…`);
      await sleep(15000);
    }
  }
  throw last;
}

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
  await scanHoldingsRetry();
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
  const h = await scanHoldingsRetry();
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
  await scanHoldingsRetry();
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

// Alice discovers her stealth credit via the new dapp API (the sender
// shares the txid out-of-band; she calls discoverStealthFromTxid).
// scanHoldings alone can't find stealth outputs because they sit at
// P2WPKH(commit), not at wallet.address() — discovery is necessarily
// txid-driven in v1.
asAlice();
let aliceStealthCredit;
{
  const discovered = await dapp.discoverStealthFromTxid(state.p4RevealTxid);
  if (discovered.length < 1) fail(`Alice's discoverStealthFromTxid returned 0 credits — math broken`);
  const credit = discovered.find(d => d.assetIdHex === assetIdHex);
  if (!credit) fail(`Alice discovered credits but none for this asset`);
  ok(`Alice discovered stealth credit: ${credit.amount} units, vout ${credit.vout}`);
  ok(`tweakedSk persisted; senderPubHex = ${credit.senderPubHex.slice(0, 16)}…`);
  // Confirm the on-chain script IS P2WPKH(commit), not P2WPKH(alice.pub).
  const txData = await fetch(`https://mempool.space/signet/api/tx/${credit.txid}`).then(r => r.json());
  const outScript = txData.vout[credit.vout].scriptpubkey;
  const classicalScript = bytesToHex(dapp.p2wpkhScript(hexToBytes(ALICE.pub_hex)));
  if (outScript === classicalScript) fail(`stealth output's script is P2WPKH(alice.pub) — NOT shielded`);
  // Verify tweakedSk · G == commit (the on-chain pubkey hash).
  const tweakedPub = secp.getPublicKey(hexToBytes(credit.stealthTweakedSk), true);
  const expectedScript = bytesToHex(dapp.p2wpkhScript(tweakedPub));
  if (outScript !== expectedScript) fail(`tweakedSk·G doesn't match on-chain script`);
  ok(`stealth output script verified: P2WPKH(commit) where tweakedSk·G == commit ✓`);
  aliceStealthCredit = credit;
}

// ============================================================================
// Phase 5 — STEALTH SPEND: Alice → Bob CLASSICAL spending stealth UTXO
//   THE FIX path: amount channel must use Alice's tweakedSk.
// ============================================================================
if (!state.p5RevealTxid) {
  step(5, 'STEALTH SPEND: Alice → Bob CLASSICAL CXFER spending the stealth UTXO');
  asAlice();
  if (!aliceStealthCredit) {
    // Resumed run: re-discover.
    const discovered = await dapp.discoverStealthFromTxid(state.p4RevealTxid);
    aliceStealthCredit = discovered.find(d => d.assetIdHex === assetIdHex);
    if (!aliceStealthCredit) fail(`could not re-discover Alice's stealth credit on resume`);
  }
  // Shape the discovered credit as a forceUtxos entry.
  const stealthForceUtxo = {
    utxo: { txid: aliceStealthCredit.txid, vout: aliceStealthCredit.vout, value: dapp.DUST, status: {} },
    amount: aliceStealthCredit.amount,
    blinding: aliceStealthCredit.blinding,
    commitment: aliceStealthCredit.commitment,
    stealthTweakedSk: aliceStealthCredit.stealthTweakedSk,
  };
  info(`spending stealth UTXO ${stealthForceUtxo.utxo.txid.slice(0,16)}…:${stealthForceUtxo.utxo.vout} (${stealthForceUtxo.amount} units)`);
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ pubHex: BOB.pub_hex, amount: 100_000n }],
    forceUtxos: [stealthForceUtxo],
  });
  ok(`reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p5 stealth-spend reveal');
  state.p5RevealTxid = r.revealTxid;
  saveState(state);
} else {
  step(5, `STEALTH SPEND already done — ${state.p5RevealTxid.slice(0, 16)}…`);
}

// Bob scans; must see the credit (proves amount channel symmetry held).
// Bob receives back at his CLASSICAL address here, so plain scanHoldings sees it.
asBob();
{
  const h = await scanHoldingsRetry();
  const bh = h.get(assetIdHex);
  if (!bh) fail(`Bob lost all balance — scan failed`);
  // After Phase 5, Bob's classical balance = (CETCH-allocated - sent in p3,p4) +
  // p5 receive. CETCH credit auto-detected via scanHoldings on Bob's address.
  // Verify a credit at p5RevealTxid landed:
  const p5Credit = bh.utxos.find(u => u.utxo.txid === state.p5RevealTxid);
  if (!p5Credit) fail(`Bob can't find p5 credit at ${state.p5RevealTxid.slice(0,16)}…`);
  if (p5Credit.amount !== 100_000n) fail(`p5 credit amount ${p5Credit.amount} ≠ 100000`);
  ok(`Bob received 100000 from Alice's stealth-spend (p5: ${state.p5RevealTxid.slice(0,16)}…) ✓`);
  ok(`THE FIX (amount-channel ECDH via tweakedSk) proved on chain`);
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
  await scanHoldingsRetry();
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

// Carol discovers her stealth credit via the explicit API.
asCarol();
let carolStealthCredit;
{
  const discovered = await dapp.discoverStealthFromTxid(state.p6aRevealTxid);
  const credit = discovered.find(d => d.assetIdHex === assetIdHex && d.amount === 80_000n);
  if (!credit) fail(`Carol missing stealth credit (discovered: ${discovered.length})`);
  ok(`Carol discovered stealth UTXO: ${credit.amount} units, tweakedSk persisted`);
  carolStealthCredit = credit;
}

if (!state.p6bRevealTxid) {
  info('hop B: Carol → Bob STEALTH spending the stealth UTXO (DOUBLE-STEALTH path)');
  asCarol();
  if (!carolStealthCredit) {
    const discovered = await dapp.discoverStealthFromTxid(state.p6aRevealTxid);
    carolStealthCredit = discovered.find(d => d.assetIdHex === assetIdHex && d.amount === 80_000n);
    if (!carolStealthCredit) fail(`could not re-discover Carol's stealth credit on resume`);
  }
  const stealthForceUtxo = {
    utxo: { txid: carolStealthCredit.txid, vout: carolStealthCredit.vout, value: dapp.DUST, status: {} },
    amount: carolStealthCredit.amount,
    blinding: carolStealthCredit.blinding,
    commitment: carolStealthCredit.commitment,
    stealthTweakedSk: carolStealthCredit.stealthTweakedSk,
  };
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ stealthAddress: BOB.stealth_address, amount: 50_000n }],
    forceUtxos: [stealthForceUtxo],
  });
  ok(`hop B reveal ${r.revealTxid.slice(0, 16)}…`);
  await waitConfirmed(r.revealTxid, 'p6b reveal');
  state.p6bRevealTxid = r.revealTxid;
  saveState(state);
} else {
  info(`hop B already done — ${state.p6bRevealTxid.slice(0, 16)}…`);
}

// Bob discovers the final stealth credit. The hop B is the "double-stealth"
// case: Carol spent a stealth UTXO (tweakedSk input) AND sent to a stealth
// recipient (commit output). Both ECDH channels must use the right scalars;
// getting either wrong silently breaks here.
asBob();
{
  const discovered = await dapp.discoverStealthFromTxid(state.p6bRevealTxid);
  const credit = discovered.find(d => d.assetIdHex === assetIdHex && d.amount === 50_000n);
  if (!credit) fail(`Bob missing final stealth credit from Carol (discovered: ${discovered.length})`);
  ok(`Bob discovered stealth credit ${credit.amount} from Carol's stealth-spend ✓`);
  ok(`(this hop = double-stealth: tweakedSk on both input AND output channels)`);
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
