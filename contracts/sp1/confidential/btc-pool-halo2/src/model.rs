//! Reference model of dapp/btc-pool-zk.js over halo2curves' BN254 Fr: circomlib Poseidon, BabyJubJub,
//! keys, tree, nullifier, EdDSA-Poseidon, BabyJub Pedersen and the spend witness.

use ff::{Field, PrimeField};
use halo2_proofs::halo2curves::bn256::Fr;
use num_bigint::BigUint;
use num_traits::{One, Zero};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[path = "../../btc-pool-zk-core/src/poseidon_constants.rs"]
#[allow(dead_code)]
mod poseidon_constants;
use poseidon_constants::*;

pub const TREE_DEPTH: usize = 32;
pub const N_IN: usize = 2;
pub const N_OUT: usize = 3;
pub const N_PUBLIC: usize = 12;

pub const TAG_SPEND: &str = "tacit-btc-pool-zk-wallet-spend-v1";
pub const TAG_NK: &str = "tacit-btc-pool-zk-wallet-nk-v1";
pub const TAG_AUTH_TWEAK: &str = "tacit-btc-pool-zk-auth-tweak-v1";
pub const TAG_NK_TWEAK: &str = "tacit-btc-pool-zk-nk-tweak-v1";
pub const TAG_RHO: &str = "tacit-btc-pool-zk-rho-v1";
pub const TAG_ASSET: &str = "tacit-btc-pool-zk-asset-v1";
pub const TAG_BODY: &str = "tacit-btc-pool-zk-body-v1";
pub const TAG_NONCE: &str = "tacit-btc-pool-zk-eddsa-nonce-v1";

pub const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
pub const L_DEC: &str = "2736030358979909402780800718157159386076813972158567259200215660948447373041";
const ORDER_DEC: &str = "21888242871839275222246405745257275088614511777268538073601725287587578984328";
pub const SECP_N_HEX: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

pub const BJJ_A: u64 = 168700;
pub const BJJ_D: u64 = 168696;
pub const BASE8: [&str; 2] = [
    "5299619240641551281634865583518297030282874472190772894086521144482721001553",
    "16950150798460657717958625567821834550301663161624707787222815936182638968203",
];
pub const H_BJJ: [&str; 2] = [
    "8860051794228765624784055720668791703344981051068813113765876182532050873765",
    "9646676515308837211536143343491304968372508964725299602042231998647262935524",
];
pub const G_BJJ: [&str; 2] = [
    "10266161400728451878654657063038749398069744923142297801862881015748441185147",
    "16409704628248567085528181932184581045280945922167020034355995328070141515908",
];

pub type Pt = [Fr; 2];

// ── field / integer helpers ──

pub fn big(dec: &str) -> BigUint {
    BigUint::parse_bytes(dec.as_bytes(), 10).expect("decimal")
}
pub fn p_big() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| big(P_DEC))
}
pub fn l_big() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| big(L_DEC))
}
fn order_big() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| big(ORDER_DEC))
}
pub fn secp_n() -> BigUint {
    BigUint::parse_bytes(SECP_N_HEX.as_bytes(), 16).unwrap()
}

pub fn fr(x: &BigUint) -> Fr {
    let r = x % p_big();
    let mut le = r.to_bytes_le();
    le.resize(32, 0);
    Fr::from_repr(le.try_into().unwrap()).unwrap()
}
pub fn fr_dec(dec: &str) -> Fr {
    fr(&big(dec))
}
/// Decimal string, possibly negative, reduced mod p (snarkjs input semantics).
pub fn fr_signed_dec(s: &str) -> Option<Fr> {
    let s = s.trim();
    let (neg, digits) = match s.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let v = fr(&big(digits));
    Some(if neg { -v } else { v })
}
pub fn to_big(x: &Fr) -> BigUint {
    BigUint::from_bytes_le(x.to_repr().as_ref())
}
pub fn to_dec(x: &Fr) -> String {
    to_big(x).to_str_radix(10)
}
pub fn fr_u64(v: u64) -> Fr {
    Fr::from(v)
}
/// Bit i of the canonical integer of x.
pub fn bit(x: &Fr, i: usize) -> bool {
    let r = x.to_repr();
    (r.as_ref()[i / 8] >> (i % 8)) & 1 == 1
}

