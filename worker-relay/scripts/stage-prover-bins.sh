#!/usr/bin/env bash
# Stage the SP1 prover binaries into worker-relay/prover/bin/ for the Render Docker build.
# Source order: (1) local backup if present, else (2) fetch from a running box over SSH.
# These binaries embed the guest ELFs (vkey-pinned) — build once (ops/runbooks/PROVER-BOX-SETUP.md),
# reuse forever. Gitignored: ship as a CI/release artifact, never commit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/prover/bin"
BINS=(exec-wrap exec-lp exec-swap exec-unwrap exec-lpremove)  # add bitcoin_prove for reflection
BACKUP="${PROVER_BIN_BACKUP:-$HOME/tacit-critical-backup/seed-rebuild/prover-bins}"
mkdir -p "$DEST"

stage_from_backup() {
  local ok=1
  for b in "${BINS[@]}"; do [ -f "$BACKUP/$b" ] || ok=0; done
  [ "$ok" = 1 ] || return 1
  echo "staging from backup: $BACKUP"
  for b in "${BINS[@]}"; do cp "$BACKUP/$b" "$DEST/$b"; chmod +x "$DEST/$b"; done
}

stage_from_box() {
  : "${BOX_SSH:?set BOX_SSH='-i key -p PORT root@HOST' to fetch from a box}"
  echo "fetching from box: $BOX_SSH"
  local host_part="${BOX_SSH##* }"; local opts="${BOX_SSH% *}"
  for b in "${BINS[@]}"; do
    scp -o StrictHostKeyChecking=no $opts:"/workspace/bin/$b" "$DEST/$b"; chmod +x "$DEST/$b"
  done
}

if ! stage_from_backup; then
  echo "backup incomplete — trying box"; stage_from_box
fi

echo "=== staged (sha256) ==="
for b in "${BINS[@]}"; do
  [ -f "$DEST/$b" ] && printf '  %-14s %s\n' "$b" "$(shasum -a 256 "$DEST/$b" | cut -c1-16)" || echo "  MISSING $b"
done
echo "Ready. Build the Render image (Dockerfile COPY prover/) — vkey must == on-chain PROGRAM_VKEY 0x003a21ba."
