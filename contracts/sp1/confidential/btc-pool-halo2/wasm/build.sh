#!/usr/bin/env bash
# wasm builds: pkg/ (web, single thread), pkg-node/ (Node, single thread), pkg-threads/ (web, rayon over
# Web Workers; needs nightly + rust-src and a page served with COOP/COEP). wasm-bindgen-cli must match
# the wasm-bindgen crate version in Cargo.lock.
set -euo pipefail
cd "$(dirname "$0")/.."
T=wasm32-unknown-unknown

cargo build --lib --release --target $T --no-default-features --features wasm
wasm-bindgen --target web --out-dir wasm/pkg target/$T/release/btc_pool_halo2.wasm
wasm-bindgen --target nodejs --out-dir wasm/pkg-node target/$T/release/btc_pool_halo2.wasm

RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=4294967296 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base' \
  rustup run nightly cargo build --lib --release --target $T --no-default-features --features wasm-threads \
  -Z build-std=panic_abort,std --target-dir target/threads
wasm-bindgen --target web --out-dir wasm/pkg-threads target/threads/$T/release/btc_pool_halo2.wasm

ls -l wasm/pkg/*.wasm wasm/pkg-node/*.wasm wasm/pkg-threads/*.wasm
