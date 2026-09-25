//! Hermez powers-of-tau (snarkjs .ptau) → halo2 ParamsKZG<Bn256>. No randomness enters the SRS: g[i] = τ^i·G1
//! and s_g2 = τ·G2 are copied from the ptau; g_lagrange is derived from g by halo2's own iFFT.
//!
//! ptau layout (snarkjs binfileutils): "ptau" ‖ version u32 ‖ nSections u32, then per section
//! type u32 ‖ size u64 ‖ data. Section 1: n8 u32 ‖ q (n8 B) ‖ power u32 ‖ ceremonyPower u32.
//! Section 2: τ^i·G1 for i < 2^(power+1) − 1. Section 3: τ^i·G2 for i < 2^power.
//! Coordinates are little-endian Montgomery (R = 2^256); G2 coordinates are c0 ‖ c1.
//!
//! Checks: header q = BN254 base modulus, power ≥ k; g[0] = G1 generator, G2[0] = G2 generator;
//! e(τG1, G2) = e(G1, τG2); e(Σ r_i·g[i+1], G2) = e(Σ r_i·g[i], τG2) for i < 2^k − 1 with r_i derived
//! from a BLAKE2b hash of the points (so every g[i] is τ^i·G1); Σ g_lagrange = G1.

use blake2::{Blake2b512, Digest};
use ff::{Field, FromUniformBytes, PrimeField};
use group::{prime::PrimeCurveAffine, Curve, Group, GroupEncoding};
use halo2_proofs::{
    arithmetic::{best_multiexp, g_to_lagrange, CurveAffine},
    halo2curves::{
        bn256::{pairing, Bn256, Fq, Fq2, Fr, G1Affine, G2Affine, G1},
        serde::SerdeObject,
    },
    poly::kzg::commitment::ParamsKZG,
    SerdeFormat,
};

pub const Q_HEX: &str = "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47";
/// BLAKE2b-512 of Hermez powersOfTau28_hez_final_18.ptau, as pinned in dapp/circuits/pin-pot18.sh.
pub const POT18_BLAKE2B: &str = "7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e";

pub struct Ptau<'a> {
    pub power: u32,
    pub ceremony_power: u32,
    tau_g1: &'a [u8],
    tau_g2: &'a [u8],
    lagrange_g1: Option<&'a [u8]>,
}

fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u64le(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

pub fn blake2b_hex(data: &[u8]) -> String {
    hex::encode(Blake2b512::digest(data))
}

pub fn parse(b: &[u8]) -> Result<Ptau<'_>, String> {
    if b.len() < 12 || &b[0..4] != b"ptau" {
        return Err("not a ptau file".into());
    }
    let n_sections = u32le(b, 8) as usize;
    let mut off = 12;
    let (mut s1, mut s2, mut s3, mut s12) = (None, None, None, None);
    for _ in 0..n_sections {
        if off + 12 > b.len() {
            return Err("truncated section header".into());
        }
        let ty = u32le(b, off);
        let size = u64le(b, off + 4) as usize;
        let start = off + 12;
        if start + size > b.len() {
            return Err("truncated section".into());
        }
        let data = &b[start..start + size];
        match ty {
            1 => s1 = Some(data),
            2 => s2 = Some(data),
            3 => s3 = Some(data),
            12 => s12 = Some(data),
            _ => {}
        }
        off = start + size;
    }
    let h = s1.ok_or("missing header section")?;
    let n8 = u32le(h, 0) as usize;
    if n8 != 32 {
        return Err("n8 != 32".into());
    }
    let mut q = h[4..36].to_vec();
    q.reverse();
    if hex::encode(&q) != Q_HEX {
        return Err("ptau is not over BN254".into());
    }
    let power = u32le(h, 36);
    let ceremony_power = u32le(h, 40);
    let (g1, g2) = (s2.ok_or("missing tauG1")?, s3.ok_or("missing tauG2")?);
    if g1.len() != ((2usize << power) - 1) * 64 || g2.len() != (1usize << power) * 128 {
        return Err("section sizes do not match power".into());
    }
    Ok(Ptau { power, ceremony_power, tau_g1: g1, tau_g2: g2, lagrange_g1: s12 })
}

fn r_inv() -> Fq {
    Fq::from(2u64).pow_vartime([256u64]).invert().unwrap()
}

