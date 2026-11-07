//! A Tacit block: checks every spend proof in it with one pairing, as btc-pool-agg does, and moves the state
//! the block starts from by all of them (tacit-block-common `apply`).
//!
//! stdin (raw buffers): the starting state (`State::to_bytes`), n (u32 LE), then per spend: publics (12 ×
//! 32-byte big-endian field elements), proof (2,080 bytes), hints (20 × 64 bytes) and the rest of its body and
//! openings (`SpendData::to_bytes`); then m (u32 LE), the next forced spends of the landing contract's queue, each
//! as what was posted and the builder's answers (`Answers::to_bytes`: whether its proof verifies, then for each live
//! nullifier 0, or 1 and the `NfMember` that shows the note spent before this block); then one buffer of the
//! nullifier witnesses of every spend taken (`NfWitness::to_bytes`, smallest first).
//! Public values: `BlockOut::encode`, twelve 32-byte words. The guest panics, so no proof is produced, unless
//! every proof of the block's own verifies and the block applies. Posted bytes face the cheap checks first (a spend,
//! no note of it spent, its body and openings) and only then their proof: one the builder says verifies joins the
//! block's one pairing, and one it says does not is checked on its own and must fail. Whatever does not pass is
//! passed over: what anyone posted cannot stop a block, and junk costs a block next to nothing.
#![no_main]
sp1_zkvm::entrypoint!(main);

use btc_pool_agg_common::{self as agg, Batch, HintRead, Mode};
use ff::{Field, PrimeField};
use halo2_proofs::halo2curves::bn256::{Fr, G1Affine, G2Affine};
use halo2_proofs::plonk::{ConstraintSystem, VerifyingKey};
use halo2_proofs::SerdeFormat;
use sp1_lib::bn254::Bn254Point;
use sp1_lib::utils::{AffinePoint, WeierstrassAffinePoint};
use tacit_block_common::{self as blk, Answers, NfWitness, Posted, Spend, SpendData, State, NF_WITNESS_LEN};

/// The pinned spend verification key, its digest and transcript representative, and the verifier params, as
/// `tacit-block pin` derives them (the same values btc-pool-agg pins).
const VK: &[u8] = include_bytes!("../../../btc-pool-halo2/artifacts/vk.bin");
const VK_DIGEST: [u8; 64] = *include_bytes!("../../artifacts/vk-digest.bin");
const VK_REPR: [u8; 32] = *include_bytes!("../../artifacts/vk-repr.bin");
const PARAMS: &[u8] = include_bytes!("../../artifacts/verifier-params.bin");
/// The spend circuit's finished constraint system without its custom gates, and those gates as one flat program with
/// the system's degree (`tacit-block pin`), so the key is read without running the circuit's configure and selector
/// compression or building the gates' expression trees.
const CS: &[u8] = include_bytes!("../../artifacts/verifier-cs.bin");
const GATES: &[u8] = include_bytes!("../../artifacts/verifier-gates.bin");

fn read_u32() -> u32 {
    let b = sp1_zkvm::io::read_vec();
    assert_eq!(b.len(), 4, "n");
    u32::from_le_bytes(b.try_into().unwrap())
}

