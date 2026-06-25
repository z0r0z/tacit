#!/usr/bin/env bash
# One-command Tacit V1 suite deploy to Sepolia (+ optional signet reflection relay).
#
# Deploys + WIRES the whole suite via script/DeployV1Suite.s.sol: CanonicalAssetFactory, ChainlinkEthBtc-
# Adapter + CollateralEngine, ConfidentialPool (ctor pins cBTC.tac + cUSD.tac + cETH), engine.setPool +
# ownership handoff, ConfidentialRouter, TacitRelayer, BtcCallExecutor, a testnet 21M TAC etch, the five
# TAC-centric core pools, and a cTAC farm per pool. Writes deployments/<chainid>.json — feed it to
# tools/sync-deployment-config.mjs to wire the dapp + worker. This is the rehearsal that becomes the
# mainnet template (deploy-v1-suite-mainnet.sh).
#
# Required:
#   DEPLOYER_PRIVATE_KEY   Sepolia-funded hex key
#   SP1_VERIFIER           the immutable SP1VerifierGroth16 LEAF on Sepolia (never the upgradeable gateway)
# Common knobs (sensible defaults):
#   SEPOLIA_RPC            default https://ethereum-sepolia-rpc.publicnode.com
#   TETH_BITCOIN_ID        cETH cross-chain link (default the signet tETH id) — 0 to disable cETH
#   REFLECTION=1           also deploy the signet relay + enable cBTC/cross-chain (needs GENESIS_REFLECTION_ANCHOR)
#   GENESIS_REFLECTION_ANCHOR   near-tip matured signet block hash (required when REFLECTION=1)
#   ENGINE_ADMIN / FARM_GOV / TAC_RECIPIENT   default the Sepolia TEST_BOT_ADMIN
#   ALLOW_DIRTY=1          skip the clean-tree guard (local iteration only)
set -euo pipefail
cd "$(dirname "$0")"

: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY (Sepolia-funded)}"
: "${SP1_VERIFIER:?set SP1_VERIFIER (the immutable Sepolia SP1VerifierGroth16 leaf)}"
SEPOLIA_RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
TETH_BITCOIN_ID="${TETH_BITCOIN_ID:-0xd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b}"
REFLECTION="${REFLECTION:-0}"