// ── Poseidon (circomlib) ──

struct PoseidonParams {
    c: Vec<Fr>,
    m: Vec<Vec<Fr>>,
    partial: usize,
}

fn fr_hex(h: &str) -> Fr {
    let mut be = hex::decode(h).expect("hex");
    be.reverse();
    Fr::from_repr(be.try_into().unwrap()).unwrap()
}

fn build<const T: usize>(c: &[&str], m: &[[&str; T]; T], partial: usize) -> PoseidonParams {
    PoseidonParams {
        c: c.iter().map(|h| fr_hex(h)).collect(),
        m: m.iter().map(|row| row.iter().map(|h| fr_hex(h)).collect()).collect(),
        partial,
    }
}

fn params(t: usize) -> &'static PoseidonParams {
    static P3: OnceLock<PoseidonParams> = OnceLock::new();
    static P4: OnceLock<PoseidonParams> = OnceLock::new();
    static P5: OnceLock<PoseidonParams> = OnceLock::new();
    static P6: OnceLock<PoseidonParams> = OnceLock::new();
    match t {
        3 => P3.get_or_init(|| build(&C3, &M3, 57)),
        4 => P4.get_or_init(|| build(&C4, &M4, 56)),
        5 => P5.get_or_init(|| build(&C5, &M5, 60)),
        6 => P6.get_or_init(|| build(&C6, &M6, 60)),
        _ => panic!("poseidon: width {t}"),
    }
}

pub const FULL_ROUNDS: usize = 8;

/// Partial rounds for width t.
pub fn partial_rounds(t: usize) -> usize {
    params(t).partial
}
/// Round constant for round r, lane j, width t.
pub fn round_constant(t: usize, r: usize, j: usize) -> Fr {
    params(t).c[r * t + j]
}
/// MDS entry (i, j) for width t: new_i = Σ_j M[i][j]·s_j.
pub fn mds(t: usize, i: usize, j: usize) -> Fr {
    params(t).m[i][j]
}
pub fn is_full_round(t: usize, r: usize) -> bool {
    r < FULL_ROUNDS / 2 || r >= FULL_ROUNDS / 2 + partial_rounds(t)
}

pub fn pow5(x: Fr) -> Fr {
    let x2 = x.square();
    x2.square() * x
}

/// One round in place.
pub fn poseidon_round(t: usize, r: usize, s: &mut [Fr]) {
    let p = params(t);
    for j in 0..t {
        s[j] += p.c[r * t + j];
    }
    if is_full_round(t, r) {
        for x in s.iter_mut() {
            *x = pow5(*x);
        }
    } else {
        s[0] = pow5(s[0]);
    }
    let n: Vec<Fr> = (0..t).map(|i| (0..t).fold(Fr::ZERO, |acc, j| acc + p.m[i][j] * s[j])).collect();
    s.copy_from_slice(&n);
}

/// circomlib Poseidon(inputs), 2 ≤ len ≤ 5: state [0, inputs…], output state[0].
pub fn poseidon(inputs: &[Fr]) -> Fr {
    let t = inputs.len() + 1;
    let mut s = Vec::with_capacity(t);
    s.push(Fr::ZERO);
    s.extend_from_slice(inputs);
    for r in 0..FULL_ROUNDS + params(t).partial {
        poseidon_round(t, r, &mut s);
    }
    s[0]
}

// ── BabyJubJub ──

pub fn identity() -> Pt {
    [Fr::ZERO, Fr::ONE]
}
pub fn base8() -> Pt {
    [fr_dec(BASE8[0]), fr_dec(BASE8[1])]
}
pub fn h_bjj() -> Pt {
    [fr_dec(H_BJJ[0]), fr_dec(H_BJJ[1])]
}
pub fn g_bjj() -> Pt {
    [fr_dec(G_BJJ[0]), fr_dec(G_BJJ[1])]
}

