//! btc-pool-agg: pins, proves and checks aggregates of Halo2 spend proofs (DESIGN-btc-shielded-pool.md,
//! Aggregation).
//!
//! pin [--check]   derive artifacts/{vk-digest,vk-repr,verifier-params}.bin from btc-pool-halo2/artifacts, or
//!                 check the committed ones (exit 1 on a mismatch).
//! prove           stdin {"spends":[{"proof": hex, "publics": [dec; 12]}]}, in carrier input order. Every proof
//!                 is verified natively first. PROVE_MODE=execute (default) runs the guest locally;
//!                 PROVE_MODE=network proves on the Succinct network (NETWORK_PRIVATE_KEY, NETWORK_RPC_URL) with
//!                 AGG_WRAP=plonk (default) or groth16 and checks the result locally before printing
//!                 {"wrap","proof","statement","vkey","cycles","gas",...}.
//! verify          stdin {"wrap","proof","statement","vkey"}: sp1-verifier check, exit 0 valid, 1 invalid.

use btc_pool_agg_common as agg;
use btc_pool_halo2 as h2;
use ff::{Field, PrimeField};
use halo2_proofs::halo2curves::bn256::Fr;
use halo2_proofs::poly::commitment::{Params as _, ParamsProver as _};
use serde_json::{json, Value};
use std::io::Read;
use std::process::exit;

const ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../artifacts");
const H2_ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../btc-pool-halo2/artifacts");
#[cfg(feature = "sdk")]
const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../elf/btc-pool-agg"));
#[cfg(feature = "sdk")]
const DEFAULT_RPC: &str = "https://rpc.mainnet.succinct.xyz";

fn fail(msg: &str) -> ! {
    eprintln!("btc-pool-agg: {msg}");
    exit(2)
}

struct Pinned {
    vk: h2::Vk,
    params: h2::Params,
    digest: [u8; 64],
    repr: [u8; 32],
    vparams: Vec<u8>,
}

fn read(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| fail(&format!("{path}: {e}")))
}

fn derive() -> Pinned {
    use blake2::{Blake2b512, Digest};
    let vk_bytes = read(&format!("{H2_ARTIFACTS}/vk.bin"));
    let params = h2::srs::read_params(&read(&format!("{H2_ARTIFACTS}/params-k{}.bin", h2::K))).unwrap_or_else(|e| fail(&e));
    let vk = h2::vk_from_bytes(&vk_bytes).unwrap_or_else(|e| fail(&e));
    let digest: [u8; 64] = Blake2b512::digest(&vk_bytes).into();
    let mut repr = [0u8; 32];
    repr.copy_from_slice(vk.transcript_repr().to_repr().as_ref());
    let vparams = agg::encode_params(params.k(), &params.get_g()[0], &params.g2(), &params.s_g2());
    Pinned { vk, params, digest, repr, vparams }
}

fn pin(check: bool) {
    let p = derive();
    let files: [(&str, &[u8]); 3] = [("vk-digest.bin", &p.digest), ("vk-repr.bin", &p.repr), ("verifier-params.bin", &p.vparams)];
    let mut bad = false;
    for (name, want) in files {
        let path = format!("{ARTIFACTS}/{name}");
        if check {
            let got = std::fs::read(&path).unwrap_or_default();
            if got != want {
                eprintln!("{name}: committed bytes differ from the derived ones");
                bad = true;
            }
        } else {
            std::fs::write(&path, want).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
        }
    }
    println!("{}", json!({ "vk_digest": hex::encode(p.digest), "vk_repr": hex::encode(p.repr), "verifier_params": hex::encode(&p.vparams), "ok": !bad }));
    if bad {
        exit(1);
    }
}

fn stdin_json() -> Value {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap_or_else(|e| fail(&format!("read stdin: {e}")));
    serde_json::from_str(&raw).unwrap_or_else(|e| fail(&format!("json: {e}")))
}

fn unhex(v: &Value, what: &str) -> Vec<u8> {
    let s = v.as_str().unwrap_or_else(|| fail(&format!("{what} is not a string")));
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap_or_else(|_| fail(&format!("{what} is not hex")))
}

