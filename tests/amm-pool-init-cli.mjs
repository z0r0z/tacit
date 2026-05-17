// AMM POOL_INIT seeder — broadcasts a real T_LP_ADD variant=1 envelope.
//
// Use case: founder runs this once per (assetA, assetB, fee_bps) pair to
// seed a canonical AMM pool. After confirmation, the worker registers
// the pool and traders can swap against it via the dapp's
// `buildAndBroadcastSwapVarSelfFulfill` path (or any equivalent).
//
// Composes:
//   - dapp tx primitives (commit-reveal P2TR with envelope script,
//     tap leaf hash, signTaprootScriptPathInput, etc.)
//   - tests/amm-bjj.mjs reference Pedersen-BJJ + NUMS H/G
//   - tests/amm-sigma-xcurve.mjs proveXCurveDeterministic (production-
//     safe sigma prover with HMAC-derived nonces)
//   - tests/amm-envelope.mjs encodeLpAdd
//   - tests/amm-kernel.mjs lpAddKernelSign (per-side)
//   - tests/amm-asset.mjs derivePoolId / deriveLpAssetId / canonicalAssetPair
//   - tests/amm-clearing.mjs lpInitShares (founder + locked share split)
//   - tests/amm-min-liq.mjs deriveMinLiq{Blinding,Commitment,AmountCt,NumsRecipient}
//
// Required env:
//   NETWORK            signet | mainnet (default signet)
//   ASSET_A_HEX        64-hex asset_id of side A
//   ASSET_B_HEX        64-hex asset_id of side B
//   DELTA_A            initial reserve of A (base units, u64)
//   DELTA_B            initial reserve of B (base units, u64)
//   FEE_BPS            pool fee tier in basis points (0..1000, default 30)
//   VK_CID             IPFS CID of the pool's Groth16 verification key
//                      (string, 1..64 bytes UTF-8)
//   CEREMONY_CID       IPFS CID of the trusted-setup ceremony transcript
//                      (string, 1..64 bytes UTF-8)
//   POOL_CAPABILITY_FLAGS  u8 bitmap (default 0)
//   PROTOCOL_FEE_BPS   0..1000 (default 0)
//
// Required local files:
//   .local/amm-pool-init-wallet.json
//     {
//       "priv_hex": "<64-hex wallet privkey>",
//       "network": "signet" | "mainnet"
//     }
//
// Run:
//   NETWORK=signet \
//   ASSET_A_HEX=... ASSET_B_HEX=... \
//   DELTA_A=100000000 DELTA_B=300000000 \
//   FEE_BPS=30 VK_CID=bafy... CEREMONY_CID=bafy... \
//   node tests/amm-pool-init-cli.mjs
//
// SAFETY: this broadcasts a real on-chain tx that locks DELTA_A of asset A
// and DELTA_B of asset B into a pool record. Once confirmed, the only way
// to recover liquidity is via T_LP_REMOVE (not yet shipped from the dapp
// side). Use signet for first runs.

import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from 'node:fs';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const WALLET_FILE = path.join(STATE_DIR, 'amm-pool-init-wallet.json');

// ---- env params ----
const NETWORK = (process.env.NETWORK || 'signet').toLowerCase();
if (NETWORK !== 'signet' && NETWORK !== 'mainnet') {
  console.error(`✗ NETWORK must be signet|mainnet (got: ${NETWORK})`);
  process.exit(1);
}
globalThis.localStorage.setItem('tacit-network-v1', NETWORK);

function envHex(name, len = 64) {
  const v = process.env[name];
  if (!v || !new RegExp(`^[0-9a-fA-F]{${len}}$`).test(v)) {
    console.error(`✗ ${name} env var required (${len}-hex)`);
    process.exit(1);
  }
  return v.toLowerCase();
}
function envBig(name) {
  const v = process.env[name];
  if (!v || !/^\d+$/.test(v) || BigInt(v) <= 0n) {
    console.error(`✗ ${name} env var required (positive integer)`);
    process.exit(1);
  }
  return BigInt(v);
}
function envStr(name, max = 64) {
  const v = process.env[name];
  if (!v || v.length === 0 || v.length > max) {
    console.error(`✗ ${name} env var required (1..${max} chars)`);
    process.exit(1);
  }
  return v;
}
function envU16(name, def, max = 1000) {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    console.error(`✗ ${name} must be integer in [0, ${max}] (got: ${v})`);
    process.exit(1);
  }
  return n;
}

