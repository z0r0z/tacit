// Execute the full OP_BRIDGE_MINT op loop in the zkVM (no proof) to validate the
// bridge_mint assembler end-to-end on a real BTC→ETH witness — the FULLOP_OK
// equivalent for bridge_mint. Reads bridgemint_op.json (built by
// tests/gen-cxfer-bridgemint-fixture.mjs) and writes the guest's io::read order.
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/bridgemint_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap())); // header: chainBinding
    stdin.write(&vec![0u8; 32]);                              // spendRoot (unused by bridge_mint)
    stdin.write(&1u32);                                       // numOps
    stdin.write(&4u8);                                        // OP_BRIDGE_MINT
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    stdin.write(&hexv(f["header"].as_str().unwrap()));        // Vec<u8> block header
    stdin.write(&hexv(f["tx"].as_str().unwrap()));            // Vec<u8> burn tx
    stdin.write(&(f["txIndex"].as_u64().unwrap() as u32));
    let txids = f["txids"].as_array().unwrap();
    stdin.write(&(txids.len() as u32));
    for t in txids { stdin.write(&hexv(t.as_str().unwrap())); }
    let inp = &f["input"];
    stdin.write(&hexv(inp["cx"].as_str().unwrap()));
    stdin.write(&hexv(inp["cy"].as_str().unwrap()));
    stdin.write(&hexv(inp["owner"].as_str().unwrap()));
    stdin.write(&inp["leafIndex"].as_u64().unwrap());
    for p in inp["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(inp["secret"].as_str().unwrap()));
    let out = &f["output"];
    stdin.write(&hexv(out["cx"].as_str().unwrap()));
    stdin.write(&hexv(out["cy"].as_str().unwrap()));
    stdin.write(&hexv(out["owner"].as_str().unwrap()));
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    let client = ProverClient::builder().cpu().build();
    let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
    println!("BRIDGEMINT_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
    println!("PV={}", hex::encode(output.as_slice()));
}
