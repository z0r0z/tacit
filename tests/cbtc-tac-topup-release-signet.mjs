// Signet rehearsal for SPEC §5.50 (T_CBTC_TAC_TOP_UP) and §5.51
// (T_CBTC_TAC_BOND_RELEASE). Reuses the existing CETCH'd TACO+WAGMI assets
// and the POOL_INIT pool from cbtc-tac-signet-prestage.mjs's state file.
//
// Phases (resumable via .local/cbtc-tac-topup-release-state.json):
//   1. Reuse TACO + WAGMI + pool from prestage state file
//   2. SLOT_MINT — fresh cBTC.zk slot (smaller denom to fit budget)
//   3. T_CBTC_TAC_DEPOSIT_ATOMIC — opens position
//   4. T_LP_ADD variant-0 — creates an extra LP-share UTXO for top-up
//   5. T_CBTC_TAC_TOP_UP — combines bond + extra LP-share
//   6. T_CBTC_TAC_BOND_RELEASE — partial release of bond back to depositor
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
// Bypass slow CF worker proxy for chain queries.
globalThis.localStorage.setItem('tacit-custom-api-v1', JSON.stringify({
  signet: 'https://mempool.space/signet/api',
}));

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-topup-release-state.json');
const PRESTAGE_FILE = path.join(STATE_DIR, 'cbtc-tac-prestage-state.json');
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
const DEP_PRIV_HEX = wallets.depositor.priv_hex;
const state = loadState();
const prestage = existsSync(PRESTAGE_FILE) ? JSON.parse(readFileSync(PRESTAGE_FILE, 'utf8')) : null;
if (!prestage || !prestage.tacoAssetIdHex || !prestage.poolIdHex) {
  fail('prestage state missing — run tests/cbtc-tac-signet-prestage.mjs first');
}

dapp.wallet.priv = DEP_SK;
dapp.wallet.pub = DEP_PUB;
const ackKey = 'tacit-backup-ack-v1:' + bytesToHex(DEP_PUB);
globalThis.localStorage.setItem(ackKey, '1');
globalThis.TAC_ASSET_ID_HEX = prestage.tacoAssetIdHex;
ok(`wallet: ${DEP_ADDR}`);

async function balanceSats() {
  const r = await fetch(`https://mempool.space/signet/api/address/${DEP_ADDR}`);
  const j = await r.json();
  return (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum)
    + (j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum);
}
info(`balance: ${(await balanceSats()).toLocaleString()} sats`);
info(`reusing TACO=${prestage.tacoAssetIdHex.slice(0,16)}… WAGMI=${prestage.wagmiAssetIdHex.slice(0,16)}… pool=${prestage.poolIdHex.slice(0,16)}…`);

// ============ Phase 2: SLOT_MINT (smaller denom to conserve budget) ============
if (!state.slotLeafHashHex) {
  step(2, 'mint cBTC.zk slot (against WAGMI, 100k sats — top-up/release rehearsal budget)');
  const r = await dapp.buildAndBroadcastSlotMint({
    assetIdHex: prestage.wagmiAssetIdHex,
    denomination: 100_000n,
    onProgress: (s) => info(s),
  });
  state.slotMintTxid = r.revealTxid || r.commitTxid;
  state.slotLeafHashHex = r.slotRecord?.leafCommitmentHex || r.leafCommitmentHex;
  const fullSlot = (dapp.getSlotRecords ? dapp.getSlotRecords() : []).find(
    s => s.leafCommitmentHex === state.slotLeafHashHex,
  );
  if (fullSlot) state.slotRecord = fullSlot;
  saveState(state);
  ok(`SLOT_MINT broadcast: ${state.slotMintTxid}`);
  await waitForConfirmation(state.slotMintTxid, 'SLOT_MINT');
}
// Re-inject slot record into localStorage (fresh JSDOM has no localStorage).
if (state.slotRecord && (!dapp.getSlotRecords || !dapp.getSlotRecords().find(s => s.leafCommitmentHex === state.slotLeafHashHex))) {
  try {
    const key = 'tacit-slot-records-v1:signet';
    const existing = JSON.parse(globalThis.localStorage.getItem(key) || '[]');
    if (!existing.find(s => s.leafCommitmentHex === state.slotLeafHashHex)) {
      existing.push(state.slotRecord);
      globalThis.localStorage.setItem(key, JSON.stringify(existing));
    }
  } catch (e) { info(`slot record re-inject failed: ${e?.message || e}`); }
}
ok(`Phase 2: slot leaf ${state.slotLeafHashHex}`);

