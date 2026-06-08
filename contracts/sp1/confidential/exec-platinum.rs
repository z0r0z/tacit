// Execute a SETTLE in improved-platinum mode (bitcoinSpentRoot != 0) to validate the
// in-guest cross-lane non-membership end-to-end — the gold-standard check of the
// guest's witness read order for check_btc_nonmembership. Reads platinum_op.json
// (tests/gen-cxfer-platinum-fixture.mjs): a 2-in/2-out transfer + per-input IMT
// non-membership against the reflected Bitcoin spent-set root.
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/platinum_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&hexv(f["bitcoinSpentRoot"].as_str().unwrap())); // != 0 → cross-lane check on
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0 (transfer-only, no bridge_mint)
    stdin.write(&1u32);
    stdin.write(&1u8); // OP_TRANSFER
    stdin.write(&hexv(f["asset"].as_str().unwrap()));
    let ins = f["inputs"].as_array().unwrap();
    let outs = f["outputs"].as_array().unwrap();
    stdin.write(&(ins.len() as u32));
    stdin.write(&(outs.len() as u32));
    for inp in ins {
        stdin.write(&hexv(inp["cx"].as_str().unwrap()));
        stdin.write(&hexv(inp["cy"].as_str().unwrap()));
        stdin.write(&hexv(inp["owner"].as_str().unwrap()));
        stdin.write(&inp["leafIndex"].as_u64().unwrap());
        for p in inp["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(inp["secret"].as_str().unwrap()));
        let nm = &inp["nonMember"]; // read by check_btc_nonmembership (bitcoinSpentRoot != 0)
        stdin.write(&hexv(nm["lowValue"].as_str().unwrap()));
        stdin.write(&hexv(nm["lowNext"].as_str().unwrap()));
        stdin.write(&nm["lowIndex"].as_u64().unwrap());
        for p in nm["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    }
    for o in outs {
        stdin.write(&hexv(o["cx"].as_str().unwrap()));
        stdin.write(&hexv(o["cy"].as_str().unwrap()));
        stdin.write(&hexv(o["owner"].as_str().unwrap()));
    }
    stdin.write(&hexv(f["rangeProof"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["R"].as_str().unwrap()));
    stdin.write(&hexv(f["kernel"]["z"].as_str().unwrap()));

    let client = ProverClient::builder().cpu().build();
    let (output, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
    println!("PLATINUM_OK cycles={} pv_bytes={}", report.total_instruction_count(), output.as_slice().len());
}
