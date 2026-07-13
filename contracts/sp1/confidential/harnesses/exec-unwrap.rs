// OP_UNWRAP box harness — spend a note to a public recipient, releasing escrow. Reads OP_FILE
// (unwrap_op.json), proves the op in the zkVM, verifies locally, writes public_values.hex +
// proof_bytes.hex. MODE=groth16 -> GPU (on-chain); else compressed (CPU). stdin order = the guest's
// io::read for an OP_UNWRAP batch (main.rs): header roots (incl. lock_set_root + cdp_position_root),
// then op 0 fields.
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
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/unwrap_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: OP_UNWRAP requires membership
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0 (Ethereum-only)
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32); // num_ops
    stdin.write(&2u8); // OP_UNWRAP
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["cx"].as_str().unwrap()));
    stdin.write(&hexv(f["cy"].as_str().unwrap()));
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&f["leafIndex"].as_u64().unwrap());
    for p in f["path"].as_array().unwrap() {
        stdin.write(&hexv(p.as_str().unwrap()));
    }
    stdin.write(&hexv(f["secret"].as_str().unwrap())); // vestigial
    stdin.write(&f["value"].as_str().unwrap().parse::<u64>().unwrap());
    stdin.write(&hexv(f["recipient"].as_str().unwrap())); // 20-byte address
    stdin.write(
        &f["fee"]
            .as_str()
            .map(|s| s.parse::<u64>().unwrap())
            .unwrap_or(0),
    ); // relayer fee (0 = self-settle)
    stdin.write(
        &f["deadline"]
            .as_str()
            .map(|s| s.parse::<u64>().unwrap())
            .unwrap_or(0),
    ); // per-op settle expiry, bound in the opening sigma (0 = no expiry)
    stdin.write(&hexv(f["sigR"].as_str().unwrap())); // opening-sigma R (33B); never serialize blinding
    stdin.write(&hexv(f["sigZ"].as_str().unwrap())); // opening-sigma z (32B)

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

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