// ============ Phase 3: atomic deposit ============
if (!state.atomicDepositTxid) {
  step(3, 'T_CBTC_TAC_DEPOSIT_ATOMIC');
  // Source WAGMI + TACO from the previous atomic withdraw's LP_REMOVE legs
  // (still unspent per outspends check). Blindings are HMAC-derived from
  // priv per SPEC §5.49.8, anchored to the burned LP-share input outpoint
  // (= prestage.atomicDepositTxid : 0).
  if (!prestage.atomicWithdrawTxid || !prestage.atomicDepositTxid) {
    fail('prestage state missing atomicWithdrawTxid / atomicDepositTxid');
  }
  const ammReceipt = await import('../dapp/amm-receipt.js');
  const ammAsset = await import('../dapp/amm-asset.js');
  const lpShareInputOutpoint = ammReceipt.canonicalOutpoint(prestage.atomicDepositTxid, 0);
  const [canonA, canonB] = ammAsset.canonicalAssetPair(prestage.wagmiAssetIdHex, prestage.tacoAssetIdHex);
  const wagmiIsCanonA = bytesToHex(canonA) === prestage.wagmiAssetIdHex.toLowerCase();
  const { legA, legB } = ammReceipt.deriveLpRemoveBlindings({
    recipientPrivkey: DEP_SK,
    poolId: hexToBytes(prestage.poolIdHex),
    lpShareInputOutpoint,
    assetIdA: canonA, assetIdB: canonB,
  });
  const wagmiBlindBig = wagmiIsCanonA ? legA.r_secp : legB.r_secp;
  const tacoBlindBig  = wagmiIsCanonA ? legB.r_secp : legA.r_secp;
  const toHex = (n) => n.toString(16).padStart(64, '0');
  // Withdraw layout: vout[0]=BTC payout, vout[1]=cBTC.zk(WAGMI), vout[2]=TAC(TACO)
  const cbtcZkInput = {
    utxo: { txid: prestage.atomicWithdrawTxid, vout: 1 },
    amount: prestage.atomicWithdrawRecvCbtcAmount,
    blinding: toHex(wagmiBlindBig),
  };
  const tacInput = {
    utxo: { txid: prestage.atomicWithdrawTxid, vout: 2 },
    amount: prestage.atomicWithdrawRecvTacAmount,
    blinding: toHex(tacoBlindBig),
  };
  info(`WAGMI input: ${cbtcZkInput.amount} from atomic withdraw vout 1`);
  info(`TACO input: ${tacInput.amount} from atomic withdraw vout 2`);
  const slots = dapp.getSlotRecords({ status: 'live' });
  const slotRec = slots.find(s => s.leafCommitmentHex === state.slotLeafHashHex);
  if (!slotRec) fail(`slot record ${state.slotLeafHashHex} missing from localStorage`);
  const r = await dapp.buildAndBroadcastCbtcTacDepositAtomic({
    slotRecord: slotRec,
    poolIdHex: prestage.poolIdHex,
    cbtcZkInput, tacInput,
    onProgress: (s) => info(s),
  });
  state.atomicDepositTxid = r.revealTxid;
  state.atomicDepositLpShareAmount = r.shareAmount;
  state.atomicDepositLpShareBlinding = r.lpShareBlindingHex;
  state.atomicDepositMintBlinding = r.mintBlindingHex;
  state.atomicDepositPositionRecord = { ...r.positionRecord, status: 'active' };
  saveState(state);
  ok(`atomic deposit: ${r.revealTxid}`);
  ok(`minted ${r.shareAmount} LP shares + ${slotRec.denomination} cBTC.tac`);
  await waitForConfirmation(r.revealTxid, 'atomic deposit');
}
// Re-inject position record + slot status update
const positionsKey = 'tacit-cbtc-tac-positions-v1:signet';
try {
  const existing = JSON.parse(globalThis.localStorage.getItem(positionsKey) || '[]');
  if (!existing.find(p => p.depositRevealTxid === state.atomicDepositTxid)) {
    existing.push(state.atomicDepositPositionRecord);
    globalThis.localStorage.setItem(positionsKey, JSON.stringify(existing));
  }
} catch (e) { info(`position record re-inject failed: ${e?.message || e}`); }
ok(`Phase 3: atomic deposit ${state.atomicDepositTxid}`);

