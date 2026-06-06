#![cfg_attr(not(test), no_main)]
#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

//! Confidential-pool guest (Phase 1). Validates a batch of confidential ops and
//! commits the ABI-encoded `PublicValues` that `ConfidentialPool.settle` decodes.
//!
//! Division of labour (see ops/PLAN-confidential-token-rollup.md §5/§16): the
//! guest does all secp work — membership against the on-chain Keccak root, the
//! aggregated Bulletproofs+ ranges, the per-asset conservation kernel, and the
//! wrap/unwrap openings — and emits only the public boundary effects. The
//! contract maintains the tree, nullifier set, and escrow.
//!
//! Forward-compat (Phase 3): nullifiers are `keccak(note_secret)` —
//! chain-independent — and the `PublicValues` tail is versioned, so the
//! cross-chain accumulator roots + exposed mint-nullifiers append without a
//! layout break.

use alloy_sol_types::{sol, SolValue};
use k256::ProjectivePoint;
use sp1_zkvm::io;
use tiny_keccak::{Hasher, Keccak};

mod secp; // reused from the bridge guest: pedersen_h(), verify_pedersen_opening()

const TREE_DEPTH: usize = 32;
const PV_VERSION: u16 = 1;

// Mirrors ConfidentialPool.PublicValues exactly; abi_encode() → commit_slice()
// is what the on-chain abi.decode reads.
sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 amount; }
    struct FeePayment { bytes32 assetId; uint256 amount; }
    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot;
        bytes32[] nullifiers;
        bytes32[] leaves;
        bytes32[] depositsConsumed;
        Withdrawal[] withdrawals;
        FeePayment[] fees;
    }
}

const OP_WRAP: u8 = 0;
const OP_TRANSFER: u8 = 1;
const OP_UNWRAP: u8 = 2;

pub fn main() {
    let chain_binding: [u8; 32] = io::read();
    let spend_root: [u8; 32] = io::read();
    let h = secp::pedersen_h();

    let mut nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut leaves: Vec<[u8; 32]> = Vec::new();
    let mut deposits_consumed: Vec<[u8; 32]> = Vec::new();
    let mut withdrawals: Vec<Withdrawal> = Vec::new();
    let mut fees: Vec<FeePayment> = Vec::new();

    let num_ops: u32 = io::read();
    for _ in 0..num_ops {
        let op_type: u8 = io::read();
        match op_type {
            OP_WRAP => {
                // Public deposit: prove C opens to the publicly-escrowed amount
                // (amount = value · unit_scale), then emit its leaf + deposit id.
                let asset_id: [u8; 32] = io::read();
                let amount: u64 = io::read();          // value in in-system units
                let unit_scale_amount: [u8; 32] = io::read(); // escrowed underlying (for deposit id)
                let commitment: [u8; 33] = io::read();
                let blinding: [u8; 32] = io::read();
                let owner: [u8; 32] = io::read();

                assert!(secp::verify_pedersen_opening(&h, &commitment, amount, &blinding), "wrap opening");

                let (cx, cy) = decompress_xy(&commitment);
                leaves.push(leaf(&asset_id, &cx, &cy, &owner));
                deposits_consumed.push(deposit_id(&asset_id, &unit_scale_amount, &cx, &cy, &owner));
            }
            OP_TRANSFER => {
                // n-in / m-out, hidden amounts. Inputs proven in-tree against
                // spend_root; outputs range-bounded by an aggregated BP+; sums
                // conserved per asset by the kernel. Amounts never leave the guest.
                let asset_id: [u8; 32] = io::read();
                let n_in: u32 = io::read();
                let m_out: u32 = io::read();

                let mut in_points: Vec<ProjectivePoint> = Vec::with_capacity(n_in as usize);
                for _ in 0..n_in {
                    let commitment: [u8; 33] = io::read();
                    let leaf_index: u64 = io::read();
                    let path: Vec<[u8; 32]> = read_path();
                    let note_secret: [u8; 32] = io::read();

                    let (cx, cy) = decompress_xy(&commitment);
                    let owner: [u8; 32] = io::read();
                    let lf = leaf(&asset_id, &cx, &cy, &owner);
                    assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");

                    nullifiers.push(nullifier(&note_secret)); // chain-independent
                    in_points.push(point(&commitment));
                }

                let mut out_points: Vec<ProjectivePoint> = Vec::with_capacity(m_out as usize);
                let mut out_commitments: Vec<[u8; 33]> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let commitment: [u8; 33] = io::read();
                    let owner: [u8; 32] = io::read();
                    let (cx, cy) = decompress_xy(&commitment);
                    leaves.push(leaf(&asset_id, &cx, &cy, &owner));
                    out_points.push(point(&commitment));
                    out_commitments.push(commitment);
                }

                // Range: every output ∈ [0, 2^64) via one aggregated BP+ over the
                // output commitments. PORT-IN: the canonical secp BP+ verifier.
                let bp_proof: Vec<u8> = io::read();
                assert!(secp::verify_bulletproofs_plus(&h, &out_commitments, &bp_proof), "range");

                // Conservation: Σ Cin − Σ Cout − fee·H = excess·G, Schnorr under
                // the excess. fee is public and paid to the settler in-asset.
                let fee: u64 = io::read();
                let kernel_r_addr: [u8; 20] = io::read();
                let kernel_z: [u8; 32] = io::read();
                assert!(
                    secp::verify_kernel(&h, &in_points, &out_points, fee, &kernel_r_addr, &kernel_z),
                    "conservation"
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset_id.into(),
                        amount: scale_to_underlying(fee),
                    });
                }
            }
            OP_UNWRAP => {
                // Spend a note to a public recipient: prove it opens to `amount`,
                // nullify it, emit the withdrawal (underlying units).
                let asset_id: [u8; 32] = io::read();
                let commitment: [u8; 33] = io::read();
                let leaf_index: u64 = io::read();
                let path: Vec<[u8; 32]> = read_path();
                let note_secret: [u8; 32] = io::read();
                let owner: [u8; 32] = io::read();
                let amount: u64 = io::read();
                let blinding: [u8; 32] = io::read();
                let recipient: [u8; 20] = io::read();

                let (cx, cy) = decompress_xy(&commitment);
                let lf = leaf(&asset_id, &cx, &cy, &owner);
                assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                assert!(secp::verify_pedersen_opening(&h, &commitment, amount, &blinding), "unwrap opening");

                nullifiers.push(nullifier(&note_secret));
                withdrawals.push(Withdrawal {
                    assetId: asset_id.into(),
                    recipient: recipient.into(),
                    amount: scale_to_underlying(amount),
                });
            }
            _ => panic!("unknown op type"),
        }
    }

    let pv = PublicValues {
        version: PV_VERSION,
        chainBinding: chain_binding.into(),
        spendRoot: spend_root.into(),
        nullifiers: nullifiers.into_iter().map(Into::into).collect(),
        leaves: leaves.into_iter().map(Into::into).collect(),
        depositsConsumed: deposits_consumed.into_iter().map(Into::into).collect(),
        withdrawals,
        fees,
    };
    io::commit_slice(&pv.abi_encode());
}

