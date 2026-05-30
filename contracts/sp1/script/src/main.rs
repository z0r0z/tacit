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
use sha2::{Sha256, Digest};
use sha3::Keccak256;
use teth_tree::merkle;
use teth_tree::merkle::TREE_DEPTH;
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

// Canonical guest ELF, committed at contracts/sp1/program/elf/. Embedding the
// committed bytes (rather than a per-machine `cargo prove build`) keeps the
// program verification key identical for every prover — SP1 guest builds embed
// absolute paths, so rebuilding elsewhere drifts the vkey and proofs get rejected.
const ELF: &[u8] = include_bytes!("../../program/elf/teth-pool-prover");

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

    // `--keys`: print the two deploy inputs and exit. GROTH16_VK_HASH is the
    // sha256 of the serialized groth16 VK exactly as fed to the guest; the SP1
    // program vkey comes from `cargo prove vkey` on the same ELF.
    if args.contains(&"--keys".to_string()) {
        let vk_bytes = load_groth16_vk();
        println!("GROTH16_VK_HASH=0x{}", hex::encode(Sha256::digest(&vk_bytes)));
        println!("SP1_PROGRAM_VKEY: cargo prove vkey --elf ../program/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/teth-pool-prover");
        return;
    }

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

    // 8-decimal tacit-unit denominations matching the deployed pools:
    // 0.001 / 0.01 / 0.1 / 1 / 10 / 100 ETH = 1e5 / 1e6 / 1e7 / 1e8 / 1e9 / 1e10.
    let denoms_str = env::var("DENOMINATIONS").unwrap_or_else(|_|
        "000186a0,000f4240,00989680,05f5e100,3b9aca00,02540be400".to_string()
    );
    let denominations: Vec<Vec<u8>> = denoms_str.split(',')
        .map(|s| { let mut v = hex::decode(s.trim().trim_start_matches("0x")).expect("denom hex"); while v.len() < 32 { v.insert(0, 0); } v })
        .collect();
    let nd = denominations.len();
    println!("  Denominations: {nd}");

    // ──── Determine previous state from the on-chain verifier ────
    // No local state file: read the verifier's committed state and reconstruct
    // the prev inputs. Supports genesis and the deposit-side regime (pool trees
    // empty, null set empty — deposits are validated via the deposit-root set,
    // not inserted into the pool tree). CXFER (pool tree grows) or withdrawals
    // (null set grows) advance state this path can't yet rebuild — it asserts
    // loudly there until the guest emits its state for persistence.
    let verifier_addr = env_hex_vec("VERIFIER_ADDRESS",
        "3d395b8310d241a1fbb6a544e36dfccdbbc51f5a");
    let vstate = read_verifier_state(&http, &bases_eth, &verifier_addr);

    // Incremental state file: if STATE_FILE is set and the saved state matches
    // the verifier's currently-committed state, the host feeds the full prev
    // state (pool frontiers/next_indices, null set entries, UTXO set) instead
    // of the empty-pools fallback. This is what makes cycle N+1 possible after
    // any activity advanced the verifier past genesis/empty. See
    // ops/prover-incremental-state.md for the full design — the SAVE half
    // (deriving the new ProverState after a successful cycle) lives in either
    // a guest state-emission tail (Option B) or a host-side replay (Option A),
    // both planned in that doc; load is wired here.
    let saved_state = env::var("STATE_FILE").ok().and_then(|p| {
        if std::path::Path::new(&p).exists() {
            println!("  state file: {p}");
            load_prover_state(&p)
        } else {
            None
        }
    });
    let saved_state = saved_state.and_then(|s| {
        // Verify the saved state matches the verifier's committed state. If a
        // reorg or someone-else's-proof advanced the chain since we last saved,
        // the file is stale; fall back to verifier-only reconstruction.
        match &vstate {
            Some((vh, vn, vsh, vlb)) => {
                let computed_pools: [u8; 32] = {
                    let mut c = Vec::with_capacity(32 * nd);
                    for r in &s.pool_roots { c.extend_from_slice(r); }
                    Sha256::digest(&c).into()
                };
                let saved_null: [u8; 32] = s.null_set_hash.clone().try_into().ok()?;
                let saved_lb: [u8; 32] = s.last_block_hash.clone().try_into().ok()?;
                if computed_pools == *vh
                    && saved_null == *vn
                    && s.state_height == *vsh
                    && saved_lb == *vlb
                {
                    println!("  state file matches verifier — using as prev_state");
                    Some(s)
                } else {
                    println!("  state file stale (does not match verifier); ignoring");
                    None
                }
            }
            None => None,
        }
    });

    let empty_tree = merkle::PoseidonTree::new();
    let empty_root = empty_tree.root();
    let empty_frontier = empty_tree.frontier();
    let genesis_pools_hash: [u8; 32] = Sha256::digest(&vec![0u8; 32 * nd]).into();
    let empty_pools_hash: [u8; 32] = {
        let mut c = Vec::with_capacity(32 * nd);
        for _ in 0..nd { c.extend_from_slice(&empty_root); }
        Sha256::digest(&c).into()
    };
    let genesis_anchor = env_hex32("GENESIS_ANCHOR",
        "9adb35bb0996d74cf63498f0b60297ee85e44b18f0347e831f38710515000000");

    let (is_genesis, prev_block_hash, prev_height): (bool, Vec<u8>, u64) = match (&saved_state, &vstate) {
        // Saved state matches verifier — incremental from saved
        (Some(s), Some(_)) => (false, s.last_block_hash.clone(), s.state_height),
        // No saved state, no verifier state — fresh genesis
        (None, None) => (true, genesis_anchor.clone(), 0),
        // Verifier at genesis poolsHash — fresh genesis
        (None, Some((ph, _, _, _))) if *ph == genesis_pools_hash => (true, genesis_anchor.clone(), 0),
        // Verifier advanced past genesis but no saved state — the existing
        // empty-pools-empty-null fallback (deposit-side regime only).
        (None, Some((ph, nh, h, lb))) => {
            assert!(*ph == empty_pools_hash,
                "verifier poolsHash advanced beyond empty trees and no STATE_FILE provided — set STATE_FILE to the persisted prover state (see ops/prover-incremental-state.md) or redeploy from genesis");
            assert!(*nh == [0u8; 32],
                "verifier nullifierSetHash != 0 and no STATE_FILE provided — same recovery: set STATE_FILE or redeploy");
            (false, lb.to_vec(), *h)
        }
    };
    println!("  State: {}", match (&saved_state, is_genesis) {
        (Some(_), _) => "incremental (from STATE_FILE)",
        (None, true) => "genesis",
        (None, false) => "incremental (empty pools/null)",
    });

    // ──── Build SP1 stdin matching guest read order exactly ────
    let mut stdin = SP1Stdin::new();

    // 1. Denomination config
    stdin.write(&(nd as u32));
    for d in &denominations { stdin.write(d); }

    // 2. Per-denomination previous pool state
    for i in 0..nd {
        if let Some(s) = &saved_state {
            stdin.write(&s.pool_roots[i]);
            stdin.write(&s.pool_next_indices[i]);
            for f in &s.pool_frontiers[i] { stdin.write(f); }
        } else if is_genesis {
            stdin.write(&vec![0u8; 32]);
            stdin.write(&0u64);
            for _ in 0..empty_frontier.len() { stdin.write(&vec![0u8; 32]); }
        } else {
            stdin.write(&empty_root.to_vec());
            stdin.write(&0u64);
            for f in &empty_frontier { stdin.write(&f.to_vec()); }
        }
    }

    // 3. Shared previous state. With STATE_FILE: feed the persisted null
    //    set hash + height + nullifier entries + UTXO entries. Without:
    //    empty (deposit-side regime + genesis both work this path).
    if let Some(s) = &saved_state {
        stdin.write(&s.null_set_hash);
        stdin.write(&s.state_height);
        stdin.write(&(s.nullifiers.len() as u64));
        for n in &s.nullifiers { stdin.write(n); }
        stdin.write(&(s.utxo_set.len() as u64));
        for (txid, vout, commit, amount) in &s.utxo_set {
            stdin.write(txid);
            stdin.write(vout);
            stdin.write(commit);
            stdin.write(amount);
        }
    } else {
        stdin.write(&vec![0u8; 32]); // null set hash
        stdin.write(&prev_height);   // state height (read from the verifier)
        stdin.write(&0u64);          // null count
        stdin.write(&0u64);          // utxo count
    }

    // 4. Per-denomination deposit roots — reconstructed from on-chain Deposit
    //    events with the shared tree, self-checked against the mixer.
    let unit_scale = fetch_unit_scale(&http, &bases_eth, &mixer_addr);
    let deploy_block = env::var("DEPLOY_BLOCK").unwrap_or_else(|_| "0x0".to_string());
    for i in 0..nd {
        let pool_id = compute_pool_id(&asset_id, &denominations[i], unit_scale);
        let roots = fetch_deposit_roots_for_pool(&http, &bases_eth, &mixer_addr, &pool_id, &deploy_block);
        stdin.write(&(roots.len() as u32));
        for r in &roots { stdin.write(r); }
        println!("  Deposit roots [denom {i}]: {} (pool 0x{}…)", roots.len(), hex::encode(&pool_id[..6]));
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
    // prev_block_hash: GENESIS_ANCHOR at true genesis, else the verifier's last
    // proven block (read on-chain above) so the proof chains from it.
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

        // Incremental-state save: parse the host-only tail (after the burn
        // claims) into a ProverState + write atomically to STATE_FILE so the
        // next cycle's load path picks it up. The SP1 proof authenticates the
        // entire public_values blob, so this tail is as trustworthy as the
        // on-chain head + tail. See ops/prover-incremental-state.md.
        if let Ok(state_file) = env::var("STATE_FILE") {
            match parse_state_tail(pv, nd, &denominations) {
                Ok((roots, indices, frontiers, null_hash, height, nulls, utxos, last_bh)) => {
                    let state = ProverState {
                        denominations: denominations.clone(),
                        pool_roots: roots,
                        pool_next_indices: indices,
                        pool_frontiers: frontiers,
                        null_set_hash: null_hash,
                        state_height: height,
                        nullifiers: nulls,
                        utxo_set: utxos,
                        last_block_hash: last_bh,
                        state_commitment: pv[429..461].to_vec(), // new_state_commitment offset in head
                    };
                    match save_prover_state(&state_file, &state) {
                        Ok(_) => println!("State persisted to {state_file} ({} null + {} utxo)", state.nullifiers.len(), state.utxo_set.len()),
                        Err(e) => eprintln!("State save failed: {e}"),
                    }
                }
                Err(e) => eprintln!("State tail parse failed: {e} (proof is valid; just no state file update)"),
            }
        }
    }
}

