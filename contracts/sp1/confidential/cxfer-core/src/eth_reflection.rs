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
//! struct EthReflectionPublicValues {     // 11 static ABI words; reflect.rs Mode-B reads them by offset
//!     bytes32 priorDigest;             // [0] eth app-accumulator state this cycle continues from (chain)
//!     bytes32 newDigest;               // [1] app-accumulator state after this cycle (next cycle's prior)
//!     address ethPool;                 // [2] the ConfidentialPool whose crossOut/consumed slots were proven
//!     bytes32 crossOutSetRoot;         // [3] KeccakTreeAccumulator root over EthCrossOut leaves — membership target
//!     uint64  crossOutCount;           // [4] leaves in the crossOut set (append-only; monotone)
//!     uint64  finalizedSlot;           // [5] beacon slot of the finalized header proven against (monotone)
//!     bytes32 finalizedExecStateRoot;  // [6] execution stateRoot the storage proofs were verified against
//!     bytes32 syncCommitteeRoot;       // [7] sync committee AFTER the proven light-client update
//!     bytes32 prevSyncCommitteeRoot;   // [8] genesis / weak-subjectivity anchor the chain started from —
//!                                      //     reflect.rs asserts word [8] == the pinned ETH_GENESIS_SYNC_COMMITTEE
//!     bytes32 consumedNuSetRoot;       // [9] KeccakTreeAccumulator root over EthConsumed leaves (fast lane)
//!     uint64  consumedNuCount;         // [10] leaves in the consumed-ν set (append-only; the completeness count)
//! }
//! ```
//! NOTE: `eth_refl_digest` (priorDigest/newDigest) chains the APP ACCUMULATOR ONLY — both set roots + counts
//! (see below). Finality progression (monotone `finalizedSlot`, light-client verification, the weak-
//! subjectivity anchor) is re-proven by the eth guest EACH cycle and gated on-chain by the freshness count,
//! NOT carried in the digest — so do not read priorDigest/newDigest as pinning finality.
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

use crate::{keccak_merkle_verify, kn, KeccakTreeAccumulator};

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

/// FAST LANE (consumed-ν reverse reflection). A Bitcoin-homed note whose nullifier was spent by a
/// value-exit on the Ethereum fast lane — recorded on-chain as `ConfidentialPool.bitcoinConsumed[ν] =
/// spendRoot` (the eth-reflection guest proves that storage slot, slot 119). The Bitcoin reflection guest
/// folds each MEMBER into the spent set (Ethereum-senior), so the source note can't be re-spent on
/// Bitcoin. Unlike a cross-out (whose omission is liveness-only), a consumed-ν omission is a DOUBLE-SPEND,
/// so the Bitcoin guest must fold the WHOLE set each cycle (completeness via `consumed_count`), not a
/// subset. `nullifier` is the key; `spend_root` is the slot value (the Bitcoin pool root membership was
/// proven against — an audit trail, and it makes the leaf bind the authorizing root).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EthConsumed {
    pub nullifier: [u8; 32],
    pub spend_root: [u8; 32],
}

/// The consumed-set leaf: `keccak(ν ‖ spendRoot)`.
pub fn eth_consumed_leaf(c: &EthConsumed) -> [u8; 32] {
    kn(&[&c.nullifier, &c.spend_root])
}

/// Membership of a consumed ν in the eth-reflection consumed set (`consumedNuSetRoot`). The Bitcoin
/// reflection guest proves this for EVERY new consumed ν before folding it into the spent set.
pub fn eth_consumed_member(c: &EthConsumed, index: u64, path: &[[u8; 32]], set_root: &[u8; 32]) -> bool {
    keccak_merkle_verify(&eth_consumed_leaf(c), index, path, set_root)
}

// ──────────────────── ConfidentialPool storage-slot derivation (eth_getProof keys) ────────────────────
// The eth-reflection guest proves THESE exact slots against the finalized execution stateRoot, so the
// indices must track `forge inspect ConfidentialPool storageLayout` — a drift would prove the wrong
// storage. Single-source here (KAT-pinned to `cast index`), used by the guest via thin B256 wrappers.

