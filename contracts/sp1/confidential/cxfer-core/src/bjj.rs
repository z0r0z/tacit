//! BabyJubJub (twisted Edwards over BN254 Fr) — port of `tests/amm-bjj.mjs`. The crypto
//! foundation for confidential swaps on Ethereum (`OP_SWAP`): the `C_in_BJJ` / `C_out_BJJ`
//! Pedersen openings and (with `sigma`) the secp↔BJJ binding. Byte-for-byte compatible
//! with the JS prover + `amm_swap_batch.circom` (NUMS generators, circomlib `packPoint`).
//!
//! Curve: `A·u² + v² = 1 + D·u²·v²`, `A = 168700`, `D = 168696`, over the BN254 scalar
//! field `p_Fr`. Identity is `(0, 1)`. Native-tested against JS KATs.

use num_bigint::BigUint;
use num_traits::{One, Zero};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

fn p() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| {
        BigUint::parse_bytes(
            b"21888242871839275222246405745257275088548364400416034343698204186575808495617",
            10,
        )
        .unwrap()
    })
}
fn a_bjj() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| BigUint::from(168700u32))
}
fn d_bjj() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| BigUint::from(168696u32))
}
fn order_bjj() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| {
        BigUint::parse_bytes(
            b"21888242871839275222246405745257275088614511777268538073601725287587578984328",
            10,
        )
        .unwrap()
    })
}
fn n_bjj() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| order_bjj() / 8u32)
}

// ── field arithmetic mod p_Fr ──
fn fmul(a: &BigUint, b: &BigUint) -> BigUint { (a * b) % p() }
fn fadd(a: &BigUint, b: &BigUint) -> BigUint { (a + b) % p() }
fn fsub(a: &BigUint, b: &BigUint) -> BigUint { (a + p() - (b % p())) % p() }
fn fpow(a: &BigUint, e: &BigUint) -> BigUint { a.modpow(e, p()) }
fn finv(a: &BigUint) -> BigUint { a.modpow(&(p() - 2u32), p()) } // Fermat (p prime)

/// Tonelli-Shanks sqrt mod p (returns None if not a QR). Matches the JS.
fn fsqrt(n: &BigUint) -> Option<BigUint> {
    let n = n % p();
    if n.is_zero() {
        return Some(BigUint::zero());
    }
    let pm1 = p() - 1u32;
    if fpow(&n, &(&pm1 / 2u32)) != BigUint::one() {
        return None;
    }
    let mut q = pm1.clone();
    let mut s = 0u32;
    while (&q & BigUint::one()).is_zero() {
        q >>= 1;
        s += 1;
    }
    if s == 1 {
        return Some(fpow(&n, &((p() + 1u32) / 4u32)));
    }
    let mut z = BigUint::from(2u32);
    while fpow(&z, &(&pm1 / 2u32)) != pm1 {
        z += 1u32;
    }
    let mut m = s;
    let mut c = fpow(&z, &q);
    let mut t = fpow(&n, &q);
    let mut r = fpow(&n, &((&q + 1u32) / 2u32));
    loop {
        if t == BigUint::one() {
            return Some(r);
        }
        let mut i = 0u32;
        let mut tmp = t.clone();
        while tmp != BigUint::one() {
            tmp = fmul(&tmp, &tmp);
            i += 1;
            if i >= m {
                return None;
            }
        }
        let b = fpow(&c, &(BigUint::one() << (m - i - 1)));
        m = i;
        c = fmul(&b, &b);
        t = fmul(&t, &c);
        r = fmul(&r, &b);
    }
}

/// A BabyJubJub point in affine (u, v).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Point {
    pub u: BigUint,
    pub v: BigUint,
}

pub fn identity() -> Point { Point { u: BigUint::zero(), v: BigUint::one() } }
pub fn is_identity(pt: &Point) -> bool { pt.u.is_zero() && pt.v == BigUint::one() }

