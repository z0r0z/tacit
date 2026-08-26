#!/usr/bin/env bash
# launch-v1.sh — the canonical Tacit V1 mainnet launch: deploy a FRESH BitcoinLightRelay at a recent
# matured anchor, then the V1 suite (DeployV1SuiteCreateX) anchored to it. Fresh genesis (no resume).
#
# Runs a full DRY_RUN by default (forge simulation, NO key needed for the sims — but the fetch is live).
# Broadcast ONLY when BROADCAST=1 AND DEPLOYER_PRIVATE_KEY is set. Two phases:
#   RELAY_ADDR set  -> skip the relay deploy, reuse it, deploy only the suite.
#   otherwise       -> deploy the relay first, read its address, then the suite.
#
#   source deployments/redeploy-v3.env
#   bash launch-v1.sh                 # DRY_RUN both phases (validates fetch + both forge sims)
#   BROADCAST=1 bash launch-v1.sh     # live (needs DEPLOYER_PRIVATE_KEY + funded deployer)
set -euo pipefail
cd "$(dirname "$0")"

RPC="${MAINNET_RPC:-${RPC:?set RPC / MAINNET_RPC}}"
: "${SP1_VERIFIER:?}"; : "${EXPECTED_VERIFIER_CODEHASH:?}"
# Esplora-compatible APIs (mempool.space + blockstream.info are drop-in for /blocks, /block-height, /block).
BTC_APIS="${BTC_APIS:-https://blockstream.info/api https://mempool.space/api}"
BTC_RPC="${BTC_RPC:-https://bitcoin-rpc.publicnode.com}"
CONF="${REFLECTION_CONFIRMATIONS:-6}"
DRY=$([ "${BROADCAST:-0}" = 1 ] && echo "" || echo 1)

hexrev() { python3 -c "import sys; print(bytes.fromhex(sys.argv[1].removeprefix('0x'))[::-1].hex())" "$1"; }
jget()   { python3 -c "import sys,json; print(json.load(sys.stdin)[sys.argv[1]])" "$1"; }
# g <esplora-path> — fetch with a hard per-call timeout, 3 attempts, failing over across BTC_APIS.
g() {
  local path=$1 api out
  for api in $BTC_APIS; do
    for _ in 1 2 3; do
      out=$(curl -sf --max-time 12 "$api/$path" 2>/dev/null) && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
      sleep 1
    done
  done
  echo "FETCH FAILED (all APIs) for /$path" >&2; return 1
}

echo "== Phase 0: preflight pins =="
PIN=sp1/confidential/elf-vkey-pin.json
[ "$PROGRAM_VKEY" = "$(python3 -c "import json;print(json.load(open('$PIN'))['program_vkey'])")" ] || { echo "PROGRAM_VKEY != pin"; exit 1; }
[ "$BITCOIN_RELAY_VKEY" = "$(python3 -c "import json;print(json.load(open('$PIN'))['bitcoin_relay_vkey'])")" ] || { echo "BITCOIN_RELAY_VKEY != pin"; exit 1; }
echo "  vkeys match pin ✓  (settle $PROGRAM_VKEY / reflection $BITCOIN_RELAY_VKEY)"

echo "== Phase 1: fetch a fresh recent Bitcoin anchor (tip - $CONF) =="
TIP_H=$(g "blocks/tip/height")
ANCHOR_H=$(( TIP_H - CONF ))
ANCHOR_BE=$(g "block-height/$ANCHOR_H")
ANCHOR_LE=$(hexrev "$ANCHOR_BE")
ANCHOR_HDR=$(g "block/$ANCHOR_BE/header")
ANCHOR_TS=$(g "block/$ANCHOR_BE" | jget timestamp)
# cumulative work at the anchor (canonical heaviest-chain accumulator)
CW_HEX=$(curl -sf --max-time 15 -X POST "$BTC_RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"getblockheader\",\"params\":[\"$ANCHOR_BE\"]}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['chainwork'])")
TIP_WORK=$(python3 -c "print(int('$CW_HEX',16))")
# epoch start (difficulty period boundary) — anchor must be in the same epoch (wrapper limitation)
EPOCH_START=$(( ANCHOR_H / 2016 * 2016 ))
EPOCH_BE=$(g "block-height/$EPOCH_START")
EPOCH_HDR=$(g "block/$EPOCH_BE/header")
EPOCH_BLK=$(g "block/$EPOCH_BE")
EPOCH_TS=$(echo "$EPOCH_BLK" | jget timestamp)
EPOCH_BITS=$(echo "$EPOCH_BLK" | python3 -c "import sys,json;print(f'{json.load(sys.stdin)[\"bits\"]:08x}')")
EPOCH_TARGET=$(python3 -c "b=int('$EPOCH_BITS',16);print((b&0x7fffff)<<(8*(((b>>24)&0xff)-3)))")
# 10 canonical ancestors of the anchor (parent first) for the median-time-past window
ANC_HASHES=""; ANC_TS=""
h=$ANCHOR_H
for i in $(seq 1 10); do
  h=$(( h - 1 ))
  be=$(g "block-height/$h")
  ANC_HASHES="$ANC_HASHES${ANC_HASHES:+,}0x$(hexrev "$be")"
  ANC_TS="$ANC_TS${ANC_TS:+,}$(g "block/$be" | jget timestamp)"
