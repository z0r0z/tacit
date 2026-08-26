// Derive the SP1 program vkey (bytes32) from a guest ELF, for the elf-vkey-pin.json rotation.
//   cargo run --release --bin vkey -- <path-to-elf>
use sp1_sdk::{blocking::{ProverClient, Prover}, Elf, HashableKey, ProvingKey};

fn main() {
    let path = std::env::args().nth(1).expect("usage: vkey <elf-path>");
    let bytes = std::fs::read(&path).expect("read elf");
    let n = bytes.len();
    let elf: &'static [u8] = Box::leak(bytes.into_boxed_slice());
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(elf)).expect("setup failed");
    println!("VKEY {} bytes={} {}", path, n, pk.verifying_key().bytes32());
}
