#!/bin/sh
# Builds the prover and writes its wasm and glue into dapp/vendor (fixed-pool-prover.js, fixed-pool-prover_bg.wasm).
# Needs the wasm32-unknown-unknown target and wasm-bindgen-cli at the version Cargo.toml pins:
#   cargo install wasm-bindgen-cli --version 0.2.108 --locked
set -eu
cd "$(dirname "$0")"
want=0.2.108
have=$(wasm-bindgen --version | awk '{print $2}')
[ "$have" = "$want" ] || { echo "wasm-bindgen $want is needed, found $have" >&2; exit 1; }
cargo build --release --target wasm32-unknown-unknown --locked
wasm-bindgen --target web --no-typescript --out-dir ../../dapp/vendor --out-name fixed-pool-prover \
  target/wasm32-unknown-unknown/release/fixed_pool_prover.wasm
ls -l ../../dapp/vendor/fixed-pool-prover.js ../../dapp/vendor/fixed-pool-prover_bg.wasm
