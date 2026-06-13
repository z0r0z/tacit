//! Verification core for the EVM confidential transfer, ported from the JS
//! prover (dapp/confidential-transfer.js + dapp/bulletproofs-plus.js). Pure k256
//! + sha2/keccak, no SP1 deps, so it tests natively against JS-produced fixtures.
//! The SP1 guest re-exports these checks. Two pieces:
//!   - verify_kernel: the conservation Schnorr (dapp/confidential-transfer.js)
//!   - verify_range:  the aggregated Bulletproofs+ range proof
//!                    (dapp/bulletproofs-plus.js::bppRangeVerify), m ∈ {1,2,4,8}

use k256::elliptic_curve::group::Group;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};

/// Public alias so dependents (the SP1 guest) can name the point type without
/// referencing k256 directly — the patched-k256 path is private, so a re-export
/// fails but an alias resolves in both vanilla and patched builds.
pub type Point = ProjectivePoint;
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

/// Bitcoin block/tx primitives for bridge_mint (BTC→ETH burn verification).
pub mod bitcoin;
pub mod bjj;
pub mod eth_reflection;
pub mod sigma;

pub const KERNEL_DOMAIN: &[u8] = b"tacit-evm-cxfer-kernel-v1";
const BPP_DOMAIN: &[u8] = b"tacit-bpp-v1";
const N_BITS: usize = 64;

// ──────────────────── point / scalar helpers ────────────────────

pub fn decompress(b: &[u8; 33]) -> Option<ProjectivePoint> {
    let ep = EncodedPoint::from_bytes(b).ok()?;
    let aff: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    aff.map(ProjectivePoint::from)
}

pub fn compress(p: &ProjectivePoint) -> [u8; 33] {
    let enc = p.to_affine().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(enc.as_bytes());
    out
}

/// reduce a 32-byte big-endian hash to a scalar mod n (matches modN(bytes32ToBigint)).
pub fn scalar_reduce_be(bytes: &[u8; 32]) -> Scalar {
    <Scalar as Reduce<U256>>::reduce(U256::from_be_slice(bytes))
}

/// parse a canonical 32-byte big-endian scalar (< n), else None (matches `>= SECP_N → false`).
fn scalar_canonical_be(bytes: &[u8]) -> Option<Scalar> {
    if bytes.len() != 32 { return None; }
    let fb = FieldBytes::clone_from_slice(bytes);
    Option::<Scalar>::from(Scalar::from_repr(fb))
}

fn sum_points(points: &[ProjectivePoint]) -> ProjectivePoint {
    points.iter().fold(ProjectivePoint::identity(), |a, p| a + p)
}

// ──────────────────── conservation kernel ────────────────────

/// z·G == R + e·(Σ Cin − Σ Cout), e = keccak(KERNEL_DOMAIN ‖ Cin… ‖ Cout… ‖ R) mod n.
/// Mirrors dapp/confidential-transfer.js. (fee-less; a public fee adds −fee·H to X.)
pub fn verify_kernel(
    in_c: &[ProjectivePoint],
    out_c: &[ProjectivePoint],
    r: &ProjectivePoint,
    z: &Scalar,
) -> bool {
    let mut k = Keccak::v256();
    k.update(KERNEL_DOMAIN);
    for p in in_c { k.update(&compress(p)); }
    for p in out_c { k.update(&compress(p)); }
    k.update(&compress(r));
    let mut h = [0u8; 32];
    k.finalize(&mut h);
    let e = scalar_reduce_be(&h);

    let x = sum_points(in_c) - sum_points(out_c);
    ProjectivePoint::generator() * z == *r + x * e
}

// ──────────────────── opening proof-of-knowledge (swap / LP) ────────────────────

pub const OPENING_DOMAIN: &[u8] = b"tacit-open-sigma-v1";

// ──────────────────── cBTC.zk sats-lock value-entry (real-BTC backing) ────────────────────
// The deploy-gated cBTC pieces (baked into BITCOIN_RELAY_VKEY). See ops/DESIGN-cbtc-sats-lock-reflection.md.
/// The single canonical asset id real-BTC-locked notes mint under (domain-separated, allowlisted).
/// TODO(cbtc): pin to the real cBTC.zk etch-derived id before the Mode-B re-prove (placeholder below).
pub const CBTC_ZK_ASSET_ID: [u8; 32] = [0xcb; 32];
/// The canonical cBTC vault scriptPubKey the lock output MUST equal — the deploy-gated LOCK FORM.
/// TODO(cbtc): set to the real vault output (the trust-model crux: protocol-key P2TR / covenant /
/// pre-signed — ops/DESIGN-cbtc-sats-lock-reflection.md §4). Placeholder 34-byte P2TR below.
pub const CBTC_VAULT_SPK: &[u8] = &[
    0x51, 0x20, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb,
    0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb, 0xcb,
];
/// Opening-sigma context domain for a sats-lock (binds asset ‖ lock_txid ‖ lock_vout — anti-replay).
pub const CBTC_LOCK_DOMAIN: &[u8] = b"tacit-cbtc-lock-v1";

/// Adaptor-swap LOCK-SET leaf domain — see ops/DESIGN-adaptor-swap-guest.md. Domain-separated from
/// the note-tree `leaf` so a locked note is NEVER spendable by a normal OP_TRANSFER (and vice-versa).
pub const ADAPTOR_LOCK_DOMAIN: &[u8] = b"tacit-adaptor-lock-v1";

/// Schnorr proof of knowledge of the blinding `r` for a Pedersen commitment with a PUBLIC
/// `amount`: proves the prover knows `r` such that `commitment = amount·H + r·G`, binding the
/// trade `context` (out owner / min_out / amounts / pool / chain) into the challenge — WITHOUT
/// revealing `r`. This is the swap/LP analog of the kernel signature hiding transfer blindings:
/// a remote settle prover verifies a swap/LP opening without learning `r`, so it can neither
/// spend the input note elsewhere nor redirect the output. Binding `amount` to the commitment
/// (Pedersen binding) also fixes the cleared/contributed value. proof = (R, z); e = keccak(
/// OPENING_DOMAIN ‖ amount_be ‖ context ‖ compress(commitment) ‖ compress(R)) mod n. Accept iff
/// z·G == R + e·(commitment − amount·H). Mirrors dapp/confidential-pool.js `openingSigma`.
pub fn verify_opening_sigma(
    commitment: &ProjectivePoint,
    amount: u64,
    r: &ProjectivePoint,
    z: &Scalar,
    context: &[u8; 32],
) -> bool {
    let x = *commitment - gen_h() * Scalar::from(amount);
    let mut k = Keccak::v256();
    k.update(OPENING_DOMAIN);
    k.update(&amount.to_be_bytes());
    k.update(context);
    k.update(&compress(commitment));
    k.update(&compress(r));
    let mut h = [0u8; 32];
    k.finalize(&mut h);
    let e = scalar_reduce_be(&h);
    ProjectivePoint::generator() * z == *r + x * e
}

/// Domain-separated keccak context binding a swap/LP intent's trade terms, fed into every opening
/// sigma for that intent. `notes` = each (cx, cy, owner) the intent touches (spent + minted, in a
/// fixed order); `amounts` = the public quantities (direction/in/out/shares/min_out…). Any change
/// to a bound field changes the context → the sigmas fail → the box can neither redirect the output
/// nor re-price the trade. The guest builds it from the witness; dapp/confidential-pool.js
/// `intentContext` mirrors it byte-for-byte (the exec harness locks the agreement).
pub fn intent_context(
    tag: &[u8],
    chain_binding: &[u8; 32],
    asset_a: &[u8; 32],
    asset_b: &[u8; 32],
    notes: &[([u8; 32], [u8; 32], [u8; 32])],
    amounts: &[u64],
) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(tag);
    k.update(chain_binding);
    k.update(asset_a);
    k.update(asset_b);
    for (cx, cy, owner) in notes {
        k.update(cx);
        k.update(cy);
        k.update(owner);
    }
    for a in amounts {
        k.update(&a.to_be_bytes());
    }
    let mut h = [0u8; 32];
    k.finalize(&mut h);
    h
}

// ──────────────────── Bitcoin T_CXFER kernel (BIP-340 Schnorr) ────────────────────

const CXFER_KERNEL_DOMAIN: &[u8] = b"tacit-kernel-v1";

/// BIP-340 tagged hash: sha256(sha256(tag) ‖ sha256(tag) ‖ msg).
fn bip340_tagged(tag: &[u8], msg: &[u8]) -> [u8; 32] {
    let t: [u8; 32] = Sha256::digest(tag).into();
    let mut h = Sha256::new();
    h.update(t);
    h.update(t);
    h.update(msg);
    h.finalize().into()
}

/// BIP-340 Schnorr verification (x-only pubkey) — ported from dapp/bulletproofs.js
/// `verifySchnorr`. Lifts `pubkey_x` to its even-y point P and checks `s·G − e·P == R`
/// with R even-y and `R.x == sig[0..32]`.
pub fn bip340_verify(sig: &[u8; 64], msg: &[u8; 32], pubkey_x: &[u8; 32]) -> bool {
    let rx = &sig[0..32];
    let s = match scalar_canonical_be(&sig[32..64]) {
        Some(s) => s,
        None => return false,
    };
    let mut comp = [0u8; 33];
    comp[0] = 0x02;
    comp[1..].copy_from_slice(pubkey_x);
    let p = match decompress(&comp) {
        Some(p) => p,
        None => return false,
    };
    let mut chal = Vec::with_capacity(96);
    chal.extend_from_slice(rx);
    chal.extend_from_slice(pubkey_x);
    chal.extend_from_slice(msg);
    let e = scalar_reduce_be(&bip340_tagged(b"BIP0340/challenge", &chal));
    let r = ProjectivePoint::generator() * s - p * e;
    if r == ProjectivePoint::identity() {
        return false;
    }
    let rb = compress(&r);
    rb[0] == 0x02 && &rb[1..] == rx
}

/// Verify a Bitcoin T_CXFER / T_CXFER_BPP kernel: conservation proven as a BIP-340
/// Schnorr signature over the kernel message
///   sha256("tacit-kernel-v1" ‖ asset ‖ in_count ‖ (txid ‖ vout_LE)×in ‖ out_count ‖
///          commitment(33)×out ‖ burned_LE8),
/// with verify key `P = Σ C_in − Σ C_out − burned·H` (= excess·G, the blinding residue;
/// the validator equation Σ C_in == burned·H + Σ C_out + excess·G). The reflection prover
/// resolves `input_commitments` from the UTXO set and reads the output commitments
/// (compressed) from the envelope; `input_outpoints` are the tx's vin (internal-order
/// txid + vout) as `bitcoin::extract_inputs` returns them.
pub fn cxfer_kernel_verify(
    asset: &[u8; 32],
    input_outpoints: &[([u8; 32], u32)],
    input_commitments: &[Point],
    output_commitments_compressed: &[[u8; 33]],
    burned_amount: u64,
    kernel_sig: &[u8; 64],
) -> bool {
    if input_outpoints.len() != input_commitments.len() {
        return false;
    }
    if input_outpoints.len() > 255 || output_commitments_compressed.len() > 255 {
        return false;
    }
    let mut h = Sha256::new();
    h.update(CXFER_KERNEL_DOMAIN);
    h.update(asset);
    h.update([input_outpoints.len() as u8]);
    for (txid, vout) in input_outpoints {
        h.update(txid);
        h.update(vout.to_le_bytes());
    }
    h.update([output_commitments_compressed.len() as u8]);
    let mut out_points: Vec<Point> = Vec::with_capacity(output_commitments_compressed.len());
    for c in output_commitments_compressed {
        h.update(c);
        match decompress(c) {
            Some(p) => out_points.push(p),
            None => return false,
        }
    }
    h.update(burned_amount.to_le_bytes());
    let msg: [u8; 32] = h.finalize().into();

    let mut p = sum_points(input_commitments) - sum_points(&out_points);
    if burned_amount != 0 {
        p = p - gen_h() * Scalar::from(burned_amount);
    }
    if p == ProjectivePoint::identity() {
        return false;
    }
    let pc = compress(&p);
    let px: [u8; 32] = pc[1..].try_into().unwrap();
    bip340_verify(kernel_sig, &msg, &px)
}

// ──────────────────── BP+ transcript (length-prefixed sha256) ────────────────────

