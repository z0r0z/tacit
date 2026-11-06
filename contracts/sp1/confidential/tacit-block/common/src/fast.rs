//! The note tree's Poseidon and the deposit and exit openings in the shape the zkVM runs fastest, written once over a small field
//! trait: Fr natively, where `check` holds them to btc-pool-halo2's reference functions, and canonical limbs with one
//! uint256_mulmod per product in the zkVM.
//!
//! Poseidon (circomlib's, t = 3: four full rounds, 57 partial, four full) with its partial rounds made cheap: each adds one scalar
//! constant to the first word, raises it to the fifth power and multiplies by a sparse matrix (five products, not nine), the dense
//! part of the matrices moved before the partial rounds into one matrix P and the constants' other words carried into the first full
//! round after them. The openings use fixed-base tables of the two generators in 4-bit windows and extended twisted Edwards
//! coordinates, so no inversion is taken and the result is compared with the commitment by cross-multiplying.

use btc_pool_halo2::model::{add as bjj_add, g_bjj, h_bjj, mds, partial_rounds, pedersen_bjj, poseidon, round_constant, BJJ_A, BJJ_D, FULL_ROUNDS};
use ff::{Field, PrimeField};
use halo2_proofs::halo2curves::bn256::Fr;
use num_bigint::BigUint;

/// The field operations both algorithms need.
pub trait Fe: Copy {
    fn zero() -> Self;
    fn one() -> Self;
    fn from_u64(v: u64) -> Self;
    fn add(&self, o: &Self) -> Self;
    fn sub(&self, o: &Self) -> Self;
    fn mul(&self, o: &Self) -> Self;
    fn same(&self, o: &Self) -> bool;
}

impl Fe for Fr {
    fn zero() -> Self {
        Fr::ZERO
    }
    fn one() -> Self {
        Fr::ONE
    }
    fn from_u64(v: u64) -> Self {
        Fr::from(v)
    }
    fn add(&self, o: &Self) -> Self {
        *self + o
    }
    fn sub(&self, o: &Self) -> Self {
        *self - o
    }
    fn mul(&self, o: &Self) -> Self {
        *self * o
    }
    fn same(&self, o: &Self) -> bool {
        self == o
    }
}

/// Where each part of the Poseidon constants sits in `poseidon_consts`: the first half's round constants (4 × 3), the MDS matrix and
/// P (row-major, 9 each), the partial rounds' scalar constants (57) and sparse matrices (57 × 5: the first row, then the first column
/// below it), and the second half's round constants (4 × 3, the first carrying what the partial rounds passed on).
pub const POSEIDON_PARTIAL: usize = 57;
const FIRST: usize = 0;
const M_AT: usize = 12;
const P_AT: usize = 21;
const GAMMA: usize = 30;
const SPARSE: usize = GAMMA + POSEIDON_PARTIAL;
const LAST: usize = SPARSE + 5 * POSEIDON_PARTIAL;
pub const POSEIDON_CONSTS: usize = LAST + 12;

type M3 = [[Fr; 3]; 3];

