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
fn u32w(s: &mut SP1Stdin, v: &serde_json::Value, k: &str) {
    let x = v[k].as_u64().unwrap_or_else(|| panic!("u32 field {k}"));
    assert!(x <= u32::MAX as u64, "{k} over u32");
    s.write(&(x as u32));
}

// TAC burn-deposit witness (reflect.rs read order for a 0x2B burn of a non-live-set note).
fn write_burn_deposit(s: &mut SP1Stdin, bd: &serde_json::Value) {
    h(s, bd, "etchTx");
    u32w(s, bd, "etchIndex");
    let esib = bd["etchSiblings"].as_array().unwrap();
    s.write(&(esib.len() as u32));
    for x in esib {
        r32(s, x);
    }
    let ewsib = bd["etchWtxidSiblings"]
        .as_array()
        .expect("etchWtxidSiblings array");
    s.write(&(ewsib.len() as u32));
    for x in ewsib {
        r32(s, x);
    }
    h(s, bd, "etchCoinbase");
    let ecbsib = bd["etchCoinbaseTxidSiblings"]
        .as_array()
        .expect("etchCoinbaseTxidSiblings array");
    s.write(&(ecbsib.len() as u32));
    for x in ecbsib {
        r32(s, x);
    }
    let phs = bd["provHeaders"].as_array().unwrap();
    s.write(&(phs.len() as u32));
    for hh in phs {
        s.write(&hexv(hh.as_str().unwrap()));
    }
    let cxfers = bd["cxfers"].as_array().unwrap();
    s.write(&(cxfers.len() as u32));
    for c in cxfers {
        h(s, c, "tx");
        let ins = c["inputCommitments"]
            .as_array()
            .expect("inputCommitments array");
        s.write(&(ins.len() as u32));
        for i in ins {
            let b = hexv(i.as_str().expect("input commitment"));
            assert_eq!(b.len(), 33, "input commitment must be exactly 33 bytes");
            s.write(&b);
        }
        let outs = c["outputVouts"].as_array().expect("outputVouts array");
        s.write(&(outs.len() as u32));
        for o in outs {
            let x = o.as_u64().expect("output vout");
            assert!(x <= u32::MAX as u64, "output vout over u32");
            s.write(&(x as u32));
        }
        s.write(&c["burnedAmount"].as_u64().unwrap_or(0)); // 0 for a transfer, > 0 for a CBURN step
        let msib = c["merkleSiblings"].as_array().unwrap();
        s.write(&(msib.len() as u32));
        for x in msib {
            r32(s, x);
        }
        u32w(s, c, "merkleIndex");
        r32(s, &c["confirmedBlockRoot"]);
        let wsib = c["wtxidSiblings"].as_array().expect("wtxidSiblings array");
        s.write(&(wsib.len() as u32));
        for x in wsib {
            r32(s, x);
        }
        h(s, c, "coinbase");
        let cbsib = c["coinbaseTxidSiblings"]
            .as_array()
            .expect("coinbaseTxidSiblings array");
        s.write(&(cbsib.len() as u32));
        for x in cbsib {
            r32(s, x);
        }
    }
    // mintable: issuer-authorized cmints (reveal tx + commit tx + reveal merkle inclusion). Empty for fixed.
    let cmints = bd
        .get("cmints")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    s.write(&(cmints.len() as u32));
    for cm in cmints {
        h(s, cm, "revealTx");
        h(s, cm, "commitTx");
        let msib = cm["merkleSiblings"].as_array().unwrap();
        s.write(&(msib.len() as u32));
        for x in msib {
            s.write(&hexv(x.as_str().unwrap()));
        }
        u32w(s, cm, "merkleIndex");
        let rwsib = cm["revealWtxidSiblings"]
            .as_array()
            .expect("revealWtxidSiblings array");
        s.write(&(rwsib.len() as u32));
        for x in rwsib {
            r32(s, x);
        }
        h(s, cm, "revealCoinbase");
        let rcbsib = cm["revealCoinbaseTxidSiblings"]
            .as_array()
            .expect("revealCoinbaseTxidSiblings array");
        s.write(&(rcbsib.len() as u32));
        for x in rcbsib {
            r32(s, x);
        }
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
    path(s, &bd["notePath"]); // the burned note's pool-tree append path (onboard it as a pool member)
}

/// Serialize a reflection fixture (the dapp assembler's `assembleReflectionScanInput` output) into the
/// guest's exact `io::read` order. Returns a fresh `SP1Stdin`; a recursion prover may `write_proof` onto it.
pub fn write_stdin(f: &serde_json::Value) -> SP1Stdin {
    let p = &f["prior"];
    let mut s = SP1Stdin::new();
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
        r32(&mut s, &t[0]);
        r32(&mut s, &t[1]);
        r32(&mut s, &t[2]);
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

    // Fair farms (SPEC-CONTROLLER-VAULT-AMENDMENT §4): the per-farm reward-per-share accumulator handoff, read
    // by the guest right after ethReflDigest (before the Mode-B gate). (farmId, rate, totalShares, rps,
    // lastHeight) — the assembler emits rps (u128) + totalShares (u64) as strings. Empty (n=0) for a no-farm
    // chain; omitting it desyncs the stream → an EOF halt.
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
        s.write(&u64f("lastHeight"));
    }

    // Mode-B gate (matches reflect.rs): mode_b, then ONLY when set the eth-reflection PV the guest verifies.
    // A forward-only fixture (modeB absent/0) skips it — no eth_pv, no verify_sp1_proof. modeB=1 carries the
    // real `ethPv` (11 abi words = 352 bytes; word 8 == pinned ETH_GENESIS_SYNC_COMMITTEE, word 9 =
    // consumedNuSetRoot, word 10 low-8 = consumedNuCount) for a fold_crossout / fold_consumed.
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
                let mut b = vec![0u8; 11 * 32];
                b[8 * 32..9 * 32].copy_from_slice(&hexv(
                    "0x8a83300119ac1e64a2318d3db330ed496c51276c636a93633b2d5cfd283c2d44",
                ));
                b
            });
        assert_eq!(
            eth_pv.len(),
            11 * 32,
            "ethPv must be exactly 11 ABI words (352 bytes)"
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
        }
    }

    for block in f["blocks"].as_array().unwrap() {
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
            // swap_var (0x32): the guest reads the receipt note-path (+ the change note-path iff
            // non-sentinel) after the envelope — mirror that order.
            if let Some(sw) = tx.get("swapVar").filter(|v| !v.is_null()) {
                path(&mut s, &sw["receiptPath"]);
                if let Some(cp) = sw.get("changePath").filter(|v| !v.is_null()) {
                    path(&mut s, cp);
                }
            }
            // swap_route (0x33): the guest reads the receipt note's append path after the envelope — mirror it.
            if let Some(rt) = tx.get("swapRoute").filter(|v| !v.is_null()) {
                path(&mut s, &rt["receiptPath"]);
            }
            // swap_batch (0x2F): the guest reads one receipt note-append path per intent (the notes at vouts
            // 1..=n) after the envelope — mirror that order.
            if let Some(sb) = tx.get("swapBatch").filter(|v| !v.is_null()) {
                for rp in sb["receiptPaths"].as_array().unwrap() {
                    path(&mut s, rp);
                }
            }
            // crossout_mint (0x65, Mode-B reverse): the guest reads set_index + set_path + note_path for any
            // parseable 0x65 (fold_crossout skips in a forward batch — crossout_set_root=0) — mirror that order.
            if let Some(cm) = tx.get("crossoutMint").filter(|v| !v.is_null()) {
                s.write(&cm["setIndex"].as_u64().unwrap());
                path(&mut s, &cm["setPath"]);
                path(&mut s, &cm["notePath"]);
            }
            // lp_add / POOL_INIT (0x2D): share_r is ON-CHAIN (option a; the guest parses it), so the only
            // witness is the minted share note's append path.
            if let Some(la) = tx.get("lpAdd").filter(|v| !v.is_null()) {
                path(&mut s, &la["sharePath"]);
            }
            // lp_remove (0x2E): r_recv_a/b are ON-CHAIN (option a; the guest parses them), so the only
            // witnesses are the two recv note-append paths.
            if let Some(lr) = tx.get("lpRemove").filter(|v| !v.is_null()) {
                path(&mut s, &lr["recvAPath"]);
                path(&mut s, &lr["recvBPath"]);
            }
            // lp_bond (0x35): owner + nonce now ride the PUBLIC 0x35 envelope (trustless), so the guest reads them
            // from the envelope — the witness stream carries ONLY the receipt's append path.
            if let Some(lb) = tx.get("lpBond").filter(|v| !v.is_null()) {
                path(&mut s, &lb["receiptPath"]);
            }
            // harvest (0x3B): TRUSTLESS — the OLD receipt's (owner, old/new nonce, shares, rps_entry) now ride the
            // 0x3B envelope, so the guest reads them from the envelope; the witness stream carries only the
            // tree-position witnesses: old index + membership path, the receipt-nullifier IMT insert, the advanced
            // receipt's append path, then the reward note's append path (fold_harvest). Mirror that exact order.
            if let Some(hv) = tx.get("harvest").filter(|v| !v.is_null()) {
                s.write(&hv["oldIndex"].as_u64().unwrap_or(0));
                path(&mut s, &hv["oldPath"]);
                let si = &hv["spentInsert"];
                r32(&mut s, &si["sLowValue"]);
                r32(&mut s, &si["sLowNext"]);
                s.write(&si["sLowIndex"].as_u64().unwrap_or(0));
                path(&mut s, &si["sLowPath"]);
                path(&mut s, &si["sNewPath"]);
                path(&mut s, &hv["newReceiptPath"]);
                path(&mut s, &hv["notePath"]); // the reward note's append path (fold_harvest)
            }
            // farm-refund (0x3E): one note-append path (the launcher's refund note; still the public-r treasury
            // draw — no receipt). A tx carries exactly one of bond/harvest/refund/unbond, so only one set fires.
            if let Some(fr) = tx.get("farmRefund").filter(|v| !v.is_null()) {
                path(&mut s, &fr["notePath"]);
            }
            // lp_unbond (0x36): TRUSTLESS — the guest reads (owner, nonce, rps_entry, old index + membership
            // path, the receipt-nullifier IMT insert) to retire the receipt + drop the shares. Mirror that order.
            // owner/nonce/rps_entry/shares now ride the 0x36 envelope (trustless); the witness stream carries
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
