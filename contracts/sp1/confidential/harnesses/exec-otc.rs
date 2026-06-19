// OP_OTC box harness (not part of the crate build). Reads fixtures/otc_op.json, writes the
// confidential 2-party swap in the guest's io::read order, then:
//   MODE=execute (default) — execute the guest, decode PublicValues, assert ν + leaves == expected
//                            (fast: validates the new op without a proof).
//   MODE=groth16           — GPU Groth16 prove + local verify, writing public_values.hex +
//                            proof_bytes.hex for a Forge real-proof test (ConfidentialOtcProofReal).
// The settle vkey is the cxfer-guest vkey — OP_OTC ships in the same ELF as the other ops, so this
// re-prove refreshes the settle vkey for ALL settle fixtures (confidential/swap/lp/crosslane/otc).
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

// Write one party's leg in the guest's io::read order: input (cx,cy,leaf_index,path,amount,sig),
// has_change flag (+ optional change cx,cy,sig), received (cx,cy,sig).
fn write_leg(stdin: &mut SP1Stdin, leg: &serde_json::Value) {
    stdin.write(&hexv(leg["inCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["inCy"].as_str().unwrap()));
    stdin.write(&leg["inLeafIndex"].as_u64().unwrap());
    for p in leg["inPath"].as_array().unwrap() { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&leg["inAmount"].as_u64().unwrap());
    stdin.write(&hexv(leg["inSigR"].as_str().unwrap()));  // opening-sigma R (33B compressed)
    stdin.write(&hexv(leg["inSigZ"].as_str().unwrap()));  // opening-sigma z (32B scalar)
    let has_change = leg["hasChange"].as_u64().unwrap() as u8;
    stdin.write(&has_change);
    if has_change == 1 {
        stdin.write(&hexv(leg["changeCx"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeCy"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeSigR"].as_str().unwrap()));
        stdin.write(&hexv(leg["changeSigZ"].as_str().unwrap()));
    }
    stdin.write(&hexv(leg["recvCx"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvCy"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvSigR"].as_str().unwrap()));
    stdin.write(&hexv(leg["recvSigZ"].as_str().unwrap()));
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/otc_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap()));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0 (Ethereum-only; no cross-lane reads)
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0 (no adaptor claim/refund in this batch)
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (no CDP close/liquidate in this batch)
    stdin.write(&1u32);          // numOps
    stdin.write(&9u8);           // OP_OTC
    stdin.write(&hexv(f["assetA"].as_str().unwrap()));
    stdin.write(&hexv(f["assetB"].as_str().unwrap()));
    stdin.write(&f["vA"].as_u64().unwrap());
    stdin.write(&f["vB"].as_u64().unwrap());
    stdin.write(&hexv(f["makerOwner"].as_str().unwrap()));
    stdin.write(&hexv(f["takerOwner"].as_str().unwrap()));
    write_leg(&mut stdin, &f["maker"]);
    write_leg(&mut stdin, &f["taker"]);
    stdin.write(&f["deadline"].as_u64().unwrap_or(0)); // op_deadline (guest main.rs:776), after both legs

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());

    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (public_values, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        let pv = PublicValues::abi_decode(public_values.as_slice(), true).expect("decode pv");
        let ex = &f["expected"];
        let exp_nu = ex["nullifiers"].as_array().unwrap();
        let exp_lf = ex["leaves"].as_array().unwrap();
        assert_eq!(pv.nullifiers.len(), exp_nu.len(), "nullifier count");
        assert_eq!(pv.leaves.len(), exp_lf.len(), "leaf count");
        for (i, n) in pv.nullifiers.iter().enumerate() {
            assert_eq!(hex::encode(n.0), exp_nu[i].as_str().unwrap().trim_start_matches("0x"), "nullifier {i}");
        }
        for (i, l) in pv.leaves.iter().enumerate() {
            assert_eq!(hex::encode(l.0), exp_lf[i].as_str().unwrap().trim_start_matches("0x"), "leaf {i}");
        }
        println!("EXECUTE_OK cycles={} otc ν={} leaves={}", report.total_instruction_count(), pv.nullifiers.len(), pv.leaves.len());
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
