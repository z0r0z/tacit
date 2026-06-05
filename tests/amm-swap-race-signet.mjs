// T_SWAP_VAR outcome-taxonomy race rehearsal (SPEC §5.20, 2026-06-05 revision).
//
// Proves on signet that concurrent same-pool swaps in one inter-block window
// all settle — never burn — under the amended validator:
//
//   Phase R (test-plan item 9b): two swaps quote the same pre-state with
//     loose floors, broadcast back-to-back. Both must EXECUTE — the earlier
//     canonical position at its quote, the later at post-earlier-fill
//     reserves (delta_out_actual < quote), pool replay = both applied.
//   Phase T (item 9c): two swaps quote the same pre-state; the second pins
//     min_out at its full quote. The second must resolve PASS-THROUGH —
//     pool untouched by it, refund_amount = delta_in, receipt in the INPUT
//     asset — and the refund UTXO must credit back in scanHoldings (the
//     trader's input-asset balance is conserved minus nothing).
//
// Requires the worker to run the outcome-taxonomy validator (deploy worker
// before running; activation height SWAP_VAR_OUTCOME_ACTIVATION.signet).
//
// Reuses the founder wallet from the AMM e2e harness. Resumable via
// .local/amm-swap-race-signet-state.json.
//
// Run:  node tests/amm-swap-race-signet.mjs

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

// Post-ceremony POOL_INIT runs the real Groth16 prover. Under Node the
// dapp's browser-relative wasm path and the IPFS zkey fetch both need a
// local override (the worker's POOL_INIT registration verifies the xcurve
// sigma; the Groth16 leg is trust-the-envelope until per-pool VK
// verification lands, so the dev zkey is sufficient to build).
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
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'amm-swap-race-signet-state.json');
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

function useWallet(w) {
  dapp.wallet.priv = w.priv;
  dapp.wallet.pub = w.pub;
  dapp.invalidateHoldingsCache();
}

function cetchAssetId(revealTxid) {
  const txid_BE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) txid_BE[i] = parseInt(revealTxid.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, 0, true);
  return bytesToHex(sha256(concatBytes(txid_BE, voutLE)));
}