/// Parse the host-only incremental-state tail of the SP1 public values
/// (everything past the burn-claims tail consumed on-chain). Format mirrors
/// the guest emission in program/src/main.rs end-of-main.
#[allow(clippy::type_complexity)]
fn parse_state_tail(
    pv: &[u8],
    nd: usize,
    denominations: &[Vec<u8>],
) -> Result<(Vec<Vec<u8>>, Vec<u64>, Vec<Vec<Vec<u8>>>, Vec<u8>, u64, Vec<Vec<u8>>, Vec<(Vec<u8>, u32, Vec<u8>, u64)>, Vec<u8>), String> {
    // Fixed-head layout (461 bytes).
    if pv.len() < 461 { return Err(format!("pv {} < 461 head", pv.len())); }
    let new_state_height = u64::from_be_bytes(pv[168..176].try_into().unwrap());
    let last_block_hash = pv[333..365].to_vec();
    let new_null_set_hash = pv[136..168].to_vec();

    // Skip the on-chain tail: deposit_accs[nd*32] + counts[nd*4 BE] + claims[sum*32].
    let mut p = 461;
    p += nd * 32; // deposit accs
    if pv.len() < p + nd * 4 { return Err(format!("pv {} < accs+counts {}", pv.len(), p + nd * 4)); }
    let mut total_claims: usize = 0;
    for i in 0..nd {
        let c = u32::from_be_bytes(pv[p + i * 4..p + (i + 1) * 4].try_into().unwrap()) as usize;
        total_claims += c;
    }
    p += nd * 4;
    p += total_claims * 32;

    // Per-pool: root(32) + next_index(8 BE) + TREE_DEPTH frontiers (32 each)
    let per_pool = 32 + 8 + TREE_DEPTH * 32;
    if pv.len() < p + nd * per_pool + 4 { return Err(format!("pv {} too short for pool state {}", pv.len(), p + nd * per_pool + 4)); }
    let mut pool_roots = Vec::with_capacity(nd);
    let mut pool_next_indices = Vec::with_capacity(nd);
    let mut pool_frontiers = Vec::with_capacity(nd);
    for _ in 0..nd {
        pool_roots.push(pv[p..p + 32].to_vec()); p += 32;
        let idx = u64::from_be_bytes(pv[p..p + 8].try_into().unwrap());
        pool_next_indices.push(idx); p += 8;
        let mut frontier = Vec::with_capacity(TREE_DEPTH);
        for _ in 0..TREE_DEPTH { frontier.push(pv[p..p + 32].to_vec()); p += 32; }
        pool_frontiers.push(frontier);
    }

    // null_count(4 BE) + entries
    if p + 4 > pv.len() { return Err("pv truncated before null_count".into()); }
    let null_count = u32::from_be_bytes(pv[p..p + 4].try_into().unwrap()) as usize;
    p += 4;
    if p + null_count * 32 > pv.len() { return Err("pv truncated in null entries".into()); }
    let mut nullifiers = Vec::with_capacity(null_count);
    for _ in 0..null_count { nullifiers.push(pv[p..p + 32].to_vec()); p += 32; }

    // utxo_count(4 BE) + entries
    if p + 4 > pv.len() { return Err("pv truncated before utxo_count".into()); }
    let utxo_count = u32::from_be_bytes(pv[p..p + 4].try_into().unwrap()) as usize;
    p += 4;
    if p + utxo_count * 77 > pv.len() { return Err("pv truncated in utxo entries".into()); }
    let mut utxo_set = Vec::with_capacity(utxo_count);
    for _ in 0..utxo_count {
        let txid = pv[p..p + 32].to_vec(); p += 32;
        let vout = u32::from_be_bytes(pv[p..p + 4].try_into().unwrap()); p += 4;
        let commit = pv[p..p + 33].to_vec(); p += 33;
        let amount = u64::from_be_bytes(pv[p..p + 8].try_into().unwrap()); p += 8;
        utxo_set.push((txid, vout, commit, amount));
    }
    let _ = denominations;
    Ok((pool_roots, pool_next_indices, pool_frontiers, new_null_set_hash, new_state_height, nullifiers, utxo_set, last_block_hash))
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

fn keccak(data: &[u8]) -> [u8; 32] { Keccak256::digest(data).into() }
fn selector(sig: &str) -> String { hex::encode(&keccak(sig.as_bytes())[..4]) }

/// Big-endian byte slice → u128 (low 16 bytes). Deposit denominations and the
/// derived wei amounts fit comfortably in u128.
fn u128_be(b: &[u8]) -> u128 {
    let mut v = 0u128;
    for &x in &b[b.len().saturating_sub(16)..] { v = (v << 8) | x as u128; }
    v
}

fn rpc_post(http: &Client, rpcs: &[String], body: &serde_json::Value) -> Option<serde_json::Value> {
    for rpc in rpcs {
        if let Ok(resp) = http.post(rpc).json(body).timeout(Duration::from_secs(20)).send() {
            if let Ok(j) = resp.json::<serde_json::Value>() {
                if j.get("result").is_some() { return Some(j); }
            }
        }
    }
    None
}

fn eth_call(http: &Client, rpcs: &[String], to_hex: &str, data_hex: &str) -> Option<Vec<u8>> {
    let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"eth_call",
        "params":[{"to": to_hex, "data": data_hex}, "latest"]});
    let j = rpc_post(http, rpcs, &body)?;
    hex::decode(j["result"].as_str()?.trim_start_matches("0x")).ok()
}

