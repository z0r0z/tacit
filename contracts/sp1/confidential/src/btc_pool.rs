#![cfg_attr(not(test), no_main)]
//! Bitcoin-native shielded pool guest: proves one `T_BTC_SPEND` (DESIGN-btc-shielded-pool.md §4) and commits
//! `abi.encode(uint16 1, bytes32 root, bytes32 keccak(body))`. The relation is
//! `btc_pool_core::verify_btc_pool_spend`.
//!
//! Witness order (each byte string is a bincode Vec<u8>):
//!   body, root[32], n_in u32,
//!   per input:  cx[32], cy[32], value u64, blinding[32], spend_key[32], nk_pub[33], nk_note[32],
//!               leaf_index u64, path 32×[32], sig[64]
//!   n_open u32,
//!   per opening: value u64, blinding[32]     (one per pool output in body order, then the exit's when
//!                                             has_exit = 1: n_open = n_out + has_exit)

#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::{sol, SolValue};
use btc_pool_core::{
    verify_btc_pool_spend, BtcPoolOpening, BtcPoolSpendInput, BtcPoolSpendWitness, BTC_POOL_MAX_IN, BTC_POOL_MAX_OUT,
    BTC_POOL_PV_VERSION,
};
use cxfer_core::KECCAK_TREE_DEPTH;
use sp1_zkvm::io;

sol! {
    struct BtcPoolSpendValues {
        uint16 version;
        bytes32 root;
        bytes32 bodyHash;
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}

pub fn main() {
    let body: Vec<u8> = io::read();
    let root = r_n::<32>();
    let n_in: u32 = io::read();
    assert!(n_in >= 1 && n_in as usize <= BTC_POOL_MAX_IN, "btc-pool: input count out of range");
    let inputs: Vec<BtcPoolSpendInput> = (0..n_in)
        .map(|_| BtcPoolSpendInput {
            cx: r_n(),
            cy: r_n(),
            value: io::read(),
            blinding: r_n(),
            spend_key: r_n(),
            nk_pub: r_n(),
            nk_note: r_n(),
            leaf_index: io::read(),
            path: (0..KECCAK_TREE_DEPTH).map(|_| r_n::<32>()).collect(),
            sig: r_n(),
        })
        .collect();
    let n_open: u32 = io::read();
    assert!(n_open >= 1 && n_open as usize <= BTC_POOL_MAX_OUT + 1, "btc-pool: output count out of range");
    let outputs: Vec<BtcPoolOpening> =
        (0..n_open).map(|_| BtcPoolOpening { value: io::read(), blinding: r_n() }).collect();

    let st = verify_btc_pool_spend(&BtcPoolSpendWitness { body, root, inputs, outputs })
        .unwrap_or_else(|e| panic!("{}", e));

    let pv = BtcPoolSpendValues { version: BTC_POOL_PV_VERSION, root: st.root.into(), bodyHash: st.body_hash.into() };
    io::commit_slice(&pv.abi_encode());
}
