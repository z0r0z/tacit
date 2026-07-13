// OP_CDP_MINT box harness (not part of the crate build). Reads fixtures/cdpmint_op.json and writes the
// confidential CDP open — lock a collateral basket → mint a controller debt note, carving an OPTIONAL relay
// fee from the debt note — in the guest's io::read order, then:
//   MODE=execute (default) — execute the guest (validates the witness layout without a proof) + print cycles.
//   MODE=groth16           — GPU Groth16 prove + local verify, writing public_values.hex + proof_bytes.hex
//                            for the Forge real-proof test (ConfidentialCdpCbtcSettle). OP_CDP_MINT ships in
//                            the same settle ELF, so this re-prove refreshes the settle vkey for ALL fixtures.
//
// stdin order = the guest's OP_CDP_MINT io::read (contracts/sp1/confidential/src/main.rs): header roots, then
// op 0 = controller(20) ‖ owner(32) ‖ debtValue(u64) ‖ nonce(32) ‖ rateSnapshot(32) ‖ nLegs(u32) ‖
// {asset(32) ‖ cx(32) ‖ cy(32) ‖ value(u64) ‖ index(u64) ‖ path[] ‖ sigR(33) ‖ sigZ(32)} × nLegs ‖
// fee(u64) ‖ [debt: cx(32) ‖ cy(32) ‖ sigR(33) ‖ sigZ(32)  iff debtValue > 0].  The relay `fee` is read
// AFTER the legs and BEFORE the debt note; the debt note opens to debtValue − fee.
//
// NB box wiring: the ELF path mirrors the other relay-loop harnesses (exec-route/swap/lp/otc/bid). Confirm it
// matches the committed cxfer-guest the relay loop builds, and that the dapp serializer carves the debt note
// to debtValue − fee + emits the same field names.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest");
fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }
// Read a u64 amount from either a JSON number OR a decimal string — the dapp serializer emits u64 amounts as
// decimal strings (debtValue/value/fee) to avoid the float64 precision loss above 2^53; numbers stay accepted
// for legacy fixtures. Indices stay plain numbers (tree-bounded, well under 2^53).
fn u64f(v: &serde_json::Value) -> Option<u64> { v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())) }
fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("OP_FILE").unwrap_or_else(|_| "/root/work/cxfer/fixtures/cdpmint_op.json".to_string())).unwrap()).unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(f["chainBinding"].as_str().unwrap()));
    stdin.write(&hexv(f["spendRoot"].as_str().unwrap())); // NON-zero when nLegs > 0: collateral membership
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0 (MINT appends a position; no position membership)
    stdin.write(&1u32);          // numOps
    stdin.write(&15u8);          // OP_CDP_MINT
    stdin.write(&hexv(f["controller"].as_str().unwrap())); // 20-byte controller (CollateralEngine) address
    stdin.write(&hexv(f["owner"].as_str().unwrap()));
    let debt_value = u64f(&f["debtValue"]).unwrap();
    stdin.write(&debt_value);
    stdin.write(&hexv(f["nonce"].as_str().unwrap()));
    stdin.write(&hexv(f["rateSnapshot"].as_str().unwrap()));
    let legs = f["legs"].as_array().expect("legs");
    stdin.write(&(legs.len() as u32));
    for leg in legs {
        stdin.write(&hexv(leg["asset"].as_str().unwrap()));
        stdin.write(&hexv(leg["cx"].as_str().unwrap()));
        stdin.write(&hexv(leg["cy"].as_str().unwrap()));
        stdin.write(&u64f(&leg["value"]).unwrap());
        stdin.write(&leg["index"].as_u64().unwrap());
        for p in leg["path"].as_array().expect("leg path") { stdin.write(&hexv(p.as_str().unwrap())); }
        stdin.write(&hexv(leg["sigR"].as_str().unwrap())); // collateral opening-sigma R (33B) + z (32B)
        stdin.write(&hexv(leg["sigZ"].as_str().unwrap()));
    }
    stdin.write(&u64f(&f["fee"]).unwrap_or(0)); // relay fee carved from the debt note (0 = self-settle), after the legs
    if debt_value > 0 {
        let d = &f["debt"];
        stdin.write(&hexv(d["cx"].as_str().unwrap())); // debt note opens to debtValue − fee
        stdin.write(&hexv(d["cy"].as_str().unwrap()));
        stdin.write(&hexv(d["sigR"].as_str().unwrap()));
        stdin.write(&hexv(d["sigZ"].as_str().unwrap()));
    }

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (public_values, report) = client.execute(Elf::Static(ELF), stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} debtValue={} fee={}",
            report.total_instruction_count(), public_values.as_slice().len(),
            debt_value, u64f(&f["fee"]).unwrap_or(0));
        return;
    }

    let client = ProverClient::builder().cpu().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
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
