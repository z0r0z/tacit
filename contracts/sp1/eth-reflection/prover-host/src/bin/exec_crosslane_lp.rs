// One-settle OP_LP_ADD in CROSS-LANE mode (bitcoinSpentRoot != 0) from fixtures/crosslane_lp_op.json
// (tests/gen-cxfer-crosslane-lp-fixture.mjs): a Bitcoin holder adds liquidity in one settle, both
// contribution notes (A + B) Bitcoin-homed (a batch proves membership against a SINGLE spendRoot, so a
// btcHomed LP-add funds both reserves from Bitcoin notes). It is exec_lp.rs + the per-leg cross-lane
// non-membership reads.
//
// READ-ORDER NOTE: OP_LP_ADD reads ALL witness fields up front and DEFERS its membership + cross-lane
// checks until after it derives d_shares — so check_btc_nonmembership runs at the END, after op_deadline,
// in A-then-B order (main.rs:621 A / :626 B). The two nonMember witnesses are therefore appended after the
// deadline write, A first. The LP guest path is unchanged (op-agnostic on bitcoin_spent_root != 0); only
// PROGRAM_VKEY rotates with the Stage-0 re-prove. MODE=execute (default) validates the read order +
// conservation; MODE=groth16 writes the cross-lane LP *ProofReal artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

// A cross-lane IMT non-membership witness (low leaf value/next/index/path), as read by
// check_btc_nonmembership (main.rs:118).
fn write_nm(stdin: &mut SP1Stdin, nm: &serde_json::Value) {
    stdin.write(&hexv(nm["lowValue"].as_str().unwrap()));
    stdin.write(&hexv(nm["lowNext"].as_str().unwrap()));
    stdin.write(&nm["lowIndex"].as_u64().unwrap());
    for p in nm["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/crosslane_lp_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // != 0 → cross-lane non-membership per input
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund; guest header reads it unconditionally — main.rs:139)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
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
    stdin.write(&f["deadline"].as_u64().unwrap_or(0)); // per-op Expired (guest 577), after the share sigma
    // CROSS-LANE: both contribution notes' non-membership, read at the END (after op_deadline), A then B
    // (main.rs:621 / :626 — LP defers its membership/cross-lane checks until after d_shares is derived).
    write_nm(&mut stdin, &a["nonMember"]);
    write_nm(&mut stdin, &b["nonMember"]);

    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("CROSSLANE_LP_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
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
    std::fs::write("/root/work/prover-host/out/crosslane_lp_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/crosslane_lp_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE crosslane_lp_pv.hex + crosslane_lp_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