// Read the verifier's committed ProvenState: (poolsHash, nullifierSetHash,
// stateHeight, lastBlockHash). currentState() returns the four fields ABI-encoded
// as 32-byte words (height in the low 8 bytes of its word).
fn read_verifier_state(http: &Client, rpcs: &[String], verifier: &[u8]) -> Option<([u8; 32], [u8; 32], u64, [u8; 32])> {
    let to = format!("0x{}", hex::encode(verifier));
    let r = eth_call(http, rpcs, &to, &format!("0x{}", selector("currentState()")))?;
    if r.len() < 128 { return None; }
    Some((
        r[0..32].try_into().ok()?,
        r[32..64].try_into().ok()?,
        u64::from_be_bytes(r[88..96].try_into().ok()?),
        r[96..128].try_into().ok()?,
    ))
}

fn fetch_unit_scale(http: &Client, rpcs: &[String], mixer: &[u8]) -> u128 {
    let to = format!("0x{}", hex::encode(mixer));
    match eth_call(http, rpcs, &to, &format!("0x{}", selector("UNIT_SCALE()"))) {
        Some(r) if r.len() == 32 => { let v = u128_be(&r); if v == 0 { 1 } else { v } }
        _ => 1,
    }
}

/// poolId = keccak256(abi.encode(assetId, denominationWei)); the mixer keys pools
/// by the wei denomination, so scale the 8-decimal tacit denom up by UNIT_SCALE.
fn compute_pool_id(asset_id: &[u8], denom_tacit: &[u8], unit_scale: u128) -> [u8; 32] {
    let wei = u128_be(denom_tacit).checked_mul(unit_scale).expect("denomWei overflow");
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(&asset_id[..32]);
    buf[48..64].copy_from_slice(&wei.to_be_bytes());
    keccak(&buf)
}

