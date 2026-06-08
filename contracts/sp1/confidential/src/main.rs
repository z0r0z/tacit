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
    bitcoin, claim_id, decompress, deposit_id, from_affine_xy, imt_non_membership,
    keccak_merkle_verify, leaf, nullifier, scalar_reduce_be, utxo_leaf, verify_kernel,
    verify_pedersen_opening, verify_range, Point,
};
use sp1_zkvm::io;

const PV_VERSION: u16 = 1;
const OP_WRAP: u8 = 0;
const OP_TRANSFER: u8 = 1;
const OP_UNWRAP: u8 = 2;
const OP_BRIDGE_BURN: u8 = 3; // Ethereum note → Bitcoin (emit crossOut)
const OP_BRIDGE_MINT: u8 = 4; // Bitcoin burn → Ethereum note (verify Bitcoin burn)
const OP_ATTEST_META: u8 = 5; // etch reveal → prove (asset_id, ticker, decimals) trustlessly

// Mirrors ConfidentialPool.PublicValues exactly.
sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; }
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
        bytes32[] bitcoinRootsUsed;
        bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot;
        AssetMeta[] assetMetas;
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] { r_n::<32>() }
fn r33() -> [u8; 33] { r_n::<33>() }
fn r20() -> [u8; 20] { r_n::<20>() }

/// Big-endian 32-byte encoding of an in-system u64 value — the deposit-id /
/// withdrawal value field the contract derives as `amount / unitScale`.
fn u64_be32(v: u64) -> [u8; 32] {
    let mut a = [0u8; 32];
    a[24..].copy_from_slice(&v.to_be_bytes());
    a
}

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

/// Cross-lane gate (improved platinum): assert `nu` is absent from the reflected
/// Bitcoin spent set committed by `root`, reading the IMT non-membership witness
/// (low leaf value/next/index/path). Called only when the root is non-zero.
fn check_btc_nonmembership(nu: &[u8; 32], root: &[u8; 32]) {
    let low_value = r32();
    let low_next = r32();
    let low_index: u64 = io::read();
    let low_path = r_path();
    assert!(imt_non_membership(root, nu, &low_value, &low_next, low_index, &low_path), "cross-lane: nu spent on Bitcoin");
}

