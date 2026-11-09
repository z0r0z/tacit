#!/bin/bash
# Runs a help desk node on this machine: llama.cpp's llama-server with the Qwen3.5-4B model, and worker.mjs, which takes questions from the
# help desk, has the model answer them and sends the answers back. Answers are credited to MINER.
#   MINER=0x… bash run.sh          the first run downloads about 2.7 GB (checked against pinned SHA-256 sums); stop it with Ctrl-C
# Settings: HELPDESK_API (default https://tacit-helpdesk.onrender.com), HELPDESK_NODE_DIR (default ~/.tacit-helpdesk-node), PORT (the model's local port, default 8095),
# CTX (the model's context, default 4096). Needs Node 18 or newer and about 4 GB of memory to spare.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
D=${HELPDESK_NODE_DIR:-$HOME/.tacit-helpdesk-node}; PORT=${PORT:-8095}; CTX=${CTX:-4096}
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ "${MINER:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "set MINER to an Ethereum address (0x and 40 hex digits): the help desk credits your answers to it"
command -v node >/dev/null || die "Node 18 or newer is needed (https://nodejs.org)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node 18 or newer is needed, this is $(node --version)"
# the download takes a while: an idle laptop is kept awake for it (a sleeping computer stalls it)
if command -v caffeinate >/dev/null 2>&1; then caffeinate -i bash "$HERE/fetch.sh" || exit 1; else bash "$HERE/fetch.sh" || exit 1; fi

LPID=
stop() { [ -n "$LPID" ] && kill "$LPID" 2>/dev/null; }
trap stop EXIT; trap 'exit 130' INT TERM
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "a model server is already answering on port $PORT: using it"
else
  bin=$(find "$D/llama" -name llama-server -type f | head -1); libdir=$(dirname "$bin")
  echo "starting the model (log: $D/llama.log)"
  LD_LIBRARY_PATH="$libdir:${LD_LIBRARY_PATH:-}" DYLD_LIBRARY_PATH="$libdir:${DYLD_LIBRARY_PATH:-}" \
    "$bin" -m "$D/model.gguf" -c "$CTX" -np 1 --host 127.0.0.1 --port "$PORT" --reasoning off > "$D/llama.log" 2>&1 &
  LPID=$!
  for _ in $(seq 1 180); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    kill -0 "$LPID" 2>/dev/null || die "the model stopped at start, see $D/llama.log"
    sleep 1
  done
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || die "the model did not come up in 3 minutes, see $D/llama.log"
  echo "model ready"
fi
LLM_URL="http://127.0.0.1:$PORT" node "$HERE/worker.mjs"
