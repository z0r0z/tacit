// Reference indexer validator for AMM envelopes (T_LP_ADD, T_LP_REMOVE,
// T_SWAP_BATCH). Mirrors AMM.md §"SPEC.md integration plan: §5.5" extension
// branches and §"Indexer determinism rules". Pure JS, no Bitcoin layer —
// callers must pre-extract the on-chain context (vout[0] OP_RETURN data,
// input Pedersen commitments, vin/vout layout).
//
// The Groth16 proof verification is delegated to an injected verifier so this
// module stays usable before circuits compile. In production the verifier is
// snarkjs.groth16.verify(vk, publicSignals, proof) under the pool's vk_cid.

import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes,
} from './bulletproofs.mjs';

import { decodeLpAdd, decodeLpRemove, decodeSwapBatch } from './amm-envelope.mjs';
import { derivePoolId, deriveLpAssetId, canonicalAssetPair } from './amm-asset.mjs';
import { verifyXCurve } from './amm-sigma-xcurve.mjs';
import { lpAddKernelVerify, lpRemoveKernelVerify } from './amm-kernel.mjs';
import {
  solveClearing, applyBatch, amountOutForTrader,
  lpAddShares, lpInitShares, lpRemoveOutputs,
} from './amm-clearing.mjs';
import { computeEnvelopeHash, deriveIntentId, buildIntentMsg, verifyIntent } from './amm-intent.mjs';
import { verifyMinLiqOutput } from './amm-min-liq.mjs';
import { extractLauncherPubkey } from './amm-jcs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function pointFromCompressed(bytes) {
  return secp.ProjectivePoint.fromHex(bytesToHex(bytes));
}

// Result shape:
//   { valid: true,  newPoolState, receipts: [...] }
//   { valid: false, reason: string }

