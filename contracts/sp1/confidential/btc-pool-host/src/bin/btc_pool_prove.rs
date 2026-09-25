//! Proves one T_BTC_SPEND with the committed btc-pool-prover ELF.
//!
//! stdin: {"body","root","inputs":[{"cx","cy","value","blinding","spend_key","nk_pub","nk_note",
//!         "leaf_index","path":[32],"sig"}],"outputs":[{"value","blinding"}]}
//!        outputs: one opening per pool output in body order, then the exit's opening when has_exit = 1.
//! PROVE_MODE=execute (default): {"public_values","cycles"}
//! PROVE_MODE=network: Groth16 on the Succinct network (NETWORK_PRIVATE_KEY, NETWORK_RPC_URL),
//!                     {"proof","public_values","vkey"}; the proof is checked locally before it is printed.
//!
//! Guest stdin order (src/btc_pool.rs): body, root, n_in u32, per input (cx, cy, value u64, blinding,
//! spend_key, nk_pub, nk_note, leaf_index u64, path[32], sig), n_open u32, per opening (value u64, blinding).

use serde_json::{json, Value};
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1Stdin};
use std::io::Read;
use std::process::exit;

const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/btc-pool-prover"));
const DEFAULT_RPC: &str = "https://rpc.mainnet.succinct.xyz";
const TREE_DEPTH: usize = 32;

fn fail(msg: &str) -> ! {
    eprintln!("btc-pool-prove: {msg}");
    exit(2)
}

fn bytes(v: &Value, field: &str, len: Option<usize>) -> Vec<u8> {
    let s = v.get(field).and_then(Value::as_str).unwrap_or_else(|| fail(&format!("missing hex field {field}")));
    let b = hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap_or_else(|_| fail(&format!("{field} is not hex")));
    if let Some(n) = len {
        if b.len() != n {
            fail(&format!("{field} must be {n} bytes, got {}", b.len()));
        }
    }
    b
}

fn u64_dec(v: &Value, field: &str) -> u64 {
    match v.get(field) {
        Some(Value::String(s)) => s.parse().unwrap_or_else(|_| fail(&format!("{field} is not a u64 decimal"))),
        Some(Value::Number(n)) => n.as_u64().unwrap_or_else(|| fail(&format!("{field} is not a u64"))),
        _ => fail(&format!("missing {field}")),
    }
}

fn array<'a>(v: &'a Value, field: &str) -> &'a Vec<Value> {
    v.get(field).and_then(Value::as_array).unwrap_or_else(|| fail(&format!("missing array {field}")))
}

fn build_stdin(w: &Value) -> SP1Stdin {
    let mut stdin = SP1Stdin::new();
    stdin.write(&bytes(w, "body", None));
    stdin.write(&bytes(w, "root", Some(32)));
    let inputs = array(w, "inputs");
    stdin.write(&(inputs.len() as u32));
    for i in inputs {
        stdin.write(&bytes(i, "cx", Some(32)));
        stdin.write(&bytes(i, "cy", Some(32)));
        stdin.write(&u64_dec(i, "value"));
        stdin.write(&bytes(i, "blinding", Some(32)));
        stdin.write(&bytes(i, "spend_key", Some(32)));
        stdin.write(&bytes(i, "nk_pub", Some(33)));
        stdin.write(&bytes(i, "nk_note", Some(32)));
        stdin.write(&u64_dec(i, "leaf_index"));
        let path = array(i, "path");
        if path.len() != TREE_DEPTH {
            fail(&format!("path must have {TREE_DEPTH} entries, got {}", path.len()));
        }
        for (k, p) in path.iter().enumerate() {
            let s = p.as_str().unwrap_or_else(|| fail(&format!("path[{k}] is not a string")));
            let b = hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap_or_else(|_| fail(&format!("path[{k}] is not hex")));
            if b.len() != 32 {
                fail(&format!("path[{k}] must be 32 bytes"));
            }
            stdin.write(&b);
        }
        stdin.write(&bytes(i, "sig", Some(64)));
    }
    let outputs = array(w, "outputs");
    stdin.write(&(outputs.len() as u32));
    for o in outputs {
        stdin.write(&u64_dec(o, "value"));
        stdin.write(&bytes(o, "blinding", Some(32)));
    }
    stdin
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap_or_else(|e| fail(&format!("read stdin: {e}")));
    let w: Value = serde_json::from_str(&raw).unwrap_or_else(|e| fail(&format!("witness json: {e}")));
    let stdin = build_stdin(&w);
    let mode = std::env::var("PROVE_MODE").unwrap_or_else(|_| "execute".into());

    match mode.as_str() {
        "execute" => {
            let client = ProverClient::builder().cpu().build();
            let (pv, report) = client
                .execute(Elf::Static(ELF), stdin)
                .run()
                .unwrap_or_else(|e| fail(&format!("guest rejected the witness: {e}")));
            if report.exit_code != 0 {
                fail(&format!("guest rejected the witness (exit code {})", report.exit_code));
            }
            println!("{}", json!({ "public_values": hex0x(pv.as_slice()), "cycles": report.total_instruction_count() }));
        }
        "network" => {
            let rpc = std::env::var("NETWORK_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC.into());
            let client = ProverClient::builder().network().rpc_url(&rpc).build();
            let (_, report) = client
                .execute(Elf::Static(ELF), stdin.clone())
                .run()
                .unwrap_or_else(|e| fail(&format!("guest rejected the witness: {e}")));
            if report.exit_code != 0 {
                fail(&format!("guest rejected the witness (exit code {})", report.exit_code));
            }
            let pk = client.setup(Elf::Static(ELF)).unwrap_or_else(|e| fail(&format!("setup: {e}")));
            let vkey = pk.verifying_key().bytes32();
            let proof = client
                .prove(&pk, stdin)
                .groth16()
                .run()
                .unwrap_or_else(|e| fail(&format!("groth16 proof: {e}")));
            let proof_bytes = proof.bytes();
            let pv = proof.public_values.as_slice();
            if let Err(e) = sp1_verifier::Groth16Verifier::verify(&proof_bytes, pv, &vkey, &sp1_verifier::GROTH16_VK_BYTES) {
                fail(&format!("network proof failed local verification: {e}"));
            }
            println!("{}", json!({ "proof": hex0x(&proof_bytes), "public_values": hex0x(pv), "vkey": vkey }));
        }
        other => fail(&format!("unknown PROVE_MODE {other}")),
    }
}
