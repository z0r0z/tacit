// Reconnects to an already-submitted Succinct network proof request by its request_id, instead of
// re-submitting a fresh one. bitcoin_prove.rs's own client-side wait has a 4-hour default timeout
// (sp1_sdk::network::DEFAULT_TIMEOUT_SECS) that does NOT cancel the request server-side when it fires --
// it only stops our own local wait and returns an error. A request already past the initial auction
// (picked up by a prover) keeps proving on Succinct's network regardless of whether any client is still
// watching it. This binary just re-attaches with a fresh, longer wait on the SAME request_id -- no new
// witness, no new cycle/gas spend, no new request.
use sp1_sdk::blocking::ProverClient;
use alloy_primitives::B256;
use std::time::Duration;
use std::str::FromStr;

fn main() {
    sp1_sdk::utils::setup_logger();
    let out_dir = std::env::var("PROVER_OUT").unwrap_or_else(|_| "/root/work/prover-host/out".to_string());
    let request_id_hex = std::env::var("REQUEST_ID").expect("set REQUEST_ID=0x...");
    let wait_secs: u64 = std::env::var("WAIT_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(6 * 3600);

    let pclient = ProverClient::builder().network().build();
    let request_id = B256::from_str(&request_id_hex).expect("parse REQUEST_ID as 0x-hex B256");

    println!("reconnecting to request {request_id_hex}, waiting up to {wait_secs}s...");
    let proof = pclient
        .wait_proof(request_id, Some(Duration::from_secs(wait_secs)), None)
        .expect("wait_proof failed");

    let pv = proof.public_values.as_slice().to_vec();
    println!("RECONNECTED — proof retrieved, pv_bytes={}", pv.len());
    std::fs::create_dir_all(&out_dir).ok();
    proof.save(format!("{out_dir}/bitcoin_groth16.bin")).expect("save proof");
    std::fs::write(format!("{out_dir}/bitcoin_pv.hex"), hex::encode(&pv)).unwrap();
    std::fs::write(format!("{out_dir}/bitcoin_proof_bytes.hex"), hex::encode(proof.bytes())).unwrap();
    println!("WROTE bitcoin_groth16.bin + bitcoin_pv.hex + bitcoin_proof_bytes.hex");
}
