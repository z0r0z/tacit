//! eth-reflection guest (Mode B reverse reflection, Phase 1).
//!
//! Proves, trustlessly for the Bitcoin side, that cross-outs were recorded on FINALIZED Ethereum —
//! so the Bitcoin reflection guest can fold cross-out value into the bridge-mintable pool root
//! without trusting the worker. See `ops/PLAN-eth-reflection-modeB.md`.
//!
//! Built on sp1-helios (helios 0.11.1, Zellic-audited): the sync-committee + finality verification and
//! the contract storage-slot MPT proof are reused verbatim (`helios_consensus_core::*`,
//! `sp1_helios_primitives::verify_storage_slot_proofs`). Our addition is the fold: each verified
//! `crossOutCommitment[claimId]` storage slot is bound to its cross-out fields and appended to the
//! append-only `EthCrossOut` set (`cxfer-core::eth_reflection`), the SAME leaf the Bitcoin guest proves
//! membership against and the SAME `claim_id` binding the ConfidentialPool derives on-chain.
//!
//! Two CBOR inputs: (1) sp1-helios `ProofInputs` (LC + storage), (2) `EthReflInputs` (the accumulator
//! resume + per-slot cross-out witnesses). Commits `EthReflectionPublicValues`.
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::{Address, B256};
use alloy_sol_types::{sol, SolValue};
use helios_consensus_core::{apply_finality_update, apply_update, verify_finality_update, verify_update};
use serde::{Deserialize, Serialize};
use sp1_helios_primitives::{types::ProofInputs, verify_storage_slot_proofs};
use tree_hash::TreeHash;

use cxfer_core::eth_reflection::{
    eth_consumed_leaf, eth_crossout_leaf, eth_refl_digest, mapping_slot_key, plain_slot_key, slot_value_to_u64,
    EthConsumed, EthCrossOut, CONSUMED_AT_SLOT_INDEX, CONSUMED_COUNT_SLOT_INDEX, CONSUMED_SLOT_INDEX, CROSSOUT_SLOT_INDEX,
    DEST_CHAIN_BITCOIN,
};
use cxfer_core::{claim_id, keccak_tree_append_transition};

sol! {
    /// Public values: the append-only cross-out set @ a finalized Ethereum slot. The Bitcoin
    /// reflection guest recursively verifies this proof and folds cross-outs against `crossOutSetRoot`.
    struct EthReflectionPublicValues {
        bytes32 priorDigest;            // eth-reflection state this cycle continues from (append-only chain)
        bytes32 newDigest;              // state after this cycle (next cycle's prior)
        address ethPool;                // the ConfidentialPool whose crossOutCommitment slots were proven
        bytes32 crossOutSetRoot;        // KeccakTreeAccumulator root over EthCrossOut leaves (membership target)
        uint64  crossOutCount;          // leaves in the set (append-only, monotone)
        uint64  finalizedSlot;          // beacon slot of the finalized header proven against (monotone)
        bytes32 finalizedExecStateRoot; // execution stateRoot the storage proofs were verified against
        bytes32 syncCommitteeRoot;      // CURRENT sync-committee after the batch (next cycle's prev)
        bytes32 prevSyncCommitteeRoot;  // the sync-committee this batch chained FROM — the Bitcoin guest
                                        // gates the FIRST proof's prev == genesis, then chains (weak-subjectivity)
        // FAST LANE (consumed-ν reverse reflection). APPENDED so the Bitcoin guest's existing by-offset
        // reads (fields 2/3/8) stay valid; these are fields 9/10.
        bytes32 consumedNuSetRoot;      // KeccakTreeAccumulator root over EthConsumed leaves (membership target)
        uint64  consumedNuCount;        // leaves in the consumed set (append-only, monotone)
    }
}

/// The accumulator resume state + the per-slot cross-out witnesses (one per verified `pool` storage
/// slot, same order). `append_path` is the frontier path for the leaf's slot (headless append).
#[derive(Serialize, Deserialize)]
struct EthReflInputs {
    pool: Address,
    prior_set_root: B256,
    prior_count: u64,
    crossouts: Vec<CrossOutWitness>,
    // FAST LANE: the consumed-ν set resume + the per-slot witnesses (one per proven `bitcoinConsumed[ν]`).
    prior_consumed_root: B256,
    prior_consumed_count: u64,
    consumeds: Vec<ConsumedWitness>,
}

