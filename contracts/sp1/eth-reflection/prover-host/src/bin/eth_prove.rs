// Stage-i of the Mode B recursive prove: build real Sepolia light-client + EthReflInputs (helios) and
// produce a COMPRESSED SP1 proof of the eth_reflection guest under sp1-sdk 6.2.3 — the recursion input
// the Bitcoin reflection guest verifies via verify_sp1_proof. Reads prevSyncCommitteeRoot (word 8) of
// the EthReflectionPublicValues = the ETH_GENESIS_SYNC_COMMITTEE to pin. The async helios fetch runs in a
// scoped runtime that is dropped BEFORE the blocking prove (the blocking SDK cannot run inside a tokio
// runtime).
//
// Fast lane: the guest reads ConfidentialPool storage (crossOutCommitment / bitcoinConsumed and the
// bitcoinConsumedCount FRESHNESS anchor) via eth_getProof against the FINALIZED execution block, so this
// now requires SOURCE_EXECUTION_RPC + a real POOL. The bitcoinConsumedCount slot (120) is ALWAYS proven —
// the guest asserts its folded consumed_count equals it (ops/PLAN-fast-lane-shared-nullifier.md).
//   SOURCE_CONSENSUS_RPC=https://ethereum-sepolia-beacon-api.publicnode.com SOURCE_CHAIN_ID=11155111 \
//   SOURCE_EXECUTION_RPC=https://sepolia.example/<key> POOL=0x<ConfidentialPool> \
//   cargo +stable run --release --bin eth_prove   (needs a running sp1-gpu-server)
use alloy_primitives::{Address, B256};
use alloy::providers::{Provider, ProviderBuilder};
use serde::{Deserialize, Serialize};
use sp1_helios_primitives::types::{ContractStorage, ProofInputs, StorageSlotWithProof};
use sp1_helios_primitives::verify_storage_slot_proofs;
use helios_ethereum::rpc::ConsensusRpc;
use sp1_sdk::{blocking::{ProverClient, Prover, ProveRequest}, SP1Stdin, Elf, HashableKey};
use prover_host::{get_client, get_updates};
use cxfer_core::eth_reflection::{
    mapping_slot_key, plain_slot_key, CONSUMED_COUNT_SLOT_INDEX, CONSUMED_SLOT_INDEX, CROSSOUT_SLOT_INDEX,
};

const ETH_ELF: &[u8] = include_bytes!("/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection");

// Mirrors the guest's cxfer-core EthReflInputs (serde_cbor matches by field NAME).
#[derive(Serialize, Deserialize)]
struct EthReflInputs {
    pool: Address,
    prior_set_root: B256,
    prior_count: u64,
    crossouts: Vec<CrossOutWitness>,
    prior_consumed_root: B256,
    prior_consumed_count: u64,
    consumeds: Vec<ConsumedWitness>,
}
#[derive(Serialize, Deserialize)]
struct CrossOutWitness { claim_id: B256, dest_chain: u16, dest_commitment: B256, nullifier: B256, asset_id: B256, append_path: Vec<B256> }
#[derive(Serialize, Deserialize)]
struct ConsumedWitness { nullifier: B256, spend_root: B256, append_path: Vec<B256> }

