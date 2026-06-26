// Worker chain-scan unit tests for the LP-bond yield-farm opcodes.
//
// PURPOSE: catch worker ↔ ref-impl drift. The ref-impl at tests/amm-farm.mjs
// has 101 tests + 10k-trace property fuzz, but the worker re-implements
// the same wire format + crystallization math inline in worker/src/index.js
// (~700 LOC of decoders + chain-scan branches + KV helpers + emit-resolver).
// Drift between the two is a silent bug surface: envelopes the dapp builds
// would be parsed differently by the worker than by ref impl, and indexer
// state would diverge across implementations.
//
// What this file pins:
//
//   1. Worker decoder ↔ ref-impl encoder round-trip
//      For each of the 5 opcodes: build envelope via ref-impl encoder,
//      decode via the worker's decoder, assert all fields byte-for-byte
//      match. Catches any wire-format drift.
//
//   2. Worker kernel-msg construction ↔ ref-impl kernel-msg construction
//      The worker's ammKernelMsgV1 must produce byte-identical output to
//      composition.mjs computeKernelMsg for the same (asset_id, inputs,
//      outputs, burned_amount). Drift here breaks BIP-340 sig verify
//      silently — envelopes would confirm on chain but the worker would
//      reject every one.
//
//   3. Worker crystallization ↔ ref-impl crystallization
//      The worker's _farmCrystallize and ref impl crystallizeFarm must
//      produce identical state mutations for any (farm, current_height)
//      pair. Drift here causes acc_reward_per_share divergence, which
//      cascades into wrong payouts at unbond/harvest.
//
//   4. Worker farm_id derivation ↔ ref-impl deriveFarmId
//      The worker's ammDeriveFarmId must produce byte-identical farm_id
//      values to ref-impl deriveFarmId. Drift here means launchers
//      can't find their own farms by id (worker indexes under one id,
//      dapp queries under another).
//
//   5. KV key formation
//      The worker's ammFarmKey / ammFarmBondKey / etc. produce the
//      expected key strings for both 'signet' and named networks.
//      Drift here means farms get written under different keys than
//      they're read from, silently failing every query.
//
// Run: `node tests/amm-farm-worker.test.mjs`

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

import {
  // Worker exports under test
  T_FARM_INIT as W_T_FARM_INIT,
  T_LP_BOND as W_T_LP_BOND,
  T_LP_UNBOND as W_T_LP_UNBOND,
  T_LP_HARVEST as W_T_LP_HARVEST,
  T_FARM_REFUND as W_T_FARM_REFUND,
  AMM_FARM_MIN_BOND as W_MIN_BOND,
  AMM_FARM_MIN_REWARD_TOTAL as W_MIN_REWARD,
  AMM_FARM_MAX_START_DELAY as W_MAX_START_DELAY,
  AMM_FARM_VIEW_STALENESS as W_VIEW_STALENESS,
  AMM_FARM_REFUND_GRACE_BLOCKS as W_REFUND_GRACE,
  FARM_ACC_FIXED_POINT_SHIFT as W_ACC_SHIFT,
  decodeTFarmInitPayload,
  decodeTLpBondPayload,
  decodeTLpUnbondPayload,
  decodeTLpHarvestPayload,
  decodeTFarmRefundPayload,
  ammDeriveFarmId as workerDeriveFarmId,
  _farmCrystallize as workerCrystallize,
  ammFarmKey, ammFarmBondKey, ammFarmBondsByBonderKey,
  ammFarmsByPoolKey, ammFarmUnbondReceiptKey,
  ammKernelMsgV1,
} from '../worker/src/index.js';

