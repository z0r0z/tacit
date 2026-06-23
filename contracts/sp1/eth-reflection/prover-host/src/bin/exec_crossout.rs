// crossOut SETTLE (ETH→BTC, OP_BRIDGE_BURN) box harness — round-trip step 1. Reads
// fixtures/crossout_op.json (tests/gen-cxfer-crossout-fixture.mjs): EVM-homed notes burned, emitting
// per-output crossOuts. MODE=execute validates the witness read order + conservation against the guest;
// MODE=groth16 GPU-proves + locally verifies + writes the on-chain artifacts (pv/pb hex) for a settle()
// that sets crossOutCommitment[claimId]. The burned note is EVM-homed (spendRoot is the pool's own EVM
// root), so bitcoinSpentRoot = 0 — no cross-lane non-membership (a btcHomed crossOut is barred).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};
const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("/root/work/confidential/fixtures/crossout_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (EVM-homed crossOut; no cross-lane check)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund; guest header reads it unconditionally — main.rs:139)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    stdin.write(&1u32);          // numOps
    stdin.write(&3u8);           // OP_BRIDGE_BURN
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&(f["destChain"].as_u64().unwrap() as u32)); // dest_chain read as u32 -> u16
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
        stdin.write(&hexv(inp["secret"].as_str().unwrap())); // B3-vestigial; read + discarded by the guest
    }
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("CROSSOUT_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
        return;
    }
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    prover_host::assert_vkey(&pk.verifying_key().bytes32(), "program_vkey"); // fail-closed: abort on vkey drift BEFORE the GPU spend
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write("/root/work/prover-host/out/crossout_pv.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/prover-host/out/crossout_pb.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE crossout_pv.hex + crossout_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
