// OP_BRIDGE_MINT box harness (not part of the crate build). Mints an Ethereum note for a note BURNED FOR THE
// BRIDGE on Bitcoin (BTC→ETH). FEE-LESS BY NECESSITY: the destination note is PRE-COMMITTED at burn time on
// Bitcoin (dest_leaf is pinned in the bridge-burn set, v_out == v_in), so the mint must produce exactly that
// note — there is no room to carve `v_in − fee`. The relay still ROUTES it (box-settled, no user EOA) and the
// fee rides the follow-up spend of the minted note. Reads fixtures/bridgemint_op.json. stdin order = the
// guest's OP_BRIDGE_MINT io::read (main.rs): header roots (bitcoinBurnRoot NON-zero: bridge-burn-set
// membership), then asset(32) ‖ poolRoot(32) ‖ inCx(32) ‖ inCy(32) ‖ inOwner(32) ‖ inLeafIndex(u64) ‖
// inPath[] ‖ outCx(32) ‖ outCy(32) ‖ outOwner(32) ‖ bmNext(32) ‖ bmIndex(u64) ‖ bmPath[] ‖ rangeProof(bytes)
// ‖ kernelR(33) ‖ kernelZ(32).
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/bridgemint_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // unused by bridge_mint; pass the live root or 0
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&hexv(f["bitcoinBurnRoot"].as_str().unwrap())); // NON-zero: bridge-burn-set membership
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&4u8);           // OP_BRIDGE_MINT
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["poolRoot"].as_str().unwrap())); // the BTC confidential-pool root the burned note is in
    stdin.write(&hexv(f["inCx"].as_str().unwrap()));
    stdin.write(&hexv(f["inCy"].as_str().unwrap()));
    stdin.write(&hexv(f["inOwner"].as_str().unwrap()));
    stdin.write(&f["inLeafIndex"].as_u64().unwrap());
    for p in f["inPath"].as_array().expect("inPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["outCx"].as_str().unwrap())); // the PRE-COMMITTED destination note (v_out == v_in)
    stdin.write(&hexv(f["outCy"].as_str().unwrap()));
    stdin.write(&hexv(f["outOwner"].as_str().unwrap()));
    stdin.write(&hexv(f["bmNext"].as_str().unwrap())); // burn-set leaf neighbor
    stdin.write(&f["bmIndex"].as_u64().unwrap());
    for p in f["bmPath"].as_array().expect("bmPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(f["kernelZ"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={}", report.total_instruction_count(), pv.as_slice().len());
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
