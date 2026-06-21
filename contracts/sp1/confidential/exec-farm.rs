// Settle prove harness for the fair-farm ops OP_FARM_BOND/HARVEST/UNBOND (groth16). Serializes the farm op
// witness in main.rs's io::read order (the same bytes the dapp's confidential-farm.js buildBondOp/buildHarvestOp/
// buildUnbondOp emit) and produces a REAL Groth16 proof against the committed settle ELF — the production prove
// path the relay drives for a farm settle, and the end-to-end confirmation that the farm ops verify against the
// pinned PROGRAM_VKEY. Select the op via env: FARM_FIXTURE=<path> FARM_OP=20|21|22 FARM_TAG=bond|harvest|unbond.
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey, ProvingKey};

const ELF: &[u8] = include_bytes!("/root/work/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn main() {
    let fixture = std::env::var("FARM_FIXTURE").expect("set FARM_FIXTURE");
    let op: u8 = std::env::var("FARM_OP").expect("set FARM_OP (20/21/22)").parse().unwrap();
    let tag = std::env::var("FARM_TAG").unwrap_or_else(|_| "farm".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&fixture).unwrap()).unwrap();

    let mut s = SP1Stdin::new();
    // batch header (membership uses spendRoot; the other roots are 0 — farm ops touch only the note tree + spent set)
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot
    s.write(&vec![0u8; 32]); // lockSetRoot
    s.write(&vec![0u8; 32]); // cdpPositionRoot
    s.write(&1u32);          // numOps
    s.write(&op);

    if op == 20 {
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
        s.write(&hexv(f["nonce"].as_str().unwrap()));
        s.write(&hexv(f["lpAsset"].as_str().unwrap()));
        let legs = f["legs"].as_array().unwrap();
        s.write(&(legs.len() as u32));
        for leg in legs {
            s.write(&hexv(leg["cx"].as_str().unwrap()));
            s.write(&hexv(leg["cy"].as_str().unwrap()));
            s.write(&leg["value"].as_u64().unwrap());
            s.write(&leg["index"].as_u64().unwrap());
            for p in leg["path"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
            s.write(&hexv(leg["sigR"].as_str().unwrap()));
            s.write(&hexv(leg["sigZ"].as_str().unwrap()));
        }
    } else if op == 21 {
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["shares"].as_u64().unwrap());
        s.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
        s.write(&hexv(f["oldNonce"].as_str().unwrap()));
        s.write(&hexv(f["newNonce"].as_str().unwrap()));
        s.write(&f["reward"].as_u64().unwrap());
        s.write(&f["oldIndex"].as_u64().unwrap());
        for p in f["oldPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(f["rewardAsset"].as_str().unwrap()));
        s.write(&hexv(f["rewardCx"].as_str().unwrap()));
        s.write(&hexv(f["rewardCy"].as_str().unwrap()));
        s.write(&hexv(f["sigR"].as_str().unwrap()));
        s.write(&hexv(f["sigZ"].as_str().unwrap()));
    } else {
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["shares"].as_u64().unwrap());
        s.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
        s.write(&hexv(f["nonce"].as_str().unwrap()));
        s.write(&hexv(f["lpAsset"].as_str().unwrap()));
        s.write(&f["oldIndex"].as_u64().unwrap());
        for p in f["oldPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(f["releaseCx"].as_str().unwrap()));
        s.write(&hexv(f["releaseCy"].as_str().unwrap()));
        s.write(&hexv(f["sigR"].as_str().unwrap()));
        s.write(&hexv(f["sigZ"].as_str().unwrap()));
    }

    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup");
    println!("PROGRAM_VKEY={}", pk.verifying_key().bytes32());
    println!("proving groth16 ({tag}, cuda)...");
    let proof = client.prove(&pk, s).groth16().run().expect("groth16 proof failed");
    client.verify(&proof, pk.verifying_key(), None).expect("local verify failed");
    println!("LOCAL_VERIFY_OK {tag} pv_bytes={}", proof.public_values.as_slice().len());
    std::fs::create_dir_all("/root/work/prover-host/out").ok();
    std::fs::write(format!("/root/work/prover-host/out/farm_{tag}_pv.hex"), hex::encode(proof.public_values.as_slice())).unwrap();
    std::fs::write(format!("/root/work/prover-host/out/farm_{tag}_pb.hex"), hex::encode(proof.bytes())).unwrap();
    println!("WROTE farm_{tag}_pv.hex + farm_{tag}_pb.hex");
    use std::io::Write; std::io::stdout().flush().ok();
    std::process::exit(0);
}
