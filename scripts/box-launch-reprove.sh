#!/usr/bin/env bash
# Self-contained, SSH-drop-resilient launcher for the V1 re-prove on the vast box.
# rsync'd to the box and triggered with ONE minimal SSH command; does its own cleanup + detached launch,
# so a dropped interactive SSH session never leaves the box half-configured. box-prove-remote.sh is
# resumable (skip-done via manifest + out-v1), so re-triggering this safely continues a partial run.
set -uo pipefail
cd /root/work/cxfer
{
  echo "=== launcher start (box clock unreliable; ignore wall time) ==="
  # one driver only: kill any stale prove procs + servers + orphan cargo + parallel bins
  pkill -9 -f "cargo run.*--bin exec" 2>/dev/null || true
  pkill -9 -f "bash box-prove-remote.sh" 2>/dev/null || true
  pkill -9 -f "parallel-ng-prove" 2>/dev/null || true
  pkill -9 -f "exec/bins/" 2>/dev/null || true
  pkill -9 -x sp1-gpu-server 2>/dev/null || true
  pkill -9 -x sp1-native-runn 2>/dev/null || true
  rm -f /dev/shm/sp1* /dev/shm/sem.sp1* /tmp/sp1-cuda-0.sock 2>/dev/null || true
  sleep 5
  # FULL clean only when FRESH=1; default RESUME keeps completed artifacts (skip-done continues a partial run)
  if [ "${FRESH:-0}" = "1" ]; then
    rm -f out-v1/*_pv.hex out-v1/*_pb.hex out-v1/manifest.tsv 2>/dev/null || true
    echo "FRESH clean: out-v1 wiped"
  fi
  rm -f box-prove.status 2>/dev/null || true
  source "$HOME/.cargo/env" 2>/dev/null || true
  export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"
  export CX=/root/work/cxfer
  export PVK="${PVK:-0x0079b7559416907fe29e534cb81ed19ad67436734bb324821e855bf30505f55b}"
  setsid nohup bash box-prove-remote.sh >> box-prove.out 2>&1 < /dev/null &
  echo "box-prove-remote launched, pid $!"
  echo "=== launcher done ==="
} > launcher.log 2>&1
