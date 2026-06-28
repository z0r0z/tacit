// LOCAL execute-mode validator for the OP_BID settle guest. Serializes fixtures/bid_op.json in the
// guest's io::read order (same as exec-bid.rs) and executes the locally-built cxfer-guest ELF — a
// clean run (no panic) proves the guest ACCEPTS the bid witness (grid/range, every funding/buyer/
// seller opening, refund + change, conservation held in-zkVM), validating the op logic and the byte
// serialization without a GPU proof.
//
//   cargo run --release --bin bid-execute
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/bid_op.json";

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn note(stdin: &mut SP1Stdin, n: &serde_json::Value) {
    stdin.write(&hexv(n["cx"].as_str().unwrap()));
    stdin.write(&hexv(n["cy"].as_str().unwrap()));
}
fn sig(stdin: &mut SP1Stdin, n: &serde_json::Value) {
    stdin.write(&hexv(n["sigR"].as_str().unwrap()));
    stdin.write(&hexv(n["sigZ"].as_str().unwrap()));
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    s.write(&1u32);          // numOps
    s.write(&10u8);          // OP_BID
    s.write(&hexv(f["assetA"].as_str().unwrap()));
    s.write(&hexv(f["assetB"].as_str().unwrap()));
    s.write(&f["minFill"].as_u64().unwrap());
    s.write(&f["maxFill"].as_u64().unwrap());
    s.write(&f["price"].as_u64().unwrap());
    s.write(&f["increment"].as_u64().unwrap());
    s.write(&hexv(f["buyerOwner"].as_str().unwrap()));
    // funding note (asset_b): cx, cy, leaf_index, path, sig
    let fund = &f["fund"];
    note(&mut s, fund);
    s.write(&fund["leafIndex"].as_u64().unwrap());
    for p in fund["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    sig(&mut s, fund);
    // chosen fill + buyer received-A
    let chosen_f = f["chosenF"].as_u64().unwrap();
    s.write(&chosen_f);
    note(&mut s, &f["buyerRecvA"]);
    sig(&mut s, &f["buyerRecvA"]);
    // refund (present iff chosen_f < max_fill)
    if chosen_f < f["maxFill"].as_u64().unwrap() {
        let r = &f["refund"];
        note(&mut s, r);
        sig(&mut s, r);
    }
    // seller input (asset_a): cx, cy, owner, leaf_index, path, amount, sig
    let si = &f["sellerIn"];
    note(&mut s, si);
    s.write(&hexv(f["sellerOwner"].as_str().unwrap()));
    s.write(&si["leafIndex"].as_u64().unwrap());
    for p in si["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    s.write(&si["amount"].as_u64().unwrap());
    sig(&mut s, si);
    // seller change
    let has_change = f["sellerHasChange"].as_u64().unwrap() as u8;
    s.write(&has_change);
    if has_change == 1 { note(&mut s, &f["sellerChange"]); sig(&mut s, &f["sellerChange"]); }
    // seller received-B (pay)
    note(&mut s, &f["sellerRecvB"]);
    sig(&mut s, &f["sellerRecvB"]);
    s.write(&f["deadline"].as_u64().unwrap_or(0)); // op_deadline (guest main.rs:917), last read in OP_BID
    s.write(&f.get("fee").and_then(|v| v.as_u64()).unwrap_or(0)); // seller relay fee (guest reads after deadline)

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client.execute(Elf::Static(ELF), s).run().expect("execute failed (guest rejected the BID witness)");
    assert_eq!(report.exit_code, 0, "guest REJECTED the witness (exit_code = {})", report.exit_code);
    let exp_nu = f["expected"]["nullifiers"].as_array().unwrap().len();
    let exp_lf = f["expected"]["leaves"].as_array().unwrap().len();
    println!("EXECUTE_OK cycles={} pv_bytes={} expected ν={} leaves={}",
        report.total_instruction_count(), public_values.as_slice().len(), exp_nu, exp_lf);
}