const ASSET_A_HEX = envHex('ASSET_A_HEX');
const ASSET_B_HEX = envHex('ASSET_B_HEX');
const DELTA_A     = envBig('DELTA_A');
const DELTA_B     = envBig('DELTA_B');
const FEE_BPS     = envU16('FEE_BPS', 30, 1000);
const CAP_FLAGS   = envU16('POOL_CAPABILITY_FLAGS', 0, 255);
const VK_CID      = envStr('VK_CID', 64);
const CEREMONY_CID = envStr('CEREMONY_CID', 64);
const PROTOCOL_FEE_BPS = envU16('PROTOCOL_FEE_BPS', 0, 1000);

// ---- wallet ----
if (!existsSync(WALLET_FILE)) {
  console.error(`✗ wallet file missing: ${WALLET_FILE}`);
  console.error(`  expected JSON: {"priv_hex": "<64 hex>", "network": "${NETWORK}"}`);
  process.exit(1);
}
const wallet = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
if (!/^[0-9a-f]{64}$/i.test(wallet.priv_hex || '')) {
  console.error('✗ wallet.priv_hex must be 64-hex');
  process.exit(1);
}
if (wallet.network !== NETWORK) {
  console.error(`✗ wallet.network = ${wallet.network} but NETWORK env = ${NETWORK} — refusing to cross networks`);
  process.exit(1);
}
const PRIV = hexToBytes(wallet.priv_hex);
const PUB = secp.getPublicKey(PRIV, true);

// ---- imports ----
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
try {
  globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1');
} catch {}

// Install wallet into dapp
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
dapp.invalidateHoldingsCache();

// ---- pre-flight ----
console.log(`\n=== AMM POOL_INIT ===\n`);
console.log(`  network:          ${NETWORK}`);
console.log(`  address:          ${dapp.wallet.address()}`);
console.log(`  asset A:          ${ASSET_A_HEX.slice(0, 16)}…`);
console.log(`  asset B:          ${ASSET_B_HEX.slice(0, 16)}…`);
console.log(`  delta A:          ${DELTA_A.toString()}`);
console.log(`  delta B:          ${DELTA_B.toString()}`);
console.log(`  fee bps:          ${FEE_BPS}`);
console.log(`  capability flags: 0x${CAP_FLAGS.toString(16).padStart(2, '0')}`);
console.log(`  vk_cid:           ${VK_CID}`);
console.log(`  ceremony_cid:     ${CEREMONY_CID}`);
console.log(`  protocol fee bps: ${PROTOCOL_FEE_BPS}`);

// Canonical asset pair check
let canonA, canonB, swapped;
try {
  const [low, high] = asset_mod.canonicalAssetPair(ASSET_A_HEX, ASSET_B_HEX);
  canonA = low;
  canonB = high;
  swapped = bytesToHex(canonA) !== ASSET_A_HEX;
} catch (e) {
  console.error(`✗ canonical pair: ${e.message}`);
  process.exit(1);
}
const canonDeltaA = swapped ? DELTA_B : DELTA_A;
const canonDeltaB = swapped ? DELTA_A : DELTA_B;
const canonAssetAHex = bytesToHex(canonA);
const canonAssetBHex = bytesToHex(canonB);
const poolId = asset_mod.derivePoolId(canonA, canonB, FEE_BPS, CAP_FLAGS);
const poolIdHex = bytesToHex(poolId);
const lpAssetId = asset_mod.deriveLpAssetId(poolId);
const lpAssetIdHex = bytesToHex(lpAssetId);

console.log(`\n  → pool_id: ${poolIdHex}`);
console.log(`  → lp_asset_id: ${lpAssetIdHex}`);

