//! Provenance anchors for the burn-deposit fold, and the rule that lets a burn proof bottom out at a
//! Bitcoin shielded-pool exit or present a lineage longer than 256 transfers
//! (docs/STUCK-TAC-POOL-BACKING.md).
//!
//! ## The two edges the fold refuses today
//!
//! `fold_burn_deposit` walks a note's history back through its transfers to the etch supply note. Two edges
//! stop it (`docs/STUCK-TAC-BOUNTY.md` §1):
//!
//!   1. a note that left Bitcoin's shielded pool — a `T_BTC_SPEND` (0x6d) with `has_exit = 1`, whose
//!      transparent note appears at the carrier's `exit_vout` with no Tacit history behind it;
//!   2. a note with more than 255 transfers behind it (`ncx > 256` in `burn_deposit.rs`).
//!
//! Neither edge is a statement about value. Both are the same missing fact: the fold knows which notes the
//! reflection *saw*, not how much value the shielded pool is *holding* for the transparent notes it handed
//! out. Without that fact an exit is unbacked — and the tempting shortcut, "the pool proved the note exists,
//! so call it real supply", lets a prover mint against value that was never proven real. That shortcut is
//! exactly what the fold already refuses on purpose at `reflect.rs` step 4 (a pool-membership leaf is not
//! mintable supply). This crate adds the missing fact instead of relaxing the check.
//!
//! ## What is added
//!
//! A per-asset **backing ledger**, `funded − exited`, advanced only by witnessed events whose pool-side
//! proofs the caller supplies:
//!
//!   * **shield** (0x6c) — the pool takes custody of value. The ledger credits `Σ v_in`, but only for a shield
//!     whose pool proof verified and whose boundary opens to that sum. This is the only place value enters.
//!   * **exit** (0x6d, `has_exit = 1`) — the pool hands value back out as one transparent note worth
//!     `v_exit`. The rule is one line: **an exit is admissible iff the ledger holds `v_exit`, and admitting it
//!     debits the ledger by that much.** No discount, no rounding, no policy knob. An exit the ledger cannot
//!     cover is refused, and refusing it burns nothing: the note stays spendable on Bitcoin.
//!
//! With that, an exit note is real supply on the same footing as `C_0`, because the value behind it is on the
//! ledger and that value entered through shields the pool proved. The provenance DAG gains the exit note as
//! one more admissible leaf, and a blob that presents no anchor folds exactly as it does today. This does add a
//! rule — [`read_exit`] decides which confirmed transactions are admissible supply, and [`lineage`] decides
//! which presentation shapes are — so the honest statement is narrower than "nothing changes": every hop the DAG
//! accepted before is still accepted, and the only blobs that newly pass are ones that bottom out at the anchor
//! this ledger covers.
//!
//! ## What is added for the 256-step cap
//!
//! `ncx > 256` is a proving-cost bound, not a fact about Bitcoin. A **re-anchoring** rule makes a long lineage
//! presentable inside the same bound: present the transfers from the nearest admissible anchor (an admitted
//! exit note, a cmint leaf, or `C_0`) down to the burned note, and name that anchor instead of the etch.
//! Soundness rests on what the fold already checks for every presented step — inclusion in a confirmed block
//! and value conservation — plus the fact that the anchor itself is admitted supply. A gap cannot hide inside
//! the shortened lineage, because an unresolved outpoint is a dangling input the DAG already rejects.
//! [`Lineage`] is the whole rule: full inside the bound, anchored beyond it, refused when no anchor is in
//! reach.
//!
//! ## Wire format
//!
//! The parser here follows `DESIGN-btc-shielded-pool.md` §3 byte-for-byte, which is also what
//! `worker/src/btc-shielded-pool.js` parses and encodes on the live path. It deliberately does **not** reuse
//! `btc-pool-core::BtcPoolSpendBody`: that crate's relation encodes a pool output as
//! `Cx(32) ‖ Cy(32) ‖ spend_key(32) ‖ nk_pub(33) ‖ pk_eph(33) ‖ ct_note(56)` = 218 bytes and keeps the exit as
//! `exit_vout ‖ Cx ‖ Cy ‖ dest_spk_hash` with the boundary outside the body, while §3 and the worker use
//! `leaf(32) ‖ pk_eph(33) ‖ ct_note(24)` = 89 bytes and inline the 825-byte boundary in the exit. Reading an
//! exit out of a confirmed transaction means reading the wire form, so this crate pins the wire form.
//!
//! ## What is deliberately not here
//!
//! No live pool, verifying key, contract or guest is touched, and no guest links this crate. Per-event crypto
//! stays where it is: the pool proof (Halo2/SP1), the boundary's cross-curve sigma and its range proofs, and
//! every confirmed-transaction check are the caller's, injected through [`PoolProofCheck`] and
//! [`BoundaryCheck`] exactly as `fold_burn_deposit` already takes its header chain and witness from its
//! caller. What this crate owns is the accounting rule and the parsing that must not be re-invented per guest
//! — and every part of it runs offline in `cargo test`.

use cxfer_core::{commitment_hash_compressed, outpoint_key};
use std::collections::BTreeSet;

/// The depth cap one presented lineage may have, the same 256 the provenance blob is bounded by. Its own
/// constant so the rule and the parser cannot drift apart silently.
pub const ANCHOR_MAX_HOPS: u32 = 256;

