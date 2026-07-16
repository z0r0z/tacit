// Stage-iii: recursion prove of the Bitcoin reflection guest. Serializes the reflection fixture with the
// SHARED `reflect_stdin::write_stdin` (the SAME bytes reflect-exec validates via DIGEST_MATCH — the single
// source of truth for reflect.rs's io::read order, so the prover writer can never drift from the guest).
// For a Mode-B fixture (modeB=1) it also feeds the stage-i eth compressed proof via SP1Stdin::write_proof so
// the guest verify_sp1_proof binds the eth cross-out / consumed-ν set; a forward fixture (modeB=0) proves
// without an inner proof. PROOF_MODE=execute (diagnostic, no proof) | compressed (default, fast recursion
// validation) | groth16 (on-chain).
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, SP1Proof, SP1ProofWithPublicValues};
use reflect_stdin::write_stdin;

const BITCOIN_ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");
const ETH_ELF: &[u8] = include_bytes!("/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection");

fn main() {
    let mode = std::env::var("PROOF_MODE").unwrap_or_else(|_| "compressed".into());
    let fx_path = std::env::var("REFLECT_FIXTURE").unwrap_or_else(|_| "/root/work/confidential/fixtures/reflection_input.json".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fx_path).unwrap()).unwrap();
    let mode_b = f.get("modeB").and_then(|v| v.as_u64()).unwrap_or(0);
    let execute_only = mode == "execute";
    println!("fixture {fx_path}  modeB={mode_b}  proofMode={mode}");

    // The full witness stream in the guest's exact io::read order (prior, mode_b, eth_pv, anchor/headers,
    // consumed-ν fast lane, then every block's per-tx Track-B/C + crossout witnesses).
    let mut stdin: SP1Stdin = write_stdin(&f);

    let pclient = ProverClient::builder().cuda().build();

    // Mode-B recursion: bind the stage-i eth-reflection inner proof so verify_sp1_proof trusts the
    // cross-out / consumed-ν set. write_stdin already wrote f["ethPv"] into the io stream; assert it equals
    // the loaded proof's public values (the indexer sourced the fold roots FROM this proof, and the real
    // ethPool word must ride through so the on-chain ethPoolReflected == address(this) gate passes).
    if mode_b != 0 {
        let eth = SP1ProofWithPublicValues::load("/root/work/prover-host/out/eth_compressed.bin").expect("load eth proof");
        let eth_pv = eth.public_values.as_slice().to_vec();
        assert!(eth_pv.len() >= 11 * 32, "eth pv too short (need the 11-word fast-lane PV)");
        let fx_ethpv = f.get("ethPv").and_then(|v| v.as_str())
            .map(|s| hex::decode(s.trim_start_matches("0x")).unwrap());
        assert_eq!(fx_ethpv.as_deref(), Some(eth_pv.as_slice()),
            "fixture ethPv != eth proof public values (regenerate the fixture from out/eth_pv.hex)");
        let SP1Proof::Compressed(reduce) = eth.proof else { panic!("eth proof not compressed") };
        let eth_pk = pclient.setup(Elf::Static(ETH_ELF)).expect("setup eth");
        // COHERENCE GUARD: the eth ELF's recursion vk_digest MUST equal the constant the Bitcoin guest
        // (reflect.rs ETH_REFLECTION_VKEY) bakes into its `verify_sp1_proof` call. If they drift, the Bitcoin
        // guest at best rejects every Mode-B proof (fail-closed) and at worst — if a wrong-but-valid digest
        // is ever pinned — recursively trusts the WRONG inner program (forged crossOut/consumed-ν sets). Assert
        // here so a drift fails LOUDLY before the GPU spend, printing the value to re-pin. Keep this array in
        // lockstep with reflect.rs:169-170 (rebuilding the eth ELF rotates it).
        const ETH_REFLECTION_VKEY: [u32; 8] =
            [740262594, 275750350, 1515022045, 1617354007, 928640383, 1985748378, 232523283, 846985044];
        let derived = eth_pk.verifying_key().hash_u32();
        assert_eq!(
            derived, ETH_REFLECTION_VKEY,
            "ETH_REFLECTION_VKEY DRIFT: this eth ELF's recursion vkey {derived:?} != the constant the Bitcoin \
             guest verifies against (reflect.rs ETH_REFLECTION_VKEY). Re-pin BOTH reflect.rs:169-170 and \
             bitcoin_prove.rs to {derived:?}, then re-prove the Bitcoin guest so its baked vkey matches the eth \
             ELF being recursed.",
        );
        println!("eth vkey = {} (recursion hash_u32 == reflect.rs ETH_REFLECTION_VKEY ✓)", eth_pk.verifying_key().bytes32());
        let eth_vk = eth_pk.verifying_key().vk.clone();
        stdin.write_proof(*reduce, eth_vk);
        // sp1-cuda 6.2.x may spawn from ProvingKey/SessionKey Drop without a Tokio reactor when this
        // short-lived inner key leaves scope. The process exits explicitly after the outer proof, so leaking
        // this setup key is the least surprising way to avoid a destructor-only abort before the real proof.
        std::mem::forget(eth_pk);
    } else {
        println!("forward batch (modeB=0): no eth recursion");
    }

    if execute_only {
        println!("executing bitcoin guest (no proof)...");
        let (out, report) = pclient.execute(Elf::Static(BITCOIN_ELF), stdin).run().expect("execute failed");
        let pv = out.as_slice().to_vec();
        println!("EXECUTED cycles={} pv_bytes={}", report.total_instruction_count(), pv.len());
        std::fs::create_dir_all("/root/work/prover-host/out").ok();
        std::fs::write("/root/work/prover-host/out/bitcoin_pv.hex", hex::encode(&pv)).unwrap();
        println!("WROTE out/bitcoin_pv.hex");
        return;
    }

    let bpk = pclient.setup(Elf::Static(BITCOIN_ELF)).expect("setup bitcoin");
    println!("BITCOIN_RELAY_VKEY = {}", bpk.verifying_key().bytes32());
    println!("proving {mode} (cuda)...");
    let proof = if mode == "groth16" {
        pclient.prove(&bpk, stdin).groth16().run().expect("groth16 proof failed")
    } else {
        pclient.prove(&bpk, stdin).compressed().run().expect("compressed proof failed")
    };
    let pv = proof.public_values.as_slice().to_vec();
    println!("PROVED mode={mode} pv_bytes={}", pv.len());
    pclient.verify(&proof, bpk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK");
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    proof.save(format!("/root/work/prover-host/out/bitcoin_{mode}.bin")).expect("save");
    std::fs::write("/root/work/prover-host/out/bitcoin_pv.hex", hex::encode(&pv)).unwrap();
    if mode == "groth16" {
        std::fs::write("/root/work/prover-host/out/bitcoin_proof_bytes.hex", hex::encode(proof.bytes())).unwrap();
    }
    println!("WROTE out/bitcoin_{mode}.bin + bitcoin_pv.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
