/// SP1 host program: feeds real Bitcoin block data to the tETH pool prover guest.
///
/// Usage:
///   cargo run --release -- --start-height <height> --num-blocks <n> [--execute-only]
///
/// Fetches real Bitcoin signet blocks from mempool.space, feeds all transactions
/// to the SP1 guest, and generates (or executes) the proof.

use sp1_sdk::blocking::prelude::*;
use sp1_sdk::blocking::ProverClient;
use reqwest::blocking::Client;
use std::env;
use std::time::Duration;
use std::thread;

#[derive(serde::Serialize, serde::Deserialize)]
struct ProverState {
    denominations: Vec<Vec<u8>>,
    pool_roots: Vec<Vec<u8>>,
    pool_next_indices: Vec<u64>,
    pool_frontiers: Vec<Vec<Vec<u8>>>,
    null_set_hash: Vec<u8>,
    state_height: u64,
    nullifiers: Vec<Vec<u8>>,
    utxo_set: Vec<(Vec<u8>, u32, Vec<u8>, u64)>,
    last_block_hash: Vec<u8>,
    state_commitment: Vec<u8>,
}

fn load_prover_state(path: &str) -> Option<ProverState> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

const ELF: &[u8] = include_bytes!("../../program/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/teth-pool-prover");

fn api_bases() -> Vec<String> {
    if let Ok(custom) = env::var("API_BASES") {
        return custom.split(',').map(|s| s.trim().to_string()).collect();
    }
    if let Ok(single) = env::var("API_BASE") {
        return vec![single];
    }
    let network = env::var("NETWORK").unwrap_or_else(|_| "signet".to_string());
    match network.as_str() {
        "mainnet" => vec![
            "https://mempool.space/api".to_string(),
            "https://blockstream.info/api".to_string(),
            "https://btcscan.org/api".to_string(),
        ],
        _ => vec![
            "https://mempool.space/signet/api".to_string(),
        ],
    }
}

fn fetch_text(http: &Client, bases: &[String], path: &str) -> String {
    let mut last_err = String::new();
    for base in bases {
        for attempt in 0..3 {
            let url = format!("{base}{path}");
            match http.get(&url).timeout(Duration::from_secs(30)).send() {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(text) = resp.text() { return text; }
                }
                Ok(resp) => { last_err = format!("{url} → {}", resp.status()); }
                Err(e) => { last_err = format!("{url} → {e}"); }
            }
            if attempt < 2 { thread::sleep(Duration::from_secs(2u64 << attempt)); }
        }
    }
    panic!("all providers failed for {path}: {last_err}");
}

