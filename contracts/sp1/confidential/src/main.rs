#![cfg_attr(not(test), no_main)]
//! Confidential-pool guest (Phase 1). Validates a batch of confidential ops and
//! commits the ABI-encoded `PublicValues` that `ConfidentialPool.settle` decodes.
//! All secp/keccak verification is delegated to `cxfer-core` (native-tested
//! against the JS prover); this guest is the thin assembler that reads the
//! witness, calls the verified checks, and emits the public boundary effects.
//!
//! Op witness layout (host writes in this order; see dapp prover):
//!   header:  chainBinding[32], spendRoot[32], bitcoinSpentRoot[32], bitcoinBurnRoot[32],
//!            lockSetRoot[32], cdpPositionRoot[32], numOps u32
//!   per op:  opType u8, then op-specific fields below.

#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::private::{Address, U256};
use alloy_sol_types::{sol, SolValue};
use cxfer_core::{
    adaptor_lock_leaf, bip340_verify, bitcoin, cdp_basket_leg, cdp_basket_root, cdp_close_msg,
    cdp_debt_asset_id,
    cdp_position_leaf, cdp_position_nullifier, claim_id, clearing_price_matches, commitment_hash,
    decompress, deposit_commit, deposit_id, evm_lp_harvest_owner_msg, evm_lp_unbond_owner_msg,
    farm_harvest_new_entry, farm_receipt_leaf,
    farm_receipt_nullifier, from_affine_xy, get_amount_out, imt_non_membership, intent_context,
    isqrt, keccak_merkle_verify, leaf, lp_add_shares, lp_share_id, nullifier, pool_id,
    pool_id_with_protocol_fee, protocol_fee_cut,
    scalar_reduce_be, stealth_claim_msg, stealth_lock_leaf, utxo_leaf, verify_kernel,
    verify_kernel_with_fee, verify_kernel_with_fee_bound, verify_opening_sigma, verify_range, Point, CBTC_ZK_ASSET_ID,
};
use sp1_zkvm::io;

const PV_VERSION: u16 = 1;
const OP_WRAP: u8 = 0;
const OP_TRANSFER: u8 = 1;
const OP_UNWRAP: u8 = 2;
const OP_BRIDGE_BURN: u8 = 3; // Ethereum note → Bitcoin (emit crossOut)
const OP_BRIDGE_MINT: u8 = 4; // Bitcoin burn → Ethereum note (verify Bitcoin burn)

// Opcode 5 — RESERVED for the Bitcoin-covenant era (was OP_ATTEST_META; metadata is now reflection-attested).
// Held for OP_COVENANT_MINT: a trustless, escrow-FREE cBTC mint against a COVENANT-enforced Bitcoin lock
// (CTV/CCV/CSFS), once those activate. The settle guest needs NO new verification for it — covenant-cBTC
// reuses OP_CBTC_MINT's exact opening-sigma value-binding; the only difference is the CONTRACT gate, which
// lives in the mutable layer (`covenantLock[outpoint]` — the covenant's spend-restriction proof verified
// on-chain — in place of `cbtcLock[outpoint]`'s slashable-escrow gate). So the immutable core is ALREADY
// covenant-ready: when covenants ship, the reflection layer records covenant locks and the upgradeable
// CollateralEngine gates them, dropping in escrow-free trustless cBTC (no keeper, no basis-risk window) WITH
// NO guest change. This slot is held — rather than filled with a guessed CTV-template verifier against an
// unactivated spec — so a future guest generation can claim it against the FINAL covenant primitive if one
// ever truly needs in-circuit logic (a mechanical re-prove). Do not renumber the ops below.
#[allow(dead_code)]
const OP_COVENANT_MINT: u8 = 5; // reserved (no handler yet ⇒ op 5 is rejected as unknown until a future gen claims it)
const OP_SWAP: u8 = 6; // confidential AMM batch: hidden-amount swaps against public pool reserves
const OP_LP_ADD: u8 = 7; // confidential LP: add liquidity in-ratio, mint a shielded LP-share note
const OP_LP_REMOVE: u8 = 8; // confidential LP: burn a shielded LP-share note, withdraw the underlying
const OP_OTC: u8 = 9; // confidential OTC: 2-party direct swap of shielded notes (no pool)
const OP_BID: u8 = 10; // confidential partial-fill bid: buyer-offline limit order, seller fills a grid amount
const OP_SWAP_ROUTE: u8 = 11; // confidential multihop: route one input note through ≤ MAX_ROUTE_HOPS pools
const MAX_ROUTE_HOPS: u32 = 4; // bound the per-route hop count (mirrors the Bitcoin route op)
const MAX_OPS: u32 = 256; // bound the per-batch op count — predictable proving memory; far above any real batch
const MAX_ITEMS_PER_OP: u32 = 256; // nested inputs/outputs/intents/legs; prevents one op bypassing MAX_OPS
const OP_ADAPTOR_LOCK: u8 = 12; // adaptor swap: lock a note into the lock-set under (T, deadline, recipient)
const OP_ADAPTOR_CLAIM: u8 = 13; // adaptor swap: claim a locked note before its deadline, revealing the kernel s
const OP_ADAPTOR_REFUND: u8 = 14; // adaptor swap: refund a locked note to its locker after the deadline
                                  // Generic confidential CDP (ops/DESIGN-confidential-defi-v1.md §4): lock a basket of collateral notes into
                                  // a controller-bound position + mint a controller-derived debt asset. The guest enforces structure +
                                  // conservation only; the contract calls the MUTABLE controller (onCdpMint/Close/Liquidate/Topup) for all
                                  // pricing /ratio policy. cUSD-on-cBTC is the first instance (single-leg cBTC basket).
const OP_CDP_MINT: u8 = 15; // open: lock collateral basket → mint debt note (controller authorizes the amount)
const OP_CDP_CLOSE: u8 = 16; // close: burn the exact debt → reclaim the collateral basket (no oracle/veto)
const OP_CDP_LIQUIDATE: u8 = 17; // liquidate: burn exact debt, then seize basket (controller proves unhealthy)
const OP_CBTC_MINT: u8 = 18; // mint cBTC against a reflection-recorded self-custody lock (contract gates lock + escrow)
const OP_CDP_TOPUP: u8 = 19; // top-up: consume old position + append replacement with larger collateral basket

