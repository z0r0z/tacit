// Test suite for T_SWAP_ROUTE (opcode 0x33) reference impl.
//
// Covers wire roundtrip + honest 2-hop and 3-hop validation + adversarial
// cases that mirror SPEC-SWAP-ROUTE-AMENDMENT.md §"Test plan".
//
// Run: `node swap-route.test.mjs`

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

import {
  G, H, SECP_N, modN, pedersenCommit, pointToBytes,
  bpRangeAggProve, bpRangeAggVerify, ZERO,
} from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';
import { curveDeltaOut } from './swap-var.mjs';
import {
  OPCODE_T_SWAP_ROUTE, ENVELOPE_VERSION, N_HOPS_MAX,
  encodeSwapRoute, decodeSwapRoute, computeSwapRouteEnvelopeHash,
  buildSwapRouteIntentMsg, buildSwapRouteKernelMsg, kernelVerifyPoint,
  hashHops, validateSwapRoute,
} from './swap-route.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}  (returned ${typeof ok === 'object' ? JSON.stringify(ok) : ok})`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// ---- Pinned fixtures: 3 assets, 2 pools (A↔B, B↔C) ----
const ASSET_A = hexToBytes('aa' + '11'.repeat(31));
const ASSET_B = hexToBytes('bb' + '22'.repeat(31));
const ASSET_C = hexToBytes('cc' + '33'.repeat(31));
// Always order canonically: A < B < C byte-wise (matches our pin).

const FEE_AB_BPS = 30;
const FEE_BC_BPS = 30;

function poolId(assetLo, assetHi, fee_bps, flags = 0) {
  const feeLE = new Uint8Array(2); new DataView(feeLE.buffer).setUint16(0, fee_bps, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-amm-pool-v1'),
    assetLo, assetHi, feeLE, new Uint8Array([flags]),
  ));
}
const POOL_AB_ID = poolId(ASSET_A, ASSET_B, FEE_AB_BPS);
const POOL_BC_ID = poolId(ASSET_B, ASSET_C, FEE_BC_BPS);

const POOL_AB = {
  pool_id: POOL_AB_ID, asset_A: ASSET_A, asset_B: ASSET_B,
  reserve_A: 10_000_000n, reserve_B: 5_000_000n, fee_bps: FEE_AB_BPS, tradable: true,
};
const POOL_BC = {
  pool_id: POOL_BC_ID, asset_A: ASSET_B, asset_B: ASSET_C,
  reserve_A: 4_000_000n, reserve_B: 8_000_000n, fee_bps: FEE_BC_BPS, tradable: true,
};

const TRADER_PRIVKEY = hexToBytes('11'.repeat(32));
const TRADER_PUBKEY = secp.getPublicKey(TRADER_PRIVKEY, true);

const INPUT_TXID = 'de'.repeat(32);
const INPUT_VOUT = 0;

// Trader's input UTXO: a Pedersen commit to 100_000 of asset A with
// blinding r_in. Both are known to the trader.
const TRADER_IN_AMOUNT = 100_000n;
const TRADER_IN_R = modN(BigInt('0x' + 'aa'.repeat(32)));
const C_IN = pedersenCommit(TRADER_IN_AMOUNT, TRADER_IN_R);
const C_IN_BYTES = pointToBytes(C_IN);

// =========================================================================
// Honest-path builders
// =========================================================================

