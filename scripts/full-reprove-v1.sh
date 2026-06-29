#!/usr/bin/env bash
# ⚠️ DEPRECATED — DO NOT USE FOR THE V1 LOCK. This sequential box-native driver is UNREFERENCED and its op
# list drifted INCOMPLETE (missing wrap, mixed, the stealth_* set, bridge_burn/bridge_mint, and the fusion
# ops sendunwrap/wrapcdpmint/wraptransfer) — running it would silently produce a PARTIAL re-prove and leave
# stale fixtures that fail forge *ProofReal at deploy. The AUTHORITATIVE driver is scripts/parallel-ng-prove.sh
# (driven by scripts/fast-reprove.sh), kept in lockstep with the complete reference scripts/box-prove-remote.sh.
# Left in tree only for its detached-safe per-op GPU/shm-reset pattern; port that into the parallel driver if
# ever needed, don't revive this op list.
#
# Full coordinated re-prove for the Sepolia V1 freeze — box-native (harness-swap) driver.
set -uo pipefail
echo "full-reprove-v1.sh is DEPRECATED + INCOMPLETE — use scripts/fast-reprove.sh (parallel-ng-prove.sh). Set ALLOW_DEPRECATED_REPROVE=1 to override." >&2
[ "${ALLOW_DEPRECATED_REPROVE:-0}" = "1" ] || exit 2
source ~/.cargo/env 2>/dev/null; export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin"
# The new program vkey derived from the freshly-rebuilt settle ELF (GPU-free MODE=execute). The settle
# harnesses have a drift guard requiring EXPECT_VKEY; set it to the derived value so the guard passes
# (derived == expected) instead of aborting "NotPresent". Reflection uses SKIP_VKEY_ASSERT (it ESTABLISHES
# a new relay vkey this run). Override PVK via env if a later op derives a different settle vkey.
PVK=${PVK:-0x00fdf97302e3224c4574fa12edc463c8163b4715bcc44ada457499d31e4d5f1a}
CX=/root/work/cxfer; EXEC=$CX/exec; HARN=$CX/harnesses; FX=$CX/fixtures
OUT=$CX/out-v1; HOSTOUT=/root/work/prover-host/out
mkdir -p "$OUT" "$HOSTOUT"
STATUS=$CX/reprove-v1.status; MAN=$OUT/manifest.tsv; TO=${TO:-900}
: > "$STATUS"; [ -f "$MAN" ] || : > "$MAN"
log(){ echo "[$(date -u +%H:%M:%S)] $*" >> "$STATUS"; }

gpu_down(){ pkill -9 -x sp1-gpu-server 2>/dev/null; pkill -9 -x sp1-native-runn 2>/dev/null; rm -f /dev/shm/sp1* /dev/shm/sem.sp1* /tmp/sp1-cuda-0.sock 2>/dev/null; }
gpu_up(){ gpu_down; sleep 3; CUDA_VISIBLE_DEVICES=0 setsid nohup sp1-gpu-server >"$CX/gpu-v1.log" 2>&1 </dev/null & for _ in $(seq 1 30); do sleep 2; [ -S /tmp/sp1-cuda-0.sock ] && return 0; done; return 1; }

stamped(){ [ -s "$OUT/$1_pv.hex" ] && grep -q "^$1	" "$MAN" 2>/dev/null && grep -q "	OK$" <(grep "^$1	" "$MAN"); }
collect_vkey(){ grep -oE '(BITCOIN_RELAY_VKEY|VKEY)=0x[0-9a-f]{64}' "/root/$1.log" 2>/dev/null | grep -oE '0x[0-9a-f]{64}' | head -1; }
ok_marker(){ grep -qE 'LOCAL_VERIFY_OK|^PROVED' "/root/$1.log" 2>/dev/null; }

