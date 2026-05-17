// Receipt-blinding derivation for AMM receipts — dapp-side port of
// tests/amm-receipt.mjs. Byte-for-byte identical math.
//
// Per AMM.md §"Receipt recovery":
//   seed_secp = HMAC-SHA256(recipient_privkey,
//                            "tacit-amm-receipt-secp-v1"
//                            || pool_id || recipient_anchor_outpoint || asset_id)
//   seed_BJJ  = HMAC-SHA256(recipient_privkey,
//                            "tacit-amm-receipt-bjj-v1"
//                            || pool_id || recipient_anchor_outpoint || asset_id)
//   r_out_secp_i = seed_secp mod n_secp
//   r_out_BJJ_i  = seed_BJJ  mod n_BJJ

import { hmac, sha256, hexToBytes, concatBytes } from './vendor/tacit-deps.min.js';
import { SECP_N, modN as modSecp } from './bulletproofs.js';
import { N_BJJ } from './amm-bjj.js';

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

export function canonicalOutpoint(txidHex, vout) {
  const txid_BE = reverseBytes(hexToBytes(txidHex));
  const vout_LE = new Uint8Array(4);
  new DataView(vout_LE.buffer).setUint32(0, vout >>> 0, true);
  return concatBytes(txid_BE, vout_LE);
}

// Counter-extended HMAC fallback for the (statistically impossible) case
// where the base seed reduces to zero modulo the group order. r=0 would
// collapse the Pedersen commitment to amount·H and destroy the hiding
// property. Probability per call is ~2⁻²⁵⁶, but the spec's intent is
// unconditional hiding, so we rejection-sample. Counter starts at 1 so
// the base call (counter implicit = no suffix) is unambiguous.
function _hmacWithCounter(sk, baseMsg, counter) {
  const counterByte = new Uint8Array([counter & 0xff]);
  return hmac(sha256, sk, concatBytes(baseMsg, counterByte));
}

export function deriveReceiptBlinding({
  recipientPrivkey, poolId, anchorOutpoint, assetId,
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

export function deriveLpAddShareBlinding({
  recipientPrivkey, poolId, lpInputAOutpoint, lpAssetId,
}) {
  return deriveReceiptBlinding({
    recipientPrivkey, poolId,
    anchorOutpoint: lpInputAOutpoint, assetId: lpAssetId,
  });
}

export function deriveLpRemoveBlindings({
  recipientPrivkey, poolId, lpShareInputOutpoint, assetIdA, assetIdB,
}) {
  const legA = deriveReceiptBlinding({
    recipientPrivkey, poolId,
    anchorOutpoint: lpShareInputOutpoint, assetId: assetIdA,
  });
  const legB = deriveReceiptBlinding({
    recipientPrivkey, poolId,
    anchorOutpoint: lpShareInputOutpoint, assetId: assetIdB,
  });
  return { legA, legB };
}
