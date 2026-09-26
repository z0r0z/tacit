//! Shared by the aggregation guest and host (DESIGN-btc-shielded-pool.md, Aggregation):
//! - `HintRead`: halo2's Blake2b transcript reader, byte for byte the hashing of
//!   `Blake2bRead<_, G1Affine, Challenge255<_>>`. `read_point` either decompresses and records the affine point
//!   (Record, host) or takes the recorded point as a hint and checks it against the compressed bytes (Hint,
//!   guest), which replaces a square root by a comparison and an on-curve check.
//! - `Capture`: a verification strategy that returns halo2's `DualMSM` (the pairing input) unchecked.
//! - `Batch`: a random linear combination of several `DualMSM`s with equal bases merged.
//! - The verifier params encoding (g[0], g2, s_g2, k) and the aggregate statement.

use blake2b_simd::{Params as Blake2bParams, State as Blake2bState};
use ff::{Field, FromUniformBytes, PrimeField};
use halo2_proofs::{
    halo2curves::{
        bn256::{Bn256, Fq, Fq2, Fr, G1Affine, G2Affine, G1},
        serde::SerdeObject,
        CurveAffine,
    },
    plonk::{verify_proof, Error, VerifyingKey},
    poly::{
        commitment::MSM,
        kzg::{
            commitment::{KZGCommitmentScheme, ParamsKZG},
            msm::DualMSM,
            multiopen::VerifierSHPLONK,
            strategy::GuardKZG,
        },
        VerificationStrategy,
    },
    transcript::{Challenge255, EncodedChallenge, Transcript, TranscriptRead},
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io;

pub const PARAMS_LEN: usize = 64 + 128 + 128 + 4;
/// Public inputs of the spend relation, and the wire length of one Halo2 proof.
pub const N_PUBLIC: usize = 12;
pub const PUBLICS_LEN: usize = 32 * N_PUBLIC;
pub const PROOF_LEN: usize = 2080;
/// Points a proof's transcript reads (12 advice, 1 permutation product, 1 random, 4 quotient, 2 SHPLONK).
pub const PROOF_POINTS: usize = 20;
pub const HINTS_LEN: usize = 64 * PROOF_POINTS;
pub const STATEMENT_DOMAIN: &[u8] = b"tacit-btc-pool-agg-v1";
pub const RLC_DOMAIN: &[u8] = b"tacit-btc-pool-agg-rlc-v1";

fn ioerr(m: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Other, m.to_string())
}

pub enum Mode<'h> {
    /// Host: decompress each point and record x‖y (canonical little-endian).
    Record(Vec<[u8; 64]>),
    /// Guest: hints (64 bytes per point read, in order) and a cursor.
    Hint(&'h [u8], usize),
}

pub struct HintRead<'a, 'h> {
    state: Blake2bState,
    proof: &'a [u8],
    pos: usize,
    pub mode: Mode<'h>,
    pub track: bool,
}

impl<'a, 'h> HintRead<'a, 'h> {
    pub fn new(proof: &'a [u8], mode: Mode<'h>) -> Self {
        HintRead { state: Blake2bParams::new().hash_length(64).personal(b"Halo2-Transcript").to_state(), proof, pos: 0, mode, track: false }
    }
    fn take32(&mut self) -> io::Result<[u8; 32]> {
        if self.pos + 32 > self.proof.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "proof truncated"));
        }
        let mut b = [0u8; 32];
        b.copy_from_slice(&self.proof[self.pos..self.pos + 32]);
        self.pos += 32;
        Ok(b)
    }
    pub fn recorded(self) -> Vec<[u8; 64]> {
        match self.mode {
            Mode::Record(v) => v,
            Mode::Hint(..) => vec![],
        }
    }
    /// True when every byte of the proof was read.
    pub fn consumed(&self) -> bool {
        self.pos == self.proof.len()
    }
    pub fn hints_used(&self) -> usize {
        match &self.mode {
            Mode::Hint(_, i) => *i,
            Mode::Record(v) => v.len(),
        }
    }
}

