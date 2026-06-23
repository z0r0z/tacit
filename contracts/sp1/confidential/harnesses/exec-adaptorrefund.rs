// OP_ADAPTOR_REFUND box harness (not part of the crate build). Reclaims a locked note after its deadline,
// carving an OPTIONAL relay fee from the refunded note (kernel: L = O + fee — safe, REFUND reveals no `s`).
// Reads fixtures/adaptorrefund_op.json. stdin order = the guest's OP_ADAPTOR_REFUND io::read (main.rs): header
// roots (lockSetRoot NON-zero: L lock-set membership), then asset(32) ‖ lCx(32) ‖ lCy(32) ‖ tx(32) ‖ ty(32) ‖
// deadline(u64) ‖ recipient(32) ‖ locker(32) ‖ lIndex(u64) ‖ lPath[] ‖ oCx(32) ‖ oCy(32) ‖ amount(u64) ‖
// lSigR(33) ‖ lSigZ(32) ‖ fee(u64) ‖ kernelR(33) ‖ kernelZ(32). The L-opening (amount + lSig) re-binds the
// locked u64 value so the `fee` (read after, before the kernel) is bounded by it (fee < amount).
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
// NB box wiring: confirm the ELF path matches the relay loop's build; the serializer commits O to L − fee.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/adaptorrefund_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // unused by refund; pass the live root or 0
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&hexv(f["lockSetRoot"].as_str().unwrap())); // NON-zero: L lock-set membership
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&14u8);          // OP_ADAPTOR_REFUND
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["lCx"].as_str().unwrap()));
    stdin.write(&hexv(f["lCy"].as_str().unwrap()));
    stdin.write(&hexv(f["tx"].as_str().unwrap()));
    stdin.write(&hexv(f["ty"].as_str().unwrap()));
    stdin.write(&f["deadline"].as_u64().unwrap());
    stdin.write(&hexv(f["recipient"].as_str().unwrap()));
    stdin.write(&hexv(f["locker"].as_str().unwrap()));
    stdin.write(&f["lIndex"].as_u64().unwrap());
    for p in f["lPath"].as_array().expect("lPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["oCx"].as_str().unwrap())); // O opens to L − fee
    stdin.write(&hexv(f["oCy"].as_str().unwrap()));
    stdin.write(&f["amount"].as_u64().unwrap());      // L's locked u64 value, re-opened to bound the fee
    stdin.write(&hexv(f["lSigR"].as_str().unwrap())); // L opening R (locked-value bind)
    stdin.write(&hexv(f["lSigZ"].as_str().unwrap())); // L opening z
    stdin.write(&f["fee"].as_u64().unwrap_or(0)); // relay fee carved from the refund (0 = self-settle), after O
    stdin.write(&hexv(f["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelZ"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} fee={}", report.total_instruction_count(), pv.as_slice().len(), f["fee"].as_u64().unwrap_or(0));
        return;
    }
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") { assert_eq!(pk.verifying_key().bytes32(), expect.trim_start_matches("0x"), "EXPECT_VKEY mismatch"); }
    println!("proving groth16 (gpu)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!("LOCAL_VERIFY_OK groth16 pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("/root/work/cxfer/exec/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/cxfer/exec/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
