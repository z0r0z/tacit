#!/bin/bash
set -euo pipefail

# Guard the immutable ConfidentialPool artifact on every PR.
#
#   1. EIP-170 (ALWAYS hard-fail): runtime bytecode <= 24576 bytes. The pool ships ~20 bytes under the
#      limit, so an added require/event/getter can silently produce an UNDEPLOYABLE contract. Catching that
#      at deploy time means discovering it after the guest re-prove and the vanity-salt grind.
#   2. Artifact identity: keccak(runtime) == pool-bytecode-pin.json:runtime_keccak. A mismatch means the
#      bytecode changed — legitimately (code/compiler change: update the pin IN THE SAME COMMIT) or
#      accidentally (a floating solc, a dependency bump). Same discipline as sp1/confidential/elf-vkey-pin.json.
#
# The compiler is pinned at the source (`pragma solidity 0.8.34;`) rather than in foundry.toml, because the
# *ProofReal units pin 0.8.20 for the vendored SP1 Groth16Verifier — the build is intentionally multi-version.
#
# Exit non-zero on any mismatch.

cd "$(dirname "$0")"
PIN="pool-bytecode-pin.json"
[ -f "$PIN" ] || { echo "FAIL: missing $PIN"; exit 1; }

want_size=$(grep -o '"runtime_size"[[:space:]]*:[[:space:]]*[0-9]*' "$PIN" | grep -o '[0-9]*$')
want_hash=$(grep -o '"runtime_keccak"[[:space:]]*:[[:space:]]*"[^"]*"' "$PIN" | sed 's/.*"\(0x[^"]*\)"/\1/')
limit=24576

code=$(forge inspect ConfidentialPool deployedBytecode | tr -d '\n')
case "$code" in 0x*) ;; *) echo "FAIL: could not read deployedBytecode"; exit 1;; esac
size=$(( (${#code} - 2) / 2 ))
hash=$(cast keccak "$code")

echo "ConfidentialPool runtime: $size bytes (limit $limit, headroom $(( limit - size )))"

if [ "$size" -gt "$limit" ]; then
  echo "FAIL: EIP-170 EXCEEDED by $(( size - limit )) bytes — this contract CANNOT be deployed."
  echo "      Reduce pool code or move a surface behind the router before proceeding."
  exit 1
fi

if [ "$size" != "$want_size" ] || [ "$hash" != "$want_hash" ]; then
  echo "FAIL: artifact differs from the reviewed pin."
  echo "      pinned: $want_size bytes  $want_hash"
  echo "      built:  $size bytes  $hash"
  echo "      If this change is intentional, update $PIN in the SAME commit."
  exit 1
fi

echo "OK: runtime matches the pinned artifact ($hash)"
