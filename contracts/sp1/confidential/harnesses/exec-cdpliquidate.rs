// OP_CDP_LIQUIDATE box harness (not part of the crate build). A keeper seizes an undercollateralized CDP:
// burn the keeper's debt notes (≥ the position debt) and seize the basket to the keeper as PUBLIC
// withdrawals. The guest reproduces the position leaf from its published preimage (owner is public, nonce is
// 0) and proves membership; the controller's onCdpLiquidate reverts if the position is healthy.
// Reads fixtures/cdpliquidate_op.json. stdin order = the guest's OP_CDP_LIQUIDATE io::read (main.rs): header
// roots (spendRoot NON-zero: debt membership; cdpPositionRoot NON-zero: position membership), then
// controller(20) ‖ owner(32) ‖ debtValue(u64) ‖ nonce(32) ‖ rateSnapshot(32) ‖ liquidator(20) ‖
// positionIndex(u64) ‖ positionPath[] ‖ nLegs(u32) ‖ {asset(32) ‖ value(u64)} × nLegs ‖ nDebt(u32) ‖
// {cx(32) ‖ cy(32) ‖ dOwner(32) ‖ value(u64) ‖ index(u64) ‖ path[] ‖ sigR(33) ‖ sigZ(32)} × nDebt.
// NB: liquidate legs are (asset, value) only — the basket is seized as withdrawals, NOT re-minted as notes
// (so no cx/cy/sigma per leg, and no relay fee leg — the keeper profits the over-collateralization spread).
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn u64f(v: &serde_json::Value) -> Option<u64> { v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())) }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/cdpliquidate_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));   // NON-zero: debt-note membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&hexv(f["cdpPositionRoot"].as_str().unwrap())); // NON-zero: position membership
    stdin.write(&1u32);          // numOps
    stdin.write(&17u8);          // OP_CDP_LIQUIDATE
    stdin.write(&hexv(f["controller"].as_str().unwrap()));
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&u64f(&f["debtValue"]).unwrap());
    stdin.write(&hexv(f["nonce"].as_str().unwrap()));
    stdin.write(&hexv(f["rateSnapshot"].as_str().unwrap()));
    stdin.write(&hexv(f["liquidator"].as_str().unwrap()));
    stdin.write(&f["positionIndex"].as_u64().unwrap());
    for p in f["positionPath"].as_array().expect("positionPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    let legs = f["legs"].as_array().expect("legs");
    stdin.write(&(legs.len() as u32));
    stdin.write(&u64f(&f["fee"]).unwrap_or(0)); // relay fee carved from the first seized leg (0 = self-settle)
    for leg in legs {
        stdin.write(&hexv(leg["asset"].as_str().unwrap()));
        stdin.write(&u64f(&leg["value"]).unwrap()); // GROSS seized value; leg 0's withdrawal is net of fee
    }
    let debts = f["debts"].as_array().expect("debts");
    stdin.write(&(debts.len() as u32));
    for d in debts {
        stdin.write(&hexv(d["cx"].as_str().unwrap()));
        stdin.write(&hexv(d["cy"].as_str().unwrap()));
        stdin.write(&hexv(d["owner"].as_str().unwrap()));
        stdin.write(&u64f(&d["value"]).unwrap());
        stdin.write(&d["index"].as_u64().unwrap());
        for p in d["path"].as_array().expect("debt path") { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(d["sigR"].as_str().unwrap()));
        stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} debtValue={}",
            report.total_instruction_count(), pv.as_slice().len(), f["debtValue"]);
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") { assert_eq!(pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(), expect.trim().trim_start_matches("0x").to_lowercase(), "EXPECT_VKEY mismatch"); }
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