fn inv0(x: Fr) -> Fr {
    x.invert().unwrap_or(Fr::ZERO)
}

/// circomlib BabyAdd; a zero denominator yields 0 (the constraint then fails).
pub fn add(p: &Pt, q: &Pt) -> Pt {
    let (a, d) = (Fr::from(BJJ_A), Fr::from(BJJ_D));
    let tau = p[0] * q[0] * p[1] * q[1];
    let x = (p[0] * q[1] + p[1] * q[0]) * inv0(Fr::ONE + d * tau);
    let y = (p[1] * q[1] - a * p[0] * q[0]) * inv0(Fr::ONE - d * tau);
    [x, y]
}

/// k·P by double-and-add over the bits of k (no reduction).
pub fn mul_bits(p: &Pt, k: &BigUint) -> Pt {
    let mut r = identity();
    let mut acc = *p;
    for i in 0..k.bits() {
        if k.bit(i) {
            r = add(&r, &acc);
        }
        acc = add(&acc, &acc);
    }
    r
}
/// amm-bjj mulScalar: k mod the full curve order.
pub fn mul(p: &Pt, k: &BigUint) -> Pt {
    mul_bits(p, &(k % order_big()))
}
pub fn mul_b8(k: &BigUint) -> Pt {
    mul(&base8(), &(k % l_big()))
}
pub fn on_curve(p: &Pt) -> bool {
    let (x2, y2) = (p[0].square(), p[1].square());
    Fr::from(BJJ_A) * x2 + y2 == Fr::ONE + Fr::from(BJJ_D) * x2 * y2
}

/// circomlib packPoint: y little-endian, top bit = x > (p−1)/2.
pub fn pack_point(p: &Pt) -> [u8; 32] {
    let mut b: [u8; 32] = p[1].to_repr();
    if to_big(&p[0]) > (p_big() - 1u8) / 2u8 {
        b[31] |= 0x80;
    }
    b
}

/// v·H + r·G with both reduced mod l; (0, 0) gives the identity.
pub fn pedersen_bjj(v: &BigUint, r: &BigUint) -> Pt {
    let a = v % l_big();
    let rr = r % l_big();
    let ah = if a.is_zero() { identity() } else { mul(&h_bjj(), &a) };
    let rg = if rr.is_zero() { identity() } else { mul(&g_bjj(), &rr) };
    add(&ah, &rg)
}

// ── hashing to scalars ──

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn wide(tag: &str, parts: &[&[u8]]) -> BigUint {
    let mut m: Vec<u8> = tag.as_bytes().to_vec();
    for p in parts {
        m.extend_from_slice(p);
    }
    let a = sha(&[&m, &[0u8]]);
    let b = sha(&[&m, &[1u8]]);
    BigUint::from_bytes_be(&[a, b].concat())
}
/// hsL: 512-bit hash mod l, rejecting 0.
pub fn hs_l(tag: &str, parts: &[&[u8]]) -> BigUint {
    let x = wide(tag, parts) % l_big();
    assert!(!x.is_zero(), "zero scalar");
    x
}
pub fn hs_p(tag: &str, parts: &[&[u8]]) -> Fr {
    fr(&wide(tag, parts))
}
pub fn asset_field(asset: &[u8; 32]) -> Fr {
    fr(&BigUint::from_bytes_be(&sha(&[TAG_ASSET.as_bytes(), asset])))
}
pub fn body_hash(body: &[u8]) -> Fr {
    fr(&BigUint::from_bytes_be(&sha(&[TAG_BODY.as_bytes(), body])))
}
pub fn be32(x: &BigUint) -> [u8; 32] {
    let v = x.to_bytes_be();
    assert!(v.len() <= 32);
    let mut b = [0u8; 32];
    b[32 - v.len()..].copy_from_slice(&v);
    b
}

// ── keys ──

pub struct Wallet {
    pub a: BigUint,
    pub n: BigUint,
    pub a_pub: Pt,
    pub n_pub: Pt,
}