/// `T_BTC_SHIELD`: move transparent notes into the pool.
pub const T_BTC_SHIELD: u8 = 0x6c;
/// `T_BTC_SPEND`: pay, exit, or both.
pub const T_BTC_SPEND: u8 = 0x6d;

/// `leaf(32) ‖ pk_eph(33) ‖ ct_note(24)` — 89 bytes, as §3 defines a pool output.
pub const POOL_OUTPUT_LEN: usize = 32 + 33 + 24;
/// `C_secp(33) ‖ C_bjj(32) ‖ sigma(169) ‖ bpp(591)` — 825 bytes.
pub const BOUNDARY_LEN: usize = 33 + 32 + 169 + 591;
/// `exit_vout(4) ‖ dest_spk_hash(32) ‖ boundary(825)`.
pub const EXIT_LEN: usize = 4 + 32 + BOUNDARY_LEN;
/// `vout(4) ‖ value(8) ‖ spk_hash(32)`.
pub const WANT_LEN: usize = 4 + 8 + 32;
/// `txid(32) ‖ vout(4)`, all zero for none.
pub const BIND_LEN: usize = 36;
/// §3's bound on a spend proof.
pub const PROOF_MAX: usize = 4096;
pub const SPEND_MAX_IN: usize = 2;
pub const SPEND_MAX_OUT: usize = 3;
pub const SHIELD_MAX_IN: usize = 8;
/// §3's `kernel_sig` length on a shield.
pub const KERNEL_SIG_LEN: usize = 64;

