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
    pool_root: Vec<u8>,
    null_set_hash: Vec<u8>,
    state_height: u64,
    pool_next_index: u64,
    pool_frontier: Vec<Vec<u8>>,
    nullifiers: Vec<Vec<u8>>,
    utxo_set: Vec<(Vec<u8>, u32, Vec<u8>)>,
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
    let denomination = env_hex32("DENOMINATION",
        "00000000000000000000000000000000000000000000000000000000000186a0");

    // ──── Load previous state (genesis if no state file) ────
    let state_dir = env::var("STATE_DIR").unwrap_or_else(|_| ".sp1-state".to_string());
    let state_path = format!("{state_dir}/prover_state.json");
    let prev = load_prover_state(&state_path);
    let is_genesis = prev.is_none();
    println!("  State: {}", if is_genesis { "genesis" } else { "incremental" });

    // ──── Build SP1 stdin matching guest read order exactly ────
    let mut stdin = SP1Stdin::new();

    if let Some(ref st) = prev {
        stdin.write(&st.pool_root);
        stdin.write(&st.null_set_hash);
        stdin.write(&st.state_height);
        stdin.write(&st.pool_next_index);
        for f in &st.pool_frontier { stdin.write(f); }
        stdin.write(&(st.nullifiers.len() as u64));
        for n in &st.nullifiers { stdin.write(n); }
        stdin.write(&(st.utxo_set.len() as u64));
        for (txid, vout, commit) in &st.utxo_set {
            stdin.write(txid); stdin.write(vout); stdin.write(commit);
        }
    } else {
        stdin.write(&vec![0u8; 32]); // prev_pool_root
        stdin.write(&vec![0u8; 32]); // prev_null_set_hash
        stdin.write(&0u64);           // prev_state_height
        stdin.write(&0u64);           // prev_pool_next_index
        for _ in 0..20 { stdin.write(&vec![0u8; 32]); }
        stdin.write(&0u64);           // prev_null_count
        stdin.write(&0u64);           // prev_utxo_count
    }

    let bases_eth = eth_rpc_bases();
    let deposit_roots = fetch_deposit_roots(&http, &bases_eth, &mixer_addr);
    stdin.write(&(deposit_roots.len() as u32));
    for r in &deposit_roots { stdin.write(r); }
    println!("  Deposit roots: {}", deposit_roots.len());

    let vk_bytes = load_groth16_vk();
    stdin.write(&vk_bytes);
    println!("  VK bytes: {}", vk_bytes.len());

    stdin.write(&asset_id);
    stdin.write(&network_tag);
    stdin.write(&chain_id);
    stdin.write(&mixer_addr);
    stdin.write(&denomination);

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
        // Check deposit root accumulator freshness before proving.
        let acc_before = fetch_accumulator(&http, &bases_eth, &mixer_addr);
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

        // Warn if accumulator changed during proving (new deposit invalidates proof).
        let acc_after = fetch_accumulator(&http, &bases_eth, &mixer_addr);
        if acc_before != acc_after {
            eprintln!("WARNING: deposit root accumulator changed during proof generation!");
            eprintln!("  The on-chain verifier will reject this proof. Re-run with updated roots.");
        }

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
    if pv.len() < 104 {
        println!("  (too short to decode: {} bytes)", pv.len());
        return;
    }
    println!("  prev_pool_root:  0x{}", hex::encode(&pv[0..32]));
    println!("  prev_null_root:  0x{}", hex::encode(&pv[32..64]));
    println!("  prev_height:     {}", u64::from_be_bytes(pv[64..72].try_into().unwrap()));
    println!("  prev_block_hash: 0x{}", hex::encode(&pv[72..104]));
    if pv.len() >= 176 {
        println!("  new_pool_root:   0x{}", hex::encode(&pv[104..136]));
        println!("  new_null_root:   0x{}", hex::encode(&pv[136..168]));
        println!("  new_height:      {}", u64::from_be_bytes(pv[168..176].try_into().unwrap()));
    }
    if pv.len() >= 365 {
        println!("  last_block_hash: 0x{}", hex::encode(&pv[333..365]));
    }
    if pv.len() >= 397 {
        println!("  denomination:    0x{}", hex::encode(&pv[365..397]));
    }
    if pv.len() >= 461 {
        println!("  prev_state_cmt: 0x{}", hex::encode(&pv[397..429]));
        println!("  new_state_cmt:  0x{}", hex::encode(&pv[429..461]));
    }
    if pv.len() >= 493 {
        println!("  [dbg] 0x60 seen: {}", u64::from_be_bytes(pv[461..469].try_into().unwrap()));
        println!("  [dbg] root ok:   {}", u64::from_be_bytes(pv[469..477].try_into().unwrap()));
        println!("  [dbg] bind ok:   {}", u64::from_be_bytes(pv[477..485].try_into().unwrap()));
        println!("  [dbg] proof ok:  {}", u64::from_be_bytes(pv[485..493].try_into().unwrap()));
    }
    if pv.len() >= 501 {
        println!("  [dbg] vk ok:     {}", u64::from_be_bytes(pv[493..501].try_into().unwrap()));
    }
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

