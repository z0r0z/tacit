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
/// nullifier = keccak(note_secret) — chain-independent (Phase-3 tee-up).
pub fn nullifier(secret: &[u8; 32]) -> [u8; 32] { kn(&[secret]) }
/// deposit id = keccak(asset_id ‖ amount_be32 ‖ Cx ‖ Cy ‖ owner) — matches wrap().
pub fn deposit_id(asset_id: &[u8; 32], amount_be32: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    kn(&[asset_id, amount_be32, cx, cy, owner])
}
/// claimId = keccak(abi.encodePacked(destChain:uint16, destCommitment, nullifier,
/// asset_id)) — matches ConfidentialPool.settle's on-chain re-derivation and the
/// dapp prover. Binds a cross-chain burn to exactly one mintable destination.
pub fn claim_id(dest_chain: u16, dest_commitment: &[u8; 32], nullifier: &[u8; 32], asset_id: &[u8; 32]) -> [u8; 32] {
    kn(&[&dest_chain.to_be_bytes(), dest_commitment, nullifier, asset_id])
}

/// Membership against the on-chain Keccak incremental Merkle root.
pub fn keccak_merkle_verify(leaf: &[u8; 32], mut index: u64, path: &[[u8; 32]], root: &[u8; 32]) -> bool {
    if path.len() != 32 { return false; }
    let mut h = *leaf;
    for sib in path {
        h = if index & 1 == 0 { k2(&h, sib) } else { k2(sib, &h) };
        index >>= 1;
    }
    &h == root
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
            let secret = arr32(note["secret"].as_str().unwrap());
            assert_eq!(nullifier(&secret), arr32(note["nullifier"].as_str().unwrap()), "nullifier");
            let amount: u64 = note["amount"].as_str().unwrap().parse().unwrap();
            assert_eq!(deposit_id(&asset, &u64_be32(amount), &cx, &cy, &owner), arr32(note["depositId"].as_str().unwrap()), "depositId");

            // Pedersen opening: C reconstructed from (cx,cy) opens to (value, blinding).
            let c = from_affine_xy(&cx, &cy).unwrap();
            let value: u64 = note["value"].as_str().unwrap().parse().unwrap();
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
}
