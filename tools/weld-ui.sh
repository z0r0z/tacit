#!/bin/sh
# The front page's look-and-copy checks in a few minutes: weld-check's `ui` steps (or the ones named) on an anvil fork pinned to one block
# a day, through tools/fork-proxy.mjs, whose disk cache answers a rerun at that block without asking a public node again.
#   tools/weld-ui.sh              the ui steps
#   tools/weld-ui.sh hxfold,hints  just these
set -e
cd "$(dirname "$0")/.."
PORT=${PROXY_PORT:-8590}
CACHE=${CACHE_DIR:-${TMPDIR:-/tmp}/tacit-fork-cache}
export PATH="$PATH:$HOME/.foundry/bin"
if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PORT=$PORT CACHE_DIR=$CACHE node tools/fork-proxy.mjs >/dev/null 2>&1 &
  trap 'kill $! 2>/dev/null' EXIT
  sleep 1
fi
# one block a day, kept beside the cache, so every run of the day asks the same questions
PIN="$CACHE/block-$(date +%Y%m%d)"
mkdir -p "$CACHE"
if [ ! -s "$PIN" ]; then
  head=$(curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' https://rpc.mevblocker.io | sed -E 's/.*"result":"(0x[0-9a-f]+)".*/\1/')
  printf '%d\n' $((head - 4)) > "$PIN"
fi
FORK_BLOCK=$(cat "$PIN") node tools/weld-check.mjs "${1:-ui}" "http://127.0.0.1:$PORT"
