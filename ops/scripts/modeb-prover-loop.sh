#!/usr/bin/env bash
# Durable Mode-B prover loop (ETH→BTC redemption) — runs on the vast.ai GPU prover box.
#
# This is the production sibling of contracts/sp1/eth-reflection/prover-host/run-reflect-loop.sh. Where the
# base reflect loop runs eth_prove→bitcoin_prove on EVERY cycle, this loop gates the expensive Mode-B
# recursion (the helios eth_prove + the inner-proof bitcoin_prove mode_b=1) on there actually being a NEW
# Bitcoin-destined crossOut to fold. A no-crossout cycle skips the eth recursion and does the cheap forward
# attest instead (the same single-ELF groth16 the worker /reflection/job loop runs), so the on-chain
# Bitcoin-state digest stays current cheaply while reverse-bridge value still folds the cycle it appears.
#
# Each cycle:
#   1. POLL  — eth_getLogs CrossOutRecorded on the pool from the last-folded block (out/eth_set_state.json
#              last_block + 1) to (tip − CONFIRMATIONS), filtered to destChain==1 (Bitcoin). Any unfolded
#              entry ⇒ a Mode-B cycle; none ⇒ a forward cycle.
#   2a. MODE-B (a pending crossOut):
#        eth_prove          → POOL-bound eth-reflection COMPRESSED proof (helios light-client + the crossOut /
#                             consumed-ν witness set; emits out/eth_compressed.bin + eth_pv.hex + eth_set.json
#                             + eth_set_state.pending.json) against the LIVE Sepolia beacon/exec state.
#        REGEN_MODEB_CMD    → [optional] build the Bitcoin reflection fixture (modeB=1) from out/eth_set.json
#                             + the Bitcoin pool snapshot (the dapp buildModeBBatch via the reflection indexer).
#                             Omit only for a committed-fixture dry run.
#        bitcoin_prove      → the recursive Bitcoin reflection groth16 proof; mode_b=1 binds the eth inner proof
#                             (bitcoin_prove.rs:32-64, the ETH_REFLECTION_VKEY coherence guard runs here).
#        submit             → attestBitcoinStateProven via SUBMIT_URL (a relay queue). On success the pending
#                             eth_set_state is committed (host state advances only after the attest lands).
#   2b. FORWARD (no pending crossOut):
#        REGEN_FWD_CMD      → refresh the forward (modeB=0) reflection fixture from the Bitcoin pool snapshot.
#        bitcoin_prove      → forward groth16 proof (no eth recursion; the fixture's modeB=0 sentinel makes
#                             crossout_set_root=0 so every 0x65 mint skips).
#        submit             → attestBitcoinStateProven (the cheap forward attest).
#
# Durability mirrors run-reflect-loop.sh: per-cycle GPU cleanup (a stale sp1-gpu-server fills the card →
# "early eof"; the bracket trick keeps the pkill from matching this script), a heartbeat JSON for
# /prover-health, the last newDigest persisted, the `while` survives a cycle crash, and a `.catch`-style
# continue-with-logging on every failure (never a hard exit). For REBOOT survival install the @reboot cron
# (footer).
#
# ── Required env ──────────────────────────────────────────────────────────────
#   POOL                 deployed ConfidentialPool address (the crossOut source + the ethPool the guest binds)
#   GENESIS_SLOT         pinned bootstrap slot (reproducible prevSyncCommittee genesis; e.g. 10462624)
#   SOURCE_CONSENSUS_RPC Ethereum beacon (consensus) RPC      (e.g. https://ethereum-sepolia-beacon-api.publicnode.com)
#   SOURCE_CHAIN_ID      11155111 (Sepolia) | 1 (mainnet)
#   SOURCE_EXECUTION_RPC Ethereum execution RPC (eth_getLogs + eth_getProof; the crossOut poll uses it too)
# ── Optional env ──────────────────────────────────────────────────────────────
#   SUBMIT_URL           relay attest endpoint; UNSET ⇒ DRY-RUN (proof left in out/, host state not advanced)
#   DEPLOY_BLOCK         pool deploy block — the first-run lower bound for both eth_prove and the poll
#   CONFIRMATIONS        crossOut finality depth before folding (default 36; matches the worker consumer)
#   INTERVAL             idle poll interval, seconds          (default 600)
#   REGEN_MODEB_CMD      build the modeB=1 Bitcoin fixture from out/eth_set.json (reflection indexer)
#   REGEN_FWD_CMD        build the modeB=0 forward fixture (reflection indexer; falls back to REGEN_CMD)
#   REGEN_CMD            legacy alias used for the forward fixture if REGEN_FWD_CMD is unset
#   HOST                 prover-host dir (default /root/work/prover-host) — holds target/release + out/
#
# ── Box prerequisites (the immutable artifacts this loop drives) ──────────────
#   * the eth-reflection guest ELF built on the box at
#       /root/sp1-helios/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/eth_reflection
#     (include_bytes! into eth_prove + bitcoin_prove; its recursion vkey MUST match reflect.rs
#     ETH_REFLECTION_VKEY — bitcoin_prove.rs:48-57 asserts this LOUDLY before the GPU spend).
#   * the Bitcoin reflection guest ELF at
#       /root/work/confidential/target/.../release/reflection-prover
#   * $HOST/target/release/{eth_prove,bitcoin_prove} built (cargo build --release in prover-host).
#   * a running sp1-gpu-server (24GB card) + the SP1 toolchain + curl + jq + cast (foundry, for the poll).
#
# Run durable:  nohup setsid bash ops/scripts/modeb-prover-loop.sh >/dev/null 2>&1 &
# Health:       cat $HOST/loop-state/modeb-health.json

