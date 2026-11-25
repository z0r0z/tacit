#!/bin/sh
# A full rehearsal of the ceremony with the real tool on a toy circuit, in a few minutes on one machine: a coordinator,
# honest contributors queued at once, hostile ones (a join from a web page, a place held by polling, junk uploads, a
# download flood), a coordinator crash and restart mid-queue, then close, a real beacon (a Bitcoin block hash and a
# BLS-checked drand quicknet round), seal, and a proof with the sealed keys.
#
#   sh rehearsal/rehearse.sh [work-dir]
# Needs Go, curl and python3; fetches the latest Bitcoin block hash (mempool.space) and a quicknet round (api.drand.sh).
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=${1:-$(mktemp -d)}
mkdir -p "$W"
cd "$W"
PORT=${PORT:-18080}
ADMIN=127.0.0.1:$((PORT + 1))
API=http://127.0.0.1:$PORT
LOG=$W/rehearsal.log
: > "$LOG"
say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }
fail() { say "FAIL: $*"; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
head_index() { curl -s "$API/api/head" | python3 -c "import json,sys
try: print(json.load(sys.stdin)['index'])
except Exception: print(0)"; }

(cd "$HERE" && go build -o "$W/tacit-ceremony" ./cmd/tacit-ceremony && go build -o "$W/fixture" ./rehearsal/fixture)
./fixture make fix > /dev/null
./tacit-ceremony init chain fix/phase2-17 17 "Tacit Praxis ceremony (rehearsal)" > init.out
KEY=$(sed -n 's/.*coordinator key \([0-9a-f]*\).*/\1/p' init.out)
say "chain started; coordinator key $KEY"

SERVE_ARGS="--admin $ADMIN --per-ip -1 --heartbeat 10s --claim-window 20s --download-start 20s --download-by 60s --upload-start 90s --slot-cap 4m --files-per-ip 2"
start_serve() { ./tacit-ceremony serve $SERVE_ARGS chain 127.0.0.1:$PORT >> serve.log 2>&1 & SERVE=$!; sleep 1; }
start_serve
trap 'kill $SERVE 2>/dev/null || true; kill $(jobs -p) 2>/dev/null || true' EXIT

# hostile 1: a join a web page could send (text/plain, no preflight)
[ "$(code -X POST -H 'Content-Type: text/plain' -d '{"name":"web page"}' $API/api/join)" = 415 ] && say "ok: a text/plain join is refused" || fail "text/plain join accepted"

# hostile 2: claims the slot and only polls
SQ=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"squatter"}' $API/api/join | json "['token']")
curl -s -X POST -H "X-Ceremony-Token: $SQ" $API/api/claim > /dev/null
( while [ "$(code -H "X-Ceremony-Token: $SQ" $API/api/slot)" != 404 ]; do sleep 2; done ) &

# hostile 3: uploads junk of the right size (the head itself) until refused; it keeps polling through a coordinator restart
J=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"junk"}' $API/api/join | json "['token']")
(
  state() { curl -s -H "X-Ceremony-Token: $J" $API/api/slot | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('state','gone'))
except Exception: print('down')"; }
  while :; do
    st=$(state)
    [ "$st" = gone ] && { echo "junk: place lost before its turn" > junk.out; exit 0; }
    [ "$st" = claim ] && break
    sleep 2
  done
  curl -s -X POST -H "X-Ceremony-Token: $J" $API/api/claim > slot.json
  H=$(json "['index']" < slot.json)
  curl -s -o head.bin -H "X-Ceremony-Token: $J" "$API/f/phase2-$H"
  for i in 1 2 3; do echo "upload $i: $(code -X PUT -H "X-Ceremony-Token: $J" --data-binary @head.bin $API/api/upload)" >> junk.out; done
  echo "slot after: $(code -H "X-Ceremony-Token: $J" $API/api/slot)" >> junk.out
) &

# honest contributors, queued at once
for n in alice bob carol; do
  ./tacit-ceremony contribute --coordinator $API --coordinator-key "$KEY" --name "$n" --receipt-dir "$W" > "contrib-$n.log" 2>&1 &
  eval "PID_$n=\$!"
  sleep 1
done

# hostile 4: slow downloads with no token hold the per-address limit; one more is refused (a large stand-in file, as
# the toy circuit's files fit in a socket buffer)
head -c 67108864 /dev/zero > chain/phase2-99
for i in 1 2; do curl -s -o /dev/null --limit-rate 100k --max-time 6 "$API/f/phase2-99" & done
sleep 1
[ "$(code "$API/f/phase2-17")" = 429 ] && say "ok: a download beyond the per-address limit is refused (429)" || fail "no download limit"

# crash and restart the coordinator once the first contribution is in
until [ "$(head_index)" -ge 18 ]; do sleep 1; done
kill -9 $SERVE
say "coordinator killed (SIGKILL) with the head at phase2-18"
sleep 2
start_serve
say "coordinator restarted: head phase2-$(head_index)"

for n in alice bob carol; do
  eval "p=\$PID_$n"
  wait "$p" || fail "$n's contribution did not finish ($(tail -3 contrib-$n.log | tr '\n' ' '))"
  grep -q "Your contribution is in" "contrib-$n.log" && say "ok: $n contributed $(grep -o 'as phase2-[0-9]*' contrib-$n.log | head -1), receipt checked against the pinned key"
done
grep -q "(squatter) left: the head's download did not start" serve.log && say "ok: the squatter lost its slot: $(grep -o '(squatter) left: .*' serve.log)" || fail "the squatter kept its place"
if grep -q "slot after: 404" junk.out 2>/dev/null && grep -q "(junk) left: 2 uploads refused" serve.log; then
  say "ok: junk uploads: $(tr '\n' ' ' < junk.out); $(grep -o '(junk) left: .*' serve.log)"
else
  cat junk.out 2>/dev/null; fail "the junk uploader kept the slot"
fi

HEAD=$(head_index)
./tacit-ceremony verify-chain chain 17 "$HEAD" >> verify.log 2>&1 && say "ok: phase2-17..phase2-$HEAD verify link by link" || fail "the chain does not verify"

# close
curl -s -X POST http://$ADMIN/admin/close > /dev/null
[ "$(code -X POST -H 'Content-Type: application/json' -d '{"name":"late"}' $API/api/join)" = 403 ] && say "ok: closed: joins are refused" || fail "join after close"

# beacon: the latest Bitcoin block and a just-published quicknet round
BLOCK=$(curl -s -m 20 https://mempool.space/api/blocks/tip/hash)
ROUND=$(( ($(date +%s) - 1692803367) / 3 - 2 ))
BEACON=$(./tacit-ceremony beacon "$BLOCK" "$ROUND" | tee -a beacon.out | sed -n 's/^beacon  *//p')
[ -n "$BEACON" ] || fail "beacon ($(cat beacon.out))"
say "beacon from Bitcoin block $BLOCK and quicknet round $ROUND (BLS-checked): $BEACON"

# seal and use the keys
./tacit-ceremony seal fix/phase1 "chain/phase2-$HEAD" fix/evals "$BEACON" keys >> seal.log 2>&1 || fail "seal ($(tail -2 seal.log))"
say "sealed: $(grep 'sha256' seal.log | tr '\n' ' ')"
./fixture prove fix keys/groth16_pk.bin keys/groth16_vk.bin | tee -a "$LOG"
[ -s keys/Groth16Verifier.sol ] && say "ok: Groth16Verifier.sol written"
say "REHEARSAL PASSED ($W)"