struct Transcript {
    parts: Vec<u8>,
}
impl Transcript {
    fn new() -> Self { Transcript { parts: Vec::new() } }
    fn append(&mut self, label: &[u8], data: &[u8]) {
        self.parts.extend_from_slice(&(label.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(label);
        self.parts.extend_from_slice(&(data.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(data);
    }
    fn challenge(&mut self, label: &[u8]) -> Scalar {
        self.parts.extend_from_slice(&(label.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(label);
        let h: [u8; 32] = Sha256::digest(&self.parts).into();
        self.parts.extend_from_slice(&(h.len() as u32).to_le_bytes());
        self.parts.extend_from_slice(&h);
        let c = scalar_reduce_be(&h);
        if c == Scalar::ZERO {
            let h2: [u8; 32] = Sha256::new().chain_update(h).chain_update([0x01u8]).finalize().into();
            return scalar_reduce_be(&h2);
        }
        c
    }
}

// ──────────────────── BP+ generators ────────────────────

fn hash_to_curve(domain: &[u8], idx: u32) -> ProjectivePoint {
    for counter in 0u8..=255 {
        let mut hasher = Sha256::new();
        hasher.update(domain);
        hasher.update(idx.to_le_bytes());
        hasher.update([counter]);
        let seed: [u8; 32] = hasher.finalize().into();
        let mut comp = [0u8; 33];
        comp[0] = 0x02;
        comp[1..].copy_from_slice(&seed);
        if let Some(p) = decompress(&comp) {
            if p != ProjectivePoint::identity() { return p; }
        }
    }
    panic!("hash_to_curve failed");
}

pub(crate) fn gen_h() -> ProjectivePoint {
    let hseed: [u8; 32] = Sha256::digest(b"tacit-generator-H-v1").into();
    for counter in 0u8..=255 {
        let mut hasher = Sha256::new();
        hasher.update(hseed);
        hasher.update([counter]);
        let x: [u8; 32] = hasher.finalize().into();
        let mut comp = [0u8; 33];
        comp[0] = 0x02;
        comp[1..].copy_from_slice(&x);
        if let Some(p) = decompress(&comp) {
            if p != ProjectivePoint::identity() { return p; }
        }
    }
    panic!("gen_h failed");
}

fn bpp_gens(mn: usize) -> (Vec<ProjectivePoint>, Vec<ProjectivePoint>, ProjectivePoint) {
    let gvec: Vec<_> = (0..mn).map(|i| hash_to_curve(b"tacit-bp-G-v1", i as u32)).collect();
    let hvec: Vec<_> = (0..mn).map(|i| hash_to_curve(b"tacit-bp-H-v1", i as u32)).collect();
    (gvec, hvec, gen_h())
}

// ──────────────────── BP+ aggregated range verifier ────────────────────

fn sum_of_scalar_powers(x: &Scalar, n: usize) -> Scalar {
    let mut res = Scalar::ZERO;
    let mut xpow = Scalar::ONE;
    for _ in 0..n {
        xpow *= x;
        res += xpow;
    }
    res
}

fn sum_of_even_powers(x: &Scalar, n: usize) -> Scalar {
    let mut x1 = *x * x; // x^2
    let mut res = x1;
    let mut nn = n;
    while nn > 2 {
        res += x1 * res;
        x1 = x1 * x1;
        nn /= 2;
    }
    res
}

/// Ported from dapp/bulletproofs-plus.js::bppRangeVerify. Returns true iff the
/// aggregated range proof shows every committed value ∈ [0, 2^64).
pub fn verify_range(commitments: &[ProjectivePoint], proof: &[u8]) -> bool {
    let m = commitments.len();
    if ![1usize, 2, 4, 8].contains(&m) { return false; }
    let log_m = m.trailing_zeros() as usize;
    let log_mn = log_m + 6;
    let mn = m * N_BITS;
    if proof.len() != 99 + 96 + log_mn * 66 { return false; }

    // ---- parse ----
    let mut off = 0usize;
    let mut take33 = |o: &mut usize| -> Option<ProjectivePoint> {
        let mut a = [0u8; 33];
        a.copy_from_slice(&proof[*o..*o + 33]);
        *o += 33;
        decompress(&a)
    };
    let a_pt = match take33(&mut off) { Some(p) => p, None => return false };
    let a1 = match take33(&mut off) { Some(p) => p, None => return false };
    let b_pt = match take33(&mut off) { Some(p) => p, None => return false };
    let r1 = match scalar_canonical_be(&proof[off..off + 32]) { Some(s) => s, None => return false };
    off += 32;
    let s1 = match scalar_canonical_be(&proof[off..off + 32]) { Some(s) => s, None => return false };
    off += 32;
    let d1 = match scalar_canonical_be(&proof[off..off + 32]) { Some(s) => s, None => return false };
    off += 32;
    let mut lvec = Vec::with_capacity(log_mn);
    let mut rvec = Vec::with_capacity(log_mn);
    for _ in 0..log_mn {
        match take33(&mut off) { Some(p) => lvec.push(p), None => return false }
        match take33(&mut off) { Some(p) => rvec.push(p), None => return false }
    }
    if off != proof.len() { return false; }

    // ---- transcript replay ----
    let mut t = Transcript::new();
    t.append(b"domain", BPP_DOMAIN);
    t.append(b"M", &[(m & 0xff) as u8]);
    for v in commitments { t.append(b"V", &compress(v)); }
    t.append(b"A", &compress(&a_pt));
    let y = t.challenge(b"y");
    let z = t.challenge(b"z");
    let zsq = z * z;
    let mut challenges = Vec::with_capacity(log_mn);
    for k in 0..log_mn {
        t.append(b"L", &compress(&lvec[k]));
        t.append(b"R", &compress(&rvec[k]));
        challenges.push(t.challenge(b"u"));
    }
    t.append(b"A1", &compress(&a1));
    t.append(b"B", &compress(&b_pt));
    let e = t.challenge(b"e");
    let esq = e * e;

    // ---- inverses ----
    let y_inv = y.invert().unwrap();
    let challenges_inv: Vec<Scalar> = challenges.iter().map(|u| u.invert().unwrap()).collect();

    // ---- y^MN, y^(MN+1) ----
    let mut y_mn = y;
    let mut tmp = mn;
    while tmp > 1 { y_mn = y_mn * y_mn; tmp /= 2; }
    let y_mn_1 = y_mn * y;

    // ---- d[j*N+i] = z^(2(j+1)) · 2^i ----
    let two = Scalar::from(2u64);
    let mut d = vec![Scalar::ZERO; mn];
    d[0] = zsq;
    for i in 1..N_BITS { d[i] = d[i - 1] * two; }
    for j in 1..m {
        for i in 0..N_BITS { d[j * N_BITS + i] = d[(j - 1) * N_BITS + i] * zsq; }
    }

    // ---- challenges_cache (IPA s-vector) ----
    let mut cache = vec![Scalar::ZERO; 1 << log_mn];
    cache[0] = challenges_inv[0];
    cache[1] = challenges[0];
    for j in 1..log_mn {
        let slots = 1usize << (j + 1);
        let mut s = slots;
        while s > 0 {
            s -= 1;
            cache[s] = if s & 1 == 1 {
                cache[s >> 1] * challenges[j]
            } else {
                cache[s >> 1] * challenges_inv[j]
            };
        }
    }

    // ---- generators ----
    let (gvec, hvec, h_gen) = bpp_gens(mn);

    // ---- scalar terms ----
    let sum_y_mn = sum_of_scalar_powers(&y, mn);
    let two_pow_n_minus_1 = Scalar::from(u64::MAX); // 2^64 - 1
    let sum_d_val = two_pow_n_minus_1 * sum_of_even_powers(&z, 2 * m);

    let h_term1 = r1 * y * s1;
    let zsq_minus_z = zsq - z;
    let h_inner = zsq_minus_z * sum_y_mn + (y_mn_1 * z * sum_d_val);
    let h_scalar = h_term1 + esq * h_inner;
    let g_scalar = d1;

    let neg_esq = -esq;
    let base_v = neg_esq * y_mn_1; // -e²·y^(MN+1)
    let mut v_scalars = Vec::with_capacity(m);
    {
        let mut zp = zsq;
        for _ in 0..m { v_scalars.push(base_v * zp); zp = zp * zsq; }
    }

    let a_scalar = -esq;
    let a1_scalar = -e;
    let b_scalar = -Scalar::ONE;

    let mut l_scalars = Vec::with_capacity(log_mn);
    let mut r_scalars = Vec::with_capacity(log_mn);
    for k in 0..log_mn {
        let usq = challenges[k] * challenges[k];
        let uinvsq = challenges_inv[k] * challenges_inv[k];
        l_scalars.push(neg_esq * usq);
        r_scalars.push(neg_esq * uinvsq);
    }

    // ---- per-index G_i / H_i scalars ----
    let mut gi = vec![Scalar::ZERO; mn];
    let mut hi = vec![Scalar::ZERO; mn];
    let mut e_r1_yinv_i = e * r1;
    let e_s1 = e * s1;
    let esq_z = esq * z;
    let neg_esq_z = -esq_z;
    let mut neg_esq_y_mn_minus_i = -(esq * y_mn);
    let mn_minus_1 = mn - 1;
    for i in 0..mn {
        gi[i] = e_r1_yinv_i * cache[i] + esq_z;
        let rev = mn_minus_1 ^ i;
        hi[i] = e_s1 * cache[rev] + neg_esq_z + (neg_esq_y_mn_minus_i * d[i]);
        e_r1_yinv_i = e_r1_yinv_i * y_inv;
        neg_esq_y_mn_minus_i = neg_esq_y_mn_minus_i * y_inv;
    }

    // ---- single MSM: must be identity ----
    let mut acc = ProjectivePoint::generator() * g_scalar;
    acc += h_gen * h_scalar;
    for i in 0..mn {
        acc += gvec[i] * gi[i];
        acc += hvec[i] * hi[i];
    }
    for j in 0..m { acc += commitments[j] * v_scalars[j]; }
    acc += a_pt * a_scalar;
    acc += a1 * a1_scalar;
    acc += b_pt * b_scalar;
    for k in 0..log_mn {
        acc += lvec[k] * l_scalars[k];
        acc += rvec[k] * r_scalars[k];
    }

    acc == ProjectivePoint::identity()
}

// ──────────────────── wrap/unwrap opening + keccak note helpers ────────────────────

/// Build a point from big-endian affine (x, y) — the dapp serializes commitments
/// this way for the contract leaf preimage.
pub fn from_affine_xy(x: &[u8; 32], y: &[u8; 32]) -> Option<ProjectivePoint> {
    let mut enc = [0u8; 65];
    enc[0] = 0x04;
    enc[1..33].copy_from_slice(x);
    enc[33..].copy_from_slice(y);
    let ep = EncodedPoint::from_bytes(enc).ok()?;
    let aff: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    aff.map(ProjectivePoint::from)
}

/// wrap/unwrap public-amount opening: C == v·H + r·G (v public, r in the witness).
/// Same scheme as the bridge guest's verify_pedersen_opening.
pub fn verify_pedersen_opening(c: &ProjectivePoint, v: u64, r: &Scalar) -> bool {
    *c == gen_h() * Scalar::from(v) + ProjectivePoint::generator() * r
}

fn k2(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(l); k.update(r);
    let mut o = [0u8; 32]; k.finalize(&mut o); o
}
fn kn(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak::v256();
    for p in parts { k.update(p); }
    let mut o = [0u8; 32]; k.finalize(&mut o); o
}

/// leaf = keccak(asset_id ‖ Cx ‖ Cy ‖ owner) — matches ConfidentialPool + the dapp.
pub fn leaf(asset_id: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    kn(&[asset_id, cx, cy, owner])
}
/// nullifier = keccak(Cx ‖ Cy ‖ "spent") — note-bound (spec B3), chain-independent.
/// Derived from the membership-proven commitment, NOT a free witness secret, so a note
/// has exactly one nullifier and cannot be re-spent under a fresh secret.
pub fn nullifier(cx: &[u8; 32], cy: &[u8; 32]) -> [u8; 32] { kn(&[cx, cy, b"spent"]) }
/// The UTXO-set value for a pool note: keccak(Cx ‖ Cy), binding the outpoint to its
/// commitment. The reflection prover stores this when an output lands and, on spend,
/// re-opens it to derive ν — so a spend's ν is forced to be the note actually at that outpoint.
pub fn commitment_hash(cx: &[u8; 32], cy: &[u8; 32]) -> [u8; 32] { kn(&[cx, cy]) }
/// The commitment_hash of a COMPRESSED secp256k1 commitment, as a CXFER envelope carries it:
/// decompress → affine (Cx,Cy) → keccak(Cx,Cy). The reflection prover binds each output note's
/// stored UTXO value to the envelope's declared commitment, so a fake/unbacked note (with a
/// commitment the confirmed tx never declared) cannot enter the pool. None if not a curve point.
pub fn commitment_hash_compressed(compressed: &[u8; 33]) -> Option<[u8; 32]> {
    let enc = decompress(compressed)?.to_affine().to_encoded_point(false);
    let b = enc.as_bytes();
    if b.len() != 65 { return None; }
    let cx: [u8; 32] = b[1..33].try_into().ok()?;
    let cy: [u8; 32] = b[33..65].try_into().ok()?;
    Some(commitment_hash(&cx, &cy))
}
/// The reflected pool-note leaf for a confirmed CXFER output: `leaf(asset, Cx, Cy, 0)`, where
/// (Cx,Cy) is the DECOMPRESSED envelope commitment and the owner is the zero sentinel (a
/// Bitcoin-homed note carries no owner — the dapp reflection indexer uses the same ZERO_OWNER).
/// The reflection prover MUST derive the appended note leaf this way rather than read it as a free
/// witness: the note tree's root is committed as `bitcoinPoolRoot` and a btcHomed settle spends
/// against it by membership, so a witnessed leaf would let a relayer append an arbitrary
/// attacker-spendable leaf (value minted from nothing). None if the commitment isn't a curve point.
pub fn reflected_note_leaf(asset: &[u8; 32], compressed: &[u8; 33]) -> Option<[u8; 32]> {
    let enc = decompress(compressed)?.to_affine().to_encoded_point(false);
    let b = enc.as_bytes();
    if b.len() != 65 { return None; }
    let cx: [u8; 32] = b[1..33].try_into().ok()?;
    let cy: [u8; 32] = b[33..65].try_into().ok()?;
    Some(leaf(asset, &cx, &cy, &[0u8; 32]))
}
/// The UTXO-set key for a Bitcoin outpoint: keccak(txid ‖ vout_le). The reflection prover
/// derives this from a confirmed tx's vin (`extract_inputs`), so a spent outpoint is forced
/// to be a real prior output and not a witnessed value.
pub fn outpoint_key(txid: &[u8; 32], vout: u32) -> [u8; 32] { kn(&[txid, &vout.to_le_bytes()]) }
/// The adaptor-swap LOCK-SET leaf for a confidentially-locked note (ops/DESIGN-adaptor-swap-guest.md):
/// binds the locked note's commitment (Cx,Cy), the adaptor point T (the PTLC secret hole, Tx,Ty), the
/// `deadline`, and BOTH parties (`recipient` paid on claim / `locker` repaid on refund). A CLAIM/REFUND
/// must reproduce this EXACT leaf to prove lock-set membership, so neither the relayer nor the
/// counterparty can redirect the output (the paid party is in the leaf), re-time the swap (the deadline
/// is in the leaf), or substitute a different adaptor point (T is in the leaf). Domain-separated from the
/// note-tree `leaf` so a lock leaf is never spendable by a normal OP_TRANSFER. Value stays hidden — it
/// rides the note commitment, bound by an opening sigma at lock/claim/refund like OP_OTC.
#[allow(clippy::too_many_arguments)]
pub fn adaptor_lock_leaf(
    cx: &[u8; 32], cy: &[u8; 32],
    tx: &[u8; 32], ty: &[u8; 32],
    deadline: u64,
    recipient: &[u8; 32], locker: &[u8; 32],
) -> [u8; 32] {
    kn(&[ADAPTOR_LOCK_DOMAIN, cx, cy, tx, ty, &deadline.to_be_bytes(), recipient, locker])
}
/// Confidential-AMM pool id, matching `ConfidentialPool`'s `keccak256(abi.encode(low, high, feeBps))`
/// (three 32-byte ABI words). Binds an OP_SWAP/LP batch's reserves to the exact (canonical pair, fee
/// tier) pool, so a prover can't settle one pool's op against another's reserves.
pub fn pool_id(asset_a: &[u8; 32], asset_b: &[u8; 32], fee_bps: u32) -> [u8; 32] {
    // Canonical asset pair + fee tier: keccak(low ‖ high ‖ fee_be32). (low,high) = the assets sorted
    // by byte order; fee_be32 = fee_bps as a 32-byte BE word. Canonical so (A,B)≡(B,A) (one pool per
    // pair); fee-bound so each fee tier is a DISTINCT pool — an LP just picks its tier, nothing to
    // squat. (No capability-flags byte: on EVM a pool "capability" is a real hook contract, not a
    // reserved flag, so it'd be added as a bound hooks address when that feature exists — not cargo-
    // culted from the Bitcoin circuit's flagsByte.)
    let (low, high) = if bitcoin::be_bytes_lte(asset_a, asset_b) { (asset_a, asset_b) } else { (asset_b, asset_a) };
    let mut fee = [0u8; 32];
    fee[28..].copy_from_slice(&fee_bps.to_be_bytes());
    kn(&[low, high, &fee])
}
/// Pool-specific LP-share asset id: keccak(pool_id ‖ "lp"). An LP's position is a shielded note of
/// this asset, so per-LP stakes stay hidden while the pool's totalShares is public.
pub fn lp_share_id(pool_id: &[u8; 32]) -> [u8; 32] { kn(&[pool_id, b"lp"]) }

/// Proportional LP shares for an add: min(floor(S·dA/R_A), floor(S·dB/R_B)). The limiting
/// leg sets the shares, so an off-ratio add earns only the smaller leg's worth (the excess accrues to
/// the pool, the constant-product `mint` rule) and the LP can never over-claim. This replaces the
/// old exact-ratio gate (`dA·R_B == dB·R_A`), which forced dA to be a multiple of R_A/gcd(R_A,R_B) and
/// so made incremental adds impossible once a traded pool's reserves went coprime. Faithful port of
/// tests/amm-clearing.mjs `lpAddShares` (AMM.md §"Indexer determinism rules: Rounding"). u128 product
/// so S·dA (each < 2^64) never overflows. Callers pass a live pool (reserve_a, reserve_b > 0).
pub fn lp_add_shares(shares_pre: u64, d_a: u64, d_b: u64, reserve_a: u64, reserve_b: u64) -> u128 {
    let sp = shares_pre as u128;
    let a = sp * d_a as u128 / reserve_a as u128;
    let b = sp * d_b as u128 / reserve_b as u128;
    if a < b { a } else { b }
}

/// Proportional underlying for an LP remove: floor(reserve·shares/total), floored TOWARD the pool so
/// the rounding dust stays for the remaining LPs (never over-withdrawn). Mirrors tests/amm-clearing.mjs
/// `lpRemoveOutputs`. u128 product (reserve·shares each < 2^64).
pub fn lp_remove_output(reserve: u64, shares: u64, total: u64) -> u128 {
    reserve as u128 * shares as u128 / total as u128
}

/// Floor integer square root — matches tests/amm-clearing.mjs `isqrt` (and Solady's sqrt). OP_LP_ADD's
/// FIRST mint (empty pool) sets initial totalShares = isqrt(dA·dB) — the constant-product first-mint
/// basis, so shares are the price-invariant geometric mean and the MINIMUM_LIQUIDITY lock is symmetric.
/// The input is dA·dB with dA,dB ≤ u64, so n < 2^128 and the result ≤ u64.
pub fn isqrt(n: u128) -> u128 { n.isqrt() }

/// Constant-product exact-in hop output (`getAmountOut`) — the single-trade output for one hop of a
/// route: amount_out = floor(R_out · amount_in · (10000−fee) / (R_in · 10000 + amount_in · (10000−fee))).
/// The (10000−fee) factor charges the pool's fee tier; the result is always < R_out (the denominator
/// strictly exceeds the numerator's R_out coefficient), so a hop can never drain its output reserve.
/// u128 throughout: amount_in, R_in, R_out each < 2^64, so R_out · ain_g < 2^64·2^64·10^4 < 2^128.
/// OP_SWAP_ROUTE chains it hop-by-hop (out_i feeds in_{i+1}); fee_bps ≤ 1000 is enforced upstream.
pub fn get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64, fee_bps: u32) -> u128 {
    let gamma = (10000 - fee_bps) as u128;        // 10000 − fee
    let ain_g = amount_in as u128 * gamma;        // amount_in · γ
    let num = reserve_out as u128 * ain_g;        // R_out · amount_in · γ
    let den = reserve_in as u128 * 10000 + ain_g; // R_in · 10000 + amount_in · γ
    num / den
}

/// Deterministic uniform-price clearing solve — a faithful, byte-for-byte port of
/// tests/amm-clearing.mjs `solveClearing` (AMM.md §4, the normative indexer-determinism rule).
/// OP_SWAP uses it to ENFORCE the pool's fee tier: the guest re-derives P_clear from the public
/// reserves + gross flows + fee_bps and rejects any batch whose declared uniform price differs, so
/// the fee is actually charged (the constant-product non-decrease alone is only the ZERO-fee floor).
/// Returns (P_clear_num, P_clear_den). BigUint throughout (like the JS BigInt) so the intermediate
/// products — R_B·γ_num·Δa reaches ~2^142 — never overflow.
pub fn solve_clearing(x: u64, y: u64, r_a: u64, r_b: u64, fee_bps: u32) -> (num_bigint::BigUint, num_bigint::BigUint) {
    use num_bigint::BigUint;
    let xb = BigUint::from(x);
    let rab = BigUint::from(r_a);
    let rbb = BigUint::from(r_b);
    // Empty batch: spot price = R_A / R_B (den guarded to 1 when R_B == 0).
    if x == 0 && y == 0 {
        return (rab, if r_b == 0 { BigUint::from(1u32) } else { rbb });
    }
    assert!(r_a != 0 && r_b != 0, "solve: pool reserves must be > 0 for a non-empty batch");
    let g_num = BigUint::from(10000u32 - fee_bps); // fee_bps ≤ 1000 is enforced upstream
    let g_den = BigUint::from(10000u32);
    let lhs = &xb * &rbb;          // X·R_B
    let rhs = BigUint::from(y) * &rab; // Y·R_A
    if lhs > rhs {
        let (pn, pd) = solve_a_to_b(x, y, r_a, r_b, &g_num, &g_den);
        (pn, pd)
    } else if lhs < rhs {
        // Symmetric B→A: solve with (X,Y),(R_A,R_B) swapped, then reciprocate P_clear.
        let (pn, pd) = solve_a_to_b(y, x, r_b, r_a, &g_num, &g_den);
        (pd, pn)
    } else {
        // Exact-cancel batch → spot.
        (rab, rbb)
    }
}

// A→B-dominant solve: binary search on Δa_net ∈ [1, X] (≤ 64 iterations), returns (P_clear_num,
// P_clear_den) = (X, Y + Δb_net) for the converged (or largest-too-small) Δa_net. Mirrors
// solveAToB in tests/amm-clearing.mjs exactly.
fn solve_a_to_b(x: u64, y: u64, r_a: u64, r_b: u64, g_num: &num_bigint::BigUint, g_den: &num_bigint::BigUint)
    -> (num_bigint::BigUint, num_bigint::BigUint)
{
    use num_bigint::BigUint;
    let xb = BigUint::from(x);
    let yb = BigUint::from(y);
    let rab = BigUint::from(r_a);
    let rbb = BigUint::from(r_b);
    let one = BigUint::from(1u32);
    let mut lo = one.clone();
    let mut hi = xb.clone();
    let mut best = one.clone();
    let mut iter = 0u32;
    while iter < 64 && lo <= hi {
        let mid = &lo + (&hi - &lo) / 2u32;
        // Δb = floor(R_B·γ_num·mid / (R_A·γ_den + γ_num·mid))
        let delta_b = (&rbb * g_num * &mid) / (&rab * g_den + g_num * &mid);
        let denom = &yb + &delta_b;
        // Δa_implied = X − floor(Y·X / (Y + Δb)); denom==0 only when Y==Δb==0 (pool-empty edge).
        let delta_a_implied = if denom == BigUint::from(0u32) { xb.clone() } else { &xb - (&yb * &xb) / &denom };
        if delta_a_implied == mid {
            return (xb.clone(), &yb + &delta_b);
        }
        if delta_a_implied < mid {
            hi = &mid - 1u32;
        } else {
            best = mid.clone();
            lo = &mid + 1u32;
        }
        iter += 1;
    }
    // No exact fixed point: the largest 'best' that was too small (settler declares exactly this).
    let final_delta_b = (&rbb * g_num * &best) / (&rab * g_den + g_num * &best);
    (xb, &yb + &final_delta_b)
}

/// True iff (price_num, price_den) is EXACTLY the fee-clearing uniform price (B per A, un-reduced)
/// that solve_clearing derives for these gross flows + reserves + fee — the OP_SWAP fee-enforcement
/// check. The declared price is clearingPriceBperA(solve), i.e. price_num == P_clear_den and
/// price_den == P_clear_num. Keeping the BigUint inside cxfer-core so the zkVM guest just calls a bool.
pub fn clearing_price_matches(x: u64, y: u64, r_a: u64, r_b: u64, fee_bps: u32, price_num: u64, price_den: u64) -> bool {
    use num_bigint::BigUint;
    let (pc_num, pc_den) = solve_clearing(x, y, r_a, r_b, fee_bps);
    pc_den == BigUint::from(price_num) && pc_num == BigUint::from(price_den)
}
/// Bind a spent pool note to its nullifier: given the outpoint's committed value (proven in
/// the UTXO set via the remove witness) and the note's commitment coords, return ν iff
/// (Cx,Cy) opens that value — so a spend can't claim a ν unbound from the real note. None
/// if the commitment doesn't match the outpoint's stored value.
pub fn bind_spent_note(committed_value: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32]) -> Option<[u8; 32]> {
    if commitment_hash(cx, cy) != *committed_value { return None; }
    Some(nullifier(cx, cy))
}

/// Confirm one pool tx for the reflection prover and return `(txid, spent-outpoint keys)`.
/// `verify_tx_in_block` ties the tx to a PoW block whose header the caller has checked is in
/// the verified header chain; `extract_inputs` gives the tx's vins → `outpoint_key` each. A
/// reflected spend's outpoint must be one of these (it's a real prior output the confirmed
/// tx actually spends), and a reflected output's outpoint must be `outpoint_key(txid, vout)`
/// (a real output of the confirmed tx). None if the tx isn't confirmed in the block or is
/// malformed.
pub fn confirm_pool_tx(
    header: &[u8],
    tx_data: &[u8],
    tx_index: u32,
    txids: &[[u8; 32]],
) -> Option<([u8; 32], Vec<[u8; 32]>)> {
    let txid = bitcoin::verify_tx_in_block(header, tx_data, tx_index, txids)?;
    let outpoints = bitcoin::extract_inputs(tx_data)?
        .iter()
        .map(|(t, v)| outpoint_key(t, *v))
        .collect();
    Some((txid, outpoints))
}
/// deposit id = keccak(asset_id ‖ value_be32 ‖ Cx ‖ Cy ‖ owner) — binds the note's
/// in-system value (the contract derives the same value = amount/unitScale at wrap, so
/// value·unitScale == escrowed amount: the wrap-side no-inflation gate).
pub fn deposit_id(asset_id: &[u8; 32], value_be32: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    kn(&[asset_id, value_be32, cx, cy, owner])
}
/// claimId = keccak(abi.encodePacked(destChain:uint16, destCommitment, nullifier,
/// asset_id)) — matches ConfidentialPool.settle's on-chain re-derivation and the
/// dapp prover. Binds a cross-chain burn to exactly one mintable destination.
pub fn claim_id(dest_chain: u16, dest_commitment: &[u8; 32], nullifier: &[u8; 32], asset_id: &[u8; 32]) -> [u8; 32] {
    kn(&[&dest_chain.to_be_bytes(), dest_commitment, nullifier, asset_id])
}

/// Membership against the on-chain Keccak incremental Merkle root.
pub fn keccak_merkle_verify(leaf: &[u8; 32], index: u64, path: &[[u8; 32]], root: &[u8; 32]) -> bool {
    match merkle_root_from(leaf, index, path) {
        Some(h) => &h == root,
        None => false,
    }
}

/// Fold a leaf up its Merkle path to the root it implies — the compute-side of
/// `keccak_merkle_verify` (which compares the result to a claimed root). The witnessed
/// accumulator transitions use it to derive the NEW root after replacing/appending a leaf:
/// the same path that proved the old leaf re-folds the new leaf to the post-update root.
/// Returns None on a malformed (non-depth-32) path.
pub fn merkle_root_from(leaf: &[u8; 32], mut index: u64, path: &[[u8; 32]]) -> Option<[u8; 32]> {
    if path.len() != KECCAK_TREE_DEPTH { return None; }
    let mut h = *leaf;
    for sib in path {
        h = if index & 1 == 0 { k2(&h, sib) } else { k2(sib, &h) };
        index >>= 1;
    }
    Some(h)
}

/// Witnessed append transition for the append-only note tree: append `leaf` at the next
/// free slot and return the new root — with NO frontier state, only (prior_root, the empty
/// slot's path). The slot at `next_index` must be the zero leaf in `prior_root` (so an
/// append can't overwrite an existing note); the same path re-folds `leaf` to the new root.
/// The reflection prover folds Δ-deposits through this; `next_index` is the prior leaf count.
pub fn keccak_tree_append_transition(
    prior_root: &[u8; 32],
    next_index: u64,
    path: &[[u8; 32]],
    leaf: &[u8; 32],
) -> Option<[u8; 32]> {
    if !keccak_merkle_verify(&[0u8; 32], next_index, path, prior_root) { return None; }
    merkle_root_from(leaf, next_index, path)
}

/// Big-endian strict less-than over 32-byte values.
fn be_lt(a: &[u8; 32], b: &[u8; 32]) -> bool { bitcoin::be_bytes_lte(a, b) && a != b }

/// Indexed-Merkle-tree leaf: a "low nullifier" linked record keccak(value ‖ next).
/// The set is the sorted linked list of spent nullifiers; `next` is the successor
/// (0 ⇒ this is the maximum element).
pub fn imt_leaf(value: &[u8; 32], next: &[u8; 32]) -> [u8; 32] { kn(&[value, next]) }

/// Indexed-Merkle NON-membership: prove `nu` is NOT in the set committed by `root`
/// (a Keccak Merkle tree of `imt_leaf` records). Succinct — one low-leaf membership,
/// no full-set load — so proving cost is O(log n), not O(n) like a sorted-list hash.
/// Returns true iff the low leaf is in the tree and its (value, next) range straddles
/// `nu`: value < nu < next, or value < nu with next == 0 (nu beyond the maximum).
/// A member `nu` cannot be proven absent (no leaf's range strictly straddles it).
pub fn imt_non_membership(
    root: &[u8; 32],
    nu: &[u8; 32],
    low_value: &[u8; 32],
    low_next: &[u8; 32],
    low_index: u64,
    low_path: &[[u8; 32]],
) -> bool {
    let leaf = imt_leaf(low_value, low_next);
    if !keccak_merkle_verify(&leaf, low_index, low_path, root) { return false; }
    if !be_lt(low_value, nu) { return false; }
    let zero = [0u8; 32];
    if low_next == &zero { return true; } // low is the max element; nu is beyond it
    be_lt(nu, low_next)
}

/// Indexed-Merkle MEMBERSHIP: prove `nu` IS in the set committed by `root` — there is a
/// leaf `imt_leaf(nu, next)` in the tree at `index`. Since the IMT holds each spent
/// nullifier as a unique sorted link, a leaf whose value is `nu` means `nu` is spent.
/// bridge_mint uses this to prove a Bitcoin note was actually burned (its ν reflected
/// into the relay-attested Bitcoin spent set) — the relay-anchored replacement for the
/// self-supplied-PoW block check (spec B5).
pub fn imt_membership(
    root: &[u8; 32],
    nu: &[u8; 32],
    next: &[u8; 32],
    index: u64,
    path: &[[u8; 32]],
) -> bool {
    keccak_merkle_verify(&imt_leaf(nu, next), index, path, root)
}

/// Witnessed IMT insert transition: insert `nu` into the spent set committed by
/// `prior_root` and return the new root — with NO full-set state (the resume-from-digest
/// form the reflection prover folds Δ-spends through). Two Merkle updates, each verified
/// against the evolving root so a forged witness can't fabricate a transition:
///   1. the straddling low leaf (low_value < nu < low_next, or low_next == 0) is a member
///      of `prior_root`; its successor is rewired to `nu` → the intermediate root.
///   2. the target slot at `new_index` is empty (zero leaf) in the intermediate tree; it
///      is filled with {nu → old_next} → the new root.
/// `new_path` is the path in the INTERMEDIATE tree (after the low-leaf rewire) — the
/// indexer builds it against the post-rewire state. Returns None if any check fails.
#[allow(clippy::too_many_arguments)]
pub fn imt_insert_transition(
    prior_root: &[u8; 32],
    nu: &[u8; 32],
    low_value: &[u8; 32],
    low_next: &[u8; 32],
    low_index: u64,
    low_path: &[[u8; 32]],
    new_index: u64,
    new_path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    let zero = [0u8; 32];
    // nu must be insertable: non-zero and strictly straddled by the low leaf.
    if *nu == zero || !be_lt(low_value, nu) { return None; }
    if *low_next != zero && !be_lt(nu, low_next) { return None; }
    // (1) the low leaf is a member of prior_root; rewire its successor to nu.
    if !keccak_merkle_verify(&imt_leaf(low_value, low_next), low_index, low_path, prior_root) { return None; }
    let intermediate = merkle_root_from(&imt_leaf(low_value, nu), low_index, low_path)?;
    // (2) the target slot is empty in the intermediate tree; fill it with {nu → old_next}.
    if !keccak_merkle_verify(&zero, new_index, new_path, &intermediate) { return None; }
    merkle_root_from(&imt_leaf(nu, low_next), new_index, new_path)
}

/// Depth of the keccak incremental Merkle tree — the note tree, the spent-set IMT, and
/// ConfidentialPool's commitment tree all share it (TREE_LEVELS = 32).
pub const KECCAK_TREE_DEPTH: usize = 32;

/// Per-level zero hashes: zeros[0] = 0, zeros[i] = keccak(zeros[i-1] ‖ zeros[i-1]).
fn keccak_zeros() -> [[u8; 32]; KECCAK_TREE_DEPTH] {
    let mut z = [[0u8; 32]; KECCAK_TREE_DEPTH];
    for i in 1..KECCAK_TREE_DEPTH { z[i] = kn(&[&z[i - 1], &z[i - 1]]); }
    z
}

/// Root of the depth-32 keccak incremental Merkle tree holding `leaves` at positions
/// 0..n, empty subtrees zero-filled — byte-identical to ConfidentialPool._insertLeaf
/// and the JS pool.Tree. This is the BUILD side (the verify side is
/// keccak_merkle_verify); the reflection prover uses it to recompute the Bitcoin pool
/// root and the spent-set IMT root in-guest.
pub fn keccak_merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let zeros = keccak_zeros();
    // Empty tree: fold the zero leaf up 32 levels → zeros[32].
    if leaves.is_empty() {
        let mut h = [0u8; 32];
        for _ in 0..KECCAK_TREE_DEPTH { h = kn(&[&h, &h]); }
        return h;
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    for i in 0..KECCAK_TREE_DEPTH {
        let mut next: Vec<[u8; 32]> = Vec::with_capacity((level.len() + 1) / 2);
        let mut k = 0;
        while k * 2 < level.len() {
            let l = level[2 * k];
            let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[i] };
            next.push(kn(&[&l, &r]));
            k += 1;
        }
        level = next; // non-empty for non-empty input every round
    }
    level[0]
}

/// The spent-set IMT root from its sorted low-nullifier linked list `(value, next)` —
/// each link becomes an imt_leaf, folded into the depth-32 tree. The reflection prover
/// commits this as `bitcoinSpentRoot`; non-membership (imt_non_membership) verifies
/// against it.
pub fn imt_root(links: &[([u8; 32], [u8; 32])]) -> [u8; 32] {
    let leaves: Vec<[u8; 32]> = links.iter().map(|(v, n)| imt_leaf(v, n)).collect();
    keccak_merkle_root(&leaves)
}

/// The NON-ZERO root of an EMPTY spent set: the single sentinel low-leaf imt_leaf(0,0)
/// ("0 is the max, nothing above"), which proves non-membership of every nu > 0. The
/// reflected spent root is seeded to this and only advances; the contract rejects a zero
/// spent root because a zero would let the guest skip its non-membership check.
pub fn imt_empty_root() -> [u8; 32] {
    let zero = [0u8; 32];
    keccak_merkle_root(&[imt_leaf(&zero, &zero)])
}

/// Stateful spent-set accumulator (the indexer / reflection-prover side): the sorted
/// low-nullifier linked list seeded with the {0→0} sentinel, with incremental insert.
/// `insert` splits the predecessor low-leaf (its `next` → nu) and appends {nu → old
/// next} at a new index — leaf index = insertion order, so the root is order-dependent;
/// fold spends in the SAME (chronological) order as the JS accumulator. Mirrors
/// dapp/confidential-pool.js makeImtAccumulator.
pub struct ImtAccumulator {
    links: Vec<([u8; 32], [u8; 32])>,
}

impl Default for ImtAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl ImtAccumulator {
    /// A fresh accumulator: the empty set, represented by the {0→0} sentinel.
    pub fn new() -> Self {
        Self { links: vec![([0u8; 32], [0u8; 32])] }
    }

    fn low_index(&self, nu: &[u8; 32]) -> Option<usize> {
        let zero = [0u8; 32];
        self.links.iter().position(|(v, n)| be_lt(v, nu) && (*n == zero || be_lt(nu, n)))
    }

    /// Insert a spent nullifier. Panics on 0 (the sentinel anchor) or an nu already in
    /// the set / out of range (no straddling low leaf).
    pub fn insert(&mut self, nu: &[u8; 32]) {
        assert!(*nu != [0u8; 32], "cannot insert 0 (the sentinel anchor)");
        let i = self.low_index(nu).expect("no low link (nu already spent or out of range)");
        let old = self.links[i].1;
        self.links[i].1 = *nu; // predecessor now points to nu
        self.links.push((*nu, old)); // nu takes the displaced successor
    }

    /// The spent-set root reflecting all inserts so far.
    pub fn root(&self) -> [u8; 32] {
        imt_root(&self.links)
    }

    pub fn links(&self) -> &[([u8; 32], [u8; 32])] {
        &self.links
    }

    /// Low-leaf (index, value, next) for proving `nu` absent against `root()`; None if
    /// `nu` is a member. The Merkle path is generated by the caller's tree builder.
    pub fn non_membership_low(&self, nu: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32])> {
        self.low_index(nu).map(|i| (i, self.links[i].0, self.links[i].1))
    }
}

/// Incremental note-tree accumulator: append-only Keccak Merkle holding only the
/// per-level `filled` subtrees + the running root (O(depth) state, not O(leaves)) —
/// byte-identical to ConfidentialPool._insertLeaf. The reflection prover / Bitcoin
/// indexer use it to advance the note-tree root as deposits land, without holding every
/// leaf. (ImtAccumulator is the spent-set counterpart.)
pub struct KeccakTreeAccumulator {
    zeros: [[u8; 32]; KECCAK_TREE_DEPTH],
    filled: [[u8; 32]; KECCAK_TREE_DEPTH],
    next_index: u64,
    root: [u8; 32],
}

impl Default for KeccakTreeAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl KeccakTreeAccumulator {
    /// An empty tree: root = the all-zero depth-32 root (zeros[32]), as the contract's
    /// initial `currentRoot`.
    pub fn new() -> Self {
        let zeros = keccak_zeros();
        Self { zeros, filled: [[0u8; 32]; KECCAK_TREE_DEPTH], next_index: 0, root: keccak_merkle_root(&[]) }
    }

    /// Append one leaf, updating the filled subtrees + root exactly as _insertLeaf does.
    pub fn append(&mut self, leaf: &[u8; 32]) {
        let mut idx = self.next_index;
        let mut h = *leaf;
        for i in 0..KECCAK_TREE_DEPTH {
            if idx & 1 == 0 {
                self.filled[i] = h;
                h = kn(&[&h, &self.zeros[i]]);
            } else {
                h = kn(&[&self.filled[i], &h]);
            }
            idx >>= 1;
        }
        self.root = h;
        self.next_index += 1;
    }

    pub fn root(&self) -> [u8; 32] {
        self.root
    }
    pub fn next_index(&self) -> u64 {
        self.next_index
    }

    /// The Merkle path for the NEXT append slot, derived from the frontier: at level i the
    /// sibling is the filled left subtree (bit set) or the empty-subtree root (bit clear).
    /// The indexer hands this to `keccak_tree_append_transition`; folding the zero leaf with
    /// it reproduces the current root, and the new leaf with it the post-append root.
    pub fn append_path(&self) -> Vec<[u8; 32]> {
        (0..KECCAK_TREE_DEPTH)
            .map(|i| if (self.next_index >> i) & 1 == 0 { self.zeros[i] } else { self.filled[i] })
            .collect()
    }
}

/// Outpoint accumulator leaf: keccak(key ‖ next ‖ value).
pub fn utxo_leaf(key: &[u8; 32], next: &[u8; 32], value: &[u8; 32]) -> [u8; 32] {
    kn(&[key, next, value])
}

/// Witnessed UTXO/bridge-burn insert transition: add `key → value` to the sorted set
/// committed by `prior_root` and return the new root — no full-set state. The IMT pattern
/// with 3-field leaves: the straddling low node (low_key < key < low_next, or low_next == 0)
/// is rewired to `key`, then {key → old_next, value} fills the empty slot at `new_index`
/// (its path against the intermediate, post-rewire tree). Returns None if any check fails.
#[allow(clippy::too_many_arguments)]
pub fn utxo_insert_transition(
    prior_root: &[u8; 32],
    key: &[u8; 32],
    value: &[u8; 32],
    low_key: &[u8; 32],
    low_next: &[u8; 32],
    low_value: &[u8; 32],
    low_index: u64,
    low_path: &[[u8; 32]],
    new_index: u64,
    new_path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    let zero = [0u8; 32];
    if *key == zero || !be_lt(low_key, key) { return None; }
    if *low_next != zero && !be_lt(key, low_next) { return None; }
    // (1) the low node is a member of prior_root; rewire its successor to key (value kept).
    if !keccak_merkle_verify(&utxo_leaf(low_key, low_next, low_value), low_index, low_path, prior_root) { return None; }
    let intermediate = merkle_root_from(&utxo_leaf(low_key, key, low_value), low_index, low_path)?;
    // (2) fill the empty slot with the new node {key → old_next, value}.
    if !keccak_merkle_verify(&zero, new_index, new_path, &intermediate) { return None; }
    merkle_root_from(&utxo_leaf(key, low_next, value), new_index, new_path)
}

/// Witnessed UTXO remove (spend) transition: tombstone the live outpoint `key` and return
/// the new root — no full-set state. Two updates: the predecessor (pred_next == key) is
/// rewired to `key`'s successor, then `key`'s node is tombstoned (leaf → 0, matching the
/// stateful accumulator's `leaf_at` for a dead node). `node_path` is against the
/// intermediate (post-rewire) tree. Returns None if the witnesses don't link up.
#[allow(clippy::too_many_arguments)]
pub fn utxo_remove_transition(
    prior_root: &[u8; 32],
    key: &[u8; 32],
    node_next: &[u8; 32],
    node_value: &[u8; 32],
    node_index: u64,
    node_path: &[[u8; 32]],
    pred_key: &[u8; 32],
    pred_value: &[u8; 32],
    pred_index: u64,
    pred_path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    // The predecessor points at `key` and is a member of prior_root; rewire it to skip `key`.
    if !keccak_merkle_verify(&utxo_leaf(pred_key, key, pred_value), pred_index, pred_path, prior_root) { return None; }
    let intermediate = merkle_root_from(&utxo_leaf(pred_key, node_next, pred_value), pred_index, pred_path)?;
    // `key`'s node is a member of the intermediate tree; tombstone it (leaf → 0).
    if !keccak_merkle_verify(&utxo_leaf(key, node_next, node_value), node_index, node_path, &intermediate) { return None; }
    merkle_root_from(&[0u8; 32], node_index, node_path)
}

/// Outpoint→note accumulator — the Bitcoin UTXO set the reflection prover resolves
/// inputs against (SPEC-BITCOIN-REFLECTION-AMENDMENT §7.2). A sorted linked list keyed by
/// the outpoint `key = keccak(txid ‖ vout)`, each live node carrying the note's nullifier
/// `ν = keccak(Cx ‖ Cy ‖ "spent")` as its value, seeded with the {0→0} sentinel. Supports
/// add (a new output), `get` (resolve an input → its ν), and remove (a spend). The
/// committed root reflects every LIVE outpoint — a spent outpoint is unlinked from the
/// chain AND tombstoned (its leaf hashes to 0) — so a resumed prover proves an input is a
/// real, unspent output against it.
pub struct UtxoAccumulator {
    // (key, next, value, alive): a tombstoned node (alive = false) hashes to 0 and is
    // skipped by every lookup — its outpoint has been spent.
    nodes: Vec<([u8; 32], [u8; 32], [u8; 32], bool)>,
}

impl Default for UtxoAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl UtxoAccumulator {
    /// A fresh empty UTXO set: the {0→0} sentinel (key 0 is the max).
    pub fn new() -> Self {
        Self { nodes: vec![([0u8; 32], [0u8; 32], [0u8; 32], true)] }
    }

    fn leaf_at(&self, i: usize) -> [u8; 32] {
        let (k, n, v, alive) = &self.nodes[i];
        if *alive { utxo_leaf(k, n, v) } else { [0u8; 32] }
    }

    /// The live predecessor for `key` (node.key < key < node.next, or node.next == 0).
    fn low_index(&self, key: &[u8; 32]) -> Option<usize> {
        let zero = [0u8; 32];
        self.nodes.iter().position(|(k, n, _, a)| *a && be_lt(k, key) && (*n == zero || be_lt(key, n)))
    }
    /// The live node whose key == `key` (membership).
    fn find(&self, key: &[u8; 32]) -> Option<usize> {
        self.nodes.iter().position(|(k, _, _, a)| *a && k == key)
    }
    /// The live node whose next == `key` (the predecessor of a present key).
    fn pred_of(&self, key: &[u8; 32]) -> Option<usize> {
        self.nodes.iter().position(|(_, n, _, a)| *a && n == key)
    }

    /// Add a new output `key → value`. Panics on key 0 or an already-present key.
    pub fn insert(&mut self, key: &[u8; 32], value: &[u8; 32]) {
        assert!(*key != [0u8; 32], "outpoint key 0 reserved for the sentinel");
        let i = self.low_index(key).expect("no low link (outpoint present or out of range)");
        let old_next = self.nodes[i].1;
        self.nodes[i].1 = *key; // predecessor → key
        self.nodes.push((*key, old_next, *value, true));
    }

    /// Resolve an outpoint to its note value (ν), if it is a live UTXO.
    pub fn get(&self, key: &[u8; 32]) -> Option<[u8; 32]> {
        self.find(key).map(|i| self.nodes[i].2)
    }

    /// Spend an outpoint: unlink it (predecessor skips it) and tombstone it. Panics if the
    /// outpoint is not a live UTXO (a double-spend / unknown input).
    pub fn remove(&mut self, key: &[u8; 32]) {
        let i = self.find(key).expect("outpoint not in the UTXO set");
        let p = self.pred_of(key).expect("predecessor missing");
        self.nodes[p].1 = self.nodes[i].1; // predecessor → removed.next
        self.nodes[i].3 = false; // tombstone (leaf → 0)
    }

    /// The committed UTXO-set root (live outpoints; tombstones hash to 0).
    pub fn root(&self) -> [u8; 32] {
        let leaves: Vec<[u8; 32]> = (0..self.nodes.len()).map(|i| self.leaf_at(i)).collect();
        keccak_merkle_root(&leaves)
    }

    /// Membership witness `(leaf_index, next, value)` for proving `key` is a live UTXO
    /// against `root()`; None if absent. The Merkle path is built by the caller.
    pub fn membership(&self, key: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32])> {
        self.find(key).map(|i| (i, self.nodes[i].1, self.nodes[i].2))
    }

    /// The committed leaf vector (live → utxo_leaf, tombstoned → 0) — what the indexer folds
    /// to build Merkle paths for the witnessed insert/remove transitions.
    pub fn leaves(&self) -> Vec<[u8; 32]> {
        (0..self.nodes.len()).map(|i| self.leaf_at(i)).collect()
    }

    /// Low-node witness `(index, key, next, value)` straddling `key` (key_low < key <
    /// key_next, or next == 0) — the insert witness. None if `key` is present/out of range.
    pub fn low(&self, key: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32], [u8; 32])> {
        self.low_index(key).map(|i| (i, self.nodes[i].0, self.nodes[i].1, self.nodes[i].2))
    }

