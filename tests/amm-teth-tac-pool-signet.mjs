// TETH/TAC pilot pool bring-up on signet (fast-settlement pilot Phase 0).
//
// Pairs the real bridge-minted signet tETH (d903de2d…, decimals 8) with the
// mainnet-shape dec8-tac test asset (879cf8e6…, decimals 8, founder-held)
// in a fresh AMM pool, then proves a swap settles under the SPEC §5.20
// outcome taxonomy (worker resolves EXECUTE with a derived receipt).
//
//   Phase 1: bridge wallet CXFERs tETH to the founder
//   Phase 2: founder POOL_INITs tETH × TAC8
//   Phase 3: founder swaps TAC8 → tETH; outcome must be EXECUTE; /head sane
//
// Run AFTER amm-swap-race-signet.mjs completes (shares the founder wallet).
// Resumable via .local/amm-teth-tac-pool-state.json.
//
// Run:  node tests/amm-teth-tac-pool-signet.mjs

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
const STATE_FILE = path.join(STATE_DIR, 'amm-teth-tac-pool-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');

// Post-ceremony POOL_INIT runs the real Groth16 prover; under Node the
// browser-relative wasm path and the IPFS zkey fetch need local overrides
// (same shim as amm-swap-race-signet.mjs).
{
  const _origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input?.url;
    if (typeof u === 'string') {
      const wasmMatch = u.match(/(?:^|\/)vendor\/(amm_[a-z_]+)\.wasm$/) || u.match(/^\.\/vendor\/(amm_[a-z_]+)\.wasm$/);
      if (wasmMatch) {
        const p = path.join(__dirname, '..', 'dapp', 'circuits', 'amm', 'build', `${wasmMatch[1]}_js`, `${wasmMatch[1]}.wasm`);
        return new Response(readFileSync(p));
      }
      const zkeyMatch = u.match(/\/(amm_[a-z_]+_final\.zkey)$/);
      if (zkeyMatch) {
        const p = path.join(__dirname, '..', 'dapp', 'circuits', 'amm', 'dev-zkey', zkeyMatch[1]);
        if (existsSync(p)) return new Response(readFileSync(p));
      }
    }
    return _origFetch(input, init);
  };
}

if (!existsSync(WALLETS_FILE)) {
  console.error(`✗ Wallets not found at ${WALLETS_FILE}`);
  process.exit(1);
}
const WALLETS = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const FOUNDER = {
  priv: hexToBytes(WALLETS.founder.priv_hex),
  pub: secp.getPublicKey(hexToBytes(WALLETS.founder.priv_hex), true),
  addr: WALLETS.founder.address,
};
// Signet bridge round-trip wallet — holds the bridge-minted tETH (see
// tests/bridge-sepolia-signet-e2e.mjs).
const BRIDGE = (() => {
  const priv = hexToBytes('827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222');
  return { priv, pub: secp.getPublicKey(priv, true), addr: 'tb1qc0tjnm339uu89as6lhauegpc340m747n3jnsu5' };
})();
for (const w of [FOUNDER, BRIDGE]) {
  try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(w.pub), '1'); } catch {}
}

const TETH = 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const TAC8 = '879cf8e6f26b733497ca1d154ed22c80b2266a5702ed55476a8cd4a3c5e9c4ea';
const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';

// Pool sizing: tETH side adapts to what the bridge wallet still holds
// (each bridge mint is 100,000 base units = 0.001 ETH at decimals 8).
const TETH_POOL_TARGET = 100_000n;
const TETH_POOL_MIN    = 10_000n;
// TAC side: 1 tETH-unit : 20 TAC-units toy ratio (signet pilot pricing).
const TAC_PER_TETH = 20n;

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
function useWallet(w) {
  dapp.wallet.priv = w.priv;
  dapp.wallet.pub = w.pub;
  dapp.invalidateHoldingsCache();
}

async function fetchJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

const state = loadState();
console.log(`\n=== TETH/TAC pilot pool bring-up (signet) ===\n`);
console.log(`  founder: ${FOUNDER.addr}`);
console.log(`  bridge:  ${BRIDGE.addr}`);
console.log(`  tETH:    ${TETH.slice(0, 16)}…  TAC8: ${TAC8.slice(0, 16)}…\n`);