pub fn main() {
    println!("cycle-tracker-report-start: read");
    let state = State::from_bytes(&sp1_zkvm::io::read_vec()).expect("starting state");
    let n = read_u32() as usize;
    let mut raw = Vec::with_capacity(n);
    let mut spends = Vec::with_capacity(n);
    let mut data = Vec::with_capacity(n);
    for _ in 0..n {
        let publics = sp1_zkvm::io::read_vec();
        let proof = sp1_zkvm::io::read_vec();
        let hints = sp1_zkvm::io::read_vec();
        assert_eq!(publics.len(), agg::PUBLICS_LEN, "publics length");
        assert_eq!(proof.len(), agg::PROOF_LEN, "proof length");
        assert_eq!(hints.len(), agg::HINTS_LEN, "hints length");
        let p = agg::publics_from_be(&publics).expect("publics not canonical");
        data.push(SpendData::from_bytes(&sp1_zkvm::io::read_vec()).expect("spend data"));
        spends.push(Spend::from_publics(&p));
        raw.push((publics, p, proof, hints));
    }
    let k = read_u32() as usize;
    let settles: Vec<blk::lock::Settle> = (0..k).map(|_| blk::lock::Settle::from_bytes(&sp1_zkvm::io::read_vec()).expect("settle")).collect();
    let time = u64::from_le_bytes(sp1_zkvm::io::read_vec().try_into().expect("time"));
    let blobs = sp1_zkvm::io::read_vec();
    let m = read_u32() as usize;
    assert!(n + k + m >= 1, "an empty block");
    let posted_raw: Vec<(Vec<u8>, Vec<u8>)> = (0..m).map(|_| (sp1_zkvm::io::read_vec(), sp1_zkvm::io::read_vec())).collect();
    let witnesses = sp1_zkvm::io::read_vec();
    assert_eq!(witnesses.len() % NF_WITNESS_LEN, 0, "nullifier witnesses length");
    let nfw: Vec<NfWitness> = witnesses.chunks(NF_WITNESS_LEN).map(|c| NfWitness::from_bytes(c).expect("nullifier witness")).collect();
    println!("cycle-tracker-report-end: read");

    // The posted spends as the cheap checks leave them, before any proof is looked at.
    println!("cycle-tracker-report-start: forced-checks");
    let answers: Vec<Answers> = posted_raw.iter().map(|(_, a)| Answers::from_bytes(a).expect("forced answers")).collect();
    let posted: Vec<Posted> = posted_raw
        .iter()
        .zip(&answers)
        .enumerate()
        .map(|(j, ((p, _), a))| blk::posted(&state, p, &a.members, time).unwrap_or_else(|e| panic!("forced spend {j}: {e}")))
        .collect();
    println!("cycle-tracker-report-end: forced-checks");

    println!("cycle-tracker-report-start: proofs");
    println!("cycle-tracker-report-start: vk-read");
    let repr = Option::from(Fr::from_repr(VK_REPR)).expect("vk repr");
    let (cs, degree) = ConstraintSystem::<Fr>::from_compact(CS).expect("verifier constraint system");
    let vk = VerifyingKey::<G1Affine>::read_with_program(&mut &VK[..], SerdeFormat::RawBytes, cs, degree, repr, GATES).expect("vk");
    println!("cycle-tracker-report-end: vk-read");
    let params = agg::verifier_params(PARAMS).expect("params");
    let (_, _, g2, s_g2) = agg::decode_params(PARAMS).expect("params");

    // Which posted spends the block takes. A proof the builder says verifies joins the pairing below, which then fails if it does not;
    // one it says does not verify must fail here, on its own, so a sound spend cannot be passed over.
    println!("cycle-tracker-report-start: forced");
    let mut joined: Vec<usize> = vec![];
    let taken = blk::take(&spends, &settles, &posted, |j, c| {
        if answers[j].verifies {
            joined.push(j);
            return true;
        }
        let (proof, hints) = blk::forced_proof(&posted_raw[j].0);
        let mut tr = HintRead::new(proof, Mode::Hint(hints, 0));
        if let Ok(dm) = agg::to_dual_msm(&params, &vk, &c.publics, &mut tr) {
            if tr.consumed() && tr.hints_used() == agg::PROOF_POINTS {
                let mut one = Batch::default();
                one.add(&dm, None);
                assert!(!pairs(&one, &g2, &s_g2), "forced spend {j}: a proof said not to verify does");
            }
        }
        false
    });
    println!("cycle-tracker-report-end: forced");

    // One pairing for the block's own proofs and the posted ones said to verify, folded with a challenge drawn from all of them.
    let mut publics_refs: Vec<&[u8]> = raw.iter().map(|s| s.0.as_slice()).collect();
    publics_refs.extend(joined.iter().map(|&j| &posted_raw[j].0[..blk::FORCED_PUBLICS_LEN]));
    let statement = agg::statement(&VK_DIGEST, &publics_refs);
    let total = n + joined.len();
    let r = if total > 1 {
        let mut proofs: Vec<&[u8]> = raw.iter().map(|s| s.2.as_slice()).collect();
        proofs.extend(joined.iter().map(|&j| blk::forced_proof(&posted_raw[j].0).0));
        agg::rlc_challenge(&statement, &proofs)
    } else {
        Fr::ONE
    };
    let mut batch = Batch::default();
    let mut ri = Fr::ONE;
    for (i, (_, publics, proof, hints)) in raw.iter().enumerate() {
        let mut tr = HintRead::new(proof, Mode::Hint(hints, 0));
        let dm = agg::to_dual_msm(&params, &vk, publics, &mut tr).expect("proof rejected before the pairing");
        assert!(tr.consumed() && tr.hints_used() == agg::PROOF_POINTS, "proof not fully read");
        batch.add(&dm, if i == 0 { None } else { Some(ri) });
        ri *= r;
    }
    for (k, &j) in joined.iter().enumerate() {
        let c = posted[j].candidate.as_ref().expect("a joined spend");
        let (proof, hints) = blk::forced_proof(&posted_raw[j].0);
        let mut tr = HintRead::new(proof, Mode::Hint(hints, 0));
        let dm = agg::to_dual_msm(&params, &vk, &c.publics, &mut tr).unwrap_or_else(|e| panic!("forced spend {j}: a proof said to verify does not read: {e:?}"));
        assert!(tr.consumed() && tr.hints_used() == agg::PROOF_POINTS, "forced spend {j}: a proof said to verify is not fully read");
        batch.add(&dm, if n + k == 0 { None } else { Some(ri) });
        ri *= r;
    }
    println!("cycle-tracker-report-end: proofs");

    println!("cycle-tracker-report-start: pairing");
    assert!(total == 0 || pairs(&batch, &g2, &s_g2), "pairing check failed");
    println!("cycle-tracker-report-end: pairing");

    let (_, out, _) = blk::apply(&state, &spends, &data, &settles, &posted, &taken, &nfw, blk::vk_hash(&VK_DIGEST), time, &blobs).expect("block rejected");
    sp1_zkvm::io::commit_slice(&out.encode());
    // the run ends here: dropping the key, the proofs and the batch would only spend cycles freeing memory
    std::mem::forget((vk, params, batch, raw, spends, data, settles, nfw, posted, posted_raw, answers));
}