fn fetch_deposit_roots(http: &Client, eth_rpcs: &[String], mixer_addr: &[u8]) -> Vec<Vec<u8>> {
    let mixer_hex = hex::encode(mixer_addr).to_lowercase();
    let pool_id = env::var("POOL_ID").unwrap_or_else(|_|
        "0c5d21b00bbd6b38d324efe3cd640b5dc9fe6d4d210a2939963009148dd11eef".to_string()
    );
    let pool_id_clean = pool_id.trim_start_matches("0x");
    let deploy_block = env::var("DEPLOY_BLOCK").unwrap_or_else(|_| "0x0".to_string());

    // Fetch Deposit events to count deposits and extract per-deposit roots.
    // Each Deposit event stores the root in `everKnownRoot` and updates `rootAccumulator`.
    // We call `isKnownDepositRoot(poolId, root)` to verify each one.
    let deposit_sig = "0x35a268a90c41b0181a3b58b12063b25c3597e0d085532dfff38eaf88e946c30e";

    for rpc in eth_rpcs {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
            "params": [{
                "address": format!("0x{mixer_hex}"),
                "fromBlock": deploy_block, "toBlock": "latest",
                "topics": [deposit_sig, format!("0x{pool_id_clean}")]
            }]
        });
        let resp = match http.post(rpc).json(&body).timeout(Duration::from_secs(60)).send() {
            Ok(r) => r, Err(e) => { eprintln!("  eth_getLogs failed: {e}"); continue; }
        };
        let json: serde_json::Value = match resp.json() { Ok(j) => j, Err(_) => continue };
        let logs = match json["result"].as_array() { Some(l) => l, None => continue };
        println!("  {} Deposit events on Ethereum", logs.len());
        if logs.is_empty() { return Vec::new(); }

        // We need the Ethereum deposit roots — the Poseidon Merkle roots stored on-chain.
        // The contract doesn't emit the root in events, so we replay the tree.
        // Simpler: call getPoolRoot after each deposit via eth_call at historical blocks.
        // Simplest: pass the root file from DEPOSIT_ROOTS env/file.
        if let Ok(roots_hex) = env::var("DEPOSIT_ROOTS") {
            let roots: Vec<Vec<u8>> = roots_hex.split(',')
                .filter(|s| !s.is_empty())
                .map(|s| hex::decode(s.trim().trim_start_matches("0x")).expect("deposit root hex"))
                .collect();
            println!("  Using {} deposit roots from DEPOSIT_ROOTS env", roots.len());
            return roots;
        }

        // Fallback: call getPoolRoot at current block (only works if no reorgs)
        // keccak256("getPoolRoot(bytes32)") = 0xee59a615
        let sel = "ee59a615";
        let call_body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{"to": format!("0x{mixer_hex}"), "data": format!("0x{sel}{pool_id_clean}")}, "latest"]
        });
        let call_resp = match http.post(rpc).json(&call_body).timeout(Duration::from_secs(15)).send() {
            Ok(r) => r, Err(_) => continue,
        };
        let call_json: serde_json::Value = match call_resp.json() { Ok(j) => j, Err(_) => continue };
        if let Some(root_hex) = call_json["result"].as_str() {
            let root = hex::decode(root_hex.trim_start_matches("0x")).unwrap_or_default();
            if root.len() == 32 && root != vec![0u8; 32] {
                println!("  Using current pool root as single deposit root");
                return vec![root];
            }
        }
        return Vec::new();
    }
    Vec::new()
}

fn fetch_accumulator(http: &Client, eth_rpcs: &[String], mixer_addr: &[u8]) -> Vec<u8> {
    let mixer_hex = hex::encode(mixer_addr).to_lowercase();
    let pool_id = env::var("POOL_ID").unwrap_or_else(|_|
        "0c5d21b00bbd6b38d324efe3cd640b5dc9fe6d4d210a2939963009148dd11eef".to_string()
    );
    let pool_id_clean = pool_id.trim_start_matches("0x");
    let sel = "7b3be964";
    for rpc in eth_rpcs {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{"to": format!("0x{mixer_hex}"), "data": format!("0x{sel}{pool_id_clean}")}, "latest"]
        });
        if let Ok(resp) = http.post(rpc).json(&body).timeout(Duration::from_secs(15)).send() {
            if let Ok(json) = resp.json::<serde_json::Value>() {
                if let Some(hex_str) = json["result"].as_str() {
                    return hex::decode(hex_str.trim_start_matches("0x")).unwrap_or_default();
                }
            }
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


#[allow(dead_code)]
fn save_prover_state(path: &str, state: &ProverState) {
    if let Some(d) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(d).ok();
    }
    let json = serde_json::to_string_pretty(state).expect("serialize state");
    std::fs::write(path, json).expect("write state file");
}
