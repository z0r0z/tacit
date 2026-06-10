// LOCAL execute-mode validator for the full-scan reflection guest. Runs the locally-built
// reflection-prover ELF (RISC-V emulator on the host — no GPU) against an assembled
// reflection_input.json, using the SAME write_stdin serialization as the box harnesses
// (exec-reflect-{prove,fixture}.rs), and checks the guest commits the assembler's newDigest. This
// closes the witness-stream contract loop: assembleReflectionScanInput → write_stdin → guest.
//
//   cargo run --release --bin reflect-execute -- <reflection_input.json> [expectedNewDigest]
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};

// The PINNED canonical reflection ELF (elf-vkey-pin.json bitcoin_relay_vkey), NOT a local rebuild —
// so this validates the exact box-built guest a deploy runs, free of ELF drift.
const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/elf/reflection-prover");

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) { s.write(&hexv(v.as_str().unwrap())); }
fn path(s: &mut SP1Stdin, v: &serde_json::Value) { for p in v.as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); } }

// Identical to the box harnesses' write_stdin (the guest's io::read order).
fn write_stdin(f: &serde_json::Value) -> SP1Stdin {
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
    r32(&mut s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    let live = p["live"].as_array().unwrap();
    s.write(&(live.len() as u32));
    for kv in live { let pair = kv.as_array().unwrap(); r32(&mut s, &pair[0]); r32(&mut s, &pair[1]); }
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
                path(&mut s, &o["notePath"]); s.write(&(o["vout"].as_u64().unwrap() as u32));
            }
        }
    }
    s
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input_path = args.get(1).cloned().unwrap_or_else(|| "/Users/z/tacit/contracts/sp1/confidential/fixtures/reflection_input.json".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();
    let expected_new_digest = args.get(2).cloned().or_else(|| f["newDigest"].as_str().map(|s| s.to_string()));

    let s = write_stdin(&f);
    let client = ProverClient::builder().cpu().build();
    let (out, rep) = client.execute(Elf::Static(ELF), s).run().expect("execute failed");
    let pv = out.as_slice();
    println!("EXECUTE_OK cycles={} pv_bytes={}", rep.total_instruction_count(), pv.len());

    // BitcoinReflectionPublicValues = 8 abi words: [0]priorDigest [1]poolRoot [2]spentRoot
    // [3]burnRoot [4]height(u64) [5]newDigest [6]prevHash [7]tipHash.
    assert!(pv.len() >= 256, "public values too short");
    let field = |i: usize| format!("0x{}", hex::encode(&pv[i * 32..i * 32 + 32]));
    println!("priorDigest = {}", field(0));
    println!("poolRoot    = {}", field(1));
    println!("spentRoot   = {}", field(2));
    println!("burnRoot    = {}", field(3));
    println!("height      = {}", u64::from_be_bytes(pv[160 - 8..160].try_into().unwrap()));
    let new_digest = field(5);
    println!("newDigest   = {}", new_digest);
    println!("prevHash    = {}", field(6));
    println!("tipHash     = {}", field(7));

    if let Some(exp) = expected_new_digest {
        let exp = exp.to_lowercase();
        if new_digest == exp {
            println!("DIGEST_MATCH (guest newDigest == assembler newDigest)");
        } else {
            println!("DIGEST_MISMATCH expected={} got={}", exp, new_digest);
            std::process::exit(1);
        }
    }
}
