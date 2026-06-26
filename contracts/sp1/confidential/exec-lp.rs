// OP_LP_ADD box harness (not part of the crate build). Reads fixtures/lp_op.json, writes the
// confidential add-liquidity op in the guest's io::read order, then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert liquidity[0] == expected
//                            (fast: validates the new LP op without a proof).
//   MODE=groth16           — GPU Groth16 prove + local verify, writing public_values.hex +
//                            proof_bytes.hex for a Forge real-proof test (the C-3 re-prove pins the
//                            new ELF's vkey via setup()).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
use alloy_sol_types::{sol, SolValue};

const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

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

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/lp_op.json").unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund in this batch)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    stdin.write(&1u32);          // numOps
    stdin.write(&7u8);           // OP_LP_ADD

    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32)); // pool fee tier — binds the pool id
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["sharesPre"].as_u64().unwrap());

    let a = &f["a"];
    stdin.write(&hexv(a["cx"].as_str().unwrap()));
    stdin.write(&hexv(a["cy"].as_str().unwrap()));
    stdin.write(&hexv(a["owner"].as_str().unwrap()));
    stdin.write(&a["leafIndex"].as_u64().unwrap());
    for p in a["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&a["d"].as_u64().unwrap());
    stdin.write(&hexv(a["sigR"].as_str().unwrap()));  // A opening-sigma R (33B) + z (32B)
    stdin.write(&hexv(a["sigZ"].as_str().unwrap()));

    let b = &f["b"];
    stdin.write(&hexv(b["cx"].as_str().unwrap()));
    stdin.write(&hexv(b["cy"].as_str().unwrap()));
    stdin.write(&hexv(b["owner"].as_str().unwrap()));
    stdin.write(&b["leafIndex"].as_u64().unwrap());
    for p in b["path"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&b["d"].as_u64().unwrap());
    stdin.write(&hexv(b["sigR"].as_str().unwrap()));
    stdin.write(&hexv(b["sigZ"].as_str().unwrap()));

    // d_shares is now DERIVED in-guest (the V2 min rule) — no longer streamed; the share note follows B.
    let s = &f["share"];
    stdin.write(&hexv(s["cx"].as_str().unwrap()));
    stdin.write(&hexv(s["cy"].as_str().unwrap()));
    stdin.write(&hexv(s["owner"].as_str().unwrap()));
    stdin.write(&hexv(s["sigR"].as_str().unwrap()));
    stdin.write(&hexv(s["sigZ"].as_str().unwrap()));
    stdin.write(&f["deadline"].as_u64().unwrap_or(0)); // op_deadline (guest main.rs:554), after the share sigma

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());

    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (public_values, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        let pv = PublicValues::abi_decode(public_values.as_slice(), true).expect("decode pv");
        let ex = &f["expected"];
        assert_eq!(pv.liquidity.len(), 1, "one LP settlement");
        let l = &pv.liquidity[0];
        assert_eq!(hex::encode(l.poolId.0), ex["poolId"].as_str().unwrap().trim_start_matches("0x"), "poolId");
        assert_eq!(l.reserveAPost, alloy_sol_types::private::U256::from(ex["reserveAPost"].as_u64().unwrap()), "reserveAPost");
        assert_eq!(l.reserveBPost, alloy_sol_types::private::U256::from(ex["reserveBPost"].as_u64().unwrap()), "reserveBPost");
        assert_eq!(l.sharesPost, alloy_sol_types::private::U256::from(ex["sharesPost"].as_u64().unwrap()), "sharesPost");
        assert_eq!(pv.nullifiers.len(), 2, "A + B contribution notes spent");
        assert_eq!(pv.leaves.len(), 1, "one LP-share note minted");
        println!("EXECUTE_OK cycles={} liquidity=1 reserves {}/{}→{}/{} shares {}→{}", report.total_instruction_count(),
            f["reserveAPre"], f["reserveBPre"], l.reserveAPost, l.reserveBPost, f["sharesPre"], l.sharesPost);
        return;
    }

    let client = ProverClient::builder().cpu().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (cpu+native-gnark)...");
        {
            let __pv_ov = client.execute(Elf::Static(ELF), stdin.clone()).run().expect("pv-exec failed").0;
            std::fs::write("/root/work/cxfer/exec/pv_override.hex", hex::encode(__pv_ov.as_slice())).expect("pv_override write");
        }
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("/root/work/cxfer/exec/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/cxfer/exec/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
