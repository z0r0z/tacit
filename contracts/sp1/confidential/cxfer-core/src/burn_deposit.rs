//! Burn-and-mint onboarding of a pre-existing fixed-supply Bitcoin asset (e.g. TAC): prove a burned note is
//! a REAL unit of the asset's supply WITHOUT a full history scan, via per-bridge provenance back to the etch
//! supply note `C_0`. See ops/DESIGN-trustless-asset-onboarding.md (phase 3).
//!
//! Division of labour (each piece independently tested):
//!   - per-CXFER CRYPTO is the caller's (the fold): inclusion via `bitcoin::verify_merkle_path(..) == a
//!     relay-confirmed block merkle root`, and value+asset conservation via `verify_cxfer_conservation(asset,
//!     ..)`. Passing the ONE `asset` to every conservation check is what preserves the asset down the chain —
//!     a relabel CXFER signed under a different asset fails conservation and never reaches here.
//!   - THIS module is the pure DAG-LINKAGE check — the new, error-prone surface where a value-swapping seam,
//!     a dangling (non-`C_0`) leaf, an in-DAG double-spend, or burning an already-consumed note would
//!     otherwise slip past the per-CXFER crypto. It is crypto-free so it can be tested adversarially in
//!     isolation; the fold composes it OVER the verified CXFERs.

use crate::outpoint_key;

/// One provenance CXFER whose crypto the caller has ALREADY verified (inclusion + conservation, see module
/// doc). Carries only the post-verification SHAPE the linkage needs: the spent inputs (their outpoint + the
/// spent note's commitment hash) and the produced outputs (vout + commitment hash). The commitment hash is
/// `commitment_hash`/`commitment_hash_compressed` of the SAME commitment the caller fed to
/// `verify_cxfer_conservation` — binding VALUE across a link, so a seam that swaps a low-value producing
/// output for a high-value claimed input cannot inflate.
pub struct VerifiedCxfer {
    pub txid: [u8; 32],
    /// `(prev_txid, prev_vout, spent_commitment_hash)` per input.
    pub inputs: Vec<([u8; 32], u32, [u8; 32])>,
    /// `(vout, commitment_hash)` per produced note.
    pub outputs: Vec<(u32, [u8; 32])>,
}

