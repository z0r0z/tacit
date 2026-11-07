#!/bin/bash
# usage: prove-and-fetch.sh INSTANCE_ID N : waits for the box, proves, copies N proofs back, destroys the box only after ALL_FETCHED
ID=$1; N=$2
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE"
for i in $(seq 1 60); do
  R=$(vastai show instance $ID --raw 2>/dev/null | python3 -c "
import json,sys
i=json.load(sys.stdin)
p=(i.get('ports') or {}).get('22/tcp') or [{}]
print(i.get('actual_status'), i.get('public_ipaddr'), p[0].get('HostPort'))" 2>/dev/null)
  set -- $R
  if [ "$1" = running ] && [ -n "$3" ] && [ "$3" != None ]; then
    if ssh -i $HOME/.ssh/vast_prover -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR -p "$3" root@"$2" true 2>/dev/null; then
      echo "READY $2 $3"
      sh "$S/block-proof-run.sh" "$3" "$2"
      SSH="ssh -i $HOME/.ssh/vast_prover -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -o BatchMode=yes -o LogLevel=ERROR -p $3 root@$2"
      for j in $(seq 1 75); do
        sleep 60
        out=$($SSH "tail -c 300 /root/prove.log 2>/dev/null; tail -c 200 /root/build.log 2>/dev/null" 2>/dev/null)
        if echo "$out" | grep -q PROVE_DONE; then
          $SSH "grep -c '^{' /root/prove.log; grep PROVE_FAILED /root/prove.log"
          if bash "$S/block-proof-fetch.sh" "$3" "$2" $N; then vastai destroy instance $ID -y; else echo "FETCH_INCOMPLETE: box $ID left running"; fi
          exit 0
        fi
        if echo "$out" | grep -q -E "error: could not compile|error\[E"; then echo "BUILD_FAILED: box $ID left running"; exit 1; fi
      done
      echo "STILL_RUNNING: box $ID left running"; exit 1
    fi
  fi
  sleep 15
done
echo "TIMEOUT: box $ID left running"
