// LOCAL execute-mode validator for the OP_CDP_TOPUP settle guest. Runs the locally-built cxfer-guest ELF
// against contracts/sp1/confidential/fixtures/cdp_topup_op.json, in the SAME io::read order as the guest's
// OP_CDP_TOPUP arm. A clean execute proves the guest ACCEPTS the witness — the OLD position proves membership
// against cdpPositionRoot, the fresh added-collateral note proves membership against spendRoot + its opening
// sigma (bound to the old position leaf + new nonce), and old+added merge into the replacement position —
// validating the arm + serialization without a Groth16 proof. The controller's health-floor (onCdpTopup) is
// the contract's, not execute. Parity with route/otc/bid/cbtc-mint/cdp-mint/cdp-liquidate.
//
//   cargo run --release --bin cdp-topup-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/cdp_topup_op.json";

const OP_CDP_TOPUP: u8 = 19;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header (added collateral proves against spendRoot; the old position against cdpPositionRoot) ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&hexv(f["cdpPositionRoot"].as_str().unwrap()));
    s.write(&1u32);          // numOps
    s.write(&OP_CDP_TOPUP);

    // ── OP_CDP_TOPUP body (matches the guest io::read order) ──
    s.write(&hexv(f["controller"].as_str().unwrap())); // r20
    s.write(&hexv(f["owner"].as_str().unwrap()));
    s.write(&f["debtValue"].as_u64().unwrap());
    s.write(&hexv(f["oldNonce"].as_str().unwrap()));
    s.write(&hexv(f["newNonce"].as_str().unwrap()));
    s.write(&f["positionIndex"].as_u64().unwrap());
    for p in f["positionPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    let old_legs = f["oldLegs"].as_array().unwrap();
    s.write(&(old_legs.len() as u32)); // n_old_legs
    for leg in old_legs {
        s.write(&hexv(leg["asset"].as_str().unwrap()));
        s.write(&leg["value"].as_u64().unwrap());
    }
    let added = f["addedLegs"].as_array().unwrap();
    s.write(&(added.len() as u32)); // n_added_legs
    for leg in added {
        s.write(&hexv(leg["asset"].as_str().unwrap()));
        s.write(&hexv(leg["cx"].as_str().unwrap()));
        s.write(&hexv(leg["cy"].as_str().unwrap()));
        s.write(&leg["value"].as_u64().unwrap());
        s.write(&leg["index"].as_u64().unwrap());
        for p in leg["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(leg["sigR"].as_str().unwrap()));
        s.write(&hexv(leg["sigZ"].as_str().unwrap()));
    }

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the CDP-topup witness)");
    let ex = &f["expected"];
    println!(
        "EXECUTE_OK cycles={} pv_bytes={} nullifiers={} cdpTopups={}",
        report.total_instruction_count(),
        public_values.as_slice().len(),
        ex["nullifiers"].as_u64().unwrap(),
        ex["cdpTopups"].as_u64().unwrap()
    );
}
