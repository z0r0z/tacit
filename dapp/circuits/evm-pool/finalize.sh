#!/usr/bin/env bash
# Seal the transact.circom phase-2 chain with a Bitcoin block-hash beacon and export the production artifacts:
# final zkey, verification key, the Solidity verifier as `TransactVerifier`, and pin.json with the hashes the
# client checks (vk_hash is makeGroth16System({pinnedVkHash}) in dapp/evm-pool-zk-prover.js).
#
# Before this (operator): pause contributions and fetch the head the beacon is applied to.
#   curl --config "$CFG" -sS -X POST -F duration_seconds=1800 $WORKER/ceremony/<circuit_hash>/drain
#   HEAD_CID=$(curl -s $WORKER/ceremony/<circuit_hash> | jq -r .state.head_cid)
#   curl -sLf "$GATEWAY/$HEAD_CID" -o head.zkey
#
#   HEAD_CID=... bash finalize.sh head.zkey                                 # beacon: block (tip - 12)
#   HEAD_CID=... BEACON_HEIGHT=<h> bash finalize.sh head.zkey               # beacon: block h
#   BEACON_HEIGHT=<h> BEACON_HASH=<64 hex> bash finalize.sh head.zkey       # given hash, no explorer lookup
#
# The beacon follows ../finalize-amm.sh: a Bitcoin block at least 12 deep, its hash taken from two explorers
# that must agree, 2^10 iterations. Env: BEACON_ITERS (10..63), MIN_CONTRIBUTIONS (default 10), OUT, PTAU,
# FORCE=1 to replace an existing $OUT/final. Makes no coordinator or pinning calls; prints them.
set -euo pipefail
source "$(dirname "$0")/ceremony-env.sh"

HEAD=${1:?usage: finalize.sh <head.zkey>}
[ -f "$HEAD" ] || die "$HEAD not found"
magic "$HEAD" 7a6b6579 || die "$HEAD is not a zkey"
need_tools python3 curl
load_manifest
check_ptau
BEACON_ITERS=${BEACON_ITERS:-$BEACON_ITERS_DEFAULT}
[[ "$BEACON_ITERS" =~ ^[0-9]+$ ]] && [ "$BEACON_ITERS" -ge 10 ] && [ "$BEACON_ITERS" -le 63 ] || die "BEACON_ITERS must be in [10, 63]"
MIN_CONTRIBUTIONS=${MIN_CONTRIBUTIONS:-$MIN_CONTRIBUTIONS_DEFAULT}

echo "==> [1/6] Beacon"
if [ -n "${BEACON_HASH:-}" ]; then
  [[ "${BEACON_HEIGHT:-}" =~ ^[0-9]+$ ]] || die "BEACON_HASH needs BEACON_HEIGHT"
  BEACON_HASH=$(echo "$BEACON_HASH" | tr 'A-F' 'a-f')
  [[ "$BEACON_HASH" =~ ^[0-9a-f]{64}$ ]] || die "BEACON_HASH must be 64 hex chars"
  echo "    block $BEACON_HEIGHT $BEACON_HASH (given, not looked up)"
