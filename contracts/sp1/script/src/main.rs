/// SP1 host program: feeds real Bitcoin block data to the tETH pool prover guest.
///
/// Usage:
///   cargo run --release -- --start-height <height> --num-blocks <n> [--execute-only]
///
/// Fetches real Bitcoin signet blocks from mempool.space, feeds all transactions
/// to the SP1 guest, and generates (or executes) the proof.

use sp1_sdk::blocking::prelude::*;
use sp1_sdk::blocking::ProverClient;
use sp1_sdk::ProvingKey as _;
use reqwest::blocking::Client;
use std::env;
use std::time::Duration;
use std::thread;

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

    println!("tETH SP1 Prover");
    println!("  APIs: {:?}", bases);
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

    // ──── Build SP1 stdin matching guest read order exactly ────
    // Guest reads: prev_pool_root, prev_nullifier_root, prev_state_height,
    //   num_deposit_roots, [roots...], vk_bytes, asset_id, network_tag,
    //   chain_id, mixer_address, num_blocks, prev_last_block_hash,
    //   then per-block: header, num_txs, [raw_tx...]
    let mut stdin = SP1Stdin::new();

    // 1-3: prev state (genesis = zeros)
    stdin.write(&vec![0u8; 32]); // prev_pool_root
    stdin.write(&vec![0u8; 32]); // prev_nullifier_root
    stdin.write(&0u64);           // prev_state_height

    // 4: pool tree frontier (genesis = zeros)
    stdin.write(&0u64);           // prev_pool_next_index
    for _ in 0..20 { stdin.write(&vec![0u8; 32]); }

    // 5: nullifier set (genesis = empty)
    stdin.write(&0u64);           // prev_null_count

    // 5b: tETH UTXO set (genesis = empty)
    stdin.write(&0u64);           // prev_utxo_count

    // 6: deposit roots (empty)
    stdin.write(&0u32);

    // 7: Groth16 VK (empty for genesis with no envelopes)
    stdin.write(&Vec::<u8>::new());

    // 8-12: domain binding (read from env or use signet defaults)
    let asset_id = env_hex32("ASSET_ID",
        "d903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b");
    let network_tag: u8 = env::var("NETWORK_TAG").ok()
        .and_then(|v| v.parse().ok()).unwrap_or(0x01);
    let chain_id: u64 = env::var("CHAIN_ID").ok()
        .and_then(|v| v.parse().ok()).unwrap_or(11155111);
    let mixer_addr = env_hex_vec("MIXER_ADDRESS",
        "13124e519c9c11ef200fc4c36ed5a7010750f00e");
    let denomination = env_hex32("DENOMINATION",
        "00000000000000000000000000000000000000000000000000038d7ea4c68000");
    stdin.write(&asset_id);
    stdin.write(&network_tag);
    stdin.write(&chain_id);
    stdin.write(&mixer_addr);
    stdin.write(&denomination);

    // 13: number of blocks
    stdin.write(&(num_blocks as u32));

    // 14: prev_last_block_hash (genesis = zeros)
    stdin.write(&vec![0u8; 32]);

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
        println!("Generating SP1 proof (this may take a while)...");
        let pk = client.setup(elf).expect("setup failed");
        let proof = client.prove(&pk, stdin).compressed().run().expect("proof generation failed");
        println!("Proof generated!");
        println!("  Public values: {} bytes", proof.public_values.as_slice().len());
        print_public_values(proof.public_values.as_slice());

        client.verify(&proof, pk.verifying_key(), None).expect("proof verification failed");
        println!("Proof verified locally!");

        let proof_path = "proof.bin";
        std::fs::write(proof_path, bincode::serialize(&proof).expect("serialize"))
            .expect("write proof");
        println!("Proof saved to {proof_path}");
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
