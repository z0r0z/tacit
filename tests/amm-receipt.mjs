// Receipt-blinding derivation for AMM receipts.
//
// Per AMM.md §"Receipt recovery":
//
//   seed_secp = HMAC-SHA256(recipient_privkey,
//                            "tacit-amm-receipt-secp-v1"
//                            || pool_id
//                            || recipient_anchor_outpoint
//                            || asset_id)
//   seed_BJJ  = HMAC-SHA256(recipient_privkey,
//                            "tacit-amm-receipt-bjj-v1"
//                            || pool_id
//                            || recipient_anchor_outpoint
//                            || asset_id)
//   r_out_secp_i = seed_secp mod n_secp
//   r_out_BJJ_i  = seed_BJJ  mod n_BJJ
//
// recipient_anchor_outpoint = txid_BE(32) || vout_LE(4) = 36 bytes
//
// Anchors:
//   • Swap receipt (T_SWAP_BATCH): trader's tacit input outpoint at vin[1+rank]
//   • LP-share receipt (T_LP_ADD): LP's canonical asset-A input outpoint (first)
//   • LP-withdraw receipts (T_LP_REMOVE): LP's lp_asset_id input outpoint
//
// Indexers do not derive receipt blindings — only recipients can, since the
// derivation requires the recipient's privkey. The settler/LP-op assembler
// receives the blindings from the recipient via an encrypted opening blob.

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import { SECP_N, modN as modSecp } from './bulletproofs.mjs';
import { N_BJJ } from './amm-bjj.mjs';

const DOMAIN_SECP = new TextEncoder().encode('tacit-amm-receipt-secp-v1');
const DOMAIN_BJJ  = new TextEncoder().encode('tacit-amm-receipt-bjj-v1');

function asBytes32(x, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return b;
}
function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }

function bytesToBigintBE(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

// Build the 36-byte canonical outpoint (txid_BE || vout_LE).
export function canonicalOutpoint(txidHex, vout) {
  const txid_BE = reverseBytes(hexToBytes(txidHex));
  const vout_LE = new Uint8Array(4);
  new DataView(vout_LE.buffer).setUint32(0, vout >>> 0, true);
  return concatBytes(txid_BE, vout_LE);
}

// Counter-extended HMAC for rejection sampling. counter byte is appended
// to the base message; counter=0 is the unsuffixed base call (handled at
// the call site by trying base first without suffix).
function _hmacWithCounter(sk, baseMsg, counter) {
  const counterByte = new Uint8Array([counter & 0xff]);
  return hmac(sha256, sk, concatBytes(baseMsg, counterByte));
}

// Derive (r_out_secp, r_out_BJJ) for a single receipt.
//
// Returns { r_secp: bigint (mod n_secp), r_BJJ: bigint (mod n_BJJ) }.
//
// Rejection-samples r=0: probability is ~2⁻²⁵⁶ per side, but r=0 collapses
// the Pedersen commitment to amount·H and breaks the hiding property the
// spec requires. The counter-extended fallback preserves the unsuffixed
// base call as the canonical path so existing test vectors stay valid.
export function deriveReceiptBlinding({
  recipientPrivkey,    // 32-byte Uint8Array or hex
  poolId,              // 32-byte Uint8Array or hex
  anchorOutpoint,      // 36-byte Uint8Array (canonicalOutpoint())
  assetId,             // 32-byte Uint8Array or hex
}) {
  const sk = recipientPrivkey instanceof Uint8Array ? recipientPrivkey : hexToBytes(recipientPrivkey);
  if (sk.length !== 32) throw new Error('recipientPrivkey must be 32 bytes');
  const pid = asBytes32(poolId, 'poolId');
  const aid = asBytes32(assetId, 'assetId');
  if (!(anchorOutpoint instanceof Uint8Array) || anchorOutpoint.length !== 36) {
    throw new Error('anchorOutpoint must be 36 bytes (use canonicalOutpoint())');
  }

  const baseSecp = concatBytes(DOMAIN_SECP, pid, anchorOutpoint, aid);
  const baseBJJ  = concatBytes(DOMAIN_BJJ,  pid, anchorOutpoint, aid);
  let seedSecp = hmac(sha256, sk, baseSecp);
  let r_secp = modSecp(bytesToBigintBE(seedSecp));
  for (let counter = 1; r_secp === 0n && counter < 256; counter++) {
    seedSecp = _hmacWithCounter(sk, baseSecp, counter);
    r_secp = modSecp(bytesToBigintBE(seedSecp));
  }
  if (r_secp === 0n) throw new Error('receipt secp blinding: rejection sampling exhausted (statistically impossible)');
  let seedBJJ = hmac(sha256, sk, baseBJJ);
  let r_BJJ  = bytesToBigintBE(seedBJJ) % N_BJJ;
  for (let counter = 1; r_BJJ === 0n && counter < 256; counter++) {
    seedBJJ = _hmacWithCounter(sk, baseBJJ, counter);
    r_BJJ  = bytesToBigintBE(seedBJJ) % N_BJJ;
  }
  if (r_BJJ === 0n) throw new Error('receipt BJJ blinding: rejection sampling exhausted (statistically impossible)');
  return { r_secp, r_BJJ };
}

// Per-batch helper: derive blindings for an A→B or B→A swap receipt.
// outputAssetId is the asset that's being received (opposite of input direction).
export function deriveSwapReceiptBlinding({
  recipientPrivkey,
  poolId,
  traderInputOutpoint, // canonicalOutpoint of the trader's vin[1+rank] tacit input
  outputAssetId,
}) {
  return deriveReceiptBlinding({
    recipientPrivkey,
    poolId,
    anchorOutpoint: traderInputOutpoint,
    assetId: outputAssetId,
  });
}

// LP_ADD share receipt blinding. Anchor is the LP's canonical (first) asset-A
// input outpoint. The receipt asset is lp_asset_id.
export function deriveLpAddShareBlinding({
  recipientPrivkey,
  poolId,
  lpInputAOutpoint,
  lpAssetId,
}) {
  return deriveReceiptBlinding({
    recipientPrivkey,
    poolId,
    anchorOutpoint: lpInputAOutpoint,
    assetId: lpAssetId,
  });
}

// LP_REMOVE produces two receipts (asset A and asset B). Both anchored on the
// SAME lp_share_input_outpoint, distinguished by asset_id.
export function deriveLpRemoveBlindings({
  recipientPrivkey,
  poolId,
  lpShareInputOutpoint,
  assetIdA,
  assetIdB,
}) {
  const blindA = deriveReceiptBlinding({
    recipientPrivkey,
    poolId,
    anchorOutpoint: lpShareInputOutpoint,
    assetId: assetIdA,
  });
  const blindB = deriveReceiptBlinding({
    recipientPrivkey,
    poolId,
    anchorOutpoint: lpShareInputOutpoint,
    assetId: assetIdB,
  });
  return { legA: blindA, legB: blindB };
}
