// LOCAL execute-mode validator for the OP_CDP_CLOSE settle guest. Runs the locally-built cxfer-guest ELF
// against contracts/sp1/confidential/fixtures/cdp_close_op.json, in the SAME io::read order as the guest's
// OP_CDP_CLOSE arm. A clean execute proves the guest ACCEPTS the witness — the position proves membership
// against cdpPositionRoot, each collateral leg is re-minted as a fresh note (release sigma), and debt notes
// (∈ spendRoot, debt sigma) burn to EXACTLY the position debt — validating the arm + serialization without a
// Groth16 proof. Parity with route/otc/bid/cbtc-mint/cdp-mint/cdp-liquidate/cdp-topup.
//
//   cargo run --release --bin cdp-close-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/cdp_close_op.json";

const OP_CDP_CLOSE: u8 = 16;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header (debt notes prove against spendRoot; the position against cdpPositionRoot) ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&hexv(f["cdpPositionRoot"].as_str().unwrap()));
    s.write(&1u32);          // numOps
    s.write(&OP_CDP_CLOSE);

    // ── OP_CDP_CLOSE body (matches the guest io::read order) ──
    s.write(&hexv(f["controller"].as_str().unwrap())); // r20
    s.write(&hexv(f["owner"].as_str().unwrap()));
    s.write(&f["debtValue"].as_u64().unwrap());
    s.write(&hexv(f["nonce"].as_str().unwrap()));
    s.write(&f["positionIndex"].as_u64().unwrap());
    for p in f["positionPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    let legs = f["legs"].as_array().unwrap();
    s.write(&(legs.len() as u32)); // n_legs (released collateral, re-minted)
    for leg in legs {
        s.write(&hexv(leg["asset"].as_str().unwrap()));
        s.write(&leg["value"].as_u64().unwrap());
        s.write(&hexv(leg["cx"].as_str().unwrap()));
        s.write(&hexv(leg["cy"].as_str().unwrap()));
        s.write(&hexv(leg["sigR"].as_str().unwrap()));
        s.write(&hexv(leg["sigZ"].as_str().unwrap()));
    }
    let debt = f["debt"].as_array().unwrap();
    s.write(&(debt.len() as u32)); // n_debt
    for d in debt {
        s.write(&hexv(d["cx"].as_str().unwrap()));
        s.write(&hexv(d["cy"].as_str().unwrap()));
        s.write(&hexv(d["owner"].as_str().unwrap()));
        s.write(&d["value"].as_u64().unwrap());
        s.write(&d["index"].as_u64().unwrap());
        for p in d["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(d["sigR"].as_str().unwrap()));
        s.write(&hexv(d["sigZ"].as_str().unwrap()));
    }

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the CDP-close witness)");
    let ex = &f["expected"];
    println!(
        "EXECUTE_OK cycles={} pv_bytes={} nullifiers={} leaves={} cdpCloses={}",
        report.total_instruction_count(),
        public_values.as_slice().len(),
        ex["nullifiers"].as_u64().unwrap(),
        ex["leaves"].as_u64().unwrap(),
        ex["cdpCloses"].as_u64().unwrap()
    );
}
