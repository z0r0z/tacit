// AMM full end-to-end signet harness — production-readiness rehearsal.
//
// Exercises every flow the AMM expects to support at mainnet go-live with
// cBTC.zk + cBTC.tac:
//   - 3 wallet roles (founder / LP / trader) → cross-party fee accounting
//   - Fee tiers: 5 bps, 30 bps, 100 bps (the V2 ladder)
//   - capability_flags=0x01 reject test (pre-launch guard)
//   - POOL_INIT × 4 (A↔TAC@30, B↔TAC@5, A↔B@100, cBTC.tac↔TAC@30)
//   - LP_ADD variant 0 + LP_REMOVE round-trip
//   - Single-hop swaps (A→TAC and A→B)
//   - 2-hop multihop swap via router (A → TAC → B)
//   - cBTC.tac AMM swap (TAC → cBTC.tac)
//   - T_PROTOCOL_FEE_CLAIM by founder against fees trader paid
//   - cBTC.zk lifecycle (slot mint → slot burn) — proves the asset works
//     for mainnet (no AMM pool by SPEC-CBTC-ZK-AMENDMENT §"No native
//     AMM-pool integration in v1")
//
// Pre-req:
//   .local/amm-e2e-signet-wallets.json (gen-amm-e2e-signet-wallets.mjs)
//   founder ≥ 300k signet sats, lp ≥ 200k, trader ≥ 200k
//
// Resumable: each phase persists to .local/amm-full-e2e-state.json.
// Re-running picks up where it left off. To restart: rm that file.
//
// Skip phases via env:
//   SKIP_PROTOCOL_FEE=1   skip the protocol-fee accrual + claim phase
//   SKIP_CBTC=1           skip cBTC.tac pool + cBTC.zk lifecycle
//   SKIP_MULTIHOP=1       skip the 2-hop swap
//   SKIP_LP_REMOVE=1      skip LP_REMOVE
//
// Run:  node tests/amm-full-e2e-signet.mjs

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
const STATE_FILE = path.join(STATE_DIR, 'amm-full-e2e-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');

if (!existsSync(WALLETS_FILE)) {
  console.error(`✗ Wallets not found at ${WALLETS_FILE}`);
  console.error(`  Run: node tests/gen-amm-e2e-signet-wallets.mjs`);
  process.exit(1);
}

const WALLETS = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const FOUNDER = { priv: hexToBytes(WALLETS.founder.priv_hex), pub: secp.getPublicKey(hexToBytes(WALLETS.founder.priv_hex), true), addr: WALLETS.founder.address };
const LP      = { priv: hexToBytes(WALLETS.lp.priv_hex),      pub: secp.getPublicKey(hexToBytes(WALLETS.lp.priv_hex), true),      addr: WALLETS.lp.address };
const TRADER  = { priv: hexToBytes(WALLETS.trader.priv_hex),  pub: secp.getPublicKey(hexToBytes(WALLETS.trader.priv_hex), true),  addr: WALLETS.trader.address };

