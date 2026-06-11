// LOCAL execute-mode validator for the OP_OTC settle guest. Runs the locally-built cxfer-guest ELF
// (RISC-V emulator on the host — no GPU) against contracts/sp1/confidential/fixtures/otc_op.json,
// using the SAME io::read serialization as the box harness (exec-otc.rs). A clean execute (the guest
// commits PublicValues without panicking) proves the guest ACCEPTS the OTC witness — every
// membership / opening-sigma / conservation assert held in-zkVM — so both the op logic and the byte
// serialization are validated end-to-end without a Groth16 proof.
//
//   cargo run --release --bin otc-execute
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/otc_op.json";

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn write_leg(stdin: &mut SP1Stdin, leg: &serde_json::Value) {
    stdin.write(&hexv(leg["inCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["inCy"].as_str().unwrap()));
    stdin.write(&leg["inLeafIndex"].as_u64().unwrap());
    for p in leg["inPath"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&leg["inAmount"].as_u64().unwrap());
    stdin.write(&hexv(leg["inSigR"].as_str().unwrap()));
    stdin.write(&hexv(leg["inSigZ"].as_str().unwrap()));
    let has_change = leg["hasChange"].as_u64().unwrap() as u8;
    stdin.write(&has_change);
    if has_change == 1 {
        stdin.write(&hexv(leg["changeCx"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeCy"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeSigR"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeSigZ"].as_str().unwrap()));
    }
    stdin.write(&hexv(leg["recvCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvCy"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvSigR"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvSigZ"].as_str().unwrap()));
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&9u8);           // OP_OTC
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&f["vA"].as_u64().unwrap());
    stdin.write(&f["vB"].as_u64().unwrap());
    stdin.write(&hexv(f["makerOwner"].as_str().unwrap()));
    stdin.write(&hexv(f["takerOwner"].as_str().unwrap()));
    write_leg(&mut stdin, &f["maker"]);
    write_leg(&mut stdin, &f["taker"]);

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed (guest rejected the OTC witness)");
    let exp_nu = f["expected"]["nullifiers"].as_array().unwrap().len();
    let exp_lf = f["expected"]["leaves"].as_array().unwrap().len();
    println!("EXECUTE_OK cycles={} pv_bytes={} expected ν={} leaves={}",
        report.total_instruction_count(), public_values.as_slice().len(), exp_nu, exp_lf);
}
