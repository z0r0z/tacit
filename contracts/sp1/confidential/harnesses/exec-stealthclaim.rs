// OP_STEALTH_CLAIM box harness (not part of the crate build). The recipient claims a stealth lock: prove L ∈
// the lock-set, spend ν_L, mint M to a chosen owner, authorized by a BIP-340 sig under the lock's one-time
// pubkey. Carries an optional relay fee (gasless): M opens to amount − fee, the fee leg pays the settler.
// Reads fixtures/stealthclaim_op.json. stdin order = the guest's OP_STEALTH_CLAIM io::read (main.rs): header
// roots (lockSetRoot NON-zero: L membership; spendRoot 0), then asset(32) ‖ lCx(32) ‖ lCy(32) ‖ ownerPub(32) ‖
// amount(u64) ‖ deadline(u64) ‖ locker(32) ‖ lIndex(u64) ‖ lPath[32] ‖ mCx(32) ‖ mCy(32) ‖ mOwner(32) ‖
// fee(u64) ‖ mSigR(33) ‖ mSigZ(32) ‖ ownerSigHi(32) ‖ ownerSigLo(32)  [ownerSig = the 64-byte BIP-340 sig].
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/stealthclaim_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spendRoot = 0 (claim reads the lock-set, not the note tree)
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&hexv(f["lockSetRoot"].as_str().unwrap())); // NON-zero: L lock-set membership
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&24u8);          // OP_STEALTH_CLAIM
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["lCx"].as_str().unwrap()));
    stdin.write(&hexv(f["lCy"].as_str().unwrap()));
    stdin.write(&hexv(f["ownerPub"].as_str().unwrap()));
    stdin.write(&f["amount"].as_u64().unwrap());
    stdin.write(&f["deadline"].as_u64().unwrap());
    stdin.write(&hexv(f["locker"].as_str().unwrap()));
    stdin.write(&f["lIndex"].as_u64().unwrap());
    for p in f["lPath"].as_array().expect("lPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["mCx"].as_str().unwrap()));
    stdin.write(&hexv(f["mCy"].as_str().unwrap()));
    stdin.write(&hexv(f["mOwner"].as_str().unwrap()));
    stdin.write(&f["fee"].as_u64().unwrap());
    stdin.write(&hexv(f["mSigR"].as_str().unwrap()));
    stdin.write(&hexv(f["mSigZ"].as_str().unwrap()));
    let sig = hexv(f["ownerSig"].as_str().unwrap()); // 64-byte BIP-340 sig (Rx ‖ s)
    stdin.write(&sig[0..32].to_vec());
    stdin.write(&sig[32..64].to_vec());

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} fee={}", report.total_instruction_count(), pv.as_slice().len(), f["fee"]);
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
