#!/usr/bin/env bash
# Posts prover-box liveness + gas balance to the worker every ~2 min, independent of the
# prove loop (which blocks for minutes during a GPU proof). /prover-health then reflects a
# down box, a dead prover process, or a low gas key within ~10 min. Run alongside run-loop.sh.
#
#   PROVER_GAS_ADDR=0x... PROVER_HEARTBEAT_TOKEN=... nohup ./heartbeat-loop.sh >/root/loop-state/heartbeat.log 2>&1 &
set -u

WORKER_URL="${WORKER_URL:-https://tacit-pin.rosscampbell9.workers.dev}"
ETH_RPC="${ETH_RPC:-https://eth.llamarpc.com}"
INTERVAL="${HEARTBEAT_INTERVAL:-120}"
: "${PROVER_GAS_ADDR:?set PROVER_GAS_ADDR}"
: "${PROVER_HEARTBEAT_TOKEN:?set PROVER_HEARTBEAT_TOKEN}"

while true; do
  gas=$(cast balance "$PROVER_GAS_ADDR" --rpc-url "$ETH_RPC" 2>/dev/null || echo 0)
  case "$gas" in ''|*[!0-9]*) gas=0 ;; esac
  alive=false
  pgrep -f sp1-prover-loop.sh >/dev/null 2>&1 && alive=true
  curl -s -m 10 -o /dev/null -X POST "$WORKER_URL/prover-heartbeat" \
    -H 'Content-Type: application/json' \
    -d "{\"token\":\"$PROVER_HEARTBEAT_TOKEN\",\"network\":\"mainnet\",\"gas_wei\":\"$gas\",\"prover_alive\":$alive,\"note\":\"hb\"}" || true
  sleep "$INTERVAL"
done
