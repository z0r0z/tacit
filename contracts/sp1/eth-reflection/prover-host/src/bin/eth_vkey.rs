// Vk-coherence gate: does sp1-sdk 6.2.3 derive the same eth-reflection vkey the box cargo-prove pinned
// (0x00726774…)? If yes, the 6.1-built eth ELF is provable under 6.2.3 and the in-guest verify_sp1_proof
// pin holds — recursion is version-viable without upgrading sp1-helios to SP1 6.2.
//
// CONFIRMED 2026-06-13: prints 0x0072677443772bb89cdc3a5022f5f2b3cfb6e9b1d8497a8084f472c563cfc303,
// == ETH_REFLECTION_VKEY pinned in confidential/src/reflect.rs.
use sp1_sdk::{blocking::{ProverClient, Prover}, Elf, HashableKey, ProvingKey};
const ETH_ELF: &[u8] = include_bytes!("/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection");
fn main() {
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ETH_ELF)).expect("setup");
    println!("ETH_REFLECTION_VKEY (sp1-sdk 6.2.3) = {}", pk.verifying_key().bytes32());
}
