// End-to-end signet harness for the Tacit mixer (SPEC §5.10 / §5.11).
//
// Drives the REAL dapp code path — buildAndBroadcastCEtch → buildAndBroadcast-
// PoolInit → buildAndBroadcastDeposit → buildAndBroadcastWithdraw — against
// live Bitcoin signet + the live indexer (api.tacit.finance). Exercises every
// fund-safety gate the offline audit examined, on chain:
//
//   Phase 1: pre-flight (depositor funded)
//   Phase 2: CETCH a throwaway tacit asset (supply → depositor)
//   Phase 3: POOL_INIT the CANONICAL pool (asset_id, denom) — vk_cid +
//            ceremony_cid = the pinned trust anchors
//   Phase 4: wait for the indexer to register the pool (scanPools)
//   Phase 5: DEPOSIT denom into the pool (kernel-signed consume → leaf append)
//   Phase 6: wait for deposit depth ≥ 3 + indexer (buildMixerMerkleProof finds
//            the leaf)
//   Phase 7: WITHDRAW — browser-side Groth16 proof + pre-broadcast self-verify
//            under the pinned vk, then broadcast T_WITHDRAW (flow-to-self so
//            the credit is verifiable; set WITHDRAW_TO=other for a pay-to-
//            withdrawer unlinkability demo)
//   Phase 8: wait for withdraw confirmation; verify the fresh tacit UTXO is
//            credited (denom restored at a NEW, on-chain-unlinkable outpoint)
//            and the nullifier is marked spent
//
// State persists between phases at .local/mixer-signet-state.json so a partial
// run resumes. Signet blocks are ~10 min and the indexer cron is periodic, so
// a full run can take 30–60 min.
//
// Run:   node tests/mixer-onchain-e2e-signet.mjs
// Reset: rm .local/mixer-signet-state.json
// Wallets: node tests/gen-mixer-signet-wallets.mjs  (fund the depositor ~200k sats)

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
globalThis.__TACIT_WORKER_BASE__ = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance';

// buildAndBroadcastWithdraw does `fetch('./vendor/withdraw.wasm')` — a relative
// URL that node's global fetch can't resolve. Shim fetch to serve the local
// vendor asset from disk; everything else (worker zkey, IPFS, signet API)
// passes through to the real network.
const _realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : (url?.url || '');
  if (u.endsWith('/vendor/withdraw.wasm') || u === './vendor/withdraw.wasm') {
    const buf = readFileSync(path.join(ROOT, 'dapp', 'vendor', 'withdraw.wasm'));
    return new Response(buf, { status: 200, headers: { 'content-type': 'application/wasm' } });
  }
  return _realFetch(url, opts);
};

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
const dapp = await import('../dapp/tacit.js');

