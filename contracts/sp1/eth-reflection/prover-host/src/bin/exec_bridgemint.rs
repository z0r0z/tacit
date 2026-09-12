// Claim the OP_BRIDGE_MINT settle for the 1000-TAC bridge deposit now that gen4's reflection has folded
// the burn (attested on-chain at height 966068). Reads bridge-mint_op.json (scratchpad/build-bridge-mint.mjs)
// and writes the settle guest's exact stdin order (main.rs header + one OP_BRIDGE_MINT op).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn path32(s: &mut SP1Stdin, arr: &[serde_json::Value]) {
    assert_eq!(arr.len(), 32, "path must have exactly 32 siblings");
    for p in arr { s.write(&hexv(p.as_str().unwrap())); }
}
fn main() {
    let fx_path = std::env::var("BRIDGEMINT_FIXTURE").unwrap_or_else(|_| "/root/work/confidential/fixtures/bridge_mint_op.json".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fx_path).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();

    // ── settle header (main.rs: chain_binding, spend_root, bitcoin_spent_root, bitcoin_burn_root,
    // lock_set_root, cdp_position_root, num_ops) ──
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spend_root = 0 (no ordinary EVM-note inputs in this batch)
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0 (bridge_mint doesn't use the cross-lane gate)
    stdin.write(&hexv(f["bitcoinBurnRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32); // num_ops

    let op = &f["op"];
    stdin.write(&4u8); // OP_BRIDGE_MINT
    stdin.write(&hexv(op["asset"].as_str().unwrap()));
    stdin.write(&hexv(op["poolRoot"].as_str().unwrap()));
    stdin.write(&hexv(op["inCx"].as_str().unwrap()));
    stdin.write(&hexv(op["inCy"].as_str().unwrap()));
    stdin.write(&hexv(op["inOwner"].as_str().unwrap()));
    stdin.write(&(op["sourceClass"].as_u64().unwrap() as u32));
    stdin.write(&hexv(op["spentTxid"].as_str().unwrap()));
    stdin.write(&(op["spentVout"].as_u64().unwrap() as u32));
    stdin.write(&op["inLeafIndex"].as_u64().unwrap());
    path32(&mut stdin, op["inPath"].as_array().unwrap());
    stdin.write(&hexv(op["outCx"].as_str().unwrap()));
    stdin.write(&hexv(op["outCy"].as_str().unwrap()));
    stdin.write(&hexv(op["outOwner"].as_str().unwrap()));
    stdin.write(&hexv(op["bmNext"].as_str().unwrap()));
    stdin.write(&op["bmIndex"].as_u64().unwrap());
    path32(&mut stdin, op["bmPath"].as_array().unwrap());
    stdin.write(&hexv(op["bpProof"].as_str().unwrap()));
    stdin.write(&op["fee"].as_u64().unwrap());
    stdin.write(&hexv(op["kernelR"].as_str().unwrap()));
    stdin.write(&hexv(op["kernelZ"].as_str().unwrap()));

    // n_memos = leaves.len() + lock_leaves.len() = 1 (the one dest_leaf this op pushed) + 0.
    // Read unconditionally at the end of main() regardless of op type.
    stdin.write(&hexv(f["memoHash"].as_str().unwrap()));

    let mode = std::env::var("PROOF_MODE").unwrap_or_else(|_| "execute".to_string());
    if mode == "execute" {
        let client = if std::env::var("LOCAL_EXECUTE").ok().as_deref() == Some("1") {
            ProverClient::builder().cpu().build()
        } else {
            panic!("execute mode here always uses LOCAL_EXECUTE=1 (cpu)");
        };
        let (out, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        let pv = out.as_slice().to_vec();
        println!("EXECUTED cycles={} pv_bytes={} exit_code={}", report.total_instruction_count(), pv.len(), report.exit_code);
        std::fs::create_dir_all("/root/work/prover-host/out").ok();
        std::fs::write("/root/work/prover-host/out/bridgemint_pv.hex", hex::encode(&pv)).unwrap();
        println!("WROTE out/bridgemint_pv.hex");
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
    proof.save("/root/work/prover-host/out/bridgemint_groth16.bin").expect("save");
    std::fs::write("/root/work/prover-host/out/bridgemint_pv.hex", hex::encode(&pv)).unwrap();
    std::fs::write("/root/work/prover-host/out/bridgemint_proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE out/bridgemint_groth16.bin + bridgemint_pv.hex + bridgemint_proof_bytes.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
