#!/bin/bash
set -uo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# Reflection relay loop — runs on the self-hosted GPU prover box.
#
# Keeps the on-chain Bitcoin-state attestation current: polls the worker for the
# next assembled reflection batch, proves it (exec-reflect-prove, GPU Groth16),
# submits ConfidentialPool.attestBitcoinStateProven on-chain with a relay key,
# then acks so the worker advances its attested cursor. The relay key + RPC stay
# on the box (self-hosted — no third-party prover, no PROVE token). Outbound-only:
# the box never accepts inbound, so it works behind vast NAT.
#
# Idempotent: before proving it reads the pool's knownReflectionDigest; if the
# batch's newDigest already landed (a lost ack), it just re-acks and moves on —
# the digest-chain means a re-submit would revert, never double-attest.
#
# Env (required unless noted):
#   WORKER_BASE   worker base URL (serves /reflection/job, accepts /reflection/ack)
#   NETWORK       'mainnet' | 'signet'            (default mainnet)
#   POOL_ADDR     deployed ConfidentialPool address
#   RPC_URL       Ethereum RPC
#   RELAY_KEY     funded key paying for attestBitcoinStateProven (0x-hex)
#   POLL_SECS     idle poll interval              (default 120)
#   CXFER_DIR     box work dir                    (default /root/work/cxfer)
#
# Setup once (see RUNBOOK-confidential-pool-deploy.md): cp exec-reflect-prove.rs
# → exec/src/main.rs, cargo prove build the guest, start sp1-gpu-server.
# Requires: cargo + SP1 toolchain, foundry (cast), jq, curl, a running sp1-gpu-server.
# ─────────────────────────────────────────────────────────────────────────────

source ~/.cargo/env 2>/dev/null || true
export PATH="$PATH:/root/.sp1/bin:/root/.foundry/bin"

WORKER_BASE="${WORKER_BASE:?set WORKER_BASE}"
NETWORK="${NETWORK:-mainnet}"
POOL_ADDR="${POOL_ADDR:?set POOL_ADDR}"
RPC_URL="${RPC_URL:?set RPC_URL}"
RELAY_KEY="${RELAY_KEY:?set RELAY_KEY}"
# Bearer token = worker CONFIDENTIAL_BOX_TOKEN/DEBUG_TOKEN. The /reflection/* routes are
# box-only (the ack advances the un-rewindable Bitcoin cursor — an unauthenticated POST could
# freeze every cross-lane / bridge_mint gate), so the loop must authenticate like the settle loop.
BOX_TOKEN="${BOX_TOKEN:?set BOX_TOKEN}"
POLL_SECS="${POLL_SECS:-120}"
CXFER="${CXFER_DIR:-/root/work/cxfer}"

log() { echo "[reflection-relay $(date -u +%H:%M:%S)] $*"; }

ack() { # attestedTo txHash
  curl -fsS -X POST "$WORKER_BASE/reflection/ack" -H "authorization: Bearer $BOX_TOKEN" -H 'content-type: application/json' \
    -d "{\"network\":\"$NETWORK\",\"attestedTo\":$1,\"txHash\":\"${2:-}\"}" >/dev/null 2>&1 \
    || log "ack failed (worker will re-serve; on-chain idempotent via digest-chain)"
}

log "starting — worker=$WORKER_BASE network=$NETWORK pool=$POOL_ADDR poll=${POLL_SECS}s"
while true; do
  JOB=$(curl -fsS "$WORKER_BASE/reflection/job?network=$NETWORK" -H "authorization: Bearer $BOX_TOKEN" 2>/dev/null || echo '{}')
  if [ -z "$(echo "$JOB" | jq -r '.input // empty')" ]; then sleep "$POLL_SECS"; continue; fi

  ATTESTED_TO=$(echo "$JOB" | jq -r '.attestedTo')
  NEW_DIGEST=$(echo "$JOB" | jq -r '.input.newDigest')

  # Idempotency: if the batch already landed on-chain (lost ack), just re-ack and skip.
  ONCHAIN=$(cast call "$POOL_ADDR" 'knownReflectionDigest()(bytes32)' --rpc-url "$RPC_URL" 2>/dev/null || echo "")
  if [ "$ONCHAIN" = "$NEW_DIGEST" ]; then
    log "batch newDigest already attested on-chain — re-acking attestedTo=$ATTESTED_TO"
    ack "$ATTESTED_TO" ""; continue
  fi

  echo "$JOB" | jq -c '.input' > "$CXFER/fixtures/reflection_input.json"
  log "job attestedTo=$ATTESTED_TO pending=$(echo "$JOB" | jq -r '.pending') — proving (groth16/gpu)..."

  if ! (cd "$CXFER/exec" && cargo run --release >/tmp/reflect-prove.log 2>&1); then
    # the cuda client panics in a harmless cleanup destructor AFTER writing the artifacts; treat a
    # present, fresh proof as success regardless of the exit code.
    if ! grep -q "WROTE reflect_public_values.hex" /tmp/reflect-prove.log; then
      log "prove failed (see /tmp/reflect-prove.log) — retrying job"; sleep "$POLL_SECS"; continue
    fi
  fi
  PV="0x$(cat "$CXFER/exec/reflect_public_values.hex")"
  PROOF="0x$(cat "$CXFER/exec/reflect_proof_bytes.hex")"

  TX=$(cast send "$POOL_ADDR" 'attestBitcoinStateProven(bytes,bytes)' "$PV" "$PROOF" \
    --rpc-url "$RPC_URL" --private-key "$RELAY_KEY" --json 2>/tmp/reflect-send.log \
    | jq -r '.transactionHash // empty')
  if [ -z "$TX" ]; then log "submit failed (see /tmp/reflect-send.log) — retrying job"; sleep 30; continue; fi

  log "attested: tx=$TX"
  ack "$ATTESTED_TO" "$TX"
done
