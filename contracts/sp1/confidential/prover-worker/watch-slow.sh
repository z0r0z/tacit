#!/usr/bin/env bash
# Watches the GPU server's log (it writes into /workspace/worker.log) for the warning stage of its slow regime: a Groth16 step over 14 s where a
# healthy one takes 10-11 s (the step jumps to a steady ~27 s once the server's GPU memory has grown past what ICICLE needs in one piece, a median of 12 proofs
# in; 100 s proofs have followed within two or three). It then creates /workspace/worker.recycle, and the worker (src/main.rs RECYCLE_FLAG) restarts itself and
# the server at its next idle moment. A restart takes about a minute (the server's start and a warm-up proof: 66 s measured over 163 restarts), and a user's job
# posted meanwhile waits for it: it did in more than half of them.
#
# With a second box (PEER_WORKERS in worker.env: the other house worker's board name, comma separated for more) the restarts are rolled: this box asks for its
# recycle only while a peer is polling the board (lastSeenSeconds <= 5 on /prover/board), so one worker is always warm and a sealed or board job is claimed by
# it (dapp/sealed-input.js pickWorker seals to the worker polling now). A peer seen within the last ten minutes but not polling is restarting: wait for it, at most
# RECYCLE_PEER_HOLD_SECS (180); a peer not seen for ten minutes, never seen, or a board that cannot be read is no peer to wait for, and the recycle goes ahead as it
# always did. A small random pause first keeps two boxes that slow in the same second from asking together. With no PEER_WORKERS nothing changes.
# Settings are read from worker.env here (this script starts before run-worker.sh sources it), or from the environment.
LOG=${WORKER_LOG:-/workspace/worker.log}
FLAG=${RECYCLE_FLAG:-/workspace/worker.recycle}
LIMIT_MS=${SLOW_STEP_MS:-14000}
ENVFILE=${WORKER_ENV:-/workspace/worker.env}

# A setting: the environment first, then the last NAME=value line of worker.env (quotes dropped). Never printed.
setting() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -r "$ENVFILE" ]; then v=$(grep -E "^$1=" "$ENVFILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'"); fi
  printf '%s' "$v"
}

# exit 0: the recycle may go ahead; exit 1: a peer is restarting, wait.
peer_ready() {
  local peers board
  peers=$(setting PEER_WORKERS)
  [ -z "$peers" ] && return 0
  board=$(setting BOARD_URL); board=${board:-https://api.tacit.finance}
  python3 - "$board" "$peers" <<'PY'
import json, sys, urllib.request
board, peers = sys.argv[1], {p.strip() for p in sys.argv[2].split(",") if p.strip()}
try:
    s = json.load(urllib.request.urlopen(board.rstrip("/") + "/prover/board", timeout=8))
except Exception:
    sys.exit(0)                      # the board cannot be read: say nothing of the peer, recycle as before
seen = [w.get("lastSeenSeconds") for w in s.get("workers", []) if w.get("name") in peers]
seen = [float(x) for x in seen if x is not None]
if any(x <= 5 for x in seen):
    sys.exit(0)                      # a peer is polling now: it takes the jobs while this box restarts
sys.exit(1 if any(x <= 600 for x in seen) else 0)   # seen lately but not polling: restarting, wait; gone or never seen: nothing to wait for
PY
}

ask_recycle() {
  local ms=$1 waited=0 hold step
  hold=$(setting RECYCLE_PEER_HOLD_SECS); hold=${hold:-180}
  step=${RECYCLE_PEER_POLL_SECS:-5}
  if [ -n "$(setting PEER_WORKERS)" ]; then
    sleep "$(( RANDOM % ${RECYCLE_JITTER_SECS:-15} ))"
    while ! peer_ready && [ "$waited" -lt "$hold" ]; do sleep "$step"; waited=$(( waited + step )); done
  fi
  touch "$FLAG"
  if [ "$waited" -gt 0 ]; then echo "[watch-slow] Groth16 step took ${ms} ms: recycle asked (after ${waited} s for a peer to be back)" >> "$LOG"
  else echo "[watch-slow] Groth16 step took ${ms} ms: recycle asked" >> "$LOG"; fi
}

# sourced (by the test) it only defines the functions above
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  tail -n0 -F "$LOG" 2>/dev/null | grep --line-buffered "prover done" | sed -u 's/\x1b\[[0-9;]*m//g' | while IFS= read -r line; do
    if [[ $line =~ took=([0-9]+) ]]; then
      ms=${BASH_REMATCH[1]}
      if [ "$ms" -gt "$LIMIT_MS" ]; then ask_recycle "$ms"; fi
    fi
  done
fi
