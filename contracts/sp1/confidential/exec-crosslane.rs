// Execute a SETTLE in cross-lane mode (bitcoinSpentRoot != 0) to validate the
// in-guest cross-lane non-membership end-to-end — the pool-standard check of the
// guest's witness read order for check_btc_nonmembership. Reads crosslane_op.json
// (tests/gen-cxfer-crosslane-fixture.mjs): a 2-in/2-out transfer + per-input IMT
// non-membership against the reflected Bitcoin spent-set root.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let op_file = std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/crosslane_op.json".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&op_file).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // != 0 → cross-lane check on
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0 (transfer-only, no bridge_mint)
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund in this batch)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    stdin.write(&1u32);
    stdin.write(&1u8); // OP_TRANSFER
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    let ins = f["inputs"].as_array().unwrap();
    let outs = f["outputs"].as_array().unwrap();
    stdin.write(&(ins.len() as u32));
    stdin.write(&(outs.len() as u32));
    for inp in ins {
        stdin.write(&hexv(inp["cx"].as_str().unwrap()));
        stdin.write(&hexv(inp["cy"].as_str().unwrap()));
        stdin.write(&hexv(inp["owner"].as_str().unwrap()));
        stdin.write(&inp["leafIndex"].as_u64().unwrap());
        for p in inp["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(inp["secret"].as_str().unwrap()));
        let nm = &inp["nonMember"]; // read by check_btc_nonmembership (bitcoinSpentRoot != 0)
        stdin.write(&hexv(nm["lowValue"].as_str().unwrap()));
        stdin.write(&hexv(nm["lowNext"].as_str().unwrap()));
        stdin.write(&nm["lowIndex"].as_u64().unwrap());
        for p in nm["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    }
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&f["fee"].as_u64().unwrap_or(0)); // relay fee (0 = fee-free transfer), read after bp_proof, before the kernel
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    // MODE=execute (default) — cross-lane validation only; MODE=groth16 — GPU prove + write the
    // on-chain artifacts (public_values.hex + proof_bytes.hex) for ConfidentialCrossLaneProofReal.
    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        // sp1 returns Ok with EMPTY public values when the guest halts before its commit (e.g. a
        // rejected witness panics an assert). Treat that as a hard failure, not a pass.
        assert!(!output.as_slice().is_empty(), "EMPTY public values: guest halted before commit (witness rejected by an in-guest assert)");
        println!("CROSSLANE_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
        return;
    }
    let client = ProverClient::builder().cpu().build();
    println!("setup...");
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cpu+native-gnark)...");
            let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    /* client.verify dropped — prover self-verifies; forge *ProofReal is the on-chain gate */
    assert!(!proof.public_values.as_slice().is_empty(), "EMPTY public values: guest halted before commit (witness rejected); refusing to write a 0-byte artifact");
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
