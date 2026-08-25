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
//! finalized execution stateRoot, and inserts each verified cross-out into a cross-out indexed-Merkle tree
//! (the consumed-ν set is a separate keccak append set). Its public values (alloy `sol!`, in the guest crate):
//!
//! ```text
//! struct EthReflectionPublicValues {     // 11 static ABI words; reflect.rs Mode-B reads them by offset
//!     bytes32 priorDigest;             // [0] eth app-accumulator state this cycle continues from (chain)
//!     bytes32 newDigest;               // [1] app-accumulator state after this cycle (next cycle's prior)
//!     address ethPool;                 // [2] the ConfidentialPool whose crossOut/consumed slots were proven
//!     bytes32 crossOutSetRoot;         // [3] indexed-Merkle-tree root keyed by the EthCrossOut leaf — membership/non-membership target
//!     uint64  crossOutCount;           // [4] cross-outs recorded as of the finalized slot (monotone)
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
//! a member of the set — `eth_crossout_imt(&co, &crossOutSetRoot, ..)` proves membership — AND the note's
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

/// Cross-out IMT presence. `crossOutSetRoot` is an Indexed-Merkle tree keyed by `eth_crossout_leaf` so the
/// Bitcoin guest can prove ABSENCE, not just membership — a prover cannot supply a bad membership path to
/// skip a real mint. The prover CLAIMS membership
/// (→ `Some(true)`: fold the confirmed mint) or non-membership (→ `Some(false)`: skip a fake 0x65). A LYING
/// claim — a membership witness for an absent leaf, OR a non-membership witness for a present leaf — fails
/// its check and returns `None`, which the caller turns into an ABORT: a malicious prover can no longer skip
/// a real cross-out (its leaf is deterministically present, so non-membership is unprovable), and a fake 0x65
/// still skips (its leaf is genuinely absent → a valid non-membership proof). `next` is the membership leaf's
/// successor (membership) or the straddling low leaf's successor (non-membership); `low_value` is used for
/// non-membership only.
pub fn eth_crossout_imt(
    co: &EthCrossOut,
    set_root: &[u8; 32],
    is_member: bool,
    next: &[u8; 32],
    low_value: &[u8; 32],
    index: u64,
    path: &[[u8; 32]],
) -> Option<bool> {
    let leaf = eth_crossout_leaf(co);
    if is_member {
        if crate::imt_membership(set_root, &leaf, next, index, path) { Some(true) } else { None }
    } else if crate::imt_non_membership(set_root, &leaf, low_value, next, index, path) {
        Some(false)
    } else {
        None
    }
}

/// FAST LANE (consumed-ν reverse reflection). A Bitcoin-homed note whose nullifier was spent by a
/// value-exit on the Ethereum fast lane — recorded on-chain as `ConfidentialPool.bitcoinConsumed[ν] =
/// spendRoot` (the eth-reflection guest proves that storage slot, slot 120). The Bitcoin reflection guest
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

/// An authenticated Ethereum→Bitcoin message, as recorded by `EthCallOutbox` and proven by the
/// eth-reflection guest. `msg_id` is the one-shot key (and the outbox's enumeration entry);
/// `record` is `msgRecord[msg_id]`, which commits the fields a relayer re-supplies on Bitcoin.
/// See `ops/DESIGN-eth-call-outbox.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EthMessage {
    pub msg_id: [u8; 32],
    pub record: [u8; 32],
}

/// The outbox commitment: `keccak(destChain_be2 ‖ ns ‖ sender20 ‖ payloadHash)` — the EXACT preimage
/// `EthCallOutbox.recordHashOf` builds with `abi.encodePacked(uint16, bytes32, address, bytes32)`.
/// The Bitcoin guest rebuilds this from the `T_ETH_CALL` envelope's `(ns, sender, payload)`, so a
/// relayer can neither redirect a message's handler nor alter its payload.
pub fn eth_message_record(dest_chain: u16, ns: &[u8; 32], sender: &[u8; 20], payload_hash: &[u8; 32]) -> [u8; 32] {
    kn(&[&dest_chain.to_be_bytes(), ns, sender, payload_hash])
}

