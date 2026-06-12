// OP_SWAP box harness (not part of the crate build). Reads fixtures/swap_op.json, writes the
// confidential batch in the guest's io::read order, then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert swaps[0] == expected
//                            (fast: validates the new op without a proof).
//   MODE=groth16           — GPU Groth16 prove + local verify, writing public_values.hex +
//                            proof_bytes.hex for a Forge real-proof test (the C-3 re-prove uses
//                            the new ELF's vkey via setup()).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
// `verifying_key()` is the `ProvingKey` trait method (sp1_sdk::ProvingKey) on the EnvProvingKey
// that setup() returns; `bytes32()` is `HashableKey`. Both must be in scope.
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
        LpSettlement[] liquidity;
    }
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/swap_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&6u8);           // OP_SWAP
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&(f["feeBps"].as_u64().unwrap() as u32)); // pool fee tier — binds the pool id
    stdin.write(&f["reserveAPre"].as_u64().unwrap());
    stdin.write(&f["reserveBPre"].as_u64().unwrap());
    stdin.write(&f["priceNum"].as_u64().unwrap());
    stdin.write(&f["priceDen"].as_u64().unwrap());
    let intents = f["intents"].as_array().unwrap();
    stdin.write(&(intents.len() as u32));
    for it in intents {
        stdin.write(&(it["direction"].as_u64().unwrap() as u8));
        stdin.write(&hexv(it["inCx"].as_str().unwrap()));
        stdin.write(&hexv(it["inCy"].as_str().unwrap()));
        stdin.write(&hexv(it["inOwner"].as_str().unwrap()));
        stdin.write(&it["inLeafIndex"].as_u64().unwrap());
        for p in it["inPath"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&it["amountIn"].as_u64().unwrap());
        stdin.write(&it["amountOut"].as_u64().unwrap());
        stdin.write(&it["rem"].as_u64().unwrap());
        stdin.write(&hexv(it["inSigR"].as_str().unwrap()));  // opening-sigma R (33B compressed)
        stdin.write(&hexv(it["inSigZ"].as_str().unwrap()));  // opening-sigma z (32B scalar)
        stdin.write(&it["minOut"].as_u64().unwrap());
        stdin.write(&hexv(it["outCx"].as_str().unwrap()));
        stdin.write(&hexv(it["outCy"].as_str().unwrap()));
        stdin.write(&hexv(it["outOwner"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigR"].as_str().unwrap()));
        stdin.write(&hexv(it["outSigZ"].as_str().unwrap()));
    }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());

    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        // The vkey is deterministic from the ELF — capture it here (the C-3 pin) without a proof.
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (public_values, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        let pv = PublicValues::abi_decode(public_values.as_slice(), true).expect("decode pv");
        let ex = &f["expected"];
        assert_eq!(pv.swaps.len(), 1, "one swap settlement");
        let s = &pv.swaps[0];
        assert_eq!(hex::encode(s.poolId.0), ex["poolId"].as_str().unwrap().trim_start_matches("0x"), "poolId");
        assert_eq!(s.reserveAPost, alloy_sol_types::private::U256::from(ex["reserveAPost"].as_u64().unwrap()), "reserveAPost");
        assert_eq!(s.reserveBPost, alloy_sol_types::private::U256::from(ex["reserveBPost"].as_u64().unwrap()), "reserveBPost");
        assert_eq!(pv.nullifiers.len(), 1, "one nullifier");
        assert_eq!(pv.leaves.len(), 1, "one output leaf");
        println!("EXECUTE_OK cycles={} swaps=1 reserves {}/{}→{}/{}", report.total_instruction_count(),
            f["reserveAPre"], f["reserveBPre"], s.reserveAPost, s.reserveBPost);
        return;
    }

    let client = ProverClient::builder().cuda().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 (gpu)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK groth16 pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("/root/work/cxfer/exec/public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("/root/work/cxfer/exec/proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
