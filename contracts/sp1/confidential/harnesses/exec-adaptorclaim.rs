// OP_ADAPTOR_CLAIM box harness (not part of the crate build). Claims a locked note before its deadline,
// revealing the kernel `s` (the t-reveal). FEE-LESS BY NECESSITY: the claim kernel over (L − O) IS the
// t-reveal channel and must stay zero-value — a fee would break the cross-chain atomic swap, so the recipient
// pays the relay via the funded follow-up spend of the claimed note. Reads fixtures/adaptorclaim_op.json.
// stdin order = the guest's OP_ADAPTOR_CLAIM io::read (main.rs): header roots (lockSetRoot NON-zero: L
// membership), then asset(32) ‖ lCx(32) ‖ lCy(32) ‖ tx(32) ‖ ty(32) ‖ deadline(u64) ‖ recipient(32) ‖
// locker(32) ‖ lIndex(u64) ‖ lPath[] ‖ amount(u64) ‖ oCx(32) ‖ oCy(32) ‖ oSigR(33) ‖ oSigZ(32) ‖ kernelR(33)
// ‖ kernelS(32). (`kernelS` is the completed adaptor signature `s`.)
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/adaptorclaim_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // unused by claim; pass the live root or 0
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&hexv(f["lockSetRoot"].as_str().unwrap())); // NON-zero: L lock-set membership
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&13u8);          // OP_ADAPTOR_CLAIM
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
    stdin.write(&f["amount"].as_u64().unwrap());
    stdin.write(&hexv(f["oCx"].as_str().unwrap()));
    stdin.write(&hexv(f["oCy"].as_str().unwrap()));
    stdin.write(&hexv(f["oSigR"].as_str().unwrap()));
    stdin.write(&hexv(f["oSigZ"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelS"].as_str().unwrap())); // the completed adaptor signature s (t-reveal)

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
