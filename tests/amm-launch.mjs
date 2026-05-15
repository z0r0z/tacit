// Single-click token-launch + pool-seed reference module.
//
// Helps the dapp implement the "launch a token paired with cBTC, single
// click" UX. Returns:
//
//   `previewLaunch(params)`  — pure quote: expected pool state, founder
//                              share count, MIN_LIQ lock severity, an
//                              estimate of Bitcoin tx fees at the chosen
//                              feerate.
//   `buildLaunchBundle(params)` — returns the two envelope payloads
//                                 (etch + POOL_INIT) that the dapp will
//                                 sign with the user's privkey and
//                                 broadcast as a mempool package.
//
// V1 atomicity: the two transactions broadcast as a Bitcoin mempool
// package and confirm in the same block. The dapp pre-computes TX1's
// txid (deterministically from the signed CETCH/T_PETCH inputs+outputs)
// so TX2 can reference TX1's etched-supply output. If the dapp picks a
// feerate that doesn't need RBF mid-package, both confirm together.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { isqrt, lpInitShares } from './amm-clearing.mjs';
import {
  MINIMUM_LIQUIDITY, assessMinLiqLockFraction,
} from './amm-min-liq.mjs';
import {
  derivePoolId, deriveLpAssetId, canonicalAssetPair,
} from './amm-asset.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Tacit V1 normative caps (mirror SPEC.md §5.14 POOL_INIT wire format).
const FEE_BPS_MAX = 1000;          // 10% cap on pool fee
const PROTOCOL_FEE_BPS_MAX = 1000; // 10% cap on protocol fee

// Approximate Bitcoin tx vbyte estimates per tacit envelope:
const ESTIMATED_VBYTES = {
  CETCH:    200,   // confidential etch (Pedersen + tacit_attest)
  T_PETCH:  150,   // permissionless mint (public supply)
  POOL_INIT: 700,  // T_LP_ADD variant=1: two kernel sigs + share sigma + Groth16 proof
};
const ESTIMATED_COMMIT_VBYTES = 150;  // standard tacit commit tx

// ---------------------------------------------------------------------------
// previewLaunch
// ---------------------------------------------------------------------------