// =========================================================================
// T_LP_ADD validator
// =========================================================================
//
// Inputs:
//   payload          : envelope bytes
//   pool             : current pool state (null for POOL_INIT variant=1)
//                        { pool_id, asset_A, asset_B, vk_cid, fee_bps,
//                          reserve_A, reserve_B, lp_total_shares,
//                          inclusion_arbiter_pubkeys, ... }
//   inputCommitmentsA: array of ProjectivePoint — asset-A input UTXOs consumed
//   inputCommitmentsB: array of ProjectivePoint — asset-B input UTXOs consumed
//   inputsA, inputsB : array of { txid, vout } — the same UTXOs as outpoints
//   metadataA, metadataB : per-asset metadata blob bytes (Uint8Array) or null,
//                          for launcher-gate verification on POOL_INIT
//   groth16Verify    : injected function (vk, publicSignals, proof) -> bool
//                        (stub returns true when not provided — callers MUST
//                         wire a real verifier for production)
export function validateLpAdd({
  payload, pool,
  inputCommitmentsA, inputCommitmentsB,
  inputsA, inputsB,
  metadataA = null, metadataB = null,
  groth16Verify = null,
}) {
  let env;
  try { env = decodeLpAdd(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  // Canonical asset ordering: assetA must be < assetB.
  for (let i = 0; i < 32; i++) {
    if (env.assetA[i] < env.assetB[i]) break;
    if (env.assetA[i] > env.assetB[i]) {
      return { valid: false, reason: 'assetA must be lexicographically smaller than assetB' };
    }
  }

  // Verify pool_id matches.
  const poolId = derivePoolId(env.assetA, env.assetB);

  // POOL_INIT path (variant 1): create pool. Otherwise require existing pool.
  if (env.variant === 1) {
    if (pool) return { valid: false, reason: 'POOL_INIT but pool already exists' };

    // Launcher gate (AMM.md §"Optional launcher gate").
    const gateA = metadataA ? extractLauncherPubkey(metadataA) : null;
    const gateB = metadataB ? extractLauncherPubkey(metadataB) : null;
    const gates = [gateA, gateB].filter(g => g !== null);
    if (gates.length > 0) {
      if (env.launcherSigs.length !== gates.length) {
        return { valid: false, reason: 'launcher_sig_count must match declared gates' };
      }
      // Build the launcher-gate message: SHA256("tacit-amm-launcher-gate-v1" || pool_id || vk_cid || fee_bps_LE)
      const vkCidBytes = new TextEncoder().encode(env.vkCid);
      const feeBpsLE = new Uint8Array(2);
      new DataView(feeBpsLE.buffer).setUint16(0, env.feeBps, true);
      const gateMsg = sha256(concatBytes(
        new TextEncoder().encode('tacit-amm-launcher-gate-v1'),
        poolId,
        vkCidBytes,
        feeBpsLE,
      ));
      // Verify each launcher sig — order: gateA first (if present), then gateB.
      // The spec is silent on the order; we adopt "ordered by asset_A's pubkey first".
      const orderedGates = [gateA, gateB].filter(g => g !== null);
      for (let i = 0; i < orderedGates.length; i++) {
        const pk = orderedGates[i];
        const xOnly = pk.subarray(1);
        if (!verifySchnorr(env.launcherSigs[i], gateMsg, xOnly)) {
          return { valid: false, reason: `launcher_sig[${i}] failed verification` };
        }
      }
    } else {
      if (env.launcherSigs.length !== 0) {
        return { valid: false, reason: 'no launcher gates declared but launcherSigs non-empty' };
      }
    }

    // Initial shares (Uniswap V2 convention): total = isqrt(deltaA · deltaB).
    let initShares;
    try { initShares = lpInitShares(env.deltaA, env.deltaB, 1000n); }
    catch (e) { return { valid: false, reason: `lpInitShares: ${e.message}` }; }
    if (initShares.founder_shares !== env.shareAmount) {
      return { valid: false, reason: `shareAmount mismatch: expected ${initShares.founder_shares}, got ${env.shareAmount}` };
    }

    // Per-asset kernel sigs.
    if (!verifyKernel(env, inputCommitmentsA, inputCommitmentsB, inputsA, inputsB, env.variant)) {
      return { valid: false, reason: 'kernel sig verification failed' };
    }
    if (!verifyXCurve(env.shareXcurveSigma, env.shareCSecp, env.shareCBJJ)) {
      return { valid: false, reason: 'share output sigma cross-curve binding failed' };
    }
    if (groth16Verify && !groth16Verify({ proof: env.proof, pool: { vk_cid: env.vkCid }, kind: 'LP_ADD_INIT' })) {
      return { valid: false, reason: 'Groth16 proof failed (POOL_INIT)' };
    }

    // Construct new pool state.
    const newPool = {
      pool_id: poolId,
      asset_A: env.assetA,
      asset_B: env.assetB,
      lp_asset_id: deriveLpAssetId(poolId),
      vk_cid: env.vkCid,
      ceremony_cid: env.ceremonyCid,
      fee_bps: env.feeBps,
      reserve_A: env.deltaA,
      reserve_B: env.deltaB,
      lp_total_shares: initShares.total_shares,
      inclusion_arbiter_pubkeys: env.arbiterPubkeys || [],
    };
    return {
      valid: true,
      newPoolState: newPool,
      receipts: [
        { kind: 'lp_share_founder', amount: initShares.founder_shares, commitment: env.shareCSecp },
        { kind: 'lp_share_locked', amount: initShares.locked_shares, info: 'NUMS-locked at vout[1]' },
      ],
    };
  }

  // Standard LP_ADD (variant 0) — require existing pool.
  if (!pool) return { valid: false, reason: 'pool not registered' };
  if (!bytesEqual(pool.pool_id, poolId)) return { valid: false, reason: 'pool_id mismatch' };

  // At-the-ratio check: deltaA / deltaB ≈ reserve_A / reserve_B.
  // share_amount = floor(min(deltaA · S / reserve_A, deltaB · S / reserve_B))
  let expectedShares;
  try {
    expectedShares = lpAddShares(env.deltaA, env.deltaB, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);
  } catch (e) { return { valid: false, reason: `lpAddShares: ${e.message}` }; }
  if (expectedShares !== env.shareAmount) {
    return { valid: false, reason: `shareAmount: expected ${expectedShares}, got ${env.shareAmount}` };
  }

  if (!verifyKernel(env, inputCommitmentsA, inputCommitmentsB, inputsA, inputsB, env.variant)) {
    return { valid: false, reason: 'kernel sig verification failed' };
  }
  if (!verifyXCurve(env.shareXcurveSigma, env.shareCSecp, env.shareCBJJ)) {
    return { valid: false, reason: 'share output sigma cross-curve binding failed' };
  }
  if (groth16Verify && !groth16Verify({ proof: env.proof, pool, kind: 'LP_ADD' })) {
    return { valid: false, reason: 'Groth16 proof failed' };
  }

  return {
    valid: true,
    newPoolState: {
      ...pool,
      reserve_A: pool.reserve_A + env.deltaA,
      reserve_B: pool.reserve_B + env.deltaB,
      lp_total_shares: pool.lp_total_shares + env.shareAmount,
    },
    receipts: [{ kind: 'lp_share', amount: env.shareAmount, commitment: env.shareCSecp }],
  };
}

function verifyKernel(env, inputCommitmentsA, inputCommitmentsB, inputsA, inputsB, variant) {
  return lpAddKernelVerify({
    variant,
    poolId: derivePoolId(env.assetA, env.assetB),
    assetX: env.assetA,
    deltaX: env.deltaA,
    shareAmount: env.shareAmount,
    shareCSecpBytes: env.shareCSecp,
    inputsX: inputsA,
    inputCommitments: inputCommitmentsA,
    sig64: env.kernelSigA,
  }) && lpAddKernelVerify({
    variant,
    poolId: derivePoolId(env.assetA, env.assetB),
    assetX: env.assetB,
    deltaX: env.deltaB,
    shareAmount: env.shareAmount,
    shareCSecpBytes: env.shareCSecp,
    inputsX: inputsB,
    inputCommitments: inputCommitmentsB,
    sig64: env.kernelSigB,
  });
}

// =========================================================================
// T_LP_REMOVE validator
// =========================================================================
export function validateLpRemove({
  payload, pool,
  lpInputCommitments, lpInputs,
  groth16Verify = null,
}) {
  let env;
  try { env = decodeLpRemove(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }
  if (!pool) return { valid: false, reason: 'pool not registered' };
  const poolId = derivePoolId(env.assetA, env.assetB);
  if (!bytesEqual(pool.pool_id, poolId)) return { valid: false, reason: 'pool_id mismatch' };

  // Expected deltas: proportional withdrawal.
  let expected;
  try { expected = lpRemoveOutputs(env.shareAmount, pool.reserve_A, pool.reserve_B, pool.lp_total_shares); }
  catch (e) { return { valid: false, reason: `lpRemoveOutputs: ${e.message}` }; }
  if (expected.delta_a !== env.deltaA) {
    return { valid: false, reason: `deltaA: expected ${expected.delta_a}, got ${env.deltaA}` };
  }
  if (expected.delta_b !== env.deltaB) {
    return { valid: false, reason: `deltaB: expected ${expected.delta_b}, got ${env.deltaB}` };
  }

  // Kernel sig over lp-share input(s).
  const kernelOk = lpRemoveKernelVerify({
    poolId,
    shareAmount: env.shareAmount,
    deltaA: env.deltaA, deltaB: env.deltaB,
    recvACSecpBytes: env.recvACSecp,
    recvBCSecpBytes: env.recvBCSecp,
    lpInputs,
    lpInputCommitments,
    sig64: env.kernelSigLP,
  });
  if (!kernelOk) return { valid: false, reason: 'kernel sig verification failed' };

  // Sigma cross-curve bindings on both receipts.
  if (!verifyXCurve(env.recvAXcurveSigma, env.recvACSecp, env.recvACBJJ)) {
    return { valid: false, reason: 'asset-A receipt sigma binding failed' };
  }
  if (!verifyXCurve(env.recvBXcurveSigma, env.recvBCSecp, env.recvBCBJJ)) {
    return { valid: false, reason: 'asset-B receipt sigma binding failed' };
  }

  if (groth16Verify && !groth16Verify({ proof: env.proof, pool, kind: 'LP_REMOVE' })) {
    return { valid: false, reason: 'Groth16 proof failed' };
  }

  return {
    valid: true,
    newPoolState: {
      ...pool,
      reserve_A: pool.reserve_A - env.deltaA,
      reserve_B: pool.reserve_B - env.deltaB,
      lp_total_shares: pool.lp_total_shares - env.shareAmount,
    },
    receipts: [
      { kind: 'lp_withdraw_A', amount: env.deltaA, commitment: env.recvACSecp },
      { kind: 'lp_withdraw_B', amount: env.deltaB, commitment: env.recvBCSecp },
    ],
  };
}

// =========================================================================
// T_SWAP_BATCH validator
// =========================================================================
//
// Inputs:
//   payload                  : envelope bytes
//   pool                     : current pool state (must be registered)
//   opReturnData             : 32-byte data from vout[0] OP_RETURN (or null if absent)
//   inputCommitmentsByIntent : array, parallel to intents — each entry is an
//                              array of ProjectivePoint commitments aggregated
//                              into C_in_secp for that intent's tacit input(s)
//   intentInputUtxos         : array, parallel to intents — each entry is the
//                              list of { txid, vout } outpoints consumed by
//                              that intent
//   receiveScripts           : array, parallel to intents — each entry is the
//                              trader's receive_scriptPubKey (Uint8Array)
//   currentHeight            : block height (for arbiter expected_height check)
//   groth16Verify            : injected proof verifier
export function validateSwapBatch({
  payload, pool, opReturnData,
  inputCommitmentsByIntent, intentInputUtxos, receiveScripts,
  currentHeight,
  groth16Verify = null,
}) {
  if (!pool) return { valid: false, reason: 'pool not registered' };
  const hasArbiter = (pool.inclusion_arbiter_pubkeys || []).length > 0;

  let env;
  try { env = decodeSwapBatch(payload, { hasArbiter }); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  // OP_RETURN binding: vout[0] data MUST equal SHA256(envelope_payload).
  if (!opReturnData) return { valid: false, reason: 'missing vout[0] OP_RETURN' };
  const expectedHash = computeEnvelopeHash(payload);
  if (!bytesEqual(opReturnData, expectedHash)) {
    return { valid: false, reason: 'OP_RETURN data != SHA256(envelope_payload)' };
  }

  // pool_id consistency
  const poolId = derivePoolId(env.assetA, env.assetB);
  if (!bytesEqual(pool.pool_id, poolId)) return { valid: false, reason: 'pool_id mismatch' };
  if (env.feeBpsAtSettle !== pool.fee_bps) {
    return { valid: false, reason: 'fee_bps_at_settle != pool.fee_bps' };
  }

  // Arbiter block (if pool requires)
  if (hasArbiter) {
    if (!env.arbiterBlock) return { valid: false, reason: 'arbiter block required by pool' };
    // Arbiter sig verification done elsewhere (caller supplies signed list and
    // we'd verify against pool.inclusion_arbiter_pubkeys). For reference impl
    // we just check the field is present.
    // TODO(production): full mandatory-inclusion check requires fetching the
    // canonical list bytes (content-addressed by qualifying_set_hash) and
    // verifying every listed intent_id appears in env.intents.
  } else {
    if (env.arbiterBlock) return { valid: false, reason: 'arbiter block present but pool has none pinned' };
  }

  // intent_id ascending order
  let prevIid = null;
  const intentIds = [];
  for (let i = 0; i < env.intents.length; i++) {
    const it = env.intents[i];
    // Reconstruct intent_msg from envelope-visible fields + provided trader inputs/scripts.
    if (i >= intentInputUtxos.length || i >= receiveScripts.length) {
      return { valid: false, reason: 'missing context for intent reconstruction' };
    }
    let intentMsg;
    try {
      intentMsg = buildIntentMsg({
        poolId, direction: it.direction, inputUtxos: intentInputUtxos[i],
        cInSecp: it.cInSecp, cInBjj: it.cInBjj, xcurveSigma: it.inXcurveSigma,
        receiveScriptPubKey: receiveScripts[i],
        minOut: it.minOut, tipAmount: it.tipAmount,
        tipAsset: it.direction, // tip on input side per AMM.md "Tip mechanics"
        expiryHeight: it.expiryHeight, traderPubkey: it.traderPubkey,
      });
    } catch (e) { return { valid: false, reason: `intent[${i}] msg build: ${e.message}` }; }

    const iid = deriveIntentId(intentMsg);
    if (prevIid) {
      for (let j = 0; j < 32; j++) {
        if (iid[j] < prevIid[j]) return { valid: false, reason: `intents not in intent_id ascending order at i=${i}` };
        if (iid[j] > prevIid[j]) break;
      }
    }
    prevIid = iid;
    intentIds.push(iid);

    // BIP-340 intent_sig verification (out-of-circuit per AMM.md).
    if (!verifyIntent(intentMsg, it.intentSig, it.traderPubkey)) {
      return { valid: false, reason: `intent[${i}] intent_sig failed` };
    }
    // Per-intent sigma cross-curve binding.
    if (!verifyXCurve(it.inXcurveSigma, it.cInSecp, it.cInBjj)) {
      return { valid: false, reason: `intent[${i}] sigma cross-curve failed` };
    }
    // Expiry not lapsed.
    if (it.expiryHeight < currentHeight) {
      return { valid: false, reason: `intent[${i}] expired (height ${it.expiryHeight} < ${currentHeight})` };
    }
  }

  // Per-receipt sigma cross-curve bindings.
  for (let i = 0; i < env.receipts.length; i++) {
    const r = env.receipts[i];
    if (!verifyXCurve(r.outXcurveSigma, r.cOutSecp, r.cOutBjj)) {
      return { valid: false, reason: `receipt[${i}] sigma cross-curve failed` };
    }
  }

  // Re-run deterministic clearing solve and check declared deltas match.
  let X = 0n, Y = 0n;
  // Re-derive per-trader amount_in from BJJ commitments is impossible without
  // private witness; the Groth16 proof binds this. Here we verify the
  // public Pedersen identity instead (next).
  // Compute Δ_signed direction sign from envelope.
  const dA = env.deltaANetSigned, dB = env.deltaBNetSigned;

  // Chain-side aggregate Pedersen check (one per asset):
  //   Σ_{X→Y inputs} C_in_secp,i − Σ_{Y→X outputs} C_out_secp,i
  //     − tip_X_C_secp − delta_X_signed · H == R_net_X · G
  if (!checkAggregatePedersen({
    env,
    inputCommitmentsByIntent,
    assetXIsA: true,
    deltaXSigned: dA,
    tipXCSecp: env.tipACSecp,
    rNetX: env.rNetA,
  })) {
    return { valid: false, reason: 'asset-A aggregate Pedersen check failed' };
  }
  if (!checkAggregatePedersen({
    env,
    inputCommitmentsByIntent,
    assetXIsA: false,
    deltaXSigned: dB,
    tipXCSecp: env.tipBCSecp,
    rNetX: env.rNetB,
  })) {
    return { valid: false, reason: 'asset-B aggregate Pedersen check failed' };
  }

  // Direction inference from declared net deltas:
  //   A→B-dominant: dA > 0, dB < 0  (A flowing in, B flowing out)
  //   B→A-dominant: dA < 0, dB > 0
  //   spot:         dA == 0, dB == 0
  if (!(dA === 0n && dB === 0n) && !(dA > 0n && dB < 0n) && !(dA < 0n && dB > 0n)) {
    return { valid: false, reason: `inconsistent net-delta signs: dA=${dA}, dB=${dB}` };
  }

  // Re-derive (deltaA_net, deltaB_net) from the deterministic solve over the
  // included intent set. This requires knowing per-trader amount_in's, which
  // the indexer doesn't (Groth16 binds them). What the indexer CAN check:
  // the declared deltas form a valid (X, Y, R_A, R_B, fee_bps) clearing
  // result — but X and Y are private. So instead we verify:
  //   - The chain-side Pedersen identity holds (above) — binds Σ C's to
  //     declared deltas.
  //   - The Groth16 proof asserts each amount_out_i = amount_in_i · P_clear
  //     and min_out is satisfied.
  // The remaining indexer check is: declared (dA, dB) satisfies the
  // constant-product invariant on the post-batch reserves.
  let newReserveA, newReserveB;
  if (dA > 0n) {
    // A→B-dom
    newReserveA = pool.reserve_A + dA;
    newReserveB = pool.reserve_B + dB; // dB is negative, so subtract magnitude
    // Verify the curve: post-batch product ≥ pre-batch product (fee accrues to LPs)
    if (newReserveB <= 0n) return { valid: false, reason: 'asset-B reserve would go negative' };
  } else if (dA < 0n) {
    newReserveA = pool.reserve_A + dA;
    newReserveB = pool.reserve_B + dB;
    if (newReserveA <= 0n) return { valid: false, reason: 'asset-A reserve would go negative' };
  } else {
    newReserveA = pool.reserve_A;
    newReserveB = pool.reserve_B;
  }

  // Constant-product check: with γ scaling, R_A · R_B (post) ≥ R_A · R_B (pre).
  // The exact-output deterministic solve ensures this; verify cheaply here.
  if (newReserveA * newReserveB < pool.reserve_A * pool.reserve_B) {
    return { valid: false, reason: 'constant-product invariant violated (post < pre)' };
  }

  // Groth16 batch proof (delegated)
  if (groth16Verify && !groth16Verify({ proof: env.proof, pool, kind: 'SWAP_BATCH', publicSignals: env })) {
    return { valid: false, reason: 'Groth16 batch proof failed' };
  }

  return {
    valid: true,
    newPoolState: {
      ...pool,
      reserve_A: newReserveA,
      reserve_B: newReserveB,
      // lp_total_shares unchanged by swaps
    },
    receipts: env.receipts.map((r, i) => ({
      kind: env.intents[i].direction === 0 ? 'swap_B_to_trader' : 'swap_A_to_trader',
      commitment: r.cOutSecp,
      vout: 1 + i,
    })),
    intentIds,
  };
}

function checkAggregatePedersen({ env, inputCommitmentsByIntent, assetXIsA, deltaXSigned, tipXCSecp, rNetX }) {
  // Σ_{X→Y inputs} C_in_secp,i  (intents whose direction matches X-side input)
  // − Σ_{Y→X outputs} C_out_secp,i  (intents whose direction is opposite, so X is their receipt)
  // − tip_X_C_secp − delta_X_signed · H == R_net_X · G
  //
  // direction == 0 (A→B): input is asset A, output is asset B.
  // direction == 1 (B→A): input is asset B, output is asset A.
  //
  // For assetXIsA: input side = direction==0 traders, output side = direction==1 traders.

  let sum = ZERO;
  for (let i = 0; i < env.intents.length; i++) {
    const it = env.intents[i];
    const isInputSide = (assetXIsA && it.direction === 0) || (!assetXIsA && it.direction === 1);
    const isOutputSide = (assetXIsA && it.direction === 1) || (!assetXIsA && it.direction === 0);
    if (isInputSide) {
      // The trader's input C_in_secp is the aggregate of their tacit-input UTXOs'
      // Pedersen commitments. Caller provides those; we sum them here.
      for (const cp of inputCommitmentsByIntent[i]) sum = sum.add(cp);
    } else if (isOutputSide) {
      sum = sum.add(pointFromCompressed(env.receipts[i].cOutSecp).negate());
    }
  }
  sum = sum.add(pointFromCompressed(tipXCSecp).negate());

  // Subtract delta_X_signed · H (handle sign)
  if (deltaXSigned !== 0n) {
    const mag = deltaXSigned < 0n ? -deltaXSigned : deltaXSigned;
    const dH = H.multiply(mag);
    if (deltaXSigned > 0n) sum = sum.add(dH.negate());
    else sum = sum.add(dH);
  }

  // Compare against R_net_X · G
  const rNet = BigInt('0x' + bytesToHex(rNetX));
  const rNetMod = modN(rNet);
  const rG = rNetMod === 0n ? ZERO : G.multiply(rNetMod);
  return sum.equals(rG);
}

