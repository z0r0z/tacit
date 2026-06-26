#!/usr/bin/env bash
# box-reprove.sh — canonical prover-box driver for a coordinated confidential-pool re-prove.
#
# Run this ON THE VAST PROVER BOX after a guest change to regenerate every settle + reflection Groth16
# fixture against the freshly-derived vkeys. Hardened against the things that make a hand-driven re-prove
# painful:
#   • the vast SSH proxy dropping long sessions   -> everything writes to files; run it detached + poll.
#   • a flaky/​wedged GPU server                    -> per-op `timeout` + ONE auto-retry with a full GPU reset.
#   • pkill matching your own ssh command strings  -> `pkill -x` (exact process name) only.
#   • stale proofs masquerading as "done"          -> each proof is stamped with the vkey it was made
#                                                     against; an op is re-proven unless its stamp == the
#                                                     CURRENT vkey (so a prior run's old-vkey proof is redone).
#   • four different prove mechanisms per op family -> one op registry; the runner picks the mechanism.
#
# Usage (on the box, detached):
#   setsid nohup bash box-reprove.sh > /root/box-reprove.out 2>&1 < /dev/null &
#   # poll:        grep -E 'OK|FAIL|DONE' /root/reprove_status.log
#   # rebuild first (guest ELF changed):  REBUILD=1 setsid nohup bash box-reprove.sh ...
#   # one op only:                        ONLY=cdp_mint bash box-reprove.sh
#
# Output (under $OUT): <tag>_pv.hex + <tag>_pb.hex + <tag>.vkey per op, and reprove_manifest.tsv
# (tag <tab> vkey <tab> pv_bytes <tab> status). The new PROGRAM_VKEY / BITCOIN_RELAY_VKEY are logged up top.
# Pull side: scp the out/ artifacts back; scripts/confidential-reprove-apply.sh assembles the *_groth16.json
# (each = {vkey, publicValues=<pv.hex>, proofBytes=<pb.hex>}) and bumps elf-vkey-pin.json + DeployConfidentialPool.
set -uo pipefail

# ── config (override via env to match a different box layout) ──
WORK=${WORK:-/root/work}; GUEST=$WORK/confidential; HOST=$WORK/prover-host
FX=${FX:-$GUEST/fixtures}; OUT=${OUT:-$HOST/out}; SP1=${SP1:-/root/.sp1/bin}
EXECDIR=${EXECDIR:-$WORK/cxfer/exec}            # where the per-op cargo harnesses drop public_values.hex
STATUS=${STATUS:-/root/reprove_status.log}; TIMEOUT=${TIMEOUT:-700}; GPU_WAIT=${GPU_WAIT:-30}
ONLY=${ONLY:-}                                   # prove only this tag (else all)
export PATH="$SP1:$HOME/.cargo/bin:$PATH"; [ -f /root/.cargo/env ] && source /root/.cargo/env
mkdir -p "$OUT"; : > "$STATUS"
log(){ echo "[$(date -u +%H:%M:%S)] $*" >> "$STATUS"; }

# ── GPU server lifecycle (exact-name kills only) ──
gpu_down(){ pkill -9 -x sp1-gpu-server 2>/dev/null; rm -f /tmp/sp1-cuda-0.sock; }
gpu_up(){ gpu_down; sleep 3; CUDA_VISIBLE_DEVICES=0 setsid nohup sp1-gpu-server >/tmp/gpu.log 2>&1 </dev/null &
          for _ in $(seq 1 "$GPU_WAIT"); do sleep 2; [ -S /tmp/sp1-cuda-0.sock ] && return 0; done
          log "WARN gpu socket did not appear"; return 1; }

# ── optional rebuild (guest ELF + host bins) ──
if [ "${REBUILD:-0}" = "1" ]; then
  log "REBUILD guest ELFs (cargo prove build)"; ( cd "$GUEST" && cargo prove build ) >>"$STATUS.build" 2>&1 \
    || { log "FATAL guest build failed (see $STATUS.build)"; exit 1; }
  log "REBUILD host bins (cargo build --release)"; ( cd "$HOST" && cargo build --release ) >>"$STATUS.build" 2>&1 \
    || { log "FATAL host build failed"; exit 1; }
fi

# ── derive the current vkeys (the source of truth for skip/stamp) ──
log "deriving vkeys..."
VK=$( cd "$HOST" && cargo run --release --bin derive_vkeys 2>/dev/null )
PVK=$(grep -oE 'PROGRAM_VKEY=0x[0-9a-f]+' <<<"$VK" | cut -d= -f2)
RVK=$(grep -oE 'BITCOIN_RELAY_VKEY=0x[0-9a-f]+' <<<"$VK" | cut -d= -f2)
[ -n "$PVK" ] && [ -n "$RVK" ] || { log "FATAL could not derive vkeys: $VK"; exit 1; }
log "PROGRAM_VKEY=$PVK"; log "BITCOIN_RELAY_VKEY=$RVK"