/// What a caller must prove about an exit's pool half: that the spend verified at `h_anchor` against
/// `pool_root` and is the spend this body describes. The fold injects its witness verification the same way,
/// so this crate never reimplements a proof system it cannot run offline.
pub type PoolProofCheck<'a> = &'a dyn Fn(&SpendBody<'_>, &[u8; 32]) -> bool;

pub type ShieldProofCheck<'a> = &'a dyn Fn(&ShieldBody<'_>, &[u8; 32]) -> bool;

/// What a caller must prove about a boundary: that its cross-curve sigma and range proofs verified and that its
/// commitment opens to `value` under `blinding`. Same seam discipline: the opening is checked by whoever can
/// run the curve math, this crate only consumes the answer.
pub type BoundaryCheck<'a> = &'a dyn Fn(&Boundary<'_>, u64, &[u8; 32]) -> bool;

/// The boundary verification this crate can now do itself, with no seam and no caller-supplied closure.
///
/// Until this existed, `boundary_ok` was the whole trust surface: a caller that returned `true` unconditionally
/// could mint backing out of a boundary that proves nothing. `btc-pool-zk-core::boundary::verify` already
/// verifies the 169-byte cross-curve sigma and the 591-byte Bulletproofs+ range proof in this tree — it is the
/// same code the pool's own indexer path uses — so the only thing that was ever missing here was the opening
/// check against the transparent commitment, which `cxfer_core::verify_pedersen_opening` does.
///
/// Refuses a zero value for the same reason the ledger does: a value-0 boundary crossing proves nothing about
/// value and would let a prover pad the anchor set at no cost.
pub fn boundary_opens(boundary: &Boundary<'_>, value: u64, blinding: &[u8; 32]) -> bool {
    if value == 0 {
        return false;
    }
    let mut raw = Vec::with_capacity(BOUNDARY_LEN);
    raw.extend_from_slice(&boundary.c_secp);
    raw.extend_from_slice(&boundary.c_bjj);
    raw.extend_from_slice(boundary.proof);
    // sigma + range proof, in-crate: this is `dapp/btc-pool-zk-boundary.js` `verifyBoundary` in Rust.
    let bjj = match btc_pool_zk_core::boundary::verify_bytes(&raw) {
        Some(p) => p,
        None => return false,
    };
    if btc_pool_zk_core::pt_eq(&bjj, &btc_pool_zk_core::identity()) {
        return false; // an identity BabyJub point is a boundary the pool's own indexer rejects
    }
    // The transparent half: `C_secp` must open to exactly the value and blinding being claimed, so a valid
    // boundary cannot be reused for a different amount. Without this, `value` would be a free witness.
    match cxfer_core::decompress(&boundary.c_secp) {
        Some(c) => {
            cxfer_core::verify_pedersen_opening(&c, value, &cxfer_core::scalar_reduce_be(blinding))
        }
        None => false,
    }
}

// ───────────────────────────── the backing ledger ─────────────────────────────

/// One asset's backing: what the shielded pool took custody of, and what it has already handed back out.
///
/// Both counters only grow, in the order the reflection folds events, so the pair is order-dependent exactly
/// as the pool's own state is — a resumed cycle that reorders events gets a different pair and therefore a
/// different digest, which is the behaviour the `priorDigest` chain already forces everywhere else. `u128`
/// because one batch may legitimately sum more than 2^64 sats in witnesses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackingLedger {
    pub funded: u128,
    pub exited: u128,
    /// Shield carrier txids already credited, and exit outpoints already debited.
    ///
    /// Needed because the counters alone cannot tell a **re-folded** event from a **second** one. A resumed
    /// cycle that re-folds a block would credit the same shield twice (minting backing) or debit the same exit
    /// twice (draining it) — the exact hole this design exists to close, reintroduced by the fix. Two sets
    /// because a shield names its carrier's txid and an exit names its own outpoint; one namespace would let a
    /// txid collide with an unrelated outpoint and silently suppress a real event. Unbounded like the spent
    /// set and the burn set, which grow with history for the same reason, and committed the same way.
    pub shielded: BTreeSet<[u8; 32]>,
    pub exited_at: BTreeSet<[u8; 32]>,
}

impl BackingLedger {
    /// What the pool still owes to notes it has not handed out.
    pub fn available(&self) -> u128 {
        self.funded.saturating_sub(self.exited)
    }

    /// Credit a verified shield: the pool now holds `value` more. [`credit_shield`] is the checked form,
    /// and it is the ONLY caller: `fund` is private precisely so no seam can mint backing without the
    /// pool proof and the boundary opening. A test that needs backing builds it through
    /// [`credit_shield`] with a settling seam, never by calling this.
    ///
    /// Idempotent by `carrier` (the shield transaction's txid) for the same reason `debit` is: re-folding a
    /// block must not mint backing. Returns `None` and credits nothing on a repeat.
    fn fund(&mut self, carrier: &[u8; 32], value: u64) -> Option<()> {
        if value == 0 || !self.shielded.insert(*carrier) {
            return None;
        }
        self.funded = self.funded.saturating_add(value as u128);
        Some(())
    }

    /// Debit a verified exit at `outpoint`. Refuses rather than clamps: an uncovered exit is never partially
    /// booked, so a prover cannot split one unbacked exit into two acceptable halves across cycles.
    ///
    /// Idempotent by outpoint — a second call for the same exit returns `None` and books nothing, so
    /// re-folding a block cannot spend the backing twice.
    pub fn debit(&mut self, outpoint: &[u8; 32], value: u64) -> Option<()> {
        let v = value as u128;
        if value == 0 || v > self.available() {
            return None;
        }
        if !self.exited_at.insert(*outpoint) {
            return None; // already admitted: one exit backs one anchor, once
        }
        self.exited += v;
        Some(())
    }
}

/// Credit one shield, after its pool proof and boundary check both said yes.
///
/// `shielded` is the total the caller read out of the boundary commitment (the sum of the transparent notes the
/// pool took custody of). It refuses a shield that moved nothing, one whose boundary does not open to the
/// claimed total, and one whose carrier pool proof did not verify at `pool_root`.
///
/// What that buys is narrower than "cannot be funded by a figment", and the difference is the seam: this crate
/// cannot open a curve commitment, run a range proof, or resolve a shield's inputs to supply, so `shielded`,
/// `pool_ok` and `boundary_ok` are the caller's. An honest caller can only fund the ledger through a shield
/// whose pool proof verified and whose boundary opens; a caller who lies to both seams can fund it. Risk 1 in
/// §10 of the design doc is that assumption, stated plainly. What this function does own is the shape: the
/// asset, the carrier txid, the pool root, the length and the non-zero rule are all enforced here.
pub fn credit_shield(
    ledger: &mut BackingLedger,
    carrier: &[u8; 32],
    asset: &[u8; 32],
    body: &ShieldBody<'_>,
    shielded: u64,
    blinding: &[u8; 32],
    pool_root: &[u8; 32],
    pool_ok: ShieldProofCheck<'_>,
    boundary_ok: BoundaryCheck<'_>,
) -> Option<()> {
    if shielded == 0 || &body.asset != asset {
        return None; // a shield of another asset cannot fund this fold
    }
    if !pool_ok(body, pool_root) || !boundary_ok(&body.boundary, shielded, blinding) {
        return None;
    }
    ledger.fund(carrier, shielded)
}

// ───────────────────────────── wire parsing ─────────────────────────────

/// The boundary a pool envelope carries, borrowed from the payload: the proof bytes are opaque here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Boundary<'a> {
    pub c_secp: [u8; 33],
    pub c_bjj: [u8; 32],
    pub proof: &'a [u8],
}

impl<'a> Boundary<'a> {
    pub const LEN: usize = BOUNDARY_LEN;

    /// Split a boundary the way §3 lays it out. None on a wrong length, so a truncated boundary cannot be read
    /// as a shorter valid one.
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() != BOUNDARY_LEN {
            return None;
        }
        let mut c_secp = [0u8; 33];
        c_secp.copy_from_slice(&bytes[..33]);
        let mut c_bjj = [0u8; 32];
        c_bjj.copy_from_slice(&bytes[33..65]);
        Some(Self {
            c_secp,
            c_bjj,
            proof: &bytes[65..],
        })
    }
}

/// One pool exit as §3 encodes it: `exit_vout(4) ‖ dest_spk_hash(32) ‖ boundary(825)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpendExit<'a> {
    pub exit_vout: u32,
    pub dest_spk_hash: [u8; 32],
    pub boundary: Boundary<'a>,
}

impl<'a> SpendExit<'a> {
    fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() != EXIT_LEN {
            return None;
        }
        Some(Self {
            exit_vout: u32::from_le_bytes(bytes[..4].try_into().ok()?),
            dest_spk_hash: bytes[4..36].try_into().ok()?,
            boundary: Boundary::parse(&bytes[36..])?,
        })
    }
}

