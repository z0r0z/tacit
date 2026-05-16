// Test suite for T_SWAP_VAR (opcode 0x32) reference impl.
//
// Covers the unit-testable subset of SPEC-SWAP-VAR-AMENDMENT.md
// §"Test plan" (items 1–16) plus the critical inflation defense
// surfaced in the same-day P0 crypto fix.
//
// Items requiring signet (reorg, real wallet recovery, multi-block
// running-state, cross-impl parity vs the worker code path) are
// out of scope here; they're noted inline and belong in
// `axintent-onchain-e2e-signet.mjs`-shape integration tests.
//
// Run: `node swap-var.test.mjs`.

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

import {
  G, H, SECP_N, modN, pedersenCommit, pointToBytes,
  bpRangeAggProve, bpRangeAggVerify, randomScalar,
} from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';
import {
  OPCODE_T_SWAP_VAR, ENVELOPE_VERSION, NO_CHANGE_SENTINEL,
  encodeSwapVar, decodeSwapVar, computeSwapVarEnvelopeHash,
  buildSwapVarIntentMsg, buildSwapVarKernelMsg, kernelVerifyPoint,
  deriveSwapVarReceiptScalar, deriveSwapVarChangeScalar,
  deriveSwapVarReceiptPubkey, deriveSwapVarTipScalar,
  curveDeltaOut, buildTickFan,
  validateSwapVar,
} from './swap-var.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label} (returned ${typeof ok === 'object' ? JSON.stringify(ok) : ok})`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// ---- Pinned canonical inputs ----
const ASSET_A = hexToBytes('aa' + '11'.repeat(31));
const ASSET_B = hexToBytes('bb' + '22'.repeat(31));
// pool_id = SHA256("tacit-amm-pool-v1" || A || B || fee_bps_LE || capability_flags)
// per AMM.md §"Pool state" (V3/V4 fee-tier parity). This fixture uses
// fee_bps=30, capability_flags=0.
const POOL_FEE_BPS = 30;
const POOL_CAPABILITY_FLAGS = 0;
const POOL_FEE_BPS_LE = (() => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, POOL_FEE_BPS, true); return b; })();
const POOL_ID = sha256(concatBytes(
  new TextEncoder().encode('tacit-amm-pool-v1'),
  ASSET_A, ASSET_B,
  POOL_FEE_BPS_LE,
  new Uint8Array([POOL_CAPABILITY_FLAGS]),
));
const TRADER_PRIVKEY = hexToBytes('11'.repeat(32));
const TRADER_PUBKEY = secp.getPublicKey(TRADER_PRIVKEY, true);
const SETTLER_PRIVKEY = hexToBytes('22'.repeat(32));
const INPUT_TXID = 'de'.repeat(32);
const INPUT_VOUT = 0;
const ASSET_INPUT_OUTPOINT = (() => {
  const txid_BE = new Uint8Array(hexToBytes(INPUT_TXID)).reverse();
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, INPUT_VOUT, true);
  return concatBytes(txid_BE, voutLE);
})();
const POOL = {
  pool_id: POOL_ID, asset_A: ASSET_A, asset_B: ASSET_B,
  reserve_A: 50_000_000n, reserve_B: 525_000n, fee_bps: 30,
};

// A canonical scriptPubKey (just bytes — not actually decoded).
const RECEIVE_SCRIPT = new Uint8Array([0x00, 0x14, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56]);

// ============================================================
// Section 1: Curve math + derivations + tick-fan
// ============================================================

console.log('Curve recompute');

test('A→B curve: simple case, fee=0', () => {
  const out = curveDeltaOut({ direction: 0, R_A_pre: 1000n, R_B_pre: 1000n, delta_in: 100n, fee_bps: 0 });
  // Formula: floor(R_B · γ_num · Δ / (R_A · γ_den + γ_num · Δ))
  // = floor(1000 · 10000 · 100 / (1000 · 10000 + 10000 · 100))
  // = floor(1_000_000_000 / 11_000_000) = floor(90.909…) = 90.
  // R_A_post = 1100; R_B_post = 1000 − 90 = 910.
  return out.deltaOut === 90n && out.raPost === 1100n && out.rbPost === 910n;
});

test('B→A curve: symmetric to A→B', () => {
  const fwd = curveDeltaOut({ direction: 0, R_A_pre: 1000n, R_B_pre: 2000n, delta_in: 100n, fee_bps: 30 });
  const rev = curveDeltaOut({ direction: 1, R_A_pre: 2000n, R_B_pre: 1000n, delta_in: 100n, fee_bps: 30 });
  return fwd.deltaOut === rev.deltaOut;
});

test('curve rejects R=0 reserve', () => {
  try { curveDeltaOut({ direction: 0, R_A_pre: 0n, R_B_pre: 1n, delta_in: 1n, fee_bps: 0 }); return false; }
  catch { return true; }
});

