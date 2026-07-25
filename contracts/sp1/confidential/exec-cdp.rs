// CDP box harness (not part of the crate build) — covers OP_CDP_MINT (15), OP_CDP_TOPUP (19) and
// OP_WRAP_CDP_MINT (30). Reads fixtures/cdp_op.json; MODE=execute (default) or MODE=groth16.
//
// WHY THIS FILE EXISTS: the only serializer that covered CDP ops was exec-gap.rs, which is stale (see its
// banner). These three ops just received a security fix that MOVED witness fields, so they need a harness
// that matches the guest exactly:
//   * CDP_MINT / WRAP_CDP_MINT: `fee` and the debt commitment + its sigma are now read BEFORE the collateral
//     legs, because each collateral authorization must BIND them (a relayer could otherwise keep every value
//     the borrower signed, substitute its own debt commitment, and take the loan as "fee").
//   * CDP_TOPUP: a trailing owner BIP-340 signature (R‖s, 32+32) now authorizes the position replacement.
// The `sol!` block is copied VERBATIM from the guest so PublicValues decoding cannot drift.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
use alloy_sol_types::{sol, SolValue};

const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

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
    let f: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/cdp_op.json").unwrap()).unwrap();
    let op = f["op"].as_u64().unwrap() as u8; // 15 = CDP_MINT, 19 = CDP_TOPUP, 30 = WRAP_CDP_MINT
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot
    stdin.write(&vec![0u8; 32]); // lockSetRoot
    stdin.write(&hexv(f["cdpPositionRoot"].as_str().unwrap_or(&"00".repeat(32))));
    stdin.write(&1u32);          // numOps
    stdin.write(&op);

    let path_of = |v: &serde_json::Value| -> Vec<String> {
        v.as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect()
    };

    if op == 15 || op == 30 {
        stdin.write(&hexv(f["controller"].as_str().unwrap()));
        stdin.write(&hexv(f["owner"].as_str().unwrap()));
        stdin.write(&f["debtValue"].as_u64().unwrap());
        stdin.write(&hexv(f["nonce"].as_str().unwrap()));
        stdin.write(&hexv(f["rateSnapshot"].as_str().unwrap()));
        // --- moved AHEAD of the legs so every collateral sigma binds them ---
        stdin.write(&f["fee"].as_u64().unwrap_or(0));
        stdin.write(&hexv(f["debtCx"].as_str().unwrap()));
        stdin.write(&hexv(f["debtCy"].as_str().unwrap()));
        stdin.write(&hexv(f["debtSigR"].as_str().unwrap()));
        stdin.write(&hexv(f["debtSigZ"].as_str().unwrap()));

        let legs = f["legs"].as_array().unwrap();
        stdin.write(&(legs.len() as u32));
        for l in legs {
            stdin.write(&hexv(l["asset"].as_str().unwrap()));
            if op == 15 {
                // note-collateral: commitment, value, index, path, sigma
                stdin.write(&hexv(l["cx"].as_str().unwrap()));
                stdin.write(&hexv(l["cy"].as_str().unwrap()));
                stdin.write(&l["value"].as_u64().unwrap());
                stdin.write(&l["leafIndex"].as_u64().unwrap());
                for p in path_of(&l["path"]) { stdin.write(&hexv(&p)); }
            } else {
                // deposit-collateral: value first, then the deposit commitment
                stdin.write(&l["value"].as_u64().unwrap());
                stdin.write(&hexv(l["cx"].as_str().unwrap()));
                stdin.write(&hexv(l["cy"].as_str().unwrap()));
            }
            stdin.write(&hexv(l["sigR"].as_str().unwrap()));
            stdin.write(&hexv(l["sigZ"].as_str().unwrap()));
        }
    } else {
        // OP_CDP_TOPUP
        stdin.write(&hexv(f["controller"].as_str().unwrap()));
        stdin.write(&hexv(f["owner"].as_str().unwrap()));
        stdin.write(&f["debtValue"].as_u64().unwrap());
        stdin.write(&hexv(f["oldNonce"].as_str().unwrap()));
        stdin.write(&hexv(f["newNonce"].as_str().unwrap()));
        stdin.write(&hexv(f["rateSnapshot"].as_str().unwrap()));
        stdin.write(&f["positionIndex"].as_u64().unwrap());
        for p in path_of(&f["positionPath"]) { stdin.write(&hexv(&p)); }

        let old_legs = f["oldLegs"].as_array().unwrap();
        stdin.write(&(old_legs.len() as u32));
        for l in old_legs {
            stdin.write(&hexv(l["asset"].as_str().unwrap()));
            stdin.write(&l["value"].as_u64().unwrap());
        }
        let added = f["addedLegs"].as_array().unwrap();
        stdin.write(&(added.len() as u32));
        for l in added {
            stdin.write(&hexv(l["asset"].as_str().unwrap()));
            stdin.write(&hexv(l["cx"].as_str().unwrap()));
            stdin.write(&hexv(l["cy"].as_str().unwrap()));
            stdin.write(&l["value"].as_u64().unwrap());
            stdin.write(&l["leafIndex"].as_u64().unwrap());
            for p in path_of(&l["path"]) { stdin.write(&hexv(&p)); }
            stdin.write(&hexv(l["sigR"].as_str().unwrap()));
            stdin.write(&hexv(l["sigZ"].as_str().unwrap()));
        }
        // NEW: owner BIP-340 authorization over (old leaf, old ν, new leaf, added legs, debt), as R(32)‖s(32).
        let osig = hexv(f["ownerSig"].as_str().unwrap());
        stdin.write(&osig[..32].to_vec());
        stdin.write(&osig[32..].to_vec());
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());

    if mode == "execute" {
        let (public_values, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        let pv = PublicValues::abi_decode(public_values.as_slice(), true).expect("decode pv");
        match op {
            15 => assert_eq!(pv.cdpMints.len(), 1, "one CdpMint"),
            30 => assert_eq!(pv.cdpMints.len(), 1, "one CdpMint (wrap-funded)"),
            _  => assert_eq!(pv.cdpTopups.len(), 1, "one CdpTopup"),
        }
        println!("OK cdp op={} cycles={}", op, report.total_instruction_count());
    } else {
        let proof = client.prove(&pk, stdin).groth16().run().expect("prove failed");
        std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
        std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
        println!("OK cdp groth16 written");
    }
}
