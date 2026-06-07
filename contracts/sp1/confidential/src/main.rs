#![cfg_attr(not(test), no_main)]
//! Confidential-pool guest (Phase 1). Validates a batch of confidential ops and
//! commits the ABI-encoded `PublicValues` that `ConfidentialPool.settle` decodes.
//! All secp/keccak verification is delegated to `cxfer-core` (native-tested
//! against the JS prover); this guest is the thin assembler that reads the
//! witness, calls the verified checks, and emits the public boundary effects.
//!
//! Op witness layout (host writes in this order; see dapp prover):
//!   header:  chainBinding[32], spendRoot[32], numOps u32
//!   per op:  opType u8, then op-specific fields below.

#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::{sol, SolValue};
use alloy_sol_types::private::{Address, U256};
use cxfer_core::{
    claim_id, decompress, deposit_id, from_affine_xy, keccak_merkle_verify, leaf, nullifier,
    scalar_reduce_be, verify_kernel, verify_pedersen_opening, verify_range,
    Point,
};
use sp1_zkvm::io;

const PV_VERSION: u16 = 1;
const OP_WRAP: u8 = 0;
const OP_TRANSFER: u8 = 1;
const OP_UNWRAP: u8 = 2;
const OP_BRIDGE_BURN: u8 = 3; // Ethereum note → Bitcoin (emit crossOut)
// OP_BRIDGE_MINT (Bitcoin burn → Ethereum note) = 4, reserved; its in-guest
// Bitcoin-burn verification (tETH crates) is the next milestone.

// Mirrors ConfidentialPool.PublicValues exactly.
sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 amount; }
    struct FeePayment { bytes32 assetId; uint256 amount; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot;
        bytes32[] nullifiers;
        bytes32[] leaves;
        bytes32[] depositsConsumed;
        Withdrawal[] withdrawals;
        FeePayment[] fees;
        bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts;
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] { r_n::<32>() }
fn r33() -> [u8; 33] { r_n::<33>() }
fn r20() -> [u8; 20] { r_n::<20>() }

/// Read a commitment as affine (cx, cy) and rebuild the point. Returns the bytes
/// (for leaf/deposit-id keccak preimages) and the point (for range/kernel/opening).
fn r_commitment() -> ([u8; 32], [u8; 32], Point) {
    let cx = r32();
    let cy = r32();
    let p = from_affine_xy(&cx, &cy).expect("commitment xy");
    (cx, cy, p)
}

fn r_path() -> Vec<[u8; 32]> {
    (0..32).map(|_| r32()).collect()
}

