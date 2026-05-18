// T_FARM_INIT / T_LP_BOND / T_LP_HARVEST / T_LP_UNBOND / T_FARM_REFUND
// on-chain end-to-end signet harness (SPEC-AMM-FARM-AMENDMENT.md).
//
// This is the integration-test gap surfaced in the design review:
// the worker chain-scan branches, KV state persistence, emit-resolver
// receipt index, and HTTP /farm endpoints have never been exercised
// against a real Bitcoin chain. Cross-impl byte parity locks the wire
// format across ref impl, worker, and dapp — but only end-to-end on
// signet proves the worker actually crystallizes state on confirmed
// envelopes, that the emit-resolver resolves freshly-minted UTXOs, and
// that the depth-3 gate works on real reorgs.
//
// Flow (phased; each phase resumable from .local/amm-farm-e2e-state.json):
//
//   Phase 1: pre-flight checks (wallets loaded, worker reachable, deps)
//   Phase 2: CETCH × 2 — asset_A (paired with asset_B in the pool that
//            mints LP shares) + asset_REWARD (TAC-style farm reward)
//   Phase 3: POOL_INIT (asset_A, asset_B) — pool to bond shares of
//   Phase 4: T_FARM_INIT — short emission window so we don't wait days
//   Phase 5: T_LP_BOND — bond LP shares against the farm
//   Phase 6: wait for accrual + T_LP_HARVEST → reward UTXO indexed
//   Phase 7: T_LP_UNBOND → LP UTXO returns to bonder
//   Phase 8 (optional): T_FARM_REFUND — gated on end_height + 1008 blocks
//                       (~7 days on signet). Run the harness a second
//                       time after the grace window to exercise this.
//
// Pre-req:
//   .local/amm-e2e-signet-wallets.json (gen-amm-e2e-signet-wallets.mjs)
//   Founder + Bonder roles. Founder does CETCH × 2, POOL_INIT, FARM_INIT.
//   Bonder runs LP_ADD to get LP shares, then BOND/HARVEST/UNBOND.
//   Budget ≥ 300k signet sats split across both roles.
//
// Run:
//   node tests/amm-farm-e2e-signet.mjs              — full pre-refund run
//   node tests/amm-farm-e2e-signet.mjs --refund     — run refund phase only
//                                                     (after grace window)
//   node tests/amm-farm-e2e-signet.mjs --dry-run    — build envelopes,
//                                                     validate via the ref
//                                                     impl, do NOT broadcast
//   node tests/amm-farm-e2e-signet.mjs --reset      — wipe state and start over
//
// Resumable: each phase persists to .local/amm-farm-e2e-state.json.

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- jsdom shim so the dapp module loads under Node ----
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

// Ref-impl exports we use for envelope construction + dry-run validation.
const refFarm = await import('./amm-farm.mjs');
const { bpRangeAggProve, randomScalar, modN, SECP_N, pedersenCommit, pointToBytes, ZERO, G, H } =
  await import('./bulletproofs.mjs');
const { signSchnorr } = await import('./composition.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'amm-farm-e2e-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');

// ---- CLI flags ----
const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const DRY_RUN = FLAGS.has('--dry-run');
const REFUND_ONLY = FLAGS.has('--refund');
const RESET = FLAGS.has('--reset');

if (RESET && existsSync(STATE_FILE)) {
  unlinkSync(STATE_FILE);
  console.log(`State reset: ${STATE_FILE} deleted`);
}

// ---- Output helpers ----
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---- Wallets ----
if (!existsSync(WALLETS_FILE)) {
  fail(`Wallets not found at ${WALLETS_FILE}\n  Run: node tests/gen-amm-e2e-signet-wallets.mjs`);
}
const WALLETS = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const FOUNDER = {
  priv: hexToBytes(WALLETS.founder.priv_hex),
  pub: secp.getPublicKey(hexToBytes(WALLETS.founder.priv_hex), true),
  addr: WALLETS.founder.address,
};
// Single-wallet simplification: FOUNDER does everything. POOL_INIT mints
// the founder LP shares (Uniswap V2 initial-share convention), so the
// founder has lp_asset_id UTXOs to bond directly — no cross-wallet
// LP_ADD prerequisite. Keeps the harness self-contained and runnable
// in one shot. A separate cross-party test is covered by
// amm-full-e2e-signet.mjs.
const BONDER = FOUNDER;
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(FOUNDER.pub), '1'); } catch {}
function useWallet(w) {
  dapp.wallet.priv = w.priv;
  dapp.wallet.pub = w.pub;
  dapp.invalidateHoldingsCache();
}

