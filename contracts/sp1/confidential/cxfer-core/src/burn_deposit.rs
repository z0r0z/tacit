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

use crate::bitcoin::{self, verify_merkle_path};
use crate::{
    bip340_verify, commitment_hash_compressed, decompress, outpoint_key, verify_cxfer_conservation,
    verify_range, Point,
};

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
    verify_provenance_dag_leaves(
        &[(*c0_outpoint, *c0_commitment_hash)],
        burned_outpoint,
        burned_commitment_hash,
        cxfers,
    )
}

/// Generalized DAG check admitting MULTIPLE valid supply leaves `(outpoint, commitment_hash)`. For a
/// MINTABLE asset the leaves are the etch supply note `C_0` PLUS each issuer-authorized cmint output — every
/// leaf verified by the caller (`C_0` via `verify_etch_anchor`; each cmint via `verify_cmint_authorized`,
/// whose issuer signature binds the commit anchor so a re-wrapped mint envelope can't double-issue). A
/// fixed-supply asset passes the single leaf `[(C_0, …)]`. Every CXFER input must resolve to a produced
/// output (value-matched) or one of `valid_leaves`; same dedup / value-seam / sink invariants as the
/// single-leaf form.
pub fn verify_provenance_dag_leaves(
    valid_leaves: &[([u8; 32], [u8; 32])],
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
    // 2. Resolve every input to a produced output (value-matched) or a valid supply leaf; reject an outpoint
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
            let is_leaf = valid_leaves.iter().any(|(o, ch)| &op == o && in_ch == ch);
            if !linked && !is_leaf {
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

/// One provenance CXFER plus the witnesses to verify its crypto: compressed input/output commitments, the
/// conservation kernel + range proof, and a merkle inclusion path to a CONFIRMED block merkle root. The
/// caller (the fold, in reflect.rs) supplies `confirmed_block_root` from the reflection's own relay-anchored
/// header sync — `verify_provenance` only checks the tx folds into THAT root, it does not itself validate PoW.
pub struct ProvenanceWitness {
    pub txid: [u8; 32],
    pub input_outpoints: Vec<([u8; 32], u32)>,
    pub input_commitments: Vec<[u8; 33]>,  // compressed; decompressed for conservation
    pub output_commitments: Vec<[u8; 33]>, // compressed
    pub output_vouts: Vec<u32>,
    pub range_proof: Vec<u8>,
    pub kernel_sig: [u8; 64],
    pub merkle_siblings: Vec<[u8; 32]>,
    pub merkle_index: u32,
    pub confirmed_block_root: [u8; 32],
}

/// Verify a burned note descends from the etch supply note `C_0` through `cxfers` — the full per-bridge
/// realness, scan-free. For each CXFER: (1) inclusion — `verify_merkle_path == confirmed_block_root`; (2)
/// conservation — `verify_cxfer_conservation(asset, ..)` (value AND asset, bound to the ONE `asset`, so a
/// relabel CXFER signed under a different asset fails here). The verified CXFERs are then reduced to their
/// linkage shape (commitment hashes from the SAME commitments fed to conservation, so a value-swapping seam
/// can't open) and checked by `verify_provenance_dag`. Returns `Err` (fold nothing — skip-not-panic) on the
/// first failure. The caller then records ν (`fold_spent` + `fold_burn`) and applies the `S`-cap.
pub fn verify_provenance(
    asset: &[u8; 32],
    c0_outpoint: &[u8; 32],
    c0_commitment_hash: &[u8; 32],
    burned_outpoint: &[u8; 32],
    burned_commitment_hash: &[u8; 32],
    cxfers: &[ProvenanceWitness],
) -> Result<(), &'static str> {
    verify_provenance_leaves(
        asset,
        &[(*c0_outpoint, *c0_commitment_hash)],
        burned_outpoint,
        burned_commitment_hash,
        cxfers,
    )
}

/// MINTABLE form: the burned note may descend from ANY of `valid_leaves` — the etch supply note `C_0` PLUS
/// each issuer-authorized cmint output. The caller verifies each leaf (`C_0` via `verify_etch_anchor`; each
/// cmint via `verify_cmint_authorized`, whose issuer signature is bound to the mint's commit anchor so a
/// re-wrapped mint envelope cannot double-issue). Per-CXFER crypto is identical to the fixed-supply form.
pub fn verify_provenance_leaves(
    asset: &[u8; 32],
    valid_leaves: &[([u8; 32], [u8; 32])],
    burned_outpoint: &[u8; 32],
    burned_commitment_hash: &[u8; 32],
    cxfers: &[ProvenanceWitness],
) -> Result<(), &'static str> {
    if cxfers.is_empty() {
        return Err("burn-deposit: empty provenance");
    }
    let verified = verify_cxfers(asset, cxfers)?;
    if !verify_provenance_dag_leaves(valid_leaves, burned_outpoint, burned_commitment_hash, &verified) {
        return Err("burn-deposit: burned note does not descend from a valid supply leaf");
    }
    Ok(())
}

