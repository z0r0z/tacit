#!/bin/bash
set -euo pipefail

# tETH Bridge: continuous SP1 prover loop for vast.ai.
#
# Runs on the instance. Each cycle advances the Bitcoin light relay to a bounded
# target, generates an SP1 proof of the pool-state transition over exactly those
# blocks (so lastBlockHash == RELAY.tip()), and submits it to the verifier.
#
# Setup once: scripts/vastai-setup.sh (installs Rust + Foundry, builds the host
# which embeds the committed canonical guest ELF — no SP1 toolchain / guest build).
#
# Required env:
#   ETH_PK              Ethereum key for proof submission + relay advance
#   MIXER_ADDRESS       deployed TacitBridgeMixer (no 0x)
#   VERIFIER_ADDRESS    deployed SP1PoolRootVerifier (no 0x)
#   RELAY_ADDRESS       deployed relay (no 0x)
#   ASSET_ID            asset id (no 0x)
#   DEPLOY_BLOCK        ETH deploy block (hex) — deposit-event scan start
#   FIRST_DEPOSIT_BLOCK relay genesis height + 1 (first block the genesis proof covers)
# Optional env:
#   GENESIS_ANCHOR      relay genesis block hash (the guest's genesis prev_block)
#   NETWORK (signet|mainnet) | ETH_RPC | BLOCKS_PER_PROOF (10) | CONFIRMATIONS (6)
#   SLEEP_SECONDS (600) | STATE_DIR | SP1_PROVER (cpu|cuda) | POOL_IDS | DEPOSIT_ROOTS_FILE

REPO_DIR="${REPO_DIR:-/workspace/tacit}"
STATE_DIR="${STATE_DIR:-/workspace/prover-state}"
BLOCKS_PER_PROOF="${BLOCKS_PER_PROOF:-10}"
SLEEP_SECONDS="${SLEEP_SECONDS:-600}"

# Network config
NETWORK="${NETWORK:-signet}"
if [[ "$NETWORK" == "mainnet" ]]; then
  BTC_API="${BTC_API:-https://mempool.space/api}"
  ETH_RPC="${ETH_RPC:-https://ethereum-rpc.publicnode.com}"
  NETWORK_TAG=0
  CHAIN_ID=1
else
  BTC_API="${BTC_API:-https://mempool.space/signet/api}"
  ETH_RPC="${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
  ASSET_ID="${ASSET_ID:-d903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b}"
  NETWORK_TAG=1
  CHAIN_ID=11155111
fi

# Deployment-specific (no stale defaults, no 0x).
MIXER_ADDRESS="${MIXER_ADDRESS:?Set MIXER_ADDRESS (deployed mixer, no 0x)}"
VERIFIER_ADDRESS="${VERIFIER_ADDRESS:?Set VERIFIER_ADDRESS (deployed SP1 verifier, no 0x)}"
RELAY_ADDRESS="${RELAY_ADDRESS:?Set RELAY_ADDRESS (deployed relay, no 0x)}"
ASSET_ID="${ASSET_ID:?Set ASSET_ID (asset id, no 0x)}"
DEPLOY_BLOCK="${DEPLOY_BLOCK:?Set DEPLOY_BLOCK (ETH deploy block, hex)}"
FIRST_DEPOSIT_BLOCK="${FIRST_DEPOSIT_BLOCK:?Set FIRST_DEPOSIT_BLOCK (relay genesis height + 1)}"
GENESIS_ANCHOR="${GENESIS_ANCHOR:-}"
CONFIRMATIONS="${CONFIRMATIONS:-6}"
# Tacit-unit (8-dec) denominations the guest tracks, comma-separated.
DENOMINATIONS="${DENOMINATIONS:-000186a0,000f4240,00989680,05f5e100,3b9aca00,02540be400}"
POOL_IDS="${POOL_IDS:-}"

ETH_PK="${ETH_PK:?Set ETH_PK (Ethereum private key)}"
SP1_PROVER="${SP1_PROVER:-cpu}"

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

get_relay_tip() {
  curl -sf -X POST "$ETH_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x${RELAY_ADDRESS}\",\"data\":\"0x1fd4827a\"},\"latest\"]}" \
    | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'], 16))" 2>/dev/null
}
get_btc_tip() { curl -sf "${BTC_API}/blocks/tip/height" 2>/dev/null; }
get_last_proven_height() {
  [[ -f "${STATE_DIR}/last_proven_block.txt" ]] && cat "${STATE_DIR}/last_proven_block.txt" || echo "0"
}