pub fn on_curve(pt: &Point) -> bool {
    let u2 = fmul(&pt.u, &pt.u);
    let v2 = fmul(&pt.v, &pt.v);
    let lhs = fadd(&fmul(a_bjj(), &u2), &v2);
    let rhs = fadd(&BigUint::one(), &fmul(d_bjj(), &fmul(&u2, &v2)));
    lhs == rhs
}

/// Complete twisted-Edwards addition.
pub fn add(p1: &Point, p2: &Point) -> Point {
    let u1u2 = fmul(&p1.u, &p2.u);
    let v1v2 = fmul(&p1.v, &p2.v);
    let dprod = fmul(d_bjj(), &fmul(&u1u2, &v1v2));
    let inv1 = finv(&fadd(&BigUint::one(), &dprod));
    let inv2 = finv(&fsub(&BigUint::one(), &dprod));
    let u3 = fmul(&fadd(&fmul(&p1.u, &p2.v), &fmul(&p1.v, &p2.u)), &inv1);
    let v3 = fmul(&fsub(&v1v2, &fmul(a_bjj(), &u1u2)), &inv2);
    Point { u: u3, v: v3 }
}

pub fn mul(pt: &Point, k: &BigUint) -> Point {
    let mut r = identity();
    let mut acc = pt.clone();
    let mut e = k % order_bjj();
    while !e.is_zero() {
        if (&e & BigUint::one()) == BigUint::one() {
            r = add(&r, &acc);
        }
        acc = add(&acc, &acc);
        e >>= 1;
    }
    r
}

/// circomlib packPoint: v little-endian (32 B); the sign of u (u > (p-1)/2) in bit 255.
pub fn pack(pt: &Point) -> [u8; 32] {
    let mut out = [0u8; 32];
    let vb = pt.v.to_bytes_le();
    out[..vb.len().min(32)].copy_from_slice(&vb[..vb.len().min(32)]);
    if pt.u > (p() - 1u32) / 2u32 {
        out[31] |= 0x80;
    }
    out
}

/// The prime subgroup order n_BJJ (for sigma range checks).
pub fn subgroup_order() -> BigUint { n_bjj().clone() }

/// True iff P is in the prime-order subgroup (cofactor 8) — required for binding.
pub fn in_subgroup(pt: &Point) -> bool { is_identity(pt) || is_identity(&mul(pt, n_bjj())) }

/// circomlib unpackPoint: decode (v LE + sign bit) → (u, v), recovering u via the curve
/// equation. Rejects off-curve, out-of-field, and non-prime-subgroup points. Matches JS.
pub fn unpack(buf: &[u8; 32]) -> Option<Point> {
    let mut work = *buf;
    let sign = (work[31] & 0x80) != 0;
    work[31] &= 0x7f;
    let v = BigUint::from_bytes_le(&work);
    if &v >= p() {
        return None;
    }
    let v2 = fmul(&v, &v);
    let num = fsub(&BigUint::one(), &v2);
    let den = fsub(a_bjj(), &fmul(d_bjj(), &v2));
    if den.is_zero() {
        return None;
    }
    let u2 = fmul(&num, &finv(&den));
    let mut u = fsqrt(&u2)?;
    let half = (p() - 1u32) / 2u32;
    if (u > half) != sign {
        u = fsub(&BigUint::zero(), &u);
    }
    let pt = Point { u, v };
    if !in_subgroup(&pt) {
        return None;
    }
    Some(pt)
}

fn digest_to_scalar(d: &[u8; 32]) -> BigUint { BigUint::from_bytes_be(d) % p() }

