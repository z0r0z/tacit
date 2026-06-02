#!/bin/bash
set -euo pipefail

# Retarget the Bitcoin light relay across a difficulty-epoch boundary.
#
# advanceTip() cannot cross into a new 2016-block epoch until retarget() has set
# that epoch's target — it reverts UnknownEpoch at the boundary. So at every
# boundary the operator must: advance the tip to the last block of the old epoch
# (tipHeight == (currentEpoch+1)*2016 - 1), then call this once, then resume
# advanceTip into the new epoch.
#
# Submits PROOF_LENGTH*2 = 8 headers spanning the boundary: the last 4 blocks of
# the old epoch (the 4th must equal the stored tip) + the first 4 of the new
# epoch (whose nBits must match the target the contract recomputes from the
# old epoch's timespan).
#
# Usage:  ./scripts/retarget-relay.sh
# Env:    ETH_RPC, RELAY_PK, RELAY_ADDRESS, MEMPOOL_API
#   mainnet: ETH_RPC=https://ethereum-rpc.publicnode.com \
#            RELAY_ADDRESS=0x45AA793952A710E61D456deAcA13E29d8E5c0951 \
#            RELAY_PK=0x... MEMPOOL_API=https://mempool.space/api \
#            ./scripts/retarget-relay.sh

ETH_RPC="${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
RELAY_PK="${RELAY_PK:-${SEPOLIA_PK:-}}"
RELAY_ADDRESS="${RELAY_ADDRESS:-0x3337F06CddC27220D4A10dA41719869Fe9fF6690}"
MEMPOOL_API="${MEMPOOL_API:-https://mempool.space/signet/api}"
EPOCH_LENGTH=2016
PROOF_LENGTH=4

if [[ -z "$RELAY_PK" ]]; then echo "Set RELAY_PK (or SEPOLIA_PK for testnet)"; exit 1; fi

# strip cast's "[1.23e4]" annotation
TIP=$(cast call "$RELAY_ADDRESS" "tipHeight()(uint256)" --rpc-url "$ETH_RPC" | awk '{print $1}')
EPOCH=$(cast call "$RELAY_ADDRESS" "currentEpoch()(uint256)" --rpc-url "$ETH_RPC" | awk '{print $1}')
BOUNDARY=$(( (EPOCH + 1) * EPOCH_LENGTH - 1 ))   # last block of the current epoch
echo "Relay tip: $TIP   currentEpoch: $EPOCH   boundary (last old-epoch block): $BOUNDARY"

if [[ "$TIP" -ne "$BOUNDARY" ]]; then
  echo "Relay tip is not at the epoch boundary."
  if [[ "$TIP" -lt "$BOUNDARY" ]]; then
    echo "advanceTip to $BOUNDARY first (advance-relay.sh stops there automatically), then re-run."
  else
    echo "Tip is already past $BOUNDARY — epoch $EPOCH was retargeted already (nothing to do)."
  fi
  exit 1
fi

FIRST=$(( BOUNDARY - PROOF_LENGTH + 1 ))   # 4 old-epoch blocks ending at the boundary
LAST=$(( BOUNDARY + PROOF_LENGTH ))        # + 4 new-epoch blocks
BTC_TIP=$(curl -s "$MEMPOOL_API/blocks/tip/height")
if [[ "$LAST" -gt "$BTC_TIP" ]]; then
  echo "Need Bitcoin tip >= $LAST (the first $PROOF_LENGTH new-epoch blocks); current tip $BTC_TIP. Wait for the new epoch to extend, then re-run."
  exit 1
fi

echo "Fetching boundary headers $FIRST..$LAST ($(( LAST - FIRST + 1 )) total)..."
HEADERS=""
for ((h = FIRST; h <= LAST; h++)); do
  HASH=$(curl -s "$MEMPOOL_API/block-height/$h")
  HDR=$(curl -s "$MEMPOOL_API/block/$HASH/header")
  HEADERS="${HEADERS}${HDR}"
  marker=""; [[ "$h" -le "$BOUNDARY" ]] && marker="(old epoch $EPOCH)" || marker="(new epoch $((EPOCH+1)))"
  echo "  Block $h: $HASH $marker"
done

echo ""
echo "Submitting retarget (8 headers) to relay..."
cast send "$RELAY_ADDRESS" "retarget(bytes)" "0x${HEADERS}" \
  --rpc-url "$ETH_RPC" \
  --private-key "$RELAY_PK" \
  --gas-limit 2000000 2>&1 | grep "status\|transactionHash" | head -2

echo ""
NEW_EPOCH=$(cast call "$RELAY_ADDRESS" "currentEpoch()(uint256)" --rpc-url "$ETH_RPC" | awk '{print $1}')
if [[ "$NEW_EPOCH" -eq "$(( EPOCH + 1 ))" ]]; then
  echo "Retarget OK — currentEpoch advanced $EPOCH -> $NEW_EPOCH. Resume advanceTip into the new epoch."
else
  echo "Retarget did NOT advance the epoch (still $NEW_EPOCH) — check the tx status above."
fi