# ── result bookkeeping ──
stamped(){ [ -s "$OUT/$1_pv.hex" ] && [ "$(cat "$OUT/$1.vkey" 2>/dev/null)" = "$2" ]; }
finish(){ # tag vkey logfile
  local tag=$1 vkey=$2 lf=$3 pv; pv=$(wc -c <"$OUT/$tag"_pv.hex 2>/dev/null || echo 0)
  if [ -s "$OUT/$tag"_pv.hex ] && grep -q LOCAL_VERIFY_OK "$lf" 2>/dev/null; then
    echo "$vkey" > "$OUT/$tag.vkey"; printf '%s\t%s\t%s\tOK\n' "$tag" "$vkey" "$pv" >> "$OUT/reprove_manifest.tsv"
    log "OK   $tag pv=$pv"; return 0
  fi
  printf '%s\t%s\t%s\tFAIL\n' "$tag" "$vkey" "$pv" >> "$OUT/reprove_manifest.tsv"
  log "FAIL $tag $(grep -oE 'timeout|panicked|No such file|error\[[0-9]+' "$lf" 2>/dev/null | head -1)"; return 1
}

# ── prover mechanisms (each leaves $OUT/<tag>_pv.hex + <tag>_pb.hex) ──
pf_gap(){  local tag=$1 op=$2 fxt=$3
  GAP_FIXTURE=$FX/${fxt}_op.json GAP_OP=$op GAP_TAG=$tag CUDA_VISIBLE_DEVICES=0 \
    timeout "$TIMEOUT" "$HOST/target/release/exec_gap" >"/root/$tag.log" 2>&1 || true; }
# exec_farm prepends "farm_" to FARM_TAG and writes out/farm_<short>_pv.hex itself; run via cargo (the prebuilt
# binary intermittently dies with a CudaClient "early eof" at setup — the retry in prove() recovers).
pf_farm(){ local tag=$1 short=$2 op=$3 fxt=$4
  ( cd "$HOST" && FARM_FIXTURE=$FX/$fxt FARM_OP=$op FARM_TAG=$short CUDA_VISIBLE_DEVICES=0 \
    timeout "$TIMEOUT" cargo run --release --bin exec_farm ) >"/root/$tag.log" 2>&1 || true; }
# bins that write out/<tag>_pv.hex themselves (exec_crosslane), driven by cargo — no copy from $EXECDIR.
pf_xbin(){ local tag=$1 bin=$2 fx=$3
  ( cd "$HOST" && OP_FILE=$FX/$fx MODE=groth16 CUDA_VISIBLE_DEVICES=0 \
    timeout "$TIMEOUT" cargo run --release --bin "$bin" ) >"/root/$tag.log" 2>&1 || true; }
pf_perop(){ local tag=$1 harn=$2 bin=$3 fx=$4
  if [ -n "$harn" ]; then cp -f "$GUEST/harnesses/$harn" "$HOST/src/bin/$bin.rs"
    grep -q "name = \"$bin\"" "$HOST/Cargo.toml" || printf '\n[[bin]]\nname="%s"\npath="src/bin/%s.rs"\n' "$bin" "$bin" >>"$HOST/Cargo.toml"; fi
  rm -f "$EXECDIR/public_values.hex" "$EXECDIR/proof_bytes.hex"
  ( cd "$HOST" && OP_FILE=$FX/$fx MODE=groth16 CUDA_VISIBLE_DEVICES=0 timeout "$TIMEOUT" cargo run --release --bin "$bin" ) >"/root/$tag.log" 2>&1 || true
  cp -f "$EXECDIR/public_values.hex" "$OUT/${tag}_pv.hex" 2>/dev/null || true
  cp -f "$EXECDIR/proof_bytes.hex"   "$OUT/${tag}_pb.hex" 2>/dev/null || true; }
pf_refl(){ local tag=$1 fx=$2
  rm -f "$OUT/bitcoin_pv.hex" "$OUT/bitcoin_proof_bytes.hex"
  ( cd "$HOST" && PROOF_MODE=groth16 REFLECT_FIXTURE=$FX/$fx CUDA_VISIBLE_DEVICES=0 timeout "$TIMEOUT" ./target/release/bitcoin_prove ) >"/root/$tag.log" 2>&1 || true
  cp -f "$OUT/bitcoin_pv.hex"          "$OUT/${tag}_pv.hex" 2>/dev/null || true
  cp -f "$OUT/bitcoin_proof_bytes.hex" "$OUT/${tag}_pb.hex" 2>/dev/null || true; }