fn mat_mul(a: &M3, b: &M3) -> M3 {
    let mut c = [[Fr::ZERO; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            c[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    c
}

fn mat_vec(a: &M3, v: &[Fr; 3]) -> [Fr; 3] {
    [0, 1, 2].map(|i| (0..3).map(|k| a[i][k] * v[k]).sum())
}

/// The optimized constants, derived from btc-pool-halo2's round constants and MDS matrix. With a_i the state entering partial round
/// i and c_i its constants, b_i = a_i + δ_i runs on scalar constants γ_i = c_i0 − δ_i0, where δ_0 = 0 and δ_{i+1} = −M (0, c_i − δ_i)
/// on the last two words (the S-box leaves them alone, so their constants pass through linearly); the first full round after takes
/// c − δ. Each partial round's M is then split right to left as D_{i+1} M = S_i D_i with D_i = diag(1, N̂) (N̂ the lower right 2 × 2
/// block of D_{i+1} M, D_R = I) and S_i sparse; D_i commutes with an S-box on the first word, so the D's gather into P = D_0 M.
pub fn poseidon_consts() -> Vec<Fr> {
    assert_eq!(partial_rounds(3), POSEIDON_PARTIAL, "Poseidon's partial rounds");
    let half = FULL_ROUNDS / 2;
    let c = |r: usize, j: usize| round_constant(3, r, j);
    let m: M3 = [0, 1, 2].map(|i| [0, 1, 2].map(|j| mds(3, i, j)));
    let mut out = Vec::with_capacity(POSEIDON_CONSTS);
    for r in 0..half {
        out.extend((0..3).map(|j| c(r, j)));
    }
    out.extend(m.iter().flatten());
    // constants
    let mut delta = [Fr::ZERO; 3];
    let mut gamma = vec![];
    for i in 0..POSEIDON_PARTIAL {
        let r = half + i;
        gamma.push(c(r, 0) - delta[0]);
        let mv = mat_vec(&m, &[Fr::ZERO, c(r, 1) - delta[1], c(r, 2) - delta[2]]);
        delta = mv.map(|x| -x);
    }
    // matrices, right to left
    let mut d: M3 = [[Fr::ONE, Fr::ZERO, Fr::ZERO], [Fr::ZERO, Fr::ONE, Fr::ZERO], [Fr::ZERO, Fr::ZERO, Fr::ONE]];
    let mut sparse = vec![[Fr::ZERO; 5]; POSEIDON_PARTIAL];
    for i in (0..POSEIDON_PARTIAL).rev() {
        let n = mat_mul(&d, &m);
        let det = n[1][1] * n[2][2] - n[1][2] * n[2][1];
        let inv = det.invert().expect("an MDS block is invertible");
        let ni = [[n[2][2] * inv, -n[1][2] * inv], [-n[2][1] * inv, n[1][1] * inv]];
        sparse[i] = [n[0][0], n[0][1] * ni[0][0] + n[0][2] * ni[1][0], n[0][1] * ni[0][1] + n[0][2] * ni[1][1], n[1][0], n[2][0]];
        d = [[Fr::ONE, Fr::ZERO, Fr::ZERO], [Fr::ZERO, n[1][1], n[1][2]], [Fr::ZERO, n[2][1], n[2][2]]];
    }
    out.extend(mat_mul(&d, &m).iter().flatten());
    out.extend(gamma);
    out.extend(sparse.iter().flatten());
    let r = half + POSEIDON_PARTIAL;
    out.extend((0..3).map(|j| c(r, j) - delta[j]));
    for r in r + 1..FULL_ROUNDS + POSEIDON_PARTIAL {
        out.extend((0..3).map(|j| c(r, j)));
    }
    assert_eq!(out.len(), POSEIDON_CONSTS);
    out
}

fn pow5<F: Fe>(x: &F) -> F {
    let x2 = x.mul(x);
    let x4 = x2.mul(&x2);
    x4.mul(x)
}

fn mix<F: Fe>(k: &impl Fn(usize) -> F, at: usize, s: &[F; 3]) -> [F; 3] {
    [0, 1, 2].map(|i| k(at + 3 * i).mul(&s[0]).add(&k(at + 3 * i + 1).mul(&s[1])).add(&k(at + 3 * i + 2).mul(&s[2])))
}

/// circomlib Poseidon(a, b) from the constants `poseidon_consts` lays out (`k(i)` the i-th).
pub fn poseidon2<F: Fe>(k: &impl Fn(usize) -> F, a: &F, b: &F) -> F {
    let half = FULL_ROUNDS / 2;
    let mut s = [F::zero(), *a, *b];
    for r in 0..half {
        for j in 0..3 {
            s[j] = s[j].add(&k(FIRST + 3 * r + j));
        }
        s = s.map(|x| pow5(&x));
        s = mix(k, if r + 1 < half { M_AT } else { P_AT }, &s);
    }
    for i in 0..POSEIDON_PARTIAL {
        let x = pow5(&s[0].add(&k(GAMMA + i)));
        let o = SPARSE + 5 * i;
        let first = k(o).mul(&x).add(&k(o + 1).mul(&s[1])).add(&k(o + 2).mul(&s[2]));
        s[1] = k(o + 3).mul(&x).add(&s[1]);
        s[2] = k(o + 4).mul(&x).add(&s[2]);
        s[0] = first;
    }
    for r in 0..half {
        for j in 0..3 {
            s[j] = s[j].add(&k(LAST + 3 * r + j));
        }
        s = s.map(|x| pow5(&x));
        s = mix(k, M_AT, &s);
    }
    s[0]
}

/// Windows of the fixed-base tables: 16 of the value (a u64) and 63 of the blinding (below l < 2^252), 15 multiples each.
pub const H_WINDOWS: usize = 16;
pub const G_WINDOWS: usize = 63;
pub const TABLE_POINTS: usize = 15 * (H_WINDOWS + G_WINDOWS);

/// The fixed-base tables as `tacit-block pin` writes artifacts/pedersen.bin: for H then G, window by window, j · 16^w times the
/// generator for j = 1..15, each as x, y and d·x·y, 32 little-endian canonical bytes apiece.
pub fn pedersen_tables() -> Vec<u8> {
    let d = Fr::from(BJJ_D);
    let mut out = Vec::with_capacity(96 * TABLE_POINTS);
    for (base, windows) in [(h_bjj(), H_WINDOWS), (g_bjj(), G_WINDOWS)] {
        let mut b = base;
        for _ in 0..windows {
            let mut acc = b;
            for _ in 1..16 {
                for f in [acc[0], acc[1], d * acc[0] * acc[1]] {
                    out.extend_from_slice(f.to_repr().as_ref());
                }
                acc = bjj_add(&acc, &b);
            }
            b = acc;
        }
    }
    out
}

/// P + Q for P in extended coordinates (X, Y, Z, T = XY/Z) and Q affine with d·x·y given (the unified formula, complete on BabyJubJub).
fn add_mixed<F: Fe>(p: &[F; 4], q: &[F; 3], a: &F) -> [F; 4] {
    let [x1, y1, z1, t1] = *p;
    let [x2, y2, dt2] = *q;
    let aa = x1.mul(&x2);
    let bb = y1.mul(&y2);
    let cc = t1.mul(&dt2);
    let ee = x1.add(&y1).mul(&x2.add(&y2)).sub(&aa).sub(&bb);
    let ff = z1.sub(&cc);
    let gg = z1.add(&cc);
    let hh = bb.sub(&a.mul(&aa));
    [ee.mul(&ff), gg.mul(&hh), ff.mul(&gg), ee.mul(&hh)]
}

/// v·H + r·G in extended coordinates from the tables (`t(i)` the i-th field element of `pedersen_tables`), `r` little-endian below l.
pub fn pedersen<F: Fe>(t: &impl Fn(usize) -> F, v: u64, r: &[u8; 32]) -> [F; 4] {
    let a = F::from_u64(BJJ_A);
    let mut p = [F::zero(), F::one(), F::one(), F::zero()];
    let point = |i: usize| [t(3 * i), t(3 * i + 1), t(3 * i + 2)];
    for w in 0..H_WINDOWS {
        let j = ((v >> (4 * w)) & 15) as usize;
        if j != 0 {
            p = add_mixed(&p, &point(15 * w + j - 1), &a);
        }
    }
    for w in 0..G_WINDOWS {
        let j = ((r[w / 2] >> (4 * (w % 2))) & 15) as usize;
        if j != 0 {
            p = add_mixed(&p, &point(15 * (H_WINDOWS + w) + j - 1), &a);
        }
    }
    p
}

/// The opening's blinding as `pedersen` takes it: reduced mod l, little-endian.
pub fn blinding(r: &[u8; 32]) -> [u8; 32] {
    let rr = (BigUint::from_bytes_be(r) % btc_pool_halo2::model::l_big()).to_bytes_le();
    let mut out = [0u8; 32];
    out[..rr.len()].copy_from_slice(&rr);
    out
}

/// Whether the extended point `p` is the affine point `c`.
pub fn is<F: Fe>(p: &[F; 4], c: &[F; 2]) -> bool {
    p[0].same(&c[0].mul(&p[2])) && p[1].same(&c[1].mul(&p[2]))
}

/// The fast forms held to the reference ones: Poseidon on chosen and pseudo-random inputs, and the openings on values and blindings
/// from zero to past l, each against btc-pool-halo2's `poseidon` and `pedersen_bjj`.
pub fn check(consts: &[Fr], tables: &[u8]) -> Result<(), String> {
    let k = |i: usize| consts[i];
    let mut x = Fr::from(7u64);
    let mut inputs = vec![(Fr::ZERO, Fr::ZERO), (Fr::ONE, Fr::ZERO), (Fr::ZERO, -Fr::ONE), (-Fr::ONE, -Fr::ONE)];
    for _ in 0..60 {
        x = x * x + Fr::from(3u64);
        let y = x * x + x;
        inputs.push((x, y));
    }
    for (a, b) in inputs {
        if poseidon2(&k, &a, &b) != poseidon(&[a, b]) {
            return Err(format!("Poseidon({a:?}, {b:?}) differs from the reference"));
        }
    }
    let t = |i: usize| -> Fr {
        let mut b = [0u8; 32];
        b.copy_from_slice(&tables[32 * i..32 * i + 32]);
        Option::from(Fr::from_repr(b)).expect("a table entry is canonical")
    };
    let l = btc_pool_halo2::model::l_big().clone();
    let mut seed = BigUint::from(0x1234_5678_9abc_def0u64);
    let mut cases: Vec<(u64, BigUint)> = vec![(0, BigUint::from(0u8)), (1, BigUint::from(0u8)), (0, BigUint::from(1u8)), (u64::MAX, &l - 1u8), (5, l.clone()), (9, &l + 3u8)];
    for i in 0..40u64 {
        seed = (&seed * &seed + 0x9e37u32) % (BigUint::from(1u8) << 256);
        cases.push((i.wrapping_mul(0x9e3779b97f4a7c15) ^ (i << 40), seed.clone()));
    }
    for (v, r) in cases {
        let mut be = r.to_bytes_be();
        if be.len() > 32 {
            continue;
        }
        while be.len() < 32 {
            be.insert(0, 0);
        }
        let rb: [u8; 32] = be.try_into().unwrap();
        let want = pedersen_bjj(&BigUint::from(v), &r);
        if !is(&pedersen(&t, v, &blinding(&rb)), &want) {
            return Err(format!("the opening of ({v}, {r}) differs from the reference"));
        }
    }
    Ok(())
}
