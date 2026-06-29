//! Reflection prover — proves the Bitcoin confidential-pool roots that
//! ConfidentialPool.attestBitcoinStateProven pins as the cross-lane / bridge_mint authority.
//!
//! FULL SCAN (F4 closed): the prover is HANDED the live pool UTXO set, re-derives the resume
//! digest from it (so the contract's `priorDigest == knownReflectionDigest` chain pins the handed
//! set — a wrong handoff fails the digest), then walks EVERY tx of EVERY block in the batch and
//! resolves each tx's vins against that set. Because no tx is skipped (the provided txs must
//! re-hash to the header's merkle root) and no vin is skipped, a relayer can no longer OMIT a
//! Bitcoin spend of a pool note — even a plain, non-protocol spend of a pool UTXO is nullified.
//! That is the completeness the earlier witnessed-effects model (relayer-chosen txs) could not
//! guarantee, so the cross-lane non-membership gate is now sound, not caveated.
//!
//! The note tree, spent-set, and bridge-burn set stay HEADLESS (roots + counts + witnessed
//! transitions, O(Δ)/cycle); only the UTXO set is full in-memory (`LiveUtxoSet`, the vin-lookup
//! source, O(live) to verify once per batch). Per batch: O(live) set-verify + O(block) vin-scan +
//! O(Δ) witnessed spent/note/burn — see the reflection prover memo for the scale envelope.
//!
//! ANCHOR (F1/F2/F3 closed): the guest commits `bitcoinPrevHash` (headers[0]'s prev field) +
//! `bitcoinTipHash` (the last header's hash); ConfidentialPool pins the tip to the canonical
//! BitcoinLightRelay (`RELAY.tip()` within FINALITY_WINDOW) and the prev to the prior attested tip,
//! forcing the whole proven chain to be canonical Bitcoin (self-declared difficulty moot; the
//! finality window gives confirmation/reorg tolerance). The ctor binds them: a non-zero
//! BITCOIN_RELAY_VKEY requires a non-zero HEADER_RELAY.
#![cfg_attr(not(test), no_main)]
#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::private::U256;
use alloy_sol_types::sol;
use alloy_sol_types::SolType;
use cxfer_core::{
    amm_canonical_pair, amm_derive_farm_id, amm_derive_pool_id_full, bitcoin, burn_deposit,
    commitment_hash, commitment_hash_compressed, compress, decompress, from_affine_xy, imt_membership,
    leaf, nullifier, outpoint_key, scan_tx_spends, utxo_membership,
    verify_cxfer_conservation,
    CbtcLockFold, FarmRewardSet, FarmRewardState, LiveUtxoSet, Point, PoolReserveSet,
    PoolReserveState, ScanReflection, CBTC_ZK_ASSET_ID,
};
use sp1_zkvm::io;

// The in-guest BN254 Groth16 verifier for T_SWAP_BATCH (reflection-only; pulls the SP1-precompile `bn`
// crate into this ELF, not the settle one). FULLY IMPLEMENTED + WIRED: `swap_batch::fold_swap_batch`
// (swap_batch.rs) parses the 0x2F envelope, re-derives the 123 public signals (swap_batch_public_signals),
// verifies them against the baked BATCH_VK via `groth16::groth16_bn254_verify`, checks the aggregate
// Pedersen identity + distinct-real-spend matching + per-receipt cross-curve sigma, then onboards each
// receipt's witnessed opening — invoked from the reflection fold below. Only end-to-end box validation
// against a full real envelope+proof vector remains (see swap_batch.rs header). See
// ops/DESIGN-in-guest-groth16-verifier.md.
mod babyjubjub;
#[allow(dead_code)]
mod groth16;
mod swap_batch;

