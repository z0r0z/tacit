#!/bin/bash
set -euo pipefail

# One-time setup for vast.ai prover instance.
# Run this via SSH after provisioning the instance.
#
# Usage:
#   ssh -p <port> root@<host> 'bash -s' < scripts/vastai-setup.sh

echo "=== vast.ai SP1 Prover Setup ==="

# Disk sanity — SP1's host build + Groth16 artifacts (+ the moongate image for
# cuda) need room; 32G default instances run out mid-build. Resize to ~100G.
avail=$(df -BG / | awk 'NR==2 {gsub(/G/,"",$4); print $4+0}' 2>/dev/null || echo 999)
if [[ "${avail:-999}" -lt 50 ]]; then
  echo "WARNING: ~${avail}G free on / — likely too small. Resize the instance disk to ~100G before building."
fi

# Rust
if ! command -v cargo &>/dev/null; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
echo "Rust: $(cargo --version)"

# SP1 — pinned to v6.2.2 (matches sp1-sdk/sp1-zkvm 6.2.2 in the lockfiles). With
# the committed Cargo.lock files, this builds the identical guest ELF, so the
# program verification key matches the on-chain verifier. Override with SP1_VERSION.
SP1_VERSION="${SP1_VERSION:-v6.2.2}"
if ! command -v cargo-prove &>/dev/null; then
  echo "Installing SP1 ${SP1_VERSION}..."
  curl -L https://sp1up.succinct.xyz | bash
  source "$HOME/.bashrc" 2>/dev/null || true
  export PATH="$HOME/.sp1/bin:$PATH"
  sp1up --version "${SP1_VERSION}"
fi
echo "SP1: $(~/.sp1/bin/cargo-prove prove --version 2>/dev/null || echo 'installed')"

# Foundry (for cast/relay submission)
if ! command -v cast &>/dev/null; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  source "$HOME/.bashrc" 2>/dev/null || true
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
fi
echo "Cast: $(cast --version 2>/dev/null | head -1)"

# Optional CUDA prover prerequisites (SETUP_CUDA=1). SP1's cuda prover runs a GPU
# Docker container, so the box needs Docker + the NVIDIA Container Toolkit and must
# permit nested Docker (rent with Docker enabled). Without it, SP1_PROVER=cpu proves
# on this box with no Docker at all — slower, but zero setup.
if [[ "${SETUP_CUDA:-0}" == "1" ]]; then
  echo "Setting up CUDA prover prerequisites..."
  export DEBIAN_FRONTEND=noninteractive
  command -v docker &>/dev/null || curl -fsSL https://get.docker.com | sh
  if ! command -v nvidia-ctk &>/dev/null; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit
  fi
  nvidia-ctk runtime configure --runtime=docker || true
  service docker restart 2>/dev/null || (dockerd >/tmp/dockerd.log 2>&1 & sleep 4)
  echo "Verifying GPU is visible inside Docker..."
  if docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
    echo "  GPU-in-Docker OK — SP1_PROVER=cuda will work."
  else
    echo "  WARNING: GPU-in-Docker failed; this instance likely blocks nested Docker."
    echo "  Use SP1_PROVER=cpu here, or re-rent with Docker enabled."
  fi
fi

# Clone repo
if [[ ! -d /workspace/tacit ]]; then
  echo "Cloning tacit..."
  cd /workspace
  git clone https://github.com/z0r0z/tacit
else
  echo "Updating tacit..."
  cd /workspace/tacit
  git pull
fi

# Build SP1 guest
echo "Building SP1 guest program..."
cd /workspace/tacit/contracts/sp1/program
~/.sp1/bin/cargo-prove prove build

# Build host
echo "Building SP1 host..."
cd /workspace/tacit/contracts/sp1/script
cargo build --release

# Create state dir
mkdir -p /workspace/prover-state

echo ""
echo "=== Setup complete ==="
echo ""
echo "To start the prover (SP1_PROVER=cuda needs the SETUP_CUDA=1 step above; else cpu):"
echo "  ETH_PK=0x.. SP1_PROVER=cpu <deployment env> /workspace/tacit/scripts/sp1-prover-loop.sh"
echo ""
echo "For background operation:"
echo "  ETH_PK=0x.. SP1_PROVER=cpu <deployment env> nohup /workspace/tacit/scripts/sp1-prover-loop.sh > /workspace/prover.log 2>&1 &"
echo ""
echo "To monitor:"
echo "  tail -f /workspace/prover.log"