/// Reconstruct a pool's deposit tree from its on-chain Deposit events (commitments
/// in leaf order) using the shared tree, returning the root after each insertion —
/// the full set of historically-valid roots a deposit envelope may reference. The
/// result is self-checked against getPoolRoot / getRootAccumulator so missing logs
/// or any divergence fail loudly rather than producing an unprovable batch.
fn fetch_deposit_roots_for_pool(
    http: &Client, rpcs: &[String], mixer: &[u8], pool_id: &[u8; 32], from_block: &str,
) -> Vec<Vec<u8>> {
    let to = format!("0x{}", hex::encode(mixer));
    let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
        "address": to,
        "fromBlock": from_block,
        "toBlock": "latest",
        "topics": [
            format!("0x{}", hex::encode(keccak(b"Deposit(bytes32,bytes32,uint256,uint256)"))),
            format!("0x{}", hex::encode(pool_id)),
        ]
    }]});
    let j = rpc_post(http, rpcs, &body).expect("eth_getLogs failed");
    let logs = j["result"].as_array().cloned().unwrap_or_default();

    // (leafIndex, commitment): leafIndex is the first data word, commitment is topic[2].
    let mut entries: Vec<(u64, [u8; 32])> = Vec::new();
    for log in &logs {
        let topics = match log["topics"].as_array() { Some(t) if t.len() >= 3 => t, _ => continue };
        let commit_hex = topics[2].as_str().unwrap_or("").trim_start_matches("0x");
        let data = hex::decode(log["data"].as_str().unwrap_or("").trim_start_matches("0x")).unwrap_or_default();
        if commit_hex.len() != 64 || data.len() < 32 { continue; }
        let commit: [u8; 32] = hex::decode(commit_hex).unwrap().try_into().unwrap();
        entries.push((u128_be(&data[..32]) as u64, commit));
    }
    entries.sort_by_key(|(idx, _)| *idx);

    let mut tree = merkle::PoseidonTree::new();
    let mut roots: Vec<Vec<u8>> = Vec::with_capacity(entries.len());
    let mut acc = [0u8; 32];
    for (_, commit) in &entries {
        tree.insert(*commit);
        let r = tree.root();
        acc = Sha256::new().chain_update(acc).chain_update(r).finalize().into();
        roots.push(r.to_vec());
    }

    // Self-check: reconstruction must match the mixer's authoritative state.
    let pid = hex::encode(pool_id);
    if !entries.is_empty() {
        let on_root = eth_call(http, rpcs, &to, &format!("0x{}{}", selector("getPoolRoot(bytes32)"), pid)).unwrap_or_default();
        assert!(on_root == tree.root(), "deposit-tree reconstruction != getPoolRoot (pool 0x{}…) — incomplete Deposit logs?", &pid[..8]);
    }
    let mut on_acc = eth_call(http, rpcs, &to, &format!("0x{}{}", selector("getRootAccumulator(bytes32)"), pid)).unwrap_or_default();
    if on_acc.len() != 32 { on_acc = vec![0u8; 32]; }
    assert!(on_acc == acc.to_vec(), "deposit accumulator != getRootAccumulator (pool 0x{}…)", &pid[..8]);

    roots
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

/// Atomic write: serialize → tmp file → rename. A torn write at cycle N+1
/// would make N+2's load see garbage; the rename is atomic on POSIX so we
/// either see the full new state or the full old state.
fn save_prover_state(path: &str, state: &ProverState) -> Result<(), String> {
    if let Some(d) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(d).ok();
    }
    let tmp = format!("{path}.tmp");
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))
}
