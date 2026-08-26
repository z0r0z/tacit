//! Shared reflection-stdin serializer — the SINGLE source of truth for the SP1Stdin byte stream the
//! full-scan reflection guest (`contracts/sp1/confidential/src/reflect.rs`) reads via `io::read`.
//!
//! Both consumers call [`write_stdin`] so they can never drift from the guest's read order:
//! - `reflect-exec` (LOCAL execute validator) — runs the guest in the RISC-V emulator and asserts the
//!   committed `newDigest` == the JS assembler's (DIGEST_MATCH), the cheap parity proof.
//! - `eth-reflection/prover-host` `bitcoin_prove` (BOX recursion prover) — writes the same stream, then
//!   `write_proof`s the eth-reflection inner proof and proves groth16 for the on-chain attest.
//!
//! The fixture JSON is the dapp reflection assembler's output (`assembleReflectionScanInput`). Pure
//! sp1-sdk/serde_json/hex (no box-absolute or guest-crate deps) so it builds locally and on the box.
//!
//! ## Mode-B note
//! `write_stdin` reads the eth-reflection public values from `f["ethPv"]` (only when `modeB != 0`). For a
//! LOCAL execute the JS `buildEthPv` value (ethPool word zeroed) suffices — only the fold-relevant words
//! (3 crossOutSetRoot, 9 consumedNuSetRoot, 10 consumedNuCount) + word 8 (genesis sync-committee) drive
//! the in-circuit fold + the digest. For a REAL recursion prove the fixture MUST carry the eth proof's
//! actual public values (ethPool word populated) so the committed `ethPoolReflected` passes the on-chain
//! `== address(this)` gate — `bitcoin_prove` asserts `f["ethPv"] == eth.public_values` before proving.
use sp1_sdk::SP1Stdin;

fn hexv(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}
// Every fixed-width field is length-checked so a malformed fixture fails LOUDLY here rather than silently
// shifting the stream (the guest reads fixed widths via io::read — a wrong length desyncs everything after).
fn r32(s: &mut SP1Stdin, v: &serde_json::Value) {
    let b = hexv(v.as_str().expect("r32 field"));
    assert_eq!(b.len(), 32, "r32 field must be exactly 32 bytes");
    s.write(&b);
}
fn r33(s: &mut SP1Stdin, v: &serde_json::Value) {
    let b = hexv(v.as_str().expect("r33 field"));
    assert_eq!(b.len(), 33, "r33 field must be exactly 33 bytes");
    s.write(&b);
}
// The guest's r_path() always reads EXACTLY 32 siblings (the pool-tree / IMT / eth-set depth), so the
// serializer must write exactly 32. (Variable-length Bitcoin merkle siblings are written length-prefixed
// elsewhere, not through path().)
fn path(s: &mut SP1Stdin, v: &serde_json::Value) {
    let a = v.as_array().expect("path array");
    assert_eq!(a.len(), 32, "path must have exactly 32 siblings");
    for p in a {
        r32(s, p);
    }
}
fn h(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) {
    let b = hexv(v[k].as_str().unwrap_or_else(|| panic!("hex field {k}")));
    s.write(&b);
}
// TAC burn-deposit witness (reflect.rs read order for a 0x2B burn of a non-live-set note). The provenance
// DAG (etch, cmints, prov, headers) now rides the burn tx's Taproot witness (appended after the 129-byte
// burn envelope) and is read by the guest from that wtxid-authenticated blob — not from stdin. The stdin
// stream carries only the burn tx's witness-commitment proof + the note opening + the IMT/tree witnesses.
fn write_burn_deposit(s: &mut SP1Stdin, bd: &serde_json::Value) {
    let bwsib = bd["burnWtxidSiblings"]
        .as_array()
        .expect("burnWtxidSiblings array");
    s.write(&(bwsib.len() as u32));
    for x in bwsib {
        r32(s, x);
    }
    let bcbsib = bd["burnCbTxidSiblings"]
        .as_array()
        .expect("burnCbTxidSiblings array");
    s.write(&(bcbsib.len() as u32));
    for x in bcbsib {
        r32(s, x);
    }
    h(s, bd, "burnedCx");
    h(s, bd, "burnedCy");
    let si = &bd["spentInsert"];
    r32(s, &si["sLowValue"]);
    r32(s, &si["sLowNext"]);
    s.write(&si["sLowIndex"].as_u64().unwrap());
    path(s, &si["sLowPath"]);
    path(s, &si["sNewPath"]);
    let bi = &bd["burnInsert"];
    r32(s, &bi["bLowKey"]);
    r32(s, &bi["bLowNext"]);
    r32(s, &bi["bLowValue"]);
    s.write(&bi["bLowIndex"].as_u64().unwrap());
    path(s, &bi["bLowPath"]);
    path(s, &bi["bNewPath"]);
    // CROSS-LANE DOUBLE-MINT GATE presence witness — the guest reads it UNCONDITIONALLY here (reflect.rs:
    // co_is_member/co_value/co_next/co_index/co_path), between the burn insert and the note append, to prove the
    // burned outpoint was not already retired on the Ethereum fast lane. Omitting it ran the stdin stream dry
    // mid burn-deposit, so it also broke the box recursion prover on every real burn-deposit.
    s.write(&(bd["coIsMember"].as_u64().unwrap() as u32));
    r32(s, &bd["coValue"]);
    r32(s, &bd["coNext"]);
    s.write(&bd["coIndex"].as_u64().unwrap());
    path(s, &bd["coPath"]);
    path(s, &bd["notePath"]); // the burned note's pool-tree append path (onboard it as a pool member)
}

