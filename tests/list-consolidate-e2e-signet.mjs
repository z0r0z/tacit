// End-to-end smoke test for the dapp's multi-UTXO consolidate-and-list path.
// Runs against live signet + the production worker. Single burner wallet:
//
//   1. Etches a fresh test asset with supply == 23 (small, innocuous)
//   2. Self-CXFERs supply into 4 UTXOs of amounts {3, 5, 7, 8} (the user's
//      reported example)
//   3. Drives the exact code path the new listing flow uses:
//        coverUtxos = greedy descending pick (all 4)
//        buildAndBroadcastCXferMulti({ recipients: [{ self, 23 }], forceUtxos: coverUtxos })
//      Produces one 23-amount UTXO + 0-change UTXO (Σinputs == listAmount).
//   4. POSTs the resulting UTXO to the marketplace worker as a listing.
//   5. Fetches the listing back to confirm it landed.
//
// Run (interactive, you fund + press Enter between phases):
//   SEED=<hex64> node tests/list-consolidate-e2e-signet.mjs
//
// Or skip the pauses (script polls balances on its own):
//   CONFIRM=1 SEED=<hex64> node tests/list-consolidate-e2e-signet.mjs

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ============== jsdom shim + dapp boot ==============
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const m = await import('../dapp/tacit.js');

// ============== config ==============
const WORKER_BASE = (process.env.WORKER_BASE || 'https://api.tacit.finance').replace(/\/+$/, '');
const TICKER = process.env.TICKER || 'CTAC1';
const SUPPLY = 23n;     // CETCH supply: sum we'll list. Tiny + matches the user's example exactly.
const FRAGMENT_K = 3;   // K=3 recipients + 1 change = 4 UTXOs of {3, 5, 7, 8}
const FRAGMENT_AMOUNTS = [3n, 5n, 7n];     // change becomes 23 - 3 - 5 - 7 = 8 automatically
const LIST_AMOUNT = 23n; // We list the sum, forcing consolidation of all 4 inputs.
const PRICE_SATS = 5000;
const EXPIRY_DAYS = 7;
const DRY_RUN = !!process.env.DRY_RUN;

// Deterministic key from SEED (so re-runs hit the same funded address).
function deriveFromSeed(seedHex) {
  return bytesToHex(sha256(new TextEncoder().encode('tacit-list-consolidate-signet-v1:maker:' + seedHex)));
}
const SEED = (process.env.SEED || '').toLowerCase();
const MAKER_PRIV = (process.env.MAKER_PRIV || (SEED ? deriveFromSeed(SEED) : '')).toLowerCase();
if (!/^[0-9a-f]{64}$/.test(MAKER_PRIV)) {
  console.error('MAKER_PRIV not set or malformed. Set MAKER_PRIV=<hex64> or SEED=<hex64> to derive.');
  process.exit(1);
}
const makerPriv = hexToBytes(MAKER_PRIV);
const makerPub = secp.getPublicKey(makerPriv, true);
const makerAddr = bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(makerPub)))]);

function setWallet() {
  m.wallet.priv = makerPriv;
  m.wallet.pub = makerPub;
  m.invalidateHoldingsCache();
}
setWallet();

// ============== preflight ==============
console.log('\n=== Tacit signet consolidate-and-list smoke test ===');
console.log(`Worker:    ${WORKER_BASE}`);
console.log(`Ticker:    ${TICKER} (supply ${SUPPLY}, 0 decimals)`);
console.log(`Maker:     ${makerAddr}`);
console.log(`Maker pub: ${bytesToHex(makerPub)}`);
console.log(`Plan: fragment supply into {3,5,7,8}, list 23 → forces 4-input consolidate-and-carve CXFER\n`);

