// Stage-iii: recursion prove of the Bitcoin reflection guest. Feeds the stage-i eth compressed proof via
// SP1Stdin::write_proof so the guest verify_sp1_proof binds the eth cross-out set (Mode B). Reads the
// Bitcoin scan fixture in reflect.rs io::read order: prior state, THEN eth_pv, THEN anchor/headers/blocks.
// PROOF_MODE=compressed (default, fast recursion validation) | groth16 (on-chain fixture).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey, SP1Proof, SP1ProofWithPublicValues};

const BITCOIN_ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");
const ETH_ELF: &[u8] = include_bytes!("/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection");

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) { s.write(&hexv(v.as_str().unwrap())); }
fn path(s: &mut SP1Stdin, v: &serde_json::Value) { for p in v.as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); } }

fn write_prior(s: &mut SP1Stdin, f: &serde_json::Value) {
    let p = &f["prior"];
    r32(s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    let live = p["live"].as_array().unwrap();
    s.write(&(live.len() as u32));
    // live entry = (key, value, asset). Pre-asset-preservation fixtures only serialize (key,value);
    // supply the known fold asset so read_scan_prior_state gets its triple (a non-conserving cxfer is skipped).
    const LIVE_ASSET: &str = "879cf8e6f26b733497ca1d154ed22c80b2266a5702ed55476a8cd4a3c5e9c4ea";
    for kv in live {
        let t = kv.as_array().unwrap();
        r32(s, &t[0]); r32(s, &t[1]);
        if t.len() > 2 { r32(s, &t[2]); } else { s.write(&hex::decode(LIVE_ASSET).unwrap()); }
    }
    r32(s, &p["burnRoot"]);  s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());
    // cBTC.zk resume state (key, sats-as-32B, asset) + running backing sats — empty for a no-lock batch.
    let cbtc_locks = p["cbtcLocks"].as_array().cloned().unwrap_or_default();
    s.write(&(cbtc_locks.len() as u32));
    for kv in &cbtc_locks { let t = kv.as_array().unwrap(); r32(s, &t[0]); r32(s, &t[1]); r32(s, &t[2]); }
    s.write(&p["cbtcBackingSats"].as_u64().unwrap_or(0));
}

fn write_scan_rest(s: &mut SP1Stdin, f: &serde_json::Value) {
    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for h in headers { s.write(&hexv(h.as_str().unwrap())); }
    for block in f["blocks"].as_array().unwrap() {
        let txs = block["txs"].as_array().unwrap();
        s.write(&(txs.len() as u32));
        for tx in txs { s.write(&hexv(tx["txData"].as_str().unwrap())); }
        for tx in txs {
            for op in tx["openings"].as_array().unwrap() { r32(s, &op["cx"]); r32(s, &op["cy"]); }
            for si in tx["spentInserts"].as_array().unwrap() {
                r32(s, &si["sLowValue"]); r32(s, &si["sLowNext"]); s.write(&si["sLowIndex"].as_u64().unwrap());
                path(s, &si["sLowPath"]); path(s, &si["sNewPath"]);
            }
            if let Some(bi) = tx.get("burnInsert").filter(|v| !v.is_null()) {
                r32(s, &bi["bLowKey"]); r32(s, &bi["bLowNext"]); r32(s, &bi["bLowValue"]); s.write(&bi["bLowIndex"].as_u64().unwrap());
                path(s, &bi["bLowPath"]); path(s, &bi["bNewPath"]);
            }
            for o in tx["outputs"].as_array().unwrap() { path(s, &o["notePath"]); }
        }
    }
}

fn main() {
    let mode = std::env::var("PROOF_MODE").unwrap_or_else(|_| "compressed".into());
    let fx_path = std::env::var("REFLECT_FIXTURE").unwrap_or_else(|_| "/root/work/confidential/fixtures/reflection_input.json".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fx_path).unwrap()).unwrap();

    let eth = SP1ProofWithPublicValues::load("/root/work/prover-host/out/eth_compressed.bin").expect("load eth proof");
    let eth_pv = eth.public_values.as_slice().to_vec();
    assert!(eth_pv.len() >= 288, "eth pv too short");
    let SP1Proof::Compressed(reduce) = eth.proof else { panic!("eth proof not compressed") };

    let mut stdin = SP1Stdin::new();
    write_prior(&mut stdin, &f);
    stdin.write(&eth_pv);
    write_scan_rest(&mut stdin, &f);

    let pclient = ProverClient::builder().cuda().build();
    let eth_pk = pclient.setup(Elf::Static(ETH_ELF)).expect("setup eth");
    println!("eth vkey = {}", eth_pk.verifying_key().bytes32());
    stdin.write_proof(*reduce, eth_pk.verifying_key().vk.clone());

    let bpk = pclient.setup(Elf::Static(BITCOIN_ELF)).expect("setup bitcoin");
    println!("BITCOIN_RELAY_VKEY = {}", bpk.verifying_key().bytes32());
    println!("proving {mode} (cuda)...");
    let proof = if mode == "groth16" {
        pclient.prove(&bpk, stdin).groth16().run().expect("groth16 proof failed")
    } else {
        pclient.prove(&bpk, stdin).compressed().run().expect("compressed proof failed")
    };
    let pv = proof.public_values.as_slice().to_vec();
    println!("PROVED mode={mode} pv_bytes={}", pv.len());
    pclient.verify(&proof, bpk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK");
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    proof.save(format!("/root/work/prover-host/out/bitcoin_{mode}.bin")).expect("save");
    std::fs::write("/root/work/prover-host/out/bitcoin_pv.hex", hex::encode(&pv)).unwrap();
    if mode == "groth16" {
        std::fs::write("/root/work/prover-host/out/bitcoin_proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    }
    println!("WROTE out/bitcoin_{mode}.bin + bitcoin_pv.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