fn fetch_bytes(http: &Client, bases: &[String], path: &str) -> Vec<u8> {
    let mut last_err = String::new();
    for base in bases {
        for attempt in 0..3 {
            let url = format!("{base}{path}");
            match http.get(&url).timeout(Duration::from_secs(30)).send() {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(bytes) = resp.bytes() { return bytes.to_vec(); }
                }
                Ok(resp) => { last_err = format!("{url} → {}", resp.status()); }
                Err(e) => { last_err = format!("{url} → {e}"); }
            }
            if attempt < 2 { thread::sleep(Duration::from_secs(2u64 << attempt)); }
        }
    }
    panic!("all providers failed for {path}: {last_err}");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let start_height = parse_arg(&args, "--start-height").unwrap_or(0);
    let num_blocks = parse_arg(&args, "--num-blocks").unwrap_or(1);
    let execute_only = args.contains(&"--execute-only".to_string());
    let bases = api_bases();
    let bases_eth = eth_rpc_bases();

    println!("tETH SP1 Prover");
    println!("  Bitcoin APIs: {:?}", bases);
    println!("  ETH RPC: {:?}", bases_eth);
    println!("  Start height: {start_height}");
    println!("  Blocks: {num_blocks}");
    println!("  Mode: {}", if execute_only { "execute (no proof)" } else { "prove" });

    let http = Client::builder()
        .timeout(Duration::from_secs(60))
        .build().expect("http client");

    // ──── Fetch all block data first ────
    let mut blocks: Vec<(Vec<u8>, Vec<Vec<u8>>)> = Vec::new();

    for h in start_height..start_height + num_blocks {
        println!("\nFetching block {h}...");

        let block_hash = fetch_text(&http, &bases, &format!("/block-height/{h}"));
        println!("  Hash: {block_hash}");

        let header_hex = fetch_text(&http, &bases, &format!("/block/{block_hash}/header"));
        let header = hex::decode(&header_hex).expect("decode header");
        assert_eq!(header.len(), 80, "header must be 80 bytes");

        let txids_json = fetch_text(&http, &bases, &format!("/block/{block_hash}/txids"));
        let txids: Vec<String> = serde_json::from_str(&txids_json).expect("parse txids");
        println!("  Transactions: {}", txids.len());

        let mut raw_txs: Vec<Vec<u8>> = Vec::new();
        for (i, txid) in txids.iter().enumerate() {
            let raw_tx = fetch_bytes(&http, &bases, &format!("/tx/{txid}/raw"));
            if i % 50 == 0 && i > 0 {
                println!("  Fetched {i}/{} txs...", txids.len());
            }
            raw_txs.push(raw_tx);
        }

        blocks.push((header, raw_txs));
    }

    // ──── Domain binding ────
    let asset_id = env_hex32("ASSET_ID",
        "d903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b");
    let network_tag: u8 = env::var("NETWORK_TAG").ok()
        .and_then(|v| v.parse().ok()).unwrap_or(0x01);
    let chain_id: u64 = env::var("CHAIN_ID").ok()
        .and_then(|v| v.parse().ok()).unwrap_or(11155111);
    let mixer_addr = env_hex_vec("MIXER_ADDRESS",
        "13124e519c9c11ef200fc4c36ed5a7010750f00e");

    let denoms_str = env::var("DENOMINATIONS").unwrap_or_else(|_|
        "000186a0,00989680,05f5e100,3b9aca00,2540be400,174876e800".to_string()
    );
    let denominations: Vec<Vec<u8>> = denoms_str.split(',')
        .map(|s| { let mut v = hex::decode(s.trim().trim_start_matches("0x")).expect("denom hex"); while v.len() < 32 { v.insert(0, 0); } v })
        .collect();
    let nd = denominations.len();
    println!("  Denominations: {nd}");

    // ──── Load previous state (genesis if no state file) ────
    let state_dir = env::var("STATE_DIR").unwrap_or_else(|_| ".sp1-state".to_string());
    let state_path = format!("{state_dir}/prover_state.json");
    let prev = load_prover_state(&state_path);
    let is_genesis = prev.is_none();
    println!("  State: {}", if is_genesis { "genesis" } else { "incremental" });

    // ──── Build SP1 stdin matching guest read order exactly ────
    let mut stdin = SP1Stdin::new();

    // 1. Denomination config
    stdin.write(&(nd as u32));
    for d in &denominations { stdin.write(d); }

    // 2. Per-denomination previous pool state
    if let Some(ref st) = prev {
        assert!(st.pool_roots.len() == nd, "state denomination count mismatch");
        for i in 0..nd {
            stdin.write(&st.pool_roots[i]);
            stdin.write(&st.pool_next_indices[i]);
            for f in &st.pool_frontiers[i] { stdin.write(f); }
        }
    } else {
        for _ in 0..nd {
            stdin.write(&vec![0u8; 32]);
            stdin.write(&0u64);
            for _ in 0..20 { stdin.write(&vec![0u8; 32]); }
        }
    }

    // 3. Shared previous state
    if let Some(ref st) = prev {
        stdin.write(&st.null_set_hash);
        stdin.write(&st.state_height);
        stdin.write(&(st.nullifiers.len() as u64));
        for n in &st.nullifiers { stdin.write(n); }
        stdin.write(&(st.utxo_set.len() as u64));
        for (txid, vout, commit, amount) in &st.utxo_set {
            stdin.write(txid); stdin.write(vout); stdin.write(commit); stdin.write(amount);
        }
    } else {
        stdin.write(&vec![0u8; 32]); // null set hash
        stdin.write(&0u64);           // state height
        stdin.write(&0u64);           // null count
        stdin.write(&0u64);           // utxo count
    }

    // 4. Per-denomination deposit roots
    let bases_eth = eth_rpc_bases();
    for i in 0..nd {
        let roots = fetch_deposit_roots_for_denom(&http, &bases_eth, &mixer_addr, &denominations[i]);
        stdin.write(&(roots.len() as u32));
        for r in &roots { stdin.write(r); }
        println!("  Deposit roots [denom {i}]: {}", roots.len());
    }

    // 5. VK + domain binding
    let vk_bytes = load_groth16_vk();
    stdin.write(&vk_bytes);
    println!("  VK bytes: {}", vk_bytes.len());

    stdin.write(&asset_id);
    stdin.write(&network_tag);
    stdin.write(&chain_id);
    stdin.write(&mixer_addr);

    // 6. CXFER witnesses
    let cxfer_witnesses = load_cxfer_witnesses(start_height);
    stdin.write(&(cxfer_witnesses.len() as u32));
    for (block_idx, tx_idx, openings) in &cxfer_witnesses {
        stdin.write(block_idx);
        stdin.write(tx_idx);
        stdin.write(&(openings.len() as u32));
        for (amount, blinding) in openings {
            stdin.write(amount);
            stdin.write(blinding);
        }
    }
    println!("  CXFER witnesses: {}", cxfer_witnesses.len());

    stdin.write(&(num_blocks as u32));
    let prev_block_hash = prev.as_ref()
        .map(|s| s.last_block_hash.clone())
        .unwrap_or_else(|| vec![0u8; 32]);
    stdin.write(&prev_block_hash);

    // 12+: block data
    for (header, raw_txs) in &blocks {
        stdin.write(header);
        stdin.write(&(raw_txs.len() as u32));
        for tx in raw_txs {
            stdin.write(tx);
        }
    }

    println!("\nInitializing SP1 client...");
    let client = ProverClient::from_env();
    let elf = Elf::Static(ELF);

    if execute_only {
        println!("Executing guest program (no proof generation)...");
        let (output, report) = client.execute(elf, stdin).run().expect("execution failed");
        println!("Execution complete!");
        println!("  Cycles: {}", report.total_instruction_count());
        println!("  Public values: {} bytes", output.as_slice().len());
        print_public_values(output.as_slice());
    } else {
        let _ = &bases_eth; // accumulators checked per-denom at submission time
        let onchain = args.contains(&"--onchain".to_string());
        println!("Generating SP1 proof ({})...", if onchain { "groth16 for on-chain" } else { "compressed" });
        let pk = client.setup(elf).expect("setup failed");
        let proof = if onchain {
            client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed")
        } else {
            client.prove(&pk, stdin).compressed().run().expect("compressed proof failed")
        };
        println!("Proof generated!");
        println!("  Public values: {} bytes", proof.public_values.as_slice().len());
        print_public_values(proof.public_values.as_slice());

        // Accumulators are checked on-chain at submission time. If a deposit
        // occurred during proving, the on-chain check will reject the proof.

        client.verify(&proof, pk.verifying_key(), None).expect("proof verification failed");
        println!("Proof verified locally!");

        let proof_path = "proof.bin";
        std::fs::write(proof_path, bincode::serialize(&proof).expect("serialize"))
            .expect("write proof");
        println!("Proof saved to {proof_path}");

        let pv = proof.public_values.as_slice();
        let proof_bytes = proof.bytes();
        let out_dir = env::var("OUTPUT_DIR").unwrap_or_else(|_| ".".to_string());
        std::fs::create_dir_all(&out_dir).ok();
        std::fs::write(format!("{out_dir}/public_values.hex"), hex::encode(pv)).expect("write pv");
        std::fs::write(format!("{out_dir}/proof_bytes.hex"), hex::encode(&proof_bytes)).expect("write proof hex");
        println!("Submission files saved to {out_dir}/");
    }
}

