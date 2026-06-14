// Settle re-prove: OP_SWAP groth16 (writes swap_pv.hex + swap_pb.hex for ConfidentialSwapProofReal).
// Re-pointed at the confidential settle ELF + fixtures/swap_op.json; threads the per-intent deadline
// (read after minOut, guest main.rs:440). PROOF_MODE is implicit groth16. cargo +stable build.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/swap_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&6u8);           // OP_SWAP
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32));
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["priceNum"].as_u64().unwrap());
    stdin.write(&f["priceDen"].as_u64().unwrap());
    let intents = f["intents"].as_array().unwrap();
    stdin.write(&(intents.len() as u32));
    for it in intents {
        stdin.write(&(it["direction"].as_u64().unwrap() as u8));
        stdin.write(&hexv(it["inCx"].as_str().unwrap()));
        stdin.write(&hexv(it["inCy"].as_str().unwrap()));
        stdin.write(&hexv(it["inOwner"].as_str().unwrap()));
        stdin.write(&it["inLeafIndex"].as_u64().unwrap());
        for p in it["inPath"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&it["amountIn"].as_u64().unwrap());
        stdin.write(&it["amountOut"].as_u64().unwrap());
        stdin.write(&it["rem"].as_u64().unwrap());
        stdin.write(&hexv(it["inSigR"].as_str().unwrap()));
        stdin.write(&hexv(it["inSigZ"].as_str().unwrap()));
        stdin.write(&it["minOut"].as_u64().unwrap());
        stdin.write(&it["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 440), after minOut
        stdin.write(&hexv(it["outCx"].as_str().unwrap()));
        stdin.write(&hexv(it["outCy"].as_str().unwrap()));
        stdin.write(&hexv(it["outOwner"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigR"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigZ"].as_str().unwrap()));
    }

    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/swap_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/swap_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE swap_pv.hex + swap_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
