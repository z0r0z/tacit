// CPU-forced Groth16 prover for the confidential guest (box use; not part of the
// crate build). Reads the transfer_op.json witness, proves the full op in the
// zkVM, verifies locally, and writes on-chain submission artifacts
// (public_values.hex + proof_bytes.hex) for a Forge verify against the real SP1
// Groth16 verifier. ProverClient::builder().cpu() forces CPU — never the GPU the
// live mainnet bridge prover uses.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/transfer_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (gold mode, no cross-lane check)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0 (no bridge_mint in this batch)
    stdin.write(&1u32);
    stdin.write(&1u8); // OP_TRANSFER
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    let ins = f["inputs"].as_array().unwrap();
    let outs = f["outputs"].as_array().unwrap();
    stdin.write(&(ins.len() as u32));
    stdin.write(&(outs.len() as u32));
    for inp in ins {
        stdin.write(&hexv(inp["cx"].as_str().unwrap()));
        stdin.write(&hexv(inp["cy"].as_str().unwrap()));
        stdin.write(&hexv(inp["owner"].as_str().unwrap()));
        stdin.write(&inp["leafIndex"].as_u64().unwrap());
        for p in inp["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(inp["secret"].as_str().unwrap()));
    }
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    let client = ProverClient::builder().cpu().build(); // CPU only — never the GPU
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    println!("proving {mode} (cpu)...");
    let proof = if mode == "groth16" {
        client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed")
    } else {
        client.prove(&pk, stdin).compressed().run().expect("compressed proof failed")
    };
    println!("PROVED pv_bytes={}", proof.public_values.as_slice().len());
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK ({mode})");
    std::fs::write("/root/work/cxfer/exec/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    if mode == "groth16" {
        std::fs::write("/root/work/cxfer/exec/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
        println!("WROTE public_values.hex + proof_bytes.hex");
    } else {
        println!("WROTE public_values.hex (compressed proof verified locally)");
    }
}
