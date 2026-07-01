// AMM end-to-end signet smoke test.
//
// Resumable harness (state at .local/amm-signet-state.json) that:
//   1. Pre-flight: load wallet, check signet sats balance.
//   2. CETCH asset_A (ticker: "amm-smoke-A", supply: 1_000_000 base units).
//   3. CETCH asset_B (ticker: "amm-smoke-B", supply: 1_000_000 base units).
//   4. POOL_INIT the (A, B) pair at fee_bps=30 with deltaA=100_000,
//      deltaB=300_000 (initial price 3:1).
//   5. Verify the pool appears on the worker after confirmation depth.
//
// Each phase is idempotent — re-running picks up where it left off
// (read state file). To start over: rm .local/amm-signet-state.json
//
// Pre-req:
//   .local/amm-signet-wallet.json  (run gen-amm-signet-wallet.mjs first)
//   wallet funded with ≥ 150_000 signet sats
//
// Optional env:
//   FEE_BPS              0..1000 (default 30)
//   DELTA_A              base units of asset_A (default 100_000)
//   DELTA_B              base units of asset_B (default 300_000)
//   POOL_VK_CID          IPFS CID (default 'bafy-smoke-vk')
//   POOL_CEREMONY_CID    IPFS CID (default 'bafy-smoke-ceremony')
//   POOL_CAPABILITY_FLAGS u8 (default 0)
//   SKIP_VERIFY=1        don't poll worker for pool registration
//
// Run:  node tests/amm-smoke-signet.mjs

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'amm-signet-state.json');
const WALLET_FILE = path.join(STATE_DIR, 'amm-signet-wallet.json');

if (!existsSync(WALLET_FILE)) {
  console.error(`✗ Wallet not found at ${WALLET_FILE}`);
  console.error(`  Run: node tests/gen-amm-signet-wallet.mjs`);
  process.exit(1);
}
const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const PRIV = hexToBytes(W.priv_hex);
const PUB = secp.getPublicKey(PRIV, true);

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const FEE_BPS = Number(process.env.FEE_BPS || 30);
const DELTA_A = BigInt(process.env.DELTA_A || 100_000n);
const DELTA_B = BigInt(process.env.DELTA_B || 300_000n);
const POOL_VK_CID = process.env.POOL_VK_CID || 'bafy-smoke-vk';
const POOL_CEREMONY_CID = process.env.POOL_CEREMONY_CID || 'bafy-smoke-ceremony';
const POOL_CAPABILITY_FLAGS = Number(process.env.POOL_CAPABILITY_FLAGS || 0);
const SKIP_VERIFY = process.env.SKIP_VERIFY === '1';

const dapp = await import('../dapp/tacit.js');
const bjj = await import('./amm-bjj.mjs');
const sigma = await import('./amm-sigma-xcurve.mjs');
const env_mod = await import('./amm-envelope.mjs');
const kernel = await import('./amm-kernel.mjs');
const asset_mod = await import('./amm-asset.mjs');
const clearing = await import('./amm-clearing.mjs');
const minliq = await import('./amm-min-liq.mjs');
const bp = await import('./bulletproofs.mjs');

// Pre-mark backup ack so carve helpers don't prompt
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}

function setWallet() {
  dapp.wallet.priv = PRIV;
  dapp.wallet.pub = PUB;
  dapp.invalidateHoldingsCache();
}

const state = loadState();

console.log(`\n=== AMM signet smoke test ===\n`);
console.log(`  address:     ${W.address}`);
console.log(`  delta A:     ${DELTA_A}`);
console.log(`  delta B:     ${DELTA_B}`);
console.log(`  fee bps:     ${FEE_BPS}`);
console.log(`  capability:  0x${POOL_CAPABILITY_FLAGS.toString(16).padStart(2, '0')}`);
console.log(`  vk_cid:      ${POOL_VK_CID}`);
console.log(`  ceremony:    ${POOL_CEREMONY_CID}`);

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight (sats balance)');
setWallet();
const utxos = await dapp.getUtxos(W.address);
const sats = utxos.reduce((s, u) => s + u.value, 0);
info(`signet sats balance: ${sats.toLocaleString()}`);
// Signet is typically 1 sat/vbyte; CETCH × 2 + POOL_INIT consumes ~15k
// total including DUST locked in outputs. 30k gives 2x slack.
if (sats < 30_000) {
  fail(`Underfunded: need ≥ 30,000 sats. Top up at https://signet.bublina.eu.org/ → ${W.address}`);
}
ok(`pre-flight passed`);

