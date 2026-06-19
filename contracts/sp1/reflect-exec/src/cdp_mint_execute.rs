// LOCAL execute-mode validator for the OP_CDP_MINT settle guest. Runs the locally-built cxfer-guest ELF
// (RISC-V emulator on the host — no GPU) against contracts/sp1/confidential/fixtures/cdp_mint_op.json, in the
// SAME io::read order as the guest's OP_CDP_MINT arm (contracts/sp1/confidential/src/main.rs). A clean execute
// (PublicValues committed without a panic) proves the guest ACCEPTS the CDP-mint witness — each collateral
// leg's membership against spendRoot + its opening sigma, and the controller-derived debt note's opening
// sigma — validating the dispatch arm AND its byte serialization without a Groth16 proof. The contract's
// ratio gate (controller.onCdpMint) is NOT in execute (it is the mutable engine's job). Parity with
// route/otc/bid/cbtc-mint.
//
//   cargo run --release --bin cdp-mint-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/cdp_mint_op.json";

const OP_CDP_MINT: u8 = 15;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header (membership uses spendRoot; cdpPositionRoot = 0 — MINT appends, doesn't prove) ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    s.write(&1u32);          // numOps
    s.write(&OP_CDP_MINT);

    // ── OP_CDP_MINT body (matches the guest io::read order) ──
    s.write(&hexv(f["controller"].as_str().unwrap())); // r20
    s.write(&hexv(f["owner"].as_str().unwrap()));
    s.write(&f["debtValue"].as_u64().unwrap());
    s.write(&hexv(f["nonce"].as_str().unwrap()));
    let legs = f["legs"].as_array().unwrap();
    s.write(&(legs.len() as u32)); // n_legs
    for leg in legs {
        s.write(&hexv(leg["asset"].as_str().unwrap()));
        s.write(&hexv(leg["cx"].as_str().unwrap()));
        s.write(&hexv(leg["cy"].as_str().unwrap()));
        s.write(&leg["value"].as_u64().unwrap());
        s.write(&leg["index"].as_u64().unwrap());
        for p in leg["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(leg["sigR"].as_str().unwrap()));
        s.write(&hexv(leg["sigZ"].as_str().unwrap()));
    }
    let debt = &f["debt"];
    s.write(&hexv(debt["cx"].as_str().unwrap()));
    s.write(&hexv(debt["cy"].as_str().unwrap()));
    s.write(&hexv(debt["sigR"].as_str().unwrap()));
    s.write(&hexv(debt["sigZ"].as_str().unwrap()));

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client
        .execute(Elf::Static(ELF), s)
        .run()
        .expect("execute failed (guest rejected the CDP-mint witness)");
    let ex = &f["expected"];
    println!(
        "EXECUTE_OK cycles={} pv_bytes={} nullifiers={} leaves={} cdpMints={}",
        report.total_instruction_count(),
        public_values.as_slice().len(),
        ex["nullifiers"].as_u64().unwrap(),
        ex["leaves"].as_u64().unwrap(),
        ex["cdpMints"].as_u64().unwrap()
    );
}