fn fq_lem(b: &[u8]) -> Result<Fq, String> {
    let raw: [u8; 32] = b.try_into().unwrap();
    let m = Option::<Fq>::from(Fq::from_repr(raw)).ok_or("coordinate ≥ q")?;
    Ok(m * r_inv())
}

impl Ptau<'_> {
    pub fn g1(&self, i: usize) -> Result<G1Affine, String> {
        let o = i * 64;
        let (x, y) = (fq_lem(&self.tau_g1[o..o + 32])?, fq_lem(&self.tau_g1[o + 32..o + 64])?);
        Option::from(G1Affine::from_xy(x, y)).ok_or_else(|| format!("tauG1[{i}] not on curve"))
    }
    /// snarkjs's prepared Lagrange basis for 2^k (section 12 holds bases for every power 0..=power).
    pub fn lagrange(&self, k: u32, i: usize) -> Option<Result<G1Affine, String>> {
        let sec = self.lagrange_g1?;
        let o = (((1usize << k) - 1) + i) * 64;
        if o + 64 > sec.len() {
            return None;
        }
        let xy = (fq_lem(&sec[o..o + 32]), fq_lem(&sec[o + 32..o + 64]));
        Some(match xy {
            (Ok(x), Ok(y)) => Option::from(G1Affine::from_xy(x, y)).ok_or_else(|| "lagrange point not on curve".to_string()),
            _ => Err("lagrange coordinate ≥ q".into()),
        })
    }

    pub fn g2(&self, i: usize) -> Result<G2Affine, String> {
        let o = i * 128;
        let f = |k: usize| fq_lem(&self.tau_g2[o + 32 * k..o + 32 * k + 32]);
        let x = Fq2 { c0: f(0)?, c1: f(1)? };
        let y = Fq2 { c0: f(2)?, c1: f(3)? };
        Option::from(G2Affine::from_xy(x, y)).ok_or_else(|| format!("tauG2[{i}] not on curve"))
    }
}

pub struct SrsReport {
    pub power: u32,
    pub ceremony_power: u32,
    pub k: u32,
    pub checks: Vec<String>,
}