const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';
async function fetchPool(poolIdHex) {
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pool/${poolIdHex}?network=signet`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function fetchSwapOutcome(txidHex) {
  try {
    const r = await fetch(`${WORKER_BASE}/amm/swap-accepted?network=signet&txid=${txidHex}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// curve quote (mirrors ammCurveDeltaOut, 30bps)
function quote(rIn, rOut, dIn) {
  const g = 9970n;
  return (rOut * dIn * g) / (rIn * 10000n + dIn * g);
}

const state = loadState();

// Pool sized so a RACE_IN swap moves the price measurably: at 1M × 1M and
// 30 bps, a 5k fill quotes 4960 and shifts the next identical quote to ~4911
// (-1%), comfortably detectable and comfortably below a quote-pinned floor.
const SUPPLY    = 100_000_000n;
const POOL_SIZE = 1_000_000n;
const RACE_IN   = 5_000n;

console.log(`\n=== T_SWAP_VAR outcome-taxonomy race rehearsal (signet) ===\n`);
console.log(`  founder: ${FOUNDER.addr}`);
console.log(`  pool:    ${POOL_SIZE} × ${POOL_SIZE} @ 30bps · race fills: ${RACE_IN} each`);
console.log(`  state:   ${STATE_FILE}\n`);

// ---- Phase 0: pre-flight ----
step(0, 'pre-flight');
useWallet(FOUNDER);
{
  const utxos = await dapp.getUtxos(FOUNDER.addr);
  const sats = utxos.reduce((s, u) => s + u.value, 0);
  info(`founder sats: ${sats.toLocaleString()}`);
  if (sats < 40_000) fail(`underfunded — need ≥ 40k sats for 2 CETCH + POOL_INIT + 4 swaps`);
  ok(`pre-flight passed`);
}

// ---- Phase 1: CETCH the pair ----
step(1, 'CETCH race-a + race-b');
state.assets = state.assets || {};
for (const [key, ticker] of [['RA', 'race-a'], ['RB', 'race-b']]) {
  if (state.assets[key]?.asset_id_hex) {
    ok(`reusing ${key}: ${state.assets[key].asset_id_hex.slice(0, 16)}…`);
    continue;
  }
  useWallet(FOUNDER);
  info(`CETCHing ${ticker}…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker, supplyBase: SUPPLY, decimals: 0, mintable: false,
  });
  const aid = cetchAssetId(r.revealTxid);
  state.assets[key] = { ticker, cetch_txid: r.revealTxid, asset_id_hex: aid };
  saveState(state);
  ok(`${ticker} CETCHed: ${aid.slice(0, 16)}…`);
  info(`waiting 45s before next broadcast…`);
  await sleep(45_000);
}
const RA = state.assets.RA.asset_id_hex;
const RB = state.assets.RB.asset_id_hex;

// ---- Phase 2: POOL_INIT ----
step(2, `POOL_INIT race-a↔race-b (${POOL_SIZE} × ${POOL_SIZE} @ 30bps)`);
if (state.pool) {
  ok(`reusing pool: ${state.pool.pool_id_hex.slice(0, 16)}…`);
} else {
  useWallet(FOUNDER);
  dapp.invalidateHoldingsCache();
  await sleep(5_000);
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: RA, assetBIdHex: RB,
    deltaA: POOL_SIZE, deltaB: POOL_SIZE,
    feeBps: 30,
    vkCid: 'bafy-race-vk', ceremonyCid: 'bafy-race-ceremony',
    poolCapabilityFlags: 0,
    onProgress: (s) => info(`  · ${s}`),
  });
  state.pool = {
    pool_id_hex: r.poolIdHex,
    canonical_asset_a: r.canonicalAssetA,
    canonical_asset_b: r.canonicalAssetB,
    reveal_txid: r.revealTxid,
  };
  saveState(state);
  ok(`POOL_INIT reveal ${r.revealTxid.slice(0, 16)}…`);
}

// Wait for the pool to be registered + verified on the worker.
{
  info(`waiting for worker pool registration…`);
  let rec = null;
  for (let i = 1; i <= 30; i++) {
    rec = await fetchPool(state.pool.pool_id_hex);
    if (rec?.pool_id === state.pool.pool_id_hex) break;
    info(`  attempt ${i}/30: not yet indexed`);
    await sleep(30_000);
  }
  if (!rec) fail(`pool not on worker — re-run later (state is resumable)`);
  ok(`pool live: R_A=${rec.reserve_a} R_B=${rec.reserve_b} validation=${rec.validation}`);
}

// Helper: carve BOTH race lots in one CXFER so the two swap builds never
// compete for the same input (two sequential carveExactAmount calls race
// each other's pending spends and produce an RBF conflict).
async function carveRacePair() {
  useWallet(FOUNDER);
  dapp.invalidateHoldingsCache();
  const pubHex = bytesToHex(FOUNDER.pub);
  const r = await dapp.buildAndBroadcastCXferMulti({
    assetIdHex: RA,
    recipients: [
      { pubHex, amount: RACE_IN },
      { pubHex, amount: RACE_IN },
    ],
    allowDuplicateRecipients: true,
  });
  ok(`carved race pair in one CXFER: ${r.revealTxid.slice(0, 16)}…`);
  return r.recipients.map((rec) => ({
    txid: r.revealTxid, vout: rec.vout, amount: rec.amount, blinding: rec.blinding,
  }));
}

// Helper: wait until the pool's pending line is empty AND the founder
// wallet has no unconfirmed txs (covers in-flight swaps that predate the
// hint wiring), so each race phase starts from a clean canonical
// pre-state.
async function drainPendingLine() {
  for (let i = 1; i <= 40; i++) {
    let pendingCount = 0, mempoolCount = 0;
    try {
      const r = await fetch(`${WORKER_BASE}/amm/pool/${state.pool.pool_id_hex}/head?network=signet`);
      if (r.ok) pendingCount = (await r.json()).pending_count || 0;
    } catch {}
    try {
      const m = await fetch(`https://mempool.space/signet/api/address/${FOUNDER.addr}/txs/mempool`);
      if (m.ok) mempoolCount = ((await m.json()) || []).length;
    } catch {}
    if (pendingCount === 0 && mempoolCount === 0) return;
    info(`  drain ${i}/40: ${pendingCount} in-flight swap(s), ${mempoolCount} unconfirmed founder tx(s)`);
    await sleep(30_000);
  }
  warn(`pending line did not drain — proceeding anyway`);
}

// Helper: broadcast one self-fulfilled race swap from a prepared lot.
async function raceSwap({ lot, rA, rB, minOut, label }) {
  const direction = RA.toLowerCase() === state.pool.canonical_asset_a.toLowerCase() ? 0 : 1;
  const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
    poolReserves: {
      pool_id_hex: state.pool.pool_id_hex,
      reserve_a: rA, reserve_b: rB, fee_bps: 30,
    },
    assetInputUtxo: {
      txid: lot.txid, vout: lot.vout,
      amount: lot.amount, blinding: lot.blinding,
      asset_id_hex: RA,
    },
    direction, deltaIn: RACE_IN, minOut,
    expiryHeight: 4_294_967_290,
    receiveAssetIdHex: RB,
  });
  ok(`${label} broadcast: reveal ${r.revealTxid.slice(0, 16)}…  quoted deltaOut=${r.deltaOut}`);
  return { reveal_txid: r.revealTxid, quoted: r.deltaOut.toString(), min_out: minOut.toString() };
}

