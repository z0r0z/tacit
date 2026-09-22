// OP_SWAP_BLIND (31 / 0x1F) box harness (not part of the crate build). Mirrors exec-swap.rs.
//
// The guest arm runs the real clearing. An execute against the committed elf/cxfer-guest returns:
//
//     EXECUTE_OK cycles=7611678765 swaps=1 reserves 1000000/1000000→1001000/999004 tips A=0 B=0
//
// matching fixtures/swapblind_op.json's `expected` (in-guest BN254 Groth16 verify, per-asset conservation
// kernels, cross-curve sigmas, blind PoKs and the k-check all pass; the fixture carries a real 256-byte
// amm_swap_batch proof).
//
// Cost: 7.6e9 cycles is for a ONE-INTENT batch. The Groth16 verify (swap_blind.rs, one groth16_bn254_verify
// over the whole envelope) is a FIXED cost; only the per-intent loop (membership, xcurve sigma, blind PoK,
// BP+ range) scales, so cost per trader is roughly fixed/n_intents + marginal, and the guest caps n_intents
// at 16. Every other settle harness proves under cycle_limit(256_000_000); this one sets 16_000_000_000
// below, and the relay fee has to be priced for the real cycle cost.
//
// The Bitcoin lane runs the SAME verify (swap_batch.rs fold_swap_batch → groth16_bn254_verify over the
// same batch_vk()), but inside a reflection proof that is produced anyway, and that lane already
// budgets ETHPROVE_CYCLE_LIMIT=3e9 rather than 256e6 — so its marginal cost is the verify added to an
// existing proof rather than a separate proof needing its own fee. Cheaper in kind, still not free.
//
// Reads the OP_SWAP_BLIND envelope from a fixture JSON, writes it to SP1Stdin in the EXACT guest
// io::read()/r32()/r33() order (src/main.rs:1665..1865), then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert swaps[0] == expected.
//   MODE=groth16           — GPU Groth16 prove + write public_values.hex + proof_bytes.hex.
//
// Each stdin.write below is annotated with the guest source line it mirrors, so the read order is
// reviewable line-by-line against main.rs.
//
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};
use alloy_sol_types::{sol, SolValue};

