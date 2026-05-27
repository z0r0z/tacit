#!/bin/bash
set -euo pipefail

# tETH Bridge: Continuous SP1 prover loop for vast.ai
#
# Runs on the vast.ai instance itself. Continuously processes new Bitcoin
# blocks, generates SP1 proofs, and submits them to the Ethereum verifier.
#
# Setup (run once on the vast.ai instance):
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
#   source ~/.cargo/env
#   curl -L https://sp1up.succinct.xyz | bash && source ~/.bashrc && sp1up
#   git clone https://github.com/z0r0z/tacit /workspace/tacit
#   cd /workspace/tacit/contracts/sp1/program && ~/.sp1/bin/cargo-prove prove build
#   cd /workspace/tacit/contracts/sp1/script && cargo build --release
#   cp /workspace/tacit/scripts/sp1-prover-loop.sh /workspace/prover.sh
#   chmod +x /workspace/prover.sh
#
# Usage:
#   ETH_PK=0x... /workspace/prover.sh
#
# Env vars:
#   ETH_PK              — Ethereum private key for submitting proofs (required)
#   ETH_RPC             — Ethereum RPC (default: Sepolia public)
#   NETWORK             — "signet" or "mainnet" (default: signet)
#   BLOCKS_PER_PROOF    — blocks per proof batch (default: 10)
#   SLEEP_SECONDS       — seconds between proof cycles (default: 600 = 10 min)
#   STATE_DIR           — persistent state directory (default: /workspace/prover-state)
#   SP1_PROVER          — "cpu" or "cuda" (default: cpu)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-/workspace/tacit}"
PROVER_BIN="${REPO_DIR}/contracts/sp1/script/target/release/teth-prover"
STATE_DIR="${STATE_DIR:-/workspace/prover-state}"
BLOCKS_PER_PROOF="${BLOCKS_PER_PROOF:-10}"
SLEEP_SECONDS="${SLEEP_SECONDS:-600}"

# Network defaults
NETWORK="${NETWORK:-signet}"
if [[ "$NETWORK" == "mainnet" ]]; then
  BTC_API="${BTC_API:-https://mempool.space/api}"
  ETH_RPC="${ETH_RPC:-https://ethereum-rpc.publicnode.com}"
  MIXER_ADDRESS="${MIXER_ADDRESS:?Set MIXER_ADDRESS for mainnet}"
  VERIFIER_ADDRESS="${VERIFIER_ADDRESS:?Set VERIFIER_ADDRESS for mainnet}"
  RELAY_ADDRESS="${RELAY_ADDRESS:?Set RELAY_ADDRESS for mainnet}"
  ASSET_ID="${ASSET_ID:?Set ASSET_ID for mainnet}"
  DENOMINATION="${DENOMINATION:?Set DENOMINATION for mainnet}"
  POOL_ID="${POOL_ID:?Set POOL_ID for mainnet}"
  DEPLOY_BLOCK="${DEPLOY_BLOCK:?Set DEPLOY_BLOCK for mainnet}"
  NETWORK_TAG=0
  CHAIN_ID=1
else
  BTC_API="${BTC_API:-https://mempool.space/signet/api}"
  ETH_RPC="${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
  MIXER_ADDRESS="${MIXER_ADDRESS:-13124e519c9c11ef200fc4c36ed5a7010750f00e}"
  VERIFIER_ADDRESS="${VERIFIER_ADDRESS:-fe1670ea5173dbcfe2a9e936447854cc8e3a2d17}"
  RELAY_ADDRESS="${RELAY_ADDRESS:-3337F06CddC27220D4A10dA41719869Fe9fF6690}"
  ASSET_ID="${ASSET_ID:-d903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b}"
  DENOMINATION="${DENOMINATION:-00000000000000000000000000000000000000000000000000000000000186a0}"
  POOL_ID="${POOL_ID:-0c5d21b00bbd6b38d324efe3cd640b5dc9fe6d4d210a2939963009148dd11eef}"
  DEPLOY_BLOCK="${DEPLOY_BLOCK:-0xa6b8a5}"
  NETWORK_TAG=1
  CHAIN_ID=11155111
