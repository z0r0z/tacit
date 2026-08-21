#!/usr/bin/env bash
# Local whole-bridge parity simulation: for every reflection op, the JS mirror produces the fixture, the
# guest runs in execute mode (CPU, no box), and its committed newDigest is compared to the mirror's.
# A desync (harvest/zero-input class) shows up as SERIALIZER_PANIC, EXECUTE_FAILED, or MISMATCH.
#
# Usage: tests/reflection-digest-match-sim.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELF="$ROOT/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover"
RUNNER="$ROOT/contracts/sp1/confidential/harnesses/target/release/reflect-local"
FIX="$(mktemp -d)"

[ -x "$RUNNER" ] || { echo "runner not built: $RUNNER"; exit 1; }
[ -f "$ELF" ] || { echo "elf not found: $ELF"; exit 1; }

pass=0; fail=0; declare -a failed
printf "%-22s %-12s %s\n" "OP" "RESULT" "detail"
printf -- "---------------------------------------------------------------\n"

run_one() { # <op-label> <fixture-file>
  local op="$1" fx="$2"
  local out; out="$("$RUNNER" "$ELF" "$fx" 2>&1)"; local rc=$?
  local tag; tag="$(printf '%s' "$out" | head -1 | awk '{print $1}')"
  if [ $rc -eq 0 ]; then pass=$((pass+1)); printf "%-22s %-12s %s\n" "$op" "PASS" "$(printf '%s' "$out"|head -1)";
  else fail=$((fail+1)); failed+=("$op"); printf "%-22s %-12s %s\n" "$op" "FAIL($tag)" "$(printf '%s' "$out"|head -1)"; fi
}

# The canonical genesis fixture (gen-reflection-input.mjs writes reflection_input.json shape).
node "$ROOT/tests/gen-reflection-input.mjs" 2>/dev/null | grep '^{' > "$FIX/genesis.json" && run_one "genesis" "$FIX/genesis.json"

# Every per-op mirror fixture.
for gen in "$ROOT"/tests/gen-reflection-*-synth.mjs; do
  op="$(basename "$gen" | sed 's/gen-reflection-//;s/-synth.mjs//')"
  if node "$gen" 2>/dev/null | grep '^{' > "$FIX/$op.json" && [ -s "$FIX/$op.json" ]; then
    run_one "$op" "$FIX/$op.json"
  else
    fail=$((fail+1)); failed+=("$op"); printf "%-22s %-12s %s\n" "$op" "FAIL(GEN)" "generator produced no fixture"
  fi
done

printf -- "---------------------------------------------------------------\n"
printf "TOTAL: %d pass, %d fail\n" "$pass" "$fail"
[ $fail -eq 0 ] || printf "FAILED OPS: %s\n" "${failed[*]}"
rm -rf "$FIX"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