else
  tip=$(curl -sf --max-time 30 https://mempool.space/api/blocks/tip/height || true)
  [[ "$tip" =~ ^[0-9]+$ ]] || die "could not fetch the Bitcoin tip height; pass BEACON_HEIGHT"
  BEACON_HEIGHT=${BEACON_HEIGHT:-$((tip - 12))}
  [[ "$BEACON_HEIGHT" =~ ^[0-9]+$ ]] || die "BEACON_HEIGHT must be a block height"
  depth=$((tip - BEACON_HEIGHT + 1))
  [ "$depth" -ge 12 ] || die "block $BEACON_HEIGHT has $depth confirmations, 12 required"
  h1=$(curl -sf --max-time 30 "https://mempool.space/api/block-height/$BEACON_HEIGHT" | tr 'A-F' 'a-f' || true)
  h2=$(curl -sf --max-time 30 "https://blockstream.info/api/block-height/$BEACON_HEIGHT" | tr 'A-F' 'a-f' || true)
  [[ "$h1" =~ ^[0-9a-f]{64}$ ]] && [[ "$h2" =~ ^[0-9a-f]{64}$ ]] || die "explorer lookup failed ('$h1' / '$h2')"
  [ "$h1" = "$h2" ] || die "explorers disagree on block $BEACON_HEIGHT: $h1 vs $h2"
  BEACON_HASH=$h1
  echo "    block $BEACON_HEIGHT $BEACON_HASH ($depth confirmations, two explorers agree)"
fi
echo "    iterations 2^$BEACON_ITERS"

if [ -e "$FINAL" ]; then
  [ "${FORCE:-0}" = "1" ] || die "$FINAL exists; FORCE=1 replaces it"
  rm -rf "$FINAL"
fi
mkdir -p "$FINAL"
PRE="$FINAL/transact_pre_beacon.zkey"
ZF="$FINAL/transact_final.zkey"
VK="$FINAL/transact_vk.json"
SOL="$FINAL/TransactVerifier.sol"
cp "$HEAD" "$PRE"
head_cid=$(cid "$PRE")
if [ -n "${HEAD_CID:-}" ] && [ "$head_cid" = "$HEAD_CID" ]; then
  echo "    head CID matches the coordinator head_cid"
elif [ -n "${HEAD_CID:-}" ] && [ -n "$head_cid" ]; then
  echo "    note: local CID of the head is $head_cid, coordinator head_cid is $HEAD_CID (import settings differ;"
  echo "          the verify step below is what binds the key)"
fi

echo "==> [2/6] Apply beacon"
t0=$(date +%s)
"$SNARKJS" zkey beacon "$PRE" "$ZF" "$BEACON_HASH" "$BEACON_ITERS" -n="bitcoin-block-$BEACON_HEIGHT" > "$FINAL/beacon.log" 2>&1 \
  || { tail -20 "$FINAL/beacon.log"; die "zkey beacon failed"; }
magic "$ZF" 7a6b6579 || die "beacon produced no zkey"
echo "    $ZF  ($(( $(date +%s) - t0 ))s)"

echo "==> [3/6] Verify the full chain + beacon"
BEACON_HASH=$BEACON_HASH BEACON_ITERS=$BEACON_ITERS MIN_CONTRIBUTIONS=$MIN_CONTRIBUTIONS SUMMARY="$FINAL/transcript.json" \
  OUT="$OUT" PTAU="$PTAU" bash "$EVM_POOL_DIR/ceremony-verify.sh" "$ZF"
contributions=$(jq '[.contributions[] | select(.beacon_hash | not)] | length' "$FINAL/transcript.json")

echo "==> [4/6] Verification key"
"$SNARKJS" zkey export verificationkey "$ZF" "$VK" > /dev/null 2>&1 || die "vk export failed"
[ "$(jq -r '"\(.protocol) \(.curve) \(.nPublic)"' "$VK")" = "groth16 bn128 $N_PUBLIC" ] || die "unexpected vk shape"
VK_HASH=$(vk_hash "$VK")
echo "    $VK  vk_hash $VK_HASH"

echo "==> [5/6] Solidity verifier"
"$SNARKJS" zkey export solidityverifier "$ZF" "$SOL.tmp" > /dev/null 2>&1 || die "solidity export failed"
[ "$(grep -c '^contract Groth16Verifier {' "$SOL.tmp")" = 1 ] || die "unexpected verifier contract name"
grep -q "uint\[$N_PUBLIC\] calldata _pubSignals" "$SOL.tmp" || die "verifier does not take $N_PUBLIC public signals"
sed 's/^contract Groth16Verifier {/contract TransactVerifier {/' "$SOL.tmp" > "$SOL"
rm -f "$SOL.tmp"
echo "    $SOL  sha256 $(sha256 "$SOL")"

echo "==> [6/6] Bundle + pin.json"
cp "$R1CS" "$WASM" "$FINAL/"
cp "$MANIFEST" "$FINAL/genesis.json"
zf_cid=$(cid "$ZF")
jq -n \
  --arg circuit_hash "$CIRCUIT_HASH" --argjson contributions "$contributions" \
  --argjson height "$BEACON_HEIGHT" --arg bhash "$BEACON_HASH" --argjson iters "$BEACON_ITERS" \
  --arg ptau_name "$PTAU_NAME" --arg ptau_b2 "$PTAU_BLAKE2B" --arg ptau_sha "$(sha256 "$PTAU")" \
  --arg vk_hash "$VK_HASH" --arg vk_sha "$(sha256 "$VK")" \
  --arg wasm_sha "$(sha256 "$WASM")" --argjson wasm_bytes "$(bytes "$WASM")" \
  --arg z_sha "$(sha256 "$ZF")" --argjson z_bytes "$(bytes "$ZF")" --arg z_cid "$zf_cid" \
  --arg sol_sha "$(sha256 "$SOL")" \
  '{
    note: "transact.circom phase-2 ceremony key: \($contributions) contributions plus a Bitcoin block beacon.",
    system: "groth16-bn254",
    circuit: "dapp/circuits/evm-pool/transact.circom",
    circuit_hash: $circuit_hash,
    contributions: $contributions,
    beacon: { block_height: $height, block_hash: $bhash, iterations_exp: $iters },
    ptau: { file: $ptau_name, blake2b: $ptau_b2, sha256: $ptau_sha },
    vk: "transact_vk.json", vk_hash: $vk_hash, vk_sha256: $vk_sha,
    wasm: "transact.wasm", wasm_sha256: $wasm_sha, wasm_bytes: $wasm_bytes,
    zkey: "transact_final.zkey", zkey_sha256: $z_sha, zkey_bytes: $z_bytes, zkey_cid: $z_cid,
    verifier: "TransactVerifier.sol", verifier_sha256: $sol_sha
  }' > "$FINAL/pin.json"

