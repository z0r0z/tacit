//! Eth-reflection inter-guest ABI (Mode B reverse reflection).
//!
//! The contract between the `eth-reflection` guest (an Ethereum beacon light client; Phase 1,
//! fork sp1-helios) and the Bitcoin reflection guest that folds cross-out value (Phase 2).
//! See `ops/PLAN-eth-reflection-modeB.md`. This module is the SHARED, dependency-light core:
//! the cross-out set leaf both guests build and the membership check the Bitcoin guest runs.
//!
//! ## What the eth-reflection guest proves and commits
//!
//! Resuming from a pinned genesis sync-committee checkpoint, it verifies Ethereum beacon
//! sync-committee signatures + finality up to a finalized slot S, reads the ConfidentialPool's
//! `crossOutCommitment[claimId]` storage slots via Merkle-Patricia storage proofs against the
//! finalized execution stateRoot, and appends each verified cross-out to an append-only
//! `KeccakTreeAccumulator`. Its public values (alloy `sol!`, defined in the guest crate):
//!
//! ```text
//! struct EthReflectionPublicValues {
//!     bytes32 priorDigest;             // eth-reflection state this cycle continues from (append-only chain)
//!     bytes32 newDigest;               // state after this cycle (next cycle's prior)
//!     address ethPool;                 // the ConfidentialPool whose crossOutCommitment slots were proven
//!     bytes32 crossOutSetRoot;         // KeccakTreeAccumulator root over EthCrossOut leaves — the membership target
//!     uint64  crossOutCount;           // leaves in the set (append-only; monotone)
//!     uint64  finalizedSlot;           // beacon slot of the finalized header proven against (monotone)
//!     bytes32 finalizedExecStateRoot;  // execution stateRoot the storage proofs were verified against
//!     bytes32 syncCommitteeRoot;       // the sync-committee anchor the proof chained from (weak-subjectivity)
//! }
//! ```
//!
//! ## How the Bitcoin reflection consumes it (Phase 2)
//!
//! The Bitcoin reflection guest RECURSIVELY verifies the eth-reflection proof (pinning its vkey),
//! reads `crossOutSetRoot`, and for each `T_CROSSOUT_MINT` (opcode `0x65`: `assetId ‖ claimId ‖ Cx ‖
//! Cy ‖ owner`) it scans, folds the note into the pool root + live UTXO set ONLY IF the cross-out is
//! a member of the set — `eth_crossout_member(&co, index, &path, &crossOutSetRoot)` — AND the note's
//! reflected leaf equals `co.dest_commitment` (so the minted Bitcoin note matches the value Ethereum
//! committed). A non-member (fake/unconfirmed) cross-out folds nothing: the worker cannot inject
//! unbacked value, and a fake cross-out can never enter the bridge-mintable pool root.
//!
//! ## Field binding
//!
//! The Ethereum contract sets `claimId = keccak(destChain ‖ destCommitment ‖ nullifier ‖ assetId)`
//! ([`crate::claim_id`]; `destChain` is `uint16`, 2 bytes BE). The eth-reflection guest reads only
//! `crossOutCommitment[claimId] == destCommitment` from storage, so it takes `(destChain, nullifier,
//! assetId)` as witness and re-derives `claimId` to prove they are the real bound fields BEFORE
//! appending the leaf. The leaf carries `(claimId, destChain, destCommitment, assetId)` explicitly so
//! the Bitcoin guest re-derives the SAME leaf from envelope fields — it has `claimId`,
//! `destCommitment`, `assetId`, and `destChain == BITCOIN` by construction — with no need for the
//! Ethereum nullifier (which it never sees).

use crate::{keccak_merkle_verify, kn};

/// `destChain` selector — matches `ConfidentialPool.CrossOut.destChain`.
pub const DEST_CHAIN_BITCOIN: u16 = 1;
pub const DEST_CHAIN_ETHEREUM: u16 = 2;

/// A cross-out verified by the eth-reflection guest: the fields the Bitcoin guest binds a
/// `T_CROSSOUT_MINT` note against. `claim_id` is the unique key; `dest_commitment` is the Bitcoin
/// pool leaf the minted note must equal; `asset_id` is the (shared) asset; `dest_chain` gates the
/// destination (only `DEST_CHAIN_BITCOIN` cross-outs are foldable on Bitcoin).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EthCrossOut {
    pub claim_id: [u8; 32],
    pub dest_chain: u16,
    pub dest_commitment: [u8; 32],
    pub asset_id: [u8; 32],
}

/// The cross-out set leaf both guests build: `keccak(claimId ‖ destChain_be2 ‖ destCommitment ‖
/// assetId)`. Carries the fields explicitly (not just `claimId`) so the Bitcoin guest can bind a
/// note to the cross-out WITHOUT the Ethereum nullifier.
pub fn eth_crossout_leaf(co: &EthCrossOut) -> [u8; 32] {
    kn(&[&co.claim_id, &co.dest_chain.to_be_bytes(), &co.dest_commitment, &co.asset_id])
}