// ---- Phase 1: move tETH from the bridge wallet to the founder ----
step(1, 'bridge wallet → founder tETH transfer');
if (state.transfer?.reveal_txid) {
  ok(`reusing transfer: ${state.transfer.reveal_txid.slice(0, 16)}… (${state.transfer.amount} units)`);
} else {
  useWallet(BRIDGE);
  await sleep(2000);
  const h = await dapp.scanHoldings();
  const teth = h.get(TETH);
  const held = teth?.balance ?? 0n;
  info(`bridge wallet tETH balance: ${held} base units (${Number(held) / 1e8} ETH-equivalent)`);
  if (held < TETH_POOL_MIN) fail(`bridge wallet holds ${held} < ${TETH_POOL_MIN} tETH units — top up via the bridge round-trip first`);
  const amount = held >= TETH_POOL_TARGET ? TETH_POOL_TARGET : held;
  info(`transferring ${amount} tETH units to the founder…`);
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex: TETH,
    recipients: [{ pubHex: bytesToHex(FOUNDER.pub), amount }],
  });
  state.transfer = { reveal_txid: r.revealTxid, amount: amount.toString() };
  saveState(state);
  ok(`tETH transfer reveal ${r.revealTxid.slice(0, 16)}…`);
  info(`waiting 60s for propagation…`);
  await sleep(60_000);
}

// ---- Phase 2: POOL_INIT tETH × TAC8 ----
step(2, 'POOL_INIT tETH × TAC8');
if (state.pool?.pool_id_hex) {
  ok(`reusing pool: ${state.pool.pool_id_hex.slice(0, 16)}…`);
} else {
  useWallet(FOUNDER);
  await sleep(3000);
  // Wait until the founder's tETH lot is spendable in holdings.
  let tethBal = 0n;
  for (let i = 1; i <= 20; i++) {
    dapp.invalidateHoldingsCache();
    const h = await dapp.scanHoldings();
    tethBal = h.get(TETH)?.balance ?? 0n;
    if (tethBal >= TETH_POOL_MIN) break;
    info(`  waiting for founder tETH to land (${i}/20): ${tethBal} units so far`);
    await sleep(30_000);
  }
  if (tethBal < TETH_POOL_MIN) fail(`founder tETH ${tethBal} < ${TETH_POOL_MIN} — re-run once the transfer confirms`);
  const tethDelta = tethBal >= TETH_POOL_TARGET ? TETH_POOL_TARGET : tethBal;
  const tacDelta = tethDelta * TAC_PER_TETH;
  info(`POOL_INIT ${tethDelta} tETH × ${tacDelta} TAC8 @ 30bps…`);
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: TETH, assetBIdHex: TAC8,
    deltaA: tethDelta, deltaB: tacDelta,
    feeBps: 30,
    vkCid: 'bafy-teth-tac-pilot-vk', ceremonyCid: 'bafy-teth-tac-pilot-ceremony',
    poolCapabilityFlags: 0,
    onProgress: (s) => info(`  · ${s}`),
  });
  state.pool = {
    pool_id_hex: r.poolIdHex,
    canonical_asset_a: r.canonicalAssetA,
    canonical_asset_b: r.canonicalAssetB,
    reveal_txid: r.revealTxid,
    teth_delta: tethDelta.toString(),
    tac_delta: tacDelta.toString(),
  };
  saveState(state);
  ok(`POOL_INIT reveal ${r.revealTxid.slice(0, 16)}…  pool ${r.poolIdHex.slice(0, 16)}…`);
}

// Wait for worker registration.
{
  info(`waiting for worker pool registration…`);
  let rec = null;
  for (let i = 1; i <= 30; i++) {
    rec = await fetchJson(`${WORKER_BASE}/amm/pool/${state.pool.pool_id_hex}?network=signet`);
    if (rec?.pool_id === state.pool.pool_id_hex) break;
    info(`  attempt ${i}/30: not yet indexed`);
    await sleep(30_000);
  }
  if (!rec) fail(`pool not on worker — re-run later`);
  ok(`pool live: R_A=${rec.reserve_a} R_B=${rec.reserve_b} validation=${rec.validation}`);
}

