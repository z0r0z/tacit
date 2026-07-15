// FAST-LANE box harness: OP_TRANSFER (op 1) spending a BITCOIN-HOMED note on Ethereum — membership is
// proven against a relay-attested Bitcoin pool root (knownBitcoinRoot) instead of this pool's own tree,
// so the settle records bitcoinConsumed[nu] and advances bitcoinConsumedCount (slot 120, the fast-lane
// freshness anchor the eth-reflection guest reads).
//
// The one thing every other harness omits: bitcoin_spent_root is NON-ZERO here, so the guest runs
// check_btc_nonmembership(nu, root) per input (main.rs:379) and reads an IMT non-membership witness
// (low_value, low_next, low_index, low_path) immediately after that input's vestigial `secret`.
// Reads fixtures/fastlane_op.json. MODE=execute -> execute + cycles. MODE=groth16 -> prove + artifacts.
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
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/fastlane_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();

    // --- batch header ---
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // the BITCOIN pool root (knownBitcoinRoot)
    stdin.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // NON-zero: drives the non-membership gate
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32); // num_ops

    // --- op 0: OP_TRANSFER ---
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
        // check_btc_nonmembership reads these here (main.rs:253-257), per input, since root != 0.
        let low = &inp["low"];
        stdin.write(&hexv(low["value"].as_str().unwrap()));
        stdin.write(&hexv(low["next"].as_str().unwrap()));
        stdin.write(&low["index"].as_u64().unwrap());
        for p in low["path"].as_array().unwrap() {
            stdin.write(&hexv(p.as_str().unwrap()));
        }
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
    );
    stdin.write(&hexv(t["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(t["kernel"]["z"].as_str().unwrap()));

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count.
    for _ in 0..64u32 {
        stdin.write(&hexv(
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        ));
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client
            .execute(Elf::Static(ELF), stdin)
            .run()
            .expect("execute failed");
        println!(
            "EXECUTE_OK cycles={} pv_bytes={}",
            report.total_instruction_count(),
            pv.as_slice().len()
        );
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
        "PROVED groth16 pv_bytes={}",
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
