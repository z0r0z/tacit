#!/bin/bash
set -euo pipefail
# FREEZE GUARD (#4): the eth-reflection guest hardcodes ConfidentialPool storage-slot indices
# (cxfer-core/src/eth_reflection.rs) to read crossOutCommitment / bitcoinConsumed[Count|At] /
# crossOutCount / crossOutAt via eth_getProof. If the Solidity storage layout ever shifts one of these,
# the (immutable) guest silently proves the WRONG slot -> Mode-B breaks / a proof is unverifiable. This
# asserts every guest slot constant equals the slot the Solidity layout actually assigns. Run before any
# freeze/deploy and in CI. Exit non-zero on any drift.
cd "$(dirname "$0")/../.."  # -> contracts/
GUEST="sp1/confidential/cxfer-core/src/eth_reflection.rs"
POOL="src/ConfidentialPool.sol:ConfidentialPool"

gconst() { grep -oE "$1: u64 = [0-9]+" "$GUEST" | grep -oE '= [0-9]+' | grep -oE '[0-9]+' | head -1; }

# guest constant -> Solidity storage label
declare -a PAIRS=(
  "CROSSOUT_SLOT_INDEX:crossOutCommitment"
  "CONSUMED_SLOT_INDEX:bitcoinConsumed"
  "CONSUMED_COUNT_SLOT_INDEX:bitcoinConsumedCount"
  "CONSUMED_AT_SLOT_INDEX:bitcoinConsumedAt"
  "CROSSOUT_COUNT_SLOT_INDEX:crossOutCount"
  "CROSSOUT_AT_SLOT_INDEX:crossOutAt"
)

LAYOUT=$(forge inspect "$POOL" storage-layout --json 2>/dev/null)
[ -n "$LAYOUT" ] || { echo "FAIL: could not read Solidity storage-layout (forge inspect)"; exit 1; }

fail=0
for p in "${PAIRS[@]}"; do
  gk="${p%%:*}"; label="${p##*:}"
  gv=$(gconst "$gk")
  sv=$(echo "$LAYOUT" | python3 -c "import sys,json;print(next((s['slot'] for s in json.load(sys.stdin).get('storage',[]) if s['label']=='$label'),''))")
  if [ -z "$gv" ]; then echo "FAIL: guest constant $gk not found in $GUEST"; fail=1; continue; fi
  if [ -z "$sv" ]; then echo "FAIL: Solidity label $label not found in storage layout"; fail=1; continue; fi
  if [ "$gv" != "$sv" ]; then
    echo "FAIL: SLOT DRIFT $gk (guest=$gv) != $label (solidity=$sv) — the immutable guest reads the wrong slot; realign before freeze"
    fail=1
  else
    echo "PASS: $gk = $label @ slot $gv"
  fi
done
[ "$fail" = 0 ] && echo "PASS: all eth-reflection guest slot constants match the ConfidentialPool storage layout" || exit 1