const STATE_DIR  = path.join(ROOT, '.local');
const STATE_FILE = path.join(STATE_DIR, 'mixer-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'mixer-signet-test-wallets.json');

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

if (!existsSync(WALLET_FILE)) {
  fail(`Wallet file missing: ${WALLET_FILE}\nGenerate first: node tests/gen-mixer-signet-wallets.mjs`);
}
const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const DENOM = BigInt(process.env.MIXER_DENOM || '1000');
const SUPPLY = 100_000n;
const WITHDRAW_TO_OTHER = process.env.WITHDRAW_TO === 'other';

function asDepositor() {
  dapp.wallet.priv = hexToBytes(W.depositor.priv_hex);
  dapp.wallet.pub  = hexToBytes(W.depositor.pub_hex);
  // Headless: pre-ack the burner-key backup (per-pubkey flag) so the deposit
  // auto-split's ensureBurnerBackedUp gate doesn't try to open an interactive
  // modal (which auto-cancels under jsdom → "cancelled"). Same key as
  // markBurnerBackedUp(): BACKUP_ACK_PREFIX + pubHex.
  globalThis.localStorage.setItem('tacit-backup-ack-v1:' + W.depositor.pub_hex, '1');
  dapp.invalidateHoldingsCache();
}

async function fetchSatsBalance(addr) {
  const r = await _realFetch(`https://mempool.space/signet/api/address/${addr}`);
  const j = await r.json();
  const confirmed = (j.chain_stats?.funded_txo_sum || 0) - (j.chain_stats?.spent_txo_sum || 0);
  const mem       = (j.mempool_stats?.funded_txo_sum || 0) - (j.mempool_stats?.spent_txo_sum || 0);
  return { confirmed, total: confirmed + mem };
}
async function waitConfirmed(txid, label, maxMin = 180) {
  info(`waiting for ${label} confirmation (${txid.slice(0, 12)}…)`);
  for (let i = 0; i < maxMin * 12; i++) {
    try {
      const r = await _realFetch(`https://mempool.space/signet/api/tx/${txid}/status`);
      if (r.ok) { const s = await r.json(); if (s.confirmed) { ok(`${label} confirmed @ block ${s.block_height}`); return s.block_height; } }
    } catch {}
    await sleep(5000);
  }
  fail(`${label} not confirmed after ${maxMin} min`);
}
async function waitFor(label, predicate, maxMin = 120) {
  info(`waiting for ${label} (indexer)…`);
  for (let i = 0; i < maxMin * 4; i++) {
    try { dapp.invalidateHoldingsCache?.(); await dapp.scanPools(); if (await predicate()) { ok(label); return; } } catch (e) { info(`  (retry: ${e.message || e})`); }
    await sleep(15000);
  }
  fail(`${label} did not happen within ${maxMin} min`);
}

const state = loadState();

// ---------------- Phase 1 ----------------
step(1, 'Pre-flight (depositor funding)');
asDepositor();
const depAddr = dapp.wallet.address();
info(`depositor:  ${depAddr}`);
info(`withdrawer: ${W.withdrawer.address}  (${WITHDRAW_TO_OTHER ? 'pay-to-other demo' : 'unused; flow-to-self'})`);
info(`denomination: ${DENOM}`);
// Flow needs only fees + DUST outputs (CETCH/POOL_INIT/DEPOSIT/WITHDRAW commit+reveal),
// well under 20k on signet at ~1 sat/vb. Kept low so the faucet's RBF shrinkage of
// the unconfirmed payout can't drop us under the bar before it confirms.
const MIN_SATS = 40_000;
const CONFIRM_WAIT_MIN = 180; // signet's centralized signer stalls for long stretches; ride it out
let bal = await fetchSatsBalance(depAddr);
info(`depositor sats: confirmed=${bal.confirmed} total=${bal.total}`);
if (bal.total < MIN_SATS) fail(`depositor needs ≥${MIN_SATS} signet sats (has ${bal.total}); fund at https://signet.bublina.eu.org/`);
// CETCH must spend a CONFIRMED UTXO — wait for the funding tx to confirm. Signet
// block production is irregular (centralized signer), so this can take a while;
// the harness is resumable, so a stall just delays rather than loses progress.
if (bal.confirmed < MIN_SATS) {
  info('funding is unconfirmed; waiting for ≥1 confirmation before spending (signet may be slow)…');
  for (let i = 0; i < CONFIRM_WAIT_MIN * 4; i++) {
    await sleep(15000);
    bal = await fetchSatsBalance(depAddr);
    if (bal.confirmed >= MIN_SATS) break;
    if (i % 8 === 0) info(`  …confirmed=${bal.confirmed} total=${bal.total} (waited ~${Math.round(i / 4)} min)`);
  }
  if (bal.confirmed < MIN_SATS) fail(`funding still unconfirmed after ${CONFIRM_WAIT_MIN} min (confirmed=${bal.confirmed}) — signet block production likely stalled; re-run when it resumes`);
}
ok(`depositor funded (confirmed ${bal.confirmed} sats)`);

// ---------------- Phase 2: CETCH ----------------
if (!state.assetIdHex) {
  step(2, 'CETCH a throwaway tacit asset (supply → depositor)');
  const r = await dapp.buildAndBroadcastCEtch({ ticker: `MIX${Date.now() % 100000}`, supplyBase: SUPPLY, decimals: 0, mintable: false });
  ok(`CETCH commit ${r.commitTxid.slice(0, 12)}… reveal ${r.revealTxid.slice(0, 12)}…`);
  await waitConfirmed(r.revealTxid, 'CETCH reveal');
  state.assetIdHex = r.assetIdHex; state.cetchTxid = r.revealTxid; saveState(state);
} else { step(2, `CETCH done — asset ${state.assetIdHex.slice(0, 12)}…`); }
const assetIdHex = state.assetIdHex;

// ---------------- Phase 3: POOL_INIT ----------------
if (!state.poolInitTxid) {
  step(3, 'POOL_INIT the canonical pool');
  const r = await dapp.buildAndBroadcastPoolInit({
    assetIdHex, poolDenom: DENOM,
    vkCid: dapp.CANONICAL_VK_CID, ceremonyCid: dapp.CANONICAL_CEREMONY_CID,
  });
  ok(`POOL_INIT reveal ${r.revealTxid.slice(0, 12)}…`);
  await waitConfirmed(r.revealTxid, 'POOL_INIT reveal');
  state.poolInitTxid = r.revealTxid; saveState(state);
} else { step(3, `POOL_INIT done — ${state.poolInitTxid.slice(0, 12)}…`); }

// ---------------- Phase 4: indexer registers pool ----------------
step(4, 'Wait for indexer to register the pool');
await waitFor('pool registered + canonical', async () =>
  dapp.mixerIsPoolRegistered(assetIdHex, DENOM) && dapp.mixerIsPoolCanonical(assetIdHex, DENOM));

// ---------------- Phase 5: DEPOSIT ----------------
if (!state.depositRecord) {
  step(5, `DEPOSIT ${DENOM} into the pool`);
  asDepositor();
  const r = await dapp.buildAndBroadcastDeposit({ assetIdHex, denomination: DENOM, onProgress: s => info(`  [deposit:${s}]`) });
  ok(`DEPOSIT reveal ${r.revealTxid.slice(0, 12)}…  leaf ${r.depositRecord.leafCommitmentHex.slice(0, 12)}…`);
  await waitConfirmed(r.revealTxid, 'DEPOSIT reveal');
  state.depositRecord = r.depositRecord; state.depositTxid = r.revealTxid; saveState(state);
} else { step(5, `DEPOSIT done — leaf ${state.depositRecord.leafCommitmentHex.slice(0, 12)}…`); }
const depositRecord = state.depositRecord;

// ---------------- Phase 6: leaf indexed at depth ≥ 3 ----------------
step(6, 'Wait for deposit leaf to reach depth ≥ 3 + be indexed');
await waitFor('leaf in local pool tree (merkle proof builds)', async () => {
  const mp = dapp.buildMixerMerkleProof(assetIdHex, DENOM, hexToBytes(depositRecord.leafCommitmentHex));
  if (mp) { const st = dapp.mixerGetPoolStats(assetIdHex, DENOM); info(`  pool: ${st?.totalLeaves} leaves, ${st?.anonymitySet} anon-set`); }
  return !!mp;
}, 120);

// ---------------- Phase 7: WITHDRAW ----------------
if (!state.withdrawTxid) {
  step(7, `WITHDRAW (Groth16 proof + pre-broadcast self-verify)${WITHDRAW_TO_OTHER ? ' → withdrawer' : ' → self'}`);
  asDepositor();
  const r = await dapp.buildAndBroadcastWithdraw({
    depositRecord,
    recipientPubkey: WITHDRAW_TO_OTHER ? hexToBytes(W.withdrawer.pub_hex) : null,
    onProgress: (s, i) => info(`  [withdraw:${s}${i?.ms ? ` ${i.ms}ms` : ''}]`),
  });
  ok(`WITHDRAW reveal ${r.revealTxid.slice(0, 12)}…  (pre-broadcast self-verify passed)`);
  await waitConfirmed(r.revealTxid, 'WITHDRAW reveal');
  state.withdrawTxid = r.revealTxid; saveState(state);
} else { step(7, `WITHDRAW done — ${state.withdrawTxid.slice(0, 12)}…`); }

// ---------------- Phase 8: verify credit + nullifier ----------------
step(8, 'Verify the withdraw credit + nullifier spent');
await waitFor('nullifier marked spent in indexer', async () =>
  dapp.mixerIsNullifierSpent(assetIdHex, DENOM, hexToBytes(depositRecord.nullifierHashHex)), 120);

if (!WITHDRAW_TO_OTHER) {
  // Authoritative credit check: run the full T_WITHDRAW validator on the
  // confirmed reveal (pool-registered → canonical vk → historical-root →
  // owner-conflict re-verify → Pedersen → Groth16 → reserve floor). Returns
  // true iff the fresh tacit UTXO at vout 0 is a valid spendable credit. This
  // is the on-chain meaning of "the withdraw credited", independent of the
  // worker's address-scan timing.
  asDepositor();
  await waitFor(`T_WITHDRAW ${state.withdrawTxid.slice(0, 12)}…:0 validates as a creditable tacit UTXO`, async () => {
    return (await dapp.validateOutpoint(state.withdrawTxid, 0, new Map(), dapp.getTx)) === true;
  }, 60);
  ok(`withdraw credit verified authoritatively (Groth16 + Pedersen + nullifier-conflict gate all pass; unlinkable to the deposit on chain)`);
  // Best-effort wallet-recognition note (not a gate — scanHoldings auto-discovery may lag).
  try {
    dapp.invalidateHoldingsCache();
    const h = (await dapp.scanHoldings()).get(assetIdHex);
    const seen = h?.utxos?.some(u => u.txid === state.withdrawTxid && BigInt(u.amount) === DENOM);
    info(seen ? 'wallet scanHoldings also surfaced the credited UTXO' : 'wallet scanHoldings has not auto-surfaced it yet (indexer lag; credit is valid regardless)');
  } catch {}
} else {
  ok(`withdraw broadcast to withdrawer ${W.withdrawer.address}; share r_leaf out-of-band for the recipient to recognize the opening`);
}

console.log('\n✅ Mixer signet e2e complete: deposit → withdraw → credit round-trip verified on chain.');
console.log('   The on-chain T_WITHDRAW reveals no link to the T_DEPOSIT (Groth16 ZK + nullifier).');
process.exit(0);
