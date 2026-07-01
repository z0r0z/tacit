// OP_BRIDGE_STEALTH_MINT box harness (not part of the crate build). Cross-chain confidential PAY-TO-STEALTH:
// a note burned for the bridge on Bitcoin is minted into the SHARED stealth lock-set under the recipient's
// one-time pubkey — the recipient claims with OP_STEALTH_CLAIM, the locker refunds with OP_STEALTH_REFUND.
// Like exec-bridgemint, but the destination is a stealth lock (dest_leaf = stealth_lock_leaf_blind) appended to the
// lock-set instead of a note. Reads fixtures/bridgestealthmint_op.json. stdin order = the guest's
// OP_BRIDGE_STEALTH_MINT io::read (main.rs): header roots (bitcoinBurnRoot NON-zero — the dest is a member of
// the bridge-burn set; spendRoot/spentRoot/lockSetRoot/cdpRoot 0), then asset(32) ‖ poolRoot(32) ‖ inCx(32) ‖
// inCy(32) ‖ inOwner(32) ‖ inIndex(u64) ‖ inPath[32] ‖ ownerPub(32) ‖ deadline(u64) ‖ locker(32)
// ‖ lCx(32) ‖ lCy(32) ‖ bmNext(32) ‖ bmIndex(u64) ‖ bmPath[32] ‖ fee(u64) ‖ kernelR(33) ‖ kernelZ(32) ‖
// lRange(var). Value-hidden: L carries no cleartext amount — the kernel pins v_in == v_L + fee and the BP+
// range on L (v_L < 2^64) bounds the fee, replacing the dropped opening sigma.
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/bridgestealthmint_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spendRoot = 0 (the burned note is in poolRoot, not the EVM spend tree)
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&hexv(f["bitcoinBurnRoot"].as_str().unwrap())); // NON-zero: the dest_leaf is a member of the bridge-burn set
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (the lock APPENDS; no membership read here)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&26u8);          // OP_BRIDGE_STEALTH_MINT
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["poolRoot"].as_str().unwrap()));
    stdin.write(&hexv(f["inCx"].as_str().unwrap()));
    stdin.write(&hexv(f["inCy"].as_str().unwrap()));
    stdin.write(&hexv(f["inOwner"].as_str().unwrap()));
    stdin.write(&f["inIndex"].as_u64().unwrap());
    for p in f["inPath"].as_array().expect("inPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["ownerPub"].as_str().unwrap())); // recipient one-time stealth x-only pubkey
    stdin.write(&f["deadline"].as_u64().unwrap());
    stdin.write(&hexv(f["locker"].as_str().unwrap()));
    stdin.write(&hexv(f["lCx"].as_str().unwrap()));
    stdin.write(&hexv(f["lCy"].as_str().unwrap()));
    stdin.write(&hexv(f["bmNext"].as_str().unwrap()));
    stdin.write(&f["bmIndex"].as_u64().unwrap());
    for p in f["bmPath"].as_array().expect("bmPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&f["fee"].as_u64().or_else(|| f["fee"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0)); // relay fee (0 = self-mint)
    stdin.write(&hexv(f["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelZ"].as_str().unwrap()));
    stdin.write(&hexv(f["lRange"].as_str().unwrap())); // BP+ range on L (Vec<u8> via io::read)

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} deadline={}", report.total_instruction_count(), pv.as_slice().len(), f["deadline"]);
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
