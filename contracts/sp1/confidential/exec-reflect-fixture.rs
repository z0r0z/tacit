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

fn write_spend(s: &mut SP1Stdin, sp: &serde_json::Value) {
    r32(s, &sp["cx"]); r32(s, &sp["cy"]); r32(s, &sp["outpoint"]);
    r32(s, &sp["sLowValue"]); r32(s, &sp["sLowNext"]); s.write(&sp["sLowIndex"].as_u64().unwrap());
    path(s, &sp["sLowPath"]); path(s, &sp["sNewPath"]);
    r32(s, &sp["uNodeNext"]); r32(s, &sp["uNodeValue"]); s.write(&sp["uNodeIndex"].as_u64().unwrap()); path(s, &sp["uNodePath"]);
    r32(s, &sp["uPredKey"]); r32(s, &sp["uPredValue"]); s.write(&sp["uPredIndex"].as_u64().unwrap()); path(s, &sp["uPredPath"]);
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/reflection_input.json").unwrap()).unwrap();
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
    // prior reflection state (the resume anchor)
    r32(&mut s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    r32(&mut s, &p["utxoRoot"]);  s.write(&p["utxoCount"].as_u64().unwrap());
    r32(&mut s, &p["burnRoot"]);  s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());
    // anchor height + the header chain
    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for h in headers { s.write(&hexv(h.as_str().unwrap())); }
    // effects
    let effects = f["effects"].as_array().unwrap();
    s.write(&(effects.len() as u32));
    for e in effects {
        let op = e["op"].as_u64().unwrap() as u8;
        s.write(&op);
        s.write(&(e["blockIndex"].as_u64().unwrap() as u32));
        s.write(&hexv(e["txData"].as_str().unwrap()));
        s.write(&(e["txIndex"].as_u64().unwrap() as u32));
        let txids = e["txids"].as_array().unwrap();
        s.write(&(txids.len() as u32));
        for t in txids { s.write(&hexv(t.as_str().unwrap())); }
        if op == 0 {
            let spends = e["spends"].as_array().unwrap();
            let outputs = e["outputs"].as_array().unwrap();
            s.write(&(spends.len() as u32));
            s.write(&(outputs.len() as u32));
            for sp in spends { write_spend(&mut s, sp); }
            for o in outputs {
                r32(&mut s, &o["noteLeaf"]); path(&mut s, &o["notePath"]); r32(&mut s, &o["outpoint"]); r32(&mut s, &o["commitmentHash"]);
                r32(&mut s, &o["uLowKey"]); r32(&mut s, &o["uLowNext"]); r32(&mut s, &o["uLowValue"]); s.write(&o["uLowIndex"].as_u64().unwrap()); path(&mut s, &o["uLowPath"]);
                path(&mut s, &o["uNewPath"]);
                s.write(&(o["vout"].as_u64().unwrap() as u32));
            }
        } else {
            let b = &e["burn"];
            write_spend(&mut s, &b["spend"]);
            r32(&mut s, &b["bLowKey"]); r32(&mut s, &b["bLowNext"]); r32(&mut s, &b["bLowValue"]); s.write(&b["bLowIndex"].as_u64().unwrap());
            path(&mut s, &b["bLowPath"]); path(&mut s, &b["bNewPath"]);
        }
    }

    let client = ProverClient::builder().cpu().build();
    let (out, rep) = client.execute(Elf::Static(ELF), s).run().expect("execute failed");
    println!("REFLECT_FIXTURE_OK cycles={} pv_bytes={}", rep.total_instruction_count(), out.as_slice().len());
    println!("PV={}", hex::encode(out.as_slice()));
}