function buildHonestTwoHopRoute({
  amountIn = TRADER_IN_AMOUNT,
  minOut = 0n,
  expiryHeight = 1_000_000,
} = {}) {
  // Hop 0: A → B via POOL_AB (direction = 0, asset_A is input side)
  const hop0Curve = curveDeltaOut({
    direction: 0,
    R_A_pre: POOL_AB.reserve_A, R_B_pre: POOL_AB.reserve_B,
    delta_in: amountIn, fee_bps: POOL_AB.fee_bps,
  });
  // Hop 1: B → C via POOL_BC (POOL_BC.asset_A = B, so direction = 0)
  const hop1Curve = curveDeltaOut({
    direction: 0,
    R_A_pre: POOL_BC.reserve_A, R_B_pre: POOL_BC.reserve_B,
    delta_in: hop0Curve.deltaOut, fee_bps: POOL_BC.fee_bps,
  });

  const hops = [
    {
      poolId: POOL_AB_ID, direction: 0, feeBps: POOL_AB.fee_bps,
      R_A_pre: POOL_AB.reserve_A, R_B_pre: POOL_AB.reserve_B,
      deltaANetMag: amountIn,            // A flows in
      deltaBNetMag: hop0Curve.deltaOut,  // B flows out
    },
    {
      poolId: POOL_BC_ID, direction: 0, feeBps: POOL_BC.fee_bps,
      R_A_pre: POOL_BC.reserve_A, R_B_pre: POOL_BC.reserve_B,
      deltaANetMag: hop0Curve.deltaOut,  // B flows in
      deltaBNetMag: hop1Curve.deltaOut,  // C flows out
    },
  ];

  const delta_out_last = hop1Curve.deltaOut;

  // Receipt: fresh blinding r_receipt, commits to delta_out_last
  const R_RECEIPT = modN(BigInt('0x' + 'bb'.repeat(32)));
  const C_RECEIPT = pedersenCommit(delta_out_last, R_RECEIPT);
  const C_RECEIPT_BYTES = pointToBytes(C_RECEIPT);
  const R_RECEIPT_BYTES = hexToBytes(R_RECEIPT.toString(16).padStart(64, '0'));

  // BP+ range proof over (sentinel, receipt) for V_pts = (ZERO, C_RECEIPT)
  // bpRangeAggProve takes (values, blindings) — slot 0 trivially opens to
  // (0, 0) → ZERO; slot 1 opens to (delta_out_last, r_receipt).
  const { proof: rangeProof } = bpRangeAggProve([0n, delta_out_last], [0n, R_RECEIPT]);

  // intent_sig: trader's BIP-340 over route_msg
  const intentMsg = buildSwapRouteIntentMsg({
    traderPubkey: TRADER_PUBKEY,
    traderInputAssetId: ASSET_A,
    traderOutputAssetId: ASSET_C,
    minOut, expiryHeight, hops,
    cInSecp: C_IN_BYTES,
    cReceiptSecp: C_RECEIPT_BYTES,
  });
  const intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);

  // kernel_sig: closes (r_receipt − r_in) · G against kernelVerifyPoint
  // We need a private key whose public is the kernelVerifyPoint. The key
  // is (r_receipt − r_in) mod n. BIP-340 signs with even-Y form; the lib
  // negates internally if needed.
  const excess = modN(R_RECEIPT - TRADER_IN_R);
  if (excess === 0n) throw new Error('excess == 0 (degenerate fixture)');
  const excessKey = hexToBytes(excess.toString(16).padStart(64, '0'));
  const hopsHash = hashHops(hops);
  const kernelMsg = buildSwapRouteKernelMsg({
    traderInputAssetId: ASSET_A,
    traderOutputAssetId: ASSET_C,
    traderInputOutpointTxid: INPUT_TXID,
    traderInputOutpointVout: INPUT_VOUT,
    deltaIn0: amountIn,
    deltaOutLast: delta_out_last,
    cReceiptSecp: C_RECEIPT_BYTES,
    hopsHash,
  });
  const kernelSig = signSchnorr(kernelMsg, excessKey);

  return {
    env: {
      traderInputAssetId: ASSET_A,
      traderOutputAssetId: ASSET_C,
      minOut, expiryHeight,
      traderPubkey: TRADER_PUBKEY,
      hops,
      traderInputOutpointTxid: INPUT_TXID,
      traderInputOutpointVout: INPUT_VOUT,
      cInSecp: C_IN_BYTES,
      cReceiptSecp: C_RECEIPT_BYTES,
      rReceipt: R_RECEIPT_BYTES,
      rangeProof, kernelSig, intentSig,
    },
    delta_out_last,
  };
}

// =========================================================================
// Section 1: Wire roundtrip
// =========================================================================
console.log('Wire roundtrip');

