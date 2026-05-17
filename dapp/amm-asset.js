// AMM asset identity primitives — dapp-side port of tests/amm-asset.mjs.
// Byte-for-byte identical math; imports adjusted for dapp vendor bundle.
//
// Three-origin asset-id resolution per AMM.md §"Pool state":
//   (1) CETCH                — asset_id = SHA256(reveal_txid_BE || 0_LE)
//   (2) T_PETCH              — asset_id = SHA256(reveal_txid_BE || 0_LE)
//   (3) AMM POOL_INIT (LP)   — asset_id = SHA256("tacit-amm-lp-v1" || pool_id)
//                              where pool_id = SHA256(
//                                "tacit-amm-pool-v1"
//                                || asset_A           // 32 B, lex-smaller
//                                || asset_B           // 32 B, lex-larger
//                                || fee_bps_LE        // 2 B,  u16  (0..1000)
//                                || capability_flags  // 1 B,  u8
//                              )

import { sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

const DOMAIN_POOL_ID = new TextEncoder().encode('tacit-amm-pool-v1');
const DOMAIN_LP_ASSET = new TextEncoder().encode('tacit-amm-lp-v1');

const FEE_BPS_MAX = 1000;
const CAPABILITY_FLAGS_MAX = 255;

function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }

export function deriveAssetIdFromReveal(revealTxidHex, revealVout = 0) {
  const txidBE = reverseBytes(hexToBytes(revealTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, revealVout >>> 0, true);
  return sha256(concatBytes(txidBE, voutLE));
}

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

export function derivePoolId(idA, idB, feeBps, capabilityFlags) {
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
  return sha256(concatBytes(DOMAIN_POOL_ID, low, high, feeBpsLE, flagsByte));
}

export function deriveLpAssetId(poolId) {
  const pid = poolId instanceof Uint8Array ? poolId : hexToBytes(poolId);
  if (pid.length !== 32) throw new Error('pool_id must be 32 bytes');
  return sha256(concatBytes(DOMAIN_LP_ASSET, pid));
}
