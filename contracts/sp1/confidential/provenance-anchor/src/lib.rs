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
//! one more admissible leaf — no acceptance rule is added, and a blob that presents no anchor folds exactly as
//! it does today.
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

/// What a caller must prove about an exit's pool half: that the spend verified at `h_anchor` against
/// `pool_root` and is the spend this body describes. The fold injects its witness verification the same way,
/// so this crate never reimplements a proof system it cannot run offline.
pub type PoolProofCheck<'a> = &'a dyn Fn(&SpendBody<'_>, &[u8; 32]) -> bool;

/// What a caller must prove about a boundary: that its cross-curve sigma and range proofs verified and that its
/// commitment opens to `value` under `blinding`. Same seam discipline: the opening is checked by whoever can
/// run the curve math, this crate only consumes the answer.
pub type BoundaryCheck<'a> = &'a dyn Fn(&Boundary<'_>, u64, &[u8; 32]) -> bool;

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

    /// Credit a verified shield: the pool now holds `value` more. [`credit_shield`] is the checked form.
    ///
    /// Idempotent by `carrier` (the shield transaction's txid) for the same reason `debit` is: re-folding a
    /// block must not mint backing. Returns `None` and credits nothing on a repeat.
    pub fn fund(&mut self, carrier: &[u8; 32], value: u64) -> Option<()> {
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
/// pool took custody of). It refuses a shield that moved nothing and one whose boundary does not open to the
/// claimed total, so the ledger can never be funded by a figment.
pub fn credit_shield(
    ledger: &mut BackingLedger,
    carrier: &[u8; 32],
    boundary: &Boundary<'_>,
    shielded: u64,
    blinding: &[u8; 32],
    boundary_ok: BoundaryCheck<'_>,
) -> Option<()> {
    if shielded == 0 || !boundary_ok(boundary, shielded, blinding) {
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
        Some(Self { c_secp, c_bjj, proof: &bytes[65..] })
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

    Some(SpendBody { asset, h_anchor, bind, nullifiers, outputs, exit, want, proof, body })
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
    /// The exit note's opening. Public once the exit is on Bitcoin; the rule binds it to the commitment the
    /// spend created, so a wrong opening is refused rather than skipped.
    pub value: u64,
    pub blinding: [u8; 32],
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
    if cxfer_core::bitcoin::verify_merkle_path(&txid, &w.merkle_siblings, w.merkle_index) != w.confirmed_block_root {
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
    if w.value == 0 {
        return None; // a zero-value exit backs nothing and would let a prover pad the anchor set
    }
    if !pool_ok(&body, &w.pool_root) {
        return None;
    }

    let exit = body.exit?;
    if !boundary_ok(&exit.boundary, w.value, &w.blinding) {
        return None; // the opening must be the commitment the exit actually created
    }
    // The commitment the DAG keys on is the boundary's secp point, decompressed and hashed — the same
    // `commitment_hash` the reflection stores for a transparent note.
    let commitment = commitment_hash_compressed(&exit.boundary.c_secp)?;

    Some(ExitAnchor { outpoint: outpoint_key(&txid, exit.exit_vout), commitment, asset: body.asset, value: w.value })
}

/// Admit an anchor and debit the ledger. The whole "the fold accepts pool exits" rule.
///
/// One function, no knobs: a value the ledger does not hold is refused and nothing is booked, so the pool's own
/// state is untouched and the note stays spendable on Bitcoin.
pub fn admit_exit(ledger: &mut BackingLedger, anchor: &ExitAnchor) -> Option<()> {
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
    Anchored { hops: u32, from: [u8; 32], distance: u32 },
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
pub fn lineage(hops: u32, anchor: Option<([u8; 32], u32)>) -> Lineage {
    if hops < ANCHOR_MAX_HOPS {
        return Lineage::Full { hops, steps: hops };
    }
    match anchor {
        Some((from, d)) if d < ANCHOR_MAX_HOPS => Lineage::Anchored { hops, from, distance: d },
        _ => Lineage::Refused { hops, cap: ANCHOR_MAX_HOPS },
    }
}

/// The valid-leaf set the provenance DAG should be given for one burn: the leaves it already had, plus every
/// admitted anchor. This is the entire wiring change — `valid_leaves` grows and no acceptance rule is added, so
/// a blob that presents no anchor folds byte-for-byte as it does today.
pub fn valid_leaves(base: &[([u8; 32], [u8; 32])], anchors: &[ExitAnchor]) -> Vec<([u8; 32], [u8; 32])> {
    let mut out = base.to_vec();
    for a in anchors {
        if !out.iter().any(|(o, c)| *o == a.outpoint && *c == a.commitment) {
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
        0xfd => Some((u16::from_le_bytes(data.get(pos + 1..pos + 3)?.try_into().ok()?) as usize, 3)),
        0xfe => Some((u32::from_le_bytes(data.get(pos + 1..pos + 5)?.try_into().ok()?) as usize, 5)),
        _ => usize::try_from(u64::from_le_bytes(data.get(pos + 1..pos + 9)?.try_into().ok()?))
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
    if script.len() < 36 || script[0] != 0x20 || script[33] != 0xac || script[34] != 0x00 || script[35] != 0x63 {
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