/// A parsed `T_BTC_SPEND` body (everything before `proof_len`), plus the pool proof the caller must verify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendBody<'a> {
    pub asset: [u8; 32],
    pub h_anchor: u32,
    pub bind: [u8; BIND_LEN],
    pub nullifiers: Vec<[u8; 32]>,
    /// `leaf(32) ‖ pk_eph(33) ‖ ct_note(24)` per output, kept raw: this crate never opens a note.
    pub outputs: Vec<[u8; POOL_OUTPUT_LEN]>,
    pub exit: Option<SpendExit<'a>>,
    pub want: Option<[u8; WANT_LEN]>,
    /// The proof bytes carried after `proof_len`.
    pub proof: &'a [u8],
    /// The canonical body bytes (through `has_want`/`want`), i.e. exactly what the spend message hashes.
    pub body: &'a [u8],
}

/// A parsed `T_BTC_SHIELD` body (everything before `kernel_sig`), plus the pool proof the caller must verify.
///
/// Layout (§3): `0x6C ‖ asset ‖ n_in ‖ n_out ‖ output×n_out ‖ boundary ‖ kernel_sig ‖ proof_len(2) ‖ proof`.
pub struct ShieldBody<'a> {
    pub asset: [u8; 32],
    pub outputs: Vec<[u8; POOL_OUTPUT_LEN]>,
    pub boundary: Boundary<'a>,
    pub kernel_sig: [u8; KERNEL_SIG_LEN],
    /// The proof bytes carried after `proof_len`.
    pub proof: &'a [u8],
    /// The canonical body bytes (through `boundary`), i.e. what the shield message hashes.
    pub body: &'a [u8],
}

impl<'a> ShieldBody<'a> {
    /// Read the layout §3 gives for `0x6C`. Rejects a wrong opcode, `n_in ∉ [1, 8]`, `n_out ∉ [1, 3]`,
    /// `proof_len > 4096`, and trailing bytes, so a truncated payload cannot be read as a shorter valid one.
    pub fn parse(payload: &'a [u8]) -> Option<Self> {
        let mut p = 0usize;
        let take = |n: usize, p: &mut usize| -> Option<&[u8]> {
            let end = p.checked_add(n)?;
            let s = payload.get(*p..end)?;
            *p = end;
            Some(s)
        };
        if *take(1, &mut p)?.first()? != T_BTC_SHIELD {
            return None;
        }
        let asset: [u8; 32] = take(32, &mut p)?.try_into().ok()?;
        let n_in = *take(1, &mut p)?.first()? as usize;
        if n_in < 1 || n_in > SHIELD_MAX_IN {
            return None;
        }
        let n_out = *take(1, &mut p)?.first()? as usize;
        if n_out < 1 || n_out > SPEND_MAX_OUT {
            return None;
        }
        let mut outputs = Vec::with_capacity(n_out);
        for _ in 0..n_out {
            outputs.push(take(POOL_OUTPUT_LEN, &mut p)?.try_into().ok()?);
        }
        let boundary = Boundary::parse(take(BOUNDARY_LEN, &mut p)?)?;
        let body = &payload[..p];
        let kernel_sig: [u8; KERNEL_SIG_LEN] = take(KERNEL_SIG_LEN, &mut p)?.try_into().ok()?;
        let proof_len = u16::from_le_bytes(take(2, &mut p)?.try_into().ok()?) as usize;
        if proof_len > PROOF_MAX {
            return None;
        }
        let proof = take(proof_len, &mut p)?;
        if p != payload.len() {
            return None; // trailing bytes: the payload is not what it claims to be
        }
        Some(Self {
            asset,
            outputs,
            boundary,
            kernel_sig,
            proof,
            body,
        })
    }
}

