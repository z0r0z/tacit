#!/usr/bin/env node
// Headless airdrop fulfilment daemon for tacit.
//
// Mirrors what the issuer would do by hand in the Drops tab's Fulfil panel:
// pulls pending claims from the worker queue, verifies each one (merkle proof
// + eth_sig), batches up to 7 valid claims into a single CXFER, signs with
// the treasury's privkey, broadcasts, deletes the fulfilled tuples from the
// queue. Loops on a configurable interval.
//
// Architecture: imports dapp/tacit.js under a jsdom shim so we drive the same
// crypto + tx-building path the browser does — no reimplementation. The
// dapp-parity test already proves the dapp loads cleanly under jsdom.
//
// Trust model: the treasury privkey lives in this process's env var or config
// file. Whoever has access to that machine has access to the treasury. The
// treasury is a per-drop fresh key, so worst-case blast radius is the drop's
// remaining TAC supply — NOT the issuer's main wallet.
//
// Usage:
//   node auto-fulfil.mjs --config ./fulfil-config.json [--once] [--dry-run]
//
// Stop with SIGINT (Ctrl-C); state persists between runs.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- CLI arg parsing ----
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const CONFIG_PATH = arg('--config', './fulfil-config.json');
const DRY_RUN = flag('--dry-run');
const ONCE = flag('--once');

