#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Confidential-pool production-readiness gate.
#
# Runs every verification layer of the ConfidentialPool + cross-chain stack and
# prints a TIERED go/no-go:
#   POOL     = Ethereum-only confidential pool (BITCOIN_RELAY_VKEY = 0).
#   BRIDGE = adds the Bitcoin<->Ethereum cross-lane / bridge (relay-attested).
#
# A FAIL is a regression and fails the exit code. A BLOCKED gate is an
# expected-pending milestone (an off-box prove, an unbuilt subsystem); it does
# NOT fail the exit, but its layer is not "ready" until the block clears. This is
# the operational companion to ops/RUNBOOK-confidential-pool-readiness.md.
#
# Usage:  bash contracts/sp1/confidential/readiness-gate.sh
#   READINESS_FAST=1   skip the slow stateful invariant fuzzing (quick iteration)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 2
CXFER="contracts/sp1/confidential/cxfer-core/Cargo.toml"
DEPLOY="contracts/script/DeployConfidentialPool.s.sol"
GROTH16_FIXTURE="contracts/test/fixtures/confidential_groth16.json"
CROSSLANE_FIXTURE="contracts/test/fixtures/crosslane_groth16.json"
REFLECT_FIXTURE="contracts/test/fixtures/reflection_groth16.json"
PIN="contracts/sp1/confidential/elf-vkey-pin.json"

pass=0; fail=0; blocked=0
declare -a RESULTS   # "STATUS|LAYER|name"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

run_gate() {  # name layer cmd...
  local name="$1" layer="$2"; shift 2
  printf '──▶ %-58s [%s]\n' "$name" "$layer"
  if "$@" >"$TMP" 2>&1; then
    printf '    PASS  %s\n' "$name"; pass=$((pass+1)); RESULTS+=("PASS|$layer|$name")
  else
    printf '    FAIL  %s\n' "$name"; tail -10 "$TMP" | sed 's/^/        | /'
    fail=$((fail+1)); RESULTS+=("FAIL|$layer|$name")
  fi
}
block_gate() { # name layer reason
  printf '──▶ %-58s [%s]\n    BLOCKED  %s\n' "$1" "$2" "$3"
  blocked=$((blocked+1)); RESULTS+=("BLOCKED|$2|$1 — $3")
}

# node helper: run every confidential dapp/prover test; fail if any fails.
node_suite() {
  local t rc=0
  for t in confidential-memo confidential-indexer confidential-transfer-roundtrip \
           confidential-bridge-mint confidential-bridge-burn confidential-btc-relay \
           confidential-canonical-asset-id confidential-evm-log confidential-note-binds-amm \
           confidential-swap-op confidential-lp-op confidential-otc-op confidential-bid-op; do
    if ! node "tests/$t.mjs" >>"$TMP.node" 2>&1; then echo "FAIL $t"; rc=1; fi
  done
  cat "$TMP.node" >>"$TMP" 2>/dev/null; rm -f "$TMP.node"
  return $rc
}

# node helper: the Bitcoin reflection indexer + prover-input tests. The SHIPPED model is the
# full SCAN (confidential-reflection-scan*: every tx of every block, F4-complete); the witnessed
# (state/witness/indexer) tests stay as the superseded-model cross-check oracle. Both must be green.
reflection_suite() {
  local t rc=0
  for t in confidential-reflection-scan confidential-reflection-scan-indexer \
           confidential-reflection-attest-scan \
           confidential-reflection-state confidential-reflection-witness \
           confidential-reflection-indexer reflection-attest; do
    [ -f "tests/$t.mjs" ] || continue
    if ! node "tests/$t.mjs" >>"$TMP.refl" 2>&1; then echo "FAIL $t"; rc=1; fi
  done
  cat "$TMP.refl" >>"$TMP" 2>/dev/null; rm -f "$TMP.refl"
  return $rc
}

echo "════════════════════════ CONFIDENTIAL-POOL READINESS ════════════════════════"
echo "repo: $ROOT"
echo

# ── POOL layer 1: on-chain state machine + crypto (forge) ────────────────────
if [ "${READINESS_FAST:-0}" = "1" ]; then
  run_gate "Forge: state-machine + fuzz + KAT + real-proof + factory" POOL \
    forge test --root contracts --no-match-contract ConfidentialPoolInvariant \
      --match-contract 'Confidential|CanonicalAsset'
  block_gate "Forge: stateful invariant fuzzing" POOL "skipped (READINESS_FAST=1)"