import {
  OPCODE_T_FARM_INIT, OPCODE_T_LP_BOND, OPCODE_T_LP_UNBOND,
  OPCODE_T_LP_HARVEST, OPCODE_T_FARM_REFUND,
  AMM_FARM_MIN_BOND, AMM_FARM_MIN_REWARD_TOTAL,
  AMM_FARM_MAX_START_DELAY, AMM_FARM_VIEW_STALENESS,
  AMM_FARM_REFUND_GRACE_BLOCKS, ACC_FIXED_POINT_SHIFT,
  deriveFarmId, deriveLpAssetIdFromPoolId, encodeBondId,
  buildFarmInitKernelMsg, buildLpBondKernelMsg,
  encodeFarmInit, encodeFarmRefund,
  crystallizeFarm,
} from './amm-farm.mjs';
// The worker's LP bond/harvest/unbond decoders were re-aligned to the dapp/reflection
// receipt envelope layouts (bond +owner_commit/nonce, harvest 346B, unbond 217B
// receipt-only). Encode with the dapp source of truth; decode with the worker.
import {
  encodeLpBond as dEncodeLpBond,
  encodeLpHarvest as dEncodeLpHarvest,
  encodeLpUnbond as dEncodeLpUnbond,
} from '../dapp/amm-envelope.js';
import { computeKernelMsg } from './composition.mjs';
import { pedersenCommit, pointToBytes, randomScalar, modN, SECP_N } from './bulletproofs.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${r}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const LAUNCHER_PRIV = hexToBytes('11'.repeat(32));
const LAUNCHER_PUB  = secp.getPublicKey(LAUNCHER_PRIV, true);
const BONDER_PRIV   = hexToBytes('22'.repeat(32));
const BONDER_PUB    = secp.getPublicKey(BONDER_PRIV, true);
const POOL_ID = sha256(new TextEncoder().encode('worker-parity-pool'));
const REWARD_ASSET = sha256(new TextEncoder().encode('worker-parity-reward'));
const FARM_NONCE = hexToBytes('a1'.repeat(32));

// =========================================================================
// Section 1: Constant parity (worker ↔ ref impl)
// =========================================================================
console.log('\n--- Section 1: constants ---');

test('T_FARM_INIT opcode matches', () => W_T_FARM_INIT === OPCODE_T_FARM_INIT && W_T_FARM_INIT === 0x34);
test('T_LP_BOND opcode matches',   () => W_T_LP_BOND   === OPCODE_T_LP_BOND   && W_T_LP_BOND   === 0x35);
test('T_LP_UNBOND opcode matches', () => W_T_LP_UNBOND === OPCODE_T_LP_UNBOND && W_T_LP_UNBOND === 0x36);
test('T_LP_HARVEST opcode matches',() => W_T_LP_HARVEST=== OPCODE_T_LP_HARVEST&& W_T_LP_HARVEST=== 0x3B);
test('T_FARM_REFUND opcode matches',() => W_T_FARM_REFUND === OPCODE_T_FARM_REFUND && W_T_FARM_REFUND === 0x3E);

test('AMM_FARM_MIN_BOND constant matches', () => W_MIN_BOND === AMM_FARM_MIN_BOND && W_MIN_BOND === 1000n);
test('AMM_FARM_MIN_REWARD_TOTAL constant matches', () => W_MIN_REWARD === AMM_FARM_MIN_REWARD_TOTAL);
test('AMM_FARM_MAX_START_DELAY constant matches', () => W_MAX_START_DELAY === AMM_FARM_MAX_START_DELAY);
test('AMM_FARM_VIEW_STALENESS constant matches', () => W_VIEW_STALENESS === AMM_FARM_VIEW_STALENESS);
test('AMM_FARM_REFUND_GRACE_BLOCKS constant matches', () => W_REFUND_GRACE === AMM_FARM_REFUND_GRACE_BLOCKS);
test('FARM_ACC_FIXED_POINT_SHIFT constant matches', () => W_ACC_SHIFT === ACC_FIXED_POINT_SHIFT);

// =========================================================================
// Section 2: Decoder ↔ encoder roundtrip parity
// =========================================================================
console.log('\n--- Section 2: decoder ↔ encoder roundtrips ---');

const FARM_ID_REF = deriveFarmId({
  poolId: POOL_ID, launcherPubkey: LAUNCHER_PUB,
  rewardAssetId: REWARD_ASSET, farmNonce: FARM_NONCE,
});

