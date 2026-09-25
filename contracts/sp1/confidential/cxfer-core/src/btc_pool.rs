//! Bitcoin-native shielded pool: the note leaf shared by `T_BTC_SHIELD` (0x6C) and `T_BTC_SPEND` (0x6D), the
//! spend-authorization message, and the `T_BTC_SPEND` relation the btc-pool guest proves.
//! See DESIGN-btc-shielded-pool.md §2–§4 and DESIGN-btc-shielded-pool-security.md §2–§3.
//!
//! Pure verification, no SP1 deps: the guest (src/btc_pool.rs) reads the witness, calls
//! `verify_btc_pool_spend`, and commits the returned statement.

use crate::{
    compress, decompress, from_affine_xy, keccak_bytes, keccak_merkle_verify, kn, scalar_reduce_be,
    verify_pedersen_opening,
};
use k256::elliptic_curve::group::Group; // ProjectivePoint::generator() needs this in scope on the RISC-V target (sp1-lib)
use k256::ProjectivePoint;

/// Leaf domain for a shielded-pool note (design §2). Disjoint from the Bitcoin-homed `btc_note_leaf`
/// ("tacit-btc-note-v1") and the native `leaf`, so a pool note never reconstructs as either.
pub const BTC_POOL_NOTE_DOMAIN: &[u8] = b"tacit-btc-pool-note-v1";
/// Domain of `nf_secret = keccak("tacit-btc-pool-nf-v1" ‖ sk_note)` (design §2). Folding a value derived
/// from the private spend secret into the nullifier is what makes it unprecomputable from public note
/// fields alone — see `btc_pool_nullifier` below.
pub const BTC_POOL_NF_DOMAIN: &[u8] = b"tacit-btc-pool-nf-v1";
/// `T_BTC_SPEND`'s own opcode byte, the first byte of `canonical_body` (design §3/§4) — binds the
/// signature to this opcode specifically, so a `canonical_body` can never be reinterpreted as some other
/// envelope's signed bytes.
pub const T_BTC_SPEND_OPCODE: u8 = 0x6D;
/// `out_kind` tags (design §3).
pub const BTC_POOL_OUT_PAY: u8 = 0x00;
pub const BTC_POOL_OUT_EXIT: u8 = 0x01;
/// v1 arity caps (design §3, "Resolved for v1").
pub const BTC_POOL_MAX_IN: usize = 2;
pub const BTC_POOL_MAX_OUT: usize = 2;

/// leaf = keccak(asset ‖ Cx ‖ Cy ‖ spend_key ‖ "tacit-btc-pool-note-v1") (design §2). Every field this
/// depends on is published in plaintext at creation, so the leaf alone is public and precomputable — the
/// nullifier deliberately does NOT reuse this formula (see `btc_pool_nullifier` below): the generic
/// `crate::nullifier(leaf) = keccak(leaf‖"spent")` used by Bitcoin-homed notes would be precomputable by any
/// passive observer here, a real privacy break for this note type (design §2).
pub fn btc_pool_note_leaf(asset: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], spend_key: &[u8; 32]) -> [u8; 32] {
    kn(&[asset, cx, cy, spend_key, BTC_POOL_NOTE_DOMAIN])
}

/// `nf_secret = keccak("tacit-btc-pool-nf-v1" ‖ sk_note)` (design §2). Only the note's owner can compute
/// this, since it requires the private `sk_note` — never derivable from the public `spend_key` alone
/// (security doc A5/A5a).
pub fn btc_pool_nf_secret(sk_note: &[u8; 32]) -> [u8; 32] {
    kn(&[BTC_POOL_NF_DOMAIN, sk_note])
}

/// `nullifier = keccak(leaf ‖ nf_secret ‖ "spent")` (design §2/§4) — this pool's own nullifier formula,
/// distinct from the generic `crate::nullifier(leaf) = keccak(leaf‖"spent")` used by Bitcoin-homed notes.
/// Folding in `nf_secret` (derivable only from the private `sk_note`) is what makes the nullifier
/// unprecomputable from `leaf`'s public preimage alone.
pub fn btc_pool_nullifier(leaf: &[u8; 32], nf_secret: &[u8; 32]) -> [u8; 32] {
    kn(&[leaf, nf_secret, b"spent"])
}

/// One created output's public fields as they appear in the envelope and in `canonical_body` (design §3
/// pay case): `Cx‖Cy‖pk_eph‖spend_key‖ct_note`, in that order.
pub type BtcPoolOutFields = ([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 56]);

