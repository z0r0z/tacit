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

use alloy_primitives::{keccak256, Address, B256};
use alloy_sol_types::{sol, SolValue};
use helios_consensus_core::{apply_finality_update, apply_update, verify_finality_update, verify_update};
use serde::{Deserialize, Serialize};
use sp1_helios_primitives::{types::ProofInputs, verify_storage_slot_proofs};
use tree_hash::TreeHash;

use cxfer_core::eth_reflection::{eth_crossout_leaf, EthCrossOut, DEST_CHAIN_BITCOIN};
use cxfer_core::{claim_id, keccak_tree_append_transition};

/// Storage slot index of `ConfidentialPool.crossOutCommitment` (the mapping declaration order in the
/// contract's storage layout). Set from `forge inspect ConfidentialPool storageLayout` at wiring time.
const CROSSOUT_SLOT_INDEX: u64 = 76; // ConfidentialPool storage layout (forge inspect); re-check on any pool relayout

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

/// Location of `crossOutCommitment[claimId]`: `keccak256(claimId ‖ uint256(SLOT))` — the Solidity
/// mapping-slot rule, so it matches the `eth_getProof` key the contract exposes.
fn crossout_slot_key(claim_id: &B256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(claim_id.as_slice());
    buf[56..64].copy_from_slice(&CROSSOUT_SLOT_INDEX.to_be_bytes());
    keccak256(buf)
}

/// Digest chaining the eth-reflection state: `keccak(pool ‖ crossOutSetRoot ‖ count_be8)` — the
/// contract enforces `priorDigest == knownEthReflectionDigest`, advancing it (append-only, no rollback).
fn eth_refl_digest(pool: &Address, set_root: &B256, count: u64) -> B256 {
    let mut b = Vec::with_capacity(20 + 32 + 8);
    b.extend_from_slice(pool.as_slice());
    b.extend_from_slice(set_root.as_slice());
    b.extend_from_slice(&count.to_be_bytes());
    keccak256(&b)
}

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

    // 3. Fold each verified crossOutCommitment slot of `pool` into the append-only set.
    let ethr: EthReflInputs = serde_cbor::from_slice(&sp1_zkvm::io::read_vec()).unwrap();
    let prior_digest = eth_refl_digest(&ethr.pool, &ethr.prior_set_root, ethr.prior_count);

    let pool_slots: Vec<_> = verified.iter().filter(|s| s.contractAddress == ethr.pool).collect();
    assert_eq!(pool_slots.len(), ethr.crossouts.len(), "verified-slot / witness count mismatch");

    let mut set_root: [u8; 32] = ethr.prior_set_root.0;
    let mut count = ethr.prior_count;
    for (slot, co) in pool_slots.iter().zip(ethr.crossouts.iter()) {
        assert_eq!(slot.key, crossout_slot_key(&co.claim_id), "slot != crossOutCommitment[claimId]");
        assert_eq!(slot.value, co.dest_commitment, "slot value != destCommitment");
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
        set_root = keccak_tree_append_transition(&set_root, count, &path, &leaf).expect("append transition");
        count += 1;
    }

    let new_digest = eth_refl_digest(&ethr.pool, &B256::from(set_root), count);
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
    };
    sp1_zkvm::io::commit_slice(&pv.abi_encode());
}
