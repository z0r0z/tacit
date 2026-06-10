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

use alloy_sol_types::sol;
use alloy_sol_types::SolType;
use cxfer_core::{bitcoin, commitment_hash_compressed, outpoint_key, reflected_note_leaf, scan_tx_spends, LiveUtxoSet, ScanReflection};
use sp1_zkvm::io;

sol! {
    struct BitcoinReflectionPublicValues {
        bytes32 priorDigest;       // the reflected state this cycle continues from
        bytes32 bitcoinPoolRoot;   // note-tree root after the batch
        bytes32 bitcoinSpentRoot;  // spent-set IMT root after the batch
        bytes32 bitcoinBurnRoot;   // bridge-burn set root after the batch
        uint64  bitcoinHeight;     // confirmed Bitcoin height the batch advanced to
        bytes32 newDigest;         // the reflected state after the batch (next cycle's prior)
        bytes32 bitcoinPrevHash;   // headers[0]'s prev-block field — the anchor this batch resumes from
        bytes32 bitcoinTipHash;    // double-SHA256 of the last header — the batch's new tip
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] { r_n::<32>() }
fn r_path() -> Vec<[u8; 32]> { (0..32).map(|_| r32()).collect() }

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
    let live_pairs: Vec<([u8; 32], [u8; 32])> = (0..n_live).map(|_| (r32(), r32())).collect();
    let live = LiveUtxoSet::from_sorted(live_pairs).expect("handed live UTXO set not sorted/unique");
    let burn_root = r32();
    let burn_count: u64 = io::read();
    let height: u64 = io::read();
    ScanReflection { pool_root, note_count, spent_root, spent_count, live, burn_root, burn_count, height }
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
fn read_burn_insert() -> ([u8; 32], [u8; 32], [u8; 32], u64, Vec<[u8; 32]>, Vec<[u8; 32]>) {
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

    // Header chain: non-empty, links (prev_hash) + carries valid PoW, and EXPOSES its anchor
    // (headers[0]'s prev) + tip so the CONTRACT can pin them to the canonical relay — forcing the
    // whole batch to be canonical Bitcoin (F1/F2/F3).
    let anchor_height: u64 = io::read();
    let num_headers: u32 = io::read();
    let headers: Vec<Vec<u8>> = (0..num_headers).map(|_| io::read()).collect();
    assert!(num_headers > 0, "reflection batch needs >=1 header to anchor");
    let refs: Vec<&[u8]> = headers.iter().map(|h| h.as_slice()).collect();
    let tip_hash = bitcoin::verify_header_chain(&refs).expect("invalid Bitcoin header chain");
    let prev_hash: [u8; 32] = headers[0][4..36].try_into().expect("header prev field");

    // FULL SCAN: every tx of every block, in order.
    for block_index in 0..(num_headers as usize) {
        let merkle_root = bitcoin::extract_merkle_root(&headers[block_index]);
        let n_tx: u32 = io::read();
        let txs: Vec<Vec<u8>> = (0..n_tx).map(|_| io::read()).collect();
        // Completeness of the tx set: the provided txs ARE the whole block — their txid merkle
        // root equals the header's. So no tx (hence no pool spend) can be silently omitted.
        let txids: Vec<[u8; 32]> = txs.iter().map(|t| bitcoin::compute_txid(t)).collect();
        assert_eq!(bitcoin::compute_merkle_root(&txids), merkle_root, "provided txs are not the complete block");
        let height = anchor_height + block_index as u64;
        assert!(height >= state.height, "reflection height must not decrease");

        for (ti, tx) in txs.iter().enumerate() {
            let txid = txids[ti];

            // Vin-scan: every input that hits a live pool UTXO is a spend that MUST be folded. The
            // opening (Cx,Cy) for each is read in vin order and bound to the outpoint's stored
            // commitment inside scan_tx_spends (a forged opening is a hard reject).
            let spends = scan_tx_spends(tx, &mut state.live, || (r32(), r32()))
                .expect("vin scan / opening bind");

            // Classify by envelope: most txs have none (their spends are plain pool-UTXO spends,
            // still nullified). A burn envelope marks a bridge-out; a cxfer envelope declares
            // output notes.
            let env = bitcoin::extract_taproot_envelope(tx);
            let burn = env.as_ref().and_then(|e| bitcoin::parse_burn_envelope(e));
            let cxfer = env.as_ref().and_then(|e| bitcoin::parse_cxfer_envelope(e));

            // Fold the detected spends into the spent-set (witnessed IMT insert, in scan order).
            for (_outpoint, nu) in &spends {
                let (sv, sn, si, sp, snew) = read_spent_insert();
                state.fold_spent(nu, &sv, &sn, si, &sp, &snew).expect("spent-set fold");
            }

            // A bridge-out records ν → destCommitment in the burn set (the burned note is the
            // tx's single detected spend, bound to the envelope's nullifier).
            if let Some((_asset, env_nu, env_dest)) = &burn {
                assert!(spends.len() == 1 && &spends[0].1 == env_nu, "burn envelope must match the single spent note");
                let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                state.fold_burn(env_nu, env_dest, &bk, &bn, &bv, bi, &bp, &bnew).expect("burn-set fold");
            }

            // A cxfer tx's outputs are new pool notes: the note leaf (asset/owner/commitment) is
            // witnessed, its commitment bound to the envelope's declared point, its outpoint to a
            // real vout. Added to the live set so a later tx in the batch can spend it.
            if let Some((asset, commitments)) = &cxfer {
                for commitment in commitments {
                    let note_path = r_path();
                    let vout: u32 = io::read();
                    let outpoint = outpoint_key(&txid, vout);
                    // DERIVE the note leaf from the envelope's asset + commitment (not a free witness),
                    // so a relayer can't append an arbitrary attacker-spendable leaf into bitcoinPoolRoot.
                    let note_leaf = reflected_note_leaf(asset, commitment).expect("envelope commitment is a curve point");
                    let ch = commitment_hash_compressed(commitment).expect("envelope commitment is a curve point");
                    state.fold_output(&note_leaf, &note_path, &outpoint, &ch).expect("output fold");
                }
            }
        }
        state.height = height;
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
    };
    io::commit_slice(&BitcoinReflectionPublicValues::abi_encode(&pv));
}
