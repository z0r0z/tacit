// Test suite for the T_SWAP_ROUTE (opcode 0x33) reference impl.
//
// Covers the wire roundtrip, the intent/kernel message builders, and the validator's mirror of the
// Bitcoin reflection guest's fold: hops re-cleared at current reserves and registry fee tiers, the
// refund branch (expiry, min_out miss, a hop clearing to nothing), and the destination/input bindings.
//
// Run: `node swap-route.test.mjs`

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';

import {
  modN, pedersenCommit, pointToBytes, bpRangeAggProve,
} from './bulletproofs.mjs';
import { signSchnorr } from './composition.mjs';
import { curveDeltaOut } from './swap-var.mjs';
import {
  OPCODE_T_SWAP_ROUTE, N_HOPS_MAX,
  encodeSwapRoute, decodeSwapRoute, computeSwapRouteEnvelopeHash,
  buildSwapRouteIntentMsg as _buildSwapRouteIntentMsg, buildSwapRouteKernelMsg,
  buildSwapRouteHop0KernelMsg, getAmountOut,
  hashHops, validateSwapRoute as _validateSwapRoute,
} from './swap-route.mjs';

// Receipt (vout 1) and refund (vout 2) scriptPubKeys the intent binds. Defaulted here (overridable per
// test); `tests/swap-route-dapp-worker-parity.test.mjs` covers the byte-level binding against the worker.
export const RECEIPT_SPK = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xd7)]);
export const REFUND_SPK = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xe3)]);
function buildSwapRouteIntentMsg(args) {
  return _buildSwapRouteIntentMsg({ receiveScriptPubKey: RECEIPT_SPK, refundScriptPubKey: REFUND_SPK, ...args });
}

