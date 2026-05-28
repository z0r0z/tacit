#!/bin/bash
set -euo pipefail

# tETH Bridge: one-shot — generate an SP1 groth16 proof on a vast.ai instance for a
# block range, download it, and submit to the on-chain verifier. For continuous
# operation use sp1-prover-loop.sh (runs on the instance itself).
#
# Prereqs: the instance is bootstrapped via scripts/vastai-setup.sh.
#
# Required env:
#   VASTAI_HOST   ssh host of the prover instance
#   VASTAI_PORT   ssh port
#   ETH_PK        Ethereum key for proof submission (0x-prefixed)
#   VERIFIER      deployed SP1PoolRootVerifier address
#   MIXER_ADDRESS deployed TacitBridgeMixer address (no 0x)
#   ASSET_ID      tETH asset id (0x-prefixed)
# Optional env:
#   ETH_RPC (default Sepolia public) | NETWORK (signet|mainnet) | NETWORK_TAG | CHAIN_ID
#   VASTAI_USER (default root) | REMOTE_DIR

VASTAI_USER="${VASTAI_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/workspace/tacit/contracts/sp1/script}"
ETH_RPC="${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
NETWORK="${NETWORK:-signet}"
NETWORK_TAG="${NETWORK_TAG:-1}"
CHAIN_ID="${CHAIN_ID:-11155111}"

: "${VASTAI_HOST:?Set VASTAI_HOST}"
: "${VASTAI_PORT:?Set VASTAI_PORT}"
: "${ETH_PK:?Set ETH_PK (Ethereum key for proof submission)}"
: "${VERIFIER:?Set VERIFIER (deployed SP1PoolRootVerifier address)}"
: "${MIXER_ADDRESS:?Set MIXER_ADDRESS (deployed mixer, no 0x)}"
: "${ASSET_ID:?Set ASSET_ID (tETH asset id)}"

START_HEIGHT=""
NUM_BLOCKS="1"
EXECUTE_ONLY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --start) START_HEIGHT="$2"; shift 2 ;;
    --blocks) NUM_BLOCKS="$2"; shift 2 ;;
    --execute-only) EXECUTE_ONLY="--execute-only"; shift ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done
[[ -n "$START_HEIGHT" ]] || { echo "Usage: $0 --start <height> --blocks <n> [--execute-only]"; exit 1; }
MODE="${EXECUTE_ONLY:---onchain}"  # --execute-only if requested, else groth16 for on-chain

echo "=== tETH SP1 Prover (vast.ai: ${VASTAI_USER}@${VASTAI_HOST}:${VASTAI_PORT}) ==="
echo "  Blocks: ${START_HEIGHT}..$((START_HEIGHT + NUM_BLOCKS - 1))  Network: ${NETWORK}"
echo ""

# ──── Step 1: prove on the instance (pull latest guest first) ────
echo "Step 1: Proving on vast.ai..."
ssh -p "$VASTAI_PORT" "${VASTAI_USER}@${VASTAI_HOST}" bash -s <<EOF
set -e
source ~/.cargo/env 2>/dev/null || true
export PATH="\$HOME/.sp1/bin:\$HOME/.foundry/bin:\$PATH"
cd /workspace/tacit && git pull --ff-only
cd contracts/sp1/program && cargo-prove prove build
cd "$REMOTE_DIR"
NETWORK="$NETWORK" NETWORK_TAG="$NETWORK_TAG" CHAIN_ID="$CHAIN_ID" \
ASSET_ID="$ASSET_ID" MIXER_ADDRESS="$MIXER_ADDRESS" ETH_RPC="$ETH_RPC" \
SP1_PROVER="\${SP1_PROVER:-cpu}" \
cargo run --release --bin teth-prover -- --start-height ${START_HEIGHT} --num-blocks ${NUM_BLOCKS} ${MODE}
EOF

if [[ -n "$EXECUTE_ONLY" ]]; then
  echo ""; echo "Execute-only — no proof to submit."; exit 0
fi

# ──── Step 2: download proof artifacts ────
echo ""; echo "Step 2: Downloading proof artifacts..."
scp -P "$VASTAI_PORT" \
  "${VASTAI_USER}@${VASTAI_HOST}:${REMOTE_DIR}/public_values.hex" \
  "${VASTAI_USER}@${VASTAI_HOST}:${REMOTE_DIR}/proof_bytes.hex" .
echo "  public_values.hex: $(( $(wc -c < public_values.hex) / 2 )) bytes"
echo "  proof_bytes.hex:   $(( $(wc -c < proof_bytes.hex) / 2 )) bytes"

# ──── Step 3: submit (depositAccs + burn claims ride in the authenticated PV tail) ────
echo ""; echo "Step 3: Submitting to verifier ${VERIFIER}..."
cast send "$VERIFIER" 'proveStateTransition(bytes,bytes)' \
  "0x$(cat public_values.hex)" \
  "0x$(cat proof_bytes.hex)" \
  --rpc-url "$ETH_RPC" --private-key "$ETH_PK" --gas-limit 1500000 \
  | grep -E "status|transactionHash" | head -2

echo ""; echo "=== Done ==="
