// AMM asset identity primitives.
//
// Three-origin asset-id resolution per AMM.md §"Pool state":
//   (1) CETCH                — asset_id = SHA256(reveal_txid_BE || 0_LE)
//   (2) T_PETCH               — asset_id = SHA256(reveal_txid_BE || 0_LE)
//   (3) AMM POOL_INIT (LP)    — asset_id = SHA256("tacit-amm-lp-v1" || pool_id)
//                                 where pool_id = SHA256(
//                                   "tacit-amm-pool-v1"
//                                   || asset_A                 // 32 B, lex-smaller
//                                   || asset_B                 // 32 B, lex-larger
//                                   || fee_bps_LE              // 2 B,  u16  (0..1000)
//                                   || capability_flags        // 1 B,  u8
//                                   || protocol_fee_address    // 33 B, appended iff fee enabled
//                                   || protocol_fee_bps_LE     // 2 B,  appended iff fee enabled
//                                 )
//                                 → 84-byte preimage (no-skim) or 119-byte preimage (fee enabled)
//
// Domain separation between paths is structural: path (1)/(2) preimages are
// 36 bytes (txid_BE 32 || vout_LE 4); path (3) lp_asset_id preimages are
// 47 bytes ("tacit-amm-lp-v1" 15 B || pool_id 32 B); pool_id preimages are
// 84 or 119 bytes. All sizes are disjoint, so cross-origin SHA256 collisions
// reduce to preimage-finding under distinct domain separations.
//
// V3/V4 parity: multiple pools can coexist for the same (asset_A, asset_B)
// at different fee tiers OR capability_flags configurations — each
// distinct (fee_bps, capability_flags) tuple yields a distinct pool_id and
// thus a distinct canonical pool. "One canonical pool per (pair, fee_bps,
// capability_flags)" replaces the earlier "one canonical pool per pair".

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

const DOMAIN_POOL_ID = new TextEncoder().encode('tacit-amm-pool-v1');
const DOMAIN_LP_ASSET = new TextEncoder().encode('tacit-amm-lp-v1');

// Validation bounds. fee_bps is u16 capped at 1000 (10%) per AMM.md
// §"SOLVE_CLEARING". capability_flags is a u8 bitmap (AMM.md §"Pool state").
const FEE_BPS_MAX = 1000;
const CAPABILITY_FLAGS_MAX = 255;
const PROTOCOL_FEE_ADDRESS_LEN = 33;
const PROTOCOL_FEE_BPS_MAX = 1000;
const ZERO_PROTOCOL_FEE_ADDRESS = new Uint8Array(PROTOCOL_FEE_ADDRESS_LEN);
function isZeroProtocolFeeAddress(b) {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }

