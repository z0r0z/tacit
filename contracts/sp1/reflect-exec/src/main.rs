// LOCAL execute-mode validator for the full-scan reflection guest. Runs a reflection-prover ELF
// (RISC-V emulator on the host — no GPU) against an assembled reflection_input.json, using the SAME
// write_stdin serialization as the box harnesses (exec-reflect-{prove,fixture}.rs), and reports the
// committed BitcoinReflectionPublicValues. Closes the witness-stream contract loop without a GPU proof.
//
//   REFLECT_ELF=<path> cargo run --release --bin reflect-execute -- <reflection_input.json>
//   (REFLECT_ELF defaults to the committed pinned ELF; set it to a local build to validate new guest code.)
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf};

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) { s.write(&hexv(v.as_str().unwrap())); }
fn path(s: &mut SP1Stdin, v: &serde_json::Value) { for p in v.as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); } }
fn h(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) { s.write(&hexv(v[k].as_str().unwrap())); }
fn u32w(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) { s.write(&(v[k].as_u64().unwrap() as u32)); }

// TAC burn-deposit witness (reflect.rs read order for a 0x2B burn of a non-live-set note). Mirror of the
// box harnesses' write_burn_deposit.
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

// The guest's (reflect.rs) io::read order — identical to exec-reflect-fixture.rs.
fn write_stdin(f: &serde_json::Value) -> SP1Stdin {
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
    r32(&mut s, &p["poolRoot"]);  s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]); s.write(&p["spentCount"].as_u64().unwrap());
    let live = p["live"].as_array().unwrap();
    s.write(&(live.len() as u32));
    for kv in live { let t = kv.as_array().unwrap(); r32(&mut s, &t[0]); r32(&mut s, &t[1]); r32(&mut s, &t[2]); }
    r32(&mut s, &p["burnRoot"]);  s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());
    let cbtc = p.get("cbtcLocks").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
    s.write(&(cbtc.len() as u32));
    for kv in cbtc { let t = kv.as_array().unwrap(); r32(&mut s, &t[0]); r32(&mut s, &t[1]); r32(&mut s, &t[2]); }
    s.write(&p.get("cbtcBackingSats").and_then(|v| v.as_u64()).unwrap_or(0));

    // Track B resume state (guest reads it after cbtcBackingSats): the per-pool reserve registry. The
    // assembler emits reserve/share/k_last as strings (u64/u128 exceed JS Number); parse them losslessly.
    let pools = p.get("pools").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
    s.write(&(pools.len() as u32));
    for pe in pools {
        let u64f = |k: &str| pe[k].as_u64().or_else(|| pe[k].as_str().and_then(|x| x.parse::<u64>().ok())).unwrap_or(0);
        r32(&mut s, &pe["poolId"]); r32(&mut s, &pe["assetA"]); r32(&mut s, &pe["assetB"]);
        s.write(&u64f("reserveA")); s.write(&u64f("reserveB")); s.write(&u64f("totalShares"));
        s.write(&(if pe["c0Backed"].as_bool().unwrap_or(false) { 1u32 } else { 0u32 }));
        s.write(&(u64f("protocolFeeBps") as u16));
        s.write(&pe.get("kLast").and_then(|v| v.as_str()).and_then(|x| x.parse::<u128>().ok()).unwrap_or(0u128));
        s.write(&u64f("protocolFeeAccrued"));
    }

    // Mode-B gate (matches reflect.rs): mode_b, then ONLY when set the eth-reflection PV the guest verifies.
    // A forward-only fixture (modeB absent/0) skips it — no eth_pv, no verify_sp1_proof. modeB=1 carries the
    // real `ethPv` (9 abi words = 288 bytes; word 8 == pinned ETH_GENESIS_SYNC_COMMITTEE) for a fold_crossout.
    let mode_b = f.get("modeB").and_then(|v| v.as_u64()).unwrap_or(0);
    s.write(&(mode_b as u32));
    if mode_b != 0 {
        let eth_pv = f.get("ethPv").and_then(|v| v.as_str()).map(hexv).unwrap_or_else(|| {
            let mut b = vec![0u8; 9 * 32];
            b[8 * 32..9 * 32].copy_from_slice(&hexv("0x8a83300119ac1e64a2318d3db330ed496c51276c636a93633b2d5cfd283c2d44"));
            b
        });
        s.write(&eth_pv);
    }

    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for hh in headers { s.write(&hexv(hh.as_str().unwrap())); }

    for block in f["blocks"].as_array().unwrap() {
        let txs = block["txs"].as_array().unwrap();
        s.write(&(txs.len() as u32));
        for tx in txs { s.write(&hexv(tx["txData"].as_str().unwrap())); }
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
            for o in tx["outputs"].as_array().unwrap() { path(&mut s, &o["notePath"]); }
            // cBTC.zk sats-lock (0x66): the guest reads note_path + the opening sigma (rx,ry,z) after the
            // envelope parse — mirror that order here so the witness stream stays in sync.
            if let Some(cb) = tx.get("cbtcLock").filter(|v| !v.is_null()) {
                path(&mut s, &cb["notePath"]); r32(&mut s, &cb["sigRx"]); r32(&mut s, &cb["sigRy"]); r32(&mut s, &cb["sigZ"]);
            }
            // swap_var (0x32): the guest reads the receipt note-path (+ the change note-path iff
            // non-sentinel) after the envelope — mirror that order.
            if let Some(sw) = tx.get("swapVar").filter(|v| !v.is_null()) {
                path(&mut s, &sw["receiptPath"]);
                if let Some(cp) = sw.get("changePath").filter(|v| !v.is_null()) { path(&mut s, cp); }
            }
            // harvest (0x3B) / farm-refund (0x3E): the guest reads the reward/refund note's append path after
            // the envelope (both dispatch after swap_var) — mirror that order.
            if let Some(hv) = tx.get("harvest").filter(|v| !v.is_null()) {
                path(&mut s, &hv["notePath"]);
            }
            // protocol-fee claim (0x31): the guest reads the claim note's append path after the envelope
            // (dispatches after harvest/refund) — mirror that order.
            if let Some(pf) = tx.get("protocolFee").filter(|v| !v.is_null()) {
                path(&mut s, &pf["notePath"]);
            }
        }
    }
    s
}