set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$HOME/.foundry/bin:$PATH"
HOST="${HOST:-/root/work/prover-host}"
OUT="$HOST/out"
STATE="$HOST/loop-state"; mkdir -p "$STATE"
HEALTH="$STATE/modeb-health.json"
LOG="$STATE/modeb-loop.out"
INTERVAL="${INTERVAL:-600}"
CONFIRMATIONS="${CONFIRMATIONS:-36}"
ETH_STATE="$OUT/eth_set_state.json"

: "${POOL:?set POOL=<deployed ConfidentialPool address>}"
: "${GENESIS_SLOT:?set GENESIS_SLOT=<pinned bootstrap slot, e.g. 10462624>}"
: "${SOURCE_CONSENSUS_RPC:?set SOURCE_CONSENSUS_RPC}"
: "${SOURCE_CHAIN_ID:?set SOURCE_CHAIN_ID}"
: "${SOURCE_EXECUTION_RPC:?set SOURCE_EXECUTION_RPC (eth_getLogs/getProof + the crossOut poll)}"

# keccak256("CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)") — the poll topic0. Matches
# eth_prove.rs co_sig and dapp/confidential-evm-log TOPIC0.CrossOutRecorded.
CO_TOPIC0="0x$(cast keccak 'CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)' 2>/dev/null | sed 's/^0x//')"
DEST_CHAIN_BITCOIN=1

ts() { date -u +%FT%TZ; }
heartbeat() { printf '{"ts":"%s","cycle":%d,"phase":"%s","status":"%s","mode":"%s","detail":"%s","last_digest":"%s"}\n' \
  "$(ts)" "$1" "$2" "$3" "$4" "$5" "$(cat "$STATE/modeb-last-digest.txt" 2>/dev/null || echo none)" > "$HEALTH"; }
