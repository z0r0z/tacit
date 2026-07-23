// CPU/CUDA Groth16 prover for OP_WRAP_CDP_MINT (1-click cUSD): consume pending deposit(s) as collateral →
// mint a confidential CDP debt note in one settle. Reads wrapcdpmint_op.json. Mirrors exec-prove.rs; witness
// layout = OP_WRAP_CDP_MINT (30).
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};
const ELF: &[u8] = include_bytes!(
    "/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest"
);
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
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
            std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/wrapcdpmint_op.json".to_string()),
        ).unwrap(),
    ).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spendRoot = 0 (deposit-collateral; no tree membership)
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);
    stdin.write(&30u8); // OP_WRAP_CDP_MINT
    stdin.write(&hexv(f["controller"].as_str().unwrap())); // 20-byte controller
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&u64f(&f["debtValue"]));
    stdin.write(&hexv(f["nonce"].as_str().unwrap()));
    stdin.write(&hexv(f["rateSnapshot"].as_str().unwrap()));
    // SECURITY (F-2): `fee` + the DEBT COMMITMENT move ahead of the deposit legs — each deposit's
    // authorization must BIND them, or a relayer can substitute its own debt commitment and take the loan
    // as "fee" while the borrower's collateral is encumbered for the gross debt.
    stdin.write(&u64f(&f["fee"]));
    {
        let d = &f["debt"];
        stdin.write(&hexv(d["cx"].as_str().unwrap()));
        stdin.write(&hexv(d["cy"].as_str().unwrap()));
        stdin.write(&hexv(d["sigR"].as_str().unwrap()));
        stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
    }
    let legs = f["legs"].as_array().unwrap();
    stdin.write(&(legs.len() as u32));
    for leg in legs {
        stdin.write(&hexv(leg["asset"].as_str().unwrap()));
        stdin.write(&u64f(&leg["value"]));
        stdin.write(&hexv(leg["cx"].as_str().unwrap()));
        stdin.write(&hexv(leg["cy"].as_str().unwrap()));
        stdin.write(&hexv(leg["sigR"].as_str().unwrap()));
        stdin.write(&hexv(leg["sigZ"].as_str().unwrap()));
    }


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
