// Generator for CROSS-IMPL-TEST-VECTORS.md fill-in values.
//
// Runs the reference impl with the canonical pinned inputs and emits the
// derived values (pubkeys, asset_ids, pool_ids, intent_pool_hashes,
// qualifying_set_hashes, claim_msgs, etc.) for direct paste-in to the
// cross-impl vectors document. Vectors requiring real Groth16 proofs
// (T_LP_ADD, T_LP_REMOVE, T_SWAP_BATCH proof bytes) remain TODO until
// after the Phase 2 ceremony.
//
// Run: node tests/cross-impl-vectors-gen.mjs

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import { computeIntentPoolHash } from './amm-attest.mjs';
import { derivePoolId, deriveLpAssetId } from './amm-asset.mjs';
import { computeQualifyingSetHash } from './amm-validator.mjs';
import { buildProtocolFeeClaimMsgWith } from './amm-protocol-fee.mjs';
import { buildIntentMsg, deriveIntentId } from './amm-intent.mjs';

// ===== Canonical inputs (mirror CROSS-IMPL-TEST-VECTORS.md §"Shared canonical inputs") =====
const CANONICAL = {
  asset_id_TAC:      '0xaa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11',
  asset_id_cBTC:     '0xbb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22',
  asset_id_cUSD:     '0xcc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33',
  trader_privkey_A:  '0x1111111111111111111111111111111111111111111111111111111111111111',
  trader_privkey_B:  '0x2222222222222222222222222222222222222222222222222222222222222222',
  trader_privkey_C:  '0x3333333333333333333333333333333333333333333333333333333333333333',
  worker_privkey_W1: '0xaabb00112233445566778899aabbccddeeff00112233445566778899aabbccdd',
  worker_privkey_W2: '0xccdd00112233445566778899aabbccddeeff00112233445566778899aabbccdd',
};

const CANONICAL_OUTPOINTS = {
  trader_A_tac_utxo: {
    txid_BE: '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
    vout: 0,
  },
  trader_B_cbtc_utxo: {
    txid_BE: '0xdeadbeef00000000000000000000000000000000000000000000000000000002',
    vout: 1,
  },
};

function fromHex(hexStr) {
  return hexToBytes(hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr);
}
function pubkeyOf(privkeyHex) {
  return secp.ProjectivePoint.fromPrivateKey(fromHex(privkeyHex)).toRawBytes(true);
}

const out = [];
function emit(label, value) { out.push({ label, value }); }

// ===== Pubkeys =====
emit('trader_pubkey_A (33-byte compressed)', '0x' + bytesToHex(pubkeyOf(CANONICAL.trader_privkey_A)));
emit('trader_pubkey_B', '0x' + bytesToHex(pubkeyOf(CANONICAL.trader_privkey_B)));
emit('trader_pubkey_C', '0x' + bytesToHex(pubkeyOf(CANONICAL.trader_privkey_C)));
emit('worker_pubkey_W1', '0x' + bytesToHex(pubkeyOf(CANONICAL.worker_privkey_W1)));
emit('worker_pubkey_W2', '0x' + bytesToHex(pubkeyOf(CANONICAL.worker_privkey_W2)));

// ===== Pool & LP asset IDs =====
// Canonical pair: TAC + cBTC, lex-ascending → TAC (0xaa…) < cBTC (0xbb…).
// pool_id discriminators now include fee_bps + capability_flags per
// AMM.md §"Pool state" (V3/V4 fee-tier parity). Canonical test vectors
// use fee_bps=30 (standard 3 bps tier), capability_flags=0 (default).
const CANONICAL_FEE_BPS = 30;
const CANONICAL_CAPABILITY_FLAGS = 0;
const assetA = fromHex(CANONICAL.asset_id_TAC);   // smaller
const assetB = fromHex(CANONICAL.asset_id_cBTC);  // larger
const poolId_TAC_cBTC = derivePoolId(assetA, assetB, CANONICAL_FEE_BPS, CANONICAL_CAPABILITY_FLAGS);
emit('pool_id (TAC,cBTC,fee=30,flags=0) = SHA256("tacit-amm-pool-v1" || asset_min || asset_max || fee_bps_LE || flags)',
     '0x' + bytesToHex(poolId_TAC_cBTC));

const lpAssetId_TAC_cBTC = deriveLpAssetId(poolId_TAC_cBTC);
emit('lp_asset_id = SHA256("tacit-amm-lp-v1" || pool_id)',
     '0x' + bytesToHex(lpAssetId_TAC_cBTC));