// ============ Phase 4: T_LP_ADD variant-0 to create extra LP-share for top-up ============
if (!state.extraLpAddTxid) {
  step(4, 'T_LP_ADD variant-0 (extra LP-shares for TOP_UP input)');
  dapp.invalidateHoldingsCache();
  // Look up pool reserves to compute proportional share output
  const poolRes = await fetch(`https://tacit-pin.rosscampbell9.workers.dev/amm/pool/${prestage.poolIdHex}?network=signet`);
  const poolJson = await poolRes.json();
  if (!poolJson || !poolJson.pool_id) fail(`pool ${prestage.poolIdHex} not found`);
  const tacIsA = poolJson.asset_a === prestage.tacoAssetIdHex;
  const R_cbtc = tacIsA ? BigInt(poolJson.reserve_b) : BigInt(poolJson.reserve_a);
  const R_tac  = tacIsA ? BigInt(poolJson.reserve_a) : BigInt(poolJson.reserve_b);
  const S = BigInt(poolJson.lp_total_shares);
  const dA = 1_000_000_000n;  // WAGMI side
  const dB = 1_000_000_000n;  // TACO side
  // For canonical ordering — variant0 builder canonicalizes internally
  const deltaA_canonical = poolJson.asset_a === prestage.wagmiAssetIdHex ? dA : dB;
  const deltaB_canonical = poolJson.asset_a === prestage.wagmiAssetIdHex ? dB : dA;
  // Shares minted = floor(min(dA·S/R_a, dB·S/R_b))
  const Rcanon_a = BigInt(poolJson.reserve_a);
  const Rcanon_b = BigInt(poolJson.reserve_b);
  const sharesA = (deltaA_canonical * S) / Rcanon_a;
  const sharesB = (deltaB_canonical * S) / Rcanon_b;
  const shareAmount = sharesA < sharesB ? sharesA : sharesB;
  info(`pool reserves: a=${poolJson.reserve_a} b=${poolJson.reserve_b} S=${S}`);
  info(`adding deltaA=${deltaA_canonical} deltaB=${deltaB_canonical} → shares=${shareAmount}`);
  const r = await dapp.buildAndBroadcastLpAddVariant0({
    poolIdHex: prestage.poolIdHex,
    assetAIdHex: poolJson.asset_a,
    assetBIdHex: poolJson.asset_b,
    deltaA: deltaA_canonical, deltaB: deltaB_canonical,
    shareAmount,
    feeBps: poolJson.fee_bps,
    poolCapabilityFlags: 0,
    onProgress: (s) => info(s),
  });
  state.extraLpAddTxid = r.revealTxid;
  state.extraLpShareAmount = shareAmount.toString();
  state.extraLpShareBlinding = r.lpShareBlindingHex;
  saveState(state);
  ok(`LP_ADD: ${r.revealTxid} → ${shareAmount} LP-shares`);
  await waitForConfirmation(r.revealTxid, 'extra LP_ADD');
}
ok(`Phase 4: extra LP-shares ${state.extraLpAddTxid}`);

