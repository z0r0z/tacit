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
fn h(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) { s.write(&hexv(v[k].as_str().unwrap())); }
fn u32w(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) { s.write(&(v[k].as_u64().unwrap() as u32)); }

// TAC burn-DEPOSIT witness — written in reflect.rs's read order for a 0x2B burn of a non-live-set note:
// etchTx, etchIndex, etchSiblings, provHeaders, cxfers[{txid, inputs[{prevTxid,prevVout,commitment}],
// outputs[{commitment,vout}], rangeProof, kernelSig, merkleSiblings, merkleIndex, confirmedBlockRoot}],
// burnedCx, burnedCy, then ONE spent insert + ONE burn insert (the burned note's ν + dest).
fn write_burn_deposit(s: &mut SP1Stdin, bd: &serde_json::Value) {
    h(s, bd, "etchTx");
    u32w(s, bd, "etchIndex");
    let esib = bd["etchSiblings"].as_array().unwrap();
    s.write(&(esib.len() as u32));
    for x in esib { s.write(&hexv(x.as_str().unwrap())); }
    let phs = bd["provHeaders"].as_array().unwrap();
    s.write(&(phs.len() as u32));
    for hh in phs { s.write(&hexv(hh.as_str().unwrap())); }
    let cxfers = bd["cxfers"].as_array().unwrap();
    s.write(&(cxfers.len() as u32));
    for c in cxfers {
        h(s, c, "txid");
        let ins = c["inputs"].as_array().unwrap();
        s.write(&(ins.len() as u32));
        for i in ins { h(s, i, "prevTxid"); u32w(s, i, "prevVout"); h(s, i, "commitment"); }
        let outs = c["outputs"].as_array().unwrap();
        s.write(&(outs.len() as u32));
        for o in outs { h(s, o, "commitment"); u32w(s, o, "vout"); }
        s.write(&c["burnedAmount"].as_u64().unwrap_or(0)); // 0 for a transfer, > 0 for a CBURN step
        h(s, c, "rangeProof");
        h(s, c, "kernelSig");
        let msib = c["merkleSiblings"].as_array().unwrap();
        s.write(&(msib.len() as u32));
        for x in msib { s.write(&hexv(x.as_str().unwrap())); }
        u32w(s, c, "merkleIndex");
        h(s, c, "confirmedBlockRoot");
    }
    // mintable: issuer-authorized cmints (reveal tx + commit tx + reveal merkle inclusion). Empty for fixed.
    let cmints = bd.get("cmints").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
    s.write(&(cmints.len() as u32));
    for cm in cmints {
        h(s, cm, "revealTx");
        h(s, cm, "commitTx");
        let msib = cm["merkleSiblings"].as_array().unwrap();
        s.write(&(msib.len() as u32));
        for x in msib { s.write(&hexv(x.as_str().unwrap())); }
        u32w(s, cm, "merkleIndex");
    }
    h(s, bd, "burnedCx");
    h(s, bd, "burnedCy");
    let si = &bd["spentInsert"];
    r32(s, &si["sLowValue"]); r32(s, &si["sLowNext"]); s.write(&si["sLowIndex"].as_u64().unwrap());
    path(s, &si["sLowPath"]); path(s, &si["sNewPath"]);
    let bi = &bd["burnInsert"];
    r32(s, &bi["bLowKey"]); r32(s, &bi["bLowNext"]); r32(s, &bi["bLowValue"]); s.write(&bi["bLowIndex"].as_u64().unwrap());
    path(s, &bi["bLowPath"]); path(s, &bi["bNewPath"]);
    path(s, &bd["notePath"]); // the burned note's pool-tree append path (onboard it as a pool member)
}

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
    // cBTC.zk resume state (guest reads it after height): the live self-custody locks (key,sats,asset)
    // triples + the running backing sats. Tolerant of priors that omit it (empty set, 0 sats).
    let cbtc = p.get("cbtcLocks").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
    s.write(&(cbtc.len() as u32));
    for kv in cbtc { let t = kv.as_array().unwrap(); r32(&mut s, &t[0]); r32(&mut s, &t[1]); r32(&mut s, &t[2]); }
    s.write(&p.get("cbtcBackingSats").and_then(|v| v.as_u64()).unwrap_or(0));

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
            if let Some(bd) = tx.get("burnDeposit").filter(|v| !v.is_null()) {
                write_burn_deposit(&mut s, bd);
            } else if let Some(bi) = tx.get("burnInsert").filter(|v| !v.is_null()) {
                r32(&mut s, &bi["bLowKey"]); r32(&mut s, &bi["bLowNext"]); r32(&mut s, &bi["bLowValue"]); s.write(&bi["bLowIndex"].as_u64().unwrap());
                path(&mut s, &bi["bLowPath"]); path(&mut s, &bi["bNewPath"]);
            }
            for o in tx["outputs"].as_array().unwrap() {
                // the note leaf AND its outpoint vout are DERIVED in-guest (reflected_note_leaf; vout =
                // the output's commitment index); only the append path is witnessed.
                path(&mut s, &o["notePath"]);
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
