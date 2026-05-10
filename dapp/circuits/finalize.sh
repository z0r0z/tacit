#!/usr/bin/env bash
# Finalize the tacit mixer ceremony in one shot.
#
# Usage:
#   ./finalize.sh <bitcoin_block_height> [circuit_hash]
#
# What it does (no manual steps in the middle):
#   1. Reads CEREMONY_INIT_TOKEN from env or stdin (required for /finalize)
#   2. Resolves the worker's current head zkey CID
#   3. Downloads the head zkey from IPFS gateway
#   4. Fetches the chosen BTC block's hash from mempool.space
#   5. Applies snarkjs's beacon (10 iterations of MiMC)
#   6. POSTs the beacon-applied zkey to /ceremony/<hash>/finalize
#   7. Exports the finalized verifying key
#   8. Stages the ceremony bundle for IPFS pinning (you pin via Pinata / w3up
#      / ipfs add -r — see printed instructions at the end)
#
# The whole thing takes ~30 seconds + the time it takes to pin the bundle.

set -euo pipefail

# --- args ---
BLOCK_HEIGHT="${1:-}"
CIRCUIT_HASH="${2:-1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d}"
WORKER="${WORKER:-https://tacit-pin.rosscampbell9.workers.dev}"
GATEWAY="${GATEWAY:-https://content.wrappr.wtf/ipfs}"

if [ -z "$BLOCK_HEIGHT" ]; then
  echo "usage: $0 <bitcoin_block_height> [circuit_hash]"
  echo "  block height: a confirmed Bitcoin block to use as the beacon source"
  echo "                (you announced this height before contributors finished)"
  exit 1
fi
if ! [[ "$BLOCK_HEIGHT" =~ ^[0-9]+$ ]]; then
  echo "block height must be a positive integer"; exit 1
fi
if ! [[ "$CIRCUIT_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "circuit_hash must be 64 lowercase hex chars"; exit 1
fi

cd "$(dirname "$0")"

# --- token ---
if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
  printf "Paste CEREMONY_INIT_TOKEN (from your password manager): "
  read -rs CEREMONY_INIT_TOKEN
  echo
fi
if [ -z "$CEREMONY_INIT_TOKEN" ]; then
  echo "no token provided"; exit 1
fi

mkdir -p build artifacts ceremony-bundle

echo
echo "==> [1/8] Fetching ceremony state"
STATE=$(curl -sf "$WORKER/ceremony/$CIRCUIT_HASH")
HEAD_CID=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['head_cid'])")
PTAU_CID=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['ptau_cid'])")
R1CS_CID=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['r1cs_cid'])")
COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['contribution_count'])")
FINALIZED=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'].get('finalized', False))")
echo "    contributions: $COUNT"
echo "    head zkey:     $HEAD_CID"
echo "    finalized:     $FINALIZED"

if [ "$FINALIZED" = "True" ]; then
  echo "    Already finalized. Aborting."
  exit 1
fi
if [ "$COUNT" = "0" ]; then
  echo "    Warning: ceremony has 0 contributions (only the genesis). Are you sure?"
  printf "    Continue anyway? [y/N] "
  read -r yn
  [ "$yn" = "y" ] || [ "$yn" = "Y" ] || exit 0
fi

echo
echo "==> [2/8] Downloading head zkey from IPFS"
curl -sLf "$GATEWAY/$HEAD_CID" -o build/withdraw_pre_beacon.zkey
echo "    $(wc -c < build/withdraw_pre_beacon.zkey) bytes"

