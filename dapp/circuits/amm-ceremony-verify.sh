#!/usr/bin/env bash
# Verify all three AMM ceremony chains are initialized + accepting
# contributions. Public read; no token required.

set -euo pipefail

CIRCUITS_DIR="/Users/z/tacit/dapp/circuits"
WORKER="${WORKER:-https://tacit-pin.rosscampbell9.workers.dev}"

for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    R1CS="${CIRCUITS_DIR}/amm/build/${c}.r1cs"
    CHASH="$(shasum -a 256 "$R1CS" | cut -d' ' -f1)"
    printf "%-18s " "$c"
    BODY="$(curl -sf "${WORKER}/ceremony/${CHASH}" || true)"
    if [ -z "$BODY" ]; then
        echo "  NOT FOUND (chain not initialized)"
        continue
    fi
    echo "$BODY" | python3 -c "
import sys, json
j = json.load(sys.stdin)
s = j.get('state') or {}
print('count=' + str(s.get('contribution_count','?')) +
      '  finalized=' + str(s.get('finalized', False)) +
      '  head=' + (s.get('head_cid','')[:16] + ('…' if s.get('head_cid') else '')))
"
done
