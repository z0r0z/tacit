// MINIMUM_LIQUIDITY locked LP-share construction per AMM.md §"MINIMUM_LIQUIDITY
// burn-output construction".
//
// At POOL_INIT, the founder receives `isqrt(Δa·Δb) − MINIMUM_LIQUIDITY` shares
// and the protocol locks the remaining MINIMUM_LIQUIDITY in a provably
// unspendable output at vout[1] of the POOL_INIT reveal tx. The output is a
// tacit UTXO of lp_asset_id whose:
//
//   (a) Pedersen commitment opens to exactly MINIMUM_LIQUIDITY with a
//       deterministic blinding anyone can recompute from pool_id:
//
//         r_burn    = SHA256("tacit-amm-min-liq-blind-v1" || pool_id) mod n_secp
//         C_min_liq = MINIMUM_LIQUIDITY · H_secp + r_burn · G_secp
//
//   (b) recipient pubkey is NUMS (no known privkey), so the locked share can
//       never be CXFER'd or T_DEPOSITed elsewhere:
//
//         NUMS_recipient = try-and-increment under domain
//                          "tacit-amm-min-liq-pubkey-v1" || pool_id
//
//       The P2WPKH output script pays HASH160(0x02 || NUMS_recipient_x).
//
//   (c) encrypted amount field, present for UTXO-format consistency
//       (MINIMUM_LIQUIDITY is publicly known so encryption hides nothing):
//
//         keystream_seed = SHA256("tacit-amm-min-liq-ks-v1" || pool_id)
//         envelope_anchor = pool_id || (1)_LE(4)   // vout=1 is always the locked output
//         amount_ct = u64_LE(MINIMUM_LIQUIDITY) XOR HMAC-SHA256(
//                       keystream_seed, envelope_anchor)[:8]
//
// MINIMUM_LIQUIDITY is fixed at 1000 base units (Uniswap V2 convention).

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, bigintToBytes32, bytes32ToBigint,
} from './bulletproofs.mjs';

export const MINIMUM_LIQUIDITY = 1000n;

const DOMAIN_BLIND  = new TextEncoder().encode('tacit-amm-min-liq-blind-v1');
const DOMAIN_KS     = new TextEncoder().encode('tacit-amm-min-liq-ks-v1');
const DOMAIN_PUBKEY = new TextEncoder().encode('tacit-amm-min-liq-pubkey-v1');

// Secp256k1 prime (for x-coordinate validity check).
const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

const hash160 = (b) => ripemd160(sha256(b));

