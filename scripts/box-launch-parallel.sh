#!/usr/bin/env bash
# SSH-drop-resilient launcher for the PARALLEL CPU re-prove (parallel-ng-prove.sh, native-gnark, no GPU).
# rsync'd to the box + triggered by one minimal SSH cmd. Rebuilds bins fresh (embeds the current ELF),
# then proves N-way concurrent. No `timeout` in the driver (clock-jump-immune). Resumable via out-v1 skip.
set -uo pipefail
cd /root/work/cxfer
{
  echo "=== parallel launcher start (clock unreliable; ignore wall time) ==="
  pkill -9 -f "cargo run.*--bin exec" 2>/dev/null || true
  pkill -9 -f "box-prove-remote.sh" 2>/dev/null || true
  pkill -9 -f "parallel-ng-prove.sh" 2>/dev/null || true
  pkill -9 -f "exec/bins/" 2>/dev/null || true
  pkill -9 -x sp1-gpu-server 2>/dev/null || true
  pkill -9 -x sp1-native-runn 2>/dev/null || true
  rm -f /dev/shm/sp1* /dev/shm/sem.sp1* /tmp/sp1-cuda-0.sock 2>/dev/null || true
  sleep 5
  rm -f out-v1/*_pv.hex out-v1/*_pb.hex out-v1/manifest.tsv 2>/dev/null || true
  rm -rf run/* 2>/dev/null || true
  source "$HOME/.cargo/env" 2>/dev/null || true
  export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"
  export PVK="${PVK:-0x0079b7559416907fe29e534cb81ed19ad67436734bb324821e855bf30505f55b}"
  export N="${N:-10}"
  # no REUSE_BINS -> rebuild bins fresh so they embed the current (14:14) ELF + audited harnesses
  setsid nohup bash parallel-ng-prove.sh >> parallel.out 2>&1 < /dev/null &
  echo "parallel-ng-prove launched pid $!, N=$N"
  echo "=== launcher done ==="
} > launcher-parallel.log 2>&1
