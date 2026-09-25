#!/usr/bin/env bash
# Compile spend.circom → build/spend.r1cs, build/spend_js/spend.wasm, build/spend.sym, and check the
# constraint budget. Requires circom 2.1.6+ (measured with 2.2.3) and `npm ci` in dapp/circuits.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

BUDGET=32768   # 2^15

out=$(circom spend.circom --r1cs --wasm --sym --O2 -o build 2>&1)
echo "$out" | grep -E "non-linear|^linear|public inputs|private inputs|wires" | sed 's/^/    /'
nl=$(echo "$out" | grep "non-linear constraints" | awk '{print $NF}')
lin=$(echo "$out" | grep "^linear constraints" | awk '{print $NF}')
total=$((nl + lin))
if [ "$total" -gt "$BUDGET" ]; then
  echo "FAIL spend: $total constraints > $BUDGET"
  exit 1
fi
cp build/spend_js/witness_calculator.js build/spend_js/witness_calculator.cjs
echo "spend: $total constraints (budget $BUDGET)"
echo "r1cs sha256: $(shasum -a 256 build/spend.r1cs | cut -d' ' -f1)"
echo "wasm sha256: $(shasum -a 256 build/spend_js/spend.wasm | cut -d' ' -f1)"
