//! tac-oracle-host: a TacProvenOracle proof from an Ethereum node.
//!
//!   input   --venues A,B | --oracle O  [--rpc NODES] [--proof-rpc NODES] [--anchor N | --lag N] [--count C]
//!           [--points S,W,M (shorter windows, for test inputs)] --dir D
//!           fetches the headers and proofs, runs the program natively, writes D/input.bin, D/pv.hex, D/answers.json
//!   execute --elf ELF --dir D     runs the program in SP1's executor on D/input.bin; checks it commits D/pv.hex
//!   prove   --elf ELF --dir D     a Groth16 proof (SP1_PROVER=cpu|cuda|network), written to D/proof.json
//!   vkey    --elf ELF             the program's verification key
//!
//! D/proof.json holds `publicValues` and `proof` exactly as TacProvenOracle.record takes them (the proof without SP1's
//! selector, exit code and vk root, which the oracle has folded in).

mod fetch;
mod rpc;

use alloy_primitives::{Address, U256};
use serde_json::json;
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1Stdin};
use std::collections::HashMap;
use std::path::PathBuf;
use tac_oracle_core::{public_values, unpack, Input};

const HEAD_NODES: &str = "https://ethereum-rpc.publicnode.com,https://rpc.mevblocker.io";
const PROOF_NODES: &str = "https://rpc.mevblocker.io,https://eth-mainnet.public.blastapi.io,https://1.rpc.thirdweb.com";
// SP1 v6.1.0's Groth16 vk root, which TacProvenOracle folds in.
const VK_ROOT: &str = "002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352";

fn args() -> (String, HashMap<String, String>) {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_default();
    let mut m = HashMap::new();
    while let Some(k) = it.next() {
        let v = it.next().unwrap_or_else(|| panic!("{k} needs a value"));
        m.insert(k.trim_start_matches("--").to_string(), v);
    }
    (cmd, m)
}

fn elf(m: &HashMap<String, String>) -> &'static [u8] {
    let p = m.get("elf").expect("--elf");
    Box::leak(std::fs::read(p).expect("read elf").into_boxed_slice())
}