pub fn wallet_keys(seed: &[u8; 32], network: &str) -> Wallet {
    assert!(network == "mainnet" || network == "signet");
    let a = hs_l(TAG_SPEND, &[network.as_bytes(), seed]);
    let n = hs_l(TAG_NK, &[network.as_bytes(), seed]);
    Wallet { a_pub: mul_b8(&a), n_pub: mul_b8(&n), a, n }
}

pub struct Tweaks {
    pub t_a: BigUint,
    pub t_n: BigUint,
    pub rho: Fr,
}
pub fn note_tweaks(s: &[u8]) -> Tweaks {
    assert_eq!(s.len(), 33);
    Tweaks { t_a: hs_l(TAG_AUTH_TWEAK, &[s]), t_n: hs_l(TAG_NK_TWEAK, &[s]), rho: hs_p(TAG_RHO, &[s]) }
}

pub fn npk_of(ak: &Pt, nk: &Pt) -> Fr {
    poseidon(&[ak[0], ak[1], nk[0], nk[1]])
}

pub struct OutKeys {
    pub ak: Pt,
    pub nk_pub: Pt,
    pub npk: Fr,
    pub rho: Fr,
}
pub fn output_keys(a_pub: &Pt, n_pub: &Pt, s: &[u8]) -> OutKeys {
    let t = note_tweaks(s);
    let ak = add(a_pub, &mul_b8(&t.t_a));
    let nk_pub = add(n_pub, &mul_b8(&t.t_n));
    OutKeys { npk: npk_of(&ak, &nk_pub), ak, nk_pub, rho: t.rho }
}

pub struct Owned {
    pub sk: BigUint,
    pub nk: BigUint,
    pub ak: Pt,
    pub nk_pub: Pt,
    pub npk: Fr,
    pub rho: Fr,
}
pub fn owned_keys(w: &Wallet, s: &[u8]) -> Owned {
    let t = note_tweaks(s);
    let sk = (&w.a + &t.t_a) % l_big();
    let nk = (&w.n + &t.t_n) % l_big();
    assert!(!sk.is_zero() && !nk.is_zero());
    let ak = mul_b8(&sk);
    let nk_pub = mul_b8(&nk);
    Owned { npk: npk_of(&ak, &nk_pub), sk, nk, ak, nk_pub, rho: t.rho }
}

pub fn leaf_of(asset_f: &Fr, v: &Fr, npk: &Fr, rho: &Fr) -> Fr {
    poseidon(&[*asset_f, *v, *npk, *rho])
}

pub fn nullifier(nk: &BigUint, leaf: &Fr, index: u64) -> Fr {
    assert!(nk < l_big() && index < (1u64 << 32));
    poseidon(&[fr(nk), *leaf, fr_u64(index)])
}

// ── tree ──

pub fn zeros() -> &'static [Fr; TREE_DEPTH + 1] {
    static Z: OnceLock<[Fr; TREE_DEPTH + 1]> = OnceLock::new();
    Z.get_or_init(|| {
        let mut z = [Fr::ZERO; TREE_DEPTH + 1];
        for i in 1..=TREE_DEPTH {
            z[i] = poseidon(&[z[i - 1], z[i - 1]]);
        }
        z
    })
}

pub struct Tree {
    layers: Vec<Vec<Fr>>,
    pub root: Fr,
}

impl Tree {
    pub fn new(leaves: &[Fr]) -> Tree {
        let z = zeros();
        let mut layers = vec![leaves.to_vec()];
        for d in 0..TREE_DEPTH {
            let cur = &layers[d];
            let next: Vec<Fr> = cur
                .chunks(2)
                .map(|c| poseidon(&[c[0], if c.len() > 1 { c[1] } else { z[d] }]))
                .collect();
            layers.push(next);
        }
        let root = layers[TREE_DEPTH].first().copied().unwrap_or(z[TREE_DEPTH]);
        Tree { layers, root }
    }
    pub fn path(&self, index: usize) -> [Fr; TREE_DEPTH] {
        assert!(index < self.layers[0].len());
        let z = zeros();
        let mut out = [Fr::ZERO; TREE_DEPTH];
        let mut i = index;
        for d in 0..TREE_DEPTH {
            let sib = i ^ 1;
            out[d] = self.layers[d].get(sib).copied().unwrap_or(z[d]);
            i >>= 1;
        }
        out
    }
}