fn main() -> anyhow::Result<()> {
    let rpc = std::env::var("SOURCE_CONSENSUS_RPC")?;
    let chain_id: u64 = std::env::var("SOURCE_CHAIN_ID")?.parse()?;
    let pool: Address = std::env::var("POOL")
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".to_string())
        .parse()?;
    // The fast-lane guest reads ConfidentialPool storage via eth_getProof against the finalized execution
    // block and MANDATES the bitcoinConsumedCount slot, so an execution RPC + a real POOL are required.
    let exec_rpc = std::env::var("SOURCE_EXECUTION_RPC")
        .map_err(|_| anyhow::anyhow!("SOURCE_EXECUTION_RPC required (eth_getProof against the finalized block)"))?;
    if pool == Address::ZERO {
        anyhow::bail!("POOL must be the deployed ConfidentialPool (the guest proves its bitcoinConsumedCount slot)");
    }
    // GENESIS_SLOT pins the bootstrap checkpoint so prevSyncCommitteeRoot (the genesis anchor the
    // Bitcoin guest gates) is REPRODUCIBLE across re-proves — without it get_client(None) bootstraps to
    // whatever is latest-finalized and the genesis drifts. Set it to the slot the pinned genesis was
    // captured at (10462624 for 0x8a83…). POOL binds ethPool == the deployed ConfidentialPool, so the
    // on-chain gate ethPoolReflected == address(this) passes for a live attest.
    let genesis_slot: Option<u64> = std::env::var("GENESIS_SLOT").ok().and_then(|s| s.parse().ok());

    // Async helios fetch in a scoped runtime, dropped before the blocking prove.
    let (lc_bytes, ethr_bytes) = {
        let rt = tokio::runtime::Runtime::new()?;
        let out = rt.block_on(async {
            eprintln!("bootstrapping helios on {rpc} (chain {chain_id}) genesis_slot={genesis_slot:?} pool={pool}");
            let client = get_client(genesis_slot, &rpc, chain_id).await?;
            let updates = get_updates(&client).await;
            let finality_update = client.rpc.get_finality_update().await
                .map_err(|e| anyhow::anyhow!("finality_update: {e:?}"))?;
            let expected_current_slot = client.expected_current_slot();
            eprintln!("updates={} finalized_slot={}", updates.len(), client.store.finalized_header.beacon().slot);

            // The cross-out + consumed witnesses the guest folds (empty this milestone — the worker
            // populates them from CrossOutRecorded / BitcoinNotesConsumed events as the lanes are used).
            let crossouts: Vec<CrossOutWitness> = vec![];
            let consumeds: Vec<ConsumedWitness> = vec![];

            // eth_getProof witness for the guest's storage reads, against the FINALIZED execution block (so
            // it matches the exec stateRoot the guest derives after applying the finality update). Proven
            // slots: each crossOutCommitment[claimId] + bitcoinConsumed[ν] mapping slot, AND the
            // bitcoinConsumedCount plain slot — the FRESHNESS anchor the guest asserts consumed_count against.
            // Slot keys come from the SAME cxfer-core derivation the guest uses (KAT-pinned), so they can't drift.
            let exec_block: u64 = *client
                .store
                .finalized_header
                .execution()
                .expect("no finalized execution header in store")
                .block_number();
            let mut keys: Vec<B256> = Vec::with_capacity(crossouts.len() + consumeds.len() + 1);
            for co in &crossouts { keys.push(B256::from(mapping_slot_key(&co.claim_id.0, CROSSOUT_SLOT_INDEX))); }
            for cw in &consumeds { keys.push(B256::from(mapping_slot_key(&cw.nullifier.0, CONSUMED_SLOT_INDEX))); }
            keys.push(B256::from(plain_slot_key(CONSUMED_COUNT_SLOT_INDEX))); // freshness anchor — always proven

            let provider =
                ProviderBuilder::new().connect_http(exec_rpc.parse().expect("bad SOURCE_EXECUTION_RPC url"));
            let block = provider
                .get_block(exec_block.into())
                .await?
                .ok_or_else(|| anyhow::anyhow!("finalized block {exec_block} missing from the execution RPC"))?;
            let state_root = block.header.state_root;
            let proof = provider.get_proof(pool, keys).number(exec_block).await?;
            let cs = ContractStorage {
                address: proof.address,
                value: alloy_trie::TrieAccount {
                    nonce: proof.nonce,
                    balance: proof.balance,
                    storage_root: proof.storage_hash,
                    code_hash: proof.code_hash,
                },
                mpt_proof: proof.account_proof,
                storage_slots: proof
                    .storage_proof
                    .into_iter()
                    .map(|p| StorageSlotWithProof { key: p.key.as_b256(), value: p.value, mpt_proof: p.proof })
                    .collect(),
            };
            // Preflight (the same check the guest runs in-circuit): fail fast + free if the slot proofs don't
            // verify — e.g. the bitcoinConsumedCount slot while the count is 0, where an unwritten slot yields
            // an exclusion proof. If that case is rejected here, seed the slot once in the ConfidentialPool ctor.
            verify_storage_slot_proofs(state_root, &cs)
                .map_err(|e| anyhow::anyhow!("preflight eth_getProof verify failed (fast-lane slot 120): {e}"))?;
            eprintln!("eth_getProof @block {exec_block}: proved {} slot(s) incl. bitcoinConsumedCount", cs.storage_slots.len());

            let lc = ProofInputs {
                updates,
                finality_update,
                expected_current_slot,
                store: client.store.clone(),
                genesis_root: client.config.chain.genesis_root,
                forks: client.config.forks.clone(),
                contract_storage: vec![cs],
            };
            let empty_root = cxfer_core::KeccakTreeAccumulator::new().root();
            let ethr = EthReflInputs {
                pool,
                prior_set_root: B256::from(empty_root),
                prior_count: 0,
                crossouts,
                prior_consumed_root: B256::from(empty_root),
                prior_consumed_count: 0,
                consumeds,
            };
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
    assert!(pv.len() >= 11 * 32, "expected 11-field (352B) eth pv (fast lane), got {}", pv.len());
    println!("PREV_SYNC_COMMITTEE (ETH_GENESIS_SYNC_COMMITTEE) = 0x{}", hex::encode(&pv[8 * 32..9 * 32]));
    println!("ethPool word = 0x{}", hex::encode(&pv[2 * 32..3 * 32]));
    println!("finalizedSlot = {}", u64::from_be_bytes(pv[5 * 32 + 24..6 * 32].try_into().unwrap()));

    std::fs::create_dir_all("/root/work/prover-host/out")?;
    proof.save("/root/work/prover-host/out/eth_compressed.bin").expect("save proof");
    std::fs::write("/root/work/prover-host/out/eth_pv.hex", hex::encode(&pv))?;
    println!("WROTE out/eth_compressed.bin + out/eth_pv.hex");
    use std::io::Write;
    std::io::stdout().flush().ok();
    std::process::exit(0); // skip the sp1-cuda client Drop (it spawns on a missing runtime and aborts)
}