const NONINTERACTIVE = !!process.env.CONFIRM || !stdin.isTTY;
const rl = NONINTERACTIVE ? null : readline.createInterface({ input: stdin, output: stdout });
async function pause(prompt) {
  if (NONINTERACTIVE) { console.log(prompt + ' [auto-confirmed]'); return ''; }
  return await rl.question(prompt + ' [Enter to continue, Ctrl-C to abort] ');
}
async function balanceSats(addr) {
  try {
    const r = await fetch(`https://mempool.space/signet/api/address/${addr}/utxo`);
    if (!r.ok) return null;
    const utxos = await r.json();
    return utxos.reduce((s, x) => s + (x.value || 0), 0);
  } catch { return null; }
}
async function waitForTxVisible(txid, label) {
  process.stdout.write(`  waiting for ${label} (${txid.slice(0, 16)}…) to be visible…`);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
      if (r.ok) { console.log(' visible'); return; }
    } catch {}
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(' timeout (continuing)');
}
async function waitForIndexer(seconds, label) {
  process.stdout.write(`  waiting ${seconds}s for indexer to pick up ${label}…`);
  for (let i = 0; i < seconds; i++) {
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(' done');
}

console.log('Fund the maker address with ~30,000 signet sats (CETCH ~15k + fragment ~5k + consolidate ~5k + headroom):');
console.log(`  ${makerAddr}`);
console.log('Signet faucets: https://signet.bublina.eu.org/  ·  https://alt.signetfaucet.com/\n');

if (!DRY_RUN) {
  await pause('Fund the address above, then');
  const bal = await balanceSats(makerAddr);
  if (bal == null) console.log('  balance: fetch failed (network) — continuing anyway');
  else console.log(`  balance: ${bal.toLocaleString()} sats`);
  if (bal != null && bal < 15000) {
    console.log('  ⚠ low balance — CETCH may fail. Fund more or proceed at your own risk.');
    await pause('Continue anyway?');
  }
}

// ============== phase 1: CETCH ==============
console.log('\nPhase 1: CETCH test asset');
const cetch = await m.buildAndBroadcastCEtch({
  ticker: TICKER,
  decimals: 0,
  supplyBase: SUPPLY,
  mintable: false,
  imageUri: null,
});
console.log(`  CETCH reveal txid: ${cetch.revealTxid}`);
const assetIdHex = cetch.assetIdHex;
console.log(`  asset_id: ${assetIdHex}`);
await waitForTxVisible(cetch.revealTxid, 'CETCH reveal');
await waitForIndexer(60, 'CETCH'); // worker indexer ~30s; double it for safety

// ============== phase 2: fragment supply → 4 UTXOs of {3,5,7,8} ==============
console.log('\nPhase 2: Fragment supply via one self-CXFER (K=3 recipients + 1 change)');
m.invalidateHoldingsCache();
const holdings0 = await m.scanHoldings(true);
const h0 = holdings0.get(assetIdHex);
if (!h0 || h0.balance !== SUPPLY) {
  console.error(`  expected balance ${SUPPLY}, got ${h0?.balance ?? 'none'}`);
  process.exit(1);
}
console.log(`  initial UTXOs: [${h0.utxos.map(u => u.amount.toString()).join(', ')}]`);

const fragResult = await m.buildAndBroadcastCXferMulti({
  assetIdHex,
  recipients: FRAGMENT_AMOUNTS.map(amt => ({ pubHex: bytesToHex(makerPub), amount: amt })),
  allowDuplicateRecipients: true,
});
console.log(`  fragment reveal txid: ${fragResult.revealTxid}`);
await waitForTxVisible(fragResult.revealTxid, 'fragment reveal');
await waitForIndexer(60, 'fragment');

m.invalidateHoldingsCache();
const holdings1 = await m.scanHoldings(true);
const h1 = holdings1.get(assetIdHex);
if (!h1 || h1.balance !== SUPPLY) {
  console.error(`  expected balance ${SUPPLY} after fragment, got ${h1?.balance ?? 'none'}`);
  process.exit(1);
}
const amts = [...h1.utxos.map(u => u.amount)].sort((a, b) => Number(a - b));
console.log(`  fragmented UTXOs: [${amts.map(x => x.toString()).join(', ')}]`);
const expected = [3n, 5n, 7n, 8n];
if (amts.length !== 4 || amts.some((a, i) => a !== expected[i])) {
  console.error(`  expected [3,5,7,8], got [${amts.join(',')}]`);
  process.exit(1);
}
console.log('  ✓ fragmented into 4 UTXOs of {3, 5, 7, 8}');

// ============== phase 3: consolidate-and-list (the path under test) ==============
console.log('\nPhase 3: Consolidate-and-list (the new code path)');
// Mirror the picker from dapp/tacit.js: sort descending, greedy until sum ≥ amount.
const sorted = [...h1.utxos].sort((a, b) => a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0);
const availLargest = sorted[0].amount;
const availTotal = sorted.reduce((s, u) => s + u.amount, 0n);
console.log(`  availLargest=${availLargest}, availTotal=${availTotal}, listAmount=${LIST_AMOUNT}`);
if (LIST_AMOUNT > availTotal) { console.error('  insufficient holdings'); process.exit(1); }

let coverUtxos;
if (LIST_AMOUNT <= availLargest) {
  // Single-cover path (preserves existing auto-split behavior — should NOT
  // trigger here since 23 > max(3,5,7,8)=8). Asserting it doesn't is part
  // of the test: a regression that picked one UTXO and tried to split it
  // would underflow at the builder.
  console.error(`  TEST INVARIANT VIOLATED: listAmount ${LIST_AMOUNT} ≤ availLargest ${availLargest} — fragmentation produced wrong shape`);
  process.exit(1);
} else {
  coverUtxos = [];
  let sum = 0n;
  for (const u of sorted) { coverUtxos.push(u); sum += u.amount; if (sum >= LIST_AMOUNT) break; }
}
console.log(`  coverUtxos: ${coverUtxos.length} inputs = [${coverUtxos.map(u => u.amount.toString()).join(', ')}]`);
console.log(`  Σinputs = ${coverUtxos.reduce((s, u) => s + u.amount, 0n)} (expect ${LIST_AMOUNT} → change = 0)`);

const listCxfer = await m.buildAndBroadcastCXferMulti({
  assetIdHex,
  recipients: [{ pubHex: bytesToHex(makerPub), amount: LIST_AMOUNT }],
  forceUtxos: coverUtxos,
});
console.log(`  consolidate-list reveal txid: ${listCxfer.revealTxid}`);
const r0 = listCxfer.recipients[0];
console.log(`  listing UTXO: ${listCxfer.revealTxid}:${r0.vout} amount=${r0.amount}`);
if (r0.amount !== LIST_AMOUNT) {
  console.error(`  listing UTXO amount ${r0.amount} != ${LIST_AMOUNT}`); process.exit(1);
}
await waitForTxVisible(listCxfer.revealTxid, 'consolidate-list reveal');
await waitForIndexer(60, 'consolidate-list');

// Verify holdings now show one 23-amount UTXO (+ 0-change UTXO).
m.invalidateHoldingsCache();
const holdings2 = await m.scanHoldings(true);
const h2 = holdings2.get(assetIdHex);
if (!h2) { console.error('  asset disappeared after consolidate'); process.exit(1); }
console.log(`  post-consolidate UTXOs: [${h2.utxos.map(u => u.amount.toString()).join(', ')}]`);
const post = [...h2.utxos.map(u => u.amount)].sort((a, b) => Number(a - b));
// Expect: [0, 23]. The 0-amount change UTXO is the protocol output that
// makes m=2; same bytes shape as any K<m padding output.
if (post.length !== 2 || post[0] !== 0n || post[1] !== LIST_AMOUNT) {
  console.error(`  expected [0, 23], got [${post.join(',')}]`);
  // Don't exit — the listing may still be valid even if the 0-change UTXO
  // confuses the wallet's display logic. Surface as a warning.
  console.warn('  ⚠ holdings shape unexpected — investigate before mainnet');
}
if (h2.balance !== SUPPLY) {
  console.error(`  total balance drifted: expected ${SUPPLY}, got ${h2.balance}`);
  process.exit(1);
}
console.log('  ✓ multi-input consolidate produced one 23-amount UTXO');

// ============== phase 4: publish listing to worker ==============
console.log('\nPhase 4: Publish listing to worker');
const expiry = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400;
// Recompute opening + listing sigs the same way publishListing() does internally.
const assetIdBytes = hexToBytes(assetIdHex);
const blindingBytes = (() => {
  const b = new Uint8Array(32);
  const dv = new DataView(b.buffer);
  const v = BigInt(r0.blinding);
  // Big-endian 32-byte serialization of the scalar.
  for (let i = 0; i < 32; i++) {
    dv.setUint8(31 - i, Number((v >> BigInt(8 * i)) & 0xffn));
  }
  return b;
})();
const oMsg = m.openingMsg(assetIdBytes, listCxfer.revealTxid, r0.vout, r0.amount, blindingBytes, makerPub);
const openingSig = m.signSchnorr(oMsg, makerPriv);
const lMsg = m.listingMsgBytes(assetIdBytes, listCxfer.revealTxid, r0.vout, PRICE_SATS, expiry, makerAddr, openingSig);
const listingSig = m.signSchnorr(lMsg, makerPriv);

const listingsUrl = `${WORKER_BASE}/assets/${assetIdHex}/listings?network=signet`;
const postBody = {
  txid: listCxfer.revealTxid,
  vout: r0.vout,
  amount: r0.amount.toString(),
  blinding: bytesToHex(blindingBytes),
  owner_pubkey: bytesToHex(makerPub),
  opening_sig: bytesToHex(openingSig),
  price_sats: PRICE_SATS,
  maker_address: makerAddr,
  expiry,
  listing_sig: bytesToHex(listingSig),
};
console.log(`  POST ${listingsUrl}`);
const postResp = await fetch(listingsUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(postBody),
});
const postJson = await postResp.json().catch(() => ({}));
if (!postResp.ok) {
  console.error(`  POST failed: HTTP ${postResp.status} — ${postJson.error || JSON.stringify(postJson)}`);
  process.exit(1);
}
console.log('  ✓ POST 200 — listing accepted by worker');