# ── driver: skip-if-stamped, else up to 2 attempts (fresh GPU each), then record ──
prove(){ local tag=$1 vkey=$2 fn=$3; shift 3
  [ -n "$ONLY" ] && [ "$ONLY" != "$tag" ] && return 0
  if stamped "$tag" "$vkey"; then log "skip $tag (already proven against $vkey)"; return 0; fi
  local a
  for a in 1 2; do
    log "prove $tag (attempt $a/2)"
    gpu_up || { gpu_down; sleep 4; continue; }
    "$fn" "$tag" "$@"
    if [ -s "$OUT/${tag}_pv.hex" ] && grep -q LOCAL_VERIFY_OK "/root/$tag.log" 2>/dev/null; then break; fi
    log "  $tag attempt $a did not verify: $(grep -oE 'timeout|panicked|No such file|error\[[0-9]+' /root/$tag.log 2>/dev/null | head -1)"
    gpu_down; sleep 4
  done
  finish "$tag" "$vkey" "/root/$tag.log"
}

: > "$OUT/reprove_manifest.tsv"
# ── op registry: <tag> <vkey> <mechanism> <args...> ; tag == the local *_groth16.json basename ──
# gap ops (exec_gap, op code + <fxt>_op.json):
prove cdp_mint        "$PVK" pf_gap   15 cdp_mint
prove cdp_close       "$PVK" pf_gap   16 cdp_close
prove cdp_liquidate   "$PVK" pf_gap   17 cdp_liquidate
prove cbtc_mint       "$PVK" pf_gap   18 cbtc_mint
prove cdp_topup       "$PVK" pf_gap   19 cdp_topup
prove swap_route      "$PVK" pf_gap   11 swap_route
prove adaptor_lock    "$PVK" pf_gap   12 adaptor_lock
prove adaptor_claim   "$PVK" pf_gap   13 adaptor_claim
prove adaptor_refund  "$PVK" pf_gap   14 adaptor_refund
prove lp_remove       "$PVK" pf_gap    8 lp_remove
# per-op harness ops (cargo run --bin exec_<x>, OP_FILE=<fx>, MODE=groth16):
prove swap            "$PVK" pf_perop exec-swap.rs  exec_swap       swap_op.json
prove lp              "$PVK" pf_perop exec-lp.rs    exec_lp         lp_op.json
prove otc             "$PVK" pf_perop exec-otc.rs   exec_otc        otc_op.json
prove bid             "$PVK" pf_perop exec-bid.rs   exec_bid        bid_op.json
prove confidential    "$PVK" pf_perop exec-prove.rs exec_prove      transfer_op.json
prove unwrap          "$PVK" pf_perop exec-unwrap.rs exec_unwrap     unwrap_op.json
prove wrap            "$PVK" pf_perop exec-wrap.rs   exec_wrap       wrap_op.json
prove swapbatch       "$PVK" pf_perop exec-swap.rs   exec_swapbatch  swapbatch_op.json
prove mixed           "$PVK" pf_perop exec-mixed.rs  exec_mixed      mixed_op.json
prove bridgestealthmint  "$PVK" pf_perop exec-bridgestealthmint.rs exec_bridgestealthmint bridgestealthmint_op.json
prove stealthlockbatch   "$PVK" pf_perop exec-stealthlockbatch.rs  exec_stealthlockbatch  stealthlockbatch_op.json
prove stealthclaim       "$PVK" pf_perop exec-stealthclaim.rs      exec_stealthclaim      stealthclaim_op.json
prove stealthrefund      "$PVK" pf_perop exec-stealthrefund.rs     exec_stealthrefund     stealthrefund_op.json
prove crosslane       "$PVK" pf_xbin  exec_crosslane  crosslane_op.json
# farm ops (exec_farm via cargo, short tag + farm_<x>_op.json):
prove farm_bond       "$PVK" pf_farm  bond    20 farm_bond_op.json
prove farm_harvest    "$PVK" pf_farm  harvest 21 farm_harvest_op.json
prove farm_unbond     "$PVK" pf_farm  unbond  22 farm_unbond_op.json
# reflection ops (bitcoin_prove, REFLECT_FIXTURE) — bound to the RELAY vkey:
prove reflection              "$RVK" pf_refl reflection_input.json
prove reflection_burn_deposit "$RVK" pf_refl reflection_burn_deposit.json

gpu_down
oks=$(grep -c $'\tOK$' "$OUT/reprove_manifest.tsv" 2>/dev/null || echo 0)
fails=$(grep -c $'\tFAIL$' "$OUT/reprove_manifest.tsv" 2>/dev/null || echo 0)
log "REPROVE_DONE ok=$oks fail=$fails  (manifest: $OUT/reprove_manifest.tsv)"