/// `crossOutCommitment` (mapping) declaration slot.
pub const CROSSOUT_SLOT_INDEX: u64 = 76;
/// `bitcoinConsumed` (mapping) declaration slot — the fast-lane consumed-ν set.
pub const CONSUMED_SLOT_INDEX: u64 = 119;
/// `bitcoinConsumedCount` (plain uint) declaration slot — the fast-lane FRESHNESS anchor the guest reads
/// to assert it folded the COMPLETE recorded consume set as of the finalized block.
pub const CONSUMED_COUNT_SLOT_INDEX: u64 = 120;
/// `bitcoinConsumedAt` (mapping index => nullifier) declaration slot. Appended after the CDP tree state.
pub const CONSUMED_AT_SLOT_INDEX: u64 = 163;
/// `crossOutCount` (plain uint) declaration slot — the cross-out FRESHNESS anchor (mirror of the consumed
/// count) the guest reads to assert it folded the COMPLETE recorded cross-out set as of the finalized block.
pub const CROSSOUT_COUNT_SLOT_INDEX: u64 = 169;
/// `crossOutAt` (mapping index => claimId) declaration slot — the enumerable cross-out log. Appended last.
pub const CROSSOUT_AT_SLOT_INDEX: u64 = 170;

/// Storage location of `mapping(bytes32 => _)[key]` declared at `slot`: `keccak256(key ‖ uint256(slot))`
/// — the Solidity mapping-slot rule, matching the `eth_getProof` key the contract exposes.
pub fn mapping_slot_key(key: &[u8; 32], slot: u64) -> [u8; 32] {
    let mut slot32 = [0u8; 32];
    slot32[24..].copy_from_slice(&slot.to_be_bytes());
    kn(&[key, &slot32])
}

/// Storage location of a PLAIN (non-mapping) variable declared at `slot`: the slot index as a uint256
/// (left-padded to 32 bytes) — e.g. `bitcoinConsumedCount`.
pub fn plain_slot_key(slot: u64) -> [u8; 32] {
    let mut k = [0u8; 32];
    k[24..].copy_from_slice(&slot.to_be_bytes());
    k
}

/// Decode a uint256 storage slot known to hold a small count into u64. Panics if it exceeds u64 —
/// silent truncation would weaken the freshness completeness equality (`consumed_count == count`).
pub fn slot_value_to_u64(value: &[u8; 32]) -> u64 {
    assert!(value[..24].iter().all(|&b| b == 0), "storage count exceeds u64");
    u64::from_be_bytes(value[24..32].try_into().unwrap())
}

// ──────────────────── eth-reflection accumulator digest (the cross-cycle anchor) ────────────────────
// SINGLE SOURCE for the digest the eth-reflection guest commits as priorDigest/newDigest AND the value
// the Bitcoin reflection guest stores in `ScanReflection.eth_refl_digest` to chain it. The Bitcoin guest
// folds this into its own resume digest, so the contract's `priorDigest == knownReflectionDigest` chain
// transitively forces each Mode-B cycle's witnessed eth prior to continue the one the prior cycle
// committed — a witnessed eth accumulator prior can no longer be forged. (DESIGN-mode-b-recursion.md §2.)

/// `keccak(pool ‖ crossOutSetRoot ‖ crossOutCount_be8 ‖ consumedNuSetRoot ‖ consumedNuCount_be8)`.
/// `pool` is the 20-byte address; the two roots are 32 bytes each. Binds the WHOLE eth accumulator
/// (both sets + counts) into one chaining value, so anchoring it covers crossOut and consumed alike.
pub fn eth_refl_digest(pool: &[u8], set_root: &[u8], count: u64, consumed_root: &[u8], consumed_count: u64) -> [u8; 32] {
    // `pool` is the 20-byte address (callers pass the low 20 bytes of the ABI word, e.g. `&ep[12..32]`); a
    // wrong slice — the full 32-byte word vs. the low 20 — chains a DIFFERENT genesis digest, so pin it.
    assert_eq!(pool.len(), 20, "eth_refl_digest: pool must be the 20-byte address");
    kn(&[pool, set_root, &count.to_be_bytes(), consumed_root, &consumed_count.to_be_bytes()])
}