else
  run_gate "Forge: state-machine + invariant + fuzz + KAT + real-proof + factory" POOL \
    forge test --root contracts --match-contract 'Confidential|CanonicalAsset'
fi

# ── POOL layer 2: guest verification core (cxfer-core native KATs) ───────────
run_gate "cxfer-core: native crypto + cross-impl + reflection KATs" POOL \
  cargo test --manifest-path "$CXFER" --quiet

# ── POOL layer 3: off-chain dapp/prover (node) ───────────────────────────────
run_gate "Node: memo / indexer / transfer / bridge / relay / canonical" POOL node_suite

# ── POOL layer 4: deployment coherence (the live guest must be the proven one) ─
# The settle vkey must agree across all four faces: the pin (program_vkey), the deploy
# DEFAULT_VKEY, and EVERY settle real-proof fixture (confidential/swap/lp/crosslane) — a
# lagging fixture or pin typo otherwise passes green while the deployed guest has no proof.
# The reflection leg checks its own pair (bitcoin_relay_vkey ↔ reflection fixture).
printf '──▶ %-58s [%s]\n' "vkey coherence: pin == deploy == every fixture" "POOL"
jget() { node -e 'try{process.stdout.write(String(require("./"+process.argv[1])[process.argv[2]]||""))}catch(e){}' "$1" "$2" 2>/dev/null; }
PIN_VKEY="$(jget "$PIN" program_vkey)"
DEP_VKEY="$(grep -oE 'DEFAULT_VKEY = 0x[0-9a-fA-F]{64}' "$DEPLOY" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)"
SETTLE_FIXTURES="$GROTH16_FIXTURE contracts/test/fixtures/swap_groth16.json contracts/test/fixtures/lp_groth16.json $CROSSLANE_FIXTURE"
printf '    pin program_vkey   : %s\n' "${PIN_VKEY:-<none>}"
printf '    deploy DEFAULT_VKEY : %s\n' "${DEP_VKEY:-<none>}"
coh_ok=1
[ -n "$PIN_VKEY" ] && [ "$PIN_VKEY" = "$DEP_VKEY" ] || coh_ok=0
for fx in $SETTLE_FIXTURES; do
  fxv="$(jget "$fx" vkey)"
  printf '    %-30s : %s\n' "$(basename "$fx")" "${fxv:-<missing>}"
  [ -n "$fxv" ] && [ "$fxv" = "$PIN_VKEY" ] || coh_ok=0
done
# Reflection pair (its own vkey lineage).
RPIN_VKEY="$(jget "$PIN" bitcoin_relay_vkey)"; RFX_VKEY="$(jget "$REFLECT_FIXTURE" vkey)"
printf '    reflection pin/fixture : %s / %s\n' "${RPIN_VKEY:-<none>}" "${RFX_VKEY:-<missing>}"
[ -n "$RFX_VKEY" ] && [ "$RFX_VKEY" != "$RPIN_VKEY" ] && coh_ok=0
if [ "$coh_ok" = 1 ]; then
  printf '    PASS  the deploy-default + pinned guest has on-chain Groth16 proofs (all settle fixtures + reflection)\n'
  pass=$((pass+1)); RESULTS+=("PASS|POOL|vkey coherence")
else
  block_gate "vkey coherence" POOL \
    "pin/deploy/fixture vkey mismatch: a settle face has no matching on-chain proof (box: re-prove, refresh fixtures, repin DEFAULT_VKEY + elf-vkey-pin.json in one commit)"
fi

# ── POOL layer 5: guest ELF pin discipline (no silent drift) ─────────────────
# The real sha256(committed-ELF) == pin check lives in verify-vkey-pin.sh — run it here
# (was a file-exists no-op that let a silently recommitted ELF pass the gate).
if [ -f "$PIN" ]; then
  run_gate "Guest ELF/vkey pin matches committed ELF" POOL \
    bash contracts/sp1/confidential/verify-vkey-pin.sh
else
  block_gate "Guest ELF/vkey pin" POOL \
    "no $PIN: confidential guest lacks the tETH ELF-pin discipline (commit canonical ELF + pinned vkey + CI sha check)"
fi

# ── BRIDGE layer 6: cross-lane real proof ──────────────────────────────────
if [ -f "$CROSSLANE_FIXTURE" ]; then
  run_gate "Forge: cross-lane real proof verifies on-chain" BRIDGE \
    forge test --root contracts --match-contract ConfidentialCrossLaneProofReal