fn print_public_values(pv: &[u8]) {
    if pv.len() < 461 {
        println!("  (unexpected size: {} bytes, expected 461)", pv.len());
        return;
    }
    println!("  prev_pools_hash:   0x{}", hex::encode(&pv[0..32]));
    println!("  prev_null_hash:    0x{}", hex::encode(&pv[32..64]));
    println!("  prev_height:       {}", u64::from_be_bytes(pv[64..72].try_into().unwrap()));
    println!("  prev_block_hash:   0x{}", hex::encode(&pv[72..104]));
    println!("  new_pools_hash:    0x{}", hex::encode(&pv[104..136]));
    println!("  new_null_hash:     0x{}", hex::encode(&pv[136..168]));
    println!("  new_height:        {}", u64::from_be_bytes(pv[168..176].try_into().unwrap()));
    println!("  deposit_accs_hash: 0x{}", hex::encode(&pv[176..208]));
    println!("  burns_hash:        0x{}", hex::encode(&pv[208..240]));
    println!("  vk_hash:           0x{}", hex::encode(&pv[240..272]));
    println!("  asset_id:          0x{}", hex::encode(&pv[272..304]));
    println!("  network_tag:       {}", pv[304]);
    println!("  chain_id:          {}", u64::from_be_bytes(pv[305..313].try_into().unwrap()));
    println!("  mixer_address:     0x{}", hex::encode(&pv[313..333]));
    println!("  last_block_hash:   0x{}", hex::encode(&pv[333..365]));
    println!("  denoms_hash:       0x{}", hex::encode(&pv[365..397]));
    println!("  prev_state_cmt:    0x{}", hex::encode(&pv[397..429]));
    println!("  new_state_cmt:     0x{}", hex::encode(&pv[429..461]));
}

