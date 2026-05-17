// MINIMUM_LIQUIDITY locked LP-share construction — dapp-side port of
// tests/amm-min-liq.mjs. Byte-for-byte identical math.
//
// At POOL_INIT, the founder receives isqrt(Δa·Δb) − MINIMUM_LIQUIDITY shares
// and the protocol locks the remaining MINIMUM_LIQUIDITY in a provably
// unspendable output at vout[1]. NUMS recipient (no known privkey) ensures
// the lock is permanent.

import { secp, sha256, ripemd160, hmac, hexToBytes, bytesToHex, concatBytes } from './vendor/tacit-deps.min.js';
import {
  G, H, ZERO, SECP_N, SECP_P, modN,
  pedersenCommit, pointToBytes, bigintToBytes32, bytes32ToBigint,
} from './bulletproofs.js';

export const MINIMUM_LIQUIDITY = 1000n;

const DOMAIN_BLIND  = new TextEncoder().encode('tacit-amm-min-liq-blind-v1');
const DOMAIN_KS     = new TextEncoder().encode('tacit-amm-min-liq-ks-v1');
const DOMAIN_PUBKEY = new TextEncoder().encode('tacit-amm-min-liq-pubkey-v1');

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

export function deriveMinLiqBlinding(poolId) {
  const pid = asBytes32(poolId, 'poolId');
  const seed = sha256(concatBytes(DOMAIN_BLIND, pid));
  return modN(bytes32ToBigint(seed));
}

export function deriveMinLiqCommitment(poolId) {
  const r = deriveMinLiqBlinding(poolId);
  return pedersenCommit(MINIMUM_LIQUIDITY, r);
}

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
      const p2wpkh = hash160(candidate);
      return { xOnly: xHash, counter, point, p2wpkh };
    } catch { /* invalid x — try next counter */ }
  }
  throw new Error('NUMS recipient derivation exhausted');
}

// Newton's-method integer square root (BigInt). Self-contained.
export function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x = n, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}

// LP_ADD initial founder + locked shares per Uniswap V2 convention.
//   total = isqrt(deltaA · deltaB)
//   locked = MINIMUM_LIQUIDITY = 1000
//   founder = total − locked
// Throws if total ≤ locked (founder would receive ≤ 0 shares).
export function lpInitShares(deltaA, deltaB) {
  const da = BigInt(deltaA), db = BigInt(deltaB);
  if (da <= 0n || db <= 0n) throw new Error('deltaA and deltaB must be positive');
  const total = isqrt(da * db);
  if (total <= MINIMUM_LIQUIDITY) {
    throw new Error('initial liquidity below MINIMUM_LIQUIDITY (Δa·Δb too small)');
  }
  return {
    total_shares: total,
    locked_shares: MINIMUM_LIQUIDITY,
    founder_shares: total - MINIMUM_LIQUIDITY,
  };
}

export const MIN_LIQ_LOCK_BPS_WARN = 100n;
export const MIN_LIQ_LOCK_BPS_HIGH = 1000n;

export function assessMinLiqLockFraction(deltaA, deltaB) {
  const da = BigInt(deltaA), db = BigInt(deltaB);
  if (da <= 0n || db <= 0n) throw new Error('deltaA and deltaB must be positive');
  const total = isqrt(da * db);
  if (total <= MINIMUM_LIQUIDITY) {
    return {
      total_shares: total, locked_shares: MINIMUM_LIQUIDITY,
      founder_shares: 0n, locked_bps: 10000n, severity: 'reject',
    };
  }
  const founder = total - MINIMUM_LIQUIDITY;
  const lockedBps = (10000n * MINIMUM_LIQUIDITY) / total;
  let severity;
  if (lockedBps >= MIN_LIQ_LOCK_BPS_HIGH)      severity = 'high';
  else if (lockedBps >= MIN_LIQ_LOCK_BPS_WARN) severity = 'warn';
  else                                          severity = 'ok';
  return {
    total_shares: total, locked_shares: MINIMUM_LIQUIDITY,
    founder_shares: founder, locked_bps: lockedBps, severity,
  };
}

export function verifyMinLiqOutput({ poolId, onChainCommit, onChainAmtCt, onChainP2wpkh }) {
  const expectedC = deriveMinLiqCommitment(poolId);
  const expectedCBytes = pointToBytes(expectedC);
  const onChainBytes = onChainCommit instanceof Uint8Array
    ? onChainCommit
    : (typeof onChainCommit === 'string' ? hexToBytes(onChainCommit) : pointToBytes(onChainCommit));
  if (!bytesEqual(expectedCBytes, onChainBytes)) return false;
  const expectedCt = deriveMinLiqAmountCt(poolId);
  if (!bytesEqual(expectedCt, onChainAmtCt)) return false;
  const { p2wpkh } = deriveMinLiqNumsRecipient(poolId);
  if (!bytesEqual(p2wpkh, onChainP2wpkh)) return false;
  const decrypted = decryptMinLiqAmount(onChainAmtCt, poolId);
  if (decrypted !== MINIMUM_LIQUIDITY) return false;
  return true;
}
