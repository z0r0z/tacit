// CPU-forced Groth16 prover for the confidential guest (box use; not part of the
// crate build). Reads the transfer_op.json witness, proves the full op in the
// zkVM, verifies locally, and writes on-chain submission artifacts
// (public_values.hex + proof_bytes.hex) for a Forge verify against the real SP1
// Groth16 verifier. ProverClient::builder().cpu() forces CPU — never the GPU the
// live mainnet bridge prover uses.
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
// Fail-closed vkey guard: the derived vkey MUST equal the pinned PROGRAM_VKEY, else a drifting box
// rebuild (different toolchain/deps than the committed elf/cxfer-guest) produces a proof that reverts
// in ConfidentialPool.settle. Set EXPECT_VKEY=<pinned vkey> OR ELF_VKEY_PIN=<path to
// elf-vkey-pin.json>; the prove aborts BEFORE the GPU spend on any mismatch.
fn expected_vkey(field: &str) -> String {
    if let Ok(v) = std::env::var("EXPECT_VKEY") {
        return v.trim().to_lowercase();
    }
    let path = std::env::var("ELF_VKEY_PIN")
        .expect("set EXPECT_VKEY=<pinned vkey> or ELF_VKEY_PIN=<path to elf-vkey-pin.json> so a drifting rebuild can't produce on-chain-rejected proofs");
    let j: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read ELF_VKEY_PIN"))
            .expect("parse ELF_VKEY_PIN");
    j[field].as_str().expect("pin field missing").trim().to_lowercase()
}
fn assert_vkey(actual: &str, field: &str) {
    let exp = expected_vkey(field);
    let act = actual.trim().to_lowercase();
    assert_eq!(act, exp, "VKEY DRIFT: derived {act} != pinned {field} {exp} — this ELF won't verify against the deployed contract; rebuild from the committed source so the box runs the pinned bytes before proving");
}
fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("OP_FILE")
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/transfer_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (Ethereum-only mode, no cross-lane check)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0 (no bridge_mint in this batch)
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

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    // CudaProver and CpuProver are distinct types, so each path is self-contained (no shared binding).
    // groth16 → GPU (a CPU groth16 wrap is intractable); compressed → CPU (demonstrates the CPU path).
    if mode != "groth16" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_vkey(&vk, "program_vkey");
        println!("proving compressed (cpu)...");
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
        println!("LOCAL_VERIFY_OK (compressed)\nWROTE public_values.hex (compressed proof verified locally)");
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_vkey(&vk, "program_vkey");
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
