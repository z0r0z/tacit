// One-settle OP_OTC in CROSS-LANE mode (bitcoinSpentRoot != 0) from fixtures/crosslane_otc_op.json
// (tests/gen-cxfer-crosslane-otc-fixture.mjs): a confidential maker/taker order match where BOTH legs
// are Bitcoin-homed (both notes are members of the same reflected Bitcoin pool root — a batch proves
// membership against a SINGLE spendRoot, so a btcHomed OTC necessarily has both legs on Bitcoin; a
// mixed-lane fill is the two-settle on-ramp, not one batch). It is exec_otc.rs + the per-leg cross-lane
// non-membership read.
//
// The OTC guest path is UNCHANGED: check_btc_nonmembership runs per input right after that input's
// membership + nullifier and BEFORE its amount (main.rs:750 maker / :774 taker, op-agnostic on
// bitcoin_spent_root != 0), so the nonMember witness is written in write_leg right after inPath. Only
// PROGRAM_VKEY rotates with the Stage-0 re-prove. MODE=execute (default) validates the witness read
// order + conservation against the guest; MODE=groth16 writes the cross-lane OTC *ProofReal artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

// Write one party's leg in the guest's io::read order, with the cross-lane non-membership inserted
// after the input's membership path and before its amount (main.rs:750/774).
fn write_leg(stdin: &mut SP1Stdin, leg: &serde_json::Value) {
    stdin.write(&hexv(leg["inCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["inCy"].as_str().unwrap()));
    stdin.write(&leg["inLeafIndex"].as_u64().unwrap());
    for p in leg["inPath"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    // CROSS-LANE: this leg's btcHomed input non-membership in the reflected Bitcoin spent set.
    let nm = &leg["nonMember"];
    stdin.write(&hexv(nm["lowValue"].as_str().unwrap()));
    stdin.write(&hexv(nm["lowNext"].as_str().unwrap()));
    stdin.write(&nm["lowIndex"].as_u64().unwrap());
    for p in nm["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
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
        &std::fs::read_to_string("/root/work/confidential/fixtures/crosslane_otc_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // != 0 → cross-lane non-membership per input
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund; guest header reads it unconditionally — main.rs:139)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
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
    stdin.write(&f["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 799), after both legs

    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("CROSSLANE_OTC_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
        return;
    }
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    prover_host::assert_vkey(&pk.verifying_key().bytes32(), "program_vkey"); // fail-closed: abort on vkey drift BEFORE the GPU spend
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/crosslane_otc_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/crosslane_otc_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE crosslane_otc_pv.hex + crosslane_otc_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
