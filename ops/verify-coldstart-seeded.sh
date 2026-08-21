#!/usr/bin/env bash
# Cold-start ordering gate: a pool must have seeded its fast-lane consume counter BEFORE it is opened
# to users, and certainly before any crossOut exists.
#
# WHY. crossOut bumps crossOutCount unconditionally, and a forward reflection batch commits
# crossOutCount=0, so once crossOutCount >= 1 every forward attest reverts ConsumedCountStale and only a
# Mode-B batch can advance. Mode-B's eth_prove inclusion-reads bitcoinConsumedCount, and there is no
# exclusion path for an unwritten slot — so if that counter is still 0 when the first crossOut lands,
# reflection FREEZES: forward bridging past that height, reverse bridging and every reflection-dependent
# op stop, and nothing recovers until some holder of a note in the current reflected Bitcoin root does a
# fast-lane spend. An attacker needs only a note in the pool to trigger it. Liveness only — no theft, no
# inflation — but unrecoverable without such a note, which a fresh pool may not have in friendly hands.
#
# The counter is MONOTONE, so once it is >= 1 the freeze is impossible on that pool forever. Seeding it
# takes one btcHomed fast-lane spend: a note live in the reflected Bitcoin root, spent on Ethereum. A
# bridge-MINTED note is EVM-homed and CANNOT seed it.
#
# This has been a runbook instruction. It is a gate now because the ordering is load-bearing and the
# failure is permanent-ish: a pool opened in the wrong order can be frozen by any user who holds a note.
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
  echo "FAIL: ALREADY FROZEN. crossOutCount=$crossout with bitcoinConsumedCount=0."
  echo "  Forward attests revert ConsumedCountStale and Mode-B cannot inclusion-prove an unwritten slot."
  echo "  Recovery needs a fast-lane spend of a note live in the current reflected Bitcoin root."
  exit 1
fi

echo "FAIL: NOT SEEDED and NOT YET FROZEN — do not open this pool to users."
echo "  Seed slot $CONSUMED_COUNT_SLOT first with ONE btcHomed fast-lane spend (a note live in the reflected"
echo "  Bitcoin root, spent on Ethereum; a bridge-minted note is EVM-homed and will NOT work). Re-run this"
echo "  gate until it PASSes, and only then allow crossOut / public access."
exit 1
