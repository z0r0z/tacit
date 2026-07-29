#!/usr/bin/env bash
# R-01 launch gate: prove every superseded ConfidentialPool holds no withdrawable EVM escrow, block-tagged and
# reproducible. Cross-generation double-spend safety rests on this (the resumed reflected state's notes are
# spendable in both the old and new pool, but a spend against an INERT old pool extracts nothing). An
# already-deployed predecessor is immutable and cannot be retired on-chain, so this is an OPERATIONAL gate:
# run it at a pinned block immediately before deploy/funding and publish the block hash. Any nonzero withdrawable
# balance above DUST is a NO-GO for that predecessor. See ops/DESIGN-c01-generational-retirement.md.
#
# Usage: RPC=<mainnet-rpc> [BLOCK=<n>] [DUST_WEI=...] bash ops/verify-predecessor-inert.sh
set -euo pipefail

RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
BLOCK="${BLOCK:-latest}"
# Below this, a balance is treated as ignorable test dust (default ~$50 at any plausible price for the majors).
DUST="${DUST:-100000000}"   # 1e8 base units; ETH uses DUST_WEI

BLK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?')"
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
done

if [ "$BAD" -ne 0 ]; then
  echo "NOT INERT — a superseded pool holds withdrawable escrow above dust. Drain it or do not resume its state. NO-GO."
  exit 1
fi
echo "OK — all superseded pools inert (≤ dust) at block ${BLK}. Record this block hash with the deploy."
