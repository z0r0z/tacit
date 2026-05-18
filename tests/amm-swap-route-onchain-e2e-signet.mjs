// T_SWAP_ROUTE on-chain end-to-end signet harness.
//
// Targeted rehearsal for atomic multi-hop AMM routing (opcode 0x33). The
// AMM full e2e (amm-full-e2e-signet.mjs Phase 8) already covers SEQUENTIAL
// multi-hop (two separate T_SWAP_VAR txs); this harness covers the
// new ATOMIC multi-hop path via buildAndBroadcastSwapRoute. The full
// flow is:
//
//   - 3 CETCHes: A, BRIDGE, C (1M supply each, decimals=0)
//   - 2 POOL_INITs: (A, BRIDGE)@30bps and (BRIDGE, C)@30bps
//   - 1 atomic T_SWAP_ROUTE: A → C via [pool_AB, pool_BC] in one Bitcoin tx
//   - previewSwapRoute() dispatch sanity-check vs the sequential path
//
// Pre-req:
//   .local/amm-e2e-signet-wallets.json (gen-amm-e2e-signet-wallets.mjs)
//   The FOUNDER role pays for everything here (CETCH × 3 + POOL_INIT × 2
//   + T_SWAP_ROUTE × 1). The trader role IS the founder for simplicity;
//   no cross-party fee accounting in this harness — that's covered by
//   amm-full-e2e-signet.mjs. Budget ≥ 200k signet sats.
//
// Resumable: each phase persists to .local/amm-swap-route-e2e-state.json.
// Re-running picks up where it left off. To restart: rm that file.
//
// Run:  node tests/amm-swap-route-onchain-e2e-signet.mjs

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
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'amm-swap-route-e2e-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');

if (!existsSync(WALLETS_FILE)) {
  console.error(`✗ Wallets not found at ${WALLETS_FILE}`);
  console.error(`  Run: node tests/gen-amm-e2e-signet-wallets.mjs`);
  process.exit(1);
}

const WALLETS = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const FOUNDER = {
  priv: hexToBytes(WALLETS.founder.priv_hex),
  pub: secp.getPublicKey(hexToBytes(WALLETS.founder.priv_hex), true),
  addr: WALLETS.founder.address,
};
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(FOUNDER.pub), '1'); } catch {}

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function useFounder() {
  dapp.wallet.priv = FOUNDER.priv;
  dapp.wallet.pub = FOUNDER.pub;
  dapp.invalidateHoldingsCache();
}

const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';
async function fetchPool(poolIdHex) {
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pool/${poolIdHex}?network=signet`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function waitForPool(poolIdHex, label, attempts = 20, delayMs = 30_000) {
  info(`polling worker for pool ${label} (${poolIdHex.slice(0, 16)}…)`);
  for (let i = 1; i <= attempts; i++) {
    const p = await fetchPool(poolIdHex);
    if (p?.pool_id === poolIdHex.toLowerCase()) {
      ok(`pool ${label} registered (R_A=${p.reserve_a}, R_B=${p.reserve_b})`);
      return p;
    }
    info(`  attempt ${i}/${attempts}: not yet registered`);
    if (i < attempts) await sleep(delayMs);
  }
  return null;
}
async function fetchAllPools() {
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pools?limit=200&network=signet`);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.pools) ? j.pools : [];
  } catch { return []; }
}

