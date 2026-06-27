#!/usr/bin/env bash
# Tacit V1 suite — MAINNET deploy TEMPLATE (fail-closed). Same orchestrator as the testnet rehearsal
# (script/DeployV1Suite.s.sol); the only difference is the env: real verifier (codehash-pinned), the ops
# multisig as engine admin, the REAL bridged TAC (no testnet etch), mainnet Chainlink feeds (auto by
# chainid), and a mainnet BitcoinLightRelay anchored near the tip. Mirrors deploy-mainnet.sh discipline:
# no defaults for fund-critical values, explicit acks, DRY_RUN to rehearse the guards.
#
# Required:
#   DEPLOYER_PRIVATE_KEY        mainnet-funded hex key
#   MAINNET_RPC                 chainid must be 1
#   SP1_VERIFIER                immutable SP1VerifierGroth16 leaf (mainnet)
#   EXPECTED_VERIFIER_CODEHASH  the published leaf's extcodehash (the pool pins it forever)
#   TAC_UNDERLYING              the REAL public bridged-TAC ERC20 (NOT a testnet etch)
#   HEADER_RELAY                mainnet BitcoinLightRelay (near-tip anchored)
#   GENESIS_REFLECTION_ANCHOR   near-tip matured Bitcoin block hash
#   TETH_BITCOIN_ID             canonical Bitcoin-side tETH asset id; pins cETH's immutable cross-chain link
#   ENGINE_ADMIN                the ops multisig (the script also enforces == MAINNET_OPS_MULTISIG)
# Optional:
#   DRY_RUN=1                   simulate (no broadcast) to confirm the fail-closed guards fire
set -euo pipefail
cd "$(dirname "$0")"

: "${DEPLOYER_PRIVATE_KEY:?}"; : "${MAINNET_RPC:?}"; : "${SP1_VERIFIER:?}"
: "${EXPECTED_VERIFIER_CODEHASH:?set EXPECTED_VERIFIER_CODEHASH (the immutable leaf codehash)}"
: "${TAC_UNDERLYING:?set TAC_UNDERLYING to the REAL bridged TAC ERC20 (mainnet uses no testnet etch)}"
: "${HEADER_RELAY:?}"; : "${GENESIS_REFLECTION_ANCHOR:?}"; : "${TETH_BITCOIN_ID:?set TETH_BITCOIN_ID to the canonical tETH Bitcoin id}"
: "${ENGINE_ADMIN:?}"

if [ -n "$(git status --porcelain)" ]; then echo "refusing to deploy from a dirty tree"; exit 1; fi
echo "== verifying guest vkey pin =="
( cd sp1/confidential && VERIFY_VKEY_STRICT=1 ./verify-vkey-pin.sh )

CHAINID="$(cast chain-id --rpc-url "$MAINNET_RPC")"
[ "$CHAINID" = "1" ] || { echo "RPC is chainid $CHAINID, expected mainnet 1"; exit 1; }

export SP1_VERIFIER EXPECTED_VERIFIER_CODEHASH TAC_UNDERLYING HEADER_RELAY GENESIS_REFLECTION_ANCHOR TETH_BITCOIN_ID ENGINE_ADMIN
export DEPLOY_ENGINE=true DEPLOY_TESTNET_TAC=false ACK_REFLECTION_ANCHORED=1
export PROGRAM_VKEY="$(jq -r .program_vkey sp1/confidential/elf-vkey-pin.json)"
export BITCOIN_RELAY_VKEY="$(jq -r .bitcoin_relay_vkey sp1/confidential/elf-vkey-pin.json)"

BROADCAST="--broadcast --verify --slow"
[ "${DRY_RUN:-0}" = "1" ] && BROADCAST="" && echo "== DRY_RUN: simulating, no broadcast =="

echo "== deploying V1 suite (mainnet) =="
forge script script/DeployV1Suite.s.sol:DeployV1Suite \
  --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" $BROADCAST

echo "== done. manifest: deployments/1.json — DO NOT flip dapp/worker gates until the readiness gate is green =="
