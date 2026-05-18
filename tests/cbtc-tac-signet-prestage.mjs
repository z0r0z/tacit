// Multi-phase pre-staging driver for the cBTC.tac signet rehearsal.
//
// Phases (resumable via .local/cbtc-tac-prestage-state.json):
//   1. CETCH TACO (the TAC-side asset)
//   2. CETCH WAGMI (the cBTC.zk-side asset — slot mints against this)
//   3. Mint a cBTC.zk slot against WAGMI (1 BTC tier = 100M sats)
//   4. POOL_INIT (T_LP_ADD variant 1) on (WAGMI, TACO) with raw asset inputs
//   5. T_CBTC_TAC_DEPOSIT_ATOMIC — LP + cBTC.tac mint in one tx
//   6. T_CBTC_TAC_WITHDRAW_ATOMIC — close position, full exit
//
// Each phase saves state after broadcast + waits for confirmation.
// Resumable: kill+restart picks up from the last confirmed phase.

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) try { globalThis.crypto = dom.window.crypto; } catch {}
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-prestage-state.json');
const WALLETS    = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function step(n, msg) { console.log(`\n=== Phase ${n}: ${msg} ===`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForConfirmation(txid, label, maxMin = 30) {
  const start = Date.now();
  let lastReport = 0;
  while (true) {
    const elapsedMin = (Date.now() - start) / 60_000;
    if (elapsedMin > maxMin) fail(`timeout waiting for ${label}`);
    try {
      const r = await fetch(`https://mempool.space/signet/api/tx/${txid}/status`);
      if (r.ok) {
        const s = await r.json();
        if (s.confirmed) {
          ok(`${label} confirmed at block ${s.block_height} (${elapsedMin.toFixed(1)}min)`);
          return s;
        }
      }
    } catch {}
    if (elapsedMin - lastReport >= 0.5) {
      info(`waiting for ${label}… (${elapsedMin.toFixed(1)}min)`);
      lastReport = elapsedMin;
    }
    await sleep(15_000);
  }
}

const wallets = JSON.parse(readFileSync(WALLETS, 'utf8'));
const DEP_SK = hexToBytes(wallets.depositor.priv_hex);
const DEP_PUB = hexToBytes(wallets.depositor.pub_hex);
const DEP_ADDR = wallets.depositor.address;
const state = loadState();

dapp.wallet.priv = DEP_SK;
dapp.wallet.pub = DEP_PUB;
// Pre-ack the burner-backup gate (we own the key file directly; the JSDOM
// modal can't render). Same for sats-funded gate (we verified balance above).
const ackKey = 'tacit-backup-ack-v1:' + bytesToHex(DEP_PUB);
globalThis.localStorage.setItem(ackKey, '1');
ok(`wallet: ${DEP_ADDR}`);
async function balanceSats() {
  const r = await fetch(`https://mempool.space/signet/api/address/${DEP_ADDR}`);
  const j = await r.json();
  return (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum)
    + (j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum);
}
info(`balance: ${(await balanceSats()).toLocaleString()} sats`);

// ============ Phase 1: CETCH TACO ============
if (!state.tacoAssetIdHex) {
  step(1, 'CETCH TACO (TAC-side stand-in, 10B base units)');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'TACO', supplyBase: 10_000_000_000n, decimals: 8, mintable: false,
    onProgress: (s) => info(s),
  });
  state.tacoCetchTxid = r.revealTxid;
  state.tacoAssetIdHex = r.assetIdHex;
  saveState(state);
  ok(`TACO CETCH broadcast: ${r.revealTxid}`);
  await waitForConfirmation(r.revealTxid, 'TACO CETCH');
}
ok(`Phase 1: TACO asset_id ${state.tacoAssetIdHex}`);
globalThis.TAC_ASSET_ID_HEX = state.tacoAssetIdHex;

