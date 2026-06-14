// Settle re-prove: OP_OTC groth16 (writes otc_pv.hex + otc_pb.hex for ConfidentialOtcProofReal).
// Re-pointed at the settle ELF + fixtures/otc_op.json; threads the op deadline (read after BOTH legs,
// guest main.rs:776). OTC is a direct maker/taker swap — no pool, no feeBps.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn write_leg(stdin: &mut SP1Stdin, leg: &serde_json::Value) {
    stdin.write(&hexv(leg["inCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["inCy"].as_str().unwrap()));
    stdin.write(&leg["inLeafIndex"].as_u64().unwrap());
    for p in leg["inPath"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&leg["inAmount"].as_u64().unwrap());
    stdin.write(&hexv(leg["inSigR"].as_str().unwrap()));
    stdin.write(&hexv(leg["inSigZ"].as_str().unwrap()));
    let has_change = leg["hasChange"].as_u64().unwrap() as u8;
    stdin.write(&has_change);
    if has_change == 1 {
        stdin.write(&hexv(leg["changeCx"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeCy"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeSigR"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeSigZ"].as_str().unwrap()));
    }
    stdin.write(&hexv(leg["recvCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvCy"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvSigR"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvSigZ"].as_str().unwrap()));
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/otc_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&9u8);           // OP_OTC
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&f["vA"].as_u64().unwrap());
    stdin.write(&f["vB"].as_u64().unwrap());
    stdin.write(&hexv(f["makerOwner"].as_str().unwrap()));
    stdin.write(&hexv(f["takerOwner"].as_str().unwrap()));
    write_leg(&mut stdin, &f["maker"]);
    write_leg(&mut stdin, &f["taker"]);
    stdin.write(&f["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 776), after both legs

    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/otc_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/otc_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE otc_pv.hex + otc_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
