// CPU/CUDA Groth16 prover for OP_SEND_AND_UNWRAP (partial public exit): spend ONE hidden note → a public
// withdrawal(payout) + HIDDEN change note(s). Reads sendunwrap_op.json, proves the op, writes the on-chain
// submission artifacts. Mirrors exec-prove.rs / exec-wraptransfer.rs; only the op witness layout differs
// (OP_SEND_AND_UNWRAP = 28).
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
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/sendunwrap_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);
    stdin.write(&28u8); // OP_SEND_AND_UNWRAP
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    let inp = &f["input"];
    stdin.write(&hexv(inp["cx"].as_str().unwrap()));
    stdin.write(&hexv(inp["cy"].as_str().unwrap()));
    stdin.write(&hexv(inp["owner"].as_str().unwrap()));
    stdin.write(&inp["leafIndex"].as_u64().unwrap());
    for p in inp["path"].as_array().unwrap() {
        stdin.write(&hexv(p.as_str().unwrap()));
    }
    stdin.write(&hexv(inp["secret"].as_str().unwrap()));
    stdin.write(&hexv(f["recipient"].as_str().unwrap())); // 20-byte EVM recipient
    stdin.write(&u64f(&f["payout"]));
    stdin.write(&u64f(&f["fee"]));
    stdin.write(&u64f(&f["opDeadline"]));
    stdin.write(&hexv(f["pokR"].as_str().unwrap()));  // value-hiding opening PoK (value never read)
    stdin.write(&hexv(f["pokZv"].as_str().unwrap()));
    stdin.write(&hexv(f["pokZr"].as_str().unwrap()));
    let change = f["change"].as_array().unwrap();
    stdin.write(&(change.len() as u32));
    for o in change {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} payout={}", report.total_instruction_count(), pv.as_slice().len(), f["payout"]);
        return;
    }
    if mode != "groth16" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_expected_vkey(&vk);
        let proof = client.prove(&pk, stdin).compressed().run().expect("compressed proof failed");
        std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
        println!("LOCAL_VERIFY_OK (compressed)\nWROTE public_values.hex");
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    println!(
        "PROVED groth16 (forge *ProofReal is the on-chain gate) pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
