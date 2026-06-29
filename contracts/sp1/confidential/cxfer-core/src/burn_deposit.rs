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
    bip340_verify, canonical_output_vout, commitment_hash_compressed, decompress, outpoint_key,
    verify_cxfer_conservation_burned, verify_range, Point,
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
    verify_provenance_dag_leaves(&[(*c0_outpoint, *c0_commitment_hash)], burned_outpoint, cxfers)
        == Some(*burned_commitment_hash)
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
    cxfers: &[VerifiedCxfer],
) -> Option<[u8; 32]> {
    if cxfers.is_empty() {
        return None;
    }
    // 1. Index produced outputs (outpoint → commitment hash); a duplicate produced outpoint (two producers
    //    for one note) is rejected.
    let mut produced: Vec<([u8; 32], [u8; 32])> = Vec::new();
    for cx in cxfers {
        if cx.outputs.is_empty() {
            return None;
        }
        for (vout, ch) in &cx.outputs {
            let op = outpoint_key(&cx.txid, *vout);
            if produced.iter().any(|(o, _)| o == &op) {
                return None;
            }
            produced.push((op, *ch));
        }
    }
    // 2. Reject an outpoint consumed twice (an in-DAG double-spend).
    let mut consumed: Vec<[u8; 32]> = Vec::new();
    for cx in cxfers {
        if cx.inputs.is_empty() {
            return None;
        }
        for (ptxid, pvout, _) in &cx.inputs {
            let op = outpoint_key(ptxid, *pvout);
            if consumed.iter().any(|o| o == &op) {
                return None;
            }
            consumed.push(op);
        }
    }
    // 3. REACHABILITY from the valid supply leaves (not just local edge consistency): a CXFER is accepted
    //    only once EVERY input resolves to a reachable note — a valid leaf, or an output of an
    //    already-accepted CXFER, value-matched by commitment hash (so a value-swapping seam can't open).
    //    Iterate to a fixpoint. A cycle, a disconnected component, or a future-output dependency never
    //    becomes reachable, so it stays unaccepted — and EVERY CXFER must be accepted, so the whole DAG is
    //    rejected unless it genuinely descends from a leaf. (Without this, a closed cycle conserving its own
    //    fabricated notes — whose openings the prover knows — would mint value rooted in nothing.)
    let mut reachable: Vec<([u8; 32], [u8; 32])> = valid_leaves.to_vec();
    let mut accepted = vec![false; cxfers.len()];
    loop {
        let mut progress = false;
        for (i, cx) in cxfers.iter().enumerate() {
            if accepted[i] {
                continue;
            }
            let all_inputs_reachable = cx.inputs.iter().all(|(ptxid, pvout, in_ch)| {
                let op = outpoint_key(ptxid, *pvout);
                reachable.iter().any(|(o, ch)| o == &op && ch == in_ch)
            });
            if all_inputs_reachable {
                accepted[i] = true;
                progress = true;
                for (vout, ch) in &cx.outputs {
                    reachable.push((outpoint_key(&cx.txid, *vout), *ch));
                }
            }
        }
        if !progress {
            break;
        }
    }
    if accepted.iter().any(|&a| !a) {
        return None; // an unreachable CXFER ⇒ a cycle / disconnected component / not rooted in supply
    }
    // 4. The burned note must be reachable (descends from a valid leaf) and NOT consumed inside the DAG
    //    (it is spent by the later burn tx, not by a child CXFER). Return the commitment hash the DAG
    //    authenticates at the outpoint — the caller binds the prover's note opening to it, so the opening
    //    cannot be chosen to drop a reachable (confirmed) burn.
    if consumed.iter().any(|o| o == burned_outpoint) {
        return None;
    }
    reachable
        .iter()
        .find(|(o, _)| o == burned_outpoint)
        .map(|(_, ch)| *ch)
}

/// One provenance CXFER, bound to the ACTUAL confirmed Bitcoin transaction. `txid`, the CXFER envelope
/// (asset, kernel sig, output commitments, range proof) and the input outpoints are all DERIVED from `tx`
/// — not witnessed freely alongside a bare txid — and the witness is BIP141-committed. The caller (the
/// fold, in reflect.rs) supplies `confirmed_block_root` from the reflection's own relay-anchored header
/// sync; `verify_provenance` checks the tx folds into THAT root, it does not itself validate PoW.
pub struct ProvenanceWitness {
    /// The full confirmed CXFER tx bytes — `txid` (computed, not free) + the CXFER envelope are read from
    /// these, so the conserving step is tied to the real on-chain transaction.
    pub tx: Vec<u8>,
    /// The spent notes' commitments (compressed). Witnessed — Bitcoin records only the outpoint, not the
    /// note value — but bound: each must value-match the producing DAG output (or C_0) by commitment hash.
    pub input_commitments: Vec<[u8; 33]>,
    /// The produced notes' vouts (the note→output mapping; bound by the DAG to the real input each is later
    /// spent by). Values are tx-derived (the envelope's output commitments), so a vout can't inflate value.
    pub output_vouts: Vec<u32>,
    /// Public supply destroyed by this step: 0 for a pure transfer, > 0 for a CBURN. Witnessed but
    /// KERNEL-BOUND (`Σ C_in = burned_amount·H + Σ C_out`), so it cannot be understated to inflate change.
    pub burned_amount: u64,
    pub merkle_index: u32,
    pub merkle_siblings: Vec<[u8; 32]>,
    pub confirmed_block_root: [u8; 32],
    /// BIP141 witness authentication (the CXFER envelope is in the witness): the tx's wtxid path + the
    /// same-block coinbase commitment, exactly as for the etch/cmint reveals.
    pub wtxid_siblings: Vec<[u8; 32]>,
    pub coinbase: Vec<u8>,
    pub coinbase_txid_siblings: Vec<[u8; 32]>,
}