/// The eth-reflection accumulator's GENESIS digest for `pool`: both sets empty (the append-only
/// `KeccakTreeAccumulator` empty root), both counts 0. The Bitcoin guest requires the FIRST Mode-B
/// eth proof's priorDigest to equal this (before any cycle has committed an eth state).
pub fn eth_refl_genesis_digest(pool: &[u8]) -> [u8; 32] {
    let empty = KeccakTreeAccumulator::new().root();
    eth_refl_digest(pool, &empty, 0, &empty, 0)
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

    fn consumed(tag: u8) -> EthConsumed {
        EthConsumed { nullifier: kn(&[&[tag], b"nu"]), spend_root: kn(&[&[tag], b"spendroot"]) }
    }

    #[test]
    fn consumed_leaf_binds_nu_and_spendroot_and_set_round_trips() {
        let a = consumed(1);
        assert_eq!(eth_consumed_leaf(&a), eth_consumed_leaf(&a), "deterministic");
        let mut b = a; b.spend_root = kn(&[b"other-root"]);
        assert_ne!(eth_consumed_leaf(&a), eth_consumed_leaf(&b), "spendRoot bound");
        let mut c = a; c.nullifier = kn(&[b"other-nu"]);
        assert_ne!(eth_consumed_leaf(&a), eth_consumed_leaf(&c), "nullifier bound");

        // Append-only set membership round-trips; a non-member folds nothing (and would, in the guest,
        // mean a ν left unmarked on Bitcoin — caught by the completeness count, not by this gate alone).
        let set: Vec<EthConsumed> = (0..5).map(|i| consumed(i as u8)).collect();
        let leaves: Vec<[u8; 32]> = set.iter().map(eth_consumed_leaf).collect();
        let mut acc = KeccakTreeAccumulator::new();
        for l in &leaves { acc.append(l); }
        let root = acc.root();
        for (i, c) in set.iter().enumerate() {
            assert!(eth_consumed_member(c, i as u64, &member_path(&leaves, i as u64), &root), "member {i}");
        }
        let fake = consumed(99);
        assert!(!eth_consumed_member(&fake, 0, &member_path(&leaves, 0), &root), "non-member rejected");
    }

    fn hx(s: &str) -> [u8; 32] {
        let v = hex::decode(s).unwrap();
        let mut a = [0u8; 32];
        a.copy_from_slice(&v);
        a
    }

    /// KAT — the storage-slot keys match ConfidentialPool's real layout. Ground truth from
    /// `cast index bytes32 <key> <slot>` (mappings) and `bytes32(slot)` (plain vars). Pins the indices the
    /// eth-reflection guest proves against the finalized stateRoot: a slot drift here (or a pool relayout
    /// not mirrored) would silently prove the WRONG storage, so it must fail loudly.
    #[test]
    fn storage_slot_keys_match_solidity_layout() {
        let key = [0x11u8; 32];
        // bitcoinConsumed[key] @ slot 119  (cast index bytes32 0x11..11 119)
        assert_eq!(
            mapping_slot_key(&key, CONSUMED_SLOT_INDEX),
            hx("ddcf687da0e7721af4ba601e6197dcf9cfae4e0a011690e104fcf4f36a1f4eb0"),
            "bitcoinConsumed mapping slot",
        );
        // crossOutCommitment[key] @ slot 76  (cast index bytes32 0x11..11 76)
        assert_eq!(
            mapping_slot_key(&key, CROSSOUT_SLOT_INDEX),
            hx("ccd8e9783d7c5c4e8e3e59c53db1dbe096e99276ea2ca18ad3a7e3286e7c3a67"),
            "crossOutCommitment mapping slot",
        );
        // bitcoinConsumedAt[key] @ slot 163  (cast index bytes32 0x11..11 163)
        assert_eq!(
            mapping_slot_key(&key, CONSUMED_AT_SLOT_INDEX),
            hx("a0861c0ba1e5981f2bbbcb4b6e25b8c7b31b60fb1d9657c9b644743f93adbe36"),
            "bitcoinConsumedAt mapping slot",
        );
        // bitcoinConsumedCount @ slot 120 (plain uint) → bytes32(120) == 0x…0078
        let mut want = [0u8; 32];
        want[31] = 0x78;
        assert_eq!(plain_slot_key(CONSUMED_COUNT_SLOT_INDEX), want, "plain count slot = bytes32(120)");
        // crossOutAt[key] @ slot 170  (cast index uint256 0x11..11 170)
        assert_eq!(
            mapping_slot_key(&key, CROSSOUT_AT_SLOT_INDEX),
            hx("cf4b963ea9a15592de2bec759fe1d5f65da07c19db0db7fbe0efefe1292d87fe"),
            "crossOutAt mapping slot",
        );
        // crossOutCount @ slot 169 (plain uint) → bytes32(169) == 0x…00a9
        let mut want_co = [0u8; 32];
        want_co[31] = 0xa9;
        assert_eq!(plain_slot_key(CROSSOUT_COUNT_SLOT_INDEX), want_co, "plain crossOutCount slot = bytes32(169)");
        // count decode: low 8 bytes, big-endian; high bytes must be zero.
        let mut v = [0u8; 32];
        v[24..].copy_from_slice(&7u64.to_be_bytes());
        assert_eq!(slot_value_to_u64(&v), 7, "count decode");
    }

    #[test]
    #[should_panic(expected = "storage count exceeds u64")]
    fn slot_value_over_u64_panics() {
        let mut v = [0u8; 32];
        v[23] = 1; // a bit above the low 8 bytes ⇒ > u64::MAX
        let _ = slot_value_to_u64(&v);
    }
}
