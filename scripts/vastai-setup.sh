#!/bin/bash
set -euo pipefail

# One-time setup for a vast.ai tETH prover instance.
# Run via SSH:  ssh -p <port> root@<host> 'bash -s' < scripts/vastai-setup.sh
#
# The guest ELF is committed (contracts/sp1/program/elf/teth-pool-prover) and
# embedded by the host at build time, so the prover does NOT rebuild the guest —
# every prover gets the identical program verification key the on-chain verifier
# expects. SP1 guest builds embed absolute paths, so rebuilding per-machine drifts
# the vkey and proofs get rejected. To regenerate/verify the guest reproducibly,
# see contracts/sp1/build-guest.sh (requires Docker).
#
# The host builds the Groth16 prover NATIVELY (sp1-sdk native-gnark feature) so the
# wrap runs without Docker — works on unprivileged hosts. That needs Go + clang at
# build time (installed below). SP1_PROVER=cpu then proves end-to-end, no Docker.

echo "=== vast.ai tETH Prover Setup ==="

# Disk sanity — the host build + the ~8G Groth16 circuit artifacts + cargo target
# need room; 32G default instances run out mid-build. Resize the disk to ~100G.
avail=$(df -BG / | awk 'NR==2 {gsub(/G/,"",$4); print $4+0}' 2>/dev/null || echo 999)
if [[ "${avail:-999}" -lt 60 ]]; then
  echo "WARNING: ~${avail}G free on / — resize the instance disk to ~100G before building."
fi

# Build prerequisites — sp1-sdk needs protoc; native-gnark needs clang/libclang
# (bindgen) + a C toolchain (CGO); the rest covers minimal base images.
export DEBIAN_FRONTEND=noninteractive
if ! command -v protoc &>/dev/null || ! command -v clang &>/dev/null; then
  echo "Installing build prerequisites..."
  apt-get update -qq && apt-get install -y -qq protobuf-compiler pkg-config libssl-dev build-essential git curl clang libclang-dev
fi
echo "protoc: $(protoc --version 2>/dev/null || echo MISSING)  clang: $(clang --version 2>/dev/null | head -1 || echo MISSING)"

# Go — native-gnark's build.rs runs `go build` (CGO) to compile the gnark prover.
GO_VERSION="${GO_VERSION:-1.23.4}"
if ! /usr/local/go/bin/go version &>/dev/null; then
  echo "Installing Go ${GO_VERSION}..."
  curl -sfLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz
fi
export PATH="$PATH:/usr/local/go/bin"
echo "Go: $(go version)"
# bindgen needs libclang at build time.
export LIBCLANG_PATH="$(llvm-config --libdir 2>/dev/null || ls -d /usr/lib/llvm-*/lib 2>/dev/null | head -1 || echo /usr/lib/x86_64-linux-gnu)"
echo "LIBCLANG_PATH: $LIBCLANG_PATH"

# Rust
if ! command -v cargo &>/dev/null && [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
source "$HOME/.cargo/env" 2>/dev/null || true
echo "Rust: $(cargo --version)"

# Foundry (cast — for proof submission + relay advance)
if ! command -v cast &>/dev/null && [[ ! -x "$HOME/.foundry/bin/cast" ]]; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  "$HOME/.foundry/bin/foundryup"
fi
export PATH="$HOME/.foundry/bin:$PATH"
echo "Cast: $(cast --version 2>/dev/null | head -1)"

# Optional CUDA prover prerequisites (SETUP_CUDA=1) to accelerate STARK proving via
# SP1_PROVER=cuda. SP1's cuda prover runs a GPU Docker container (moongate), so the
# box needs Docker + the NVIDIA Container Toolkit and must permit nested Docker (rent
# a PRIVILEGED instance). The Groth16 wrap is already native (no Docker) regardless.
# Without cuda, SP1_PROVER=cpu proves end-to-end on CPU with zero Docker — slower
# STARK proving, fine for low-volume signet. Only worth it at mainnet scale.
if [[ "${SETUP_CUDA:-0}" == "1" ]]; then
  echo "Setting up CUDA prover prerequisites..."
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

# Clone / update repo (brings the committed guest ELF)
if [[ ! -d /workspace/tacit ]]; then
  echo "Cloning tacit..."; mkdir -p /workspace; git clone https://github.com/z0r0z/tacit /workspace/tacit
else
  echo "Updating tacit..."; git -C /workspace/tacit pull --ff-only
fi

# Build the prover host — embeds the committed guest ELF (no guest rebuild).
echo "Building prover host..."
cd /workspace/tacit/contracts/sp1/script && cargo build --release

mkdir -p /workspace/prover-state
echo ""
echo "=== Setup complete ==="
echo ""
echo "Start the prover (CPU; cuda needs SETUP_CUDA=1 above):"
echo "  ETH_PK=0x.. SP1_PROVER=cpu <deployment env> /workspace/tacit/scripts/sp1-prover-loop.sh"
echo ""
echo "Background + monitor:"
echo "  ETH_PK=0x.. SP1_PROVER=cpu <deployment env> nohup /workspace/tacit/scripts/sp1-prover-loop.sh > /workspace/prover.log 2>&1 &"
echo "  tail -f /workspace/prover.log"
