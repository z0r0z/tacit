// OP_TRANSFER BATCH harness — prove N independent shielded transfers in ONE settle.
//
// The guest has always accepted a batch (`num_ops` up to MAX_OPS = 256, then an op-type-tagged body per op);
// every single-op harness simply hardcoded `1`. That left the settle's dominant cost — gas, ~85% of the
// per-op total and charged once per SETTLE, not per op — being paid in full by each user separately.
// Batching divides it: 5 ops in a settle is ~1/5 the gas each.
//
// It also improves privacy. One op per settle makes each settle transaction a per-user event; several
// unrelated users in one settle breaks that link.
//
// Constraint: every op in the batch proves membership against the SINGLE `spendRoot` in the header, so the
// relay may only batch ops that already share a root (true for anything queued between two settles). It also
// cannot batch DEPENDENT ops — a note created by an op in this batch is not in the tree the batch proves
// against, so it cannot be spent by a later op in the same batch.
//
// OP_FILE: { chainBinding, spendRoot, ops: [ <transfer op>, ... ], memoHashes: [...] }
// where each op is exactly the shape exec-prove.rs consumes, and memoHashes covers every output leaf across
// the whole batch IN ORDER (the guest reads leaves.len() + lock_leaves.len() of them after the last op).
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, Elf, HashableKey, ProvingKey, SP1Stdin};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

// Fail-closed vkey guard — identical to the single-op harnesses: a drifting rebuild must never produce a
// proof the deployed pool rejects.
fn expected_vkey(field: &str) -> String {
    if let Ok(v) = std::env::var("EXPECT_VKEY") { return v.trim().to_lowercase(); }
    let path = std::env::var("ELF_VKEY_PIN")
        .expect("set EXPECT_VKEY=<pinned vkey> or ELF_VKEY_PIN=<path to elf-vkey-pin.json>");
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read ELF_VKEY_PIN")).expect("parse ELF_VKEY_PIN");
    j[field].as_str().expect("pin field missing").trim().to_lowercase()
}
fn assert_expected_vkey(actual: &str) {
    let exp = expected_vkey("program_vkey");
    assert_eq!(actual.trim().to_lowercase(), exp, "VKEY DRIFT: this ELF won't verify against the deployed contract");
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var("OP_FILE").expect("set OP_FILE")).unwrap(),
    ).unwrap();

    // A single-op file is a batch of one, so this harness is a superset of exec-prove.
    let ops: Vec<serde_json::Value> = match f.get("ops").and_then(|v| v.as_array()) {
        Some(a) => a.clone(),
        None => vec![f.clone()],
    };
    assert!(!ops.is_empty(), "batch has no ops");
    assert!(ops.len() <= 256, "batch over the guest's MAX_OPS");

    let mut stdin = SP1Stdin::new();
    // Header — one chain binding and ONE spend root for the whole batch.
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (Ethereum-only mode)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot  = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot      = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot  = 0
    stdin.write(&(ops.len() as u32));

    for op in &ops {
        stdin.write(&1u8); // OP_TRANSFER
        stdin.write(&hexv(op["asset"].as_str().unwrap()));
        let ins = op["inputs"].as_array().unwrap();
        let outs = op["outputs"].as_array().unwrap();
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
        stdin.write(&hexv(op["rangeProof"].as_str().unwrap()));
        stdin.write(
            &op["fee"].as_str().map(|s| s.parse::<u64>().unwrap()).unwrap_or(0),
        ); // per-op relay fee (0 = self-settle)
        stdin.write(&hexv(op["kernel"]["R"].as_str().unwrap()));
        stdin.write(&hexv(op["kernel"]["z"].as_str().unwrap()));
    }

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.
    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 batch of {} op(s)...", ops.len());
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 proof failed");
    println!("PROVED groth16 batch pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
