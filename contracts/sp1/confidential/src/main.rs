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
    adaptor_lock_leaf, bitcoin, claim_id, clearing_price_matches, decompress, deposit_id, from_affine_xy,
    get_amount_out, imt_non_membership, intent_context, isqrt, keccak_merkle_verify, leaf, lp_add_shares,
    lp_share_id, nullifier, pool_id, scalar_reduce_be, utxo_leaf, verify_kernel, verify_opening_sigma,
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
const OP_SWAP: u8 = 6; // confidential AMM batch: hidden-amount swaps against public pool reserves
const OP_LP_ADD: u8 = 7; // confidential LP: add liquidity in-ratio, mint a shielded LP-share note
const OP_LP_REMOVE: u8 = 8; // confidential LP: burn a shielded LP-share note, withdraw the underlying
const OP_OTC: u8 = 9; // confidential OTC: 2-party direct swap of shielded notes (no pool)
const OP_BID: u8 = 10; // confidential partial-fill bid: buyer-offline limit order, seller fills a grid amount
const OP_SWAP_ROUTE: u8 = 11; // confidential multihop: route one input note through ≤ MAX_ROUTE_HOPS pools
const MAX_ROUTE_HOPS: u32 = 4; // bound the per-route hop count (mirrors the Bitcoin route op)
const OP_ADAPTOR_LOCK: u8 = 12; // adaptor swap: lock a note into the lock-set under (T, deadline, recipient)
const OP_ADAPTOR_CLAIM: u8 = 13; // adaptor swap: claim a locked note before its deadline, revealing the kernel s
const OP_ADAPTOR_REFUND: u8 = 14; // adaptor swap: refund a locked note to its locker after the deadline

const SWAP_DIR_A_TO_B: u8 = 0;
const SWAP_DIR_B_TO_A: u8 = 1;

/// Permanently-locked LP-share floor — MUST equal ConfidentialPool.MINIMUM_LIQUIDITY. A pool's
/// totalShares can never drop below this (no note holds the locked shares), so an OP_LP_REMOVE that
/// would breach it is rejected in-guest (fail-fast, defense-in-depth with the same on-chain gate).
const MINIMUM_LIQUIDITY: u128 = 1000;