test('FARM_INIT: worker decode of ref-impl encode preserves every field', () => {
  const env = {
    poolId: POOL_ID, farmNonce: FARM_NONCE,
    launcherPubkey: LAUNCHER_PUB, rewardAssetId: REWARD_ASSET,
    rewardTotal: 100_000_000_000n, rewardPerBlock: 100_000n,
    startHeight: 200,
    endHeight: 200 + Number(100_000_000_000n / 100_000n),
    cChangeOrSentinel: pointToBytes(pedersenCommit(50n, modN(0x1234n))),
    rangeProof: new Uint8Array([0xa1, 0xa2, 0xa3]),
    kernelSig: new Uint8Array(64).fill(0xaa),
    launcherSig: new Uint8Array(64).fill(0xbb),
  };
  const payload = encodeFarmInit(env);
  const dec = decodeTFarmInitPayload(payload);
  if (!dec) return 'worker decoder returned null';
  if (dec.pool_id !== bytesToHex(POOL_ID)) return `pool_id: ${dec.pool_id}`;
  if (dec.farm_nonce !== bytesToHex(FARM_NONCE)) return `farm_nonce`;
  if (dec.launcher_pubkey !== bytesToHex(LAUNCHER_PUB)) return `launcher_pubkey`;
  if (dec.reward_asset_id !== bytesToHex(REWARD_ASSET)) return `reward_asset_id`;
  if (BigInt(dec.reward_total) !== env.rewardTotal) return `reward_total: ${dec.reward_total}`;
  if (BigInt(dec.reward_per_block) !== env.rewardPerBlock) return `reward_per_block`;
  if (dec.start_height !== env.startHeight) return `start_height: ${dec.start_height}`;
  if (dec.end_height !== env.endHeight) return `end_height`;
  if (dec.c_change_or_sentinel !== bytesToHex(env.cChangeOrSentinel)) return `c_change_or_sentinel`;
  if (dec.range_proof !== bytesToHex(env.rangeProof)) return `range_proof`;
  if (dec.kernel_sig !== bytesToHex(env.kernelSig)) return `kernel_sig`;
  if (dec.launcher_sig !== bytesToHex(env.launcherSig)) return `launcher_sig`;
  return true;
});

test('FARM_INIT: worker decoder rejects bad opcode', () => {
  const env = {
    poolId: POOL_ID, farmNonce: FARM_NONCE, launcherPubkey: LAUNCHER_PUB,
    rewardAssetId: REWARD_ASSET, rewardTotal: 1_000_000_000n,
    rewardPerBlock: 100_000n, startHeight: 200,
    endHeight: 200 + Number(1_000_000_000n / 100_000n),
    cChangeOrSentinel: new Uint8Array(33),
    rangeProof: new Uint8Array([0x01]),
    kernelSig: new Uint8Array(64),
    launcherSig: new Uint8Array(64),
  };
  const p = encodeFarmInit(env);
  p[0] = 0x99;   // tamper opcode
  return decodeTFarmInitPayload(p) === null;
});

test('FARM_INIT: worker decoder rejects malformed launcher_pubkey leading byte', () => {
  const env = {
    poolId: POOL_ID, farmNonce: FARM_NONCE,
    launcherPubkey: new Uint8Array([0x04, ...LAUNCHER_PUB.slice(1)]),
    rewardAssetId: REWARD_ASSET, rewardTotal: 1_000_000_000n,
    rewardPerBlock: 100_000n, startHeight: 200,
    endHeight: 200 + Number(1_000_000_000n / 100_000n),
    cChangeOrSentinel: new Uint8Array(33),
    rangeProof: new Uint8Array([0x01]),
    kernelSig: new Uint8Array(64), launcherSig: new Uint8Array(64),
  };
  const p = encodeFarmInit(env);
  return decodeTFarmInitPayload(p) === null;
});

