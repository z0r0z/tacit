//! secp256k1 helpers for the confidential-pool guest.
//!
//! ASSEMBLY PLAN (not yet wired — needs the SP1 toolchain to build/prove):
//!  - `pedersen_h`, `verify_pedersen_opening`: reuse verbatim from the bridge
//!    guest (`contracts/sp1/program/src/secp.rs`). Factor that file into a shared
//!    crate (e.g. `teth-secp`) and depend on it from both guests rather than
//!    copying, so the NUMS H and opening logic can never drift between surfaces.
//!  - `decompress` / `affine_xy`: thin k256 wrappers.
//!  - `verify_bulletproofs_plus`: PORT-IN — the canonical secp Bulletproofs+
//!    verifier (the same construction as `dapp/bulletproofs-plus.js` / the
//!    Bitcoin-side `secp.rs`), so the guest accepts byte-identical proofs to the
//!    Bitcoin layer. This is the one substantial piece remaining.
//!  - `verify_kernel`: the Mimblewimble conservation Schnorr,
//!    `Σ Cin − Σ Cout − fee·H = excess·G`, via the `ecrecover`-style address
//!    check already used on-chain (`Secp256k1.sol`), ported to k256.
//!
//! Signatures are fixed here so the guest (`main.rs`) compiles against a stable
//! interface; bodies are filled when the shared crate + BP+ port land.

use k256::ProjectivePoint;

pub fn pedersen_h() -> ProjectivePoint {
    todo!("reuse contracts/sp1/program/src/secp.rs::pedersen_h via a shared crate")
}

pub fn verify_pedersen_opening(
    _h: &ProjectivePoint,
    _commitment: &[u8; 33],
    _amount: u64,
    _blinding: &[u8; 32],
) -> bool {
    todo!("reuse bridge verify_pedersen_opening")
}

pub fn decompress(_commitment: &[u8; 33]) -> Option<ProjectivePoint> {
    todo!("k256 EncodedPoint -> ProjectivePoint")
}

pub fn affine_xy(_commitment: &[u8; 33]) -> Option<([u8; 32], [u8; 32])> {
    todo!("k256 affine coordinates as big-endian 32-byte")
}

/// Aggregated Bulletproofs+ range check over the output commitments — every
/// committed value ∈ [0, 2^64). PORT-IN: the canonical secp BP+ verifier.
pub fn verify_bulletproofs_plus(
    _h: &ProjectivePoint,
    _out_commitments: &[[u8; 33]],
    _proof: &[u8],
) -> bool {
    todo!("port the canonical secp Bulletproofs+ verifier")
}

/// Conservation kernel: Σ Cin − Σ Cout − fee·H == excess·G, Schnorr under excess.
pub fn verify_kernel(
    _h: &ProjectivePoint,
    _in_points: &[ProjectivePoint],
    _out_points: &[ProjectivePoint],
    _fee: u64,
    _kernel_r_addr: &[u8; 20],
    _kernel_z: &[u8; 32],
) -> bool {
    todo!("Mimblewimble kernel Schnorr via the ecrecover-style address check")
}