fn be32(f: &Fr) -> [u8; 32] {
    let mut b = [0u8; 32];
    let le = f.to_repr();
    for i in 0..32 {
        b[i] = le.as_ref()[31 - i];
    }
    b
}

/// A spend ready for the guest: publics (big-endian), proof, hints.
pub struct Spend {
    publics: Vec<u8>,
    proof: Vec<u8>,
    hints: Vec<u8>,
}

/// Checks each proof natively, records its hints, and checks the batched fold the guest will run.
fn prepare(p: &Pinned, doc: &Value) -> (Vec<Spend>, [u8; 32]) {
    let spends = doc.get("spends").and_then(Value::as_array).unwrap_or_else(|| fail("missing spends"));
    if spends.is_empty() || spends.len() > u8::MAX as usize {
        fail("between 1 and 255 spends");
    }
    let vparams = agg::verifier_params(&p.vparams).unwrap_or_else(|| fail("verifier params"));
    let mut out = Vec::with_capacity(spends.len());
    let mut dms = vec![];
    for (i, s) in spends.iter().enumerate() {
        let proof = unhex(&s["proof"], "proof");
        if proof.len() != agg::PROOF_LEN {
            fail(&format!("spend {i}: proof is {} bytes, expected {}", proof.len(), agg::PROOF_LEN));
        }
        let decs: Vec<String> = s["publics"].as_array().unwrap_or_else(|| fail("publics")).iter().map(|x| x.as_str().unwrap_or_else(|| fail("publics: strings")).to_string()).collect();
        let publics = h2::publics_from_dec(&decs).unwrap_or_else(|e| fail(&format!("spend {i}: {e}")));
        if !h2::verify(&p.params, &p.vk, &publics, &proof) {
            fail(&format!("spend {i}: proof does not verify"));
        }
        let (hints, dm) = agg::record_hints(&vparams, &p.vk, &publics, &proof).unwrap_or_else(|e| fail(&format!("spend {i}: {e:?}")));
        if hints.len() != agg::HINTS_LEN {
            fail(&format!("spend {i}: {} hint bytes", hints.len()));
        }
        dms.push(dm);
        out.push(Spend { publics: publics.iter().flat_map(be32).collect(), proof, hints });
    }
    let refs: Vec<&[u8]> = out.iter().map(|s| s.publics.as_slice()).collect();
    let statement = agg::statement(&p.digest, &refs);
    let proofs: Vec<&[u8]> = out.iter().map(|s| s.proof.as_slice()).collect();
    let r = if out.len() > 1 { agg::rlc_challenge(&statement, &proofs) } else { Fr::ONE };
    let mut batch = agg::Batch::default();
    let mut ri = Fr::ONE;
    for (i, dm) in dms.iter().enumerate() {
        batch.add(dm, if i == 0 { None } else { Some(ri) });
        ri *= r;
    }
    let (_, _, g2, s_g2) = agg::decode_params(&p.vparams).unwrap();
    if !agg::native_check(&batch, &g2, &s_g2) {
        fail("batched fold does not check natively");
    }
    (out, statement)
}

