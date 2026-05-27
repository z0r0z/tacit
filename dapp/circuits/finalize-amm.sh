#!/usr/bin/env bash
# Finalize the tacit AMM ceremony in one shot.
#
# Runs the same finalize choreography as ./finalize.sh (drain, beacon,
# pre-flight verify, POST, audit-bundle staging) — but for the THREE AMM
# circuit chains running in parallel under shared pot18.
#
# Usage:
#   ./finalize-amm.sh [bitcoin_block_height]
#   ./finalize-amm.sh                          # auto-pick (tip - 12)
#   BUNDLE_ONLY=1 ./finalize-amm.sh           # regenerate bundle only
#
# What it does:
#   For each of the three circuits (amm_lp_add, amm_lp_remove, amm_swap_batch):
#     1. Reads CEREMONY_INIT_TOKEN
#     2. Resolves the worker's current head zkey CID for that circuit
#     3. Downloads + pre-flight verifies + beacons + POSTs /finalize
#     4. Exports the per-circuit verifying key
#   Then once all three are finalized:
#     5. Constructs the per-kind vk wrapper JSON
#     6. Stages the combined audit bundle (ceremony-bundle-amm/)
#
# The whole thing takes ~5–10 minutes total. The same Bitcoin block hash
# is used as the beacon for all three circuits so the AMM ceremony has one
# auditable anchor.
#
# Reads from dapp/circuits/amm/build/*.r1cs for the per-circuit hashes
# (sha256 of the r1cs file = circuit_hash that anchors each chain).

set -euo pipefail

# Dependency preflight — fail fast if any required tool is missing.
for _cmd in curl python3 npx xxd shasum awk du mktemp jq; do
  command -v "$_cmd" >/dev/null 2>&1 || {
    echo "ERROR: missing required dependency: $_cmd"
    echo "Install it before running finalize."
    exit 1
  }
done

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
else
  TIMEOUT_CMD=""
fi

cd "$(dirname "$0")"

# Single-instance mutex via mkdir.
mkdir -p build-amm
LOCKDIR="build-amm/.finalize.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "ERROR: another finalize-amm.sh appears to be running."
  echo "  Lockdir exists: $LOCKDIR"
  echo "  If you're certain no other instance is running, remove it:"
  echo "    rmdir $LOCKDIR"
  exit 1
fi
_cleanup_lockdir() { rmdir "$LOCKDIR" 2>/dev/null || true; }

# Track each circuit's chain-finalize state for the recovery hint trap.
CHAIN_FINALIZED_lp_add=0
CHAIN_FINALIZED_lp_remove=0
CHAIN_FINALIZED_swap_batch=0
on_exit() {
  local exit_code=$?
  _cleanup_lockdir
  [ -n "${CURL_CONFIG:-}" ] && rm -f "$CURL_CONFIG"
  if [ "$exit_code" = "0" ]; then return; fi
  echo
  echo "================================================================"
  echo "  finalize-amm.sh exited with status $exit_code"
  echo "================================================================"
  echo "  Per-circuit chain state (1 = finalized on worker, 0 = open):"
  echo "    amm_lp_add:      $CHAIN_FINALIZED_lp_add"
  echo "    amm_lp_remove:   $CHAIN_FINALIZED_lp_remove"
  echo "    amm_swap_batch:  $CHAIN_FINALIZED_swap_batch"
  echo
  if [ "$CHAIN_FINALIZED_lp_add" = "1" ] && \
     [ "$CHAIN_FINALIZED_lp_remove" = "1" ] && \
     [ "$CHAIN_FINALIZED_swap_batch" = "1" ]; then
    echo "  All three chains are FINALIZED on the worker; only the bundle"
    echo "  generation failed. Recover with:"
    echo "      BUNDLE_ONLY=1 $0"
  else
    echo "  Some chains were NOT finalized. Inspect state per circuit:"
    for c in amm_lp_add amm_lp_remove amm_swap_batch; do
      hash=$(_circuit_hash "$c" 2>/dev/null || echo "?")
      echo "      $c (hash=$hash):"
      echo "        $WORKER/ceremony/$hash"
    done
  fi
}
trap 'on_exit' EXIT

# --- args + env ---
BLOCK_HEIGHT="${1:-}"
WORKER="${WORKER:-https://tacit-pin.rosscampbell9.workers.dev}"
GATEWAY="${GATEWAY:-https://content.wrappr.wtf/ipfs}"
SNARKJS="${SNARKJS:-npx --yes snarkjs@0.7.6}"
BUNDLE_ONLY="${BUNDLE_ONLY:-0}"
MIN_QUIET_SECONDS="${MIN_QUIET_SECONDS:-60}"
MIN_CONTRIBUTIONS="${MIN_CONTRIBUTIONS:-1000}"

CIRCUITS=(amm_lp_add amm_lp_remove amm_swap_batch)
PTAU_NAME="${PTAU_NAME:-pot18_final.ptau}"

# Resolve r1cs path + circuit hash for a given circuit name. The r1cs file
# is the load-bearing artifact; circuit_hash = sha256(r1cs) anchors the
# ceremony chain on the worker. Sourced from amm/build/, NOT from
# amm/dev-zkey/ (those are dev artifacts under pot18 but with a single dev
# contribution + dev beacon — not production-safe).
_circuit_r1cs() { echo "amm/build/$1.r1cs"; }
_circuit_hash() {
  local r1cs
  r1cs=$(_circuit_r1cs "$1")
  if [ ! -f "$r1cs" ]; then
    echo "MISSING_R1CS_$1"
    return 1
  fi
  shasum -a 256 "$r1cs" | cut -d' ' -f1
}

