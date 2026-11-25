#!/bin/sh
# Builds g.wasm (gnark's own code for the proof and the scaling) and copies the Go runtime shim that matches it.
set -eu
cd "$(dirname "$0")/.."
GOOS=js GOARCH=wasm go build -trimpath -o browser/g.wasm ./browser/gowasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" browser/wasm_exec.js
