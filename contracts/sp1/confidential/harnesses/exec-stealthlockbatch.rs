// OP_STEALTH_LOCK *batch* box harness (not part of the crate build). One proof that locks N notes into the
// SHARED lock-set under N recipients' one-time stealth pubkeys — the airdrop path (N recipients in one settle
// instead of N proofs). The guest already loops `for _ in 0..num_ops` reading an op byte per iteration
// (main.rs), so this is exactly exec-stealthlock.rs's single-op block written numOps times against ONE shared
// header. All locks share chainBinding + spendRoot (one proof, one pre-state root); each APPENDS to the lock-set
// (lockSetRoot 0 — no membership read) and spends its funding note's nullifier. Lock ops emit NO note leaf, so
// settle carries an EMPTY memos[]; the stealth memos travel in the airdrop's published bundle, not on-chain.
// Reads fixtures/stealthlockbatch_op.json = { chainBinding, spendRoot, ops: [ { asset, locker, ownerPub,
// deadline, nCx, nCy, nIndex, nPath, lCx, lCy, kernelR, kernelZ }, ... ] }. Value-hidden: each block's
// N→L kernel conserves value and binds the blind lock leaf — no amount, no opening sigmas.
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/stealthlockbatch_op.json".to_string())).unwrap()).unwrap();
    let ops = f["ops"].as_array().expect("ops array");
    assert!(!ops.is_empty(), "stealthlockbatch: empty ops");
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: N membership (shared pre-state root)
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (locks append; no membership read)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&(ops.len() as u32)); // numOps = N
    for o in ops {
        stdin.write(&23u8); // OP_STEALTH_LOCK
        stdin.write(&hexv(o["asset"].as_str().unwrap()));
        stdin.write(&hexv(o["locker"].as_str().unwrap()));
        stdin.write(&hexv(o["ownerPub"].as_str().unwrap())); // recipient one-time stealth x-only pubkey
        stdin.write(&o["deadline"].as_u64().unwrap());
        stdin.write(&hexv(o["nCx"].as_str().unwrap()));
        stdin.write(&hexv(o["nCy"].as_str().unwrap()));
        stdin.write(&o["nIndex"].as_u64().unwrap());
        for p in o["nPath"].as_array().expect("nPath") { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(o["lCx"].as_str().unwrap()));
        stdin.write(&hexv(o["lCy"].as_str().unwrap()));
        stdin.write(&hexv(o["kernelR"].as_str().unwrap()));
        stdin.write(&hexv(o["kernelZ"].as_str().unwrap()));
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} num_ops={}", report.total_instruction_count(), pv.as_slice().len(), ops.len());
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") { assert_eq!(pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(), expect.trim().trim_start_matches("0x").to_lowercase(), "EXPECT_VKEY mismatch"); }
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