# Pre-flight: all three r1cs files must exist (built by amm/build.sh).
for c in "${CIRCUITS[@]}"; do
  r1cs=$(_circuit_r1cs "$c")
  if [ ! -f "$r1cs" ]; then
    echo "ERROR: $r1cs not found."
    echo "  Run 'bash amm/build.sh' first to compile the AMM circuits."
    exit 1
  fi
done

if [ "$BUNDLE_ONLY" = "1" ]; then
  echo "==> BUNDLE_ONLY=1 — skipping chain finalize, regenerating audit bundle only"
fi

mkdir -p build-amm artifacts-amm ceremony-bundle-amm

# --- token (skipped in BUNDLE_ONLY since no /finalize POST) ---
if [ "$BUNDLE_ONLY" != "1" ]; then
  # Auto-pick a beacon block if none was provided. Defaults to (tip - 12)
  # for ≥12 confirmations.
  if [ -z "$BLOCK_HEIGHT" ]; then
    echo "==> No block height provided — auto-picking (tip - 12) for ≥12 confirmations"
    TIP=$(curl -sf --max-time 30 "https://mempool.space/api/blocks/tip/height" || echo "")
    if ! [[ "$TIP" =~ ^[0-9]+$ ]]; then
      echo "    ERROR: failed to fetch tip height from mempool.space"
      echo "    Pass an explicit block height: $0 <height>"
      exit 1
    fi
    BLOCK_HEIGHT=$((TIP - 12))
    echo "    tip=$TIP  →  beacon block height: $BLOCK_HEIGHT"
  fi
  if ! [[ "$BLOCK_HEIGHT" =~ ^[0-9]+$ ]]; then
    echo "block height must be a positive integer"; exit 1
  fi

  if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
    printf "Paste CEREMONY_INIT_TOKEN (from your password manager): "
    IFS= read -rs CEREMONY_INIT_TOKEN || true
    echo
  fi
  if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
    echo "no token provided"; exit 1
  fi
  CEREMONY_INIT_TOKEN="$(printf '%s' "$CEREMONY_INIT_TOKEN" | xargs)"
  export -n CEREMONY_INIT_TOKEN 2>/dev/null || true

  # curl --config tempfile (token never in argv).
  CURL_CONFIG=$(mktemp -t tacit-amm-finalize-XXXXXX)
  chmod 600 "$CURL_CONFIG"
  printf 'header = "X-Tacit-Init-Token: %s"\n' "$CEREMONY_INIT_TOKEN" > "$CURL_CONFIG"

  # Fetch + cross-check beacon block hash ONCE for the whole AMM ceremony.
  # The same block hash beacons all three pre-beacon zkeys (one auditable
  # anchor for the AMM event). mempool.space + blockstream.info must agree.
  echo
  echo "==> Fetching + cross-checking Bitcoin block $BLOCK_HEIGHT hash"
  H_MEMPOOL=$(curl -sf --max-time 30 "https://mempool.space/api/block-height/$BLOCK_HEIGHT" || echo "")
  H_BLOCKSTREAM=$(curl -sf --max-time 30 "https://blockstream.info/api/block-height/$BLOCK_HEIGHT" || echo "")
  H_MEMPOOL=$(echo "$H_MEMPOOL" | tr 'A-F' 'a-f')
  H_BLOCKSTREAM=$(echo "$H_BLOCKSTREAM" | tr 'A-F' 'a-f')
  if ! [[ "$H_MEMPOOL" =~ ^[0-9a-f]{64}$ ]]; then
    echo "    ERROR: mempool.space returned invalid hash: '$H_MEMPOOL'"
    exit 1
  fi
  if ! [[ "$H_BLOCKSTREAM" =~ ^[0-9a-f]{64}$ ]]; then
    echo "    ERROR: blockstream.info returned invalid hash: '$H_BLOCKSTREAM'"
    exit 1
  fi
  if [ "$H_MEMPOOL" != "$H_BLOCKSTREAM" ]; then
    echo "    ERROR: block hash mismatch between explorers!"
    echo "      mempool.space:    $H_MEMPOOL"
    echo "      blockstream.info: $H_BLOCKSTREAM"
    exit 1
  fi
  BTC_BLOCK_HASH="$H_MEMPOOL"
  TIP_NOW=$(curl -sf --max-time 30 "https://mempool.space/api/blocks/tip/height" || echo "")
  DEPTH=$((TIP_NOW - BLOCK_HEIGHT + 1))
  if (( DEPTH < 12 )); then
    echo "    ERROR: beacon block has only $DEPTH confirmations; minimum required is 12"
    exit 1
  fi
  echo "    block $BLOCK_HEIGHT: $BTC_BLOCK_HASH"
  echo "    confirmations: $DEPTH (≥12 required ✓; mempool.space ≡ blockstream.info ✓)"
fi