/// Whether a batch of dual MSMs holds: e(left, τ·g2) = e(right, g2), its MSMs on the bn254 precompiles.
fn pairs(batch: &Batch, g2: &G2Affine, s_g2: &G2Affine) -> bool {
    let lb: Vec<[u64; 8]> = batch.left.iter().map(|(_, p)| to_sp1(p)).collect();
    let ls: Vec<[u64; 4]> = batch.left.iter().map(|(s, _)| scalar_limbs(s)).collect();
    let rb: Vec<[u64; 8]> = batch.right.iter().map(|(_, p)| to_sp1(p)).collect();
    let rs: Vec<[u64; 4]> = batch.right.iter().map(|(s, _)| scalar_limbs(s)).collect();
    let (l, rr) = (msm(&lb, &ls), msm(&rb, &rs));
    bn::pairing_batch(&[(bn_g1(&l), bn_g2(s_g2)), (-bn_g1(&rr), bn_g2(g2))]) == bn::Gt::one()
}

fn limbs4(b: &[u8]) -> [u64; 4] {
    let mut l = [0u64; 4];
    for i in 0..4 {
        l[i] = u64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
    }
    l
}

pub fn to_sp1(p: &G1Affine) -> [u64; 8] {
    let x = limbs4(p.x.to_repr().as_ref());
    let y = limbs4(p.y.to_repr().as_ref());
    [x[0], x[1], x[2], x[3], y[0], y[1], y[2], y[3]]
}

pub fn scalar_limbs(s: &Fr) -> [u64; 4] {
    limbs4(s.to_repr().as_ref())
}

fn digit(s: &[u64; 4], bit: usize, c: usize) -> usize {
    let limb = bit / 64;
    let off = bit % 64;
    if limb >= 4 {
        return 0;
    }
    let mut v = s[limb] >> off;
    if off + c > 64 && limb + 1 < 4 {
        v |= s[limb + 1] << (64 - off);
    }
    (v as usize) & ((1usize << c) - 1)
}

