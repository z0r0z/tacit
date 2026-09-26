//! `verifyAggregate(wrap, proof, statement, vkey)`: an SP1 proof of the btc-pool-agg guest whose public values
//! are exactly `statement`, under `vkey` (the pinned guest key, "0x…" 32 bytes), wrapped in PLONK (wrap 1) or
//! Groth16 (wrap 2) against sp1-verifier 6.2.4's keys. Any decode failure is `false`.

use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = verifyAggregate)]
pub fn verify_aggregate(wrap: u8, proof: &[u8], statement: &[u8], vkey: &str) -> bool {
    match wrap {
        1 => sp1_verifier::PlonkVerifier::verify(proof, statement, vkey, &sp1_verifier::PLONK_VK_BYTES).is_ok(),
        2 => sp1_verifier::Groth16Verifier::verify(proof, statement, vkey, &sp1_verifier::GROTH16_VK_BYTES).is_ok(),
        _ => false,
    }
}
