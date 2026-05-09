#!/usr/bin/env bash
# Build the tacit mixer withdrawal circuit.
#
# Prereqs (install once):
#   - circom 2.1.6+: https://docs.circom.io/getting-started/installation/
#   - rust + cargo (for circom): https://rustup.rs
#   - npm install   (this directory)
#
# This script:
#   1. compiles withdraw.circom → withdraw.r1cs + withdraw_js/witness generator
#   2. downloads a Powers-of-Tau ceremony transcript (BN254, 2^17 ≈ 130k constraints)
#   3. runs Groth16 setup (Phase 2) — DEMO ONLY, see README §"Trusted setup"
#   4. exports the verifying key (verification_key.json)
#   5. exports the verifier as Solidity (Verifier.sol) and as snarkjs JSON for
#      browser-side verification
#
# Outputs land in artifacts/. The on-chain envelope's vk_cid points to a
# CID where verification_key.json has been pinned.

set -euo pipefail

cd "$(dirname "$0")"

mkdir -p build artifacts

echo "==> Compiling withdraw.circom"
circom withdraw.circom \
  --r1cs --wasm --sym \
  -l node_modules \
  -o build

echo "==> Powers-of-Tau"
# pot14 (16384 max constraints) covers our ~12k-wire circuit comfortably with
# room for the secp256k1 in-circuit hardening if/when added.
#
# **Phase 1 ptau is the load-bearing trust assumption** — a malicious or
# single-party ptau means whoever holds the toxic waste can forge proofs for
# every pool ever built on this circuit, regardless of how many honest Phase 2
# contributors join. We fetch the truncated pot14 from Polygon Hermez (formerly
# Hermez Network), which conducted a 71-contributor public Phase 1 ceremony
# from 2020–2022 with a Bitcoin-block-hash beacon at the end. The expected
# sha256 is pinned below; if the download doesn't match, the script aborts.
PTAU="build/pot14_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau"
# Canonical BLAKE2b-512 — published in snarkjs's official README, row 14.
# https://github.com/iden3/snarkjs README "Powers of Tau" table.
PTAU_EXPECTED_BLAKE2B="eeefbcf7c3803b523c94112023c7ff89558f9b8e0cf5d6cdcba3ade60f168af4a181c9c21774b94fbae6c90411995f7d854d02ebd93fb66043dbb06f17a831c1"
# Belt-and-suspenders sha256, computed locally after fetch.
PTAU_EXPECTED_SHA256="489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d"

if [ ! -f "$PTAU" ]; then
  echo "    Fetching verified pot14 from Polygon Hermez ceremony…"
  curl -sLo "$PTAU.tmp" "$PTAU_URL"
  ACTUAL_SHA=$(shasum -a 256 "$PTAU.tmp" | cut -d' ' -f1)
  ACTUAL_B2B=$(openssl dgst -blake2b512 "$PTAU.tmp" 2>/dev/null | sed 's/.*= //')
  if [ "$ACTUAL_SHA" != "$PTAU_EXPECTED_SHA256" ] || [ "$ACTUAL_B2B" != "$PTAU_EXPECTED_BLAKE2B" ]; then
    rm -f "$PTAU.tmp"
    echo "    ERROR: pot14 hash mismatch"
    echo "    sha256   expected: $PTAU_EXPECTED_SHA256"
    echo "             got:      $ACTUAL_SHA"
    echo "    blake2b  expected: $PTAU_EXPECTED_BLAKE2B"
    echo "             got:      $ACTUAL_B2B"
    echo "    Refusing to use unverified Phase 1 ptau (would invalidate every Phase 2 contribution)."
    exit 1
  fi
  mv "$PTAU.tmp" "$PTAU"
  echo "    Verified sha256:  $PTAU_EXPECTED_SHA256"
  echo "    Verified blake2b: $PTAU_EXPECTED_BLAKE2B (matches snarkjs README)"
fi

echo "==> Groth16 setup (DEMO ceremony — single-contributor)"
npx snarkjs groth16 setup build/withdraw.r1cs "$PTAU" build/withdraw_0000.zkey

echo "==> Phase 2 contribution (DEMO — replace with multi-party MPC for real pools)"
npx snarkjs zkey contribute build/withdraw_0000.zkey build/withdraw_final.zkey \
  --name="tacit demo contributor 1" \
  -v -e="$(date +%s%N)$RANDOM tacit demo entropy do not use in production"

echo "==> Export verification key + Solidity verifier"
npx snarkjs zkey export verificationkey build/withdraw_final.zkey artifacts/verification_key.json
npx snarkjs zkey export solidityverifier build/withdraw_final.zkey artifacts/Verifier.sol

cp build/withdraw_js/withdraw.wasm artifacts/withdraw.wasm
cp build/withdraw_final.zkey artifacts/withdraw_final.zkey

echo
echo "==> Build complete."
echo "    artifacts/verification_key.json  (vk for snarkjs.groth16.verify)"
echo "    artifacts/withdraw.wasm          (witness generator)"
echo "    artifacts/withdraw_final.zkey    (proving key)"
echo "    artifacts/Verifier.sol           (Solidity verifier — out-of-band reference)"
echo
echo "    Pin verification_key.json to IPFS, copy its CID into the POOL_INIT"
echo "    envelope's vk_cid field. Pin a ceremony transcript to IPFS too and"
echo "    record its CID in ceremony_cid."
