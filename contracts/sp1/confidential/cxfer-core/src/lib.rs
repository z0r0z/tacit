//! Verification core for the EVM confidential transfer, ported from the JS
//! prover (dapp/confidential-transfer.js + dapp/bulletproofs-plus.js). Pure k256
//! + sha2/keccak, no SP1 deps, so it tests natively against JS-produced fixtures.
//! The SP1 guest re-exports these checks. Two pieces:
//!   - verify_kernel: the conservation Schnorr (dapp/confidential-transfer.js)
//!   - verify_range:  the aggregated Bulletproofs+ range proof
//!                    (dapp/bulletproofs-plus.js::bppRangeVerify), m ∈ {1,2,4,8}

use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::group::Group; // ProjectivePoint::generator() needs this in scope on the RISC-V target (sp1-lib)
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};

/// Public alias so dependents (the SP1 guest) can name the point type without
/// referencing k256 directly — the patched-k256 path is private, so a re-export
/// fails but an alias resolves in both vanilla and patched builds.
pub type Point = ProjectivePoint;
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

/// Bitcoin block/tx primitives for bridge_mint (BTC→ETH burn verification).
pub mod bitcoin;
pub mod bjj;
/// Burn-and-mint onboarding of pre-existing fixed-supply Bitcoin assets (TAC): scan-free per-bridge
/// provenance to the etch supply note. See ops/DESIGN-trustless-asset-onboarding.md.
pub mod burn_deposit;
pub mod eth_reflection;
// `sigma` is a TEST-ONLY reference mirror of the cross-curve (secp↔BabyJubJub) sigma verifier. The LIVE,
// VKEY-pinned verifier is `babyjubjub::verify_xcurve` (the sole production caller is swap_batch.rs); this
// num_bigint reimplementation is kept only for its independent KAT vectors and is gated `#[cfg(test)]` so it
// can never be wired into the proving build and silently diverge from the verifier the proof commits to.
#[cfg(test)]
mod sigma;

pub const KERNEL_DOMAIN: &[u8] = b"tacit-evm-cxfer-kernel-v1";
const BPP_DOMAIN: &[u8] = b"tacit-bpp-v1";
const N_BITS: usize = 64;

// ──────────────────── point / scalar helpers ────────────────────

pub fn decompress(b: &[u8; 33]) -> Option<ProjectivePoint> {
    let ep = EncodedPoint::from_bytes(b).ok()?;
    let aff: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    aff.map(ProjectivePoint::from)
}

pub fn compress(p: &ProjectivePoint) -> [u8; 33] {
    let enc = p.to_affine().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(enc.as_bytes());
    out
}

/// reduce a 32-byte big-endian hash to a scalar mod n (matches modN(bytes32ToBigint)).
pub fn scalar_reduce_be(bytes: &[u8; 32]) -> Scalar {
    <Scalar as Reduce<U256>>::reduce(U256::from_be_slice(bytes))
}

/// parse a canonical 32-byte big-endian scalar (< n), else None (matches `>= SECP_N → false`).
fn scalar_canonical_be(bytes: &[u8]) -> Option<Scalar> {
    let fb: FieldBytes = match <[u8; 32]>::try_from(bytes) {
        Ok(a) => a.into(),
        Err(_) => return None,
    };
    Option::<Scalar>::from(Scalar::from_repr(fb))
}

fn sum_points(points: &[ProjectivePoint]) -> ProjectivePoint {
    points.iter().fold(ProjectivePoint::identity(), |a, p| a + p)
}

// ──────────────────── conservation kernel ────────────────────

/// z·G == R + e·(Σ Cin − Σ Cout), e = keccak(KERNEL_DOMAIN ‖ Cin… ‖ Cout… ‖ R) mod n.
/// Mirrors dapp/confidential-transfer.js. (fee-less; a public fee adds −fee·H to X.)
pub fn verify_kernel(
    in_c: &[ProjectivePoint],
    out_c: &[ProjectivePoint],
    r: &ProjectivePoint,
    z: &Scalar,
) -> bool {
    verify_kernel_with_fee(in_c, out_c, 0, r, z)
}

/// Conservation kernel with a PUBLIC fee leg: proves Σ value_in = Σ value_out + `fee`, where `fee`
/// leaves the shielded set as a public FeePayment (the relay fee for a gasless transfer). Identical
/// to `verify_kernel` but removes the public `fee·H` from the excess before the Schnorr check —
/// x = Σ Cin − Σ Cout − fee·H must equal excess·G. With fee = 0 this is byte-identical to
/// `verify_kernel` (fee·H = identity). The fee needs no separate binding: shifting it leaves an
/// H-component in x the Schnorr can't satisfy without the (secret) blinding excess.
pub fn verify_kernel_with_fee(
    in_c: &[ProjectivePoint],
    out_c: &[ProjectivePoint],
    fee: u64,
    r: &ProjectivePoint,
    z: &Scalar,
) -> bool {
    // No output-leaf binding: identical transcript to the original kernel (the empty `out_leaves` loop is
    // a no-op). Used by ops that bind the output owner elsewhere (an opening-sigma over `(Cx,Cy,owner)`) or
    // emit a deterministic/zero owner.
    verify_kernel_with_fee_bound(in_c, out_c, fee, &[], r, z)
}

/// As `verify_kernel_with_fee`, but additionally binds the ORDERED output LEAF hashes into the challenge
/// transcript. The plain kernel commits only the output COMMITMENT POINTS `(Cx,Cy)`; the tree leaf is
/// `leaf(asset,Cx,Cy,owner)`, so `owner` is otherwise unbound. Without this, a delegated prover (the relay
/// box receives the raw witness) could flip an output `owner` while keeping a valid range+kernel proof,
/// emitting a leaf the intended recipient cannot reconstruct → a permanent fund lock. Ops that emit
/// fresh, prover-supplied-owner output leaves (OP_TRANSFER / OP_WRAP_TRANSFER / OP_SEND_AND_UNWRAP change)
/// pass their output leaves here so a mutated owner invalidates the proof.
pub fn verify_kernel_with_fee_bound(
    in_c: &[ProjectivePoint],
    out_c: &[ProjectivePoint],
    fee: u64,
    out_leaves: &[[u8; 32]],
    r: &ProjectivePoint,
    z: &Scalar,
) -> bool {
    let mut k = Keccak::v256();
    k.update(KERNEL_DOMAIN);
    for p in in_c { k.update(&compress(p)); }
    for p in out_c { k.update(&compress(p)); }
    for l in out_leaves { k.update(l); }
    k.update(&compress(r));
    let mut h = [0u8; 32];
    k.finalize(&mut h);
    let e = scalar_reduce_be(&h);

    let x = sum_points(in_c) - sum_points(out_c) - gen_h() * Scalar::from(fee);
    ProjectivePoint::generator() * z == *r + x * e
}

#[cfg(test)]
mod relay_fee_kernel_tests {
    use super::*;

    fn commit(v: u64, r: Scalar) -> ProjectivePoint {
        gen_h() * Scalar::from(v) + ProjectivePoint::generator() * r
    }
    fn challenge(in_c: &[ProjectivePoint], out_c: &[ProjectivePoint], rr: &ProjectivePoint) -> Scalar {
        let mut k = Keccak::v256();
        k.update(KERNEL_DOMAIN);
        for p in in_c { k.update(&compress(p)); }
        for p in out_c { k.update(&compress(p)); }
        k.update(&compress(rr));
        let mut h = [0u8; 32];
        k.finalize(&mut h);
        scalar_reduce_be(&h)
    }
    // Honest prover for Σin = Σout + fee: (R, z) over the blinding excess, as confidential-transfer.js.
    fn prove(in_c: &[ProjectivePoint], out_c: &[ProjectivePoint], excess: Scalar, nonce: &[u8; 32]) -> (ProjectivePoint, Scalar) {
        let kk = scalar_reduce_be(nonce);
        let rr = ProjectivePoint::generator() * kk;
        let e = challenge(in_c, out_c, &rr);
        (rr, kk + e * excess)
    }

    #[test]
    fn fee_leg_conserves_and_binds() {
        let r_in = scalar_reduce_be(&[7u8; 32]);
        let r_out = scalar_reduce_be(&[9u8; 32]);
        let in_c = [commit(100, r_in)];
        let out_c = [commit(70, r_out)]; // Σin = Σout + 30
        let (rr, z) = prove(&in_c, &out_c, r_in - r_out, &[3u8; 32]);
        assert!(verify_kernel_with_fee(&in_c, &out_c, 30, &rr, &z), "honest fee accepted");
        assert!(!verify_kernel_with_fee(&in_c, &out_c, 31, &rr, &z), "padded fee rejected");
        assert!(!verify_kernel_with_fee(&in_c, &out_c, 29, &rr, &z), "understated fee rejected");
        assert!(!verify_kernel_with_fee(&in_c, &out_c, 0, &rr, &z), "fee-free read of a fee'd transfer rejected");
    }

    #[test]
    fn fee_zero_equals_verify_kernel() {
        let r_in = scalar_reduce_be(&[11u8; 32]);
        let r_out = scalar_reduce_be(&[13u8; 32]);
        let in_c = [commit(50, r_in)];
        let out_c = [commit(50, r_out)]; // balanced
        let (rr, z) = prove(&in_c, &out_c, r_in - r_out, &[5u8; 32]);
        assert!(verify_kernel(&in_c, &out_c, &rr, &z));
        assert!(verify_kernel_with_fee(&in_c, &out_c, 0, &rr, &z));
        assert!(!verify_kernel_with_fee(&in_c, &out_c, 1, &rr, &z), "a fee on a balanced transfer is rejected");
    }

    // A valid opening sigma (PoK of the blinding r for a PUBLIC u64 amount), mirroring verify_opening_sigma.
    fn open_sigma(c: &ProjectivePoint, amount: u64, r: Scalar, context: &[u8; 32], nonce: &[u8; 32])
        -> (ProjectivePoint, Scalar)
    {
        let kk = scalar_reduce_be(nonce);
        let rr = ProjectivePoint::generator() * kk;
        let mut k = Keccak::v256();
        k.update(OPENING_DOMAIN);
        k.update(&amount.to_be_bytes());
        k.update(context);
        k.update(&compress(c));
        k.update(&compress(&rr));
        let mut h = [0u8; 32];
        k.finalize(&mut h);
        let e = scalar_reduce_be(&h);
        (rr, kk + e * r)
    }

    // OP_ADAPTOR_REFUND / OP_STEALTH_REFUND fee-bound regression. The refund kernel proves only
    // value(L) = value(O) + fee (mod n); the scalar field has no ordering, so for a freely chosen O the
    // kernel passes for ANY fee — an over-large fee then pays out unbacked value at the public boundary
    // (FeePayment to the settler). The guard is: re-open L (adaptor) / read the leaf-pinned amount (stealth)
    // to L's TRUE u64 value, then assert fee < amount. This pins both ends so no wraparound fee survives.
    #[test]
    fn refund_fee_must_be_bounded_by_the_locked_value() {
        let r_l = scalar_reduce_be(&[21u8; 32]);
        let amount: u64 = 100; // L's true locked value (u64)
        let l = commit(amount, r_l);
        let r_o = scalar_reduce_be(&[22u8; 32]);

        // THE GAP: a huge fee with O chosen so value(O) == amount - fee (mod n) — a valid curve point the
        // locker can open. The fee-bearing kernel alone ACCEPTS it (this is the vulnerability the fix closes).
        let big_fee: u64 = u64::MAX;
        let o_bad = gen_h() * (Scalar::from(amount) - Scalar::from(big_fee))
            + ProjectivePoint::generator() * r_o;
        let (rr_bad, z_bad) = prove(&[l], &[o_bad], r_l - r_o, &[23u8; 32]);
        assert!(
            verify_kernel_with_fee(&[l], &[o_bad], big_fee, &rr_bad, &z_bad),
            "kernel alone accepts an over-large fee — the gap the guard must close"
        );

        // THE GUARD: the opening sigma binds L to its TRUE u64 value; it cannot be opened to any other value,
        // and `amount` is a u64 (< 2^64). The guest then rejects fee >= amount.
        let ctx = [7u8; 32];
        let (osig_r, osig_z) = open_sigma(&l, amount, r_l, &ctx, &[24u8; 32]);
        assert!(verify_opening_sigma(&l, amount, &osig_r, &osig_z, &ctx), "L opens to its true value");
        assert!(
            !verify_opening_sigma(&l, amount.wrapping_add(1), &osig_r, &osig_z, &ctx),
            "L cannot be opened to a different value (so `amount` is forced to L's real value)"
        );
        assert!(!(big_fee < amount), "the guest-level `fee < amount` check rejects the over-large fee");

        // An honest fee passes the bound AND conservation.
        let honest_fee: u64 = 30;
        let o_ok = commit(amount - honest_fee, r_o);
        let (rr_ok, z_ok) = prove(&[l], &[o_ok], r_l - r_o, &[25u8; 32]);
        assert!(honest_fee < amount);
        assert!(verify_kernel_with_fee(&[l], &[o_ok], honest_fee, &rr_ok, &z_ok));
    }

    // Guest↔JS parity for the output-owner binding (audit H-3): the JS prover
    // (confidential-transfer.js) must produce a kernel (R,z) that the guest's
    // verify_kernel_with_fee_bound ACCEPTS (leaf-bound) and that the UNBOUND kernel REJECTS — proving the
    // binding is live on the new transcript AND that the JS leaf/point/domain encodings match byte-for-byte.
    #[test]
    fn js_transfer_family_fixtures_satisfy_the_bound_kernel() {
        fn hx<const N: usize>(s: &str) -> [u8; N] {
            let s = s.trim_start_matches("0x");
            let mut o = [0u8; N];
            for i in 0..N { o[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap(); }
            o
        }
        fn pt(cx: &str, cy: &str) -> ProjectivePoint {
            let x = FieldBytes::from(hx::<32>(cx));
            let y = FieldBytes::from(hx::<32>(cy));
            let ep = EncodedPoint::from_affine_coordinates(&x, &y, false);
            ProjectivePoint::from(Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep)).unwrap())
        }
        let check = |label: &str, j: &serde_json::Value,
                     iin: &[(String, String)], out: &[(String, String, String)], fee: u64| {
            let asset = hx::<32>(j["asset"].as_str().unwrap());
            let inc: Vec<ProjectivePoint> = iin.iter().map(|(x, y)| pt(x, y)).collect();
            let outc: Vec<ProjectivePoint> = out.iter().map(|(x, y, _)| pt(x, y)).collect();
            let lvs: Vec<[u8; 32]> =
                out.iter().map(|(x, y, o)| leaf(&asset, &hx::<32>(x), &hx::<32>(y), &hx::<32>(o))).collect();
            let r = decompress(&hx::<33>(j["kernel"]["R"].as_str().unwrap())).unwrap();
            let z = scalar_reduce_be(&hx::<32>(j["kernel"]["z"].as_str().unwrap()));
            assert!(verify_kernel_with_fee_bound(&inc, &outc, fee, &lvs, &r, &z),
                "{}: bound kernel must ACCEPT the JS proof (guest↔JS parity)", label);
            assert!(!verify_kernel_with_fee(&inc, &outc, fee, &r, &z),
                "{}: unbound kernel must REJECT a leaf-bound proof (binding is live)", label);
        };
        let arr3 = |v: &serde_json::Value| -> Vec<(String, String, String)> {
            v.as_array().unwrap().iter()
                .map(|o| (o["cx"].as_str().unwrap().into(), o["cy"].as_str().unwrap().into(), o["owner"].as_str().unwrap().into()))
                .collect()
        };
        let xy = |o: &serde_json::Value| (o["cx"].as_str().unwrap().to_string(), o["cy"].as_str().unwrap().to_string());

        let t: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/transfer_op.json")).unwrap();
        let tin: Vec<_> = t["inputs"].as_array().unwrap().iter().map(|i| xy(i)).collect();
        check("transfer", &t, &tin, &arr3(&t["outputs"]), t["fee"].as_u64().unwrap_or(0));

        let w: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/wraptransfer_op.json")).unwrap();
        check("wraptransfer", &w, &[xy(&w["deposit"])], &arr3(&w["outputs"]), w["fee"].as_u64().unwrap_or(0));

        let s: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/sendunwrap_op.json")).unwrap();
        let kfee = s["payout"].as_u64().unwrap() + s["fee"].as_u64().unwrap();
        check("sendunwrap", &s, &[xy(&s["input"])], &arr3(&s["change"]), kfee);
    }
}

// ──────────────────── opening proof-of-knowledge (swap / LP) ────────────────────

pub const OPENING_DOMAIN: &[u8] = b"tacit-open-sigma-v1";

// ──────────────────── cBTC.zk sats-lock value-entry (real-BTC backing) ────────────────────
// The deploy-gated cBTC pieces (baked into BITCOIN_RELAY_VKEY). See ops/DESIGN-cbtc-sats-lock-reflection.md.
/// The single canonical asset id real-BTC-locked cBTC notes mint under = keccak256("tacit-cbtc-zk-lock-v1").
/// cBTC.zk is a lock position (not a real etch), so this is a FIXED domain constant; its fungible canonical
/// ERC20 form is cBTC.tac. Final — baked into BITCOIN_RELAY_VKEY at the re-prove. See ops/DESIGN-cbtc-tac.md.
pub const CBTC_ZK_ASSET_ID: [u8; 32] = [
    0x62, 0xa2, 0x0d, 0x98, 0xfc, 0x1c, 0xd2, 0x02, 0x89, 0x62, 0x1d, 0x13, 0x15, 0x29, 0x4c, 0xb8,
    0x77, 0x2f, 0x93, 0x4d, 0x82, 0x2e, 0x40, 0x4b, 0x71, 0xe1, 0xf4, 0x71, 0xcf, 0x06, 0x79, 0xc8,
];
/// Opening-sigma context domain for a sats-lock (binds asset ‖ lock_txid ‖ lock_vout — anti-replay).
pub const CBTC_LOCK_DOMAIN: &[u8] = b"tacit-cbtc-lock-v1";

/// Adaptor-swap LOCK-SET leaf domain — see ops/DESIGN-adaptor-swap-guest.md. Domain-separated from
/// the note-tree `leaf` so a locked note is NEVER spendable by a normal OP_TRANSFER (and vice-versa).
pub const ADAPTOR_LOCK_DOMAIN: &[u8] = b"tacit-adaptor-lock-v1";

/// Schnorr proof of knowledge of the blinding `r` for a Pedersen commitment with a PUBLIC
/// `amount`: proves the prover knows `r` such that `commitment = amount·H + r·G`, binding the
/// trade `context` (out owner / min_out / amounts / pool / chain) into the challenge — WITHOUT
/// revealing `r`. This is the swap/LP analog of the kernel signature hiding transfer blindings:
/// a remote settle prover verifies a swap/LP opening without learning `r`, so it can neither
/// spend the input note elsewhere nor redirect the output. Binding `amount` to the commitment
/// (Pedersen binding) also fixes the cleared/contributed value. proof = (R, z); e = keccak(
/// OPENING_DOMAIN ‖ amount_be ‖ context ‖ compress(commitment) ‖ compress(R)) mod n. Accept iff
/// z·G == R + e·(commitment − amount·H). Mirrors dapp/confidential-pool.js `openingSigma`.
pub fn verify_opening_sigma(
    commitment: &ProjectivePoint,
    amount: u64,
    r: &ProjectivePoint,
    z: &Scalar,
    context: &[u8; 32],
) -> bool {
    let x = *commitment - gen_h() * Scalar::from(amount);
    let mut k = Keccak::v256();
    k.update(OPENING_DOMAIN);
    k.update(&amount.to_be_bytes());
    k.update(context);
    k.update(&compress(commitment));
    k.update(&compress(r));
    let mut h = [0u8; 32];
    k.finalize(&mut h);
    let e = scalar_reduce_be(&h);
    ProjectivePoint::generator() * z == *r + x * e
}

/// Domain-separated keccak context binding a swap/LP intent's trade terms, fed into every opening
/// sigma for that intent. `notes` = each (cx, cy, owner) the intent touches (spent + minted, in a
/// fixed order); `amounts` = the public quantities (direction/in/out/shares/min_out…). Any change
/// to a bound field changes the context → the sigmas fail → the box can neither redirect the output
/// nor re-price the trade. The guest builds it from the witness; dapp/confidential-pool.js
/// `intentContext` mirrors it byte-for-byte (the exec harness locks the agreement).
pub fn intent_context(
    tag: &[u8],
    chain_binding: &[u8; 32],
    asset_a: &[u8; 32],
    asset_b: &[u8; 32],
    notes: &[([u8; 32], [u8; 32], [u8; 32])],
    amounts: &[u64],
) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(tag);
    k.update(chain_binding);
    k.update(asset_a);
    k.update(asset_b);
    for (cx, cy, owner) in notes {
        k.update(cx);
        k.update(cy);
        k.update(owner);
    }
    for a in amounts {
        k.update(&a.to_be_bytes());
    }
    let mut h = [0u8; 32];
    k.finalize(&mut h);
    h
}

// ──────────────────── Bitcoin T_CXFER kernel (BIP-340 Schnorr) ────────────────────

const CXFER_KERNEL_DOMAIN: &[u8] = b"tacit-kernel-v1";

/// BIP-340 tagged hash: sha256(sha256(tag) ‖ sha256(tag) ‖ msg).
fn bip340_tagged(tag: &[u8], msg: &[u8]) -> [u8; 32] {
    let t: [u8; 32] = Sha256::digest(tag).into();
    let mut h = Sha256::new();
    h.update(t);
    h.update(t);
    h.update(msg);
    h.finalize().into()
}

/// BIP-340 Schnorr verification (x-only pubkey) — ported from dapp/bulletproofs.js
/// `verifySchnorr`. Lifts `pubkey_x` to its even-y point P and checks `s·G − e·P == R`
/// with R even-y and `R.x == sig[0..32]`.
pub fn bip340_verify(sig: &[u8; 64], msg: &[u8; 32], pubkey_x: &[u8; 32]) -> bool {
    let rx = &sig[0..32];
    let s = match scalar_canonical_be(&sig[32..64]) {
        Some(s) => s,
        None => return false,
    };
    let mut comp = [0u8; 33];
    comp[0] = 0x02;
    comp[1..].copy_from_slice(pubkey_x);
    let p = match decompress(&comp) {
        Some(p) => p,
        None => return false,
    };
    let mut chal = Vec::with_capacity(96);
    chal.extend_from_slice(rx);
    chal.extend_from_slice(pubkey_x);
    chal.extend_from_slice(msg);
    let e = scalar_reduce_be(&bip340_tagged(b"BIP0340/challenge", &chal));
    let r = ProjectivePoint::generator() * s - p * e;
    if r == ProjectivePoint::identity() {
        return false;
    }
    let rb = compress(&r);
    rb[0] == 0x02 && &rb[1..] == rx
}

/// SPEC-BITCOIN-HOOK-AMENDMENT §1.4: verify a value-free Bitcoin-authorized call envelope. If its BIP-340
/// signature by `caller_pubkey` over the domain-tagged call binding (which includes the authorized `executor`
/// — pinning the call to one deployment, no cross-deployment replay) is valid, return (call_id, record_hash):
/// `call_id = keccak(caller_pubkey ‖ call_nonce)` is the one-shot key; `record_hash =
/// keccak(executor ‖ target ‖ calldata_hash ‖ caller_pubkey)` is byte-identical to the BtcCallExecutor's
/// `keccak(abi.encodePacked(address(this), target, calldataHash, callerPubkey))` check, so the executor can
/// only fire a call that named it. No value, no note — a fact, not an effect.
pub fn fold_btc_call(env: &bitcoin::BtcCallEnvelope) -> Option<([u8; 32], [u8; 32])> {
    let msg = kn(&[
        b"tacit-btc-call-v1",
        &env.executor,
        &env.target,
        &env.calldata_hash,
        &env.caller_pubkey,
        &env.call_nonce,
    ]);
    if !bip340_verify(&env.sig, &msg, &env.caller_pubkey) {
        return None;
    }
    let call_id = kn(&[&env.caller_pubkey, &env.call_nonce]);
    let record_hash = kn(&[&env.executor, &env.target, &env.calldata_hash, &env.caller_pubkey]);
    Some((call_id, record_hash))
}

/// Verify a Bitcoin T_CXFER / T_CXFER_BPP kernel: conservation proven as a BIP-340
/// Schnorr signature over the kernel message
///   sha256("tacit-kernel-v1" ‖ asset ‖ in_count ‖ (txid ‖ vout_LE)×in ‖ out_count ‖
///          commitment(33)×out ‖ burned_LE8),
/// with verify key `P = Σ C_in − Σ C_out − burned·H` (= excess·G, the blinding residue;
/// the validator equation Σ C_in == burned·H + Σ C_out + excess·G). The reflection prover
/// resolves `input_commitments` from the UTXO set and reads the output commitments
/// (compressed) from the envelope; `input_outpoints` are the tx's vin (internal-order
/// txid + vout) as `bitcoin::extract_inputs` returns them.
pub fn cxfer_kernel_verify(
    asset: &[u8; 32],
    input_outpoints: &[([u8; 32], u32)],
    input_commitments: &[Point],
    output_commitments_compressed: &[[u8; 33]],
    burned_amount: u64,
    kernel_sig: &[u8; 64],
) -> bool {
    if input_outpoints.len() != input_commitments.len() {
        return false;
    }
    if input_outpoints.len() > 255 || output_commitments_compressed.len() > 255 {
        return false;
    }
    let mut h = Sha256::new();
    h.update(CXFER_KERNEL_DOMAIN);
    h.update(asset);
    h.update([input_outpoints.len() as u8]);
    for (txid, vout) in input_outpoints {
        h.update(txid);
        h.update(vout.to_le_bytes());
    }
    h.update([output_commitments_compressed.len() as u8]);
    let mut out_points: Vec<Point> = Vec::with_capacity(output_commitments_compressed.len());
    for c in output_commitments_compressed {
        h.update(c);
        match decompress(c) {
            Some(p) => out_points.push(p),
            None => return false,
        }
    }
    h.update(burned_amount.to_le_bytes());
    let msg: [u8; 32] = h.finalize().into();

    let mut p = sum_points(input_commitments) - sum_points(&out_points);
    if burned_amount != 0 {
        p = p - gen_h() * Scalar::from(burned_amount);
    }
    if p == ProjectivePoint::identity() {
        return false;
    }
    let pc = compress(&p);
    let px: [u8; 32] = pc[1..].try_into().unwrap();
    bip340_verify(kernel_sig, &msg, &px)
}

/// Verify a `T_SWAP_VAR` (0x32) kernel signature — the input-side conservation of a public-reserve AMM
/// swap. Mirrors the worker's `ammSwapVarKernelVerifyPoint` + `ammKernelMsgV1` byte-for-byte: the verify
/// key is `(C_change_or_sentinel − C_in + delta_in_total·H).x_only` (the sentinel = all-zero ⇒ identity,
/// the exact-input no-change case), and the message is the same `tacit-kernel-v1` digest as a CXFER with
/// one input outpoint and `[C_change_or_sentinel]` as the single output. A valid sig proves
/// `C_in − C_change = delta_in_total·H + excess·G` — the taker really put `delta_in_total` (delta_in + tip)
/// of `asset_in` into the pool, with no H-inflation. (`cxfer_kernel_verify` can't be reused: it decompresses
/// every output, so the all-zero sentinel would fail.) See ops/DESIGN-bridge-multiasset-provenance.md (B).
pub fn swap_var_kernel_verify(
    asset_in: &[u8; 32],
    input_outpoint: ([u8; 32], u32),
    c_in: &[u8; 33],
    c_change_or_sentinel: &[u8; 33],
    delta_in_total: u64,
    kernel_sig: &[u8; 64],
) -> bool {
    // msg = tacit-kernel-v1 ‖ asset ‖ 1 ‖ (txid ‖ vout_LE) ‖ 1 ‖ c_change_or_sentinel ‖ delta_in_total_LE
    let mut h = Sha256::new();
    h.update(CXFER_KERNEL_DOMAIN);
    h.update(asset_in);
    h.update([1u8]);
    h.update(input_outpoint.0);
    h.update(input_outpoint.1.to_le_bytes());
    h.update([1u8]);
    h.update(c_change_or_sentinel);
    h.update(delta_in_total.to_le_bytes());
    let msg: [u8; 32] = h.finalize().into();

    let c_in_pt = match decompress(c_in) {
        Some(p) => p,
        None => return false,
    };
    let is_sentinel = c_change_or_sentinel.iter().all(|&b| b == 0);
    let c_change_pt = if is_sentinel {
        ProjectivePoint::identity() // sentinel (no change) ⇒ a zero output
    } else {
        match decompress(c_change_or_sentinel) {
            Some(p) => p,
            None => return false,
        }
    };
    // The generalized form: in = [C_in], out = [C_change], net = delta_in_total. The residue
    // `C_in − C_change − delta_in_total·H` is the negation of the worker's `C_change − C_in + …·H`;
    // the x-only verify key is identical, so this is byte-equal to the worker's check.
    asset_scoped_kernel_verify(&msg, &[c_in_pt], &[c_change_pt], delta_in_total, kernel_sig)
}

/// The per-asset `T_LP_ADD` / POOL_INIT conservation kernel domain (dapp/amm-kernel.js `DOMAIN_LP_ADD`).
pub const LP_ADD_KERNEL_DOMAIN: &[u8] = b"tacit-amm-lp-add-v1";

/// Verify a `T_LP_ADD` / POOL_INIT per-asset conservation kernel — proving the LP's inputs on asset X net
/// to EXACTLY `delta_x` of value (the reserve contribution). Mirrors dapp/amm-kernel.js `lpAddKernelMsg` +
/// `lpAddKernelKey` byte-for-byte: the verify key is `(Σ C_in_X − delta_x·H).x_only` (so the residue is the
/// LP's blinding excess and the inputs' VALUE sums to exactly `delta_x`), and the message binds
/// `(variant, pool_id, asset_x, delta_x, share_amount, share_csecp, input outpoints)`. A valid sig ⇒
/// `Σ value(C_in_X) = delta_x`, so a reserve credit is backed by the LP's REAL input notes.
///
/// The worker DEFERS this kernel (POOL_INIT pools are tagged `structural-only` until upgraded), so the
/// reflection is the authoritative conservation check for bridge purposes: a pool whose reserves the
/// reflection can't tie to real inputs never becomes `c0_backed`, so no swap against it onboards value.
/// See ops/DESIGN-bridge-multiasset-provenance.md (B).
#[allow(clippy::too_many_arguments)]
pub fn lp_add_kernel_verify(
    variant: u8,
    pool_id: &[u8; 32],
    asset_x: &[u8; 32],
    delta_x: u64,
    share_amount: u64,
    share_csecp: &[u8; 33],
    input_outpoints: &[([u8; 32], u32)],
    input_commitments: &[Point],
    sig: &[u8; 64],
) -> bool {
    if input_outpoints.is_empty() || input_outpoints.len() > 255 {
        return false;
    }
    if input_outpoints.len() != input_commitments.len() {
        return false;
    }
    // msg = tacit-amm-lp-add-v1 ‖ variant ‖ pool_id ‖ asset_x ‖ delta_x_LE ‖ share_amount_LE ‖
    //       share_csecp ‖ n_inputs ‖ (txid ‖ vout_LE)*
    let mut h = Sha256::new();
    h.update(LP_ADD_KERNEL_DOMAIN);
    h.update([variant]);
    h.update(pool_id);
    h.update(asset_x);
    h.update(delta_x.to_le_bytes());
    h.update(share_amount.to_le_bytes());
    h.update(share_csecp);
    h.update([input_outpoints.len() as u8]);
    for (txid, vout) in input_outpoints {
        h.update(txid);
        h.update(vout.to_le_bytes());
    }
    let msg: [u8; 32] = h.finalize().into();

    // The generalized form: in = the LP's asset-X inputs, out = [], net = delta_x.
    asset_scoped_kernel_verify(&msg, input_commitments, &[], delta_x, sig)
}

/// THE unifying conservation primitive (ops/DESIGN-bridge-multiasset-provenance.md). Every Tacit
/// value-moving op proves the SAME per-asset statement: the hidden input commitments minus the hidden
/// output commitments net to exactly `net` units of value with no extra H-term —
/// `Σ C_in − Σ C_out − net·H = excess·G`, where `excess` is the (per-op) signing key and the verify key
/// is that residue's x-only. CXFER (`net = burned`), `T_SWAP_VAR` (`in=[C_in]`, `out=[C_change]`,
/// `net = delta_in+tip`), `T_LP_ADD` (`out=[]`, `net = delta_X`), and `T_LP_REMOVE` (`in = LP-share notes`,
/// `out=[]`, `net = share_amount`) are ALL this kernel — they differ ONLY in the message `msg` (which binds
/// the op's public fields) and in what `net` denotes. One primitive verifies conservation for every op
/// (and any future op that conserves an asset against a public quantity). The aggregate Pedersen identity a
/// `T_SWAP_BATCH` proves is this same shape on the batch's net deltas — see the design doc for why the
/// batch's per-receipt SPLIT still needs its Groth16 even though its aggregate fits here.
pub fn asset_scoped_kernel_verify(
    msg: &[u8; 32],
    in_commitments: &[Point],
    out_commitments: &[Point],
    net: u64,
    sig: &[u8; 64],
) -> bool {
    let mut p = sum_points(in_commitments) - sum_points(out_commitments);
    if net != 0 {
        p = p - gen_h() * Scalar::from(net);
    }
    if p == ProjectivePoint::identity() {
        return false;
    }
    let pc = compress(&p);
    let px: [u8; 32] = pc[1..].try_into().unwrap();
    bip340_verify(sig, msg, &px)
}

/// The per-asset `T_LP_REMOVE` conservation kernel domain (dapp/amm-kernel.js `DOMAIN_LP_REMOVE`).
pub const LP_REMOVE_KERNEL_DOMAIN: &[u8] = b"tacit-amm-lp-remove-v1";

/// Verify a `T_LP_REMOVE` share-burn kernel — proving the LP's burned LP-share inputs net to EXACTLY
/// `share_amount` (anti-theft: only a real shareholder can withdraw). Mirrors dapp/amm-kernel.js
/// `lpRemoveKernelMsg` + `lpRemoveKernelKey`: verify key `(Σ C_in_LP − share_amount·H).x_only`, message
/// binds `(pool_id, share_amount, delta_a, delta_b, recv_a_secp, recv_b_secp, LP input outpoints)`. Just
/// the generalized kernel with `in = LP-share notes`, `out = []`, `net = share_amount`. (The withdrawn
/// `recv_X` values are bound to the public `delta_X` separately, by a reflection-witnessed opening — see
/// `fold_lp_remove`.)
#[allow(clippy::too_many_arguments)]
pub fn lp_remove_kernel_verify(
    pool_id: &[u8; 32],
    share_amount: u64,
    delta_a: u64,
    delta_b: u64,
    recv_a_secp: &[u8; 33],
    recv_b_secp: &[u8; 33],
    lp_input_outpoints: &[([u8; 32], u32)],
    lp_input_commitments: &[Point],
    sig: &[u8; 64],
) -> bool {
    if lp_input_outpoints.is_empty() || lp_input_outpoints.len() > 255 {
        return false;
    }
    if lp_input_outpoints.len() != lp_input_commitments.len() {
        return false;
    }
    // msg = tacit-amm-lp-remove-v1 ‖ pool_id ‖ share_amount_LE ‖ delta_a_LE ‖ delta_b_LE ‖
    //       recv_a_secp ‖ recv_b_secp ‖ n_inputs ‖ (txid ‖ vout_LE)*
    let mut h = Sha256::new();
    h.update(LP_REMOVE_KERNEL_DOMAIN);
    h.update(pool_id);
    h.update(share_amount.to_le_bytes());
    h.update(delta_a.to_le_bytes());
    h.update(delta_b.to_le_bytes());
    h.update(recv_a_secp);
    h.update(recv_b_secp);
    h.update([lp_input_outpoints.len() as u8]);
    for (txid, vout) in lp_input_outpoints {
        h.update(txid);
        h.update(vout.to_le_bytes());
    }
    let msg: [u8; 32] = h.finalize().into();

    asset_scoped_kernel_verify(&msg, lp_input_commitments, &[], share_amount, sig)
}

/// The per-asset `T_LP_BOND` conservation kernel domain (dapp/amm-kernel.js `DOMAIN_LP_BOND`).
pub const LP_BOND_KERNEL_DOMAIN: &[u8] = b"tacit-amm-lp-bond-v1";

/// Verify a `T_LP_BOND` share-lock kernel — proving the bonder's spent LP-share inputs net to EXACTLY
/// `bond_amount` of the farm's `lp_asset` (anti-theft: a bond's claimed weight must be backed by real,
/// spent LP-share notes, so an attacker can't credit unbacked shares and drain the treasury at harvest).
/// Same generalized kernel as `lp_remove` (`in = LP-share notes`, `out = []`, `net = bond_amount`); the msg
/// binds the farm + asset + spent outpoints. An empty input set (`bond_amount` from nothing) is rejected
/// both by the count guard and because `−bond_amount·H` is never `excess·G` for a known `excess`.
/// Mirrors dapp/amm-kernel.js `lpBondKernelMsg`/`lpBondKernelKey`.
#[allow(clippy::too_many_arguments)]
pub fn lp_bond_kernel_verify(
    farm_id: &[u8; 32],
    lp_asset: &[u8; 32],
    bond_amount: u64,
    lp_input_outpoints: &[([u8; 32], u32)],
    lp_input_commitments: &[Point],
    sig: &[u8; 64],
) -> bool {
    if lp_input_outpoints.is_empty() || lp_input_outpoints.len() > 255 {
        return false;
    }
    if lp_input_outpoints.len() != lp_input_commitments.len() {
        return false;
    }
    // msg = tacit-amm-lp-bond-v1 ‖ farm_id ‖ lp_asset ‖ bond_amount_LE ‖ n_inputs ‖ (txid ‖ vout_LE)*
    let mut h = Sha256::new();
    h.update(LP_BOND_KERNEL_DOMAIN);
    h.update(farm_id);
    h.update(lp_asset);
    h.update(bond_amount.to_le_bytes());
    h.update([lp_input_outpoints.len() as u8]);
    for (txid, vout) in lp_input_outpoints {
        h.update(txid);
        h.update(vout.to_le_bytes());
    }
    let msg: [u8; 32] = h.finalize().into();
    asset_scoped_kernel_verify(&msg, lp_input_commitments, &[], bond_amount, sig)
}

// ──────────────────── BP+ transcript (length-prefixed sha256) ────────────────────

struct Transcript {
    parts: Vec<u8>,
}
impl Transcript {
    fn new() -> Self { Transcript { parts: Vec::new() } }
    fn append(&mut self, label: &[u8], data: &[u8]) {
        self.parts.extend_from_slice(&(label.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(label);
        self.parts.extend_from_slice(&(data.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(data);
    }
    fn challenge(&mut self, label: &[u8]) -> Scalar {
        self.parts.extend_from_slice(&(label.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(label);
        let h: [u8; 32] = Sha256::digest(&self.parts).into();
        self.parts.extend_from_slice(&(h.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(&h);
        let c = scalar_reduce_be(&h);
        if c == Scalar::ZERO {
            let h2: [u8; 32] = Sha256::new().chain_update(h).chain_update([0x01u8]).finalize().into();
            return scalar_reduce_be(&h2);
        }
        c
    }
}

// ──────────────────── BP+ generators ────────────────────

fn hash_to_curve(domain: &[u8], idx: u32) -> ProjectivePoint {
    for counter in 0u8..=255 {
        let mut hasher = Sha256::new();
        hasher.update(domain);
        hasher.update(idx.to_le_bytes());
        hasher.update([counter]);
        let seed: [u8; 32] = hasher.finalize().into();
        let mut comp = [0u8; 33];
        comp[0] = 0x02;
        comp[1..].copy_from_slice(&seed);
        if let Some(p) = decompress(&comp) {
            if p != ProjectivePoint::identity() { return p; }
        }
    }
    panic!("hash_to_curve failed");
}

pub(crate) fn gen_h() -> ProjectivePoint {
    let hseed: [u8; 32] = Sha256::digest(b"tacit-generator-H-v1").into();
    for counter in 0u8..=255 {
        let mut hasher = Sha256::new();
        hasher.update(hseed);
        hasher.update([counter]);
        let x: [u8; 32] = hasher.finalize().into();
        let mut comp = [0u8; 33];
        comp[0] = 0x02;
        comp[1..].copy_from_slice(&x);
        if let Some(p) = decompress(&comp) {
            if p != ProjectivePoint::identity() { return p; }
        }
    }
    panic!("gen_h failed");
}

/// FS challenge for the cross-curve (secp256k1 ↔ BabyJubJub) Camenisch-Stadler sigma: the low 16 bytes of
/// `sha256("tacit-amm-xcurve-v1" ‖ C_secp ‖ C_BJJ ‖ A_secp ‖ A_BJJ)` — a 128-bit challenge. Mirrors
/// dapp/amm-sigma.js `challenge` (pure bytes, no curve ops). Consumed by BOTH the secp half (here) and the
/// BabyJubJub half (reflection bin, src/babyjubjub.rs); the shared 320-bit response `z_a` is what binds the
/// hidden amount across the two curves.
pub fn xcurve_challenge(c_secp: &[u8; 33], c_bjj: &[u8; 32], a_secp: &[u8; 33], a_bjj: &[u8; 32]) -> [u8; 16] {
    let mut h = Sha256::new();
    h.update(b"tacit-amm-xcurve-v1");
    h.update(c_secp);
    h.update(c_bjj);
    h.update(a_secp);
    h.update(a_bjj);
    let d: [u8; 32] = h.finalize().into();
    let mut e = [0u8; 16];
    e.copy_from_slice(&d[16..32]);
    e
}

/// Verify the SECP256K1 half of the cross-curve sigma:
///   `z_a·H_secp + z_r_secp·G_secp == A_secp + e·C_secp`
/// with `z_a` the shared 320-bit response (reduced mod n in the order-n group) and `e` the 16-byte FS
/// challenge. Mirrors dapp/amm-sigma.js `verifyXCurve` (secp branch). Fail-closed on a non-canonical
/// `z_r_secp` (≥ n), a non-curve-point `C_secp`/`A_secp`, or an unsatisfied equation. The BabyJubJub half
/// (`src/babyjubjub.rs`) must ALSO hold for the binding.
pub fn xcurve_secp_check(c_secp: &[u8; 33], a_secp: &[u8; 33], z_a: &[u8; 40], z_r_secp: &[u8; 32], e: &[u8; 16]) -> bool {
    // z_r_secp must be canonical (< n) — mirrors the dapp's `z_r_secp >= SECP_N` reject.
    let zrs = match Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(*z_r_secp))) {
        Some(s) => s,
        None => return false,
    };
    let c256 = Scalar::from(256u64);
    // z_a (320-bit, BE) reduced mod n by Horner; (z_a mod n)·H == z_a·H in the order-n group.
    let mut za = Scalar::from(0u64);
    for &b in z_a.iter() {
        za = za * c256 + Scalar::from(b as u64);
    }
    // e (128-bit, BE) → Scalar by Horner (e < n trivially).
    let mut es = Scalar::from(0u64);
    for &b in e.iter() {
        es = es * c256 + Scalar::from(b as u64);
    }
    let (cs, asp) = match (decompress(c_secp), decompress(a_secp)) {
        (Some(x), Some(y)) => (x, y),
        _ => return false,
    };
    gen_h() * za + ProjectivePoint::generator() * zrs == asp + cs * es
}

/// Verify the `T_SWAP_BATCH` aggregate Pedersen identity for ONE asset X (called for both A and B):
///   `Σ_{X-input intents} C_in_secp − Σ_{X-output intents} C_out_secp − tip_X_C_secp − δ_X·H == R_net_X·G`
/// Mirrors the worker `ammCheckAggregatePedersen`. This binds the batch's receipts (the bridgeable notes) to
/// the traders' REAL spent input notes + the public net delta + the c0-backed reserve — so the TOTAL onboarded
/// can't exceed what the real inputs + reserve back (the per-receipt SPLIT is bound separately by the Groth16).
/// `intents` = `(direction, C_in_secp)` per intent; `receipts_c_out` = `C_out_secp` per receipt (same order).
/// For asset A (`asset_x_is_a = true`): input-side = direction 0 (A→B), output-side = direction 1; swapped for
/// asset B. `delta_x_sign`: 0 ⇒ +mag (reserve grows), 1 ⇒ −mag. Fail-closed on any non-curve-point input or a
/// length mismatch. The caller must ALSO confirm each `C_in_secp` is a real spent pool note (the live set).
pub fn swap_batch_aggregate_identity(
    intents: &[(u8, [u8; 33])],
    receipts_c_out: &[[u8; 33]],
    asset_x_is_a: bool,
    delta_x_sign: u8,
    delta_x_mag: u64,
    tip_x_c_secp: &[u8; 33],
    r_net_x: &[u8; 32],
) -> bool {
    if intents.len() != receipts_c_out.len() {
        return false;
    }
    let mut sum = ProjectivePoint::identity();
    for (i, (direction, c_in_secp)) in intents.iter().enumerate() {
        let is_input = (asset_x_is_a && *direction == 0) || (!asset_x_is_a && *direction == 1);
        let is_output = (asset_x_is_a && *direction == 1) || (!asset_x_is_a && *direction == 0);
        if is_input {
            match decompress(c_in_secp) {
                Some(p) => sum = sum + p,
                None => return false,
            }
        } else if is_output {
            match decompress(&receipts_c_out[i]) {
                Some(p) => sum = sum - p,
                None => return false,
            }
        }
    }
    // The caller first verifies this commitment opens to the Groth16-public tip amount under the envelope's
    // r_tip. Once bound, subtracting the full point mirrors the worker and includes its blinding in R_net.
    sum = match decompress(tip_x_c_secp) {
        Some(p) => sum - p,
        None => return false,
    };
    if delta_x_mag != 0 {
        let dh = gen_h() * Scalar::from(delta_x_mag);
        sum = if delta_x_sign == 0 { sum - dh } else { sum + dh };
    }
    // R_net_X reduced mod n (the worker uses modN, not a strict reject), then `sum == R_net_X·G`.
    sum == ProjectivePoint::generator() * scalar_reduce_be(r_net_x)
}

/// SHA-256 of `data` (sp1-patched in-zkVM). Exposed for the reflection bin — e.g. the T_SWAP_BATCH
/// `pool_id_fr = SHA256(pool_id) mod r` public-signal derivation.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn bpp_gens(mn: usize) -> (Vec<ProjectivePoint>, Vec<ProjectivePoint>, ProjectivePoint) {
    let gvec: Vec<_> = (0..mn).map(|i| hash_to_curve(b"tacit-bp-G-v1", i as u32)).collect();
    let hvec: Vec<_> = (0..mn).map(|i| hash_to_curve(b"tacit-bp-H-v1", i as u32)).collect();
    (gvec, hvec, gen_h())
}

// ──────────────────── BP+ aggregated range verifier ────────────────────

fn sum_of_scalar_powers(x: &Scalar, n: usize) -> Scalar {
    let mut res = Scalar::ZERO;
    let mut xpow = Scalar::ONE;
    for _ in 0..n {
        xpow *= x;
        res += xpow;
    }
    res
}

fn sum_of_even_powers(x: &Scalar, n: usize) -> Scalar {
    let mut x1 = *x * x; // x^2
    let mut res = x1;
    let mut nn = n;
    while nn > 2 {
        res += x1 * res;
        x1 = x1 * x1;
        nn /= 2;
    }
    res
}

/// Ported from dapp/bulletproofs-plus.js::bppRangeVerify. Returns true iff the
/// aggregated range proof shows every committed value ∈ [0, 2^64).
pub fn verify_range(commitments: &[ProjectivePoint], proof: &[u8]) -> bool {
    let m = commitments.len();
    if ![1usize, 2, 4, 8].contains(&m) { return false; }
    let log_m = m.trailing_zeros() as usize;
    let log_mn = log_m + 6;
    let mn = m * N_BITS;
    if proof.len() != 99 + 96 + log_mn * 66 { return false; }

    // ---- parse ----
    let mut off = 0usize;
    let take33 = |o: &mut usize| -> Option<ProjectivePoint> {
        let mut a = [0u8; 33];
        a.copy_from_slice(&proof[*o..*o + 33]);
        *o += 33;
        decompress(&a)
    };
    let a_pt = match take33(&mut off) { Some(p) => p, None => return false };
    let a1 = match take33(&mut off) { Some(p) => p, None => return false };
    let b_pt = match take33(&mut off) { Some(p) => p, None => return false };
    let r1 = match scalar_canonical_be(&proof[off..off + 32]) { Some(s) => s, None => return false };
    off += 32;
    let s1 = match scalar_canonical_be(&proof[off..off + 32]) { Some(s) => s, None => return false };
    off += 32;
    let d1 = match scalar_canonical_be(&proof[off..off + 32]) { Some(s) => s, None => return false };
    off += 32;
    let mut lvec = Vec::with_capacity(log_mn);
    let mut rvec = Vec::with_capacity(log_mn);
    for _ in 0..log_mn {
        match take33(&mut off) { Some(p) => lvec.push(p), None => return false }
        match take33(&mut off) { Some(p) => rvec.push(p), None => return false }
    }
    if off != proof.len() { return false; }

    // ---- transcript replay ----
    let mut t = Transcript::new();
    t.append(b"domain", BPP_DOMAIN);
    t.append(b"M", &[(m & 0xff) as u8]);
    for v in commitments { t.append(b"V", &compress(v)); }
    t.append(b"A", &compress(&a_pt));
    let y = t.challenge(b"y");
    let z = t.challenge(b"z");
    let zsq = z * z;
    let mut challenges = Vec::with_capacity(log_mn);
    for k in 0..log_mn {
        t.append(b"L", &compress(&lvec[k]));
        t.append(b"R", &compress(&rvec[k]));
        challenges.push(t.challenge(b"u"));
    }
    t.append(b"A1", &compress(&a1));
    t.append(b"B", &compress(&b_pt));
    let e = t.challenge(b"e");
    let esq = e * e;

    // ---- inverses ---- (reject, don't panic, on a zero scalar: the transcript avoids a zero challenge,
    // but a hostile proof shouldn't be able to panic the guest — a non-invertible scalar is just invalid)
    let y_inv = match Option::<Scalar>::from(y.invert()) { Some(v) => v, None => return false };
    let mut challenges_inv: Vec<Scalar> = Vec::with_capacity(challenges.len());
    for u in &challenges {
        match Option::<Scalar>::from(u.invert()) { Some(v) => challenges_inv.push(v), None => return false }
    }

    // ---- y^MN, y^(MN+1) ----
    let mut y_mn = y;
    let mut tmp = mn;
    while tmp > 1 { y_mn = y_mn * y_mn; tmp /= 2; }
    let y_mn_1 = y_mn * y;

    // ---- d[j*N+i] = z^(2(j+1)) · 2^i ----
    let two = Scalar::from(2u64);
    let mut d = vec![Scalar::ZERO; mn];
    d[0] = zsq;
    for i in 1..N_BITS { d[i] = d[i - 1] * two; }
    for j in 1..m {
        for i in 0..N_BITS { d[j * N_BITS + i] = d[(j - 1) * N_BITS + i] * zsq; }
    }

    // ---- challenges_cache (IPA s-vector) ----
    let mut cache = vec![Scalar::ZERO; 1 << log_mn];
    cache[0] = challenges_inv[0];
    cache[1] = challenges[0];
    for j in 1..log_mn {
        let slots = 1usize << (j + 1);
        let mut s = slots;
        while s > 0 {
            s -= 1;
            cache[s] = if s & 1 == 1 {
                cache[s >> 1] * challenges[j]
            } else {
                cache[s >> 1] * challenges_inv[j]
            };
        }
    }

    // ---- generators ----
    let (gvec, hvec, h_gen) = bpp_gens(mn);

    // ---- scalar terms ----
    let sum_y_mn = sum_of_scalar_powers(&y, mn);
    let two_pow_n_minus_1 = Scalar::from(u64::MAX); // 2^64 - 1
    let sum_d_val = two_pow_n_minus_1 * sum_of_even_powers(&z, 2 * m);

    let h_term1 = r1 * y * s1;
    let zsq_minus_z = zsq - z;
    let h_inner = zsq_minus_z * sum_y_mn + (y_mn_1 * z * sum_d_val);
    let h_scalar = h_term1 + esq * h_inner;
    let g_scalar = d1;

    let neg_esq = -esq;
    let base_v = neg_esq * y_mn_1; // -e²·y^(MN+1)
    let mut v_scalars = Vec::with_capacity(m);
    {
        let mut zp = zsq;
        for _ in 0..m { v_scalars.push(base_v * zp); zp = zp * zsq; }
    }

    let a_scalar = -esq;
    let a1_scalar = -e;
    let b_scalar = -Scalar::ONE;

    let mut l_scalars = Vec::with_capacity(log_mn);
    let mut r_scalars = Vec::with_capacity(log_mn);
    for k in 0..log_mn {
        let usq = challenges[k] * challenges[k];
        let uinvsq = challenges_inv[k] * challenges_inv[k];
        l_scalars.push(neg_esq * usq);
        r_scalars.push(neg_esq * uinvsq);
    }

    // ---- per-index G_i / H_i scalars ----
    let mut gi = vec![Scalar::ZERO; mn];
    let mut hi = vec![Scalar::ZERO; mn];
    let mut e_r1_yinv_i = e * r1;
    let e_s1 = e * s1;
    let esq_z = esq * z;
    let neg_esq_z = -esq_z;
    let mut neg_esq_y_mn_minus_i = -(esq * y_mn);
    let mn_minus_1 = mn - 1;
    for i in 0..mn {
        gi[i] = e_r1_yinv_i * cache[i] + esq_z;
        let rev = mn_minus_1 ^ i;
        hi[i] = e_s1 * cache[rev] + neg_esq_z + (neg_esq_y_mn_minus_i * d[i]);
        e_r1_yinv_i = e_r1_yinv_i * y_inv;
        neg_esq_y_mn_minus_i = neg_esq_y_mn_minus_i * y_inv;
    }

    // ---- single MSM: must be identity ----
    let mut acc = ProjectivePoint::generator() * g_scalar;
    acc += h_gen * h_scalar;
    for i in 0..mn {
        acc += gvec[i] * gi[i];
        acc += hvec[i] * hi[i];
    }
    for j in 0..m { acc += commitments[j] * v_scalars[j]; }
    acc += a_pt * a_scalar;
    acc += a1 * a1_scalar;
    acc += b_pt * b_scalar;
    for k in 0..log_mn {
        acc += lvec[k] * l_scalars[k];
        acc += rvec[k] * r_scalars[k];
    }

    acc == ProjectivePoint::identity()
}

// ──────────────────── wrap/unwrap opening + keccak note helpers ────────────────────

/// Build a point from big-endian affine (x, y) — the dapp serializes commitments
/// this way for the contract leaf preimage.
pub fn from_affine_xy(x: &[u8; 32], y: &[u8; 32]) -> Option<ProjectivePoint> {
    let mut enc = [0u8; 65];
    enc[0] = 0x04;
    enc[1..33].copy_from_slice(x);
    enc[33..].copy_from_slice(y);
    let ep = EncodedPoint::from_bytes(enc).ok()?;
    let aff: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    aff.map(ProjectivePoint::from)
}

/// wrap/unwrap public-amount opening: C == v·H + r·G (v public, r in the witness).
/// Same scheme as the bridge guest's verify_pedersen_opening.
pub fn verify_pedersen_opening(c: &ProjectivePoint, v: u64, r: &Scalar) -> bool {
    *c == gen_h() * Scalar::from(v) + ProjectivePoint::generator() * r
}

fn k2(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(l); k.update(r);
    let mut o = [0u8; 32]; k.finalize(&mut o); o
}
fn kn(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak::v256();
    for p in parts { k.update(p); }
    let mut o = [0u8; 32]; k.finalize(&mut o); o
}

/// The CANONICAL Bitcoin vout of a CXFER-family envelope's `i`-th confidential output (of `n_outputs`),
/// mirroring the worker/dapp `commitmentForUtxo` (`getParentEnvelopeData`) — the single convention that
/// DEFINES where a note's commitment sits on-chain. SINGLE SOURCE OF TRUTH for both the live reflection
/// fold (reflect.rs) and the scan-free burn-deposit DAG (burn_deposit::verify_cxfers); a divergence between
/// them is exactly how an AXFER_VAR maker-change note got keyed at the wrong outpoint (undetected spend).
///  - T_CXFER (0x23) / T_CXFER_BPP (0x22) / T_AXFER (0x26) / T_AXFER_BPP (0x3C): IDENTITY — output `i` is at
///    vout `i` (any vout ≥ N is an aux non-tacit BTC output, not a pool UTXO);
///  - T_AXFER_VAR (0x37) / T_AXFER_VAR_BPP (0x3D): the INTERLEAVED variable-amount atomic-settlement layout
///    (SPEC §5.7.9) — output 0 → vout 0 (recipient), output 1 → vout 2 (maker change); vout 1 is the maker
///    BTC payment, vout 3 the OP_RETURN. N ∈ {1, 2}.
/// `None` for an index with no canonical tacit vout under the opcode's layout (caller fails closed / skips).
pub fn canonical_output_vout(opcode: u8, i: usize, n_outputs: usize) -> Option<u32> {
    match opcode {
        0x23 | 0x22 | 0x26 | 0x3C => Some(i as u32), // identity
        0x37 | 0x3D => match i {                     // interleaved (recipient @0, maker change @2)
            0 => Some(0),
            1 if n_outputs >= 2 => Some(2),
            _ => None,
        },
        _ => None,
    }
}

/// The CANONICAL Bitcoin vout of a preauth-bid envelope's `i`-th confidential output, mirroring the dapp
/// `getParentEnvelopeData` bid arms (tacit.js): the bid tx carries the envelope-hash OP_RETURN at vout 0
/// is NOT used here — for bids the buyer FILLED note is at vout 0 and the seller CHANGE at a fixed later
/// vout. T_PREAUTH_BID (0x5B, exact-fill): output 0 → vout 0, output 1 (seller change) → vout 3.
/// T_PREAUTH_BID_VAR (0x5C): output 0 → vout 0, output 1 → vout 4 when the bid has a buyer refund
/// (fill_amount < max_fill) else vout 3. `None` for an unmapped index.
pub fn canonical_bid_output_vout(opcode: u8, i: usize, n_outputs: usize, has_refund: bool) -> Option<u32> {
    match (opcode, i) {
        (0x5B, 0) | (0x5C, 0) => Some(0),
        (0x5B, 1) if n_outputs >= 2 => Some(3),
        (0x5C, 1) if n_outputs >= 2 => Some(if has_refund { 4 } else { 3 }),
        _ => None,
    }
}

/// The CANONICAL Bitcoin vout of a WITNESS-ENVELOPE AMM op's `i`-th onboarded confidential note. These ops
/// (T_LP_ADD/POOL_INIT 0x2D, T_LP_REMOVE 0x2E, T_PROTOCOL_FEE_CLAIM 0x31) carry the Tacit envelope in the
/// Taproot script-path WITNESS with NO OP_RETURN at vout 0, so their tacit notes begin at vout 0 — mirroring
/// the worker/dapp `getParentEnvelopeData` (T_LP_ADD: vout 0 only; T_LP_REMOVE: recvA vout 0 / recvB vout 1;
/// T_PROTOCOL_FEE_CLAIM: vout 0 only). This is DISTINCT from the OP_RETURN-prefixed AMM/farm reveals
/// (T_SWAP_VAR / T_SWAP_ROUTE / T_LP_UNBOND / T_LP_HARVEST / T_FARM_REFUND), whose envelope-hash sits at vout
/// 0 so their notes start at vout 1 — those key in their own reflect.rs branches. Keying a witness-envelope
/// note one vout too high drops it from the live UTXO set, so its later real Bitcoin spend (at vout 0) goes
/// UNDETECTED — a cross-lane double-spend. `None` for an unmapped (opcode, index).
pub fn canonical_amm_output_vout(opcode: u8, i: usize) -> Option<u32> {
    match (opcode, i) {
        (0x2D, 0) => Some(0), // T_LP_ADD / POOL_INIT: the minted LP-share note
        (0x2E, 0) => Some(0), // T_LP_REMOVE: recvA (asset A withdrawal)
        (0x2E, 1) => Some(1), // T_LP_REMOVE: recvB (asset B withdrawal)
        (0x31, 0) => Some(0), // T_PROTOCOL_FEE_CLAIM: the crystallized claim note
        _ => None,
    }
}

/// leaf = keccak(asset_id ‖ Cx ‖ Cy ‖ owner) — matches ConfidentialPool + the dapp.
pub fn leaf(asset_id: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    kn(&[asset_id, cx, cy, owner])
}
/// nullifier = keccak(Cx ‖ Cy ‖ "spent") — note-bound (spec B3), chain-independent.
/// Derived from the membership-proven commitment, NOT a free witness secret, so a note
/// has exactly one nullifier and cannot be re-spent under a fresh secret.
/// The asset id is intentionally NOT in the preimage: the Bitcoin spent set binds ν to the
/// commitment alone (`bind_spent_note` has no asset), so the SAME note must hash to the SAME ν
/// on both chains for the cross-lane gates (`check_btc_nonmembership`, bridge-mint) to match.
/// Adding the asset here would split ν across chains and reopen a cross-lane double-spend. Two
/// different-asset notes collide only if they share (Cx,Cy), i.e. identical (value, blinding) —
/// the wallet's blinding is keyed by asset id (deriveNote), so this never happens by construction.
pub fn nullifier(cx: &[u8; 32], cy: &[u8; 32]) -> [u8; 32] { kn(&[cx, cy, b"spent"]) }
/// The UTXO-set value for a pool note: keccak(Cx ‖ Cy), binding the outpoint to its
/// commitment. The reflection prover stores this when an output lands and, on spend,
/// re-opens it to derive ν — so a spend's ν is forced to be the note actually at that outpoint.
pub fn commitment_hash(cx: &[u8; 32], cy: &[u8; 32]) -> [u8; 32] { kn(&[cx, cy]) }
/// The commitment_hash of a COMPRESSED secp256k1 commitment, as a CXFER envelope carries it:
/// decompress → affine (Cx,Cy) → keccak(Cx,Cy). The reflection prover binds each output note's
/// stored UTXO value to the envelope's declared commitment, so a fake/unbacked note (with a
/// commitment the confirmed tx never declared) cannot enter the pool. None if not a curve point.
pub fn commitment_hash_compressed(compressed: &[u8; 33]) -> Option<[u8; 32]> {
    let enc = decompress(compressed)?.to_affine().to_encoded_point(false);
    let b = enc.as_bytes();
    if b.len() != 65 { return None; }
    let cx: [u8; 32] = b[1..33].try_into().ok()?;
    let cy: [u8; 32] = b[33..65].try_into().ok()?;
    Some(commitment_hash(&cx, &cy))
}
/// The reflected pool-note leaf for a confirmed CXFER output: `leaf(asset, Cx, Cy, 0)`, where
/// (Cx,Cy) is the DECOMPRESSED envelope commitment and the owner is the zero sentinel (a
/// Bitcoin-homed note carries no owner — the dapp reflection indexer uses the same ZERO_OWNER).
/// The reflection prover MUST derive the appended note leaf this way rather than read it as a free
/// witness: the note tree's root is committed as `bitcoinPoolRoot` and a btcHomed settle spends
/// against it by membership, so a witnessed leaf would let a relayer append an arbitrary
/// attacker-spendable leaf (value minted from nothing). None if the commitment isn't a curve point.
pub fn reflected_note_leaf(asset: &[u8; 32], compressed: &[u8; 33]) -> Option<[u8; 32]> {
    let enc = decompress(compressed)?.to_affine().to_encoded_point(false);
    let b = enc.as_bytes();
    if b.len() != 65 { return None; }
    let cx: [u8; 32] = b[1..33].try_into().ok()?;
    let cy: [u8; 32] = b[33..65].try_into().ok()?;
    Some(leaf(asset, &cx, &cy, &[0u8; 32]))
}
/// The UTXO-set key for a Bitcoin outpoint: keccak(txid ‖ vout_le). The reflection prover
/// derives this from a confirmed tx's vin (`extract_inputs`), so a spent outpoint is forced
/// to be a real prior output and not a witnessed value.
pub fn outpoint_key(txid: &[u8; 32], vout: u32) -> [u8; 32] { kn(&[txid, &vout.to_le_bytes()]) }
/// The adaptor-swap LOCK-SET leaf for a confidentially-locked note (ops/DESIGN-adaptor-swap-guest.md):
/// binds the `asset` id, the locked note's commitment (Cx,Cy), the adaptor point T (the PTLC secret hole,
/// Tx,Ty), the `deadline`, and BOTH parties (`recipient` paid on claim / `locker` repaid on refund). A CLAIM/REFUND
/// must reproduce this EXACT leaf to prove lock-set membership, so neither the relayer nor the
/// counterparty can redirect the output (the paid party is in the leaf), re-time the swap (the deadline
/// is in the leaf), substitute a different adaptor point (T is in the leaf), or settle the locked value as a
/// different asset (the asset id is in the leaf — value commitments share one global generator H, so the
/// kernel alone does not constrain the asset). Domain-separated from the
/// note-tree `leaf` so a lock leaf is never spendable by a normal OP_TRANSFER. Value stays hidden — it
/// rides the note commitment, bound by an opening sigma at lock/claim/refund like OP_OTC.
#[allow(clippy::too_many_arguments)]
pub fn adaptor_lock_leaf(
    asset: &[u8; 32],
    cx: &[u8; 32], cy: &[u8; 32],
    tx: &[u8; 32], ty: &[u8; 32],
    deadline: u64,
    recipient: &[u8; 32], locker: &[u8; 32],
) -> [u8; 32] {
    kn(&[ADAPTOR_LOCK_DOMAIN, asset, cx, cy, tx, ty, &deadline.to_be_bytes(), recipient, locker])
}

// ──────────────────── stealth-receive (ops/DESIGN-confidential-stealth-receive.md) ────────────────────
// Non-interactive send-to-address: lock a note under the recipient's one-time stealth pubkey in the SAME
// lock-set as adaptor (disjoint domain ⇒ a stealth claim and an adaptor claim can never spend each other's
// locks), and gate the claim with a BIP-340 signature under that pubkey. The sender knows the lock's blinding
// but not the recipient's one-time key, and the locked note is unreachable by transfer/swap — so only the
// recipient can claim. `amount` is bound in the leaf so the claim's output cannot inflate.

/// Stealth-lock leaf domain — disjoint from `ADAPTOR_LOCK_DOMAIN` though both ride the shared lock-set.
pub const STEALTH_LOCK_DOMAIN: &[u8] = b"tacit-stealth-lock-v1";
/// Domain of the message the recipient signs (BIP-340 under their one-time pubkey) to claim a stealth lock.
pub const STEALTH_CLAIM_DOMAIN: &[u8] = b"tacit-stealth-claim-v1";

/// Lock-set leaf for a stealth lock: note `L=commit(amount,r_L)` locked under the recipient one-time x-only
/// pubkey `owner_pub`. `amount` is bound (membership pins the locked value ⇒ the claim cannot over-mint);
/// `deadline`/`locker` carry the refund path (the locker reclaims after the deadline if never claimed).
#[allow(clippy::too_many_arguments)]
pub fn stealth_lock_leaf(
    asset: &[u8; 32],
    cx: &[u8; 32], cy: &[u8; 32],
    owner_pub: &[u8; 32],
    amount: u64,
    deadline: u64,
    locker: &[u8; 32],
) -> [u8; 32] {
    kn(&[
        STEALTH_LOCK_DOMAIN, asset, cx, cy, owner_pub,
        &amount.to_be_bytes(), &deadline.to_be_bytes(), locker,
    ])
}

/// The message the recipient signs (BIP-340 under `owner_pub`) to CLAIM a stealth lock — binds the exact lock
/// leaf and the exact output note `M` + relay `fee`. Only the holder of `owner_pub`'s one-time key can sign,
/// and only for THIS output: neither the sender (who knows the lock) nor a relayer can claim or redirect it.
pub fn stealth_claim_msg(
    chain_binding: &[u8; 32],
    lock_leaf: &[u8; 32],
    m_cx: &[u8; 32], m_cy: &[u8; 32], m_owner: &[u8; 32],
    amount: u64,
    fee: u64,
) -> [u8; 32] {
    kn(&[
        STEALTH_CLAIM_DOMAIN, chain_binding, lock_leaf, m_cx, m_cy, m_owner,
        &amount.to_be_bytes(), &fee.to_be_bytes(),
    ])
}

// ──────────────────── generic confidential CDP (ops/DESIGN-confidential-defi-v1.md §4) ────────────────────
// A position locks a BASKET of collateral legs and mints a controller-derived debt asset against it. The
// guest freezes ONLY the structure + conservation; ALL pricing/ratio policy lives in the MUTABLE Ethereum
// controller, which the pool calls at settle (`onCdpMint`/`onCdpLiquidate`). cUSD-on-cBTC is the first
// instance; a single-leg basket (n=1) is the simple case, n>1 the MakerDAO-style multi-collateral one.

/// CDP position-leaf domain — disjoint from the note-tree `leaf`, the adaptor lock set, and the cBTC lock
/// set, so collateral locked in a position is NEVER spendable by a normal transfer.
pub const CDP_POSITION_DOMAIN: &[u8] = b"tacit-cdp-position-v1";
/// CDP debt-asset domain — the debt asset id is derived from the CONTROLLER alone.
pub const CDP_DEBT_DOMAIN: &[u8] = b"tacit-cdp-debt-v1";

/// The CDP debt asset id = keccak(CDP_DEBT_DOMAIN ‖ controller) — derived from the controller (an Ethereum
/// address) ALONE, so ONE controller mints ONE debt asset regardless of the basket. A controller is the
/// SOLE minter of its own asset (permissionless, no registry/admin); a rogue controller can only inflate
/// its OWN worthless-unless-collateralized token, never an existing asset (cBTC/TAC). The contract
/// re-derives the same id and enforces `debt_asset == cdp_debt_asset_id(controller)`.
pub fn cdp_debt_asset_id(controller: &[u8; 20]) -> [u8; 32] {
    kn(&[CDP_DEBT_DOMAIN, controller])
}

/// One collateral basket leg's hash: keccak(asset ‖ value_be). The leg value is PUBLIC at the CDP
/// boundary (so the controller can price it on-chain via Chainlink). It binds (asset, value) only — the
/// original collateral note is SPENT at mint, and CLOSE re-mints a FRESH note opening to this recorded
/// value (re-minting the original commitment would collide with its already-spent nullifier), so the
/// commitment is not part of the leg. Position uniqueness comes from the leaf nonce.
pub fn cdp_basket_leg(asset: &[u8; 32], value: u64) -> [u8; 32] {
    let mut v32 = [0u8; 32];
    v32[24..].copy_from_slice(&value.to_be_bytes());
    kn(&[asset, &v32])
}

/// The basket root = keccak Merkle root over the leg hashes (in witnessed order). Binds the WHOLE basket
/// into the position leaf, so CLOSE/LIQUIDATE must reproduce every leg to act on the position.
pub fn cdp_basket_root(legs: &[[u8; 32]]) -> [u8; 32] {
    keccak_merkle_root(legs)
}

/// The CDP position leaf: binds the controller, its derived debt asset, the basket root, the PUBLIC debt
/// value, the (confidential) owner, and a uniqueness nonce. CLOSE/LIQUIDATE reproduce this EXACT leaf to
/// prove membership, so a relayer can't free a different position, change the debt, or redirect the
/// collateral. Domain-separated (CDP_POSITION_DOMAIN).
/// `rate_snapshot` is the controller's RAY-scaled debt accumulator captured at mint (32-byte big-endian),
/// committed so the controller can compute accrued debt `principal · rate / rate_snapshot` at close. Bound
/// into the leaf so CLOSE/LIQUIDATE/TOPUP reproduce it exactly (membership pins it — a borrower cannot forge
/// a higher snapshot to dodge the stability fee). Inert (0) for fee-free controllers (farms).
pub fn cdp_position_leaf(
    controller: &[u8; 20], debt_asset: &[u8; 32], basket_root: &[u8; 32],
    debt_value: u64, rate_snapshot: &[u8; 32], owner: &[u8; 32], nonce: &[u8; 32],
) -> [u8; 32] {
    let mut dv = [0u8; 32];
    dv[24..].copy_from_slice(&debt_value.to_be_bytes());
    kn(&[CDP_POSITION_DOMAIN, controller, debt_asset, basket_root, &dv, rate_snapshot, owner, nonce])
}

/// The CDP position nullifier (spend-once): keccak(CDP_POSITION_DOMAIN ‖ position_leaf ‖ "spent"). The
/// contract dedups it across CLOSE/LIQUIDATE so a position is consumed at most once.
pub fn cdp_position_nullifier(position_leaf: &[u8; 32]) -> [u8; 32] {
    kn(&[CDP_POSITION_DOMAIN, position_leaf, b"spent"])
}

/// CDP voluntary-close authorization domain — disjoint from the position leaf.
pub const CDP_CLOSE_DOMAIN: &[u8] = b"tacit-cdp-close-auth-v1";

/// The message a position owner BIP-340-signs to authorize a voluntary CLOSE: binds the chain, the exact
/// position being closed, and a digest of the released collateral commitments (so a relayer cannot redirect
/// the reclaimed collateral to notes it controls). Close has no controller health veto, and the position
/// leaf + `owner` are public — without this signature anyone could reconstruct the leaf, repay the public
/// debt, and seize the owner's collateral as bearer notes they chose the blinding for (CDP-CLOSE-OWNER-001).
/// `released` = each released leg's (asset ‖ value_be ‖ Cx ‖ Cy) in order ‖ fee_be (hashed in-place here).
pub fn cdp_close_msg(chain_binding: &[u8; 32], position_leaf: &[u8; 32], released: &[u8]) -> [u8; 32] {
    kn(&[CDP_CLOSE_DOMAIN, chain_binding, position_leaf, released])
}

/// Confidential-AMM pool id, matching `ConfidentialPool`'s `keccak256(abi.encode(low, high, feeBps))`
/// (three 32-byte ABI words). Binds an OP_SWAP/LP batch's reserves to the exact (canonical pair, fee
/// tier) pool, so a prover can't settle one pool's op against another's reserves.
pub fn pool_id(asset_a: &[u8; 32], asset_b: &[u8; 32], fee_bps: u32) -> [u8; 32] {
    // Canonical asset pair + fee tier: keccak(low ‖ high ‖ fee_be32). (low,high) = the assets sorted
    // by byte order; fee_be32 = fee_bps as a 32-byte BE word. Canonical so (A,B)≡(B,A) (one pool per
    // pair); fee-bound so each fee tier is a DISTINCT pool — an LP just picks its tier, nothing to
    // squat. (No capability-flags byte: on EVM a pool "capability" is a real hook contract, not a
    // reserved flag, so it'd be added as a bound hooks address when that feature exists — not cargo-
    // culted from the Bitcoin circuit's flagsByte.)
    let (low, high) = if bitcoin::be_bytes_lte(asset_a, asset_b) { (asset_a, asset_b) } else { (asset_b, asset_a) };
    let mut fee = [0u8; 32];
    fee[28..].copy_from_slice(&fee_bps.to_be_bytes());
    kn(&[low, high, &fee])
}
/// EVM AMM pool_id WITH an optional Uniswap-V2-style protocol-fee skim. `protocol_fee_bps == 0` returns
/// the canonical no-skim `pool_id` (byte-identical — a fee-free pool is unchanged). A non-zero skim appends
/// the 33-byte fee-recipient pubkey + the skim bps (BE32), so a protocol-fee pool gets a DISTINCT slot from
/// the no-skim pool (an LP/swapper opting into a fee pool routes to its own reserves). The CONTRACT mirrors
/// this exact preimage — keccak(low ‖ high ‖ fee_be32 [‖ recipient33 ‖ pf_be32]) — so the guest-committed
/// poolId hits the on-chain slot. The skim itself is crystallized on LP events via `protocol_fee_shares`.
pub fn pool_id_with_protocol_fee(
    asset_a: &[u8; 32],
    asset_b: &[u8; 32],
    fee_bps: u32,
    protocol_fee_recipient: &[u8; 33],
    protocol_fee_bps: u32,
) -> [u8; 32] {
    let (low, high) = if bitcoin::be_bytes_lte(asset_a, asset_b) { (asset_a, asset_b) } else { (asset_b, asset_a) };
    let mut fee = [0u8; 32];
    fee[28..].copy_from_slice(&fee_bps.to_be_bytes());
    if protocol_fee_bps == 0 {
        return kn(&[low, high, &fee]); // canonical no-skim — byte-identical to pool_id()
    }
    let mut pf = [0u8; 32];
    pf[28..].copy_from_slice(&protocol_fee_bps.to_be_bytes());
    kn(&[low, high, &fee, protocol_fee_recipient, &pf])
}

/// Pool-specific LP-share asset id: keccak(pool_id ‖ "lp"). An LP's position is a shielded note of
/// this asset, so per-LP stakes stay hidden while the pool's totalShares is public.
pub fn lp_share_id(pool_id: &[u8; 32]) -> [u8; 32] { kn(&[pool_id, b"lp"]) }

/// Proportional LP shares for an add: min(floor(S·dA/R_A), floor(S·dB/R_B)). The limiting
/// leg sets the shares, so an off-ratio add earns only the smaller leg's worth (the excess accrues to
/// the pool, the constant-product `mint` rule) and the LP can never over-claim. This replaces the
/// old exact-ratio gate (`dA·R_B == dB·R_A`), which forced dA to be a multiple of R_A/gcd(R_A,R_B) and
/// so made incremental adds impossible once a traded pool's reserves went coprime. Faithful port of
/// tests/amm-clearing.mjs `lpAddShares` (AMM.md §"Indexer determinism rules: Rounding"). u128 product
/// so S·dA (each < 2^64) never overflows. Callers pass a live pool (reserve_a, reserve_b > 0).
pub fn lp_add_shares(shares_pre: u64, d_a: u64, d_b: u64, reserve_a: u64, reserve_b: u64) -> u128 {
    // A live pool has nonzero reserves (the caller adds to an initialized pool); guard the divisor anyway
    // so a malformed input is a 0-share no-op, never a divide-by-zero guest panic.
    if reserve_a == 0 || reserve_b == 0 { return 0; }
    let sp = shares_pre as u128;
    let a = sp * d_a as u128 / reserve_a as u128;
    let b = sp * d_b as u128 / reserve_b as u128;
    if a < b { a } else { b }
}

/// Proportional underlying for an LP remove: floor(reserve·shares/total), floored TOWARD the pool so
/// the rounding dust stays for the remaining LPs (never over-withdrawn). Mirrors tests/amm-clearing.mjs
/// `lpRemoveOutputs`. u128 product (reserve·shares each < 2^64).
pub fn lp_remove_output(reserve: u64, shares: u64, total: u64) -> u128 {
    if total == 0 { return 0; } // caller checks total_shares > 0; guard the divisor against a guest panic
    reserve as u128 * shares as u128 / total as u128
}

/// Floor integer square root — matches tests/amm-clearing.mjs `isqrt` (and Solady's sqrt). OP_LP_ADD's
/// FIRST mint (empty pool) sets initial totalShares = isqrt(dA·dB) — the constant-product first-mint
/// basis, so shares are the price-invariant geometric mean and the MINIMUM_LIQUIDITY lock is symmetric.
/// The input is dA·dB with dA,dB ≤ u64, so n < 2^128 and the result ≤ u64.
pub fn isqrt(n: u128) -> u128 { n.isqrt() }

/// Per-swap protocol (creator) fee cut — the Uniswap fee-SWITCH realized per swap (NOT the lazy mintFee):
/// `protocol_fee_bps`/10000 of the swap's LP fee (= `gross_in`·`fee_bps`/10000), i.e.
/// `gross_in · fee_bps · protocol_fee_bps / 10000²`, denominated in the INPUT asset. SHARED by BOTH lanes
/// (EVM OP_SWAP + the Bitcoin reflection swap_var fold) so the fee model is identical across chains. The
/// cut comes out of the LP's share (trader-neutral); the caller carves it into a treasury note + reduces
/// the pool's retained reserve by exactly this amount (conserved). u128 product: in a mixed-direction batch
/// `gross_in` is a sum of per-leg inputs (the post-reserve ≤ u64 check bounds only the NET move, not the
/// gross), but overflow of the u128 product would need `gross_in > 2^104` — ~2^40 max-value legs, which no
/// proof can hold — so with `fee_bps` ≤ 1000 and `protocol_fee_bps` < 10000 the product stays well under 2^128.
pub fn protocol_fee_cut(gross_in: u128, fee_bps: u32, protocol_fee_bps: u32) -> u64 {
    ((gross_in * fee_bps as u128 * protocol_fee_bps as u128) / 100_000_000u128) as u64
}

/// Constant-product exact-in hop output (`getAmountOut`) — the single-trade output for one hop of a
/// route: amount_out = floor(R_out · amount_in · (10000−fee) / (R_in · 10000 + amount_in · (10000−fee))).
/// The (10000−fee) factor charges the pool's fee tier; the result is always < R_out (the denominator
/// strictly exceeds the numerator's R_out coefficient), so a hop can never drain its output reserve.
/// u128 throughout: amount_in, R_in, R_out each < 2^64, so R_out · ain_g < 2^64·2^64·10^4 < 2^128.
/// OP_SWAP_ROUTE chains it hop-by-hop (out_i feeds in_{i+1}); fee_bps ≤ 1000 is enforced upstream.
pub fn get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64, fee_bps: u32) -> u128 {
    // BigUint intermediates: R_out · amount_in · γ reaches ~2^141 for near-u64 reserves, which a u128
    // product silently overflows (wrap in release / panic in debug) and diverges from the JS/Bitcoin
    // reference. The quotient amount_out < reserve_out ≤ u64::MAX still fits u128. Same reason
    // solve_clearing uses BigUint. (KAT: get_amount_out_matches_js_vectors.)
    use num_bigint::BigUint;
    let gamma = BigUint::from(10000u32 - fee_bps);              // 10000 − fee
    let ain_g = BigUint::from(amount_in) * &gamma;             // amount_in · γ
    let num = BigUint::from(reserve_out) * &ain_g;            // R_out · amount_in · γ
    let den = BigUint::from(reserve_in) * BigUint::from(10000u32) + &ain_g; // R_in · 10000 + amount_in · γ
    (num / den).to_string().parse::<u128>().unwrap()
}

/// Uniswap-V2 lazy-`mintFee` protocol-share crystallization (mirrors worker `ammComputeProtocolShares`):
///   `newShares = floor( S·bps·(√k_now − √k_pre) / ((10000−bps)·√k_now + bps·√k_pre) )`.
/// The protocol-fee skim is minted as LP shares from the SWAP-driven k-growth since the last crystallization
/// (`k_pre`). BigUint intermediates: the numerator reaches ~2^142 (`S·bps·Δroot`), which a u128 would overflow
/// + diverge from the Bitcoin/JS reference. Returns 0 on no growth / disabled fee (bps 0) / zero supply
/// (fail-safe). `fee_bps ≤ AMM_PROTOCOL_FEE_BPS_MAX` is enforced upstream (the pool's stored config).
/// This is the Bitcoin lane's realization of the protocol fee; the EVM lane charges the SAME φ =
/// bps/10000 of the LP fee but as a per-swap carve (guest `main.rs` OP_SWAP, `protocol_fee_cut`) rather
/// than √k mintFee — same aggregate split, different realization. See the OP_SWAP carve comment.
pub fn protocol_fee_shares(s_pre: u64, k_pre: u128, k_now: u128, fee_bps: u16) -> u64 {
    if fee_bps == 0 || s_pre == 0 || k_now <= k_pre {
        return 0;
    }
    let root_pre = isqrt(k_pre);
    let root_now = isqrt(k_now);
    if root_now <= root_pre {
        return 0;
    }
    use num_bigint::BigUint;
    let bps = BigUint::from(fee_bps);
    let num = BigUint::from(s_pre) * &bps * BigUint::from(root_now - root_pre);
    let den = BigUint::from(10000u32 - fee_bps as u32) * BigUint::from(root_now) + &bps * BigUint::from(root_pre);
    if den == BigUint::from(0u32) {
        return 0;
    }
    (num / den).to_string().parse::<u64>().unwrap_or(u64::MAX)
}

/// Deterministic uniform-price clearing solve — a faithful, byte-for-byte port of
/// tests/amm-clearing.mjs `solveClearing` (AMM.md §4, the normative indexer-determinism rule).
/// OP_SWAP uses it to ENFORCE the pool's fee tier: the guest re-derives P_clear from the public
/// reserves + gross flows + fee_bps and rejects any batch whose declared uniform price differs, so
/// the fee is actually charged (the constant-product non-decrease alone is only the ZERO-fee floor).
/// Returns (P_clear_num, P_clear_den). BigUint throughout (like the JS BigInt) so the intermediate
/// products — R_B·γ_num·Δa reaches ~2^142 — never overflow.
pub fn solve_clearing(x: u64, y: u64, r_a: u64, r_b: u64, fee_bps: u32) -> Option<(num_bigint::BigUint, num_bigint::BigUint)> {
    use num_bigint::BigUint;
    let xb = BigUint::from(x);
    let rab = BigUint::from(r_a);
    let rbb = BigUint::from(r_b);
    // Empty batch: spot price = R_A / R_B (den guarded to 1 when R_B == 0).
    if x == 0 && y == 0 {
        return Some((rab, if r_b == 0 { BigUint::from(1u32) } else { rbb }));
    }
    if r_a == 0 || r_b == 0 || fee_bps > 10000 { return None; }
    let g_num = BigUint::from(10000u32 - fee_bps); // fee_bps ≤ 1000 is enforced upstream
    let g_den = BigUint::from(10000u32);
    let lhs = &xb * &rbb;          // X·R_B
    let rhs = BigUint::from(y) * &rab; // Y·R_A
    if lhs > rhs {
        let (pn, pd) = solve_a_to_b(x, y, r_a, r_b, &g_num, &g_den);
        Some((pn, pd))
    } else if lhs < rhs {
        // Symmetric B→A: solve with (X,Y),(R_A,R_B) swapped, then reciprocate P_clear.
        let (pn, pd) = solve_a_to_b(y, x, r_b, r_a, &g_num, &g_den);
        Some((pd, pn))
    } else {
        // Exact-cancel batch → spot.
        Some((rab, rbb))
    }
}

// A→B-dominant solve: binary search on Δa_net ∈ [1, X] (≤ 64 iterations), returns (P_clear_num,
// P_clear_den) = (X, Y + Δb_net) for the converged (or largest-too-small) Δa_net. Mirrors
// solveAToB in tests/amm-clearing.mjs exactly.
fn solve_a_to_b(x: u64, y: u64, r_a: u64, r_b: u64, g_num: &num_bigint::BigUint, g_den: &num_bigint::BigUint)
    -> (num_bigint::BigUint, num_bigint::BigUint)
{
    use num_bigint::BigUint;
    let xb = BigUint::from(x);
    let yb = BigUint::from(y);
    let rab = BigUint::from(r_a);
    let rbb = BigUint::from(r_b);
    let one = BigUint::from(1u32);
    let mut lo = one.clone();
    let mut hi = xb.clone();
    let mut best = one.clone();
    let mut iter = 0u32;
    while iter < 64 && lo <= hi {
        let mid = &lo + (&hi - &lo) / 2u32;
        // Δb = floor(R_B·γ_num·mid / (R_A·γ_den + γ_num·mid))
        let delta_b = (&rbb * g_num * &mid) / (&rab * g_den + g_num * &mid);
        let denom = &yb + &delta_b;
        // Δa_implied = X − floor(Y·X / (Y + Δb)); denom==0 only when Y==Δb==0 (pool-empty edge).
        let delta_a_implied = if denom == BigUint::from(0u32) { xb.clone() } else { &xb - (&yb * &xb) / &denom };
        if delta_a_implied == mid {
            return (xb.clone(), &yb + &delta_b);
        }
        if delta_a_implied < mid {
            hi = &mid - 1u32;
        } else {
            best = mid.clone();
            lo = &mid + 1u32;
        }
        iter += 1;
    }
    // No exact fixed point: the largest 'best' that was too small (settler declares exactly this).
    let final_delta_b = (&rbb * g_num * &best) / (&rab * g_den + g_num * &best);
    (xb, &yb + &final_delta_b)
}

/// True iff (price_num, price_den) is EXACTLY the fee-clearing uniform price (B per A, un-reduced)
/// that solve_clearing derives for these gross flows + reserves + fee — the OP_SWAP fee-enforcement
/// check. The declared price is clearingPriceBperA(solve), i.e. price_num == P_clear_den and
/// price_den == P_clear_num. Keeping the BigUint inside cxfer-core so the zkVM guest just calls a bool.
pub fn clearing_price_matches(x: u64, y: u64, r_a: u64, r_b: u64, fee_bps: u32, price_num: u64, price_den: u64) -> bool {
    use num_bigint::BigUint;
    let Some((pc_num, pc_den)) = solve_clearing(x, y, r_a, r_b, fee_bps) else { return false; };
    pc_den == BigUint::from(price_num) && pc_num == BigUint::from(price_den)
}
/// Bind a spent pool note to its nullifier: given the outpoint's committed value (proven in
/// the UTXO set via the remove witness) and the note's commitment coords, return ν iff
/// (Cx,Cy) opens that value — so a spend can't claim a ν unbound from the real note. None
/// if the commitment doesn't match the outpoint's stored value.
pub fn bind_spent_note(committed_value: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32]) -> Option<[u8; 32]> {
    if commitment_hash(cx, cy) != *committed_value { return None; }
    Some(nullifier(cx, cy))
}

/// Confirm one pool tx for the reflection prover and return `(txid, spent-outpoint keys)`.
/// `verify_tx_in_block` ties the tx to a PoW block whose header the caller has checked is in
/// the verified header chain; `extract_inputs` gives the tx's vins → `outpoint_key` each. A
/// reflected spend's outpoint must be one of these (it's a real prior output the confirmed
/// tx actually spends), and a reflected output's outpoint must be `outpoint_key(txid, vout)`
/// (a real output of the confirmed tx). None if the tx isn't confirmed in the block or is
/// malformed.
pub fn confirm_pool_tx(
    header: &[u8],
    tx_data: &[u8],
    tx_index: u32,
    txids: &[[u8; 32]],
) -> Option<([u8; 32], Vec<[u8; 32]>)> {
    let txid = bitcoin::verify_tx_in_block(header, tx_data, tx_index, txids)?;
    let outpoints = bitcoin::extract_inputs(tx_data)?
        .iter()
        .map(|(t, v)| outpoint_key(t, *v))
        .collect();
    Some((txid, outpoints))
}
/// deposit commit = keccak(Cx ‖ Cy ‖ owner) — the digest the contract's `wrap` takes in place of the
/// raw coords + owner, so they never appear in public calldata. Distinct preimage from `nullifier`
/// (no "spent" tag) and `leaf` (no asset prefix), so publishing it yields neither.
pub fn deposit_commit(cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] { kn(&[cx, cy, owner]) }
/// deposit id = keccak(asset_id ‖ value_be32 ‖ commit), commit = deposit_commit(Cx, Cy, owner) —
/// binds the note's in-system value (the contract derives the same value = amount/unitScale at wrap,
/// so value·unitScale == escrowed amount: the wrap-side no-inflation gate) over the coord/owner
/// digest rather than the raw coords, which keeps them off-chain.
pub fn deposit_id(asset_id: &[u8; 32], value_be32: &[u8; 32], commit: &[u8; 32]) -> [u8; 32] {
    kn(&[asset_id, value_be32, commit])
}
/// claimId = keccak(abi.encodePacked(destChain:uint16, destCommitment, nullifier,
/// asset_id)) — matches ConfidentialPool.settle's on-chain re-derivation and the
/// dapp prover. Binds a cross-chain burn to exactly one mintable destination.
pub fn claim_id(dest_chain: u16, dest_commitment: &[u8; 32], nullifier: &[u8; 32], asset_id: &[u8; 32]) -> [u8; 32] {
    kn(&[&dest_chain.to_be_bytes(), dest_commitment, nullifier, asset_id])
}

/// Membership against the on-chain Keccak incremental Merkle root.
pub fn keccak_merkle_verify(leaf: &[u8; 32], index: u64, path: &[[u8; 32]], root: &[u8; 32]) -> bool {
    match merkle_root_from(leaf, index, path) {
        Some(h) => &h == root,
        None => false,
    }
}

/// Fold a leaf up its Merkle path to the root it implies — the compute-side of
/// `keccak_merkle_verify` (which compares the result to a claimed root). The witnessed
/// accumulator transitions use it to derive the NEW root after replacing/appending a leaf:
/// the same path that proved the old leaf re-folds the new leaf to the post-update root.
/// Returns None on a malformed (non-depth-32) path.
pub fn merkle_root_from(leaf: &[u8; 32], mut index: u64, path: &[[u8; 32]]) -> Option<[u8; 32]> {
    if path.len() != KECCAK_TREE_DEPTH { return None; }
    let mut h = *leaf;
    for sib in path {
        h = if index & 1 == 0 { k2(&h, sib) } else { k2(sib, &h) };
        index >>= 1;
    }
    Some(h)
}

/// Witnessed append transition for the append-only note tree: append `leaf` at the next
/// free slot and return the new root — with NO frontier state, only (prior_root, the empty
/// slot's path). The slot at `next_index` must be the zero leaf in `prior_root` (so an
/// append can't overwrite an existing note); the same path re-folds `leaf` to the new root.
/// The reflection prover folds Δ-deposits through this; `next_index` is the prior leaf count.
pub fn keccak_tree_append_transition(
    prior_root: &[u8; 32],
    next_index: u64,
    path: &[[u8; 32]],
    leaf: &[u8; 32],
) -> Option<[u8; 32]> {
    if !keccak_merkle_verify(&[0u8; 32], next_index, path, prior_root) { return None; }
    merkle_root_from(leaf, next_index, path)
}

/// Big-endian strict less-than over 32-byte values.
fn be_lt(a: &[u8; 32], b: &[u8; 32]) -> bool { bitcoin::be_bytes_lte(a, b) && a != b }

/// Indexed-Merkle-tree leaf: a "low nullifier" linked record keccak(value ‖ next).
/// The set is the sorted linked list of spent nullifiers; `next` is the successor
/// (0 ⇒ this is the maximum element).
pub fn imt_leaf(value: &[u8; 32], next: &[u8; 32]) -> [u8; 32] { kn(&[value, next]) }

/// Indexed-Merkle NON-membership: prove `nu` is NOT in the set committed by `root`
/// (a Keccak Merkle tree of `imt_leaf` records). Succinct — one low-leaf membership,
/// no full-set load — so proving cost is O(log n), not O(n) like a sorted-list hash.
/// Returns true iff the low leaf is in the tree and its (value, next) range straddles
/// `nu`: value < nu < next, or value < nu with next == 0 (nu beyond the maximum).
/// A member `nu` cannot be proven absent (no leaf's range strictly straddles it).
pub fn imt_non_membership(
    root: &[u8; 32],
    nu: &[u8; 32],
    low_value: &[u8; 32],
    low_next: &[u8; 32],
    low_index: u64,
    low_path: &[[u8; 32]],
) -> bool {
    let leaf = imt_leaf(low_value, low_next);
    if !keccak_merkle_verify(&leaf, low_index, low_path, root) { return false; }
    if !be_lt(low_value, nu) { return false; }
    let zero = [0u8; 32];
    if low_next == &zero { return true; } // low is the max element; nu is beyond it
    be_lt(nu, low_next)
}

/// Indexed-Merkle MEMBERSHIP: prove `nu` IS in the set committed by `root` — there is a
/// leaf `imt_leaf(nu, next)` in the tree at `index`. Since the IMT holds each spent
/// nullifier as a unique sorted link, a leaf whose value is `nu` means `nu` is spent.
/// bridge_mint uses this to prove a Bitcoin note was actually burned (its ν reflected
/// into the relay-attested Bitcoin spent set) — the relay-anchored replacement for the
/// self-supplied-PoW block check (spec B5).
pub fn imt_membership(
    root: &[u8; 32],
    nu: &[u8; 32],
    next: &[u8; 32],
    index: u64,
    path: &[[u8; 32]],
) -> bool {
    keccak_merkle_verify(&imt_leaf(nu, next), index, path, root)
}

/// Membership of `key` (→ `value`) in a UTXO IMT committed by `root` (the burn set's `utxo_leaf`
/// shape, which carries a stored value unlike the spent set's key-only `imt_leaf`). Used to prove a
/// commitment-collision duplicate is ALREADY present instead of re-inserting (which would panic).
pub fn utxo_membership(
    root: &[u8; 32],
    key: &[u8; 32],
    next: &[u8; 32],
    value: &[u8; 32],
    index: u64,
    path: &[[u8; 32]],
) -> bool {
    keccak_merkle_verify(&utxo_leaf(key, next, value), index, path, root)
}

/// Witnessed IMT insert transition: insert `nu` into the spent set committed by
/// `prior_root` and return the new root — with NO full-set state (the resume-from-digest
/// form the reflection prover folds Δ-spends through). Two Merkle updates, each verified
/// against the evolving root so a forged witness can't fabricate a transition:
///   1. the straddling low leaf (low_value < nu < low_next, or low_next == 0) is a member
///      of `prior_root`; its successor is rewired to `nu` → the intermediate root.
///   2. the target slot at `new_index` is empty (zero leaf) in the intermediate tree; it
///      is filled with {nu → old_next} → the new root.
/// `new_path` is the path in the INTERMEDIATE tree (after the low-leaf rewire) — the
/// indexer builds it against the post-rewire state. Returns None if any check fails.
#[allow(clippy::too_many_arguments)]
pub fn imt_insert_transition(
    prior_root: &[u8; 32],
    nu: &[u8; 32],
    low_value: &[u8; 32],
    low_next: &[u8; 32],
    low_index: u64,
    low_path: &[[u8; 32]],
    new_index: u64,
    new_path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    let zero = [0u8; 32];
    // nu must be insertable: non-zero and strictly straddled by the low leaf.
    if *nu == zero || !be_lt(low_value, nu) { return None; }
    if *low_next != zero && !be_lt(nu, low_next) { return None; }
    // (1) the low leaf is a member of prior_root; rewire its successor to nu.
    if !keccak_merkle_verify(&imt_leaf(low_value, low_next), low_index, low_path, prior_root) { return None; }
    let intermediate = merkle_root_from(&imt_leaf(low_value, nu), low_index, low_path)?;
    // (2) the target slot is empty in the intermediate tree; fill it with {nu → old_next}.
    if !keccak_merkle_verify(&zero, new_index, new_path, &intermediate) { return None; }
    merkle_root_from(&imt_leaf(nu, low_next), new_index, new_path)
}

/// Depth of the keccak incremental Merkle tree — the note tree, the spent-set IMT, and
/// ConfidentialPool's commitment tree all share it (TREE_LEVELS = 32).
pub const KECCAK_TREE_DEPTH: usize = 32;

/// Per-level zero hashes: zeros[0] = 0, zeros[i] = keccak(zeros[i-1] ‖ zeros[i-1]).
fn keccak_zeros() -> [[u8; 32]; KECCAK_TREE_DEPTH] {
    let mut z = [[0u8; 32]; KECCAK_TREE_DEPTH];
    for i in 1..KECCAK_TREE_DEPTH { z[i] = kn(&[&z[i - 1], &z[i - 1]]); }
    z
}

/// Root of the depth-32 keccak incremental Merkle tree holding `leaves` at positions
/// 0..n, empty subtrees zero-filled — byte-identical to ConfidentialPool._insertLeaf
/// and the JS pool.Tree. This is the BUILD side (the verify side is
/// keccak_merkle_verify); the reflection prover uses it to recompute the Bitcoin pool
/// root and the spent-set IMT root in-guest.
pub fn keccak_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let zeros = keccak_zeros();
    // Empty tree: fold the zero leaf up 32 levels → zeros[32].
    if leaves.is_empty() {
        let mut h = [0u8; 32];
        for _ in 0..KECCAK_TREE_DEPTH { h = kn(&[&h, &h]); }
        return h;
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    for i in 0..KECCAK_TREE_DEPTH {
        let mut next: Vec<[u8; 32]> = Vec::with_capacity((level.len() + 1) / 2);
        let mut k = 0;
        while k * 2 < level.len() {
            let l = level[2 * k];
            let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[i] };
            next.push(kn(&[&l, &r]));
            k += 1;
        }
        level = next; // non-empty for non-empty input every round
    }
    level[0]
}

/// The spent-set IMT root from its sorted low-nullifier linked list `(value, next)` —
/// each link becomes an imt_leaf, folded into the depth-32 tree. The reflection prover
/// commits this as `bitcoinSpentRoot`; non-membership (imt_non_membership) verifies
/// against it.
pub fn imt_root(links: &[([u8; 32], [u8; 32])]) -> [u8; 32] {
    let leaves: Vec<[u8; 32]> = links.iter().map(|(v, n)| imt_leaf(v, n)).collect();
    keccak_merkle_root(&leaves)
}

/// The NON-ZERO root of an EMPTY spent set: the single sentinel low-leaf imt_leaf(0,0)
/// ("0 is the max, nothing above"), which proves non-membership of every nu > 0. The
/// reflected spent root is seeded to this and only advances; the contract rejects a zero
/// spent root because a zero would let the guest skip its non-membership check.
pub fn imt_empty_root() -> [u8; 32] {
    let zero = [0u8; 32];
    keccak_merkle_root(&[imt_leaf(&zero, &zero)])
}

/// Stateful spent-set accumulator (the indexer / reflection-prover side): the sorted
/// low-nullifier linked list seeded with the {0→0} sentinel, with incremental insert.
/// `insert` splits the predecessor low-leaf (its `next` → nu) and appends {nu → old
/// next} at a new index — leaf index = insertion order, so the root is order-dependent;
/// fold spends in the SAME (chronological) order as the JS accumulator. Mirrors
/// dapp/confidential-pool.js makeImtAccumulator.
pub struct ImtAccumulator {
    links: Vec<([u8; 32], [u8; 32])>,
}

impl Default for ImtAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl ImtAccumulator {
    /// A fresh accumulator: the empty set, represented by the {0→0} sentinel.
    pub fn new() -> Self {
        Self { links: vec![([0u8; 32], [0u8; 32])] }
    }

    fn low_index(&self, nu: &[u8; 32]) -> Option<usize> {
        let zero = [0u8; 32];
        self.links.iter().position(|(v, n)| be_lt(v, nu) && (*n == zero || be_lt(nu, n)))
    }

    /// Insert a spent nullifier. Panics on 0 (the sentinel anchor) or an nu already in
    /// the set / out of range (no straddling low leaf).
    pub fn insert(&mut self, nu: &[u8; 32]) {
        assert!(*nu != [0u8; 32], "cannot insert 0 (the sentinel anchor)");
        let i = self.low_index(nu).expect("no low link (nu already spent or out of range)");
        let old = self.links[i].1;
        self.links[i].1 = *nu; // predecessor now points to nu
        self.links.push((*nu, old)); // nu takes the displaced successor
    }

    /// The spent-set root reflecting all inserts so far.
    pub fn root(&self) -> [u8; 32] {
        imt_root(&self.links)
    }

    pub fn links(&self) -> &[([u8; 32], [u8; 32])] {
        &self.links
    }

    /// Low-leaf (index, value, next) for proving `nu` absent against `root()`; None if
    /// `nu` is a member. The Merkle path is generated by the caller's tree builder.
    pub fn non_membership_low(&self, nu: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32])> {
        self.low_index(nu).map(|i| (i, self.links[i].0, self.links[i].1))
    }
}

/// Incremental note-tree accumulator: append-only Keccak Merkle holding only the
/// per-level `filled` subtrees + the running root (O(depth) state, not O(leaves)) —
/// byte-identical to ConfidentialPool._insertLeaf. The reflection prover / Bitcoin
/// indexer use it to advance the note-tree root as deposits land, without holding every
/// leaf. (ImtAccumulator is the spent-set counterpart.)
pub struct KeccakTreeAccumulator {
    zeros: [[u8; 32]; KECCAK_TREE_DEPTH],
    filled: [[u8; 32]; KECCAK_TREE_DEPTH],
    next_index: u64,
    root: [u8; 32],
}

impl Default for KeccakTreeAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl KeccakTreeAccumulator {
    /// An empty tree: root = the all-zero depth-32 root (zeros[32]), as the contract's
    /// initial `currentRoot`.
    pub fn new() -> Self {
        let zeros = keccak_zeros();
        Self { zeros, filled: [[0u8; 32]; KECCAK_TREE_DEPTH], next_index: 0, root: keccak_merkle_root(&[]) }
    }

    /// Append one leaf, updating the filled subtrees + root exactly as _insertLeaf does.
    pub fn append(&mut self, leaf: &[u8; 32]) {
        let mut idx = self.next_index;
        let mut h = *leaf;
        for i in 0..KECCAK_TREE_DEPTH {
            if idx & 1 == 0 {
                self.filled[i] = h;
                h = kn(&[&h, &self.zeros[i]]);
            } else {
                h = kn(&[&self.filled[i], &h]);
            }
            idx >>= 1;
        }
        self.root = h;
        self.next_index += 1;
    }

    pub fn root(&self) -> [u8; 32] {
        self.root
    }
    pub fn next_index(&self) -> u64 {
        self.next_index
    }

    /// The Merkle path for the NEXT append slot, derived from the frontier: at level i the
    /// sibling is the filled left subtree (bit set) or the empty-subtree root (bit clear).
    /// The indexer hands this to `keccak_tree_append_transition`; folding the zero leaf with
    /// it reproduces the current root, and the new leaf with it the post-append root.
    pub fn append_path(&self) -> Vec<[u8; 32]> {
        (0..KECCAK_TREE_DEPTH)
            .map(|i| if (self.next_index >> i) & 1 == 0 { self.zeros[i] } else { self.filled[i] })
            .collect()
    }
}

/// Outpoint accumulator leaf: keccak(key ‖ next ‖ value).
pub fn utxo_leaf(key: &[u8; 32], next: &[u8; 32], value: &[u8; 32]) -> [u8; 32] {
    kn(&[key, next, value])
}

/// Witnessed UTXO/bridge-burn insert transition: add `key → value` to the sorted set
/// committed by `prior_root` and return the new root — no full-set state. The IMT pattern
/// with 3-field leaves: the straddling low node (low_key < key < low_next, or low_next == 0)
/// is rewired to `key`, then {key → old_next, value} fills the empty slot at `new_index`
/// (its path against the intermediate, post-rewire tree). Returns None if any check fails.
#[allow(clippy::too_many_arguments)]
pub fn utxo_insert_transition(
    prior_root: &[u8; 32],
    key: &[u8; 32],
    value: &[u8; 32],
    low_key: &[u8; 32],
    low_next: &[u8; 32],
    low_value: &[u8; 32],
    low_index: u64,
    low_path: &[[u8; 32]],
    new_index: u64,
    new_path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    let zero = [0u8; 32];
    if *key == zero || !be_lt(low_key, key) { return None; }
    if *low_next != zero && !be_lt(key, low_next) { return None; }
    // (1) the low node is a member of prior_root; rewire its successor to key (value kept).
    if !keccak_merkle_verify(&utxo_leaf(low_key, low_next, low_value), low_index, low_path, prior_root) { return None; }
    let intermediate = merkle_root_from(&utxo_leaf(low_key, key, low_value), low_index, low_path)?;
    // (2) fill the empty slot with the new node {key → old_next, value}.
    if !keccak_merkle_verify(&zero, new_index, new_path, &intermediate) { return None; }
    merkle_root_from(&utxo_leaf(key, low_next, value), new_index, new_path)
}

/// Witnessed UTXO remove (spend) transition: tombstone the live outpoint `key` and return
/// the new root — no full-set state. Two updates: the predecessor (pred_next == key) is
/// rewired to `key`'s successor, then `key`'s node is tombstoned (leaf → 0, matching the
/// stateful accumulator's `leaf_at` for a dead node). `node_path` is against the
/// intermediate (post-rewire) tree. Returns None if the witnesses don't link up.
#[allow(clippy::too_many_arguments)]
pub fn utxo_remove_transition(
    prior_root: &[u8; 32],
    key: &[u8; 32],
    node_next: &[u8; 32],
    node_value: &[u8; 32],
    node_index: u64,
    node_path: &[[u8; 32]],
    pred_key: &[u8; 32],
    pred_value: &[u8; 32],
    pred_index: u64,
    pred_path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    // The predecessor points at `key` and is a member of prior_root; rewire it to skip `key`.
    if !keccak_merkle_verify(&utxo_leaf(pred_key, key, pred_value), pred_index, pred_path, prior_root) { return None; }
    let intermediate = merkle_root_from(&utxo_leaf(pred_key, node_next, pred_value), pred_index, pred_path)?;
    // `key`'s node is a member of the intermediate tree; tombstone it (leaf → 0).
    if !keccak_merkle_verify(&utxo_leaf(key, node_next, node_value), node_index, node_path, &intermediate) { return None; }
    merkle_root_from(&[0u8; 32], node_index, node_path)
}

/// Outpoint→note accumulator — the Bitcoin UTXO set the reflection prover resolves
/// inputs against (SPEC-BITCOIN-REFLECTION-AMENDMENT §7.2). A sorted linked list keyed by
/// the outpoint `key = keccak(txid ‖ vout)`, each live node carrying the note's nullifier
/// `ν = keccak(Cx ‖ Cy ‖ "spent")` as its value, seeded with the {0→0} sentinel. Supports
/// add (a new output), `get` (resolve an input → its ν), and remove (a spend). The
/// committed root reflects every LIVE outpoint — a spent outpoint is unlinked from the
/// chain AND tombstoned (its leaf hashes to 0) — so a resumed prover proves an input is a
/// real, unspent output against it.
pub struct UtxoAccumulator {
    // (key, next, value, alive): a tombstoned node (alive = false) hashes to 0 and is
    // skipped by every lookup — its outpoint has been spent.
    nodes: Vec<([u8; 32], [u8; 32], [u8; 32], bool)>,
}

impl Default for UtxoAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl UtxoAccumulator {
    /// A fresh empty UTXO set: the {0→0} sentinel (key 0 is the max).
    pub fn new() -> Self {
        Self { nodes: vec![([0u8; 32], [0u8; 32], [0u8; 32], true)] }
    }

    fn leaf_at(&self, i: usize) -> [u8; 32] {
        let (k, n, v, alive) = &self.nodes[i];
        if *alive { utxo_leaf(k, n, v) } else { [0u8; 32] }
    }

    /// The live predecessor for `key` (node.key < key < node.next, or node.next == 0).
    fn low_index(&self, key: &[u8; 32]) -> Option<usize> {
        let zero = [0u8; 32];
        self.nodes.iter().position(|(k, n, _, a)| *a && be_lt(k, key) && (*n == zero || be_lt(key, n)))
    }
    /// The live node whose key == `key` (membership).
    fn find(&self, key: &[u8; 32]) -> Option<usize> {
        self.nodes.iter().position(|(k, _, _, a)| *a && k == key)
    }
    /// The live node whose next == `key` (the predecessor of a present key).
    fn pred_of(&self, key: &[u8; 32]) -> Option<usize> {
        self.nodes.iter().position(|(_, n, _, a)| *a && n == key)
    }

    /// Add a new output `key → value`. Panics on key 0 or an already-present key.
    pub fn insert(&mut self, key: &[u8; 32], value: &[u8; 32]) {
        assert!(*key != [0u8; 32], "outpoint key 0 reserved for the sentinel");
        let i = self.low_index(key).expect("no low link (outpoint present or out of range)");
        let old_next = self.nodes[i].1;
        self.nodes[i].1 = *key; // predecessor → key
        self.nodes.push((*key, old_next, *value, true));
    }

    /// Resolve an outpoint to its note value (ν), if it is a live UTXO.
    pub fn get(&self, key: &[u8; 32]) -> Option<[u8; 32]> {
        self.find(key).map(|i| self.nodes[i].2)
    }

    /// Spend an outpoint: unlink it (predecessor skips it) and tombstone it. Panics if the
    /// outpoint is not a live UTXO (a double-spend / unknown input).
    pub fn remove(&mut self, key: &[u8; 32]) {
        let i = self.find(key).expect("outpoint not in the UTXO set");
        let p = self.pred_of(key).expect("predecessor missing");
        self.nodes[p].1 = self.nodes[i].1; // predecessor → removed.next
        self.nodes[i].3 = false; // tombstone (leaf → 0)
    }

    /// The committed UTXO-set root (live outpoints; tombstones hash to 0).
    pub fn root(&self) -> [u8; 32] {
        let leaves: Vec<[u8; 32]> = (0..self.nodes.len()).map(|i| self.leaf_at(i)).collect();
        keccak_merkle_root(&leaves)
    }

    /// Membership witness `(leaf_index, next, value)` for proving `key` is a live UTXO
    /// against `root()`; None if absent. The Merkle path is built by the caller.
    pub fn membership(&self, key: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32])> {
        self.find(key).map(|i| (i, self.nodes[i].1, self.nodes[i].2))
    }

    /// The committed leaf vector (live → utxo_leaf, tombstoned → 0) — what the indexer folds
    /// to build Merkle paths for the witnessed insert/remove transitions.
    pub fn leaves(&self) -> Vec<[u8; 32]> {
        (0..self.nodes.len()).map(|i| self.leaf_at(i)).collect()
    }

    /// Low-node witness `(index, key, next, value)` straddling `key` (key_low < key <
    /// key_next, or next == 0) — the insert witness. None if `key` is present/out of range.
    pub fn low(&self, key: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32], [u8; 32])> {
        self.low_index(key).map(|i| (i, self.nodes[i].0, self.nodes[i].1, self.nodes[i].2))
    }

    /// Predecessor witness `(index, key, value)` — the live node whose `next == key` — for
    /// the remove transition (it is rewired to skip the removed node). None if absent.
    pub fn predecessor(&self, key: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32])> {
        self.pred_of(key).map(|i| (i, self.nodes[i].0, self.nodes[i].2))
    }

    /// The next free leaf slot (insertion index for a new node).
    pub fn len(&self) -> usize { self.nodes.len() }
    pub fn is_empty(&self) -> bool { self.nodes.is_empty() }
}

/// Live UTXO set for the FULL-SCAN reflection model (closes the F4 spent-set completeness gap).
/// Where `UtxoAccumulator` is insertion-order with tombstones — its committed root is O(history)
/// to reconstruct, which is fine for the witnessed O(Δ) fold that never rebuilds — this commits
/// ONLY the live outpoints, as a Keccak Merkle tree over (key, value) leaves sorted by key. So
/// the prover rebuilds + root-checks the HANDED set in O(live) once per batch, then resolves
/// every confirmed tx's vins against it in-memory. Because no vin can be skipped, a relayer can
/// no longer OMIT a Bitcoin spend of a pool note (the gap F4 named) — a plain, non-TACIT spend of
/// a pool UTXO is caught the same as an enveloped one. Its root lives only in the reflection
/// `state_digest` (never read on-chain — the cross-lane gate reads spentRoot/poolRoot), so this
/// live-only shape is free to differ from the witnessed UtxoAccumulator the bridge-burn set uses.
#[derive(Clone, Default)]
pub struct LiveUtxoSet {
    // (outpoint key = keccak(txid‖vout), value = commitment_hash = keccak(Cx‖Cy), asset_id), kept
    // sorted ascending by key (big-endian == array order) so root rebuild and lookups are one pass
    // / log n. The asset is carried per-entry (set from the CXFER envelope when the output lands)
    // and committed into the root so a spend can re-impose asset preservation: the reflection's
    // CXFER fold requires every spent note's asset == the envelope's declared asset, the same
    // invariant the EVM lane gets for free from `leaf(asset,…)` membership. Without it a confirmed
    // (Bitcoin-side) CXFER could spend a cheap-asset note and mint a dear-asset note of equal
    // commitment-value (cross-asset inflation), because conservation is value-only.
    entries: Vec<([u8; 32], [u8; 32], [u8; 32])>,
}

impl LiveUtxoSet {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    /// Adopt a handed live set: keys must be strictly ascending and non-zero. The caller then
    /// root-checks `root()` against the resumed utxo root — that single O(live) hash is the
    /// batch's whole trust step (verify the set once, then scan vins against it for free).
    pub fn from_sorted(entries: Vec<([u8; 32], [u8; 32], [u8; 32])>) -> Option<Self> {
        for i in 0..entries.len() {
            if entries[i].0 == [0u8; 32] {
                return None;
            }
            if i > 0 && !be_lt(&entries[i - 1].0, &entries[i].0) {
                return None;
            }
        }
        Some(Self { entries })
    }

    /// Resolve an outpoint key to its stored `(commitment_hash, asset_id)` iff it is a live pool
    /// UTXO. The asset is what the reflection's CXFER fold checks against the envelope (preservation).
    pub fn get(&self, key: &[u8; 32]) -> Option<([u8; 32], [u8; 32])> {
        self.entries.binary_search_by(|(k, _, _)| k.cmp(key)).ok().map(|i| (self.entries[i].1, self.entries[i].2))
    }

    /// Add a new output's outpoint → `(commitment hash, asset_id)`. Panics on a duplicate key
    /// (outpoints are unique — a duplicate is a malformed batch, never a valid Bitcoin state).
    pub fn insert(&mut self, key: &[u8; 32], value: &[u8; 32], asset: &[u8; 32]) {
        // panic, NOT Result, is the intended fail-closed: a duplicate outpoint is a prover bug, and a
        // panic mid-fold discards the ENTIRE batch proof — so no partially-mutated ScanReflection state
        // ever reaches a committed root. (A `Result` here would weaken that: a skip-not-panic caller could
        // ignore the Err and keep the note-root mutation that ran before this insert.) The Err-returning
        // fold paths instead validate before mutating, so their skip-not-panic is partial-state-free too.
        match self.entries.binary_search_by(|(k, _, _)| k.cmp(key)) {
            Ok(_) => panic!("duplicate outpoint in live set"),
            Err(i) => self.entries.insert(i, (*key, *value, *asset)),
        }
    }

    /// Spend a live outpoint, returning its stored `(commitment hash, asset_id)`. Panics if absent
    /// (the caller resolves it via `get` first — a remove of an unknown outpoint is a prover bug).
    pub fn remove(&mut self, key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        let i = self.entries.binary_search_by(|(k, _, _)| k.cmp(key)).expect("outpoint not live");
        let (_, v, a) = self.entries.remove(i);
        (v, a)
    }

    /// The committed live-set root: Keccak Merkle over the (key‖asset‖value) leaves in key order.
    /// The asset is committed so the digest chain pins each note's asset (a wrong handoff fails the
    /// digest), which is what makes the CXFER fold's asset-preservation check trustworthy on resume.
    pub fn root(&self) -> [u8; 32] {
        let leaves: Vec<[u8; 32]> = self.entries.iter().map(|(k, v, a)| kn(&[k, a, v])).collect();
        keccak_merkle_root(&leaves)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// One detected pool-UTXO spend from the full scan: the outpoint key + the note's derived ν, plus
/// the raw prev-outpoint `(txid, vout)` and the spent note's commitment coords `(cx, cy)`. The
/// raw outpoint + the commitment point are what the CXFER conservation gate needs (the BIP-340
/// kernel signs over the input outpoints, and `Σ C_in` over the input commitments — see
/// `verify_cxfer_conservation`), so the scan surfaces them rather than discarding them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetectedSpend {
    pub outpoint: [u8; 32],
    pub nu: [u8; 32],
    pub prev_txid: [u8; 32],
    pub prev_vout: u32,
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    // The asset_id the spent note was created under (carried by the live UTXO set, set from the
    // CXFER envelope when the note landed). The CXFER fold asserts this equals the spending
    // envelope's declared asset, so a confirmed tx can't relabel a cheap-asset note as a dear one.
    pub asset: [u8; 32],
}

/// Full-scan vin detection — the F4 completeness primitive. EVERY input of `tx_data` is resolved
/// against the live UTXO set; each one that hits a live pool UTXO is a spend that MUST be
/// reflected (the relayer cannot silently drop it, because the scan visits all vins). For each
/// hit, `next_opening` yields the spent note's (Cx, Cy) in vin order; ν is derived and BOUND to
/// the outpoint's stored commitment hash via `bind_spent_note` (so a forged opening is rejected),
/// the outpoint is removed from `live`, and a `DetectedSpend` (outpoint key + ν + raw outpoint +
/// commitment coords) is recorded. A tx touching no pool UTXO returns an empty vec. Returns None
/// on a malformed tx or an opening that doesn't bind — both are hard rejects (a confirmed tx the
/// prover can't honestly fold). Output notes (new outpoints a CXFER envelope declares) are added
/// by the caller, which holds the envelope parse + the conservation check.
pub fn scan_tx_spends(
    tx_data: &[u8],
    live: &mut LiveUtxoSet,
    mut next_opening: impl FnMut() -> ([u8; 32], [u8; 32]),
) -> Option<Vec<DetectedSpend>> {
    let inputs = bitcoin::extract_inputs(tx_data)?;
    let mut spends = Vec::new();
    for (txid, vout) in &inputs {
        let key = outpoint_key(txid, *vout);
        if let Some((stored, asset)) = live.get(&key) {
            let (cx, cy) = next_opening();
            let nu = bind_spent_note(&stored, &cx, &cy)?;
            live.remove(&key);
            spends.push(DetectedSpend { outpoint: key, nu, prev_txid: *txid, prev_vout: *vout, cx, cy, asset });
        }
    }
    Some(spends)
}

/// Verify a confirmed CXFER tx CONSERVES value before its outputs are folded into the reflected
/// Bitcoin pool: the BIP-340 kernel (`cxfer_kernel_verify`: Σ C_in = Σ C_out, `burned = 0` for a
/// pure transfer) AND the BP+ range proof bounding every output to `[0, 2^64)`. Bitcoin consensus
/// never checks the Tacit kernel (the envelope is witness bytes), so without this a confirmed tx
/// declaring an inflated output commitment would inject UNBACKED value into `bitcoinPoolRoot` —
/// spendable cross-lane on Ethereum (value from nothing). `input_outpoints` / `input_commitments`
/// come from the live-set scan (`scan_tx_spends`, which binds each input point to the stored
/// commitment); `kernel_sig` / `output_commitments_compressed` / `range_proof` from the envelope
/// (`bitcoin::parse_cxfer_envelope_full`). A zero-pool-input tx therefore can only mint
/// zero-value outputs (Σ C_in = 0 ⇒ the kernel forces Σ value_out = 0).
pub fn verify_cxfer_conservation(
    asset: &[u8; 32],
    input_outpoints: &[([u8; 32], u32)],
    input_commitments: &[Point],
    output_commitments_compressed: &[[u8; 33]],
    range_proof: &[u8],
    kernel_sig: &[u8; 64],
) -> bool {
    verify_cxfer_conservation_burned(
        asset, input_outpoints, input_commitments, output_commitments_compressed, 0, range_proof, kernel_sig,
    )
}

/// CBURN-aware conservation: identical to `verify_cxfer_conservation` but for a step that DESTROYS
/// `burned_amount` of supply (a Bitcoin `CBURN`). The kernel proves `Σ C_in = burned·H + Σ C_out`, so the
/// change outputs carry the inputs' value MINUS the public burn, range-bounded. A pure transfer is
/// `burned_amount == 0` (the wrapper above). Used by the burn-deposit provenance walk: a note descending
/// from a CBURN's change output is still provably real supply — the inputs were real, the burn is public
/// (bound into the kernel message so it can't be understated), and the change conserves. The burned value
/// has no output commitment, so it cannot be linked further (it is destroyed).
pub fn verify_cxfer_conservation_burned(
    asset: &[u8; 32],
    input_outpoints: &[([u8; 32], u32)],
    input_commitments: &[Point],
    output_commitments_compressed: &[[u8; 33]],
    burned_amount: u64,
    range_proof: &[u8],
    kernel_sig: &[u8; 64],
) -> bool {
    let mut out_pts: Vec<Point> = Vec::with_capacity(output_commitments_compressed.len());
    for c in output_commitments_compressed {
        match decompress(c) {
            Some(p) => out_pts.push(p),
            None => return false,
        }
    }
    cxfer_kernel_verify(asset, input_outpoints, input_commitments, output_commitments_compressed, burned_amount, kernel_sig)
        && verify_range(&out_pts, range_proof)
}

/// The reflection prover's state: the Bitcoin confidential-pool note tree, spent-set, and
/// UTXO set, advanced as confirmed effects land, plus the confirmed height. `commit`
/// yields exactly the `(bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight)` the relay
/// proof carries (ConfidentialPool.BitcoinRelayPublicValues); the UTXO root is internal
/// state (`state_digest` binds it for resumption). The Bitcoin-confirmation of each
/// effect (header chain + tx inclusion, via cxfer-core::bitcoin) is the guest's job
/// before it folds them in; this is the fold + the committed roots.
pub struct ReflectionState {
    pub notes: KeccakTreeAccumulator,
    pub spent: ImtAccumulator,
    pub utxo: UtxoAccumulator,
    /// Bridge-OUT set: key = ν, value = destCommitment, populated ONLY for cross-chain
    /// burns (OP_ENV_CONF_BURN). bridge_mint proves membership HERE (not in `spent`), so a
    /// note merely spent on Bitcoin in an ordinary transfer cannot be minted on Ethereum —
    /// only a note explicitly burned for the bridge can, and bound to its declared
    /// destCommitment. Closes the spent-vs-burned inflation conflation.
    pub bridge_burns: UtxoAccumulator,
    pub height: u64,
}

impl Default for ReflectionState {
    fn default() -> Self {
        Self::genesis()
    }
}

impl ReflectionState {
    /// Genesis: an empty note tree + the non-zero empty-IMT spent set + an empty UTXO set,
    /// height 0.
    pub fn genesis() -> Self {
        Self {
            notes: KeccakTreeAccumulator::new(),
            spent: ImtAccumulator::new(),
            utxo: UtxoAccumulator::new(),
            bridge_burns: UtxoAccumulator::new(),
            height: 0,
        }
    }

    /// Fold pre-resolved confidential-pool effects (deposits already as note leaves,
    /// spends already as nullifiers) and advance to `height`. The simple, UTXO-agnostic
    /// path — the caller resolved inputs to ν itself. `height` must strictly increase.
    pub fn apply_block(&mut self, deposits: &[[u8; 32]], spends: &[[u8; 32]], height: u64) {
        assert!(height >= self.height, "reflection height must not decrease");
        for leaf in deposits {
            self.notes.append(leaf);
        }
        for nu in spends {
            self.spent.insert(nu);
        }
        self.height = height;
    }

    /// Fold one confirmed Bitcoin confidential transfer in the UTXO model (§3). The guest
    /// has already verified conservation/range/confirmation and, for each input, witnessed
    /// its commitment `C_in` (checking `keccak(C_in) == utxo.get(outpoint)`) to derive
    /// `ν = keccak(Cx ‖ Cy ‖ "spent")`. This performs the validated state transition:
    /// - `inputs` = `(outpoint, ν)`: assert the outpoint is a live UTXO, mark ν spent,
    ///   remove the outpoint;
    /// - `outputs` = `(outpoint, note_leaf, commitment_hash)`: append the note leaf and add
    ///   the outpoint → `keccak(C_out)` to the UTXO set.
    ///
    /// Inputs are resolved BEFORE outputs are added, so a transfer cannot spend an
    /// outpoint it creates in the same tx. `height` must strictly increase.
    pub fn apply_transfer(
        &mut self,
        inputs: &[([u8; 32], [u8; 32])],
        outputs: &[([u8; 32], [u8; 32], [u8; 32])],
        height: u64,
    ) {
        assert!(height >= self.height, "reflection height must not decrease");
        for (outpoint, nu) in inputs {
            assert!(self.utxo.get(outpoint).is_some(), "input outpoint not a live UTXO");
            self.spent.insert(nu);
            self.utxo.remove(outpoint);
        }
        for (outpoint, note_leaf, commitment_hash) in outputs {
            self.notes.append(note_leaf);
            self.utxo.insert(outpoint, commitment_hash);
        }
        self.height = height;
    }

    /// Fold one confirmed cross-chain BURN (OP_ENV_CONF_BURN): the input note is consumed
    /// (spent + UTXO removed, like any spend) AND recorded in the bridge-burn set as
    /// `ν → destCommitment`. Only burns reach `bridge_burns`, so a `bridge_mint` proving
    /// membership there cannot be satisfied by an ordinary transfer's ν, and is bound to
    /// the destination the burn declared. `height` must strictly increase.
    pub fn apply_bridge_out(
        &mut self,
        outpoint: &[u8; 32],
        nu: &[u8; 32],
        dest_commitment: &[u8; 32],
        height: u64,
    ) {
        assert!(height >= self.height, "reflection height must not decrease");
        assert!(self.utxo.get(outpoint).is_some(), "bridge-out outpoint not a live UTXO");
        self.spent.insert(nu);
        self.utxo.remove(outpoint);
        self.bridge_burns.insert(nu, dest_commitment);
        self.height = height;
    }

    /// The bridge-burn set root — the relay attests it as `bitcoinBurnRoot`, and the
    /// guest's `bridge_mint` proves membership of `(ν → destCommitment)` against it.
    pub fn bridge_burn_root(&self) -> [u8; 32] {
        self.bridge_burns.root()
    }

    /// The committed reflection roots: (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight).
    /// The spent root is always non-zero (the empty-IMT sentinel), so the contract
    /// accepts it and the cross-lane gate never goes vacuous.
    pub fn commit(&self) -> ([u8; 32], [u8; 32], u64) {
        (self.notes.root(), self.spent.root(), self.height)
    }

    /// The internal UTXO-set root (not in BitcoinRelayPublicValues; bound into
    /// `state_digest` for resumption).
    pub fn utxo_root(&self) -> [u8; 32] {
        self.utxo.root()
    }

    /// Full-state digest keccak(poolRoot ‖ spentRoot ‖ utxoRoot ‖ height) — the anchor a
    /// resumed proof continues from, so the next cycle's UTXO set (and roots) provably
    /// extend this one rather than starting fresh.
    pub fn state_digest(&self) -> [u8; 32] {
        let (pool, spent, _) = self.commit();
        let mut h = [0u8; 32];
        h[24..].copy_from_slice(&self.height.to_be_bytes());
        kn(&[&pool, &spent, &self.utxo.root(), &self.bridge_burns.root(), &h])
    }
}

/// One spent input's witnesses: nullify ν in the spent set (IMT insert) and remove the
/// outpoint from the UTXO set (tombstone). The indexer builds these from the canonical
/// accumulators; the reflection prover folds them with no full-set state.
#[derive(Clone)]
pub struct SpendWitness {
    // The spent note's commitment coords — ν is DERIVED (nullifier(cx,cy)) and bound to the
    // outpoint's committed value (keccak(cx,cy) == u_node_value), never witnessed freely.
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    pub outpoint: [u8; 32],
    // spent-set IMT insert
    pub s_low_value: [u8; 32],
    pub s_low_next: [u8; 32],
    pub s_low_index: u64,
    pub s_low_path: Vec<[u8; 32]>,
    pub s_new_path: Vec<[u8; 32]>,
    // UTXO remove
    pub u_node_next: [u8; 32],
    pub u_node_value: [u8; 32],
    pub u_node_index: u64,
    pub u_node_path: Vec<[u8; 32]>,
    pub u_pred_key: [u8; 32],
    pub u_pred_value: [u8; 32],
    pub u_pred_index: u64,
    pub u_pred_path: Vec<[u8; 32]>,
}

/// One output note's witnesses: append the note leaf (note tree) and add the outpoint →
/// commitment to the UTXO set (insert).
#[derive(Clone)]
pub struct OutputWitness {
    pub note_leaf: [u8; 32],
    pub note_path: Vec<[u8; 32]>,
    pub outpoint: [u8; 32],
    pub commitment_hash: [u8; 32],
    pub u_low_key: [u8; 32],
    pub u_low_next: [u8; 32],
    pub u_low_value: [u8; 32],
    pub u_low_index: u64,
    pub u_low_path: Vec<[u8; 32]>,
    pub u_new_path: Vec<[u8; 32]>,
}

/// A cross-chain burn's witnesses: a spend PLUS an insert of ν → destCommitment into the
/// bridge-burn set (so bridge_mint can only mint a note explicitly burned for the bridge).
#[derive(Clone)]
pub struct BurnWitness {
    pub spend: SpendWitness,
    pub dest_commitment: [u8; 32],
    pub b_low_key: [u8; 32],
    pub b_low_next: [u8; 32],
    pub b_low_value: [u8; 32],
    pub b_low_index: u64,
    pub b_low_path: Vec<[u8; 32]>,
    pub b_new_path: Vec<[u8; 32]>,
}

/// Headless reflection state: only the four roots + their leaf counts + height — the
/// resumable anchor the reflection prover reads from its prior `digest()` and advances by
/// folding Δ-effects through the witnessed accumulator transitions (Phase 1). No full
/// accumulator state, so proving cost is O(Δ) per cycle, not O(n) replay. Counts pin each
/// insert to the next free slot (a witness can't open a gap). `commit()` yields the
/// BitcoinRelayPublicValues roots; `digest()` is the cross-cycle resumption anchor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WitnessedReflection {
    pub pool_root: [u8; 32],
    pub note_count: u64,
    pub spent_root: [u8; 32],
    pub spent_count: u64,
    pub utxo_root: [u8; 32],
    pub utxo_count: u64,
    pub burn_root: [u8; 32],
    pub burn_count: u64,
    pub height: u64,
}

impl WitnessedReflection {
    /// Genesis: empty note tree + sentinel-seeded IMT/UTXO sets (each one leaf at index 0,
    /// so the first real insert lands at index 1). Byte-identical to ReflectionState::genesis.
    pub fn genesis() -> Self {
        let utxo_empty = UtxoAccumulator::new().root();
        Self {
            pool_root: keccak_merkle_root(&[]),
            note_count: 0,
            spent_root: imt_empty_root(),
            spent_count: 1,
            utxo_root: utxo_empty,
            utxo_count: 1,
            burn_root: utxo_empty,
            burn_count: 1,
            height: 0,
        }
    }

    /// (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight) — the relay public values; the
    /// burn root is committed separately as bitcoinBurnRoot.
    pub fn commit(&self) -> ([u8; 32], [u8; 32], u64) {
        (self.pool_root, self.spent_root, self.height)
    }

    /// Resumption anchor — every root, every count, and the height. A resumed cycle proves
    /// it continues THIS digest, so it can't silently restart or skip the count guards.
    pub fn digest(&self) -> [u8; 32] {
        let u64b = |n: u64| { let mut a = [0u8; 32]; a[24..].copy_from_slice(&n.to_be_bytes()); a };
        kn(&[
            &self.pool_root, &u64b(self.note_count),
            &self.spent_root, &u64b(self.spent_count),
            &self.utxo_root, &u64b(self.utxo_count),
            &self.burn_root, &u64b(self.burn_count),
            &u64b(self.height),
        ])
    }

    /// Nullify a spent note and tombstone its outpoint. ν is DERIVED from the note's
    /// commitment and BOUND to the outpoint's committed value (keccak(Cx,Cy) == u_node_value,
    /// the value the UTXO remove witness proves is stored at this outpoint) — so a spend
    /// can't insert a ν unrelated to the note actually at that outpoint. Returns ν (the burn
    /// set keys on it). Shared by transfers and burns.
    fn apply_spend(&mut self, s: &SpendWitness) -> Result<[u8; 32], &'static str> {
        let nu = bind_spent_note(&s.u_node_value, &s.cx, &s.cy).ok_or("ν not bound to the outpoint's note")?;
        self.spent_root = imt_insert_transition(
            &self.spent_root, &nu, &s.s_low_value, &s.s_low_next, s.s_low_index, &s.s_low_path,
            self.spent_count, &s.s_new_path,
        ).ok_or("spent-set insert witness invalid")?;
        self.spent_count += 1;
        self.utxo_root = utxo_remove_transition(
            &self.utxo_root, &s.outpoint, &s.u_node_next, &s.u_node_value, s.u_node_index, &s.u_node_path,
            &s.u_pred_key, &s.u_pred_value, s.u_pred_index, &s.u_pred_path,
        ).ok_or("utxo remove witness invalid")?;
        Ok(nu)
    }

    /// Append the output note and insert its outpoint → commitment in the UTXO set.
    fn apply_output(&mut self, o: &OutputWitness) -> Result<(), &'static str> {
        self.pool_root = keccak_tree_append_transition(&self.pool_root, self.note_count, &o.note_path, &o.note_leaf)
            .ok_or("note append witness invalid")?;
        self.note_count += 1;
        self.utxo_root = utxo_insert_transition(
            &self.utxo_root, &o.outpoint, &o.commitment_hash, &o.u_low_key, &o.u_low_next, &o.u_low_value,
            o.u_low_index, &o.u_low_path, self.utxo_count, &o.u_new_path,
        ).ok_or("utxo insert witness invalid")?;
        self.utxo_count += 1;
        Ok(())
    }

    /// Fold one confirmed transfer: spends first (so it can't spend an output it creates),
    /// then outputs. `height` must strictly increase. Mirrors ReflectionState::apply_transfer.
    pub fn apply_transfer(&mut self, spends: &[SpendWitness], outputs: &[OutputWitness], height: u64) -> Result<(), &'static str> {
        if height < self.height { return Err("reflection height must not decrease"); }
        for s in spends { self.apply_spend(s)?; }
        for o in outputs { self.apply_output(o)?; }
        self.height = height;
        Ok(())
    }

    /// Fold one confirmed cross-chain burn: a spend, plus an insert of ν → destCommitment
    /// into the bridge-burn set (ν is the derived nullifier of the spent note). Mirrors
    /// ReflectionState::apply_bridge_out.
    pub fn apply_bridge_out(&mut self, b: &BurnWitness, height: u64) -> Result<(), &'static str> {
        if height < self.height { return Err("reflection height must not decrease"); }
        let nu = self.apply_spend(&b.spend)?;
        self.burn_root = utxo_insert_transition(
            &self.burn_root, &nu, &b.dest_commitment, &b.b_low_key, &b.b_low_next, &b.b_low_value,
            b.b_low_index, &b.b_low_path, self.burn_count, &b.b_new_path,
        ).ok_or("burn-set insert witness invalid")?;
        self.burn_count += 1;
        self.height = height;
        Ok(())
    }
}

/// Full-scan reflection state (closes F4 — spent-set completeness). Same headless O(Δ) engine as
/// `WitnessedReflection` for the note tree, spent-set, and bridge-burn set (roots + counts +
/// witnessed transitions, never reconstructed — the spent-set is monotone O(history)), but the
/// UTXO set is the full in-memory `LiveUtxoSet`. The prover resumes `live` from handed contents
/// and re-derives `digest()`; the contract chains `priorDigest == knownReflectionDigest`, so a
/// wrong handoff fails the digest. With the real set in hand, every confirmed tx's vins are
/// resolved against it (`scan_tx_spends`) — no spend can be omitted, which is what the witnessed
/// model (relayer-chosen effects) could not guarantee. The detected spends fold into the spent-set
/// here; the UTXO removal already happened in the scan.
/// AMM pool_id derivation domain (worker `_AMM_POOL_ID_DOMAIN`).
pub const AMM_POOL_ID_DOMAIN: &[u8] = b"tacit-amm-pool-v1";

/// Canonical (lexicographically-ordered) asset pair — `(low, high)`; None if the two ids are equal.
/// Mirrors the worker's `ammCanonicalAssetPair`, the ordering the pool_id is derived over.
pub fn amm_canonical_pair(a: &[u8; 32], b: &[u8; 32]) -> Option<([u8; 32], [u8; 32])> {
    if a == b {
        return None;
    }
    if *a < *b {
        Some((*a, *b))
    } else {
        Some((*b, *a))
    }
}

/// Derive a V1 (no-protocol-fee, `capability_flags = 0`) AMM pool_id, mirroring the worker's
/// `ammDerivePoolId`: `sha256(domain ‖ low ‖ high ‖ fee_bps_LE(2) ‖ 0x00)`. POOL_INIT carries `fee_bps`,
/// so the reflection reconstructs the exact pool_id the LP kernel signed over; a variant-0 LP-add /
/// LP-remove (no `fee_bps` on the wire) is matched by canonical-asset enumeration over the registry.
pub fn amm_derive_pool_id_full(
    asset_a: &[u8; 32],
    asset_b: &[u8; 32],
    fee_bps: u16,
    capability_flags: u8,
    protocol_fee_address: &[u8; 33],
    protocol_fee_bps: u16,
) -> Option<[u8; 32]> {
    let (low, high) = amm_canonical_pair(asset_a, asset_b)?;
    let mut h = Sha256::new();
    h.update(AMM_POOL_ID_DOMAIN);
    h.update(low);
    h.update(high);
    h.update(fee_bps.to_le_bytes());
    h.update([capability_flags]);
    // The protocol-fee suffix is appended iff a fee is enabled (joint-non-zero with the address) — so a
    // protocol-fee / capability-flagged pool gets a DISTINCT pool_id from the canonical no-skim slot.
    // Mirrors the worker `ammDerivePoolId`. (capability_flags is a Bitcoin-side concept; the EVM side has no pools.)
    if protocol_fee_bps != 0 {
        h.update(protocol_fee_address);
        h.update(protocol_fee_bps.to_le_bytes());
    }
    Some(h.finalize().into())
}

/// The canonical NO-SKIM pool_id (capability_flags = 0, no protocol fee) — the slot LPs + swappers route to.
pub fn amm_derive_pool_id_v1(asset_a: &[u8; 32], asset_b: &[u8; 32], fee_bps: u16) -> Option<[u8; 32]> {
    amm_derive_pool_id_full(asset_a, asset_b, fee_bps, 0, &[0u8; 33], 0)
}

// ──────────────────── Groth16 (BN254) — T_SWAP_BATCH verifier foundation ────────────────────
// ops/DESIGN-in-guest-groth16-verifier.md. The reflection verifies the batch's snarkjs/circom Groth16 (the
// per-receipt clearing) to onboard confidential batch receipts. snarkjs encodes field elements as DECIMAL
// strings; the vk/proof parse into the big-endian field-byte types below (curve-crate-agnostic). The
// PAIRING itself (e(A,B)==e(α,β)·e(vk_x,γ)·e(C,δ)) is done with a BN254 crate (SP1 precompile-accelerated)
// in the reflection bin — see the scope doc; here we land the locally-testable parsing + types.

/// A snarkjs G1 point as big-endian field bytes `(x, y)` (the `"z"=1` projective coord is dropped).
pub type G1Aff = ([u8; 32], [u8; 32]);
/// A snarkjs G2 point as big-endian Fp2 field bytes `(x_c0, x_c1, y_c0, y_c1)`, in snarkjs limb order
/// (the verifier adapts to the BN254 crate's limb convention at the pairing step — see the scope doc).
pub type G2Aff = ([u8; 32], [u8; 32], [u8; 32], [u8; 32]);

/// A parsed Groth16 verifying key (snarkjs `verification_key.json` shape). `ic.len() == nPublic + 1`.
#[derive(Clone)]
pub struct G16Vk {
    pub alpha1: G1Aff,
    pub beta2: G2Aff,
    pub gamma2: G2Aff,
    pub delta2: G2Aff,
    pub ic: Vec<G1Aff>,
}

/// A parsed Groth16 proof (snarkjs `proof.json` shape): `A ∈ G1`, `B ∈ G2`, `C ∈ G1`.
#[derive(Clone)]
pub struct G16Proof {
    pub a: G1Aff,
    pub b: G2Aff,
    pub c: G1Aff,
}

/// Parse a snarkjs decimal field-element string into 32-byte big-endian. BN254 Fq/Fr are < 2^254, so they
/// fit in 32 bytes. Returns None on a non-digit or on overflow past 2^256 (a malformed vk/proof element).
pub fn dec_to_be32(s: &str) -> Option<[u8; 32]> {
    let mut acc = [0u8; 32];
    for ch in s.bytes() {
        if !ch.is_ascii_digit() {
            return None;
        }
        let mut carry = (ch - b'0') as u16;
        for byte in acc.iter_mut().rev() {
            let v = *byte as u16 * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return None; // overflowed 2^256 — not a valid BN254 field element
        }
    }
    // A canonical field element is < the BN254 base modulus q. Reject [q, 2^256): a value there is a
    // malformed vk/proof element, not just a 2^256 overflow. (q is the larger of Fq/Fr, so an Fr scalar
    // gets the looser q bound here; the pairing step reduces/validates Fr in its own field.) Array Ord on
    // [u8; 32] is lexicographic = big-endian numeric.
    const BN254_Q: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
    ];
    if acc >= BN254_Q {
        return None;
    }
    Some(acc)
}

/// Bitcoin-AMM LP-share asset-id domain (worker `_AMM_LP_ASSET_DOMAIN`). NOTE: distinct from the EVM
/// settle-guest `lp_share_id` (keccak `pool_id‖"lp"`) — the Bitcoin LP-share asset is `sha256(domain ‖ pool_id)`.
pub const AMM_LP_ASSET_DOMAIN: &[u8] = b"tacit-amm-lp-v1";

/// Minimum-liquidity floor locked at POOL_INIT (worker `AMM_MINIMUM_LIQUIDITY`). The founder's
/// onboardable share is `isqrt(Δa·Δb) − MINIMUM_LIQUIDITY` (the ML stays locked to a NUMS recipient).
pub const AMM_MINIMUM_LIQUIDITY: u64 = 1000;

/// Derive the Bitcoin-AMM LP-share asset_id, mirroring the worker's `ammDeriveLpAssetId`:
/// `sha256("tacit-amm-lp-v1" ‖ pool_id)`. The asset under which LP-share notes (minted at LP-add /
/// protocol-fee-claim, burned at LP-remove) live.
pub fn amm_derive_lp_asset_id(pool_id: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(AMM_LP_ASSET_DOMAIN);
    h.update(pool_id);
    h.finalize().into()
}

/// AMM farm-id derivation domain (worker `ammDeriveFarmId`).
pub const AMM_FARM_INIT_DOMAIN: &[u8] = b"tacit-amm-farm-init-v1";

/// Derive a farm_id, mirroring the worker's `ammDeriveFarmId`:
/// `sha256(domain ‖ pool_id ‖ launcher_pubkey(33) ‖ reward_asset ‖ farm_nonce)`. The reflection keys the
/// farm treasury by this so a T_LP_HARVEST's reward note is drawn from the right (C0-backed) treasury.
pub fn amm_derive_farm_id(pool_id: &[u8; 32], launcher_pubkey: &[u8; 33], reward_asset: &[u8; 32], farm_nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(AMM_FARM_INIT_DOMAIN);
    h.update(pool_id);
    h.update(launcher_pubkey);
    h.update(reward_asset);
    h.update(farm_nonce);
    h.finalize().into()
}

/// T_FARM_REFUND launcher-authorization domain + message. The launcher BIP-340-signs over the farm, the
/// exact draw (amount, r, view-height), AND the refund output's destination scriptPubKey (`dest_spk` =
/// vout[1] of the reveal tx). Binding the draw alone is not enough: the refund note is a pure bearer note
/// keyed only by its outpoint, so a mempool front-runner could replay the public envelope into their own
/// vout[1] and steal the treasury draw. The destination is signable (unlike the circular txid) and closes
/// that. Mirrors the worker's + dapp's farm-refund signing message and confidential-pool.js foldFarmRefund.
pub const FARM_REFUND_DOMAIN: &[u8] = b"tacit-amm-farm-refund-v1";
pub fn farm_refund_msg(farm_id: &[u8; 32], refund_amount: u64, refund_r: &[u8; 32], view_height: u32, dest_spk: &[u8]) -> [u8; 32] {
    kn(&[FARM_REFUND_DOMAIN, farm_id, &refund_amount.to_be_bytes(), refund_r, &view_height.to_be_bytes(), dest_spk])
}

/// Receipt-owner authorization for the trustless farm spends (harvest 0x3B / unbond 0x36). The receipt
/// preimage rides the PUBLIC envelope, so membership-of-the-leaf is NOT authorization (any observer can
/// reconstruct it). The owner BIP-340-signs over the spend, binding BOTH the materialized note's blinding
/// (reward_r / lp_return_r) AND its DESTINATION scriptPubKey (`dest_spk` = vout[1] of the reveal tx).
/// The destination is the load-bearing field: the materialized note is a PURE BEARER note keyed only by its
/// outpoint (reflected_note_leaf hardcodes owner=0), and its blinding is PUBLIC, so spend authority is
/// control of the vout[1] Bitcoin UTXO — NOT knowledge of the blinding. Binding only the blinding (the prior
/// design) let a mempool front-runner replay the public envelope into their OWN vout[1] and steal the
/// reward/principal: the owner sig stayed valid (it never named the destination), the guest folded the
/// attacker's tx first, and the bearer note materialized at the attacker's UTXO. The txid itself can't be
/// signed (it commits sha256(envelope), which contains the sig — circular), but the vout[1] scriptPubKey is
/// chosen at sign time and is not circular, so the guest re-parses it from the confirmed tx (extract_outputs)
/// and requires it to equal the signed value. The signing key is the x-only pubkey committed as the receipt's
/// `owner` (a one-time key, per CDP-close).
pub const LP_HARVEST_OWNER_DOMAIN: &[u8] = b"tacit-farm-harvest-owner-v1";
pub const LP_UNBOND_OWNER_DOMAIN: &[u8] = b"tacit-farm-unbond-owner-v1";
pub fn lp_harvest_owner_msg(farm_id: &[u8; 32], old_leaf: &[u8; 32], reward: u64, reward_r: &[u8; 32], dest_spk: &[u8]) -> [u8; 32] {
    kn(&[LP_HARVEST_OWNER_DOMAIN, farm_id, old_leaf, &reward.to_be_bytes(), reward_r, dest_spk])
}
pub fn lp_unbond_owner_msg(farm_id: &[u8; 32], old_leaf: &[u8; 32], shares: u64, lp_return_r: &[u8; 32], dest_spk: &[u8]) -> [u8; 32] {
    kn(&[LP_UNBOND_OWNER_DOMAIN, farm_id, old_leaf, &shares.to_be_bytes(), lp_return_r, dest_spk])
}

/// EVM-lane farm receipt-spend owner authorization (OP_FARM_HARVEST / OP_FARM_UNBOND in the settle guest).
/// The receipt preimage is public, so it is NOT authorization: the receipt owner must BIP-340-sign the spend.
/// On Ethereum the output is a Pedersen note whose blinding the guest never sees (only its commitment), and a
/// delegated proving box can nullify the receipt and re-mint the reward/release note under a commitment IT
/// controls — capturing the value (the leaf `owner` field is bearer-only). So the EVM message binds the OUTPUT
/// COMMITMENT (the dest the box could substitute), the receipt being spent, the amounts, and (harvest) the
/// advanced-receipt nonce — the analogues of the Bitcoin lane's `reward_r` + `dest_spk`. Distinct domains from
/// the Bitcoin-lane messages so a signature can never cross lanes.
pub const EVM_LP_HARVEST_OWNER_DOMAIN: &[u8] = b"tacit-evm-farm-harvest-owner-v1";
pub const EVM_LP_UNBOND_OWNER_DOMAIN: &[u8] = b"tacit-evm-farm-unbond-owner-v1";
pub fn evm_lp_harvest_owner_msg(
    farm_id: &[u8; 32], old_leaf: &[u8; 32], reward: u64, fee: u64, new_nonce: &[u8; 32],
    reward_asset: &[u8; 32], reward_cx: &[u8; 32], reward_cy: &[u8; 32],
) -> [u8; 32] {
    kn(&[
        EVM_LP_HARVEST_OWNER_DOMAIN, farm_id, old_leaf, &reward.to_be_bytes(), &fee.to_be_bytes(),
        new_nonce, reward_asset, reward_cx, reward_cy,
    ])
}
pub fn evm_lp_unbond_owner_msg(
    farm_id: &[u8; 32], receipt: &[u8; 32], shares: u64, fee: u64, lp_asset: &[u8; 32],
    release_cx: &[u8; 32], release_cy: &[u8; 32],
) -> [u8; 32] {
    kn(&[
        EVM_LP_UNBOND_OWNER_DOMAIN, farm_id, receipt, &shares.to_be_bytes(), &fee.to_be_bytes(),
        lp_asset, release_cx, release_cy,
    ])
}

/// Track-B per-pool reserve provenance (ops/DESIGN-bridge-multiasset-provenance.md). A Bitcoin AMM
/// pool's `(asset_a, asset_b)` and current public reserves, plus whether those reserves are known to
/// descend from the assets' supply note `C_0` (`c0_backed`). The reflection advances this as it folds
/// the pool's confirmed AMM txs; a swap output is onboarded as real only against a `c0_backed` pool whose
/// tracked reserves match the swap's declared `R_*_pre` (so a forged reserve can't mint unbacked value).
#[derive(Clone)]
pub struct PoolReserveState {
    pub asset_a: [u8; 32],
    pub asset_b: [u8; 32],
    pub reserve_a: u64,
    pub reserve_b: u64,
    // Total LP shares outstanding (constant-product share accounting). Tracked so a T_LP_REMOVE's proportional
    // withdrawal `delta_X = floor(R_X·share/S)` matches the worker's pool state — keeping the reflection's
    // reserves in lockstep so later swaps still validate. Advanced by fold_lp_add, drawn by fold_lp_remove.
    pub total_shares: u64,
    pub c0_backed: bool,
    // Protocol-fee (Uniswap-V2 lazy `mintFee`) state, set at POOL_INIT from the 6-arg pool_id config. This is
    // a creator-earned LP-fee skim (any pool creator can enable it), not just protocol governance:
    //   `protocol_fee_bps` — the skim tier (0 = the canonical no-skim pool);
    //   `k_last` — `reserve_a·reserve_b` at the last crystallization (advanced only at LP events, NOT swaps);
    //   `protocol_fee_accrued` — virtual LP-shares owed to the fee recipient, minted at LP events + claimed by
    //   T_PROTOCOL_FEE_CLAIM. All three ride `root()` so a resumed cycle can't forge the accrued fee.
    pub protocol_fee_bps: u16,
    pub k_last: u128,
    pub protocol_fee_accrued: u64,
}

impl PoolReserveState {
    /// Crystallize the Uniswap-V2 lazy protocol fee from the SWAP-driven k-growth since `k_last`: mint the skim
    /// as LP shares (into `protocol_fee_accrued` + `total_shares`) and advance `k_last` to the CURRENT k. Call
    /// at every LP event (LP_ADD / LP_REMOVE / PROTOCOL_FEE_CLAIM) on the CURRENT (pre-liquidity-change) reserves;
    /// for LP_ADD/REMOVE the caller RE-SETS `k_last` to the post-change k afterward, so an LP deposit is never
    /// taxed as a fee (Uniswap V2 `_mintFee` / worker `ammCrystallizeProtocolFee`). No-op for a no-skim pool.
    pub fn crystallize_protocol_fee(&mut self) {
        if self.protocol_fee_bps == 0 {
            return;
        }
        let k_now = (self.reserve_a as u128) * (self.reserve_b as u128);
        if k_now <= self.k_last {
            self.k_last = k_now; // baseline only (no growth)
            return;
        }
        let shares = protocol_fee_shares(self.total_shares, self.k_last, k_now, self.protocol_fee_bps);
        // checked, not saturating: a silent cap would diverge consensus state from exact protocol math.
        // Unreachable for real values (total_shares = isqrt(reserve_a·reserve_b) stays well under 2^51 for
        // any real BTC reserves), so the overflow aborts the proof (fail-closed) rather than ever firing.
        self.protocol_fee_accrued = self.protocol_fee_accrued.checked_add(shares).expect("protocol fee accrued overflow");
        self.total_shares = self.total_shares.checked_add(shares).expect("protocol fee total_shares overflow");
        self.k_last = k_now;
    }
}

/// The Track-B per-pool reserve registry: a sorted `pool_id → PoolReserveState` map with a committed
/// `root()` (mirrors `LiveUtxoSet`). The root joins `ScanReflection::digest()`, so a resumed cycle's
/// handed pools are pinned by the digest chain (`priorDigest == knownReflectionDigest`) — a prover cannot
/// resume with a forged reserve or a falsely-`c0_backed` pool. POOL_INIT/LP-add insert + advance entries;
/// `fold_swap_var` reads the looked-up state, applies, and the caller writes it back.
#[derive(Clone)]
pub struct PoolReserveSet {
    entries: Vec<([u8; 32], PoolReserveState)>,
}

impl Default for PoolReserveSet {
    fn default() -> Self {
        Self::new()
    }
}

impl PoolReserveSet {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    /// Adopt a handed registry: pool_ids strictly ascending + non-zero (same discipline as `LiveUtxoSet`).
    pub fn from_sorted(entries: Vec<([u8; 32], PoolReserveState)>) -> Option<Self> {
        for i in 0..entries.len() {
            if entries[i].0 == [0u8; 32] {
                return None;
            }
            if i > 0 && !be_lt(&entries[i - 1].0, &entries[i].0) {
                return None;
            }
        }
        Some(Self { entries })
    }

    /// The pool's current state, if tracked. Cloned so the caller can fold + write back without holding a
    /// borrow on `self` (which `fold_swap_var` needs mutably for the note-tree append).
    pub fn get(&self, pool_id: &[u8; 32]) -> Option<PoolReserveState> {
        self.entries.binary_search_by(|(k, _)| k.cmp(pool_id)).ok().map(|i| self.entries[i].1.clone())
    }

    /// Register a new pool (POOL_INIT). Panics on a duplicate pool_id (a malformed batch — a pool is
    /// initialized once).
    pub fn insert(&mut self, pool_id: &[u8; 32], state: PoolReserveState) {
        match self.entries.binary_search_by(|(k, _)| k.cmp(pool_id)) {
            Ok(_) => panic!("duplicate pool in reserve set"),
            Err(i) => self.entries.insert(i, (*pool_id, state)),
        }
    }

    /// Advance an existing pool's reserves (swap / LP). Panics if the pool isn't registered (the caller
    /// resolves it via `get` first).
    pub fn update(&mut self, pool_id: &[u8; 32], state: PoolReserveState) {
        let i = self.entries.binary_search_by(|(k, _)| k.cmp(pool_id)).expect("pool not in reserve set");
        self.entries[i].1 = state;
    }

    /// Committed root: Keccak Merkle over `(pool_id ‖ asset_a ‖ asset_b ‖ reserve_a ‖ reserve_b ‖ c0_backed)`
    /// leaves in pool_id order. Every field is committed so a resumed handoff can't forge a reserve or flip
    /// the backing flag without failing the digest chain.
    pub fn root(&self) -> [u8; 32] {
        let u64b = |n: u64| {
            let mut a = [0u8; 32];
            a[24..].copy_from_slice(&n.to_be_bytes());
            a
        };
        let u128b = |n: u128| {
            let mut a = [0u8; 32];
            a[16..].copy_from_slice(&n.to_be_bytes());
            a
        };
        let leaves: Vec<[u8; 32]> = self.entries.iter().map(|(k, s)| {
            let mut backed = [0u8; 32];
            if s.c0_backed {
                backed[31] = 1;
            }
            kn(&[
                k, &s.asset_a, &s.asset_b, &u64b(s.reserve_a), &u64b(s.reserve_b), &u64b(s.total_shares),
                &backed, &u64b(s.protocol_fee_bps as u64), &u128b(s.k_last), &u64b(s.protocol_fee_accrued),
            ])
        }).collect();
        keccak_merkle_root(&leaves)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Candidate pool_ids whose stored canonical `(asset_a, asset_b)` match the given pair — for a
    /// variant-0 LP-add / LP-remove that doesn't carry `fee_bps`; the caller disambiguates by which
    /// candidate's pool_id makes the op's kernel verify (the kernel binds pool_id).
    pub fn pool_ids_for_assets(&self, asset_a: &[u8; 32], asset_b: &[u8; 32]) -> Vec<[u8; 32]> {
        self.entries.iter()
            .filter(|(_, s)| &s.asset_a == asset_a && &s.asset_b == asset_b)
            .map(|(k, _)| *k)
            .collect()
    }
}

/// The per-cycle delta `fold_cbtc_lock` returns — surfaced in the reflection public values as a
/// `cbtcLocksFolded` entry. `commitment_hash = keccak(Cx‖Cy)` binds the locker's pre-committed cBTC note
/// so only that note can be minted against this lock by `ConfidentialPool.mintCbtc` (anti-griefing); the
/// value-opening (note == v_btc) is checked there, not here. See ops/DESIGN-confidential-defi-v1.md §3.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CbtcLockFold {
    pub outpoint: [u8; 32],
    pub v_btc: u64,
    pub commitment_hash: [u8; 32],
}

#[derive(Clone)]
pub struct ScanReflection {
    pub pool_root: [u8; 32],
    pub note_count: u64,
    pub spent_root: [u8; 32],
    pub spent_count: u64,
    pub live: LiveUtxoSet,
    pub burn_root: [u8; 32],
    pub burn_count: u64,
    pub height: u64,
    // cBTC: the live SELF-CUSTODY cBTC.zk locks (lock outpoint → sats) and their running total. A lock is
    // the locker's OWN output committed to a cBTC note; its sats back the minted cBTC (peg, oracle-free).
    // A locker spending their lock without redeeming (a "rug") is detected here, dropping the backing — the
    // off-pool CbtcBuffer reads `cbtc_backing_sats` (surfaced as cbtcBackingSats) to cover the shortfall.
    // Both are committed in `digest()` so the resumed total can't be forged.
    pub cbtc_locks: LiveUtxoSet,
    pub cbtc_backing_sats: u64,
    // Track B: per-pool public-reserve provenance (pool_id → reserves + c0_backed). Advanced by the AMM
    // folds (POOL_INIT / LP / swap); committed in `digest()` so a resumed cycle can't forge a pool's backing.
    pub pools: PoolReserveSet,
    // FAST LANE: count of consumed-ν folded from the eth-reflection consumed set (the reverse reflection of
    // ConfidentialPool.bitcoinConsumed). The resume point so a cycle folds exactly the NEW members in order;
    // committed in `digest()` so it can't be rolled back to re-open an already-marked-spent note.
    pub consumed_count: u64,
    // FAST LANE / Mode-B anchor: the eth-reflection accumulator digest (eth_refl_digest = the eth proof's
    // committed newDigest, binding crossOutSetRoot + consumedNuSetRoot + both counts) as of the last Mode-B
    // cycle; [0;32] until the first. Committed in `digest()` so the contract's priorDigest chain forces the
    // NEXT Mode-B cycle's witnessed eth prior to continue it — closing the forged-eth-prior bypass of the
    // consumed-ν / crossout folds (a witnessed prior set root is no longer free). See reflect.rs Mode-B.
    pub eth_refl_digest: [u8; 32],
    // Farms (SPEC-CONTROLLER-VAULT-AMENDMENT §4): the per-farm reward-per-share accumulator (rate,
    // total_shares, rps) — GLOBAL state only, byte-for-byte the EVM `FarmController`'s `(rate, totalShares,
    // rps)`. The per-staker checkpoint is NOT here: it rides the note tree as an owner-blinded RECEIPT note
    // (`farm_receipt_leaf`), nullified on harvest/unbond through the spent set — so there is no per-bond
    // record to deanonymize (parity with the EVM position-tree receipt). Committed in `digest()` so a
    // resumed cycle can't forge a farm's rps / total_shares (which would let an over-reward harvest pass).
    pub farm_rewards: FarmRewardSet,
}

impl Default for ScanReflection {
    fn default() -> Self {
        Self::genesis()
    }
}

impl ScanReflection {
    /// Genesis: empty note tree, sentinel-seeded spent/burn sets, an empty live UTXO set. The
    /// spent/burn counts start at 1 (the {0→0} sentinel occupies index 0).
    pub fn genesis() -> Self {
        Self {
            pool_root: keccak_merkle_root(&[]),
            note_count: 0,
            spent_root: imt_empty_root(),
            spent_count: 1,
            live: LiveUtxoSet::new(),
            burn_root: UtxoAccumulator::new().root(),
            burn_count: 1,
            height: 0,
            cbtc_locks: LiveUtxoSet::new(),
            cbtc_backing_sats: 0,
            pools: PoolReserveSet::new(),
            consumed_count: 0,
            eth_refl_digest: [0u8; 32],
            farm_rewards: FarmRewardSet::new(),
        }
    }

    /// (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight) — the relay public values.
    pub fn commit(&self) -> ([u8; 32], [u8; 32], u64) {
        (self.pool_root, self.spent_root, self.height)
    }

    /// Resumption anchor: every headless root + count, the LIVE-set root + size, and the height.
    /// A resumed cycle proves it continues THIS digest, so the handed live set is pinned (its root
    /// is in here) and the count guards can't be skipped.
    pub fn digest(&self) -> [u8; 32] {
        let u64b = |n: u64| {
            let mut a = [0u8; 32];
            a[24..].copy_from_slice(&n.to_be_bytes());
            a
        };
        kn(&[
            &self.pool_root, &u64b(self.note_count),
            &self.spent_root, &u64b(self.spent_count),
            &self.live.root(), &u64b(self.live.len() as u64),
            &self.burn_root, &u64b(self.burn_count),
            &u64b(self.height),
            // cBTC backing — pinned so a resumed cycle can't forge the live cBTC.zk lock total.
            &self.cbtc_locks.root(), &u64b(self.cbtc_backing_sats),
            // Track B: per-pool reserve registry — pinned so a resumed cycle can't forge a pool's
            // reserves or its c0_backed flag (which would let fold_swap_var onboard unbacked value).
            &self.pools.root(), &u64b(self.pools.len() as u64),
            // FAST LANE: how many eth-consumed ν have been folded into the spent set (resume pin).
            &u64b(self.consumed_count),
            // FAST LANE / Mode-B: the eth-reflection accumulator digest (binds both eth set roots + counts)
            // as of the last Mode-B cycle — the cross-cycle anchor that bars a forged witnessed eth prior.
            &self.eth_refl_digest,
            // Farms (SPEC-CONTROLLER-VAULT-AMENDMENT §4): the per-farm reward-per-share accumulator
            // (rate, total_shares, rps) — pinned so a resumed cycle can't forge a farm's rps / total_shares
            // (which would let an over-reward harvest pass). The per-staker receipts are owner-blinded leaves
            // in the note tree (pool_root) + nullified through the spent set, so they need no separate pin.
            // Empty (= keccak_merkle_root(&[]), len 0) until the first farm is registered.
            &self.farm_rewards.root(), &u64b(self.farm_rewards.len() as u64),
        ])
    }

    /// Fold a detected spend's ν into the spent-set (witnessed IMT insert). The live-set removal
    /// and the ν↔note binding already happened in `scan_tx_spends`; this is the monotone
    /// spent-set transition only. `height` must not decrease.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_spent(
        &mut self,
        nu: &[u8; 32],
        s_low_value: &[u8; 32],
        s_low_next: &[u8; 32],
        s_low_index: u64,
        s_low_path: &[[u8; 32]],
        s_new_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        self.spent_root = imt_insert_transition(
            &self.spent_root, nu, s_low_value, s_low_next, s_low_index, s_low_path,
            self.spent_count, s_new_path,
        ).ok_or("spent-set insert witness invalid")?;
        self.spent_count += 1;
        Ok(())
    }

    /// FAST LANE (consumed-ν reverse reflection): mark a Bitcoin-homed note SPENT because its ν was
    /// consumed by a value-exit on the Ethereum fast lane — proven by membership in the eth-reflection
    /// consumed set (the reverse reflection of `ConfidentialPool.bitcoinConsumed[ν]`). Ethereum-senior:
    /// the caller runs this BEFORE the Bitcoin block scan, and it REMOVES the source UTXO from `live` so a
    /// racing Bitcoin spend of that note in this cycle finds it absent (`scan_tx_spends` no longer treats
    /// it as a pool spend → the racing tx's CXFER outputs fail conservation = voided). The live-removal is
    /// the void mechanism precisely because `fold_spent` would PANIC on the double-insert otherwise.
    ///
    /// Folded in append order: membership is checked at index `self.consumed_count`, which then increments
    /// — so the caller MUST fold the WHOLE `[prior, consumed_nu_count)` range with no skip (an omitted
    /// consume leaves the note live on Bitcoin = double-spend). Unlike `fold_crossout`/`fold_cxfer` this is
    /// NOT skip-not-panic: an `Err` here is a hard prover error (the caller `.expect`s it).
    ///
    /// FRESHNESS + ANCHOR (both enforced outside this fn — soundness rests on them). (1) COUNT freshness:
    /// the eth proof must cover EVERY ν recorded in `bitcoinConsumed`, else an omitted consume's outpoint
    /// stays live = double-credit. Enforced by the eth-reflection guest (`consumedNuCount ==
    /// bitcoinConsumedCount` at its finalized slot) + the contract (`ConsumedCountStale`: the reflection's
    /// committed count == `bitcoinConsumedCount` now). (2) SET-CONTENT anchor: the eth accumulator the fold
    /// is authorized against must be the REAL one — `reflect.rs` requires the eth proof's priorDigest to
    /// continue `state.eth_refl_digest` (pinned by the contract's priorDigest chain), so a witnessed forged
    /// prior that satisfies (1) vacuously is rejected. This fn assumes both hold; it only reproduces the
    /// state transition (`eth_consumed_member` against the trusted set root + the ν↔note binding).
    #[allow(clippy::too_many_arguments)]
    pub fn fold_consumed(
        &mut self,
        nu: &[u8; 32],
        spend_root: &[u8; 32],
        cx: &[u8; 32],
        cy: &[u8; 32],
        source_txid: &[u8; 32],
        source_vout: u32,
        set_path: &[[u8; 32]],
        consumed_set_root: &[u8; 32],
        s_low_value: &[u8; 32],
        s_low_next: &[u8; 32],
        s_low_index: u64,
        s_low_path: &[[u8; 32]],
        s_new_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        let co = crate::eth_reflection::EthConsumed { nullifier: *nu, spend_root: *spend_root };
        if !crate::eth_reflection::eth_consumed_member(&co, self.consumed_count, set_path, consumed_set_root) {
            return Err("consumed fold: ν not the next member of the eth consumed set (skip or wrong order)");
        }
        if &nullifier(cx, cy) != nu {
            return Err("consumed fold: ν != nullifier(Cx,Cy)");
        }
        // The source note must be a LIVE Bitcoin pool UTXO bound to this (Cx,Cy). Remove it (Ethereum-senior
        // void) so a racing Bitcoin spend this cycle isn't detected, then mark ν spent.
        let outpoint = outpoint_key(source_txid, source_vout);
        let (live_ch, _asset) = self.live.get(&outpoint).ok_or("consumed fold: source outpoint not a live UTXO")?;
        if live_ch != commitment_hash(cx, cy) {
            return Err("consumed fold: live commitment != Cx,Cy");
        }
        self.live.remove(&outpoint);
        self.fold_spent(nu, s_low_value, s_low_next, s_low_index, s_low_path, s_new_path)?;
        self.consumed_count += 1;
        Ok(())
    }

    /// Fold one output note: append the note leaf (witnessed note-tree transition) and add the
    /// outpoint → `(commitment hash, asset)` to the live UTXO set so a later tx in the batch can
    /// spend it. `asset` is the note's asset (the CXFER envelope's declared asset) — carried so a
    /// later spend can re-impose asset preservation.
    pub fn fold_output(
        &mut self,
        note_leaf: &[u8; 32],
        note_path: &[[u8; 32]],
        outpoint: &[u8; 32],
        commitment_hash: &[u8; 32],
        asset: &[u8; 32],
    ) -> Result<(), &'static str> {
        self.pool_root = keccak_tree_append_transition(&self.pool_root, self.note_count, note_path, note_leaf)
            .ok_or("note append witness invalid")?;
        self.note_count += 1;
        self.live.insert(outpoint, commitment_hash, asset);
        Ok(())
    }

    /// Append a proven-real note to the pool tree WITHOUT marking its outpoint live — for a burn-deposit
    /// note (a pre-existing Bitcoin note proven real via `burn_deposit::verify_provenance_leaves`) that is
    /// onboarded and IMMEDIATELY bridged out. It must be a pool member so `OP_BRIDGE_MINT` proves its
    /// membership and the kernel binds `v_mint == v_burn` (exactly as for a reflected bridge-out), but it
    /// must NEVER enter the live set: it is spent now, not an in-pool-spendable UTXO. Append-only; the
    /// caller separately `fold_spent`s its ν and `fold_burn`s ν → dest.
    pub fn fold_note_append(&mut self, note_leaf: &[u8; 32], note_path: &[[u8; 32]]) -> Result<(), &'static str> {
        self.pool_root = keccak_tree_append_transition(&self.pool_root, self.note_count, note_path, note_leaf)
            .ok_or("note append witness invalid")?;
        self.note_count += 1;
        Ok(())
    }

    /// Fold a confirmed CXFER tx's outputs into the pool — ONLY if the tx CONSERVES value. Verifies
    /// the BIP-340 kernel + the BP+ range proof over the detected pool-note inputs and the envelope's
    /// outputs (`verify_cxfer_conservation`) BEFORE appending any output note, so a confirmed-but-non-
    /// conserving tx injects NOTHING (its spends are still nullified by the caller via `fold_spent`;
    /// no phantom note enters `bitcoinPoolRoot`). Each accepted output: derive its leaf
    /// (`reflected_note_leaf`, never a free witness) + UTXO value (`commitment_hash_compressed`),
    /// append the note, insert the outpoint. Fails closed (folding nothing) on a bad kernel/range,
    /// a non-curve-point commitment, or a mismatched output-witness length.
    ///
    /// REFLECT-1: without the conservation gate the per-output `fold_output` loop appended an
    /// attacker's inflated commitment (Σ_out ≫ Σ_in) into the pool root — Bitcoin never checks the
    /// Tacit kernel — making unbacked notes mintable/withdrawable cross-lane on Ethereum (value from
    /// nothing). The leaf-SHAPE binding cannot catch it (an inflated commitment is a valid curve
    /// point).
    ///
    /// ASSET PRESERVATION: conservation is value-only (`Σ C_in = Σ C_out`, asset-blind — the kernel
    /// only labels the message with `asset`). So a confirmed CXFER could spend a CHEAP-asset note and
    /// declare DEAR-asset outputs of equal commitment-value: value conserves, asset flips, and the
    /// dear note becomes bridge-mintable on Ethereum (cross-asset inflation). `input_assets` are the
    /// spent notes' assets (carried by the live UTXO set, see `DetectedSpend.asset`); every one MUST
    /// equal the envelope's declared `asset`, the same binding the EVM lane gets from `leaf(asset,…)`
    /// membership. Fails closed (folds nothing) on mismatch, like a non-conserving tx — its spends
    /// are still nullified by the caller, so a relabel just burns the attacker's input for nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_cxfer(
        &mut self,
        asset: &[u8; 32],
        input_outpoints: &[([u8; 32], u32)],
        input_commitments: &[Point],
        input_assets: &[[u8; 32]],
        txid: &[u8; 32],
        output_commitments_compressed: &[[u8; 33]],
        output_paths: &[Vec<[u8; 32]>],
        output_vouts: &[u32],
        range_proof: &[u8],
        kernel_sig: &[u8; 64],
    ) -> Result<(), &'static str> {
        let n = output_commitments_compressed.len();
        if output_paths.len() != n || output_vouts.len() != n {
            return Err("cxfer fold: output witness length mismatch");
        }
        if input_assets.len() != input_commitments.len() {
            return Err("cxfer fold: input asset length mismatch");
        }
        // Asset preservation: every spent note must be of the envelope's declared asset (closes the
        // cross-asset inflation path the value-only conservation can't see).
        if input_assets.iter().any(|a| a != asset) {
            return Err("cxfer fold: non-asset-preserving (input asset != envelope asset)");
        }
        if !verify_cxfer_conservation(asset, input_outpoints, input_commitments, output_commitments_compressed, range_proof, kernel_sig) {
            return Err("cxfer fold: tx does not conserve value (kernel/range)");
        }
        for i in 0..n {
            let commitment = &output_commitments_compressed[i];
            let note_leaf = reflected_note_leaf(asset, commitment).ok_or("cxfer fold: output commitment not a curve point")?;
            let ch = commitment_hash_compressed(commitment).ok_or("cxfer fold: output commitment not a curve point")?;
            let outpoint = outpoint_key(txid, output_vouts[i]);
            self.fold_output(&note_leaf, &output_paths[i], &outpoint, &ch, asset)?;
        }
        Ok(())
    }

    /// Fold a confirmed `T_SWAP_VAR` (Track B): onboard the taker's receipt note as a real, live pool
    /// member — ONLY if the pool is C0-backed, the swap's declared reserves match the tracked reserves,
    /// the input-side kernel verifies, and the receipt opens to `delta_out` ≤ the out-side reserve. Then
    /// the receipt is bridgeable exactly like any reflected note (`OP_BRIDGE_MINT` binds `v_mint == v_burn`).
    ///
    /// Soundness: the receipt's value is `delta_out`, drawn from `R_out_pre` which is C0-backed, so the
    /// onboarded note descends from `C_0`. The in-side reserve credit (`+delta_in`) is backed because the
    /// kernel binds it to the taker's REAL spent input `C_in` (a prior live note; the caller resolves it via
    /// `scan_tx_spends` and passes its asset). The tip leaves the pool (it's `delta_in_total − delta_in`),
    /// so only `delta_in` is credited. Fails closed (folds nothing, skip-not-panic) on any miss: a forged
    /// reserve, a bad kernel/opening, an over-draw, or a non-C0-backed pool just leaves the note un-onboarded
    /// (completeness only — never an over-mint). `pool` is advanced in place on success.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_swap_var(
        &mut self,
        pool: &mut PoolReserveState,
        env: &bitcoin::SwapVarEnvelope,
        input_outpoint: ([u8; 32], u32),
        input_asset: &[u8; 32],
        receipt_outpoint: &[u8; 32],
        receipt_note_path: &[[u8; 32]],
        // The taker's change note (leftover of c_in) is onboarded ATOMICALLY here, not by the caller, so a
        // bad change-append path skips the whole swap instead of dropping the user's change after the receipt
        // + reserves already committed. Present iff c_change_or_sentinel is a real (non-sentinel) note.
        change_outpoint: &[u8; 32],
        change_note_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        // (1) the pool must be C0-backed and its declared reserves must match what we track (anti-forgery).
        if !pool.c0_backed {
            return Err("swap_var fold: pool not C0-backed");
        }
        if pool.reserve_a != env.r_a_pre || pool.reserve_b != env.r_b_pre {
            return Err("swap_var fold: declared reserves != tracked reserves");
        }
        // (2) direction → in/out assets + reserves.
        let (asset_in, asset_out, r_in_pre, r_out_pre) = if env.direction == 0 {
            (&pool.asset_a, &pool.asset_b, pool.reserve_a, pool.reserve_b)
        } else if env.direction == 1 {
            (&pool.asset_b, &pool.asset_a, pool.reserve_b, pool.reserve_a)
        } else {
            return Err("swap_var fold: bad direction");
        };
        // (3) the taker's spent input must be of the pool's in-side asset (carried by the live set).
        if input_asset != asset_in {
            return Err("swap_var fold: input asset != pool in-side asset");
        }
        // (4) kernel: the taker really contributed delta_in_total = delta_in + tip of asset_in. C_in is a
        //     real spent live note (resolved by the caller), so the credited delta_in is backed.
        let delta_in_total = (env.delta_in as u128) + (env.tip_amount as u128);
        if delta_in_total >= (1u128 << 64) {
            return Err("swap_var fold: delta_in_total overflow");
        }
        if !swap_var_kernel_verify(
            asset_in, input_outpoint, &env.c_in, &env.c_change_or_sentinel, delta_in_total as u64, &env.kernel_sig,
        ) {
            return Err("swap_var fold: kernel verify");
        }
        // (5) the receipt opens to delta_out under the PUBLIC r_receipt — its value is exactly delta_out.
        if env.delta_out == 0 {
            return Err("swap_var fold: zero delta_out");
        }
        let c_receipt_pt = decompress(&env.c_receipt).ok_or("swap_var fold: receipt not a curve point")?;
        if !verify_pedersen_opening(&c_receipt_pt, env.delta_out, &scalar_reduce_be(&env.r_receipt)) {
            return Err("swap_var fold: receipt opening != delta_out");
        }
        // (6) conservation: the pool can only pay out what it holds of the out-side asset.
        if env.delta_out > r_out_pre {
            return Err("swap_var fold: delta_out exceeds out-side reserve");
        }
        // (7) compute the post-reserves BEFORE any state mutation (validate-then-commit, as fold_swap_route /
        //     fold_swap_batch already do): in-side += delta_in (the tip leaves the pool), out-side −= delta_out.
        //     Running the fallible checked_add ahead of fold_output keeps the fold strictly all-or-nothing — a
        //     receipt note can never be onboarded while the reserve debit is skipped (which would leave the
        //     out-side reserve overstated and double-extractable by a later swap).
        let r_in_post = r_in_pre.checked_add(env.delta_in).ok_or("swap_var fold: in-reserve overflow")?;
        let r_out_post = r_out_pre - env.delta_out; // ≤ checked above
        // Constant-product floor: the swap must NOT decrease k. delta_out ≤ reserve (step 6) alone lets an
        // off-curve swap (e.g. delta_in=1, delta_out≈r_out) drain the out-side at a ruinous rate and onboard a
        // receipt the reserves never fairly gave up (LP theft). Reflection enforces VALUE conservation, not the
        // exact fee'd price (the settler's concern), so the no-fee floor k_post ≥ k_pre suffices. u64·u64 ≤ u128.
        if (r_in_post as u128) * (r_out_post as u128) < (r_in_pre as u128) * (r_out_pre as u128) {
            return Err("swap_var fold: constant-product floor (k decreased)");
        }
        // Onboard the receipt as a real live note (same leaf/UTXO shape as any reflected output). fold_output
        // is itself atomic (it returns Err before mutating on a bad append path), so nothing partial lands.
        let note_leaf = reflected_note_leaf(asset_out, &env.c_receipt).ok_or("swap_var fold: receipt not a curve point")?;
        let ch = commitment_hash_compressed(&env.c_receipt).ok_or("swap_var fold: receipt not a curve point")?;
        // Stage the receipt append, and the taker's change append on top of it, BEFORE mutating self — so a
        // bad change path fails the WHOLE swap (no half-apply: receipt live + change dropped). The change
        // rides asset_in; a sentinel c_change means no change note (reflected_note_leaf returns None). On
        // success this commits byte-identically to a receipt fold_output followed by a separate change append.
        let recv_root = keccak_tree_append_transition(&self.pool_root, self.note_count, receipt_note_path, &note_leaf)
            .ok_or("swap_var fold: receipt append witness invalid")?;
        let change = match reflected_note_leaf(asset_in, &env.c_change_or_sentinel) {
            Some(c_leaf) => {
                let c_ch = commitment_hash_compressed(&env.c_change_or_sentinel).ok_or("swap_var fold: change hash")?;
                let c_root = keccak_tree_append_transition(&recv_root, self.note_count + 1, change_note_path, &c_leaf)
                    .ok_or("swap_var fold: change append witness invalid")?;
                Some((c_root, c_ch))
            }
            None => None,
        };
        match change {
            Some((c_root, c_ch)) => {
                self.pool_root = c_root;
                self.note_count += 2;
                self.live.insert(receipt_outpoint, &ch, asset_out);
                self.live.insert(change_outpoint, &c_ch, asset_in);
            }
            None => {
                self.pool_root = recv_root;
                self.note_count += 1;
                self.live.insert(receipt_outpoint, &ch, asset_out);
            }
        }
        if env.direction == 0 {
            pool.reserve_a = r_in_post;
            pool.reserve_b = r_out_post;
        } else {
            pool.reserve_b = r_in_post;
            pool.reserve_a = r_out_post;
        }
        Ok(())
    }

    /// Fold a confirmed `T_SWAP_ROUTE` (0x33, Track B): atomic multi-hop AMM routing. The trader's single
    /// real input note flows through up to 4 pools and lands as ONE receipt note of the final hop's output
    /// asset (public `r_receipt`, exactly like `fold_swap_var`). Soundness (no bridge inflation) rests on a
    /// VALUE CHAIN, validated end-to-end before any mutation (all-or-nothing, skip-not-panic on failure):
    ///   - hop 0's input amount is bound to the trader's REAL spent note by `swap_var_kernel_verify`
    ///     (sentinel change ⇒ `C_in` commits exactly that amount);
    ///   - each later hop's `(input asset, input amount)` must equal the prior hop's `(output asset, output
    ///     amount)` — so no value is conjured between pools (the intermediate flows pool-to-pool, never a note);
    ///   - every pool is `c0_backed`, its declared `R_*_pre` matches the tracked reserves, and it pays out
    ///     `≤` its reserve;
    ///   - the receipt opens to the final hop's output amount under the PUBLIC `r_receipt`.
    /// AMM PRICE correctness (was each `delta_out` fair for `delta_in`?) is the settler's concern, not the
    /// reflection's — bridging only needs value conservation: you can't onboard more than the c0-backed
    /// reserves gave up. A pool repeated within one route is rejected (its staged reserves would be stale);
    /// such an exotic route just doesn't bridge directly (heal via a CXFER hop) — fail-closed, never an
    /// over-mint. See ops/DESIGN-bridge-multiasset-provenance.md (Track B).
    pub fn fold_swap_route(
        &mut self,
        env: &bitcoin::SwapRouteEnvelope,
        input_outpoint: ([u8; 32], u32),
        input_asset: &[u8; 32],
        receipt_outpoint: &[u8; 32],
        receipt_note_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        if input_asset != &env.trader_input_asset {
            return Err("swap_route fold: spent input asset != route input asset");
        }
        // Validate + stage every hop BEFORE mutating self (all-or-nothing).
        let mut staged: Vec<([u8; 32], PoolReserveState)> = Vec::with_capacity(env.n_hops);
        let mut cur_asset = env.trader_input_asset;
        let mut cur_amount: u64 = 0;
        for (i, hop) in env.hops.iter().enumerate() {
            if staged.iter().any(|(pid, _)| pid == &hop.pool_id) {
                return Err("swap_route fold: pool repeated in route");
            }
            let mut pool = self.pools.get(&hop.pool_id).ok_or("swap_route fold: unknown pool")?;
            if !pool.c0_backed {
                return Err("swap_route fold: pool not C0-backed");
            }
            if pool.reserve_a != hop.r_a_pre || pool.reserve_b != hop.r_b_pre {
                return Err("swap_route fold: declared reserves != tracked reserves");
            }
            let (in_asset, out_asset, r_in, r_out, in_mag, out_mag) = if hop.direction == 0 {
                (pool.asset_a, pool.asset_b, pool.reserve_a, pool.reserve_b, hop.delta_a_net_mag, hop.delta_b_net_mag)
            } else {
                (pool.asset_b, pool.asset_a, pool.reserve_b, pool.reserve_a, hop.delta_b_net_mag, hop.delta_a_net_mag)
            };
            if in_asset != cur_asset {
                return Err("swap_route fold: hop input asset breaks the chain");
            }
            if i == 0 {
                if in_mag == 0 {
                    return Err("swap_route fold: zero route input");
                }
                // sentinel change ⇒ C_in commits EXACTLY in_mag of the input asset (the trader paid it all in).
                if !swap_var_kernel_verify(&cur_asset, input_outpoint, &env.c_in, &[0u8; 33], in_mag, &env.kernel_sig) {
                    return Err("swap_route fold: input kernel verify");
                }
                // cur_amount is set to this hop's out_mag at the loop tail (below); no first-hop seed needed.
            } else if in_mag != cur_amount {
                return Err("swap_route fold: hop input amount breaks the chain");
            }
            if out_mag == 0 {
                return Err("swap_route fold: zero hop output");
            }
            if out_mag > r_out {
                return Err("swap_route fold: hop output exceeds reserve");
            }
            let r_in_post = r_in.checked_add(in_mag).ok_or("swap_route fold: in-reserve overflow")?;
            let r_out_post = r_out - out_mag; // ≤ checked above
            // Constant-product floor per hop (same as fold_swap_var): out_mag ≤ reserve alone lets a hop run
            // off-curve and extract value the pool never fairly gave up. Require k_post ≥ k_pre. u64·u64 ≤ u128.
            if (r_in_post as u128) * (r_out_post as u128) < (r_in as u128) * (r_out as u128) {
                return Err("swap_route fold: constant-product floor (k decreased)");
            }
            if hop.direction == 0 {
                pool.reserve_a = r_in_post;
                pool.reserve_b = r_out_post;
            } else {
                pool.reserve_b = r_in_post;
                pool.reserve_a = r_out_post;
            }
            staged.push((hop.pool_id, pool));
            cur_asset = out_asset;
            cur_amount = out_mag;
        }
        if cur_asset != env.trader_output_asset {
            return Err("swap_route fold: final hop asset != route output asset");
        }
        let c_receipt_pt = decompress(&env.c_receipt).ok_or("swap_route fold: receipt not a curve point")?;
        if !verify_pedersen_opening(&c_receipt_pt, cur_amount, &scalar_reduce_be(&env.r_receipt)) {
            return Err("swap_route fold: receipt opening != final output amount");
        }
        // commit: onboard the receipt, then write back every hop's advanced reserves.
        let note_leaf =
            reflected_note_leaf(&env.trader_output_asset, &env.c_receipt).ok_or("swap_route fold: receipt not a curve point")?;
        let ch = commitment_hash_compressed(&env.c_receipt).ok_or("swap_route fold: receipt not a curve point")?;
        self.fold_output(&note_leaf, receipt_note_path, receipt_outpoint, &ch, &env.trader_output_asset)?;
        for (pid, pool) in staged {
            self.pools.update(&pid, pool);
        }
        Ok(())
    }

    /// Fold a confirmed `T_LP_ADD` / POOL_INIT (Track B): establish or grow a pool's reserves in the
    /// registry, marked `c0_backed` only when BOTH per-asset conservation kernels verify AND the LP's input
    /// notes are real (C0-backed). Both sides prove `Σ value(inputs) = delta_*` (`lp_add_kernel_verify`), so
    /// the reserve credits are backed; `inputs_c0_backed` (the dispatch's verdict that every LP input was a
    /// live-reflected note) carries the descend-to-`C_0` property into the pool. A POOL_INIT (`variant == 1`)
    /// inserts a fresh pool; an LP-add (`variant == 0`) grows an existing one (its `c0_backed` stays true
    /// only while every contribution is backed). The minted LP-share is NOT onboarded here (it's pool
    /// ownership, not a `C_0`-rooted asset note — its own follow-up); this fold only advances the reserve
    /// provenance that `fold_swap_var` consumes. Fails closed (changes nothing) on a bad kernel, an asset
    /// mismatch, a duplicate POOL_INIT, or an unknown LP-add pool.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_lp_add(
        &mut self,
        variant: u8,
        pool_id: &[u8; 32],
        asset_a: &[u8; 32],
        asset_b: &[u8; 32],
        delta_a: u64,
        delta_b: u64,
        share_amount: u64,
        share_csecp: &[u8; 33],
        a_input_outpoints: &[([u8; 32], u32)],
        a_input_commitments: &[Point],
        a_kernel_sig: &[u8; 64],
        b_input_outpoints: &[([u8; 32], u32)],
        b_input_commitments: &[Point],
        b_kernel_sig: &[u8; 64],
        inputs_c0_backed: bool,
        protocol_fee_bps: u16, // POOL_INIT only: the pool's lazy-mintFee tier (0 = canonical no-skim pool)
    ) -> Result<(), &'static str> {
        if asset_a == asset_b {
            return Err("lp_add fold: assets must differ");
        }
        // Both per-asset kernels must prove the inputs net to exactly delta_a / delta_b (pool_id + assets +
        // deltas are bound in the kernel message, so a forged pool_id or relabeled side fails here).
        if !lp_add_kernel_verify(
            variant, pool_id, asset_a, delta_a, share_amount, share_csecp, a_input_outpoints, a_input_commitments, a_kernel_sig,
        ) {
            return Err("lp_add fold: asset_a kernel verify");
        }
        if !lp_add_kernel_verify(
            variant, pool_id, asset_b, delta_b, share_amount, share_csecp, b_input_outpoints, b_input_commitments, b_kernel_sig,
        ) {
            return Err("lp_add fold: asset_b kernel verify");
        }
        match variant {
            1 => {
                // POOL_INIT: a fresh pool. Reserves = the seeded deltas; backed iff the seed inputs are real.
                if self.pools.get(pool_id).is_some() {
                    return Err("lp_add fold: POOL_INIT for an already-registered pool");
                }
                if delta_a == 0 || delta_b == 0 {
                    return Err("lp_add fold: POOL_INIT requires non-zero reserves");
                }
                // Initial total shares = isqrt(Δa·Δb), the geometric-mean first mint (the founder gets that minus MINIMUM_LIQUIDITY,
                // which stays locked — so TOTAL outstanding is isqrt). Tracks the worker's lp_total_shares.
                let total_shares = isqrt(delta_a as u128 * delta_b as u128);
                if total_shares > u64::MAX as u128 {
                    return Err("lp_add fold: POOL_INIT total shares overflow");
                }
                // First-mint floor (mirror EVM OP_LP_ADD main.rs:1319): the founder's onboardable share is
                // `total_shares − MINIMUM_LIQUIDITY`, so a seed whose geometric mean isn't strictly above the
                // locked floor would mint zero/underflowing founder shares while burning the deposit. Reject it.
                if total_shares <= AMM_MINIMUM_LIQUIDITY as u128 {
                    return Err("lp_add fold: POOL_INIT initial liquidity below MINIMUM_LIQUIDITY");
                }
                // The protocol skim is a fraction of the LP fee out of 10000; protocol_fee_shares computes
                // `10000 - protocol_fee_bps`, so a POOL_INIT setting it >= 10000 (it's a u16) would underflow.
                // Bound it < 10000 (skim < 100%); a tighter fairness cap is a product policy on top of this.
                if protocol_fee_bps >= 10000 {
                    return Err("lp_add fold: protocol fee bps must be < 10000");
                }
                self.pools.insert(pool_id, PoolReserveState {
                    asset_a: *asset_a, asset_b: *asset_b, reserve_a: delta_a, reserve_b: delta_b,
                    total_shares: total_shares as u64, c0_backed: inputs_c0_backed,
                    protocol_fee_bps, k_last: delta_a as u128 * delta_b as u128, protocol_fee_accrued: 0,
                });
                Ok(())
            }
            0 => {
                // LP-add: grow an existing pool. Assets must match; reserves += the (kernel-bound) deltas.
                let mut pool = self.pools.get(pool_id).ok_or("lp_add fold: LP-add to an unknown pool")?;
                if &pool.asset_a != asset_a || &pool.asset_b != asset_b {
                    return Err("lp_add fold: LP-add asset mismatch");
                }
                // Crystallize the protocol fee from swap-driven k-growth BEFORE the deposit (Uniswap V2
                // `_mintFee`): `total_shares` may grow, so the proportional mint is over the POST-crystallization
                // supply — matching the worker, which crystallizes before computing the LP's shares.
                pool.crystallize_protocol_fee();
                // Shares minted over the PRE-add reserves (proportional mint), then reserves grow.
                let minted = lp_add_shares(pool.total_shares, delta_a, delta_b, pool.reserve_a, pool.reserve_b);
                if minted > u64::MAX as u128 {
                    return Err("lp_add fold: minted shares overflow");
                }
                pool.reserve_a = pool.reserve_a.checked_add(delta_a).ok_or("lp_add fold: reserve_a overflow")?;
                pool.reserve_b = pool.reserve_b.checked_add(delta_b).ok_or("lp_add fold: reserve_b overflow")?;
                pool.total_shares = pool.total_shares.checked_add(minted as u64).ok_or("lp_add fold: total shares overflow")?;
                // Backing is monotone: it stays true only while every contribution is itself backed.
                pool.c0_backed = pool.c0_backed && inputs_c0_backed;
                // The LP deposit itself isn't a fee — advance k_last to the POST-deposit k (so the next
                // crystallization counts only swap growth, never this deposit).
                pool.k_last = pool.reserve_a as u128 * pool.reserve_b as u128;
                self.pools.update(pool_id, pool);
                Ok(())
            }
            _ => Err("lp_add fold: bad variant"),
        }
    }

    /// Fold a confirmed `T_LP_REMOVE` (Track B): the LP burns `share_amount` of LP-shares and withdraws the
    /// proportional `(delta_a, delta_b)`; onboard the withdrawn notes as real so they bridge like any
    /// reflected note. Soundness: (1) the share-burn kernel proves the LP owns the shares (anti-theft);
    /// (2) `delta_X = floor(R_X·share/S)` matches the worker's accounting, so the reflection's reserves stay
    /// in lockstep (a drain-the-pool over-withdrawal is rejected — a later swap would otherwise desync);
    /// (3) each `recv_X` opens to the PUBLIC `delta_X` under a reflection-witnessed blinding `r_recv_X`, so
    /// its value is EXACTLY the reserve decrease (no over-withdrawal mints unbacked value). `r_recv_X` is a
    /// private witness (never in PublicValues) and `delta_X` is already public on-chain, so this binding
    /// leaks nothing the envelope didn't and preserves the note's forward-spend privacy. Then reserves +
    /// shares are drawn down. Fails closed on any miss. See ops/DESIGN-bridge-multiasset-provenance.md (B).
    #[allow(clippy::too_many_arguments)]
    pub fn fold_lp_remove(
        &mut self,
        pool_id: &[u8; 32],
        share_amount: u64,
        delta_a: u64,
        delta_b: u64,
        recv_a_secp: &[u8; 33],
        r_recv_a: &[u8; 32],
        recv_b_secp: &[u8; 33],
        r_recv_b: &[u8; 32],
        lp_input_outpoints: &[([u8; 32], u32)],
        lp_input_commitments: &[Point],
        kernel_sig: &[u8; 64],
        recv_a_path: &[[u8; 32]],
        recv_a_outpoint: &[u8; 32],
        recv_b_path: &[[u8; 32]],
        recv_b_outpoint: &[u8; 32],
    ) -> Result<(), &'static str> {
        let mut pool = self.pools.get(pool_id).ok_or("lp_remove fold: unknown pool")?;
        if !pool.c0_backed {
            return Err("lp_remove fold: pool not C0-backed");
        }
        // Crystallize the protocol fee from swap-driven k-growth BEFORE the withdrawal (Uniswap V2 `_mintFee`),
        // so the proportional `delta_X = floor(R_X·share/S)` is over the POST-crystallization supply — matching
        // the worker, which crystallizes before computing the LP's outputs.
        pool.crystallize_protocol_fee();
        if pool.total_shares == 0 || share_amount == 0 || share_amount > pool.total_shares {
            return Err("lp_remove fold: bad share amount");
        }
        // Minimum-liquidity floor: the AMM_MINIMUM_LIQUIDITY shares locked at POOL_INIT must remain, so a
        // remove burns only the unlocked shares. Unreachable under correct minting (the locked shares are
        // never owned), enforced here as defense-in-depth, mirroring the Solidity pool. (share_amount <=
        // total_shares above, so the subtraction can't underflow.)
        if pool.total_shares - share_amount < AMM_MINIMUM_LIQUIDITY {
            return Err("lp_remove fold: minimum liquidity breach");
        }
        // (1) proportional withdrawal must equal the worker's ammLpRemoveOutputs (floor toward zero), so the
        //     reflection's reserves track the worker's; da ≤ reserve_a since share ≤ total_shares.
        let da = (pool.reserve_a as u128 * share_amount as u128) / pool.total_shares as u128;
        let db = (pool.reserve_b as u128 * share_amount as u128) / pool.total_shares as u128;
        if da != delta_a as u128 || db != delta_b as u128 {
            return Err("lp_remove fold: non-proportional withdrawal");
        }
        if delta_a == 0 || delta_b == 0 {
            return Err("lp_remove fold: zero withdrawal");
        }
        // (2) the LP really burned `share_amount` of this pool's shares (anti-theft).
        if !lp_remove_kernel_verify(pool_id, share_amount, delta_a, delta_b, recv_a_secp, recv_b_secp, lp_input_outpoints, lp_input_commitments, kernel_sig) {
            return Err("lp_remove fold: share-burn kernel");
        }
        // (3) each withdrawn note opens to its PUBLIC delta_X (witnessed blinding) — value == reserve decrease.
        let recv_a_pt = decompress(recv_a_secp).ok_or("lp_remove fold: recv_a not a curve point")?;
        if !verify_pedersen_opening(&recv_a_pt, delta_a, &scalar_reduce_be(r_recv_a)) {
            return Err("lp_remove fold: recv_a opening != delta_a");
        }
        let recv_b_pt = decompress(recv_b_secp).ok_or("lp_remove fold: recv_b not a curve point")?;
        if !verify_pedersen_opening(&recv_b_pt, delta_b, &scalar_reduce_be(r_recv_b)) {
            return Err("lp_remove fold: recv_b opening != delta_b");
        }
        // Onboard both withdrawn notes ATOMICALLY: stage BOTH note-tree append transitions before mutating
        // anything, so a bad recv_b append path can't leave recv_a already live with the reserves un-debited
        // (the caller folds this under skip-not-panic). recv_b appends on top of recv_a (note_count + 1). On
        // success the committed state is byte-identical to two sequential fold_output calls; only a witness
        // failure now leaves the state untouched instead of half-applied.
        let leaf_a = reflected_note_leaf(&pool.asset_a, recv_a_secp).ok_or("lp_remove fold: recv_a leaf")?;
        let ch_a = commitment_hash_compressed(recv_a_secp).ok_or("lp_remove fold: recv_a hash")?;
        let leaf_b = reflected_note_leaf(&pool.asset_b, recv_b_secp).ok_or("lp_remove fold: recv_b leaf")?;
        let ch_b = commitment_hash_compressed(recv_b_secp).ok_or("lp_remove fold: recv_b hash")?;
        let root_a = keccak_tree_append_transition(&self.pool_root, self.note_count, recv_a_path, &leaf_a)
            .ok_or("lp_remove fold: recv_a append witness invalid")?;
        let root_b = keccak_tree_append_transition(&root_a, self.note_count + 1, recv_b_path, &leaf_b)
            .ok_or("lp_remove fold: recv_b append witness invalid")?;
        self.pool_root = root_b;
        self.note_count += 2;
        self.live.insert(recv_a_outpoint, &ch_a, &pool.asset_a);
        self.live.insert(recv_b_outpoint, &ch_b, &pool.asset_b);
        pool.reserve_a -= delta_a;
        pool.reserve_b -= delta_b;
        pool.total_shares -= share_amount;
        // The withdrawal isn't a fee — advance k_last to the POST-removal k.
        pool.k_last = pool.reserve_a as u128 * pool.reserve_b as u128;
        self.pools.update(pool_id, pool);
        Ok(())
    }

    /// Fold a confirmed `T_PROTOCOL_FEE_CLAIM` (0x31): the pool's fee recipient (a CREATOR-earned LP-fee skim,
    /// not just governance) claims the accrued protocol-fee LP-shares as a real note. The claim is an LP event,
    /// so crystallize first, then require `claim_amount` == the post-crystallization `protocol_fee_accrued`
    /// (the worker's exact-claim rule — no over/under-mint), onboard the claim note (opens to `claim_amount`
    /// under the PUBLIC `claim_blinding`, asset = the pool's Bitcoin LP-share asset), and reset the accrued to 0.
    /// The crystallize already added these shares to `total_shares`, so they're backed by the pool's reserves —
    /// the claim just materializes them as a bridgeable note. The claimer authorization (sig == fee recipient)
    /// is the worker's fairness gate, not bridge-soundness. No-op for a no-skim pool; fails closed on any miss.
    pub fn fold_protocol_fee_claim(
        &mut self,
        pool_id: &[u8; 32],
        claim_amount: u64,
        claim_c_secp: &[u8; 33],
        claim_blinding: &[u8; 32],
        claim_outpoint: &[u8; 32],
        claim_note_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        let mut pool = self.pools.get(pool_id).ok_or("protocol_fee_claim fold: unknown pool")?;
        if !pool.c0_backed {
            return Err("protocol_fee_claim fold: pool not C0-backed");
        }
        if pool.protocol_fee_bps == 0 {
            return Err("protocol_fee_claim fold: pool has no protocol fee");
        }
        // Crystallize the swap-driven skim (this claim is an LP event), then require the exact accrued amount.
        pool.crystallize_protocol_fee();
        if claim_amount == 0 || claim_amount != pool.protocol_fee_accrued {
            return Err("protocol_fee_claim fold: claim != accrued");
        }
        // The claim note opens to `claim_amount` under the PUBLIC blinding (value == the accrued skim).
        let c_pt = decompress(claim_c_secp).ok_or("protocol_fee_claim fold: claim not a curve point")?;
        if !verify_pedersen_opening(&c_pt, claim_amount, &scalar_reduce_be(claim_blinding)) {
            return Err("protocol_fee_claim fold: claim opening != claim_amount");
        }
        // Onboard as a note of the pool's Bitcoin LP-share asset (the crystallize already counted these in
        // total_shares — bridging them is backed; this just materializes the virtual claim as a real note).
        let lp_asset = amm_derive_lp_asset_id(pool_id);
        let leaf = reflected_note_leaf(&lp_asset, claim_c_secp).ok_or("protocol_fee_claim fold: claim leaf")?;
        let ch = commitment_hash_compressed(claim_c_secp).ok_or("protocol_fee_claim fold: claim hash")?;
        self.fold_output(&leaf, claim_note_path, claim_outpoint, &ch, &lp_asset)?;
        pool.protocol_fee_accrued = 0; // the accrued skim is now a claimed note
        self.pools.update(pool_id, pool);
        Ok(())
    }

    /// Fold a confirmed `T_FARM_INIT` (Track B): establish a farm treasury as a C0-backed reserve. The
    /// launcher's reward-asset input (the detected live spend) conserves `reward_total` into the (virtual)
    /// treasury under the SAME `tacit-kernel-v1` input-side kernel as a swap (`C_in − C_change =
    /// reward_total·H`). The treasury is keyed by `farm_id` in the SAME registry as pools — a degenerate
    /// pool: `asset_a = reward_asset`, `reserve_a = treasury_remaining`, the rest zero (farm_ids never collide
    /// with pool_ids — different derivations). A later `T_LP_HARVEST` draws reward notes from it. Fails closed
    /// on a bad funding kernel / duplicate farm.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_farm_init(
        &mut self,
        farm_id: &[u8; 32],
        reward_asset: &[u8; 32],
        reward_total: u64,
        launcher_input_outpoint: ([u8; 32], u32),
        launcher_c_in: &[u8; 33],
        c_change_or_sentinel: &[u8; 33],
        kernel_sig: &[u8; 64],
        inputs_c0_backed: bool,
    ) -> Result<(), &'static str> {
        if reward_total == 0 {
            return Err("farm_init fold: zero treasury");
        }
        if self.pools.get(farm_id).is_some() {
            return Err("farm_init fold: farm already registered");
        }
        // The launcher really put `reward_total` of `reward_asset` into the treasury (reuses the swap kernel).
        if !swap_var_kernel_verify(reward_asset, launcher_input_outpoint, launcher_c_in, c_change_or_sentinel, reward_total, kernel_sig) {
            return Err("farm_init fold: treasury-funding kernel");
        }
        self.pools.insert(farm_id, PoolReserveState {
            asset_a: *reward_asset, asset_b: [0u8; 32], reserve_a: reward_total, reserve_b: 0,
            total_shares: 0, c0_backed: inputs_c0_backed,
            protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0, // a farm treasury has no protocol fee
        });
        Ok(())
    }

    /// Fold a confirmed `T_LP_HARVEST` (Track B): onboard a farmer's reward note (drawn from a C0-backed farm
    /// treasury) as real + bridgeable. The reward note is DERIVED from the PUBLIC `(reward_amount, reward_r)`
    /// the envelope carries — `C_reward = reward_amount·H + reward_r·G` — so its value is exactly the treasury
    /// draw, and the treasury is debited `reward_amount` (≤ the remaining treasury ⇒ no inflation). Onboards
    /// `C_reward` at the harvest's vout[1]. The accrual/entitlement (is `reward_amount` the harvester's legit
    /// share?) is the worker's FAIRNESS gate, not a bridge-soundness one — an over-accrual harvest's reward is
    /// still ≤ the real treasury, never minted.
    pub fn fold_harvest(
        &mut self,
        farm_id: &[u8; 32],
        reward_amount: u64,
        reward_r: &[u8; 32],
        reward_outpoint: &[u8; 32],
        reward_note_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        let mut farm = self.pools.get(farm_id).ok_or("harvest fold: unknown farm")?;
        if !farm.c0_backed {
            return Err("harvest fold: farm not C0-backed");
        }
        if reward_amount == 0 || reward_amount > farm.reserve_a {
            return Err("harvest fold: reward exceeds treasury");
        }
        let c_reward = gen_h() * Scalar::from(reward_amount) + ProjectivePoint::generator() * scalar_reduce_be(reward_r);
        let c_compressed = compress(&c_reward);
        let leaf = reflected_note_leaf(&farm.asset_a, &c_compressed).ok_or("harvest fold: reward leaf")?;
        let ch = commitment_hash_compressed(&c_compressed).ok_or("harvest fold: reward hash")?;
        self.fold_output(&leaf, reward_note_path, reward_outpoint, &ch, &farm.asset_a)?;
        farm.reserve_a -= reward_amount;
        self.pools.update(farm_id, farm);
        Ok(())
    }

    /// Farm (SPEC-CONTROLLER-VAULT-AMENDMENT §4/§5) — register the per-farm reward-per-share accumulator
    /// at `FARM_INIT` (alongside the treasury `fold_farm_init`). `rate` = total reward units/block, fixed here.
    pub fn fold_farm_init_rewards(&mut self, farm_id: &[u8; 32], rate: u64, launcher_pubkey: &[u8; 33], pool_id: &[u8; 32]) -> Result<(), &'static str> {
        if self.farm_rewards.get(farm_id).is_some() {
            return Err("farm reward state already registered");
        }
        let mut st = FarmRewardState::new(rate, self.height);
        st.launcher_pubkey = *launcher_pubkey; // bind the launcher (∈ farm_id) so only it can T_FARM_REFUND
        st.lp_asset = amm_derive_lp_asset_id(pool_id); // bind the bondable LP-share asset (T_LP_BOND must spend it)
        self.farm_rewards.insert(farm_id, st);
        Ok(())
    }

    /// Fold a confirmed `T_FARM_REFUND` (Track B): the farm LAUNCHER reclaims unspent treasury. Authorize it
    /// in-guest (not just the worker gate) — else a permissionless prover could draw any farm's treasury into
    /// an attacker-claimable public-`r` note. Requires the envelope's `launcher_pubkey` to equal the one bound
    /// in `farm_id` at FARM_INIT (stored here) AND a BIP-340 signature under it over the refund. The draw then
    /// reuses `fold_harvest` (mint the public-`r` note at vout[1] + debit the treasury, ≤ reserve ⇒ no inflation).
    #[allow(clippy::too_many_arguments)]
    pub fn fold_farm_refund(
        &mut self,
        farm_id: &[u8; 32],
        refund_amount: u64,
        refund_r: &[u8; 32],
        refund_view_height: u32,
        refund_outpoint: &[u8; 32],
        refund_note_path: &[[u8; 32]],
        launcher_pubkey: &[u8; 33],
        launcher_sig: &[u8; 64],
        dest_spk: &[u8],
    ) -> Result<(), &'static str> {
        let st = self.farm_rewards.get(farm_id).ok_or("refund: unknown farm")?;
        if &st.launcher_pubkey != launcher_pubkey {
            return Err("refund: launcher pubkey not the one bound in farm_id");
        }
        // Bind the destination (vout[1] scriptPubKey) so a front-runner can't replay the public envelope to
        // redirect the treasury draw to their own UTXO (see farm_refund_msg + the harvest/unbond owner-auth doc).
        let msg = farm_refund_msg(farm_id, refund_amount, refund_r, refund_view_height, dest_spk);
        let xonly: [u8; 32] = launcher_pubkey[1..33].try_into().map_err(|_| "refund: launcher x-only")?;
        if !bip340_verify(launcher_sig, &msg, &xonly) {
            return Err("refund: launcher signature");
        }
        self.fold_harvest(farm_id, refund_amount, refund_r, refund_outpoint, refund_note_path)
    }

    /// Farm BOND (trustless, SPEC-CONTROLLER-VAULT-AMENDMENT §4): accrue the farm, add `shares` to
    /// `total_shares`, and append the shielded RECEIPT note committing `(shares, rps_entry = live rps, owner,
    /// nonce)` to the note tree. `rps_entry` is the reflection's AUTHORITATIVE live rps — computed HERE, never
    /// witnessed — so a backdated claim can't earn pre-bond reward (the receipt's checkpoint cannot precede the
    /// bond). `shares` is the conservation-validated bonded LP value (the dispatch's kernel proved the bond
    /// input). No per-bond global state: the owner-blinded receipt is the only record, so positions are
    /// unlinkable — parity with the EVM position-tree receipt. `owner` is the staker's blinded owner commitment
    /// (NOT a bare pubkey); `nonce` makes the leaf fresh. Returns the appended receipt leaf.
    pub fn fold_lp_bond(
        &mut self,
        farm_id: &[u8; 32],
        shares: u64,
        owner: &[u8; 32],
        nonce: &[u8; 32],
        receipt_path: &[[u8; 32]],
    ) -> Result<[u8; 32], &'static str> {
        let mut st = self.farm_rewards.get(farm_id).ok_or("bond: unknown farm")?;
        let entry = st.bond(shares, self.height); // accrue + total_shares += ; entry = live rps
        let leaf = farm_receipt_leaf(farm_id, shares, entry, owner, nonce);
        self.fold_note_append(&leaf, receipt_path)?; // atomic: returns Err WITHOUT mutating on a bad witness
        self.farm_rewards.update(farm_id, st);
        Ok(leaf)
    }

    /// Verify a receipt leaf's membership in the note tree (`pool_root`) and compute the spent-set root after
    /// inserting its domain-separated nullifier (spend-once). Pure w.r.t. `self` (returns the new root) so the
    /// caller commits atomically alongside any note append. Shared by harvest + unbond. The nullifier matches
    /// `verify_farm_harvest`'s (`tacit-farm-receipt-null-v1 ‖ leaf`).
    #[allow(clippy::too_many_arguments)]
    fn receipt_spend_root(
        &self,
        leaf: &[u8; 32],
        old_index: u64,
        old_path: &[[u8; 32]],
        s_low_value: &[u8; 32],
        s_low_next: &[u8; 32],
        s_low_index: u64,
        s_low_path: &[[u8; 32]],
        s_new_path: &[[u8; 32]],
    ) -> Result<[u8; 32], &'static str> {
        if !keccak_merkle_verify(leaf, old_index, old_path, &self.pool_root) {
            return Err("receipt not in note tree");
        }
        let null = farm_receipt_nullifier(leaf);
        imt_insert_transition(
            &self.spent_root, &null, s_low_value, s_low_next, s_low_index, s_low_path,
            self.spent_count, s_new_path,
        )
        .ok_or("receipt nullifier insert witness invalid")
    }

    /// Farm HARVEST (trustless): prove the OLD receipt `(shares, rps_entry, owner, old_nonce)` is in the
    /// note tree, bound `reward ≤ shares·(rps − rps_entry)` against the reflection's live `rps` (NOT a witnessed
    /// `exit_acc_per_share`), nullify the old receipt (spend-once), and append the advanced NEW receipt
    /// committing `rps_entry' = rps_entry + reward·PRECISION/shares` — so a re-harvest earns only new accrual.
    /// Atomic: every witnessed transition is validated before any state mutates. The treasury debit (the
    /// no-inflation backstop) stays in `fold_harvest`. The new receipt's `new_nonce` re-blinds it, keeping
    /// successive harvests unlinkable (modulo the unique-`shares` caveat).
    #[allow(clippy::too_many_arguments)]
    pub fn fold_lp_harvest(
        &mut self,
        farm_id: &[u8; 32],
        shares: u64,
        rps_entry: u128,
        owner: &[u8; 32],
        old_nonce: &[u8; 32],
        new_nonce: &[u8; 32],
        reward: u64,
        old_index: u64,
        old_path: &[[u8; 32]],
        s_low_value: &[u8; 32],
        s_low_next: &[u8; 32],
        s_low_index: u64,
        s_low_path: &[[u8; 32]],
        s_new_path: &[[u8; 32]],
        new_receipt_path: &[[u8; 32]],
        reward_r: &[u8; 32],
        dest_spk: &[u8],
        owner_sig: &[u8; 64],
    ) -> Result<(), &'static str> {
        let mut st = self.farm_rewards.get(farm_id).ok_or("harvest: unknown farm")?;
        // The bound (`harvest_ok`) + the leaf/nullifier/new-leaf derivation — all in-guest, rps from `st`.
        let (old_leaf, _old_null, new_leaf) = verify_farm_harvest(
            farm_id, &mut st, self.height, shares, rps_entry, owner, old_nonce, new_nonce, reward,
        )
        .ok_or("harvest: reward exceeds accrual")?;
        // OWNER AUTH: the public receipt preimage is NOT authorization. The receipt owner must BIP-340-sign
        // over the spend, binding the reward note's blinding (reward_r) AND its destination scriptPubKey
        // (`dest_spk` = vout[1] of this reveal tx). The destination is the load-bearing field: the reward note
        // is bearer + keyed only by its outpoint, so without it a front-runner replays the public envelope into
        // their own vout[1] and steals the reward (the sig stays valid). See lp_harvest_owner_msg's doc.
        let owner_msg = lp_harvest_owner_msg(farm_id, &old_leaf, reward, reward_r, dest_spk);
        if !bip340_verify(owner_sig, &owner_msg, owner) {
            return Err("harvest: owner signature");
        }
        // Pre-validate BOTH witnessed transitions, then commit together (no half-apply on a bad witness).
        let new_spent_root = self.receipt_spend_root(
            &old_leaf, old_index, old_path, s_low_value, s_low_next, s_low_index, s_low_path, s_new_path,
        )?;
        let new_pool_root =
            keccak_tree_append_transition(&self.pool_root, self.note_count, new_receipt_path, &new_leaf)
                .ok_or("harvest: new receipt append witness invalid")?;
        self.spent_root = new_spent_root;
        self.spent_count += 1;
        self.pool_root = new_pool_root;
        self.note_count += 1;
        self.farm_rewards.update(farm_id, st);
        Ok(())
    }

    /// Farm UNBOND: prove the receipt `(shares, rps_entry, owner, nonce)` is in the note tree, nullify it
    /// (spend-once), and drop `shares` from the farm's `total_shares`. No new receipt (the position is closed);
    /// any unclaimed accrual is forfeited unless harvested first — same model as the EVM `onCdpClose`.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_lp_unbond(
        &mut self,
        farm_id: &[u8; 32],
        shares: u64,
        rps_entry: u128,
        owner: &[u8; 32],
        nonce: &[u8; 32],
        old_index: u64,
        old_path: &[[u8; 32]],
        s_low_value: &[u8; 32],
        s_low_next: &[u8; 32],
        s_low_index: u64,
        s_low_path: &[[u8; 32]],
        s_new_path: &[[u8; 32]],
        lp_return_r: &[u8; 32],
        lp_return_outpoint: &[u8; 32],
        lp_return_path: &[[u8; 32]],
        dest_spk: &[u8],
        owner_sig: &[u8; 64],
    ) -> Result<(), &'static str> {
        let leaf = farm_receipt_leaf(farm_id, shares, rps_entry, owner, nonce);
        // OWNER AUTH (see fold_lp_harvest): the public receipt preimage isn't authorization — the owner must
        // BIP-340-sign over the lp-return note's blinding (lp_return_r) AND its destination scriptPubKey
        // (`dest_spk` = vout[1]). The destination is load-bearing: the re-minted LP-share note is bearer +
        // keyed only by lp_return_outpoint, so binding only the blinding let a front-runner replay the public
        // envelope into their own vout[1] and steal the unbonded principal. dest_spk closes that.
        let owner_msg = lp_unbond_owner_msg(farm_id, &leaf, shares, lp_return_r, dest_spk);
        if !bip340_verify(owner_sig, &owner_msg, owner) {
            return Err("unbond: owner signature");
        }
        let new_spent_root = self.receipt_spend_root(
            &leaf, old_index, old_path, s_low_value, s_low_next, s_low_index, s_low_path, s_new_path,
        )?;
        let mut st = self.farm_rewards.get(farm_id).ok_or("unbond: unknown farm")?;
        // Return the bonded LP-shares: mint a LIVE `lp_asset` note opening to exactly `shares` under the PUBLIC
        // `lp_return_r` (the bond locked `shares`; this gives them back, conserving — onboarded like a harvest
        // reward, but of the farm's lp_asset so it's spendable / re-bondable). Validate-then-commit: the note
        // onboard + the receipt retire + the share drop all land together (fold_output is atomic on a bad path).
        let c_ret = gen_h() * Scalar::from(shares) + ProjectivePoint::generator() * scalar_reduce_be(lp_return_r);
        let c_comp = compress(&c_ret);
        let ret_leaf = reflected_note_leaf(&st.lp_asset, &c_comp).ok_or("unbond: lp-return leaf")?;
        let ret_ch = commitment_hash_compressed(&c_comp).ok_or("unbond: lp-return hash")?;
        self.fold_output(&ret_leaf, lp_return_path, lp_return_outpoint, &ret_ch, &st.lp_asset)?;
        st.unbond(shares, self.height);
        self.spent_root = new_spent_root;
        self.spent_count += 1;
        self.farm_rewards.update(farm_id, st);
        Ok(())
    }

    /// Onboard a minted LP-share note (Track B SHARE-SUPPLY provenance). TWO reasons: (1) CORRECTNESS —
    /// `fold_lp_remove` needs the burned LP-share to be a detected LIVE note; this is what puts it in the live
    /// set (without it, every LP-remove fails-closed). (2) BRIDGEABILITY — onboarding makes LP-shares (and
    /// protocol-fee claims, which mint LP-shares) bridgeable. The share's value MUST equal the legitimately
    /// minted `lp_shares` (the founder's `isqrt(Δa·Δb) − MINIMUM_LIQUIDITY` at POOL_INIT, or `lp_add_shares` at
    /// LP-add — the caller computes it from the pool's `total_shares` delta), bound by a reflection-WITNESSED
    /// blinding (`share_csecp` opens to `lp_shares`); without the bind an LP could over-claim the share
    /// commitment and bridge unbacked LP-shares. The asset is `amm_derive_lp_asset_id(pool_id)` (the Bitcoin
    /// LP-share asset). See ops/DESIGN-bridge-multiasset-provenance.md + task #18.
    pub fn fold_lp_share_mint(
        &mut self,
        pool_id: &[u8; 32],
        lp_shares: u64,
        share_csecp: &[u8; 33],
        share_r: &[u8; 32],
        share_path: &[[u8; 32]],
        share_outpoint: &[u8; 32],
    ) -> Result<(), &'static str> {
        if lp_shares == 0 {
            return Err("lp_share_mint: zero shares");
        }
        let share_pt = decompress(share_csecp).ok_or("lp_share_mint: share not a curve point")?;
        // The share note commits to EXACTLY the legitimately-minted shares (no over-claim → no unbacked bridge).
        if !verify_pedersen_opening(&share_pt, lp_shares, &scalar_reduce_be(share_r)) {
            return Err("lp_share_mint: share opening != minted shares");
        }
        let lp_asset = amm_derive_lp_asset_id(pool_id);
        let leaf = reflected_note_leaf(&lp_asset, share_csecp).ok_or("lp_share_mint: leaf")?;
        let ch = commitment_hash_compressed(share_csecp).ok_or("lp_share_mint: hash")?;
        self.fold_output(&leaf, share_path, share_outpoint, &ch, &lp_asset)
    }

    /// Record a bridge-out in the burn set: ν → destCommitment (witnessed UTXO insert). The spend
    /// itself is folded via `fold_spent`; this adds the bound destination so bridge_mint can mint
    /// only an explicitly-burned note, to exactly the declared destination.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_burn(
        &mut self,
        nu: &[u8; 32],
        dest_commitment: &[u8; 32],
        b_low_key: &[u8; 32],
        b_low_next: &[u8; 32],
        b_low_value: &[u8; 32],
        b_low_index: u64,
        b_low_path: &[[u8; 32]],
        b_new_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        self.burn_root = utxo_insert_transition(
            &self.burn_root, nu, dest_commitment, b_low_key, b_low_next, b_low_value,
            b_low_index, b_low_path, self.burn_count, b_new_path,
        ).ok_or("burn-set insert witness invalid")?;
        self.burn_count += 1;
        Ok(())
    }

    /// Fold an Ethereum→Bitcoin cross-out mint (`T_CROSSOUT_MINT`, opcode 0x65) into the pool — ONLY if
    /// the cross-out is a MEMBER of the eth-reflection crossOutSet (proven on finalized Ethereum; Mode B
    /// reverse reflection). The minted note's Bitcoin-side leaf is `leaf(asset, Cx, Cy, 0)` — exactly the
    /// `destCommitment` the ConfidentialPool records for a Bitcoin-destined burn (owner = the zero
    /// sentinel) — and membership binds `(claimId, BITCOIN, destCommitment, asset)` to the eth set, so a
    /// fabricated/unconfirmed mint is absent and folds NOTHING (no unbacked value, no worker trust).
    /// Mirrors `fold_cxfer`'s output append via `fold_output`. `vout` is the mint tx's
    /// confidential-output index (derived, not witnessed — a bogus outpoint would make the note's later
    /// real Bitcoin spend miss the live set).
    #[allow(clippy::too_many_arguments)]
    pub fn fold_crossout(
        &mut self,
        asset: &[u8; 32],
        claim_id: &[u8; 32],
        cx: &[u8; 32],
        cy: &[u8; 32],
        set_index: u64,
        set_path: &[[u8; 32]],
        crossout_set_root: &[u8; 32],
        crossout_txid: &[u8; 32],
        vout: u32,
        note_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        // The minted commitment must be a real secp256k1 point (else an unspendable junk note).
        from_affine_xy(cx, cy).ok_or("crossout fold: commitment not a curve point")?;
        // Bitcoin-side reflected leaf (owner = zero sentinel) = the contract's destCommitment for a
        // Bitcoin-destined cross-out; an owner!=0 eth record can't match the set below (fail-closed).
        let dest_commitment = leaf(asset, cx, cy, &[0u8; 32]);
        let co = eth_reflection::EthCrossOut {
            claim_id: *claim_id,
            dest_chain: eth_reflection::DEST_CHAIN_BITCOIN,
            dest_commitment,
            asset_id: *asset,
        };
        if !eth_reflection::eth_crossout_member(&co, set_index, set_path, crossout_set_root) {
            return Err("crossout fold: not an eth crossOutSet member");
        }
        // One-to-one (no ETH→BTC inflation) rests on the commitment-only nullifier: two mint txs for the same
        // crossOut leaf carry identical (Cx,Cy) → identical ν, so the fail-closed spent-set IMT admits only
        // one. A future nullifier-shape change (folding txid/outpoint, or a per-chain split) would break it —
        // keep ν a function of the commitment alone (see `nullifier`), or add a consumed-claimId gate here.
        let outpoint = outpoint_key(crossout_txid, vout);
        let ch = commitment_hash(cx, cy);
        self.fold_output(&dest_commitment, note_path, &outpoint, &ch, asset)
    }

    /// cBTC.zk sats-lock value-entry (`T_CBTC_LOCK`, opcode 0x66) — track a real-BTC lock only if the
    /// envelope tx contains, at `lock_vout`, a confirmed self-custody lock output (the locker's own output,
    /// any scriptPubKey) of nonzero value `v_btc`. The cBTC note is NOT minted here: this fold records the
    /// lock outpoint + value + pre-committed note commitment hash, and `OP_CBTC_MINT` later proves that the
    /// note opens to exactly `v_btc` before the pool inserts it. Fails closed (folds nothing) on any miss —
    /// same skip-not-panic discipline as `fold_cxfer` / `fold_crossout`. `tx_data` is the confirmed envelope
    /// tx (the caller verified inclusion + PoW via the full-scan). See ops/DESIGN-confidential-defi-v1.md §3.
    pub fn fold_cbtc_lock(
        &mut self,
        asset: &[u8; 32],
        cx: &[u8; 32],
        cy: &[u8; 32],
        tx_data: &[u8],
        lock_vout: u32,
        lock_txid: &[u8; 32],
    ) -> Result<CbtcLockFold, &'static str> {
        // Asset binding — only the one canonical cBTC.zk id (a fabricated etch can only name a
        // worthless made-up id, never the real allowlisted one).
        if asset != &CBTC_ZK_ASSET_ID {
            return Err("cbtc lock: not the cBTC.zk asset");
        }
        // The pre-committed cBTC note commitment must be a real secp256k1 point — skip a junk lock rather
        // than track an unmintable one (its `verify_pedersen_opening` would fail at OP_CBTC_MINT anyway).
        // Matches the JS mirror's `ptFromXY` gate so the guest + indexer digests never diverge on junk.
        from_affine_xy(cx, cy).ok_or("cbtc lock: commitment not a curve point")?;
        // The confirmed lock output: the LOCKER'S OWN output (self-custody, ANY scriptPubKey — no vault,
        // no custodial key) and its public value v_btc (objective Bitcoin data, proven by the confirmed tx).
        let (v_btc, _spk) =
            bitcoin::parse_tx_output(tx_data, lock_vout).ok_or("cbtc lock: no such output")?;
        if v_btc == 0 {
            return Err("cbtc lock: zero value");
        }
        // vout 0 is reserved disjoint from the historical note outpoint; a real lock is a later output.
        if lock_vout == 0 {
            return Err("cbtc lock: lock vout must not be 0");
        }
        let lock_outpoint = outpoint_key(lock_txid, lock_vout);
        // One lock backs one mint: a duplicate outpoint folds nothing (skip-not-panic).
        if self.cbtc_locks.get(&lock_outpoint).is_some() {
            return Err("cbtc lock: outpoint already tracked");
        }
        // TRACK, don't mint. Record the lock (outpoint → v_btc) + the backing total — both ride `digest()`,
        // so a resumed cycle can't forge the backing. The cBTC NOTE is NOT folded here: minting moves to
        // ConfidentialPool.mintCbtc (gated on this lock + a native-ETH escrow), where the value-opening
        // (note == v_btc, the conservation peg) is checked. The returned `commitment_hash` binds the
        // locker's pre-committed note so only that note can be minted against this lock (anti-griefing).
        let mut v32 = [0u8; 32];
        v32[24..].copy_from_slice(&v_btc.to_be_bytes());
        self.cbtc_locks.insert(&lock_outpoint, &v32, asset);
        self.cbtc_backing_sats = self.cbtc_backing_sats.saturating_add(v_btc);
        Ok(CbtcLockFold { outpoint: lock_outpoint, v_btc, commitment_hash: commitment_hash(cx, cy) })
    }

    /// Detect SELF-CUSTODY lock spends: scan a confirmed tx's inputs for any spending a tracked cBTC.zk
    /// lock outpoint; drop its sats from the backing, remove it from the live index, and RETURN the spent
    /// outpoint(s) for the per-cycle `cbtcLocksSpent` public-value array. The contract classifies rug vs.
    /// honest redemption (spent ∧ escrow-not-released ⇒ rug ⇒ slash). A lock spend is a plain Bitcoin
    /// spend — NO Tacit ν / opening (unlike a pool-note spend in `scan_tx_spends`).
    pub fn fold_cbtc_lock_spends(&mut self, tx_data: &[u8]) -> Vec<[u8; 32]> {
        let inputs = match bitcoin::extract_inputs(tx_data) {
            Some(i) => i,
            None => return Vec::new(),
        };
        let mut spent = Vec::new();
        for (txid, vout) in &inputs {
            let key = outpoint_key(txid, *vout);
            if let Some((vbytes, _asset)) = self.cbtc_locks.get(&key) {
                let v = u64::from_be_bytes(vbytes[24..].try_into().unwrap());
                self.cbtc_backing_sats = self.cbtc_backing_sats.saturating_sub(v);
                self.cbtc_locks.remove(&key);
                spent.push(key);
            }
        }
        spent
    }

    /// Single-tx Bitcoin-native cBTC REDEMPTION — the trustless rug-vs-redeem classifier (DESIGN-cbtc-
    /// redemption.md). The redeeming tx BOTH spends a tracked lock outpoint `O` AND burns exactly `v_btc` of
    /// cBTC in the SAME tx (`Σ C_in(cBTC) = v_btc·H`, no cBTC output — the audited `cxfer_kernel_verify`
    /// burn), so supply ↓ and backing ↓ together. The caller invokes this BEFORE `fold_cbtc_lock_spends`, so
    /// on success `O` leaves the live lock set here and the later spend-scan no longer sees it → it NEVER
    /// enters `cbtcLocksSpent` → an honest redeemer is never slashable. A rugger cannot spoof it: marking `O`
    /// redeemed REQUIRES actually burning `v_btc` of cBTC, which IS the honest retirement (a bare lock spend
    /// with no matching burn stays tracked and folds as a rug). `input_outpoints` / `input_commitments` are
    /// the tx's cBTC note spends (from the caller's `scan_tx_spends`, each already bound to its stored
    /// commitment + asset and nullified into the spent set); `kernel_sig` from the redeem envelope. Returns
    /// Ok(O) on a valid redeem; Err (skip-not-panic) leaves `O` tracked.
    pub fn fold_cbtc_redeem(
        &mut self,
        lock_txid: &[u8; 32],
        lock_vout: u32,
        v_btc: u64,
        tx_inputs: &[([u8; 32], u32)],
        input_outpoints: &[([u8; 32], u32)],
        input_commitments: &[Point],
        kernel_sig: &[u8; 64],
    ) -> Result<[u8; 32], &'static str> {
        if v_btc == 0 {
            return Err("cbtc redeem: zero value");
        }
        // The redeem MUST actually UNLOCK the lock in THIS tx (the single-tx atomic swap: the locker's lock
        // input + the holder's cBTC burn, co-signed). Without it a cBTC burn could name an arbitrary,
        // still-locked outpoint and drop it from backing — and, worse, mark it non-slashable so its owner
        // could later rug it undetected. Requiring the lock be a vin here binds the retirement to a real unlock.
        if !tx_inputs.iter().any(|(t, v)| t == lock_txid && *v == lock_vout) {
            return Err("cbtc redeem: lock not unlocked in this tx");
        }
        let lock_outpoint = outpoint_key(lock_txid, lock_vout);
        // The lock must be tracked at EXACTLY v_btc — the burn retires precisely this lock's backing (so a
        // redeem can't be diverted to under-retire a larger lock, nor to name an untracked/foreign outpoint).
        let (vbytes, _asset) =
            self.cbtc_locks.get(&lock_outpoint).ok_or("cbtc redeem: lock not tracked")?;
        if u64::from_be_bytes(vbytes[24..].try_into().unwrap()) != v_btc {
            return Err("cbtc redeem: lock value mismatch");
        }
        // Conservation: the cBTC inputs sum to EXACTLY v_btc, ALL BURNED (no cBTC output). Reuses the audited
        // BIP-340 kernel (`Σ C_in = burned·H + Σ C_out`, here Σ C_out = 0). The burn is public + kernel-bound
        // so it can't be understated (inputs < v_btc fails the kernel), and the asset is pinned to cBTC.zk —
        // each input was bound to its stored asset by scan_tx_spends, so a non-cBTC input can't be smuggled in.
        if !cxfer_kernel_verify(&CBTC_ZK_ASSET_ID, input_outpoints, input_commitments, &[], v_btc, kernel_sig)
        {
            return Err("cbtc redeem: burn conservation");
        }
        // Retire the lock: backing ↓ (lock unlocked to the redeemer) and supply ↓ (cBTC burned) by the same
        // v_btc, conserving `supply ≤ backing`. Removed from the live set so the spend-scan won't fold it as a rug.
        self.cbtc_backing_sats = self.cbtc_backing_sats.saturating_sub(v_btc);
        self.cbtc_locks.remove(&lock_outpoint);
        Ok(lock_outpoint)
    }
}

/// Farm reward accrual (SPEC-CONTROLLER-VAULT-AMENDMENT §4/§5) — the Bitcoin reflection's mirror of the
/// EVM `FarmController`. A per-farm reward-per-share accumulator that makes `LP_HARVEST` **trustless** — the
/// reward is proof-bound (`reward ≤ shares·(rps − rps_entry)`). The per-staker
/// checkpoint `(shares, rps_entry)` rides the `LP_BOND` receipt note; this holds only the GLOBAL
/// `rps`/`total_shares` (nothing per-owner). It accrues over Bitcoin block **HEIGHT** — the proof's own clock —
/// so the whole bound runs in-guest with NO contract seam (unlike EVM, where settle-time forces the bound
/// on-chain). `PRECISION ≥ max shares` (u64) so any `reward ≥ 1` advances the checkpoint (no sub-share
/// re-claim). `FARM_INIT` bounds `rate` so `rate·Δheight·PRECISION` fits the working width.
pub const FARM_RPS_PRECISION: u128 = 1 << 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FarmRewardState {
    pub rate: u64, // total reward units per block across the farm (fixed at FARM_INIT)
    pub total_shares: u64,
    pub rps: u128, // Σ rate·Δh·PRECISION / total_shares
    pub last_height: u64,
    pub launcher_pubkey: [u8; 33], // the farm launcher (committed in farm_id); gates T_FARM_REFUND auth
    pub lp_asset: [u8; 32], // amm_derive_lp_asset_id(pool_id) — the farm's bondable LP-share asset; a T_LP_BOND
    // must spend notes of THIS asset summing to its claimed shares (lp_bond_kernel_verify), so an attacker
    // can't credit unbacked shares and drain the treasury at harvest. Set at FARM_INIT from the envelope pool_id.
}

impl FarmRewardState {
    pub fn new(rate: u64, height: u64) -> Self {
        Self { rate, total_shares: 0, rps: 0, last_height: height, launcher_pubkey: [0u8; 33], lp_asset: [0u8; 32] }
    }

    /// Accrue the global reward-per-share for the elapsed blocks at the current rate.
    pub fn accrue(&mut self, height: u64) {
        if height > self.last_height {
            if self.total_shares != 0 {
                let dh = (height - self.last_height) as u128;
                // Saturating, NOT panicking: a pathologically large `rate` (a malicious/fat-fingered FARM_INIT)
                // or a long-elapsed `dh` must not overflow u128 and `.expect()`-panic INSIDE the reflection fold
                // — a panic is unprovable and permanently bricks the forward-only digest (fund-strand DoS). A
                // saturated rps only drives `harvest_ok` fail-closed (no over-reward); the JS mirror clamps the same.
                let inc = (self.rate as u128)
                    .saturating_mul(dh)
                    .saturating_mul(FARM_RPS_PRECISION)
                    / self.total_shares as u128;
                self.rps = self.rps.saturating_add(inc);
            }
            self.last_height = height;
        }
    }

    /// BOND: accrue, add shares, return the `rps_entry` the receipt must commit (== live rps; no backdating).
    pub fn bond(&mut self, shares: u64, height: u64) -> u128 {
        assert!(shares > 0, "farm bond zero shares");
        self.accrue(height);
        self.total_shares = self.total_shares.checked_add(shares).expect("farm total shares overflow");
        self.rps
    }

    /// HARVEST bound: accrue, then `reward·PRECISION ≤ shares·(rps − rps_entry)`. Fail-closed on overflow.
    pub fn harvest_ok(&mut self, shares: u64, rps_entry: u128, reward: u64, height: u64) -> bool {
        self.accrue(height);
        if rps_entry > self.rps {
            return false;
        }
        match (
            (reward as u128).checked_mul(FARM_RPS_PRECISION),
            (shares as u128).checked_mul(self.rps - rps_entry),
        ) {
            (Some(lhs), Some(rhs)) => lhs <= rhs,
            _ => false,
        }
    }

    /// UNBOND: accrue, remove shares.
    pub fn unbond(&mut self, shares: u64, height: u64) {
        assert!(shares > 0, "farm unbond zero shares");
        self.accrue(height);
        self.total_shares = self.total_shares.checked_sub(shares).expect("farm total shares underflow");
    }
}

/// The checkpoint the NEW receipt must commit after a harvest: advance by exactly the claim, so any
/// `reward ≥ 1` moves it (PRECISION ≥ shares) — closing the sub-share re-claim. Overflow is rejected so a
/// malformed witness cannot silently over-advance or wrap the receipt checkpoint.
pub fn farm_harvest_new_entry(shares: u64, rps_entry: u128, reward: u64) -> u128 {
    assert!(shares > 0, "farm harvest zero shares");
    let delta = (reward as u128)
        .checked_mul(FARM_RPS_PRECISION)
        .expect("farm harvest checkpoint overflow")
        / shares as u128;
    rps_entry.checked_add(delta).expect("farm harvest rps entry overflow")
}

/// Domain-separated leaf for a farm RECEIPT (SPEC-CONTROLLER-VAULT-AMENDMENT §4): a stake checkpoint
/// committing `(shares, rps_entry)` to `owner`. Disjoint from the note tree, the CDP-position tree, and the
/// adaptor lock-set, so a receipt is never spendable as a value note. Appended at bond, consumed + re-appended
/// (advanced checkpoint) at harvest, consumed at unbond.
pub fn farm_receipt_leaf(
    farm: &[u8; 32],
    shares: u64,
    rps_entry: u128,
    owner: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    kn(&[
        b"tacit-farm-receipt-v1",
        farm,
        &shares.to_le_bytes(),
        &rps_entry.to_le_bytes(),
        owner,
        nonce,
    ])
}

/// Spend-once nullifier for a farm receipt leaf — domain-separated (`tacit-farm-receipt-null-v1`) from
/// value-note nullifiers, so a receipt can never be spent as a note (or vice-versa). Shared verbatim by the
/// Bitcoin reflection folds and the EVM settle guest's OP_FARM_HARVEST/UNBOND, so the receipt is byte-identical
/// across chains (SPEC-CONTROLLER-VAULT-AMENDMENT §5).
pub fn farm_receipt_nullifier(leaf: &[u8; 32]) -> [u8; 32] {
    kn(&[b"tacit-farm-receipt-null-v1", leaf])
}

/// Verify a farm harvest, returning `(old_leaf, old_nullifier, new_leaf)`. The guest proves `old_leaf`
/// membership in the receipt set, marks `old_nullifier` spent (spend-once), appends `new_leaf`, and mints
/// `reward` of the reward asset. The reward is bounded to real accrual (`harvest_ok`) and the new receipt's
/// checkpoint advances by exactly the claim — so this is the same forge-resistance as the EVM path, with the
/// `rps` read from the in-proof `FarmRewardState`. Fail-closed: `None` on over-claim.
pub fn verify_farm_harvest(
    farm: &[u8; 32],
    state: &mut FarmRewardState,
    height: u64,
    shares: u64,
    rps_entry: u128,
    owner: &[u8; 32],
    old_nonce: &[u8; 32],
    new_nonce: &[u8; 32],
    reward: u64,
) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
    if !state.harvest_ok(shares, rps_entry, reward, height) {
        return None;
    }
    let old_leaf = farm_receipt_leaf(farm, shares, rps_entry, owner, old_nonce);
    let old_nullifier = farm_receipt_nullifier(&old_leaf);
    let new_entry = farm_harvest_new_entry(shares, rps_entry, reward);
    let new_leaf = farm_receipt_leaf(farm, shares, new_entry, owner, new_nonce);
    Some((old_leaf, old_nullifier, new_leaf))
}

/// Witnessed map `farm_id → FarmRewardState` (mirrors `PoolReserveSet`) — the reflection's per-farm
/// reward-per-share registry. Its `root()` is committed in `ScanReflection::digest()` so a resumed cycle
/// cannot forge a farm's `rps` / `total_shares` (which would let an over-reward harvest pass). Entries are
/// strictly ascending by `farm_id`.
#[derive(Clone, Default)]
pub struct FarmRewardSet {
    entries: Vec<([u8; 32], FarmRewardState)>,
}

impl FarmRewardSet {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    pub fn from_sorted(entries: Vec<([u8; 32], FarmRewardState)>) -> Option<Self> {
        for i in 0..entries.len() {
            if entries[i].0 == [0u8; 32] {
                return None;
            }
            if i > 0 && !be_lt(&entries[i - 1].0, &entries[i].0) {
                return None;
            }
        }
        Some(Self { entries })
    }

    pub fn get(&self, farm_id: &[u8; 32]) -> Option<FarmRewardState> {
        self.entries.binary_search_by(|(k, _)| k.cmp(farm_id)).ok().map(|i| self.entries[i].1)
    }

    pub fn insert(&mut self, farm_id: &[u8; 32], state: FarmRewardState) {
        match self.entries.binary_search_by(|(k, _)| k.cmp(farm_id)) {
            Ok(_) => panic!("duplicate farm in reward set"),
            Err(i) => self.entries.insert(i, (*farm_id, state)),
        }
    }

    pub fn update(&mut self, farm_id: &[u8; 32], state: FarmRewardState) {
        let i = self.entries.binary_search_by(|(k, _)| k.cmp(farm_id)).expect("farm not in reward set");
        self.entries[i].1 = state;
    }

    /// Committed root: Keccak-Merkle over `(farm_id ‖ rate ‖ total_shares ‖ rps ‖ last_height)` in farm_id
    /// order — every field pinned so a resumed handoff can't forge an accrual.
    pub fn root(&self) -> [u8; 32] {
        let u64b = |n: u64| {
            let mut a = [0u8; 32];
            a[24..].copy_from_slice(&n.to_be_bytes());
            a
        };
        let u128b = |n: u128| {
            let mut a = [0u8; 32];
            a[16..].copy_from_slice(&n.to_be_bytes());
            a
        };
        let leaves: Vec<[u8; 32]> = self
            .entries
            .iter()
            .map(|(k, s)| kn(&[k, &u64b(s.rate), &u64b(s.total_shares), &u128b(s.rps), &u64b(s.last_height), &s.launcher_pubkey, &s.lp_asset]))
            .collect();
        keccak_merkle_root(&leaves)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(h: &str) -> &str { h.trim_start_matches("0x") }
    fn arr33(h: &str) -> [u8; 33] { let v = hex::decode(strip(h)).unwrap(); let mut a = [0u8; 33]; a.copy_from_slice(&v); a }
    fn arr32(h: &str) -> [u8; 32] { let v = hex::decode(strip(h)).unwrap(); let mut a = [0u8; 32]; a.copy_from_slice(&v); a }
    fn pt(h: &str) -> ProjectivePoint { decompress(&arr33(h)).unwrap() }
    fn u64_be32(n: u64) -> [u8; 32] { let mut a = [0u8; 32]; a[24..].copy_from_slice(&n.to_be_bytes()); a }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../fixtures/cxfer.json")).unwrap()
    }

    // SPEC-CONTROLLER-VAULT-AMENDMENT §4/§5: the Bitcoin reflection's farm accumulator gives proportional,
    // trustless rewards over height, and rejects every forge — byte-for-byte the EVM FarmController's behavior.
    #[test]
    fn farm_reward_state_proportional_and_forge_proof() {
        // proportional split + exact cap
        let mut f = FarmRewardState::new(100, 0); // 100 reward units/block
        let ea = f.bond(100, 0); // alice
        let eb = f.bond(300, 0); // bob; total_shares = 400
        assert_eq!(ea, 0);
        assert_eq!(eb, 0);
        // 10 blocks → pool emits 100*10 = 1000; alice = 100/400 = 250, bob = 300/400 = 750
        assert!(!f.harvest_ok(100, ea, 251, 10), "alice over-claim rejected");
        assert!(f.harvest_ok(100, ea, 250, 10), "alice exact accrual");
        assert!(!f.harvest_ok(300, eb, 751, 10), "bob over-claim rejected");
        assert!(f.harvest_ok(300, eb, 750, 10), "bob proportional");

        // checkpoint advances even for reward=1 → no re-claim of the same accrual
        let mut g = FarmRewardState::new(100, 0);
        let e = g.bond(100, 0); // sole staker; 10 blocks → accrual 1000
        assert!(g.harvest_ok(100, e, 1, 10));
        let e_adv = farm_harvest_new_entry(100, e, 1);
        assert!(e_adv > e, "checkpoint advances for reward = 1");
        assert!(!g.harvest_ok(100, e_adv, 1000, 10), "cannot re-claim the full 1000 from the advanced checkpoint");
        assert!(g.harvest_ok(100, e_adv, 999, 10), "only the remainder");

        // no reward without new blocks (no double-claim)
        let mut h = FarmRewardState::new(100, 0);
        let eh = h.bond(100, 0);
        assert!(h.harvest_ok(100, eh, 1000, 10));
        let e_full = farm_harvest_new_entry(100, eh, 1000);
        assert!(!h.harvest_ok(100, e_full, 1, 10), "no double-claim without new height");

        // no backdating: a staker bonding after dilution earns from now, not genesis
        let mut k = FarmRewardState::new(100, 0);
        let _ = k.bond(100, 0);
        let late = k.bond(300, 10); // bonds at height 10 (after alice accrued)
        assert!(late > 0, "late bond's rps_entry is the live rps, not 0");
        assert!(!k.harvest_ok(300, late, 1, 10), "late bonder can't claim pre-bond rewards");

        // verify_farm_harvest ties the bound to the shielded receipt: a valid harvest advances the receipt
        // checkpoint (new_leaf != old_leaf); an over-claim folds nothing.
        let farm = [0x7fu8; 32];
        let owner = [0xa1u8; 32];
        let (on, nn) = ([1u8; 32], [2u8; 32]);
        let mut s = FarmRewardState::new(100, 0);
        let entry = s.bond(100, 0);
        let (old_leaf, old_null, new_leaf) =
            verify_farm_harvest(&farm, &mut s, 10, 100, entry, &owner, &on, &nn, 250).expect("valid harvest");
        assert_eq!(old_leaf, farm_receipt_leaf(&farm, 100, entry, &owner, &on));
        assert_ne!(new_leaf, old_leaf, "checkpoint advanced ⇒ a fresh receipt leaf");
        assert_ne!(old_null, [0u8; 32]);
        let mut s2 = FarmRewardState::new(100, 0);
        let e2 = s2.bond(100, 0);
        assert!(verify_farm_harvest(&farm, &mut s2, 10, 100, e2, &owner, &on, &nn, 1001).is_none(), "over-claim folds nothing");
    }

    // SPEC-CONTROLLER-VAULT-AMENDMENT §8.4 (solid-ground gate ①): the full fold lifecycle the reflection's
    // fold_lp_bond / fold_lp_unbond / rewired fold_harvest will run — proven end-to-end against an in-test
    // receipt set + spent set, so the live ScanReflection wiring is mechanical against verified logic.
    #[test]
    fn farm_full_lifecycle_bond_harvest_unbond() {
        use std::collections::HashSet;
        let farm = [0x33u8; 32];
        let alice = [0xa1u8; 32];
        let bob = [0xb0u8; 32];
        let mut state = FarmRewardState::new(100, 0); // 100 reward units/block
        let mut receipts: HashSet<[u8; 32]> = HashSet::new(); // the receipt set (membership)
        let mut spent: HashSet<[u8; 32]> = HashSet::new(); // nullified receipts (spend-once)
        let mut minted: u64 = 0;

        // bond: append a receipt per staker; track total_shares
        let a_entry = state.bond(100, 0);
        let a_nonce = [1u8; 32];
        receipts.insert(farm_receipt_leaf(&farm, 100, a_entry, &alice, &a_nonce));
        let b_entry = state.bond(300, 0);
        let b_nonce = [1u8; 32];
        receipts.insert(farm_receipt_leaf(&farm, 300, b_entry, &bob, &b_nonce));
        assert_eq!(state.total_shares, 400);

        // 10 blocks → 1000 emitted; alice = 100/400 = 250
        let (a_old, a_null, a_new) =
            verify_farm_harvest(&farm, &mut state, 10, 100, a_entry, &alice, &a_nonce, &[2u8; 32], 250)
                .expect("alice harvest");
        assert!(receipts.contains(&a_old) && !spent.contains(&a_null), "old receipt member + unspent");
        spent.insert(a_null);
        receipts.remove(&a_old);
        receipts.insert(a_new);
        minted += 250;

        // double-harvest the SAME receipt is blocked: verify recomputes the same nullifier, already spent
        let (a_old2, a_null2, _) =
            verify_farm_harvest(&farm, &mut state, 10, 100, a_entry, &alice, &a_nonce, &[3u8; 32], 1)
                .expect("recompute leaf");
        assert_eq!(a_old2, a_old);
        assert!(spent.contains(&a_null2), "double-harvest blocked by the spent nullifier");

        // bob = 300/400 = 750
        let (b_old, b_null, b_new) =
            verify_farm_harvest(&farm, &mut state, 10, 300, b_entry, &bob, &b_nonce, &[2u8; 32], 750)
                .expect("bob harvest");
        spent.insert(b_null);
        receipts.remove(&b_old);
        receipts.insert(b_new);
        minted += 750;

        // conservation: total rewards == the emission, never more
        assert_eq!(minted, 1000, "Σ rewards == rate·blocks");
        assert!((minted as u128) <= 100u128 * 10, "no over-emission");

        // unbond alice: consume her receipt, decrement shares
        receipts.remove(&a_new);
        state.unbond(100, 10);
        assert_eq!(state.total_shares, 300);
    }

    // SPEC-CONTROLLER-VAULT-AMENDMENT §4/§8.4 gate ①: the trustless farm folds against the LIVE
    // ScanReflection trees — fold_farm_init_rewards → fold_lp_bond (appends the owner-blinded RECEIPT note) →
    // fold_lp_harvest (bounds reward vs the live rps, nullifies the old receipt, appends the advanced one)
    // → fold_lp_unbond — with REAL witnessed note-tree + spent-set transitions, kept in lockstep with reference
    // accumulators. No per-bond global state: the receipt rides the note tree, so this is parity with the EVM
    // position-tree receipt. Covers the forge-resistance the bound + membership give.
    #[test]
    fn scan_reflection_farm_folds() {
        // The spent-set witness for a receipt nullifier (the spent-set half of build_spend_witness — receipts
        // are not live UTXOs, so there is no UTXO leg). Mirrors what the indexer hands the prover.
        fn receipt_spend_w(
            spent: &ImtAccumulator,
            null: &[u8; 32],
        ) -> ([u8; 32], [u8; 32], u64, Vec<[u8; 32]>, Vec<[u8; 32]>) {
            let leaves: Vec<[u8; 32]> = spent.links().iter().map(|(v, n)| imt_leaf(v, n)).collect();
            let (low_i, low_v, low_n) = spent.non_membership_low(null).expect("spent low");
            let s_low_path = merkle_path(&leaves, low_i as u64);
            let mut interm = leaves.clone();
            interm[low_i] = imt_leaf(&low_v, null);
            let s_new_path = merkle_path(&interm, leaves.len() as u64);
            (low_v, low_n, low_i as u64, s_low_path, s_new_path)
        }
        let null_of = farm_receipt_nullifier;

        let mut sc = ScanReflection::genesis();
        // Reference accumulators kept byte-for-byte in lockstep with sc.pool_root / sc.spent_root.
        let mut notes = KeccakTreeAccumulator::new();
        let mut hist: Vec<[u8; 32]> = Vec::new();
        let mut spent = ImtAccumulator::new();
        assert_eq!(sc.pool_root, notes.root());
        assert_eq!(sc.spent_root, spent.root());

        let farm = [0x44u8; 32];
        // The receipt owner is a ONE-TIME x-only pubkey (fresh per position — unlinkable yet signable). The
        // harvest/unbond SPEND is gated by a BIP-340 sig under it (the public preimage gates membership only).
        let a_d = [0xa1u8; 32];
        let b_d = [0xb1u8; 32];
        let m_d = [0xc1u8; 32];
        let alice = bip340_sign(&a_d, &[0xa0u8; 32], &[0u8; 32]).0;
        let bob = bip340_sign(&b_d, &[0xb0u8; 32], &[0u8; 32]).0;
        let mallory = bip340_sign(&m_d, &[0xc0u8; 32], &[0u8; 32]).0;
        let rrew = [0xddu8; 32]; // the fixed reward_r the harvest sig binds (the note blinding)
        let reward_spk = b"reward-destination-spk";
        let return_spk = b"lp-return-destination-spk";
        let h_sig = |d: &[u8; 32], k: &[u8; 32], leaf: &[u8; 32], reward: u64| -> [u8; 64] {
            bip340_sign(d, k, &lp_harvest_owner_msg(&farm, leaf, reward, &rrew, reward_spk)).1
        };
        sc.fold_farm_init_rewards(&farm, 100, &[2u8; 33], &[0x50u8; 32]).expect("register farm rewards");
        assert!(sc.fold_farm_init_rewards(&farm, 100, &[2u8; 33], &[0x50u8; 32]).is_err(), "no double-register");

        // ── BOND: append a receipt per staker; total_shares tracks the public bonded weight ──
        let a_nonce = [0x01u8; 32];
        let a_leaf = sc.fold_lp_bond(&farm, 100, &alice, &a_nonce, &notes.append_path()).expect("alice bond");
        notes.append(&a_leaf);
        hist.push(a_leaf);
        let b_nonce = [0x01u8; 32];
        let b_leaf = sc.fold_lp_bond(&farm, 300, &bob, &b_nonce, &notes.append_path()).expect("bob bond");
        notes.append(&b_leaf);
        hist.push(b_leaf);
        assert_eq!(sc.pool_root, notes.root(), "note tree in lockstep after the bonds");
        assert_eq!(sc.farm_rewards.get(&farm).unwrap().total_shares, 400);
        let a_entry = 0u128; // rps at bond (height 0) — committed by the fold, not the staker
        // a bond with a bad append path folds nothing (atomic — no half-apply)
        assert!(sc.fold_lp_bond(&farm, 1, &alice, &[0x09u8; 32], &merkle_path(&[], 99)).is_err(), "bad append path");

        // ── HARVEST alice at height 10: 1000 emitted; alice = 100/400 = 250 ──
        sc.height = 10;
        let a_new_nonce = [0x02u8; 32];
        let a_null = null_of(&a_leaf);
        let (lv, ln, li, lp, snp) = receipt_spend_w(&spent, &a_null);
        let a_mem = merkle_path(&hist, 0);
        let a_np = notes.append_path();
        // over-claim 251 rejected (bound fails BEFORE any state mutates — atomic, so the same witnesses still work)
        assert!(
            sc.fold_lp_harvest(&farm, 100, a_entry, &alice, &a_nonce, &a_new_nonce, 251, 0, &a_mem, &lv, &ln, li, &lp, &snp, &a_np, &rrew, reward_spk, &h_sig(&a_d, &[0x31u8; 32], &a_leaf, 251)).is_err(),
            "over-claim rejected"
        );
        // a FORGED receipt — valid (shares, entry) that passes the bound but was NEVER bonded → not in the note
        // tree. This is the soundness crux: the bound alone is not enough; membership is what ties the claim to a
        // real bond. (Claims against alice's slot/path with a leaf the path doesn't commit.)
        let m_nonce = [0x07u8; 32];
        let m_leaf = farm_receipt_leaf(&farm, 100, 0u128, &mallory, &m_nonce);
        let m_null = null_of(&m_leaf);
        let (mlv, mln, mli, mlp, msnp) = receipt_spend_w(&spent, &m_null);
        assert!(
            sc.fold_lp_harvest(&farm, 100, 0u128, &mallory, &m_nonce, &[0x08u8; 32], 100, 0, &a_mem, &mlv, &mln, mli, &mlp, &msnp, &a_np, &rrew, reward_spk, &h_sig(&m_d, &[0x32u8; 32], &m_leaf, 100)).is_err(),
            "forged receipt not in the note tree"
        );
        // FRONT-RUN DEFENSE (the dest-binding regression test): alice signs over her real receipt + HER reward
        // destination (reward_spk), but a mempool front-runner replays the verbatim public envelope into a
        // DIFFERENT vout[1] (attacker_spk). The owner_msg the guest verifies binds the destination, so the
        // replay's sig no longer matches → fold rejects (atomic, no state mutation) and the bearer reward note
        // can't be materialized at the attacker's UTXO. Without dest binding this redirect succeeded = theft.
        let attacker_spk = b"attacker-controlled-vout1-spk";
        assert!(
            sc.fold_lp_harvest(&farm, 100, a_entry, &alice, &a_nonce, &a_new_nonce, 250, 0, &a_mem, &lv, &ln, li, &lp, &snp, &a_np, &rrew, attacker_spk, &h_sig(&a_d, &[0x3au8; 32], &a_leaf, 250)).is_err(),
            "harvest reward redirected to an attacker vout[1] must reject (destination binding)"
        );
        // exact accrual accepted (alice owner-signs over her real receipt leaf + the reward output)
        sc.fold_lp_harvest(&farm, 100, a_entry, &alice, &a_nonce, &a_new_nonce, 250, 0, &a_mem, &lv, &ln, li, &lp, &snp, &a_np, &rrew, reward_spk, &h_sig(&a_d, &[0x33u8; 32], &a_leaf, 250)).expect("alice harvest 250");
        spent.insert(&a_null);
        let a_new_entry = farm_harvest_new_entry(100, a_entry, 250);
        let a_new_leaf = farm_receipt_leaf(&farm, 100, a_new_entry, &alice, &a_new_nonce);
        notes.append(&a_new_leaf);
        hist.push(a_new_leaf);
        assert_eq!(sc.pool_root, notes.root(), "note tree in lockstep after the harvest append");
        assert_eq!(sc.spent_root, spent.root(), "spent set in lockstep after the receipt nullifier");
        assert!(spent.non_membership_low(&a_null).is_none(), "old receipt spent-once: nullifier now a member");
        // FEATURE: harvest does NOT touch the bonded weight — alice's principal is STILL staked (parity with the
        // EVM FarmController, whose harvest branch never writes totalShares; only bond/unbond do).
        assert_eq!(sc.farm_rewards.get(&farm).unwrap().total_shares, 400, "principal still staked after harvest");

        // immediate re-harvest of the advanced receipt earns nothing (rps hasn't moved since)
        let a_null2 = null_of(&a_new_leaf);
        let (lv2, ln2, li2, lp2, snp2) = receipt_spend_w(&spent, &a_null2);
        assert!(
            sc.fold_lp_harvest(&farm, 100, a_new_entry, &alice, &a_new_nonce, &[0x03u8; 32], 1, 2, &merkle_path(&hist, 2), &lv2, &ln2, li2, &lp2, &snp2, &notes.append_path(), &rrew, reward_spk, &h_sig(&a_d, &[0x34u8; 32], &a_new_leaf, 1)).is_err(),
            "immediate re-harvest earns nothing"
        );
        // an unknown farm folds nothing (same advanced-receipt witnesses; the failed attempts mutated nothing)
        assert!(
            sc.fold_lp_harvest(&[0x99u8; 32], 100, a_new_entry, &alice, &a_new_nonce, &[0x04u8; 32], 1, 2, &merkle_path(&hist, 2), &lv2, &ln2, li2, &lp2, &snp2, &notes.append_path(), &rrew, reward_spk, &h_sig(&a_d, &[0x35u8; 32], &a_new_leaf, 1)).is_err(),
            "unknown farm rejected"
        );
        // FEATURE: REPEATED harvest while staying staked — 10 more blocks accrue, alice harvests her advanced
        // receipt AGAIN for her next 250 (blocks 10–20). total_shares is untouched throughout: bond once, harvest
        // many. This is the "claim rewards, keep the principal staked" semantics on the Bitcoin side.
        sc.height = 20;
        let a_np2 = notes.append_path();
        sc.fold_lp_harvest(&farm, 100, a_new_entry, &alice, &a_new_nonce, &[0x05u8; 32], 250, 2, &merkle_path(&hist, 2), &lv2, &ln2, li2, &lp2, &snp2, &a_np2, &rrew, reward_spk, &h_sig(&a_d, &[0x36u8; 32], &a_new_leaf, 250)).expect("alice second harvest 250");
        spent.insert(&a_null2);
        let a_entry3 = farm_harvest_new_entry(100, a_new_entry, 250);
        notes.append(&farm_receipt_leaf(&farm, 100, a_entry3, &alice, &[0x05u8; 32]));
        hist.push(farm_receipt_leaf(&farm, 100, a_entry3, &alice, &[0x05u8; 32]));
        assert_eq!(sc.farm_rewards.get(&farm).unwrap().total_shares, 400, "principal STILL staked after the 2nd harvest");
        assert_eq!(sc.pool_root, notes.root(), "note tree in lockstep after the 2nd harvest");

        // ── UNBOND bob: prove his receipt, nullify it, drop his shares, re-mint his LP-shares (owner-signed) ──
        let b_null = null_of(&b_leaf);
        let (blv, bln, bli, blp, bsnp) = receipt_spend_w(&spent, &b_null);
        let blr = [0xfbu8; 32]; // bob's lp-return blinding + outpoint, bound by his unbond sig
        let bout = [0xfcu8; 32];
        let b_lp_path = notes.append_path();
        let bsig = bip340_sign(&b_d, &[0xb2u8; 32], &lp_unbond_owner_msg(&farm, &b_leaf, 300, &blr, return_spk)).1;
        // FRONT-RUN DEFENSE (dest binding, unbond leg): bob signs over return_spk, but a front-runner replays
        // the public envelope into their OWN vout[1] (attacker_spk2). The dest-bound owner_msg makes bob's sig
        // fail → the re-minted LP-share principal can't be redirected (atomic reject, no state mutation).
        let attacker_spk2 = b"attacker-controlled-unbond-vout1-spk";
        assert!(
            sc.fold_lp_unbond(&farm, 300, 0u128, &bob, &b_nonce, 1, &merkle_path(&hist, 1), &blv, &bln, bli, &blp, &bsnp, &blr, &bout, &b_lp_path, attacker_spk2, &bsig).is_err(),
            "unbond principal redirected to an attacker vout[1] must reject (destination binding)"
        );
        sc.fold_lp_unbond(&farm, 300, 0u128, &bob, &b_nonce, 1, &merkle_path(&hist, 1), &blv, &bln, bli, &blp, &bsnp, &blr, &bout, &b_lp_path, return_spk, &bsig).expect("bob unbond");
        spent.insert(&b_null);
        assert_eq!(sc.farm_rewards.get(&farm).unwrap().total_shares, 100, "bob's shares dropped");
        assert_eq!(sc.spent_root, spent.root(), "spent set in lockstep after the unbond nullifier");
        assert!(spent.non_membership_low(&b_null).is_none(), "bob's receipt spent-once");
    }

    // SPEC-BITCOIN-HOOK-AMENDMENT §1.4: a value-free Bitcoin call envelope (0x68) parses, its BIP-340 sig
    // verifies, and fold_btc_call returns the (callId, recordHash) the ConfidentialPool / BtcCallExecutor
    // expect. A tampered sig or rebound field folds nothing (skip-not-panic).
    #[test]
    fn btc_call_envelope_folds_and_binds() {
        let executor = [0x99u8; 20];
        let target = [0x11u8; 20];
        let calldata_hash = [0x22u8; 32];
        let call_nonce = [0x33u8; 32];
        let d_seed = [0x44u8; 32];
        let k_seed = [0x55u8; 32];
        let (pubkey_x, _) = bip340_sign(&d_seed, &k_seed, &[0u8; 32]); // derive the signer pubkey first
        let msg = kn(&[b"tacit-btc-call-v1", &executor, &target, &calldata_hash, &pubkey_x, &call_nonce]);
        let (pubkey_x2, sig) = bip340_sign(&d_seed, &k_seed, &msg);
        assert_eq!(pubkey_x, pubkey_x2, "pubkey is deterministic in d_seed");

        let mut env = vec![0x68u8];
        env.extend_from_slice(&executor);
        env.extend_from_slice(&target);
        env.extend_from_slice(&calldata_hash);
        env.extend_from_slice(&pubkey_x);
        env.extend_from_slice(&call_nonce);
        env.extend_from_slice(&sig);
        assert_eq!(env.len(), 201, "fixed envelope length");

        let parsed = bitcoin::parse_btc_call_envelope(&env).expect("parse");
        let (call_id, record_hash) = fold_btc_call(&parsed).expect("valid sig folds");
        assert_eq!(call_id, kn(&[&pubkey_x, &call_nonce]), "callId = keccak(pubkey ‖ nonce)");
        // recordHash must equal the executor's keccak(abi.encodePacked(address(this), target, calldataHash, callerPubkey))
        assert_eq!(record_hash, kn(&[&executor, &target, &calldata_hash, &pubkey_x]), "recordHash binding");

        // a tampered signature folds nothing
        let mut bad_sig = env.clone();
        bad_sig[200] ^= 1;
        assert!(
            bitcoin::parse_btc_call_envelope(&bad_sig).and_then(|c| fold_btc_call(&c)).is_none(),
            "a bad sig folds nothing"
        );
        // a swapped executor breaks the signed binding → folds nothing (no cross-deployment replay)
        let mut bad_exec = env.clone();
        bad_exec[1] ^= 1;
        assert!(
            bitcoin::parse_btc_call_envelope(&bad_exec).and_then(|c| fold_btc_call(&c)).is_none(),
            "a swapped executor breaks the binding"
        );
        // a swapped target (now at offset 21) also breaks the binding
        let mut bad_target = env.clone();
        bad_target[21] ^= 1;
        assert!(
            bitcoin::parse_btc_call_envelope(&bad_target).and_then(|c| fold_btc_call(&c)).is_none(),
            "a swapped target breaks the binding"
        );
    }

    // Mode B: fold_crossout admits a Bitcoin cross-out mint ONLY if it's a member of the eth-reflection
    // crossOutSet; a fabricated mint (absent from the set) folds nothing.
    #[test]
    fn fold_crossout_gates_on_eth_set_membership() {
        use crate::eth_reflection::{eth_crossout_leaf, EthCrossOut, DEST_CHAIN_BITCOIN};
        // a real secp256k1 point for the minted note commitment
        let enc = gen_h().to_affine().to_encoded_point(false);
        let b = enc.as_bytes();
        let cx: [u8; 32] = b[1..33].try_into().unwrap();
        let cy: [u8; 32] = b[33..65].try_into().unwrap();
        let asset = [0x11u8; 32];
        let claim_id = [0x22u8; 32];
        let txid = [0x33u8; 32];
        // the eth-set leaf the eth-reflection guest commits for this Bitcoin-destined cross-out
        let dest_commitment = leaf(&asset, &cx, &cy, &[0u8; 32]);
        let co = EthCrossOut { claim_id, dest_chain: DEST_CHAIN_BITCOIN, dest_commitment, asset_id: asset };
        let set_root = keccak_merkle_root(&[eth_crossout_leaf(&co)]);
        let empty_path = KeccakTreeAccumulator::new().append_path(); // index-0 membership AND genesis note append

        // member → folds (note appended)
        let mut st = ScanReflection::genesis();
        st.fold_crossout(&asset, &claim_id, &cx, &cy, 0, &empty_path, &set_root, &txid, 0, &empty_path)
            .expect("member cross-out folds");
        assert_eq!(st.note_count, 1, "minted note appended on member");

        // non-member (wrong set root) → rejected, nothing folded
        let mut st2 = ScanReflection::genesis();
        assert!(
            st2.fold_crossout(&asset, &claim_id, &cx, &cy, 0, &empty_path, &[0xdeu8; 32], &txid, 0, &empty_path).is_err(),
            "non-member cross-out rejected"
        );
        assert_eq!(st2.note_count, 0, "nothing folded on reject");
    }

    /// cBTC.zk sats-lock value-entry: the reflection tracks ONLY a confirmed, nonzero self-custody lock
    /// output and the locker's pre-committed note hash; the value-opening note==v_btc check happens in
    /// OP_CBTC_MINT. Wrong asset / zero value / duplicate / vout-0 each fold nothing, while ANY scriptPubKey
    /// is accepted (self-custody — no vault check).
    #[test]
    fn fold_cbtc_lock_admits_backed_mint_rejects_tampering() {
        // a minimal non-segwit tx whose output[lock_vout] = (value, spk)
        fn tx_with_lock(value: u64, spk: &[u8], lock_vout: u32) -> Vec<u8> {
            let mut t = vec![0x02u8, 0, 0, 0]; // version
            t.push(0x01); // 1 input
            t.extend_from_slice(&[0u8; 32]); // prev txid
            t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // prev vout
            t.push(0x00); // empty scriptSig
            t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
            t.push((lock_vout + 1) as u8); // output count
            for i in 0..=lock_vout {
                if i == lock_vout {
                    t.extend_from_slice(&value.to_le_bytes());
                    t.push(spk.len() as u8);
                    t.extend_from_slice(spk);
                } else {
                    t.extend_from_slice(&0u64.to_le_bytes());
                    t.push(0x00);
                }
            }
            t.extend_from_slice(&[0, 0, 0, 0]); // locktime
            t
        }

        let v_btc: u64 = 100_000;
        let asset = CBTC_ZK_ASSET_ID;
        let lock_txid = [0x33u8; 32];
        let lock_vout: u32 = 1;
        // the locker's pre-committed cBTC note commitment (a real point; reflection only binds its hash —
        // the value-opening note==v_btc is the contract's mintCbtc check, not the reflection's).
        let gamma = scalar_reduce_be(&[0x44u8; 32]);
        let c = gen_h() * Scalar::from(v_btc) + ProjectivePoint::generator() * gamma;
        let cb = c.to_affine().to_encoded_point(false);
        let cx: [u8; 32] = cb.as_bytes()[1..33].try_into().unwrap();
        let cy: [u8; 32] = cb.as_bytes()[33..65].try_into().unwrap();
        // self-custody: the lock pays the locker's OWN output — any P2TR-shaped SPK works (no vault check).
        let lock_spk: &[u8] = &[
            0x51, 0x20, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb,
            0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb,
            0xcb, 0xcb,
        ];
        let expect_outpoint = outpoint_key(&lock_txid, lock_vout);

        // TRACK-not-mint: a backed lock folds (returns the delta), accrues the backing, mints NO note.
        let tx = tx_with_lock(v_btc, lock_spk, lock_vout);
        let mut st = ScanReflection::genesis();
        let f = st.fold_cbtc_lock(&asset, &cx, &cy, &tx, lock_vout, &lock_txid)
            .expect("a backed cBTC lock tracks");
        assert_eq!(f, CbtcLockFold { outpoint: expect_outpoint, v_btc, commitment_hash: commitment_hash(&cx, &cy) }, "fold delta surfaces (outpoint, v_btc, commitment)");
        assert_eq!(st.note_count, 0, "track-not-mint: reflection mints NO cBTC note (the contract does)");
        assert_eq!(st.cbtc_backing_sats, v_btc, "backing accrued the locked sats");

        // duplicate outpoint → folds nothing (one lock backs one mint)
        assert!(st.fold_cbtc_lock(&asset, &cx, &cy, &tx, lock_vout, &lock_txid).is_err(), "duplicate lock rejected");

        // RUG: a later tx spends the self-custody lock outpoint → backing drops + the spent outpoint surfaces
        let mut spend_tx: Vec<u8> = vec![0x02, 0, 0, 0, 0x01]; // version + 1 input
        spend_tx.extend_from_slice(&lock_txid);
        spend_tx.extend_from_slice(&lock_vout.to_le_bytes());
        spend_tx.extend_from_slice(&[0x00, 0xff, 0xff, 0xff, 0xff]); // empty scriptSig + sequence
        spend_tx.extend_from_slice(&[0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0, 0, 0, 0]); // 1 dummy output + locktime
        assert_eq!(st.fold_cbtc_lock_spends(&spend_tx), vec![expect_outpoint], "the rug surfaces the spent lock outpoint");
        assert_eq!(st.cbtc_backing_sats, 0, "backing dropped to 0 after the rug");

        // wrong asset → reject
        let mut st2 = ScanReflection::genesis();
        assert!(st2.fold_cbtc_lock(&[0x99u8; 32], &cx, &cy, &tx, lock_vout, &lock_txid).is_err(), "wrong asset rejected");
        assert_eq!(st2.cbtc_backing_sats, 0);

        // SELF-CUSTODY: the lock output's scriptPubKey is the LOCKER's OWN — ANY SPK folds (no vault check)
        let tx_any = tx_with_lock(v_btc, &[0x51, 0x20, 0xaa, 0xbb], lock_vout);
        let mut st4 = ScanReflection::genesis();
        st4.fold_cbtc_lock(&asset, &cx, &cy, &tx_any, lock_vout, &lock_txid)
            .expect("self-custody: any lock-output SPK folds");
        assert_eq!(st4.cbtc_backing_sats, v_btc, "backing tracked");

        // lock vout 0 reserved → reject
        let tx0 = tx_with_lock(v_btc, lock_spk, 0);
        let mut st5 = ScanReflection::genesis();
        assert!(st5.fold_cbtc_lock(&asset, &cx, &cy, &tx0, 0, &lock_txid).is_err(), "lock vout 0 rejected");
        assert_eq!(st5.cbtc_backing_sats, 0);

        // zero-value lock output → skip. This keeps a junk 0x66 envelope from surfacing a zero-value
        // cbtcLocksFolded delta that the Solidity attest path rejects.
        let tx_zero = tx_with_lock(0, lock_spk, lock_vout);
        let mut st6 = ScanReflection::genesis();
        assert!(
            st6.fold_cbtc_lock(&asset, &cx, &cy, &tx_zero, lock_vout, &lock_txid).is_err(),
            "zero-value lock rejected",
        );
        assert_eq!(st6.cbtc_backing_sats, 0);
    }

    /// Adaptor-swap lock-set leaf (ops/DESIGN-adaptor-swap-guest.md): deterministic, binds EVERY field
    /// (so a claim/refund can't redirect the payee, re-time the deadline, swap the adaptor point, or change
    /// the asset), and is domain-separated from the note-tree `leaf` (a locked note is never normal-spendable).
    #[test]
    fn adaptor_lock_leaf_is_deterministic_and_binds_every_field() {
        let asset = [0x51u8; 32];
        let cx = [0x11u8; 32]; let cy = [0x12u8; 32];
        let tx = [0x21u8; 32]; let ty = [0x22u8; 32];
        let deadline = 1_700_000_000u64;
        let recipient = [0x31u8; 32]; let locker = [0x41u8; 32];
        let base = adaptor_lock_leaf(&asset, &cx, &cy, &tx, &ty, deadline, &recipient, &locker);
        // deterministic
        assert_eq!(base, adaptor_lock_leaf(&asset, &cx, &cy, &tx, &ty, deadline, &recipient, &locker));
        // every field is bound — flipping any one changes the leaf
        let bump = |b: &[u8; 32]| { let mut x = *b; x[0] ^= 1; x };
        assert_ne!(base, adaptor_lock_leaf(&bump(&asset), &cx, &cy, &tx, &ty, deadline, &recipient, &locker), "asset bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &bump(&cx), &cy, &tx, &ty, deadline, &recipient, &locker), "Cx bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &bump(&cy), &tx, &ty, deadline, &recipient, &locker), "Cy bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &cy, &bump(&tx), &ty, deadline, &recipient, &locker), "Tx bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &cy, &tx, &bump(&ty), deadline, &recipient, &locker), "Ty bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &cy, &tx, &ty, deadline + 1, &recipient, &locker), "deadline bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &cy, &tx, &ty, deadline, &bump(&recipient), &locker), "recipient bound");
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &cy, &tx, &ty, deadline, &recipient, &bump(&locker)), "locker bound");
        // domain-separated from the note-tree leaf (same bytes, different domain → different leaf)
        assert_ne!(base, leaf(&cx, &cy, &tx, &ty), "lock leaf disjoint from a normal note leaf");
    }

    /// Stealth lock leaf: deterministic, binds every field (incl. `amount`, so a claim cannot over-mint),
    /// and is domain-separated from the adaptor lock leaf — so a stealth claim and an adaptor claim can never
    /// reproduce each other's leaf in the shared lock-set.
    #[test]
    fn stealth_lock_leaf_binds_every_field_and_is_domain_separated() {
        let asset = [0x51u8; 32];
        let cx = [0x11u8; 32]; let cy = [0x12u8; 32];
        let owner_pub = [0x61u8; 32];
        let amount = 1_000_000u64;
        let deadline = 1_700_000_000u64;
        let locker = [0x41u8; 32];
        let base = stealth_lock_leaf(&asset, &cx, &cy, &owner_pub, amount, deadline, &locker);
        assert_eq!(base, stealth_lock_leaf(&asset, &cx, &cy, &owner_pub, amount, deadline, &locker), "deterministic");
        let bump = |b: &[u8; 32]| { let mut x = *b; x[0] ^= 1; x };
        assert_ne!(base, stealth_lock_leaf(&bump(&asset), &cx, &cy, &owner_pub, amount, deadline, &locker), "asset bound");
        assert_ne!(base, stealth_lock_leaf(&asset, &bump(&cx), &cy, &owner_pub, amount, deadline, &locker), "Cx bound");
        assert_ne!(base, stealth_lock_leaf(&asset, &cx, &bump(&cy), &owner_pub, amount, deadline, &locker), "Cy bound");
        assert_ne!(base, stealth_lock_leaf(&asset, &cx, &cy, &bump(&owner_pub), amount, deadline, &locker), "owner_pub bound");
        assert_ne!(base, stealth_lock_leaf(&asset, &cx, &cy, &owner_pub, amount + 1, deadline, &locker), "amount bound (no over-mint)");
        assert_ne!(base, stealth_lock_leaf(&asset, &cx, &cy, &owner_pub, amount, deadline + 1, &locker), "deadline bound");
        assert_ne!(base, stealth_lock_leaf(&asset, &cx, &cy, &owner_pub, amount, deadline, &bump(&locker)), "locker bound");
        // disjoint from the adaptor lock leaf even with overlapping inputs (shared lock-set, different domain)
        assert_ne!(base, adaptor_lock_leaf(&asset, &cx, &cy, &owner_pub, &locker, deadline, &owner_pub, &locker), "domain-separated from adaptor lock");
    }

    /// The stealth claim message binds the lock leaf + the exact output note + fee, so the recipient's
    /// signature authorizes ONE output at ONE fee: a relayer can neither redirect the note nor pad the fee.
    #[test]
    fn stealth_claim_msg_binds_output_and_fee() {
        let cb = [0x71u8; 32];
        let lock_leaf = [0x72u8; 32];
        let m_cx = [0x11u8; 32]; let m_cy = [0x12u8; 32]; let m_owner = [0x13u8; 32];
        let amount = 500_000u64; let fee = 1_000u64;
        let base = stealth_claim_msg(&cb, &lock_leaf, &m_cx, &m_cy, &m_owner, amount, fee);
        assert_eq!(base, stealth_claim_msg(&cb, &lock_leaf, &m_cx, &m_cy, &m_owner, amount, fee), "deterministic");
        let bump = |b: &[u8; 32]| { let mut x = *b; x[0] ^= 1; x };
        assert_ne!(base, stealth_claim_msg(&bump(&cb), &lock_leaf, &m_cx, &m_cy, &m_owner, amount, fee), "chain binding bound");
        assert_ne!(base, stealth_claim_msg(&cb, &bump(&lock_leaf), &m_cx, &m_cy, &m_owner, amount, fee), "lock leaf bound");
        assert_ne!(base, stealth_claim_msg(&cb, &lock_leaf, &bump(&m_cx), &m_cy, &m_owner, amount, fee), "output Cx bound (no redirect)");
        assert_ne!(base, stealth_claim_msg(&cb, &lock_leaf, &m_cx, &bump(&m_cy), &m_owner, amount, fee), "output Cy bound (no redirect)");
        assert_ne!(base, stealth_claim_msg(&cb, &lock_leaf, &m_cx, &m_cy, &bump(&m_owner), amount, fee), "output owner bound (no redirect)");
        assert_ne!(base, stealth_claim_msg(&cb, &lock_leaf, &m_cx, &m_cy, &m_owner, amount + 1, fee), "amount bound");
        assert_ne!(base, stealth_claim_msg(&cb, &lock_leaf, &m_cx, &m_cy, &m_owner, amount, fee + 1), "fee bound (no pad)");
    }

    /// Regression: the adaptor lock leaf pins the `asset` id, so a CLAIM/REFUND that declares a different
    /// asset than was locked cannot reproduce the lock leaf and fails lock-set membership. Since the
    /// CLAIM/REFUND output note is `leaf(asset, …)` built from the SAME `asset` that reconstructs the lock
    /// leaf, the minted output is forced to the locked note's asset — closing the cross-asset settle (value
    /// commitments share one global generator H, so the kernel alone does not constrain the asset).
    #[test]
    fn adaptor_lock_asset_is_pinned_for_claim_refund() {
        let cx = [0x11u8; 32]; let cy = [0x12u8; 32];
        let tx = [0x21u8; 32]; let ty = [0x22u8; 32];
        let deadline = 1_700_000_000u64;
        let recipient = [0x31u8; 32]; let locker = [0x41u8; 32];
        let asset_locked = [0xAAu8; 32];
        let asset_other = [0xBBu8; 32];
        // LOCK records the leaf under the locked note's asset.
        let locked = adaptor_lock_leaf(&asset_locked, &cx, &cy, &tx, &ty, deadline, &recipient, &locker);
        // A CLAIM/REFUND reconstructs the leaf from its declared asset: the locked asset reproduces it,
        // any other asset yields a different leaf → membership against the lock-set root rejects it.
        assert_eq!(
            locked,
            adaptor_lock_leaf(&asset_locked, &cx, &cy, &tx, &ty, deadline, &recipient, &locker),
            "the locked asset reproduces the lock leaf"
        );
        assert_ne!(
            locked,
            adaptor_lock_leaf(&asset_other, &cx, &cy, &tx, &ty, deadline, &recipient, &locker),
            "a different claim/refund asset cannot reproduce the lock leaf"
        );
    }

    /// Generic CDP primitives (ops/DESIGN-confidential-defi-v1.md §4): the debt asset is controller-derived
    /// (sole minter), the position leaf binds every field + the basket root, and the position nullifier /
    /// leaf / debt-asset are domain-separated from each other and from notes / adaptor locks / cBTC locks.
    #[test]
    fn cdp_primitives_bind_and_separate() {
        let controller_a = [0xc1u8; 20];
        let controller_b = [0xc2u8; 20];
        // debt asset = f(controller) ALONE — distinct controllers ⇒ distinct assets; deterministic.
        let da = cdp_debt_asset_id(&controller_a);
        assert_eq!(da, cdp_debt_asset_id(&controller_a), "debt asset deterministic");
        assert_ne!(da, cdp_debt_asset_id(&controller_b), "debt asset derives from the controller (sole minter)");

        // basket root binds every leg (asset, value); order-sensitive; n=1 and n>1 both work.
        let leg = |a: u8, v: u64| cdp_basket_leg(&[a; 32], v);
        let single = cdp_basket_root(&[leg(0xaa, 100)]);
        let multi = cdp_basket_root(&[leg(0xaa, 100), leg(0xbb, 200)]);
        assert_ne!(single, multi, "basket root binds the leg set");
        assert_ne!(cdp_basket_leg(&[0xaa; 32], 100), cdp_basket_leg(&[0xaa; 32], 101), "leg binds value");
        assert_ne!(cdp_basket_leg(&[0xaa; 32], 100), cdp_basket_leg(&[0xab; 32], 100), "leg binds asset");

        // position leaf binds every field
        let owner = [0x71u8; 32]; let nonce = [0x81u8; 32]; let snap = [0x91u8; 32];
        let base = cdp_position_leaf(&controller_a, &da, &single, 50, &snap, &owner, &nonce);
        assert_eq!(base, cdp_position_leaf(&controller_a, &da, &single, 50, &snap, &owner, &nonce), "deterministic");
        assert_ne!(base, cdp_position_leaf(&controller_b, &da, &single, 50, &snap, &owner, &nonce), "controller bound");
        assert_ne!(base, cdp_position_leaf(&controller_a, &cdp_debt_asset_id(&controller_b), &single, 50, &snap, &owner, &nonce), "debt asset bound");
        assert_ne!(base, cdp_position_leaf(&controller_a, &da, &multi, 50, &snap, &owner, &nonce), "basket root bound");
        assert_ne!(base, cdp_position_leaf(&controller_a, &da, &single, 51, &snap, &owner, &nonce), "debt value bound");
        assert_ne!(base, cdp_position_leaf(&controller_a, &da, &single, 50, &[0x92; 32], &owner, &nonce), "rate snapshot bound");
        assert_ne!(base, cdp_position_leaf(&controller_a, &da, &single, 50, &snap, &[0x72; 32], &nonce), "owner bound");
        assert_ne!(base, cdp_position_leaf(&controller_a, &da, &single, 50, &snap, &owner, &[0x82; 32]), "nonce bound");

        // the position nullifier is one-to-one with the leaf and domain-separated from a note nullifier
        let nu = cdp_position_nullifier(&base);
        assert_eq!(nu, cdp_position_nullifier(&base), "position ν deterministic");
        assert_ne!(nu, cdp_position_nullifier(&cdp_position_leaf(&controller_a, &da, &single, 50, &snap, &owner, &[0x82; 32])), "distinct positions ⇒ distinct ν");
        // position leaf must never collide with a normal note leaf or an adaptor lock leaf (domain sep)
        assert_ne!(base, leaf(&single, &owner, &nonce, &owner), "position leaf disjoint from a note leaf");
        assert_ne!(base, adaptor_lock_leaf(&single, &single, &owner, &single, &owner, 50, &owner, &nonce), "position leaf disjoint from an adaptor lock leaf");
    }

    /// Produce a valid BIP-340 signature for the kernel/opening KATs (LP-add / lp-remove / swap-var
    /// kernels): even-y P (negate d if odd), even-y R (negate k), e = H_tag(rx‖px‖msg), s = k + e·d.
    fn bip340_sign(d_seed: &[u8; 32], k_seed: &[u8; 32], msg: &[u8; 32]) -> ([u8; 32], [u8; 64]) {
        let mut d = scalar_reduce_be(d_seed);
        if compress(&(ProjectivePoint::generator() * d))[0] == 0x03 { d = -d; }
        let pc = compress(&(ProjectivePoint::generator() * d));
        let mut px = [0u8; 32]; px.copy_from_slice(&pc[1..]);
        let mut k = scalar_reduce_be(k_seed);
        if compress(&(ProjectivePoint::generator() * k))[0] == 0x03 { k = -k; }
        let rc = compress(&(ProjectivePoint::generator() * k));
        let mut rx = [0u8; 32]; rx.copy_from_slice(&rc[1..]);
        let mut chal = Vec::with_capacity(96);
        chal.extend_from_slice(&rx); chal.extend_from_slice(&px); chal.extend_from_slice(msg);
        let e = scalar_reduce_be(&bip340_tagged(b"BIP0340/challenge", &chal));
        let s = k + e * d;
        let mut sig = [0u8; 64];
        sig[0..32].copy_from_slice(&rx);
        sig[32..64].copy_from_slice(s.to_bytes().as_slice());
        (px, sig)
    }

    /// Pin ScanReflection::genesis().digest() (the SHIPPED full-scan reflection model) to the
    /// constant the contract hardcodes (ConfidentialPool.REFLECTION_GENESIS_DIGEST).
    /// knownReflectionDigest is seeded to this, so the FIRST attestBitcoinStateProven must continue
    /// it — a Rust-side drift makes the bridge un-bootstrappable (first attest reverts
    /// StaleReflectionDigest). (The legacy WitnessedReflection genesis 0x0ca539ff is no longer the
    /// shipped model; the contract constant must equal the ScanReflection genesis below.)
    #[test]
    fn genesis_digest_matches_contract_constant() {
        assert_eq!(
            ScanReflection::genesis().digest(),
            arr32("0x7b058378c57dc5e8586e588ed5b010862924ec34dfce88495379135ae006ef41"),
            "ScanReflection::genesis().digest() drifted from ConfidentialPool.REFLECTION_GENESIS_DIGEST"
        );
    }

    /// Single-tx cBTC redemption (the trustless rug-vs-redeem classifier): a valid burn of exactly v_btc
    /// matched to a tracked lock RETIRES the lock (never slashable); a forged/short/misnamed burn is rejected
    /// and leaves the lock tracked (so a bare spend still folds it as a rug). Closes the honest-redeemer slash
    /// race without an owner attestation.
    #[test]
    fn fold_cbtc_redeem_classifies_honest_exit_and_rejects_spoof() {
        let v_btc: u64 = 100_000;
        let lock_txid = [0x22u8; 32];
        let lock_vout = 1u32;
        let o = outpoint_key(&lock_txid, lock_vout);
        let in_op = ([0x11u8; 32], 0u32);

        // A real cBTC note C = v·H + r·G (Σv = v_btc); the burn kernel key is r·G (the excess), so sign with d = r.
        let d_seed = [7u8; 32];
        let r = scalar_reduce_be(&d_seed);
        let c = gen_h() * Scalar::from(v_btc) + ProjectivePoint::generator() * r;
        // The burn kernel message EXACTLY as cxfer_kernel_verify builds it (1 input, no outputs, burned = v_btc).
        let mut h = Sha256::new();
        h.update(CXFER_KERNEL_DOMAIN);
        h.update(CBTC_ZK_ASSET_ID);
        h.update([1u8]);
        h.update(in_op.0);
        h.update(in_op.1.to_le_bytes());
        h.update([0u8]);
        h.update(v_btc.to_le_bytes());
        let msg: [u8; 32] = h.finalize().into();
        let (_px, sig) = bip340_sign(&d_seed, &[9u8; 32], &msg);

        let mut v32 = [0u8; 32];
        v32[24..].copy_from_slice(&v_btc.to_be_bytes());

        // The redeem tx's vins: the cBTC note(s) burned AND the lock unlock (the single-tx atomic swap).
        let tx_ins = [in_op, (lock_txid, lock_vout)];

        // Honest redeem: valid burn + lock unlocked in-tx + tracked lock → retired, off the live set.
        let mut st = ScanReflection::genesis();
        st.cbtc_locks.insert(&o, &v32, &CBTC_ZK_ASSET_ID);
        st.cbtc_backing_sats = v_btc;
        assert_eq!(
            st.fold_cbtc_redeem(&lock_txid, lock_vout, v_btc, &tx_ins, &[in_op], &[c], &sig),
            Ok(o),
            "a valid single-tx redeem classifies the lock as redeemed",
        );
        assert!(st.cbtc_locks.get(&o).is_none(), "redeemed lock leaves the live set (spend-scan won't rug it)");
        assert_eq!(st.cbtc_backing_sats, 0, "backing drops with the burned supply");

        // Spoof attempts on a fresh state: each must REJECT and leave the lock tracked + slashable.
        let mut st2 = ScanReflection::genesis();
        st2.cbtc_locks.insert(&o, &v32, &CBTC_ZK_ASSET_ID);
        st2.cbtc_backing_sats = v_btc;
        assert!(st2.fold_cbtc_redeem(&[0xFFu8; 32], 9, v_btc, &tx_ins, &[in_op], &[c], &sig).is_err(), "untracked lock");
        assert!(st2.fold_cbtc_redeem(&lock_txid, lock_vout, v_btc + 1, &tx_ins, &[in_op], &[c], &sig).is_err(), "value mismatch");
        assert!(st2.fold_cbtc_redeem(&lock_txid, lock_vout, v_btc, &tx_ins, &[in_op], &[c], &[0u8; 64]).is_err(), "forged burn");
        // a burn that NAMES the lock but does not UNLOCK it in-tx (lock absent from the vins) is rejected.
        assert!(st2.fold_cbtc_redeem(&lock_txid, lock_vout, v_btc, &[in_op], &[in_op], &[c], &sig).is_err(), "lock not unlocked in-tx");
        assert!(st2.cbtc_locks.get(&o).is_some(), "a rejected redeem leaves the lock tracked");
        assert_eq!(st2.cbtc_backing_sats, v_btc, "a rejected redeem never touches backing");
    }

    /// Mode-B anchor regression: the resume digest binds `eth_refl_digest` (the eth proof's committed
    /// newDigest, which commits crossOutSetRoot + consumedNuSetRoot + both counts), so the contract's
    /// `priorDigest == knownReflectionDigest` chain forces each Mode-B cycle's witnessed eth prior to
    /// continue the one the prior cycle committed (DESIGN-mode-b-recursion.md §2; reflect.rs Mode-B).
    /// Without this, a witnessed eth accumulator prior is free and a fold could be authorized by a
    /// forged set that still satisfies the freshness COUNT gate. Two states equal in every Bitcoin
    /// field but recording a different authorizing eth accumulator MUST differ.
    #[test]
    fn resume_digest_binds_eth_reflection_accumulator() {
        let pool = [0x11u8; 20];
        let root_a = arr32("0x00000000000000000000000000000000000000000000000000000000000000aa");
        let root_b = arr32("0x00000000000000000000000000000000000000000000000000000000000000bb");
        // Distinct authorizing eth accumulators ⇒ distinct eth_refl_digest ⇒ distinct resume digest.
        let da = eth_reflection::eth_refl_digest(&pool, &root_a, 1, &root_a, 1);
        let db = eth_reflection::eth_refl_digest(&pool, &root_b, 1, &root_b, 1);
        assert_ne!(da, db, "the two eth accumulators must hash distinctly");
        let mut sa = ScanReflection::genesis();
        sa.eth_refl_digest = da;
        let mut sb = ScanReflection::genesis();
        sb.eth_refl_digest = db;
        assert_ne!(
            sa.digest(), sb.digest(),
            "resume digest must bind the eth-reflection accumulator (the cross-cycle anchor)",
        );
        // Genesis (no Mode-B yet) carries the zero anchor and differs from any folded eth state.
        assert_ne!(ScanReflection::genesis().digest(), sa.digest(), "genesis anchor is zero, distinct");
    }

    /// The reflected note leaf is DERIVED from the envelope (asset + commitment), never witnessed —
    /// so a relayer cannot append an arbitrary spendable leaf into bitcoinPoolRoot (F-CRIT). It must
    /// equal leaf(asset, Cx, Cy, 0) for the decompressed commitment (matches the dapp indexer).
    #[test]
    fn reflected_note_leaf_binds_envelope_commitment() {
        let asset = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        // A real curve point: H (the value generator) compressed.
        let c = compress(&gen_h());
        let p = decompress(&c).unwrap().to_affine().to_encoded_point(false);
        let b = p.as_bytes();
        let cx: [u8; 32] = b[1..33].try_into().unwrap();
        let cy: [u8; 32] = b[33..65].try_into().unwrap();
        assert_eq!(
            reflected_note_leaf(&asset, &c).unwrap(),
            leaf(&asset, &cx, &cy, &[0u8; 32]),
            "reflected leaf must be leaf(asset, Cx, Cy, 0)"
        );
        // A non-curve-point compressed blob is rejected (no panic, no junk leaf).
        assert!(reflected_note_leaf(&asset, &[0u8; 33]).is_none());
    }

    #[test]
    fn kernel_accepts_js_proof_and_rejects_tamper() {
        let f = fixture();
        let in_c: Vec<_> = f["inC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let out_c: Vec<_> = f["outC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let r = pt(f["kernel"]["R"].as_str().unwrap());
        let z = scalar_reduce_be(&arr32(f["kernel"]["z"].as_str().unwrap()));
        assert!(verify_kernel(&in_c, &out_c, &r, &z));
        let mut bad = out_c.clone();
        bad[0] = bad[0] + ProjectivePoint::generator() * Scalar::from(7u64);
        assert!(!verify_kernel(&in_c, &bad, &r, &z));
    }

    // Rust-side opening-sigma prover (mirror of dapp/confidential-pool.js openingSigma): C =
    // amount·H + r·G, R = k·G, e = keccak(DOMAIN ‖ amount ‖ ctx ‖ C ‖ R), z = k + e·r.
    fn prove_opening_sigma(amount: u64, r: &Scalar, k: &Scalar, ctx: &[u8; 32]) -> (ProjectivePoint, Scalar) {
        let c = gen_h() * Scalar::from(amount) + ProjectivePoint::generator() * r;
        let r_pt = ProjectivePoint::generator() * k;
        let mut h = Keccak::v256();
        h.update(OPENING_DOMAIN);
        h.update(&amount.to_be_bytes());
        h.update(ctx);
        h.update(&compress(&c));
        h.update(&compress(&r_pt));
        let mut hb = [0u8; 32]; h.finalize(&mut hb);
        let e = scalar_reduce_be(&hb);
        (r_pt, *k + e * r)
    }

    #[test]
    fn opening_sigma_roundtrip_and_tamper() {
        let amount = 1234u64;
        let r = scalar_reduce_be(&arr32("0x1111111111111111111111111111111111111111111111111111111111111111"));
        let k = scalar_reduce_be(&arr32("0x2222222222222222222222222222222222222222222222222222222222222222"));
        let ctx = arr32("0x3333333333333333333333333333333333333333333333333333333333333333");
        let c = gen_h() * Scalar::from(amount) + ProjectivePoint::generator() * r;
        let (r_pt, z) = prove_opening_sigma(amount, &r, &k, &ctx);
        // a valid proof verifies — and reveals nothing about r (z, R are the only outputs).
        assert!(verify_opening_sigma(&c, amount, &r_pt, &z, &ctx), "valid opening sigma verifies");
        // binds the value: a different amount (same commitment) is rejected.
        assert!(!verify_opening_sigma(&c, amount + 1, &r_pt, &z, &ctx), "amount tamper rejected");
        // binds the trade terms: a different context is rejected (so the box can't redirect/relabel).
        let ctx2 = arr32("0x4444444444444444444444444444444444444444444444444444444444444444");
        assert!(!verify_opening_sigma(&c, amount, &r_pt, &z, &ctx2), "context tamper rejected");
        // a forged response is rejected.
        assert!(!verify_opening_sigma(&c, amount, &r_pt, &(z + Scalar::from(1u64)), &ctx), "z tamper rejected");
    }

    // Kernel prover (mirrors verify_kernel's challenge): R = k·G, e = keccak(KERNEL_DOMAIN‖Cin…‖Cout…‖R),
    // z = k + e·excess, where `excess` is the discrete log of ΣCin − ΣCout base G (= Σr_in − Σr_out when
    // values balance). The only secret a real spender feeds in is that excess — i.e. the input blindings.
    fn prove_kernel(
        in_c: &[ProjectivePoint],
        out_c: &[ProjectivePoint],
        k: &Scalar,
        excess: &Scalar,
    ) -> (ProjectivePoint, Scalar) {
        let r_pt = ProjectivePoint::generator() * k;
        let mut h = Keccak::v256();
        h.update(KERNEL_DOMAIN);
        for p in in_c { h.update(&compress(p)); }
        for p in out_c { h.update(&compress(p)); }
        h.update(&compress(&r_pt));
        let mut hb = [0u8; 32]; h.finalize(&mut hb);
        let e = scalar_reduce_be(&hb);
        (r_pt, *k + e * *excess)
    }

    /// REGRESSION — the kernel IS the spend authorization (bearer model, spec §1). The whole transfer
    /// lane's anti-theft property rests on this, so pin it.
    ///
    /// A note leaf `keccak(asset‖Cx‖Cy‖owner)` carries an UNSIGNED `owner` label — nothing checks it, and
    /// the nullifier `keccak(Cx‖Cy‖"spent")` is a public function of the commitment. So the only thing
    /// between a publicly-visible note and theft is `verify_kernel`: a Fiat-Shamir Schnorr PoK of the
    /// discrete log of X = ΣCin − ΣCout base G. Because H and G are independent NUMS, it verifies iff
    /// (a) the H-component vanishes → Σv_in = Σv_out (conservation), AND (b) the prover knows
    /// x = Σr_in − Σr_out (the input blindings). This test pins all of: the owner spends, a party WITHOUT
    /// the input blinding cannot, value cannot be inflated, and the proof is bound to its output set.
    #[test]
    fn kernel_is_the_spend_authorization() {
        let v: u64 = 1_000;
        let r_in = scalar_reduce_be(&[0x11u8; 32]);  // the note owner's SECRET input blinding
        let r_out = scalar_reduce_be(&[0x22u8; 32]); // an output blinding a spender (or thief) chooses
        let k = scalar_reduce_be(&[0x33u8; 32]);     // the Schnorr nonce (R = k·G)

        // The note as it sits on the tree — only (Cx,Cy) and `owner` are public; r_in is the owner's secret.
        let c_in = gen_h() * Scalar::from(v) + ProjectivePoint::generator() * r_in;
        let c_out = gen_h() * Scalar::from(v) + ProjectivePoint::generator() * r_out;

        // (1) HONEST OWNER (knows r_in): excess = r_in − r_out is the dlog of c_in − c_out → a valid spend.
        let excess = r_in - r_out;
        let (r_pt, z) = prove_kernel(&[c_in], &[c_out], &k, &excess);
        assert!(verify_kernel(&[c_in], &[c_out], &r_pt, &z), "owner who knows r_in spends");
        // z is unique for this R: any other response fails (so a thief cannot fuzz z into validity).
        assert!(!verify_kernel(&[c_in], &[c_out], &r_pt, &(z + Scalar::from(1u64))), "z is unique");

        // (2) THIEF — sees c_in, c_out, picks r_out + k, but does NOT know r_in. The only z that verifies
        // for R = k·G is k + e·(r_in − r_out), which embeds r_in. Every excess a thief can form from
        // known-only values (guessing r_in) is rejected — i.e. theft requires the input blinding.
        for guess in [Scalar::from(0u64), r_out, Scalar::from(v), k] {
            let forged_excess = guess - r_out; // what the thief computes assuming r_in = guess
            let (r_f, z_f) = prove_kernel(&[c_in], &[c_out], &k, &forged_excess);
            assert!(
                !verify_kernel(&[c_in], &[c_out], &r_f, &z_f),
                "a kernel forged without the real input blinding is rejected"
            );
        }

        // (3) VALUE INFLATION — even the owner (knowing every blinding) cannot move value: a higher-value
        // output leaves an H-component in X that no scalar z can cancel (the conservation half of the PoK).
        let c_out_inflated = gen_h() * Scalar::from(v + 500) + ProjectivePoint::generator() * r_out;
        let (r_i, z_i) = prove_kernel(&[c_in], &[c_out_inflated], &k, &excess);
        assert!(!verify_kernel(&[c_in], &[c_out_inflated], &r_i, &z_i), "value inflation rejected");

        // (4) OUTPUT BINDING — the honest proof does not verify against a different output: the challenge
        // commits ΣCin‖ΣCout, so swapping the output changes e and breaks the equation (non-malleable).
        let c_out_other = gen_h() * Scalar::from(v) + ProjectivePoint::generator() * scalar_reduce_be(&[0x44u8; 32]);
        assert!(!verify_kernel(&[c_in], &[c_out_other], &r_pt, &z), "proof is bound to its output set");
    }

    /// REGRESSION — why adaptor claim/refund MUST stay single-output (audit S-3). The kernel proves only
    /// that ΣCin − ΣCout has no H-component (Σv_in ≡ Σv_out mod n) plus knowledge of the excess. With TWO
    /// outputs a prover can split v_in as (v_in + D, n − D): the values still sum to v_in mod n, so the
    /// kernel ALONE verifies — yet one output now commits to a wildly out-of-range value. TRANSFER guards
    /// this with an explicit range proof on its outputs; adaptor claim/refund carry NO range proof and are
    /// safe ONLY because they have exactly ONE output (which the kernel pins to the single input value). If
    /// a future change gives claim/refund a second output, THIS is the inflation it reopens.
    #[test]
    fn kernel_alone_does_not_bound_a_multi_output_split() {
        let v: u64 = 1_000;
        let r_in = scalar_reduce_be(&[0xa1u8; 32]);
        let r_out1 = scalar_reduce_be(&[0xa2u8; 32]);
        let r_out2 = scalar_reduce_be(&[0xa3u8; 32]);
        let k = scalar_reduce_be(&[0xa4u8; 32]);

        let c_in = gen_h() * Scalar::from(v) + ProjectivePoint::generator() * r_in;
        // Split as (v + D, −D): D = 2^64−1, so out2 commits to (n − D) — far outside any 2^64 range.
        let big = Scalar::from(u64::MAX);
        let c_out1 = gen_h() * (Scalar::from(v) + big) + ProjectivePoint::generator() * r_out1;
        let c_out2 = gen_h() * (-big) + ProjectivePoint::generator() * r_out2;
        let excess = r_in - r_out1 - r_out2;
        let (r_pt, z) = prove_kernel(&[c_in], &[c_out1, c_out2], &k, &excess);
        assert!(
            verify_kernel(&[c_in], &[c_out1, c_out2], &r_pt, &z),
            "the kernel ALONE admits a 2-output split — a range proof (transfer) or a single output (adaptor) is what bounds it"
        );
    }

    /// REGRESSION — the canonical-orientation assert is load-bearing (audit S-5). `pool_id` sorts its pair
    /// internally, so it is SYMMETRIC: pool_id(a,b) == pool_id(b,a). The contract's pre==live reserve gate
    /// is keyed by pool_id, so it CANNOT detect a swapped (asset_a, asset_b) — only the guest's
    /// `be_bytes_lte(asset_a, asset_b) && asset_a != asset_b` assert binds asset_a to the low reserve leg.
    /// Drop that assert and a prover could clear the high-value leg against the low reserve. Pin both halves.
    #[test]
    fn pool_id_is_symmetric_so_orientation_must_be_asserted() {
        let lo = [0x01u8; 32];
        let hi = [0x02u8; 32];
        let fee = 30u32;
        assert_eq!(pool_id(&lo, &hi, fee), pool_id(&hi, &lo, fee), "pool_id sorts internally (symmetric)");
        assert_ne!(pool_id(&lo, &hi, fee), pool_id(&lo, &hi, fee + 1), "fee tier is part of the id");
        // the predicate the guest asserts: true for exactly the canonical order, false otherwise.
        assert!(crate::bitcoin::be_bytes_lte(&lo, &hi) && lo != hi, "canonical order accepted");
        assert!(!(crate::bitcoin::be_bytes_lte(&hi, &lo) && hi != lo), "reversed order rejected");
        assert!(!(lo != lo), "equal assets rejected by the != half");
    }

    #[test]
    fn range_accepts_js_proof_and_rejects_tamper() {
        let f = fixture();
        let out_c: Vec<_> = f["outC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let proof = hex::decode(f["rangeProof"].as_str().unwrap()).unwrap();
        assert!(verify_range(&out_c, &proof), "must accept JS BP+ proof");

        let mut bad = proof.clone();
        bad[200] ^= 1; // flip a byte inside the proof
        assert!(!verify_range(&out_c, &bad), "tampered proof must reject");

        let mut badc = out_c.clone();
        badc[0] = badc[0] + ProjectivePoint::generator() * Scalar::from(3u64);
        assert!(!verify_range(&badc, &proof), "wrong commitment must reject");
    }

    // BPP-AUDIT: adversarial edge cases on the range verifier (attacker-crafted proof bytes).
    // Confirms the structural gates (m-set, length, parse) reject cleanly and that the proof's
    // m is taken from commitments.len() (NOT attacker bytes) so a length/aggregation mismatch
    // cannot be exploited. The valid baseline is the real m=2 JS fixture proof.
    #[test]
    fn range_adversarial_edge_cases() {
        let f = fixture();
        let out_c: Vec<_> = f["outC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let proof = hex::decode(f["rangeProof"].as_str().unwrap()).unwrap();
        assert_eq!(out_c.len(), 2);
        assert!(verify_range(&out_c, &proof), "baseline m=2 must verify");

        // m = 0 (no commitments): not in {1,2,4,8} → reject, no panic.
        assert!(!verify_range(&[], &proof), "m=0 must reject");

        // m = 3 (non power of two): reject.
        let three = vec![out_c[0], out_c[1], out_c[0]];
        assert!(!verify_range(&three, &proof), "m=3 must reject");

        // m=1 with the m=2 proof: length is checked against commitments.len(), so the m=2
        // proof (657 B) is the wrong length for m=1 (591 B) → reject (can't repurpose a proof
        // for a different aggregation count).
        assert!(!verify_range(&[out_c[0]], &proof), "m=1 with m=2 proof: length mismatch must reject");

        // Truncated proof (one byte short): length gate rejects.
        assert!(!verify_range(&out_c, &proof[..proof.len() - 1]), "truncated must reject");
        // Extended proof (one trailing byte): length gate rejects.
        let mut longer = proof.clone();
        longer.push(0u8);
        assert!(!verify_range(&out_c, &longer), "over-length must reject");

        // All-zero proof of the correct length: the first 33 bytes are 0x00.. which is not a
        // valid compressed point → decompress fails → reject (no identity-point spoof).
        let zero = vec![0u8; proof.len()];
        assert!(!verify_range(&out_c, &zero), "all-zero proof must reject");

        // A commitment that is the identity point (point at infinity): in the guest this is
        // UNREACHABLE because output commitments are built by from_affine_xy(cx,cy), which has no
        // 65-byte 0x04-encoding for the identity and returns None (the guest then .expect()-panics
        // before verify_range is ever called). Fed directly, compress(identity) panics inside the
        // transcript (identity SEC1-compresses to a single 0x00 byte, not 33) — a FAIL-CLOSED panic,
        // never a spoofed `true`. Assert the call cannot return true (catch the panic).
        let id_result = std::panic::catch_unwind(|| {
            let mut id_c = out_c.clone();
            id_c[0] = ProjectivePoint::identity();
            verify_range(&id_c, &proof)
        });
        assert!(matches!(id_result, Ok(false) | Err(_)), "identity commitment must NOT verify (reject or fail-closed panic)");

        // Scalar field r1 set out of canonical range (>= n): scalar_canonical_be → None → reject.
        // r1 lives at offset 99 (after A,A1,B = 3*33). Overwrite with 0xFF..FF (> n).
        let mut bad_scalar = proof.clone();
        for b in bad_scalar.iter_mut().skip(99).take(32) { *b = 0xff; }
        assert!(!verify_range(&out_c, &bad_scalar), "non-canonical r1 scalar must reject");
    }

    // AMM-FEE-1: solve_clearing (the guest's fee-enforcement primitive for OP_SWAP) must match the
    // normative JS clearing-solve (tests/amm-clearing.mjs, AMM.md §4) byte-for-byte across the full
    // battery — one/two-sided, exact-cancel, zero/max fee, large near-u64 reserves (intermediate
    // products ~2^142), and a no-exact-fixed-point case. Vectors: tests/gen-clearing-vectors.mjs.
    // If the port drifts, the swap fee is mis-enforced (the whole point of fee tiers).
    #[test]
    fn solve_clearing_matches_js() {
        use num_bigint::BigUint;
        use std::str::FromStr;
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/clearing_vectors.json")).unwrap();
        for v in f["vectors"].as_array().unwrap() {
            let x: u64 = v["x"].as_str().unwrap().parse().unwrap();
            let y: u64 = v["y"].as_str().unwrap().parse().unwrap();
            let r_a: u64 = v["rA"].as_str().unwrap().parse().unwrap();
            let r_b: u64 = v["rB"].as_str().unwrap().parse().unwrap();
            let fee: u32 = v["fee"].as_u64().unwrap() as u32;
            let (pn, pd) = solve_clearing(x, y, r_a, r_b, fee).expect("valid clearing vector");
            let exp_n = BigUint::from_str(v["pNum"].as_str().unwrap()).unwrap();
            let exp_d = BigUint::from_str(v["pDen"].as_str().unwrap()).unwrap();
            assert_eq!(pn, exp_n, "P_clear_num drift on X={x} Y={y} R={r_a}/{r_b} fee={fee}");
            assert_eq!(pd, exp_d, "P_clear_den drift on X={x} Y={y} R={r_a}/{r_b} fee={fee}");
        }
    }

    #[test]
    fn solve_clearing_fails_closed_on_invalid_nonempty_pool_or_fee() {
        assert!(solve_clearing(1, 0, 0, 10, 30).is_none());
        assert!(solve_clearing(0, 1, 10, 0, 30).is_none());
        assert!(solve_clearing(1, 0, 10, 10, 10001).is_none());
        assert!(!clearing_price_matches(1, 0, 0, 10, 30, 1, 1));
    }

    // AMM-LP-1: lp_add_shares is the min rule (the EVM guest's OP_LP_ADD share computation) and must
    // match tests/amm-clearing.mjs `lpAddShares` / dapp confidential-lp.js. The key property the old
    // exact-ratio gate broke: an INCREMENTAL add on a coprime, traded pool must earn shares (be > 0),
    // and an off-ratio add earns the LIMITING leg (the excess accrues to the pool — never an over-claim).
    #[test]
    fn lp_add_shares_min_rule() {
        // in-ratio (1:2 pool) → both legs agree → proportional shares
        assert_eq!(lp_add_shares(1000, 100, 200, 1000, 2000), 100);
        // B-short of ratio → min picks the B leg (99); the extra A is donated to the pool
        assert_eq!(lp_add_shares(1000, 100, 199, 1000, 2000), 99);
        // B-long of ratio → min picks the A leg (100); the extra B is donated
        assert_eq!(lp_add_shares(1000, 100, 400, 1000, 2000), 100);
        // dust below one share rounds to 0 (the guest rejects a 0-share add)
        assert_eq!(lp_add_shares(10000, 1, 2, 1_000_003, 2_000_006), 0);
        // REGRESSION: an incremental add on a COPRIME pool (no integer dB makes dA·R_B == dB·R_A) now
        // earns shares — the exact-ratio gate would have rejected every such add.
        assert!(lp_add_shares(1_000_003, 500, 999, 1_000_003, 1_999_991) > 0,
            "incremental add on a coprime/traded pool must earn shares");
        assert_eq!(lp_add_shares(1_000_003, 500, 999, 1_000_003, 1_999_991), 499);
        // remove: floor toward the pool
        assert_eq!(lp_remove_output(1000, 100, 1000), 100);
        assert_eq!(lp_remove_output(2000, 100, 1000), 200);
        assert_eq!(lp_remove_output(1_000_003, 1, 3), 333_334);
    }

    // AMM-LP-INIT: isqrt (the constant-product first-mint basis) matches tests/amm-clearing.mjs `isqrt`
    // reference vectors byte-for-byte, so the guest's first-mint totalShares == the JS/contract value.
    #[test]
    fn isqrt_matches_js_vectors() {
        for (n, r) in [(0u128, 0u128), (1, 1), (2, 1), (3, 1), (4, 2), (8, 2), (2_000_000_000_000, 1_414_213),
                       (1_000_000, 1000), (999_999, 999), (1_000_001, 1000), (u64::MAX as u128 * u64::MAX as u128, u64::MAX as u128)] {
            assert_eq!(isqrt(n), r, "isqrt({n}) should be {r}");
        }
    }

    // AMM-ROUTE-1: get_amount_out is the constant-product exact-in hop primitive OP_SWAP_ROUTE chains. It
    // must charge the fee, never drain the output reserve, and keep k non-decreasing (the LP floor).
    #[test]
    fn get_amount_out_exact_in() {
        assert_eq!(get_amount_out(1000, 1_000_000, 1_000_000, 0), 999);  // no-fee slippage
        assert_eq!(get_amount_out(1000, 1_000_000, 1_000_000, 30), 996); // 0.3% fee → strictly less
        assert!(get_amount_out(u64::MAX, 1000, 5000, 30) < 5000);        // can't drain the output reserve
        let (rin, rout) = (1_000_000u128, 1_000_000u128);
        let out = get_amount_out(1000, 1_000_000, 1_000_000, 30);
        assert!((rin + 1000) * (rout - out) >= rin * rout, "constant-product must not decrease");
    }

    // AMM-ROUTE-2: cross-language KAT — get_amount_out matches tests/amm per-hop reference vectors
    // (tests/gen-amount-out-vectors.mjs) byte-for-byte. Those vectors are also pinned on the Bitcoin
    // lane to be exactly the max delta_out swap-route cfmmFloorOk admits, so this asserts the per-hop
    // curve agrees across the SP1 guest (this), the JS reference, and the Bitcoin route validator —
    // closing the route-hop drift the batch clearing KAT (clearing_vectors.json) didn't cover.
    #[test]
    fn get_amount_out_matches_js_vectors() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/get_amount_out_vectors.json")).unwrap();
        for v in f["vectors"].as_array().unwrap() {
            let a_in: u64 = v["amountIn"].as_str().unwrap().parse().unwrap();
            let r_in: u64 = v["reserveIn"].as_str().unwrap().parse().unwrap();
            let r_out: u64 = v["reserveOut"].as_str().unwrap().parse().unwrap();
            let fee: u32 = v["feeBps"].as_u64().unwrap() as u32;
            let exp: u128 = v["amountOut"].as_str().unwrap().parse().unwrap();
            assert_eq!(get_amount_out(a_in, r_in, r_out, fee), exp,
                "get_amount_out drift on a_in={a_in} R={r_in}/{r_out} fee={fee}");
        }
    }

    // AMM-FEE-2: pin the ORIENTATION of clearing_price_matches. The declared OP_SWAP price is
    // clearingPriceBperA(solve) = B per A, i.e. the RECIPROCAL of solve_clearing's A-per-B P_clear, so
    // the check is `pc_den == price_num && pc_num == price_den`. This test locks that: the correct
    // (B-per-A) price is ACCEPTED and the reciprocal / an under-charged price is REJECTED — so a reader
    // (or auditor) can't mistake the intentional flip for a num/den reversal.
    #[test]
    fn clearing_price_matches_orientation() {
        // solve_clearing(100 A in, 0 B in, 1000/1000, 30bps) → P_clear 100/90 (A per B);
        // declared price (B per A) = 90/100.
        assert!(clearing_price_matches(100, 0, 1000, 1000, 30, 90, 100), "the fee-clearing B-per-A price must be accepted");
        assert!(!clearing_price_matches(100, 0, 1000, 1000, 30, 100, 90), "the reciprocal (A-per-B) price must be rejected");
        assert!(!clearing_price_matches(100, 0, 1000, 1000, 30, 91, 100), "an over-favourable (under-charged) price must be rejected");
        assert!(!clearing_price_matches(100, 0, 1000, 1000, 30, 89, 100), "a mismatched price must be rejected");
    }

    // BPP-1: the on-chain verify_range — the no-inflation ROOT primitive — must REJECT a FORGED proof
    // that commits an OUT-OF-RANGE value (V opens to 2^64), and still ACCEPT the honest max in-range
    // value (2^64 - 1). The forged proof is built by a malicious prover bypassing the [0,2^64) input
    // guard (tests/gen-bpp-out-of-range-fixture.mjs). Without this, the suite never drove the VERIFIER
    // with an out-of-range artifact — only the JS prover's input gate was tested — so a future port/
    // dependency drift that broke the value bound would mint unbacked supply behind a green suite.
    #[test]
    fn range_rejects_out_of_range_commitment() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/bpp_out_of_range.json")).unwrap();
        let honest_c = pt(f["honestMax"]["commitment"].as_str().unwrap());
        let honest_p = hex::decode(strip(f["honestMax"]["proof"].as_str().unwrap())).unwrap();
        assert!(verify_range(&[honest_c], &honest_p), "honest max in-range value 2^64-1 must verify (no false reject)");

        let oor_c = pt(f["outOfRange"]["commitment"].as_str().unwrap());
        let oor_p = hex::decode(strip(f["outOfRange"]["proof"].as_str().unwrap())).unwrap();
        assert!(!verify_range(&[oor_c], &oor_p), "a proof committing an out-of-range value (2^64) MUST be rejected (no inflation)");
    }

    // BPP-A: randomized JS<->Rust differential. The committed corpus (fixtures/bpp_differential.json)
    // is generated deterministically by the JS attester (tests/gen-bpp-differential-fixture.mjs) over
    // every m in {1,2,4,8} and the honest / out-of-range / tampered / wrong-commitment families; the JS
    // verifier pins each verdict (tests/bulletproofs-plus-rust-differential.test.mjs). Here the on-chain
    // verify_range must return the SAME verdict for the SAME bytes on every case. Before this, JS->Rust
    // agreement was pinned only for m=1/m=2 on a handful of proofs, so a future port or @noble drift that
    // manifested only at m=4/8 (or on a challenge-dependent path) could diverge the two verifiers behind
    // a green suite: attester-blesses-but-guest-rejects bricks settle; the reverse is a soundness gap.
    #[test]
    fn range_matches_js_across_random_corpus() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/bpp_differential.json")).unwrap();
        let cases = f["cases"].as_array().unwrap();
        assert!(cases.len() >= 28, "differential corpus unexpectedly small: {}", cases.len());
        let (mut seen_accept, mut seen_reject) = (false, false);
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let commitments: Vec<ProjectivePoint> =
                case["commitments"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
            let proof = hex::decode(strip(case["proof"].as_str().unwrap())).unwrap();
            let want = case["accept"].as_bool().unwrap();
            if want { seen_accept = true } else { seen_reject = true }
            assert_eq!(
                verify_range(&commitments, &proof), want,
                "JS<->Rust verdict divergence on {label}: Rust verify_range disagrees with the pinned JS verdict {want}"
            );
        }
        assert!(seen_accept && seen_reject, "differential corpus must carry both accept and reject cases");
    }

    #[test]
    fn keccak_primitives_and_opening_match_js_and_contract() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/confidential_pool.json")).unwrap();
        let asset = arr32(f["assetId"].as_str().unwrap());
        let owner = arr32(f["owner"].as_str().unwrap());

        for note in f["notes"].as_array().unwrap() {
            let cx = arr32(note["cx"].as_str().unwrap());
            let cy = arr32(note["cy"].as_str().unwrap());
            assert_eq!(leaf(&asset, &cx, &cy, &owner), arr32(note["leaf"].as_str().unwrap()), "leaf");
            assert_eq!(nullifier(&cx, &cy), arr32(note["nullifier"].as_str().unwrap()), "nullifier");
            let value: u64 = note["value"].as_str().unwrap().parse().unwrap();
            // deposit id binds the in-system value (not the underlying `amount`); the
            // contract derives the same value = amount/unitScale at wrap.
            assert_eq!(deposit_id(&asset, &u64_be32(value), &deposit_commit(&cx, &cy, &owner)), arr32(note["depositId"].as_str().unwrap()), "depositId");

            // Pedersen opening: C reconstructed from (cx,cy) opens to (value, blinding).
            let c = from_affine_xy(&cx, &cy).unwrap();
            let blinding = scalar_reduce_be(&arr32(note["blinding"].as_str().unwrap()));
            assert!(verify_pedersen_opening(&c, value, &blinding), "opening");
            assert!(!verify_pedersen_opening(&c, value + 1, &blinding), "wrong value rejected");
        }

        // membership path folds to the tree root
        let leaves: Vec<[u8; 32]> = f["treeLeaves"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect();
        let idx = f["memberIndex"].as_u64().unwrap();
        let path: Vec<[u8; 32]> = f["memberPath"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect();
        let root = arr32(f["treeRoot"].as_str().unwrap());
        assert!(keccak_merkle_verify(&leaves[idx as usize], idx, &path, &root), "membership");
    }

    // Cross-chain: the guest's claim_id + destCommitment (Bitcoin leaf) must equal
    // the JS prover's and the contract's — locked three-way against the fixture so
    // a crossOut the guest emits is exactly what settle re-derives and Bitcoin honors.
    #[test]
    fn claim_id_and_dest_commitment_match_js_and_contract() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/bridge_burn.json")).unwrap();
        let asset = arr32(f["assetId"].as_str().unwrap());
        let dest_chain = f["destChain"].as_u64().unwrap() as u16;
        let bind = arr32(f["bindNullifier"].as_str().unwrap());

        for c in f["crossOuts"].as_array().unwrap() {
            let cx = arr32(c["cx"].as_str().unwrap());
            let cy = arr32(c["cy"].as_str().unwrap());
            let owner = arr32(c["owner"].as_str().unwrap());
            let dest = leaf(&asset, &cx, &cy, &owner);
            assert_eq!(dest, arr32(c["destCommitment"].as_str().unwrap()), "destCommitment");
            assert_eq!(claim_id(dest_chain, &dest, &bind, &asset), arr32(c["claimId"].as_str().unwrap()), "claimId");
        }
    }

    // Cross-lane gate: indexed-Merkle non-membership against the JS-built IMT root —
    // the scalable (O(log n)) accumulator for reflecting Bitcoin spends. Genuine
    // non-members verify; a present nullifier + a wrong/tampered low-leaf reject.
    #[test]
    fn imt_non_membership_matches_js() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let root = arr32(f["root"].as_str().unwrap());
        let arrp = |w: &serde_json::Value| -> Vec<[u8; 32]> {
            w["path"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect()
        };
        for w in f["witnesses"].as_array().unwrap() {
            let nu = arr32(w["nu"].as_str().unwrap());
            let lv = arr32(w["lowValue"].as_str().unwrap());
            let ln = arr32(w["lowNext"].as_str().unwrap());
            let li = w["lowIndex"].as_u64().unwrap();
            let got = imt_non_membership(&root, &nu, &lv, &ln, li, &arrp(w));
            assert_eq!(got, w["expect"].as_bool().unwrap(), "{}", w["note"].as_str().unwrap());
        }
        // a tampered path must reject a genuine non-member
        let w = &f["witnesses"][1];
        let nu = arr32(w["nu"].as_str().unwrap());
        let lv = arr32(w["lowValue"].as_str().unwrap());
        let ln = arr32(w["lowNext"].as_str().unwrap());
        let mut path = arrp(w);
        path[0][0] ^= 1;
        assert!(!imt_non_membership(&root, &nu, &lv, &ln, w["lowIndex"].as_u64().unwrap(), &path), "tampered path");
    }

    // The BUILD side (imt_root / imt_empty_root / keccak_merkle_root) reconstructs the
    // exact roots the JS pool.Tree produces — so the reflection prover computes the same
    // bitcoinSpentRoot the contract gate + non-membership witnesses are checked against.
    #[test]
    fn imt_build_matches_js() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let links: Vec<([u8; 32], [u8; 32])> = f["links"].as_array().unwrap().iter()
            .map(|l| (arr32(l[0].as_str().unwrap()), arr32(l[1].as_str().unwrap()))).collect();
        assert_eq!(imt_root(&links), arr32(f["root"].as_str().unwrap()), "built spent-set root == JS root");

        // The empty-set sentinel root is reproduced AND is non-zero (a zero root would
        // let the cross-lane gate be skipped — the contract rejects it).
        let empty = imt_empty_root();
        assert_eq!(empty, arr32(f["emptyRoot"].as_str().unwrap()), "empty-IMT root == JS emptyRoot");
        assert_ne!(empty, [0u8; 32], "empty-IMT sentinel is non-zero");

        // And the rebuilt set proves non-membership of a value beyond the max, against
        // the freshly BUILT root (closing the loop: build → prove on the same root).
        let beyond = arr32("0x0000000000000000000000000000000000000000000000000000000000000040");
        let max_links = links.last().unwrap();
        assert!(be_lt(&max_links.0, &beyond) && max_links.1 == [0u8; 32], "last link is the max element");
    }

    // The stateful ImtAccumulator (incremental insert, in-place predecessor update)
    // reaches the SAME root the JS accumulator does from the same chronological
    // insertion sequence, and a non-member proves absent against that built root — the
    // spent-set transition the reflection prover folds each new Bitcoin spend through.
    #[test]
    fn imt_accumulator_matches_js() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let a = &f["accumulator"];

        // empty accumulator == the non-zero sentinel root
        assert_eq!(ImtAccumulator::new().root(), imt_empty_root(), "empty accumulator == sentinel");
        assert_ne!(ImtAccumulator::new().root(), [0u8; 32], "sentinel non-zero");

        // fold the same chronological sequence → same order-dependent root as JS
        let mut acc = ImtAccumulator::new();
        for nu in a["insertSeq"].as_array().unwrap() {
            acc.insert(&arr32(nu.as_str().unwrap()));
        }
        let root = acc.root();
        assert_eq!(root, arr32(a["root"].as_str().unwrap()), "accumulator root == JS root");

        // non-membership of nu against the INCREMENTALLY-BUILT root (JS-supplied path)
        let nm = &a["nonMember"];
        let nu = arr32(nm["nu"].as_str().unwrap());
        let path: Vec<[u8; 32]> = nm["path"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();
        let (li, lv, ln) = acc.non_membership_low(&nu).expect("nu is a non-member");
        assert_eq!(li as u64, nm["lowIndex"].as_u64().unwrap(), "low index matches JS");
        assert_eq!(lv, arr32(nm["lowValue"].as_str().unwrap()), "low value matches JS");
        assert_eq!(ln, arr32(nm["lowNext"].as_str().unwrap()), "low next matches JS");
        assert!(imt_non_membership(&root, &nu, &lv, &ln, li as u64, &path), "nu absent from built root");

        // a member is correctly NOT provable absent
        let member = arr32(a["insertSeq"][0].as_str().unwrap());
        assert!(acc.non_membership_low(&member).is_none(), "a spent nu has no non-membership low leaf");
    }

    // imt_membership: a spent nu IS provable present against the built spent-set root —
    // the bridge_mint burn gate (B5). A wrong `next` or a non-spent value rejects.
    #[test]
    fn imt_membership_round_trips() {
        let zeros = keccak_zeros();
        let build_path = |leaves: &[[u8; 32]], mut idx: usize| -> Vec<[u8; 32]> {
            let mut level = leaves.to_vec();
            let mut path: Vec<[u8; 32]> = Vec::new();
            for lvl in 0..KECCAK_TREE_DEPTH {
                let s = idx ^ 1;
                path.push(if s < level.len() { level[s] } else { zeros[lvl] });
                let mut next: Vec<[u8; 32]> = Vec::new();
                let mut k = 0;
                while k * 2 < level.len() {
                    let l = level[2 * k];
                    let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[lvl] };
                    next.push(kn(&[&l, &r]));
                    k += 1;
                }
                level = next;
                idx >>= 1;
            }
            path
        };
        let mut acc = ImtAccumulator::new();
        let nu_a = arr32("0x0000000000000000000000000000000000000000000000000000000000000010");
        let nu_b = arr32("0x0000000000000000000000000000000000000000000000000000000000000020");
        acc.insert(&nu_a);
        acc.insert(&nu_b);
        let root = acc.root();
        let links = acc.links().to_vec();
        let leaves: Vec<[u8; 32]> = links.iter().map(|(v, n)| imt_leaf(v, n)).collect();

        let i = links.iter().position(|(v, _)| *v == nu_a).unwrap();
        let next_a = links[i].1;
        let path = build_path(&leaves, i);
        assert!(imt_membership(&root, &nu_a, &next_a, i as u64, &path), "spent nu is a member");

        let mut bad_next = next_a;
        bad_next[0] ^= 1;
        assert!(!imt_membership(&root, &nu_a, &bad_next, i as u64, &path), "wrong next rejects");

        let nu_c = arr32("0x0000000000000000000000000000000000000000000000000000000000000030");
        assert!(!imt_membership(&root, &nu_c, &next_a, i as u64, &path), "non-spent value rejects");
    }

    // The incremental note-tree accumulator (append-only, O(depth) state) reaches the
    // SAME root as the JS pool.Tree / the contract _insertLeaf, at every step — so the
    // reflection prover advances bitcoinPoolRoot without holding every leaf.
    #[test]
    fn note_tree_accumulator_matches_contract_tree() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/confidential_pool.json")).unwrap();
        let leaves: Vec<[u8; 32]> = f["treeLeaves"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();

        let mut acc = KeccakTreeAccumulator::new();
        assert_eq!(acc.root(), keccak_merkle_root(&[]), "empty accumulator == empty tree root");
        for (i, leaf) in leaves.iter().enumerate() {
            acc.append(leaf);
            // incremental root == batch rebuild over the leaves appended so far
            assert_eq!(acc.root(), keccak_merkle_root(&leaves[..=i]), "incremental == batch at step {i}");
            assert_eq!(acc.next_index(), (i + 1) as u64);
        }
        assert_eq!(acc.root(), arr32(f["treeRoot"].as_str().unwrap()), "final root == JS/contract treeRoot");
    }

    // The reflection prover's state transition: fold confirmed deposits (note leaves)
    // and spends (nullifiers) into a block, then commit the exact
    // (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight) the relay proof carries. The
    // pool root matches the contract tree; the spent root matches the IMT accumulator;
    // the spent root is never zero.
    #[test]
    fn reflection_state_commits_relay_public_values() {
        let pf: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/confidential_pool.json")).unwrap();
        let imt: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let deposits: Vec<[u8; 32]> = pf["treeLeaves"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();
        let spends: Vec<[u8; 32]> = imt["accumulator"]["insertSeq"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();

        let mut state = ReflectionState::genesis();
        let (p0, s0, h0) = state.commit();
        assert_eq!(p0, keccak_merkle_root(&[]), "genesis pool root = empty");
        assert_eq!(s0, imt_empty_root(), "genesis spent root = non-zero sentinel");
        assert_ne!(s0, [0u8; 32], "genesis spent root non-zero");
        assert_eq!(h0, 0);

        state.apply_block(&deposits, &spends, 800_000);
        let (pool_root, spent_root, height) = state.commit();
        assert_eq!(pool_root, arr32(pf["treeRoot"].as_str().unwrap()), "reflected pool root == contract tree");
        assert_eq!(spent_root, arr32(imt["accumulator"]["root"].as_str().unwrap()), "reflected spent root == IMT accumulator");
        assert_ne!(spent_root, [0u8; 32], "reflected spent root non-zero");
        assert_eq!(height, 800_000);
    }

    // The per-event Bitcoin confirmation (bitcoin::verify_tx_in_block) accepts the real
    // bridge_mint block (valid PoW + the tx folds to the header's merkle root at its
    // index) and rejects tampering — the check the reflection prover runs on each
    // deposit/spend before folding it.
    #[test]
    fn verify_tx_in_block_accepts_real_block_rejects_tamper() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let header = hex::decode(strip(f["header"].as_str().unwrap())).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let tx_index = f["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = f["txids"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();

        // accepts: returns the tx's txid
        let txid = bitcoin::verify_tx_in_block(&header, &tx, tx_index, &txids)
            .expect("real bridge_mint block verifies");
        assert_eq!(txid, bitcoin::compute_txid(&tx).unwrap(), "returns the confirmed txid");

        // rejects: wrong index, a flipped txid (breaks the merkle root), a flipped tx
        // byte (txid no longer matches), and a malformed header length
        assert!(bitcoin::verify_tx_in_block(&header, &tx, tx_index + 1, &txids).is_none(), "bad index");
        let mut bad_txids = txids.clone();
        bad_txids[tx_index as usize][0] ^= 1;
        assert!(bitcoin::verify_tx_in_block(&header, &tx, tx_index, &bad_txids).is_none(), "tampered txid set");
        let mut bad_tx = tx.clone();
        let n = bad_tx.len();
        bad_tx[n - 1] ^= 1;
        assert!(bitcoin::verify_tx_in_block(&header, &bad_tx, tx_index, &txids).is_none(), "tampered tx");
        assert!(bitcoin::verify_tx_in_block(&header[..79], &tx, tx_index, &txids).is_none(), "bad header length");
    }

    // The reflection prover reads a confidential transfer's spent UTXOs from the tx's
    // native inputs (vin). extract_inputs parses them from the real bridge_mint tx and
    // rejects a malformed one.
    #[test]
    fn extract_inputs_parses_real_tx() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let inputs = bitcoin::extract_inputs(&tx).expect("real tx inputs parse");
        assert!(!inputs.is_empty(), "tx has at least one input");
        assert!(bitcoin::extract_inputs(&tx[..5]).is_none(), "truncated tx rejected");
    }

    // The Bitcoin T_CXFER kernel: a real BIP-340 kernel signature (a pure transfer,
    // Σv_in = Σv_out, burned = 0) verifies against the reconstructed excess key
    // P = Σ C_in − Σ C_out, and tampering the sig / the message (reordered outputs) is
    // rejected. (dapp/evm-confidential.js commitments → tests/gen-cxfer-kernel-fixture.mjs.)
    #[test]
    fn cxfer_kernel_verify_accepts_real_sig_rejects_tamper() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/cxfer_kernel.json")).unwrap();
        let asset = arr32(f["asset"].as_str().unwrap());
        let burned: u64 = f["burnedAmount"].as_str().unwrap().parse().unwrap();
        let inputs: Vec<([u8; 32], u32)> = f["inputs"].as_array().unwrap().iter()
            .map(|i| (arr32(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
        let in_commits: Vec<ProjectivePoint> = f["inputs"].as_array().unwrap().iter()
            .map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();
        let out_compressed: Vec<[u8; 33]> = f["outputs"].as_array().unwrap().iter()
            .map(|o| arr33(o["commitment"].as_str().unwrap())).collect();
        let sig: [u8; 64] = hex::decode(strip(f["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();

        assert!(cxfer_kernel_verify(&asset, &inputs, &in_commits, &out_compressed, burned, &sig), "valid kernel sig");

        let mut bad_sig = sig;
        bad_sig[63] ^= 1;
        assert!(!cxfer_kernel_verify(&asset, &inputs, &in_commits, &out_compressed, burned, &bad_sig), "tampered sig rejected");

        let mut reordered = out_compressed.clone();
        reordered.swap(0, 1); // changes the kernel message (output order) → e differs
        assert!(!cxfer_kernel_verify(&asset, &inputs, &in_commits, &reordered, burned, &sig), "reordered outputs rejected");

        // wrong asset → different message → reject
        assert!(!cxfer_kernel_verify(&[0u8; 32], &inputs, &in_commits, &out_compressed, burned, &sig), "wrong asset rejected");
    }

    // Track B: build a valid T_SWAP_VAR scenario (real kernel sig + real receipt opening) and lock both
    // the kernel primitive AND fold_swap_var's inflation-critical gates. The positive onboarding round-trip
    // (which needs real keccak-tree append paths) rides the native-exec reflection fixture.
    fn swap_var_kernel_msg(asset_in: &[u8; 32], op: ([u8; 32], u32), c_change: &[u8; 33], dit: u64) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(CXFER_KERNEL_DOMAIN);
        h.update(asset_in);
        h.update([1u8]);
        h.update(op.0);
        h.update(op.1.to_le_bytes());
        h.update([1u8]);
        h.update(c_change);
        h.update(dit.to_le_bytes());
        h.finalize().into()
    }

    #[test]
    fn swap_var_kernel_verify_accepts_real_sig_and_rejects_tamper() {
        let asset_in = [0xAAu8; 32];
        let op = ([0x77u8; 32], 1u32);
        // delta_in_total = v_in − v_change; excess = r_change − r_in ⇒ P = excess·G (pure G-term).
        let (v_in, v_change, dit) = (1500u64, 500u64, 1000u64);
        let r_in = scalar_reduce_be(&[0x31u8; 32]);
        let excess = scalar_reduce_be(&[0x32u8; 32]);
        let r_change = r_in + excess;
        let c_in = compress(&(gen_h() * Scalar::from(v_in) + ProjectivePoint::generator() * r_in));
        let c_change = compress(&(gen_h() * Scalar::from(v_change) + ProjectivePoint::generator() * r_change));
        let msg = swap_var_kernel_msg(&asset_in, op, &c_change, dit);
        let (_px, sig) = bip340_sign(&[0x32u8; 32], &[0x55u8; 32], &msg); // d_seed reduces to `excess`

        assert!(swap_var_kernel_verify(&asset_in, op, &c_in, &c_change, dit, &sig), "valid swap kernel verifies");
        let mut bad = sig; bad[63] ^= 1;
        assert!(!swap_var_kernel_verify(&asset_in, op, &c_in, &c_change, dit, &bad), "tampered sig rejected");
        assert!(!swap_var_kernel_verify(&asset_in, op, &c_in, &c_change, dit + 1, &sig), "wrong delta_in_total rejected");
        assert!(!swap_var_kernel_verify(&[0u8; 32], op, &c_in, &c_change, dit, &sig), "wrong asset rejected");
    }

    #[test]
    fn fold_swap_var_gates_reject_inflation() {
        let asset_a = [0xAAu8; 32];
        let asset_b = [0xBBu8; 32];
        // Valid A→B swap: delta_in 1000 (tip 0), delta_out 450 ≤ reserve_b 5000.
        let op = ([0x77u8; 32], 1u32);
        let (v_in, v_change, dit) = (1500u64, 500u64, 1000u64);
        let r_in = scalar_reduce_be(&[0x31u8; 32]);
        let excess = scalar_reduce_be(&[0x32u8; 32]);
        let r_change = r_in + excess;
        let c_in = compress(&(gen_h() * Scalar::from(v_in) + ProjectivePoint::generator() * r_in));
        let c_change = compress(&(gen_h() * Scalar::from(v_change) + ProjectivePoint::generator() * r_change));
        let msg = swap_var_kernel_msg(&asset_a, op, &c_change, dit);
        let (_px, sig) = bip340_sign(&[0x32u8; 32], &[0x55u8; 32], &msg);
        let delta_out = 450u64;
        let r_receipt_bytes = [0x44u8; 32];
        let c_receipt = compress(&(gen_h() * Scalar::from(delta_out) + ProjectivePoint::generator() * scalar_reduce_be(&r_receipt_bytes)));
        let env = bitcoin::SwapVarEnvelope {
            pool_id: [0x10u8; 32], direction: 0,
            r_a_pre: 10_000, r_b_pre: 5_000,
            delta_in: 1000, tip_amount: 0, delta_out,
            c_in, c_change_or_sentinel: c_change, c_receipt, r_receipt: r_receipt_bytes, kernel_sig: sig,
        };
        let mk_pool = || PoolReserveState { asset_a, asset_b, reserve_a: 10_000, reserve_b: 5_000, total_shares: 7_000, c0_backed: true, protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0 };
        let path = [[0u8; 32]; 32];

        // gate (1): a pool not yet C0-backed folds NOTHING.
        let mut p = mk_pool(); p.c0_backed = false;
        let mut sc = ScanReflection::genesis();
        assert!(sc.fold_swap_var(&mut p, &env, op, &asset_a, &[0x01u8; 32], &path, &[0x02u8; 32], &path).is_err(), "non-C0-backed pool rejected");

        // gate (1): declared reserves must match the tracked reserves (no forged R_pre to over-draw).
        let mut p = mk_pool(); p.reserve_b = 999_999; // tracked ≠ env.r_b_pre
        assert!(sc.fold_swap_var(&mut p, &env, op, &asset_a, &[0x01u8; 32], &path, &[0x02u8; 32], &path).is_err(), "forged reserves rejected");

        // gate (3): the spent input must be the pool's in-side asset (no cross-asset credit).
        let mut p = mk_pool();
        assert!(sc.fold_swap_var(&mut p, &env, op, &asset_b, &[0x01u8; 32], &path, &[0x02u8; 32], &path).is_err(), "wrong input asset rejected");

        // gate (4): a bad kernel sig (the taker didn't really put delta_in in) folds nothing.
        let mut p = mk_pool();
        let mut bad_env = env.clone(); bad_env.kernel_sig[0] ^= 1;
        assert!(sc.fold_swap_var(&mut p, &bad_env, op, &asset_a, &[0x01u8; 32], &path, &[0x02u8; 32], &path).is_err(), "bad kernel rejected");

        // gate (5): the receipt must open to delta_out under r_receipt (no over-stated output value).
        let mut p = mk_pool();
        let mut wrong_out = env.clone(); wrong_out.delta_out = 451; // opening is to 450
        assert!(sc.fold_swap_var(&mut p, &wrong_out, op, &asset_a, &[0x01u8; 32], &path, &[0x02u8; 32], &path).is_err(), "receipt-opening mismatch rejected");

        // gate (6): can't draw more of the out-asset than the pool holds (the inflation floor). Build a
        // receipt that DOES open to an over-draw amount + a kernel for it, so only gate (6) trips.
        let mut p = mk_pool();
        let big = 6000u64; // > reserve_b 5000
        let c_big = compress(&(gen_h() * Scalar::from(big) + ProjectivePoint::generator() * scalar_reduce_be(&r_receipt_bytes)));
        let mut over = env.clone(); over.delta_out = big; over.c_receipt = c_big;
        assert!(sc.fold_swap_var(&mut p, &over, op, &asset_a, &[0x01u8; 32], &path, &[0x02u8; 32], &path).is_err(), "out-reserve over-draw rejected");
    }

    #[test]
    fn fold_swap_route_chains_value_and_fails_closed() {
        // 2-hop route A→M→B: pool1 (A,M) swaps A→M, pool2 (M,B) swaps M→B. The intermediate M (454)
        // flows pool-to-pool; the trader's 1000 A lands as 161 B in the receipt. Both hops respect the
        // constant-product k-floor (k_post ≥ k_pre): hop0 11000·4546 ≥ 10000·5000, hop1 8454·2839 ≥ 8000·3000.
        let a = [0xAAu8; 32];
        let m = [0xCCu8; 32];
        let b = [0xBBu8; 32];
        let pid1 = [0x11u8; 32];
        let pid2 = [0x22u8; 32];
        let op = ([0x77u8; 32], 1u32);
        let (in_mag, mid, out_amt) = (1000u64, 454u64, 161u64);
        let r_in = scalar_reduce_be(&[0x31u8; 32]);
        // c_in commits EXACTLY in_mag (sentinel change ⇒ residue = r_in·G; sign d = r_in).
        let c_in = compress(&(gen_h() * Scalar::from(in_mag) + ProjectivePoint::generator() * r_in));
        let msg = swap_var_kernel_msg(&a, op, &[0u8; 33], in_mag);
        let (_px, sig) = bip340_sign(&[0x31u8; 32], &[0x55u8; 32], &msg);
        let r_receipt = [0x44u8; 32];
        let c_receipt = compress(&(gen_h() * Scalar::from(out_amt) + ProjectivePoint::generator() * scalar_reduce_be(&r_receipt)));
        let env = bitcoin::SwapRouteEnvelope {
            n_hops: 2,
            trader_input_asset: a,
            trader_output_asset: b,
            hops: vec![
                bitcoin::SwapRouteHop { pool_id: pid1, direction: 0, r_a_pre: 10_000, r_b_pre: 5_000, delta_a_net_mag: in_mag, delta_b_net_mag: mid },
                bitcoin::SwapRouteHop { pool_id: pid2, direction: 0, r_a_pre: 8_000, r_b_pre: 3_000, delta_a_net_mag: mid, delta_b_net_mag: out_amt },
            ],
            c_in, c_receipt, r_receipt, kernel_sig: sig,
        };
        let path = KeccakTreeAccumulator::new().append_path(); // genesis note-append path (note_count 0)
        let setup = || {
            let mut sc = ScanReflection::genesis();
            sc.pools.insert(&pid1, PoolReserveState { asset_a: a, asset_b: m, reserve_a: 10_000, reserve_b: 5_000, total_shares: 7_000, c0_backed: true, protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0 });
            sc.pools.insert(&pid2, PoolReserveState { asset_a: m, asset_b: b, reserve_a: 8_000, reserve_b: 3_000, total_shares: 4_000, c0_backed: true, protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0 });
            sc
        };

        // happy path: folds + both pools advance (in += in_mag, out −= out_mag per hop).
        let mut sc = setup();
        assert!(sc.fold_swap_route(&env, op, &a, &[0x01u8; 32], &path).is_ok(), "valid 2-hop route folds");
        assert_eq!((sc.pools.get(&pid1).unwrap().reserve_a, sc.pools.get(&pid1).unwrap().reserve_b), (11_000, 4_546));
        assert_eq!((sc.pools.get(&pid2).unwrap().reserve_a, sc.pools.get(&pid2).unwrap().reserve_b), (8_454, 2_839));

        // broken value chain: hop 1's M-input ≠ hop 0's M-output ⇒ reject, no mutation.
        let mut sc = setup();
        let mut e = env.clone(); e.hops[1].delta_a_net_mag = 455;
        assert!(sc.fold_swap_route(&e, op, &a, &[0x01u8; 32], &path).is_err(), "broken value chain rejected");
        assert_eq!(sc.pools.get(&pid1).unwrap().reserve_a, 10_000, "no mutation on chain break");

        // all-or-nothing: a LATER hop's pool not C0-backed ⇒ the earlier (staged) hop is NOT committed.
        let mut sc = setup();
        let mut p2 = sc.pools.get(&pid2).unwrap(); p2.c0_backed = false; sc.pools.update(&pid2, p2);
        assert!(sc.fold_swap_route(&env, op, &a, &[0x01u8; 32], &path).is_err(), "non-C0-backed later hop rejected");
        assert_eq!(sc.pools.get(&pid1).unwrap().reserve_a, 10_000, "first hop not committed when a later hop fails");

        // final-hop over-draw: out 4000 > reserve_b 3000 (with a matching receipt) ⇒ reject.
        let mut sc = setup();
        let mut e = env.clone();
        e.hops[1].delta_b_net_mag = 4000;
        e.c_receipt = compress(&(gen_h() * Scalar::from(4000u64) + ProjectivePoint::generator() * scalar_reduce_be(&r_receipt)));
        assert!(sc.fold_swap_route(&e, op, &a, &[0x01u8; 32], &path).is_err(), "final-hop over-draw rejected");

        // bad input kernel (hop 0's input not really backed) ⇒ reject.
        let mut sc = setup();
        let mut e = env.clone(); e.kernel_sig[0] ^= 1;
        assert!(sc.fold_swap_route(&e, op, &a, &[0x01u8; 32], &path).is_err(), "bad input kernel rejected");

        // receipt opens to the WRONG final amount (162 ≠ 161) ⇒ reject (no over-stated output).
        let mut sc = setup();
        let mut e = env.clone();
        e.c_receipt = compress(&(gen_h() * Scalar::from(162u64) + ProjectivePoint::generator() * scalar_reduce_be(&r_receipt)));
        assert!(sc.fold_swap_route(&e, op, &a, &[0x01u8; 32], &path).is_err(), "receipt-opening mismatch rejected");

        // spent input of the wrong asset ⇒ reject.
        let mut sc = setup();
        assert!(sc.fold_swap_route(&env, op, &b, &[0x01u8; 32], &path).is_err(), "wrong spent input asset rejected");
    }

    /// Regression (REFL-LPADD): on a protocol-fee pool with swap-driven k-growth, an LP-add crystallizes the
    /// owed fee into BOTH total_shares and protocol_fee_accrued before minting the LP's proportional shares.
    /// The reflection must onboard the LP's share note as (total_shares delta − crystallized), NOT the raw
    /// delta — otherwise the crystallized shares mint twice (once into the LP note, once via the protocol-fee
    /// claim that reads protocol_fee_accrued), so Σ bridgeable LP-shares would exceed total_shares.
    #[test]
    fn lp_add_share_note_excludes_crystallized_protocol_fee() {
        let a = [0xa1u8; 32];
        let b = [0xb1u8; 32];
        // A 300-bps skim pool seeded at k_last = 1e12, then swap-grown to k = 1.6e13 ⇒ a fee is owed.
        let mut pool = PoolReserveState {
            asset_a: a, asset_b: b, reserve_a: 4_000_000, reserve_b: 4_000_000,
            total_shares: 1_000_000, c0_backed: true, protocol_fee_bps: 300,
            k_last: 1_000_000_000_000, protocol_fee_accrued: 0,
        };
        let pre_shares = pool.total_shares;
        let pre_accrued = pool.protocol_fee_accrued;

        // Mirror fold_lp_add variant 0: crystallize the fee, then mint the LP's proportional shares.
        let (da, db) = (4_000_000u64, 4_000_000u64);
        pool.crystallize_protocol_fee();
        let crystallized = pool.protocol_fee_accrued - pre_accrued;
        let minted = lp_add_shares(pool.total_shares, da, db, pool.reserve_a, pool.reserve_b) as u64;
        pool.reserve_a += da;
        pool.reserve_b += db;
        pool.total_shares += minted;

        assert!(crystallized > 0, "swap growth must accrue a protocol fee for this regression to be meaningful");
        // Fixed caller formula: delta − crystallized == the LP's own minted shares (no double-mint).
        let onboarded = pool.total_shares.saturating_sub(pre_shares).saturating_sub(crystallized);
        assert_eq!(onboarded, minted, "LP share note carries only the LP's minted shares");
        // The pre-fix formula (raw delta) over-mints by exactly the still-accrued fee — the double-mint amount.
        let buggy = pool.total_shares.saturating_sub(pre_shares);
        assert_eq!(buggy - onboarded, pool.protocol_fee_accrued, "raw delta double-counts the accrued protocol fee");
    }

    #[test]
    fn xcurve_secp_half_and_challenge_match_dapp_vector() {
        // A REAL cross-curve sigma from dapp/amm-sigma.js (generated by tests/_bjjvec.mjs; a=1992; the dapp's
        // own verifyXCurve returned true). This pins the secp half + the FS challenge byte-for-byte to the dapp.
        fn hexd(s: &str) -> Vec<u8> {
            (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
        }
        let proof = hexd("03589ac733552d5517d8aef7bdcc6f08ae185f68a30bbd630baf4bb6e03c52e517f136d5ff8e587f84e72a98c4b00012d148981373b75a7daf3a833bb16935ad8d8a12aa7982ee4cad3fec7c831f32d5df0cf673997497d7dcd3c22e19ae24f8a77a8f5f5849d4e0ddf7bd449ea48707967181040b83dc591f65a1ac12f9872e36132323b54a6303fe004d3129371fd7a0be9a4ad8caf0af536c324578b5c189f12e2864aa76aea0fd");
        assert_eq!(proof.len(), 169, "vector proof length");
        let c_secp: [u8; 33] = hexd("02e197540466a06dc7970601045b38ae034d4565ffbffd4de25da835ae9b13a805").try_into().unwrap();
        let c_bjj: [u8; 32] = hexd("8d49c4743526e7a8463c75f2d946aa4d3f43e429c1cfeefb8d53dd1ea09006a5").try_into().unwrap();
        let a_secp: [u8; 33] = proof[0..33].try_into().unwrap();
        let a_bjj: [u8; 32] = proof[33..65].try_into().unwrap();
        let z_a: [u8; 40] = proof[65..105].try_into().unwrap();
        let z_r_secp: [u8; 32] = proof[105..137].try_into().unwrap();

        let e = xcurve_challenge(&c_secp, &c_bjj, &a_secp, &a_bjj);
        assert!(xcurve_secp_check(&c_secp, &a_secp, &z_a, &z_r_secp, &e), "secp half of the real vector verifies");

        // fail-closed: tampered z_a, wrong challenge, non-canonical z_r_secp (all-0xff ≥ n).
        let mut z_bad = z_a; z_bad[0] ^= 1;
        assert!(!xcurve_secp_check(&c_secp, &a_secp, &z_bad, &z_r_secp, &e), "tampered z_a rejected");
        let mut e_bad = e; e_bad[0] ^= 1;
        assert!(!xcurve_secp_check(&c_secp, &a_secp, &z_a, &z_r_secp, &e_bad), "wrong challenge rejected");
        assert!(!xcurve_secp_check(&c_secp, &a_secp, &z_a, &[0xffu8; 32], &e), "non-canonical z_r_secp rejected");
    }

    #[test]
    fn swap_batch_aggregate_identity_binds_receipts_to_inputs() {
        // 1-intent direction-0 (A→B) batch, asset-A identity:
        // C_in − tip_A_C − δ_A·H == R_net_A·G. The caller separately proves tip_A_C opens to the Groth16-public
        // tip amount, so its blinding participates in R_net just like the worker.
        let v_in = 1000u64;
        let delta_a = 1000u64;
        let r_in = scalar_reduce_be(&[0x31u8; 32]);
        let r_tip = scalar_reduce_be(&[0x41u8; 32]);
        let c_in = compress(&(gen_h() * Scalar::from(v_in) + ProjectivePoint::generator() * r_in));
        let tip_c = compress(&(ProjectivePoint::generator() * r_tip));
        let mut r_net_a = [0u8; 32];
        r_net_a.copy_from_slice((r_in - r_tip).to_repr().as_slice());
        let intents = [(0u8, c_in)];
        let receipts = [c_in]; // direction-0 intent is INPUT-side for asset A ⇒ its receipt isn't summed here

        assert!(swap_batch_aggregate_identity(&intents, &receipts, true, 0, delta_a, &tip_c, &r_net_a), "valid asset-A identity holds");
        let mut bad_r = r_net_a; bad_r[31] ^= 1;
        assert!(!swap_batch_aggregate_identity(&intents, &receipts, true, 0, delta_a, &tip_c, &bad_r), "wrong R_net rejected");
        assert!(!swap_batch_aggregate_identity(&intents, &receipts, true, 0, delta_a + 1, &tip_c, &r_net_a), "wrong delta rejected");
        assert!(!swap_batch_aggregate_identity(&intents, &receipts, true, 1, delta_a, &tip_c, &r_net_a), "wrong delta sign rejected");
        let wrong_tip_c = compress(&(ProjectivePoint::generator() * (r_tip + Scalar::from(1u64))));
        assert!(!swap_batch_aggregate_identity(&intents, &receipts, true, 0, delta_a, &wrong_tip_c, &r_net_a), "wrong tip commitment rejected");
    }

    #[test]
    fn protocol_fee_shares_matches_uniswap_v2_formula() {
        // S=10000, bps=300, k grows 1e6 → 4e6 (√1000 → √2000):
        //   num = 10000·300·(2000−1000) = 3_000_000_000
        //   den = (10000−300)·2000 + 300·1000 = 19_700_000  ⇒ floor = 152.
        assert_eq!(protocol_fee_shares(10000, 1_000_000, 4_000_000, 300), 152);
        // guards: disabled fee, zero supply, no growth, no √-growth ⇒ 0.
        assert_eq!(protocol_fee_shares(10000, 1_000_000, 4_000_000, 0), 0, "bps 0");
        assert_eq!(protocol_fee_shares(0, 1_000_000, 4_000_000, 300), 0, "S 0");
        assert_eq!(protocol_fee_shares(10000, 4_000_000, 4_000_000, 300), 0, "no growth");
        assert_eq!(protocol_fee_shares(10000, 4_000_000, 1_000_000, 300), 0, "k shrank");
        assert_eq!(protocol_fee_shares(10000, 1_000_000, 1_000_001, 300), 0, "growth below a √-step");
        // wide inputs (no u128 overflow in the ~2^142 numerator): just must not panic + stay ≤ S-ish.
        let big = protocol_fee_shares(1u64 << 60, 1u128 << 100, 1u128 << 110, 1000);
        assert!(big > 0 && big < (1u64 << 60), "wide-input crystallization sane");
    }

    #[test]
    fn fold_protocol_fee_claim_crystallizes_and_onboards() {
        let pool_id = [0x40u8; 32];
        let (a, b) = ([0xAAu8; 32], [0xBBu8; 32]);
        // A 300-bps-protocol-fee pool, k_last = (1M)² at the last crystallization, then swap-grown to (4M)².
        let mk = || {
            let mut sc = ScanReflection::genesis();
            sc.pools.insert(&pool_id, PoolReserveState {
                asset_a: a, asset_b: b, reserve_a: 4_000_000, reserve_b: 4_000_000, total_shares: 1_000_000,
                c0_backed: true, protocol_fee_bps: 300, k_last: 1_000_000u128 * 1_000_000, protocol_fee_accrued: 0,
            });
            sc
        };
        // The fold crystallizes the swap-growth (1M·1M → 4M·4M) and requires claim == accrued.
        let expected = protocol_fee_shares(1_000_000, 1_000_000u128 * 1_000_000, 4_000_000u128 * 4_000_000, 300);
        assert!(expected > 0, "fee accrues on swap growth");
        let r = [0x44u8; 32];
        let c = compress(&(gen_h() * Scalar::from(expected) + ProjectivePoint::generator() * scalar_reduce_be(&r)));
        let path = KeccakTreeAccumulator::new().append_path();

        let mut sc = mk();
        assert!(sc.fold_protocol_fee_claim(&pool_id, expected, &c, &r, &[0x01u8; 32], &path).is_ok(), "exact claim folds");
        let pool = sc.pools.get(&pool_id).unwrap();
        assert_eq!(pool.protocol_fee_accrued, 0, "accrued reset after claim");
        assert_eq!(pool.total_shares, 1_000_000 + expected, "crystallized fee counted in total_shares");

        // fail-closed: claim ≠ accrued, claim 0, bad opening, no-protocol-fee pool.
        let mut sc = mk();
        assert!(sc.fold_protocol_fee_claim(&pool_id, expected + 1, &c, &r, &[0x01u8; 32], &path).is_err(), "claim != accrued rejected");
        let mut sc = mk();
        let wrong_c = compress(&(gen_h() * Scalar::from(expected + 1) + ProjectivePoint::generator() * scalar_reduce_be(&r)));
        assert!(sc.fold_protocol_fee_claim(&pool_id, expected, &wrong_c, &r, &[0x01u8; 32], &path).is_err(), "claim opening mismatch rejected");
        let mut sc = ScanReflection::genesis();
        sc.pools.insert(&pool_id, PoolReserveState {
            asset_a: a, asset_b: b, reserve_a: 4_000_000, reserve_b: 4_000_000, total_shares: 1_000_000,
            c0_backed: true, protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0,
        });
        assert!(sc.fold_protocol_fee_claim(&pool_id, 1, &c, &r, &[0x01u8; 32], &path).is_err(), "no-protocol-fee pool rejected");
    }

    #[test]
    fn pool_reserve_set_insert_get_update_root() {
        let mut s = PoolReserveSet::new();
        assert!(s.is_empty());
        let pid1 = [0x01u8; 32];
        let pid2 = [0x02u8; 32];
        let st = |ra, rb, backed| PoolReserveState {
            asset_a: [0xAAu8; 32], asset_b: [0xBBu8; 32], reserve_a: ra, reserve_b: rb, total_shares: 1_000, c0_backed: backed,
            protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0,
        };
        s.insert(&pid1, st(100, 200, true));
        s.insert(&pid2, st(300, 400, false));
        assert_eq!(s.len(), 2);
        let got = s.get(&pid1).expect("pid1 tracked");
        assert_eq!((got.reserve_a, got.reserve_b, got.c0_backed), (100, 200, true));
        assert!(s.get(&[0x09u8; 32]).is_none(), "untracked pool → None");

        // root is deterministic + sensitive to every committed field (reserves + the backing flag).
        let root0 = s.root();
        assert_eq!(root0, s.root(), "root deterministic");
        s.update(&pid1, st(101, 200, true)); // reserve_a changed
        assert_ne!(root0, s.root(), "root tracks reserve change");
        let r1 = s.root();
        s.update(&pid1, st(101, 200, false)); // c0_backed flipped
        assert_ne!(r1, s.root(), "root tracks the c0_backed flag");

        // from_sorted rejects an out-of-order / zero-key handoff (a forged resume can't sneak in).
        assert!(PoolReserveSet::from_sorted(vec![(pid2, st(1, 1, true)), (pid1, st(1, 1, true))]).is_none(), "unsorted rejected");
        assert!(PoolReserveSet::from_sorted(vec![([0u8; 32], st(1, 1, true))]).is_none(), "zero pool_id rejected");
    }

    fn lp_add_msg(variant: u8, pool_id: &[u8; 32], asset_x: &[u8; 32], delta_x: u64, share_amount: u64, share_csecp: &[u8; 33], inputs: &[([u8; 32], u32)]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(LP_ADD_KERNEL_DOMAIN);
        h.update([variant]);
        h.update(pool_id);
        h.update(asset_x);
        h.update(delta_x.to_le_bytes());
        h.update(share_amount.to_le_bytes());
        h.update(share_csecp);
        h.update([inputs.len() as u8]);
        for (txid, vout) in inputs {
            h.update(txid);
            h.update(vout.to_le_bytes());
        }
        h.finalize().into()
    }

    #[test]
    fn lp_add_kernel_verify_and_fold_pool_init() {
        let pid = [0x10u8; 32];
        let asset_a = [0xAAu8; 32];
        let asset_b = [0xBBu8; 32];
        let (da, db) = (1000u64, 4000u64);
        let share = 2000u64;
        let csc = [0x02u8; 33];
        // single input per side: C_in = delta·H + excess·G ⇒ key = excess·G; sign with `excess`.
        let op_a = [([0x71u8; 32], 0u32)];
        let xa = scalar_reduce_be(&[0x41u8; 32]);
        let cia = gen_h() * Scalar::from(da) + ProjectivePoint::generator() * xa;
        let (_pa, sa) = bip340_sign(&[0x41u8; 32], &[0x51u8; 32], &lp_add_msg(1, &pid, &asset_a, da, share, &csc, &op_a));
        let op_b = [([0x72u8; 32], 1u32)];
        let xb = scalar_reduce_be(&[0x42u8; 32]);
        let cib = gen_h() * Scalar::from(db) + ProjectivePoint::generator() * xb;
        let (_pb, sb) = bip340_sign(&[0x42u8; 32], &[0x52u8; 32], &lp_add_msg(1, &pid, &asset_b, db, share, &csc, &op_b));

        // kernel primitive: accept + reject tamper / wrong delta.
        assert!(lp_add_kernel_verify(1, &pid, &asset_a, da, share, &csc, &op_a, &[cia], &sa), "valid A kernel");
        let mut bad = sa; bad[63] ^= 1;
        assert!(!lp_add_kernel_verify(1, &pid, &asset_a, da, share, &csc, &op_a, &[cia], &bad), "tampered A sig rejected");
        assert!(!lp_add_kernel_verify(1, &pid, &asset_a, da + 1, share, &csc, &op_a, &[cia], &sa), "wrong delta_a rejected");

        // POOL_INIT (backed): pool registered with the seeded reserves + c0_backed.
        let mut sc = ScanReflection::genesis();
        assert!(sc.fold_lp_add(1, &pid, &asset_a, &asset_b, da, db, share, &csc, &op_a, &[cia], &sa, &op_b, &[cib], &sb, true, 0).is_ok(), "POOL_INIT folds");
        let p = sc.pools.get(&pid).expect("pool registered");
        assert_eq!((p.reserve_a, p.reserve_b, p.c0_backed), (da, db, true));
        // duplicate POOL_INIT → reject.
        assert!(sc.fold_lp_add(1, &pid, &asset_a, &asset_b, da, db, share, &csc, &op_a, &[cia], &sa, &op_b, &[cib], &sb, true, 0).is_err(), "duplicate POOL_INIT rejected");

        // bad B kernel → fold nothing (fresh pool id).
        let pid2 = [0x11u8; 32];
        let (_x, sa2) = bip340_sign(&[0x41u8; 32], &[0x51u8; 32], &lp_add_msg(1, &pid2, &asset_a, da, share, &csc, &op_a));
        let mut sc2 = ScanReflection::genesis();
        assert!(sc2.fold_lp_add(1, &pid2, &asset_a, &asset_b, da, db, share, &csc, &op_a, &[cia], &sa2, &op_b, &[cib], &[0u8; 64], true, 0).is_err(), "bad B kernel rejected");
        assert!(sc2.pools.get(&pid2).is_none(), "rejected POOL_INIT registered nothing");

        // POOL_INIT whose inputs aren't C0-backed ⇒ pool registered but NOT c0_backed (no swap can onboard).
        let pid3 = [0x12u8; 32];
        let (_y, sa3) = bip340_sign(&[0x41u8; 32], &[0x51u8; 32], &lp_add_msg(1, &pid3, &asset_a, da, share, &csc, &op_a));
        let (_z, sb3) = bip340_sign(&[0x42u8; 32], &[0x52u8; 32], &lp_add_msg(1, &pid3, &asset_b, db, share, &csc, &op_b));
        let mut sc3 = ScanReflection::genesis();
        assert!(sc3.fold_lp_add(1, &pid3, &asset_a, &asset_b, da, db, share, &csc, &op_a, &[cia], &sa3, &op_b, &[cib], &sb3, false, 0).is_ok());
        assert!(!sc3.pools.get(&pid3).unwrap().c0_backed, "unbacked pool is not c0_backed");

        // LP-add (variant 0) grows the first pool's reserves.
        let cia0 = gen_h() * Scalar::from(500u64) + ProjectivePoint::generator() * xa;
        let (_w, sa0) = bip340_sign(&[0x41u8; 32], &[0x51u8; 32], &lp_add_msg(0, &pid, &asset_a, 500, share, &csc, &op_a));
        let cib0 = gen_h() * Scalar::from(2000u64) + ProjectivePoint::generator() * xb;
        let (_v, sb0) = bip340_sign(&[0x42u8; 32], &[0x52u8; 32], &lp_add_msg(0, &pid, &asset_b, 2000, share, &csc, &op_b));
        assert!(sc.fold_lp_add(0, &pid, &asset_a, &asset_b, 500, 2000, share, &csc, &op_a, &[cia0], &sa0, &op_b, &[cib0], &sb0, true, 0).is_ok(), "LP-add grows reserves");
        let p2 = sc.pools.get(&pid).unwrap();
        assert_eq!((p2.reserve_a, p2.reserve_b), (da + 500, db + 2000), "reserves grew");

        // LP-add to an unregistered pool → reject (valid kernels, but no such pool).
        let pidu = [0x88u8; 32];
        let (_, sau) = bip340_sign(&[0x41u8; 32], &[0x51u8; 32], &lp_add_msg(0, &pidu, &asset_a, 100, share, &csc, &op_a));
        let ciau = gen_h() * Scalar::from(100u64) + ProjectivePoint::generator() * xa;
        let (_, sbu) = bip340_sign(&[0x42u8; 32], &[0x52u8; 32], &lp_add_msg(0, &pidu, &asset_b, 100, share, &csc, &op_b));
        let cibu = gen_h() * Scalar::from(100u64) + ProjectivePoint::generator() * xb;
        assert!(sc.fold_lp_add(0, &pidu, &asset_a, &asset_b, 100, 100, share, &csc, &op_a, &[ciau], &sau, &op_b, &[cibu], &sbu, true, 0).is_err(), "LP-add to unknown pool rejected");
    }

    fn lp_remove_msg(pid: &[u8; 32], share: u64, da: u64, db: u64, ra: &[u8; 33], rb: &[u8; 33], inputs: &[([u8; 32], u32)]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(LP_REMOVE_KERNEL_DOMAIN);
        h.update(pid);
        h.update(share.to_le_bytes());
        h.update(da.to_le_bytes());
        h.update(db.to_le_bytes());
        h.update(ra);
        h.update(rb);
        h.update([inputs.len() as u8]);
        for (txid, vout) in inputs {
            h.update(txid);
            h.update(vout.to_le_bytes());
        }
        h.finalize().into()
    }

    #[test]
    fn lp_remove_kernel_verify_and_fold_gates() {
        let pid = [0x20u8; 32];
        let asset_a = [0xAAu8; 32];
        let asset_b = [0xBBu8; 32];
        // pool: 1000 A / 4000 B, 2000 shares (isqrt(1000·4000)=2000), c0_backed.
        let mut base = ScanReflection::genesis();
        base.pools.insert(&pid, PoolReserveState { asset_a, asset_b, reserve_a: 1000, reserve_b: 4000, total_shares: 2000, c0_backed: true, protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0 });
        // burn 1000 shares (half) ⇒ delta_a = 500, delta_b = 2000.
        let (share, da, db) = (1000u64, 500u64, 2000u64);
        let op = [([0x73u8; 32], 0u32)];
        let x = scalar_reduce_be(&[0x61u8; 32]);
        let ci = gen_h() * Scalar::from(share) + ProjectivePoint::generator() * x; // LP-share input opens to `share`
        let ra = [0x62u8; 32];
        let rb = [0x63u8; 32];
        let recv_a = compress(&(gen_h() * Scalar::from(da) + ProjectivePoint::generator() * scalar_reduce_be(&ra)));
        let recv_b = compress(&(gen_h() * Scalar::from(db) + ProjectivePoint::generator() * scalar_reduce_be(&rb)));
        let (_p, sig) = bip340_sign(&[0x61u8; 32], &[0x64u8; 32], &lp_remove_msg(&pid, share, da, db, &recv_a, &recv_b, &op));
        let path = [[0u8; 32]; 32];
        let oa = [0x01u8; 32];
        let ob = [0x02u8; 32];

        // kernel primitive: accept + tamper reject.
        assert!(lp_remove_kernel_verify(&pid, share, da, db, &recv_a, &recv_b, &op, &[ci], &sig), "valid lp-remove kernel");
        let mut bad = sig; bad[63] ^= 1;
        assert!(!lp_remove_kernel_verify(&pid, share, da, db, &recv_a, &recv_b, &op, &[ci], &bad), "tampered sig rejected");

        // gate: pool not C0-backed.
        let mut s1 = base.clone();
        let mut p = s1.pools.get(&pid).unwrap(); p.c0_backed = false; s1.pools.update(&pid, p);
        assert!(s1.fold_lp_remove(&pid, share, da, db, &recv_a, &ra, &recv_b, &rb, &op, &[ci], &sig, &path, &oa, &path, &ob).is_err(), "non-C0-backed rejected");
        // gate: share > total (kernel never reached).
        let mut s2 = base.clone();
        assert!(s2.fold_lp_remove(&pid, 3000, da, db, &recv_a, &ra, &recv_b, &rb, &op, &[ci], &sig, &path, &oa, &path, &ob).is_err(), "share > total rejected");
        // gate: non-proportional withdrawal (delta_a off by one).
        let mut s3 = base.clone();
        assert!(s3.fold_lp_remove(&pid, share, da + 1, db, &recv_a, &ra, &recv_b, &rb, &op, &[ci], &sig, &path, &oa, &path, &ob).is_err(), "non-proportional rejected");
        // gate: bad share-burn kernel.
        let mut s4 = base.clone();
        assert!(s4.fold_lp_remove(&pid, share, da, db, &recv_a, &ra, &recv_b, &rb, &op, &[ci], &bad, &path, &oa, &path, &ob).is_err(), "bad kernel rejected");
        // gate: recv_b opening mismatch (valid kernel, wrong r_recv_b) — no over-stated withdrawal value.
        let mut s5 = base.clone();
        assert!(s5.fold_lp_remove(&pid, share, da, db, &recv_a, &ra, &recv_b, &[0u8; 32], &op, &[ci], &sig, &path, &oa, &path, &ob).is_err(), "recv_b opening mismatch rejected");
        // gate: unknown pool.
        let mut s6 = base.clone();
        assert!(s6.fold_lp_remove(&[0x99u8; 32], share, da, db, &recv_a, &ra, &recv_b, &rb, &op, &[ci], &sig, &path, &oa, &path, &ob).is_err(), "unknown pool rejected");
    }

    #[test]
    fn amm_pool_id_canonical_derivation_and_enumeration() {
        let a = [0x01u8; 32];
        let b = [0x02u8; 32];
        // canonical pair: (low, high) regardless of input order; identical rejected.
        assert_eq!(amm_canonical_pair(&a, &b), Some((a, b)));
        assert_eq!(amm_canonical_pair(&b, &a), Some((a, b)));
        assert!(amm_canonical_pair(&a, &a).is_none());
        // pool_id is order-independent + fee-sensitive (mirrors the worker).
        let id = amm_derive_pool_id_v1(&a, &b, 30).unwrap();
        assert_eq!(id, amm_derive_pool_id_v1(&b, &a, 30).unwrap(), "order-independent");
        assert_ne!(id, amm_derive_pool_id_v1(&a, &b, 100).unwrap(), "fee-sensitive");
        // enumeration finds the pool by its canonical assets (stored canonical only).
        let mut s = PoolReserveSet::new();
        s.insert(&id, PoolReserveState { asset_a: a, asset_b: b, reserve_a: 1, reserve_b: 1, total_shares: 1, c0_backed: true, protocol_fee_bps: 0, k_last: 0, protocol_fee_accrued: 0 });
        assert_eq!(s.pool_ids_for_assets(&a, &b), vec![id]);
        assert!(s.pool_ids_for_assets(&b, &a).is_empty(), "stored in canonical order only");
    }

    #[test]
    fn dec_to_be32_parses_and_rejects() {
        assert_eq!(dec_to_be32("0").unwrap(), [0u8; 32]);
        assert_eq!(dec_to_be32("1").unwrap()[31], 1);
        assert_eq!(&dec_to_be32("256").unwrap()[30..], &[1u8, 0u8]);
        // 2^248 - ish round-trip via a known value
        assert_eq!(dec_to_be32("255").unwrap()[31], 255);
        assert!(dec_to_be32("12a3").is_none(), "non-digit rejected");
        assert!(dec_to_be32("").map(|x| x == [0u8; 32]).unwrap_or(false), "empty = zero");
        // 2^256 overflows (1 followed by 77 digits > 2^256); 2^256 = 115792089237316195423570985008687907853269984665640564039457584007913129639936
        assert!(dec_to_be32("115792089237316195423570985008687907853269984665640564039457584007913129639936").is_none(), "2^256 overflows 32 bytes");
    }

    #[test]
    fn parse_swap_batch_ceremony_vk() {
        // Parse the REAL concluded-ceremony swap_batch vk (CANONICAL_AMM_VK_CID, CID-verified) into the
        // field-byte G16Vk — the foundation for baking BATCH_VK into the reflection guest.
        let v: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/swap_batch_vk.json")).unwrap();
        assert_eq!(v["nPublic"].as_u64().unwrap(), 123, "swap_batch has 123 public signals");
        assert_eq!(v["protocol"].as_str().unwrap(), "groth16");
        assert_eq!(v["curve"].as_str().unwrap(), "bn128");
        let g1 = |a: &serde_json::Value| -> G1Aff {
            (dec_to_be32(a[0].as_str().unwrap()).unwrap(), dec_to_be32(a[1].as_str().unwrap()).unwrap())
        };
        let g2 = |a: &serde_json::Value| -> G2Aff {
            (
                dec_to_be32(a[0][0].as_str().unwrap()).unwrap(), dec_to_be32(a[0][1].as_str().unwrap()).unwrap(),
                dec_to_be32(a[1][0].as_str().unwrap()).unwrap(), dec_to_be32(a[1][1].as_str().unwrap()).unwrap(),
            )
        };
        let ic: Vec<G1Aff> = v["IC"].as_array().unwrap().iter().map(&g1).collect();
        let vk = G16Vk {
            alpha1: g1(&v["vk_alpha_1"]),
            beta2: g2(&v["vk_beta_2"]),
            gamma2: g2(&v["vk_gamma_2"]),
            delta2: g2(&v["vk_delta_2"]),
            ic,
        };
        // IC = nPublic + 1; every G1/G2 element parsed to non-zero 32-byte field bytes (no overflow/garbage).
        assert_eq!(vk.ic.len(), 124, "IC length = nPublic + 1");
        assert_ne!(vk.alpha1.0, [0u8; 32]);
        assert_ne!(vk.beta2.0, [0u8; 32]);
        assert_ne!(vk.gamma2.0, [0u8; 32]);
        assert_ne!(vk.delta2.0, [0u8; 32]);
        assert!(vk.ic.iter().all(|(x, y)| *x != [0u8; 32] || *y != [0u8; 32]), "no all-zero IC point");
    }

    #[test]
    fn fold_farm_init_and_harvest_gates() {
        let pool_id = [0x40u8; 32];
        let launcher_pk = [0x02u8; 33];
        let reward_asset = [0xAAu8; 32];
        let farm_id = amm_derive_farm_id(&pool_id, &launcher_pk, &reward_asset, &[0x41u8; 32]);
        assert_eq!(farm_id, amm_derive_farm_id(&pool_id, &launcher_pk, &reward_asset, &[0x41u8; 32]), "farm_id deterministic");
        // FARM_INIT funding kernel: launcher's C_in − C_change = reward_total·H (swap-kernel shape).
        let reward_total = 1_000_000u64;
        let op = [0x77u8; 32];
        let (v_in, v_change) = (1_500_000u64, 500_000u64);
        let r_in = scalar_reduce_be(&[0x31u8; 32]);
        let excess = scalar_reduce_be(&[0x32u8; 32]);
        let r_change = r_in + excess;
        let c_in = compress(&(gen_h() * Scalar::from(v_in) + ProjectivePoint::generator() * r_in));
        let c_change = compress(&(gen_h() * Scalar::from(v_change) + ProjectivePoint::generator() * r_change));
        let msg = swap_var_kernel_msg(&reward_asset, (op, 0), &c_change, reward_total);
        let (_p, sig) = bip340_sign(&[0x32u8; 32], &[0x55u8; 32], &msg);
        let path = [[0u8; 32]; 32];

        // FARM_INIT registers a C0-backed treasury (a degenerate pool keyed by farm_id).
        let mut sc = ScanReflection::genesis();
        assert!(sc.fold_farm_init(&farm_id, &reward_asset, reward_total, (op, 0), &c_in, &c_change, &sig, true).is_ok(), "farm_init folds");
        let f = sc.pools.get(&farm_id).expect("farm registered");
        assert_eq!((f.asset_a, f.reserve_a, f.total_shares, f.c0_backed), (reward_asset, reward_total, 0, true));
        // duplicate + bad-kernel reject.
        assert!(sc.fold_farm_init(&farm_id, &reward_asset, reward_total, (op, 0), &c_in, &c_change, &sig, true).is_err(), "duplicate farm rejected");
        let farm2 = amm_derive_farm_id(&pool_id, &launcher_pk, &reward_asset, &[0x42u8; 32]);
        let mut bad = sig; bad[63] ^= 1;
        assert!(sc.fold_farm_init(&farm2, &reward_asset, reward_total, (op, 0), &c_in, &c_change, &bad, true).is_err(), "bad funding kernel rejected");

        // HARVEST gates (fail before the note append — no path needed).
        assert!(sc.fold_harvest(&[0x99u8; 32], 100, &[0x33u8; 32], &[0x01u8; 32], &path).is_err(), "unknown farm rejected");
        assert!(sc.fold_harvest(&farm_id, reward_total + 1, &[0x33u8; 32], &[0x01u8; 32], &path).is_err(), "reward > treasury rejected");
        assert!(sc.fold_harvest(&farm_id, 0, &[0x33u8; 32], &[0x01u8; 32], &path).is_err(), "zero reward rejected");
        let mut f2 = sc.pools.get(&farm_id).unwrap(); f2.c0_backed = false; sc.pools.update(&farm_id, f2);
        assert!(sc.fold_harvest(&farm_id, 100, &[0x33u8; 32], &[0x01u8; 32], &path).is_err(), "non-C0-backed farm rejected");
    }

    #[test]
    fn fold_lp_share_mint_binds_value() {
        let pool_id = [0x50u8; 32];
        // lp_asset_id distinct from the EVM lp_share_id (different hash + domain).
        assert_ne!(amm_derive_lp_asset_id(&pool_id), lp_share_id(&pool_id), "Bitcoin lp_asset != EVM lp_share_id");
        assert_eq!(amm_derive_lp_asset_id(&pool_id), amm_derive_lp_asset_id(&pool_id), "deterministic");
        let lp_shares = 1990u64;
        let r = [0x71u8; 32];
        let share = compress(&(gen_h() * Scalar::from(lp_shares) + ProjectivePoint::generator() * scalar_reduce_be(&r)));
        let path = [[0u8; 32]; 32];
        let mut sc = ScanReflection::genesis();
        // gates (fail before the note append — no valid path needed):
        assert!(sc.fold_lp_share_mint(&pool_id, 0, &share, &r, &path, &[0x01u8; 32]).is_err(), "zero shares rejected");
        assert!(sc.fold_lp_share_mint(&pool_id, lp_shares + 1, &share, &r, &path, &[0x01u8; 32]).is_err(), "value-mismatch (over-claim) rejected");
        assert!(sc.fold_lp_share_mint(&pool_id, lp_shares, &share, &[0u8; 32], &path, &[0x01u8; 32]).is_err(), "wrong blinding rejected");
    }

    // REFLECT-1 regression: the reflection prover must NOT fold a confirmed CXFER tx's outputs into
    // bitcoinPoolRoot unless the tx CONSERVES value. Bitcoin consensus never checks the Tacit kernel
    // (the envelope is witness bytes), so a confirmed tx can declare an inflated output commitment;
    // before this gate (`fold_cxfer` → `verify_cxfer_conservation`) the per-output fold appended it
    // into the pool root, making unbacked value spendable cross-lane on Ethereum (value from nothing).
    #[test]
    fn reflection_cxfer_fold_rejects_nonconserving_outputs() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/cxfer_kernel.json")).unwrap();
        let asset = arr32(f["asset"].as_str().unwrap());
        let inputs: Vec<([u8; 32], u32)> = f["inputs"].as_array().unwrap().iter()
            .map(|i| (arr32(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
        let in_pts: Vec<ProjectivePoint> = f["inputs"].as_array().unwrap().iter()
            .map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();
        let outs: Vec<[u8; 33]> = f["outputs"].as_array().unwrap().iter()
            .map(|o| arr33(o["commitment"].as_str().unwrap())).collect();
        let sig: [u8; 64] = hex::decode(strip(f["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();

        // The conserved tx's kernel verifies (Σ C_in = Σ C_out).
        assert!(cxfer_kernel_verify(&asset, &inputs, &in_pts, &outs, 0, &sig), "conserved cxfer kernel verifies");

        // Inflate output[0] by 1_000_000·H: still a valid curve point that yields a well-formed leaf
        // (shape-binding CANNOT catch inflation), but the kernel now rejects it (Σ_out ≠ Σ_in).
        let inflated_pt = decompress(&outs[0]).unwrap() + gen_h() * Scalar::from(1_000_000u64);
        let mut inflated = outs.clone();
        inflated[0] = compress(&inflated_pt);
        assert!(reflected_note_leaf(&asset, &inflated[0]).is_some(),
            "inflated commitment still yields a well-formed leaf — shape-binding misses value inflation");
        assert!(!cxfer_kernel_verify(&asset, &inputs, &in_pts, &inflated, 0, &sig),
            "inflated cxfer output rejected by the conservation kernel");

        // The FOLD path fails closed: fold_cxfer rejects the non-conserving tx and folds NOTHING, so
        // the pool root / note count are unchanged (no phantom note enters the pool; the spends are
        // nullified separately by the caller). A real-PoW positive-fold round-trip is exercised by the
        // reflection round-trip fixture; here we lock the inflation REJECT the missing gate let through.
        let mut sc = ScanReflection::genesis();
        let pool_before = sc.pool_root;
        let notes_before = sc.note_count;
        let paths: Vec<Vec<[u8; 32]>> = (0..inflated.len()).map(|_| vec![[0u8; 32]; KECCAK_TREE_DEPTH]).collect();
        let vouts: Vec<u32> = (0..inflated.len() as u32).collect();
        let txid = arr32("0x7777777777777777777777777777777777777777777777777777777777777777");
        // No range proof in the kernel fixture → verify_range fails → fold rejects (fail-closed: a
        // cxfer with a missing/short range proof also injects nothing).
        // input_assets all == the envelope asset, so the rejection here is purely the conservation
        // failure (asset preservation is exercised separately in scan_reflection_rejects_asset_relabel).
        let in_assets = vec![asset; in_pts.len()];
        let res = sc.fold_cxfer(&asset, &inputs, &in_pts, &in_assets, &txid, &inflated, &paths, &vouts, &[], &sig);
        assert!(res.is_err(), "fold_cxfer rejects a non-conserving cxfer tx");
        assert_eq!(sc.pool_root, pool_before, "rejected cxfer folds NO output (pool root unchanged)");
        assert_eq!(sc.note_count, notes_before, "rejected cxfer appends no note");
    }

    // ASSET-PRESERVATION (cross-asset inflation): the reflection's CXFER conservation is value-ONLY
    // (Σ C_in = Σ C_out; the kernel only labels its message with `asset`). A confirmed Bitcoin CXFER
    // can therefore spend a CHEAP-asset pool note and declare a DEAR-asset output of equal
    // commitment-value: value conserves, asset flips, and the dear note becomes bridge-mintable on
    // Ethereum (value from nothing). The EVM lane is immune — `leaf(asset,…)` membership binds the
    // spend's asset — but the reflection resolved inputs through an (asset-blind) live UTXO set, so
    // it could not. The fix carries each note's asset in the live set and makes `fold_cxfer` require
    // every spent note's asset == the envelope's. This pins the property on a GENUINELY conserving
    // fixture: conservation PASSES, so the asset-preservation check is the SOLE defense — pre-fix
    // this exact fold minted the relabeled note.
    #[test]
    fn scan_reflection_cxfer_fold_rejects_asset_relabel() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        let v = f["vectors"].as_array().unwrap().iter()
            .find(|x| x["name"].as_str() == Some("conserving_m1")).expect("conserving_m1 vector");

        // The CXFER envelope's declared asset (the DEAR asset the attacker wants to mint), and a
        // genuinely value-conserving 1-in/1-out kernel + range proof signed under it.
        let envelope_asset = arr32(v["asset"].as_str().unwrap());
        let in_txid = arr32(v["inputs"][0]["txid"].as_str().unwrap());
        let in_vout = v["inputs"][0]["vout"].as_u64().unwrap() as u32;
        let in_pt = decompress(&arr33(v["inputs"][0]["commitment"].as_str().unwrap())).unwrap();
        let out_c = arr33(v["outsCompressed"][0].as_str().unwrap());
        let sig: [u8; 64] = hex::decode(strip(v["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();
        let rp = hex::decode(strip(v["rangeProof"].as_str().unwrap())).unwrap();

        let in_outpoints = vec![(in_txid, in_vout)];
        let in_pts = vec![in_pt];
        // Conservation genuinely PASSES for this (input, output, asset, sig, rp) — so the ONLY thing
        // that can stop the relabel is the asset-preservation gate.
        assert!(verify_cxfer_conservation(&envelope_asset, &in_outpoints, &in_pts, &[out_c], &rp, &sig),
            "fixture cxfer conserves value (the asset check is the sole defense)");

        // The single output appends at genesis index 0 → the append path is the empty-tree zeros path.
        let txid = arr32("0x9999999999999999999999999999999999999999999999999999999999999999");
        let note_path = KeccakTreeAccumulator::new().append_path();
        let vouts = vec![0u32];

        // ── The attack ── the spent note's REAL asset (recorded in the live set when it was created)
        // is a DIFFERENT, cheaper asset than the envelope declares.
        let cheap_asset = arr32("0x00000000000000000000000000000000000000000000000000000000c4eac4ea");
        assert_ne!(cheap_asset, envelope_asset);
        let mut attacked = ScanReflection::genesis();
        let pool_before = attacked.pool_root;
        let res = attacked.fold_cxfer(
            &envelope_asset, &in_outpoints, &in_pts, &[cheap_asset], &txid,
            &[out_c], &[note_path.clone()], &vouts, &rp, &sig,
        );
        assert_eq!(res, Err("cxfer fold: non-asset-preserving (input asset != envelope asset)"),
            "a value-conserving CXFER that RELABELS a cheap-asset note as the dear envelope asset is rejected");
        assert_eq!(attacked.pool_root, pool_before, "relabel folds NO output (pool root unchanged) — no dear note minted");
        assert_eq!(attacked.note_count, 0, "relabel appends no note");
        assert!(attacked.live.is_empty(), "relabel adds no live outpoint");

        // ── The honest path ── input note's asset == the envelope asset → the conserving cxfer folds.
        let mut honest = ScanReflection::genesis();
        honest.fold_cxfer(
            &envelope_asset, &in_outpoints, &in_pts, &[envelope_asset], &txid,
            &[out_c], &[note_path], &vouts, &rp, &sig,
        ).expect("an asset-preserving conserving cxfer folds");
        assert_eq!(honest.note_count, 1, "honest fold appends the output note");
        assert_ne!(honest.pool_root, pool_before, "honest fold advances the pool root");
        let outpoint = outpoint_key(&txid, 0);
        let ch = commitment_hash_compressed(&out_c).unwrap();
        assert_eq!(honest.live.get(&outpoint), Some((ch, envelope_asset)),
            "the new note is live under the envelope asset");
    }

    // REFLECT-1 DIFFERENTIAL: the guest reads a cxfer's output witnesses ONLY when
    // verify_cxfer_conservation accepts; the JS assembler (dapp verifyCxferConservation) emits them
    // under the SAME condition. If the two predicates ever DISAGREE (one accepts, the other rejects)
    // for some confirmed envelope, the witness stream desyncs → wrong roots / a panic. This pins the
    // Rust verdict against the JS verdict, byte-for-byte, on a battery of adversarial envelopes
    // (inflated, tampered sig/range, reordered, mismatched range, non-canonical point, zero point,
    // zero-input mint-from-nothing). Vectors + the JS verdict are generated by
    // tests/gen-cxfer-conservation-differential.mjs (run with the dapp's own secp/BP+).
    #[test]
    fn cxfer_conservation_matches_js_verdict() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        for v in f["vectors"].as_array().unwrap() {
            let name = v["name"].as_str().unwrap();
            let asset = arr32(v["asset"].as_str().unwrap());
            let in_outpoints: Vec<([u8; 32], u32)> = v["inputs"].as_array().unwrap().iter()
                .map(|i| (arr32(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
            let in_points: Vec<ProjectivePoint> = v["inputs"].as_array().unwrap().iter()
                .map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();
            let outs: Vec<[u8; 33]> = v["outsCompressed"].as_array().unwrap().iter()
                .map(|o| arr33(o.as_str().unwrap())).collect();
            let sig: [u8; 64] = hex::decode(strip(v["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();
            let rp = hex::decode(strip(v["rangeProof"].as_str().unwrap())).unwrap();

            let rust = verify_cxfer_conservation(&asset, &in_outpoints, &in_points, &outs, &rp, &sig);
            // A JS "throw" (a wiring bug, missing field) has no Rust analog — only true/false vectors
            // are differential. All generated vectors are well-formed (no missing field), so jsVerdict
            // is a bool here.
            let js = v["jsVerdict"].as_bool()
                .unwrap_or_else(|| panic!("vector {name} jsVerdict not a bool: {:?}", v["jsVerdict"]));
            assert_eq!(rust, js, "REFLECT-1 desync: vector '{name}' — Rust verify_cxfer_conservation={rust} but JS verifyCxferConservation={js}");
        }
    }

    // The UTXO accumulator: add outpoints, resolve them (get), prove membership against
    // the live root, then spend (remove) — a spent outpoint resolves to None and its
    // membership leaf no longer folds to the root, while live siblings still do.
    #[test]
    fn utxo_accumulator_add_resolve_spend() {
        let key = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let val = |b: u8| { let mut v = [0u8; 32]; v[0] = b; v };
        let mut u = UtxoAccumulator::new();
        let empty_root = u.root();

        // add three outpoints (out of order), each carrying its note's ν as value
        u.insert(&key(0x20), &val(0xb2));
        u.insert(&key(0x10), &val(0xa1));
        u.insert(&key(0x30), &val(0xc3));
        assert_ne!(u.root(), empty_root, "root advanced on inserts");

        // resolve: get returns the stored ν
        assert_eq!(u.get(&key(0x10)), Some(val(0xa1)), "resolve 0x10");
        assert_eq!(u.get(&key(0x99)), None, "unknown outpoint");

        // membership of a live outpoint folds to the current root
        let (idx, next, value) = u.membership(&key(0x10)).expect("0x10 live");
        assert_eq!(value, val(0xa1));
        // rebuild the same tree the accumulator commits, to get the path
        let leaves: Vec<[u8; 32]> = (0..u.nodes.len()).map(|i| u.leaf_at(i)).collect();
        let root = keccak_merkle_root(&leaves);
        assert_eq!(root, u.root(), "rebuilt root == accumulator root");
        assert_eq!(leaves[idx], utxo_leaf(&key(0x10), &next, &value), "membership leaf at index");

        // spend it: resolve→None, and its leaf position is now a tombstone (0)
        u.remove(&key(0x10));
        assert_eq!(u.get(&key(0x10)), None, "spent outpoint no longer resolves");
        assert!(u.membership(&key(0x10)).is_none(), "spent outpoint has no membership");
        assert_eq!(u.leaf_at(idx), [0u8; 32], "spent leaf tombstoned to 0");
        // siblings still resolve
        assert_eq!(u.get(&key(0x20)), Some(val(0xb2)), "sibling 0x20 still live");
        assert_eq!(u.get(&key(0x30)), Some(val(0xc3)), "sibling 0x30 still live");
        // double-spend panics (tested via catch in a separate #[should_panic] below)
    }

    #[test]
    #[should_panic(expected = "outpoint not in the UTXO set")]
    fn utxo_double_spend_panics() {
        let key = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let mut u = UtxoAccumulator::new();
        u.insert(&key(0x10), &[7u8; 32]);
        u.remove(&key(0x10));
        u.remove(&key(0x10)); // already spent
    }

    // NEG-1 / NEG-2: the bridge_mint authority binding (guest `main.rs`: bm_leaf = utxo_leaf(ν,
    // bm_next, dest_leaf); keccak_merkle_verify(bm_leaf, …, bitcoin_burn_root)). Only a note
    // explicitly BURNED FOR THE BRIDGE — ν a live key in the dedicated bridge-burn set — bound to the
    // destination the burn declared (its stored value == the Ethereum-minted leaf) can be minted on
    // Ethereum. (NEG-1) An ordinarily-spent ν is absent from the burn set, so it cannot prove
    // membership (it lives in the spent set, never the burn set) → no cross-chain value duplication.
    // (NEG-2) The mint cannot be redirected to a destination the burn did not declare. The contract
    // sees only the burn-root, never this in-guest check, so no contract test reaches it; this locks
    // the §6 inflation / mint-redirection rejects.
    #[test]
    fn bridge_mint_burn_membership_binds_nu_and_destination() {
        let zeros = keccak_zeros();
        let build_path = |leaves: &[[u8; 32]], mut idx: usize| -> Vec<[u8; 32]> {
            let mut level = leaves.to_vec();
            let mut path: Vec<[u8; 32]> = Vec::new();
            for lvl in 0..KECCAK_TREE_DEPTH {
                let s = idx ^ 1;
                path.push(if s < level.len() { level[s] } else { zeros[lvl] });
                let mut next: Vec<[u8; 32]> = Vec::new();
                let mut k = 0;
                while k * 2 < level.len() {
                    let l = level[2 * k];
                    let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[lvl] };
                    next.push(kn(&[&l, &r]));
                    k += 1;
                }
                level = next;
                idx >>= 1;
            }
            path
        };

        let nu = { let mut x = [0u8; 32]; x[31] = 0xaa; x };        // a burned note's ν
        let dest_leaf = { let mut x = [0u8; 32]; x[0] = 0xd0; x };  // the ETH-minted leaf the burn declared
        let other_nu = { let mut x = [0u8; 32]; x[31] = 0xbb; x };  // an ordinarily-spent (non-bridged) ν

        // The bridge-burn set: only genuine bridge-outs land here (ν → declared dest_leaf).
        let mut burns = UtxoAccumulator::new();
        burns.insert(&nu, &dest_leaf);
        let burn_root = burns.root();
        let leaves = burns.leaves();
        let (idx, next, value) = burns.membership(&nu).expect("ν is a member of the bridge-burn set");
        assert_eq!(value, dest_leaf, "the burn set binds ν to the destination it declared");
        let path = build_path(&leaves, idx);

        // HONEST: ν bound to its declared destination proves membership → mintable.
        assert!(keccak_merkle_verify(&utxo_leaf(&nu, &next, &dest_leaf), idx as u64, &path, &burn_root),
            "a genuine bridge-burn (ν → dest_leaf) proves membership in bitcoinBurnRoot");

        // NEG-2 (redirect): the SAME ν + witness but a DIFFERENT minted destination → the preimage
        // (utxo_leaf binds dest_leaf as its value field) differs → membership fails.
        let redirected = { let mut x = [0u8; 32]; x[0] = 0xd1; x };
        assert_ne!(redirected, dest_leaf);
        assert!(!keccak_merkle_verify(&utxo_leaf(&nu, &next, &redirected), idx as u64, &path, &burn_root),
            "redirecting the mint to a destination the burn never declared is rejected (no mint redirection)");

        // NEG-1 (ordinary spend): an ordinarily-spent ν is NOT in the bridge-burn set, so no honest
        // witness exists; even reusing the genuine member's slot, the preimage differs from any real
        // leaf, so membership fails.
        assert!(burns.membership(&other_nu).is_none(), "an ordinarily-spent ν is absent from the bridge-burn set");
        assert!(!keccak_merkle_verify(&utxo_leaf(&other_nu, &next, &dest_leaf), idx as u64, &path, &burn_root),
            "an ordinarily-spent ν cannot prove bridge-burn membership → not mintable (no cross-chain inflation)");
    }

    // The UTXO-model transfer fold: an output creates an outpoint→ν UTXO + a note leaf;
    // a later transfer consumes that outpoint, inserting its ν into the spent set and
    // removing it from the UTXO set. The committed roots advance; state_digest binds the
    // UTXO root for resumption.
    #[test]
    fn reflection_apply_transfer_utxo_model() {
        let outpoint = arr32("0x00000000000000000000000000000000000000000000000000000000000000a1");
        let note_leaf = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let ch1 = arr32("0x00000000000000000000000000000000000000000000000000000000000000c1"); // keccak(C_out)
        let nu1 = arr32("0x0000000000000000000000000000000000000000000000000000000000000033"); // the note's ν

        let mut s = ReflectionState::genesis();
        let d0 = s.state_digest();

        // block 1: a transfer with one output (a new note/UTXO), no inputs
        s.apply_transfer(&[], &[(outpoint, note_leaf, ch1)], 800_000);
        assert_eq!(s.utxo.get(&outpoint), Some(ch1), "outpoint → commitment hash");
        assert!(s.spent.non_membership_low(&nu1).is_some(), "ν not yet spent");
        let (_, _, h1) = s.commit();
        assert_eq!(h1, 800_000);
        assert_ne!(s.state_digest(), d0, "state advanced");

        // block 2: a transfer consuming that outpoint — the guest witnessed its commitment,
        // verified keccak(C) == ch1, and derived ν = nu1, which it passes in with the input
        let out2 = arr32("0x00000000000000000000000000000000000000000000000000000000000000b2");
        let leaf2 = arr32("0x2222222222222222222222222222222222222222222222222222222222222222");
        let ch2 = arr32("0x00000000000000000000000000000000000000000000000000000000000000c2");
        s.apply_transfer(&[(outpoint, nu1)], &[(out2, leaf2, ch2)], 800_001);

        assert_eq!(s.utxo.get(&outpoint), None, "spent outpoint removed from UTXO set");
        assert!(s.spent.non_membership_low(&nu1).is_none(), "ν is now in the spent set");
        assert_eq!(s.utxo.get(&out2), Some(ch2), "new output → commitment hash");
        assert_eq!(s.notes.next_index(), 2, "two note leaves appended");
        let (_, _, h2) = s.commit();
        assert_eq!(h2, 800_001);
    }

    // F4 full-scan: the live UTXO set rebuilds + root-checks from sorted contents (the O(live)
    // verify-once step), resolves outpoints, and folds an output/spend with the committed root
    // advancing — and rejects an out-of-order / zero-key handoff.
    #[test]
    fn live_utxo_set_rebuild_and_mutate() {
        let key = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let val = |b: u8| { let mut v = [0u8; 32]; v[0] = b; v };
        let ast = |b: u8| { let mut a = [0u8; 32]; a[1] = b; a }; // a distinct asset_id per entry

        // a handed set must be strictly ascending, non-zero (by key)
        assert!(LiveUtxoSet::from_sorted(vec![(key(0x10), val(1), ast(1)), (key(0x20), val(2), ast(2))]).is_some());
        assert!(LiveUtxoSet::from_sorted(vec![(key(0x20), val(2), ast(2)), (key(0x10), val(1), ast(1))]).is_none(), "unsorted rejected");
        assert!(LiveUtxoSet::from_sorted(vec![(key(0x10), val(1), ast(1)), (key(0x10), val(2), ast(2))]).is_none(), "duplicate rejected");
        assert!(LiveUtxoSet::from_sorted(vec![([0u8; 32], val(1), ast(1))]).is_none(), "zero key rejected");

        let mut live = LiveUtxoSet::from_sorted(vec![(key(0x10), val(0xa1), ast(0xa)), (key(0x30), val(0xc3), ast(0xc))]).unwrap();
        assert_eq!(live.root(), LiveUtxoSet::from_sorted(vec![(key(0x10), val(0xa1), ast(0xa)), (key(0x30), val(0xc3), ast(0xc))]).unwrap().root(), "root is contents-determined");
        assert_eq!(live.get(&key(0x10)), Some((val(0xa1), ast(0xa))), "resolve → (commitment hash, asset)");
        assert_eq!(live.get(&key(0x99)), None);
        // the asset is committed into the root: same key/value, different asset → different root
        assert_ne!(live.root(), LiveUtxoSet::from_sorted(vec![(key(0x10), val(0xa1), ast(0xa)), (key(0x30), val(0xc3), ast(0xd))]).unwrap().root(), "asset bound into the root");
        let r0 = live.root();

        // an output inserts in key order; a spend removes; the root tracks the live contents
        live.insert(&key(0x20), &val(0xb2), &ast(0xb));
        assert_eq!(live.get(&key(0x20)), Some((val(0xb2), ast(0xb))));
        assert_ne!(live.root(), r0, "root advanced on insert");
        assert_eq!(live.remove(&key(0x20)), (val(0xb2), ast(0xb)), "remove returns the stored (commitment, asset)");
        assert_eq!(live.root(), r0, "insert+remove of the same key restores the root");
        assert_eq!(live.get(&key(0x20)), None, "spent outpoint no longer resolves");
    }

    // Parity anchor for tests/confidential-reflection-scan.mjs (LIVE2_ROOT): the asset-committed
    // live-set root for a known 2-entry set, so JS == Rust on the keccak(key‖asset‖value) leaf order.
    #[test]
    fn live_utxo_set_root_with_asset_pin() {
        let last = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let first = |b: u8| { let mut x = [0u8; 32]; x[0] = b; x };
        let live = LiveUtxoSet::from_sorted(vec![
            (last(0x10), first(0xa1), first(0xaa)),
            (last(0x30), first(0xc3), first(0xbb)),
        ]).unwrap();
        assert_eq!(
            hex::encode(live.root()),
            "0b4c5da8728e3216a451be798a8d9326513e018880e1755bffd582f084718faa",
            "LIVE2_ROOT (asset-committed live-set root) — keep in sync with tests/confidential-reflection-scan.mjs"
        );
    }

    // F4 full-scan: scan a REAL confirmed tx's vins against a live set seeded with its first
    // input outpoint → the spend is detected, ν is derived + bound to the stored commitment, and
    // the outpoint is removed. A set without that outpoint detects nothing; a forged opening that
    // doesn't bind to the stored commitment is a hard reject.
    #[test]
    fn scan_tx_spends_detects_real_vin() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let inputs = bitcoin::extract_inputs(&tx).expect("real tx inputs");
        let (in_txid, in_vout) = inputs[0];
        let outpoint = outpoint_key(&in_txid, in_vout);

        // a note (Cx,Cy) whose commitment_hash is what the live set stores at that outpoint
        let cx = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let cy = arr32("0x2222222222222222222222222222222222222222222222222222222222222222");
        let stored = commitment_hash(&cx, &cy);
        let asset = arr32("0x00000000000000000000000000000000000000000000000000000000000000aa");

        let mut live = LiveUtxoSet::from_sorted(vec![(outpoint, stored, asset)]).unwrap();
        let before = live.root();
        let spends = scan_tx_spends(&tx, &mut live, || (cx, cy)).expect("scan honest tx");
        assert_eq!(spends.len(), 1, "the seeded pool outpoint is detected as a spend");
        assert_eq!((spends[0].outpoint, spends[0].nu), (outpoint, nullifier(&cx, &cy)), "ν derived + bound to the stored commitment");
        assert_eq!((spends[0].prev_txid, spends[0].prev_vout), (in_txid, in_vout), "raw prev-outpoint surfaced for the conservation kernel");
        assert_eq!((spends[0].cx, spends[0].cy), (cx, cy), "spent commitment coords surfaced (Σ C_in)");
        assert_eq!(spends[0].asset, asset, "spent note's asset surfaced (CXFER fold asset-preservation)");
        assert!(live.is_empty(), "the spent outpoint is removed from the live set");
        assert_ne!(live.root(), before, "live root advanced on the spend");

        // a live set that doesn't contain any of the tx's vins → no pool spend
        let mut other = LiveUtxoSet::from_sorted(vec![(arr32("0x00000000000000000000000000000000000000000000000000000000000000ff"), stored, asset)]).unwrap();
        let none = scan_tx_spends(&tx, &mut other, || (cx, cy)).expect("scan unrelated tx");
        assert!(none.is_empty(), "a tx spending no pool UTXO yields no spends");

        // an opening that doesn't open the stored commitment is rejected (forged ν)
        let mut live2 = LiveUtxoSet::from_sorted(vec![(outpoint, stored, asset)]).unwrap();
        let bad = scan_tx_spends(&tx, &mut live2, || (cy, cx)); // swapped → wrong commitment_hash
        assert!(bad.is_none(), "an opening not binding to the stored commitment is a hard reject");
    }

    // H-1: bridge_mint must authorize only against the bridge-burn set, not the all-spends
    // set. An ordinary Bitcoin spend's ν enters `spent` but NOT `bridge_burns`, so it has no
    // bridge-burn membership (bridge_mint can't mint it). A cross-chain burn's ν enters BOTH,
    // and `bridge_burns` binds it to the declared destCommitment.
    #[test]
    fn bridge_burn_set_excludes_ordinary_spends() {
        let op_a = arr32("0x00000000000000000000000000000000000000000000000000000000000000a1");
        let op_b = arr32("0x00000000000000000000000000000000000000000000000000000000000000b2");
        let ch = arr32("0x00000000000000000000000000000000000000000000000000000000000000c0");
        let leaf_x = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let nu_ord = arr32("0x0000000000000000000000000000000000000000000000000000000000000041"); // ordinary spend ν
        let nu_brn = arr32("0x0000000000000000000000000000000000000000000000000000000000000042"); // bridge-out ν
        let dest = arr32("0x2222222222222222222222222222222222222222222222222222222222222222"); // destCommitment

        let mut s = ReflectionState::genesis();
        // two outputs → two live UTXOs
        s.apply_transfer(&[], &[(op_a, leaf_x, ch), (op_b, leaf_x, ch)], 900_000);

        // op_a spent in an ORDINARY transfer; op_b BURNED for the bridge
        s.apply_transfer(&[(op_a, nu_ord)], &[], 900_001);
        s.apply_bridge_out(&op_b, &nu_brn, &dest, 900_002);

        // both ν are spent (cross-lane serialization holds for both)
        assert!(s.spent.non_membership_low(&nu_ord).is_none(), "ordinary ν spent");
        assert!(s.spent.non_membership_low(&nu_brn).is_none(), "burn ν spent");

        // but ONLY the bridge-out's ν is in the bridge-burn set, bound to its destCommitment
        assert_eq!(s.bridge_burns.get(&nu_ord), None, "ordinary spend NOT mintable (H-1)");
        assert_eq!(s.bridge_burns.get(&nu_brn), Some(dest), "burn mintable, bound to dest");
        assert_ne!(s.bridge_burn_root(), [0u8; 32], "burn root is the non-zero sentinel-seeded set");
    }

    // JS↔Rust cross-impl KAT for the bridge-burn (UTXO) accumulator. The JS witness builder
    // (dapp makeUtxoAccumulator) and this Rust prover MUST agree on the root, or a JS-built
    // bridge_mint witness won't verify against the Rust-proven bitcoinBurnRoot. Expected root
    // computed by dapp/confidential-pool.js for the same two (key → value) inserts.
    #[test]
    fn utxo_accumulator_root_matches_js() {
        let k1 = arr32("0x0000000000000000000000000000000000000000000000000000000000000007");
        let v1 = arr32("0x0000000000000000000000000000000000000000000000000000000000000099");
        let k2 = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let v2 = arr32("0x2222222222222222222222222222222222222222222222222222222222222222");
        let mut u = UtxoAccumulator::new();
        u.insert(&k1, &v1);
        u.insert(&k2, &v2);
        assert_eq!(u.root(), arr32("0xc0e284ae6547f611ffa26c9bf05875e87b6c9e8bb0793b9eaeda6daa1121efad"),
            "Rust UtxoAccumulator root must equal the JS makeUtxoAccumulator root");
    }

    // Depth-32 Merkle path for `index` over `leaves`, zero-filling empty subtrees — the
    // witness builder the indexer runs (positions ≥ leaves.len() are the zero leaf). Mirrors
    // the JS pool.Tree.rootAndPath; used here to feed the witnessed transitions.
    fn merkle_path(leaves: &[[u8; 32]], mut index: u64) -> Vec<[u8; 32]> {
        let zeros = keccak_zeros();
        let mut path = Vec::with_capacity(KECCAK_TREE_DEPTH);
        let mut level: Vec<[u8; 32]> = leaves.to_vec();
        for i in 0..KECCAK_TREE_DEPTH {
            let sib_idx = (index ^ 1) as usize;
            path.push(if sib_idx < level.len() { level[sib_idx] } else { zeros[i] });
            let mut next = Vec::with_capacity(level.len().div_ceil(2));
            let mut k = 0;
            while k * 2 < level.len() {
                let l = level[2 * k];
                let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[i] };
                next.push(kn(&[&l, &r]));
                k += 1;
            }
            level = next;
            index >>= 1;
        }
        path
    }

    // Phase 1: the witnessed IMT insert transition reproduces the stateful ImtAccumulator's
    // root sequence with NO full-set state — only (prior_root, low-witness, append-witness).
    // This is what lets the reflection prover resume from a digest and fold Δ-spends in-zkVM.
    #[test]
    fn imt_insert_transition_matches_stateful() {
        let spends = [
            arr32("0x0000000000000000000000000000000000000000000000000000000000000042"),
            arr32("0x00000000000000000000000000000000000000000000000000000000000000a1"),
            arr32("0x0000000000000000000000000000000000000000000000000000000000000007"),
            arr32("0x00000000000000000000000000000000000000000000000000000000000000ff"),
            arr32("0x0000000000000000000000000000000000000000000000000000000000000080"),
        ];
        let mut acc = ImtAccumulator::new();
        for nu in &spends {
            // Witnesses built from the CURRENT (pre-insert) accumulator state.
            let prior_root = acc.root();
            let prior_leaves: Vec<[u8; 32]> = acc.links().iter().map(|(v, n)| imt_leaf(v, n)).collect();
            let (low_index, low_value, low_next) = acc.non_membership_low(nu).expect("low link");
            let low_idx = low_index as u64;
            let low_path = merkle_path(&prior_leaves, low_idx);
            // The new leaf lands at the next free slot; its path is against the INTERMEDIATE
            // tree (low leaf rewired to nu), exactly as the in-zkVM transition checks it.
            let new_index = prior_leaves.len() as u64;
            let mut interm_leaves = prior_leaves.clone();
            interm_leaves[low_index] = imt_leaf(&low_value, nu);
            let new_path = merkle_path(&interm_leaves, new_index);

            let got = imt_insert_transition(
                &prior_root, nu, &low_value, &low_next, low_idx, &low_path, new_index, &new_path,
            ).expect("transition");

            acc.insert(nu); // advance the stateful reference
            assert_eq!(got, acc.root(), "witnessed insert root must equal the stateful root");
        }

        // A forged low witness (wrong low_next that doesn't straddle) is rejected.
        let nu = arr32("0x0000000000000000000000000000000000000000000000000000000000000005");
        let bad = imt_insert_transition(
            &acc.root(), &nu, &[0u8; 32], &[0u8; 32], 0, &merkle_path(&[], 0), 99, &merkle_path(&[], 99),
        );
        assert!(bad.is_none(), "forged/non-straddling witness must not produce a transition");
    }

    // Phase 1: the witnessed note-tree append transition reproduces the stateful
    // KeccakTreeAccumulator's root sequence from only (prior_root, the empty slot's path).
    #[test]
    fn keccak_tree_append_transition_matches_stateful() {
        let mut acc = KeccakTreeAccumulator::new();
        let mut hist: Vec<[u8; 32]> = Vec::new();
        for i in 0u8..6 {
            let leaf = arr32(&format!("0x{:064x}", 0x1000 + i as u32));
            let prior_root = acc.root();
            let next_index = acc.next_index();
            let path = merkle_path(&hist, next_index);
            let got = keccak_tree_append_transition(&prior_root, next_index, &path, &leaf).expect("append");
            acc.append(&leaf);
            hist.push(leaf);
            assert_eq!(got, acc.root(), "witnessed append root == stateful");
        }
        // appending onto a non-empty slot (wrong path proving a filled slot) fails.
        let bad = keccak_tree_append_transition(&acc.root(), 0, &merkle_path(&hist, 0), &arr32(&format!("0x{:064x}", 1)));
        assert!(bad.is_none(), "cannot append over an occupied slot");
    }

    // Phase 1: the witnessed UTXO insert + remove transitions reproduce the stateful
    // UtxoAccumulator (key → value sorted set with tombstoning) — the burn set and the
    // outpoint set the reflection prover advances without holding the full set.
    #[test]
    fn utxo_insert_remove_transition_matches_stateful() {
        let h = |n: u32| arr32(&format!("0x{:064x}", n));
        let kv = [
            (h(0x42), h(0xaa)),
            (h(0xa1), h(0xbb)),
            (h(0x07), h(0xcc)),
            (h(0xff), h(0xdd)),
        ];
        let mut acc = UtxoAccumulator::new();
        for (k, v) in &kv {
            let prior_root = acc.root();
            let prior_leaves = acc.leaves();
            let (low_i, low_k, low_n, low_v) = acc.low(k).expect("low");
            let low_path = merkle_path(&prior_leaves, low_i as u64);
            let new_index = prior_leaves.len() as u64;
            let mut interm = prior_leaves.clone();
            interm[low_i] = utxo_leaf(&low_k, k, &low_v);
            let new_path = merkle_path(&interm, new_index);
            let got = utxo_insert_transition(
                &prior_root, k, v, &low_k, &low_n, &low_v, low_i as u64, &low_path, new_index, &new_path,
            ).expect("insert transition");
            acc.insert(k, v);
            assert_eq!(got, acc.root(), "witnessed utxo insert root == stateful");
        }

        // Remove a live key (0xa1) and check the transition matches the stateful remove.
        let key = h(0xa1);
        let prior_root = acc.root();
        let prior_leaves = acc.leaves();
        let (node_i, node_n, node_v) = acc.membership(&key).expect("member");
        let (pred_i, pred_k, pred_v) = acc.predecessor(&key).expect("pred");
        let pred_path = merkle_path(&prior_leaves, pred_i as u64);
        let mut interm = prior_leaves.clone();
        interm[pred_i] = utxo_leaf(&pred_k, &node_n, &pred_v); // pred rewired to skip key
        let node_path = merkle_path(&interm, node_i as u64);
        let got = utxo_remove_transition(
            &prior_root, &key, &node_n, &node_v, node_i as u64, &node_path,
            &pred_k, &pred_v, pred_i as u64, &pred_path,
        ).expect("remove transition");
        acc.remove(&key);
        assert_eq!(got, acc.root(), "witnessed utxo remove root == stateful");
        assert_eq!(acc.get(&key), None, "removed key is gone");
    }

    // ── Phase 2 witness builders (what the Phase-4 indexer runs) ──
    fn build_spend_witness(spent: &ImtAccumulator, utxo: &UtxoAccumulator, cx: [u8; 32], cy: [u8; 32], outpoint: [u8; 32]) -> SpendWitness {
        let nu = nullifier(&cx, &cy);
        let spent_leaves: Vec<[u8; 32]> = spent.links().iter().map(|(v, n)| imt_leaf(v, n)).collect();
        let (low_i, low_v, low_n) = spent.non_membership_low(&nu).expect("spent low");
        let s_low_path = merkle_path(&spent_leaves, low_i as u64);
        let mut s_interm = spent_leaves.clone();
        s_interm[low_i] = imt_leaf(&low_v, &nu);
        let s_new_path = merkle_path(&s_interm, spent_leaves.len() as u64);
        let utxo_leaves = utxo.leaves();
        let (node_i, node_n, node_v) = utxo.membership(&outpoint).expect("utxo member");
        let (pred_i, pred_k, pred_v) = utxo.predecessor(&outpoint).expect("utxo pred");
        let u_pred_path = merkle_path(&utxo_leaves, pred_i as u64);
        let mut u_interm = utxo_leaves.clone();
        u_interm[pred_i] = utxo_leaf(&pred_k, &node_n, &pred_v);
        let u_node_path = merkle_path(&u_interm, node_i as u64);
        SpendWitness {
            cx, cy, outpoint, s_low_value: low_v, s_low_next: low_n, s_low_index: low_i as u64, s_low_path, s_new_path,
            u_node_next: node_n, u_node_value: node_v, u_node_index: node_i as u64, u_node_path,
            u_pred_key: pred_k, u_pred_value: pred_v, u_pred_index: pred_i as u64, u_pred_path,
        }
    }
    fn build_output_witness(notes: &KeccakTreeAccumulator, utxo: &UtxoAccumulator, note_leaf: [u8; 32], outpoint: [u8; 32], commit: [u8; 32]) -> OutputWitness {
        let utxo_leaves = utxo.leaves();
        let (low_i, low_k, low_n, low_v) = utxo.low(&outpoint).expect("utxo low");
        let u_low_path = merkle_path(&utxo_leaves, low_i as u64);
        let mut interm = utxo_leaves.clone();
        interm[low_i] = utxo_leaf(&low_k, &outpoint, &low_v);
        let u_new_path = merkle_path(&interm, utxo_leaves.len() as u64);
        OutputWitness {
            note_leaf, note_path: notes.append_path(), outpoint, commitment_hash: commit,
            u_low_key: low_k, u_low_next: low_n, u_low_value: low_v, u_low_index: low_i as u64, u_low_path, u_new_path,
        }
    }
    fn build_burn_witness(spent: &ImtAccumulator, utxo: &UtxoAccumulator, burns: &UtxoAccumulator, cx: [u8; 32], cy: [u8; 32], outpoint: [u8; 32], dest: [u8; 32]) -> BurnWitness {
        let nu = nullifier(&cx, &cy);
        let spend = build_spend_witness(spent, utxo, cx, cy, outpoint);
        let burn_leaves = burns.leaves();
        let (low_i, low_k, low_n, low_v) = burns.low(&nu).expect("burn low");
        let b_low_path = merkle_path(&burn_leaves, low_i as u64);
        let mut interm = burn_leaves.clone();
        interm[low_i] = utxo_leaf(&low_k, &nu, &low_v);
        let b_new_path = merkle_path(&interm, burn_leaves.len() as u64);
        BurnWitness {
            spend, dest_commitment: dest,
            b_low_key: low_k, b_low_next: low_n, b_low_value: low_v, b_low_index: low_i as u64, b_low_path, b_new_path,
        }
    }

    // Phase 2: WitnessedReflection (headless, O(Δ)) produces byte-identical roots to the
    // stateful ReflectionState (the indexer/contract reference) over a deposit → transfer →
    // bridge-out sequence. This is the faithfulness proof of the resume-from-digest model.
    #[test]
    fn witnessed_reflection_matches_stateful() {
        let v = |n: u32| arr32(&format!("0x{:064x}", n));
        let mut st = ReflectionState::genesis();
        let mut w = WitnessedReflection::genesis();
        // genesis roots agree
        assert_eq!(w.pool_root, st.notes.root());
        assert_eq!(w.spent_root, st.spent.root());
        assert_eq!(w.utxo_root, st.utxo.root());
        assert_eq!(w.burn_root, st.bridge_burns.root());

        // Each note has commitment coords; the UTXO value stored is commitment_hash(cx,cy)
        // and the spend's ν is DERIVED from it (3.2 binding), not witnessed.
        let (cx_a, cy_a) = (v(0x0a), v(0x1a)); let com_a = commitment_hash(&cx_a, &cy_a); let nu_a = nullifier(&cx_a, &cy_a);
        let (cx_b, cy_b) = (v(0x0b), v(0x1b)); let com_b = commitment_hash(&cx_b, &cy_b); let nu_b = nullifier(&cx_b, &cy_b);
        let (cx_c, cy_c) = (v(0x0c), v(0x1c)); let com_c = commitment_hash(&cx_c, &cy_c);
        let (op_a, op_b, op_c) = (v(0xa0), v(0xb0), v(0xc0));
        let (leaf_a, leaf_b, leaf_c) = (v(0x1aa), v(0x1bb), v(0x1cc));
        let dest_b = v(0xde);
        let _ = cy_c;

        // 1. two deposits (no spends, two outputs)
        let ow_a = build_output_witness(&st.notes, &st.utxo, leaf_a, op_a, com_a);
        st.notes.append(&leaf_a); st.utxo.insert(&op_a, &com_a);
        let ow_b = build_output_witness(&st.notes, &st.utxo, leaf_b, op_b, com_b);
        st.notes.append(&leaf_b); st.utxo.insert(&op_b, &com_b);
        st.height = 100;
        w.apply_transfer(&[], &[ow_a, ow_b], 100).expect("deposits");
        assert_eq!((w.pool_root, w.utxo_root), (st.notes.root(), st.utxo.root()), "after deposits");

        // 2. transfer: spend note A at op_a, create op_c (ν derived from cx_a,cy_a)
        let sw = build_spend_witness(&st.spent, &st.utxo, cx_a, cy_a, op_a);
        st.spent.insert(&nu_a); st.utxo.remove(&op_a);
        let ow_c = build_output_witness(&st.notes, &st.utxo, leaf_c, op_c, com_c);
        st.notes.append(&leaf_c); st.utxo.insert(&op_c, &com_c);
        st.height = 101;
        w.apply_transfer(&[sw], &[ow_c], 101).expect("transfer");
        assert_eq!((w.pool_root, w.spent_root, w.utxo_root), (st.notes.root(), st.spent.root(), st.utxo.root()), "after transfer");

        // 3. bridge-out: burn note B at op_b → destCommitment
        let bw = build_burn_witness(&st.spent, &st.utxo, &st.bridge_burns, cx_b, cy_b, op_b, dest_b);
        st.spent.insert(&nu_b); st.utxo.remove(&op_b); st.bridge_burns.insert(&nu_b, &dest_b);
        st.height = 102;
        w.apply_bridge_out(&bw, 102).expect("bridge-out");
        assert_eq!(w.spent_root, st.spent.root(), "spent after burn");
        assert_eq!(w.utxo_root, st.utxo.root(), "utxo after burn");
        assert_eq!(w.burn_root, st.bridge_burns.root(), "burn root after burn");

        // commit matches the stateful reference; digest is deterministic + non-zero
        assert_eq!(w.commit(), (st.notes.root(), st.spent.root(), 102));
        assert_eq!(w.burn_root, st.bridge_burns.root());
        assert_ne!(w.digest(), [0u8; 32], "resumption digest is well-defined");
        // height must not decrease (same-block effects share a height; a rollback is rejected)
        w.apply_transfer(&[], &[], 102).expect("same height allowed (same-block effects)");
        assert!(w.apply_transfer(&[], &[], 101).is_err(), "height decrease (rollback) rejected");
    }

    // F4 full scan: ScanReflection genesis digest — the three-way anchor (Rust prover == JS
    // indexer == contract REFLECTION_GENESIS_DIGEST for the full-scan model). Differs from the
    // witnessed model: the UTXO slot is the EMPTY live set (keccak_merkle_root([]) + size 0), not
    // the {0→0} UtxoAccumulator sentinel.
    #[test]
    fn scan_reflection_genesis_digest() {
        let g = ScanReflection::genesis();
        assert_eq!(hex::encode(g.digest()), "7b058378c57dc5e8586e588ed5b010862924ec34dfce88495379135ae006ef41", "full-scan genesis digest (JS indexer + contract must match)");
        // empty live set root == empty note-tree root (both keccak_merkle_root([])); spent + burn
        // keep the {0→0} sentinel roots.
        assert_eq!(g.live.root(), g.pool_root);
        assert_eq!(hex::encode(g.spent_root), "5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0");
    }

    // F4 full scan: ScanReflection's headless spent/note/burn folds produce byte-identical roots
    // to the stateful ReflectionState (same witnessed transitions), while the live UTXO set tracks
    // outpoints in-memory. This mirrors the guest's per-tx fold order over a deposit → transfer →
    // bridge-out sequence — the faithfulness proof of the full-scan model's commitments.
    #[test]
    fn scan_reflection_folds_match_stateful() {
        let v = |n: u32| arr32(&format!("0x{:064x}", n));
        let mut st = ReflectionState::genesis();
        let mut sc = ScanReflection::genesis();
        // genesis headless roots agree (the UTXO sets differ in shape by design)
        assert_eq!(sc.pool_root, st.notes.root());
        assert_eq!(sc.spent_root, st.spent.root());
        assert_eq!(sc.burn_root, st.bridge_burns.root());
        let d0 = sc.digest();

        let (cx_a, cy_a) = (v(0x0a), v(0x1a)); let com_a = commitment_hash(&cx_a, &cy_a); let nu_a = nullifier(&cx_a, &cy_a);
        let (cx_b, cy_b) = (v(0x0b), v(0x1b)); let com_b = commitment_hash(&cx_b, &cy_b); let nu_b = nullifier(&cx_b, &cy_b);
        let (cx_c, cy_c) = (v(0x0c), v(0x1c)); let com_c = commitment_hash(&cx_c, &cy_c);
        let (op_a, op_b, op_c) = (v(0xa0), v(0xb0), v(0xc0));
        let (leaf_a, leaf_b, leaf_c) = (v(0x1aa), v(0x1bb), v(0x1cc));
        let dest_b = v(0xde);
        let asset = v(0x5e); // the live set carries the note's asset (unused by the legacy UtxoAccumulator)
        let _ = cy_c;

        // 1. two outputs (deposits): fold_output appends the note leaf + adds the outpoint live.
        let ow_a = build_output_witness(&st.notes, &st.utxo, leaf_a, op_a, com_a);
        st.notes.append(&leaf_a); st.utxo.insert(&op_a, &com_a);
        sc.fold_output(&leaf_a, &ow_a.note_path, &op_a, &com_a, &asset).expect("output a");
        let ow_b = build_output_witness(&st.notes, &st.utxo, leaf_b, op_b, com_b);
        st.notes.append(&leaf_b); st.utxo.insert(&op_b, &com_b);
        sc.fold_output(&leaf_b, &ow_b.note_path, &op_b, &com_b, &asset).expect("output b");
        assert_eq!(sc.pool_root, st.notes.root(), "note tree after deposits");
        assert_eq!(sc.live.get(&op_a), Some((com_a, asset)), "op_a live");
        assert_eq!(sc.live.get(&op_b), Some((com_b, asset)), "op_b live");
        assert_ne!(sc.digest(), d0, "state advanced");

        // 2. transfer: spend note A (the scan derives nu_a + removes op_a), create op_c.
        let sw = build_spend_witness(&st.spent, &st.utxo, cx_a, cy_a, op_a);
        st.spent.insert(&nu_a); st.utxo.remove(&op_a);
        sc.live.remove(&op_a); // scan_tx_spends does this in the guest
        sc.fold_spent(&nu_a, &sw.s_low_value, &sw.s_low_next, sw.s_low_index, &sw.s_low_path, &sw.s_new_path).expect("spend a");
        let ow_c = build_output_witness(&st.notes, &st.utxo, leaf_c, op_c, com_c);
        st.notes.append(&leaf_c); st.utxo.insert(&op_c, &com_c);
        sc.fold_output(&leaf_c, &ow_c.note_path, &op_c, &com_c, &asset).expect("output c");
        assert_eq!(sc.spent_root, st.spent.root(), "spent after transfer");
        assert_eq!(sc.pool_root, st.notes.root(), "notes after transfer");
        assert_eq!(sc.live.get(&op_a), None, "op_a spent");

        // 3. bridge-out: burn note B → destCommitment.
        let bw = build_burn_witness(&st.spent, &st.utxo, &st.bridge_burns, cx_b, cy_b, op_b, dest_b);
        st.spent.insert(&nu_b); st.utxo.remove(&op_b); st.bridge_burns.insert(&nu_b, &dest_b);
        sc.live.remove(&op_b);
        sc.fold_spent(&nu_b, &bw.spend.s_low_value, &bw.spend.s_low_next, bw.spend.s_low_index, &bw.spend.s_low_path, &bw.spend.s_new_path).expect("spend b");
        sc.fold_burn(&nu_b, &dest_b, &bw.b_low_key, &bw.b_low_next, &bw.b_low_value, bw.b_low_index, &bw.b_low_path, &bw.b_new_path).expect("burn b");
        assert_eq!(sc.spent_root, st.spent.root(), "spent after burn");
        assert_eq!(sc.burn_root, st.bridge_burns.root(), "burn root after burn");

        // commit matches the stateful reference; digest is deterministic + non-zero.
        sc.height = 102;
        assert_eq!(sc.commit(), (st.notes.root(), st.spent.root(), 102));
        assert_ne!(sc.digest(), [0u8; 32], "resumption digest is well-defined");
    }

    // Phase 3.2: ν is BOUND to the outpoint's committed note — a spend can't fabricate a ν
    // unrelated to the note actually at the outpoint it removes.
    #[test]
    fn spend_nu_bound_to_outpoint_note() {
        let v = |n: u32| arr32(&format!("0x{:064x}", n));
        let (cx, cy) = (v(0x0a), v(0x1a));
        let com = commitment_hash(&cx, &cy);
        // correct coords open the committed value → the note's nullifier; wrong coords don't
        assert_eq!(bind_spent_note(&com, &cx, &cy), Some(nullifier(&cx, &cy)));
        assert_eq!(bind_spent_note(&com, &v(0x99), &cy), None);
        assert_eq!(bind_spent_note(&com, &cx, &v(0x99)), None);

        // end-to-end: a deposit, then a spend whose witness carries the WRONG commitment is
        // rejected by apply_transfer (the stored UTXO value won't open to it).
        let mut st = ReflectionState::genesis();
        let mut w = WitnessedReflection::genesis();
        let op = v(0xa0);
        let ow = build_output_witness(&st.notes, &st.utxo, v(0x1aa), op, com);
        st.notes.append(&v(0x1aa)); st.utxo.insert(&op, &com);
        w.apply_transfer(&[], &[ow], 1).expect("deposit");
        let mut bad = build_spend_witness(&st.spent, &st.utxo, cx, cy, op);
        bad.cx = v(0xdead); // no longer opens com
        assert!(w.apply_transfer(&[bad], &[], 2).is_err(), "spend with unbound ν is rejected");
    }

    // Phase 3.3b: a CXFER output's stored commitment_hash equals the envelope's compressed
    // commitment decompressed — so a reflected output is the note the confirmed tx declared,
    // not a fabricated (unbacked) one. Uses a real curve point from the bridge_burn fixture.
    #[test]
    fn commitment_hash_compressed_matches_coords() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/bridge_burn.json")).unwrap();
        let c = &f["crossOuts"][0];
        let cx = arr32(c["cx"].as_str().unwrap());
        let cy = arr32(c["cy"].as_str().unwrap());
        let compressed: [u8; 33] = from_affine_xy(&cx, &cy).expect("valid point")
            .to_affine().to_encoded_point(true).as_bytes().try_into().unwrap();
        assert_eq!(commitment_hash_compressed(&compressed), Some(commitment_hash(&cx, &cy)),
            "compressed commitment → the same commitment_hash as its (Cx,Cy)");
        // a non-point (bad prefix) is rejected
        assert_eq!(commitment_hash_compressed(&[0x09u8; 33]), None, "not a curve point");
    }

    // Phase 3.2 #2/#3: confirm_pool_tx ties an effect to a real confirmed Bitcoin tx — the tx
    // is in a PoW block (verify_tx_in_block) and its vins become the only outpoints a reflected
    // spend may claim (outpoint_key over extract_inputs). Uses the real bridge_mint block.
    #[test]
    fn confirm_pool_tx_binds_real_block() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let header = hex::decode(strip(f["header"].as_str().unwrap())).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let tx_index = f["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = f["txids"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect();

        let (txid, in_outpoints) = confirm_pool_tx(&header, &tx, tx_index, &txids).expect("confirmed");
        assert_eq!(txid, bitcoin::compute_txid(&tx).unwrap(), "returns the confirmed txid");
        assert!(!in_outpoints.is_empty(), "tx has spent outpoints");
        // each bound outpoint is outpoint_key of a real vin
        let vins = bitcoin::extract_inputs(&tx).unwrap();
        assert_eq!(in_outpoints.len(), vins.len(), "one bound outpoint per vin");
        assert_eq!(in_outpoints[0], outpoint_key(&vins[0].0, vins[0].1), "outpoint = key(vin)");
        // a tampered tx (txid no longer in the block) is not confirmable
        let mut bad = tx.clone();
        let n = bad.len(); bad[n - 1] ^= 1;
        assert!(confirm_pool_tx(&header, &bad, tx_index, &txids).is_none(), "tampered tx rejected");
    }

    // Extract the real CXFER's fold data (vin outpoint keys, output commitment-hashes + outpoints,
    // txid, asset) and write it for the JS full-fold assembler (tests/gen-reflection-cxfer-fold.mjs).
    // The spent outpoints + the txid + the output commitments are all on-chain; the spent notes'
    // (Cx,Cy) come from the attested prior state, which the assembler seeds.
    #[test]
    fn gen_real_cxfer_fold_data() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/signet_cxfer.json")).unwrap();
        let hx = |s: &str| hex::decode(s.trim_start_matches("0x")).unwrap();
        let tx = hx(f["tx"].as_str().unwrap());
        let txid = bitcoin::compute_txid(&tx).unwrap();
        let vins = bitcoin::extract_inputs(&tx).expect("vins");
        let env = bitcoin::extract_taproot_envelope(&tx).expect("envelope");
        let (asset, comms) = bitcoin::parse_cxfer_envelope(&env).expect("cxfer parse");

        let spends: Vec<String> = vins.iter().map(|(t, v)| format!("\"0x{}\"", hex::encode(outpoint_key(t, *v)))).collect();
        let outputs: Vec<String> = comms.iter().enumerate().map(|(i, c)| {
            let ch = commitment_hash_compressed(c).expect("decompress");
            format!("{{ \"commitmentHash\": \"0x{}\", \"outpoint\": \"0x{}\", \"vout\": {} }}",
                hex::encode(ch), hex::encode(outpoint_key(&txid, i as u32)), i)
        }).collect();
        let json = format!(
            "{{\n  \"note\": \"real signet CXFER fold data (block 307547)\",\n  \"asset\": \"0x{}\",\n  \"txid\": \"0x{}\",\n  \"spendOutpoints\": [{}],\n  \"outputs\": [{}]\n}}\n",
            hex::encode(asset), hex::encode(txid),
            spends.iter().map(|s| format!("\n    {}", s)).collect::<Vec<_>>().join(","),
            outputs.iter().map(|o| format!("\n    {}", o)).collect::<Vec<_>>().join(",")
        );
        std::fs::write("../fixtures/signet_cxfer_folddata.json", json).expect("write fold data");
        assert_eq!(comms.len(), outputs.len());
    }

    // Reproduce the guest's OP_TRANSFER fold natively on the assembled real-CXFER fixture, to
    // pinpoint any witnessed-transition failure (apply_transfer returns a per-transition message).
    #[test]
    fn reproduce_real_cxfer_fold() {
        let path = std::path::Path::new("../fixtures/reflection_cxfer_fold.json");
        if !path.exists() { eprintln!("(no reflection_cxfer_fold.json — skip)"); return; }
        let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let a = |v: &serde_json::Value| arr32(v.as_str().unwrap());
        let p = |v: &serde_json::Value| -> Vec<[u8; 32]> { v.as_array().unwrap().iter().map(|x| arr32(x.as_str().unwrap())).collect() };
        let pr = &f["prior"];
        let mut w = WitnessedReflection {
            pool_root: a(&pr["poolRoot"]), note_count: pr["noteCount"].as_u64().unwrap(),
            spent_root: a(&pr["spentRoot"]), spent_count: pr["spentCount"].as_u64().unwrap(),
            utxo_root: a(&pr["utxoRoot"]), utxo_count: pr["utxoCount"].as_u64().unwrap(),
            burn_root: a(&pr["burnRoot"]), burn_count: pr["burnCount"].as_u64().unwrap(),
            height: pr["height"].as_u64().unwrap(),
        };
        let mk_spend = |s: &serde_json::Value| SpendWitness {
            cx: a(&s["cx"]), cy: a(&s["cy"]), outpoint: a(&s["outpoint"]),
            s_low_value: a(&s["sLowValue"]), s_low_next: a(&s["sLowNext"]), s_low_index: s["sLowIndex"].as_u64().unwrap(),
            s_low_path: p(&s["sLowPath"]), s_new_path: p(&s["sNewPath"]),
            u_node_next: a(&s["uNodeNext"]), u_node_value: a(&s["uNodeValue"]), u_node_index: s["uNodeIndex"].as_u64().unwrap(), u_node_path: p(&s["uNodePath"]),
            u_pred_key: a(&s["uPredKey"]), u_pred_value: a(&s["uPredValue"]), u_pred_index: s["uPredIndex"].as_u64().unwrap(), u_pred_path: p(&s["uPredPath"]),
        };
        let e = &f["effects"][0];
        let spends: Vec<SpendWitness> = e["spends"].as_array().unwrap().iter().map(mk_spend).collect();
        let outputs: Vec<OutputWitness> = e["outputs"].as_array().unwrap().iter().map(|o| OutputWitness {
            note_leaf: a(&o["noteLeaf"]), note_path: p(&o["notePath"]), outpoint: a(&o["outpoint"]), commitment_hash: a(&o["commitmentHash"]),
            u_low_key: a(&o["uLowKey"]), u_low_next: a(&o["uLowNext"]), u_low_value: a(&o["uLowValue"]), u_low_index: o["uLowIndex"].as_u64().unwrap(),
            u_low_path: p(&o["uLowPath"]), u_new_path: p(&o["uNewPath"]),
        }).collect();
        // the guest's pre-fold tx-binding (confirm + envelope + outpoint/commitment), the part
        // the digest check skips — this is what panics in-guest if a binding is off.
        let dh = |s: &str| hex::decode(s).unwrap();
        let hdr = dh(f["headers"][0].as_str().unwrap());
        let tx = dh(e["txData"].as_str().unwrap());
        let tx_index = e["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = e["txids"].as_array().unwrap().iter().map(|t| dh(t.as_str().unwrap()).try_into().unwrap()).collect();
        let (txid, in_outpoints) = confirm_pool_tx(&hdr, &tx, tx_index, &txids).expect("confirm_pool_tx FAILED");
        let env = bitcoin::extract_taproot_envelope(&tx).expect("envelope");
        let (_a, comms) = bitcoin::parse_cxfer_envelope(&env).expect("parse cxfer");
        assert_eq!(outputs.len(), comms.len(), "m_out != commitments");
        for s in &spends { assert!(in_outpoints.contains(&s.outpoint), "spend outpoint not a vin"); }
        for (j, o) in outputs.iter().enumerate() {
            let vout = e["outputs"][j]["vout"].as_u64().unwrap() as u32;
            assert_eq!(outpoint_key(&txid, vout), o.outpoint, "output outpoint != vout(j={})", j);
            assert_eq!(commitment_hash_compressed(&comms[j]), Some(o.commitment_hash), "output commitment != envelope (j={})", j);
        }

        let height = f["anchorHeight"].as_u64().unwrap() + e["blockIndex"].as_u64().unwrap();
        let res = w.apply_transfer(&spends, &outputs, height);
        assert!(res.is_ok(), "apply_transfer FAILED: {:?}", res.err());
        // and the resulting digest matches the fixture's newDigest
        assert_eq!(format!("0x{}", hex::encode(w.digest())), f["newDigest"].as_str().unwrap(), "digest mismatch");
    }

    #[test]
    fn protocol_fee_pool_id_layout() {
        let a = [0x11u8; 32];
        let b = [0x22u8; 32];
        let rcpt = [0x02u8; 33];
        // no-skim is byte-identical to the canonical pool_id (a fee-free pool is unchanged)
        assert_eq!(pool_id_with_protocol_fee(&a, &b, 30, &rcpt, 0), pool_id(&a, &b, 30), "no-skim must equal pool_id");
        assert_eq!(pool_id_with_protocol_fee(&a, &b, 30, &[0u8; 33], 0), pool_id(&a, &b, 30), "no-skim independent of recipient");
        // a non-zero skim yields a DISTINCT slot, and is canonical (A,B)≡(B,A) + recipient/bps-bound
        let fee_pool = pool_id_with_protocol_fee(&a, &b, 30, &rcpt, 167);
        assert_ne!(fee_pool, pool_id(&a, &b, 30), "fee pool must differ from no-skim");
        assert_eq!(fee_pool, pool_id_with_protocol_fee(&b, &a, 30, &rcpt, 167), "fee pool canonical in asset order");
        assert_ne!(fee_pool, pool_id_with_protocol_fee(&a, &b, 30, &rcpt, 100), "distinct skim bps → distinct pool");
        assert_ne!(fee_pool, pool_id_with_protocol_fee(&a, &b, 30, &[0x03u8; 33], 167), "distinct recipient → distinct pool");
    }

    #[test]
    fn protocol_fee_cut_is_a_fraction_of_the_lp_fee() {
        // 1_000_000 in, 30bps LP fee = 3000 fee; 1667bps (≈1/6) of that = 500.1 → floor 500.
        assert_eq!(protocol_fee_cut(1_000_000, 30, 1667), 500);
        assert_eq!(protocol_fee_cut(1_000_000, 30, 0), 0, "no protocol fee");
        assert_eq!(protocol_fee_cut(0, 30, 1667), 0, "no volume");
        // never exceeds the LP fee (gross·fee/10000) since protocol_fee_bps ≤ 10000
        let gross = 5_000_000u128;
        assert!(protocol_fee_cut(gross, 30, 10000) <= (gross * 30 / 10000) as u64, "cut ≤ LP fee");
    }
}
