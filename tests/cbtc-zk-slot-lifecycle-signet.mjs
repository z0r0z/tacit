// cBTC.zk slot lifecycle — live signet smoke that closes the audit's
// last validation gap.
//
// What this proves (and no other harness does):
//   POOL_INIT → T_SLOT_MINT → cron index → /pools surfaces leaf with
//   kind='slot_mint' → dapp scanPools re-verifies via verifySlotLeafOnChain
//   → mixerAppendLeaf populates the local merkle tree → mixerGetMerkleProof
//   returns a non-null proof → buildAndBroadcastSlotBurn generates a real
//   Groth16 proof against the populated tree → reveal tx confirms → cron
//   indexes the nullifier → /pools surfaces it in the spent-set.
//
// This is the path the audit found broken: pre-fix, scanPools rejected
// every slot leaf because verifyMixerDepositKernelOnChain gated on
// env.opcode === T_DEPOSIT and slot envelopes use 0x43/0x44/0x45/0x46/0x47.
// With the fix in dapp.verifySlotLeafOnChain + scanPools kind-dispatch, the
// full lifecycle should round-trip.
//
// Pre-req:
//   .local/amm-e2e-signet-wallets.json  (gen-amm-e2e-signet-wallets.mjs)
//   founder ≥ 60k signet sats
//
// Resumable: persists to .local/cbtc-zk-slot-lifecycle-state.json. Each
// phase records its on-chain effect (txid, indexed status) so re-running
// after a cron tick advances to the next phase. To restart: rm that file.
//
// Phase tags in the log:
//   [pool-init] [slot-mint] [index] [scan] [proof] [slot-burn] [nullifier]
//
// Run: `node tests/cbtc-zk-slot-lifecycle-signet.mjs`

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
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cbtc-zk-slot-lifecycle-state.json');
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
function info(tag, msg) { console.log(`  [${tag}] ${msg}`); }
function ok(tag, msg) { console.log(`  [${tag}] ✓ ${msg}`); }
function step(n, t) { console.log(`\n--- Phase ${n}: ${t} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';

// Deterministic test asset_id — derived from a fixed seed so reruns hit
// the same pool. Distinct from any real CETCHed asset on the worker.
const TEST_SEED = 'cbtc-zk-slot-lifecycle-v1';
const TEST_ASSET_ID = bytesToHex(sha256(new TextEncoder().encode(TEST_SEED)));
const DENOM = 10_000n;  // 10k sats — cheap to mint + burn on signet

const state = loadState();

// Force the dapp to use FOUNDER's priv for all operations — mirrors the
// useWallet helper in amm-full-e2e-signet.mjs.
function useFounder() {
  dapp.wallet.priv = FOUNDER.priv;
  dapp.wallet.pub = FOUNDER.pub;
  try { dapp.invalidateHoldingsCache?.(); } catch {}
}

console.log(`\n${'='.repeat(70)}`);
console.log(`cBTC.zk slot lifecycle signet smoke`);
console.log(`${'='.repeat(70)}`);
console.log(`  worker:    ${WORKER_BASE}`);
console.log(`  founder:   ${FOUNDER.addr}`);
console.log(`  asset_id:  ${TEST_ASSET_ID}`);
console.log(`  denom:     ${DENOM} sats\n`);

useFounder();

// Transient-fetch-tolerant pool fetch. Cloudflare Workers occasionally
// EHOSTUNREACH / ETIMEDOUT for a few seconds at a time from cold node
// processes; retry-with-backoff lets the harness ride through those
// without losing the resumable state file.
async function workerGetPool() {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(`${WORKER_BASE}/pools/${TEST_ASSET_ID}/${DENOM}?network=signet`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`/pools HTTP ${r.status}`);
      return r.json();
    } catch (e) {
      lastErr = e;
      await sleep(2_000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function waitForPoolInit(maxMin = 15) {
  info('index', `polling /pools for init (up to ${maxMin}min)…`);
  for (let i = 0; i < maxMin * 2; i++) {
    try {
      const p = await workerGetPool();
      if (p && p.pool) return p;
    } catch (e) {
      info('index', `  · transient fetch error (${e.message?.slice(0, 60)}), retrying…`);
    }
    await sleep(30_000);
  }
  return null;
}

async function waitForLeaf(leafCommitHex, maxMin = 15) {
  info('index', `polling /pools for leaf ${leafCommitHex.slice(0, 16)}… (up to ${maxMin}min)…`);
  const target = leafCommitHex.toLowerCase();
  for (let i = 0; i < maxMin * 2; i++) {
    try {
      const p = await workerGetPool();
      if (p?.leaves?.some(l => (l.leaf_commitment || '').toLowerCase() === target)) {
        return p.leaves.find(l => (l.leaf_commitment || '').toLowerCase() === target);
      }
    } catch (e) {
      info('index', `  · transient fetch error (${e.message?.slice(0, 60)}), retrying…`);
    }
    await sleep(30_000);
  }
  return null;
}

async function waitForNullifier(nullifierHashHex, maxMin = 15) {
  info('index', `polling /pools for nullifier ${nullifierHashHex.slice(0, 16)}… (up to ${maxMin}min)…`);
  const target = nullifierHashHex.toLowerCase();
  for (let i = 0; i < maxMin * 2; i++) {
    try {
      const p = await workerGetPool();
      if (p?.nullifiers?.some(n => (n.nullifier_hash || '').toLowerCase() === target)) {
        return p.nullifiers.find(n => (n.nullifier_hash || '').toLowerCase() === target);
      }
    } catch (e) {
      info('index', `  · transient fetch error (${e.message?.slice(0, 60)}), retrying…`);
    }
    await sleep(30_000);
  }
  return null;
}

// =========================================================================
// Phase 1: POOL_INIT
// =========================================================================
step(1, 'POOL_INIT — register (asset_id, denom) on the mixer');
if (state.poolInit?.indexed) {
  ok('pool-init', `reusing pool init: ${state.poolInit.revealTxid?.slice(0, 16)}…`);
} else if (state.poolInit?.revealTxid) {
  info('pool-init', `reveal already broadcast: ${state.poolInit.revealTxid.slice(0, 16)}…`);
  const pool = await waitForPoolInit();
  if (!pool) fail('pool init never showed up in /pools after broadcast');
  state.poolInit.indexed = true;
  state.poolInit.initHeight = pool.pool.init_height;
  saveState(state);
  ok('pool-init', `indexed at height ${pool.pool.init_height}`);
} else {
  // Use bafy-e2e-* CIDs to match what other test pools use; the worker
  // doesn't gate on CID content at v1 init verification.
  info('pool-init', `broadcasting POOL_INIT…`);
  const r = await dapp.buildAndBroadcastPoolInit({
    assetIdHex: TEST_ASSET_ID,
    poolDenom: DENOM,
    vkCid: 'bafy-cbtc-zk-smoke-vk',
    ceremonyCid: 'bafy-cbtc-zk-smoke-ceremony',
    onProgress: (s) => info('pool-init', `  · ${s}`),
  });
  ok('pool-init', `reveal ${r.revealTxid.slice(0, 16)}…`);
  state.poolInit = { revealTxid: r.revealTxid };
  saveState(state);
  const pool = await waitForPoolInit();
  if (!pool) fail('pool init never showed up in /pools');
  state.poolInit.indexed = true;
  state.poolInit.initHeight = pool.pool.init_height;
  saveState(state);
  ok('pool-init', `indexed at height ${pool.pool.init_height}`);
}

// =========================================================================
// Phase 2: T_SLOT_MINT
// =========================================================================
step(2, 'T_SLOT_MINT — mint a fresh cBTC.zk slot into the pool');
if (state.slotMint?.indexed) {
  ok('slot-mint', `reusing slot mint: ${state.slotMint.revealTxid?.slice(0, 16)}…`);
} else if (state.slotMint?.revealTxid) {
  info('slot-mint', `reveal already broadcast: ${state.slotMint.revealTxid.slice(0, 16)}…`);
  const leaf = await waitForLeaf(state.slotMint.leafCommitHex);
  if (!leaf) fail('slot mint never showed up in /pools');
  state.slotMint.indexed = true;
  state.slotMint.indexedAtHeight = leaf.deposited_at_height;
  state.slotMint.indexedKind = leaf.kind;
  saveState(state);
  ok('slot-mint', `indexed at height ${leaf.deposited_at_height} with kind='${leaf.kind}'`);
} else {
  info('slot-mint', `broadcasting T_SLOT_MINT…`);
  const r = await dapp.buildAndBroadcastSlotMint({
    assetIdHex: TEST_ASSET_ID,
    denomination: DENOM,
    onProgress: (s) => info('slot-mint', `  · ${s}`),
  });
  ok('slot-mint', `reveal ${r.revealTxid.slice(0, 16)}…`);
  // The dapp records the slot in localStorage; recover the leafCommitmentHex.
  const recs = dapp.getSlotRecords();
  const slot = recs.find(s => s.mintTxid === r.revealTxid);
  if (!slot) fail('slot record missing post-mint');
  state.slotMint = {
    revealTxid: r.revealTxid,
    leafCommitHex: slot.leafCommitmentHex,
    slotRecord: slot,
  };
  saveState(state);
  const leaf = await waitForLeaf(slot.leafCommitmentHex);
  if (!leaf) fail('slot mint never indexed');
  state.slotMint.indexed = true;
  state.slotMint.indexedAtHeight = leaf.deposited_at_height;
  state.slotMint.indexedKind = leaf.kind;
  saveState(state);
  ok('slot-mint', `indexed at height ${leaf.deposited_at_height} with kind='${leaf.kind}'`);
}

// CRITICAL ASSERTION — the audit's headline finding. Pre-fix the worker
// indexed slot mints with kind='slot_mint' but the dapp's scanPools threw
// them away because they couldn't be re-verified by the T_DEPOSIT kernel
// path. Asserting the kind field here pins the contract on the wire.
if (state.slotMint.indexedKind !== 'slot_mint') {
  fail(`expected leaf.kind='slot_mint' on worker, got ${JSON.stringify(state.slotMint.indexedKind)}`);
}
ok('slot-mint', `worker emits leaf.kind='slot_mint' (pinned)`);

// =========================================================================
// Phase 3: scanPools — the fix's surface
// =========================================================================
step(3, 'scanPools — populate the local mixer tree with the slot leaf');
info('scan', `calling dapp.scanPools()…`);
const scanResult = await dapp.scanPools();
if (scanResult?.error) fail(`scanPools error: ${scanResult.error}`);
ok('scan', `pools=${scanResult.pools} registered=${scanResult.registered} leavesApplied=${scanResult.leavesApplied}`);

if (!dapp.mixerIsPoolRegistered(TEST_ASSET_ID, DENOM)) {
  fail(`pool (${TEST_ASSET_ID.slice(0,16)}…, ${DENOM}) not registered locally after scanPools`);
}
ok('scan', `pool registered in local registry`);

// =========================================================================
// Phase 4: merkle proof against the local tree — pre-fix this was null.
// =========================================================================
step(4, 'mixerGetMerkleProof — confirm the slot leaf is in the local tree');
const leafBytes = hexToBytes(state.slotMint.leafCommitHex);
const proof = dapp.buildMixerMerkleProof
  ? dapp.buildMixerMerkleProof(TEST_ASSET_ID, DENOM, leafBytes)
  : null;
if (!proof) {
  fail(`buildMixerMerkleProof returned null — local tree never got the slot leaf. This is the PRE-FIX failure mode. The fix (verifySlotLeafOnChain dispatch in scanPools) is not in effect.`);
}
ok('proof', `merkle proof generated (path length=${proof.pathElements?.length ?? '?'}, indices=${proof.pathIndices?.length ?? '?'})`);

// =========================================================================
// Phase 5: T_SLOT_BURN — full Groth16 proof, real broadcast
// =========================================================================
step(5, 'T_SLOT_BURN — generate Groth16 proof + broadcast against the live tree');
// Ensure the slotRecord is in localStorage (resume path may have lost it).
try { dapp.saveSlotRecord(state.slotMint.slotRecord); } catch {}
if (state.slotBurn?.indexed) {
  ok('slot-burn', `reusing slot burn: ${state.slotBurn.revealTxid?.slice(0, 16)}…`);
} else if (state.slotBurn?.revealTxid) {
  info('slot-burn', `reveal already broadcast: ${state.slotBurn.revealTxid.slice(0, 16)}…`);
  const n = await waitForNullifier(state.slotBurn.nullifierHashHex);
  if (!n) fail('slot burn nullifier never showed up in /pools');
  state.slotBurn.indexed = true;
  state.slotBurn.indexedAtHeight = n.withdrawn_at_height;
  saveState(state);
  ok('slot-burn', `nullifier indexed at height ${n.withdrawn_at_height}`);
} else {
  info('slot-burn', `building proof + broadcasting…`);
  const r = await dapp.buildAndBroadcastSlotBurn({
    slotRecord: state.slotMint.slotRecord,
    onProgress: (s) => info('slot-burn', `  · ${s}`),
  });
  ok('slot-burn', `reveal ${r.revealTxid.slice(0, 16)}…`);
  state.slotBurn = {
    revealTxid: r.revealTxid,
    nullifierHashHex: r.nullifierHashHex || null,
  };
  saveState(state);
  if (!state.slotBurn.nullifierHashHex) {
    // Derive nullifier hash from the slot record so we can poll for it.
    const slot = state.slotMint.slotRecord;
    const nullifierPreimage = hexToBytes(slot.nullifierPreimageHex);
    const nullifierHash = dapp.computeNullifierHash(nullifierPreimage);
    state.slotBurn.nullifierHashHex = bytesToHex(nullifierHash);
    saveState(state);
  }
  const n = await waitForNullifier(state.slotBurn.nullifierHashHex);
  if (!n) fail('slot burn nullifier never indexed');
  state.slotBurn.indexed = true;
  state.slotBurn.indexedAtHeight = n.withdrawn_at_height;
  saveState(state);
  ok('slot-burn', `nullifier indexed at height ${n.withdrawn_at_height}`);
}

// =========================================================================
// Phase 6: double-spend probe — second burn must fail at pre-flight.
// =========================================================================
step(6, 'double-spend probe — pre-flight nullifier check must reject re-burn');
// Refresh local nullifier set so mixerIsNullifierSpent picks up the
// just-indexed nullifier. scanPools rehydrates both leaves and nullifiers.
await dapp.scanPools();
let preflightRejected = false;
try {
  await dapp.buildAndBroadcastSlotBurn({
    slotRecord: state.slotMint.slotRecord,
    onProgress: () => {},
  });
} catch (e) {
  if (/already redeemed|nullifier in spent-set/i.test(e.message)) {
    preflightRejected = true;
    ok('nullifier', `pre-flight refused re-burn: "${e.message.slice(0, 80)}…"`);
  } else {
    info('nullifier', `re-burn threw (unrelated): ${e.message.slice(0, 100)}`);
  }
}
if (!preflightRejected) {
  fail('second burn attempt was NOT pre-flight-rejected. Double-spend defense is leaky.');
}

// =========================================================================
console.log(`\n=== cBTC.zk slot lifecycle signet smoke COMPLETE ===\n`);
console.log(`State preserved at ${STATE_FILE}.`);
console.log(`Mempool: https://mempool.space/signet/address/${FOUNDER.addr}`);
console.log(`\nLifecycle summary:`);
console.log(`  pool init:     ${state.poolInit.revealTxid.slice(0, 16)}…  (height ${state.poolInit.initHeight})`);
console.log(`  slot mint:     ${state.slotMint.revealTxid.slice(0, 16)}…  (height ${state.slotMint.indexedAtHeight}, kind='${state.slotMint.indexedKind}')`);
console.log(`  merkle proof:  populated from local tree (was null pre-fix)`);
console.log(`  slot burn:     ${state.slotBurn.revealTxid.slice(0, 16)}…  (height ${state.slotBurn.indexedAtHeight})`);
console.log(`  double-spend:  rejected at pre-flight`);
console.log(`\nGAP CLOSED: live end-to-end through verifySlotLeafOnChain dispatch.`);