/// Verify the burned note `(burned_outpoint, burned_commitment_hash)` descends from the etch supply note
/// `(c0_outpoint, c0_commitment_hash)` through `cxfers`. Every CXFER input must resolve to EITHER another
/// DAG CXFER's output (same outpoint AND same commitment hash — a value-preserving link) OR the `C_0` leaf;
/// no outpoint may be consumed twice; the burned note must be PRODUCED by the DAG and NOT consumed inside it
/// (it is spent by the later burn tx, not by a child CXFER). Returns false (fold nothing — skip-not-panic)
/// on any violation.
///
/// SOUNDNESS: with the caller's per-CXFER conservation, Σ value is conserved from `C_0` down to the burned
/// note → its value is REAL supply, not a fabricated commitment. Double-bridge / double-use is closed
/// separately by the fold pushing the burned note's ν into the shared nullifier set; the etch `S`-cap is the
/// fold's defence-in-depth. No full history scan: Bitcoin's consensus forbids a leaf note being spent twice,
/// so two conflicting DAGs cannot both be inclusion-proven by the caller.
pub fn verify_provenance_dag(
    c0_outpoint: &[u8; 32],
    c0_commitment_hash: &[u8; 32],
    burned_outpoint: &[u8; 32],
    burned_commitment_hash: &[u8; 32],
    cxfers: &[VerifiedCxfer],
) -> bool {
    if cxfers.is_empty() {
        return false;
    }
    // 1. Index produced outputs (outpoint → commitment hash); a duplicate produced outpoint (two producers
    //    for one note) is rejected.
    let mut produced: Vec<([u8; 32], [u8; 32])> = Vec::new();
    for cx in cxfers {
        if cx.outputs.is_empty() {
            return false;
        }
        for (vout, ch) in &cx.outputs {
            let op = outpoint_key(&cx.txid, *vout);
            if produced.iter().any(|(o, _)| o == &op) {
                return false;
            }
            produced.push((op, *ch));
        }
    }
    // 2. Resolve every input to a produced output (value-matched) or the C_0 leaf; reject an outpoint
    //    consumed twice (an in-DAG double-spend), a dangling input, or a value-swapping seam.
    let mut consumed: Vec<[u8; 32]> = Vec::new();
    for cx in cxfers {
        if cx.inputs.is_empty() {
            return false;
        }
        for (ptxid, pvout, in_ch) in &cx.inputs {
            let op = outpoint_key(ptxid, *pvout);
            if consumed.iter().any(|o| o == &op) {
                return false;
            }
            consumed.push(op);
            let linked = produced.iter().any(|(o, ch)| o == &op && ch == in_ch);
            let is_c0 = &op == c0_outpoint && in_ch == c0_commitment_hash;
            if !linked && !is_c0 {
                return false;
            }
        }
    }
    // 3. The burned note must be produced by the DAG and NOT consumed inside it.
    let produced_burned = produced
        .iter()
        .any(|(o, ch)| o == burned_outpoint && ch == burned_commitment_hash);
    let consumed_burned = consumed.iter().any(|o| o == burned_outpoint);
    produced_burned && !consumed_burned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(txid: u8, vout: u32) -> [u8; 32] {
        outpoint_key(&[txid; 32], vout)
    }
    fn c0_op() -> [u8; 32] {
        op(0x00, 0)
    }
    fn c0_ch() -> [u8; 32] {
        [0xC0; 32]
    }

    #[test]
    fn depth1_distribution_from_c0_is_real() {
        // CXFER A spends C_0, produces the burned note at (A,0)
        let a = VerifiedCxfer {
            txid: [0x0A; 32],
            inputs: vec![([0x00; 32], 0, c0_ch())],
            outputs: vec![(0, [0xAA; 32])],
        };
        assert!(verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[a]));
    }

    #[test]
    fn depth2_chain_is_real() {
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xAA; 32])] };
        let b = VerifiedCxfer { txid: [0x0B; 32], inputs: vec![([0x0A; 32], 0, [0xAA; 32])], outputs: vec![(0, [0xBB; 32])] };
        assert!(verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0B, 0), &[0xBB; 32], &[a, b]));
    }

    #[test]
    fn dangling_input_rejected() {
        // input is neither C_0 nor produced by any DAG CXFER
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x99; 32], 0, [0x55; 32])], outputs: vec![(0, [0xAA; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[a]));
    }

    #[test]
    fn value_swapping_seam_rejected() {
        // B claims to spend A's output but with a DIFFERENT (inflated) commitment hash
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xAA; 32])] };
        let b = VerifiedCxfer { txid: [0x0B; 32], inputs: vec![([0x0A; 32], 0, [0xFF; 32])], outputs: vec![(0, [0xBB; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0B, 0), &[0xBB; 32], &[a, b]));
    }

    #[test]
    fn double_spend_within_dag_rejected() {
        // two CXFERs both spend C_0
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xAA; 32])] };
        let b = VerifiedCxfer { txid: [0x0B; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xBB; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[a, b]));
    }

    #[test]
    fn burned_note_must_be_produced() {
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xAA; 32])] };
        // a burned note no CXFER produced
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xDD; 32], &[a]));
    }

    #[test]
    fn burned_note_consumed_in_dag_rejected() {
        // the "burned" note (A,0) is actually spent by B inside the DAG → not a live note to burn
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xAA; 32])] };
        let b = VerifiedCxfer { txid: [0x0B; 32], inputs: vec![([0x0A; 32], 0, [0xAA; 32])], outputs: vec![(0, [0xBB; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[a, b]));
    }

    #[test]
    fn wrong_c0_commitment_rejected() {
        // input claims the C_0 outpoint but a fabricated commitment hash (a made-up supply value)
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, [0x11; 32])], outputs: vec![(0, [0xAA; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[a]));
    }

    #[test]
    fn empty_dag_rejected() {
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[]));
    }
}
