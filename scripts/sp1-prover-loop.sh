#!/bin/bash
set -euo pipefail

# tETH Bridge: continuous SP1 prover loop for vast.ai.
#
# Runs on the instance. Each cycle advances the Bitcoin light relay to a bounded
# target, generates an SP1 proof of the pool-state transition over exactly those
# blocks (so lastBlockHash == RELAY.tip()), and submits it to the verifier.
#
# Setup once: scripts/vastai-setup.sh (installs Rust + Foundry, builds the host
# which embeds the committed canonical guest ELF — no SP1 toolchain / guest build).
#
# Required env:
#   ETH_PK              Ethereum key for proof submission + relay advance
#   MIXER_ADDRESS       deployed TacitBridgeMixer (no 0x)
#   VERIFIER_ADDRESS    deployed SP1PoolRootVerifier (no 0x)
#   RELAY_ADDRESS       deployed relay (no 0x)
#   ASSET_ID            asset id (no 0x)
#   DEPLOY_BLOCK        ETH deploy block (hex) — deposit-event scan start
#   FIRST_DEPOSIT_BLOCK relay genesis height + 1 (first block the genesis proof covers)
# Optional env:
#   GENESIS_ANCHOR      relay genesis block hash (the guest's genesis prev_block)
#   NETWORK (signet|mainnet) | ETH_RPC | BLOCKS_PER_PROOF (10) | CONFIRMATIONS (6)
#   SLEEP_SECONDS (600) | STATE_DIR | SP1_PROVER (cpu|cuda) | POOL_IDS | DEPOSIT_ROOTS_FILE

REPO_DIR="${REPO_DIR:-/workspace/tacit}"
STATE_DIR="${STATE_DIR:-/workspace/prover-state}"
BLOCKS_PER_PROOF="${BLOCKS_PER_PROOF:-10}"
SLEEP_SECONDS="${SLEEP_SECONDS:-600}"

# Network config
NETWORK="${NETWORK:-signet}"
if [[ "$NETWORK" == "mainnet" ]]; then
  BTC_API="${BTC_API:-https://mempool.space/api}"
  ETH_RPC="${ETH_RPC:-https://ethereum-rpc.publicnode.com}"
  NETWORK_TAG=0
  CHAIN_ID=1
else
  BTC_API="${BTC_API:-https://mempool.space/signet/api}"
  ETH_RPC="${ETH_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
  ASSET_ID="${ASSET_ID:-d903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b}"
  NETWORK_TAG=1
  CHAIN_ID=11155111
fi

# Deployment-specific (no stale defaults, no 0x).
MIXER_ADDRESS="${MIXER_ADDRESS:?Set MIXER_ADDRESS (deployed mixer, no 0x)}"
VERIFIER_ADDRESS="${VERIFIER_ADDRESS:?Set VERIFIER_ADDRESS (deployed SP1 verifier, no 0x)}"
RELAY_ADDRESS="${RELAY_ADDRESS:?Set RELAY_ADDRESS (deployed relay, no 0x)}"
ASSET_ID="${ASSET_ID:?Set ASSET_ID (asset id, no 0x)}"
DEPLOY_BLOCK="${DEPLOY_BLOCK:?Set DEPLOY_BLOCK (ETH deploy block, hex)}"
FIRST_DEPOSIT_BLOCK="${FIRST_DEPOSIT_BLOCK:?Set FIRST_DEPOSIT_BLOCK (relay genesis height + 1)}"
GENESIS_ANCHOR="${GENESIS_ANCHOR:-}"
CONFIRMATIONS="${CONFIRMATIONS:-6}"
# Tacit-unit (8-dec) denominations the guest tracks, comma-separated.
DENOMINATIONS="${DENOMINATIONS:-000186a0,000f4240,00989680,05f5e100,3b9aca00,02540be400}"
POOL_IDS="${POOL_IDS:-}"

ETH_PK="${ETH_PK:?Set ETH_PK (Ethereum private key)}"
SP1_PROVER="${SP1_PROVER:-cpu}"