# ============================================================================
# Per-circuit finalize loop.
# ============================================================================
#
# For each circuit:
#   1. Fetch ceremony state (head_cid, r1cs_cid, ptau_cid, count)
#   2. Drain new contributions
#   3. Download head zkey
#   4. Apply beacon (same Bitcoin block hash across all three)
#   5. Pre-flight verify locally
#   6. POST /finalize
#   7. Export per-circuit vk
#
# State for each circuit is captured into circuit-prefixed variables so the
# bundle-staging phase can use them after the loop. CHAIN_FINALIZED_<c>=1
# is set immediately after each circuit's HTTP 200, so the on_exit trap
# can give accurate recovery hints.

finalize_one_circuit() {
  local c="$1"   # circuit name (amm_lp_add, etc.)
  local CIRCUIT_HASH
  CIRCUIT_HASH=$(_circuit_hash "$c")
  local r1cs_local
  r1cs_local=$(_circuit_r1cs "$c")

  echo
  echo "================================================================"
  echo "  Circuit: $c   (hash: $CIRCUIT_HASH)"
  echo "================================================================"

  echo "==> [1/7] Fetching ceremony state"
  local STATE HEAD_CID PTAU_CID R1CS_CID COUNT FINALIZED LAST_CONTRIBUTED_AT
  STATE=$(curl -sf --max-time 30 "$WORKER/ceremony/$CIRCUIT_HASH")
  HEAD_CID=$(echo "$STATE" | jq -r '.state.head_cid')
  PTAU_CID=$(echo "$STATE" | jq -r '.state.ptau_cid')
  R1CS_CID=$(echo "$STATE" | jq -r '.state.r1cs_cid')
  COUNT=$(echo "$STATE" | jq -r '.state.contribution_count')
  FINALIZED=$(echo "$STATE" | jq -r '.state.finalized // false')
  LAST_CONTRIBUTED_AT=$(echo "$STATE" | jq -r '.state.last_contributed_at // 0')
  echo "    contributions: $COUNT"
  echo "    head zkey:     $HEAD_CID"
  echo "    finalized:     $FINALIZED"

  if [ "$FINALIZED" = "true" ]; then
    if [ "$BUNDLE_ONLY" != "1" ]; then
      echo "    Already finalized. Skipping chain ops for $c."
    else
      echo "    Already finalized — using existing state for bundle."
    fi
    eval "CHAIN_FINALIZED_${c#amm_}=1"
  elif [ "$BUNDLE_ONLY" = "1" ]; then
    echo "    ERROR: BUNDLE_ONLY=1 but $c is NOT finalized (finalized=$FINALIZED)."
    echo "    Bundle-only mode requires all three circuits to be finalized."
    echo "    Either drop BUNDLE_ONLY=1 for a normal finalize, or finalize $c first."
    exit 1
  fi

  # Skip 2–6 for already-finalized circuits or BUNDLE_ONLY mode.
  if [ "$FINALIZED" != "true" ] && [ "$BUNDLE_ONLY" != "1" ]; then
    if (( COUNT < MIN_CONTRIBUTIONS )); then
      echo "    ERROR: contribution_count=$COUNT is below MIN_CONTRIBUTIONS=$MIN_CONTRIBUTIONS"
      echo "    Override with MIN_CONTRIBUTIONS=$COUNT $0 ..."
      exit 1
    fi

    local NOW IDLE_FOR
    NOW=$(date +%s)
    IDLE_FOR=$(( NOW - LAST_CONTRIBUTED_AT ))
    if (( IDLE_FOR < 0 )); then
      echo "    ERROR: IDLE_FOR=${IDLE_FOR}s (negative) — clock skew."
      exit 1
    fi
    if (( IDLE_FOR < MIN_QUIET_SECONDS )); then
      echo "    ERROR: last contribution was $IDLE_FOR seconds ago — too active."
      echo "    Override: MIN_QUIET_SECONDS=0 $0"
      exit 1
    fi
    echo "    quiet for: ${IDLE_FOR}s (≥${MIN_QUIET_SECONDS}s required ✓)"

    echo
    echo "==> [2/7] Drain (pause new contributes for 30min)"
    local DRAIN_RESP DRAIN_UNTIL
    DRAIN_RESP=$(curl -sf --max-time 30 -X POST \
      --config "$CURL_CONFIG" \
      -F "duration_seconds=1800" \
      "$WORKER/ceremony/$CIRCUIT_HASH/drain" || echo "")
    if [ -z "$DRAIN_RESP" ]; then
      echo "    ERROR: drain request failed. The worker may not have the /drain"
      echo "    endpoint deployed yet, or returned an HTTP error."
      exit 1
    fi
    DRAIN_UNTIL=$(echo "$DRAIN_RESP" | jq -r '.drain_until // empty')
    if [ -z "$DRAIN_UNTIL" ]; then
      echo "    ERROR: drain endpoint returned no drain_until field"
      echo "    Response: $DRAIN_RESP"
      exit 1
    fi
    echo "    drain set: contributions paused until unix=$DRAIN_UNTIL"
    sleep 8
    STATE=$(curl -sf --max-time 30 "$WORKER/ceremony/$CIRCUIT_HASH")
    HEAD_CID=$(echo "$STATE" | jq -r '.state.head_cid')
    COUNT=$(echo "$STATE" | jq -r '.state.contribution_count')
    echo "    post-drain: contributions=$COUNT, head=${HEAD_CID:0:12}…"

    echo
    echo "==> [3/7] Downloading head zkey from IPFS"
    # swap_batch is ~91 MB; 120s needs sustained 760 KB/s from the IPFS
    # gateway which can be marginal on a slow start. 600s matches pot18.
    curl -sLf --max-time 600 "$GATEWAY/$HEAD_CID" -o "build-amm/${c}_pre_beacon.zkey"
    if [ "$(head -c 4 "build-amm/${c}_pre_beacon.zkey" | xxd -p)" != "7a6b6579" ]; then
      echo "    ERROR: downloaded zkey missing zkey magic bytes"
      exit 1
    fi
    echo "    $(wc -c < "build-amm/${c}_pre_beacon.zkey") bytes ✓"

    echo
    echo "==> [4/7] Applying beacon ($BTC_BLOCK_HASH at height $BLOCK_HEIGHT)"
    rm -f "build-amm/${c}_final.zkey"
    if ! ( CEREMONY_INIT_TOKEN= $SNARKJS zkey beacon \
        "build-amm/${c}_pre_beacon.zkey" \
        "build-amm/${c}_final.zkey" \
        "$BTC_BLOCK_HASH" 10 \
        > "build-amm/${c}_beacon.log" 2>&1 ); then
      echo "    ✗ snarkjs zkey beacon failed for $c. See build-amm/${c}_beacon.log"
      exit 1
    fi
    if [ ! -s "build-amm/${c}_final.zkey" ]; then
      echo "    ✗ beacon produced empty output for $c"
      exit 1
    fi
    if [ "$(head -c 4 "build-amm/${c}_final.zkey" | xxd -p)" != "7a6b6579" ]; then
      echo "    ✗ beacon output has wrong magic bytes for $c"
      exit 1
    fi
    echo "    wrote build-amm/${c}_final.zkey"

    echo
    echo "==> [5/7] Pre-flight verifying beacon-applied zkey"
    # Download r1cs + ptau from IPFS (canonical artifacts the chain was
    # built on, not local rebuild from amm/build/).
    curl -sLf --max-time 60 "$GATEWAY/$R1CS_CID" -o "build-amm/${c}_chain.r1cs"
    if [ "$(head -c 4 "build-amm/${c}_chain.r1cs" | xxd -p)" != "72316373" ]; then
      echo "    ERROR: r1cs missing magic bytes"
      exit 1
    fi
    # pot18 download is large (~580 MB); cache by filename so we don't
    # re-download it for each of the three circuits.
    if [ ! -f "build-amm/$PTAU_NAME" ]; then
      echo "    Downloading $PTAU_NAME ($PTAU_CID)…"
      curl -sLf --max-time 600 "$GATEWAY/$PTAU_CID" -o "build-amm/$PTAU_NAME"
      if [ "$(head -c 4 "build-amm/$PTAU_NAME" | xxd -p)" != "70746175" ]; then
        echo "    ERROR: ptau missing magic bytes"
        exit 1
      fi
    fi
    if ! ( CEREMONY_INIT_TOKEN= ${TIMEOUT_CMD:+$TIMEOUT_CMD 900} $SNARKJS zkey verify \
        "build-amm/${c}_chain.r1cs" \
        "build-amm/$PTAU_NAME" \
        "build-amm/${c}_final.zkey" \
        > "build-amm/${c}_verify.log" 2>&1 ); then
      echo "    ✗ LOCAL VERIFY FAILED for $c. See build-amm/${c}_verify.log"
      exit 1
    fi
    echo "    ✓ ZKey Ok — beacon-applied $c verified against chain artifacts"

    # Pre-POST size sanity — catch corrupt-large downloads before
    # wasting the multi-second upload. Worker hard-rejects > 100 MB.
    local FINAL_BYTES
    FINAL_BYTES=$(wc -c < "build-amm/${c}_final.zkey" | awk '{print $1}')
    if (( FINAL_BYTES > 100 * 1024 * 1024 )); then
      echo "    ERROR: final zkey is $FINAL_BYTES bytes; worker hard-limit is 100 MiB."
      echo "    Beacon-applied zkey is unexpectedly large — likely corrupt input."
      echo "    Inspect build-amm/${c}_final.zkey before retrying."
      exit 1
    fi

    echo
    echo "==> [6/7] POSTing to /finalize"
    local HTTP_CODE
    # Large zkeys (swap_batch ~91 MB) exceed Cloudflare Workers' resource
    # limits when piped through the worker to Pinata (CF error 1102). For
    # files > 50 MB, pre-pin to Pinata directly via the upload-token
    # presigned URL, then send zkey_cid to /finalize instead of the file.
    local ZKEY_CID_ARG=""
    if (( FINAL_BYTES > 50 * 1024 * 1024 )); then
      echo "    zkey is ${FINAL_BYTES} bytes — pre-pinning to Pinata directly"
      local TOK_RESP UPLOAD_URL PIN_RESP PRE_PIN_CID
      TOK_RESP=$(curl -sf --max-time 30 -X POST \
        -H "Content-Type: application/json" -d '{}' \
        "$WORKER/ceremony/$CIRCUIT_HASH/upload-token" || echo "")
      if [ -z "$TOK_RESP" ]; then
        echo "    ERROR: upload-token request failed"; exit 1
      fi
      UPLOAD_URL=$(echo "$TOK_RESP" | jq -r '.upload_url // empty')
      if [ -z "$UPLOAD_URL" ]; then
        echo "    ERROR: upload-token returned no upload_url"
        echo "    Response: $TOK_RESP"; exit 1
      fi
      PIN_RESP=$(curl -sf --max-time 600 -X POST \
        "$UPLOAD_URL" \
        -F "file=@build-amm/${c}_final.zkey" || echo "")
      if [ -z "$PIN_RESP" ]; then
        echo "    ERROR: direct Pinata upload failed"; exit 1
      fi
      PRE_PIN_CID=$(echo "$PIN_RESP" | jq -r '.data.cid // .cid // .IpfsHash // empty')
      if [ -z "$PRE_PIN_CID" ]; then
        echo "    ERROR: Pinata returned no CID"
        echo "    Response: $PIN_RESP"; exit 1
      fi
      echo "    pre-pinned: $PRE_PIN_CID"
      ZKEY_CID_ARG="-F zkey_cid=$PRE_PIN_CID"
    fi

    if [ -n "$ZKEY_CID_ARG" ]; then
      HTTP_CODE=$(curl -s -o "build-amm/${c}_finalize_response.json" -w "%{http_code}" \
        --max-time 600 \
        --config "$CURL_CONFIG" \
        -X POST \
        $ZKEY_CID_ARG \
        -F "beacon_block_hash=$BTC_BLOCK_HASH" \
        -F "beacon_block_height=$BLOCK_HEIGHT" \
        -F "beacon_iterations=10" \
        -F "expected_head_cid=$HEAD_CID" \
        "$WORKER/ceremony/$CIRCUIT_HASH/finalize")
    else
      HTTP_CODE=$(curl -s -o "build-amm/${c}_finalize_response.json" -w "%{http_code}" \
        --max-time 600 \
        --config "$CURL_CONFIG" \
        -X POST \
        -F "zkey=@build-amm/${c}_final.zkey" \
        -F "beacon_block_hash=$BTC_BLOCK_HASH" \
        -F "beacon_block_height=$BLOCK_HEIGHT" \
        -F "beacon_iterations=10" \
        -F "expected_head_cid=$HEAD_CID" \
        "$WORKER/ceremony/$CIRCUIT_HASH/finalize")
    fi
    if [ "$HTTP_CODE" = "409" ]; then
      echo "    ✗ Finalize race lost for $c. Re-run to pick up new head."
      exit 1
    fi
    if [ "$HTTP_CODE" != "200" ]; then
      echo "    ✗ Finalize POST failed with HTTP $HTTP_CODE for $c"
      cat "build-amm/${c}_finalize_response.json" 2>/dev/null
      exit 1
    fi
    eval "CHAIN_FINALIZED_${c#amm_}=1"
    echo "    ✓ Chain $c finalized"
  fi

  echo
  echo "==> [7/7] Exporting verifying key for $c"
  # If we skipped the beacon path (already finalized or BUNDLE_ONLY), pull
  # the finalized zkey + chain artifacts from IPFS, recover the pre-beacon
  # zkey, and re-verify. Mirrors mixer finalize.sh's BUNDLE_ONLY recovery.
  if [ ! -f "build-amm/${c}_final.zkey" ]; then
    local FRESH_STATE FINAL_CID
    FRESH_STATE=$(curl -sf --max-time 30 "$WORKER/ceremony/$CIRCUIT_HASH")
    FINAL_CID=$(echo "$FRESH_STATE" | jq -r '.state.head_cid')
    local DL_R1CS_CID DL_PTAU_CID
    DL_R1CS_CID=$(echo "$FRESH_STATE" | jq -r '.state.r1cs_cid')
    DL_PTAU_CID=$(echo "$FRESH_STATE" | jq -r '.state.ptau_cid')
    # Recover beacon info for BUNDLE_ONLY README (only set from first circuit).
    if [ -z "${BTC_BLOCK_HASH:-}" ]; then
      BTC_BLOCK_HASH=$(echo "$FRESH_STATE" | jq -r '.state.beacon_block_hash // empty')
      BLOCK_HEIGHT=$(echo "$FRESH_STATE" | jq -r '.state.beacon_block_height // empty')
    fi
    curl -sLf --max-time 600 "$GATEWAY/$FINAL_CID" -o "build-amm/${c}_final.zkey"
    if [ "$(head -c 4 "build-amm/${c}_final.zkey" | xxd -p)" != "7a6b6579" ]; then
      echo "    ERROR: downloaded final zkey missing magic"
      exit 1
    fi
    # Download chain r1cs if not present (needed for bundle + re-verify).
    if [ ! -f "build-amm/${c}_chain.r1cs" ]; then
      curl -sLf --max-time 60 "$GATEWAY/$DL_R1CS_CID" -o "build-amm/${c}_chain.r1cs"
      if [ "$(head -c 4 "build-amm/${c}_chain.r1cs" | xxd -p)" != "72316373" ]; then
        echo "    ERROR: r1cs missing magic bytes"; exit 1
      fi
    fi
    # Download pot18 if not present (needed for bundle + re-verify).
    if [ ! -f "build-amm/$PTAU_NAME" ]; then
      echo "    Downloading $PTAU_NAME ($DL_PTAU_CID)…"
      curl -sLf --max-time 600 "$GATEWAY/$DL_PTAU_CID" -o "build-amm/$PTAU_NAME"
      if [ "$(head -c 4 "build-amm/$PTAU_NAME" | xxd -p)" != "70746175" ]; then
        echo "    ERROR: ptau missing magic bytes"; exit 1
      fi
    fi
    # Recover pre-beacon zkey from the beacon attestation's prev_cid.
    echo "    Recovering pre-beacon zkey via beacon attestation's prev_cid…"
    local PRE_BEACON_CID
    PRE_BEACON_CID=$(curl -sf --max-time 30 -A "tacit-amm-finalize/1.0" \
      "${WORKER}/ceremony/${CIRCUIT_HASH}/attestations?limit=20" \
      | jq -r '[.attestations[] | select(.is_beacon == true)][0].prev_cid // empty')
    if [ -n "$PRE_BEACON_CID" ]; then
      curl -sLf --max-time 600 "$GATEWAY/$PRE_BEACON_CID" -o "build-amm/${c}_pre_beacon.zkey"
      if [ "$(head -c 4 "build-amm/${c}_pre_beacon.zkey" | xxd -p)" = "7a6b6579" ]; then
        echo "    pre-beacon zkey recovered: ${PRE_BEACON_CID:0:16}… ($(wc -c < "build-amm/${c}_pre_beacon.zkey") bytes)"
      else
        echo "    WARN: pre-beacon zkey download failed magic check; bundle will omit it."
        rm -f "build-amm/${c}_pre_beacon.zkey"
      fi
    else
      echo "    WARN: couldn't find beacon record's prev_cid. Bundle will omit pre-beacon zkey."
    fi
    # Re-verify downloaded final zkey against chain artifacts.
    echo "    Re-verifying downloaded final zkey vs chain r1cs+ptau…"
    if ! ( CEREMONY_INIT_TOKEN= ${TIMEOUT_CMD:+$TIMEOUT_CMD 900} $SNARKJS zkey verify \
        "build-amm/${c}_chain.r1cs" \
        "build-amm/$PTAU_NAME" \
        "build-amm/${c}_final.zkey" \
        > "build-amm/${c}_verify.log" 2>&1 ); then
      echo "    ✗ Downloaded final zkey does NOT verify. Bundle aborted for $c."
      echo "      Try a different gateway: GATEWAY=https://ipfs.io/ipfs $0"
      exit 1
    fi
    echo "    ✓ Final zkey re-verified against chain"
  fi
  if ! ( CEREMONY_INIT_TOKEN= $SNARKJS zkey export verificationkey \
      "build-amm/${c}_final.zkey" \
      "artifacts-amm/${c}_vk.json" \
      > "build-amm/${c}_export_vk.log" 2>&1 ); then
    echo "    ✗ vk export failed. See build-amm/${c}_export_vk.log"
    exit 1
  fi
  local N_PUBLIC
  N_PUBLIC=$(jq -r '.nPublic' "artifacts-amm/${c}_vk.json")
  echo "    artifacts-amm/${c}_vk.json (nPublic=$N_PUBLIC)"
}