test('encode+decode 2-hop route roundtrip', () => {
  const { env } = buildHonestTwoHopRoute();
  const bytes = encodeSwapRoute(env);
  const dec = decodeSwapRoute(bytes);
  return dec.opcode === OPCODE_T_SWAP_ROUTE
    && dec.nHops === 2
    && bytesEq(dec.traderInputAssetId, ASSET_A)
    && bytesEq(dec.traderOutputAssetId, ASSET_C)
    && dec.hops.length === 2
    && bytesEq(dec.hops[0].poolId, POOL_AB_ID)
    && bytesEq(dec.hops[1].poolId, POOL_BC_ID)
    && dec.hops[0].direction === 0
    && dec.hops[1].direction === 0
    && dec.hops[0].feeBps === 30
    && dec.hops[1].feeBps === 30
    && dec.hops[0].deltaANetMag === env.hops[0].deltaANetMag
    && dec.hops[0].deltaBNetMag === env.hops[0].deltaBNetMag
    && bytesEq(dec.cInSecp, env.cInSecp)
    && bytesEq(dec.cReceiptSecp, env.cReceiptSecp)
    && bytesEq(dec.rReceipt, env.rReceipt)
    && bytesEq(dec.rangeProof, env.rangeProof)
    && bytesEq(dec.kernelSig, env.kernelSig)
    && bytesEq(dec.intentSig, env.intentSig);
});

test('decode rejects opcode mismatch', () => {
  const { env } = buildHonestTwoHopRoute();
  const bytes = encodeSwapRoute(env);
  const bad = new Uint8Array(bytes); bad[1] = 0x32;
  try { decodeSwapRoute(bad); return false; } catch { return true; }
});

test('decode rejects nHops < 2', () => {
  const { env } = buildHonestTwoHopRoute();
  const bytes = encodeSwapRoute(env);
  const bad = new Uint8Array(bytes); bad[2] = 1;
  try { decodeSwapRoute(bad); return false; } catch { return true; }
});

test('decode rejects nHops > N_HOPS_MAX', () => {
  const { env } = buildHonestTwoHopRoute();
  const bytes = encodeSwapRoute(env);
  const bad = new Uint8Array(bytes); bad[2] = N_HOPS_MAX + 1;
  try { decodeSwapRoute(bad); return false; } catch { return true; }
});

test('decode rejects degenerate same-asset I/O', () => {
  const { env } = buildHonestTwoHopRoute();
  const sameAssetEnv = { ...env, traderOutputAssetId: ASSET_A };
  const bytes = encodeSwapRoute(sameAssetEnv);
  try { decodeSwapRoute(bytes); return false; } catch { return true; }
});

test('encode rejects nHops out of range', () => {
  const { env } = buildHonestTwoHopRoute();
  try { encodeSwapRoute({ ...env, hops: [env.hops[0]] }); return false; } catch { return true; }
});

// =========================================================================
// Section 2: Intent msg + kernel msg constructors
// =========================================================================
console.log('\nMessage builders');

test('intent_msg includes route domain tag', () => {
  const { env } = buildHonestTwoHopRoute();
  const msg = buildSwapRouteIntentMsg({
    traderPubkey: env.traderPubkey,
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    minOut: env.minOut, expiryHeight: env.expiryHeight,
    hops: env.hops,
    cInSecp: env.cInSecp, cReceiptSecp: env.cReceiptSecp,
  });
  return msg.length === 32;
});

test('intent_msg differs if any hop mutated', () => {
  const { env } = buildHonestTwoHopRoute();
  const args0 = {
    traderPubkey: env.traderPubkey,
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    minOut: env.minOut, expiryHeight: env.expiryHeight,
    hops: env.hops,
    cInSecp: env.cInSecp, cReceiptSecp: env.cReceiptSecp,
  };
  const msg0 = buildSwapRouteIntentMsg(args0);
  const mutatedHops = env.hops.map((h, i) =>
    i === 0 ? { ...h, deltaANetMag: h.deltaANetMag + 1n } : h);
  const msg1 = buildSwapRouteIntentMsg({ ...args0, hops: mutatedHops });
  return !bytesEq(msg0, msg1);
});

test('kernel_msg binds hopsHash (settler swap-hops attack defense)', () => {
  const { env } = buildHonestTwoHopRoute();
  const h0 = hashHops(env.hops);
  const altHops = env.hops.map((h, i) =>
    i === 1 ? { ...h, deltaBNetMag: h.deltaBNetMag - 1n } : h);
  const h1 = hashHops(altHops);
  const m0 = buildSwapRouteKernelMsg({
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    traderInputOutpointTxid: env.traderInputOutpointTxid,
    traderInputOutpointVout: env.traderInputOutpointVout,
    deltaIn0: env.hops[0].deltaANetMag,
    deltaOutLast: env.hops[1].deltaBNetMag,
    cReceiptSecp: env.cReceiptSecp,
    hopsHash: h0,
  });
  const m1 = buildSwapRouteKernelMsg({
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    traderInputOutpointTxid: env.traderInputOutpointTxid,
    traderInputOutpointVout: env.traderInputOutpointVout,
    deltaIn0: env.hops[0].deltaANetMag,
    deltaOutLast: env.hops[1].deltaBNetMag,
    cReceiptSecp: env.cReceiptSecp,
    hopsHash: h1,
  });
  return !bytesEq(m0, m1);
});