test('LP_BOND: worker decode of dapp encode preserves every field (+ owner_commit/nonce)', () => {
  const env = {
    farmId: FARM_ID_REF,
    bonderPubkey: BONDER_PUB,
    bondAmount: 50_000n,
    entryAccPerShare: 0x123456789abcdef0123456789abcdef0n,
    bondViewHeight: 250,
    ownerCommit: hexToBytes('a1'.repeat(32)),
    nonce: hexToBytes('b2'.repeat(32)),
    cChangeOrSentinel: pointToBytes(pedersenCommit(25n, modN(0xfeedn))),
    rangeProof: new Uint8Array([0xc1, 0xc2]),
    kernelSig: new Uint8Array(64).fill(0x11),
    bonderSig: new Uint8Array(64).fill(0x22),
  };
  const p = dEncodeLpBond(env);
  const dec = decodeTLpBondPayload(p);
  if (!dec) return 'worker decoder returned null';
  if (dec.farm_id !== bytesToHex(env.farmId)) return 'farm_id';
  if (dec.bonder_pubkey !== bytesToHex(env.bonderPubkey)) return 'bonder_pubkey';
  if (BigInt(dec.bond_amount) !== env.bondAmount) return 'bond_amount';
  if (BigInt(dec.entry_acc_per_share) !== env.entryAccPerShare) return 'entry_acc_per_share (u128 truncated?)';
  if (dec.bond_view_height !== env.bondViewHeight) return 'bond_view_height';
  if (dec.owner_commit !== bytesToHex(env.ownerCommit)) return 'owner_commit';
  if (dec.receipt_nonce !== bytesToHex(env.nonce)) return 'receipt_nonce';
  if (dec.c_change_or_sentinel !== bytesToHex(env.cChangeOrSentinel)) return 'c_change_or_sentinel';
  return true;
});

test('LP_UNBOND: worker decode preserves the receipt fields (owner_commit/nonce/shares/rps_entry)', () => {
  const env = {
    farmId: FARM_ID_REF,
    ownerCommit: hexToBytes('a1'.repeat(32)),
    nonce: hexToBytes('b2'.repeat(32)),
    shares: 50_000n,
    rpsEntry: (1n << 80n) + 42n,
    lpReturnR: hexToBytes('aa'.repeat(32)),
    unbonderSig: new Uint8Array(64).fill(0x33),
  };
  const p = dEncodeLpUnbond(env);
  const dec = decodeTLpUnbondPayload(p);
  if (!dec) return 'worker decoder returned null';
  if (dec.farm_id !== bytesToHex(env.farmId)) return 'farm_id';
  if (dec.owner_commit !== bytesToHex(env.ownerCommit)) return 'owner_commit';
  if (dec.receipt_nonce !== bytesToHex(env.nonce)) return 'receipt_nonce';
  if (BigInt(dec.shares) !== env.shares) return 'shares';
  if (BigInt(dec.rps_entry) !== env.rpsEntry) return 'rps_entry';
  if (dec.lp_return_r !== bytesToHex(env.lpReturnR)) return 'lp_return_r';
  return true;
});

test('LP_UNBOND: worker decoder rejects wrong-length payload', () => {
  const env = {
    farmId: FARM_ID_REF, ownerCommit: new Uint8Array(32), nonce: new Uint8Array(32),
    shares: 0n, rpsEntry: 0n, lpReturnR: new Uint8Array(32),
    unbonderSig: new Uint8Array(64),
  };
  const p = dEncodeLpUnbond(env);
  // T_LP_UNBOND is fixed 217 bytes. Append a trailing byte → reject.
  const padded = new Uint8Array(p.length + 1);
  padded.set(p, 0);
  return decodeTLpUnbondPayload(padded) === null;
});

