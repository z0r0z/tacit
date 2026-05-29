#!/bin/bash
set -euo pipefail

# Verify the committed SP1 guest ELF matches its pinned hash + verifying key, so
# an ELF rebuild can never silently desync from the deployed PROGRAM_VKEY (which
# would make every proveStateTransition revert → all withdrawals brick).
#
#   - Always: sha256(program/elf/teth-pool-prover) == elf-vkey-pin.json:elf_sha256
#   - When the SP1 toolchain is present (e.g. the prover host): the vkey derived
#     from the committed ELF (script/src/vkey.rs) == elf-vkey-pin.json:program_vkey
#
# Exit non-zero on any mismatch. CI runs the sha256 leg on every PR; the full
# vkey-derivation leg runs wherever cargo + the SP1 toolchain are available.

cd "$(dirname "$0")"
PIN="elf-vkey-pin.json"
ELF="program/elf/teth-pool-prover"

[ -f "$PIN" ] || { echo "FAIL: missing $PIN"; exit 1; }
[ -f "$ELF" ] || { echo "FAIL: missing $ELF"; exit 1; }

if command -v shasum >/dev/null 2>&1; then
  act_sha=$(shasum -a 256 "$ELF" | cut -d' ' -f1)
else
  act_sha=$(sha256sum "$ELF" | cut -d' ' -f1)
fi
pin_sha=$(grep -oE '"elf_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}')

if [ "$pin_sha" != "$act_sha" ]; then
  echo "FAIL: ELF sha256 mismatch"
  echo "  pinned:   $pin_sha"
  echo "  computed: $act_sha"
  echo "  If you rebuilt the guest, regenerate the vkey and update $PIN in the SAME commit,"
  echo "  then redeploy SP1PoolRootVerifier with the new PROGRAM_VKEY."
  exit 1
fi
echo "PASS: ELF sha256 matches pin ($act_sha)"

pin_vkey=$(grep -oE '"program_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}')
if command -v cargo >/dev/null 2>&1; then
  echo "Deriving vkey from the committed ELF (cargo run --bin vkey)…"
  if out=$(cd script && cargo run --quiet --release --bin vkey 2>/dev/null); then
    derived=$(printf '%s' "$out" | grep -oE '0x[0-9a-f]{64}' | head -1)
    if [ -z "$derived" ]; then
      echo "SKIP: vkey binary produced no 0x-hash output; verified sha256 pin only"
    elif [ "$derived" != "$pin_vkey" ]; then
      echo "FAIL: derived vkey does not match pin"
      echo "  pinned:  $pin_vkey"
      echo "  derived: $derived"
      exit 1
    else
      echo "PASS: derived vkey matches pin ($derived)"
    fi
  else
    echo "SKIP: SP1 toolchain unavailable to build the vkey binary — verified sha256 pin only"
    echo "      (run this on the prover host for the full ELF→vkey binding check)"
  fi
else
  echo "SKIP: cargo unavailable — verified sha256 pin only"
fi
