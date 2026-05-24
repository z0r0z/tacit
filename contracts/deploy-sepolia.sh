#!/bin/bash
set -euo pipefail

# tETH Bridge Sepolia Deployment
# Prerequisites:
#   - DEPLOYER_PRIVATE_KEY set (Sepolia-funded account)
#   - SEPOLIA_RPC set (e.g. https://rpc.sepolia.org or Alchemy/Infura)
#   - forge installed
#   - A recent Bitcoin signet block header (80 bytes hex)

echo "=== tETH Bridge — Sepolia Deployment ==="

# Check env vars
: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY (hex, with 0x prefix)}"
: "${SEPOLIA_RPC:?Set SEPOLIA_RPC (e.g. https://rpc.sepolia.org)}"

# Get a recent signet block for the relay genesis.
# Use mempool.space API to fetch the latest signet block header.
echo ""
echo "Step 1: Fetching recent signet block header for relay genesis..."
SIGNET_TIP=$(curl -s "https://mempool.space/signet/api/blocks/tip/height")
SIGNET_HASH=$(curl -s "https://mempool.space/signet/api/blocks/tip/hash")
SIGNET_HEADER=$(curl -s "https://mempool.space/signet/api/block/${SIGNET_HASH}/header")
echo "  Signet tip: height=${SIGNET_TIP} hash=${SIGNET_HASH}"
echo "  Header: ${SIGNET_HEADER:0:40}..."

# Deploy contracts
echo ""
echo "Step 2: Deploying BitcoinHeaderRelay + TacitETHMixer to Sepolia..."
echo "  (This uses forge script — review the output for deployed addresses)"
echo ""

BTC_GENESIS_HEADER="0x${SIGNET_HEADER}" \
BTC_GENESIS_HEIGHT="${SIGNET_TIP}" \
BTC_GENESIS_CHAIN_WORK=1 \
forge script script/Deploy.s.sol:DeployTacitBridge \
  --rpc-url "${SEPOLIA_RPC}" \
  --broadcast \
  -vvv

echo ""
echo "Step 3: Record the deployed addresses above, then:"
echo "  1. Update teth-metadata-sepolia.json with eth_mixer_address"
echo "  2. Pin metadata + teth.svg to IPFS via worker /pin-json"
echo "  3. CETCH the tETH asset on signet"
echo "  4. Init the 1 ETH pool (T_DEPOSIT)"
echo "  5. Set up attestor to post Sepolia roots"
echo "  6. Run: node tests/bridge-e2e-testnet.mjs"
echo ""
echo "=== Deployment complete ==="