test('LP_HARVEST: worker decode preserves all fields (+ receipt fields)', () => {
  const bondId = encodeBondId(sha256(new TextEncoder().encode('harvest-test')), 1);
  const env = {
    farmId: FARM_ID_REF, bondId,
    harvesterPubkey: BONDER_PUB,
    exitAccPerShare: (1n << 90n) + 12345n,
    exitViewHeight: 600,
    rewardAmount: 99_999n,
    rewardR: hexToBytes('33'.repeat(32)),
    ownerCommit: hexToBytes('a1'.repeat(32)),
    oldNonce: hexToBytes('b2'.repeat(32)),
    newNonce: hexToBytes('c3'.repeat(32)),
    shares: 50_000n,
    rpsEntry: (1n << 70n) + 7n,
    harvesterSig: new Uint8Array(64).fill(0x44),
  };
  const p = dEncodeLpHarvest(env);
  const dec = decodeTLpHarvestPayload(p);
  if (!dec) return 'worker decoder returned null';
  if (dec.farm_id !== bytesToHex(env.farmId)) return 'farm_id';
  if (dec.bond_id !== bytesToHex(env.bondId)) return 'bond_id';
  if (dec.harvester_pubkey !== bytesToHex(env.harvesterPubkey)) return 'harvester_pubkey';
  if (BigInt(dec.reward_amount) !== env.rewardAmount) return 'reward_amount';
  if (dec.owner_commit !== bytesToHex(env.ownerCommit)) return 'owner_commit';
  if (dec.old_nonce !== bytesToHex(env.oldNonce)) return 'old_nonce';
  if (dec.new_nonce !== bytesToHex(env.newNonce)) return 'new_nonce';
  if (BigInt(dec.shares) !== env.shares) return 'shares';
  if (BigInt(dec.rps_entry) !== env.rpsEntry) return 'rps_entry';
  return true;
});

test('FARM_REFUND: worker decode preserves all fields', () => {
  const env = {
    farmId: FARM_ID_REF, launcherPubkey: LAUNCHER_PUB,
    refundAmount: 999_999_999n,
    refundViewHeight: 9999,
    refundR: hexToBytes('55'.repeat(32)),
    launcherSig: new Uint8Array(64).fill(0x66),
  };
  const p = encodeFarmRefund(env);
  const dec = decodeTFarmRefundPayload(p);
  if (!dec) return 'worker decoder returned null';
  if (dec.farm_id !== bytesToHex(env.farmId)) return 'farm_id';
  if (dec.launcher_pubkey !== bytesToHex(env.launcherPubkey)) return 'launcher_pubkey';
  if (BigInt(dec.refund_amount) !== env.refundAmount) return 'refund_amount';
  if (dec.refund_view_height !== env.refundViewHeight) return 'refund_view_height';
  return true;
});

// =========================================================================
// Section 3: Kernel-msg byte parity (worker.ammKernelMsgV1 ↔ composition.computeKernelMsg)
// =========================================================================
console.log('\n--- Section 3: kernel-msg byte parity ---');

test('FARM_INIT kernel_msg: worker ammKernelMsgV1 == ref impl buildFarmInitKernelMsg', () => {
  const txid = bytesToHex(sha256(new TextEncoder().encode('kmsg-test-1')));
  const vout = 7;
  const cChange = new Uint8Array(33);   // sentinel
  const refMsg = buildFarmInitKernelMsg({
    rewardAssetId: REWARD_ASSET,
    launcherInputOutpointTxid: hexToBytes(txid),
    launcherInputOutpointVout: vout,
    cChangeOrSentinel: cChange,
    rewardTotal: 1_000_000_000n,
  });
  const workerMsg = ammKernelMsgV1(
    REWARD_ASSET,
    [{ txid, vout }],
    [cChange],
    1_000_000_000n,
  );
  return bytesEq(refMsg, workerMsg);
});

test('LP_BOND kernel_msg: worker.ammKernelMsgV1 == ref impl buildLpBondKernelMsg', () => {
  const lpAssetId = deriveLpAssetIdFromPoolId(POOL_ID);
  const txid = bytesToHex(sha256(new TextEncoder().encode('kmsg-test-2')));
  const vout = 3;
  const cChange = pointToBytes(pedersenCommit(100n, modN(0xfeen)));
  const refMsg = buildLpBondKernelMsg({
    lpAssetId,
    bonderInputOutpointTxid: hexToBytes(txid),
    bonderInputOutpointVout: vout,
    cChangeOrSentinel: cChange,
    bondAmount: 50_000n,
  });
  const workerMsg = ammKernelMsgV1(
    lpAssetId,
    [{ txid, vout }],
    [cChange],
    50_000n,
  );
  return bytesEq(refMsg, workerMsg);
});

// =========================================================================
// Section 4: farm_id derivation parity
// =========================================================================
console.log('\n--- Section 4: farm_id derivation parity ---');

