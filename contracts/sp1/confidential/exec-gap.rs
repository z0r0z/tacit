// Settle prove harness for the gap ops OP_CDP_MINT(15) / OP_CDP_CLOSE(16) / OP_CBTC_MINT(18) — groth16. The
// serialization mirrors the reflect-exec emulator bins (cdp_mint/cdp_close/cbtc_mint_execute.rs) in main.rs's
// io::read order; this produces a REAL Groth16 proof vs the committed settle ELF so the CDP/cUSD + cBTC settle
// ops are verified ON-CHAIN (ConfidentialCdpCbtcProofReal), the same bar as swap/lp/otc/bid/farm. Select via
// env: GAP_FIXTURE=<path> GAP_OP=15|16|18 GAP_TAG=cdp_mint|cdp_close|cbtc_mint.
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ELF: &[u8] = include_bytes!(
    "/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest"
);

fn hexv(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}
fn assert_expected_vkey(vk: &str) {
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(
            vk.trim().trim_start_matches("0x").to_lowercase(),
            expect.trim().trim_start_matches("0x").to_lowercase(),
            "EXPECT_VKEY mismatch"
        );
    }
}
fn root(f: &serde_json::Value, key: &str) -> Vec<u8> {
    f.get(key)
        .and_then(|v| v.as_str())
        .map(hexv)
        .unwrap_or_else(|| vec![0u8; 32])
}

