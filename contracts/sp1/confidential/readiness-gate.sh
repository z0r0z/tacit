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
           confidential-canonical-asset-id confidential-evm-log confidential-note-binds-amm \
           confidential-swap-op confidential-lp-op confidential-otc-op confidential-bid-op \
           confidential-stealth confidential-stealth-op confidential-airdrop \
           confidential-bridge-stealth-op \
           confidential-finality; do
    if ! node "tests/$t.mjs" >>"$TMP.node" 2>&1; then echo "FAIL $t"; rc=1; fi
  done
  cat "$TMP.node" >>"$TMP" 2>/dev/null; rm -f "$TMP.node"
  return $rc
}

# node helper: the Bitcoin reflection indexer + prover-input tests. The SHIPPED model is the
# full SCAN (confidential-reflection-scan*: every tx of every block, F4-complete); the witnessed
# (state/witness/indexer) tests stay as the superseded-model cross-check oracle. The burn-deposit
# block covers the scan-free TAC onboarding (realness mirror, assembler, tracer, the raw-tx kit,
# the indexer wiring, and the attester injection seam). Both styles run under plain `node` (the
# node:test files auto-run + set the exit code), and all must be green.
reflection_suite() {
  local t rc=0
  for t in confidential-reflection-scan confidential-reflection-scan-indexer \
           confidential-reflection-attest-scan confidential-reflection-conservation \
           confidential-reflection-state confidential-reflection-witness \
           confidential-reflection-indexer \
           confidential-reflection-unsupported-guard confidential-cbtc-lock-fold confidential-fastlane-consumed \
           confidential-swapvar-fold confidential-swaproute-fold confidential-harvest-fold confidential-protofee-fold \
           confidential-farminit-fold confidential-lpremove-fold confidential-lpadd-fold confidential-bid-fold \
           confidential-swapbatch-core confidential-bjj-xcurve confidential-swapbatch-publics confidential-swapbatch-groth16 confidential-swapbatch-fold \
           confidential-amm-classify \
           burn-deposit-provenance burn-deposit-assembler burn-deposit-tracer \
           burn-deposit-kit confidential-burn-deposit-wiring confidential-reflection-attest-burndeposit; do
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
    forge test --root contracts --offline --no-match-contract ConfidentialPoolInvariant \
      --match-contract 'Confidential|CanonicalAsset'
  block_gate "Forge: stateful invariant fuzzing" POOL "skipped (READINESS_FAST=1)"
else
  run_gate "Forge: state-machine + invariant + fuzz + KAT + real-proof + factory" POOL \
    forge test --root contracts --offline --match-contract 'Confidential|CanonicalAsset'
fi

# ── POOL layer 2: guest verification core (cxfer-core native KATs) ───────────
run_gate "cxfer-core: native crypto + cross-impl + reflection KATs" POOL \
  cargo test --manifest-path "$CXFER" --quiet

# ── POOL layer 2b: in-guest BN254 Groth16 verifier for T_SWAP_BATCH (native, real dev-zkey vector) ──
# Accepts a real bn128 swap_batch proof + rejects a public-input tamper and a G2-limb swap. Validates the
# verifier LOGIC the reflection ELF runs; the baked CEREMONY vk vs a ceremony-zkey proof is a separate box step.
run_gate "swap_batch: in-guest Groth16 verifier accepts real + rejects forgeries" POOL \
  cargo test --manifest-path contracts/sp1/confidential/Cargo.toml --bin reflection-prover swapbatch_verifier --quiet

# ── POOL layer 3: off-chain dapp/prover (node) ───────────────────────────────
run_gate "Node: memo / indexer / transfer / bridge / relay / canonical" POOL node_suite

# ── POOL layer 4: deployment coherence (the live guest must be the proven one) ─
# The settle vkey must agree across all four faces: the pin (program_vkey), the deploy
# DEFAULT_VKEY, and EVERY settle real-proof fixture (confidential/swap/lp/crosslane) — a
# lagging fixture or pin typo otherwise passes green while the deployed guest has no proof.
# The reflection leg checks its own pair (bitcoin_relay_vkey ↔ reflection fixture).
printf '──▶ %-58s [%s]\n' "vkey coherence: pin == deploy == every fixture" "POOL"
jget() { node -e 'try{process.stdout.write(String(require("./"+process.argv[1])[process.argv[2]]||""))}catch(e){}' "$1" "$2" 2>/dev/null; }
PIN_VKEY="$(jget "$PIN" program_vkey)"
DEP_VKEY="$(grep -oE 'DEFAULT_VKEY = 0x[0-9a-fA-F]{64}' "$DEPLOY" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)"
SETTLE_FIXTURES="$GROTH16_FIXTURE contracts/test/fixtures/swap_groth16.json contracts/test/fixtures/lp_groth16.json contracts/test/fixtures/otc_groth16.json contracts/test/fixtures/bid_groth16.json $CROSSLANE_FIXTURE"
printf '    pin program_vkey   : %s\n' "${PIN_VKEY:-<none>}"
printf '    deploy DEFAULT_VKEY : %s\n' "${DEP_VKEY:-<none>}"
coh_ok=1
[ -n "$PIN_VKEY" ] && [ "$PIN_VKEY" = "$DEP_VKEY" ] || coh_ok=0
for fx in $SETTLE_FIXTURES; do
  fxv="$(jget "$fx" vkey)"
  printf '    %-30s : %s\n' "$(basename "$fx")" "${fxv:-<missing>}"
  [ -n "$fxv" ] && [ "$fxv" = "$PIN_VKEY" ] || coh_ok=0
done
# Reflection pair (its own vkey lineage).
RPIN_VKEY="$(jget "$PIN" bitcoin_relay_vkey)"; RFX_VKEY="$(jget "$REFLECT_FIXTURE" vkey)"
printf '    reflection pin/fixture : %s / %s\n' "${RPIN_VKEY:-<none>}" "${RFX_VKEY:-<missing>}"
[ -n "$RFX_VKEY" ] && [ "$RFX_VKEY" != "$RPIN_VKEY" ] && coh_ok=0
if [ "$coh_ok" = 1 ]; then
  printf '    PASS  the deploy-default + pinned guest has on-chain Groth16 proofs (all settle fixtures + reflection)\n'
  pass=$((pass+1)); RESULTS+=("PASS|POOL|vkey coherence")
else
  block_gate "vkey coherence" POOL \
    "pin/deploy/fixture vkey mismatch: a settle face has no matching on-chain proof (box: re-prove, refresh fixtures, repin DEFAULT_VKEY + elf-vkey-pin.json in one commit)"
fi

# ── POOL layer 5: guest ELF pin discipline (no silent drift) ─────────────────
# The real sha256(committed-ELF) == pin check lives in verify-vkey-pin.sh — run it here
# (was a file-exists no-op that let a silently recommitted ELF pass the gate).
if [ -f "$PIN" ]; then
  # STRICT: the readiness gate is a deploy precondition, so any working-tree-vs-HEAD-vs-pin ELF drift
  # is a hard FAIL here (not a warning) — a deploy must never be cut from a dirty/uncommitted ELF.
  run_gate "Guest ELF/vkey pin matches committed ELF" POOL \
    env VERIFY_VKEY_STRICT=1 bash contracts/sp1/confidential/verify-vkey-pin.sh
else
  block_gate "Guest ELF/vkey pin" POOL \
    "no $PIN: confidential guest lacks the tETH ELF-pin discipline (commit canonical ELF + pinned vkey + CI sha check)"
fi

# ── BRIDGE layer 6: cross-lane real proof ──────────────────────────────────
if [ -f "$CROSSLANE_FIXTURE" ]; then
  run_gate "Forge: cross-lane real proof verifies on-chain" BRIDGE \
    forge test --root contracts --offline --match-contract ConfidentialCrossLaneProofReal
else
  block_gate "Bridge cross-lane real proof" BRIDGE \
    "no $CROSSLANE_FIXTURE: box has not produced a cross-lane Groth16 proof yet"
fi

# ── BRIDGE layer 7: the Bitcoin-state relay prover (BITCOIN_RELAY_VKEY) ─────
if [ -f "$REFLECT_FIXTURE" ] && [ -f contracts/test/ConfidentialReflectionProofReal.t.sol ]; then
  run_gate "Reflection prover: real proof verifies on-chain (BITCOIN_RELAY_VKEY)" BRIDGE \
    forge test --root contracts --offline --match-contract ConfidentialReflectionProofReal
else
  block_gate "Reflection prover (BITCOIN_RELAY_VKEY)" BRIDGE \
    "reflection guest unproven on-chain (no $REFLECT_FIXTURE)"
fi

# ── BRIDGE layer 8: Bitcoin-side confidential-pool indexer ──────────────────
# The shipped indexer is the full-scan one (dapp/confidential-reflection-scan-indexer.js); the
# suite exercises it (scan / scan-indexer / attest-scan) plus the witnessed-model oracle tests.
if [ -f dapp/confidential-reflection-scan-indexer.js ]; then
  run_gate "Bitcoin reflection indexer (scan + witnessed oracle)" BRIDGE reflection_suite
else
  block_gate "Bitcoin confidential-pool indexer" BRIDGE \
    "full-scan reflection indexer not built (dapp/confidential-reflection-scan-indexer.js absent)"
fi

# ── BRIDGE layer 8b: reflection fixture freshness (guest == committed newDigest) ─
# Every committed reflection input fixture pins a newDigest — the assembler's expected reflected
# state for that input. Replaying it through the guest must reproduce it; a drift is a stale fixture
# or a guest<->JS divergence, and any re-prove built on it bakes in the wrong digest (this is how the
# redeem fixture's 0xba53-vs-0xc737 drift surfaced). Execute-mode replay is heavy → skipped under FAST.
if [ "${READINESS_FAST:-0}" = "1" ]; then
  block_gate "Reflection fixtures: guest == committed newDigest" BRIDGE "skipped (READINESS_FAST=1)"
else
  run_gate "Reflection fixtures: guest == committed newDigest (freshness)" BRIDGE \
    bash contracts/sp1/confidential/verify-reflection-fixtures.sh
fi

# Generated-from-source: the eth-reflection *_SLOT_INDEX constants must equal the compiled ConfidentialPool
# storage layout (a relayout that shifts a reflected slot, without updating the constant, makes the guest read
# the wrong word). Pins the constants to `forge inspect storageLayout` so a relayout fails loudly here.
run_gate "Reflection storage slots == compiled ConfidentialPool layout" BRIDGE \
  bash contracts/sp1/confidential/verify-reflection-slots.sh

# ── BRIDGE layer 9: reflection guest soundness (FAIL-CLOSED allowlist) ────
# The gate verifies coherence + that a real Groth16 verifies — it CANNOT see an in-guest logic bug
# (the contract sees only hashes), so a coherent, on-chain-verifying reflection vkey is NOT evidence
# of soundness. REFLECT-1 (FUND-CRITICAL): a reflection guest that folds CXFER outputs into
# bitcoinPoolRoot WITHOUT a value-conservation check lets a confirmed Bitcoin tx spending no pool
# UTXO inject a phantom inflated note → drain on the Ethereum cross-lane. The source fix is
# cxfer-core verify_cxfer_conservation (= cxfer_kernel_verify(burned=0) + verify_range), run by
# ScanReflection::fold_cxfer, with reflect.rs checking conservation BEFORE folding; regression
# reflection_cxfer_fold_rejects_nonconserving_outputs (gate layer 2) is the source-side catch, and
# the worker mirror is dapp verifyCxferConservation (tests/confidential-reflection-conservation.mjs).
#
# A DENYLIST is unsafe here: it silently PASSES any new/unknown reflection vkey, including an
# unverified re-prove. So this is an ALLOWLIST — BRIDGE is blocked unless the pinned reflection vkey
# is one POSITIVELY CONFIRMED to enforce conservation. "Confirmed" = an execute- or on-chain-level
# NEGATIVE test showing THIS pinned ELF rejects/skips a non-conserving CXFER (not just that a
# conserving one verifies). Add a vkey below only with that evidence; the empty default fails closed.
#   Known-UNSOUND (never confirm): 0x0050d656 (anchor/F4-open), 0x0099e1c7 (REFLECT-1 unconserved fold).
#
# CONFIRMED 0x00e593b0 (2026-06-10): the negative test (tests/gen-reflection-nonconserve.mjs →
# contracts/sp1/reflect-exec over the PINNED ELF) EXECUTE_OK — the guest SKIPS a non-conserving CXFER
# (Σ C_in = 0 vs a multi-input kernel) instead of reading its output witnesses; the conserving
# control folds + reproduces the on-chain digest 0x240a843d. So this ELF defeats the REFLECT-1
# attack (no-input inflated note). Re-confirm before re-adding after any reflection re-prove.
#
# CONFIRMED 0x00687472 (2026-06-11): after the fee-enforcement / multi-fee-tier re-prove, the shared
# cxfer-core rebuild (OP_SWAP fee enforcement + canonical-pair pool_id) rotated the reflection vkey
# 0x00e593b0 → 0x00687472, but the conservation logic (verify_cxfer_conservation / fold_cxfer / the
# reflect.rs check-before-fold) is BYTE-IDENTICAL (the AMM changes are unused by the reflection path).
# The negative test was RE-RUN against THIS pinned ELF: the conserving control EXECUTE_OK + DIGEST_MATCH
# 0x240a843d (folds), and the non-conserving input (emptied prior live set ⇒ Σ C_in = 0 vs a multi-input
# kernel, outputs stripped) EXECUTE_OK — the guest SKIPS it instead of reading the absent output
# witnesses (a non-enforcing guest would PANIC). So 0x00687472 defeats the REFLECT-1 attack. Prior
# confirmed (now superseded as the pin): 0x00e593b0. (Known-UNSOUND, never confirm: 0x0050d656, 0x0099e1c7.)
#
# CONFIRMED 0x002d2536 (2026-06-13): the Mode-B reflection re-prove (recursive eth-reflection verify +
# CXFER asset-preservation + genesis-pinned). Both-sided negative test RE-RUN against THIS pinned ELF via
# prover-host/bitcoin_prove (PROVE level — the eth recursion proof supplied through SP1Stdin::write_proof):
# the CONSERVING control (gen-reflection-cxfer-synth: 2-in/2-out Σv_in=Σv_out=1000, real BIP-340 kernel +
# BP+ range) FOLDS → poolRoot 0x1658bfbe…, newDigest 0x4d798e9a…, LOCAL_VERIFY_OK (== the on-chain
# reflection_groth16 fixture); the NON-CONSERVING case (gen-reflection-nonconserve: emptied prior live ⇒
# Σ C_in = 0 vs the multi-input kernel) SKIPS → poolRoot 0x7c79406a…, newDigest 0x2c7f6b26…,
# LOCAL_VERIFY_OK with NO panic (a non-enforcing guest would fold the phantom outputs or panic on the
# absent output witnesses). So 0x002d2536 defeats the REFLECT-1 attack AND preserves asset.
# Lineage (superseded pins): 0x00687472, 0x00e593b0. (Known-UNSOUND, never confirm: 0x0050d656, 0x0099e1c7.)
# CONFIRMED 0x004d8dbd (2026-06-13): the coordinated re-prove — the AMM consolidation (da8cd9c) added fns
# to the shared cxfer-core, which compiles into the reflection ELF wholesale, rotating its vkey
# 0x002d2536…→0x004d8dbd… (it touched no reflection logic). The REFLECT-1 both-sided negative test was
# RE-RUN against THIS pinned ELF via prover-host/bitcoin_prove: CONSERVING (gen-reflection-cxfer-synth)
# FOLDS → poolRoot 0x1658bfbe…, newDigest 0x4d798e9a…, LOCAL_VERIFY_OK (== the on-chain reflection_groth16
# fixture); NON-CONSERVING (gen-reflection-nonconserve) SKIPS → poolRoot 0x7c79406a…, newDigest 0x2c7f6b26…,
# LOCAL_VERIFY_OK with NO panic. Identical conservation behavior to 0x002d2536 (only the AMM-bloat changed
# the bytes). Lineage (superseded pins): 0x002d2536, 0x00687472, 0x00e593b0.
# CONFIRMED 0x005e6adc (2026-06-13): the cBTC.zk re-prove — adds the digest-bound cbtcBackingSats (10th PV
# field) + fold_cbtc_lock self-custody to the shared cxfer-core, rotating the reflection vkey
# 0x004d8dbd→0x005e6adc. Both-sided REFLECT-1 negative test RE-RUN on THIS pinned ELF via bitcoin_prove:
# CONSERVING (gen-reflection-cxfer-synth) FOLDS → newDigest 0xcef6d5e5…, LOCAL_VERIFY_OK (== reflection_groth16
# fixture); NON-CONSERVING (gen-reflection-nonconserve) SKIPS → newDigest 0xdd004958…, no panic. cbtcBackingSats
# is digest-bound (cxfer-core ScanReflection.digest folds cbtc_locks.root()+cbtc_backing_sats), so it is not a
# forgeable free witness. Lineage (superseded): 0x004d8dbd, 0x002d2536, 0x00687472, 0x00e593b0.
# CONFIRMED 0x0006921c (2026-06-19): Sepolia/signet pilot reflection re-prove after the BIP141 trailing-byte
# and Mode-B 0x65 skip-witness fixes, with reflection ELF sha f66eb9d8… and both reflection Groth16 fixtures
# LOCAL_VERIFY_OK. REFLECT-1 negative test RE-RUN against THIS committed ELF locally:
# `node tests/gen-reflection-nonconserve.mjs > /tmp/refl_nonconserve_000692.json; REFLECT_ELF=.../elf/reflection-prover
# cargo run --release --manifest-path contracts/sp1/reflect-exec/Cargo.toml --bin reflect-execute -- /tmp/refl_nonconserve_000692.json`
# returned EXECUTE_OK (3,087,539 cycles) with burn-set UNCHANGED, proving the guest skipped the non-conserving
# CXFER instead of reading/folding phantom outputs. Lineage (superseded pin): 0x008c9fa6.
# CONFIRMED 0x0032a552 (2026-06-19): burn-envelope liveness re-prove (multi-live-spend / mismatched-ν
# burns skip-not-panic after nullifying their live spends, reading no burn-deposit witnesses). REFLECT-1
# negative test RE-RUN against THIS committed ELF:
# `node tests/gen-reflection-nonconserve.mjs > /tmp/refl_nonconserve_0032.json; REFLECT_ELF=.../elf/reflection-prover
# cargo run --release --manifest-path contracts/sp1/reflect-exec/Cargo.toml --bin reflect-execute -- /tmp/refl_nonconserve_0032.json`
# returned EXECUTE_OK (3,090,627 cycles) with burn-set UNCHANGED, proving the guest still skips the
# non-conserving CXFER instead of reading/folding phantom outputs. Lineage (superseded pin): 0x0006921c.
# CONFIRMED 0x00fdfe08 (2026-06-21): pre-freeze re-prove — the shared cxfer-core farm/settle additions
# (OP_FARM_HARVEST witnessed reward_asset + farm settle ops + adaptor/unwrap opening-sigmas) recompile
# into the reflection ELF wholesale (sha 36224f90→27863304, 1016856→1068624 bytes), rotating its vkey
# 0x0032a552→0x00fdfe08 although reflect.rs logic is untouched. Both-sided REFLECT-1 test RE-RUN against THIS
# committed ELF via reflect-exec (bin reflect-execute, EXECUTE level): the CONSERVING control
# (gen-reflection-cxfer-synth) FOLDS → EXECUTE_OK 23,221,497 cycles, DIGEST_MATCH ✓ (newDigest 0x752306d9…
# == JS assembler); the NON-CONSERVING case (gen-reflection-nonconserve, Σ C_in = 0 vs the multi-input
# kernel) SKIPS → EXECUTE_OK 4,044,379 cycles, nothing folded, no panic. So 0x00fdfe08 folds valid CXFERs
# yet skips phantom ones — it defeats the REFLECT-1 attack. Lineage (superseded pin): 0x0032a552.
# (Known-UNSOUND, never confirm: 0x0050d656, 0x0099e1c7.)
CONFIRMED_SOUND_REFL_VKEYS="0x003ff6f92c41c5217f98c8e38c42d4ade7e2747c302d60dce6daa263a40716cb 0x00fdfe08721b3ad298529bf632975a2f0ca29440004536d1fa5f43eadd3b0891 0x0032a552d82143745ed675a217822187e15118060dcea1514589ce47c2ec3c02 0x0006921c364ff0c13a006f3117a2c0d40d2df44ca8671a13c86eaa50492395bd 0x008c9fa6e9ee312ba99be8ba5a222ad161912fafebc3cec893e3dfc25f041160 0x007a9feef7f58594cfb2ae5e59610e235b309beb23c4a1dc59d68935a0785648 0x005e6adc6f6d208a7c1652b13626c5e5cdf802fb05418dd64ec5b67f4763d23d 0x004d8dbda0b8590cebe53a74140804389e5a3d2cefe8076c37cf5172e617790d 0x002d2536aa22213fb4e178432a8068e80b041308b4e626c761b74705f71af96c 0x0068747232900af2f75fde3a5fb1143ccac63c56128394e638683cdcd5f307a3"
refl_confirmed=0
for v in $CONFIRMED_SOUND_REFL_VKEYS; do [ "$RPIN_VKEY" = "$v" ] && refl_confirmed=1; done
if [ "$refl_confirmed" = 1 ]; then
  run_gate "Reflection guest soundness (REFLECT-1 conservation confirmed)" BRIDGE \
    test -n "$RPIN_VKEY"
else
  block_gate "Reflection guest soundness (REFLECT-1 + F4)" BRIDGE \
    "pinned reflection vkey ($RPIN_VKEY) is NOT in the confirmed-conservation allowlist — BRIDGE is fail-closed until a negative test proves THIS ELF skips a non-conserving CXFER (REFLECT-1). The source fix + worker mirror exist (verify_cxfer_conservation / fold_cxfer + reflect.rs check-before-fold + tests/confidential-reflection-conservation.mjs); confirm the pinned build enforces them, then allowlist the vkey. See RUNBOOK-confidential-pool-readiness.md."
fi

# ── DAY1 layer A: launch-asset engine coverage (oracle / escrow / slash / CDP / cBTC) ─────────
# The day-1 assets (cBTC / cUSD) the launch depends on: the Chainlink oracle (stale/future/deviation
# fail-closed), the native-ETH escrow + slashing, the cUSD CDP mint/close/liquidate/topup lifecycle, and
# the cross-chain cBTC.zk lock → backing → liquidation seize (real Groth16). CollateralEngine +
# ChainlinkEthBtcAdapter are NOT matched by layer 1's 'Confidential|CanonicalAsset' filter, so gate them here.
run_gate "Forge: launch-asset engine — oracle/escrow/slash/CDP/cBTC lifecycle" DAY1 \
  forge test --root contracts --offline \
    --match-contract 'CollateralEngine|ChainlinkEthBtcAdapter|ConfidentialCbtcLink|ConfidentialCdpCbtc'

# ── DAY1 layer B: airdrop distributor + orchestrated deploy rehearsal + wired day-1 walkthrough ─
run_gate "Forge: airdrop distributor + deploy-suite rehearsal + day-1 integration" DAY1 \
  forge test --root contracts --offline \
    --match-contract 'MerkleDistributor|DeployV1Suite|V1Day1Integration'

# ── DAY1 layer C: airdrop merkle JS builder ↔ Solidity verifier parity ────────
if [ -f tests/airdrop-merkle-evm.test.mjs ]; then
  run_gate "Airdrop merkle: JS builder ↔ Solidity MerkleProofLib parity" DAY1 \
    node tests/airdrop-merkle-evm.test.mjs
else
  block_gate "Airdrop merkle parity" DAY1 "tests/airdrop-merkle-evm.test.mjs absent"
fi

# ── DAY1 layer D: the day-1 deploy artifacts are present (one-command suite + airdrop + config sync) ─
day1_artifacts() {
  local f rc=0
  for f in contracts/src/MerkleDistributor.sol contracts/script/DeployV1Suite.s.sol \
           contracts/script/DeployMerkleDistributor.s.sol contracts/script/DeployCanonicalAssetFactory.s.sol \
           contracts/script/DeployBtcCallExecutor.s.sol contracts/script/DeployCanonicalTac.s.sol \
           contracts/script/DeployTestnetRelay.s.sol contracts/deploy-v1-suite-testnet.sh \
           contracts/deploy-v1-suite-mainnet.sh tools/airdrop/build-merkle.mjs tools/sync-deployment-config.mjs; do
    [ -f "$f" ] || { echo "MISSING $f"; rc=1; }
  done
  return $rc
}
run_gate "Day-1 deploy artifacts present (suite + airdrop + config sync)" DAY1 day1_artifacts

# ── verdicts ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────── SUMMARY ────────────────────────────────────"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r st ti nm <<<"$r"
  printf '  %-8s %-9s %s\n' "$st" "$ti" "$nm"
done
echo
printf '  totals: PASS=%d  FAIL=%d  BLOCKED=%d\n\n' "$pass" "$fail" "$blocked"

pool_open=0; bridge_open=0; day1_open=0
for r in "${RESULTS[@]}"; do
  IFS='|' read -r st ti nm <<<"$r"
  [ "$st" = "PASS" ] && continue
  case "$ti" in
    POOL)   pool_open=$((pool_open+1)); bridge_open=$((bridge_open+1));; # cross-lane needs every pool gate
    BRIDGE) bridge_open=$((bridge_open+1));;
    DAY1)   day1_open=$((day1_open+1));;
  esac
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
# DAY1 = the launch-asset + scripted-deploy surface (builds on POOL): engine oracle/escrow/slash/CDP/cBTC,
# the airdrop distributor, the orchestrated suite rehearsal, and the day-1 deploy artifacts.
if [ "$pool_open" -eq 0 ] && [ "$day1_open" -eq 0 ]; then
  echo "  DAY1 (launch assets + scripted deploy):  READY"
else
  echo "  DAY1 (launch assets + scripted deploy):  NOT READY ($day1_open day1 + $pool_open pool gate(s) open)"
fi
echo "──────────────────────────────────────────────────────────────────────────────"

# Exit nonzero only on a real regression (FAIL); BLOCKED is expected-pending.
[ "$fail" -eq 0 ]
