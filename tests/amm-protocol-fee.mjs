// Protocol-fee mechanics for tacit AMM (founder-set, immutable).
//
// Mirrors AMM.md §"Protocol fee mechanism". The pool optionally pins a
// `protocol_fee_address` (33-byte compressed pubkey) and `protocol_fee_bps`
// (u16, 0..1000 = 0..10% of LP-fee growth) at POOL_INIT.
//
// If `protocol_fee_address` is all-zeros, the pool has no protocol fee and
// `protocol_fee_bps` must also be zero (rejected at envelope decode).
//
// Accrual model is **Uniswap V2 lazy**: protocol fee is crystallized into
// `protocol_fee_accrued` (an LP-share counter held by the pool's internal
// state — NO chain-side UTXO until claimed) at every LP event (LP_ADD,
// LP_REMOVE) and at PROTOCOL_FEE_CLAIM time. T_SWAP_BATCH does NOT
// crystallize (the fee accrues "virtually" between fee events).
//
// State fields the validator maintains in pool:
//   protocol_fee_address    : 33-byte compressed pubkey, all-zeros = disabled
//   protocol_fee_bps        : u16, 0..1000
//   protocol_fee_accrued    : bigint LP-shares owed to the address
//   k_last                  : bigint (R_A · R_B snapshot at last fee event)
//
// Forward compatibility: the founder picks the address at POOL_INIT. It can
// be any 33-byte pubkey (own wallet, TAC treasury, multisig, burn address).
// Choice is immutable for the pool's lifetime — V1 pools without protocol
// fees can never have them added retroactively.

import { isqrt } from './amm-clearing.mjs';

const BPS_DEN = 10000n;
const PROTOCOL_FEE_BPS_MAX = 1000n; // 10% of LP-fee growth

export function isZeroAddress(addr) {
  if (!(addr instanceof Uint8Array) || addr.length !== 33) return false;
  for (let i = 0; i < 33; i++) if (addr[i] !== 0) return false;
  return true;
}

// Compute the protocol's share-mint amount for the period since k_last,
// given current pool product k_now = R_A · R_B.
//
// Formula (Uniswap V2 mintFee, integerized):
//   if k_now <= k_last: return 0
//   rootK_pre  = isqrt(k_last)
//   rootK_now  = isqrt(k_now)
//   numerator   = S · bps · (rootK_now − rootK_pre)
//   denominator = (10000 − bps) · rootK_now + bps · rootK_pre
//   protocol_shares = floor(numerator / denominator)
//
// Properties:
//   * protocol_shares / (S + protocol_shares) == bps/10000 · (rootK_now − rootK_pre) / rootK_now
//     i.e., the protocol gets `bps` basis-points of the LP-share value growth.
//   * Existing LPs are diluted by exactly that fraction; the pool's bookkeeping
//     stays internally consistent (sum of share values = pool value).
//   * If bps == 0 or k_now <= k_last, returns 0 (no-op).
export function computeProtocolShares({ S_pre, k_pre, k_now, protocol_fee_bps }) {
  const S = BigInt(S_pre);
  const kPre = BigInt(k_pre);
  const kNow = BigInt(k_now);
  const bps = BigInt(protocol_fee_bps);
  if (bps < 0n || bps > PROTOCOL_FEE_BPS_MAX) {
    throw new Error(`protocol_fee_bps out of range: ${bps}`);
  }
  if (bps === 0n) return 0n;
  if (kNow <= kPre) return 0n;
  if (S === 0n) return 0n;
  const rootPre = isqrt(kPre);
  const rootNow = isqrt(kNow);
  if (rootNow <= rootPre) return 0n;
  const numerator   = S * bps * (rootNow - rootPre);
  const denominator = (BPS_DEN - bps) * rootNow + bps * rootPre;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

// Crystallize protocol fee accrual on a pool state. Returns updated pool
// object (immutable update — caller swaps in the result). No-op if the pool
// has no protocol fee enabled, or if k has not grown since last crystallization.
//
// Mutations:
//   pool.protocol_fee_accrued += newly accrued shares
//   pool.lp_total_shares      += newly accrued shares   (dilutes existing LPs)
//   pool.k_last                = R_A · R_B              (new baseline)
//
// Note: lp_total_shares grows so that the protocol_fee_accrued is "minted"
// into the pool's share supply, matching V2 semantics where mintFee dilutes
// LPs. The actual UTXO for the protocol address isn't emitted until
// T_PROTOCOL_FEE_CLAIM; until then `protocol_fee_accrued` is a virtual claim.
export function crystallizeProtocolFee(pool) {
  if (!pool) return pool;
  if (!pool.protocol_fee_address || isZeroAddress(pool.protocol_fee_address)) return pool;
  if (!pool.protocol_fee_bps || pool.protocol_fee_bps === 0) return pool;
  const k_now = pool.reserve_A * pool.reserve_B;
  const k_pre = pool.k_last || 0n;
  if (k_now <= k_pre) {
    // No growth (or first call). Still set k_last for the baseline.
    return { ...pool, k_last: k_now };
  }
  const newShares = computeProtocolShares({
    S_pre: pool.lp_total_shares,
    k_pre,
    k_now,
    protocol_fee_bps: pool.protocol_fee_bps,
  });
  return {
    ...pool,
    protocol_fee_accrued: (pool.protocol_fee_accrued || 0n) + newShares,
    lp_total_shares: pool.lp_total_shares + newShares,
    k_last: k_now,
  };
}

// Build the canonical claim_msg for T_PROTOCOL_FEE_CLAIM BIP-340 signature.
// Domain-separated with the `-v1` suffix for forward compatibility.
//
//   claim_msg = SHA256(
//       "tacit-amm-protocol-fee-claim-v1"
//       || pool_id(32)
//       || claim_amount_LE(8)
//       || claim_C_secp(33)
//       || claim_blinding(32)
//   )
export function buildProtocolFeeClaimMsg({ poolId, claimAmount, claimCSecp, claimBlinding }) {
  // Delegate to a SHA-256 hasher; built inline to avoid extra imports.
  // Callers in the validator already have sha256 available.
  throw new Error('use buildProtocolFeeClaimMsgWith(sha256) — caller supplies hasher');
}

// Hasher-injected variant. Validator calls this with `sha256` from
// @noble/hashes to avoid duplicating the import in this module.
export function buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount, claimCSecp, claimBlinding }) {
  if (!(poolId instanceof Uint8Array) || poolId.length !== 32) throw new Error('poolId must be 32 bytes');
  if (!(claimCSecp instanceof Uint8Array) || claimCSecp.length !== 33) throw new Error('claimCSecp must be 33 bytes');
  if (!(claimBlinding instanceof Uint8Array) || claimBlinding.length !== 32) throw new Error('claimBlinding must be 32 bytes');
  const tag = new TextEncoder().encode('tacit-amm-protocol-fee-claim-v1');
  const amtLE = new Uint8Array(8);
  let x = BigInt(claimAmount);
  if (x < 0n || x >= 1n << 64n) throw new Error('claimAmount u64 overflow');
  for (let i = 0; i < 8; i++) { amtLE[i] = Number(x & 0xffn); x >>= 8n; }
  const buf = new Uint8Array(tag.length + 32 + 8 + 33 + 32);
  let off = 0;
  buf.set(tag, off); off += tag.length;
  buf.set(poolId, off); off += 32;
  buf.set(amtLE, off); off += 8;
  buf.set(claimCSecp, off); off += 33;
  buf.set(claimBlinding, off); off += 32;
  return sha256(buf);
}
