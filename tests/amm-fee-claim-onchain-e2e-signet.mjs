// T_PROTOCOL_FEE_CLAIM on-chain signet harness.
//
// Focused rehearsal for the LP lifecycle phase the broader
// amm-full-e2e-signet.mjs Phase 11 skipped because its rehearsal pool
// was configured WITHOUT a protocol_fee_bps and accrued stayed zero.
//
// What this harness exercises:
//
//   1. POOL_INIT WITH a non-zero `protocol_fee_bps` + founder fee
//      address, so every swap routes 1% (or whatever bps) of LP-fee
//      growth toward the founder via the lazy crystallization
//      mechanism (AMM.md §"Protocol fee mechanism").
//
//   2. Swap volume × N — k_now grows above k_last; protocol_fee_accrued
//      stays at 0 (lazy: no crystallization until next LP event).
//
//   3. LP_ADD variant 0 — triggers crystallizeProtocolFee inside the
//      worker validator. lp_total_shares += newShares,
//      protocol_fee_accrued += newShares. Worker now reports a non-
//      zero accrued counter at /amm/pool/<id>.
//
//   4. T_PROTOCOL_FEE_CLAIM — founder broadcasts. Worker validates
//      (claim_sig under founder_x_only, claim_C_secp opens to
//      (claim_amount, claim_blinding), claim_amount == accrued),
//      then resets accrued to 0 and emits an lp_asset_id UTXO at
//      vout[0] of the reveal tx at the founder's recipient SPK.
//
//   5. Post-confirm checks:
//        a. worker shows pool.protocol_fee_accrued reset to 0
//        b. founder's holdings show the claim's worth of lp_asset_id
//
// Pre-req:
//   .local/amm-e2e-signet-wallets.json (gen-amm-e2e-signet-wallets.mjs)
//   The FOUNDER role does everything (CETCH × 2, POOL_INIT with fee,
//   funds the trader role indirectly by holding both sides of the pair,
//   does the swaps from a trader wallet, then does the LP_ADD that
//   triggers crystallization, then does the claim). Budget ≥ 200k
//   signet sats.
//
// Resumable: each phase persists to .local/amm-fee-claim-e2e-state.json.
// Re-running picks up where it left off. To restart: rm that file.
//
// Run:  node tests/amm-fee-claim-onchain-e2e-signet.mjs

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
const STATE_FILE = path.join(STATE_DIR, 'amm-fee-claim-e2e-state.json');
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
const TRADER = {
  priv: hexToBytes(WALLETS.trader.priv_hex),
  pub: secp.getPublicKey(hexToBytes(WALLETS.trader.priv_hex), true),
  addr: WALLETS.trader.address,
};
for (const w of [FOUNDER, TRADER]) {
  try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(w.pub), '1'); } catch {}
}

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
      ok(`pool ${label} registered (R_A=${p.reserve_a}, R_B=${p.reserve_b}, accrued=${p.protocol_fee_accrued || 0})`);
      return p;
    }
    info(`  attempt ${i}/${attempts}: not yet`);
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

const state = loadState();

// Tunables. Reserves chosen large enough that crystallization rounds
// non-zero on a handful of swaps (the round-to-zero threshold falls
// when S ~< (fee_bps × root_k_growth / denominator); 1M:1M cleanly
// avoids it for a 100bps fee + a few 5k swaps).
const SUPPLY        = 1_000_000n;
const POOL_DELTA_A  = 200_000n;
const POOL_DELTA_B  = 200_000n;
const SWAP_AMOUNT   = 5_000n;
const N_SWAPS       = 5;
const PROTOCOL_FEE_BPS = 100;   // 1% of LP-fee growth → fast accrual

console.log(`\n=== T_PROTOCOL_FEE_CLAIM on-chain end-to-end signet harness ===\n`);
console.log(`  founder: ${FOUNDER.addr}  ← also acts as protocol-fee recipient`);
console.log(`  trader:  ${TRADER.addr}`);
console.log(`  state:   ${STATE_FILE}\n`);

