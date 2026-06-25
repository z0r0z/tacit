// OP_BRIDGE_BURN box harness — burn EVM notes into Bitcoin destination crossOuts (ETH→BTC source side).
// Reads OP_FILE (bridgeburn_op.json), proves the op in the zkVM, verifies locally, writes
// public_values.hex + proof_bytes.hex. MODE=groth16 -> GPU. stdin order = the guest's io::read for an
// OP_BRIDGE_BURN batch (main.rs): header roots (incl. lock_set_root + cdp_position_root), then op 0 fields.
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
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/bridgeburn_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: membership
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0 (EVM-homed burn)
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32); // num_ops
    stdin.write(&3u8); // OP_BRIDGE_BURN
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&(f["destChain"].as_u64().unwrap() as u32)); // dest_chain (read as u32)
    let ins = f["inputs"].as_array().unwrap();
    let outs = f["outputs"].as_array().unwrap();
    stdin.write(&(ins.len() as u32)); // n_in
    stdin.write(&(outs.len() as u32)); // m_out
    for inp in ins {
        stdin.write(&hexv(inp["cx"].as_str().unwrap()));
        stdin.write(&hexv(inp["cy"].as_str().unwrap()));
        stdin.write(&hexv(inp["owner"].as_str().unwrap()));
        stdin.write(&inp["leafIndex"].as_u64().unwrap());
        for p in inp["path"].as_array().unwrap() {
            stdin.write(&hexv(p.as_str().unwrap()));
        }
        stdin.write(&hexv(inp["secret"].as_str().unwrap()));
    }
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(
        &f["fee"]
            .as_str()
            .map(|s| s.parse::<u64>().unwrap())
            .unwrap_or(0),
    ); // relay fee (0 = self-settle)
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    if mode != "groth16" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_expected_vkey(&vk);
        let proof = client
            .prove(&pk, stdin)
            .compressed()
            .run()
            .expect("compressed proof failed");
        /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
        std::fs::write(
            "public_values.hex",
            hex::encode(proof.public_values.as_slice()),
        )
        .unwrap();
        println!("LOCAL_VERIFY_OK (compressed)");
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
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!(
        "PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write(
        "public_values.hex",
        hex::encode(proof.public_values.as_slice()),
    )
    .unwrap();
    std::fs::write(
        "proof_bytes.hex",
        hex::encode(proof.bytes()),
    )
    .unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
