// GPU (cuda) Groth16 prover for the reflection guest on the assembled real-CXFER fixture
// (reflection_input.json). Produces BITCOIN_RELAY_VKEY + an on-chain-verifiable proof of the
// reflected Bitcoin state (the input to ConfidentialPool.attestBitcoinStateProven). Needs a
// running sp1-gpu-server (CUDA_VISIBLE_DEVICES=0) + a clean /dev/shm.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey};
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
    r32(&mut s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    r32(&mut s, &p["utxoRoot"]);  s.write(&p["utxoCount"].as_u64().unwrap());
    r32(&mut s, &p["burnRoot"]);  s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());
    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for h in headers { s.write(&hexv(h.as_str().unwrap())); }
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
