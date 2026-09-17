// OP_STEALTH_CLAIM box harness (not part of the crate build). The recipient claims a stealth lock: prove L ∈
// the lock-set, spend ν_L, mint M to a chosen owner, authorized by a BIP-340 sig under the lock's one-time
// pubkey. Carries an optional relay fee (gasless): M opens to amount − fee, the fee leg pays the settler.
// Reads fixtures/stealthclaim_op.json. stdin order = the guest's OP_STEALTH_CLAIM io::read (main.rs): header
// roots (lockSetRoot NON-zero: L membership; spendRoot 0), then blind(u8) ‖ asset(32) ‖ lCx(32) ‖ lCy(32) ‖
// ownerPub(32) ‖ [amount(u64) if blind == 0] ‖ deadline(u64) ‖ locker(32) ‖ lIndex(u64) ‖ lPath[32] ‖
// mCx(32) ‖ mCy(32) ‖ mOwner(32) ‖ fee(u64) ‖ {blind 1: kernelR(33) ‖ kernelZ(32) ‖ mRange(var) | blind 0:
// mSigR(33) ‖ mSigZ(32)} ‖ ownerSigHi(32) ‖ ownerSigLo(32). blind=1 is the value-hidden user send (L→M+fee
// kernel + a BP+ range on M conserve value + bound the fee without a cleartext amount); blind=0 is the
// amount-bearing AMM protocol-fee skim (leaf-pinned amount, opening sigma on M) — the shape
// dapp/confidential-stealth.js `buildStealthClaimAmount` emits.
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/stealthclaim_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spendRoot = 0 (claim reads the lock-set, not the note tree)
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&hexv(f["lockSetRoot"].as_str().unwrap())); // NON-zero: L lock-set membership
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&24u8);          // OP_STEALTH_CLAIM
    // `blind` selects the leaf form the guest reads (main.rs OP_STEALTH_CLAIM): 1 = the value-hidden user
    // send (kernel + BP+ range on M); 0 = the amount-bearing AMM protocol-fee skim (opening sigma on M, the
    // leaf-pinned `amount` read first). Both end with the BIP-340 owner signature.
    let blind = f.get("blind").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
    let u64_field = |k: &str| -> u64 {
        match &f[k] {
            serde_json::Value::Number(n) => n.as_u64().expect(k),
            serde_json::Value::String(t) => t.parse::<u64>().expect(k),
            _ => panic!("{k}"),
        }
    };
    stdin.write(&blind);
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["lCx"].as_str().unwrap()));
    stdin.write(&hexv(f["lCy"].as_str().unwrap()));
    stdin.write(&hexv(f["ownerPub"].as_str().unwrap()));
    if blind == 0 { stdin.write(&u64_field("amount")); }
    stdin.write(&u64_field("deadline"));
    stdin.write(&hexv(f["locker"].as_str().unwrap()));
    stdin.write(&f["lIndex"].as_u64().unwrap());
    for p in f["lPath"].as_array().expect("lPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["mCx"].as_str().unwrap()));
    stdin.write(&hexv(f["mCy"].as_str().unwrap()));
    stdin.write(&hexv(f["mOwner"].as_str().unwrap()));
    stdin.write(&u64_field("fee"));
    if blind == 1 {
        stdin.write(&hexv(f["kernelR"].as_str().unwrap()));
        stdin.write(&hexv(f["kernelZ"].as_str().unwrap()));
        stdin.write(&hexv(f["mRange"].as_str().unwrap())); // BP+ range on M (Vec<u8> via io::read)
    } else {
        stdin.write(&hexv(f["mSigR"].as_str().unwrap())); // opening sigma on M (33-byte R ‖ 32-byte z)
        stdin.write(&hexv(f["mSigZ"].as_str().unwrap()));
    }
    let sig = hexv(f["ownerSig"].as_str().unwrap()); // 64-byte BIP-340 sig (Rx ‖ s)
    stdin.write(&sig[0..32].to_vec());
    stdin.write(&sig[32..64].to_vec());

    // CP-04: feed keccak256("") memo hashes by default; the guest reads exactly its
    // (leaves+lock_leaves) count. A fixture can supply real ones via "memoHashes" to test non-empty memos.
    {
        let empty = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
        let mh: Vec<String> = f.get("memoHashes").and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        if f.get("memoHashes").is_some() { for h in &mh { stdin.write(&hexv(h)); } } else { for _ in 0..64usize { stdin.write(&hexv(empty)); } }
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().network().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} fee={}", report.total_instruction_count(), pv.as_slice().len(), f["fee"]);
        return;
    }
    let client = ProverClient::builder().network().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") { assert_eq!(pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(), expect.trim().trim_start_matches("0x").to_lowercase(), "EXPECT_VKEY mismatch"); }
    println!("proving groth16 (network, groth16 wrap)...");
    let proof = client.prove(&pk, stdin).groth16().cycle_limit(256_000_000).gas_limit(1_000_000_000).run().expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