// Founder + locked shares from Uniswap V2 init formula
let initShares;
try {
  initShares = clearing.lpInitShares(canonDeltaA, canonDeltaB, minliq.MINIMUM_LIQUIDITY);
} catch (e) {
  console.error(`✗ lpInitShares: ${e.message}`);
  console.error(`  deltas must satisfy isqrt(ΔA·ΔB) > MINIMUM_LIQUIDITY (${minliq.MINIMUM_LIQUIDITY})`);
  process.exit(1);
}
console.log(`  → founder shares: ${initShares.founder_shares}`);
console.log(`  → locked shares:  ${initShares.locked_shares} (MINIMUM_LIQUIDITY, NUMS-locked)`);
console.log(`  → total shares:   ${initShares.total_shares}`);

// ---- scan holdings for exact UTXOs ----
console.log(`\n--- scanning holdings ---`);
const holdings = await dapp.scanHoldings();
if (!holdings || !(holdings instanceof Map)) {
  console.error('✗ holdings scan failed');
  process.exit(1);
}
const hA = holdings.get(canonAssetAHex);
const hB = holdings.get(canonAssetBHex);
if (!hA || hA.balance < canonDeltaA) {
  console.error(`✗ insufficient asset_A balance: have ${hA?.balance ?? 0}, need ${canonDeltaA}`);
  process.exit(1);
}
if (!hB || hB.balance < canonDeltaB) {
  console.error(`✗ insufficient asset_B balance: have ${hB?.balance ?? 0}, need ${canonDeltaB}`);
  process.exit(1);
}
console.log(`  ✓ asset_A balance: ${hA.balance} (need ${canonDeltaA})`);
console.log(`  ✓ asset_B balance: ${hB.balance} (need ${canonDeltaB})`);

// Carve exact-denom UTXOs (consolidates fragments + waits for visibility)
console.log(`  carving exact ${canonDeltaA} of asset_A…`);
const carvedA = await dapp.carveExactAmount({ assetIdHex: canonAssetAHex, amount: canonDeltaA });
if (!carvedA) {
  console.error('✗ carveExactAmount for asset_A failed');
  process.exit(1);
}
console.log(`  ✓ asset_A UTXO: ${carvedA.utxo.txid.slice(0, 16)}…:${carvedA.utxo.vout}`);
console.log(`  carving exact ${canonDeltaB} of asset_B…`);
const carvedB = await dapp.carveExactAmount({ assetIdHex: canonAssetBHex, amount: canonDeltaB });
if (!carvedB) {
  console.error('✗ carveExactAmount for asset_B failed');
  process.exit(1);
}
console.log(`  ✓ asset_B UTXO: ${carvedB.utxo.txid.slice(0, 16)}…:${carvedB.utxo.vout}`);

// ---- build POOL_INIT envelope ----
console.log(`\n--- building POOL_INIT envelope ---`);

// HMAC seed for deterministic XCurve nonce derivation
const SEED_KEY = hmac(sha256, PRIV, new TextEncoder().encode('tacit-amm-xcurve-seed-v1'));

// Share blindings (deterministic from wallet + pool_id so re-runs are idempotent)
const r_share_secp_bytes = hmac(sha256, PRIV, concatBytes(
  new TextEncoder().encode('tacit-amm-lp-share-secp-v1'), poolId,
));
const r_share_BJJ_bytes = hmac(sha256, PRIV, concatBytes(
  new TextEncoder().encode('tacit-amm-lp-share-bjj-v1'), poolId,
));
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const r_share_secp = (BigInt('0x' + bytesToHex(r_share_secp_bytes)) % SECP_N) || 1n;
const r_share_BJJ = (BigInt('0x' + bytesToHex(r_share_BJJ_bytes)) % bjj.N_BJJ) || 1n;

const C_share_secp_pt = bp.pedersenCommit(initShares.founder_shares, r_share_secp);
const C_share_BJJ_pt = bjj.pedersenBJJ(initShares.founder_shares, r_share_BJJ);
const C_share_secp_bytes = bp.pointToBytes(C_share_secp_pt);
const C_share_BJJ_bytes = bjj.packPoint(C_share_BJJ_pt);

const { proof: xcurveProof } = sigma.proveXCurveDeterministic({
  a: initShares.founder_shares,
  r_secp: r_share_secp,
  r_BJJ: r_share_BJJ,
  seedKey: SEED_KEY,
  C_secp: C_share_secp_pt,
  C_BJJ: C_share_BJJ_pt,
});
console.log(`  ✓ XCurve sigma proof generated (${xcurveProof.length} bytes)`);

