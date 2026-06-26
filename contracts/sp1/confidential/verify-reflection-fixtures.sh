#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Reflection-fixture freshness gate.
#
# A committed reflection INPUT fixture carries a `newDigest` field — the JS
# assembler's expected reflected-state digest for that input. The guest must
# reproduce it exactly: a drift means either a stale fixture (the field was not
# regenerated after a guest/JS change) or a real guest<->JS divergence. Either
# way the fixture no longer means what it claims, and a re-prove built on it
# would bake in the wrong digest.
#
# This replays each committed fixture through the guest (reflect-exec, execute
# mode) and fails on any mismatch. It is how the 0xba53-vs-0xc737 redeem drift
# was found; run it whenever the guest or the assembler changes.
#
#   reflection-scan fixtures (full write_stdin path)  -> reflect-exec DIGEST_MATCH
#   cxfer-fold fixture (slim CXFER format, no blocks) -> its own generator
#
# Usage:  bash contracts/sp1/confidential/verify-reflection-fixtures.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ELF="$ROOT/contracts/sp1/confidential/elf/reflection-prover"
FXD="$ROOT/contracts/sp1/confidential/fixtures"
EXEC="$ROOT/contracts/sp1/reflect-exec"
fail=0

echo "── reflection-scan fixtures (guest == committed newDigest) ──"
for fx in reflection_input reflection_burn_deposit cbtc_redeem_reflection_input; do
  out=$(cd "$EXEC" && REFLECT_ELF="$ELF" cargo run --release --quiet --bin reflect-execute -- "$FXD/$fx.json" 2>&1)
  if printf '%s' "$out" | grep -q "DIGEST_MATCH"; then
    printf '   PASS  %s\n' "$fx"
  else
    printf '   FAIL  %s\n' "$fx"
    printf '%s\n' "$out" | grep -E "DIGEST_MISMATCH|panicked" | head -2 | sed 's/^/         | /'
    fail=1
  fi
done

echo "── cxfer-fold fixture (generator == committed newDigest) ──"
want=$(python3 -c "import json;print(json.load(open('$FXD/reflection_cxfer_fold.json'))['newDigest'])" 2>/dev/null)
got=$(cd "$ROOT" && node tests/gen-reflection-cxfer-fold.mjs 2>/dev/null | grep -ioE 'newDigest[":= ]+0x[0-9a-f]{64}' | grep -oE '0x[0-9a-f]{64}' | head -1)
if [ -n "$want" ] && [ "$want" = "$got" ]; then
  printf '   PASS  %s\n' "reflection_cxfer_fold"
else
  printf '   FAIL  %s  want=%s got=%s\n' "reflection_cxfer_fold" "$want" "$got"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL REFLECTION FIXTURES FRESH"
else
  echo "STALE / DIVERGENT REFLECTION FIXTURE(S) — regenerate or reconcile before proving"
  exit 1
fi