// Cross-fee-tier vector: same pair at fee=5 bps yields a distinct pool_id
// and lp_asset_id. Implementations MUST reproduce both vectors to confirm
// fee_bps is in the preimage.
const poolId_TAC_cBTC_fee5 = derivePoolId(assetA, assetB, 5, CANONICAL_CAPABILITY_FLAGS);
emit('pool_id (TAC,cBTC,fee=5,flags=0)', '0x' + bytesToHex(poolId_TAC_cBTC_fee5));
emit('lp_asset_id (TAC,cBTC,fee=5,flags=0)', '0x' + bytesToHex(deriveLpAssetId(poolId_TAC_cBTC_fee5)));

// Cross-capability-flags vector: same pair + fee at flags=0x02 (solo-intent
// opt-in) yields a distinct pool_id.
const poolId_TAC_cBTC_flags2 = derivePoolId(assetA, assetB, CANONICAL_FEE_BPS, 0x02);
emit('pool_id (TAC,cBTC,fee=30,flags=2)', '0x' + bytesToHex(poolId_TAC_cBTC_flags2));

// Also for TAC + cUSD pool.
const assetA2 = fromHex(CANONICAL.asset_id_TAC);
const assetB2 = fromHex(CANONICAL.asset_id_cUSD);
const poolId_TAC_cUSD = derivePoolId(assetA2, assetB2, CANONICAL_FEE_BPS, CANONICAL_CAPABILITY_FLAGS);
emit('pool_id (TAC,cUSD,fee=30,flags=0)', '0x' + bytesToHex(poolId_TAC_cUSD));
emit('lp_asset_id (TAC,cUSD,fee=30,flags=0)', '0x' + bytesToHex(deriveLpAssetId(poolId_TAC_cUSD)));

// ===== Intent-pool hashes =====
emit('intent_pool_hash (empty pool) = SHA256("")',
     '0x' + bytesToHex(computeIntentPoolHash([])));

// Sample populated pool with three intents (deterministic byte fills).
const id_X = new Uint8Array(32).fill(0x11);
const id_Y = new Uint8Array(32).fill(0x22);
const id_Z = new Uint8Array(32).fill(0x33);
emit('intent_pool_hash ([0x11×32, 0x22×32, 0x33×32], sorted ascending)',
     '0x' + bytesToHex(computeIntentPoolHash([id_Z, id_X, id_Y])));

// ===== Qualifying-set hash =====
// pool: TAC/cBTC, height 850123, single intent_id 0x11×32.
{
  const qsetHash = computeQualifyingSetHash({
    poolId: poolId_TAC_cBTC,
    height: 850123,
    intentIds: [id_X],
  });
  emit('qualifying_set_hash (TAC/cBTC, h=850123, intents=[0x11×32])',
       '0x' + bytesToHex(qsetHash));
}
// Multi-intent qualifying set.
{
  const ids = [id_X, id_Y, id_Z];
  // Sort ascending byte-order — already in order here.
  const qsetHash = computeQualifyingSetHash({
    poolId: poolId_TAC_cBTC,
    height: 850123,
    intentIds: ids,
  });
  emit('qualifying_set_hash (TAC/cBTC, h=850123, intents=[0x11,0x22,0x33])',
       '0x' + bytesToHex(qsetHash));
}

// ===== T_PROTOCOL_FEE_CLAIM claim_msg =====
{
  const claimAmount = 12345n;
  const claimCSecp = new Uint8Array(33); claimCSecp[0] = 0x02; claimCSecp.fill(0xcd, 1);
  const claimBlinding = new Uint8Array(32).fill(0x9e);
  const msg = buildProtocolFeeClaimMsgWith(sha256, {
    poolId: poolId_TAC_cBTC,
    claimAmount,
    claimCSecp,
    claimBlinding,
  });
  emit('claim_msg (pool=TAC/cBTC, amount=12345, C=0x02||0xcd×32, r=0x9e×32)',
       '0x' + bytesToHex(msg));
}

// ===== intent_msg + intent_id (T_SWAP_BATCH single-trader sample) =====
{
  const direction = 0; // A→B
  const inputUtxos = [{ txid: 'deadbeef00000000000000000000000000000000000000000000000000000001', vout: 0 }];
  const cInSecp = new Uint8Array(33); cInSecp[0] = 0x02; cInSecp.fill(0xa1, 1);
  const cInBjj = new Uint8Array(32).fill(0xb2);
  const xcurveSigma = new Uint8Array(169).fill(0xc3);   // 169-byte placeholder
  const receiveScriptPubKey = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xd4)]);
  const minOut = 950n;
  const tipAmount = 50n;
  const tipAsset = 0;
  const expiryHeight = 850130;
  const traderPubkey = pubkeyOf(CANONICAL.trader_privkey_A);

  const intentMsg = buildIntentMsg({
    poolId: poolId_TAC_cBTC, direction, inputUtxos,
    cInSecp, cInBjj, xcurveSigma,
    receiveScriptPubKey, minOut, tipAmount, tipAsset,
    expiryHeight, traderPubkey,
  });
  const intentId = deriveIntentId(intentMsg);
  emit('intent_msg (sample A→B swap; full preimage hex)',
       '0x' + bytesToHex(intentMsg));
  emit('intent_id = SHA256(intent_msg)', '0x' + bytesToHex(intentId));
}

