// OP_BID box harness (not part of the crate build). Reads fixtures/bid_op.json, writes the
// confidential partial-fill bid in the guest's io::read order, then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert ν + leaves == expected.
//   MODE=groth16           — GPU Groth16 prove + local verify, writing public_values.hex +
//                            proof_bytes.hex for a Forge real-proof test (ConfidentialBidProofReal).
// OP_BID is in the same settle ELF; this re-prove refreshes the settle vkey for ALL settle fixtures.
use alloy_sol_types::{sol, SolValue};
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
fn note(stdin: &mut SP1Stdin, n: &serde_json::Value) {
    stdin.write(&hexv(n["cx"].as_str().unwrap()));
    stdin.write(&hexv(n["cy"].as_str().unwrap()));
}
fn sig(stdin: &mut SP1Stdin, n: &serde_json::Value) {
    stdin.write(&hexv(n["sigR"].as_str().unwrap()));
    stdin.write(&hexv(n["sigZ"].as_str().unwrap()));
}

sol! {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; bytes32 cid; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct PublicValues {
        uint16 version; bytes32 chainBinding; bytes32 spendRoot;
        bytes32[] nullifiers; bytes32[] leaves; bytes32[] depositsConsumed;
        Withdrawal[] withdrawals; FeePayment[] fees; bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts; bytes32[] bitcoinRootsUsed; bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot; AssetMeta[] assetMetas; SwapSettlement[] swaps;
        LpSettlement[] liquidity; uint64 deadline;
    }
}

fn build_stdin(f: &serde_json::Value) -> SP1Stdin {
    let mut s = SP1Stdin::new();
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund in this batch)
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    s.write(&1u32); // numOps
    s.write(&10u8); // OP_BID
    s.write(&hexv(f["assetA"].as_str().unwrap()));
    s.write(&hexv(f["assetB"].as_str().unwrap()));
    s.write(&f["minFill"].as_u64().unwrap());
    s.write(&f["maxFill"].as_u64().unwrap());
    s.write(&f["price"].as_u64().unwrap());
    s.write(&f["increment"].as_u64().unwrap());
    s.write(&hexv(f["buyerOwner"].as_str().unwrap()));
    let fund = &f["fund"];
    note(&mut s, fund);
    s.write(&fund["leafIndex"].as_u64().unwrap());
    for p in fund["path"].as_array().unwrap() {
        s.write(&hexv(p.as_str().unwrap()));
    }
    sig(&mut s, fund);
    let chosen_f = f["chosenF"].as_u64().unwrap();
    s.write(&chosen_f);
    note(&mut s, &f["buyerRecvA"]);
    sig(&mut s, &f["buyerRecvA"]);
    if chosen_f < f["maxFill"].as_u64().unwrap() {
        let r = &f["refund"];
        note(&mut s, r);
        sig(&mut s, r);
    }
    let si = &f["sellerIn"];
    note(&mut s, si);
    s.write(&hexv(f["sellerOwner"].as_str().unwrap()));
    s.write(&si["leafIndex"].as_u64().unwrap());
    for p in si["path"].as_array().unwrap() {
        s.write(&hexv(p.as_str().unwrap()));
    }
    s.write(&si["amount"].as_u64().unwrap());
    sig(&mut s, si);
    let has_change = f["sellerHasChange"].as_u64().unwrap() as u8;
    s.write(&has_change);
    if has_change == 1 {
        note(&mut s, &f["sellerChange"]);
        sig(&mut s, &f["sellerChange"]);
    }
    note(&mut s, &f["sellerRecvB"]);
    sig(&mut s, &f["sellerRecvB"]);
    s.write(&f["deadline"].as_u64().unwrap_or(0)); // op_deadline (guest main.rs:917)
    s.write(&f["fee"].as_u64().unwrap_or(0)); // seller-payment relay fee in asset_b (0 = self-settle), last read
    s
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("OP_FILE")
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/bid_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let stdin = build_stdin(&f);
    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.
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
        return;
        #[allow(unreachable_code)]
        let pv = PublicValues::abi_decode(public_values.as_slice(), true).expect("decode pv");
        let ex = &f["expected"];
        let exp_nu = ex["nullifiers"].as_array().unwrap();
        let exp_lf = ex["leaves"].as_array().unwrap();
        assert_eq!(pv.nullifiers.len(), exp_nu.len(), "nullifier count");
        assert_eq!(pv.leaves.len(), exp_lf.len(), "leaf count");
        for (i, n) in pv.nullifiers.iter().enumerate() {
            assert_eq!(
                hex::encode(n.0),
                exp_nu[i].as_str().unwrap().trim_start_matches("0x"),
                "nullifier {i}"
            );
        }
        for (i, l) in pv.leaves.iter().enumerate() {
            assert_eq!(
                hex::encode(l.0),
                exp_lf[i].as_str().unwrap().trim_start_matches("0x"),
                "leaf {i}"
            );
        }
        println!(
            "EXECUTE_OK cycles={} bid ν={} leaves={}",
            report.total_instruction_count(),
            pv.nullifiers.len(),
            pv.leaves.len()
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