{
  echo "# transact.circom phase-2 ceremony"
  echo
  echo "Circuit \`dapp/circuits/evm-pool/transact.circom\`, circuit hash (r1cs SHA-256) \`$CIRCUIT_HASH\`."
  echo "Phase 1: Hermez \`$PTAU_NAME\`, BLAKE2b \`$PTAU_BLAKE2B\`."
  echo "Phase 2: $contributions contributions, sealed by Bitcoin block $BEACON_HEIGHT (\`$BEACON_HASH\`), 2^$BEACON_ITERS iterations."
  echo
  echo "| File | SHA-256 |"
  echo "|---|---|"
  for f in transact.r1cs transact.wasm transact_pre_beacon.zkey transact_final.zkey transact_vk.json TransactVerifier.sol; do
    echo "| \`$f\` | \`$(sha256 "$FINAL/$f")\` |"
  done
  echo
  echo "vk_hash (dapp/evm-pool-zk-prover.js \`vkHash\`): \`$VK_HASH\`. Contribution hashes: \`transcript.json\`."
  echo
  echo "Verify:"
  echo
  echo '```sh'
  echo "npx snarkjs zkey verify transact.r1cs $PTAU_NAME transact_final.zkey"
  echo "npx snarkjs zkey export verificationkey transact_final.zkey vk.json && diff <(jq -S . vk.json) <(jq -S . transact_vk.json)"
  echo '```'
} > "$FINAL/README.md"
jq . "$FINAL/pin.json"

cat <<EOF

Final key ready in $FINAL. Next (operator; nothing below has run):

1. Pin the bundle on the local node and Filebase (the final zkey exceeds /finalize's inline cap,
   so it goes in by CID):
     bash $EVM_POOL_DIR/pin-final.sh
   Confirm transact_final.zkey resolves at ${zf_cid:-its CID}: curl -sI $GATEWAY/${zf_cid:-<cid>}

2. Seal the chain on the coordinator (\$CFG holds the X-Tacit-Init-Token header, as in ceremony-init.sh):
     curl --config "\$CFG" -sS -X POST \\
       -F zkey_cid=${zf_cid:-<final zkey CID>} \\
       -F beacon_block_hash=$BEACON_HASH \\
       -F beacon_block_height=$BEACON_HEIGHT \\
       -F beacon_iterations=$BEACON_ITERS \\
       -F expected_head_cid=${HEAD_CID:-<state.head_cid the head was downloaded from>} \\
       $WORKER/ceremony/$CIRCUIT_HASH/finalize

3. Install the artifacts:
     cp $SOL $REPO_DIR/contracts/src/TransactVerifier.sol
     mkdir -p $REPO_DIR/dapp/evm-pool && cp $FINAL/{pin.json,transact_vk.json,transact.wasm,transact_final.zkey} $REPO_DIR/dapp/evm-pool/
   The Secret Sats ETH tab (dapp/sats/eth.js) reads them there and opens once the pool has code; set each chain's
   deployBlock and keeper URL in its CHAINS after deploying. Keepers: EVM_POOL_ZKEY / _WASM / _VK at those URLs,
   EVM_POOL_ZKEY_SHA256 / _WASM_SHA256 from pin.json, EVM_POOL_VK_HASH = $VK_HASH.
EOF