pub fn root_from_path(leaf: &Fr, index: u64, path: &[Fr; TREE_DEPTH]) -> Fr {
    let mut cur = *leaf;
    for (d, sib) in path.iter().enumerate() {
        cur = if (index >> d) & 1 == 1 { poseidon(&[*sib, cur]) } else { poseidon(&[cur, *sib]) };
    }
    cur
}

// ── EdDSA-Poseidon ──

#[derive(Clone, Copy, Debug)]
pub struct Sig {
    pub r8: Pt,
    pub s: Fr,
}

pub fn sign(sk: &BigUint, m: &Fr) -> Sig {
    let k = sk % l_big();
    let a = mul_b8(&k);
    let r = hs_l(TAG_NONCE, &[&be32(&k), &be32(&to_big(m))]);
    let r8 = mul_b8(&r);
    let h = to_big(&poseidon(&[r8[0], r8[1], a[0], a[1], *m]));
    let s = (&r + BigUint::from(8u8) * h * &k) % l_big();
    Sig { r8, s: fr(&s) }
}

pub fn verify_sig(a: &Pt, m: &Fr, sig: &Sig) -> bool {
    if &to_big(&sig.s) >= l_big() || !on_curve(a) || !on_curve(&sig.r8) {
        return false;
    }
    let h = to_big(&poseidon(&[sig.r8[0], sig.r8[1], a[0], a[1], *m]));
    mul_b8(&to_big(&sig.s)) == add(&sig.r8, &mul(a, &(h * BigUint::from(8u8))))
}

// ── witness ──

/// Private and public assignment of spend.circom, in its signal names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendWitness {
    pub root: Fr,
    pub body_hash: Fr,
    pub asset: Fr,
    pub nf: [Fr; N_IN],
    pub out_leaf: [Fr; N_OUT],
    pub exit_c: Pt,
    pub dep_c: Pt,
    pub in_v: [Fr; N_IN],
    pub in_rho: [Fr; N_IN],
    pub in_nk: [Fr; N_IN],
    pub in_ak: [Pt; N_IN],
    pub in_index: [Fr; N_IN],
    pub in_path: [[Fr; TREE_DEPTH]; N_IN],
    pub sig_r8: [Pt; N_IN],
    pub sig_s: [Fr; N_IN],
    pub out_v: [Fr; N_OUT],
    pub out_npk: [Fr; N_OUT],
    pub out_rho: [Fr; N_OUT],
    pub exit_v: Fr,
    pub exit_r: Fr,
    pub dep_v: Fr,
    pub dep_r: Fr,
}

impl Default for SpendWitness {
    fn default() -> Self {
        let z = Fr::ZERO;
        SpendWitness {
            root: z,
            body_hash: z,
            asset: z,
            nf: [z; N_IN],
            out_leaf: [z; N_OUT],
            exit_c: identity(),
            dep_c: identity(),
            in_v: [z; N_IN],
            in_rho: [z; N_IN],
            in_nk: [Fr::ONE; N_IN],
            in_ak: [base8(); N_IN],
            in_index: [z; N_IN],
            in_path: [[z; TREE_DEPTH]; N_IN],
            sig_r8: [base8(); N_IN],
            sig_s: [z; N_IN],
            out_v: [z; N_OUT],
            out_npk: [z; N_OUT],
            out_rho: [z; N_OUT],
            exit_v: z,
            exit_r: z,
            dep_v: z,
            dep_r: z,
        }
    }
}

impl SpendWitness {
    /// Public signal order of spend.circom: root, bodyHash, asset, nf[2], outLeaf[3], exitC[2], depC[2].
    pub fn publics(&self) -> [Fr; N_PUBLIC] {
        [
            self.root,
            self.body_hash,
            self.asset,
            self.nf[0],
            self.nf[1],
            self.out_leaf[0],
            self.out_leaf[1],
            self.out_leaf[2],
            self.exit_c[0],
            self.exit_c[1],
            self.dep_c[0],
            self.dep_c[1],
        ]
    }