/// `canonical_body` per design §4 — the exact byte encoding every input's `spend_key` signs (over
/// `h_body`, below). This precise layout isn't spelled out byte-for-byte in the design doc's prose; it is
/// authoritative here:
///
/// ```text
/// canonical_body = 0x6D(1) ‖ asset(32) ‖ n_in(1) ‖ nf[32×n_in](32 each) ‖ out_kind(1)
///   if out_kind = 0x00 (pay):  n_out(1) ‖ (Cx(32)‖Cy(32)‖pk_eph(32)‖spend_key(32)‖ct_note(56)) × n_out
///   if out_kind = 0x01 (exit): exit_vout(4 BE) ‖ dest_spk_hash(32)
///   ‖ h_anchor(4 BE)
/// h_body = keccak(canonical_body)
/// ```
///
/// One hash over the *whole* envelope instead of a hand-picked field list (security doc G5): enumerating
/// "nullifiers, output leaves, fee, h_anchor" would leave
/// `pk_eph`/`ct_note` and the exit destination unbound. `nf[]` and, for a pay, each output's fields are
/// serialized in-order with no extra length prefix beyond the single leading `n_in`/`n_out` count byte —
/// consistent with the envelope's own encoding (design §3), which is itself already unambiguous because
/// every element has a fixed width; this mirrors how `T_CXFER`'s own kernel-message construction in
/// `bitcoin.rs` treats same-width lists (count once, then concatenate, no per-element length tag).
///
/// `dest_spk_hash` closes a second exit-only requirement (security doc G3): `exit_vout`/`exit_value`
/// bind *which output index* and *how much*, but nothing else binds *whose scriptPubKey* it pays — a signed
/// envelope+proof could be lifted into a different carrier transaction whose `exit_vout` still names the
/// right index and value but a different, attacker-controlled destination script. Including
/// `dest_spk_hash` here signs it under every input's `spend_key` exactly like every other field; the
/// indexer separately checks it against the real output's actual scriptPubKey hash (design §10 step 2a) —
/// that chain-data comparison is intentionally not an in-circuit check, same as `exit_value` isn't compared
/// against the real output inside the circuit either.
pub fn btc_pool_h_body(
    asset: &[u8; 32],
    nullifiers: &[[u8; 32]],
    out_kind: u8,
    outputs: &[BtcPoolOutFields],
    exit_vout: Option<u32>,
    dest_spk_hash: Option<[u8; 32]>,
    h_anchor: u32,
) -> [u8; 32] {
    let mut body = Vec::with_capacity(1 + 32 + 1 + nullifiers.len() * 32 + 1 + 4 + 32 + outputs.len() * 176 + 4);
    body.push(T_BTC_SPEND_OPCODE);
    body.extend_from_slice(asset);
    body.push(nullifiers.len() as u8);
    for nf in nullifiers {
        body.extend_from_slice(nf);
    }
    body.push(out_kind);
    if out_kind == BTC_POOL_OUT_PAY {
        body.push(outputs.len() as u8);
        for (cx, cy, pk_eph, spend_key, ct_note) in outputs {
            body.extend_from_slice(cx);
            body.extend_from_slice(cy);
            body.extend_from_slice(pk_eph);
            body.extend_from_slice(spend_key);
            body.extend_from_slice(ct_note);
        }
    } else {
        body.extend_from_slice(&exit_vout.unwrap_or(0).to_be_bytes());
        body.extend_from_slice(&dest_spk_hash.unwrap_or([0u8; 32]));
    }
    body.extend_from_slice(&h_anchor.to_be_bytes());
    keccak_bytes(&body)
}

/// One spent note (private witness, design §4 / security §3).
#[derive(Clone, Debug)]
pub struct BtcPoolSpendInput {
    /// Note commitment C = value·H + blinding·G, affine big-endian (design §2 leaf preimage).
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    /// The note's one-time x-only spend key (design §2), bound in its leaf at shield/spend time.
    pub spend_key: [u8; 32],
    /// Pedersen opening of C (the `ct_note` plaintext, design §3).
    pub value: u64,
    pub blinding: [u8; 32],
    /// Position of the leaf in the Bitcoin-only tree and its depth-32 keccak path (design §4 membership).
    pub leaf_index: u64,
    pub path: Vec<[u8; 32]>,
    /// The note's private one-time spend secret (design §2/§4): witnessed directly and constrained
    /// in-circuit as `spend_key = sk_note·G`, replacing a detached BIP-340 signature. Also the input to
    /// `nf_secret` (`btc_pool_nf_secret`), which is what makes this note's nullifier unprecomputable by an
    /// outside observer.
    pub sk_note: [u8; 32],
}

/// One created note (pay case only, design §3). `(cx, cy, pk_eph, spend_key, ct_note)` are all public —
/// they are the envelope's per-output fields, and all five are committed into `h_body` (design §4).
/// `(value, blinding)` are the private Pedersen opening `ct_note` encrypts.
#[derive(Clone, Debug)]
pub struct BtcPoolSpendOutput {
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    /// One-time ECDH ephemeral public key for this output's stealth `spend_key` (design §2).
    pub pk_eph: [u8; 32],
    pub spend_key: [u8; 32],
    /// AEAD(shared-secret key, plaintext = v(8)‖r(32), 16-byte tag) — the recipient's later spend opening
    /// (design §3). Opaque to the relation: carried through untouched, bound into `h_body` only.
    pub ct_note: [u8; 56],
    pub value: u64,
    pub blinding: [u8; 32],
}

