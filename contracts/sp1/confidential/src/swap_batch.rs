//! T_SWAP_BATCH (0x2F) onboarding fold — the assembly that ties the validated primitives into the reflection
//! so a confidential AMM batch's receipts become real, bridgeable notes:
//!   - `groth16::groth16_bn254_verify` (validated) — the per-receipt SPLIT is the correct uniform clearing;
//!   - `cxfer_core::swap_batch_aggregate_identity` (KAT'd) — the aggregate Pedersen identity per asset, binding
//!     the receipts' total to the traders' REAL spent inputs + the public net delta + the c0-backed reserve;
//!   - `babyjubjub::verify_xcurve` (validated) — per receipt, binds `C_out_secp` to the Groth16-proven
//!     `C_out_BJJ`, so the onboarded secp note carries the cleared (hidden) amount.
//!
//! Soundness (no bridge inflation): the aggregate identity bounds the TOTAL onboarded to real inputs + reserve;
//! the Groth16 fixes each receipt's share; the cross-curve sigma ties each secp note to its proven BJJ value.
//! (Per-intent `in_xcurve` + intent-sig are settler-side FAIRNESS checks the worker enforces; the reflection's
//! no-inflation property rests on the aggregate identity + real-spend inputs, so they're not repeated here.)
//!
//! BOX-ONLY ASSEMBLY: this links `bn` (Groth16 + BabyJubJub), so it can't be cargo-tested here; the component
//! primitives + the parser + the aggregate identity ARE validated (native harnesses + cxfer-core KATs). The
//! assembled fold's end-to-end validation needs a full swap_batch envelope+proof vector (the worker's envelope
//! builder) or a box run — that's the remaining step. Fail-closed (returns false / skips) on any validation
//! miss; witness-stream errors in the commit phase `expect()` (a prover bug, like the other folds' appends).

use bn::Fr;
use cxfer_core::{
    amm_canonical_pair, amm_derive_pool_id_v1, bitcoin::SwapBatchEnvelope, commitment_hash_compressed,
    decompress, from_affine_xy, outpoint_key, reflected_note_leaf, sha256, swap_batch_aggregate_identity,
    DetectedSpend, G16Proof, ScanReflection,
};

const N_MAX: usize = 16;

/// Field element → canonical big-endian 32 bytes (the Groth16 public-input encoding `fr()` expects).
fn fr_to_be(f: Fr) -> [u8; 32] {
    let mut o = [0u8; 32];
    f.into_u256().to_big_endian(&mut o).expect("32-byte field");
    o
}
/// A small unsigned integer as a field element's big-endian bytes (value in the low 8 bytes).
fn u64_be(n: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[24..].copy_from_slice(&n.to_be_bytes());
    o
}

/// Re-derive the circuit's 123 public signals from the on-chain envelope + the pool's tracked reserves, in the
/// EXACT order the circom `main` declares: 11 globals then 7 N_MAX=16 arrays
/// `[direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount, C_out_BJJ_u, C_out_BJJ_v]`. A prover can't forge
/// these: `R_*_pre` come from the registry, `pool_id_fr = SHA256(pool_id) mod r`, and the BJJ coordinates are
/// recovered by the validated `babyjubjub::unpack` of the envelope's commitments (padding the unused slots with
/// the BJJ identity `(0,1)`, like the circuit). Returns None on a bad point / out-of-range count.
pub fn swap_batch_public_signals(env: &SwapBatchEnvelope, pool_id: &[u8; 32], reserve_a: u64, reserve_b: u64) -> Option<Vec<[u8; 32]>> {
    if env.n_intents == 0 || env.n_intents > N_MAX || env.intents.len() != env.n_intents || env.receipts.len() != env.n_intents {
        return None;
    }
    let mut s: Vec<[u8; 32]> = Vec::with_capacity(123);
    // [0..11] globals.
    s.push(fr_to_be(Fr::from_bytes_be_mod_order(&sha256(pool_id)).ok()?)); // pool_id_fr = SHA256(pool_id) mod r
    s.push(u64_be(reserve_a)); // R_A_pre
    s.push(u64_be(reserve_b)); // R_B_pre
    s.push(u64_be(env.delta_a_net_sign as u64));
    s.push(u64_be(env.delta_a_net_mag));
    s.push(u64_be(env.delta_b_net_sign as u64));
    s.push(u64_be(env.delta_b_net_mag));
    s.push(u64_be(env.tip_a_amount));
    s.push(u64_be(env.tip_b_amount));
    s.push(u64_be(env.fee_bps as u64));
    s.push(u64_be(env.n_intents as u64));

    // [11..123] the seven N_MAX arrays. Build each padded to N_MAX, then push in circom order.
    let zero = [0u8; 32];
    let one = u64_be(1); // BJJ identity v-coordinate for padded slots
    let mut direction = [zero; N_MAX];
    let mut c_in_u = [zero; N_MAX];
    let mut c_in_v = [one; N_MAX];
    let mut min_out = [zero; N_MAX];
    let mut tip = [zero; N_MAX];
    let mut c_out_u = [zero; N_MAX];
    let mut c_out_v = [one; N_MAX];
    for i in 0..env.n_intents {
        let it = &env.intents[i];
        direction[i] = u64_be(it.direction as u64);
        let (iu, iv) = crate::babyjubjub::unpack(&it.c_in_bjj)?;
        c_in_u[i] = fr_to_be(iu);
        c_in_v[i] = fr_to_be(iv);
        min_out[i] = u64_be(it.min_out);
        tip[i] = u64_be(it.tip_amount);
        let (ou, ov) = crate::babyjubjub::unpack(&env.receipts[i].c_out_bjj)?;
        c_out_u[i] = fr_to_be(ou);
        c_out_v[i] = fr_to_be(ov);
    }
    for arr in [&direction, &c_in_u, &c_in_v, &min_out, &tip, &c_out_u, &c_out_v] {
        for x in arr.iter() {
            s.push(*x);
        }
    }
    if s.len() != 123 {
        return None;
    }
    Some(s)
}