/// Per-CXFER crypto (inclusion + conservation) → the linkage-shape `VerifiedCxfer`s. Shared by the
/// fixed-supply (`verify_provenance`) and mintable (`verify_provenance_leaves`) forms.
fn verify_cxfers(asset: &[u8; 32], cxfers: &[ProvenanceWitness]) -> Result<Vec<VerifiedCxfer>, &'static str> {
    let mut verified: Vec<VerifiedCxfer> = Vec::with_capacity(cxfers.len());
    for cx in cxfers {
        if cx.input_commitments.len() != cx.input_outpoints.len() {
            return Err("burn-deposit: input outpoint/commitment length mismatch");
        }
        if cx.output_commitments.len() != cx.output_vouts.len() {
            return Err("burn-deposit: output commitment/vout length mismatch");
        }
        // 1. Inclusion: the tx folds into the caller-confirmed (relay-anchored) block merkle root.
        if verify_merkle_path(&cx.txid, &cx.merkle_siblings, cx.merkle_index) != cx.confirmed_block_root {
            return Err("burn-deposit: provenance cxfer not in the confirmed block");
        }
        // 2. Conservation: value + asset, bound to the ONE asset.
        let mut input_points: Vec<Point> = Vec::with_capacity(cx.input_commitments.len());
        for c in &cx.input_commitments {
            input_points.push(decompress(c).ok_or("burn-deposit: input commitment not a curve point")?);
        }
        if !verify_cxfer_conservation(
            asset,
            &cx.input_outpoints,
            &input_points,
            &cx.output_commitments,
            &cx.range_proof,
            &cx.kernel_sig,
        ) {
            return Err("burn-deposit: provenance cxfer does not conserve value/asset");
        }
        // 3. Reduce to the linkage shape — commitment hashes derived from the SAME commitments conservation
        //    just verified, so a link can't swap a low-value producing output for a high-value claimed input.
        let mut inputs = Vec::with_capacity(cx.input_outpoints.len());
        for (i, (txid, vout)) in cx.input_outpoints.iter().enumerate() {
            let ch = commitment_hash_compressed(&cx.input_commitments[i])
                .ok_or("burn-deposit: input commitment not a curve point")?;
            inputs.push((*txid, *vout, ch));
        }
        let mut outputs = Vec::with_capacity(cx.output_commitments.len());
        for (i, c) in cx.output_commitments.iter().enumerate() {
            let ch = commitment_hash_compressed(c).ok_or("burn-deposit: output commitment not a curve point")?;
            outputs.push((cx.output_vouts[i], ch));
        }
        verified.push(VerifiedCxfer { txid: cx.txid, inputs, outputs });
    }
    Ok(verified)
}

/// Domain for the issuer-authorized-mint signature message (mintable assets, §6.1).
pub const CMINT_DOMAIN: &[u8] = b"tacit-cmint-v1";