fn parse_arg(args: &[String], flag: &str) -> Option<u64> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)?.parse().ok())
}

fn env_hex32(name: &str, default: &str) -> Vec<u8> {
    let s = env::var(name).unwrap_or_else(|_| default.to_string());
    let s = s.strip_prefix("0x").unwrap_or(&s);
    let mut v = hex::decode(s).expect(&format!("{name} must be valid hex"));
    assert!(v.len() <= 32, "{name} too long");
    while v.len() < 32 { v.insert(0, 0); }
    v
}

fn env_hex_vec(name: &str, default: &str) -> Vec<u8> {
    let s = env::var(name).unwrap_or_else(|_| default.to_string());
    let s = s.strip_prefix("0x").unwrap_or(&s);
    hex::decode(s).expect(&format!("{name} must be valid hex"))
}

fn eth_rpc_bases() -> Vec<String> {
    if let Ok(custom) = env::var("ETH_RPC") {
        return vec![custom];
    }
    let network = env::var("NETWORK").unwrap_or_else(|_| "signet".to_string());
    match network.as_str() {
        "mainnet" => vec!["https://ethereum-rpc.publicnode.com".to_string()],
        _ => vec!["https://ethereum-sepolia-rpc.publicnode.com".to_string()],
    }
}

fn fetch_deposit_roots_for_denom(http: &Client, eth_rpcs: &[String], mixer_addr: &[u8], denom: &[u8]) -> Vec<Vec<u8>> {
    let mixer_hex = hex::encode(mixer_addr).to_lowercase();

    // Per-denomination deposit roots: DEPOSIT_ROOTS_FILE keyed by denom hex,
    // or POOL_IDS env to fetch getPoolRoot for each pool on-chain.
    if let Ok(path) = env::var("DEPOSIT_ROOTS_FILE") {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(all) = serde_json::from_str::<serde_json::Value>(&data) {
                let denom_hex = hex::encode(denom);
                if let Some(roots_arr) = all[&denom_hex].as_array() {
                    return roots_arr.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| hex::decode(s.trim_start_matches("0x")).unwrap_or_default())
                        .filter(|r| r.len() == 32)
                        .collect();
                }
            }
        }
    }

    // Fallback: call getPoolRoot for this denom's pool
    let sel = "ee59a615"; // getPoolRoot(bytes32)
    let pool_ids_env = env::var("POOL_IDS").ok();
    if let Some(ref ids) = pool_ids_env {
        let pool_id_list: Vec<&str> = ids.split(',').collect();
        // Find the pool ID for this denomination by index matching
        // (denominations and pool IDs are ordered the same way)
        for rpc in eth_rpcs {
            for pid in &pool_id_list {
                let pid_clean = pid.trim().trim_start_matches("0x");
                let call_body = serde_json::json!({
                    "jsonrpc": "2.0", "id": 1, "method": "eth_call",
                    "params": [{"to": format!("0x{mixer_hex}"), "data": format!("0x{sel}{pid_clean}")}, "latest"]
                });
                if let Ok(resp) = http.post(rpc).json(&call_body).timeout(Duration::from_secs(15)).send() {
                    if let Ok(json) = resp.json::<serde_json::Value>() {
                        if let Some(root_hex) = json["result"].as_str() {
                            let root = hex::decode(root_hex.trim_start_matches("0x")).unwrap_or_default();
                            if root.len() == 32 && root != vec![0u8; 32] {
                                return vec![root];
                            }
                        }
                    }
                }
            }
            break;
        }
    }
    Vec::new()
}

