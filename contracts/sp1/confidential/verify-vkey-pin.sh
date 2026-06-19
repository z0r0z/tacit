#!/bin/bash
set -euo pipefail

# Verify the committed confidential SP1 guest ELF matches its pinned hash (+ vkey on the prover
# host), so an ELF rebuild can never silently desync from the deployed PROGRAM_VKEY — a desync
# would make every ConfidentialPool.settle revert.
#
#   - Always: sha256(elf/cxfer-guest) == elf-vkey-pin.json:elf_sha256
#   - On the prover host (SP1 toolchain present): rebuild the guest and confirm the derived vkey
#     == elf-vkey-pin.json:program_vkey. `cargo prove build` in ../../guest equivalent, then
#     exec-swap.rs MODE=execute prints `VKEY=...`. That leg is documented, not auto-run here
#     (it needs the box + the fixture); CI runs the sha256 leg.
#
# Exit non-zero on any mismatch.
export LC_ALL=C
export LANG=C

cd "$(dirname "$0")"
PIN="elf-vkey-pin.json"
ELF="elf/cxfer-guest"

[ -f "$PIN" ] || { echo "FAIL: missing $PIN"; exit 1; }
[ -f "$ELF" ] || { echo "FAIL: missing $ELF"; exit 1; }

if command -v shasum >/dev/null 2>&1; then
  act_sha=$(shasum -a 256 "$ELF" | cut -d' ' -f1)
else
  act_sha=$(sha256sum "$ELF" | cut -d' ' -f1)
fi
pin_sha=$(grep -oE '"elf_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}' | head -1)

if [ "$pin_sha" != "$act_sha" ]; then
  echo "FAIL: ELF sha256 mismatch"
  echo "  pinned:   $pin_sha"
  echo "  computed: $act_sha"
  echo "  If you rebuilt the guest, regenerate the vkey and update $PIN in the SAME commit,"
  echo "  then redeploy ConfidentialPool with the new PROGRAM_VKEY."
  exit 1
fi
echo "PASS: settle-guest ELF sha256 matches pin ($act_sha)"

# Reflection prover ELF (the Bitcoin-state relay; built by the same cargo prove build) → BITCOIN_RELAY_VKEY.
RELF="elf/reflection-prover"
[ -f "$RELF" ] || { echo "FAIL: missing $RELF"; exit 1; }
if command -v shasum >/dev/null 2>&1; then ract=$(shasum -a 256 "$RELF" | cut -d' ' -f1); else ract=$(sha256sum "$RELF" | cut -d' ' -f1); fi
rpin=$(grep -oE '"reflection_elf_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}' | head -1)
if [ "$rpin" != "$ract" ]; then
  echo "FAIL: reflection ELF sha256 mismatch"
  echo "  pinned:   $rpin"
  echo "  computed: $ract"
  echo "  If you rebuilt the guest, regenerate BITCOIN_RELAY_VKEY + update $PIN in the SAME commit, then redeploy."
  exit 1
fi
echo "PASS: reflection ELF sha256 matches pin ($ract)"

pin_vkey=$(grep -oE '"program_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}' | head -1)
relay_vkey=$(grep -oE '"bitcoin_relay_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}' | head -1)
# Fail closed on a missing/malformed vkey field: a blank program_vkey would deploy a zero PROGRAM_VKEY
# (every settle reverts), and the guest_state prose has lagged these fields before — so assert the
# machine-read fields are present + well-formed here, and treat the fields (not the prose) as canonical.
[ -n "$pin_vkey" ]   || { echo "FAIL: program_vkey missing/malformed in $PIN"; exit 1; }
[ -n "$relay_vkey" ] || { echo "FAIL: bitcoin_relay_vkey missing/malformed in $PIN"; exit 1; }
echo "PINNED program_vkey:       $pin_vkey  (settle; ConfidentialSwapProofReal / ConfidentialProofReal)"
echo "PINNED bitcoin_relay_vkey: $relay_vkey  (reflection; ConfidentialReflectionProofReal)"

# ── Reflection leg deliberately pinned (Sepolia E2, 2026-06-19) ───────────────────────────────
# The reflection vkey is an explicit coordination point: its Groth16 proofs verify on-chain
# (ConfidentialReflectionProofReal + ConfidentialReflectionBurnDepositProofReal) and readiness-gate
# layer 9 must separately allowlist the exact vkey after a REFLECT-1 conservation negative test.
# Any reflection ELF drift invalidates the on-chain fixtures and the soundness allowlist, so a
# deliberate re-prove must bump both FROZEN_* here in the same commit that regenerates the reflection
# fixtures and re-runs the layer-9 confirmation. The name is historical: these are not "never rotate"
# constants, they are fail-closed drift guards for the currently pinned reflection ELF.
FROZEN_REFLECTION_VKEY="0x008c9fa6e9ee312ba99be8ba5a222ad161912fafebc3cec893e3dfc25f041160"
FROZEN_REFLECTION_ELF_SHA="121659ce8f5c2e42c092a18de3651d33b43c25db0321c9b71e628e62fc78c689"
if [ "$relay_vkey" != "$FROZEN_REFLECTION_VKEY" ] || [ "$rpin" != "$FROZEN_REFLECTION_ELF_SHA" ]; then
  echo "FAIL: reflection leg drifted from the frozen Mode-B values"
  echo "  bitcoin_relay_vkey:    got $relay_vkey  expected $FROZEN_REFLECTION_VKEY"
  echo "  reflection_elf_sha256: got $rpin  expected $FROZEN_REFLECTION_ELF_SHA"
  echo "  Reflection ELF drift must be deliberate. Regenerate reflection_groth16.json and"
  echo "  reflection_burn_deposit_groth16.json, re-run the readiness-gate layer-9 conservation"
  echo "  confirmation, re-allowlist the new vkey, and bump FROZEN_* here — all in the same commit."
  exit 1
fi
echo "PASS: reflection leg matches the pinned Sepolia E2 vkey/sha"

# Cross-artifact coherence: the on-chain reflection fixture's vkey IS the pin, so the proof a deployer
# sets BITCOIN_RELAY_VKEY to is the same one that verifies on-chain (mirror of test_fixture_vkey_matches_pin).
RFX="../../test/fixtures/reflection_groth16.json"
if [ -f "$RFX" ]; then
  fx_vkey=$(grep -oE '"vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$RFX" | grep -oE '0x[0-9a-f]{64}')
  [ "$fx_vkey" = "$relay_vkey" ] || { echo "FAIL: reflection_groth16.json vkey ($fx_vkey) != pinned bitcoin_relay_vkey ($relay_vkey)"; exit 1; }
  echo "PASS: reflection_groth16 fixture vkey matches the pin"
fi
echo
echo "The sha256 checks above prove the committed bytes; they do NOT prove the pinned vkey is the one"
echo "this ELF derives. That binding is enforced mechanically at:"
echo "  - prove time: exec-prove.rs / exec-reflect-prove.rs abort unless the derived vkey equals the"
echo "                pin (set EXPECT_VKEY=<pinned> or ELF_VKEY_PIN=$PIN before proving)."
echo "  - deploy time: DeployConfidentialPool require(PROGRAM_VKEY == .program_vkey)."
echo "After ANY ELF rebuild, derive both vkeys on the prover host and reconcile every field in $PIN"
echo "(program_vkey, bitcoin_relay_vkey, both sha256s, guest_state) in the SAME commit."
