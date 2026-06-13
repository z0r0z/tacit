#!/bin/bash
# Confidential settle relay — GPU-box loop.
#
# Polls the worker job queue (/confidential/job), GPU-Groth16-proves each claimed
# confidential op (transfer/swap/lp/otc/bid) with the committed cxfer-guest ELF, submits
# ConfidentialPool.settle(pv, proof, memos) on-chain, and acks the worker (/confidential/ack).
# FIFO, single-prover; the worker is the queue, the contract independently verifies the proof
# against PROGRAM_VKEY, so a bad witness just fails to prove (and acks as failed — never stuck).
#
# Shares the box's single GPU with the mainnet tETH loop; both go through one sp1-gpu-server,
# which serializes prove requests. Config via env (confidential-settle.env), all required:
#   WORKER_BASE  - e.g. https://api.tacit.finance (no trailing slash)
#   BOX_TOKEN    - Bearer for /confidential/job + /confidential/ack (= worker CONFIDENTIAL_BOX_TOKEN)
#   POOL         - ConfidentialPool address (Sepolia 0x32e46B09… for the v1 pilot)
#   RPC          - Sepolia RPC
#   ETH_PK       - settle gas key (the box .ethpk)
# Optional: CXFER_DIR (/root/work/cxfer), SLEEP_SECONDS (15),
#   EXPECT_VKEY  - the pool's PROGRAM_VKEY (e.g. 0x00d5b572…). When set, it's passed to the prove
#                  harness's fail-closed vkey guard, so a box guest that doesn't match the deployed
#                  pool aborts at prove time instead of wasting a GPU prove on an on-chain revert.
set -uo pipefail
CXFER_DIR="${CXFER_DIR:-/root/work/cxfer}"
EXEC_DIR="$CXFER_DIR/exec"
OP_FILE="$CXFER_DIR/loop-op.json"
SLEEP="${SLEEP_SECONDS:-15}"
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$HOME/.foundry/bin:$PATH"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] $*"; }

harness_for() {
  case "$1" in
    wrap)     echo "exec-wrap.rs";;
    transfer) echo "exec-prove.rs";;
    swap)     echo "exec-swap.rs";;
    lp)       echo "exec-lp.rs";;
    otc)      echo "exec-otc.rs";;
    bid)      echo "exec-bid.rs";;
    *)        echo "";;
  esac
}

ack() { # jobId, key(txHash|error), value
  curl -fsS -X POST -H "Authorization: Bearer $BOX_TOKEN" -H 'content-type: application/json' \
    "$WORKER_BASE/confidential/ack" -d "{\"jobId\":\"$1\",\"$2\":\"$3\"}" >/dev/null 2>&1
}

# A fresh gpu-server per prove: SP1 6.2's cuda server leaks GPU memory across proofs (-> AllocError)
# and its teardown SIGABRTs, leaving the server dirty so the next prove fails. Mirror the tETH loop:
# kill, clear the socket, restart, wait for /tmp/sp1-cuda-0.sock. Shares the box's single GPU with the
# (idle-most-of-the-time) tETH prover; a rare simultaneous prove is caught by the per-job retry below.
ensure_fresh_gpu_server() {
  pkill -9 -f "[s]p1-gpu-server" 2>/dev/null; sleep 2; rm -f /tmp/sp1-cuda-0.sock
  CUDA_VISIBLE_DEVICES=0 setsid nohup "$HOME/.sp1/bin/sp1-gpu-server" >"$CXFER_DIR/cps-gpu-server.log" 2>&1 </dev/null &
  for _ in $(seq 1 20); do sleep 2; [ -S /tmp/sp1-cuda-0.sock ] && return 0; done
  log "WARNING: gpu-server socket /tmp/sp1-cuda-0.sock not up after restart"; return 1
}

for v in WORKER_BASE BOX_TOKEN POOL RPC ETH_PK; do
  [ -n "${!v:-}" ] || { log "FATAL: missing $v"; exit 1; }
done
command -v jq >/dev/null || { log "FATAL: jq not found"; exit 1; }

log "=== Confidential settle loop === pool=$POOL worker=$WORKER_BASE sleep=${SLEEP}s"
while true; do
  job=$(curl -fsS -H "Authorization: Bearer $BOX_TOKEN" "$WORKER_BASE/confidential/job" 2>/dev/null)
  jobId=$(echo "$job" | jq -r '.jobId // empty' 2>/dev/null)
  if [ -z "$jobId" ]; then sleep "$SLEEP"; continue; fi
  type=$(echo "$job" | jq -r '.type // empty')
  harness=$(harness_for "$type")
  if [ -z "$harness" ]; then log "job $jobId: unknown type '$type'"; ack "$jobId" error "unknown type $type"; continue; fi
  log "job $jobId: claimed type=$type → $harness"

  echo "$job" | jq '.op' > "$OP_FILE"
  if [ ! -s "$OP_FILE" ] || [ "$(cat "$OP_FILE")" = "null" ]; then log "job $jobId: empty op"; ack "$jobId" error "empty op"; continue; fi

  cp "$CXFER_DIR/harnesses/$harness" "$EXEC_DIR/src/main.rs"
  proved=0
  for attempt in 1 2; do
    ensure_fresh_gpu_server
    rm -f "$EXEC_DIR/public_values.hex" "$EXEC_DIR/proof_bytes.hex"
    ( cd "$EXEC_DIR" && OP_FILE="$OP_FILE" MODE=groth16 CUDA_VISIBLE_DEVICES=0 ${EXPECT_VKEY:+EXPECT_VKEY="$EXPECT_VKEY"} cargo run --release ) >"$CXFER_DIR/loop-prove.log" 2>&1
    rc=$?
    # The CUDA groth16 prover SIGABRTs (rc=134) on a destructor panic during teardown — AFTER it has
    # written + locally verified the proof ("WROTE …" in loop-prove.log). Judge by the artifacts, not rc.
    if [ -s "$EXEC_DIR/public_values.hex" ] && [ -s "$EXEC_DIR/proof_bytes.hex" ]; then
      proved=1; [ $rc -ne 0 ] && log "job $jobId: prove rc=$rc (cosmetic teardown abort; artifacts present)"; break
    fi
    log "job $jobId: prove attempt $attempt FAILED (rc=$rc, no artifacts) — fresh gpu-server + retry"
  done
  [ $proved -eq 1 ] || { log "job $jobId: prove FAILED after retries (see loop-prove.log)"; ack "$jobId" error "prove failed"; continue; }
  pv="0x$(tr -d '[:space:]' <"$EXEC_DIR/public_values.hex")"
  proof="0x$(tr -d '[:space:]' <"$EXEC_DIR/proof_bytes.hex")"
  memos=$(echo "$job" | jq -r '(.memos // []) | map(if startswith("0x") then . else "0x"+. end) | "["+join(",")+"]"')
  log "job $jobId: proved (pv ${#pv}b proof ${#proof}b) → settle"

  out=$(cast send "$POOL" "settle(bytes,bytes,bytes[])" "$pv" "$proof" "$memos" \
        --private-key "$ETH_PK" --rpc-url "$RPC" --json 2>&1)
  tx=$(echo "$out" | jq -r '.transactionHash // empty' 2>/dev/null)
  st=$(echo "$out" | jq -r '.status // empty' 2>/dev/null)
  if [ -n "$tx" ] && [ "$st" = "0x1" ]; then
    log "job $jobId: settled tx=$tx"; ack "$jobId" txHash "$tx"
  else
    log "job $jobId: settle FAILED — $(echo "$out" | tr -d '\n' | head -c 180)"; ack "$jobId" error "settle reverted"
  fi
done