/// Parse the envelope's Groth16 proof bytes → `G16Proof`. Layout (256 B, big-endian field bytes, matching the
/// validated `groth16_bn254_verify` G16Proof shape): `A(G1 64) ‖ B(G2 128: x_c0 x_c1 y_c0 y_c1) ‖ C(G1 64)`.
fn parse_g16_proof(b: &[u8]) -> Option<G16Proof> {
    if b.len() != 256 {
        return None;
    }
    let r32 = |o: usize| -> [u8; 32] { b[o..o + 32].try_into().unwrap() };
    Some(G16Proof {
        a: (r32(0), r32(32)),
        b: (r32(64), r32(96), r32(128), r32(160)),
        c: (r32(192), r32(224)),
    })
}

fn apply_signed(reserve: u64, sign: u8, mag: u64) -> Option<u64> {
    if sign == 0 {
        reserve.checked_add(mag)
    } else {
        reserve.checked_sub(mag)
    }
}

/// Fold a confirmed `T_SWAP_BATCH` (0x2F): validate the whole batch, then onboard every receipt as a real,
/// bridgeable note + advance the pool reserves by the public net deltas. All-or-nothing: every check runs (and
/// the post-reserves are computed) BEFORE any state mutation. `receipt_paths[i]` is the witnessed append path for
/// receipt `i` (the note at vout `i+1`). Returns true iff folded.
pub fn fold_swap_batch(
    state: &mut ScanReflection,
    env: &SwapBatchEnvelope,
    txid: &[u8; 32],
    spends: &[DetectedSpend],
    receipt_paths: &[Vec<[u8; 32]>],
) -> bool {
    if env.intents.len() != env.n_intents || env.receipts.len() != env.n_intents || receipt_paths.len() != env.n_intents {
        return false;
    }
    if env.fee_bps > 1000 {
        return false; // MAX_POOL_FEE_BPS — reject an invalid fee tier even if a bad pool state ever entered
    }
    // 1. resolve the pool (canonical pair → pool_id) + its tracked reserves; must be C0-backed + canonically
    //    oriented (so `direction` maps to the right reserve side).
    let (a_lo, a_hi) = match amm_canonical_pair(&env.asset_a, &env.asset_b) {
        Some(p) => p,
        None => return false,
    };
    let pool_id = match amm_derive_pool_id_v1(&a_lo, &a_hi, env.fee_bps) {
        Some(p) => p,
        None => return false,
    };
    let mut pool = match state.pools.get(&pool_id) {
        Some(p) => p,
        None => return false,
    };
    if !pool.c0_backed || env.asset_a != pool.asset_a || env.asset_b != pool.asset_b {
        return false;
    }
    // 2. compute the post-reserves up front (so an over-draw is caught before any mutation).
    let new_a = match apply_signed(pool.reserve_a, env.delta_a_net_sign, env.delta_a_net_mag) {
        Some(v) => v,
        None => return false,
    };
    let new_b = match apply_signed(pool.reserve_b, env.delta_b_net_sign, env.delta_b_net_mag) {
        Some(v) => v,
        None => return false,
    };
    // post-reserves must stay positive and must not shrink the constant product. The Groth16 clearing
    // should already guarantee k_post >= k_pre, but enforce it here too — cheap defense-in-depth against a
    // public-signal / verifying-key drift, mirroring the EVM-side confidential swap settlement.
    if new_a == 0 || new_b == 0 {
        return false;
    }
    if (new_a as u128) * (new_b as u128) < (pool.reserve_a as u128) * (pool.reserve_b as u128) {
        return false;
    }
    // 3. Groth16 verify (per-receipt split correctness) over the re-derived public signals.
    let pubs = match swap_batch_public_signals(env, &pool_id, pool.reserve_a, pool.reserve_b) {
        Some(p) => p,
        None => return false,
    };
    let proof = match parse_g16_proof(&env.proof) {
        Some(p) => p,
        None => return false,
    };
    if !crate::groth16::groth16_bn254_verify(&crate::groth16::batch_vk(), &proof, &pubs) {
        return false;
    }
    // 4. aggregate Pedersen identity per asset A + B (binds the receipts' total to real inputs + reserve).
    let intents_secp: Vec<(u8, [u8; 33])> = env.intents.iter().map(|it| (it.direction, it.c_in_secp)).collect();
    let receipts_secp: Vec<[u8; 33]> = env.receipts.iter().map(|r| r.c_out_secp).collect();
    if !swap_batch_aggregate_identity(&intents_secp, &receipts_secp, true, env.delta_a_net_sign, env.delta_a_net_mag, env.tip_a_amount, &env.r_net_a) {
        return false;
    }
    if !swap_batch_aggregate_identity(&intents_secp, &receipts_secp, false, env.delta_b_net_sign, env.delta_b_net_mag, env.tip_b_amount, &env.r_net_b) {
        return false;
    }
    // 5. ONE-TO-ONE: each intent's C_in_secp must match a DISTINCT real spent pool note of the intent's
    //    INPUT asset (direction 0 = A→B inputs asset A; direction 1 = B→A inputs asset B). The aggregate
    //    identity counts each intent's input once, so without distinctness a single real UTXO reused across
    //    two intents would be double-counted (inflation), and without the asset check an asset-X note could
    //    pose as an A/B input (relabel — the Pedersen commitment is asset-blind). Every detected spend must
    //    back exactly one intent input (no unaccounted real spend).
    let mut used = vec![false; spends.len()];
    for it in env.intents.iter() {
        if it.direction > 1 {
            return false;
        }
        let expected_asset = if it.direction == 0 { pool.asset_a } else { pool.asset_b };
        let in_pt = match decompress(&it.c_in_secp) {
            Some(p) => p,
            None => return false,
        };
        let mut matched = None;
        for (j, sp) in spends.iter().enumerate() {
            if used[j] || sp.asset != expected_asset {
                continue;
            }
            if matches!(from_affine_xy(&sp.cx, &sp.cy), Some(x) if x == in_pt) {
                matched = Some(j);
                break;
            }
        }
        match matched {
            Some(j) => used[j] = true,
            None => return false,
        }
    }
    if used.iter().any(|u| !*u) {
        return false;
    }
    // 6. per receipt: the cross-curve sigma binds C_out_secp ↔ C_out_BJJ (the secp note's value == the
    //    Groth16-proven cleared amount).
    for r in env.receipts.iter() {
        if !crate::babyjubjub::verify_xcurve(&r.out_xcurve_sigma, &r.c_out_secp, &r.c_out_bjj) {
            return false;
        }
    }

    // ---- all validation passed; COMMIT: onboard each receipt, then advance reserves. ----
    for (i, r) in env.receipts.iter().enumerate() {
        // receipt asset = the OUTPUT side for this intent: direction 0 (A→B) ⇒ receives B; direction 1 ⇒ A.
        let out_asset = if env.intents[i].direction == 0 { pool.asset_b } else { pool.asset_a };
        let leaf = reflected_note_leaf(&out_asset, &r.c_out_secp).expect("receipt commitment is a curve point");
        let ch = commitment_hash_compressed(&r.c_out_secp).expect("receipt commitment hash");
        state
            .fold_output(&leaf, &receipt_paths[i], &outpoint_key(txid, (i + 1) as u32), &ch, &out_asset)
            .expect("swap_batch receipt append");
    }
    pool.reserve_a = new_a;
    pool.reserve_b = new_b;
    state.pools.update(&pool_id, pool);
    true
}