// ──────────────────── hashing helpers (match the contract) ────────────────────

fn k2(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(l);
    k.update(r);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}

/// leaf = keccak(asset_id, Cx, Cy, owner) — matches the Bitcoin note scheme so a
/// unified tree is natural in the cross-chain generation.
fn leaf(asset_id: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(asset_id);
    k.update(cx);
    k.update(cy);
    k.update(owner);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}

/// keccak(note_secret) — chain-independent nullifier (Phase-3 tee-up §11.1).
fn nullifier(note_secret: &[u8; 32]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(note_secret);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}

/// deposit id = keccak(abi.encode(assetId, amount, cx, cy, owner)) — must equal
/// ConfidentialPool.wrap()'s. abi.encode of static types is just concatenation of
/// 32-byte words; amount here is the underlying (unit_scale) amount as bytes32.
fn deposit_id(asset_id: &[u8; 32], amount32: &[u8; 32], cx: &[u8; 32], cy: &[u8; 32], owner: &[u8; 32]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(asset_id);
    k.update(amount32);
    k.update(cx);
    k.update(cy);
    k.update(owner);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}

/// Membership against the on-chain Keccak incremental Merkle root: fold the leaf
/// up with its siblings using the index bits, matching _insertLeaf's ordering.
fn keccak_merkle_verify(leaf: &[u8; 32], mut index: u64, path: &[[u8; 32]], root: &[u8; 32]) -> bool {
    if path.len() != TREE_DEPTH {
        return false;
    }
    let mut h = *leaf;
    for sib in path.iter() {
        h = if index & 1 == 0 { k2(&h, sib) } else { k2(sib, &h) };
        index >>= 1;
    }
    &h == root
}

fn read_path() -> Vec<[u8; 32]> {
    let mut path = Vec::with_capacity(TREE_DEPTH);
    for _ in 0..TREE_DEPTH {
        let s: [u8; 32] = io::read();
        path.push(s);
    }
    path
}

// ──────────────────── secp helpers ────────────────────

fn point(commitment: &[u8; 33]) -> ProjectivePoint {
    secp::decompress(commitment).expect("commitment point")
}

fn decompress_xy(commitment: &[u8; 33]) -> ([u8; 32], [u8; 32]) {
    secp::affine_xy(commitment).expect("commitment xy")
}

/// in-system value (u64) → underlying units. Phase-1 carries unit_scale per
/// asset off-chain in the witness; the scaffold uses identity and is wired to the
/// asset's unit_scale when the witness format is finalized (§17).
fn scale_to_underlying(value: u64) -> alloy_sol_types::private::U256 {
    alloy_sol_types::private::U256::from(value)
}
