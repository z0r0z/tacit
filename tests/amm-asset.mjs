// AMM asset identity primitives.
//
// Three-origin asset-id resolution per AMM.md §"Pool state":
//   (1) CETCH                — asset_id = SHA256(reveal_txid_BE || 0_LE)
//   (2) T_PETCH               — asset_id = SHA256(reveal_txid_BE || 0_LE)
//   (3) AMM POOL_INIT (LP)    — asset_id = SHA256("tacit-amm-lp-v1" || pool_id)
//                                 where pool_id = SHA256("tacit-amm-pool-v1" || asset_A || asset_B)
//                                 and asset_A is the lexicographically smaller asset_id.
//
// Domain separation between paths is structural: path (1)/(2) preimages are
// 36 bytes (txid_BE 32 || vout_LE 4); path (3) preimages are 53 bytes
// ("tacit-amm-lp-v1" 15 bytes || pool_id 32 bytes is wrong arithmetic) ...
// Let me recompute: "tacit-amm-lp-v1" UTF-8 = 15 bytes; pool_id = 32 bytes;
// total preimage = 47 bytes. Distinct from 36-byte CETCH/PETCH preimages.

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

const DOMAIN_POOL_ID = new TextEncoder().encode('tacit-amm-pool-v1');
const DOMAIN_LP_ASSET = new TextEncoder().encode('tacit-amm-lp-v1');

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

export function derivePoolId(idA, idB) {
  const [low, high] = canonicalAssetPair(idA, idB);
  return sha256(concatBytes(DOMAIN_POOL_ID, low, high));
}

// LP-share asset_id derived from a confirmed POOL_INIT's pool_id.
export function deriveLpAssetId(poolId) {
  const pid = poolId instanceof Uint8Array ? poolId : hexToBytes(poolId);
  if (pid.length !== 32) throw new Error('pool_id must be 32 bytes');
  return sha256(concatBytes(DOMAIN_LP_ASSET, pid));
}

// Three-origin resolution. Given an asset_id and a lookup oracle providing:
//   getCetchOrPetch(asset_id)  -> { mode: 'CETCH' | 'T_PETCH', reveal_txid_hex } | null
//   getPoolInit(asset_id)       -> { pool_id, asset_A, asset_B } | null
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