/// Read a `T_BTC_SPEND` payload: `0x6D ‖ asset ‖ h_anchor ‖ bind ‖ n_in ‖ nf×n_in ‖ n_out ‖ output×n_out ‖
/// has_exit ‖ [exit] ‖ has_want ‖ [want] ‖ proof_len(2) ‖ proof`.
///
/// Rejects, in §3's order: a wrong opcode, `n_in ∉ [1, 2]`, `n_out > 3`, a field that is not canonical (a zero
/// nullifier, or one repeated within the same spend), `has_exit`/`has_want` outside `{0, 1}`,
/// `n_out + has_exit < 1`, `proof_len > 4096`, and a payload whose declared proof length does not exactly
/// consume the rest. Total and non-panicking on hostile input.
pub fn parse_spend(payload: &[u8]) -> Option<SpendBody<'_>> {
    let mut p = 0usize;
    let take = |n: usize, p: &mut usize| -> Option<&[u8]> {
        let end = p.checked_add(n)?;
        let s = payload.get(*p..end)?;
        *p = end;
        Some(s)
    };

    if *take(1, &mut p)?.first()? != T_BTC_SPEND {
        return None;
    }
    let asset: [u8; 32] = take(32, &mut p)?.try_into().ok()?;
    let h_anchor = u32::from_le_bytes(take(4, &mut p)?.try_into().ok()?);
    let bind: [u8; BIND_LEN] = take(BIND_LEN, &mut p)?.try_into().ok()?;

    let n_in = *take(1, &mut p)?.first()? as usize;
    if n_in == 0 || n_in > SPEND_MAX_IN {
        return None;
    }
    let mut nullifiers: Vec<[u8; 32]> = Vec::with_capacity(n_in);
    for _ in 0..n_in {
        let nf: [u8; 32] = take(32, &mut p)?.try_into().ok()?;
        if nf == [0u8; 32] {
            return None; // a zero nullifier is not a field element any honest wallet emits
        }
        if nullifiers.contains(&nf) {
            return None; // the pool relation rejects a repeated nullifier; refuse before the seam sees it
        }
        nullifiers.push(nf);
    }

    let n_out = *take(1, &mut p)?.first()? as usize;
    if n_out > SPEND_MAX_OUT {
        return None;
    }
    let mut outputs: Vec<[u8; POOL_OUTPUT_LEN]> = Vec::with_capacity(n_out);
    for _ in 0..n_out {
        outputs.push(take(POOL_OUTPUT_LEN, &mut p)?.try_into().ok()?);
    }

    let exit = match *take(1, &mut p)?.first()? {
        0 => None,
        1 => Some(SpendExit::parse(take(EXIT_LEN, &mut p)?)?),
        _ => return None,
    };
    let want: Option<[u8; WANT_LEN]> = match *take(1, &mut p)?.first()? {
        0 => None,
        1 => Some(take(WANT_LEN, &mut p)?.try_into().ok()?),
        _ => return None,
    };
    if n_out == 0 && exit.is_none() {
        return None; // a spend that creates nothing is not an exit and moves no pool value out
    }
    let body = payload.get(..p)?;

    let proof_len = u16::from_le_bytes(take(2, &mut p)?.try_into().ok()?) as usize;
    // `proof_len = 0` is legal: a proofless spend covered later in the same carrier by one `T_BTC_AGG`
    // (0x6E), whose single proof binds every covered spend's publics
    // (`worker/src/btc-shielded-pool.js` aggregateFor). The fold's `pool_ok` seam is what decides whether
    // that aggregate verified; refusing the shape here would silently drop every aggregated spend.
    if proof_len > PROOF_MAX {
        return None;
    }
    let proof = take(proof_len, &mut p)?;
    if p != payload.len() {
        return None; // trailing bytes: the payload is not what it claims to be
    }

    Some(SpendBody {
        asset,
        h_anchor,
        bind,
        nullifiers,
        outputs,
        exit,
        want,
        proof,
        body,
    })
}

// ───────────────────────────── exits ─────────────────────────────

/// One pool exit the fold is handed, with the Bitcoin authentication a provenance CXFER already carries. Every
/// field is either read back out of the confirmed transaction or attested by the caller's header chain —
/// nothing is a free witness.
#[derive(Clone, Debug)]
pub struct ExitWitness {
    /// The carrier transaction holding the `T_BTC_SPEND` envelope, full bytes with witness: its txid and its
    /// envelope are read from it, never witnessed beside it.
    pub tx: Vec<u8>,
    /// The input whose witness carries the envelope. A `T_BTC_SPEND` may ride any such input, so one carrier
    /// can hold many users' spends.
    pub vin: usize,
    /// BIP141 witness authentication, exactly as a provenance CXFER is authenticated.
    pub wtxid_siblings: Vec<[u8; 32]>,
    pub coinbase: Vec<u8>,
    pub coinbase_txid_siblings: Vec<[u8; 32]>,
    /// Inclusion of `tx` in `confirmed_block_root`.
    pub merkle_index: u32,
    pub merkle_siblings: Vec<[u8; 32]>,
    pub confirmed_block_root: [u8; 32],
    /// The pool note-tree root the spend was proven against (`h_anchor`), as the indexer committed it at that
    /// height.
    pub pool_root: [u8; 32],
    /// The exit note's opening. Public once the exit is on Bitcoin: an exit carries no `ct_note`, so the
    /// exiter reveals the opening to claim the note (`DESIGN-btc-shielded-pool.md` §3), and the rule here
    /// binds that claim to the commitment the spend created. A wrong opening is refused rather than skipped.
    pub value: u64,
    pub blinding: [u8; 32],
}

/// Reject an exit the live pool would refuse inside a carrier whose first input holds a transparent Tacit
/// operation.
///
/// Mirrors `worker/src/btc-shielded-pool.js`: `carrierPoolEnvelopes` classifies the vin[0] envelope, and
/// `acceptSpend` refuses an exit when it is not itself a pool op (`T_BTC_SHIELD` or `T_BTC_SPEND`). A
/// `T_BTC_AGG` on vin[0] counts as a foreign op there, so it counts as one here. Reading an exit out of such
/// a carrier would book backing for a note the pool's own fold never creates.
///
/// Absent envelope means no transparent op, which is the common case: a pool spend rides any input and its
/// carrier's first input is usually a plain fee coin.
fn vin0_holds_a_transparent_op(tx: &[u8]) -> bool {
    match envelope_of_input(tx, 0) {
        None => false,
        // An empty payload cannot be a pool op either; treat it as hostile rather than as absent.
        Some(p) => !matches!(p.first(), Some(&T_BTC_SHIELD) | Some(&T_BTC_SPEND)),
    }
}

