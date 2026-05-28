#!/bin/bash
# Supervised wrapper for the continuous tETH prover loop.
#
# Sources the deployment env (/workspace/prover.env, public values) and the gas
# key (/workspace/.ethpk, secret — never committed), exports the toolchain PATH,
# and restarts the loop if it ever exits. Launched in a tmux session named
# 'prover' by the vast.ai onstart so it survives disconnects + reboots. The inner
# loop (sp1-prover-loop.sh) already sleeps between cycles; this wrapper only
# re-runs it after a crash.
set -uo pipefail
exec >> /workspace/prover.log 2>&1

export PATH="$PATH:/usr/local/go/bin:$HOME/.cargo/bin:$HOME/.foundry/bin"
source "$HOME/.cargo/env" 2>/dev/null || true
[ -f /workspace/prover.env ] && { set -a; source /workspace/prover.env; set +a; }
[ -f /workspace/.ethpk ]     && { set -a; source /workspace/.ethpk;     set +a; }

LOOP=/workspace/tacit/scripts/sp1-prover-loop.sh
while true; do
  echo "[$(date '+%F %T')] === starting prover loop ==="
  bash "$LOOP" || echo "[$(date '+%F %T')] loop exited ($?); restarting in 30s"
  sleep 30
done
