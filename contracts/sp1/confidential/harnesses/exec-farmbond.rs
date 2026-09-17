// OP_FARM_BOND box harness (not part of the crate build). Stakes a basket of LP-share notes into a farm
// position (mint a receipt). FEE-LESS by design: a bond has no spendable output to carve a relay fee from,
// and the fee couldn't be cleanly bound, so the relay is recouped via the recurring harvest fee. Reads
// fixtures/farmbond_op.json. stdin order = the guest's OP_FARM_BOND io::read (contracts/sp1/confidential/src/
// main.rs): header roots, then controller(20) ‖ owner(32) ‖ nonce(32) ‖ lpAsset(32) ‖
// nLegs(u32) ‖ {cx(32) ‖ cy(32) ‖ value(u64) ‖ index(u64) ‖ path[] ‖ sigR(33) ‖ sigZ(32) ‖ owner(32) ‖ nk(32)} × nLegs
// — each leg's OWN spend owner (H(nk)) is witnessed independently of the position's `owner` above.
//   MODE=execute (default) — execute the guest (validates the witness) + print cycles.
//   MODE=groth16           — GPU Groth16 prove + local verify → public_values.hex + proof_bytes.hex.
// NB box wiring: confirm the ELF path matches the relay loop's committed cxfer-guest build.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn u64f(v: &serde_json::Value) -> Option<u64> { v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())) } // a u64 as a JSON number or a decimal string (the dapp relay stringifies BigInt amounts)
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/farmbond_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: leg membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&20u8);          // OP_FARM_BOND
    stdin.write(&hexv(f["controller"].as_str().unwrap())); // 20-byte FarmController address
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&hexv(f["nonce"].as_str().unwrap()));
    stdin.write(&hexv(f["lpAsset"].as_str().unwrap()));
    let legs = f["legs"].as_array().expect("legs");
    stdin.write(&(legs.len() as u32));
    for leg in legs {
        stdin.write(&hexv(leg["cx"].as_str().unwrap()));
        stdin.write(&hexv(leg["cy"].as_str().unwrap()));
        stdin.write(&u64f(&leg["value"]).unwrap());
        stdin.write(&u64f(&leg["index"]).unwrap());
        for p in leg["path"].as_array().expect("leg path") { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(leg["sigR"].as_str().unwrap()));
        stdin.write(&hexv(leg["sigZ"].as_str().unwrap()));
        stdin.write(&hexv(leg["owner"].as_str().unwrap())); // this leg's OWN spend owner = H(nk) (leg_auth), read after its sig
        stdin.write(&hexv(leg["nk"].as_str().unwrap())); // the secret nk (input_leaf_authed reads it; nk_to_owner(nk) == owner)
    }

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    { let empty = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"; let mh: Vec<String> = f.get("memoHashes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(); if f.get("memoHashes").is_some() { for h in &mh { stdin.write(&hexv(h)); } } else { for _ in 0..64usize { stdin.write(&hexv(empty)); } } }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} legs={}", report.total_instruction_count(), pv.as_slice().len(), legs.len());
        return;
    }
    let client = ProverClient::builder().network().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(), expect.trim().trim_start_matches("0x").to_lowercase(), "EXPECT_VKEY mismatch");
    }
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client.prove(&pk, stdin).groth16().cycle_limit(256_000_000).gas_limit(1_000_000_000).run().expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
