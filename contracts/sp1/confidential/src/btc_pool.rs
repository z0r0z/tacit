#![cfg_attr(not(test), no_main)]
//! Bitcoin-native shielded pool guest: proves one `T_BTC_SPEND` (0x6D) against a retained tree root and
//! commits the ABI-encoded `BtcPoolSpendValues` the indexer checks against the envelope (design §10 step 5).
//! The relation is `cxfer_core::btc_pool::verify_btc_pool_spend` (native-tested); this guest only reads the
//! witness and commits the statement. See DESIGN-btc-shielded-pool.md §3–§4.
//!
//! Witness layout (host writes in this order):
//!   header:  asset[32], root[32], h_anchor u32, out_kind u8, n_in u32
//!   per in:  Cx[32], Cy[32], spend_key[32], value u64, blinding[32], leaf_index u64, path 32×[32], sk_note[32]
//!   if out_kind = pay:  n_out u32, per out: Cx[32], Cy[32], pk_eph[32], spend_key[32], ct_note[56], value u64, blinding[32]
//!   if out_kind = exit: exit_vout u32, exit_value u64, dest_spk_hash[32]
//!
//! `sk_note` (design §2/§4) is the note's private one-time spend secret, witnessed directly and
//! constrained in-circuit as `spend_key = sk_note·G`, rather than authorized by a detached BIP-340
//! signature. It also feeds `nf_secret`, which the nullifier formula requires.

#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::{sol, SolValue};
use cxfer_core::btc_pool::{
    verify_btc_pool_spend, BtcPoolSpendInput, BtcPoolSpendOutput, BtcPoolSpendWitness, BTC_POOL_MAX_IN,
    BTC_POOL_MAX_OUT, BTC_POOL_OUT_EXIT, BTC_POOL_OUT_PAY,
};
use cxfer_core::KECCAK_TREE_DEPTH;
use sp1_zkvm::io;

const PV_VERSION: u16 = 1;

sol! {
    // One created note's public fields, exactly the envelope's per-output (Cx, Cy, pk_eph, spend_key, ct_note).
    struct BtcPoolNote { bytes32 cx; bytes32 cy; bytes32 pkEph; bytes32 spendKey; bytes ctNote; }
    struct BtcPoolSpendValues {
        uint16 version;
        bytes32 asset;
        bytes32 root;        // must equal the indexer's retained root at hAnchor
        uint32 hAnchor;
        uint8 outKind;
        bytes32[] nullifiers; // the envelope's nf[], in order
        BtcPoolNote[] outputs; // the envelope's outputs, in order (empty for an exit)
        bool hasExitVout;
        uint32 exitVout;
        uint64 exitValue;
        bytes32 destSpkHash;
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] {
    r_n::<32>()
}
fn r56() -> [u8; 56] {
    r_n::<56>()
}
fn r_path() -> Vec<[u8; 32]> {
    (0..KECCAK_TREE_DEPTH).map(|_| r32()).collect()
}

pub fn main() {
    let asset = r32();
    let root = r32();
    let h_anchor: u32 = io::read();
    let out_kind: u8 = io::read();
    let n_in: u32 = io::read();
    assert!(n_in >= 1 && n_in as usize <= BTC_POOL_MAX_IN, "btc-pool: input count out of range");

    let inputs: Vec<BtcPoolSpendInput> = (0..n_in)
        .map(|_| BtcPoolSpendInput {
            cx: r32(),
            cy: r32(),
            spend_key: r32(),
            value: io::read(),
            blinding: r32(),
            leaf_index: io::read(),
            path: r_path(),
            sk_note: r32(),
        })
        .collect();

    let (outputs, exit_vout, exit_value, dest_spk_hash) = if out_kind == BTC_POOL_OUT_PAY {
        let n_out: u32 = io::read();
        assert!(n_out >= 1 && n_out as usize <= BTC_POOL_MAX_OUT, "btc-pool: output count out of range");
        let outputs: Vec<BtcPoolSpendOutput> = (0..n_out)
            .map(|_| BtcPoolSpendOutput {
                cx: r32(),
                cy: r32(),
                pk_eph: r32(),
                spend_key: r32(),
                ct_note: r56(),
                value: io::read(),
                blinding: r32(),
            })
            .collect();
        (outputs, None, 0u64, None)
    } else {
        assert!(out_kind == BTC_POOL_OUT_EXIT, "btc-pool: bad out_kind");
        let exit_vout: u32 = io::read();
        let exit_value: u64 = io::read();
        let dest_spk_hash: [u8; 32] = r32();
        (Vec::new(), Some(exit_vout), exit_value, Some(dest_spk_hash))
    };

    let w = BtcPoolSpendWitness {
        asset,
        root,
        h_anchor,
        out_kind,
        inputs,
        outputs,
        exit_vout,
        exit_value,
        dest_spk_hash,
    };
    let st = verify_btc_pool_spend(&w).unwrap_or_else(|e| panic!("{}", e));

    let pv = BtcPoolSpendValues {
        version: PV_VERSION,
        asset: st.asset.into(),
        root: st.root.into(),
        hAnchor: st.h_anchor,
        outKind: st.out_kind,
        nullifiers: st.nullifiers.into_iter().map(Into::into).collect(),
        outputs: st
            .outputs
            .into_iter()
            .map(|(cx, cy, pk_eph, k, ct)| BtcPoolNote {
                cx: cx.into(),
                cy: cy.into(),
                pkEph: pk_eph.into(),
                spendKey: k.into(),
                ctNote: ct.to_vec().into(),
            })
            .collect(),
        hasExitVout: st.exit_vout.is_some(),
        exitVout: st.exit_vout.unwrap_or(0),
        exitValue: st.exit_value,
        destSpkHash: st.dest_spk_hash.unwrap_or([0u8; 32]).into(),
    };
    io::commit_slice(&pv.abi_encode());
}
