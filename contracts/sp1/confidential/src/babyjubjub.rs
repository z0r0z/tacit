//! BabyJubJub (twisted Edwards over F_r = the BN254 scalar field) + the BabyJubJub half of the cross-curve
//! Camenisch-Stadler sigma, for T_SWAP_BATCH receipt onboarding: a batch receipt's secp note value is hidden,
//! bound only by the 169-byte `out_xcurve_sigma` to the Groth16-proven BabyJubJub commitment `C_out_BJJ`.
//! Verifying that sigma is what lets the reflection onboard `C_out_secp` as a real, bridgeable note.
//!
//! Mirrors dapp/amm-bjj.js + amm-sigma.js byte-for-byte. Curve: `a·u² + v² = 1 + d·u²·v²`, a=168700,
//! d=168696; identity `(0,1)`. Reflection-bin only (links `bn` for F_r, like groth16.rs); the secp half +
//! the FS challenge live in cxfer-core (`xcurve_secp_check` / `xcurve_challenge`, native-tested). BOX-ONLY:
//! validated natively in a standalone harness against real dapp vectors (cargo can't build the guest here).
//!
//! Soundness: BOTH halves of the sigma must verify; the shared 320-bit response `z_a` (reduced mod each
//! curve's order) binds the SAME hidden amount across secp and BabyJubJub, so a settler can't put a
//! `C_out_secp` committing a different value than the Groth16-cleared `C_out_BJJ`.

use bn::{arith::U256, Fr};
use cxfer_core::{xcurve_challenge, xcurve_secp_check};

type Pt = (Fr, Fr);

fn hx(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut a = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        let hi = (b[2 * i] as char).to_digit(16).expect("hex") as u8;
        let lo = (b[2 * i + 1] as char).to_digit(16).expect("hex") as u8;
        a[i] = (hi << 4) | lo;
        i += 1;
    }
    a
}

fn fr_hex(h: &[u8; 32]) -> Fr {
    Fr::from_slice(h).expect("canonical field element")
}
fn fr_dec(s: &str) -> Fr {
    Fr::from_str(s).expect("decimal field element")
}

// Curve parameters.
fn a_bjj() -> Fr {
    fr_dec("168700")
}
fn d_bjj() -> Fr {
    fr_dec("168696")
}
fn identity() -> Pt {
    (Fr::zero(), Fr::one())
}
fn pt_eq(p: &Pt, q: &Pt) -> bool {
    p.0 == q.0 && p.1 == q.1
}

/// The NUMS Pedersen generators (dapp `H_BJJ()` / `G_BJJ()`); the canonical-integer coordinates are pinned
/// here + validated against the dapp's hash-to-curve in the harness.
pub fn h_bjj() -> Pt {
    (
        fr_hex(&hx("13969c921b0a36e78280a9ff5415b7756761b630fd5fa30d7537e3640cbf6da5")),
        fr_hex(&hx("1553d34ea48b8d61df6de5ca9ae5d95183746714ba21af253a46c18a6c2279e4")),
    )
}
pub fn g_bjj() -> Pt {
    (
        fr_hex(&hx("16b271021d857578ee55d438a32eed9081bfe28579f6e671c87c58a035b49b7b")),
        fr_hex(&hx("2447904d61713ffa77c624c908255001a5f369e2548764cb4adbc6e454ae9884")),
    )
}

// (P_FR − 1) / 2 — the high-half threshold for the point-compression sign bit.
fn pm1d2() -> U256 {
    fr_dec("10944121435919637611123202872628637544274182200208017171849102093287904247808").into_u256()
}
// N_BJJ = ORDER_BJJ / 8 (the prime subgroup order), big-endian.
fn n_bjj_bytes() -> [u8; 32] {
    hx("060c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1")
}
// P_FR (the field modulus), big-endian — for the canonical-`v` range check in unpack.
fn p_fr_bytes() -> [u8; 32] {
    hx("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001")
}

fn be_lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
        i += 1;
    }
    false
}

fn fr_gt_half(u: &Fr) -> bool {
    u.into_u256() > pm1d2()
}

/// Complete twisted-Edwards addition (a is a square, d a non-square ⇒ denominators never vanish for curve
/// points; `unwrap_or(zero)` is a defensive fail-closed, never reached for valid points).
pub fn add(p: &Pt, q: &Pt) -> Pt {
    let (u1, v1) = *p;
    let (u2, v2) = *q;
    let u1u2 = u1 * u2;
    let v1v2 = v1 * v2;
    let dprod = d_bjj() * u1u2 * v1v2;
    let inv1 = (Fr::one() + dprod).inverse().unwrap_or_else(Fr::zero);
    let inv2 = (Fr::one() - dprod).inverse().unwrap_or_else(Fr::zero);
    let u3 = (u1 * v2 + v1 * u2) * inv1;
    let v3 = (v1v2 - a_bjj() * u1u2) * inv2;
    (u3, v3)
}

/// Scalar multiplication by a big-endian scalar (MSB-first double-and-add). The scalar need not be reduced:
/// for a subgroup point of order N_BJJ, `k·P == (k mod N_BJJ)·P`, so passing the raw 320-bit `z_a` is exact.
pub fn mul_bits(p: &Pt, scalar_be: &[u8]) -> Pt {
    let mut r = identity();
    for &byte in scalar_be.iter() {
        let mut bit: i32 = 7;
        while bit >= 0 {
            r = add(&r, &r);
            if (byte >> bit) & 1 == 1 {
                r = add(&r, p);
            }
            bit -= 1;
        }
    }
    r
}