# mechanisms — each leaves $OUT/<tag>_pv.hex + <tag>_pb.hex
# PV always from pv_override.hex (the deterministic execute pass — works around sp1-cuda groth16 empty PV);
# proofBytes from each mechanism's groth16 output file.
m_perop(){ local tag=$1 h=$2 fx=$3
  cp -f "$HARN/$h" "$EXEC/src/main.rs"; rm -f "$EXEC/public_values.hex" "$EXEC/proof_bytes.hex" "$EXEC/pv_override.hex"
  ( cd "$EXEC" && EXPECT_VKEY="$PVK" MODE=groth16 OP_FILE="$FX/$fx" CUDA_VISIBLE_DEVICES=0 timeout "$TO" cargo run --release ) >"/root/$tag.log" 2>&1
  cp -f "$EXEC/pv_override.hex" "$OUT/${tag}_pv.hex" 2>/dev/null; cp -f "$EXEC/proof_bytes.hex" "$OUT/${tag}_pb.hex" 2>/dev/null; }
m_gap(){ local tag=$1 op=$2 fx=$3
  cp -f "$HARN/exec-gap.rs" "$EXEC/src/main.rs"; rm -f "$HOSTOUT/${tag}_pb.hex" "$EXEC/pv_override.hex"
  ( cd "$EXEC" && EXPECT_VKEY="$PVK" MODE=groth16 GAP_OP="$op" GAP_FIXTURE="$FX/$fx" GAP_TAG="$tag" CUDA_VISIBLE_DEVICES=0 timeout "$TO" cargo run --release ) >"/root/$tag.log" 2>&1
  cp -f "$EXEC/pv_override.hex" "$OUT/${tag}_pv.hex" 2>/dev/null; cp -f "$HOSTOUT/${tag}_pb.hex" "$OUT/${tag}_pb.hex" 2>/dev/null; }
m_farm(){ local tag=$1 short=$2 op=$3 fx=$4
  cp -f "$HARN/exec-farm.rs" "$EXEC/src/main.rs"; rm -f "$HOSTOUT/farm_${short}_pb.hex" "$EXEC/pv_override.hex"
  ( cd "$EXEC" && EXPECT_VKEY="$PVK" MODE=groth16 FARM_OP="$op" FARM_FIXTURE="$FX/$fx" FARM_TAG="$short" CUDA_VISIBLE_DEVICES=0 timeout "$TO" cargo run --release ) >"/root/$tag.log" 2>&1
  cp -f "$EXEC/pv_override.hex" "$OUT/${tag}_pv.hex" 2>/dev/null; cp -f "$HOSTOUT/farm_${short}_pb.hex" "$OUT/${tag}_pb.hex" 2>/dev/null; }
