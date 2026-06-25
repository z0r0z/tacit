// OP_CDP_TOPUP box harness (not part of the crate build). Adds collateral to a CDP without changing its debt.
// FEE-LESS: a top-up adds value (no spendable output) — the relay is recouped on a later spend. Reads
// fixtures/cdptopup_op.json. stdin order = the guest's OP_CDP_TOPUP io::read (main.rs): header roots (spendRoot
// NON-zero: added-collateral membership; cdpPositionRoot NON-zero: old-position membership), then
// controller(20) ‖ owner(32) ‖ debtValue(u64) ‖ oldNonce(32) ‖ newNonce(32) ‖ rateSnapshot(32) ‖
// positionIndex(u64) ‖ positionPath[] ‖ nOldLegs(u32) ‖ {asset(32) ‖ value(u64)} × nOldLegs ‖ nAddedLegs(u32)
// ‖ {asset(32) ‖ cx(32) ‖ cy(32) ‖ value(u64) ‖ index(u64) ‖ path[] ‖ sigR(33) ‖ sigZ(32)} × nAddedLegs.
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn u64f(v: &serde_json::Value) -> Option<u64> { v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())) } // accept u64 amount as number OR decimal string (avoids float64 >2^53 loss)
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/cdptopup_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: added-collateral membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&hexv(f["cdpPositionRoot"].as_str().unwrap())); // NON-zero: old-position membership
    stdin.write(&1u32);          // numOps
    stdin.write(&19u8);          // OP_CDP_TOPUP
    stdin.write(&hexv(f["controller"].as_str().unwrap()));
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&u64f(&f["debtValue"]).unwrap());
    stdin.write(&hexv(f["oldNonce"].as_str().unwrap()));
    stdin.write(&hexv(f["newNonce"].as_str().unwrap()));
    stdin.write(&hexv(f["rateSnapshot"].as_str().unwrap()));
    stdin.write(&f["positionIndex"].as_u64().unwrap());
    for p in f["positionPath"].as_array().expect("positionPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    let old_legs = f["oldLegs"].as_array().expect("oldLegs");
    stdin.write(&(old_legs.len() as u32));
    for leg in old_legs { // the OLD basket: asset + value only (re-derives the old position leaf)
        stdin.write(&hexv(leg["asset"].as_str().unwrap()));
        stdin.write(&u64f(&leg["value"]).unwrap());
    }
    let added = f["addedLegs"].as_array().expect("addedLegs");
    stdin.write(&(added.len() as u32));
    for leg in added { // the ADDED collateral notes (spent + opening-bound)
        stdin.write(&hexv(leg["asset"].as_str().unwrap()));
        stdin.write(&hexv(leg["cx"].as_str().unwrap()));
        stdin.write(&hexv(leg["cy"].as_str().unwrap()));
        stdin.write(&u64f(&leg["value"]).unwrap());
        stdin.write(&leg["index"].as_u64().unwrap());
        for p in leg["path"].as_array().expect("added path") { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(leg["sigR"].as_str().unwrap()));
        stdin.write(&hexv(leg["sigZ"].as_str().unwrap()));
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} debtValue={} added={}",
            report.total_instruction_count(), pv.as_slice().len(), f["debtValue"], added.len());
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") { assert_eq!(pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(), expect.trim().trim_start_matches("0x").to_lowercase(), "EXPECT_VKEY mismatch"); }
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
