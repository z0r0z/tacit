//! secp256k1 ↔ BabyJub boundary: `C_secp(33) ‖ C_bjj(32) ‖ sigma(169) ‖ bpp(591)`.
//!
//! sigma is the cross-curve sigma (`babyjubjub::verify_xcurve`, the verifier T_SWAP_BATCH uses); bpp is a
//! 64-bit Bulletproofs+ proof on `C_secp` (`cxfer_core::verify_range`). The circuit bounds the BabyJub
//! value below 2^64, so with both sides range-bound the sigma's per-order equality is integer equality.
//! Shield: `C_secp` = the kernel's pool commitment, `C_bjj` = depC. Exit: `C_secp` = the new transparent
//! note, `C_bjj` = exitC.

use crate::{babyjubjub, pt_eq, identity, Pt};

pub const SIGMA_LEN: usize = 169;
pub const BPP_M1_LEN: usize = 591;
pub const BOUNDARY_LEN: usize = 33 + 32 + SIGMA_LEN + BPP_M1_LEN;

pub struct Boundary<'a> {
    pub c_secp: [u8; 33],
    pub c_bjj: [u8; 32],
    pub sigma: [u8; SIGMA_LEN],
    pub bpp: &'a [u8],
}

pub fn parse(b: &[u8]) -> Option<Boundary<'_>> {
    if b.len() != BOUNDARY_LEN {
        return None;
    }
    Some(Boundary {
        c_secp: b[0..33].try_into().ok()?,
        c_bjj: b[33..65].try_into().ok()?,
        sigma: b[65..65 + SIGMA_LEN].try_into().ok()?,
        bpp: &b[65 + SIGMA_LEN..],
    })
}

/// Returns the BabyJub commitment (for the circuit's exitC / depC public inputs) iff the crossing is valid.
pub fn verify(bd: &Boundary) -> Option<Pt> {
    if bd.bpp.len() != BPP_M1_LEN {
        return None;
    }
    let cs = cxfer_core::decompress(&bd.c_secp)?;
    let cb = babyjubjub::unpack(&bd.c_bjj)?;
    if pt_eq(&cb, &identity()) {
        return None;
    }
    if !babyjubjub::verify_xcurve(&bd.sigma, &bd.c_secp, &bd.c_bjj) {
        return None;
    }
    if !cxfer_core::verify_range(&[cs], bd.bpp) {
        return None;
    }
    Some(cb)
}

pub fn verify_bytes(b: &[u8]) -> Option<Pt> {
    verify(&parse(b)?)
}