for c in "${CIRCUITS[@]}"; do
  finalize_one_circuit "$c"
done

# ============================================================================
# Bundle staging.
# ============================================================================

echo
echo "================================================================"
echo "  Constructing per-kind vk wrapper + ceremony bundle"
echo "================================================================"

# Build the wrapper JSON. Key order is the canonical lex-ascending
# (lp_add, lp_remove, swap_batch); sort_keys + compact separators so the
# CID is deterministic across machines.
python3 <<'PY'
import json
wrapper = {
    "schema":     "tacit-amm-vk-wrapper-v1",
    "lp_add":     json.load(open("artifacts-amm/amm_lp_add_vk.json")),
    "lp_remove":  json.load(open("artifacts-amm/amm_lp_remove_vk.json")),
    "swap_batch": json.load(open("artifacts-amm/amm_swap_batch_vk.json")),
}
with open("artifacts-amm/vk.json", "w") as f:
    json.dump(wrapper, f, sort_keys=True, separators=(",", ":"))
print("    wrote artifacts-amm/vk.json (canonical wrapper)")
PY

# Derive vk_cid from the wrapper bytes (CIDv1, raw codec, sha2-256).
# Match tests/amm-validator.mjs deriveVkCid() byte-for-byte.
VK_CID=$(python3 <<'PY'
import hashlib, base64
data = open("artifacts-amm/vk.json", "rb").read()
digest = hashlib.sha256(data).digest()
# CIDv1 (0x01) + raw codec (0x55) + multihash: sha2-256 (0x12) + length (0x20) + digest
cid_bytes = bytes([0x01, 0x55, 0x12, 0x20]) + digest
# base32 lowercase no-padding with "b" multibase prefix
alphabet = "abcdefghijklmnopqrstuvwxyz234567"
buf, bits, out = 0, 0, ""
for b in cid_bytes:
    buf = (buf << 8) | b
    bits += 8
    while bits >= 5:
        bits -= 5
        out += alphabet[(buf >> bits) & 0x1f]
if bits > 0:
    out += alphabet[(buf << (5 - bits)) & 0x1f]
print("b" + out)
PY
)
echo "    canonical vk_cid: $VK_CID"

