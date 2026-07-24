#!/bin/sh
set -e

export IPFS_PATH=/data/ipfs
PORT="${PORT:-8080}"

# Init repo once (persists if /data is a mounted disk; re-inits on ephemeral hosts).
if [ ! -f "$IPFS_PATH/config" ]; then
  ipfs init --profile server
fi

# Gateway listens on the platform-provided HTTP port, all interfaces.
ipfs config Addresses.Gateway "/ip4/0.0.0.0/tcp/${PORT}"
# API bound to loopback only (never expose the write API publicly).
ipfs config Addresses.API "/ip4/127.0.0.1/tcp/5001"
# Serve only content this node has pinned (no open-proxy fetching of arbitrary
# CIDs). New content is added via deploy, so uploads stay gated to our auth.
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.DeserializedResponses true

# Pin the baked content and announce it, in the background once the daemon is up.
(
  # wait for the API socket
  i=0
  while [ $i -lt 60 ]; do
    if ipfs id >/dev/null 2>&1; then break; fi
    i=$((i+1)); sleep 1
  done
  CID=$(ipfs add -Q --pin=true /content/index.html)
  echo "pinned: $CID"
  ipfs routing provide "$CID" >/dev/null 2>&1 || true
  echo "announced: $CID"
) &

exec ipfs daemon --migrate=true --enable-gc