// CETCH and T_PETCH share the same asset-id formula.
//   asset_id = SHA256(reveal_txid_BE || reveal_vout_LE)
// where reveal_vout is 0 by convention (SPEC §4).
export function deriveAssetIdFromReveal(revealTxidHex, revealVout = 0) {
  const txidBE = reverseBytes(hexToBytes(revealTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, revealVout >>> 0, true);
  return sha256(concatBytes(txidBE, voutLE));
}

// Pool identity from an unordered pair of tacit asset_ids.
// Canonical order: unsigned big-endian byte compare ⇒ smaller is asset_A.
export function canonicalAssetPair(idA, idB) {
  const a = idA instanceof Uint8Array ? idA : hexToBytes(idA);
  const b = idB instanceof Uint8Array ? idB : hexToBytes(idB);
  if (a.length !== 32 || b.length !== 32) throw new Error('asset_id must be 32 bytes');
  for (let i = 0; i < 32; i++) {
    if (a[i] < b[i]) return [a, b];
    if (a[i] > b[i]) return [b, a];
  }
  throw new Error('canonicalAssetPair: identical asset_ids');
}

// Derive pool_id from a canonical pair, fee tier, and capability flags.
//   pool_id = SHA256(
//     "tacit-amm-pool-v1" || asset_A || asset_B || fee_bps_LE || capability_flags
//     [ || protocol_fee_address || protocol_fee_bps_LE ]   // appended iff fee enabled
//   )
// All discriminators are load-bearing: two POOL_INITs over the same (A, B)
// with different fee_bps OR capability_flags OR protocol-fee configuration are
// different canonical pools. The protocol-fee fields are size-discriminated:
// fee-disabled (joint-zero) uses the 84-byte preimage and is the canonical
// no-skim pool; any non-zero protocol-fee config appends both fields (119-byte
// preimage), preventing protocol-fee squatting on the no-skim canonical pool.
// Callers MUST supply fee_bps + capabilityFlags from the POOL_INIT envelope
// (variant=1) or the existing pool record (variant=0 LP_ADD / LP_REMOVE /
// SWAP_*); protocolFeeAddress + protocolFeeBps default to disabled if omitted.
export function derivePoolId(idA, idB, feeBps, capabilityFlags, protocolFeeAddress, protocolFeeBps) {
  const [low, high] = canonicalAssetPair(idA, idB);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) {
    throw new Error(`fee_bps must be integer in [0, ${FEE_BPS_MAX}]: got ${feeBps}`);
  }
  if (!Number.isInteger(capabilityFlags) || capabilityFlags < 0 || capabilityFlags > CAPABILITY_FLAGS_MAX) {
    throw new Error(`capability_flags must be u8 in [0, ${CAPABILITY_FLAGS_MAX}]: got ${capabilityFlags}`);
  }
  const feeBpsLE = new Uint8Array(2);
  new DataView(feeBpsLE.buffer).setUint16(0, feeBps, true);
  const flagsByte = new Uint8Array([capabilityFlags]);

  const pfBps = protocolFeeBps == null ? 0 : protocolFeeBps;
  if (!Number.isInteger(pfBps) || pfBps < 0 || pfBps > PROTOCOL_FEE_BPS_MAX) {
    throw new Error(`protocol_fee_bps must be integer in [0, ${PROTOCOL_FEE_BPS_MAX}]: got ${pfBps}`);
  }
  let pfAddr;
  if (protocolFeeAddress == null) {
    pfAddr = ZERO_PROTOCOL_FEE_ADDRESS;
  } else {
    pfAddr = protocolFeeAddress instanceof Uint8Array ? protocolFeeAddress : hexToBytes(protocolFeeAddress);
    if (pfAddr.length !== PROTOCOL_FEE_ADDRESS_LEN) {
      throw new Error(`protocol_fee_address must be ${PROTOCOL_FEE_ADDRESS_LEN} bytes: got ${pfAddr.length}`);
    }
  }
  const pfAddrZero = isZeroProtocolFeeAddress(pfAddr);
  if ((pfBps === 0) !== pfAddrZero) {
    throw new Error('protocol_fee_address and protocol_fee_bps must be joint-zero or joint-non-zero');
  }
  if (pfBps === 0) {
    return sha256(concatBytes(DOMAIN_POOL_ID, low, high, feeBpsLE, flagsByte));
  }
  const pfBpsLE = new Uint8Array(2);
  new DataView(pfBpsLE.buffer).setUint16(0, pfBps, true);
  return sha256(concatBytes(DOMAIN_POOL_ID, low, high, feeBpsLE, flagsByte, pfAddr, pfBpsLE));
}

// LP-share asset_id derived from a confirmed POOL_INIT's pool_id.
export function deriveLpAssetId(poolId) {
  const pid = poolId instanceof Uint8Array ? poolId : hexToBytes(poolId);
  if (pid.length !== 32) throw new Error('pool_id must be 32 bytes');
  return sha256(concatBytes(DOMAIN_LP_ASSET, pid));
}

// Three-origin resolution. Given an asset_id and a lookup oracle providing:
//   getCetchOrPetch(asset_id)  -> { mode: 'CETCH' | 'T_PETCH', reveal_txid_hex } | null
//   getPoolInit(asset_id)       -> { pool_id, asset_A, asset_B, fee_bps, capability_flags } | null
// returns { origin: 'CETCH' | 'T_PETCH' | 'LP', ... } or null on unresolved.
//
// Verification is byte-exact: each candidate origin must reproduce the asset_id
// from public chain state.
export function resolveAssetIdOrigin(assetId, lookups) {
  const aid = assetId instanceof Uint8Array ? assetId : hexToBytes(assetId);
  const aidHex = bytesToHex(aid);

  // Path (1)/(2): CETCH/PETCH reveal-tx match.
  const ep = lookups.getCetchOrPetch ? lookups.getCetchOrPetch(aidHex) : null;
  if (ep) {
    const recomputed = deriveAssetIdFromReveal(ep.reveal_txid_hex, 0);
    if (bytesEqual(recomputed, aid)) {
      return { origin: ep.mode, reveal_txid_hex: ep.reveal_txid_hex };
    }
  }
  // Path (3): POOL_INIT LP-share match.
  const pi = lookups.getPoolInit ? lookups.getPoolInit(aidHex) : null;
  if (pi) {
    const recomputed = deriveLpAssetId(hexToBytes(pi.pool_id));
    if (bytesEqual(recomputed, aid)) {
      return {
        origin: 'LP',
        pool_id: pi.pool_id,
        asset_A: pi.asset_A,
        asset_B: pi.asset_B,
      };
    }
  }
  return null;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