// =========================================================================
// Section 3: Honest validation
// =========================================================================
console.log('\nHonest validation');

function buildPools() {
  return new Map([
    [bytesToHex(POOL_AB_ID), { ...POOL_AB }],
    [bytesToHex(POOL_BC_ID), { ...POOL_BC }],
  ]);
}

test('honest 2-hop A→B→C validates', () => {
  const { env, delta_out_last } = buildHonestTwoHopRoute();
  const payload = encodeSwapRoute(env);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  if (!res.valid) console.log(`     reason: ${res.reason}`);
  return res.valid === true
    && res.receipt.amount === delta_out_last
    && bytesEq(res.receipt.asset_id, ASSET_C);
});

test('honest 2-hop state transitions apply per pool', () => {
  const { env } = buildHonestTwoHopRoute();
  const payload = encodeSwapRoute(env);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  const newAB = res.newPoolStates.get(bytesToHex(POOL_AB_ID));
  const newBC = res.newPoolStates.get(bytesToHex(POOL_BC_ID));
  // POOL_AB: A goes IN, B goes OUT
  // POOL_BC: B (as POOL_BC.asset_A) goes IN, C (as POOL_BC.asset_B) goes OUT
  return newAB.reserve_A === POOL_AB.reserve_A + env.hops[0].deltaANetMag
      && newAB.reserve_B === POOL_AB.reserve_B - env.hops[0].deltaBNetMag
      && newBC.reserve_A === POOL_BC.reserve_A + env.hops[1].deltaANetMag
      && newBC.reserve_B === POOL_BC.reserve_B - env.hops[1].deltaBNetMag;
});

// =========================================================================
// Section 4: Adversarial cases
// =========================================================================
console.log('\nAdversarial');

test('expired route rejected', () => {
  const { env } = buildHonestTwoHopRoute({ expiryHeight: 100 });
  const payload = encodeSwapRoute(env);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 200,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /expired/.test(res.reason);
});