// Per-side kernel sigs (excess scalar = sum of input blindings on that side)
const kSigA = kernel.lpAddKernelSign({
  variant: 1, poolId,
  assetX: canonA, deltaX: canonDeltaA, shareAmount: initShares.founder_shares,
  shareCSecpBytes: C_share_secp_bytes,
  inputsX: [{ txid: carvedA.utxo.txid, vout: carvedA.utxo.vout }],
  inputCommitments: [bp.pedersenCommit(carvedA.amount, BigInt(carvedA.blinding))],
  excessX: BigInt(carvedA.blinding),
});
const kSigB = kernel.lpAddKernelSign({
  variant: 1, poolId,
  assetX: canonB, deltaX: canonDeltaB, shareAmount: initShares.founder_shares,
  shareCSecpBytes: C_share_secp_bytes,
  inputsX: [{ txid: carvedB.utxo.txid, vout: carvedB.utxo.vout }],
  inputCommitments: [bp.pedersenCommit(carvedB.amount, BigInt(carvedB.blinding))],
  excessX: BigInt(carvedB.blinding),
});
console.log(`  ✓ kernel sigs (A + B) generated`);

// Envelope payload — placeholder Groth16 proof (worker doesn't verify it
// in v1; SPEC §5.11.4 three-verifier model offloads Groth16 to dapp on read).
const payload = env_mod.encodeLpAdd({
  variant: 1,
  assetA: canonA, assetB: canonB,
  deltaA: canonDeltaA, deltaB: canonDeltaB,
  shareAmount: initShares.founder_shares,
  shareCSecp: C_share_secp_bytes,
  shareCBJJ: C_share_BJJ_bytes,
  shareXcurveSigma: xcurveProof,
  kernelSigA: kSigA, kernelSigB: kSigB,
  feeBps: FEE_BPS,
  vkCid: VK_CID,
  ceremonyCid: CEREMONY_CID,
  arbiterPubkeys: [], launcherSigs: [],
  protocolFeeAddress: new Uint8Array(33),     // no protocol fee in v1 seed
  protocolFeeBps: PROTOCOL_FEE_BPS,
  poolMetaUri: '',
  poolCapabilityFlags: CAP_FLAGS,
  proof: new Uint8Array(256),                 // Groth16 stub
});
console.log(`  ✓ payload encoded (${payload.length} bytes)`);

// ---- assemble Bitcoin tx (commit + reveal) ----
console.log(`\n--- assembling Bitcoin tx ---`);

const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
const tapLeaf = dapp.tapLeafHash(envelopeScript);
const TAP_NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
const { Q_xonly, parity } = dapp.tweakedOutputKey(TAP_NUMS, tapLeaf);
const commitSpk = dapp.p2trScript(Q_xonly);
const cb = dapp.controlBlock(TAP_NUMS, parity);

// MIN_LIQ locked output (per SPEC §"MINIMUM_LIQUIDITY burn-output construction")
const { p2wpkh: minLiqP2wpkh } = minliq.deriveMinLiqNumsRecipient(poolId);
const minLiqSpk = concatBytes(new Uint8Array([0x00, 0x14]), minLiqP2wpkh);

// Reveal vout layout (SPEC §"Bitcoin tx layout for T_LP_ADD"):
//   vout[0] = founder LP share UTXO at trader P2WPKH (DUST, blinded = founder_shares)
//   vout[1] = MIN_LIQ locked LP share UTXO at NUMS P2WPKH (DUST, blinded = MIN_LIQ)
const founderSpk = concatBytes(new Uint8Array([0x00, 0x14]), dapp.hash160(PUB));
const DUST = 546;

// Reveal vbytes (rough estimate; envelope dominates)
const revealVb = 11 + 41 /* commit P2TR vin */ + 41 + 41 /* 2 asset inputs */
  + 31 + 31 /* 2 P2WPKH outs */
  + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34 + 109 + 109) / 4);