// Fair farms (SPEC-CONTROLLER-VAULT-AMENDMENT §4) — the per-stake reward-per-share receipt, byte-identical to
// the Bitcoin reflection (`farm_receipt_leaf` in the note tree, nullified via the spent set). bond/harvest/
// unbond ride a positionLeaf == 1 sentinel CdpMint (debtValue discriminates bond=0 / harvest>0) + a CdpClose,
// so the FROZEN pool needs no change — the receipt is a note in `pv.leaves`, its nullifier in `pv.nullifiers`.
const OP_FARM_BOND: u8 = 20; // lock LP-share notes → mint a receipt note (shares, rps_entry); controller checks rps_entry == rps_live
const OP_FARM_HARVEST: u8 = 21; // prove receipt → bound reward, nullify old + append advanced receipt + reward note
const OP_FARM_UNBOND: u8 = 22; // prove receipt → nullify, re-mint the LP-share notes, controller drops the shares
const OP_STEALTH_LOCK: u8 = 23; // stealth-receive: lock a note under the recipient's one-time pubkey (shared lock-set)
const OP_STEALTH_CLAIM: u8 = 24; // stealth-receive: recipient claims via a BIP-340 sig under that one-time pubkey
const OP_STEALTH_REFUND: u8 = 25; // stealth-receive: locker reclaims an unclaimed lock after the deadline (kernel-gated)
const OP_BRIDGE_STEALTH_MINT: u8 = 26; // Bitcoin burn → Ethereum STEALTH LOCK: mint a Bitcoin-burned note's value into the shared lock-set under the recipient's one-time pubkey (cross-chain confidential pay); claimed via OP_STEALTH_CLAIM
const OP_WRAP_TRANSFER: u8 = 27; // atomic wrap-and-send: consume a pending public deposit and emit HIDDEN recipient (+ change) notes in one settle — OP_WRAP fused with OP_TRANSFER's conservation (used by router.wrapAndSettle for a one-tx private send)
const OP_SEND_AND_UNWRAP: u8 = 28; // partial public exit: spend ONE hidden note → public withdrawal(payout) to an EVM recipient + HIDDEN change note(s), one settle. The note value stays private (only `payout` is public); OP_UNWRAP's opening-sigma binds recipient+payout+fee+deadline (anti-relay-redirect). fee = 0 ⇒ self-settle.
const OP_LP_BOND: u8 = 29; // 1-click farm entry: add liquidity AND bond the resulting shares into a farm in one settle — OP_LP_ADD fused with OP_FARM_BOND. The LP-share note never materializes; the derived shares flow straight into a farm_receipt_leaf + bond CdpMint. (swap-and-send needs NO op — OP_SWAP already mints to an arbitrary out_owner.)
const OP_WRAP_CDP_MINT: u8 = 30; // 1-click cUSD: consume pending PUBLIC deposit(s) as the collateral basket and mint a confidential CDP debt note (cUSD) in one settle — OP_CDP_MINT with deposit-collateral instead of tree notes (used by router.wrapAndMintCusd). The debt-mint/position/CdpMint are identical to OP_CDP_MINT.
// Opcode map: 0–30 assigned (5 was OP_ATTEST_META, retired — reuse for the next non-fusion op). swap-and-send +
// non-interactive stealth claim need NO op (dapp wiring on existing ops). 31–255 free for a future guest.

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
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    // Generic CDP (ops/DESIGN-confidential-defi-v1.md §4). A leg = one basket collateral (asset, public value).
    struct CdpLeg { bytes32 asset; uint256 value; }
    // OP_CDP_MINT: the contract appends `positionLeaf` to its position set + calls
    // controller.onCdpMint(legs, debtValue); it MUST check debtAsset == cdp_debt_asset_id(controller).
    // `rateSnapshot` = the controller debt accumulator captured at mint (the leaf commits it); `repaid` =
    // cUSD burned at close (== the accrued debt the controller enforces). The guest carries these verbatim —
    // all fee math is the controller's. Dormant (rate == RAY): rateSnapshot == rate so repaid == debtValue.
    // `owner` is PUBLISHED (the position leaf's preimage, with nonce fixed at 0) so a keeper can reconstruct
    // the leaf and liquidate permissionlessly against the live oracle. It is a FRESH per-position value
    // (unlinkable to the borrower's other notes; EVM notes are bearer, so it is leaf-binding only, never a
    // spend key) — publishing it doxxes nothing while making the position liquidatable. The fresh owner alone
    // gives the leaf its uniqueness, so the position nonce is fixed at 0 and needs no separate field.
    struct CdpMint { address controller; bytes32 debtAsset; uint256 debtValue; bytes32 positionLeaf; uint256 rateSnapshot; CdpLeg[] legs; bytes32 owner; }
    // OP_CDP_CLOSE: the contract dedups `positionNullifier` + calls controller.onCdpClose(debtValue, repaid, ...).
    struct CdpClose { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    // OP_CDP_LIQUIDATE: burn debt notes summing to the accrued debt, then the contract dedups
    // `positionNullifier` + calls controller.onCdpLiquidate (reverts if healthy); seized legs ride `withdrawals`.
    struct CdpLiquidate { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    // OP_CDP_TOPUP: consume an existing position and append a same-debt replacement with a larger basket.
    // The controller authorizes the replacement health; outstanding debt is unchanged. The snapshot carries
    // forward unchanged (accrual is uninterrupted). Both nonces are pinned to 0 (like the mint) so the
    // replacement leaf is keeper-reconstructable from the public legs + the mint-published owner (recoverable
    // via this op's oldPositionNullifier → the originating mint), keeping every position liquidatable.
    struct CdpTopup {
        address controller;
        uint256 debtValue;
        uint256 rateSnapshot;
        bytes32 oldPositionNullifier;
        bytes32 newPositionLeaf;
        CdpLeg[] oldLegs;
        CdpLeg[] newLegs;
    }
    // OP_CBTC_MINT (ops/DESIGN-confidential-defi-v1.md §3.2): mint cBTC against a reflection-recorded
    // self-custody lock. The guest verified the note opens to EXACTLY `vBtc` (the conservation peg); the
    // contract checks cbtcLock[outpoint].vBtc == vBtc + commitment match + !cbtcMinted + the CollateralEngine
    // escrow, then inserts the cBTC leaf (which rides `leaves`). bridge_mint-shaped.
    struct CbtcMint { bytes32 outpoint; uint256 vBtc; bytes32 commitment; }
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
        SwapSettlement[] swaps;
        LpSettlement[] liquidity;
        uint64 deadline; // settle expiry (unix secs); 0 = none. The box can't relay a stale proof past it (Expired)
        // ── adaptor-swap (ops 12–14): the cross-chain atomic-swap lock-set ──────────────────────────
        bytes32 lockSetRoot; // INPUT: the lock-set root claim/refund membership is proven against (contract checks == stored)
        bytes32[] lockLeaves; // adaptor_lock_leaf values appended to the lock-set by OP_ADAPTOR_LOCK
        bytes32[] lockNullifiers; // ν_L consumed by claim/refund → the lock-spent set (spend-once, contract dedups)
        bytes32[] adaptorClaimS; // the completed kernel `s` per claim — the t-reveal channel the Bitcoin counterparty reads
        uint64 refundNotBefore; // contract gate: block.timestamp >= this for the batch (max refund deadline; 0 = no refunds)
        // ── generic CDP (ops 15–17, 19) ────────────────────────────────────────────────────────────────
        bytes32 cdpPositionRoot; // INPUT: position-set root CLOSE/LIQUIDATE/TOPUP prove membership against
        CdpMint[] cdpMints;          // open: append positionLeaf to the position set + controller.onCdpMint authorizes
        CdpClose[] cdpCloses;        // close: dedup positionNullifier + controller.onCdpClose accounting
        CdpLiquidate[] cdpLiquidations; // liquidate: dedup positionNullifier + controller.onCdpLiquidate (reverts if healthy)
        CdpTopup[] cdpTopups;        // top-up: consume old position + append replacement with larger basket
        CbtcMint[] cbtcMints;        // cBTC mint: contract gates on the recorded lock + the native-ETH escrow
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] {
    r_n::<32>()
}
fn r33() -> [u8; 33] {
    r_n::<33>()
}
fn r20() -> [u8; 20] {
    r_n::<20>()
}

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

fn merge_cdp_legs(old: &[([u8; 32], u64)], added: &[([u8; 32], u64)]) -> Vec<([u8; 32], u64)> {
    let mut out: Vec<([u8; 32], u64)> = Vec::with_capacity(old.len() + added.len());
    let mut i = 0usize;
    let mut j = 0usize;
    while i < old.len() || j < added.len() {
        if j == added.len() || (i < old.len() && old[i].0 < added[j].0) {
            out.push(old[i]);
            i += 1;
        } else if i == old.len() || added[j].0 < old[i].0 {
            out.push(added[j]);
            j += 1;
        } else {
            let sum = old[i].1 as u128 + added[j].1 as u128;
            assert!(
                sum <= u64::MAX as u128,
                "cdp-topup: collateral leg overflow"
            );
            out.push((old[i].0, sum as u64));
            i += 1;
            j += 1;
        }
    }
    out
}

/// Cross-lane gate (cross-lane): assert `nu` is absent from the reflected
/// Bitcoin spent set committed by `root`, reading the IMT non-membership witness
/// (low leaf value/next/index/path). Called only when the root is non-zero.
fn check_btc_nonmembership(nu: &[u8; 32], root: &[u8; 32]) {
    let low_value = r32();
    let low_next = r32();
    let low_index: u64 = io::read();
    let low_path = r_path();
    assert!(
        imt_non_membership(root, nu, &low_value, &low_next, low_index, &low_path),
        "cross-lane: nu spent on Bitcoin"
    );
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
    // CDP: the position-set root CLOSE/LIQUIDATE prove membership against (0 = no position set yet / no
    // close/liquidate this batch). The contract checks it == its stored CDP position root before advancing.
    let cdp_position_root = r32();
    let num_ops: u32 = io::read();
    assert!(num_ops <= MAX_OPS, "batch op count over MAX_OPS");

    let mut nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut leaves: Vec<[u8; 32]> = Vec::new();
    let mut deposits: Vec<[u8; 32]> = Vec::new();
    let mut withdrawals: Vec<Withdrawal> = Vec::new();
    let mut fees: Vec<FeePayment> = Vec::new(); // OP_UNWRAP relayer fee (gasless exit)
    let mut bitcoin_burns: Vec<[u8; 32]> = Vec::new(); // OP_BRIDGE_MINT burned-note nullifiers
    let mut bitcoin_roots: Vec<[u8; 32]> = Vec::new(); // Bitcoin pool roots minted against
    let mut cross_outs: Vec<CrossOut> = Vec::new();
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
    // CDP accumulators (ops 15–17): per-op records the contract reads to call the mutable controller +
    // advance/dedup its position set. The note effects (collateral ν, debt note leaf, released-collateral
    // leaves, seized-collateral withdrawals) ride the shared nullifiers/leaves/withdrawals arrays.
    let mut cdp_mints: Vec<CdpMint> = Vec::new();
    let mut cdp_closes: Vec<CdpClose> = Vec::new();
    let mut cdp_liquidations: Vec<CdpLiquidate> = Vec::new();
    let mut cdp_topups: Vec<CdpTopup> = Vec::new();
    let mut cbtc_mints: Vec<CbtcMint> = Vec::new();

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
                let sig_r = decompress(&r33()).expect("wrap: sigma R");
                let sig_z = scalar_reduce_be(&r32());
                let dep_id =
                    deposit_id(&asset, &u64_be32(value), &deposit_commit(&cx, &cy, &owner));
                let ctx = intent_context(
                    b"tacit-wrap-intent-v1",
                    &chain_binding,
                    &asset,
                    &dep_id,
                    &[(cx, cy, owner)],
                    &[value],
                );
                assert!(
                    verify_opening_sigma(&c, value, &sig_r, &sig_z, &ctx),
                    "wrap opening sigma"
                );
                leaves.push(leaf(&asset, &cx, &cy, &owner));
                // The contract's wrap binds depositId over keccak(Cx‖Cy‖owner), never the raw coords;
                // reproduce that digest here so the ids match (the value binding is unchanged).
                deposits.push(dep_id);
            }
            OP_TRANSFER => {
                // n-in / m-out, hidden amounts: membership + range + conservation.
                let asset = r32();
                let n_in: u32 = io::read();
                let m_out: u32 = io::read();
                assert!(
                    n_in > 0 && m_out > 0,
                    "transfer: empty in/out (no-op settlement)"
                );
                assert!(
                    n_in <= MAX_ITEMS_PER_OP && m_out <= MAX_ITEMS_PER_OP,
                    "transfer: item count over cap"
                );

                let mut in_pts: Vec<Point> = Vec::with_capacity(n_in as usize);
                for _ in 0..n_in {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    let leaf_index: u64 = io::read();
                    let path = r_path();
                    let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(
                        spend_root != [0u8; 32],
                        "membership requires a non-zero spend root"
                    );
                    assert!(
                        keccak_merkle_verify(&lf, leaf_index, &path, &spend_root),
                        "membership"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    nullifiers.push(nu);
                    in_pts.push(p);
                }

                let mut out_pts: Vec<Point> = Vec::with_capacity(m_out as usize);
                let mut out_leaves: Vec<[u8; 32]> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    leaves.push(lf);
                    out_leaves.push(lf);
                    out_pts.push(p);
                }

                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&out_pts, &bp_proof), "range");

                // Relay fee (gasless privacy): a public FeePayment of `fee` in the transfer asset, paid
                // to the settler (msg.sender). Conservation becomes Σin = Σout + fee, so the kernel checks
                // the excess after removing fee·H — a relay can't pad it (that leaves an H-term the Schnorr
                // fails). fee = 0 ⇒ byte-identical to the fee-free transfer. The kernel also binds the output
                // LEAVES so a delegated prover can't mutate an output `owner` into an unspendable leaf.
                let fee: u64 = io::read();
                let kernel_r = decompress(&r33()).expect("kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee_bound(&in_pts, &out_pts, fee, &out_leaves, &kernel_r, &kernel_z),
                    "conservation"
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
            }
            OP_WRAP_TRANSFER => {
                // Atomic wrap-and-send: consume a pending PUBLIC deposit (same opening-sigma binding as
                // OP_WRAP — only the depositor, who knows the blinding r, can spend it) and emit HIDDEN
                // recipient (+ change) notes under the transfer conservation kernel — in one settle. The
                // deposit's value is public (= escrowed_amount/unitScale, bound in deposit_id), so the wrap
                // boundary leaks the amount exactly as a plain wrap does; WHO receives it and the split stay
                // hidden. Unlike OP_WRAP, the deposit is NOT emitted as a self-note leaf: it is spent into
                // the outputs. The contract marks the deposit consumed (pv.deposits) and inserts the output
                // leaves, identical to how it already handles OP_WRAP + OP_TRANSFER.
                let asset = r32();
                let value: u64 = io::read(); // public in-system value of the consumed deposit
                let (dcx, dcy, dc) = r_commitment();
                let downer = r32();
                let sig_r = decompress(&r33()).expect("wraptransfer: sigma R");
                let sig_z = scalar_reduce_be(&r32());
                let dep_id =
                    deposit_id(&asset, &u64_be32(value), &deposit_commit(&dcx, &dcy, &downer));
                let ctx = intent_context(
                    b"tacit-wrap-intent-v1",
                    &chain_binding,
                    &asset,
                    &dep_id,
                    &[(dcx, dcy, downer)],
                    &[value],
                );
                assert!(
                    verify_opening_sigma(&dc, value, &sig_r, &sig_z, &ctx),
                    "wraptransfer opening sigma"
                );
                deposits.push(dep_id);

                let m_out: u32 = io::read();
                assert!(
                    m_out > 0 && m_out <= MAX_ITEMS_PER_OP,
                    "wraptransfer: out count 0 or over cap"
                );
                let mut out_pts: Vec<Point> = Vec::with_capacity(m_out as usize);
                let mut out_leaves: Vec<[u8; 32]> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    leaves.push(lf);
                    out_leaves.push(lf);
                    out_pts.push(p);
                }
                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&out_pts, &bp_proof), "wraptransfer range");

                // Single input = the deposit commitment (public value). Σin = Σout + fee, same kernel as
                // OP_TRANSFER. The router path is fee-free (user-sent), but a relayed fee is supported here
                // for symmetry; the contract's router gate rejects non-zero fees on a router settle. The kernel
                // binds the output LEAVES so a delegated prover can't mutate an output `owner` (fund-lock).
                let fee: u64 = io::read();
                let kernel_r = decompress(&r33()).expect("wraptransfer kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee_bound(&[dc], &out_pts, fee, &out_leaves, &kernel_r, &kernel_z),
                    "wraptransfer conservation"
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
            }
            OP_BRIDGE_BURN => {
                // Ethereum → Bitcoin: like a transfer, but outputs are destination
                // notes MINTED ON BITCOIN — emitted as crossOut records, not leaves.
                // Conservation crosses the boundary: Σ value_in (burned) = Σ value_out
                // (minted on Bitcoin). Every claimId binds to the first input's ν.
                let asset = r32();
                let dest_chain = io::read::<u32>() as u16;
                // Only Bitcoin (1) cross-outs are redeemable today: the reflection folds dest_chain==1
                // (fold_crossout is Bitcoin-only) and the eth-reflection consumer rejects non-Bitcoin dests.
                // An Ethereum re-home (dest_chain==2) has no consumer yet, so accepting it would let a user
                // burn into a record nobody redeems (value sink). Re-enable 2 here once the Eth re-home
                // consumer ships. Reject any unsupported destination outright.
                assert!(dest_chain == 1, "bridge-burn: unsupported dest chain");
                let n_in: u32 = io::read();
                let m_out: u32 = io::read();
                assert!(
                    n_in > 0 && m_out > 0 && n_in <= MAX_ITEMS_PER_OP && m_out <= MAX_ITEMS_PER_OP,
                    "bridge-burn: item count out of range"
                );

                let mut in_pts: Vec<Point> = Vec::with_capacity(n_in as usize);
                let mut bind: Option<[u8; 32]> = None;
                for _ in 0..n_in {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    let leaf_index: u64 = io::read();
                    let path = r_path();
                    let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(
                        spend_root != [0u8; 32],
                        "membership requires a non-zero spend root"
                    );
                    assert!(
                        keccak_merkle_verify(&lf, leaf_index, &path, &spend_root),
                        "membership"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    if bind.is_none() {
                        bind = Some(nu);
                    }
                    nullifiers.push(nu);
                    in_pts.push(p);
                }
                let bind = bind.expect("bridge-burn needs >= 1 input");

                let mut out_pts: Vec<Point> = Vec::with_capacity(m_out as usize);
                let mut dest_commitments: Vec<[u8; 32]> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let (cx, cy, p) = r_commitment();
                    let owner = r32();
                    // A Bitcoin-homed pool note is owner-free (ZERO_OWNER bearer; the blinding is the key)
                    // and the reflection's fold_crossout mints leaf(asset,cx,cy,ZERO_OWNER). Force ZERO_OWNER
                    // for the Bitcoin dest leaf so a non-zero witness owner can never record an UNFOLDABLE
                    // destCommitment — that would burn the Ethereum note into a Bitcoin note no reflection can
                    // mint (self-inflicted fund loss). owner is still read to keep the witness stream in sync;
                    // it is vestigial for a Bitcoin destination (dest_chain == 1).
                    let dest_owner = if dest_chain == 1 { [0u8; 32] } else { owner };
                    dest_commitments.push(leaf(&asset, &cx, &cy, &dest_owner)); // Bitcoin-side leaf
                    out_pts.push(p);
                }

                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&out_pts, &bp_proof), "range");
                // Relay fee (gasless privacy): a public FeePayment of `fee` in the burned asset, paid to
                // the settler (msg.sender) on Ethereum. Conservation crosses the boundary net of the fee:
                // Σ value_in (ETH burned) = Σ value_out (BTC minted) + fee. fee = 0 ⇒ the fee-free burn.
                let fee: u64 = io::read();
                let kernel_r = decompress(&r33()).expect("kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee(&in_pts, &out_pts, fee, &kernel_r, &kernel_z),
                    "conservation"
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }

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
                assert!(
                    keccak_merkle_verify(&in_leaf, in_leaf_index, &in_path, &pool_root),
                    "bridge_mint: btc pool membership"
                );
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
                assert!(
                    bitcoin_burn_root != [0u8; 32],
                    "bridge_mint: burn root required"
                );
                let bm_next = r32();
                let bm_index: u64 = io::read();
                let bm_path = r_path();
                let bm_leaf = utxo_leaf(&nu, &bm_next, &dest_leaf);
                assert!(
                    keccak_merkle_verify(&bm_leaf, bm_index, &bm_path, &bitcoin_burn_root),
                    "bridge_mint: nu not in Bitcoin bridge-burn set, or wrong destination"
                );

                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&[out_pt], &bp_proof), "bridge_mint: range");
                // Relay fee (gasless cross-chain mint): a keeper settles the Bitcoin→Ethereum mint for a
                // burner with no ETH gas. The dest note (pinned in the burn set) opens to v_burn − fee and the
                // settler is paid `fee`; conservation v_burn == v_out + fee forces fee = v_burn − v_out (both
                // pinned — the burn-set dest_leaf fixes v_out, the kernel fixes v_burn), so a relay can't pad
                // it. fee = 0 ⇒ self-mint (v_out == v_burn), byte-identical to the original verify_kernel.
                let fee: u64 = io::read();
                let kernel_r = decompress(&r33()).expect("bridge_mint: R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee(&[in_pt], &[out_pt], fee, &kernel_r, &kernel_z),
                    "bridge_mint: conservation"
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }

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
            OP_BRIDGE_STEALTH_MINT => {
                // Bitcoin → Ethereum, confidential PAY-TO-STEALTH. Like OP_BRIDGE_MINT, but the burned note's
                // value is minted into the SHARED stealth lock-set under the recipient's one-time pubkey
                // (owner_pub) instead of a plain note — so the SENDER cannot spend it: only the recipient's
                // BIP-340 claim (OP_STEALTH_CLAIM) can, and the sender (locker) can only refund after the
                // deadline (OP_STEALTH_REFUND). The Bitcoin burn declared dest_leaf = stealth_lock_leaf(…) as
                // its (opaque 32-byte) destCommitment, so the SAME bridge-burn set (ν → destCommitment) pins it
                // — no Bitcoin-side or reflection change. Conservation has two binds: the kernel proves
                // v_in == v_L (the burned note's value; it needs that note's blinding, so only the burner can
                // mint — no third party redirects the burn), and the opening sigma proves L opens to the
                // cleartext `amount`. Together amount == v_in: the lock's claimable amount equals exactly the
                // value burned on Bitcoin, so the claim mints no more than was burned (no inflation past the
                // existing bridge_mint guard). One-mint-per-ν via bitcoin_burns + the contract's bridgeMinted.
                let asset = r32();
                // The Bitcoin confidential-pool root the burned note is a member of (gated ∈ knownBitcoinRoot
                // on-chain — canonical + relay-confirmed, not forgeable).
                let pool_root = r32();

                // Burned input note: membership in the Bitcoin pool.
                let (in_cx, in_cy, in_pt) = r_commitment();
                let in_owner = r32();
                let in_leaf_index: u64 = io::read();
                let in_path = r_path();
                let in_leaf = leaf(&asset, &in_cx, &in_cy, &in_owner);
                assert!(
                    keccak_merkle_verify(&in_leaf, in_leaf_index, &in_path, &pool_root),
                    "bridge_stealth_mint: btc pool membership"
                );
                let nu = nullifier(&in_cx, &in_cy);

                // Recipient one-time stealth pubkey. Reject a non-curve owner_pub so a typo'd address can't
                // create an unclaimable lock (the locker can still refund either way); an honest O = B + s·G is
                // always a valid x-coordinate.
                let owner_pub = r32();
                {
                    let mut owner_comp = [2u8; 33];
                    owner_comp[1..].copy_from_slice(&owner_pub);
                    decompress(&owner_comp)
                        .expect("bridge_stealth_mint: owner_pub is not a valid x-only pubkey");
                }
                let amount: u64 = io::read();
                assert!(amount > 0, "bridge_stealth_mint: zero amount");
                let deadline: u64 = io::read();
                assert!(deadline != 0, "bridge_stealth_mint: deadline required");
                let locker = r32(); // refund recipient (the burner), bound into the lock leaf

                // Locked note L the value is minted into (opens to `amount`).
                let (l_cx, l_cy, l_pt) = r_commitment();
                let l_sig_r = decompress(&r33()).expect("bridge_stealth_mint: L-open R");
                let l_sig_z = scalar_reduce_be(&r32());

                // The burn pinned dest_leaf = stealth_lock_leaf(…); the bridge-burn set (ν → destCommitment)
                // thus authorizes exactly this lock for ν, and only once.
                let dest_leaf =
                    stealth_lock_leaf(&asset, &l_cx, &l_cy, &owner_pub, amount, deadline, &locker);
                assert!(
                    bitcoin_burn_root != [0u8; 32],
                    "bridge_stealth_mint: burn root required"
                );
                let bm_next = r32();
                let bm_index: u64 = io::read();
                let bm_path = r_path();
                let bm_leaf = utxo_leaf(&nu, &bm_next, &dest_leaf);
                assert!(
                    keccak_merkle_verify(&bm_leaf, bm_index, &bm_path, &bitcoin_burn_root),
                    "bridge_stealth_mint: nu not in Bitcoin bridge-burn set, or wrong stealth destination"
                );

                // Bind the cleartext `amount` to L (so a later claim, which mints the leaf-pinned amount, is
                // honest — no over-mint via an amount label that exceeds L's committed value).
                let ctx = intent_context(
                    b"tacit-bridge-stealth-mint-v1",
                    &chain_binding,
                    &asset,
                    &asset,
                    &[(l_cx, l_cy, owner_pub)],
                    &[amount, deadline],
                );
                assert!(
                    verify_opening_sigma(&l_pt, amount, &l_sig_r, &l_sig_z, &ctx),
                    "bridge_stealth_mint: L opening (amount binding)"
                );

                // Conservation: v_in (burned note) == v_L + fee. Requires the burned note's blinding, so only
                // its owner can mint. The L opening above pins v_L == amount (the claimable, leaf-bound), so a
                // relay fee is forced fee = v_in − amount (both pinned: amount in the lock leaf / burn set,
                // v_in by the kernel) — un-paddable. Relay (gasless cross-chain stealth pay): a keeper settles
                // the mint for a burner with no ETH gas and is paid `fee`; the recipient later claims `amount`.
                // fee = 0 ⇒ v_L == v_in, byte-identical to the original verify_kernel.
                let fee: u64 = io::read();
                let kernel_r = decompress(&r33()).expect("bridge_stealth_mint: R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee(&[in_pt], &[l_pt], fee, &kernel_r, &kernel_z),
                    "bridge_stealth_mint: conservation"
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }

                // Effects: append the lock to the SHARED lock-set (claimed via OP_STEALTH_CLAIM, refunded via
                // OP_STEALTH_REFUND), spend ν once in the GLOBAL nullifier set, gate one-mint-per-burned-ν
                // (bitcoin_burns + contract bridgeMinted), and record the Bitcoin pool root.
                lock_leaves.push(dest_leaf);
                nullifiers.push(nu);
                bitcoin_burns.push(nu);
                bitcoin_roots.push(pool_root);
            }
            OP_UNWRAP => {
                // Spend a note to a PUBLIC recipient via an OPENING SIGMA (not the raw blinding): the
                // settler verifies the note opening WITHOUT learning r, and the intent context binds
                // (recipient, value, fee), so it can neither spend the note elsewhere nor redirect the
                // withdrawal / pad the fee — the swap/LP trustless-settler pattern applied to the gasless
                // exit. The contract scales `value` to underlying by the asset's trusted unitScale, so each
                // payout is bound to the note value (the guest emits `value`, never an underlying amount).
                let asset = r32();
                let (cx, cy, c) = r_commitment();
                let owner = r32();
                let leaf_index: u64 = io::read();
                let path = r_path();
                let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                let value: u64 = io::read();
                let recipient = r20();
                // Relayer fee (gasless exit): the note opens to `value`; the recipient receives
                // `value − fee` and the settler (msg.sender — the relay box that pays gas) is paid `fee`.
                // Both legs are PUBLIC in-system values summing to the proven `value`; a self-settling user
                // sets fee = 0. fee ≤ value (no negative payout). Both are bound in the sigma below, so the
                // box cannot move value from the recipient leg to its own fee leg.
                let fee: u64 = io::read();
                // fee < value (not <=): a zero-net exit (fee == value) pays the relay the whole note and the
                // recipient nothing — pointless and asymmetric to every other op's `fee < amount`. A dust note
                // too small to relay self-settles (fee = 0) instead. The dapp already requires net > 0.
                assert!(fee < value, "unwrap fee must be < value (self-settle a dust note)");
                // Per-op expiry, bound in the opening sigma below (per-op Expired): a box holding this
                // proof can't submit it past `op_deadline`, and — since it's signed — can't forge/stretch
                // it. 0 = no expiry (a self-settling user). The guest folds it into the batch min_deadline.
                let op_deadline: u64 = io::read();
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }
                let sig_r = decompress(&r33()).expect("unwrap: sigma R");
                let sig_z = scalar_reduce_be(&r32());

                let lf = leaf(&asset, &cx, &cy, &owner);
                assert!(
                    spend_root != [0u8; 32],
                    "membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&lf, leaf_index, &path, &spend_root),
                    "membership"
                );
                // The 20-byte EVM recipient is bound in the asset_b slot (unwrap touches a single asset).
                let mut recip32 = [0u8; 32];
                recip32[12..].copy_from_slice(&recipient);
                let ctx = intent_context(
                    b"tacit-unwrap-intent-v1",
                    &chain_binding,
                    &asset,
                    &recip32,
                    &[(cx, cy, owner)],
                    &[value, fee, op_deadline],
                );
                assert!(
                    verify_opening_sigma(&c, value, &sig_r, &sig_z, &ctx),
                    "unwrap opening sigma"
                );
                let nu = nullifier(&cx, &cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&nu, &bitcoin_spent_root);
                }
                nullifiers.push(nu);
                let net = value - fee;
                if net != 0 {
                    withdrawals.push(Withdrawal {
                        assetId: asset.into(),
                        recipient: Address::from(recipient),
                        value: U256::from(net),
                    });
                }
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
            }
            OP_SEND_AND_UNWRAP => {
                // Partial public exit in one settle: spend ONE hidden note → a PUBLIC withdrawal of `payout`
                // to an EVM recipient + HIDDEN change note(s) back to the sender. Unlike OP_UNWRAP (whole
                // note exits, value public), the note's value stays PRIVATE — only `payout` (+ fee) is
                // public; the remainder lives on as a shielded change note. The opening sigma binds
                // (recipient, payout, fee, deadline) so a relay box can neither redirect the withdrawal nor
                // shift value between the payout and fee legs (the OP_UNWRAP trustless-settler pattern). The
                // conservation kernel proves value == Σchange + payout + fee (payout+fee are the public
                // leaving legs), and the range proof bounds the hidden change. fee = 0 ⇒ self-settle.
                let asset = r32();
                let (cx, cy, c) = r_commitment();
                let owner = r32();
                let leaf_index: u64 = io::read();
                let path = r_path();
                let _secret = r32(); // B3: vestigial — ν is note-bound, not secret-derived
                let value: u64 = io::read(); // PRIVATE note value (never emitted; binds the conservation)
                let recipient = r20();
                let payout: u64 = io::read(); // public amount sent to the recipient
                let fee: u64 = io::read();
                // Checked sum so correctness never depends on the build profile's overflow-checks: a wrapped
                // `payout + fee` must not pass the `<= value` bound and then emit the un-wrapped public legs.
                let public_exit = payout.checked_add(fee).expect("send-unwrap: payout + fee overflow");
                assert!(public_exit <= value, "send-unwrap: payout + fee exceeds value");
                assert!(payout > 0, "send-unwrap: zero payout (use OP_TRANSFER for a pure shielded move)");
                let op_deadline: u64 = io::read();
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }
                let sig_r = decompress(&r33()).expect("send-unwrap: sigma R");
                let sig_z = scalar_reduce_be(&r32());

                let lf = leaf(&asset, &cx, &cy, &owner);
                assert!(
                    spend_root != [0u8; 32],
                    "membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&lf, leaf_index, &path, &spend_root),
                    "membership"
                );
                let mut recip32 = [0u8; 32];
                recip32[12..].copy_from_slice(&recipient);
                // Bind value + the two public legs + recipient + deadline. value is a sigma input (a hash
                // preimage), NOT a PublicValues output, so the note value is never revealed.
                let ctx = intent_context(
                    b"tacit-send-unwrap-intent-v1",
                    &chain_binding,
                    &asset,
                    &recip32,
                    &[(cx, cy, owner)],
                    &[value, payout, fee, op_deadline],
                );
                assert!(
                    verify_opening_sigma(&c, value, &sig_r, &sig_z, &ctx),
                    "send-unwrap opening sigma"
                );
                let nu = nullifier(&cx, &cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&nu, &bitcoin_spent_root);
                }
                nullifiers.push(nu);

                // Hidden change note(s) back to the sender.
                let m_out: u32 = io::read();
                assert!(
                    m_out > 0 && m_out <= MAX_ITEMS_PER_OP,
                    "send-unwrap: change count 0 or over cap (whole-note exit uses OP_UNWRAP)"
                );
                let mut change_pts: Vec<Point> = Vec::with_capacity(m_out as usize);
                let mut change_leaves: Vec<[u8; 32]> = Vec::with_capacity(m_out as usize);
                for _ in 0..m_out {
                    let (ccx, ccy, p) = r_commitment();
                    let cowner = r32();
                    let lf = leaf(&asset, &ccx, &ccy, &cowner);
                    leaves.push(lf);
                    change_leaves.push(lf);
                    change_pts.push(p);
                }
                let bp_proof: Vec<u8> = io::read();
                assert!(verify_range(&change_pts, &bp_proof), "send-unwrap range");

                // Conservation: value == Σchange + (payout + fee). The single input is the spent note; the
                // public leaving amount is payout+fee (both bound in the sigma above, so the split is fixed).
                // The kernel binds the change LEAVES so a delegated prover can't mutate a change `owner`.
                let kernel_r = decompress(&r33()).expect("send-unwrap kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee_bound(&[c], &change_pts, public_exit, &change_leaves, &kernel_r, &kernel_z),
                    "send-unwrap conservation"
                );

                withdrawals.push(Withdrawal {
                    assetId: asset.into(),
                    recipient: Address::from(recipient),
                    value: U256::from(payout),
                });
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
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
                assert!(fee_bps <= 1000, "fee tier over MAX_POOL_FEE_BPS"); // guard 10000-fee_bps before AMM math
                // Protocol-fee (Uniswap fee-switch, realized per-swap) config: 0 = canonical no-skim pool.
                // protocol_fee_bps is the fraction (bps) of the LP fee that accrues to the recipient; both bind
                // the pool id (a fee pool is a DISTINCT slot — the permissionless creator-fee primitive).
                let protocol_fee_bps: u32 = io::read();
                // Bound < 10000 (not <=) to match the Bitcoin POOL_INIT cap (lib.rs `lp_add fold`, where the
                // `10000 - bps` mintFee denominator would underflow at 10000): a pool config must be usable on
                // BOTH lanes. 10000 (100% of the LP fee to the protocol) is degenerate anyway — LPs earn nothing.
                assert!(protocol_fee_bps < 10000, "swap: protocol fee fraction must be < 100% of the LP fee");
                let protocol_fee_recipient = r33();
                let pid = pool_id_with_protocol_fee(&asset_a, &asset_b, fee_bps, &protocol_fee_recipient, protocol_fee_bps);
                // Canonical orientation: asset_a MUST be the low asset of the (sorted) pool pair, so it
                // maps to the contract's p.reserveA. pool_id sorts internally, so a reversed (asset_a,
                // asset_b) witness yields the SAME pid; without this a prover could pass the high asset as
                // asset_a with the low asset's reserve and clear the batch on a swapped reserve→asset map,
                // minting the high-value leg for the low-value one (settle gates p.reserveA == reserve_a_pre
                // but never the asset identities — the guest is the only orientation pin).
                assert!(
                    bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b,
                    "swap: non-canonical asset order"
                );
                let reserve_a_pre: u64 = io::read();
                let reserve_b_pre: u64 = io::read();
                let price_num: u64 = io::read(); // uniform price: price_num B per price_den A
                let price_den: u64 = io::read();
                assert!(price_num > 0 && price_den > 0, "swap: zero price");
                let n_intents: u32 = io::read();
                assert!(
                    n_intents > 0 && n_intents <= MAX_ITEMS_PER_OP,
                    "swap: intent count out of range"
                );

                // u128 flow accumulators (sums of u64 amounts across the batch can exceed u64).
                let mut gross_a_in: u128 = 0;
                let mut gross_a_out: u128 = 0;
                let mut gross_b_in: u128 = 0;
                let mut gross_b_out: u128 = 0;

                for _ in 0..n_intents {
                    let direction: u8 = io::read();
                    assert!(
                        direction == SWAP_DIR_A_TO_B || direction == SWAP_DIR_B_TO_A,
                        "swap: bad direction"
                    );
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
                    assert!(
                        spend_root != [0u8; 32],
                        "swap: membership requires a non-zero spend root"
                    );
                    assert!(
                        keccak_merkle_verify(&in_lf, in_leaf_index, &in_path, &spend_root),
                        "swap: membership"
                    );
                    let nu = nullifier(&in_cx, &in_cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }

                    let amount_in: u64 = io::read();
                    // Relay fee (gasless privacy): carved in the INPUT asset; only amount_in − fee swaps,
                    // and `fee` is paid to the settler (msg.sender). Bound in the intent sigma below;
                    // fee = 0 ⇒ self-settle. Each trader in the batch covers their own relay fee.
                    let fee: u64 = io::read();
                    assert!(fee < amount_in, "swap: fee >= input");
                    let amount_out: u64 = io::read();
                    let rem: u64 = io::read();
                    let in_sig_r = decompress(&r33()).expect("swap: in sigma R");
                    let in_sig_z = scalar_reduce_be(&r32());
                    let min_out: u64 = io::read();
                    let intent_deadline: u64 = io::read(); // bound in this trader's sigma (per-op Expired)
                    if intent_deadline != 0 {
                        min_deadline = if min_deadline == 0 {
                            intent_deadline
                        } else {
                            min_deadline.min(intent_deadline)
                        };
                    }
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
                        b"tacit-swap-intent-v1",
                        &chain_binding,
                        &asset_a,
                        &asset_b,
                        &[(in_cx, in_cy, in_owner), (out_cx, out_cy, out_owner)],
                        &[
                            direction as u64,
                            amount_in,
                            amount_out,
                            min_out,
                            intent_deadline,
                            fee,
                        ],
                    );
                    assert!(
                        verify_opening_sigma(&in_pt, amount_in, &in_sig_r, &in_sig_z, &ctx),
                        "swap: input opening"
                    );
                    assert!(
                        verify_opening_sigma(&out_pt, amount_out, &out_sig_r, &out_sig_z, &ctx),
                        "swap: output opening"
                    );

                    // Uniform-price clearing: amount_out = floor(amount_in · P), one price per batch.
                    //   A→B: in·num == out·den + rem,  rem < den
                    //   B→A: in·den == out·num + rem,  rem < num   (P inverted for the other side)
                    let ain = (amount_in - fee) as u128; // the amount that actually swaps (relay fee carved off)
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
                    if fee != 0 {
                        fees.push(FeePayment {
                            assetId: (*in_asset).into(),
                            value: U256::from(fee),
                        });
                    }
                }

                // Net reserve move (no underflow), and the constant-product non-decrease.
                let a_pre = reserve_a_pre as u128;
                let b_pre = reserve_b_pre as u128;
                assert!(
                    a_pre + gross_a_in >= gross_a_out,
                    "swap: reserve A underflow"
                );
                assert!(
                    b_pre + gross_b_in >= gross_b_out,
                    "swap: reserve B underflow"
                );
                let a_post = a_pre + gross_a_in - gross_a_out;
                let b_post = b_pre + gross_b_in - gross_b_out;
                assert!(
                    a_post <= u64::MAX as u128 && b_post <= u64::MAX as u128,
                    "swap: reserve overflow"
                );
                // Protocol fee (Uniswap fee-switch, per-swap): the recipient takes protocol_fee_bps/10000 of the
                // LP fee (= gross_in·fee_bps/10000) on each input leg, carved from the pool's RETAINED fee into a
                // stealth-lock note (claimed via OP_STEALTH_CLAIM under the recipient key — no new op). The cut
                // comes out of the LP's share, NOT the trader's (the clearing price below is unchanged ⇒ trader-
                // neutral). Conserved by construction: the note value is opening-bound to the cut, and the same
                // cut is subtracted from the pool reserves (a_post/b_post). The constant-product k-check then runs
                // on the POST-CUT reserves, so an over-large skim reverts rather than draining the pool.
                //
                // Same φ, different realization vs the Bitcoin lane. Bitcoin Track-B charges the SAME φ =
                // protocol_fee_bps/10000 of the LP fee, but via the Uniswap-V2 lazy-`mintFee` √k crystallization
                // (cxfer-core `protocol_fee_shares`/`crystallize_protocol_fee`, run at LP events) — the cut stays
                // in the pool as LP shares that keep earning/suffering IL until claimed. The EVM lane carves φ out
                // per swap as a note, so it never re-enters the pool. Aggregate fee split (protocol φ, LPs 1−φ) is
                // identical; per-state reserve trajectories are NOT bit-identical, and that is intentional —
                // confidential swaps settle individually (carve is natural) while Bitcoin batches via reflection
                // (lazy-mint is natural). A per-swap carve also leaves no accrual to crystallize, so the EVM lane
                // has no `k_last`/`protocol_fee_accrued` state at all.
                let (a_post, b_post) = if protocol_fee_bps != 0 {
                    let recipient_x: [u8; 32] =
                        protocol_fee_recipient[1..].try_into().expect("swap: recipient x");
                    // Reject a protocol-fee recipient whose x-only key isn't on-curve — otherwise the per-swap
                    // fee lock (claimed by BIP-340 under recipient_x) would be permanently unclaimable. Fail the
                    // swap closed rather than strand value in a trap pool (mirror the stealth-lock owner check).
                    let mut recipient_comp = [0u8; 33];
                    recipient_comp[0] = 0x02;
                    recipient_comp[1..].copy_from_slice(&recipient_x);
                    decompress(&recipient_comp)
                        .expect("swap: protocol-fee recipient is not a valid x-only pubkey");
                    let cut_a = protocol_fee_cut(gross_a_in, fee_bps, protocol_fee_bps);
                    let cut_b = protocol_fee_cut(gross_b_in, fee_bps, protocol_fee_bps);
                    if cut_a != 0 {
                        let (t_cx, t_cy, t_pt) = r_commitment();
                        let t_sig_r = decompress(&r33()).expect("swap: protofee A R");
                        let t_sig_z = scalar_reduce_be(&r32());
                        let t_ctx = intent_context(
                            b"tacit-swap-protofee-v1", &chain_binding, &asset_a, &asset_a,
                            &[(t_cx, t_cy, recipient_x)], &[cut_a],
                        );
                        assert!(verify_opening_sigma(&t_pt, cut_a, &t_sig_r, &t_sig_z, &t_ctx), "swap: protofee A opening");
                        lock_leaves.push(stealth_lock_leaf(&asset_a, &t_cx, &t_cy, &recipient_x, cut_a, u64::MAX, &recipient_x));
                    }
                    if cut_b != 0 {
                        let (t_cx, t_cy, t_pt) = r_commitment();
                        let t_sig_r = decompress(&r33()).expect("swap: protofee B R");
                        let t_sig_z = scalar_reduce_be(&r32());
                        let t_ctx = intent_context(
                            b"tacit-swap-protofee-v1", &chain_binding, &asset_b, &asset_b,
                            &[(t_cx, t_cy, recipient_x)], &[cut_b],
                        );
                        assert!(verify_opening_sigma(&t_pt, cut_b, &t_sig_r, &t_sig_z, &t_ctx), "swap: protofee B opening");
                        lock_leaves.push(stealth_lock_leaf(&asset_b, &t_cx, &t_cy, &recipient_x, cut_b, u64::MAX, &recipient_x));
                    }
                    assert!(a_post >= cut_a as u128 && b_post >= cut_b as u128, "swap: protofee exceeds reserves");
                    (a_post - cut_a as u128, b_post - cut_b as u128)
                } else {
                    (a_post, b_post)
                };
                assert!(
                    a_post * b_post >= a_pre * b_pre,
                    "swap: constant-product decreased"
                );

                // Enforce the pool's FEE TIER: re-derive the deterministic clearing price (AMM.md §4)
                // from the public reserves + gross flows + fee_bps and require the batch's declared
                // uniform price to equal it EXACTLY. The constant-product non-decrease above is only the
                // ZERO-fee floor; without this a self-solved batch could clear at the zero-fee price and
                // starve LPs of the fee they're owed. This makes the fee tier economically real.
                assert!(
                    gross_a_in <= u64::MAX as u128 && gross_b_in <= u64::MAX as u128,
                    "swap: gross flow over u64"
                );
                assert!(
                    clearing_price_matches(
                        gross_a_in as u64,
                        gross_b_in as u64,
                        reserve_a_pre,
                        reserve_b_pre,
                        fee_bps,
                        price_num,
                        price_den
                    ),
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
                assert!(fee_bps <= 1000, "fee tier over MAX_POOL_FEE_BPS"); // guard 10000-fee_bps before AMM math
                // Optional Uniswap fee-switch: bind the SAME protocol-fee-skim pool id OP_SWAP derives, so a
                // non-zero-skim pool is FUNDABLE (otherwise swaps key a 6-arg id no LP path ever seeds → a dead,
                // unswappable slot). `protocol_fee_bps == 0` is byte-identical to the canonical `pool_id`, so
                // existing no-skim pools/fixtures are unchanged. The recipient is bound into the id (a wrong
                // recipient simply maps to a different/uninitialized pool — self-enforcing, no extra check).
                let protocol_fee_bps: u32 = io::read();
                assert!(protocol_fee_bps < 10000, "lp_add: protocol fee fraction must be < 100% of the LP fee");
                let protocol_fee_recipient = r33();
                let pid = pool_id_with_protocol_fee(&asset_a, &asset_b, fee_bps, &protocol_fee_recipient, protocol_fee_bps);
                // Canonical orientation (see OP_SWAP): asset_a must be the low asset that maps to the
                // contract's p.reserveA, else an in-ratio add could be cleared against a swapped
                // reserve→asset map.
                assert!(
                    bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b,
                    "lp_add: non-canonical asset order"
                );
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
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }

                // Relay fee (gasless privacy): carved from the A contribution in asset_a; the LP earns
                // shares on (d_a − fee) and the settler (msg.sender) is paid `fee`. The A note still opens
                // to its full value d_a; fee = 0 ⇒ self-settle. Bound in the intent sigma below.
                let fee: u64 = io::read();
                assert!(fee < d_a, "lp_add: fee >= A contribution");
                let add_a = d_a - fee;

                // Constant-product mint: the FIRST provider (empty pool, shares_pre==0) sets totalShares =
                // isqrt(dA·dB) and gets isqrt − MINIMUM_LIQUIDITY as their note (MINIMUM_LIQUIDITY = the
                // permanent NOTELESS floor, so reserves can never fully drain → the (pair,fee) slot can't be
                // bricked); they set the price, reserves are SET not added. Every SUBSEQUENT provider earns
                // the MIN rule min(floor(S·dA/R_A), floor(S·dB/R_B)) — off-ratio safe (the excess accrues to
                // the pool), no exact-ratio gate (the old `dA·R_B == dB·R_A` forced dA to be a multiple of
                // R_A/gcd and broke incremental adds once a traded pool went coprime). d_shares is DERIVED
                // in-guest (not witnessed), so it can't be over-claimed; the share note must open to it.
                let da = add_a as u128; // fee carved off the A contribution before the pool/share math
                let db = d_b as u128;
                let ra = r_a_pre as u128;
                let rb = r_b_pre as u128;
                let sp = shares_pre as u128;
                let (d_shares_u128, r_a_post, r_b_post, s_post): (u128, u128, u128, u128) =
                    if shares_pre == 0 {
                        assert!(
                            r_a_pre == 0 && r_b_pre == 0,
                            "lp_add: first mint requires an empty pool"
                        );
                        assert!(da > 0 && db > 0, "lp_add: first mint needs both sides");
                        assert!(
                            da <= u64::MAX as u128 && db <= u64::MAX as u128,
                            "lp_add: first-mint reserve overflow"
                        );
                        let total = isqrt(da * db);
                        assert!(
                            total > MINIMUM_LIQUIDITY,
                            "lp_add: initial liquidity below MINIMUM_LIQUIDITY"
                        );
                        (total - MINIMUM_LIQUIDITY, da, db, total)
                    } else {
                        assert!(ra > 0 && rb > 0, "lp_add: pool must be initialized");
                        let ds = lp_add_shares(shares_pre, add_a, d_b, r_a_pre, r_b_pre);
                        assert!(ds > 0, "lp_add: zero shares minted (dust add)"); // reject a dust add that mints nothing
                        assert!(
                            (ra + da) <= u64::MAX as u128
                                && (rb + db) <= u64::MAX as u128
                                && (sp + ds) <= u64::MAX as u128,
                            "lp_add: overflow"
                        );
                        (ds, ra + da, rb + db, sp + ds)
                    };
                assert!(d_shares_u128 <= u64::MAX as u128, "lp_add: shares overflow");
                let d_shares = d_shares_u128 as u64;

                // The intent context binds all three notes + the deltas (incl. the DERIVED d_shares): the
                // box can't redirect the minted LP-share note or alter the amounts (the sigmas commit to
                // it), and never learns a blinding (so it can't spend the A/B contribution notes). The
                // synthetic (lp_asset, pid, s_owner) tuple binds the POOL IDENTITY — without it a first-add
                // (d_shares = isqrt(d_a·d_b), independent of any pool) could be redirected by the box into a
                // different same-pair fee tier / protocol-fee config, stranding the LP's liquidity. pid binds
                // fee_bps + protocol_fee_recipient + protocol_fee_bps; lp_asset is the minted share's asset.
                let ctx = intent_context(
                    b"tacit-lp-add-v1",
                    &chain_binding,
                    &asset_a,
                    &asset_b,
                    &[
                        (a_cx, a_cy, a_owner),
                        (b_cx, b_cy, b_owner),
                        (s_cx, s_cy, s_owner),
                        (lp_asset, pid, s_owner),
                    ],
                    &[d_a, d_b, d_shares, op_deadline, fee],
                );

                // Spend the two contribution notes: membership + ν + cross-lane + opening sigma (binds d_a/d_b).
                let a_lf = leaf(&asset_a, &a_cx, &a_cy, &a_owner);
                assert!(
                    spend_root != [0u8; 32],
                    "lp_add: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&a_lf, a_idx, &a_path, &spend_root),
                    "lp_add: A membership"
                );
                let a_nu = nullifier(&a_cx, &a_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&a_nu, &bitcoin_spent_root);
                }
                assert!(
                    verify_opening_sigma(&a_pt, d_a, &a_sig_r, &a_sig_z, &ctx),
                    "lp_add: A opening"
                );
                let b_lf = leaf(&asset_b, &b_cx, &b_cy, &b_owner);
                assert!(
                    keccak_merkle_verify(&b_lf, b_idx, &b_path, &spend_root),
                    "lp_add: B membership"
                );
                let b_nu = nullifier(&b_cx, &b_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&b_nu, &bitcoin_spent_root);
                }
                assert!(
                    verify_opening_sigma(&b_pt, d_b, &b_sig_r, &b_sig_z, &ctx),
                    "lp_add: B opening"
                );

                // The minted LP-share note opens to the DERIVED d_shares (can't claim more than earned).
                assert!(
                    verify_opening_sigma(&s_pt, d_shares, &s_sig_r, &s_sig_z, &ctx),
                    "lp_add: share opening"
                );

                nullifiers.push(a_nu);
                nullifiers.push(b_nu);
                leaves.push(leaf(&lp_asset, &s_cx, &s_cy, &s_owner));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset_a.into(),
                        value: U256::from(fee),
                    });
                }
                liquidity.push(LpSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(r_a_pre),
                    reserveBPre: U256::from(r_b_pre),
                    sharesPre: U256::from(shares_pre),
                    reserveAPost: U256::from(r_a_post as u64),
                    reserveBPost: U256::from(r_b_post as u64),
                    sharesPost: U256::from(s_post as u64),
                });
            }
            OP_LP_BOND => {
                // 1-click farm entry: add liquidity AND bond the resulting LP shares into a farm in ONE
                // settle (OP_LP_ADD fused with OP_FARM_BOND). The intermediate LP-share note never exists —
                // the in-guest-DERIVED `d_shares` flow straight into a farm_receipt_leaf + the bond CdpMint
                // (positionLeaf == 1 / debtValue == 0 sentinel, legs = [shares, rps_entry]) so the controller
                // binds `rps_entry == rps_live` + `total_shares += shares`. Share math, reserve update, and
                // the A/B opening sigmas are byte-identical to OP_LP_ADD; the A/B sigmas additionally bind the
                // BOND TARGET (controller, owner, nonce) so a relay box cannot re-target the bonded liquidity.
                let controller = r20();
                let owner = r32(); // farm-receipt owner (the LP)
                let rps_entry: u128 = io::read(); // witnessed; the controller binds it to rps_live at settle
                let bond_nonce = r32();
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);

                let asset_a = r32();
                let asset_b = r32();
                let fee_bps: u32 = io::read();
                assert!(fee_bps <= 1000, "lp_bond: fee tier over MAX_POOL_FEE_BPS");
                let pid = pool_id(&asset_a, &asset_b, fee_bps);
                assert!(
                    bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b,
                    "lp_bond: non-canonical asset order"
                );
                let lp_asset = lp_share_id(&pid);
                let r_a_pre: u64 = io::read();
                let r_b_pre: u64 = io::read();
                let shares_pre: u64 = io::read();

                let (a_cx, a_cy, a_pt) = r_commitment();
                let a_owner = r32();
                let a_idx: u64 = io::read();
                let a_path = r_path();
                let d_a: u64 = io::read();
                let a_sig_r = decompress(&r33()).expect("lp_bond: A sigma R");
                let a_sig_z = scalar_reduce_be(&r32());
                let (b_cx, b_cy, b_pt) = r_commitment();
                let b_owner = r32();
                let b_idx: u64 = io::read();
                let b_path = r_path();
                let d_b: u64 = io::read();
                let b_sig_r = decompress(&r33()).expect("lp_bond: B sigma R");
                let b_sig_z = scalar_reduce_be(&r32());
                let op_deadline: u64 = io::read();
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }
                let fee: u64 = io::read();
                assert!(fee < d_a, "lp_bond: fee >= A contribution");
                let add_a = d_a - fee;

                // DERIVE d_shares exactly as OP_LP_ADD (never witnessed → can't be over-claimed).
                let da = add_a as u128;
                let db = d_b as u128;
                let ra = r_a_pre as u128;
                let rb = r_b_pre as u128;
                let sp = shares_pre as u128;
                let (d_shares_u128, r_a_post, r_b_post, s_post): (u128, u128, u128, u128) =
                    if shares_pre == 0 {
                        assert!(r_a_pre == 0 && r_b_pre == 0, "lp_bond: first mint requires an empty pool");
                        assert!(da > 0 && db > 0, "lp_bond: first mint needs both sides");
                        assert!(da <= u64::MAX as u128 && db <= u64::MAX as u128, "lp_bond: first-mint reserve overflow");
                        let total = isqrt(da * db);
                        assert!(total > MINIMUM_LIQUIDITY, "lp_bond: initial liquidity below MINIMUM_LIQUIDITY");
                        (total - MINIMUM_LIQUIDITY, da, db, total)
                    } else {
                        assert!(ra > 0 && rb > 0, "lp_bond: pool must be initialized");
                        let ds = lp_add_shares(shares_pre, add_a, d_b, r_a_pre, r_b_pre);
                        assert!(ds > 0, "lp_bond: zero shares minted (dust add)");
                        assert!(
                            (ra + da) <= u64::MAX as u128 && (rb + db) <= u64::MAX as u128 && (sp + ds) <= u64::MAX as u128,
                            "lp_bond: overflow"
                        );
                        (ds, ra + da, rb + db, sp + ds)
                    };
                assert!(d_shares_u128 <= u64::MAX as u128, "lp_bond: shares overflow");
                let d_shares = d_shares_u128 as u64;

                // The A/B sigmas bind the deltas (incl. DERIVED d_shares) AND the bond target via the synthetic
                // (controller32, nonce, owner) note tuple — so a relay can neither alter the amounts nor
                // re-point the bonded shares to a different controller/owner.
                let ctx = intent_context(
                    b"tacit-lp-bond-v1",
                    &chain_binding,
                    &asset_a,
                    &asset_b,
                    &[
                        (a_cx, a_cy, a_owner),
                        (b_cx, b_cy, b_owner),
                        (controller32, bond_nonce, owner),
                    ],
                    // bind rps_entry (u128 hi/lo) — same reason as OP_FARM_BOND: stop a delegated prover
                    // future-dating the receipt's entry checkpoint and forfeiting the bonder's yield.
                    &[d_a, d_b, d_shares, op_deadline, fee, (rps_entry >> 64) as u64, rps_entry as u64],
                );

                let a_lf = leaf(&asset_a, &a_cx, &a_cy, &a_owner);
                assert!(spend_root != [0u8; 32], "lp_bond: membership requires a non-zero spend root");
                assert!(keccak_merkle_verify(&a_lf, a_idx, &a_path, &spend_root), "lp_bond: A membership");
                let a_nu = nullifier(&a_cx, &a_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&a_nu, &bitcoin_spent_root);
                }
                assert!(verify_opening_sigma(&a_pt, d_a, &a_sig_r, &a_sig_z, &ctx), "lp_bond: A opening");
                let b_lf = leaf(&asset_b, &b_cx, &b_cy, &b_owner);
                assert!(keccak_merkle_verify(&b_lf, b_idx, &b_path, &spend_root), "lp_bond: B membership");
                let b_nu = nullifier(&b_cx, &b_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&b_nu, &bitcoin_spent_root);
                }
                assert!(verify_opening_sigma(&b_pt, d_b, &b_sig_r, &b_sig_z, &ctx), "lp_bond: B opening");

                nullifiers.push(a_nu);
                nullifiers.push(b_nu);
                // Bond the derived shares directly: the receipt leaf (no intermediate LP-share note) + the
                // reserve update + the bond CdpMint the controller binds (rps_entry == rps_live, total_shares +=).
                leaves.push(farm_receipt_leaf(&controller32, d_shares, rps_entry, &owner, &bond_nonce));
                if fee != 0 {
                    fees.push(FeePayment { assetId: asset_a.into(), value: U256::from(fee) });
                }
                liquidity.push(LpSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(r_a_pre),
                    reserveBPre: U256::from(r_b_pre),
                    sharesPre: U256::from(shares_pre),
                    reserveAPost: U256::from(r_a_post as u64),
                    reserveBPost: U256::from(r_b_post as u64),
                    sharesPost: U256::from(s_post as u64),
                });
                let debt_asset = cdp_debt_asset_id(&controller);
                let mut sentinel = [0u8; 32];
                sentinel[31] = 1; // positionLeaf == 1 (fair-farm sentinel); debtValue == 0 ⇒ BOND
                cdp_mints.push(CdpMint {
                    controller: Address::from(controller),
                    debtAsset: debt_asset.into(),
                    debtValue: U256::from(0u64),
                    positionLeaf: sentinel.into(),
                    rateSnapshot: U256::from(0u64),
                    legs: vec![
                        CdpLeg { asset: lp_asset.into(), value: U256::from(d_shares) },
                        CdpLeg { asset: [0u8; 32].into(), value: U256::from(rps_entry) },
                    ],
                    owner: owner.into(),
                });
            }
            OP_LP_REMOVE => {
                // Confidential remove-liquidity: spend a shielded LP-share note, withdraw the proportional
                // underlying as fresh A/B notes. The share note proves the LP's stake (opening); the
                // withdrawal is floored toward the pool so the dust accrues to the remaining LPs.
                let asset_a = r32();
                let asset_b = r32();
                let fee_bps: u32 = io::read(); // pool fee tier — binds the pool id (multi-fee-tier)
                assert!(fee_bps <= 1000, "fee tier over MAX_POOL_FEE_BPS"); // guard 10000-fee_bps before AMM math
                // Optional Uniswap fee-switch (see OP_LP_ADD): derive the same 6-arg skim pool id so liquidity
                // can be REMOVED from a protocol-fee pool. `protocol_fee_bps == 0` ≡ the canonical `pool_id`.
                let protocol_fee_bps: u32 = io::read();
                assert!(protocol_fee_bps < 10000, "lp_remove: protocol fee fraction must be < 100% of the LP fee");
                let protocol_fee_recipient = r33();
                let pid = pool_id_with_protocol_fee(&asset_a, &asset_b, fee_bps, &protocol_fee_recipient, protocol_fee_bps);
                // Canonical orientation (see OP_SWAP): asset_a must be the low asset that maps to the
                // contract's p.reserveA, else the proportional withdrawal da=floor(R_A·ds/sp) — computed
                // from the low reserve — would be emitted as the HIGH-value asset_a note (LP over-withdraw).
                assert!(
                    bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b,
                    "lp_remove: non-canonical asset order"
                );
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
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }

                // Relay fee (gasless privacy): carved from the A withdrawal in asset_a; the A note opens
                // to (d_a − fee) and the settler (msg.sender) is paid `fee`. The pool still releases the
                // full proportional d_a; fee = 0 ⇒ self-settle. Bound in the intent sigma below.
                let fee: u64 = io::read();
                assert!(fee < d_a, "lp_remove: fee >= A withdrawal");
                let net_a = d_a - fee;

                // Intent context binds the spent LP-share note + the two minted A/B notes + the
                // amounts: the box can't redirect the withdrawn A/B notes or alter d_shares/dA/dB, and
                // never learns the share blinding (so it can't spend the LP-share note).
                let ctx = intent_context(
                    b"tacit-lp-remove-v1",
                    &chain_binding,
                    &asset_a,
                    &asset_b,
                    &[
                        (s_cx, s_cy, s_owner),
                        (a_cx, a_cy, a_owner),
                        (b_cx, b_cy, b_owner),
                    ],
                    &[d_shares, d_a, d_b, op_deadline, fee],
                );

                // Spend the LP-share note: membership + ν + cross-lane + opening sigma (binds d_shares).
                let s_lf = leaf(&lp_asset, &s_cx, &s_cy, &s_owner);
                assert!(
                    spend_root != [0u8; 32],
                    "lp_remove: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&s_lf, s_idx, &s_path, &spend_root),
                    "lp_remove: share membership"
                );
                let s_nu = nullifier(&s_cx, &s_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&s_nu, &bitcoin_spent_root);
                }
                assert!(
                    verify_opening_sigma(&s_pt, d_shares, &s_sig_r, &s_sig_z, &ctx),
                    "lp_remove: share opening"
                );

                let da = d_a as u128;
                let db = d_b as u128;
                let ra = r_a_pre as u128;
                let rb = r_b_pre as u128;
                let sp = shares_pre as u128;
                let ds = d_shares as u128;
                assert!(sp > 0 && ds > 0 && ds <= sp, "lp_remove: shares in range");
                // The locked MINIMUM_LIQUIDITY can never be removed (no note holds it), so totalShares
                // stays ≥ MINIMUM_LIQUIDITY — keeping the (pair,fee) slot live after a full exit. Reject
                // a remove that would breach it in-guest (fail-fast; the contract enforces the same gate).
                assert!(
                    sp - ds >= MINIMUM_LIQUIDITY,
                    "lp_remove: would breach MINIMUM_LIQUIDITY floor"
                );
                // Proportional withdrawal, floor toward the pool (dust stays for remaining LPs).
                assert!((rem_a as u128) < sp, "lp_remove: remA range");
                assert!(
                    ra * ds == da * sp + rem_a as u128,
                    "lp_remove: dA = floor(R_A·shares/total)"
                );
                assert!((rem_b as u128) < sp, "lp_remove: remB range");
                assert!(
                    rb * ds == db * sp + rem_b as u128,
                    "lp_remove: dB = floor(R_B·shares/total)"
                );
                // The withdrawn A/B notes open to dA/dB (sigma — the box never learns r_a/r_b).
                assert!(
                    verify_opening_sigma(&a_pt, net_a, &a_sig_r, &a_sig_z, &ctx),
                    "lp_remove: A opening (net of relay fee)"
                );
                assert!(
                    verify_opening_sigma(&b_pt, d_b, &b_sig_r, &b_sig_z, &ctx),
                    "lp_remove: B opening"
                );

                nullifiers.push(s_nu);
                leaves.push(leaf(&asset_a, &a_cx, &a_cy, &a_owner));
                leaves.push(leaf(&asset_b, &b_cx, &b_cy, &b_owner));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset_a.into(),
                        value: U256::from(fee),
                    });
                }
                liquidity.push(LpSettlement {
                    poolId: pid.into(),
                    reserveAPre: U256::from(r_a_pre),
                    reserveBPre: U256::from(r_b_pre),
                    sharesPre: U256::from(shares_pre),
                    reserveAPost: U256::from((ra - da) as u64),
                    reserveBPost: U256::from((rb - db) as u64),
                    sharesPost: U256::from((sp - ds) as u64),
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
                assert!(
                    spend_root != [0u8; 32],
                    "otc: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&m_in_lf, m_in_index, &m_in_path, &spend_root),
                    "otc: maker membership"
                );
                let m_nu = nullifier(&m_in_cx, &m_in_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&m_nu, &bitcoin_spent_root);
                }
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
                } else {
                    None
                };
                // Maker received (asset_b, value v_b).
                let (m_rv_cx, m_rv_cy, m_rv_pt) = r_commitment();
                let m_rv_sig_r = decompress(&r33()).expect("otc: maker-recv R");
                let m_rv_sig_z = scalar_reduce_be(&r32());

                // ---- Taker input (asset_b): membership + ν + cross-lane gate ----
                let (t_in_cx, t_in_cy, t_in_pt) = r_commitment();
                let t_in_index: u64 = io::read();
                let t_in_path = r_path();
                let t_in_lf = leaf(&asset_b, &t_in_cx, &t_in_cy, &taker_owner);
                assert!(
                    keccak_merkle_verify(&t_in_lf, t_in_index, &t_in_path, &spend_root),
                    "otc: taker membership"
                );
                let t_nu = nullifier(&t_in_cx, &t_in_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&t_nu, &bitcoin_spent_root);
                }
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
                } else {
                    None
                };
                // Taker received (asset_a, value v_a).
                let (t_rv_cx, t_rv_cy, t_rv_pt) = r_commitment();
                let t_rv_sig_r = decompress(&r33()).expect("otc: taker-recv R");
                let t_rv_sig_z = scalar_reduce_be(&r32());

                // ---- Shared intent context: every touched note + owner + both amounts ----
                let mut ctx_notes: Vec<([u8; 32], [u8; 32], [u8; 32])> =
                    vec![(m_in_cx, m_in_cy, maker_owner)];
                if let Some((cx, cy, _, _, _)) = m_change {
                    ctx_notes.push((cx, cy, maker_owner));
                }
                ctx_notes.push((m_rv_cx, m_rv_cy, maker_owner));
                ctx_notes.push((t_in_cx, t_in_cy, taker_owner));
                if let Some((cx, cy, _, _, _)) = t_change {
                    ctx_notes.push((cx, cy, taker_owner));
                }
                ctx_notes.push((t_rv_cx, t_rv_cy, taker_owner));
                let op_deadline: u64 = io::read(); // bound in BOTH parties' sigmas (per-op Expired)
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }
                // Relay fees (gasless privacy): each party may carve a fee from the asset they RECEIVE —
                // fee_a from the taker's received v_a (asset_a), fee_b from the maker's received v_b
                // (asset_b) — paid to the settler (msg.sender). Either/both default 0 (self-settle); bound
                // in the shared sigma context below so the box can't pad them.
                let fee_a: u64 = io::read();
                let fee_b: u64 = io::read();
                assert!(fee_a < v_a, "otc: fee_a >= taker receipt");
                assert!(fee_b < v_b, "otc: fee_b >= maker receipt");
                let ctx = intent_context(
                    b"tacit-otc-intent-v1",
                    &chain_binding,
                    &asset_a,
                    &asset_b,
                    &ctx_notes,
                    &[v_a, v_b, op_deadline, fee_a, fee_b],
                );

                // ---- Authorizations: each party's input opens (proving the spend is theirs) and
                //      each output opens to its bound amount (no redirect / no re-price) ----
                assert!(
                    verify_opening_sigma(&m_in_pt, m_in_amount, &m_in_sig_r, &m_in_sig_z, &ctx),
                    "otc: maker-in opening"
                );
                assert!(
                    verify_opening_sigma(&t_in_pt, t_in_amount, &t_in_sig_r, &t_in_sig_z, &ctx),
                    "otc: taker-in opening"
                );
                assert!(
                    verify_opening_sigma(&m_rv_pt, v_b - fee_b, &m_rv_sig_r, &m_rv_sig_z, &ctx),
                    "otc: maker-recv opening (net of relay fee)"
                );
                assert!(
                    verify_opening_sigma(&t_rv_pt, v_a - fee_a, &t_rv_sig_r, &t_rv_sig_z, &ctx),
                    "otc: taker-recv opening (net of relay fee)"
                );

                // ---- Per-asset conservation (u128 sums; canonical change form) ----
                let change_a: u64 = match m_change {
                    Some((_, _, pt, sr, sz)) => {
                        assert!(m_in_amount > v_a, "otc: maker change requires input > give");
                        let c = m_in_amount - v_a;
                        assert!(
                            verify_opening_sigma(&pt, c, &sr, &sz, &ctx),
                            "otc: maker-change opening"
                        );
                        c
                    }
                    None => {
                        assert!(
                            m_in_amount == v_a,
                            "otc: maker exact input required without change"
                        );
                        0
                    }
                };
                let change_b: u64 = match t_change {
                    Some((_, _, pt, sr, sz)) => {
                        assert!(t_in_amount > v_b, "otc: taker change requires input > give");
                        let c = t_in_amount - v_b;
                        assert!(
                            verify_opening_sigma(&pt, c, &sr, &sz, &ctx),
                            "otc: taker-change opening"
                        );
                        c
                    }
                    None => {
                        assert!(
                            t_in_amount == v_b,
                            "otc: taker exact input required without change"
                        );
                        0
                    }
                };
                assert!(
                    m_in_amount as u128 == v_a as u128 + change_a as u128,
                    "otc: asset_a conservation"
                );
                assert!(
                    t_in_amount as u128 == v_b as u128 + change_b as u128,
                    "otc: asset_b conservation"
                );

                // ---- Emit ν + leaves (fixed order; client + memos mirror it) ----
                nullifiers.push(m_nu);
                nullifiers.push(t_nu);
                leaves.push(leaf(&asset_a, &t_rv_cx, &t_rv_cy, &taker_owner)); // taker receives asset_a (v_a)
                leaves.push(leaf(&asset_b, &m_rv_cx, &m_rv_cy, &maker_owner)); // maker receives asset_b (v_b)
                if let Some((cx, cy, _, _, _)) = m_change {
                    leaves.push(leaf(&asset_a, &cx, &cy, &maker_owner));
                }
                if let Some((cx, cy, _, _, _)) = t_change {
                    leaves.push(leaf(&asset_b, &cx, &cy, &taker_owner));
                }
                if fee_a != 0 {
                    fees.push(FeePayment {
                        assetId: asset_a.into(),
                        value: U256::from(fee_a),
                    });
                }
                if fee_b != 0 {
                    fees.push(FeePayment {
                        assetId: asset_b.into(),
                        value: U256::from(fee_b),
                    });
                }
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
                assert!(
                    (max_fill - min_fill) % increment == 0,
                    "bid: grid not increment-aligned"
                );
                assert!(asset_a != asset_b, "bid: same asset");
                let buyer_owner = r32();

                // Buyer funding note (asset_b, value V_fund): membership + ν + cross-lane gate.
                let (fund_cx, fund_cy, fund_pt) = r_commitment();
                let fund_index: u64 = io::read();
                let fund_path = r_path();
                let fund_lf = leaf(&asset_b, &fund_cx, &fund_cy, &buyer_owner);
                assert!(
                    spend_root != [0u8; 32],
                    "bid: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&fund_lf, fund_index, &fund_path, &spend_root),
                    "bid: funding membership"
                );
                let fund_nu = nullifier(&fund_cx, &fund_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&fund_nu, &bitcoin_spent_root);
                }
                let fund_sig_r = decompress(&r33()).expect("bid: fund R");
                let fund_sig_z = scalar_reduce_be(&r32());

                // Chosen fill (on the grid) + the buyer's pre-signed received notes for it.
                let chosen_f: u64 = io::read();
                assert!(
                    chosen_f >= min_fill && chosen_f <= max_fill,
                    "bid: fill out of range"
                );
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
                assert!(
                    keccak_merkle_verify(&s_in_lf, s_in_index, &s_in_path, &spend_root),
                    "bid: seller membership"
                );
                let s_nu = nullifier(&s_in_cx, &s_in_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&s_nu, &bitcoin_spent_root);
                }
                let s_in_amount: u64 = io::read();
                let s_in_sig_r = decompress(&r33()).expect("bid: seller-in R");
                let s_in_sig_z = scalar_reduce_be(&r32());
                let s_has_change: u8 = io::read();
                let s_change = if s_has_change == 1 {
                    let (cx, cy, pt) = r_commitment();
                    let sr = decompress(&r33()).expect("bid: seller-change R");
                    let sz = scalar_reduce_be(&r32());
                    Some((cx, cy, pt, sr, sz))
                } else {
                    None
                };
                // Seller received (asset_b, value pay = chosen_f·price).
                let (s_rv_cx, s_rv_cy, s_rv_pt) = r_commitment();
                let s_rv_sig_r = decompress(&r33()).expect("bid: seller-recv R");
                let s_rv_sig_z = scalar_reduce_be(&r32());

                let s_change_amt: u64 = match s_change {
                    Some(_) => {
                        assert!(
                            s_in_amount > chosen_f,
                            "bid: seller change requires input > fill"
                        );
                        s_in_amount - chosen_f
                    }
                    None => {
                        assert!(
                            s_in_amount == chosen_f,
                            "bid: seller exact input required without change"
                        );
                        0
                    }
                };

                // Buyer context: PRE-SIGNED OFFLINE, so it binds only buyer-knowable data (the bid
                // terms + the buyer's funding/received notes + chosen_f) — never the seller's notes.
                let mut b_notes: Vec<([u8; 32], [u8; 32], [u8; 32])> =
                    vec![(fund_cx, fund_cy, buyer_owner), (ra_cx, ra_cy, buyer_owner)];
                if let Some((cx, cy, _, _, _)) = refund_note {
                    b_notes.push((cx, cy, buyer_owner));
                }
                let op_deadline: u64 = io::read(); // buyer's bid expiry, bound in their pre-signed sigma (per-op Expired)
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }
                // Relay fee (gasless privacy): the seller is the online filler, so it carves the fee from
                // its received payment `pay` (asset_b), paid to the settler (msg.sender). Bound in the
                // SELLER context below — the buyer's pre-signed offline sigma is untouched; fee = 0 ⇒ self-settle.
                let fee: u64 = io::read();
                assert!(fee < pay, "bid: fee >= seller payment");
                let buyer_ctx = intent_context(
                    b"tacit-bid-buyer-v1",
                    &chain_binding,
                    &asset_a,
                    &asset_b,
                    &b_notes,
                    &[min_fill, max_fill, price, increment, chosen_f, op_deadline],
                );
                assert!(
                    verify_opening_sigma(&fund_pt, v_fund, &fund_sig_r, &fund_sig_z, &buyer_ctx),
                    "bid: funding opening"
                );
                assert!(
                    verify_opening_sigma(&ra_pt, chosen_f, &ra_sig_r, &ra_sig_z, &buyer_ctx),
                    "bid: buyer-recv-a opening"
                );
                if let Some((_, _, pt, sr, sz)) = refund_note {
                    assert!(
                        verify_opening_sigma(&pt, refund, &sr, &sz, &buyer_ctx),
                        "bid: buyer-refund opening"
                    );
                }

                // Seller context: the seller is online, so it binds the seller's notes + chosen_f.
                let mut s_notes: Vec<([u8; 32], [u8; 32], [u8; 32])> =
                    vec![(s_in_cx, s_in_cy, s_owner), (s_rv_cx, s_rv_cy, s_owner)];
                if let Some((cx, cy, _, _, _)) = s_change {
                    s_notes.push((cx, cy, s_owner));
                }
                let seller_ctx = intent_context(
                    b"tacit-bid-seller-v1",
                    &chain_binding,
                    &asset_a,
                    &asset_b,
                    &s_notes,
                    &[chosen_f, price, fee],
                );
                assert!(
                    verify_opening_sigma(
                        &s_in_pt,
                        s_in_amount,
                        &s_in_sig_r,
                        &s_in_sig_z,
                        &seller_ctx
                    ),
                    "bid: seller-in opening"
                );
                assert!(
                    verify_opening_sigma(
                        &s_rv_pt,
                        pay - fee,
                        &s_rv_sig_r,
                        &s_rv_sig_z,
                        &seller_ctx
                    ),
                    "bid: seller-recv opening (net of relay fee)"
                );
                if let Some((_, _, pt, sr, sz)) = s_change {
                    assert!(
                        verify_opening_sigma(&pt, s_change_amt, &sr, &sz, &seller_ctx),
                        "bid: seller-change opening"
                    );
                }

                // Per-asset conservation.
                assert!(
                    v_fund as u128 == pay as u128 + refund as u128,
                    "bid: asset_b conservation"
                );
                assert!(
                    s_in_amount as u128 == chosen_f as u128 + s_change_amt as u128,
                    "bid: asset_a conservation"
                );

                // Emit ν + leaves (fixed order; client + memos mirror it).
                nullifiers.push(fund_nu);
                nullifiers.push(s_nu);
                leaves.push(leaf(&asset_a, &ra_cx, &ra_cy, &buyer_owner)); // buyer receives asset_a (chosen_f)
                leaves.push(leaf(&asset_b, &s_rv_cx, &s_rv_cy, &s_owner)); // seller receives asset_b (pay)
                if let Some((cx, cy, _, _, _)) = refund_note {
                    leaves.push(leaf(&asset_b, &cx, &cy, &buyer_owner));
                } // buyer refund
                if let Some((cx, cy, _, _, _)) = s_change {
                    leaves.push(leaf(&asset_a, &cx, &cy, &s_owner));
                } // seller change
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset_b.into(),
                        value: U256::from(fee),
                    });
                }
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
                // Relay fee (gasless privacy): carved in the INPUT asset and paid to the settler
                // (msg.sender), so a third party can relay the route and the trader never broadcasts from
                // their own address. fee = 0 ⇒ self-settle (no leg, identical to the fee-free path). The
                // fee is bound in the intent sigma below, so the box can neither pad it nor redirect it.
                let fee: u64 = io::read();
                assert!(fee < amount_in, "route: fee >= input");
                let in_sig_r = decompress(&r33()).expect("route: in sigma R");
                let in_sig_z = scalar_reduce_be(&r32());
                let n_hops: u32 = io::read();
                assert!(
                    n_hops >= 1 && n_hops <= MAX_ROUTE_HOPS,
                    "route: hop count out of range"
                );
                let min_out: u64 = io::read();
                let (out_cx, out_cy, out_pt) = r_commitment();
                let out_owner = r32();
                let out_sig_r = decompress(&r33()).expect("route: out sigma R");
                let out_sig_z = scalar_reduce_be(&r32());
                let op_deadline: u64 = io::read(); // bound in the trader's sigma (per-op Expired)
                if op_deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        op_deadline
                    } else {
                        min_deadline.min(op_deadline)
                    };
                }

                // Walk the hops: compute each pool's exact-in output, thread it into the next hop, and stage
                // a SwapSettlement per hop. Per-hop reserves are witnessed (the prover supplies the live
                // pre); the contract's pre==live gate + sequential application force them to be the real,
                // chained reserves — so the route can't settle against stale or fabricated pool state.
                let mut cur_asset = asset_0;
                let mut cur_amount: u64 = amount_in - fee; // route the post-fee input
                let mut hop_swaps: Vec<SwapSettlement> = Vec::with_capacity(n_hops as usize);
                for _ in 0..n_hops {
                    let asset_next = r32();
                    let fee_bps: u32 = io::read();
                    assert!(fee_bps <= 1000, "route hop fee over MAX_POOL_FEE_BPS"); // guard get_amount_out's 10000-fee_bps
                    let reserve_a_pre: u64 = io::read(); // CANONICAL reserves (low asset = reserveA)
                    let reserve_b_pre: u64 = io::read();
                    assert!(
                        cur_asset != asset_next,
                        "route: hop maps an asset to itself"
                    );
                    let pid = pool_id(&cur_asset, &asset_next, fee_bps);
                    // Orientation: the pool stores reserveA for the canonical-low asset. cur_is_lo ⇒ the
                    // flow is low→high (input is reserveA, output reserveB); else high→low. pool_id sorts
                    // internally, so the pid is identical either way — only the in/out mapping flips.
                    let cur_is_lo = bitcoin::be_bytes_lte(&cur_asset, &asset_next);
                    let (r_in, r_out) = if cur_is_lo {
                        (reserve_a_pre, reserve_b_pre)
                    } else {
                        (reserve_b_pre, reserve_a_pre)
                    };
                    assert!(r_in > 0 && r_out > 0, "route: hop pool not initialized");
                    let out = get_amount_out(cur_amount, r_in, r_out, fee_bps);
                    assert!(out > 0, "route: hop output rounds to zero");
                    let r_out_post = r_out as u128 - out; // out < r_out by the formula → no underflow, reserve stays > 0
                    let r_in_post = r_in as u128 + cur_amount as u128;
                    assert!(r_in_post <= u64::MAX as u128, "route: hop reserve overflow");
                    // Constant-product non-decrease (LP protection): (R_in+in)·(R_out−out) ≥ R_in·R_out.
                    assert!(
                        r_in_post * r_out_post >= r_in as u128 * r_out as u128,
                        "route: constant-product decreased"
                    );
                    let (reserve_a_post, reserve_b_post) = if cur_is_lo {
                        (r_in_post, r_out_post)
                    } else {
                        (r_out_post, r_in_post)
                    };
                    hop_swaps.push(SwapSettlement {
                        poolId: pid.into(),
                        reserveAPre: U256::from(reserve_a_pre),
                        reserveBPre: U256::from(reserve_b_pre),
                        reserveAPost: U256::from(reserve_a_post as u64),
                        reserveBPost: U256::from(reserve_b_post as u64),
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
                    b"tacit-route-intent-v1",
                    &chain_binding,
                    &asset_0,
                    &asset_final,
                    &[(in_cx, in_cy, in_owner), (out_cx, out_cy, out_owner)],
                    &[
                        amount_in,
                        amount_out,
                        min_out,
                        n_hops as u64,
                        op_deadline,
                        fee,
                    ],
                );

                // Spend the input note (membership + ν + cross-lane + opening binds amount_in).
                let in_lf = leaf(&asset_0, &in_cx, &in_cy, &in_owner);
                assert!(
                    spend_root != [0u8; 32],
                    "route: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&in_lf, in_leaf_index, &in_path, &spend_root),
                    "route: membership"
                );
                let nu = nullifier(&in_cx, &in_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&nu, &bitcoin_spent_root);
                }
                assert!(
                    verify_opening_sigma(&in_pt, amount_in, &in_sig_r, &in_sig_z, &ctx),
                    "route: input opening"
                );
                // The output note opens to the final amount_out (only the trader, who knows r_out, can spend it).
                assert!(
                    verify_opening_sigma(&out_pt, amount_out, &out_sig_r, &out_sig_z, &ctx),
                    "route: output opening"
                );

                nullifiers.push(nu);
                leaves.push(leaf(&asset_final, &out_cx, &out_cy, &out_owner));
                for s in hop_swaps {
                    swaps.push(s);
                }
                // Pay the relayer the input-asset fee (gasless privacy). asset_0 is a registered pool
                // asset (a note of it was just spent), so settle's _payout resolves it; the input note
                // opened to the gross amount_in, of which (amount_in − fee) entered the route above.
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset_0.into(),
                        value: U256::from(fee),
                    });
                }
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
                let locker = r32(); // == N's owner (authorizes the spend by opening N)
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
                assert!(
                    spend_root != [0u8; 32],
                    "adaptor-lock: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&n_lf, n_index, &n_path, &spend_root),
                    "adaptor-lock: N membership"
                );
                let n_nu = nullifier(&n_cx, &n_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&n_nu, &bitcoin_spent_root);
                }
                let n_sig_r = decompress(&r33()).expect("adaptor-lock: N-open R");
                let n_sig_z = scalar_reduce_be(&r32());
                // Locked note L (same asset, same value).
                let (l_cx, l_cy, l_pt) = r_commitment();
                let l_sig_r = decompress(&r33()).expect("adaptor-lock: L-open R");
                let l_sig_z = scalar_reduce_be(&r32());

                // Context binds the whole lock: N (locker), L (recipient), T, amount, deadline — so a relayer
                // can neither re-target the lock to a different recipient/T nor re-price it (the openings fail).
                if deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        deadline
                    } else {
                        min_deadline.min(deadline)
                    };
                }
                let ctx = intent_context(
                    b"tacit-adaptor-lock-intent-v1",
                    &chain_binding,
                    &asset,
                    &asset,
                    &[
                        (n_cx, n_cy, locker),
                        (l_cx, l_cy, recipient),
                        (tx, ty, [0u8; 32]),
                    ],
                    &[amount, deadline],
                );
                assert!(
                    verify_opening_sigma(&n_pt, amount, &n_sig_r, &n_sig_z, &ctx),
                    "adaptor-lock: N opening (spend authz + value)"
                );
                assert!(
                    verify_opening_sigma(&l_pt, amount, &l_sig_r, &l_sig_z, &ctx),
                    "adaptor-lock: L opening (value carry)"
                );

                // Effect: spend N; append L to the lock-set.
                nullifiers.push(n_nu);
                lock_leaves.push(adaptor_lock_leaf(
                    &asset, &l_cx, &l_cy, &tx, &ty, deadline, &recipient, &locker,
                ));
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
                // Lock-set membership reconstructs the EXACT leaf — so asset/recipient/T/deadline/locker are
                // pinned (neither a relayer nor the claimer can change them without breaking membership); the
                // output note below is minted in that same membership-pinned `asset`.
                let lock_lf = adaptor_lock_leaf(
                    &asset, &l_cx, &l_cy, &tx, &ty, deadline, &recipient, &locker,
                );
                assert!(
                    lock_set_root != [0u8; 32],
                    "adaptor-claim: membership requires a non-zero lock-set root"
                );
                assert!(
                    keccak_merkle_verify(&lock_lf, l_index, &l_path, &lock_set_root),
                    "adaptor-claim: L lock-set membership"
                );
                let l_nu = nullifier(&l_cx, &l_cy);

                // Output note → recipient (owner pinned by the membership-verified lock leaf; no redirect).
                let amount: u64 = io::read(); // prover-visible (kept out of PublicValues); == L's value by the kernel
                let (o_cx, o_cy, o_pt) = r_commitment();
                // Require an OPENING on O — the recipient proves they know its blinding for `amount`, symmetric
                // with the lock's N/L openings. This makes O a real recipient-controlled note (an output whose
                // blinding the recipient can't open is rejected). Since L's blinding is the locker's secret, a
                // valid kernel over (L_C − O_C) can then only be produced by completing the locker's T-adaptor
                // signature — so committing the kernel `s` below always reveals `t` (the cross-chain settlement
                // guarantee, not a worker convention).
                let o_sig_r = decompress(&r33()).expect("adaptor-claim: O-open R");
                let o_sig_z = scalar_reduce_be(&r32());
                let o_ctx = intent_context(
                    b"tacit-adaptor-claim-out-v1",
                    &chain_binding,
                    &asset,
                    &asset,
                    &[(o_cx, o_cy, recipient), (l_cx, l_cy, locker)],
                    &[amount, deadline],
                );
                assert!(
                    verify_opening_sigma(&o_pt, amount, &o_sig_r, &o_sig_z, &o_ctx),
                    "adaptor-claim: O opening (recipient controls the output)"
                );
                // Adaptor-completed kernel over (L_C − out_C): a valid kernel ⇒ out conserves L's value without
                // revealing it. `kernel_z` IS the completed signature `s` (committed for the t-reveal).
                let kernel_r = decompress(&r33()).expect("adaptor-claim: kernel R");
                let kernel_s = r32();
                let kernel_z = scalar_reduce_be(&kernel_s);
                assert!(
                    verify_kernel(&[l_pt], &[o_pt], &kernel_r, &kernel_z),
                    "adaptor-claim: value conservation"
                );

                // Claim window: bind the lock's deadline into the ≤ gate (settle must land before it).
                if deadline != 0 {
                    min_deadline = if min_deadline == 0 {
                        deadline
                    } else {
                        min_deadline.min(deadline)
                    };
                }

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
                let lock_lf = adaptor_lock_leaf(
                    &asset, &l_cx, &l_cy, &tx, &ty, deadline, &recipient, &locker,
                );
                assert!(
                    lock_set_root != [0u8; 32],
                    "adaptor-refund: membership requires a non-zero lock-set root"
                );
                assert!(
                    keccak_merkle_verify(&lock_lf, l_index, &l_path, &lock_set_root),
                    "adaptor-refund: L lock-set membership"
                );
                let l_nu = nullifier(&l_cx, &l_cy);

                let (o_cx, o_cy, o_pt) = r_commitment();
                // Bind the locked value before carving the relay fee. The adaptor lock leaf hides `amount`
                // (unlike the stealth lock leaf), so re-open L to its locked u64 value: verify_opening_sigma
                // forces `amount` to equal L's true value, and the u64 type bounds it below 2^64. Without this
                // the fee-bearing kernel (value(L) = value(O) + fee mod n) accepts ANY fee for a freely chosen
                // O — the locker knows r_O — paying out an unbacked `fee` at the public boundary. The opening
                // also re-proves the refunder knows L's blinding (only the locker can refund).
                let amount: u64 = io::read();
                let l_sig_r = decompress(&r33()).expect("adaptor-refund: L-open R");
                let l_sig_z = scalar_reduce_be(&r32());
                let refund_ctx = intent_context(
                    b"tacit-adaptor-refund-v1",
                    &chain_binding,
                    &asset,
                    &asset,
                    &[(l_cx, l_cy, locker), (o_cx, o_cy, locker)],
                    &[amount, deadline],
                );
                assert!(
                    verify_opening_sigma(&l_pt, amount, &l_sig_r, &l_sig_z, &refund_ctx),
                    "adaptor-refund: L opening (locked-value bind)"
                );
                // Relay fee (gasless privacy): the locker reclaims its locked note net of a fee paid to the
                // settler (msg.sender) — safe here because REFUND reveals no `s` (no t-reveal), so the kernel
                // is plain conservation L = O + fee. fee = 0 ⇒ the fee-free refund. (CLAIM cannot do this: its
                // kernel IS the t-reveal channel and must stay zero-value, so a claim is relayed fee-less and
                // the recipient pays via the funded follow-up spend of the claimed note.)
                let fee: u64 = io::read();
                assert!(fee < amount, "adaptor-refund: fee >= locked amount");
                let kernel_r = decompress(&r33()).expect("adaptor-refund: kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee(&[l_pt], &[o_pt], fee, &kernel_r, &kernel_z),
                    "adaptor-refund: value conservation"
                );

                // Refund window: the contract requires block.timestamp >= the LATEST refund deadline in the batch.
                assert!(deadline != 0, "adaptor-refund: deadline required");
                refund_not_before = refund_not_before.max(deadline);

                lock_nullifiers.push(l_nu);
                leaves.push(leaf(&asset, &o_cx, &o_cy, &locker));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
            }
            OP_CDP_MINT => {
                // Open a CDP: lock a BASKET of collateral notes into a controller-bound position and mint a
                // controller-derived debt note. The guest enforces STRUCTURE + conservation only — each leg
                // note is spent + opens to its PUBLIC value, the debt note opens to the PUBLIC debt value;
                // the contract calls controller.onCdpMint(legs, debtValue) for the pricing/ratio policy
                // (revert = deny). The debt asset = derive(controller) so the controller is its sole minter.
                // Owner stays confidential; only the boundary amounts are public (like wrap/withdraw).
                let controller = r20();
                let owner = r32();
                let debt_value: u64 = io::read();
                let nonce = r32();
                // The controller's debt-accumulator snapshot at mint (RAY-scaled, 32B BE). Committed into the
                // position leaf + surfaced; the controller checks it (cUSD CDP: snapshot ∈ [RAY, rate]). 0 for
                // fee-free controllers (farms). The guest does NO rate math — it carries the value.
                let rate_snapshot = r32();
                let n_legs: u32 = io::read();
                // SPEC-CONTROLLER-VAULT-AMENDMENT §§1-2: relax the two anti-bloat asserts so one op serves three
                // shapes. `debt_value == 0` ⇒ a BOND (lock the basket into a controller position, mint NO debt
                // note — for farms/staking/vesting). `n_legs == 0` ⇒ a PAYOUT (mint the controller token to a
                // recipient, no collateral, no position — positionLeaf = 0). The normal CDP (both > 0) is
                // unchanged. Both zero is an empty op — rejected.
                assert!(
                    debt_value > 0 || n_legs > 0,
                    "cdp-mint: empty op (zero debt and empty basket)"
                );
                assert!(n_legs <= MAX_ITEMS_PER_OP, "cdp-mint: basket over cap");
                if n_legs > 0 {
                    assert!(
                        spend_root != [0u8; 32],
                        "cdp-mint: membership requires a non-zero spend root"
                    );
                    // A real CDP position MUST use nonce 0: the FRESH per-position `owner` alone makes the leaf
                    // unique, and a keeper reconstructs the leaf assuming nonce 0. Forbidding a custom nonce
                    // keeps EVERY position liquidatable — a nonzero nonce would hide the leaf preimage from
                    // keepers (only `owner` is published), creating un-liquidatable bad debt.
                    assert!(nonce == [0u8; 32], "cdp-mint: position nonce must be 0 (keeper-liquidatable)");
                    // The position is closed via an `owner` BIP-340 signature (OP_CDP_CLOSE), so `owner` MUST
                    // be a valid x-only pubkey — else the position would be un-closeable (collateral locked
                    // until liquidation). Reject a non-curve owner at mint (fail-fast over locked funds).
                    let mut owner_comp = [2u8; 33];
                    owner_comp[1..].copy_from_slice(&owner);
                    decompress(&owner_comp).expect("cdp-mint: owner is not a valid x-only pubkey");
                }
                let mut leg_hashes: Vec<[u8; 32]> = Vec::with_capacity(n_legs as usize);
                let mut legs_pv: Vec<CdpLeg> = Vec::with_capacity(n_legs as usize);
                // Canonical basket: legs strictly asset-sorted (so basket_root is order-independent + no
                // duplicate asset — a controller can price each asset once, no aggregation ambiguity) and
                // every leg value > 0. asset ids are SHA256 (never 0), so > [0;32] holds for the first leg.
                let mut prev_asset = [0u8; 32];
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);
                for _ in 0..n_legs {
                    let asset = r32();
                    assert!(
                        asset > prev_asset,
                        "cdp-mint: basket legs must be strictly asset-sorted (no dups)"
                    );
                    prev_asset = asset;
                    let (cx, cy, pt) = r_commitment();
                    let value: u64 = io::read();
                    assert!(value > 0, "cdp-mint: zero-value collateral leg");
                    let index: u64 = io::read();
                    let path = r_path();
                    let sig_r = decompress(&r33()).expect("cdp-mint: collateral sigma R");
                    let sig_z = scalar_reduce_be(&r32());
                    // spend the collateral note (owned by `owner`): membership + value opening + ν + cross-lane
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(
                        keccak_merkle_verify(&lf, index, &path, &spend_root),
                        "cdp-mint: collateral membership"
                    );
                    let ctx = intent_context(
                        b"tacit-cdp-mint-collateral-v1",
                        &chain_binding,
                        &asset,
                        &nonce,
                        // bind rate_snapshot (the controller's debt-accumulator snapshot) so a delegated
                        // prover can't substitute a stale low snapshot — overcharging the borrower once a
                        // stability fee is armed (owed = principal·rate/snapshot). Carried as a synthetic
                        // note tuple (mirrors controller32); the engine still accepts [RAY, rate] for drip.
                        &[(cx, cy, owner), (controller32, nonce, owner), (rate_snapshot, nonce, owner)],
                        &[value, debt_value, index],
                    );
                    assert!(
                        verify_opening_sigma(&pt, value, &sig_r, &sig_z, &ctx),
                        "cdp-mint: collateral opening sigma"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    nullifiers.push(nu);
                    leg_hashes.push(cdp_basket_leg(&asset, value));
                    legs_pv.push(CdpLeg {
                        asset: asset.into(),
                        value: U256::from(value),
                    });
                }
                // mint the debt/payout note (asset = derive(controller)), owned by `owner`, opening to
                // debt_value − fee — SKIPPED for a bond (debt_value == 0 mints nothing; the basket is locked unpriced).
                let debt_asset = cdp_debt_asset_id(&controller);
                // Relay fee (gasless privacy): carved from the minted debt note. The position records the GROSS
                // debt_value (the controller's health check is on that), the user's note opens to debt_value − fee,
                // and the settler (msg.sender) is paid `fee` in the debt asset. fee = 0 ⇒ self-settle; a bond
                // (debt_value == 0) has no debt note, so fee must be 0. Bound in the debt sigma context.
                let fee: u64 = io::read();
                if debt_value > 0 {
                    assert!(fee < debt_value, "cdp-mint: fee >= debt");
                    let (d_cx, d_cy, d_pt) = r_commitment();
                    let d_sig_r = decompress(&r33()).expect("cdp-mint: debt sigma R");
                    let d_sig_z = scalar_reduce_be(&r32());
                    let debt_ctx = intent_context(
                        b"tacit-cdp-mint-debt-v1",
                        &chain_binding,
                        &debt_asset,
                        &nonce,
                        // bind rate_snapshot here too (shared by OP_CDP_MINT + OP_WRAP_CDP_MINT debt legs).
                        &[(d_cx, d_cy, owner), (controller32, nonce, owner), (rate_snapshot, nonce, owner)],
                        &[debt_value, fee],
                    );
                    assert!(
                        verify_opening_sigma(
                            &d_pt,
                            debt_value - fee,
                            &d_sig_r,
                            &d_sig_z,
                            &debt_ctx
                        ),
                        "cdp-mint: debt opening sigma (net of relay fee)"
                    );
                    leaves.push(leaf(&debt_asset, &d_cx, &d_cy, &owner));
                    if fee != 0 {
                        fees.push(FeePayment {
                            assetId: debt_asset.into(),
                            value: U256::from(fee),
                        });
                    }
                } else {
                    assert!(fee == 0, "cdp-mint: fee requires a debt note");
                }
                // the position leaf the contract appends to its position set (CLOSE/LIQUIDATE prove against it),
                // or the `0` sentinel for a PAYOUT (n_legs == 0 ⇒ no position; the pool skips the insert).
                let position_leaf = if n_legs > 0 {
                    let basket_root = cdp_basket_root(&leg_hashes);
                    cdp_position_leaf(
                        &controller,
                        &debt_asset,
                        &basket_root,
                        debt_value,
                        &rate_snapshot,
                        &owner,
                        &nonce,
                    )
                } else {
                    [0u8; 32]
                };
                cdp_mints.push(CdpMint {
                    controller: Address::from(controller),
                    debtAsset: debt_asset.into(),
                    debtValue: U256::from(debt_value),
                    positionLeaf: position_leaf.into(),
                    rateSnapshot: U256::from_be_slice(&rate_snapshot),
                    legs: legs_pv,
                    owner: owner.into(),
                });
            }
            OP_WRAP_CDP_MINT => {
                // 1-click cUSD: consume pending PUBLIC deposit(s) as the collateral basket and mint a
                // confidential CDP debt note (cUSD) in ONE settle — OP_CDP_MINT with deposit-collateral
                // instead of tree notes (mirrors OP_WRAP_TRANSFER's wrap-and-X pattern). Each collateral leg
                // is a pending deposit: bound by the SAME wrap opening-sigma + deposit_id the contract created
                // at wrap (owner-pinned by the deposit commit), consumed once (pv.deposits dedup-gated). The
                // debt-note mint, position leaf, and controller CdpMint are byte-identical to OP_CDP_MINT, so
                // the controller's pricing/ratio policy (onCdpMint) is unchanged. No contract change.
                let controller = r20();
                let owner = r32();
                let debt_value: u64 = io::read();
                assert!(debt_value > 0, "wrap-cdp-mint: zero debt (use OP_WRAP_TRANSFER for a pure deposit)");
                let nonce = r32();
                assert!(nonce == [0u8; 32], "wrap-cdp-mint: position nonce must be 0 (keeper-liquidatable)");
                // owner closes the position via a BIP-340 sig (OP_CDP_CLOSE) → must be a valid x-only pubkey.
                {
                    let mut owner_comp = [2u8; 33];
                    owner_comp[1..].copy_from_slice(&owner);
                    decompress(&owner_comp).expect("wrap-cdp-mint: owner is not a valid x-only pubkey");
                }
                let rate_snapshot = r32();
                let n_legs: u32 = io::read();
                assert!(n_legs > 0 && n_legs <= MAX_ITEMS_PER_OP, "wrap-cdp-mint: basket count");
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);

                let mut leg_hashes: Vec<[u8; 32]> = Vec::with_capacity(n_legs as usize);
                let mut legs_pv: Vec<CdpLeg> = Vec::with_capacity(n_legs as usize);
                let mut prev_asset = [0u8; 32];
                for i in 0..n_legs {
                    let asset = r32();
                    if i > 0 {
                        assert!(
                            bitcoin::be_bytes_lte(&prev_asset, &asset) && prev_asset != asset,
                            "wrap-cdp-mint: basket legs must be strictly asset-sorted (no dups)"
                        );
                    }
                    prev_asset = asset;
                    let value: u64 = io::read();
                    assert!(value > 0, "wrap-cdp-mint: zero-value collateral leg");
                    let (cx, cy, c) = r_commitment();
                    let sig_r = decompress(&r33()).expect("wrap-cdp-mint: collateral sigma R");
                    let sig_z = scalar_reduce_be(&r32());
                    // Consume the pending deposit (owner-pinned by the deposit commit). The collateral
                    // authorization MUST be op- and CDP-intent-specific — never the plain `tacit-wrap-intent-v1`
                    // context, or a depositor's plain-wrap opening sigma could be replayed to lock their deposit
                    // into an attacker-chosen CDP. Bind the op tag + controller + position nonce + debt_value
                    // (mirrors OP_CDP_MINT's collateral context), so the sigma authorizes THIS CDP and no other.
                    let dep_id =
                        deposit_id(&asset, &u64_be32(value), &deposit_commit(&cx, &cy, &owner));
                    let ctx = intent_context(
                        b"tacit-wrap-cdp-mint-collateral-v1",
                        &chain_binding,
                        &asset,
                        &dep_id,
                        // bind rate_snapshot (see OP_CDP_MINT) so the box can't substitute a stale snapshot.
                        &[(cx, cy, owner), (controller32, nonce, owner), (rate_snapshot, nonce, owner)],
                        &[value, debt_value],
                    );
                    assert!(
                        verify_opening_sigma(&c, value, &sig_r, &sig_z, &ctx),
                        "wrap-cdp-mint: collateral opening sigma"
                    );
                    deposits.push(dep_id);
                    leg_hashes.push(cdp_basket_leg(&asset, value));
                    legs_pv.push(CdpLeg {
                        asset: asset.into(),
                        value: U256::from(value),
                    });
                }

                // Mint the debt (cUSD) note — identical to OP_CDP_MINT (owned by `owner`, opens to
                // debt_value − fee; the relay fee is carved from the minted debt note).
                let debt_asset = cdp_debt_asset_id(&controller);
                let fee: u64 = io::read();
                assert!(fee < debt_value, "wrap-cdp-mint: fee >= debt");
                let (d_cx, d_cy, d_pt) = r_commitment();
                let d_sig_r = decompress(&r33()).expect("wrap-cdp-mint: debt sigma R");
                let d_sig_z = scalar_reduce_be(&r32());
                let debt_ctx = intent_context(
                    b"tacit-cdp-mint-debt-v1",
                    &chain_binding,
                    &debt_asset,
                    &nonce,
                    // bind rate_snapshot (byte-identical to OP_CDP_MINT's debt context above).
                    &[(d_cx, d_cy, owner), (controller32, nonce, owner), (rate_snapshot, nonce, owner)],
                    &[debt_value, fee],
                );
                assert!(
                    verify_opening_sigma(&d_pt, debt_value - fee, &d_sig_r, &d_sig_z, &debt_ctx),
                    "wrap-cdp-mint: debt opening sigma (net of relay fee)"
                );
                leaves.push(leaf(&debt_asset, &d_cx, &d_cy, &owner));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: debt_asset.into(),
                        value: U256::from(fee),
                    });
                }

                let basket_root = cdp_basket_root(&leg_hashes);
                let position_leaf = cdp_position_leaf(
                    &controller,
                    &debt_asset,
                    &basket_root,
                    debt_value,
                    &rate_snapshot,
                    &owner,
                    &nonce,
                );
                cdp_mints.push(CdpMint {
                    controller: Address::from(controller),
                    debtAsset: debt_asset.into(),
                    debtValue: U256::from(debt_value),
                    positionLeaf: position_leaf.into(),
                    rateSnapshot: U256::from_be_slice(&rate_snapshot),
                    legs: legs_pv,
                    owner: owner.into(),
                });
            }
            OP_CDP_CLOSE => {
                // Close a CDP (unconditional — NO oracle/controller veto): reproduce the position leaf from
                // the revealed legs + fields, prove it ∈ cdp_position_root, burn debt notes (asset =
                // derive(controller)) summing to EXACTLY the position debt, and re-mint each leg as a FRESH
                // note opening to its recorded value, owned by the position owner. The contract dedups the
                // position ν and calls controller.onCdpClose to decrement its outstanding debt.
                let controller = r20();
                let owner = r32();
                let debt_value: u64 = io::read();
                let nonce = r32();
                let rate_snapshot = r32(); // the position's mint-time accumulator snapshot (carried in the leaf)
                let position_index: u64 = io::read();
                let position_path = r_path();
                let n_legs: u32 = io::read();
                assert!(n_legs > 0, "cdp-close: empty basket");
                assert!(n_legs <= MAX_ITEMS_PER_OP, "cdp-close: basket over cap");
                // Relay fee (gasless privacy): carved from the FIRST released collateral leg — the user gets
                // back value[0] − fee, the settler (msg.sender) is paid `fee` in that leg's asset, and the
                // basket membership + controller still use the GROSS value. fee = 0 ⇒ self-settle.
                let fee: u64 = io::read();
                assert!(
                    spend_root != [0u8; 32],
                    "cdp-close: membership requires a non-zero spend root"
                );
                let mut leg_hashes: Vec<[u8; 32]> = Vec::with_capacity(n_legs as usize);
                let mut legs_pv: Vec<CdpLeg> = Vec::with_capacity(n_legs as usize);
                let mut released: Vec<([u8; 32], u64, [u8; 32], [u8; 32], Point, Point, [u8; 32])> =
                    Vec::with_capacity(n_legs as usize);
                for _ in 0..n_legs {
                    let asset = r32();
                    let value: u64 = io::read();
                    // re-mint a FRESH collateral note to the owner, opening to the recorded value
                    let (cx, cy, pt) = r_commitment();
                    let sig_r = decompress(&r33()).expect("cdp-close: released-leg sigma R");
                    let sig_z = r32();
                    released.push((asset, value, cx, cy, pt, sig_r, sig_z));
                    leg_hashes.push(cdp_basket_leg(&asset, value));
                    legs_pv.push(CdpLeg {
                        asset: asset.into(),
                        value: U256::from(value),
                    });
                }
                // reconstruct + prove position membership
                let debt_asset = cdp_debt_asset_id(&controller);
                let basket_root = cdp_basket_root(&leg_hashes);
                let position_leaf = cdp_position_leaf(
                    &controller,
                    &debt_asset,
                    &basket_root,
                    debt_value,
                    &rate_snapshot,
                    &owner,
                    &nonce,
                );
                assert!(
                    cdp_position_root != [0u8; 32],
                    "cdp-close: membership requires a non-zero position root"
                );
                assert!(
                    keccak_merkle_verify(
                        &position_leaf,
                        position_index,
                        &position_path,
                        &cdp_position_root
                    ),
                    "cdp-close: position membership"
                );
                // CDP-CLOSE-OWNER-001: a voluntary close has NO controller health veto, and the position leaf
                // + its `owner` are PUBLIC (emitted by CdpMint). Without owner consent anyone could reconstruct
                // the leaf, repay the (public) debt, and re-mint the collateral as bearer notes whose blinding
                // THEY chose — stealing the owner's equity. Require a BIP-340 signature under `owner` (an
                // x-only pubkey) binding the chain, this exact position, and the released commitments (so a
                // relayer can't redirect the reclaimed collateral). Liquidation stays permissionless (the
                // controller's health check is its gate); only voluntary close needs the owner's signature.
                let mut owner_sig = [0u8; 64];
                owner_sig[..32].copy_from_slice(&r32());
                owner_sig[32..].copy_from_slice(&r32());
                let mut released_bytes: Vec<u8> = Vec::with_capacity(released.len() * 96 + 8);
                for (asset, value, cx, cy, _pt, _sr, _sz) in &released {
                    released_bytes.extend_from_slice(asset);
                    released_bytes.extend_from_slice(&value.to_be_bytes());
                    released_bytes.extend_from_slice(cx);
                    released_bytes.extend_from_slice(cy);
                }
                released_bytes.extend_from_slice(&fee.to_be_bytes());
                let close_msg = cdp_close_msg(&chain_binding, &position_leaf, &released_bytes);
                assert!(
                    bip340_verify(&owner_sig, &close_msg, &owner),
                    "cdp-close: owner BIP-340 authorization (only the position owner may voluntarily close)"
                );
                for (i, (asset, value, cx, cy, pt, sig_r, sig_z)) in
                    released.into_iter().enumerate()
                {
                    let sig_z = scalar_reduce_be(&sig_z);
                    // The first leg carries the op's relay fee: it opens to value − fee (the others open to
                    // their full value). The fee is bound in this leg's context so the box can't pad it.
                    let leg_fee = if i == 0 { fee } else { 0 };
                    assert!(
                        leg_fee == 0 || leg_fee < value,
                        "cdp-close: fee >= leg value"
                    );
                    let ctx = intent_context(
                        b"tacit-cdp-close-release-v1",
                        &chain_binding,
                        &asset,
                        &position_leaf,
                        &[(cx, cy, owner)],
                        &[value, leg_fee],
                    );
                    assert!(
                        verify_opening_sigma(&pt, value - leg_fee, &sig_r, &sig_z, &ctx),
                        "cdp-close: released-leg opening sigma"
                    );
                    leaves.push(leaf(&asset, &cx, &cy, &owner));
                    if leg_fee != 0 {
                        fees.push(FeePayment {
                            assetId: asset.into(),
                            value: U256::from(leg_fee),
                        });
                    }
                }
                // burn debt notes (any holders) summing to EXACTLY the position debt
                let n_debt: u32 = io::read();
                assert!(
                    n_debt > 0 && n_debt <= MAX_ITEMS_PER_OP,
                    "cdp-close: debt input count out of range"
                );
                let mut repaid: u128 = 0;
                for _ in 0..n_debt {
                    let (cx, cy, pt) = r_commitment();
                    let d_owner = r32();
                    let value: u64 = io::read();
                    let index: u64 = io::read();
                    let path = r_path();
                    let sig_r = decompress(&r33()).expect("cdp-close: debt sigma R");
                    let sig_z = scalar_reduce_be(&r32());
                    let lf = leaf(&debt_asset, &cx, &cy, &d_owner);
                    assert!(
                        keccak_merkle_verify(&lf, index, &path, &spend_root),
                        "cdp-close: debt membership"
                    );
                    let ctx = intent_context(
                        b"tacit-cdp-close-debt-v1",
                        &chain_binding,
                        &debt_asset,
                        &position_leaf,
                        &[(cx, cy, d_owner)],
                        &[value, debt_value, index],
                    );
                    assert!(
                        verify_opening_sigma(&pt, value, &sig_r, &sig_z, &ctx),
                        "cdp-close: debt opening sigma"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    nullifiers.push(nu);
                    repaid += value as u128;
                }
                // Floor only: the burn must cover at least the principal. The controller enforces the EXACT
                // accrued debt (principal · rate / rate_snapshot ≥ principal) against `repaid` — keeping the
                // fee arithmetic in the auditable engine, not the guest. Dormant: accrued == principal, so the
                // engine pins repaid == debt_value (the original exact-debt close).
                assert!(
                    repaid >= debt_value as u128,
                    "cdp-close: repayment below principal"
                );
                cdp_closes.push(CdpClose {
                    controller: Address::from(controller),
                    debtValue: U256::from(debt_value),
                    repaid: U256::from(repaid),
                    rateSnapshot: U256::from_be_slice(&rate_snapshot),
                    positionNullifier: cdp_position_nullifier(&position_leaf).into(),
                    legs: legs_pv,
                });
            }
            OP_CDP_LIQUIDATE => {
                // Liquidate a CDP atomically: reproduce the position leaf, prove it ∈ cdp_position_root, burn
                // controller-derived debt notes summing to EXACTLY the position debt, and SEIZE the basket by
                // WITHDRAWING each leg's value to the liquidator. The contract still calls
                // controller.onCdpLiquidate(legs, debtValue), which proves (its oracle) the position is
                // undercollateralized and reverts if healthy. No async buy-and-burn remains: the debt is
                // retired inside this proof before collateral can leave.
                let controller = r20();
                let owner = r32();
                let debt_value: u64 = io::read();
                let nonce = r32();
                let rate_snapshot = r32(); // the position's mint-time accumulator snapshot (carried in the leaf)
                let liquidator = r20();
                let position_index: u64 = io::read();
                let position_path = r_path();
                let n_legs: u32 = io::read();
                assert!(n_legs > 0, "cdp-liquidate: empty basket");
                assert!(n_legs <= MAX_ITEMS_PER_OP, "cdp-liquidate: basket over cap");
                assert!(
                    spend_root != [0u8; 32],
                    "cdp-liquidate: debt membership requires a non-zero spend root"
                );
                // Optional relay fee, carved from the FIRST seized leg and paid to the settler (msg.sender) as
                // a public FeePayment — so a GASLESS keeper can have the box settle the liquidation (relayed),
                // exactly like OP_CDP_CLOSE. The basket MEMBERSHIP (basket_root) + the controller's health
                // check use the GROSS leg values; only the liquidator's withdrawal of leg 0 is net of the fee.
                // fee = 0 ⇒ a self-settling keeper takes the whole basket (read after n_legs, mirroring close).
                let fee: u64 = io::read();
                let liquidator_addr = Address::from(liquidator);
                let mut leg_hashes: Vec<[u8; 32]> = Vec::with_capacity(n_legs as usize);
                let mut legs_pv: Vec<CdpLeg> = Vec::with_capacity(n_legs as usize);
                for i in 0..n_legs {
                    let asset = r32();
                    let value: u64 = io::read();
                    leg_hashes.push(cdp_basket_leg(&asset, value));
                    legs_pv.push(CdpLeg {
                        asset: asset.into(),
                        value: U256::from(value),
                    });
                    // seize: withdraw the leg's value to the liquidator (the value is bound by the basket root).
                    // The first leg carries the relay fee: liquidator gets value − fee, the settler gets fee.
                    let leg_fee = if i == 0 { fee } else { 0 };
                    assert!(leg_fee < value, "cdp-liquidate: fee >= first seized leg");
                    withdrawals.push(Withdrawal {
                        assetId: asset.into(),
                        recipient: liquidator_addr,
                        value: U256::from(value - leg_fee),
                    });
                    if leg_fee != 0 {
                        fees.push(FeePayment {
                            assetId: asset.into(),
                            value: U256::from(leg_fee),
                        });
                    }
                }
                let debt_asset = cdp_debt_asset_id(&controller);
                let basket_root = cdp_basket_root(&leg_hashes);
                let position_leaf = cdp_position_leaf(
                    &controller,
                    &debt_asset,
                    &basket_root,
                    debt_value,
                    &rate_snapshot,
                    &owner,
                    &nonce,
                );
                assert!(
                    cdp_position_root != [0u8; 32],
                    "cdp-liquidate: membership requires a non-zero position root"
                );
                assert!(
                    keccak_merkle_verify(
                        &position_leaf,
                        position_index,
                        &position_path,
                        &cdp_position_root
                    ),
                    "cdp-liquidate: position membership"
                );
                let n_debt: u32 = io::read();
                assert!(
                    n_debt > 0 && n_debt <= MAX_ITEMS_PER_OP,
                    "cdp-liquidate: debt input count out of range"
                );
                let mut repaid: u128 = 0;
                for _ in 0..n_debt {
                    let (cx, cy, pt) = r_commitment();
                    let d_owner = r32();
                    let value: u64 = io::read();
                    let index: u64 = io::read();
                    let path = r_path();
                    let sig_r = decompress(&r33()).expect("cdp-liquidate: debt sigma R");
                    let sig_z = scalar_reduce_be(&r32());
                    let lf = leaf(&debt_asset, &cx, &cy, &d_owner);
                    assert!(
                        keccak_merkle_verify(&lf, index, &path, &spend_root),
                        "cdp-liquidate: debt membership"
                    );
                    let ctx = intent_context(
                        b"tacit-cdp-liquidate-debt-v1",
                        &chain_binding,
                        &debt_asset,
                        &position_leaf,
                        &[(cx, cy, d_owner)],
                        &[value, debt_value, index],
                    );
                    assert!(
                        verify_opening_sigma(&pt, value, &sig_r, &sig_z, &ctx),
                        "cdp-liquidate: debt opening sigma"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    nullifiers.push(nu);
                    repaid += value as u128;
                }
                // Floor only — the controller enforces the exact accrued debt against `repaid` and gates health
                // against it (a fee-eroded position becomes seizable). Dormant: accrued == principal.
                assert!(
                    repaid >= debt_value as u128,
                    "cdp-liquidate: repayment below principal"
                );
                cdp_liquidations.push(CdpLiquidate {
                    controller: Address::from(controller),
                    debtValue: U256::from(debt_value),
                    repaid: U256::from(repaid),
                    rateSnapshot: U256::from_be_slice(&rate_snapshot),
                    positionNullifier: cdp_position_nullifier(&position_leaf).into(),
                    legs: legs_pv,
                });
            }
            OP_CDP_TOPUP => {
                // Top up a CDP without changing its debt: reproduce the OLD position, prove it ∈ the
                // position set, spend fresh collateral notes, and append a replacement position with the same
                // debt and a strictly larger canonical basket. No debt note is minted or burned; the contract
                // consumes the old position ν, appends `new_position_leaf`, and asks the controller to approve
                // the replacement health. This is the Maker-style rescue path without introducing mutable
                // in-place position state.
                let controller = r20();
                let owner = r32();
                let debt_value: u64 = io::read();
                assert!(debt_value > 0, "cdp-topup: zero debt");
                let old_nonce = r32();
                let new_nonce = r32();
                // Positions are nonce-0 by construction (OP_CDP_MINT enforces it; the fresh `owner` gives the
                // leaf its uniqueness). Pin BOTH the old and the replacement leaf to nonce 0 so the topped-up
                // position stays keeper-reconstructable — a nonzero replacement nonce would hide the leaf
                // preimage from keepers (only `owner` is published), creating un-liquidatable bad debt.
                assert!(old_nonce == [0u8; 32], "cdp-topup: old position nonce must be 0");
                assert!(new_nonce == [0u8; 32], "cdp-topup: replacement nonce must be 0 (keeper-liquidatable)");
                // Carried forward UNCHANGED into the replacement leaf: a top-up adds collateral, it does not
                // settle accrued interest. Old-leaf membership pins it to the genuine mint snapshot.
                let rate_snapshot = r32();
                let position_index: u64 = io::read();
                let position_path = r_path();
                let n_old_legs: u32 = io::read();
                assert!(n_old_legs > 0, "cdp-topup: empty old basket");
                assert!(
                    n_old_legs <= MAX_ITEMS_PER_OP,
                    "cdp-topup: old basket over cap"
                );

                let mut old_leg_hashes: Vec<[u8; 32]> = Vec::with_capacity(n_old_legs as usize);
                let mut old_legs_raw: Vec<([u8; 32], u64)> =
                    Vec::with_capacity(n_old_legs as usize);
                let mut old_legs_pv: Vec<CdpLeg> = Vec::with_capacity(n_old_legs as usize);
                let mut prev_asset = [0u8; 32];
                for _ in 0..n_old_legs {
                    let asset = r32();
                    assert!(
                        asset > prev_asset,
                        "cdp-topup: old basket legs must be strictly asset-sorted"
                    );
                    prev_asset = asset;
                    let value: u64 = io::read();
                    assert!(value > 0, "cdp-topup: zero-value old collateral leg");
                    old_leg_hashes.push(cdp_basket_leg(&asset, value));
                    old_legs_raw.push((asset, value));
                    old_legs_pv.push(CdpLeg {
                        asset: asset.into(),
                        value: U256::from(value),
                    });
                }

                let debt_asset = cdp_debt_asset_id(&controller);
                let old_basket_root = cdp_basket_root(&old_leg_hashes);
                let old_position_leaf = cdp_position_leaf(
                    &controller,
                    &debt_asset,
                    &old_basket_root,
                    debt_value,
                    &rate_snapshot,
                    &owner,
                    &old_nonce,
                );
                assert!(
                    cdp_position_root != [0u8; 32],
                    "cdp-topup: membership requires a non-zero position root"
                );
                assert!(
                    keccak_merkle_verify(
                        &old_position_leaf,
                        position_index,
                        &position_path,
                        &cdp_position_root
                    ),
                    "cdp-topup: position membership",
                );

                let n_added_legs: u32 = io::read();
                assert!(n_added_legs > 0, "cdp-topup: empty added basket");
                assert!(
                    n_added_legs <= MAX_ITEMS_PER_OP,
                    "cdp-topup: added basket over cap"
                );
                assert!(
                    spend_root != [0u8; 32],
                    "cdp-topup: membership requires a non-zero spend root"
                );
                let mut added_legs_raw: Vec<([u8; 32], u64)> =
                    Vec::with_capacity(n_added_legs as usize);
                prev_asset = [0u8; 32];
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);
                for _ in 0..n_added_legs {
                    let asset = r32();
                    assert!(
                        asset > prev_asset,
                        "cdp-topup: added legs must be strictly asset-sorted"
                    );
                    prev_asset = asset;
                    let (cx, cy, pt) = r_commitment();
                    let value: u64 = io::read();
                    assert!(value > 0, "cdp-topup: zero-value added collateral leg");
                    let index: u64 = io::read();
                    let path = r_path();
                    let sig_r = decompress(&r33()).expect("cdp-topup: collateral sigma R");
                    let sig_z = scalar_reduce_be(&r32());
                    let lf = leaf(&asset, &cx, &cy, &owner);
                    assert!(
                        keccak_merkle_verify(&lf, index, &path, &spend_root),
                        "cdp-topup: collateral membership"
                    );
                    let ctx = intent_context(
                        b"tacit-cdp-topup-collateral-v1",
                        &chain_binding,
                        &asset,
                        &old_position_leaf,
                        &[(cx, cy, owner), (controller32, new_nonce, owner)],
                        &[value, debt_value, index],
                    );
                    assert!(
                        verify_opening_sigma(&pt, value, &sig_r, &sig_z, &ctx),
                        "cdp-topup: collateral opening sigma"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    nullifiers.push(nu);
                    added_legs_raw.push((asset, value));
                }

                let new_legs_raw = merge_cdp_legs(&old_legs_raw, &added_legs_raw);
                assert!(
                    new_legs_raw.len() <= MAX_ITEMS_PER_OP as usize,
                    "cdp-topup: replacement basket over cap"
                );
                let mut new_leg_hashes: Vec<[u8; 32]> = Vec::with_capacity(new_legs_raw.len());
                let mut new_legs_pv: Vec<CdpLeg> = Vec::with_capacity(new_legs_raw.len());
                for (asset, value) in new_legs_raw {
                    new_leg_hashes.push(cdp_basket_leg(&asset, value));
                    new_legs_pv.push(CdpLeg {
                        asset: asset.into(),
                        value: U256::from(value),
                    });
                }
                let new_basket_root = cdp_basket_root(&new_leg_hashes);
                let new_position_leaf = cdp_position_leaf(
                    &controller,
                    &debt_asset,
                    &new_basket_root,
                    debt_value,
                    &rate_snapshot,
                    &owner,
                    &new_nonce,
                );
                cdp_topups.push(CdpTopup {
                    controller: Address::from(controller),
                    debtValue: U256::from(debt_value),
                    rateSnapshot: U256::from_be_slice(&rate_snapshot),
                    oldPositionNullifier: cdp_position_nullifier(&old_position_leaf).into(),
                    newPositionLeaf: new_position_leaf.into(),
                    oldLegs: old_legs_pv,
                    newLegs: new_legs_pv,
                });
            }
            OP_FARM_BOND => {
                // Lock LP-share notes into a farm position (SPEC-CONTROLLER-VAULT-AMENDMENT §4): spend the
                // basket (conserve `shares`), append a RECEIPT note committing (shares, rps_entry, owner, nonce)
                // — byte-identical to the Bitcoin `farm_receipt_leaf`. The bond emits a positionLeaf == 1 /
                // debtValue == 0 CdpMint with legs = [shares, rps_entry], so the controller binds `rps_entry ==
                // rps_live` (no backdating) + `total_shares += shares`, and the FROZEN pool skips the position
                // insert (positionLeaf ≤ 1). The receipt rides `pv.leaves`; no pool change.
                let controller = r20();
                let owner = r32();
                let rps_entry: u128 = io::read(); // witnessed; the controller binds it to the live rps at settle
                let nonce = r32();
                let lp_asset = r32(); // the bonded LP-share asset (all legs share it)
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);
                let n_legs: u32 = io::read();
                assert!(
                    n_legs > 0 && n_legs <= MAX_ITEMS_PER_OP,
                    "farm-bond: basket count"
                );
                assert!(
                    spend_root != [0u8; 32],
                    "farm-bond: membership requires a non-zero spend root"
                );
                let mut shares: u64 = 0;
                for _ in 0..n_legs {
                    let (cx, cy, pt) = r_commitment();
                    let value: u64 = io::read();
                    assert!(value > 0, "farm-bond: zero-value leg");
                    let index: u64 = io::read();
                    let path = r_path();
                    let sig_r = decompress(&r33()).expect("farm-bond: leg sigma R");
                    let sig_z = scalar_reduce_be(&r32());
                    let lf = leaf(&lp_asset, &cx, &cy, &owner);
                    assert!(
                        keccak_merkle_verify(&lf, index, &path, &spend_root),
                        "farm-bond: leg membership"
                    );
                    let ctx = intent_context(
                        b"tacit-farm-bond-leg-v1",
                        &chain_binding,
                        &lp_asset,
                        &nonce,
                        &[(cx, cy, owner), (controller32, nonce, owner)],
                        // bind rps_entry (u128 hi/lo) so a delegated prover can't future-date the receipt's
                        // entry checkpoint — which would forfeit the bonder's yield until rps catches up.
                        &[value, index, (rps_entry >> 64) as u64, rps_entry as u64],
                    );
                    assert!(
                        verify_opening_sigma(&pt, value, &sig_r, &sig_z, &ctx),
                        "farm-bond: leg opening sigma"
                    );
                    let nu = nullifier(&cx, &cy);
                    if bitcoin_spent_root != [0u8; 32] {
                        check_btc_nonmembership(&nu, &bitcoin_spent_root);
                    }
                    nullifiers.push(nu);
                    shares = shares
                        .checked_add(value)
                        .expect("farm-bond: share overflow");
                }
                leaves.push(farm_receipt_leaf(
                    &controller32,
                    shares,
                    rps_entry,
                    &owner,
                    &nonce,
                ));
                let debt_asset = cdp_debt_asset_id(&controller);
                let mut sentinel = [0u8; 32];
                sentinel[31] = 1; // positionLeaf == 1 (fair-farm sentinel); debtValue == 0 ⇒ BOND
                cdp_mints.push(CdpMint {
                    controller: Address::from(controller),
                    debtAsset: debt_asset.into(),
                    debtValue: U256::from(0u64),
                    positionLeaf: sentinel.into(),
                    rateSnapshot: U256::from(0u64), // inert: a farm controller has no stability fee
                    legs: vec![
                        CdpLeg {
                            asset: lp_asset.into(),
                            value: U256::from(shares),
                        },
                        CdpLeg {
                            asset: [0u8; 32].into(),
                            value: U256::from(rps_entry),
                        },
                    ],
                    owner: owner.into(),
                });
            }
            OP_FARM_HARVEST => {
                // Claim accrued reward, keeping the principal staked (SPEC-CONTROLLER-VAULT-AMENDMENT §4): prove
                // the OLD receipt note is in the pool tree, nullify it (spend-once), append the checkpoint-
                // advanced receipt + the reward note, and emit a positionLeaf == 1 / debtValue == reward CdpMint
                // with legs = [shares, rps_entry] so the controller bounds `reward ≤ shares·(rps − rps_entry)`.
                // total_shares is untouched (the controller's harvest branch never writes it) — principal stays.
                let controller = r20();
                let owner = r32();
                let shares: u64 = io::read();
                assert!(shares > 0, "farm-harvest: zero shares");
                let rps_entry: u128 = io::read();
                let old_nonce = r32();
                let new_nonce = r32();
                let reward: u64 = io::read();
                assert!(reward > 0, "farm-harvest: zero reward");
                // Relay fee (gasless privacy): carved from the harvested REWARD note — pay the relay out of
                // yield. The reward note opens to reward − fee, the settler (msg.sender) is paid `fee` in the
                // reward asset, and the controller still bounds the GROSS reward. fee = 0 ⇒ self-settle.
                let fee: u64 = io::read();
                assert!(fee < reward, "farm-harvest: fee >= reward");
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);
                let old_index: u64 = io::read();
                let old_path = r_path();
                let old_leaf =
                    farm_receipt_leaf(&controller32, shares, rps_entry, &owner, &old_nonce);
                assert!(
                    spend_root != [0u8; 32],
                    "farm-harvest: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&old_leaf, old_index, &old_path, &spend_root),
                    "farm-harvest: receipt membership"
                );
                let receipt_null = farm_receipt_nullifier(&old_leaf);
                // Cross-lane: the farm receipt nullifier is shared byte-identically with the Bitcoin
                // reflection farm folds, so a receipt already harvested/unbonded on Bitcoin must not be
                // replayed here. Same freshness gate every Bitcoin-homed value spend enforces.
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&receipt_null, &bitcoin_spent_root);
                }
                nullifiers.push(receipt_null);
                let new_entry = farm_harvest_new_entry(shares, rps_entry, reward);
                leaves.push(farm_receipt_leaf(
                    &controller32,
                    shares,
                    new_entry,
                    &owner,
                    &new_nonce,
                ));
                let debt_asset = cdp_debt_asset_id(&controller);
                // The reward note's asset: an escrow-backed reward asset (ESCROW mode, the pool's farmTreasury
                // backs it) or the controller's pool-minted debt asset (MINT mode, == debt_asset). Witnessed so
                // one op serves both; the CdpMint.debtAsset below stays the controller-derived debt id.
                let reward_asset = r32();
                let (r_cx, r_cy, r_pt) = r_commitment();
                let r_sig_r = decompress(&r33()).expect("farm-harvest: reward sigma R");
                let r_sig_z = scalar_reduce_be(&r32());
                let r_ctx = intent_context(
                    b"tacit-farm-harvest-reward-v1",
                    &chain_binding,
                    &reward_asset,
                    &new_nonce,
                    &[(r_cx, r_cy, owner)],
                    &[reward, fee],
                );
                assert!(
                    verify_opening_sigma(&r_pt, reward - fee, &r_sig_r, &r_sig_z, &r_ctx),
                    "farm-harvest: reward opening sigma (net of relay fee)"
                );
                // OWNER AUTH: the public receipt preimage is NOT authorization. A delegated box that sees the
                // receipt witness could otherwise nullify it and re-mint the reward under a commitment IT
                // controls (the leaf `owner` is bearer-only), capturing the yield. Require the receipt owner to
                // BIP-340-sign the spend, binding the reward note's commitment (the dest the box could
                // substitute), the amounts, and the advanced-receipt nonce — the EVM analogue of the Bitcoin
                // lane's reward_r + dest_spk authorization.
                let mut owner_sig = [0u8; 64];
                owner_sig[..32].copy_from_slice(&r32());
                owner_sig[32..].copy_from_slice(&r32());
                let owner_msg = evm_lp_harvest_owner_msg(
                    &controller32, &old_leaf, reward, fee, &new_nonce, &reward_asset, &r_cx, &r_cy,
                );
                assert!(
                    bip340_verify(&owner_sig, &owner_msg, &owner),
                    "farm-harvest: receipt owner signature"
                );
                leaves.push(leaf(&reward_asset, &r_cx, &r_cy, &owner));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: reward_asset.into(),
                        value: U256::from(fee),
                    });
                }
                let mut sentinel = [0u8; 32];
                sentinel[31] = 1; // positionLeaf == 1; debtValue == reward > 0 ⇒ HARVEST
                cdp_mints.push(CdpMint {
                    controller: Address::from(controller),
                    debtAsset: debt_asset.into(),
                    debtValue: U256::from(reward),
                    positionLeaf: sentinel.into(),
                    rateSnapshot: U256::from(0u64), // inert: a farm controller has no stability fee
                    legs: vec![
                        CdpLeg {
                            asset: reward_asset.into(),
                            value: U256::from(shares),
                        },
                        CdpLeg {
                            asset: [0u8; 32].into(),
                            value: U256::from(rps_entry),
                        },
                    ],
                    owner: owner.into(),
                });
            }
            OP_FARM_UNBOND => {
                // Close a farm position (SPEC-CONTROLLER-VAULT-AMENDMENT §4): prove the receipt note, nullify it,
                // re-mint the released LP-share note (opening to `shares`), and emit a CdpClose so the controller
                // drops `total_shares -= shares` + enforces the lock-up. Harvest first to collect accrual.
                let controller = r20();
                let owner = r32();
                let shares: u64 = io::read();
                // Relay fee (gasless privacy): carved from the released LP-share note — the user gets back
                // shares − fee, the settler (msg.sender) is paid `fee` in the LP asset, and the controller
                // still drops the GROSS shares. fee = 0 ⇒ self-settle.
                let fee: u64 = io::read();
                assert!(fee < shares, "farm-unbond: fee >= shares");
                let rps_entry: u128 = io::read();
                let nonce = r32();
                let lp_asset = r32();
                let mut controller32 = [0u8; 32];
                controller32[12..].copy_from_slice(&controller);
                let old_index: u64 = io::read();
                let old_path = r_path();
                let receipt = farm_receipt_leaf(&controller32, shares, rps_entry, &owner, &nonce);
                assert!(
                    spend_root != [0u8; 32],
                    "farm-unbond: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&receipt, old_index, &old_path, &spend_root),
                    "farm-unbond: receipt membership"
                );
                let receipt_null = farm_receipt_nullifier(&receipt);
                // Cross-lane: the receipt nullifier is shared with the Bitcoin reflection farm folds —
                // reject a receipt already spent on Bitcoin (matches every Bitcoin-homed value spend).
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&receipt_null, &bitcoin_spent_root);
                }
                nullifiers.push(receipt_null);
                let (cx, cy, pt) = r_commitment();
                let sig_r = decompress(&r33()).expect("farm-unbond: release sigma R");
                let sig_z = scalar_reduce_be(&r32());
                let ctx = intent_context(
                    b"tacit-farm-unbond-release-v1",
                    &chain_binding,
                    &lp_asset,
                    &nonce,
                    &[(cx, cy, owner)],
                    &[shares, fee],
                );
                assert!(
                    verify_opening_sigma(&pt, shares - fee, &sig_r, &sig_z, &ctx),
                    "farm-unbond: release opening sigma (net of relay fee)"
                );
                // OWNER AUTH (see OP_FARM_HARVEST): require the receipt owner to BIP-340-sign the unbond,
                // binding the released note's commitment, shares, and fee — so a delegated box can't nullify
                // the receipt and re-mint the principal under a commitment it controls.
                let mut owner_sig = [0u8; 64];
                owner_sig[..32].copy_from_slice(&r32());
                owner_sig[32..].copy_from_slice(&r32());
                let owner_msg =
                    evm_lp_unbond_owner_msg(&controller32, &receipt, shares, fee, &lp_asset, &cx, &cy);
                assert!(
                    bip340_verify(&owner_sig, &owner_msg, &owner),
                    "farm-unbond: receipt owner signature"
                );
                leaves.push(leaf(&lp_asset, &cx, &cy, &owner));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: lp_asset.into(),
                        value: U256::from(fee),
                    });
                }
                cdp_closes.push(CdpClose {
                    controller: Address::from(controller),
                    debtValue: U256::from(0u64),
                    repaid: U256::from(0u64), // farm unbond: no debt, no repayment
                    rateSnapshot: U256::from(0u64), // inert: a farm controller has no stability fee
                    positionNullifier: receipt_null.into(),
                    legs: vec![CdpLeg {
                        asset: lp_asset.into(),
                        value: U256::from(shares),
                    }],
                });
            }
            OP_CBTC_MINT => {
                // Mint cBTC against a self-custody Bitcoin lock the reflection recorded. The guest verifies
                // ONLY the value-binding: the note commitment opens to EXACTLY `v_btc` (conservation peg,
                // blinding hidden). The contract gates the rest (cbtcLock[outpoint].vBtc == v_btc, the
                // committed note matches the lock's pre-committed commitment, !cbtcMinted, and the
                // CollateralEngine native-ETH escrow is sufficient) before inserting the leaf. cBTC's asset
                // id is the pinned CBTC_ZK_ASSET_ID — bridge_mint-shaped (no on-chain secp opening needed).
                let outpoint = r32();
                let v_btc: u64 = io::read();
                assert!(v_btc > 0, "cbtc-mint: zero sats"); // a zero-value cBTC bearer note is pure clutter
                // Relay fee (gasless auto-mint): a keeper/relay settles the mint once the reflection records the
                // lock — no second user popup after they posted the ETH escrow + the parallel Bitcoin lock. The
                // bearer note opens to `v_btc − fee` (the user pre-commits to that net commitment at lock time)
                // and the settler (msg.sender) is paid `fee` in cBTC; total minted = net + fee = v_btc, so the
                // 1:1 lock/escrow backing is exact (no over-mint, no under-backing). fee = 0 ⇒ self-mint
                // (net == v_btc), byte-identical to the original. The contract still records vBtc = v_btc and
                // matches the pre-committed commitment, so the peg gate is unchanged.
                let fee: u64 = io::read();
                assert!(fee < v_btc, "cbtc-mint: fee >= v_btc");
                let net = v_btc - fee;
                let (cx, cy, c) = r_commitment();
                let sig_r = decompress(&r33()).expect("cbtc-mint: sigma R");
                let sig_z = scalar_reduce_be(&r32());
                let ctx = intent_context(
                    b"tacit-cbtc-mint-intent-v1",
                    &chain_binding,
                    &CBTC_ZK_ASSET_ID,
                    &outpoint,
                    &[(cx, cy, [0u8; 32])],
                    &[v_btc, fee],
                );
                assert!(
                    verify_opening_sigma(&c, net, &sig_r, &sig_z, &ctx),
                    "cbtc-mint: note opening sigma (opens to v_btc − fee)",
                );
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: CBTC_ZK_ASSET_ID.into(),
                        value: U256::from(fee),
                    });
                }
                // OWNER-FREE bearer note (owner = 0), the cBTC model: control is the secret blinding `r`
                // (the locker's), NOT the owner label. (Cx,Cy) is public on the Bitcoin lock tx, so an
                // owner-bearing leaf would let a front-runner mint it to an unscannable owner + block the
                // re-mint (cbtcMinted is one-shot) — griefing. With owner=0 a front-run just mints the
                // locker's OWN note (only they hold `r`); it cannot be redirected. Matches fold_cbtc_lock's
                // historical owner-free note + the JS CBTC_NOTE_OWNER.
                leaves.push(leaf(&CBTC_ZK_ASSET_ID, &cx, &cy, &[0u8; 32]));
                cbtc_mints.push(CbtcMint {
                    outpoint: outpoint.into(),
                    vBtc: U256::from(v_btc),
                    commitment: commitment_hash(&cx, &cy).into(),
                });
            }
            OP_STEALTH_LOCK => {
                // Stealth-receive LOCK: spend a normal note N and move its FULL value into the SHARED lock-set
                // as a locked note L, bound to the recipient's one-time stealth pubkey `owner_pub`. Disjoint
                // leaf domain from the adaptor lock (`stealth_lock_leaf`), so the two lock kinds never
                // cross-claim. `amount` is bound in the leaf so a later claim cannot over-mint; `deadline`/
                // `locker` carry the refund path. The sender (locker) knows L's blinding but NOT owner_pub's
                // one-time key, and L is unreachable by transfer/swap — so only the recipient can claim.
                let asset = r32();
                let locker = r32(); // == N's owner (authorizes the spend by opening N)
                let owner_pub = r32(); // recipient one-time stealth x-only pubkey (the claim signs under it)
                                       // Reject a non-curve owner_pub at lock time (a typo'd / garbage stealth address) so it can't
                                       // create an unclaimable lock — an honest one-time pubkey O = B + s·G is always a valid
                                       // x-coordinate. (The locker can still refund either way; this just fails fast.)
                {
                    let mut owner_comp = [2u8; 33];
                    owner_comp[1..].copy_from_slice(&owner_pub);
                    decompress(&owner_comp)
                        .expect("stealth-lock: owner_pub is not a valid x-only pubkey");
                }
                let amount: u64 = io::read();
                assert!(amount > 0, "stealth-lock: zero amount");
                let deadline: u64 = io::read();
                assert!(deadline != 0, "stealth-lock: deadline required");

                let (n_cx, n_cy, n_pt) = r_commitment();
                let n_index: u64 = io::read();
                let n_path = r_path();
                let n_lf = leaf(&asset, &n_cx, &n_cy, &locker);
                assert!(
                    spend_root != [0u8; 32],
                    "stealth-lock: membership requires a non-zero spend root"
                );
                assert!(
                    keccak_merkle_verify(&n_lf, n_index, &n_path, &spend_root),
                    "stealth-lock: N membership"
                );
                let n_nu = nullifier(&n_cx, &n_cy);
                if bitcoin_spent_root != [0u8; 32] {
                    check_btc_nonmembership(&n_nu, &bitcoin_spent_root);
                }
                let n_sig_r = decompress(&r33()).expect("stealth-lock: N-open R");
                let n_sig_z = scalar_reduce_be(&r32());
                let (l_cx, l_cy, l_pt) = r_commitment();
                let l_sig_r = decompress(&r33()).expect("stealth-lock: L-open R");
                let l_sig_z = scalar_reduce_be(&r32());

                let ctx = intent_context(
                    b"tacit-stealth-lock-intent-v1",
                    &chain_binding,
                    &asset,
                    &asset,
                    &[(n_cx, n_cy, locker), (l_cx, l_cy, owner_pub)],
                    &[amount, deadline],
                );
                assert!(
                    verify_opening_sigma(&n_pt, amount, &n_sig_r, &n_sig_z, &ctx),
                    "stealth-lock: N opening (spend authz + value)"
                );
                assert!(
                    verify_opening_sigma(&l_pt, amount, &l_sig_r, &l_sig_z, &ctx),
                    "stealth-lock: L opening (value carry)"
                );

                nullifiers.push(n_nu);
                lock_leaves.push(stealth_lock_leaf(
                    &asset, &l_cx, &l_cy, &owner_pub, amount, deadline, &locker,
                ));
            }
            OP_STEALTH_CLAIM => {
                // Stealth-receive CLAIM: the recipient proves L ∈ the lock-set (reconstructing its leaf pins
                // asset/owner_pub/amount/deadline/locker), spends ν_L once, and mints output M to an owner THEY
                // choose. Authorized by a BIP-340 signature under `owner_pub` over the exact (lock, M, fee), so
                // only the one-time-key holder can claim and a relayer can neither redirect M nor pad the fee.
                // No kernel: `amount` is leaf-pinned and M opens to `amount − fee` (+ the fee leg) ⇒ conserved.
                let asset = r32();
                let (l_cx, l_cy, _l_pt) = r_commitment(); // locked note (point validated; value pinned by the leaf)
                let owner_pub = r32();
                let amount: u64 = io::read();
                let deadline: u64 = io::read();
                let locker = r32();
                let l_index: u64 = io::read();
                let l_path = r_path();
                let lock_lf =
                    stealth_lock_leaf(&asset, &l_cx, &l_cy, &owner_pub, amount, deadline, &locker);
                assert!(
                    lock_set_root != [0u8; 32],
                    "stealth-claim: membership requires a non-zero lock-set root"
                );
                assert!(
                    keccak_merkle_verify(&lock_lf, l_index, &l_path, &lock_set_root),
                    "stealth-claim: L lock-set membership"
                );
                let l_nu = nullifier(&l_cx, &l_cy);

                let (m_cx, m_cy, m_pt) = r_commitment();
                let m_owner = r32();
                let fee: u64 = io::read();
                assert!(
                    fee < amount,
                    "stealth-claim: fee must be < the locked amount"
                );
                let net = amount - fee;
                let m_sig_r = decompress(&r33()).expect("stealth-claim: M-open R");
                let m_sig_z = scalar_reduce_be(&r32());
                let m_ctx = intent_context(
                    b"tacit-stealth-claim-out-v1",
                    &chain_binding,
                    &asset,
                    &asset,
                    &[(m_cx, m_cy, m_owner)],
                    &[amount, fee],
                );
                assert!(
                    verify_opening_sigma(&m_pt, net, &m_sig_r, &m_sig_z, &m_ctx),
                    "stealth-claim: M opening (recipient controls the output, net of fee)"
                );

                let mut owner_sig = [0u8; 64];
                owner_sig[..32].copy_from_slice(&r32());
                owner_sig[32..].copy_from_slice(&r32());
                let claim_msg = stealth_claim_msg(
                    &chain_binding,
                    &lock_lf,
                    &m_cx,
                    &m_cy,
                    &m_owner,
                    amount,
                    fee,
                );
                assert!(
                    bip340_verify(&owner_sig, &claim_msg, &owner_pub),
                    "stealth-claim: one-time-key signature (only the recipient can claim)"
                );

                min_deadline = if min_deadline == 0 {
                    deadline
                } else {
                    min_deadline.min(deadline)
                };

                lock_nullifiers.push(l_nu);
                leaves.push(leaf(&asset, &m_cx, &m_cy, &m_owner));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
            }
            OP_STEALTH_REFUND => {
                // Stealth-receive REFUND: after the deadline, the LOCKER reclaims an unclaimed lock (typo /
                // dead-address safety). Same membership + ν_L as CLAIM, but kernel-gated like OP_ADAPTOR_REFUND:
                // the kernel over (L_C − O_C) can only be produced by the locker (who alone knows L's blinding),
                // so a non-locker can neither refund nor redirect — the output is the locker's note. Optional fee.
                let asset = r32();
                let (l_cx, l_cy, l_pt) = r_commitment();
                let owner_pub = r32();
                let amount: u64 = io::read();
                let deadline: u64 = io::read();
                let locker = r32();
                let l_index: u64 = io::read();
                let l_path = r_path();
                let lock_lf =
                    stealth_lock_leaf(&asset, &l_cx, &l_cy, &owner_pub, amount, deadline, &locker);
                assert!(
                    lock_set_root != [0u8; 32],
                    "stealth-refund: membership requires a non-zero lock-set root"
                );
                assert!(
                    keccak_merkle_verify(&lock_lf, l_index, &l_path, &lock_set_root),
                    "stealth-refund: L lock-set membership"
                );
                let l_nu = nullifier(&l_cx, &l_cy);

                let (o_cx, o_cy, o_pt) = r_commitment();
                let fee: u64 = io::read();
                // Bound the relay fee by the locked value: `amount` is leaf-pinned (membership reconstructs
                // stealth_lock_leaf with it) and was bound to L's value by the lock-time opening sigma, so it
                // IS L's true u64 value. Without this the fee-bearing kernel (value(L) = value(O) + fee mod n)
                // accepts ANY fee for a freely chosen O, paying out an unbacked `fee` at the public boundary.
                assert!(fee < amount, "stealth-refund: fee >= locked amount");
                let kernel_r = decompress(&r33()).expect("stealth-refund: kernel R");
                let kernel_z = scalar_reduce_be(&r32());
                assert!(
                    verify_kernel_with_fee(&[l_pt], &[o_pt], fee, &kernel_r, &kernel_z),
                    "stealth-refund: value conservation (locker-only kernel)"
                );

                assert!(deadline != 0, "stealth-refund: deadline required");
                refund_not_before = refund_not_before.max(deadline);

                lock_nullifiers.push(l_nu);
                leaves.push(leaf(&asset, &o_cx, &o_cy, &locker));
                if fee != 0 {
                    fees.push(FeePayment {
                        assetId: asset.into(),
                        value: U256::from(fee),
                    });
                }
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
        swaps,
        liquidity,
        deadline: min_deadline,
        lockSetRoot: lock_set_root.into(),
        lockLeaves: lock_leaves.into_iter().map(Into::into).collect(),
        lockNullifiers: lock_nullifiers.into_iter().map(Into::into).collect(),
        adaptorClaimS: adaptor_claim_s.into_iter().map(Into::into).collect(),
        refundNotBefore: refund_not_before,
        cdpPositionRoot: cdp_position_root.into(),
        cdpMints: cdp_mints,
        cdpCloses: cdp_closes,
        cdpLiquidations: cdp_liquidations,
        cdpTopups: cdp_topups,
        cbtcMints: cbtc_mints,
    };
    io::commit_slice(&pv.abi_encode());
}