// Poll mempool.space until the given txid lands in a block. Returns the
// confirmation height on success, null on timeout. Critical when chaining
// broadcasts on signet (10-min average blocks): without confirmation the
// mempool-ancestor chain grows deep enough that some downstream broadcast
// fails with "bad-txns-inputs-missingorspent" because mempool.space's
// /utxo endpoint hasn't reindexed the just-spent UTXO yet. Polling the
// LAST broadcast's confirmation guarantees the entire ancestor chain is
// resolved on chain before the next phase issues its first carve.
async function waitForTxConfirmed(txid, label, attempts = 40, delayMs = 30_000) {
  info(`polling for ${label} confirmation (${txid.slice(0, 16)}…)`);
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
      if (r.ok) {
        const s = await r.json();
        if (s.confirmed) {
          ok(`${label} confirmed at height ${s.block_height} (after ${i} polls)`);
          return s.block_height;
        }
      }
    } catch {}
    if (i < attempts) {
      info(`  attempt ${i}/${attempts}: still in mempool…`);
      await sleep(delayMs);
    }
  }
  warn(`${label} did not confirm within ${attempts * delayMs / 1000}s; continuing anyway`);
  return null;
}
function cetchAssetId(revealTxid) {
  const txid_BE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) txid_BE[i] = parseInt(revealTxid.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, 0, true);
  return bytesToHex(sha256(concatBytes(txid_BE, voutLE)));
}

const state = loadState();

// Tunables — chosen so the 1M supply per asset gives ample headroom for
// pool seeding + a non-degenerate trade.
const SUPPLY        = 1_000_000n;
const POOL_DELTA    = 100_000n;   // each side of each pool
const TRADE_AMOUNT  = 5_000n;     // trader's input to the route (A side)

console.log(`\n=== T_SWAP_ROUTE on-chain end-to-end signet harness ===\n`);
console.log(`  founder: ${FOUNDER.addr}`);
console.log(`  state:   ${STATE_FILE}\n`);
useFounder();

// =========================================================================
// Phase 1: CETCH × 3 (assets A, BRIDGE, C)
// =========================================================================
step(1, 'CETCH × 3 (assets A, BRIDGE, C)');
state.cetches = state.cetches || {};

