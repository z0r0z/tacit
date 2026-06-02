#!/usr/bin/env bash
# One-shot prover-box setup: deps, rust, sp1, foundry, go, clone, build host.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
cd /root/work
echo "=== [1/7] apt deps ==="
apt-get update -qq
apt-get install -y -qq build-essential clang pkg-config libssl-dev protobuf-compiler curl git jq ca-certificates >/dev/null
echo "=== [2/7] rust ==="
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable >/dev/null
fi
export PATH="$HOME/.cargo/bin:$PATH"
echo "=== [3/7] sp1 (sp1up) ==="
if ! command -v cargo-prove >/dev/null && [ ! -x "$HOME/.sp1/bin/cargo-prove" ]; then
  curl -L https://sp1up.succinct.xyz | bash || true
  export PATH="$HOME/.sp1/bin:$PATH"
  sp1up --version 6.2.2 || sp1up || true
fi
export PATH="$HOME/.sp1/bin:$PATH"
echo "=== [4/7] foundry (cast) ==="
if ! command -v cast >/dev/null && [ ! -x "$HOME/.foundry/bin/cast" ]; then
  curl -L https://foundry.paradigm.xyz | bash || true
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup || true
fi
export PATH="$HOME/.foundry/bin:$PATH"
echo "=== [5/7] go 1.22.5 (native-gnark) ==="
if [ ! -x /usr/local/go/bin/go ]; then
  curl -sSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz -o /tmp/go.tgz
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz
fi
export PATH="/usr/local/go/bin:$PATH"
echo "=== [6/7] clone repo @ 9da5b4e ==="
if [ ! -d /root/work/tacit/.git ]; then
  git clone --quiet https://github.com/z0r0z/tacit.git /root/work/tacit
fi
cd /root/work/tacit
git fetch --quiet origin
git checkout --quiet 9da5b4e
echo "HEAD: $(git rev-parse --short HEAD)"
echo "=== [7/7] build host (native-gnark, CPU) ==="
cd /root/work/tacit/contracts/sp1/script
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$HOME/.foundry/bin:/usr/local/go/bin:$PATH"
cargo build --release --bin teth-prover 2>&1 | tail -5
echo "=== DONE: host built ==="
ls -la /root/work/tacit/contracts/sp1/script/target/release/teth-prover
go version; cast --version 2>/dev/null | head -1; rustc --version
