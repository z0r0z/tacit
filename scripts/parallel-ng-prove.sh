#!/usr/bin/env bash
# parallel-ng-prove.sh — PARALLEL native-gnark re-prove driver (runs ON the vast box).
#
# v1 cloned the exec crate per worker (cp -r) which INVALIDATED cargo's build cache → every worker did a
# full from-scratch recompile of the SP1+gnark dep tree → 23 rustc instances thrashed → 0 proofs. v2 fixes
# this structurally:
#   BUILD phase (sequential, ONE exec dir, dep cache stays valid → ~30s/harness): each distinct harness is
#     compiled once and the self-contained binary (the guest ELF is include_bytes!'d in) is stashed in bins/.
#   RUN phase (parallel, cap N): the PREBUILT binaries run concurrently, each in its own run/<tag> CWD (the
#     harness writes CWD-relative artifacts — see the Task-1 relativization). No compile during proving → no
#     thrash. Per-op result files (run/<tag>/result) are assembled into the manifest at the end (no race).
# No GPU/sp1-gpu-server (harnesses are ProverClient::builder().cpu() native-gnark). Go must be on PATH.
set -uo pipefail
source ~/.cargo/env 2>/dev/null || true
export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"

N=${N:-10}                # RUN concurrency (proves only — no compile; watch load and tune)
TO=${TO:-2400}            # per-op timeout (s)
PVK=${PVK:?set PVK=<program vkey of the freshly-built settle ELF>}

