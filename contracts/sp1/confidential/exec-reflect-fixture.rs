// Execute the reflection prover on an indexer-assembled input (reflection_input.json, built by
// tests/gen-reflection-input.mjs via dapp assembleReflectionInput) — validates the assembler
// serializes the guest's io::read order AND the guest verifies a REAL Bitcoin header chain (PoW)
// end-to-end. Effect serialization is included so the same harness drives a full-fold fixture
// once a real CXFER/burn tx is wired.
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) { s.write(&hexv(v.as_str().unwrap())); }
fn path(s: &mut SP1Stdin, v: &serde_json::Value) { for p in v.as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); } }

// The assembled FULL-SCAN input (assembleReflectionScanInput) in the guest's (reflect.rs)
// io::read order: prior (roots + counts + the handed live (key,value,asset) triples), anchorHeight +
// headers, then per block n_tx + ALL txData, then per tx openings → spent inserts → burn insert →
// outputs. Identical to exec-reflect-prove's writer (these box bins don't share a crate).
fn write_stdin(f: &serde_json::Value) -> SP1Stdin {
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
    r32(&mut s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    let live = p["live"].as_array().unwrap();
    s.write(&(live.len() as u32));
    for kv in live { let t = kv.as_array().unwrap(); r32(&mut s, &t[0]); r32(&mut s, &t[1]); r32(&mut s, &t[2]); }
    r32(&mut s, &p["burnRoot"]);  s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());

    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for h in headers { s.write(&hexv(h.as_str().unwrap())); }

    for block in f["blocks"].as_array().unwrap() {
        let txs = block["txs"].as_array().unwrap();
        s.write(&(txs.len() as u32));
        for tx in txs { s.write(&hexv(tx["txData"].as_str().unwrap())); }
        for tx in txs {
            for op in tx["openings"].as_array().unwrap() { r32(&mut s, &op["cx"]); r32(&mut s, &op["cy"]); }
            for si in tx["spentInserts"].as_array().unwrap() {
                r32(&mut s, &si["sLowValue"]); r32(&mut s, &si["sLowNext"]); s.write(&si["sLowIndex"].as_u64().unwrap());
                path(&mut s, &si["sLowPath"]); path(&mut s, &si["sNewPath"]);
            }
            if let Some(bi) = tx.get("burnInsert").filter(|v| !v.is_null()) {
                r32(&mut s, &bi["bLowKey"]); r32(&mut s, &bi["bLowNext"]); r32(&mut s, &bi["bLowValue"]); s.write(&bi["bLowIndex"].as_u64().unwrap());
                path(&mut s, &bi["bLowPath"]); path(&mut s, &bi["bNewPath"]);
            }
            for o in tx["outputs"].as_array().unwrap() {
                // the note leaf is DERIVED in-guest (reflected_note_leaf); only the append path +
                // vout are witnessed.
                path(&mut s, &o["notePath"]); s.write(&(o["vout"].as_u64().unwrap() as u32));
            }
        }
    }
    s
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/reflection_input.json").unwrap()).unwrap();
    let s = write_stdin(&f);

    let client = ProverClient::builder().cpu().build();
    let (out, rep) = client.execute(Elf::Static(ELF), s).run().expect("execute failed");
    println!("REFLECT_FIXTURE_OK cycles={} pv_bytes={}", rep.total_instruction_count(), out.as_slice().len());
    println!("PV={}", hex::encode(out.as_slice()));
}