gpu_clean() { pkill -9 -f "sp1-gpu-serve[r]" 2>/dev/null; rm -f /tmp/sp1-cuda-*.sock; sleep 2; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

hexint() { printf '0x%x' "$1"; }

# The execution tip via eth_blockNumber over SOURCE_EXECUTION_RPC. Echoes a decimal height, or empty on
# failure (the caller then skips the cycle — never folds against an unknown tip).
eth_tip() {
  local r
  r=$(curl -fsS -X POST "$SOURCE_EXECUTION_RPC" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null \
      | jq -r '.result // empty') || return 1
  [ -n "$r" ] || return 1
  printf '%d' "$r"
}

# Last execution block already folded by eth_prove (out/eth_set_state.json last_block). 0 if no state yet.
last_folded_block() {
  if [ -f "$ETH_STATE" ]; then jq -r '.last_block // 0' "$ETH_STATE" 2>/dev/null || echo 0; else echo 0; fi
}

# Poll: is there a NEW Bitcoin-destined CrossOutRecorded the eth accumulator hasn't folded yet? Scans
# eth_getLogs from (last_folded + 1, or DEPLOY_BLOCK on a cold box) to (tip − CONFIRMATIONS), filtered to
# destChain==1. Echoes the count of qualifying logs (0 ⇒ a forward cycle). This is the SAME scan eth_prove
# does internally; doing it cheaply here first avoids paying the helios prove on an idle cycle. Returns 0 on
# any RPC failure (fail toward the cheap forward cycle — never stall, and the next cycle re-polls; eth_prove
# itself re-scans authoritatively when it does run, so a missed log only defers the Mode-B fold one cycle).
pending_crossout_count() {
  local tip safe_tip from_block from_hex to_hex logs n
  tip=$(eth_tip) || { echo 0; return; }
  safe_tip=$(( tip - CONFIRMATIONS ))
  from_block=$(( $(last_folded_block) + 1 ))
  if [ "$from_block" -le 1 ]; then from_block="${DEPLOY_BLOCK:-0}"; fi
  if [ "$safe_tip" -lt "$from_block" ]; then echo 0; return; fi
  from_hex=$(hexint "$from_block"); to_hex=$(hexint "$safe_tip")
  logs=$(curl -fsS -X POST "$SOURCE_EXECUTION_RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"address\":\"$POOL\",\"fromBlock\":\"$from_hex\",\"toBlock\":\"$to_hex\",\"topics\":[\"$CO_TOPIC0\"]}]}" 2>/dev/null) \
    || { echo 0; return; }
  # destChain is the first 32-byte data word (uint16, right-aligned). Compare the leading-zero-stripped hex
  # string against DEST_CHAIN_BITCOIN's hex form (jq tonumber can't parse 0x-hex, so string-compare). Count
  # only destChain==1 (Bitcoin) logs; a destChain==2 (Ethereum) crossOut is not a Bitcoin mint, ignored here.
  n=$(echo "$logs" | jq -r --arg want "$(hexint "$DEST_CHAIN_BITCOIN" | sed 's/^0x//')" \
        '[.result[]? | select(((.data[2:66]) | sub("^0+";"") | if . == "" then "0" else . end) == $want)] | length' 2>/dev/null) \
    || { echo 0; return; }
  echo "${n:-0}"
}

# Submit a proved attest (groth16 PV + proof bytes left in out/ by bitcoin_prove). Echoes ok|fail. On a
# Mode-B success, commit the pending eth_set_state (host state advances only after the attest lands, keeping
# the box's accumulator aligned with the chain if a prove/submit fails). Telemetry-only newDigest (the full
# $PV is submitted): BitcoinReflectionPublicValues is a DYNAMIC tuple so abi_encode prepends a 0x20 offset
# word — newDigest (index 5) sits at word 6 = char 384 (see run-reflect-loop.sh).
submit_attest() { # $1 = mode (modeb|forward)  $2 = cycle
  local pv pb newdigest
  pv="$(cat "$OUT/bitcoin_pv.hex")"; pb="$(cat "$OUT/bitcoin_proof_bytes.hex")"
  newdigest="0x${pv:384:64}"
  if [ -z "${SUBMIT_URL:-}" ]; then
    echo "$newdigest" > "$STATE/modeb-last-digest.txt"
    log "cycle $2 [$1]: DRY-RUN proof ready newDigest=$newdigest (set SUBMIT_URL to attest)"
    heartbeat "$2" submit dry-run "$1" "$newdigest"; return
  fi
  if curl -fsS -X POST "$SUBMIT_URL" -H 'content-type: application/json' \
       -d "{\"publicValues\":\"0x$pv\",\"proofBytes\":\"0x$pb\"}" >>"$LOG" 2>&1; then
    [ "$1" = "modeb" ] && [ -f "$OUT/eth_set_state.pending.json" ] && mv "$OUT/eth_set_state.pending.json" "$ETH_STATE"
    echo "$newdigest" > "$STATE/modeb-last-digest.txt"
    log "cycle $2 [$1]: SUBMITTED newDigest=$newdigest"; heartbeat "$2" submit ok "$1" "$newdigest"
  else
    log "cycle $2 [$1]: SUBMIT FAILED"; heartbeat "$2" submit error "$1" "$newdigest"
  fi
}

log "modeb-loop start: POOL=$POOL GENESIS_SLOT=$GENESIS_SLOT chain=$SOURCE_CHAIN_ID conf=$CONFIRMATIONS interval=${INTERVAL}s submit=${SUBMIT_URL:-DRY-RUN}"
cycle=0
while true; do
  cycle=$((cycle+1))
  log "cycle $cycle begin"

  heartbeat "$cycle" poll running "?" ""
  N="$(pending_crossout_count)"
  log "cycle $cycle: pending Bitcoin-destined crossOut(s) = $N"

  if [ "${N:-0}" -gt 0 ] 2>/dev/null; then
    # ── Mode-B: prove the eth recursion, fold the crossOut, attest ─────────────
    heartbeat "$cycle" eth_prove running modeb ""
    gpu_clean
    if ! POOL="$POOL" GENESIS_SLOT="$GENESIS_SLOT" SOURCE_CONSENSUS_RPC="$SOURCE_CONSENSUS_RPC" \
         SOURCE_CHAIN_ID="$SOURCE_CHAIN_ID" SOURCE_EXECUTION_RPC="$SOURCE_EXECUTION_RPC" \
         DEPLOY_BLOCK="${DEPLOY_BLOCK:-0}" "$HOST/target/release/eth_prove" >>"$LOG" 2>&1; then
      log "cycle $cycle [modeb]: eth_prove FAILED"; heartbeat "$cycle" eth_prove error modeb ""; sleep "$INTERVAL"; continue
    fi

    if [ -n "${REGEN_MODEB_CMD:-}" ]; then
      heartbeat "$cycle" fixture running modeb ""
      if ! bash -c "$REGEN_MODEB_CMD" >>"$LOG" 2>&1; then
        log "cycle $cycle [modeb]: REGEN_MODEB_CMD failed"; heartbeat "$cycle" fixture error modeb ""; sleep "$INTERVAL"; continue
      fi
    fi

    heartbeat "$cycle" bitcoin_prove running modeb ""
    gpu_clean
    # bitcoin_prove reads modeB=1 from the fixture, loads out/eth_compressed.bin, runs the ETH_REFLECTION_VKEY
    # coherence guard (bitcoin_prove.rs:48-57), and recursively binds the eth proof. PROOF_MODE=groth16 = on-chain.
    if ! PROOF_MODE=groth16 "$HOST/target/release/bitcoin_prove" >>"$LOG" 2>&1; then
      log "cycle $cycle [modeb]: bitcoin_prove FAILED"; heartbeat "$cycle" bitcoin_prove error modeb ""; sleep "$INTERVAL"; continue
    fi
    submit_attest modeb "$cycle"
  else
    # ── Forward: cheap single-ELF attest (no eth recursion), keeps the digest current ──
    if [ -n "${REGEN_FWD_CMD:-${REGEN_CMD:-}}" ]; then
      heartbeat "$cycle" fixture running forward ""
      if ! bash -c "${REGEN_FWD_CMD:-${REGEN_CMD}}" >>"$LOG" 2>&1; then
        log "cycle $cycle [forward]: forward fixture regen failed"; heartbeat "$cycle" fixture error forward ""; sleep "$INTERVAL"; continue
      fi
    fi
    heartbeat "$cycle" bitcoin_prove running forward ""
    gpu_clean
    if ! PROOF_MODE=groth16 "$HOST/target/release/bitcoin_prove" >>"$LOG" 2>&1; then
      log "cycle $cycle [forward]: bitcoin_prove FAILED"; heartbeat "$cycle" bitcoin_prove error forward ""; sleep "$INTERVAL"; continue
    fi
    submit_attest forward "$cycle"
  fi

  sleep "$INTERVAL"
done

# ── Reboot durability ───────────────────────────────────────────────────────────
# The `while` survives a cycle crash; for box-reboot survival add a @reboot cron that relaunches this:
#   (crontab -l 2>/dev/null; echo "@reboot POOL=0x.. GENESIS_SLOT=10462624 SOURCE_CONSENSUS_RPC=https://ethereum-sepolia-beacon-api.publicnode.com SOURCE_CHAIN_ID=11155111 SOURCE_EXECUTION_RPC=https://sepolia.example/<key> SUBMIT_URL=https://api.tacit.finance/.. nohup setsid bash /root/tacit/ops/scripts/modeb-prover-loop.sh >/dev/null 2>&1 &") | crontab -
# Health JSON: $HOST/loop-state/modeb-health.json (phase/status/mode/last_digest, refreshed each step).