fn load_groth16_vk() -> Vec<u8> {
    if let Ok(path) = env::var("VK_BIN_PATH") {
        return std::fs::read(&path).expect(&format!("read VK from {path}"));
    }
    if let Ok(path) = env::var("VK_JSON_PATH") {
        let json_str = std::fs::read_to_string(&path).expect(&format!("read VK JSON from {path}"));
        return convert_snarkjs_vk_to_arkworks(&json_str);
    }
    let default_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vk.json");
    if std::path::Path::new(default_path).exists() {
        let json_str = std::fs::read_to_string(default_path).expect("read default vk.json");
        return convert_snarkjs_vk_to_arkworks(&json_str);
    }
    println!("  WARNING: No VK found — Groth16 verification will be skipped");
    Vec::new()
}

fn convert_snarkjs_vk_to_arkworks(json_str: &str) -> Vec<u8> {
    let vk: serde_json::Value = serde_json::from_str(json_str).expect("parse VK JSON");
    let mut buf = Vec::new();
    write_g1_uncompressed(&mut buf, &vk["vk_alpha_1"]);
    write_g2_uncompressed(&mut buf, &vk["vk_beta_2"]);
    write_g2_uncompressed(&mut buf, &vk["vk_gamma_2"]);
    write_g2_uncompressed(&mut buf, &vk["vk_delta_2"]);
    let ic = vk["IC"].as_array().expect("IC array");
    let num_ic = ic.len() as u64;
    buf.extend_from_slice(&num_ic.to_le_bytes());
    for pt in ic {
        write_g1_uncompressed(&mut buf, pt);
    }
    buf
}

fn write_g1_uncompressed(buf: &mut Vec<u8>, pt: &serde_json::Value) {
    let arr = pt.as_array().expect("G1 array");
    let x = arr[0].as_str().expect("G1 x");
    let y = arr[1].as_str().expect("G1 y");
    let is_inf = arr.get(2).and_then(|v| v.as_str()).unwrap_or("1") == "0";
    buf.extend_from_slice(&decimal_to_le_bytes(x));
    let mut y_bytes = decimal_to_le_bytes(y);
    if is_inf { y_bytes[31] |= 1 << 6; }
    buf.extend_from_slice(&y_bytes);
}

