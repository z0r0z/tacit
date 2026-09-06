#!/bin/bash
set -euo pipefail
# One-time setup for confidential-settle-loop-lite.sh: installs jq + foundry (if missing) and
# downloads the prebuilt prover binaries the loop expects, from a prover-bins-<N> GitHub release.
# Run once per box; the loop script itself has no build step and needs nothing else.
#
# Usage: ./setup-relay-lite.sh [release-tag]
#   release-tag defaults to the latest prover-bins-* release. Pin an exact tag (e.g.
#   prover-bins-v6) if you want reproducible binaries rather than whatever's newest.
#
# Verifies each binary embeds the SAME guest ELF the pinned vkey expects (via `cargo prove vkey`,
# if a Rust toolchain happens to be present) is NOT done here — that check lives in the repo's own
# CI (verify-vkey-pin.sh) and in EXPECT_VKEY, which the loop script asserts against the prover's own
# reported vkey at prove time and refuses to run on if it doesn't match.

REPO="z0r0z/tacit"
TAG="${1:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$DIR/bin"
mkdir -p "$BIN_DIR"

BINS="exec-wrap exec-prove exec-batchtransfer exec-wraplp exec-wrapswap exec-swap exec-unwrap \
  exec-lp exec-lpremove exec-wraptransfer exec-sendunwrap exec-otc exec-route exec-bid \
  exec-bridgeburn exec-bridgemint exec-cbtcmint exec-cdpmint exec-cdpclose exec-stealthlock \
  exec-stealthclaim exec-stealthrefund exec-stealthlockbatch exec-bridgestealthmint"

echo "== jq =="
if ! command -v jq >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq jq
  elif command -v brew >/dev/null 2>&1; then brew install jq
  else echo "install jq manually, then re-run" >&2; exit 1
  fi
fi
echo "jq: $(command -v jq)"

echo "== foundry (cast) =="
if ! command -v cast >/dev/null 2>&1 && [ ! -x "$HOME/.foundry/bin/cast" ]; then
  curl -fsSL https://foundry.paradigm.xyz | bash
  "$HOME/.foundry/bin/foundryup"
fi
export PATH="$PATH:$HOME/.foundry/bin"
echo "cast: $(command -v cast || echo "$HOME/.foundry/bin/cast")"

echo "== prover binaries (release: ${TAG:-latest prover-bins-*}) =="
if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" \
    | grep -o '"tag_name": *"prover-bins-[^"]*"' | head -1 | sed 's/.*"\(prover-bins-[^"]*\)"/\1/')
  [ -n "$TAG" ] || { echo "could not resolve the latest prover-bins-* release — pass a tag explicitly" >&2; exit 1; }
fi
echo "using $TAG"
for b in $BINS; do
  echo "  fetching $b"
  curl -fsSL -o "$BIN_DIR/$b" "https://github.com/$REPO/releases/download/$TAG/$b" &
done
wait
chmod +x "$BIN_DIR"/exec-*

echo "== pinned vkey =="
# Read straight from GitHub — a self-hoster running this doesn't necessarily have the repo cloned.
EXPECT_VKEY=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/main/contracts/sp1/confidential/elf-vkey-pin.json" \
  | grep -o '"program_vkey": *"0x[0-9a-fA-F]*"' | sed 's/.*"\(0x[0-9a-fA-F]*\)"/\1/')
if [ -z "$EXPECT_VKEY" ]; then
  echo "could not resolve program_vkey from elf-vkey-pin.json — check contracts/sp1/confidential/elf-vkey-pin.json manually" >&2
else
  echo "program_vkey: $EXPECT_VKEY"
fi

echo "== done =="
ls -la "$BIN_DIR"
echo
echo "Next: run confidential-settle-loop-lite.sh with EXPECT_VKEY=$EXPECT_VKEY plus the rest of"
echo "the env it documents (WORKER_BASE, BOX_TOKEN, POOL_ADDR, RPC_URL, SETTLE_KEY, NETWORK_PRIVATE_KEY)."
