// Reflection GROTH16 prover: feeds a mirror fixture through write_stdin, proves the reflection ELF on the
// network, writes public_values.hex + proof_bytes.hex. Usage: reflect-prove <elf> <fixture.json>
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, Elf, HashableKey, ProvingKey};
use reflect_stdin::write_stdin;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 { eprintln!("usage: reflect-prove <elf> <fixture.json>"); std::process::exit(4); }
    let elf = std::fs::read(&args[1]).expect("read elf");
    let elf_static: &'static [u8] = Box::leak(elf.into_boxed_slice());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[2]).expect("read fixture")).expect("parse fixture");
    let stdin = write_stdin(&f);
    let __pv = ProverClient::builder().network().build().execute(Elf::Static(elf_static), stdin.clone()).run().expect("pv-exec").0;
    let client = ProverClient::builder().network().build();
    let pk = client.setup(Elf::Static(elf_static)).expect("setup");
    let vk = pk.verifying_key().bytes32();
    println!("REFLECTION_VKEY={vk}");
    println!("proving reflection groth16...");
    let proof = client.prove(&pk, stdin).groth16().cycle_limit(4_000_000_000).gas_limit(100_000_000_000).run().expect("groth16 proof failed");
    std::fs::write("public_values.hex", hex::encode(__pv.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("PROVED reflection groth16 pv_bytes={}", __pv.as_slice().len());
}