/// The full guest input. `asset`, `root`, `h_anchor`, `out_kind`, and (for an exit) `exit_vout`/
/// `exit_value` are public statement fields (committed verbatim); everything in `inputs` and the openings
/// in `outputs` are private. No `fee` field — conservation is `Σv_in = Σv_out` (pay) or
/// `Σv_in = exit_value` (exit), design §3.
#[derive(Clone, Debug)]
pub struct BtcPoolSpendWitness {
    /// Pool asset id every input and output leaf is built under (design §2 leaf preimage).
    pub asset: [u8; 32],
    /// Retained tree root the indexer holds for `h_anchor` (design §3/§10 step 4). Membership is checked
    /// against it; the indexer checks it equals its own root at `h_anchor`.
    pub root: [u8; 32],
    /// Anchor block height (design §3 `h_anchor`, §10 window).
    pub h_anchor: u32,
    /// `0x00` = pay (creates `outputs`), `0x01` = exit (redeems into `exit_vout`, no new leaf) — design §3.
    pub out_kind: u8,
    pub inputs: Vec<BtcPoolSpendInput>,
    /// Pay case only; must be empty when `out_kind == BTC_POOL_OUT_EXIT`.
    pub outputs: Vec<BtcPoolSpendOutput>,
    /// Exit case only: which of this transaction's real Bitcoin outputs receives the redeemed value
    /// (design §3 `exit_vout`).
    pub exit_vout: Option<u32>,
    /// Exit case only: the value that output pays, supplied by the host and checked here against
    /// `Σv_in`. The indexer separately checks this equals the real output's Bitcoin-consensus value
    /// (the same atomicity check as `T_BTC_SHIELD`'s `lock_vout`, design §3) — this relation only enforces
    /// that the spent notes conserve into whatever value is claimed here.
    pub exit_value: u64,
    /// Exit case only: hash of the scriptPubKey `exit_vout` must actually pay (design §3/§10 step 2a).
    /// Signed via `h_body` like every other field; the indexer separately checks it against the real
    /// output's actual scriptPubKey hash — this relation only threads it through.
    pub dest_spk_hash: Option<[u8; 32]>,
}

/// The public statement an accepting proof establishes (design §10 step 5): the indexer compares these to
/// the envelope and its own replayed state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtcPoolSpendStatement {
    pub asset: [u8; 32],
    pub root: [u8; 32],
    pub h_anchor: u32,
    pub out_kind: u8,
    /// nf_i = keccak(leaf_i ‖ nf_secret_i ‖ "spent"), in input order (design §3 `nf[]`).
    pub nullifiers: Vec<[u8; 32]>,
    /// (Cx, Cy, pk_eph, spend_key, ct_note) per output, in output order (design §3 per-output fields).
    /// Empty for an exit.
    pub outputs: Vec<BtcPoolOutFields>,
    /// btc_pool_note_leaf of each output, in output order. Empty for an exit.
    pub out_leaves: Vec<[u8; 32]>,
    pub exit_vout: Option<u32>,
    pub exit_value: u64,
    /// Exit case only: hash of the scriptPubKey `exit_vout` must actually pay (design §3/§10 step 2a).
    /// Empty for a pay.
    pub dest_spk_hash: Option<[u8; 32]>,
}

fn opens(cx: &[u8; 32], cy: &[u8; 32], value: u64, blinding: &[u8; 32]) -> bool {
    match from_affine_xy(cx, cy) {
        Some(c) => verify_pedersen_opening(&c, value, &scalar_reduce_be(blinding)),
        None => false,
    }
}

fn is_xonly_key(k: &[u8; 32]) -> bool {
    let mut comp = [0u8; 33];
    comp[0] = 0x02;
    comp[1..].copy_from_slice(k);
    decompress(&comp).is_some()
}

