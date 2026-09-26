#!/usr/bin/env bash
# Compile transact.circom → build/transact.r1cs, build/transact_js/transact.wasm, build/transact.sym, and
# check the constraint budget. Requires circom 2.1.6+ (measured with 2.2.3) and `npm ci` in dapp/circuits.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

BUDGET=65536   # 2^16

out=$(circom transact.circom --r1cs --wasm --sym --O2 -o build 2>&1)
echo "$out" | grep -E "non-linear|^linear|public inputs|private inputs|wires" | sed 's/^/    /'
nl=$(echo "$out" | grep "non-linear constraints" | awk '{print $NF}')
lin=$(echo "$out" | grep "^linear constraints" | awk '{print $NF}')
total=$((nl + lin))
if [ "$total" -gt "$BUDGET" ]; then
  echo "FAIL transact: $total constraints > $BUDGET"
  exit 1
fi
cp build/transact_js/witness_calculator.js build/transact_js/witness_calculator.cjs
echo "transact: $total constraints (budget $BUDGET)"
echo "r1cs sha256: $(shasum -a 256 build/transact.r1cs | cut -d' ' -f1)"
echo "wasm sha256: $(shasum -a 256 build/transact_js/transact.wasm | cut -d' ' -f1)"