/// Membership of a cross-out in the eth-reflection set (`crossOutSetRoot`). The Bitcoin reflection
/// guest calls this before folding a `T_CROSSOUT_MINT` note; a `false` result folds nothing.
pub fn eth_crossout_member(co: &EthCrossOut, index: u64, path: &[[u8; 32]], set_root: &[u8; 32]) -> bool {
    keccak_merkle_verify(&eth_crossout_leaf(co), index, path, set_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{claim_id, keccak_merkle_root, KeccakTreeAccumulator, KECCAK_TREE_DEPTH};

    fn co(tag: u8, dest_chain: u16) -> EthCrossOut {
        let dest_commitment = kn(&[&[tag], b"dest"]);
        let asset_id = kn(&[&[tag], b"asset"]);
        let nullifier = kn(&[&[tag], b"eth-nu"]);
        // claimId is bound exactly as the contract derives it (the eth-reflection guest proves this
        // preimage against the on-chain crossOutCommitment slot before committing the leaf).
        let claim_id = claim_id(dest_chain, &dest_commitment, &nullifier, &asset_id);
        EthCrossOut { claim_id, dest_chain, dest_commitment, asset_id }
    }

    /// A depth-32 membership path for `leaves[index]`, mirroring `keccak_merkle_root`'s level fold
    /// (the build side; the verify side is `keccak_merkle_verify`).
    fn member_path(leaves: &[[u8; 32]], index: u64) -> Vec<[u8; 32]> {
        let mut zeros = [[0u8; 32]; KECCAK_TREE_DEPTH];
        for i in 1..KECCAK_TREE_DEPTH { zeros[i] = kn(&[&zeros[i - 1], &zeros[i - 1]]); }
        let mut level = leaves.to_vec();
        let mut idx = index as usize;
        let mut path = Vec::with_capacity(KECCAK_TREE_DEPTH);
        for i in 0..KECCAK_TREE_DEPTH {
            let sib = if (idx ^ 1) < level.len() { level[idx ^ 1] } else { zeros[i] };
            path.push(sib);
            let mut next = Vec::with_capacity((level.len() + 1) / 2);
            let mut k = 0;
            while k * 2 < level.len() {
                let l = level[2 * k];
                let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[i] };
                next.push(kn(&[&l, &r]));
                k += 1;
            }
            level = next;
            idx >>= 1;
        }
        path
    }

    #[test]
    fn crossout_leaf_is_deterministic_and_binds_all_fields() {
        let a = co(1, DEST_CHAIN_BITCOIN);
        assert_eq!(eth_crossout_leaf(&a), eth_crossout_leaf(&a), "deterministic");
        // Flipping any field changes the leaf (binds claimId, destChain, destCommitment, assetId).
        let mut b = a; b.dest_commitment = kn(&[b"other"]);
        assert_ne!(eth_crossout_leaf(&a), eth_crossout_leaf(&b), "destCommitment bound");
        let mut c = a; c.dest_chain = DEST_CHAIN_ETHEREUM;
        assert_ne!(eth_crossout_leaf(&a), eth_crossout_leaf(&c), "destChain bound");
        let mut d = a; d.asset_id = kn(&[b"other-asset"]);
        assert_ne!(eth_crossout_leaf(&a), eth_crossout_leaf(&d), "assetId bound");
    }

    #[test]
    fn accumulator_membership_round_trips() {
        // Build the set the way the eth-reflection guest does (append-only KeccakTreeAccumulator),
        // then prove each member — and reject a non-member and a tampered field.
        let set: Vec<EthCrossOut> = (0..5).map(|i| co(i as u8, DEST_CHAIN_BITCOIN)).collect();
        let leaves: Vec<[u8; 32]> = set.iter().map(eth_crossout_leaf).collect();

        let mut acc = KeccakTreeAccumulator::new();
        for l in &leaves { acc.append(l); }
        let root = acc.root();
        assert_eq!(root, keccak_merkle_root(&leaves), "accumulator == batch root");

        for (i, c) in set.iter().enumerate() {
            let path = member_path(&leaves, i as u64);
            assert!(eth_crossout_member(c, i as u64, &path, &root), "member {i} verifies");
        }

        // A cross-out NOT in the set (fake/unconfirmed) has no valid path → folds nothing.
        let fake = co(99, DEST_CHAIN_BITCOIN);
        let path0 = member_path(&leaves, 0);
        assert!(!eth_crossout_member(&fake, 0, &path0, &root), "non-member rejected");

        // A real member with one field tampered (e.g. an attacker swaps destCommitment) is rejected.
        let mut tampered = set[2];
        tampered.dest_commitment = kn(&[b"swapped"]);
        let path2 = member_path(&leaves, 2);
        assert!(!eth_crossout_member(&tampered, 2, &path2, &root), "tampered field rejected");
    }
}