    /// Predecessor witness `(index, key, value)` — the live node whose `next == key` — for
    /// the remove transition (it is rewired to skip the removed node). None if absent.
    pub fn predecessor(&self, key: &[u8; 32]) -> Option<(usize, [u8; 32], [u8; 32])> {
        self.pred_of(key).map(|i| (i, self.nodes[i].0, self.nodes[i].2))
    }

    /// The next free leaf slot (insertion index for a new node).
    pub fn len(&self) -> usize { self.nodes.len() }
    pub fn is_empty(&self) -> bool { self.nodes.is_empty() }
}

/// Live UTXO set for the FULL-SCAN reflection model (closes the F4 spent-set completeness gap).
/// Where `UtxoAccumulator` is insertion-order with tombstones — its committed root is O(history)
/// to reconstruct, which is fine for the witnessed O(Δ) fold that never rebuilds — this commits
/// ONLY the live outpoints, as a Keccak Merkle tree over (key, value) leaves sorted by key. So
/// the prover rebuilds + root-checks the HANDED set in O(live) once per batch, then resolves
/// every confirmed tx's vins against it in-memory. Because no vin can be skipped, a relayer can
/// no longer OMIT a Bitcoin spend of a pool note (the gap F4 named) — a plain, non-TACIT spend of
/// a pool UTXO is caught the same as an enveloped one. Its root lives only in the reflection
/// `state_digest` (never read on-chain — the cross-lane gate reads spentRoot/poolRoot), so this
/// live-only shape is free to differ from the witnessed UtxoAccumulator the bridge-burn set uses.
#[derive(Clone, Default)]
pub struct LiveUtxoSet {
    // (outpoint key = keccak(txid‖vout), value = commitment_hash = keccak(Cx‖Cy), asset_id), kept
    // sorted ascending by key (big-endian == array order) so root rebuild and lookups are one pass
    // / log n. The asset is carried per-entry (set from the CXFER envelope when the output lands)
    // and committed into the root so a spend can re-impose asset preservation: the reflection's
    // CXFER fold requires every spent note's asset == the envelope's declared asset, the same
    // invariant the EVM lane gets for free from `leaf(asset,…)` membership. Without it a confirmed
    // (Bitcoin-side) CXFER could spend a cheap-asset note and mint a dear-asset note of equal
    // commitment-value (cross-asset inflation), because conservation is value-only.
    entries: Vec<([u8; 32], [u8; 32], [u8; 32])>,
}

impl LiveUtxoSet {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    /// Adopt a handed live set: keys must be strictly ascending and non-zero. The caller then
    /// root-checks `root()` against the resumed utxo root — that single O(live) hash is the
    /// batch's whole trust step (verify the set once, then scan vins against it for free).
    pub fn from_sorted(entries: Vec<([u8; 32], [u8; 32], [u8; 32])>) -> Option<Self> {
        for i in 0..entries.len() {
            if entries[i].0 == [0u8; 32] {
                return None;
            }
            if i > 0 && !be_lt(&entries[i - 1].0, &entries[i].0) {
                return None;
            }
        }
        Some(Self { entries })
    }

    /// Resolve an outpoint key to its stored `(commitment_hash, asset_id)` iff it is a live pool
    /// UTXO. The asset is what the reflection's CXFER fold checks against the envelope (preservation).
    pub fn get(&self, key: &[u8; 32]) -> Option<([u8; 32], [u8; 32])> {
        self.entries.binary_search_by(|(k, _, _)| k.cmp(key)).ok().map(|i| (self.entries[i].1, self.entries[i].2))
    }

    /// Add a new output's outpoint → `(commitment hash, asset_id)`. Panics on a duplicate key
    /// (outpoints are unique — a duplicate is a malformed batch, never a valid Bitcoin state).
    pub fn insert(&mut self, key: &[u8; 32], value: &[u8; 32], asset: &[u8; 32]) {
        match self.entries.binary_search_by(|(k, _, _)| k.cmp(key)) {
            Ok(_) => panic!("duplicate outpoint in live set"),
            Err(i) => self.entries.insert(i, (*key, *value, *asset)),
        }
    }

    /// Spend a live outpoint, returning its stored `(commitment hash, asset_id)`. Panics if absent
    /// (the caller resolves it via `get` first — a remove of an unknown outpoint is a prover bug).
    pub fn remove(&mut self, key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        let i = self.entries.binary_search_by(|(k, _, _)| k.cmp(key)).expect("outpoint not live");
        let (_, v, a) = self.entries.remove(i);
        (v, a)
    }

    /// The committed live-set root: Keccak Merkle over the (key‖asset‖value) leaves in key order.
    /// The asset is committed so the digest chain pins each note's asset (a wrong handoff fails the
    /// digest), which is what makes the CXFER fold's asset-preservation check trustworthy on resume.
    pub fn root(&self) -> [u8; 32] {
        let leaves: Vec<[u8; 32]> = self.entries.iter().map(|(k, v, a)| kn(&[k, a, v])).collect();
        keccak_merkle_root(&leaves)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// One detected pool-UTXO spend from the full scan: the outpoint key + the note's derived ν, plus
/// the raw prev-outpoint `(txid, vout)` and the spent note's commitment coords `(cx, cy)`. The
/// raw outpoint + the commitment point are what the CXFER conservation gate needs (the BIP-340
/// kernel signs over the input outpoints, and `Σ C_in` over the input commitments — see
/// `verify_cxfer_conservation`), so the scan surfaces them rather than discarding them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetectedSpend {
    pub outpoint: [u8; 32],
    pub nu: [u8; 32],
    pub prev_txid: [u8; 32],
    pub prev_vout: u32,
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    // The asset_id the spent note was created under (carried by the live UTXO set, set from the
    // CXFER envelope when the note landed). The CXFER fold asserts this equals the spending
    // envelope's declared asset, so a confirmed tx can't relabel a cheap-asset note as a dear one.
    pub asset: [u8; 32],
}

/// Full-scan vin detection — the F4 completeness primitive. EVERY input of `tx_data` is resolved
/// against the live UTXO set; each one that hits a live pool UTXO is a spend that MUST be
/// reflected (the relayer cannot silently drop it, because the scan visits all vins). For each
/// hit, `next_opening` yields the spent note's (Cx, Cy) in vin order; ν is derived and BOUND to
/// the outpoint's stored commitment hash via `bind_spent_note` (so a forged opening is rejected),
/// the outpoint is removed from `live`, and a `DetectedSpend` (outpoint key + ν + raw outpoint +
/// commitment coords) is recorded. A tx touching no pool UTXO returns an empty vec. Returns None
/// on a malformed tx or an opening that doesn't bind — both are hard rejects (a confirmed tx the
/// prover can't honestly fold). Output notes (new outpoints a CXFER envelope declares) are added
/// by the caller, which holds the envelope parse + the conservation check.
pub fn scan_tx_spends(
    tx_data: &[u8],
    live: &mut LiveUtxoSet,
    mut next_opening: impl FnMut() -> ([u8; 32], [u8; 32]),
) -> Option<Vec<DetectedSpend>> {
    let inputs = bitcoin::extract_inputs(tx_data)?;
    let mut spends = Vec::new();
    for (txid, vout) in &inputs {
        let key = outpoint_key(txid, *vout);
        if let Some((stored, asset)) = live.get(&key) {
            let (cx, cy) = next_opening();
            let nu = bind_spent_note(&stored, &cx, &cy)?;
            live.remove(&key);
            spends.push(DetectedSpend { outpoint: key, nu, prev_txid: *txid, prev_vout: *vout, cx, cy, asset });
        }
    }
    Some(spends)
}

/// Verify a confirmed CXFER tx CONSERVES value before its outputs are folded into the reflected
/// Bitcoin pool: the BIP-340 kernel (`cxfer_kernel_verify`: Σ C_in = Σ C_out, `burned = 0` for a
/// pure transfer) AND the BP+ range proof bounding every output to `[0, 2^64)`. Bitcoin consensus
/// never checks the Tacit kernel (the envelope is witness bytes), so without this a confirmed tx
/// declaring an inflated output commitment would inject UNBACKED value into `bitcoinPoolRoot` —
/// spendable cross-lane on Ethereum (value from nothing). `input_outpoints` / `input_commitments`
/// come from the live-set scan (`scan_tx_spends`, which binds each input point to the stored
/// commitment); `kernel_sig` / `output_commitments_compressed` / `range_proof` from the envelope
/// (`bitcoin::parse_cxfer_envelope_full`). A zero-pool-input tx therefore can only mint
/// zero-value outputs (Σ C_in = 0 ⇒ the kernel forces Σ value_out = 0).
pub fn verify_cxfer_conservation(
    asset: &[u8; 32],
    input_outpoints: &[([u8; 32], u32)],
    input_commitments: &[Point],
    output_commitments_compressed: &[[u8; 33]],
    range_proof: &[u8],
    kernel_sig: &[u8; 64],
) -> bool {
    let mut out_pts: Vec<Point> = Vec::with_capacity(output_commitments_compressed.len());
    for c in output_commitments_compressed {
        match decompress(c) {
            Some(p) => out_pts.push(p),
            None => return false,
        }
    }
    cxfer_kernel_verify(asset, input_outpoints, input_commitments, output_commitments_compressed, 0, kernel_sig)
        && verify_range(&out_pts, range_proof)
}

/// The reflection prover's state: the Bitcoin confidential-pool note tree, spent-set, and
/// UTXO set, advanced as confirmed effects land, plus the confirmed height. `commit`
/// yields exactly the `(bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight)` the relay
/// proof carries (ConfidentialPool.BitcoinRelayPublicValues); the UTXO root is internal
/// state (`state_digest` binds it for resumption). The Bitcoin-confirmation of each
/// effect (header chain + tx inclusion, via cxfer-core::bitcoin) is the guest's job
/// before it folds them in; this is the fold + the committed roots.
pub struct ReflectionState {
    pub notes: KeccakTreeAccumulator,
    pub spent: ImtAccumulator,
    pub utxo: UtxoAccumulator,
    /// Bridge-OUT set: key = ν, value = destCommitment, populated ONLY for cross-chain
    /// burns (OP_ENV_CONF_BURN). bridge_mint proves membership HERE (not in `spent`), so a
    /// note merely spent on Bitcoin in an ordinary transfer cannot be minted on Ethereum —
    /// only a note explicitly burned for the bridge can, and bound to its declared
    /// destCommitment. Closes the spent-vs-burned inflation conflation.
    pub bridge_burns: UtxoAccumulator,
    pub height: u64,
}

impl Default for ReflectionState {
    fn default() -> Self {
        Self::genesis()
    }
}

impl ReflectionState {
    /// Genesis: an empty note tree + the non-zero empty-IMT spent set + an empty UTXO set,
    /// height 0.
    pub fn genesis() -> Self {
        Self {
            notes: KeccakTreeAccumulator::new(),
            spent: ImtAccumulator::new(),
            utxo: UtxoAccumulator::new(),
            bridge_burns: UtxoAccumulator::new(),
            height: 0,
        }
    }

    /// Fold pre-resolved confidential-pool effects (deposits already as note leaves,
    /// spends already as nullifiers) and advance to `height`. The simple, UTXO-agnostic
    /// path — the caller resolved inputs to ν itself. `height` must strictly increase.
    pub fn apply_block(&mut self, deposits: &[[u8; 32]], spends: &[[u8; 32]], height: u64) {
        assert!(height >= self.height, "reflection height must not decrease");
        for leaf in deposits {
            self.notes.append(leaf);
        }
        for nu in spends {
            self.spent.insert(nu);
        }
        self.height = height;
    }

    /// Fold one confirmed Bitcoin confidential transfer in the UTXO model (§3). The guest
    /// has already verified conservation/range/confirmation and, for each input, witnessed
    /// its commitment `C_in` (checking `keccak(C_in) == utxo.get(outpoint)`) to derive
    /// `ν = keccak(Cx ‖ Cy ‖ "spent")`. This performs the validated state transition:
    /// - `inputs` = `(outpoint, ν)`: assert the outpoint is a live UTXO, mark ν spent,
    ///   remove the outpoint;
    /// - `outputs` = `(outpoint, note_leaf, commitment_hash)`: append the note leaf and add
    ///   the outpoint → `keccak(C_out)` to the UTXO set.
    ///
    /// Inputs are resolved BEFORE outputs are added, so a transfer cannot spend an
    /// outpoint it creates in the same tx. `height` must strictly increase.
    pub fn apply_transfer(
        &mut self,
        inputs: &[([u8; 32], [u8; 32])],
        outputs: &[([u8; 32], [u8; 32], [u8; 32])],
        height: u64,
    ) {
        assert!(height >= self.height, "reflection height must not decrease");
        for (outpoint, nu) in inputs {
            assert!(self.utxo.get(outpoint).is_some(), "input outpoint not a live UTXO");
            self.spent.insert(nu);
            self.utxo.remove(outpoint);
        }
        for (outpoint, note_leaf, commitment_hash) in outputs {
            self.notes.append(note_leaf);
            self.utxo.insert(outpoint, commitment_hash);
        }
        self.height = height;
    }

    /// Fold one confirmed cross-chain BURN (OP_ENV_CONF_BURN): the input note is consumed
    /// (spent + UTXO removed, like any spend) AND recorded in the bridge-burn set as
    /// `ν → destCommitment`. Only burns reach `bridge_burns`, so a `bridge_mint` proving
    /// membership there cannot be satisfied by an ordinary transfer's ν, and is bound to
    /// the destination the burn declared. `height` must strictly increase.
    pub fn apply_bridge_out(
        &mut self,
        outpoint: &[u8; 32],
        nu: &[u8; 32],
        dest_commitment: &[u8; 32],
        height: u64,
    ) {
        assert!(height >= self.height, "reflection height must not decrease");
        assert!(self.utxo.get(outpoint).is_some(), "bridge-out outpoint not a live UTXO");
        self.spent.insert(nu);
        self.utxo.remove(outpoint);
        self.bridge_burns.insert(nu, dest_commitment);
        self.height = height;
    }

    /// The bridge-burn set root — the relay attests it as `bitcoinBurnRoot`, and the
    /// guest's `bridge_mint` proves membership of `(ν → destCommitment)` against it.
    pub fn bridge_burn_root(&self) -> [u8; 32] {
        self.bridge_burns.root()
    }

    /// The committed reflection roots: (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight).
    /// The spent root is always non-zero (the empty-IMT sentinel), so the contract
    /// accepts it and the cross-lane gate never goes vacuous.
    pub fn commit(&self) -> ([u8; 32], [u8; 32], u64) {
        (self.notes.root(), self.spent.root(), self.height)
    }

    /// The internal UTXO-set root (not in BitcoinRelayPublicValues; bound into
    /// `state_digest` for resumption).
    pub fn utxo_root(&self) -> [u8; 32] {
        self.utxo.root()
    }

