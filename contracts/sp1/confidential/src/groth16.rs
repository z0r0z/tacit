//! In-guest BN254 Groth16 verifier for T_SWAP_BATCH (ops/DESIGN-in-guest-groth16-verifier.md).
//!
//! Verifies the confidential batch's snarkjs/circom Groth16 proof — the per-receipt uniform-clearing — so a
//! batch receipt onboards as real + bridgeable (the aggregate Pedersen identity is the asset-scoped kernel;
//! only the per-receipt split needs this proof). Reflection-only: the settle guest never touches
//! T_SWAP_BATCH, so the BN254 dependency links into the reflection ELF only (main.rs never `mod`s this).
//!
//! BOX-ONLY: this is the heaviest reflection op (a BN254 multi-pairing) and uses the SP1-precompile `bn`
//! crate, so it can't be compiled or measured here. Before trusting it, unit-test on the box against a REAL
//! swap_batch proof vector produced from the ceremony zkey — in particular to confirm:
//!   (a) the snarkjs G2 Fp2 limb order (`[c0, c1]`) matches `bn::Fq2::new(c0, c1)` — if a known-good vector
//!       fails, swap the two `Fq` limbs in `g2()` (the classic snarkjs↔arkworks/bn G2 byte-order gotcha);
//!   (b) the `bn` package version/source resolves to the SP1-accelerated build;
//!   (c) `Gt::one()` is the correct target (the multi-pairing product is 1 iff the equation holds).

use bn::{pairing_batch, AffineG1, AffineG2, Fq, Fq2, Fr, Group, Gt, G1, G2};
use cxfer_core::{G16Proof, G16Vk};

/// The baked T_SWAP_BATCH verifying key — the CID-verified ceremony vk (CANONICAL_AMM_VK_CID), generated
/// from fixtures/swap_batch_vk.json as big-endian field bytes: `alpha1(G1 64) ‖ beta2(G2 128) ‖
/// gamma2(128) ‖ delta2(128) ‖ IC[0..124](G1 64 each)` = 8384 B. Embedded so the guest never parses JSON
/// in-zkVM; regenerate if the ceremony ever rotates (the rotation would also rotate BITCOIN_RELAY_VKEY).
static BATCH_VK_BYTES: &[u8] = include_bytes!("batch_vk.bin");
const BATCH_NPUBLIC: usize = 123;

fn rd32(b: &[u8], off: usize) -> [u8; 32] {
    let mut a = [0u8; 32];
    a.copy_from_slice(&b[off..off + 32]);
    a
}

/// Build the baked swap_batch `G16Vk` from the embedded blob. Panics only on a corrupt embed (a build-time
/// invariant — the blob is committed + ceremony-CID-verified, never a runtime input).
pub fn batch_vk() -> G16Vk {
    let b = BATCH_VK_BYTES;
    assert_eq!(b.len(), 448 + (BATCH_NPUBLIC + 1) * 64, "baked batch vk size");
    let g2 = |o: usize| (rd32(b, o), rd32(b, o + 32), rd32(b, o + 64), rd32(b, o + 96));
    let mut ic = Vec::with_capacity(BATCH_NPUBLIC + 1);
    let mut off = 448;
    for _ in 0..(BATCH_NPUBLIC + 1) {
        ic.push((rd32(b, off), rd32(b, off + 32)));
        off += 64;
    }
    G16Vk { alpha1: (rd32(b, 0), rd32(b, 32)), beta2: g2(64), gamma2: g2(192), delta2: g2(320), ic }
}

/// Parse a big-endian 32-byte field element into `Fq` (BN254 base field).
fn fq(b: &[u8; 32]) -> Option<Fq> {
    Fq::from_slice(b).ok()
}

/// Parse a big-endian 32-byte scalar into `Fr` (BN254 scalar field).
fn fr(b: &[u8; 32]) -> Option<Fr> {
    Fr::from_slice(b).ok()
}

/// snarkjs G1 `(x, y)` (big-endian Fq) → `bn::G1`. All-zero ⇒ the point at infinity. `AffineG1::new`
/// validates on-curve, so a malformed vk/proof point fails closed.
fn g1(p: &([u8; 32], [u8; 32])) -> Option<G1> {
    if p.0 == [0u8; 32] && p.1 == [0u8; 32] {
        return Some(G1::zero());
    }
    Some(AffineG1::new(fq(&p.0)?, fq(&p.1)?).ok()?.into())
}

/// snarkjs G2 `([x_c0, x_c1], [y_c0, y_c1])` (big-endian Fq2 limbs) → `bn::G2`. `Fq2::new(c0, c1)` =
/// `c0 + c1·u`; see the limb-order caveat in the module docs.
fn g2(p: &([u8; 32], [u8; 32], [u8; 32], [u8; 32])) -> Option<G2> {
    let x = Fq2::new(fq(&p.0)?, fq(&p.1)?);
    let y = Fq2::new(fq(&p.2)?, fq(&p.3)?);
    Some(AffineG2::new(x, y).ok()?.into())
}

/// Verify a snarkjs/circom BN254 Groth16 proof:
///   `e(A, B) == e(α, β) · e(vk_x, γ) · e(C, δ)`, where `vk_x = IC[0] + Σ pub[i]·IC[i+1]`,
/// checked as the multi-pairing product `e(−A, B)·e(α, β)·e(vk_x, γ)·e(C, δ) == 1`.
///
/// `public_inputs` are the circuit's public signals as big-endian `Fr` bytes — the reflection RE-DERIVES
/// them from the on-chain batch envelope (net deltas, reserves, per-receipt commitments) so a prover can't
/// feed forged signals; that derivation + the baked `BATCH_VK` are `fold_swap_batch`'s remaining glue.
/// Returns false on any decode / length / on-curve failure (fail-closed).
pub fn groth16_bn254_verify(vk: &G16Vk, proof: &G16Proof, public_inputs: &[[u8; 32]]) -> bool {
    // IC must have exactly nPublic + 1 points.
    if public_inputs.len() + 1 != vk.ic.len() {
        return false;
    }
    // vk_x = IC[0] + Σ pub[i] · IC[i+1]
    let mut vk_x = match g1(&vk.ic[0]) {
        Some(p) => p,
        None => return false,
    };
    for (i, x) in public_inputs.iter().enumerate() {
        let ic = match g1(&vk.ic[i + 1]) {
            Some(p) => p,
            None => return false,
        };
        let s = match fr(x) {
            Some(s) => s,
            None => return false,
        };
        vk_x = vk_x + ic * s;
    }
    let a = match g1(&proof.a) {
        Some(p) => p,
        None => return false,
    };
    let b = match g2(&proof.b) {
        Some(p) => p,
        None => return false,
    };
    let c = match g1(&proof.c) {
        Some(p) => p,
        None => return false,
    };
    let alpha = match g1(&vk.alpha1) {
        Some(p) => p,
        None => return false,
    };
    let (beta, gamma, delta) = match (g2(&vk.beta2), g2(&vk.gamma2), g2(&vk.delta2)) {
        (Some(be), Some(ga), Some(de)) => (be, ga, de),
        _ => return false,
    };
    // e(−A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) == 1  ⟺  e(A, B) == e(α, β)·e(vk_x, γ)·e(C, δ)
    let product = pairing_batch(&[(-a, b), (alpha, beta), (vk_x, gamma), (c, delta)]);
    product == Gt::one()
}