/// Converts and checks. Returns ParamsKZG for 2^k rows.
pub fn params_from_ptau(bytes: &[u8], k: u32) -> Result<(ParamsKZG<Bn256>, SrsReport), String> {
    let pt = parse(bytes)?;
    let mut checks = vec![format!("header: BN254 q, power {} (ceremony power {})", pt.power, pt.ceremony_power)];
    if k > pt.power {
        return Err(format!("k = {k} exceeds ptau power {}", pt.power));
    }
    let n = 1usize << k;
    let g: Vec<G1Affine> = (0..n).map(|i| pt.g1(i)).collect::<Result<_, _>>()?;
    let (g2, s_g2) = (pt.g2(0)?, pt.g2(1)?);
    if g[0] != G1Affine::generator() {
        return Err("tauG1[0] is not the G1 generator".into());
    }
    if g2 != G2Affine::generator() {
        return Err("tauG2[0] is not the G2 generator".into());
    }
    checks.push("tauG1[0] = G1, tauG2[0] = G2 (standard generators)".into());
    if pairing(&g[1], &g2) != pairing(&g[0], &s_g2) {
        return Err("e(τG1, G2) ≠ e(G1, τG2)".into());
    }
    checks.push("e(τ·G1, G2) = e(G1, τ·G2)".into());

    let mut h = Blake2b512::new();
    h.update(b"tacit-btc-pool-halo2-srs-check");
    for p in &g {
        h.update(p.to_bytes());
    }
    let seed = h.finalize();
    let rs: Vec<Fr> = (0..n - 1)
        .map(|i| {
            let mut hh = Blake2b512::new();
            hh.update(seed);
            hh.update((i as u64).to_le_bytes());
            let wide: [u8; 64] = hh.finalize().into();
            Fr::from_uniform_bytes(&wide)
        })
        .collect();
    let a = best_multiexp(&rs, &g[1..]).to_affine();
    let b = best_multiexp(&rs, &g[..n - 1]).to_affine();
    if pairing(&a, &g2) != pairing(&b, &s_g2) {
        return Err("powers are not consecutive: e(Σ r_i·g[i+1], G2) ≠ e(Σ r_i·g[i], τG2)".into());
    }
    checks.push(format!("e(Σ r_i·g[i+1], G2) = e(Σ r_i·g[i], τ·G2) over i < 2^{k} − 1 (r_i from BLAKE2b of the points)"));

    let proj: Vec<G1> = g.iter().map(|p| p.to_curve()).collect();
    let g_lagrange: Vec<G1Affine> = g_to_lagrange(proj, k);
    let sum: G1 = g_lagrange.iter().fold(G1::identity(), |acc, p| acc + p);
    if sum.to_affine() != g[0] {
        return Err("Σ g_lagrange ≠ G1".into());
    }
    checks.push("Σ_i L_i(τ)·G1 = G1 for halo2's g_lagrange".into());
    // snarkjs's own Lagrange basis for the same 2^k domain (an independent computation), when present.
    // Its generator is 5^((r−1)/2^28) squared down; halo2's is ROOT_OF_UNITY squared down. With
    // ω_halo2 = ω_snarkjs^j, halo2's L_i is snarkjs's L_{i·j mod 2^k}.
    if pt.lagrange(k, 0).is_some() {
        let w_h = (k..Fr::S).fold(Fr::ROOT_OF_UNITY, |w, _| w.square());
        let w_s = {
            // 5^((r − 1) / 2^S)
            let mut e = [0u64; 4];
            let rm1 = crate::model::p_big() - 1u8;
            let q = rm1 >> (Fr::S as usize);
            for (i, d) in q.to_u64_digits().iter().enumerate() {
                e[i] = *d;
            }
            let mut w = Fr::from(5u64).pow_vartime(e);
            for _ in k..Fr::S {
                w = w.square();
            }
            w
        };
        let mut j = None;
        let mut acc = Fr::ONE;
        for e in 0..n {
            if acc == w_h {
                j = Some(e);
                break;
            }
            acc *= w_s;
        }
        let j = j.ok_or("halo2's root of unity is not a power of snarkjs's")?;
        for (i, p) in g_lagrange.iter().enumerate() {
            match pt.lagrange(k, (i * j) % n) {
                Some(Ok(q)) if q == *p => {}
                _ => return Err(format!("g_lagrange[{i}] differs from the ptau's Lagrange basis")),
            }
        }
        checks.push(format!("g_lagrange equals the ptau's own Lagrange basis for 2^{k} (index map i → {j}·i mod 2^{k})"));
    }
    let mut buf = Vec::with_capacity(4 + 2 * n * 64 + 256);
    buf.extend_from_slice(&k.to_le_bytes());
    for p in g.iter().chain(g_lagrange.iter()) {
        p.write_raw(&mut buf).unwrap();
    }
    g2.write_raw(&mut buf).unwrap();
    s_g2.write_raw(&mut buf).unwrap();
    let params = ParamsKZG::<Bn256>::read_custom(&mut &buf[..], SerdeFormat::RawBytes).map_err(|e| e.to_string())?;
    Ok((params, SrsReport { power: pt.power, ceremony_power: pt.ceremony_power, k, checks }))
}

pub fn write_params(p: &ParamsKZG<Bn256>) -> Vec<u8> {
    let mut out = Vec::new();
    p.write_custom(&mut out, SerdeFormat::Processed).unwrap();
    out
}

pub fn read_params(b: &[u8]) -> Result<ParamsKZG<Bn256>, String> {
    ParamsKZG::<Bn256>::read_custom(&mut &b[..], SerdeFormat::Processed).map_err(|e| e.to_string())
}

pub fn default_ptau_path() -> std::path::PathBuf {
    match std::env::var("PTAU") {
        Ok(p) => p.into(),
        Err(_) => std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../dapp/circuits/pot18_final.ptau"),
    }
}
pub fn default_params_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("artifacts/params-k{}.bin", crate::K))
}

/// Reads the pinned params from artifacts/, or converts the pinned ptau (BLAKE2b-checked) and caches them.
pub fn load_or_convert(ptau: Option<&std::path::Path>) -> Result<ParamsKZG<Bn256>, String> {
    let out = default_params_path();
    if let Ok(b) = std::fs::read(&out) {
        return read_params(&b);
    }
    let path = ptau.map(|p| p.to_path_buf()).unwrap_or_else(default_ptau_path);
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if blake2b_hex(&bytes) != POT18_BLAKE2B {
        return Err("ptau BLAKE2b does not match the pot18 pin".into());
    }
    let (params, _) = params_from_ptau(&bytes, crate::K)?;
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&out, write_params(&params)).map_err(|e| e.to_string())?;
    Ok(params)
}