# cuda needs the sp1-sdk/cuda feature compiled in (separate target dir so it
# doesn't clobber the cpu build) and the native sp1-gpu-server running. Dense
# mainnet blocks make cpu proving impractical, so mainnet runs SP1_PROVER=cuda.
PROVER_FEATURES=""; PROVER_TARGET=""
GPU_RESTART_EVERY="${GPU_RESTART_EVERY:-15}"
CYCLE_COUNT=0
if [[ "$SP1_PROVER" == "cuda" ]]; then
  PROVER_FEATURES="--features sp1-sdk/cuda"
  PROVER_TARGET="${CUDA_TARGET_DIR:-${REPO_DIR}/contracts/sp1/script/target-cuda}"
fi

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

get_relay_tip() {
  # tipHeight() selector 0x1fd4827a. Empty return on RPC failure would crash
  # the `while [[ -lt ]]` in run_proof_cycle under `set -e`; caller must
  # check for empty and skip the cycle rather than feed it to numeric ops.
  curl -sf -X POST "$ETH_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x${RELAY_ADDRESS}\",\"data\":\"0x1fd4827a\"},\"latest\"]}" \
    | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'], 16))" 2>/dev/null
}
get_btc_tip() { curl -sf "${BTC_API}/blocks/tip/height" 2>/dev/null; }

# Sanity-check that the foundry `cast` is actually on PATH. Without it,
# both submit_proof and the relay-advance pipeline silently get treated as
# "tx reverted" — the loop spins forever without progress. Fail loud.
command -v cast >/dev/null 2>&1 || { log "FATAL: cast not on PATH — add ~/.foundry/bin to PATH before launching"; exit 1; }
get_last_proven_height() {
  [[ -f "${STATE_DIR}/last_proven_block.txt" ]] && cat "${STATE_DIR}/last_proven_block.txt" || echo "0"
}

submit_proof() {
  local pv proof
  [[ -f "${STATE_DIR}/public_values.hex" && -f "${STATE_DIR}/proof_bytes.hex" ]] || { log "ERROR: submission files missing"; return 1; }
  pv=$(cat "${STATE_DIR}/public_values.hex"); proof=$(cat "${STATE_DIR}/proof_bytes.hex")
  # depositAccs + burn claims ride in the authenticated public-values tail → (pv, proof).
  log "Submitting to verifier 0x${VERIFIER_ADDRESS} (pv ${#pv} hex, proof ${#proof} hex)..."
  local result
  result=$(cast send "0x${VERIFIER_ADDRESS}" 'proveStateTransition(bytes,bytes)' \
    "0x${pv}" "0x${proof}" --rpc-url "$ETH_RPC" --private-key "$ETH_PK" --gas-limit 1500000 2>&1) || true
  # Tightened pattern: cast send prints "status               1 (success)" on
  # success, "status               0 (failed)" on revert. The loose `status.*1`
  # was prone to false positives matching `transactionIndex 1*` etc. — anchor
  # to whitespace + "1" + non-digit so 10, 11, etc. don't false-positive.
  if echo "$result" | grep -qE "status[[:space:]]+1[[:space:]]+\("; then
    log "Proof accepted on-chain!"
  else
    log "Proof submission failed (full output below):"
    echo "$result"
    return 1
  fi
}

# GPU-prover (sp1-gpu-server) lifecycle. SP1 6.2.2's cuda client connects to a
# Unix socket; it does not reliably auto-spawn the server in an unprivileged
# container, and the server leaks GPU memory across many proofs (-> AllocError).
# So start it if absent, and force a fresh restart every GPU_RESTART_EVERY cycles.
ensure_gpu_server() {
  [[ "$SP1_PROVER" == "cuda" ]] || return 0
  local force_restart=0
  (( CYCLE_COUNT % GPU_RESTART_EVERY == 0 )) && force_restart=1
  if [[ "$force_restart" == "1" ]] || ! pgrep -f sp1-gpu-server >/dev/null; then
    pkill -f sp1-gpu-server 2>/dev/null || true; sleep 2; rm -f /tmp/sp1-cuda-0.sock
    CUDA_VISIBLE_DEVICES=0 setsid nohup "$HOME/.sp1/bin/sp1-gpu-server" >"${STATE_DIR}/gpu-server.log" 2>&1 </dev/null &
    sleep 14
    if pgrep -f sp1-gpu-server >/dev/null && [[ -S /tmp/sp1-cuda-0.sock ]]; then
      log "gpu-server (re)started"
    else
      log "WARNING: gpu-server not up after restart — proof will fail; check ${STATE_DIR}/gpu-server.log"
    fi
  fi
}

