#!/usr/bin/env bash
# Builds the aggregate verifier wasm into worker-relay/src/lib/btc-pool-agg-verify/ (web target; Node loads it
# with the wasm bytes).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --lib --release --target wasm32-unknown-unknown
OUT=../../../../../worker-relay/src/lib/btc-pool-agg-verify
wasm-bindgen --target web --out-dir "$OUT" target/wasm32-unknown-unknown/release/btc_pool_agg_verify.wasm
rm -f "$OUT"/*.d.ts "$OUT"/.gitignore
ls -l "$OUT"
