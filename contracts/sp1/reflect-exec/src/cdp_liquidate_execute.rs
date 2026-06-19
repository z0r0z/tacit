// LOCAL execute-mode validator for the OP_CDP_LIQUIDATE settle guest. Runs the locally-built cxfer-guest ELF
// against contracts/sp1/confidential/fixtures/cdp_liquidate_op.json, in the SAME io::read order as the guest's
// OP_CDP_LIQUIDATE arm. A clean execute proves the guest ACCEPTS the witness — the position leaf reproduced
// from its legs/fields proves membership against cdpPositionRoot, and the basket is seized as withdrawals to
// the controller — validating the arm + serialization without a Groth16 proof. The controller's health-veto
// (onCdpLiquidate) is the contract's, not execute. Parity with route/otc/bid/cbtc-mint/cdp-mint.
//
//   cargo run --release --bin cdp-liquidate-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/cdp_liquidate_op.json";

const OP_CDP_LIQUIDATE: u8 = 17;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header (no note membership; the position proves against cdpPositionRoot) ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // spendRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&hexv(f["cdpPositionRoot"].as_str().unwrap()));
    s.write(&1u32);          // numOps
    s.write(&OP_CDP_LIQUIDATE);

    // ── OP_CDP_LIQUIDATE body (matches the guest io::read order) ──
    s.write(&hexv(f["controller"].as_str().unwrap())); // r20
    s.write(&hexv(f["owner"].as_str().unwrap()));
    s.write(&f["debtValue"].as_u64().unwrap());
    s.write(&hexv(f["nonce"].as_str().unwrap()));
    s.write(&f["positionIndex"].as_u64().unwrap());
    for p in f["positionPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    let legs = f["legs"].as_array().unwrap();
    s.write(&(legs.len() as u32)); // n_legs
    for leg in legs {
        s.write(&hexv(leg["asset"].as_str().unwrap()));
        s.write(&leg["value"].as_u64().unwrap());
    }

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the CDP-liquidate witness)");
    let ex = &f["expected"];
    println!(
        "EXECUTE_OK cycles={} pv_bytes={} withdrawals={} cdpLiquidations={}",
        report.total_instruction_count(),
        public_values.as_slice().len(),
        ex["withdrawals"].as_u64().unwrap(),
        ex["cdpLiquidations"].as_u64().unwrap()
    );
}