submit_proof() {
  local pv proof
  [[ -f "${STATE_DIR}/public_values.hex" && -f "${STATE_DIR}/proof_bytes.hex" ]] || { log "ERROR: submission files missing"; return 1; }
  pv=$(cat "${STATE_DIR}/public_values.hex"); proof=$(cat "${STATE_DIR}/proof_bytes.hex")
  # depositAccs + burn claims ride in the authenticated public-values tail → (pv, proof).
  log "Submitting to verifier 0x${VERIFIER_ADDRESS} (pv ${#pv} hex, proof ${#proof} hex)..."
  local result
  result=$(cast send "0x${VERIFIER_ADDRESS}" 'proveStateTransition(bytes,bytes)' \
    "0x${pv}" "0x${proof}" --rpc-url "$ETH_RPC" --private-key "$ETH_PK" --gas-limit 1500000 2>&1) || true
  if echo "$result" | grep -q "status.*1"; then
    log "Proof accepted on-chain!"
  else
    log "Proof submission failed:"; echo "$result" | grep -E "status|transactionHash|error|revert|0x" | head -5
    return 1
  fi
}

run_proof_cycle() {
  local last_proven btc_tip start_height target max_confirmed relay_tip num_blocks
  last_proven=$(get_last_proven_height)
  btc_tip=$(get_btc_tip)
  [[ -n "$btc_tip" ]] || { log "could not fetch Bitcoin tip"; return 1; }

  if [[ "$last_proven" == "0" ]]; then start_height=$FIRST_DEPOSIT_BLOCK; else start_height=$((last_proven + 1)); fi

  # Bounded batch ending exactly at the relay tip (verifier needs lastBlockHash == RELAY.tip()).
  target=$((start_height + BLOCKS_PER_PROOF - 1))
  max_confirmed=$((btc_tip - CONFIRMATIONS))
  [[ "$target" -gt "$max_confirmed" ]] && target=$max_confirmed
  if [[ "$target" -lt "$start_height" ]]; then
    log "Waiting for confirmed Bitcoin blocks (start=$start_height, confirmed=$max_confirmed)"; return 1
  fi

  # Advance the relay to exactly $target, in <=20-header chunks.
  relay_tip=$(get_relay_tip)
  while [[ "$relay_tip" -lt "$target" ]]; do
    local chunk_end=$((relay_tip + 20)); [[ "$chunk_end" -gt "$target" ]] && chunk_end=$target
    log "Advancing relay $relay_tip -> $chunk_end"
    local headers=""
    for h in $(seq $((relay_tip + 1)) "$chunk_end"); do
      local bh; bh=$(curl -sf "${BTC_API}/block-height/$h")
      headers+=$(curl -sf "${BTC_API}/block/$bh/header")
    done
    if ! cast send "0x${RELAY_ADDRESS}" 'advanceTip(bytes)' "0x${headers}" \
        --rpc-url "$ETH_RPC" --private-key "$ETH_PK" --gas-limit 3000000 2>&1 | grep -q "status.*1"; then
      log "Relay advance failed ($relay_tip -> $chunk_end)"; return 1
    fi
    relay_tip=$(get_relay_tip)
  done

  num_blocks=$((target - start_height + 1))
  log "Proving blocks $start_height..$target ($num_blocks) up to relay tip"
  cd "${REPO_DIR}/contracts/sp1/script"
  ASSET_ID="$ASSET_ID" MIXER_ADDRESS="$MIXER_ADDRESS" DENOMINATIONS="$DENOMINATIONS" \
  NETWORK="$NETWORK" NETWORK_TAG="$NETWORK_TAG" CHAIN_ID="$CHAIN_ID" DEPLOY_BLOCK="$DEPLOY_BLOCK" \
  STATE_DIR="$STATE_DIR" OUTPUT_DIR="$STATE_DIR" ETH_RPC="$ETH_RPC" SP1_PROVER="$SP1_PROVER" \
  ${POOL_IDS:+POOL_IDS="$POOL_IDS"} ${DEPOSIT_ROOTS_FILE:+DEPOSIT_ROOTS_FILE="$DEPOSIT_ROOTS_FILE"} \
  cargo run --release --bin teth-prover -- \
    --start-height "$start_height" --num-blocks "$num_blocks" --onchain 2>&1 | tee "${STATE_DIR}/last_proof.log"

  [[ -f "${STATE_DIR}/public_values.hex" ]] || { log "ERROR: proof artifacts not generated"; return 1; }
  submit_proof || return 1
  echo "$target" > "${STATE_DIR}/last_proven_block.txt"
  log "Cycle complete: blocks $start_height-$target proven and accepted"
}

log "=== tETH SP1 Prover Loop ==="
log "  Network: $NETWORK | Prover: $SP1_PROVER | Blocks/proof: $BLOCKS_PER_PROOF"
log "  Mixer 0x$MIXER_ADDRESS | Verifier 0x$VERIFIER_ADDRESS | Relay 0x$RELAY_ADDRESS"
log ""
while true; do
  run_proof_cycle || log "Proof cycle skipped"
  log "Sleeping ${SLEEP_SECONDS}s..."
  sleep "$SLEEP_SECONDS"
done
