#!/usr/bin/env bash
# Cold-start ordering gate — SUPERSEDED BY THE GUEST FIX (see STATUS below); kept as a reporting tool.
#
# STATUS 2026-09-07: a FAIL here is no longer a launch blocker on any pool whose pinned eth-reflection
# guest contains `verify_storage_slot_proofs_allow_zero` (contracts/sp1/eth-reflection/src/main.rs,
# landed 2026-07-13). That function verifies a zero-valued counter slot with an EXCLUSION proof — a
# never-written slot is genuinely absent from the storage trie, and a monotone ++-only counter can never
# be legitimately absent once non-zero, so proven-absent == a true 0. Mode-B therefore BOOTSTRAPS at
# bitcoinConsumedCount/crossOutCount == 0 instead of freezing. Confirm the pool's pinned
# bitcoin_relay_vkey matches contracts/sp1/confidential/elf-vkey-pin.json before relying on this.
#
# WHY THE GATE EXISTED (pre-fix history). crossOut bumps crossOutCount unconditionally, and a forward
# reflection batch commits crossOutCount=0, so once crossOutCount >= 1 every forward attest reverts
# ConsumedCountStale and only a Mode-B batch can advance. Mode-B's eth_prove USED TO inclusion-read
# bitcoinConsumedCount with no exclusion path for an unwritten slot — so a first crossOut at counter 0
# froze reflection until some holder of a note in the reflected Bitcoin root did a fast-lane spend.
# That is the failure this script was written to prevent, and it is what the guest fix removed.
#
# Seeding is still the belt-and-braces path (the counter is MONOTONE, so once >= 1 the pre-fix freeze is
# impossible forever): one btcHomed fast-lane spend — a note live in the reflected Bitcoin root, spent on
# Ethereum. A bridge-MINTED note is EVM-homed and CANNOT seed it.
#
# DO NOT re-escalate a FAIL here to "redeploy the pool" without first checking the deployed guest: doing
# so on 2026-09-07 produced a false alarm that nearly triggered an unnecessary mainnet redeploy.
#
# Usage: RPC=<rpc> POOL=<addr> bash ops/verify-coldstart-seeded.sh
set -uo pipefail

RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
POOL="${POOL:-}"
[ -n "$POOL" ] || { echo "FAIL: set POOL=<ConfidentialPool address>"; exit 1; }
command -v cast >/dev/null 2>&1 || { echo "FAIL: cast (foundry) not on PATH"; exit 1; }

# Resolve the slots from the COMPILED layout rather than hardcoding them. The layout has shifted between
# generations — the pool live at 0x...c5B537 keeps bitcoinConsumedCount at slot 120, while current source
# puts it at 121 (120 is the bitcoinConsumed MAPPING there) — so a hardcoded number silently reads the
# wrong word and reports a seeded pool as unseeded, or worse. Same source of truth as
# contracts/sp1/confidential/verify-storage-slots.sh. Override with CONSUMED_COUNT_SLOT / CROSSOUT_COUNT_SLOT
# when checking a pool whose deployed bytecode predates the current layout.
resolve_slot() { # label -> slot index from `forge inspect`
  local label="$1"
  ( cd "$(dirname "$0")/../contracts" && forge inspect ConfidentialPool storage --json 2>/dev/null ) \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const f=l.storage.find(x=>x.label===process.argv[1]);process.stdout.write(f?String(f.slot):"")}catch{process.stdout.write("")}})' "$label"
}
CONSUMED_COUNT_SLOT="${CONSUMED_COUNT_SLOT:-$(resolve_slot bitcoinConsumedCount)}"
CROSSOUT_COUNT_SLOT="${CROSSOUT_COUNT_SLOT:-$(resolve_slot crossOutCount)}"
if [ -z "$CONSUMED_COUNT_SLOT" ] || [ -z "$CROSSOUT_COUNT_SLOT" ]; then
  echo "FAIL: could not resolve storage slots from the compiled layout."
  echo "  Build contracts first, or pass CONSUMED_COUNT_SLOT=<n> CROSSOUT_COUNT_SLOT=<n> explicitly"
  echo "  (older deployed generations keep bitcoinConsumedCount at 120)."
  exit 1
fi

hexdec() { printf '%d' "$1" 2>/dev/null || echo 0; }

raw_consumed=$(cast storage "$POOL" "$CONSUMED_COUNT_SLOT" --rpc-url "$RPC" 2>/dev/null || true)
raw_crossout=$(cast storage "$POOL" "$CROSSOUT_COUNT_SLOT" --rpc-url "$RPC" 2>/dev/null || true)
[ -n "$raw_consumed" ] && [ -n "$raw_crossout" ] || { echo "FAIL: could not read pool storage (rpc/address?)"; exit 1; }

consumed=$(hexdec "$raw_consumed")
crossout=$(hexdec "$raw_crossout")

echo "# cold-start gate  pool=$POOL"
echo "  bitcoinConsumedCount (slot $CONSUMED_COUNT_SLOT) = $consumed"
echo "  crossOutCount        (slot $CROSSOUT_COUNT_SLOT) = $crossout"

if [ "$consumed" -ge 1 ]; then
  echo "PASS: fast-lane consume counter is seeded ($consumed) and monotone — cold-start freeze is impossible on this pool."
  exit 0
fi

if [ "$crossout" -ge 1 ]; then
  echo "UNSEEDED: crossOutCount=$crossout with bitcoinConsumedCount=0."
  echo "  On a PRE-FIX guest this is the frozen state (forward attests revert ConsumedCountStale and Mode-B"
  echo "  cannot inclusion-prove an unwritten slot); recovery would need a fast-lane spend of a note live in"
  echo "  the current reflected Bitcoin root."
  echo "  On a guest carrying verify_storage_slot_proofs_allow_zero (>= 2026-07-13) this is NOT frozen —"
  echo "  Mode-B bootstraps via the exclusion proof. CHECK THE DEPLOYED GUEST before acting:"
  echo "    contracts/sp1/confidential/elf-vkey-pin.json  ->  bitcoin_relay_vkey"
  exit 1
fi

echo "UNSEEDED (no crossOut yet). Not a blocker on a fixed guest; see the STATUS note at the top of this file."
echo "  Optional belt-and-braces: seed slot $CONSUMED_COUNT_SLOT with ONE btcHomed fast-lane spend (a note live"
echo "  in the reflected Bitcoin root, spent on Ethereum; a bridge-minted note is EVM-homed and will NOT work)."
echo "  Verify the pool's pinned bitcoin_relay_vkey matches elf-vkey-pin.json to confirm the guest fix is live."
exit 1
