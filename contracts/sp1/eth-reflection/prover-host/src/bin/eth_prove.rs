// Stage-i of the Mode B recursive prove: build real Sepolia light-client + EthReflInputs (helios) and
// produce a COMPRESSED SP1 proof of the eth_reflection guest under sp1-sdk 6.2.3 — the recursion input
// the Bitcoin reflection guest verifies via verify_sp1_proof. Reads prevSyncCommitteeRoot (word 8) of
// the EthReflectionPublicValues = the ETH_GENESIS_SYNC_COMMITTEE to pin. The async helios fetch runs in a
// scoped runtime that is dropped BEFORE the blocking prove (the blocking SDK cannot run inside a tokio
// runtime).
//
// Fast lane / cross-out witnesses (G1): the guest folds the pool's confirmed cross-outs + consumed-ν into
// append-only keccak sets, so this reads `CrossOutRecorded` / `BitcoinNotesConsumed` logs (eth_getLogs)
// since the last-accepted block up to the FINALIZED execution block, resumes the append-only accumulators
// from a committed state (out/eth_set_state.json), and writes the next state as a candidate
// (out/eth_set_state.pending.json) that the submit loop commits only after the outer Bitcoin reflection
// attest succeeds. It builds one witness per new entry (the slot proof + the frontier append_path). It
// ALSO proves the bitcoinConsumedCount slot (120) every cycle — the guest
// asserts its folded consumed_count equals it (ops/PLAN-fast-lane-shared-nullifier.md). The cumulative set
// + the proof PV are emitted as out/eth_set.json — the bundle the Bitcoin fixture builder consumes
// (buildModeBBatch: { ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,spendRoot}] }).
//   SOURCE_CONSENSUS_RPC=https://ethereum-sepolia-beacon-api.publicnode.com SOURCE_CHAIN_ID=11155111 \
//   SOURCE_EXECUTION_RPC=https://sepolia.example/<key> POOL=0x<ConfidentialPool> \
//   DEPLOY_BLOCK=<pool deploy block, first run only> \
//   cargo +stable run --release --bin eth_prove   (needs a running sp1-gpu-server)
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::Filter;
use alloy_primitives::{keccak256, Address, B256};
use cxfer_core::eth_reflection::{
    eth_consumed_leaf, eth_crossout_leaf, mapping_slot_key, plain_slot_key, EthConsumed,
    EthCrossOut, CONSUMED_AT_SLOT_INDEX, CONSUMED_COUNT_SLOT_INDEX, CONSUMED_SLOT_INDEX,
    CROSSOUT_SLOT_INDEX, DEST_CHAIN_BITCOIN,
};
use cxfer_core::KeccakTreeAccumulator;
use helios_ethereum::rpc::ConsensusRpc;
use prover_host::{get_client, get_updates};
use serde::{Deserialize, Serialize};
use sp1_helios_primitives::types::{ContractStorage, ProofInputs, StorageSlotWithProof};
use sp1_helios_primitives::verify_storage_slot_proofs;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, SP1Stdin,
};

const ETH_ELF: &[u8] = include_bytes!(
    "/root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection"
);
const STATE_PATH: &str = "/root/work/prover-host/out/eth_set_state.json";
const PENDING_STATE_PATH: &str = "/root/work/prover-host/out/eth_set_state.pending.json";

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
struct CrossOutWitness {
    claim_id: B256,
    dest_chain: u16,
    dest_commitment: B256,
    nullifier: B256,
    asset_id: B256,
    append_path: Vec<B256>,
}
#[derive(Serialize, Deserialize)]
struct ConsumedWitness {
    nullifier: B256,
    spend_root: B256,
    append_path: Vec<B256>,
}

// The persisted cumulative sets (in APPEND order) — resume across cycles + the source for both the witness
// frontier paths and the emitted bundle. last_block = the highest execution block already folded.
#[derive(Serialize, Deserialize, Default)]
struct EthSetState {
    last_block: u64,
    #[serde(default)]
    crossouts: Vec<CoRecord>,
    #[serde(default)]
    consumeds: Vec<CnRecord>,
}
#[derive(Serialize, Deserialize, Clone)]
struct CoRecord {
    claim_id: B256,
    dest_chain: u16,
    dest_commitment: B256,
    nullifier: B256,
    asset_id: B256,
}
#[derive(Serialize, Deserialize, Clone)]
struct CnRecord {
    nullifier: B256,
    spend_root: B256,
}

