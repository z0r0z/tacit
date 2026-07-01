// OP_STEALTH_REFUND box harness (not part of the crate build). After the deadline, the LOCKER reclaims an
// unclaimed stealth lock (typo / dead-address safety). Kernel-gated like OP_ADAPTOR_REFUND: the kernel over
// (L_C − O_C) can only be produced by the locker (who alone knows L's blinding). Optional relay fee. Reads
// fixtures/stealthrefund_op.json. stdin order = the guest's OP_STEALTH_REFUND io::read (main.rs): header roots
// (lockSetRoot NON-zero: L membership), then asset(32) ‖ lCx(32) ‖ lCy(32) ‖ ownerPub(32) ‖ deadline(u64) ‖
// locker(32) ‖ lIndex(u64) ‖ lPath[32] ‖ oCx(32) ‖ oCy(32) ‖ fee(u64) ‖ kernelR(33) ‖ kernelZ(32) ‖
// oRange(var) ‖ lockerSigHi(32) ‖ lockerSigLo(32). Value-hidden: the L→O+fee kernel + a BP+ range on O
// conserve value + bound the fee without a cleartext amount; a BIP-340 sig under `locker` authorizes it.
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/stealthrefund_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spendRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&hexv(f["lockSetRoot"].as_str().unwrap())); // NON-zero: L lock-set membership
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&25u8);          // OP_STEALTH_REFUND
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["lCx"].as_str().unwrap()));
    stdin.write(&hexv(f["lCy"].as_str().unwrap()));
    stdin.write(&hexv(f["ownerPub"].as_str().unwrap()));
    stdin.write(&f["deadline"].as_u64().unwrap());
    stdin.write(&hexv(f["locker"].as_str().unwrap()));
    stdin.write(&f["lIndex"].as_u64().unwrap());
    for p in f["lPath"].as_array().expect("lPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["oCx"].as_str().unwrap()));
    stdin.write(&hexv(f["oCy"].as_str().unwrap()));
    stdin.write(&f["fee"].as_u64().unwrap());
    stdin.write(&hexv(f["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelZ"].as_str().unwrap()));
    stdin.write(&hexv(f["oRange"].as_str().unwrap())); // BP+ range on O (Vec<u8> via io::read)
    let sig = hexv(f["lockerSig"].as_str().unwrap()); // 64-byte BIP-340 sig under `locker` (Rx ‖ s)
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