run_proof_cycle() {
  local last_proven btc_tip start_height target max_confirmed relay_tip num_blocks
  ensure_gpu_server
  last_proven=$(get_last_proven_height)
  btc_tip=$(get_btc_tip)
  [[ -n "$btc_tip" ]] || { log "could not fetch Bitcoin tip"; return 1; }

  if [[ "$last_proven" == "0" ]]; then start_height=$FIRST_DEPOSIT_BLOCK; else start_height=$((last_proven + 1)); fi

  # Bounded batch ending exactly at the relay tip (verifier needs lastBlockHash == RELAY.tip()).
  target=$((start_height + BLOCKS_PER_PROOF - 1))
  max_confirmed=$((btc_tip - CONFIRMATIONS))
  [[ "$target" -gt "$max_confirmed" ]] && target=$max_confirmed
  if [[ "$target" -lt "$start_height" ]]; then
    log "Waiting for confirmed Bitcoin blocks (start=$start_height, confirmed=$max_confirmed)"; return 1
  fi

  # Advance the relay to exactly $target, in <=20-header chunks.
  relay_tip=$(get_relay_tip)
  [[ -n "$relay_tip" ]] || { log "could not fetch relay tip (RPC unreachable?); skipping cycle"; return 1; }
  while [[ "$relay_tip" -lt "$target" ]]; do
    local chunk_end=$((relay_tip + 20)); [[ "$chunk_end" -gt "$target" ]] && chunk_end=$target
    log "Advancing relay $relay_tip -> $chunk_end"
    local headers=""
    for h in $(seq $((relay_tip + 1)) "$chunk_end"); do
      local bh hdr
      bh=$(curl -sf "${BTC_API}/block-height/$h")
      hdr=$(curl -sf "${BTC_API}/block/$bh/header")
      # Each Bitcoin header is exactly 80 bytes = 160 hex chars. A short or
      # empty fetch (mempool.space hiccup) silently corrupts the headers
      # blob; cast send then reverts in the relay's parser and we waste a
      # cycle. Bail out and let the next cycle retry.
      if [[ ${#hdr} -ne 160 ]]; then
        log "Header fetch for $h returned ${#hdr} hex chars (expected 160); skipping cycle"
        return 1
      fi
      headers+="$hdr"
    done
    local relay_out
    relay_out=$(cast send "0x${RELAY_ADDRESS}" 'advanceTip(bytes)' "0x${headers}" \
        --rpc-url "$ETH_RPC" --private-key "$ETH_PK" --gas-limit 3000000 2>&1) || true
    if ! echo "$relay_out" | grep -qE "status[[:space:]]+1"; then
      log "Relay advance failed ($relay_tip -> $chunk_end):"
      echo "$relay_out" | tail -10
      return 1
    fi
    relay_tip=$(get_relay_tip)
    [[ -n "$relay_tip" ]] || { log "lost relay tip mid-advance; skipping rest of cycle"; return 1; }
  done

  num_blocks=$((target - start_height + 1))
  log "Proving blocks $start_height..$target ($num_blocks) up to relay tip"

  # Fetch published CXFER openings from the worker so the bridge guest can
  # verify Pedersen conservation on tETH CXFER outputs (without them the
  # guest removes spent inputs but creates no outputs → recipients can't
  # import + redeem ETH). Helper iterates the block range, queries the
  # worker per (txid, vout), writes the JSON file CXFER_WITNESSES_PATH points
  # at. Non-fatal: empty file = no openings = guest treats every CXFER as
  # untracked (same as before this wiring).
  local witnesses_file="${STATE_DIR}/cxfer-witnesses.json"
  local worker_base="${WORKER_BASE:-https://tacit-pin.rosscampbell9.workers.dev}"
  if command -v python3 >/dev/null 2>&1; then
    log "Fetching CXFER openings for blocks $start_height..$target from worker"
    python3 "${REPO_DIR}/scripts/fetch-cxfer-openings.py" \
      --start-height "$start_height" --num-blocks "$num_blocks" \
      --network "$NETWORK" --worker-base "$worker_base" \
      --output "$witnesses_file" 2>&1 | tee -a "${STATE_DIR}/last_proof.log" >/dev/null || {
      log "  CXFER opening fetch failed (continuing with no witnesses)"
      echo "[]" > "$witnesses_file"
    }
  else
    log "  python3 not available — skipping CXFER opening fetch"
    echo "[]" > "$witnesses_file"
  fi

  # STATE_FILE: incremental-proving persistence. Host loads at cycle start
  # (if matches verifier), saves after a successful prove cycle (extracts
  # the SP1-authenticated state tail from public values). See
  # ops/prover-incremental-state.md.
  local state_file="${STATE_DIR}/prover-state.json"

  cd "${REPO_DIR}/contracts/sp1/script"
  # Clear stale artifacts from any prior cycle so `[[ -f public_values.hex ]]`
  # below + submit_proof don't accidentally re-submit a leftover proof when
  # `cargo run` crashes mid-cycle. Without this, a failed prove would let
  # the loop re-submit the PRIOR cycle's proof → verifier reverts on stale
  # prev_state → the loop spins indefinitely with no progress.
  rm -f "${STATE_DIR}/public_values.hex" "${STATE_DIR}/proof_bytes.hex" "${STATE_DIR}/proof.bin"
  # Also clear any leftover STATE_FILE.staging from a prior submit failure —
  # the staging file represents an UNCOMMITTED post-cycle state that should
  # not affect the next cycle's load (which uses the LAST KNOWN-GOOD
  # STATE_FILE). Host re-writes staging during this cycle.
  rm -f "${state_file}.staging"
  ASSET_ID="$ASSET_ID" MIXER_ADDRESS="$MIXER_ADDRESS" DENOMINATIONS="$DENOMINATIONS" \
  NETWORK="$NETWORK" NETWORK_TAG="$NETWORK_TAG" CHAIN_ID="$CHAIN_ID" DEPLOY_BLOCK="$DEPLOY_BLOCK" \
  STATE_DIR="$STATE_DIR" OUTPUT_DIR="$STATE_DIR" ETH_RPC="$ETH_RPC" SP1_PROVER="$SP1_PROVER" \
  CXFER_WITNESSES_PATH="$witnesses_file" STATE_FILE="$state_file" \
  ${POOL_IDS:+POOL_IDS="$POOL_IDS"} ${DEPOSIT_ROOTS_FILE:+DEPOSIT_ROOTS_FILE="$DEPOSIT_ROOTS_FILE"} \
  ${PROVER_TARGET:+CARGO_TARGET_DIR="$PROVER_TARGET"} \
  cargo run --release $PROVER_FEATURES --bin teth-prover -- \
    --start-height "$start_height" --num-blocks "$num_blocks" --onchain 2>&1 | tee "${STATE_DIR}/last_proof.log"

  [[ -f "${STATE_DIR}/public_values.hex" ]] || { log "ERROR: proof artifacts not generated"; return 1; }
  submit_proof || return 1
  # Commit staged STATE_FILE only after on-chain submit succeeded — closes
  # the race where the host-side save would leave the file ahead of the
  # verifier after a submit failure, bricking every subsequent cycle on
  # stale-state panic. Atomic mv preserves the prior file until the new
  # one's contents are fully written.
  if [[ -f "${state_file}.staging" ]]; then
    mv "${state_file}.staging" "${state_file}"
    log "STATE_FILE committed (post-cycle state persisted)"
  fi
  echo "$target" > "${STATE_DIR}/last_proven_block.txt"
  log "Cycle complete: blocks $start_height-$target proven and accepted"
}

log "=== tETH SP1 Prover Loop ==="
log "  Network: $NETWORK | Prover: $SP1_PROVER | Blocks/proof: $BLOCKS_PER_PROOF"
log "  Mixer 0x$MIXER_ADDRESS | Verifier 0x$VERIFIER_ADDRESS | Relay 0x$RELAY_ADDRESS"
log ""
while true; do
  run_proof_cycle || log "Proof cycle skipped"
  CYCLE_COUNT=$((CYCLE_COUNT + 1))
  log "Sleeping ${SLEEP_SECONDS}s..."
  sleep "$SLEEP_SECONDS"
done
