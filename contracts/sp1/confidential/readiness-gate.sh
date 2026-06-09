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
           confidential-canonical-asset-id confidential-evm-log confidential-note-binds-amm; do
    if ! node "tests/$t.mjs" >>"$TMP.node" 2>&1; then echo "FAIL $t"; rc=1; fi
  done
  cat "$TMP.node" >>"$TMP" 2>/dev/null; rm -f "$TMP.node"
  return $rc
}

# node helper: the Bitcoin reflection indexer + prover-input tests.
reflection_suite() {
  local t rc=0
  for t in confidential-reflection-state confidential-reflection-witness \
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
printf '──▶ %-58s [%s]\n' "vkey coherence: deployed guest == proven guest" "POOL"
DEP_VKEY="$(grep -oE 'DEFAULT_VKEY = 0x[0-9a-fA-F]{64}' "$DEPLOY" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)"
FX_VKEY="$(node -e 'try{process.stdout.write(require("./'"$GROTH16_FIXTURE"'").vkey)}catch(e){}' 2>/dev/null)"
printf '    deploy DEFAULT_VKEY : %s\n' "${DEP_VKEY:-<none>}"
printf '    real-proof fixture  : %s\n' "${FX_VKEY:-<none>}"
if [ -n "$DEP_VKEY" ] && [ "$DEP_VKEY" = "$FX_VKEY" ]; then
  printf '    PASS  the deploy-default guest has an on-chain Groth16 proof\n'
  pass=$((pass+1)); RESULTS+=("PASS|POOL|vkey coherence")
else
  block_gate "vkey coherence" POOL \
    "deploy default != real-proof fixture: the current guest has no on-chain proof (box: re-prove, refresh $GROTH16_FIXTURE, repin DEFAULT_VKEY)"
fi

# ── POOL layer 5: guest ELF pin discipline (no silent drift) ─────────────────
if [ -f "$PIN" ]; then
  run_gate "Guest ELF/vkey pin matches committed ELF" POOL \
    bash -c 'test -s "'"$PIN"'"'
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
if [ -f dapp/confidential-reflection-indexer.js ]; then
  run_gate "Bitcoin reflection indexer (state / witness / indexer / attest)" BRIDGE reflection_suite
else
  block_gate "Bitcoin confidential-pool indexer" BRIDGE \
    "reflection indexer not built (dapp/confidential-reflection-indexer.js absent)"
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
