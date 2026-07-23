// OP_WRAP_LP box harness — 1-click liquidity from an external wallet.
//
// Consumes TWO pending public deposits as the A/B contributions and mints the shielded LP-share note in one
// settle (OP_LP_ADD fused with OP_WRAP). No tree notes are spent, so there is no membership, no nullifier and
// no change output: a deposit's value is exact and public (bound into its deposit_id), which is precisely what
// removes the intermediate note — one transaction instead of wrap, wrap, add, and one fewer linkable note.
//
// OP_FILE mirrors the guest's read order exactly (main.rs OP_WRAP_LP): pair + fee tier, the pool's pre-state,
// each deposit (value, commitment, owner, opening sigma), the share commitment + its sigma, deadline, and the
// relay fee. The fee must sit on the guest's coarse ladder (<= 2 significant digits) or the proof is refused.
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, Elf, HashableKey, ProvingKey, SP1Stdin};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn u64of(v: &serde_json::Value) -> u64 {
    v.as_u64().unwrap_or_else(|| v.as_str().expect("numeric field").parse().expect("numeric field"))
}

fn expected_vkey(field: &str) -> String {
    if let Ok(v) = std::env::var("EXPECT_VKEY") { return v.trim().to_lowercase(); }
    let path = std::env::var("ELF_VKEY_PIN")
        .expect("set EXPECT_VKEY=<pinned vkey> or ELF_VKEY_PIN=<path to elf-vkey-pin.json>");
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read ELF_VKEY_PIN")).expect("parse ELF_VKEY_PIN");
    j[field].as_str().expect("pin field missing").trim().to_lowercase()
}
fn assert_expected_vkey(actual: &str) {
    assert_eq!(actual.trim().to_lowercase(), expected_vkey("program_vkey"),
        "VKEY DRIFT: this ELF won't verify against the deployed contract");
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("OP_FILE").expect("set OP_FILE")).unwrap(),
    ).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (Ethereum-only mode)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot  = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot      = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot  = 0
    stdin.write(&1u32);
    stdin.write(&32u8); // OP_WRAP_LP

    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(u64of(&f["feeBps"]) as u32));
    stdin.write(&(u64of(&f["protocolFeeBps"]) as u32));
    stdin.write(&hexv(f["protocolFeeRecipient"].as_str().unwrap()));
    stdin.write(&u64of(&f["reserveAPre"]));
    stdin.write(&u64of(&f["reserveBPre"]));
    stdin.write(&u64of(&f["sharesPre"]));

    // A deposit, then B deposit: value, commitment, owner, opening sigma.
    for side in ["a", "b"] {
        let d = &f[side];
        stdin.write(&u64of(&d["value"]));
        stdin.write(&hexv(d["cx"].as_str().unwrap()));
        stdin.write(&hexv(d["cy"].as_str().unwrap()));
        stdin.write(&hexv(d["owner"].as_str().unwrap()));
        stdin.write(&hexv(d["sigR"].as_str().unwrap()));
        stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
    }
    // Minted LP-share note + its opening sigma.
    let s = &f["share"];
    stdin.write(&hexv(s["cx"].as_str().unwrap()));
    stdin.write(&hexv(s["cy"].as_str().unwrap()));
    stdin.write(&hexv(s["owner"].as_str().unwrap()));
    stdin.write(&hexv(s["sigR"].as_str().unwrap()));
    stdin.write(&hexv(s["sigZ"].as_str().unwrap()));

    stdin.write(&u64of(&f["opDeadline"]));
    stdin.write(&u64of(&f["fee"])); // relay fee, carved from the A contribution

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.
    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 wrap_lp...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    println!("PROVED groth16 wrap_lp pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
