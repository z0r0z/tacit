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
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::private::U256;
use alloy_sol_types::sol;
use alloy_sol_types::SolType;
use cxfer_core::{
    amm_canonical_pair, amm_derive_farm_id, amm_derive_pool_id_full, bitcoin, burn_deposit,
    commitment_hash, commitment_hash_compressed, compress, decompress, from_affine_xy, leaf,
    nullifier, outpoint_key, reflected_note_leaf, scan_tx_spends, verify_cxfer_conservation,
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
            (
                farm_id,
                FarmRewardState {
                    rate,
                    total_shares,
                    rps,
                    last_height,
                },
            )
        })
        .collect();
    let farm_rewards =
        FarmRewardSet::from_sorted(farm_entries).expect("handed farm reward set not sorted/unique");
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
    let (eth_pool_word, crossout_set_root, consumed_set_root, consumed_nu_count): (
        [u8; 32],
        [u8; 32],
        [u8; 32],
        u64,
    ) = if mode_b != 0 {
        let eth_pv: Vec<u8> = io::read();
        assert!(
            eth_pv.len() >= 11 * 32,
            "eth-reflection public values too short"
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
        (ep, cr, consumed_root, consumed_cnt)
    } else {
        // sentinel: forward-only batch — no eth recursion, no crossout/consumed fold.
        ([0u8; 32], [0u8; 32], [0u8; 32], 0u64)
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

            // Fold the detected spends into the spent-set (witnessed IMT insert, in scan order).
            for s in &spends {
                let (sv, sn, si, sp, snew) = read_spent_insert();
                state
                    .fold_spent(&s.nu, &sv, &sn, si, &sp, &snew)
                    .expect("spent-set fold");
            }

            // A bridge-out records ν → destCommitment in the burn set (the burned note is the
            // tx's single detected spend, bound to the envelope's nullifier).
            if let Some((b_asset, env_nu, env_dest)) = &burn {
                if spends.len() == 1 && &spends[0].nu == env_nu {
                    // Reflected-note bridge-out: the burned note is in the live set (this near-tip
                    // reflection saw it created), already nullified above by `fold_spent`. Record ν → dest.
                    let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                    state
                        .fold_burn(env_nu, env_dest, &bk, &bn, &bv, bi, &bp, &bnew)
                        .expect("burn-set fold");
                } else if spends.is_empty() {
                    // BURN-DEPOSIT (scan-free onboarding): the burned note is a PRE-existing, never-reflected
                    // note (no live-set spend). Admit it ONLY if the witness proves it descends from the
                    // asset's etch supply note C_0 through confirmed, conserving CXFERs. The provenance
                    // blocks are pre-anchor, so their canonicity is a header chain whose tip == this batch's
                    // relay-pinned anchor (prev_hash). See ops/DESIGN-trustless-asset-onboarding.md.
                    // ── witnesses (read UNCONDITIONALLY so the io stream stays in sync; fold only if valid) ──
                    let etch_tx: Vec<u8> = io::read();
                    let etch_index: u32 = io::read();
                    let n_etch_sib: u32 = io::read();
                    let etch_siblings: Vec<[u8; 32]> = (0..n_etch_sib).map(|_| r32()).collect();
                    // BIP141 witness authentication for the etch (its CETCH supply note C_0 + mint authority
                    // are read from the WITNESS, which the txid merkle path above does NOT bind): the tx's
                    // wtxid path + the same-block coinbase commitment.
                    let n_etch_wsib: u32 = io::read();
                    let etch_wtxid_siblings: Vec<[u8; 32]> =
                        (0..n_etch_wsib).map(|_| r32()).collect();
                    let etch_coinbase: Vec<u8> = io::read();
                    let n_etch_cb_sib: u32 = io::read();
                    let etch_cb_txid_siblings: Vec<[u8; 32]> =
                        (0..n_etch_cb_sib).map(|_| r32()).collect();
                    let n_prov_headers: u32 = io::read();
                    let prov_headers: Vec<Vec<u8>> =
                        (0..n_prov_headers).map(|_| io::read()).collect();
                    let n_cxfers: u32 = io::read();
                    // Cap the DAG size: reachability is O(n^2) in the cxfer count, and the Vec::with_capacity
                    // below trusts it. 1024 is far above any real provenance depth; a pathological witness is a
                    // clean reject, not an unbounded proving blowup. (A prover already pays its own proving
                    // cost, but bound the worst case explicitly.)
                    assert!(
                        n_cxfers <= 1024,
                        "burn-deposit: provenance cxfer count over cap"
                    );
                    let mut prov: Vec<burn_deposit::ProvenanceWitness> =
                        Vec::with_capacity(n_cxfers as usize);
                    for _ in 0..n_cxfers {
                        // The CXFER tx bytes: txid (computed), the envelope (asset, kernel sig, output
                        // commitments, range proof) and the input outpoints are all derived from these in
                        // verify_cxfers — the conserving step is bound to the real on-chain tx.
                        let tx: Vec<u8> = io::read();
                        let n_in: u32 = io::read();
                        // Spent-note commitment POINTS (Bitcoin records only the outpoint); bound by the DAG.
                        let input_commitments: Vec<[u8; 33]> =
                            (0..n_in).map(|_| r_n::<33>()).collect();
                        let n_out: u32 = io::read();
                        // Produced-note vouts (values are tx-derived from the envelope's commitments).
                        let output_vouts: Vec<u32> = (0..n_out).map(|_| io::read()).collect();
                        // 0 for a pure CXFER transfer; > 0 for a CBURN step (kernel-bound, can't be understated).
                        let burned_amount: u64 = io::read();
                        let n_sib: u32 = io::read();
                        let merkle_siblings: Vec<[u8; 32]> = (0..n_sib).map(|_| r32()).collect();
                        let merkle_index: u32 = io::read();
                        let confirmed_block_root = r32();
                        // BIP141 witness authentication: wtxid path + same-block coinbase commitment.
                        let n_wsib: u32 = io::read();
                        let wtxid_siblings: Vec<[u8; 32]> = (0..n_wsib).map(|_| r32()).collect();
                        let coinbase: Vec<u8> = io::read();
                        let n_cbsib: u32 = io::read();
                        let coinbase_txid_siblings: Vec<[u8; 32]> =
                            (0..n_cbsib).map(|_| r32()).collect();
                        prov.push(burn_deposit::ProvenanceWitness {
                            tx,
                            input_commitments,
                            output_vouts,
                            burned_amount,
                            merkle_siblings,
                            merkle_index,
                            confirmed_block_root,
                            wtxid_siblings,
                            coinbase,
                            coinbase_txid_siblings,
                        });
                    }
                    // mintable: issuer-authorized cmint witnesses (each: the T_MINT reveal tx + the commit tx
                    // + the reveal's merkle inclusion). Empty (n=0) for a fixed-supply asset.
                    let n_cmints: u32 = io::read();
                    assert!(n_cmints <= 1024, "burn-deposit: cmint count over cap");
                    #[allow(clippy::type_complexity)]
                    let mut cmints: Vec<(
                        Vec<u8>,
                        Vec<u8>,
                        Vec<[u8; 32]>,
                        u32,
                        Vec<[u8; 32]>,
                        Vec<u8>,
                        Vec<[u8; 32]>,
                    )> = Vec::with_capacity(n_cmints as usize);
                    for _ in 0..n_cmints {
                        let reveal_tx: Vec<u8> = io::read();
                        let commit_tx: Vec<u8> = io::read();
                        let n_msib: u32 = io::read();
                        let msib: Vec<[u8; 32]> = (0..n_msib).map(|_| r32()).collect();
                        let midx: u32 = io::read();
                        // BIP141 witness authentication for the reveal (its CMINT envelope is in the WITNESS).
                        let n_rwsib: u32 = io::read();
                        let reveal_wtxid_siblings: Vec<[u8; 32]> =
                            (0..n_rwsib).map(|_| r32()).collect();
                        let reveal_coinbase: Vec<u8> = io::read();
                        let n_rcb_sib: u32 = io::read();
                        let reveal_cb_txid_siblings: Vec<[u8; 32]> =
                            (0..n_rcb_sib).map(|_| r32()).collect();
                        cmints.push((
                            reveal_tx,
                            commit_tx,
                            msib,
                            midx,
                            reveal_wtxid_siblings,
                            reveal_coinbase,
                            reveal_cb_txid_siblings,
                        ));
                    }
                    let burned_cx = r32();
                    let burned_cy = r32();
                    let (sv, sn, si, sp, snew) = read_spent_insert();
                    let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                    // the proven-real burned note is onboarded as a pool member (so the Ethereum mint binds
                    // v_mint == v_burn via pool-membership + kernel); its note-tree append path is witnessed.
                    let note_path = r_path();

                    // ── verify (all required; any miss → skip, fold nothing) ──
                    let verified = (|| -> Option<()> {
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
                        // (4) burned note: outpoint = the burn tx's spent input; env ν is the note's REAL ν.
                        let inputs = bitcoin::extract_inputs(tx)?;
                        let (bt, bvo) = inputs.first()?;
                        let burned_outpoint = outpoint_key(bt, *bvo);
                        if &nullifier(&burned_cx, &burned_cy) != env_nu {
                            return None;
                        }
                        let burned_ch = commitment_hash(&burned_cx, &burned_cy);
                        // (5) the burned note descends from a valid supply leaf (C_0 ∪ authorized cmints).
                        burn_deposit::verify_provenance_leaves(
                            b_asset,
                            &valid_leaves,
                            &burned_outpoint,
                            &burned_ch,
                            &prov,
                        )
                        .ok()
                    })();
                    if verified.is_some() {
                        // nullify the burned note in the shared set (no double-use) + onboard it as a pool member
                        // + authorize bridge_mint → dest. skip-not-panic (like the cxfer/crossout/cbtc folds): a ν
                        // already in the shared set — a re-presented bridge or an in-pool spend of the same note —
                        // folds nothing rather than wedging the prover (a griefer can't stall reflection with a
                        // double-bridge tx). The note-append + fold_burn can't fail once fold_spent succeeds: a ν
                        // absent from the spent set is absent from the burn set too (every bridge-out adds to both).
                        if state.fold_spent(env_nu, &sv, &sn, si, &sp, &snew).is_ok() {
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
                                if let Some(meta_env) = bitcoin::extract_taproot_envelope(&etch_tx)
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
                let set_index: u64 = io::read();
                let set_path = r_path();
                let note_path = r_path();
                // vout 0 = the mint's single confidential output (the dapp's T_CROSSOUT_MINT layout).
                let _ = state.fold_crossout(
                    &co_asset,
                    &claim_id,
                    &cx,
                    &cy,
                    set_index,
                    &set_path,
                    &crossout_set_root,
                    &txid,
                    0,
                    &note_path,
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
                            let asset_in = if sv.direction == 0 {
                                pool.asset_a
                            } else {
                                pool.asset_b
                            };
                            if state
                                .fold_swap_var(
                                    &mut pool,
                                    &sv,
                                    (s.prev_txid, s.prev_vout),
                                    &s.asset,
                                    &outpoint_key(&txid, 1),
                                    &receipt_path,
                                )
                                .is_ok()
                            {
                                state.pools.update(&sv.pool_id, pool);
                                // Onboard the taker's change (leftover of c_in, kernel-bound) so it isn't stranded.
                                if let Some(cp) = change_path.as_ref() {
                                    if let (Some(lf), Some(ch)) = (
                                        reflected_note_leaf(&asset_in, &sv.c_change_or_sentinel),
                                        commitment_hash_compressed(&sv.c_change_or_sentinel),
                                    ) {
                                        let _ = state.fold_output(
                                            &lf,
                                            cp,
                                            &outpoint_key(&txid, 2),
                                            &ch,
                                            &asset_in,
                                        );
                                    }
                                }
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
                        state.pools.pool_ids_for_assets(&ca, &cb).first().copied()
                    };
                    if let Some(pid) = pool_id {
                        // Group the detected live spends by canonical asset side.
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
                        let pre_shares = state.pools.get(&pid).map(|p| p.total_shares).unwrap_or(0);
                        let pre_accrued = state
                            .pools
                            .get(&pid)
                            .map(|p| p.protocol_fee_accrued)
                            .unwrap_or(0);
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
                                let _ = state.fold_lp_share_mint(
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
                                );
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
                            // inputs_c0_backed: the launcher's funding input is a detected live (real) spend.
                            if state
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
                                // the reward against this rps.
                                let _ = state.fold_farm_init_rewards(&farm_id, fi.reward_per_block);
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
            if let Some((farm_id, _bonder_pubkey, bond_amount, _entry_acc, _view_h)) =
                env.as_ref().and_then(|e| bitcoin::parse_lp_bond_fields(e))
            {
                let owner = r32(); // blinded owner commitment (pubkey + b·G), witnessed
                let nonce = r32(); // receipt nonce, witnessed
                let receipt_path = r_path(); // append-path witness for the receipt leaf at note_count
                let _ = state.fold_lp_bond(&farm_id, bond_amount, &owner, &nonce, &receipt_path);
            }

            // Track B: a T_LP_HARVEST (0x3B) claims a farmer's accrued reward, keeping the principal staked.
            // SPEC-CONTROLLER-VAULT-AMENDMENT §4: `fold_lp_harvest` proves the bond's RECEIPT note is in the note
            // tree, bounds `reward ≤ shares·(rps − rps_entry)` against the reflection's live `rps` (the guest's
            // own accumulator, not the envelope's claimed `exit_acc_per_share`), nullifies the old receipt, and
            // appends the checkpoint-advanced one. Then `fold_harvest` materializes the reward note (vout[1])
            // from the PUBLIC `(reward_amount, reward_r)` and debits the C0-backed treasury (the no-inflation
            // backstop). The accrual fairness is proof-bound.
            if let Some((farm_id, reward_amount, reward_r)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_lp_harvest_envelope(e))
            {
                let owner = r32();
                let old_nonce = r32();
                let new_nonce = r32();
                let shares: u64 = io::read();
                let rps_entry: u128 = io::read();
                let old_index: u64 = io::read();
                let old_path = r_path(); // receipt membership path against pool_root
                let (lv, ln, li, lp, snp) = read_spent_insert(); // receipt nullifier IMT insert
                let new_receipt_path = r_path(); // advanced-receipt append path
                let _ = state.fold_lp_harvest(
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
                );
                let reward_path = r_path(); // the reward note's append path (vout[1])
                let _ = state.fold_harvest(
                    &farm_id,
                    reward_amount,
                    &reward_r,
                    &outpoint_key(&txid, 1),
                    &reward_path,
                );
            }

            // Track B: a T_FARM_REFUND (0x3E) — the launcher reclaims unspent treasury post-grace. Same shape as
            // a harvest (a public-r note drawn from the treasury reserve), so fold_harvest onboards it + debits
            // the treasury — NO new fold (the generalized "draw a reserve + onboard a public-r note" pattern).
            if let Some((farm_id, refund_amount, refund_r)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_farm_refund_envelope(e))
            {
                let refund_path = r_path(); // witnessed per 0x3E (the refund note's append path; vout[1])
                let _ = state.fold_harvest(
                    &farm_id,
                    refund_amount,
                    &refund_r,
                    &outpoint_key(&txid, 1),
                    &refund_path,
                );
            }

            // Track B: a T_LP_UNBOND (0x36) closes a farm position. TRUSTLESS (SPEC-CONTROLLER-VAULT-AMENDMENT
            // §4): `fold_lp_unbond` proves the bond's RECEIPT note is in the note tree, nullifies it, and drops
            // `shares` from the farm's `total_shares`. No reward is claimed (harvest first to collect accrual).
            // `(owner, nonce, rps_entry, membership + nullifier witnesses)` are witnessed. NOTE (prove-validated
            // refinement): re-minting the released LP-share notes is the bond's homomorphic kernel run in
            // reverse (AMM-kernel layer), not folded here — this branch is the receipt-retire + share bookkeeping
            // against the verified `fold_lp_unbond`.
            if let Some((farm_id, _unbonder_pubkey, shares, _view_h)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_lp_unbond_fields(e))
            {
                let owner = r32();
                let nonce = r32();
                let rps_entry: u128 = io::read();
                let old_index: u64 = io::read();
                let old_path = r_path(); // receipt membership path against pool_root
                let (lv, ln, li, lp, snp) = read_spent_insert(); // receipt nullifier IMT insert
                let _ = state.fold_lp_unbond(
                    &farm_id, shares, rps_entry, &owner, &nonce, old_index, &old_path, &lv, &ln,
                    li, &lp, &snp,
                );
            }

            // Track B: a T_PROTOCOL_FEE_CLAIM (0x31) — the pool's fee recipient claims the CREATOR-earned
            // protocol-fee LP-share skim as a real, bridgeable note. fold_protocol_fee_claim crystallizes the
            // swap-driven accrual, requires claim == accrued (exact), and onboards the claim note. T_PROTOCOL_
            // FEE_CLAIM (0x31) carries its envelope in the Taproot WITNESS — NO OP_RETURN at vout 0 — so the
            // single claim note is at vout 0 (the authoritative getParentEnvelopeData arm rejects vout != 0).
            // Keying it at vout 1 dropped it from the live set, so a later real spend at (txid,0) went
            // undetected → cross-lane double-spend.
            if let Some((cl_pool_id, cl_amount, cl_c_secp, cl_blinding)) = env
                .as_ref()
                .and_then(|e| bitcoin::parse_protocol_fee_claim_envelope(e))
            {
                let claim_path = r_path(); // witnessed per 0x31 (the claim note's append path; vout 0)
                let _ = state.fold_protocol_fee_claim(
                    &cl_pool_id,
                    cl_amount,
                    &cl_c_secp,
                    &cl_blinding,
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
        attestedAssetMetas: attested_metas,
        btcCallsFolded: btc_calls_folded.into_iter().map(Into::into).collect(),
    };
    io::commit_slice(&BitcoinReflectionPublicValues::abi_encode(&pv));
}
