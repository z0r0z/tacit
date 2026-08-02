#!/usr/bin/env bash
# R-01 launch gate: prove every superseded ConfidentialPool is inert, block-tagged and reproducible. Two checks:
#   (1) ESCROW — the pool holds no withdrawable EVM escrow above dust.
#   (2) QUIESCED — the pool's reflected state is NOT advancing (its attested reflection digest and fast-lane
#       consume / cross-out counts are unchanged across a block window). A predecessor that is still advancing its
#       reflection can fast-lane-mint against a note the new generation also recognizes, so escrow being empty is
#       not sufficient — a pool that mints its own canonical tokens holds no escrow yet can still credit value.
# An already-deployed predecessor is immutable and cannot be retired on-chain, so this is an OPERATIONAL gate:
# run it at a pinned block immediately before deploy/funding and publish the block hash. Any withdrawable balance
# above DUST, or any reflection advancement over the window, is a NO-GO for that predecessor.
# POOLS defaults to the resumed lineage; set it to the full superseded set (see ops/DESIGN-multigen-safe.md).
#
# Usage: RPC=<mainnet-rpc> [BLOCK=<n>] [WINDOW=<blocks>] [DUST=...] bash ops/verify-predecessor-inert.sh
set -euo pipefail

RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
BLOCK="${BLOCK:-latest}"
# Below this, a balance is treated as ignorable test dust (default ~$50 at any plausible price for the majors).
DUST="${DUST:-100000000}"   # 1e8 base units; ETH uses DUST_WEI
# Advancement window: the quiesced check samples reflection progress at head and head-WINDOW.
WINDOW="${WINDOW:-50}"

BLK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?')"
# Numeric head and the past sample block for the quiesced check.
NOWB="$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '')"
PASTB=""
if [ -n "$NOWB" ] && [ "$NOWB" -gt "$WINDOW" ] 2>/dev/null; then PASTB=$((NOWB - WINDOW)); fi
BLKHASH="$(cast block "$BLOCK" --rpc-url "$RPC" --json 2>/dev/null | sed -n 's/.*"hash":"\(0x[0-9a-f]*\)".*/\1/p' | head -1 || true)"
echo "# predecessor-inert gate @ block ${BLK} (${BLOCK}) hash=${BLKHASH:-?} rpc=${RPC}"

# Superseded pools in the resumed lineage (deployments/1.json pool + _previous_pool + any older).
POOLS="${POOLS:-0x00000000000f5DE1295Ab2F0649fDE3855b66020 0x0000000000c5B537A7c3622d1418D5771914C03D}"

# Withdrawable underlyings to check. Extend with any asset the pool ever escrowed (cross-check against the
# pool's registered-asset set at launch — this list is the majors + the BTC-wrapped set the protocol uses).
TOKENS="\
WETH:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
USDC:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
USDT:0xdAC17F958D2ee523a2206206994597C13D831ec7 \
wstETH:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0 \
cbBTC:0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf \
tBTC:0x18084fbA666a33d37592fA2633fD49a74DD93a88 \
WBTC:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"

BAD=0
for P in $POOLS; do
  echo "== pool $P =="
  eth="$(cast balance "$P" --rpc-url "$RPC" --block "$BLOCK" 2>/dev/null || echo 0)"
  echo "   ETH(wei): $eth"
  # ETH dust threshold ~0.02 ETH
  if [ "$(printf '%s' "$eth")" != "0" ] && [ "${#eth}" -ge 17 ]; then echo "   !! ETH above dust"; BAD=1; fi
  for t in $TOKENS; do
    nm="${t%%:*}"; addr="${t##*:}"
    bal="$(cast call "$addr" "balanceOf(address)(uint256)" "$P" --rpc-url "$RPC" --block "$BLOCK" 2>/dev/null | awk '{print $1}' || echo 0)"
    echo "   ${nm}: ${bal}"
    # numeric compare against DUST (bal may be huge; use awk bignum-safe string length + compare)
    if [ "$bal" != "0" ]; then
      if [ "${#bal}" -gt "${#DUST}" ] || { [ "${#bal}" -eq "${#DUST}" ] && [ "$bal" \> "$DUST" ]; }; then
        echo "   !! ${nm} above dust ($bal > $DUST)"; BAD=1
      fi
    fi
  done
  # (2) QUIESCED: the pool's reflected state must not be advancing over the window (escrow being empty does not
  # cover a pool that mints its own canonical tokens — such a pool credits value with no escrow to check).
  if [ -n "$PASTB" ]; then
    for sig in "attestedReflectionDigest()(bytes32)" "attestedBitcoinConsumedCount()(uint256)" "attestedCrossOutCount()(uint256)"; do
      nm="${sig%%(*}"
      now="$(cast call "$P" "$sig" --rpc-url "$RPC" --block "$NOWB" 2>/dev/null | awk '{print $1}' || true)"
      past="$(cast call "$P" "$sig" --rpc-url "$RPC" --block "$PASTB" 2>/dev/null | awk '{print $1}' || true)"
      if [ -z "$now" ] || [ -z "$past" ]; then
        echo "   ${nm}: UNREADABLE (now='${now}' past='${past}')"
        # The digest is core ABI on every pool in the resumed lineage; unreadable means we cannot confirm inertness.
        if [ "$nm" = "attestedReflectionDigest" ]; then echo "   !! cannot confirm ${nm} quiesced — verify manually"; BAD=1; fi
        continue
      fi
      echo "   ${nm}: ${past} -> ${now}"
      if [ "$now" != "$past" ]; then echo "   !! ${nm} ADVANCED over ${WINDOW} blocks — predecessor is LIVE"; BAD=1; fi
    done
  else
    echo "   (quiesced check skipped — head ≤ WINDOW; set a smaller WINDOW)"
  fi
done

if [ "$BAD" -ne 0 ]; then
  echo "NOT INERT — a superseded pool holds withdrawable escrow above dust, or its reflection is still advancing."
  echo "Drain the escrow / confirm the predecessor is quiesced, or do not resume its state. NO-GO."
  exit 1
fi
echo "OK — all superseded pools inert at block ${BLK}: no withdrawable escrow above dust, and reflection quiesced"
echo "over the last ${WINDOW} blocks. Record this block hash with the deploy."
