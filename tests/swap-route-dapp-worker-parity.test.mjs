// Cross-impl parity: tests/swap-route.mjs reference impl ↔ worker
// `decodeTSwapRoutePayload` + `ammSwapRouteIntentMsg` +
// `ammSwapRouteKernelMsg`. The dapp builder inlines byte-identical
// copies of these (see `dapp/tacit.js` T_SWAP_ROUTE section); this
// suite verifies the worker decodes the reference encoder's output
// AND that both sides reach the same intent_msg / kernel_msg / hops
// hash bytes for the same fixture.
//
// Run: node tests/swap-route-dapp-worker-parity.test.mjs

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  G, H, SECP_N, modN, pedersenCommit, pointToBytes,
  bpRangeAggProve, ZERO,
} from './bulletproofs.mjs';
import { signSchnorr } from './composition.mjs';
import { curveDeltaOut } from './swap-var.mjs';
import {
  encodeSwapRoute, buildSwapRouteIntentMsg, buildSwapRouteKernelMsg, hashHops,
} from './swap-route.mjs';

import * as workerMod from '../worker/src/index.js';
const {
  decodeTSwapRoutePayload,
  ammSwapRouteIntentMsg,
  ammSwapRouteKernelMsg,
  T_SWAP_ROUTE: WORKER_T_SWAP_ROUTE,
  SWAP_ROUTE_N_HOPS_MAX: WORKER_N_HOPS_MAX,
} = workerMod;

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}  (${typeof ok === 'object' ? JSON.stringify(ok) : ok})`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}
function bytesEq(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Fixture: 2-hop A→B→C using two pools ----
const ASSET_A = hexToBytes('aa' + '11'.repeat(31));
const ASSET_B = hexToBytes('bb' + '22'.repeat(31));
const ASSET_C = hexToBytes('cc' + '33'.repeat(31));

function poolId(a, b, fee_bps, flags = 0) {
  const feeLE = new Uint8Array(2); new DataView(feeLE.buffer).setUint16(0, fee_bps, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-amm-pool-v1'),
    a, b, feeLE, new Uint8Array([flags]),
  ));
}
const POOL_AB = poolId(ASSET_A, ASSET_B, 30);
const POOL_BC = poolId(ASSET_B, ASSET_C, 30);

const TRADER_PRIV = hexToBytes('11'.repeat(32));
const TRADER_PUB = secp.getPublicKey(TRADER_PRIV, true);
const INPUT_TXID = 'de'.repeat(32);
const INPUT_VOUT = 0;
const INPUT_AMOUNT = 100_000n;
const INPUT_R = modN(BigInt('0x' + 'aa'.repeat(32)));
const C_IN = pointToBytes(pedersenCommit(INPUT_AMOUNT, INPUT_R));

// Hop 0: A→B over POOL_AB (1e7 / 5e6, fee 30 bps)
const hop0 = curveDeltaOut({
  direction: 0, R_A_pre: 10_000_000n, R_B_pre: 5_000_000n,
  delta_in: INPUT_AMOUNT, fee_bps: 30,
});
// Hop 1: B→C over POOL_BC (4e6 / 8e6, fee 30 bps)
const hop1 = curveDeltaOut({
  direction: 0, R_A_pre: 4_000_000n, R_B_pre: 8_000_000n,
  delta_in: hop0.deltaOut, fee_bps: 30,
});
const DELTA_OUT_LAST = hop1.deltaOut;

const HOPS = [
  {
    poolId: POOL_AB, direction: 0, feeBps: 30,
    R_A_pre: 10_000_000n, R_B_pre: 5_000_000n,
    deltaANetMag: INPUT_AMOUNT, deltaBNetMag: hop0.deltaOut,
  },
  {
    poolId: POOL_BC, direction: 0, feeBps: 30,
    R_A_pre: 4_000_000n, R_B_pre: 8_000_000n,
    deltaANetMag: hop0.deltaOut, deltaBNetMag: hop1.deltaOut,
  },
];

const R_RECEIPT = modN(BigInt('0x' + 'bb'.repeat(32)));
const C_RECEIPT = pointToBytes(pedersenCommit(DELTA_OUT_LAST, R_RECEIPT));
const R_RECEIPT_BYTES = hexToBytes(R_RECEIPT.toString(16).padStart(64, '0'));

const { proof: rangeProof } = bpRangeAggProve([0n, DELTA_OUT_LAST], [0n, R_RECEIPT]);

const ROUTE_MSG = buildSwapRouteIntentMsg({
  traderPubkey: TRADER_PUB,
  traderInputAssetId: ASSET_A,
  traderOutputAssetId: ASSET_C,
  minOut: 0n,
  expiryHeight: 1_000_000,
  hops: HOPS,
  cInSecp: C_IN,
  cReceiptSecp: C_RECEIPT,
});
const INTENT_SIG = signSchnorr(ROUTE_MSG, TRADER_PRIV);

const HOPS_HASH = hashHops(HOPS);
const KERNEL_MSG = buildSwapRouteKernelMsg({
  traderInputAssetId: ASSET_A,
  traderOutputAssetId: ASSET_C,
  traderInputOutpointTxid: INPUT_TXID,
  traderInputOutpointVout: INPUT_VOUT,
  deltaIn0: INPUT_AMOUNT,
  deltaOutLast: DELTA_OUT_LAST,
  cReceiptSecp: C_RECEIPT,
  hopsHash: HOPS_HASH,
});
const KERNEL_EXCESS = modN(R_RECEIPT - INPUT_R);
const KERNEL_SIG = signSchnorr(
  KERNEL_MSG,
  hexToBytes(KERNEL_EXCESS.toString(16).padStart(64, '0')),
);

const PAYLOAD = encodeSwapRoute({
  traderInputAssetId: ASSET_A,
  traderOutputAssetId: ASSET_C,
  minOut: 0n,
  expiryHeight: 1_000_000,
  traderPubkey: TRADER_PUB,
  hops: HOPS,
  traderInputOutpointTxid: INPUT_TXID,
  traderInputOutpointVout: INPUT_VOUT,
  cInSecp: C_IN,
  cReceiptSecp: C_RECEIPT,
  rReceipt: R_RECEIPT_BYTES,
  rangeProof, kernelSig: KERNEL_SIG, intentSig: INTENT_SIG,
});

// =========================================================================
// Tests
// =========================================================================
console.log('worker module exports');
test('worker exports T_SWAP_ROUTE = 0x33', () => WORKER_T_SWAP_ROUTE === 0x33);
test('worker exports SWAP_ROUTE_N_HOPS_MAX = 4', () => WORKER_N_HOPS_MAX === 4);

console.log('\nworker decoder parity');
const decoded = decodeTSwapRoutePayload(PAYLOAD);
test('worker decoder accepts reference-encoded payload', () => decoded !== null);
test('decoded n_hops == 2', () => decoded.n_hops === 2);
test('decoded asset_in matches', () => decoded.trader_input_asset_id === bytesToHex(ASSET_A));
test('decoded asset_out matches', () => decoded.trader_output_asset_id === bytesToHex(ASSET_C));
test('decoded hop[0] pool_id matches', () => decoded.hops[0].pool_id === bytesToHex(POOL_AB));
test('decoded hop[1] pool_id matches', () => decoded.hops[1].pool_id === bytesToHex(POOL_BC));
test('decoded c_receipt matches', () => decoded.c_receipt_secp === bytesToHex(C_RECEIPT));
test('decoded c_in matches',      () => decoded.c_in_secp      === bytesToHex(C_IN));
test('decoded range_proof matches', () =>
  decoded.range_proof === bytesToHex(rangeProof));

console.log('\nworker intent_msg / kernel_msg parity');
const workerIntentMsg = ammSwapRouteIntentMsg(decoded);
test('worker ammSwapRouteIntentMsg byte-equals reference buildSwapRouteIntentMsg', () =>
  bytesEq(workerIntentMsg, ROUTE_MSG));

const workerKernelMsg = ammSwapRouteKernelMsg(decoded, INPUT_AMOUNT, DELTA_OUT_LAST);
test('worker ammSwapRouteKernelMsg byte-equals reference buildSwapRouteKernelMsg', () =>
  bytesEq(workerKernelMsg, KERNEL_MSG));

console.log(`\n${pass}/${pass + fail} parity checks passed`);
if (fail > 0) process.exit(1);
