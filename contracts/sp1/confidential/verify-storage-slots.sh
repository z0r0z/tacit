#!/usr/bin/env bash
# Fail closed if the eth-reflection guest's hardcoded ConfidentialPool storage-slot constants drift from the
# compiler-emitted storage layout. The guest proves these exact slots via eth_getProof, so a layout shift
# (a new state var declared before a proven field) silently makes it prove the WRONG slots — bricking Mode-B
# reflection and enabling a cross-lane double-spend. Run this in the reprove/deploy gate; a diff is a NO-GO.
#
# Usage: bash contracts/sp1/confidential/verify-storage-slots.sh   (from repo root or contracts/)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$(cd "$HERE/../.." && pwd)"
GUEST="$HERE/cxfer-core/src/eth_reflection.rs"
READER="$CONTRACTS/test/PoolStateReader.sol"

cd "$CONTRACTS"
LAYOUT="$(forge inspect ConfidentialPool storageLayout --json 2>/dev/null)"

# field:const-name pairs — the Rust const in eth_reflection.rs that must equal that field's compiler slot.
fail=0
for pair in \
  "crossOutCommitment:CROSSOUT_SLOT_INDEX" \
  "bitcoinConsumed:CONSUMED_SLOT_INDEX" \
  "bitcoinConsumedCount:CONSUMED_COUNT_SLOT_INDEX" \
  "bitcoinConsumedAt:CONSUMED_AT_SLOT_INDEX" \
  "crossOutCount:CROSSOUT_COUNT_SLOT_INDEX" \
  "crossOutAt:CROSSOUT_AT_SLOT_INDEX"; do
  field="${pair%%:*}"
  cname="${pair##*:}"
  want="$(printf '%s' "$LAYOUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const f=l.storage.find(x=>x.label==process.argv[1]);process.stdout.write(f?String(f.slot):"MISSING")})' "$field")"
  have="$(grep -oE "${cname}: u64 = [0-9]+" "$GUEST" | grep -oE '[0-9]+$' || echo MISSING)"
  if [ "$want" != "$have" ]; then
    echo "DRIFT: ${field} is at slot ${want} but guest ${cname} = ${have}"
    fail=1
  else
    echo "ok: ${field} slot ${want} == ${cname}"
  fi
done

# The test-only direct-slot reader mirrors the same fields; keep it honest too (its slot list is a superset).
for pair in "escrow:73" "nullifierSpent:70" "bridgeMinted:76" "bitcoinConsumed:120" "bitcoinConsumedCount:121" "crossOutCount:171"; do
  field="${pair%%:*}"
  want="$(printf '%s' "$LAYOUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const f=l.storage.find(x=>x.label==process.argv[1]);process.stdout.write(f?String(f.slot):"MISSING")})' "$field")"
  if ! grep -qE "uint256\\(${want}\\)" "$READER"; then
    echo "DRIFT: PoolStateReader has no uint256(${want}) for ${field} (current slot ${want})"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "STORAGE-SLOT DRIFT DETECTED — the eth-reflection guest would prove the wrong slots. Rebuild + re-prove after fixing. NO-GO."
  exit 1
fi
echo "storage-slot pins OK"
