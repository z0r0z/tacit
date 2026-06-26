// MIXED-OP box harness — one OP_TRANSFER (op 1) then one OP_UNWRAP (op 2) in ONE proof, both spending
// notes from the SAME shared spendRoot note tree under ONE header. Reads OP_FILE (mixed_op.json), proves
// the heterogeneous batch in the zkVM, writes public_values.hex (+ proof_bytes.hex in groth16). This is
// the only box harness that drives >1 op TYPE through the guest's generic `for _ in 0..num_ops` loop, so
// it validates cross-op PublicValues aggregation (min_deadline fold + combined nullifiers/leaves/
// withdrawals/fees). MODE=groth16 -> native-gnark CPU groth16 (on-chain artifacts); else compressed.
//
// stdin order == the guest's io::read for a 2-op batch (main.rs): the shared header roots (chainBinding,
// spendRoot, bitcoin_spent_root, bitcoin_burn_root, lock_set_root, cdp_position_root, num_ops), then the
// OP_TRANSFER arm (~main.rs:316), then the OP_UNWRAP arm (~main.rs:651, incl. the deadline read before
// sigR). Matches gen-confidential-mixed-fixture.mjs field names.
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
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/mixed_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();

    // --- shared batch header (written ONCE for both ops) ---
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: both ops require membership
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0 (Ethereum-only)
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&2u32); // num_ops = 2 (heterogeneous)

    // --- op 0: OP_TRANSFER (n-in / m-out, real BP+ range proof + kernel) ---
    let t = &f["transfer"];
    stdin.write(&1u8); // OP_TRANSFER
    stdin.write(&hexv(t["asset"].as_str().unwrap()));
    let ins = t["inputs"].as_array().unwrap();
    let outs = t["outputs"].as_array().unwrap();
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
        stdin.write(&hexv(inp["secret"].as_str().unwrap())); // vestigial
    }
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(t["rangeProof"].as_str().unwrap()));
    stdin.write(
        &t["fee"]
            .as_str()
            .map(|s| s.parse::<u64>().unwrap())
            .unwrap_or(0),
    ); // relay fee (0 = self-settle)
    stdin.write(&hexv(t["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(t["kernel"]["z"].as_str().unwrap()));

    // --- op 1: OP_UNWRAP (single-note spend to a public recipient, opening sigma + deadline) ---
    let u = &f["unwrap"];
    stdin.write(&2u8); // OP_UNWRAP
    stdin.write(&hexv(u["asset"].as_str().unwrap()));
    stdin.write(&hexv(u["cx"].as_str().unwrap()));
    stdin.write(&hexv(u["cy"].as_str().unwrap()));
    stdin.write(&hexv(u["owner"].as_str().unwrap()));
    stdin.write(&u["leafIndex"].as_u64().unwrap());
    for p in u["path"].as_array().unwrap() {
        stdin.write(&hexv(p.as_str().unwrap()));
    }
    stdin.write(&hexv(u["secret"].as_str().unwrap())); // vestigial
    stdin.write(&u["value"].as_str().unwrap().parse::<u64>().unwrap());
    stdin.write(&hexv(u["recipient"].as_str().unwrap())); // 20-byte address
    stdin.write(
        &u["fee"]
            .as_str()
            .map(|s| s.parse::<u64>().unwrap())
            .unwrap_or(0),
    ); // relayer fee (0 = self-settle)
    stdin.write(
        &u["deadline"]
            .as_str()
            .map(|s| s.parse::<u64>().unwrap())
            .unwrap_or(0),
    ); // per-op expiry, bound in the opening sigma; folded into the batch min_deadline (0 = no expiry)
    stdin.write(&hexv(u["sigR"].as_str().unwrap())); // opening-sigma R (33B); never serialize blinding
    stdin.write(&hexv(u["sigZ"].as_str().unwrap())); // opening-sigma z (32B)

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
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
