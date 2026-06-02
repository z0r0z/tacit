#!/bin/bash
set -euo pipefail

# tETH Bridge MAINNET deployment wrapper (Ethereum mainnet + Bitcoin mainnet).
#
# Calls script/Deploy.s.sol (fail-closed — no mock verifier fallback). Mirrors
# the safety preflight in deploy-sepolia.sh:
#   - Refuses a dirty bridge source tree (committed source is the source of
#     record CI validates; a dirty tree would compile bytecode unreviewed).
#   - Verifies the committed SP1 guest ELF matches its pinned vkey.
# Plus mainnet-specific guards:
#   - Asserts chainid is 1 (so this script can't accidentally deploy to a
#     non-mainnet RPC even if MAINNET_RPC is misconfigured).
#   - All sensitive params (SP1 verifier gateway, ceremony Groth16Verifier,
#     PROGRAM_VKEY, GROTH16_VK_HASH) must be supplied via env — no defaults —
#     so the deployer explicitly chooses each address rather than inheriting
#     a stale constant.
#
# Required env:
#   DEPLOYER_PRIVATE_KEY  hex, mainnet-funded account (with 0x)
#   MAINNET_RPC           Ethereum mainnet RPC URL
#   TETH_ASSET_ID         bytes32 (with 0x) — production tETH asset id
#   BURN_VERIFIER         address of the deployed ceremony-key Groth16Verifier
#   SP1_VERIFIER          address of Succinct's mainnet SP1 Groth16 gateway
#   SP1_PROGRAM_VKEY      bytes32 vkey from the canonical Docker-built ELF
#                         (must equal program_vkey in contracts/sp1/elf-vkey-pin.json)
#   GROTH16_VK_HASH       bytes32 (sha256 of the ceremony VK bytes)
#   BTC_TIP_WORK          uint256 cumulative chainwork at the chosen anchor;
#                         fetch via `bitcoin-cli getblockheader <hash> | jq -r .chainwork`
#                         and pass as decimal. A small baseline opens the door
#                         to a malicious heavier-fork submission to advanceTip;
#                         use the real on-chain chainwork.
#
# The script fetches a recent canonical BTC mainnet anchor block (tip - 6 for
# safety) and derives BTC_TIP_HASH (LITTLE-ENDIAN — header `prev` is parsed
# raw-sha256d-bytes-as-bytes32, byte-order matches Bitcoin Core memory order),
# BTC_TIP_HEIGHT, BTC_GENESIS_TIMESTAMP/TARGET/EPOCH_START.

echo "=== tETH Bridge — MAINNET Deployment ==="

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY (hex, with 0x)}"
: "${MAINNET_RPC:?Set MAINNET_RPC (Ethereum mainnet RPC URL)}"
: "${TETH_ASSET_ID:?Set TETH_ASSET_ID (bytes32, with 0x)}"
: "${BURN_VERIFIER:?Set BURN_VERIFIER (deployed ceremony-key Groth16Verifier)}"
: "${SP1_VERIFIER:?Set SP1_VERIFIER (Succinct mainnet SP1 Groth16 gateway)}"
: "${SP1_PROGRAM_VKEY:?Set SP1_PROGRAM_VKEY (bytes32 from canonical Docker ELF)}"
: "${GROTH16_VK_HASH:?Set GROTH16_VK_HASH (sha256 of ceremony VK bytes)}"
# BTC_TIP_WORK (decimal cumulative chainwork at the anchor) is derived below
# from a keyless Bitcoin RPC for the exact anchor this script picks, unless
# supplied explicitly — keeps it from drifting from the anchor block.
BTC_TIP_WORK="${BTC_TIP_WORK:-}"

# Canonical PoseidonT3 (poseidon-solidity deterministic deploy, also live on
# mainnet). TacitBridgeMixer links it as an external library — the artifact
# carries unresolved linkRefs (29 KB, exceeds the 24.5 KB EIP-170 cap so it
# cannot be inlined). Without --libraries forge would auto-deploy a copy,
# which (a) would itself exceed the contract size cap (broadcast reverts) and
# (b) would silently produce a Poseidon that disagrees with the dapp + guest
# hashing — fail-closed via the on-chain preflight below either way.
: "${POSEIDON_T3:=0x3333333c0a88f9be4fd23ed0536f9b6c427e3b93}"
echo "  PoseidonT3: ${POSEIDON_T3}"

