#!/bin/bash
set -uo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# Confidential settle loop — runs on the self-hosted GPU prover box.
#
# Turns the live ConfidentialPool into a working deposit→swap/LP/transfer→withdraw
# loop: polls the worker for the next user-submitted confidential op, GPU
# Groth16-proves the settle guest, submits ConfidentialPool.settle(pv, proof,
# memos) on-chain with a relay key, then acks. The relay key + RPC stay on the
# box (self-hosted — no third-party prover, no PROVE token). Outbound-only: works
# behind vast NAT. settle is permissionless — the box only relays a proof the
# contract independently verifies against PROGRAM_VKEY; it never holds user funds.
#
# Each op type maps to the op-specific harness already proven in the real-proof
# suite (swap→exec-swap, route→exec-route, lp→exec-lp, transfer→exec-prove) — the box just feeds the
# job's op JSON to that harness's fixture path. One op per settle (batching = later).
#
# A fresh sp1-gpu-server per job (a 2nd groth16 on a warm server OOMs). On a settle
# revert (e.g. a lost ack re-serving an already-applied op — the nullifier is spent)
# the job is acked as failed; submit-dedup keeps a resubmit from storming.
#
# Env (required unless noted):
#   WORKER_BASE   worker base URL (/confidential/job, /confidential/ack)
#   BOX_TOKEN     Bearer token = worker CONFIDENTIAL_BOX_TOKEN/DEBUG_TOKEN
#   POOL_ADDR     deployed ConfidentialPool address
#   RPC_URL       Ethereum RPC
#   SETTLE_KEY    funded key paying for settle (0x-hex)
#   POLL_SECS     idle poll interval                (default 20)
#   CXFER_DIR     box work dir                      (default /root/work/cxfer)
#
# Setup once: the harnesses staged in $CXFER/harnesses/ (exec-swap.rs, exec-lp.rs,
# exec-prove.rs), the guest ELF built. Requires cargo + SP1 toolchain, foundry
# (cast), jq, curl.
# ─────────────────────────────────────────────────────────────────────────────

source ~/.cargo/env 2>/dev/null || true
export PATH="$PATH:/root/.sp1/bin:/root/.foundry/bin"

WORKER_BASE="${WORKER_BASE:?set WORKER_BASE}"
BOX_TOKEN="${BOX_TOKEN:?set BOX_TOKEN}"
POOL_ADDR="${POOL_ADDR:?set POOL_ADDR}"
RPC_URL="${RPC_URL:?set RPC_URL}"
SETTLE_KEY="${SETTLE_KEY:?set SETTLE_KEY}"
POLL_SECS="${POLL_SECS:-20}"
CXFER="${CXFER_DIR:-/root/work/cxfer}"

log() { echo "[conf-settle $(date -u +%H:%M:%S)] $*"; }

ack() { # jobId  txHash  errMsg
  local payload
  if [ -n "${3:-}" ]; then payload="{\"jobId\":\"$1\",\"error\":\"$3\"}"
  else payload="{\"jobId\":\"$1\",\"txHash\":\"${2:-}\"}"; fi
  curl -fsS -X POST "$WORKER_BASE/confidential/ack" -H "authorization: Bearer $BOX_TOKEN" \
    -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1 \
    || log "ack failed (worker reclaims the stale claim after its TTL)"
}

# type → (harness, fixture filename). pv/proof land at exec/public_values.hex + proof_bytes.hex.
harness_for() { case "$1" in
  swap)     echo "exec-swap.rs swap_op.json" ;;
  route)    echo "exec-route.rs route_op.json" ;;
  lp)       echo "exec-lp.rs lp_op.json" ;;
  transfer) echo "exec-prove.rs transfer_op.json" ;;
  otc)      echo "exec-otc.rs otc_op.json" ;;
  bid)      echo "exec-bid.rs bid_op.json" ;;
  bridgeburn) echo "exec-bridgeburn.rs bridgeburn_op.json" ;;
  cdpmint)  echo "exec-cdpmint.rs cdpmint_op.json" ;;
  farmbond) echo "exec-farmbond.rs farmbond_op.json" ;;
  farmharvest) echo "exec-farmharvest.rs farmharvest_op.json" ;;
  farmunbond) echo "exec-farmunbond.rs farmunbond_op.json" ;;
  adaptorlock) echo "exec-adaptorlock.rs adaptorlock_op.json" ;;
  adaptorclaim) echo "exec-adaptorclaim.rs adaptorclaim_op.json" ;;
  adaptorrefund) echo "exec-adaptorrefund.rs adaptorrefund_op.json" ;;
  cdpclose) echo "exec-cdpclose.rs cdpclose_op.json" ;;
  cdptopup) echo "exec-cdptopup.rs cdptopup_op.json" ;;
  bridgemint) echo "exec-bridgemint.rs bridgemint_op.json" ;;
  cbtcmint) echo "exec-cbtcmint.rs cbtcmint_op.json" ;;
  stealthlock) echo "exec-stealthlock.rs stealthlock_op.json" ;;
  stealthlockbatch) echo "exec-stealthlockbatch.rs stealthlockbatch_op.json" ;;
  stealthclaim) echo "exec-stealthclaim.rs stealthclaim_op.json" ;;
  stealthrefund) echo "exec-stealthrefund.rs stealthrefund_op.json" ;;
  bridgestealthmint) echo "exec-bridgestealthmint.rs bridgestealthmint_op.json" ;;
  *) echo "" ;; esac; }

