#!/bin/bash
set -euo pipefail

# tETH Bridge: generate SP1 proof and submit to Sepolia
#
# Usage:
#   ./scripts/prove-and-submit.sh --start <height> --blocks <n>
#
# Requirements:
#   - VastAI instance running with SSH access
#   - VASTAI_HOST, VASTAI_PORT env vars (or edit defaults below)
#   - Sepolia deployer key for proof submission

# ──── Config ────
VASTAI_HOST="${VASTAI_HOST:-ssh8.vast.ai}"
VASTAI_PORT="${VASTAI_PORT:-22595}"
VASTAI_USER="${VASTAI_USER:-root}"

SEPOLIA_RPC="https://ethereum-sepolia-rpc.publicnode.com"
SEPOLIA_PK="${SEPOLIA_PK:-0x950b04c07979d8ff19eb45fd1c14d4834a9b0b912a9744cb2b37593380b7b81b}"
MIXER="0x80c53DcFCFA816Ae70f0D1FD7DE00a70db7fc1C5"

ASSET_ID="0xd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b"

# ──── Parse args ────
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

if [[ -z "$START_HEIGHT" ]]; then
  echo "Usage: $0 --start <height> --blocks <n> [--execute-only]"
  exit 1
fi

echo "=== tETH SP1 Prover ==="
echo "  Blocks: ${START_HEIGHT} to $((START_HEIGHT + NUM_BLOCKS - 1))"
echo "  VastAI: ${VASTAI_USER}@${VASTAI_HOST}:${VASTAI_PORT}"
echo ""

# ──── Step 1: Run prover on VastAI ────
echo "Step 1: Generating SP1 proof on VastAI..."

ssh -p "$VASTAI_PORT" "${VASTAI_USER}@${VASTAI_HOST}" bash -s <<EOF
set -e
cd /workspace/tacit/contracts/sp1/script 2>/dev/null || {
  echo "Setting up environment..."
  if ! command -v cargo &>/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source ~/.cargo/env
  fi
  if ! command -v cargo-prove &>/dev/null; then
    curl -L https://sp1up.succinct.xyz | bash
    source ~/.bashrc
    sp1up
  fi
  if [[ ! -d /workspace/tacit ]]; then
    cd /workspace && git clone https://github.com/z0r0z/tacit
  else
    cd /workspace/tacit && git pull
  fi
  cd /workspace/tacit/contracts/sp1/program
  ~/.sp1/bin/cargo-prove prove build
  cd /workspace/tacit/contracts/sp1/script
}
source ~/.cargo/env 2>/dev/null || true
SP1_PROVER=cpu cargo run --release -- --start-height ${START_HEIGHT} --num-blocks ${NUM_BLOCKS} ${EXECUTE_ONLY}
EOF

if [[ -n "$EXECUTE_ONLY" ]]; then
  echo ""
  echo "Execute-only mode — no proof to submit."
  exit 0
fi

# ──── Step 2: Download proof ────
echo ""
echo "Step 2: Downloading proof..."
scp -P "$VASTAI_PORT" "${VASTAI_USER}@${VASTAI_HOST}:/workspace/tacit/contracts/sp1/script/proof.bin" ./proof.bin
echo "  Downloaded: proof.bin ($(wc -c < proof.bin) bytes)"

# ──── Step 3: Submit to Sepolia ────
echo ""
echo "Step 3: Submitting proof to Sepolia..."
echo "  (TODO: encode public values + call proveStateTransition)"
echo "  Proof file: ./proof.bin"
echo "  Mixer: ${MIXER}"
echo ""
echo "=== Done ==="
