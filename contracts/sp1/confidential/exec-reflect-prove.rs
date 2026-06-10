// GPU (cuda) Groth16 prover for the reflection guest on the assembled real-CXFER fixture
// (reflection_input.json). Produces BITCOIN_RELAY_VKEY + an on-chain-verifiable proof of the
// reflected Bitcoin state (the input to ConfidentialPool.attestBitcoinStateProven). Needs a
// running sp1-gpu-server (CUDA_VISIBLE_DEVICES=0) + a clean /dev/shm.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) { s.write(&hexv(v.as_str().unwrap())); }
fn path(s: &mut SP1Stdin, v: &serde_json::Value) { for p in v.as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); } }

// Write the assembled FULL-SCAN input (assembleReflectionScanInput) to SP1Stdin in the guest's
// (reflect.rs) io::read order. Prior: roots + counts with the HANDED live set (key,value pairs).
// Then anchorHeight + headers. Then per block: n_tx, ALL txData (the guest collects them, then
// recomputes the merkle root for completeness), then per tx the witnesses in scan order —
// openings (read inside scan_tx_spends), spent-set inserts, a burn insert, then outputs.
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
        for tx in txs { s.write(&hexv(tx["txData"].as_str().unwrap())); } // all txData first
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
                // the note leaf is DERIVED in-guest (reflected_note_leaf) from the envelope's
                // asset+commitment — not streamed; only the append path + vout are witnessed.
                path(&mut s, &o["notePath"]); s.write(&(o["vout"].as_u64().unwrap() as u32));
            }
        }
    }
    s
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/reflection_input.json").unwrap()).unwrap();
    let s = write_stdin(&f);

    let client = ProverClient::builder().cuda().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    println!("BITCOIN_RELAY_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, s).groth16().run().expect("groth16 proof failed");
    println!("PROVED pv_bytes={}", proof.public_values.as_slice().len());
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK");
    std::fs::write("/root/work/cxfer/exec/reflect_public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/cxfer/exec/reflect_proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE reflect_public_values.hex + reflect_proof_bytes.hex");
}
