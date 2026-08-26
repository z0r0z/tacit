// OP_SWAP_BLIND (31 / 0x1F) box harness (not part of the crate build). Mirrors exec-swap.rs.
// NOTE: OP_SWAP_BLIND is HARD-DISABLED in this generation — the guest arm is proof-fatal, so an
// execute/prove run against this harness now aborts by design. Kept as the dormant-path record for
// a later guest that re-enables the op once it is box-validated end-to-end and an emitter exists.
// Reads the OP_SWAP_BLIND envelope from a fixture JSON, writes it to SP1Stdin in the EXACT guest
// io::read()/r32()/r33() order (src/main.rs:1665..1865), then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert swaps[0] == expected.
//   MODE=groth16           — GPU Groth16 prove + write public_values.hex + proof_bytes.hex.
//
// Each stdin.write below is annotated with the guest source line it mirrors, so the read order is
// reviewable line-by-line against main.rs.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TODO — FIXTURE REGENERATION (BLOCKER for a real run).
//
// The existing fixtures/swapbatch_op.json is an OP_SWAP (op 6) fixture — cleartext amountIn/
// amountOut/rem, single per-note secp opening sigmas (inSigR/inSigZ), and NO Groth16 proof. It
// CANNOT drive OP_SWAP_BLIND, which is prover-blind and needs a different envelope. A new
// fixtures/swapblind_op.json must be generated (by dapp/confidential-swapblind.js →
// buildSwapBlindOp, the settle-side emitter) carrying ALL of:
//
//   globals:  assetA, assetB, feeBps (≤1000), protocolFeeBps==0, protocolFeeRecipient(33B, may be 0),
//             reserveAPre, reserveBPre,
//             deltaANetSign/Mag, deltaBNetSign/Mag  (the batch's net reserve move),
//             rNetA(32B), rNetB(32B)                (per-asset aggregate Pedersen blindings),
//             tipAAmount==0, tipACSecp(33B)=Pedersen(0,rTipA), rTipA(32B),
//             tipBAmount==0, tipBCSecp(33B)=Pedersen(0,rTipB), rTipB(32B),
//   proof:    a REAL 256-byte amm_swap_batch Groth16 proof over the 123 public signals, produced
//             under the FINALIZED ceremony zkey whose VK == the guest's baked batch_vk()
//             (== fixtures/swap_batch_vk.json; ceremony hash
//             2d9db81d741e59d65e1b52ac3d37c5da521ef8c3728e9cd715c9a8a45bd495f4). The publics MUST be
//             re-derivable by swap_batch::swap_batch_public_signals(env, circuit_pool_id,
//             reserveAPre, reserveBPre) — i.e. pool_id_fr = SHA256(amm_derive_pool_id_v1(assetA,
//             assetB, feeBps)) mod r, with the per-intent BJJ commitments matching cInBjj/cOutBjj.
//   intents[] (n≤16, each): direction(0=A→B,1=B→A),
//             inCx,inCy(on-curve secp), inOwner, inLeafIndex, inPath(32 hashes) → leaf must be a
//             real member of spendRoot; cInBjj(32B packed BJJ), inXcurveSigma(169B) binding
//             C_in_secp↔C_in_bjj; minOut, deadline;
//             outCx,outCy, outOwner, cOutBjj(32B), outXcurveSigma(169B);
//             pokR(33B), pokZv(32B), pokZr(32B) — verify_opening_pok_blind over the intent context
//             (b"tacit-swap-blind-intent-v1", chainBinding, assetA, assetB,
//              [(inCx,inCy,inOwner),(outCx,outCy,outOwner)], [direction,minOut,deadline]).
//   expected: poolId (== pool_id_with_protocol_fee(assetA,assetB,feeBps,recipient,0)),
//             reserveAPost, reserveBPost, nullifiers[], leaves[].
//
// The single-trader witness demo (dapp/circuits/amm/dev-zkey/demo_swap_batch.mjs) shows the
// clearing/witness math; fixtures/gen-swapbatch-ceremony-vector.mjs shows the real-ceremony proving
// command. The emitter ties these into a full settle envelope.
// ─────────────────────────────────────────────────────────────────────────────────────────────
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};
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
    stdin.write(&hexv(f["rNetA"].as_str().unwrap())); // main.rs:1695  r_net_a = r32()
    stdin.write(&hexv(f["rNetB"].as_str().unwrap())); // main.rs:1696  r_net_b = r32()
    // Relay tips FORCED to 0 (guest asserts tip_a_amount == 0 && tip_b_amount == 0, main.rs:1718).
    stdin.write(&f["tipAAmount"].as_u64().unwrap_or(0)); // main.rs:1699  tip_a_amount: u64 (== 0)
    stdin.write(&hexv(f["tipACSecp"].as_str().unwrap())); // main.rs:1700  tip_a_c_secp = r33()  (Pedersen(0,rTipA))
    stdin.write(&hexv(f["rTipA"].as_str().unwrap()));     // main.rs:1701  r_tip_a = r32()
    stdin.write(&f["tipBAmount"].as_u64().unwrap_or(0)); // main.rs:1702  tip_b_amount: u64 (== 0)
    stdin.write(&hexv(f["tipBCSecp"].as_str().unwrap())); // main.rs:1703  tip_b_c_secp = r33()  (Pedersen(0,rTipB))
    stdin.write(&hexv(f["rTipB"].as_str().unwrap()));     // main.rs:1704  r_tip_b = r32()

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

        stdin.write(&it["minOut"].as_u64().unwrap());          // main.rs:1766  min_out: u64
        stdin.write(&it["deadline"].as_u64().unwrap_or(0));    // main.rs:1767  intent_deadline: u64

        // Output (receipt) note: r_commitment() (main.rs:1773) then owner + BJJ twin + sigma.
        stdin.write(&hexv(it["outCx"].as_str().unwrap())); // main.rs:1773  r_commitment → out_cx = r32()
        stdin.write(&hexv(it["outCy"].as_str().unwrap())); // main.rs:1773  r_commitment → out_cy = r32()
        stdin.write(&hexv(it["outOwner"].as_str().unwrap())); // main.rs:1774  out_owner = r32()
        stdin.write(&hexv(it["cOutBjj"].as_str().unwrap()));  // main.rs:1776  c_out_bjj = r32()
        // main.rs:1777  out_sig_v: Vec<u8> = io::read()  (asserted len == 169)
        let out_sig = hexv(it["outXcurveSigma"].as_str().unwrap());
        assert_eq!(out_sig.len(), 169, "output xcurve sigma must be 169 bytes");
        stdin.write(&out_sig);

        // Intent authorization (anti-redirect blind opening PoK).
        stdin.write(&hexv(it["pokR"].as_str().unwrap()));  // main.rs:1786  pok_r = r33()  (compressed)
        stdin.write(&hexv(it["pokZv"].as_str().unwrap())); // main.rs:1787  pok_z_v = r32()
        stdin.write(&hexv(it["pokZr"].as_str().unwrap())); // main.rs:1788  pok_z_r = r32()
    }

    // CP-04 memo tail: the guest reads exactly (leaves + lock_leaves) keccak256("") memo hashes
    // after all ops; over-supplying is harmless (leftover stdin is ignored). Same as exec-swap.rs.
    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

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
        assert!(pv.fees.is_empty(), "tips == 0 ⇒ no fee payments");
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
    println!(
        "PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