/// One cmint authorization in a provenance blob: the reveal + commit txs and their inclusion/witness proofs.
pub struct CmintWitness {
    pub reveal_tx: Vec<u8>,
    pub commit_tx: Vec<u8>,
    pub merkle_siblings: Vec<[u8; 32]>,
    pub merkle_index: u32,
    pub reveal_wtxid_siblings: Vec<[u8; 32]>,
    pub reveal_coinbase: Vec<u8>,
    pub reveal_cb_txid_siblings: Vec<[u8; 32]>,
}

/// A burn-deposit's complete provenance, serialized to live in the burn tx's Taproot witness (appended to the
/// burn envelope inscription). The reflection guest reads it from the wtxid-authenticated witness — not from
/// the proof's private input — so the provenance is non-discretionary: a prover cannot substitute a broken DAG
/// to skip a real burn (that would change the burn txid), and a fake burn carries its own (invalid) DAG that
/// simply fails verification and skips. `serialize`/`parse` are inverses (round-trip tested); the dapp mirrors
/// `serialize` byte-for-byte. Length-prefixed, little-endian counts; `parse` requires exact consumption.
pub struct ProvenanceBlob {
    pub headers: Vec<Vec<u8>>,
    pub etch_tx: Vec<u8>,
    pub etch_index: u32,
    pub etch_siblings: Vec<[u8; 32]>,
    pub etch_wtxid_siblings: Vec<[u8; 32]>,
    pub etch_coinbase: Vec<u8>,
    pub etch_cb_txid_siblings: Vec<[u8; 32]>,
    pub cmints: Vec<CmintWitness>,
    pub prov: Vec<ProvenanceWitness>,
}

fn pb_u32(o: &mut Vec<u8>, v: u32) { o.extend_from_slice(&v.to_le_bytes()); }
fn pb_bytes(o: &mut Vec<u8>, b: &[u8]) { pb_u32(o, b.len() as u32); o.extend_from_slice(b); }
fn pb_v32(o: &mut Vec<u8>, v: &[[u8; 32]]) { pb_u32(o, v.len() as u32); for x in v { o.extend_from_slice(x); } }
fn pb_v33(o: &mut Vec<u8>, v: &[[u8; 33]]) { pb_u32(o, v.len() as u32); for x in v { o.extend_from_slice(x); } }
fn pb_vu32(o: &mut Vec<u8>, v: &[u32]) { pb_u32(o, v.len() as u32); for x in v { pb_u32(o, *x); } }

struct PbCur<'a> { b: &'a [u8], i: usize }
impl<'a> PbCur<'a> {
    fn u32(&mut self) -> Option<u32> {
        let e = self.i.checked_add(4)?;
        if e > self.b.len() { return None; }
        let v = u32::from_le_bytes(self.b[self.i..e].try_into().ok()?);
        self.i = e;
        Some(v)
    }
    fn u64(&mut self) -> Option<u64> {
        let e = self.i.checked_add(8)?;
        if e > self.b.len() { return None; }
        let v = u64::from_le_bytes(self.b[self.i..e].try_into().ok()?);
        self.i = e;
        Some(v)
    }
    fn bytes(&mut self) -> Option<Vec<u8>> {
        let n = self.u32()? as usize;
        let e = self.i.checked_add(n)?;
        if e > self.b.len() { return None; }
        let v = self.b[self.i..e].to_vec();
        self.i = e;
        Some(v)
    }
    fn a32(&mut self) -> Option<[u8; 32]> {
        let e = self.i.checked_add(32)?;
        if e > self.b.len() { return None; }
        let v: [u8; 32] = self.b[self.i..e].try_into().ok()?;
        self.i = e;
        Some(v)
    }
    fn a33(&mut self) -> Option<[u8; 33]> {
        let e = self.i.checked_add(33)?;
        if e > self.b.len() { return None; }
        let v: [u8; 33] = self.b[self.i..e].try_into().ok()?;
        self.i = e;
        Some(v)
    }
    fn v32(&mut self) -> Option<Vec<[u8; 32]>> {
        let n = self.u32()? as usize;
        if n > 4096 { return None; }
        let mut r = Vec::with_capacity(n);
        for _ in 0..n { r.push(self.a32()?); }
        Some(r)
    }
    fn v33(&mut self) -> Option<Vec<[u8; 33]>> {
        let n = self.u32()? as usize;
        if n > 4096 { return None; }
        let mut r = Vec::with_capacity(n);
        for _ in 0..n { r.push(self.a33()?); }
        Some(r)
    }
    fn vu32(&mut self) -> Option<Vec<u32>> {
        let n = self.u32()? as usize;
        if n > 4096 { return None; }
        let mut r = Vec::with_capacity(n);
        for _ in 0..n { r.push(self.u32()?); }
        Some(r)
    }
}