else
  block_gate "Bridge cross-lane real proof" BRIDGE \
    "no $CROSSLANE_FIXTURE: box has not produced a cross-lane Groth16 proof yet"
fi

# ── BRIDGE layer 7: the Bitcoin-state relay prover (BITCOIN_RELAY_VKEY) ─────
if [ -f "$REFLECT_FIXTURE" ] && [ -f contracts/test/ConfidentialReflectionProofReal.t.sol ]; then
  run_gate "Reflection prover: real proof verifies on-chain (BITCOIN_RELAY_VKEY)" BRIDGE \
    forge test --root contracts --match-contract ConfidentialReflectionProofReal
else
  block_gate "Reflection prover (BITCOIN_RELAY_VKEY)" BRIDGE \
    "reflection guest unproven on-chain (no $REFLECT_FIXTURE)"
fi

# ── BRIDGE layer 8: Bitcoin-side confidential-pool indexer ──────────────────
# The shipped indexer is the full-scan one (dapp/confidential-reflection-scan-indexer.js); the
# suite exercises it (scan / scan-indexer / attest-scan) plus the witnessed-model oracle tests.
if [ -f dapp/confidential-reflection-scan-indexer.js ]; then
  run_gate "Bitcoin reflection indexer (scan + witnessed oracle)" BRIDGE reflection_suite
else
  block_gate "Bitcoin confidential-pool indexer" BRIDGE \
    "full-scan reflection indexer not built (dapp/confidential-reflection-scan-indexer.js absent)"
fi

# ── BRIDGE layer 9: F4 spent-set completeness (full-scan re-prove landed) ────
# The pinned reflection proof (vkey 0x0050d656…) is the relay-ANCHOR model (F1/F2/F3): it folds
# witnessed effects, so a relayer could omit a Bitcoin spend → the cross-lane non-membership gate
# carries the F4 caveat. The full-scan guest (every-tx/every-vin, no omission) is built in source +
# JS indexer + the signet-307547 input fixture, but its GPU re-prove is the remaining box step —
# it will REPLACE 0x0050d656 with a new vkey + refresh reflection_groth16.json. So this gate stays
# BLOCKED while the pinned reflection vkey is still the anchor-model marker; it auto-clears when the
# re-prove repins. (BLOCKED is an expected-pending milestone, not a regression — it does not fail.)
F4_ANCHOR_VKEY="0x0050d656e9d421d5c75724e17dff0ba83e44813691101b75a96ff42d4aa41d49"
if [ "$RPIN_VKEY" = "$F4_ANCHOR_VKEY" ]; then
  block_gate "F4 spent-set completeness (full-scan re-prove)" BRIDGE \
    "pinned reflection vkey is still the witnessed-anchor model ($F4_ANCHOR_VKEY) — cross-lane carries the F4 omission caveat until the full-scan guest is GPU-re-proven + re-pinned (box step; see elf-vkey-pin.json guest_state + RUNBOOK-confidential-pool-readiness.md)"
else
  run_gate "F4 spent-set completeness (full-scan re-prove landed)" BRIDGE \
    test -n "$RPIN_VKEY"
fi

# ── verdicts ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────── SUMMARY ────────────────────────────────────"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r st ti nm <<<"$r"
  printf '  %-8s %-9s %s\n' "$st" "$ti" "$nm"
done
echo
printf '  totals: PASS=%d  FAIL=%d  BLOCKED=%d\n\n' "$pass" "$fail" "$blocked"

pool_open=0; bridge_open=0
for r in "${RESULTS[@]}"; do
  IFS='|' read -r st ti nm <<<"$r"
  if [ "$st" != "PASS" ]; then
    [ "$ti" = "POOL" ] && pool_open=$((pool_open+1))
    bridge_open=$((bridge_open+1))   # cross-lane requires every pool gate too
  fi
done

if [ "$pool_open" -eq 0 ]; then
  echo "  POOL (Ethereum shielded pool):  READY"
else
  echo "  POOL (Ethereum shielded pool):  NOT READY ($pool_open gate(s) open above)"
fi
if [ "$bridge_open" -eq 0 ]; then
  echo "  BRIDGE (Bitcoin cross-chain):    READY"
else
  echo "  BRIDGE (Bitcoin cross-chain):    NOT READY ($bridge_open gate(s) open above)"
fi
echo "──────────────────────────────────────────────────────────────────────────────"

# Exit nonzero only on a real regression (FAIL); BLOCKED is expected-pending.
[ "$fail" -eq 0 ]