sol! {
    // A self-custody cBTC.zk lock this batch newly tracked (cf. cxfer-core CbtcLockFold). The contract
    // records `cbtcLock[outpoint] = {vBtc, commitment}` so a later ConfidentialPool.mintCbtc can mint the
    // pre-committed cBTC note 1:1 against the lock, gated on a native-ETH escrow. The value-opening
    // (note == vBtc, the conservation peg) is checked at mint, not here.
    struct CbtcLockFolded {
        bytes32 outpoint;     // keccak(lock_txid ‖ lock_vout)
        uint256 vBtc;         // the locked output's sats (objective Bitcoin data, proven by the confirmed tx)
        bytes32 commitment;   // keccak(Cx‖Cy) of the locker's pre-committed cBTC note (anti-griefing bind)
    }
    // (asset_id, ticker, decimals, cid) parsed from an etch this batch authenticated — byte-identical to the
    // settle guest's AssetMeta + ConfidentialPool.AssetMeta so the contract's `_autoRegisterFromMeta` decodes it.
    struct AssetMeta {
        bytes32 assetId;
        bytes16 ticker;
        uint8 tickerLen;
        uint8 decimals;
        bytes32 cid;
    }
    struct BitcoinReflectionPublicValues {
        bytes32 priorDigest;       // the reflected state this cycle continues from
        bytes32 bitcoinPoolRoot;   // note-tree root after the batch
        bytes32 bitcoinSpentRoot;  // spent-set IMT root after the batch
        bytes32 bitcoinBurnRoot;   // bridge-burn set root after the batch
        uint64  bitcoinHeight;     // confirmed Bitcoin height the batch advanced to
        bytes32 newDigest;         // the reflected state after the batch (next cycle's prior)
        bytes32 bitcoinPrevHash;   // headers[0]'s prev-block field — the anchor this batch resumes from
        bytes32 bitcoinTipHash;    // double-SHA256 of the last header — the batch's new tip
        bytes32 ethPoolReflected;  // Mode B: the eth-reflection's ethPool — attest gates it == address(this)
        uint256 cbtcBackingSats;   // cBTC: Σ live self-custody cBTC.zk lock sats (the off-pool buffer reads it)
        // cBTC per-lock surfacing (ops/DESIGN-confidential-defi-v1.md §3): the per-batch deltas the contract
        // records into its per-lock registry. `cbtcLocksFolded` = locks newly tracked this batch (gate the
        // escrow-mint); `cbtcLocksSpent` = tracked locks BARE-spent this batch (a rug — the engine slashes the
        // escrow); `cbtcLocksRedeemed` = tracked locks HONESTLY redeemed this batch (cBTC burned + lock
        // unlocked atomically — the engine's TRUSTLESS escrow-claim gate). Spent and redeemed are mutually
        // exclusive (a redeem retires the lock before the rug scan). Proven arrays, like the settle guest's
        // leaves / bitcoinBurnsConsumed.
        CbtcLockFolded[] cbtcLocksFolded;
        bytes32[] cbtcLocksSpent;
        bytes32[] cbtcLocksRedeemed;
        // FAST-LANE FRESHNESS: how many eth-consumed ν this batch has folded into the spent set. attest
        // gates it == ConfidentialPool.bitcoinConsumedCount, so the spent set can advance ONLY after every
        // recorded consume is folded — closing the stale-eth-proof double-credit.
        uint64  consumedCount;
        // CROSS-OUT FRESHNESS: the eth-reflection's crossOutCount (complete as of its finalized slot). attest
        // gates it == ConfidentialPool.crossOutCount, so a 0x65 mint can fold ONLY against a cross-out set
        // current as of NOW — closing the stale-eth-proof cross-out censorship (mirror of consumedCount).
        uint64  crossOutCount;
        // Trustless metadata: assets whose etch this batch authenticated (BIP141 witness commitment + the
        // canonical provenance header chain) — surfaced so attest can lazy-register each canonical ERC20.
        // The SP1 proof binds them to a real, confirmed etch, so the contract needs no further anchor.
        AssetMeta[] attestedAssetMetas;
        // value-free Bitcoin-authorized calls → ConfidentialPool.pendingBtcCall, flat (callId, recordHash) pairs.
        bytes32[] btcCallsFolded;
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
fn r_path() -> Vec<[u8; 32]> {
    (0..32).map(|_| r32()).collect()
}

/// Resume anchor: the headless roots + counts, the HANDED live UTXO set (sorted (key,value)
/// pairs), and the height. `from_sorted` rejects an unsorted/duplicate handoff; the digest
/// re-derivation pins the set's root + size (the contract chains it), so this IS the O(live)
/// verify-once step — no separate root check needed.
fn read_scan_prior_state() -> ScanReflection {
    let pool_root = r32();
    let note_count: u64 = io::read();
    let spent_root = r32();
    let spent_count: u64 = io::read();
    let n_live: u32 = io::read();
    // Each live entry is (outpoint key, commitment_hash, asset_id): the asset is carried so the
    // CXFER fold can re-impose asset preservation on a spend (the digest commits all three).
    let live_triples: Vec<([u8; 32], [u8; 32], [u8; 32])> =
        (0..n_live).map(|_| (r32(), r32(), r32())).collect();
    let live =
        LiveUtxoSet::from_sorted(live_triples).expect("handed live UTXO set not sorted/unique");
    let burn_root = r32();
    let burn_count: u64 = io::read();
    let height: u64 = io::read();
    // cBTC.zk resume state: the live self-custody lock set (key, sats-as-32B, asset) + the running
    // Σ backing sats. Both ride digest() (cxfer-core), so a wrong handoff fails the priorDigest chain.
    // Empty for a no-lock batch (n=0, sats=0); the assembler/indexer emit the prior set for live locks.
    let n_cbtc_locks: u32 = io::read();
    let cbtc_lock_triples: Vec<([u8; 32], [u8; 32], [u8; 32])> =
        (0..n_cbtc_locks).map(|_| (r32(), r32(), r32())).collect();
    let cbtc_locks = LiveUtxoSet::from_sorted(cbtc_lock_triples)
        .expect("handed cBTC lock set not sorted/unique");
    let cbtc_backing_sats: u64 = io::read();
    // Track B resume state: the per-pool reserve registry — (pool_id, asset_a, asset_b, reserve_a,
    // reserve_b, total_shares, c0_backed, protocol_fee_bps, k_last, protocol_fee_accrued). Rides digest()
    // (cxfer-core), so a wrong handoff (forged reserve / flipped backing flag / forged accrued skim) fails
    // the priorDigest chain. Empty for a no-AMM-pool batch (n=0).
    let n_pools: u32 = io::read();
    let pool_entries: Vec<([u8; 32], PoolReserveState)> = (0..n_pools)
        .map(|_| {
            let pool_id = r32();
            let asset_a = r32();
            let asset_b = r32();
            let reserve_a: u64 = io::read();
            let reserve_b: u64 = io::read();
            let total_shares: u64 = io::read();
            let c0_backed: u32 = io::read();
            // Protocol-fee (Uniswap-V2 lazy mintFee) state — committed in the pool leaf (PoolReserveSet::root)
            // so a resumed cycle can't forge the accrued skim. All zero for a no-skim pool.
            let protocol_fee_bps: u16 = io::read();
            let k_last: u128 = io::read();
            let protocol_fee_accrued: u64 = io::read();
            (
                pool_id,
                PoolReserveState {
                    asset_a,
                    asset_b,
                    reserve_a,
                    reserve_b,
                    total_shares,
                    c0_backed: c0_backed != 0,
                    protocol_fee_bps,
                    k_last,
                    protocol_fee_accrued,
                },
            )
        })
        .collect();
    let pools = PoolReserveSet::from_sorted(pool_entries)
        .expect("handed pool reserve set not sorted/unique");
    // FAST LANE resume: how many eth-consumed ν have already been folded into the spent set (rides
    // digest(), so a forged handoff fails the priorDigest chain). 0 until the first fast-lane consume.
    let consumed_count: u64 = io::read();
    // FAST LANE / Mode-B anchor resume: the eth-reflection accumulator digest committed by the last
    // Mode-B cycle ([0;32] until the first). Rides digest(), so a forged handoff fails the priorDigest
    // chain — and the Mode-B fold below requires the eth proof's prior to continue exactly this.
    let eth_refl_digest = r32();
    // Farms (SPEC-CONTROLLER-VAULT-AMENDMENT §4): the per-farm reward-per-share accumulator handoff —
    // (farm_id, rate, total_shares, rps, last_height), read right after eth_refl_digest. Rides digest()
    // (cxfer-core), so a forged handoff (a forged rps / total_shares that would let an over-reward harvest
    // pass) fails the priorDigest chain. Empty (n=0) for a no-farm chain. The per-staker receipts ride the
    // note tree (pool_root) + spent set (already resumed above), so they need NO separate handoff.
    let n_farms: u32 = io::read();
    let farm_entries: Vec<([u8; 32], FarmRewardState)> = (0..n_farms)
        .map(|_| {
            let farm_id = r32();
            let rate: u64 = io::read();
            let total_shares: u64 = io::read();
            let rps: u128 = io::read();
            let last_height: u64 = io::read();
            let launcher_pubkey = r33(); // the farm launcher (∈ farm_id); gates T_FARM_REFUND auth
            let lp_asset = r32(); // amm_derive_lp_asset_id(pool_id); a T_LP_BOND must spend this asset
            let start_height: u64 = io::read(); // campaign window [start, end] — accrue clamps to it
            let end_height: u64 = io::read();
            (
                farm_id,
                FarmRewardState {
                    rate,
                    total_shares,
                    rps,
                    last_height,
                    launcher_pubkey,
                    lp_asset,
                    start_height,
                    end_height,
                },
            )
        })
        .collect();
    let farm_rewards =
        FarmRewardSet::from_sorted(farm_entries).expect("handed farm reward set not sorted/unique");
    // ETH→BTC cross-out replay gate resume: the consumed-cross-out (claim_id) IMT root + count, read LAST
    // (matches digest() order). Rides digest(), so a rolled-back set fails the priorDigest chain — a resumed
    // cycle can't drop an already-minted claim and re-mint it.
    let consumed_crossout_root = r32();
    let consumed_crossout_count: u64 = io::read();
    ScanReflection {
        pool_root,
        note_count,
        spent_root,
        spent_count,
        live,
        burn_root,
        burn_count,
        height,
        cbtc_locks,
        cbtc_backing_sats,
        pools,
        consumed_count,
        eth_refl_digest,
        // Farms (SPEC-CONTROLLER-VAULT-AMENDMENT §4): the per-farm reward-per-share accumulator, resumed
        // from the witnessed (farm_id → rate/total_shares/rps/last_height) handoff above + committed in
        // `digest()`. The per-staker receipts ride the note tree (resumed via pool_root) + spent set (resumed
        // via spent_root), so they carry no separate handoff.
        farm_rewards,
        consumed_crossout_root,
        consumed_crossout_count,
    }
}

/// One spent-set IMT insert witness (the low leaf + the two paths). ν comes from the scan.
fn read_spent_insert() -> ([u8; 32], [u8; 32], u64, Vec<[u8; 32]>, Vec<[u8; 32]>) {
    let low_value = r32();
    let low_next = r32();
    let low_index: u64 = io::read();
    let low_path = r_path();
    let new_path = r_path();
    (low_value, low_next, low_index, low_path, new_path)
}

/// One bridge-burn set insert witness (ν → destCommitment; the low node + the two paths).
fn read_burn_insert() -> (
    [u8; 32],
    [u8; 32],
    [u8; 32],
    u64,
    Vec<[u8; 32]>,
    Vec<[u8; 32]>,
) {
    let low_key = r32();
    let low_next = r32();
    let low_value = r32();
    let low_index: u64 = io::read();
    let low_path = r_path();
    let new_path = r_path();
    (low_key, low_next, low_value, low_index, low_path, new_path)
}

pub fn main() {
    let mut state = read_scan_prior_state();
    let prior_digest = state.digest();

    // ── Mode B reverse reflection: recursively verify the eth-reflection proof, then admit its
    // attested cross-out set. The eth-reflection guest (helios light-client + a crossOutCommitment
    // storage proof against finalized Ethereum) commits `EthReflectionPublicValues`;
    // `verify_sp1_proof` binds these bytes to THAT program (the inner Compressed proof is supplied to
    // the prover via SP1Stdin::write_proof), so a `fold_crossout` below trusts a cross-out finalized on
    // Ethereum — not the worker. See ops/PLAN-eth-reflection-modeB.md + ops/DESIGN-mode-b-recursion.md.
    // The eth-reflection guest's RECURSION vk_digest (vk.hash_u32(), the Poseidon digest verify_sp1_proof
    // checks — NOT the on-chain bytes32 0x0081d2c6…). Rebuilding that ELF rotates this; recompute via
    // prover-host/eth_vkey and keep in lockstep.
    const ETH_REFLECTION_VKEY: [u32; 8] = [
        1089037164, 291760170, 687406231, 696197423, 1042459346, 1019538966, 544568070, 685838131,
    ];
    // Genesis sync-committee anchor (beacon weak-subjectivity bootstrap — NOT circular with the pool),
    // pinned at re-prove time to the chosen Sepolia finalized checkpoint. The pool address is NOT pinned
    // here: it's passed through as `ethPoolReflected` and gated on-chain == address(this), which breaks
    // the pool↔vkey circularity with the vkey still immutable in the constructor (D1).
    // Sepolia genesis sync-committee anchor, captured from the stage-i eth compressed proof
    // (prevSyncCommitteeRoot @ finalizedSlot 10462624). Re-anchor for a production deploy.
    const ETH_GENESIS_SYNC_COMMITTEE: [u8; 32] = [
        0x8a, 0x83, 0x30, 0x01, 0x19, 0xac, 0x1e, 0x64, 0xa2, 0x31, 0x8d, 0x3d, 0xb3, 0x30, 0xed,
        0x49, 0x6c, 0x51, 0x27, 0x6c, 0x63, 0x6a, 0x93, 0x63, 0x3b, 0x2d, 0x5c, 0xfd, 0x28, 0x3c,
        0x2d, 0x44,
    ];

    // Mode-B gate. `verify_sp1_proof` (the eth-reflection recursion) is needed ONLY to trust a
    // `fold_crossout` below (reverse-bridge ETH→BTC). A forward-only batch (burn-deposit / cmint / CXFER
    // scan) folds no crossout, so it skips the recursion entirely — no deferred-proof obligation, no
    // eth-reflection inner proof required. mode_b == 0 ⇒ SENTINEL eth state: crossout_set_root = 0 makes
    // every 0x65 `fold_crossout` fail set-membership (skip-not-panic), so a forward batch can never mint a
    // crossout without verification; ethPoolReflected = 0 is the "no eth-state attested" sentinel the
    // contract accepts (otherwise it must == address(this)). A reverse-bridge batch sets mode_b = 1 and
    // proves exactly as before. This is what lets the forward bridge re-prove without standing up the
    // eth-reflection guest (it decouples the onboarding re-prove from Mode-B becoming operational).
    let mode_b: u32 = io::read();
    let (eth_pool_word, crossout_set_root, crossout_count, consumed_set_root, consumed_nu_count): (
        [u8; 32],
        [u8; 32],
        u64,
        [u8; 32],
        u64,
    ) = if mode_b != 0 {
        let eth_pv: Vec<u8> = io::read();
        // EthReflectionPublicValues is exactly 11 static ABI words; require the exact length so no trailing
        // bytes (or a future appended field) are silently ignored by the offset reads below.
        assert!(
            eth_pv.len() == 11 * 32,
            "eth-reflection public values: wrong length"
        );
        sp1_lib::verify::verify_sp1_proof(&ETH_REFLECTION_VKEY, &bitcoin::sha256_once(&eth_pv));
        // EthReflectionPublicValues is 11 static ABI words; read by offset. Order: priorDigest, newDigest,
        // ethPool, crossOutSetRoot, crossOutCount, finalizedSlot, finalizedExecStateRoot, syncCommitteeRoot,
        // prevSyncCommitteeRoot, consumedNuSetRoot, consumedNuCount. WEAK-SUBJECTIVITY ANCHOR: every cycle's eth
        // proof MUST have chained FROM the pinned genesis sync-committee (word 8). This is enforced statically
        // here, NOT carried forward — the eth guest re-bootstraps from genesis each cycle and replays the LC
        // update chain to the finalized slot. Cross-period chaining (carry word 7 syncCommitteeRoot into the
        // next cycle's word 8) is NOT implemented; advancing past a far-future genesis is an operational
        // re-anchor (which rotates the eth vkey ⇒ re-pin ETH_REFLECTION_VKEY + re-prove), a deferred feature.
        assert_eq!(
            &eth_pv[8 * 32..9 * 32],
            &ETH_GENESIS_SYNC_COMMITTEE,
            "eth-reflection: wrong genesis sync-committee"
        );
        let ep: [u8; 32] = eth_pv[2 * 32..3 * 32].try_into().expect("ethPool word"); // gated on-chain == address(this)
                                                                                     // A Mode-B proof must carry a REAL pool: ethPool == 0 is the mode_b==0 "no eth-state" sentinel the
                                                                                     // contract accepts, so a Mode-B proof with ethPool 0 would be mistaken for it (the guest still used
                                                                                     // this proof's crossout/consumed roots). Also require a canonical 20-byte address (high 12 bytes 0)
                                                                                     // so the ABI word can't be a non-address that still compares != 0.
        assert!(
            ep != [0u8; 32] && ep[..12].iter().all(|&b| b == 0),
            "mode_b ethPool must be a nonzero canonical address"
        );
        let cr: [u8; 32] = eth_pv[3 * 32..4 * 32]
            .try_into()
            .expect("crossOutSetRoot word");
        // crossOutCount — a uint64 ABI-encoded right-aligned in the 32-byte word (field 4). attest gates this
        // == ConfidentialPool.crossOutCount (NOW), forcing the eth proof fresh enough to include every recorded
        // cross-out, so a freshly-finalized claimId can't be censored by a stale set.
        let crossout_cnt = u64::from_be_bytes(eth_pv[5 * 32 - 8..5 * 32].try_into().unwrap());
        let consumed_root: [u8; 32] = eth_pv[9 * 32..10 * 32]
            .try_into()
            .expect("consumedNuSetRoot word");
        // consumedNuCount — a uint64 ABI-encoded right-aligned in the 32-byte word (field 10).
        let consumed_cnt = u64::from_be_bytes(eth_pv[11 * 32 - 8..11 * 32].try_into().unwrap());
        // CROSS-CYCLE ANCHOR (closes the forged-eth-prior bypass). The eth-reflection accumulator prior
        // (prior_set_root / prior_consumed_root / counts) is WITNESSED into the eth guest, so the freshness
        // COUNT gate alone (consumedNuCount == bitcoinConsumedCount) is satisfiable by a forged prior that
        // folds nothing real. Bind it: the eth proof's priorDigest (word 0) MUST continue the digest the
        // last Mode-B cycle committed (resumed in `state.eth_refl_digest`, itself pinned by the contract's
        // priorDigest == knownReflectionDigest chain); the FIRST Mode-B cycle continues the eth genesis
        // (empty accumulator for this pool). Then carry forward the new committed digest (word 1). With this,
        // a witnessed prior must equal the real prior accumulation, so every folded crossout / consumed ν is
        // backed by a slot actually proven in some cycle. (DESIGN-mode-b-recursion.md §2.)
        let expected_prior = if state.eth_refl_digest == [0u8; 32] {
            cxfer_core::eth_reflection::eth_refl_genesis_digest(&ep[12..32])
        } else {
            state.eth_refl_digest
        };
        assert_eq!(
            &eth_pv[0..32],
            &expected_prior[..],
            "eth-reflection prior must continue the committed chain"
        );
        state.eth_refl_digest = eth_pv[32..64].try_into().expect("eth newDigest word");
        (ep, cr, crossout_cnt, consumed_root, consumed_cnt)
    } else {
        // sentinel: forward-only batch — no eth recursion, no crossout/consumed fold.
        ([0u8; 32], [0u8; 32], 0u64, [0u8; 32], 0u64)
    };

    // Header chain: non-empty, links (prev_hash) + carries valid PoW, and EXPOSES its anchor
    // (headers[0]'s prev) + tip so the CONTRACT can pin them to the canonical relay — forcing the
    // whole batch to be canonical Bitcoin (F1/F2/F3).
    let anchor_height: u64 = io::read();
    let num_headers: u32 = io::read();
    let headers: Vec<Vec<u8>> = (0..num_headers).map(|_| io::read()).collect();
    assert!(
        num_headers > 0,
        "reflection batch needs >=1 header to anchor"
    );
    let refs: Vec<&[u8]> = headers.iter().map(|h| h.as_slice()).collect();
    let tip_hash = bitcoin::verify_header_chain(&refs).expect("invalid Bitcoin header chain");
    let prev_hash: [u8; 32] = headers[0][4..36].try_into().expect("header prev field");
    // Strict append-only: the first scanned block must be exactly the one after the last reflected block.
    // state.height is the prior reflected height (bound by priorDigest); the contract pins prev_hash to the
    // last reflected block, so headers[0] (which extends prev_hash) is at state.height + 1. Without this a
    // prover could witness an INFLATED anchor_height — ratcheting the contract's lastRelayHeight forward to
    // brick honest proofs whose real height is lower — or a DEFLATED one to re-fold blocks at/under the
    // prior tip (the reflection has no rollback). This also makes the contract's recent-ancestor prevHash
    // tolerance unreachable: an ancestor sits below state.height, so the batch would fail this equality.
    assert_eq!(
        anchor_height,
        state.height + 1,
        "reflection must append exactly (anchor_height == prior reflected height + 1)"
    );

    // FAST LANE (Ethereum-senior): fold the NEW eth-consumed ν into the spent set BEFORE the block scan,
    // so each source UTXO is removed from `live` and a racing Bitcoin spend in this batch is voided (its
    // CXFER outputs fail conservation). COMPLETENESS is mandatory: an omitted consume leaves the note live
    // on Bitcoin (double-spend), so fold the WHOLE [prior, consumed_nu_count) range and panic on any miss
    // (the inverse of the crossout/cxfer skip-not-panic discipline). mode_b == 0 ⇒ consumed_nu_count == 0,
    // so a forward-only batch folds none and `consumed_count` carries unchanged. The witnesses (ν,
    // spendRoot, Cx, Cy, source outpoint, set-membership path, spent-IMT insert) are read here, ahead of
    // the per-block tx witnesses, so the assembler/JS mirror MUST emit them in this position. SAFETY rests
    // on two gates enforced ABOVE/outside this loop: (1) COUNT freshness — the eth guest ties consumedNuCount
    // to bitcoinConsumedCount@finalized-slot and the contract's ConsumedCountStale ties it to NOW, so the eth
    // proof covers every recorded consume; (2) the SET-CONTENT anchor just enforced in the mode_b block (the
    // eth proof's priorDigest must continue state.eth_refl_digest), so the consumed set itself is the real
    // accumulation and a forged prior can't slip fake/omitted ν past the count gate.
    if mode_b != 0 {
        let prior_consumed = state.consumed_count;
        assert!(
            consumed_nu_count >= prior_consumed,
            "eth consumed count rolled back"
        );
        for _ in prior_consumed..consumed_nu_count {
            let nu = r32();
            let spend_root = r32();
            let cx = r32();
            let cy = r32();
            let src_txid = r32();
            let src_vout: u32 = io::read();
            let set_path = r_path();
            let (sv, sn, si, sp, snew) = read_spent_insert();
            state.fold_consumed(
                &nu, &spend_root, &cx, &cy, &src_txid, src_vout, &set_path, &consumed_set_root,
                &sv, &sn, si, &sp, &snew,
            ).expect("fast-lane consumed-ν fold (completeness: every consume must mark its source note spent)");
        }
        assert_eq!(
            state.consumed_count, consumed_nu_count,
            "must fold the entire consumed set (completeness)"
        );
    }

    // cBTC per-lock deltas accumulated across the whole batch, surfaced in the public values for the
    // contract's per-lock registry (mint gate) + slash (rug). See ops/DESIGN-confidential-defi-v1.md §3.
    let mut cbtc_folded: Vec<CbtcLockFold> = Vec::new();
    let mut cbtc_spent: Vec<[u8; 32]> = Vec::new();
    let mut cbtc_redeemed: Vec<[u8; 32]> = Vec::new();
    let mut attested_metas: Vec<AssetMeta> = Vec::new();
    // The value-free Bitcoin-call fold pushes (callId, recordHash) pairs here (flat) → contract pendingBtcCall.
    let mut btc_calls_folded: Vec<[u8; 32]> = Vec::new();

    // FULL SCAN: every tx of every block, in order.
    for block_index in 0..(num_headers as usize) {
        let merkle_root = bitcoin::extract_merkle_root(&headers[block_index]);
        let n_tx: u32 = io::read();
        let txs: Vec<Vec<u8>> = (0..n_tx).map(|_| io::read()).collect();
        // Completeness of the tx set: the provided txs ARE the whole block — their txid merkle
        // root equals the header's. So no tx (hence no pool spend) can be silently omitted.
        let txids: Vec<[u8; 32]> = txs
            .iter()
            .map(|t| bitcoin::compute_txid(t))
            .collect::<Option<_>>()
            .expect("malformed tx in block");
        assert_eq!(
            bitcoin::compute_merkle_root_checked(&txids),
            Some(merkle_root),
            "provided txs are not the complete block" // checked: a duplicate-tail alias fails here
        );
        // Block-body shape: tx[0] MUST be a real coinbase and no later tx may be one. This
        // closes the 64-byte merkle-merge: an attacker who mines a [coinbase L, spend R] block can present a
        // fake one-tx block whose sole "tx" C = txid_L‖txid_R matches the header root (C parses as a 64-byte
        // tx), hiding R. C's prevout isn't the null outpoint, so it fails the coinbase check → the fake can't
        // be proven, only the real block can (which scans R). (An n_tx≥2 merge must KEEP the real coinbase to
        // match the root, which pins its committed wtxid root; collapsing any subtree into one 64-byte leaf
        // changes the wtxid tree shape — a leaf where an internal node belongs — so verify_witness_commitment
        // fails. This holds whether the hidden tx is segwit or legacy.)
        assert!(n_tx > 0, "empty block");
        assert!(bitcoin::is_coinbase(&txs[0]), "block tx[0] is not a coinbase");
        for t in txs.iter().skip(1) {
            assert!(!bitcoin::is_coinbase(t), "non-first coinbase in block");
        }
        // BIP141 witness commitment: bind the SegWit WITNESS data too (the txid merkle above commits only
        // the stripped serialization). Tacit envelopes live in the Taproot WITNESS, so without this a
        // prover could keep a real txid and swap the witness for a fake envelope. The commitment lives in
        // the coinbase's TXID-committed outputs, so a present commitment that doesn't match the provided
        // witnesses is tampered (hard reject); envelope extraction is gated on a verified commitment below.
        let tx_refs: Vec<&[u8]> = txs.iter().map(|t| t.as_slice()).collect();
        let witness_committed = match bitcoin::verify_witness_commitment(&tx_refs) {
            Some(true) => true,
            Some(false) => panic!("block witness commitment mismatch (tampered witnesses)"),
            None => false, // non-segwit block: no commitment, hence no witness envelopes to fold
        };
        let height = anchor_height + block_index as u64;
        assert!(
            height >= state.height,
            "reflection height must not decrease"
        );
        // Advance the reflected height NOW (after the monotonicity check), so the per-tx folds — the fair-farm
        // rps accrual in particular — see THIS block's height. Matches the JS assembler, which setHeight()s
        // before its tx loop. (The only loop reader of state.height was the monotonicity check above.)
        state.height = height;

        for (ti, tx) in txs.iter().enumerate() {
            let txid = txids[ti];

            // Vin-scan: every input that hits a live pool UTXO is a spend that MUST be folded. The
            // opening (Cx,Cy) for each is read in vin order and bound to the outpoint's stored
            // commitment inside scan_tx_spends (a forged opening is a hard reject).
            let spends = scan_tx_spends(tx, &mut state.live, || (r32(), r32()))
                .expect("vin scan / opening bind");

            // The Taproot envelope (consensus-bound only when the block's witness commitment verified above;
            // a non-segwit block carries none). Parsed here so the cBTC redeem below runs BEFORE the rug scan.
            // The coinbase (ti == 0) is NEVER an envelope source: BIP-141 fixes its wtxid to zero, so its
            // witness is the one witness in the block the commitment does not bind — a prover could otherwise
            // attach a forged envelope to it while keeping the txid merkle root and witness commitment valid.
            let env = if witness_committed && ti != 0 {
                bitcoin::extract_taproot_envelope(tx)
            } else {
                None
            };

            // cBTC single-tx REDEMPTION (T_CBTC_REDEEM, 0x67) — the honest exit, classified IN-GUEST (no
            // owner attestation). This tx both UNLOCKS a tracked lock AND burns exactly its sats of cBTC in
            // the same tx (Σ C_in = v_btc·H, the audited CXFER burn). Recognized BEFORE the rug scan: a valid
            // redeem retires the lock HERE (off the live set), so fold_cbtc_lock_spends no longer sees it → it
            // never enters cbtcLocksSpent → an honest redeemer is never slashable (closing the slash race
            // trustlessly). The burn inputs are this tx's cBTC note spends, already bound to their stored
            // commitment + asset and nullified by scan_tx_spends. A bare lock spend with no matching in-tx burn
            // stays tracked and folds as a rug below — so a rugger can't spoof a redeem without truly burning
            // the matching cBTC (which IS the honest retirement).
            if let Some(rd) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_cbtc_redeem_envelope(e))
            {
                let cbtc_ins: Vec<_> = spends
                    .iter()
                    .filter(|s| s.asset == CBTC_ZK_ASSET_ID)
                    .collect();
                let in_ops: Vec<([u8; 32], u32)> = cbtc_ins
                    .iter()
                    .map(|s| (s.prev_txid, s.prev_vout))
                    .collect();
                if let (Some(in_pts), Some(tx_ins)) = (
                    cbtc_ins
                        .iter()
                        .map(|s| from_affine_xy(&s.cx, &s.cy))
                        .collect::<Option<Vec<Point>>>(),
                    bitcoin::extract_inputs(tx),
                ) {
                    // On a valid redeem, surface the retired outpoint so the engine's escrow-claim gate is
                    // proof-driven (`outpoint_key` — the same key the lock set / cbtcLocksSpent use).
                    if let Ok(redeemed_op) = state.fold_cbtc_redeem(
                        &rd.lock_txid,
                        rd.lock_vout,
                        rd.v_btc,
                        &tx_ins,
                        &in_ops,
                        &in_pts,
                        &rd.kernel_sig,
                    ) {
                        cbtc_redeemed.push(redeemed_op);
                    }
                }
            }

            // cBTC RUG: a self-custody lock spend NOT matched by a redeem above — any input spending a tracked
            // cBTC.zk lock outpoint drops its sats from the backing and surfaces the spent outpoint for
            // cbtcLocksSpent (the engine slashes it: spent ∧ escrow-not-released ⇒ rug). A plain Bitcoin spend
            // (no Tacit ν), independent of the pool-UTXO scan above, and BEFORE the 0x66 track below so an
            // in-block create-then-spend nets correctly.
            cbtc_spent.extend(state.fold_cbtc_lock_spends(tx));

            // Classify by envelope (`env` parsed above, before the cBTC redeem/rug scan): most txs have none
            // (their spends are plain pool-UTXO spends, still nullified). A burn envelope marks a bridge-out;
            // a cxfer envelope declares output notes.
            let burn = env.as_ref().and_then(|e| bitcoin::parse_burn_envelope(e));
            // CXFER surfaces the kernel sig + range proof too, so the fold can RE-VERIFY value
            // conservation (Σ C_in = Σ C_out) + output range before injecting any note (REFLECT-1).
            let cxfer = env
                .as_ref()
                .and_then(|e| bitcoin::parse_cxfer_envelope_full(e));

            // Fold the detected spends into the spent-set IMT. ν = nullifier(Cx,Cy) is commitment-only (it must
            // match the EVM nullifier the cross-lane non-membership guard checks), so two distinct live UTXOs can
            // share a ν when value+blinding collide (C1=C2) — across the SAME tx, different txs, different blocks,
            // or different proofs. Spending both must NOT double-insert: imt_insert_transition has no straddling
            // low leaf for an already-present ν, so a naive insert returns None and PANICS, bricking the
            // forward-only reflection (a fund-strand DoS). Per spend the witness is REPURPOSED: an already-spent ν
            // arrives with low_value == ν, which is impossible for a real insert (inserts require low_value < ν),
            // so it unambiguously flags a duplicate and the same (low_next, index, path) prove ν is ALREADY a
            // member of spent_root. This is a membership-GATED no-op (the value was nullified by the first spend),
            // NOT a blanket error-swallow: a fresh ν has no such membership (a prover can't drop a genuine first
            // spend), and an already-present ν has no straddling insert witness (it can't take the insert path).
            for s in &spends {
                let (sv, sn, si, sp, snew) = read_spent_insert();
                if sv == s.nu {
                    assert!(
                        imt_membership(&state.spent_root, &s.nu, &sn, si, &sp),
                        "spent-set fold: claimed-duplicate ν is not a member of spent_root"
                    );
                } else {
                    state
                        .fold_spent(&s.nu, &sv, &sn, si, &sp, &snew)
                        .expect("spent-set fold");
                }
            }

            // A bridge-out records ν → destCommitment in the burn set (the burned note is the
            // tx's single detected spend, bound to the envelope's nullifier).
            if let Some((b_asset, env_nu, env_dest)) = &burn {
                if spends.len() == 1 && &spends[0].nu == env_nu {
                    // Reflected-note bridge-out: the burned note is in the live set (this near-tip
                    // reflection saw it created), already nullified above by `fold_spent`. Record ν → dest.
                    // Same commitment-collision DoS as the spent set: two notes sharing a commitment share a
                    // ν, so two bridge-out txs would `fold_burn` the same ν → a naive insert returns None and
                    // PANICS, bricking forward-only reflection. The burn witness is REPURPOSED identically: a
                    // duplicate ν arrives with low_key == ν (impossible for a real insert, which needs
                    // low_key < ν), so it flags an already-present ν and (low_next, low_value, index, path)
                    // prove ν is ALREADY a member of burn_root — a membership-GATED no-op (the first burn
                    // already recorded ν → dest), NOT a blanket error-swallow: a fresh ν has no such
                    // membership, so a prover can't drop a genuine first burn.
                    let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                    if &bk == env_nu {
                        assert!(
                            utxo_membership(&state.burn_root, env_nu, &bn, &bv, bi, &bp),
                            "burn-set fold: claimed-duplicate ν is not a member of burn_root"
                        );
                    } else {
                        state
                            .fold_burn(env_nu, env_dest, &bk, &bn, &bv, bi, &bp, &bnew)
                            .expect("burn-set fold");
                    }
                } else if spends.is_empty() {
                    // BURN-DEPOSIT (scan-free onboarding): the burned note is a PRE-existing, never-reflected
                    // note (no live-set spend). Admit it ONLY if the witness proves it descends from the
                    // asset's etch supply note C_0 through confirmed, conserving CXFERs. The provenance
                    // blocks are pre-anchor, so their canonicity is a header chain whose tip == this batch's
                    // relay-pinned anchor (prev_hash). See ops/DESIGN-trustless-asset-onboarding.md.
                    // ── witnesses (read UNCONDITIONALLY so the io stream stays in sync; fold only if valid) ──
                    // The provenance DAG lives in the burn tx's Taproot witness (appended after the 129-byte
                    // burn envelope) and is committed by the burn tx's wtxid, so the guest reads it from the
                    // wtxid-authenticated witness (env[129..]) in the verify closure below — never from the
                    // proof's private input — which makes the provenance non-discretionary: a prover cannot
                    // substitute a broken DAG for a real burn (that would change the burn txid), and a fake
                    // burn carries its own DAG that fails verification and skips. Only the burn tx's
                    // witness-commitment proof (wtxid path + same-block coinbase) is read here: a real burn tx
                    // is always committed, so a failure is a bad prover witness (abort); a fake burn's witness
                    // is likewise committed, so it passes this auth and is skipped by the provenance check.
                    let n_burn_wsib: u32 = io::read();
                    let burn_wtxid_siblings: Vec<[u8; 32]> = (0..n_burn_wsib).map(|_| r32()).collect();
                    let n_burn_cbsib: u32 = io::read();
                    let burn_cb_txid_siblings: Vec<[u8; 32]> = (0..n_burn_cbsib).map(|_| r32()).collect();
                    assert!(
                        bitcoin::verify_tx_witness_committed(
                            tx,
                            ti as u32,
                            &burn_wtxid_siblings,
                            &txs[0],
                            &burn_cb_txid_siblings,
                            &merkle_root,
                        )
                        .is_some(),
                        "burn-deposit: burn tx witness not committed (bad prover witness)"
                    );
                    let burned_cx = r32();
                    let burned_cy = r32();
                    let (sv, sn, si, sp, snew) = read_spent_insert();
                    let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                    // the proven-real burned note is onboarded as a pool member (so the Ethereum mint binds
                    // v_mint == v_burn via pool-membership + kernel); its note-tree append path is witnessed.
                    let note_path = r_path();

                    // ── verify (all required; any miss → skip, fold nothing) ──
                    let verified = (|| -> Option<()> {
                        // The provenance comes from the burn tx's wtxid-authenticated witness (the bytes after
                        // the 129-byte envelope), so it is exactly what the on-chain burn committed — not a
                        // prover-chosen DAG. A malformed committed blob is a fake burn (skip via None).
                        let pb = burn_deposit::ProvenanceBlob::parse(env.as_ref()?.get(129..)?)?;
                        let prov_headers = pb.headers;
                        let etch_tx = pb.etch_tx;
                        let etch_index = pb.etch_index;
                        let etch_siblings = pb.etch_siblings;
                        let etch_wtxid_siblings = pb.etch_wtxid_siblings;
                        let etch_coinbase = pb.etch_coinbase;
                        let etch_cb_txid_siblings = pb.etch_cb_txid_siblings;
                        #[allow(clippy::type_complexity)]
                        let cmints: Vec<(Vec<u8>, Vec<u8>, Vec<[u8; 32]>, u32, Vec<[u8; 32]>, Vec<u8>, Vec<[u8; 32]>)> =
                            pb.cmints
                                .into_iter()
                                .map(|c| {
                                    (
                                        c.reveal_tx,
                                        c.commit_tx,
                                        c.merkle_siblings,
                                        c.merkle_index,
                                        c.reveal_wtxid_siblings,
                                        c.reveal_coinbase,
                                        c.reveal_cb_txid_siblings,
                                    )
                                })
                                .collect();
                        let prov = pb.prov;
                        // (1) the pre-anchor chain is canonical Bitcoin: valid PoW + tip == this batch's anchor.
                        let refs: Vec<&[u8]> = prov_headers.iter().map(|h| h.as_slice()).collect();
                        if refs.is_empty() || bitcoin::verify_header_chain(&refs)? != prev_hash {
                            return None;
                        }
                        // (2) the etch is a valid CETCH in a canonical block, asset-bound (fixed OR mintable;
                        //     the mint_authority gates the cmints below). C_0 is its supply note.
                        let etch_txid = bitcoin::compute_txid(&etch_tx)?;
                        let (c0_compressed, mint_authority, _dec) =
                            bitcoin::verify_etch_anchor(&etch_tx, b_asset)?;
                        let etch_root =
                            bitcoin::verify_merkle_path(&etch_txid, &etch_siblings, etch_index);
                        if !prov_headers
                            .iter()
                            .any(|h| bitcoin::extract_merkle_root(h) == etch_root)
                        {
                            return None;
                        }
                        // The CETCH (C_0 + mint authority) is read from the etch WITNESS, so bind it to the
                        // block (BIP141), not just txid-merkle inclusion — else a swapped witness with a fake
                        // CETCH would pass and forge the asset's supply anchor / mint authority.
                        bitcoin::verify_tx_witness_committed(
                            &etch_tx,
                            etch_index,
                            &etch_wtxid_siblings,
                            &etch_coinbase,
                            &etch_cb_txid_siblings,
                            &etch_root,
                        )?;
                        // (3) every provenance CXFER's confirmed block root is one of the canonical chain's roots.
                        if !prov.iter().all(|c| {
                            prov_headers
                                .iter()
                                .any(|h| bitcoin::extract_merkle_root(h) == c.confirmed_block_root)
                        }) {
                            return None;
                        }
                        // (3b) valid supply leaves = C_0 + each issuer-authorized cmint output, the cmint reveal
                        //      confirmed in the canonical chain. A fixed-supply asset has mint_authority = 0, so
                        //      verify_cmint_authorized rejects every cmint → leaves = [C_0] (criterion self-enforces).
                        let c0_outpoint = outpoint_key(&etch_txid, 0);
                        let c0_ch = commitment_hash_compressed(&c0_compressed)?;
                        let mut valid_leaves: Vec<([u8; 32], [u8; 32])> =
                            Vec::with_capacity(1 + cmints.len());
                        valid_leaves.push((c0_outpoint, c0_ch));
                        let mut seen_commits: Vec<[u8; 32]> = Vec::with_capacity(cmints.len());
                        for (
                            reveal_tx,
                            commit_tx,
                            msib,
                            midx,
                            reveal_wtxid_siblings,
                            reveal_coinbase,
                            reveal_cb_txid_siblings,
                        ) in &cmints
                        {
                            let reveal_txid = bitcoin::compute_txid(reveal_tx)?;
                            let root = bitcoin::verify_merkle_path(&reveal_txid, msib, *midx);
                            if !prov_headers
                                .iter()
                                .any(|h| bitcoin::extract_merkle_root(h) == root)
                            {
                                return None;
                            }
                            // Replay guard: ONE commit tx authorizes ONE mint. The issuer signature binds the
                            // commit's input anchor but NOT which commit OUTPUT the reveal spends, so two reveals
                            // spending different outputs of the same commit would reuse a single authorization to
                            // mint two supply leaves. Reject a repeated commit (one commit ⇒ one leaf).
                            let commit_txid = bitcoin::compute_txid(commit_tx)?;
                            if seen_commits.contains(&commit_txid) {
                                return None;
                            }
                            seen_commits.push(commit_txid);
                            // The CMINT envelope is read from the reveal's WITNESS — bind it (BIP141). commit_tx
                            // needs no witness auth: it's bound by txid (reveal spends commit_txid) + its inputs.
                            bitcoin::verify_tx_witness_committed(
                                reveal_tx,
                                *midx,
                                reveal_wtxid_siblings,
                                reveal_coinbase,
                                reveal_cb_txid_siblings,
                                &root,
                            )?;
                            valid_leaves.push(burn_deposit::verify_cmint_authorized(
                                b_asset,
                                &mint_authority,
                                &etch_txid,
                                reveal_tx,
                                commit_tx,
                            )?);
                        }
                        // (4) burned note outpoint = the burn tx's first spent input.
                        let inputs = bitcoin::extract_inputs(tx)?;
                        let (bt, bvo) = inputs.first()?;
                        let burned_outpoint = outpoint_key(bt, *bvo);
                        // (5) the burned note descends from a valid supply leaf (C_0 ∪ authorized cmints); the
                        //     provenance DAG authenticates the commitment hash at the outpoint. A burn whose
                        //     outpoint is not reachable from supply is a fake → skip.
                        let real_ch =
                            burn_deposit::verify_provenance_leaves(b_asset, &valid_leaves, &burned_outpoint, &prov)
                                .ok()?;
                        // The note opening is the prover's only remaining discretionary input here. Bind it to
                        // the authenticated commitment: a prover that supplies a wrong opening for a reachable
                        // (confirmed) burn would otherwise have it skipped and the digest advanced past it,
                        // permanently censoring the deposit. A mismatch is a lying prover → abort.
                        assert!(
                            commitment_hash(&burned_cx, &burned_cy) == real_ch,
                            "burn-deposit: opening does not match the authenticated provenance commitment (bad prover witness)"
                        );
                        // The envelope ν must equal the burned note's real ν; an inconsistent on-chain burn is
                        // malformed (a tx-validity fact, deterministic for every prover) → skip.
                        if &nullifier(&burned_cx, &burned_cy) != env_nu {
                            return None;
                        }
                        Some(())
                    })();
                    if verified.is_some() {
                        // A VERIFIED burn-deposit must be recorded or the proof rejected — never silently
                        // omitted, else its confirmed-on-Bitcoin burn never reaches `bitcoinBurnRoot`/the pool
                        // tree and the Ethereum bridge mint is permanently blocked. Mirror the main spent loop's
                        // duplicate-vs-fresh discipline: a FRESH ν whose insert witness fails is a malicious
                        // prover → ABORT; a genuine duplicate ν (re-presented bridge / ν-collision) is a
                        // membership-gated no-op (already recorded in both spent + burn). The earlier `.is_ok()`
                        // skip let a bad fresh witness drop a valid burn-deposit.
                        // SPENT side: a genuine spent-duplicate ν is a membership-gated no-op; a FRESH ν must
                        // insert (a bad witness → abort).
                        if sv == *env_nu {
                            assert!(
                                imt_membership(&state.spent_root, env_nu, &sn, si, &sp),
                                "burn-deposit: claimed spent-duplicate ν is not a member of spent_root"
                            );
                        } else {
                            state
                                .fold_spent(env_nu, &sv, &sn, si, &sp, &snew)
                                .expect("burn-deposit: spent insert (bad prover witness)");
                        }
                        // BURN + note side, INDEPENDENT of the spent side: a ν may already be recorded in
                        // spent_root yet ABSENT from burn_root — a commitment-collision ν, or a ν that was spent
                        // normally before this burn-deposit — so gating the burn record on spent-freshness dropped
                        // a valid fresh burn, permanently blocking its OP_BRIDGE_MINT. Mirror the reflected-burn
                        // replay gate independently: a genuine burn-duplicate (bk == env_nu) is a membership-gated
                        // no-op (note already appended by the first burn); otherwise record the burn AND append
                        // the note whenever the BURN is fresh (a bad fresh witness → abort, never skip).
                        if bk == *env_nu {
                            assert!(
                                utxo_membership(&state.burn_root, env_nu, &bn, &bv, bi, &bp),
                                "burn-deposit: claimed burn-duplicate ν is not a member of burn_root"
                            );
                        } else {
                            // Append the burned note to the pool tree with the SAME leaf shape a reflected note
                            // uses — leaf(asset, Cx, Cy, 0) — so OP_BRIDGE_MINT proves its membership and the
                            // kernel binds v_mint == v_burn (the burned value is REAL: verify_provenance_leaves
                            // proved it descends from supply). Append-only (never live): the note is spent now,
                            // not in-pool-spendable. This makes a burn-deposit mint identical to a reflected one.
                            let note_leaf = leaf(b_asset, &burned_cx, &burned_cy, &[0u8; 32]);
                            state
                                .fold_note_append(&note_leaf, &note_path)
                                .expect("burn-deposit note append");
                            state
                                .fold_burn(env_nu, env_dest, &bk, &bn, &bv, bi, &bp, &bnew)
                                .expect("burn-deposit burn fold");
                            // The etch was BIP141 witness-committed + canonical above, so its declared
                            // (ticker, decimals, cid) are authentic — surface them once for attest to
                            // lazy-register the asset's canonical ERC20 (idempotent on the contract).
                            if !attested_metas.iter().any(|m| m.assetId.0 == *b_asset) {
                                // The etch tx lives in the same wtxid-authenticated witness blob the provenance
                                // verified from (parse succeeds here since the fold only runs after it verified).
                                if let Some(meta_env) = env
                                    .as_ref()
                                    .and_then(|e| e.get(129..))
                                    .and_then(burn_deposit::ProvenanceBlob::parse)
                                    .and_then(|pb| bitcoin::extract_taproot_envelope(&pb.etch_tx))
                                {
                                    if let Some((ticker, tlen, decimals, cid)) =
                                        bitcoin::parse_etch_meta(&meta_env)
                                    {
                                        attested_metas.push(AssetMeta {
                                            assetId: (*b_asset).into(),
                                            ticker: ticker.into(),
                                            tickerLen: tlen,
                                            decimals,
                                            cid: cid.into(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // A burn envelope that spends live pool notes but does not bind exactly one of those
                    // spends by ν is not a reflected bridge-out and is not a scan-free burn-deposit. The
                    // live spends were already nullified above; read no burn-deposit witnesses and fold no
                    // burn entry. This keeps malformed / multi-live-spend burns skip-not-panic and preserves
                    // the witness stream (matching the JS assembler).
                }
            }

            // A cxfer tx's outputs are new pool notes — but ONLY if the tx CONSERVES value. fold_cxfer
            // re-verifies the BIP-340 kernel + the BP+ range over the detected pool-note inputs (Σ C_in,
            // from the scan) and the envelope's outputs BEFORE appending any note, so a confirmed-but-
            // non-conserving tx (Bitcoin never checks the Tacit kernel) cannot inject unbacked, cross-
            // lane-spendable pool value (REFLECT-1). Each output note leaf is DERIVED from the envelope
            // (never a free witness), its outpoint added to the live set for later spends in the batch.
            if let Some((asset, kernel_sig, commitments, range_proof)) = &cxfer {
                let in_outpoints: Vec<([u8; 32], u32)> =
                    spends.iter().map(|s| (s.prev_txid, s.prev_vout)).collect();
                let in_points: Vec<Point> = spends
                    .iter()
                    .map(|s| from_affine_xy(&s.cx, &s.cy).expect("input commitment xy"))
                    .collect();
                let in_assets: Vec<[u8; 32]> = spends.iter().map(|s| s.asset).collect();
                // Asset preservation: every spent note must be of the envelope's declared asset. A
                // value-only conserving CXFER that RELABELS a cheap-asset note as a dear one is junk
                // here, exactly like a non-conserving one — it injects no notes and carries NO output
                // witnesses in the stream, so we read none and skip it (its spends are still nullified
                // above; the relabel just burns the attacker's input). The JS assembler gates on the
                // SAME predicate, so the witness stream stays in sync.
                let asset_preserving = in_assets.iter().all(|a| a == asset);
                // Conservation gate (REFLECT-1): a confirmed-but-non-conserving CXFER injects no notes
                // and carries no output witnesses — read none, skip (a SKIP, not a panic, so a griefed
                // envelope can't wedge the prover). Conserving + asset-preserving cxfers read their
                // witnesses and fold; a fold error there is a real witness bug (panics).
                // Derive each output's REAL Bitcoin vout from the opcode's canonical tx layout (the single
                // convention commitmentForUtxo resolves by) — NOT the output index. Identity for
                // T_CXFER/T_CXFER_BPP/T_AXFER/T_AXFER_BPP, but the INTERLEAVED {0->0,1->2} for the
                // variable-amount atomic settlement T_AXFER_VAR/T_AXFER_VAR_BPP (vout 1 is the maker BTC
                // payment). Keying the maker-change note at the index (vout 1) instead of its true outpoint
                // (vout 2) would drop it from the live set, so its later real Bitcoin spend goes UNDETECTED
                // — a cross-lane double-spend. A witnessed vout is never trusted; only the note-tree append
                // path stays witnessed. A malformed layout (canonical None for some index) is skip-not-panic
                // (fold nothing, read no paths), exactly like the non-conserving case, so the JS assembler
                // gating on the SAME predicate keeps the witness stream in sync.
                let opcode = env.as_ref().map(|e| e[0]).unwrap_or(0);
                let canon_vouts: Option<Vec<u32>> = (0..commitments.len())
                    .map(|i| cxfer_core::canonical_output_vout(opcode, i, commitments.len()))
                    .collect();
                if asset_preserving
                    && canon_vouts.is_some()
                    && verify_cxfer_conservation(
                        asset,
                        &in_outpoints,
                        &in_points,
                        commitments,
                        range_proof,
                        kernel_sig,
                    )
                {
                    let vouts = canon_vouts.expect("canon_vouts is_some checked");
                    let mut paths: Vec<Vec<[u8; 32]>> = Vec::with_capacity(commitments.len());
                    for _ in 0..commitments.len() {
                        paths.push(r_path());
                    }
                    state
                        .fold_cxfer(
                            asset,
                            &in_outpoints,
                            &in_points,
                            &in_assets,
                            &txid,
                            commitments,
                            &paths,
                            &vouts,
                            range_proof,
                            kernel_sig,
                        )
                        .expect("cxfer fold");
                }
            }

            // Mode B: an Ethereum→Bitcoin cross-out mint (T_CROSSOUT_MINT, 0x65). Fold the minted note
            // ONLY if it's a member of the eth-reflection crossOutSet (verified at the top of main). A
            // spend-less mint (no pool inputs to nullify). Witnesses are read for EVERY 0x65 tx (the
            // assembler provides a set per 0x65, bogus for non-members) so the stream stays in sync; a
            // non-member folds nothing (skip-not-panic, like a non-conserving cxfer).
            if let Some((co_asset, claim_id, cx, cy, _owner)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_crossout_mint_envelope(e))
            {
                // Cross-out replay is closed at the CONTRACT, not here: the unconditional crossOutCount freshness gate
                // (attest: r.crossOutCount == crossOutCount) rejects any batch whose reflected crossOutCount
                // lags the on-chain count. Once a cross-out is recorded (crossOutCount > 0), a forward batch
                // (mode_b == 0 ⇒ committed crossOutCount 0) can no longer attest, so this 0x65 must ride a
                // Mode-B batch whose set is complete (the eth guest asserts count == on-chain count) and the
                // confirmed mint folds. When crossOutCount == 0 no real cross-out exists, so a 0x65 here is a
                // fake and correctly folds nothing as a non-member (skip-not-panic — never stall a forward scan).
                // Cross-out IMT presence witness (read per 0x65 for stream sync). `is_member` selects a
                // membership proof (→ fold the confirmed mint) or a non-membership proof (→ skip a fake 0x65);
                // a lying claim aborts inside fold_crossout. `m_next` = the leaf's successor (membership) or
                // the straddling low leaf's successor (non-membership); `m_low_value` = the low leaf's value
                // (non-membership only).
                let is_member: u32 = io::read();
                let m_next = r32();
                let m_low_value = r32();
                let m_index: u64 = io::read();
                let m_path = r_path();
                let note_path = r_path();
                // The consumed-cross-out (claim_id) IMT insert witness — read for EVERY 0x65 tx so the stream
                // stays in sync (a replay's already-present claim_id has no valid witness → the mint skips).
                let (clv, cln, cli, clp, cnp) = read_spent_insert();
                // vout 0 = the mint's single confidential output (the dapp's T_CROSSOUT_MINT layout).
                let _ = state.fold_crossout(
                    &co_asset,
                    &claim_id,
                    &cx,
                    &cy,
                    is_member != 0,
                    &m_next,
                    &m_low_value,
                    m_index,
                    &m_path,
                    &crossout_set_root,
                    &txid,
                    0,
                    &note_path,
                    &clv,
                    &cln,
                    cli,
                    &clp,
                    &cnp,
                );
            }

            // cBTC.zk: a real-BTC self-custody lock (T_CBTC_LOCK, 0x66). TRACK it (no note minted here) if
            // the envelope tx has, at lock_vout != 0, a confirmed self-custody lock output (the locker's OWN
            // output, any scriptPubKey) of value v_btc. The cBTC note is minted later by
            // ConfidentialPool.mintCbtc — gated on this lock (surfaced in cbtcLocksFolded) + a native-ETH
            // escrow, where the value-opening (note == v_btc) is checked. A later spend of the lock is a rug
            // caught by fold_cbtc_lock_spends above. No witness is read per 0x66 (track-not-mint appends no
            // note); a wrong-asset / duplicate / vout-0 lock folds nothing (skip-not-panic). See
            // ops/DESIGN-confidential-defi-v1.md §3. cf. cxfer-core::ScanReflection::fold_cbtc_lock.
            if let Some(cb) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_cbtc_lock_envelope(e))
            {
                if let Ok(f) =
                    state.fold_cbtc_lock(&cb.asset, &cb.cx, &cb.cy, tx, cb.lock_vout, &txid)
                {
                    cbtc_folded.push(f);
                }
            }

            // Value-free Bitcoin-authorized call (T_BTC_CALL, 0x68): a confirmed, Schnorr-signed Bitcoin tx
            // that authorizes an arbitrary Ethereum call carrying NO value. fold_btc_call verifies the BIP-340
            // sig by caller_pubkey over the domain-tagged call binding, then returns (callId, recordHash) —
            // surfaced as a flat pair for ConfidentialPool.attest → pendingBtcCall, fired by the off-pool
            // BtcCallExecutor (never inline, so a hostile target can't revert this attest). No note, no mint.
            // Witness-carried like every Tacit envelope (authenticated by the BIP141 commitment gate above);
            // a bad/absent sig folds nothing (skip-not-panic). SPEC-BITCOIN-HOOK-AMENDMENT §1.4.
            if let Some((call_id, record_hash)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_btc_call_envelope(e))
                .and_then(|c| cxfer_core::fold_btc_call(&c))
            {
                btc_calls_folded.push(call_id);
                btc_calls_folded.push(record_hash);
            }

            // Track A: an orderbook bid fill (T_PREAUTH_BID_VAR, 0x5C) is a CXFER on the tacit-asset side —
            // the seller's asset inputs (the only pool-UTXO spends; the buyer pre-funds in native sats)
            // conserve into the buyer's filled note + the seller's change under tacit-kernel-v1, with one
            // aggregated BP+ range over all outputs. So fold it EXACTLY like a cxfer: re-verify Σ C_in =
            // Σ C_out + range BEFORE onboarding any output note (REFLECT-1 discipline). This onboards the
            // buyer's filled note (the bridgeable one) + the seller's change. Handles BOTH the partial-fill
            // (T_PREAUTH_BID_VAR 0x5C) and the exact-fill (T_PREAUTH_BID 0x5B) walk-away bids — same
            // CXFER-family conservation, only the inline differs. OTC + the other atomic-settlement variants
            // (T_AXFER 0x26 / 0x37 / 0x3C / 0x3D) need NO branch here — parse_cxfer_envelope_full accepts
            // them, so the cxfer fold above handles them.
            if let Some((bid_asset, bid_kernel_sig, bid_commitments, bid_range_proof)) =
                env.as_ref().and_then(|e| {
                    bitcoin::parse_preauth_bid_var_envelope(e)
                        .or_else(|| bitcoin::parse_preauth_bid_envelope(e))
                })
            {
                let in_outpoints: Vec<([u8; 32], u32)> =
                    spends.iter().map(|s| (s.prev_txid, s.prev_vout)).collect();
                let in_points: Vec<Point> = spends
                    .iter()
                    .map(|s| from_affine_xy(&s.cx, &s.cy).expect("bid input commitment xy"))
                    .collect();
                let in_assets: Vec<[u8; 32]> = spends.iter().map(|s| s.asset).collect();
                let asset_preserving = in_assets.iter().all(|a| a == &bid_asset);
                // DERIVE each output's REAL Bitcoin vout from the bid opcode's canonical layout (the convention
                // getParentEnvelopeData resolves by) — NOT a flat +1 offset, which mis-keyed BOTH the buyer
                // filled note (true vout 0, not 1) and the seller change (true vout 3, or 4 with a buyer
                // refund — never 2). A witnessed/wrong vout would key a note off its real outpoint, so a later
                // spend misses the live set. Skip-not-panic on an unmapped index, like the conservation gate.
                let bid_opcode = env.as_ref().map(|e| e[0]).unwrap_or(0);
                let bid_has_refund = env
                    .as_ref()
                    .and_then(|e| bitcoin::preauth_bid_var_has_refund(e))
                    .unwrap_or(false);
                let bid_vouts: Option<Vec<u32>> = (0..bid_commitments.len())
                    .map(|i| cxfer_core::canonical_bid_output_vout(bid_opcode, i, bid_commitments.len(), bid_has_refund))
                    .collect();
                if asset_preserving
                    && bid_vouts.is_some()
                    && verify_cxfer_conservation(
                        &bid_asset,
                        &in_outpoints,
                        &in_points,
                        &bid_commitments,
                        &bid_range_proof,
                        &bid_kernel_sig,
                    )
                {
                    // Note-tree append paths are witnessed; vouts are DERIVED from the canonical bid layout above.
                    let vouts = bid_vouts.expect("bid_vouts is_some checked");
                    let mut paths: Vec<Vec<[u8; 32]>> = Vec::with_capacity(bid_commitments.len());
                    for _ in 0..bid_commitments.len() {
                        paths.push(r_path());
                    }
                    state
                        .fold_cxfer(
                            &bid_asset,
                            &in_outpoints,
                            &in_points,
                            &in_assets,
                            &txid,
                            &bid_commitments,
                            &paths,
                            &vouts,
                            &bid_range_proof,
                            &bid_kernel_sig,
                        )
                        .expect("bid fold");
                }
            }

            // Track B: a T_SWAP_VAR (0x32) onboards the taker's RECEIPT (+ change) as real, bridgeable notes
            // against a c0_backed pool whose tracked reserves match the swap's declared R_pre. fold_swap_var
            // re-verifies the input-side kernel + the receipt opening + the out-reserve floor BEFORE onboarding
            // (skip-not-panic). The pool reserve is registry state (not a live UTXO), so the taker's c_in is
            // the only detected pool-UTXO spend.
            if let Some(sv) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_swap_var_envelope(e))
            {
                let is_sentinel = sv.c_change_or_sentinel.iter().all(|&b| b == 0);
                // Witnesses read UNCONDITIONALLY per 0x32 (stream sync): the receipt's append path (vout 1) +
                // the change's (vout 2), the latter only when non-sentinel — both deterministic from the envelope.
                let receipt_path = r_path();
                let change_path = if !is_sentinel { Some(r_path()) } else { None };
                if spends.len() == 1 {
                    let s = &spends[0];
                    // c_in must be the REAL spent note (so delta_in is backed by the real input value).
                    let c_in_real = matches!(
                        (from_affine_xy(&s.cx, &s.cy), decompress(&sv.c_in)),
                        (Some(x), Some(y)) if x == y
                    );
                    if c_in_real {
                        if let Some(mut pool) = state.pools.get(&sv.pool_id) {
                            // fold_swap_var now onboards the receipt AND the taker's change atomically (the
                            // change at vout 2, iff c_change is non-sentinel) — so a bad change path skips the
                            // whole swap instead of dropping the change after the receipt + reserves committed.
                            if state
                                .fold_swap_var(
                                    &mut pool,
                                    &sv,
                                    (s.prev_txid, s.prev_vout),
                                    &s.asset,
                                    &outpoint_key(&txid, 1),
                                    &receipt_path,
                                    &outpoint_key(&txid, 2),
                                    change_path.as_deref().unwrap_or(&[]),
                                )
                                .is_ok()
                            {
                                state.pools.update(&sv.pool_id, pool);
                            }
                        }
                    }
                }
            }

            // Track B: a T_SWAP_ROUTE (0x33) is the multi-hop sibling of T_SWAP_VAR — the trader's single
            // real input note flows through up to 4 pools and lands as ONE receipt note (public r_receipt, no
            // circuit). fold_swap_route validates the whole value chain + every hop's reserve floor BEFORE
            // onboarding the receipt + advancing reserves (all-or-nothing, skip-not-panic). The trader's c_in is
            // the only detected pool-UTXO spend (pool reserves are registry state).
            if let Some(rt) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_swap_route_envelope(e))
            {
                let receipt_path = r_path(); // witnessed per 0x33 (the receipt note's append path; vout 1)
                if spends.len() == 1 {
                    let s = &spends[0];
                    let c_in_real = matches!(
                        (from_affine_xy(&s.cx, &s.cy), decompress(&rt.c_in)),
                        (Some(x), Some(y)) if x == y
                    );
                    if c_in_real {
                        let _ = state.fold_swap_route(
                            &rt,
                            (s.prev_txid, s.prev_vout),
                            &s.asset,
                            &outpoint_key(&txid, 1),
                            &receipt_path,
                        );
                    }
                }
            }

            // Track C: a T_SWAP_BATCH (0x2F) onboards every receipt of a confidential uniform-clearing batch as
            // a real, bridgeable note — gated by the BN254 Groth16 (per-receipt split), the aggregate Pedersen
            // identity (the receipts' total vs the traders' real inputs + the c0-backed reserve), and the
            // per-receipt cross-curve sigma (secp note ↔ Groth16-proven BabyJubJub value). The v1 wire format
            // has no optional block, so the layout is fixed.
            if let Some(sb) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_swap_batch_envelope(e))
            {
                // Witnessed per 0x2F (stream sync): one append path per receipt (the notes at vouts 1..=n).
                let receipt_paths: Vec<Vec<[u8; 32]>> =
                    (0..sb.n_intents).map(|_| r_path()).collect();
                let _ =
                    swap_batch::fold_swap_batch(&mut state, &sb, &txid, &spends, &receipt_paths);
            }

            // Track B: a T_LP_ADD / POOL_INIT (0x2D) establishes or grows a pool's c0_backed reserves. The
            // LP's per-asset inputs are detected live spends; fold_lp_add verifies both per-asset kernels +
            // (for POOL_INIT) inserts the pool / (for LP-add) grows its reserves + shares. Everything is mapped
            // to CANONICAL asset order — pools + pool_id derivation are canonical (worker convention). NB the
            // per-asset kernel must be the one the dapp signed in canonical order; confirm on the box.
            if let Some(la) = env.as_ref().and_then(|e| bitcoin::parse_lp_add_envelope(e)) {
                // The share-note blinding is now ON-CHAIN (la.share_r, option a) — only the share note's
                // append path remains a witness. So per 0x2D the assembler emits exactly one r_path().
                let share_path = r_path();
                if let Some((ca, cb)) = amm_canonical_pair(&la.asset_a, &la.asset_b) {
                    let swapped = la.asset_a != ca;
                    let (da_c, db_c) = if swapped {
                        (la.delta_b, la.delta_a)
                    } else {
                        (la.delta_a, la.delta_b)
                    };
                    let (ka_c, kb_c) = if swapped {
                        (la.kernel_sig_b, la.kernel_sig_a)
                    } else {
                        (la.kernel_sig_a, la.kernel_sig_b)
                    };
                    // Group the detected live spends by canonical asset side (pid-INDEPENDENT — needed to
                    // disambiguate which same-pair pool this add targets).
                    let coll = |asset: &[u8; 32]| -> (Vec<([u8; 32], u32)>, Vec<Point>) {
                        let mut ops = Vec::new();
                        let mut pts = Vec::new();
                        for s in spends.iter().filter(|s| &s.asset == asset) {
                            ops.push((s.prev_txid, s.prev_vout));
                            pts.push(from_affine_xy(&s.cx, &s.cy).expect("lp_add input xy"));
                        }
                        (ops, pts)
                    };
                    let (a_ops, a_pts) = coll(&ca);
                    let (b_ops, b_pts) = coll(&cb);
                    let pool_id = if la.variant == 1 {
                        // 6-arg pool_id: a protocol-fee / capability-flagged pool gets a DISTINCT pool_id from
                        // the canonical no-skim slot (matching the worker), so it's findable for swaps + claims.
                        amm_derive_pool_id_full(
                            &ca,
                            &cb,
                            la.fee_bps,
                            la.capability_flags,
                            &la.protocol_fee_address,
                            la.protocol_fee_bps,
                        )
                    } else {
                        // variant-0 carries NO pool identity, so select the same-pair candidate whose BOTH
                        // per-asset LP-add kernels verify (the kernel sig binds pool_id, so at most one matches)
                        // — mirror fold_lp_remove's disambiguation. Picking `.first()` would fail the kernels
                        // for a victim adding to a non-first same-pair pool AFTER the vin-scan already nullified
                        // its input notes → user fund loss.
                        state
                            .pools
                            .pool_ids_for_assets(&ca, &cb)
                            .into_iter()
                            .find(|pid| {
                                cxfer_core::lp_add_kernel_verify(
                                    0, pid, &ca, da_c, la.share_amount, &la.share_csecp, &a_ops, &a_pts, &ka_c,
                                ) && cxfer_core::lp_add_kernel_verify(
                                    0, pid, &cb, db_c, la.share_amount, &la.share_csecp, &b_ops, &b_pts, &kb_c,
                                )
                            })
                    };
                    if let Some(pid) = pool_id {
                        let pre_shares = state.pools.get(&pid).map(|p| p.total_shares).unwrap_or(0);
                        let pre_accrued = state
                            .pools
                            .get(&pid)
                            .map(|p| p.protocol_fee_accrued)
                            .unwrap_or(0);
                        // Snapshot the pool entry (None for POOL_INIT) to revert fold_lp_add if the share
                        // commitment is semantically invalid (see below).
                        let pre_pool = state.pools.get(&pid);
                        // inputs_c0_backed: every contribution is a detected live (real) spend → C0-backed.
                        if state
                            .fold_lp_add(
                                la.variant,
                                &pid,
                                &ca,
                                &cb,
                                da_c,
                                db_c,
                                la.share_amount,
                                &la.share_csecp,
                                &a_ops,
                                &a_pts,
                                &ka_c,
                                &b_ops,
                                &b_pts,
                                &kb_c,
                                true,
                                la.protocol_fee_bps,
                            )
                            .is_ok()
                        {
                            // Onboard the LP's minted share note so LP-remove can later burn it AND it bridges.
                            // The LP's shares = the total_shares delta this op produced (founder's isqrt−ML at
                            // POOL_INIT; minted at LP-add). The share note is at the LP-add tx's share output —
                            // confirm the exact share vout on the box (a wrong vout is fail-closed: LP-remove
                            // can't detect the share, never an over-mint).
                            if let Some(p) = state.pools.get(&pid) {
                                let lp_shares = if la.variant == 1 {
                                    p.total_shares
                                        .saturating_sub(cxfer_core::AMM_MINIMUM_LIQUIDITY)
                                } else {
                                    // The total_shares delta includes the protocol-fee shares crystallized
                                    // inside fold_lp_add (added to BOTH total_shares and protocol_fee_accrued).
                                    // Those belong to the fee recipient and are onboarded separately by
                                    // fold_protocol_fee_claim — exclude them so the LP's note carries only its
                                    // own freshly minted shares (else the crystallized shares mint twice).
                                    let crystallized =
                                        p.protocol_fee_accrued.saturating_sub(pre_accrued);
                                    p.total_shares
                                        .saturating_sub(pre_shares)
                                        .saturating_sub(crystallized)
                                };
                                // T_LP_ADD (0x2D) carries its envelope in the Taproot WITNESS — NO OP_RETURN
                                // at vout 0 — so the LP-share note is the FIRST output, at vout 0 (the
                                // authoritative getParentEnvelopeData T_LP_ADD arm rejects any vout != 0).
                                // Keying it at vout 1 dropped it from the live set, so a later real spend of
                                // the share at (txid,0) went undetected → cross-lane double-spend.
                                // The share commitment is TX-CONTROLLED — the LP-add kernel binds
                                // share_csecp but does NOT prove it opens to the reflection-computed lp_shares —
                                // so a griefer can sign a funding-valid LP-add with a malformed share (zero
                                // shares / non-curve / wrong opening). Those are SEMANTIC failures of the LP's
                                // own tx, NOT a prover-witness failure: validate them HERE and, on failure,
                                // restore the pool registry + SKIP (the malformed input is forfeit, but the
                                // block still reflects — an abort here would be too wide and a confirmed bad
                                // LP-add would have stalled the forward chain forever). ONLY after the semantics
                                // pass is the remaining note-append a deterministic witness; a failure there is
                                // a malicious/buggy prover, so THAT aborts (never strand a valid
                                // op's already-nullified input).
                                let share_valid = lp_shares > 0
                                    && decompress(&la.share_csecp)
                                        .map(|pt| {
                                            cxfer_core::verify_pedersen_opening(
                                                &pt,
                                                lp_shares,
                                                &cxfer_core::scalar_reduce_be(&la.share_r),
                                            )
                                        })
                                        .unwrap_or(false);
                                if share_valid {
                                    state
                                        .fold_lp_share_mint(
                                            &pid,
                                            lp_shares,
                                            &la.share_csecp,
                                            &la.share_r,
                                            &share_path,
                                            &outpoint_key(
                                                &txid,
                                                cxfer_core::canonical_amm_output_vout(0x2D, 0)
                                                    .expect("lp_add share vout"),
                                            ),
                                        )
                                        .expect("lp_add: share-note append failed after valid share semantics (bad prover witness)");
                                } else {
                                    match &pre_pool {
                                        Some(old) => state.pools.update(&pid, old.clone()),
                                        None => state.pools.remove(&pid),
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Track B: a T_LP_REMOVE (0x2E) — the LP burns LP-shares (the detected lp_asset spends) and
            // withdraws the proportional (delta_a, delta_b); fold_lp_remove onboards the withdrawn notes
            // (each bound to its PUBLIC delta_X by a witnessed blinding) + draws down reserves/shares. The
            // envelope carries no fee_bps, so the pool is found by canonical-asset enumeration + disambiguated
            // by which candidate's pool_id makes the share-burn kernel verify.
            if let Some(lr) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_lp_remove_envelope(e))
            {
                // The two recv-note blindings are now ON-CHAIN (lr.r_recv_a/b, option a) — only the two
                // append paths remain witnesses. So per 0x2E the assembler emits exactly two r_path()s.
                let recv_a_path = r_path();
                let recv_b_path = r_path();
                if let Some((ca, cb)) = amm_canonical_pair(&lr.asset_a, &lr.asset_b) {
                    let swapped = lr.asset_a != ca;
                    let (da_c, db_c) = if swapped {
                        (lr.delta_b, lr.delta_a)
                    } else {
                        (lr.delta_a, lr.delta_b)
                    };
                    let (recv_ca, recv_cb) = if swapped {
                        (lr.recv_b_secp, lr.recv_a_secp)
                    } else {
                        (lr.recv_a_secp, lr.recv_b_secp)
                    };
                    let (rca, rcb) = if swapped {
                        (lr.r_recv_b, lr.r_recv_a)
                    } else {
                        (lr.r_recv_a, lr.r_recv_b)
                    };
                    // Find the pool whose pool_id makes the share-burn kernel verify (one V1 candidate per pair).
                    // Only inputs whose STORED asset is this pool's LP-share asset are eligible to be burned as
                    // shares (mirrors fold_lp_add's per-asset filter): the kernel is asset-blind, so without the
                    // filter a value-equal non-LP note could be burned as LP shares to withdraw real reserves.
                    for pid in state.pools.pool_ids_for_assets(&ca, &cb) {
                        let lp_asset = cxfer_core::amm_derive_lp_asset_id(&pid);
                        let mut lp_ops = Vec::new();
                        let mut lp_pts = Vec::new();
                        for s in spends.iter().filter(|s| s.asset == lp_asset) {
                            lp_ops.push((s.prev_txid, s.prev_vout));
                            lp_pts.push(from_affine_xy(&s.cx, &s.cy).expect("lp_remove input xy"));
                        }
                        if cxfer_core::lp_remove_kernel_verify(
                            &pid,
                            lr.share_amount,
                            da_c,
                            db_c,
                            &recv_ca,
                            &recv_cb,
                            &lp_ops,
                            &lp_pts,
                            &lr.kernel_sig,
                        ) {
                            // T_LP_REMOVE (0x2E) carries its envelope in the Taproot WITNESS — NO OP_RETURN at
                            // vout 0 — so the two withdrawn notes are the FIRST outputs: recvA @vout 0, recvB
                            // @vout 1 (the authoritative getParentEnvelopeData T_LP_REMOVE arm maps exactly
                            // {0->recvA, 1->recvB}). Keying them at vout 1/2 dropped them from the live set, so
                            // a later real spend at (txid,0)/(txid,1) went undetected → cross-lane double-spend.
                            let _ = state.fold_lp_remove(
                                &pid,
                                lr.share_amount,
                                da_c,
                                db_c,
                                &recv_ca,
                                &rca,
                                &recv_cb,
                                &rcb,
                                &lp_ops,
                                &lp_pts,
                                &lr.kernel_sig,
                                &recv_a_path,
                                &outpoint_key(
                                    &txid,
                                    cxfer_core::canonical_amm_output_vout(0x2E, 0).expect("lp_remove recvA vout"),
                                ),
                                &recv_b_path,
                                &outpoint_key(
                                    &txid,
                                    cxfer_core::canonical_amm_output_vout(0x2E, 1).expect("lp_remove recvB vout"),
                                ),
                            );
                            break;
                        }
                    }
                }
            }

            // Track B: a T_FARM_INIT (0x34) establishes a farm treasury as a C0-backed reserve. The launcher's
            // reward-asset input (the single detected spend) funds reward_total into the (virtual) treasury
            // under the swap-shape kernel; fold_farm_init registers it keyed by farm_id. A later T_LP_HARVEST
            // draws reward notes from it.
            if let Some(fi) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_farm_init_envelope(e))
            {
                if spends.len() == 1 {
                    let s = &spends[0];
                    if s.asset == fi.reward_asset {
                        if let Some(c_in_pt) = from_affine_xy(&s.cx, &s.cy) {
                            let c_in = compress(&c_in_pt);
                            let farm_id = amm_derive_farm_id(
                                &fi.pool_id,
                                &fi.launcher_pubkey,
                                &fi.reward_asset,
                                &fi.farm_nonce,
                            );
                            // Pre-validate the campaign window BEFORE inserting the treasury so a malformed
                            // [start, end] skips the WHOLE init (treasury + reward-state commit atomically).
                            // Otherwise fold_farm_init_rewards would reject end<=start AFTER fold_farm_init
                            // committed the treasury — stranding a funded farm with no reward state, and the
                            // farm_id un-retryable (fold_farm_init rejects the duplicate).
                            let window_ok = fi.end_height == 0 || fi.end_height > fi.start_height;
                            // inputs_c0_backed: the launcher's funding input is a detected live (real) spend.
                            if window_ok
                                && state
                                    .fold_farm_init(
                                        &farm_id,
                                        &fi.reward_asset,
                                        fi.reward_total,
                                        (s.prev_txid, s.prev_vout),
                                        &c_in,
                                        &fi.c_change_or_sentinel,
                                        &fi.kernel_sig,
                                        true,
                                    )
                                    .is_ok()
                            {
                                // Farm (SPEC-CONTROLLER-VAULT-AMENDMENT §8.4): register the reward-per-share
                                // accumulator with the envelope's `reward_per_block` rate — the harvest bounds
                                // the reward against this rps. The window is pre-validated, so this can't fail
                                // on it after the treasury committed (the `let _` stays a clean all-or-nothing).
                                let _ = state.fold_farm_init_rewards(&farm_id, fi.reward_per_block, &fi.launcher_pubkey, &fi.pool_id, fi.start_height as u64, fi.end_height as u64);
                            }
                        }
                    }
                }
            }

            // Track B: a T_LP_BOND (0x35) locks LP-share notes into a farm position. The trustless receipt
            // model (SPEC-CONTROLLER-VAULT-AMENDMENT §4): accrue the farm, add `bond_amount` to `total_shares`,
            // and append the owner-blinded RECEIPT note committing `(shares, rps_entry = live rps, owner,
            // nonce)`. `rps_entry` is computed in-fold (the envelope's `entry_acc_per_share` is IGNORED — no
            // backdating). The `(owner, nonce, receipt append path)` are witnessed. The farm must be registered
            // (FARM_INIT). NOTE (prove-validated refinement): `bond_amount` is bound to the spent LP-share value
            // by the bond's homomorphic kernel + BP+ tail (the confidential spends carry no plaintext value);
            // that kernel check rides the AMM-kernel layer, not folded here — this branch is the receipt+rps
            // bookkeeping against the verified `fold_lp_bond`.
            if let Some((farm_id, _bonder_pubkey, bond_amount, _entry_acc, _view_h, owner, nonce, kernel_sig)) =
                env.as_ref().and_then(|e| bitcoin::parse_lp_bond_fields_full(e))
            {
                // owner + nonce ride the PUBLIC envelope (blinded pubkey+b·G, fresh b ⇒ unlinkable) so ANY prover
                // folds the bond trustlessly; only the receipt's append path is a per-prover witness.
                let receipt_path = r_path(); // append-path witness for the receipt leaf at note_count
                // Bind `bond_amount` to REAL spent LP-share notes of the farm's lp_asset: an unbacked bond must
                // NOT credit shares (which would over-claim at harvest and drain the C0-backed treasury). Collect
                // the detected spends of the farm's lp_asset and verify Σ(their commitments) == bond_amount·H
                // (`lp_bond_kernel_verify`, the kernel_sig riding the 0x35 envelope). Fold the receipt only if it
                // binds — skip (no shares) on unknown farm / non-curve commitment / bad kernel, like the siblings.
                let bond_backed = state
                    .farm_rewards
                    .get(&farm_id)
                    .map(|st| {
                        let lp_ins: Vec<_> =
                            spends.iter().filter(|s| s.asset == st.lp_asset).collect();
                        let ops: Vec<([u8; 32], u32)> =
                            lp_ins.iter().map(|s| (s.prev_txid, s.prev_vout)).collect();
                        match lp_ins
                            .iter()
                            .map(|s| from_affine_xy(&s.cx, &s.cy))
                            .collect::<Option<Vec<Point>>>()
                        {
                            Some(pts) => cxfer_core::lp_bond_kernel_verify(
                                &farm_id, &st.lp_asset, bond_amount, &ops, &pts, &kernel_sig,
                            ),
                            None => false,
                        }
                    })
                    .unwrap_or(false);
                if bond_backed {
                    let _ = state.fold_lp_bond(&farm_id, bond_amount, &owner, &nonce, &receipt_path);
                }
            }

            // Track B: a T_LP_HARVEST (0x3B) claims a farmer's accrued reward, keeping the principal staked.
            // SPEC-CONTROLLER-VAULT-AMENDMENT §4: `fold_lp_harvest` proves the bond's RECEIPT note is in the note
            // tree, bounds `reward ≤ shares·(rps − rps_entry)` against the reflection's live `rps` (the guest's
            // own accumulator, not the envelope's claimed `exit_acc_per_share`), nullifies the old receipt, and
            // appends the checkpoint-advanced one. Then `fold_harvest` materializes the reward note (vout[1])
            // from the PUBLIC `(reward_amount, reward_r)` and debits the C0-backed treasury (the no-inflation
            // backstop). The accrual fairness is proof-bound.
            if let Some((farm_id, reward_amount, reward_r, owner, old_nonce, new_nonce, shares, rps_entry, owner_sig)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_lp_harvest_envelope(e))
            {
                // The OLD receipt's (owner, old_nonce, new_nonce, shares, rps_entry) ride the PUBLIC envelope so
                // ANY prover reconstructs it; the SPEND is gated by owner_sig (BIP-340 over the reward output,
                // verified in fold_lp_harvest). Only the tree-position witnesses below are per-prover.
                let reward_outpoint = outpoint_key(&txid, 1);
                // The reward note's DESTINATION (vout[1] scriptPubKey of THIS reveal tx) — the owner sig binds
                // it so the public envelope can't be replayed into an attacker's vout[1] (parsed from the tx,
                // not the witness stream, so it doesn't affect io alignment).
                let dest_spk = bitcoin::output_scriptpubkey(tx, 1);
                let old_index: u64 = io::read();
                let old_path = r_path(); // receipt membership path against pool_root
                let (lv, ln, li, lp, snp) = read_spent_insert(); // receipt nullifier IMT insert
                let new_receipt_path = r_path(); // advanced-receipt append path
                // The reward materialization (`fold_harvest`: mint vout[1] + debit the C0-backed treasury)
                // is AUTHORIZED by `fold_lp_harvest` (receipt membership + `reward ≤ shares·(rps−rps_entry)`
                // + receipt nullify/advance). Gate on it: an unauthorized or over-claimed harvest auth-fails
                // (atomically, no state mutation) and MUST NOT mint — else anyone drains the treasury with a
                // bogus receipt. `reward_path` is always consumed to keep the witness stream aligned.
                // ATOMIC harvest: the receipt nullify/advance (fold_lp_harvest) and the reward note +
                // treasury debit (fold_harvest) must land together. fold_lp_harvest touches only
                // spent_root/count + pool_root/note_count + the farm_rewards entry (receipts aren't live);
                // fold_harvest is itself all-or-nothing (a bad reward path mutates nothing). So snapshot those
                // fields, and if the reward can't be onboarded, REVERT the receipt commit — otherwise a bad
                // reward path would consume the receipt without paying the reward (a half-applied harvest).
                let snap = (
                    state.spent_root,
                    state.spent_count,
                    state.pool_root,
                    state.note_count,
                    state.farm_rewards.get(&farm_id),
                );
                let harvest_authorized = state
                    .fold_lp_harvest(
                        &farm_id,
                        shares,
                        rps_entry,
                        &owner,
                        &old_nonce,
                        &new_nonce,
                        reward_amount,
                        old_index,
                        &old_path,
                        &lv,
                        &ln,
                        li,
                        &lp,
                        &snp,
                        &new_receipt_path,
                        &reward_r,
                        &dest_spk,
                        &owner_sig,
                    )
                    .is_ok();
                let reward_path = r_path(); // the reward note's append path (vout[1])
                if harvest_authorized
                    && state
                        .fold_harvest(&farm_id, reward_amount, &reward_r, &reward_outpoint, &reward_path)
                        .is_err()
                {
                    state.spent_root = snap.0;
                    state.spent_count = snap.1;
                    state.pool_root = snap.2;
                    state.note_count = snap.3;
                    if let Some(e) = snap.4 {
                        state.farm_rewards.update(&farm_id, e);
                    }
                }
            }

            // Track B: a T_FARM_REFUND (0x3E) — the farm LAUNCHER reclaims unspent treasury. The draw onboards a
            // public-r note + debits the treasury (≤ reserve ⇒ no inflation), but it MUST be launcher-authorized
            // in-guest — else a permissionless prover drains any farm's treasury into an attacker-claimable note.
            // `fold_farm_refund` binds the envelope's launcher_pubkey to the one committed in farm_id (stored at
            // FARM_INIT) + verifies the launcher's BIP-340 signature over (farm, amount, r, view_height).
            if let Some((farm_id, launcher_pubkey, refund_amount, refund_view_height, refund_r, launcher_sig)) =
                env.as_ref().and_then(|e| bitcoin::parse_farm_refund_envelope_full(e))
            {
                let refund_path = r_path(); // witnessed per 0x3E (the refund note's append path; vout[1])
                let refund_dest_spk = bitcoin::output_scriptpubkey(tx, 1);
                let _ = state.fold_farm_refund(
                    &farm_id,
                    refund_amount,
                    &refund_r,
                    refund_view_height,
                    &outpoint_key(&txid, 1),
                    &refund_path,
                    &launcher_pubkey,
                    &launcher_sig,
                    &refund_dest_spk,
                );
            }

            // Track B: a T_LP_UNBOND (0x36) closes a farm position. TRUSTLESS (SPEC-CONTROLLER-VAULT-AMENDMENT
            // §4): `fold_lp_unbond` proves the bond's RECEIPT note is in the note tree, nullifies it, and drops
            // drops `shares` from `total_shares`, AND re-mints the bonded LP-shares as a live lp_asset note
            // (fold_lp_unbond) — a complete trustless exit. The receipt `(owner, nonce, shares, rps_entry)` +
            // `lp_return_r` ride the PUBLIC envelope; only the tree-position witnesses (receipt membership +
            // nullifier IMT insert + the lp-return note's append path) are per-prover.
            if let Some((farm_id, owner, nonce, shares, rps_entry, lp_return_r, owner_sig)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_lp_unbond_fields(e))
            {
                let lp_return_outpoint = outpoint_key(&txid, 1);
                let old_index: u64 = io::read();
                let old_path = r_path(); // receipt membership path against pool_root
                let (lv, ln, li, lp, snp) = read_spent_insert(); // receipt nullifier IMT insert
                let lp_return_path = r_path(); // the lp-share return note's append path (vout[1])
                let lp_return_dest_spk = bitcoin::output_scriptpubkey(tx, 1);
                // owner_sig (BIP-340 over the lp-return output) gates the spend — see fold_lp_unbond.
                let _ = state.fold_lp_unbond(
                    &farm_id, shares, rps_entry, &owner, &nonce, old_index, &old_path, &lv, &ln,
                    li, &lp, &snp, &lp_return_r, &lp_return_outpoint, &lp_return_path,
                    &lp_return_dest_spk, &owner_sig,
                );
            }

            // Track B: a T_PROTOCOL_FEE_CLAIM (0x31) — the pool's fee recipient claims the CREATOR-earned
            // protocol-fee LP-share skim as a real, bridgeable note. fold_protocol_fee_claim crystallizes the
            // swap-driven accrual, requires claim == accrued (exact), and onboards the claim note. T_PROTOCOL_
            // FEE_CLAIM (0x31) carries its envelope in the Taproot WITNESS — NO OP_RETURN at vout 0 — so the
            // single claim note is at vout 0 (the authoritative getParentEnvelopeData arm rejects vout != 0).
            // Keying it at vout 1 dropped it from the live set, so a later real spend at (txid,0) went
            // undetected → cross-lane double-spend.
            if let Some((cl_pool_id, cl_claimer, cl_fee_bps, cl_amount, cl_c_secp, cl_blinding, cl_sig)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_protocol_fee_claim_envelope(e))
            {
                let claim_path = r_path(); // witnessed per 0x31 (the claim note's append path; vout 0)
                // The claim note is at vout 0; bind its scriptPubKey into the recipient sig so the public
                // envelope can't be replayed into a front-runner's own vout 0 (parsed from the confirmed tx).
                let claim_dest_spk = bitcoin::output_scriptpubkey(tx, 0);
                let _ = state.fold_protocol_fee_claim(
                    &cl_pool_id,
                    &cl_claimer,
                    cl_fee_bps,
                    cl_amount,
                    &cl_c_secp,
                    &cl_blinding,
                    &cl_sig,
                    &claim_dest_spk,
                    &outpoint_key(
                        &txid,
                        cxfer_core::canonical_amm_output_vout(0x31, 0).expect("fee-claim note vout"),
                    ),
                    &claim_path,
                );
            }
        }
    }

    let pv = BitcoinReflectionPublicValues {
        priorDigest: prior_digest.into(),
        bitcoinPoolRoot: state.pool_root.into(),
        bitcoinSpentRoot: state.spent_root.into(),
        bitcoinBurnRoot: state.burn_root.into(),
        bitcoinHeight: state.height,
        newDigest: state.digest().into(),
        bitcoinPrevHash: prev_hash.into(),
        bitcoinTipHash: tip_hash.into(),
        ethPoolReflected: eth_pool_word.into(),
        cbtcBackingSats: U256::from(state.cbtc_backing_sats), // reflection-attested cBTC backing
        cbtcLocksFolded: cbtc_folded
            .iter()
            .map(|f| CbtcLockFolded {
                outpoint: f.outpoint.into(),
                vBtc: U256::from(f.v_btc),
                commitment: f.commitment_hash.into(),
            })
            .collect(),
        cbtcLocksSpent: cbtc_spent.iter().map(|o| (*o).into()).collect(),
        cbtcLocksRedeemed: cbtc_redeemed.iter().map(|o| (*o).into()).collect(),
        consumedCount: state.consumed_count, // fast-lane freshness: attest gates this == bitcoinConsumedCount
        crossOutCount: crossout_count, // cross-out freshness: attest gates this == ConfidentialPool.crossOutCount
        attestedAssetMetas: attested_metas,
        btcCallsFolded: btc_calls_folded.into_iter().map(Into::into).collect(),
    };
    io::commit_slice(&BitcoinReflectionPublicValues::abi_encode(&pv));
}
