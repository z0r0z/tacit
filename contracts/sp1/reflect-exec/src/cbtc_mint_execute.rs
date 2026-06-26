// LOCAL execute-mode validator for the OP_CBTC_MINT settle guest. Runs the locally-built cxfer-guest ELF
// (RISC-V emulator on the host — no GPU) against contracts/sp1/confidential/fixtures/cbtc_mint_op.json, in
// the SAME io::read order as the guest's OP_CBTC_MINT arm (contracts/sp1/confidential/src/main.rs). A clean
// execute (PublicValues committed without a panic) proves the guest ACCEPTS the cBTC-mint witness — the
// bearer note's opening sigma binds it to exactly v_btc under the cBTC-mint intent context — so the dispatch
// arm AND its byte serialization are validated end-to-end without a Groth16 proof. Parity with route/otc/bid.
//
//   cargo run --release --bin cbtc-mint-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/cbtc_mint_op.json";

const OP_CBTC_MINT: u8 = 18;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header (cBTC mint uses no membership/cross-lane/lock/cdp roots) ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // spendRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    s.write(&1u32);          // numOps
    s.write(&OP_CBTC_MINT);

    // ── OP_CBTC_MINT body (matches the guest io::read order) ──
    s.write(&hexv(f["outpoint"].as_str().unwrap()));
    s.write(&f["vBtc"].as_u64().unwrap());
    s.write(&hexv(f["cx"].as_str().unwrap()));
    s.write(&hexv(f["cy"].as_str().unwrap()));
    s.write(&hexv(f["sigR"].as_str().unwrap()));
    s.write(&hexv(f["sigZ"].as_str().unwrap()));

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the cBTC-mint witness)");
    let ex = &f["expected"];
    println!(
        "EXECUTE_OK cycles={} pv_bytes={} expected leaves={} cbtcMints={}",
        report.total_instruction_count(),
        public_values.as_slice().len(),
        ex["leaves"].as_u64().unwrap(),
        ex["cbtcMints"].as_u64().unwrap()
    );
}