#[cfg(feature = "sdk")]
fn prove(p: &Pinned) {
    use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
    use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1Stdin};
    let (spends, statement) = prepare(p, &stdin_json());
    let mut stdin = SP1Stdin::new();
    stdin.write_vec((spends.len() as u32).to_le_bytes().to_vec());
    for s in &spends {
        stdin.write_vec(s.publics.clone());
        stdin.write_vec(s.proof.clone());
        stdin.write_vec(s.hints.clone());
    }
    let mode = std::env::var("PROVE_MODE").unwrap_or_else(|_| "execute".into());
    let t0 = std::time::Instant::now();
    match mode.as_str() {
        "execute" => {
            let client = ProverClient::builder().cpu().build();
            let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().unwrap_or_else(|e| fail(&format!("guest rejected: {e}")));
            if report.exit_code != 0 {
                fail(&format!("guest exit code {}", report.exit_code));
            }
            if pv.as_slice() != statement {
                fail("guest statement differs from the host's");
            }
            println!("{}", json!({ "n": spends.len(), "statement": hex::encode(statement), "cycles": report.total_instruction_count(), "gas": report.gas(), "secs": t0.elapsed().as_secs_f64() }));
        }
        "network" => {
            let wrap = std::env::var("AGG_WRAP").unwrap_or_else(|_| "plonk".into());
            let rpc = std::env::var("NETWORK_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC.into());
            let client = ProverClient::builder().network().rpc_url(&rpc).build();
            let (pv, report) = client.execute(Elf::Static(ELF), stdin.clone()).run().unwrap_or_else(|e| fail(&format!("guest rejected: {e}")));
            if report.exit_code != 0 || pv.as_slice() != statement {
                fail("guest rejected the batch or committed another statement");
            }
            let pk = client.setup(Elf::Static(ELF)).unwrap_or_else(|e| fail(&format!("setup: {e}")));
            let vkey = pk.verifying_key().bytes32();
            let balance0 = client.get_balance().ok();
            let req = match wrap.as_str() {
                "plonk" => client.prove(&pk, stdin).plonk().request(),
                "groth16" => client.prove(&pk, stdin).groth16().request(),
                w => fail(&format!("AGG_WRAP must be plonk or groth16, not {w}")),
            }
            .unwrap_or_else(|e| fail(&format!("request: {e}")));
            eprintln!("btc-pool-agg: request 0x{}", hex::encode(req));
            let proof = client.wait_proof(req, Some(std::time::Duration::from_secs(1800)), None).unwrap_or_else(|e| fail(&format!("proof: {e}")));
            let bytes = proof.bytes();
            if proof.public_values.as_slice() != statement {
                fail("network proof commits another statement");
            }
            if !check(&wrap, &bytes, &statement, &vkey) {
                fail("network proof failed local verification");
            }
            let details = client.get_proof_request(req).ok().flatten();
            let balance1 = client.get_balance().ok();
            println!(
                "{}",
                json!({
                    "n": spends.len(), "wrap": wrap, "proof": hex::encode(&bytes), "proof_bytes": bytes.len(),
                    "statement": hex::encode(statement), "vkey": vkey, "request": format!("0x{}", hex::encode(req)),
                    "cycles": report.total_instruction_count(), "gas": report.gas(),
                    "gas_used": details.as_ref().and_then(|d| d.gas_used), "gas_price": details.as_ref().and_then(|d| d.gas_price),
                    "deduction": details.as_ref().and_then(|d| d.deduction_amount.clone()),
                    "refund": details.as_ref().and_then(|d| d.refund_amount.clone()),
                    "balance_before": balance0.map(|b| b.to_string()), "balance_after": balance1.map(|b| b.to_string()),
                    "secs": t0.elapsed().as_secs_f64(),
                })
            );
        }
        m => fail(&format!("unknown PROVE_MODE {m}")),
    }
}

fn check(wrap: &str, proof: &[u8], statement: &[u8], vkey: &str) -> bool {
    match wrap {
        "plonk" => sp1_verifier::PlonkVerifier::verify(proof, statement, vkey, &sp1_verifier::PLONK_VK_BYTES).is_ok(),
        "groth16" => sp1_verifier::Groth16Verifier::verify(proof, statement, vkey, &sp1_verifier::GROTH16_VK_BYTES).is_ok(),
        _ => false,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("pin") => pin(args.iter().any(|a| a == "--check")),
        Some("statement") => {
            let p = derive();
            let (_, st) = prepare(&p, &stdin_json());
            println!("{}", json!({ "statement": hex::encode(st) }));
        }
        #[cfg(feature = "sdk")]
        Some("prove") => prove(&derive()),
        Some("verify") => {
            let d = stdin_json();
            let wrap = d["wrap"].as_str().unwrap_or_else(|| fail("wrap"));
            let ok = check(wrap, &unhex(&d["proof"], "proof"), &unhex(&d["statement"], "statement"), d["vkey"].as_str().unwrap_or_else(|| fail("vkey")));
            println!("{}", json!({ "valid": ok }));
            exit(if ok { 0 } else { 1 });
        }
        _ => fail("usage: btc-pool-agg pin [--check] | statement | prove | verify"),
    }
}