const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));
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
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; uint256 cutA; uint256 cutB; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct CdpLeg { bytes32 asset; uint256 value; }
    struct CdpMint { address controller; bytes32 debtAsset; uint256 debtValue; bytes32 positionLeaf; uint256 rateSnapshot; CdpLeg[] legs; bytes32 owner; }
    struct CdpClose { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpLiquidate { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpTopup {
        address controller;
        uint256 debtValue;
        uint256 rateSnapshot;
        bytes32 oldPositionNullifier;
        bytes32 newPositionLeaf;
        CdpLeg[] oldLegs;
        CdpLeg[] newLegs;
    }
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
        // The FULL authenticated source leaf — btc_note_leaf(asset‖Cx‖Cy‖auth_key) — of each Bitcoin-homed
        // consumed input, aligned 1:1 with `nullifiers` (a btcHomed batch has one per note input; see
        // `input_leaf_authed`). The contract folds it into the `bitcoinConsumed` record as
        // keccak(spendRoot‖sourceLeaf), and cxfer-core `fold_consumed` rebuilds that leaf from the live
        // outpoint's OWN asset AND Bitcoin auth key — so the reverse reflection retires the EXACT note signed
        // here, not merely one sharing its commitment+asset. NOT the bare asset id: narrowing it would break
        // fold_consumed's keccak equality. Empty for native batches.
        bytes32[] bitcoinConsumedSources;
        // Source-specific burn_id per bridge_mint (the one-mint gate key), 1:1 with bitcoinBurnsConsumed.
        // APPENDED LAST: the ConfidentialRouter reads a HARDCODED calldata offset for cdpMints (field index 22),
        // so a new field must go at the end — inserting mid-struct would shift that offset and break the router.
        bytes32[] bitcoinBurnIdsConsumed;
        // One-shot ids for farm/savings harvests, in cdpMints order — one per harvest mint (positionLeaf == 1,
        // debtValue > 0). The pool consumes each before its controller callback + fee payout, so a copied
        // harvest proof cannot be replayed after the controller's reward window re-accrues. Appended last.
        bytes32[] harvestActionIds;
    }
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("OP_FILE")
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/swapblind_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();

    // ── batch header (main.rs:461..483), identical framing to exec-swap.rs ──────────────────────
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap())); // main.rs:461  chain_binding = r32()
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));    // main.rs:462  spend_root = r32()
    stdin.write(&vec![0u8; 32]); // main.rs:465  bitcoin_spent_root = r32()  (0 = Ethereum-only)
    stdin.write(&vec![0u8; 32]); // main.rs:476  bitcoin_burn_root  = r32()  (0)
    stdin.write(&vec![0u8; 32]); // main.rs:479  lock_set_root      = r32()  (0)
    stdin.write(&vec![0u8; 32]); // main.rs:482  cdp_position_root  = r32()  (0)
    stdin.write(&1u32);          // main.rs:483  num_ops: u32 = io::read()
    stdin.write(&31u8);          // per-op opType u8 = OP_SWAP_BLIND (31)

    // ── OP_SWAP_BLIND body ──────────────────────────────────────────────────────────────────────
    stdin.write(&hexv(f["assetA"].as_str().unwrap())); // main.rs:1677  asset_a = r32()
    stdin.write(&hexv(f["assetB"].as_str().unwrap())); // main.rs:1678  asset_b = r32()
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32)); // main.rs:1679  fee_bps: u32 (≤1000)
    let protocol_fee_bps = f["protocolFeeBps"].as_u64().unwrap_or(0) as u32;
    stdin.write(&protocol_fee_bps); // main.rs:1681  protocol_fee_bps: u32 (asserted == 0)
    // main.rs:1683  protocol_fee_recipient = r33()  (bound into the EVM pool id; may be all-zero)
    stdin.write(&f["protocolFeeRecipient"].as_str().map(hexv).unwrap_or_else(|| vec![0u8; 33]));
    stdin.write(&f["reserveAPre"].as_u64().unwrap()); // main.rs:1689  reserve_a_pre: u64
    stdin.write(&f["reserveBPre"].as_u64().unwrap()); // main.rs:1690  reserve_b_pre: u64
    stdin.write(&(f["deltaANetSign"].as_u64().unwrap() as u8)); // main.rs:1691  delta_a_net_sign: u8
    stdin.write(&f["deltaANetMag"].as_u64().unwrap());          // main.rs:1692  delta_a_net_mag: u64
    stdin.write(&(f["deltaBNetSign"].as_u64().unwrap() as u8)); // main.rs:1693  delta_b_net_sign: u8
    stdin.write(&f["deltaBNetMag"].as_u64().unwrap());          // main.rs:1694  delta_b_net_mag: u64
    // Per-asset conservation kernels (R 33B, z 32B), A then B; the aggregate blindings never reach the prover.
    stdin.write(&hexv(f["kernelA"]["R"].as_str().unwrap())); // kernel_a.r = r33()
    stdin.write(&hexv(f["kernelA"]["z"].as_str().unwrap())); // kernel_a.z = r32()
    stdin.write(&hexv(f["kernelB"]["R"].as_str().unwrap())); // kernel_b.r = r33()
    stdin.write(&hexv(f["kernelB"]["z"].as_str().unwrap())); // kernel_b.z = r32()
    // Global per-asset relay tips (paid to msg.sender; bound to their commitments + Σ per-intent tips).
    stdin.write(&f["tipAAmount"].as_u64().unwrap_or(0)); // tip_a_amount: u64
    stdin.write(&hexv(f["tipACSecp"].as_str().unwrap())); // tip_a_c_secp = r33()  (Pedersen(tipA,rTipA))
    stdin.write(&hexv(f["rTipA"].as_str().unwrap()));     // r_tip_a = r32()
    stdin.write(&f["tipBAmount"].as_u64().unwrap_or(0)); // tip_b_amount: u64
    stdin.write(&hexv(f["tipBCSecp"].as_str().unwrap())); // tip_b_c_secp = r33()  (Pedersen(tipB,rTipB))
    stdin.write(&hexv(f["rTipB"].as_str().unwrap()));     // r_tip_b = r32()

    let intents = f["intents"].as_array().unwrap();
    stdin.write(&(intents.len() as u32)); // main.rs:1722  n_intents: u32 (0 < n ≤ 16)
    stdin.write(&hexv(f["proof"].as_str().unwrap())); // main.rs:1727  proof: Vec<u8> = io::read()  (256 B)

    for it in intents {
        stdin.write(&(it["direction"].as_u64().unwrap() as u8)); // main.rs:1732  direction: u8

        // Input note: r_commitment() (main.rs:1742) then owner + membership witness.
        stdin.write(&hexv(it["inCx"].as_str().unwrap())); // main.rs:1742  r_commitment → in_cx = r32()
        stdin.write(&hexv(it["inCy"].as_str().unwrap())); // main.rs:1742  r_commitment → in_cy = r32()
        stdin.write(&hexv(it["inOwner"].as_str().unwrap())); // main.rs:1743  in_owner = r32()
        stdin.write(&it["inLeafIndex"].as_u64().unwrap());   // main.rs:1744  in_leaf_index: u64
        // main.rs:1745  in_path = r_path() → 32 × r32()
        let path = it["inPath"].as_array().expect("in path");
        assert_eq!(path.len(), 32, "in_path must be 32 hashes");
        for p in path { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(it["inNk"].as_str().unwrap())); // in_nk = r32() (native secret nullifier key)

        stdin.write(&hexv(it["cInBjj"].as_str().unwrap())); // main.rs:1760  c_in_bjj = r32()
        // main.rs:1761  in_sig_v: Vec<u8> = io::read()  (asserted len == 169)
        let in_sig = hexv(it["inXcurveSigma"].as_str().unwrap());
        assert_eq!(in_sig.len(), 169, "input xcurve sigma must be 169 bytes");
        stdin.write(&in_sig);

        stdin.write(&it["minOut"].as_u64().unwrap());          // min_out: u64
        stdin.write(&it["deadline"].as_u64().unwrap_or(0));    // intent_deadline: u64
        stdin.write(&it["tip"].as_u64().unwrap_or(0));         // tip_amount: u64 (bound into the PoK ctx)

        // Output (receipt) note: r_commitment() (main.rs:1773) then owner + BJJ twin + sigma.
        stdin.write(&hexv(it["outCx"].as_str().unwrap())); // main.rs:1773  r_commitment → out_cx = r32()
        stdin.write(&hexv(it["outCy"].as_str().unwrap())); // main.rs:1773  r_commitment → out_cy = r32()
        stdin.write(&hexv(it["outOwner"].as_str().unwrap())); // main.rs:1774  out_owner = r32()
        stdin.write(&hexv(it["cOutBjj"].as_str().unwrap()));  // main.rs:1776  c_out_bjj = r32()
        // main.rs:1777  out_sig_v: Vec<u8> = io::read()  (asserted len == 169)
        let out_sig = hexv(it["outXcurveSigma"].as_str().unwrap());
        assert_eq!(out_sig.len(), 169, "output xcurve sigma must be 169 bytes");
        stdin.write(&out_sig);
        // main.rs: out_range_proof: Vec<u8> = io::read() — the receipt's own m=1 BP+ proof over C_out_secp
        // (the sigma binds the two curves' residues only; this bounds the secp note's real value).
        stdin.write(&hexv(it["outRangeProof"].as_str().unwrap()));

        // Intent authorization (anti-redirect blind opening PoK).
        stdin.write(&hexv(it["pokR"].as_str().unwrap()));  // main.rs:1786  pok_r = r33()  (compressed)
        stdin.write(&hexv(it["pokZv"].as_str().unwrap())); // main.rs:1787  pok_z_v = r32()
        stdin.write(&hexv(it["pokZr"].as_str().unwrap())); // main.rs:1788  pok_z_r = r32()
    }

    // CP-04 memo tail: the guest reads exactly (leaves + lock_leaves) keccak256("") memo hashes
    // after all ops; over-supplying is harmless (leftover stdin is ignored). Same as exec-swap.rs.
    { let empty = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"; let mh: Vec<String> = f.get("memoHashes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(); if f.get("memoHashes").is_some() { for h in &mh { stdin.write(&hexv(h)); } } else { for _ in 0..64usize { stdin.write(&hexv(empty)); } } }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());

    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
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
        // OP_SWAP_BLIND is no-skim: cutA/cutB are published as 0 (main.rs:1855-1856).
        assert_eq!(s.cutA, alloy_sol_types::private::U256::ZERO, "cutA == 0 (no-skim)");
        assert_eq!(s.cutB, alloy_sol_types::private::U256::ZERO, "cutB == 0 (no-skim)");
        assert_eq!(pv.nullifiers.len(), intents.len(), "one nullifier per intent");
        assert_eq!(pv.leaves.len(), intents.len(), "one output leaf per intent");
        // Each non-zero global tip is paid to msg.sender as one FeePayment (asset A before asset B).
        let tip_a = f["tipAAmount"].as_u64().unwrap_or(0);
        let tip_b = f["tipBAmount"].as_u64().unwrap_or(0);
        let mut expected_fees: Vec<(Vec<u8>, u64)> = Vec::new();
        if tip_a != 0 { expected_fees.push((hexv(f["assetA"].as_str().unwrap()), tip_a)); }
        if tip_b != 0 { expected_fees.push((hexv(f["assetB"].as_str().unwrap()), tip_b)); }
        assert_eq!(pv.fees.len(), expected_fees.len(), "one fee payment per non-zero tip");
        for (fee, (asset, amt)) in pv.fees.iter().zip(expected_fees.iter()) {
            assert_eq!(fee.assetId.as_slice(), asset.as_slice(), "tip fee asset");
            assert_eq!(fee.value, alloy_sol_types::private::U256::from(*amt), "tip fee amount");
        }
        println!(
            "EXECUTE_OK cycles={} swaps=1 reserves {}/{}→{}/{} tips A={} B={}",
            report.total_instruction_count(),
            f["reserveAPre"],
            f["reserveBPre"],
            s.reserveAPost,
            s.reserveBPost,
            tip_a,
            tip_b
        );
        return;
    }

    // Network proving (not CPU+native-gnark): this op's in-guest Groth16 verification of the
    // amm_swap_batch ceremony proof runs into the billions of cycles (~7.6B for a 1-intent batch in execute
    // mode), far past what the box's cgroup memory cap can carry through a local native-gnark wrap — the
    // same reason every other settle harness uses .network(). Generous explicit limits so the SDK submits straight to the network instead of
    // re-executing locally first to estimate them (this host cannot cheaply re-run a 7.6B-cycle guest).
    let client = ProverClient::builder().network().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("VKEY={vk}");
    assert_expected_vkey(&vk);
    println!("proving groth16 (network)...");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .cycle_limit(16_000_000_000)
        .gas_limit(16_000_000_000)
        .run()
        .expect("groth16 proof failed");
    println!(
        "PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
