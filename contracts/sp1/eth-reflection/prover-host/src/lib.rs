// Helios light-client bootstrap helpers, copied verbatim from sp1-helios/script/src/lib.rs (pure helios,
// no sp1-sdk) so this 6.2.3 host crate can build the eth-reflection inputs without depending on the
// sp1-helios-script crate (whose =6.1.0 sp1-sdk pin would conflict with our =6.2.3).
use alloy_primitives::B256;
use helios_consensus_core::{
    calc_sync_period,
    consensus_spec::MainnetConsensusSpec,
    types::{BeaconBlock, Update},
};
use helios_ethereum::rpc::ConsensusRpc;
use helios_ethereum::{
    config::{checkpoints, networks::Network, Config},
    consensus::Inner,
    rpc::http_rpc::HttpRpc,
};
use anyhow::{anyhow, Result};
use std::sync::Arc;
use tokio::sync::{mpsc::channel, watch};
use tree_hash::TreeHash;

pub const MAX_REQUEST_LIGHT_CLIENT_UPDATES: u8 = 128;

pub async fn get_updates(
    client: &Inner<MainnetConsensusSpec, HttpRpc>,
) -> Vec<Update<MainnetConsensusSpec>> {
    let period =
        calc_sync_period::<MainnetConsensusSpec>(client.store.finalized_header.beacon().slot);
    let updates = client
        .rpc
        .get_updates(period, MAX_REQUEST_LIGHT_CLIENT_UPDATES)
        .await
        .unwrap();
    updates.clone()
}

pub async fn get_latest_checkpoint(chain_id: u64) -> Result<B256> {
    let cf = checkpoints::CheckpointFallback::new()
        .build()
        .await
        .map_err(|e| anyhow!("error building checkpoint fallback: {}", e.to_string()))?;
    let network = Network::from_chain_id(chain_id).unwrap_or_else(|_| {
        panic!("unknown network: {chain_id}");
    });
    cf.fetch_latest_checkpoint(&network)
        .await
        .map_err(|e| anyhow!("error fetching latest checkpoint: {}", e.to_string()))
}

pub async fn get_client(
    slot: Option<u64>,
    consensus_rpc: &str,
    chain_id: u64,
) -> Result<Inner<MainnetConsensusSpec, HttpRpc>> {
    let network = Network::from_chain_id(chain_id).unwrap();
    let base_config = network.to_base_config();
    let config = Config {
        consensus_rpc: consensus_rpc.parse()?,
        execution_rpc: None,
        chain: base_config.chain,
        forks: base_config.forks,
        strict_checkpoint_age: false,
        ..Default::default()
    };
    let (block_send, _) = channel(256);
    let (finalized_block_send, _) = watch::channel(None);
    let (channel_send, _) = watch::channel(None);
    let mut client = Inner::<MainnetConsensusSpec, HttpRpc>::new(
        consensus_rpc,
        block_send,
        finalized_block_send,
        channel_send,
        Arc::new(config),
    );
    let root = match slot {
        Some(slot) => {
            let block: BeaconBlock<MainnetConsensusSpec> = client
                .rpc
                .get_block(slot)
                .await
                .map_err(|e| anyhow!("error getting block: {}", e.to_string()))?;
            block.tree_hash_root()
        }
        None => get_latest_checkpoint(chain_id).await?,
    };
    client
        .bootstrap(root)
        .await
        .map_err(|e| anyhow!("error bootstrapping client: {}", e.to_string()))?;
    Ok(client)
}