# Preflight: ensure the canonical PoseidonT3 is actually deployed on mainnet
# at the expected address. A wrong/missing address makes mixer deposit() and
# withdrawFromBurn() revert on every call (immutable mixer, no recovery).
POSEIDON_CODE_LEN=$(cast code ${POSEIDON_T3} --rpc-url "${MAINNET_RPC}" 2>/dev/null | wc -c)
if [ "${POSEIDON_CODE_LEN}" -lt 100 ]; then
  echo "REFUSING TO DEPLOY: PoseidonT3 not deployed at ${POSEIDON_T3} on this RPC (got ${POSEIDON_CODE_LEN} hex chars)."
  echo "Deploy the canonical poseidon-solidity PoseidonT3 first, then re-run."
  exit 1
fi
echo "  PoseidonT3 has ${POSEIDON_CODE_LEN} bytes of code ✓"

# Belt-and-suspenders: refuse to broadcast against a non-mainnet RPC even if
# the user's MAINNET_RPC env points elsewhere.
CHAIN_ID=$(curl -sf -X POST "$MAINNET_RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))")
if [ "$CHAIN_ID" != "1" ]; then
  echo "REFUSING TO DEPLOY: MAINNET_RPC returned chainid $CHAIN_ID (expected 1). Check the URL."
  exit 1
fi
echo "  chainid: 1 ✓"

# Preflight: dirty bridge source + ELF/vkey pin.
PREFLIGHT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${ALLOW_DIRTY_DEPLOY:-}" ]; then
  DIRTY=$(git -C "$PREFLIGHT_DIR" status --porcelain -- \
    src/TacitBridgeMixer.sol src/SP1PoolRootVerifier.sol src/Groth16Verifier.sol \
    sp1/program/src sp1/tree/src 2>/dev/null || true)
  if [ -n "$DIRTY" ]; then
    echo "REFUSING TO DEPLOY: bridge source tree is dirty:"; echo "$DIRTY"
    echo "Commit the changes (let CI validate them), or set ALLOW_DIRTY_DEPLOY=1 to override."
    exit 1
  fi
fi
bash "$PREFLIGHT_DIR/sp1/verify-vkey-pin.sh"

# Cross-check: SP1_PROGRAM_VKEY env equals the pinned canonical vkey.
# (tr-lowercase, not ${var,,}, so this runs under macOS's bash 3.2.)
PINNED_VKEY=$(python3 -c "import json; print(json.load(open('$PREFLIGHT_DIR/sp1/elf-vkey-pin.json'))['program_vkey'])")
_VKEY_LC=$(printf '%s' "$SP1_PROGRAM_VKEY" | tr '[:upper:]' '[:lower:]')
_PIN_LC=$(printf '%s' "$PINNED_VKEY" | tr '[:upper:]' '[:lower:]')
if [ "$_VKEY_LC" != "$_PIN_LC" ]; then
  echo "REFUSING TO DEPLOY: SP1_PROGRAM_VKEY env ($SP1_PROGRAM_VKEY) != pinned ($PINNED_VKEY)."
  echo "The deployed verifier MUST use the vkey of the committed ELF or every proveStateTransition reverts."
  exit 1
fi
echo "  vkey pin: $PINNED_VKEY ✓"

# Fetch BTC mainnet anchor (tip - 6 for confirmation depth).
echo ""
echo "Step 1: Fetching BTC mainnet anchor (tip - 6)..."
BTC_TIP_HEIGHT_LIVE=$(curl -sf "https://mempool.space/api/blocks/tip/height")
ANCHOR_HEIGHT=$((BTC_TIP_HEIGHT_LIVE - 6))
ANCHOR_HASH_BE=$(curl -sf "https://mempool.space/api/block-height/$ANCHOR_HEIGHT")
ANCHOR_HASH_LE=$(python3 -c "print(bytes.fromhex('$ANCHOR_HASH_BE')[::-1].hex())")
ANCHOR_BLOCK=$(curl -sf "https://mempool.space/api/block/$ANCHOR_HASH_BE")
ANCHOR_BITS_LE=$(echo "$ANCHOR_BLOCK" | python3 -c "import sys,json; print(f'{json.load(sys.stdin)[\"bits\"]:08x}')")
ANCHOR_TIMESTAMP=$(echo "$ANCHOR_BLOCK" | python3 -c "import sys,json; print(json.load(sys.stdin)['timestamp'])")
# Cumulative chainwork at the anchor, from a keyless Bitcoin RPC, derived for
# the SAME anchor block computed above (no drift). getblockheader.chainwork is
# the canonical heaviest-chain accumulator; a too-low value would weaken the
# relay's fork choice.
if [ -z "$BTC_TIP_WORK" ]; then
  CW_HEX=$(curl -sf -X POST "https://bitcoin-rpc.publicnode.com" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"getblockheader\",\"params\":[\"$ANCHOR_HASH_BE\"]}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['chainwork'])")
  [ -n "$CW_HEX" ] || { echo "REFUSING TO DEPLOY: could not fetch chainwork for anchor $ANCHOR_HASH_BE"; exit 1; }
  BTC_TIP_WORK=$(python3 -c "print(int('$CW_HEX', 16))")