// ---- Config load + validate ----
if (!existsSync(CONFIG_PATH)) {
  console.error(`config not found: ${CONFIG_PATH}`);
  console.error(`Pass --config <path> or create fulfil-config.json in cwd. Sample shape:`);
  console.error(JSON.stringify({
    treasury_privkey: 'hex64 (or set TACIT_TREASURY_PRIVKEY env var)',
    drop_record_path: './drop-export.json',
    worker_base: 'https://tacit-pin.rosscampbell9.workers.dev',
    network: 'signet',
    interval_sec: 600,
    max_batches_per_run: 50,
    min_treasury_sats: 5000,
    min_queue_to_broadcast: 1,
    require_eth_sigs: true,
  }, null, 2));
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const TREASURY_PRIV = (process.env.TACIT_TREASURY_PRIVKEY || cfg.treasury_privkey || '').toLowerCase().trim();
if (!/^[0-9a-f]{64}$/.test(TREASURY_PRIV)) {
  console.error('treasury_privkey must be 64 hex chars (set via env var TACIT_TREASURY_PRIVKEY or config field)');
  process.exit(1);
}
const DROP_RECORD_PATH = resolve(cfg.drop_record_path || './drop-export.json');
if (!existsSync(DROP_RECORD_PATH)) {
  console.error(`drop record not found: ${DROP_RECORD_PATH}`);
  console.error(`Export it from the dapp's Drops tab → click your saved drop → Export JSON.`);
  process.exit(1);
}
const drop = JSON.parse(readFileSync(DROP_RECORD_PATH, 'utf8'));
const WORKER_BASE = (cfg.worker_base || '').replace(/\/+$/, '');
const NETWORK_NAME = drop.network || cfg.network || 'signet';
if (NETWORK_NAME !== 'signet' && NETWORK_NAME !== 'mainnet') {
  console.error(`network must be "signet" or "mainnet" (got "${NETWORK_NAME}")`);
  process.exit(1);
}
const INTERVAL_SEC = Number.isInteger(cfg.interval_sec) ? cfg.interval_sec : 600;
const MAX_BATCHES_PER_RUN = Number.isInteger(cfg.max_batches_per_run) ? cfg.max_batches_per_run : 50;
const MIN_TREASURY_SATS = Number.isInteger(cfg.min_treasury_sats) ? cfg.min_treasury_sats : 5000;
const MIN_QUEUE_TO_BROADCAST = Number.isInteger(cfg.min_queue_to_broadcast) ? cfg.min_queue_to_broadcast : 1;
const REQUIRE_ETH_SIGS = cfg.require_eth_sigs !== false;
const REQUIRE_FUNDING = cfg.require_funding !== false;  // default: require recipient tip per claim
const MIN_FUNDING_SATS = Number.isInteger(cfg.min_funding_sats) ? cfg.min_funding_sats : 3000;
// Confirmation threshold for funding txs. Mempool-only txs can be RBF'd to
// remove the treasury output AFTER we credit the claim, so we refuse to
// accept a funding_txid until it has confirmed. Default 1 conf is enough to
// close the RBF window (BIP-125 stops being valid once a tx confirms);
// raising this to 2-3 hedges against tip-state reorgs at the cost of slower
// fulfilment turnaround.
const MIN_FUNDING_CONFIRMATIONS = Number.isInteger(cfg.min_funding_confirmations)
  ? Math.max(1, cfg.min_funding_confirmations) : 1;
const STATE_PATH = resolve(cfg.state_path || `./fulfiller-state-${drop.merkle_root_hex.slice(0, 12)}.json`);

// ---- Structured logger ----
function log(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  console.log(JSON.stringify(entry));
}

// ---- jsdom shim + dapp import ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: NETWORK_NAME === 'mainnet' ? 'http://localhost/' : 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
// Set network BEFORE importing tacit.js so its top-level `NET` initializer
// picks it up. The dapp reads `localStorage.tacit-network-v1` at load.
globalThis.localStorage.setItem('tacit-network-v1', NETWORK_NAME);

const DAPP_PATH = resolve(__dirname, '../dapp/tacit.js');
log('info', 'booting daemon', {
  config: CONFIG_PATH, network: NETWORK_NAME, dapp: DAPP_PATH,
  dry_run: DRY_RUN, interval_sec: INTERVAL_SEC, max_batches_per_run: MAX_BATCHES_PER_RUN,
});
const m = await import('file://' + DAPP_PATH);

// ---- Configure wallet from treasury privkey ----
// Bypass wallet.setPriv (which prompts for a passphrase). We're a daemon —
// the operator is responsible for env-var security; encryption-at-rest is
// not our threat model. Set priv/pub directly.
const privBytes = hexToBytes(TREASURY_PRIV);
m.wallet.priv = privBytes;
m.wallet.pub = secp.getPublicKey(privBytes, true);
const TREASURY_ADDR = bech32.encode(
  NETWORK_NAME === 'mainnet' ? 'bc' : 'tb',
  [0, ...bech32.toWords(ripemd160(sha256(m.wallet.pub)))],
);
log('info', 'treasury wallet loaded', {
  pubkey: bytesToHex(m.wallet.pub),
  address: TREASURY_ADDR,
});

// ---- Validate drop record ----
if (!drop.merkle_root_hex || !/^[0-9a-f]{64}$/.test(drop.merkle_root_hex)) {
  log('error', 'drop record missing/invalid merkle_root_hex'); process.exit(1);
}
if (!Array.isArray(drop.rows) || drop.rows.length === 0) {
  log('error', 'drop record has no rows[]'); process.exit(1);
}
const dropRows = drop.rows.map(r => ({
  index: Number(r.index),
  ethAddrHex: String(r.eth_address || '').replace(/^0x/i, '').toLowerCase(),
  ethAddrBytes: hexToBytes(String(r.eth_address || '').replace(/^0x/i, '').toLowerCase()),
  amount: BigInt(r.amount),
}));
// Re-derive the merkle root + verify it matches the record — defense-in-depth
// against an edited/tampered drop record before we sign anything against it.
const leaves = dropRows.map(r => m.airdropLeafHash(r.ethAddrBytes, r.amount, r.index));
const { root, layers } = m.buildAirdropMerkle(leaves);
const computedRootHex = bytesToHex(root);
if (computedRootHex !== drop.merkle_root_hex) {
  log('error', 'drop record root mismatch', { stored: drop.merkle_root_hex, computed: computedRootHex });
  process.exit(1);
}
log('info', 'drop validated', {
  asset: drop.asset_ticker, asset_id: drop.asset_id_hex,
  recipients: dropRows.length, root: drop.merkle_root_hex,
});

// ---- Load fulfilment state ----
let state = { fulfilled_leaves: {}, batches: [], consumed_funding: {} };
// consumed_funding: { "<funding_txid>": leaf_index } — daemon-side nullifier
// set that survives restarts. The worker also enforces uniqueness in KV, but
// keeping a local mirror means a daemon running against a fresh worker (or a
// worker whose KV got wiped) still won't double-credit a funding tx.
if (existsSync(STATE_PATH)) {
  try {
    const loaded = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    state = {
      fulfilled_leaves: loaded.fulfilled_leaves || {},
      batches: loaded.batches || [],
      consumed_funding: loaded.consumed_funding || {},
    };
  } catch (e) { log('warn', 'state file unreadable, starting fresh', { err: e.message }); }
}
// Surface pending entries left by a prior crash (broadcast may or may not
// have landed; daemon won't re-broadcast against `pending: true` leaves —
// verifyClaim treats them as fulfilled — but the operator must reconcile.
// Use the Drops tab's Cross-check (or mempool.space directly) to see whether
// the on-chain CXFER exists; then either fill in txid + drop the pending
// flag, or delete the entry from the state file to allow a retry.
{
  let pendingCount = 0;
  const pendingLeaves = [];
  for (const [li, f] of Object.entries(state.fulfilled_leaves || {})) {
    if (f && f.pending === true) {
      pendingCount++;
      if (pendingLeaves.length < 10) pendingLeaves.push(Number(li));
    }
  }
  if (pendingCount > 0) {
    log('warn', 'pending entries from prior cycle — daemon will NOT re-broadcast against these leaves', {
      count: pendingCount,
      sample: pendingLeaves,
      hint: 'Run Cross-check on the drop record; either fill in the txid + remove pending flag, or delete the entry from the state file to retry.',
    });
  }
}
function saveState() {
  // Atomic write: serialize to a sibling .tmp file, fsync via writeFileSync's
  // sync semantics, then rename onto the real path. POSIX rename is atomic
  // within a filesystem — readers either see the old complete file or the
  // new complete file, never a half-written one. Without this pattern, a
  // crash mid-write (SIGKILL, OOM, power loss) corrupts state and the
  // daemon refuses to start next time, losing the fulfilled-leaves ledger.
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ---- Worker queue helpers ----
async function pullQueue() {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 32; page++) {
    const url = `${WORKER_BASE}/airdrops/${drop.merkle_root_hex}/claims?network=${encodeURIComponent(NETWORK_NAME)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`worker GET ${r.status}`);
    const j = await r.json();
    for (const c of (j.claims || [])) out.push(c);
    cursor = j.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function deleteFromQueue(leafIndex) {
  if (DRY_RUN) return;
  const url = `${WORKER_BASE}/airdrops/${drop.merkle_root_hex}/claims/${leafIndex}?network=${encodeURIComponent(NETWORK_NAME)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) log('warn', 'queue delete failed', { leaf_index: leafIndex, status: r.status });
  } catch (e) { log('warn', 'queue delete threw', { leaf_index: leafIndex, err: e.message }); }
}

// ---- Per-claim verification ----
// Verify funding_txid: fetch the tx, confirm one of its outputs paid the
// treasury at least MIN_FUNDING_SATS, AND confirm the tx itself has at least
// MIN_FUNDING_CONFIRMATIONS — without the conf check, a recipient could send
// an RBF-enabled mempool tx, get their claim batched, then RBF the funding
// tx to remove the treasury output (recipient keeps tokens + sats; issuer
// absorbs the CXFER cost).
//
// Cache rules:
//   - confirmed-paid → cache permanently (`ok: true`)
//   - confirmed-not-paid (or malformed) → cache permanently (`ok: false`)
//   - unconfirmed-but-paid → cache temporarily; re-check next cycle once
//     the tx may have hit a block. Without this, an early `ok: true` cache
//     hit would skip re-verification forever and miss the RBF window.
//   - fetch failed → cache temporarily (transient API blip).
//
// Cap cache size with FIFO eviction. Without a cap, a long campaign fielding
// spam funding_txids leaks memory linearly in the count of attempted submissions.
const _fundingTxCache = new Map();  // txid → { ok, sats?, err?, confirmed?, transient? }
const _FUNDING_CACHE_MAX = 4096;
function _setFundingCache(txid, value) {
  if (_fundingTxCache.size >= _FUNDING_CACHE_MAX) {
    // FIFO: drop the oldest entry. Map iteration order is insertion order.
    const oldest = _fundingTxCache.keys().next().value;
    if (oldest !== undefined) _fundingTxCache.delete(oldest);
  }
  _fundingTxCache.set(txid, value);
}
async function _verifyFundingTx(fundingTxidHex) {
  // Permanent ok/no-pay decisions: trust the cache. Transient entries
  // (unconfirmed / fetch-failed) are re-checked so the daemon can pick up
  // when an unconfirmed tx confirms or an RBF replaces it.
  const cached = _fundingTxCache.get(fundingTxidHex);
  if (cached && !cached.transient) return cached;

  let tx;
  try { tx = await m.getTx(fundingTxidHex); }
  catch (e) {
    const v = { ok: false, err: `tx fetch failed: ${e.message?.slice(0, 80) || 'unknown'}`, transient: true };
    _setFundingCache(fundingTxidHex, v); return v;
  }
  if (!tx || !Array.isArray(tx.vout)) {
    const v = { ok: false, err: 'tx not found or malformed', transient: true };
    _setFundingCache(fundingTxidHex, v); return v;
  }
  // Sum any outputs paying the treasury address. Mempool.space returns the
  // scriptpubkey_address field on each vout for standard scripts.
  let paid = 0;
  for (const o of tx.vout) {
    if (o.scriptpubkey_address === TREASURY_ADDR) paid += (o.value || 0);
  }
  if (paid < MIN_FUNDING_SATS) {
    // Confirmed payment is short — permanent fail. Unconfirmed payment
    // short might still be supplemented by an RBF that raises the value;
    // either way the tip didn't meet the floor as observed, so we keep
    // refusing until the recipient re-tips (which produces a fresh txid).
    const v = { ok: false, err: `paid ${paid} sats, need ≥ ${MIN_FUNDING_SATS}` };
    _setFundingCache(fundingTxidHex, v); return v;
  }
  // Confirmation gate (closes the RBF attack). Mempool.space returns
  // tx.status = { confirmed: bool, block_height?, block_hash?, block_time? }.
  const confirmed = !!tx.status?.confirmed;
  if (!confirmed) {
    const v = {
      ok: false,
      err: `funding tx unconfirmed (RBF window) — wait ≥${MIN_FUNDING_CONFIRMATIONS} conf`,
      transient: true,
    };
    _setFundingCache(fundingTxidHex, v); return v;
  }
  // Note on confirmation depth > 1: mempool.space's /tx endpoint includes
  // block_height but not current tip-height, so a depth check requires a
  // second API call. The default MIN_FUNDING_CONFIRMATIONS=1 already closes
  // the RBF-after-broadcast attack (RBF stops being valid once a tx mines
  // into a block). If you want defense-in-depth against tip reorgs, raise
  // MIN_FUNDING_CONFIRMATIONS — but we cache as permanent at 1 conf, which
  // means a reorg that drops the funding tx into mempool wouldn't be
  // re-checked. For mainnet drops where reorg-resistance matters, set
  // MIN_FUNDING_CONFIRMATIONS to ≥3 and accept the slower turnaround.
  const v = { ok: true, sats: paid, confirmed: true };
  _setFundingCache(fundingTxidHex, v); return v;
}

async function verifyClaim(claim) {
  const leafIdx = Number(claim.leaf_index);
  if (!Number.isInteger(leafIdx) || leafIdx < 0 || leafIdx >= dropRows.length) {
    return { ok: false, reason: `leaf_index ${leafIdx} out of range` };
  }
  if (state.fulfilled_leaves[leafIdx]) {
    return { ok: false, reason: 'already fulfilled' };
  }
  const row = dropRows[leafIdx];
  const tacitPubHex = String(claim.tacit_pubkey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(tacitPubHex)) return { ok: false, reason: 'invalid tacit_pubkey' };
  // Merkle proof must verify against root.
  const leaf = leaves[leafIdx];
  const proof = m.airdropMerkleProof(layers, leafIdx);
  if (!m.verifyAirdropMerkleProof(leaf, proof, root)) {
    return { ok: false, reason: 'merkle proof fails' };
  }
  // Eth sig must recover to row's eth_address.
  if (claim.eth_sig) {
    const claimMsg = m.buildAirdropClaimMsg({
      rootHex: drop.merkle_root_hex,
      network: NETWORK_NAME,
      assetIdHex: drop.asset_id_hex,
      ethAddrHex: row.ethAddrHex,
      leafIndex: row.index,
      amount: row.amount,
      ticker: drop.asset_ticker || '?',
      decimals: drop.asset_decimals,
      tacitPubHex,
    });
    if (!m.verifyAirdropClaimSig(claimMsg, claim.eth_sig, row.ethAddrHex)) {
      return { ok: false, reason: 'eth_sig does not recover to row\'s eth_address' };
    }
  } else if (REQUIRE_ETH_SIGS) {
    return { ok: false, reason: 'no eth_sig and require_eth_sigs=true' };
  }
  // Funding tx check: each claim's seat in a batch must be paid for.
  // Without this, anyone could submit a claim and ride the treasury's
  // existing sats balance for free, depleting the pool that other
  // recipients funded for their own claims.
  let fundingTxid = String(claim.funding_txid || '').toLowerCase().replace(/^0x/, '');
  if (!fundingTxid) {
    if (REQUIRE_FUNDING) return { ok: false, reason: 'no funding_txid (require_funding=true) — recipient must tip the treasury and re-submit with the tip txid' };
  } else {
    if (!/^[0-9a-f]{64}$/.test(fundingTxid)) return { ok: false, reason: 'malformed funding_txid' };
    const consumedBy = state.consumed_funding[fundingTxid];
    if (consumedBy != null && consumedBy !== leafIdx) {
      return { ok: false, reason: `funding_txid already consumed by leaf_index ${consumedBy}` };
    }
    const fv = await _verifyFundingTx(fundingTxid);
    if (!fv.ok) return { ok: false, reason: `funding_txid invalid: ${fv.err}` };
  }
  return { ok: true, leafIndex: leafIdx, tacitPubHex, amount: row.amount, fundingTxid: fundingTxid || null };
}

// ---- Treasury readiness check ----
async function treasuryReady() {
  let utxos;
  try { utxos = await m.getUtxos(TREASURY_ADDR); }
  catch (e) { log('warn', 'getUtxos failed', { err: e.message }); return { ok: false, sats: null }; }
  const sats = utxos.reduce((s, u) => s + (u.value || 0), 0);
  if (sats < MIN_TREASURY_SATS) return { ok: false, sats };
  return { ok: true, sats };
}

// ---- Single broadcast cycle ----
async function broadcastOnce(batchesRemaining) {
  const queue = await pullQueue();
  if (queue.length === 0) { log('info', 'queue empty'); return 0; }
  // Filter to fulfilable + verify each.
  const verified = [];
  for (const c of queue) {
    if (verified.length >= 7) break;
    const v = await verifyClaim(c);
    if (v.ok) verified.push(v);
    else log('warn', 'claim rejected', { leaf_index: c.leaf_index, reason: v.reason });
  }
  if (verified.length < MIN_QUEUE_TO_BROADCAST) {
    log('info', 'queue below broadcast threshold', { verified: verified.length, threshold: MIN_QUEUE_TO_BROADCAST });
    return 0;
  }
  const tStatus = await treasuryReady();
  if (!tStatus.ok) {
    log('warn', 'treasury insufficient, skipping batch', { sats: tStatus.sats, min: MIN_TREASURY_SATS });
    return 0;
  }
  log('info', 'staging batch', {
    size: verified.length,
    leaves: verified.map(v => v.leafIndex),
    total_tac: verified.reduce((s, v) => s + v.amount, 0n).toString(),
    treasury_sats: tStatus.sats,
  });
  if (DRY_RUN) {
    log('info', 'DRY RUN — would have broadcast', { size: verified.length });
    return 0;
  }
  // Pre-broadcast fee check: assert treasury balance covers the actual
  // CXFER cost at the current fee rate. Without this, the daemon could
  // sign and broadcast a batch whose reveal-tx fee exceeds the sats
  // available — either the broadcast fails with "insufficient sats" or
  // succeeds at a fee that drains the treasury below the next batch's
  // floor. Default `min_treasury_sats` is just a static lower bound; this
  // is the dynamic one that adapts to the actual recipient count + fee rate.
  let feeRateForCheck;
  try { feeRateForCheck = await m.getFeeRate(); }
  catch (e) { log('warn', 'getFeeRate failed, skipping batch', { err: e.message }); return 0; }
  const m_outs = verified.length + 1;  // K recipients + 1 change output
  const bpM = m_outs <= 2 ? 2 : m_outs <= 4 ? 4 : 8;
  const estRevealFee = m.feeFor(m.estCXferRevealVb({ m: bpM, numAssetIn: 4, hasSatsChange: true }), feeRateForCheck);
  const estCommitFee = m.feeFor(m.estCommitVb(2), feeRateForCheck);
  const estBatchCost = estCommitFee + estRevealFee + (verified.length + 1) * m.DUST + 1000;
  if (tStatus.sats < estBatchCost) {
    log('warn', 'treasury below estimated batch cost, skipping', {
      treasury_sats: tStatus.sats,
      estimated_batch_cost: estBatchCost,
      fee_rate: feeRateForCheck,
      shortfall: estBatchCost - tStatus.sats,
    });
    return 0;
  }
  // Re-check asset balance against batch total before signing — guards
  // against the case where the treasury wallet was drained out-of-band.
  m.invalidateHoldingsCache();
  const holdings = await m.scanHoldings(true);
  const h = holdings.get(drop.asset_id_hex);
  const batchTotal = verified.reduce((s, v) => s + v.amount, 0n);
  if (!h || h.balance < batchTotal) {
    log('error', 'treasury TAC balance insufficient', {
      balance: h ? h.balance.toString() : '0',
      batch_total: batchTotal.toString(),
    });
    return 0;
  }
  // Build + broadcast. allowDuplicateRecipients=true mirrors the dapp's
  // fulfilment path (two eth addrs can legitimately consolidate to one tacit pub).
  const recipients = verified.map(v => ({ pubHex: v.tacitPubHex, amount: v.amount }));
  // Phase-1: write pending entries to disk BEFORE broadcasting. Without this,
  // a crash (SIGKILL / OOM / power loss) between buildAndBroadcastCXferMulti
  // returning success and saveState() completing would leave the CXFER on-
  // chain but state empty — next cycle would re-broadcast the same leaves
  // and double-pay the recipients. With phase-1 in place, verifyClaim sees
  // the pending entry as "already fulfilled" on restart and refuses to
  // re-broadcast; the operator reconciles via Cross-check + manual edit.
  const pendingNow = Math.floor(Date.now() / 1000);
  for (const v of verified) {
    state.fulfilled_leaves[v.leafIndex] = {
      tacit_pubkey: v.tacitPubHex,
      amount: v.amount.toString(),
      txid: null,
      fulfilled_at: pendingNow,
      funding_txid: v.fundingTxid || null,
      pending: true,
    };
    // Lock in the funding_txid → leaf binding pre-broadcast so a concurrent
    // racing claim citing the same tip is rejected even if our broadcast
    // crashes mid-flight.
    if (v.fundingTxid) state.consumed_funding[v.fundingTxid] = v.leafIndex;
  }
  saveState();

  let result;
  try {
    result = await m.buildAndBroadcastCXferMulti({
      assetIdHex: drop.asset_id_hex,
      recipients,
      allowDuplicateRecipients: true,
    });
  } catch (e) {
    // Broadcast failed — annotate pending entries with the error so the
    // operator can decide whether to clear them (broadcast didn't land) or
    // fill in the txid (broadcast landed but the post-step threw). We do
    // NOT auto-rollback: if the broadcast actually succeeded inside the
    // failing path, rolling back here would unblock a retry that double-
    // pays. Same posture as the dapp's manual fulfil path.
    const errMsg = String(e?.message || e).slice(0, 200);
    for (const v of verified) {
      const f = state.fulfilled_leaves[v.leafIndex];
      if (f && f.pending === true && f.txid == null) {
        f.pending_error = errMsg;
        f.pending_error_at = Math.floor(Date.now() / 1000);
      }
    }
    try { saveState(); } catch {}
    log('error', 'broadcast failed (pending entries kept for operator review)', {
      err: errMsg, leaves: verified.map(v => v.leafIndex),
    });
    return 0;
  }
  // Phase-2: flip pending → confirmed with the real txid.
  const now = Math.floor(Date.now() / 1000);
  for (const v of verified) {
    const f = state.fulfilled_leaves[v.leafIndex];
    if (f && f.pending === true) {
      f.txid = result.revealTxid;
      f.fulfilled_at = now;
      delete f.pending;
    }
  }
  state.batches.push({
    broadcast_at: now, size: verified.length, leaves: verified.map(v => v.leafIndex),
    commit_txid: result.commitTxid, reveal_txid: result.revealTxid,
  });
  saveState();
  log('info', 'batch broadcast', {
    size: verified.length, commit: result.commitTxid, reveal: result.revealTxid,
    leaves: verified.map(v => v.leafIndex),
  });
  // Clean up queue entries — best-effort, the local state is authoritative.
  await Promise.all(verified.map(v => deleteFromQueue(v.leafIndex)));
  return 1;
}

// ---- Main loop ----
let shutdown = false;
process.on('SIGINT', () => { log('info', 'SIGINT received, finishing current run'); shutdown = true; });
process.on('SIGTERM', () => { log('info', 'SIGTERM received, finishing current run'); shutdown = true; });

async function runOnce() {
  let broadcastedCount = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    if (shutdown) break;
    const n = await broadcastOnce(MAX_BATCHES_PER_RUN - i);
    if (n === 0) break;  // no more work or hit a guard
    broadcastedCount += n;
  }
  return broadcastedCount;
}

if (ONCE) {
  const n = await runOnce();
  log('info', 'one-shot run complete', { batches: n });
  process.exit(0);
} else {
  log('info', 'daemon active', { interval_sec: INTERVAL_SEC });
  while (!shutdown) {
    try {
      const n = await runOnce();
      log('info', 'cycle complete', { batches: n });
    } catch (e) {
      log('error', 'cycle threw', { err: e.message, stack: e.stack });
    }
    if (shutdown) break;
    // Sleep INTERVAL_SEC, but check shutdown every second.
    for (let s = 0; s < INTERVAL_SEC && !shutdown; s++) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  log('info', 'shutdown clean');
  process.exit(0);
}