# Stage the bundle directory.
mkdir -p ceremony-bundle-amm/circuits ceremony-bundle-amm/zkeys ceremony-bundle-amm/attestations

for c in "${CIRCUITS[@]}"; do
  cp "build-amm/${c}_chain.r1cs" "ceremony-bundle-amm/circuits/${c}.r1cs" 2>/dev/null || \
    cp "amm/build/${c}.r1cs" "ceremony-bundle-amm/circuits/${c}.r1cs"
  cp "build-amm/${c}_final.zkey" "ceremony-bundle-amm/zkeys/${c}_final.zkey"
  [ -f "build-amm/${c}_pre_beacon.zkey" ] && \
    cp "build-amm/${c}_pre_beacon.zkey" "ceremony-bundle-amm/zkeys/${c}_pre_beacon.zkey"
done

cp "build-amm/$PTAU_NAME" "ceremony-bundle-amm/$PTAU_NAME"
cp "artifacts-amm/vk.json" "ceremony-bundle-amm/vk.json"
for c in "${CIRCUITS[@]}"; do
  cp "artifacts-amm/${c}_vk.json" "ceremony-bundle-amm/${c}_vk.json"
done

# Paginate per-circuit attestations.
echo "    Paginating attestations for each circuit…"
for c in "${CIRCUITS[@]}"; do
  CIRCUIT_HASH=$(_circuit_hash "$c")
  mkdir -p "ceremony-bundle-amm/attestations/$c"

  : > "build-amm/${c}_attest_pages.jsonl"
  cursor=""
  pages=0
  total=0
  while [ $pages -lt 200 ]; do
    pages=$((pages + 1))
    page=""
    for try in 1 2 3 4 5; do
      page=$(curl -sf --max-time 120 -A "tacit-amm-finalize/1.0" \
        "${WORKER}/ceremony/${CIRCUIT_HASH}/attestations?limit=800&cursor=${cursor}" || echo "")
      if [ -z "$page" ]; then
        sleep $((try * 2))
        continue
      fi
      if echo "$page" | jq -e . >/dev/null 2>&1; then
        break
      fi
      sleep $((try * 2))
      page=""
    done
    if [ -z "$page" ]; then
      echo "    ERROR: $c page $pages failed after 5 retries"
      exit 1
    fi
    echo "$page" >> "build-amm/${c}_attest_pages.jsonl"
    page_count=$(echo "$page" | jq -r '.attestations | length')
    list_complete=$(echo "$page" | jq -r '.list_complete // true')
    next_cursor=$(echo "$page" | jq -r '.cursor // ""')
    total=$((total + page_count))
    if [ "$list_complete" = "true" ]; then break; fi
    if [ -z "$next_cursor" ] || [ "$next_cursor" = "null" ]; then break; fi
    cursor=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$next_cursor")
  done

  # Fetch finalized state for beacon-record synthesis fallback.
  # KV list() can lag behind get() (CF eventual consistency), so the
  # beacon attestation record may be invisible to pagination even though
  # the ceremony is finalized and the record exists. If the paginated
  # records don't contain an is_beacon record, synthesize one from the
  # finalized state and the last user contribution's CID.
  CIRCUIT_STATE=$(curl -sf --max-time 30 "$WORKER/ceremony/$CIRCUIT_HASH")

  # Merge + chain-walk for this circuit.
  python3 <<PY
