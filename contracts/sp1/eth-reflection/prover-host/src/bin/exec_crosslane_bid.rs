// One-settle OP_BID in CROSS-LANE mode (bitcoinSpentRoot != 0) from fixtures/crosslane_bid_op.json
// (tests/gen-cxfer-crosslane-bid-fixture.mjs): a confidential resting-bid fill where BOTH the buyer's
// funding note AND the seller's note are Bitcoin-homed (a batch proves membership against a SINGLE
// spendRoot, so a btcHomed BID has both legs on Bitcoin — two Bitcoin holders matching a limit order on
// Ethereum). It is exec_bid.rs + the per-leg cross-lane non-membership reads.
//
// READ-ORDER NOTE: BID's cross-lane checks are INTERLEAVED, not deferred — check_btc_nonmembership runs
// for the funding note right after its membership path and before its sigma (main.rs:874), and for the
// seller note right after its membership path and before its amount (main.rs:914). The BID guest path is
// unchanged (op-agnostic on bitcoin_spent_root != 0); only PROGRAM_VKEY rotates with the Stage-0 re-prove.
// MODE=execute (default) validates the read order + conservation; MODE=groth16 writes the cross-lane BID
// *ProofReal artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn note(s: &mut SP1Stdin, n: &serde_json::Value) { s.write(&hexv(n["cx"].as_str().unwrap())); s.write(&hexv(n["cy"].as_str().unwrap())); }
fn sig(s: &mut SP1Stdin, n: &serde_json::Value) { s.write(&hexv(n["sigR"].as_str().unwrap())); s.write(&hexv(n["sigZ"].as_str().unwrap())); }
// A cross-lane IMT non-membership witness, as read by check_btc_nonmembership (main.rs:118).
fn write_nm(s: &mut SP1Stdin, nm: &serde_json::Value) {
    s.write(&hexv(nm["lowValue"].as_str().unwrap()));
    s.write(&hexv(nm["lowNext"].as_str().unwrap()));
    s.write(&nm["lowIndex"].as_u64().unwrap());
    for p in nm["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
}

fn build_stdin(f: &serde_json::Value) -> SP1Stdin {
    let mut s = SP1Stdin::new();
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // != 0 → cross-lane non-membership per input
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
    write_nm(&mut s, &fund["nonMember"]); // CROSS-LANE: funding ν, after fund path, before fund sig (main.rs:874)
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
    write_nm(&mut s, &si["nonMember"]); // CROSS-LANE: seller ν, after seller path, before seller amount (main.rs:914)
    s.write(&si["amount"].as_u64().unwrap());
    sig(&mut s, si);
    let has_change = f["sellerHasChange"].as_u64().unwrap() as u8;
    s.write(&has_change);
    if has_change == 1 { note(&mut s, &f["sellerChange"]); sig(&mut s, &f["sellerChange"]); }
    note(&mut s, &f["sellerRecvB"]);
    sig(&mut s, &f["sellerRecvB"]);
    s.write(&f["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 940), after all seller notes
    s
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/crosslane_bid_op.json").unwrap()).unwrap();
    let stdin = build_stdin(&f);
    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("CROSSLANE_BID_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
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
    std::fs::write("/root/work/prover-host/out/crosslane_bid_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/crosslane_bid_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE crosslane_bid_pv.hex + crosslane_bid_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
