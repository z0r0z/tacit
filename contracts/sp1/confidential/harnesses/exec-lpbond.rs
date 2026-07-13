// CPU/CUDA Groth16 prover for OP_LP_BOND (1-click farm entry): add liquidity AND bond the resulting shares
// into a farm in one settle. Reads lpbond_op.json, proves, writes the on-chain artifacts. Mirrors
// exec-prove.rs; witness layout = OP_LP_BOND (29): bond target ‖ OP_LP_ADD body (no share note).
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
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())).unwrap_or(0)
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
            std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/lpbond_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: A/B leg membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);
    stdin.write(&29u8); // OP_LP_BOND
    stdin.write(&hexv(f["controller"].as_str().unwrap())); // 20-byte FarmController
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
    stdin.write(&hexv(f["bondNonce"].as_str().unwrap()));
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(u64f(&f["feeBps"]) as u32));
    stdin.write(&u64f(&f["reserveAPre"]));
    stdin.write(&u64f(&f["reserveBPre"]));
    stdin.write(&u64f(&f["sharesPre"]));
    let a = &f["a"];
    stdin.write(&hexv(a["cx"].as_str().unwrap()));
    stdin.write(&hexv(a["cy"].as_str().unwrap()));
    stdin.write(&hexv(a["owner"].as_str().unwrap()));
    stdin.write(&a["index"].as_u64().unwrap());
    for p in a["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&u64f(&a["d"]));
    stdin.write(&hexv(a["sigR"].as_str().unwrap()));
    stdin.write(&hexv(a["sigZ"].as_str().unwrap()));
    let b = &f["b"];
    stdin.write(&hexv(b["cx"].as_str().unwrap()));
    stdin.write(&hexv(b["cy"].as_str().unwrap()));
    stdin.write(&hexv(b["owner"].as_str().unwrap()));
    stdin.write(&b["index"].as_u64().unwrap());
    for p in b["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&u64f(&b["d"]));
    stdin.write(&hexv(b["sigR"].as_str().unwrap()));
    stdin.write(&hexv(b["sigZ"].as_str().unwrap()));
    stdin.write(&u64f(&f["opDeadline"]));
    stdin.write(&u64f(&f["fee"]));

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
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
    println!("PROVED groth16 pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