/// Whether the carrier actually spends the outpoint the spend body binds, or the body binds none.
///
/// Mirrors `if (s.bind && !ctx.inputs.some(...)) return reject('carrier does not spend the bound outpoint')`.
/// `bind` is written in the same byte order a prevout uses (`bindBytes` in `dapp/btc-shielded-pool.js`
/// reverses the display txid), so the comparison is byte-exact against `extract_inputs`, with no hex
/// round-trip and no endianness decision for the caller to get wrong. All-zero means "no bind"; a body that
/// binds a txid the carrier does not spend is refused, because the binding is what lets a relayer's quote
/// name the coin that must fund its own envelope.
fn carrier_spends_bind(tx: &[u8], bind: &[u8; BIND_LEN]) -> bool {
    if *bind == [0u8; BIND_LEN] {
        return true;
    }
    let mut txid = [0u8; 32];
    txid.copy_from_slice(&bind[..32]);
    let vout = u32::from_le_bytes([bind[32], bind[33], bind[34], bind[35]]);
    match cxfer_core::bitcoin::extract_inputs(tx) {
        Some(inputs) => inputs.iter().any(|(t, v)| *t == txid && *v == vout),
        None => false, // unparseable inputs: fail closed, the carrier is not authenticated
    }
}

/// Whether any other envelope in this carrier already claims `vout`, as an exit or a want.
///
/// Mirrors the worker's `claimed(vout)` set, which is keyed on `(carrier txid, vout)` and is therefore
/// same-carrier by construction: `this.exits` holds exits accepted from this txid and `b.wants` holds wants
/// claimed in this txid. A want claimed by a *different* carrier lives under a different key there, so this
/// scan is the whole of that rule and not a narrowing of it.
///
/// This is what `read_exit` could not do while it saw one body: two exits in one carrier naming the same
/// `exit_vout` both parsed, and the ledger's outpoint set would only catch them after the fact. Checking the
/// carrier refuses both, which is the worker's behaviour and fails closed at the read step.
fn carrier_claims_vout(tx: &[u8], our_vin: usize, vout: u32) -> bool {
    let inputs = match cxfer_core::bitcoin::extract_inputs(tx) {
        Some(i) => i,
        None => return true, // unparseable carrier: fail closed
    };
    for vin in 0..inputs.len() {
        let payload = match envelope_of_input(tx, vin) {
            Some(p) => p,
            None => continue, // that input carries no Tacit op
        };
        let body = match parse_spend(&payload) {
            Some(b) => b,
            None => continue, // not a T_BTC_SPEND: it claims no outpoint of this carrier
        };
        if vin != our_vin {
            if let Some(e) = body.exit {
                if e.exit_vout == vout {
                    return true; // another spend already names this output as its exit
                }
            }
        }
        if let Some(w) = body.want {
            if u32::from_le_bytes([w[0], w[1], w[2], w[3]]) == vout {
                return true; // a want names it, whether that want is ours or another input's
            }
        }
    }
    false
}

/// An exit the rules admitted: the transparent note the provenance DAG may bottom out at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExitAnchor {
    /// `outpoint_key(txid, exit_vout)`: where the exited note sits, the same key the reflection's UTXO set uses.
    pub outpoint: [u8; 32],
    /// `commitment_hash(Cx, Cy)` of the boundary's secp commitment — the note's identity for the DAG.
    pub commitment: [u8; 32],
    pub asset: [u8; 32],
    pub value: u64,
}

