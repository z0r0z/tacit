// Derive a guest ELF's verifying key LOCALLY (CPU setup, no GPU): the on-chain bytes32 form
// (PROGRAM_VKEY / BITCOIN_RELAY_VKEY) AND the recursion [u32;8] (vk.hash_u32() — the ETH_REFLECTION_VKEY
// constant that verify_sp1_proof checks). Mirrors prover-host/eth_vkey, but reflect-exec has no
// box-absolute deps so it runs on the laptop against the docker-built canonical ELFs.
//   cargo run --release --bin vkey-derive -- <path/to/elf>
use sp1_sdk::{blocking::{ProverClient, Prover}, Elf, HashableKey, ProvingKey};

fn main() {
    let elf_path = std::env::args().nth(1).expect("usage: vkey-derive <elf path>");
    let elf: &'static [u8] = Box::leak(std::fs::read(&elf_path).expect("read elf").into_boxed_slice());
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(elf)).expect("setup");
    let vk = pk.verifying_key();
    println!("elf       = {} ({} bytes)", elf_path, elf.len());
    println!("bytes32   = {}", vk.bytes32());
    println!("hash_u32  = {:?}", vk.hash_u32());
}
