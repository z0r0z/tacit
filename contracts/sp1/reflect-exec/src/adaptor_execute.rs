// LOCAL execute-mode validator for the OP_ADAPTOR_CLAIM settle guest arm. Runs the locally-built cxfer-guest
// ELF (RISC-V emulator on the host — no GPU) against fixtures/adaptor_claim_op.json, in the SAME io::read order
// as main.rs's OP_ADAPTOR_CLAIM arm. A clean execute proves the guest ACCEPTS the claim witness: L proves
// lock-set membership against lockSetRoot (reconstructing adaptor_lock_leaf pins asset/T/deadline/recipient/
// locker), the output O carries a real opening sigma (tacit-adaptor-claim-out-v1, the locker-griefing fix), and
// the adaptor-completed kernel over (L_C − O_C) conserves value — validating the arm + serialization (and the
// JS kernel/leaf/sigma builder in scripts/build-adaptor-exec-fixture.mjs) without a Groth16 proof.
//
//   cargo run --release --bin adaptor-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/adaptor_claim_op.json";

const OP_ADAPTOR_CLAIM: u8 = 13;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header (the claim proves L against lockSetRoot; the other roots are 0) ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // spendRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&hexv(f["lockSetRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    s.write(&1u32);          // numOps
    s.write(&OP_ADAPTOR_CLAIM);

    // ── OP_ADAPTOR_CLAIM body (matches the guest io::read order) ──
    s.write(&hexv(f["asset"].as_str().unwrap()));
    s.write(&hexv(f["lCx"].as_str().unwrap()));
    s.write(&hexv(f["lCy"].as_str().unwrap()));
    s.write(&hexv(f["tx"].as_str().unwrap()));
    s.write(&hexv(f["ty"].as_str().unwrap()));
    s.write(&f["deadline"].as_u64().unwrap());
    s.write(&hexv(f["recipient"].as_str().unwrap()));
    s.write(&hexv(f["locker"].as_str().unwrap()));
    s.write(&f["lIndex"].as_u64().unwrap());
    for p in f["lPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    s.write(&f["amount"].as_u64().unwrap());
    s.write(&hexv(f["oCx"].as_str().unwrap()));
    s.write(&hexv(f["oCy"].as_str().unwrap()));
    s.write(&hexv(f["oSigR"].as_str().unwrap()));
    s.write(&hexv(f["oSigZ"].as_str().unwrap()));
    s.write(&hexv(f["kernelR"].as_str().unwrap()));
    s.write(&hexv(f["kernelS"].as_str().unwrap()));

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the adaptor-claim witness)");
    let ex = &f["expected"];
    println!(
        "EXECUTE_OK adaptor_claim cycles={} pv_bytes={} lockNullifiers={} leaves={} adaptorClaimS={}",
        report.total_instruction_count(),
        public_values.as_slice().len(),
        ex["lockNullifiers"].as_u64().unwrap(),
        ex["leaves"].as_u64().unwrap(),
        ex["adaptorClaimS"].as_u64().unwrap()
    );
    println!("ADAPTOR_EXECUTE_OK");
}
