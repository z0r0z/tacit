// OP_SWAP_ROUTE box harness. Reads a queued `type: route` op JSON (or fixtures/route_op.json),
// writes the guest stdin in OP_SWAP_ROUTE order, then either executes or Groth16-proves the
// committed confidential guest. This is the box-side mate of dapp/cross-venue-execution.js.
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
fn u64v(v: &serde_json::Value) -> u64 {
    if let Some(n) = v.as_u64() {
        return n;
    }
    v.as_str()
        .expect("u64 string")
        .parse::<u64>()
        .expect("u64 parse")
}
fn u32v(v: &serde_json::Value) -> u32 {
    u64v(v) as u32
}
fn h<'a>(v: &'a serde_json::Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("missing hex field {k}"))
}
fn route_sig_r<'a>(f: &'a serde_json::Value, side: &str) -> &'a str {
    let node = if side == "in" { &f["in"] } else { &f["out"] };
    let top = if side == "in" { "inSig" } else { "outSig" };
    node["sigR"]
        .as_str()
        .or_else(|| node["sig"]["R"].as_str())
        .or_else(|| f[top]["R"].as_str())
        .unwrap_or_else(|| panic!("missing {side} route sigma R"))
}
fn route_sig_z<'a>(f: &'a serde_json::Value, side: &str) -> &'a str {
    let node = if side == "in" { &f["in"] } else { &f["out"] };
    let top = if side == "in" { "inSig" } else { "outSig" };
    node["sigZ"]
        .as_str()
        .or_else(|| node["sig"]["z"].as_str())
        .or_else(|| f[top]["z"].as_str())
        .unwrap_or_else(|| panic!("missing {side} route sigma z"))
}

fn main() {
    let f: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::env::var("OP_FILE")
                .unwrap_or_else(|_| "/root/work/cxfer/fixtures/route_op.json".to_string()),
        )
        .unwrap(),
    )
    .unwrap();
    let mut stdin = SP1Stdin::new();
    stdin.write(&hexv(h(&f, "chainBinding")));
    stdin.write(&hexv(h(&f, "spendRoot")));
    stdin.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    stdin.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    stdin.write(&vec![0u8; 32]); // lockSetRoot = 0
    stdin.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    stdin.write(&1u32); // numOps
    stdin.write(&11u8); // OP_SWAP_ROUTE

    stdin.write(&hexv(h(&f, "asset0")));
    stdin.write(&hexv(h(&f["in"], "cx")));
    stdin.write(&hexv(h(&f["in"], "cy")));
    stdin.write(&hexv(h(&f["in"], "owner")));
    stdin.write(&u64v(&f["in"]["leafIndex"]));
    for p in f["in"]["path"].as_array().expect("in.path") {
        stdin.write(&hexv(p.as_str().expect("path hex")));
    }
    stdin.write(&u64v(&f["amountIn"]));
    stdin.write(&f.get("fee").map(|v| u64v(v)).unwrap_or(0)); // relay fee (0 = self-settle), after amountIn
    // PARTIAL ROUTES: the input now proves spend authority with a value-HIDING blind PoK (R‖z_v‖z_r) —
    // the note may exceed `amountIn`, with the remainder returned as change in the ROUTE START asset.
    stdin.write(&hexv(f["in"]["pokR"].as_str().expect("route: in.pokR")));
    stdin.write(&hexv(f["in"]["pokZv"].as_str().expect("route: in.pokZv")));
    stdin.write(&hexv(f["in"]["pokZr"].as_str().expect("route: in.pokZr")));
    let hops = f["hops"].as_array().expect("hops");
    stdin.write(&(hops.len() as u32));
    stdin.write(&u64v(&f["minOut"]));
    stdin.write(&hexv(h(&f["out"], "cx")));
    stdin.write(&hexv(h(&f["out"], "cy")));
    stdin.write(&hexv(h(&f["out"], "owner")));
    stdin.write(&hexv(route_sig_r(&f, "out")));
    stdin.write(&hexv(route_sig_z(&f, "out")));
    stdin.write(&u64v(&f["deadline"]));
    for hop in hops {
        stdin.write(&hexv(h(hop, "assetNext")));
        stdin.write(&u32v(&hop["feeBps"]));
        stdin.write(&u64v(&hop["reserveAPre"]));
        stdin.write(&u64v(&hop["reserveBPre"]));
    }

    // Change tail, in the ROUTE START asset (never the endpoint — minting change of a different, more
    // valuable asset would be the FARM-01 shape). Count must be a legal BP+ aggregation size {0,1,2,4,8}.
    let empty: Vec<serde_json::Value> = Vec::new();
    let ch = f["change"].as_array().unwrap_or(&empty).clone();
    stdin.write(&(ch.len() as u32));
    for c in &ch {
        stdin.write(&hexv(h(c, "cx")));
        stdin.write(&hexv(h(c, "cy")));
        stdin.write(&hexv(h(c, "owner")));
    }
    if !ch.is_empty() {
        stdin.write(&hexv(f["changeRangeProof"].as_str().expect("route: changeRangeProof")));
    }
    stdin.write(&hexv(f["changeKernelR"].as_str().expect("route: changeKernelR")));
    stdin.write(&hexv(f["changeKernelZ"].as_str().expect("route: changeKernelZ")));

    // CP-04: feed keccak256("") memo hashes; the guest reads exactly its (leaves+lock_leaves) count, tests settle with matching empty memos.

    for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }

    let mode = std::env::var("MODE").unwrap_or_else(|_| "execute".into());
    if mode == "execute" {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (_public_values, report) = client
            .execute(Elf::Static(ELF), stdin)
            .run()
            .expect("execute failed");
        println!(
            "EXECUTE_OK cycles={} route_hops={} amount_in={}",
            report.total_instruction_count(),
            hops.len(),
            f["amountIn"]
        );
        return;
    }

    let client = ProverClient::builder().cpu().build();
    let elf = Elf::Static(ELF);
    println!("setup...");
    let pk = client.setup(elf).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(
            pk.verifying_key().bytes32().trim_start_matches("0x").to_lowercase(),
            expect.trim().trim_start_matches("0x").to_lowercase(),
            "EXPECT_VKEY mismatch"
        );
    }
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
