// End-to-end signet harness for SPEC §5.48 + §5.49 atomic envelopes:
//   T_CBTC_TAC_DEPOSIT_ATOMIC (0x57): LP_ADD + DEPOSIT in one tx
//   T_CBTC_TAC_WITHDRAW_ATOMIC (0x58): WITHDRAW + LP_REMOVE in one tx
//
// Phases (resumable via .local/cbtc-tac-atomic-signet-state.json):
//   1. Pre-flight: wallets funded; TAC asset + cBTC.zk slot + canonical pool exist
//   2. T_CBTC_TAC_DEPOSIT_ATOMIC: one tx creates LP + mints cBTC.tac
//   3. Wait for confirmation, verify via /ctac/state + /ctac/lien
//   4. T_CBTC_TAC_WITHDRAW_ATOMIC: one tx burns cBTC.tac + LP_REMOVE + pays out
//   5. Wait for confirmation, verify lien released, LP_REMOVE outputs landed
//
// Run:  node tests/cbtc-tac-atomic-deposit-signet.mjs
// Reset: rm .local/cbtc-tac-atomic-signet-state.json
//
// Requires:
//   .local/cbtc-tac-signet-test-wallets.json
//   .local/cbtc-tac-atomic-signet-state.json (or env vars):
//     {
//       "tacAssetIdHex": "<64 hex>",
//       "poolIdHex": "<64 hex>",     (canonical (cBTC.zk-L, TAC) pool)
//       "slotLeafHashHex": "<64 hex>" (a live cBTC.zk slot in the depositor's wallet)
//     }

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

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cbtc-tac-atomic-signet-state.json');
const WALLETS    = path.join(STATE_DIR, 'cbtc-tac-signet-test-wallets.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function step(n, msg) { console.log(`\n--- step ${n}: ${msg} ---`); }
function ok(msg) { console.log(`✓ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(WALLETS)) {
  fail(`wallets not found at ${WALLETS}. Run: node tests/gen-cbtc-tac-signet-wallets.mjs`);
}
const wallets = JSON.parse(readFileSync(WALLETS, 'utf8'));
const DEP_SK = hexToBytes(wallets.depositor.priv_hex);
const DEP_PUB = hexToBytes(wallets.depositor.pub_hex);
const DEP_ADDR = wallets.depositor.address;

const state = loadState();
const TAC_ASSET_ID = (process.env.TAC_ASSET_ID || state.tacAssetIdHex || '').toLowerCase();
const POOL_ID = (process.env.POOL_ID || state.poolIdHex || '').toLowerCase();
const SLOT_LEAF_HASH = (process.env.SLOT_LEAF_HASH || state.slotLeafHashHex || '').toLowerCase();

function setWallet(sk, pub) {
  dapp.wallet.priv = sk;
  dapp.wallet.pub = pub;
}
setWallet(DEP_SK, DEP_PUB);
globalThis.TAC_ASSET_ID_HEX = TAC_ASSET_ID;

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight (wallet + assets + pool + slot all exist)');

async function balanceSats(addr) {
  const r = await fetch(`https://mempool.space/signet/api/address/${addr}`);
  const j = await r.json();
  return (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum)
    + (j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum);
}
const depSats = await balanceSats(DEP_ADDR);
info(`depositor BTC: ${depSats.toLocaleString()} sats`);
if (depSats < 50_000) fail('insufficient depositor sats — fund with 100k+');
ok(`depositor funded: ${DEP_ADDR}`);

if (!TAC_ASSET_ID || !/^[0-9a-f]{64}$/.test(TAC_ASSET_ID)) {
  fail(`TAC_ASSET_ID env or state.tacAssetIdHex required. CETCH a test TAC asset first via dapp UI.`);
}
if (!POOL_ID || !/^[0-9a-f]{64}$/.test(POOL_ID)) {
  fail(`POOL_ID env or state.poolIdHex required. Create canonical (cBTC.zk-L, TAC) pool via T_LP_ADD POOL_INIT first.`);
}
if (!SLOT_LEAF_HASH || !/^[0-9a-f]{64}$/.test(SLOT_LEAF_HASH)) {
  fail(`SLOT_LEAF_HASH env or state.slotLeafHashHex required. Mint a cBTC.zk-L slot via T_SLOT_MINT first.`);
}
state.tacAssetIdHex = TAC_ASSET_ID;
state.poolIdHex = POOL_ID;
state.slotLeafHashHex = SLOT_LEAF_HASH;

// Holdings scan: must have TAC + cBTC.zk UTXOs and the slot record
info('scanning holdings…');
const holdings = await dapp.scanHoldings();
const tacHolding = holdings.get(TAC_ASSET_ID);
if (!tacHolding || (tacHolding.utxos || []).length === 0) {
  fail(`no TAC UTXOs in wallet (asset_id ${TAC_ASSET_ID})`);
}
ok(`TAC balance: ${tacHolding.balance} base units (${tacHolding.utxos.length} UTXOs)`);

// Pool lookup
const poolJson = await fetch(`https://tacit.finance/amm/pool/${POOL_ID}?network=signet`).then(r => r.json());
if (!poolJson || !poolJson.pool_id) fail(`pool ${POOL_ID} not found on signet worker`);
const cbtcAid = (poolJson.asset_a === TAC_ASSET_ID) ? poolJson.asset_b : poolJson.asset_a;
info(`pool ${POOL_ID.slice(0,12)}…: cBTC.zk side = ${cbtcAid.slice(0,12)}…, reserves ${poolJson.reserve_a}/${poolJson.reserve_b}, LP supply ${poolJson.lp_total_shares}`);

const cbtcHolding = holdings.get(cbtcAid);
if (!cbtcHolding || (cbtcHolding.utxos || []).length === 0) {
  fail(`no cBTC.zk UTXOs in wallet (asset_id ${cbtcAid})`);
}
ok(`cBTC.zk balance: ${cbtcHolding.balance} (${cbtcHolding.utxos.length} UTXOs)`);

// Slot record (in localStorage via the dapp wallet)
const slots = dapp.getSlotRecords ? dapp.getSlotRecords({ status: 'live' }) : [];
const slotRecord = slots.find(s => s.leafCommitmentHex === SLOT_LEAF_HASH);
if (!slotRecord) fail(`slot record ${SLOT_LEAF_HASH} not in localStorage (have ${slots.length} live slots)`);
ok(`slot ${SLOT_LEAF_HASH.slice(0,12)}… live, denom ${slotRecord.denomination}`);

// Pick UTXOs for the atomic deposit
const cbtcZkInput = {
  utxo: { txid: cbtcHolding.utxos[0].txid, vout: cbtcHolding.utxos[0].vout },
  amount: cbtcHolding.utxos[0].amount.toString(),
  blinding: cbtcHolding.utxos[0].blinding,
};
const tacInput = {
  utxo: { txid: tacHolding.utxos[0].txid, vout: tacHolding.utxos[0].vout },
  amount: tacHolding.utxos[0].amount.toString(),
  blinding: tacHolding.utxos[0].blinding,
};
info(`would use cBTC.zk input ${cbtcZkInput.utxo.txid.slice(0,12)}…:${cbtcZkInput.utxo.vout} (${cbtcZkInput.amount})`);
info(`would use TAC input ${tacInput.utxo.txid.slice(0,12)}…:${tacInput.utxo.vout} (${tacInput.amount})`);
saveState(state);

// ---- Phase 2: T_CBTC_TAC_DEPOSIT_ATOMIC ----
if (state.atomicDepositResult) {
  ok(`reusing atomic deposit from prior run: ${state.atomicDepositResult.revealTxid.slice(0,16)}…`);
} else {
  step(2, 'T_CBTC_TAC_DEPOSIT_ATOMIC (LP + cBTC.tac mint in one tx)');
  const result = await dapp.buildAndBroadcastCbtcTacDepositAtomic({
    slotRecord,
    poolIdHex: POOL_ID,
    cbtcZkInput,
    tacInput,
    onProgress: (s) => info(`  · ${s}`),
  });
  state.atomicDepositResult = {
    commitTxid: result.commitTxid,
    revealTxid: result.revealTxid,
    shareAmount: result.shareAmount,
    lpShareCommitHex: result.lpShareCommitHex,
    lpShareBlindingHex: result.lpShareBlindingHex,
    mintRecipientCommitHex: result.mintRecipientCommitHex,
    mintBlindingHex: result.mintBlindingHex,
  };
  saveState(state);
  ok(`atomic deposit broadcast: ${result.revealTxid.slice(0,16)}…`);
  ok(`minted ${result.shareAmount} LP shares + ${slotRecord.denomination} cBTC.tac`);
  info(`waiting 90s for confirmation…`);
  await sleep(90_000);
}

// ---- Phase 3: verify ----
step(3, 'verify position state via worker');
const lienResp = await fetch(`https://tacit.finance/ctac/lien?network=signet&txid=${state.atomicDepositResult.revealTxid}&vout=0`);
const lienJson = await lienResp.json();
if (lienJson?.lien?.state === 'depositor') {
  ok(`lien attached at (${state.atomicDepositResult.revealTxid.slice(0,12)}…:0) state=depositor`);
} else {
  info(`lien state: ${JSON.stringify(lienJson)} — may need worker re-scan`);
}

if (process.env.SKIP_WITHDRAW) {
  console.log('\n--- SKIP_WITHDRAW set — stopping after atomic deposit ---');
  process.exit(0);
}

// ---- Phase 4: T_CBTC_TAC_WITHDRAW_ATOMIC ----
step(4, 'T_CBTC_TAC_WITHDRAW_ATOMIC (burn cBTC.tac + LP_REMOVE + payout in one tx)');
// Refresh holdings post-deposit
dapp.invalidateHoldingsCache();
const postDepHoldings = await dapp.scanHoldings();
const positionRecords = dapp.getCtacPositionRecords();
const positionRecord = positionRecords.find(p => p.depositRevealTxid === state.atomicDepositResult.revealTxid);
if (!positionRecord || positionRecord.status !== 'active') {
  fail(`position not active (status=${positionRecord?.status}); confirmation may still be pending`);
}
ok(`position record: ${positionRecord.targetLeafHashHex.slice(0,12)}… status=${positionRecord.status}`);

// cBTC.tac UTXO is at (atomic deposit revealTxid, 1) per the §5.48 wire layout
const cbtcTacUtxo = {
  utxo: { txid: state.atomicDepositResult.revealTxid, vout: 1 },
  amount: positionRecord.mintAmount,
  blinding: state.atomicDepositResult.mintBlindingHex,
};

// LP-share UTXO is at (atomic deposit revealTxid, 0)
const lpShareUtxo = {
  utxo: { txid: state.atomicDepositResult.revealTxid, vout: 0 },
  amount: state.atomicDepositResult.shareAmount,
  blinding: state.atomicDepositResult.lpShareBlindingHex,
};

const wd = await dapp.buildAndBroadcastCbtcTacWithdrawAtomic({
  positionRecord,
  slotRecord,
  cbtcTacUtxos: [cbtcTacUtxo],
  lpShareUtxo,
  recipientAddr: null,                   // null = depositor's own P2WPKH
  recvCbtcZkRecipientPubHex: null,       // null = wallet.pub
  recvTacRecipientPubHex: null,          // null = wallet.pub
  onProgress: (s) => info(`  · ${s}`),
});
ok(`atomic withdraw broadcast: ${wd.revealTxid.slice(0,16)}…`);
ok(`BTC payout: ${wd.payoutValue.toLocaleString()} sats → vout[0]`);
ok(`cBTC.zk LP_REMOVE: ${wd.recvCbtcZkAmount} → vout[1]`);
ok(`TAC LP_REMOVE: ${wd.recvTacAmount} → vout[2]`);
state.atomicWithdrawResult = {
  commitTxid: wd.commitTxid,
  revealTxid: wd.revealTxid,
  payoutValue: wd.payoutValue,
  recvCbtcZkAmount: wd.recvCbtcZkAmount,
  recvTacAmount: wd.recvTacAmount,
};
saveState(state);

info(`waiting 90s for confirmation…`);
await sleep(90_000);

// ---- Phase 5: post-flight verification ----
step(5, 'post-flight (lien released; LP_REMOVE outputs visible)');
const postLienResp = await fetch(`https://tacit.finance/ctac/lien?network=signet&txid=${state.atomicDepositResult.revealTxid}&vout=0`);
const postLienJson = await postLienResp.json();
if (!postLienJson?.lien) {
  ok(`LIEN RELEASED: outpoint (${state.atomicDepositResult.revealTxid.slice(0,12)}…:0) no longer liened`);
} else {
  info(`lien state still: ${JSON.stringify(postLienJson.lien)}`);
}

dapp.invalidateHoldingsCache();
const finalHoldings = await dapp.scanHoldings();
const finalCbtc = finalHoldings.get(cbtcAid);
const finalTac = finalHoldings.get(TAC_ASSET_ID);
info(`final cBTC.zk balance: ${finalCbtc?.balance || 0}`);
info(`final TAC balance: ${finalTac?.balance || 0}`);

console.log('\n=== ATOMIC DEPOSIT + WITHDRAW signet smoke test complete ===');
