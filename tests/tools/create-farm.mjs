#!/usr/bin/env node
// Launcher CLI for T_FARM_INIT — safe, validated farm deployment.
//
// Goal: a launcher with TAC (or any tacit asset) can use this to verify
// their farm parameters compose correctly, build the envelope, and
// inspect the tx-construction manifest BEFORE broadcasting. The CLI:
//
//   1. Reads launcher privkey + farm parameters from CLI flags or env.
//   2. Validates every pre-condition (schedule sanity, dust floors,
//      depth-3 gate, init-lock window).
//   3. Builds the T_FARM_INIT envelope using the reference impl.
//   4. Dry-runs validateFarmInit against a synthesised pool state to
//      confirm the validator path accepts the envelope.
//   5. Prints: the envelope payload (hex), the OP_RETURN script, the
//      vin/vout manifest, the farm_id, and a human-readable summary.
//
// What it does NOT do:
//   - Construct or broadcast the actual Bitcoin transaction.
//     (That's wallet-tier code; this tool produces the deterministic
//     envelope payload so any wallet capable of building tacit
//     script-path txs can finish the job.)
//   - Fetch live chain state. Pre-conditions involving live data
//     (current_height, pool state) are read from flags so the operator
//     supplies them deliberately. A future enhancement could hit the
//     worker /tip + /amm/pool/:id endpoints to auto-populate.
//
// Usage:
//
//   node tests/tools/create-farm.mjs \
//     --launcher-priv=<32B hex> \
//     --pool-id=<32B hex>      \
//     --reward-asset=<32B hex> \
//     --reward-total=<u64>     \
//     --reward-per-block=<u64> \
//     --start-height=<u32>     \
//     --current-height=<u32>   \
//     --pool-init-height=<u32> \
//     --input-value=<u64>      \  # value of the launcher's TAC UTXO
//     --input-blind=<32B hex>  \  # blinding factor of that UTXO
//     --input-txid=<32B hex>   \  # outpoint txid (big-endian, as on chain)
//     --input-vout=<u32>          # outpoint vout
//
// Or via env:
//   TACIT_LAUNCHER_PRIV=...  TACIT_POOL_ID=...  ... node tests/tools/create-farm.mjs
//
// Output (stdout):
//   - Human-readable validation report.
//   - JSON manifest with envelope_payload_hex, op_return_spk_hex,
//     vin / vout layout, farm_id, and dry-run validator result.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

import {
  G, H, SECP_N, modN, pedersenCommit, pointToBytes,
  bpRangeAggProve, randomScalar,
} from '../bulletproofs.mjs';
import { signSchnorr } from '../composition.mjs';
import {
  OPCODE_T_FARM_INIT,
  AMM_FARM_MIN_BOND, AMM_FARM_MIN_REWARD_TOTAL,
  AMM_FARM_MAX_START_DELAY, AMM_FARM_VIEW_STALENESS,
  AMM_FARM_REFUND_GRACE_BLOCKS, NO_CHANGE_SENTINEL,
  deriveFarmId, deriveLpAssetIdFromPoolId,
  buildFarmInitMsg, buildFarmInitKernelMsg,
  encodeFarmInit, decodeFarmInit, computeEnvelopeHash,
  validateFarmInit,
} from '../amm-farm.mjs';

function bigintToBytes32(n) {
  let x = BigInt(n);
  if (x < 0n) x = ((x % SECP_N) + SECP_N) % SECP_N;
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

// ---- Arg parsing ----

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

function getReq(args, flag, envKey) {
  const v = args[flag] ?? process.env[envKey];
  if (v === undefined || v === null || v === '') {
    bail(`missing required flag --${flag} (or env ${envKey})`);
  }
  return v;
}
function getOpt(args, flag, envKey, def) {
  const v = args[flag] ?? process.env[envKey];
  return v === undefined || v === null || v === '' ? def : v;
}
function parseHex(s, len, label) {
  const clean = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]+$/.test(clean)) bail(`${label}: not hex`);
  const b = hexToBytes(clean.toLowerCase());
  if (b.length !== len) bail(`${label}: expected ${len} bytes, got ${b.length}`);
  return b;
}
function parseU64(s, label) {
  let n;
  try { n = BigInt(s); } catch { bail(`${label}: not an integer`); }
  if (n < 0n || n >= 1n << 64n) bail(`${label}: out of u64 range`);
  return n;
}
function parseU32(s, label) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) bail(`${label}: out of u32 range`);
  return n;
}