fresh_gpu() {
  pkill -9 sp1-gpu-server 2>/dev/null; pkill -9 -f cxfer-exec 2>/dev/null; pkill -9 sp1-native-runn 2>/dev/null
  rm -f /dev/shm/sp1* /dev/shm/sem.sp1* 2>/dev/null
  sleep 4
  CUDA_VISIBLE_DEVICES=0 setsid nohup sp1-gpu-server > "$CXFER/gpu-server.log" 2>&1 < /dev/null &
  sleep 16
}

log "starting — worker=$WORKER_BASE pool=$POOL_ADDR poll=${POLL_SECS}s"
while true; do
  JOB=$(curl -fsS "$WORKER_BASE/confidential/job" -H "authorization: Bearer $BOX_TOKEN" 2>/dev/null || echo '{}')
  JID=$(echo "$JOB" | jq -r '.jobId // empty')
  if [ -z "$JID" ]; then sleep "$POLL_SECS"; continue; fi

  TYPE=$(echo "$JOB" | jq -r '.type')
  MODE_JOB=$(echo "$JOB" | jq -r '.mode // "settle"')
  read -r HARNESS FIXTURE <<<"$(harness_for "$TYPE")"
  if [ -z "$HARNESS" ]; then log "job $JID unknown type=$TYPE — acking failed"; ack "$JID" "" "unknown type $TYPE"; continue; fi

  echo "$JOB" | jq -c '.op' > "$CXFER/fixtures/$FIXTURE"
  MEMOS=$(echo "$JOB" | jq -r '(.memos // []) | "[" + join(",") + "]"')
  log "job $JID type=$TYPE — proving (groth16/gpu)..."

  fresh_gpu
  cp "$CXFER/harnesses/$HARNESS" "$CXFER/exec/src/main.rs"
  rm -f "$CXFER/exec/public_values.hex" "$CXFER/exec/proof_bytes.hex" "$CXFER/exec/route_pv.hex" "$CXFER/exec/route_pb.hex"
  ( cd "$CXFER/exec" && CUDA_VISIBLE_DEVICES=0 MODE=groth16 cargo run --release >/tmp/conf-prove.log 2>&1 )
  PV_FILE="$CXFER/exec/public_values.hex"; PROOF_FILE="$CXFER/exec/proof_bytes.hex"
  if [ ! -s "$PV_FILE" ] && [ -s "$CXFER/exec/route_pv.hex" ]; then PV_FILE="$CXFER/exec/route_pv.hex"; fi
  if [ ! -s "$PROOF_FILE" ] && [ -s "$CXFER/exec/route_pb.hex" ]; then PROOF_FILE="$CXFER/exec/route_pb.hex"; fi
  # the cuda client panics in a harmless cleanup destructor AFTER writing the artifacts; treat a
  # present, fresh proof as success regardless of exit code.
  if [ ! -s "$PV_FILE" ] || [ ! -s "$PROOF_FILE" ] || ! grep -Eq "WROTE (public_values.hex|route_pv.hex)" /tmp/conf-prove.log; then
    log "prove failed (see /tmp/conf-prove.log) — acking failed"; ack "$JID" "" "prove failed"; continue
  fi
  PV="0x$(cat "$PV_FILE")"
  PROOF="0x$(cat "$PROOF_FILE")"
  if [ "$MODE_JOB" = "prove" ]; then
    curl -fsS -X POST "$WORKER_BASE/confidential/ack" -H "authorization: Bearer $BOX_TOKEN" \
      -H 'content-type: application/json' \
      -d "$(jq -nc --arg jobId "$JID" --arg publicValues "$PV" --arg proof "$PROOF" '{jobId:$jobId,publicValues:$publicValues,proof:$proof}')" >/dev/null 2>&1 \
      || log "ack failed (worker reclaims the stale claim after its TTL)"
    log "proved-only: job=$JID"
    continue
  fi

  TX=$(cast send "$POOL_ADDR" 'settle(bytes,bytes,bytes[])' "$PV" "$PROOF" "$MEMOS" \
    --rpc-url "$RPC_URL" --private-key "$SETTLE_KEY" --json 2>/tmp/conf-send.log \
    | jq -r '.transactionHash // empty')
  if [ -z "$TX" ]; then
    log "settle reverted/failed (see /tmp/conf-send.log) — acking failed"; ack "$JID" "" "settle reverted"; continue
  fi
  log "settled: job=$JID tx=$TX"
  ack "$JID" "$TX"
done