// Defaults the REQUIRED contextual params (opReturnData = SHA256(payload), inputCommitment = the trader's
// real input commit, both destination scripts) so a test overrides only the gate it exercises.
function validateSwapRoute(args) {
  return _validateSwapRoute({
    ...args,
    opReturnData: args.opReturnData !== undefined ? args.opReturnData : computeSwapRouteEnvelopeHash(args.payload),
    inputCommitment: args.inputCommitment !== undefined ? args.inputCommitment : C_IN_BYTES,
    receiveScriptPubKey: args.receiveScriptPubKey !== undefined ? args.receiveScriptPubKey : RECEIPT_SPK,
    refundScriptPubKey: args.refundScriptPubKey !== undefined ? args.refundScriptPubKey : REFUND_SPK,
  });
}

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}  (returned ${typeof ok === 'object' ? JSON.stringify(ok, (k, v) => typeof v === 'bigint' ? v.toString() : v) : ok})`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// ---- Pinned fixtures: 3 assets, 2 pools (A↔B, B↔C) ----
const ASSET_A = hexToBytes('aa' + '11'.repeat(31));
const ASSET_B = hexToBytes('bb' + '22'.repeat(31));
const ASSET_C = hexToBytes('cc' + '33'.repeat(31));

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

// Trader's input UTXO: a Pedersen commit to 100_000 of asset A with blinding r_in.
const TRADER_IN_AMOUNT = 100_000n;
const TRADER_IN_R = modN(BigInt('0x' + 'aa'.repeat(32)));
const C_IN = pedersenCommit(TRADER_IN_AMOUNT, TRADER_IN_R);
const C_IN_BYTES = pointToBytes(C_IN);

const R_RECEIPT = modN(BigInt('0x' + 'bb'.repeat(32)));
const R_RECEIPT_BYTES = hexToBytes(R_RECEIPT.toString(16).padStart(64, '0'));

function buildPools(overrides = {}) {
  return new Map([
    [bytesToHex(POOL_AB_ID), { ...POOL_AB, ...(overrides.ab || {}) }],
    [bytesToHex(POOL_BC_ID), { ...POOL_BC, ...(overrides.bc || {}) }],
  ]);
}

// =========================================================================
// Honest-path builders
// =========================================================================

// Declared hops as the dapp emitter builds them: each hop's magnitudes quoted against the given reserves.
function quoteHops(amountIn, ab = POOL_AB, bc = POOL_BC) {
  const h0 = curveDeltaOut({
    direction: 0, R_A_pre: ab.reserve_A, R_B_pre: ab.reserve_B, delta_in: amountIn, fee_bps: ab.fee_bps,
  });
  const h1 = curveDeltaOut({
    direction: 0, R_A_pre: bc.reserve_A, R_B_pre: bc.reserve_B, delta_in: h0.deltaOut, fee_bps: bc.fee_bps,
  });
  return {
    hops: [
      {
        poolId: POOL_AB_ID, direction: 0, feeBps: ab.fee_bps,
        R_A_pre: ab.reserve_A, R_B_pre: ab.reserve_B,
        deltaANetMag: amountIn, deltaBNetMag: h0.deltaOut,
      },
      {
        poolId: POOL_BC_ID, direction: 0, feeBps: bc.fee_bps,
        R_A_pre: bc.reserve_A, R_B_pre: bc.reserve_B,
        deltaANetMag: h0.deltaOut, deltaBNetMag: h1.deltaOut,
      },
    ],
    deltaOutLast: h1.deltaOut,
  };
}

// The validator does not read the range proof, so one proof per receipt amount is enough.
const _proofs = new Map();
function receiptRangeProof(v) {
  if (!_proofs.has(v)) _proofs.set(v, bpRangeAggProve([0n, v], [0n, R_RECEIPT]).proof);
  return _proofs.get(v);
}

// Sign + assemble an envelope over the given hops. The intent binds the route shape, hop 0's input,
// min_out, rReceipt and both destinations; the kernel binds hop 0's input to the real input note.
function signRoute({ hops, deltaOutLast, minOut = 0n, expiryHeight = 1_000_000, cInSecp = C_IN_BYTES, rIn = TRADER_IN_R }) {
  const cReceiptSecp = pointToBytes(pedersenCommit(deltaOutLast, R_RECEIPT));
  const rangeProof = receiptRangeProof(deltaOutLast);
  const intentSig = signSchnorr(buildSwapRouteIntentMsg({
    traderPubkey: TRADER_PUBKEY,
    traderInputAssetId: ASSET_A, traderOutputAssetId: ASSET_C,
    minOut, expiryHeight, hops,
    cInSecp, rReceipt: R_RECEIPT_BYTES,
  }), TRADER_PRIVKEY);
  const deltaIn0 = hops[0].direction === 0 ? hops[0].deltaANetMag : hops[0].deltaBNetMag;
  const kernelSig = signSchnorr(buildSwapRouteHop0KernelMsg({
    traderInputAssetId: ASSET_A,
    traderInputOutpointTxid: INPUT_TXID, traderInputOutpointVout: INPUT_VOUT,
    deltaIn0,
  }), hexToBytes(rIn.toString(16).padStart(64, '0')));
  return {
    traderInputAssetId: ASSET_A, traderOutputAssetId: ASSET_C,
    minOut, expiryHeight, traderPubkey: TRADER_PUBKEY,
    hops,
    traderInputOutpointTxid: INPUT_TXID, traderInputOutpointVout: INPUT_VOUT,
    cInSecp, cReceiptSecp, rReceipt: R_RECEIPT_BYTES,
    rangeProof, kernelSig, intentSig,
  };
}

function buildHonestTwoHopRoute({ amountIn = TRADER_IN_AMOUNT, minOut = 0n, expiryHeight = 1_000_000 } = {}) {
  const { hops, deltaOutLast } = quoteHops(amountIn);
  return { env: signRoute({ hops, deltaOutLast, minOut, expiryHeight }), delta_out_last: deltaOutLast };
}

const run = (env, extra = {}) => {
  const payload = encodeSwapRoute(env);
  return validateSwapRoute({ payload, pools: buildPools(), currentHeight: 100, ...extra });
};

// =========================================================================
// Section 1: Wire roundtrip
// =========================================================================
console.log('Wire roundtrip');

test('encode+decode 2-hop route roundtrip', () => {
  const { env } = buildHonestTwoHopRoute();
  const dec = decodeSwapRoute(encodeSwapRoute(env));
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
  const bad = new Uint8Array(encodeSwapRoute(buildHonestTwoHopRoute().env)); bad[0] = 0x32;
  try { decodeSwapRoute(bad); return false; } catch { return true; }
});

test('decode rejects nHops < 2', () => {
  const bad = new Uint8Array(encodeSwapRoute(buildHonestTwoHopRoute().env)); bad[1] = 1;
  try { decodeSwapRoute(bad); return false; } catch { return true; }
});

test('decode rejects nHops > N_HOPS_MAX', () => {
  const bad = new Uint8Array(encodeSwapRoute(buildHonestTwoHopRoute().env)); bad[1] = N_HOPS_MAX + 1;
  try { decodeSwapRoute(bad); return false; } catch { return true; }
});

test('decode rejects degenerate same-asset I/O', () => {
  const { env } = buildHonestTwoHopRoute();
  try { decodeSwapRoute(encodeSwapRoute({ ...env, traderOutputAssetId: ASSET_A })); return false; } catch { return true; }
});

test('encode rejects nHops out of range', () => {
  const { env } = buildHonestTwoHopRoute();
  try { encodeSwapRoute({ ...env, hops: [env.hops[0]] }); return false; } catch { return true; }
});

// =========================================================================
// Section 2: Intent msg + kernel msg constructors
// =========================================================================
console.log('\nMessage builders');

const intentArgs = (env) => ({
  traderPubkey: env.traderPubkey,
  traderInputAssetId: env.traderInputAssetId,
  traderOutputAssetId: env.traderOutputAssetId,
  minOut: env.minOut, expiryHeight: env.expiryHeight,
  hops: env.hops,
  cInSecp: env.cInSecp, rReceipt: env.rReceipt,
});

test('intent_msg is a 32-byte digest', () => {
  return buildSwapRouteIntentMsg(intentArgs(buildHonestTwoHopRoute().env)).length === 32;
});

test('intent_msg requires refundScriptPubKey', () => {
  try {
    _buildSwapRouteIntentMsg({ ...intentArgs(buildHonestTwoHopRoute().env), receiveScriptPubKey: RECEIPT_SPK });
    return false;
  } catch (e) { return /refundScriptPubKey/.test(e.message); }
});

test('intent_msg binds each hop\'s pool and direction', () => {
  const args0 = intentArgs(buildHonestTwoHopRoute().env);
  const m0 = buildSwapRouteIntentMsg(args0);
  const mPool = buildSwapRouteIntentMsg({ ...args0, hops: args0.hops.map((h, i) => i === 1 ? { ...h, poolId: POOL_AB_ID } : h) });
  const mDir = buildSwapRouteIntentMsg({ ...args0, hops: args0.hops.map((h, i) => i === 1 ? { ...h, direction: 1 } : h) });
  return !bytesEq(m0, mPool) && !bytesEq(m0, mDir);
});

test('intent_msg binds hop 0\'s input amount', () => {
  const args0 = intentArgs(buildHonestTwoHopRoute().env);
  const m1 = buildSwapRouteIntentMsg({ ...args0, hops: args0.hops.map((h, i) => i === 0 ? { ...h, deltaANetMag: h.deltaANetMag + 1n } : h) });
  return !bytesEq(buildSwapRouteIntentMsg(args0), m1);
});

test('intent_msg does NOT bind fee tiers, pre-reserves or output magnitudes', () => {
  const args0 = intentArgs(buildHonestTwoHopRoute().env);
  const moved = args0.hops.map((h) => ({
    ...h, feeBps: 0, R_A_pre: h.R_A_pre + 7n, R_B_pre: h.R_B_pre - 7n, deltaBNetMag: h.deltaBNetMag + 1n,
  }));
  moved[1] = { ...moved[1], deltaANetMag: moved[1].deltaANetMag + 3n };
  return bytesEq(buildSwapRouteIntentMsg(args0), buildSwapRouteIntentMsg({ ...args0, hops: moved }));
});

test('intent_msg binds both destinations', () => {
  const args0 = intentArgs(buildHonestTwoHopRoute().env);
  const other = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x99)]);
  const m0 = buildSwapRouteIntentMsg(args0);
  return !bytesEq(m0, buildSwapRouteIntentMsg({ ...args0, receiveScriptPubKey: other }))
    && !bytesEq(m0, buildSwapRouteIntentMsg({ ...args0, refundScriptPubKey: other }));
});

test('hop-0 kernel msg binds the input outpoint and amount', () => {
  const base = { traderInputAssetId: ASSET_A, traderInputOutpointTxid: INPUT_TXID, traderInputOutpointVout: 0, deltaIn0: 5n };
  const m0 = buildSwapRouteHop0KernelMsg(base);
  return !bytesEq(m0, buildSwapRouteHop0KernelMsg({ ...base, traderInputOutpointVout: 1 }))
    && !bytesEq(m0, buildSwapRouteHop0KernelMsg({ ...base, deltaIn0: 6n }))
    && !bytesEq(m0, buildSwapRouteHop0KernelMsg({ ...base, traderInputAssetId: ASSET_B }));
});

test('net-flow kernel_msg binds hopsHash', () => {
  const { env } = buildHonestTwoHopRoute();
  const mk = (hops) => buildSwapRouteKernelMsg({
    traderInputAssetId: env.traderInputAssetId,
    traderOutputAssetId: env.traderOutputAssetId,
    traderInputOutpointTxid: env.traderInputOutpointTxid,
    traderInputOutpointVout: env.traderInputOutpointVout,
    deltaIn0: env.hops[0].deltaANetMag,
    deltaOutLast: env.hops[1].deltaBNetMag,
    cReceiptSecp: env.cReceiptSecp,
    hopsHash: hashHops(hops),
  });
  return !bytesEq(mk(env.hops), mk(env.hops.map((h, i) => i === 1 ? { ...h, deltaBNetMag: h.deltaBNetMag - 1n } : h)));
});

// =========================================================================
// Section 3: Honest validation
// =========================================================================
console.log('\nHonest validation');

test('honest 2-hop A→B→C executes with the receipt formed from the cleared amount', () => {
  const { env, delta_out_last } = buildHonestTwoHopRoute();
  const res = run(env);
  if (!res.valid) console.log(`     reason: ${res.reason}`);
  return res.valid === true && res.outcome === 'receipt'
    && res.receipt.amount === delta_out_last
    && bytesEq(res.receipt.asset_id, ASSET_C)
    && bytesEq(res.receipt.commitment, pointToBytes(pedersenCommit(delta_out_last, R_RECEIPT)));
});

test('getAmountOut matches the emitter quote (curveDeltaOut)', () => {
  const q = curveDeltaOut({ direction: 0, R_A_pre: 10_000_000n, R_B_pre: 5_000_000n, delta_in: 12_345n, fee_bps: 30 });
  return getAmountOut(12_345n, 10_000_000n, 5_000_000n, 30) === q.deltaOut;
});

test('honest 2-hop state transitions apply per pool', () => {
  const { env } = buildHonestTwoHopRoute();
  const res = run(env);
  const newAB = res.newPoolStates.get(bytesToHex(POOL_AB_ID));
  const newBC = res.newPoolStates.get(bytesToHex(POOL_BC_ID));
  return newAB.reserve_A === POOL_AB.reserve_A + env.hops[0].deltaANetMag
      && newAB.reserve_B === POOL_AB.reserve_B - env.hops[0].deltaBNetMag
      && newBC.reserve_A === POOL_BC.reserve_A + env.hops[1].deltaANetMag
      && newBC.reserve_B === POOL_BC.reserve_B - env.hops[1].deltaBNetMag;
});

test('a pool that moved after signing re-clears at its current reserves', () => {
  const { env } = buildHonestTwoHopRoute();
  const movedAB = { reserve_A: POOL_AB.reserve_A + 500_000n, reserve_B: POOL_AB.reserve_B - 200_000n };
  const res = validateSwapRoute({ payload: encodeSwapRoute(env), pools: buildPools({ ab: movedAB }), currentHeight: 100 });
  const expect = quoteHops(TRADER_IN_AMOUNT, { ...POOL_AB, ...movedAB }).deltaOutLast;
  return res.valid === true && res.outcome === 'receipt' && res.receipt.amount === expect
    && expect !== env.hops[1].deltaBNetMag;
});

test('declared hop fee tier is ignored; the registry fee tier clears', () => {
  const { hops, deltaOutLast } = quoteHops(TRADER_IN_AMOUNT);
  const env = signRoute({ hops: hops.map((h) => ({ ...h, feeBps: 0 })), deltaOutLast });
  const res = run(env);
  return res.valid === true && res.receipt.amount === deltaOutLast;
});

test('declared later-hop and output magnitudes are ignored', () => {
  const { hops, deltaOutLast } = quoteHops(TRADER_IN_AMOUNT);
  const inflated = hops.map((h, i) => i === 0 ? { ...h, deltaBNetMag: h.deltaBNetMag * 2n }
    : { ...h, deltaANetMag: h.deltaANetMag * 2n, deltaBNetMag: h.deltaBNetMag * 2n });
  const res = run(signRoute({ hops: inflated, deltaOutLast }));
  return res.valid === true && res.receipt.amount === deltaOutLast;
});

test('envelope cReceiptSecp takes no part (receipt is formed by the validator)', () => {
  const { env, delta_out_last } = buildHonestTwoHopRoute();
  const alt = pointToBytes(pedersenCommit(1n, modN(BigInt('0x' + 'cc'.repeat(32)))));
  const res = run({ ...env, cReceiptSecp: alt });
  return res.valid === true
    && bytesEq(res.receipt.commitment, pointToBytes(pedersenCommit(delta_out_last, R_RECEIPT)));
});

test('an oversized input never drains a pool (output strictly below the reserve)', () => {
  const tiny = { reserve_A: 100n, reserve_B: 100n };
  const bigIn = 10_000_000n;
  const { hops, deltaOutLast } = quoteHops(bigIn, { ...POOL_AB, ...tiny });
  const res = validateSwapRoute({
    payload: encodeSwapRoute(signRoute({ hops, deltaOutLast, cInSecp: pointToBytes(pedersenCommit(bigIn, TRADER_IN_R)) })),
    pools: buildPools({ ab: tiny }), currentHeight: 100,
    inputCommitment: pointToBytes(pedersenCommit(bigIn, TRADER_IN_R)),
  });
  const ab = res.newPoolStates?.get(bytesToHex(POOL_AB_ID));
  return res.valid === true && res.outcome === 'receipt' && ab.reserve_B > 0n;
});

// =========================================================================
// Section 4: Refund branch
// =========================================================================
console.log('\nRefund branch');

const isRefund = (res) => res.valid === true && res.outcome === 'refund'
  && res.newPoolStates.size === 0
  && bytesEq(res.refund.asset_id, ASSET_A)
  && bytesEq(res.refund.commitment, C_IN_BYTES);

test('expired route refunds the exact input', () => {
  const { env } = buildHonestTwoHopRoute({ expiryHeight: 100 });
  const res = run(env, { currentHeight: 200 });
  return isRefund(res) && /expired/.test(res.reason);
});

test('expiry_height 0 refunds', () => {
  return isRefund(run(buildHonestTwoHopRoute({ expiryHeight: 0 }).env));
});

test('min_out above the cleared amount refunds and moves no pool', () => {
  const { delta_out_last } = buildHonestTwoHopRoute();
  const res = run(buildHonestTwoHopRoute({ minOut: delta_out_last + 1n }).env);
  return isRefund(res) && /min_out/.test(res.reason);
});

test('a pool moving against the trader past min_out refunds', () => {
  const { delta_out_last } = buildHonestTwoHopRoute();
  const { env } = buildHonestTwoHopRoute({ minOut: delta_out_last });
  const res = validateSwapRoute({
    payload: encodeSwapRoute(env), currentHeight: 100,
    pools: buildPools({ ab: { reserve_A: POOL_AB.reserve_A * 2n } }),
  });
  return isRefund(res);
});

test('a hop that clears to nothing refunds', () => {
  const amountIn = 1n;
  const cIn = pointToBytes(pedersenCommit(amountIn, TRADER_IN_R));
  const hops = quoteHops(TRADER_IN_AMOUNT).hops.map((h, i) => i === 0 ? { ...h, deltaANetMag: amountIn } : h);
  const res = validateSwapRoute({
    payload: encodeSwapRoute(signRoute({ hops, deltaOutLast: 1n, cInSecp: cIn })),
    pools: buildPools(), currentHeight: 100, inputCommitment: cIn,
  });
  return res.valid === true && res.outcome === 'refund' && /nothing/.test(res.reason);
});

// =========================================================================
// Section 5: Rejections
// =========================================================================
console.log('\nRejections');

test('unregistered pool_id rejected', () => {
  const { env } = buildHonestTwoHopRoute();
  const res = validateSwapRoute({
    payload: encodeSwapRoute(env), currentHeight: 100,
    pools: new Map([[bytesToHex(POOL_AB_ID), POOL_AB]]),
  });
  return res.valid === false && /not registered/.test(res.reason);
});

test('pool repeated within one route rejected', () => {
  const { hops, deltaOutLast } = quoteHops(TRADER_IN_AMOUNT);
  const res = run(signRoute({ hops: [hops[0], { ...hops[0], direction: 1 }], deltaOutLast }));
  return res.valid === false && /repeated/.test(res.reason);
});

test('broken asset chain rejected (hop[1].asset_in != hop[0].asset_out)', () => {
  const { hops, deltaOutLast } = quoteHops(TRADER_IN_AMOUNT);
  const res = run(signRoute({ hops: hops.map((h, i) => i === 1 ? { ...h, direction: 1 } : h), deltaOutLast }));
  return res.valid === false && /asset_in mismatch/.test(res.reason);
});

test('tampered intent_sig rejected', () => {
  const res = run({ ...buildHonestTwoHopRoute().env, intentSig: new Uint8Array(64) });
  return res.valid === false && /intent_sig/.test(res.reason);
});

test('tampered kernel_sig rejected', () => {
  const res = run({ ...buildHonestTwoHopRoute().env, kernelSig: new Uint8Array(64) });
  return res.valid === false && /kernel_sig/.test(res.reason);
});

test('hop-0 input larger than the input note fails the kernel', () => {
  // The intent is re-signed over the larger amount; the kernel key C_in − delta_in_0·H then has no known
  // discrete log for the trader's blinding, so the hop-0 kernel cannot verify.
  const { hops } = quoteHops(TRADER_IN_AMOUNT + 1n);
  const res = run(signRoute({ hops, deltaOutLast: 1n }));
  return res.valid === false && /kernel_sig/.test(res.reason);
});

test('rReceipt swapped after signing rejected (rReceipt is bound)', () => {
  const res = run({ ...buildHonestTwoHopRoute().env, rReceipt: new Uint8Array(32).fill(0x01) });
  return res.valid === false && /intent_sig/.test(res.reason);
});

// =========================================================================
// Section 6: OP_RETURN, destination and input-commit bindings
// =========================================================================
console.log('\nOP_RETURN + destination + input-commit gates');

test('missing opReturnData throws', () => {
  const payload = encodeSwapRoute(buildHonestTwoHopRoute().env);
  try {
    _validateSwapRoute({
      payload, pools: buildPools(), currentHeight: 100,
      inputCommitment: C_IN_BYTES, receiveScriptPubKey: RECEIPT_SPK, refundScriptPubKey: REFUND_SPK,
    });
    return false;
  } catch (e) { return /opReturnData is required/.test(e.message); }
});

test('missing refundScriptPubKey throws', () => {
  const payload = encodeSwapRoute(buildHonestTwoHopRoute().env);
  try {
    _validateSwapRoute({
      payload, pools: buildPools(), currentHeight: 100,
      opReturnData: computeSwapRouteEnvelopeHash(payload),
      inputCommitment: C_IN_BYTES, receiveScriptPubKey: RECEIPT_SPK,
    });
    return false;
  } catch (e) { return /refundScriptPubKey is required/.test(e.message); }
});

test('opReturnData wrong length rejected', () => {
  const res = run(buildHonestTwoHopRoute().env, { opReturnData: new Uint8Array(31) });
  return res.valid === false && /32-byte Uint8Array/.test(res.reason);
});

test('redirected receipt rejected (destination binding)', () => {
  const elsewhere = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x99)]);
  const res = run(buildHonestTwoHopRoute().env, { receiveScriptPubKey: elsewhere });
  return res.valid === false && /intent_sig/.test(res.reason);
});

test('redirected refund rejected (destination binding)', () => {
  const elsewhere = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x99)]);
  const res = run(buildHonestTwoHopRoute().env, { refundScriptPubKey: elsewhere });
  return res.valid === false && /intent_sig/.test(res.reason);
});

test('opReturnData mismatch rejected', () => {
  const res = run(buildHonestTwoHopRoute().env, { opReturnData: new Uint8Array(32).fill(0xab) });
  return res.valid === false && /OP_RETURN data != SHA256/.test(res.reason);
});

test('opReturnData honest match passes through', () => {
  const payload = encodeSwapRoute(buildHonestTwoHopRoute().env);
  const res = _validateSwapRoute({
    payload, pools: buildPools(), currentHeight: 100,
    opReturnData: computeSwapRouteEnvelopeHash(payload),
    inputCommitment: C_IN_BYTES, receiveScriptPubKey: RECEIPT_SPK, refundScriptPubKey: REFUND_SPK,
  });
  return res.valid === true;
});

test('missing inputCommitment throws', () => {
  const payload = encodeSwapRoute(buildHonestTwoHopRoute().env);
  try {
    _validateSwapRoute({
      payload, pools: buildPools(), currentHeight: 100,
      opReturnData: computeSwapRouteEnvelopeHash(payload),
      receiveScriptPubKey: RECEIPT_SPK, refundScriptPubKey: REFUND_SPK,
    });
    return false;
  } catch (e) { return /inputCommitment is required/.test(e.message); }
});

test('inputCommitment wrong length rejected', () => {
  const res = run(buildHonestTwoHopRoute().env, { inputCommitment: new Uint8Array(32) });
  return res.valid === false && /33-byte compressed point/.test(res.reason);
});

test('inputCommitment wrong type rejected', () => {
  const res = run(buildHonestTwoHopRoute().env, { inputCommitment: 'aa'.repeat(33) });
  return res.valid === false && /ProjectivePoint or Uint8Array/.test(res.reason);
});

test('cInSecp that differs from the on-chain input commit rejected', () => {
  // A route signed over a commitment to the same amount under r_in = 1 instead of the note's real
  // blinding: every signature verifies, but cInSecp is not the confirmed input's commitment.
  const fakeR = 1n;
  const fakeCIn = pointToBytes(pedersenCommit(TRADER_IN_AMOUNT, fakeR));
  const { hops, deltaOutLast } = quoteHops(TRADER_IN_AMOUNT);
  const res = run(signRoute({ hops, deltaOutLast, cInSecp: fakeCIn, rIn: fakeR }));
  return res.valid === false && /cInSecp does not match on-chain input UTXO/.test(res.reason);
});

test('inputCommitment accepted as ProjectivePoint (parity with bytes form)', () => {
  return run(buildHonestTwoHopRoute().env, { inputCommitment: C_IN }).valid === true;
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${pass}/${pass + fail} passed`);
// Exit on the computed verdict: imported browser modules can leave the event loop alive.
process.exit(fail > 0 ? 1 : 0);

// ---- helpers ----
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
