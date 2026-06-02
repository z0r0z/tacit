#!/bin/bash
set -euo pipefail

# Advance the Bitcoin light relay with new headers.
#
# Usage:
#   ./scripts/advance-relay.sh [--from <height>] [--count <n>]
#
# Env vars: ETH_RPC, RELAY_PK, RELAY_ADDRESS, MEMPOOL_API
# Defaults to Sepolia/signet. For mainnet:
#   ETH_RPC=https://ethereum-rpc.publicnode.com \
#   RELAY_ADDRESS=0x... RELAY_PK=0x... \
#   MEMPOOL_API=https://mempool.space/api \
#   ./scripts/advance-relay.sh

ETH_RPC="${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
RELAY_PK="${RELAY_PK:-${SEPOLIA_PK:-}}"
RELAY_ADDRESS="${RELAY_ADDRESS:-0x3337F06CddC27220D4A10dA41719869Fe9fF6690}"
MEMPOOL_API="${MEMPOOL_API:-https://mempool.space/signet/api}"

if [[ -z "$RELAY_PK" ]]; then echo "Set RELAY_PK (or SEPOLIA_PK for testnet)"; exit 1; fi

FROM_HEIGHT=""
COUNT=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --from) FROM_HEIGHT="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# Get current relay tip (strip cast's "[1.23e4]" annotation)
RELAY_TIP_HEIGHT=$(cast call "$RELAY_ADDRESS" "tipHeight()(uint256)" --rpc-url "$ETH_RPC" | awk '{print $1}')
echo "Relay tip height: $RELAY_TIP_HEIGHT"

if [[ -z "$FROM_HEIGHT" ]]; then
  FROM_HEIGHT=$((RELAY_TIP_HEIGHT + 1))
fi

SIGNET_TIP=$(curl -s "$MEMPOOL_API/blocks/tip/height")
echo "Bitcoin tip: $SIGNET_TIP"
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

# Cap at the difficulty-epoch boundary. advanceTip reverts UnknownEpoch on the
# first block of a new 2016-block epoch until retarget() sets that epoch's
# target, so never include it: stop at the last block of the current epoch and
# tell the operator to run retarget-relay.sh.
EPOCH=$(cast call "$RELAY_ADDRESS" "currentEpoch()(uint256)" --rpc-url "$ETH_RPC" | awk '{print $1}')
BOUNDARY=$(( (EPOCH + 1) * 2016 - 1 ))
if [[ $((FROM_HEIGHT + COUNT - 1)) -gt $BOUNDARY ]]; then
  COUNT=$(( BOUNDARY - FROM_HEIGHT + 1 ))
  echo "Capping at epoch-$EPOCH boundary (block $BOUNDARY). After this, run retarget-relay.sh before advancing further."
fi
if [[ $COUNT -le 0 ]]; then
  echo "Tip is at the epoch boundary ($BOUNDARY). Run retarget-relay.sh to cross into epoch $((EPOCH+1))."
  exit 0
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
cast send "$RELAY_ADDRESS" "advanceTip(bytes)" "0x${HEADERS}" \
  --rpc-url "$ETH_RPC" \
  --private-key "$RELAY_PK" \
  --gas-limit 5000000 2>&1 | grep "status\|transactionHash" | head -2

echo ""
NEW_TIP=$(cast call "$RELAY_ADDRESS" "tipHeight()(uint256)" --rpc-url "$ETH_RPC" | awk '{print $1}')
echo "New relay tip: $NEW_TIP"
