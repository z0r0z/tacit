// OP_SWAP box harness (not part of the crate build). Reads fixtures/swap_op.json, writes the
// confidential batch in the guest's io::read order, then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert swaps[0] == expected
//                            (fast: validates the new op without a proof).
//   MODE=groth16           — GPU Groth16 prove + local verify, writing public_values.hex +
//                            proof_bytes.hex for a Forge real-proof test (the C-3 re-prove uses
//                            the new ELF's vkey via setup()).
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};
// `verifying_key()` is the `ProvingKey` trait method (sp1_sdk::ProvingKey) on the EnvProvingKey
// that setup() returns; `bytes32()` is `HashableKey`. Both must be in scope.
use alloy_sol_types::{sol, SolValue};

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

sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    // Generic CDP (ops/DESIGN-confidential-defi-v1.md §4). A leg = one basket collateral (asset, public value).
    struct CdpLeg { bytes32 asset; uint256 value; }
    // OP_CDP_MINT: the contract appends `positionLeaf` to its position set + calls
    // controller.onCdpMint(legs, debtValue); it MUST check debtAsset == cdp_debt_asset_id(controller).
    // `rateSnapshot` = the controller debt accumulator captured at mint (the leaf commits it); `repaid` =
    // cUSD burned at close (== the accrued debt the controller enforces). The guest carries these verbatim —
    // all fee math is the controller's. Dormant (rate == RAY): rateSnapshot == rate so repaid == debtValue.
    // `owner` is PUBLISHED (the position leaf's preimage, with nonce fixed at 0) so a keeper can reconstruct
    // the leaf and liquidate permissionlessly against the live oracle. It is a FRESH per-position value
    // (unlinkable to the borrower's other notes; EVM notes are bearer, so it is leaf-binding only, never a
    // spend key) — publishing it doxxes nothing while making the position liquidatable. The fresh owner alone
    // gives the leaf its uniqueness, so the position nonce is fixed at 0 and needs no separate field.
    struct CdpMint { address controller; bytes32 debtAsset; uint256 debtValue; bytes32 positionLeaf; uint256 rateSnapshot; CdpLeg[] legs; bytes32 owner; }
    // OP_CDP_CLOSE: the contract dedups `positionNullifier` + calls controller.onCdpClose(debtValue, repaid, ...).
    struct CdpClose { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    // OP_CDP_LIQUIDATE: burn debt notes summing to the accrued debt, then the contract dedups
    // `positionNullifier` + calls controller.onCdpLiquidate (reverts if healthy); seized legs ride `withdrawals`.
    struct CdpLiquidate { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    // OP_CDP_TOPUP: consume an existing position and append a same-debt replacement with a larger basket.
    // The controller authorizes the replacement health; outstanding debt is unchanged. The snapshot carries
    // forward unchanged (accrual is uninterrupted). Both nonces are pinned to 0 (like the mint) so the
    // replacement leaf is keeper-reconstructable from the public legs + the mint-published owner (recoverable
    // via this op's oldPositionNullifier → the originating mint), keeping every position liquidatable.
    struct CdpTopup {
        address controller;
        uint256 debtValue;
        uint256 rateSnapshot;
        bytes32 oldPositionNullifier;
        bytes32 newPositionLeaf;
        CdpLeg[] oldLegs;
        CdpLeg[] newLegs;
    }
    // OP_CBTC_MINT (ops/DESIGN-confidential-defi-v1.md §3.2): mint cBTC against a reflection-recorded
    // self-custody lock. The guest verified the note opens to EXACTLY `vBtc` (the conservation peg); the
    // contract checks cbtcLock[outpoint].vBtc == vBtc + commitment match + !cbtcMinted + the CollateralEngine
    // escrow, then inserts the cBTC leaf (which rides `leaves`). bridge_mint-shaped.
    struct CbtcMint { bytes32 outpoint; uint256 vBtc; bytes32 commitment; }
    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot;
        bytes32[] nullifiers;
        bytes32[] leaves;
        bytes32[] depositsConsumed;
        Withdrawal[] withdrawals;
        FeePayment[] fees;
        bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts;
        bytes32[] bitcoinRootsUsed;
        bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot;
        SwapSettlement[] swaps;
        LpSettlement[] liquidity;
        uint64 deadline; // settle expiry (unix secs); 0 = none. The box can't relay a stale proof past it (Expired)
        // ── adaptor-swap (ops 12–14): the cross-chain atomic-swap lock-set ──────────────────────────
        bytes32 lockSetRoot; // INPUT: the lock-set root claim/refund membership is proven against (contract checks == stored)
        bytes32[] lockLeaves; // adaptor_lock_leaf values appended to the lock-set by OP_ADAPTOR_LOCK
        bytes32[] lockNullifiers; // ν_L consumed by claim/refund → the lock-spent set (spend-once, contract dedups)
        bytes32[] adaptorClaimS; // the completed kernel `s` per claim — the t-reveal channel the Bitcoin counterparty reads
        uint64 refundNotBefore; // contract gate: block.timestamp >= this for the batch (max refund deadline; 0 = no refunds)
        // ── generic CDP (ops 15–17, 19) ────────────────────────────────────────────────────────────────
        bytes32 cdpPositionRoot; // INPUT: position-set root CLOSE/LIQUIDATE/TOPUP prove membership against
        CdpMint[] cdpMints;          // open: append positionLeaf to the position set + controller.onCdpMint authorizes
        CdpClose[] cdpCloses;        // close: dedup positionNullifier + controller.onCdpClose accounting
        CdpLiquidate[] cdpLiquidations; // liquidate: dedup positionNullifier + controller.onCdpLiquidate (reverts if healthy)
        CdpTopup[] cdpTopups;        // top-up: consume old position + append replacement with larger basket
        CbtcMint[] cbtcMints;        // cBTC mint: contract gates on the recorded lock + the native-ETH escrow
        bytes32 memoRoot;            // CP-04: keccak chain over keccak(memo_i) for each note leaf then lock leaf
    }
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("OP_FILE")
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/swap_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund in this batch)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    stdin.write(&1u32); // numOps
    stdin.write(&6u8); // OP_SWAP
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32)); // pool fee tier — binds the pool id
    // Per-swap protocol/creator fee config (guest reads these right after fee_bps, before the pool_id):
    // protocol_fee_bps (0 = no-skim) then the 33B recipient pubkey. The guest derives the 6-arg pool_id.
    let protocol_fee_bps = f["protocolFeeBps"].as_u64().unwrap_or(0) as u32;
    stdin.write(&protocol_fee_bps);
    stdin.write(&f["protocolFeeRecipient"].as_str().map(hexv).unwrap_or_else(|| vec![0u8; 33]));
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["priceNum"].as_u64().unwrap());
    stdin.write(&f["priceDen"].as_u64().unwrap());
    let intents = f["intents"].as_array().unwrap();
    stdin.write(&(intents.len() as u32));
    for it in intents {
        stdin.write(&(it["direction"].as_u64().unwrap() as u8));
        // MULTI-NOTE INPUT + PARTIAL SWAPS: the intent's inputs are an ARRAY, each with its OWN blind
        // opening PoK (R‖z_v‖z_r). Membership binds each input's asset (the leaf is built with the
        // direction-derived in_asset), so a note of another asset is simply not in the tree. `amountIn`
        // stays the PUBLIC amount that clears; any surplus returns as change below. A legacy single-note
        // fixture (flat inCx/inCy) is normalised to a one-element array.
        let one;
        let ins: &Vec<serde_json::Value> = match it["inputs"].as_array() {
            Some(v) => v,
            None => {
                one = vec![serde_json::json!({
                    "cx": it["inCx"], "cy": it["inCy"], "owner": it["inOwner"],
                    "leafIndex": it["inLeafIndex"], "path": it["inPath"],
                    "pokR": it["inPokR"], "pokZv": it["inPokZv"], "pokZr": it["inPokZr"],
                })];
                &one
            }
        };
        stdin.write(&(ins.len() as u32));
        for n in ins {
            stdin.write(&hexv(n["cx"].as_str().unwrap()));
            stdin.write(&hexv(n["cy"].as_str().unwrap()));
            stdin.write(&hexv(n["owner"].as_str().unwrap()));
            stdin.write(&n["leafIndex"].as_u64().unwrap());
            for p in n["path"].as_array().expect("in path") { stdin.write(&hexv(p.as_str().unwrap())); }
            stdin.write(&hexv(n["pokR"].as_str().expect("swap: pokR")));
            stdin.write(&hexv(n["pokZv"].as_str().expect("swap: pokZv")));
            stdin.write(&hexv(n["pokZr"].as_str().expect("swap: pokZr")));
        }
        stdin.write(&it["amountIn"].as_u64().unwrap());
        stdin.write(&it["fee"].as_u64().unwrap_or(0)); // relay fee (0 = self-settle), after amountIn
        stdin.write(&it["amountOut"].as_u64().unwrap());
        stdin.write(&it["rem"].as_u64().unwrap());
        stdin.write(&it["minOut"].as_u64().unwrap());
        stdin.write(&it["deadline"].as_u64().unwrap_or(0)); // intent_deadline (guest main.rs:440), after minOut
        stdin.write(&hexv(it["outCx"].as_str().unwrap()));
        stdin.write(&hexv(it["outCy"].as_str().unwrap()));
        stdin.write(&hexv(it["outOwner"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigR"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigZ"].as_str().unwrap()));

        // Per-intent change tail, in the INPUT asset (never the output asset). Count must be a legal BP+
        // aggregation size {0,1,2,4,8}; the kernel proves Σ inputs == amountIn + Σ change.
        let empty: Vec<serde_json::Value> = Vec::new();
        let ch = it["change"].as_array().unwrap_or(&empty);
        stdin.write(&(ch.len() as u32));
        for c in ch {
            stdin.write(&hexv(c["cx"].as_str().unwrap()));
            stdin.write(&hexv(c["cy"].as_str().unwrap()));
            stdin.write(&hexv(c["owner"].as_str().unwrap()));
        }
        if !ch.is_empty() {
            stdin.write(&hexv(it["changeRangeProof"].as_str().expect("swap: changeRangeProof")));
        }
        stdin.write(&hexv(it["changeKernelR"].as_str().expect("swap: changeKernelR")));
        stdin.write(&hexv(it["changeKernelZ"].as_str().expect("swap: changeKernelZ")));
    }

    // Per-swap protocol-fee treasury notes (read AFTER the intent loop, only for a fee pool): the guest reads
    // one stealth-lock note (cx, cy, opening-sigma R+z) per NON-ZERO per-asset cut, in [A, B] order. The
    // fixture pre-computes them (cut = gross_in·fee_bps·protocol_fee_bps/1e8). No-skim pools carry none.
    if protocol_fee_bps != 0 {
        if let Some(notes) = f["treasuryNotes"].as_array() {
            for n in notes {
                stdin.write(&hexv(n["cx"].as_str().unwrap()));
                stdin.write(&hexv(n["cy"].as_str().unwrap()));
                stdin.write(&hexv(n["sigR"].as_str().unwrap()));
                stdin.write(&hexv(n["sigZ"].as_str().unwrap()));
            }
        }
    }

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());

    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        // The vkey is deterministic from the ELF — capture it here (the C-3 pin) without a proof.
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        let vk = pk.verifying_key().bytes32();
        println!("VKEY={vk}");
        assert_expected_vkey(&vk);
        let (public_values, report) = client
            .execute(Elf::Static(ELF), stdin)
            .run()
            .expect("execute failed");
        std::fs::write("public_values.hex", hex::encode(public_values.as_slice())).expect("pv write");
        println!("WROTE_PV len={}", public_values.as_slice().len());
        return;
        #[allow(unreachable_code)]
        let pv = PublicValues::abi_decode(public_values.as_slice(), true).expect("decode pv");
        let ex = &f["expected"];
        assert_eq!(pv.swaps.len(), 1, "one swap settlement");
        let s = &pv.swaps[0];
        assert_eq!(
            hex::encode(s.poolId.0),
            ex["poolId"].as_str().unwrap().trim_start_matches("0x"),
            "poolId"
        );
        assert_eq!(
            s.reserveAPost,
            alloy_sol_types::private::U256::from(ex["reserveAPost"].as_u64().unwrap()),
            "reserveAPost"
        );
        assert_eq!(
            s.reserveBPost,
            alloy_sol_types::private::U256::from(ex["reserveBPost"].as_u64().unwrap()),
            "reserveBPost"
        );
        assert_eq!(pv.nullifiers.len(), 1, "one nullifier");
        assert_eq!(pv.leaves.len(), 1, "one output leaf");
        println!(
            "EXECUTE_OK cycles={} swaps=1 reserves {}/{}→{}/{}",
            report.total_instruction_count(),
            f["reserveAPre"],
            f["reserveBPre"],
            s.reserveAPost,
            s.reserveBPost
        );
        return;
    }

    let client = ProverClient::builder().cpu().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!(
        "PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write(
        "public_values.hex",
        hex::encode(proof.public_values.as_slice()),
    )
    .unwrap();
    std::fs::write(
        "proof_bytes.hex",
        hex::encode(proof.bytes()),
    )
    .unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
