#!/bin/bash
set -euo pipefail

# Bitcoin reorg monitor for the tETH bridge pilot.
#
# Withdrawals require a burn buried CONFIRMATION_DEPTH (6) blocks deep in the
# relay, and the relay follows the heaviest chain — so a reorg shallower than 6
# is absorbed safely. The realistic fund-risk is a reorg DEEPER than 6 that
# un-confirms a burn an honest withdrawal already paid out against (deepest
# historical mainnet reorg: 4 blocks, 2013). This watcher caches recent block
# hashes and alerts the moment a previously-seen height's hash changes, with the
# reorg depth, so the operator can pause withdrawals + investigate before any
# deeper reorg matters.
#
# Usage:  ./scripts/monitor-btc-reorg.sh
# Env:    MEMPOOL_API (default mainnet), WATCH_DEPTH (12), POLL_SECONDS (60),
#         ALERT_DEPTH (2 — log at WARN; >=CONFIRMATION_DEPTH is a fund-risk),
#         CONFIRMATION_DEPTH (6), STATE_DIR (/tmp/btc-reorg-mon)

MEMPOOL_API="${MEMPOOL_API:-https://mempool.space/api}"
WATCH_DEPTH="${WATCH_DEPTH:-12}"
POLL_SECONDS="${POLL_SECONDS:-60}"
ALERT_DEPTH="${ALERT_DEPTH:-2}"
CONFIRMATION_DEPTH="${CONFIRMATION_DEPTH:-6}"
STATE_DIR="${STATE_DIR:-/tmp/btc-reorg-mon}"
mkdir -p "$STATE_DIR"
CACHE="$STATE_DIR/hashes.tsv"   # lines: <height>\t<hash>
log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

log "BTC reorg monitor: api=$MEMPOOL_API depth=$WATCH_DEPTH poll=${POLL_SECONDS}s (alert>=${ALERT_DEPTH}, fund-risk>=${CONFIRMATION_DEPTH})"
while true; do
  tip=$(curl -s "$MEMPOOL_API/blocks/tip/height" 2>/dev/null || echo "")
  if ! [[ "$tip" =~ ^[0-9]+$ ]]; then log "WARN: could not fetch tip"; sleep "$POLL_SECONDS"; continue; fi

  for ((d = 0; d < WATCH_DEPTH; d++)); do
    h=$((tip - d))
    hash=$(curl -s "$MEMPOOL_API/block-height/$h" 2>/dev/null || echo "")
    [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || continue
    prev=$(awk -F'\t' -v hh="$h" '$1==hh{print $2}' "$CACHE" 2>/dev/null | tail -1)
    if [[ -n "$prev" && "$prev" != "$hash" ]]; then
      depth=$((tip - h + 1))
      if [[ "$depth" -ge "$CONFIRMATION_DEPTH" ]]; then
        log "FUND-RISK REORG: block $h hash changed at depth $depth (>= CONFIRMATION_DEPTH $CONFIRMATION_DEPTH). PAUSE WITHDRAWALS. was=$prev now=$hash"
      elif [[ "$depth" -ge "$ALERT_DEPTH" ]]; then
        log "REORG: block $h hash changed at depth $depth. was=$prev now=$hash"
      fi
    fi
    # upsert
    if [[ -f "$CACHE" ]]; then grep -v -P "^$h\t" "$CACHE" > "$CACHE.tmp" 2>/dev/null || true; mv "$CACHE.tmp" "$CACHE"; fi
    printf '%s\t%s\n' "$h" "$hash" >> "$CACHE"
  done
  # keep the cache bounded
  tail -n $((WATCH_DEPTH * 4)) "$CACHE" > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE"
  sleep "$POLL_SECONDS"
done