const feeRate = await dapp.getFeeRate();
const revealFee = dapp.feeFor(revealVb, feeRate);
console.log(`  revealVb estimate: ${revealVb}, fee rate: ${feeRate}, revealFee: ${revealFee} sats`);

// Reveal BTC math: commit P2TR + DUST + DUST (asset inputs) = DUST + DUST (outs) + revealFee + sats change
// commitValue must fund the deficit
let commitValue = Math.max(DUST, DUST + DUST + revealFee - DUST - DUST);

// Fund commit from sats UTXOs (excluding the two asset inputs)
const allUtxos = await dapp.getUtxos(dapp.wallet.address());
const assetKeys = new Set([
  `${carvedA.utxo.txid}:${carvedA.utxo.vout}`,
  `${carvedB.utxo.txid}:${carvedB.utxo.vout}`,
]);
const sats = allUtxos
  .filter(u => !assetKeys.has(`${u.txid}:${u.vout}`) && u.value > DUST)
  .sort((a, b) => b.value - a.value);
if (sats.length === 0) {
  console.error('✗ no plain-sats UTXOs to fund the POOL_INIT commit');
  process.exit(1);
}
const picked = [];
let total = 0;
let commitFee = 500;
for (const u of sats) {
  picked.push(u);
  total += u.value;
  commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate);
  if (total >= commitValue + commitFee + DUST) break;
}
if (total < commitValue + commitFee) {
  console.error(`✗ insufficient sats for commit: need ${commitValue + commitFee}, have ${total}`);
  process.exit(1);
}
console.log(`  ✓ funded commit with ${picked.length} sats inputs (${total} sats total)`);

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
console.log(`  ✓ commit tx built: ${commitTxid.slice(0, 16)}…`);

// Reveal tx
const revealTx = {
  version: 2, locktime: 0,
  inputs: [
    { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
    { txid: carvedA.utxo.txid, vout: carvedA.utxo.vout, sequence: 0xfffffffd, witness: [] },
    { txid: carvedB.utxo.txid, vout: carvedB.utxo.vout, sequence: 0xfffffffd, witness: [] },
  ],
  outputs: [
    { value: DUST, script: founderSpk },    // founder LP share UTXO
    { value: DUST, script: minLiqSpk },     // MIN_LIQ NUMS-locked UTXO
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
console.log(`  ✓ reveal tx built: ${revealTxid.slice(0, 16)}…`);

// ---- broadcast ----
console.log(`\n--- broadcasting ---`);
if (process.env.DRY_RUN === '1') {
  console.log(`  DRY_RUN=1: skipping broadcast`);
  console.log(`  commit hex:`);
  console.log(`    ${commitHex}`);
  console.log(`  reveal hex:`);
  console.log(`    ${revealHex}`);
} else {
  console.log(`  broadcasting commit…`);
  await dapp.broadcast(commitHex);
  console.log(`  ✓ commit broadcast`);
  console.log(`  broadcasting reveal…`);
  await dapp.broadcastWithRetry(revealHex);
  console.log(`  ✓ reveal broadcast`);
  // Persist the founder LP share opening so downstream LP_REMOVE can find it.
  try {
    dapp.recordOpening(revealTxid, 0, lpAssetIdHex, initShares.founder_shares, r_share_secp);
  } catch (e) {
    console.log(`  (recordOpening warning: ${e.message})`);
  }
}

console.log(`\n=== POOL_INIT broadcast complete ===\n`);
console.log(`  pool_id:        ${poolIdHex}`);
console.log(`  lp_asset_id:    ${lpAssetIdHex}`);
console.log(`  commit txid:    ${commitTxid}`);
console.log(`  reveal txid:    ${revealTxid}`);
console.log(`  founder shares: ${initShares.founder_shares} (at ${revealTxid.slice(0, 16)}…:0)`);
console.log(`  locked shares:  ${initShares.locked_shares} (NUMS-locked at vout[1])`);
console.log(`\n  Wait for ${NETWORK === 'signet' ? '~3' : '~3'} confirmations, then check`);
console.log(`  https://tacit-pin.rosscampbell9.workers.dev/amm/pool/${poolIdHex}?network=${NETWORK}`);
console.log(`  (endpoint may not exist yet — worker /amm/pool GET ships with the AMM rollout)\n`);
