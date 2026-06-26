#!/usr/bin/env bash
# box-prove-remote.sh — clean, idempotent re-prove driver. Runs ON the vast box (synced by box-prove.sh).
# Per op: one groth16 prove that carries BOTH public_values + proofBytes (with the correct fee-field
# harness). No dual-pass, no client.verify (it hangs; the prover self-verifies and forge *ProofReal is the
# on-chain gate). Per-op GPU reset + one retry. Idempotent: skips ops already OK in the manifest.
#
# Hard-won env: the gnark-ffi build needs Go, which is NOT on the non-interactive PATH → add /usr/local/go/bin.
set -uo pipefail
source ~/.cargo/env 2>/dev/null || true
export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"
CX=${CX:-/root/work/cxfer}; EXEC=$CX/exec; HARN=$CX/harnesses; FX=$CX/fixtures
OUT=${OUT:-$CX/out-v1}; HOSTOUT=/root/work/prover-host/out
# box-prove.sh auto-derives PVK from the freshly-built ELF and passes it in; this is only a fallback.
PVK=${PVK:-0x00561e3e831115a3418a048142cf99604afec896ab3c899ee7316be3eeb25ebc}
TO=${TO:-900}; ONLY=${ONLY:-}
mkdir -p "$OUT" "$HOSTOUT"
STATUS=$CX/box-prove.status; MAN=$OUT/manifest.tsv
: > "$STATUS"; [ -f "$MAN" ] || : > "$MAN"
log(){ echo "[$(date -u +%H:%M:%S)] $*" >> "$STATUS"; }

command -v go >/dev/null || { log "FATAL: go not found (gnark-ffi build needs it)"; echo "go missing"; exit 2; }

gpu_down(){ pkill -9 -x sp1-gpu-server 2>/dev/null; pkill -9 -x sp1-native-runn 2>/dev/null; rm -f /dev/shm/sp1* /dev/shm/sem.sp1* /tmp/sp1-cuda-0.sock 2>/dev/null; }
gpu_up(){ gpu_down; sleep 3; CUDA_VISIBLE_DEVICES=0 setsid nohup sp1-gpu-server >"$CX/gpu.log" 2>&1 </dev/null & for _ in $(seq 1 30); do sleep 2; [ -S /tmp/sp1-cuda-0.sock ] && return 0; done; return 1; }

