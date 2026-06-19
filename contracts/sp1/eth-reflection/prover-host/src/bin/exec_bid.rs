// Settle re-prove: OP_BID groth16 (writes bid_pv.hex + bid_pb.hex for ConfidentialBidProofReal).
// Re-pointed at the settle ELF + fixtures/bid_op.json; threads the bid deadline (buyer's expiry, read
// AFTER all seller notes — the last BID read, guest main.rs:917). buildBid binds it in the presig.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn note(s: &mut SP1Stdin, n: &serde_json::Value) { s.write(&hexv(n["cx"].as_str().unwrap())); s.write(&hexv(n["cy"].as_str().unwrap())); }
fn sig(s: &mut SP1Stdin, n: &serde_json::Value) { s.write(&hexv(n["sigR"].as_str().unwrap())); s.write(&hexv(n["sigZ"].as_str().unwrap())); }

fn build_stdin(f: &serde_json::Value) -> SP1Stdin {
    let mut s = SP1Stdin::new();
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund; guest header reads it unconditionally — main.rs:139)
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    s.write(&1u32);          // numOps
    s.write(&10u8);          // OP_BID
    s.write(&hexv(f["assetA"].as_str().unwrap()));
    s.write(&hexv(f["assetB"].as_str().unwrap()));
    s.write(&f["minFill"].as_u64().unwrap());
    s.write(&f["maxFill"].as_u64().unwrap());
    s.write(&f["price"].as_u64().unwrap());
    s.write(&f["increment"].as_u64().unwrap());
    s.write(&hexv(f["buyerOwner"].as_str().unwrap()));
    let fund = &f["fund"];
    note(&mut s, fund);
    s.write(&fund["leafIndex"].as_u64().unwrap());
    for p in fund["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    sig(&mut s, fund);
    let chosen_f = f["chosenF"].as_u64().unwrap();
    s.write(&chosen_f);
    note(&mut s, &f["buyerRecvA"]);
    sig(&mut s, &f["buyerRecvA"]);
    if chosen_f < f["maxFill"].as_u64().unwrap() {
        let r = &f["refund"];
        note(&mut s, r);
        sig(&mut s, r);
    }
    let si = &f["sellerIn"];
    note(&mut s, si);
    s.write(&hexv(f["sellerOwner"].as_str().unwrap()));
    s.write(&si["leafIndex"].as_u64().unwrap());
    for p in si["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    s.write(&si["amount"].as_u64().unwrap());
    sig(&mut s, si);
    let has_change = f["sellerHasChange"].as_u64().unwrap() as u8;
    s.write(&has_change);
    if has_change == 1 { note(&mut s, &f["sellerChange"]); sig(&mut s, &f["sellerChange"]); }
    note(&mut s, &f["sellerRecvB"]);
    sig(&mut s, &f["sellerRecvB"]);
    s.write(&f["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 917), after all seller notes
    s
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/bid_op.json").unwrap()).unwrap();
    let stdin = build_stdin(&f);
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/bid_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/bid_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE bid_pv.hex + bid_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
