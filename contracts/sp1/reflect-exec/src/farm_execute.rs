// LOCAL execute-mode validator for the OP_FARM_BOND / OP_FARM_HARVEST / OP_FARM_UNBOND settle guest arms
// (SPEC-CONTROLLER-VAULT-AMENDMENT §4). Runs the locally-built cxfer-guest ELF (RISC-V emulator on the host —
// no GPU) against fixtures/farm_{bond,harvest,unbond}_op.json, in the SAME io::read order as main.rs's farm
// arms. A clean execute (PublicValues committed without a panic) proves the guest ACCEPTS each farm witness —
// leg/receipt membership against spendRoot + the opening sigma (tacit-farm-bond-leg-v1 / -harvest-reward-v1 /
// -unbond-release-v1) — validating the dispatch arm AND its byte serialization without a Groth16 proof. The
// controller's rps policy (FarmController.onCdpMint/onCdpClose) is NOT in execute; it is the mutable engine's
// job on-chain. Parity with cdp-mint/close/liquidate/topup-execute.
//
//   cargo run --release --bin farm-execute
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf, SP1Stdin};

const ELF: &[u8] = include_bytes!("/Users/z/tacit/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/confidential-pool-prover");
const DIR: &str = "/Users/z/tacit/contracts/sp1/confidential/fixtures/";

const OP_FARM_BOND: u8 = 20;
const OP_FARM_HARVEST: u8 = 21;
const OP_FARM_UNBOND: u8 = 22;

fn hexv(s: &str) -> Vec<u8> { hex::decode(s.trim_start_matches("0x")).unwrap() }

fn load(name: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{DIR}{name}")).unwrap()).unwrap()
}

// Batch header (membership uses spendRoot; the other roots are 0 — farm ops touch only the note tree + spent set).
fn header(s: &mut SP1Stdin, f: &serde_json::Value, op: u8) {
    s.write(&hexv(f["chainBinding"].as_str().unwrap()));
    s.write(&hexv(f["spendRoot"].as_str().unwrap()));
    s.write(&vec![0u8; 32]); // bitcoinSpentRoot = 0
    s.write(&vec![0u8; 32]); // bitcoinBurnRoot = 0
    s.write(&vec![0u8; 32]); // lockSetRoot = 0
    s.write(&vec![0u8; 32]); // cdpPositionRoot = 0
    s.write(&1u32);          // numOps
    s.write(&op);
}

fn main() {
    let client = ProverClient::builder().cpu().build();

    // ── OP_FARM_BOND: controller, owner, rps_entry(u128), nonce, lp_asset, n_legs, [cx,cy,value,index,path,sigR,sigZ] ──
    {
        let f = load("farm_bond_op.json");
        let mut s = SP1Stdin::new();
        header(&mut s, &f, OP_FARM_BOND);
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
        let (pv, report) = client.execute(Elf::Static(ELF), s).run().expect("farm-bond: execute failed (guest rejected the bond witness)");
        println!("EXECUTE_OK farm_bond cycles={} pv_bytes={} (receipt leaf + CdpMint positionLeaf==1, debtValue==0)", report.total_instruction_count(), pv.as_slice().len());
    }

    // ── OP_FARM_HARVEST: controller, owner, shares, rps_entry(u128), old_nonce, new_nonce, reward, fee, old_index, old_path, reward(cx,cy,sigR,sigZ) ──
    {
        let f = load("farm_harvest_op.json");
        let mut s = SP1Stdin::new();
        header(&mut s, &f, OP_FARM_HARVEST);
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["shares"].as_u64().unwrap());
        s.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
        s.write(&hexv(f["oldNonce"].as_str().unwrap()));
        s.write(&hexv(f["newNonce"].as_str().unwrap()));
        s.write(&f["reward"].as_u64().unwrap());
        s.write(&f.get("fee").and_then(|v| v.as_u64()).unwrap_or(0));
        s.write(&f["oldIndex"].as_u64().unwrap());
        for p in f["oldPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(f["rewardAsset"].as_str().unwrap())); // reward note asset (ESCROW-backed or == debt asset)
        s.write(&hexv(f["rewardCx"].as_str().unwrap()));
        s.write(&hexv(f["rewardCy"].as_str().unwrap()));
        s.write(&hexv(f["sigR"].as_str().unwrap()));
        s.write(&hexv(f["sigZ"].as_str().unwrap()));
        let (pv, report) = client.execute(Elf::Static(ELF), s).run().expect("farm-harvest: execute failed (guest rejected the harvest witness)");
        println!("EXECUTE_OK farm_harvest cycles={} pv_bytes={} (nullify receipt + advanced receipt + reward leaf + CdpMint debtValue==reward)", report.total_instruction_count(), pv.as_slice().len());
    }

    // ── OP_FARM_UNBOND: controller, owner, shares, fee, rps_entry(u128), nonce, lp_asset, old_index, old_path, release(cx,cy,sigR,sigZ) ──
    {
        let f = load("farm_unbond_op.json");
        let mut s = SP1Stdin::new();
        header(&mut s, &f, OP_FARM_UNBOND);
        s.write(&hexv(f["controller"].as_str().unwrap()));
        s.write(&hexv(f["owner"].as_str().unwrap()));
        s.write(&f["shares"].as_u64().unwrap());
        s.write(&f.get("fee").and_then(|v| v.as_u64()).unwrap_or(0));
        s.write(&f["rpsEntry"].as_str().unwrap().parse::<u128>().unwrap());
        s.write(&hexv(f["nonce"].as_str().unwrap()));
        s.write(&hexv(f["lpAsset"].as_str().unwrap()));
        s.write(&f["oldIndex"].as_u64().unwrap());
        for p in f["oldPath"].as_array().unwrap() { s.write(&hexv(p.as_str().unwrap())); }
        s.write(&hexv(f["releaseCx"].as_str().unwrap()));
        s.write(&hexv(f["releaseCy"].as_str().unwrap()));
        s.write(&hexv(f["sigR"].as_str().unwrap()));
        s.write(&hexv(f["sigZ"].as_str().unwrap()));
        let (pv, report) = client.execute(Elf::Static(ELF), s).run().expect("farm-unbond: execute failed (guest rejected the unbond witness)");
        println!("EXECUTE_OK farm_unbond cycles={} pv_bytes={} (nullify receipt + re-mint LP-share leaf + CdpClose)", report.total_instruction_count(), pv.as_slice().len());
    }

    println!("ALL_FARM_EXECUTE_OK");
}