fn co_leaf(r: &CoRecord) -> [u8; 32] {
    eth_crossout_leaf(&EthCrossOut {
        claim_id: r.claim_id.0,
        dest_chain: r.dest_chain,
        dest_commitment: r.dest_commitment.0,
        asset_id: r.asset_id.0,
    })
}
fn cn_leaf(r: &CnRecord) -> [u8; 32] {
    eth_consumed_leaf(&EthConsumed {
        nullifier: r.nullifier.0,
        spend_root: r.spend_root.0,
    })
}
fn consumed_at_key(index: u64) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[24..].copy_from_slice(&index.to_be_bytes());
    key
}

// The bundle the Bitcoin fixture builder reads (dapp buildModeBBatch). camelCase keys (JS), 0x-hex values.
#[derive(Serialize)]
struct EthSetBundle {
    ethPv: String,
    crossouts: Vec<CoBundle>,
    consumeds: Vec<CnBundle>,
}
#[derive(Serialize)]
#[allow(non_snake_case)]
struct CoBundle {
    claimId: String,
    destCommitment: String,
    asset: String,
}
#[derive(Serialize)]
#[allow(non_snake_case)]
struct CnBundle {
    nu: String,
    spendRoot: String,
}
fn hx(b: &B256) -> String {
    format!("0x{}", hex::encode(b.0))
}

