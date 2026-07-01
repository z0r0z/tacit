//! OP_SWAP_BLIND (31 / 0x1F) — prover-blind confidential AMM batch on the EVM settle lane.
//!
//! The settle-side twin of the reflection `swap_batch::fold_swap_batch`: the SP1 box never reads a
//! cleartext swap amount. Correctness rests on the SAME three box-validated layers as `swap_batch`:
//!   - `groth16::groth16_bn254_verify` over the re-derived 123 public signals (per-receipt uniform
//!     clearing + in-circuit output range — `amm_swap_batch.circom`);
//!   - `swap_batch_aggregate_identity` per asset (binds the receipts' total to the real spent inputs
//!     + the public net delta + the tip);
//!   - `babyjubjub::verify_xcurve` per receipt (the onboarded secp note's hidden value == the
//!     Groth16-proven BJJ value).
//!
//! This module is the PURE clearing-validation half (no settle locals, no I/O): it re-derives the
//! signals, verifies the proof + tip openings + aggregate identity, and returns the post-reserves.
//! The per-intent INPUT authorization that `swap_batch` omits — because Bitcoin tx signatures cover
//! it and the EVM has none — is enforced by the dispatch arm in `main.rs` (membership + nullifier +
//! the input cross-curve sigma + `verify_opening_pok_blind` binding out_owner/min_out/direction).
//! See ops/DESIGN-op-swap-blind.md.

use cxfer_core::{
    bitcoin::SwapBatchEnvelope, decompress, scalar_reduce_be, swap_batch_aggregate_identity,
    verify_pedersen_opening,
};

/// Apply a signed delta to a reserve (sign 0 = grow, 1 = shrink), saturating-checked.
fn apply_signed(reserve: u64, sign: u8, mag: u64) -> Option<u64> {
    if sign == 0 {
        reserve.checked_add(mag)
    } else {
        reserve.checked_sub(mag)
    }
}

/// Validate a prover-blind AMM batch's CLEARING against the pool's pre-reserves and return the
/// post-reserves `(new_a, new_b)`. Mirrors `swap_batch::fold_swap_batch` steps 2–8 + the per-receipt
/// cross-curve check, with the Bitcoin one-to-one spend matcher REMOVED (the settle membership +
/// nullifier loop in the dispatch arm supplies that property). Returns `None` (fail-closed) on any
/// check miss. Pure: no state mutation, no witness reads.
///
/// `env` carries the batch's public clearing data (deltas, tips, fee tier, the per-intent BJJ
/// commitments + secp commitments + min_out, the per-receipt secp/BJJ + xcurve sigma, the Groth16
/// proof). `reserve_a_pre`/`reserve_b_pre` are the pool's live reserves (the dispatch arm pins them
/// == the proven pre on-chain via SwapSettlement).
pub fn verify_clearing(
    env: &SwapBatchEnvelope,
    pool_id: &[u8; 32],
    reserve_a_pre: u64,
    reserve_b_pre: u64,
) -> Option<(u64, u64)> {
    if env.intents.len() != env.n_intents || env.receipts.len() != env.n_intents {
        return None;
    }
    if env.fee_bps > 1000 {
        return None; // MAX_POOL_FEE_BPS — reject an invalid fee tier
    }

    // 1. Post-reserves up front (catch an over-draw before trusting anything else).
    let new_a = apply_signed(reserve_a_pre, env.delta_a_net_sign, env.delta_a_net_mag)?;
    let new_b = apply_signed(reserve_b_pre, env.delta_b_net_sign, env.delta_b_net_mag)?;
    // Post-reserves stay positive and never shrink the constant product. The circuit constrains
    // per-trader fills against the declared clearing price but enforces the k-curve OUT of circuit,
    // so k_post >= k_pre is enforced HERE (mirrors swap_batch.rs + the EVM OP_SWAP settlement).
    if new_a == 0 || new_b == 0 {
        return None;
    }
    if (new_a as u128) * (new_b as u128) < (reserve_a_pre as u128) * (reserve_b_pre as u128) {
        return None;
    }

    // 2. Groth16 verify (per-receipt split + in-circuit output range) over the re-derived signals.
    //    Reuses the reflection module's validated derivation verbatim (the SAME 123-signal order the
    //    circom main declares) and the SAME baked ceremony verifying key.
    let pubs = crate::swap_batch::swap_batch_public_signals(env, pool_id, reserve_a_pre, reserve_b_pre)?;
    let proof = crate::swap_batch::parse_g16_proof(&env.proof)?;
    if !crate::groth16::groth16_bn254_verify(&crate::groth16::batch_vk(), &proof, &pubs) {
        return None;
    }

    // 3. Bind each tip commitment to its Groth16-public tip amount before its blinding enters R_net.
    let tip_a = decompress(&env.tip_a_c_secp)?;
    let tip_b = decompress(&env.tip_b_c_secp)?;
    if !verify_pedersen_opening(&tip_a, env.tip_a_amount, &scalar_reduce_be(&env.r_tip_a))
        || !verify_pedersen_opening(&tip_b, env.tip_b_amount, &scalar_reduce_be(&env.r_tip_b))
    {
        return None;
    }

    // 4. Aggregate Pedersen identity per asset (binds the receipts' total to the real spent inputs +
    //    public net delta + tip). The spent inputs are the membership-proven notes the dispatch arm
    //    nullified; here C_in_secp must equal those (the arm asserts identity by reusing the same
    //    commitment for membership + this aggregate).
    let intents_secp: Vec<(u8, [u8; 33])> =
        env.intents.iter().map(|it| (it.direction, it.c_in_secp)).collect();
    let receipts_secp: Vec<[u8; 33]> = env.receipts.iter().map(|r| r.c_out_secp).collect();
    if !swap_batch_aggregate_identity(
        &intents_secp, &receipts_secp, true,
        env.delta_a_net_sign, env.delta_a_net_mag, &env.tip_a_c_secp, &env.r_net_a,
    ) {
        return None;
    }
    if !swap_batch_aggregate_identity(
        &intents_secp, &receipts_secp, false,
        env.delta_b_net_sign, env.delta_b_net_mag, &env.tip_b_c_secp, &env.r_net_b,
    ) {
        return None;
    }

    // 5. Per receipt: cross-curve sigma binds C_out_secp <-> C_out_BJJ (the onboarded secp note's
    //    hidden value == the Groth16-proven cleared amount).
    for r in env.receipts.iter() {
        if !crate::babyjubjub::verify_xcurve(&r.out_xcurve_sigma, &r.c_out_secp, &r.c_out_bjj) {
            return None;
        }
    }

    Some((new_a, new_b))
}