/// Verify a `T_MINT` (0x24) is an AUTHORIZED supply leaf for a MINTABLE asset → `(leaf_outpoint,
/// leaf_commitment_hash)` for `valid_leaves`, or None. Checks:
///  - mintable: `mint_authority != 0` (the x-only issuer key from the etch; a fixed-supply asset has none);
///  - asset-bound: the reveal's `T_MINT` envelope declares THIS `asset`;
///  - commit/reveal pair: the reveal spends the `commit_tx`;
///  - **authorized + non-re-wrappable:** BIP-340 verify of the issuer signature under `mint_authority` over
///    `sha256(CMINT_DOMAIN ‖ asset ‖ commitment ‖ commit_anchor)`, where `commit_anchor` is the COMMIT tx's
///    first input outpoint — so one signature can't be re-wrapped into another commit/reveal pair (which
///    would mint the same authorization twice);
///  - range: the minted commitment is BP+ range-bounded to [0, 2⁶⁴).
/// The leaf note is the reveal's vout-0 commitment. The CALLER confirms the reveal + commit txs are real
/// on-chain (header+merkle), exactly as for the provenance cxfers. Returns None (admit nothing) on any miss.
pub fn verify_cmint_authorized(
    asset: &[u8; 32],
    mint_authority: &[u8; 32],
    reveal_tx: &[u8],
    commit_tx: &[u8],
) -> Option<([u8; 32], [u8; 32])> {
    if mint_authority.iter().all(|&b| b == 0) {
        return None; // not mintable — no authorized mints exist
    }
    let env = bitcoin::extract_taproot_envelope(reveal_tx)?;
    let (mint_asset, _etch_txid, commitment, range_proof, issuer_sig) = bitcoin::parse_cmint(&env)?;
    if &mint_asset != asset {
        return None;
    }
    // commit/reveal pair: the reveal's first input spends the commit tx.
    let commit_txid = bitcoin::compute_txid(commit_tx)?;
    if bitcoin::extract_inputs(reveal_tx)?.first()?.0 != commit_txid {
        return None;
    }
    // commit_anchor = the commit tx's first input outpoint (binds the signature to THIS pair → no re-wrap).
    let (anchor_txid, anchor_vout) = *bitcoin::extract_inputs(commit_tx)?.first()?;
    let mut pre = Vec::with_capacity(CMINT_DOMAIN.len() + 32 + 33 + 32 + 4);
    pre.extend_from_slice(CMINT_DOMAIN);
    pre.extend_from_slice(asset);
    pre.extend_from_slice(&commitment);
    pre.extend_from_slice(&anchor_txid);
    pre.extend_from_slice(&anchor_vout.to_le_bytes());
    let mint_msg = bitcoin::sha256_once(&pre);
    if !bip340_verify(&issuer_sig, &mint_msg, mint_authority) {
        return None;
    }
    // the minted note is range-bounded.
    let c = decompress(&commitment)?;
    if !verify_range(&[c], range_proof) {
        return None;
    }
    // the supply leaf: the minted note at the reveal's vout 0.
    let reveal_txid = bitcoin::compute_txid(reveal_tx)?;
    Some((outpoint_key(&reveal_txid, 0), commitment_hash_compressed(&commitment)?))
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

    #[test]
    fn provenance_dag_leaves_admits_a_cmint_leaf() {
        // MINTABLE: valid leaves = C_0 AND an issuer-authorized cmint output. A note descending from the
        // cmint leaf (not C_0) is real supply.
        let cmint_op = op(0xCC, 0);
        let cmint_ch = [0xCD; 32];
        let leaves = [(c0_op(), c0_ch()), (cmint_op, cmint_ch)];
        let a = VerifiedCxfer {
            txid: [0x0A; 32],
            inputs: vec![([0xCC; 32], 0, cmint_ch)], // spends the cmint leaf
            outputs: vec![(0, [0xAA; 32])],
        };
        assert!(verify_provenance_dag_leaves(&leaves, &op(0x0A, 0), &[0xAA; 32], &[a]));
        // a note rooting at the cmint OUTPOINT but a non-authorized commitment hash → rejected (the leaf set
        // is value-matched, so a fabricated mint commitment can't pose as the authorized one).
        let b = VerifiedCxfer {
            txid: [0x0B; 32],
            inputs: vec![([0xCC; 32], 0, [0xFF; 32])],
            outputs: vec![(0, [0xBB; 32])],
        };
        assert!(!verify_provenance_dag_leaves(&leaves, &op(0x0B, 0), &[0xBB; 32], &[b]));
        // and the fixed-supply single-leaf wrapper still rejects a cmint-rooted note (C_0 only)
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[VerifiedCxfer {
            txid: [0x0A; 32], inputs: vec![([0xCC; 32], 0, cmint_ch)], outputs: vec![(0, [0xAA; 32])],
        }]));
    }

    #[test]
    fn cmint_rejects_non_mintable_authority() {
        // mint_authority all-zero (a fixed-supply asset) ⇒ no authorized mints — None before any tx parse.
        assert!(verify_cmint_authorized(&[0xAA; 32], &[0u8; 32], &[], &[]).is_none());
    }

    // ---- verify_provenance (composition over real conserving crypto) ----

    fn strip(s: &str) -> &str {
        s.strip_prefix("0x").unwrap_or(s)
    }
    fn arr32(s: &str) -> [u8; 32] {
        hex::decode(strip(s)).unwrap().try_into().unwrap()
    }
    fn arr33(s: &str) -> [u8; 33] {
        hex::decode(strip(s)).unwrap().try_into().unwrap()
    }

    /// A real conserving 1-in/1-out CXFER (the `conserving_m1` fixture) framed as a depth-1 distribution:
    /// the fixture's input note IS the etch supply note C_0, its output IS the burned note. Returns the
    /// anchor params + a valid `ProvenanceWitness` (single-tx block, so the confirmed root is the txid).
    fn build_valid() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 32], ProvenanceWitness) {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        let v = f["vectors"].as_array().unwrap().iter()
            .find(|x| x["name"].as_str() == Some("conserving_m1")).expect("conserving_m1 vector");
        let asset = arr32(v["asset"].as_str().unwrap());
        let in_txid = arr32(v["inputs"][0]["txid"].as_str().unwrap());
        let in_vout = v["inputs"][0]["vout"].as_u64().unwrap() as u32;
        let in_c = arr33(v["inputs"][0]["commitment"].as_str().unwrap());
        let out_c = arr33(v["outsCompressed"][0].as_str().unwrap());
        let sig: [u8; 64] = hex::decode(strip(v["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();
        let rp = hex::decode(strip(v["rangeProof"].as_str().unwrap())).unwrap();

        let c0_outpoint = outpoint_key(&in_txid, in_vout);
        let c0_ch = commitment_hash_compressed(&in_c).unwrap();
        let prov_txid = [0x99u8; 32];
        let confirmed_root = verify_merkle_path(&prov_txid, &[], 0); // single-tx block: root == txid
        let burned_outpoint = outpoint_key(&prov_txid, 0);
        let burned_ch = commitment_hash_compressed(&out_c).unwrap();
        let w = ProvenanceWitness {
            txid: prov_txid,
            input_outpoints: vec![(in_txid, in_vout)],
            input_commitments: vec![in_c],
            output_commitments: vec![out_c],
            output_vouts: vec![0],
            range_proof: rp,
            kernel_sig: sig,
            merkle_siblings: vec![],
            merkle_index: 0,
            confirmed_block_root: confirmed_root,
        };
        (asset, c0_outpoint, c0_ch, burned_outpoint, burned_ch, w)
    }

    #[test]
    fn verify_provenance_accepts_real_depth1_from_c0() {
        let (asset, c0_op, c0_ch, b_op, b_ch, w) = build_valid();
        assert!(
            verify_provenance(&asset, &c0_op, &c0_ch, &b_op, &b_ch, &[w]).is_ok(),
            "a real conserving depth-1 distribution from C_0 verifies"
        );
    }

    #[test]
    fn verify_provenance_rejects_unconfirmed_cxfer() {
        let (asset, c0_op, c0_ch, b_op, b_ch, mut w) = build_valid();
        w.confirmed_block_root = [0xEE; 32]; // != verify_merkle_path → inclusion fails
        assert!(verify_provenance(&asset, &c0_op, &c0_ch, &b_op, &b_ch, &[w]).is_err());
    }

    #[test]
    fn verify_provenance_rejects_nonconserving_cxfer() {
        let (asset, c0_op, c0_ch, b_op, b_ch, mut w) = build_valid();
        w.kernel_sig = [0u8; 64]; // garbage kernel → conservation fails (inclusion still passes)
        assert!(verify_provenance(&asset, &c0_op, &c0_ch, &b_op, &b_ch, &[w]).is_err());
    }

    #[test]
    fn verify_provenance_rejects_wrong_c0_anchor() {
        let (asset, c0_op, _c0_ch, b_op, b_ch, w) = build_valid();
        // a real conserving cxfer, but its input does not match the declared C_0 commitment → not a
        // C_0 descendant → the linkage rejects (no fabricating the supply anchor).
        assert!(verify_provenance(&asset, &c0_op, &[0x00; 32], &b_op, &b_ch, &[w]).is_err());
    }
}
