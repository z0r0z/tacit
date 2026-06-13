// Settle re-prove: OP_LP_ADD groth16 (writes lp_pv.hex + lp_pb.hex for ConfidentialLpProofReal).
// Re-pointed at the settle ELF + fixtures/lp_op.json; threads the op deadline (read after the share
// sigma, guest main.rs:554). d_shares is DERIVED in-guest (V2 min rule) — not streamed.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/lp_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&7u8);           // OP_LP_ADD
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32));
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["sharesPre"].as_u64().unwrap());
    let a = &f["a"];
    stdin.write(&hexv(a["cx"].as_str().unwrap()));
    stdin.write(&hexv(a["cy"].as_str().unwrap()));
    stdin.write(&hexv(a["owner"].as_str().unwrap()));
    stdin.write(&a["leafIndex"].as_u64().unwrap());
    for p in a["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&a["d"].as_u64().unwrap());
    stdin.write(&hexv(a["sigR"].as_str().unwrap()));
    stdin.write(&hexv(a["sigZ"].as_str().unwrap()));
    let b = &f["b"];
    stdin.write(&hexv(b["cx"].as_str().unwrap()));
    stdin.write(&hexv(b["cy"].as_str().unwrap()));
    stdin.write(&hexv(b["owner"].as_str().unwrap()));
    stdin.write(&b["leafIndex"].as_u64().unwrap());
    for p in b["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&b["d"].as_u64().unwrap());
    stdin.write(&hexv(b["sigR"].as_str().unwrap()));
    stdin.write(&hexv(b["sigZ"].as_str().unwrap()));
    let s = &f["share"];
    stdin.write(&hexv(s["cx"].as_str().unwrap()));
    stdin.write(&hexv(s["cy"].as_str().unwrap()));
    stdin.write(&hexv(s["owner"].as_str().unwrap()));
    stdin.write(&hexv(s["sigR"].as_str().unwrap()));
    stdin.write(&hexv(s["sigZ"].as_str().unwrap()));
    stdin.write(&f["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 554), after the share sigma

    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/lp_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/lp_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE lp_pv.hex + lp_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