/// Pippenger MSM with the bn254 add/double precompiles on affine points. Scalars < r < 2^254.
pub fn msm(bases: &[[u64; 8]], scalars: &[[u64; 4]]) -> Bn254Point {
    const BITS: usize = 254;
    let m = bases.len();
    let mut acc = Bn254Point::infinity();
    if m == 0 {
        return acc;
    }
    let cost = |c: usize| ((BITS + c - 1) / c) * (m + (2 << c));
    let c = (1..=12).min_by_key(|&c| cost(c)).unwrap();
    let nw = (BITS + c - 1) / c;
    let pts: Vec<Bn254Point> = bases.iter().map(|b| Bn254Point::new(*b)).collect();
    let mut buckets = vec![Bn254Point::infinity(); (1 << c) - 1];
    for w in (0..nw).rev() {
        if !acc.is_infinity() {
            for _ in 0..c {
                acc.double();
            }
        }
        for b in buckets.iter_mut() {
            *b = Bn254Point::infinity();
        }
        for (p, s) in pts.iter().zip(scalars) {
            let d = digit(s, w * c, c);
            if d != 0 {
                buckets[d - 1].weierstrass_add_assign(p);
            }
        }
        let mut running = Bn254Point::infinity();
        let mut sum = Bn254Point::infinity();
        for b in buckets.iter().rev() {
            running.weierstrass_add_assign(b);
            sum.weierstrass_add_assign(&running);
        }
        acc.weierstrass_add_assign(&sum);
    }
    acc
}

fn bn_fq(le: &[u8]) -> bn::Fq {
    let mut be = [0u8; 32];
    for i in 0..32 {
        be[i] = le[31 - i];
    }
    bn::Fq::from_slice(&be).expect("fq")
}

pub fn bn_g1(p: &Bn254Point) -> bn::G1 {
    use bn::Group as _;
    if p.is_infinity() {
        return bn::G1::zero();
    }
    let l = p.limbs_ref();
    let b: Vec<u8> = l.iter().flat_map(|w| w.to_le_bytes()).collect();
    bn::AffineG1::new_unchecked(bn_fq(&b[..32]), bn_fq(&b[32..])).into()
}

pub fn bn_g2(p: &G2Affine) -> bn::G2 {
    let f = |x: &halo2_proofs::halo2curves::bn256::Fq| bn_fq(x.to_repr().as_ref());
    let x = bn::Fq2::new(f(&p.x.c0), f(&p.x.c1));
    let y = bn::Fq2::new(f(&p.y.c0), f(&p.y.c1));
    bn::AffineG2::new_unchecked(x, y).into()
}

/// 64-bit libatomic entry points for rayon/crossbeam on riscv64im (no A extension). The zkVM is
/// single-threaded (rayon falls back to the current thread), so plain memory operations suffice.
#[allow(clippy::missing_safety_doc)]
mod atomics8 {
    #[no_mangle]
    pub unsafe extern "C" fn __atomic_load_8(p: *const u64, _o: i32) -> u64 {
        core::ptr::read_volatile(p)
    }
    #[no_mangle]
    pub unsafe extern "C" fn __atomic_store_8(p: *mut u64, v: u64, _o: i32) {
        core::ptr::write_volatile(p, v)
    }
    #[no_mangle]
    pub unsafe extern "C" fn __atomic_exchange_8(p: *mut u64, v: u64, _o: i32) -> u64 {
        let old = core::ptr::read_volatile(p);
        core::ptr::write_volatile(p, v);
        old
    }
    #[no_mangle]
    pub unsafe extern "C" fn __atomic_compare_exchange_8(p: *mut u64, expected: *mut u64, desired: u64, _weak: bool, _s: i32, _f: i32) -> bool {
        let cur = core::ptr::read_volatile(p);
        if cur == *expected {
            core::ptr::write_volatile(p, desired);
            true
        } else {
            *expected = cur;
            false
        }
    }
    macro_rules! fetch {
        ($name:ident, $op:expr) => {
            #[no_mangle]
            pub unsafe extern "C" fn $name(p: *mut u64, v: u64, _o: i32) -> u64 {
                let old = core::ptr::read_volatile(p);
                let f: fn(u64, u64) -> u64 = $op;
                core::ptr::write_volatile(p, f(old, v));
                old
            }
        };
    }
    fetch!(__atomic_fetch_add_8, |a, b| a.wrapping_add(b));
    fetch!(__atomic_fetch_sub_8, |a, b| a.wrapping_sub(b));
    fetch!(__atomic_fetch_or_8, |a, b| a | b);
    fetch!(__atomic_fetch_and_8, |a, b| a & b);
    fetch!(__atomic_fetch_xor_8, |a, b| a ^ b);
}