function bail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function header(s) {
  console.log(`\n=== ${s} ===`);
}
function kv(k, v) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}

// ---- Main flow ----

const args = parseArgs(process.argv);

if (args.help || args.h) {
  console.log(`tacit launcher CLI — T_FARM_INIT envelope builder + validator

Required flags (or matching TACIT_* env vars):
  --launcher-priv      32B hex (secp256k1 secret key)
  --pool-id            32B hex
  --reward-asset       32B hex (tacit asset_id of the reward token)
  --reward-total       u64 (total emission budget)
  --reward-per-block   u64 (emissions per Bitcoin block)
  --start-height       u32 (Bitcoin block height when emissions begin)
  --current-height     u32 (current tip height; used for depth-3 gating)
  --pool-init-height   u32 (the target pool's init_height)
  --input-value        u64 (value of launcher's reward-asset UTXO)
  --input-blind        32B hex (blinding factor of that UTXO; consult wallet)
  --input-txid         32B hex (outpoint txid, big-endian as on chain)
  --input-vout         u32 (outpoint vout)

Optional:
  --farm-nonce         32B hex (default: random)
  --pool-fee-bps       u16 (default: 30; informational, surfaced in output)

Outputs the envelope payload, OP_RETURN scriptPubKey, tx manifest, and
dry-run validator result. Does NOT broadcast.
`);
  process.exit(0);
}

const launcherPriv = parseHex(getReq(args, 'launcher-priv', 'TACIT_LAUNCHER_PRIV'), 32, 'launcher-priv');
const launcherPub  = secp.getPublicKey(launcherPriv, true);

const poolId         = parseHex(getReq(args, 'pool-id', 'TACIT_POOL_ID'), 32, 'pool-id');
const rewardAssetId  = parseHex(getReq(args, 'reward-asset', 'TACIT_REWARD_ASSET'), 32, 'reward-asset');
const rewardTotal    = parseU64(getReq(args, 'reward-total', 'TACIT_REWARD_TOTAL'), 'reward-total');
const rewardPerBlock = parseU64(getReq(args, 'reward-per-block', 'TACIT_REWARD_PER_BLOCK'), 'reward-per-block');
const startHeight    = parseU32(getReq(args, 'start-height', 'TACIT_START_HEIGHT'), 'start-height');
const currentHeight  = parseU32(getReq(args, 'current-height', 'TACIT_CURRENT_HEIGHT'), 'current-height');
const poolInitHeight = parseU32(getReq(args, 'pool-init-height', 'TACIT_POOL_INIT_HEIGHT'), 'pool-init-height');
const inputValue     = parseU64(getReq(args, 'input-value', 'TACIT_INPUT_VALUE'), 'input-value');
const inputBlind     = BigInt('0x' + bytesToHex(parseHex(getReq(args, 'input-blind', 'TACIT_INPUT_BLIND'), 32, 'input-blind')));
const inputTxid      = parseHex(getReq(args, 'input-txid', 'TACIT_INPUT_TXID'), 32, 'input-txid');
const inputVout      = parseU32(getReq(args, 'input-vout', 'TACIT_INPUT_VOUT'), 'input-vout');

const farmNonce = args['farm-nonce']
  ? parseHex(args['farm-nonce'], 32, 'farm-nonce')
  : (() => { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = Math.floor(Math.random() * 256); return r; })();

// ---- Pre-validation (cheap structural checks BEFORE building) ----

header('Pre-validation');
let preFailed = false;
function check(cond, label) {
  if (cond) { kv(`✓ ${label}`, ''); return; }
  console.log(`  ✗ ${label}`);
  preFailed = true;
}