echo
echo "==> [3/8] Fetching Bitcoin block $BLOCK_HEIGHT hash from mempool.space"
BTC_BLOCK_HASH=$(curl -sf "https://mempool.space/api/block-height/$BLOCK_HEIGHT")
if ! [[ "$BTC_BLOCK_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "    ERROR: invalid block hash from mempool.space: '$BTC_BLOCK_HASH'"
  echo "    Has block $BLOCK_HEIGHT confirmed yet? Check https://mempool.space/block/$BLOCK_HEIGHT"
  exit 1
fi
echo "    block $BLOCK_HEIGHT: $BTC_BLOCK_HASH"

echo
echo "==> [4/8] Applying beacon (numIterationsExp=10 → 1024 actual iterations)"
npx snarkjs zkey beacon \
  build/withdraw_pre_beacon.zkey \
  build/withdraw_final.zkey \
  "$BTC_BLOCK_HASH" 10 \
  -n "bitcoin block $BLOCK_HEIGHT beacon" \
  >/dev/null 2>&1
echo "    wrote build/withdraw_final.zkey ($(wc -c < build/withdraw_final.zkey) bytes)"

# CRITICAL safety gate. Once we POST a malformed zkey to /finalize the
# ceremony locks against further contributes and the only recovery is
# /reset (which nukes ALL contributions). So we run snarkjs's full
# r1cs+ptau+zkey verify locally BEFORE the POST and abort if it doesn't
# pass. Downloads r1cs + ptau from IPFS rather than reading local
# build/ files so this works on a fresh checkout and verifies against
# the EXACT artifacts the chain was built on (not a potentially-stale
# local rebuild).
echo
echo "==> [5/8] Pre-flight: verifying beacon-applied zkey vs chain artifacts"
echo "    Downloading r1cs ($R1CS_CID)…"
curl -sLf "$GATEWAY/$R1CS_CID" -o build/withdraw_chain.r1cs
echo "    Downloading ptau ($PTAU_CID)…"
curl -sLf "$GATEWAY/$PTAU_CID" -o build/pot14_chain.ptau
echo "    Running snarkjs zkey verify (this can take ~30-60s)…"
if ! npx snarkjs zkey verify \
    build/withdraw_chain.r1cs \
    build/pot14_chain.ptau \
    build/withdraw_final.zkey 2>&1 | tee build/verify.log | grep -q "ZKey OK"; then
  echo
  echo "    ✗ LOCAL VERIFY FAILED. Beacon-applied zkey is NOT a valid extension"
  echo "      of the chain. Aborting before POST so the ceremony stays open."
  echo
  echo "    See build/verify.log for the snarkjs error trail."
  echo "    Common causes:"
  echo "      • build/withdraw_pre_beacon.zkey is corrupt or partial (re-run from step 2)"
  echo "      • beacon block hash format wrong (must be 64 lowercase hex)"
  echo "      • snarkjs version mismatch between contributors and finalizer"
  exit 1
fi
echo "    ✓ ZKey OK — beacon-applied zkey verified against chain r1cs+ptau"

echo
echo "==> [6/8] POSTing to /finalize"
RESP=$(curl -sf -X POST \
  -H "X-Tacit-Init-Token: $CEREMONY_INIT_TOKEN" \
  -F "zkey=@build/withdraw_final.zkey" \
  -F "beacon_block_hash=$BTC_BLOCK_HASH" \
  -F "beacon_iterations=10" \
  "$WORKER/ceremony/$CIRCUIT_HASH/finalize")
FINAL_CID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['head_cid'])")
echo "    finalized head_cid: $FINAL_CID"
echo "    state: $(echo "$RESP" | python3 -c "import sys,json; s=json.load(sys.stdin)['state']; print(f\"contributions={s['contribution_count']} finalized={s.get('finalized',False)} beacon={s.get('beacon_block_hash','?')[:16]}…\")")"

echo
echo "==> [7/8] Exporting verifying key"
npx snarkjs zkey export verificationkey \
  build/withdraw_final.zkey \
  artifacts/verification_key_final.json \
  >/dev/null 2>&1
N_PUBLIC=$(python3 -c "import json; print(json.load(open('artifacts/verification_key_final.json'))['nPublic'])")
echo "    artifacts/verification_key_final.json (nPublic=$N_PUBLIC)"

echo
echo "==> [8/8] Staging ceremony bundle"
# Use the chain-downloaded artifacts (build/withdraw_chain.r1cs +
# build/pot14_chain.ptau) so the bundle reflects exactly what the
# ceremony was built on, not a potentially-stale local rebuild from
# build.sh. Renamed in the bundle to match snarkjs's expected filenames.
cp build/withdraw_chain.r1cs ceremony-bundle/withdraw.r1cs
cp build/pot14_chain.ptau ceremony-bundle/pot14_final.ptau
cp build/withdraw_pre_beacon.zkey ceremony-bundle/withdraw_pre_beacon.zkey
cp build/withdraw_final.zkey ceremony-bundle/withdraw_final.zkey
cp artifacts/verification_key_final.json ceremony-bundle/verification_key_final.json
cp artifacts/verification_key_final.json ceremony-bundle/verification_key.json
curl -sf "$WORKER/ceremony/$CIRCUIT_HASH/attestations" > ceremony-bundle/attestations.json
{
  echo "# Tacit mixer ceremony — circuit $CIRCUIT_HASH"
  echo
  echo "- Phase 1 ptau: Polygon Hermez pot14 (BLAKE2b matches snarkjs README row 14)"
  echo "- Phase 2: $COUNT contributions, see attestations.json"
  echo "- Beacon: Bitcoin block $BLOCK_HEIGHT ($BTC_BLOCK_HASH), 10 iterations"
  echo "- Final zkey sha256: $(shasum -a 256 ceremony-bundle/withdraw_final.zkey | cut -d' ' -f1)"
  echo
  echo "Verify locally:"
  echo '    npx snarkjs zkey verify withdraw.r1cs pot14_final.ptau withdraw_final.zkey'
} > ceremony-bundle/README.md

echo "    ceremony-bundle/ ready ($(du -sh ceremony-bundle | cut -f1))"

echo
echo "================================================================"
echo "  ✓ Ceremony finalized."
echo "================================================================"
echo
echo "  Next steps (~5 min):"
echo
echo "  1. Pin the bundle to IPFS as a directory and grab its CID:"
echo "       w3 up ceremony-bundle/                     # web3.storage"
echo "       # OR drag the folder into Pinata's web UI"
echo "       # OR ipfs add -r ceremony-bundle/"
echo
echo "  2. Open https://tacit.finance/  → Mixer tab → 'Initialize a new pool':"
echo "       Asset:           [pick from dropdown]"
echo "       Denomination:    [pool size in base units]"
echo "       vk JSON:         dapp/circuits/artifacts/verification_key_final.json"
echo "                        (auto-pins via worker, fills vk CID)"
echo "       Ceremony CID:    [the directory CID from step 1]"
echo
echo "  3. Click 'Initialize pool & broadcast'. Sign commit + reveal."
echo
echo "================================================================"