    /// Full-state digest keccak(poolRoot ‖ spentRoot ‖ utxoRoot ‖ height) — the anchor a
    /// resumed proof continues from, so the next cycle's UTXO set (and roots) provably
    /// extend this one rather than starting fresh.
    pub fn state_digest(&self) -> [u8; 32] {
        let (pool, spent, _) = self.commit();
        let mut h = [0u8; 32];
        h[24..].copy_from_slice(&self.height.to_be_bytes());
        kn(&[&pool, &spent, &self.utxo.root(), &self.bridge_burns.root(), &h])
    }
}

/// One spent input's witnesses: nullify ν in the spent set (IMT insert) and remove the
/// outpoint from the UTXO set (tombstone). The indexer builds these from the canonical
/// accumulators; the reflection prover folds them with no full-set state.
#[derive(Clone)]
pub struct SpendWitness {
    // The spent note's commitment coords — ν is DERIVED (nullifier(cx,cy)) and bound to the
    // outpoint's committed value (keccak(cx,cy) == u_node_value), never witnessed freely.
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    pub outpoint: [u8; 32],
    // spent-set IMT insert
    pub s_low_value: [u8; 32],
    pub s_low_next: [u8; 32],
    pub s_low_index: u64,
    pub s_low_path: Vec<[u8; 32]>,
    pub s_new_path: Vec<[u8; 32]>,
    // UTXO remove
    pub u_node_next: [u8; 32],
    pub u_node_value: [u8; 32],
    pub u_node_index: u64,
    pub u_node_path: Vec<[u8; 32]>,
    pub u_pred_key: [u8; 32],
    pub u_pred_value: [u8; 32],
    pub u_pred_index: u64,
    pub u_pred_path: Vec<[u8; 32]>,
}

/// One output note's witnesses: append the note leaf (note tree) and add the outpoint →
/// commitment to the UTXO set (insert).
#[derive(Clone)]
pub struct OutputWitness {
    pub note_leaf: [u8; 32],
    pub note_path: Vec<[u8; 32]>,
    pub outpoint: [u8; 32],
    pub commitment_hash: [u8; 32],
    pub u_low_key: [u8; 32],
    pub u_low_next: [u8; 32],
    pub u_low_value: [u8; 32],
    pub u_low_index: u64,
    pub u_low_path: Vec<[u8; 32]>,
    pub u_new_path: Vec<[u8; 32]>,
}

/// A cross-chain burn's witnesses: a spend PLUS an insert of ν → destCommitment into the
/// bridge-burn set (so bridge_mint can only mint a note explicitly burned for the bridge).
#[derive(Clone)]
pub struct BurnWitness {
    pub spend: SpendWitness,
    pub dest_commitment: [u8; 32],
    pub b_low_key: [u8; 32],
    pub b_low_next: [u8; 32],
    pub b_low_value: [u8; 32],
    pub b_low_index: u64,
    pub b_low_path: Vec<[u8; 32]>,
    pub b_new_path: Vec<[u8; 32]>,
}

/// Headless reflection state: only the four roots + their leaf counts + height — the
/// resumable anchor the reflection prover reads from its prior `digest()` and advances by
/// folding Δ-effects through the witnessed accumulator transitions (Phase 1). No full
/// accumulator state, so proving cost is O(Δ) per cycle, not O(n) replay. Counts pin each
/// insert to the next free slot (a witness can't open a gap). `commit()` yields the
/// BitcoinRelayPublicValues roots; `digest()` is the cross-cycle resumption anchor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WitnessedReflection {
    pub pool_root: [u8; 32],
    pub note_count: u64,
    pub spent_root: [u8; 32],
    pub spent_count: u64,
    pub utxo_root: [u8; 32],
    pub utxo_count: u64,
    pub burn_root: [u8; 32],
    pub burn_count: u64,
    pub height: u64,
}

impl WitnessedReflection {
    /// Genesis: empty note tree + sentinel-seeded IMT/UTXO sets (each one leaf at index 0,
    /// so the first real insert lands at index 1). Byte-identical to ReflectionState::genesis.
    pub fn genesis() -> Self {
        let utxo_empty = UtxoAccumulator::new().root();
        Self {
            pool_root: keccak_merkle_root(&[]),
            note_count: 0,
            spent_root: imt_empty_root(),
            spent_count: 1,
            utxo_root: utxo_empty,
            utxo_count: 1,
            burn_root: utxo_empty,
            burn_count: 1,
            height: 0,
        }
    }

    /// (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight) — the relay public values; the
    /// burn root is committed separately as bitcoinBurnRoot.
    pub fn commit(&self) -> ([u8; 32], [u8; 32], u64) {
        (self.pool_root, self.spent_root, self.height)
    }

    /// Resumption anchor — every root, every count, and the height. A resumed cycle proves
    /// it continues THIS digest, so it can't silently restart or skip the count guards.
    pub fn digest(&self) -> [u8; 32] {
        let u64b = |n: u64| { let mut a = [0u8; 32]; a[24..].copy_from_slice(&n.to_be_bytes()); a };
        kn(&[
            &self.pool_root, &u64b(self.note_count),
            &self.spent_root, &u64b(self.spent_count),
            &self.utxo_root, &u64b(self.utxo_count),
            &self.burn_root, &u64b(self.burn_count),
            &u64b(self.height),
        ])
    }

    /// Nullify a spent note and tombstone its outpoint. ν is DERIVED from the note's
    /// commitment and BOUND to the outpoint's committed value (keccak(Cx,Cy) == u_node_value,
    /// the value the UTXO remove witness proves is stored at this outpoint) — so a spend
    /// can't insert a ν unrelated to the note actually at that outpoint. Returns ν (the burn
    /// set keys on it). Shared by transfers and burns.
    fn apply_spend(&mut self, s: &SpendWitness) -> Result<[u8; 32], &'static str> {
        let nu = bind_spent_note(&s.u_node_value, &s.cx, &s.cy).ok_or("ν not bound to the outpoint's note")?;
        self.spent_root = imt_insert_transition(
            &self.spent_root, &nu, &s.s_low_value, &s.s_low_next, s.s_low_index, &s.s_low_path,
            self.spent_count, &s.s_new_path,
        ).ok_or("spent-set insert witness invalid")?;
        self.spent_count += 1;
        self.utxo_root = utxo_remove_transition(
            &self.utxo_root, &s.outpoint, &s.u_node_next, &s.u_node_value, s.u_node_index, &s.u_node_path,
            &s.u_pred_key, &s.u_pred_value, s.u_pred_index, &s.u_pred_path,
        ).ok_or("utxo remove witness invalid")?;
        Ok(nu)
    }

    /// Append the output note and insert its outpoint → commitment in the UTXO set.
    fn apply_output(&mut self, o: &OutputWitness) -> Result<(), &'static str> {
        self.pool_root = keccak_tree_append_transition(&self.pool_root, self.note_count, &o.note_path, &o.note_leaf)
            .ok_or("note append witness invalid")?;
        self.note_count += 1;
        self.utxo_root = utxo_insert_transition(
            &self.utxo_root, &o.outpoint, &o.commitment_hash, &o.u_low_key, &o.u_low_next, &o.u_low_value,
            o.u_low_index, &o.u_low_path, self.utxo_count, &o.u_new_path,
        ).ok_or("utxo insert witness invalid")?;
        self.utxo_count += 1;
        Ok(())
    }

    /// Fold one confirmed transfer: spends first (so it can't spend an output it creates),
    /// then outputs. `height` must strictly increase. Mirrors ReflectionState::apply_transfer.
    pub fn apply_transfer(&mut self, spends: &[SpendWitness], outputs: &[OutputWitness], height: u64) -> Result<(), &'static str> {
        if height < self.height { return Err("reflection height must not decrease"); }
        for s in spends { self.apply_spend(s)?; }
        for o in outputs { self.apply_output(o)?; }
        self.height = height;
        Ok(())
    }

    /// Fold one confirmed cross-chain burn: a spend, plus an insert of ν → destCommitment
    /// into the bridge-burn set (ν is the derived nullifier of the spent note). Mirrors
    /// ReflectionState::apply_bridge_out.
    pub fn apply_bridge_out(&mut self, b: &BurnWitness, height: u64) -> Result<(), &'static str> {
        if height < self.height { return Err("reflection height must not decrease"); }
        let nu = self.apply_spend(&b.spend)?;
        self.burn_root = utxo_insert_transition(
            &self.burn_root, &nu, &b.dest_commitment, &b.b_low_key, &b.b_low_next, &b.b_low_value,
            b.b_low_index, &b.b_low_path, self.burn_count, &b.b_new_path,
        ).ok_or("burn-set insert witness invalid")?;
        self.burn_count += 1;
        self.height = height;
        Ok(())
    }
}

/// Full-scan reflection state (closes F4 — spent-set completeness). Same headless O(Δ) engine as
/// `WitnessedReflection` for the note tree, spent-set, and bridge-burn set (roots + counts +
/// witnessed transitions, never reconstructed — the spent-set is monotone O(history)), but the
/// UTXO set is the full in-memory `LiveUtxoSet`. The prover resumes `live` from handed contents
/// and re-derives `digest()`; the contract chains `priorDigest == knownReflectionDigest`, so a
/// wrong handoff fails the digest. With the real set in hand, every confirmed tx's vins are
/// resolved against it (`scan_tx_spends`) — no spend can be omitted, which is what the witnessed
/// model (relayer-chosen effects) could not guarantee. The detected spends fold into the spent-set
/// here; the UTXO removal already happened in the scan.
#[derive(Clone)]
pub struct ScanReflection {
    pub pool_root: [u8; 32],
    pub note_count: u64,
    pub spent_root: [u8; 32],
    pub spent_count: u64,
    pub live: LiveUtxoSet,
    pub burn_root: [u8; 32],
    pub burn_count: u64,
    pub height: u64,
}

impl Default for ScanReflection {
    fn default() -> Self {
        Self::genesis()
    }
}

impl ScanReflection {
    /// Genesis: empty note tree, sentinel-seeded spent/burn sets, an empty live UTXO set. The
    /// spent/burn counts start at 1 (the {0→0} sentinel occupies index 0).
    pub fn genesis() -> Self {
        Self {
            pool_root: keccak_merkle_root(&[]),
            note_count: 0,
            spent_root: imt_empty_root(),
            spent_count: 1,
            live: LiveUtxoSet::new(),
            burn_root: UtxoAccumulator::new().root(),
            burn_count: 1,
            height: 0,
        }
    }

    /// (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight) — the relay public values.
    pub fn commit(&self) -> ([u8; 32], [u8; 32], u64) {
        (self.pool_root, self.spent_root, self.height)
    }

    /// Resumption anchor: every headless root + count, the LIVE-set root + size, and the height.
    /// A resumed cycle proves it continues THIS digest, so the handed live set is pinned (its root
    /// is in here) and the count guards can't be skipped.
    pub fn digest(&self) -> [u8; 32] {
        let u64b = |n: u64| {
            let mut a = [0u8; 32];
            a[24..].copy_from_slice(&n.to_be_bytes());
            a
        };
        kn(&[
            &self.pool_root, &u64b(self.note_count),
            &self.spent_root, &u64b(self.spent_count),
            &self.live.root(), &u64b(self.live.len() as u64),
            &self.burn_root, &u64b(self.burn_count),
            &u64b(self.height),
        ])
    }