fi
# Epoch start: floor(height / 2016) * 2016
EPOCH_START=$(( ANCHOR_HEIGHT / 2016 * 2016 ))
EPOCH_HASH=$(curl -sf "https://mempool.space/api/block-height/$EPOCH_START")
EPOCH_BLOCK=$(curl -sf "https://mempool.space/api/block/$EPOCH_HASH")
EPOCH_BITS=$(echo "$EPOCH_BLOCK" | python3 -c "import sys,json; print(f'{json.load(sys.stdin)[\"bits\"]:08x}')")
EPOCH_TIMESTAMP=$(echo "$EPOCH_BLOCK" | python3 -c "import sys,json; print(json.load(sys.stdin)['timestamp'])")
# Target from epoch bits (Bitcoin compact)
EPOCH_TARGET=$(python3 -c "
bits = int('$EPOCH_BITS', 16)
exp = (bits >> 24) & 0xff
mant = bits & 0x7fffff
target = mant << (8 * (exp - 3))
print(target)
")

echo "  Live tip: $BTC_TIP_HEIGHT_LIVE"
echo "  Anchor (tip-6): height=$ANCHOR_HEIGHT ts=$ANCHOR_TIMESTAMP bits=0x$ANCHOR_BITS_LE"
echo "  Anchor hash BE (display): $ANCHOR_HASH_BE"
echo "  Anchor hash LE (BTC_TIP_HASH): 0x$ANCHOR_HASH_LE"
echo "  Epoch start: $EPOCH_START ts=$EPOCH_TIMESTAMP bits=0x$EPOCH_BITS target=$EPOCH_TARGET"
echo "  BTC_TIP_WORK (supplied): $BTC_TIP_WORK"

# Sanity: the anchor bits should equal the epoch bits (same difficulty epoch).
if [ "$ANCHOR_BITS_LE" != "$EPOCH_BITS" ]; then
  echo "REFUSING TO DEPLOY: anchor bits ($ANCHOR_BITS_LE) != epoch bits ($EPOCH_BITS) — cross-epoch anchor not supported by this wrapper; rerun in a few blocks or pass BTC_GENESIS_* explicitly."
  exit 1
fi

# Deploy
echo ""
echo "Step 2: Deploying via forge script Deploy.s.sol..."
NETWORK_TAG=0 \
BTC_GENESIS_EPOCH_START=$EPOCH_START \
BTC_GENESIS_TARGET=$EPOCH_TARGET \
BTC_GENESIS_TIMESTAMP=$EPOCH_TIMESTAMP \
BTC_TIP_HASH=0x$ANCHOR_HASH_LE \
BTC_TIP_HEIGHT=$ANCHOR_HEIGHT \
BTC_TIP_WORK=$BTC_TIP_WORK \
TETH_ASSET_ID=$TETH_ASSET_ID \
BURN_VERIFIER=$BURN_VERIFIER \
SP1_VERIFIER=$SP1_VERIFIER \
SP1_PROGRAM_VKEY=$SP1_PROGRAM_VKEY \
GROTH16_VK_HASH=$GROTH16_VK_HASH \
DEPLOYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY \
forge script script/Deploy.s.sol:DeployTacitBridge \
  --rpc-url "$MAINNET_RPC" \
  --libraries "src/lib/PoseidonT3.sol:PoseidonT3:${POSEIDON_T3}" \
  $([ "${DRY_RUN:-}" = 1 ] || echo --broadcast) \
  ${DEPLOY_GAS_PRICE:+--with-gas-price "$DEPLOY_GAS_PRICE"} \
  --gas-estimate-multiplier "${DEPLOY_GAS_MULT:-130}" \
  -vvv

echo ""
echo "=== Mainnet deployment broadcast complete ==="
echo "Addresses are in broadcast/Deploy.s.sol/1/run-latest.json"
echo "Next: pin the mainnet addresses in the dapp + memory + ops runbook."
