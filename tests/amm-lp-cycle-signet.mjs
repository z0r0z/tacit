// AMM LP cycle signet smoke — LP_ADD variant 0 → LP_REMOVE round-trip.
//
// Validates the parallel collab's dapp builders end-to-end:
//   buildAndBroadcastLpAddVariant0  → add liquidity to existing pool
//   buildAndBroadcastLpRemove       → burn shares, recover proportional reserves
//
// Pre-req:
//   .local/amm-signet-wallet.json   (gen-amm-signet-wallet.mjs)
//   .local/amm-signet-state.json    (amm-smoke-signet.mjs phase 4 complete)
//   Pool registered on chain (POOL_INIT + at least one swap settled — this
//   smoke uses post-first-swap reserves 110000/272802 by default).
//
// Phases (resumable via .local/amm-lp-cycle-state.json):
//   1. Pre-flight (wallet balances + pool reserves)
//   2. LP_ADD variant 0 (proportional liquidity add)
//   3. LP_REMOVE (burn all just-added shares, recover ≈ original deltas)
//   4. Verify wallet balances roughly restored (small rounding losses OK)
//
// Env overrides:
//   POOL_R_A             current reserve_A (default 110000 = post-first-swap)
//   POOL_R_B             current reserve_B (default 272802)
//   POOL_S               current lp_total_shares (default 173205 = founder+locked)
//   LP_ADD_DELTA_A       asset_A to deposit (default 11000)
//   SKIP_LP_REMOVE=1     stop after LP_ADD (test add only)
//   SKIP_BROADCAST=1     build txs + print hex without broadcasting

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'amm-lp-cycle-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'amm-signet-wallet.json');
const POOL_STATE_FILE = path.join(STATE_DIR, 'amm-signet-state.json');

if (!existsSync(WALLET_FILE) || !existsSync(POOL_STATE_FILE)) {
  console.error('✗ Missing wallet or pool state. Run gen-amm-signet-wallet.mjs + amm-smoke-signet.mjs first.');
  process.exit(1);
}
const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const POOL_INIT_STATE = JSON.parse(readFileSync(POOL_STATE_FILE, 'utf8'));
if (!POOL_INIT_STATE.poolInit?.pool_id_hex) {
  console.error('✗ Pool not seeded. Run amm-smoke-signet.mjs phase 4 first.');
  process.exit(1);
}

const PRIV = hexToBytes(W.priv_hex);
const PUB = secp.getPublicKey(PRIV, true);

const R_A = BigInt(process.env.POOL_R_A || 110000n);
const R_B = BigInt(process.env.POOL_R_B || 272802n);
const S = BigInt(process.env.POOL_S || 173205n);
const DELTA_A = BigInt(process.env.LP_ADD_DELTA_A || 11000n);
const SKIP_LP_REMOVE = process.env.SKIP_LP_REMOVE === '1';
const SKIP_BROADCAST = process.env.SKIP_BROADCAST === '1';

// Compute at-ratio DELTA_B: dB = floor(dA · R_B / R_A) so the LP gets
// proportional shares without donating excess on the B side. Floor errors
// would slightly over-deposit B; we round up by 1 to ensure the kernel
// sig closes (a_side share ≤ b_side share → min = a_side = expected).
const DELTA_B_raw = (DELTA_A * R_B) / R_A;
const DELTA_B = DELTA_B_raw + 1n;  // donate the rounding remainder to existing LPs

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

const dapp = await import('../dapp/tacit.js');
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
dapp.invalidateHoldingsCache();

const POOL = POOL_INIT_STATE.poolInit;
const state = loadState();

console.log(`\n=== AMM LP cycle signet smoke ===\n`);
console.log(`  address:      ${W.address}`);
console.log(`  pool_id:      ${POOL.pool_id_hex}`);
console.log(`  reserve_A:    ${R_A}  (asset ${POOL.canonical_asset_a.slice(0,12)}…)`);
console.log(`  reserve_B:    ${R_B}  (asset ${POOL.canonical_asset_b.slice(0,12)}…)`);
console.log(`  total_shares: ${S}`);
console.log(`  fee_bps:      ${POOL.fee_bps}`);
console.log(``);
console.log(`  LP_ADD delta_A: ${DELTA_A}`);
console.log(`  LP_ADD delta_B: ${DELTA_B}  (at-ratio + 1 unit to ensure kernel sig closure)`);

// Expected shares = floor(min(dA·S/R_A, dB·S/R_B))
const sharesA = (DELTA_A * S) / R_A;
const sharesB = (DELTA_B * S) / R_B;
const EXPECTED_SHARES = sharesA < sharesB ? sharesA : sharesB;
console.log(`  expected shares: ${EXPECTED_SHARES}  (a-side=${sharesA}, b-side=${sharesB})`);
if (EXPECTED_SHARES <= 0n) fail('zero-share LP_ADD — increase DELTA_A');

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight');
const utxos = await dapp.getUtxos(W.address);
const sats = utxos.reduce((s, u) => s + u.value, 0);
info(`sats balance: ${sats}`);
if (sats < 15_000) fail(`underfunded: need ≥ 15k sats for LP_ADD + LP_REMOVE`);
const holdings = await dapp.scanHoldings();
const hA = holdings.get(POOL.canonical_asset_a);
const hB = holdings.get(POOL.canonical_asset_b);
if (!hA || hA.balance < DELTA_A) fail(`asset_A balance ${hA?.balance ?? 0} < ${DELTA_A}`);
if (!hB || hB.balance < DELTA_B) fail(`asset_B balance ${hB?.balance ?? 0} < ${DELTA_B}`);
ok(`asset_A: ${hA.balance} (need ${DELTA_A})`);
ok(`asset_B: ${hB.balance} (need ${DELTA_B})`);