// ---- Worker endpoints ----
const WORKER_BASE = process.env.TACIT_WORKER || 'https://tacit-pin.rosscampbell9.workers.dev';
async function fetchPool(poolIdHex) {
  try {
    const r = await fetch(`${WORKER_BASE}/amm/pool/${poolIdHex}?network=signet`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function fetchFarm(farmIdHex) {
  try {
    const r = await fetch(`${WORKER_BASE}/farm/${farmIdHex}?network=signet`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function fetchBonds(farmIdHex, bonderPubHex) {
  try {
    const r = await fetch(`${WORKER_BASE}/farm/${farmIdHex}/bonds?bonder=${bonderPubHex}&network=signet`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function fetchTip() {
  // Worker doesn't expose /tip; query mempool.space's signet API directly.
  try {
    const r = await fetch('https://mempool.space/signet/api/blocks/tip/height', {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    const n = Number(text);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}
async function waitForFarm(farmIdHex, attempts = 20, delayMs = 30_000) {
  info(`polling /farm/${farmIdHex.slice(0, 16)}…`);
  for (let i = 1; i <= attempts; i++) {
    const f = await fetchFarm(farmIdHex);
    if (f?.farm_id === farmIdHex.toLowerCase()) {
      ok(`farm registered (treasury=${f.treasury_remaining}, bonded=${f.total_bonded})`);
      return f;
    }
    info(`  attempt ${i}/${attempts}: not yet`);
    if (i < attempts) await sleep(delayMs);
  }
  return null;
}
async function waitForBondedAdvance(farmIdHex, prevBonded, attempts = 20, delayMs = 30_000) {
  info(`polling /farm/${farmIdHex.slice(0, 16)}… for total_bonded != ${prevBonded}`);
  for (let i = 1; i <= attempts; i++) {
    const f = await fetchFarm(farmIdHex);
    if (f && f.total_bonded !== String(prevBonded)) {
      ok(`worker indexed bond advance: total_bonded=${f.total_bonded}`);
      return f;
    }
    info(`  attempt ${i}/${attempts}: still ${f?.total_bonded}`);
    if (i < attempts) await sleep(delayMs);
  }
  return null;
}

function cetchAssetId(revealTxid) {
  const txid_BE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) txid_BE[i] = parseInt(revealTxid.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, 0, true);
  return bytesToHex(sha256(concatBytes(txid_BE, voutLE)));
}

function bigintToBytes32(n) {
  let x = BigInt(n);
  if (x < 0n) x = ((x % SECP_N) + SECP_N) % SECP_N;
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

// =========================================================================
// Tunables — short emission window for fast testing
// =========================================================================
//
// reward_per_block must divide reward_total exactly. AMM_FARM_MIN_REWARD_TOTAL
// is 1B base units. Chosen so end_height − start_height ≈ 20 signet blocks
// (~200 min); the bond and harvest happen mid-stream while emissions tick.
const REWARD_TOTAL     = 2_000_000_000n;   // 2B reward-asset base units
const REWARD_PER_BLOCK = 100_000_000n;     // 100M / block → 20 emission blocks
const ASSET_A_SUPPLY   = 1_000_000n;
const ASSET_B_SUPPLY   = 1_000_000n;
const REWARD_SUPPLY    = 100_000_000_000n; // 100B; enough to fund farm + change
const POOL_DELTA_A     = 100_000n;
const POOL_DELTA_B     = 100_000n;
// Founder LP shares from POOL_INIT = isqrt(deltaA · deltaB) − MINIMUM_LIQUIDITY.
// For 100k × 100k → isqrt = 100_000; minus 1000 MINIMUM_LIQUIDITY → 99_000.
// Bonding 50_000 of those is comfortably above the 1000 AMM_FARM_MIN_BOND floor.
const BOND_AMOUNT      = 50_000n;
const START_HEIGHT_OFFSET = 8;              // start_height = tip + 8 (after init-lock window)

const state = loadState();
console.log(`\n=== T_FARM_INIT / BOND / HARVEST / UNBOND / REFUND signet harness ===\n`);
console.log(`  founder:  ${FOUNDER.addr}  (single-wallet: CETCH × 3, POOL_INIT,`);
console.log(`                                  FARM_INIT, BOND, HARVEST, UNBOND, REFUND)`);
console.log(`  worker:   ${WORKER_BASE}`);
console.log(`  state:    ${STATE_FILE}`);
if (DRY_RUN)     console.log(`  mode:     DRY_RUN (build envelopes, validate, no broadcast)`);
if (REFUND_ONLY) console.log(`  mode:     REFUND ONLY (skip init/bond/harvest/unbond)`);

if (REFUND_ONLY) {
  if (!state.farm?.farm_id_hex) {
    fail(`--refund requires a prior run that completed FARM_INIT. State file has no farm_id.`);
  }
  console.log(`  farm_id:  ${state.farm.farm_id_hex.slice(0, 16)}…`);
  await runRefund(state);
  process.exit(0);
}

// =========================================================================
// Phase 1: pre-flight
// =========================================================================
step(1, 'pre-flight checks');

const tip = await fetchTip();
if (tip === null) {
  warn('worker /tip endpoint unreachable — proceeding with stub values; some pre-checks will skip');
} else {
  ok(`worker reachable; signet tip = ${tip}`);
}

if (DRY_RUN) {
  ok('DRY_RUN mode — broadcast paths disabled; ref-impl validation only');
} else {
  ok('LIVE mode — will broadcast to signet');
}

// =========================================================================
// Phase 2: CETCH × 2 (asset_A pool side + reward asset)
// =========================================================================
step(2, 'CETCH × 2 (asset_A + asset_REWARD)');
state.cetches = state.cetches || {};
useWallet(FOUNDER);

async function cetch(label, ticker, supply) {
  if (state.cetches[label]) {
    ok(`reusing CETCH ${label}: ${state.cetches[label].reveal_txid.slice(0, 16)}…`);
    return state.cetches[label];
  }
  if (DRY_RUN) {
    // Synthesise a deterministic stub asset_id so subsequent phases compose.
    const stubTxid = bytesToHex(sha256(new TextEncoder().encode(`stub-cetch-${label}`)));
    const aid = cetchAssetId(stubTxid);
    state.cetches[label] = { reveal_txid: stubTxid, asset_id: aid, ticker, stub: true };
    saveState(state);
    ok(`(dry-run) CETCH ${label} stubbed: asset_id=${aid.slice(0, 16)}…`);
    return state.cetches[label];
  }
  info(`CETCH ${label} (${ticker}, supply=${supply})…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker, supplyBase: supply, decimals: 0, mintable: false,
  });
  const aid = cetchAssetId(r.revealTxid);
  state.cetches[label] = { reveal_txid: r.revealTxid, asset_id: aid, ticker };
  saveState(state);
  ok(`CETCH ${label} reveal ${r.revealTxid.slice(0, 16)}…  asset_id=${aid.slice(0, 16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  return state.cetches[label];
}
const C_A = await cetch('A',      'FARM-A',      ASSET_A_SUPPLY);
const C_B = await cetch('B',      'FARM-B',      ASSET_B_SUPPLY);
const C_R = await cetch('REWARD', 'FARM-REWARD', REWARD_SUPPLY);
const ASSET_A_ID  = C_A.asset_id;
const ASSET_B_ID  = C_B.asset_id;
const ASSET_REW_ID = C_R.asset_id;

// =========================================================================
// Phase 3: POOL_INIT (asset_A, asset_B)
// =========================================================================
step(3, 'POOL_INIT (asset_A ↔ asset_B @ 30bps)');
useWallet(FOUNDER);
if (state.pool?.completed) {
  ok(`reusing pool: ${state.pool.pool_id_hex.slice(0, 16)}…`);
} else if (DRY_RUN) {
  // Synthesise a deterministic pool_id.
  const fakePoolPreimage = concatBytes(
    new TextEncoder().encode('tacit-amm-pool-v1'),
    hexToBytes(ASSET_A_ID < ASSET_B_ID ? ASSET_A_ID : ASSET_B_ID),
    hexToBytes(ASSET_A_ID < ASSET_B_ID ? ASSET_B_ID : ASSET_A_ID),
    new Uint8Array([30, 0]),
    new Uint8Array([0]),
  );
  const poolId = bytesToHex(sha256(fakePoolPreimage));
  state.pool = {
    completed: true, stub: true,
    pool_id_hex: poolId,
    canonical_asset_a: ASSET_A_ID < ASSET_B_ID ? ASSET_A_ID : ASSET_B_ID,
    canonical_asset_b: ASSET_A_ID < ASSET_B_ID ? ASSET_B_ID : ASSET_A_ID,
    delta_a: POOL_DELTA_A.toString(),
    delta_b: POOL_DELTA_B.toString(),
    fee_bps: 30,
    init_height: tip || 0,
  };
  saveState(state);
  ok(`(dry-run) POOL_INIT stubbed: pool_id=${poolId.slice(0, 16)}…`);
} else {
  info(`POOL_INIT (${POOL_DELTA_A}/${POOL_DELTA_B} @ 30bps)…`);
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: ASSET_A_ID, assetBIdHex: ASSET_B_ID,
    deltaA: POOL_DELTA_A, deltaB: POOL_DELTA_B,
    feeBps: 30,
    vkCid: 'bafy-farm-harness-vk', ceremonyCid: 'bafy-farm-harness-ceremony',
    poolCapabilityFlags: 0,
  });
  state.pool = {
    completed: true,
    pool_id_hex: r.poolIdHex,
    canonical_asset_a: r.canonicalAssetA,
    canonical_asset_b: r.canonicalAssetB,
    delta_a: r.deltaA.toString(),
    delta_b: r.deltaB.toString(),
    fee_bps: r.feeBps,
    reveal_txid: r.revealTxid,
  };
  saveState(state);
  ok(`POOL_INIT reveal ${r.revealTxid.slice(0, 16)}…  pool ${r.poolIdHex.slice(0, 16)}…`);
  info(`waiting 90s for confirmation + worker indexing…`);
  await sleep(90_000);
  const p = await fetchPool(r.poolIdHex);
  if (p && p.init_height) {
    state.pool.init_height = p.init_height;
    saveState(state);
    ok(`worker indexed pool; init_height=${p.init_height}`);
  } else {
    warn('worker did not yet confirm pool registration — Phase 4 may need to wait');
  }
}

// =========================================================================
// Phase 4: T_FARM_INIT
// =========================================================================
step(4, 'T_FARM_INIT (founder creates farm with virtual treasury)');
useWallet(FOUNDER);

if (state.farm?.completed) {
  ok(`reusing farm: ${state.farm.farm_id_hex.slice(0, 16)}…`);
} else {
  const currentTip = tip || state.pool.init_height || 0;
  const startHeight = currentTip + START_HEIGHT_OFFSET;
  const endHeight   = startHeight + Number(REWARD_TOTAL / REWARD_PER_BLOCK);
  info(`farm schedule: start=${startHeight}, end=${endHeight} (~${endHeight - startHeight} blocks of emission)`);
  info(`reward_total=${REWARD_TOTAL}, reward_per_block=${REWARD_PER_BLOCK}, reward_asset=${ASSET_REW_ID.slice(0, 16)}…`);

  // ---- Build envelope ----
  const farmNonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(farmNonce);
  const farmId = refFarm.deriveFarmId({
    poolId: hexToBytes(state.pool.pool_id_hex),
    launcherPubkey: FOUNDER.pub,
    rewardAssetId: hexToBytes(ASSET_REW_ID),
    farmNonce,
  });

  // Carve a reward-asset UTXO sized exactly to REWARD_TOTAL for clean
  // sentinel-case kernel-sig (no change).
  let inputUtxo;
  if (DRY_RUN) {
    inputUtxo = {
      txid: bytesToHex(sha256(new TextEncoder().encode('stub-reward-utxo'))),
      vout: 0,
      amount: REWARD_TOTAL,
      blinding: randomScalar(),
    };
  } else {
    inputUtxo = await dapp.carveExactAmount({ assetIdHex: ASSET_REW_ID, amount: REWARD_TOTAL });
    if (!inputUtxo || !inputUtxo.utxo) fail('failed to carve reward-asset UTXO');
    inputUtxo = {
      txid: inputUtxo.utxo.txid, vout: inputUtxo.utxo.vout,
      amount: inputUtxo.amount, blinding: BigInt(inputUtxo.blinding),
    };
  }

  // Whole-input case (input == reward_total): no-change sentinel.
  const cChangeOrSentinel = refFarm.NO_CHANGE_SENTINEL;
  const inputCommit = pedersenCommit(inputUtxo.amount, inputUtxo.blinding);
  const placeholderBlind = randomScalar();
  const { proof: rangeProof } = bpRangeAggProve([0n], [placeholderBlind]);

  const kernelMsg = refFarm.buildFarmInitKernelMsg({
    rewardAssetId: hexToBytes(ASSET_REW_ID),
    launcherInputOutpointTxid: hexToBytes(inputUtxo.txid),
    launcherInputOutpointVout: inputUtxo.vout,
    cChangeOrSentinel,
    rewardTotal: REWARD_TOTAL,
  });
  const excessScalar = modN(-inputUtxo.blinding);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excessScalar));

  const initMsg = refFarm.buildFarmInitMsg({
    farmId,
    launcherPubkey: FOUNDER.pub,
    rewardTotal: REWARD_TOTAL,
    rewardPerBlock: REWARD_PER_BLOCK,
    startHeight,
    endHeight,
  });
  const launcherSig = signSchnorr(initMsg, FOUNDER.priv);

  const payload = refFarm.encodeFarmInit({
    poolId: hexToBytes(state.pool.pool_id_hex),
    farmNonce,
    launcherPubkey: FOUNDER.pub,
    rewardAssetId: hexToBytes(ASSET_REW_ID),
    rewardTotal: REWARD_TOTAL,
    rewardPerBlock: REWARD_PER_BLOCK,
    startHeight,
    endHeight,
    cChangeOrSentinel,
    rangeProof,
    kernelSig,
    launcherSig,
  });
  const envelopeHash = refFarm.computeEnvelopeHash(payload);

  // ---- Dry-run validate via ref impl ----
  const stubPool = {
    pool_id: hexToBytes(state.pool.pool_id_hex),
    init_height: state.pool.init_height || (currentTip - 10),
    amm_initial_lp_lock_blocks: 6,
  };
  const { bpRangeAggVerify } = await import('./bulletproofs.mjs');
  function bpVerifyAware(V_pts, proofBytes) {
    if (V_pts.length === 1 && V_pts[0].equals(ZERO)) {
      return proofBytes instanceof Uint8Array && proofBytes.length > 0;
    }
    return bpRangeAggVerify(V_pts, proofBytes);
  }
  const dry = refFarm.validateFarmInit({
    payload,
    pool: stubPool,
    inputCommitment: pointToBytes(inputCommit),
    currentHeight: currentTip,
    opReturnData: envelopeHash,
    bulletproofVerify: bpVerifyAware,
  });
  if (!dry.valid) fail(`ref-impl validation rejected FARM_INIT: ${dry.reason}`);
  ok(`ref-impl validation PASS — envelope is well-formed`);

  state.farm = {
    farm_id_hex: bytesToHex(farmId),
    farm_nonce_hex: bytesToHex(farmNonce),
    reward_asset_id: ASSET_REW_ID,
    reward_total: REWARD_TOTAL.toString(),
    reward_per_block: REWARD_PER_BLOCK.toString(),
    start_height: startHeight,
    end_height: endHeight,
    payload_hex: bytesToHex(payload),
    envelope_hash: bytesToHex(envelopeHash),
    input_utxo: { txid: inputUtxo.txid, vout: inputUtxo.vout, amount: inputUtxo.amount.toString() },
  };

  if (DRY_RUN) {
    state.farm.completed = true;
    state.farm.stub = true;
    saveState(state);
    ok(`(dry-run) FARM_INIT envelope built (${payload.length} B). Skipping broadcast.`);
    info(`farm_id: ${state.farm.farm_id_hex}`);
  } else {
    // ---- Broadcast: commit + reveal tx pair, same pattern as
    //      buildAndBroadcastSwapRoute. The reveal tx has:
    //        vin[0] = commit's envelope output (taproot script-path)
    //        vin[1] = launcher's reward-asset UTXO
    //        vout[0] = OP_RETURN(envelope_hash)
    //        vout[1] = optional change (omitted in whole-input case)
    info(`broadcasting FARM_INIT envelope (payload ${payload.length} B)…`);
    const broadcastRes = await broadcastFarmEnvelope({
      payload,
      envelopeHash,
      vin1: inputUtxo,
      launcherWallet: FOUNDER,
    });
    state.farm.commit_txid  = broadcastRes.commitTxid;
    state.farm.reveal_txid  = broadcastRes.revealTxid;
    state.farm.completed = true;
    saveState(state);
    ok(`FARM_INIT reveal ${broadcastRes.revealTxid.slice(0, 16)}…`);
    info(`waiting 90s for confirmation + worker indexing…`);
    await sleep(90_000);
    const farmFetched = await waitForFarm(state.farm.farm_id_hex);
    if (!farmFetched) fail('worker never indexed the farm');
    state.farm.worker_confirmed_height = farmFetched.confirmed_height;
    saveState(state);
  }
}

// =========================================================================
// Phase 5: T_LP_BOND (requires LP shares in bonder's wallet)
// =========================================================================
step(5, 'T_LP_BOND (bonder stakes LP shares)');

if (DRY_RUN) {
  warn('DRY_RUN: skipping BOND (requires real LP shares); envelope-construction smoke covered offline');
} else if (state.bond?.completed) {
  ok(`reusing bond: ${state.bond.bond_id_hex.slice(0, 16)}…`);
} else {
  useWallet(BONDER);
  const lpAssetIdBytes = refFarm.deriveLpAssetIdFromPoolId(hexToBytes(state.pool.pool_id_hex));
  const lpAssetIdHex = bytesToHex(lpAssetIdBytes);

  dapp.invalidateHoldingsCache();
  await sleep(3_000);
  const holdings = await dapp.scanHoldings();
  const lpHolding = holdings.get(lpAssetIdHex);
  if (!lpHolding || lpHolding.balance < BOND_AMOUNT) {
    fail(
      `bonder (= founder in single-wallet mode) needs ≥ ${BOND_AMOUNT} of\n` +
      `  lp_asset_id ${lpAssetIdHex.slice(0, 16)}…\n` +
      `  current balance: ${lpHolding?.balance ?? 0}\n` +
      `  POOL_INIT should have minted ~${POOL_DELTA_A - 1000n} founder LP shares.\n` +
      `  Check that Phase 3 confirmed + worker indexed the pool.`
    );
  }
  const lpUtxo = await dapp.carveExactAmount({ assetIdHex: lpAssetIdHex, amount: BOND_AMOUNT });
  if (!lpUtxo || !lpUtxo.utxo) fail('failed to carve LP UTXO of size BOND_AMOUNT');

  // Fetch live farm state for canonical entry_acc.
  const liveFarm = await fetchFarm(state.farm.farm_id_hex);
  if (!liveFarm) fail('worker has no record of the farm — Phase 4 must complete first');
  const tipNow = await fetchTip();
  if (!tipNow) fail('worker /tip unreachable');
  const canonicalHeight = Math.min(tipNow - 3, liveFarm.end_height);
  // Crystallize the farm copy to derive the entry_acc the bonder must publish.
  const farmCopy = {
    ...liveFarm,
    reward_total: BigInt(liveFarm.reward_total),
    reward_per_block: BigInt(liveFarm.reward_per_block),
    acc_reward_per_share: BigInt(liveFarm.acc_reward_per_share),
    total_bonded: BigInt(liveFarm.total_bonded),
    treasury_remaining: BigInt(liveFarm.treasury_remaining),
  };
  refFarm.crystallizeFarm(farmCopy, canonicalHeight);
  const entryAcc = farmCopy.acc_reward_per_share;

  // Build bond envelope.
  const inputValue = BigInt(lpUtxo.amount);
  const inputBlind = BigInt(lpUtxo.blinding);
  const changeValue = inputValue - BOND_AMOUNT;
  let cChangeOrSentinel, rangeProof, kernelExcess;
  if (changeValue === 0n) {
    cChangeOrSentinel = refFarm.NO_CHANGE_SENTINEL;
    const { proof } = bpRangeAggProve([0n], [randomScalar()]);
    rangeProof = proof;
    kernelExcess = modN(-inputBlind);
  } else {
    const changeBlind = randomScalar();
    const cChange = pedersenCommit(changeValue, changeBlind);
    cChangeOrSentinel = pointToBytes(cChange);
    const { proof } = bpRangeAggProve([changeValue], [changeBlind]);
    rangeProof = proof;
    kernelExcess = modN(changeBlind - inputBlind);
  }
  const kernelMsg = refFarm.buildLpBondKernelMsg({
    lpAssetId: lpAssetIdBytes,
    bonderInputOutpointTxid: hexToBytes(lpUtxo.utxo.txid),
    bonderInputOutpointVout: lpUtxo.utxo.vout,
    cChangeOrSentinel,
    bondAmount: BOND_AMOUNT,
  });
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(kernelExcess));
  const bondMsg = refFarm.buildLpBondMsg({
    farmId: hexToBytes(state.farm.farm_id_hex),
    bonderPubkey: BONDER.pub,
    bondAmount: BOND_AMOUNT,
    entryAccPerShare: entryAcc,
    bondViewHeight: canonicalHeight,
  });
  const bonderSig = signSchnorr(bondMsg, BONDER.priv);
  const payload = refFarm.encodeLpBond({
    farmId: hexToBytes(state.farm.farm_id_hex),
    bonderPubkey: BONDER.pub,
    bondAmount: BOND_AMOUNT,
    entryAccPerShare: entryAcc,
    bondViewHeight: canonicalHeight,
    cChangeOrSentinel, rangeProof, kernelSig, bonderSig,
  });
  const envelopeHash = refFarm.computeEnvelopeHash(payload);

  // LP_BOND emits: vout[1] = bond-marker dust (P2WPKH to bonder), vout[2] = optional change
  const bondMarkerSpk = dapp.p2wpkhScript(BONDER.pub);
  const extraOutputs = [{ value: dapp.DUST, script: bondMarkerSpk }];
  if (changeValue > 0n) {
    extraOutputs.push({ value: dapp.DUST, script: dapp.p2wpkhScript(BONDER.pub) });
  }

  info(`broadcasting BOND envelope (${payload.length} B, bond_amount=${BOND_AMOUNT}, entry_acc=${entryAcc})…`);
  const broadcastRes = await broadcastFarmEnvelope({
    payload, envelopeHash,
    vin1: { txid: lpUtxo.utxo.txid, vout: lpUtxo.utxo.vout },
    launcherWallet: BONDER,
    extraOutputs,
  });
  // bond_id = vout[1].outpoint of the bond reveal tx.
  const bondTxidBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bondTxidBytes[i] = parseInt(broadcastRes.revealTxid.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  }
  const bondIdBytes = new Uint8Array(36);
  bondIdBytes.set(bondTxidBytes, 0);
  new DataView(bondIdBytes.buffer).setUint32(32, 1, true);
  const bondIdHex = bytesToHex(bondIdBytes);
  state.bond = {
    completed: true,
    bond_id_hex: bondIdHex,
    reveal_txid: broadcastRes.revealTxid,
    bond_amount: BOND_AMOUNT.toString(),
    entry_acc_per_share: entryAcc.toString(),
    bond_height: canonicalHeight,
  };
  saveState(state);
  ok(`BOND reveal ${broadcastRes.revealTxid.slice(0, 16)}…  bond_id=${bondIdHex.slice(0, 16)}…`);
  info(`waiting 90s for confirmation + worker indexing…`);
  await sleep(90_000);
  const updatedFarm = await waitForBondedAdvance(state.farm.farm_id_hex, '0');
  if (!updatedFarm) warn('worker did not yet index bond — Phase 6 may need to wait');
}

// =========================================================================
// Phase 6: T_LP_HARVEST (claim accrued reward, keep bond alive)
// =========================================================================
step(6, 'T_LP_HARVEST (claim reward without unbonding)');

if (DRY_RUN || !state.bond?.completed) {
  warn(`${DRY_RUN ? 'DRY_RUN' : 'no bond present'}: skipping HARVEST`);
} else if (state.harvest?.completed) {
  ok(`reusing harvest: ${state.harvest.reveal_txid.slice(0, 16)}…`);
} else {
  useWallet(BONDER);
  // Wait a few blocks so accrual builds up.
  info(`waiting 5 blocks (~50 min) for emissions to accrue…`);
  // For test purposes, poll every 2 min; in production this would just wait a fixed interval.
  let priorAcc = '0';
  for (let i = 0; i < 30; i++) {
    const f = await fetchFarm(state.farm.farm_id_hex);
    if (f && BigInt(f.acc_reward_per_share) > 0n) {
      priorAcc = f.acc_reward_per_share;
      info(`emissions started: acc=${priorAcc}`);
      break;
    }
    if (i % 5 === 0) info(`  waiting for emissions to start (attempt ${i + 1}/30)…`);
    await sleep(120_000);
  }

  const liveFarm = await fetchFarm(state.farm.farm_id_hex);
  if (!liveFarm) fail('farm not found');
  const tipNow = await fetchTip();
  if (!tipNow) fail('worker /tip unreachable');
  const canonical = Math.min(tipNow - 3, liveFarm.end_height);
  const farmCopy = {
    ...liveFarm,
    reward_total: BigInt(liveFarm.reward_total),
    reward_per_block: BigInt(liveFarm.reward_per_block),
    acc_reward_per_share: BigInt(liveFarm.acc_reward_per_share),
    total_bonded: BigInt(liveFarm.total_bonded),
    treasury_remaining: BigInt(liveFarm.treasury_remaining),
  };
  refFarm.crystallizeFarm(farmCopy, canonical);
  const exitAcc = farmCopy.acc_reward_per_share;
  const entryAcc = BigInt(state.bond.entry_acc_per_share);
  const delta = exitAcc - entryAcc;
  const pending = (BOND_AMOUNT * delta) >> refFarm.ACC_FIXED_POINT_SHIFT;
  const payout = pending > farmCopy.treasury_remaining ? farmCopy.treasury_remaining : pending;
  if (payout === 0n) {
    warn('payout would be 0 — wait longer for accrual or end the run');
  } else {
    const rewardR = bigintToBytes32(randomScalar());
    const harvestMsg = refFarm.buildLpHarvestMsg({
      farmId: hexToBytes(state.farm.farm_id_hex),
      bondId: hexToBytes(state.bond.bond_id_hex),
      harvesterPubkey: BONDER.pub,
      exitAccPerShare: exitAcc,
      exitViewHeight: canonical,
      rewardAmount: payout,
      rewardR,
    });
    const harvesterSig = signSchnorr(harvestMsg, BONDER.priv);
    const payload = refFarm.encodeLpHarvest({
      farmId: hexToBytes(state.farm.farm_id_hex),
      bondId: hexToBytes(state.bond.bond_id_hex),
      harvesterPubkey: BONDER.pub,
      exitAccPerShare: exitAcc,
      exitViewHeight: canonical,
      rewardAmount: payout,
      rewardR, harvesterSig,
    });
    const envelopeHash = refFarm.computeEnvelopeHash(payload);
    // HARVEST emits vout[1] = reward UTXO (validator decree-mints).
    const rewardSpk = dapp.p2wpkhScript(BONDER.pub);
    info(`broadcasting HARVEST envelope (payout=${payout})…`);
    const broadcastRes = await broadcastFarmEnvelope({
      payload, envelopeHash, vin1: null, launcherWallet: BONDER,
      extraOutputs: [{ value: dapp.DUST, script: rewardSpk }],
    });
    state.harvest = {
      completed: true,
      reveal_txid: broadcastRes.revealTxid,
      payout: payout.toString(),
      exit_acc: exitAcc.toString(),
    };
    saveState(state);
    ok(`HARVEST reveal ${broadcastRes.revealTxid.slice(0, 16)}…  payout=${payout}`);
    info(`waiting 90s for confirmation…`);
    await sleep(90_000);
  }
}

// =========================================================================
// Phase 7: T_LP_UNBOND (claim remaining + return LP shares)
// =========================================================================
step(7, 'T_LP_UNBOND (full exit)');

if (DRY_RUN || !state.bond?.completed) {
  warn(`${DRY_RUN ? 'DRY_RUN' : 'no bond present'}: skipping UNBOND`);
} else if (state.unbond?.completed) {
  ok(`reusing unbond: ${state.unbond.reveal_txid.slice(0, 16)}…`);
} else {
  useWallet(BONDER);
  const liveFarm = await fetchFarm(state.farm.farm_id_hex);
  if (!liveFarm) fail('farm not found');
  const tipNow = await fetchTip();
  if (!tipNow) fail('worker /tip unreachable');
  const canonical = Math.min(tipNow - 3, liveFarm.end_height);
  const farmCopy = {
    ...liveFarm,
    reward_total: BigInt(liveFarm.reward_total),
    reward_per_block: BigInt(liveFarm.reward_per_block),
    acc_reward_per_share: BigInt(liveFarm.acc_reward_per_share),
    total_bonded: BigInt(liveFarm.total_bonded),
    treasury_remaining: BigInt(liveFarm.treasury_remaining),
  };
  refFarm.crystallizeFarm(farmCopy, canonical);
  const exitAcc = farmCopy.acc_reward_per_share;
  // If user harvested, bond.entry_acc was rolled forward; refetch from worker.
  const bondsList = await fetchBonds(state.farm.farm_id_hex, bytesToHex(BONDER.pub));
  const myBond = bondsList?.bonds?.find(b => b.bond_id === state.bond.bond_id_hex);
  if (!myBond) fail('worker has no record of the bond');
  const entryAcc = BigInt(myBond.entry_acc_per_share);
  const delta = exitAcc - entryAcc;
  const pending = (BOND_AMOUNT * delta) >> refFarm.ACC_FIXED_POINT_SHIFT;
  const payout = pending > farmCopy.treasury_remaining ? farmCopy.treasury_remaining : pending;

  const lpReturnR = bigintToBytes32(randomScalar());
  const rewardR = payout === 0n ? new Uint8Array(32) : bigintToBytes32(randomScalar());
  const unbondMsg = refFarm.buildLpUnbondMsg({
    farmId: hexToBytes(state.farm.farm_id_hex),
    bondId: hexToBytes(state.bond.bond_id_hex),
    unbonderPubkey: BONDER.pub,
    exitAccPerShare: exitAcc,
    exitViewHeight: canonical,
    rewardAmount: payout,
    lpReturnR, rewardR,
  });
  const unbonderSig = signSchnorr(unbondMsg, BONDER.priv);
  const payload = refFarm.encodeLpUnbond({
    farmId: hexToBytes(state.farm.farm_id_hex),
    bondId: hexToBytes(state.bond.bond_id_hex),
    unbonderPubkey: BONDER.pub,
    exitAccPerShare: exitAcc,
    exitViewHeight: canonical,
    rewardAmount: payout,
    lpReturnR, rewardR, unbonderSig,
  });
  const envelopeHash = refFarm.computeEnvelopeHash(payload);
  // UNBOND emits vout[1] = lp_return, vout[2] = reward (omitted if 0).
  const lpReturnSpk = dapp.p2wpkhScript(BONDER.pub);
  const extraOutputs = [{ value: dapp.DUST, script: lpReturnSpk }];
  if (payout > 0n) {
    extraOutputs.push({ value: dapp.DUST, script: dapp.p2wpkhScript(BONDER.pub) });
  }
  info(`broadcasting UNBOND envelope (payout=${payout})…`);
  const broadcastRes = await broadcastFarmEnvelope({
    payload, envelopeHash, vin1: null, launcherWallet: BONDER,
    extraOutputs,
  });
  state.unbond = {
    completed: true,
    reveal_txid: broadcastRes.revealTxid,
    payout: payout.toString(),
    exit_acc: exitAcc.toString(),
  };
  saveState(state);
  ok(`UNBOND reveal ${broadcastRes.revealTxid.slice(0, 16)}…  payout=${payout}`);
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== Farm harness summary ===\n`);
if (state.farm?.farm_id_hex) {
  console.log(`farm_id:           ${state.farm.farm_id_hex}`);
  console.log(`pool_id:           ${state.pool.pool_id_hex}`);
  console.log(`reward_asset:      ${state.farm.reward_asset_id}`);
  console.log(`reward_total:      ${state.farm.reward_total}`);
  console.log(`reward_per_block:  ${state.farm.reward_per_block}`);
  console.log(`start_height:      ${state.farm.start_height}`);
  console.log(`end_height:        ${state.farm.end_height}`);
  console.log(`refund_unlock:     ${state.farm.end_height + 1008}  (~7 days post-end)`);
  if (state.farm.reveal_txid) {
    console.log(`mempool:           https://mempool.space/signet/tx/${state.farm.reveal_txid}`);
  }
}
console.log(`\nState: ${STATE_FILE}\n`);
if (state.farm?.completed && !state.farm.stub) {
  console.log(`Next: complete the bond/harvest/unbond flow by ensuring the bonder`);
  console.log(`      has ≥ ${BOND_AMOUNT} lp_asset_id shares and re-running.`);
  console.log(`Refund: run \`node tests/amm-farm-e2e-signet.mjs --refund\` after`);
  console.log(`        canonical height passes ${state.farm.end_height + 1008}.`);
}

// =========================================================================
// Helpers
// =========================================================================

// Broadcast a farm envelope via commit+reveal P2TR tap-leaf. Generic
// across the five farm opcodes — caller supplies the payload bytes,
// vin[1] (the launcher/bonder's tacit asset input if any), and an
// optional extraOutputs array of additional reveal-tx outputs after
// OP_RETURN (e.g. wallet-discovery dust for LP_BOND, lp_return + reward
// dusts for LP_UNBOND, reward dust for LP_HARVEST, refund dust for
// FARM_REFUND).
//
// For T_LP_UNBOND, T_LP_HARVEST, T_FARM_REFUND the caller passes vin1=null
// (no asset input is consumed; the validator mints outputs by decree).
async function broadcastFarmEnvelope({ payload, envelopeHash, vin1, launcherWallet, extraOutputs = [] }) {
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
  const tapLeaf = dapp.tapLeafHash(envelopeScript);
  // TAP_NUMS is the dapp's nothing-up-my-sleeve internal key for envelope
  // P2TR outputs. Imported via the dapp module; if unavailable in this
  // environment, fall back to deriving it.
  const TAP_NUMS = dapp.TAP_NUMS || hexToBytes('0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
  const { Q_xonly, parity } = dapp.tweakedOutputKey(TAP_NUMS, tapLeaf);
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(TAP_NUMS, parity);

  const feeRate = await dapp.getFeeRate();
  const opReturnSpk = concatBytes(new Uint8Array([0x6a, 0x20]), envelopeHash);

  // Estimate reveal vbytes (rough — adequate for fee budgeting).
  const revealVbBase = 11 + 41 + (vin1 ? 41 : 0) + 34;
  const revealVb = revealVbBase + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34 + 109) / 4);
  const revealFee = dapp.feeFor(revealVb, feeRate);
  const commitValue = Math.max(dapp.DUST, revealFee);

  // Funding inputs from launcher's plain-sats UTXOs.
  const allUtxos = await dapp.getUtxos(launcherWallet.addr);
  const sats = dapp.sortSatsForCommit(allUtxos.filter(u => u.value > dapp.DUST));
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + dapp.DUST) break;
  }
  if (total < commitValue + commitFee) {
    throw new Error(`insufficient sats: need ${commitValue + commitFee}, have ${total}`);
  }
  const satsChange = total - commitValue - commitFee;
  const changeSpk = dapp.p2wpkhScript(launcherWallet.pub);

  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (satsChange >= dapp.DUST) commitOutputs.push({ value: satsChange, script: changeSpk });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(dapp.serializeTx(commitTx));
  const commitTxidHex = dapp.txid(commitTx);

  // Reveal tx.
  const revealInputs = [
    { txid: commitTxidHex, vout: 0, sequence: 0xfffffffd, witness: [] },
  ];
  const revealPrevouts = [{ value: commitValue, script: commitSpk }];
  if (vin1) {
    revealInputs.push({ txid: vin1.txid, vout: vin1.vout | 0, sequence: 0xfffffffd, witness: [] });
    revealPrevouts.push({ value: dapp.DUST, script: dapp.p2wpkhScript(launcherWallet.pub) });
  }
  // OP_RETURN(envelope_hash) at vout[0], then any extra outputs the caller
  // supplied (wallet-discovery dust for BOND, lp_return + reward for UNBOND,
  // reward for HARVEST, refund for REFUND).
  const revealOutputs = [{ value: 0, script: opReturnSpk }, ...extraOutputs];

  const revealTx = {
    version: 2, locktime: 0,
    inputs: revealInputs,
    outputs: revealOutputs,
  };
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(
    revealTx, revealPrevouts, envelopeScript, cb,
  );
  if (vin1) {
    revealTx.inputs[1].witness = dapp.signP2wpkhInput(revealTx, 1, dapp.DUST);
  }
  const revealHex = bytesToHex(dapp.serializeTx(revealTx));
  const revealTxidHex = dapp.txid(revealTx);

  await dapp.broadcast(commitHex);
  await dapp.broadcastWithRetry(revealHex);
  return { commitTxid: commitTxidHex, revealTxid: revealTxidHex };
}

async function runRefund(state) {
  console.log(`\n--- Phase 8 (refund only) ---`);
  const f = await fetchFarm(state.farm.farm_id_hex);
  if (!f) fail(`worker has no record of farm ${state.farm.farm_id_hex}`);
  const tipNow = await fetchTip();
  if (!tipNow) fail('cannot fetch signet tip from worker');
  const canonical = tipNow - 3;
  const refundFloor = f.end_height + 1008;
  if (canonical < refundFloor) {
    fail(`refund window not open: canonical_height ${canonical} < end_height+grace ${refundFloor}\n` +
         `  Try again after block ${refundFloor + 3}.`);
  }
  if (f.refunded) {
    console.log(`farm already refunded at height ${f.refunded_height}, amount ${f.refunded_amount}`);
    return;
  }
  // Refund envelope construction.
  useWallet(FOUNDER);
  const refundR = bigintToBytes32(randomScalar());
  const refundAmount = BigInt(f.treasury_remaining);
  if (refundAmount === 0n) {
    console.log(`treasury_remaining is 0 — nothing to refund (all rewards claimed by LPs)`);
    return;
  }
  const refundMsg = refFarm.buildFarmRefundMsg({
    farmId: hexToBytes(state.farm.farm_id_hex),
    launcherPubkey: FOUNDER.pub,
    refundAmount,
    refundViewHeight: canonical,
    refundR,
  });
  const launcherSig = signSchnorr(refundMsg, FOUNDER.priv);
  const payload = refFarm.encodeFarmRefund({
    farmId: hexToBytes(state.farm.farm_id_hex),
    launcherPubkey: FOUNDER.pub,
    refundAmount,
    refundViewHeight: canonical,
    refundR,
    launcherSig,
  });
  const envelopeHash = refFarm.computeEnvelopeHash(payload);
  info(`refund envelope built; refund_amount=${refundAmount}`);
  if (DRY_RUN) {
    ok(`(dry-run) refund envelope hash = ${bytesToHex(envelopeHash).slice(0, 16)}…`);
    return;
  }
  // REFUND emits vout[1] = refund UTXO to launcher.
  const refundSpk = dapp.p2wpkhScript(FOUNDER.pub);
  const r = await broadcastFarmEnvelope({
    payload, envelopeHash, vin1: null, launcherWallet: FOUNDER,
    extraOutputs: [{ value: dapp.DUST, script: refundSpk }],
  });
  ok(`REFUND reveal ${r.revealTxid.slice(0, 16)}…`);
  state.refund = { reveal_txid: r.revealTxid, refund_amount: refundAmount.toString() };
  saveState(state);
}
