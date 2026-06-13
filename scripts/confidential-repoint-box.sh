#!/bin/bash
# Repoint the GPU-box confidential-settle loop at a new ConfidentialPool (Sepolia v1 pilot 0x32e46B09…).
#
# WHAT IT DOES (on the box, over SSH): sets POOL (+ EXPECT_VKEY) in confidential-settle.env, prints the
# relay key's Sepolia balance (settle gas), and restarts the `cps` tmux loop. Once running, a dapp wrap
# deposit → an OP_WRAP job → the box proves + settles it against the new pool → the cETH note appears.
#
# The worker/queue side needs NO change: the queue is pool-agnostic (the box settles to POOL), and
# CONFIDENTIAL_SETTLE=1 + CONFIDENTIAL_BOX_TOKEN are already set on api.tacit.finance.
#
# PREREQUISITE — the box must be RUNNING. As of the v1 deploy both vast instances are EXITED:
#     vastai show instances-v1            # find the box id (38922877 was the prover/settle box)
#     vastai start instance <id>          # PAID — your call
#     vastai show instances-v1            # read the reassigned SSH addr/port
# then run this with SSH_HOST/SSH_PORT from that output.
#
# Usage:
#   SSH_HOST=sshN.vast.ai SSH_PORT=NNNNN scripts/confidential-repoint-box.sh
# Optional: SSH_KEY (~/.ssh/vast_prover), POOL, EXPECT_VKEY, ENV_FILE, CXFER_DIR.
set -euo pipefail

POOL="${POOL:-0x32e46B097830D93d50b0CBC89c018bCFD79b7B5a}"
EXPECT_VKEY="${EXPECT_VKEY:-0x00d5b572003254b7bb0e50b567d1d92a273b915f0117f5e3bc328236326a9df7}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/vast_prover}"
CXFER_DIR="${CXFER_DIR:-/root/work/cxfer}"
ENV_FILE="${ENV_FILE:-}"
: "${SSH_HOST:?set SSH_HOST (the box ssh host, e.g. ssh9.vast.ai — from 'vastai show instances-v1')}"
: "${SSH_PORT:?set SSH_PORT (the box ssh port)}"

SSH="ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=no -o ConnectTimeout=15 root@$SSH_HOST"

echo "== confidential-settle repoint -> POOL=$POOL (box $SSH_HOST:$SSH_PORT) =="
$SSH "POOL='$POOL' EXPECT_VKEY='$EXPECT_VKEY' CXFER_DIR='$CXFER_DIR' ENV_FILE='$ENV_FILE' bash -s" <<'REMOTE'
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"

# 1. locate confidential-settle.env (the loop's config)
if [ -z "${ENV_FILE:-}" ]; then
  ENV_FILE=$(grep -rls '^WORKER_BASE=' /root/work /root/loop-state 2>/dev/null | grep -i confidential | head -1)
fi
[ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ] || { echo "!! confidential-settle.env not found — pass ENV_FILE=<path>"; exit 1; }
echo "env: $ENV_FILE"

# 2. set POOL + EXPECT_VKEY (replace in place, or append)
set_kv() { if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi; }
set_kv POOL "$POOL"
set_kv EXPECT_VKEY "$EXPECT_VKEY"
echo "  POOL=$(grep '^POOL=' "$ENV_FILE" | cut -d= -f2-)"
echo "  EXPECT_VKEY=$(grep '^EXPECT_VKEY=' "$ENV_FILE" | cut -d= -f2-)"

# 3. relay-key Sepolia balance (the settle gas)
set -a; . "$ENV_FILE"; set +a
ADDR=$(cast wallet address --private-key "$ETH_PK" 2>/dev/null || echo '?')
BAL=$(cast balance "$ADDR" --rpc-url "$RPC" --ether 2>/dev/null || echo '?')
echo "  relay key $ADDR : ${BAL} ETH"
case "$BAL" in 0|0.000000000000000000|'?') echo "  !! fund the relay key with Sepolia ETH or settles will fail";; esac

# 4. restart the cps loop
LOOP="$CXFER_DIR/scripts/confidential-settle-loop.sh"
[ -f "$LOOP" ] || LOOP=$(find /root -name confidential-settle-loop.sh 2>/dev/null | head -1)
[ -n "$LOOP" ] && [ -f "$LOOP" ] || { echo "!! confidential-settle-loop.sh not found on the box"; exit 1; }
mkdir -p /root/loop-state
tmux kill-session -t cps 2>/dev/null || true
tmux new-session -d -s cps "cd '$CXFER_DIR' && set -a && . '$ENV_FILE' && set +a && bash '$LOOP' 2>&1 | tee -a /root/loop-state/cps.out"
sleep 3
if tmux has-session -t cps 2>/dev/null; then
  echo "cps loop restarted (tmux: cps). Recent:"; tail -n 4 /root/loop-state/cps.out 2>/dev/null || true
else
  echo "!! cps failed to start — check /root/loop-state/cps.out"; exit 1
fi
REMOTE
echo "== repoint complete =="