/// The `T_BTC_SPEND` relation (design §4, security §3). For each input: C opens to (value, blinding), the
/// leaf is a member of `root`, `spend_key = sk_note·G` for the witnessed `sk_note` (authorization, design
/// §2/§4), and nf = `btc_pool_nullifier(leaf, nf_secret)` where `nf_secret = btc_pool_nf_secret(sk_note)`.
/// Pay case: for each output, C opens to (value, blinding), `spend_key` is an x-only key, and the leaf is
/// derived from (asset, Cx, Cy, spend_key); `Σv_in = Σv_out`. Exit case: no outputs, `Σv_in = exit_value`.
/// `h_body` (`btc_pool_h_body`, design §4) commits the whole canonical envelope — asset, every nullifier,
/// `out_kind`, every output's full contents (pay) or `exit_vout`/`dest_spk_hash` (exit), and `h_anchor` — as
/// a public SP1 input; that alone makes the envelope tamper-evident (design §4), so no separate signature
/// is needed for non-malleability. Returns the public statement on success.
pub fn verify_btc_pool_spend(w: &BtcPoolSpendWitness) -> Result<BtcPoolSpendStatement, &'static str> {
    let n_in = w.inputs.len();
    if n_in == 0 || n_in > BTC_POOL_MAX_IN {
        return Err("btc-pool: input count out of range");
    }
    if w.root == [0u8; 32] {
        return Err("btc-pool: zero root");
    }
    if w.out_kind != BTC_POOL_OUT_PAY && w.out_kind != BTC_POOL_OUT_EXIT {
        return Err("btc-pool: bad out_kind");
    }

    let mut nullifiers: Vec<[u8; 32]> = Vec::with_capacity(n_in);
    let mut sum_in: u128 = 0;
    for i in &w.inputs {
        if !opens(&i.cx, &i.cy, i.value, &i.blinding) {
            return Err("btc-pool: input opening");
        }
        let expected_spend_key = {
            let p = ProjectivePoint::generator() * scalar_reduce_be(&i.sk_note);
            let c = compress(&p);
            // `spend_key` is x-only, so both `sk_note = d` and `sk_note = n-d` satisfy the equality check
            // below (same x-coordinate, same spend_key) but hash to different `nf_secret`/nullifiers for the
            // same note — a double-spend via two different valid proofs (design §2, security doc A5
            // "Canonical witness requirement" / G2). Require the witnessed `sk_note` to already be the
            // canonical even-y representative of its point, not just any scalar whose point's x-coordinate
            // matches.
            if c[0] != 0x02 {
                return Err("btc-pool: sk_note is not the canonical even-y representative");
            }
            let mut x = [0u8; 32];
            x.copy_from_slice(&c[1..]);
            x
        };
        if expected_spend_key != i.spend_key {
            return Err("btc-pool: spend_key does not match sk_note");
        }
        let lf = btc_pool_note_leaf(&w.asset, &i.cx, &i.cy, &i.spend_key);
        if !keccak_merkle_verify(&lf, i.leaf_index, &i.path, &w.root) {
            return Err("btc-pool: input membership");
        }
        let nf_secret = btc_pool_nf_secret(&i.sk_note);
        let nf = btc_pool_nullifier(&lf, &nf_secret);
        if nullifiers.contains(&nf) {
            return Err("btc-pool: repeated nullifier");
        }
        nullifiers.push(nf);
        sum_in += i.value as u128;
    }

    let (outputs, out_leaves, exit_vout, exit_value, dest_spk_hash) = if w.out_kind == BTC_POOL_OUT_PAY {
        let n_out = w.outputs.len();
        if n_out == 0 || n_out > BTC_POOL_MAX_OUT {
            return Err("btc-pool: output count out of range");
        }
        if w.exit_vout.is_some() {
            return Err("btc-pool: exit_vout set on a pay");
        }
        if w.dest_spk_hash.is_some() {
            return Err("btc-pool: dest_spk_hash set on a pay");
        }
        let mut outputs: Vec<BtcPoolOutFields> = Vec::with_capacity(n_out);
        let mut out_leaves: Vec<[u8; 32]> = Vec::with_capacity(n_out);
        let mut sum_out: u128 = 0;
        for o in &w.outputs {
            if !opens(&o.cx, &o.cy, o.value, &o.blinding) {
                return Err("btc-pool: output opening");
            }
            if !is_xonly_key(&o.spend_key) {
                return Err("btc-pool: output spend_key not an x-only key");
            }
            outputs.push((o.cx, o.cy, o.pk_eph, o.spend_key, o.ct_note));
            out_leaves.push(btc_pool_note_leaf(&w.asset, &o.cx, &o.cy, &o.spend_key));
            sum_out += o.value as u128;
        }
        if sum_in != sum_out {
            return Err("btc-pool: conservation");
        }
        (outputs, out_leaves, None, 0u64, None)
    } else {
        if !w.outputs.is_empty() {
            return Err("btc-pool: outputs set on an exit");
        }
        let exit_vout = w.exit_vout.ok_or("btc-pool: missing exit_vout")?;
        let dest_spk_hash = w.dest_spk_hash.ok_or("btc-pool: missing dest_spk_hash")?;
        if sum_in != w.exit_value as u128 {
            return Err("btc-pool: conservation");
        }
        (Vec::new(), Vec::new(), Some(exit_vout), w.exit_value, Some(dest_spk_hash))
    };

    Ok(BtcPoolSpendStatement {
        asset: w.asset,
        root: w.root,
        h_anchor: w.h_anchor,
        out_kind: w.out_kind,
        nullifiers,
        outputs,
        out_leaves,
        exit_vout,
        exit_value,
        dest_spk_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compress, merkle_root_from, pedersen_commit_xy, KeccakTreeAccumulator};
    use k256::ProjectivePoint;

    const ASSET: [u8; 32] = [0xB7u8; 32];

    /// `sk_note` -> its x-only public spend key, `spend_key = sk_note·G`'s x-coordinate (design §2/§4).
    /// x-only, so it's sign-agnostic: fine for an OUTPUT's `spend_key` (only ever checked with
    /// `is_xonly_key`, never witnessed as a scalar), but NOT for a value that will be witnessed as an
    /// INPUT's `sk_note` — use `canonical_sk` for that.
    fn xonly(sk_seed: &[u8; 32]) -> [u8; 32] {
        let p = ProjectivePoint::GENERATOR * scalar_reduce_be(sk_seed);
        let c = compress(&p);
        let mut x = [0u8; 32];
        x.copy_from_slice(&c[1..]);
        x
    }

    /// `seed` -> the canonical even-y `sk_note` scalar and its x-only `spend_key`. Negates the seed's
    /// scalar (mod curve order) when its point has odd y, mirroring what a real wallet must do when it
    /// picks `sk_note` at note-creation time so the note is ever spendable under the new even-y
    /// constraint (`verify_btc_pool_spend`'s `sk_note is not the canonical even-y representative` check).
    fn canonical_sk(seed: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        let mut s = scalar_reduce_be(seed);
        let mut c = compress(&(ProjectivePoint::GENERATOR * s));
        if c[0] != 0x02 {
            s = -s;
            c = compress(&(ProjectivePoint::GENERATOR * s));
        }
        assert_eq!(c[0], 0x02);
        let mut sk = [0u8; 32];
        sk.copy_from_slice(s.to_bytes().as_slice());
        let mut x = [0u8; 32];
        x.copy_from_slice(&c[1..]);
        (sk, x)
    }

    fn out(cx: [u8; 32], cy: [u8; 32], spend_key: [u8; 32], value: u64, blinding: [u8; 32], tag: u8) -> BtcPoolSpendOutput {
        BtcPoolSpendOutput { cx, cy, pk_eph: [tag; 32], spend_key, ct_note: [tag; 56], value, blinding }
    }

    /// A tree holding `pad` unrelated leaves then the spent note, so the note sits at a non-zero index.
    struct Fixture {
        witness: BtcPoolSpendWitness,
    }

    /// Valid 1-in/1-out pay: a 50_000-sat note paid in full to a fresh one-time key.
    fn one_in_one_out() -> Fixture {
        let (in_sk, in_key) = canonical_sk(&[0x11u8; 32]);
        let (in_r, in_v) = ([0x21u8; 32], 50_000u64);
        let (icx, icy) = pedersen_commit_xy(in_v, &in_r);
        let in_leaf = btc_pool_note_leaf(&ASSET, &icx, &icy, &in_key);

        let mut tree = KeccakTreeAccumulator::new();
        for s in 0..3u8 {
            tree.append(&[s + 1; 32]);
        }
        let leaf_index = tree.next_index();
        let path = tree.append_path();
        tree.append(&in_leaf);
        let root = tree.root();
        assert_eq!(merkle_root_from(&in_leaf, leaf_index, &path), Some(root));

        let out_key = xonly(&[0x33u8; 32]);
        let out_r = [0x44u8; 32];
        let (ocx, ocy) = pedersen_commit_xy(in_v, &out_r);

        let witness = BtcPoolSpendWitness {
            asset: ASSET,
            root,
            h_anchor: 910_000,
            out_kind: BTC_POOL_OUT_PAY,
            inputs: vec![BtcPoolSpendInput {
                cx: icx,
                cy: icy,
                spend_key: in_key,
                value: in_v,
                blinding: in_r,
                leaf_index,
                path,
                sk_note: in_sk,
            }],
            outputs: vec![out(ocx, ocy, out_key, in_v, out_r, 0x55)],
            exit_vout: None,
            exit_value: 0,
            dest_spk_hash: None,
        };
        Fixture { witness }
    }

    #[test]
    fn valid_one_in_one_out() {
        let f = one_in_one_out();
        let st = verify_btc_pool_spend(&f.witness).expect("valid spend accepted");
        let i = &f.witness.inputs[0];
        let o = &f.witness.outputs[0];
        let in_leaf = btc_pool_note_leaf(&ASSET, &i.cx, &i.cy, &i.spend_key);
        let nf_secret = btc_pool_nf_secret(&i.sk_note);
        assert_eq!(st.nullifiers, vec![btc_pool_nullifier(&in_leaf, &nf_secret)]);
        assert_eq!(st.nullifiers[0], kn(&[&in_leaf, &nf_secret, b"spent"]));
        assert_eq!(st.outputs, vec![(o.cx, o.cy, o.pk_eph, o.spend_key, o.ct_note)]);
        assert_eq!(st.out_leaves, vec![kn(&[&ASSET, &o.cx, &o.cy, &o.spend_key, b"tacit-btc-pool-note-v1"])]);
        assert_eq!((st.asset, st.root, st.h_anchor, st.out_kind), (ASSET, f.witness.root, 910_000, BTC_POOL_OUT_PAY));
        assert_eq!(st.exit_vout, None);
    }

    /// Proves the design property: a passive chain observer, seeing only the public note fields
    /// (`asset, Cx, Cy, spend_key`), cannot compute the real nullifier — it also needs `nf_secret`, which
    /// requires the private `sk_note`. A formula depending on `leaf` alone (`keccak(leaf‖"spent")`) would
    /// be a function of public fields alone and precomputable; this asserts the actual formula is not.
    #[test]
    fn nullifier_not_precomputable_from_public_fields_alone() {
        let f = one_in_one_out();
        let st = verify_btc_pool_spend(&f.witness).expect("valid spend accepted");
        let i = &f.witness.inputs[0];
        let leaf = btc_pool_note_leaf(&ASSET, &i.cx, &i.cy, &i.spend_key);

        // What a passive observer, knowing only (asset, Cx, Cy, spend_key) from the shield envelope, could
        // compute without ever learning sk_note: the old, broken formula.
        let observer_guess = kn(&[&leaf, b"spent"]);
        assert_ne!(st.nullifiers[0], observer_guess, "nullifier must not be computable from public fields alone");

        // The real nullifier does require the private sk_note.
        let nf_secret = btc_pool_nf_secret(&i.sk_note);
        assert_eq!(st.nullifiers[0], btc_pool_nullifier(&leaf, &nf_secret));
    }

    #[test]
    fn valid_two_in_two_out() {
        let f = one_in_one_out();
        let mut w = f.witness.clone();
        let (sk2, key2) = canonical_sk(&[0x12u8; 32]);
        let r2 = [0x22u8; 32];
        let (cx2, cy2) = pedersen_commit_xy(7_000, &r2);
        let leaf1 = btc_pool_note_leaf(&ASSET, &w.inputs[0].cx, &w.inputs[0].cy, &w.inputs[0].spend_key);
        let leaf2 = btc_pool_note_leaf(&ASSET, &cx2, &cy2, &key2);
        let mut tree = KeccakTreeAccumulator::new();
        tree.append(&leaf1);
        let p1 = tree.append_path();
        tree.append(&leaf2);
        let root = tree.root();
        // Index 0 of a two-leaf tree shares index 1's path above level 0; its level-0 sibling is leaf2.
        let mut p0 = p1.clone();
        p0[0] = leaf2;
        assert_eq!(merkle_root_from(&leaf1, 0, &p0), Some(root));
        w.root = root;
        w.inputs[0].leaf_index = 0;
        w.inputs[0].path = p0;
        w.inputs.push(BtcPoolSpendInput {
            cx: cx2,
            cy: cy2,
            spend_key: key2,
            value: 7_000,
            blinding: r2,
            leaf_index: 1,
            path: p1,
            sk_note: sk2,
        });
        // 57_000 in = 40_000 + 17_000 out (no fee term).
        let (oa, ob) = ([0x45u8; 32], [0x46u8; 32]);
        let (acx, acy) = pedersen_commit_xy(40_000, &oa);
        let (bcx, bcy) = pedersen_commit_xy(17_000, &ob);
        w.outputs = vec![
            out(acx, acy, xonly(&[0x34u8; 32]), 40_000, oa, 0x61),
            out(bcx, bcy, xonly(&[0x35u8; 32]), 17_000, ob, 0x62),
        ];
        let st = verify_btc_pool_spend(&w).expect("2-in/2-out accepted");
        assert_eq!(st.nullifiers.len(), 2);
        assert_eq!(st.out_leaves.len(), 2);
    }

    /// Exit: the same note redeemed straight to a real Bitcoin output, no replacement leaf.
    fn exit_fixture() -> Fixture {
        let (in_sk, in_key) = canonical_sk(&[0x11u8; 32]);
        let (in_r, in_v) = ([0x21u8; 32], 50_000u64);
        let (icx, icy) = pedersen_commit_xy(in_v, &in_r);
        let in_leaf = btc_pool_note_leaf(&ASSET, &icx, &icy, &in_key);

        let mut tree = KeccakTreeAccumulator::new();
        tree.append(&[0x99u8; 32]);
        let leaf_index = tree.next_index();
        let path = tree.append_path();
        tree.append(&in_leaf);
        let root = tree.root();

        let witness = BtcPoolSpendWitness {
            asset: ASSET,
            root,
            h_anchor: 910_000,
            out_kind: BTC_POOL_OUT_EXIT,
            inputs: vec![BtcPoolSpendInput {
                cx: icx,
                cy: icy,
                spend_key: in_key,
                value: in_v,
                blinding: in_r,
                leaf_index,
                path,
                sk_note: in_sk,
            }],
            outputs: vec![],
            exit_vout: Some(1),
            exit_value: in_v,
            dest_spk_hash: Some([0x66u8; 32]),
        };
        Fixture { witness }
    }

    #[test]
    fn valid_exit() {
        let f = exit_fixture();
        let st = verify_btc_pool_spend(&f.witness).expect("valid exit accepted");
        assert!(st.outputs.is_empty());
        assert!(st.out_leaves.is_empty());
        assert_eq!(st.exit_vout, Some(1));
        assert_eq!(st.exit_value, 50_000);
        assert_eq!(st.dest_spk_hash, Some([0x66u8; 32]));
        assert_eq!(st.out_kind, BTC_POOL_OUT_EXIT);
    }

    #[test]
    fn exit_rejects_mismatched_value_or_shape() {
        let f = exit_fixture();

        let mut w = f.witness.clone();
        w.exit_value += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));

        let mut w = f.witness.clone();
        w.exit_vout = None;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: missing exit_vout"));

        let mut w = f.witness.clone();
        w.dest_spk_hash = None;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: missing dest_spk_hash"));

        let mut w = f.witness.clone();
        w.outputs.push(out([1u8; 32], [2u8; 32], xonly(&[3u8; 32]), 1, [4u8; 32], 0x70));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: outputs set on an exit"));

        let mut w = f.witness.clone();
        w.out_kind = 0x02;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: bad out_kind"));
    }

    /// `h_body` (design §4) covers `pk_eph`/`ct_note` for a pay and `dest_spk_hash` for an exit
    /// (security doc G5). This is enforced by the guest's SP1 public-input binding,
    /// not by `verify_btc_pool_spend` itself (which only returns the raw fields as the committed
    /// statement); what's checked natively here is that `h_body` actually changes when any of these fields
    /// does, which is what makes that binding meaningful.
    #[test]
    fn pay_h_body_binds_pk_eph_and_ct_note() {
        let f = one_in_one_out();
        let w = &f.witness;
        let nfs: Vec<[u8; 32]> = w
            .inputs
            .iter()
            .map(|i| {
                let leaf = btc_pool_note_leaf(&w.asset, &i.cx, &i.cy, &i.spend_key);
                btc_pool_nullifier(&leaf, &btc_pool_nf_secret(&i.sk_note))
            })
            .collect();
        let out_fields = |outs: &[BtcPoolSpendOutput]| -> Vec<BtcPoolOutFields> {
            outs.iter().map(|o| (o.cx, o.cy, o.pk_eph, o.spend_key, o.ct_note)).collect()
        };
        let h_body_orig =
            btc_pool_h_body(&w.asset, &nfs, w.out_kind, &out_fields(&w.outputs), w.exit_vout, w.dest_spk_hash, w.h_anchor);

        let mut w2 = w.clone();
        w2.outputs[0].pk_eph[0] ^= 1;
        let h_body_pk_eph =
            btc_pool_h_body(&w2.asset, &nfs, w2.out_kind, &out_fields(&w2.outputs), w2.exit_vout, w2.dest_spk_hash, w2.h_anchor);
        assert_ne!(h_body_orig, h_body_pk_eph);

        let mut w3 = w.clone();
        w3.outputs[0].ct_note[0] ^= 1;
        let h_body_ct_note =
            btc_pool_h_body(&w3.asset, &nfs, w3.out_kind, &out_fields(&w3.outputs), w3.exit_vout, w3.dest_spk_hash, w3.h_anchor);
        assert_ne!(h_body_orig, h_body_ct_note);
    }

    #[test]
    fn pay_rejects_dest_spk_hash_set() {
        let f = one_in_one_out();
        let mut w = f.witness.clone();
        w.dest_spk_hash = Some([0x66u8; 32]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: dest_spk_hash set on a pay"));
    }

    /// The theft path this design closes (security doc G3 follow-up): an exit envelope's `h_body` must
    /// change when `dest_spk_hash` changes, so a proof generated for one destination can't be repointed to
    /// another via the guest's public-input binding — same mechanism `pay_h_body_binds_pk_eph_and_ct_note`
    /// checks for a pay, mirrored here for the exit-only `dest_spk_hash` field.
    #[test]
    fn exit_h_body_binds_dest_spk_hash() {
        let f = exit_fixture();
        let w = &f.witness;
        let nfs: Vec<[u8; 32]> = w
            .inputs
            .iter()
            .map(|i| {
                let leaf = btc_pool_note_leaf(&w.asset, &i.cx, &i.cy, &i.spend_key);
                btc_pool_nullifier(&leaf, &btc_pool_nf_secret(&i.sk_note))
            })
            .collect();
        let h_body_orig = btc_pool_h_body(&w.asset, &nfs, w.out_kind, &[], w.exit_vout, w.dest_spk_hash, w.h_anchor);

        let mut w_other = w.clone();
        w_other.dest_spk_hash = Some([0x77u8; 32]);
        let h_body_other =
            btc_pool_h_body(&w_other.asset, &nfs, w_other.out_kind, &[], w_other.exit_vout, w_other.dest_spk_hash, w_other.h_anchor);
        assert_ne!(h_body_orig, h_body_other);
    }

    #[test]
    fn rejects_unbalanced_or_bad_openings() {
        let f = one_in_one_out();

        let mut w = f.witness.clone();
        let r = [0x47u8; 32];
        let (cx, cy) = pedersen_commit_xy(50_001, &r);
        w.outputs[0] = out(cx, cy, w.outputs[0].spend_key, 50_001, r, 0x55);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));

        let mut w = f.witness.clone();
        w.outputs[0].value += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output opening"));

        let mut w = f.witness.clone();
        w.inputs[0].value += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input opening"));
    }

    #[test]
    fn rejects_bad_membership() {
        let f = one_in_one_out();
        let mut w = f.witness.clone();
        w.inputs[0].leaf_index += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        let mut w = f.witness.clone();
        w.root[0] ^= 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        // A different spend_key (with a matching sk_note, so the authorization check itself passes)
        // changes the leaf, so it is not a member.
        let mut w = f.witness.clone();
        let (other_sk, other_key) = canonical_sk(&[0x99u8; 32]);
        w.inputs[0].spend_key = other_key;
        w.inputs[0].sk_note = other_sk;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        // Another asset's leaf over the same commitment and key is not a member either.
        let mut w = f.witness.clone();
        w.asset = [0xC8u8; 32];
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        let mut w = f.witness.clone();
        w.root = [0u8; 32];
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: zero root"));
    }

    /// A wrong `sk_note` — not matching the note's committed `spend_key` — must be rejected, not silently
    /// accepted or misattributed. This is the in-circuit authorization check that replaces the detached
    /// BIP-340 signature (design §2/§4).
    #[test]
    fn rejects_wrong_sk_note() {
        let f = one_in_one_out();
        let mut w = f.witness.clone();
        let (wrong_sk, _) = canonical_sk(&[0x77u8; 32]);
        w.inputs[0].sk_note = wrong_sk;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend_key does not match sk_note"));
    }

    /// The theft this fix closes (round-5 review / security doc A5 "Canonical witness requirement", G2):
    /// `spend_key` is x-only, so both `sk_note = d` and `sk_note = n-d` (curve order minus `d`) satisfy
    /// `spend_key = sk_note·G` for the same `spend_key` — same x-coordinate — yet `nf_secret` (and so the
    /// nullifier) hashes the FULL scalar, so `d` and `n-d` produce different nullifiers for the same note.
    /// Without the even-y constraint, an owner could spend the same note twice under two different valid
    /// proofs. `d'` here has the same x-coordinate as `d` (would pass the old, incomplete equality check)
    /// but odd y, so it must be rejected by the new canonical-witness check specifically — not by the
    /// (unrelated) equality check.
    #[test]
    fn rejects_noncanonical_odd_y_sk_note_n_minus_d() {
        let f = one_in_one_out();
        let d = scalar_reduce_be(&f.witness.inputs[0].sk_note);
        // d is canonical (even y) by construction (`canonical_sk`); n-d is its odd-y twin, same x-coordinate.
        let d_prime = -d;
        assert_ne!(d, d_prime);
        let p_prime = ProjectivePoint::GENERATOR * d_prime;
        let c_prime = compress(&p_prime);
        assert_eq!(c_prime[0], 0x03, "n-d must be the odd-y twin");
        assert_eq!(&c_prime[1..], &f.witness.inputs[0].spend_key[..], "n-d must share d's x-coordinate / spend_key");

        let mut w = f.witness.clone();
        let mut sk_prime = [0u8; 32];
        sk_prime.copy_from_slice(d_prime.to_bytes().as_slice());
        w.inputs[0].sk_note = sk_prime;
        assert_eq!(
            verify_btc_pool_spend(&w),
            Err("btc-pool: sk_note is not the canonical even-y representative"),
            "n-d shares spend_key's x-coordinate with d but must still be rejected as a non-canonical witness"
        );
    }

    #[test]
    fn rejects_arity_and_repeated_input() {
        let f = one_in_one_out();

        let mut w = f.witness.clone();
        w.inputs.clear();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input count out of range"));

        let mut w = f.witness.clone();
        w.outputs.clear();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count out of range"));

        let mut w = f.witness.clone();
        w.inputs = vec![w.inputs[0].clone(); 3];
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input count out of range"));

        let mut w = f.witness.clone();
        let o = w.outputs[0].clone();
        w.outputs = vec![o.clone(), o.clone(), o];
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count out of range"));

        // The same note twice in one spend.
        let mut w = f.witness.clone();
        w.inputs.push(w.inputs[0].clone());
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: repeated nullifier"));
    }

    #[test]
    fn rejects_output_key_off_curve() {
        let f = one_in_one_out();
        let mut w = f.witness.clone();
        // x = 5 has no point on secp256k1 (5^3 + 7 = 132 is a non-residue mod p).
        let mut bad = [0u8; 32];
        bad[31] = 5;
        assert!(!is_xonly_key(&bad));
        w.outputs[0].spend_key = bad;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output spend_key not an x-only key"));
    }

    #[test]
    fn leaf_domain_is_disjoint() {
        let (cx, cy, k) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let pool = btc_pool_note_leaf(&ASSET, &cx, &cy, &k);
        assert_ne!(pool, crate::btc_note_leaf(&ASSET, &cx, &cy, &k));
        assert_ne!(pool, crate::leaf(&ASSET, &cx, &cy, &k));
    }
}
