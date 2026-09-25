//! The signet key the indexers pin (dapp/btc-pool/pin.json) hashes to the pinned vk_hash here too, and the
//! stored Groth16 cases (tests/vectors/btc-pool-zk-vectors.json) verify natively as recorded.

use btc_pool_zk_core::fr_from_big;
use btc_pool_zk_core::verify::{verify_spend, vk_from_snarkjs_json, vk_hash, SpendPublic};
use num_bigint::BigUint;
use std::fs;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../..");

fn fr(s: &serde_json::Value) -> bn::Fr {
    fr_from_big(&s.as_str().unwrap().parse::<BigUint>().unwrap())
}

#[test]
fn pinned_vk_hash_matches() {
    let pin: serde_json::Value = serde_json::from_str(&fs::read_to_string(format!("{ROOT}/dapp/btc-pool/pin.json")).unwrap()).unwrap();
    let vk_json = fs::read_to_string(format!("{ROOT}/dapp/btc-pool/{}", pin["vk"].as_str().unwrap())).unwrap();
    let vk = vk_from_snarkjs_json(&vk_json).expect("vk parses");
    assert_eq!(hex::encode(vk_hash(&vk)), pin["vk_hash"].as_str().unwrap());
}

#[test]
fn stored_cases_verify_as_recorded() {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(format!("{ROOT}/tests/vectors/btc-pool-zk-vectors.json")).unwrap()).unwrap();
    let vk = vk_from_snarkjs_json(&v["groth16"]["vk"].to_string()).expect("vk parses");
    for c in v["groth16"]["cases"].as_array().unwrap() {
        let p: Vec<bn::Fr> = c["publics"].as_array().unwrap().iter().map(fr).collect();
        let public = SpendPublic {
            root: p[0], body_hash: p[1], asset: p[2], nf: [p[3], p[4]], out_leaf: [p[5], p[6], p[7]],
            exit_c: (p[8], p[9]), dep_c: (p[10], p[11]),
        };
        let wire = hex::decode(c["proof"].as_str().unwrap()).unwrap();
        assert_eq!(verify_spend(&vk, &wire, &public), c["valid"].as_bool().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn poseidon_matches_vectors() {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(format!("{ROOT}/tests/vectors/btc-pool-zk-vectors.json")).unwrap()).unwrap();
    for c in v["poseidon"].as_array().unwrap() {
        let xs: Vec<bn::Fr> = c["inputs"].as_array().unwrap().iter().map(fr).collect();
        let got = btc_pool_zk_core::big_from_fr(&btc_pool_zk_core::poseidon(&xs));
        assert_eq!(got.to_string(), c["out"].as_str().unwrap());
    }
}

#[test]
fn boundary_matches_vectors() {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(format!("{ROOT}/tests/vectors/btc-pool-zk-vectors.json")).unwrap()).unwrap();
    for b in v["boundary"].as_array().unwrap() {
        let got = btc_pool_zk_core::boundary::verify_bytes(&hex::decode(b["hex"].as_str().unwrap()).unwrap());
        assert_eq!(got.is_some(), b["valid"].as_bool().unwrap());
        if let Some(p) = got {
            let want = b["C_bjj"].as_array().unwrap();
            assert_eq!(btc_pool_zk_core::big_from_fr(&p.0).to_string(), want[0].as_str().unwrap());
            assert_eq!(btc_pool_zk_core::big_from_fr(&p.1).to_string(), want[1].as_str().unwrap());
        }
    }
}