impl Transcript<G1Affine, Challenge255<G1Affine>> for HintRead<'_, '_> {
    fn squeeze_challenge(&mut self) -> Challenge255<G1Affine> {
        self.state.update(&[0u8]);
        let r: [u8; 64] = self.state.clone().finalize().as_bytes().try_into().unwrap();
        Challenge255::<G1Affine>::new(&r)
    }
    fn common_point(&mut self, point: G1Affine) -> io::Result<()> {
        self.state.update(&[1u8]);
        let c: halo2_proofs::halo2curves::Coordinates<G1Affine> = Option::from(point.coordinates()).ok_or_else(|| ioerr("cannot write points at infinity to the transcript"))?;
        self.state.update(c.x().to_repr().as_ref());
        self.state.update(c.y().to_repr().as_ref());
        Ok(())
    }
    fn common_scalar(&mut self, scalar: Fr) -> io::Result<()> {
        self.state.update(&[2u8]);
        self.state.update(scalar.to_repr().as_ref());
        Ok(())
    }
}

impl TranscriptRead<G1Affine, Challenge255<G1Affine>> for HintRead<'_, '_> {
    fn read_point(&mut self) -> io::Result<G1Affine> {
        let c = self.take32()?;
        match &mut self.mode {
            Mode::Record(rec) => {
                use group::GroupEncoding;
                let mut repr = <G1Affine as GroupEncoding>::Repr::default();
                repr.as_mut().copy_from_slice(&c);
                let p: G1Affine = Option::from(G1Affine::from_bytes(&repr)).ok_or_else(|| ioerr("invalid point encoding in proof"))?;
                let co: halo2_proofs::halo2curves::Coordinates<G1Affine> = Option::from(p.coordinates()).ok_or_else(|| ioerr("cannot write points at infinity to the transcript"))?;
                let mut h = [0u8; 64];
                h[..32].copy_from_slice(co.x().to_repr().as_ref());
                h[32..].copy_from_slice(co.y().to_repr().as_ref());
                rec.push(h);
                self.common_point(p)?;
                Ok(p)
            }
            Mode::Hint(hints, i) => {
                if self.track {
                    println!("cycle-tracker-report-start: v2_read_point_hint");
                }
                let off = *i * 64;
                if off + 64 > hints.len() {
                    return Err(ioerr("hints exhausted"));
                }
                let mut xb = [0u8; 32];
                let mut yb = [0u8; 32];
                xb.copy_from_slice(&hints[off..off + 32]);
                yb.copy_from_slice(&hints[off + 32..off + 64]);
                *i += 1;
                // Mirror halo2curves G1Affine::from_bytes: bit 7 of the last byte = infinity flag,
                // bit 6 = y parity, remaining 254 bits = x. Identity (flag set, x = 0) is rejected, as
                // the stock reader rejects it in common_point.
                let flags = c[31];
                let inf = flags >> 7;
                let ysign = (flags >> 6) & 1;
                let mut cx = c;
                cx[31] &= 0x3f;
                if inf == 1 && cx.iter().all(|&b| b == 0) {
                    return Err(ioerr("cannot write points at infinity to the transcript"));
                }
                if cx != xb || (yb[0] & 1) != ysign {
                    return Err(ioerr("hint does not match the compressed point"));
                }
                let x: Fq = Option::from(Fq::from_repr(xb)).ok_or_else(|| ioerr("hint x not canonical"))?;
                let y: Fq = Option::from(Fq::from_repr(yb)).ok_or_else(|| ioerr("hint y not canonical"))?;
                let p = G1Affine { x, y };
                if !bool::from(p.is_on_curve()) {
                    return Err(ioerr("hint not on curve"));
                }
                self.state.update(&[1u8]);
                self.state.update(&xb);
                self.state.update(&yb);
                if self.track {
                    println!("cycle-tracker-report-end: v2_read_point_hint");
                }
                Ok(p)
            }
        }
    }
    fn read_scalar(&mut self) -> io::Result<Fr> {
        let b = self.take32()?;
        let s: Fr = Option::from(Fr::from_repr(b)).ok_or_else(|| ioerr("invalid field element encoding in proof"))?;
        self.common_scalar(s)?;
        Ok(s)
    }
}

/// Returns halo2's DualMSM (the pairing-check input) instead of evaluating it.
pub struct Capture<'p> {
    params: &'p ParamsKZG<Bn256>,
}