/// Read an exit out of a confirmed carrier and authenticate it back to the block's txid root.
///
/// Checks, in order: the transaction is in `confirmed_block_root`; its witnesses are the ones that block
/// committed (BIP141 — the check that stops a prover folding a counterfeit envelope into a real txid); the
/// envelope on input `vin` is a canonical `T_BTC_SPEND`; its asset is the one being folded; it has an exit; the
/// pool proof verified at `h_anchor` against `pool_root`; and the exit boundary opens to the claimed value.
/// Returns None on any failure — no partial acceptance and no "skip this one", because a skipped event is a
/// silent hole in the fold's accounting.
///
/// The caller must have checked that `confirmed_block_root` is on the header chain the batch anchored to and
/// that `pool_root` is the root the indexer committed at `h_anchor`; both are out of this crate's scope
/// (`fold_burn_deposit` already holds its chain the same way).
pub fn read_exit(
    w: &ExitWitness,
    asset: &[u8; 32],
    pool_ok: PoolProofCheck<'_>,
    boundary_ok: BoundaryCheck<'_>,
) -> Option<ExitAnchor> {
    let txid = cxfer_core::bitcoin::compute_txid(&w.tx)?;
    if cxfer_core::bitcoin::verify_merkle_path(&txid, &w.merkle_siblings, w.merkle_index)
        != w.confirmed_block_root
    {
        return None;
    }
    cxfer_core::bitcoin::verify_tx_witness_committed(
        &w.tx,
        w.merkle_index,
        &w.wtxid_siblings,
        &w.coinbase,
        &w.coinbase_txid_siblings,
        &w.confirmed_block_root,
    )?;

    let payload = envelope_of_input(&w.tx, w.vin)?;
    let body = parse_spend(&payload)?;
    if &body.asset != asset {
        return None; // a spend of another asset cannot back this fold
    }
    // The carrier must spend the coin the body binds, and must not carry a transparent Tacit op in vin[0].
    // Both are checks the live pool makes in the same block as the two below; without them this crate would
    // read an exit out of a transaction the pool's own fold refuses. See §10 risk 6.
    if !carrier_spends_bind(&w.tx, &body.bind) {
        return None; // the bound outpoint is not an input: the envelope names a carrier it does not ride
    }
    if vin0_holds_a_transparent_op(&w.tx) {
        return None; // vin[0] is a foreign Tacit op, so the pool never accepts this carrier's exit
    }
    if w.value == 0 {
        return None; // a zero-value exit backs nothing and would let a prover pad the anchor set
    }
    if !pool_ok(&body, &w.pool_root) {
        return None;
    }

    let exit = body.exit?;
    // An exit and a want naming the same output would give one UTXO two claims. The ledger catches the
    // exit-versus-exit case (`exited_at` is keyed on the outpoint), but not this one, and the live pool
    // refuses it explicitly: `want and exit name the same output`. Wants themselves are outside this crate —
    // it folds no want set — so a cross-body collision between an exit and another spend's want is the
    // residual §10 risk 6 still carries.
    if let Some(want) = body.want {
        let want_vout = u32::from_le_bytes([want[0], want[1], want[2], want[3]]);
        if want_vout == exit.exit_vout {
            return None;
        }
    }
    // No other envelope in this carrier may already claim the same output, as an exit or a want. This is the
    // worker's `claimed(vout)` rule and it is the check that catches two exits naming one vout — the ledger's
    // `exited_at` set would only catch that after both were read.
    if carrier_claims_vout(&w.tx, w.vin, exit.exit_vout) {
        return None;
    }
    // The exit must name a REAL output of this carrier, and that output's script must hash to
    // `dest_spk_hash`. Without these two checks `exit_vout` and `dest_spk_hash` would be free witnesses:
    // a prover could name vout 7 on a one-output carrier, or fork one confirmed exit into unlimited
    // distinct anchors by varying `exit_vout`, and each would debit the ledger. Mirrors
    // `worker/src/btc-shielded-pool.js` (`exit_vout is not an output of the carrier`,
    // `exit scriptPubKey does not match dest_spk_hash`) and `DESIGN-btc-shielded-pool.md` §3.
    let (_value, spk) = cxfer_core::bitcoin::parse_tx_output(&w.tx, exit.exit_vout)?;
    if cxfer_core::bitcoin::sha256_once(&spk) != exit.dest_spk_hash {
        return None; // the exit pays to a script the body did not commit to
    }
    if !boundary_ok(&exit.boundary, w.value, &w.blinding) {
        return None; // the opening must be the commitment the exit actually created
    }
    // The commitment the DAG keys on is the boundary's secp point, decompressed and hashed — the same
    // `commitment_hash` the reflection stores for a transparent note.
    let commitment = commitment_hash_compressed(&exit.boundary.c_secp)?;

    Some(ExitAnchor {
        outpoint: outpoint_key(&txid, exit.exit_vout),
        commitment,
        asset: body.asset,
        value: w.value,
    })
}

/// Admit an anchor and debit the ledger. The whole "the fold accepts pool exits" rule.
///
/// One function, no knobs: a value the ledger does not hold is refused and nothing is booked, so the pool's own
/// state is untouched and the note stays spendable on Bitcoin. The asset is checked here as well as in
/// [`read_exit`], because a ledger is one asset (§2.1): an exit of one asset must not drain another's
/// backing, and `ExitAnchor` carries `asset` as a public field a caller can set to anything.
pub fn admit_exit(ledger: &mut BackingLedger, anchor: &ExitAnchor, asset: &[u8; 32]) -> Option<()> {
    if &anchor.asset != asset {
        return None; // an exit of another asset cannot drain this one's backing
    }
    ledger.debit(&anchor.outpoint, anchor.value)
}

// ───────────────────────────── long lineages ─────────────────────────────

/// How a lineage of `hops` proven transfers may be presented to the parser, whose cap is [`ANCHOR_MAX_HOPS`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lineage {
    /// Present it all: it fits inside the cap.
    Full { hops: u32, steps: u32 },
    /// Present from an admissible anchor down to the burn; `from` is that anchor's outpoint and `distance` the
    /// transfers between it and the burned note.
    Anchored {
        hops: u32,
        from: [u8; 32],
        distance: u32,
    },
    /// No admissible presentation: too long, and no anchor inside reach.
    Refused { hops: u32, cap: u32 },
}

/// The rule for the 256-step cap. `anchor` is the nearest admissible anchor the caller found (an admitted exit
/// note, a cmint leaf, or `C_0`) as `(outpoint, transfers between it and the burn)`.
///
/// A lineage that fits is presented whole — the existing path, unchanged. A longer one is presented from the
/// anchor instead, and the fold names the anchor rather than the etch. With no anchor inside the cap there is
/// nothing to present, so it refuses: a burn whose provenance cannot be shown is not mintable, which is the
/// conservative direction.
///
/// The bound is `hops <= ANCHOR_MAX_HOPS`, because `burn_deposit.rs` refuses only `ncx > 256`: a blob with
/// exactly 256 steps parses today, so it must keep parsing. A `>` here would tighten acceptance on a lineage
/// the current system already carries.
pub fn lineage(hops: u32, anchor: Option<([u8; 32], u32)>) -> Lineage {
    if hops <= ANCHOR_MAX_HOPS {
        return Lineage::Full { hops, steps: hops };
    }
    match anchor {
        Some((from, d)) if d <= ANCHOR_MAX_HOPS => Lineage::Anchored {
            hops,
            from,
            distance: d,
        },
        _ => Lineage::Refused {
            hops,
            cap: ANCHOR_MAX_HOPS,
        },
    }
}

