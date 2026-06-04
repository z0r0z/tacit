#!/usr/bin/env bash
# Posts prover-box liveness + gas balance to the worker every ~2 min, independent of the
# prove loop (which blocks for minutes during a GPU proof). /prover-health then reflects a
# down box, a dead prover process, or a low gas key within ~10 min. Run alongside run-loop.sh.
#
#   PROVER_GAS_ADDR=0x... PROVER_HEARTBEAT_TOKEN=... nohup ./heartbeat-loop.sh >/root/loop-state/heartbeat.log 2>&1 &
set -u

WORKER_URL="${WORKER_URL:-https://tacit-pin.rosscampbell9.workers.dev}"
ETH_RPCS="${ETH_RPCS:-https://eth.llamarpc.com https://ethereum-rpc.publicnode.com https://eth.drpc.org}"
INTERVAL="${HEARTBEAT_INTERVAL:-120}"
STATE_DIR="${STATE_DIR:-/root/loop-state}"
RELAY_ADDRESS="${RELAY_ADDRESS:-45AA793952A710E61D456deAcA13E29d8E5c0951}"
BTC_API="${BTC_API:-https://mempool.space/api}"
: "${PROVER_GAS_ADDR:?set PROVER_GAS_ADDR}"
: "${PROVER_HEARTBEAT_TOKEN:?set PROVER_HEARTBEAT_TOKEN}"

# Run a cast read against each RPC until one returns a plain integer; empty on
# total failure. A single throttled RPC must degrade a field to "unknown",
# never to a fake 0 — a 0 gas reading trips the low-gas alarm.
_cast_int() {
  local rpc out
  for rpc in $ETH_RPCS; do
    out=$("$@" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}')
    case "$out" in ''|*[!0-9]*) continue ;; esac
    echo "$out"; return 0
  done
  return 1
}

while true; do
  gas=$(_cast_int cast balance "$PROVER_GAS_ADDR" || echo "")
  alive=false
  pgrep -f sp1-prover-loop.sh >/dev/null 2>&1 && alive=true
  # Progress fields: how far proof coverage trails the chain, not just box
  # liveness — the loop process can exist while state stops advancing, and
  # /prover-health can't tell the difference without these. Each is omitted
  # (not zeroed) when its source is unavailable so the worker keeps the
  # field null rather than recording a bogus 0.
  proven=$(cat "$STATE_DIR/last_proven_block.txt" 2>/dev/null || echo "")
  case "$proven" in ''|*[!0-9]*) proven= ;; esac
  relay=$(_cast_int cast call "0x$RELAY_ADDRESS" 'tipHeight()(uint256)' || echo "")
  btctip=$(curl -sf -m 10 "$BTC_API/blocks/tip/height" 2>/dev/null)
  case "$btctip" in ''|*[!0-9]*) btctip= ;; esac
  extra=""
  [ -n "$gas" ]    && extra="$extra,\"gas_wei\":\"$gas\""
  [ -n "$proven" ] && extra="$extra,\"last_proven_height\":$proven"
  [ -n "$relay" ]  && extra="$extra,\"relay_tip\":$relay"
  [ -n "$btctip" ] && extra="$extra,\"btc_tip\":$btctip"
  curl -s -m 10 -o /dev/null -X POST "$WORKER_URL/prover-heartbeat" \
    -H 'Content-Type: application/json' \
    -d "{\"token\":\"$PROVER_HEARTBEAT_TOKEN\",\"network\":\"mainnet\",\"prover_alive\":$alive,\"note\":\"hb\"$extra}" || true
  sleep "$INTERVAL"
done