impl ProvenanceBlob {
    pub fn serialize(&self) -> Vec<u8> {
        let mut o = Vec::new();
        pb_u32(&mut o, self.headers.len() as u32);
        for h in &self.headers { pb_bytes(&mut o, h); }
        pb_bytes(&mut o, &self.etch_tx);
        pb_u32(&mut o, self.etch_index);
        pb_v32(&mut o, &self.etch_siblings);
        pb_v32(&mut o, &self.etch_wtxid_siblings);
        pb_bytes(&mut o, &self.etch_coinbase);
        pb_v32(&mut o, &self.etch_cb_txid_siblings);
        pb_u32(&mut o, self.cmints.len() as u32);
        for c in &self.cmints {
            pb_bytes(&mut o, &c.reveal_tx);
            pb_bytes(&mut o, &c.commit_tx);
            pb_v32(&mut o, &c.merkle_siblings);
            pb_u32(&mut o, c.merkle_index);
            pb_v32(&mut o, &c.reveal_wtxid_siblings);
            pb_bytes(&mut o, &c.reveal_coinbase);
            pb_v32(&mut o, &c.reveal_cb_txid_siblings);
        }
        pb_u32(&mut o, self.prov.len() as u32);
        for p in &self.prov {
            pb_bytes(&mut o, &p.tx);
            pb_v33(&mut o, &p.input_commitments);
            pb_vu32(&mut o, &p.output_vouts);
            o.extend_from_slice(&p.burned_amount.to_le_bytes());
            pb_u32(&mut o, p.merkle_index);
            pb_v32(&mut o, &p.merkle_siblings);
            o.extend_from_slice(&p.confirmed_block_root);
            pb_v32(&mut o, &p.wtxid_siblings);
            pb_bytes(&mut o, &p.coinbase);
            pb_v32(&mut o, &p.coinbase_txid_siblings);
        }
        o
    }

    pub fn parse(blob: &[u8]) -> Option<ProvenanceBlob> {
        let mut c = PbCur { b: blob, i: 0 };
        let nh = c.u32()? as usize;
        if nh > 4096 { return None; }
        let mut headers = Vec::with_capacity(nh);
        for _ in 0..nh { headers.push(c.bytes()?); }
        let etch_tx = c.bytes()?;
        let etch_index = c.u32()?;
        let etch_siblings = c.v32()?;
        let etch_wtxid_siblings = c.v32()?;
        let etch_coinbase = c.bytes()?;
        let etch_cb_txid_siblings = c.v32()?;
        let ncm = c.u32()? as usize;
        if ncm > 1024 { return None; }
        let mut cmints = Vec::with_capacity(ncm);
        for _ in 0..ncm {
            cmints.push(CmintWitness {
                reveal_tx: c.bytes()?,
                commit_tx: c.bytes()?,
                merkle_siblings: c.v32()?,
                merkle_index: c.u32()?,
                reveal_wtxid_siblings: c.v32()?,
                reveal_coinbase: c.bytes()?,
                reveal_cb_txid_siblings: c.v32()?,
            });
        }
        let ncx = c.u32()? as usize;
        if ncx > 1024 { return None; }
        let mut prov = Vec::with_capacity(ncx);
        for _ in 0..ncx {
            prov.push(ProvenanceWitness {
                tx: c.bytes()?,
                input_commitments: c.v33()?,
                output_vouts: c.vu32()?,
                burned_amount: c.u64()?,
                merkle_index: c.u32()?,
                merkle_siblings: c.v32()?,
                confirmed_block_root: c.a32()?,
                wtxid_siblings: c.v32()?,
                coinbase: c.bytes()?,
                coinbase_txid_siblings: c.v32()?,
            });
        }
        if c.i != blob.len() { return None; }
        Some(ProvenanceBlob {
            headers,
            etch_tx,
            etch_index,
            etch_siblings,
            etch_wtxid_siblings,
            etch_coinbase,
            etch_cb_txid_siblings,
            cmints,
            prov,
        })
    }
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
    let ch = verify_provenance_leaves(
        asset,
        &[(*c0_outpoint, *c0_commitment_hash)],
        burned_outpoint,
        cxfers,
    )?;
    if &ch != burned_commitment_hash {
        return Err("burn-deposit: burned commitment hash mismatch");
    }
    Ok(())
}

/// MINTABLE form: the burned note may descend from ANY of `valid_leaves` — the etch supply note `C_0` PLUS
/// each issuer-authorized cmint output. The caller verifies each leaf (`C_0` via `verify_etch_anchor`; each
/// cmint via `verify_cmint_authorized`, whose issuer signature is bound to the mint's commit anchor so a
/// re-wrapped mint envelope cannot double-issue). Per-CXFER crypto is identical to the fixed-supply form.
pub fn verify_provenance_leaves(
    asset: &[u8; 32],
    valid_leaves: &[([u8; 32], [u8; 32])],
    burned_outpoint: &[u8; 32],
    cxfers: &[ProvenanceWitness],
) -> Result<[u8; 32], &'static str> {
    if cxfers.is_empty() {
        return Err("burn-deposit: empty provenance");
    }
    let verified = verify_cxfers(asset, cxfers)?;
    verify_provenance_dag_leaves(valid_leaves, burned_outpoint, &verified)
        .ok_or("burn-deposit: burned note does not descend from a valid supply leaf")
}

