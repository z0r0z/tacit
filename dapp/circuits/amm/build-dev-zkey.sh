#!/usr/bin/env bash
# DEV-ONLY Phase 2 zkey generation for AMM circuits.
#
# Produces single-contributor, dev-beacon zkeys suitable for testing the
# end-to-end real-Groth16 pipeline. NOT PRODUCTION SAFE — a real V1 launch
# requires the multi-contributor ceremony described in
# AMM-CEREMONY-RUNBOOK.md (≥1000 contributors, Bitcoin-block-hash beacon,
# public attestation chain).
#
# Output files are named `*_dev_final.zkey` and `*_dev_vk.json` to make
# the dev provenance unambiguous. Anyone routing these into production
# code is misconfigured.
#
# Run from this directory: bash build-dev-zkey.sh
# Requires: snarkjs in ../node_modules (already installed per
# dapp/circuits/package.json).

set -euo pipefail
cd "$(dirname "$0")"

SNARKJS=../node_modules/.bin/snarkjs
PTAU=dev-zkey/pot18_final.ptau

if [ ! -f "$PTAU" ]; then
    echo "FAIL: $PTAU not found. Phase 1 ptau missing."
    exit 1
fi
if [ ! -x "$SNARKJS" ]; then
    echo "FAIL: $SNARKJS not found. Run 'npm install' in ../."
    exit 1
fi

DEV_ENTROPY="tacit-amm-dev-zkey-2026-not-production-safe-$(date +%s%N)"
DEV_BEACON_HEX="deadbeefcafef00d0123456789abcdefdeadbeefcafef00d0123456789abcdef"

CIRCUITS=(amm_lp_add amm_lp_remove amm_swap_batch)

for c in "${CIRCUITS[@]}"; do
    echo ""
    echo "================ $c ================"

    R1CS="build/$c.r1cs"
    Z0="dev-zkey/${c}_0000.zkey"
    Z1="dev-zkey/${c}_0001.zkey"
    ZF="dev-zkey/${c}_dev_final.zkey"
    VK="dev-zkey/${c}_dev_vk.json"

    if [ ! -f "$R1CS" ]; then
        echo "  SKIP — $R1CS not present (run build.sh first)"
        continue
    fi

    echo "  [1/4] groth16 setup"
    $SNARKJS groth16 setup "$R1CS" "$PTAU" "$Z0" 2>&1 | tail -3

    echo "  [2/4] dev contribution (single contributor — NOT a real ceremony)"
    $SNARKJS zkey contribute "$Z0" "$Z1" --name="tacit-amm-dev" -e="$DEV_ENTROPY" 2>&1 | tail -3

    echo "  [3/4] dev beacon (deterministic dev seed — NOT a real Bitcoin block beacon)"
    $SNARKJS zkey beacon "$Z1" "$ZF" "$DEV_BEACON_HEX" 10 -n="dev-beacon" 2>&1 | tail -3

    echo "  [4/4] export verification key"
    $SNARKJS zkey export verificationkey "$ZF" "$VK" 2>&1 | tail -3

    rm -f "$Z0" "$Z1"
    echo "  DONE  $ZF + $VK"
done

echo ""
echo "Dev zkeys built at dapp/circuits/amm/dev-zkey/*_dev_final.zkey"
echo "WARNING: these are DEV-ONLY single-contributor zkeys. Replace with"
echo "ceremony output before any production use."
