#!/usr/bin/env bash
# Build the three AMM circuits.
#
# Prereqs (install once):
#   - circom 2.1.6+: https://docs.circom.io/getting-started/installation/
#   - rust + cargo (for circom): https://rustup.rs
#   - npm install   (in dapp/circuits/, one level up)
#
# This script:
#   1. compiles amm_lp_add.circom, amm_lp_remove.circom, amm_swap_batch.circom
#      → r1cs + wasm + sym, output in build/
#   2. prints constraint counts and validates against AMM.md targets:
#        • amm_lp_add      ≤ 30K   (current: ~5K)
#        • amm_lp_remove   ≤ 30K   (current: ~10K)
#        • amm_swap_batch  ≤ 300K  (current: ~165K)
#
# Phase-1 ptau and Phase-2 ceremony are managed by ./finalize.sh once the
# circuit constraint counts and witness shapes are accepted. This script is
# the design-validation step and is safe to re-run any time circuits change.

set -euo pipefail

cd "$(dirname "$0")"

mkdir -p build

PASS=0
FAIL=0

run_circuit() {
    local name="$1"
    local budget="$2"
    echo "==> Compiling $name.circom"
    local out
    out=$(circom $name.circom --r1cs --wasm --sym -l ../node_modules -o build 2>&1)
    echo "$out" | grep -E "non-linear|linear|public inputs|private inputs|wires" \
        | sed 's/^/    /'

    local nl lin total
    nl=$(echo "$out" | grep "non-linear constraints" | awk '{print $NF}')
    lin=$(echo "$out" | grep "^linear constraints" | awk '{print $NF}')
    total=$((nl + lin))

    if [ "$total" -le "$budget" ]; then
        echo "    PASS  $name  total=$total constraints (budget $budget)"
        PASS=$((PASS + 1))
    else
        echo "    FAIL  $name  total=$total constraints EXCEEDS budget $budget"
        FAIL=$((FAIL + 1))
    fi
    echo
}

run_circuit amm_lp_add      30000
run_circuit amm_lp_remove   30000
run_circuit amm_swap_batch  300000

# Copy circom-generated witness calculators to .cjs so they can be loaded from
# this directory's ESM scope (parent package.json sets "type":"module").
for name in amm_lp_add amm_lp_remove amm_swap_batch; do
    src="build/${name}_js/witness_calculator.js"
    dst="build/${name}_js/witness_calculator.cjs"
    if [ -f "$src" ]; then
        cp "$src" "$dst"
    fi
done

# Drift-guard: re-run after compile to catch any ceremony-invalidating change.
# Fails loudly if .circom or .r1cs hashes don't match pinned values.
echo "==> Drift-guard against pinned ceremony fingerprints"
if ! node drift-guard.test.mjs; then
    echo "    Refusing to claim build success — see drift-guard.test.mjs output."
    exit 1
fi

echo "==> Summary: $PASS pass / $FAIL fail"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi

echo
echo "==> Build artifacts in build/:"
ls -lh build/*.r1cs build/*_js/*.wasm 2>/dev/null | awk '{print "    " $9 "  " $5}'
echo
echo "Next: run ./finalize.sh once you're ready to do Phase 1 ptau download +"
echo "Phase 2 ceremony coordination (mirrors the mixer's finalize.sh)."