    /// Parses the snarkjs input object that btc-pool-zk.js `buildWitness` returns as `input`.
    pub fn from_json(v: &serde_json::Value) -> Result<SpendWitness, String> {
        fn one(v: &serde_json::Value, name: &str) -> Result<Fr, String> {
            let s = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => return Err(format!("{name}: expected a decimal string")),
            };
            fr_signed_dec(&s).ok_or_else(|| format!("{name}: bad decimal"))
        }
        fn get<'a>(v: &'a serde_json::Value, k: &str) -> Result<&'a serde_json::Value, String> {
            v.get(k).ok_or_else(|| format!("missing {k}"))
        }
        fn arr<const N: usize>(v: &serde_json::Value, name: &str) -> Result<[Fr; N], String> {
            let a = v.as_array().ok_or_else(|| format!("{name}: expected array"))?;
            if a.len() != N {
                return Err(format!("{name}: expected {N} entries"));
            }
            let mut out = [Fr::ZERO; N];
            for (i, x) in a.iter().enumerate() {
                out[i] = one(x, name)?;
            }
            Ok(out)
        }
        fn arr2<const N: usize, const M: usize>(v: &serde_json::Value, name: &str) -> Result<[[Fr; M]; N], String> {
            let a = v.as_array().ok_or_else(|| format!("{name}: expected array"))?;
            if a.len() != N {
                return Err(format!("{name}: expected {N} entries"));
            }
            let mut out = [[Fr::ZERO; M]; N];
            for (i, x) in a.iter().enumerate() {
                out[i] = arr::<M>(x, name)?;
            }
            Ok(out)
        }
        let s = |k: &str| -> Result<Fr, String> { one(get(v, k)?, k) };
        Ok(SpendWitness {
            root: s("root")?,
            body_hash: s("bodyHash")?,
            asset: s("asset")?,
            nf: arr(get(v, "nf")?, "nf")?,
            out_leaf: arr(get(v, "outLeaf")?, "outLeaf")?,
            exit_c: arr(get(v, "exitC")?, "exitC")?,
            dep_c: arr(get(v, "depC")?, "depC")?,
            in_v: arr(get(v, "inV")?, "inV")?,
            in_rho: arr(get(v, "inRho")?, "inRho")?,
            in_nk: arr(get(v, "inNk")?, "inNk")?,
            in_ak: arr2(get(v, "inAk")?, "inAk")?,
            in_index: arr(get(v, "inIndex")?, "inIndex")?,
            in_path: arr2(get(v, "inPath")?, "inPath")?,
            sig_r8: arr2(get(v, "sigR8")?, "sigR8")?,
            sig_s: arr(get(v, "sigS")?, "sigS")?,
            out_v: arr(get(v, "outV")?, "outV")?,
            out_npk: arr(get(v, "outNpk")?, "outNpk")?,
            out_rho: arr(get(v, "outRho")?, "outRho")?,
            exit_v: s("exitV")?,
            exit_r: s("exitR")?,
            dep_v: s("depV")?,
            dep_r: s("depR")?,
        })
    }

    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        let d = |x: &Fr| to_dec(x);
        let a = |xs: &[Fr]| xs.iter().map(d).collect::<Vec<_>>();
        json!({
            "root": d(&self.root), "bodyHash": d(&self.body_hash), "asset": d(&self.asset),
            "nf": a(&self.nf), "outLeaf": a(&self.out_leaf), "exitC": a(&self.exit_c), "depC": a(&self.dep_c),
            "inV": a(&self.in_v), "inRho": a(&self.in_rho), "inNk": a(&self.in_nk),
            "inAk": self.in_ak.iter().map(|p| a(p)).collect::<Vec<_>>(),
            "inIndex": a(&self.in_index),
            "inPath": self.in_path.iter().map(|p| a(p)).collect::<Vec<_>>(),
            "sigR8": self.sig_r8.iter().map(|p| a(p)).collect::<Vec<_>>(),
            "sigS": a(&self.sig_s),
            "outV": a(&self.out_v), "outNpk": a(&self.out_npk), "outRho": a(&self.out_rho),
            "exitV": d(&self.exit_v), "exitR": d(&self.exit_r), "depV": d(&self.dep_v), "depR": d(&self.dep_r),
        })
    }
}

