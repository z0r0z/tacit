#!/usr/bin/env bash
# Build settle + reflection ELFs from the synced latest source (reflect.rs has the re-pinned eth vkey),
# then derive PROGRAM_VKEY (settle) + BITCOIN_RELAY_VKEY (reflection). Detached + logged for SSH-drop safety.
cd /root/work/cxfer
{
  source "$HOME/.cargo/env" 2>/dev/null || true
  export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"
  echo "=== build settle+reflection ELFs (cargo prove build) ==="
  ( cd /root/work/cxfer/guest && cargo prove build ) 2>&1 | tail -4
  echo "=== derive settle + reflection vkeys ==="
  ( cd /root/work/cxfer/exec && cargo run --release --bin derive_v1 ) 2>&1 | grep -iE "PROGRAM_VKEY|BITCOIN_RELAY_VKEY|VKEY=|0x[0-9a-f]{60}"
  echo "=== BUILD_DERIVE_DONE ==="
} > /root/work/cxfer/build-derive.log 2>&1
