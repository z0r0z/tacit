#!/bin/bash
set -uo pipefail
# Confidential settle loop — the easy way to run your own relayer, no GPU or Rust toolchain
# required. Polls the same job queue as ops/scripts/confidential-settle-loop.sh
# (/confidential/job + /confidential/ack, BOX_TOKEN bearer auth), but every op is proven by running
# the matching prebuilt prover-bins-<N> binary directly with MODE=groth16 against the Succinct
# NETWORK prover — no per-job compile, no local GPU, no native-gnark build. A plain CPU box with
# ~2 vCPU / 4GB RAM is enough; proving happens on Succinct's network, not locally.
#
# This can run standing alongside Tacit's own relay (or anyone else's) as extra capacity on the
# same queue — jobs are claimed atomically-enough (see confidential-settle.js's claim-nonce) that
# more than one poller on one queue is safe, not just tolerated.
#
# Setup: see setup-relay-lite.sh (installs jq + foundry, downloads the binaries this expects at
# BIN_DIR). Then run this with the env below.
#
# Env (required unless noted):
#   WORKER_BASE   the relay's base URL (e.g. https://api.tacit.finance)
#   BOX_TOKEN     bearer token for the box-only /confidential/job + /confidential/ack routes
#   POOL_ADDR     the deployed ConfidentialPool address
#   RPC_URL       an Ethereum RPC endpoint (settle() broadcast)
#   SETTLE_KEY    a funded EVM private key that pays gas for settle() — 0x-hex
#   NETWORK_PRIVATE_KEY   your Succinct network prover key (costs $PROVE per proof)
#   EXPECT_VKEY   the pool's currently pinned program_vkey (sp1/confidential/elf-vkey-pin.json)
#   POLL_SECS (default 15), BIN_DIR (default ./bin), WORK_DIR (default ./work)
#   NETWORK_RPC_URL (default https://rpc.mainnet.succinct.xyz — the auction endpoint; the Reserved
#     endpoint returns Unimplemented for every network prove call, so don't point this at it)

WORKER_BASE="${WORKER_BASE:?set WORKER_BASE}"
BOX_TOKEN="${BOX_TOKEN:?set BOX_TOKEN}"
POOL_ADDR="${POOL_ADDR:?set POOL_ADDR}"
RPC_URL="${RPC_URL:?set RPC_URL}"
SETTLE_KEY="${SETTLE_KEY:?set SETTLE_KEY}"
NETWORK_PRIVATE_KEY="${NETWORK_PRIVATE_KEY:?set NETWORK_PRIVATE_KEY}"
EXPECT_VKEY="${EXPECT_VKEY:?set EXPECT_VKEY}"
NETWORK_RPC_URL="${NETWORK_RPC_URL:-https://rpc.mainnet.succinct.xyz}"
POLL_SECS="${POLL_SECS:-15}"
BIN_DIR="${BIN_DIR:-$(cd "$(dirname "$0")" && pwd)/bin}"
WORK_DIR="${WORK_DIR:-$(cd "$(dirname "$0")" && pwd)/work}"
mkdir -p "$WORK_DIR"
export PATH="$PATH:$HOME/.foundry/bin"

log() { echo "[settle-lite $(date -u +%H:%M:%S)] $*"; }

ack() { # jobId txHash errMsg
  local payload
  if [ -n "${3:-}" ]; then payload="{\"jobId\":\"$1\",\"error\":\"$3\"}"
  else payload="{\"jobId\":\"$1\",\"txHash\":\"${2:-}\"}"; fi
  curl -fsS -X POST "$WORKER_BASE/confidential/ack" -H "authorization: Bearer $BOX_TOKEN" \
    -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1 \
    || log "ack failed (worker reclaims the stale claim after its TTL)"
}

# type → prebuilt binary name (kept in sync with worker-relay/src/lib/prover.js's PEROP map and
# ops/scripts/confidential-settle-loop.sh's harness_for()).
bin_for() { case "$1" in
  wrap) echo "exec-wrap" ;;
  transfer) echo "exec-prove" ;;
  batchtransfer) echo "exec-batchtransfer" ;;
  wraplp) echo "exec-wraplp" ;;
  wrapswap) echo "exec-wrapswap" ;;
  swap) echo "exec-swap" ;;
  unwrap) echo "exec-unwrap" ;;
  lp) echo "exec-lp" ;;
  lpremove) echo "exec-lpremove" ;;
  wraptransfer) echo "exec-wraptransfer" ;;
  sendunwrap) echo "exec-sendunwrap" ;;
  otc) echo "exec-otc" ;;
  route) echo "exec-route" ;;
  bid) echo "exec-bid" ;;
  bridgeburn) echo "exec-bridgeburn" ;;
  bridgemint) echo "exec-bridgemint" ;;
  cbtcmint) echo "exec-cbtcmint" ;;
  cdpmint) echo "exec-cdpmint" ;;
  cdpclose) echo "exec-cdpclose" ;;
  stealthlock) echo "exec-stealthlock" ;;
  stealthclaim) echo "exec-stealthclaim" ;;
  stealthrefund) echo "exec-stealthrefund" ;;
  stealthlockbatch) echo "exec-stealthlockbatch" ;;
  bridgestealthmint) echo "exec-bridgestealthmint" ;;
  *) echo "" ;; esac; }

