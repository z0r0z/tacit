//! Reflection prover — proves the Bitcoin confidential-pool roots that
//! ConfidentialPool.attestBitcoinStateProven pins as the cross-lane / bridge_mint authority.
//!
//! Resume-from-digest (witnessed-incremental, O(Δ)/cycle): read the prior reflection state
//! (roots + counts + height), verify it hashes to `priorDigest`, fold the batch's confirmed
//! Δ-effects through the witnessed accumulator transitions, and commit the new roots + digest.
//! The contract chains cycles by checking `priorDigest == knownReflectionDigest` then setting
//! `knownReflectionDigest = newDigest`, so a proof can only EXTEND the attested state.
//!
//! Trustless inputs landing in layers:
//!   - header-chain PoW (verify_header_chain) — DONE here: the batch's confirmed tip.
//!   - per-effect tx-inclusion (verify_tx_in_block) + outpoint binding (extract_inputs) +
//!     envelope parse (extract_taproot_envelope → note/dest) — the next increment; until it
//!     lands this program is the fold+PoW+digest-chaining scaffold, NOT a live BITCOIN_RELAY_VKEY.
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::sol;
use alloy_sol_types::SolType;
use cxfer_core::{bitcoin, confirm_pool_tx, nullifier, outpoint_key, BurnWitness, OutputWitness, SpendWitness, WitnessedReflection};
use sp1_zkvm::io;

const OP_TRANSFER: u8 = 0;
const OP_BRIDGE_OUT: u8 = 1;

sol! {
    struct BitcoinReflectionPublicValues {
        bytes32 priorDigest;       // the reflected state this cycle continues from
        bytes32 bitcoinPoolRoot;   // note-tree root after the batch
        bytes32 bitcoinSpentRoot;  // spent-set IMT root after the batch
        bytes32 bitcoinBurnRoot;   // bridge-burn set root after the batch
        uint64  bitcoinHeight;     // confirmed Bitcoin height the batch advanced to
        bytes32 newDigest;         // the reflected state after the batch (next cycle's prior)
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] { r_n::<32>() }
fn r_path() -> Vec<[u8; 32]> { (0..32).map(|_| r32()).collect() }

/// Read the prior reflection state (roots + counts + height) — the resume anchor.
fn read_prior_state() -> WitnessedReflection {
    WitnessedReflection {
        pool_root: r32(),
        note_count: io::read(),
        spent_root: r32(),
        spent_count: io::read(),
        utxo_root: r32(),
        utxo_count: io::read(),
        burn_root: r32(),
        burn_count: io::read(),
        height: io::read(),
    }
}

fn read_spend() -> SpendWitness {
    SpendWitness {
        cx: r32(),
        cy: r32(),
        outpoint: r32(),
        s_low_value: r32(),
        s_low_next: r32(),
        s_low_index: io::read(),
        s_low_path: r_path(),
        s_new_path: r_path(),
        u_node_next: r32(),
        u_node_value: r32(),
        u_node_index: io::read(),
        u_node_path: r_path(),
        u_pred_key: r32(),
        u_pred_value: r32(),
        u_pred_index: io::read(),
        u_pred_path: r_path(),
    }
}

fn read_output() -> OutputWitness {
    OutputWitness {
        note_leaf: r32(),
        note_path: r_path(),
        outpoint: r32(),
        commitment_hash: r32(),
        u_low_key: r32(),
        u_low_next: r32(),
        u_low_value: r32(),
        u_low_index: io::read(),
        u_low_path: r_path(),
        u_new_path: r_path(),
    }
}

pub fn main() {
    let mut state = read_prior_state();
    let prior_digest = state.digest();

    // Header-chain PoW: the batch's headers are a valid difficulty-respecting chain anchored
    // at `anchor_height` (the contract checks headers[0] == the relay tip). Each effect cites
    // a block by index; its confirmed height is anchor_height + block_index.
    let anchor_height: u64 = io::read();
    let num_headers: u32 = io::read();
    let headers: Vec<Vec<u8>> = (0..num_headers).map(|_| io::read()).collect();
    if num_headers > 0 {
        let refs: Vec<&[u8]> = headers.iter().map(|h| h.as_slice()).collect();
        assert!(bitcoin::verify_header_chain(&refs).is_some(), "invalid Bitcoin header chain");
    }

    // Fold the batch's confirmed Δ-effects through the witnessed transitions. Each effect is
    // bound to a confirmed Bitcoin tx: confirm_pool_tx ties it to a PoW block in the chain
    // (verify_tx_in_block), every spent outpoint must be a real vin of that tx (extract_inputs),
    // and every output outpoint must be a real vout (outpoint_key(txid, vout)).
    let num_effects: u32 = io::read();
    for _ in 0..num_effects {
        let op: u8 = io::read();
        let block_index: u32 = io::read();
        let tx_data: Vec<u8> = io::read();
        let tx_index: u32 = io::read();
        let n_txids: u32 = io::read();
        let txids: Vec<[u8; 32]> = (0..n_txids).map(|_| r32()).collect();
        assert!((block_index as usize) < headers.len(), "block index outside the verified chain");
        let (txid, in_outpoints) = confirm_pool_tx(&headers[block_index as usize], &tx_data, tx_index, &txids)
            .expect("effect tx not confirmed in its block");
        let height = anchor_height + block_index as u64;

        match op {
            OP_TRANSFER => {
                let n_in: u32 = io::read();
                let m_out: u32 = io::read();
                let spends: Vec<SpendWitness> = (0..n_in).map(|_| read_spend()).collect();
                for s in &spends {
                    assert!(in_outpoints.contains(&s.outpoint), "spent outpoint is not a vin of the confirmed tx");
                }
                let outputs: Vec<OutputWitness> = (0..m_out)
                    .map(|_| {
                        let o = read_output();
                        let vout: u32 = io::read();
                        assert_eq!(outpoint_key(&txid, vout), o.outpoint, "output outpoint is not a vout of the confirmed tx");
                        o
                    })
                    .collect();
                state.apply_transfer(&spends, &outputs, height).expect("transfer fold");
            }
            OP_BRIDGE_OUT => {
                let spend = read_spend();
                assert!(in_outpoints.contains(&spend.outpoint), "burned outpoint is not a vin of the confirmed tx");
                // 3.3: the destCommitment (and ν) are bound to the burn ENVELOPE, not witnessed —
                // so a burn's Ethereum mint can't be redirected to a different destination.
                let env = bitcoin::extract_taproot_envelope(&tx_data).expect("burn envelope present");
                let (_asset, env_nu, env_dest) = bitcoin::parse_burn_envelope(&env).expect("malformed burn envelope");
                assert_eq!(nullifier(&spend.cx, &spend.cy), env_nu, "burned note ν != the envelope's nullifier");
                let burn = BurnWitness {
                    spend,
                    dest_commitment: env_dest,
                    b_low_key: r32(),
                    b_low_next: r32(),
                    b_low_value: r32(),
                    b_low_index: io::read(),
                    b_low_path: r_path(),
                    b_new_path: r_path(),
                };
                state.apply_bridge_out(&burn, height).expect("bridge-out fold");
            }
            _ => panic!("unknown reflection effect"),
        }
    }

    let pv = BitcoinReflectionPublicValues {
        priorDigest: prior_digest.into(),
        bitcoinPoolRoot: state.pool_root.into(),
        bitcoinSpentRoot: state.spent_root.into(),
        bitcoinBurnRoot: state.burn_root.into(),
        bitcoinHeight: state.height,
        newDigest: state.digest().into(),
    };
    io::commit_slice(&BitcoinReflectionPublicValues::abi_encode(&pv));
}