pub fn main() {
    let chain_binding = r32();
    let spend_root = r32();
    let num_ops: u32 = io::read();

    let mut nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut leaves: Vec<[u8; 32]> = Vec::new();
    let mut deposits: Vec<[u8; 32]> = Vec::new();
    let mut withdrawals: Vec<Withdrawal> = Vec::new();
    let fees: Vec<FeePayment> = Vec::new(); // fee path: follow-up (kernel −fee·H term)
    let bitcoin_burns: Vec<[u8; 32]> = Vec::new(); // OP_BRIDGE_MINT (next milestone)
    let mut cross_outs: Vec<CrossOut> = Vec::new();

    for _ in 0..num_ops {
        let op: u8 = io::read();
        match op {
            OP_WRAP => {
                // public deposit: prove C opens to value, emit leaf + deposit id.
                let asset = r32();
                let amount = r32(); // underlying (BE32) for the deposit id
                let value: u64 = io::read(); // in-system value the note commits to
                let (cx, cy, c) = r_commitment();
                let owner = r32();
                let r = scalar_reduce_be(&r32());
                assert!(verify_pedersen_opening(&c, value, &r), "wrap opening");
                leaves.push(leaf(&asset, &cx, &cy, &owner));
                deposits.push(deposit_id(&asset, &amount, &cx, &cy, &owner));
            }
            OP_TRANSFER => {
                // n-in / m-out, hidden amounts: membership + range + conservation.
                let asset = r32();
                let n_in: u32 = io::read();
                let m_out: u32 = io::read();

                let mut in_pts: Vec<Point> = Vec::with_capacity(n_in as usize);
                for _ in 0..n_in {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    let leaf_index: u64 = io::read();
                    let path = r_path();
                    let secret = r32();
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                    nullifiers.push(nullifier(&secret));
                    in_pts.push(p);
                }

                let mut out_pts: Vec<Point> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    leaves.push(leaf(&asset, &cx, &cy, &owner));
                    out_pts.push(p);
                }

                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&out_pts, &bp_proof), "range");

                let kernel_r = decompress(&r33()).expect("kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(verify_kernel(&in_pts, &out_pts, &kernel_r, &kernel_z), "conservation");
            }
            OP_BRIDGE_BURN => {
                // Ethereum → Bitcoin: like a transfer, but outputs are destination
                // notes MINTED ON BITCOIN — emitted as crossOut records, not leaves.
                // Conservation crosses the boundary: Σ value_in (burned) = Σ value_out
                // (minted on Bitcoin). Every claimId binds to the first input's ν.
                let asset = r32();
                let dest_chain = io::read::<u32>() as u16;
                let n_in: u32 = io::read();
                let m_out: u32 = io::read();

                let mut in_pts: Vec<Point> = Vec::with_capacity(n_in as usize);
                let mut bind: Option<[u8; 32]> = None;
                for _ in 0..n_in {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    let leaf_index: u64 = io::read();
                    let path = r_path();
                    let secret = r32();
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                    let nu = nullifier(&secret);
                    if bind.is_none() { bind = Some(nu); }
                    nullifiers.push(nu);
                    in_pts.push(p);
                }
                let bind = bind.expect("bridge-burn needs >= 1 input");

                let mut out_pts: Vec<Point> = Vec::with_capacity(m_out as usize);
                let mut dest_commitments: Vec<[u8; 32]> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    dest_commitments.push(leaf(&asset, &cx, &cy, &owner)); // Bitcoin-side leaf
                    out_pts.push(p);
                }

                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&out_pts, &bp_proof), "range");
                let kernel_r = decompress(&r33()).expect("kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(verify_kernel(&in_pts, &out_pts, &kernel_r, &kernel_z), "conservation");

                for dest_commitment in dest_commitments {
                    let cid = claim_id(dest_chain, &dest_commitment, &bind, &asset);
                    cross_outs.push(CrossOut {
                        destChain: dest_chain,
                        destCommitment: dest_commitment.into(),
                        nullifier: bind.into(),
                        assetId: asset.into(),
                        claimId: cid.into(),
                    });
                }
            }
            OP_UNWRAP => {
                // spend a note to a public recipient: membership + opening, pay out.
                let asset = r32();
                let (cx, cy, c) = r_commitment();
                let owner = r32();
                let leaf_index: u64 = io::read();
                let path = r_path();
                let secret = r32();
                let value: u64 = io::read();
                let r = scalar_reduce_be(&r32());
                let amount = r32(); // underlying payout (BE32)
                let recipient = r20();

                let lf = leaf(&asset, &cx, &cy, &owner);
                assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                assert!(verify_pedersen_opening(&c, value, &r), "unwrap opening");
                nullifiers.push(nullifier(&secret));
                withdrawals.push(Withdrawal {
                    assetId: asset.into(),
                    recipient: Address::from(recipient),
                    amount: U256::from_be_slice(&amount),
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
        depositsConsumed: deposits.into_iter().map(Into::into).collect(),
        withdrawals,
        fees,
        bitcoinBurnsConsumed: bitcoin_burns.into_iter().map(Into::into).collect(),
        crossOuts: cross_outs,
    };
    io::commit_slice(&pv.abi_encode());
}