// Returns:
//   {
//     newAssetId,        // SHA-256 of the predicted CETCH/T_PETCH reveal txid
//                        //   (only computable once the dapp knows the txid;
//                        //   here we return null so caller fills in)
//     poolId,            // derivePoolId(cBTC, newAsset) — placeholder until newAssetId known
//     lpAssetId,         // derivedLpAssetId(poolId)
//     initialPriceCBTCPerToken,
//     initialShares: { total, founder, locked },
//     minLiqLockAssessment: { severity, locked_bps, ... },
//     estimatedFees: { commit_vbytes, reveal_vbytes, total_vbytes, sats_at_10sv, sats_at_50sv },
//     warnings: [strings — surface in dapp UX],
//     blockingErrors: [strings — refuse submission],
//   }
//
// Inputs:
//   tokenType: 'CETCH' | 'T_PETCH'
//   cbtcSeedAmount: bigint (sats)
//   tokenSeedAmount: bigint
//   feeBps: number (0..1000)
//   protocolFeeBps: number (0..1000, default 0)
//   feerateSatPerVB: number (for fee estimate; default 10 → relaxed mempool)
//   cbtcAssetId: Uint8Array(32) — caller provides; cBTC's canonical asset_id
//   newAssetIdPredicted: Uint8Array(32) — null if not yet known (etch reveal-tx not yet built)
export function previewLaunch({
  tokenType = 'T_PETCH',
  cbtcSeedAmount,
  tokenSeedAmount,
  feeBps = 30,
  protocolFeeBps = 0,
  feerateSatPerVB = 10,
  cbtcAssetId,
  newAssetIdPredicted = null,
}) {
  const warnings = [];
  const blockingErrors = [];

  // -- input validation --
  if (typeof cbtcSeedAmount !== 'bigint' || cbtcSeedAmount <= 0n) {
    blockingErrors.push('cbtcSeedAmount must be a positive bigint (sats)');
  }
  if (typeof tokenSeedAmount !== 'bigint' || tokenSeedAmount <= 0n) {
    blockingErrors.push('tokenSeedAmount must be a positive bigint (token base units)');
  }
  if (typeof feeBps !== 'number' || feeBps < 0 || feeBps > FEE_BPS_MAX) {
    blockingErrors.push(`feeBps must be 0..${FEE_BPS_MAX}`);
  }
  if (typeof protocolFeeBps !== 'number' || protocolFeeBps < 0 || protocolFeeBps > PROTOCOL_FEE_BPS_MAX) {
    blockingErrors.push(`protocolFeeBps must be 0..${PROTOCOL_FEE_BPS_MAX}`);
  }
  if (tokenType !== 'CETCH' && tokenType !== 'T_PETCH') {
    blockingErrors.push(`tokenType must be 'CETCH' or 'T_PETCH'`);
  }
  if (!(cbtcAssetId instanceof Uint8Array) || cbtcAssetId.length !== 32) {
    blockingErrors.push('cbtcAssetId must be a 32-byte Uint8Array');
  }

  if (blockingErrors.length > 0) {
    return { blockingErrors, warnings, valid: false };
  }

  // -- MIN_LIQ lock-fraction assessment --
  let minLiqLockAssessment;
  try {
    minLiqLockAssessment = assessMinLiqLockFraction(cbtcSeedAmount, tokenSeedAmount);
  } catch (e) {
    blockingErrors.push(`min-liq assessment: ${e.message}`);
    return { blockingErrors, warnings, valid: false };
  }
  if (minLiqLockAssessment.severity === 'reject') {
    blockingErrors.push(
      `Pool too small: total_shares (${minLiqLockAssessment.total_shares}) ≤ MINIMUM_LIQUIDITY (${MINIMUM_LIQUIDITY}). ` +
      `Founder would receive zero shares. Increase cbtcSeedAmount and/or tokenSeedAmount.`
    );
    return { blockingErrors, warnings, valid: false };
  }
  if (minLiqLockAssessment.severity === 'high') {
    warnings.push(
      `Thin pool: ${minLiqLockAssessment.locked_bps} bps (${(Number(minLiqLockAssessment.locked_bps) / 100).toFixed(2)}%) of total initial shares locked at MIN_LIQ. ` +
      `Founder receives ${minLiqLockAssessment.founder_shares} / ${minLiqLockAssessment.total_shares} shares. ` +
      `Consider increasing seed sizes.`
    );
  } else if (minLiqLockAssessment.severity === 'warn') {
    warnings.push(
      `Small pool: ${minLiqLockAssessment.locked_bps} bps (${(Number(minLiqLockAssessment.locked_bps) / 100).toFixed(2)}%) of total initial shares locked at MIN_LIQ. ` +
      `Acceptable but worth surfacing to the founder.`
    );
  }

  // -- shares calculation --
  const initialShares = lpInitShares(cbtcSeedAmount, tokenSeedAmount, MINIMUM_LIQUIDITY);

  // -- price calculation --
  // initialPriceCBTCPerToken = cbtcSeedAmount / tokenSeedAmount.
  // Returned as a Number for UX display (precision-loss tolerated for display).
  const initialPriceCBTCPerToken = Number(cbtcSeedAmount) / Number(tokenSeedAmount);

  // -- protocol-fee config check --
  if (protocolFeeBps > 0) {
    warnings.push(
      `Protocol fee ${protocolFeeBps} bps enabled: founder's protocol_fee_address will accrue ` +
      `${protocolFeeBps} bps of LP-fee growth, claimable via T_PROTOCOL_FEE_CLAIM. ` +
      `Immutable post-POOL_INIT.`
    );
  }

  // -- pool_id / lp_asset_id (require both asset_ids; predict if not known) --
  let poolId = null, lpAssetId = null;
  if (newAssetIdPredicted instanceof Uint8Array && newAssetIdPredicted.length === 32) {
    poolId = derivePoolId(cbtcAssetId, newAssetIdPredicted);
    lpAssetId = deriveLpAssetId(poolId);
  } else {
    warnings.push(
      `newAssetIdPredicted not provided — poolId / lpAssetId will be computable once ` +
      `the etch reveal-tx is signed and its txid is known.`
    );
  }

  // -- fee estimate --
  const etchVbytes = ESTIMATED_VBYTES[tokenType];
  const totalVbytes = ESTIMATED_COMMIT_VBYTES * 2 + etchVbytes + ESTIMATED_VBYTES.POOL_INIT;
  const sats_at_10sv = totalVbytes * 10;
  const sats_at_50sv = totalVbytes * 50;
  const estimatedFees = {
    etch_vbytes: ESTIMATED_COMMIT_VBYTES + etchVbytes,
    pool_init_vbytes: ESTIMATED_COMMIT_VBYTES + ESTIMATED_VBYTES.POOL_INIT,
    total_vbytes: totalVbytes,
    sats_at_10sv,
    sats_at_50sv,
    estimated_sats_at_feerate: totalVbytes * feerateSatPerVB,
  };

  // -- founder dollar warning --
  // At $100K BTC, total_vbytes × 50 sat/vB / 1e8 × $100K.
  // For 1100 vbytes × 50 sat/vB = 55,000 sat = $55 in fees at busy mempool.
  if (sats_at_50sv > 50_000) {
    warnings.push(
      `Busy-mempool fee estimate: ${sats_at_50sv} sat (~$${(sats_at_50sv / 100_000_000 * 100_000).toFixed(2)} ` +
      `at BTC ≈ $100K) for the launch bundle (CETCH/T_PETCH + POOL_INIT, both with commit+reveal). ` +
      `Consider launching during low-fee periods if cost-sensitive.`
    );
  }

  return {
    valid: true,
    tokenType,
    initialPriceCBTCPerToken,
    initialShares,
    minLiqLockAssessment,
    poolId,
    lpAssetId,
    estimatedFees,
    warnings,
    blockingErrors,
    // Founder-relevant economic preview:
    pool: {
      reserve_A_at_init: undefined,    // depends on canonical order; computed once newAssetId known
      reserve_B_at_init: undefined,
      fee_bps: feeBps,
      protocol_fee_bps: protocolFeeBps,
    },
    sizes: { cbtcSeedAmount, tokenSeedAmount },
  };
}