impl<'p> VerificationStrategy<'p, KZGCommitmentScheme<Bn256>, VerifierSHPLONK<'p, Bn256>> for Capture<'p> {
    type Output = DualMSM<'p, Bn256>;
    fn new(params: &'p ParamsKZG<Bn256>) -> Self {
        Capture { params }
    }
    fn process(self, f: impl FnOnce(DualMSM<'p, Bn256>) -> Result<GuardKZG<'p, Bn256>, Error>) -> Result<Self::Output, Error> {
        Ok(f(DualMSM::new(self.params))?.msm_accumulator)
    }
    fn finalize(self) -> bool {
        unreachable!()
    }
}

/// Everything in halo2's `verify_proof` except the final MSM evaluation and pairing.
pub fn to_dual_msm<'p, T: TranscriptRead<G1Affine, Challenge255<G1Affine>>>(
    params: &'p ParamsKZG<Bn256>,
    vk: &VerifyingKey<G1Affine>,
    publics: &[Fr],
    tr: &mut T,
) -> Result<DualMSM<'p, Bn256>, Error> {
    verify_proof::<KZGCommitmentScheme<Bn256>, VerifierSHPLONK<'p, Bn256>, _, _, Capture<'p>>(params, vk, Capture::new(params), &[&[publics]], tr)
}

/// Twelve 32-byte big-endian field elements, each canonical (below r).
pub fn publics_from_be(b: &[u8]) -> Option<Vec<Fr>> {
    if b.len() != PUBLICS_LEN {
        return None;
    }
    b.chunks(32)
        .map(|c| {
            let mut r = [0u8; 32];
            for i in 0..32 {
                r[i] = c[31 - i];
            }
            Option::from(Fr::from_repr(r))
        })
        .collect()
}

/// The aggregate's public value: SHA-256(STATEMENT_DOMAIN ‖ vk_digest ‖ n (u32 LE) ‖ publics_0 ‖ … ‖
/// publics_{n-1}), each publics block the spend's twelve inputs as 32-byte big-endian field elements, in
/// carrier input order.
pub fn statement(vk_digest: &[u8; 64], publics: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(STATEMENT_DOMAIN);
    h.update(vk_digest);
    h.update((publics.len() as u32).to_le_bytes());
    for p in publics {
        h.update(p);
    }
    h.finalize().into()
}

/// Batch challenge: SHA-256 over RLC_DOMAIN, the statement and every proof, widened to 64 bytes and reduced.
/// Hints are determined by the proof bytes, so they need not enter.
pub fn rlc_challenge(statement: &[u8; 32], proofs: &[&[u8]]) -> Fr {
    let mut h = Sha256::new();
    h.update(RLC_DOMAIN);
    h.update(statement);
    for p in proofs {
        h.update((p.len() as u32).to_le_bytes());
        h.update(p);
    }
    let seed = h.finalize();
    let mut wide = [0u8; 64];
    wide[..32].copy_from_slice(&Sha256::digest([&seed[..], &[0u8]].concat()));
    wide[32..].copy_from_slice(&Sha256::digest([&seed[..], &[1u8]].concat()));
    Fr::from_uniform_bytes(&wide)
}

fn fq(b: &[u8]) -> Option<Fq> {
    let mut r = [0u8; 32];
    r.copy_from_slice(&b[..32]);
    Option::from(Fq::from_repr(r))
}

/// params bytes: g0.x ‖ g0.y ‖ g2.x.c0 ‖ g2.x.c1 ‖ g2.y.c0 ‖ g2.y.c1 ‖ s_g2 (same) ‖ k u32, field
/// elements canonical little-endian.
pub fn encode_params(k: u32, g0: &G1Affine, g2: &G2Affine, s_g2: &G2Affine) -> Vec<u8> {
    let mut v = Vec::with_capacity(PARAMS_LEN);
    for f in [g0.x, g0.y] {
        v.extend_from_slice(f.to_repr().as_ref());
    }
    for p in [g2, s_g2] {
        for f in [p.x.c0, p.x.c1, p.y.c0, p.y.c1] {
            v.extend_from_slice(f.to_repr().as_ref());
        }
    }
    v.extend_from_slice(&k.to_le_bytes());
    v
}

pub fn decode_params(b: &[u8]) -> Option<(u32, G1Affine, G2Affine, G2Affine)> {
    if b.len() != PARAMS_LEN {
        return None;
    }
    let g0 = G1Affine { x: fq(&b[0..])?, y: fq(&b[32..])? };
    let g2at = |o: usize| -> Option<G2Affine> {
        Some(G2Affine { x: Fq2 { c0: fq(&b[o..])?, c1: fq(&b[o + 32..])? }, y: Fq2 { c0: fq(&b[o + 64..])?, c1: fq(&b[o + 96..])? } })
    };
    let g2 = g2at(64)?;
    let s_g2 = g2at(192)?;
    let k = u32::from_le_bytes(b[320..324].try_into().unwrap());
    if !bool::from(g0.is_on_curve()) || !bool::from(g2.is_on_curve()) || !bool::from(s_g2.is_on_curve()) {
        return None;
    }
    Some((k, g0, g2, s_g2))
}

