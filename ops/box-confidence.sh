#!/usr/bin/env bash
# Production-confidence gate — the deterministic battery that must be GREEN before a freeze.
# Runs on the box (251GB RAM), not a laptop. One command, one green/red board. No hand-inference.
#
# The load-bearing part is PHASE 3: the reflection DIGEST_MATCH board. It rebuilds the guest ELF and the
# mirror from the SAME commit, so a mismatch is real drift (never a stale-fixture artifact — the exact
# ambiguity that made local runs inconclusive). This is the gate that mechanically catches the guest↔mirror
# drift class (harvest/#5, zero-input, cbtc, and any future guest migration a mirror doesn't track).
#
# Usage (on the box, repo at /workspace/tacit): bash ops/box-confidence.sh [--fast]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAST="${1:-}"
declare -A R  # phase -> PASS/FAIL
line(){ printf -- '----------------------------------------------------------------\n'; }

# ── PHASE 0: artifact pins ───────────────────────────────────────────────────────────────────────
# Runs first and in STRICT mode. The later phases all test SOURCE; this one tests what would actually
# be DEPLOYED — that the committed ELFs match their pinned vkeys, that neither has uncommitted drift,
# and that the guest source is not ahead of the binaries. A battery that is green on source while the
# committed ELF predates the fixes is the failure this phase exists to make impossible.
echo "[0/5] artifact pins (verify-vkey-pin.sh strict + X-4 lockstep)"
( cd "$ROOT/contracts/sp1/confidential" && VERIFY_VKEY_STRICT=1 bash verify-vkey-pin.sh >/tmp/bc-pin.log 2>&1 \
  && bash verify-lockstep-pins.sh >>/tmp/bc-pin.log 2>&1 ) \
  && R[pin]=PASS || R[pin]=FAIL
grep -E "^(FAIL|WARN)" /tmp/bc-pin.log | head -4

# ── PHASE 1: Solidity ────────────────────────────────────────────────────────────────────────────
echo "[1/5] forge test"
( cd "$ROOT/contracts" && forge test >/tmp/bc-forge.log 2>&1 ) && R[forge]=PASS || R[forge]=FAIL
grep -E "Ran [0-9]+ test suites|[0-9]+ failed" /tmp/bc-forge.log | tail -2

# ── PHASE 2: Rust (cxfer-core + guest lib tests) ─────────────────────────────────────────────────
echo "[2/5] cargo test (cxfer-core)"
( cd "$ROOT/contracts/sp1/confidential/cxfer-core" && cargo test --lib >/tmp/bc-cargo.log 2>&1 ) && R[cargo]=PASS || R[cargo]=FAIL
grep -E "test result:" /tmp/bc-cargo.log | tail -2

# ── PHASE 3: reflection DIGEST_MATCH board (guest ↔ mirror, same generation) ──────────────────────
# Rebuild the guest ELF from CURRENT source so it matches the CURRENT mirror. Then for each op, the
# mirror generates the fixture (carrying its own computed newDigest) and the guest executes it; the
# committed digest must equal the mirror's. Same-commit triple ⇒ a mismatch is real drift.
echo "[3/5] reflection DIGEST_MATCH board (rebuild ELF + per-op parity)"
export PATH="$HOME/.sp1/bin:$PATH"
( cd "$ROOT/contracts/sp1/confidential" && cargo prove build --bin reflection-prover >/tmp/bc-elf.log 2>&1 ) \
  && ( cd "$ROOT/contracts/sp1/confidential/harnesses" && cargo build --release --bin reflect-local >>/tmp/bc-elf.log 2>&1 ) \
  || { R[digest]=FAIL; echo "  ELF/runner build failed — see /tmp/bc-elf.log"; }
ELF="$ROOT/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover"
RUN="$ROOT/contracts/sp1/confidential/harnesses/target/release/reflect-local"
dmp=0; dmf=0; declare -a dmfail
if [ -x "$RUN" ] && [ -f "$ELF" ]; then
  FIX="$(mktemp -d)"
  for gen in "$ROOT"/tests/gen-reflection-*-synth.mjs; do
    op="$(basename "$gen" | sed 's/gen-reflection-//;s/-synth.mjs//')"
    node "$gen" 2>/dev/null | grep '^{' > "$FIX/$op.json"
    [ -s "$FIX/$op.json" ] || { dmf=$((dmf+1)); dmfail+=("$op:GEN"); continue; }
    out="$("$RUN" "$ELF" "$FIX/$op.json" 2>&1 | head -1)"
    case "$out" in
      MATCH*) dmp=$((dmp+1)); printf "  %-20s MATCH\n" "$op" ;;
      *)      dmf=$((dmf+1)); dmfail+=("$op"); printf "  %-20s FAIL  %s\n" "$op" "$(printf '%s' "$out"|cut -c1-60)" ;;
    esac
  done
  rm -rf "$FIX"
  [ $dmf -eq 0 ] && R[digest]=PASS || R[digest]=FAIL