/// The valid-leaf set the provenance DAG should be given for one burn: the leaves it already had, plus every
/// admitted anchor. `valid_leaves` grows and no acceptance rule is added, so a blob that presents no anchor
/// folds byte-for-byte as it does today.
///
/// An anchor is refused when the base set already carries its outpoint with a DIFFERENT commitment. Appending
/// it would give one outpoint two identities, and `verify_provenance_dag_leaves` resolves a hop against
/// `(outpoint, commitment)`, so the second identity would open a leaf the DAG had already resolved — the
/// outpoint-binding gap `reflect.rs` step 4 refuses pool-membership leaves for. The base set wins.
pub fn valid_leaves(
    base: &[([u8; 32], [u8; 32])],
    anchors: &[ExitAnchor],
) -> Vec<([u8; 32], [u8; 32])> {
    let mut out = base.to_vec();
    for a in anchors {
        let same_outpoint = out
            .iter()
            .any(|(o, c)| *o == a.outpoint && *c == a.commitment);
        let taken = out.iter().any(|(o, _)| *o == a.outpoint);
        if taken && !same_outpoint {
            continue; // the outpoint is already resolved to another commitment: refuse, do not fork
        }
        if !same_outpoint {
            out.push((a.outpoint, a.commitment));
        }
    }
    out
}

// ───────────────────────────── witness reading ─────────────────────────────

/// The payload a Tacit envelope rides on input `vin`: its second witness item, which is where every Tacit op's
/// envelope sits (`worker-relay/src/lib/btc-pool-chain.js` reads the same slot). Total and non-panicking.
fn envelope_of_input(tx: &[u8], vin: usize) -> Option<Vec<u8>> {
    decode_envelope_script(&witness_item(tx, vin, 1)?)
}

fn read_varint(data: &[u8], pos: usize) -> Option<(usize, usize)> {
    let b = *data.get(pos)?;
    match b {
        0..=0xfc => Some((b as usize, 1)),
        0xfd => Some((
            u16::from_le_bytes(data.get(pos + 1..pos + 3)?.try_into().ok()?) as usize,
            3,
        )),
        0xfe => Some((
            u32::from_le_bytes(data.get(pos + 1..pos + 5)?.try_into().ok()?) as usize,
            5,
        )),
        _ => usize::try_from(u64::from_le_bytes(
            data.get(pos + 1..pos + 9)?.try_into().ok()?,
        ))
        .ok()
        .map(|v| (v, 9)),
    }
}

/// `tx.witness[vin][index]`, walking the exact serialization: marker/flag, inputs (each `36 ‖ varint ‖
/// scriptSig ‖ 4`), outputs, then one witness stack per input in input order.
fn witness_item(tx: &[u8], vin: usize, index: usize) -> Option<Vec<u8>> {
    if tx.len() < 6 || tx[4] != 0x00 || tx[5] != 0x01 {
        return None; // legacy serialization: there is no witness section to read
    }
    let mut pos = 6usize;
    let (inputs, vl) = read_varint(tx, pos)?;
    if inputs == 0 || vin >= inputs {
        return None;
    }
    pos = pos.checked_add(vl)?;
    for _ in 0..inputs {
        pos = pos.checked_add(36)?;
        let (slen, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?.checked_add(slen)?.checked_add(4)?;
    }
    let (outputs, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    for _ in 0..outputs {
        pos = pos.checked_add(8)?;
        let (slen, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?.checked_add(slen)?;
    }
    for i in 0..inputs {
        let (items, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?;
        for k in 0..items {
            let (len, vl) = read_varint(tx, pos)?;
            pos = pos.checked_add(vl)?;
            let end = pos.checked_add(len)?;
            let item = tx.get(pos..end)?;
            if i == vin && k == index {
                return Some(item.to_vec());
            }
            pos = end;
        }
    }
    None
}

/// The envelope a Tacit witness item carries:
/// `<xonly(32)> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <pushes…> OP_ENDIF`, with the payload being the pushes
/// after the magic. Mirrors `decodeEnvelopeScript` in `worker-relay/src/lib/btc-pool-chain.js`, including its
/// rejection of trailing bytes, a missing `OP_ENDIF`, or a short magic.
fn decode_envelope_script(script: &[u8]) -> Option<Vec<u8>> {
    if script.len() < 36
        || script[0] != 0x20
        || script[33] != 0xac
        || script[34] != 0x00
        || script[35] != 0x63
    {
        return None;
    }
    let mut p = 36usize;
    let mut pushes: Vec<&[u8]> = Vec::new();
    let mut saw_endif = false;
    while p < script.len() {
        if script[p] == 0x68 {
            p += 1;
            saw_endif = true;
            break;
        }
        let op = script[p];
        p += 1;
        let len = match op {
            0x01..=0x4b => op as usize,
            0x4c => {
                let v = *script.get(p)? as usize;
                p += 1;
                v
            }
            0x4d => {
                let v = u16::from_le_bytes(script.get(p..p + 2)?.try_into().ok()?) as usize;
                p += 2;
                v
            }
            0x00 => 0,
            _ => return None,
        };
        let end = p.checked_add(len)?;
        pushes.push(script.get(p..end)?);
        p = end;
    }
    if !saw_endif || p != script.len() || pushes.len() < 3 {
        return None;
    }
    if pushes[0] != b"TACIT" || pushes[1].len() != 1 || pushes[1][0] != 0x01 {
        return None;
    }
    Some(pushes[2..].concat())
}

#[cfg(test)]
mod tests;