fn dir(m: &HashMap<String, String>) -> PathBuf {
    let d = PathBuf::from(m.get("dir").expect("--dir"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn read_input(d: &PathBuf) -> Input {
    bincode::deserialize(&std::fs::read(d.join("input.bin")).expect("input.bin")).expect("input.bin")
}

fn stdin(input: &Input) -> SP1Stdin {
    let mut s = SP1Stdin::new();
    s.write(input);
    s
}

// The head and words decoded, for reading.
fn answers(pv: &[u8]) -> serde_json::Value {
    let word = |i: usize| U256::from_be_slice(&pv[32 * i..32 * i + 32]);
    let f = |w: U256, at: usize, m: usize, bits: usize| unpack((w >> at) & ((U256::from(1) << bits) - U256::from(1)), m);
    let head = word(1);
    let x = (head & U256::from(u32::MAX)).to::<u64>();
    let count = ((head >> 64usize) & U256::from(0xff)).to::<u64>();
    let mut ns = Vec::new();
    for j in 0..count as usize {
        let w = word(2 + j);
        let win = |k: usize| {
            json!({"low": f(w, 84 * k, 20, 28).to_string(), "high": f(w, 84 * k + 28, 20, 28).to_string(), "recovery": f(w, 84 * k + 56, 20, 28).to_string()})
        };
        ns.push(json!({"N": x - 1 + j as u64, "short": win(0), "window": win(1), "max": win(2)}));
    }
    json!({
        "bound": format!("0x{}", hex::encode(&pv[..32])),
        "x": x,
        "count": count,
        "latest": f(head, 72, 24, 32).to_string(),
        "depthAtXMinus1": f(head, 104, 24, 32).to_string(),
        "depthAtX": f(head, 136, 24, 32).to_string(),
        "anchor": ((head >> 168usize) & U256::from(u32::MAX)).to::<u64>(),
        "answers": ns,
    })
}

fn main() {
    let (cmd, m) = args();
    match cmd.as_str() {
        "input" => {
            let heads = rpc::Rpc::new(m.get("rpc").map_or(HEAD_NODES, String::as_str));
            let proofs = rpc::Rpc::new(m.get("proof-rpc").map_or(PROOF_NODES, String::as_str));
            let config = if let Some(o) = m.get("oracle") {
                fetch::config_from_oracle(&heads, o.parse::<Address>().expect("--oracle")).expect("config")
            } else {
                let v: Vec<Address> =
                    m.get("venues").expect("--venues or --oracle").split(',').map(|s| s.parse().expect("venue")).collect();
                fetch::config_from_venues(&heads, v[0], v[1]).expect("config")
            };
            // Shorter windows, for a small test input from real blocks (its public values fit no deployed oracle).
            let config = match m.get("points") {
                Some(p) => {
                    let p: Vec<u64> = p.split(',').map(|s| s.parse().expect("--points short,window,max")).collect();
                    tac_oracle_core::Config { short_points: p[0], window_points: p[1], max_points: p[2], ..config }
                }
                None => config,
            };
            eprintln!("config {} (CONFIG {})", serde_json::to_string(&config).unwrap(), config.digest());
            let anchor = match m.get("anchor") {
                Some(a) => a.parse().expect("--anchor"),
                None => {
                    let head = heads.call("eth_blockNumber", json!([])).expect("head");
                    let head = u64::from_str_radix(head.as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
                    head - m.get("lag").map_or(2, |l| l.parse().expect("--lag"))
                }
            };
            let count = m.get("count").map_or(5, |c| c.parse().expect("--count"));
            let t = std::time::Instant::now();
            let input = fetch::input(&heads, &proofs, config, anchor, count, true).expect("input");
            eprintln!("fetched in {:?}", t.elapsed());
            let pv = public_values(&input).expect("the input does not prove");
            let d = dir(&m);
            std::fs::write(d.join("input.bin"), bincode::serialize(&input).unwrap()).unwrap();
            std::fs::write(d.join("pv.hex"), hex::encode(&pv)).unwrap();
            let a = answers(&pv);
            std::fs::write(d.join("answers.json"), serde_json::to_string_pretty(&a).unwrap()).unwrap();
            println!("{}", serde_json::to_string_pretty(&a).unwrap());
        }
        "execute" => {
            let d = dir(&m);
            let input = read_input(&d);
            let want = std::fs::read_to_string(d.join("pv.hex")).expect("pv.hex");
            let client = ProverClient::builder().mock().build();
            let t = std::time::Instant::now();
            let (pv, report) = client.execute(Elf::Static(elf(&m)), stdin(&input)).run().expect("execute failed");
            let got = hex::encode(pv.as_slice());
            println!("{report}");
            println!(
                "EXECUTE cycles={} in {:?}; public values {}",
                report.total_instruction_count(),
                t.elapsed(),
                if got == want.trim() { "match the native run" } else { "DIFFER from the native run" }
            );
            assert_eq!(got, want.trim(), "the zkVM and the native run differ");
        }
        "prove" => {
            let d = dir(&m);
            let input = read_input(&d);
            let e = elf(&m);
            let mode = std::env::var("SP1_PROVER").unwrap_or_else(|_| "cpu".into());
            macro_rules! prove {
                ($client:expr) => {{
                    let client = $client;
                    let pk = client.setup(Elf::Static(e)).expect("setup");
                    let vkey = pk.verifying_key().bytes32();
                    let p = client.prove(&pk, stdin(&input)).groth16().run().expect("groth16 proof failed");
                    let out = (vkey, p.bytes(), p.public_values.as_slice().to_vec());
                    // The GPU client's key and session release themselves on a Tokio runtime this blocking host does
                    // not run; the process ends right after, so they are left to it.
                    std::mem::forget(pk);
                    std::mem::forget(client);
                    out
                }};
            }
            let (vkey, bytes, pv): (String, Vec<u8>, Vec<u8>) = match mode.as_str() {
                #[cfg(feature = "cuda")]
                "cuda" => prove!(ProverClient::builder().cuda().build()),
                "network" => prove!(ProverClient::builder().network().build()),
                _ => prove!(ProverClient::builder().cpu().build()),
            };
            assert_eq!(bytes.len(), 4 + 32 * 11, "a Groth16 proof is a selector and eleven words");
            assert!(bytes[4..36].iter().all(|b| *b == 0), "exit code 0");
            assert_eq!(hex::encode(&bytes[36..68]), VK_ROOT, "the v6.1.0 circuit");
            let out = json!({
                "vkey": vkey,
                "publicValues": format!("0x{}", hex::encode(&pv)),
                "proof": format!("0x{}", hex::encode(&bytes[68..])),
                "proofBytes": format!("0x{}", hex::encode(&bytes)),
            });
            std::fs::write(d.join("proof.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
        }
        "vkey" => {
            let client = ProverClient::builder().mock().build();
            let pk = client.setup(Elf::Static(elf(&m))).expect("setup");
            println!("{}", pk.verifying_key().bytes32());
        }
        _ => {
            eprintln!("usage: tac-oracle-host input|execute|prove|vkey (see the header of src/main.rs)");
            std::process::exit(2);
        }
    }
}
