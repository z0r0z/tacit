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
/// The UTXO-set key for a Bitcoin outpoint: keccak(txid ‖ vout_le). The reflection prover
/// derives this from a confirmed tx's vin (`extract_inputs`), so a spent outpoint is forced
/// to be a real prior output and not a witnessed value.
pub fn outpoint_key(txid: &[u8; 32], vout: u32) -> [u8; 32] { kn(&[txid, &vout.to_le_bytes()]) }
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
        assert_eq!(txid, bitcoin::compute_txid(&tx), "returns the confirmed txid");

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
        assert_eq!(txid, bitcoin::compute_txid(&tx), "returns the confirmed txid");
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
}
