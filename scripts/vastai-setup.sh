#!/bin/bash
set -euo pipefail

# One-time setup for vast.ai prover instance.
# Run this via SSH after provisioning the instance.
#
# Usage:
#   ssh -p <port> root@<host> 'bash -s' < scripts/vastai-setup.sh

echo "=== vast.ai SP1 Prover Setup ==="

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
echo "To start the prover:"
echo "  ETH_PK=0x... /workspace/tacit/scripts/sp1-prover-loop.sh"
echo ""
echo "For background operation:"
echo "  ETH_PK=0x... nohup /workspace/tacit/scripts/sp1-prover-loop.sh > /workspace/prover.log 2>&1 &"
echo ""
echo "To monitor:"
echo "  tail -f /workspace/prover.log"
