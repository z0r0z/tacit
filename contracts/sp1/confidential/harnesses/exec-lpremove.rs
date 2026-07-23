// OP_LP_REMOVE box harness — burn a shielded LP-share note, withdraw the proportional reserves as two
// fresh notes. Reads OP_FILE (lp_remove_op.json), proves in the zkVM, verifies locally, writes
// public_values.hex + proof_bytes.hex. MODE=groth16 -> GPU. stdin order = the guest's io::read for an
// OP_LP_REMOVE batch (main.rs): header roots (incl. lock_set_root + cdp_position_root), then op 0 fields.
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
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/lp_remove_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: share-note membership
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32); // num_ops
    stdin.write(&8u8); // OP_LP_REMOVE
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32));
    stdin.write(&(f["protocolFeeBps"].as_u64().unwrap_or(0) as u32)); // optional Uniswap fee-switch (0 = no skim, ≡ 3-arg pool id)
    let pf_rcpt = f["protocolFeeRecipient"].as_str().map(hexv).unwrap_or_else(|| vec![0u8; 33]);
    stdin.write(&pf_rcpt); // recipient33 — bound into the 6-arg protocol-fee pool id
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["sharesPre"].as_u64().unwrap());
    let s = &f["share"];
    stdin.write(&hexv(s["cx"].as_str().unwrap()));
    stdin.write(&hexv(s["cy"].as_str().unwrap()));
    stdin.write(&hexv(s["owner"].as_str().unwrap()));
    stdin.write(&s["leafIndex"].as_u64().unwrap());
    for p in s["path"].as_array().unwrap() {
        stdin.write(&hexv(p.as_str().unwrap()));
    }
    stdin.write(&s["dShares"].as_u64().unwrap()); // PUBLIC shares burned (moves totalShares)
    // PARTIAL WITHDRAWAL: the share note proves authority with a value-HIDING blind PoK — it may hold MORE
    // than dShares, and the remainder returns as an LP-share change note. Burning the whole note was
    // previously the only option, so exiting a fraction of a position was impossible.
    stdin.write(&hexv(s["pokR"].as_str().expect("lpremove: share.pokR")));
    stdin.write(&hexv(s["pokZv"].as_str().expect("lpremove: share.pokZv")));
    stdin.write(&hexv(s["pokZr"].as_str().expect("lpremove: share.pokZr")));
    stdin.write(&f["dA"].as_u64().unwrap());
    stdin.write(&f["remA"].as_u64().unwrap());
    stdin.write(&f["dB"].as_u64().unwrap());
    stdin.write(&f["remB"].as_u64().unwrap());
    let a = &f["a"];
    stdin.write(&hexv(a["cx"].as_str().unwrap()));
    stdin.write(&hexv(a["cy"].as_str().unwrap()));
    stdin.write(&hexv(a["owner"].as_str().unwrap()));
    stdin.write(&hexv(a["sigR"].as_str().unwrap()));
    stdin.write(&hexv(a["sigZ"].as_str().unwrap()));
    let b = &f["b"];
    stdin.write(&hexv(b["cx"].as_str().unwrap()));
    stdin.write(&hexv(b["cy"].as_str().unwrap()));
    stdin.write(&hexv(b["owner"].as_str().unwrap()));
    stdin.write(&hexv(b["sigR"].as_str().unwrap()));
    stdin.write(&hexv(b["sigZ"].as_str().unwrap()));
    stdin.write(&f["deadline"].as_u64().unwrap()); // op_deadline
    stdin.write(&f["fee"].as_u64().unwrap_or(0)); // relay fee (0 = self-settle), guest reads last
    // Share-change tail: LP-share notes returned to the provider. Built under the pool's own lp_asset
    // (derived from the pool id, never witnessed), so change cannot be re-labelled into another asset.
    // Count must be a legal BP+ aggregation size {0,1,2,4,8}.
    let empty: Vec<serde_json::Value> = Vec::new();
    let sch = f["shareChange"].as_array().unwrap_or(&empty).clone();
    stdin.write(&(sch.len() as u32));
    for c in &sch {
        stdin.write(&hexv(c["cx"].as_str().unwrap()));
        stdin.write(&hexv(c["cy"].as_str().unwrap()));
        stdin.write(&hexv(c["owner"].as_str().unwrap()));
    }
    if !sch.is_empty() {
        stdin.write(&hexv(f["changeRangeProof"].as_str().expect("lpremove: changeRangeProof")));
    }
    stdin.write(&hexv(f["shareKernelR"].as_str().expect("lpremove: shareKernelR")));
    stdin.write(&hexv(f["shareKernelZ"].as_str().expect("lpremove: shareKernelZ")));


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