fi

# ── PHASE 4: JS mirror suite (parity + fold tests) ───────────────────────────────────────────────
# Several of these are heavy BP+/crypto suites that run for many minutes, so they are run in parallel
# with a per-test deadline. A test that exceeds the deadline is counted as TIMEOUT, NOT as a failure:
# conflating the two is how a green-looking suite hides real breakage (and how a slow test gets
# "fixed" by weakening it). Raise JS_TIMEOUT on the box if a legitimate suite needs longer.
echo "[4/5] JS mirror suite (.test.mjs)"
jsp=0; jsf=0; jst=0
JS_TIMEOUT="${JS_TIMEOUT:-900}"
JS_JOBS="${JS_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
if [ "$FAST" != "--fast" ]; then
  jsdir="$(mktemp -d)"
  run_one() { # test-path
    local t="$1" base; base="$(basename "$t")"
    node "$t" >"$jsdir/$base.log" 2>&1 &
    local p=$! rc
    ( sleep "$JS_TIMEOUT"; kill -9 $p 2>/dev/null; echo timeout >"$jsdir/$base.killed" ) & local w=$!
    if wait $p 2>/dev/null; then rc=0; else rc=1; fi
    kill $w 2>/dev/null
    if [ -f "$jsdir/$base.killed" ]; then echo "TIMEOUT $base" >>"$jsdir/results"
    elif [ $rc -eq 0 ]; then echo "PASS $base" >>"$jsdir/results"
    else echo "FAIL $base" >>"$jsdir/results"; fi
  }
  n=0
  for t in "$ROOT"/tests/*.test.mjs; do
    run_one "$t" &
    n=$((n+1)); [ $((n % JS_JOBS)) -eq 0 ] && wait
  done
  wait
  jsp=$(grep -c '^PASS' "$jsdir/results" 2>/dev/null || echo 0)
  jsf=$(grep -c '^FAIL' "$jsdir/results" 2>/dev/null || echo 0)
  jst=$(grep -c '^TIMEOUT' "$jsdir/results" 2>/dev/null || echo 0)
  grep -E '^(FAIL|TIMEOUT)' "$jsdir/results" 2>/dev/null | sed 's/^/  /'
  rm -rf "$jsdir"
  # A timeout is not a pass. It means the battery did not observe that suite's verdict, so the board
  # cannot claim green on it.
  { [ "$jsf" -eq 0 ] && [ "$jst" -eq 0 ]; } && R[js]=PASS || R[js]=FAIL
else R[js]=SKIP; fi

# ── Board ────────────────────────────────────────────────────────────────────────────────────────
line; echo "PRODUCTION-CONFIDENCE BOARD  (commit $(cd "$ROOT" && git rev-parse --short HEAD))"; line
printf "  %-28s %s\n" "0. artifact pins (strict)"     "${R[pin]:-?}"
printf "  %-28s %s\n" "1. forge test"                 "${R[forge]:-?}"
printf "  %-28s %s\n" "2. cargo test (cxfer-core)"    "${R[cargo]:-?}"
printf "  %-28s %s  (%d match / %d fail)\n" "3. reflection DIGEST_MATCH" "${R[digest]:-?}" "$dmp" "$dmf"
[ $dmf -gt 0 ] && printf "       drift: %s\n" "${dmfail[*]}"
printf "  %-28s %s  (%d pass / %d fail / %d timeout)\n" "4. JS mirror suite" "${R[js]:-?}" "$jsp" "$jsf" "$jst"
line
green=1; for k in pin forge cargo digest js; do [ "${R[$k]:-FAIL}" = "PASS" ] || [ "${R[$k]:-}" = "SKIP" ] || green=0; done
[ $green -eq 1 ] && echo "RESULT: GREEN — battery passed." || echo "RESULT: RED — see failures above."
exit $((1-green))
