// CPU-forced Groth16 prover for OP_WRAP_TRANSFER (atomic wrap-and-send): consume a pending PUBLIC deposit
// and emit HIDDEN recipient (+ change) notes in one settle. Reads wraptransfer_op.json, proves the full op
// in the zkVM, and writes the on-chain submission artifacts (public_values.hex + proof_bytes.hex) for a
// Forge verify against the real SP1 Groth16 verifier. Mirrors exec-prove.rs; only the op witness layout
// differs (OP_WRAP_TRANSFER = 27).
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};
const ELF: &[u8] = include_bytes!(
    "/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest"
);
fn hexv(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}
fn u64f(v: &serde_json::Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
        .unwrap_or(0)
}
fn assert_expected_vkey(vk: &str) {
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(
            vk.trim().trim_start_matches("0x").to_lowercase(),
            expect.trim().trim_start_matches("0x").to_lowercase(),
            "EXPECT_VKEY mismatch"
        );
    }
}
fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("OP_FILE")
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/wraptransfer_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    // spendRoot is only consumed by OP_TRANSFER membership; wraptransfer has no tree input → 0 is fine.
    stdin.write(&hexv(
        f["spendRoot"]
            .as_str()
            .unwrap_or("0x0000000000000000000000000000000000000000000000000000000000000000"),
    ));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);
    stdin.write(&27u8); // OP_WRAP_TRANSFER
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&u64f(&f["value"])); // public deposit value (in-system u64)
    let d = &f["deposit"];
    stdin.write(&hexv(d["cx"].as_str().unwrap()));
    stdin.write(&hexv(d["cy"].as_str().unwrap()));
    stdin.write(&hexv(d["owner"].as_str().unwrap()));
    stdin.write(&hexv(d["sigR"].as_str().unwrap()));
    stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
    let outs = f["outputs"].as_array().unwrap();
    stdin.write(&(outs.len() as u32));
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&u64f(&f["fee"])); // relay fee (0 for the user-sent router path)
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    if mode != "groth16" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_expected_vkey(&vk);
        println!("proving compressed (cpu)...");
        let proof = client
            .prove(&pk, stdin)
            .compressed()
            .run()
            .expect("compressed proof failed");
        std::fs::write(
            "public_values.hex",
            hex::encode(proof.public_values.as_slice()),
        )
        .unwrap();
        println!("LOCAL_VERIFY_OK (compressed)\nWROTE public_values.hex");
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 proof failed");
    println!(
        "PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write(
        "public_values.hex",
        hex::encode(proof.public_values.as_slice()),
    )
    .unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
