#!/usr/bin/env bash
# Build every confidential per-op prover in NETWORK mode → dist/exec-<op>. The Cargo [[bin]] is always `exec`
# built from src/main.rs, so we copy each harness → src/main.rs, build, and rename the output. No GPU, no
# native-gnark: the hosted Succinct network does the proving. Run after patch-harnesses-network.sh.
# Usage: ./build-all-network.sh [op ...]   (default: the launch-critical set)
set -euo pipefail
cd "$(dirname "$0")"
source "$HOME/.cargo/env" 2>/dev/null || true

# Launch-critical ops (relay type → harness). Extend as needed; `all` builds every harness.
DEFAULT_OPS=(wrap sendunwrap wraptransfer swap unwrap lp lpremove otc route bid crosslane bridgeburn bridgemint cbtcmint cdpmint cdpclose)
if [ "${1:-}" = "all" ]; then
  OPS=(); for h in harnesses/exec-*.rs; do OPS+=("$(basename "$h" .rs | sed 's/^exec-//')"); done
elif [ "$#" -gt 0 ]; then OPS=("$@"); else OPS=("${DEFAULT_OPS[@]}"); fi

mkdir -p dist harnesses/src
for op in "${OPS[@]}"; do
  h="harnesses/exec-${op}.rs"
  if [ ! -f "$h" ]; then echo "SKIP $op (no harness $h)"; continue; fi
  echo "=== building exec-${op} ==="
  cp "$h" harnesses/src/main.rs
  ( cd harnesses && cargo build --release --bin exec )
  cp harnesses/target/release/exec "dist/exec-${op}"
  echo "  → dist/exec-${op}  ($(shasum -a 256 "dist/exec-${op}" | cut -c1-16)…)"
done
echo "=== SHA256SUMS ==="
( cd dist && shasum -a 256 exec-* | tee SHA256SUMS )
echo "done — upload dist/exec-* to the prover-bins release + update worker-relay/prover/bin/SHA256SUMS"
