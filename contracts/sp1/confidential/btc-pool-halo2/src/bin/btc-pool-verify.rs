//! btc-pool-verify [--params FILE] [--vk FILE] [PROOF.json | -]
//! PROOF.json = {"proof": hex, "publics": [dec; 12]}. Exit 0 valid, 1 invalid, 2 error.
//! Defaults: artifacts/params-k12.bin and artifacts/vk.bin; --expect-vk HEX checks the vk digest first.

use btc_pool_halo2::*;
use std::path::Path;

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opt = |k: &str| args.iter().position(|a| a == k).map(|i| args.get(i + 1).cloned().unwrap_or_else(|| die(format!("{k} needs a value"))));
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("artifacts");
    let params_path = opt("--params").map(Into::into).unwrap_or_else(|| dir.join(format!("params-k{K}.bin")));
    let vk_path = opt("--vk").map(Into::into).unwrap_or_else(|| dir.join("vk.bin"));
    let mut skip = false;
    let file = args
        .iter()
        .find(|a| {
            if skip {
                skip = false;
                return false;
            }
            if a.starts_with("--") {
                skip = true;
                return false;
            }
            true
        })
        .cloned()
        .unwrap_or_else(|| "-".into());
    let params = srs::read_params(&std::fs::read(&params_path).unwrap_or_else(|e| die(format!("{}: {e}", params_path.display())))).unwrap_or_else(|e| die(e));
    let vk = vk_from_bytes(&std::fs::read(&vk_path).unwrap_or_else(|e| die(format!("{}: {e}", vk_path.display())))).unwrap_or_else(|e| die(e));
    if let Some(want) = opt("--expect-vk") {
        if vk_digest(&vk) != want {
            die("vk digest mismatch");
        }
    }
    let s = if file == "-" { std::io::read_to_string(std::io::stdin()).unwrap_or_else(|e| die(e)) } else { std::fs::read_to_string(&file).unwrap_or_else(|e| die(e)) };
    let doc: serde_json::Value = serde_json::from_str(&s).unwrap_or_else(|e| die(e));
    let t = std::time::Instant::now();
    let ok = verify_json(&params, &vk, &doc).unwrap_or_else(|e| die(e));
    eprintln!("{} in {:.1} ms", if ok { "valid" } else { "INVALID" }, t.elapsed().as_secs_f64() * 1e3);
    std::process::exit(if ok { 0 } else { 1 });
}