// ---- Phase 2: LP_ADD variant 0 ----
step(2, 'LP_ADD variant 0 (proportional add)');
let lpShareTxid;
let lpShareVout;
let lpShareAmount;
let lpShareBlinding;
if (state.lpAdd?.reveal_txid) {
  ok(`reusing LP_ADD from prior run: ${state.lpAdd.reveal_txid.slice(0,16)}…`);
  lpShareTxid = state.lpAdd.reveal_txid;
  lpShareVout = 0;
  lpShareAmount = BigInt(state.lpAdd.share_amount);
  lpShareBlinding = state.lpAdd.lp_share_blinding_hex;
} else if (SKIP_BROADCAST) {
  fail('SKIP_BROADCAST=1: cannot proceed without an LP_ADD UTXO');
} else {
  info(`broadcasting buildAndBroadcastLpAddVariant0 (deposit ${DELTA_A} + ${DELTA_B})…`);
  const r = await dapp.buildAndBroadcastLpAddVariant0({
    poolIdHex: POOL.pool_id_hex,
    assetAIdHex: POOL.canonical_asset_a,
    assetBIdHex: POOL.canonical_asset_b,
    deltaA: DELTA_A,
    deltaB: DELTA_B,
    shareAmount: EXPECTED_SHARES,
    feeBps: POOL.fee_bps,
    poolCapabilityFlags: 0,
  });
  ok(`commit ${r.commitTxid.slice(0,16)}… reveal ${r.revealTxid.slice(0,16)}…`);
  ok(`LP shares minted: ${r.shareAmount} at vout[0]`);
  state.lpAdd = {
    commit_txid: r.commitTxid,
    reveal_txid: r.revealTxid,
    delta_a: DELTA_A.toString(),
    delta_b: DELTA_B.toString(),
    share_amount: r.shareAmount.toString(),
    lp_share_blinding_hex: r.rShareSecpHex,
  };
  saveState(state);
  lpShareTxid = r.revealTxid;
  lpShareVout = 0;
  lpShareAmount = BigInt(r.shareAmount);
  lpShareBlinding = r.rShareSecpHex;
  info(`waiting 90s for LP_ADD confirmation…`);
  await sleep(90_000);
}

if (SKIP_LP_REMOVE) {
  console.log(`\n=== LP_ADD complete (SKIP_LP_REMOVE=1) ===`);
  console.log(`  LP shares at ${lpShareTxid.slice(0,16)}…:0 = ${lpShareAmount}`);
  process.exit(0);
}

// ---- Phase 3: LP_REMOVE ----
step(3, 'LP_REMOVE (burn shares, recover proportional reserves)');
// Recompute reserves + shares post-LP_ADD (the worker would have updated these).
const R_A_post_add = R_A + DELTA_A;
const R_B_post_add = R_B + DELTA_B;
const S_post_add = S + EXPECTED_SHARES;
const EXPECTED_OUT_A = (R_A_post_add * lpShareAmount) / S_post_add;
const EXPECTED_OUT_B = (R_B_post_add * lpShareAmount) / S_post_add;
info(`reserves post-add: ${R_A_post_add}/${R_B_post_add}, shares ${S_post_add}`);
info(`burning ${lpShareAmount} shares → expecting ${EXPECTED_OUT_A} asset_A + ${EXPECTED_OUT_B} asset_B`);

if (state.lpRemove?.reveal_txid) {
  ok(`reusing LP_REMOVE from prior run: ${state.lpRemove.reveal_txid.slice(0,16)}…`);
} else {
  info(`broadcasting buildAndBroadcastLpRemove…`);
  const r = await dapp.buildAndBroadcastLpRemove({
    poolIdHex: POOL.pool_id_hex,
    assetAIdHex: POOL.canonical_asset_a,
    assetBIdHex: POOL.canonical_asset_b,
    shareAmount: lpShareAmount,
    expectedDeltaA: EXPECTED_OUT_A,
    expectedDeltaB: EXPECTED_OUT_B,
    lpShareUtxos: [{
      utxo: { txid: lpShareTxid, vout: lpShareVout },
      amount: lpShareAmount,
      // dapp's LP_REMOVE expects blinding as a BigInt — convert hex string.
      blinding: typeof lpShareBlinding === 'bigint' ? lpShareBlinding : BigInt('0x' + lpShareBlinding),
    }],
    feeBps: POOL.fee_bps,
    poolCapabilityFlags: 0,
  });
  ok(`commit ${r.commitTxid.slice(0,16)}… reveal ${r.revealTxid.slice(0,16)}…`);
  ok(`recovered: ${r.deltaA} asset_A + ${r.deltaB} asset_B`);
  state.lpRemove = {
    commit_txid: r.commitTxid,
    reveal_txid: r.revealTxid,
    delta_a: r.deltaA.toString(),
    delta_b: r.deltaB.toString(),
  };
  saveState(state);
}

console.log(`\n=== AMM LP cycle signet smoke complete ===\n`);
console.log(`  pool:         ${POOL.pool_id_hex}`);
console.log(`  LP_ADD reveal: https://mempool.space/signet/tx/${state.lpAdd.reveal_txid}`);
console.log(`  LP_REMOVE reveal: https://mempool.space/signet/tx/${state.lpRemove.reveal_txid}`);
console.log(`  net asset_A change: -${DELTA_A} + ${state.lpRemove.delta_a} = ${BigInt(state.lpRemove.delta_a) - DELTA_A} (≈ rounding loss)`);
console.log(`  net asset_B change: -${DELTA_B} + ${state.lpRemove.delta_b} = ${BigInt(state.lpRemove.delta_b) - DELTA_B} (≈ rounding loss)`);
