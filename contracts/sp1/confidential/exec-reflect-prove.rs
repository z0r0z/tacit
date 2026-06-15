// GPU (cuda) Groth16 prover for the reflection guest on the assembled real-CXFER fixture
// (reflection_input.json). Produces BITCOIN_RELAY_VKEY + an on-chain-verifiable proof of the
// reflected Bitcoin state (the input to ConfidentialPool.attestBitcoinStateProven). Needs a
// running sp1-gpu-server (CUDA_VISIBLE_DEVICES=0) + a clean /dev/shm.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) { s.write(&hexv(v.as_str().unwrap())); }
fn path(s: &mut SP1Stdin, v: &serde_json::Value) { for p in v.as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); } }
fn h(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) { s.write(&hexv(v[k].as_str().unwrap())); }
fn u32w(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) { s.write(&(v[k].as_u64().unwrap() as u32)); }

// TAC burn-DEPOSIT witness (reflect.rs read order for a 0x2B burn of a non-live-set note). See the twin in
// exec-reflect-fixture.rs.
fn write_burn_deposit(s: &mut SP1Stdin, bd: &serde_json::Value) {
    h(s, bd, "etchTx");
    u32w(s, bd, "etchIndex");
    let esib = bd["etchSiblings"].as_array().unwrap();
    s.write(&(esib.len() as u32));
    for x in esib { s.write(&hexv(x.as_str().unwrap())); }
    let phs = bd["provHeaders"].as_array().unwrap();
    s.write(&(phs.len() as u32));
    for hh in phs { s.write(&hexv(hh.as_str().unwrap())); }
    let cxfers = bd["cxfers"].as_array().unwrap();
    s.write(&(cxfers.len() as u32));
    for c in cxfers {
        h(s, c, "txid");
        let ins = c["inputs"].as_array().unwrap();
        s.write(&(ins.len() as u32));
        for i in ins { h(s, i, "prevTxid"); u32w(s, i, "prevVout"); h(s, i, "commitment"); }
        let outs = c["outputs"].as_array().unwrap();
        s.write(&(outs.len() as u32));
        for o in outs { h(s, o, "commitment"); u32w(s, o, "vout"); }
        s.write(&c["burnedAmount"].as_u64().unwrap_or(0)); // 0 for a transfer, > 0 for a CBURN step
        h(s, c, "rangeProof");
        h(s, c, "kernelSig");
        let msib = c["merkleSiblings"].as_array().unwrap();
        s.write(&(msib.len() as u32));
        for x in msib { s.write(&hexv(x.as_str().unwrap())); }
        u32w(s, c, "merkleIndex");
        h(s, c, "confirmedBlockRoot");
    }
    // mintable: issuer-authorized cmints (reveal tx + commit tx + reveal merkle inclusion). Empty for fixed.
    let cmints = bd.get("cmints").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
    s.write(&(cmints.len() as u32));
    for cm in cmints {
        h(s, cm, "revealTx");
        h(s, cm, "commitTx");
        let msib = cm["merkleSiblings"].as_array().unwrap();
        s.write(&(msib.len() as u32));
        for x in msib { s.write(&hexv(x.as_str().unwrap())); }
        u32w(s, cm, "merkleIndex");
    }
    h(s, bd, "burnedCx");
    h(s, bd, "burnedCy");
    let si = &bd["spentInsert"];
    r32(s, &si["sLowValue"]); r32(s, &si["sLowNext"]); s.write(&si["sLowIndex"].as_u64().unwrap());
    path(s, &si["sLowPath"]); path(s, &si["sNewPath"]);
    let bi = &bd["burnInsert"];
    r32(s, &bi["bLowKey"]); r32(s, &bi["bLowNext"]); r32(s, &bi["bLowValue"]); s.write(&bi["bLowIndex"].as_u64().unwrap());
    path(s, &bi["bLowPath"]); path(s, &bi["bNewPath"]);
    path(s, &bd["notePath"]); // the burned note's pool-tree append path (onboard it as a pool member)
}

// Fail-closed vkey guard: the derived vkey MUST equal the pinned BITCOIN_RELAY_VKEY, else a drifting
// box rebuild (different toolchain/deps than the committed elf/reflection-prover) produces a proof
// that reverts in ConfidentialPool.attestBitcoinStateProven. Set EXPECT_VKEY=<pinned vkey> OR
// ELF_VKEY_PIN=<path to elf-vkey-pin.json>; the prove aborts BEFORE the GPU spend on any mismatch.
fn expected_vkey(field: &str) -> String {
    if let Ok(v) = std::env::var("EXPECT_VKEY") { return v.trim().to_lowercase(); }
    let path = std::env::var("ELF_VKEY_PIN")
        .expect("set EXPECT_VKEY=<pinned vkey> or ELF_VKEY_PIN=<path to elf-vkey-pin.json> so a drifting rebuild can't produce on-chain-rejected proofs");
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read ELF_VKEY_PIN")).expect("parse ELF_VKEY_PIN");
    j[field].as_str().expect("pin field missing").trim().to_lowercase()
}
fn assert_vkey(actual: &str, field: &str) {
    let exp = expected_vkey(field);
    let act = actual.trim().to_lowercase();
    assert_eq!(act, exp, "VKEY DRIFT: derived {act} != pinned {field} {exp} — this ELF won't verify against the deployed contract; rebuild from the committed source so the box runs the pinned bytes before proving");
}

