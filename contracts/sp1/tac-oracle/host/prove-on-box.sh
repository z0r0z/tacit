#!/bin/bash
set -euo pipefail

# A TacProvenOracle proof on a CUDA box (Ubuntu, a 24 GB GPU): builds tac-oracle-host with the GPU prover and the SP1
# stack eth-reflection's prover host runs (6.2.4), reads a fresh input from mainnet and proves it with the given ELF.
#
#   prove-on-box.sh <tac-oracle dir: core/ host/ and the ELF> <ELF> [out dir]
#
# Writes <out>/proof.json ({ vkey, publicValues, proof, proofBytes }) and <out>/times.txt. The SDK fetches its GPU server
# and the Groth16 artifacts (about 9 GB) into ~/.sp1 on first use.

HERE="$(cd "$1" && pwd)"
ELF="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
OUT="${3:-$HERE/out}"
mkdir -p "$OUT"

if ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi
command -v protoc >/dev/null || (apt-get update -qq && apt-get install -y -qq protobuf-compiler pkg-config libssl-dev clang >/dev/null)

cd "$HERE/host"
# The resolution a GPU box builds with: eth-reflection's prover host's lock plus this host's own crates. Without it the
# SP1 crates' transitive versions drift and sp1-hypercube 6.2.4 does not compile.
cp Cargo.box.lock Cargo.lock
# The GPU prover's features as eth-reflection's prover host has them (the Groth16 wrap runs in the GPU server).
sed -i 's/^sp1-sdk = .*/sp1-sdk = { version = "=6.2.3", features = ["blocking", "network"] }/' Cargo.toml
if ! grep -q '^sp1-prover = "=6.2.4"' Cargo.toml; then
  sed -i '/^\[dependencies\]/a sp1-prover = "=6.2.4"\nsp1-primitives = "=6.2.4"\nsp1-core-machine = "=6.2.4"\nsp1-core-executor = "=6.2.4"\nsp1-recursion-compiler = "=6.2.4"\nsp1-recursion-circuit = "=6.2.4"\nsp1-recursion-gnark-ffi = "=6.2.4"\nsp1-recursion-machine = "=6.2.4"\nsp1-verifier = "=6.2.4"\nsp1-curves = "=6.2.4"\nsp1-derive = "=6.2.4"\nsp1-build = "=6.2.4"' Cargo.toml
fi
t0=$(date +%s)
cargo build --release --features cuda 2>&1 | tail -3
t1=$(date +%s)
./target/release/tac-oracle-host input \
  --venues 0x0000002C48F347Fc4245226b71457E6bC85A5724,0x000000cD99De6AD4079F9e327c2A61eD58AB8551 --count 5 --dir "$OUT" >/dev/null
t2=$(date +%s)
./target/release/tac-oracle-host execute --elf "$ELF" --dir "$OUT" | tail -1
t3=$(date +%s)
SP1_PROVER=cuda ./target/release/tac-oracle-host prove --elf "$ELF" --dir "$OUT" >/dev/null
t4=$(date +%s)
printf 'build %ss\ninput %ss\nexecute %ss\nprove (groth16, cuda) %ss\n' $((t1-t0)) $((t2-t1)) $((t3-t2)) $((t4-t3)) | tee "$OUT/times.txt"
echo "proof: $OUT/proof.json"