// ---------------------------------------------------------------------------
// buildLaunchBundle — high-level orchestration
// ---------------------------------------------------------------------------

// Returns a structured plan describing the two envelopes the dapp must
// build, sign, and broadcast as a Bitcoin mempool package. The dapp
// fills in privkey-domain fields (signatures, blinding factors); this
// module computes everything else.
//
// Returns:
//   {
//     plan: 'launch-bundle-v1',
//     tx1: { envelope: 'CETCH' | 'T_PETCH', tokenParams, hint: 'sign-with-founder-privkey' },
//     tx2: { envelope: 'POOL_INIT',
//            poolParams,
//            dependsOnTx1: true,
//            hint: 'requires tx1 txid before constructing input ref' },
//     broadcastStrategy: { method: 'mempool-package', notes: '...' },
//     preview,  // result of previewLaunch
//   }
//
// The dapp's flow:
//   1. Call buildLaunchBundle(params)
//   2. Construct + sign TX1 from `tx1.envelope` + `tx1.tokenParams`
//   3. Compute TX1's txid (deterministic from signed-inputs+outputs)
//   4. Construct + sign TX2 using `tx2.poolParams` and TX1's txid for the new token's input outpoint
//   5. Broadcast TX1 + TX2 as a mempool package (Bitcoin Core JSON-RPC `submitpackage`)
//
// Returns null on validation failure (see preview.blockingErrors).
export function buildLaunchBundle(params) {
  const preview = previewLaunch(params);
  if (!preview.valid) return { plan: 'launch-bundle-v1', valid: false, preview };

  const { cbtcSeedAmount, tokenSeedAmount } = preview.sizes;
  return {
    plan: 'launch-bundle-v1',
    valid: true,
    preview,
    tx1: {
      envelope: params.tokenType || 'T_PETCH',
      tokenParams: {
        // Caller fills in ticker / decimals / metadata-CID / etc.
        // For T_PETCH: public supply = tokenSeedAmount + any reserved supply.
        // For CETCH: confidential supply commitment + tacit_attest.
        supplyOrCap: tokenSeedAmount,
      },
      hint: 'Construct CETCH/T_PETCH envelope with founder pubkey, broadcast.',
    },
    tx2: {
      envelope: 'POOL_INIT',
      poolParams: {
        cbtcAssetId: params.cbtcAssetId,
        // newAssetId is the SHA-256 of TX1's reveal txid; the dapp computes it
        // after TX1 is built.
        deltaA: cbtcSeedAmount,
        deltaB: tokenSeedAmount,
        feeBps: params.feeBps ?? 30,
        protocolFeeBps: params.protocolFeeBps ?? 0,
        // Expected founder share count + lp_asset_id are in preview.
      },
      dependsOnTx1: true,
      hint: 'Reference TX1\'s reveal-tx output as the newAsset input; sign POOL_INIT.',
    },
    broadcastStrategy: {
      method: 'mempool-package',
      notes:
        'Broadcast TX1 first, then TX2 (or use submitpackage). Both will land in the ' +
        'next Bitcoin block under typical mempool conditions. AVOID RBF on TX1 mid-package ' +
        '— if TX1\'s txid changes, TX2\'s input reference becomes invalid and TX2 will be ' +
        'rejected. Price both txs at a feerate that\'s comfortable for the current mempool.',
    },
  };
}