// ============ Phase 2: CETCH WAGMI ============
if (!state.wagmiAssetIdHex) {
  step(2, 'CETCH WAGMI (cBTC.zk-side stand-in, 100B base units for slot minting)');
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'WAGMI', supplyBase: 100_000_000_000n, decimals: 8, mintable: false,
    onProgress: (s) => info(s),
  });
  state.wagmiCetchTxid = r.revealTxid;
  state.wagmiAssetIdHex = r.assetIdHex;
  saveState(state);
  ok(`WAGMI CETCH broadcast: ${r.revealTxid}`);
  await waitForConfirmation(r.revealTxid, 'WAGMI CETCH');
}
ok(`Phase 2: WAGMI asset_id ${state.wagmiAssetIdHex}`);

// ============ Phase 3: Mint cBTC.zk slot against WAGMI ============
if (!state.slotLeafHashHex) {
  step(3, 'mint cBTC.zk slot (against WAGMI, 500k sats = 0.005 BTC test tier — fits signet wallet budget)');
  const r = await dapp.buildAndBroadcastSlotMint({
    assetIdHex: state.wagmiAssetIdHex,
    denomination: 500_000n,
    onProgress: (s) => info(s),
  });
  state.slotMintTxid = r.revealTxid || r.commitTxid;
  state.slotLeafHashHex = r.slotRecord?.leafCommitmentHex || r.leafCommitmentHex;
  // Persist full slot record — needed by later phases (atomic deposit reads
  // mintTxid + k_btc_xonly + asset_id; atomic withdraw needs r_btc + r_pedersen).
  const fullSlot = (dapp.getSlotRecords ? dapp.getSlotRecords() : []).find(
    s => s.leafCommitmentHex === state.slotLeafHashHex
  );
  if (fullSlot) state.slotRecord = fullSlot;
  saveState(state);
  ok(`SLOT_MINT broadcast: ${state.slotMintTxid}`);
  await waitForConfirmation(state.slotMintTxid, 'SLOT_MINT');
}
// Re-inject the slot record into localStorage on every script run so later
// phases that look it up via dapp.getSlotRecords() can find it.
if (state.slotRecord && (!dapp.getSlotRecords || !dapp.getSlotRecords().find(s => s.leafCommitmentHex === state.slotLeafHashHex))) {
  try {
    const existing = JSON.parse(globalThis.localStorage.getItem('tacit-slot-records-v1:signet') || '[]');
    if (!existing.find(s => s.leafCommitmentHex === state.slotLeafHashHex)) {
      existing.push(state.slotRecord);
      globalThis.localStorage.setItem('tacit-slot-records-v1:signet', JSON.stringify(existing));
    }
  } catch (e) { info(`slot record re-inject failed: ${e?.message || e}`); }
}
ok(`Phase 3: slot leaf ${state.slotLeafHashHex}`);

// ============ Phase 4: POOL_INIT (WAGMI, TACO) ============
if (!state.poolIdHex) {
  step(4, 'POOL_INIT (WAGMI, TACO) with raw asset inputs');
  // Pool with 1B WAGMI + 1B TACO initial liquidity. Equal sides means
  // implied 1:1 ratio. LP share value will be roughly average of both.
  const r = await dapp.buildAndBroadcastLpAddPoolInit({
    assetAIdHex: state.wagmiAssetIdHex,
    assetBIdHex: state.tacoAssetIdHex,
    deltaA: 1_000_000_000n,
    deltaB: 1_000_000_000n,
    feeBps: 30,
    vkCid: 'test-amm-vk-cid-signet-rehearsal',
    ceremonyCid: 'test-ceremony-cid-signet-rehearsal',
    onProgress: (s) => info(s),
  });
  state.poolInitCommitTxid = r.commitTxid;
  state.poolInitTxid = r.revealTxid;
  state.poolIdHex = r.poolIdHex;
  state.lpAssetIdHex = r.lpAssetIdHex;
  state.founderSharesAmount = r.founderShares?.toString();
  saveState(state);
  ok(`POOL_INIT broadcast: ${r.revealTxid}`);
  ok(`pool_id: ${r.poolIdHex}`);
  await waitForConfirmation(r.revealTxid, 'POOL_INIT');
}
ok(`Phase 4: pool ${state.poolIdHex}`);

