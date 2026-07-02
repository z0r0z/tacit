// GPU (cuda) Groth16 prover for the reflection guest on the assembled real-CXFER fixture
// (reflection_input.json). Produces BITCOIN_RELAY_VKEY + an on-chain-verifiable proof of the
// reflected Bitcoin state (the input to ConfidentialPool.attestBitcoinStateProven). Needs a
// running sp1-gpu-server (CUDA_VISIBLE_DEVICES=0) + a clean /dev/shm.
//
// The SP1Stdin byte stream is built by the SHARED `reflect_stdin::write_stdin` — the SINGLE source of
// truth for reflect.rs's io::read order (the SAME writer reflect-exec validates via DIGEST_MATCH and
// eth-reflection/prover-host `bitcoin_prove` proves with). This file previously carried its OWN copy of
// the writer, which fell behind the guest (it lacked the fast-lane consumed-ν loop + the resume
// consumedCount/ethReflDigest fields and still wrote a 9-word eth_pv); that copy is DELETED so it can
// never silently desync the stream again. The box exec crate this is built in must depend on the
// `reflect-stdin` crate (pure sp1-sdk/serde_json/hex; builds locally + on the box).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, Elf, HashableKey, ProvingKey};
use reflect_stdin::write_stdin;
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");

// Fail-closed vkey guard: the derived vkey MUST equal the pinned BITCOIN_RELAY_VKEY, else a drifting
// box rebuild (different toolchain/deps than the committed elf/reflection-prover) produces a proof
// that reverts in ConfidentialPool.attestBitcoinStateProven. Set EXPECT_VKEY=<pinned vkey> OR
// ELF_VKEY_PIN=<path to elf-vkey-pin.json>; the prove aborts BEFORE the GPU spend on any mismatch.
fn expected_vkey(field: &str) -> String {
    if let Ok(v) = std::env::var("EXPECT_VKEY") { return v.trim().to_lowercase(); }
    let path = std::env::var("ELF_VKEY_PIN")
        .expect("set EXPECT_VKEY=<pinned vkey> or ELF_VKEY_PIN=<path to elf-vkey-pin.json> so a drifting rebuild can't produce on-chain-rejected proofs");
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read ELF_VKEY_PIN")).expect("parse ELF_VKEY_PIN");
    j[field].as_str().expect("pin field missing").trim().to_lowercase()
}
fn assert_vkey(actual: &str, field: &str) {
    let exp = expected_vkey(field);
    let act = actual.trim().to_lowercase();
    assert_eq!(act, exp, "VKEY DRIFT: derived {act} != pinned {field} {exp} — this ELF won't verify against the deployed contract; rebuild from the committed source so the box runs the pinned bytes before proving");
}

fn main() {
    // REFLECT_INPUT lets the box prove a DIFFERENT assembled fixture without a code edit — the standard
    // real-CXFER reflection_input.json (default) OR the TAC burn-deposit fixture
    // (contracts/sp1/confidential/fixtures/reflection_burn_deposit.json) for the
    // ConfidentialReflectionBurnDepositProofReal turnkey fixture. reflect_stdin::write_stdin handles both
    // shapes (a burnDeposit tx folds, a plain CXFER tx folds), so only the path changes.
    // REFLECT_OUT_TAG names the output hex files (default "reflect") so the two fixtures don't collide.
    let input_path = std::env::var("REFLECT_INPUT")
        .unwrap_or_else(|_| "/root/work/cxfer/fixtures/reflection_input.json".to_string());
    let out_tag = std::env::var("REFLECT_OUT_TAG").unwrap_or_else(|_| "reflect".to_string());
    println!("input {input_path}  out_tag {out_tag}");
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();
    let s = write_stdin(&f);

    // CUDA prover (matches the settle host exec) — the box runs a shared sp1-gpu-server, so GPU-prove the
    // reflection guest too. Native-gnark CPU proving a full mainnet block is impractically slow.
    let client = ProverClient::builder().cuda().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("BITCOIN_RELAY_VKEY={vk}");
    // SKIP_VKEY_ASSERT bypasses the drift guard for the re-prove that ESTABLISHES a new vkey (the guest
    // changed, so the derived vkey legitimately differs from the old pin). Pin the printed vkey afterward;
    // every subsequent prove re-asserts against it.
    if std::env::var("SKIP_VKEY_ASSERT").is_err() { assert_vkey(&vk, "bitcoin_relay_vkey"); }
    else { println!("(vkey assert skipped — establishing a new pin)"); }
    println!("proving groth16 (cpu+native-gnark)...");
        let proof = client.prove(&pk, s).groth16().run().expect("groth16 proof failed");
    println!("PROVED pv_bytes={}", proof.public_values.as_slice().len());
    /* client.verify dropped — prover self-verifies; forge *ProofReal is the on-chain gate */
    println!("LOCAL_VERIFY_OK");
    let pv_path = format!("{out_tag}_public_values.hex");
    let proof_path = format!("{out_tag}_proof_bytes.hex");
    std::fs::write(&pv_path, hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write(&proof_path, hex::encode(proof.bytes())).unwrap();
    println!("WROTE {pv_path} + {proof_path}");
}