fn word(pv: &[u8], i: usize) -> String { format!("0x{}", hex::encode(&pv[i * 32..i * 32 + 32])) }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input_path = args.get(1).cloned()
        .unwrap_or_else(|| "/Users/z/tacit/contracts/sp1/confidential/fixtures/reflection_input.json".to_string());
    let elf_path = std::env::var("REFLECT_ELF")
        .unwrap_or_else(|_| "/Users/z/tacit/contracts/sp1/confidential/elf/reflection-prover".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();
    let elf: &'static [u8] = Box::leak(std::fs::read(&elf_path).expect("read REFLECT_ELF").into_boxed_slice());
    eprintln!("ELF {} ({} bytes), input {}", elf_path, elf.len(), input_path);

    let s = write_stdin(&f);
    let client = ProverClient::builder().cpu().build();
    let (out, rep) = client.execute(Elf::Static(elf), s).run().expect("execute failed (guest panicked / witness desync)");
    let pv = out.as_slice();
    println!("EXECUTE_OK cycles={} pv_bytes={}", rep.total_instruction_count(), pv.len());
    // BitcoinReflectionPublicValues: [0]priorDigest [1]poolRoot [2]spentRoot [3]burnRoot [4]height
    // [5]newDigest [6]prevHash [7]tipHash [8]ethPoolReflected [9]cbtcBackingSats.
    let prior_burn = f["prior"]["burnRoot"].as_str().unwrap_or("").to_lowercase();
    let new_burn = word(pv, 3);
    println!("bitcoinBurnRoot  prior={prior_burn}  new={new_burn}");
    println!("bitcoinSpentRoot new={}", word(pv, 2));
    if new_burn != prior_burn { println!("BURN FOLDED ✓ (burn-set advanced — the burn-deposit recorded ν → dest)"); }
    else { println!("burn-set UNCHANGED (nothing folded)"); }
    // Guest↔JS digest parity: the fixture carries the JS assembler's newDigest; the guest must land on it.
    let new_digest = word(pv, 5);
    let expected = f["newDigest"].as_str().unwrap_or("").to_lowercase();
    if !expected.is_empty() {
        if new_digest == expected { println!("DIGEST_MATCH ✓ guest newDigest == JS assembler ({new_digest})"); }
        else { eprintln!("DIGEST_MISMATCH ✗ guest={new_digest} js={expected}"); std::process::exit(1); }
    }
}