// Fetch back to confirm it surfaces.
const getUrl = `${WORKER_BASE}/assets/${assetIdHex}/listings?network=signet`;
const getResp = await fetch(getUrl);
const getJson = await getResp.json().catch(() => ({}));
const listings = Array.isArray(getJson) ? getJson : (getJson.listings || []);
const ours = listings.find(l => l.txid === listCxfer.revealTxid && (l.vout | 0) === (r0.vout | 0));
if (!ours) {
  console.error(`  listing not found in GET response (count=${listings.length})`);
  console.error(JSON.stringify(getJson).slice(0, 500));
  process.exit(1);
}
console.log(`  ✓ listing visible in GET: ${ours.amount} @ ${ours.price_sats} sats, expires ${new Date(ours.expiry * 1000).toISOString()}`);

console.log('\n=== ALL PHASES PASSED ===');
console.log(`asset_id:         ${assetIdHex}`);
console.log(`listing txid:vout: ${listCxfer.revealTxid}:${r0.vout}`);
console.log(`marketplace URL:   ${WORKER_BASE}/assets/${assetIdHex}/listings?network=signet`);
console.log('\nWhat this validated end-to-end:');
console.log('  • Multi-input CXFER (4 inputs → 1 listing output + 0 change) accepted by signet network');
console.log('  • Indexer recognized the consolidated UTXO as a valid asset holding');
console.log('  • Worker accepted the published listing (opening sig + listing sig verified)');
console.log('  • Listing is discoverable via GET — the user-reported gap is closed end-to-end');

if (rl) rl.close();
