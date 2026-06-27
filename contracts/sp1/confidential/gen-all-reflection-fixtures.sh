#!/usr/bin/env bash
# Regenerate all generator-backed reflection-scan fixtures (the guest↔JS DIGEST_MATCH set gated by
# verify-reflection-fixtures.sh). Each generator emits a full reflection input with the JS assembler's
# newDigest embedded; the guest must reproduce it. Re-run after any reflection guest/assembler change,
# then run verify-reflection-fixtures.sh to confirm parity. (bash 3.2 compatible — no assoc arrays.)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
FXD=contracts/sp1/confidential/fixtures

# "<generator-suffix>:<fixture-basename>" pairs.
PAIRS="
cbtc:reflection_cbtc_lock
cbtc-spend:reflection_cbtc_spend
crossout:reflection_crossout
farminit:reflection_farminit
harvest:reflection_harvest
lpbond:reflection_lpbond
farmrefund:reflection_farmrefund
bid:reflection_bid
lp-poolinit:reflection_lp_poolinit
lp-add:reflection_lp_add
lpremove:reflection_lpremove
protofee:reflection_protofee
swaproute:reflection_swaproute
swapvar:reflection_swapvar
poolresume:reflection_poolresume
modeb:reflection_modeb
"

rc=0
for pair in $PAIRS; do
  g="${pair%%:*}"; fx="${pair##*:}"
  out="$FXD/$fx.json"
  if node "tests/gen-reflection-$g-synth.mjs" > "$out.tmp" 2>/dev/null && [ -s "$out.tmp" ]; then
    mv "$out.tmp" "$out"
    echo "OK   $fx  ($(node -e "process.stdout.write(require('./$out').newDigest||'?')" 2>/dev/null))"
  else
    rm -f "$out.tmp"; echo "FAIL $g"; rc=1
  fi
done
# swap_batch needs the production ceremony HEAD zkey (not in-repo: fetch CID
# bafybeieb5hafaix2xwvnmsodby4vkvcpdv4bpt4ny3etza4lpy2rxefwqm from an IPFS gateway, sha256 6ed30983…).
# Skips cleanly if absent (the committed fixture stays). snarkjs hangs on exit AFTER writing stdout, so
# poll for a valid fixture then kill.
ZK="${REFLECT_SWAPBATCH_ZKEY:-/tmp/head-swapbatch.zkey}"
if [ -f "$ZK" ]; then
  node -e 'const s=require("snarkjs"),fs=require("fs");s.zKey.exportVerificationKey(process.argv[1]).then(vk=>{fs.writeFileSync("/tmp/swapbatch-inline-vk.json",JSON.stringify(vk));process.exit(0)})' "$ZK" >/dev/null 2>&1
  REFLECT_SWAPBATCH_ZKEY="$ZK" node tests/gen-reflection-swapbatch-synth.mjs > "$FXD/reflection_swapbatch.json.tmp" 2>/dev/null &
  gp=$!
  for i in $(seq 1 60); do sleep 5; node -e 'process.exit(require(process.argv[1]).newDigest?0:1)' "$FXD/reflection_swapbatch.json.tmp" 2>/dev/null && break; done
  kill -9 $gp 2>/dev/null
  if node -e 'process.exit(require(process.argv[1]).newDigest?0:1)' "$FXD/reflection_swapbatch.json.tmp" 2>/dev/null; then
    mv "$FXD/reflection_swapbatch.json.tmp" "$FXD/reflection_swapbatch.json"; echo "OK   reflection_swapbatch  ($(node -e "process.stdout.write(require('./$FXD/reflection_swapbatch.json').newDigest)"))"
  else rm -f "$FXD/reflection_swapbatch.json.tmp"; echo "FAIL swap_batch (gen)"; rc=1; fi
else
  echo "SKIP reflection_swapbatch (no head zkey at $ZK — committed fixture kept)"
fi
echo "=== GEN-ALL DONE ==="
exit $rc