import json, sys
out = []
with open("build-amm/${c}_attest_pages.jsonl") as f:
    for line in f:
        out.extend(json.loads(line).get("attestations", []))
out.sort(key=lambda a: (a.get("index", 0), a.get("cid", "")))

beacon = next((r for r in out if r.get("is_beacon")), None)
if not beacon:
    state_json = '''${CIRCUIT_STATE}'''
    try:
        st = json.loads(state_json).get("state", {})
    except:
        st = {}
    if st.get("finalized") and st.get("head_cid") and st.get("beacon_block_hash"):
        last_user = max((r for r in out if r.get("cid")), key=lambda r: r.get("index", 0), default=None)
        prev_cid = last_user["cid"] if last_user else ""
        beacon = {
            "index": st.get("contribution_count", 0),
            "cid": st["head_cid"],
            "contributor_name": "beacon",
            "contribution_hash": st["beacon_block_hash"],
            "contributed_at": st.get("finalized_at", 0),
            "prev_cid": prev_cid,
            "is_beacon": True,
            "beacon_block_height": st.get("beacon_block_height"),
            "beacon_iterations": st.get("beacon_iterations", 10),
        }
        out.append(beacon)
        out.sort(key=lambda a: (a.get("index", 0), a.get("cid", "")))
        sys.stderr.write(f"    (synthesized beacon record from finalized state: idx={beacon['index']} cid={beacon['cid'][:16]}…)\n")