// Mirrors ConfidentialPool.PublicValues exactly.
sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; bytes32 cid; }
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
        uint64 deadline; // settle expiry (unix secs); 0 = none. The box can't relay a stale proof past it (Expired)
        // ── adaptor-swap (ops 12–14): the cross-chain atomic-swap lock-set ──────────────────────────
        bytes32 lockSetRoot; // INPUT: the lock-set root claim/refund membership is proven against (contract checks == stored)
        bytes32[] lockLeaves; // adaptor_lock_leaf values appended to the lock-set by OP_ADAPTOR_LOCK
        bytes32[] lockNullifiers; // ν_L consumed by claim/refund → the lock-spent set (spend-once, contract dedups)
        bytes32[] adaptorClaimS; // the completed kernel `s` per claim — the t-reveal channel the Bitcoin counterparty reads
        uint64 refundNotBefore; // contract gate: block.timestamp >= this for the batch (max refund deadline; 0 = no refunds)
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
    // adaptor swap: the lock-set root claim/refund prove membership against (0 = no lock-set yet / no
    // claim/refund this batch). The contract checks it == its stored lock-set root before advancing.
    let lock_set_root = r32();
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
    // Per-op deadline (Expired), bound in each trading op's sigma context so the box can't forge or
    // stretch it. The guest commits the EARLIEST non-zero deadline; the contract enforces it vs block.time.
    let mut min_deadline: u64 = 0;
    // adaptor-swap accumulators (ops 12–14). lock_leaves append to the lock-set; lock_nullifiers spend a
    // locked note once; adaptor_claim_s carries each claim's completed kernel `s` (t-reveal). refund_not_before
    // is the LATEST refund deadline in the batch — the contract gates block.timestamp >= it (the ≥ mirror of
    // the ≤ `deadline` gate that covers claims).
    let mut lock_leaves: Vec<[u8; 32]> = Vec::new();
    let mut lock_nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut adaptor_claim_s: Vec<[u8; 32]> = Vec::new();
    let mut refund_not_before: u64 = 0;

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
                let asset = bitcoin::asset_id_from_etch(&etch_tx).expect("attest: malformed etch tx");
                let env = bitcoin::extract_taproot_envelope(&etch_tx).expect("attest: envelope");
                let (ticker, tlen, decimals, cid) = bitcoin::parse_etch_meta(&env).expect("attest: etch meta");

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
                    cid: cid.into(),
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
                // PublicValues readers. Safety: a trader gets EXACTLY the output their opening sigma
                // binds (the box can't re-price or short them) and the settle reverts if the pool
                // moved (the contract gates reserve_*_pre == the live reserves); min_out is the
                // trader's own floor on that signed output (it can only reject their own intent, not
                // an adversary). LPs are protected by the constant-product non-decrease (k_post ≥
                // k_pre) — no adversarial price can drain the pool.
                let asset_a = r32();
                let asset_b = r32();
                let fee_bps: u32 = io::read(); // pool fee tier — binds the pool id (multi-fee-tier)
                let pid = pool_id(&asset_a, &asset_b, fee_bps);
                // Canonical orientation: asset_a MUST be the low asset of the (sorted) pool pair, so it
                // maps to the contract's p.reserveA. pool_id sorts internally, so a reversed (asset_a,
                // asset_b) witness yields the SAME pid; without this a prover could pass the high asset as
                // asset_a with the low asset's reserve and clear the batch on a swapped reserve→asset map,
                // minting the high-value leg for the low-value one (settle gates p.reserveA == reserve_a_pre
                // but never the asset identities — the guest is the only orientation pin).
                assert!(bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b, "swap: non-canonical asset order");
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
                    let intent_deadline: u64 = io::read(); // bound in this trader's sigma (per-op Expired)
                    if intent_deadline != 0 { min_deadline = if min_deadline == 0 { intent_deadline } else { min_deadline.min(intent_deadline) }; }
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
                        &[direction as u64, amount_in, amount_out, min_out, intent_deadline],
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

                // Enforce the pool's FEE TIER: re-derive the deterministic clearing price (AMM.md §4)
                // from the public reserves + gross flows + fee_bps and require the batch's declared
                // uniform price to equal it EXACTLY. The constant-product non-decrease above is only the
                // ZERO-fee floor; without this a self-solved batch could clear at the zero-fee price and
                // starve LPs of the fee they're owed. This makes the fee tier economically real.
                assert!(gross_a_in <= u64::MAX as u128 && gross_b_in <= u64::MAX as u128, "swap: gross flow over u64");
                assert!(
                    clearing_price_matches(gross_a_in as u64, gross_b_in as u64, reserve_a_pre, reserve_b_pre, fee_bps, price_num, price_den),
                    "swap: declared price is not the fee-clearing price"
                );

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
                // bound to its amount by a secp opening), add them to the public reserves, and mint a
                // shielded LP-share note for the proportional shares (the min rule below — an
                // off-ratio add earns the limiting leg). The LP-share NOTE hides the provider's ownership
                // + total position; reserves + totalShares stay public.
                let asset_a = r32();
                let asset_b = r32();
                let fee_bps: u32 = io::read(); // pool fee tier — binds the pool id (multi-fee-tier)
                let pid = pool_id(&asset_a, &asset_b, fee_bps);
                // Canonical orientation (see OP_SWAP): asset_a must be the low asset that maps to the
                // contract's p.reserveA, else an in-ratio add could be cleared against a swapped
                // reserve→asset map.
                assert!(bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b, "lp_add: non-canonical asset order");
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
                let (s_cx, s_cy, s_pt) = r_commitment();
                let s_owner = r32();
                let s_sig_r = decompress(&r33()).expect("lp_add: share sigma R");
                let s_sig_z = scalar_reduce_be(&r32());
                let op_deadline: u64 = io::read(); // bound in the LP's sigma (per-op Expired)
                if op_deadline != 0 { min_deadline = if min_deadline == 0 { op_deadline } else { min_deadline.min(op_deadline) }; }

                // Constant-product mint: the FIRST provider (empty pool, shares_pre==0) sets totalShares =
                // isqrt(dA·dB) and gets isqrt − MINIMUM_LIQUIDITY as their note (MINIMUM_LIQUIDITY = the
                // permanent NOTELESS floor, so reserves can never fully drain → the (pair,fee) slot can't be
                // bricked); they set the price, reserves are SET not added. Every SUBSEQUENT provider earns
                // the MIN rule min(floor(S·dA/R_A), floor(S·dB/R_B)) — off-ratio safe (the excess accrues to
                // the pool), no exact-ratio gate (the old `dA·R_B == dB·R_A` forced dA to be a multiple of
                // R_A/gcd and broke incremental adds once a traded pool went coprime). d_shares is DERIVED
                // in-guest (not witnessed), so it can't be over-claimed; the share note must open to it.
                let da = d_a as u128; let db = d_b as u128;
                let ra = r_a_pre as u128; let rb = r_b_pre as u128; let sp = shares_pre as u128;
                let (d_shares_u128, r_a_post, r_b_post, s_post): (u128, u128, u128, u128) = if shares_pre == 0 {
                    assert!(r_a_pre == 0 && r_b_pre == 0, "lp_add: first mint requires an empty pool");
                    assert!(da > 0 && db > 0, "lp_add: first mint needs both sides");
                    assert!(da <= u64::MAX as u128 && db <= u64::MAX as u128, "lp_add: first-mint reserve overflow");
                    let total = isqrt(da * db);
                    assert!(total > MINIMUM_LIQUIDITY, "lp_add: initial liquidity below MINIMUM_LIQUIDITY");
                    (total - MINIMUM_LIQUIDITY, da, db, total)
                } else {
                    assert!(ra > 0 && rb > 0, "lp_add: pool must be initialized");
                    let ds = lp_add_shares(shares_pre, d_a, d_b, r_a_pre, r_b_pre);
                    assert!(ds > 0, "lp_add: zero shares minted (dust add)"); // reject a dust add that mints nothing
                    assert!((ra + da) <= u64::MAX as u128 && (rb + db) <= u64::MAX as u128 && (sp + ds) <= u64::MAX as u128, "lp_add: overflow");
                    (ds, ra + da, rb + db, sp + ds)
                };
                assert!(d_shares_u128 <= u64::MAX as u128, "lp_add: shares overflow");
                let d_shares = d_shares_u128 as u64;

                // The intent context binds all three notes + the deltas (incl. the DERIVED d_shares): the
                // box can't redirect the minted LP-share note or alter the amounts (the sigmas commit to
                // it), and never learns a blinding (so it can't spend the A/B contribution notes).
                let ctx = intent_context(
                    b"tacit-lp-add-v1", &chain_binding, &asset_a, &asset_b,
                    &[(a_cx, a_cy, a_owner), (b_cx, b_cy, b_owner), (s_cx, s_cy, s_owner)],
                    &[d_a, d_b, d_shares, op_deadline],
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

                // The minted LP-share note opens to the DERIVED d_shares (can't claim more than earned).
                assert!(verify_opening_sigma(&s_pt, d_shares, &s_sig_r, &s_sig_z, &ctx), "lp_add: share opening");

                nullifiers.push(a_nu);
                nullifiers.push(b_nu);
                leaves.push(leaf(&lp_asset, &s_cx, &s_cy, &s_owner));
                liquidity.push(LpSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(r_a_pre), reserveBPre: U256::from(r_b_pre), sharesPre: U256::from(shares_pre),
                    reserveAPost: U256::from(r_a_post as u64), reserveBPost: U256::from(r_b_post as u64), sharesPost: U256::from(s_post as u64),
                });
            }
            OP_LP_REMOVE => {
                // Confidential remove-liquidity: spend a shielded LP-share note, withdraw the proportional
                // underlying as fresh A/B notes. The share note proves the LP's stake (opening); the
                // withdrawal is floored toward the pool so the dust accrues to the remaining LPs.
                let asset_a = r32();
                let asset_b = r32();
                let fee_bps: u32 = io::read(); // pool fee tier — binds the pool id (multi-fee-tier)
                let pid = pool_id(&asset_a, &asset_b, fee_bps);
                // Canonical orientation (see OP_SWAP): asset_a must be the low asset that maps to the
                // contract's p.reserveA, else the proportional withdrawal da=floor(R_A·ds/sp) — computed
                // from the low reserve — would be emitted as the HIGH-value asset_a note (LP over-withdraw).
                assert!(bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b, "lp_remove: non-canonical asset order");
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
                let op_deadline: u64 = io::read(); // bound in the LP's sigma (per-op Expired)
                if op_deadline != 0 { min_deadline = if min_deadline == 0 { op_deadline } else { min_deadline.min(op_deadline) }; }

                // Intent context binds the spent LP-share note + the two minted A/B notes + the
                // amounts: the box can't redirect the withdrawn A/B notes or alter d_shares/dA/dB, and
                // never learns the share blinding (so it can't spend the LP-share note).
                let ctx = intent_context(
                    b"tacit-lp-remove-v1", &chain_binding, &asset_a, &asset_b,
                    &[(s_cx, s_cy, s_owner), (a_cx, a_cy, a_owner), (b_cx, b_cy, b_owner)],
                    &[d_shares, d_a, d_b, op_deadline],
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
                // The locked MINIMUM_LIQUIDITY can never be removed (no note holds it), so totalShares
                // stays ≥ MINIMUM_LIQUIDITY — keeping the (pair,fee) slot live after a full exit. Reject
                // a remove that would breach it in-guest (fail-fast; the contract enforces the same gate).
                assert!(sp - ds >= MINIMUM_LIQUIDITY, "lp_remove: would breach MINIMUM_LIQUIDITY floor");
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
            OP_OTC => {
                // Direct 2-party confidential swap (no pool / no price curve): the MAKER gives
                // `v_a` of asset_a and receives `v_b` of asset_b; the TAKER gives `v_b` of asset_b
                // and receives `v_a` of asset_a. Atomic — one op = one proof = all-or-nothing. Each
                // note is bound by an opening sigma under a SHARED intent context (both assets, both
                // amounts, every touched note + its owner), so the settle prover can neither redirect
                // an output (the receiving owner is in the context) nor re-price the trade — the OTC
                // analog of OP_SWAP's binding. Per-asset conservation ties each party's spent input to
                // the counterparty's received note + that party's own change. Amounts are prover-
                // visible (the matcher) but kept out of PublicValues; only ν + leaves are committed.
                let asset_a = r32();
                let asset_b = r32();
                let v_a: u64 = io::read();
                let v_b: u64 = io::read();
                assert!(v_a > 0 && v_b > 0, "otc: zero amount");
                assert!(asset_a != asset_b, "otc: same asset");
                let maker_owner = r32();
                let taker_owner = r32();

                // ---- Maker input (asset_a): membership + ν + cross-lane gate ----
                let (m_in_cx, m_in_cy, m_in_pt) = r_commitment();
                let m_in_index: u64 = io::read();
                let m_in_path = r_path();
                let m_in_lf = leaf(&asset_a, &m_in_cx, &m_in_cy, &maker_owner);
                assert!(spend_root != [0u8; 32], "otc: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&m_in_lf, m_in_index, &m_in_path, &spend_root), "otc: maker membership");
                let m_nu = nullifier(&m_in_cx, &m_in_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&m_nu, &bitcoin_spent_root); }
                let m_in_amount: u64 = io::read();
                let m_in_sig_r = decompress(&r33()).expect("otc: maker-in R");
                let m_in_sig_z = scalar_reduce_be(&r32());
                // Maker change (asset_a), optional (value = m_in_amount - v_a).
                let m_has_change: u8 = io::read();
                let m_change = if m_has_change == 1 {
                    let (cx, cy, pt) = r_commitment();
                    let sr = decompress(&r33()).expect("otc: maker-change R");
                    let sz = scalar_reduce_be(&r32());
                    Some((cx, cy, pt, sr, sz))
                } else { None };
                // Maker received (asset_b, value v_b).
                let (m_rv_cx, m_rv_cy, m_rv_pt) = r_commitment();
                let m_rv_sig_r = decompress(&r33()).expect("otc: maker-recv R");
                let m_rv_sig_z = scalar_reduce_be(&r32());

                // ---- Taker input (asset_b): membership + ν + cross-lane gate ----
                let (t_in_cx, t_in_cy, t_in_pt) = r_commitment();
                let t_in_index: u64 = io::read();
                let t_in_path = r_path();
                let t_in_lf = leaf(&asset_b, &t_in_cx, &t_in_cy, &taker_owner);
                assert!(keccak_merkle_verify(&t_in_lf, t_in_index, &t_in_path, &spend_root), "otc: taker membership");
                let t_nu = nullifier(&t_in_cx, &t_in_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&t_nu, &bitcoin_spent_root); }
                let t_in_amount: u64 = io::read();
                let t_in_sig_r = decompress(&r33()).expect("otc: taker-in R");
                let t_in_sig_z = scalar_reduce_be(&r32());
                // Taker change (asset_b), optional (value = t_in_amount - v_b).
                let t_has_change: u8 = io::read();
                let t_change = if t_has_change == 1 {
                    let (cx, cy, pt) = r_commitment();
                    let sr = decompress(&r33()).expect("otc: taker-change R");
                    let sz = scalar_reduce_be(&r32());
                    Some((cx, cy, pt, sr, sz))
                } else { None };
                // Taker received (asset_a, value v_a).
                let (t_rv_cx, t_rv_cy, t_rv_pt) = r_commitment();
                let t_rv_sig_r = decompress(&r33()).expect("otc: taker-recv R");
                let t_rv_sig_z = scalar_reduce_be(&r32());

                // ---- Shared intent context: every touched note + owner + both amounts ----
                let mut ctx_notes: Vec<([u8; 32], [u8; 32], [u8; 32])> =
                    vec![(m_in_cx, m_in_cy, maker_owner)];
                if let Some((cx, cy, _, _, _)) = m_change { ctx_notes.push((cx, cy, maker_owner)); }
                ctx_notes.push((m_rv_cx, m_rv_cy, maker_owner));
                ctx_notes.push((t_in_cx, t_in_cy, taker_owner));
                if let Some((cx, cy, _, _, _)) = t_change { ctx_notes.push((cx, cy, taker_owner)); }
                ctx_notes.push((t_rv_cx, t_rv_cy, taker_owner));
                let op_deadline: u64 = io::read(); // bound in BOTH parties' sigmas (per-op Expired)
                if op_deadline != 0 { min_deadline = if min_deadline == 0 { op_deadline } else { min_deadline.min(op_deadline) }; }
                let ctx = intent_context(
                    b"tacit-otc-intent-v1", &chain_binding, &asset_a, &asset_b,
                    &ctx_notes, &[v_a, v_b, op_deadline],
                );

                // ---- Authorizations: each party's input opens (proving the spend is theirs) and
                //      each output opens to its bound amount (no redirect / no re-price) ----
                assert!(verify_opening_sigma(&m_in_pt, m_in_amount, &m_in_sig_r, &m_in_sig_z, &ctx), "otc: maker-in opening");
                assert!(verify_opening_sigma(&t_in_pt, t_in_amount, &t_in_sig_r, &t_in_sig_z, &ctx), "otc: taker-in opening");
                assert!(verify_opening_sigma(&m_rv_pt, v_b, &m_rv_sig_r, &m_rv_sig_z, &ctx), "otc: maker-recv opening");
                assert!(verify_opening_sigma(&t_rv_pt, v_a, &t_rv_sig_r, &t_rv_sig_z, &ctx), "otc: taker-recv opening");

                // ---- Per-asset conservation (u128 sums; canonical change form) ----
                let change_a: u64 = match m_change {
                    Some((_, _, pt, sr, sz)) => {
                        assert!(m_in_amount > v_a, "otc: maker change requires input > give");
                        let c = m_in_amount - v_a;
                        assert!(verify_opening_sigma(&pt, c, &sr, &sz, &ctx), "otc: maker-change opening");
                        c
                    }
                    None => { assert!(m_in_amount == v_a, "otc: maker exact input required without change"); 0 }
                };
                let change_b: u64 = match t_change {
                    Some((_, _, pt, sr, sz)) => {
                        assert!(t_in_amount > v_b, "otc: taker change requires input > give");
                        let c = t_in_amount - v_b;
                        assert!(verify_opening_sigma(&pt, c, &sr, &sz, &ctx), "otc: taker-change opening");
                        c
                    }
                    None => { assert!(t_in_amount == v_b, "otc: taker exact input required without change"); 0 }
                };
                assert!(m_in_amount as u128 == v_a as u128 + change_a as u128, "otc: asset_a conservation");
                assert!(t_in_amount as u128 == v_b as u128 + change_b as u128, "otc: asset_b conservation");

                // ---- Emit ν + leaves (fixed order; client + memos mirror it) ----
                nullifiers.push(m_nu);
                nullifiers.push(t_nu);
                leaves.push(leaf(&asset_a, &t_rv_cx, &t_rv_cy, &taker_owner)); // taker receives asset_a (v_a)
                leaves.push(leaf(&asset_b, &m_rv_cx, &m_rv_cy, &maker_owner)); // maker receives asset_b (v_b)
                if let Some((cx, cy, _, _, _)) = m_change { leaves.push(leaf(&asset_a, &cx, &cy, &maker_owner)); }
                if let Some((cx, cy, _, _, _)) = t_change { leaves.push(leaf(&asset_b, &cx, &cy, &taker_owner)); }
            }
            OP_BID => {
                // Buyer-offline partial-fill bid (confidential limit order; Bitcoin T_PREAUTH_BID_VAR
                // parity). The buyer pre-funds V_fund = max_fill·price of asset_b and pre-signs, per
                // grid fill, the openings of its received notes (the filled asset_a + the asset_b
                // refund) with blindings only it can reproduce, then walks away. A seller picks a grid
                // `chosen_f`, delivers it of asset_a, receives chosen_f·price of asset_b; the buyer
                // gets chosen_f of asset_a + (max_fill−chosen_f)·price refunded. The K presig lives
                // OFF-CHAIN (the published bid) — the witness carries only the chosen fill's openings,
                // which only the buyer could have produced, so a seller can only fill at a pre-signed
                // amount and can neither under-deliver nor redirect. No pool state; emits leaves +
                // nullifiers the contract already applies (no PublicValues change).
                let asset_a = r32();
                let asset_b = r32();
                let min_fill: u64 = io::read();
                let max_fill: u64 = io::read();
                let price: u64 = io::read();
                let increment: u64 = io::read();
                assert!(min_fill > 0 && price > 0 && increment > 0, "bid: zero term");
                assert!(max_fill >= min_fill, "bid: max < min");
                assert!((max_fill - min_fill) % increment == 0, "bid: grid not increment-aligned");
                assert!(asset_a != asset_b, "bid: same asset");
                let buyer_owner = r32();

                // Buyer funding note (asset_b, value V_fund): membership + ν + cross-lane gate.
                let (fund_cx, fund_cy, fund_pt) = r_commitment();
                let fund_index: u64 = io::read();
                let fund_path = r_path();
                let fund_lf = leaf(&asset_b, &fund_cx, &fund_cy, &buyer_owner);
                assert!(spend_root != [0u8; 32], "bid: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&fund_lf, fund_index, &fund_path, &spend_root), "bid: funding membership");
                let fund_nu = nullifier(&fund_cx, &fund_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&fund_nu, &bitcoin_spent_root); }
                let fund_sig_r = decompress(&r33()).expect("bid: fund R");
                let fund_sig_z = scalar_reduce_be(&r32());

                // Chosen fill (on the grid) + the buyer's pre-signed received notes for it.
                let chosen_f: u64 = io::read();
                assert!(chosen_f >= min_fill && chosen_f <= max_fill, "bid: fill out of range");
                assert!((chosen_f - min_fill) % increment == 0, "bid: fill off grid");
                let (ra_cx, ra_cy, ra_pt) = r_commitment(); // buyer receives asset_a (chosen_f)
                let ra_sig_r = decompress(&r33()).expect("bid: recv-a R");
                let ra_sig_z = scalar_reduce_be(&r32());

                // Amounts (u128 → u64 guards).
                let v_fund_u = max_fill as u128 * price as u128;
                assert!(v_fund_u <= u64::MAX as u128, "bid: V_fund over u64");
                let v_fund = v_fund_u as u64;
                let pay = (chosen_f as u128 * price as u128) as u64; // ≤ v_fund
                let refund = v_fund - pay; // (max_fill − chosen_f)·price

                // Buyer refund (asset_b), present ONLY on a partial fill (refund > 0; a 0-value note
                // isn't constructible). Full fill (chosen_f == max_fill) ⇒ no refund note.
                let refund_note = if chosen_f < max_fill {
                    assert!(refund > 0, "bid: partial fill must refund");
                    let (cx, cy, pt) = r_commitment();
                    let sr = decompress(&r33()).expect("bid: refund R");
                    let sz = scalar_reduce_be(&r32());
                    Some((cx, cy, pt, sr, sz))
                } else {
                    assert!(refund == 0, "bid: full fill has no refund");
                    None
                };

                // Seller input (asset_a): membership + ν + cross-lane gate.
                let (s_in_cx, s_in_cy, s_in_pt) = r_commitment();
                let s_owner = r32();
                let s_in_index: u64 = io::read();
                let s_in_path = r_path();
                let s_in_lf = leaf(&asset_a, &s_in_cx, &s_in_cy, &s_owner);
                assert!(keccak_merkle_verify(&s_in_lf, s_in_index, &s_in_path, &spend_root), "bid: seller membership");
                let s_nu = nullifier(&s_in_cx, &s_in_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&s_nu, &bitcoin_spent_root); }
                let s_in_amount: u64 = io::read();
                let s_in_sig_r = decompress(&r33()).expect("bid: seller-in R");
                let s_in_sig_z = scalar_reduce_be(&r32());
                let s_has_change: u8 = io::read();
                let s_change = if s_has_change == 1 {
                    let (cx, cy, pt) = r_commitment();
                    let sr = decompress(&r33()).expect("bid: seller-change R");
                    let sz = scalar_reduce_be(&r32());
                    Some((cx, cy, pt, sr, sz))
                } else { None };
                // Seller received (asset_b, value pay = chosen_f·price).
                let (s_rv_cx, s_rv_cy, s_rv_pt) = r_commitment();
                let s_rv_sig_r = decompress(&r33()).expect("bid: seller-recv R");
                let s_rv_sig_z = scalar_reduce_be(&r32());

                let s_change_amt: u64 = match s_change {
                    Some(_) => { assert!(s_in_amount > chosen_f, "bid: seller change requires input > fill"); s_in_amount - chosen_f }
                    None => { assert!(s_in_amount == chosen_f, "bid: seller exact input required without change"); 0 }
                };

                // Buyer context: PRE-SIGNED OFFLINE, so it binds only buyer-knowable data (the bid
                // terms + the buyer's funding/received notes + chosen_f) — never the seller's notes.
                let mut b_notes: Vec<([u8; 32], [u8; 32], [u8; 32])> =
                    vec![(fund_cx, fund_cy, buyer_owner), (ra_cx, ra_cy, buyer_owner)];
                if let Some((cx, cy, _, _, _)) = refund_note { b_notes.push((cx, cy, buyer_owner)); }
                let op_deadline: u64 = io::read(); // buyer's bid expiry, bound in their pre-signed sigma (per-op Expired)
                if op_deadline != 0 { min_deadline = if min_deadline == 0 { op_deadline } else { min_deadline.min(op_deadline) }; }
                let buyer_ctx = intent_context(
                    b"tacit-bid-buyer-v1", &chain_binding, &asset_a, &asset_b,
                    &b_notes, &[min_fill, max_fill, price, increment, chosen_f, op_deadline],
                );
                assert!(verify_opening_sigma(&fund_pt, v_fund, &fund_sig_r, &fund_sig_z, &buyer_ctx), "bid: funding opening");
                assert!(verify_opening_sigma(&ra_pt, chosen_f, &ra_sig_r, &ra_sig_z, &buyer_ctx), "bid: buyer-recv-a opening");
                if let Some((_, _, pt, sr, sz)) = refund_note { assert!(verify_opening_sigma(&pt, refund, &sr, &sz, &buyer_ctx), "bid: buyer-refund opening"); }

                // Seller context: the seller is online, so it binds the seller's notes + chosen_f.
                let mut s_notes: Vec<([u8; 32], [u8; 32], [u8; 32])> =
                    vec![(s_in_cx, s_in_cy, s_owner), (s_rv_cx, s_rv_cy, s_owner)];
                if let Some((cx, cy, _, _, _)) = s_change { s_notes.push((cx, cy, s_owner)); }
                let seller_ctx = intent_context(
                    b"tacit-bid-seller-v1", &chain_binding, &asset_a, &asset_b,
                    &s_notes, &[chosen_f, price],
                );
                assert!(verify_opening_sigma(&s_in_pt, s_in_amount, &s_in_sig_r, &s_in_sig_z, &seller_ctx), "bid: seller-in opening");
                assert!(verify_opening_sigma(&s_rv_pt, pay, &s_rv_sig_r, &s_rv_sig_z, &seller_ctx), "bid: seller-recv opening");
                if let Some((_, _, pt, sr, sz)) = s_change { assert!(verify_opening_sigma(&pt, s_change_amt, &sr, &sz, &seller_ctx), "bid: seller-change opening"); }

                // Per-asset conservation.
                assert!(v_fund as u128 == pay as u128 + refund as u128, "bid: asset_b conservation");
                assert!(s_in_amount as u128 == chosen_f as u128 + s_change_amt as u128, "bid: asset_a conservation");

                // Emit ν + leaves (fixed order; client + memos mirror it).
                nullifiers.push(fund_nu);
                nullifiers.push(s_nu);
                leaves.push(leaf(&asset_a, &ra_cx, &ra_cy, &buyer_owner)); // buyer receives asset_a (chosen_f)
                leaves.push(leaf(&asset_b, &s_rv_cx, &s_rv_cy, &s_owner)); // seller receives asset_b (pay)
                if let Some((cx, cy, _, _, _)) = refund_note { leaves.push(leaf(&asset_b, &cx, &cy, &buyer_owner)); } // buyer refund
                if let Some((cx, cy, _, _, _)) = s_change { leaves.push(leaf(&asset_a, &cx, &cy, &s_owner)); } // seller change
            }
            OP_SWAP_ROUTE => {
                // Confidential MULTIHOP: route one input note through up to MAX_ROUTE_HOPS pools to one
                // output note. Intermediate amounts flow as VALUES (only the route's start input + final
                // output are notes), so the path stays private and atomic in one proof. Each hop is a
                // constant-product exact-in swap (get_amount_out, fee-charged); each touched pool stages a
                // SwapSettlement the existing settle swap-loop applies (gate pre==live → set post), so the
                // route needs NO new contract surface. The trader is protected by the final min_out, the
                // LPs by each hop's constant-product non-decrease.
                let asset_0 = r32(); // the input asset (start of the route)
                let (in_cx, in_cy, in_pt) = r_commitment();
                let in_owner = r32();
                let in_leaf_index: u64 = io::read();
                let in_path = r_path();
                let amount_in: u64 = io::read();
                let in_sig_r = decompress(&r33()).expect("route: in sigma R");
                let in_sig_z = scalar_reduce_be(&r32());
                let n_hops: u32 = io::read();
                assert!(n_hops >= 1 && n_hops <= MAX_ROUTE_HOPS, "route: hop count out of range");
                let min_out: u64 = io::read();
                let (out_cx, out_cy, out_pt) = r_commitment();
                let out_owner = r32();
                let out_sig_r = decompress(&r33()).expect("route: out sigma R");
                let out_sig_z = scalar_reduce_be(&r32());
                let op_deadline: u64 = io::read(); // bound in the trader's sigma (per-op Expired)
                if op_deadline != 0 { min_deadline = if min_deadline == 0 { op_deadline } else { min_deadline.min(op_deadline) }; }

                // Walk the hops: compute each pool's exact-in output, thread it into the next hop, and stage
                // a SwapSettlement per hop. Per-hop reserves are witnessed (the prover supplies the live
                // pre); the contract's pre==live gate + sequential application force them to be the real,
                // chained reserves — so the route can't settle against stale or fabricated pool state.
                let mut cur_asset = asset_0;
                let mut cur_amount: u64 = amount_in;
                let mut hop_swaps: Vec<SwapSettlement> = Vec::with_capacity(n_hops as usize);
                for _ in 0..n_hops {
                    let asset_next = r32();
                    let fee_bps: u32 = io::read();
                    let reserve_a_pre: u64 = io::read(); // CANONICAL reserves (low asset = reserveA)
                    let reserve_b_pre: u64 = io::read();
                    assert!(cur_asset != asset_next, "route: hop maps an asset to itself");
                    let pid = pool_id(&cur_asset, &asset_next, fee_bps);
                    // Orientation: the pool stores reserveA for the canonical-low asset. cur_is_lo ⇒ the
                    // flow is low→high (input is reserveA, output reserveB); else high→low. pool_id sorts
                    // internally, so the pid is identical either way — only the in/out mapping flips.
                    let cur_is_lo = bitcoin::be_bytes_lte(&cur_asset, &asset_next);
                    let (r_in, r_out) = if cur_is_lo { (reserve_a_pre, reserve_b_pre) } else { (reserve_b_pre, reserve_a_pre) };
                    assert!(r_in > 0 && r_out > 0, "route: hop pool not initialized");
                    let out = get_amount_out(cur_amount, r_in, r_out, fee_bps);
                    assert!(out > 0, "route: hop output rounds to zero");
                    let r_out_post = r_out as u128 - out; // out < r_out by the formula → no underflow, reserve stays > 0
                    let r_in_post = r_in as u128 + cur_amount as u128;
                    assert!(r_in_post <= u64::MAX as u128, "route: hop reserve overflow");
                    // Constant-product non-decrease (LP protection): (R_in+in)·(R_out−out) ≥ R_in·R_out.
                    assert!(r_in_post * r_out_post >= r_in as u128 * r_out as u128, "route: constant-product decreased");
                    let (reserve_a_post, reserve_b_post) = if cur_is_lo { (r_in_post, r_out_post) } else { (r_out_post, r_in_post) };
                    hop_swaps.push(SwapSettlement {
                        poolId: pid.into(),
                        reserveAPre: U256::from(reserve_a_pre), reserveBPre: U256::from(reserve_b_pre),
                        reserveAPost: U256::from(reserve_a_post as u64), reserveBPost: U256::from(reserve_b_post as u64),
                    });
                    cur_asset = asset_next;
                    cur_amount = out as u64;
                }
                let amount_out = cur_amount;
                let asset_final = cur_asset;
                assert!(amount_out >= min_out, "route: min_out");

                // Bind the route ENDPOINTS + amounts to BOTH notes: the box can't redirect the output
                // (out_owner is in the context) or re-price (amount_in / amount_out are). The path's only
                // effect is amount_out — pinned here — so a re-route that changed the result would fail the
                // output opening or min_out; the trader gets exactly what they signed for, or the tx reverts.
                let ctx = intent_context(
                    b"tacit-route-intent-v1", &chain_binding, &asset_0, &asset_final,
                    &[(in_cx, in_cy, in_owner), (out_cx, out_cy, out_owner)],
                    &[amount_in, amount_out, min_out, n_hops as u64, op_deadline],
                );

                // Spend the input note (membership + ν + cross-lane + opening binds amount_in).
                let in_lf = leaf(&asset_0, &in_cx, &in_cy, &in_owner);
                assert!(spend_root != [0u8; 32], "route: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&in_lf, in_leaf_index, &in_path, &spend_root), "route: membership");
                let nu = nullifier(&in_cx, &in_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&nu, &bitcoin_spent_root); }
                assert!(verify_opening_sigma(&in_pt, amount_in, &in_sig_r, &in_sig_z, &ctx), "route: input opening");
                // The output note opens to the final amount_out (only the trader, who knows r_out, can spend it).
                assert!(verify_opening_sigma(&out_pt, amount_out, &out_sig_r, &out_sig_z, &ctx), "route: output opening");

                nullifiers.push(nu);
                leaves.push(leaf(&asset_final, &out_cx, &out_cy, &out_owner));
                for s in hop_swaps { swaps.push(s); }
            }
            OP_ADAPTOR_LOCK => {
                // Atomic-swap LOCK (the cBTC↔BTC / cross-chain leg): spend a normal note `N` and move its
                // FULL value into the lock-set as a locked note `L`, committing the adaptor point `T`, the
                // `deadline`, the `recipient` (who may claim before the deadline) and the `locker` (who may
                // refund after). `L` lives in the lock-set, NOT the note tree (domain-separated leaf), so no
                // OP_TRANSFER can touch it — only OP_ADAPTOR_CLAIM / OP_ADAPTOR_REFUND, deadline-exclusive.
                // Value is prover-visible (bound by openings, kept out of PublicValues); N and L open to the
                // SAME `amount`, so the lock conserves value (no change, no inflation — split first to lock less).
                let asset = r32();
                let locker = r32();    // == N's owner (authorizes the spend by opening N)
                let recipient = r32(); // the eventual claimer bound into the lock leaf
                let amount: u64 = io::read();
                assert!(amount > 0, "adaptor-lock: zero amount");
                // Adaptor point T (affine x,y) — must be a real curve point; bound into the lock leaf + context.
                let tx = r32();
                let ty = r32();
                from_affine_xy(&tx, &ty).expect("adaptor-lock: T not on curve");
                let deadline: u64 = io::read();
                assert!(deadline != 0, "adaptor-lock: deadline required");

                // Spent note N (asset, owned by locker): membership + ν + cross-lane gate.
                let (n_cx, n_cy, n_pt) = r_commitment();
                let n_index: u64 = io::read();
                let n_path = r_path();
                let n_lf = leaf(&asset, &n_cx, &n_cy, &locker);
                assert!(spend_root != [0u8; 32], "adaptor-lock: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&n_lf, n_index, &n_path, &spend_root), "adaptor-lock: N membership");
                let n_nu = nullifier(&n_cx, &n_cy);
                if bitcoin_spent_root != [0u8; 32] { check_btc_nonmembership(&n_nu, &bitcoin_spent_root); }
                let n_sig_r = decompress(&r33()).expect("adaptor-lock: N-open R");
                let n_sig_z = scalar_reduce_be(&r32());
                // Locked note L (same asset, same value).
                let (l_cx, l_cy, l_pt) = r_commitment();
                let l_sig_r = decompress(&r33()).expect("adaptor-lock: L-open R");
                let l_sig_z = scalar_reduce_be(&r32());

                // Context binds the whole lock: N (locker), L (recipient), T, amount, deadline — so a relayer
                // can neither re-target the lock to a different recipient/T nor re-price it (the openings fail).
                if deadline != 0 { min_deadline = if min_deadline == 0 { deadline } else { min_deadline.min(deadline) }; }
                let ctx = intent_context(
                    b"tacit-adaptor-lock-intent-v1", &chain_binding, &asset, &asset,
                    &[(n_cx, n_cy, locker), (l_cx, l_cy, recipient), (tx, ty, [0u8; 32])],
                    &[amount, deadline],
                );
                assert!(verify_opening_sigma(&n_pt, amount, &n_sig_r, &n_sig_z, &ctx), "adaptor-lock: N opening (spend authz + value)");
                assert!(verify_opening_sigma(&l_pt, amount, &l_sig_r, &l_sig_z, &ctx), "adaptor-lock: L opening (value carry)");

                // Effect: spend N; append L to the lock-set.
                nullifiers.push(n_nu);
                lock_leaves.push(adaptor_lock_leaf(&l_cx, &l_cy, &tx, &ty, deadline, &recipient, &locker));
            }
            OP_ADAPTOR_CLAIM => {
                // CLAIM a locked note before its deadline: prove `L` ∈ the lock-set (reconstructing its leaf
                // pins recipient/T/deadline/locker), spend ν_L once, and emit the recipient's output note with
                // value conserved by the ADAPTOR-COMPLETED kernel over (L_C − out_C). Committing that kernel's
                // `s` is the t-reveal channel: the Bitcoin counterparty holding s̃ extracts t = σ·(s − s̃).
                // The contract enforces block.timestamp <= deadline via the shared `deadline` (≤) gate.
                let asset = r32();
                let (l_cx, l_cy, l_pt) = r_commitment(); // the locked note
                let tx = r32();
                let ty = r32();
                let deadline: u64 = io::read();
                let recipient = r32();
                let locker = r32();
                let l_index: u64 = io::read();
                let l_path = r_path();
                // Lock-set membership reconstructs the EXACT leaf — so recipient/T/deadline/locker are pinned
                // (a relayer can't change them without breaking membership).
                let lock_lf = adaptor_lock_leaf(&l_cx, &l_cy, &tx, &ty, deadline, &recipient, &locker);
                assert!(lock_set_root != [0u8; 32], "adaptor-claim: membership requires a non-zero lock-set root");
                assert!(keccak_merkle_verify(&lock_lf, l_index, &l_path, &lock_set_root), "adaptor-claim: L lock-set membership");
                let l_nu = nullifier(&l_cx, &l_cy);

                // Output note → recipient (owner pinned by the membership-verified lock leaf; no redirect).
                let (o_cx, o_cy, o_pt) = r_commitment();
                // Adaptor-completed kernel over (L_C − out_C): a valid kernel ⇒ out conserves L's value without
                // revealing it. `kernel_z` IS the completed signature `s` (committed for the t-reveal).
                let kernel_r = decompress(&r33()).expect("adaptor-claim: kernel R");
                let kernel_s = r32();
                let kernel_z = scalar_reduce_be(&kernel_s);
                assert!(verify_kernel(&[l_pt], &[o_pt], &kernel_r, &kernel_z), "adaptor-claim: value conservation");

                // Claim window: bind the lock's deadline into the ≤ gate (settle must land before it).
                if deadline != 0 { min_deadline = if min_deadline == 0 { deadline } else { min_deadline.min(deadline) }; }

                lock_nullifiers.push(l_nu);
                leaves.push(leaf(&asset, &o_cx, &o_cy, &recipient));
                adaptor_claim_s.push(kernel_s);
            }
            OP_ADAPTOR_REFUND => {
                // REFUND a locked note after its deadline: same membership + ν_L spend-once + kernel value
                // carry as CLAIM, but the output goes to the LOCKER and NO `s` is revealed (no swap completed).
                // The contract enforces block.timestamp >= deadline via the new `refundNotBefore` (≥) gate.
                let asset = r32();
                let (l_cx, l_cy, l_pt) = r_commitment();
                let tx = r32();
                let ty = r32();
                let deadline: u64 = io::read();
                let recipient = r32();
                let locker = r32();
                let l_index: u64 = io::read();
                let l_path = r_path();
                let lock_lf = adaptor_lock_leaf(&l_cx, &l_cy, &tx, &ty, deadline, &recipient, &locker);
                assert!(lock_set_root != [0u8; 32], "adaptor-refund: membership requires a non-zero lock-set root");
                assert!(keccak_merkle_verify(&lock_lf, l_index, &l_path, &lock_set_root), "adaptor-refund: L lock-set membership");
                let l_nu = nullifier(&l_cx, &l_cy);

                let (o_cx, o_cy, o_pt) = r_commitment();
                let kernel_r = decompress(&r33()).expect("adaptor-refund: kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(verify_kernel(&[l_pt], &[o_pt], &kernel_r, &kernel_z), "adaptor-refund: value conservation");

                // Refund window: the contract requires block.timestamp >= the LATEST refund deadline in the batch.
                assert!(deadline != 0, "adaptor-refund: deadline required");
                refund_not_before = refund_not_before.max(deadline);

                lock_nullifiers.push(l_nu);
                leaves.push(leaf(&asset, &o_cx, &o_cy, &locker));
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
        deadline: min_deadline,
        lockSetRoot: lock_set_root.into(),
        lockLeaves: lock_leaves.into_iter().map(Into::into).collect(),
        lockNullifiers: lock_nullifiers.into_iter().map(Into::into).collect(),
        adaptorClaimS: adaptor_claim_s.into_iter().map(Into::into).collect(),
        refundNotBefore: refund_not_before,
    };
    io::commit_slice(&pv.abi_encode());
}