/// The message-set leaf: `keccak(msgId ‖ recordHash)`. Both halves come from PROVEN outbox storage
/// (`msgAt[i]` and `msgRecord[msgId]`), and the record slot is keyed BY `msgId`, so the pairing is
/// forced by the slot derivation — a witness cannot pair one message's id with another's record.
pub fn eth_message_leaf(m: &EthMessage) -> [u8; 32] {
    kn(&[&m.msg_id, &m.record])
}

/// Membership of a message in the eth-reflection message set (`ethMsgSetRoot`). Membership-ONLY, with
/// no completeness gate on the fold: omitting a message means it does not apply (liveness), never a
/// double-spend, so the guest never has to fold the whole set. That is deliberate — an outbox `send`
/// is cheap, and a completeness-gated message set would let anyone force unbounded per-cycle
/// accumulator work on every future reflection proof (a permanent liveness attack on the bridge).
/// DO NOT add a completeness gate to this set (unlike the consume / cross-out sets, whose completeness IS
/// required because omitting one is a double-spend/censorship). Message soundness needs no order — the leaf
/// binds msg_id -> msgRecord[msg_id] from proven storage — so "fold whatever subset" is safe here and only
/// here. Making it completeness-gated to look symmetric with the other sets reintroduces the brick vector.
pub fn eth_message_member(m: &EthMessage, index: u64, path: &[[u8; 32]], set_root: &[u8; 32]) -> bool {
    keccak_merkle_verify(&eth_message_leaf(m), index, path, set_root)
}

// ──────────────────── EthCallOutbox storage-slot derivation ────────────────────
// A SECOND proven account (the pool is the first). The outbox is deliberately separate from the pool —
// least privilege, and it keeps the two storage formats uncoupled. Indices track the contract's layout
// (`forge inspect EthCallOutbox storageLayout`), pinned by `contracts/test/EthCallOutbox.t.sol`.

/// `msgCount` (plain uint64) declaration slot — the enumeration cursor.
pub const OUTBOX_MSG_COUNT_SLOT_INDEX: u64 = 0;
/// `msgAt` (mapping index => msgId) declaration slot — the enumerable log.
pub const OUTBOX_MSG_AT_SLOT_INDEX: u64 = 1;
/// `msgRecord` (mapping msgId => recordHash) declaration slot.
pub const OUTBOX_MSG_RECORD_SLOT_INDEX: u64 = 2;

/// Payload ceiling, mirroring `EthCallOutbox.MAX_PAYLOAD`. The CONTRACT is the binding side: it refuses
/// a longer payload, so a message accepted on Ethereum is always foldable here. Asserted in the Bitcoin
/// guest's envelope parse so the two can never drift apart silently.
pub const MAX_ETH_MESSAGE_PAYLOAD: usize = 1024;

// ──────────────────── ConfidentialPool storage-slot derivation (eth_getProof keys) ────────────────────
// The eth-reflection guest proves THESE exact slots against the finalized execution stateRoot, so the
// indices must track `forge inspect ConfidentialPool storageLayout` — a drift would prove the wrong
// storage. Single-source here (KAT-pinned to `cast index`), used by the guest via thin B256 wrappers.