/// Tonelli-Shanks square root in F_r (P_FR has 2-adicity S=28; non-residue 5). Returns None for a non-residue.
fn fr_sqrt(n: Fr) -> Option<Fr> {
    if n.is_zero() {
        return Some(Fr::zero());
    }
    let exp_half = fr_dec("10944121435919637611123202872628637544274182200208017171849102093287904247808"); // (p−1)/2
    if n.pow(exp_half) != Fr::one() {
        return None; // not a quadratic residue
    }
    let q = fr_dec("81540058820840996586704275553141814055101440848469862132140264610111"); // odd part of p−1
    let q_plus_1_over_2 = fr_dec("40770029410420498293352137776570907027550720424234931066070132305056");
    let nonresidue = fr_dec("5");
    let mut m: u32 = 28; // S
    let mut c = nonresidue.pow(q);
    let mut t = n.pow(q);
    let mut r = n.pow(q_plus_1_over_2);
    loop {
        if t == Fr::one() {
            return Some(r);
        }
        let mut i = 0u32;
        let mut tmp = t;
        while tmp != Fr::one() {
            tmp = tmp * tmp;
            i += 1;
            if i >= m {
                return None;
            }
        }
        let mut b = c;
        let mut j = 0u32;
        while j < m - i - 1 {
            b = b * b;
            j += 1;
        }
        m = i;
        c = b * b;
        t = t * c;
        r = r * b;
    }
}

/// Decompress a 32-byte packed BabyJubJub point (v-coord little-endian, sign of u in the high bit of byte 31)
/// → `(u, v)`. Mirrors dapp/amm-bjj.js `unpackPoint`: recover `u² = (1 − v²)/(a − d·v²)`, take the root,
/// fix the sign, and require the point be in the prime-order subgroup. None on a non-canonical v, a non-square
/// u², or a non-subgroup point (fail-closed).
pub fn unpack(buf: &[u8; 32]) -> Option<Pt> {
    let mut work = *buf;
    let sign = (work[31] & 0x80) != 0;
    work[31] &= 0x7f;
    let mut be = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        be[i] = work[31 - i];
        i += 1;
    }
    if !be_lt(&be, &p_fr_bytes()) {
        return None; // v ≥ P_FR (matches the dapp's `v >= P_FR` reject; avoids a silent reduction)
    }
    let v = Fr::from_slice(&be).ok()?;
    let v2 = v * v;
    let num = Fr::one() - v2;
    let den = a_bjj() - d_bjj() * v2;
    let u2 = num * den.inverse()?;
    let mut u = fr_sqrt(u2)?;
    if fr_gt_half(&u) != sign {
        u = Fr::zero() - u;
    }
    let p = (u, v);
    if !pt_eq(&mul_bits(&p, &n_bjj_bytes()), &identity()) {
        return None; // not in the prime-order subgroup
    }
    Some(p)
}

/// Verify a 169-byte cross-curve sigma binding `C_secp` (secp256k1 Pedersen) and `C_BJJ` (BabyJubJub Pedersen)
/// to a SHARED hidden amount. Layout: `A_secp(33) ‖ A_BJJ(32) ‖ z_a(40) ‖ z_r_secp(32) ‖ z_r_BJJ(32)`.
/// Both halves must hold:
///   secp: `z_a·H_secp + z_r_secp·G_secp == A_secp + e·C_secp`  (cxfer-core)
///   BJJ:  `z_a·H_BJJ  + z_r_BJJ·G_BJJ  == A_BJJ  + e·C_BJJ`   (here)
/// with `e` the 128-bit FS challenge. Fail-closed (returns false) on any decode / range / curve / equation
/// failure. Mirrors dapp/amm-sigma.js `verifyXCurve`.
pub fn verify_xcurve(proof: &[u8; 169], c_secp: &[u8; 33], c_bjj: &[u8; 32]) -> bool {
    let a_secp: [u8; 33] = proof[0..33].try_into().unwrap();
    let a_bjj_b: [u8; 32] = proof[33..65].try_into().unwrap();
    let z_a: [u8; 40] = proof[65..105].try_into().unwrap();
    let z_r_secp: [u8; 32] = proof[105..137].try_into().unwrap();
    let z_r_bjj: [u8; 32] = proof[137..169].try_into().unwrap();

    // z_r_BJJ must be canonical (< N_BJJ) — mirrors the dapp's `z_r_BJJ >= N_BJJ` reject. (z_a < 2^320 and
    // z_r_secp < n are enforced by their byte-widths / cxfer-core's canonical parse.)
    if !be_lt(&z_r_bjj, &n_bjj_bytes()) {
        return false;
    }
    let e = xcurve_challenge(c_secp, c_bjj, &a_secp, &a_bjj_b);
    // secp half (cxfer-core; native-validated against the same dapp vector).
    if !xcurve_secp_check(c_secp, &a_secp, &z_a, &z_r_secp, &e) {
        return false;
    }
    // BabyJubJub half.
    let cb = match unpack(c_bjj) {
        Some(p) => p,
        None => return false,
    };
    let ab = match unpack(&a_bjj_b) {
        Some(p) => p,
        None => return false,
    };
    let lhs = add(&mul_bits(&h_bjj(), &z_a), &mul_bits(&g_bjj(), &z_r_bjj));
    let rhs = add(&ab, &mul_bits(&cb, &e));
    pt_eq(&lhs, &rhs)
}
