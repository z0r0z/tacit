// One-settle atomic fast-lane SWAP acceptance harness: execute (or groth16-prove) an OP_SWAP in
// CROSS-LANE mode (bitcoinSpentRoot != 0) from fixtures/crosslane_swap_op.json
// (tests/gen-cxfer-crosslane-swap-fixture.mjs). It is exec_swap.rs + the per-intent cross-lane
// non-membership read, mirroring exec_crosslane.rs: a Bitcoin-homed input funds the swap, and per
// input the guest checks its ν is absent from the reflected Bitcoin spent set before clearing.
//
// This is the box step for the swap-cut re-prove. The swap guest path is UNCHANGED: it already reads
// the per-intent nonMember in the swap loop right after the input's membership + nullifier and before
// amount_in (main.rs:455, op-agnostic on bitcoin_spent_root != 0), so no settle-guest change is needed —
// only PROGRAM_VKEY rotates with the Stage-0 re-prove. MODE=execute validates the witness read order +
// conservation against the guest; MODE=groth16 writes the on-chain artifacts for the cross-lane swap
// *ProofReal.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/crosslane_swap_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // != 0 → cross-lane non-membership per input
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund; guest header reads it unconditionally — main.rs:139)
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
        // CROSS-LANE: the btcHomed input's non-membership in the reflected Bitcoin spent set. The
        // guest's check_btc_nonmembership runs in the swap loop right after the input's membership +
        // nullifier and BEFORE amount_in (main.rs:455 — op-agnostic, same position as the transfer's
        // exec_crosslane.rs read), so the witness is written here, not after the sig.
        let nm = &it["nonMember"];
        stdin.write(&hexv(nm["lowValue"].as_str().unwrap()));
        stdin.write(&hexv(nm["lowNext"].as_str().unwrap()));
        stdin.write(&nm["lowIndex"].as_u64().unwrap());
        for p in nm["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&it["amountIn"].as_u64().unwrap());
        stdin.write(&it["amountOut"].as_u64().unwrap());
        stdin.write(&it["rem"].as_u64().unwrap());
        stdin.write(&hexv(it["inSigR"].as_str().unwrap()));
        stdin.write(&hexv(it["inSigZ"].as_str().unwrap()));
        stdin.write(&it["minOut"].as_u64().unwrap());
        stdin.write(&it["deadline"].as_u64().unwrap_or(0));
        stdin.write(&hexv(it["outCx"].as_str().unwrap()));
        stdin.write(&hexv(it["outCy"].as_str().unwrap()));
        stdin.write(&hexv(it["outOwner"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigR"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigZ"].as_str().unwrap()));
    }

    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("CROSSLANE_SWAP_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
        return;
    }
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/crosslane_swap_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/crosslane_swap_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE crosslane_swap_pv.hex + crosslane_swap_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