check(inputBlind >= 0n && inputBlind < SECP_N, 'inputBlind is a valid scalar (mod n)');
check(inputBlind > 0n, 'inputBlind is non-zero');
check(inputValue >= rewardTotal, `input-value (${inputValue}) ≥ reward-total (${rewardTotal})`);
check(rewardPerBlock > 0n, 'reward-per-block > 0');
check(rewardTotal >= AMM_FARM_MIN_REWARD_TOTAL, `reward-total ≥ AMM_FARM_MIN_REWARD_TOTAL (${AMM_FARM_MIN_REWARD_TOTAL})`);
check(rewardTotal % rewardPerBlock === 0n, 'reward-total divisible by reward-per-block');
check(startHeight >= currentHeight + 3, `start-height ≥ current-height + 3 (depth-3 gate)`);
check(startHeight <= currentHeight + AMM_FARM_MAX_START_DELAY, `start-height ≤ current-height + ${AMM_FARM_MAX_START_DELAY} (max-delay)`);
check(startHeight >= poolInitHeight + 6, `start-height ≥ pool-init-height + 6 (first-LP lock window)`);
const durationBlocks = rewardTotal / rewardPerBlock;
const endHeight = startHeight + Number(durationBlocks);
check(durationBlocks <= BigInt(0xffffffff) && endHeight <= 0xffffffff, 'computed end-height fits u32');

if (preFailed) {
  console.error('\nPre-validation failed. Fix the flagged inputs and retry.');
  process.exit(2);
}

// ---- Derive farm_id ----

const farmId = deriveFarmId({ poolId, launcherPubkey: launcherPub, rewardAssetId, farmNonce });
const lpAssetId = deriveLpAssetIdFromPoolId(poolId);

// ---- Build commitments ----

const cInPoint = pedersenCommit(inputValue, inputBlind);
const changeValue = inputValue - rewardTotal;

let cChangeOrSentinel, rangeProof, kernelExcess;
if (changeValue === 0n) {
  // Whole-input case (launcher's UTXO is exactly reward_total).
  cChangeOrSentinel = NO_CHANGE_SENTINEL;
  // Bulletproof can't prove value=0 with non-zero blind directly; the
  // sentinel branch in the validator accepts a structural placeholder.
  // We supply a degenerate proof for non-CI test branches; real worker
  // wire requires the sentinel-aware verifier.
  const placeholderBlind = randomScalar();
  const { proof } = bpRangeAggProve([0n], [placeholderBlind]);
  rangeProof = proof;
  kernelExcess = modN(-inputBlind);
} else {
  const changeBlind = randomScalar();
  const cChange = pedersenCommit(changeValue, changeBlind);
  cChangeOrSentinel = pointToBytes(cChange);
  const { proof } = bpRangeAggProve([changeValue], [changeBlind]);
  rangeProof = proof;
  kernelExcess = modN(changeBlind - inputBlind);
}

// ---- Sign kernel + launcher ----

const kernelMsg = buildFarmInitKernelMsg({
  rewardAssetId,
  launcherInputOutpointTxid: inputTxid,
  launcherInputOutpointVout: inputVout,
  cChangeOrSentinel,
  rewardTotal,
});
const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(kernelExcess));

const initMsg = buildFarmInitMsg({
  farmId,
  launcherPubkey: launcherPub,
  rewardTotal,
  rewardPerBlock,
  startHeight,
  endHeight,
});
const launcherSig = signSchnorr(initMsg, launcherPriv);

// ---- Encode envelope ----

const env = {
  poolId, farmNonce, launcherPubkey: launcherPub, rewardAssetId,
  rewardTotal, rewardPerBlock, startHeight, endHeight,
  cChangeOrSentinel, rangeProof, kernelSig, launcherSig,
};
const payload = encodeFarmInit(env);
const envelopeHash = computeEnvelopeHash(payload);

// ---- Dry-run validator ----

header('Dry-run validation');

// We synthesise the minimal pool state the validator needs.
const stubPool = {
  pool_id: poolId,
  init_height: poolInitHeight,
  amm_initial_lp_lock_blocks: 6,
};
// Stub bulletproof verify that accepts the sentinel-case structural
// placeholder and runs the real verify on real commitments.
const { bpRangeAggVerify } = await import('../bulletproofs.mjs');
const { ZERO } = await import('../bulletproofs.mjs');
function bpVerifyAware(V_pts, proofBytes) {
  if (V_pts.length === 1 && V_pts[0].equals(ZERO)) {
    return proofBytes instanceof Uint8Array && proofBytes.length > 0;
  }
  return bpRangeAggVerify(V_pts, proofBytes);
}

