#!/usr/bin/env bash
# One-time setup for an eth-reflection (Mode B reverse reflection) build/prover box on vast.ai.
# Installs Rust + the SP1 toolchain (cargo-prove) + build deps and clones sp1-helios. Run via:
#   ssh -p <port> root@<host> 'bash -s' < scripts/eth-reflection-box-setup.sh
# After this: sync cxfer-core + the guest, wire into sp1-helios's workspace, `cargo prove build`.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== apt deps ==="
apt-get update -qq
apt-get install -y -qq git curl build-essential pkg-config libssl-dev ca-certificates protobuf-compiler >/dev/null

echo "=== rust ==="
if ! [ -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable >/dev/null
fi
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$PATH"

echo "=== sp1 toolchain (cargo-prove) ==="
if ! [ -x "$HOME/.sp1/bin/cargo-prove" ]; then
  curl -L https://sp1.succinct.xyz | bash
  "$HOME/.sp1/bin/sp1up"
fi

echo "=== sp1-helios (audited LC + storage-proof base) ==="
cd /root
[ -d sp1-helios ] || git clone --depth 1 https://github.com/succinctlabs/sp1-helios

echo "=== versions ==="
cargo --version
"$HOME/.sp1/bin/cargo-prove" prove --version
echo "SETUP_DONE"