function asBytes32(x, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return b;
}
function u32LE(n) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n >>> 0, true);
  return buf;
}
function u64LE(n) {
  const buf = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// r_burn = SHA256("tacit-amm-min-liq-blind-v1" || pool_id) mod n_secp
export function deriveMinLiqBlinding(poolId) {
  const pid = asBytes32(poolId, 'poolId');
  const seed = sha256(concatBytes(DOMAIN_BLIND, pid));
  return modN(bytes32ToBigint(seed));
}

// C_min_liq = MINIMUM_LIQUIDITY · H_secp + r_burn · G_secp
export function deriveMinLiqCommitment(poolId) {
  const r = deriveMinLiqBlinding(poolId);
  return pedersenCommit(MINIMUM_LIQUIDITY, r);
}

// Encrypted-amount field for the locked output (for UTXO-format consistency).
// envelope_anchor = pool_id(32) || vout_LE(4)  with vout = 1 (fixed for POOL_INIT).
export function deriveMinLiqAmountCt(poolId) {
  const pid = asBytes32(poolId, 'poolId');
  const seed = sha256(concatBytes(DOMAIN_KS, pid));
  const anchor = concatBytes(pid, u32LE(1));
  const ks = hmac(sha256, seed, anchor).subarray(0, 8);
  const amtLE = u64LE(MINIMUM_LIQUIDITY);
  const ct = new Uint8Array(8);
  for (let i = 0; i < 8; i++) ct[i] = amtLE[i] ^ ks[i];
  return ct;
}

// Inverse: decrypt amount_ct → recover MINIMUM_LIQUIDITY (= 1000n) given pool_id.
// Anyone can run this; the result MUST equal MINIMUM_LIQUIDITY or the locked
// output is malformed and the POOL_INIT is invalid.
export function decryptMinLiqAmount(amountCt, poolId) {
  const pid = asBytes32(poolId, 'poolId');
  if (amountCt.length !== 8) throw new Error('amount_ct must be 8 bytes');
  const seed = sha256(concatBytes(DOMAIN_KS, pid));
  const anchor = concatBytes(pid, u32LE(1));
  const ks = hmac(sha256, seed, anchor).subarray(0, 8);
  let amt = 0n;
  for (let i = 7; i >= 0; i--) {
    amt = (amt << 8n) | BigInt(amountCt[i] ^ ks[i]);
  }
  return amt;
}

// NUMS recipient pubkey via try-and-increment, same pattern as SPEC §3.1's H.
//   digest = SHA256("tacit-amm-min-liq-pubkey-v1" || pool_id || counter_u8)
//   candidate = 0x02 || digest    (x-only with implicit even-y prefix)
//   accept if it parses as a valid secp256k1 point ≠ identity
//
// Returns { xOnly: 32-byte Uint8Array, counter, point: ProjectivePoint, p2wpkh: 20-byte HASH160 }.
export function deriveMinLiqNumsRecipient(poolId, maxCounter = 256) {
  const pid = asBytes32(poolId, 'poolId');
  for (let counter = 0; counter < maxCounter; counter++) {
    const ctrByte = new Uint8Array([counter & 0xff]);
    const xHash = sha256(concatBytes(DOMAIN_PUBKEY, pid, ctrByte));
    const xBig = bytes32ToBigint(xHash);
    if (xBig >= SECP_P) continue;
    const candidate = concatBytes(new Uint8Array([0x02]), xHash);
    try {
      const point = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (point.equals(ZERO)) continue;
      // P2WPKH script: OP_0 <20-byte HASH160 of 33-byte compressed pubkey>
      // The 33-byte compressed form is 0x02 || x (even-y prefix).
      const p2wpkh = hash160(candidate);
      return { xOnly: xHash, counter, point, p2wpkh };
    } catch { /* invalid x — try next counter */ }
  }
  throw new Error('NUMS recipient derivation exhausted');
}

// Verify a complete MINIMUM_LIQUIDITY locked-output construction.
//
// Inputs:
//   poolId         — the canonical pool_id
//   onChainCommit  — the on-chain C_min_liq Pedersen commitment (33-byte
//                    compressed or ProjectivePoint)
//   onChainAmtCt   — the on-chain encrypted-amount field (8 bytes)
//   onChainP2wpkh  — the 20-byte HASH160 from the P2WPKH output script
//
// Returns true iff all three derivations match the on-chain values.
export function verifyMinLiqOutput({ poolId, onChainCommit, onChainAmtCt, onChainP2wpkh }) {
  const expectedC = deriveMinLiqCommitment(poolId);
  const expectedCBytes = pointToBytes(expectedC);
  const onChainBytes = onChainCommit instanceof Uint8Array
    ? onChainCommit
    : (typeof onChainCommit === 'string'
        ? hexToBytes(onChainCommit)
        : pointToBytes(onChainCommit));
  if (!bytesEqual(expectedCBytes, onChainBytes)) return false;

  const expectedCt = deriveMinLiqAmountCt(poolId);
  if (!bytesEqual(expectedCt, onChainAmtCt)) return false;

  const { p2wpkh } = deriveMinLiqNumsRecipient(poolId);
  if (!bytesEqual(p2wpkh, onChainP2wpkh)) return false;

  // Sanity: decrypted amount matches MINIMUM_LIQUIDITY.
  const decrypted = decryptMinLiqAmount(onChainAmtCt, poolId);
  if (decrypted !== MINIMUM_LIQUIDITY) return false;

  return true;
}