/// Per-CXFER crypto (inclusion + conservation) → the linkage-shape `VerifiedCxfer`s. Shared by the
/// fixed-supply (`verify_provenance`) and mintable (`verify_provenance_leaves`) forms.
fn verify_cxfers(asset: &[u8; 32], cxfers: &[ProvenanceWitness]) -> Result<Vec<VerifiedCxfer>, &'static str> {
    let mut verified: Vec<VerifiedCxfer> = Vec::with_capacity(cxfers.len());
    for cx in cxfers {
        // 1. The txid is COMPUTED from the tx bytes (not a free 32-byte value — closes using an internal
        //    merkle node or an unrelated confirmed txid as the anchor), and the tx folds into the
        //    caller-confirmed (relay-anchored) block merkle root.
        let txid = bitcoin::compute_txid(&cx.tx).ok_or("burn-deposit: malformed provenance tx")?;
        if verify_merkle_path(&txid, &cx.merkle_siblings, cx.merkle_index) != cx.confirmed_block_root {
            return Err("burn-deposit: provenance cxfer not in the confirmed block");
        }
        // 2. The CXFER envelope lives in the WITNESS, so bind the witness (BIP141), not just the txid.
        bitcoin::verify_tx_witness_committed(
            &cx.tx, cx.merkle_index, &cx.wtxid_siblings, &cx.coinbase, &cx.coinbase_txid_siblings, &cx.confirmed_block_root,
        )
        .ok_or("burn-deposit: provenance witness not committed")?;
        // 3. Parse the CXFER data FROM the confirmed tx — asset, kernel sig, output commitments, range proof
        //    — so the conserving step is the one actually published on Bitcoin, not free witness data.
        let env = bitcoin::extract_taproot_envelope(&cx.tx).ok_or("burn-deposit: no cxfer envelope")?;
        let (env_asset, kernel_sig, output_commitments, range_proof) =
            bitcoin::parse_cxfer_envelope_full(&env).ok_or("burn-deposit: not a cxfer envelope")?;
        if &env_asset != asset {
            return Err("burn-deposit: provenance cxfer asset mismatch");
        }
        // 4. The spent inputs are the tx's vins; their commitment POINTS are witnessed (bound below by the
        //    DAG to prior tx-derived outputs / C_0).
        let input_outpoints = bitcoin::extract_inputs(&cx.tx).ok_or("burn-deposit: malformed cxfer inputs")?;
        if cx.input_commitments.len() != input_outpoints.len() {
            return Err("burn-deposit: input outpoint/commitment length mismatch");
        }
        if cx.output_vouts.len() != output_commitments.len() {
            return Err("burn-deposit: output vout/commitment length mismatch");
        }
        // 5. Conservation: value + asset, bound to the ONE asset. Inputs (witnessed points), outputs +
        //    kernel + range (tx-derived), burned_amount (witnessed, kernel-bound).
        let mut input_points: Vec<Point> = Vec::with_capacity(cx.input_commitments.len());
        for c in &cx.input_commitments {
            input_points.push(decompress(c).ok_or("burn-deposit: input commitment not a curve point")?);
        }
        if !verify_cxfer_conservation_burned(
            asset,
            &input_outpoints,
            &input_points,
            &output_commitments,
            cx.burned_amount,
            &range_proof,
            &kernel_sig,
        ) {
            return Err("burn-deposit: provenance step does not conserve value/asset");
        }
        // 6. Reduce to the linkage shape — commitment hashes derived from the SAME commitments conservation
        //    just verified, so a link can't swap a low-value producing output for a high-value claimed input.
        let mut inputs = Vec::with_capacity(input_outpoints.len());
        for (i, (ptxid, pvout)) in input_outpoints.iter().enumerate() {
            let ch = commitment_hash_compressed(&cx.input_commitments[i])
                .ok_or("burn-deposit: input commitment not a curve point")?;
            inputs.push((*ptxid, *pvout, ch));
        }
        // Bind each output's Bitcoin vout to the CANONICAL value the opcode's tx layout dictates — NOT the
        // freely WITNESSED `cx.output_vouts`. A free vout lets a prover re-key which output commitment the
        // burned outpoint resolves to (e.g. a recipient+change producer → resolve the burn to the HIGH-value
        // output while only the LOW-value note was actually retired on Bitcoin → unbacked cross-chain mint).
        // The canonical map mirrors the worker/dapp `commitmentForUtxo` (the single defining-hop resolver):
        // identity for T_CXFER/T_CXFER_BPP/T_AXFER/T_AXFER_BPP, the interleave {0→0, 1→2} for the
        // variable-amount atomic-settlement T_AXFER_VAR/T_AXFER_VAR_BPP. The witnessed value must equal it
        // (fail-closed on assembler drift); a mismatch or an unmapped index is rejected.
        let opcode = env[0];
        let mut outputs = Vec::with_capacity(output_commitments.len());
        for (i, c) in output_commitments.iter().enumerate() {
            let ch = commitment_hash_compressed(c).ok_or("burn-deposit: output commitment not a curve point")?;
            let canonical = canonical_output_vout(opcode, i, output_commitments.len())
                .ok_or("burn-deposit: output index has no canonical vout for this opcode")?;
            if cx.output_vouts[i] != canonical {
                return Err("burn-deposit: non-canonical output vout (must match the opcode's tx layout)");
            }
            outputs.push((canonical, ch));
        }
        verified.push(VerifiedCxfer { txid, inputs, outputs });
    }
    Ok(verified)
}

/// Domain for the issuer-authorized-mint signature message (mintable assets, §6.1). This is the CANONICAL
/// message the live dapp signs/validates (`computeMintMsg` / `buildAndBroadcastCMint` / the dapp mint
/// validator): a mint the dapp accepts as supply is exactly the one the bridge admits as a supply leaf.
pub const CMINT_DOMAIN: &[u8] = b"tacit-mint-v1";