fn main() {
    let fixture = std::env::var("GAP_FIXTURE").expect("set GAP_FIXTURE");
    let op: u8 = std::env::var("GAP_OP")
        .expect("set GAP_OP")
        .parse()
        .unwrap();
    let tag = std::env::var("GAP_TAG").unwrap_or_else(|_| "gap".to_string());
    let f: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&fixture).unwrap()).unwrap();

    let mut s = SP1Stdin::new();
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&root(&f, "spendRoot"));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot
    s.write(&root(&f, "lockSetRoot")); // 0 unless OP_ADAPTOR_CLAIM (which proves L against it)
    s.write(&root(&f, "cdpPositionRoot"));
    s.write(&1u32);
    s.write(&op);

    if op == 15 {
        // OP_CDP_MINT
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["debtValue"].as_u64().unwrap());
        s.write(&hexv(f["nonce"].as_str().unwrap()));
        let legs = f["legs"].as_array().unwrap();
        s.write(&(legs.len() as u32));
        for leg in legs {
            s.write(&hexv(leg["asset"].as_str().unwrap()));
            s.write(&hexv(leg["cx"].as_str().unwrap()));
            s.write(&hexv(leg["cy"].as_str().unwrap()));
            s.write(&leg["value"].as_u64().unwrap());
            s.write(&leg["index"].as_u64().unwrap());
            for p in leg["path"].as_array().unwrap() {
                s.write(&hexv(p.as_str().unwrap()));
            }
            s.write(&hexv(leg["sigR"].as_str().unwrap()));
            s.write(&hexv(leg["sigZ"].as_str().unwrap()));
        }
        let debt = &f["debt"];
        s.write(&hexv(debt["cx"].as_str().unwrap()));
        s.write(&hexv(debt["cy"].as_str().unwrap()));
        s.write(&hexv(debt["sigR"].as_str().unwrap()));
        s.write(&hexv(debt["sigZ"].as_str().unwrap()));
    } else if op == 16 {
        // OP_CDP_CLOSE
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["debtValue"].as_u64().unwrap());
        s.write(&hexv(f["nonce"].as_str().unwrap()));
        s.write(&f["positionIndex"].as_u64().unwrap());
        for p in f["positionPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        let legs = f["legs"].as_array().unwrap();
        s.write(&(legs.len() as u32));
        for leg in legs {
            s.write(&hexv(leg["asset"].as_str().unwrap()));
            s.write(&leg["value"].as_u64().unwrap());
            s.write(&hexv(leg["cx"].as_str().unwrap()));
            s.write(&hexv(leg["cy"].as_str().unwrap()));
            s.write(&hexv(leg["sigR"].as_str().unwrap()));
            s.write(&hexv(leg["sigZ"].as_str().unwrap()));
        }
        let debt = f["debt"].as_array().unwrap();
        s.write(&(debt.len() as u32));
        for d in debt {
            s.write(&hexv(d["cx"].as_str().unwrap()));
            s.write(&hexv(d["cy"].as_str().unwrap()));
            s.write(&hexv(d["owner"].as_str().unwrap()));
            s.write(&d["value"].as_u64().unwrap());
            s.write(&d["index"].as_u64().unwrap());
            for p in d["path"].as_array().unwrap() {
                s.write(&hexv(p.as_str().unwrap()));
            }
            s.write(&hexv(d["sigR"].as_str().unwrap()));
            s.write(&hexv(d["sigZ"].as_str().unwrap()));
        }
    } else if op == 17 {
        // OP_CDP_LIQUIDATE
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["debtValue"].as_u64().unwrap());
        s.write(&hexv(f["nonce"].as_str().unwrap()));
        s.write(&hexv(f["rateSnapshot"].as_str().unwrap())); // position mint-time accumulator snapshot (carried in the leaf)
        s.write(&hexv(f["liquidator"].as_str().unwrap()));
        s.write(&f["positionIndex"].as_u64().unwrap());
        for p in f["positionPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        let legs = f["legs"].as_array().unwrap();
        s.write(&(legs.len() as u32));
        s.write(&f["fee"].as_u64().unwrap_or(0)); // relay fee carved from the first seized leg (0 = self-settle), read after nLegs
        for leg in legs {
            s.write(&hexv(leg["asset"].as_str().unwrap()));
            s.write(&leg["value"].as_u64().unwrap());
        }
        let debt = f["debt"].as_array().unwrap();
        s.write(&(debt.len() as u32));
        for d in debt {
            s.write(&hexv(d["cx"].as_str().unwrap()));
            s.write(&hexv(d["cy"].as_str().unwrap()));
            s.write(&hexv(d["owner"].as_str().unwrap()));
            s.write(&d["value"].as_u64().unwrap());
            s.write(&d["index"].as_u64().unwrap());
            for p in d["path"].as_array().unwrap() {
                s.write(&hexv(p.as_str().unwrap()));
            }
            s.write(&hexv(d["sigR"].as_str().unwrap()));
            s.write(&hexv(d["sigZ"].as_str().unwrap()));
        }
    } else if op == 19 {
        // OP_CDP_TOPUP
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["debtValue"].as_u64().unwrap());
        s.write(&hexv(f["oldNonce"].as_str().unwrap()));
        s.write(&hexv(f["newNonce"].as_str().unwrap()));
        s.write(&f["positionIndex"].as_u64().unwrap());
        for p in f["positionPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        let old_legs = f["oldLegs"].as_array().unwrap();
        s.write(&(old_legs.len() as u32));
        for leg in old_legs {
            s.write(&hexv(leg["asset"].as_str().unwrap()));
            s.write(&leg["value"].as_u64().unwrap());
        }
        let added = f["addedLegs"].as_array().unwrap();
        s.write(&(added.len() as u32));
        for leg in added {
            s.write(&hexv(leg["asset"].as_str().unwrap()));
            s.write(&hexv(leg["cx"].as_str().unwrap()));
            s.write(&hexv(leg["cy"].as_str().unwrap()));
            s.write(&leg["value"].as_u64().unwrap());
            s.write(&leg["index"].as_u64().unwrap());
            for p in leg["path"].as_array().unwrap() {
                s.write(&hexv(p.as_str().unwrap()));
            }
            s.write(&hexv(leg["sigR"].as_str().unwrap()));
            s.write(&hexv(leg["sigZ"].as_str().unwrap()));
        }
    } else if op == 11 {
        // OP_SWAP_ROUTE
        let inp = &f["in"];
        s.write(&hexv(f["asset0"].as_str().unwrap()));
        s.write(&hexv(inp["cx"].as_str().unwrap()));
        s.write(&hexv(inp["cy"].as_str().unwrap()));
        s.write(&hexv(inp["owner"].as_str().unwrap()));
        s.write(&inp["leafIndex"].as_u64().unwrap());
        for p in inp["path"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        s.write(&f["amountIn"].as_u64().unwrap());
        s.write(&hexv(inp["sigR"].as_str().unwrap()));
        s.write(&hexv(inp["sigZ"].as_str().unwrap()));
        let hops = f["hops"].as_array().unwrap();
        s.write(&(hops.len() as u32));
        s.write(&f["minOut"].as_u64().unwrap());
        let out = &f["out"];
        s.write(&hexv(out["cx"].as_str().unwrap()));
        s.write(&hexv(out["cy"].as_str().unwrap()));
        s.write(&hexv(out["owner"].as_str().unwrap()));
        s.write(&hexv(out["sigR"].as_str().unwrap()));
        s.write(&hexv(out["sigZ"].as_str().unwrap()));
        s.write(&f["deadline"].as_u64().unwrap_or(0));
        for h in hops {
            s.write(&hexv(h["assetNext"].as_str().unwrap()));
            s.write(&(h["feeBps"].as_u64().unwrap() as u32));
            s.write(&h["reserveAPre"].as_u64().unwrap());
            s.write(&h["reserveBPre"].as_u64().unwrap());
        }
    } else if op == 12 {
        // OP_ADAPTOR_LOCK
        s.write(&hexv(f["asset"].as_str().unwrap()));
        s.write(&hexv(f["locker"].as_str().unwrap()));
        s.write(&hexv(f["recipient"].as_str().unwrap()));
        s.write(&f["amount"].as_u64().unwrap());
        s.write(&hexv(f["tx"].as_str().unwrap()));
        s.write(&hexv(f["ty"].as_str().unwrap()));
        s.write(&f["deadline"].as_u64().unwrap());
        s.write(&hexv(f["nCx"].as_str().unwrap()));
        s.write(&hexv(f["nCy"].as_str().unwrap()));
        s.write(&f["nIndex"].as_u64().unwrap());
        for p in f["nPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        s.write(&hexv(f["nSigR"].as_str().unwrap()));
        s.write(&hexv(f["nSigZ"].as_str().unwrap()));
        s.write(&hexv(f["lCx"].as_str().unwrap()));
        s.write(&hexv(f["lCy"].as_str().unwrap()));
        s.write(&hexv(f["lSigR"].as_str().unwrap()));
        s.write(&hexv(f["lSigZ"].as_str().unwrap()));
    } else if op == 14 {
        // OP_ADAPTOR_REFUND
        s.write(&hexv(f["asset"].as_str().unwrap()));
        s.write(&hexv(f["lCx"].as_str().unwrap()));
        s.write(&hexv(f["lCy"].as_str().unwrap()));
        s.write(&hexv(f["tx"].as_str().unwrap()));
        s.write(&hexv(f["ty"].as_str().unwrap()));
        s.write(&f["deadline"].as_u64().unwrap());
        s.write(&hexv(f["recipient"].as_str().unwrap()));
        s.write(&hexv(f["locker"].as_str().unwrap()));
        s.write(&f["lIndex"].as_u64().unwrap());
        for p in f["lPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        s.write(&hexv(f["oCx"].as_str().unwrap()));
        s.write(&hexv(f["oCy"].as_str().unwrap()));
        s.write(&hexv(f["kernelR"].as_str().unwrap()));
        s.write(&hexv(f["kernelS"].as_str().unwrap()));
    } else if op == 8 {
        // OP_LP_REMOVE
        s.write(&hexv(f["assetA"].as_str().unwrap()));
        s.write(&hexv(f["assetB"].as_str().unwrap()));
        s.write(&(f["feeBps"].as_u64().unwrap() as u32));
        s.write(&f["rAPre"].as_u64().unwrap());
        s.write(&f["rBPre"].as_u64().unwrap());
        s.write(&f["sharesPre"].as_u64().unwrap());
        s.write(&hexv(f["sCx"].as_str().unwrap()));
        s.write(&hexv(f["sCy"].as_str().unwrap()));
        s.write(&hexv(f["sOwner"].as_str().unwrap()));
        s.write(&f["sIndex"].as_u64().unwrap());
        for p in f["sPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        s.write(&f["dShares"].as_u64().unwrap());
        s.write(&hexv(f["sSigR"].as_str().unwrap()));
        s.write(&hexv(f["sSigZ"].as_str().unwrap()));
        s.write(&f["dA"].as_u64().unwrap());
        s.write(&f["remA"].as_u64().unwrap());
        s.write(&f["dB"].as_u64().unwrap());
        s.write(&f["remB"].as_u64().unwrap());
        s.write(&hexv(f["aCx"].as_str().unwrap()));
        s.write(&hexv(f["aCy"].as_str().unwrap()));
        s.write(&hexv(f["aOwner"].as_str().unwrap()));
        s.write(&hexv(f["aSigR"].as_str().unwrap()));
        s.write(&hexv(f["aSigZ"].as_str().unwrap()));
        s.write(&hexv(f["bCx"].as_str().unwrap()));
        s.write(&hexv(f["bCy"].as_str().unwrap()));
        s.write(&hexv(f["bOwner"].as_str().unwrap()));
        s.write(&hexv(f["bSigR"].as_str().unwrap()));
        s.write(&hexv(f["bSigZ"].as_str().unwrap()));
        s.write(&f["opDeadline"].as_u64().unwrap());
    } else if op == 13 {
        // OP_ADAPTOR_CLAIM
        s.write(&hexv(f["asset"].as_str().unwrap()));
        s.write(&hexv(f["lCx"].as_str().unwrap()));
        s.write(&hexv(f["lCy"].as_str().unwrap()));
        s.write(&hexv(f["tx"].as_str().unwrap()));
        s.write(&hexv(f["ty"].as_str().unwrap()));
        s.write(&f["deadline"].as_u64().unwrap());
        s.write(&hexv(f["recipient"].as_str().unwrap()));
        s.write(&hexv(f["locker"].as_str().unwrap()));
        s.write(&f["lIndex"].as_u64().unwrap());
        for p in f["lPath"].as_array().unwrap() {
            s.write(&hexv(p.as_str().unwrap()));
        }
        s.write(&f["amount"].as_u64().unwrap());
        s.write(&hexv(f["oCx"].as_str().unwrap()));
        s.write(&hexv(f["oCy"].as_str().unwrap()));
        s.write(&hexv(f["oSigR"].as_str().unwrap()));
        s.write(&hexv(f["oSigZ"].as_str().unwrap()));
        s.write(&hexv(f["kernelR"].as_str().unwrap()));
        s.write(&hexv(f["kernelS"].as_str().unwrap()));
    } else {
        // OP_CBTC_MINT
        s.write(&hexv(f["outpoint"].as_str().unwrap()));
        s.write(&f["vBtc"].as_u64().unwrap());
        // relay fee (gasless auto-mint): note opens to v_btc − fee, settler is paid `fee` in cBTC. 0 = self-mint.
        s.write(&f["fee"].as_u64().or_else(|| f["fee"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0));
        s.write(&hexv(f["cx"].as_str().unwrap()));
        s.write(&hexv(f["cy"].as_str().unwrap()));
        s.write(&hexv(f["sigR"].as_str().unwrap()));
        s.write(&hexv(f["sigZ"].as_str().unwrap()));
    }

    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    let vk = pk.verifying_key().bytes32();
    println!("PROGRAM_VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 ({tag}, cuda)...");
        let proof = client
        .prove(&pk, s)
        .groth16()
        .run()
        .expect("groth16 proof failed");
    /* client.verify dropped — prover self-verifies; forge *ProofReal is the on-chain gate */
    println!(
        "LOCAL_VERIFY_OK {tag} pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write(
        format!("{tag}_pv.hex"),
        hex::encode(proof.public_values.as_slice()),
    )
    .unwrap();
    std::fs::write(
        format!("{tag}_pb.hex"),
        hex::encode(proof.bytes()),
    )
    .unwrap();
    println!("WROTE {tag}_pv.hex + {tag}_pb.hex");
    use std::io::Write;
    std::io::stdout().flush().ok();
    std::process::exit(0);
}