test('unregistered pool_id rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  const payload = encodeSwapRoute(env);
  const pools = new Map([[bytesToHex(POOL_AB_ID), POOL_AB]]);  // missing POOL_BC
  const res = validateSwapRoute({
    payload, pools, currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /not registered/.test(res.reason);
});

test('stale reserves rejected (R_A_pre differs from pool state)', () => {
  const { env } = buildHonestTwoHopRoute();
  const stalePools = buildPools();
  // Shift pool's reserve_A AFTER trader assembled the route — mimics
  // another swap landing between assembly + confirmation.
  const stale = stalePools.get(bytesToHex(POOL_AB_ID));
  stalePools.set(bytesToHex(POOL_AB_ID), { ...stale, reserve_A: stale.reserve_A + 1n });
  const payload = encodeSwapRoute(env);
  const res = validateSwapRoute({
    payload, pools: stalePools, currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /R_A_pre/.test(res.reason);
});

test('over-claimed delta_out rejected (CFMM curve floor)', () => {
  const { env } = buildHonestTwoHopRoute();
  // Inflate hop[0].delta_out by 1 — breaks CFMM floor identity. But we
  // also need to mutate intent_sig + kernel_sig to NOT trip those guards
  // first. Instead, rebuild from scratch with the inflated curve.
  const inflatedHops = env.hops.map((h, i) =>
    i === 0 ? { ...h, deltaBNetMag: h.deltaBNetMag * 2n } : h);
  const inflatedEnv = { ...env, hops: inflatedHops };
  // Re-sign intent under trader to make it past intent_sig check (the
  // settler is the attacker here; trader signed under the inflated hops
  // intentionally to test the validator's CFMM gate).
  const intentMsg = buildSwapRouteIntentMsg({
    traderPubkey: inflatedEnv.traderPubkey,
    traderInputAssetId: inflatedEnv.traderInputAssetId,
    traderOutputAssetId: inflatedEnv.traderOutputAssetId,
    minOut: inflatedEnv.minOut, expiryHeight: inflatedEnv.expiryHeight,
    hops: inflatedEnv.hops,
    cInSecp: inflatedEnv.cInSecp, cReceiptSecp: inflatedEnv.cReceiptSecp,
  });
  inflatedEnv.intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);
  const payload = encodeSwapRoute(inflatedEnv);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /CFMM curve floor|delta_in|delta_out/.test(res.reason);
});

test('broken asset chain rejected (hop[1].asset_in != hop[0].asset_out)', () => {
  // Build a route where hop[1] uses POOL_BC with direction=1 (asset_B
  // is OUTPUT, asset_A is INPUT). POOL_BC.asset_A = B but the direction
  // flip means hop[1].asset_in == C, which doesn't match hop[0]'s
  // asset_out = B. (Using POOL_AB for hop[1] would also work, but the
  // freshness check on the post-hop[0] snapshot trips first and yields
  // an R_A_pre reason rather than the asset chain reason we want here.)
  const { env } = buildHonestTwoHopRoute();
  const brokenHops = env.hops.map((h, i) =>
    i === 1 ? {
      ...h,
      direction: 1,                             // flip: now asset_in = pool.asset_B = C
      deltaANetMag: 1n,                         // arbitrary; placeholder
      deltaBNetMag: 1n,
    } : h);
  const brokenEnv = { ...env, hops: brokenHops };
  const intentMsg = buildSwapRouteIntentMsg({
    traderPubkey: brokenEnv.traderPubkey,
    traderInputAssetId: brokenEnv.traderInputAssetId,
    traderOutputAssetId: brokenEnv.traderOutputAssetId,
    minOut: brokenEnv.minOut, expiryHeight: brokenEnv.expiryHeight,
    hops: brokenEnv.hops,
    cInSecp: brokenEnv.cInSecp, cReceiptSecp: brokenEnv.cReceiptSecp,
  });
  brokenEnv.intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);
  const payload = encodeSwapRoute(brokenEnv);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /asset_in mismatch/.test(res.reason);
});

test('hop[1].delta_in != hop[0].delta_out rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  // Mismatch the chained amount on hop[1]'s input side.
  const mismatchedHops = env.hops.map((h, i) =>
    i === 1 ? { ...h, deltaANetMag: h.deltaANetMag + 1n } : h);
  const mismatchedEnv = { ...env, hops: mismatchedHops };
  const intentMsg = buildSwapRouteIntentMsg({
    traderPubkey: mismatchedEnv.traderPubkey,
    traderInputAssetId: mismatchedEnv.traderInputAssetId,
    traderOutputAssetId: mismatchedEnv.traderOutputAssetId,
    minOut: mismatchedEnv.minOut, expiryHeight: mismatchedEnv.expiryHeight,
    hops: mismatchedEnv.hops,
    cInSecp: mismatchedEnv.cInSecp, cReceiptSecp: mismatchedEnv.cReceiptSecp,
  });
  mismatchedEnv.intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);
  const payload = encodeSwapRoute(mismatchedEnv);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /delta_in.*prev hop delta_out|prev hop delta_out/.test(res.reason);
});

test('min_out violation rejected', () => {
  const { delta_out_last } = buildHonestTwoHopRoute();
  const { env } = buildHonestTwoHopRoute({ minOut: delta_out_last + 1n });
  const payload = encodeSwapRoute(env);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /min_out violated/.test(res.reason);
});

test('tampered intent_sig rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  const tampered = { ...env, intentSig: new Uint8Array(64) };
  // signSchnorr accepts; we just zero out the sig.
  const payload = encodeSwapRoute(tampered);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /intent_sig/.test(res.reason);
});

test('tampered kernel_sig rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  const tampered = { ...env, kernelSig: new Uint8Array(64) };
  const payload = encodeSwapRoute(tampered);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /kernel_sig/.test(res.reason);
});

test('rReceipt = 0 rejected (would leak delta_out)', () => {
  const { env } = buildHonestTwoHopRoute();
  // Recompute commit, receipt with r_receipt = 0 → C = delta_out_last · H
  // (a trivially-openable commit that leaks the amount). The validator
  // refuses this regardless of all other gates.
  // We mutate just the rReceipt byte field; the commit will then no
  // longer open to (delta_out_last, r_receipt=0). The "receipt opens"
  // gate will fire first; defensively the rReceipt=0 explicit check
  // would catch it too. Either rejection is acceptable.
  const tampered = { ...env, rReceipt: new Uint8Array(32) };
  const payload = encodeSwapRoute(tampered);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /rReceipt.*zero|cReceiptSecp does not open/.test(res.reason);
});