m_refl(){ local tag=$1 fx=$2
  cp -f "$HARN/exec-reflect-prove.rs" "$EXEC/src/main.rs"; rm -f "$EXEC"/*_proof_bytes.hex "$EXEC/pv_override.hex"
  ( cd "$EXEC" && PROOF_MODE=groth16 SKIP_VKEY_ASSERT=1 REFLECT_FIXTURE="$FX/$fx" REFLECT_OUT_TAG="$tag" CUDA_VISIBLE_DEVICES=0 timeout "$TO" cargo run --release ) >"/root/$tag.log" 2>&1
  local pb; pb=$(ls "$EXEC"/*_proof_bytes.hex 2>/dev/null | head -1)
  cp -f "$EXEC/pv_override.hex" "$OUT/${tag}_pv.hex" 2>/dev/null; [ -n "$pb" ] && cp -f "$pb" "$OUT/${tag}_pb.hex"; }

prove(){ local tag=$1 fn=$2; shift 2
  [ -n "${ONLY:-}" ] && [ "$ONLY" != "$tag" ] && return 0
  if stamped "$tag"; then log "skip $tag (stamped OK)"; return 0; fi
  local a
  for a in 1 2; do
    log "prove $tag (attempt $a/2)"
    gpu_up || { log "  $tag gpu fail"; gpu_down; sleep 4; continue; }
    "$fn" "$tag" "$@"
    if [ -s "$OUT/${tag}_pv.hex" ] && ok_marker "$tag"; then break; fi
    log "  $tag attempt $a no-verify: $(grep -oE 'timeout|panicked|SIGBUS|early eof|Connection refused|error\[[0-9]+' /root/$tag.log 2>/dev/null | head -1)"
    gpu_down; sleep 4
  done
  local vk; vk=$(collect_vkey "$tag"); echo "$vk" > "$OUT/${tag}.vkey"
  grep -v "^$tag	" "$MAN" > "$MAN.tmp" 2>/dev/null; mv -f "$MAN.tmp" "$MAN" 2>/dev/null
  if [ -s "$OUT/${tag}_pv.hex" ] && ok_marker "$tag"; then printf '%s\t%s\t%s\tOK\n' "$tag" "$vk" "$(wc -c <"$OUT/${tag}_pv.hex")" >> "$MAN"; log "OK   $tag vkey=$vk"
  else printf '%s\t%s\t0\tFAIL\n' "$tag" "$vk" >> "$MAN"; log "FAIL $tag"; fi
}

log "=== full re-prove start $(date -u) ==="
log "settle ELF sha: $(sha256sum $CX/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest | cut -d' ' -f1)"
log "reflection ELF sha: $(sha256sum $CX/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover | cut -d' ' -f1)"

# per-op settle harnesses
prove confidential m_perop exec-prove.rs      transfer_op.json
prove unwrap       m_perop exec-unwrap.rs     unwrap_op.json
prove swap         m_perop exec-swap.rs       swap_op.json
prove lp           m_perop exec-lp.rs         lp_op.json
prove lp_protofee  m_perop exec-lp.rs         lp_protofee_op.json
prove lpbond       m_perop exec-lpbond.rs     lpbond_op.json
prove lp_remove    m_perop exec-lpremove.rs   lp_remove_op.json
prove otc          m_perop exec-otc.rs        otc_op.json
prove bid          m_perop exec-bid.rs        bid_op.json
prove crosslane    m_perop exec-crosslane.rs  crosslane_op.json
prove swap_route   m_perop exec-route.rs      route_op.json
prove adaptor_lock   m_perop exec-adaptorlock.rs   adaptor_lock_op.json
prove adaptor_claim  m_perop exec-adaptorclaim.rs  adaptor_claim_op.json
prove adaptor_refund m_perop exec-adaptorrefund.rs adaptor_refund_op.json
prove cdp_mint   m_perop exec-cdpmint.rs   cdp_mint_op.json
prove cdp_close  m_perop exec-cdpclose.rs  cdp_close_op.json
prove cdp_topup  m_perop exec-cdptopup.rs  cdp_topup_op.json
prove cbtc_mint  m_perop exec-cbtcmint.rs  cbtc_mint_op.json
# new op 22: cross-chain confidential pay-to-stealth
prove bridge_stealth_mint m_perop exec-bridgestealthmint.rs bridgestealthmint_op.json
# gap-only op (no per-op harness): cdp_liquidate
prove cdp_liquidate m_gap 17 cdp_liquidate_op.json
# farm ops
prove farm_bond    m_farm bond    20 farm_bond_op.json
prove farm_harvest m_farm harvest 21 farm_harvest_op.json
prove farm_unbond  m_farm unbond  22 farm_unbond_op.json
# reflection ops (relay vkey)
prove reflection              m_refl reflection_input.json
prove reflection_burn_deposit m_refl reflection_burn_deposit.json

gpu_down
oks=$(grep -c '	OK$' "$MAN" 2>/dev/null || echo 0); fails=$(grep -c '	FAIL$' "$MAN" 2>/dev/null || echo 0)
log "=== REPROVE_DONE ok=$oks fail=$fails $(date -u) ==="
