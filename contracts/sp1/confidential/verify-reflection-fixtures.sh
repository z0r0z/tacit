#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Reflection-fixture freshness / guest↔JS parity gate.
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
# and the mode_b/coinbase divergence were found; run it whenever the guest or
# the assembler changes.
#
# Every reflection fold that has a generator (gen-reflection-*-synth.mjs) is
# covered here — each generator's block carries a COINBASE at tx 0 (the guest
# extracts a Taproot envelope only for ti != 0), so the envelope tx is a later
# tx the guest actually folds. Regenerate the committed fixtures with
# `gen-all-reflection-fixtures.sh` after any reflection guest/assembler change.
#
# By default this builds the reflection ELF from CURRENT SOURCE (the box
# re-prove produces the same vkey), so it proves guest(current source) ==
# JS(current source) rather than testing the possibly-stale committed pinned
# ELF. Set REFLECT_ELF to pin a specific ELF; it falls back to the committed
# pinned ELF if the SP1 toolchain is absent.
#
# reflection_swapbatch carries a REAL Groth16 proof under the production ceremony HEAD zkey (final post-beacon,
# CID bafybeieb5hafaix2xwvnmsodby4vkvcpdv4bpt4ny3etza4lpy2rxefwqm, sha256 6ed30983…; VK == baked batch_vk.bin) —
# its reflect-exec is a real in-guest BN254 Groth16 verify (~5.4B cycles, slow). The committed fixture validates
# WITHOUT the zkey; only REGENERATING it needs REFLECT_SWAPBATCH_ZKEY=<head zkey> (gen-all skips it if absent).
#
# Folds NOT covered by a DIGEST_MATCH fixture here (covered elsewhere):
#   - btc_call (T_BTC_CALL 0x68): value-free, writes only the `btcCallsFolded` PV
#     field (not digest()), so a digest fixture can't exercise it; covered by its
#     own classify/fold unit tests.
#   - cbtc_lock_spends (rug detection): covered by tests/confidential-cbtc-lock-fold.mjs.
#
# Usage:  bash contracts/sp1/confidential/verify-reflection-fixtures.sh
#         REFLECT_ELF=/path/to/elf bash .../verify-reflection-fixtures.sh   # pin an ELF
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
FXD="$ROOT/contracts/sp1/confidential/fixtures"
EXEC="$ROOT/contracts/sp1/reflect-exec"
PINNED="$ROOT/contracts/sp1/confidential/elf/reflection-prover"
fail=0

# Resolve the ELF to validate against: explicit REFLECT_ELF > fresh current-source build > pinned.
ELF="${REFLECT_ELF:-}"
if [ -z "$ELF" ]; then
  CARGO_PROVE=""
  command -v cargo-prove >/dev/null 2>&1 && CARGO_PROVE="cargo-prove"
  [ -z "$CARGO_PROVE" ] && [ -x "$HOME/.sp1/bin/cargo-prove" ] && CARGO_PROVE="$HOME/.sp1/bin/cargo-prove"
  BUILT="$ROOT/contracts/sp1/confidential/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover"
  if [ -n "$CARGO_PROVE" ]; then
    echo "── building reflection ELF from current source ──"
    ( cd "$ROOT/contracts/sp1/confidential" && PATH="$HOME/.sp1/bin:$PATH" cargo prove build --bin reflection-prover >/dev/null 2>&1 )
    if [ -f "$BUILT" ]; then ELF="$BUILT"; else ELF="$PINNED"; echo "   (build failed — falling back to pinned ELF)"; fi
  else
    ELF="$PINNED"; echo "── SP1 toolchain absent — validating against the committed pinned ELF ──"
  fi
fi
echo "ELF: $ELF"
echo

echo "── reflection-scan fixtures (guest == committed JS newDigest) ──"
for fx in reflection_input reflection_burn_deposit cbtc_redeem_reflection_input reflection_farm_lifecycle \
          reflection_modeb reflection_cbtc_lock reflection_cbtc_spend reflection_crossout reflection_farminit reflection_harvest \
          reflection_lp_poolinit reflection_lp_add reflection_lpremove reflection_protofee \
          reflection_swaproute reflection_swapvar reflection_poolresume reflection_swapbatch \
          reflection_lpbond reflection_farmrefund reflection_bid; do
  if [ ! -f "$FXD/$fx.json" ]; then printf '   MISS  %s  (no committed fixture — run gen-all-reflection-fixtures.sh)\n' "$fx"; fail=1; continue; fi
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