#[derive(Serialize, Deserialize)]
struct CrossOutWitness {
    claim_id: B256,
    dest_chain: u16,
    dest_commitment: B256,
    nullifier: B256,
    asset_id: B256,
    append_path: Vec<B256>,
}

/// One consumed-ν witness: its `bitcoinConsumed[ν]` slot was proven (value `spend_root != 0`).
#[derive(Serialize, Deserialize)]
struct ConsumedWitness {
    nullifier: B256,
    spend_root: B256,
    append_path: Vec<B256>,
}

// Thin B256 adapters over the KAT-pinned cxfer-core slot derivations (single source of truth, tested in
// cxfer_core::eth_reflection against `cast index`). The eth_getProof key the contract exposes for
// `crossOutCommitment[claimId]` / `bitcoinConsumed[ν]` (mappings) and `bitcoinConsumedCount` (plain).
fn crossout_slot_key(claim_id: &B256) -> B256 { B256::from(mapping_slot_key(&claim_id.0, CROSSOUT_SLOT_INDEX)) }
fn consumed_slot_key(nullifier: &B256) -> B256 { B256::from(mapping_slot_key(&nullifier.0, CONSUMED_SLOT_INDEX)) }
fn consumed_at_slot_key(index: u64) -> B256 {
    let mut key = [0u8; 32];
    key[24..].copy_from_slice(&index.to_be_bytes());
    B256::from(mapping_slot_key(&key, CONSUMED_AT_SLOT_INDEX))
}
fn count_slot_key() -> B256 { B256::from(plain_slot_key(CONSUMED_COUNT_SLOT_INDEX)) }

