// Execute/prove OP_SWAP_ROUTE against the confidential settle guest. This is the
// prover-host packaged mate of dapp/cross-venue-execution.js route jobs.
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");

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
    let op_file = std::env::var("OP_FILE")
        .unwrap_or_else(|_| "/root/work/confidential/fixtures/route_op.json".to_string());
    let f: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(op_file).unwrap()).unwrap();
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
    stdin.write(&hexv(route_sig_r(&f, "in")));
    stdin.write(&hexv(route_sig_z(&f, "in")));
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

    if std::env::var("MODE").as_deref() != Ok("groth16") {
        let client = ProverClient::builder().cpu().build();
        let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
        println!("VKEY={}", pk.verifying_key().bytes32());
        let (output, report) = client
            .execute(Elf::Static(ELF), stdin)
            .run()
            .expect("execute failed");
        println!(
            "ROUTE_OK cycles={} pv_bytes={} hops={} amount_in={}",
            report.total_instruction_count(),
            output.as_slice().len(),
            hops.len(),
            f["amountIn"]
        );
        return;
    }

    let client = ProverClient::builder().cuda().build();
    println!("setup...");
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    println!("VKEY={}", pk.verifying_key().bytes32());
    // MANDATORY fail-closed vkey-drift guard (was opt-in): abort BEFORE the GPU spend if the derived vkey
    // doesn't match the pin, so a drifted ELF can't burn cycles then revert on-chain. Set EXPECT_VKEY or
    // ELF_VKEY_PIN. Shared with every other groth16 box bin via prover_host::assert_vkey.
    prover_host::assert_vkey(&pk.verifying_key().bytes32(), "program_vkey");
    println!("proving groth16 (cuda)...");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 proof failed");
    client
        .verify(&proof, pk.verifying_key(), None)
        .expect("local verify failed");
    println!(
        "LOCAL_VERIFY_OK groth16 pv_bytes={}",
        proof.public_values.as_slice().len()
    );
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write(
        "/root/work/prover-host/out/route_pv.hex",
        hex::encode(proof.public_values.as_slice()),
    )
    .unwrap();
    std::fs::write(
        "/root/work/prover-host/out/route_pb.hex",
        hex::encode(proof.bytes()),
    )
    .unwrap();
    println!("WROTE route_pv.hex + route_pb.hex");
    use std::io::Write;
    std::io::stdout().flush().ok();
    std::process::exit(0);
}
