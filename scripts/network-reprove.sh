#!/usr/bin/env bash
# Network re-prove driver for the RunPod box (in-repo harnesses crate + Succinct network).
# Each op is self-verifying: it counts only if the harness printed VKEY=<expected> AND wrote a
# non-empty public_values.hex + proof_bytes.hex, so a wrong op->bin mapping fails safe (no bad fixture).
#   setsid nohup bash scripts/network-reprove.sh > /root/netreprove.out 2>&1 < /dev/null &
set -uo pipefail
cd /workspace/tacit/contracts/sp1/confidential/harnesses
source "$HOME/.cargo/env" 2>/dev/null || true
source /root/.prove.env 2>/dev/null || true
export PATH="$HOME/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin:$PATH"
export CGO_ENABLED=1 GOCACHE=/root/.cache/go-build GOPATH=/root/go
export LIBCLANG_PATH="$(dirname "$(find / -name 'libclang.so*' 2>/dev/null | head -1)")"
export SP1_PROVER=network

FX=/root/work/cxfer/fixtures
OUT=/root/reprove-out; mkdir -p "$OUT"
SETTLE=0x0082db7e3c32c8a865ddecc8f5236b1fb86339aeb94d198c68674538e3eb4727
REFL=0x00edafc6bb483778bf126be1c810fb7bda29cdb7996cd1ecb5a8896aac0c4f05
MAN="$OUT/manifest.tsv"; ST="$OUT/status.log"
log(){ echo "[$(date -u +%H:%M:%S)] $*" >> "$ST"; }

# tag | bin | op_input | vkey   (tag == *_groth16.json stem)
REG="
confidential|exec-prove|transfer_op.json|$SETTLE
swap|exec-swap|swap_op.json|$SETTLE
lp|exec-lp|lp_op.json|$SETTLE
lp_protofee|exec-lp|lp_protofee_op.json|$SETTLE
lp_remove|exec-lpremove|lp_remove_op.json|$SETTLE
lpbond|exec-lpbond|lpbond_op.json|$SETTLE
swap_route|exec-route|route_op.json|$SETTLE
wraptransfer|exec-wraptransfer|wraptransfer_op.json|$SETTLE
sendunwrap|exec-sendunwrap|sendunwrap_op.json|$SETTLE
wrapcdpmint|exec-wrapcdpmint|wrapcdpmint_op.json|$SETTLE
otc|exec-otc|otc_op.json|$SETTLE
bid|exec-bid|bid_op.json|$SETTLE
crosslane|exec-crosslane|crosslane_op.json|$SETTLE
unwrap|exec-unwrap|unwrap_op.json|$SETTLE
wrap|exec-wrap|wrap_op.json|$SETTLE
swapbatch|exec-swap|swapbatch_op.json|$SETTLE
mixed|exec-mixed|mixed_op.json|$SETTLE
bridgestealthmint|exec-bridgestealthmint|bridgestealthmint_op.json|$SETTLE
stealthlockbatch|exec-stealthlockbatch|stealthlockbatch_op.json|$SETTLE
stealthclaim|exec-stealthclaim|stealthclaim_op.json|$SETTLE
stealthrefund|exec-stealthrefund|stealthrefund_op.json|$SETTLE
adaptor_lock|exec-adaptorlock|adaptor_lock_op.json|$SETTLE
adaptor_claim|exec-adaptorclaim|adaptor_claim_op.json|$SETTLE
adaptor_refund|exec-adaptorrefund|adaptor_refund_op.json|$SETTLE
cdp_mint|exec-cdpmint|cdp_mint_op.json|$SETTLE
cdp_close|exec-cdpclose|cdp_close_op.json|$SETTLE
cdp_topup|exec-cdptopup|cdp_topup_op.json|$SETTLE
cdp_liquidate|exec-cdpliquidate|cdp_liquidate_op.json|$SETTLE
farm_bond|exec-farmbond|farm_bond_op.json|$SETTLE
farm_harvest|exec-farmharvest|farm_harvest_op.json|$SETTLE
farm_unbond|exec-farmunbond|farm_unbond_op.json|$SETTLE
"

prove_one(){
  local tag=$1 bin=$2 opf=$3 vkey=$4
  if [ -s "$OUT/${tag}.pv" ] && [ "$(cat "$OUT/${tag}.vkey" 2>/dev/null)" = "$vkey" ]; then log "skip $tag (already OK)"; return 0; fi
  [ -f "$FX/$opf" ] || { printf '%s\t%s\tNOINPUT\n' "$tag" "$vkey" >> "$MAN"; log "NOINPUT $tag ($opf)"; return 1; }
  rm -f public_values.hex proof_bytes.hex
  log "prove $tag ($bin $opf)"
  EXPECT_VKEY=$vkey OP_FILE="$FX/$opf" MODE=groth16 timeout 2400 cargo run --release --bin "$bin" >"$OUT/${tag}.log" 2>&1 || true
  if [ -s public_values.hex ] && [ -s proof_bytes.hex ] && grep -q "VKEY=$vkey" "$OUT/${tag}.log"; then
    cp public_values.hex "$OUT/${tag}.pv"; cp proof_bytes.hex "$OUT/${tag}.pb"; echo "$vkey" > "$OUT/${tag}.vkey"
    printf '%s\t%s\tOK\n' "$tag" "$vkey" >> "$MAN"; log "OK $tag"
  else
    printf '%s\t%s\tFAIL\n' "$tag" "$vkey" >> "$MAN"
    log "FAIL $tag: $(grep -oiE 'error\[[0-9]+|panic|no such file|vkey mismatch|unexpected|expected .* got' "$OUT/${tag}.log" | head -1)"
  fi
}

: > "$MAN"
while IFS='|' read -r tag bin opf vkey; do
  [ -z "${tag:-}" ] && continue
  [ -n "${ONLY:-}" ] && [ "$ONLY" != "$tag" ] && continue
  prove_one "$tag" "$bin" "$opf" "$vkey"
done <<< "$REG"
log "SETTLE BATCH DONE ok=$(grep -c $'\tOK$' "$MAN") fail=$(grep -c $'\tFAIL$' "$MAN") noinput=$(grep -c $'\tNOINPUT$' "$MAN")"
