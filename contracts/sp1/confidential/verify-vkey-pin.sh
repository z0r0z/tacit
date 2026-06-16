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
pin_sha=$(grep -oE '"elf_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}')

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
rpin=$(grep -oE '"reflection_elf_sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$PIN" | grep -oE '[0-9a-f]{64}')
if [ "$rpin" != "$ract" ]; then
  echo "FAIL: reflection ELF sha256 mismatch"
  echo "  pinned:   $rpin"
  echo "  computed: $ract"
  echo "  If you rebuilt the guest, regenerate BITCOIN_RELAY_VKEY + update $PIN in the SAME commit, then redeploy."
  exit 1
fi
echo "PASS: reflection ELF sha256 matches pin ($ract)"

pin_vkey=$(grep -oE '"program_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}')
relay_vkey=$(grep -oE '"bitcoin_relay_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}')
# Fail closed on a missing/malformed vkey field: a blank program_vkey would deploy a zero PROGRAM_VKEY
# (every settle reverts), and the guest_state prose has lagged these fields before — so assert the
# machine-read fields are present + well-formed here, and treat the fields (not the prose) as canonical.
[ -n "$pin_vkey" ]   || { echo "FAIL: program_vkey missing/malformed in $PIN"; exit 1; }
[ -n "$relay_vkey" ] || { echo "FAIL: bitcoin_relay_vkey missing/malformed in $PIN"; exit 1; }
echo "PINNED program_vkey:       $pin_vkey  (settle; ConfidentialSwapProofReal / ConfidentialProofReal)"
echo "PINNED bitcoin_relay_vkey: $relay_vkey  (reflection; ConfidentialReflectionProofReal)"

# ── Reflection leg FROZEN (Mode B, 2026-06-13) ────────────────────────────────────────────────
# The reflection vkey is FINAL: its groth16 proof verifies on-chain (ConfidentialReflectionProofReal)
# and the REFLECT-1 both-sided conservation test is confirmed + allowlisted (readiness-gate layer 9).
# The settle-side re-prove (deadline/AMM PublicValues) is settle-ONLY and dead-code for the reflection
# guest, so it MUST REPRODUCE these exact bytes — never rotate them. A drift here means cxfer-core's
# reflection path actually moved, which silently invalidates the on-chain fixture + the allowlist with
# no other gate catching it. To re-prove the reflection guest DELIBERATELY, bump both FROZEN_* below in
# the SAME commit that regenerates reflection_groth16.json + re-runs the layer-9 confirmation + re-allowlists.
# Bumped 2026-06-13 in the coordinated re-prove: the AMM consolidation (da8cd9c) added fns to the SHARED
# cxfer-core, which compiles wholesale into BOTH guest ELFs (no per-bin DCE), so it rotated the reflection
# vkey 0x002d2536…→0x004d8dbd… even though it touched no reflection code. The reflection chain was redone
# for the new vkey (fixture + both-sided conservation + allowlist). Any future cxfer-core change rotates
# this again — bump it with a matching re-prove + re-confirm.
FROZEN_REFLECTION_VKEY="0x007a9feef7f58594cfb2ae5e59610e235b309beb23c4a1dc59d68935a0785648"
FROZEN_REFLECTION_ELF_SHA="1173ede85b00fcbbc5ff66200e82d9a270ada34ad9f9c55db1642b74f070900f"
if [ "$relay_vkey" != "$FROZEN_REFLECTION_VKEY" ] || [ "$rpin" != "$FROZEN_REFLECTION_ELF_SHA" ]; then
  echo "FAIL: reflection leg drifted from the frozen Mode-B values"
  echo "  bitcoin_relay_vkey:    got $relay_vkey  expected $FROZEN_REFLECTION_VKEY"
  echo "  reflection_elf_sha256: got $rpin  expected $FROZEN_REFLECTION_ELF_SHA"
  echo "  The reflection vkey is FINAL (on-chain-verified + allowlisted). A settle re-prove is settle-ONLY and"
  echo "  must reproduce it. If you DELIBERATELY re-proved the reflection guest, also regenerate"
  echo "  test/fixtures/reflection_groth16.json, re-run the readiness-gate layer-9 both-sided conservation"
  echo "  confirmation, re-allowlist the new vkey, AND bump the FROZEN_* constants here — all in the same commit."
  exit 1
fi
echo "PASS: reflection leg matches the frozen Mode-B vkey/sha (on-chain-verified + allowlisted)"

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
