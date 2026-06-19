// OP_LP_REMOVE box harness — burn a shielded LP-share note, withdraw the proportional reserves as two
// fresh notes. Reads OP_FILE (lp_remove_op.json), proves in the zkVM, verifies locally, writes
// public_values.hex + proof_bytes.hex. MODE=groth16 -> GPU. stdin order = the guest's io::read for an
// OP_LP_REMOVE batch (main.rs): header roots (incl. lock_set_root + cdp_position_root), then op 0 fields.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/confidential/fixtures/lp_remove_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: share-note membership
    stdin.write(&vec![0u8; 32]); // bitcoin_spent_root = 0
    stdin.write(&vec![0u8; 32]); // bitcoin_burn_root = 0
    stdin.write(&vec![0u8; 32]); // lock_set_root = 0
    stdin.write(&vec![0u8; 32]); // cdp_position_root = 0
    stdin.write(&1u32);          // num_ops
    stdin.write(&8u8);           // OP_LP_REMOVE
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32));
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["sharesPre"].as_u64().unwrap());
    let s = &f["share"];
    stdin.write(&hexv(s["cx"].as_str().unwrap()));
    stdin.write(&hexv(s["cy"].as_str().unwrap()));
    stdin.write(&hexv(s["owner"].as_str().unwrap()));
    stdin.write(&s["leafIndex"].as_u64().unwrap());
    for p in s["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&s["dShares"].as_u64().unwrap());
    stdin.write(&hexv(s["sigR"].as_str().unwrap()));
    stdin.write(&hexv(s["sigZ"].as_str().unwrap()));
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
    stdin.write(&f["deadline"].as_u64().unwrap()); // op_deadline (guest reads last)

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
