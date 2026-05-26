#!/bin/bash
set -euo pipefail

# Advance the Bitcoin light relay on Sepolia with new signet headers.
#
# Usage:
#   ./scripts/advance-relay.sh [--from <height>] [--count <n>]
#
# Fetches headers from mempool.space and submits to the relay contract.

SEPOLIA_RPC="https://ethereum-sepolia-rpc.publicnode.com"
SEPOLIA_PK="${SEPOLIA_PK:-0x950b04c07979d8ff19eb45fd1c14d4834a9b0b912a9744cb2b37593380b7b81b}"
RELAY="0x3337F06CddC27220D4A10dA41719869Fe9fF6690"
MEMPOOL_API="https://mempool.space/signet/api"

FROM_HEIGHT=""
COUNT=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --from) FROM_HEIGHT="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# Get current relay tip
RELAY_TIP_HEIGHT=$(cast call "$RELAY" "tipHeight()(uint256)" --rpc-url "$SEPOLIA_RPC")
echo "Relay tip height: $RELAY_TIP_HEIGHT"

if [[ -z "$FROM_HEIGHT" ]]; then
  FROM_HEIGHT=$((RELAY_TIP_HEIGHT + 1))
fi

SIGNET_TIP=$(curl -s "$MEMPOOL_API/blocks/tip/height")
echo "Signet tip: $SIGNET_TIP"
echo "Advancing from $FROM_HEIGHT (+$COUNT headers)"

if [[ $FROM_HEIGHT -gt $SIGNET_TIP ]]; then
  echo "Already up to date."
  exit 0
fi

# Cap count to available blocks
AVAILABLE=$((SIGNET_TIP - FROM_HEIGHT + 1))
if [[ $COUNT -gt $AVAILABLE ]]; then
  COUNT=$AVAILABLE
fi

# Fetch and concatenate headers
HEADERS=""
for ((h = FROM_HEIGHT; h < FROM_HEIGHT + COUNT; h++)); do
  HASH=$(curl -s "$MEMPOOL_API/block-height/$h")
  HDR=$(curl -s "$MEMPOOL_API/block/$HASH/header")
  HEADERS="${HEADERS}${HDR}"
  echo "  Block $h: $HASH"
done

echo ""
echo "Submitting $COUNT headers to relay..."
cast send "$RELAY" "advanceTip(bytes)" "0x${HEADERS}" \
  --rpc-url "$SEPOLIA_RPC" \
  --private-key "$SEPOLIA_PK" \
  --gas-limit 2000000 2>&1 | grep "status\|transactionHash" | head -2

echo ""
NEW_TIP=$(cast call "$RELAY" "tipHeight()(uint256)" --rpc-url "$SEPOLIA_RPC")
echo "New relay tip: $NEW_TIP"