/// A real or zero-value input note.
#[derive(Clone)]
pub struct InNote {
    pub v: u64,
    pub rho: Fr,
    pub nk: BigUint,
    pub ak: Pt,
    pub index: u64,
    pub path: [Fr; TREE_DEPTH],
    pub sig: Sig,
}
#[derive(Clone)]
pub struct OutNote {
    pub v: u64,
    pub npk: Fr,
    pub rho: Fr,
}
#[derive(Clone)]
pub struct Opening {
    pub v: u64,
    pub r: BigUint,
}

/// btc-pool-zk.js buildWitness.
pub fn build_witness(
    root: Fr,
    body_hash: Fr,
    asset_f: Fr,
    inputs: &[Option<InNote>; N_IN],
    outputs: &[Option<OutNote>; N_OUT],
    exit: Option<Opening>,
    dep: Option<Opening>,
) -> Result<SpendWitness, String> {
    let mut w = SpendWitness { root, body_hash, asset: asset_f, ..Default::default() };
    let one = BigUint::one();
    let dummy_sig = sign(&one, &body_hash);
    for (i, x) in inputs.iter().enumerate() {
        match x {
            None => {
                w.in_v[i] = Fr::ZERO;
                w.in_rho[i] = Fr::ZERO;
                w.in_nk[i] = Fr::ONE;
                w.in_ak[i] = mul_b8(&one);
                w.in_index[i] = Fr::ZERO;
                w.in_path[i] = [Fr::ZERO; TREE_DEPTH];
                w.sig_r8[i] = dummy_sig.r8;
                w.sig_s[i] = dummy_sig.s;
                w.nf[i] = Fr::ZERO;
            }
            Some(n) => {
                let nk_pub = mul_b8(&n.nk);
                let leaf = leaf_of(&asset_f, &fr_u64(n.v), &npk_of(&n.ak, &nk_pub), &n.rho);
                w.in_v[i] = fr_u64(n.v);
                w.in_rho[i] = n.rho;
                w.in_nk[i] = fr(&n.nk);
                w.in_ak[i] = n.ak;
                w.in_index[i] = fr_u64(n.index);
                w.in_path[i] = n.path;
                w.sig_r8[i] = n.sig.r8;
                w.sig_s[i] = n.sig.s;
                w.nf[i] = nullifier(&n.nk, &leaf, n.index);
            }
        }
    }
    for (k, o) in outputs.iter().enumerate() {
        if let Some(o) = o {
            w.out_v[k] = fr_u64(o.v);
            w.out_npk[k] = o.npk;
            w.out_rho[k] = o.rho;
            w.out_leaf[k] = leaf_of(&asset_f, &fr_u64(o.v), &o.npk, &o.rho);
        }
    }
    let opening = |c: &Option<Opening>, name: &str| -> Result<(Fr, Fr, Pt), String> {
        match c {
            None => Ok((Fr::ZERO, Fr::ZERO, identity())),
            Some(c) => {
                if c.r.is_zero() || c.r.bits() > 251 || &c.r >= l_big() {
                    return Err(format!("{name}.r must be in (0, l)"));
                }
                Ok((fr_u64(c.v), fr(&c.r), pedersen_bjj(&BigUint::from(c.v), &c.r)))
            }
        }
    };
    (w.exit_v, w.exit_r, w.exit_c) = opening(&exit, "exit")?;
    (w.dep_v, w.dep_r, w.dep_c) = opening(&dep, "dep")?;
    let sum_in: u128 = inputs.iter().flatten().map(|x| x.v as u128).sum::<u128>() + dep.as_ref().map_or(0, |d| d.v as u128);
    let sum_out: u128 = outputs.iter().flatten().map(|x| x.v as u128).sum::<u128>() + exit.as_ref().map_or(0, |d| d.v as u128);
    if sum_in != sum_out {
        return Err("value not conserved".into());
    }
    Ok(w)
}
