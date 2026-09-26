#!/usr/bin/env bash
# DEV-ONLY phase 2 for transact.circom. TESTS AND TESTNETS ONLY. NOT FOR MAINNET.
#
# One contributor with local entropy plus a fixed dev beacon: whoever runs this script can forge proofs
# under the resulting key. Mainnet keys come from the multi-party ceremony on the existing coordinator.
#
# Phase 1 is the pinned Hermez pot18 (BLAKE2b checked below, same pin as ../pin-pot18.sh).
#   PTAU=/path/to/pot18_final.ptau bash build-dev-zkey.sh
# Outputs (gitignored): build/transact_dev_final.zkey, build/transact_dev_vk.json, build/TransactVerifierDev.sol
set -euo pipefail
cd "$(dirname "$0")"

SNARKJS=../node_modules/.bin/snarkjs
PTAU=${PTAU:-../pot18_final.ptau}
PTAU_BLAKE2B="7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e"

[ -f build/transact.r1cs ] || bash build.sh
[ -f "$PTAU" ] || { echo "FAIL: $PTAU not found"; exit 1; }
[ -x "$SNARKJS" ] || { echo "FAIL: run npm ci in dapp/circuits"; exit 1; }

got=$(openssl dgst -blake2b512 "$PTAU" | sed 's/.*= //')
if [ "$got" != "$PTAU_BLAKE2B" ]; then
  echo "FAIL: $PTAU is not the pinned pot18 (blake2b $got)"
  exit 1
fi

Z0=build/transact_dev_0000.zkey
Z1=build/transact_dev_0001.zkey
ZF=build/transact_dev_final.zkey
VK=build/transact_dev_vk.json
SOL=build/TransactVerifierDev.sol
BEACON=deadbeefcafef00d0123456789abcdefdeadbeefcafef00d0123456789abcdef

$SNARKJS groth16 setup build/transact.r1cs "$PTAU" "$Z0"
$SNARKJS zkey contribute "$Z0" "$Z1" --name="evm-pool-dev-NOT-FOR-MAINNET" \
  -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
$SNARKJS zkey beacon "$Z1" "$ZF" "$BEACON" 10 -n="dev-beacon-NOT-FOR-MAINNET"
$SNARKJS zkey export verificationkey "$ZF" "$VK"
$SNARKJS zkey export solidityverifier "$ZF" "$SOL"
rm -f "$Z0" "$Z1"

echo "DEV zkey (tests/testnets only): $ZF  $(stat -f %z "$ZF" 2>/dev/null || stat -c %s "$ZF") bytes"
echo "  sha256 $(shasum -a 256 "$ZF" | cut -d' ' -f1)"
echo "DEV vk: $VK  sha256 $(shasum -a 256 "$VK" | cut -d' ' -f1)"