fn main() -> anyhow::Result<()> {
    let rpc = std::env::var("SOURCE_CONSENSUS_RPC")?;
    let chain_id: u64 = std::env::var("SOURCE_CHAIN_ID")?.parse()?;
    let pool: Address = std::env::var("POOL")
        .unwrap_or_else(|_| "0x0000000000000000000000000000000000000000".to_string())
        .parse()?;
    // The fast-lane guest reads ConfidentialPool storage via eth_getProof against the finalized execution
    // block and MANDATES the bitcoinConsumedCount slot, so an execution RPC + a real POOL are required.
    let exec_rpc = std::env::var("SOURCE_EXECUTION_RPC")
        .map_err(|_| anyhow::anyhow!("SOURCE_EXECUTION_RPC required (eth_getProof + eth_getLogs against the finalized block)"))?;
    if pool == Address::ZERO {
        anyhow::bail!("POOL must be the deployed ConfidentialPool (the guest proves its bitcoinConsumedCount slot)");
    }
    // GENESIS_SLOT pins the bootstrap checkpoint so prevSyncCommitteeRoot (the genesis anchor the
    // Bitcoin guest gates) is REPRODUCIBLE across re-proves — without it get_client(None) bootstraps to
    // whatever is latest-finalized and the genesis drifts. Set it to the slot the pinned genesis was
    // captured at (10462624 for 0x8a83…). POOL binds ethPool == the deployed ConfidentialPool, so the
    // on-chain gate ethPoolReflected == address(this) passes for a live attest.
    let genesis_slot: Option<u64> = std::env::var("GENESIS_SLOT")
        .ok()
        .and_then(|s| s.parse().ok());
    // First-run lower bound for the log scan (the pool's deploy block) — afterwards the persisted state's
    // last_block + 1 is used, so a re-run never re-folds an entry (append-only, monotone).
    let deploy_block: u64 = std::env::var("DEPLOY_BLOCK")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Resume the cumulative sets (empty on the first run).
    let mut state: EthSetState = std::fs::read_to_string(STATE_PATH)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let from_block =
        if state.last_block == 0 && state.crossouts.is_empty() && state.consumeds.is_empty() {
            deploy_block
        } else {
            state.last_block + 1
        };
    let co_sig = keccak256(b"CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)");
    let cn_sig = keccak256(b"BitcoinNotesConsumed(bytes32[],bytes32)");

    // Async helios fetch + eth_getLogs/getProof in a scoped runtime, dropped before the blocking prove.
    let (lc_bytes, ethr_bytes, full_co, full_cn, exec_block) = {
        let rt = tokio::runtime::Runtime::new()?;
        let out = rt.block_on(async {
            eprintln!("bootstrapping helios on {rpc} (chain {chain_id}) genesis_slot={genesis_slot:?} pool={pool}");
            let client = get_client(genesis_slot, &rpc, chain_id).await?;
            {
                use tree_hash::TreeHash;
                eprintln!(
                    "[genesis-capture] genesis_slot={:?} sync_committee_root=0x{}",
                    genesis_slot,
                    hex::encode(client.store.current_sync_committee.tree_hash_root().0)
                );
            }
            let updates = get_updates(&client).await;
            let finality_update = client.rpc.get_finality_update().await
                .map_err(|e| anyhow::anyhow!("finality_update: {e:?}"))?;
            let expected_current_slot = client.expected_current_slot();
            eprintln!("updates={} finalized_slot={}", updates.len(), client.store.finalized_header.beacon().slot);

            // exec_block = the CURRENT finalized execution block — what the guest advances to (via the
            // updates + finality_update) and verifies the storage proofs against. Read it from the
            // finality_update, NOT client.store.finalized_header: the store stays pinned at GENESIS_SLOT
            // (the weak-subjectivity anchor), so reading exec_block from it gives a block thousands of
            // slots stale — before any recent crossOut — and getLogs/getProof would miss the entry while
            // the guest verifies against the advanced finalized state root (a host↔guest block mismatch).
            let sp = |s: u64| s / (32 * 256);
            let exec_block: u64 = *finality_update
                .finalized_header()
                .execution()
                .expect("no finalized execution header in finality_update")
                .block_number();
            eprintln!(
                "finalized slot {} (period {}), exec_block {exec_block}; bootstrap was slot {} (period {}), {} updates",
                finality_update.finalized_header().beacon().slot,
                sp(finality_update.finalized_header().beacon().slot),
                client.store.finalized_header.beacon().slot,
                sp(client.store.finalized_header.beacon().slot),
                updates.len(),
            );

            let provider =
                ProviderBuilder::new().connect_http(exec_rpc.parse().expect("bad SOURCE_EXECUTION_RPC url"));

            // NEW cross-out / consumed entries since the last-folded block, up to the FINALIZED block (so the
            // logs match the stateRoot the storage proofs verify against). Order by (block, logIndex) =
            // chain order = the append order the contract wrote crossOutCommitment / bitcoinConsumed in.
            let mut new_co: Vec<CoRecord> = Vec::new();
            let mut new_cn: Vec<CnRecord> = Vec::new();
            if exec_block >= from_block {
                let filter = Filter::new().address(pool).from_block(from_block).to_block(exec_block);
                let logs = provider.get_logs(&filter).await?;
                eprintln!("eth_getLogs {pool} blocks {from_block}..={exec_block}: {} log(s)", logs.len());
                for log in &logs {
                    let ld = &log.inner.data;
                    let topics = ld.topics();
                    if topics.is_empty() { continue; }
                    let data = ld.data.as_ref();
                    if topics[0] == co_sig {
                        // claimId is the lone indexed topic; (destChain,destCommitment,nullifier,assetId) in data.
                        if topics.len() < 2 || data.len() < 128 { continue; }
                        let dest_chain = u16::from_be_bytes([data[30], data[31]]);
                        if dest_chain != DEST_CHAIN_BITCOIN { continue; } // only Bitcoin-destined cross-outs fold
                        new_co.push(CoRecord {
                            claim_id: topics[1],
                            dest_chain,
                            dest_commitment: B256::from_slice(&data[32..64]),
                            nullifier: B256::from_slice(&data[64..96]),
                            asset_id: B256::from_slice(&data[96..128]),
                        });
                    } else if topics[0] == cn_sig {
                        // abi.encode(bytes32[] nullifiers, bytes32 spendRoot): [offset, spendRoot, len, nu...].
                        if data.len() < 96 { continue; }
                        let spend_root = B256::from_slice(&data[32..64]);
                        let len = u64::from_be_bytes(data[88..96].try_into().unwrap()) as usize;
                        for i in 0..len {
                            let o = 96 + i * 32;
                            if data.len() < o + 32 { break; }
                            new_cn.push(CnRecord { nullifier: B256::from_slice(&data[o..o + 32]), spend_root });
                        }
                    }
                }
            }
            eprintln!("new entries: {} cross-out(s), {} consumed ν", new_co.len(), new_cn.len());

            // Resume the append-only accumulators from the prior records, then build each NEW entry's witness
            // (the frontier append_path captured BEFORE its append — the guest folds with keccak_tree_append_transition).
            let mut co_acc = KeccakTreeAccumulator::new();
            for r in &state.crossouts { co_acc.append(&co_leaf(r)); }
            let prior_set_root = B256::from(co_acc.root());
            let prior_count = state.crossouts.len() as u64;
            let crossouts: Vec<CrossOutWitness> = new_co.iter().map(|r| {
                let append_path = co_acc.append_path().into_iter().map(B256::from).collect();
                co_acc.append(&co_leaf(r));
                CrossOutWitness { claim_id: r.claim_id, dest_chain: r.dest_chain, dest_commitment: r.dest_commitment, nullifier: r.nullifier, asset_id: r.asset_id, append_path }
            }).collect();

            let mut cn_acc = KeccakTreeAccumulator::new();
            for r in &state.consumeds { cn_acc.append(&cn_leaf(r)); }
            let prior_consumed_root = B256::from(cn_acc.root());
            let prior_consumed_count = state.consumeds.len() as u64;
            let consumeds: Vec<ConsumedWitness> = new_cn.iter().map(|r| {
                let append_path = cn_acc.append_path().into_iter().map(B256::from).collect();
                cn_acc.append(&cn_leaf(r));
                ConsumedWitness { nullifier: r.nullifier, spend_root: r.spend_root, append_path }
            }).collect();

            // eth_getProof witness against the FINALIZED execution block: each NEW crossOutCommitment[claimId],
            // each fast-lane consume's bitcoinConsumed[ν] slot AND append-order bitcoinConsumedAt[index] slot,
            // plus the bitcoinConsumedCount plain slot (the freshness anchor the guest asserts consumed_count
            // against). Slot keys come from the SAME cxfer-core derivation the guest uses (KAT-pinned), so they
            // can't drift; the guest also asserts no stray / unproven slot.
            let mut keys: Vec<B256> = Vec::with_capacity(crossouts.len() + 2 * consumeds.len() + 1);
            for co in &crossouts { keys.push(B256::from(mapping_slot_key(&co.claim_id.0, CROSSOUT_SLOT_INDEX))); }
            for (offset, cw) in consumeds.iter().enumerate() {
                let index = prior_consumed_count
                    .checked_add(offset as u64)
                    .ok_or_else(|| anyhow::anyhow!("consumed index overflow"))?;
                keys.push(B256::from(mapping_slot_key(&cw.nullifier.0, CONSUMED_SLOT_INDEX)));
                keys.push(B256::from(mapping_slot_key(&consumed_at_key(index), CONSUMED_AT_SLOT_INDEX)));
            }
            keys.push(B256::from(plain_slot_key(CONSUMED_COUNT_SLOT_INDEX))); // freshness anchor — always proven

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
            let ethr = EthReflInputs {
                pool,
                prior_set_root,
                prior_count,
                crossouts,
                prior_consumed_root,
                prior_consumed_count,
                consumeds,
            };
            // The cumulative sets after this cycle (prior + new) — the persisted resume + the emitted bundle.
            let mut full_co = state.crossouts.clone(); full_co.extend(new_co);
            let mut full_cn = state.consumeds.clone(); full_cn.extend(new_cn);
            Ok::<_, anyhow::Error>((serde_cbor::to_vec(&lc)?, serde_cbor::to_vec(&ethr)?, full_co, full_cn, exec_block))
        })?;
        out
    };

    let mut stdin = SP1Stdin::new();
    stdin.write_vec(lc_bytes);
    stdin.write_vec(ethr_bytes);

    // Prover backend, selected by SP1_PROVER (cpu | cuda | network); default cpu. A hardcoded `.cuda()`
    // couples the run to a GPU server whose image tag must exactly match the sp1-sdk version — a skew (e.g.
    // a 6.3.x server against this 6.2.3 client) returns an empty proof and then aborts in the CUDA session's
    // async teardown ("no reactor running", the destructor runs outside the Tokio runtime). cpu is
    // self-contained with no external service to drift, so it is the safe default; set SP1_PROVER=cuda or
    // network for throughput once the backend version is matched. Each arm keeps its own concrete prover
    // type (they do not unify), so the setup+prove is inlined per backend.
    let backend = std::env::var("SP1_PROVER").unwrap_or_else(|_| "cpu".into());
    println!("proving compressed ({backend})...");
    let proof = if backend == "cuda" {
        let c = ProverClient::builder().cuda().build();
        let pk = c.setup(Elf::Static(ETH_ELF)).expect("setup");
        println!("ETH vkey = {}", pk.verifying_key().bytes32());
        c.prove(&pk, stdin).compressed().run().expect("compressed proof failed")
    } else {
        let c = ProverClient::builder().cpu().build();
        let pk = c.setup(Elf::Static(ETH_ELF)).expect("setup");
        c.prove(&pk, stdin).compressed().run().expect("compressed proof failed")
    };
    let pv = proof.public_values.as_slice().to_vec();
    println!("eth pv_bytes={}", pv.len());
    assert!(
        pv.len() >= 11 * 32,
        "expected 11-field (352B) eth pv (fast lane), got {}",
        pv.len()
    );
    println!(
        "PREV_SYNC_COMMITTEE (ETH_GENESIS_SYNC_COMMITTEE) = 0x{}",
        hex::encode(&pv[8 * 32..9 * 32])
    );
    println!("ethPool word = 0x{}", hex::encode(&pv[2 * 32..3 * 32]));
    println!("crossOutSetRoot = 0x{}", hex::encode(&pv[3 * 32..4 * 32]));
    println!(
        "finalizedSlot = {}",
        u64::from_be_bytes(pv[5 * 32 + 24..6 * 32].try_into().unwrap())
    );

    std::fs::create_dir_all("/root/work/prover-host/out")?;
    proof
        .save("/root/work/prover-host/out/eth_compressed.bin")
        .expect("save proof");
    std::fs::write("/root/work/prover-host/out/eth_pv.hex", hex::encode(&pv))?;

    // Emit the candidate cumulative sets + the bundle the Bitcoin fixture builder consumes. The committed
    // resume file is advanced by the submit loop only after the outer attest is accepted, keeping host state
    // aligned with the chain if bitcoin_prove or submission fails.
    let new_state = EthSetState {
        last_block: exec_block,
        crossouts: full_co,
        consumeds: full_cn,
    };
    std::fs::write(PENDING_STATE_PATH, serde_json::to_string(&new_state)?)?;
    let bundle = EthSetBundle {
        ethPv: format!("0x{}", hex::encode(&pv)),
        crossouts: new_state
            .crossouts
            .iter()
            .map(|r| CoBundle {
                claimId: hx(&r.claim_id),
                destCommitment: hx(&r.dest_commitment),
                asset: hx(&r.asset_id),
            })
            .collect(),
        consumeds: new_state
            .consumeds
            .iter()
            .map(|r| CnBundle {
                nu: hx(&r.nullifier),
                spendRoot: hx(&r.spend_root),
            })
            .collect(),
    };
    std::fs::write(
        "/root/work/prover-host/out/eth_set.json",
        serde_json::to_string(&bundle)?,
    )?;
    println!(
        "WROTE out/eth_compressed.bin + eth_pv.hex + eth_set.json + eth_set_state.pending.json ({} crossout(s), {} consumed)",
        new_state.crossouts.len(),
        new_state.consumeds.len()
    );
    use std::io::Write;
    std::io::stdout().flush().ok();
    std::process::exit(0); // skip the sp1-cuda client Drop (it spawns on a missing runtime and aborts)
}