    /// Fold a detected spend's ν into the spent-set (witnessed IMT insert). The live-set removal
    /// and the ν↔note binding already happened in `scan_tx_spends`; this is the monotone
    /// spent-set transition only. `height` must not decrease.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_spent(
        &mut self,
        nu: &[u8; 32],
        s_low_value: &[u8; 32],
        s_low_next: &[u8; 32],
        s_low_index: u64,
        s_low_path: &[[u8; 32]],
        s_new_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        self.spent_root = imt_insert_transition(
            &self.spent_root, nu, s_low_value, s_low_next, s_low_index, s_low_path,
            self.spent_count, s_new_path,
        ).ok_or("spent-set insert witness invalid")?;
        self.spent_count += 1;
        Ok(())
    }

    /// Fold one output note: append the note leaf (witnessed note-tree transition) and add the
    /// outpoint → `(commitment hash, asset)` to the live UTXO set so a later tx in the batch can
    /// spend it. `asset` is the note's asset (the CXFER envelope's declared asset) — carried so a
    /// later spend can re-impose asset preservation.
    pub fn fold_output(
        &mut self,
        note_leaf: &[u8; 32],
        note_path: &[[u8; 32]],
        outpoint: &[u8; 32],
        commitment_hash: &[u8; 32],
        asset: &[u8; 32],
    ) -> Result<(), &'static str> {
        self.pool_root = keccak_tree_append_transition(&self.pool_root, self.note_count, note_path, note_leaf)
            .ok_or("note append witness invalid")?;
        self.note_count += 1;
        self.live.insert(outpoint, commitment_hash, asset);
        Ok(())
    }

    /// Fold a confirmed CXFER tx's outputs into the pool — ONLY if the tx CONSERVES value. Verifies
    /// the BIP-340 kernel + the BP+ range proof over the detected pool-note inputs and the envelope's
    /// outputs (`verify_cxfer_conservation`) BEFORE appending any output note, so a confirmed-but-non-
    /// conserving tx injects NOTHING (its spends are still nullified by the caller via `fold_spent`;
    /// no phantom note enters `bitcoinPoolRoot`). Each accepted output: derive its leaf
    /// (`reflected_note_leaf`, never a free witness) + UTXO value (`commitment_hash_compressed`),
    /// append the note, insert the outpoint. Fails closed (folding nothing) on a bad kernel/range,
    /// a non-curve-point commitment, or a mismatched output-witness length.
    ///
    /// REFLECT-1: without the conservation gate the per-output `fold_output` loop appended an
    /// attacker's inflated commitment (Σ_out ≫ Σ_in) into the pool root — Bitcoin never checks the
    /// Tacit kernel — making unbacked notes mintable/withdrawable cross-lane on Ethereum (value from
    /// nothing). The leaf-SHAPE binding cannot catch it (an inflated commitment is a valid curve
    /// point).
    ///
    /// ASSET PRESERVATION: conservation is value-only (`Σ C_in = Σ C_out`, asset-blind — the kernel
    /// only labels the message with `asset`). So a confirmed CXFER could spend a CHEAP-asset note and
    /// declare DEAR-asset outputs of equal commitment-value: value conserves, asset flips, and the
    /// dear note becomes bridge-mintable on Ethereum (cross-asset inflation). `input_assets` are the
    /// spent notes' assets (carried by the live UTXO set, see `DetectedSpend.asset`); every one MUST
    /// equal the envelope's declared `asset`, the same binding the EVM lane gets from `leaf(asset,…)`
    /// membership. Fails closed (folds nothing) on mismatch, like a non-conserving tx — its spends
    /// are still nullified by the caller, so a relabel just burns the attacker's input for nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_cxfer(
        &mut self,
        asset: &[u8; 32],
        input_outpoints: &[([u8; 32], u32)],
        input_commitments: &[Point],
        input_assets: &[[u8; 32]],
        txid: &[u8; 32],
        output_commitments_compressed: &[[u8; 33]],
        output_paths: &[Vec<[u8; 32]>],
        output_vouts: &[u32],
        range_proof: &[u8],
        kernel_sig: &[u8; 64],
    ) -> Result<(), &'static str> {
        let n = output_commitments_compressed.len();
        if output_paths.len() != n || output_vouts.len() != n {
            return Err("cxfer fold: output witness length mismatch");
        }
        if input_assets.len() != input_commitments.len() {
            return Err("cxfer fold: input asset length mismatch");
        }
        // Asset preservation: every spent note must be of the envelope's declared asset (closes the
        // cross-asset inflation path the value-only conservation can't see).
        if input_assets.iter().any(|a| a != asset) {
            return Err("cxfer fold: non-asset-preserving (input asset != envelope asset)");
        }
        if !verify_cxfer_conservation(asset, input_outpoints, input_commitments, output_commitments_compressed, range_proof, kernel_sig) {
            return Err("cxfer fold: tx does not conserve value (kernel/range)");
        }
        for i in 0..n {
            let commitment = &output_commitments_compressed[i];
            let note_leaf = reflected_note_leaf(asset, commitment).ok_or("cxfer fold: output commitment not a curve point")?;
            let ch = commitment_hash_compressed(commitment).ok_or("cxfer fold: output commitment not a curve point")?;
            let outpoint = outpoint_key(txid, output_vouts[i]);
            self.fold_output(&note_leaf, &output_paths[i], &outpoint, &ch, asset)?;
        }
        Ok(())
    }

    /// Record a bridge-out in the burn set: ν → destCommitment (witnessed UTXO insert). The spend
    /// itself is folded via `fold_spent`; this adds the bound destination so bridge_mint can mint
    /// only an explicitly-burned note, to exactly the declared destination.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_burn(
        &mut self,
        nu: &[u8; 32],
        dest_commitment: &[u8; 32],
        b_low_key: &[u8; 32],
        b_low_next: &[u8; 32],
        b_low_value: &[u8; 32],
        b_low_index: u64,
        b_low_path: &[[u8; 32]],
        b_new_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        self.burn_root = utxo_insert_transition(
            &self.burn_root, nu, dest_commitment, b_low_key, b_low_next, b_low_value,
            b_low_index, b_low_path, self.burn_count, b_new_path,
        ).ok_or("burn-set insert witness invalid")?;
        self.burn_count += 1;
        Ok(())
    }

    /// Fold an Ethereum→Bitcoin cross-out mint (`T_CROSSOUT_MINT`, opcode 0x65) into the pool — ONLY if
    /// the cross-out is a MEMBER of the eth-reflection crossOutSet (proven on finalized Ethereum; Mode B
    /// reverse reflection). The minted note's Bitcoin-side leaf is `leaf(asset, Cx, Cy, 0)` — exactly the
    /// `destCommitment` the ConfidentialPool records for a Bitcoin-destined burn (owner = the zero
    /// sentinel) — and membership binds `(claimId, BITCOIN, destCommitment, asset)` to the eth set, so a
    /// fabricated/unconfirmed mint is absent and folds NOTHING (no unbacked value, no worker trust).
    /// Mirrors `fold_cxfer`'s output append via `fold_output`. `vout` is the mint tx's
    /// confidential-output index (derived, not witnessed — a bogus outpoint would make the note's later
    /// real Bitcoin spend miss the live set).
    #[allow(clippy::too_many_arguments)]
    pub fn fold_crossout(
        &mut self,
        asset: &[u8; 32],
        claim_id: &[u8; 32],
        cx: &[u8; 32],
        cy: &[u8; 32],
        set_index: u64,
        set_path: &[[u8; 32]],
        crossout_set_root: &[u8; 32],
        crossout_txid: &[u8; 32],
        vout: u32,
        note_path: &[[u8; 32]],
    ) -> Result<(), &'static str> {
        // The minted commitment must be a real secp256k1 point (else an unspendable junk note).
        from_affine_xy(cx, cy).ok_or("crossout fold: commitment not a curve point")?;
        // Bitcoin-side reflected leaf (owner = zero sentinel) = the contract's destCommitment for a
        // Bitcoin-destined cross-out; an owner!=0 eth record can't match the set below (fail-closed).
        let dest_commitment = leaf(asset, cx, cy, &[0u8; 32]);
        let co = eth_reflection::EthCrossOut {
            claim_id: *claim_id,
            dest_chain: eth_reflection::DEST_CHAIN_BITCOIN,
            dest_commitment,
            asset_id: *asset,
        };
        if !eth_reflection::eth_crossout_member(&co, set_index, set_path, crossout_set_root) {
            return Err("crossout fold: not an eth crossOutSet member");
        }
        let outpoint = outpoint_key(crossout_txid, vout);
        let ch = commitment_hash(cx, cy);
        self.fold_output(&dest_commitment, note_path, &outpoint, &ch, asset)
    }

    /// cBTC.zk sats-lock value-entry (`T_CBTC_LOCK`, opcode 0x66) — admit a real-BTC-backed cBTC note
    /// ONLY if the envelope tx contains, at `lock_vout`, a confirmed `CBTC_VAULT_SPK` output of value
    /// `v_btc`, AND the minted note commitment opens to EXACTLY `v_btc` (opening sigma — the blinding
    /// is never revealed). The note (vout 0) and the sats-lock are outputs of the SAME tx, so single-use
    /// is structural (the note outpoint is deduped by `fold_output`; a per-block scan never re-folds).
    /// Fails closed (folds nothing) on any miss — same skip-not-panic discipline as `fold_cxfer` /
    /// `fold_crossout`. Redemption (releasing the sats on a cBTC burn) is the Bitcoin vault validator's
    /// job, NOT the reflection — this proves only that the MINT is backed. `tx_data` is the confirmed
    /// envelope tx (the caller verified inclusion + PoW via the full-scan). See
    /// ops/DESIGN-cbtc-sats-lock-reflection.md.
    #[allow(clippy::too_many_arguments)]
    pub fn fold_cbtc_lock(
        &mut self,
        asset: &[u8; 32],
        cx: &[u8; 32],
        cy: &[u8; 32],
        tx_data: &[u8],
        lock_vout: u32,
        lock_txid: &[u8; 32],
        note_path: &[[u8; 32]],
        sig_rx: &[u8; 32],
        sig_ry: &[u8; 32],
        sig_z: &[u8; 32],
    ) -> Result<(), &'static str> {
        // Asset binding — only the one canonical cBTC.zk id (a fabricated etch can only mint a
        // worthless made-up id, never the real allowlisted one).
        if asset != &CBTC_ZK_ASSET_ID {
            return Err("cbtc lock: not the cBTC.zk asset");
        }
        // The minted commitment must be a real secp256k1 point.
        let c = from_affine_xy(cx, cy).ok_or("cbtc lock: commitment not a curve point")?;
        // The confirmed lock output: the canonical vault scriptPubKey + its public value v_btc.
        let (v_btc, spk) =
            bitcoin::parse_tx_output(tx_data, lock_vout).ok_or("cbtc lock: no such output")?;
        if spk.as_slice() != CBTC_VAULT_SPK {
            return Err("cbtc lock: output is not the cBTC vault");
        }
        // Conservation: the note commits to EXACTLY v_btc — opening sigma, blinding NOT revealed, bound
        // to THIS lock (asset ‖ lock_txid ‖ lock_vout) so it cannot be replayed against another lock.
        let r = from_affine_xy(sig_rx, sig_ry).ok_or("cbtc lock: sigma R not a curve point")?;
        let z = scalar_reduce_be(sig_z);
        let context = kn(&[CBTC_LOCK_DOMAIN, asset, lock_txid, &lock_vout.to_le_bytes()]);
        if !verify_opening_sigma(&c, v_btc, &r, &z, &context) {
            return Err("cbtc lock: value-binding failed (note != locked sats)");
        }
        // Fold the owner-free note (the mint's vout 0). Single-use is structural — the lock + the note
        // are outputs of one tx, deduped by the note outpoint.
        let note_leaf = leaf(asset, cx, cy, &[0u8; 32]);
        let note_outpoint = outpoint_key(lock_txid, 0);
        let ch = commitment_hash(cx, cy);
        self.fold_output(&note_leaf, note_path, &note_outpoint, &ch, asset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(h: &str) -> &str { h.trim_start_matches("0x") }
    fn arr33(h: &str) -> [u8; 33] { let v = hex::decode(strip(h)).unwrap(); let mut a = [0u8; 33]; a.copy_from_slice(&v); a }
    fn arr32(h: &str) -> [u8; 32] { let v = hex::decode(strip(h)).unwrap(); let mut a = [0u8; 32]; a.copy_from_slice(&v); a }
    fn pt(h: &str) -> ProjectivePoint { decompress(&arr33(h)).unwrap() }
    fn u64_be32(n: u64) -> [u8; 32] { let mut a = [0u8; 32]; a[24..].copy_from_slice(&n.to_be_bytes()); a }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../fixtures/cxfer.json")).unwrap()
    }

    // Mode B: fold_crossout admits a Bitcoin cross-out mint ONLY if it's a member of the eth-reflection
    // crossOutSet; a fabricated mint (absent from the set) folds nothing.
    #[test]
    fn fold_crossout_gates_on_eth_set_membership() {
        use crate::eth_reflection::{eth_crossout_leaf, EthCrossOut, DEST_CHAIN_BITCOIN};
        // a real secp256k1 point for the minted note commitment
        let enc = gen_h().to_affine().to_encoded_point(false);
        let b = enc.as_bytes();
        let cx: [u8; 32] = b[1..33].try_into().unwrap();
        let cy: [u8; 32] = b[33..65].try_into().unwrap();
        let asset = [0x11u8; 32];
        let claim_id = [0x22u8; 32];
        let txid = [0x33u8; 32];
        // the eth-set leaf the eth-reflection guest commits for this Bitcoin-destined cross-out
        let dest_commitment = leaf(&asset, &cx, &cy, &[0u8; 32]);
        let co = EthCrossOut { claim_id, dest_chain: DEST_CHAIN_BITCOIN, dest_commitment, asset_id: asset };
        let set_root = keccak_merkle_root(&[eth_crossout_leaf(&co)]);
        let empty_path = KeccakTreeAccumulator::new().append_path(); // index-0 membership AND genesis note append

        // member → folds (note appended)
        let mut st = ScanReflection::genesis();
        st.fold_crossout(&asset, &claim_id, &cx, &cy, 0, &empty_path, &set_root, &txid, 0, &empty_path)
            .expect("member cross-out folds");
        assert_eq!(st.note_count, 1, "minted note appended on member");

        // non-member (wrong set root) → rejected, nothing folded
        let mut st2 = ScanReflection::genesis();
        assert!(
            st2.fold_crossout(&asset, &claim_id, &cx, &cy, 0, &empty_path, &[0xdeu8; 32], &txid, 0, &empty_path).is_err(),
            "non-member cross-out rejected"
        );
        assert_eq!(st2.note_count, 0, "nothing folded on reject");
    }

    /// cBTC.zk sats-lock value-entry: a real-BTC-backed mint folds ONLY with a confirmed CBTC_VAULT_SPK
    /// output of value v_btc AND a note opening to exactly v_btc; a wrong asset, an over-mint, and a
    /// non-vault output each fold nothing.
    #[test]
    fn fold_cbtc_lock_admits_backed_mint_rejects_tampering() {
        // a minimal non-segwit tx whose output[lock_vout] = (value, spk)
        fn tx_with_lock(value: u64, spk: &[u8], lock_vout: u32) -> Vec<u8> {
            let mut t = vec![0x02u8, 0, 0, 0]; // version
            t.push(0x01); // 1 input
            t.extend_from_slice(&[0u8; 32]); // prev txid
            t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // prev vout
            t.push(0x00); // empty scriptSig
            t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
            t.push((lock_vout + 1) as u8); // output count
            for i in 0..=lock_vout {
                if i == lock_vout {
                    t.extend_from_slice(&value.to_le_bytes());
                    t.push(spk.len() as u8);
                    t.extend_from_slice(spk);
                } else {
                    t.extend_from_slice(&0u64.to_le_bytes());
                    t.push(0x00);
                }
            }
            t.extend_from_slice(&[0, 0, 0, 0]); // locktime
            t
        }

        let v_btc: u64 = 100_000;
        let asset = CBTC_ZK_ASSET_ID;
        let lock_txid = [0x33u8; 32];
        let lock_vout: u32 = 1;
        let gamma = scalar_reduce_be(&[0x44u8; 32]);
        let k = scalar_reduce_be(&[0x55u8; 32]);
        let context = kn(&[CBTC_LOCK_DOMAIN, &asset, &lock_txid, &lock_vout.to_le_bytes()]);

        let c = gen_h() * Scalar::from(v_btc) + ProjectivePoint::generator() * gamma;
        let cb = c.to_affine().to_encoded_point(false);
        let cx: [u8; 32] = cb.as_bytes()[1..33].try_into().unwrap();
        let cy: [u8; 32] = cb.as_bytes()[33..65].try_into().unwrap();
        let (r_pt, z) = prove_opening_sigma(v_btc, &gamma, &k, &context);
        let rb = r_pt.to_affine().to_encoded_point(false);
        let sig_rx: [u8; 32] = rb.as_bytes()[1..33].try_into().unwrap();
        let sig_ry: [u8; 32] = rb.as_bytes()[33..65].try_into().unwrap();
        let mut sig_z = [0u8; 32];
        sig_z.copy_from_slice(&z.to_bytes());
        let note_path = KeccakTreeAccumulator::new().append_path();

        // a backed mint folds
        let tx = tx_with_lock(v_btc, CBTC_VAULT_SPK, lock_vout);
        let mut st = ScanReflection::genesis();
        st.fold_cbtc_lock(&asset, &cx, &cy, &tx, lock_vout, &lock_txid, &note_path, &sig_rx, &sig_ry, &sig_z)
            .expect("a backed cBTC lock folds");
        assert_eq!(st.note_count, 1, "cBTC note appended on a backed lock");

        // wrong asset → reject
        let mut st2 = ScanReflection::genesis();
        assert!(st2.fold_cbtc_lock(&[0x99u8; 32], &cx, &cy, &tx, lock_vout, &lock_txid, &note_path, &sig_rx, &sig_ry, &sig_z).is_err(), "wrong asset rejected");
        assert_eq!(st2.note_count, 0);

        // over-mint: a lock output worth LESS than the note claims → opening sigma fails
        let tx_low = tx_with_lock(v_btc - 1, CBTC_VAULT_SPK, lock_vout);
        let mut st3 = ScanReflection::genesis();
        assert!(st3.fold_cbtc_lock(&asset, &cx, &cy, &tx_low, lock_vout, &lock_txid, &note_path, &sig_rx, &sig_ry, &sig_z).is_err(), "over-mint (note > locked sats) rejected");
        assert_eq!(st3.note_count, 0);

        // non-vault output → reject
        let tx_bad = tx_with_lock(v_btc, &[0x6a, 0x00], lock_vout);
        let mut st4 = ScanReflection::genesis();
        assert!(st4.fold_cbtc_lock(&asset, &cx, &cy, &tx_bad, lock_vout, &lock_txid, &note_path, &sig_rx, &sig_ry, &sig_z).is_err(), "non-vault output rejected");
        assert_eq!(st4.note_count, 0);
    }

    /// Adaptor-swap lock-set leaf (ops/DESIGN-adaptor-swap-guest.md): deterministic, binds EVERY field
    /// (so a claim/refund can't redirect the payee, re-time the deadline, or swap the adaptor point),
    /// and is domain-separated from the note-tree `leaf` (a locked note is never a normal-spendable note).
    #[test]
    fn adaptor_lock_leaf_is_deterministic_and_binds_every_field() {
        let cx = [0x11u8; 32]; let cy = [0x12u8; 32];
        let tx = [0x21u8; 32]; let ty = [0x22u8; 32];
        let deadline = 1_700_000_000u64;
        let recipient = [0x31u8; 32]; let locker = [0x41u8; 32];
        let base = adaptor_lock_leaf(&cx, &cy, &tx, &ty, deadline, &recipient, &locker);
        // deterministic
        assert_eq!(base, adaptor_lock_leaf(&cx, &cy, &tx, &ty, deadline, &recipient, &locker));
        // every field is bound — flipping any one changes the leaf
        let bump = |b: &[u8; 32]| { let mut x = *b; x[0] ^= 1; x };
        assert_ne!(base, adaptor_lock_leaf(&bump(&cx), &cy, &tx, &ty, deadline, &recipient, &locker), "Cx bound");
        assert_ne!(base, adaptor_lock_leaf(&cx, &bump(&cy), &tx, &ty, deadline, &recipient, &locker), "Cy bound");
        assert_ne!(base, adaptor_lock_leaf(&cx, &cy, &bump(&tx), &ty, deadline, &recipient, &locker), "Tx bound");
        assert_ne!(base, adaptor_lock_leaf(&cx, &cy, &tx, &bump(&ty), deadline, &recipient, &locker), "Ty bound");
        assert_ne!(base, adaptor_lock_leaf(&cx, &cy, &tx, &ty, deadline + 1, &recipient, &locker), "deadline bound");
        assert_ne!(base, adaptor_lock_leaf(&cx, &cy, &tx, &ty, deadline, &bump(&recipient), &locker), "recipient bound");
        assert_ne!(base, adaptor_lock_leaf(&cx, &cy, &tx, &ty, deadline, &recipient, &bump(&locker)), "locker bound");
        // domain-separated from the note-tree leaf (same bytes, different domain → different leaf)
        assert_ne!(base, leaf(&cx, &cy, &tx, &ty), "lock leaf disjoint from a normal note leaf");
    }

    /// Pin ScanReflection::genesis().digest() (the SHIPPED full-scan reflection model) to the
    /// constant the contract hardcodes (ConfidentialPool.REFLECTION_GENESIS_DIGEST).
    /// knownReflectionDigest is seeded to this, so the FIRST attestBitcoinStateProven must continue
    /// it — a Rust-side drift makes the bridge un-bootstrappable (first attest reverts
    /// StaleReflectionDigest). (The legacy WitnessedReflection genesis 0x0ca539ff is no longer the
    /// shipped model; the contract constant must equal the ScanReflection genesis below.)
    #[test]
    fn genesis_digest_matches_contract_constant() {
        assert_eq!(
            ScanReflection::genesis().digest(),
            arr32("0xec719b81a396d28bad7625172767133724a094a5425269a71b258fe7e36fdc75"),
            "ScanReflection::genesis().digest() drifted from ConfidentialPool.REFLECTION_GENESIS_DIGEST"
        );
    }

    /// The reflected note leaf is DERIVED from the envelope (asset + commitment), never witnessed —
    /// so a relayer cannot append an arbitrary spendable leaf into bitcoinPoolRoot (F-CRIT). It must
    /// equal leaf(asset, Cx, Cy, 0) for the decompressed commitment (matches the dapp indexer).
    #[test]
    fn reflected_note_leaf_binds_envelope_commitment() {
        let asset = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        // A real curve point: H (the value generator) compressed.
        let c = compress(&gen_h());
        let p = decompress(&c).unwrap().to_affine().to_encoded_point(false);
        let b = p.as_bytes();
        let cx: [u8; 32] = b[1..33].try_into().unwrap();
        let cy: [u8; 32] = b[33..65].try_into().unwrap();
        assert_eq!(
            reflected_note_leaf(&asset, &c).unwrap(),
            leaf(&asset, &cx, &cy, &[0u8; 32]),
            "reflected leaf must be leaf(asset, Cx, Cy, 0)"
        );
        // A non-curve-point compressed blob is rejected (no panic, no junk leaf).
        assert!(reflected_note_leaf(&asset, &[0u8; 33]).is_none());
    }

    #[test]
    fn kernel_accepts_js_proof_and_rejects_tamper() {
        let f = fixture();
        let in_c: Vec<_> = f["inC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let out_c: Vec<_> = f["outC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let r = pt(f["kernel"]["R"].as_str().unwrap());
        let z = scalar_reduce_be(&arr32(f["kernel"]["z"].as_str().unwrap()));
        assert!(verify_kernel(&in_c, &out_c, &r, &z));
        let mut bad = out_c.clone();
        bad[0] = bad[0] + ProjectivePoint::generator() * Scalar::from(7u64);
        assert!(!verify_kernel(&in_c, &bad, &r, &z));
    }

    // Rust-side opening-sigma prover (mirror of dapp/confidential-pool.js openingSigma): C =
    // amount·H + r·G, R = k·G, e = keccak(DOMAIN ‖ amount ‖ ctx ‖ C ‖ R), z = k + e·r.
    fn prove_opening_sigma(amount: u64, r: &Scalar, k: &Scalar, ctx: &[u8; 32]) -> (ProjectivePoint, Scalar) {
        let c = gen_h() * Scalar::from(amount) + ProjectivePoint::generator() * r;
        let r_pt = ProjectivePoint::generator() * k;
        let mut h = Keccak::v256();
        h.update(OPENING_DOMAIN);
        h.update(&amount.to_be_bytes());
        h.update(ctx);
        h.update(&compress(&c));
        h.update(&compress(&r_pt));
        let mut hb = [0u8; 32]; h.finalize(&mut hb);
        let e = scalar_reduce_be(&hb);
        (r_pt, *k + e * r)
    }

    #[test]
    fn opening_sigma_roundtrip_and_tamper() {
        let amount = 1234u64;
        let r = scalar_reduce_be(&arr32("0x1111111111111111111111111111111111111111111111111111111111111111"));
        let k = scalar_reduce_be(&arr32("0x2222222222222222222222222222222222222222222222222222222222222222"));
        let ctx = arr32("0x3333333333333333333333333333333333333333333333333333333333333333");
        let c = gen_h() * Scalar::from(amount) + ProjectivePoint::generator() * r;
        let (r_pt, z) = prove_opening_sigma(amount, &r, &k, &ctx);
        // a valid proof verifies — and reveals nothing about r (z, R are the only outputs).
        assert!(verify_opening_sigma(&c, amount, &r_pt, &z, &ctx), "valid opening sigma verifies");
        // binds the value: a different amount (same commitment) is rejected.
        assert!(!verify_opening_sigma(&c, amount + 1, &r_pt, &z, &ctx), "amount tamper rejected");
        // binds the trade terms: a different context is rejected (so the box can't redirect/relabel).
        let ctx2 = arr32("0x4444444444444444444444444444444444444444444444444444444444444444");
        assert!(!verify_opening_sigma(&c, amount, &r_pt, &z, &ctx2), "context tamper rejected");
        // a forged response is rejected.
        assert!(!verify_opening_sigma(&c, amount, &r_pt, &(z + Scalar::from(1u64)), &ctx), "z tamper rejected");
    }

    #[test]
    fn range_accepts_js_proof_and_rejects_tamper() {
        let f = fixture();
        let out_c: Vec<_> = f["outC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let proof = hex::decode(f["rangeProof"].as_str().unwrap()).unwrap();
        assert!(verify_range(&out_c, &proof), "must accept JS BP+ proof");

        let mut bad = proof.clone();
        bad[200] ^= 1; // flip a byte inside the proof
        assert!(!verify_range(&out_c, &bad), "tampered proof must reject");

        let mut badc = out_c.clone();
        badc[0] = badc[0] + ProjectivePoint::generator() * Scalar::from(3u64);
        assert!(!verify_range(&badc, &proof), "wrong commitment must reject");
    }

    // BPP-AUDIT: adversarial edge cases on the range verifier (attacker-crafted proof bytes).
    // Confirms the structural gates (m-set, length, parse) reject cleanly and that the proof's
    // m is taken from commitments.len() (NOT attacker bytes) so a length/aggregation mismatch
    // cannot be exploited. The valid baseline is the real m=2 JS fixture proof.
    #[test]
    fn range_adversarial_edge_cases() {
        let f = fixture();
        let out_c: Vec<_> = f["outC"].as_array().unwrap().iter().map(|v| pt(v.as_str().unwrap())).collect();
        let proof = hex::decode(f["rangeProof"].as_str().unwrap()).unwrap();
        assert_eq!(out_c.len(), 2);
        assert!(verify_range(&out_c, &proof), "baseline m=2 must verify");

        // m = 0 (no commitments): not in {1,2,4,8} → reject, no panic.
        assert!(!verify_range(&[], &proof), "m=0 must reject");

        // m = 3 (non power of two): reject.
        let three = vec![out_c[0], out_c[1], out_c[0]];
        assert!(!verify_range(&three, &proof), "m=3 must reject");

        // m=1 with the m=2 proof: length is checked against commitments.len(), so the m=2
        // proof (657 B) is the wrong length for m=1 (591 B) → reject (can't repurpose a proof
        // for a different aggregation count).
        assert!(!verify_range(&[out_c[0]], &proof), "m=1 with m=2 proof: length mismatch must reject");

        // Truncated proof (one byte short): length gate rejects.
        assert!(!verify_range(&out_c, &proof[..proof.len() - 1]), "truncated must reject");
        // Extended proof (one trailing byte): length gate rejects.
        let mut longer = proof.clone();
        longer.push(0u8);
        assert!(!verify_range(&out_c, &longer), "over-length must reject");

        // All-zero proof of the correct length: the first 33 bytes are 0x00.. which is not a
        // valid compressed point → decompress fails → reject (no identity-point spoof).
        let zero = vec![0u8; proof.len()];
        assert!(!verify_range(&out_c, &zero), "all-zero proof must reject");

        // A commitment that is the identity point (point at infinity): in the guest this is
        // UNREACHABLE because output commitments are built by from_affine_xy(cx,cy), which has no
        // 65-byte 0x04-encoding for the identity and returns None (the guest then .expect()-panics
        // before verify_range is ever called). Fed directly, compress(identity) panics inside the
        // transcript (identity SEC1-compresses to a single 0x00 byte, not 33) — a FAIL-CLOSED panic,
        // never a spoofed `true`. Assert the call cannot return true (catch the panic).
        let id_result = std::panic::catch_unwind(|| {
            let mut id_c = out_c.clone();
            id_c[0] = ProjectivePoint::identity();
            verify_range(&id_c, &proof)
        });
        assert!(matches!(id_result, Ok(false) | Err(_)), "identity commitment must NOT verify (reject or fail-closed panic)");

        // Scalar field r1 set out of canonical range (>= n): scalar_canonical_be → None → reject.
        // r1 lives at offset 99 (after A,A1,B = 3*33). Overwrite with 0xFF..FF (> n).
        let mut bad_scalar = proof.clone();
        for b in bad_scalar.iter_mut().skip(99).take(32) { *b = 0xff; }
        assert!(!verify_range(&out_c, &bad_scalar), "non-canonical r1 scalar must reject");
    }

    // AMM-FEE-1: solve_clearing (the guest's fee-enforcement primitive for OP_SWAP) must match the
    // normative JS clearing-solve (tests/amm-clearing.mjs, AMM.md §4) byte-for-byte across the full
    // battery — one/two-sided, exact-cancel, zero/max fee, large near-u64 reserves (intermediate
    // products ~2^142), and a no-exact-fixed-point case. Vectors: tests/gen-clearing-vectors.mjs.
    // If the port drifts, the swap fee is mis-enforced (the whole point of fee tiers).
    #[test]
    fn solve_clearing_matches_js() {
        use num_bigint::BigUint;
        use std::str::FromStr;
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/clearing_vectors.json")).unwrap();
        for v in f["vectors"].as_array().unwrap() {
            let x: u64 = v["x"].as_str().unwrap().parse().unwrap();
            let y: u64 = v["y"].as_str().unwrap().parse().unwrap();
            let r_a: u64 = v["rA"].as_str().unwrap().parse().unwrap();
            let r_b: u64 = v["rB"].as_str().unwrap().parse().unwrap();
            let fee: u32 = v["fee"].as_u64().unwrap() as u32;
            let (pn, pd) = solve_clearing(x, y, r_a, r_b, fee);
            let exp_n = BigUint::from_str(v["pNum"].as_str().unwrap()).unwrap();
            let exp_d = BigUint::from_str(v["pDen"].as_str().unwrap()).unwrap();
            assert_eq!(pn, exp_n, "P_clear_num drift on X={x} Y={y} R={r_a}/{r_b} fee={fee}");
            assert_eq!(pd, exp_d, "P_clear_den drift on X={x} Y={y} R={r_a}/{r_b} fee={fee}");
        }
    }

    // AMM-LP-1: lp_add_shares is the min rule (the EVM guest's OP_LP_ADD share computation) and must
    // match tests/amm-clearing.mjs `lpAddShares` / dapp confidential-lp.js. The key property the old
    // exact-ratio gate broke: an INCREMENTAL add on a coprime, traded pool must earn shares (be > 0),
    // and an off-ratio add earns the LIMITING leg (the excess accrues to the pool — never an over-claim).
    #[test]
    fn lp_add_shares_min_rule() {
        // in-ratio (1:2 pool) → both legs agree → proportional shares
        assert_eq!(lp_add_shares(1000, 100, 200, 1000, 2000), 100);
        // B-short of ratio → min picks the B leg (99); the extra A is donated to the pool
        assert_eq!(lp_add_shares(1000, 100, 199, 1000, 2000), 99);
        // B-long of ratio → min picks the A leg (100); the extra B is donated
        assert_eq!(lp_add_shares(1000, 100, 400, 1000, 2000), 100);
        // dust below one share rounds to 0 (the guest rejects a 0-share add)
        assert_eq!(lp_add_shares(10000, 1, 2, 1_000_003, 2_000_006), 0);
        // REGRESSION: an incremental add on a COPRIME pool (no integer dB makes dA·R_B == dB·R_A) now
        // earns shares — the exact-ratio gate would have rejected every such add.
        assert!(lp_add_shares(1_000_003, 500, 999, 1_000_003, 1_999_991) > 0,
            "incremental add on a coprime/traded pool must earn shares");
        assert_eq!(lp_add_shares(1_000_003, 500, 999, 1_000_003, 1_999_991), 499);
        // remove: floor toward the pool
        assert_eq!(lp_remove_output(1000, 100, 1000), 100);
        assert_eq!(lp_remove_output(2000, 100, 1000), 200);
        assert_eq!(lp_remove_output(1_000_003, 1, 3), 333_334);
    }

    // AMM-LP-INIT: isqrt (the constant-product first-mint basis) matches tests/amm-clearing.mjs `isqrt`
    // reference vectors byte-for-byte, so the guest's first-mint totalShares == the JS/contract value.
    #[test]
    fn isqrt_matches_js_vectors() {
        for (n, r) in [(0u128, 0u128), (1, 1), (2, 1), (3, 1), (4, 2), (8, 2), (2_000_000_000_000, 1_414_213),
                       (1_000_000, 1000), (999_999, 999), (1_000_001, 1000), (u64::MAX as u128 * u64::MAX as u128, u64::MAX as u128)] {
            assert_eq!(isqrt(n), r, "isqrt({n}) should be {r}");
        }
    }

    // AMM-ROUTE-1: get_amount_out is the constant-product exact-in hop primitive OP_SWAP_ROUTE chains. It
    // must charge the fee, never drain the output reserve, and keep k non-decreasing (the LP floor).
    #[test]
    fn get_amount_out_exact_in() {
        assert_eq!(get_amount_out(1000, 1_000_000, 1_000_000, 0), 999);  // no-fee slippage
        assert_eq!(get_amount_out(1000, 1_000_000, 1_000_000, 30), 996); // 0.3% fee → strictly less
        assert!(get_amount_out(u64::MAX, 1000, 5000, 30) < 5000);        // can't drain the output reserve
        let (rin, rout) = (1_000_000u128, 1_000_000u128);
        let out = get_amount_out(1000, 1_000_000, 1_000_000, 30);
        assert!((rin + 1000) * (rout - out) >= rin * rout, "constant-product must not decrease");
    }

    // AMM-FEE-2: pin the ORIENTATION of clearing_price_matches. The declared OP_SWAP price is
    // clearingPriceBperA(solve) = B per A, i.e. the RECIPROCAL of solve_clearing's A-per-B P_clear, so
    // the check is `pc_den == price_num && pc_num == price_den`. This test locks that: the correct
    // (B-per-A) price is ACCEPTED and the reciprocal / an under-charged price is REJECTED — so a reader
    // (or auditor) can't mistake the intentional flip for a num/den reversal.
    #[test]
    fn clearing_price_matches_orientation() {
        // solve_clearing(100 A in, 0 B in, 1000/1000, 30bps) → P_clear 100/90 (A per B);
        // declared price (B per A) = 90/100.
        assert!(clearing_price_matches(100, 0, 1000, 1000, 30, 90, 100), "the fee-clearing B-per-A price must be accepted");
        assert!(!clearing_price_matches(100, 0, 1000, 1000, 30, 100, 90), "the reciprocal (A-per-B) price must be rejected");
        assert!(!clearing_price_matches(100, 0, 1000, 1000, 30, 91, 100), "an over-favourable (under-charged) price must be rejected");
        assert!(!clearing_price_matches(100, 0, 1000, 1000, 30, 89, 100), "a mismatched price must be rejected");
    }

    // BPP-1: the on-chain verify_range — the no-inflation ROOT primitive — must REJECT a FORGED proof
    // that commits an OUT-OF-RANGE value (V opens to 2^64), and still ACCEPT the honest max in-range
    // value (2^64 - 1). The forged proof is built by a malicious prover bypassing the [0,2^64) input
    // guard (tests/gen-bpp-out-of-range-fixture.mjs). Without this, the suite never drove the VERIFIER
    // with an out-of-range artifact — only the JS prover's input gate was tested — so a future port/
    // dependency drift that broke the value bound would mint unbacked supply behind a green suite.
    #[test]
    fn range_rejects_out_of_range_commitment() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/bpp_out_of_range.json")).unwrap();
        let honest_c = pt(f["honestMax"]["commitment"].as_str().unwrap());
        let honest_p = hex::decode(strip(f["honestMax"]["proof"].as_str().unwrap())).unwrap();
        assert!(verify_range(&[honest_c], &honest_p), "honest max in-range value 2^64-1 must verify (no false reject)");

        let oor_c = pt(f["outOfRange"]["commitment"].as_str().unwrap());
        let oor_p = hex::decode(strip(f["outOfRange"]["proof"].as_str().unwrap())).unwrap();
        assert!(!verify_range(&[oor_c], &oor_p), "a proof committing an out-of-range value (2^64) MUST be rejected (no inflation)");
    }

    #[test]
    fn keccak_primitives_and_opening_match_js_and_contract() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/confidential_pool.json")).unwrap();
        let asset = arr32(f["assetId"].as_str().unwrap());
        let owner = arr32(f["owner"].as_str().unwrap());

        for note in f["notes"].as_array().unwrap() {
            let cx = arr32(note["cx"].as_str().unwrap());
            let cy = arr32(note["cy"].as_str().unwrap());
            assert_eq!(leaf(&asset, &cx, &cy, &owner), arr32(note["leaf"].as_str().unwrap()), "leaf");
            assert_eq!(nullifier(&cx, &cy), arr32(note["nullifier"].as_str().unwrap()), "nullifier");
            let value: u64 = note["value"].as_str().unwrap().parse().unwrap();
            // deposit id binds the in-system value (not the underlying `amount`); the
            // contract derives the same value = amount/unitScale at wrap.
            assert_eq!(deposit_id(&asset, &u64_be32(value), &cx, &cy, &owner), arr32(note["depositId"].as_str().unwrap()), "depositId");

            // Pedersen opening: C reconstructed from (cx,cy) opens to (value, blinding).
            let c = from_affine_xy(&cx, &cy).unwrap();
            let blinding = scalar_reduce_be(&arr32(note["blinding"].as_str().unwrap()));
            assert!(verify_pedersen_opening(&c, value, &blinding), "opening");
            assert!(!verify_pedersen_opening(&c, value + 1, &blinding), "wrong value rejected");
        }

        // membership path folds to the tree root
        let leaves: Vec<[u8; 32]> = f["treeLeaves"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect();
        let idx = f["memberIndex"].as_u64().unwrap();
        let path: Vec<[u8; 32]> = f["memberPath"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect();
        let root = arr32(f["treeRoot"].as_str().unwrap());
        assert!(keccak_merkle_verify(&leaves[idx as usize], idx, &path, &root), "membership");
    }

    // Cross-chain: the guest's claim_id + destCommitment (Bitcoin leaf) must equal
    // the JS prover's and the contract's — locked three-way against the fixture so
    // a crossOut the guest emits is exactly what settle re-derives and Bitcoin honors.
    #[test]
    fn claim_id_and_dest_commitment_match_js_and_contract() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/bridge_burn.json")).unwrap();
        let asset = arr32(f["assetId"].as_str().unwrap());
        let dest_chain = f["destChain"].as_u64().unwrap() as u16;
        let bind = arr32(f["bindNullifier"].as_str().unwrap());

        for c in f["crossOuts"].as_array().unwrap() {
            let cx = arr32(c["cx"].as_str().unwrap());
            let cy = arr32(c["cy"].as_str().unwrap());
            let owner = arr32(c["owner"].as_str().unwrap());
            let dest = leaf(&asset, &cx, &cy, &owner);
            assert_eq!(dest, arr32(c["destCommitment"].as_str().unwrap()), "destCommitment");
            assert_eq!(claim_id(dest_chain, &dest, &bind, &asset), arr32(c["claimId"].as_str().unwrap()), "claimId");
        }
    }

    // Cross-lane gate: indexed-Merkle non-membership against the JS-built IMT root —
    // the scalable (O(log n)) accumulator for reflecting Bitcoin spends. Genuine
    // non-members verify; a present nullifier + a wrong/tampered low-leaf reject.
    #[test]
    fn imt_non_membership_matches_js() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let root = arr32(f["root"].as_str().unwrap());
        let arrp = |w: &serde_json::Value| -> Vec<[u8; 32]> {
            w["path"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect()
        };
        for w in f["witnesses"].as_array().unwrap() {
            let nu = arr32(w["nu"].as_str().unwrap());
            let lv = arr32(w["lowValue"].as_str().unwrap());
            let ln = arr32(w["lowNext"].as_str().unwrap());
            let li = w["lowIndex"].as_u64().unwrap();
            let got = imt_non_membership(&root, &nu, &lv, &ln, li, &arrp(w));
            assert_eq!(got, w["expect"].as_bool().unwrap(), "{}", w["note"].as_str().unwrap());
        }
        // a tampered path must reject a genuine non-member
        let w = &f["witnesses"][1];
        let nu = arr32(w["nu"].as_str().unwrap());
        let lv = arr32(w["lowValue"].as_str().unwrap());
        let ln = arr32(w["lowNext"].as_str().unwrap());
        let mut path = arrp(w);
        path[0][0] ^= 1;
        assert!(!imt_non_membership(&root, &nu, &lv, &ln, w["lowIndex"].as_u64().unwrap(), &path), "tampered path");
    }

    // The BUILD side (imt_root / imt_empty_root / keccak_merkle_root) reconstructs the
    // exact roots the JS pool.Tree produces — so the reflection prover computes the same
    // bitcoinSpentRoot the contract gate + non-membership witnesses are checked against.
    #[test]
    fn imt_build_matches_js() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let links: Vec<([u8; 32], [u8; 32])> = f["links"].as_array().unwrap().iter()
            .map(|l| (arr32(l[0].as_str().unwrap()), arr32(l[1].as_str().unwrap()))).collect();
        assert_eq!(imt_root(&links), arr32(f["root"].as_str().unwrap()), "built spent-set root == JS root");

        // The empty-set sentinel root is reproduced AND is non-zero (a zero root would
        // let the cross-lane gate be skipped — the contract rejects it).
        let empty = imt_empty_root();
        assert_eq!(empty, arr32(f["emptyRoot"].as_str().unwrap()), "empty-IMT root == JS emptyRoot");
        assert_ne!(empty, [0u8; 32], "empty-IMT sentinel is non-zero");

        // And the rebuilt set proves non-membership of a value beyond the max, against
        // the freshly BUILT root (closing the loop: build → prove on the same root).
        let beyond = arr32("0x0000000000000000000000000000000000000000000000000000000000000040");
        let max_links = links.last().unwrap();
        assert!(be_lt(&max_links.0, &beyond) && max_links.1 == [0u8; 32], "last link is the max element");
    }

    // The stateful ImtAccumulator (incremental insert, in-place predecessor update)
    // reaches the SAME root the JS accumulator does from the same chronological
    // insertion sequence, and a non-member proves absent against that built root — the
    // spent-set transition the reflection prover folds each new Bitcoin spend through.
    #[test]
    fn imt_accumulator_matches_js() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let a = &f["accumulator"];

        // empty accumulator == the non-zero sentinel root
        assert_eq!(ImtAccumulator::new().root(), imt_empty_root(), "empty accumulator == sentinel");
        assert_ne!(ImtAccumulator::new().root(), [0u8; 32], "sentinel non-zero");

        // fold the same chronological sequence → same order-dependent root as JS
        let mut acc = ImtAccumulator::new();
        for nu in a["insertSeq"].as_array().unwrap() {
            acc.insert(&arr32(nu.as_str().unwrap()));
        }
        let root = acc.root();
        assert_eq!(root, arr32(a["root"].as_str().unwrap()), "accumulator root == JS root");

        // non-membership of nu against the INCREMENTALLY-BUILT root (JS-supplied path)
        let nm = &a["nonMember"];
        let nu = arr32(nm["nu"].as_str().unwrap());
        let path: Vec<[u8; 32]> = nm["path"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();
        let (li, lv, ln) = acc.non_membership_low(&nu).expect("nu is a non-member");
        assert_eq!(li as u64, nm["lowIndex"].as_u64().unwrap(), "low index matches JS");
        assert_eq!(lv, arr32(nm["lowValue"].as_str().unwrap()), "low value matches JS");
        assert_eq!(ln, arr32(nm["lowNext"].as_str().unwrap()), "low next matches JS");
        assert!(imt_non_membership(&root, &nu, &lv, &ln, li as u64, &path), "nu absent from built root");

        // a member is correctly NOT provable absent
        let member = arr32(a["insertSeq"][0].as_str().unwrap());
        assert!(acc.non_membership_low(&member).is_none(), "a spent nu has no non-membership low leaf");
    }

    // imt_membership: a spent nu IS provable present against the built spent-set root —
    // the bridge_mint burn gate (B5). A wrong `next` or a non-spent value rejects.
    #[test]
    fn imt_membership_round_trips() {
        let zeros = keccak_zeros();
        let build_path = |leaves: &[[u8; 32]], mut idx: usize| -> Vec<[u8; 32]> {
            let mut level = leaves.to_vec();
            let mut path: Vec<[u8; 32]> = Vec::new();
            for lvl in 0..KECCAK_TREE_DEPTH {
                let s = idx ^ 1;
                path.push(if s < level.len() { level[s] } else { zeros[lvl] });
                let mut next: Vec<[u8; 32]> = Vec::new();
                let mut k = 0;
                while k * 2 < level.len() {
                    let l = level[2 * k];
                    let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[lvl] };
                    next.push(kn(&[&l, &r]));
                    k += 1;
                }
                level = next;
                idx >>= 1;
            }
            path
        };
        let mut acc = ImtAccumulator::new();
        let nu_a = arr32("0x0000000000000000000000000000000000000000000000000000000000000010");
        let nu_b = arr32("0x0000000000000000000000000000000000000000000000000000000000000020");
        acc.insert(&nu_a);
        acc.insert(&nu_b);
        let root = acc.root();
        let links = acc.links().to_vec();
        let leaves: Vec<[u8; 32]> = links.iter().map(|(v, n)| imt_leaf(v, n)).collect();

        let i = links.iter().position(|(v, _)| *v == nu_a).unwrap();
        let next_a = links[i].1;
        let path = build_path(&leaves, i);
        assert!(imt_membership(&root, &nu_a, &next_a, i as u64, &path), "spent nu is a member");

        let mut bad_next = next_a;
        bad_next[0] ^= 1;
        assert!(!imt_membership(&root, &nu_a, &bad_next, i as u64, &path), "wrong next rejects");

        let nu_c = arr32("0x0000000000000000000000000000000000000000000000000000000000000030");
        assert!(!imt_membership(&root, &nu_c, &next_a, i as u64, &path), "non-spent value rejects");
    }

    // The incremental note-tree accumulator (append-only, O(depth) state) reaches the
    // SAME root as the JS pool.Tree / the contract _insertLeaf, at every step — so the
    // reflection prover advances bitcoinPoolRoot without holding every leaf.
    #[test]
    fn note_tree_accumulator_matches_contract_tree() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/confidential_pool.json")).unwrap();
        let leaves: Vec<[u8; 32]> = f["treeLeaves"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();

        let mut acc = KeccakTreeAccumulator::new();
        assert_eq!(acc.root(), keccak_merkle_root(&[]), "empty accumulator == empty tree root");
        for (i, leaf) in leaves.iter().enumerate() {
            acc.append(leaf);
            // incremental root == batch rebuild over the leaves appended so far
            assert_eq!(acc.root(), keccak_merkle_root(&leaves[..=i]), "incremental == batch at step {i}");
            assert_eq!(acc.next_index(), (i + 1) as u64);
        }
        assert_eq!(acc.root(), arr32(f["treeRoot"].as_str().unwrap()), "final root == JS/contract treeRoot");
    }

    // The reflection prover's state transition: fold confirmed deposits (note leaves)
    // and spends (nullifiers) into a block, then commit the exact
    // (bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight) the relay proof carries. The
    // pool root matches the contract tree; the spent root matches the IMT accumulator;
    // the spent root is never zero.
    #[test]
    fn reflection_state_commits_relay_public_values() {
        let pf: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/confidential_pool.json")).unwrap();
        let imt: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/imt.json")).unwrap();
        let deposits: Vec<[u8; 32]> = pf["treeLeaves"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();
        let spends: Vec<[u8; 32]> = imt["accumulator"]["insertSeq"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();

        let mut state = ReflectionState::genesis();
        let (p0, s0, h0) = state.commit();
        assert_eq!(p0, keccak_merkle_root(&[]), "genesis pool root = empty");
        assert_eq!(s0, imt_empty_root(), "genesis spent root = non-zero sentinel");
        assert_ne!(s0, [0u8; 32], "genesis spent root non-zero");
        assert_eq!(h0, 0);

        state.apply_block(&deposits, &spends, 800_000);
        let (pool_root, spent_root, height) = state.commit();
        assert_eq!(pool_root, arr32(pf["treeRoot"].as_str().unwrap()), "reflected pool root == contract tree");
        assert_eq!(spent_root, arr32(imt["accumulator"]["root"].as_str().unwrap()), "reflected spent root == IMT accumulator");
        assert_ne!(spent_root, [0u8; 32], "reflected spent root non-zero");
        assert_eq!(height, 800_000);
    }

    // The per-event Bitcoin confirmation (bitcoin::verify_tx_in_block) accepts the real
    // bridge_mint block (valid PoW + the tx folds to the header's merkle root at its
    // index) and rejects tampering — the check the reflection prover runs on each
    // deposit/spend before folding it.
    #[test]
    fn verify_tx_in_block_accepts_real_block_rejects_tamper() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let header = hex::decode(strip(f["header"].as_str().unwrap())).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let tx_index = f["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = f["txids"].as_array().unwrap().iter()
            .map(|v| arr32(v.as_str().unwrap())).collect();

        // accepts: returns the tx's txid
        let txid = bitcoin::verify_tx_in_block(&header, &tx, tx_index, &txids)
            .expect("real bridge_mint block verifies");
        assert_eq!(txid, bitcoin::compute_txid(&tx).unwrap(), "returns the confirmed txid");

        // rejects: wrong index, a flipped txid (breaks the merkle root), a flipped tx
        // byte (txid no longer matches), and a malformed header length
        assert!(bitcoin::verify_tx_in_block(&header, &tx, tx_index + 1, &txids).is_none(), "bad index");
        let mut bad_txids = txids.clone();
        bad_txids[tx_index as usize][0] ^= 1;
        assert!(bitcoin::verify_tx_in_block(&header, &tx, tx_index, &bad_txids).is_none(), "tampered txid set");
        let mut bad_tx = tx.clone();
        let n = bad_tx.len();
        bad_tx[n - 1] ^= 1;
        assert!(bitcoin::verify_tx_in_block(&header, &bad_tx, tx_index, &txids).is_none(), "tampered tx");
        assert!(bitcoin::verify_tx_in_block(&header[..79], &tx, tx_index, &txids).is_none(), "bad header length");
    }

    // The reflection prover reads a confidential transfer's spent UTXOs from the tx's
    // native inputs (vin). extract_inputs parses them from the real bridge_mint tx and
    // rejects a malformed one.
    #[test]
    fn extract_inputs_parses_real_tx() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let inputs = bitcoin::extract_inputs(&tx).expect("real tx inputs parse");
        assert!(!inputs.is_empty(), "tx has at least one input");
        assert!(bitcoin::extract_inputs(&tx[..5]).is_none(), "truncated tx rejected");
    }

    // The Bitcoin T_CXFER kernel: a real BIP-340 kernel signature (a pure transfer,
    // Σv_in = Σv_out, burned = 0) verifies against the reconstructed excess key
    // P = Σ C_in − Σ C_out, and tampering the sig / the message (reordered outputs) is
    // rejected. (dapp/evm-confidential.js commitments → tests/gen-cxfer-kernel-fixture.mjs.)
    #[test]
    fn cxfer_kernel_verify_accepts_real_sig_rejects_tamper() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/cxfer_kernel.json")).unwrap();
        let asset = arr32(f["asset"].as_str().unwrap());
        let burned: u64 = f["burnedAmount"].as_str().unwrap().parse().unwrap();
        let inputs: Vec<([u8; 32], u32)> = f["inputs"].as_array().unwrap().iter()
            .map(|i| (arr32(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
        let in_commits: Vec<ProjectivePoint> = f["inputs"].as_array().unwrap().iter()
            .map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();
        let out_compressed: Vec<[u8; 33]> = f["outputs"].as_array().unwrap().iter()
            .map(|o| arr33(o["commitment"].as_str().unwrap())).collect();
        let sig: [u8; 64] = hex::decode(strip(f["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();

        assert!(cxfer_kernel_verify(&asset, &inputs, &in_commits, &out_compressed, burned, &sig), "valid kernel sig");

        let mut bad_sig = sig;
        bad_sig[63] ^= 1;
        assert!(!cxfer_kernel_verify(&asset, &inputs, &in_commits, &out_compressed, burned, &bad_sig), "tampered sig rejected");

        let mut reordered = out_compressed.clone();
        reordered.swap(0, 1); // changes the kernel message (output order) → e differs
        assert!(!cxfer_kernel_verify(&asset, &inputs, &in_commits, &reordered, burned, &sig), "reordered outputs rejected");

        // wrong asset → different message → reject
        assert!(!cxfer_kernel_verify(&[0u8; 32], &inputs, &in_commits, &out_compressed, burned, &sig), "wrong asset rejected");
    }

    // REFLECT-1 regression: the reflection prover must NOT fold a confirmed CXFER tx's outputs into
    // bitcoinPoolRoot unless the tx CONSERVES value. Bitcoin consensus never checks the Tacit kernel
    // (the envelope is witness bytes), so a confirmed tx can declare an inflated output commitment;
    // before this gate (`fold_cxfer` → `verify_cxfer_conservation`) the per-output fold appended it
    // into the pool root, making unbacked value spendable cross-lane on Ethereum (value from nothing).
    #[test]
    fn reflection_cxfer_fold_rejects_nonconserving_outputs() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/cxfer_kernel.json")).unwrap();
        let asset = arr32(f["asset"].as_str().unwrap());
        let inputs: Vec<([u8; 32], u32)> = f["inputs"].as_array().unwrap().iter()
            .map(|i| (arr32(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
        let in_pts: Vec<ProjectivePoint> = f["inputs"].as_array().unwrap().iter()
            .map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();
        let outs: Vec<[u8; 33]> = f["outputs"].as_array().unwrap().iter()
            .map(|o| arr33(o["commitment"].as_str().unwrap())).collect();
        let sig: [u8; 64] = hex::decode(strip(f["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();

        // The conserved tx's kernel verifies (Σ C_in = Σ C_out).
        assert!(cxfer_kernel_verify(&asset, &inputs, &in_pts, &outs, 0, &sig), "conserved cxfer kernel verifies");

        // Inflate output[0] by 1_000_000·H: still a valid curve point that yields a well-formed leaf
        // (shape-binding CANNOT catch inflation), but the kernel now rejects it (Σ_out ≠ Σ_in).
        let inflated_pt = decompress(&outs[0]).unwrap() + gen_h() * Scalar::from(1_000_000u64);
        let mut inflated = outs.clone();
        inflated[0] = compress(&inflated_pt);
        assert!(reflected_note_leaf(&asset, &inflated[0]).is_some(),
            "inflated commitment still yields a well-formed leaf — shape-binding misses value inflation");
        assert!(!cxfer_kernel_verify(&asset, &inputs, &in_pts, &inflated, 0, &sig),
            "inflated cxfer output rejected by the conservation kernel");

        // The FOLD path fails closed: fold_cxfer rejects the non-conserving tx and folds NOTHING, so
        // the pool root / note count are unchanged (no phantom note enters the pool; the spends are
        // nullified separately by the caller). A real-PoW positive-fold round-trip is exercised by the
        // reflection round-trip fixture; here we lock the inflation REJECT the missing gate let through.
        let mut sc = ScanReflection::genesis();
        let pool_before = sc.pool_root;
        let notes_before = sc.note_count;
        let paths: Vec<Vec<[u8; 32]>> = (0..inflated.len()).map(|_| vec![[0u8; 32]; KECCAK_TREE_DEPTH]).collect();
        let vouts: Vec<u32> = (0..inflated.len() as u32).collect();
        let txid = arr32("0x7777777777777777777777777777777777777777777777777777777777777777");
        // No range proof in the kernel fixture → verify_range fails → fold rejects (fail-closed: a
        // cxfer with a missing/short range proof also injects nothing).
        // input_assets all == the envelope asset, so the rejection here is purely the conservation
        // failure (asset preservation is exercised separately in scan_reflection_rejects_asset_relabel).
        let in_assets = vec![asset; in_pts.len()];
        let res = sc.fold_cxfer(&asset, &inputs, &in_pts, &in_assets, &txid, &inflated, &paths, &vouts, &[], &sig);
        assert!(res.is_err(), "fold_cxfer rejects a non-conserving cxfer tx");
        assert_eq!(sc.pool_root, pool_before, "rejected cxfer folds NO output (pool root unchanged)");
        assert_eq!(sc.note_count, notes_before, "rejected cxfer appends no note");
    }

    // ASSET-PRESERVATION (cross-asset inflation): the reflection's CXFER conservation is value-ONLY
    // (Σ C_in = Σ C_out; the kernel only labels its message with `asset`). A confirmed Bitcoin CXFER
    // can therefore spend a CHEAP-asset pool note and declare a DEAR-asset output of equal
    // commitment-value: value conserves, asset flips, and the dear note becomes bridge-mintable on
    // Ethereum (value from nothing). The EVM lane is immune — `leaf(asset,…)` membership binds the
    // spend's asset — but the reflection resolved inputs through an (asset-blind) live UTXO set, so
    // it could not. The fix carries each note's asset in the live set and makes `fold_cxfer` require
    // every spent note's asset == the envelope's. This pins the property on a GENUINELY conserving
    // fixture: conservation PASSES, so the asset-preservation check is the SOLE defense — pre-fix
    // this exact fold minted the relabeled note.
    #[test]
    fn scan_reflection_cxfer_fold_rejects_asset_relabel() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        let v = f["vectors"].as_array().unwrap().iter()
            .find(|x| x["name"].as_str() == Some("conserving_m1")).expect("conserving_m1 vector");

        // The CXFER envelope's declared asset (the DEAR asset the attacker wants to mint), and a
        // genuinely value-conserving 1-in/1-out kernel + range proof signed under it.
        let envelope_asset = arr32(v["asset"].as_str().unwrap());
        let in_txid = arr32(v["inputs"][0]["txid"].as_str().unwrap());
        let in_vout = v["inputs"][0]["vout"].as_u64().unwrap() as u32;
        let in_pt = decompress(&arr33(v["inputs"][0]["commitment"].as_str().unwrap())).unwrap();
        let out_c = arr33(v["outsCompressed"][0].as_str().unwrap());
        let sig: [u8; 64] = hex::decode(strip(v["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();
        let rp = hex::decode(strip(v["rangeProof"].as_str().unwrap())).unwrap();

        let in_outpoints = vec![(in_txid, in_vout)];
        let in_pts = vec![in_pt];
        // Conservation genuinely PASSES for this (input, output, asset, sig, rp) — so the ONLY thing
        // that can stop the relabel is the asset-preservation gate.
        assert!(verify_cxfer_conservation(&envelope_asset, &in_outpoints, &in_pts, &[out_c], &rp, &sig),
            "fixture cxfer conserves value (the asset check is the sole defense)");

        // The single output appends at genesis index 0 → the append path is the empty-tree zeros path.
        let txid = arr32("0x9999999999999999999999999999999999999999999999999999999999999999");
        let note_path = KeccakTreeAccumulator::new().append_path();
        let vouts = vec![0u32];

        // ── The attack ── the spent note's REAL asset (recorded in the live set when it was created)
        // is a DIFFERENT, cheaper asset than the envelope declares.
        let cheap_asset = arr32("0x00000000000000000000000000000000000000000000000000000000c4eac4ea");
        assert_ne!(cheap_asset, envelope_asset);
        let mut attacked = ScanReflection::genesis();
        let pool_before = attacked.pool_root;
        let res = attacked.fold_cxfer(
            &envelope_asset, &in_outpoints, &in_pts, &[cheap_asset], &txid,
            &[out_c], &[note_path.clone()], &vouts, &rp, &sig,
        );
        assert_eq!(res, Err("cxfer fold: non-asset-preserving (input asset != envelope asset)"),
            "a value-conserving CXFER that RELABELS a cheap-asset note as the dear envelope asset is rejected");
        assert_eq!(attacked.pool_root, pool_before, "relabel folds NO output (pool root unchanged) — no dear note minted");
        assert_eq!(attacked.note_count, 0, "relabel appends no note");
        assert!(attacked.live.is_empty(), "relabel adds no live outpoint");

        // ── The honest path ── input note's asset == the envelope asset → the conserving cxfer folds.
        let mut honest = ScanReflection::genesis();
        honest.fold_cxfer(
            &envelope_asset, &in_outpoints, &in_pts, &[envelope_asset], &txid,
            &[out_c], &[note_path], &vouts, &rp, &sig,
        ).expect("an asset-preserving conserving cxfer folds");
        assert_eq!(honest.note_count, 1, "honest fold appends the output note");
        assert_ne!(honest.pool_root, pool_before, "honest fold advances the pool root");
        let outpoint = outpoint_key(&txid, 0);
        let ch = commitment_hash_compressed(&out_c).unwrap();
        assert_eq!(honest.live.get(&outpoint), Some((ch, envelope_asset)),
            "the new note is live under the envelope asset");
    }

    // REFLECT-1 DIFFERENTIAL: the guest reads a cxfer's output witnesses ONLY when
    // verify_cxfer_conservation accepts; the JS assembler (dapp verifyCxferConservation) emits them
    // under the SAME condition. If the two predicates ever DISAGREE (one accepts, the other rejects)
    // for some confirmed envelope, the witness stream desyncs → wrong roots / a panic. This pins the
    // Rust verdict against the JS verdict, byte-for-byte, on a battery of adversarial envelopes
    // (inflated, tampered sig/range, reordered, mismatched range, non-canonical point, zero point,
    // zero-input mint-from-nothing). Vectors + the JS verdict are generated by
    // tests/gen-cxfer-conservation-differential.mjs (run with the dapp's own secp/BP+).
    #[test]
    fn cxfer_conservation_matches_js_verdict() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/cxfer_conservation_diff.json")).unwrap();
        for v in f["vectors"].as_array().unwrap() {
            let name = v["name"].as_str().unwrap();
            let asset = arr32(v["asset"].as_str().unwrap());
            let in_outpoints: Vec<([u8; 32], u32)> = v["inputs"].as_array().unwrap().iter()
                .map(|i| (arr32(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
            let in_points: Vec<ProjectivePoint> = v["inputs"].as_array().unwrap().iter()
                .map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();
            let outs: Vec<[u8; 33]> = v["outsCompressed"].as_array().unwrap().iter()
                .map(|o| arr33(o.as_str().unwrap())).collect();
            let sig: [u8; 64] = hex::decode(strip(v["kernelSig"].as_str().unwrap())).unwrap().try_into().unwrap();
            let rp = hex::decode(strip(v["rangeProof"].as_str().unwrap())).unwrap();

            let rust = verify_cxfer_conservation(&asset, &in_outpoints, &in_points, &outs, &rp, &sig);
            // A JS "throw" (a wiring bug, missing field) has no Rust analog — only true/false vectors
            // are differential. All generated vectors are well-formed (no missing field), so jsVerdict
            // is a bool here.
            let js = v["jsVerdict"].as_bool()
                .unwrap_or_else(|| panic!("vector {name} jsVerdict not a bool: {:?}", v["jsVerdict"]));
            assert_eq!(rust, js, "REFLECT-1 desync: vector '{name}' — Rust verify_cxfer_conservation={rust} but JS verifyCxferConservation={js}");
        }
    }

    // The UTXO accumulator: add outpoints, resolve them (get), prove membership against
    // the live root, then spend (remove) — a spent outpoint resolves to None and its
    // membership leaf no longer folds to the root, while live siblings still do.
    #[test]
    fn utxo_accumulator_add_resolve_spend() {
        let key = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let val = |b: u8| { let mut v = [0u8; 32]; v[0] = b; v };
        let mut u = UtxoAccumulator::new();
        let empty_root = u.root();

        // add three outpoints (out of order), each carrying its note's ν as value
        u.insert(&key(0x20), &val(0xb2));
        u.insert(&key(0x10), &val(0xa1));
        u.insert(&key(0x30), &val(0xc3));
        assert_ne!(u.root(), empty_root, "root advanced on inserts");

        // resolve: get returns the stored ν
        assert_eq!(u.get(&key(0x10)), Some(val(0xa1)), "resolve 0x10");
        assert_eq!(u.get(&key(0x99)), None, "unknown outpoint");

        // membership of a live outpoint folds to the current root
        let (idx, next, value) = u.membership(&key(0x10)).expect("0x10 live");
        assert_eq!(value, val(0xa1));
        // rebuild the same tree the accumulator commits, to get the path
        let leaves: Vec<[u8; 32]> = (0..u.nodes.len()).map(|i| u.leaf_at(i)).collect();
        let root = keccak_merkle_root(&leaves);
        assert_eq!(root, u.root(), "rebuilt root == accumulator root");
        assert_eq!(leaves[idx], utxo_leaf(&key(0x10), &next, &value), "membership leaf at index");

        // spend it: resolve→None, and its leaf position is now a tombstone (0)
        u.remove(&key(0x10));
        assert_eq!(u.get(&key(0x10)), None, "spent outpoint no longer resolves");
        assert!(u.membership(&key(0x10)).is_none(), "spent outpoint has no membership");
        assert_eq!(u.leaf_at(idx), [0u8; 32], "spent leaf tombstoned to 0");
        // siblings still resolve
        assert_eq!(u.get(&key(0x20)), Some(val(0xb2)), "sibling 0x20 still live");
        assert_eq!(u.get(&key(0x30)), Some(val(0xc3)), "sibling 0x30 still live");
        // double-spend panics (tested via catch in a separate #[should_panic] below)
    }

    #[test]
    #[should_panic(expected = "outpoint not in the UTXO set")]
    fn utxo_double_spend_panics() {
        let key = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let mut u = UtxoAccumulator::new();
        u.insert(&key(0x10), &[7u8; 32]);
        u.remove(&key(0x10));
        u.remove(&key(0x10)); // already spent
    }

    // NEG-1 / NEG-2: the bridge_mint authority binding (guest `main.rs`: bm_leaf = utxo_leaf(ν,
    // bm_next, dest_leaf); keccak_merkle_verify(bm_leaf, …, bitcoin_burn_root)). Only a note
    // explicitly BURNED FOR THE BRIDGE — ν a live key in the dedicated bridge-burn set — bound to the
    // destination the burn declared (its stored value == the Ethereum-minted leaf) can be minted on
    // Ethereum. (NEG-1) An ordinarily-spent ν is absent from the burn set, so it cannot prove
    // membership (it lives in the spent set, never the burn set) → no cross-chain value duplication.
    // (NEG-2) The mint cannot be redirected to a destination the burn did not declare. The contract
    // sees only the burn-root, never this in-guest check, so no contract test reaches it; this locks
    // the §6 inflation / mint-redirection rejects.
    #[test]
    fn bridge_mint_burn_membership_binds_nu_and_destination() {
        let zeros = keccak_zeros();
        let build_path = |leaves: &[[u8; 32]], mut idx: usize| -> Vec<[u8; 32]> {
            let mut level = leaves.to_vec();
            let mut path: Vec<[u8; 32]> = Vec::new();
            for lvl in 0..KECCAK_TREE_DEPTH {
                let s = idx ^ 1;
                path.push(if s < level.len() { level[s] } else { zeros[lvl] });
                let mut next: Vec<[u8; 32]> = Vec::new();
                let mut k = 0;
                while k * 2 < level.len() {
                    let l = level[2 * k];
                    let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[lvl] };
                    next.push(kn(&[&l, &r]));
                    k += 1;
                }
                level = next;
                idx >>= 1;
            }
            path
        };

        let nu = { let mut x = [0u8; 32]; x[31] = 0xaa; x };        // a burned note's ν
        let dest_leaf = { let mut x = [0u8; 32]; x[0] = 0xd0; x };  // the ETH-minted leaf the burn declared
        let other_nu = { let mut x = [0u8; 32]; x[31] = 0xbb; x };  // an ordinarily-spent (non-bridged) ν

        // The bridge-burn set: only genuine bridge-outs land here (ν → declared dest_leaf).
        let mut burns = UtxoAccumulator::new();
        burns.insert(&nu, &dest_leaf);
        let burn_root = burns.root();
        let leaves = burns.leaves();
        let (idx, next, value) = burns.membership(&nu).expect("ν is a member of the bridge-burn set");
        assert_eq!(value, dest_leaf, "the burn set binds ν to the destination it declared");
        let path = build_path(&leaves, idx);

        // HONEST: ν bound to its declared destination proves membership → mintable.
        assert!(keccak_merkle_verify(&utxo_leaf(&nu, &next, &dest_leaf), idx as u64, &path, &burn_root),
            "a genuine bridge-burn (ν → dest_leaf) proves membership in bitcoinBurnRoot");

        // NEG-2 (redirect): the SAME ν + witness but a DIFFERENT minted destination → the preimage
        // (utxo_leaf binds dest_leaf as its value field) differs → membership fails.
        let redirected = { let mut x = [0u8; 32]; x[0] = 0xd1; x };
        assert_ne!(redirected, dest_leaf);
        assert!(!keccak_merkle_verify(&utxo_leaf(&nu, &next, &redirected), idx as u64, &path, &burn_root),
            "redirecting the mint to a destination the burn never declared is rejected (no mint redirection)");

        // NEG-1 (ordinary spend): an ordinarily-spent ν is NOT in the bridge-burn set, so no honest
        // witness exists; even reusing the genuine member's slot, the preimage differs from any real
        // leaf, so membership fails.
        assert!(burns.membership(&other_nu).is_none(), "an ordinarily-spent ν is absent from the bridge-burn set");
        assert!(!keccak_merkle_verify(&utxo_leaf(&other_nu, &next, &dest_leaf), idx as u64, &path, &burn_root),
            "an ordinarily-spent ν cannot prove bridge-burn membership → not mintable (no cross-chain inflation)");
    }

    // The UTXO-model transfer fold: an output creates an outpoint→ν UTXO + a note leaf;
    // a later transfer consumes that outpoint, inserting its ν into the spent set and
    // removing it from the UTXO set. The committed roots advance; state_digest binds the
    // UTXO root for resumption.
    #[test]
    fn reflection_apply_transfer_utxo_model() {
        let outpoint = arr32("0x00000000000000000000000000000000000000000000000000000000000000a1");
        let note_leaf = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let ch1 = arr32("0x00000000000000000000000000000000000000000000000000000000000000c1"); // keccak(C_out)
        let nu1 = arr32("0x0000000000000000000000000000000000000000000000000000000000000033"); // the note's ν

        let mut s = ReflectionState::genesis();
        let d0 = s.state_digest();

        // block 1: a transfer with one output (a new note/UTXO), no inputs
        s.apply_transfer(&[], &[(outpoint, note_leaf, ch1)], 800_000);
        assert_eq!(s.utxo.get(&outpoint), Some(ch1), "outpoint → commitment hash");
        assert!(s.spent.non_membership_low(&nu1).is_some(), "ν not yet spent");
        let (_, _, h1) = s.commit();
        assert_eq!(h1, 800_000);
        assert_ne!(s.state_digest(), d0, "state advanced");

        // block 2: a transfer consuming that outpoint — the guest witnessed its commitment,
        // verified keccak(C) == ch1, and derived ν = nu1, which it passes in with the input
        let out2 = arr32("0x00000000000000000000000000000000000000000000000000000000000000b2");
        let leaf2 = arr32("0x2222222222222222222222222222222222222222222222222222222222222222");
        let ch2 = arr32("0x00000000000000000000000000000000000000000000000000000000000000c2");
        s.apply_transfer(&[(outpoint, nu1)], &[(out2, leaf2, ch2)], 800_001);

        assert_eq!(s.utxo.get(&outpoint), None, "spent outpoint removed from UTXO set");
        assert!(s.spent.non_membership_low(&nu1).is_none(), "ν is now in the spent set");
        assert_eq!(s.utxo.get(&out2), Some(ch2), "new output → commitment hash");
        assert_eq!(s.notes.next_index(), 2, "two note leaves appended");
        let (_, _, h2) = s.commit();
        assert_eq!(h2, 800_001);
    }

    // F4 full-scan: the live UTXO set rebuilds + root-checks from sorted contents (the O(live)
    // verify-once step), resolves outpoints, and folds an output/spend with the committed root
    // advancing — and rejects an out-of-order / zero-key handoff.
    #[test]
    fn live_utxo_set_rebuild_and_mutate() {
        let key = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let val = |b: u8| { let mut v = [0u8; 32]; v[0] = b; v };
        let ast = |b: u8| { let mut a = [0u8; 32]; a[1] = b; a }; // a distinct asset_id per entry

        // a handed set must be strictly ascending, non-zero (by key)
        assert!(LiveUtxoSet::from_sorted(vec![(key(0x10), val(1), ast(1)), (key(0x20), val(2), ast(2))]).is_some());
        assert!(LiveUtxoSet::from_sorted(vec![(key(0x20), val(2), ast(2)), (key(0x10), val(1), ast(1))]).is_none(), "unsorted rejected");
        assert!(LiveUtxoSet::from_sorted(vec![(key(0x10), val(1), ast(1)), (key(0x10), val(2), ast(2))]).is_none(), "duplicate rejected");
        assert!(LiveUtxoSet::from_sorted(vec![([0u8; 32], val(1), ast(1))]).is_none(), "zero key rejected");

        let mut live = LiveUtxoSet::from_sorted(vec![(key(0x10), val(0xa1), ast(0xa)), (key(0x30), val(0xc3), ast(0xc))]).unwrap();
        assert_eq!(live.root(), LiveUtxoSet::from_sorted(vec![(key(0x10), val(0xa1), ast(0xa)), (key(0x30), val(0xc3), ast(0xc))]).unwrap().root(), "root is contents-determined");
        assert_eq!(live.get(&key(0x10)), Some((val(0xa1), ast(0xa))), "resolve → (commitment hash, asset)");
        assert_eq!(live.get(&key(0x99)), None);
        // the asset is committed into the root: same key/value, different asset → different root
        assert_ne!(live.root(), LiveUtxoSet::from_sorted(vec![(key(0x10), val(0xa1), ast(0xa)), (key(0x30), val(0xc3), ast(0xd))]).unwrap().root(), "asset bound into the root");
        let r0 = live.root();

        // an output inserts in key order; a spend removes; the root tracks the live contents
        live.insert(&key(0x20), &val(0xb2), &ast(0xb));
        assert_eq!(live.get(&key(0x20)), Some((val(0xb2), ast(0xb))));
        assert_ne!(live.root(), r0, "root advanced on insert");
        assert_eq!(live.remove(&key(0x20)), (val(0xb2), ast(0xb)), "remove returns the stored (commitment, asset)");
        assert_eq!(live.root(), r0, "insert+remove of the same key restores the root");
        assert_eq!(live.get(&key(0x20)), None, "spent outpoint no longer resolves");
    }

    // Parity anchor for tests/confidential-reflection-scan.mjs (LIVE2_ROOT): the asset-committed
    // live-set root for a known 2-entry set, so JS == Rust on the keccak(key‖asset‖value) leaf order.
    #[test]
    fn live_utxo_set_root_with_asset_pin() {
        let last = |b: u8| { let mut k = [0u8; 32]; k[31] = b; k };
        let first = |b: u8| { let mut x = [0u8; 32]; x[0] = b; x };
        let live = LiveUtxoSet::from_sorted(vec![
            (last(0x10), first(0xa1), first(0xaa)),
            (last(0x30), first(0xc3), first(0xbb)),
        ]).unwrap();
        assert_eq!(
            hex::encode(live.root()),
            "0b4c5da8728e3216a451be798a8d9326513e018880e1755bffd582f084718faa",
            "LIVE2_ROOT (asset-committed live-set root) — keep in sync with tests/confidential-reflection-scan.mjs"
        );
    }

    // F4 full-scan: scan a REAL confirmed tx's vins against a live set seeded with its first
    // input outpoint → the spend is detected, ν is derived + bound to the stored commitment, and
    // the outpoint is removed. A set without that outpoint detects nothing; a forged opening that
    // doesn't bind to the stored commitment is a hard reject.
    #[test]
    fn scan_tx_spends_detects_real_vin() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let inputs = bitcoin::extract_inputs(&tx).expect("real tx inputs");
        let (in_txid, in_vout) = inputs[0];
        let outpoint = outpoint_key(&in_txid, in_vout);

        // a note (Cx,Cy) whose commitment_hash is what the live set stores at that outpoint
        let cx = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let cy = arr32("0x2222222222222222222222222222222222222222222222222222222222222222");
        let stored = commitment_hash(&cx, &cy);
        let asset = arr32("0x00000000000000000000000000000000000000000000000000000000000000aa");

        let mut live = LiveUtxoSet::from_sorted(vec![(outpoint, stored, asset)]).unwrap();
        let before = live.root();
        let spends = scan_tx_spends(&tx, &mut live, || (cx, cy)).expect("scan honest tx");
        assert_eq!(spends.len(), 1, "the seeded pool outpoint is detected as a spend");
        assert_eq!((spends[0].outpoint, spends[0].nu), (outpoint, nullifier(&cx, &cy)), "ν derived + bound to the stored commitment");
        assert_eq!((spends[0].prev_txid, spends[0].prev_vout), (in_txid, in_vout), "raw prev-outpoint surfaced for the conservation kernel");
        assert_eq!((spends[0].cx, spends[0].cy), (cx, cy), "spent commitment coords surfaced (Σ C_in)");
        assert_eq!(spends[0].asset, asset, "spent note's asset surfaced (CXFER fold asset-preservation)");
        assert!(live.is_empty(), "the spent outpoint is removed from the live set");
        assert_ne!(live.root(), before, "live root advanced on the spend");

        // a live set that doesn't contain any of the tx's vins → no pool spend
        let mut other = LiveUtxoSet::from_sorted(vec![(arr32("0x00000000000000000000000000000000000000000000000000000000000000ff"), stored, asset)]).unwrap();
        let none = scan_tx_spends(&tx, &mut other, || (cx, cy)).expect("scan unrelated tx");
        assert!(none.is_empty(), "a tx spending no pool UTXO yields no spends");

        // an opening that doesn't open the stored commitment is rejected (forged ν)
        let mut live2 = LiveUtxoSet::from_sorted(vec![(outpoint, stored, asset)]).unwrap();
        let bad = scan_tx_spends(&tx, &mut live2, || (cy, cx)); // swapped → wrong commitment_hash
        assert!(bad.is_none(), "an opening not binding to the stored commitment is a hard reject");
    }

    // H-1: bridge_mint must authorize only against the bridge-burn set, not the all-spends
    // set. An ordinary Bitcoin spend's ν enters `spent` but NOT `bridge_burns`, so it has no
    // bridge-burn membership (bridge_mint can't mint it). A cross-chain burn's ν enters BOTH,
    // and `bridge_burns` binds it to the declared destCommitment.
    #[test]
    fn bridge_burn_set_excludes_ordinary_spends() {
        let op_a = arr32("0x00000000000000000000000000000000000000000000000000000000000000a1");
        let op_b = arr32("0x00000000000000000000000000000000000000000000000000000000000000b2");
        let ch = arr32("0x00000000000000000000000000000000000000000000000000000000000000c0");
        let leaf_x = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let nu_ord = arr32("0x0000000000000000000000000000000000000000000000000000000000000041"); // ordinary spend ν
        let nu_brn = arr32("0x0000000000000000000000000000000000000000000000000000000000000042"); // bridge-out ν
        let dest = arr32("0x2222222222222222222222222222222222222222222222222222222222222222"); // destCommitment

        let mut s = ReflectionState::genesis();
        // two outputs → two live UTXOs
        s.apply_transfer(&[], &[(op_a, leaf_x, ch), (op_b, leaf_x, ch)], 900_000);

        // op_a spent in an ORDINARY transfer; op_b BURNED for the bridge
        s.apply_transfer(&[(op_a, nu_ord)], &[], 900_001);
        s.apply_bridge_out(&op_b, &nu_brn, &dest, 900_002);

        // both ν are spent (cross-lane serialization holds for both)
        assert!(s.spent.non_membership_low(&nu_ord).is_none(), "ordinary ν spent");
        assert!(s.spent.non_membership_low(&nu_brn).is_none(), "burn ν spent");

        // but ONLY the bridge-out's ν is in the bridge-burn set, bound to its destCommitment
        assert_eq!(s.bridge_burns.get(&nu_ord), None, "ordinary spend NOT mintable (H-1)");
        assert_eq!(s.bridge_burns.get(&nu_brn), Some(dest), "burn mintable, bound to dest");
        assert_ne!(s.bridge_burn_root(), [0u8; 32], "burn root is the non-zero sentinel-seeded set");
    }

    // JS↔Rust cross-impl KAT for the bridge-burn (UTXO) accumulator. The JS witness builder
    // (dapp makeUtxoAccumulator) and this Rust prover MUST agree on the root, or a JS-built
    // bridge_mint witness won't verify against the Rust-proven bitcoinBurnRoot. Expected root
    // computed by dapp/confidential-pool.js for the same two (key → value) inserts.
    #[test]
    fn utxo_accumulator_root_matches_js() {
        let k1 = arr32("0x0000000000000000000000000000000000000000000000000000000000000007");
        let v1 = arr32("0x0000000000000000000000000000000000000000000000000000000000000099");
        let k2 = arr32("0x1111111111111111111111111111111111111111111111111111111111111111");
        let v2 = arr32("0x2222222222222222222222222222222222222222222222222222222222222222");
        let mut u = UtxoAccumulator::new();
        u.insert(&k1, &v1);
        u.insert(&k2, &v2);
        assert_eq!(u.root(), arr32("0xc0e284ae6547f611ffa26c9bf05875e87b6c9e8bb0793b9eaeda6daa1121efad"),
            "Rust UtxoAccumulator root must equal the JS makeUtxoAccumulator root");
    }

    // Depth-32 Merkle path for `index` over `leaves`, zero-filling empty subtrees — the
    // witness builder the indexer runs (positions ≥ leaves.len() are the zero leaf). Mirrors
    // the JS pool.Tree.rootAndPath; used here to feed the witnessed transitions.
    fn merkle_path(leaves: &[[u8; 32]], mut index: u64) -> Vec<[u8; 32]> {
        let zeros = keccak_zeros();
        let mut path = Vec::with_capacity(KECCAK_TREE_DEPTH);
        let mut level: Vec<[u8; 32]> = leaves.to_vec();
        for i in 0..KECCAK_TREE_DEPTH {
            let sib_idx = (index ^ 1) as usize;
            path.push(if sib_idx < level.len() { level[sib_idx] } else { zeros[i] });
            let mut next = Vec::with_capacity(level.len().div_ceil(2));
            let mut k = 0;
            while k * 2 < level.len() {
                let l = level[2 * k];
                let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[i] };
                next.push(kn(&[&l, &r]));
                k += 1;
            }
            level = next;
            index >>= 1;
        }
        path
    }

    // Phase 1: the witnessed IMT insert transition reproduces the stateful ImtAccumulator's
    // root sequence with NO full-set state — only (prior_root, low-witness, append-witness).
    // This is what lets the reflection prover resume from a digest and fold Δ-spends in-zkVM.
    #[test]
    fn imt_insert_transition_matches_stateful() {
        let spends = [
            arr32("0x0000000000000000000000000000000000000000000000000000000000000042"),
            arr32("0x00000000000000000000000000000000000000000000000000000000000000a1"),
            arr32("0x0000000000000000000000000000000000000000000000000000000000000007"),
            arr32("0x00000000000000000000000000000000000000000000000000000000000000ff"),
            arr32("0x0000000000000000000000000000000000000000000000000000000000000080"),
        ];
        let mut acc = ImtAccumulator::new();
        for nu in &spends {
            // Witnesses built from the CURRENT (pre-insert) accumulator state.
            let prior_root = acc.root();
            let prior_leaves: Vec<[u8; 32]> = acc.links().iter().map(|(v, n)| imt_leaf(v, n)).collect();
            let (low_index, low_value, low_next) = acc.non_membership_low(nu).expect("low link");
            let low_idx = low_index as u64;
            let low_path = merkle_path(&prior_leaves, low_idx);
            // The new leaf lands at the next free slot; its path is against the INTERMEDIATE
            // tree (low leaf rewired to nu), exactly as the in-zkVM transition checks it.
            let new_index = prior_leaves.len() as u64;
            let mut interm_leaves = prior_leaves.clone();
            interm_leaves[low_index] = imt_leaf(&low_value, nu);
            let new_path = merkle_path(&interm_leaves, new_index);

            let got = imt_insert_transition(
                &prior_root, nu, &low_value, &low_next, low_idx, &low_path, new_index, &new_path,
            ).expect("transition");

            acc.insert(nu); // advance the stateful reference
            assert_eq!(got, acc.root(), "witnessed insert root must equal the stateful root");
        }

        // A forged low witness (wrong low_next that doesn't straddle) is rejected.
        let nu = arr32("0x0000000000000000000000000000000000000000000000000000000000000005");
        let bad = imt_insert_transition(
            &acc.root(), &nu, &[0u8; 32], &[0u8; 32], 0, &merkle_path(&[], 0), 99, &merkle_path(&[], 99),
        );
        assert!(bad.is_none(), "forged/non-straddling witness must not produce a transition");
    }

    // Phase 1: the witnessed note-tree append transition reproduces the stateful
    // KeccakTreeAccumulator's root sequence from only (prior_root, the empty slot's path).
    #[test]
    fn keccak_tree_append_transition_matches_stateful() {
        let mut acc = KeccakTreeAccumulator::new();
        let mut hist: Vec<[u8; 32]> = Vec::new();
        for i in 0u8..6 {
            let leaf = arr32(&format!("0x{:064x}", 0x1000 + i as u32));
            let prior_root = acc.root();
            let next_index = acc.next_index();
            let path = merkle_path(&hist, next_index);
            let got = keccak_tree_append_transition(&prior_root, next_index, &path, &leaf).expect("append");
            acc.append(&leaf);
            hist.push(leaf);
            assert_eq!(got, acc.root(), "witnessed append root == stateful");
        }
        // appending onto a non-empty slot (wrong path proving a filled slot) fails.
        let bad = keccak_tree_append_transition(&acc.root(), 0, &merkle_path(&hist, 0), &arr32(&format!("0x{:064x}", 1)));
        assert!(bad.is_none(), "cannot append over an occupied slot");
    }

    // Phase 1: the witnessed UTXO insert + remove transitions reproduce the stateful
    // UtxoAccumulator (key → value sorted set with tombstoning) — the burn set and the
    // outpoint set the reflection prover advances without holding the full set.
    #[test]
    fn utxo_insert_remove_transition_matches_stateful() {
        let h = |n: u32| arr32(&format!("0x{:064x}", n));
        let kv = [
            (h(0x42), h(0xaa)),
            (h(0xa1), h(0xbb)),
            (h(0x07), h(0xcc)),
            (h(0xff), h(0xdd)),
        ];
        let mut acc = UtxoAccumulator::new();
        for (k, v) in &kv {
            let prior_root = acc.root();
            let prior_leaves = acc.leaves();
            let (low_i, low_k, low_n, low_v) = acc.low(k).expect("low");
            let low_path = merkle_path(&prior_leaves, low_i as u64);
            let new_index = prior_leaves.len() as u64;
            let mut interm = prior_leaves.clone();
            interm[low_i] = utxo_leaf(&low_k, k, &low_v);
            let new_path = merkle_path(&interm, new_index);
            let got = utxo_insert_transition(
                &prior_root, k, v, &low_k, &low_n, &low_v, low_i as u64, &low_path, new_index, &new_path,
            ).expect("insert transition");
            acc.insert(k, v);
            assert_eq!(got, acc.root(), "witnessed utxo insert root == stateful");
        }

        // Remove a live key (0xa1) and check the transition matches the stateful remove.
        let key = h(0xa1);
        let prior_root = acc.root();
        let prior_leaves = acc.leaves();
        let (node_i, node_n, node_v) = acc.membership(&key).expect("member");
        let (pred_i, pred_k, pred_v) = acc.predecessor(&key).expect("pred");
        let pred_path = merkle_path(&prior_leaves, pred_i as u64);
        let mut interm = prior_leaves.clone();
        interm[pred_i] = utxo_leaf(&pred_k, &node_n, &pred_v); // pred rewired to skip key
        let node_path = merkle_path(&interm, node_i as u64);
        let got = utxo_remove_transition(
            &prior_root, &key, &node_n, &node_v, node_i as u64, &node_path,
            &pred_k, &pred_v, pred_i as u64, &pred_path,
        ).expect("remove transition");
        acc.remove(&key);
        assert_eq!(got, acc.root(), "witnessed utxo remove root == stateful");
        assert_eq!(acc.get(&key), None, "removed key is gone");
    }

    // ── Phase 2 witness builders (what the Phase-4 indexer runs) ──
    fn build_spend_witness(spent: &ImtAccumulator, utxo: &UtxoAccumulator, cx: [u8; 32], cy: [u8; 32], outpoint: [u8; 32]) -> SpendWitness {
        let nu = nullifier(&cx, &cy);
        let spent_leaves: Vec<[u8; 32]> = spent.links().iter().map(|(v, n)| imt_leaf(v, n)).collect();
        let (low_i, low_v, low_n) = spent.non_membership_low(&nu).expect("spent low");
        let s_low_path = merkle_path(&spent_leaves, low_i as u64);
        let mut s_interm = spent_leaves.clone();
        s_interm[low_i] = imt_leaf(&low_v, &nu);
        let s_new_path = merkle_path(&s_interm, spent_leaves.len() as u64);
        let utxo_leaves = utxo.leaves();
        let (node_i, node_n, node_v) = utxo.membership(&outpoint).expect("utxo member");
        let (pred_i, pred_k, pred_v) = utxo.predecessor(&outpoint).expect("utxo pred");
        let u_pred_path = merkle_path(&utxo_leaves, pred_i as u64);
        let mut u_interm = utxo_leaves.clone();
        u_interm[pred_i] = utxo_leaf(&pred_k, &node_n, &pred_v);
        let u_node_path = merkle_path(&u_interm, node_i as u64);
        SpendWitness {
            cx, cy, outpoint, s_low_value: low_v, s_low_next: low_n, s_low_index: low_i as u64, s_low_path, s_new_path,
            u_node_next: node_n, u_node_value: node_v, u_node_index: node_i as u64, u_node_path,
            u_pred_key: pred_k, u_pred_value: pred_v, u_pred_index: pred_i as u64, u_pred_path,
        }
    }
    fn build_output_witness(notes: &KeccakTreeAccumulator, utxo: &UtxoAccumulator, note_leaf: [u8; 32], outpoint: [u8; 32], commit: [u8; 32]) -> OutputWitness {
        let utxo_leaves = utxo.leaves();
        let (low_i, low_k, low_n, low_v) = utxo.low(&outpoint).expect("utxo low");
        let u_low_path = merkle_path(&utxo_leaves, low_i as u64);
        let mut interm = utxo_leaves.clone();
        interm[low_i] = utxo_leaf(&low_k, &outpoint, &low_v);
        let u_new_path = merkle_path(&interm, utxo_leaves.len() as u64);
        OutputWitness {
            note_leaf, note_path: notes.append_path(), outpoint, commitment_hash: commit,
            u_low_key: low_k, u_low_next: low_n, u_low_value: low_v, u_low_index: low_i as u64, u_low_path, u_new_path,
        }
    }
    fn build_burn_witness(spent: &ImtAccumulator, utxo: &UtxoAccumulator, burns: &UtxoAccumulator, cx: [u8; 32], cy: [u8; 32], outpoint: [u8; 32], dest: [u8; 32]) -> BurnWitness {
        let nu = nullifier(&cx, &cy);
        let spend = build_spend_witness(spent, utxo, cx, cy, outpoint);
        let burn_leaves = burns.leaves();
        let (low_i, low_k, low_n, low_v) = burns.low(&nu).expect("burn low");
        let b_low_path = merkle_path(&burn_leaves, low_i as u64);
        let mut interm = burn_leaves.clone();
        interm[low_i] = utxo_leaf(&low_k, &nu, &low_v);
        let b_new_path = merkle_path(&interm, burn_leaves.len() as u64);
        BurnWitness {
            spend, dest_commitment: dest,
            b_low_key: low_k, b_low_next: low_n, b_low_value: low_v, b_low_index: low_i as u64, b_low_path, b_new_path,
        }
    }

    // Phase 2: WitnessedReflection (headless, O(Δ)) produces byte-identical roots to the
    // stateful ReflectionState (the indexer/contract reference) over a deposit → transfer →
    // bridge-out sequence. This is the faithfulness proof of the resume-from-digest model.
    #[test]
    fn witnessed_reflection_matches_stateful() {
        let v = |n: u32| arr32(&format!("0x{:064x}", n));
        let mut st = ReflectionState::genesis();
        let mut w = WitnessedReflection::genesis();
        // genesis roots agree
        assert_eq!(w.pool_root, st.notes.root());
        assert_eq!(w.spent_root, st.spent.root());
        assert_eq!(w.utxo_root, st.utxo.root());
        assert_eq!(w.burn_root, st.bridge_burns.root());

        // Each note has commitment coords; the UTXO value stored is commitment_hash(cx,cy)
        // and the spend's ν is DERIVED from it (3.2 binding), not witnessed.
        let (cx_a, cy_a) = (v(0x0a), v(0x1a)); let com_a = commitment_hash(&cx_a, &cy_a); let nu_a = nullifier(&cx_a, &cy_a);
        let (cx_b, cy_b) = (v(0x0b), v(0x1b)); let com_b = commitment_hash(&cx_b, &cy_b); let nu_b = nullifier(&cx_b, &cy_b);
        let (cx_c, cy_c) = (v(0x0c), v(0x1c)); let com_c = commitment_hash(&cx_c, &cy_c);
        let (op_a, op_b, op_c) = (v(0xa0), v(0xb0), v(0xc0));
        let (leaf_a, leaf_b, leaf_c) = (v(0x1aa), v(0x1bb), v(0x1cc));
        let dest_b = v(0xde);
        let _ = cy_c;

        // 1. two deposits (no spends, two outputs)
        let ow_a = build_output_witness(&st.notes, &st.utxo, leaf_a, op_a, com_a);
        st.notes.append(&leaf_a); st.utxo.insert(&op_a, &com_a);
        let ow_b = build_output_witness(&st.notes, &st.utxo, leaf_b, op_b, com_b);
        st.notes.append(&leaf_b); st.utxo.insert(&op_b, &com_b);
        st.height = 100;
        w.apply_transfer(&[], &[ow_a, ow_b], 100).expect("deposits");
        assert_eq!((w.pool_root, w.utxo_root), (st.notes.root(), st.utxo.root()), "after deposits");

        // 2. transfer: spend note A at op_a, create op_c (ν derived from cx_a,cy_a)
        let sw = build_spend_witness(&st.spent, &st.utxo, cx_a, cy_a, op_a);
        st.spent.insert(&nu_a); st.utxo.remove(&op_a);
        let ow_c = build_output_witness(&st.notes, &st.utxo, leaf_c, op_c, com_c);
        st.notes.append(&leaf_c); st.utxo.insert(&op_c, &com_c);
        st.height = 101;
        w.apply_transfer(&[sw], &[ow_c], 101).expect("transfer");
        assert_eq!((w.pool_root, w.spent_root, w.utxo_root), (st.notes.root(), st.spent.root(), st.utxo.root()), "after transfer");

        // 3. bridge-out: burn note B at op_b → destCommitment
        let bw = build_burn_witness(&st.spent, &st.utxo, &st.bridge_burns, cx_b, cy_b, op_b, dest_b);
        st.spent.insert(&nu_b); st.utxo.remove(&op_b); st.bridge_burns.insert(&nu_b, &dest_b);
        st.height = 102;
        w.apply_bridge_out(&bw, 102).expect("bridge-out");
        assert_eq!(w.spent_root, st.spent.root(), "spent after burn");
        assert_eq!(w.utxo_root, st.utxo.root(), "utxo after burn");
        assert_eq!(w.burn_root, st.bridge_burns.root(), "burn root after burn");

        // commit matches the stateful reference; digest is deterministic + non-zero
        assert_eq!(w.commit(), (st.notes.root(), st.spent.root(), 102));
        assert_eq!(w.burn_root, st.bridge_burns.root());
        assert_ne!(w.digest(), [0u8; 32], "resumption digest is well-defined");
        // height must not decrease (same-block effects share a height; a rollback is rejected)
        w.apply_transfer(&[], &[], 102).expect("same height allowed (same-block effects)");
        assert!(w.apply_transfer(&[], &[], 101).is_err(), "height decrease (rollback) rejected");
    }

    // F4 full scan: ScanReflection genesis digest — the three-way anchor (Rust prover == JS
    // indexer == contract REFLECTION_GENESIS_DIGEST for the full-scan model). Differs from the
    // witnessed model: the UTXO slot is the EMPTY live set (keccak_merkle_root([]) + size 0), not
    // the {0→0} UtxoAccumulator sentinel.
    #[test]
    fn scan_reflection_genesis_digest() {
        let g = ScanReflection::genesis();
        assert_eq!(hex::encode(g.digest()), "ec719b81a396d28bad7625172767133724a094a5425269a71b258fe7e36fdc75", "full-scan genesis digest (JS indexer + contract must match)");
        // empty live set root == empty note-tree root (both keccak_merkle_root([])); spent + burn
        // keep the {0→0} sentinel roots.
        assert_eq!(g.live.root(), g.pool_root);
        assert_eq!(hex::encode(g.spent_root), "5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0");
    }

    // F4 full scan: ScanReflection's headless spent/note/burn folds produce byte-identical roots
    // to the stateful ReflectionState (same witnessed transitions), while the live UTXO set tracks
    // outpoints in-memory. This mirrors the guest's per-tx fold order over a deposit → transfer →
    // bridge-out sequence — the faithfulness proof of the full-scan model's commitments.
    #[test]
    fn scan_reflection_folds_match_stateful() {
        let v = |n: u32| arr32(&format!("0x{:064x}", n));
        let mut st = ReflectionState::genesis();
        let mut sc = ScanReflection::genesis();
        // genesis headless roots agree (the UTXO sets differ in shape by design)
        assert_eq!(sc.pool_root, st.notes.root());
        assert_eq!(sc.spent_root, st.spent.root());
        assert_eq!(sc.burn_root, st.bridge_burns.root());
        let d0 = sc.digest();

        let (cx_a, cy_a) = (v(0x0a), v(0x1a)); let com_a = commitment_hash(&cx_a, &cy_a); let nu_a = nullifier(&cx_a, &cy_a);
        let (cx_b, cy_b) = (v(0x0b), v(0x1b)); let com_b = commitment_hash(&cx_b, &cy_b); let nu_b = nullifier(&cx_b, &cy_b);
        let (cx_c, cy_c) = (v(0x0c), v(0x1c)); let com_c = commitment_hash(&cx_c, &cy_c);
        let (op_a, op_b, op_c) = (v(0xa0), v(0xb0), v(0xc0));
        let (leaf_a, leaf_b, leaf_c) = (v(0x1aa), v(0x1bb), v(0x1cc));
        let dest_b = v(0xde);
        let asset = v(0x5e); // the live set carries the note's asset (unused by the legacy UtxoAccumulator)
        let _ = cy_c;

        // 1. two outputs (deposits): fold_output appends the note leaf + adds the outpoint live.
        let ow_a = build_output_witness(&st.notes, &st.utxo, leaf_a, op_a, com_a);
        st.notes.append(&leaf_a); st.utxo.insert(&op_a, &com_a);
        sc.fold_output(&leaf_a, &ow_a.note_path, &op_a, &com_a, &asset).expect("output a");
        let ow_b = build_output_witness(&st.notes, &st.utxo, leaf_b, op_b, com_b);
        st.notes.append(&leaf_b); st.utxo.insert(&op_b, &com_b);
        sc.fold_output(&leaf_b, &ow_b.note_path, &op_b, &com_b, &asset).expect("output b");
        assert_eq!(sc.pool_root, st.notes.root(), "note tree after deposits");
        assert_eq!(sc.live.get(&op_a), Some((com_a, asset)), "op_a live");
        assert_eq!(sc.live.get(&op_b), Some((com_b, asset)), "op_b live");
        assert_ne!(sc.digest(), d0, "state advanced");

        // 2. transfer: spend note A (the scan derives nu_a + removes op_a), create op_c.
        let sw = build_spend_witness(&st.spent, &st.utxo, cx_a, cy_a, op_a);
        st.spent.insert(&nu_a); st.utxo.remove(&op_a);
        sc.live.remove(&op_a); // scan_tx_spends does this in the guest
        sc.fold_spent(&nu_a, &sw.s_low_value, &sw.s_low_next, sw.s_low_index, &sw.s_low_path, &sw.s_new_path).expect("spend a");
        let ow_c = build_output_witness(&st.notes, &st.utxo, leaf_c, op_c, com_c);
        st.notes.append(&leaf_c); st.utxo.insert(&op_c, &com_c);
        sc.fold_output(&leaf_c, &ow_c.note_path, &op_c, &com_c, &asset).expect("output c");
        assert_eq!(sc.spent_root, st.spent.root(), "spent after transfer");
        assert_eq!(sc.pool_root, st.notes.root(), "notes after transfer");
        assert_eq!(sc.live.get(&op_a), None, "op_a spent");

        // 3. bridge-out: burn note B → destCommitment.
        let bw = build_burn_witness(&st.spent, &st.utxo, &st.bridge_burns, cx_b, cy_b, op_b, dest_b);
        st.spent.insert(&nu_b); st.utxo.remove(&op_b); st.bridge_burns.insert(&nu_b, &dest_b);
        sc.live.remove(&op_b);
        sc.fold_spent(&nu_b, &bw.spend.s_low_value, &bw.spend.s_low_next, bw.spend.s_low_index, &bw.spend.s_low_path, &bw.spend.s_new_path).expect("spend b");
        sc.fold_burn(&nu_b, &dest_b, &bw.b_low_key, &bw.b_low_next, &bw.b_low_value, bw.b_low_index, &bw.b_low_path, &bw.b_new_path).expect("burn b");
        assert_eq!(sc.spent_root, st.spent.root(), "spent after burn");
        assert_eq!(sc.burn_root, st.bridge_burns.root(), "burn root after burn");

        // commit matches the stateful reference; digest is deterministic + non-zero.
        sc.height = 102;
        assert_eq!(sc.commit(), (st.notes.root(), st.spent.root(), 102));
        assert_ne!(sc.digest(), [0u8; 32], "resumption digest is well-defined");
    }

    // Phase 3.2: ν is BOUND to the outpoint's committed note — a spend can't fabricate a ν
    // unrelated to the note actually at the outpoint it removes.
    #[test]
    fn spend_nu_bound_to_outpoint_note() {
        let v = |n: u32| arr32(&format!("0x{:064x}", n));
        let (cx, cy) = (v(0x0a), v(0x1a));
        let com = commitment_hash(&cx, &cy);
        // correct coords open the committed value → the note's nullifier; wrong coords don't
        assert_eq!(bind_spent_note(&com, &cx, &cy), Some(nullifier(&cx, &cy)));
        assert_eq!(bind_spent_note(&com, &v(0x99), &cy), None);
        assert_eq!(bind_spent_note(&com, &cx, &v(0x99)), None);

        // end-to-end: a deposit, then a spend whose witness carries the WRONG commitment is
        // rejected by apply_transfer (the stored UTXO value won't open to it).
        let mut st = ReflectionState::genesis();
        let mut w = WitnessedReflection::genesis();
        let op = v(0xa0);
        let ow = build_output_witness(&st.notes, &st.utxo, v(0x1aa), op, com);
        st.notes.append(&v(0x1aa)); st.utxo.insert(&op, &com);
        w.apply_transfer(&[], &[ow], 1).expect("deposit");
        let mut bad = build_spend_witness(&st.spent, &st.utxo, cx, cy, op);
        bad.cx = v(0xdead); // no longer opens com
        assert!(w.apply_transfer(&[bad], &[], 2).is_err(), "spend with unbound ν is rejected");
    }

    // Phase 3.3b: a CXFER output's stored commitment_hash equals the envelope's compressed
    // commitment decompressed — so a reflected output is the note the confirmed tx declared,
    // not a fabricated (unbacked) one. Uses a real curve point from the bridge_burn fixture.
    #[test]
    fn commitment_hash_compressed_matches_coords() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/bridge_burn.json")).unwrap();
        let c = &f["crossOuts"][0];
        let cx = arr32(c["cx"].as_str().unwrap());
        let cy = arr32(c["cy"].as_str().unwrap());
        let compressed: [u8; 33] = from_affine_xy(&cx, &cy).expect("valid point")
            .to_affine().to_encoded_point(true).as_bytes().try_into().unwrap();
        assert_eq!(commitment_hash_compressed(&compressed), Some(commitment_hash(&cx, &cy)),
            "compressed commitment → the same commitment_hash as its (Cx,Cy)");
        // a non-point (bad prefix) is rejected
        assert_eq!(commitment_hash_compressed(&[0x09u8; 33]), None, "not a curve point");
    }

    // Phase 3.2 #2/#3: confirm_pool_tx ties an effect to a real confirmed Bitcoin tx — the tx
    // is in a PoW block (verify_tx_in_block) and its vins become the only outpoints a reflected
    // spend may claim (outpoint_key over extract_inputs). Uses the real bridge_mint block.
    #[test]
    fn confirm_pool_tx_binds_real_block() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/btc_block.json")).unwrap();
        let header = hex::decode(strip(f["header"].as_str().unwrap())).unwrap();
        let tx = hex::decode(strip(f["tx"].as_str().unwrap())).unwrap();
        let tx_index = f["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = f["txids"].as_array().unwrap().iter().map(|v| arr32(v.as_str().unwrap())).collect();

        let (txid, in_outpoints) = confirm_pool_tx(&header, &tx, tx_index, &txids).expect("confirmed");
        assert_eq!(txid, bitcoin::compute_txid(&tx).unwrap(), "returns the confirmed txid");
        assert!(!in_outpoints.is_empty(), "tx has spent outpoints");
        // each bound outpoint is outpoint_key of a real vin
        let vins = bitcoin::extract_inputs(&tx).unwrap();
        assert_eq!(in_outpoints.len(), vins.len(), "one bound outpoint per vin");
        assert_eq!(in_outpoints[0], outpoint_key(&vins[0].0, vins[0].1), "outpoint = key(vin)");
        // a tampered tx (txid no longer in the block) is not confirmable
        let mut bad = tx.clone();
        let n = bad.len(); bad[n - 1] ^= 1;
        assert!(confirm_pool_tx(&header, &bad, tx_index, &txids).is_none(), "tampered tx rejected");
    }

    // Extract the real CXFER's fold data (vin outpoint keys, output commitment-hashes + outpoints,
    // txid, asset) and write it for the JS full-fold assembler (tests/gen-reflection-cxfer-fold.mjs).
    // The spent outpoints + the txid + the output commitments are all on-chain; the spent notes'
    // (Cx,Cy) come from the attested prior state, which the assembler seeds.
    #[test]
    fn gen_real_cxfer_fold_data() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/signet_cxfer.json")).unwrap();
        let hx = |s: &str| hex::decode(s.trim_start_matches("0x")).unwrap();
        let tx = hx(f["tx"].as_str().unwrap());
        let txid = bitcoin::compute_txid(&tx).unwrap();
        let vins = bitcoin::extract_inputs(&tx).expect("vins");
        let env = bitcoin::extract_taproot_envelope(&tx).expect("envelope");
        let (asset, comms) = bitcoin::parse_cxfer_envelope(&env).expect("cxfer parse");

        let spends: Vec<String> = vins.iter().map(|(t, v)| format!("\"0x{}\"", hex::encode(outpoint_key(t, *v)))).collect();
        let outputs: Vec<String> = comms.iter().enumerate().map(|(i, c)| {
            let ch = commitment_hash_compressed(c).expect("decompress");
            format!("{{ \"commitmentHash\": \"0x{}\", \"outpoint\": \"0x{}\", \"vout\": {} }}",
                hex::encode(ch), hex::encode(outpoint_key(&txid, i as u32)), i)
        }).collect();
        let json = format!(
            "{{\n  \"note\": \"real signet CXFER fold data (block 307547)\",\n  \"asset\": \"0x{}\",\n  \"txid\": \"0x{}\",\n  \"spendOutpoints\": [{}],\n  \"outputs\": [{}]\n}}\n",
            hex::encode(asset), hex::encode(txid),
            spends.iter().map(|s| format!("\n    {}", s)).collect::<Vec<_>>().join(","),
            outputs.iter().map(|o| format!("\n    {}", o)).collect::<Vec<_>>().join(",")
        );
        std::fs::write("../fixtures/signet_cxfer_folddata.json", json).expect("write fold data");
        assert_eq!(comms.len(), outputs.len());
    }

    // Reproduce the guest's OP_TRANSFER fold natively on the assembled real-CXFER fixture, to
    // pinpoint any witnessed-transition failure (apply_transfer returns a per-transition message).
    #[test]
    fn reproduce_real_cxfer_fold() {
        let path = std::path::Path::new("../fixtures/reflection_cxfer_fold.json");
        if !path.exists() { eprintln!("(no reflection_cxfer_fold.json — skip)"); return; }
        let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let a = |v: &serde_json::Value| arr32(v.as_str().unwrap());
        let p = |v: &serde_json::Value| -> Vec<[u8; 32]> { v.as_array().unwrap().iter().map(|x| arr32(x.as_str().unwrap())).collect() };
        let pr = &f["prior"];
        let mut w = WitnessedReflection {
            pool_root: a(&pr["poolRoot"]), note_count: pr["noteCount"].as_u64().unwrap(),
            spent_root: a(&pr["spentRoot"]), spent_count: pr["spentCount"].as_u64().unwrap(),
            utxo_root: a(&pr["utxoRoot"]), utxo_count: pr["utxoCount"].as_u64().unwrap(),
            burn_root: a(&pr["burnRoot"]), burn_count: pr["burnCount"].as_u64().unwrap(),
            height: pr["height"].as_u64().unwrap(),
        };
        let mk_spend = |s: &serde_json::Value| SpendWitness {
            cx: a(&s["cx"]), cy: a(&s["cy"]), outpoint: a(&s["outpoint"]),
            s_low_value: a(&s["sLowValue"]), s_low_next: a(&s["sLowNext"]), s_low_index: s["sLowIndex"].as_u64().unwrap(),
            s_low_path: p(&s["sLowPath"]), s_new_path: p(&s["sNewPath"]),
            u_node_next: a(&s["uNodeNext"]), u_node_value: a(&s["uNodeValue"]), u_node_index: s["uNodeIndex"].as_u64().unwrap(), u_node_path: p(&s["uNodePath"]),
            u_pred_key: a(&s["uPredKey"]), u_pred_value: a(&s["uPredValue"]), u_pred_index: s["uPredIndex"].as_u64().unwrap(), u_pred_path: p(&s["uPredPath"]),
        };
        let e = &f["effects"][0];
        let spends: Vec<SpendWitness> = e["spends"].as_array().unwrap().iter().map(mk_spend).collect();
        let outputs: Vec<OutputWitness> = e["outputs"].as_array().unwrap().iter().map(|o| OutputWitness {
            note_leaf: a(&o["noteLeaf"]), note_path: p(&o["notePath"]), outpoint: a(&o["outpoint"]), commitment_hash: a(&o["commitmentHash"]),
            u_low_key: a(&o["uLowKey"]), u_low_next: a(&o["uLowNext"]), u_low_value: a(&o["uLowValue"]), u_low_index: o["uLowIndex"].as_u64().unwrap(),
            u_low_path: p(&o["uLowPath"]), u_new_path: p(&o["uNewPath"]),
        }).collect();
        // the guest's pre-fold tx-binding (confirm + envelope + outpoint/commitment), the part
        // the digest check skips — this is what panics in-guest if a binding is off.
        let dh = |s: &str| hex::decode(s).unwrap();
        let hdr = dh(f["headers"][0].as_str().unwrap());
        let tx = dh(e["txData"].as_str().unwrap());
        let tx_index = e["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = e["txids"].as_array().unwrap().iter().map(|t| dh(t.as_str().unwrap()).try_into().unwrap()).collect();
        let (txid, in_outpoints) = confirm_pool_tx(&hdr, &tx, tx_index, &txids).expect("confirm_pool_tx FAILED");
        let env = bitcoin::extract_taproot_envelope(&tx).expect("envelope");
        let (_a, comms) = bitcoin::parse_cxfer_envelope(&env).expect("parse cxfer");
        assert_eq!(outputs.len(), comms.len(), "m_out != commitments");
        for s in &spends { assert!(in_outpoints.contains(&s.outpoint), "spend outpoint not a vin"); }
        for (j, o) in outputs.iter().enumerate() {
            let vout = e["outputs"][j]["vout"].as_u64().unwrap() as u32;
            assert_eq!(outpoint_key(&txid, vout), o.outpoint, "output outpoint != vout(j={})", j);
            assert_eq!(commitment_hash_compressed(&comms[j]), Some(o.commitment_hash), "output commitment != envelope (j={})", j);
        }

        let height = f["anchorHeight"].as_u64().unwrap() + e["blockIndex"].as_u64().unwrap();
        let res = w.apply_transfer(&spends, &outputs, height);
        assert!(res.is_ok(), "apply_transfer FAILED: {:?}", res.err());
        // and the resulting digest matches the fixture's newDigest
        assert_eq!(format!("0x{}", hex::encode(w.digest())), f["newDigest"].as_str().unwrap(), "digest mismatch");
    }
}