pub fn main() {
    let chain_binding = r32();
    let spend_root = r32();
    // Improved platinum: the reflected Bitcoin spent-set IMT root to prove each
    // spent ν absent against (0 = gold/Phase-1, no cross-lane check).
    let bitcoin_spent_root = r32();
    // Improved platinum: the reflected Bitcoin bridge-BURN IMT root (key = ν, value =
    // destCommitment), populated only by cross-chain burns. bridge_mint authorizes against
    // THIS set, not the all-spends set — so a note spent in an ordinary Bitcoin transfer is
    // not mintable here (closes the cross-chain inflation path).
    let bitcoin_burn_root = r32();
    let num_ops: u32 = io::read();

    let mut nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut leaves: Vec<[u8; 32]> = Vec::new();
    let mut deposits: Vec<[u8; 32]> = Vec::new();
    let mut withdrawals: Vec<Withdrawal> = Vec::new();
    let fees: Vec<FeePayment> = Vec::new(); // fee path: follow-up (kernel −fee·H term)
    let mut bitcoin_burns: Vec<[u8; 32]> = Vec::new(); // OP_BRIDGE_MINT burned-note nullifiers
    let mut bitcoin_roots: Vec<[u8; 32]> = Vec::new(); // Bitcoin pool roots minted against
    let mut cross_outs: Vec<CrossOut> = Vec::new();
    let mut asset_metas: Vec<AssetMeta> = Vec::new();

    for _ in 0..num_ops {
        let op: u8 = io::read();
        match op {
            OP_WRAP => {
                // public deposit: prove C opens to the in-system value, emit leaf +
                // deposit id. The deposit id binds `value` (NOT the underlying amount):
                // the contract derives the same value = escrowed_amount / unitScale, so
                // a matching id forces value·unitScale == amount and the note can never
                // claim more than was escrowed. The guest never sees unitScale.
                let asset = r32();
                let value: u64 = io::read(); // in-system value the note commits to
                let (cx, cy, c) = r_commitment();
                let owner = r32();
                let r = scalar_reduce_be(&r32());
                assert!(verify_pedersen_opening(&c, value, &r), "wrap opening");
                leaves.push(leaf(&asset, &cx, &cy, &owner));
                deposits.push(deposit_id(&asset, &u64_be32(value), &cx, &cy, &owner));
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
                    let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(spend_root != [0u8; 32], "membership requires a non-zero spend root");
                    assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&nu, &bitcoin_spent_root); }
                    nullifiers.push(nu);
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
                    let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(spend_root != [0u8; 32], "membership requires a non-zero spend root");
                    assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&nu, &bitcoin_spent_root); }
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
            OP_BRIDGE_MINT => {
                // Bitcoin → Ethereum: mint an Ethereum note for a note that was BURNED FOR
                // THE BRIDGE on Bitcoin. The burn is proven by membership of the note's ν in
                // the relay-attested Bitcoin bridge-BURN set (key = ν, value = destCommitment)
                // — NOT the all-spends set, so an ordinary Bitcoin transfer's spend cannot be
                // re-minted here (no cross-chain inflation). The burn-set value pins the
                // destination, so no third party can redirect the mint. Conservation carries
                // value verbatim (v_mint == v_burn); one mint per burned ν (the contract gates
                // each committed ν once via bridgeMinted).
                let asset = r32();
                // The Bitcoin confidential-pool root the burned note is a member of. The
                // contract gates it ∈ knownBitcoinRoot (canonical + relay-confirmed), so
                // it is not forgeable.
                let pool_root = r32();

                // Burned input note: membership in the Bitcoin pool.
                let (in_cx, in_cy, in_pt) = r_commitment();
                let in_owner = r32();
                let in_leaf_index: u64 = io::read();
                let in_path = r_path();
                let in_leaf = leaf(&asset, &in_cx, &in_cy, &in_owner);
                assert!(keccak_merkle_verify(&in_leaf, in_leaf_index, &in_path, &pool_root), "bridge_mint: btc pool membership");
                let nu = nullifier(&in_cx, &in_cy);

                // Destination note minted on Ethereum. Conservation binds v_out == v_in,
                // which requires knowledge of the burned note's blinding — so only its
                // owner can mint it (no third party can redirect the burn).
                let (out_cx, out_cy, out_pt) = r_commitment();
                let out_owner = r32();
                let dest_leaf = leaf(&asset, &out_cx, &out_cy, &out_owner);

                // Prove the note was burned FOR THE BRIDGE and bound to THIS destination: ν is
                // a live key in the bridge-burn set with value == dest_leaf. The burn set was
                // built only from cross-chain burns (OP_ENV_CONF_BURN), each pinning its
                // declared Ethereum destination — so an ordinary spend's ν is absent (can't
                // mint) and the destination cannot be redirected. The batch's bitcoin_burn_root
                // is pinned to the CURRENT reflected root on-chain (a stale/fabricated set is
                // rejected).
                assert!(bitcoin_burn_root != [0u8; 32], "bridge_mint: burn root required");
                let bm_next = r32();
                let bm_index: u64 = io::read();
                let bm_path = r_path();
                let bm_leaf = utxo_leaf(&nu, &bm_next, &dest_leaf);
                assert!(keccak_merkle_verify(&bm_leaf, bm_index, &bm_path, &bitcoin_burn_root), "bridge_mint: nu not in Bitcoin bridge-burn set, or wrong destination");

                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&[out_pt], &bp_proof), "bridge_mint: range");
                let kernel_r = decompress(&r33()).expect("bridge_mint: R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(verify_kernel(&[in_pt], &[out_pt], &kernel_r, &kernel_z), "bridge_mint: conservation");

                // Effects: mint the dest note, record the root, gate one-mint-per-burned-ν,
                // and consume ν in the GLOBAL Ethereum nullifier set. A Bitcoin-homed note
                // fast-spent on the Ethereum lane already marks ν there, so emitting ν here
                // makes the burn share that namespace — closing the fastlane→burn→mint
                // cross-lane double-spend (the contract's nullifier loop reverts a reused ν).
                leaves.push(dest_leaf);
                nullifiers.push(nu);
                bitcoin_burns.push(nu);
                bitcoin_roots.push(pool_root);
            }
            OP_UNWRAP => {
                // spend a note to a public recipient: membership + opening, pay out the
                // PROVEN in-system value. The contract scales it to underlying by the
                // asset's trusted unitScale, so the payout is bound to the note value
                // (the guest emits `value`, never an independent underlying amount).
                let asset = r32();
                let (cx, cy, c) = r_commitment();
                let owner = r32();
                let leaf_index: u64 = io::read();
                let path = r_path();
                let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                let value: u64 = io::read();
                let r = scalar_reduce_be(&r32());
                let recipient = r20();

                let lf = leaf(&asset, &cx, &cy, &owner);
                assert!(spend_root != [0u8; 32], "membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&lf, leaf_index, &path, &spend_root), "membership");
                assert!(verify_pedersen_opening(&c, value, &r), "unwrap opening");
                let nu = nullifier(&cx, &cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&nu, &bitcoin_spent_root); }
                nullifiers.push(nu);
                withdrawals.push(Withdrawal {
                    assetId: asset.into(),
                    recipient: Address::from(recipient),
                    value: U256::from(value),
                });
            }
            OP_ATTEST_META => {
                // Trustless metadata, CONFIRMATION-GATED. Prove (asset_id, ticker, decimals)
                // from the etch reveal tx AND that the asset is real + funded on the
                // relay-attested Bitcoin pool: a member note keyed by THIS asset_id exists
                // under a relay-confirmed pool root. asset_id = sha256(reveal_txid ‖ 0) binds
                // the txid → the envelope's ticker+decimals; the note membership binds the
                // asset_id to a confirmed Bitcoin deposit. A fabricated/unconfirmed etch has
                // no real note, so it cannot register junk metadata. The pool_root is pushed
                // to bitcoinRootsUsed → the contract already gates it ∈ knownBitcoinRoot.
                let etch_tx: Vec<u8> = io::read();
                let asset = bitcoin::asset_id_from_etch(&etch_tx);
                let env = bitcoin::extract_taproot_envelope(&etch_tx).expect("attest: envelope");
                let (ticker, tlen, decimals) = bitcoin::parse_etch_meta(&env).expect("attest: etch meta");

                // Confirmation: a note for THIS asset_id is a member of a relay-attested
                // Bitcoin pool root (proves the asset exists + is funded on Bitcoin).
                let cx = r32();
                let cy = r32();
                let owner = r32();
                let leaf_index: u64 = io::read();
                let path = r_path();
                let pool_root = r32();
                let lf = leaf(&asset, &cx, &cy, &owner);
                assert!(keccak_merkle_verify(&lf, leaf_index, &path, &pool_root), "attest: asset not in attested Bitcoin pool");
                bitcoin_roots.push(pool_root);

                asset_metas.push(AssetMeta {
                    assetId: asset.into(),
                    ticker: ticker.into(),
                    tickerLen: tlen,
                    decimals,
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
        bitcoinRootsUsed: bitcoin_roots.into_iter().map(Into::into).collect(),
        bitcoinSpentRoot: bitcoin_spent_root.into(),
        bitcoinBurnRoot: bitcoin_burn_root.into(),
        assetMetas: asset_metas,
    };
    io::commit_slice(&pv.abi_encode());
}
