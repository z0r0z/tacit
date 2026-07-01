// LOCAL execute-mode validator for the OP_SWAP_ROUTE settle guest. Runs the locally-built cxfer-guest ELF
// (RISC-V emulator on the host — no GPU) against contracts/sp1/confidential/fixtures/route_op.json, in the
// SAME io::read order as the guest's OP_SWAP_ROUTE arm (contracts/sp1/confidential/src/main.rs). A clean
// execute (PublicValues committed without a panic) proves the guest ACCEPTS the route witness — input
// membership, both opening sigmas, per-hop get_amount_out + orientation + constant-product non-decrease,
// the final min_out, and one SwapSettlement per hop — so the dispatch arm AND its byte serialization are
// validated end-to-end without a Groth16 proof.
//
//   cargo run --release --bin route-execute
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const FIXTURE: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/route_op.json";

const OP_SWAP_ROUTE: u8 = 11;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let mut s = SP1Stdin::new();
    // ── batch header ──
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    s.write(&1u32);          // numOps
    s.write(&OP_SWAP_ROUTE);

    // ── OP_SWAP_ROUTE body (matches the guest io::read order) ──
    let inp = &f["in"];
    s.write(&hexv(f["asset0"].as_str().unwrap()));
    s.write(&hexv(inp["cx"].as_str().unwrap()));
    s.write(&hexv(inp["cy"].as_str().unwrap()));
    s.write(&hexv(inp["owner"].as_str().unwrap()));
    s.write(&inp["leafIndex"].as_u64().unwrap());
    for p in inp["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
    s.write(&f["amountIn"].as_u64().unwrap());
    s.write(&f.get("fee").and_then(|v| v.as_u64()).unwrap_or(0)); // input-asset relay fee (guest reads BEFORE the input sigma)
    s.write(&hexv(inp["sigR"].as_str().unwrap()));
    s.write(&hexv(inp["sigZ"].as_str().unwrap()));

    let hops = f["hops"].as_array().unwrap();
    s.write(&(hops.len() as u32)); // n_hops
    s.write(&f["minOut"].as_u64().unwrap());

    let out = &f["out"];
    s.write(&hexv(out["cx"].as_str().unwrap()));
    s.write(&hexv(out["cy"].as_str().unwrap()));
    s.write(&hexv(out["owner"].as_str().unwrap()));
    s.write(&hexv(out["sigR"].as_str().unwrap()));
    s.write(&hexv(out["sigZ"].as_str().unwrap()));
    s.write(&f["deadline"].as_u64().unwrap_or(0)); // op_deadline (0 = no expiry)

    // ── per-hop reserves (read inside the hop loop, after the deadline) ──
    for h in hops {
        s.write(&hexv(h["assetNext"].as_str().unwrap()));
        s.write(&(h["feeBps"].as_u64().unwrap() as u32));
        s.write(&h["reserveAPre"].as_u64().unwrap());
        s.write(&h["reserveBPre"].as_u64().unwrap());
    }

    let client = ProverClient::builder().cpu().build();
    let (public_values, report) = client.execute(Elf::Static(ELF), s).run().expect("execute failed (guest rejected the ROUTE witness)");
    assert_eq!(report.exit_code, 0, "guest REJECTED the witness (exit_code = {})", report.exit_code);
    let ex = &f["expected"];
    println!("EXECUTE_OK cycles={} pv_bytes={} expected nu={} leaves={} swaps={} amountOut={}",
        report.total_instruction_count(), public_values.as_slice().len(),
        ex["nullifiers"].as_u64().unwrap(), ex["leaves"].as_u64().unwrap(),
        ex["swaps"].as_u64().unwrap(), ex["amountOut"].as_u64().unwrap());
}
