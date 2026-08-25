#!/bin/bash
# X-4 lockstep gate: the production cutover rotates four pinned constants together, and a partial
# rotation must never reach a deploy.
#
#   ETH_REFLECTION_VKEY        reflect.rs   the eth-reflection recursion digest the reflection guest verifies
#   ETH_GENESIS_SYNC_COMMITTEE reflect.rs   the beacon anchor that guest trusts
#   BATCH_VK_SHA256            groth16.rs   the in-guest BN254 batch verifying key
#   BITCOIN_RELAY_VKEY / ELF   pin file     the outer reflection program
#
# A partial rotation is fail-closed at run time (a mismatch reverts), so this is not a soundness gate —
# it is a diagnosis gate. Fail-closed at 3am on mainnet, with four places to look, is the scenario this
# prevents: assert every pin was regenerated from the SAME checkpoint before anything ships.
#
# The check is a provenance one. Each rotation must record its checkpoint in the pin file's
# lockstep_checkpoint field; this asserts the constants currently in source hash to the digest recorded
# there. Regenerate with: verify-lockstep-pins.sh --record
set -uo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")"

PIN="elf-vkey-pin.json"
REFLECT="src/reflect.rs"
GROTH="src/groth16.rs"
for f in "$PIN" "$REFLECT" "$GROTH"; do
  [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }
done

sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi; }

# Extract each pinned constant's literal body (the bytes between its `= [` and the closing `];`).
extract() { # file, const-name
  awk -v name="$2" '
    $0 ~ ("const " name ":") { grab=1 }
    grab { print }
    grab && /\];/ { exit }
  ' "$1"
}

eth_vkey=$(extract "$REFLECT" "ETH_REFLECTION_VKEY")
eth_cmte=$(extract "$REFLECT" "ETH_GENESIS_SYNC_COMMITTEE")
batch_vk=$(extract "$GROTH" "BATCH_VK_SHA256")
for v in "$eth_vkey" "$eth_cmte" "$batch_vk"; do
  [ -n "$v" ] || { echo "FAIL: a lockstep constant could not be read from source — check the const names"; exit 1; }
done

relay_vkey=$(grep -oE '"bitcoin_relay_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}' | head -1)
relay_sha=$(grep -oE '"reflection_elf_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}' | head -1)
ethr_vkey=$(grep -oE '"eth_reflection_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}' | head -1)
for v in "$relay_vkey" "$relay_sha" "$ethr_vkey"; do
  [ -n "$v" ] || { echo "FAIL: a lockstep field is missing/malformed in $PIN"; exit 1; }
done

checkpoint=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$eth_vkey" "$eth_cmte" "$batch_vk" "$relay_vkey" "$relay_sha" "$ethr_vkey" | sha)

if [ "${1:-}" = "--record" ]; then
  echo "lockstep_checkpoint = $checkpoint"
  echo "Write this into $PIN as \"lockstep_checkpoint\": \"$checkpoint\" in the SAME commit as the rotation."
  exit 0
fi

recorded=$(grep -oE '"lockstep_checkpoint"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}' | head -1)
if [ -z "$recorded" ]; then
  echo "FAIL: $PIN has no lockstep_checkpoint."
  echo "  The four pins have never been recorded as a set. Run: $0 --record"
  echo "  and commit the value alongside the rotation."
  exit 1
fi
if [ "$recorded" != "$checkpoint" ]; then
  echo "FAIL: lockstep checkpoint mismatch — the four pins are not from one rotation"
  echo "  recorded: $recorded"
  echo "  computed: $checkpoint"
  echo "  One of ETH_REFLECTION_VKEY / ETH_GENESIS_SYNC_COMMITTEE / BATCH_VK_SHA256 / the reflection"
  echo "  vkey+sha+eth_reflection_vkey moved without the others. Re-derive all four from the same"
  echo "  prover-host checkpoint, then re-record with: $0 --record"
  exit 1
fi
# PRODUCTION OUTBOX PIN. ETH_CALL_OUTBOX is the EthCallOutbox address the reflection guest requires an
# ETH->BTC message set to come from. It ships as all-zero, which is fail-closed but permanently INERT: no real
# deployment matches it, so every Mode-B proof carrying a message set fails the equality. The address must be
# filled with the CREATE3-predicted outbox BEFORE the deploy ELF is built (the ordering gate in
# ops/RUNBOOK-launch-deploy-READY.md), and the only thing that can catch a forgotten fill is a gate like this
# one — a rebuild + vkey rotation does not replace a source constant. Set ALLOW_UNPINNED_OUTBOX=1 for a
# pre-cutover/dev build; a production build must not.
outbox=$(extract "$REFLECT" "ETH_CALL_OUTBOX")
[ -n "$outbox" ] || { echo "FAIL: ETH_CALL_OUTBOX could not be read from $REFLECT"; exit 1; }
if printf '%s' "$outbox" | grep -qE '=[[:space:]]*\[0u8;[[:space:]]*20\]'; then
  if [ "${ALLOW_UNPINNED_OUTBOX:-0}" != "1" ]; then
    echo "FAIL: ETH_CALL_OUTBOX is still the all-zero placeholder in $REFLECT."
    echo "  ETH->BTC authenticated messaging is permanently disabled in any ELF built from this source."
    echo "  Fill it with the CREATE3-predicted EthCallOutbox address BEFORE building the deploy ELF."
    echo "  (Pre-cutover builds: re-run with ALLOW_UNPINNED_OUTBOX=1.)"
    exit 1
  fi
  echo "WARN: ETH_CALL_OUTBOX is unpinned (all-zero) — ETH->BTC messaging is inert in this build."
fi

echo "PASS: all four lockstep pins are from the recorded checkpoint ($checkpoint)"
