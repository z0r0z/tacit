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
RELF="elf/reflection-prover"

[ -f "$PIN" ] || { echo "FAIL: missing $PIN"; exit 1; }
[ -f "$ELF" ] || { echo "FAIL: missing $ELF"; exit 1; }

# WARN/STRICT policy, declared up front: both the source-coherence check below and the git-coherence
# checks further down use it. Default WARN so a branch legitimately mid-re-prove still builds;
# VERIFY_VKEY_STRICT=1 (set by the deploy/readiness path) makes any drift a hard FAIL.
STRICT="${VERIFY_VKEY_STRICT:-0}"
drift() { # message
  if [ "$STRICT" = "1" ]; then echo "FAIL (strict): $1"; exit 1; else echo "WARN: $1 (set VERIFY_VKEY_STRICT=1 to enforce)"; fi
}

# ── ELF ↔ SOURCE coherence (the gap the sha checks cannot see) ─────────────────────────────────
# Everything above binds the ELF to the pin and to git. None of it binds the ELF to the SOURCE it was
# built from: a pin and an ELF that agree with each other are still stale if the guest source moved on
# after the build. That is the state this repo reaches during a hardening round — fixes land in
# cxfer-core/src, confidential/src and eth-reflection/src while the committed ELFs stay at the last
# re-prove — and a deploy cut from it ships binaries that do not contain the fixes, with every pin green.
# Assert EACH ELF commit is no older than the newest commit touching ITS OWN source set — per-ELF, never as
# a set. Taking the newest of all sources as one shared baseline lets a rebuild of either ELF launder the
# staleness of the other, but it also cries wolf: the two binaries share cxfer-core AND three modules, yet
# main.rs/swap_blind.rs are settle-only and reflect.rs/eth-reflection are reflection-only, so a reflect.rs-only
# commit would flag the settle ELF as stale and tell the operator to re-prove a binary nothing changed in. A
# WARN nobody believes is a WARN nobody acts on at deploy time. So: everything SHARED still forces both ELFs to
# clear it (no laundering), while each binary is additionally measured against its own exclusive sources. Any
# file under src/ that belongs to neither list is a hard failure — a new module can never sit unwatched.
if git -C . rev-parse --git-dir >/dev/null 2>&1; then
  # Shared by BOTH binaries (cxfer-core plus the modules main.rs and reflect.rs both declare).
  SHARED_SRC="cxfer-core/src src/babyjubjub.rs src/groth16.rs src/swap_batch.rs src/batch_vk.bin"
  ELF_ONLY_SRC="src/main.rs src/swap_blind.rs"          # settle guest only
  RELF_ONLY_SRC="src/reflect.rs ../eth-reflection/src"  # reflection prover only

  # Coverage guard: every file under src/ must be claimed by exactly one list above.
  for f in src/*; do
    case " $SHARED_SRC $ELF_ONLY_SRC $RELF_ONLY_SRC " in
      *" $f "*) ;;
      *) echo "FAIL: $f is under src/ but belongs to no ELF's source set — add it to SHARED_SRC," \
              "ELF_ONLY_SRC or RELF_ONLY_SRC in $0 so its changes are gated"; exit 1;;
    esac
  done

  check_elf_freshness() { # elf, its exclusive sources
    e="$1"; own_src="$2"
    src_commit_date=$(git -C . log -1 --format=%ct -- $SHARED_SRC $own_src 2>/dev/null || true)
    elf_commit_date=$(git -C . log -1 --format=%ct -- "$e" 2>/dev/null || true)
    if [ -z "$src_commit_date" ]; then
      echo "INFO: could not resolve the source commit date for $e — skipping its ELF<->source coherence"
    elif [ -z "$elf_commit_date" ]; then
      echo "INFO: could not resolve the commit date of $e — skipping its ELF<->source coherence"
    elif [ "$src_commit_date" -gt "$elf_commit_date" ]; then
      n_ahead=$(git -C . rev-list --count "$(git -C . log -1 --format=%H -- "$e")..HEAD" -- $SHARED_SRC $own_src 2>/dev/null || echo "?")
      drift "the source of $e is ahead of it by $n_ahead commit(s) — that binary predates $(git -C . log -1 --format=%h\ \"%s\" -- $SHARED_SRC $own_src). Re-prove and commit the ELF + pin before deploy"
    else
      echo "PASS: $e is at or ahead of the newest commit touching its own sources"
    fi
  }
  check_elf_freshness "$ELF" "$ELF_ONLY_SRC"
  check_elf_freshness "$RELF" "$RELF_ONLY_SRC"
else
  echo "INFO: not a git checkout — skipping ELF<->source coherence"
fi

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

# ── Three-way git coherence (drift guard) ──────────────────────────────────────────────────────
# The sha checks above only bind the WORKING-TREE ELF to the pin. They do NOT catch:
#   (a) a working-tree ELF/pin that is modified but NOT committed (a deploy cut from a dirty tree
#       ships an uncommitted binary), or
#   (b) the ELF/pin committed at HEAD disagreeing with each other (committed drift).
# Both are real states this repo has hit mid-re-prove. Assert all three agree: HEAD's committed ELF
# sha == pin sha, AND the ELF + pin have no uncommitted working-tree changes. Default = WARN (so a
# branch legitimately mid-re-prove still builds); VERIFY_VKEY_STRICT=1 (set by the deploy/readiness
# path) makes any drift a hard FAIL so it can never silently reach a deploy.
if git -C . rev-parse --git-dir >/dev/null 2>&1; then
  # (a) uncommitted changes to the ELF or pin in the working tree
  if ! git -C . diff --quiet HEAD -- "$ELF" "$RELF" "$PIN" 2>/dev/null; then
    drift "elf/cxfer-guest, elf/reflection-prover, or $PIN has uncommitted changes vs HEAD — commit the re-prove (ELF + vkey + pin sha) before deploy"
  else
    echo "PASS: ELF + pin are committed (no uncommitted drift vs HEAD)"
  fi
  # (b) HEAD's committed ELF sha must equal the pin sha (catches committed-but-unpinned ELF)
  head_sha=$(git -C . show "HEAD:./$ELF" 2>/dev/null | { command -v shasum >/dev/null 2>&1 && shasum -a 256 || sha256sum; } | cut -d' ' -f1)
  if [ -n "$head_sha" ] && [ "$head_sha" != "$pin_sha" ]; then
    drift "HEAD's committed elf/cxfer-guest sha ($head_sha) != pinned elf_sha256 ($pin_sha) — the committed ELF and committed pin disagree"
  elif [ -n "$head_sha" ]; then
    echo "PASS: HEAD's committed ELF sha matches the pin"
  fi
else
  echo "INFO: not a git work tree — skipping committed-vs-working ELF coherence"
fi

pin_vkey=$(grep -oE '"program_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}' | head -1)
relay_vkey=$(grep -oE '"bitcoin_relay_vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$PIN" | grep -oE '0x[0-9a-f]{64}' | head -1)
# Fail closed on a missing/malformed vkey field: a blank program_vkey would deploy a zero PROGRAM_VKEY
# (every settle reverts), and the guest_state prose has lagged these fields before — so assert the
# machine-read fields are present + well-formed here, and treat the fields (not the prose) as canonical.
[ -n "$pin_vkey" ]   || { echo "FAIL: program_vkey missing/malformed in $PIN"; exit 1; }
[ -n "$relay_vkey" ] || { echo "FAIL: bitcoin_relay_vkey missing/malformed in $PIN"; exit 1; }
echo "PINNED program_vkey:       $pin_vkey  (settle; ConfidentialSwapProofReal / ConfidentialProofReal)"
echo "PINNED bitcoin_relay_vkey: $relay_vkey  (reflection; ConfidentialReflectionProofReal)"

# ── Deploy-script ↔ pin coherence (the anti-brick gate: the deployed verifier's vkey must equal the
# pinned program_vkey BEFORE deploy — caught here, not just at the on-chain DeployConfidentialPool require). ──
for DEPLOY in "../../script/DeployConfidentialPool.s.sol"; do
  [ -f "$DEPLOY" ] || continue
  dep_vkey=$(grep -oE 'DEFAULT_VKEY[[:space:]]*=[[:space:]]*0x[0-9a-f]{64}' "$DEPLOY" | grep -oE '0x[0-9a-f]{64}' | head -1 || true)
  [ -n "$dep_vkey" ] || { echo "FAIL: DEFAULT_VKEY missing/malformed in $DEPLOY"; exit 1; }
  [ "$dep_vkey" = "$pin_vkey" ] || { echo "FAIL: $(basename "$DEPLOY") DEFAULT_VKEY ($dep_vkey) != pinned program_vkey ($pin_vkey)"; exit 1; }
  echo "PASS: $(basename "$DEPLOY") DEFAULT_VKEY matches the pinned program_vkey"
done

# ── Every committed Groth16 fixture must bind to one of the two pinned vkeys (a fixture matching neither
# is a stale proof from before a re-prove — re-prove + recommit it, don't ship drift). ──
ns=0; nr=0
for FX in ../../test/fixtures/*_groth16.json; do
  [ -f "$FX" ] || continue
  fxv=$(grep -oE '"vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$FX" | grep -oE '0x[0-9a-f]{64}' | head -1 || true)
  [ -n "$fxv" ] || { echo "FAIL: $(basename "$FX") vkey missing/malformed"; exit 1; }
  if [ "$fxv" = "$pin_vkey" ]; then ns=$((ns + 1));
  elif [ "$fxv" = "$relay_vkey" ]; then nr=$((nr + 1));
  else echo "FAIL: $(basename "$FX") vkey ($fxv) matches NEITHER pinned vkey — stale proof, re-prove + recommit"; exit 1; fi
done
echo "PASS: all committed Groth16 fixtures bind to a pinned vkey ($ns settle / $nr reflection)"

# ── Reflection leg pinned (mainnet-anchored, 2026-07-12: Change B count==0 bootstrap) ───────────────────────────────
# The reflection vkey is an explicit coordination point: its Groth16 proofs verify on-chain
# (ConfidentialReflectionProofReal + ConfidentialReflectionBurnDepositProofReal) and readiness-gate
# layer 9 must separately allowlist the exact vkey after a REFLECT-1 conservation negative test.
# Any reflection ELF drift invalidates the on-chain fixtures and the soundness allowlist, so a
# deliberate re-prove must bump both FROZEN_* here in the same commit that regenerates the reflection
# fixtures and re-runs the layer-9 confirmation. The name is historical: these are not "never rotate"
# constants, they are fail-closed drift guards for the currently pinned reflection ELF.
FROZEN_REFLECTION_VKEY="0x00edafc6bb483778bf126be1c810fb7bda29cdb7996cd1ecb5a8896aac0c4f05"
FROZEN_REFLECTION_ELF_SHA="1e2a75fbe8a09a0f1130336e52966d5cf1a2de9d43c4578f598847295b7ca9b1"
if [ "$relay_vkey" != "$FROZEN_REFLECTION_VKEY" ] || [ "$rpin" != "$FROZEN_REFLECTION_ELF_SHA" ]; then
  echo "FAIL: reflection leg drifted from the frozen Mode-B values"
  echo "  bitcoin_relay_vkey:    got $relay_vkey  expected $FROZEN_REFLECTION_VKEY"
  echo "  reflection_elf_sha256: got $rpin  expected $FROZEN_REFLECTION_ELF_SHA"
  echo "  Reflection ELF drift must be deliberate. Regenerate reflection_groth16.json and"
  echo "  reflection_burn_deposit_groth16.json, re-run the readiness-gate layer-9 conservation"
  echo "  confirmation, re-allowlist the new vkey, and bump FROZEN_* here — all in the same commit."
  exit 1
fi
echo "PASS: reflection leg matches the pinned mainnet vkey/sha"

# Cross-artifact coherence: every on-chain reflection fixture's vkey IS the pin, so each proof a deployer
# relies on verifies against the same BITCOIN_RELAY_VKEY that will be deployed.
for RFX in "../../test/fixtures/reflection_groth16.json" "../../test/fixtures/reflection_burn_deposit_groth16.json"; do
  if [ -f "$RFX" ]; then
    fx_name="$(basename "$RFX")"
    fx_vkey=$(grep -oE '"vkey"[[:space:]]*:[[:space:]]*"0x[0-9a-f]{64}"' "$RFX" | grep -oE '0x[0-9a-f]{64}' | head -1 || true)
    [ -n "$fx_vkey" ] || { echo "FAIL: $fx_name vkey missing/malformed"; exit 1; }
    [ "$fx_vkey" = "$relay_vkey" ] || { echo "FAIL: $fx_name vkey ($fx_vkey) != pinned bitcoin_relay_vkey ($relay_vkey)"; exit 1; }
    echo "PASS: $fx_name fixture vkey matches the pin"
  fi
done
echo
echo "The sha256 checks above prove the committed bytes; they do NOT prove the pinned vkey is the one"
echo "this ELF derives. That binding is enforced mechanically at:"
echo "  - prove time: exec-prove.rs / exec-reflect-prove.rs abort unless the derived vkey equals the"
echo "                pin (set EXPECT_VKEY=<pinned> or ELF_VKEY_PIN=$PIN before proving)."
echo "  - deploy time: DeployConfidentialPool require(PROGRAM_VKEY == .program_vkey)."
echo "After ANY ELF rebuild, derive both vkeys on the prover host and reconcile every field in $PIN"
echo "(program_vkey, bitcoin_relay_vkey, both sha256s, guest_state) in the SAME commit."
