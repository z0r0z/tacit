#!/bin/bash
# usage: block-proof-fetch.sh PORT HOST N : copies FILE.b0..b(N-1).stdin.groth16 back, checks each has two 0x lines; exits 1 if any is missing
set -u
P=$1; H=$2; N=$3
D="$(cd "$(dirname "$0")/../../../../test/fixtures" && pwd)"
ok=1
for ((i=0; i<N; i++)); do
  f=tacit-blocks-mainnet.json.b$i.stdin.groth16
  ssh -i ~/.ssh/vast_prover -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -o BatchMode=yes -o LogLevel=ERROR -p "$P" root@"$H" "cat /root/tb/$f" > "$D/$f.part"
  if [ "$(grep -c '^0x' "$D/$f.part")" = 2 ]; then mv "$D/$f.part" "$D/$f"; echo "ok $f"; else echo "MISSING $f"; rm -f "$D/$f.part"; ok=0; fi
done
[ $ok = 1 ] && echo ALL_FETCHED || exit 1