// ---- Phase 3: pilot swap TAC8 → tETH under outcome rules ----
step(3, 'pilot swap TAC8 → tETH (must EXECUTE with derived receipt)');
if (state.swap?.verified) {
  ok(`pilot swap already verified`);
} else {
  if (!state.swap) {
    useWallet(FOUNDER);
    dapp.invalidateHoldingsCache();
    await sleep(2000);
    const rec = await fetchJson(`${WORKER_BASE}/amm/pool/${state.pool.pool_id_hex}?network=signet`);
    const rA = BigInt(rec.reserve_a), rB = BigInt(rec.reserve_b);
    // Swap 1% of the TAC side for tETH.
    const direction = TAC8.toLowerCase() === state.pool.canonical_asset_a.toLowerCase() ? 0 : 1;
    const swapIn = (direction === 0 ? rA : rB) / 100n;
    if (swapIn <= 0n) fail('pool too thin for the pilot swap');
    const carved = await dapp.carveExactAmount({ assetIdHex: TAC8, amount: swapIn });
    if (!carved?.utxo) fail('failed to carve TAC8 input');
    const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
      poolReserves: { pool_id_hex: state.pool.pool_id_hex, reserve_a: rA, reserve_b: rB, fee_bps: 30 },
      assetInputUtxo: {
        txid: carved.utxo.txid, vout: carved.utxo.vout,
        amount: carved.amount, blinding: carved.blinding,
        asset_id_hex: TAC8,
      },
      direction, deltaIn: swapIn, minOut: 1n,
      expiryHeight: 4_294_967_290,
      receiveAssetIdHex: TETH,
    });
    state.swap = { reveal_txid: r.revealTxid, delta_in: swapIn.toString(), quoted: r.deltaOut.toString() };
    saveState(state);
    ok(`pilot swap broadcast ${r.revealTxid.slice(0, 16)}…  quoted ${r.deltaOut} tETH units`);
  }
  info(`waiting for the swap outcome…`);
  let outcome = null;
  for (let i = 1; i <= 40 && !outcome; i++) {
    const o = await fetchJson(`${WORKER_BASE}/amm/swap-accepted?network=signet&txid=${state.swap.reveal_txid}`);
    if (o?.accepted) { outcome = o; break; }
    info(`  outcome poll ${i}/40: pending`);
    await sleep(45_000);
  }
  if (!outcome) fail(`pilot swap outcome missing — re-run to resume polling`);
  info(`outcome: ${outcome.outcome} actual=${outcome.delta_out_actual} quoted=${outcome.quoted_delta_out}`);
  if (outcome.outcome !== 'execute') fail(`expected execute, got ${outcome.outcome} (${outcome.pass_reason})`);
  if (String(outcome.receipt?.asset_id).toLowerCase() !== TETH.toLowerCase()) {
    fail(`receipt asset ${outcome.receipt?.asset_id} != tETH`);
  }
  const head = await fetchJson(`${WORKER_BASE}/amm/pool/${state.pool.pool_id_hex}/head?network=signet`);
  ok(`swap executed: ${outcome.delta_out_actual} tETH units credited (derived commitment)`);
  ok(`/head live: confirmed (${head?.confirmed?.reserve_a}, ${head?.confirmed?.reserve_b}) · pending ${head?.pending_count}`);
  state.swap.verified = true;
  saveState(state);
}

console.log(`\n=== TETH/TAC pilot pool live ===\n`);
console.log(`Pool:  ${state.pool.pool_id_hex}`);
console.log(`Init:  https://mempool.space/signet/tx/${state.pool.reveal_txid}`);
if (state.swap) console.log(`Swap:  https://mempool.space/signet/tx/${state.swap.reveal_txid}`);
console.log(`Head:  ${WORKER_BASE}/amm/pool/${state.pool.pool_id_hex}/head?network=signet`);