// Write the assembled FULL-SCAN input (assembleReflectionScanInput) to SP1Stdin in the guest's
// (reflect.rs) io::read order. Prior: roots + counts with the HANDED live set (key,value,asset triples).
// Then anchorHeight + headers. Then per block: n_tx, ALL txData (the guest collects them, then
// recomputes the merkle root for completeness), then per tx the witnesses in scan order —
// openings (read inside scan_tx_spends), spent-set inserts, a burn insert, then outputs.
fn write_stdin(f: &serde_json::Value) -> SP1Stdin {
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
    r32(&mut s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    let live = p["live"].as_array().unwrap();
    s.write(&(live.len() as u32));
    // Each handed entry is (key, value=commitment_hash, asset_id) — the asset carried so the guest
    // can re-impose CXFER asset preservation (see LiveUtxoSet / fold_cxfer).
    for kv in live { let t = kv.as_array().unwrap(); r32(&mut s, &t[0]); r32(&mut s, &t[1]); r32(&mut s, &t[2]); }
    r32(&mut s, &p["burnRoot"]);  s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());
    // cBTC.zk resume state (guest reads it after height): live self-custody locks (key,sats,asset) triples
    // + the running backing sats. Tolerant of priors that omit it (empty set, 0 sats).
    let cbtc = p.get("cbtcLocks").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
    s.write(&(cbtc.len() as u32));
    for kv in cbtc { let t = kv.as_array().unwrap(); r32(&mut s, &t[0]); r32(&mut s, &t[1]); r32(&mut s, &t[2]); }
    s.write(&p.get("cbtcBackingSats").and_then(|v| v.as_u64()).unwrap_or(0));

    // Mode B: the eth-reflection public values the guest reads before anchorHeight (reflect.rs ~L135) +
    // verify_sp1_proof's. For a non-crossout fixture the only field the guest reads is word 8
    // (prevSyncCommitteeRoot), which must == the pinned ETH_GENESIS_SYNC_COMMITTEE; the rest is unused
    // (no 0x65 crossout txs). 9 abi words = 288 bytes. MUST match reflect-exec/src/main.rs write_stdin —
    // omitting it desyncs every read after it (the guest then commits nothing → pv_bytes=0).
    let eth_pv = f.get("ethPv").and_then(|v| v.as_str()).map(hexv).unwrap_or_else(|| {
        let mut b = vec![0u8; 9 * 32];
        b[8 * 32..9 * 32].copy_from_slice(&hexv("0x8a83300119ac1e64a2318d3db330ed496c51276c636a93633b2d5cfd283c2d44"));
        b
    });
    s.write(&eth_pv);

    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for h in headers { s.write(&hexv(h.as_str().unwrap())); }

    for block in f["blocks"].as_array().unwrap() {
        let txs = block["txs"].as_array().unwrap();
        s.write(&(txs.len() as u32));
        for tx in txs { s.write(&hexv(tx["txData"].as_str().unwrap())); } // all txData first
        for tx in txs {
            for op in tx["openings"].as_array().unwrap() { r32(&mut s, &op["cx"]); r32(&mut s, &op["cy"]); }
            for si in tx["spentInserts"].as_array().unwrap() {
                r32(&mut s, &si["sLowValue"]); r32(&mut s, &si["sLowNext"]); s.write(&si["sLowIndex"].as_u64().unwrap());
                path(&mut s, &si["sLowPath"]); path(&mut s, &si["sNewPath"]);
            }
            if let Some(bd) = tx.get("burnDeposit").filter(|v| !v.is_null()) {
                write_burn_deposit(&mut s, bd);
            } else if let Some(bi) = tx.get("burnInsert").filter(|v| !v.is_null()) {
                r32(&mut s, &bi["bLowKey"]); r32(&mut s, &bi["bLowNext"]); r32(&mut s, &bi["bLowValue"]); s.write(&bi["bLowIndex"].as_u64().unwrap());
                path(&mut s, &bi["bLowPath"]); path(&mut s, &bi["bNewPath"]);
            }
            for o in tx["outputs"].as_array().unwrap() {
                // the note leaf is DERIVED in-guest (reflected_note_leaf) from the envelope's
                // asset+commitment, and the outpoint vout = the output's commitment index — neither is
                // streamed; only the append path is witnessed.
                path(&mut s, &o["notePath"]);
            }
        }
    }
    s
}

fn main() {
    // REFLECT_INPUT lets the box prove a DIFFERENT assembled fixture without a code edit — the standard
    // real-CXFER reflection_input.json (default) OR the TAC burn-deposit fixture
    // (contracts/sp1/confidential/fixtures/reflection_burn_deposit.json) for the
    // ConfidentialReflectionBurnDepositProofReal turnkey fixture. write_burn_deposit/write_stdin already
    // handle both shapes (a burnDeposit tx folds, a plain CXFER tx folds), so only the path changes.
    // REFLECT_OUT_TAG names the output hex files (default "reflect") so the two fixtures don't collide.
    let input_path = std::env::var("REFLECT_INPUT")
        .unwrap_or_else(|_| "/root/work/cxfer/fixtures/reflection_input.json".to_string());
    let out_tag = std::env::var("REFLECT_OUT_TAG").unwrap_or_else(|_| "reflect".to_string());
    println!("input {input_path}  out_tag {out_tag}");
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();
    let s = write_stdin(&f);

    let client = ProverClient::builder().cuda().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("BITCOIN_RELAY_VKEY={vk}");
    assert_vkey(&vk, "bitcoin_relay_vkey");
    println!("proving groth16 (cuda)...");
    let proof = client.prove(&pk, s).groth16().run().expect("groth16 proof failed");
    println!("PROVED pv_bytes={}", proof.public_values.as_slice().len());
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK");
    let pv_path = format!("/root/work/cxfer/exec/{out_tag}_public_values.hex");
    let proof_path = format!("/root/work/cxfer/exec/{out_tag}_proof_bytes.hex");
    std::fs::write(&pv_path, hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write(&proof_path, hex::encode(proof.bytes())).unwrap();
    println!("WROTE {pv_path} + {proof_path}");
}