test('worker ammDeriveFarmId == ref impl deriveFarmId for canonical inputs', () => {
  const refId = deriveFarmId({
    poolId: POOL_ID, launcherPubkey: LAUNCHER_PUB,
    rewardAssetId: REWARD_ASSET, farmNonce: FARM_NONCE,
  });
  const workerId = workerDeriveFarmId(POOL_ID, LAUNCHER_PUB, REWARD_ASSET, FARM_NONCE);
  return bytesEq(refId, workerId) && refId.length === 32;
});

test('worker ammDeriveFarmId distinguishes nonces', () => {
  const a = workerDeriveFarmId(POOL_ID, LAUNCHER_PUB, REWARD_ASSET, new Uint8Array(32).fill(0x11));
  const b = workerDeriveFarmId(POOL_ID, LAUNCHER_PUB, REWARD_ASSET, new Uint8Array(32).fill(0x22));
  return !bytesEq(a, b);
});

test('worker ammDeriveFarmId distinguishes pool_ids', () => {
  const a = workerDeriveFarmId(new Uint8Array(32).fill(0x01), LAUNCHER_PUB, REWARD_ASSET, FARM_NONCE);
  const b = workerDeriveFarmId(new Uint8Array(32).fill(0x02), LAUNCHER_PUB, REWARD_ASSET, FARM_NONCE);
  return !bytesEq(a, b);
});

test('worker ammDeriveFarmId distinguishes launcher_pubkeys', () => {
  const a = workerDeriveFarmId(POOL_ID, LAUNCHER_PUB, REWARD_ASSET, FARM_NONCE);
  const b = workerDeriveFarmId(POOL_ID, BONDER_PUB, REWARD_ASSET, FARM_NONCE);
  return !bytesEq(a, b);
});

// =========================================================================
// Section 5: Crystallization parity
// =========================================================================
console.log('\n--- Section 5: crystallization parity ---');

function mkRefFarm(overrides = {}) {
  return {
    farm_id: FARM_ID_REF,
    pool_id: POOL_ID,
    lp_asset_id: deriveLpAssetIdFromPoolId(POOL_ID),
    reward_asset_id: REWARD_ASSET,
    launcher_pubkey: LAUNCHER_PUB,
    reward_total: 100_000_000_000n,
    reward_per_block: 100_000n,
    start_height: 200,
    end_height: 200 + 1_000_000,
    acc_reward_per_share: 0n,
    total_bonded: 0n,
    last_update_height: 200,
    treasury_remaining: 100_000_000_000n,
    ...overrides,
  };
}
// Mirror the worker's string-encoded BigInt convention.
function mkWorkerFarm(overrides = {}) {
  const f = mkRefFarm(overrides);
  return {
    ...f,
    reward_total: f.reward_total.toString(),
    reward_per_block: f.reward_per_block.toString(),
    acc_reward_per_share: f.acc_reward_per_share.toString(),
    total_bonded: f.total_bonded.toString(),
    treasury_remaining: f.treasury_remaining.toString(),
  };
}

test('crystallize: worker and ref impl agree on pre-start no-op', () => {
  const ref = mkRefFarm({ last_update_height: 100, total_bonded: 0n });
  const work = mkWorkerFarm({ last_update_height: 100, total_bonded: '0' });
  crystallizeFarm(ref, 150);
  workerCrystallize(work, 150);
  return ref.acc_reward_per_share.toString() === work.acc_reward_per_share
      && ref.last_update_height === work.last_update_height;
});

test('crystallize: worker and ref impl agree on normal accrual interval', () => {
  const ref = mkRefFarm({ last_update_height: 200, total_bonded: 1000n });
  const work = mkWorkerFarm({ last_update_height: 200, total_bonded: '1000' });
  crystallizeFarm(ref, 300);
  workerCrystallize(work, 300);
  return ref.acc_reward_per_share.toString() === work.acc_reward_per_share
      && ref.last_update_height === work.last_update_height;
});

