#!/usr/bin/env bash
# Durable Mode-B reflection prover loop (runs on the vast.ai prover box).
#
# Each cycle:
#   1. [optional] REGEN_CMD -> refresh reflection_input.json from the live Bitcoin pool snapshot
#      (the reflection indexer; omit for a dry-run against the committed fixture).
#   2. eth_prove            -> POOL-bound eth-reflection COMPRESSED proof (+ reproducible genesis).
#   3. bitcoin_prove groth16-> the recursive Bitcoin reflection proof (publicValues + proofBytes).
#   4. submit attestBitcoinStateProven via SUBMIT_URL (a relay queue); unset => DRY-RUN (proof left in out/).
#
# Durability: per-cycle GPU cleanup (a stale sp1-gpu-server fills the 24GB card -> "early eof"; the
# pattern uses the bracket trick so the kill never matches this script's own cmdline), a heartbeat JSON
# for /prover-health, the last newDigest persisted, and the `while` survives a cycle crash. For REBOOT
# survival, install the @reboot cron (footer).
#
# Required env: POOL GENESIS_SLOT SOURCE_CONSENSUS_RPC SOURCE_CHAIN_ID
# Optional env: SUBMIT_URL (relay attest endpoint; unset = dry-run)  INTERVAL (s, default 600)  REGEN_CMD
#               HOST (default /root/work/prover-host)
#
# Run durable:  nohup setsid bash run-reflect-loop.sh >/dev/null 2>&1 &
# Health:       cat $HOST/loop-state/health.json   (serve on :8080 for the -L tunnel if desired)

set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$PATH"
HOST="${HOST:-/root/work/prover-host}"
OUT="$HOST/out"
STATE="$HOST/loop-state"; mkdir -p "$STATE"
HEALTH="$STATE/health.json"
LOG="$STATE/loop.out"
INTERVAL="${INTERVAL:-600}"

: "${POOL:?set POOL=<deployed ConfidentialPool address>}"
: "${GENESIS_SLOT:?set GENESIS_SLOT=<pinned bootstrap slot, e.g. 10462624>}"
: "${SOURCE_CONSENSUS_RPC:?set SOURCE_CONSENSUS_RPC}"
: "${SOURCE_CHAIN_ID:?set SOURCE_CHAIN_ID}"

ts() { date -u +%FT%TZ; }
heartbeat() { printf '{"ts":"%s","cycle":%d,"phase":"%s","status":"%s","detail":"%s","last_digest":"%s"}\n' \
  "$(ts)" "$1" "$2" "$3" "$4" "$(cat "$STATE/last_digest.txt" 2>/dev/null || echo none)" > "$HEALTH"; }
gpu_clean() { pkill -9 -f "sp1-gpu-serve[r]" 2>/dev/null; rm -f /tmp/sp1-cuda-*.sock; sleep 2; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

log "reflect-loop start: POOL=$POOL GENESIS_SLOT=$GENESIS_SLOT interval=${INTERVAL}s submit=${SUBMIT_URL:-DRY-RUN}"
cycle=0
while true; do
  cycle=$((cycle+1))
  log "cycle $cycle begin"

  if [ -n "${REGEN_CMD:-}" ]; then
    heartbeat "$cycle" indexer running ""
    if ! bash -c "$REGEN_CMD" >>"$LOG" 2>&1; then
      log "cycle $cycle: REGEN_CMD failed"; heartbeat "$cycle" indexer error ""; sleep "$INTERVAL"; continue
    fi
  fi

  heartbeat "$cycle" eth_prove running ""
  gpu_clean
  if ! POOL="$POOL" GENESIS_SLOT="$GENESIS_SLOT" SOURCE_CONSENSUS_RPC="$SOURCE_CONSENSUS_RPC" SOURCE_CHAIN_ID="$SOURCE_CHAIN_ID" \
       "$HOST/target/release/eth_prove" >>"$LOG" 2>&1; then
    log "cycle $cycle: eth_prove FAILED"; heartbeat "$cycle" eth_prove error ""; sleep "$INTERVAL"; continue
  fi

  heartbeat "$cycle" bitcoin_prove running ""
  gpu_clean
  if ! PROOF_MODE=groth16 "$HOST/target/release/bitcoin_prove" >>"$LOG" 2>&1; then
    log "cycle $cycle: bitcoin_prove FAILED"; heartbeat "$cycle" bitcoin_prove error ""; sleep "$INTERVAL"; continue
  fi

  PV="$(cat "$OUT/bitcoin_pv.hex")"
  PB="$(cat "$OUT/bitcoin_proof_bytes.hex")"
  # Telemetry only (last_digest.txt + the health heartbeat); the SUBMITTED payload is the full $PV, so this
  # never gates a consensus step. BitcoinReflectionPublicValues is a DYNAMIC tuple, so abi_encode prepends a
  # 0x20 offset word (reflect-exec/main.rs strips it): in the raw stream field `newDigest` (index 5) is at
  # word 6 = char 384, NOT char 320 (= word 5 = the bitcoinHeight uint64). Read 384.
  NEWDIGEST="0x${PV:384:64}"

  if [ -n "${SUBMIT_URL:-}" ]; then
    if curl -fsS -X POST "$SUBMIT_URL" -H 'content-type: application/json' \
         -d "{\"publicValues\":\"0x$PV\",\"proofBytes\":\"0x$PB\"}" >>"$LOG" 2>&1; then
      mv "$OUT/eth_set_state.pending.json" "$OUT/eth_set_state.json"
      echo "$NEWDIGEST" > "$STATE/last_digest.txt"; log "cycle $cycle: SUBMITTED newDigest=$NEWDIGEST"; heartbeat "$cycle" submit ok "$NEWDIGEST"
    else
      log "cycle $cycle: SUBMIT FAILED"; heartbeat "$cycle" submit error "$NEWDIGEST"
    fi
  else
    echo "$NEWDIGEST" > "$STATE/last_digest.txt"; log "cycle $cycle: DRY-RUN proof ready newDigest=$NEWDIGEST (set SUBMIT_URL to attest)"; heartbeat "$cycle" dry-run ok "$NEWDIGEST"
  fi

  sleep "$INTERVAL"
done

# ── Reboot durability ─────────────────────────────────────────────────────────
# The `while` survives a cycle crash; for box-reboot survival add a @reboot cron that relaunches this:
#   (crontab -l 2>/dev/null; echo "@reboot POOL=0x.. GENESIS_SLOT=10462624 SOURCE_CONSENSUS_RPC=https://ethereum-sepolia-beacon-api.publicnode.com SOURCE_CHAIN_ID=11155111 SUBMIT_URL=https://api.tacit.finance/.. nohup setsid bash /root/work/prover-host/run-reflect-loop.sh >/dev/null 2>&1 &") | crontab -
# Health JSON: /root/work/prover-host/loop-state/health.json (phase/status/last_digest, refreshed each step).
