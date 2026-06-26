// LOCAL execute-mode validator for the last three settle arms — OP_ADAPTOR_LOCK(12) / OP_ADAPTOR_REFUND(14) /
// OP_LP_REMOVE(8). Runs the locally-built cxfer-guest ELF (RISC-V emulator on the host — no GPU) against the
// fixtures built by scripts/build-remaining-exec-fixtures.mjs, in the SAME io::read order as main.rs. A clean
// execute proves the guest ACCEPTS each witness (membership + the opening sigmas / conservation kernel + the
// floored LP math), validating the arm + serialization + the JS builder without a Groth16 proof.
//   REM_OP=12|14|8 REM_FIXTURE=<name> cargo run --release --bin remaining-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const DIR: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/";

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn root(f: &serde_json::Value, k: &str) -> Vec<u8> { f.get(k).and_then(|v| v.as_str()).map(hexv).unwrap_or_else(|| vec![0u8; 32]) }

fn main() {
    let op: u8 = std::env::var("REM_OP").expect("REM_OP").parse().unwrap();
    let name = std::env::var("REM_FIXTURE").expect("REM_FIXTURE");
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{DIR}{name}")).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&root(&f, "spendRoot"));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot
    s.write(&root(&f, "lockSetRoot"));
    s.write(&vec![0u8; 32]); // cdpPositionRoot
    s.write(&1u32);
    s.write(&op);

    if op == 12 {
        // OP_ADAPTOR_LOCK
        s.write(&hexv(f["asset"].as_str().unwrap()));
        s.write(&hexv(f["locker"].as_str().unwrap()));
        s.write(&hexv(f["recipient"].as_str().unwrap()));
        s.write(&f["amount"].as_u64().unwrap());
        s.write(&hexv(f["tx"].as_str().unwrap()));
        s.write(&hexv(f["ty"].as_str().unwrap()));
        s.write(&f["deadline"].as_u64().unwrap());
        s.write(&hexv(f["nCx"].as_str().unwrap()));
        s.write(&hexv(f["nCy"].as_str().unwrap()));
        s.write(&f["nIndex"].as_u64().unwrap());
        for p in f["nPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(f["nSigR"].as_str().unwrap()));
        s.write(&hexv(f["nSigZ"].as_str().unwrap()));
        s.write(&hexv(f["lCx"].as_str().unwrap()));
        s.write(&hexv(f["lCy"].as_str().unwrap()));
        s.write(&hexv(f["lSigR"].as_str().unwrap()));
        s.write(&hexv(f["lSigZ"].as_str().unwrap()));
    } else if op == 14 {
        // OP_ADAPTOR_REFUND
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
        s.write(&hexv(f["oCx"].as_str().unwrap()));
        s.write(&hexv(f["oCy"].as_str().unwrap()));
        s.write(&hexv(f["kernelR"].as_str().unwrap()));
        s.write(&hexv(f["kernelS"].as_str().unwrap()));
    } else {
        // OP_LP_REMOVE
        s.write(&hexv(f["assetA"].as_str().unwrap()));
        s.write(&hexv(f["assetB"].as_str().unwrap()));
        s.write(&(f["feeBps"].as_u64().unwrap() as u32));
        s.write(&f["rAPre"].as_u64().unwrap());
        s.write(&f["rBPre"].as_u64().unwrap());
        s.write(&f["sharesPre"].as_u64().unwrap());
        s.write(&hexv(f["sCx"].as_str().unwrap()));
        s.write(&hexv(f["sCy"].as_str().unwrap()));
        s.write(&hexv(f["sOwner"].as_str().unwrap()));
        s.write(&f["sIndex"].as_u64().unwrap());
        for p in f["sPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&f["dShares"].as_u64().unwrap());
        s.write(&hexv(f["sSigR"].as_str().unwrap()));
        s.write(&hexv(f["sSigZ"].as_str().unwrap()));
        s.write(&f["dA"].as_u64().unwrap());
        s.write(&f["remA"].as_u64().unwrap());
        s.write(&f["dB"].as_u64().unwrap());
        s.write(&f["remB"].as_u64().unwrap());
        s.write(&hexv(f["aCx"].as_str().unwrap()));
        s.write(&hexv(f["aCy"].as_str().unwrap()));
        s.write(&hexv(f["aOwner"].as_str().unwrap()));
        s.write(&hexv(f["aSigR"].as_str().unwrap()));
        s.write(&hexv(f["aSigZ"].as_str().unwrap()));
        s.write(&hexv(f["bCx"].as_str().unwrap()));
        s.write(&hexv(f["bCy"].as_str().unwrap()));
        s.write(&hexv(f["bOwner"].as_str().unwrap()));
        s.write(&hexv(f["bSigR"].as_str().unwrap()));
        s.write(&hexv(f["bSigZ"].as_str().unwrap()));
        s.write(&f["opDeadline"].as_u64().unwrap());
    }

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the witness)");
    println!(
        "EXECUTE_OK op={} cycles={} pv_bytes={}",
        op, report.total_instruction_count(), public_values.as_slice().len()
    );
    println!("REMAINING_EXECUTE_OK");
}
