// OP_FARM_HARVEST box harness (not part of the crate build). Claims accrued yield, keeping the stake — and
// carves an OPTIONAL relay fee from the REWARD note (pay the relay out of yield). The reward note opens to
// reward − fee; the controller still bounds the GROSS reward. Reads fixtures/farm_harvest_op.json. stdin order
// = the guest's OP_FARM_HARVEST io::read (main.rs): header roots, then controller(20) ‖ owner(32) ‖
// shares(u64) ‖ rpsEntry(u128) ‖ oldNonce(32) ‖ newNonce(32) ‖ reward(u64) ‖ fee(u64) ‖ lpAsset(32) ‖ oldIndex(u64) ‖
// oldPath[] ‖ rewardAsset(32) ‖ rewardCx(32) ‖ rewardCy(32) ‖ sigR(33) ‖ sigZ(32) ‖ ownerSig(R 32 ‖ s 32).
// The `fee` is read AFTER `reward` and BEFORE `oldIndex`. `ownerSig` is the receipt owner's BIP-340 sig over
// evm_lp_harvest_owner_msg (binds the reward commitment + advanced-receipt nonce) — read LAST.
//   MODE=execute (default) — execute + print cycles. MODE=groth16 — prove + write artifacts.
// NB box wiring: confirm the ELF path matches the relay loop's build, and the serializer commits the reward
// note to reward − fee + emits the same field names.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/farm_harvest_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero: receipt membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32);          // numOps
    stdin.write(&21u8);          // OP_FARM_HARVEST
    stdin.write(&hexv(f["controller"].as_str().unwrap())); // 20-byte FarmController address
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    stdin.write(&f["shares"].as_u64().unwrap());
    stdin.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
    stdin.write(&hexv(f["oldNonce"].as_str().unwrap()));
    stdin.write(&hexv(f["newNonce"].as_str().unwrap()));
    stdin.write(&f["reward"].as_u64().unwrap());
    stdin.write(&f["fee"].as_u64().unwrap_or(0)); // relay fee carved from the reward (0 = self-settle), after reward
    // RECEIPT v2: the STAKED asset is now committed in farm_receipt_leaf, so harvest witnesses it here
    // (between `fee` and `oldIndex`). It is forced to equal the bonded asset by receipt membership below —
    // which is what closes the cross-asset re-labelling that v1 allowed.
    stdin.write(&hexv(f["lpAsset"].as_str().expect("farmharvest: lpAsset (receipt v2)")));
    stdin.write(&f["oldIndex"].as_u64().unwrap());
    for p in f["oldPath"].as_array().expect("oldPath") { stdin.write(&hexv(p.as_str().unwrap())); }
    stdin.write(&hexv(f["rewardAsset"].as_str().unwrap()));
    stdin.write(&hexv(f["rewardCx"].as_str().unwrap())); // reward note opens to reward − fee
    stdin.write(&hexv(f["rewardCy"].as_str().unwrap()));
    stdin.write(&hexv(f["sigR"].as_str().unwrap()));
    stdin.write(&hexv(f["sigZ"].as_str().unwrap()));
    let osig = hexv(f["ownerSig"].as_str().unwrap()); // receipt-owner BIP-340 sig (R‖s) over evm_lp_harvest_owner_msg
    stdin.write(&osig[..32].to_vec());
    stdin.write(&osig[32..].to_vec());

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (pv, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} reward={} fee={}",
            report.total_instruction_count(), pv.as_slice().len(), f["reward"], f["fee"].as_u64().unwrap_or(0));
        return;
    }
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(), expect.trim().trim_start_matches("0x").to_lowercase(), "EXPECT_VKEY mismatch");
    }
    println!("proving groth16 (cpu+native-gnark)...");
    let proof = client.prove(&pk, stdin).groth16().run().expect("groth16 proof failed");
    /* client.verify dropped (hangs; prover self-verifies, forge *ProofReal is the gate) */
    println!("PROVED groth16 (NO local verify here — forge *ProofReal is the on-chain gate) pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::write("public_values.hex", hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write("proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    println!("WROTE public_values.hex + proof_bytes.hex");
}