log "starting — worker=$WORKER_BASE pool=$POOL_ADDR poll=${POLL_SECS}s bin_dir=$BIN_DIR"
while true; do
  JOB=$(curl -fsS "$WORKER_BASE/confidential/job" -H "authorization: Bearer $BOX_TOKEN" 2>/dev/null || echo '{}')
  JID=$(echo "$JOB" | jq -r '.jobId // empty')
  if [ -z "$JID" ]; then sleep "$POLL_SECS"; continue; fi

  TYPE=$(echo "$JOB" | jq -r '.type')
  MODE_JOB=$(echo "$JOB" | jq -r '.mode // "settle"')
  BIN=$(bin_for "$TYPE")
  if [ -z "$BIN" ] || [ ! -x "$BIN_DIR/$BIN" ]; then
    log "job $JID type=$TYPE has no binary at $BIN_DIR/$BIN — acking failed"; ack "$JID" "" "no binary for type $TYPE"; continue
  fi

  OP_FILE="$WORK_DIR/${JID}_op.json"
  echo "$JOB" | jq -c '.op' > "$OP_FILE"
  MEMOS=$(echo "$JOB" | jq -r '(.memos // []) | "[" + join(",") + "]"')
  log "job $JID type=$TYPE — proving (network)..."

  rm -f "$WORK_DIR/public_values.hex" "$WORK_DIR/proof_bytes.hex"
  ( cd "$WORK_DIR" && OP_FILE="$OP_FILE" MODE=groth16 EXPECT_VKEY="$EXPECT_VKEY" \
      NETWORK_PRIVATE_KEY="$NETWORK_PRIVATE_KEY" NETWORK_RPC_URL="$NETWORK_RPC_URL" \
      "$BIN_DIR/$BIN" >"$WORK_DIR/${JID}_prove.log" 2>&1 )
  PV_FILE="$WORK_DIR/public_values.hex"; PROOF_FILE="$WORK_DIR/proof_bytes.hex"
  if [ ! -s "$PV_FILE" ] || [ ! -s "$PROOF_FILE" ] || ! grep -q "WROTE public_values.hex" "$WORK_DIR/${JID}_prove.log"; then
    log "prove failed (see $WORK_DIR/${JID}_prove.log) — acking failed"; ack "$JID" "" "prove failed"; continue
  fi
  PV="0x$(cat "$PV_FILE")"
  PROOF="0x$(cat "$PROOF_FILE")"
  rm -f "$OP_FILE" "$PV_FILE" "$PROOF_FILE"

  if [ "$MODE_JOB" = "prove" ]; then
    curl -fsS -X POST "$WORKER_BASE/confidential/ack" -H "authorization: Bearer $BOX_TOKEN" \
      -H 'content-type: application/json' \
      -d "$(jq -nc --arg jobId "$JID" --arg publicValues "$PV" --arg proof "$PROOF" '{jobId:$jobId,publicValues:$publicValues,proof:$proof}')" >/dev/null 2>&1 \
      || log "ack failed (worker reclaims the stale claim after its TTL)"
    log "proved-only: job=$JID"
    continue
  fi

  TX=$(cast send "$POOL_ADDR" 'settle(bytes,bytes,bytes[])' "$PV" "$PROOF" "$MEMOS" \
    --rpc-url "$RPC_URL" --private-key "$SETTLE_KEY" --json 2>"$WORK_DIR/${JID}_send.log" \
    | jq -r '.transactionHash // empty')
  if [ -z "$TX" ]; then
    log "settle reverted/failed (see $WORK_DIR/${JID}_send.log) — acking failed"; ack "$JID" "" "settle reverted"; continue
  fi
  log "settled: job=$JID type=$TYPE tx=$TX"
  ack "$JID" "$TX"
done