# ── preflight ──────────────────────────────────────────────────────────────
if [ "${ALLOW_DIRTY:-0}" != "1" ] && [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy from a dirty tree (set ALLOW_DIRTY=1 for local iteration)"; exit 1
fi
echo "== verifying guest vkey pin =="
( cd sp1/confidential && ./verify-vkey-pin.sh )

CHAINID="$(cast chain-id --rpc-url "$SEPOLIA_RPC")"
[ "$CHAINID" = "11155111" ] || { echo "RPC is chainid $CHAINID, expected Sepolia 11155111"; exit 1; }

export SP1_VERIFIER TETH_BITCOIN_ID
export DEPLOY_TESTNET_TAC="${DEPLOY_TESTNET_TAC:-true}"
PROGRAM_VKEY="$(jq -r .program_vkey sp1/confidential/elf-vkey-pin.json)"; export PROGRAM_VKEY

# ── optional: signet reflection relay (cBTC + cross-chain) ───────────────────
if [ "$REFLECTION" = "1" ]; then
  : "${GENESIS_REFLECTION_ANCHOR:?REFLECTION=1 needs GENESIS_REFLECTION_ANCHOR (near-tip matured signet block hash)}"
  echo "== deploying signet reflection relay =="
  forge script script/DeployTestnetRelay.s.sol:DeployTestnetRelay \
    --rpc-url "$SEPOLIA_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
  HEADER_RELAY="$(jq -r '.transactions[] | select(.contractName=="TestnetLightRelay") | .contractAddress' \
    "broadcast/DeployTestnetRelay.s.sol/$CHAINID/run-latest.json" | head -1)"
  [ -n "$HEADER_RELAY" ] && [ "$HEADER_RELAY" != "null" ] || { echo "failed to capture relay address"; exit 1; }
  export HEADER_RELAY GENESIS_REFLECTION_ANCHOR
  export BITCOIN_RELAY_VKEY="$(jq -r .bitcoin_relay_vkey sp1/confidential/elf-vkey-pin.json)"
  export ACK_REFLECTION_ANCHORED=1 DEPLOY_ENGINE="${DEPLOY_ENGINE:-true}"
  echo "relay: $HEADER_RELAY"
else
  echo "REFLECTION=0 — Ethereum-only bring-up (cBTC mint dormant; set REFLECTION=1 for cBTC/cross-chain)"
  export DEPLOY_ENGINE="${DEPLOY_ENGINE:-true}"
fi

# ── the suite ────────────────────────────────────────────────────────────────
echo "== deploying V1 suite =="
forge script script/DeployV1Suite.s.sol:DeployV1Suite \
  --rpc-url "$SEPOLIA_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --verify --slow

DEPLOY_BLOCK="$(jq -r .deployBlock "deployments/$CHAINID.json")"

# ── mature the relay genesis anchor (cBTC + cross-chain only) ────────────────
# DeployTestnetRelay only genesis()-es the relay; ConfidentialPool._anchorReflection requires the relay
# tip walked back REFLECTION_CONFIRMATIONS to sit at/after GENESIS_REFLECTION_ANCHOR, else every
# attestBitcoinStateProven reverts UnanchoredReflection (the whole cross-chain lane freezes). So advance
# the relay tip until the anchor is matured before declaring success. advanceTip is permissionless; reuse
# the deployer key here, and run the standing advancer loop in production (playbook §3, RUNBOOK §2).
if [ "$REFLECTION" = "1" ]; then
  REFLECTION_CONFIRMATIONS="${REFLECTION_CONFIRMATIONS:-6}"
  MEMPOOL_API="${MEMPOOL_API:-https://mempool.space/signet/api}"
  ANCHOR_HEIGHT="$(cast call "$HEADER_RELAY" "blockHeight(bytes32)(uint256)" "$GENESIS_REFLECTION_ANCHOR" --rpc-url "$SEPOLIA_RPC" | awk '{print $1}')"
  echo "== maturing relay anchor (height $ANCHOR_HEIGHT + $REFLECTION_CONFIRMATIONS confirmations) =="
  for _ in $(seq 1 60); do
    TIP_HEIGHT="$(cast call "$HEADER_RELAY" "tipHeight()(uint256)" --rpc-url "$SEPOLIA_RPC" | awk '{print $1}')"
    if [ "$TIP_HEIGHT" -ge "$((ANCHOR_HEIGHT + REFLECTION_CONFIRMATIONS))" ]; then
      echo "relay tip $TIP_HEIGHT matured anchor $ANCHOR_HEIGHT (+$REFLECTION_CONFIRMATIONS)"; break
    fi
    echo "relay tip $TIP_HEIGHT < anchor+confirmations $((ANCHOR_HEIGHT + REFLECTION_CONFIRMATIONS)) — advancing"
    ETH_RPC="$SEPOLIA_RPC" RELAY_PK="$DEPLOYER_PRIVATE_KEY" RELAY_ADDRESS="$HEADER_RELAY" MEMPOOL_API="$MEMPOOL_API" \
      ../scripts/advance-relay.sh --count 20 || { echo "advance-relay failed (epoch boundary? run scripts/retarget-relay.sh)"; break; }
  done
  TIP_HEIGHT="$(cast call "$HEADER_RELAY" "tipHeight()(uint256)" --rpc-url "$SEPOLIA_RPC" | awk '{print $1}')"
  [ "$TIP_HEIGHT" -ge "$((ANCHOR_HEIGHT + REFLECTION_CONFIRMATIONS))" ] \
    || { echo "relay tip $TIP_HEIGHT still below anchor+confirmations — attests will revert UnanchoredReflection"; exit 1; }
fi

# ── wire the dapp + worker config off the manifest ───────────────────────────
echo "== syncing deployment config (block $DEPLOY_BLOCK) =="
node ../tools/sync-deployment-config.mjs "deployments/$CHAINID.json" --network signet --deploy-block "$DEPLOY_BLOCK" --write

echo
echo "== done. manifest: deployments/$CHAINID.json =="
if [ "$REFLECTION" = "1" ]; then
  echo "RELAY ADVANCER: keep the relay tip live — loop scripts/advance-relay.sh (RELAY_ADDRESS=$HEADER_RELAY),"
  echo "  retargeting at each 2016-block boundary (scripts/retarget-relay.sh). This is SEPARATE from the"
  echo "  attest loop (ops/scripts/reflection-relay-loop.sh), which proves/submits attests but never advances headers."
fi
echo "NEXT: run tests/v1-day1-bootstrap-signet.mjs to seed liquidity + fund farms (box-proven)"