test('curve rejects Δ=0', () => {
  try { curveDeltaOut({ direction: 0, R_A_pre: 100n, R_B_pre: 100n, delta_in: 0n, fee_bps: 0 }); return false; }
  catch { return true; }
});

test('curve rejects fee_bps > 1000', () => {
  try { curveDeltaOut({ direction: 0, R_A_pre: 100n, R_B_pre: 100n, delta_in: 1n, fee_bps: 1001 }); return false; }
  catch { return true; }
});

console.log('\nHMAC derivations');

test('r_receipt is deterministic across calls', () => {
  const a = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const b = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  return a === b && a > 0n && a < SECP_N;
});

test('r_receipt depends on pool_id (domain separation)', () => {
  const a = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const otherPool = sha256(new TextEncoder().encode('different-pool'));
  const b = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: otherPool, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  return a !== b;
});

test('r_receipt depends on input outpoint', () => {
  const a = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const other = new Uint8Array(36); other[0] = 1;
  const b = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: other });
  return a !== b;
});

test('r_receipt and r_change use different domains (distinct scalars)', () => {
  const r = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const c = deriveSwapVarChangeScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  return r !== c;
});

test('r_tip is settler-keyed (not derivable by trader)', () => {
  const traderSide = deriveSwapVarTipScalar({ settlerPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const settlerSide = deriveSwapVarTipScalar({ settlerPrivkey: SETTLER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  return traderSide !== settlerSide;
});

test('receipt pubkey is recoverable from privkey alone (item 10)', () => {
  const a = deriveSwapVarReceiptPubkey({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const b = deriveSwapVarReceiptPubkey({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  return bytesToHex(a.pubkey) === bytesToHex(b.pubkey) && a.pubkey.length === 33;
});

console.log('\nTick-fan schedule (item: AMENDMENTS.md tick-fan)');

test('K=1 collapses to single-Δ (self-broadcast)', () => {
  const ticks = buildTickFan({ deltaInMin: 100n, deltaInMax: 1000n, K: 1 });
  return ticks.length === 1 && ticks[0] === 100n;
});

test('K=8 ticks are monotonic ascending and bracket [Δmin, Δmax]', () => {
  const ticks = buildTickFan({ deltaInMin: 1000n, deltaInMax: 1_000_000n, K: 8 });
  if (ticks.length !== 8) return false;
  if (ticks[0] !== 1000n || ticks[7] !== 1_000_000n) return false;
  for (let k = 1; k < 8; k++) if (ticks[k] <= ticks[k - 1]) return false;
  return true;
});

test('K=4 ticks log-space (geometric ratio ≈ constant)', () => {
  const ticks = buildTickFan({ deltaInMin: 100n, deltaInMax: 100_000n, K: 4 });
  // log-spaced over 3 orders of magnitude in 4 ticks → ratio ≈ 10× per step.
  const ratios = [];
  for (let k = 1; k < 4; k++) ratios.push(Number(ticks[k]) / Number(ticks[k - 1]));
  // Each ratio should be within 30% of 10 (allowing for integer-floor drift).
  for (const r of ratios) if (r < 7 || r > 13) return false;
  return true;
});

test('K rejects unsupported values', () => {
  try { buildTickFan({ deltaInMin: 1n, deltaInMax: 10n, K: 3 }); return false; }
  catch { return true; }
});

// ============================================================
// Section 2: Wire format round-trip
// ============================================================

console.log('\nWire format');

// Build a complete (valid-shape) envelope to round-trip. We don't care
// whether sigs verify here — just byte parity.
function buildDummyEnv() {
  const cInSecp = pointToBytes(pedersenCommit(10_000n, 7n));
  const cChange = pointToBytes(pedersenCommit(5_000n, 11n));
  const cReceipt = pointToBytes(pedersenCommit(525n, 13n));
  return {
    poolId: POOL_ID, direction: 0,
    R_A_pre: 50_000_000n, R_B_pre: 525_000n,
    deltaIn: 5000n, deltaInMin: 1000n, deltaInMax: 10000n, deltaOut: 52n,
    minOut: 50n, tipAmount: 0n, tipAsset: 0,
    expiryHeight: 1_000_000,
    traderPubkey: TRADER_PUBKEY,
    cInSecp, cChangeOrSentinel: cChange, cReceiptSecp: cReceipt,
    rReceipt: new Uint8Array(32),       // dummy r_receipt
    rangeProof: new Uint8Array([0xab, 0xcd]), // dummy 2-byte payload
    kernelSig: new Uint8Array(64),
    intentSig: new Uint8Array(64),
  };
}

test('encode → decode round-trip preserves every field', () => {
  const env = buildDummyEnv();
  const bytes = encodeSwapVar(env);
  const decoded = decodeSwapVar(bytes);
  return decoded.opcode === OPCODE_T_SWAP_VAR
      && decoded.version === ENVELOPE_VERSION
      && bytesToHex(decoded.poolId) === bytesToHex(env.poolId)
      && decoded.direction === env.direction
      && decoded.R_A_pre === env.R_A_pre
      && decoded.deltaIn === env.deltaIn
      && decoded.deltaOut === env.deltaOut
      && decoded.minOut === env.minOut
      && decoded.tipAmount === env.tipAmount
      && bytesToHex(decoded.traderPubkey) === bytesToHex(env.traderPubkey)
      && bytesToHex(decoded.cInSecp) === bytesToHex(env.cInSecp)
      && bytesToHex(decoded.rReceipt) === bytesToHex(env.rReceipt)
      && bytesToHex(decoded.kernelSig) === bytesToHex(env.kernelSig);
});

test('decode rejects truncated payload', () => {
  const env = buildDummyEnv();
  const bytes = encodeSwapVar(env);
  try { decodeSwapVar(bytes.subarray(0, bytes.length - 5)); return false; }
  catch { return true; }
});

test('decode rejects wrong opcode byte', () => {
  const env = buildDummyEnv();
  const bytes = encodeSwapVar(env);
  bytes[1] = 0x2F; // claim T_SWAP_BATCH instead
  try { decodeSwapVar(bytes); return false; }
  catch { return true; }
});

test('decode rejects wrong version byte', () => {
  const env = buildDummyEnv();
  const bytes = encodeSwapVar(env);
  bytes[0] = 0x02;
  try { decodeSwapVar(bytes); return false; }
  catch { return true; }
});

// ============================================================
// Section 3: Kernel-msg byte parity (item 13)
// ============================================================

console.log('\nKernel-msg construction');

test('kernel_msg is deterministic for the same inputs', () => {
  const a = buildSwapVarKernelMsg({
    assetIdIn: ASSET_A, assetInputOutpointTxid: INPUT_TXID, assetInputOutpointVout: INPUT_VOUT,
    cChangeOrSentinel: new Uint8Array(33).fill(0xab), deltaInTotal: 5050n,
  });
  const b = buildSwapVarKernelMsg({
    assetIdIn: ASSET_A, assetInputOutpointTxid: INPUT_TXID, assetInputOutpointVout: INPUT_VOUT,
    cChangeOrSentinel: new Uint8Array(33).fill(0xab), deltaInTotal: 5050n,
  });
  return bytesToHex(a) === bytesToHex(b);
});

test('kernel_msg differs when delta_in_total changes (sandwich-relevant)', () => {
  const a = buildSwapVarKernelMsg({
    assetIdIn: ASSET_A, assetInputOutpointTxid: INPUT_TXID, assetInputOutpointVout: INPUT_VOUT,
    cChangeOrSentinel: new Uint8Array(33).fill(0xab), deltaInTotal: 5050n,
  });
  const b = buildSwapVarKernelMsg({
    assetIdIn: ASSET_A, assetInputOutpointTxid: INPUT_TXID, assetInputOutpointVout: INPUT_VOUT,
    cChangeOrSentinel: new Uint8Array(33).fill(0xab), deltaInTotal: 5051n,
  });
  return bytesToHex(a) !== bytesToHex(b);
});

test('kernel_verify_point: change-case math closes for (excess · G)', () => {
  // Construct everything ourselves.
  const r_in = 7n;
  const r_change = 13n;
  const excess = modN(r_change - r_in);
  const amount_in = 10_000n;
  const delta_in_total = 5_050n; // delta_in + tip
  const amount_change = amount_in - delta_in_total;
  const C_in = pedersenCommit(amount_in, r_in);
  const C_change = pedersenCommit(amount_change, r_change);
  const P = kernelVerifyPoint({
    cChangeOrSentinel: pointToBytes(C_change),
    cInSecp: pointToBytes(C_in),
    deltaInTotal: delta_in_total,
  });
  const expected = G.multiply(excess);
  return P.equals(expected);
});

test('kernel_verify_point: no-change-sentinel math closes for (−r_in · G)', () => {
  const r_in = 99n;
  const amount_in = 5_050n;
  const delta_in_total = 5_050n; // input fully consumed
  const excess = modN(0n - r_in);
  const C_in = pedersenCommit(amount_in, r_in);
  const P = kernelVerifyPoint({
    cChangeOrSentinel: NO_CHANGE_SENTINEL,
    cInSecp: pointToBytes(C_in),
    deltaInTotal: delta_in_total,
  });
  const expected = G.multiply(excess);
  return P.equals(expected);
});

// ============================================================
// Section 4: End-to-end validator — happy path
// ============================================================
//
// Build a real, signed, bulletproof'd envelope and verify it accepts.

console.log('\nValidator end-to-end');

function makeRealEnv({ deltaIn = 5000n, mutate = null, fee_bps = 30, R_A_pre = 50_000_000n, R_B_pre = 525_000n, tip = 0n } = {}) {
  const dir = 0;
  const amountIn = 10_000n;
  const r_in = 7n;
  const r_change = deriveSwapVarChangeScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const r_receipt = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });

  const C_in = pedersenCommit(amountIn, r_in);
  const curve = curveDeltaOut({ direction: dir, R_A_pre, R_B_pre, delta_in: deltaIn, fee_bps });
  const deltaOut = curve.deltaOut;

  const delta_in_total = deltaIn + tip;
  const amount_change = amountIn - delta_in_total;
  if (amount_change < 0n) throw new Error('input amount insufficient for delta_in + tip');

  let cChange;
  let cChangeBytes;
  if (amount_change === 0n) {
    cChangeBytes = NO_CHANGE_SENTINEL;
    cChange = null; // will be substituted to ZERO by validator + verifier point
  } else {
    cChange = pedersenCommit(amount_change, r_change);
    cChangeBytes = pointToBytes(cChange);
  }

  const C_receipt = pedersenCommit(deltaOut, r_receipt);
  const cReceiptBytes = pointToBytes(C_receipt);
  const rReceiptBytes = (() => {
    const out = new Uint8Array(32);
    let x = r_receipt;
    for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  })();

  // Bulletproof m=2 over (C_change_or_sentinel, C_receipt).
  // For no-change case, supply (value=0, blinding=0) for slot 0 — that
  // commits to ZERO, which equals the additive identity, matching the
  // sentinel-substituted verifier slot.
  const bpValues = amount_change === 0n ? [0n, deltaOut] : [amount_change, deltaOut];
  const bpBlindings = amount_change === 0n ? [0n, r_receipt] : [r_change, r_receipt];
  const { proof: bpProof, V_pts } = bpRangeAggProve(bpValues, bpBlindings, 64);

  // intent_msg + intent_sig.
  const intentMsg = buildSwapVarIntentMsg({
    poolId: POOL_ID, direction: dir,
    deltaIn, deltaInMin: 1000n, deltaInMax: 10000n, deltaOut,
    minOut: deltaOut, tipAmount: tip, tipAsset: 0,
    expiryHeight: 1_000_000, traderPubkey: TRADER_PUBKEY,
    assetInputOutpoint: ASSET_INPUT_OUTPOINT,
    receiveScriptPubKey: RECEIVE_SCRIPT,
    cReceiptSecp: cReceiptBytes,
    cChangeOrSentinel: cChangeBytes,
  });
  const intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);

  // kernel_msg + kernel_sig.
  // Signing key is `excess` for change case, `-r_in mod n` for no-change.
  const excess = amount_change === 0n ? modN(0n - r_in) : modN(r_change - r_in);
  const kernelMsg = buildSwapVarKernelMsg({
    assetIdIn: ASSET_A,
    assetInputOutpointTxid: INPUT_TXID,
    assetInputOutpointVout: INPUT_VOUT,
    cChangeOrSentinel: cChangeBytes,
    deltaInTotal: delta_in_total,
  });
  // BIP-340 needs the privkey-as-bytes form (32B big-endian).
  const excessBytes = (() => {
    const out = new Uint8Array(32);
    let x = excess;
    for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  })();
  const kernelSig = signSchnorr(kernelMsg, excessBytes);

  let envObj = {
    poolId: POOL_ID, direction: dir, R_A_pre, R_B_pre,
    deltaIn, deltaInMin: 1000n, deltaInMax: 10000n, deltaOut,
    minOut: deltaOut, tipAmount: tip, tipAsset: 0,
    expiryHeight: 1_000_000, traderPubkey: TRADER_PUBKEY,
    cInSecp: pointToBytes(C_in),
    cChangeOrSentinel: cChangeBytes,
    cReceiptSecp: cReceiptBytes,
    rReceipt: rReceiptBytes,
    rangeProof: bpProof,
    kernelSig, intentSig,
  };
  if (mutate) envObj = mutate(envObj);
  return envObj;
}

function runValidate(env, { currentHeight = 100, R_A_pre, R_B_pre, fee_bps = 30, inputCommitment } = {}) {
  const pool = {
    pool_id: POOL_ID, asset_A: ASSET_A, asset_B: ASSET_B,
    reserve_A: R_A_pre !== undefined ? R_A_pre : 50_000_000n,
    reserve_B: R_B_pre !== undefined ? R_B_pre : 525_000n,
    fee_bps,
  };
  const payload = encodeSwapVar(env);
  const opReturnData = computeSwapVarEnvelopeHash(payload);
  // Test harness: trader's envelope-claimed cInSecp IS the on-chain truth
  // by construction. Production callers extract the actual on-chain commit.
  // Adversarial tests can override via the `inputCommitment` opt.
  return validateSwapVar({
    payload, pool, opReturnData,
    assetInputOutpointTxid: INPUT_TXID,
    assetInputOutpointVout: INPUT_VOUT,
    currentHeight,
    receiveScriptPubKey: RECEIVE_SCRIPT,
    bulletproofVerify: (V_pts, proofBytes) => bpRangeAggVerify(V_pts, proofBytes, 64),
    inputCommitment: inputCommitment !== undefined ? inputCommitment : env.cInSecp,
  });
}

test('happy path: validator accepts honest envelope', () => {
  const env = makeRealEnv();
  const r = runValidate(env);
  if (r.valid !== true) return `reject reason: ${r.reason}`;
  if (r.newPoolState.reserve_A !== 50_005_000n) return `wrong post-A: ${r.newPoolState.reserve_A}`;
  return true;
});

test('happy path: post-reserve advances correctly (A→B)', () => {
  const env = makeRealEnv({ deltaIn: 5000n });
  const r = runValidate(env);
  // 50M + 5k = 50_005_000; pre-fee curve: 525000 * 9970 * 5000 / (50_000_000 * 10000 + 9970 * 5000)
  // = 525000 * 49_850_000 / (500_000_000_000 + 49_850_000)
  // = 26_171_250_000_000 / 500_049_850_000
  // = 52.336… → 52
  return r.valid === true
      && r.newPoolState.reserve_A === 50_005_000n
      && r.newPoolState.reserve_B === 525_000n - 52n;
});

test('item 5: 3 successive A→B fills walk reserves + k monotonically increases', () => {
  // The pool starts at (50M, 525k). Each swap moves reserves; we
  // explicitly thread the post state into the next pre state.
  // Verify that R_A · R_B (= k) STRICTLY grows across all 3 fills
  // (constant-product with fee → k grows by fee accrual every fill).
  const pool = { pool_id: POOL_ID, asset_A: ASSET_A, asset_B: ASSET_B,
                 reserve_A: 50_000_000n, reserve_B: 525_000n, fee_bps: 30 };
  const kFloors = [pool.reserve_A * pool.reserve_B];
  for (let i = 0; i < 3; i++) {
    const env = makeRealEnv({
      deltaIn: 5000n,
      R_A_pre: pool.reserve_A,
      R_B_pre: pool.reserve_B,
    });
    const payload = encodeSwapVar(env);
    const r = validateSwapVar({
      payload, pool, opReturnData: computeSwapVarEnvelopeHash(payload),
      assetInputOutpointTxid: INPUT_TXID,
      assetInputOutpointVout: INPUT_VOUT,
      currentHeight: 100,
      receiveScriptPubKey: RECEIVE_SCRIPT,
      bulletproofVerify: (V, p) => bpRangeAggVerify(V, p, 64),
      inputCommitment: env.cInSecp,
    });
    if (!r.valid) return `fill ${i} rejected: ${r.reason}`;
    pool.reserve_A = r.newPoolState.reserve_A;
    pool.reserve_B = r.newPoolState.reserve_B;
    kFloors.push(pool.reserve_A * pool.reserve_B);
  }
  for (let i = 1; i < kFloors.length; i++) {
    if (kFloors[i] <= kFloors[i - 1]) return `k did not grow at step ${i}: ${kFloors[i - 1]} → ${kFloors[i]}`;
  }
  return true;
});

test('item 7: stale reserves rejected', () => {
  const env = makeRealEnv();
  const r = runValidate(env, { R_A_pre: 50_000_001n, R_B_pre: 525_000n });
  return r.valid === false && r.reason.includes('R_A_pre mismatch');
});

test('item 8: slippage (min_out above curve) rejected', () => {
  const env = makeRealEnv({ mutate: (e) => ({ ...e, minOut: e.deltaOut + 1n }) });
  // Re-sign because intent_msg now differs.
  const r = runValidate(env);
  // The intent_sig was signed over the original minOut=deltaOut; mutating
  // minOut without re-signing makes intent_sig fail first. But we want to
  // test the slippage check specifically — rebuild with min_out > delta_out
  // from scratch.
  const env2 = (() => {
    const e = makeRealEnv();
    const newMinOut = e.deltaOut + 1n;
    const intentMsg = buildSwapVarIntentMsg({
      poolId: e.poolId, direction: e.direction,
      deltaIn: e.deltaIn, deltaInMin: e.deltaInMin, deltaInMax: e.deltaInMax,
      deltaOut: e.deltaOut, minOut: newMinOut,
      tipAmount: e.tipAmount, tipAsset: e.tipAsset,
      expiryHeight: e.expiryHeight, traderPubkey: e.traderPubkey,
      assetInputOutpoint: ASSET_INPUT_OUTPOINT,
      receiveScriptPubKey: RECEIVE_SCRIPT,
      cReceiptSecp: e.cReceiptSecp,
      cChangeOrSentinel: e.cChangeOrSentinel,
    });
    return { ...e, minOut: newMinOut, intentSig: signSchnorr(intentMsg, TRADER_PRIVKEY) };
  })();
  const r2 = runValidate(env2);
  return r2.valid === false && r2.reason.includes('slippage');
});

test('item 9: delta_in > delta_in_max rejected', () => {
  // The validator decodes deltaIn from envelope; we need an envelope whose
  // deltaIn > deltaInMax. Build manually.
  const e = makeRealEnv();
  const bad = { ...e, deltaIn: e.deltaInMax + 1n };
  // Re-sign intent (otherwise sig check fires first).
  bad.intentSig = signSchnorr(buildSwapVarIntentMsg({
    ...bad,
    assetInputOutpoint: ASSET_INPUT_OUTPOINT,
    receiveScriptPubKey: RECEIVE_SCRIPT,
  }), TRADER_PRIVKEY);
  // Curve check would also reject; range-bounds check fires first
  // (lines come before curve in validator).
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('delta_in > delta_in_max');
});

test('item 16: curve fudge (delta_out higher than curve) rejected', () => {
  const e = makeRealEnv();
  const bad = { ...e, deltaOut: e.deltaOut + 1n };
  // Inflation defense fires FIRST because C_receipt opens to original deltaOut.
  // We need to also adjust C_receipt to match the inflated deltaOut so we get
  // past the inflation gate and into the curve-mismatch gate. But then the
  // intent_sig (over the original deltaOut) would fail. To isolate the curve
  // check, re-derive everything but the curve recompute itself.
  const r_receipt = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const newDeltaOut = e.deltaOut + 1n;
  const newCReceipt = pointToBytes(pedersenCommit(newDeltaOut, r_receipt));
  bad.deltaOut = newDeltaOut;
  bad.cReceiptSecp = newCReceipt;
  // Re-sign the intent.
  bad.intentSig = signSchnorr(buildSwapVarIntentMsg({
    poolId: bad.poolId, direction: bad.direction,
    deltaIn: bad.deltaIn, deltaInMin: bad.deltaInMin, deltaInMax: bad.deltaInMax,
    deltaOut: newDeltaOut, minOut: bad.minOut, tipAmount: bad.tipAmount, tipAsset: bad.tipAsset,
    expiryHeight: bad.expiryHeight, traderPubkey: bad.traderPubkey,
    assetInputOutpoint: ASSET_INPUT_OUTPOINT,
    receiveScriptPubKey: RECEIVE_SCRIPT,
    cReceiptSecp: newCReceipt,
    cChangeOrSentinel: bad.cChangeOrSentinel,
  }), TRADER_PRIVKEY);
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('delta_out mismatch');
});

// ============================================================
// Section 5: The critical inflation defense (P0 crypto fix)
// ============================================================
//
// Even with all sigs valid, a malicious prover MUST NOT be able to claim
// an inflated delta_out by mis-constructing C_receipt_secp.

console.log('\nCritical: inflation-attack defense');

test('inflation: forged C_receipt with X ≠ delta_out rejected', () => {
  const e = makeRealEnv();
  // Construct a fake receipt commit to a HIGHER amount, but leave deltaOut and
  // r_receipt as the trader's honest values. The check `C_receipt == delta_out
  // · H + r_receipt · G` should fail because LHS commits to (deltaOut+1000)
  // while RHS computes (deltaOut · H + r_receipt · G) → wrong point.
  const r_receipt = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const inflatedAmount = e.deltaOut + 1000n;
  const forgedCReceipt = pointToBytes(pedersenCommit(inflatedAmount, r_receipt));
  const bad = { ...e, cReceiptSecp: forgedCReceipt };
  // Re-sign intent with the forged commit (otherwise intent_sig fails first).
  bad.intentSig = signSchnorr(buildSwapVarIntentMsg({
    poolId: bad.poolId, direction: bad.direction,
    deltaIn: bad.deltaIn, deltaInMin: bad.deltaInMin, deltaInMax: bad.deltaInMax,
    deltaOut: bad.deltaOut, minOut: bad.minOut, tipAmount: bad.tipAmount, tipAsset: bad.tipAsset,
    expiryHeight: bad.expiryHeight, traderPubkey: bad.traderPubkey,
    assetInputOutpoint: ASSET_INPUT_OUTPOINT,
    receiveScriptPubKey: RECEIVE_SCRIPT,
    cReceiptSecp: forgedCReceipt,
    cChangeOrSentinel: bad.cChangeOrSentinel,
  }), TRADER_PRIVKEY);
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('receipt-binding check failed');
});

test('inflation: trader publishing wrong r_receipt rejected', () => {
  const e = makeRealEnv();
  const bad = { ...e, rReceipt: new Uint8Array(32) }; // r_receipt = 0
  // Don't re-sign; the inflation check fires on the public r_receipt
  // against C_receipt, NOT against the intent_sig. The check should fail
  // because C_receipt commits to (delta_out, real_r_receipt) but rebuilds
  // it from (delta_out, 0).
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('receipt-binding check failed');
});

test('inflation: validator rejects r_receipt >= n_secp', () => {
  const e = makeRealEnv();
  const bad = { ...e, rReceipt: new Uint8Array(32).fill(0xff) }; // all 0xff > n
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('r_receipt');
});

// Input-side inflation defense (analogous to receipt-side fix, both on
// the cross-asset boundary). If the trader's published env.cInSecp does
// NOT match the on-chain Pedersen commit at the cited outpoint, the
// kernel-sig closure still verifies (it only binds the algebraic
// relationship a_in_claimed = a_change_claimed + delta_in_total). The
// trader could claim a_in_claimed > a_real and inflate asset A via the
// resulting change UTXO.

test('input inflation: env.cInSecp != on-chain commit ⇒ rejected', () => {
  const e = makeRealEnv();
  // Caller supplies a different on-chain commit. Validator must reject
  // BEFORE doing any kernel-sig work — the on-chain truth is the
  // authoritative input value, env.cInSecp is just the trader's claim.
  const wrongInputCommit = pedersenCommit(99_999n, 12345n);
  const r = runValidate(e, { inputCommitment: pointToBytes(wrongInputCommit) });
  return r.valid === false && r.reason.includes('on-chain input UTXO commit');
});

test('input inflation: missing inputCommitment param ⇒ throws', () => {
  // Catches the "forgot to wire up the on-chain commit" footgun.
  const e = makeRealEnv();
  const payload = encodeSwapVar(e);
  const pool = { pool_id: POOL_ID, asset_A: ASSET_A, asset_B: ASSET_B, reserve_A: 50_000_000n, reserve_B: 525_000n, fee_bps: 30 };
  try {
    validateSwapVar({
      payload, pool, opReturnData: computeSwapVarEnvelopeHash(payload),
      assetInputOutpointTxid: INPUT_TXID,
      assetInputOutpointVout: INPUT_VOUT,
      currentHeight: 100,
      receiveScriptPubKey: RECEIVE_SCRIPT,
      bulletproofVerify: (V, p) => bpRangeAggVerify(V, p, 64),
      // inputCommitment omitted
    });
    return false;
  } catch (err) {
    return /inputCommitment is required/.test(err.message);
  }
});

test('input inflation: inputCommitment as ProjectivePoint also works', () => {
  const e = makeRealEnv();
  // Caller passes ProjectivePoint instead of bytes — validator handles both.
  const onChainPoint = secp.ProjectivePoint.fromHex(bytesToHex(e.cInSecp));
  const r = runValidate(e, { inputCommitment: onChainPoint });
  return r.valid === true;
});

test('input inflation: malformed inputCommitment ⇒ rejected', () => {
  const e = makeRealEnv();
  const r = runValidate(e, { inputCommitment: new Uint8Array(32) }); // wrong length
  return r.valid === false && r.reason.includes('33-byte compressed');
});

// ============================================================
// Section 6: Sigs + envelope-hash binding
// ============================================================

console.log('\nSig + envelope-hash bindings');

test('tampered intent_sig rejected', () => {
  // Flip one byte in a valid sig — guaranteed-invalid result whose
  // (r, s) are well-formed scalars (so the verifier returns false
  // rather than throwing on "invalid scalar").
  const e = makeRealEnv();
  const tampered = new Uint8Array(e.intentSig);
  tampered[10] ^= 0xff;
  const bad = { ...e, intentSig: tampered };
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('intent_sig');
});

test('tampered kernel_sig rejected', () => {
  const e = makeRealEnv();
  const tampered = new Uint8Array(e.kernelSig);
  tampered[10] ^= 0xff;
  const bad = { ...e, kernelSig: tampered };
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('kernel_sig');
});

test('OP_RETURN data mismatch rejected', () => {
  const e = makeRealEnv();
  const payload = encodeSwapVar(e);
  const wrongHash = sha256(new TextEncoder().encode('not the envelope'));
  const pool = { pool_id: POOL_ID, asset_A: ASSET_A, asset_B: ASSET_B, reserve_A: 50_000_000n, reserve_B: 525_000n, fee_bps: 30 };
  const r = validateSwapVar({
    payload, pool, opReturnData: wrongHash,
    assetInputOutpointTxid: INPUT_TXID,
    assetInputOutpointVout: INPUT_VOUT,
    currentHeight: 100,
    receiveScriptPubKey: RECEIVE_SCRIPT,
    bulletproofVerify: (V, p) => bpRangeAggVerify(V, p, 64),
    inputCommitment: e.cInSecp,
  });
  return r.valid === false && r.reason.includes('OP_RETURN');
});

test('expired envelope rejected', () => {
  const e = makeRealEnv();
  const r = runValidate(e, { currentHeight: 1_000_000 });
  return r.valid === false && r.reason.includes('expired');
});

test('pool_id mismatch rejected', () => {
  const e = makeRealEnv();
  const payload = encodeSwapVar(e);
  const wrongPool = { pool_id: new Uint8Array(32).fill(0xff), asset_A: ASSET_A, asset_B: ASSET_B, reserve_A: 50_000_000n, reserve_B: 525_000n, fee_bps: 30 };
  const r = validateSwapVar({
    payload, pool: wrongPool, opReturnData: computeSwapVarEnvelopeHash(payload),
    assetInputOutpointTxid: INPUT_TXID,
    assetInputOutpointVout: INPUT_VOUT,
    currentHeight: 100,
    receiveScriptPubKey: RECEIVE_SCRIPT,
    bulletproofVerify: (V, p) => bpRangeAggVerify(V, p, 64),
    inputCommitment: e.cInSecp,
  });
  return r.valid === false && r.reason.includes('pool_id mismatch');
});

test('bulletproof tampered rejected', () => {
  const e = makeRealEnv();
  const tampered = new Uint8Array(e.rangeProof);
  tampered[10] ^= 0xff;
  const bad = { ...e, rangeProof: tampered };
  const r = runValidate(bad);
  return r.valid === false && r.reason.includes('bulletproof');
});

// ============================================================
// Section 7: No-change sentinel (whole-input case)
// ============================================================

console.log('\nNo-change sentinel (whole-input case)');

test('whole-input case: validator accepts NO_CHANGE_SENTINEL', () => {
  // Build an envelope where amount_in = delta_in_total (no change).
  // We need a trader input UTXO whose commit opens to exactly delta_in_total.
  const dir = 0;
  const deltaIn = 5000n;
  const tip = 50n;
  const dit = deltaIn + tip;
  const amountIn = dit; // no change
  const r_in = 7n;
  const C_in = pedersenCommit(amountIn, r_in);
  const curve = curveDeltaOut({ direction: dir, R_A_pre: 50_000_000n, R_B_pre: 525_000n, delta_in: deltaIn, fee_bps: 30 });
  const deltaOut = curve.deltaOut;
  const r_receipt = deriveSwapVarReceiptScalar({ traderPrivkey: TRADER_PRIVKEY, poolId: POOL_ID, assetInputOutpoint: ASSET_INPUT_OUTPOINT });
  const C_receipt = pedersenCommit(deltaOut, r_receipt);
  const rReceiptBytes = (() => { const out = new Uint8Array(32); let x = r_receipt; for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; })();

  // m=2 bulletproof with (value=0, blinding=0) for slot 0 (sentinel slot).
  const { proof: bpProof } = bpRangeAggProve([0n, deltaOut], [0n, r_receipt], 64);

  const intentMsg = buildSwapVarIntentMsg({
    poolId: POOL_ID, direction: dir, deltaIn, deltaInMin: 1000n, deltaInMax: 10000n,
    deltaOut, minOut: deltaOut, tipAmount: tip, tipAsset: 0,
    expiryHeight: 1_000_000, traderPubkey: TRADER_PUBKEY,
    assetInputOutpoint: ASSET_INPUT_OUTPOINT, receiveScriptPubKey: RECEIVE_SCRIPT,
    cReceiptSecp: pointToBytes(C_receipt), cChangeOrSentinel: NO_CHANGE_SENTINEL,
  });
  const intentSig = signSchnorr(intentMsg, TRADER_PRIVKEY);
  const kernelMsg = buildSwapVarKernelMsg({
    assetIdIn: ASSET_A, assetInputOutpointTxid: INPUT_TXID, assetInputOutpointVout: INPUT_VOUT,
    cChangeOrSentinel: NO_CHANGE_SENTINEL, deltaInTotal: dit,
  });
  // Signing key = -r_in mod n.
  const excess = modN(0n - r_in);
  const excessBytes = (() => { const out = new Uint8Array(32); let x = excess; for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; })();
  const kernelSig = signSchnorr(kernelMsg, excessBytes);

  const env = {
    poolId: POOL_ID, direction: dir, R_A_pre: 50_000_000n, R_B_pre: 525_000n,
    deltaIn, deltaInMin: 1000n, deltaInMax: 10000n, deltaOut,
    minOut: deltaOut, tipAmount: tip, tipAsset: 0,
    expiryHeight: 1_000_000, traderPubkey: TRADER_PUBKEY,
    cInSecp: pointToBytes(C_in),
    cChangeOrSentinel: NO_CHANGE_SENTINEL,
    cReceiptSecp: pointToBytes(C_receipt),
    rReceipt: rReceiptBytes,
    rangeProof: bpProof,
    kernelSig, intentSig,
  };
  const r = runValidate(env);
  return r.valid === true;
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${pass + fail} run, ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
