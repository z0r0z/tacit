// OP_BRIDGE_BURN box harness — burn EVM notes into Bitcoin destination crossOuts (ETH→BTC source side).
// Reads OP_FILE (bridgeburn_op.json), proves the op in the zkVM, verifies locally, writes
// public_values.hex + proof_bytes.hex. MODE=groth16 -> GPU. stdin order = the guest's io::read for an
// OP_BRIDGE_BURN batch (main.rs): header roots (incl. lock_set_root + cdp_position_root), then op 0 fields.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/confidential/fixtures/bridgeburn_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: membership
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0 (EVM-homed burn)
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32);          // num_ops
    stdin.write(&3u8);           // OP_BRIDGE_BURN
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&(f["destChain"].as_u64().unwrap() as u32)); // dest_chain (read as u32)
    let ins = f["inputs"].as_array().unwrap();
    let outs = f["outputs"].as_array().unwrap();
    stdin.write(&(ins.len() as u32)); // n_in
    stdin.write(&(outs.len() as u32)); // m_out
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
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "compressed".into());
    if mode != "groth16" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let proof = client.prove(&pk, stdin).compressed().run().expect("compressed proof failed");
        client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
        std::fs::write("/root/work/cxfer/exec/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
        println!("LOCAL_VERIFY_OK (compressed)");
        return;
    }
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK groth16 pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("/root/work/cxfer/exec/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/cxfer/exec/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