// ---- Phase 2: CETCH asset_A ----
step(2, 'CETCH asset_A');
if (state.assetA?.asset_id_hex) {
  ok(`reusing asset_A from prior run: ${state.assetA.ticker} (${state.assetA.asset_id_hex.slice(0, 16)}…)`);
} else {
  setWallet();
  info(`CETCHing "amm-smoke-A" (supply 1,000,000 base units, decimals 0)…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'amm-smoke-A',
    supplyBase: 1_000_000n,
    decimals: 0,
    mintable: false,
  });
  // CETCH gives asset_id = SHA256(reverse(reveal_txid) || vout_le32 with vout=0)
  const reveal_txid_BE = new Uint8Array(32);
  const txid_hex = r.revealTxid;
  for (let i = 0; i < 32; i++) reveal_txid_BE[i] = parseInt(txid_hex.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, 0, true);
  const assetIdBytes = sha256(concatBytes(reveal_txid_BE, voutLE));
  const asset_id_hex = bytesToHex(assetIdBytes);
  state.assetA = {
    ticker: 'amm-smoke-A',
    supplyBase: 1_000_000,
    decimals: 0,
    cetch_txid: r.revealTxid,
    asset_id_hex,
  };
  saveState(state);
  ok(`asset_A CETCHed: ${asset_id_hex.slice(0, 16)}… (reveal: ${r.revealTxid.slice(0, 16)}…)`);
  info(`waiting 30s for confirmation propagation…`);
  await sleep(30000);
}

// ---- Phase 3: CETCH asset_B ----
step(3, 'CETCH asset_B');
if (state.assetB?.asset_id_hex) {
  ok(`reusing asset_B from prior run: ${state.assetB.ticker} (${state.assetB.asset_id_hex.slice(0, 16)}…)`);
} else {
  setWallet();
  // Mine UTXO change for a 2nd CETCH — give the network a beat after asset_A.
  info(`refreshing UTXO cache…`);
  dapp.invalidateHoldingsCache();
  await sleep(5000);
  info(`CETCHing "amm-smoke-B" (supply 1,000,000 base units, decimals 0)…`);
  const r = await dapp.buildAndBroadcastCEtch({
    ticker: 'amm-smoke-B',
    supplyBase: 1_000_000n,
    decimals: 0,
    mintable: false,
  });
  const reveal_txid_BE = new Uint8Array(32);
  const txid_hex = r.revealTxid;
  for (let i = 0; i < 32; i++) reveal_txid_BE[i] = parseInt(txid_hex.slice((31 - i) * 2, (31 - i) * 2 + 2), 16);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, 0, true);
  const assetIdBytes = sha256(concatBytes(reveal_txid_BE, voutLE));
  const asset_id_hex = bytesToHex(assetIdBytes);
  state.assetB = {
    ticker: 'amm-smoke-B',
    supplyBase: 1_000_000,
    decimals: 0,
    cetch_txid: r.revealTxid,
    asset_id_hex,
  };
  saveState(state);
  ok(`asset_B CETCHed: ${asset_id_hex.slice(0, 16)}… (reveal: ${r.revealTxid.slice(0, 16)}…)`);
  info(`waiting 60s for asset_A + asset_B to confirm + holdings to scan…`);
  await sleep(60000);
}

// ---- Phase 4: POOL_INIT ----
step(4, 'POOL_INIT (A + B at fee_bps=30)');
if (state.poolInit?.reveal_txid) {
  ok(`reusing POOL_INIT from prior run: pool ${state.poolInit.pool_id_hex.slice(0, 16)}… (reveal: ${state.poolInit.reveal_txid.slice(0, 16)}…)`);
} else {
  setWallet();
  dapp.invalidateHoldingsCache();
  await sleep(5000);

  // Pre-flight holdings
  const holdings = await dapp.scanHoldings();
  if (!holdings || !(holdings instanceof Map)) fail('holdings scan failed');
  const hA = holdings.get(state.assetA.asset_id_hex);
  const hB = holdings.get(state.assetB.asset_id_hex);
  if (!hA || hA.balance < DELTA_A) {
    fail(`asset_A balance ${hA?.balance ?? 0} < DELTA_A ${DELTA_A}. Wait longer for CETCH confirmations OR drop DELTA_A env.`);
  }
  if (!hB || hB.balance < DELTA_B) {
    fail(`asset_B balance ${hB?.balance ?? 0} < DELTA_B ${DELTA_B}.`);
  }
  ok(`asset_A balance: ${hA.balance} (need ${DELTA_A})`);
  ok(`asset_B balance: ${hB.balance} (need ${DELTA_B})`);

  // Canonical pair ordering — derivePoolId requires lex-canonical (low, high).
  const [low, high] = asset_mod.canonicalAssetPair(state.assetA.asset_id_hex, state.assetB.asset_id_hex);
  const swapped = bytesToHex(low) !== state.assetA.asset_id_hex;
  const canonAHex = bytesToHex(low);
  const canonBHex = bytesToHex(high);
  const canonDeltaA = swapped ? DELTA_B : DELTA_A;
  const canonDeltaB = swapped ? DELTA_A : DELTA_B;

  info(`canonical asset_A: ${canonAHex.slice(0, 16)}…`);
  info(`canonical asset_B: ${canonBHex.slice(0, 16)}…`);
  info(`canonical delta_A: ${canonDeltaA}`);
  info(`canonical delta_B: ${canonDeltaB}`);

  const poolId = asset_mod.derivePoolId(low, high, FEE_BPS, POOL_CAPABILITY_FLAGS);
  const poolIdHex = bytesToHex(poolId);
  const lpAssetIdBytes = asset_mod.deriveLpAssetId(poolId);
  const lpAssetIdHex = bytesToHex(lpAssetIdBytes);
  info(`pool_id: ${poolIdHex}`);
  info(`lp_asset_id: ${lpAssetIdHex}`);

  // Carve exact UTXOs
  info(`carving exact ${canonDeltaA} of asset_A…`);
  const carvedA = await dapp.carveExactAmount({ assetIdHex: canonAHex, amount: canonDeltaA });
  if (!carvedA) fail('carveExactAmount asset_A failed');
  info(`carving exact ${canonDeltaB} of asset_B…`);
  const carvedB = await dapp.carveExactAmount({ assetIdHex: canonBHex, amount: canonDeltaB });
  if (!carvedB) fail('carveExactAmount asset_B failed');

  // Initial shares
  const initShares = clearing.lpInitShares(canonDeltaA, canonDeltaB, minliq.MINIMUM_LIQUIDITY);
  info(`founder shares: ${initShares.founder_shares} (locked: ${initShares.locked_shares})`);

  // HMAC-derived blindings (deterministic per pool — idempotent retries)
  const SEED_KEY = hmac(sha256, PRIV, new TextEncoder().encode('tacit-amm-xcurve-seed-v1'));
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r_share_secp = (BigInt('0x' + bytesToHex(hmac(sha256, PRIV, concatBytes(
    new TextEncoder().encode('tacit-amm-lp-share-secp-v1'), poolId,
  )))) % SECP_N) || 1n;
  const r_share_BJJ = (BigInt('0x' + bytesToHex(hmac(sha256, PRIV, concatBytes(
    new TextEncoder().encode('tacit-amm-lp-share-bjj-v1'), poolId,
  )))) % bjj.N_BJJ) || 1n;

  const C_share_secp_pt = bp.pedersenCommit(initShares.founder_shares, r_share_secp);
  const C_share_BJJ_pt = bjj.pedersenBJJ(initShares.founder_shares, r_share_BJJ);
  const C_share_secp_bytes = bp.pointToBytes(C_share_secp_pt);
  const C_share_BJJ_bytes = bjj.packPoint(C_share_BJJ_pt);

  info(`generating XCurve sigma proof…`);
  const { proof: xcurveProof } = sigma.proveXCurveDeterministic({
    a: initShares.founder_shares,
    r_secp: r_share_secp,
    r_BJJ: r_share_BJJ,
    seedKey: SEED_KEY,
    C_secp: C_share_secp_pt,
    C_BJJ: C_share_BJJ_pt,
  });

  info(`signing kernel sigs (A + B sides)…`);
  const kSigA = kernel.lpAddKernelSign({
    variant: 1, poolId,
    assetX: low, deltaX: canonDeltaA, shareAmount: initShares.founder_shares,
    shareCSecpBytes: C_share_secp_bytes,
    inputsX: [{ txid: carvedA.utxo.txid, vout: carvedA.utxo.vout }],
    inputCommitments: [bp.pedersenCommit(carvedA.amount, BigInt(carvedA.blinding))],
    excessX: BigInt(carvedA.blinding),
  });
  const kSigB = kernel.lpAddKernelSign({
    variant: 1, poolId,
    assetX: high, deltaX: canonDeltaB, shareAmount: initShares.founder_shares,
    shareCSecpBytes: C_share_secp_bytes,
    inputsX: [{ txid: carvedB.utxo.txid, vout: carvedB.utxo.vout }],
    inputCommitments: [bp.pedersenCommit(carvedB.amount, BigInt(carvedB.blinding))],
    excessX: BigInt(carvedB.blinding),
  });

  const payload = env_mod.encodeLpAdd({
    variant: 1,
    assetA: low, assetB: high,
    deltaA: canonDeltaA, deltaB: canonDeltaB,
    shareAmount: initShares.founder_shares,
    shareCSecp: C_share_secp_bytes,
    shareCBJJ: C_share_BJJ_bytes,
    shareXcurveSigma: xcurveProof,
    kernelSigA: kSigA, kernelSigB: kSigB,
    feeBps: FEE_BPS,
    vkCid: POOL_VK_CID,
    ceremonyCid: POOL_CEREMONY_CID,
    arbiterPubkeys: [], launcherSigs: [],
    protocolFeeAddress: new Uint8Array(33),
    protocolFeeBps: 0,
    poolMetaUri: '',
    poolCapabilityFlags: POOL_CAPABILITY_FLAGS,
    proof: new Uint8Array(256),
  });
  info(`payload encoded: ${payload.length} bytes`);

  // Bitcoin tx
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
  const tapLeaf = dapp.tapLeafHash(envelopeScript);
  const TAP_NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
  const { Q_xonly, parity } = dapp.tweakedOutputKey(TAP_NUMS, tapLeaf);
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(TAP_NUMS, parity);
  const { p2wpkh: minLiqP2wpkh } = minliq.deriveMinLiqNumsRecipient(poolId);
  const minLiqSpk = concatBytes(new Uint8Array([0x00, 0x14]), minLiqP2wpkh);
  const founderSpk = concatBytes(new Uint8Array([0x00, 0x14]), dapp.hash160(PUB));
  const DUST = dapp.DUST;

  const revealVb = 11 + 41 + 41 + 41 + 31 + 31
    + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34 + 109 + 109) / 4);
  const feeRate = await dapp.getFeeRate();
  const revealFee = dapp.feeFor(revealVb, feeRate);
  let commitValue = Math.max(DUST, DUST + DUST + revealFee - DUST - DUST);

  const allUtxos = await dapp.getUtxos(dapp.wallet.address());
  const assetKeys = new Set([
    `${carvedA.utxo.txid}:${carvedA.utxo.vout}`,
    `${carvedB.utxo.txid}:${carvedB.utxo.vout}`,
  ]);
  const satsAvail = allUtxos
    .filter(u => !assetKeys.has(`${u.txid}:${u.vout}`) && u.value > DUST)
    .sort((a, b) => b.value - a.value);
  if (satsAvail.length === 0) fail('no plain-sats UTXOs to fund POOL_INIT commit');
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of satsAvail) {
    picked.push(u); total += u.value;
    commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) {
    fail(`insufficient sats for commit: need ${commitValue + commitFee}, have ${total}`);
  }
  const satsChange = total - commitValue - commitFee;
  const wpkhSpk = concatBytes(new Uint8Array([0x00, 0x14]), dapp.hash160(PUB));
  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (satsChange >= DUST) commitOutputs.push({ value: satsChange, script: wpkhSpk });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(dapp.serializeTx(commitTx));
  const commitTxid = dapp.txid(commitTx);

  const revealTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
      { txid: carvedA.utxo.txid, vout: carvedA.utxo.vout, sequence: 0xfffffffd, witness: [] },
      { txid: carvedB.utxo.txid, vout: carvedB.utxo.vout, sequence: 0xfffffffd, witness: [] },
    ],
    outputs: [
      { value: DUST, script: founderSpk },
      { value: DUST, script: minLiqSpk },
    ],
  };
  const revealPrevouts = [
    { value: commitValue, script: commitSpk },
    { value: DUST, script: wpkhSpk },
    { value: DUST, script: wpkhSpk },
  ];
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, revealPrevouts, envelopeScript, cb);
  revealTx.inputs[1].witness = dapp.signP2wpkhInput(revealTx, 1, DUST);
  revealTx.inputs[2].witness = dapp.signP2wpkhInput(revealTx, 2, DUST);
  const revealHex = bytesToHex(dapp.serializeTx(revealTx));
  const revealTxid = dapp.txid(revealTx);

  info(`broadcasting commit (${commitTxid.slice(0, 16)}…)…`);
  await dapp.broadcast(commitHex);
  info(`broadcasting reveal (${revealTxid.slice(0, 16)}…)…`);
  await dapp.broadcastWithRetry(revealHex);
  try {
    dapp.recordOpening(revealTxid, 0, lpAssetIdHex, initShares.founder_shares, r_share_secp);
  } catch {}

  state.poolInit = {
    pool_id_hex: poolIdHex,
    lp_asset_id_hex: lpAssetIdHex,
    canonical_asset_a: canonAHex,
    canonical_asset_b: canonBHex,
    canonical_delta_a: canonDeltaA.toString(),
    canonical_delta_b: canonDeltaB.toString(),
    fee_bps: FEE_BPS,
    founder_shares: initShares.founder_shares.toString(),
    locked_shares: initShares.locked_shares.toString(),
    commit_txid: commitTxid,
    reveal_txid: revealTxid,
  };
  saveState(state);
  ok(`POOL_INIT broadcast: pool ${poolIdHex.slice(0, 16)}…`);
  info(`reveal txid: ${revealTxid}`);
  info(`waiting 90s for confirmation…`);
  await sleep(90000);
}

// ---- Phase 5: verify pool on worker ----
if (SKIP_VERIFY) {
  console.log(`\n=== Smoke test complete (verify skipped) ===\n`);
  console.log(`  pool_id: ${state.poolInit.pool_id_hex}`);
  console.log(`  reveal txid: ${state.poolInit.reveal_txid}`);
  console.log(`  https://mempool.space/signet/tx/${state.poolInit.reveal_txid}`);
  process.exit(0);
}

step(5, 'verify pool registration on worker');
const WORKER_BASE = process.env.TACIT_WORKER_BASE || process.env.WORKER_BASE || 'https://api.tacit.finance';
const POOL_URL = `${WORKER_BASE}/amm/pool/${state.poolInit.pool_id_hex}?network=signet`;
info(`polling ${POOL_URL}`);
let registered = false;
const POLL_ATTEMPTS = 20;
const POLL_DELAY_MS = 30_000;
for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
  try {
    const r = await fetch(POOL_URL);
    if (r.ok) {
      const j = await r.json();
      if (j && j.pool_id === state.poolInit.pool_id_hex) {
        registered = true;
        info(`pool record: ${JSON.stringify(j, null, 2)}`);
        break;
      }
    } else if (r.status === 404) {
      info(`attempt ${attempt}/${POLL_ATTEMPTS}: not yet registered`);
    } else {
      info(`attempt ${attempt}/${POLL_ATTEMPTS}: HTTP ${r.status}`);
    }
  } catch (e) {
    info(`attempt ${attempt}/${POLL_ATTEMPTS}: ${e.message}`);
  }
  if (attempt < POLL_ATTEMPTS) await sleep(POLL_DELAY_MS);
}
if (registered) {
  ok(`pool registered on worker`);
  console.log(`\n=== Smoke test PASSED ===\n`);
  console.log(`  pool_id:     ${state.poolInit.pool_id_hex}`);
  console.log(`  lp_asset_id: ${state.poolInit.lp_asset_id_hex}`);
  console.log(`  reveal txid: ${state.poolInit.reveal_txid}`);
  console.log(`\nWhat to test next:`);
  console.log(`  - Run a T_SWAP_VAR against this pool via the dapp UI`);
  console.log(`    (or buildAndBroadcastSwapVarSelfFulfill headless)`);
  console.log(`  - Verify pool reserves update after the swap`);
} else {
  console.log(`\n⚠ Pool did NOT register on worker within ${POLL_ATTEMPTS * POLL_DELAY_MS / 60000} minutes.`);
  console.log(`   Possible causes:`);
  console.log(`     - Worker doesn't have the AMM validators deployed yet`);
  console.log(`     - Reveal tx still unconfirmed (check https://mempool.space/signet/tx/${state.poolInit.reveal_txid})`);
  console.log(`     - Worker /amm/pool endpoint doesn't exist (ships with the AMM rollout)`);
  console.log(`   Re-run this script later (state.json persists; phase 5 will retry).`);
  process.exit(1);
}