pub fn verifier_params(b: &[u8]) -> Option<ParamsKZG<Bn256>> {
    let (k, g0, g2, s_g2) = decode_params(b)?;
    Some(ParamsKZG::<Bn256>::verifier_only(k, g0, g2, s_g2))
}

/// RLC of several DualMSMs, bases merged by value (the vk commitments and g[0] recur in every
/// proof). Every base halo2's SHPLONK verifier appends is an affine point lifted with z = 1; any
/// other base is normalized first.
#[derive(Default)]
pub struct Batch {
    idx_l: BTreeMap<[u8; 64], usize>,
    idx_r: BTreeMap<[u8; 64], usize>,
    pub left: Vec<(Fr, G1Affine)>,
    pub right: Vec<(Fr, G1Affine)>,
    pub terms_in: usize,
}

fn affine(p: &G1) -> Option<G1Affine> {
    use group::Curve;
    if bool::from(p.z.is_zero()) {
        None
    } else if p.z == Fq::ONE {
        Some(G1Affine { x: p.x, y: p.y })
    } else {
        Some(p.to_affine())
    }
}

fn key(p: &G1Affine) -> [u8; 64] {
    let mut k = [0u8; 64];
    k[..32].copy_from_slice(&p.x.to_raw_bytes());
    k[32..].copy_from_slice(&p.y.to_raw_bytes());
    k
}

fn add_terms(idx: &mut BTreeMap<[u8; 64], usize>, out: &mut Vec<(Fr, G1Affine)>, scalars: &[Fr], bases: &[G1], r: Option<Fr>) -> usize {
    for (s, b) in scalars.iter().zip(bases) {
        let Some(a) = affine(b) else { continue };
        let s = match r {
            Some(r) => *s * r,
            None => *s,
        };
        match idx.get(&key(&a)) {
            Some(&i) => out[i].0 += s,
            None => {
                idx.insert(key(&a), out.len());
                out.push((s, a));
            }
        }
    }
    scalars.len()
}

impl Batch {
    /// Adds r·(left, right) (r = None means 1).
    pub fn add(&mut self, m: &DualMSM<'_, Bn256>, r: Option<Fr>) {
        self.terms_in += add_terms(&mut self.idx_l, &mut self.left, &m.left.scalars, &m.left.bases, r);
        self.terms_in += add_terms(&mut self.idx_r, &mut self.right, &m.right.scalars, &m.right.bases, r);
    }
}

/// Native reference for the final check, e(L, s_g2)·e(R, −g2) = 1 (DualMSM::check).
pub fn native_check(b: &Batch, g2: &G2Affine, s_g2: &G2Affine) -> bool {
    use group::{Curve, Group};
    use halo2_proofs::halo2curves::bn256::G2Prepared;
    use halo2_proofs::halo2curves::pairing::{MillerLoopResult, MultiMillerLoop};
    let ev = |t: &Vec<(Fr, G1Affine)>| -> G1Affine {
        let mut acc = G1::default();
        for (s, p) in t {
            acc += *p * *s;
        }
        acc.to_affine()
    };
    let (l, r) = (ev(&b.left), ev(&b.right));
    let sp = G2Prepared::from(*s_g2);
    let np = G2Prepared::from(-*g2);
    bool::from(Bn256::multi_miller_loop(&[(&l, &sp), (&r, &np)]).final_exponentiation().is_identity())
}

#[allow(unused)]
fn _msm_trait_in_scope<M: MSM<G1Affine>>() {}

/// Hints for one proof: every transcript point decompressed, x ‖ y little-endian. Fails when the proof does
/// not decode. The DualMSM is returned too, for a native check.
pub fn record_hints<'p>(params: &'p ParamsKZG<Bn256>, vk: &VerifyingKey<G1Affine>, publics: &[Fr], proof: &[u8]) -> Result<(Vec<u8>, DualMSM<'p, Bn256>), Error> {
    let mut tr = HintRead::new(proof, Mode::Record(vec![]));
    let dm = to_dual_msm(params, vk, publics, &mut tr)?;
    if !tr.consumed() {
        return Err(Error::Opening);
    }
    Ok((tr.recorded().concat(), dm))
}