// ============ Phase 5: T_CBTC_TAC_DEPOSIT_ATOMIC ============
if (!state.atomicDepositTxid) {
  step(5, 'T_CBTC_TAC_DEPOSIT_ATOMIC (cBTC.zk + TAC inputs → LP + cBTC.tac mint)');
  // Refresh holdings — we need a WAGMI UTXO + TACO UTXO that don't include
  // the ones already consumed by POOL_INIT.
  dapp.invalidateHoldingsCache();
  const holdings = await dapp.scanHoldings();
  const wagmi = holdings.get(state.wagmiAssetIdHex);
  const taco = holdings.get(state.tacoAssetIdHex);
  if (!wagmi || !wagmi.utxos?.length) fail('no WAGMI UTXOs available for atomic deposit');
  if (!taco || !taco.utxos?.length) fail('no TACO UTXOs available for atomic deposit');
  // holdings shape: { utxo: {txid, vout, ...}, amount, blinding, commitment }
  // blinding is BigInt-or-hex per dapp/tacit.js:13371 — builder wants hex.
  const toHex = (b) => typeof b === 'bigint' ? b.toString(16).padStart(64, '0') : String(b);
  const cbtcZkInput = {
    utxo: { txid: wagmi.utxos[0].utxo.txid, vout: wagmi.utxos[0].utxo.vout },
    amount: wagmi.utxos[0].amount.toString(),
    blinding: toHex(wagmi.utxos[0].blinding),
  };
  const tacInput = {
    utxo: { txid: taco.utxos[0].utxo.txid, vout: taco.utxos[0].utxo.vout },
    amount: taco.utxos[0].amount.toString(),
    blinding: toHex(taco.utxos[0].blinding),
  };
  info(`WAGMI input: ${cbtcZkInput.amount} from ${cbtcZkInput.utxo.txid.slice(0,12)}…:${cbtcZkInput.utxo.vout}`);
  info(`TACO input: ${tacInput.amount} from ${tacInput.utxo.txid.slice(0,12)}…:${tacInput.utxo.vout}`);
  const slots = dapp.getSlotRecords({ status: 'live' });
  const slotRec = slots.find(s => s.leafCommitmentHex === state.slotLeafHashHex);
  if (!slotRec) fail(`slot record ${state.slotLeafHashHex} missing from localStorage`);
  const r = await dapp.buildAndBroadcastCbtcTacDepositAtomic({
    slotRecord: slotRec,
    poolIdHex: state.poolIdHex,
    cbtcZkInput,
    tacInput,
    onProgress: (s) => info(s),
  });
  state.atomicDepositCommitTxid = r.commitTxid;
  state.atomicDepositTxid = r.revealTxid;
  state.atomicDepositLpShareAmount = r.shareAmount;
  state.atomicDepositLpShareBlinding = r.lpShareBlindingHex;
  state.atomicDepositMintBlinding = r.mintBlindingHex;
  // Persist full position record — Phase 6 in a fresh JSDOM has no
  // localStorage, so we re-inject the record at the top of Phase 6.
  state.atomicDepositPositionRecord = { ...r.positionRecord, status: 'active' };
  saveState(state);
  ok(`atomic deposit broadcast: ${r.revealTxid}`);
  ok(`minted ${r.shareAmount} LP shares + ${slotRec.denomination} cBTC.tac`);
  await waitForConfirmation(r.revealTxid, 'atomic deposit');
}
ok(`Phase 5: atomic deposit ${state.atomicDepositTxid}`);

