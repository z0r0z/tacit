// Stage-i of the Mode B recursive prove: build real Sepolia light-client + EthReflInputs (helios) and
// produce a COMPRESSED SP1 proof of the eth_reflection guest under sp1-sdk 6.2.3 — the recursion input
// the Bitcoin reflection guest verifies via verify_sp1_proof. Reads prevSyncCommitteeRoot (word 8) of
// the 9-field EthReflectionPublicValues = the ETH_GENESIS_SYNC_COMMITTEE to pin. ZERO cross-outs this
// milestone. The async helios fetch runs in a scoped runtime that is dropped BEFORE the blocking prove
// (the blocking SDK cannot run inside a tokio runtime).
//   SOURCE_CONSENSUS_RPC=https://ethereum-sepolia-beacon-api.publicnode.com SOURCE_CHAIN_ID=11155111 \
//   cargo +stable run --release --bin eth_prove   (needs a running sp1-gpu-server)
use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};
use sp1_helios_primitives::types::ProofInputs;
use helios_ethereum::rpc::ConsensusRpc;
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey};
use prover_host::{get_client, get_updates};

const ETH_ELF: &[u8] = include_bytes!("/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection");

#[derive(Serialize, Deserialize)]
struct EthReflInputs { pool: Address, prior_set_root: B256, prior_count: u64, crossouts: Vec<CrossOutWitness> }
#[derive(Serialize, Deserialize)]
struct CrossOutWitness { claim_id: B256, dest_chain: u16, dest_commitment: B256, nullifier: B256, asset_id: B256, append_path: Vec<B256> }

fn main() -> anyhow::Result<()> {
    let rpc = std::env::var("SOURCE_CONSENSUS_RPC")?;
    let chain_id: u64 = std::env::var("SOURCE_CHAIN_ID")?.parse()?;
    let pool: Address = std::env::var("POOL")
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".to_string())
        .parse()?;

    // Async helios fetch in a scoped runtime, dropped before the blocking prove.
    let (lc_bytes, ethr_bytes) = {
        let rt = tokio::runtime::Runtime::new()?;
        let out = rt.block_on(async {
            eprintln!("bootstrapping helios on {rpc} (chain {chain_id})");
            let client = get_client(None, &rpc, chain_id).await?;
            let updates = get_updates(&client).await;
            let finality_update = client.rpc.get_finality_update().await
                .map_err(|e| anyhow::anyhow!("finality_update: {e:?}"))?;
            let expected_current_slot = client.expected_current_slot();
            eprintln!("updates={} finalized_slot={}", updates.len(), client.store.finalized_header.beacon().slot);
            let lc = ProofInputs {
                updates,
                finality_update,
                expected_current_slot,
                store: client.store.clone(),
                genesis_root: client.config.chain.genesis_root,
                forks: client.config.forks.clone(),
                contract_storage: vec![],
            };
            let empty_root = cxfer_core::KeccakTreeAccumulator::new().root();
            let ethr = EthReflInputs { pool, prior_set_root: B256::from(empty_root), prior_count: 0, crossouts: vec![] };
            Ok::<_, anyhow::Error>((serde_cbor::to_vec(&lc)?, serde_cbor::to_vec(&ethr)?))
        })?;
        out
    };

    let mut stdin = SP1Stdin::new();
    stdin.write_vec(lc_bytes);
    stdin.write_vec(ethr_bytes);

    let pclient = ProverClient::builder().cuda().build();
    let pk = pclient.setup(Elf::Static(ETH_ELF)).expect("setup");
    println!("ETH vkey = {}", pk.verifying_key().bytes32());
    println!("proving compressed (cuda)...");
    let proof = pclient.prove(&pk, stdin).compressed().run().expect("compressed proof failed");
    let pv = proof.public_values.as_slice().to_vec();
    println!("eth pv_bytes={}", pv.len());
    assert!(pv.len() >= 288, "expected 9-field (288B) eth pv, got {}", pv.len());
    println!("PREV_SYNC_COMMITTEE (ETH_GENESIS_SYNC_COMMITTEE) = 0x{}", hex::encode(&pv[8 * 32..9 * 32]));
    println!("ethPool word = 0x{}", hex::encode(&pv[2 * 32..3 * 32]));
    println!("finalizedSlot = {}", u64::from_be_bytes(pv[5 * 32 + 24..6 * 32].try_into().unwrap()));

    std::fs::create_dir_all("/root/work/prover-host/out")?;
    proof.save("/root/work/prover-host/out/eth_compressed.bin").expect("save proof");
    std::fs::write("/root/work/prover-host/out/eth_pv.hex", hex::encode(&pv))?;
    println!("WROTE out/eth_compressed.bin + out/eth_pv.hex");
    Ok(())
}
