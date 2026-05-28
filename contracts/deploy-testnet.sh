#!/bin/bash
set -euo pipefail

# tETH Bridge — Sepolia + signet testnet deploy.
#
# Deploys DeployTestnet.s.sol: a single multi-denomination SP1PoolRootVerifier +
# TacitBridgeMixer, using the relaxed TestnetLightRelay (accepts signet headers).
#
#   MOCK mode (default): MockSP1Verifier / MockBurnVerifier accept proofs blindly —
#     for exercising the dapp deposit/mint flow without running the SP1 prover.
#   REAL mode: set SP1_VERIFIER + SP1_PROGRAM_VKEY + GROTH16_VK_HASH to deploy
#     against the real Succinct SP1 gateway with a real on-chain Groth16 burn
#     verifier — the full mainnet proving path, rehearsed on signet.
#
# (Deploy.s.sol + deploy-sepolia.sh is the mainnet variant: real BitcoinLightRelay
#  with full PoW validation instead of the relaxed testnet relay.)
#
# Required env:
#   DEPLOYER_PRIVATE_KEY  hex, 0x-prefixed, Sepolia-funded
# Optional env:
#   SEPOLIA_RPC           default: https://ethereum-sepolia-rpc.publicnode.com
#   TETH_ASSET_ID         default: signet tETH asset_id (d903de2d…)
#   BTC_* / BTC_TIP_*     relay genesis anchor (defaults: known-good signet 306094)
#   REAL mode:
#     SP1_VERIFIER        Succinct SP1 gateway address (match sp1-sdk 6.x)
#     SP1_PROGRAM_VKEY    cargo prove vkey --elf <guest ELF>
#     GROTH16_VK_HASH     cargo run --bin teth-prover -- --keys
#     BURN_VERIFIER       optional; defaults to a freshly-deployed Groth16Verifier
#
# The relay genesis defaults anchor to an older signet block. Deposits never touch
# the relay, so they work regardless; the attestor re-anchors/extends headers for
# the withdraw path. Override BTC_TIP_* to anchor at a fresher block.

cd "$(dirname "$0")"

# Convenience: pick up a local deployer key if present (gitignored).
if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ] && [ -f .deployer.env ]; then
  set -a; . ./.deployer.env; set +a
fi

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY (hex, 0x-prefixed, Sepolia-funded)}"
: "${SEPOLIA_RPC:=https://ethereum-sepolia-rpc.publicnode.com}"

# Canonical PoseidonT3 (poseidon-solidity deterministic deploy, already live on
# Sepolia). The mixer links to it as an external library — forge must NOT
# auto-deploy a fresh copy, which exceeds the EIP-170 24576-byte limit and reverts.
: "${POSEIDON_T3:=0x3333333c0a88f9be4fd23ed0536f9b6c427e3b93}"

export TETH_ASSET_ID="${TETH_ASSET_ID:-0xd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b}"
export BTC_GENESIS_EPOCH_START="${BTC_GENESIS_EPOCH_START:-304416}"
export BTC_GENESIS_TARGET="${BTC_GENESIS_TARGET:-567861154474712223338616632446767823243784673126349960471809951268864}"
export BTC_GENESIS_TIMESTAMP="${BTC_GENESIS_TIMESTAMP:-1778816519}"
export BTC_TIP_HASH="${BTC_TIP_HASH:-0x9adb35bb0996d74cf63498f0b60297ee85e44b18f0347e831f38710515000000}"
export BTC_TIP_HEIGHT="${BTC_TIP_HEIGHT:-306094}"
export BTC_TIP_WORK="${BTC_TIP_WORK:-62415369196664}"
export DEPLOYER_PRIVATE_KEY

if [ -n "${SP1_VERIFIER:-}" ]; then MODE="REAL (SP1 gateway ${SP1_VERIFIER})"; else MODE="MOCK (proofs accepted blindly)"; fi
echo "=== tETH Bridge — Sepolia + signet testnet deploy ==="
echo "  Mode:       ${MODE}"
echo "  RPC:        ${SEPOLIA_RPC}"
echo "  asset_id:   ${TETH_ASSET_ID}"
echo "  relay tip:  ${BTC_TIP_HASH} @ ${BTC_TIP_HEIGHT}"
echo ""

forge script script/DeployTestnet.s.sol:DeployTestnet \
  --rpc-url "${SEPOLIA_RPC}" \
  --libraries "src/lib/PoseidonT3.sol:PoseidonT3:${POSEIDON_T3}" \
  --broadcast \
  -vvv

echo ""
echo "=== Done. Next: wire the dapp ==="
echo "  Addresses are in broadcast/DeployTestnet.s.sol/11155111/run-latest.json"
echo "  Update dapp/tacit.js TETH_DEPLOYMENTS.signet { address, deployBlock }"
echo "  and tests/bridge-sepolia-signet-e2e.mjs { MIXER_ADDRESS, DEPLOY_BLOCK }."