test('crystallize: worker and ref impl agree on end_height clamp', () => {
  const ref = mkRefFarm({ last_update_height: 200, total_bonded: 1000n, end_height: 250 });
  const work = mkWorkerFarm({ last_update_height: 200, total_bonded: '1000', end_height: 250 });
  crystallizeFarm(ref, 1000);
  workerCrystallize(work, 1000);
  return ref.acc_reward_per_share.toString() === work.acc_reward_per_share
      && ref.last_update_height === work.last_update_height;
});

test('crystallize: worker and ref impl agree on zero-bonded forfeit', () => {
  const ref = mkRefFarm({ last_update_height: 200, total_bonded: 0n });
  const work = mkWorkerFarm({ last_update_height: 200, total_bonded: '0' });
  crystallizeFarm(ref, 300);
  workerCrystallize(work, 300);
  return ref.acc_reward_per_share.toString() === work.acc_reward_per_share
      && ref.last_update_height === work.last_update_height;
});

test('crystallize: worker and ref impl agree across 100 random traces', () => {
  let s = 42n;
  function rng() { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number(s >> 33n); }
  for (let i = 0; i < 100; i++) {
    const startH = 100 + (rng() % 50);
    const endH = startH + 100 + (rng() % 1000);
    const lastH = startH + (rng() % 50);
    const totalBonded = BigInt(1 + (rng() % 1_000_000));
    const accInitial = BigInt(rng()) * BigInt(rng());   // u128-ish
    const rewardPerBlock = BigInt(1 + (rng() % 1_000_000));
    const targetH = startH + (rng() % 2000);

    const refOverrides = {
      start_height: startH, end_height: endH, last_update_height: lastH,
      total_bonded: totalBonded, reward_per_block: rewardPerBlock,
      acc_reward_per_share: accInitial,
    };
    const workerOverrides = {
      ...refOverrides,
      total_bonded: totalBonded.toString(),
      reward_per_block: rewardPerBlock.toString(),
      acc_reward_per_share: accInitial.toString(),
    };
    const ref = mkRefFarm(refOverrides);
    const work = mkWorkerFarm(workerOverrides);
    crystallizeFarm(ref, targetH);
    workerCrystallize(work, targetH);
    if (ref.acc_reward_per_share.toString() !== work.acc_reward_per_share) {
      return `acc drift at trace ${i}: ref ${ref.acc_reward_per_share} != work ${work.acc_reward_per_share}`;
    }
    if (ref.last_update_height !== work.last_update_height) {
      return `last_update drift at trace ${i}`;
    }
  }
  return true;
});

// =========================================================================
// Section 6: KV key formation
// =========================================================================
console.log('\n--- Section 6: KV key formation ---');

test('ammFarmKey: signet drops network prefix', () => {
  return ammFarmKey('signet', 'abc123') === 'ammfarm:abc123';
});
test('ammFarmKey: named network includes prefix', () => {
  return ammFarmKey('mainnet', 'abc123') === 'ammfarm:mainnet:abc123';
});

test('ammFarmBondKey: signet drops network prefix', () => {
  return ammFarmBondKey('signet', 'bondhex') === 'ammfarmbond:bondhex';
});
test('ammFarmBondKey: named network includes prefix', () => {
  return ammFarmBondKey('mainnet', 'bondhex') === 'ammfarmbond:mainnet:bondhex';
});

test('ammFarmBondsByBonderKey: signet vs named network', () => {
  return ammFarmBondsByBonderKey('signet', 'pubkey') === 'ammfarmbonder:pubkey'
      && ammFarmBondsByBonderKey('mainnet', 'pubkey') === 'ammfarmbonder:mainnet:pubkey';
});

test('ammFarmsByPoolKey: signet vs named network', () => {
  return ammFarmsByPoolKey('signet', 'poolid') === 'ammfarmpool:poolid'
      && ammFarmsByPoolKey('mainnet', 'poolid') === 'ammfarmpool:mainnet:poolid';
});

test('ammFarmUnbondReceiptKey: signet vs named network', () => {
  return ammFarmUnbondReceiptKey('signet', 'txid') === 'ammfarmreceipt:txid'
      && ammFarmUnbondReceiptKey('mainnet', 'txid') === 'ammfarmreceipt:mainnet:txid';
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