// Poll outcomes for a set of txids until all have records (confirm + scan).
async function awaitOutcomes(txids, { tries = 40, gapMs = 45_000 } = {}) {
  const outcomes = {};
  for (let i = 1; i <= tries; i++) {
    let missing = 0;
    for (const t of txids) {
      if (outcomes[t]?.accepted) continue;
      const o = await fetchSwapOutcome(t);
      if (o?.accepted) outcomes[t] = o;
      else missing++;
    }
    if (missing === 0) return outcomes;
    info(`  outcome poll ${i}/${tries}: ${missing} pending`);
    await sleep(gapMs);
  }
  return outcomes;
}

// ---- Phase R: loose-floor race (item 9b) — both execute ----
step('R', 'race two swaps, loose floors — both must EXECUTE');
if (state.raceR?.verified) {
  ok(`phase R already verified`);
} else {
  if (!state.raceR) {
    await drainPendingLine();
    const lots = await carveRacePair();
    const rec = await fetchPool(state.pool.pool_id_hex);
    const rA = BigInt(rec.reserve_a), rB = BigInt(rec.reserve_b);
    const direction = RA.toLowerCase() === state.pool.canonical_asset_a.toLowerCase() ? 0 : 1;
    const q = direction === 0 ? quote(rA, rB, RACE_IN) : quote(rB, rA, RACE_IN);
    info(`pre-state (${rA}, ${rB}) — identical quote for both: ${q}`);
    const swapA = await raceSwap({ lot: lots[0], rA: rA, rB: rB, minOut: 1n, label: 'swap A (loose)' });
    const swapB = await raceSwap({ lot: lots[1], rA: rA, rB: rB, minOut: 1n, label: 'swap B (loose)' });
    state.raceR = { pre_a: rA.toString(), pre_b: rB.toString(), swapA, swapB };
    saveState(state);
  }
  info(`waiting for confirmations + worker outcomes…`);
  const o = await awaitOutcomes([state.raceR.swapA.reveal_txid, state.raceR.swapB.reveal_txid]);
  const oA = o[state.raceR.swapA.reveal_txid];
  const oB = o[state.raceR.swapB.reveal_txid];
  if (!oA?.accepted || !oB?.accepted) fail(`phase R outcomes missing — re-run to resume polling`);
  info(`A: ${oA.outcome} actual=${oA.delta_out_actual} quoted=${oA.quoted_delta_out}`);
  info(`B: ${oB.outcome} actual=${oB.delta_out_actual} quoted=${oB.quoted_delta_out}`);
  if (oA.outcome !== 'execute' || oB.outcome !== 'execute') {
    fail(`phase R: expected execute/execute, got ${oA.outcome}/${oB.outcome}`);
  }
  const fills = [BigInt(oA.delta_out_actual), BigInt(oB.delta_out_actual)].sort((x, y) => (x < y ? 1 : -1));
  const preA = BigInt(state.raceR.pre_a), preB = BigInt(state.raceR.pre_b);
  const direction = RA.toLowerCase() === state.pool.canonical_asset_a.toLowerCase() ? 0 : 1;
  const q1 = direction === 0 ? quote(preA, preB, RACE_IN) : quote(preB, preA, RACE_IN);
  const post1A = direction === 0 ? preA + RACE_IN : preA - q1;
  const post1B = direction === 0 ? preB - q1 : preB + RACE_IN;
  const q2 = direction === 0 ? quote(post1A, post1B, RACE_IN) : quote(post1B, post1A, RACE_IN);
  if (fills[0] !== q1 || fills[1] !== q2) {
    fail(`phase R fills (${fills[0]}, ${fills[1]}) != expected walk (${q1}, ${q2})`);
  }
  ok(`both executed — first at quote ${q1}, second at moved reserves ${q2} (no burn, no rejection)`);
  state.raceR.verified = true;
  saveState(state);
}