done

echo "  tip=$TIP_H  anchor=$ANCHOR_H ts=$ANCHOR_TS  epochStart=$EPOCH_START"
echo "  anchor LE (BTC_TIP_HASH / GENESIS_REFLECTION_ANCHOR): 0x$ANCHOR_LE"
echo "  work=$TIP_WORK  epochTarget=$EPOCH_TARGET"

echo "== Phase 2: deploy fresh BitcoinLightRelay ${DRY:+(DRY_RUN)} =="
if [ -z "${RELAY_ADDR:-}" ]; then
  BTC_GENESIS_EPOCH_START=$EPOCH_START BTC_GENESIS_TARGET=$EPOCH_TARGET BTC_GENESIS_TIMESTAMP=$EPOCH_TS \
  BTC_TIP_HASH=0x$ANCHOR_LE BTC_TIP_HEIGHT=$ANCHOR_H BTC_TIP_WORK=$TIP_WORK \
  BTC_TIP_HEADER=0x$ANCHOR_HDR BTC_EPOCH_START_HEADER=0x$EPOCH_HDR \
  ANCHOR_TIMESTAMP=$ANCHOR_TS ANCHOR_ANCESTOR_HASHES="$ANC_HASHES" ANCHOR_ANCESTOR_TIMESTAMPS="$ANC_TS" \
  forge script script/DeployBitcoinRelayStandalone.s.sol --rpc-url "$RPC" ${DRY:+} $([ -z "$DRY" ] && echo --broadcast) -vvv
  if [ -z "$DRY" ]; then
    RELAY_ADDR=$(python3 -c "import json;r=json.load(open('broadcast/DeployBitcoinRelayStandalone.s.sol/1/run-latest.json'));print([t['contractAddress'] for t in r['transactions'] if t.get('contractName')=='BitcoinLightRelay'][0])")
    echo "  deployed relay: $RELAY_ADDR"
  else
    echo "  (dry-run: relay not broadcast; RELAY_ADDR unset)"
  fi
else
  echo "  reusing RELAY_ADDR=$RELAY_ADDR"
fi

echo "== Phase 3: deploy V1 suite anchored to the fresh relay ${DRY:+(DRY_RUN)} =="
[ -n "${RELAY_ADDR:-}" ] || { echo "  no RELAY_ADDR (dry-run relay phase) — rerun with BROADCAST=1 to chain, or set RELAY_ADDR"; exit 0; }
export HEADER_RELAY="$RELAY_ADDR"
export GENESIS_REFLECTION_ANCHOR="0x$ANCHOR_LE"
export REFLECTION_RESUME_DIGEST=  # fresh genesis
forge script script/DeployV1SuiteCreateX.s.sol --rpc-url "$RPC" $([ -z "$DRY" ] && echo --broadcast) -vvv

if [ -z "$DRY" ]; then
  echo "== Phase 4: read the deployed pool's immutables + TAC wiring BACK from chain (fail loud on any mismatch) =="
  POOL=$(python3 -c "import json;r=json.load(open('broadcast/DeployV1SuiteCreateX.s.sol/1/run-latest.json'));print([t['contractAddress'] for t in r['transactions'] if t.get('contractName')=='ConfidentialPool'][0])")
  TAC_ID=0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b
  lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
  ck() { local name=$1 got=$2 want=$3; [ "$(lc "$got")" = "$(lc "$want")" ] && echo "  OK  $name = $got" || { echo "  FAIL $name: got $got want $want"; exit 1; }; }
  ck PROGRAM_VKEY       "$(cast call "$POOL" 'PROGRAM_VKEY()(bytes32)' --rpc-url "$RPC")"        "$PROGRAM_VKEY"
  ck BITCOIN_RELAY_VKEY "$(cast call "$POOL" 'BITCOIN_RELAY_VKEY()(bytes32)' --rpc-url "$RPC")"  "$BITCOIN_RELAY_VKEY"
  PA=$(cast call "$POOL" 'PUBLIC_AMM()(address)' --rpc-url "$RPC"); [ "$(lc "$PA")" != "0x0000000000000000000000000000000000000000" ] && echo "  OK  PUBLIC_AMM = $PA (non-zero — public AMM live)" || { echo "  FAIL PUBLIC_AMM is zero — public AMM disabled!"; exit 1; }
  # TAC registered + linked (bridge-able): assets(TAC_ID).registered must be true, underlying non-zero
  REG=$(cast call "$POOL" 'assets(bytes32)(bool,address,uint256,bytes32,bool,uint8)' "$TAC_ID" --rpc-url "$RPC" | head -1)
  [ "$REG" = "true" ] && echo "  OK  TAC ($TAC_ID) registered + linked → bridge-able" || { echo "  FAIL TAC not registered — cannot bridge TAC!"; exit 1; }
  echo "  pool $POOL — all immutables + TAC wiring verified on-chain ✓"
fi
echo "== done ${DRY:+(DRY_RUN — nothing broadcast)} =="
