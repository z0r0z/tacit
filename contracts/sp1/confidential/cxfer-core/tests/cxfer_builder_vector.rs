//! Runs the transfers the wallet's builder broadcasts (dapp/tacit.js buildAndBroadcastCXferMulti) through the guest's own functions:
//! extract_taproot_envelope, parse_cxfer_envelope_full, canonical_output_vout, extract_inputs / extract_outputs and
//! verify_cxfer_conservation (the kernel signature and the range proof). The JS test tests/cxfer-no-zero-change.test.mjs writes the
//! vector when CXFER_BUILDER_VECTOR_OUT is set; run this with CXFER_BUILDER_VECTOR=<file>.
//!
//! It pins the builder's output sizes against the guest: a transfer spent whole is one output (N = 1) with no change note, and the
//! padding of 0 that rounds the outputs up to 2, 4 or 8 is only what the size needs. Every one of them must parse, map output `i` to
//! vout `i`, sit within the transaction's outputs, and conserve.
use cxfer_core::bitcoin;
use cxfer_core::*;

fn arr32(h: &str) -> [u8; 32] {
    hex::decode(h.trim_start_matches("0x")).unwrap().try_into().unwrap()
}
fn arr33(h: &str) -> [u8; 33] {
    hex::decode(h.trim_start_matches("0x")).unwrap().try_into().unwrap()
}
fn raw_txid(display: &str) -> [u8; 32] {
    let mut a = arr32(display);
    a.reverse();
    a
}

#[test]
fn js_built_transfers_parse_and_conserve_in_the_guest() {
    let Ok(path) = std::env::var("CXFER_BUILDER_VECTOR") else {
        eprintln!("CXFER_BUILDER_VECTOR not set; skipping");
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let vectors = v["vectors"].as_array().unwrap();
    assert!(!vectors.is_empty(), "the vector has transfers");
    let mut ones = 0;
    for t in vectors {
        let name = t["name"].as_str().unwrap();
        let tx = hex::decode(t["revealHex"].as_str().unwrap()).unwrap();
        let want_n = t["n"].as_u64().unwrap() as usize;
        let asset = arr32(t["asset"].as_str().unwrap());

        let env = bitcoin::extract_taproot_envelope(&tx).unwrap_or_else(|| panic!("{name}: no envelope at vin0"));
        let op = env[0];
        let (a, sig, commitments, rp) = bitcoin::parse_cxfer_envelope_full(&env).unwrap_or_else(|| panic!("{name}: the guest does not parse it"));
        assert_eq!(a, asset, "{name}: asset");
        assert_eq!(commitments.len(), want_n, "{name}: the guest reads the envelope's output count the builder meant");
        if want_n == 1 {
            ones += 1;
        }

        // output i is at vout i, inside the transaction's outputs: every tacit output is a real Bitcoin output
        let outs = bitcoin::extract_outputs(&tx).unwrap_or_else(|| panic!("{name}: outputs"));
        for i in 0..want_n {
            let vout = canonical_output_vout(op, i, want_n).unwrap_or_else(|| panic!("{name}: no canonical vout for output {i}"));
            assert_eq!(vout as usize, i, "{name}: output {i} is at vout {i}");
            assert!((vout as usize) < outs.len(), "{name}: output {i} has a Bitcoin output");
        }

        // the transfer's asset inputs are vin[1..] (vin[0] is the commit), the kernel binds them by outpoint
        let ins = bitcoin::extract_inputs(&tx).unwrap_or_else(|| panic!("{name}: inputs"));
        let want_ins: Vec<([u8; 32], u32)> = t["inputs"].as_array().unwrap().iter().map(|i| (raw_txid(i["txid"].as_str().unwrap()), i["vout"].as_u64().unwrap() as u32)).collect();
        assert_eq!(&ins[1..], &want_ins[..], "{name}: the asset inputs are vin[1..]");
        let in_pts: Vec<Point> = t["inputs"].as_array().unwrap().iter().map(|i| decompress(&arr33(i["commitment"].as_str().unwrap())).unwrap()).collect();

        assert!(verify_cxfer_conservation(&asset, &want_ins, &in_pts, &commitments, &rp, &sig), "{name}: the guest's conservation check (kernel and range proof) accepts it");

        // and it is the amounts that bind: the same transfer with one output dropped does not conserve
        if want_n >= 2 {
            let fewer = &commitments[..want_n - 1];
            assert!(!verify_cxfer_conservation(&asset, &want_ins, &in_pts, fewer, &rp, &sig), "{name}: dropping an output breaks the kernel");
        }
    }
    assert!(ones >= 2, "the vector has transfers of one output");
}