# Each mechanism leaves the proof artifacts where its harness writes them; we then normalize to $OUT/<tag>_{pv,pb}.hex.
run_harness(){ # harness env-prefix...
  local h=$1; shift
  cp -f "$HARN/$h" "$EXEC/src/main.rs"
  ( cd "$EXEC" && env "$@" EXPECT_VKEY="$PVK" MODE=groth16 CUDA_VISIBLE_DEVICES=0 timeout "$TO" cargo run --release --bin exec ) >>"/root/$CURTAG.log" 2>&1
}
collect_perop(){ cp -f "$EXEC/public_values.hex" "$OUT/${1}_pv.hex" 2>/dev/null; cp -f "$EXEC/proof_bytes.hex" "$OUT/${1}_pb.hex" 2>/dev/null; }
collect_gap(){ cp -f "$HOSTOUT/${1}_pv.hex" "$OUT/${1}_pv.hex" 2>/dev/null; cp -f "$HOSTOUT/${1}_pb.hex" "$OUT/${1}_pb.hex" 2>/dev/null; }
collect_refl(){ local pv pb; pv=$(ls "$EXEC"/*_public_values.hex 2>/dev/null|head -1); pb=$(ls "$EXEC"/*_proof_bytes.hex 2>/dev/null|head -1); [ -n "$pv" ]&&cp -f "$pv" "$OUT/${1}_pv.hex"; [ -n "$pb" ]&&cp -f "$pb" "$OUT/${1}_pb.hex"; }

prove(){ # tag kind harness [env...]
  local tag=$1 kind=$2 h=$3; shift 3
  [ -n "$ONLY" ] && [ "$ONLY" != "$tag" ] && return 0
  if [ -s "$OUT/${tag}_pv.hex" ] && [ -s "$OUT/${tag}_pb.hex" ] && grep -q "^$tag	OK" "$MAN" 2>/dev/null; then log "skip $tag (done)"; return 0; fi
  CURTAG=$tag; : > "/root/$tag.log"
  local a
  for a in 1 2; do
    log "prove $tag (attempt $a/2)"
    gpu_up || { log "  gpu up failed"; gpu_down; sleep 4; continue; }
    rm -f "$EXEC/public_values.hex" "$EXEC/proof_bytes.hex" "$EXEC"/*_public_values.hex "$EXEC"/*_proof_bytes.hex "$HOSTOUT/${tag}_pv.hex" "$HOSTOUT/${tag}_pb.hex"
    run_harness "$h" "$@"
    case "$kind" in perop) collect_perop "$tag";; gap) collect_gap "$tag";; refl) collect_refl "$tag";; esac
    if [ -s "$OUT/${tag}_pv.hex" ] && [ -s "$OUT/${tag}_pb.hex" ]; then break; fi
    log "  $tag attempt $a no artifacts: $(grep -oE 'timeout|panicked|SIGBUS|early eof|Connection refused|go:|error\[[0-9]+|No such file' /root/$tag.log 2>/dev/null | grep -v 'destructor' | head -1)"
    gpu_down; sleep 4
  done
  grep -v "^$tag	" "$MAN" > "$MAN.t" 2>/dev/null; mv -f "$MAN.t" "$MAN" 2>/dev/null
  if [ -s "$OUT/${tag}_pv.hex" ] && [ -s "$OUT/${tag}_pb.hex" ]; then
    printf '%s\tOK\tpv=%s\tpb=%s\n' "$tag" "$(wc -c <"$OUT/${tag}_pv.hex")" "$(wc -c <"$OUT/${tag}_pb.hex")" >> "$MAN"; log "OK   $tag"
  else printf '%s\tFAIL\n' "$tag" >> "$MAN"; log "FAIL $tag"; fi
}

log "=== box-prove start $(date -u) === (go $(go version 2>&1|awk '{print $3}'))"
# settle ops (per-op harnesses → exec/{public_values,proof_bytes}.hex)
prove confidential perop exec-prove.rs       OP_FILE="$FX/transfer_op.json"
prove wraptransfer perop exec-wraptransfer.rs OP_FILE="$FX/wraptransfer_op.json"
prove sendunwrap   perop exec-sendunwrap.rs  OP_FILE="$FX/sendunwrap_op.json"
prove lpbond       perop exec-lpbond.rs      OP_FILE="$FX/lpbond_op.json"
prove wrapcdpmint  perop exec-wrapcdpmint.rs OP_FILE="$FX/wrapcdpmint_op.json"
prove unwrap       perop exec-unwrap.rs      OP_FILE="$FX/unwrap_op.json"
prove swap         perop exec-swap.rs        OP_FILE="$FX/swap_op.json"
prove lp           perop exec-lp.rs          OP_FILE="$FX/lp_op.json"
prove lp_protofee  perop exec-lp.rs          OP_FILE="$FX/lp_protofee_op.json"  # OP_LP_ADD w/ non-zero Uniswap fee-switch (6-arg pool id); ConfidentialLpProofReal self-skips until proven
prove lp_remove    perop exec-lpremove.rs    OP_FILE="$FX/lp_remove_op.json"
prove otc          perop exec-otc.rs         OP_FILE="$FX/otc_op.json"
prove bid          perop exec-bid.rs         OP_FILE="$FX/bid_op.json"
prove swap_route   perop exec-route.rs       OP_FILE="$FX/route_op.json"
prove crosslane    perop exec-crosslane.rs   OP_FILE="$FX/crosslane_op.json"
prove adaptor_lock   perop exec-adaptorlock.rs   OP_FILE="$FX/adaptor_lock_op.json"
prove adaptor_claim  perop exec-adaptorclaim.rs  OP_FILE="$FX/adaptor_claim_op.json"
prove adaptor_refund perop exec-adaptorrefund.rs OP_FILE="$FX/adaptor_refund_op.json"
prove cdp_mint   perop exec-cdpmint.rs   OP_FILE="$FX/cdp_mint_op.json"
prove cdp_close  perop exec-cdpclose.rs  OP_FILE="$FX/cdp_close_op.json"
prove cdp_topup  perop exec-cdptopup.rs  OP_FILE="$FX/cdp_topup_op.json"
prove cbtc_mint  perop exec-cbtcmint.rs  OP_FILE="$FX/cbtc_mint_op.json"
prove wrap         perop exec-wrap.rs        OP_FILE="$FX/wrap_op.json"
prove bridge_burn  perop exec-bridgeburn.rs  OP_FILE="$FX/bridge_burn.json"
prove bridge_mint  perop exec-bridgemint.rs OP_FILE="$FX/bridgemint_op.json"
prove bridge_stealth_mint perop exec-bridgestealthmint.rs OP_FILE="$FX/bridgestealthmint_op.json"
prove stealth_lock   perop exec-stealthlockbatch.rs OP_FILE="$FX/stealthlockbatch_op.json"
prove stealth_claim  perop exec-stealthclaim.rs  OP_FILE="$FX/stealthclaim_op.json"
prove stealth_refund perop exec-stealthrefund.rs OP_FILE="$FX/stealthrefund_op.json"
prove mixed        perop exec-mixed.rs       OP_FILE="$FX/mixed_op.json"
prove farm_bond    perop exec-farmbond.rs    OP_FILE="$FX/farm_bond_op.json"
prove farm_harvest perop exec-farmharvest.rs OP_FILE="$FX/farm_harvest_op.json"
prove farm_unbond  perop exec-farmunbond.rs  OP_FILE="$FX/farm_unbond_op.json"
# gap-only op (no per-op harness)
prove cdp_liquidate gap exec-gap.rs GAP_OP=17 GAP_FIXTURE="$FX/cdp_liquidate_op.json" GAP_TAG=cdp_liquidate
# reflection ops (relay vkey — uses its own SKIP_VKEY_ASSERT)
prove reflection              refl exec-reflect-prove.rs SKIP_VKEY_ASSERT=1 PROOF_MODE=groth16 REFLECT_FIXTURE="$FX/reflection_input.json" REFLECT_OUT_TAG=reflection
prove reflection_burn_deposit refl exec-reflect-prove.rs SKIP_VKEY_ASSERT=1 PROOF_MODE=groth16 REFLECT_FIXTURE="$FX/reflection_burn_deposit.json" REFLECT_OUT_TAG=reflection_burn_deposit
gpu_down
oks=$(grep -c '	OK	' "$MAN" 2>/dev/null || echo 0); fails=$(grep -c '	FAIL$' "$MAN" 2>/dev/null || echo 0)
log "=== DONE ok=$oks fail=$fails $(date -u) ==="
