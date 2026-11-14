//! TacProvenOracle's program: the venues' samples from the headers back from an anchor block, and the answers the
//! oracle stores, committed as the exact bytes `record` takes.
#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input: tac_oracle_core::Input = sp1_zkvm::io::read();
    let pv = tac_oracle_core::public_values(&input).expect("input does not prove the answers");
    sp1_zkvm::io::commit_slice(&pv);
}
