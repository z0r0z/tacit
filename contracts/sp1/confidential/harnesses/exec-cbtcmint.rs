// OP_CBTC_MINT box harness (not part of the crate build). Mints a cBTC.zk bearer note against a self-custody
// Bitcoin lock the reflection recorded (real BTC → cBTC). FEE-LESS BY NECESSITY: the note is pinned to the
// lock's PRE-COMMITTED commitment at value v_btc (the 1:1 peg), so it can't carry a fee — the relay routes it
// gaslessly (no user ETH for gas) and the fee rides the FIRST cBTC spend. The contract gates the rest
// (cbtcLock[outpoint].vBtc == v_btc, !cbtcMinted, CollateralEngine escrow sufficient). Reads
// fixtures/cbtcmint_op.json. stdin order = the guest's OP_CBTC_MINT io::read (main.rs): header roots (all 0 —
// the guest does no membership; the contract checks the lock), then outpoint(32) ‖ vBtc(u64) ‖ cx(32) ‖
// cy(32) ‖ sigR(33) ‖ sigZ(32). The note is OWNER-FREE (owner = 0; control is the blinding `r`).
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn u64f(v: &serde_json::Value) -> Option<u64> { v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())) } // accept u64 amount as number OR decimal string (avoids float64 >2^53 loss)
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/cbtcmint_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // spendRoot = 0 (no note-tree membership; the contract gates the lock)
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&18u8);          // OP_CBTC_MINT
    stdin.write(&hexv(f["outpoint"].as_str().unwrap())); // the Bitcoin lock outpoint (anti-replay bind)
    stdin.write(&u64f(&f["vBtc"]).unwrap());
    // relay fee (gasless auto-mint): the note opens to v_btc − fee, the settler is paid `fee` in cBTC. 0 = self-mint.
    stdin.write(&f["fee"].as_u64().or_else(|| f["fee"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0));
    stdin.write(&hexv(f["cx"].as_str().unwrap())); // the cBTC note commitment (pre-committed at lock time, net of fee)
    stdin.write(&hexv(f["cy"].as_str().unwrap()));
    stdin.write(&hexv(f["sigR"].as_str().unwrap()));
    stdin.write(&hexv(f["sigZ"].as_str().unwrap()));

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} vBtc={}", report.total_instruction_count(), pv.as_slice().len(), f["vBtc"]);
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
