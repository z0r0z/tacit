#!/bin/bash
set -euo pipefail

SEPOLIA_RPC="https://ethereum-sepolia-rpc.publicnode.com"
SEPOLIA_PK="${SEPOLIA_PK:-0x950b04c07979d8ff19eb45fd1c14d4834a9b0b912a9744cb2b37593380b7b81b}"
VERIFIER="0xecc90f99249a085ddf82322ebdb82bf9c5b2491a"
MIXER="0x4e3122970F321eD27840682af422d84Df48Fc7a7"
RELAY="0x11e39E01C909179c736DEAf4964758B7025e2d41"

BURN_CLAIM_ID="${BURN_CLAIM_ID:-e7d030a95ed440e89335d23d46c3c318bddd4cc91b252936ff3db1aa25c70891}"

echo "=== Mock SP1 State Transition ==="

# Parse state fields via python
eval "$(cast call $VERIFIER 'currentState()((bytes32,bytes32,bytes32,uint64,bytes32))' --rpc-url $SEPOLIA_RPC | python3 -c "
import sys
raw = sys.stdin.read().strip().strip('()')
parts = [p.strip() for p in raw.split(',')]
print(f'PREV_POOL_ROOT={parts[0].replace(\"0x\",\"\")!s}')
print(f'PREV_NULL_ROOT={parts[1].replace(\"0x\",\"\")!s}')
# depositAcc is parts[2] but not used as prev field
print(f'PREV_HEIGHT={int(parts[3])}')
print(f'PREV_BLOCK_HASH={parts[4].replace(\"0x\",\"\")!s}')
")"

PREV_COMMITMENT=$(cast call $VERIFIER 'currentStateCommitment()(bytes32)' --rpc-url $SEPOLIA_RPC | sed 's/^0x//')
RELAY_TIP=$(cast call $RELAY 'tip()(bytes32)' --rpc-url $SEPOLIA_RPC | sed 's/^0x//')
ROOT_ACC=$(cast call $MIXER 'getRootAccumulator(bytes32)(bytes32)' 0x0c5d21b00bbd6b38d324efe3cd640b5dc9fe6d4d210a2939963009148dd11eef --rpc-url $SEPOLIA_RPC | sed 's/^0x//')

echo "Prev height: $PREV_HEIGHT"
echo "Prev block: ${PREV_BLOCK_HASH:0:16}..."
echo "Relay tip: ${RELAY_TIP:0:16}..."
echo "Root acc: ${ROOT_ACC:0:16}..."

# Compute nullBatchHash = sha256(burnClaimId)
NULL_BATCH_HASH=$(python3 -c "import hashlib; print(hashlib.sha256(bytes.fromhex('${BURN_CLAIM_ID}')).hexdigest())")

PREV_HEIGHT_HEX=$(printf '%016x' "$PREV_HEIGHT")
ASSET_ID="d903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b"
NETWORK_TAG="01"
CHAIN_ID="0000000000aa36a7"
MIXER_ADDR="4e3122970f321ed27840682af422d84df48fc7a7"
DENOM="00000000000000000000000000000000000000000000000000038d7ea4c68000"
VK_HASH="0000000000000000000000000000000000000000000000000000000000000001"
NEW_POOL_ROOT="0000000000000000000000000000000000000000000000000000000000000042"
NEW_NULL_ROOT="0000000000000000000000000000000000000000000000000000000000000043"
NEW_HEIGHT="0000000000000001"
NEW_STATE_COMMIT="0000000000000000000000000000000000000000000000000000000000000044"

PV="${PREV_POOL_ROOT}${PREV_NULL_ROOT}${PREV_HEIGHT_HEX}${PREV_BLOCK_HASH}"
PV+="${NEW_POOL_ROOT}${NEW_NULL_ROOT}${NEW_HEIGHT}"
PV+="${ROOT_ACC}${VK_HASH}${NULL_BATCH_HASH}"
PV+="${ASSET_ID}${NETWORK_TAG}${CHAIN_ID}${MIXER_ADDR}"
PV+="${RELAY_TIP}${DENOM}"
PV+="${PREV_COMMITMENT}${NEW_STATE_COMMIT}"

PV_LEN=$((${#PV} / 2))
echo "Public values: ${PV_LEN} bytes (expect 461)"

if [ "$PV_LEN" -ne 461 ]; then
  echo "ERROR: length mismatch!"
  echo "PV hex: $PV"
  exit 1
fi

echo ""
echo "Submitting..."
cast send $VERIFIER \
  'proveStateTransition(bytes,bytes,bytes32[])' \
  "0x${PV}" \
  "0x00" \
  "[0x${BURN_CLAIM_ID}]" \
  --rpc-url $SEPOLIA_RPC \
  --private-key $SEPOLIA_PK \
  --gas-limit 500000 2>&1 | grep "status\|transactionHash" | head -2

echo ""
echo "Accepted burn:"
cast call $VERIFIER "isAcceptedBurn(bytes32)(bool)" "0x${BURN_CLAIM_ID}" --rpc-url $SEPOLIA_RPC