CX=${CX:-/root/work/cxfer}
EXEC=$CX/exec; FX=$CX/fixtures; HARN=$CX/harnesses
OUT=${OUT:-$CX/out-v1}; BINS=$EXEC/bins; RUNROOT=$CX/run
mkdir -p "$OUT" "$BINS" "$RUNROOT"
STATUS=$CX/parallel.status; : > "$STATUS"
log(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$STATUS"; }

# Build toolchain (go for gnark-ffi, cargo) is only needed to BUILD bins. SKIP_BUILD=1 runs pre-copied
# bins on a toolchain-less box (e.g. a fresh high-RAM box), so don't gate on go/cargo there.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  command -v go    >/dev/null || { log "FATAL: go not found (gnark-ffi build needs it)"; exit 2; }
  command -v cargo >/dev/null || { log "FATAL: cargo not found"; exit 2; }
fi

# ── op table: "tag|kind|harness|env-string" — the SAME 29-op registry + mechanism map as box-reprove.sh,
#    but every groth16 prove is native-gnark CPU (each harness is ProverClient::builder().cpu()) and runs
#    via the v2 prebuilt-binary + concurrency-queue path below (NOT box-reprove.sh's CUDA host-bin path).
#    Mechanism map (box-reprove.sh -> this driver kind):
#      pf_gap   -> gap   (exec-gap.rs;          GAP_OP/GAP_FIXTURE/GAP_TAG; writes <GAP_TAG>_{pv,pb}.hex)
#      pf_perop -> perop (harnesses/exec-*.rs;  OP_FILE;                    writes public_values.hex/proof_bytes.hex)
#      pf_xbin  -> perop (exec-crosslane.rs;    fixture hardcoded in-harness; writes public_values.hex/proof_bytes.hex)
#      pf_farm  -> farm  (exec-farm.rs;         FARM_OP/FARM_FIXTURE/FARM_TAG=<short>; writes farm_<short>_{pv,pb}.hex)
#      pf_refl  -> refl  (exec-reflect-prove.rs; REFLECT_FIXTURE/REFLECT_OUT_TAG; writes <tag>_{public_values,proof_bytes}.hex)
#    tag == the local <tag>_groth16.json basename. The 24 settle ops bind PROGRAM_VKEY; the 2 reflection ops
#    bind BITCOIN_RELAY_VKEY (exec-reflect-prove.rs ignores EXPECT_VKEY and uses SKIP_VKEY_ASSERT=1).
OPS=(
  # ── gap ops (exec-gap.rs, GAP_OP + <fixture-on-disk>) ──
  "cdp_mint|perop|exec-cdpmint.rs|OP_FILE=$FX/cdp_mint_op.json"
  "cdp_close|perop|exec-cdpclose.rs|OP_FILE=$FX/cdp_close_op.json"
  "cdp_liquidate|gap|exec-gap.rs|GAP_OP=17 GAP_FIXTURE=$FX/cdp_liquidate_op.json GAP_TAG=cdp_liquidate"
  "cbtc_mint|gap|exec-gap.rs|GAP_OP=18 GAP_FIXTURE=$FX/cbtc_mint_op.json GAP_TAG=cbtc_mint"
  "cdp_topup|perop|exec-cdptopup.rs|OP_FILE=$FX/cdp_topup_op.json"
  "swap_route|perop|exec-route.rs|OP_FILE=$FX/route_op.json"
  "adaptor_lock|gap|exec-gap.rs|GAP_OP=12 GAP_FIXTURE=$FX/adaptor_lock_op.json GAP_TAG=adaptor_lock"
  "adaptor_claim|gap|exec-gap.rs|GAP_OP=13 GAP_FIXTURE=$FX/adaptor_claim_op.json GAP_TAG=adaptor_claim"
  "adaptor_refund|perop|exec-adaptorrefund.rs|OP_FILE=$FX/adaptor_refund_op.json"
  "lp_remove|perop|exec-lpremove.rs|OP_FILE=$FX/lp_remove_op.json"
  # ── per-op harness ops (harnesses/exec-<x>.rs, OP_FILE, MODE=groth16) ──
  "swap|perop|exec-swap.rs|OP_FILE=$FX/swap_op.json"
  "lp|perop|exec-lp.rs|OP_FILE=$FX/lp_op.json"
  "lp_protofee|perop|exec-lp.rs|OP_FILE=$FX/lp_protofee_op.json"
  "lpbond|perop|exec-lpbond.rs|OP_FILE=$FX/lpbond_op.json"
  "wraptransfer|perop|exec-wraptransfer.rs|OP_FILE=$FX/wraptransfer_op.json"
  "sendunwrap|perop|exec-sendunwrap.rs|OP_FILE=$FX/sendunwrap_op.json"
  "wrapcdpmint|perop|exec-wrapcdpmint.rs|OP_FILE=$FX/wrapcdpmint_op.json"
  "otc|perop|exec-otc.rs|OP_FILE=$FX/otc_op.json"
  "bid|perop|exec-bid.rs|OP_FILE=$FX/bid_op.json"
  "confidential|perop|exec-prove.rs|OP_FILE=$FX/transfer_op.json"
  "unwrap|perop|exec-unwrap.rs|OP_FILE=$FX/unwrap_op.json"
  "wrap|perop|exec-wrap.rs|OP_FILE=$FX/wrap_op.json"
  "swapbatch|perop|exec-swap.rs|OP_FILE=$FX/swapbatch_op.json"
  "mixed|perop|exec-mixed.rs|OP_FILE=$FX/mixed_op.json"
  "bridgestealthmint|perop|exec-bridgestealthmint.rs|OP_FILE=$FX/bridgestealthmint_op.json"
  "stealthlockbatch|perop|exec-stealthlockbatch.rs|OP_FILE=$FX/stealthlockbatch_op.json"
  "stealthclaim|perop|exec-stealthclaim.rs|OP_FILE=$FX/stealthclaim_op.json"
  "stealthrefund|perop|exec-stealthrefund.rs|OP_FILE=$FX/stealthrefund_op.json"
  # ── crosslane (pf_xbin -> exec-crosslane.rs; harness hardcodes the crosslane_op.json path) ──
  "crosslane|perop|exec-crosslane.rs|OP_FILE=$FX/crosslane_op.json"
  # ── farm ops (exec-farm.rs, FARM_OP + FARM_TAG=<short>; writes farm_<short>_{pv,pb}.hex == <tag>_{pv,pb}.hex) ──
  "farm_bond|farm|exec-farm.rs|FARM_OP=20 FARM_FIXTURE=$FX/farm_bond_op.json FARM_TAG=bond"
  "farm_harvest|farm|exec-farm.rs|FARM_OP=21 FARM_FIXTURE=$FX/farm_harvest_op.json FARM_TAG=harvest"
  "farm_unbond|farm|exec-farm.rs|FARM_OP=22 FARM_FIXTURE=$FX/farm_unbond_op.json FARM_TAG=unbond"
  # ── reflection ops (exec-reflect-prove.rs, REFLECT_FIXTURE) — bound to the RELAY vkey ──
  "reflection|refl|exec-reflect-prove.rs|SKIP_VKEY_ASSERT=1 PROOF_MODE=groth16 REFLECT_FIXTURE=$FX/reflection_input.json REFLECT_OUT_TAG=reflection"
  "reflection_burn_deposit|refl|exec-reflect-prove.rs|SKIP_VKEY_ASSERT=1 PROOF_MODE=groth16 REFLECT_FIXTURE=$FX/reflection_burn_deposit.json REFLECT_OUT_TAG=reflection_burn_deposit"
)

binname(){ local h=$1; h=${h#exec-}; h=${h%.rs}; echo "${h//-/_}"; }   # exec-reflect-prove.rs -> reflect_prove

# ── BUILD: each DISTINCT harness → a prebuilt self-contained binary in bins/ (sequential; dep cache reused).
#    SKIP_BUILD=1 skips this entirely — bins/ is assumed pre-populated (e.g. prebuilt binaries copied from
#    another box that has the toolchain). The binaries embed the guest ELF (include_bytes!), so a copied bin
#    proves the SAME vkey with NO rebuild/drift; the target box needs only glibc + libgomp + the gnark PK. ──
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  log "=== build phase SKIPPED (SKIP_BUILD=1; using $(ls "$BINS" 2>/dev/null | wc -l) pre-copied bins) ==="
else
log "=== build phase (sequential; ONE exec dir, dep cache valid → only main.rs recompiles) ==="
declare -A seen_bn
nbuilt=0; nbfail=0
for def in "${OPS[@]}"; do
  IFS='|' read -r tag kind h env <<<"$def"
  bn=$(binname "$h"); [ -n "${seen_bn[$bn]:-}" ] && continue; seen_bn[$bn]=1
  # REUSE_BINS=1: skip rebuilding a bin that already exists (a failure-sweep re-run only needs the NEW
  # harnesses built; the existing bins embed the same ELF, so reuse is drift-safe for a same-ELF re-run).
  [ "${REUSE_BINS:-0}" = "1" ] && [ -x "$BINS/$bn" ] && { log "reuse $bn (existing bin)"; nbuilt=$((nbuilt+1)); continue; }
  cp -f "$HARN/$h" "$EXEC/src/main.rs"
  if ( cd "$EXEC" && cargo build --release ) >"/root/build_$bn.log" 2>&1 && [ -f "$EXEC/target/release/exec" ]; then
    cp -f "$EXEC/target/release/exec" "$BINS/$bn"; nbuilt=$((nbuilt+1)); log "built $bn"
  else
    nbfail=$((nbfail+1)); log "BUILD FAIL $bn :: $(grep -oE 'error\[[0-9]+[^]]*\]|error:.*' /root/build_$bn.log 2>/dev/null | head -1)"
  fi
done
log "build phase done: $nbuilt built, $nbfail failed"
fi

# ── RUN: prebuilt binaries in parallel, each in its own run/<tag> CWD (no compile → no thrash) ──
prove_op(){ # tag kind harness env...
  local tag=$1 kind=$2 h=$3; shift 3
  local bn; bn=$(binname "$h"); local wd="$RUNROOT/$tag"; local plog="/root/${tag}.plog"
  rm -rf "$wd"; mkdir -p "$wd"
  if [ ! -x "$BINS/$bn" ]; then echo FAIL > "$wd/result"; log "FAIL $tag (no binary $bn)"; return; fi
  local -a envk=(); local kv
  for kv in "$@"; do
    envk+=("$kv")
    case "$kv" in REFLECT_FIXTURE=*) envk+=("REFLECT_INPUT=${kv#REFLECT_FIXTURE=}");; esac
  done
  # NO `timeout` wrapper: vast hosts NTP-jump the wall clock by hours/days mid-prove, which makes `timeout`
  # fire spuriously and kill a healthy prove (looks like a stall — load drops as ops are killed). Let the op
  # run to natural completion; a genuinely stuck op shows as no-artifact and is re-run on the next pass.
  ( cd "$wd" && env "${envk[@]}" EXPECT_VKEY="$PVK" MODE=groth16 "$BINS/$bn" ) >"$plog" 2>&1
  case "$kind" in
    perop) cp -f "$wd/public_values.hex" "$OUT/${tag}_pv.hex" 2>/dev/null
           cp -f "$wd/proof_bytes.hex"   "$OUT/${tag}_pb.hex" 2>/dev/null ;;
    gap)   cp -f "$wd/${tag}_pv.hex" "$OUT/${tag}_pv.hex" 2>/dev/null
           cp -f "$wd/${tag}_pb.hex" "$OUT/${tag}_pb.hex" 2>/dev/null ;;
    # exec-farm.rs writes farm_<FARM_TAG>_{pv,pb}.hex; with tag=farm_<short> and FARM_TAG=<short> that file IS
    # <tag>_{pv,pb}.hex. Glob defensively so a FARM_TAG/tag drift can't silently drop the proof.
    farm)  local fpv fpb; fpv=$(ls "$wd"/farm_*_pv.hex 2>/dev/null|head -1); fpb=$(ls "$wd"/farm_*_pb.hex 2>/dev/null|head -1)
           [ -n "$fpv" ] && cp -f "$fpv" "$OUT/${tag}_pv.hex"; [ -n "$fpb" ] && cp -f "$fpb" "$OUT/${tag}_pb.hex" ;;
    refl)  local pv pb; pv=$(ls "$wd"/*_public_values.hex 2>/dev/null|head -1); pb=$(ls "$wd"/*_proof_bytes.hex 2>/dev/null|head -1)
           [ -n "$pv" ] && cp -f "$pv" "$OUT/${tag}_pv.hex"; [ -n "$pb" ] && cp -f "$pb" "$OUT/${tag}_pb.hex" ;;
  esac
  if [ -s "$OUT/${tag}_pv.hex" ] && [ -s "$OUT/${tag}_pb.hex" ]; then
    echo OK > "$wd/result"; log "OK   $tag pv=$(wc -c <"$OUT/${tag}_pv.hex") pb=$(wc -c <"$OUT/${tag}_pb.hex")"
  else
    echo FAIL > "$wd/result"
    # Empty-pv case: the prove "succeeded" but committed nothing — sp1 returns Ok even when the guest
    # halts before its commit (a rejected witness panics an in-guest assert). The harness then writes a
    # 0-byte public_values.hex and prints a misleading "PROVED ... pv_bytes=0". Call it out explicitly so
    # this never again reads as a generic FAIL with no reason.
    local reason
    reason=$(grep -oE 'timeout|panicked|SIGBUS|memory allocation|Killed|signal: 9|groth16 proof failed|EXPECT_VKEY mismatch|error\[[0-9]+|No such file' "$plog" 2>/dev/null | grep -v destructor | head -1)
    if [ -z "$reason" ] && grep -q 'pv_bytes=0' "$plog" 2>/dev/null; then
      reason="EMPTY public values (guest halted before commit — witness rejected by an in-guest assert; check fixture↔guest kernel/leaf binding)"
    fi
    log "FAIL $tag :: $reason"
  fi
}

# concurrency-N queue: keep ≤N background jobs; reap when full
declare -a pids=()
running(){ local p n=0; for p in "${pids[@]:-}"; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null && n=$((n+1)); done; echo "$n"; }

log "=== run phase start $(date -u) === N=$N TO=$TO PVK=$PVK"
for def in "${OPS[@]}"; do
  IFS='|' read -r tag kind h env <<<"$def"
  if [ -s "$OUT/${tag}_pv.hex" ] && [ -s "$OUT/${tag}_pb.hex" ] && [ "$(cat "$RUNROOT/$tag/result" 2>/dev/null)" = OK ]; then
    log "skip $tag (done)"; continue
  fi
  while [ "$(running)" -ge "$N" ]; do sleep 3; done
  log "launch $tag"
  # shellcheck disable=SC2086
  ( prove_op "$tag" "$kind" "$h" $env ) &
  pids+=("$!")
done
for p in "${pids[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null; done

# ── assemble manifest from per-op result files (non-racy) ──
: > "$OUT/manifest.tsv"
oks=0; fails=0
for def in "${OPS[@]}"; do
  IFS='|' read -r tag kind h env <<<"$def"
  if [ "$(cat "$RUNROOT/$tag/result" 2>/dev/null)" = OK ]; then
    printf '%s\tOK\tpv=%s\tpb=%s\n' "$tag" "$(wc -c <"$OUT/${tag}_pv.hex" 2>/dev/null)" "$(wc -c <"$OUT/${tag}_pb.hex" 2>/dev/null)" >> "$OUT/manifest.tsv"; oks=$((oks+1))
  else
    printf '%s\tFAIL\n' "$tag" >> "$OUT/manifest.tsv"; fails=$((fails+1))
  fi
done
log "=== DONE ok=$oks fail=$fails $(date -u) ==="
echo "=== manifest ($OUT/manifest.tsv) ==="; sort "$OUT/manifest.tsv"
