//! Camenisch-Stadler sigma binding VERIFY: proves a secp256k1 Pedersen commitment and a
//! BabyJubJub Pedersen commitment hide the SAME amount. The secp↔BJJ hinge that lets a
//! pool note (secp) bind into a confidential swap (BJJ) — the foundation for `OP_SWAP`.
//! Port of `verifyXCurve` (tests/amm-sigma-xcurve.mjs / dapp/amm-sigma.js).
//!
//! Wire (169 B): A_secp(33) ‖ A_BJJ(32) ‖ z_a(40 BE) ‖ z_r_secp(32 BE) ‖ z_r_BJJ(32 BE).
//! Challenge e = last 16 bytes (BE) of SHA256(DOMAIN ‖ C_secp ‖ C_BJJ ‖ A_secp ‖ A_BJJ).
//! Checks: secp  z_a·H + z_r_secp·G == A_secp + e·C_secp
//!         BJJ   z_a·H_BJJ + z_r_BJJ·G_BJJ == A_BJJ + e·C_BJJ

use crate::{bjj, decompress, gen_h, scalar_reduce_be};
use k256::elliptic_curve::group::Group;
use k256::{ProjectivePoint, Scalar};
use num_bigint::BigUint;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const DOMAIN: &[u8] = b"tacit-amm-xcurve-v1";

fn n_secp() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| {
        BigUint::parse_bytes(
            b"115792089237316195423570985008687907852837564279074904382605163141518161494337",
            10,
        )
        .unwrap()
    })
}

/// BigUint (any size) → k256 Scalar, reduced mod n_secp.
fn secp_scalar(x: &BigUint) -> Scalar {
    let r = x % n_secp();
    let rb = r.to_bytes_be();
    let mut be = [0u8; 32];
    be[32 - rb.len()..].copy_from_slice(&rb);
    scalar_reduce_be(&be)
}

/// Verify the cross-curve binding. `c_secp` = 33-byte compressed secp point; `c_bjj` =
/// 32-byte packed BabyJubJub point. True iff the proof binds them to one hidden amount.
pub fn verify_xcurve(proof: &[u8], c_secp: &[u8; 33], c_bjj: &[u8; 32]) -> bool {
    if proof.len() != 169 {
        return false;
    }
    let mut a_secp = [0u8; 33];
    a_secp.copy_from_slice(&proof[0..33]);
    let mut a_bjj_b = [0u8; 32];
    a_bjj_b.copy_from_slice(&proof[33..65]);
    let z_a = BigUint::from_bytes_be(&proof[65..105]); // 40 B
    let z_r_secp = BigUint::from_bytes_be(&proof[105..137]);
    let z_r_bjj = BigUint::from_bytes_be(&proof[137..169]);
    if z_r_secp >= *n_secp() || z_r_bjj >= bjj::subgroup_order() {
        return false;
    }

    let c_secp_pt = match decompress(c_secp) {
        Some(p) => p,
        None => return false,
    };
    let a_secp_pt = match decompress(&a_secp) {
        Some(p) => p,
        None => return false,
    };
    let c_bjj_pt = match bjj::unpack(c_bjj) {
        Some(p) => p,
        None => return false,
    };
    let a_bjj_pt = match bjj::unpack(&a_bjj_b) {
        Some(p) => p,
        None => return false,
    };

    let mut h = Sha256::new();
    h.update(DOMAIN);
    h.update(c_secp);
    h.update(c_bjj);
    h.update(a_secp);
    h.update(a_bjj_b);
    let digest: [u8; 32] = h.finalize().into();
    let e = BigUint::from_bytes_be(&digest[16..32]);

    // secp side
    let g = ProjectivePoint::generator();
    let lhs_s = gen_h() * secp_scalar(&z_a) + g * secp_scalar(&z_r_secp);
    let rhs_s = a_secp_pt + c_secp_pt * secp_scalar(&e);
    if lhs_s != rhs_s {
        return false;
    }

    // BJJ side (H_BJJ/G_BJJ have order n_BJJ, so mul reduces the 320-bit z_a correctly)
    let lhs_b = bjj::add(&bjj::mul(bjj::h_gen(), &z_a), &bjj::mul(bjj::g_gen(), &z_r_bjj));
    let rhs_b = bjj::add(&a_bjj_pt, &bjj::mul(&c_bjj_pt, &e));
    lhs_b == rhs_b
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixture from tests/amm-sigma-xcurve.mjs proveXCurve(a=1500, r_secp, r_BJJ).
    const PROOF: &str = "039350c7115e4748a5c2e7e659db9d0323c7fd74ce784dbff8d52e138a88e8163a461891ee80f7d74fc09bac203cdcaa352f487373def5aac7fa075fe992870f9932625daf261b982c6f4c126c27caf6ebf65947491f40691b64cd37bb541de71c39e1caec58e2e37a944934dd90c34d7555d58dbfa6b06d9527e1998bd9679f44020a66444df9438401e79418aa01742b520bc2080ed1fa0dab1cfa3bfc35267fc9c1713e559fdf54";
    const C_SECP: &str = "02317b3f898d303c8c7b4a22d9a1443b019d9898a4fdd8d516f7e336cf7acd211d";
    const C_BJJ: &str = "b21444ce3bc54833be29f25e98ace3b218a8deb7fd84b976b4b267977bbbdb25";

    fn h(s: &str) -> Vec<u8> { hex::decode(s).unwrap() }

    #[test]
    fn verifies_js_proof() {
        let proof = h(PROOF);
        let cs: [u8; 33] = h(C_SECP).try_into().unwrap();
        let cb: [u8; 32] = h(C_BJJ).try_into().unwrap();
        assert!(verify_xcurve(&proof, &cs, &cb), "valid JS sigma proof must verify");
    }

    #[test]
    fn rejects_tamper() {
        let mut proof = h(PROOF);
        let cs: [u8; 33] = h(C_SECP).try_into().unwrap();
        let cb: [u8; 32] = h(C_BJJ).try_into().unwrap();
        proof[80] ^= 1; // flip a z_a byte
        assert!(!verify_xcurve(&proof, &cs, &cb), "tampered proof must fail");
        // wrong C_BJJ (different amount) must fail
        let proof2 = h(PROOF);
        let mut cb2 = cb;
        cb2[0] ^= 1;
        assert!(!verify_xcurve(&proof2, &cs, &cb2), "wrong C_BJJ must fail");
    }
}