const dryResult = validateFarmInit({
  payload,
  pool: stubPool,
  inputCommitment: pointToBytes(cInPoint),
  currentHeight,
  opReturnData: envelopeHash,
  bulletproofVerify: bpVerifyAware,
});
if (dryResult.valid) {
  kv('result', 'PASS — validator accepts the envelope');
} else {
  console.log(`  ✗ FAIL: ${dryResult.reason}`);
  console.error('\nValidator rejected the envelope. Fix the offending field and retry.');
  process.exit(2);
}

// ---- Print manifest ----

header('Farm parameters');
kv('farm_id',         bytesToHex(farmId));
kv('pool_id',         bytesToHex(poolId));
kv('lp_asset_id',     bytesToHex(lpAssetId));
kv('reward_asset_id', bytesToHex(rewardAssetId));
kv('launcher_pubkey', bytesToHex(launcherPub));
kv('reward_total',    rewardTotal.toString());
kv('reward_per_block',rewardPerBlock.toString());
kv('start_height',    startHeight);
kv('end_height',      endHeight);
kv('duration_blocks', durationBlocks.toString());
kv('refund_unlock_height', endHeight + AMM_FARM_REFUND_GRACE_BLOCKS);

header('Envelope');
kv('payload_bytes',   payload.length);
kv('payload_hex',     bytesToHex(payload));
kv('envelope_hash',   bytesToHex(envelopeHash));

header('Bitcoin tx layout');
console.log(`  vin[0]   Taproot script-path input — witness carries payload above`);
console.log(`  vin[1]   ${bytesToHex(inputTxid)}:${inputVout}`);
console.log(`           Launcher's reward-asset UTXO (value ${inputValue}, blind 0x${inputBlind.toString(16)})`);
console.log(`  vin[2..] Optional BTC funding inputs for tx fee + dust`);
console.log(``);
console.log(`  vout[0]  OP_RETURN(envelope_hash)`);
console.log(`           scriptPubKey: 6a20${bytesToHex(envelopeHash)}`);
if (changeValue === 0n) {
  console.log(`  vout[1]  (omitted — input exactly equals reward_total; no-change sentinel)`);
} else {
  console.log(`  vout[1]  Launcher's change UTXO — dust P2WPKH to launcher's change address`);
  console.log(`           Carries C_change_or_sentinel; asset_id = reward_asset_id`);
  console.log(`           Value = ${changeValue} (= input ${inputValue} − reward_total ${rewardTotal})`);
}

header('Lifecycle summary');
console.log(`  - Farm activates at block ${startHeight}.`);
console.log(`  - LPs can bond from block ${currentHeight + 3} (depth-3) onward;`);
console.log(`    emissions accrue from ${startHeight}.`);
console.log(`  - Last emission block: ${endHeight}.`);
console.log(`  - Launcher refund unlocks at block ${endHeight + AMM_FARM_REFUND_GRACE_BLOCKS}`);
console.log(`    (~${Math.round(AMM_FARM_REFUND_GRACE_BLOCKS / 144)} days post-end).`);
console.log(`  - Permissionlessness: post-init, the launcher has NO authority to`);
console.log(`    modify, pause, or front-run the farm. Only post-grace refund.`);

header('JSON manifest (machine-readable)');
console.log(JSON.stringify({
  farm_id: bytesToHex(farmId),
  pool_id: bytesToHex(poolId),
  lp_asset_id: bytesToHex(lpAssetId),
  reward_asset_id: bytesToHex(rewardAssetId),
  launcher_pubkey: bytesToHex(launcherPub),
  reward_total: rewardTotal.toString(),
  reward_per_block: rewardPerBlock.toString(),
  start_height: startHeight,
  end_height: endHeight,
  refund_unlock_height: endHeight + AMM_FARM_REFUND_GRACE_BLOCKS,
  envelope_hash: bytesToHex(envelopeHash),
  envelope_payload_hex: bytesToHex(payload),
  op_return_spk_hex: '6a20' + bytesToHex(envelopeHash),
  vin1_outpoint: {
    txid: bytesToHex(inputTxid),
    vout: inputVout,
  },
  vout1_change: changeValue === 0n ? null : {
    asset_id: bytesToHex(rewardAssetId),
    value: changeValue.toString(),
    commitment_hex: bytesToHex(cChangeOrSentinel),
  },
  dry_run_validation: 'PASS',
}, null, 2));