pub fn main() {
    // 1. Light-client verification (verbatim from sp1-helios `light_client.rs`): apply sync-committee
    //    updates, then the finality update, against the resumed store / genesis / forks.
    let ProofInputs {
        updates,
        finality_update,
        expected_current_slot,
        mut store,
        genesis_root,
        forks,
        contract_storage,
    } = serde_cbor::from_slice(&sp1_zkvm::io::read_vec()).unwrap();

    // Chain binding + weak-subjectivity on the witnessed `store`. Without these the resumed store (raw
    // CBOR) admits two forgeries that the recursion + on-chain address gate do not catch: (1) a store
    // bootstrapped on a DIFFERENT chain whose pool shares the CREATE3 address (free testnet cross-outs
    // satisfying a mainnet ethPool gate), and (2) a pre-loaded `next_sync_committee` letting an
    // attacker-chosen committee sign a forged period+1 chain past the genesis committee. The honest host
    // serializes a fresh genesis bootstrap pinned at ETH_GENESIS_SLOT with next=None and never applies
    // updates to it (prover-host eth_prove.rs:189-202,335-339), so all three checks are liveness-safe.
    //
    // VALUES are the Sepolia rehearsal anchor; RE-ANCHOR to mainnet at the production re-prove IN LOCKSTEP
    // with ETH_GENESIS_SYNC_COMMITTEE (reflect.rs:295-299): mainnet genesis_validators_root =
    // 0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95 and the chosen mainnet checkpoint
    // slot. See ops/CHECKLIST-mainnet-reprove.md.
    const ETH_GENESIS_VALIDATORS_ROOT: [u8; 32] = [
        0xd8, 0xea, 0x17, 0x1f, 0x3c, 0x94, 0xae, 0xa2, 0x1e, 0xbc, 0x42, 0xa1, 0xed, 0x61, 0x05, 0x2a,
        0xcf, 0x3f, 0x92, 0x09, 0xc0, 0x0e, 0x4e, 0xfb, 0xaa, 0xdd, 0xac, 0x09, 0xed, 0x9b, 0x80, 0x78,
    ];
    const ETH_GENESIS_SLOT: u64 = 10462624;
    assert_eq!(
        genesis_root.0, ETH_GENESIS_VALIDATORS_ROOT,
        "eth-reflection: wrong genesis_validators_root (chain pin)"
    );
    assert!(
        store.next_sync_committee.is_none(),
        "eth-reflection: resumed store must be the genesis bootstrap (a pre-set next_sync_committee admits a forged period+1 chain)"
    );
    assert_eq!(
        store.finalized_header.beacon().slot,
        ETH_GENESIS_SLOT,
        "eth-reflection: store must start at the pinned genesis checkpoint slot"
    );

    let prev_head = store.finalized_header.beacon().slot;
    let prev_sync_committee_hash: B256 = store.current_sync_committee.tree_hash_root(); // anchor chained FROM
    for update in updates.iter() {
        verify_update(update, expected_current_slot, &store, genesis_root, &forks).expect("update invalid");
        apply_update(&mut store, update);
    }
    verify_finality_update(&finality_update, expected_current_slot, &store, genesis_root, &forks)
        .expect("finality update invalid");
    apply_finality_update(&mut store, &finality_update);

    let head = store.finalized_header.beacon().slot;
    // No rollback (not strict advance): re-proving the same finalized slot is idempotent — the
    // contract enforces freshness via the resume-digest chain, and re-folding a known crossOutSetRoot
    // is a no-op. Strict `>` would crash a prover run that lands on an already-finalized slot.
    assert!(head >= prev_head, "finality rolled back");
    assert!(head % 32 == 0, "new head is not a checkpoint slot");

    let execution = store.finalized_header.execution().expect("execution payload missing");
    let exec_state_root: B256 = *execution.state_root();
    let sync_committee_hash: B256 = store.current_sync_committee.tree_hash_root();

    // 2. Verify the contract storage-slot MPT proofs against the finalized execution state root.
    let mut verified = Vec::new();
    for cs in &contract_storage {
        verified.extend(verify_storage_slot_proofs(exec_state_root, cs).expect("storage proof invalid"));
    }

    // 3. Fold each verified slot of `pool` into its set: `crossOutCommitment` → cross-out set (ETH→BTC
    //    value), `bitcoinConsumed` → consumed-ν set (FAST LANE). The two slot kinds intermix in
    //    `verified`, so each witness is matched to its slot by KEY, and the total must account for every
    //    pool slot (no stray slot, no unproven witness).
    let ethr: EthReflInputs = serde_cbor::from_slice(&sp1_zkvm::io::read_vec()).unwrap();
    // The pool address is witnessed and becomes `ethPool`; reject the zero sentinel here too. The Bitcoin
    // reflection guest treats ethPool == 0 as the mode_b==0 "no eth-state" marker, so a real Mode-B proof
    // must never emit it (defense-in-depth — reflect.rs also rejects it).
    assert!(ethr.pool != Address::ZERO, "eth-reflection: zero pool address (reserved sentinel)");
    let prior_digest = B256::from(eth_refl_digest(
        ethr.pool.as_slice(), ethr.prior_set_root.as_slice(), ethr.prior_count,
        ethr.prior_consumed_root.as_slice(), ethr.prior_consumed_count,
    ));

    let pool_slots: Vec<_> = verified.iter().filter(|s| s.contractAddress == ethr.pool).collect();

    // FAST-LANE FRESHNESS ANCHOR: read ConfidentialPool.bitcoinConsumedCount @ this finalized block. The
    // consumed fold below MUST cover every recorded consume as of this block (asserted `consumed_count ==
    // this` after the loop), else a worker could witness only a subset and leave the omitted source notes
    // live + double-spendable on Bitcoin. MANDATORY: a missing counter slot fails the proof (fail-closed).
    let count_key = count_slot_key();
    let onchain_consumed_count = slot_value_to_u64(
        &pool_slots
            .iter()
            .find(|s| s.key == count_key)
            .expect("bitcoinConsumedCount slot not proven (freshness anchor)")
            .value
            .0,
    );

    // Every OTHER pool slot is exactly one crossOut or one consumed entry — no stray slot, no unproven
    // witness. The counter slot is excluded here: it is the freshness anchor, not a set entry.
    let entry_slot_count = pool_slots.iter().filter(|s| s.key != count_key).count();
    assert_eq!(
        entry_slot_count,
        ethr.crossouts.len() + 2 * ethr.consumeds.len(),
        "verified-slot / witness count mismatch",
    );
    // Reject duplicate witnesses locally: a key folded twice would mis-count the set even though each
    // individual MPT proof is valid (the consumed double-fold is also caught system-side by the Bitcoin
    // guest's fold_consumed — a re-folded ν's source is already removed — but rejecting it here is sharper).
    for i in 0..ethr.consumeds.len() {
        for j in (i + 1)..ethr.consumeds.len() {
            assert!(ethr.consumeds[i].nullifier != ethr.consumeds[j].nullifier, "duplicate consumed nullifier");
        }
    }
    for i in 0..ethr.crossouts.len() {
        for j in (i + 1)..ethr.crossouts.len() {
            assert!(ethr.crossouts[i].claim_id != ethr.crossouts[j].claim_id, "duplicate crossOut claimId");
        }
    }

    let mut set_root: [u8; 32] = ethr.prior_set_root.0;
    let mut count = ethr.prior_count;
    for co in ethr.crossouts.iter() {
        let key = crossout_slot_key(&co.claim_id);
        let slot = pool_slots.iter().find(|s| s.key == key).expect("crossOutCommitment slot not in proven set");
        assert_eq!(slot.value, co.dest_commitment, "slot value != destCommitment");
        assert!(co.dest_commitment.0 != [0u8; 32], "zero crossOut commitment (unset slot)");
        assert_eq!(co.dest_chain, DEST_CHAIN_BITCOIN, "only bitcoin-destined cross-outs fold here");
        // Same claimId binding the ConfidentialPool derives on-chain (proves the witnessed fields are real).
        assert_eq!(
            claim_id(co.dest_chain, &co.dest_commitment.0, &co.nullifier.0, &co.asset_id.0),
            co.claim_id.0,
            "claimId binding"
        );
        let leaf = eth_crossout_leaf(&EthCrossOut {
            claim_id: co.claim_id.0,
            dest_chain: co.dest_chain,
            dest_commitment: co.dest_commitment.0,
            asset_id: co.asset_id.0,
        });
        let path: Vec<[u8; 32]> = co.append_path.iter().map(|p| p.0).collect();
        set_root = keccak_tree_append_transition(&set_root, count, &path, &leaf).expect("crossout append transition");
        count += 1;
    }

    // FAST LANE: append each consumed ν (a Bitcoin-homed note spent on Ethereum). The slot VALUE is the
    // spendRoot (`bitcoinConsumed[ν] = spendRoot`, non-zero), bound into the leaf; ν is the key.
    let mut consumed_root: [u8; 32] = ethr.prior_consumed_root.0;
    let mut consumed_count = ethr.prior_consumed_count;
    for (offset, cw) in ethr.consumeds.iter().enumerate() {
        let expected_index = ethr.prior_consumed_count
            .checked_add(offset as u64)
            .expect("consumed index overflow");
        let at_slot = pool_slots
            .iter()
            .find(|s| s.key == consumed_at_slot_key(expected_index))
            .expect("bitcoinConsumedAt[index] slot not in proven set");
        assert_eq!(at_slot.value, cw.nullifier, "bitcoinConsumedAt[index] != witnessed nullifier");
        assert!(cw.nullifier.0 != [0u8; 32], "zero consumed nullifier");
        let key = consumed_slot_key(&cw.nullifier);
        let slot = pool_slots.iter().find(|s| s.key == key).expect("bitcoinConsumed slot not in proven set");
        assert_eq!(slot.value, cw.spend_root, "slot value != spendRoot");
        assert!(cw.spend_root.0 != [0u8; 32], "consumed slot value zero (uninitialized)");
        let leaf = eth_consumed_leaf(&EthConsumed { nullifier: cw.nullifier.0, spend_root: cw.spend_root.0 });
        let path: Vec<[u8; 32]> = cw.append_path.iter().map(|p| p.0).collect();
        consumed_root =
            keccak_tree_append_transition(&consumed_root, consumed_count, &path, &leaf).expect("consumed append transition");
        consumed_count += 1;
    }

    // FRESHNESS: the cumulative folded consumed count must equal the on-chain counter at this finalized
    // block (the fold is append-only and each entry is a distinct ν). This is what forces completeness —
    // advancing the finalized slot REQUIRES folding every consume recorded as of it, closing the
    // subset-witness double-spend the bare set root could not prevent.
    assert_eq!(
        consumed_count, onchain_consumed_count,
        "consumed fold incomplete vs on-chain bitcoinConsumedCount",
    );

    let new_digest =
        B256::from(eth_refl_digest(ethr.pool.as_slice(), &set_root, count, &consumed_root, consumed_count));
    let pv = EthReflectionPublicValues {
        priorDigest: prior_digest,
        newDigest: new_digest,
        ethPool: ethr.pool,
        crossOutSetRoot: B256::from(set_root),
        crossOutCount: count,
        finalizedSlot: head,
        finalizedExecStateRoot: exec_state_root,
        syncCommitteeRoot: sync_committee_hash,
        prevSyncCommitteeRoot: prev_sync_committee_hash,
        consumedNuSetRoot: B256::from(consumed_root),
        consumedNuCount: consumed_count,
    };
    sp1_zkvm::io::commit_slice(&pv.abi_encode());
}