/// `crossOutCommitment` (mapping) declaration slot.
pub const CROSSOUT_SLOT_INDEX: u64 = 77;
/// `bitcoinConsumed` (mapping) declaration slot — the fast-lane consumed-ν set.
pub const CONSUMED_SLOT_INDEX: u64 = 120;
/// `bitcoinConsumedCount` (plain uint) declaration slot — the fast-lane FRESHNESS anchor the guest reads
/// to assert it folded the COMPLETE recorded consume set as of the finalized block.
pub const CONSUMED_COUNT_SLOT_INDEX: u64 = 121;
/// `bitcoinConsumedAt` (mapping index => nullifier) declaration slot. Appended after the CDP tree state.
pub const CONSUMED_AT_SLOT_INDEX: u64 = 165;
/// `crossOutCount` (plain uint) declaration slot — the cross-out FRESHNESS anchor (mirror of the consumed
/// count) the guest reads to assert it folded the COMPLETE recorded cross-out set as of the finalized block.
pub const CROSSOUT_COUNT_SLOT_INDEX: u64 = 171;
/// `crossOutAt` (mapping index => claimId) declaration slot — the enumerable cross-out log. Appended last.
pub const CROSSOUT_AT_SLOT_INDEX: u64 = 172;

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
pub fn eth_refl_digest(
    pool: &[u8],
    set_root: &[u8],
    count: u64,
    consumed_root: &[u8],
    consumed_count: u64,
    msg_root: &[u8],
    msg_count: u64,
) -> [u8; 32] {
    // `pool` is the 20-byte address (callers pass the low 20 bytes of the ABI word, e.g. `&ep[12..32]`); a
    // wrong slice — the full 32-byte word vs. the low 20 — chains a DIFFERENT genesis digest, so pin it.
    assert_eq!(pool.len(), 20, "eth_refl_digest: pool must be the 20-byte address");
    // The message set is bound here for the same reason the other two are: the digest is the cross-cycle
    // anchor, so a set root left OUT of it could be swapped for a forged one between cycles.
    kn(&[
        pool,
        set_root,
        &count.to_be_bytes(),
        consumed_root,
        &consumed_count.to_be_bytes(),
        msg_root,
        &msg_count.to_be_bytes(),
    ])
}

/// The eth-reflection accumulator's GENESIS digest for `pool`: both sets empty, both counts 0. The Bitcoin
/// guest requires the FIRST Mode-B eth proof's priorDigest to equal this (before any cycle has committed an
/// eth state). The cross-out set is an indexed-Merkle tree (its empty root is the IMT sentinel); the
/// consumed-ν set is a keccak append tree (its empty root is the append-tree sentinel).
pub fn eth_refl_genesis_digest(pool: &[u8]) -> [u8; 32] {
    eth_refl_digest(
        pool,
        &crate::imt_empty_root(),
        0,
        &KeccakTreeAccumulator::new().root(),
        0,
        &KeccakTreeAccumulator::new().root(),
        0,
    )
}

#[cfg(test)]
mod tests {
    /// CROSS-LANGUAGE KAT. `record` must equal `EthCallOutbox.recordHashOf` byte-for-byte — the contract
    /// is the binding side (it refuses what it will not commit), so a drift here means messages accepted
    /// on Ethereum become unfoldable on Bitcoin. Mirrored in contracts/test/EthCallOutbox.t.sol.
    #[test]
    fn message_record_matches_solidity_recordhashof() {
        let ns = crate::kn(&[b"tacit-ns-attest-v1"]);
        let payload_hash = crate::kn(&[b"hello"]);
        let mut sender = [0u8; 20];
        sender[18] = 0xa1;
        sender[19] = 0x1c;
        let record = eth_message_record(1, &ns, &sender, &payload_hash);
        assert_eq!(
            hex_lower(&record),
            "0d6a81b8062c850eabea90ec9a223a5e2aba6f7e8ddaf5d46c102e63507241be",
            "record hash drifted from EthCallOutbox.recordHashOf",
        );
    }

    #[test]
    fn message_record_binds_every_field() {
        let ns = crate::kn(&[b"tacit-ns-attest-v1"]);
        let ph = crate::kn(&[b"hello"]);
        let sender = [7u8; 20];
        let base = eth_message_record(1, &ns, &sender, &ph);
        assert_ne!(base, eth_message_record(2, &ns, &sender, &ph), "destChain not bound");
        assert_ne!(base, eth_message_record(1, &[9u8; 32], &sender, &ph), "ns not bound");
        assert_ne!(base, eth_message_record(1, &ns, &[8u8; 20], &ph), "sender not bound");
        assert_ne!(base, eth_message_record(1, &ns, &sender, &[3u8; 32]), "payload hash not bound");
    }