async function cetch(label, ticker) {
  if (state.cetches[label]) {
    ok(`reusing CETCH ${label}: ${state.cetches[label].reveal_txid.slice(0, 16)}…  asset_id=${state.cetches[label].asset_id.slice(0, 12)}…`);
    return state.cetches[label];
  }
  info(`CETCH ${label} (ticker=${ticker}, supply=${SUPPLY}, decimals=0)…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker, supplyBase: SUPPLY, decimals: 0, mintable: false,
  });
  const aid = cetchAssetId(r.revealTxid);
  state.cetches[label] = {
    reveal_txid: r.revealTxid,
    asset_id: aid,
    ticker,
  };
  saveState(state);
  ok(`CETCH ${label} reveal ${r.revealTxid.slice(0, 16)}…  asset_id=${aid.slice(0, 16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  return state.cetches[label];
}
const C_A      = await cetch('A',      'ROUTE-A');
const C_BRIDGE = await cetch('BRIDGE', 'ROUTE-BR');
const C_C      = await cetch('C',      'ROUTE-C');
const A_AID      = C_A.asset_id;
const BRIDGE_AID = C_BRIDGE.asset_id;
const C_AID      = C_C.asset_id;

// Before Phase 2, wait for the LAST CETCH reveal to confirm. Three CETCHes
// back-to-back build a deep mempool ancestor chain on the founder's sats
// UTXOs; the next phase's carveExactAmount spends a sats UTXO whose
// parent may still be mempool-only. mempool.space's /utxo endpoint can
// lag the actual mempool state for chained txs, so a fresh broadcast
// referencing one of those UTXOs sometimes hits "bad-txns-inputs-
// missingorspent". Polling for confirmation guarantees the chain is
// fully resolved before the carve. ~10 min worst-case on signet.
if (!state.cetchesConfirmed) {
  await waitForTxConfirmed(C_C.reveal_txid, 'CETCH C reveal');
  state.cetchesConfirmed = true;
  saveState(state);
}
dapp.invalidateHoldingsCache();
// mempool.space's /utxo endpoint lags chain state by ~30–60s after a
// confirmation, even with the tx itself reporting confirmed. Waiting
// longer here forces the next carve's getUtxos to fetch fresh data from
// a post-reindex view, avoiding "bad-txns-inputs-missingorspent" on
// inputs that mempool.space transiently reports as available.
await sleep(60_000);

// =========================================================================
// Phase 2: POOL_INIT × 2 — (A, BRIDGE)@30bps + (BRIDGE, C)@30bps
// =========================================================================
step(2, 'POOL_INIT × 2 (A↔BRIDGE, BRIDGE↔C)');
state.pools = state.pools || {};

async function poolInit(label, assetAHex, assetBHex, deltaA, deltaB, feeBps) {
  if (state.pools[label]) {
    ok(`reusing pool ${label}: ${state.pools[label].pool_id_hex.slice(0, 16)}…`);
    return state.pools[label];
  }
  info(`POOL_INIT ${label} (${deltaA}/${deltaB} @ ${feeBps}bps)…`);
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: assetAHex, assetBIdHex: assetBHex,
    deltaA, deltaB, feeBps,
    vkCid: 'bafy-route-harness-vk', ceremonyCid: 'bafy-route-harness-ceremony',
    poolCapabilityFlags: 0,
    onProgress: (s) => info(`  · ${s}`),
  });
  state.pools[label] = {
    pool_id_hex: r.poolIdHex,
    canonical_asset_a: r.canonicalAssetA,
    canonical_asset_b: r.canonicalAssetB,
    delta_a: r.deltaA.toString(),
    delta_b: r.deltaB.toString(),
    fee_bps: r.feeBps,
    reveal_txid: r.revealTxid,
  };
  saveState(state);
  ok(`POOL_INIT ${label} reveal ${r.revealTxid.slice(0, 16)}…  pool ${r.poolIdHex.slice(0, 16)}…`);
  return state.pools[label];
}

// Wait for any in-flight pool reveal to confirm + give mempool.space's
// /utxo endpoint ~60s post-reindex window. Runs every harness invocation
// (including resumes after a partial state file), so a fresh broadcast
// issued seconds after process startup doesn't hit "bad-txns-inputs-
// missingorspent" on sats UTXOs the chain just spent. Without this on
// the resume path, the prior session's broadcasts may still be at the
// "indexed-but-/utxo-lagging" boundary.
async function settleBeforeNextBroadcast(label, revealTxid) {
  await waitForTxConfirmed(revealTxid, label);
  dapp.invalidateHoldingsCache();
  await sleep(60_000);
}

await poolInit('AB', A_AID, BRIDGE_AID, POOL_DELTA, POOL_DELTA, 30);
await settleBeforeNextBroadcast('POOL_INIT AB reveal', state.pools.AB.reveal_txid);
await poolInit('BC', BRIDGE_AID, C_AID, POOL_DELTA, POOL_DELTA, 30);
await settleBeforeNextBroadcast('POOL_INIT BC reveal', state.pools.BC.reveal_txid);

// Wait for the worker to index both pools.
const poolAB = await waitForPool(state.pools.AB.pool_id_hex, 'AB');
const poolBC = await waitForPool(state.pools.BC.pool_id_hex, 'BC');
if (!poolAB) fail('pool AB never registered on worker');
if (!poolBC) fail('pool BC never registered on worker');

// =========================================================================
// Phase 3: Atomic T_SWAP_ROUTE (A → BRIDGE → C in one tx)
// =========================================================================
step(3, 'atomic T_SWAP_ROUTE (A → BRIDGE → C)');

if (state.swapRoute?.completed) {
  ok(`reusing atomic route: ${state.swapRoute.reveal_txid.slice(0, 16)}…  ${state.swapRoute.delta_in} A → ${state.swapRoute.delta_out_last} C`);
} else {
  // Carve the trader's input UTXO from the founder's A holdings.
  dapp.invalidateHoldingsCache();
  await sleep(3_000);
  const holdings = await dapp.scanHoldings();
  const ah = holdings.get(A_AID.toLowerCase());
  if (!ah || ah.balance < TRADE_AMOUNT) {
    fail(`founder A balance ${ah?.balance ?? 0} < ${TRADE_AMOUNT}`);
  }
  const carved = await dapp.carveExactAmount({ assetIdHex: A_AID.toLowerCase(), amount: TRADE_AMOUNT });
  if (!carved?.utxo) fail('carveExactAmount(A) failed');

  // Fetch fresh pool registry for the router.
  const pools = await fetchAllPools();
  if (!pools.length) fail('worker returned empty pool list');

  // previewSwapRoute dispatch check — the route MUST be multi-hop (no
  // direct A↔C pool exists in this harness).
  const preview = dapp.previewSwapRoute({
    fromAid: A_AID, toAid: C_AID, amountIn: TRADE_AMOUNT, pools,
  });
  if (!preview) fail('previewSwapRoute returned null — no route found');
  if (preview.kind !== 'multihop') {
    fail(`expected multihop, got ${preview.kind} (somebody added an A↔C pool that the router preferred)`);
  }
  ok(`router preview: multihop, ${preview.route.hops.length} hops, deltaOutLast=${preview.route.deltaOutLast}`);

  // Floor at 90% of the preview to leave room for reserve drift between
  // preview and confirmation.
  const minOut = (preview.route.deltaOutLast * 9000n) / 10000n;
  info(`broadcasting T_SWAP_ROUTE: ${TRADE_AMOUNT} A → ≥ ${minOut} C, 2 hops, expiry=∞`);

  const r = await dapp.buildAndBroadcastSwapRoute({
    pools,
    assetInputUtxo: {
      txid: carved.utxo.txid, vout: carved.utxo.vout,
      asset_id_hex: A_AID.toLowerCase(),
      amount: carved.amount, blinding: carved.blinding,
    },
    traderOutputAssetIdHex: C_AID.toLowerCase(),
    minOut, expiryHeight: 0xffffffff,
    onProgress: (stage) => info(`  · ${stage}`),
  });
  state.swapRoute = {
    completed: true,
    reveal_txid: r.revealTxid,
    commit_txid: r.commitTxid,
    delta_in: TRADE_AMOUNT.toString(),
    delta_out_last: r.deltaOutLast.toString(),
    hop_count: r.hops.length,
    receipt_vout: r.receiptVout,
  };
  saveState(state);
  ok(`T_SWAP_ROUTE reveal ${r.revealTxid.slice(0, 16)}…  delta_out_last=${r.deltaOutLast}`);
}

// Wait for the route to confirm on chain before Phase 4 fetches pool state.
// Without this, the worker may report pre-route reserves and Phase 4 logs
// the harmless-looking "pools unchanged — re-run later" warning instead of
// confirming atomicity.
await waitForTxConfirmed(state.swapRoute.reveal_txid, 'T_SWAP_ROUTE reveal');

// Give the worker time to ingest the confirmed route + walk it through the
// validator before re-fetching pool state.
info(`giving the worker ~30s to walk the confirmed route through the validator`);
await sleep(30_000);

// =========================================================================
// Phase 4: post-confirm worker checks
// =========================================================================
step(4, 'post-confirm worker reads (pools advanced atomically + receipt indexed)');

info(`re-fetching pools to confirm reserves advanced via the route`);
let poolABPost = await fetchPool(state.pools.AB.pool_id_hex);
let poolBCPost = await fetchPool(state.pools.BC.pool_id_hex);
// One more graceful retry if the worker is slow to walk the validator on
// the confirmed route — covers the case where the cron-driven scan window
// straddles the route's confirmation height.
if (poolABPost && poolBCPost) {
  const abAdvanced = poolABPost.reserve_a !== poolAB.reserve_a || poolABPost.reserve_b !== poolAB.reserve_b;
  const bcAdvanced = poolBCPost.reserve_a !== poolBC.reserve_a || poolBCPost.reserve_b !== poolBC.reserve_b;
  if (!abAdvanced && !bcAdvanced) {
    info(`pools still at pre-route reserves; waiting another 60s for worker indexer…`);
    await sleep(60_000);
    poolABPost = await fetchPool(state.pools.AB.pool_id_hex);
    poolBCPost = await fetchPool(state.pools.BC.pool_id_hex);
  }
}
if (!poolABPost || !poolBCPost) {
  warn(`pool fetch after route returned null — worker may still be re-indexing. Re-run later to verify.`);
} else {
  // Either both pools advanced (worker accepted the route) or both stayed
  // (worker rejected). Anything else is a bug — atomicity at the validator
  // layer means the entire envelope is rejected on any per-hop failure.
  const abAdvanced = poolABPost.reserve_a !== poolAB.reserve_a || poolABPost.reserve_b !== poolAB.reserve_b;
  const bcAdvanced = poolBCPost.reserve_a !== poolBC.reserve_a || poolBCPost.reserve_b !== poolBC.reserve_b;
  if (abAdvanced && bcAdvanced) {
    ok(`atomicity confirmed: BOTH pools' reserves advanced after the route`);
    info(`  poolAB: ${poolAB.reserve_a}/${poolAB.reserve_b} → ${poolABPost.reserve_a}/${poolABPost.reserve_b}`);
    info(`  poolBC: ${poolBC.reserve_a}/${poolBC.reserve_b} → ${poolBCPost.reserve_a}/${poolBCPost.reserve_b}`);
  } else if (!abAdvanced && !bcAdvanced) {
    warn(`pools unchanged — the route may not have confirmed yet, OR the worker rejected it. Re-run after another block.`);
  } else {
    fail(`atomicity broken: pool AB advanced=${abAdvanced} but pool BC advanced=${bcAdvanced} — both must move together`);
  }
}

// Sanity-check: trader now holds C, no longer holds the A that was spent.
info(`re-scanning holdings for the C receipt + A spend`);
dapp.invalidateHoldingsCache();
// mempool.space's /utxo endpoint lags chain state by ~30–60s after a
// confirmation, even with the tx itself reporting confirmed. Waiting
// longer here forces the next carve's getUtxos to fetch fresh data from
// a post-reindex view, avoiding "bad-txns-inputs-missingorspent" on
// inputs that mempool.space transiently reports as available.
await sleep(60_000);
const holdingsPost = await dapp.scanHoldings(true);
const cHold = holdingsPost.get(C_AID.toLowerCase());
if (cHold && cHold.balance >= BigInt(state.swapRoute.delta_out_last)) {
  ok(`founder now holds ${cHold.balance} C (≥ ${state.swapRoute.delta_out_last} from the route)`);
} else {
  warn(`founder C balance ${cHold?.balance ?? 0} < ${state.swapRoute.delta_out_last} — receipt may not be indexed yet`);
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== T_SWAP_ROUTE on-chain end-to-end signet harness COMPLETE ===\n`);
console.log(`Assets:`);
console.log(`  A=${A_AID.slice(0, 16)}…   BRIDGE=${BRIDGE_AID.slice(0, 16)}…   C=${C_AID.slice(0, 16)}…`);
console.log(`\nPools:`);
console.log(`  AB  fee=30bps  pool_id=${state.pools.AB.pool_id_hex.slice(0, 16)}…`);
console.log(`  BC  fee=30bps  pool_id=${state.pools.BC.pool_id_hex.slice(0, 16)}…`);
console.log(`\nAtomic route (single Bitcoin tx):`);
console.log(`  ${state.swapRoute.delta_in} A → ${state.swapRoute.delta_out_last} C via ${state.swapRoute.hop_count} pools`);
console.log(`  commit_txid: ${state.swapRoute.commit_txid}`);
console.log(`  reveal_txid: ${state.swapRoute.reveal_txid}`);
console.log(`\nMempool:    https://mempool.space/signet/tx/${state.swapRoute.reveal_txid}`);
console.log(`State file: ${STATE_FILE}\n`);