// ---- Phase T: deterministic floor miss (item 9c / 8) — PASS-THROUGH ----
//
// The mixed-floor same-block ordering bet was already exercised live: a
// 2026-06-05 run had the pinned-floor swap win first canonical position
// and fill AT its exact quote while the loose swap executed behind it at
// the moved price — both settled, nothing burned. To pin the refund path
// itself, this phase makes the floor miss deterministic: confirm a loose
// fill first, THEN broadcast a swap quoting the stale pre-fill state with
// its floor pinned at the stale quote. It must resolve PASS-THROUGH and
// the refund must credit back in holdings.
step('T', 'deterministic stale-floor swap — must PASS-THROUGH and refund');
if (state.raceT?.verified) {
  ok(`phase T already verified`);
} else {
  if (!state.raceT) {
    await drainPendingLine();
    const lots = await carveRacePair();
    const rec = await fetchPool(state.pool.pool_id_hex);
    const rA = BigInt(rec.reserve_a), rB = BigInt(rec.reserve_b);
    const direction = RA.toLowerCase() === state.pool.canonical_asset_a.toLowerCase() ? 0 : 1;
    const q = direction === 0 ? quote(rA, rB, RACE_IN) : quote(rB, rA, RACE_IN);
    info(`pre-state (${rA}, ${rB}) — stale quote will be ${q}`);
    const h0 = await dapp.scanHoldings();
    const ra0 = h0.get(RA)?.balance ?? 0n;
    const swapC = await raceSwap({ lot: lots[0], rA: rA, rB: rB, minOut: 1n, label: 'swap C (loose)' });
    state.raceT = {
      pre_a: rA.toString(), pre_b: rB.toString(), stale_quote: q.toString(),
      ra_before: ra0.toString(), swapC,
      lotD: { txid: lots[1].txid, vout: lots[1].vout, amount: lots[1].amount.toString(), blinding: lots[1].blinding.toString() },
    };
    saveState(state);
  }
  if (!state.raceT.swapD) {
    info(`waiting for swap C to confirm + resolve (moves the pool)…`);
    const oC0 = await awaitOutcomes([state.raceT.swapC.reveal_txid]);
    if (!oC0[state.raceT.swapC.reveal_txid]?.accepted) fail(`swap C outcome missing — re-run to resume`);
    info(`C resolved: ${oC0[state.raceT.swapC.reveal_txid].outcome} — pool has moved; broadcasting the stale-floor swap`);
    const lotD = {
      txid: state.raceT.lotD.txid, vout: state.raceT.lotD.vout,
      amount: BigInt(state.raceT.lotD.amount), blinding: BigInt(state.raceT.lotD.blinding),
    };
    const swapD = await raceSwap({
      lot: lotD,
      rA: BigInt(state.raceT.pre_a), rB: BigInt(state.raceT.pre_b),
      minOut: BigInt(state.raceT.stale_quote),
      label: 'swap D (stale floor)',
    });
    state.raceT.swapD = swapD;
    saveState(state);
  }
  info(`waiting for swap D's outcome…`);
  const o = await awaitOutcomes([state.raceT.swapD.reveal_txid]);
  const oD = o[state.raceT.swapD.reveal_txid];
  if (!oD?.accepted) fail(`phase T outcome missing — re-run to resume polling`);
  info(`D: ${oD.outcome} reason=${oD.pass_reason} refund=${oD.refund_amount}`);
  if (oD.outcome !== 'passthrough') {
    fail(`phase T: expected passthrough, got ${oD.outcome} (actual=${oD.delta_out_actual})`);
  }
  if (BigInt(oD.refund_amount) !== RACE_IN) fail(`refund ${oD.refund_amount} != delta_in ${RACE_IN}`);
  if (String(oD.receipt?.asset_id).toLowerCase() !== RA.toLowerCase()) {
    fail(`refund receipt asset ${oD.receipt?.asset_id} != input asset ${RA}`);
  }
  ok(`stale-floor swap passed through — refund ${oD.refund_amount} of the input asset, pool untouched by it`);
  // Refund recovery: the refunded receipt must credit back in holdings.
  dapp.invalidateHoldingsCache();
  const h1 = await dapp.scanHoldings();
  const ra1 = h1.get(RA)?.balance ?? 0n;
  const ra0 = BigInt(state.raceT.ra_before);
  // Expected: lost RACE_IN to the executed fill (swap C) only; the
  // refunded RACE_IN came back at the receipt slot.
  if (ra1 !== ra0 - RACE_IN) {
    warn(`input-asset balance ${ra1} != expected ${ra0 - RACE_IN} (refund may need another scan once the record propagates)`);
  } else {
    ok(`conservation holds: input-asset balance dropped by exactly one executed fill; the refunded fill came back`);
  }
  state.raceT.verified = true;
  saveState(state);
}

console.log(`\n=== race rehearsal complete — no envelope burned ===\n`);
console.log(`Pool: ${state.pool.pool_id_hex}`);
console.log(`  R/A: https://mempool.space/signet/tx/${state.raceR.swapA.reveal_txid}`);
console.log(`  R/B: https://mempool.space/signet/tx/${state.raceR.swapB.reveal_txid}`);
console.log(`  T/C: https://mempool.space/signet/tx/${state.raceT.swapC.reveal_txid}`);
console.log(`  T/D: https://mempool.space/signet/tx/${state.raceT.swapD.reveal_txid}`);