/// Verify a `T_MINT` (0x24) is an AUTHORIZED supply leaf for a MINTABLE asset → `(leaf_outpoint,
/// leaf_commitment_hash)` for `valid_leaves`, or None. Checks:
///  - mintable: `mint_authority != 0` (the x-only issuer key from the etch; a fixed-supply asset has none);
///  - asset-bound: the reveal's `T_MINT` envelope declares THIS `asset`;
///  - commit/reveal pair: the reveal spends the `commit_tx`;
///  - **authorized + non-re-wrappable:** BIP-340 verify of the issuer signature under `mint_authority` over
///    `sha256(CMINT_DOMAIN ‖ asset ‖ commit_anchor ‖ commitment ‖ amount_ct)` — the live dapp's
///    `computeMintMsg` byte-for-byte — where `commit_anchor` = `anchor_txid(internal) ‖ anchor_vout_LE` is the
///    COMMIT tx's first input outpoint — so one signature can't be re-wrapped into another commit/reveal pair
///    (which would mint the same authorization twice);
///  - range: the minted commitment is BP+ range-bounded to [0, 2⁶⁴).
/// The leaf note is the reveal's vout-0 commitment. The CALLER confirms the reveal + commit txs are real
/// on-chain (header+merkle), exactly as for the provenance cxfers. Returns None (admit nothing) on any miss.
pub fn verify_cmint_authorized(
    asset: &[u8; 32],
    mint_authority: &[u8; 32],
    expected_etch_txid: &[u8; 32],
    reveal_tx: &[u8],
    commit_tx: &[u8],
) -> Option<([u8; 32], [u8; 32])> {
    if mint_authority.iter().all(|&b| b == 0) {
        return None; // not mintable — no authorized mints exist
    }
    let env = bitcoin::extract_taproot_envelope(reveal_tx)?;
    let (mint_asset, etch_txid, commitment, amount_ct, range_proof, issuer_sig) = bitcoin::parse_cmint(&env)?;
    if &mint_asset != asset {
        return None;
    }
    // The mint must reference the SAME etch as the asset it claims to mint — the T_MINT carries etchTxid,
    // so bind it (defense-in-depth: the asset already commits to its etch txid, this rejects a mint whose
    // declared etch disagrees rather than silently ignoring the field).
    if &etch_txid != expected_etch_txid {
        return None;
    }
    // commit/reveal pair: the reveal's first input spends the commit tx.
    let commit_txid = bitcoin::compute_txid(commit_tx)?;
    if bitcoin::extract_inputs(reveal_tx)?.first()?.0 != commit_txid {
        return None;
    }
    // commit_anchor = the commit tx's first input outpoint (binds the signature to THIS pair → no re-wrap).
    // The message is the dapp's canonical `computeMintMsg`:
    //   sha256(DOMAIN ‖ asset ‖ anchor_txid(internal) ‖ anchor_vout_LE ‖ commitment ‖ amount_ct).
    // anchor_txid here is the serialized prevout txid (internal order), == the dapp's reverseBytes(display).
    let (anchor_txid, anchor_vout) = *bitcoin::extract_inputs(commit_tx)?.first()?;
    let mut pre = Vec::with_capacity(CMINT_DOMAIN.len() + 32 + 32 + 4 + 33 + 8);
    pre.extend_from_slice(CMINT_DOMAIN);
    pre.extend_from_slice(asset);
    pre.extend_from_slice(&anchor_txid);
    pre.extend_from_slice(&anchor_vout.to_le_bytes());
    pre.extend_from_slice(&commitment);
    pre.extend_from_slice(&amount_ct);
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

    // The provenance blob serializes and parses back identically (the format the burn-tx witness carries and
    // the dapp mirrors); a truncated or trailing-byte blob is rejected.
    #[test]
    fn provenance_blob_round_trips() {
        let pw = ProvenanceWitness {
            tx: vec![1, 2, 3, 4, 5],
            input_commitments: vec![[7u8; 33], [8u8; 33]],
            output_vouts: vec![0, 1, 2],
            burned_amount: 4242,
            merkle_index: 9,
            merkle_siblings: vec![[0x11u8; 32], [0x22u8; 32]],
            confirmed_block_root: [0x33u8; 32],
            wtxid_siblings: vec![[0x44u8; 32]],
            coinbase: vec![0xaa, 0xbb],
            coinbase_txid_siblings: vec![[0x55u8; 32], [0x66u8; 32]],
        };
        let cm = CmintWitness {
            reveal_tx: vec![9, 9, 9],
            commit_tx: vec![8, 8],
            merkle_siblings: vec![[0x77u8; 32]],
            merkle_index: 2,
            reveal_wtxid_siblings: vec![[0x88u8; 32], [0x99u8; 32]],
            reveal_coinbase: vec![0xcc],
            reveal_cb_txid_siblings: vec![[0xddu8; 32]],
        };
        let blob = ProvenanceBlob {
            headers: vec![vec![1; 80], vec![2; 80]],
            etch_tx: vec![0x2a; 40],
            etch_index: 3,
            etch_siblings: vec![[0xabu8; 32], [0xcdu8; 32]],
            etch_wtxid_siblings: vec![[0xefu8; 32]],
            etch_coinbase: vec![0x01, 0x02, 0x03],
            etch_cb_txid_siblings: vec![[0x10u8; 32]],
            cmints: vec![cm],
            prov: vec![pw],
        };
        let bytes = blob.serialize();
        let got = ProvenanceBlob::parse(&bytes).expect("round-trips");
        assert_eq!(got.headers, blob.headers);
        assert_eq!(got.etch_tx, blob.etch_tx);
        assert_eq!(got.etch_index, blob.etch_index);
        assert_eq!(got.etch_siblings, blob.etch_siblings);
        assert_eq!(got.etch_wtxid_siblings, blob.etch_wtxid_siblings);
        assert_eq!(got.etch_coinbase, blob.etch_coinbase);
        assert_eq!(got.etch_cb_txid_siblings, blob.etch_cb_txid_siblings);
        assert_eq!(got.cmints.len(), 1);
        assert_eq!(got.cmints[0].reveal_tx, blob.cmints[0].reveal_tx);
        assert_eq!(got.cmints[0].reveal_cb_txid_siblings, blob.cmints[0].reveal_cb_txid_siblings);
        assert_eq!(got.prov.len(), 1);
        assert_eq!(got.prov[0].tx, blob.prov[0].tx);
        assert_eq!(got.prov[0].input_commitments, blob.prov[0].input_commitments);
        assert_eq!(got.prov[0].output_vouts, blob.prov[0].output_vouts);
        assert_eq!(got.prov[0].burned_amount, blob.prov[0].burned_amount);
        assert_eq!(got.prov[0].confirmed_block_root, blob.prov[0].confirmed_block_root);
        assert_eq!(got.prov[0].coinbase_txid_siblings, blob.prov[0].coinbase_txid_siblings);
        assert!(ProvenanceBlob::parse(&bytes[..bytes.len() - 1]).is_none(), "truncated rejected");
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(ProvenanceBlob::parse(&trailing).is_none(), "trailing bytes rejected");
    }

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
    fn dag_cycle_not_rooted_in_supply_rejected() {
        // A spends B:0, B spends A:0 — a closed cycle that conserves internally (the prover knows all its
        // openings) but never reaches C_0. Every local edge is consistent (each input is a produced
        // output, value-matched), yet neither CXFER is reachable from the leaf, so reachability rejects the
        // whole DAG — and with it the cycle-minted "burned" note. Local edge consistency alone accepted it.
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x0B; 32], 0, [0xBB; 32])], outputs: vec![(0, [0xAA; 32])] };
        let b = VerifiedCxfer { txid: [0x0B; 32], inputs: vec![([0x0A; 32], 0, [0xAA; 32])], outputs: vec![(0, [0xBB; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[a, b]));
    }

    #[test]
    fn dag_disconnected_component_rejected() {
        // A is a real C_0 descendant; B is a self-consistent island (spends A's burned output but produces
        // a note claimed as burned) — wait, that's connected. A true island: A from C_0, plus C spending a
        // note D no CXFER produces. The burned note is C's output; C never becomes reachable → rejected.
        let a = VerifiedCxfer { txid: [0x0A; 32], inputs: vec![([0x00; 32], 0, c0_ch())], outputs: vec![(0, [0xAA; 32])] };
        let c = VerifiedCxfer { txid: [0x0C; 32], inputs: vec![([0xDD; 32], 0, [0xDE; 32])], outputs: vec![(0, [0xCC; 32])] };
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0C, 0), &[0xCC; 32], &[a, c]));
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
        assert_eq!(verify_provenance_dag_leaves(&leaves, &op(0x0A, 0), &[a]), Some([0xAA; 32]));
        // a note rooting at the cmint OUTPOINT but a non-authorized commitment hash → rejected (the leaf set
        // is value-matched, so a fabricated mint commitment can't pose as the authorized one).
        let b = VerifiedCxfer {
            txid: [0x0B; 32],
            inputs: vec![([0xCC; 32], 0, [0xFF; 32])],
            outputs: vec![(0, [0xBB; 32])],
        };
        assert_eq!(verify_provenance_dag_leaves(&leaves, &op(0x0B, 0), &[b]), None);
        // and the fixed-supply single-leaf wrapper still rejects a cmint-rooted note (C_0 only)
        assert!(!verify_provenance_dag(&c0_op(), &c0_ch(), &op(0x0A, 0), &[0xAA; 32], &[VerifiedCxfer {
            txid: [0x0A; 32], inputs: vec![([0xCC; 32], 0, cmint_ch)], outputs: vec![(0, [0xAA; 32])],
        }]));
    }

    #[test]
    fn cmint_rejects_non_mintable_authority() {
        // mint_authority all-zero (a fixed-supply asset) ⇒ no authorized mints — None before any tx parse.
        assert!(verify_cmint_authorized(&[0xAA; 32], &[0u8; 32], &[0u8; 32], &[], &[]).is_none());
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

    /// Build a tx-carrying `ProvenanceWitness` for the `conserving_m1` fixture (its input note IS C_0, its
    /// output IS the burned note) with the given kernel signature, in a 2-tx block [coinbase, cxfer] so the
    /// BIP141 witness commitment is exercised. A corrupted sig still produces a well-formed, inclusion-valid
    /// tx (paths rebuilt for it), so a rejection there is CONSERVATION, not inclusion.
    fn build_prov(kernel_sig: [u8; 64]) -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 32], ProvenanceWitness) {
        use crate::bitcoin::{compute_merkle_root, compute_txid, double_sha256};
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        let v = f["vectors"].as_array().unwrap().iter()
            .find(|x| x["name"].as_str() == Some("conserving_m1")).expect("conserving_m1 vector");
        let asset = arr32(v["asset"].as_str().unwrap());
        let in_txid = arr32(v["inputs"][0]["txid"].as_str().unwrap());
        let in_vout = v["inputs"][0]["vout"].as_u64().unwrap() as u32;
        let in_c = arr33(v["inputs"][0]["commitment"].as_str().unwrap());
        let out_c = arr33(v["outsCompressed"][0].as_str().unwrap());
        let rp = hex::decode(strip(v["rangeProof"].as_str().unwrap())).unwrap();

        // The T_CXFER (0x23) envelope: asset ‖ kernel_sig ‖ N ‖ (commitment ‖ amount_ct) ‖ rpLen ‖ rangeProof.
        let mut env = vec![0x23u8];
        env.extend_from_slice(&asset);
        env.extend_from_slice(&kernel_sig);
        env.push(0x01); // N = 1 output
        env.extend_from_slice(&out_c);
        env.extend_from_slice(&[0u8; 8]); // amount_ct (not surfaced by parse_cxfer_envelope_full)
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes());
        env.extend_from_slice(&rp);
        let cxfer_tx = build_reveal_tx(&env, &in_txid, in_vout);

        // Block [coinbase, cxfer_tx]; cxfer at index 1, coinbase wtxid := 0 in the witness tree.
        let reserved = [0x07u8; 32];
        let witness_root = compute_merkle_root(&[[0u8; 32], double_sha256(&cxfer_tx)]);
        let mut pre = [0u8; 64];
        pre[..32].copy_from_slice(&witness_root); pre[32..].copy_from_slice(&reserved);
        let commitment = double_sha256(&pre);
        let coinbase = build_coinbase(&commitment, &reserved);
        let cb_txid = compute_txid(&coinbase).unwrap();
        let cxfer_txid = compute_txid(&cxfer_tx).unwrap();
        let txid_root = compute_merkle_root(&[cb_txid, cxfer_txid]);

        let c0_outpoint = outpoint_key(&in_txid, in_vout);
        let c0_ch = commitment_hash_compressed(&in_c).unwrap();
        let burned_outpoint = outpoint_key(&cxfer_txid, 0);
        let burned_ch = commitment_hash_compressed(&out_c).unwrap();
        let w = ProvenanceWitness {
            tx: cxfer_tx,
            input_commitments: vec![in_c],
            output_vouts: vec![0],
            burned_amount: 0,
            merkle_index: 1,
            merkle_siblings: vec![cb_txid],
            confirmed_block_root: txid_root,
            wtxid_siblings: vec![[0u8; 32]],
            coinbase,
            coinbase_txid_siblings: vec![cxfer_txid],
        };
        (asset, c0_outpoint, c0_ch, burned_outpoint, burned_ch, w)
    }

    fn build_valid() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 32], ProvenanceWitness) {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        let v = f["vectors"].as_array().unwrap().iter()
            .find(|x| x["name"].as_str() == Some("conserving_m1")).unwrap();
        let sig: [u8; 64] = hex::decode(strip(v["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();
        build_prov(sig)
    }

    /// A minimal Taproot reveal tx carrying `envelope` in its witness (item 1), spending `(in_txid, in_vout)`.
    fn build_reveal_tx(envelope: &[u8], in_txid: &[u8; 32], in_vout: u32) -> Vec<u8> {
        let mut script = Vec::new();
        script.push(0x20); script.extend_from_slice(&[0u8; 32]); // PUSH(32) xonly pubkey
        script.push(0xac); // OP_CHECKSIG
        script.push(0x00); script.push(0x63); // OP_FALSE OP_IF
        script.push(0x05); script.extend_from_slice(b"TACIT");
        script.push(0x01); script.push(0x01); // frame v1
        script.push(0x4d); // OP_PUSHDATA2
        script.push((envelope.len() & 0xff) as u8);
        script.push((envelope.len() >> 8) as u8);
        script.extend_from_slice(envelope);
        script.push(0x68); // OP_ENDIF
        let mut tx = Vec::new();
        tx.extend_from_slice(&[0x02, 0, 0, 0]); // version
        tx.extend_from_slice(&[0x00, 0x01]); // marker, flag
        tx.push(0x01); // 1 input
        tx.extend_from_slice(in_txid);
        tx.extend_from_slice(&in_vout.to_le_bytes());
        tx.push(0x00); // scriptSig len 0
        tx.extend_from_slice(&[0xfd, 0xff, 0xff, 0xff]); // sequence
        tx.push(0x01); // 1 output
        tx.extend_from_slice(&[0u8; 8]); // value 0
        tx.push(0x00); // output script len 0
        tx.push(0x03); // 3 witness items: sig, script, control block
        tx.push(0x40); tx.extend_from_slice(&[0u8; 0x40]);
        let sl = script.len();
        if sl < 0xfd { tx.push(sl as u8); } else { tx.push(0xfd); tx.extend_from_slice(&(sl as u16).to_le_bytes()); }
        tx.extend_from_slice(&script);
        tx.push(0x21); tx.extend_from_slice(&[0xc0; 0x21]); // control block (33)
        tx.extend_from_slice(&[0u8; 4]); // locktime
        tx
    }

    fn build_coinbase(commitment: &[u8; 32], reserved: &[u8; 32]) -> Vec<u8> {
        let mut cb = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01]; // version, marker, flag, 1 input
        cb.extend_from_slice(&[0u8; 32]); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // coinbase prevout
        cb.push(0x00); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // scriptSig len 0, sequence
        cb.push(0x01); cb.extend_from_slice(&[0u8; 8]); // 1 output, value 0
        cb.push(0x26); cb.extend_from_slice(&[0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]); cb.extend_from_slice(commitment);
        cb.push(0x01); cb.push(0x20); cb.extend_from_slice(reserved); // witness: 32-byte reserved value
        cb.extend_from_slice(&[0, 0, 0, 0]); // locktime
        cb
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
        // A garbage kernel sig baked INTO the tx envelope → conservation fails (inclusion + witness
        // commitment still pass, since the tx is well-formed and its paths are rebuilt for it).
        let (asset, c0_op, c0_ch, b_op, b_ch, w) = build_prov([0u8; 64]);
        assert!(verify_provenance(&asset, &c0_op, &c0_ch, &b_op, &b_ch, &[w]).is_err());
    }

    #[test]
    fn verify_provenance_rejects_wrong_c0_anchor() {
        let (asset, c0_op, _c0_ch, b_op, b_ch, w) = build_valid();
        // a real conserving cxfer, but its input does not match the declared C_0 commitment → not a
        // C_0 descendant → the linkage rejects (no fabricating the supply anchor).
        assert!(verify_provenance(&asset, &c0_op, &[0x00; 32], &b_op, &b_ch, &[w]).is_err());
    }

    #[test]
    fn verify_provenance_rejects_noncanonical_output_vout() {
        // A witnessed vout that disagrees with the opcode's canonical layout would let a prover re-key which
        // output commitment the burned outpoint resolves to (the multi-output recipient+change case → resolve
        // the burn to the high-value note while retiring the low-value one). The canonical-vout bind rejects
        // it — the build_valid fixture is a single-output T_CXFER (canonical vout 0), so claiming vout 1 fails
        // closed (no value-swapping seam).
        let (asset, c0_op, c0_ch, b_op, b_ch, mut w) = build_valid();
        w.output_vouts = vec![1]; // canonical is [0]; a permuted/forged vout
        assert!(verify_provenance(&asset, &c0_op, &c0_ch, &b_op, &b_ch, &[w]).is_err());
    }

    #[test]
    fn canonical_output_vout_matches_commitment_for_utxo() {
        // Locks the per-opcode vout convention to the worker/dapp `commitmentForUtxo` resolver, so the
        // burn-deposit DAG keys producer outputs at their REAL Bitcoin vout for every accepted opcode.
        // Identity family: confidential output i is at vout i.
        for op in [0x23u8, 0x22, 0x26, 0x3C] {
            assert_eq!(canonical_output_vout(op, 0, 2), Some(0));
            assert_eq!(canonical_output_vout(op, 1, 2), Some(1));
            assert_eq!(canonical_output_vout(op, 7, 8), Some(7));
        }
        // Variable-amount atomic settlement (interleaved): output 0 → vout 0, output 1 → vout 2 (vout 1 is
        // the BTC payment, vout 3 the OP_RETURN); a 3rd tacit output has no canonical vout.
        for op in [0x37u8, 0x3D] {
            assert_eq!(canonical_output_vout(op, 0, 2), Some(0));
            assert_eq!(canonical_output_vout(op, 1, 2), Some(2));
            assert_eq!(canonical_output_vout(op, 0, 1), Some(0)); // no-change variant
            assert_eq!(canonical_output_vout(op, 1, 1), None);    // index 1 absent when N==1
            assert_eq!(canonical_output_vout(op, 2, 4), None);    // unmapped beyond the 2 tacit vouts
        }
        // A non-cxfer-family opcode is never a valid producer here.
        assert_eq!(canonical_output_vout(0x5C, 0, 2), None);
    }

    #[test]
    fn canonical_bid_output_vout_matches_commitment_for_utxo() {
        use crate::canonical_bid_output_vout;
        // T_PREAUTH_BID (0x5B, exact-fill): buyer filled note @vout0, seller change @vout3 (no refund branch).
        assert_eq!(canonical_bid_output_vout(0x5B, 0, 2, false), Some(0));
        assert_eq!(canonical_bid_output_vout(0x5B, 1, 2, false), Some(3));
        assert_eq!(canonical_bid_output_vout(0x5B, 1, 2, true), Some(3)); // refund flag irrelevant for 0x5B
        assert_eq!(canonical_bid_output_vout(0x5B, 1, 1, false), None);   // no change output
        // T_PREAUTH_BID_VAR (0x5C): filled note @vout0; seller change @vout4 with a buyer refund, else @vout3.
        assert_eq!(canonical_bid_output_vout(0x5C, 0, 2, false), Some(0));
        assert_eq!(canonical_bid_output_vout(0x5C, 1, 2, false), Some(3)); // full fill, no buyer refund
        assert_eq!(canonical_bid_output_vout(0x5C, 1, 2, true), Some(4));  // partial fill, buyer refund output
        assert_eq!(canonical_bid_output_vout(0x5C, 2, 4, true), None);     // only 2 tacit outputs
        // A cxfer-family opcode is not a bid.
        assert_eq!(canonical_bid_output_vout(0x37, 0, 2, false), None);
    }

    #[test]
    fn canonical_amm_output_vout_matches_commitment_for_utxo() {
        use crate::canonical_amm_output_vout;
        // WITNESS-ENVELOPE AMM ops (no OP_RETURN at vout 0) → tacit notes start at vout 0, matching
        // getParentEnvelopeData (T_LP_ADD vout 0; T_LP_REMOVE recvA 0 / recvB 1; T_PROTOCOL_FEE_CLAIM vout 0).
        assert_eq!(canonical_amm_output_vout(0x2D, 0), Some(0)); // LP_ADD / POOL_INIT share note
        assert_eq!(canonical_amm_output_vout(0x2E, 0), Some(0)); // LP_REMOVE recvA
        assert_eq!(canonical_amm_output_vout(0x2E, 1), Some(1)); // LP_REMOVE recvB
        assert_eq!(canonical_amm_output_vout(0x31, 0), Some(0)); // PROTOCOL_FEE_CLAIM claim note
        assert_eq!(canonical_amm_output_vout(0x2D, 1), None);    // LP_ADD has only one note
        // OP_RETURN-prefixed AMM/farm ops (notes at vout 1+) are NOT in this helper — they key in their own
        // reflect.rs branches (swap_var receipt@1/change@2, swap_route@1, harvest/farm_refund@1, unbond@1/2).
        assert_eq!(canonical_amm_output_vout(0x32, 0), None);    // T_SWAP_VAR not handled here
        assert_eq!(canonical_amm_output_vout(0x3B, 0), None);    // T_LP_HARVEST not handled here
    }

    #[test]
    fn provenance_step_burned_amount_is_kernel_bound() {
        // The build_valid fixture is a burned = 0 transfer. Claiming a nonzero burn on it shifts the kernel
        // verify key by −burned·H, so the burned = 0 signature no longer verifies and the step is rejected.
        // This is what stops an attacker mis-stating the public burn to inflate a CBURN's change outputs.
        // (A REAL conserving CBURN with burned > 0 is validated in-zkVM by the native-exec generator, as for
        // the cmint path — no burned-amount fixture exists here.)
        let (asset, c0_op, c0_ch, b_op, b_ch, mut w) = build_valid();
        w.burned_amount = 5;
        assert!(verify_provenance(&asset, &c0_op, &c0_ch, &b_op, &b_ch, &[w]).is_err());
    }
}