// ===== T_INTENT_ATTEST canonical envelope-hash sample =====
// (Envelope bytes themselves require signing; here we just publish the
//  pre-sig canonical hash that gets BIP-340-signed.)
{
  const scopeId = poolId_TAC_cBTC;
  const intentPoolHash = computeIntentPoolHash([id_X, id_Y, id_Z]);
  const heightLE = new Uint8Array(4);
  new DataView(heightLE.buffer).setUint32(0, 850123, true);
  const timestampLE = new Uint8Array(8);
  let ts = 1700000000n;
  for (let i = 0; i < 8; i++) { timestampLE[i] = Number(ts & 0xffn); ts >>= 8n; }
  const intentCountLE = new Uint8Array(2);
  new DataView(intentCountLE.buffer).setUint16(0, 3, true);
  const snapshotUri = '';
  const uriBytes = new TextEncoder().encode(snapshotUri);
  const workerPubkey = pubkeyOf(CANONICAL.worker_privkey_W1);

  const preSig = concatBytes(
    new Uint8Array([0x30]), // opcode
    scopeId,
    intentPoolHash,
    heightLE,
    timestampLE,
    intentCountLE,
    new Uint8Array([uriBytes.length]),
    uriBytes,
    workerPubkey,
  );
  const signedDigest = sha256(concatBytes(
    new TextEncoder().encode('tacit-intent-attest-v1'),
    preSig,
  ));
  emit('T_INTENT_ATTEST canonical pre-sig digest (sample, h=850123, 3 intents, W1)',
       '0x' + bytesToHex(signedDigest));
}

// ===== T_RANGE_ATTEST canonical pre-sig digest sample =====
{
  // Sample range attestation: scope=poolId_TAC_cBTC, expiry=850500,
  // single outpoint (trader_A_tac_utxo), attestation_bytes for PRED_GE
  // with X=1000 (we only need the bytes structure not a real bulletproof
  // for the canonical digest pinning — but include a fixed 700-byte
  // placeholder so the offsets line up).
  const scopeId = poolId_TAC_cBTC;
  const expiryLE = new Uint8Array(4);
  new DataView(expiryLE.buffer).setUint32(0, 850500, true);
  const count = 1;
  const opTxid = fromHex(CANONICAL_OUTPOINTS.trader_A_tac_utxo.txid_BE);
  const opVoutLE = new Uint8Array(4);
  new DataView(opVoutLE.buffer).setUint32(0, 0, true);
  // PRED_GE attestation: tag(1) + X_LE(8) + proof_len_LE(2) + proof(700)
  const attTag = new Uint8Array([0x00]);
  const X = new Uint8Array(8);
  let x = 1000n;
  for (let i = 0; i < 8; i++) { X[i] = Number(x & 0xffn); x >>= 8n; }
  const fixedProofBytes = new Uint8Array(700).fill(0x5a);
  const attLenLE = new Uint8Array(2);
  new DataView(attLenLE.buffer).setUint16(0, 1 + 8 + 2 + 700, true);
  const attestationBytes = concatBytes(
    attTag, X, new Uint8Array([700 & 0xff, (700 >> 8) & 0xff]), fixedProofBytes,
  );
  const holderPubkey = pubkeyOf(CANONICAL.trader_privkey_A);

  const preSig = concatBytes(
    new Uint8Array([0x3A]),
    scopeId,
    expiryLE,
    new Uint8Array([count]),
    opTxid, opVoutLE,
    attLenLE, attestationBytes,
    holderPubkey,
  );
  const digest = sha256(concatBytes(
    new TextEncoder().encode('tacit-range-attest-v1'),
    preSig,
  ));
  emit('T_RANGE_ATTEST canonical pre-sig digest (sample PRED_GE; placeholder 700-B proof)',
       '0x' + bytesToHex(digest));
}

// ===== Print =====
console.log('# Generated vectors\n');
console.log('# Source: tests/cross-impl-vectors-gen.mjs');
console.log('# Run: node tests/cross-impl-vectors-gen.mjs');
console.log('# Paste these values into ops/planning/CROSS-IMPL-TEST-VECTORS.md\n');
for (const { label, value } of out) {
  console.log(`# ${label}`);
  console.log(`${value}\n`);
}
