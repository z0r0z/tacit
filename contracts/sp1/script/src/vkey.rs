use sp1_sdk::blocking::prelude::*;
use sp1_sdk::blocking::ProverClient;

const ELF: &[u8] = include_bytes!("../../program/elf/teth-pool-prover");

fn main() {
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key();
    let vk_hash = vk.hash_bytes();
    println!("VKey hash (bytes32): 0x{}", hex::encode(vk_hash));
}