/// NUMS try-and-increment generator (AMM.md). digest big-endian → u; counter u32 LE.
fn derive_generator(seed: &[u8]) -> Point {
    for c in 0u32..1024 {
        let mut h = Sha256::new();
        h.update(seed);
        h.update(c.to_le_bytes());
        let digest: [u8; 32] = h.finalize().into();
        let u = digest_to_scalar(&digest);
        let u2 = fmul(&u, &u);
        let num = fsub(&BigUint::one(), &fmul(a_bjj(), &u2));
        let den = fsub(&BigUint::one(), &fmul(d_bjj(), &u2));
        if den.is_zero() {
            continue;
        }
        let vsq = fmul(&num, &finv(&den));
        let mut v = match fsqrt(&vsq) {
            Some(v) => v,
            None => continue,
        };
        if (&v & BigUint::one()) == BigUint::one() {
            v = fsub(&BigUint::zero(), &v); // pick even-LSB root
        }
        let cand = Point { u: u.clone(), v };
        if !on_curve(&cand) {
            continue;
        }
        let q = mul(&cand, &BigUint::from(8u32)); // clear cofactor
        if is_identity(&q) {
            continue;
        }
        if !is_identity(&mul(&q, n_bjj())) {
            continue;
        }
        return q;
    }
    panic!("BJJ NUMS derivation: max iterations exceeded");
}

pub fn h_gen() -> &'static Point {
    static V: OnceLock<Point> = OnceLock::new();
    V.get_or_init(|| derive_generator(b"tacit-amm-bjj-H-v1"))
}
pub fn g_gen() -> &'static Point {
    static V: OnceLock<Point> = OnceLock::new();
    V.get_or_init(|| derive_generator(b"tacit-amm-bjj-G-v1"))
}

/// Pedersen commitment C = a·H_BJJ + r·G_BJJ (scalars reduced mod n_BJJ). a=r=0 → identity.
pub fn pedersen(amount: &BigUint, blinding: &BigUint) -> Point {
    let a = amount % n_bjj();
    let r = blinding % n_bjj();
    let ah = if a.is_zero() { identity() } else { mul(h_gen(), &a) };
    let rg = if r.is_zero() { identity() } else { mul(g_gen(), &r) };
    add(&ah, &rg)
}

/// Packed `a·H_BJJ + r·G_BJJ` from a u64 amount and a 32-byte big-endian blinding. The guest's
/// OP_SWAP opening check (compares against the witnessed packed commitment) without touching
/// BigUint; matches the JS `packPoint(pedersenBJJ(a, r))`.
pub fn pedersen_commit(amount: u64, blinding_be: &[u8; 32]) -> [u8; 32] {
    pack(&pedersen(&BigUint::from(amount), &BigUint::from_bytes_be(blinding_be)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(s: &str) -> BigUint { BigUint::parse_bytes(s.as_bytes(), 10).unwrap() }

    #[test]
    fn nums_generators_match_js() {
        let h = h_gen();
        assert_eq!(h.u, big("8860051794228765624784055720668791703344981051068813113765876182532050873765"));
        assert_eq!(h.v, big("9646676515308837211536143343491304968372508964725299602042231998647262935524"));
        assert!(on_curve(h));
        let g = g_gen();
        assert_eq!(g.u, big("10266161400728451878654657063038749398069744923142297801862881015748441185147"));
        assert_eq!(g.v, big("16409704628248567085528181932184581045280945922167020034355995328070141515908"));
        assert!(on_curve(g));
    }

    #[test]
    fn pedersen_kat_matches_js() {
        let c = pedersen(&BigUint::from(1500u32), &BigUint::from(12345u32));
        assert_eq!(c.u, big("19687788701820515647322701015791647910609634354239502532555303641909191700414"));
        assert_eq!(c.v, big("829229494631475926057557756692681223982619193189302552600134774839453545397"));
        assert!(on_curve(&c));
        assert_eq!(
            hex::encode(pack(&c)),
            "b5f3a96fac298b5f073aa2b44f7955c719df3d4c3ded8bdad32a0e6bc753d581",
            "circomlib packPoint KAT"
        );
    }

    #[test]
    fn add_and_mul_consistent() {
        let h = h_gen();
        let h2 = add(h, h);
        assert_eq!(h2, mul(h, &BigUint::from(2u32)), "H+H == 2H");
        assert!(is_identity(&mul(h, n_bjj())), "n_BJJ · H == identity (prime subgroup)");
    }
}