by_cid = {r["cid"]: r for r in out if r.get("cid")}
beacon = next((r for r in out if r.get("is_beacon")), None)
chain, warns = [], []
if beacon:
    cur, seen = beacon, set()
    while cur is not None:
        cid = cur.get("cid")
        if cid in seen:
            warns.append(f"chain cycle at cid={cid}")
            break
        seen.add(cid)
        chain.append(cur)
        prev = cur.get("prev_cid", "")
        if not prev: break
        cur = by_cid.get(prev)
        if cur is None:
            warns.append(f"chain break: prev_cid={prev} not in bundle")
            break
    chain.reverse()
else:
    warns.append("no beacon record found")

result = {
    "circuit": "${c}",
    "attestations": out,
    "count": len(out),
    "canonical_chain_length": len(chain),
    "canonical_chain_cids": [r.get("cid") for r in chain],
    "chain_walk_warnings": warns,
}
with open("ceremony-bundle-amm/attestations/${c}/attestations.json", "w") as g:
    json.dump(result, g, indent=2)
PY

  # Gate on chain warnings.
  warn_count=$(jq -r '.chain_walk_warnings | length' "ceremony-bundle-amm/attestations/$c/attestations.json")
  if [ "$warn_count" != "0" ]; then
    echo "    ✗ $c canonical chain has $warn_count warning(s):"
    jq -r '.chain_walk_warnings[]' "ceremony-bundle-amm/attestations/$c/attestations.json" | sed 's/^/      /'
    echo "    Refusing to ship a bundle with broken prev_cid links for $c."
    exit 1
  fi
  echo "    ✓ $c chain walks cleanly ($total records)"
