// Mint a portion of a confidential note as the public ERC20 (OP_SEND_AND_UNWRAP), proved directly since
// the production relay's exec-sendunwrap box invocation is currently broken (separate infra gap). Reads
// sendunwrap_op.json (scratchpad/mint-tac-erc20.mjs) and writes the settle guest's exact stdin order.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn path32(s: &mut SP1Stdin, arr: &[serde_json::Value]) {
    assert_eq!(arr.len(), 32, "path must have exactly 32 siblings");
    for p in arr { s.write(&hexv(p.as_str().unwrap())); }
}
fn main() {
    let fx_path = std::env::var("SENDUNWRAP_FIXTURE").unwrap_or_else(|_| "/root/work/confidential/fixtures/sendunwrap_op.json".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fx_path).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();

    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0 (no bridge_mint in this batch)
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32); // num_ops

    let op = &f["op"];
    stdin.write(&28u8); // OP_SEND_AND_UNWRAP
    stdin.write(&hexv(op["asset"].as_str().unwrap()));
    stdin.write(&hexv(op["cx"].as_str().unwrap()));
    stdin.write(&hexv(op["cy"].as_str().unwrap()));
    stdin.write(&hexv(op["owner"].as_str().unwrap()));
    stdin.write(&op["leafIndex"].as_u64().unwrap());
    path32(&mut stdin, op["path"].as_array().unwrap());
    // recipient: 20 raw bytes (strip the 12-byte left-pad from the 32-byte hex if present)
    let recip_full = hexv(op["recipient"].as_str().unwrap());
    let recip20 = if recip_full.len() == 32 { recip_full[12..].to_vec() } else { recip_full };
    assert_eq!(recip20.len(), 20, "recipient must be 20 bytes");
    stdin.write(&recip20);
    stdin.write(&(op["payout"].as_u64().unwrap()));
    stdin.write(&(op["fee"].as_u64().unwrap()));
    stdin.write(&(op["opDeadline"].as_u64().unwrap()));
    stdin.write(&hexv(op["pokR"].as_str().unwrap()));
    stdin.write(&hexv(op["pokZv"].as_str().unwrap()));
    stdin.write(&hexv(op["pokZr"].as_str().unwrap()));
    // input_leaf_authed (native/non-batch-authenticated path) reads the spender's secret nullifier key
    // right here, before computing (leaf, nu) for the membership + PoK checks above.
    stdin.write(&hexv(op["nk"].as_str().unwrap()));
    let change = op["change"].as_array().unwrap();
    stdin.write(&(change.len() as u32));
    for c in change {
        stdin.write(&hexv(c["cx"].as_str().unwrap()));
        stdin.write(&hexv(c["cy"].as_str().unwrap()));
        stdin.write(&hexv(c["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(op["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(op["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(op["kernelZ"].as_str().unwrap()));

    // n_memos = leaves.len() (= change.len(), the change note(s) pushed by this op) + lock_leaves.len() (0).
    stdin.write(&hexv(f["memoHash"].as_str().unwrap()));

    let mode = std::env::var("PROOF_MODE").unwrap_or_else(|_| "execute".to_string());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let (out, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        let pv = out.as_slice().to_vec();
        println!("EXECUTED cycles={} pv_bytes={} exit_code={}", report.total_instruction_count(), pv.len(), report.exit_code);
        std::fs::create_dir_all("/root/work/prover-host/out").ok();
        std::fs::write("/root/work/prover-host/out/sendunwrap_pv.hex", hex::encode(&pv)).unwrap();
        println!("WROTE out/sendunwrap_pv.hex");
        return;
    }

    let pclient = ProverClient::builder().network().build();
    let pk = pclient.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY = {}", pk.verifying_key().bytes32());
    let cycle_limit: u64 = std::env::var("REFLECT_CYCLE_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000_000_000);
    let gas_limit: u64 = std::env::var("REFLECT_GAS_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000_000_000);
    println!("proving groth16 (network)... cycle_limit={cycle_limit} gas_limit={gas_limit}");
    let proof = pclient.prove(&pk, stdin).groth16().cycle_limit(cycle_limit).gas_limit(gas_limit).run().expect("groth16 proof failed");
    let pv = proof.public_values.as_slice().to_vec();
    println!("PROVED pv_bytes={}", pv.len());
    pclient.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK");
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    proof.save("/root/work/prover-host/out/sendunwrap_groth16.bin").expect("save");
    std::fs::write("/root/work/prover-host/out/sendunwrap_pv.hex", hex::encode(&pv)).unwrap();
    std::fs::write("/root/work/prover-host/out/sendunwrap_proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE out/sendunwrap_groth16.bin + sendunwrap_pv.hex + sendunwrap_proof_bytes.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