// ============ Phase 5: T_CBTC_TAC_TOP_UP ============
if (!state.topUpTxid) {
  step(5, 'T_CBTC_TAC_TOP_UP (combine bond LP-share + extra LP-share)');
  dapp.invalidateHoldingsCache();
  const positions = dapp.getCtacPositionRecords();
  const position = positions.find(p => p.depositRevealTxid === state.atomicDepositTxid);
  if (!position || position.status !== 'active') fail(`position not active (status=${position?.status})`);
  const oldBondUtxo = {
    txid: state.atomicDepositTxid,
    vout: 0,
    amount: state.atomicDepositLpShareAmount,
    blinding: state.atomicDepositLpShareBlinding,
  };
  const additionalLpShareUtxos = [{
    utxo: { txid: state.extraLpAddTxid, vout: 0 },
    amount: state.extraLpShareAmount,
    blinding: state.extraLpShareBlinding,
  }];
  info(`old bond: ${oldBondUtxo.amount} LP-shares from ${oldBondUtxo.txid.slice(0,12)}…:${oldBondUtxo.vout}`);
  info(`adding: ${additionalLpShareUtxos[0].amount} LP-shares`);
  const r = await dapp.buildAndBroadcastCbtcTacTopUp({
    positionRecord: position,
    oldBondUtxo,
    additionalLpShareUtxos,
    depositorRecoveryPrivHex: DEP_PRIV_HEX,
    onProgress: (s) => info(s),
  });
  state.topUpTxid = r.revealTxid;
  state.topUpNewBondAmount = r.newBondAmount;
  state.topUpNewBondBlinding = r.newBondBlindingHex;
  state.topUpNewBondCommit = r.newBondCommitHex;
  saveState(state);
  ok(`TOP_UP: ${r.revealTxid} → new bond ${r.newBondAmount}`);
  await waitForConfirmation(r.revealTxid, 'TOP_UP');
}
ok(`Phase 5: TOP_UP ${state.topUpTxid}`);

// ============ Phase 6: T_CBTC_TAC_BOND_RELEASE ============
if (!state.releaseTxid) {
  step(6, 'T_CBTC_TAC_BOND_RELEASE (partial release of bond)');
  dapp.invalidateHoldingsCache();
  const positions = dapp.getCtacPositionRecords();
  const position = positions.find(p => p.depositRevealTxid === state.atomicDepositTxid);
  if (!position) fail(`position not found`);
  // Refresh position fields from state since TOP_UP mutated bond
  position.bondLpShareAmount = state.topUpNewBondAmount;
  position.bondAmountTAC = state.topUpNewBondAmount;
  const oldBondUtxo = {
    txid: state.topUpTxid,
    vout: 0,
    amount: state.topUpNewBondAmount,
    blinding: state.topUpNewBondBlinding,
  };
  // Release 30% of the bond (keep 70% for safety margin above INITIAL_BOND_RATIO)
  const releaseAmount = (BigInt(state.topUpNewBondAmount) * 30n) / 100n;
  info(`old bond: ${oldBondUtxo.amount} LP-shares; releasing ${releaseAmount.toString()}`);
  const r = await dapp.buildAndBroadcastCbtcTacBondRelease({
    positionRecord: position,
    oldBondUtxo,
    releaseAmount,
    depositorRecoveryPrivHex: DEP_PRIV_HEX,
    onProgress: (s) => info(s),
  });
  state.releaseTxid = r.revealTxid;
  state.releaseAmount = r.releaseAmount;
  state.releaseNewBondAmount = r.newBondAmount;
  state.releaseUtxo = r.releaseUtxo;
  saveState(state);
  ok(`BOND_RELEASE: ${r.revealTxid}`);
  ok(`new bond: ${r.newBondAmount} | released: ${r.releaseAmount} LP-shares to depositor`);
  await waitForConfirmation(r.revealTxid, 'BOND_RELEASE');
}
ok(`Phase 6: BOND_RELEASE ${state.releaseTxid}`);

console.log('\n=== TOP_UP + BOND_RELEASE SIGNET RT COMPLETE ===');
info(`final balance: ${(await balanceSats()).toLocaleString()} sats`);
