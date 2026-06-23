#!/bin/bash
set -euo pipefail

# Generated-from-source guard: the eth-reflection guest proves four ConfidentialPool storage slots via
# eth_getProof against the finalized exec stateRoot (crossOutCommitment / bitcoinConsumed /
# bitcoinConsumedCount / bitcoinConsumedAt). Their *_SLOT_INDEX constants in cxfer-core are correct ONLY if
# they equal the live compiled layout — a pool relayout that shifts a slot, without updating the constant,
# would make the guest read the WRONG storage word (a reflected-state divergence). This pins the constants to
# `forge inspect ... storageLayout` (generated from source) so a relayout fails loudly.
#
# NOTE: `forge inspect storageLayout` requires solc to emit the storage layout, which the current via_ir build
# does not (the artifact carries no `storageLayout`). When that's the case this check SKIPS (exit 0) rather
# than failing — the active drift guards meanwhile are the in-crate Rust KAT (eth_reflection.rs:297-326) and
# the live literal-slot settle write in ConfidentialPool.t.sol. The check auto-activates (and will FAIL on a
# real drift) the moment a solc/forge that emits the via_ir layout is used.
export LC_ALL=C
export LANG=C

cd "$(dirname "$0")/../.."          # -> contracts/ (foundry root)
ETHR="sp1/confidential/cxfer-core/src/eth_reflection.rs"
PAIRS="CROSSOUT_SLOT_INDEX:crossOutCommitment CONSUMED_SLOT_INDEX:bitcoinConsumed CONSUMED_COUNT_SLOT_INDEX:bitcoinConsumedCount CONSUMED_AT_SLOT_INDEX:bitcoinConsumedAt"

layout() { forge inspect ConfidentialPool storageLayout --json 2>/dev/null; }
parseable() { printf '%s' "$1" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; }

# Single, NON-destructive attempt: with `extra_output = ["storageLayout"]` in foundry.toml a normal build
# populates the artifact, so inspect succeeds on the first try once solc emits the via_ir layout. We never
# `forge clean` here (it would wipe the artifacts the rest of the readiness gate depends on).
JSON="$(layout || true)"
if ! parseable "$JSON"; then
  echo "  SKIPPED: forge did not emit ConfidentialPool storageLayout (via_ir/solc limitation)."
  echo "  Active drift guards: eth_reflection.rs KAT + the ConfidentialPool.t.sol literal-slot settle write."
  exit 0
fi

CONSTS="$(grep -oE 'pub const [A-Z_]+_SLOT_INDEX: u64 = [0-9]+' "$ETHR" | sed -E 's/pub const ([A-Z_]+): u64 = ([0-9]+)/\1=\2/')"

printf '%s' "$JSON" | CONSTS="$CONSTS" PAIRS="$PAIRS" ETHR="$ETHR" python3 -c '
import json, os, sys
layout = json.load(sys.stdin)
consts = dict(kv.split("=") for kv in os.environ["CONSTS"].split())
slots = {s["label"]: int(s["slot"]) for s in layout.get("storage", [])}
rc = 0
for pair in os.environ["PAIRS"].split():
    cname, label = pair.split(":")
    want = int(consts.get(cname, -1)); got = slots.get(label)
    if want < 0: print(f"  FAIL: constant {cname} not found in {os.environ[\"ETHR\"]}"); rc = 1; continue
    if got is None: print(f"  FAIL: storage label {label} not in ConfidentialPool layout"); rc = 1; continue
    if got != want: print(f"  FAIL: {cname}={want} but ConfidentialPool.{label} is at slot {got} — relayout drift; update the constant"); rc = 1; continue
    print(f"  OK   {cname}={want} == ConfidentialPool.{label}")
sys.exit(rc)
'
echo "reflection storage-slot constants match the compiled ConfidentialPool layout"
