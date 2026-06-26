// OP_STEALTH_LOCK box harness (not part of the crate build). Locks a note N into the SHARED lock-set under the
// recipient's one-time stealth pubkey (N and L open to the SAME amount — conservation, no change). FEE-LESS: a
// lock has no spendable output; the relay is recouped when the proceeds are later spent (the claim carries the
// fee). Reads fixtures/stealthlock_op.json. stdin order = the guest's OP_STEALTH_LOCK io::read (main.rs): header
// roots (spendRoot NON-zero: N membership; lockSetRoot 0 — lock APPENDS), then asset(32) ‖ locker(32) ‖
// ownerPub(32) ‖ amount(u64) ‖ deadline(u64) ‖ nCx(32) ‖ nCy(32) ‖ nIndex(u64) ‖ nPath[32] ‖ nSigR(33) ‖
// nSigZ(32) ‖ lCx(32) ‖ lCy(32) ‖ lSigR(33) ‖ lSigZ(32).
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/stealthlock_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: N membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (lock appends to it; no membership read)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&23u8);          // OP_STEALTH_LOCK
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["locker"].as_str().unwrap()));
    stdin.write(&hexv(f["ownerPub"].as_str().unwrap())); // recipient one-time stealth x-only pubkey
    stdin.write(&f["amount"].as_u64().unwrap());
    stdin.write(&f["deadline"].as_u64().unwrap());
    stdin.write(&hexv(f["nCx"].as_str().unwrap()));
    stdin.write(&hexv(f["nCy"].as_str().unwrap()));
    stdin.write(&f["nIndex"].as_u64().unwrap());
    for p in f["nPath"].as_array().expect("nPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["nSigR"].as_str().unwrap()));
    stdin.write(&hexv(f["nSigZ"].as_str().unwrap()));
    stdin.write(&hexv(f["lCx"].as_str().unwrap()));
    stdin.write(&hexv(f["lCy"].as_str().unwrap()));
    stdin.write(&hexv(f["lSigR"].as_str().unwrap()));
    stdin.write(&hexv(f["lSigZ"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} amount={}", report.total_instruction_count(), pv.as_slice().len(), f["amount"]);
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