// ============ Phase 6: T_CBTC_TAC_WITHDRAW_ATOMIC ============
if (!state.atomicWithdrawTxid) {
  step(6, 'T_CBTC_TAC_WITHDRAW_ATOMIC (burn cBTC.tac + LP_REMOVE → BTC + WAGMI + TACO)');
  dapp.invalidateHoldingsCache();
  // Re-inject (or reconstruct) the position record into localStorage —
  // fresh JSDOM has no client-side state across script runs. Reconstruction
  // covers the case where Phase 5 was run before this persistence existed.
  {
    const positionsKey = 'tacit-cbtc-tac-positions-v1:signet';
    let positionRec = state.atomicDepositPositionRecord;
    if (!positionRec) {
      positionRec = {
        targetLeafHashHex: state.slotLeafHashHex,
        slotAssetIdHex: state.slotRecord?.assetIdHex,
        slotDenomSats: state.slotRecord?.denomination,
        bondAmountTAC: state.atomicDepositLpShareAmount,
        bondLpShareAmount: state.atomicDepositLpShareAmount,
        bondLpAssetIdHex: state.lpAssetIdHex,
        bondPoolIdHex: state.poolIdHex,
        bondBlindingHex: state.atomicDepositLpShareBlinding,
        depositorRecoveryPubHex: wallets.depositor.pub_hex,
        mintAmount: state.slotRecord?.denomination,
        mintBlindingHex: state.atomicDepositMintBlinding,
        network: 'signet',
        depositCommitTxid: state.atomicDepositCommitTxid,
        depositRevealTxid: state.atomicDepositTxid,
        status: 'active',
        atomicDeposit: true,
      };
    }
    try {
      const existing = JSON.parse(globalThis.localStorage.getItem(positionsKey) || '[]');
      if (!existing.find(p => p.depositRevealTxid === state.atomicDepositTxid)) {
        existing.push(positionRec);
        globalThis.localStorage.setItem(positionsKey, JSON.stringify(existing));
      }
    } catch (e) { info(`position record re-inject failed: ${e?.message || e}`); }
  }
  const positions = dapp.getCtacPositionRecords();
  const position = positions.find(p => p.depositRevealTxid === state.atomicDepositTxid);
  if (!position || position.status !== 'active') {
    fail(`atomic deposit position not active (status=${position?.status})`);
  }
  const slots = dapp.getSlotRecords({ status: 'deposited' });
  const slotRec = slots.find(s => s.leafCommitmentHex === state.slotLeafHashHex);
  if (!slotRec) fail(`slot record ${state.slotLeafHashHex} missing`);
  const cbtcTacUtxo = {
    utxo: { txid: state.atomicDepositTxid, vout: 1 },
    amount: position.mintAmount,
    blinding: state.atomicDepositMintBlinding,
  };
  const lpShareUtxo = {
    utxo: { txid: state.atomicDepositTxid, vout: 0 },
    amount: state.atomicDepositLpShareAmount,
    blinding: state.atomicDepositLpShareBlinding,
  };
  const r = await dapp.buildAndBroadcastCbtcTacWithdrawAtomic({
    positionRecord: position,
    slotRecord: slotRec,
    cbtcTacUtxos: [cbtcTacUtxo],
    lpShareUtxo,
    onProgress: (s) => info(s),
  });
  state.atomicWithdrawCommitTxid = r.commitTxid;
  state.atomicWithdrawTxid = r.revealTxid;
  state.atomicWithdrawPayoutValue = r.payoutValue;
  state.atomicWithdrawRecvCbtcAmount = r.recvCbtcZkAmount;
  state.atomicWithdrawRecvTacAmount = r.recvTacAmount;
  saveState(state);
  ok(`atomic withdraw broadcast: ${r.revealTxid}`);
  ok(`BTC payout: ${r.payoutValue.toLocaleString()} sats`);
  ok(`WAGMI back: ${r.recvCbtcZkAmount} | TACO back: ${r.recvTacAmount}`);
  await waitForConfirmation(r.revealTxid, 'atomic withdraw');
}
ok(`Phase 6: atomic withdraw ${state.atomicWithdrawTxid}`);

console.log('\n=== PRE-STAGING + ATOMIC RT COMPLETE ===');
info(`final balance: ${(await balanceSats()).toLocaleString()} sats`);