fn write_g2_uncompressed(buf: &mut Vec<u8>, pt: &serde_json::Value) {
    let arr = pt.as_array().expect("G2 array");
    let x = arr[0].as_array().expect("G2 x");
    let y = arr[1].as_array().expect("G2 y");
    let infinity = arr.get(2).and_then(|v| v.as_array())
        .map(|a| a[0].as_str().unwrap_or("1") == "0" && a[1].as_str().unwrap_or("0") == "0")
        .unwrap_or(false);
    // snarkJS VK JSON: [[x_c0, x_c1], [y_c0, y_c1]].
    // Arkworks Fq2 uncompressed: c0_le(32) + c1_le(32) for each coordinate.
    // Flags in top bits of last y coordinate byte.
    buf.extend_from_slice(&decimal_to_le_bytes(x[0].as_str().expect("x.c0")));
    buf.extend_from_slice(&decimal_to_le_bytes(x[1].as_str().expect("x.c1")));
    buf.extend_from_slice(&decimal_to_le_bytes(y[0].as_str().expect("y.c0")));
    let mut y_c1 = decimal_to_le_bytes(y[1].as_str().expect("y.c1"));
    if infinity { y_c1[31] |= 1 << 6; }
    buf.extend_from_slice(&y_c1);
}

fn decimal_to_le_bytes(s: &str) -> [u8; 32] {
    let mut n = [0u64; 4];
    let mut val = s.to_string();
    for limb in n.iter_mut() {
        if val.is_empty() || val == "0" { break; }
        let mut rem = 0u128;
        let mut next = String::new();
        for ch in val.chars() {
            rem = rem * 10 + (ch as u128 - '0' as u128);
            if !next.is_empty() || rem / (1u128 << 64) > 0 {
                next.push(char::from_digit((rem / (1u128 << 64)) as u32, 10).unwrap());
            }
            rem %= 1u128 << 64;
        }
        *limb = rem as u64;
        val = if next.is_empty() { "0".to_string() } else { next };
    }
    let mut out = [0u8; 32];
    for (i, limb) in n.iter().enumerate() {
        out[i*8..(i+1)*8].copy_from_slice(&limb.to_le_bytes());
    }
    out
}


/// Load CXFER Pedersen opening witnesses from a JSON file.
/// File format: array of { "block_height": u64, "tx_index": u32, "outputs": [{ "amount": u64, "blinding": "hex32" }] }
/// Heights are converted to block indices relative to start_height.
fn load_cxfer_witnesses(start_height: u64) -> Vec<(u32, u32, Vec<(u64, Vec<u8>)>)> {
    let path = match env::var("CXFER_WITNESSES_PATH") {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(e) => { eprintln!("  CXFER witnesses file {path}: {e}"); return Vec::new(); }
    };
    let entries: Vec<serde_json::Value> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(e) => { eprintln!("  CXFER witnesses parse error: {e}"); return Vec::new(); }
    };
    let mut result = Vec::new();
    for entry in &entries {
        let height = entry["block_height"].as_u64().unwrap_or(0);
        if height < start_height { continue; }
        let block_idx = (height - start_height) as u32;
        let tx_index = entry["tx_index"].as_u64().unwrap_or(0) as u32;
        let outputs = entry["outputs"].as_array();
        let mut openings = Vec::new();
        if let Some(outs) = outputs {
            for o in outs {
                let amount = o["amount"].as_u64().unwrap_or(0);
                let blinding_hex = o["blinding"].as_str().unwrap_or("");
                let blinding = hex::decode(blinding_hex.trim_start_matches("0x")).unwrap_or_default();
                if blinding.len() == 32 {
                    openings.push((amount, blinding));
                }
            }
        }
        if !openings.is_empty() {
            result.push((block_idx, tx_index, openings));
        }
    }
    result
}

// Write counterpart to load_prover_state. Wiring this into the prove path
// (reconstructing ProverState from the new committed state) enables incremental
// proving across batches — currently each run re-derives from the state file.
#[allow(dead_code)]
fn save_prover_state(path: &str, state: &ProverState) {
    if let Some(d) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(d).ok();
    }
    let json = serde_json::to_string_pretty(state).expect("serialize state");
    std::fs::write(path, json).expect("write state file");
}
