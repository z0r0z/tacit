//! tacit-block-gpu: proves Tacit blocks on this machine's GPU (SP1's CUDA prover) and prints how long each
//! stage takes, as JSON lines.
//!
//! tacit-block-gpu ELF FILE... [--groth16]   FILE is a block's stdin as `tacit-block dump` writes it. Per FILE:
//! execute (cycles and prover gas), the compressed proof (the block proof), and with --groth16 the Groth16
//! wrap a landing contract verifies. Every proof is verified, and its public values compared with the
//! execution's, before its time is printed.

use serde_json::json;
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1Stdin};
use std::time::Instant;

fn fail(msg: &str) -> ! {
    eprintln!("tacit-block-gpu: {msg}");
    std::process::exit(2)
}

/// u32 LE count, then each buffer as a u32 LE length and its bytes.
fn read_bufs(path: &str) -> Vec<Vec<u8>> {
    let b = std::fs::read(path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    let word = |i: usize| -> usize { u32::from_le_bytes(b.get(i..i + 4).unwrap_or_else(|| fail(&format!("{path}: truncated"))).try_into().unwrap()) as usize };
    let n = word(0);
    let mut at = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let len = word(at);
        at += 4;
        out.push(b.get(at..at + len).unwrap_or_else(|| fail(&format!("{path}: truncated"))).to_vec());
        at += len;
    }
    if at != b.len() {
        fail(&format!("{path}: trailing bytes"));
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let groth16 = args.iter().any(|a| a == "--groth16");
    let mut paths = args.iter().filter(|a| !a.starts_with("--"));
    let elf_path = paths.next().unwrap_or_else(|| fail("usage: tacit-block-gpu ELF FILE... [--groth16]"));
    let elf: &'static [u8] = Box::leak(std::fs::read(elf_path).unwrap_or_else(|e| fail(&format!("{elf_path}: {e}"))).into_boxed_slice());
    let t = Instant::now();
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(elf)).unwrap_or_else(|e| fail(&format!("setup: {e}")));
    println!("{}", json!({ "setup_secs": t.elapsed().as_secs_f64(), "vkey": pk.verifying_key().bytes32() }));
    for f in paths {
        let mut stdin = SP1Stdin::new();
        for b in read_bufs(f) {
            stdin.write_vec(b);
        }
        let t = Instant::now();
        let (pv, report) = client.execute(Elf::Static(elf), stdin.clone()).run().unwrap_or_else(|e| fail(&format!("{f}: execute: {e}")));
        let execute_secs = t.elapsed().as_secs_f64();
        let cycles = report.total_instruction_count();
        let limit = cycles + cycles / 4 + 1_000_000;
        let t = Instant::now();
        let proof = client.prove(&pk, stdin.clone()).compressed().cycle_limit(limit).run().unwrap_or_else(|e| fail(&format!("{f}: compressed proof: {e}")));
        let compressed_secs = t.elapsed().as_secs_f64();
        client.verify(&proof, pk.verifying_key(), None).unwrap_or_else(|e| fail(&format!("{f}: compressed proof does not verify: {e}")));
        if proof.public_values.as_slice() != pv.as_slice() {
            fail(&format!("{f}: the compressed proof commits other public values"));
        }
        let mut line = json!({ "file": f, "cycles": cycles, "gas": report.gas(), "execute_secs": execute_secs, "compressed_secs": compressed_secs });
        if groth16 {
            let t = Instant::now();
            let g = client.prove(&pk, stdin).groth16().cycle_limit(limit).run().unwrap_or_else(|e| fail(&format!("{f}: groth16 proof: {e}")));
            let groth16_secs = t.elapsed().as_secs_f64();
            client.verify(&g, pk.verifying_key(), None).unwrap_or_else(|e| fail(&format!("{f}: groth16 proof does not verify: {e}")));
            line["groth16_secs"] = json!(groth16_secs);
            line["groth16_bytes"] = json!(g.bytes().len());
        }
        println!("{line}");
    }
    // The CUDA proving key panics if dropped outside the SDK's runtime, so leave without running destructors.
    std::process::exit(0)
}