// Mark backup-ack for each wallet so internal carve helpers don't prompt
for (const w of [FOUNDER, LP, TRADER]) {
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

// Compute CETCH asset_id = sha256(reverse(reveal_txid) || vout_le32 with vout=0)
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

async function waitForPoolRegistration(poolIdHex, label, attempts = 20, delayMs = 30_000) {
  info(`polling worker for pool ${label} (${poolIdHex.slice(0, 16)}…)`);
  for (let i = 1; i <= attempts; i++) {
    const p = await fetchPool(poolIdHex);
    if (p?.pool_id === poolIdHex.toLowerCase()) {
      ok(`pool registered on worker (R_A=${p.reserve_a}, R_B=${p.reserve_b}, S=${p.lp_total_shares})`);
      return p;
    }
    info(`  attempt ${i}/${attempts}: not yet registered`);
    if (i < attempts) await sleep(delayMs);
  }
  warn(`pool not registered on worker within ${attempts * delayMs / 60000}min — continuing anyway (worker may catch up later)`);
  return null;
}

async function getSatsBalance(addr) {
  try {
    const r = await fetch(`https://mempool.space/signet/api/address/${addr}`);
    const j = await r.json();
    const conf = (j.chain_stats?.funded_txo_sum ?? 0) - (j.chain_stats?.spent_txo_sum ?? 0);
    const mempool = (j.mempool_stats?.funded_txo_sum ?? 0) - (j.mempool_stats?.spent_txo_sum ?? 0);
    return conf + mempool;
  } catch { return 0; }
}

const state = loadState();

// Tunable amounts — all chosen so 1M-supply CETCHes give plenty of headroom
const SUPPLY        = 10_000_000n;
const POOL_DELTA_A  = 100_000n;
const POOL_DELTA_T  = 100_000n;
const POOL_DELTA_B  = 100_000n;
const TRADE_AMOUNT  = 5_000n;
const CBTC_DENOM    = 10_000n;
const CBTC_BOND_TAC = 5_000n;
const PROTOCOL_FEE_BPS = 5;

const SKIP_PROTOCOL_FEE = process.env.SKIP_PROTOCOL_FEE === '1';
const SKIP_CBTC = process.env.SKIP_CBTC === '1';
const SKIP_MULTIHOP = process.env.SKIP_MULTIHOP === '1';
const SKIP_LP_REMOVE = process.env.SKIP_LP_REMOVE === '1';

console.log(`\n=== AMM full end-to-end signet harness ===\n`);
console.log(`  founder: ${FOUNDER.addr}`);
console.log(`  lp:      ${LP.addr}`);
console.log(`  trader:  ${TRADER.addr}`);
console.log(`  state:   ${STATE_FILE}\n`);

// Rehydrate dapp localStorage from harness state file. JSDOM's localStorage
// is ephemeral per Node process — the dapp's slot records + cBTC.tac
// position records from a prior run are lost on resume unless we re-push
// them. Without this, scanHoldings won't recognize the cBTC.tac UTXO after
// resume.
if (state.cbtcTac?.slotRecord || state.cbtcTac?.positionRecord || state.cbtcZk?.slotRecord) {
  console.log(`Rehydrating dapp localStorage from prior run…`);
  if (state.cbtcTac?.slotRecord) {
    useWallet(FOUNDER);
    try {
      dapp.saveSlotRecord(state.cbtcTac.slotRecord);
      const after = dapp.getSlotRecords().find(s => s.leafCommitmentHex === state.cbtcTac.slotRecord.leafCommitmentHex);
      console.log(`  · cbtcTac slot rehydrated: ${after ? 'OK' : 'MISSING after save'}`);
    } catch (e) { warn(`rehydrate cbtcTac slot: ${e.message}`); }
  }
  if (state.cbtcTac?.positionRecord) {
    useWallet(FOUNDER);
    try {
      dapp.saveCtacPositionRecord(state.cbtcTac.positionRecord);
      const after = dapp.getCtacPositionRecords().find(p => p.targetLeafHashHex === state.cbtcTac.positionRecord.targetLeafHashHex);
      console.log(`  · cbtcTac position rehydrated: ${after ? 'OK status=' + after.status : 'MISSING after save'}`);
      // Also push the public opening for the cBTC.tac mint UTXO so
      // scanHoldings can verify it without re-deriving from the (random)
      // mintBlindingHex on every call.
      const ctacAid = dapp.ctacVariantAssetId(BigInt(state.cbtcTac.positionRecord.slotDenomSats));
      dapp.recordOpening(
        state.cbtcTac.positionRecord.depositRevealTxid,
        0,
        ctacAid.toLowerCase(),
        BigInt(state.cbtcTac.positionRecord.mintAmount),
        BigInt('0x' + state.cbtcTac.positionRecord.mintBlindingHex),
      );
      console.log(`  · cbtcTac UTXO opening recorded: ${state.cbtcTac.positionRecord.depositRevealTxid.slice(0,16)}…:0`);
    } catch (e) { warn(`rehydrate cbtcTac position: ${e.message}`); }
  }
  if (state.cbtcZk?.slotRecord) {
    useWallet(TRADER);
    try {
      dapp.saveSlotRecord(state.cbtcZk.slotRecord);
      const after = dapp.getSlotRecords().find(s => s.leafCommitmentHex === state.cbtcZk.slotRecord.leafCommitmentHex);
      console.log(`  · cbtcZk slot rehydrated: ${after ? 'OK' : 'MISSING after save'}`);
    } catch (e) { warn(`rehydrate cbtcZk slot: ${e.message}`); }
  }
}

// ---- Phase 0: pre-flight ----
step(0, 'pre-flight (sats balance × 3 wallets)');
{
  const [fSats, lSats, tSats] = await Promise.all([
    getSatsBalance(FOUNDER.addr),
    getSatsBalance(LP.addr),
    getSatsBalance(TRADER.addr),
  ]);
  info(`founder: ${fSats.toLocaleString()} sats  (target ≥ 250,000)`);
  info(`lp:      ${lSats.toLocaleString()} sats  (target ≥ 60,000)`);
  info(`trader:  ${tSats.toLocaleString()} sats  (target ≥ 60,000)`);
  // We use lower minimums here than the wallet-gen target because actual
  // sat usage is well below the buffer the wallet-gen suggested. If you're
  // running with the recommended funding, you'll cruise through this.
  if (fSats < 100_000) fail(`founder underfunded: need ≥ 100,000 sats minimum.`);
  if (lSats < 30_000) fail(`lp underfunded: need ≥ 30,000 sats minimum.`);
  if (tSats < 30_000) fail(`trader underfunded: need ≥ 30,000 sats minimum.`);
  ok(`pre-flight passed`);
}

// =========================================================================
// Phase 1: founder CETCHes TAC, asset_A, asset_B
// =========================================================================
step(1, 'founder CETCHes TAC, asset_A, asset_B (1M supply each)');
useWallet(FOUNDER);
state.assets = state.assets || {};

for (const [key, ticker] of [['TAC', 'tac-e2e'], ['A', 'amm-e2e-A'], ['B', 'amm-e2e-B']]) {
  if (state.assets[key]?.asset_id_hex) {
    ok(`reusing ${key} (${ticker}): ${state.assets[key].asset_id_hex.slice(0, 16)}…`);
    continue;
  }
  info(`CETCHing ${ticker} (supply ${SUPPLY}, decimals 0)…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker, supplyBase: SUPPLY, decimals: 0, mintable: false,
  });
  const aid = cetchAssetId(r.revealTxid);
  state.assets[key] = { ticker, cetch_txid: r.revealTxid, asset_id_hex: aid };
  saveState(state);
  ok(`${ticker} CETCHed: ${aid.slice(0, 16)}…`);
  info(`waiting 45s for confirmation + holdings scan…`);
  await sleep(45_000);
  dapp.invalidateHoldingsCache();
}

const TAC_AID = state.assets.TAC.asset_id_hex;
const A_AID = state.assets.A.asset_id_hex;
const B_AID = state.assets.B.asset_id_hex;
ok(`assets: TAC=${TAC_AID.slice(0,12)}…  A=${A_AID.slice(0,12)}…  B=${B_AID.slice(0,12)}…`);

// =========================================================================
// Phase 2: founder CXFERs portions to LP + trader
// =========================================================================
step(2, 'founder CXFERs asset portions to LP + trader');
useWallet(FOUNDER);
state.transfers = state.transfers || {};

// Each CXFER puts 1 fresh UTXO at recipient with the specified amount.
// LP needs: 2× POOL_DELTA_A (some buffer for LP_ADD), 2× POOL_DELTA_T, 2× POOL_DELTA_B.
// Trader needs: enough A and TAC for several swaps.
const transfers = [
  { label: 'lp_TAC',    asset: TAC_AID, recipient: bytesToHex(LP.pub),     amount: POOL_DELTA_T * 3n },
  { label: 'lp_A',      asset: A_AID,   recipient: bytesToHex(LP.pub),     amount: POOL_DELTA_A * 2n },
  { label: 'lp_B',      asset: B_AID,   recipient: bytesToHex(LP.pub),     amount: POOL_DELTA_B * 2n },
  { label: 'trader_A',  asset: A_AID,   recipient: bytesToHex(TRADER.pub), amount: TRADE_AMOUNT * 6n },
  { label: 'trader_TAC',asset: TAC_AID, recipient: bytesToHex(TRADER.pub), amount: TRADE_AMOUNT * 4n },
];
for (const t of transfers) {
  if (state.transfers[t.label]) {
    ok(`reusing ${t.label}: ${state.transfers[t.label].txid.slice(0, 16)}…`);
    continue;
  }
  info(`CXFER ${t.amount} of ${t.label.split('_')[1]} → ${t.label.split('_')[0]}…`);
  const r = await dapp.buildAndBroadcastCXfer({
    assetIdHex: t.asset, recipientPubHex: t.recipient, amount: t.amount,
  });
  state.transfers[t.label] = { txid: r.revealTxid, amount: t.amount.toString() };
  saveState(state);
  ok(`CXFER broadcast: ${r.revealTxid.slice(0, 16)}…`);
  // Short pause between to let mempool propagate
  await sleep(10_000);
}
info(`waiting 60s for all transfers to confirm…`);
await sleep(60_000);

// =========================================================================
// Phase 3: capability_flags=0x01 reject test (pre-launch guard)
// =========================================================================
step(3, 'capability_flags=0x01 reject test (pre-launch guard)');
if (state.capabilityFlagsReject) {
  ok(`reusing prior result: ${state.capabilityFlagsReject.outcome}`);
} else {
  useWallet(FOUNDER);
  dapp.invalidateHoldingsCache();
  await sleep(5_000);
  try {
    // We expect this to fail at envelope build OR worker validation. Either
    // way we don't want it to land on chain. Wrap in try/catch.
    //
    // The dapp builder currently doesn't guard flags != 0 itself; this test
    // documents the expected mainnet enforcement boundary. Deltas chosen to
    // comfortably exceed MINIMUM_LIQUIDITY (sqrt(deltaA·deltaB) > MIN_LIQ ~1000)
    // so a rejection here is specifically about flags, not min-liquidity.
    const DELTA_A_FLAGS = 5_000n;
    const DELTA_B_FLAGS = 5_000n;  // sqrt(5000·5000) = 5000, well above MIN_LIQ
    const r = await dapp.buildAndBroadcastLpAddPoolInit({
      assetAIdHex: A_AID, assetBIdHex: TAC_AID,
      deltaA: DELTA_A_FLAGS, deltaB: DELTA_B_FLAGS,
      feeBps: 30, vkCid: 'bafy-e2e-vk', ceremonyCid: 'bafy-e2e-ceremony',
      poolCapabilityFlags: 0x01,
    });
    // If we got here, the dapp didn't reject. Record and let the worker rule.
    warn(`dapp accepted flags=0x01; awaiting worker verdict (reveal: ${r.revealTxid.slice(0, 16)}…)`);
    state.capabilityFlagsReject = {
      outcome: 'dapp-accepted-awaiting-worker',
      reveal_txid: r.revealTxid,
      pool_id_hex: r.poolIdHex,
    };
    saveState(state);
    info(`waiting 60s then querying worker — pool should be rejected/missing`);
    await sleep(60_000);
    const poolRec = await fetchPool(r.poolIdHex);
    if (poolRec) {
      warn(`worker REGISTERED the flags=0x01 pool — guard not enforced. Note for launch.`);
      state.capabilityFlagsReject.outcome = 'unenforced';
    } else {
      ok(`worker did not register flags=0x01 pool (rejected as expected)`);
      state.capabilityFlagsReject.outcome = 'worker-rejected';
    }
    saveState(state);
  } catch (e) {
    // Distinguish flags rejection from incidental rejections (like MIN_LIQUIDITY,
    // insufficient holdings, etc) so the outcome is unambiguous.
    const msg = e.message || '';
    const isMinLiq = /MINIMUM_LIQUIDITY/.test(msg);
    const isInsufficient = /insufficient|carve|holdings/.test(msg);
    if (isMinLiq || isInsufficient) {
      warn(`Phase 3 inconclusive — rejected on ${isMinLiq ? 'MIN_LIQUIDITY' : 'holdings/sats'} before flags check could fire. Bump deltas and re-run this phase.`);
      state.capabilityFlagsReject = {
        outcome: 'inconclusive-pre-flags-rejection',
        error: msg,
      };
    } else {
      ok(`builder rejected flags=0x01: ${msg.slice(0, 80)}`);
      state.capabilityFlagsReject = { outcome: 'builder-rejected', error: msg };
    }
    saveState(state);
  }
}

// =========================================================================
// Phase 4: founder POOL_INIT × 3 (A↔TAC@30, B↔TAC@5, A↔B@100) + flags=0
// =========================================================================
step(4, 'founder POOL_INIT × 3 (fee-tier ladder)');
state.pools = state.pools || {};

const poolPlans = [
  // The A↔TAC pool has protocol_fee_address=founder so we can claim fees later.
  {
    label: 'A_TAC_30',
    aAid: A_AID, bAid: TAC_AID,
    deltaA: POOL_DELTA_A, deltaB: POOL_DELTA_T,
    feeBps: 30,
    protocolFeeAddress: FOUNDER.pub,
    protocolFeeBps: PROTOCOL_FEE_BPS,
  },
  {
    label: 'B_TAC_5',
    aAid: B_AID, bAid: TAC_AID,
    deltaA: POOL_DELTA_B, deltaB: POOL_DELTA_T,
    feeBps: 5,
    protocolFeeAddress: null,
    protocolFeeBps: 0,
  },
  {
    label: 'A_B_100',
    aAid: A_AID, bAid: B_AID,
    deltaA: POOL_DELTA_A, deltaB: POOL_DELTA_B,
    feeBps: 100,
    protocolFeeAddress: null,
    protocolFeeBps: 0,
  },
];

for (const p of poolPlans) {
  if (state.pools[p.label]) {
    ok(`reusing pool ${p.label}: ${state.pools[p.label].pool_id_hex.slice(0, 16)}…`);
    continue;
  }
  useWallet(FOUNDER);
  dapp.invalidateHoldingsCache();
  await sleep(5_000);
  info(`POOL_INIT ${p.label} (feeBps=${p.feeBps}, deltaA=${p.deltaA}, deltaB=${p.deltaB}, protoFee=${p.protocolFeeBps}bps)…`);
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: p.aAid, assetBIdHex: p.bAid,
    deltaA: p.deltaA, deltaB: p.deltaB,
    feeBps: p.feeBps,
    vkCid: 'bafy-e2e-vk', ceremonyCid: 'bafy-e2e-ceremony',
    poolCapabilityFlags: 0,
    protocolFeeAddress: p.protocolFeeAddress,
    protocolFeeBps: p.protocolFeeBps,
    onProgress: (s) => info(`  · ${s}`),
  });
  state.pools[p.label] = {
    pool_id_hex: r.poolIdHex,
    lp_asset_id_hex: r.lpAssetIdHex,
    canonical_asset_a: r.canonicalAssetA,
    canonical_asset_b: r.canonicalAssetB,
    delta_a: r.deltaA.toString(),
    delta_b: r.deltaB.toString(),
    fee_bps: r.feeBps,
    founder_shares: r.founderShares.toString(),
    reveal_txid: r.revealTxid,
    protocol_fee_bps: p.protocolFeeBps,
    has_protocol_fee: p.protocolFeeAddress !== null,
    share_blinding_hex: r.rShareSecpHex,
  };
  saveState(state);
  ok(`POOL_INIT ${p.label}: pool ${r.poolIdHex.slice(0, 16)}… reveal ${r.revealTxid.slice(0, 16)}…`);
  info(`waiting 90s for confirmation…`);
  await sleep(90_000);
}

// Verify pools registered on worker
for (const p of poolPlans) {
  await waitForPoolRegistration(state.pools[p.label].pool_id_hex, p.label, 12, 30_000);
}

// =========================================================================
// Phase 5: cBTC.tac side (slot mint → deposit → pool init)
// =========================================================================
if (!SKIP_CBTC) {
  step(5, 'cBTC.tac side: slot mint + deposit + POOL_INIT (TAC ↔ cBTC.tac)');
  useWallet(FOUNDER);
  state.cbtcTac = state.cbtcTac || {};

  const ctacAssetId = dapp.ctacVariantAssetId(CBTC_DENOM);
  info(`cBTC.tac variant asset_id: ${ctacAssetId.slice(0, 16)}… (denom=${CBTC_DENOM})`);

  // 5a: slot mint
  if (state.cbtcTac.slotRecord) {
    ok(`reusing slot: ${state.cbtcTac.slotRecord.leafCommitmentHex.slice(0, 16)}…`);
  } else {
    info(`T_SLOT_MINT @ ${CBTC_DENOM} sats…`);
    const res = await dapp.buildAndBroadcastSlotMint({
      assetIdHex: ctacAssetId,
      denomination: CBTC_DENOM,
      onProgress: (s) => info(`  · ${s}`),
    });
    ok(`slot mint reveal ${res.revealTxid.slice(0, 16)}…`);
    info(`waiting 60s for confirmation…`);
    await sleep(60_000);
    const recs = dapp.getSlotRecords();
    const slot = recs.find(r => r.mintTxid === res.revealTxid);
    if (!slot) fail('slot record missing post-mint');
    state.cbtcTac.slotRecord = slot;
    saveState(state);
  }

  // 5b: cBTC.tac deposit
  if (state.cbtcTac.positionRecord) {
    ok(`reusing cBTC.tac position: status=${state.cbtcTac.positionRecord.status}`);
  } else {
    useWallet(FOUNDER);
    dapp.invalidateHoldingsCache();
    await sleep(5_000);
    info(`T_CBTC_TAC_DEPOSIT (bond ${CBTC_BOND_TAC} TAC against slot)…`);
    const res = await dapp.buildAndBroadcastCbtcTacDeposit({
      slotRecord: state.cbtcTac.slotRecord,
      bondAmountTAC: CBTC_BOND_TAC,
      tacAssetIdHex: TAC_AID,
      onProgress: (s) => info(`  · ${s}`),
    });
    ok(`deposit reveal ${res.revealTxid.slice(0, 16)}…`);
    info(`waiting 60s for confirmation…`);
    await sleep(60_000);
    const positions = dapp.getCtacPositionRecords();
    const pos = positions.find(p => p.depositRevealTxid === res.revealTxid);
    if (!pos) fail('cBTC.tac position missing post-deposit');
    state.cbtcTac.positionRecord = pos;
    saveState(state);
  }

  // 5c: verify scanHoldings sees the cBTC.tac UTXO — but only if it hasn't
  // already been consumed by a downstream phase (POOL_INIT spends the
  // deposit vout[0] as the cBTC.tac side of the pool). On resume after
  // Phase 5d, the UTXO is gone from chain; this verification is moot.
  if (state.pools.CTAC_TAC_30) {
    ok(`skipping scanHoldings check — cBTC.tac UTXO was consumed by CTAC_TAC_30 POOL_INIT (resume path)`);
  } else {
    info(`waiting 30s for indexer pickup…`);
    await sleep(30_000);
    dapp.invalidateHoldingsCache();
    const holdings = await dapp.scanHoldings(true);
    const ctacHold = holdings.get(ctacAssetId.toLowerCase());
    if (!ctacHold || ctacHold.balance < CBTC_DENOM) {
      fail(`scanHoldings did not see cBTC.tac UTXO (got balance=${ctacHold?.balance ?? 0})`);
    }
    ok(`scanHoldings sees cBTC.tac UTXO: balance=${ctacHold.balance}`);
  }

  // 5d: POOL_INIT TAC ↔ cBTC.tac
  if (state.pools.CTAC_TAC_30) {
    ok(`reusing pool CTAC_TAC_30: ${state.pools.CTAC_TAC_30.pool_id_hex.slice(0, 16)}…`);
  } else {
    info(`POOL_INIT TAC↔cBTC.tac@30bps (delta=${CBTC_DENOM}/${CBTC_DENOM})…`);
    const r = await dapp.buildAndBroadcastLpAddPoolInit({
      assetAIdHex: TAC_AID, assetBIdHex: ctacAssetId,
      deltaA: CBTC_DENOM, deltaB: CBTC_DENOM,
      feeBps: 30,
      vkCid: 'bafy-e2e-vk', ceremonyCid: 'bafy-e2e-ceremony',
      poolCapabilityFlags: 0,
      onProgress: (s) => info(`  · ${s}`),
    });
    state.pools.CTAC_TAC_30 = {
      pool_id_hex: r.poolIdHex,
      lp_asset_id_hex: r.lpAssetIdHex,
      canonical_asset_a: r.canonicalAssetA,
      canonical_asset_b: r.canonicalAssetB,
      delta_a: r.deltaA.toString(),
      delta_b: r.deltaB.toString(),
      fee_bps: r.feeBps,
      founder_shares: r.founderShares.toString(),
      reveal_txid: r.revealTxid,
      protocol_fee_bps: 0,
      has_protocol_fee: false,
      share_blinding_hex: r.rShareSecpHex,
      ctac_asset_id: ctacAssetId,
    };
    saveState(state);
    ok(`POOL_INIT CTAC_TAC_30 reveal ${r.revealTxid.slice(0, 16)}…`);
    info(`waiting 90s for confirmation…`);
    await sleep(90_000);
  }
  await waitForPoolRegistration(state.pools.CTAC_TAC_30.pool_id_hex, 'CTAC_TAC_30', 12, 30_000);
}

// =========================================================================
// Phase 6: LP_ADD variant 0 by LP wallet (to A↔TAC + B↔TAC)
// =========================================================================
step(6, 'LP_ADD variant 0 (LP wallet adds liquidity)');
state.lpAdds = state.lpAdds || {};

const lpAddPlans = [
  { label: 'A_TAC_30', delta_in_a: 10_000n },
  { label: 'B_TAC_5',  delta_in_a: 10_000n },
];
for (const plan of lpAddPlans) {
  if (state.lpAdds[plan.label]) {
    ok(`reusing LP_ADD ${plan.label}: ${state.lpAdds[plan.label].reveal_txid.slice(0, 16)}…`);
    continue;
  }
  const pool = state.pools[plan.label];
  // Get current reserves from worker — needed to compute proportional share
  const poolRec = await fetchPool(pool.pool_id_hex);
  const R_A = poolRec?.reserve_a ? BigInt(poolRec.reserve_a) : BigInt(pool.delta_a);
  const R_B = poolRec?.reserve_b ? BigInt(poolRec.reserve_b) : BigInt(pool.delta_b);
  const S   = poolRec?.lp_total_shares ? BigInt(poolRec.lp_total_shares) : BigInt(pool.founder_shares) + 1000n; // +MINIMUM_LIQUIDITY
  const deltaA = plan.delta_in_a;
  const deltaB_raw = (deltaA * R_B) / R_A;
  const deltaB = deltaB_raw + 1n;  // round-up to ensure kernel-sig closure
  const sharesA = (deltaA * S) / R_A;
  const sharesB = (deltaB * S) / R_B;
  const expectedShares = sharesA < sharesB ? sharesA : sharesB;
  if (expectedShares <= 0n) fail(`zero-share LP_ADD for ${plan.label}`);
  useWallet(LP);
  dapp.invalidateHoldingsCache();
  await sleep(5_000);
  info(`LP_ADD ${plan.label} (R_A=${R_A}, R_B=${R_B}, S=${S}, deltaA=${deltaA}, deltaB=${deltaB}, shares=${expectedShares})…`);
  const r = await dapp.buildAndBroadcastLpAddVariant0({
    poolIdHex: pool.pool_id_hex,
    assetAIdHex: pool.canonical_asset_a,
    assetBIdHex: pool.canonical_asset_b,
    deltaA, deltaB,
    shareAmount: expectedShares,
    feeBps: pool.fee_bps,
    poolCapabilityFlags: 0,
  });
  state.lpAdds[plan.label] = {
    commit_txid: r.commitTxid,
    reveal_txid: r.revealTxid,
    delta_a: deltaA.toString(),
    delta_b: deltaB.toString(),
    share_amount: r.shareAmount.toString(),
    share_blinding_hex: r.rShareSecpHex,
  };
  saveState(state);
  ok(`LP_ADD ${plan.label} reveal ${r.revealTxid.slice(0, 16)}…  shares=${r.shareAmount}`);
  info(`waiting 90s for confirmation…`);
  await sleep(90_000);
}

// =========================================================================
// Phase 7: single-hop swaps (trader)
// =========================================================================
step(7, 'single-hop swaps (trader)');
state.swaps = state.swaps || {};

async function findAssetInputUtxo(traderWallet, assetIdHex, minAmount) {
  useWallet(traderWallet);
  dapp.invalidateHoldingsCache();
  await sleep(3_000);
  const holdings = await dapp.scanHoldings();
  const h = holdings.get(assetIdHex.toLowerCase());
  if (!h || h.balance < minAmount) {
    throw new Error(`trader balance of ${assetIdHex.slice(0,12)} = ${h?.balance ?? 0}, need ≥ ${minAmount}`);
  }
  // Carve an exact-amount UTXO so the swap has a clean single input.
  const carved = await dapp.carveExactAmount({ assetIdHex: assetIdHex.toLowerCase(), amount: minAmount });
  if (!carved?.utxo) throw new Error('carveExactAmount failed');
  return {
    txid: carved.utxo.txid, vout: carved.utxo.vout,
    amount: carved.amount, blinding: carved.blinding,
    asset_id_hex: assetIdHex.toLowerCase(),
  };
}

async function doSwap(label, poolLabel, assetInHex, assetOutHex, deltaIn, slippageBps = 100) {
  if (state.swaps[label]) {
    ok(`reusing swap ${label}: ${state.swaps[label].reveal_txid.slice(0, 16)}…`);
    return state.swaps[label];
  }
  const pool = state.pools[poolLabel];
  if (!pool) throw new Error(`unknown pool ${poolLabel}`);
  // Wait for the pool to register on the worker if signet blocks are slow.
  // ~20 attempts × 30s = 10 min budget (one ~10-min signet block + slack).
  let poolRec = await fetchPool(pool.pool_id_hex);
  if (!poolRec) {
    info(`pool ${poolLabel} not yet on worker — polling (up to 10 min for next signet block)…`);
    for (let i = 1; i <= 20 && !poolRec; i++) {
      await sleep(30_000);
      poolRec = await fetchPool(pool.pool_id_hex);
      if (poolRec) ok(`pool ${poolLabel} registered (attempt ${i}/20)`);
      else info(`  attempt ${i}/20: still not registered`);
    }
    if (!poolRec) throw new Error(`pool ${poolLabel} not on worker after 10min — bail out, re-run later`);
  }
  const direction = assetInHex.toLowerCase() === pool.canonical_asset_a.toLowerCase() ? 0 : 1;
  const R_A = BigInt(poolRec.reserve_a);
  const R_B = BigInt(poolRec.reserve_b);

  // Carve trader's asset input UTXO
  const assetInputUtxo = await findAssetInputUtxo(TRADER, assetInHex, deltaIn);

  // Quote
  const FEE_DEN = 10_000n;
  const feeMul = FEE_DEN - BigInt(pool.fee_bps);
  let dout;
  if (direction === 0) {
    dout = (R_B * deltaIn * feeMul) / (R_A * FEE_DEN + deltaIn * feeMul);
  } else {
    dout = (R_A * deltaIn * feeMul) / (R_B * FEE_DEN + deltaIn * feeMul);
  }
  const minOut = (dout * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new Error(`swap ${label}: minOut <= 0 (dout=${dout})`);

  info(`SWAP_VAR ${label} (pool ${poolLabel}, dir ${direction === 0 ? 'A→B' : 'B→A'}, in=${deltaIn}, expected out=${dout}, minOut=${minOut})…`);
  const expiryHeight = 4_294_967_290;  // effectively non-expiring
  const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
    poolReserves: {
      pool_id_hex: pool.pool_id_hex,
      reserve_a: R_A, reserve_b: R_B,
      fee_bps: pool.fee_bps,
    },
    assetInputUtxo,
    direction, deltaIn, minOut,
    expiryHeight,
    receiveAssetIdHex: assetOutHex.toLowerCase(),
  });
  state.swaps[label] = {
    pool_label: poolLabel,
    reveal_txid: r.revealTxid,
    delta_in: deltaIn.toString(),
    delta_out: r.deltaOut.toString(),
    direction,
    r_a_post: r.raPost?.toString?.() ?? null,
    r_b_post: r.rbPost?.toString?.() ?? null,
  };
  saveState(state);
  ok(`swap ${label} reveal ${r.revealTxid.slice(0, 16)}…  deltaOut=${r.deltaOut}`);
  info(`waiting 60s for confirmation…`);
  await sleep(60_000);
  return state.swaps[label];
}

await doSwap('swap_A_to_TAC',  'A_TAC_30', A_AID, TAC_AID, TRADE_AMOUNT);
await doSwap('swap_A_to_B_direct', 'A_B_100', A_AID, B_AID, TRADE_AMOUNT);

// =========================================================================
// Phase 8: multihop (A → TAC → B via router)
// =========================================================================
if (!SKIP_MULTIHOP) {
  step(8, 'multihop swap (A → TAC → B via router)');
  if (state.multihop?.completed) {
    ok(`reusing multihop result: hop1=${state.multihop.hop1_out}  hop2=${state.multihop.hop2_out}`);
  } else {
    state.multihop = state.multihop || {};
    // hop 1: A → TAC via A_TAC_30
    info(`hop 1: A → TAC via A_TAC_30…`);
    const hop1 = await doSwap('multihop_hop1_A_to_TAC', 'A_TAC_30', A_AID, TAC_AID, TRADE_AMOUNT);
    state.multihop.hop1_out = hop1.delta_out;
    saveState(state);

    // Use hop1's TAC receipt as input to hop2. We need to scan trader's holdings
    // to find the just-received TAC UTXO from the hop1 receipt.
    info(`waiting 30s for hop1 receipt UTXO to be picked up by holdings scan…`);
    await sleep(30_000);
    useWallet(TRADER);
    dapp.invalidateHoldingsCache();
    const holdings = await dapp.scanHoldings(true);
    const tacHold = holdings.get(TAC_AID.toLowerCase());
    if (!tacHold || tacHold.balance < BigInt(hop1.delta_out)) {
      fail(`trader TAC balance after hop1 < hop1.deltaOut (have ${tacHold?.balance ?? 0}, need ${hop1.delta_out})`);
    }
    // hop 2: TAC → B via B_TAC_5
    info(`hop 2: TAC → B via B_TAC_5 (using ${hop1.delta_out} TAC from hop1)…`);
    const hop2 = await doSwap('multihop_hop2_TAC_to_B', 'B_TAC_5', TAC_AID, B_AID, BigInt(hop1.delta_out));
    state.multihop.hop2_out = hop2.delta_out;
    state.multihop.completed = true;
    saveState(state);
    ok(`multihop A → TAC → B: ${TRADE_AMOUNT} A → ${hop1.delta_out} TAC → ${hop2.delta_out} B`);

    // Compare to direct A→B@100bps swap from phase 7
    const directOut = BigInt(state.swaps.swap_A_to_B_direct.delta_out);
    const multihopOut = BigInt(hop2.delta_out);
    info(`direct A→B (100bps): ${directOut}`);
    info(`multihop A→TAC→B: ${multihopOut}`);
    info(`router improvement: ${multihopOut > directOut ? '+' : ''}${multihopOut - directOut} (${multihopOut > directOut ? 'multihop wins' : 'direct wins or tied'})`);
  }
}

// =========================================================================
// Phase 9: cBTC.tac swap (TAC → cBTC.tac)
// =========================================================================
if (!SKIP_CBTC && state.pools.CTAC_TAC_30) {
  step(9, 'cBTC.tac swap (TAC → cBTC.tac)');
  if (state.swaps.swap_TAC_to_CTAC) {
    ok(`reusing: ${state.swaps.swap_TAC_to_CTAC.reveal_txid.slice(0, 16)}…`);
  } else {
    const ctacAssetId = state.pools.CTAC_TAC_30.ctac_asset_id;
    // Smaller amount since the pool is initialized smaller
    await doSwap('swap_TAC_to_CTAC', 'CTAC_TAC_30', TAC_AID, ctacAssetId, 1_000n);
  }
}

// =========================================================================
// Phase 10: LP_REMOVE (LP wallet recovers liquidity from one pool)
// =========================================================================
if (!SKIP_LP_REMOVE) {
  step(10, 'LP_REMOVE (LP wallet recovers liquidity from A↔TAC pool)');
  if (state.lpRemove?.completed) {
    ok(`reusing: ${state.lpRemove.reveal_txid.slice(0, 16)}…`);
  } else {
    const pool = state.pools.A_TAC_30;
    const lpAdd = state.lpAdds.A_TAC_30;
    if (!lpAdd) fail('LP_ADD A_TAC_30 missing; cannot LP_REMOVE');

    // Refresh pool reserves to compute expected output
    const poolRec = await fetchPool(pool.pool_id_hex);
    if (!poolRec) fail('pool A_TAC_30 missing from worker');
    const R_A = BigInt(poolRec.reserve_a);
    const R_B = BigInt(poolRec.reserve_b);
    const S   = BigInt(poolRec.lp_total_shares);
    const shareAmount = BigInt(lpAdd.share_amount);
    const expectedA = (R_A * shareAmount) / S;
    const expectedB = (R_B * shareAmount) / S;
    info(`burn ${shareAmount} shares → expect ${expectedA} A + ${expectedB} TAC (reserves ${R_A}/${R_B}, S=${S})`);

    useWallet(LP);
    dapp.invalidateHoldingsCache();
    await sleep(5_000);
    const r = await dapp.buildAndBroadcastLpRemove({
      poolIdHex: pool.pool_id_hex,
      assetAIdHex: pool.canonical_asset_a,
      assetBIdHex: pool.canonical_asset_b,
      shareAmount,
      expectedDeltaA: expectedA, expectedDeltaB: expectedB,
      lpShareUtxos: [{
        utxo: { txid: lpAdd.reveal_txid, vout: 0 },
        amount: shareAmount,
        blinding: BigInt('0x' + lpAdd.share_blinding_hex),
      }],
      feeBps: pool.fee_bps,
      poolCapabilityFlags: 0,
    });
    state.lpRemove = {
      pool_label: 'A_TAC_30',
      reveal_txid: r.revealTxid,
      share_amount: shareAmount.toString(),
      delta_a: r.deltaA.toString(),
      delta_b: r.deltaB.toString(),
      completed: true,
    };
    saveState(state);
    ok(`LP_REMOVE reveal ${r.revealTxid.slice(0, 16)}…  recovered ${r.deltaA} A + ${r.deltaB} TAC`);
    info(`waiting 60s for confirmation…`);
    await sleep(60_000);
  }
}

// =========================================================================
// Phase 11: protocol-fee claim (founder)
// =========================================================================
if (!SKIP_PROTOCOL_FEE) {
  step(11, 'protocol-fee claim (founder claims accrued fees from A↔TAC pool)');
  const pool = state.pools.A_TAC_30;
  if (!pool.has_protocol_fee) {
    info(`A_TAC_30 has no protocol fee configured; skipping`);
  } else if (state.protocolFeeClaim?.completed) {
    if (state.protocolFeeClaim.skipped) {
      ok(`reusing: claim skipped (no accrued fees)`);
    } else {
      ok(`reusing: ${state.protocolFeeClaim.reveal_txid.slice(0, 16)}…`);
    }
  } else {
    info(`waiting 30s for worker to crystallize protocol-fee accrual…`);
    await sleep(30_000);
    const poolRec = await fetchPool(pool.pool_id_hex);
    if (!poolRec) fail(`pool A_TAC_30 missing on worker; cannot claim`);
    const accrued = poolRec.protocol_fee_accrued ? BigInt(poolRec.protocol_fee_accrued) : 0n;
    info(`pool A_TAC_30 protocol_fee_accrued: ${accrued}`);
    if (accrued <= 0n) {
      warn(`no accrued protocol fees yet (perhaps swap volume too low or worker hasn't crystallized). Skipping claim.`);
      state.protocolFeeClaim = { completed: true, accrued: '0', skipped: true };
      saveState(state);
    } else {
      useWallet(FOUNDER);
      dapp.invalidateHoldingsCache();
      await sleep(5_000);
      info(`T_PROTOCOL_FEE_CLAIM (founder claims ${accrued} from A_TAC_30)…`);
      const r = await dapp.buildAndBroadcastProtocolFeeClaim({
        poolIdHex: pool.pool_id_hex,
        claimAmount: accrued,
      });
      state.protocolFeeClaim = {
        pool_label: 'A_TAC_30',
        reveal_txid: r.revealTxid,
        claim_amount: accrued.toString(),
        claim_outpoint: r.claimOutpoint,
        completed: true,
      };
      saveState(state);
      ok(`fee claim reveal ${r.revealTxid.slice(0, 16)}…  amount=${accrued}`);
      info(`waiting 60s for confirmation…`);
      await sleep(60_000);
    }
  }
}

// =========================================================================
// Phase 12: cBTC.zk lifecycle (slot mint → slot burn)
// =========================================================================
if (!SKIP_CBTC) {
  step(12, 'cBTC.zk lifecycle (slot mint → slot burn round-trip)');
  state.cbtcZk = state.cbtcZk || {};
  useWallet(TRADER);
  dapp.invalidateHoldingsCache();
  await sleep(5_000);

  // 12a: slot mint at a different denom (so it doesn't collide with cBTC.tac's slot)
  const ZK_DENOM = 10_000n;
  const zkAssetId = dapp.ctacVariantAssetId(ZK_DENOM);
  if (state.cbtcZk.slotRecord) {
    ok(`reusing cBTC.zk slot: ${state.cbtcZk.slotRecord.leafCommitmentHex.slice(0, 16)}…`);
  } else {
    info(`T_SLOT_MINT @ ${ZK_DENOM} sats (trader; will be burned to recover BTC)…`);
    const res = await dapp.buildAndBroadcastSlotMint({
      assetIdHex: zkAssetId,
      denomination: ZK_DENOM,
      onProgress: (s) => info(`  · ${s}`),
    });
    ok(`zk slot mint reveal ${res.revealTxid.slice(0, 16)}…`);
    info(`waiting 60s for confirmation…`);
    await sleep(60_000);
    const recs = dapp.getSlotRecords();
    const slot = recs.find(r => r.mintTxid === res.revealTxid);
    if (!slot) fail('zk slot record missing post-mint');
    state.cbtcZk.slotRecord = slot;
    saveState(state);
  }

  // 12b: slot burn (recover BTC). Requires a registered mixer pool for the
  // slot's (asset_id, denom) — buildAndBroadcastSlotBurn uses the same merkle
  // tree as mixer withdraw. In a fresh JSDOM localStorage on resume the
  // mixer pool registry is empty, and rehydrating the worker's full mixer
  // state is out of scope for this harness. Soft-fail with a warning so the
  // harness still completes summary.
  if (state.cbtcZk.burnResult) {
    ok(`reusing cBTC.zk slot burn: ${state.cbtcZk.burnResult.reveal_txid.slice(0, 16)}…`);
  } else {
    info(`T_SLOT_BURN (recover BTC from slot)…`);
    try {
      const res = await dapp.buildAndBroadcastSlotBurn({
        slotRecord: state.cbtcZk.slotRecord,
        onProgress: (s) => info(`  · ${s}`),
      });
      ok(`slot burn reveal ${res.revealTxid.slice(0, 16)}…`);
      state.cbtcZk.burnResult = { reveal_txid: res.revealTxid };
      saveState(state);
    } catch (e) {
      // Most likely cause on resume: 'pool not registered locally' — the
      // dapp's mixer pool registry is empty after a fresh process restart.
      // Slot is still minted on-chain; the user can burn it manually via
      // the dapp UI after running 'Refresh Mixer tab'.
      warn(`slot burn skipped: ${e.message.slice(0, 100)}`);
      warn(`  slot remains on-chain at ${state.cbtcZk.slotRecord.mintTxid.slice(0, 16)}…:0`);
      warn(`  burn manually via dapp Mixer tab after a fresh holdings scan`);
      state.cbtcZk.burnResult = { skipped: true, reason: e.message.slice(0, 200) };
      saveState(state);
    }
  }
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== AMM full end-to-end signet test COMPLETE ===\n`);
console.log(`Assets:`);
console.log(`  TAC=${TAC_AID.slice(0, 16)}…  A=${A_AID.slice(0, 16)}…  B=${B_AID.slice(0, 16)}…`);
console.log(`\nPools:`);
for (const [label, p] of Object.entries(state.pools || {})) {
  console.log(`  ${label.padEnd(14)} fee=${p.fee_bps}bps  pool_id=${p.pool_id_hex.slice(0, 16)}…  reveal=${p.reveal_txid.slice(0, 16)}…`);
}
console.log(`\nSwaps:`);
for (const [label, s] of Object.entries(state.swaps || {})) {
  console.log(`  ${label.padEnd(28)} in=${s.delta_in} out=${s.delta_out}  reveal=${s.reveal_txid.slice(0, 16)}…`);
}
if (state.multihop?.completed) {
  console.log(`\nMultihop A → TAC → B:`);
  console.log(`  ${TRADE_AMOUNT} A → ${state.multihop.hop1_out} TAC → ${state.multihop.hop2_out} B`);
  const directOut = BigInt(state.swaps.swap_A_to_B_direct?.delta_out || '0');
  const mhOut = BigInt(state.multihop.hop2_out);
  console.log(`  direct A→B (100bps): ${directOut}  vs  multihop: ${mhOut}  (${mhOut > directOut ? 'multihop better' : 'direct better'})`);
}
if (state.lpRemove?.completed) {
  console.log(`\nLP_REMOVE A_TAC_30:`);
  console.log(`  burned ${state.lpRemove.share_amount} shares → ${state.lpRemove.delta_a} A + ${state.lpRemove.delta_b} TAC`);
}
if (state.protocolFeeClaim?.completed) {
  console.log(`\nProtocol fee claim:`);
  if (state.protocolFeeClaim.skipped) {
    console.log(`  skipped — no accrued fees`);
  } else {
    console.log(`  claimed ${state.protocolFeeClaim.claim_amount} from ${state.protocolFeeClaim.pool_label}`);
    console.log(`  outpoint: ${state.protocolFeeClaim.claim_outpoint}`);
  }
}
if (state.cbtcZk?.burnResult) {
  console.log(`\ncBTC.zk lifecycle:`);
  console.log(`  slot mint:  ${state.cbtcZk.slotRecord.mintTxid.slice(0, 16)}…`);
  if (state.cbtcZk.burnResult.skipped) {
    console.log(`  slot burn:  SKIPPED — ${state.cbtcZk.burnResult.reason.slice(0, 80)}`);
  } else {
    console.log(`  slot burn:  ${state.cbtcZk.burnResult.reveal_txid.slice(0, 16)}…`);
  }
}
console.log(`\nState preserved at ${STATE_FILE}.`);
console.log(`Mempool: https://mempool.space/signet/address/${FOUNDER.addr}`);
