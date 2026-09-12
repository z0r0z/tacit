// CPU-forced Groth16 prover for the confidential guest (box use; not part of the
// crate build). Reads the transfer_op.json witness, proves the full op in the
// zkVM, verifies locally, and writes on-chain submission artifacts
// (public_values.hex + proof_bytes.hex) for a Forge verify against the real SP1
// Groth16 verifier. ProverClient::builder().cpu() forces CPU — never the GPU the
// live mainnet bridge prover uses.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

// Fail-closed vkey guard: the derived vkey MUST equal the pinned PROGRAM_VKEY, else a drifting box
// rebuild (different toolchain/deps than the committed elf/cxfer-guest) produces a proof that reverts
// in ConfidentialPool.settle. Set EXPECT_VKEY=<pinned vkey> OR ELF_VKEY_PIN=<path to
// elf-vkey-pin.json>; the prove aborts BEFORE the GPU spend on any mismatch.
fn expected_vkey(field: &str) -> String {
    if let Ok(v) = std::env::var("EXPECT_VKEY") { return v.trim().to_lowercase(); }
    let path = std::env::var("ELF_VKEY_PIN")
        .expect("set EXPECT_VKEY=<pinned vkey> or ELF_VKEY_PIN=<path to elf-vkey-pin.json> so a drifting rebuild can't produce on-chain-rejected proofs");
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read ELF_VKEY_PIN")).expect("parse ELF_VKEY_PIN");
    j[field].as_str().expect("pin field missing").trim().to_lowercase()
}
fn assert_vkey(actual: &str, field: &str) {
    let exp = expected_vkey(field);
    let act = actual.trim().to_lowercase();
    assert_eq!(act, exp, "VKEY DRIFT: derived {act} != pinned {field} {exp} — this ELF won't verify against the deployed contract; rebuild from the committed source so the box runs the pinned bytes before proving");
}
fn main() {
    // FIXTURE selects the op fixture (default = the legacy transfer_op.json). The fixture's optional "op"
    // field picks the witness layout: "transfer" (default) or "wraptransfer" (atomic wrap-and-send).
    let fixture = std::env::var("FIXTURE")
        .unwrap_or_else(|_| "/root/work/confidential/fixtures/transfer_op.json".into());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fixture).unwrap()).unwrap();
    let op = f["op"].as_str().unwrap_or("transfer");
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    // spendRoot is only consumed by OP_TRANSFER membership; wraptransfer has no tree input → 0 is fine.
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap_or("0x0000000000000000000000000000000000000000000000000000000000000000")));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (Ethereum-only mode, no cross-lane check)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0 (no bridge_mint in this batch)
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund; guest header reads it unconditionally — main.rs:139)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    stdin.write(&1u32);
    if op == "wrap" {
        // OP_WRAP = 0: consume a pending public deposit (pool.wrap() already mined) → mint one hidden note.
        stdin.write(&0u8);
        stdin.write(&hexv(f["asset"].as_str().unwrap()));
        stdin.write(&f["value"].as_u64().unwrap());
        let d = &f["deposit"];
        stdin.write(&hexv(d["cx"].as_str().unwrap()));
        stdin.write(&hexv(d["cy"].as_str().unwrap()));
        stdin.write(&hexv(d["owner"].as_str().unwrap()));
        stdin.write(&hexv(d["sigR"].as_str().unwrap()));
        stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
    } else if op == "wraptransfer" {
        // OP_WRAP_TRANSFER = 27: consume a pending public deposit → hidden recipient (+ change) notes.
        stdin.write(&27u8);
        stdin.write(&hexv(f["asset"].as_str().unwrap()));
        stdin.write(&f["value"].as_u64().unwrap()); // public deposit value (in-system u64)
        let d = &f["deposit"];
        stdin.write(&hexv(d["cx"].as_str().unwrap()));
        stdin.write(&hexv(d["cy"].as_str().unwrap()));
        stdin.write(&hexv(d["owner"].as_str().unwrap()));
        stdin.write(&hexv(d["sigR"].as_str().unwrap()));
        stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
        let outs = f["outputs"].as_array().unwrap();
        stdin.write(&(outs.len() as u32));
        for o in outs {
            stdin.write(&hexv(o["cx"].as_str().unwrap()));
            stdin.write(&hexv(o["cy"].as_str().unwrap()));
            stdin.write(&hexv(o["owner"].as_str().unwrap()));
        }
        stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
        stdin.write(&f["fee"].as_u64().unwrap_or(0)); // relay fee (0 for the user-sent router path)
        stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
        stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));
    } else {
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
            for p in inp["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
            stdin.write(&hexv(inp["secret"].as_str().unwrap()));
        }
        for o in outs {
            stdin.write(&hexv(o["cx"].as_str().unwrap()));
            stdin.write(&hexv(o["cy"].as_str().unwrap()));
            stdin.write(&hexv(o["owner"].as_str().unwrap()));
        }
        stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
        // Relay fee: read unconditionally between rangeProof and the kernel (main.rs OP_TRANSFER).
        stdin.write(&f["fee"].as_str().map(|s| s.parse::<u64>().unwrap()).unwrap_or(0));
        stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
        stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));
    }

    // n_memos = leaves.len() (+ lock_leaves.len() = 0 for these ops), read unconditionally at the end of
    // main() regardless of op type. wrap mints 1 leaf; transfer/wraptransfer mint outs.len() leaves.
    let n_memos = match op {
        "wrap" => 1,
        _ => f["outputs"].as_array().map(|o| o.len()).unwrap_or(0),
    };
    let empty_memo_hash = hexv("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    for _ in 0..n_memos { stdin.write(&empty_memo_hash); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    // CudaProver and CpuProver are distinct types, so each path is self-contained (no shared binding).
    // groth16 → GPU (a CPU groth16 wrap is intractable); compressed → CPU (demonstrates the CPU path).
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let (out, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTED cycles={} pv_bytes={} exit_code={}", report.total_instruction_count(), out.as_slice().len(), report.exit_code);
        return;
    }
    if mode == "network" {
        let pclient = ProverClient::builder().network().build();
        let pk = pclient.setup(Elf::Static(ELF)).expect("setup");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_vkey(&vk, "program_vkey");
        let cycle_limit: u64 = std::env::var("REFLECT_CYCLE_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000_000_000);
        let gas_limit: u64 = std::env::var("REFLECT_GAS_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000_000_000);
        println!("proving groth16 (network)... cycle_limit={cycle_limit} gas_limit={gas_limit}");
        let proof = pclient.prove(&pk, stdin).groth16().cycle_limit(cycle_limit).gas_limit(gas_limit).run().expect("groth16 proof failed");
        let pv = proof.public_values.as_slice().to_vec();
        println!("PROVED pv_bytes={}", pv.len());
        pclient.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
        println!("LOCAL_VERIFY_OK");
        std::fs::write("/root/work/prover-host/out/public_values.hex", hex::encode(&pv)).unwrap();
        std::fs::write("/root/work/prover-host/out/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
        println!("WROTE public_values.hex + proof_bytes.hex");
        return;
    }
    if mode != "groth16" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_vkey(&vk, "program_vkey");
        println!("proving compressed (cpu)...");
        let proof = client.prove(&pk, stdin).compressed().run().expect("compressed proof failed");
        client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
        std::fs::write("/root/work/prover-host/out/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
        println!("LOCAL_VERIFY_OK (compressed)\nWROTE public_values.hex (compressed proof verified locally)");
        return;
    }
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_vkey(&vk, "program_vkey");
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK groth16 pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("/root/work/prover-host/out/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