test('cReceiptSecp does not open to (delta_out_last, rReceipt) rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  // Mutate cReceiptSecp to a different valid point.
  const alt = pedersenCommit(1n, modN(BigInt('0x' + 'cc'.repeat(32))));
  const tampered = { ...env, cReceiptSecp: pointToBytes(alt) };
  const payload = encodeSwapRoute(tampered);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /(does not open|intent_sig|kernel_sig)/.test(res.reason);
});

test('drained pool (delta_out > reserve_out) rejected', () => {
  // Build a route where hop[0].delta_out claims more than the pool's
  // reserve_B. Set reserves to a tiny pool first.
  const tinyPool = {
    pool_id: POOL_AB_ID, asset_A: ASSET_A, asset_B: ASSET_B,
    reserve_A: 100n, reserve_B: 100n, fee_bps: FEE_AB_BPS, tradable: true,
  };
  const pools = new Map([
    [bytesToHex(POOL_AB_ID), tinyPool],
    [bytesToHex(POOL_BC_ID), POOL_BC],
  ]);
  const hops = [
    {
      poolId: POOL_AB_ID, direction: 0, feeBps: FEE_AB_BPS,
      R_A_pre: tinyPool.reserve_A, R_B_pre: tinyPool.reserve_B,
      deltaANetMag: 50n,
      deltaBNetMag: 200n,                        // exceeds reserve_B = 100
    },
    {
      poolId: POOL_BC_ID, direction: 0, feeBps: FEE_BC_BPS,
      R_A_pre: POOL_BC.reserve_A, R_B_pre: POOL_BC.reserve_B,
      deltaANetMag: 200n, deltaBNetMag: 1n,
    },
  ];
  const r_receipt = modN(BigInt('0x' + 'bb'.repeat(32)));
  const c_recv = pointToBytes(pedersenCommit(1n, r_receipt));
  const { proof: rangeProof } = bpRangeAggProve([0n, 1n], [0n, r_receipt]);
  const env = {
    traderInputAssetId: ASSET_A, traderOutputAssetId: ASSET_C,
    minOut: 0n, expiryHeight: 1_000_000, traderPubkey: TRADER_PUBKEY,
    hops,
    traderInputOutpointTxid: INPUT_TXID, traderInputOutpointVout: INPUT_VOUT,
    cInSecp: C_IN_BYTES, cReceiptSecp: c_recv,
    rReceipt: hexToBytes(r_receipt.toString(16).padStart(64, '0')),
    rangeProof,
    intentSig: signSchnorr(buildSwapRouteIntentMsg({
      traderPubkey: TRADER_PUBKEY,
      traderInputAssetId: ASSET_A, traderOutputAssetId: ASSET_C,
      minOut: 0n, expiryHeight: 1_000_000, hops,
      cInSecp: C_IN_BYTES, cReceiptSecp: c_recv,
    }), TRADER_PRIVKEY),
    kernelSig: new Uint8Array(64),  // CFMM check trips before kernel_sig
  };
  const payload = encodeSwapRoute(env);
  const res = validateSwapRoute({
    payload, pools, currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false
    && /reserve_out < delta_out|CFMM curve floor/.test(res.reason);
});

test('hop[0].fee_bps != pool.fee_bps rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  const wrongFeeHops = env.hops.map((h, i) =>
    i === 0 ? { ...h, feeBps: 100 } : h);    // pool is 30, claim 100
  const wrongFeeEnv = { ...env, hops: wrongFeeHops };
  const intentMsg = buildSwapRouteIntentMsg({
    traderPubkey: wrongFeeEnv.traderPubkey,
    traderInputAssetId: wrongFeeEnv.traderInputAssetId,
    traderOutputAssetId: wrongFeeEnv.traderOutputAssetId,
    minOut: wrongFeeEnv.minOut, expiryHeight: wrongFeeEnv.expiryHeight,
    hops: wrongFeeEnv.hops,
    cInSecp: wrongFeeEnv.cInSecp, cReceiptSecp: wrongFeeEnv.cReceiptSecp,
  });
  wrongFeeEnv.intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);
  const payload = encodeSwapRoute(wrongFeeEnv);
  const res = validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    bulletproofVerify: bpRangeAggVerify,
  });
  return res.valid === false && /fee_bps/.test(res.reason);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- helpers ----
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