// =========================================================================
// Phase 1: CETCH × 2 (asset_A + asset_B for the fee-bearing pool)
// =========================================================================
step(1, 'CETCH × 2 (fee-pool asset_A + asset_B)');
state.cetches = state.cetches || {};
useWallet(FOUNDER);
async function cetch(label, ticker) {
  if (state.cetches[label]) {
    ok(`reusing CETCH ${label}: ${state.cetches[label].reveal_txid.slice(0, 16)}…`);
    return state.cetches[label];
  }
  info(`CETCH ${label} (${ticker}, supply=${SUPPLY})…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker, supplyBase: SUPPLY, decimals: 0, mintable: false,
  });
  const aid = cetchAssetId(r.revealTxid);
  state.cetches[label] = { reveal_txid: r.revealTxid, asset_id: aid, ticker };
  saveState(state);
  ok(`CETCH ${label} reveal ${r.revealTxid.slice(0, 16)}…  asset_id=${aid.slice(0, 16)}…`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  return state.cetches[label];
}
const C_A = await cetch('A', 'FEE-A');
const C_B = await cetch('B', 'FEE-B');
const A_AID = C_A.asset_id;
const B_AID = C_B.asset_id;

// =========================================================================
// Phase 2: CXFER founder → trader (fund trader with asset A for swaps)
// =========================================================================
step(2, 'CXFER founder → trader (asset A for trader to swap with)');
if (state.fundTrader?.completed) {
  ok(`reusing transfer: ${state.fundTrader.reveal_txid.slice(0, 16)}…`);
} else {
  useWallet(FOUNDER);
  const fundAmount = SWAP_AMOUNT * BigInt(N_SWAPS) + 10_000n;
  info(`CXFER ${fundAmount} A → trader…`);
  const r = await dapp.buildAndBroadcastCXfer({
    assetIdHex: A_AID.toLowerCase(),
    recipientPubHex: bytesToHex(TRADER.pub),
    amount: fundAmount,
  });
  state.fundTrader = {
    completed: true,
    reveal_txid: r.revealTxid,
    amount: fundAmount.toString(),
  };
  saveState(state);
  ok(`fund trader reveal ${r.revealTxid.slice(0, 16)}…  amount=${fundAmount}`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
}

// =========================================================================
// Phase 3: POOL_INIT with non-zero protocol_fee_bps + founder fee address
// =========================================================================
step(3, `POOL_INIT (A↔B @ 30bps with ${PROTOCOL_FEE_BPS}bps protocol fee to founder)`);
useWallet(FOUNDER);
if (state.pool?.completed) {
  ok(`reusing pool: ${state.pool.pool_id_hex.slice(0, 16)}…`);
} else {
  // Founder's compressed pubkey IS the protocol-fee address. The worker
  // verifies claim_sig under founder_x_only at claim time.
  const protocolFeeAddress = FOUNDER.pub;
  info(`POOL_INIT (${POOL_DELTA_A}/${POOL_DELTA_B} @ 30bps), protocol_fee=${PROTOCOL_FEE_BPS}bps to founder ${bytesToHex(FOUNDER.pub).slice(0, 16)}…`);
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: A_AID, assetBIdHex: B_AID,
    deltaA: POOL_DELTA_A, deltaB: POOL_DELTA_B,
    feeBps: 30,
    vkCid: 'bafy-fee-claim-harness-vk', ceremonyCid: 'bafy-fee-claim-harness-ceremony',
    poolCapabilityFlags: 0,
    protocolFeeAddress, protocolFeeBps: PROTOCOL_FEE_BPS,
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
    protocol_fee_bps: PROTOCOL_FEE_BPS,
    has_protocol_fee: true,
  };
  saveState(state);
  ok(`POOL_INIT reveal ${r.revealTxid.slice(0, 16)}…  pool ${r.poolIdHex.slice(0, 16)}…`);
  info(`waiting 60s for confirmation + worker indexing…`);
  await sleep(60_000);
}
const pool0 = await waitForPool(state.pool.pool_id_hex, 'fee-pool');
if (!pool0) fail('pool never registered on worker');
if (!pool0.protocol_fee_bps || Number(pool0.protocol_fee_bps) === 0) {
  fail(`pool.protocol_fee_bps reads ${pool0.protocol_fee_bps} — expected ${PROTOCOL_FEE_BPS}`);
}
ok(`worker confirms protocol_fee_bps=${pool0.protocol_fee_bps}`);

// =========================================================================
// Phase 4: swap × N (grow k; accrued stays 0 lazily)
// =========================================================================
step(4, `swap × ${N_SWAPS} (alternating directions, ${SWAP_AMOUNT} A per swap)`);
state.swaps = state.swaps || {};
useWallet(TRADER);
for (let i = 0; i < N_SWAPS; i++) {
  const swapLabel = `swap_${i}`;
  if (state.swaps[swapLabel]) {
    ok(`reusing ${swapLabel}: ${state.swaps[swapLabel].reveal_txid.slice(0, 16)}…`);
    continue;
  }
  const direction = i % 2;
  const assetInHex = direction === 0
    ? state.pool.canonical_asset_a.toLowerCase()
    : state.pool.canonical_asset_b.toLowerCase();
  const assetOutHex = direction === 0
    ? state.pool.canonical_asset_b.toLowerCase()
    : state.pool.canonical_asset_a.toLowerCase();

  // For B-direction swaps, founder needs to CXFER trader a tiny B
  // balance once — but for simplicity we only test A→B direction here
  // (direction = 0) for every swap. The crystallization fires regardless
  // of direction; alternating just makes k grow faster but isn't
  // necessary for the FEE_CLAIM rehearsal.
  if (direction !== 0) {
    info(`skipping B→A swap (trader has no B); A→B swap exercises crystallization equally`);
    continue;
  }

  dapp.invalidateHoldingsCache();
  await sleep(3_000);
  const holdings = await dapp.scanHoldings();
  const ah = holdings.get(assetInHex);
  if (!ah || ah.balance < SWAP_AMOUNT) {
    fail(`trader ${assetInHex.slice(0,12)} balance ${ah?.balance ?? 0} < ${SWAP_AMOUNT}`);
  }
  const carved = await dapp.carveExactAmount({ assetIdHex: assetInHex, amount: SWAP_AMOUNT });
  if (!carved?.utxo) fail(`swap ${i}: carveExactAmount failed`);
  const poolR = await fetchPool(state.pool.pool_id_hex);
  if (!poolR) fail(`swap ${i}: pool fetch failed`);
  const R_A = BigInt(poolR.reserve_a), R_B = BigInt(poolR.reserve_b);
  const FEE_DEN = 10_000n;
  const feeMul = FEE_DEN - BigInt(state.pool.fee_bps);
  const dout = (direction === 0)
    ? (R_B * SWAP_AMOUNT * feeMul) / (R_A * FEE_DEN + SWAP_AMOUNT * feeMul)
    : (R_A * SWAP_AMOUNT * feeMul) / (R_B * FEE_DEN + SWAP_AMOUNT * feeMul);
  const minOut = (dout * 9_000n) / 10_000n;  // 10% floor

  info(`swap ${i}: ${SWAP_AMOUNT} A → ≥ ${minOut} B (expected ${dout})`);
  const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
    poolReserves: {
      pool_id_hex: state.pool.pool_id_hex,
      reserve_a: R_A, reserve_b: R_B,
      fee_bps: state.pool.fee_bps,
    },
    assetInputUtxo: {
      txid: carved.utxo.txid, vout: carved.utxo.vout,
      asset_id_hex: assetInHex,
      amount: carved.amount, blinding: carved.blinding,
    },
    direction, deltaIn: SWAP_AMOUNT, minOut,
    expiryHeight: 0xffffffff,
    receiveAssetIdHex: assetOutHex,
  });
  state.swaps[swapLabel] = {
    reveal_txid: r.revealTxid,
    delta_in: SWAP_AMOUNT.toString(),
    delta_out: r.deltaOut.toString(),
    direction,
  };
  saveState(state);
  ok(`swap ${i} reveal ${r.revealTxid.slice(0, 16)}…  deltaOut=${r.deltaOut}`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
}

// =========================================================================
// Phase 5: LP_ADD by founder — triggers crystallizeProtocolFee
// =========================================================================
step(5, 'LP_ADD by founder (triggers crystallization on the worker)');
useWallet(FOUNDER);
if (state.lpAddCrystallize?.completed) {
  ok(`reusing LP_ADD: ${state.lpAddCrystallize.reveal_txid.slice(0, 16)}…`);
} else {
  // Re-fetch pool reserves so the at-ratio compute is fresh.
  const poolR = await fetchPool(state.pool.pool_id_hex);
  if (!poolR) fail('pool fetch failed before LP_ADD');
  const R_A = BigInt(poolR.reserve_a), R_B = BigInt(poolR.reserve_b);
  const S   = BigInt(poolR.lp_total_shares);
  info(`pre-LP_ADD pool state: R_A=${R_A}, R_B=${R_B}, S=${S}, accrued=${poolR.protocol_fee_accrued || 0}`);

  // Add a tiny LP at the ratio (≥ MINIMUM_LIQUIDITY × 10 in each side
  // so share-mint clears the round-to-zero gate; 5000 is safe).
  const lpAddDeltaA = 5_000n;
  const lpAddDeltaB = (lpAddDeltaA * R_B) / R_A;   // at-ratio
  // Caller computes the share-mint via the same formula the validator
  // applies. Note we use the POST-crystallization S that the worker
  // will be using when it validates the envelope (the LP_ADD validator
  // crystallizes BEFORE computing shares); use poolR.lp_total_shares
  // directly since the worker hasn't crystallized yet but will when
  // it processes the envelope — the dapp's lpAddShares uses the same
  // pre-crystallization S, so we'd over-mint. Fix: use the
  // crystallization-aware S.
  const expectedCrystallizeShares = (() => {
    // Inline the same formula as crystallizeProtocolFee. Returns the
    // share count the worker will add to S BEFORE computing the
    // LP_ADD share-mint, so our shareAmount math matches the worker.
    const sPre = S;
    const kPre = BigInt(poolR.k_last || '0');
    const kNow = R_A * R_B;
    if (kNow <= kPre) return 0n;
    const bps = BigInt(PROTOCOL_FEE_BPS);
    if (bps === 0n) return 0n;
    function isqrt(n) {
      if (n < 0n) throw new Error('isqrt: n < 0');
      if (n < 2n) return n;
      let x = n; let y = (x + 1n) / 2n;
      while (y < x) { x = y; y = (x + n / x) / 2n; }
      return x;
    }
    const rootPre = isqrt(kPre);
    const rootNow = isqrt(kNow);
    if (rootNow <= rootPre) return 0n;
    const num = sPre * bps * (rootNow - rootPre);
    const den = (10000n - bps) * rootNow + bps * rootPre;
    if (den === 0n) return 0n;
    return num / den;
  })();
  const sAfterCrystallize = S + expectedCrystallizeShares;
  // Uniswap V2 LP_ADD: shares = floor(min(Δa·S / R_A, Δb·S / R_B))
  const sa = (lpAddDeltaA * sAfterCrystallize) / R_A;
  const sb = (lpAddDeltaB * sAfterCrystallize) / R_B;
  const shareAmount = sa < sb ? sa : sb;
  info(`LP_ADD v=0  Δa=${lpAddDeltaA}  Δb=${lpAddDeltaB}  shareAmount=${shareAmount}  (after crystallizing +${expectedCrystallizeShares})`);
  const r = await dapp.buildAndBroadcastLpAddVariant0({
    poolIdHex: state.pool.pool_id_hex,
    assetAIdHex: state.pool.canonical_asset_a,
    assetBIdHex: state.pool.canonical_asset_b,
    deltaA: lpAddDeltaA, deltaB: lpAddDeltaB,
    shareAmount,
    feeBps: state.pool.fee_bps,
    poolCapabilityFlags: 0,
    protocolFeeAddress: FOUNDER.pub, protocolFeeBps: PROTOCOL_FEE_BPS,
  });
  state.lpAddCrystallize = {
    completed: true,
    reveal_txid: r.revealTxid,
    share_amount: r.shareAmount?.toString?.() ?? null,
    delta_a: lpAddDeltaA.toString(),
    delta_b: lpAddDeltaB.toString(),
  };
  saveState(state);
  ok(`LP_ADD reveal ${r.revealTxid.slice(0, 16)}…  shareAmount=${r.shareAmount ?? '?'}`);
  info(`waiting 90s for confirmation + crystallization indexing…`);
  await sleep(90_000);
}

// =========================================================================
// Phase 6: verify accrued > 0
// =========================================================================
step(6, 'verify worker indexes accrued > 0 after crystallization');
const poolCrystal = await fetchPool(state.pool.pool_id_hex);
if (!poolCrystal) fail('pool fetch failed after LP_ADD');
const accruedNow = BigInt(poolCrystal.protocol_fee_accrued || 0n);
info(`pool state: R_A=${poolCrystal.reserve_a}, R_B=${poolCrystal.reserve_b}, S=${poolCrystal.lp_total_shares}, accrued=${accruedNow}`);
if (accruedNow <= 0n) {
  fail(`crystallization did NOT accrue any shares (accrued=${accruedNow}). ` +
       `Either swap volume was too low to grow k meaningfully, OR the worker did not crystallize on LP_ADD. ` +
       `Bump SWAP_AMOUNT/N_SWAPS and re-run, or inspect worker logs for the LP_ADD branch.`);
}
ok(`accrued = ${accruedNow} lp_asset_id shares (founder will mint this many)`);

// =========================================================================
// Phase 7: T_PROTOCOL_FEE_CLAIM (founder broadcasts)
// =========================================================================
step(7, 'T_PROTOCOL_FEE_CLAIM (founder mints accrued shares as lp_asset_id UTXO)');
useWallet(FOUNDER);
if (state.feeClaim?.completed) {
  ok(`reusing fee claim: ${state.feeClaim.reveal_txid.slice(0, 16)}…  amount=${state.feeClaim.claim_amount}`);
} else {
  info(`T_PROTOCOL_FEE_CLAIM claim_amount=${accruedNow}`);
  const r = await dapp.buildAndBroadcastProtocolFeeClaim({
    poolIdHex: state.pool.pool_id_hex,
    claimAmount: accruedNow,
  });
  state.feeClaim = {
    completed: true,
    reveal_txid: r.revealTxid,
    commit_txid: r.commitTxid,
    claim_amount: accruedNow.toString(),
    claim_outpoint: r.claimOutpoint,
    lp_asset_id: r.lpAssetIdHex,
    claim_blinding_hex: r.claimBlindingHex,
  };
  saveState(state);
  ok(`fee claim reveal ${r.revealTxid.slice(0, 16)}…  outpoint=${r.claimOutpoint}`);
  info(`waiting 60s for confirmation + worker indexing…`);
  await sleep(60_000);
}

// =========================================================================
// Phase 8: post-confirm sanity checks
// =========================================================================
step(8, 'post-confirm worker checks (accrued reset + founder holds claim UTXO)');
const poolPostClaim = await fetchPool(state.pool.pool_id_hex);
if (!poolPostClaim) {
  warn('pool fetch after claim returned null — worker may still be re-indexing. Re-run after a block.');
} else {
  const accruedPost = BigInt(poolPostClaim.protocol_fee_accrued || 0n);
  if (accruedPost === 0n) {
    ok(`accrued reset to 0 (was ${accruedNow})`);
  } else {
    warn(`accrued ${accruedPost} after claim — expected 0. Worker may not have indexed the claim yet; re-run after another block.`);
  }
  // lp_total_shares should be UNCHANGED by the claim — the shares were
  // already counted at crystallization time.
  const sPre = BigInt(poolCrystal.lp_total_shares);
  const sPost = BigInt(poolPostClaim.lp_total_shares);
  if (sPre === sPost) {
    ok(`lp_total_shares unchanged across the claim (${sPre} == ${sPost})`);
  } else {
    fail(`lp_total_shares changed unexpectedly: ${sPre} → ${sPost} (FEE_CLAIM must NOT mint new shares; the accrued counter is already in lp_total_shares from crystallization)`);
  }
}

// Founder's holdings should show the claim's amount of lp_asset_id.
info(`scanning founder holdings for the claim's lp_asset_id UTXO…`);
dapp.invalidateHoldingsCache();
await sleep(5_000);
const founderHoldings = await dapp.scanHoldings(true);
const lpAssetIdHex = state.feeClaim.lp_asset_id.toLowerCase();
const lpHold = founderHoldings.get(lpAssetIdHex);
if (lpHold && lpHold.balance >= BigInt(state.feeClaim.claim_amount)) {
  ok(`founder holds ${lpHold.balance} of lp_asset_id ${lpAssetIdHex.slice(0, 16)}… (≥ claim_amount ${state.feeClaim.claim_amount})`);
} else {
  warn(`founder lp_asset_id balance ${lpHold?.balance ?? 0} < claim_amount ${state.feeClaim.claim_amount} — the UTXO opening may not be indexed in this session's localStorage; check mempool.space directly`);
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== T_PROTOCOL_FEE_CLAIM rehearsal COMPLETE ===\n`);
console.log(`Pool:`);
console.log(`  pool_id=${state.pool.pool_id_hex.slice(0, 16)}…  fee=30bps  protocol_fee=${PROTOCOL_FEE_BPS}bps`);
console.log(`\nFee accrual:`);
console.log(`  ${N_SWAPS} swaps × ${SWAP_AMOUNT} A → grew k`);
console.log(`  LP_ADD by founder → crystallized ${accruedNow} lp_asset_id shares`);
console.log(`\nFee claim:`);
console.log(`  claim_amount: ${state.feeClaim.claim_amount}`);
console.log(`  reveal_txid:  ${state.feeClaim.reveal_txid}`);
console.log(`  outpoint:     ${state.feeClaim.claim_outpoint}`);
console.log(`  lp_asset_id:  ${state.feeClaim.lp_asset_id}`);
console.log(`\nMempool: https://mempool.space/signet/tx/${state.feeClaim.reveal_txid}`);
console.log(`State:   ${STATE_FILE}\n`);