fi

ETH_PK="${ETH_PK:?Set ETH_PK (Ethereum private key for proof submission)}"
SP1_PROVER="${SP1_PROVER:-cpu}"

mkdir -p "$STATE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

get_relay_tip() {
  local sel="0x37d0208c"  # tipHeight()
  local result
  result=$(curl -sf -X POST "$ETH_RPC" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x${RELAY_ADDRESS}\",\"data\":\"${sel}\"},\"latest\"]}" \
    | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'], 16))" 2>/dev/null)
  echo "$result"
}

get_btc_tip() {
  curl -sf "${BTC_API}/blocks/tip/height" 2>/dev/null
}

get_last_proven_height() {
  if [[ -f "${STATE_DIR}/last_proven_block.txt" ]]; then
    cat "${STATE_DIR}/last_proven_block.txt"
  else
    echo "0"
  fi
}

compute_deposit_roots() {
  local roots_file="${STATE_DIR}/deposit_roots.txt"
  if [[ -f "$roots_file" ]]; then
    cat "$roots_file"
  else
    echo ""
  fi
}

advance_relay_if_needed() {
  local relay_tip btc_tip
  relay_tip=$(get_relay_tip)
  btc_tip=$(get_btc_tip)
  local target=$((relay_tip + BLOCKS_PER_PROOF + 7))

  if [[ "$target" -gt "$btc_tip" ]]; then
    log "Relay at $relay_tip, Bitcoin at $btc_tip — waiting for more blocks"
    return 1
  fi

  local behind=$((btc_tip - relay_tip))
  if [[ "$behind" -gt 6 ]]; then
    log "Advancing relay from $relay_tip (behind by $behind blocks)..."
    local headers=""
    local count=$((behind > 20 ? 20 : behind))
    for h in $(seq $((relay_tip + 1)) $((relay_tip + count))); do
      local bh=$(curl -sf "${BTC_API}/block-height/$h")
      local hdr=$(curl -sf "${BTC_API}/block/$bh/header")
      headers+="$hdr"
    done
    cast send "0x${RELAY_ADDRESS}" 'advanceTip(bytes)' "0x${headers}" \
      --rpc-url "$ETH_RPC" --private-key "$ETH_PK" --gas-limit 2000000 2>&1 | grep "status" || true
    log "Relay advanced"
  fi
  return 0
}

run_proof_cycle() {
  local last_proven start_height btc_tip num_blocks

  last_proven=$(get_last_proven_height)
  btc_tip=$(get_btc_tip)
  local relay_tip=$(get_relay_tip)

  if [[ "$last_proven" == "0" ]]; then
    local first_deposit_block="${FIRST_DEPOSIT_BLOCK:-306106}"
    start_height=$first_deposit_block
  else
    start_height=$((last_proven + 1))
  fi

  local available=$((relay_tip - start_height))
  if [[ "$available" -lt 1 ]]; then
    log "No new blocks to prove (start=$start_height, relay_tip=$relay_tip)"
    return 1
  fi

  num_blocks=$((available > BLOCKS_PER_PROOF ? BLOCKS_PER_PROOF : available))
  local end_height=$((start_height + num_blocks - 1))

  log "Proving blocks $start_height to $end_height ($num_blocks blocks)"

  local deposit_roots
  deposit_roots=$(compute_deposit_roots)

  cd "${REPO_DIR}/contracts/sp1/script"
  ASSET_ID="$ASSET_ID" \
  MIXER_ADDRESS="$MIXER_ADDRESS" \
  DENOMINATION="$DENOMINATION" \
  NETWORK_TAG="$NETWORK_TAG" \
  CHAIN_ID="$CHAIN_ID" \
  POOL_ID="$POOL_ID" \
  DEPLOY_BLOCK="$DEPLOY_BLOCK" \
  STATE_DIR="$STATE_DIR" \
  OUTPUT_DIR="$STATE_DIR" \
  ETH_RPC="$ETH_RPC" \
  SP1_PROVER="$SP1_PROVER" \
  ${DEPOSIT_ROOTS:+DEPOSIT_ROOTS="$deposit_roots"} \
  cargo run --release --bin teth-prover -- \
    --start-height "$start_height" \
    --num-blocks "$num_blocks" \
    --onchain 2>&1 | tee "${STATE_DIR}/last_proof.log"

  if [[ ! -f "proof.bin" ]]; then
    log "ERROR: proof.bin not generated"
    return 1
  fi

  local proof_size
  proof_size=$(wc -c < proof.bin)
  log "Proof generated: ${proof_size} bytes"

  log "Submitting proof to Ethereum..."
  submit_proof "proof.bin" "$start_height" "$num_blocks"

  echo "$end_height" > "${STATE_DIR}/last_proven_block.txt"
  mv proof.bin "${STATE_DIR}/proof_${start_height}_${end_height}.bin"

  log "Cycle complete: blocks $start_height-$end_height proven and submitted"
}

submit_proof() {
  local proof_file="$1"
  local start_height="$2"
  local num_blocks="$3"
  local pv_file="${STATE_DIR}/public_values.hex"
  local proof_hex_file="${STATE_DIR}/proof_bytes.hex"

  if [[ ! -f "$pv_file" ]] || [[ ! -f "$proof_hex_file" ]]; then
    log "ERROR: submission files not found (public_values.hex / proof_bytes.hex)"
    return 1
  fi

  local pv_hex proof_hex
  pv_hex=$(cat "$pv_file")
  proof_hex=$(cat "$proof_hex_file")

  # Extract burn claim IDs from the proof's public values.
  # The SP1 guest commits burn_nullifiers as SHA256(concat(claim_ids)).
  # The burn claim IDs themselves are not in the public values — they must
  # be tracked separately by the prover. For now, pass empty array (no burns
  # in this batch) or read from state file.
  local burn_claims="[]"
  local burn_claims_file="${STATE_DIR}/pending_burn_claims.json"
  if [[ -f "$burn_claims_file" ]]; then
    burn_claims=$(cat "$burn_claims_file")
    log "  Burn claims: $(echo "$burn_claims" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null || echo '?')"
  fi

  log "Submitting proof to verifier 0x${VERIFIER_ADDRESS}..."
  log "  Public values: ${#pv_hex} hex chars"
  log "  Proof bytes: ${#proof_hex} hex chars"

  # proveStateTransition(bytes publicValues, bytes proofBytes, bytes32[] burnClaimIds)
  local result
  result=$(cast send "0x${VERIFIER_ADDRESS}" \
    'proveStateTransition(bytes,bytes,bytes32[])' \
    "0x${pv_hex}" \
    "0x${proof_hex}" \
    "${burn_claims}" \
    --rpc-url "$ETH_RPC" \
    --private-key "$ETH_PK" \
    --gas-limit 1000000 2>&1) || true

  if echo "$result" | grep -q "status.*1"; then
    log "Proof accepted on-chain!"
    # Clear pending burn claims
    rm -f "$burn_claims_file"
  else
    log "Proof submission result:"
    echo "$result" | grep -E "status|transactionHash|error|revert" | head -5
  fi
}

# ──── Main loop ────

log "=== tETH SP1 Prover Loop ==="
log "  Network: $NETWORK"
log "  Prover: $SP1_PROVER"
log "  Blocks/proof: $BLOCKS_PER_PROOF"
log "  Sleep: ${SLEEP_SECONDS}s"
log "  State: $STATE_DIR"
log "  Mixer: 0x$MIXER_ADDRESS"
log "  Verifier: 0x$VERIFIER_ADDRESS"
log ""

while true; do
  if advance_relay_if_needed; then
    run_proof_cycle || log "Proof cycle skipped"
  fi

  log "Sleeping ${SLEEP_SECONDS}s..."
  sleep "$SLEEP_SECONDS"
done
