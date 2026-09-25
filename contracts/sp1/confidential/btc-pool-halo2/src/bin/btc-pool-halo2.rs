//! btc-pool-halo2 srs    [--ptau FILE]              convert + check the pinned ptau, write artifacts/params-k13.bin
//! btc-pool-halo2 keygen                            write artifacts/vk.bin and print its digest
//! btc-pool-halo2 prove  INPUT.json [OUT.json]      INPUT = btc-pool-zk.js buildWitness(...).input
//! btc-pool-halo2 check  INPUT.json                 constraint check (MockProver), failures by region
//! btc-pool-halo2 sample pay|partialExit|shield     fixture witness JSON

use btc_pool_halo2::{fixture::Fixture, model::SpendWitness, *};
use std::path::{Path, PathBuf};

fn art(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("artifacts").join(name)
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}

fn read_input(path: &str) -> SpendWitness {
    let s = if path == "-" { std::io::read_to_string(std::io::stdin()).unwrap_or_else(|e| die(e)) } else { std::fs::read_to_string(path).unwrap_or_else(|e| die(e)) };
    let v: serde_json::Value = serde_json::from_str(&s).unwrap_or_else(|e| die(e));
    let v = v.get("input").cloned().unwrap_or(v);
    SpendWitness::from_json(&v).unwrap_or_else(|e| die(e))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("srs") => {
            let ptau = args.iter().position(|a| a == "--ptau").map(|i| PathBuf::from(&args[i + 1])).unwrap_or_else(srs::default_ptau_path);
            let bytes = std::fs::read(&ptau).unwrap_or_else(|e| die(format!("{}: {e}", ptau.display())));
            let h = srs::blake2b_hex(&bytes);
            println!("ptau {} ({} B)\nBLAKE2b-512 {h}", ptau.display(), bytes.len());
            if h != srs::POT18_BLAKE2B {
                die("BLAKE2b does not match the pot18 pin (dapp/circuits/pin-pot18.sh)");
            }
            println!("  matches the pot18 pin");
            let (params, rep) = srs::params_from_ptau(&bytes, K).unwrap_or_else(|e| die(e));
            for c in &rep.checks {
                println!("  ok - {c}");
            }
            let out = srs::write_params(&params);
            std::fs::create_dir_all(art("")).unwrap();
            std::fs::write(art(&format!("params-k{K}.bin")), &out).unwrap();
            println!("wrote artifacts/params-k{K}.bin ({} B), BLAKE2b-512 {}", out.len(), srs::blake2b_hex(&out));
        }
        Some("keygen") => {
            let params = srs::load_or_convert(None).unwrap_or_else(|e| die(e));
            let pk = keygen(&params).unwrap_or_else(|e| die(e));
            let vk = vk_bytes(pk.get_vk());
            std::fs::write(art("vk.bin"), &vk).unwrap();
            println!("wrote artifacts/vk.bin ({} B)\nvk BLAKE2b-512 {}", vk.len(), vk_digest(pk.get_vk()));
        }
        Some("prove") => {
            let w = read_input(args.get(1).map(String::as_str).unwrap_or_else(|| die("prove INPUT.json")));
            let params = srs::load_or_convert(None).unwrap_or_else(|e| die(e));
            let pk = match std::fs::read(art("vk.bin")) {
                Ok(vk) => keygen_with_vk(&params, &vk),
                Err(_) => keygen(&params),
            }
            .unwrap_or_else(|e| die(e));
            let proof = prove(&params, &pk, &w).unwrap_or_else(|e| die(e));
            let doc = serde_json::json!({ "proof": hex::encode(proof), "publics": publics_to_dec(&w.publics()) }).to_string();
            match args.get(2) {
                Some(out) => std::fs::write(out, doc).unwrap(),
                None => println!("{doc}"),
            }
        }
        Some("check") => {
            let w = read_input(args.get(1).map(String::as_str).unwrap_or_else(|| die("check INPUT.json")));
            let fs = failures(&w);
            if fs.is_empty() {
                println!("satisfied");
            } else {
                for f in &fs {
                    println!("{}", f.lines().next().unwrap_or(""));
                }
                std::process::exit(1);
            }
        }
        Some("sample") => {
            let f = Fixture::new();
            let w = match args.get(1).map(String::as_str) {
                Some("partialExit") => f.partial_exit(),
                Some("shield") => f.shield(),
                _ => f.pay(),
            };
            println!("{}", w.to_json());
        }
        _ => die("usage: btc-pool-halo2 srs|keygen|prove|check|sample …"),
    }
}