done

# Hash everything for the README's audit table.
PTAU_SHA256=$(shasum -a 256 "ceremony-bundle-amm/$PTAU_NAME" | cut -d' ' -f1)
PTAU_BLAKE2B=$(openssl dgst -blake2b512 "ceremony-bundle-amm/$PTAU_NAME" 2>/dev/null | awk '{print $NF}' || true)
VK_WRAPPER_SHA256=$(shasum -a 256 ceremony-bundle-amm/vk.json | cut -d' ' -f1)

# Bundle README.
{
  echo "# Tacit AMM ceremony — three circuits, one bundle"
  echo
  echo "Beacon: Bitcoin block ${BLOCK_HEIGHT:-?} (\`${BTC_BLOCK_HASH:-?}\`), 10 MiMC iterations applied to all three pre-beacon zkeys."
  echo
  echo "## vk wrapper (what pools pin via \`vk_cid\`)"
  echo
  echo "- Canonical CID: \`$VK_CID\` (CIDv1 raw codec, sha2-256)"
  echo "- sha256: \`$VK_WRAPPER_SHA256\`"
  echo "- Shape:"
  echo '  ```json'
  echo '  { "lp_add": { ... }, "lp_remove": { ... }, "swap_batch": { ... } }'
  echo '  ```'
  echo
  echo "## Phase 1 (Powers-of-Tau)"
  echo
  echo "Polygon Hermez \`$PTAU_NAME\` (262K constraint ceiling)."
  echo "- sha256:  \`$PTAU_SHA256\`"
  if [ -n "$PTAU_BLAKE2B" ]; then
    echo "- blake2b: \`$PTAU_BLAKE2B\`"
  fi
  echo
  echo "## Per-circuit"
  echo
  for c in "${CIRCUITS[@]}"; do
    CIRCUIT_HASH=$(_circuit_hash "$c")
    FINAL_SHA=$(shasum -a 256 "ceremony-bundle-amm/zkeys/${c}_final.zkey" | cut -d' ' -f1)
    R1CS_SHA=$(shasum -a 256 "ceremony-bundle-amm/circuits/${c}.r1cs" | cut -d' ' -f1)
    VK_SHA=$(shasum -a 256 "ceremony-bundle-amm/${c}_vk.json" | cut -d' ' -f1)
    AT_COUNT=$(jq -r '.count' "ceremony-bundle-amm/attestations/${c}/attestations.json")
    echo "### \`$c\`"
    echo
    echo "- circuit_hash (sha256 of r1cs): \`$CIRCUIT_HASH\`"
    echo "- contributions: $AT_COUNT records (see \`attestations/${c}/attestations.json\`)"
    echo "- zkey sha256: \`$FINAL_SHA\`"
    echo "- r1cs sha256: \`$R1CS_SHA\`"
    echo "- vk sha256:   \`$VK_SHA\`"
    echo
  done
  echo "## Verify locally"
  echo
  echo "For each circuit, snarkjs must accept the final zkey under the chain artifacts:"
  echo
  echo '```bash'
  for c in "${CIRCUITS[@]}"; do
    echo "npx snarkjs zkey verify circuits/${c}.r1cs $PTAU_NAME zkeys/${c}_final.zkey"
  done
  echo '```'
} > ceremony-bundle-amm/README.md

echo
echo "================================================================"
echo "  ✓ AMM ceremony bundle ready"
echo "================================================================"
echo
echo "  Bundle directory:  ceremony-bundle-amm/  ($(du -sh ceremony-bundle-amm | cut -f1))"
echo "  Canonical vk_cid:  $VK_CID"
echo
echo "  Next steps:"
echo "    1. Pin the bundle to IPFS:"
echo "         ./pin-bundle.sh ceremony-bundle-amm"
echo "       Record the directory CID as AMM_CEREMONY_CID."
echo
echo "    2. Pin vk.json separately as a raw blob to derive AMM_VK_CID:"
echo "         ipfs add --cid-version=1 --raw-leaves ceremony-bundle-amm/vk.json"
echo "       Confirm the returned CID equals $VK_CID."
echo
echo "    3. Hardcode both CIDs in the dapp:"
echo "         dapp/tacit.js:  CANONICAL_AMM_VK_CID, CANONICAL_AMM_CEREMONY_CID"
echo