/// Serialize a reflection fixture (the dapp assembler's `assembleReflectionScanInput` output) into the
/// guest's exact `io::read` order. Returns a fresh `SP1Stdin`; a recursion prover may `write_proof` onto it.
pub fn write_stdin(f: &serde_json::Value) -> SP1Stdin {
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
    // GENERATIONAL RESUME: the guest reads the rebase flag FIRST (ahead of read_scan_prior_state). Nonzero ⇒
    // the prior below is the DRAINED PREDECESSOR's final state, which the guest rebases to the successor
    // genesis; the two drained on-chain counters follow the prior block (written after it, matching the
    // guest's read order). 0/absent ⇒ the ordinary resume path, no extra fields.
    let rebase_mode = f.get("rebaseMode").and_then(|v| v.as_u64()).unwrap_or(0);
    s.write(&(rebase_mode as u32));
    // DEPLOYMENT BINDING: keccak(chainid ‖ poolAddress). The guest reads it right after the rebase flag
    // (ahead of read_scan_prior_state) and commits it in the public values. [0;32] when absent (pre-binding
    // fixtures) — write 32 zero bytes so the stream stays in sync.
    match f.get("chainBinding").and_then(|v| v.as_str()) {
        Some(hx) => s.write(&hexv(hx)),
        None => s.write(&vec![0u8; 32]),
    }
    r32(&mut s, &p["poolRoot"]);
    s.write(&p["noteCount"].as_u64().unwrap());
    r32(&mut s, &p["spentRoot"]);
    s.write(&p["spentCount"].as_u64().unwrap());
    let live = p
        .get("live")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    s.write(&(live.len() as u32));
    for kv in live {
        let t = kv.as_array().unwrap();
        // Each live entry is (outpoint key, commitment_hash, asset_id, auth_key, bound) — the guest reads
        // all five (reflect.rs `live_quints`); the digest commits the Bitcoin spend key AND the generation
        // tag. `bound` (0/1) selects the leaf domain; absent (legacy 4-tuple fixture) ⇒ 0.
        r32(&mut s, &t[0]);
        r32(&mut s, &t[1]);
        r32(&mut s, &t[2]);
        r32(&mut s, &t[3]);
        s.write(&(t.get(4).and_then(|v| v.as_u64()).unwrap_or(0) as u8));
    }
    r32(&mut s, &p["burnRoot"]);
    s.write(&p["burnCount"].as_u64().unwrap());
    s.write(&p["height"].as_u64().unwrap());
    let cbtc = p
        .get("cbtcLocks")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    s.write(&(cbtc.len() as u32));
    for kv in cbtc {
        let t = kv.as_array().unwrap();
        r32(&mut s, &t[0]);
        r32(&mut s, &t[1]);
        r32(&mut s, &t[2]);
    }
    // string-or-number (the assembler emits large u64 sats as a string, like the pool reserves below).
    s.write(
        &p.get("cbtcBackingSats")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|x| x.parse::<u64>().ok()))
            })
            .unwrap_or(0),
    );

    // Track B resume state (guest reads it after cbtcBackingSats): the per-pool reserve registry. The
    // assembler emits reserve/share/k_last as strings (u64/u128 exceed JS Number); parse them losslessly.
    let pools = p
        .get("pools")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    s.write(&(pools.len() as u32));
    for pe in pools {
        let u64f = |k: &str| {
            pe[k]
                .as_u64()
                .or_else(|| pe[k].as_str().and_then(|x| x.parse::<u64>().ok()))
                .unwrap_or(0)
        };
        r32(&mut s, &pe["poolId"]);
        r32(&mut s, &pe["assetA"]);
        r32(&mut s, &pe["assetB"]);
        s.write(&u64f("reserveA"));
        s.write(&u64f("reserveB"));
        s.write(&u64f("totalShares"));
        s.write(
            &(if pe["c0Backed"].as_bool().unwrap_or(false) {
                1u32
            } else {
                0u32
            }),
        );
        // The pool's LP swap-fee tier — price-determining registry state (the swap folds re-clear against the
        // CURRENT reserves), read by the guest immediately after `c0_backed` and committed in the pool leaf.
        let fb = u64f("feeBps");
        assert!(fb <= u16::MAX as u64, "feeBps over u16");
        s.write(&(fb as u16));
        let pfb = u64f("protocolFeeBps");
        assert!(pfb <= u16::MAX as u64, "protocolFeeBps over u16");
        s.write(&(pfb as u16));
        s.write(
            &pe.get("kLast")
                .and_then(|v| v.as_str())
                .and_then(|x| x.parse::<u128>().ok())
                .unwrap_or(0u128),
        );
        s.write(&u64f("protocolFeeAccrued"));
        // The pool's capability byte — read by the guest immediately after protocolFeeAccrued and committed in
        // the pool leaf. Written last to match the guest read order.
        let cf = u64f("capabilityFlags");
        assert!(cf <= u8::MAX as u64, "capabilityFlags over u8");
        s.write(&(cf as u8));
    }
    // FAST-LANE resume count: read by the guest at the END of read_scan_prior_state (after the pools). 0 for a
    // forward-only fixture (the gens don't set it). Omitting this desyncs the whole stream → an EOF halt.
    let prior_consumed = p.get("consumedCount").and_then(|v| v.as_u64()).unwrap_or(0);
    s.write(&prior_consumed);
    // FAST-LANE / Mode-B anchor: the eth-reflection accumulator digest committed by the last Mode-B cycle
    // (read right after consumedCount). [0;32] for a never-Mode-B chain — write 32 zero bytes so the stream
    // stays in sync; a non-zero value resumes the eth chain the next Mode-B fold must continue.
    match p.get("ethReflDigest").and_then(|v| v.as_str()) {
        Some(hx) => s.write(&hexv(hx)),
        None => s.write(&vec![0u8; 32]),
    }

    // Fair farms (SPEC-masterchef-farm-stake-anytime §4): the per-farm reward-per-share accumulator handoff,
    // read by the guest right after ethReflDigest (before the Mode-B gate). (farmId, rate, totalShares, rps,
    // totalRewardDebt, lastHeight, …) — the assembler emits the u128s + totalShares as strings. Empty (n=0)
    // for a no-farm chain; omitting it desyncs the stream → an EOF halt.
    let farms = p
        .get("farmRewards")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    s.write(&(farms.len() as u32));
    for fe in farms {
        let u64f = |k: &str| {
            fe[k]
                .as_u64()
                .or_else(|| fe[k].as_str().and_then(|x| x.parse::<u64>().ok()))
                .unwrap_or(0)
        };
        r32(&mut s, &fe["farmId"]);
        s.write(&u64f("rate"));
        s.write(&u64f("totalShares"));
        s.write(
            &fe.get("rps")
                .and_then(|v| v.as_u64().map(|n| n as u128).or_else(|| v.as_str().and_then(|x| x.parse::<u128>().ok())))
                .unwrap_or(0u128),
        );
        // The MasterChef reward debt (Σ shares_i·entry_i over live positions), read between `rps` and
        // `lastHeight`. It sets what a launcher refund must reserve, so it rides digest() like the rest.
        s.write(
            &fe.get("totalRewardDebt")
                .and_then(|v| v.as_u64().map(|n| n as u128).or_else(|| v.as_str().and_then(|x| x.parse::<u128>().ok())))
                .unwrap_or(0u128),
        );
        s.write(&u64f("lastHeight"));
        // launcher_pubkey(33) + lp_asset(32): the farm-leaf binding the guest reads on resume (reflect.rs:206-207).
        // Default to zeros (FarmRewardState::new() / JS ZPUB) when absent so the stream frames either way. Omitting
        // these desynced the guest's r33()/r32() into the Mode-B gate the moment any FARM_INIT carried across resume.
        match fe.get("launcherPubkey").and_then(|v| v.as_str()) {
            Some(_) => r33(&mut s, &fe["launcherPubkey"]),
            None => s.write(&vec![0u8; 33]),
        }
        match fe.get("lpAsset").and_then(|v| v.as_str()) {
            Some(_) => r32(&mut s, &fe["lpAsset"]),
            None => s.write(&vec![0u8; 32]),
        }
        // Campaign window [start, end] the guest reads right after lp_asset (reflect.rs); 0/0 ⇒ perpetual.
        s.write(&u64f("startHeight"));
        s.write(&u64f("endHeight"));
    }

    // Per-position entry stamps (receipt leaf → entry rps), read right after the farm reward set. This is the
    // reflection's `FarmController.entryRps`: the checkpoint is stamped at fold time, so it cannot ride the
    // receipt note and must be handed across cycles. Empty (n=0) until the first bond; omitting it desyncs.
    let stamps = p
        .get("farmEntries")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    s.write(&(stamps.len() as u32));
    for st in stamps {
        r32(&mut s, &st["leaf"]);
        s.write(
            &st.get("entryRps")
                .and_then(|v| v.as_u64().map(|n| n as u128).or_else(|| v.as_str().and_then(|x| x.parse::<u128>().ok())))
                .unwrap_or(0u128),
        );
    }

    // ETH→BTC cross-out replay gate resume — read LAST in read_scan_prior_state (right after the farm
    // entry stamps): the consumed claim_id IMT root + count. Default to the genesis sentinel root (count 1) when
    // absent (a chain with no cross-out mints). Matches digest()'s last field.
    match p.get("consumedCrossoutRoot").and_then(|v| v.as_str()) {
        Some(_) => r32(&mut s, &p["consumedCrossoutRoot"]),
        None => s.write(&hex::decode("5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0").unwrap()),
    }
    s.write(&p.get("consumedCrossoutCount").and_then(|v| v.as_u64()).unwrap_or(1));
    // ETH→BTC honored-message set resume — read right after the cross-out replay gate (matches reflect.rs +
    // digest() order): the honored msg_id IMT root + count. Defaults to the genesis sentinel root (count 1)
    // when absent (a chain that has honored no message).
    match p.get("honoredMsgRoot").and_then(|v| v.as_str()) {
        Some(_) => r32(&mut s, &p["honoredMsgRoot"]),
        None => s.write(&hex::decode("5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0").unwrap()),
    }
    s.write(&p.get("honoredMsgCount").and_then(|v| v.as_u64()).unwrap_or(1));
    // Real cross-out mints folded — read right after the honored-message set (matches reflect.rs + digest() order).
    // Default 0 when absent (genesis / a chain that has folded no 0x65 mint yet).
    s.write(&p.get("foldedCrossoutCount").and_then(|v| v.as_u64()).unwrap_or(0));
    // CROSS-LANE DOUBLE-MINT GATE (matches reflect.rs read order + digest()): the consumed-outpoints IMT root
    // + count, read right after foldedCrossoutCount. `fold_consumed` inserts every fast-lane-retired Bitcoin
    // outpoint here; the scan-free burn-deposit path proves non-membership against it, so the same UTXO can't
    // be minted twice. Default to the empty-IMT sentinel (== imt_empty_root(), count 1) at genesis.
    match p.get("consumedOutpointsRoot").and_then(|v| v.as_str()) {
        Some(_) => r32(&mut s, &p["consumedOutpointsRoot"]),
        None => s.write(&hex::decode("5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0").unwrap()),
    }
    s.write(&p.get("consumedOutpointsCount").and_then(|v| v.as_u64()).unwrap_or(1));

    // GENERATIONAL RESUME drain counters: on a rebase cycle the guest reads the predecessor's CURRENT on-chain
    // fast-lane / cross-out counts here (right after read_scan_prior_state, before the Mode-B gate) and asserts
    // they equal the prior state's folded counts — the drain gate. Written only when rebaseMode is set, so an
    // ordinary cycle's stream is byte-identical to before.
    if rebase_mode != 0 {
        s.write(&f.get("predecessorConsumedCount").and_then(|v| v.as_u64()).unwrap_or(0));
        s.write(&f.get("predecessorCrossOutCount").and_then(|v| v.as_u64()).unwrap_or(0));
    }

    // Mode-B gate (matches reflect.rs): mode_b, then ONLY when set the eth-reflection PV the guest verifies.
    // A forward-only fixture (modeB absent/0) skips it — no eth_pv, no verify_sp1_proof. modeB=1 carries the
    // real `ethPv` (14 abi words = 448 bytes; word 8 == pinned ETH_GENESIS_SYNC_COMMITTEE, word 9 =
    // consumedNuSetRoot, word 10 low-8 = consumedNuCount, word 11 = ethOutbox, word 12 = ethMsgSetRoot,
    // word 13 low-8 = ethMsgCount) for a fold_crossout / fold_consumed / fold_eth_message.
    let mode_b = f.get("modeB").and_then(|v| v.as_u64()).unwrap_or(0);
    s.write(&(mode_b as u32));
    // consumedNuCount drives how many fast-lane consumed witnesses the guest reads (it derives the count
    // from the eth proof, NOT the stream); capture it from ethPv word 10 so the consumed loop can assert it.
    let mut consumed_nu_count = prior_consumed;
    if mode_b != 0 {
        // A real recursion proof carries the eth proof's actual public values (bitcoin_prove asserts
        // ethPv == eth.public_values before proving); the zero-ethPool fallback is for a LOCAL execute only.
        let eth_pv = f
            .get("ethPv")
            .and_then(|v| v.as_str())
            .map(hexv)
            .unwrap_or_else(|| {
                let mut b = vec![0u8; 14 * 32];
                // Word-8 must equal reflect.rs ETH_GENESIS_SYNC_COMMITTEE (the guest's word-8 assert), or a
                // synthetic Mode-B fixture aborts against the pinned mainnet anchor.
                b[8 * 32..9 * 32].copy_from_slice(&hexv(
                    "0x684dc219a2e8855f59564de7f5cc2c8bda79623d20ff43b5628dee8bad217f9a",
                ));
                b
            });
        assert_eq!(
            eth_pv.len(),
            14 * 32,
            "ethPv must be exactly 14 ABI words (448 bytes)"
        );
        consumed_nu_count = u64::from_be_bytes(eth_pv[11 * 32 - 8..11 * 32].try_into().unwrap());
        s.write(&eth_pv);
    }

    s.write(&f["anchorHeight"].as_u64().unwrap());
    let headers = f["headers"].as_array().unwrap();
    s.write(&(headers.len() as u32));
    for hh in headers {
        s.write(&hexv(hh.as_str().unwrap()));
    }

    // FAST LANE (Mode-B): the guest folds the eth-consumed ν set AFTER the headers, BEFORE the block scan
    // (reflect.rs). For each consumed ν: nu, spendRoot, Cx, Cy, srcTxid, srcVout(u32), set_path, then the
    // spent-IMT insert witness — mirror that exact order. A forward fixture has no `consumed` (mode_b=0).
    if mode_b != 0 {
        let consumed = f
            .get("consumed")
            .and_then(|v| v.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        // The guest reads exactly `consumedNuCount - prior.consumedCount` consumed witnesses (it counts them
        // from the eth proof, not the stream), so the fixture must carry exactly that many or the rest of the
        // stream desyncs.
        assert!(
            consumed_nu_count >= prior_consumed,
            "consumedNuCount rolled back below the prior count"
        );
        assert_eq!(consumed.len() as u64, consumed_nu_count - prior_consumed,
            "consumed witness count must equal consumedNuCount - prior.consumedCount (stream would desync)");
        for cons in consumed {
            r32(&mut s, &cons["nu"]);
            r32(&mut s, &cons["consumedVal"]);
            r32(&mut s, &cons["spendRoot"]);
            r32(&mut s, &cons["cx"]);
            r32(&mut s, &cons["cy"]);
            r32(&mut s, &cons["srcTxid"]);
            s.write(&(cons["srcVout"].as_u64().unwrap() as u32));
            path(&mut s, &cons["setPath"]);
            let si = &cons["spentInsert"];
            r32(&mut s, &si["sLowValue"]);
            r32(&mut s, &si["sLowNext"]);
            s.write(&si["sLowIndex"].as_u64().unwrap());
            path(&mut s, &si["sLowPath"]);
            path(&mut s, &si["sNewPath"]);
            let oi = &cons["outpointInsert"];
            r32(&mut s, &oi["oLowValue"]);
            r32(&mut s, &oi["oLowNext"]);
            s.write(&oi["oLowIndex"].as_u64().unwrap());
            path(&mut s, &oi["oLowPath"]);
            path(&mut s, &oi["oNewPath"]);
        }
    }

    // The guest scans exactly one block per header (`for block_index in 0..num_headers`), so a fixture whose
    // block count differs from its header count desyncs the stream — reject it here.
    let blocks = f["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), headers.len(),
        "block count must equal header count (guest scans one block per header)");
    for block in blocks {
        let txs = block["txs"].as_array().unwrap();
        s.write(&(txs.len() as u32));
        for tx in txs {
            s.write(&hexv(tx["txData"].as_str().unwrap()));
        }
        for tx in txs {
            for op in tx["openings"].as_array().unwrap() {
                r32(&mut s, &op["cx"]);
                r32(&mut s, &op["cy"]);
            }
            for si in tx["spentInserts"].as_array().unwrap() {
                r32(&mut s, &si["sLowValue"]);
                r32(&mut s, &si["sLowNext"]);
                s.write(&si["sLowIndex"].as_u64().unwrap());
                path(&mut s, &si["sLowPath"]);
                path(&mut s, &si["sNewPath"]);
            }
            if let Some(bd) = tx.get("burnDeposit").filter(|v| !v.is_null()) {
                write_burn_deposit(&mut s, bd);
            } else if let Some(bi) = tx.get("burnInsert").filter(|v| !v.is_null()) {
                r32(&mut s, &bi["bLowKey"]);
                r32(&mut s, &bi["bLowNext"]);
                r32(&mut s, &bi["bLowValue"]);
                s.write(&bi["bLowIndex"].as_u64().unwrap());
                path(&mut s, &bi["bLowPath"]);
                path(&mut s, &bi["bNewPath"]);
            }
            for o in tx["outputs"].as_array().unwrap() {
                path(&mut s, &o["notePath"]);
            }
            // cBTC.zk self-custody lock (0x66): TRACK-not-mint — the guest folds NO note (the cBTC note is
            // minted later by ConfidentialPool.mintCbtc, gated on the lock + a native-ETH escrow), so per
            // ops/DESIGN-confidential-defi-v1.md §3 there is NO per-0x66 witness to serialize.
            // swap_var (0x32): the guest reads the receipt note-path, then the change note-path iff c_change is
            // non-sentinel, then the settler-tip note-path iff tip_amount > 0 — mirror that exact order.
            if let Some(sw) = tx.get("swapVar").filter(|v| !v.is_null()) {
                path(&mut s, &sw["receiptPath"]);
                if let Some(cp) = sw.get("changePath").filter(|v| !v.is_null()) {
                    path(&mut s, cp);
                }
                if let Some(tp) = sw.get("tipPath").filter(|v| !v.is_null()) {
                    path(&mut s, tp);
                }
            }
            // swap_route (0x33): the guest reads the receipt note's append path after the envelope — mirror it.
            if let Some(rt) = tx.get("swapRoute").filter(|v| !v.is_null()) {
                path(&mut s, &rt["receiptPath"]);
            }
            // swap_batch (0x2F): the guest reads one receipt note-append path per intent (the notes at vouts
            // 1..=n) after the envelope — mirror that order.
            if let Some(sb) = tx.get("swapBatch").filter(|v| !v.is_null()) {
                let rps = sb["receiptPaths"].as_array().unwrap();
                // The guest reads exactly n_intents receipt paths (parsed from the envelope); if the fixture
                // carries the intent count, cross-check the path array against it before serializing.
                if let Some(n) = sb.get("nIntents").and_then(|v| v.as_u64()) {
                    assert_eq!(rps.len() as u64, n,
                        "swapBatch receiptPaths count must equal nIntents (one receipt path per intent)");
                }
                for rp in rps {
                    path(&mut s, rp);
                }
                // Track-C re-armed: after the n receipt paths the guest reads n refund paths (fold_swap_batch
                // onboards n receipts OR n refunds; refunds start at a different tree index so they carry their
                // own paths). Emit them unconditionally, matching the guest's branch-independent read order.
                let fps = sb["refundPaths"].as_array().expect("swapBatch refundPaths (one per intent)");
                assert_eq!(fps.len(), rps.len(),
                    "swapBatch refundPaths count must equal receiptPaths/nIntents");
                for fp in fps {
                    path(&mut s, fp);
                }
            }
            // crossout_mint (0x65, Mode-B reverse): the guest reads the cross-out IMT presence witness
            // (is_member + m_next + m_low_value + m_index + m_path), the note_path, THEN the consumed-cross-out
            // (claim_id) IMT insert witness for any parseable 0x65 (fold_crossout skips in a forward batch —
            // crossout_set_root=0) — mirror that exact order (the replay gate).
            if let Some(cm) = tx.get("crossoutMint").filter(|v| !v.is_null()) {
                s.write(&(cm["isMember"].as_u64().unwrap_or(0) as u32));
                r32(&mut s, &cm["mNext"]);
                r32(&mut s, &cm["mLowValue"]);
                s.write(&cm["mIndex"].as_u64().unwrap());
                path(&mut s, &cm["mPath"]);
                path(&mut s, &cm["notePath"]);
                let ci = &cm["consumedInsert"];
                r32(&mut s, &ci["sLowValue"]);
                r32(&mut s, &ci["sLowNext"]);
                s.write(&ci["sLowIndex"].as_u64().unwrap());
                path(&mut s, &ci["sLowPath"]);
                path(&mut s, &ci["sNewPath"]);
            }
            // eth_call (0x69, ETH→BTC message): the guest reads the message-set membership witness
            // (set_index + set_path) then the honored-set IMT insert witness, for any parseable 0x69 —
            // fold_eth_message skips in a forward batch (eth_msg_set_root = 0) but the reads still happen,
            // so mirror them unconditionally or the stream desyncs into an EOF halt.
            if let Some(ec) = tx.get("ethCall").filter(|v| !v.is_null()) {
                s.write(&ec["setIndex"].as_u64().unwrap());
                path(&mut s, &ec["setPath"]);
                let hi = &ec["honoredInsert"];
                r32(&mut s, &hi["sLowValue"]);
                r32(&mut s, &hi["sLowNext"]);
                s.write(&hi["sLowIndex"].as_u64().unwrap());
                path(&mut s, &hi["sLowPath"]);
                path(&mut s, &hi["sNewPath"]);
            }
            // lp_add / POOL_INIT (0x2D): share_r + the two refund blindings are ON-CHAIN (option a; the guest
            // parses them), so the witnesses are just two append paths, emitted UNCONDITIONALLY. The guest reads
            // both on every 0x2D: the accept branch onboards the share note at path0 (path1 read-but-unused),
            // the refund branch onboards refund note A at path0 + refund note B at path1. Emitting both on every
            // branch keeps the stream byte-identical across the state-dependent accept-vs-refund decision.
            if let Some(la) = tx.get("lpAdd").filter(|v| !v.is_null()) {
                path(&mut s, &la["path0"]);
                path(&mut s, &la["path1"]);
            }
            // lp_remove (0x2E): r_recv_a/b are ON-CHAIN (option a; the guest parses them), so the only
            // witnesses are the note-append paths. THREE are always fed (branch-independent, mirroring the
            // guest 0x2E dispatcher): recvA @path0, recvB @path1 (accept branch), and the vout-2 share-refund
            // @path2 (zero-payout-leg branch). The un-taken branch's paths are read-but-unused.
            if let Some(lr) = tx.get("lpRemove").filter(|v| !v.is_null()) {
                path(&mut s, &lr["recvAPath"]);
                path(&mut s, &lr["recvBPath"]);
                path(&mut s, &lr["refundPath"]);
            }
            // farm-init (0x34): the founder-refund append path, emitted UNCONDITIONALLY (branch-independent,
            // mirror the guest) — a well-formed init reads-but-ignores it; an init that loses its farm_id /
            // expires onboards the treasury refund note at it. The prior treasury-only init carried no witness.
            if let Some(fi) = tx.get("farmInit").filter(|v| !v.is_null()) {
                path(&mut s, &fi["refundPath"]);
            }
            // lp_bond (0x35): owner + nonce now ride the PUBLIC 0x35 envelope (trustless), so the guest reads them
            // from the envelope — the witness stream carries ONLY the receipt's append path (reused as the
            // refund note's append path when the bond loses its receipt leaf).
            if let Some(lb) = tx.get("lpBond").filter(|v| !v.is_null()) {
                path(&mut s, &lb["receiptPath"]);
            }
            // harvest (0x3B): TRUSTLESS — the receipt's (owner, nonce, shares) ride the 0x3B envelope, so the
            // guest reads them from the envelope; the stamp model re-stamps the receipt entry in place (no
            // nullifier IMT insert, no advanced-receipt append). The witness stream carries exactly three
            // tree-position witnesses, in this order: old index, the receipt membership path, then the reward
            // note's append path (fold_harvest). Mirror that exact order.
            if let Some(hv) = tx.get("harvest").filter(|v| !v.is_null()) {
                s.write(&hv["oldIndex"].as_u64().unwrap_or(0));
                path(&mut s, &hv["oldPath"]);
                path(&mut s, &hv["notePath"]); // the reward note's append path (fold_harvest)
            }
            // farm-refund (0x3E): one note-append path (the launcher's refund note; still the public-r treasury
            // draw — no receipt). A tx carries exactly one of bond/harvest/refund/unbond, so only one set fires.
            if let Some(fr) = tx.get("farmRefund").filter(|v| !v.is_null()) {
                path(&mut s, &fr["notePath"]);
            }
            // lp_unbond (0x36): TRUSTLESS — the guest reads (owner, nonce, old index + membership
            // path, the receipt-nullifier IMT insert) to retire the receipt + drop the shares. Mirror that order.
            // owner/nonce/shares now ride the 0x36 envelope (trustless); the witness stream carries
            // only the tree-position witnesses + the lp-return note's append path.
            if let Some(ub) = tx.get("lpUnbond").filter(|v| !v.is_null()) {
                s.write(&ub["oldIndex"].as_u64().unwrap_or(0));
                path(&mut s, &ub["oldPath"]);
                let si = &ub["spentInsert"];
                r32(&mut s, &si["sLowValue"]);
                r32(&mut s, &si["sLowNext"]);
                s.write(&si["sLowIndex"].as_u64().unwrap_or(0));
                path(&mut s, &si["sLowPath"]);
                path(&mut s, &si["sNewPath"]);
                path(&mut s, &ub["lpReturnPath"]); // the lp-share return note's append path (vout[1])
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
