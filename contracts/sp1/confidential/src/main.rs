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
    intent_context, keccak_merkle_verify, leaf, lp_share_id, nullifier, pool_id, scalar_reduce_be,
    utxo_leaf, verify_kernel, verify_opening_sigma, verify_pedersen_opening, verify_range, Point,
};
use sp1_zkvm::io;

const PV_VERSION: u16 = 1;
const OP_WRAP: u8 = 0;
const OP_TRANSFER: u8 = 1;
const OP_UNWRAP: u8 = 2;
const OP_BRIDGE_BURN: u8 = 3; // Ethereum note → Bitcoin (emit crossOut)
const OP_BRIDGE_MINT: u8 = 4; // Bitcoin burn → Ethereum note (verify Bitcoin burn)
const OP_ATTEST_META: u8 = 5; // etch reveal → prove (asset_id, ticker, decimals) trustlessly
const OP_SWAP: u8 = 6; // confidential AMM batch: hidden-amount swaps against public pool reserves
const OP_LP_ADD: u8 = 7; // confidential LP: add liquidity in-ratio, mint a shielded LP-share note
const OP_LP_REMOVE: u8 = 8; // confidential LP: burn a shielded LP-share note, withdraw the underlying

const SWAP_DIR_A_TO_B: u8 = 0;
const SWAP_DIR_B_TO_A: u8 = 1;

// Mirrors ConfidentialPool.PublicValues exactly.
sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
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
        SwapSettlement[] swaps;
        LpSettlement[] liquidity;
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