    #[test]
    fn message_leaf_round_trips_through_the_set() {
        let mut acc = KeccakTreeAccumulator::new();
        let msgs: Vec<EthMessage> = (0u8..4)
            .map(|i| EthMessage { msg_id: [i; 32], record: [i.wrapping_add(100); 32] })
            .collect();
        for m in &msgs {
            acc.append(&eth_message_leaf(m));
        }
        let root = acc.root();
        let leaves: Vec<[u8; 32]> = msgs.iter().map(eth_message_leaf).collect();
        for (i, m) in msgs.iter().enumerate() {
            let path = member_path(&leaves, i as u64);
            assert!(eth_message_member(m, i as u64, &path, &root), "member {i} must verify");
            // A message not in the set has no valid path — omission is liveness-only, so the guest SKIPS
            // rather than aborts, but it must never verify as a member.
            let absent = EthMessage { msg_id: [0xEE; 32], record: m.record };
            assert!(!eth_message_member(&absent, i as u64, &path, &root), "absent message verified");
        }
    }

    #[test]
    fn refl_digest_binds_the_message_set() {
        let pool = [1u8; 20];
        let empty = KeccakTreeAccumulator::new().root();
        let other = crate::kn(&[b"another root"]);
        let base = eth_refl_digest(&pool, &empty, 0, &empty, 0, &empty, 0);
        assert_ne!(base, eth_refl_digest(&pool, &empty, 0, &empty, 0, &other, 0), "msg root not bound");
        assert_ne!(base, eth_refl_digest(&pool, &empty, 0, &empty, 0, &empty, 1), "msg count not bound");
    }

    fn hex_lower(b: &[u8; 32]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    use super::*;
    use crate::{claim_id, KeccakTreeAccumulator, KECCAK_TREE_DEPTH};

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
        // bitcoinConsumed[key] @ slot 120  (cast index bytes32 0x11..11 120)
        assert_eq!(
            mapping_slot_key(&key, CONSUMED_SLOT_INDEX),
            hx("bc249583c0a551517d3cff6f0ebdb426ec59578f0af5a909f477d8d33cb5912c"),
            "bitcoinConsumed mapping slot",
        );
        // crossOutCommitment[key] @ slot 77  (cast index bytes32 0x11..11 77)
        assert_eq!(
            mapping_slot_key(&key, CROSSOUT_SLOT_INDEX),
            hx("d2c745364fb9bfa543c7b2b32cc06d661ef9978fd6ba7e1dd336573ef0214fa5"),
            "crossOutCommitment mapping slot",
        );
        // bitcoinConsumedAt[key] @ slot 165  (cast index bytes32 0x11..11 165)
        assert_eq!(
            mapping_slot_key(&key, CONSUMED_AT_SLOT_INDEX),
            hx("5fd299ac698a4011c260ca05625a0eb71615406c0aadb8d0223bf51945eef1eb"),
            "bitcoinConsumedAt mapping slot",
        );
        // bitcoinConsumedCount @ slot 121 (plain uint) → bytes32(121) == 0x…0079
        let mut want = [0u8; 32];
        want[31] = 0x79;
        assert_eq!(plain_slot_key(CONSUMED_COUNT_SLOT_INDEX), want, "plain count slot = bytes32(121)");
        // crossOutAt[key] @ slot 172  (cast index uint256 0x11..11 172)
        assert_eq!(
            mapping_slot_key(&key, CROSSOUT_AT_SLOT_INDEX),
            hx("6449168b6e547bf96effeaf2f51c1bd6068c9ab43c9970c0047f46385e529c70"),
            "crossOutAt mapping slot",
        );
        // crossOutCount @ slot 171 (plain uint) → bytes32(171) == 0x…00ab
        let mut want_co = [0u8; 32];
        want_co[31] = 0xab;
        assert_eq!(plain_slot_key(CROSSOUT_COUNT_SLOT_INDEX), want_co, "plain crossOutCount slot = bytes32(171)");
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
