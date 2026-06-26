#!/usr/bin/env bash
# CI guard for the reflection storage-slot interface.
#
# The eth-reflection guest reads four ConfidentialPool storage slots by HARDCODED index
# (cxfer-core/src/eth_reflection.rs: CROSSOUT / CONSUMED / CONSUMED_COUNT / CONSUMED_AT)
# via eth_getProof Merkle-Patricia proofs. Storage layout is therefore a protocol interface: a storage
# edit that shifts any of these slots silently breaks (or mis-proves) reflection. New state MUST be
# appended at the end of the contract's storage. This asserts the compiled contract layout still matches
# the guest constants — run on any ConfidentialPool change.
set -euo pipefail
cd "$(dirname "$0")/.."
GUEST=contracts/sp1/confidential/cxfer-core/src/eth_reflection.rs

num() { grep -oE "$1: u64 = [0-9]+" "$GUEST" | grep -oE '[0-9]+$' | head -1; }
g_crossout=$(num CROSSOUT_SLOT_INDEX)
g_consumed=$(num CONSUMED_SLOT_INDEX)
g_count=$(num CONSUMED_COUNT_SLOT_INDEX)
g_at=$(num CONSUMED_AT_SLOT_INDEX)
[ -n "$g_crossout$g_consumed$g_count$g_at" ] || { echo "could not read guest slot constants from $GUEST"; exit 1; }

LAYOUT=$(cd contracts && FOUNDRY_PROFILE=default forge inspect ConfidentialPool storage-layout)
# Each layout row is: | label | type | slot | offset | bytes | contract |  — exact-match the trimmed label
# (so bitcoinConsumed does not match bitcoinConsumedCount) and read the slot column.
slot_of() { echo "$LAYOUT" | awk -F'|' -v n="$1" '{l=$2;s=$4;gsub(/ /,"",l);gsub(/ /,"",s); if(l==n) print s}'; }
c_crossout=$(slot_of crossOutCommitment)
c_consumed=$(slot_of bitcoinConsumed)
c_count=$(slot_of bitcoinConsumedCount)
c_at=$(slot_of bitcoinConsumedAt)

fail=0
chk() { if [ "$2" != "$3" ]; then echo "  DRIFT $1: guest=$2 contract=$3"; fail=1; else echo "  ok   $1: slot $2"; fi; }
echo "reflection storage-slot coherence (guest cxfer-core == compiled ConfidentialPool):"
chk crossOutCommitment    "$g_crossout" "$c_crossout"
chk bitcoinConsumed       "$g_consumed" "$c_consumed"
chk bitcoinConsumedCount  "$g_count"    "$c_count"
chk bitcoinConsumedAt     "$g_at"       "$c_at"
if [ "$fail" != 0 ]; then
  echo "FAIL: a storage edit shifted a guest-read slot — append new state at the END of storage, or update the guest constants + re-prove the reflection vkey."
  exit 1
fi
echo "PASS: reflection-read slots coherent."