/// Cross-lane gate (cross-lane): assert `nu` is absent from the reflected
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
    // cross-lane: the reflected Bitcoin spent-set IMT root to prove each
    // spent ν absent against (0 = Ethereum-only, no cross-lane check).
    let bitcoin_spent_root = r32();
    // cross-lane: the reflected Bitcoin bridge-BURN IMT root (key = ν, value =
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
    let mut swaps: Vec<SwapSettlement> = Vec::new();
    let mut liquidity: Vec<LpSettlement> = Vec::new();

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
            OP_SWAP => {
                // Confidential AMM batch: hidden-amount swaps against a pool with PUBLIC reserves.
                // The guest computes the clearing, so it sees each intent's amounts (it is the
                // prover) — it binds them to the notes with a direct secp Pedersen opening (the same
                // accelerated primitive wrap/unwrap use): C_in opens to amount_in, C_out to
                // amount_out. (The cross-curve BJJ/sigma binding is only needed when amounts must be
                // hidden from the PROVER — the homomorphic-aggregation follow-up — not here.) The
                // typed u64 amount + the opening together ARE the range check. Only the NET reserve
                // move + ν + leaves are committed, so individual trade sizes stay private from
                // PublicValues readers. Safety: each trader is protected by min_out; the LPs by the
                // constant-product non-decrease (k_post ≥ k_pre) — no adversarial price can drain
                // the pool or short a trader.
                let asset_a = r32();
                let asset_b = r32();
                let pid = pool_id(&asset_a, &asset_b);
                let reserve_a_pre: u64 = io::read();
                let reserve_b_pre: u64 = io::read();
                let price_num: u64 = io::read(); // uniform price: price_num B per price_den A
                let price_den: u64 = io::read();
                assert!(price_num > 0 && price_den > 0, "swap: zero price");
                let n_intents: u32 = io::read();

                // u128 flow accumulators (sums of u64 amounts across the batch can exceed u64).
                let mut gross_a_in: u128 = 0;
                let mut gross_a_out: u128 = 0;
                let mut gross_b_in: u128 = 0;
                let mut gross_b_out: u128 = 0;

                for _ in 0..n_intents {
                    let direction: u8 = io::read();
                    assert!(direction == SWAP_DIR_A_TO_B || direction == SWAP_DIR_B_TO_A, "swap: bad direction");
                    let (in_asset, out_asset) = if direction == SWAP_DIR_A_TO_B {
                        (&asset_a, &asset_b)
                    } else {
                        (&asset_b, &asset_a)
                    };

                    // Input note: membership in the pool tree + nullifier (+ cross-lane gate).
                    let (in_cx, in_cy, in_pt) = r_commitment();
                    let in_owner = r32();
                    let in_leaf_index: u64 = io::read();
                    let in_path = r_path();
                    let in_lf = leaf(in_asset, &in_cx, &in_cy, &in_owner);
                    assert!(spend_root != [0u8; 32], "swap: membership requires a non-zero spend root");
                    assert!(keccak_merkle_verify(&in_lf, in_leaf_index, &in_path, &spend_root), "swap: membership");
                    let nu = nullifier(&in_cx, &in_cy);
                    if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&nu, &bitcoin_spent_root); }

                    let amount_in: u64 = io::read();
                    let amount_out: u64 = io::read();
                    let rem: u64 = io::read();
                    let in_sig_r = decompress(&r33()).expect("swap: in sigma R");
                    let in_sig_z = scalar_reduce_be(&r32());
                    let min_out: u64 = io::read();
                    let (out_cx, out_cy, out_pt) = r_commitment();
                    let out_owner = r32();
                    let out_sig_r = decompress(&r33()).expect("swap: out sigma R");
                    let out_sig_z = scalar_reduce_be(&r32());

                    // Bind each note to its amount by a Schnorr proof of knowledge of the opening
                    // blinding, NOT the raw blinding — so the settle prover (the box) verifies the
                    // amount without learning r, and thus cannot spend the input note or redirect the
                    // output. The challenge binds the whole intent context (both notes + owners +
                    // direction/amounts/min_out), so the box can't relabel out_owner or re-price. A
                    // lie about amount_in would need an r the prover can't find for the fixed
                    // (membership-pinned) C_in ⇒ no over-claim, no inflation; C_out commits to exactly
                    // amount_out so only the trader (who knows r_out, never sent) can later spend it.
                    let ctx = intent_context(
                        b"tacit-swap-intent-v1", &chain_binding, &asset_a, &asset_b,
                        &[(in_cx, in_cy, in_owner), (out_cx, out_cy, out_owner)],
                        &[direction as u64, amount_in, amount_out, min_out],
                    );
                    assert!(verify_opening_sigma(&in_pt, amount_in, &in_sig_r, &in_sig_z, &ctx), "swap: input opening");
                    assert!(verify_opening_sigma(&out_pt, amount_out, &out_sig_r, &out_sig_z, &ctx), "swap: output opening");

                    // Uniform-price clearing: amount_out = floor(amount_in · P), one price per batch.
                    //   A→B: in·num == out·den + rem,  rem < den
                    //   B→A: in·den == out·num + rem,  rem < num   (P inverted for the other side)
                    let ain = amount_in as u128;
                    let aout = amount_out as u128;
                    let num = price_num as u128;
                    let den = price_den as u128;
                    let r = rem as u128;
                    if direction == SWAP_DIR_A_TO_B {
                        assert!(r < den, "swap: rem range A→B");
                        assert!(ain * num == aout * den + r, "swap: clearing A→B");
                        gross_a_in += ain;
                        gross_b_out += aout;
                    } else {
                        assert!(r < num, "swap: rem range B→A");
                        assert!(ain * den == aout * num + r, "swap: clearing B→A");
                        gross_b_in += ain;
                        gross_a_out += aout;
                    }
                    assert!(amount_out >= min_out, "swap: min_out");

                    nullifiers.push(nu);
                    leaves.push(leaf(out_asset, &out_cx, &out_cy, &out_owner));
                }

                // Net reserve move (no underflow), and the constant-product non-decrease.
                let a_pre = reserve_a_pre as u128;
                let b_pre = reserve_b_pre as u128;
                assert!(a_pre + gross_a_in >= gross_a_out, "swap: reserve A underflow");
                assert!(b_pre + gross_b_in >= gross_b_out, "swap: reserve B underflow");
                let a_post = a_pre + gross_a_in - gross_a_out;
                let b_post = b_pre + gross_b_in - gross_b_out;
                assert!(a_post <= u64::MAX as u128 && b_post <= u64::MAX as u128, "swap: reserve overflow");
                assert!(a_post * b_post >= a_pre * b_pre, "swap: constant-product decreased");

                swaps.push(SwapSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(reserve_a_pre),
                    reserveBPre: U256::from(reserve_b_pre),
                    reserveAPost: U256::from(a_post as u64),
                    reserveBPost: U256::from(b_post as u64),
                });
            }
            OP_LP_ADD => {
                // Confidential add-liquidity: spend an A note + a B note (the LP's contribution, each
                // bound to its amount by a secp opening), add them IN RATIO to the public reserves, and
                // mint a shielded LP-share note for the proportional shares. The LP-share NOTE hides the
                // provider's ownership + total position; reserves + totalShares stay public.
                let asset_a = r32();
                let asset_b = r32();
                let pid = pool_id(&asset_a, &asset_b);
                let lp_asset = lp_share_id(&pid);
                let r_a_pre: u64 = io::read();
                let r_b_pre: u64 = io::read();
                let shares_pre: u64 = io::read();

                let (a_cx, a_cy, a_pt) = r_commitment();
                let a_owner = r32();
                let a_idx: u64 = io::read();
                let a_path = r_path();
                let d_a: u64 = io::read();
                let a_sig_r = decompress(&r33()).expect("lp_add: A sigma R");
                let a_sig_z = scalar_reduce_be(&r32());
                let (b_cx, b_cy, b_pt) = r_commitment();
                let b_owner = r32();
                let b_idx: u64 = io::read();
                let b_path = r_path();
                let d_b: u64 = io::read();
                let b_sig_r = decompress(&r33()).expect("lp_add: B sigma R");
                let b_sig_z = scalar_reduce_be(&r32());
                let d_shares: u64 = io::read();
                let rem: u64 = io::read();
                let (s_cx, s_cy, s_pt) = r_commitment();
                let s_owner = r32();
                let s_sig_r = decompress(&r33()).expect("lp_add: share sigma R");
                let s_sig_z = scalar_reduce_be(&r32());

                // The intent context binds all three notes + the deltas: the box can't redirect the
                // minted LP-share note or alter the contributed amounts (the sigmas commit to it), and
                // never learns a blinding (so it can't spend the spent A/B contribution notes).
                let ctx = intent_context(
                    b"tacit-lp-add-v1", &chain_binding, &asset_a, &asset_b,
                    &[(a_cx, a_cy, a_owner), (b_cx, b_cy, b_owner), (s_cx, s_cy, s_owner)],
                    &[d_a, d_b, d_shares],
                );

                // Spend the two contribution notes: membership + ν + cross-lane + opening sigma (binds d_a/d_b).
                let a_lf = leaf(&asset_a, &a_cx, &a_cy, &a_owner);
                assert!(spend_root != [0u8; 32], "lp_add: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&a_lf, a_idx, &a_path, &spend_root), "lp_add: A membership");
                let a_nu = nullifier(&a_cx, &a_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&a_nu, &bitcoin_spent_root); }
                assert!(verify_opening_sigma(&a_pt, d_a, &a_sig_r, &a_sig_z, &ctx), "lp_add: A opening");
                let b_lf = leaf(&asset_b, &b_cx, &b_cy, &b_owner);
                assert!(keccak_merkle_verify(&b_lf, b_idx, &b_path, &spend_root), "lp_add: B membership");
                let b_nu = nullifier(&b_cx, &b_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&b_nu, &bitcoin_spent_root); }
                assert!(verify_opening_sigma(&b_pt, d_b, &b_sig_r, &b_sig_z, &ctx), "lp_add: B opening");

                let da = d_a as u128; let db = d_b as u128;
                let ra = r_a_pre as u128; let rb = r_b_pre as u128;
                let sp = shares_pre as u128; let ds = d_shares as u128; let rm = rem as u128;
                // The pool must already exist (initPool seeds it); add IN RATIO, proportional shares.
                assert!(ra > 0 && rb > 0 && sp > 0, "lp_add: pool must be initialized");
                assert!(da * rb == db * ra, "lp_add: not in pool ratio");
                assert!(rm < ra, "lp_add: shares rem range");
                assert!(sp * da == ds * ra + rm, "lp_add: proportional shares (floor totalShares·dA/R_A)");
                // The minted LP-share note opens to d_shares (can't claim more than earned).
                assert!(verify_opening_sigma(&s_pt, d_shares, &s_sig_r, &s_sig_z, &ctx), "lp_add: share opening");
                assert!((ra + da) <= u64::MAX as u128 && (rb + db) <= u64::MAX as u128 && (sp + ds) <= u64::MAX as u128, "lp_add: overflow");

                nullifiers.push(a_nu);
                nullifiers.push(b_nu);
                leaves.push(leaf(&lp_asset, &s_cx, &s_cy, &s_owner));
                liquidity.push(LpSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(r_a_pre), reserveBPre: U256::from(r_b_pre), sharesPre: U256::from(shares_pre),
                    reserveAPost: U256::from((ra + da) as u64), reserveBPost: U256::from((rb + db) as u64), sharesPost: U256::from((sp + ds) as u64),
                });
            }
            OP_LP_REMOVE => {
                // Confidential remove-liquidity: spend a shielded LP-share note, withdraw the proportional
                // underlying as fresh A/B notes. The share note proves the LP's stake (opening); the
                // withdrawal is floored toward the pool so the dust accrues to the remaining LPs.
                let asset_a = r32();
                let asset_b = r32();
                let pid = pool_id(&asset_a, &asset_b);
                let lp_asset = lp_share_id(&pid);
                let r_a_pre: u64 = io::read();
                let r_b_pre: u64 = io::read();
                let shares_pre: u64 = io::read();

                let (s_cx, s_cy, s_pt) = r_commitment();
                let s_owner = r32();
                let s_idx: u64 = io::read();
                let s_path = r_path();
                let d_shares: u64 = io::read();
                let s_sig_r = decompress(&r33()).expect("lp_remove: share sigma R");
                let s_sig_z = scalar_reduce_be(&r32());
                let d_a: u64 = io::read();
                let rem_a: u64 = io::read();
                let d_b: u64 = io::read();
                let rem_b: u64 = io::read();
                let (a_cx, a_cy, a_pt) = r_commitment();
                let a_owner = r32();
                let a_sig_r = decompress(&r33()).expect("lp_remove: A sigma R");
                let a_sig_z = scalar_reduce_be(&r32());
                let (b_cx, b_cy, b_pt) = r_commitment();
                let b_owner = r32();
                let b_sig_r = decompress(&r33()).expect("lp_remove: B sigma R");
                let b_sig_z = scalar_reduce_be(&r32());

                // Intent context binds the spent LP-share note + the two minted A/B notes + the
                // amounts: the box can't redirect the withdrawn A/B notes or alter d_shares/dA/dB, and
                // never learns the share blinding (so it can't spend the LP-share note).
                let ctx = intent_context(
                    b"tacit-lp-remove-v1", &chain_binding, &asset_a, &asset_b,
                    &[(s_cx, s_cy, s_owner), (a_cx, a_cy, a_owner), (b_cx, b_cy, b_owner)],
                    &[d_shares, d_a, d_b],
                );

                // Spend the LP-share note: membership + ν + cross-lane + opening sigma (binds d_shares).
                let s_lf = leaf(&lp_asset, &s_cx, &s_cy, &s_owner);
                assert!(spend_root != [0u8; 32], "lp_remove: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&s_lf, s_idx, &s_path, &spend_root), "lp_remove: share membership");
                let s_nu = nullifier(&s_cx, &s_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&s_nu, &bitcoin_spent_root); }
                assert!(verify_opening_sigma(&s_pt, d_shares, &s_sig_r, &s_sig_z, &ctx), "lp_remove: share opening");

                let da = d_a as u128; let db = d_b as u128;
                let ra = r_a_pre as u128; let rb = r_b_pre as u128;
                let sp = shares_pre as u128; let ds = d_shares as u128;
                assert!(sp > 0 && ds > 0 && ds <= sp, "lp_remove: shares in range");
                // Proportional withdrawal, floor toward the pool (dust stays for remaining LPs).
                assert!((rem_a as u128) < sp, "lp_remove: remA range");
                assert!(ra * ds == da * sp + rem_a as u128, "lp_remove: dA = floor(R_A·shares/total)");
                assert!((rem_b as u128) < sp, "lp_remove: remB range");
                assert!(rb * ds == db * sp + rem_b as u128, "lp_remove: dB = floor(R_B·shares/total)");
                // The withdrawn A/B notes open to dA/dB (sigma — the box never learns r_a/r_b).
                assert!(verify_opening_sigma(&a_pt, d_a, &a_sig_r, &a_sig_z, &ctx), "lp_remove: A opening");
                assert!(verify_opening_sigma(&b_pt, d_b, &b_sig_r, &b_sig_z, &ctx), "lp_remove: B opening");

                nullifiers.push(s_nu);
                leaves.push(leaf(&asset_a, &a_cx, &a_cy, &a_owner));
                leaves.push(leaf(&asset_b, &b_cx, &b_cy, &b_owner));
                liquidity.push(LpSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(r_a_pre), reserveBPre: U256::from(r_b_pre), sharesPre: U256::from(shares_pre),
                    reserveAPost: U256::from((ra - da) as u64), reserveBPost: U256::from((rb - db) as u64), sharesPost: U256::from((sp - ds) as u64),
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
        swaps,
        liquidity,
    };
    io::commit_slice(&pv.abi_encode());
}
