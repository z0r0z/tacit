//! eth-reflection EXECUTE harness (Mode B, Phase 1 second milestone).
//!
//! Builds real Sepolia light-client inputs (helios, via sp1-helios's get_client/get_updates) + the
//! EthReflInputs, and runs the `eth_reflection` guest in the SP1 executor (no proof) to confirm it
//! verifies sync-committee + finality end-to-end and commits sane public values. ZERO cross-outs this
//! milestone (a real cross-out needs the Mode-B pool deployed + a recorded crossOutCommitment).
//! Built inside sp1-helios's `script` workspace. Run:
//!   SOURCE_CONSENSUS_RPC=https://ethereum-sepolia-beacon-api.publicnode.com SOURCE_CHAIN_ID=11155111 \
//!   ETH_REFLECTION_ELF=/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection \
//!   cargo run -p sp1-helios-script --bin eth_reflection_exec
use alloy_primitives::{Address, B256};
use alloy_sol_types::{sol, SolValue};
use helios_ethereum::rpc::ConsensusRpc;
use serde::{Deserialize, Serialize};
use sp1_helios_primitives::types::ProofInputs;
use sp1_helios_script::{get_client, get_updates};
use sp1_sdk::{Prover, ProverClient, SP1Stdin};

// MUST stay byte-identical to the guest's EthReflInputs/CrossOutWitness (single-source to cxfer-core in 2b).
#[derive(Serialize, Deserialize)]
struct EthReflInputs {
    pool: Address,
    prior_set_root: B256,
    prior_count: u64,
    crossouts: Vec<CrossOutWitness>,
}
#[derive(Serialize, Deserialize)]
struct CrossOutWitness {
    claim_id: B256,
    dest_chain: u16,
    dest_commitment: B256,
    nullifier: B256,
    asset_id: B256,
    append_path: Vec<B256>,
}

sol! {
    struct EthReflectionPublicValues {
        bytes32 priorDigest;
        bytes32 newDigest;
        address ethPool;
        bytes32 crossOutSetRoot;
        uint64 crossOutCount;
        uint64 finalizedSlot;
        bytes32 finalizedExecStateRoot;
        bytes32 syncCommitteeRoot;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let rpc = std::env::var("SOURCE_CONSENSUS_RPC")?;
    let chain_id: u64 = std::env::var("SOURCE_CHAIN_ID")?.parse()?;
    let elf_path = std::env::var("ETH_REFLECTION_ELF")?;
    let pool: Address = std::env::var("POOL")
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".to_string())
        .parse()?;

    eprintln!("bootstrapping helios on {rpc} (chain {chain_id})");
    let client = get_client(None, &rpc, chain_id).await?;
    let updates = get_updates(&client).await;
    let finality_update = client
        .rpc
        .get_finality_update()
        .await
        .map_err(|e| anyhow::anyhow!("finality_update: {e:?}"))?;
    let expected_current_slot = client.expected_current_slot();
    eprintln!(
        "updates={} finalized_slot={}",
        updates.len(),
        client.store.finalized_header.beacon().slot
    );

    let lc = ProofInputs {
        updates,
        finality_update,
        expected_current_slot,
        store: client.store.clone(),
        genesis_root: client.config.chain.genesis_root,
        forks: client.config.forks.clone(),
        contract_storage: vec![], // zero cross-outs this milestone
    };
    let empty_root = cxfer_core::KeccakTreeAccumulator::new().root();
    let ethr = EthReflInputs {
        pool,
        prior_set_root: B256::from(empty_root),
        prior_count: 0,
        crossouts: vec![],
    };

    let mut stdin = SP1Stdin::new();
    stdin.write_vec(serde_cbor::to_vec(&lc)?);
    stdin.write_vec(serde_cbor::to_vec(&ethr)?);

    let elf = std::fs::read(&elf_path)?;
    let prover = ProverClient::builder().cpu().build().await;
    let (public_values, report) = prover.execute(elf.into(), stdin).await?;
    eprintln!("EXECUTED cycles={}", report.total_instruction_count());

    // All-static struct: decode the 8 ABI words directly (avoids the alloy static-struct
    // abi_decode asymmetry). Order matches the guest's EthReflectionPublicValues.
    let b = public_values.as_slice();
    println!("EXEC OK ({} public-value bytes)", b.len());
    let word = |i: usize| -> &[u8] { &b[i * 32..(i + 1) * 32] };
    let u64_of = |w: &[u8]| u64::from_be_bytes(w[24..32].try_into().unwrap());
    if b.len() >= 256 {
        println!("  priorDigest            = 0x{}", alloy_primitives::hex::encode(word(0)));
        println!("  newDigest              = 0x{}", alloy_primitives::hex::encode(word(1)));
        println!("  ethPool                = 0x{}", alloy_primitives::hex::encode(&word(2)[12..32]));
        println!("  crossOutSetRoot        = 0x{}", alloy_primitives::hex::encode(word(3)));
        println!("  crossOutCount          = {}", u64_of(word(4)));
        println!("  finalizedSlot          = {}", u64_of(word(5)));
        println!("  finalizedExecStateRoot = 0x{}", alloy_primitives::hex::encode(word(6)));
        println!("  syncCommitteeRoot      = 0x{}", alloy_primitives::hex::encode(word(7)));
    } else {
        println!("  raw = 0x{}", alloy_primitives::hex::encode(b));
    }
    Ok(())
}
